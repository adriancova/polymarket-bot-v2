/**
 * The replay-side driver and the normalized-envelope normalizer (BACKTEST-1).
 *
 * These pin the two pieces this app SHIPS for the shared core's replay path,
 * against a structural loop double. The fixture-driven proof over the REAL
 * core — which this app builds itself since `BACKTEST-2` (`assembly.ts`) — is
 * `test/unit/simulation/backtest-static-bracket-replay.test.ts` and
 * `assembly.test.ts`. What a double can prove here is the driver's contract:
 * the clock is advanced to the recorded instant BEFORE the event is ingested,
 * one drain follows every ingest, a refused ingest stops the run with the
 * event named, a clock regression is the clock's own refusal, and (BT1-R3) a
 * latched halt stops the run where the live pump returns `HALTED`.
 *
 * SAFETY: no venue connection, no credential, no order. Nothing here reads a
 * clock, a file or the environment.
 */

import { createHash } from "node:crypto";

import {
  createReplayClock,
  simulationOk,
  type ReplayCoreLoop,
  type ReplayEventContext,
  type ReplayRecord,
  type Sha256HexDigest,
} from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import {
  endOfRunBoundTo,
  recordFraming,
  replayDrivenCoreLoop,
  type ReplayDrivenLoop,
  type ReplayIngestedEvent,
} from "./core-loop.js";
import {
  NORMALIZED_ENVELOPE_NORMALIZER_VERSION,
  normalizedEnvelopeNormalizer,
} from "./normalizer.js";

const sha256Hex: Sha256HexDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

const GATEWAY_EPOCH = "019b1e00-0000-7000-8000-0000000000aa";
const MARKET_ID = "019b1e00-0000-7000-8000-0000000000ab";

function record(input: {
  readonly ingestSeq: string;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly source?: string;
  readonly payloadUtf8: string;
}): ReplayRecord {
  return {
    datasetRowOrdinal: Number(input.ingestSeq) - 1,
    segmentId: `${GATEWAY_EPOCH}-000000`,
    segmentRecordIndex: Number(input.ingestSeq) - 1,
    frameLineSha256: sha256Hex(new Uint8Array(Buffer.from(`line:${input.ingestSeq}`, "utf8"))),
    frame: {
      gatewayEpoch: GATEWAY_EPOCH,
      ingestSeq: input.ingestSeq,
      source: input.source ?? "polymarket",
      endpoint: "stream://polymarket.normalized",
      connectionId: "conn-1",
      subscriptionGeneration: 1,
      receivedAt: input.receivedAt,
      receivedMonotonicNs: input.receivedMonotonicNs,
      payloadUtf8: input.payloadUtf8,
      payloadSha256: sha256Hex(new Uint8Array(Buffer.from(input.payloadUtf8, "utf8"))),
    },
  };
}

function contextOf(replayRecord: ReplayRecord): ReplayEventContext {
  return {
    envelope: {
      eventId: "019b1e00-0000-7000-8000-0000000000ac",
      eventType: "MarketOpened",
      schemaVersion: 1,
      source: "polymarket",
      sourceChannel: "market",
      receivedAt: replayRecord.frame.receivedAt,
      receivedMonotonicNs: replayRecord.frame.receivedMonotonicNs,
      gatewayEpoch: replayRecord.frame.gatewayEpoch,
      ingestSeq: replayRecord.frame.ingestSeq,
      payload: {},
    },
    record: replayRecord,
    identity: {
      gatewayEpoch: replayRecord.frame.gatewayEpoch,
      ingestSeq: replayRecord.frame.ingestSeq,
      receivedAt: replayRecord.frame.receivedAt,
      datasetRowOrdinal: replayRecord.datasetRowOrdinal,
    },
    monotonicNs: BigInt(replayRecord.frame.receivedMonotonicNs),
  };
}

/** The core's halt latch, structurally (`HaltController`'s `anyHalt` and `records()`). */
function haltLatch() {
  const records: { readonly code: string; readonly scope: { readonly kind: string } }[] = [];
  return {
    latch(code: string, kind: string): void {
      records.push({ code, scope: { kind } });
    },
    get anyHalt(): boolean {
      return records.length > 0;
    },
    records() {
      return [...records];
    },
  };
}

/** A structural loop double that records what it saw and when. */
function loopDouble(options: { readonly refuseFrom?: number } = {}) {
  const seen: { readonly event: ReplayIngestedEvent; readonly clockAtIngest: string; readonly monotonicAtIngest: bigint }[] = [];
  const endOfRunChecks: string[] = [];
  let drains = 0;
  let drainedAfterIngest = true;
  let clock: { now(): string; monotonicNs(): bigint } | undefined;
  return {
    bind(replayClock: { now(): string; monotonicNs(): bigint }): void {
      clock = replayClock;
    },
    get seen() {
      return seen;
    },
    get drains() {
      return drains;
    },
    get drainedAfterIngest() {
      return drainedAfterIngest;
    },
    /** `FOLD-1`: the triggers the core's end-of-run check was run with. */
    get endOfRunChecks() {
      return endOfRunChecks;
    },
    ingest(event: ReplayIngestedEvent): boolean {
      if (options.refuseFrom !== undefined && seen.length >= options.refuseFrom) return false;
      seen.push({
        event,
        clockAtIngest: clock?.now() ?? "",
        monotonicAtIngest: clock?.monotonicNs() ?? -1n,
      });
      drainedAfterIngest = false;
      return true;
    },
    async drain(): Promise<void> {
      drains += 1;
      drainedAfterIngest = true;
      return await Promise.resolve();
    },
    checkAccountingRebuild(trigger: "END_OF_RUN"): { readonly matched: boolean } {
      endOfRunChecks.push(trigger);
      return { matched: true };
    },
  };
}

describe("replayDrivenCoreLoop — the shipped driver of the shared core", () => {
  it("advances the replay clock to the recorded instant BEFORE ingesting, then drains once per event", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    expect(clock.ok).toBe(true);
    if (!clock.ok) return;
    const loop = loopDouble();
    loop.bind(clock.value);
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value });

    const first = record({ ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "1000000", payloadUtf8: "{}" });
    const second = record({ ingestSeq: "2", receivedAt: "2026-05-01T09:00:01.000Z", receivedMonotonicNs: "2000000", payloadUtf8: "{}" });
    expect((await driver.coreLoop(contextOf(first))).ok).toBe(true);
    expect((await driver.coreLoop(contextOf(second))).ok).toBe(true);

    expect(loop.seen.map((entry) => entry.clockAtIngest)).toEqual([
      "2026-05-01T09:00:00.000Z",
      "2026-05-01T09:00:01.000Z",
    ]);
    expect(loop.seen.map((entry) => entry.monotonicAtIngest)).toEqual([1000000n, 2000000n]);
    // The envelope and the recorded identity reach the loop unaltered.
    expect(loop.seen[1]?.event.identity).toEqual({
      gatewayEpoch: GATEWAY_EPOCH,
      ingestSeq: "2",
      receivedAt: "2026-05-01T09:00:01.000Z",
      datasetRowOrdinal: 1,
    });
    expect(loop.seen[1]?.event.envelope.ingestSeq).toBe("2");
    expect(loop.drains).toBe(2);
    expect(loop.drainedAfterIngest).toBe(true);
    expect(driver.observations()).toEqual({ eventsIngested: 2, drains: 2 });
  });

  it("a refused ingest STOPS the run with the event named, and nothing is drained for it", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) return;
    const loop = loopDouble({ refuseFrom: 1 });
    loop.bind(clock.value);
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value });

    const first = record({ ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "1000000", payloadUtf8: "{}" });
    const second = record({ ingestSeq: "2", receivedAt: "2026-05-01T09:00:01.000Z", receivedMonotonicNs: "2000000", payloadUtf8: "{}" });
    expect((await driver.coreLoop(contextOf(first))).ok).toBe(true);
    const refused = await driver.coreLoop(contextOf(second));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("SIMULATION_INTERNAL");
    expect(refused.refusal.message).toContain("QUEUE_BACKPRESSURE");
    expect(refused.refusal.details).toMatchObject({ ingestSeq: "2", datasetRowOrdinal: 1, eventType: "MarketOpened" });
    expect(loop.drains).toBe(1);
    expect(driver.observations()).toEqual({ eventsIngested: 1, drains: 1 });
  });

  it("FOLD-1: endOfRun() runs the core's END_OF_RUN accounting rebuild check once, and is BOUND to the coreLoop the driver built", () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) return;
    const loop = loopDouble();
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value });
    expect(loop.endOfRunChecks).toEqual([]);
    driver.endOfRun();
    expect(loop.endOfRunChecks).toEqual(["END_OF_RUN"]);
    // FOLD1-R1-3: the binding `runBacktest` reads — this driver's check, and no other hook's.
    expect(endOfRunBoundTo(driver.coreLoop)).toBe(driver.endOfRun);
    const handBuilt: ReplayCoreLoop = () => simulationOk(null);
    expect(endOfRunBoundTo(handBuilt)).toBeUndefined();
    const other = replayDrivenCoreLoop({ loop: loopDouble(), clock: clock.value });
    expect(endOfRunBoundTo(other.coreLoop)).toBe(other.endOfRun);
    expect(endOfRunBoundTo(other.coreLoop)).not.toBe(driver.endOfRun);
  });

  it("FOLD1-R1-3: a core with NO end-of-run check is refused at construction — before anything is driven", () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) return;
    const { checkAccountingRebuild: _dropped, ...withoutCheck } = loopDouble();
    expect(typeof _dropped).toBe("function");
    expect(() =>
      replayDrivenCoreLoop({ loop: withoutCheck as unknown as ReplayDrivenLoop, clock: clock.value }),
    ).toThrow(/no checkAccountingRebuild/u);
  });

  it("BT1-R3: a halt latched DURING a drain stops the run after that drain, naming the halt, and no later event is ingested", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) return;
    const halts = haltLatch();
    const inner = loopDouble();
    inner.bind(clock.value);
    // The second drain latches a halt, as the real core latches one inside `drain`.
    const loop: ReplayDrivenLoop = {
      ingest: (event) => inner.ingest(event),
      drain: async () => {
        await inner.drain();
        if (inner.drains === 2) halts.latch("STORE_UNAVAILABLE", "GLOBAL");
      },
      checkAccountingRebuild: (trigger) => inner.checkAccountingRebuild(trigger),
    };
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value, halts });

    const events = [1, 2, 3].map((seq) =>
      record({
        ingestSeq: String(seq),
        receivedAt: `2026-05-01T09:00:0${String(seq)}.000Z`,
        receivedMonotonicNs: `${String(seq)}000000`,
        payloadUtf8: "{}",
      }),
    );
    expect((await driver.coreLoop(contextOf(events[0] as ReplayRecord))).ok).toBe(true);
    const stopped = await driver.coreLoop(contextOf(events[1] as ReplayRecord));
    expect(stopped.ok).toBe(false);
    if (stopped.ok) return;
    expect(stopped.refusal.code).toBe("SIMULATION_INTERNAL");
    expect(stopped.refusal.message).toContain("STORE_UNAVAILABLE@GLOBAL");
    expect(stopped.refusal.message).toContain("pump.ts");
    expect(stopped.refusal.details).toMatchObject({
      halts: "STORE_UNAVAILABLE@GLOBAL",
      stoppedAt: "AFTER_DRAIN",
      ingestSeq: "2",
      datasetRowOrdinal: 1,
    });
    // `runReplay` stops at the first refusal; were it offered another event,
    // the driver would still not ingest it — the pump's loop-top check.
    const after = await driver.coreLoop(contextOf(events[2] as ReplayRecord));
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.refusal.details).toMatchObject({ stoppedAt: "BEFORE_INGEST", ingestSeq: "3" });
    expect(inner.seen.map((entry) => entry.event.envelope.ingestSeq)).toEqual(["1", "2"]);
    expect(driver.observations()).toEqual({ eventsIngested: 2, drains: 2 });
  });

  it("BT1-R3: a core ALREADY halted is refused before ingesting — and before its clock moves", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) return;
    const halts = haltLatch();
    halts.latch("OPERATOR_HALT", "GLOBAL");
    halts.latch("BOOK_DESYNCHRONIZED", "MARKET");
    const loop = loopDouble();
    loop.bind(clock.value);
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value, halts });
    const refused = await driver.coreLoop(
      contextOf(record({ ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "1000000", payloadUtf8: "{}" })),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.details).toMatchObject({
      halts: "OPERATOR_HALT@GLOBAL,BOOK_DESYNCHRONIZED@MARKET",
      stoppedAt: "BEFORE_INGEST",
    });
    expect(loop.seen).toEqual([]);
    expect(loop.drains).toBe(0);
    expect(clock.value.now()).toBe("2026-05-01T08:59:58.000Z");
  });

  it("BT1-R3: WITHOUT a halt latch the driver cannot see a halt and keeps delivering — BACKTEST-1's behaviour, kept for a caller that hands none", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) return;
    const halts = haltLatch();
    halts.latch("STORE_UNAVAILABLE", "GLOBAL");
    const loop = loopDouble();
    loop.bind(clock.value);
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value });
    for (const seq of [1, 2]) {
      const delivered = await driver.coreLoop(
        contextOf(
          record({
            ingestSeq: String(seq),
            receivedAt: `2026-05-01T09:00:0${String(seq)}.000Z`,
            receivedMonotonicNs: `${String(seq)}000000`,
            payloadUtf8: "{}",
          }),
        ),
      );
      expect(delivered.ok).toBe(true);
    }
    expect(driver.observations()).toEqual({ eventsIngested: 2, drains: 2 });
  });

  it("a monotonic regression is the replay clock's own refusal, and the event is never ingested", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "5000000" });
    if (!clock.ok) return;
    const loop = loopDouble();
    loop.bind(clock.value);
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value });
    const earlier = record({ ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "4000000", payloadUtf8: "{}" });
    const refused = await driver.coreLoop(contextOf(earlier));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("REPLAY_CLOCK_NOT_MONOTONE");
    expect(loop.seen).toEqual([]);
    expect(loop.drains).toBe(0);
  });
});

describe("normalizedEnvelopeNormalizer — a recording of the §7.4 stream", () => {
  const normalizer = normalizedEnvelopeNormalizer(sha256Hex);

  function opened(receivedAt = "2026-05-01T09:00:00.000Z"): ReplayRecord {
    return record({
      ingestSeq: "3",
      receivedAt,
      receivedMonotonicNs: "3000000",
      payloadUtf8: JSON.stringify({
        eventType: "MarketOpened",
        schemaVersion: 1,
        sourceChannel: "market",
        payload: { internalMarketId: MARKET_ID, conditionId: "0xcond", openedAt: receivedAt },
      }),
    });
  }

  it("names itself, and the name says what the recording is", () => {
    expect(normalizer.normalizerVersion).toBe(NORMALIZED_ENVELOPE_NORMALIZER_VERSION);
    expect(normalizer.normalizerVersion).toBe("backtest-cli/normalized-envelope/v1");
  });

  it("emits ONE envelope per frame, with provenance copied from the frame and a derived UUIDv7 id", () => {
    const outcome = normalizer.normalize(opened());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.envelopes.length).toBe(1);
    const envelope = outcome.envelopes[0];
    expect(envelope?.eventType).toBe("MarketOpened");
    expect(envelope?.schemaVersion).toBe(1);
    expect(envelope?.source).toBe("polymarket");
    expect(envelope?.sourceChannel).toBe("market");
    expect(envelope?.gatewayEpoch).toBe(GATEWAY_EPOCH);
    expect(envelope?.ingestSeq).toBe("3");
    expect(envelope?.receivedAt).toBe("2026-05-01T09:00:00.000Z");
    expect(envelope?.receivedMonotonicNs).toBe("3000000");
    expect(envelope?.rawRecordOffset).toBe("2");
    expect(envelope?.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    // Deterministic: the same frame yields the same id (§12.4).
    const again = normalizer.normalize(opened());
    expect(again.ok && again.envelopes[0]?.eventId).toBe(envelope?.eventId);
    // D4: prototype-free and frozen.
    expect(Object.getPrototypeOf(envelope)).toBeNull();
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope?.payload)).toBe(true);
  });

  it("REFUSES a payload the frozen contract rejects, rather than delivering it", () => {
    const missingField = record({
      ingestSeq: "3",
      receivedAt: "2026-05-01T09:00:00.000Z",
      receivedMonotonicNs: "3000000",
      payloadUtf8: JSON.stringify({
        eventType: "MarketOpened",
        schemaVersion: 1,
        sourceChannel: "market",
        payload: { internalMarketId: MARKET_ID, conditionId: "0xcond" },
      }),
    });
    const outcome = normalizer.normalize(missingField);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("failed its frozen packages/domain contract");
  });

  it("REFUSES a contract the registry does not carry", () => {
    const unknown = record({
      ingestSeq: "3",
      receivedAt: "2026-05-01T09:00:00.000Z",
      receivedMonotonicNs: "3000000",
      payloadUtf8: JSON.stringify({ eventType: "MarketTeleported", schemaVersion: 1, sourceChannel: "market", payload: {} }),
    });
    const outcome = normalizer.normalize(unknown);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("not a registered packages/domain event contract");
  });

  it("REFUSES a restated provenance that disagrees with the frame's source", () => {
    // `ReferenceTradeObserved.venue` restates the envelope `source`; the frame
    // says polymarket, the payload says binance, and the contract refuses it.
    const disagreeing = record({
      ingestSeq: "1",
      receivedAt: "2026-05-01T08:59:58.000Z",
      receivedMonotonicNs: "1000000",
      source: "polymarket",
      payloadUtf8: JSON.stringify({
        eventType: "ReferenceTradeObserved",
        schemaVersion: 1,
        sourceChannel: "trade",
        payload: { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" },
      }),
    });
    expect(normalizer.normalize(disagreeing).ok).toBe(false);
    const agreeing = record({
      ingestSeq: "1",
      receivedAt: "2026-05-01T08:59:58.000Z",
      receivedMonotonicNs: "1000000",
      source: "binance",
      payloadUtf8: JSON.stringify({
        eventType: "ReferenceTradeObserved",
        schemaVersion: 1,
        sourceChannel: "trade",
        payload: { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" },
      }),
    });
    expect(normalizer.normalize(agreeing).ok).toBe(true);
  });

  it.each([
    ["not strict JSON", "{\"eventType\":\"MarketOpened\",\"eventType\":\"MarketOpened\"}", "not strict JSON"],
    ["no eventType", JSON.stringify({ schemaVersion: 1, sourceChannel: "market", payload: {} }), "names no eventType"],
    ["a non-integer schemaVersion", JSON.stringify({ eventType: "MarketOpened", schemaVersion: "1", sourceChannel: "market", payload: {} }), "schemaVersion"],
    ["no sourceChannel", JSON.stringify({ eventType: "MarketOpened", schemaVersion: 1, payload: {} }), "names no sourceChannel"],
    ["no payload", JSON.stringify({ eventType: "MarketOpened", schemaVersion: 1, sourceChannel: "market" }), "carries no payload"],
    ["a raw venue frame", "{\"event_type\":\"book\",\"asset_id\":\"1\"}", "names no eventType"],
  ])("REFUSES a recorded frame that is %s", (_label, payloadUtf8, reason) => {
    const outcome = normalizer.normalize(
      record({ ingestSeq: "3", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "3000000", payloadUtf8 }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain(reason);
  });

  it("REFUSES a source outside the §7.1 vocabulary", () => {
    const outcome = normalizer.normalize(
      record({ ingestSeq: "3", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "3000000", source: "kraken", payloadUtf8: "{}" }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("§7.1 event sources");
  });
});

/**
 * `THROUGHPUT-2` (ADR-024): the driver drains once per RECORDED FRAME. A
 * normalizer may derive several envelopes from one record (a two-token
 * `price_change`); the core evaluates the frame once, at its last envelope,
 * only if one drain is handed the whole record.
 */
describe("replayDrivenCoreLoop — one drain per recorded frame (THROUGHPUT-2)", () => {
  function withEventId(context: ReplayEventContext, eventId: string): ReplayEventContext {
    return { ...context, envelope: { ...context.envelope, eventId } };
  }

  it("ingests every envelope of a record but drains only at its LAST; a one-envelope record drains at once", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) throw new Error("clock");
    const loop = loopDouble();
    loop.bind(clock.value);
    const framing = recordFraming();
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value, framing });

    const two = record({ ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "1000000", payloadUtf8: "{}" });
    const one = record({ ingestSeq: "2", receivedAt: "2026-05-01T09:00:01.000Z", receivedMonotonicNs: "2000000", payloadUtf8: "{}" });
    const ids = ["019b1e00-0000-7000-8000-000000000101", "019b1e00-0000-7000-8000-000000000102", "019b1e00-0000-7000-8000-000000000201"];
    // The wrapped normalizer answers first, as `DatasetEventSource.events()` calls it
    // before it yields any of the record's envelopes.
    const answers = new Map([
      ["1", [withEventId(contextOf(two), ids[0] as string).envelope, withEventId(contextOf(two), ids[1] as string).envelope]],
      ["2", [withEventId(contextOf(one), ids[2] as string).envelope]],
    ]);
    const inner = {
      normalizerVersion: "test-normalizer@1",
      normalize: (replayRecord: ReplayRecord) => ({ ok: true as const, envelopes: answers.get(replayRecord.frame.ingestSeq) ?? [] }),
    };
    const wrapped = framing.wrap(inner);
    expect(wrapped.normalizerVersion).toBe("test-normalizer@1");
    const answered = wrapped.normalize(two);
    expect(answered).toEqual(inner.normalize(two));

    expect((await driver.coreLoop(withEventId(contextOf(two), ids[0] as string))).ok).toBe(true);
    expect(loop.drains).toBe(0);
    expect(loop.drainedAfterIngest).toBe(false);
    expect((await driver.coreLoop(withEventId(contextOf(two), ids[1] as string))).ok).toBe(true);
    expect(loop.drains).toBe(1);

    wrapped.normalize(one);
    expect((await driver.coreLoop(withEventId(contextOf(one), ids[2] as string))).ok).toBe(true);
    expect(loop.drains).toBe(2);
    expect(loop.drainedAfterIngest).toBe(true);
    expect(driver.observations()).toEqual({ eventsIngested: 3, drains: 2 });
  });

  it("an envelope of a record the wrapped normalizer never answered for is drained at once (nothing is held back unaccounted)", async () => {
    const clock = createReplayClock({ receivedAt: "2026-05-01T08:59:58.000Z", receivedMonotonicNs: "0" });
    if (!clock.ok) throw new Error("clock");
    const loop = loopDouble();
    loop.bind(clock.value);
    const driver = replayDrivenCoreLoop({ loop, clock: clock.value, framing: recordFraming() });
    const lone = record({ ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "1000000", payloadUtf8: "{}" });
    expect((await driver.coreLoop(contextOf(lone))).ok).toBe(true);
    expect(loop.drains).toBe(1);
  });

  it("the shipped normalized-envelope normalizer is one envelope per record: framing changes no drain", async () => {
    const framing = recordFraming();
    const wrapped = framing.wrap(normalizedEnvelopeNormalizer(sha256Hex));
    expect(wrapped.normalizerVersion).toBe(NORMALIZED_ENVELOPE_NORMALIZER_VERSION);
    const payloadUtf8 = JSON.stringify({
      eventType: "MarketOpened",
      schemaVersion: 1,
      sourceChannel: "market",
      payload: { internalMarketId: MARKET_ID, conditionId: "0xcondition", openedAt: "2026-05-01T09:00:00.000Z" },
    });
    const opened = record({ ingestSeq: "1", receivedAt: "2026-05-01T09:00:00.000Z", receivedMonotonicNs: "1000000", payloadUtf8 });
    const outcome = wrapped.normalize(opened);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.envelopes).toHaveLength(1);
    const envelope = outcome.envelopes[0];
    if (envelope === undefined) throw new Error("no envelope");
    expect(framing.closesFrame({ ...contextOf(opened), envelope })).toBe(true);
  });
});
