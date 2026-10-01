/**
 * `THROUGHPUT-1c` review round 7, finding R7-H1: a frame published across
 * two transport calls, with a publication outage between them, must not
 * vouch for a stale book. The test runs from the gateway to the trader.
 *
 * ADR-023 lets a market-channel frame on a delivery session vouch for every
 * book on that session. The trader closes a frame when the stream moves on
 * or runs dry. So if the gateway publishes a frame in two calls and
 * publication halts between them (an outage), the stream ends with a PREFIX
 * of the frame. The trader then closes that prefix as a whole frame, and the
 * prefix vouches for a book whose change was in the lost tail. At `2d29b2d`
 * two routes did this:
 *
 * - a frame of MORE than 1 024 events, the Redis transport's limit for one
 *   call, is always split at that limit. Review reproduced 2 approved orders
 *   under `CONNECTION_CONFIRMED` (0 under `LAST_CHANGE`) with the default
 *   queue raised to 4 096, the H1 operator's own setting raised it to 16 384;
 * - a frame of FEWER events, queued behind a backlog: a run that already held
 *   up to 255 envelopes could start the frame and stop at 1 024
 *   (`[A200+B824], [B76]` for a 900-event frame B).
 *
 * Now the publisher never starts a frame in a run that cannot hold it whole
 * (`publisher.ts`, "Frame-atomic runs"), and the dispatcher publishes a
 * `GATEWAY_FRAME_SPLIT` incident, naming no market, ahead of every frame too
 * large for one call (`dispatcher.ts`). That incident taints the gateway
 * epoch in the trader (ADR-023 D2 rule 4) before any of the frame's events
 * can close an evaluation.
 *
 * The REAL gateway composition (the data-gateway suite's in-memory harness)
 * feeds everything it published, unchanged and in its order, to the REAL
 * assembled paper trader (the pattern of `throughput-1c-partial-frame-taint`).
 * The outage is the memory transport's own switch, set from its publish
 * observer when the call carrying the late YES snapshot starts, so that call
 * fails whole, like the Redis transport's all-or-nothing script. The one
 * hand-written input is the reference feed. The gateway runs without its
 * Binance feed (see `throughput-1c-partial-frame-taint`).
 *
 * PAPER only. No network, no credential, no signer, no real order.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { describe, expect, it } from "vitest";

import { buildHarness } from "../data-gateway/support/harness.js";
import {
  CONDITION_ID,
  MARKET_ID,
  NO_TOKEN,
  T_CLOSE,
  T_OPEN,
  YES_TOKEN,
  ingested,
  resetEventIds,
  riskPolicy,
  strategyParams,
  traderConfig,
} from "./support/fixture.js";
import { assembleOrThrow } from "./support/run.js";

const GAMMA_BASE = "http://gamma.stub";
const BOOK_AGE_KEY = "quality.input_feed_ages@polymarket.book";
/** The Redis transport's limit for one call (`FRAME_RUN_MAX_ENVELOPES`). */
const ONE_CALL = 1_024;
/** The second frame's instant: the YES book's own last change is then 3.1 s old. */
const LATE_MS = Date.parse(T_OPEN) + 4_100;

const GATEWAY_MARKET = {
  internalMarketId: MARKET_ID,
  conditionId: CONDITION_ID,
  yesTokenId: YES_TOKEN,
  noTokenId: NO_TOKEN,
  gammaMarketId: "900001",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
    openTime: T_OPEN,
    closeTime: T_CLOSE,
  },
  observedAt: "2026-03-04T11:00:00.000Z",
} as const;

const READY_MARKET = {
  conditionId: CONDITION_ID,
  question: "Synthetic market (stub)",
  active: true,
  closed: false,
  archived: false,
  acceptingOrders: true,
  restricted: false,
  enableOrderBook: true,
  negRisk: false,
  startDate: "2026-03-04T12:00:00Z",
  endDate: "2026-03-04T12:15:00Z",
  closedTime: null,
  gameStartTime: null,
};

function bookEntry(tokenId: string, bids: readonly [string, string][], asks: readonly [string, string][]): unknown {
  return {
    event_type: "book",
    market: CONDITION_ID,
    asset_id: tokenId,
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    hash: `hash-${tokenId}`,
    timestamp: "1772625600000",
  };
}

const noBook = (): unknown => bookEntry(NO_TOKEN, [["0.65", "200"]], [["0.66", "200"]]);
/** The late YES change: its ask moves to 0.80, above the 0.35 trigger. */
const yesAway = (): unknown => bookEntry(YES_TOKEN, [["0.79", "200"]], [["0.80", "200"]]);
/** A NO top-of-book event: not a confirmation (ADR-023 D1), and the trader does not act on it. */
const noTopOfBook = (): unknown => ({
  event_type: "best_bid_ask",
  market: CONDITION_ID,
  asset_id: NO_TOKEN,
  best_bid: "0.65",
  best_ask: "0.66",
  spread: "0.01",
  timestamp: String(LATE_MS),
});

function repeat(count: number, entry: () => unknown): unknown[] {
  return Array.from({ length: count }, entry);
}

type Basis = "LAST_CHANGE" | "CONNECTION_CONFIRMED";

/** The fixture document with both freshness gates at 2 000 ms, room for a large frame, and the given basis. */
function config(basis: Basis): Record<string, unknown> {
  const params = strategyParams() as { data_quality: Record<string, unknown> } & Record<string, unknown>;
  const policy = riskPolicy() as { freshness: Record<string, unknown> } & Record<string, unknown>;
  const document = traderConfig({
    queues: { ingestMaximumDepth: 4_096, outboxMaximumDepth: 1_024 },
    riskPolicy: { ...policy, freshness: { ...policy.freshness, venueBookMaxAgeMs: 2_000 } },
    bookFreshness:
      basis === "CONNECTION_CONFIRMED"
        ? { basis, maximumLastChangeAgeMs: 30_000 }
        : { basis },
  });
  const instances = document["instances"] as Record<string, unknown>[];
  const instance = instances[0] as Record<string, unknown>;
  instance["params"] = {
    ...params,
    version: 2,
    data_quality: { ...params.data_quality, maximum_book_age_ms: 2_000, book_age_feature_key: BOOK_AGE_KEY },
  };
  return document;
}

interface Timeline {
  /** The gateway's admission depth (the default is 1 024; the H1 operator ran 16 384). */
  readonly maxQueueDepth: number;
  /** The socket messages sent at +4.100 s, in order. */
  readonly lateMessages: readonly (readonly unknown[])[];
  /**
   * Hold the transport from the first late message on: that message's call
   * is in flight before the others are sent, so they queue behind it.
   */
  readonly backlog: boolean;
  /** Take the transport down when the call carrying the late YES snapshot starts. */
  readonly loseTheYesCall: boolean;
}

interface GatewayRun {
  readonly published: readonly EventEnvelope<unknown>[];
  readonly halts: readonly string[];
  /** Per transport call made from +4.100 s until the gateway stops: the labels of its envelopes. */
  readonly calls: readonly (readonly string[])[];
}

function label(envelope: EventEnvelope<unknown>): string {
  const payload = envelope.payload as { tokenId?: unknown; reasonCode?: unknown };
  if (envelope.eventType === "BookSnapshot") return payload.tokenId === YES_TOKEN ? "YES" : "NO";
  if (envelope.eventType === "BestBidAskChanged") return "TOB";
  if (envelope.eventType === "DataQualityIncidentOpened") return `INCIDENT:${String(payload.reasonCode)}`;
  return envelope.eventType;
}

/**
 * The gateway timeline: the lifecycle's `MarketOpened` at the open; the YES
 * book (asks under the 0.35 trigger) at +1.000 s; then nothing for the YES
 * token until the late messages at +4.100 s.
 */
async function gatewayRun(timeline: Timeline): Promise<GatewayRun> {
  const route = (request: PublicHttpRequest): PublicHttpResponse => {
    if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      return { status: 200, body: JSON.stringify(READY_MARKET) };
    }
    throw new Error(`unexpected request ${request.url}`);
  };
  const gateway = await buildHarness({
    config: {
      markets: [GATEWAY_MARKET],
      publisher: { maxQueueDepth: timeline.maxQueueDepth },
      polymarket: { feedId: "polymarket-market" },
      lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
    },
    http: route,
  });
  gateway.timers.advance(Date.parse(T_OPEN) - gateway.clock.nowMs());
  gateway.gateway.start();
  await gateway.settle();
  const socket = gateway.polymarketSockets.current;
  socket.open();
  await gateway.settle();
  gateway.timers.advance(1_000);
  socket.message(JSON.stringify([bookEntry(YES_TOKEN, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]])]));
  await gateway.settle();
  gateway.timers.advance(3_100);

  const transport = gateway.transport;
  const firstLateCall = transport.batchCalls + 1;
  const calls: string[][] = [];
  transport.setPublishObserver((envelope) => {
    const index = transport.batchCalls - firstLateCall;
    (calls[index] ??= []).push(label(envelope));
    if (timeline.loseTheYesCall && label(envelope) === "YES") transport.setUnavailable(true);
  });
  const [first, ...rest] = timeline.lateMessages;
  if (timeline.backlog) transport.stallPublishes();
  if (first !== undefined) socket.message(JSON.stringify(first));
  // With a backlog, let the first message's call start (and hang) before the
  // rest is sent: one macrotask, after every microtask the pump queued.
  if (timeline.backlog) await new Promise<void>((resolve) => setImmediate(resolve));
  for (const message of rest) socket.message(JSON.stringify(message));
  if (timeline.backlog) transport.resumePublishes();
  await gateway.settle();
  const beforeStop = calls.map((call) => [...call]);
  await gateway.gateway.stop();
  return { published: gateway.published(), halts: [...gateway.halts], calls: beforeStop };
}

interface Outcome {
  readonly orders: number;
  readonly approvals: number;
  readonly staleBookPauses: number;
}

async function trade(published: readonly EventEnvelope<unknown>[], basis: Basis): Promise<Outcome> {
  const run = assembleOrThrow({ config: config(basis) });
  resetEventIds();
  // The reference feed (hand-written, see the header), just before the open.
  run.trader.loop.ingest(
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
      { receivedAt: "2026-03-04T11:59:58.000Z", ingestSeq: 1, source: "binance" },
    ),
  );
  run.trader.loop.ingest(
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100100", size: "0.25" },
      { receivedAt: "2026-03-04T11:59:59.000Z", ingestSeq: 2, source: "binance" },
    ),
  );
  for (const [index, envelope] of published.entries()) {
    run.trader.loop.ingest({
      envelope,
      identity: {
        gatewayEpoch: envelope.gatewayEpoch,
        ingestSeq: envelope.ingestSeq,
        receivedAt: envelope.receivedAt,
        datasetRowOrdinal: index + 1,
      },
    });
  }
  // The process clock at the late frame's instant: no process lag (ADR-023 D7).
  run.parts.clock.positionAt(new Date(LATE_MS).toISOString(), 4_100_000_000n);
  await run.trader.loop.drain();
  const health = run.trader.loop.health();
  expect(health.halts).toEqual([]);
  expect(run.trader.markets.get(MARKET_ID)?.lifecycle).toBe("OPEN");
  return {
    orders: run.trader.loop.orderProvenance().length,
    approvals: health.risk.approvals,
    staleBookPauses: run.parts.store.decisions.filter((recorded) =>
      recorded.record.decision.reasonCodes.includes("SB.STALE_BOOK"),
    ).length,
  };
}

/** The published stream from +4.100 s on (everything before it is the open and the YES book). */
function late(published: readonly EventEnvelope<unknown>[]): readonly EventEnvelope<unknown>[] {
  return published.filter((envelope) => Date.parse(envelope.receivedAt) >= LATE_MS);
}

function count(envelopes: readonly EventEnvelope<unknown>[], wanted: string): number {
  return envelopes.filter((envelope) => label(envelope) === wanted).length;
}

describe("THROUGHPUT-1c r7 (R7-H1) — a frame split across transport calls cannot vouch for a stale book, gateway to trader", () => {
  it("a frame over the one-call limit, its tail lost to an outage: GATEWAY_FRAME_SPLIT precedes it, and no order is admitted under either basis", async () => {
    const run = await gatewayRun({
      maxQueueDepth: 4_096,
      lateMessages: [[...repeat(ONE_CALL, noBook), yesAway()]],
      backlog: false,
      loseTheYesCall: true,
    });
    expect(run.halts).toEqual(["EVENT_BUS_UNAVAILABLE"]);
    // The safety property first (at `2d29b2d`: orders [2, 0]).
    const confirmed = await trade(run.published, "CONNECTION_CONFIRMED");
    const lastChange = await trade(run.published, "LAST_CHANGE");
    expect([confirmed.orders, lastChange.orders], "orders on a book whose change was in the lost tail").toEqual([0, 0]);
    expect([confirmed.approvals, lastChange.approvals]).toEqual([0, 0]);
    // Refused for the right reason: the YES book is judged by its own 3.1 s.
    expect(confirmed.staleBookPauses).toBeGreaterThan(0);
    expect(lastChange.staleBookPauses).toBeGreaterThan(0);

    const stream = late(run.published);
    // The split itself is unchanged: the frame's first 1 024 events are one
    // call, the YES snapshot the next, and that call was lost.
    expect(count(stream, "NO")).toBe(ONE_CALL);
    expect(count(stream, "YES")).toBe(0);
    // The incident is published FIRST, names no market, and is the frame's.
    const labels = stream.map(label);
    expect(labels[0]).toBe("INCIDENT:GATEWAY_FRAME_SPLIT");
    const incident = stream[0] as EventEnvelope<unknown>;
    const payload = incident.payload as { affectedMarketIds?: unknown; severity?: unknown };
    expect(payload.affectedMarketIds).toBeUndefined();
    expect(payload.severity).toBe("LOG");
    expect(incident.causationId).toBeUndefined();
    const firstNo = stream[1] as EventEnvelope<unknown>;
    expect(BigInt(incident.ingestSeq) < BigInt(firstNo.ingestSeq)).toBe(true);
    expect(incident.receivedAt).toBe(firstNo.receivedAt);
    expect(run.calls.map((call) => call.length)).toEqual([1, ONE_CALL, 1]);
    expect(run.calls[0]).toEqual(["INCIDENT:GATEWAY_FRAME_SPLIT"]);
  });

  it("the cost, stated: a frame over the limit taints the epoch even when it is delivered whole", async () => {
    // 1 025 NO snapshots and no YES change: at `2d29b2d` this frame vouched
    // for the quiet YES book under CONNECTION_CONFIRMED and admitted the
    // entry. The split marker now turns the extension off for the epoch
    // (fail-closed): the YES book is judged by its own last change.
    const run = await gatewayRun({
      maxQueueDepth: 4_096,
      lateMessages: [repeat(ONE_CALL + 1, noBook)],
      backlog: false,
      loseTheYesCall: false,
    });
    expect(run.halts).toEqual([]);
    const stream = late(run.published);
    expect(stream.map(label)[0]).toBe("INCIDENT:GATEWAY_FRAME_SPLIT");
    expect(count(stream, "NO")).toBe(ONE_CALL + 1);
    expect(run.calls.map((call) => call.length)).toEqual([1, ONE_CALL, 1]);
    const confirmed = await trade(run.published, "CONNECTION_CONFIRMED");
    expect([confirmed.orders, confirmed.approvals]).toEqual([0, 0]);
    expect(confirmed.staleBookPauses).toBeGreaterThan(0);
  });

  it("control: a frame of exactly the limit is one call, carries no incident, and still vouches under CONNECTION_CONFIRMED only", async () => {
    const run = await gatewayRun({
      maxQueueDepth: 4_096,
      lateMessages: [repeat(ONE_CALL, noBook)],
      backlog: false,
      loseTheYesCall: false,
    });
    const stream = late(run.published);
    expect(stream.filter((envelope) => envelope.eventType === "DataQualityIncidentOpened")).toHaveLength(0);
    expect(run.calls.map((call) => call.length)).toEqual([ONE_CALL]);
    const confirmed = await trade(run.published, "CONNECTION_CONFIRMED");
    const lastChange = await trade(run.published, "LAST_CHANGE");
    expect(confirmed.orders).toBeGreaterThan(0);
    expect(lastChange.orders).toBe(0);
  });

  it("control: at the default admission depth the frame over the limit is refused (GATEWAY_PUBLISH_ADMISSION_OVERFLOW) and nothing is admitted", async () => {
    const run = await gatewayRun({
      maxQueueDepth: 1_024,
      lateMessages: [[...repeat(ONE_CALL, noBook), yesAway()]],
      backlog: false,
      loseTheYesCall: true,
    });
    expect(run.halts).toEqual(["GATEWAY_PUBLISH_ADMISSION_OVERFLOW"]);
    expect(count(late(run.published), "NO")).toBe(0);
    const confirmed = await trade(run.published, "CONNECTION_CONFIRMED");
    const lastChange = await trade(run.published, "LAST_CHANGE");
    expect([confirmed.orders, lastChange.orders]).toEqual([0, 0]);
  });

  it("a frame under the limit queued behind a backlog is ONE call: with that call lost, none of it is published and no order is admitted", async () => {
    // A held call (one top-of-book event), then frame A (200 top-of-book
    // events) and frame B (899 NO snapshots and the YES change) queue behind
    // it. At `2d29b2d` the next run took A and the first 824 of B, so B's NO
    // snapshots vouched for the quiet YES book while its change was lost.
    const run = await gatewayRun({
      maxQueueDepth: 4_096,
      lateMessages: [[noTopOfBook()], repeat(200, noTopOfBook), [...repeat(899, noBook), yesAway()]],
      backlog: true,
      loseTheYesCall: true,
    });
    expect(run.halts).toEqual(["EVENT_BUS_UNAVAILABLE"]);
    // The safety property first (at `2d29b2d`: orders [2, 0]).
    const confirmed = await trade(run.published, "CONNECTION_CONFIRMED");
    const lastChange = await trade(run.published, "LAST_CHANGE");
    expect([confirmed.orders, lastChange.orders], "orders on a book whose change was in the lost frame").toEqual([0, 0]);
    expect([confirmed.approvals, lastChange.approvals]).toEqual([0, 0]);

    expect(run.calls.map((call) => call.length)).toEqual([1, 200, 900]);
    const stream = late(run.published);
    expect(count(stream, "TOB")).toBe(201);
    expect([count(stream, "NO"), count(stream, "YES")], "frame B is published whole or not at all").toEqual([0, 0]);
    expect(stream.filter((envelope) => envelope.eventType === "DataQualityIncidentOpened")).toHaveLength(0);
  });

  it("the same backlog with no outage: frame B is published whole, in one call", async () => {
    const run = await gatewayRun({
      maxQueueDepth: 4_096,
      lateMessages: [[noTopOfBook()], repeat(200, noTopOfBook), [...repeat(899, noBook), yesAway()]],
      backlog: true,
      loseTheYesCall: false,
    });
    expect(run.halts).toEqual([]);
    expect(run.calls.map((call) => call.length)).toEqual([1, 200, 900]);
    const third = run.calls[2] ?? [];
    expect([third.filter((name) => name === "NO").length, third.filter((name) => name === "YES").length]).toEqual([899, 1]);
    const stream = late(run.published);
    expect([count(stream, "NO"), count(stream, "YES")]).toEqual([899, 1]);
  });
});
