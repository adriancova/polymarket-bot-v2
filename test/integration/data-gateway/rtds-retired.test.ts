/**
 * `RTDS-RETIRE` (2026-10-05; the user's `V3-C13-REFERENCE-TWAP` ruling of
 * 2026-10-04): the gateway's RTDS reference-price producer is retired, and
 * every reader of RTDS data recorded before then still reads it.
 *
 * The venue moved its reference/TWAP prices from public RTDS to the
 * authenticated PolyBolt service and plans to remove the legacy RTDS price
 * topics one month after its `0.11.0` SDK release, about 2026-10-23 by the
 * venue report's arithmetic (`docs/venue/verified-2026-09-30.md` E-09 to
 * E-12, C-13, U-20). The ruling is the free route only, so the gateway has nothing
 * to subscribe to.
 *
 * What is asserted here:
 *
 * 1. THE REFUSAL, through the same door `main.ts` calls: a formerly valid
 *    `rtds` block is refused with the dated reason, alone or beside other
 *    feeds, and a gateway built without one has no RTDS metrics section.
 * 2. RECORDED RTDS DATA STAYS READABLE, by readers this round does not touch:
 *    a. RTDS raw frames (the 2026-08-24 fixture's two TWAP updates, in the
 *       documented RTDS wire format the gateway recorded) written to a WAL
 *       segment as `source: "rtds"` read back byte-identical through the WAL
 *       reader;
 *    b. the research tier's interpreter (`apps/research-worker`,
 *       `FrameInterpreter`) reads each as `rtds-twap`, with its Chainlink
 *       observation in exact decimal;
 *    c. the `ReferenceTwapObserved` envelope the retired producer published
 *       (`source: "rtds"`, built by the gateway's own envelope completion,
 *       exactly as the retired driver drafted it) is read by the domain's
 *       event registry and round-trips the event bus's envelope codec.
 *
 * The RTDS adapter's own contract suite (`test/contract/rtds/`) still
 * normalizes the same fixture, through the same read doors.
 */

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DOMAIN_EVENT_REGISTRY } from "@polymarket-bot/domain";
import {
  completeEnvelope,
  GatewayConfigurationError,
  parseGatewayConfig,
  rawFrameCausationId,
  RTDS_RETIRED_REASON,
} from "@polymarket-bot/data-gateway";
import { decodeEnvelope, encodeEnvelope, validateEnvelope } from "@polymarket-bot/event-bus";
import {
  DEFAULT_RTDS_TWAP_FEED_OPTIONS,
  RTDS_TWAP_TOPIC_BY_WINDOW,
  RTDS_WEBSOCKET_URL,
  TwapObservationTracker,
  decodeInboundRtdsFrame,
  normalizeRtdsFrame,
} from "@polymarket-bot/polymarket-public/rtds";
import { listSegmentManifests, openWalWriter, readSegmentRecords } from "@polymarket-bot/storage-wal";
import {
  createManualClock,
  createMemoryFileSystem,
  createTestFrame,
  TEST_GATEWAY_EPOCH,
} from "@polymarket-bot/storage-wal/testing";

import { FrameInterpreter } from "../../../apps/research-worker/src/research-tier/interpret.js";

import { buildHarness, MARKET, STREAM } from "./support/harness.js";

/** The block a configuration written before the retirement carried. */
const FORMER_RTDS_BLOCK = {
  feedId: "polymarket-rtds-twap",
  subscriptions: [{ windowSeconds: 60 }],
  plannedSymbols: ["btc/usd"],
  maxObservationAgeMs: 300_000,
} as const;

interface FixtureExample {
  readonly name: string;
  readonly payload: unknown;
}

/** The 2026-08-24 RTDS fixture's examples, verbatim. */
async function rtdsFixtureExamples(): Promise<readonly FixtureExample[]> {
  const url = new URL("../../fixtures/venue/rtds/twap-update.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as { readonly examples: readonly FixtureExample[] };
  return fixture.examples;
}

/** The fixture's two TWAP updates as RTDS wire text, the form the gateway recorded. */
async function recordedTwapFrames(): Promise<readonly { readonly name: string; readonly text: string }[]> {
  const examples = await rtdsFixtureExamples();
  return ["twap-update-30s", "twap-update-60s"].map((name) => {
    const example = examples.find((candidate) => candidate.name === name);
    if (example === undefined) throw new Error(`the RTDS fixture has no ${name} example`);
    return { name, text: JSON.stringify(example.payload) };
  });
}

/** The receipt instant of a frame: half a second after its observation. */
const RECEIVED_AT = ["2026-07-27T19:00:00.500Z", "2026-07-27T19:01:00.500Z"] as const;

describe("RTDS-RETIRE — the gateway refuses the retired RTDS feed", () => {
  it("refuses a formerly valid rtds block at the configuration door, with the dated V3-C13 reason", async () => {
    // The harness parses its configuration through `parseGatewayConfig`, the
    // call `main.ts` makes before it builds anything, so the refusal is the
    // startup failure an operator sees (`data-gateway: <reason>` + details).
    const refusal: unknown = await buildHarness({ config: { rtds: FORMER_RTDS_BLOCK } }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(GatewayConfigurationError);
    expect(refusal).toMatchObject({
      code: "GATEWAY_CONFIGURATION",
      message: RTDS_RETIRED_REASON,
      details: { retiredOn: "2026-10-05", ruling: "V3-C13", issues: [{ path: "rtds", message: RTDS_RETIRED_REASON }] },
    });

    // The same refusal beside other, valid feeds.
    expect(() =>
      parseGatewayConfig({
        streamName: STREAM,
        wal: { rootPath: "/wal" },
        markets: [MARKET],
        polymarket: { feedId: "polymarket-market" },
        binance: { feedId: "binance-reference", symbols: ["BTCUSDT"], stalenessThresholdMs: 30_000 },
        rtds: FORMER_RTDS_BLOCK,
      }),
    ).toThrow(RTDS_RETIRED_REASON);
    expect(RTDS_RETIRED_REASON).toMatch(/^the rtds feed is retired \(RTDS-RETIRE, 2026-10-05; ruling V3-C13 of 2026-10-04\): /u);
  });

  it("a running gateway has no RTDS metrics section (the exporter then emits no recorder_rtds_* series)", async () => {
    // Before this round `metrics()` always carried an own `rtds` key (its
    // value `undefined` when unconfigured). Now the key does not exist, and
    // `packages/observability`'s renderer omits every `recorder_rtds_*` sample
    // for an absent section (its own "omits absent feed … sections" test).
    const harness = await buildHarness({ config: { polymarket: { feedId: "polymarket-market" } } });
    harness.gateway.start();
    await harness.settle();
    expect(Object.hasOwn(harness.gateway.metrics(), "rtds")).toBe(false);
    await harness.gateway.stop();
  });
});

describe("RTDS-RETIRE — RTDS data recorded before the retirement stays readable", () => {
  it("a recorded RTDS frame survives the WAL byte-identical, and the research tier still interprets it", async () => {
    const frames = await recordedTwapFrames();
    const fileSystem = createMemoryFileSystem();
    const writer = await openWalWriter({
      directoryPath: "/wal",
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock: createManualClock(),
    });
    const written = frames.map((frame, index) =>
      createTestFrame({
        ingestSeq: index + 1,
        source: "rtds",
        endpoint: RTDS_WEBSOCKET_URL,
        connectionId: "polymarket-rtds-twap:conn-1",
        subscriptionGeneration: 1,
        receivedAt: RECEIVED_AT[index] ?? RECEIVED_AT[0],
        payloadUtf8: frame.text,
      }),
    );
    for (const record of written) {
      expect(writer.enqueue(record).accepted).toBe(true);
    }
    await writer.drain();
    await writer.close();

    // (a) The WAL reader: every RTDS frame, verbatim, digest intact.
    const manifests = await listSegmentManifests(fileSystem, "/wal");
    expect(manifests).toHaveLength(1);
    const read = await readSegmentRecords(fileSystem, `/wal/${manifests[0]?.segmentFileName ?? ""}`);
    expect(read.records).toStrictEqual(written);
    expect(read.records.map((record) => record.source)).toEqual(["rtds", "rtds"]);

    // (b) The research tier's interpreter, unchanged by this round.
    const interpreter = new FrameInterpreter();
    const interpretations = read.records.map((record) => interpreter.interpret(record));
    expect(interpretations.map((interpretation) => interpretation.category)).toEqual(["rtds-twap", "rtds-twap"]);
    expect(interpretations.map((interpretation) => interpretation.problems)).toEqual([[], []]);
    expect(interpretations.map((interpretation) => interpretation.observations)).toStrictEqual([
      [
        {
          kind: "chainlink",
          entryIndex: 0,
          topic: "rtds:crypto_prices_twap_thirty",
          symbol: "btc/usd",
          value: "65000.5",
          observedAt: "2026-07-27T19:00:00.000Z",
        },
      ],
      [
        {
          kind: "chainlink",
          entryIndex: 0,
          topic: "rtds:crypto_prices_twap_sixty",
          symbol: "eth/usd",
          value: "3200.25",
          observedAt: "2026-07-27T19:01:00.000Z",
        },
      ],
    ]);
  });

  it("the ReferenceTwapObserved envelope the retired producer published is read by the domain and the event bus", async () => {
    const [frame] = await recordedTwapFrames();
    if (frame === undefined) throw new Error("no recorded frame");
    const decoded = decodeInboundRtdsFrame(frame.text);
    if (decoded.kind !== "values") throw new Error(`the recorded frame did not decode: ${decoded.kind}`);
    const normalized = normalizeRtdsFrame(decoded.values, {
      sourceChannel: RTDS_WEBSOCKET_URL,
      connectionId: "polymarket-rtds-twap:conn-1",
      subscriptionGeneration: 1,
      subscribedTopics: new Set(Object.values(RTDS_TWAP_TOPIC_BY_WINDOW)),
      receivedEpochMs: Date.parse(RECEIVED_AT[0]),
      tracker: new TwapObservationTracker({
        duplicateWindow: DEFAULT_RTDS_TWAP_FEED_OPTIONS.duplicateWindowPerSeries,
        maxTrackedSeries: DEFAULT_RTDS_TWAP_FEED_OPTIONS.maxTrackedSeries,
      }),
    });
    expect(normalized.problems).toEqual([]);
    const [event] = normalized.events;
    if (event === undefined) throw new Error("no normalized observation");

    // Drafted exactly as the retired driver drafted it, then completed by the
    // gateway's own envelope assignment, which validates the frozen contract.
    const completed = completeEnvelope(
      {
        eventType: event.eventType,
        schemaVersion: event.schemaVersion,
        source: event.provenance.source,
        sourceChannel: event.provenance.sourceChannel,
        venueTimestamp: event.provenance.venueTimestamp,
        connectionId: event.provenance.connectionId,
        subscriptionGeneration: event.provenance.subscriptionGeneration,
        payload: event.payload,
      },
      {
        eventId: "0190a3e0-0000-7000-8000-0000000000a1",
        gatewayEpoch: TEST_GATEWAY_EPOCH,
        ingestSeq: "2",
        receipt: { receivedAt: RECEIVED_AT[0], receivedMonotonicNs: "2000000", nowMs: Date.parse(RECEIVED_AT[0]) },
        causationId: rawFrameCausationId(TEST_GATEWAY_EPOCH, "1"),
      },
    );
    if (!completed.ok) throw new Error(completed.detail);
    const envelope = completed.envelope;
    expect(envelope).toMatchObject({
      eventType: "ReferenceTwapObserved",
      source: "rtds",
      payload: { venue: "rtds", symbol: "btc/usd", value: "65000.5", windowSeconds: 30 },
    });

    // The domain's registry: the §7.1 `source` vocabulary still has `rtds`.
    expect(DOMAIN_EVENT_REGISTRY.parseEnvelope(envelope)).toStrictEqual(envelope);
    // The event bus: its envelope door, and a stream entry's encode/decode.
    // (Its doors emit prototype-free trees, so the comparison is by value.)
    expect(validateEnvelope(envelope)).toEqual(envelope);
    expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
  });
});
