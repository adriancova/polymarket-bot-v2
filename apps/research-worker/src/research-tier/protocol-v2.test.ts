/**
 * Polymarket Protocol V2 on the research tier's recorded-data readers (`V2-2`:
 * plan row A16, acceptance 5).
 *
 * A V2 position id is a 75-digit decimal string (`docs/venue/verified-2026-10-05.md`
 * F-44), where the V1 token ids this tier has read so far are 77 or 78 digits.
 * The readers treat ids as opaque strings, so they should need no change; this
 * file proves it on `VENUE-4`'s own capture: the 60 s market-channel session
 * on a V2 position id (S-W01, `test/fixtures/venue/protocol-v2/ws-market-v2-session.jsonl`),
 * every inbound frame replayed as the WAL records it (`payloadUtf8` is the
 * frame text exactly as received, the book frame's trailing newline included).
 *
 * Pinned, per reader:
 * - the identity inventory (`identity.ts`, `TOKEN_KEYS`) names the 75-digit id
 *   and the frame's condition id, and counts nothing as unidentified;
 * - the interpreter (`interpret.ts`) reads the V2 `book` frame through the
 *   shipped door into one `pm-book` observation for that id, with no problem;
 * - the sampler (`sampler.ts`) releases top-of-book, depth and full-book
 *   samples keyed by that id;
 * - a 75-digit id and the 77- and 78-digit V1 ids of the same round sort as
 *   the manifest requires (strictly ascending, `identityList`).
 *
 * NO NETWORK. The capture is read from the repository.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { RawFrameRecord } from "@polymarket-bot/storage-parquet";
import { sha256Hex } from "@polymarket-bot/storage-parquet";

import { MarketIdentityInventory, frameMarketIdentity } from "./identity.js";
import { FrameInterpreter } from "./interpret.js";
import { ResearchSampler } from "./sampler.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROTOCOL_V2 = resolve(REPO_ROOT, "test/fixtures/venue/protocol-v2");
const MARKET_ENDPOINT = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const EPOCH = "0190a3e0-0000-7000-8000-000000000002";

/** The V2 position ids of the canary market (S-L01: `t[0]` Up, `t[1]` Down). */
const CANARY = JSON.parse(readFileSync(resolve(PROTOCOL_V2, "clob-markets-v2.jsonc"), "utf8")) as {
  readonly c: string;
  readonly t: readonly { readonly t: string }[];
};
const V2_YES = CANARY.t[0]?.t ?? "";
/** The two V1 token ids of the round's V1 window (S-L10), 77 and 78 digits. */
const V1_IDS = (
  JSON.parse(readFileSync(resolve(PROTOCOL_V2, "clob-markets-v1.jsonc"), "utf8")) as {
    readonly t: readonly { readonly t: string }[];
  }
).t.map((entry) => entry.t);

interface SessionRecord {
  readonly t: string;
  readonly dir: string;
  readonly data: unknown;
}

/** Every inbound frame of the session, as the WAL records it. */
const RECORDS: readonly RawFrameRecord[] = readFileSync(resolve(PROTOCOL_V2, "ws-market-v2-session.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as SessionRecord)
  .filter((record) => record.dir === "recv")
  .map((record, index) => frame(String(index + 1), record.t, record.data as string));

function frame(ingestSeq: string, receivedAt: string, payloadUtf8: string): RawFrameRecord {
  return {
    gatewayEpoch: EPOCH,
    ingestSeq,
    source: "polymarket",
    endpoint: MARKET_ENDPOINT,
    connectionId: "conn-1",
    subscriptionGeneration: 1,
    receivedAt,
    receivedMonotonicNs: ingestSeq,
    payloadUtf8,
    payloadSha256: sha256Hex(payloadUtf8),
  };
}

const BOOK = RECORDS[0] as RawFrameRecord;

describe("the capture is the one F-44 and F-62 describe (non-vacuity)", () => {
  it("a 75-digit V2 id, its 32-byte condition, and a book frame for it among seven inbound frames", () => {
    expect(V2_YES).toMatch(/^[1-9][0-9]{74}$/u);
    expect(V1_IDS.map((id) => id.length).sort()).toEqual([77, 78]);
    expect(RECORDS).toHaveLength(7);
    expect(BOOK.payloadUtf8.endsWith("]\n")).toBe(true);
    expect(BOOK.payloadUtf8).toContain(`"asset_id":"${V2_YES}"`);
    expect(BOOK.payloadUtf8).toContain('"version":"v2"');
    expect(RECORDS.filter((record) => record.payloadUtf8 === "PONG")).toHaveLength(5);
  });
});

describe("the identity inventory reads a 75-digit V2 id (A16)", () => {
  it("names the V2 id and the frame's condition id from the book frame", () => {
    expect(frameMarketIdentity(BOOK)).toStrictEqual({
      tokens: [V2_YES],
      conditions: [CANARY.c],
      gammaMarkets: [],
      unidentified: false,
    });
  });

  it("over the whole session, names the V2 id and leaves no frame unidentified", () => {
    const inventory = new MarketIdentityInventory();
    for (const record of RECORDS) inventory.add(record);
    const result = inventory.result();
    expect(result.polymarketTokenIds).toContain(V2_YES);
    expect(result.conditionIds).toContain(CANARY.c);
    expect(result.unidentifiedFrames).toBe(0);
  });

  it("sorts a 75-digit V2 id among 77- and 78-digit V1 ids strictly ascending, as the manifest requires", () => {
    const inventory = new MarketIdentityInventory();
    inventory.add(BOOK);
    for (const id of V1_IDS) {
      inventory.add(frame("9", "2026-10-05T23:16:30.000Z", JSON.stringify([{ event_type: "book", market: "0xc", asset_id: id }])));
    }
    const ids = inventory.result().polymarketTokenIds;
    expect([...ids].sort()).toEqual([...V1_IDS, V2_YES].sort());
    for (let index = 1; index < ids.length; index += 1) {
      // `packages/storage-parquet/src/research-tier-manifest.ts` `identityList`.
      expect((ids[index - 1] as string) < (ids[index] as string)).toBe(true);
    }
  });
});

describe("the interpreter and the sampler key the V2 book by its 75-digit id (A16)", () => {
  it("reads the V2 book frame through the shipped door into one pm-book observation", () => {
    const interpretation = new FrameInterpreter().interpret(BOOK);
    expect(interpretation).toStrictEqual({
      category: "polymarket-market",
      interpreted: true,
      observations: [{ kind: "pm-book", entryIndex: 0, conditionId: CANARY.c, tokenId: V2_YES, bids: [], asks: [] }],
      problems: [],
      snapshotTradesExcluded: 0,
    });
  });

  it("releases book samples for the V2 id, and the PONGs and the unrelated new_market add no book", () => {
    const interpreter = new FrameInterpreter();
    const sampler = new ResearchSampler({ gatewayEpoch: EPOCH, state: null });
    for (const record of RECORDS) {
      sampler.consume({ record, segmentId: "s0", interpretation: interpreter.interpret(record) });
    }
    // A later frame closes the 1 s and the 60 s spans the session opened.
    const release = frame("8", "2026-10-05T23:17:00.000Z", "PONG");
    sampler.consume({ record: release, segmentId: "s0", interpretation: interpreter.interpret(release) });
    for (const table of ["pm_top_of_book", "pm_depth", "pm_full_book"] as const) {
      const rows = sampler.rows().get(table) ?? [];
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows) expect([row["tokenId"], row["conditionId"]], table).toEqual([V2_YES, CANARY.c]);
    }
    // Top of book and depth are on-change samples: the unchanged empty book is released once.
    expect(sampler.rows().get("pm_top_of_book")).toHaveLength(1);
    expect(sampler.rows().get("pm_depth")).toHaveLength(1);
    expect(sampler.rows().get("pm_full_book")?.[0]).toMatchObject({ bidLevelCount: 0, askLevelCount: 0, bidsJson: "[]", asksJson: "[]" });
  });
});
