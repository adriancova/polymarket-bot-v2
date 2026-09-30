/**
 * `THROUGHPUT-1c` (ADR-023) — book freshness by delivery-session liveness,
 * pinned against the REAL composition (books, features, projection, strategy
 * runtime, Static Bracket, allocator, risk, planner, `SimulatedVenue`); only
 * the clock and the durable store are the trader's in-memory doubles.
 *
 * The four behaviours the task names, each of which FAILS on the base commit
 * (whose trader configuration door refuses `bookFreshness`, and whose Static
 * Bracket refuses grammar version 2):
 *
 * 1. a quiet book on a live delivery session stays FRESH;
 * 2. a silent session goes STALE within its bound;
 * 3. a disconnection mid-quiet is detected — a new connection, a new
 *    subscription generation or a gateway restart confirms nothing about a
 *    book delivered on the old session;
 * 4. replay is deterministic — the same recorded events produce the same
 *    decisions, byte for byte.
 *
 * Plus the fail-closed fallbacks of `book-freshness.ts` (a feed-scoped
 * incident taints, a market incident falls back, a session-less update is not
 * confirmed), §9.8 check 7's measurement, and backward compatibility: with no
 * `bookFreshness` block the loop is the pre-ADR-023 loop.
 *
 * PAPER only. No network, no credential, no signer, no real order.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
} from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import {
  DeliverySessionLiveness,
  MAXIMUM_TAINTED_EPOCHS,
  MAXIMUM_TRACKED_SESSIONS,
  bookConfirmedAt,
  sessionKeyOf,
} from "./book-freshness.js";
import { bookFreshnessBasisOf, parseTraderConfig } from "./config.js";
import { EVERY_FILL_ACCOUNTING_CHECKS } from "./folds.js";
import type { IngestedEvent } from "./ports.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";
import { createPaperTrader, type PaperTrader } from "./trader.js";
import { createExecutionPolicy, type VenueWiring } from "./venue-policy.js";

const MARKET_ID = "018f5c20-1000-7a10-8b00-0000000001c1";
const OTHER_MARKET_ID = "018f5c20-1000-7a10-8b00-0000000001c9";
const CONDITION_ID = "0xthroughput1c";
const YES_TOKEN = "9101";
const NO_TOKEN = "9102";
const OTHER_TOKEN = "9109";
const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-0000000001c2";
const RUN_ID = "018f5c20-3000-7a30-8b00-0000000001c3";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000001c4";
const EPOCH_A = "018f5c20-5000-7a50-8b00-0000000001c5";
const EPOCH_B = "018f5c20-5000-7a50-8b00-0000000001c6";
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-01T10:00:00.000Z";
const BOOK_AGE_KEY = "quality.input_feed_ages@polymarket.book";
const STALE = "SB.STALE_BOOK";

function paperEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    NODE_ENV: "test",
  };
}

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "tp1c.sim.2026-05-01",
    takerFeeRate: "0.0195",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

interface ConfigOptions {
  /** `undefined`: no `bookFreshness` block at all (the pre-ADR-023 document). */
  readonly basis?: "LAST_CHANGE" | "CONNECTION_CONFIRMED";
  /** Static Bracket grammar version; 2 adds `book_age_feature_key`. */
  readonly paramsVersion?: 1 | 2;
  readonly strategyMaxAgeMs?: number;
  readonly riskMaxAgeMs?: number;
  readonly triggerPriceLte?: string;
}

function traderConfig(options: ConfigOptions = {}): Record<string, unknown> {
  const fees = feeSnapshot();
  const paramsVersion = options.paramsVersion ?? 2;
  return {
    environment: "PAPER",
    riskPolicy: {
      freshness: {
        venueBookMaxAgeMs: options.riskMaxAgeMs ?? 600_000,
        referenceFeedMaxAgeMs: 600_000,
        featuresMaxAgeMs: 600_000,
      },
      limits: { maxWorstCaseContractualLoss: "1000" },
      scenario: { maxScenarioLoss: "1000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 0 },
      timeToClose: { entryCutoffSeconds: 30 },
    },
    allocatorCaps: {
      globalAccountCap: "10000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "0",
      liveMicroMaxAccountExposure: "0",
    },
    accounting: {
      accountRef: "tp1c-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "tp1c-venue-clearing",
      attributionClearingRef: "tp1c-attribution-clearing",
      feeExpenseRef: "tp1c-fee-expense",
      startingCash: "1000",
    },
    queues: { ingestMaximumDepth: 4096, outboxMaximumDepth: 4096 },
    features: {
      depthLevels: [1, 2, 5],
      executableShares: ["50"],
      tradeWindowMs: 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    planning: {
      maxSliceShares: "100",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.tp1c",
      fillModelParametersHash: "c".repeat(64),
      feeSchedule: { ...fees },
      startingCash: "1000",
    },
    requestBudget: { capacity: 100, windowMs: 60_000 },
    scenarios: [
      { scenarioId: "spot.down", kind: "SPOT", yesPriceShock: "-0.1" },
      { scenarioId: "vol.up", kind: "VOLATILITY", yesPriceShock: "-0.05" },
      { scenarioId: "time.decay", kind: "TIME", yesPriceShock: "-0.02" },
      { scenarioId: "liq.thin", kind: "LIQUIDITY", yesPriceShock: "-0.03" },
    ],
    ...(options.basis === undefined ? {} : { bookFreshness: { basis: options.basis } }),
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "throughput-1c-book-freshness",
      receiveBatchSize: 128,
      retentionMaxEvents: 100_000,
    },
    markets: [
      {
        marketId: MARKET_ID,
        conditionId: CONDITION_ID,
        yesTokenId: YES_TOKEN,
        noTokenId: NO_TOKEN,
        tickSize: "0.01",
        minimumOrderSize: "5",
        makerFeeRate: fees.makerFeeRate,
        takerFeeRate: fees.takerFeeRate,
        parametersVersion: 1,
        settlementReadiness: { modelDependentActivationAllowed: true },
        openTime: T_OPEN,
        closeTime: T_CLOSE,
        seriesKey: "tp1c-paper-sim",
        underlyingKey: "SIMBTC",
        resolutionWindowKey: "w2026-05-01T10.00",
      },
    ],
    instances: [
      {
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        configId: CONFIG_ID,
        runSeed: "101010",
        marketId: MARKET_ID,
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5_000_000,
        params: {
          strategy: "static-bracket",
          version: paramsVersion,
          market_selector: { series_id: "tp1c-paper-sim", direction: "YES" },
          entry: {
            trigger_basis: "executable_ask",
            trigger_feature_key: "polymarket.executable_buy_price@50",
            trigger_price_lte: options.triggerPriceLte ?? "0.35",
            size_shares: "50",
            maximum_total_cost: "18",
            economic_leg_policy: "DIRECT_ONLY",
            execution: {
              liquidity_preference: "TAKER_OK",
              passive_price: "0.34",
              convert_to_aggressive_after_ms: 0,
              maximum_buy_price: "0.35",
              immediate_order_type: "FAK",
              partial_fill_policy: "ACCEPT_ANY",
              minimum_fill_shares: "10",
              submission_unknown_after_ms: 5000,
              order_validity_ms: 30000,
            },
            economics: {
              entry_fee_per_share: "0.001",
              exit_fee_per_share: "0.001",
              minimum_expected_net_edge: "1",
            },
          },
          exit: {
            take_profit: { price: "0.5", liquidity_preference: "MAKER_ONLY", post_only: true },
            stop: {
              enabled: true,
              trigger_basis: "executable_bid",
              trigger_feature_key: "polymarket.executable_sell_price@50",
              trigger_price_lte: "0.27",
              minimum_sell_price: "0.26",
              urgency: "AGGRESSIVE",
            },
            maximum_holding_seconds: 180,
            entry_cutoff_before_close_seconds: 45,
            exit_cutoff_before_close_seconds: 20,
            final_policy: "PROTECTED_REDUCE",
            allow_resolution_hold: false,
          },
          reentry: { maximum_entries_per_market: 1, cooldown_seconds: 30 },
          risk: {
            maximum_position_shares: "50",
            maximum_contractual_loss: "18",
            maximum_slippage: "1",
            maximum_book_participation: "0.9",
          },
          data_quality: {
            maximum_book_age_ms: options.strategyMaxAgeMs ?? 2000,
            ...(paramsVersion === 2 ? { book_age_feature_key: BOOK_AGE_KEY } : {}),
            incident_feature_key: "quality.active_incidents@any",
            on_stale_book: "PAUSE_AND_CANCEL",
            on_incident: "PAUSE_AND_CANCEL",
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Recorded events
// ---------------------------------------------------------------------------

interface Session {
  readonly epoch: string;
  readonly connectionId: string;
  readonly generation: number;
}

const A1: Session = { epoch: EPOCH_A, connectionId: "polymarket-market-a1", generation: 1 };
const A2: Session = { epoch: EPOCH_A, connectionId: "polymarket-market-a2", generation: 2 };
const A1_GEN2: Session = { epoch: EPOCH_A, connectionId: "polymarket-market-a1", generation: 2 };
/** A gateway RESTART that reuses the connection id (H1 names them `…-a1`). */
const B1: Session = { epoch: EPOCH_B, connectionId: "polymarket-market-a1", generation: 1 };

interface Recorded {
  readonly eventType: string;
  readonly payload: unknown;
  /** Seconds after 09:00:00.000Z, to the millisecond. */
  readonly at: number;
  readonly source?: string;
  readonly session?: Session;
  /** Gateway epoch for a session-less event (a reference tick, an incident). */
  readonly epoch?: string;
  /**
   * A REST snapshot's stamp: the gap's generation and NO connection id (the
   * gateway's recovery path, `apps/data-gateway` `polymarket.ts`).
   */
  readonly restGeneration?: number;
}

function iso(at: number): string {
  return new Date(Date.parse(T_OPEN) + Math.round(at * 1000)).toISOString();
}

const YES_ASKS_HIGH = [
  { price: "0.4", size: "100" },
  { price: "0.41", size: "100" },
];

function yesSnapshot(at: number, session: Session | undefined, asks = YES_ASKS_HIGH): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      bids: [{ price: "0.32", size: "200" }],
      asks,
    },
    at,
    ...(session === undefined ? { epoch: EPOCH_A, restGeneration: 1 } : { session }),
  };
}

function noSnapshot(at: number, session: Session): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.58", size: "200" }],
      asks: [{ price: "0.6", size: "200" }],
    },
    at,
    session,
  };
}

/** A NO-book change: traffic on the session that leaves the YES book QUIET. */
function noChange(at: number, session: Session, size: string): Recorded {
  return {
    eventType: "BookLevelChanged",
    payload: { internalMarketId: MARKET_ID, tokenId: NO_TOKEN, side: "BID", price: "0.58", size },
    at,
    session,
  };
}

/** A frame for a market this trader does not trade, on the same socket. */
function otherMarketSnapshot(at: number, session: Session): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: OTHER_MARKET_ID,
      tokenId: OTHER_TOKEN,
      bids: [{ price: "0.1", size: "10" }],
      asks: [{ price: "0.9", size: "10" }],
    },
    at,
    session,
  };
}

/** A reference tick: it evaluates every market and confirms NO book. */
function tick(at: number, price = "64000"): Recorded {
  return {
    eventType: "ReferenceTradeObserved",
    payload: { venue: "binance", symbol: "BTCUSDT", price, size: "0.1" },
    at,
    source: "binance",
    epoch: EPOCH_A,
  };
}

function marketOpened(at: number): Recorded {
  return {
    eventType: "MarketOpened",
    payload: { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN },
    at,
  };
}

function incident(at: number, id: string, affectedMarketIds?: readonly string[]): Recorded {
  return {
    eventType: "DataQualityIncidentOpened",
    payload: {
      incidentId: id,
      openedAt: iso(at),
      reasonCode: "GATEWAY_WAL_FRAME_REFUSED",
      severity: "PAGE",
      feedId: "polymarket-market",
      ...(affectedMarketIds === undefined ? {} : { affectedMarketIds: [...affectedMarketIds] }),
    },
    at,
    source: "internal",
    epoch: EPOCH_A,
  };
}

/** A feed-health event the trader does NOT consume (counted and skipped). */
function disconnected(at: number, session: Session): Recorded {
  return {
    eventType: "FeedDisconnected",
    payload: {
      feedId: "polymarket-market",
      connectionId: session.connectionId,
      disconnectedAt: iso(at),
      reasonCode: "TRANSPORT_CLOSED",
    },
    at,
    session,
  };
}

function ingested(recorded: Recorded, ordinal: number): IngestedEvent {
  const receivedAt = iso(recorded.at);
  const epoch = recorded.session?.epoch ?? recorded.epoch ?? EPOCH_A;
  const envelope: EventEnvelope<unknown> = {
    eventId: `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`,
    eventType: recorded.eventType,
    schemaVersion: 1,
    source: (recorded.source ?? "polymarket") as EventEnvelope<unknown>["source"],
    sourceChannel: "polymarket:market-ws",
    receivedAt,
    receivedMonotonicNs: String(ordinal * 1_000_000),
    gatewayEpoch: epoch,
    ingestSeq: String(ordinal),
    ...(recorded.restGeneration === undefined ? {} : { subscriptionGeneration: recorded.restGeneration }),
    ...(recorded.session === undefined
      ? {}
      : {
          connectionId: recorded.session.connectionId,
          subscriptionGeneration: recorded.session.generation,
        }),
    payload: recorded.payload,
  };
  return {
    envelope,
    identity: { gatewayEpoch: epoch, ingestSeq: String(ordinal), receivedAt, datasetRowOrdinal: ordinal },
  };
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

interface Run {
  readonly trader: PaperTrader;
  readonly store: MemoryTraderStore;
}

function assemble(options: ConfigOptions): Run {
  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error(`fee snapshot refused: ${fees.refusal.code}`);
  const wiring: VenueWiring = { trader: undefined };
  const clock = new ManualClock(T_OPEN);
  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.tp1c", fillModelParametersHash: "c".repeat(64) }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits("no venue rate-limit budget is modelled in this unit test"),
    policy: createExecutionPolicy(wiring, () => undefined),
    startingCash: "1000",
    books: {
      book(input): BookView | undefined {
        const market = wiring.trader?.markets.get(input.marketId);
        if (market === undefined) return undefined;
        return {
          internalMarketId: input.marketId,
          tokenId: input.side === "YES" ? market.config.yesTokenId : market.config.noTokenId,
          top() {
            const top = market.bookFor(input.side).topOfBook();
            return {
              ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
              ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
              ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
              ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
              ...(top.spread === undefined ? {} : { spread: top.spread }),
            };
          },
          ladder(side) {
            return market
              .bookFor(input.side)
              .levels(side)
              .map((level) => ({ price: level.price, size: level.size }));
          },
        };
      },
    },
  });
  const store = new MemoryTraderStore();
  const result = createPaperTrader({
    env: paperEnvironment(),
    config: traderConfig(options),
    clock,
    venue,
    store,
    idNamespace: "throughput-1c-book-freshness",
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
  });
  if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.detail} ${result.refusal.issues.join("; ")}`);
  wiring.trader = result.trader;
  return { trader: result.trader, store };
}

async function run(options: ConfigOptions, events: readonly Recorded[]): Promise<Run> {
  const parts = assemble(options);
  let ordinal = 0;
  for (const recorded of events) {
    ordinal += 1;
    if (!parts.trader.loop.ingest(ingested(recorded, ordinal))) {
      throw new Error(`the ingest queue refused event ${String(ordinal)}`);
    }
    await parts.trader.loop.drain();
  }
  return parts;
}

interface Evaluation {
  readonly at: string;
  readonly stale: boolean;
  readonly bookAgeMs: string | undefined;
}

function evaluations(parts: Run): readonly Evaluation[] {
  return parts.store.decisions.map((recorded) => {
    const outputs = recorded.record.decision.modelOutputs;
    const age = outputs === undefined ? undefined : outputs["bookAgeMs"];
    return {
      at: recorded.record.evaluatedAt,
      stale: recorded.record.decision.reasonCodes.includes(STALE),
      bookAgeMs: typeof age === "string" ? age : undefined,
    };
  });
}

function evaluationAt(parts: Run, at: number): Evaluation {
  // `evaluatedAt` is strict UTC, which drops a zero millisecond part.
  const found = evaluations(parts).filter((evaluation) => Date.parse(evaluation.at) === Date.parse(iso(at)));
  expect(found, `exactly one evaluation at ${iso(at)}`).toHaveLength(1);
  return found[0] as Evaluation;
}

/**
 * The quiet-YES timeline: YES snapshot at 1.000 s; the NO book changes every
 * 500 ms from 1.500 s to 6.000 s on the SAME session, so the YES book is quiet
 * while the socket is busy. A reference tick evaluates at 6.200 s.
 */
function quietYesTimeline(session: Session = A1): Recorded[] {
  const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, session), noSnapshot(1.1, session)];
  for (let step = 0; step < 10; step += 1) {
    events.push(noChange(1.5 + step * 0.5, session, String(200 + step)));
  }
  events.push(tick(6.2));
  return events;
}

// ---------------------------------------------------------------------------
// 1. A quiet but live book stays fresh
// ---------------------------------------------------------------------------

describe("1. a quiet book on a live delivery session stays fresh", () => {
  it("CONNECTION_CONFIRMED: no evaluation of the quiet YES book is stale", async () => {
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, quietYesTimeline());
    const all = evaluations(parts);
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((evaluation) => evaluation.stale)).toEqual([]);
    expect(evaluationAt(parts, 6.2).stale).toBe(false);
  });

  it("LAST_CHANGE (the pre-ADR-023 rule): the same timeline pauses once the last change is 2 s old", async () => {
    const parts = await run({ basis: "LAST_CHANGE" }, quietYesTimeline());
    expect(evaluationAt(parts, 3).stale).toBe(false);
    expect(evaluationAt(parts, 3.5).stale).toBe(true);
    const last = evaluationAt(parts, 6.2);
    expect(last.stale).toBe(true);
    expect(last.bookAgeMs).toBe("5200");
  });

  it("confirmations come from any market-channel frame on the session, a market this trader does not run included", async () => {
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1), noSnapshot(1.1, A1)];
    for (let step = 0; step < 10; step += 1) events.push(otherMarketSnapshot(1.5 + step * 0.5, A1));
    events.push(tick(6.2));
    const confirmed = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(evaluationAt(confirmed, 6.2).stale).toBe(false);
    const lastChange = await run({ basis: "LAST_CHANGE" }, events);
    expect(evaluationAt(lastChange, 6.2).stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. A silent feed goes stale within its bound
// ---------------------------------------------------------------------------

describe("2. a silent session goes stale within its bound", () => {
  it("after the last frame at 6.000 s: fresh at 7.900 s (1 900 ms), stale at 8.100 s (2 100 ms)", async () => {
    const events = [...quietYesTimeline(), tick(7.9, "64001"), tick(8.0, "64002"), tick(8.1, "64003")];
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(evaluationAt(parts, 7.9).stale).toBe(false);
    expect(evaluationAt(parts, 8).stale).toBe(false);
    const stale = evaluationAt(parts, 8.1);
    expect(stale.stale).toBe(true);
    expect(stale.bookAgeMs).toBe("2100");
  });

  it("reference ticks are not confirmations: they do not keep a silent session fresh", async () => {
    const events = [...quietYesTimeline()];
    for (let step = 1; step <= 30; step += 1) events.push(tick(6.2 + step * 0.1, String(64000 + step)));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(evaluationAt(parts, 8).stale).toBe(false);
    expect(evaluationAt(parts, 8.1).stale).toBe(true);
    expect(evaluationAt(parts, 9.2).stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. A disconnection mid-quiet is detected
// ---------------------------------------------------------------------------

describe("3. a disconnection mid-quiet is detected", () => {
  /**
   * The quiet timeline on A1, then the socket drops at 6.100 s and a NEW
   * session carries traffic from 6.300 s. The YES book was delivered on A1 and
   * nothing re-delivers it, so the new session's frames confirm nothing about
   * it: it ages from A1's last frame (6.000 s).
   */
  function reconnected(next: Session): Recorded[] {
    const events: Recorded[] = [...quietYesTimeline(), disconnected(6.1, A1), noSnapshot(6.3, next)];
    for (let step = 1; step <= 5; step += 1) events.push(noChange(6.3 + step * 0.4, next, String(300 + step)));
    events.push(tick(7.95, "64010"), tick(8.05, "64011"));
    return events;
  }

  for (const [name, next] of [
    ["a new connection", A2],
    ["a new subscription generation on the same connection", A1_GEN2],
    ["a gateway restart that reuses the connection id", B1],
  ] as const) {
    it(`${name}: stale 2 s after the old session's last frame, although the new one is busy`, async () => {
      const parts = await run({ basis: "CONNECTION_CONFIRMED" }, reconnected(next));
      expect(evaluationAt(parts, 7.95).stale).toBe(false);
      const stale = evaluationAt(parts, 8.05);
      expect(stale.stale).toBe(true);
      expect(stale.bookAgeMs).toBe("2050");
    });
  }

  it("a YES book re-delivered on the new session is confirmed by that session", async () => {
    const events: Recorded[] = [...quietYesTimeline(), disconnected(6.1, A1), yesSnapshot(6.3, A2), noSnapshot(6.35, A2)];
    for (let step = 1; step <= 10; step += 1) events.push(noChange(6.35 + step * 0.5, A2, String(400 + step)));
    events.push(tick(11.5, "64020"));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(evaluationAt(parts, 11.5).stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The fail-closed fallbacks
// ---------------------------------------------------------------------------

describe("the fallbacks to the last change (fail closed)", () => {
  it("a data-quality incident naming NO market taints the gateway epoch: the quiet book is stale at once", async () => {
    const events = [...quietYesTimeline()];
    // Before 6.200 s's tick: the incident arrives, then one more frame on A1.
    events.splice(events.length - 1, 0, incident(6.05, "gw-polymarket-market-1"), noChange(6.1, A1, "999"));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(evaluationAt(parts, 6).stale).toBe(false);
    const after = evaluationAt(parts, 6.2);
    expect(after.stale).toBe(true);
    // The age is the LAST CHANGE's (1.000 s), not A1's latest frame (6.100 s).
    expect(after.bookAgeMs).toBe("5200");
  });

  /**
   * The gateway deduplicates an open incident and never closes a WAL-refusal
   * or normalization incident, so a repeat on a LATER session publishes
   * nothing: the taint must reach sessions first seen after it (ADR-023 D2.4).
   */
  it("the taint reaches every later session of the same gateway epoch", async () => {
    const events: Recorded[] = [...quietYesTimeline(), incident(6.05, "gw-polymarket-market-1"), yesSnapshot(6.3, A2), noSnapshot(6.35, A2)];
    for (let step = 1; step <= 10; step += 1) events.push(noChange(6.35 + step * 0.5, A2, String(500 + step)));
    events.push(tick(11.5, "64030"));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    const after = evaluationAt(parts, 11.5);
    expect(after.stale).toBe(true);
    // The age is the re-delivered YES book's own last change (6.300 s).
    expect(after.bookAgeMs).toBe("5200");
  });

  it("a NEW gateway epoch (a restart) starts clean", async () => {
    const events: Recorded[] = [...quietYesTimeline(), incident(6.05, "gw-polymarket-market-1"), yesSnapshot(6.3, B1), noSnapshot(6.35, B1)];
    for (let step = 1; step <= 10; step += 1) events.push(noChange(6.35 + step * 0.5, B1, String(500 + step)));
    events.push(tick(11.5, "64030"));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(evaluationAt(parts, 11.5).stale).toBe(false);
  });

  it("an active incident on THIS market falls back to the last change", async () => {
    const events = [...quietYesTimeline()];
    events.splice(events.length - 1, 0, incident(6.05, "gw-lifecycle-1", [MARKET_ID]));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    const after = evaluationAt(parts, 6.2);
    expect(after.stale).toBe(true);
    expect(after.bookAgeMs).toBe("5200");
  });

  it("an incident naming ANOTHER market neither taints the session nor touches this market", async () => {
    const events = [...quietYesTimeline()];
    events.splice(events.length - 1, 0, incident(6.05, "gw-lifecycle-9", [OTHER_MARKET_ID]));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(evaluationAt(parts, 6.2).stale).toBe(false);
  });

  it("a book whose update carried no session (a REST snapshot) is confirmed by nothing but itself", async () => {
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, undefined),
      noSnapshot(1.1, A1),
      ...Array.from({ length: 10 }, (_, step) => noChange(1.5 + step * 0.5, A1, String(600 + step))),
      tick(6.2),
    ]);
    const after = evaluationAt(parts, 6.2);
    expect(after.stale).toBe(true);
    expect(after.bookAgeMs).toBe("5200");
  });
});

// ---------------------------------------------------------------------------
// §9.8 check 7 — the risk engine's VENUE_BOOK measurement
// ---------------------------------------------------------------------------

describe("§9.8 check 7 measures the same confirmed age (risk freshness)", () => {
  /**
   * The strategy's own bound is set out of the way (600 000 ms, version 1) so
   * the ONLY freshness gate is risk's `venueBookMaxAgeMs` (2 000 ms). The YES
   * asks satisfy the entry trigger, and Static Bracket enters as soon as BOTH
   * books exist — which is 4.100 s, when the NO snapshot arrives on the same
   * session. Between 1.000 s and 4.100 s the socket carries only another
   * market's frames, so at the entry the YES book's last change is 3.1 s old
   * and its session's latest frame is the NO snapshot itself.
   */
  function timeline(): Recorded[] {
    const cheapAsks = [
      { price: "0.34", size: "100" },
      { price: "0.35", size: "100" },
    ];
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1, cheapAsks)];
    for (let step = 0; step < 6; step += 1) events.push(otherMarketSnapshot(1.5 + step * 0.5, A1));
    events.push(noSnapshot(4.1, A1));
    return events;
  }

  function bookStaleRefusals(parts: Run): number {
    return parts.trader.loop.health().risk.refusalsByCode["RISK_BOOK_STALE"] ?? 0;
  }

  it("CONNECTION_CONFIRMED: the entry at 4.100 s passes check 7 and is booked", async () => {
    const parts = await run(
      { basis: "CONNECTION_CONFIRMED", paramsVersion: 1, strategyMaxAgeMs: 600_000, riskMaxAgeMs: 2_000 },
      timeline(),
    );
    expect(parts.trader.loop.orderProvenance().length).toBeGreaterThan(0);
    expect(bookStaleRefusals(parts)).toBe(0);
  });

  it("LAST_CHANGE: the same entry is refused as a stale venue book (3 100 ms > 2 000 ms)", async () => {
    const parts = await run(
      { basis: "LAST_CHANGE", paramsVersion: 1, strategyMaxAgeMs: 600_000, riskMaxAgeMs: 2_000 },
      timeline(),
    );
    expect(parts.trader.loop.orderProvenance()).toHaveLength(0);
    expect(bookStaleRefusals(parts)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Replay determinism, and backward compatibility
// ---------------------------------------------------------------------------

describe("4. replay is deterministic", () => {
  it("the same recorded events produce byte-identical decisions, twice", async () => {
    const events = [
      ...quietYesTimeline(),
      disconnected(6.1, A1),
      noSnapshot(6.3, A2),
      incident(6.4, "gw-polymarket-market-7"),
      ...Array.from({ length: 6 }, (_, step) => noChange(6.5 + step * 0.4, A2, String(800 + step))),
      tick(8.2, "64100"),
      tick(9.0, "64101"),
    ];
    const first = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    const second = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    const records = (parts: Run) => JSON.stringify(parts.store.decisions.map((recorded) => recorded.record));
    expect(records(first)).toBe(records(second));
    expect(first.store.decisions.length).toBeGreaterThan(10);
  });
});

describe("backward compatibility: a document with no bookFreshness block", () => {
  it("parses, and selects LAST_CHANGE", () => {
    const parsed = parseTraderConfig(traderConfig({ paramsVersion: 1 }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.hasOwn(parsed.config, "bookFreshness")).toBe(false);
    expect(bookFreshnessBasisOf(parsed.config)).toBe("LAST_CHANGE");
  });

  it("decides exactly as an explicit LAST_CHANGE document does, byte for byte", async () => {
    const events = [...quietYesTimeline(), tick(8.1, "64003")];
    const absent = await run({ paramsVersion: 1 }, events);
    const explicit = await run({ basis: "LAST_CHANGE", paramsVersion: 1 }, events);
    const records = (parts: Run) => JSON.stringify(parts.store.decisions.map((recorded) => recorded.record));
    expect(records(absent)).toBe(records(explicit));
    expect(evaluations(absent).some((evaluation) => evaluation.stale)).toBe(true);
  });

  it("refuses an unknown basis and an unknown key in the block", () => {
    const withBlock = (block: unknown) => ({ ...traderConfig({ paramsVersion: 1 }), bookFreshness: block });
    expect(parseTraderConfig(withBlock({ basis: "HEARTBEAT" })).ok).toBe(false);
    expect(parseTraderConfig(withBlock({ basis: "CONNECTION_CONFIRMED", maxAgeMs: 5 })).ok).toBe(false);
    expect(parseTraderConfig(withBlock({})).ok).toBe(false);
  });

  it("does not adopt an inherited bookFreshness (D1: own data only)", () => {
    const polluted = Object.create({ bookFreshness: { basis: "CONNECTION_CONFIRMED" } }) as Record<string, unknown>;
    Object.assign(polluted, traderConfig({ paramsVersion: 1 }));
    const parsed = parseTraderConfig(polluted);
    if (parsed.ok) expect(bookFreshnessBasisOf(parsed.config)).toBe("LAST_CHANGE");
  });
});

// ---------------------------------------------------------------------------
// The module itself
// ---------------------------------------------------------------------------

describe("book-freshness.ts", () => {
  const at = (ms: number) => ({ iso: new Date(ms).toISOString(), epochMs: ms });
  const bookEvent = (session: Session, eventType = "BookLevelChanged", source = "polymarket") => ({
    eventType,
    source,
    gatewayEpoch: session.epoch,
    connectionId: session.connectionId,
    subscriptionGeneration: session.generation,
  });

  it("session keys separate epoch, connection and generation, and need both session fields", () => {
    const keys = new Set([A1, A2, A1_GEN2, B1].map((session) => sessionKeyOf(bookEvent(session))));
    expect(keys.size).toBe(4);
    expect(sessionKeyOf({ eventType: "BookSnapshot", gatewayEpoch: EPOCH_A })).toBeUndefined();
    expect(sessionKeyOf({ eventType: "BookSnapshot", gatewayEpoch: EPOCH_A, connectionId: "c" })).toBeUndefined();
  });

  it("only the consumed market-channel data events from polymarket confirm", () => {
    const liveness = new DeliverySessionLiveness();
    const key = sessionKeyOf(bookEvent(A1)) as string;
    for (const eventType of ["FeedConnected", "FeedStale", "BestBidAskChanged", "ReferenceTradeObserved", "DataQualityIncidentOpened"]) {
      liveness.observe(bookEvent(A1, eventType), at(1_000));
    }
    liveness.observe(bookEvent(A1, "BookLevelChanged", "binance"), at(1_000));
    expect(liveness.confirmation(key)).toBeUndefined();
    for (const eventType of ["BookSnapshot", "BookLevelChanged", "PublicTradeObserved"]) {
      liveness.observe(bookEvent(A1, eventType), at(2_000));
      expect(liveness.confirmation(key)?.epochMs).toBe(2_000);
    }
  });

  it("never answers earlier than the book's own last change, and LAST_CHANGE ignores confirmations", () => {
    const liveness = new DeliverySessionLiveness();
    const key = sessionKeyOf(bookEvent(A1)) as string;
    liveness.observe(bookEvent(A1), at(5_000));
    const common = { sessionKey: key, marketHasActiveIncident: false, liveness };
    expect(bookConfirmedAt({ ...common, basis: "CONNECTION_CONFIRMED", lastChange: at(1_000) })?.epochMs).toBe(5_000);
    // A confirmation stamped before the change (a clock step) cannot move it back.
    expect(bookConfirmedAt({ ...common, basis: "CONNECTION_CONFIRMED", lastChange: at(9_000) })?.epochMs).toBe(9_000);
    expect(bookConfirmedAt({ ...common, basis: "LAST_CHANGE", lastChange: at(1_000) })?.epochMs).toBe(1_000);
    expect(bookConfirmedAt({ ...common, basis: "CONNECTION_CONFIRMED", lastChange: undefined })).toBeUndefined();
    expect(
      bookConfirmedAt({ ...common, basis: "CONNECTION_CONFIRMED", lastChange: at(1_000), marketHasActiveIncident: true })
        ?.epochMs,
    ).toBe(1_000);
    expect(
      bookConfirmedAt({ ...common, basis: "CONNECTION_CONFIRMED", lastChange: at(1_000), sessionKey: undefined })?.epochMs,
    ).toBe(1_000);
  });

  it("an epoch taint covers sessions seen before and after it, and no other epoch", () => {
    const liveness = new DeliverySessionLiveness();
    liveness.observe(bookEvent(A1), at(1_000));
    liveness.taintGatewayEpoch(EPOCH_A);
    liveness.observe(bookEvent(A2), at(2_000));
    liveness.observe(bookEvent(B1), at(3_000));
    expect(liveness.confirmation(sessionKeyOf(bookEvent(A1)) as string)).toBeUndefined();
    expect(liveness.confirmation(sessionKeyOf(bookEvent(A2)) as string)).toBeUndefined();
    expect(liveness.confirmation(sessionKeyOf(bookEvent(B1)) as string)?.epochMs).toBe(3_000);
  });

  it("past the tainted-epoch bound, every epoch is tainted (forgetting a taint would loosen)", () => {
    const liveness = new DeliverySessionLiveness();
    for (let index = 0; index < MAXIMUM_TAINTED_EPOCHS; index += 1) {
      liveness.taintGatewayEpoch(`018f5c20-5000-7a50-8b00-${String(index).padStart(12, "0")}`);
    }
    liveness.observe(bookEvent(B1), at(3_000));
    expect(liveness.confirmation(sessionKeyOf(bookEvent(B1)) as string)?.epochMs).toBe(3_000);
    liveness.taintGatewayEpoch("018f5c20-5000-7a50-8b00-ffffffffffff");
    expect(liveness.isEpochTainted(EPOCH_B)).toBe(true);
    expect(liveness.confirmation(sessionKeyOf(bookEvent(B1)) as string)).toBeUndefined();
  });

  it("the table is bounded; a forgotten session confirms nothing (stricter, never looser)", () => {
    const liveness = new DeliverySessionLiveness();
    const first = { epoch: EPOCH_A, connectionId: "c-0", generation: 0 };
    liveness.observe(bookEvent(first), at(1_000));
    for (let index = 1; index <= MAXIMUM_TRACKED_SESSIONS; index += 1) {
      liveness.observe(bookEvent({ epoch: EPOCH_A, connectionId: `c-${String(index)}`, generation: 0 }), at(1_000));
    }
    expect(liveness.size).toBe(MAXIMUM_TRACKED_SESSIONS);
    expect(liveness.confirmation(sessionKeyOf(bookEvent(first)) as string)).toBeUndefined();
  });
});
