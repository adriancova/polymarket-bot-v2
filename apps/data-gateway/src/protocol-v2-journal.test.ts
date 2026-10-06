/**
 * `V2-2` (acceptance 2, the gateway half; migration plan row A9): the frames
 * of a Protocol V2 market-channel session reach the gateway's WAL writer byte
 * for byte, PONGs included, and are journaled before anything is published.
 *
 * The session is `VENUE-4`'s capture S-W01
 * (`test/fixtures/venue/protocol-v2/ws-market-v2-session.jsonl`; F-62 in
 * `docs/venue/verified-2026-10-05.md`): 60 s on the public market channel,
 * subscribed to one V2 position id. Each record's `data` is a frame's text
 * exactly as received. The seven inbound frames are:
 * - one `book` frame for that id. It carries the undocumented
 *   `"version":"v2"` (C-21) and ends with a newline;
 * - five `PONG`s, each answering a `PING`;
 * - one `new_market` for an unrelated market.
 *
 * The whole gateway runs on its injected doubles, as `gateway.test.ts` and the
 * data-gateway integration suite build it: `DataGateway.create`, the WP-050
 * in-memory filesystem, the in-memory transport, and a scripted socket on the
 * Polymarket socket port. The manual clock replays the session's own timing,
 * so the feed's heartbeat sends each `PING` and every `PONG` answers one. The
 * WAL is read back from the filesystem with the WP-050 reader
 * (`readSegmentRecords`), and `validateWalDirectory` checks each segment
 * against its footer and manifest. That is what a compactor or a replay would
 * find; nothing is asked of the writer itself.
 *
 * Pinned:
 * 1. Every inbound frame becomes one WAL record, in arrival order, at its
 *    arrival instant. Each record's payload is the socket text's exact UTF-8
 *    bytes, and its `payloadSha256` is the SHA-256 of those bytes (computed
 *    here).
 * 2. Nothing is published ahead of a frame's journaling. At every publication
 *    the WAL had already accepted every frame delivered so far. The V2
 *    `BookSnapshot` names its raw record by `causationId`, with a lower
 *    `ingestSeq` (WP-120 acceptance 1, here on V2 bytes). The unrelated
 *    `new_market` is reported, after its own record.
 * 3. The epoch's segments verify (`validateWalDirectory`).
 *
 * `V2-2` changes no gateway source. This file only proves the path.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { PublicWebSocketFactory, PublicWebSocketHandlers } from "@polymarket-bot/polymarket-public";
import {
  readSegmentRecords,
  validateWalDirectory,
  type RawFrameRecord,
} from "@polymarket-bot/storage-wal";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { describe, expect, it } from "vitest";

import { parseGatewayConfig } from "./config.js";
import { DataGateway } from "./gateway.js";
import {
  deterministicIdSource,
  ManualGatewayClock,
  ManualGatewayTimers,
  MemoryEventTransport,
} from "./testing/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROTOCOL_V2 = resolve(repoRoot, "test/fixtures/venue/protocol-v2");
const STREAM = "market-events";
const FEED_ID = "polymarket-market";

interface SessionRecord {
  readonly t: string;
  readonly dir: string;
  readonly data: unknown;
}

const SESSION_TEXT = readFileSync(resolve(PROTOCOL_V2, "ws-market-v2-session.jsonl"), "utf8");
const SESSION: readonly SessionRecord[] = SESSION_TEXT.split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as SessionRecord);

/** Every inbound frame: the text the socket delivered, and when. */
const INBOUND: readonly { readonly atMs: number; readonly text: string }[] = SESSION.filter(
  (record) => record.dir === "recv",
).map((record) => ({ atMs: Date.parse(record.t), text: record.data as string }));

const OPENED_AT_MS = Date.parse(SESSION.find((record) => record.dir === "open")?.t ?? "");

/** The CLOB record of the session's market (S-L01): YES ("Up") at index 0 (F-40). */
const V2_CLOB = JSON.parse(readFileSync(resolve(PROTOCOL_V2, "clob-markets-v2.jsonc"), "utf8")) as {
  readonly c: string;
  readonly t: readonly { readonly t: string; readonly o: string }[];
  readonly mts: number;
  readonly mos: number;
};

/**
 * The V2 market as the gateway's catalogue would hold it once admission
 * selects `positionIds` (A1; `V2-1`). TEST CONFIGURATION: the ids, tick size
 * and minimum size are the capture's. The condition id is Gamma's documented
 * 31-byte form (F-40, F-43), while the wire names the 32-byte form. The
 * contract suite pins that identity is resolved by `asset_id` alone
 * (`test/contract/polymarket-public/market-ws-fixtures.test.ts`).
 */
const V2_MARKET = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000002",
  conditionId: V2_CLOB.c.slice(0, -2),
  yesTokenId: V2_CLOB.t[0]?.t ?? "",
  noTokenId: V2_CLOB.t[1]?.t ?? "",
  parameters: {
    tickSize: String(V2_CLOB.mts),
    minimumOrderSize: String(V2_CLOB.mos),
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
  },
  observedAt: "2026-10-05T23:15:25.000Z",
} as const;

/** A scripted socket on the Polymarket socket port: it records what is sent. */
class ScriptedSocket {
  readonly sent: string[] = [];
  constructor(readonly handlers: PublicWebSocketHandlers) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    // Nothing to release: no network.
  }
}

const sha256OfUtf8 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

interface Publication {
  readonly envelope: EventEnvelope<unknown>;
  /** The WAL's accepted frames at the instant of publication. */
  readonly walAccepted: number;
  /**
   * Inbound frames handed to the socket by then, counting a frame from the
   * moment `onMessage` is entered: a publication made inside the callback,
   * before the frame was journaled, is caught.
   */
  readonly delivered: number;
}

async function replaySession() {
  const clock = new ManualGatewayClock(OPENED_AT_MS);
  const timers = new ManualGatewayTimers(clock);
  const transport = new MemoryEventTransport();
  const walFileSystem = createMemoryFileSystem();
  const sockets: ScriptedSocket[] = [];
  const socketFactory: PublicWebSocketFactory = (_url, handlers) => {
    const socket = new ScriptedSocket(handlers);
    sockets.push(socket);
    return socket;
  };
  const recordingFailures: string[] = [];

  const config = parseGatewayConfig({
    streamName: STREAM,
    wal: { rootPath: "/wal" },
    markets: [V2_MARKET],
    // The session subscribed with `custom_feature_enabled: true` (S-W01).
    polymarket: { feedId: FEED_ID, customFeatureEnabled: true },
  });
  const gateway = await DataGateway.create(config, {
    clock,
    ids: deterministicIdSource(),
    timers,
    walFileSystem,
    transport,
    polymarketSocketFactory: socketFactory,
    // REST recovery is not under test (and `POST /books` with V2 ids is U-42):
    // the HTTP port refuses, so the subscription's gap stays open.
    polymarketHttpClient: async () => {
      throw new Error("no HTTP in this test");
    },
    observer: {
      onRecordingFailure: (failure) => recordingFailures.push(failure.reason),
    },
  });

  let delivered = 0;
  const publications: Publication[] = [];
  transport.setPublishObserver((envelope) => {
    publications.push({ envelope, walAccepted: gateway.metrics().wal.framesAccepted, delivered });
  });

  gateway.start();
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error("the gateway opened no Polymarket socket");
  socket.handlers.onOpen();
  await gateway.settle();
  for (const frame of INBOUND) {
    // The session's own timing: the heartbeat's PINGs come due on the way.
    timers.advance(frame.atMs - clock.nowMs());
    delivered += 1;
    socket.handlers.onMessage(frame.text);
    await gateway.settle();
  }
  const epoch = gateway.gatewayEpoch;
  await gateway.stop();

  const directory = `/wal/${epoch}`;
  const segmentPaths = (await walFileSystem.listFileNames(directory))
    .filter((name) => name.endsWith(".wal.jsonl"))
    .sort()
    .map((name) => `${directory}/${name}`);
  const records: RawFrameRecord[] = [];
  for (const path of segmentPaths) {
    const read = await readSegmentRecords(walFileSystem, path, { allowIncompleteFinalRecord: false });
    records.push(...read.records);
  }
  const validation = await validateWalDirectory(walFileSystem, directory);
  return { epoch, records, validation, publications, sent: socket.sent, recordingFailures, transport };
}

describe("Protocol V2: the recorded session through the gateway's WAL writer (V2-2 acceptance 2; A9)", () => {
  it("the session is the capture the facts describe: one V2 book, five PONGs, one new_market (non-vacuity)", () => {
    // The capture's committed digest (`ws-market-v2-session.provenance.jsonc`).
    expect(sha256OfUtf8(SESSION_TEXT)).toBe("d38c050a708933e6f7355057ce27687945bc1e169acde70b754788326b5cb006");
    expect(INBOUND.map((frame) => frame.text === "PONG")).toEqual([false, true, true, true, true, false, true]);
    const book = INBOUND[0]?.text ?? "";
    expect(book.endsWith("]\n")).toBe(true);
    expect(book).toContain('"version":"v2"');
    expect(book).toContain(`"asset_id":"${V2_MARKET.yesTokenId}"`);
    expect(V2_MARKET.yesTokenId).toMatch(/^[1-9][0-9]{74}$/u);
    expect(INBOUND[5]?.text).toContain('"event_type":"new_market"');
  });

  it("journals every inbound frame, PONGs included, byte for byte and in arrival order", async () => {
    const { epoch, records, validation, recordingFailures } = await replaySession();
    expect(recordingFailures).toEqual([]);
    expect(records).toHaveLength(INBOUND.length);
    for (const [index, frame] of INBOUND.entries()) {
      const record = records[index];
      if (record === undefined) throw new Error(`no WAL record for inbound frame ${String(index)}`);
      // The exact UTF-8 bytes the socket delivered: the book's trailing newline and every PONG.
      expect(Buffer.from(record.payloadUtf8, "utf8").equals(Buffer.from(frame.text, "utf8"))).toBe(true);
      expect(record.payloadSha256).toBe(sha256OfUtf8(frame.text));
      expect(record).toMatchObject({
        gatewayEpoch: epoch,
        ingestSeq: expect.stringMatching(/^[1-9][0-9]*$/u) as unknown,
        source: "polymarket",
        receivedAt: new Date(frame.atMs).toISOString(),
      });
    }
    // One connection and one subscription generation throughout.
    expect(new Set(records.map((record) => `${record.connectionId}#${String(record.subscriptionGeneration)}`)).size).toBe(1);
    const ingestSeqs = records.map((record) => BigInt(record.ingestSeq));
    expect([...ingestSeqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ingestSeqs);
    // Every segment is complete and verified (`wal-format.md` §2).
    expect(validation.length).toBeGreaterThan(0);
    expect(validation.map((report) => [report.valid, report.issues])).toEqual(validation.map(() => [true, []]));
  });

  it("subscribes by the V2 ids and sends the PING every PONG answers, as the session did", async () => {
    const { sent } = await replaySession();
    const subscription = JSON.parse(sent[0] ?? "null") as Record<string, unknown>;
    expect(subscription).toMatchObject({ type: "market", custom_feature_enabled: true });
    expect([...(subscription["assets_ids"] as string[])].sort()).toEqual(
      [V2_MARKET.yesTokenId, V2_MARKET.noTokenId].sort(),
    );
    const sessionPings = SESSION.filter((record) => record.dir === "send" && record.data === "PING").length;
    expect(sent.slice(1)).toEqual(Array.from({ length: sessionPings }, () => "PING"));
  });

  it("publishes nothing ahead of a frame's journaling, and the V2 book cites its raw record", async () => {
    const { epoch, records, publications, transport } = await replaySession();
    expect(publications.length).toBeGreaterThan(0);
    // At every publication, every frame delivered so far was already accepted by the WAL.
    for (const publication of publications) {
      expect(
        publication.walAccepted,
        `${publication.envelope.eventType} published after ${String(publication.delivered)} frames`,
      ).toBeGreaterThanOrEqual(publication.delivered);
    }
    const published = transport.published(STREAM);
    const books = published.filter((envelope) => envelope.eventType === "BookSnapshot");
    expect(books).toHaveLength(1);
    const book = books[0];
    const bookRecord = records[0];
    if (book === undefined || bookRecord === undefined) throw new Error("unreachable");
    expect(book.causationId).toBe(`raw:${epoch}:${bookRecord.ingestSeq}`);
    expect(BigInt(bookRecord.ingestSeq)).toBeLessThan(BigInt(book.ingestSeq));
    expect(book.payload).toMatchObject({
      internalMarketId: V2_MARKET.internalMarketId,
      tokenId: V2_MARKET.yesTokenId,
      bids: [],
      asks: [],
    });
    // The book was published after its frame was delivered, never before.
    const bookPublication = publications.find((publication) => publication.envelope.eventId === book.eventId);
    expect(bookPublication?.delivered).toBe(1);
    // The unrelated `new_market` is reported, not dropped (§8.3). Its incident
    // carries no causation, so its order is read from the identities.
    const unregistered = published.filter(
      (envelope) => (envelope.payload as { reasonCode?: unknown }).reasonCode === "UNREGISTERED_MARKET",
    );
    expect(unregistered).toHaveLength(1);
    const newMarketRecord = records[5];
    if (newMarketRecord === undefined || unregistered[0] === undefined) throw new Error("unreachable");
    expect(newMarketRecord.payloadUtf8).toContain('"event_type":"new_market"');
    expect(BigInt(newMarketRecord.ingestSeq)).toBeLessThan(BigInt(unregistered[0].ingestSeq));
    expect(
      publications.find((publication) => publication.envelope.eventId === unregistered[0]?.eventId)?.delivered,
    ).toBe(6);
    // Every frame-derived publication names a journaled frame.
    const journaled = new Set(records.map((record) => `raw:${epoch}:${record.ingestSeq}`));
    for (const envelope of published) {
      if (envelope.causationId?.startsWith("raw:") === true) {
        expect(journaled.has(envelope.causationId), envelope.eventType).toBe(true);
      }
    }
  });
});
