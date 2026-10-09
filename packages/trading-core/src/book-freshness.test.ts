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
import { beforeAll, describe, expect, it } from "vitest";

import {
  DeliverySessionLiveness,
  FrameCompletionGate,
  MAXIMUM_TAINTED_EPOCHS,
  MAXIMUM_TRACKED_SESSIONS,
  MAXIMUM_UNPROVEN_FRAMES,
  bookConfirmedAt,
  sessionKeyOf,
} from "./book-freshness.js";
import { PAPER_EVALUATION_CADENCE, PER_FRAME_EVALUATION_CADENCE, type EvaluationCadenceOption } from "./cadence.js";
import { bookFreshnessBasisOf, bookFreshnessCeilingMsOf, marketChannelFeedIdOf, parseTraderConfig } from "./config.js";
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
/** `C1-HALTS`: a second TRADED market (unlike {@link OTHER_MARKET_ID}, which no instance runs). */
const MARKET_2 = "018f5c20-1000-7a10-8b00-0000000002c1";
const YES_TOKEN_2 = "9201";
const NO_TOKEN_2 = "9202";
const INSTANCE_2 = "e18f5c20-2000-7a20-8b00-0000000002c2";
const RUN_2 = "018f5c20-3000-7a30-8b00-0000000002c3";
const CONFIG_2 = "018f5c20-4000-7a40-8b00-0000000002c4";
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-01T10:00:00.000Z";
const BOOK_AGE_KEY = "quality.input_feed_ages@polymarket.book";
const STALE = "SB.STALE_BOOK";

/**
 * `TC-LOWS-1` (O07): every test of this file that runs the loop runs at BOTH
 * evaluation cadences — ADR-024's per-frame value 0, as a declared
 * reproduction (ADR-026 D1.6), under the test names it always had, and the
 * production cadence every new run uses (ADR-026 D1.5: 1,000 ms / 5,000 ms),
 * under the same names with {@link PRODUCTION_SUFFIX}.
 *
 * The subject is the freshness VERDICT at an evaluation, and the timelines
 * read it at instants 100-500 ms apart. At the production cadence a market is
 * evaluated at most once per 1,000 ms of event time (ADR-026 D2.4): an event
 * sooner than that after its last evaluation is coalesced (D5), and an owed
 * evaluation is carried to the first close the rule allows (D2.6-D2.7). So
 * where a test reads a verdict at an instant the production cadence does not
 * evaluate, its production branch says so, reads the verdict at the
 * evaluations the cadence does run, and — where the subject needs the reading
 * at a particular age — moves the probe to an instant the cadence evaluates,
 * saying how. The verdict rule itself (ADR-023) is the same at both.
 */
interface CadenceCase {
  readonly production: boolean;
  readonly option: EvaluationCadenceOption;
}
const REPRODUCTION: CadenceCase = {
  production: false,
  option: { ...PER_FRAME_EVALUATION_CADENCE, reproduces: "adr-024:packages/trading-core/src/book-freshness.test.ts" },
};
const PRODUCTION: CadenceCase = { production: true, option: PAPER_EVALUATION_CADENCE };
const PRODUCTION_SUFFIX = " [at the production cadence, ADR-026 D1.5: 1,000 ms / 5,000 ms]";
/** The cadence the tests now running use: set by {@link describeAtEachCadence}. */
let cadence: CadenceCase = REPRODUCTION;

/** `describe`, twice: at the reproduction cadence (the name as it was), then at the production one. */
function describeAtEachCadence(name: string, body: () => void): void {
  for (const each of [REPRODUCTION, PRODUCTION]) {
    describe(each.production ? `${name}${PRODUCTION_SUFFIX}` : name, () => {
      beforeAll(() => {
        cadence = each;
      });
      body();
    });
  }
}

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
  /**
   * `CONNECTION_CONFIRMED`'s REQUIRED per-book ceiling on the last-change age
   * (ADR-023 D2 rule 6; r1 finding X1). Defaults to 30 000 ms, well past every
   * timeline below except the ones that test the ceiling itself.
   */
  readonly ceilingMs?: number;
  /** Static Bracket grammar version; 2 adds `book_age_feature_key`. */
  readonly paramsVersion?: 1 | 2;
  readonly strategyMaxAgeMs?: number;
  readonly riskMaxAgeMs?: number;
  readonly triggerPriceLte?: string;
  /**
   * r2 X9: the process clock (the `Clock` port the loop reads for the
   * process-lag guard). `processClockAt` pins it at one instant (default
   * `T_OPEN`, before every event: no lag); `processLagMs` repositions it at
   * each event's `receivedAt` plus that lag, a live process running behind.
   */
  readonly processClockAt?: string;
  readonly processLagMs?: number;
  /** `C1-HALTS`: the CONNECTION_CONFIRMED arm's optional market-channel feed id (absent: the default). */
  readonly marketChannelFeedId?: string;
  /** `C1-HALTS`: a SECOND traded market ({@link MARKET_2}) with its own OWNER instance. */
  readonly secondMarket?: boolean;
}

function traderConfig(options: ConfigOptions = {}): Record<string, unknown> {
  const base = singleMarketConfig(options);
  if (options.secondMarket !== true) return base;
  const [market] = base["markets"] as Record<string, unknown>[];
  const [instance] = base["instances"] as Record<string, unknown>[];
  return {
    ...base,
    markets: [
      market,
      { ...market, marketId: MARKET_2, conditionId: `${CONDITION_ID}-2`, yesTokenId: YES_TOKEN_2, noTokenId: NO_TOKEN_2, resolutionWindowKey: "w2026-05-01T10.00-2" },
    ],
    instances: [
      instance,
      { ...instance, instanceId: INSTANCE_2, runId: RUN_2, configId: CONFIG_2, marketId: MARKET_2, evaluationPriority: 1 },
    ],
  };
}

function singleMarketConfig(options: ConfigOptions = {}): Record<string, unknown> {
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
    ...(options.basis === undefined
      ? {}
      : {
          bookFreshness:
            options.basis === "CONNECTION_CONFIRMED"
              ? {
                  basis: options.basis,
                  maximumLastChangeAgeMs: options.ceilingMs ?? 30_000,
                  ...(options.marketChannelFeedId === undefined ? {} : { marketChannelFeedId: options.marketChannelFeedId }),
                }
              : { basis: options.basis },
        }),
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "throughput-1c-book-freshness",
      receiveBatchSize: 128,
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
  /**
   * r8: the raw frame this event was derived from. Events that name the same
   * frame share the gateway's `causationId` (`raw:<epoch>:<frame>`), so the
   * loop groups them into one venue frame (`frames.ts`). Absent: a frame of
   * its own, as before.
   */
  readonly frame?: string;
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
    ...(recorded.frame === undefined ? {} : { causationId: `raw:${epoch}:${recorded.frame}` }),
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
  readonly clock: ManualClock;
}

function assemble(options: ConfigOptions): Run {
  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error(`fee snapshot refused: ${fees.refusal.code}`);
  const wiring: VenueWiring = { trader: undefined };
  const clock = new ManualClock(options.processClockAt ?? T_OPEN);
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
    // `CADENCE-1` (ADR-026 D1.6; r1, O07): this harness's subject is book freshness —
    // the ADR-023 D5 freshness verdict, not the cadence — but its timelines were
    // written for ADR-024's per-frame cadence: the verdict at each evaluation of
    // events 100-500 ms apart. `TC-LOWS-1` (O07): every loop test now runs at both
    // cadences ({@link describeAtEachCadence}); where an assertion differs at the
    // production cadence, the test says where and why.
    evaluationCadence: cadence.option,
  });
  if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.detail} ${result.refusal.issues.join("; ")}`);
  wiring.trader = result.trader;
  return { trader: result.trader, store, clock };
}

async function run(options: ConfigOptions, events: readonly Recorded[]): Promise<Run> {
  const parts = assemble(options);
  let ordinal = 0;
  for (const recorded of events) {
    ordinal += 1;
    if (options.processLagMs !== undefined) {
      parts.clock.positionAt(iso(recorded.at + options.processLagMs / 1000), BigInt(ordinal) * 1_000_000n);
    }
    if (!parts.trader.loop.ingest(ingested(recorded, ordinal))) {
      throw new Error(`the ingest queue refused event ${String(ordinal)}`);
    }
    await parts.trader.loop.drain();
  }
  return parts;
}

/**
 * r8 (R8-H1): the same events, drained in the given BATCHES (each a count of
 * events handed to one drain, as a feed hands them out). A batch may end in
 * the middle of a frame, exactly as `RedisMarketEventFeed` hands out a frame
 * longer than its `maxEvents`. The counts must cover every event.
 */
async function runInBatches(options: ConfigOptions, events: readonly Recorded[], batches: readonly number[]): Promise<Run> {
  expect(batches.reduce((sum, size) => sum + size, 0), "the batches cover every event").toBe(events.length);
  const parts = assemble(options);
  let ordinal = 0;
  for (const size of batches) {
    for (let index = 0; index < size; index += 1) {
      const recorded = events[ordinal] as Recorded;
      ordinal += 1;
      if (!parts.trader.loop.ingest(ingested(recorded, ordinal))) {
        throw new Error(`the ingest queue refused event ${String(ordinal)}`);
      }
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
 * `TC-LOWS-1` (O07): the instants, in seconds after the open, at which the
 * run evaluated the market — the production cadence's evaluations.
 */
function evaluatedSeconds(parts: Run): readonly number[] {
  return evaluations(parts).map((evaluation) => (Date.parse(evaluation.at) - Date.parse(T_OPEN)) / 1000);
}

/**
 * `TC-LOWS-1` r1 (`TCL1-R1-04`): the instants, in seconds after the open, of
 * the ENTRIES — the `onFeatures` evaluations whose decisions placed an order
 * (each placed order's provenance names its decision; an `onFill` exit's is
 * left out).
 */
function entryEvaluatedSeconds(parts: Run): readonly number[] {
  const placing = new Set(parts.trader.loop.orderProvenance().map((link) => link.evaluationSeq));
  return parts.store.decisions
    .filter((recorded) => placing.has(recorded.record.evaluationSeq) && recorded.record.callback === "onFeatures")
    .map((recorded) => (Date.parse(recorded.record.evaluatedAt) - Date.parse(T_OPEN)) / 1000);
}

/**
 * `TC-LOWS-1` (O07): the quiet-YES timeline's evaluations at the production
 * cadence. The NO changes every 500 ms owe the market an evaluation, and it
 * is evaluated at most once per 1,000 ms (ADR-026 D2.4): at 1.000 s, then at
 * the change at each whole second; the change between, and the tick at
 * 6.200 s (200 ms after 6.000 s), are coalesced (D5).
 */
const QUIET_AT_PRODUCTION = [1, 2, 3, 4, 5, 6] as const;

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

describeAtEachCadence("1. a quiet book on a live delivery session stays fresh", () => {
  it("CONNECTION_CONFIRMED: no evaluation of the quiet YES book is stale", async () => {
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, quietYesTimeline());
    const all = evaluations(parts);
    if (cadence.production) {
      // `TC-LOWS-1` (O07): six evaluations, not more than ten, and none at the
      // 6.200 s tick (coalesced; see QUIET_AT_PRODUCTION). Every one is fresh —
      // the last 5 000 ms after the YES book's last change.
      expect(evaluatedSeconds(parts)).toEqual(QUIET_AT_PRODUCTION);
      expect(all.filter((evaluation) => evaluation.stale)).toEqual([]);
      return;
    }
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((evaluation) => evaluation.stale)).toEqual([]);
    expect(evaluationAt(parts, 6.2).stale).toBe(false);
  });

  it("LAST_CHANGE (the pre-ADR-023 rule): the same timeline pauses once the last change is 2 s old", async () => {
    const parts = await run({ basis: "LAST_CHANGE" }, quietYesTimeline());
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the same rule at the production cadence's
      // evaluations (QUIET_AT_PRODUCTION): fresh at 3.000 s (2 000 ms, the
      // bound itself), stale from the next one, 4.000 s (3 000 ms).
      expect(evaluatedSeconds(parts)).toEqual(QUIET_AT_PRODUCTION);
      expect(evaluationAt(parts, 3).stale).toBe(false);
      expect(evaluationAt(parts, 4)).toMatchObject({ stale: true, bookAgeMs: "3000" });
      expect(evaluationAt(parts, 6)).toMatchObject({ stale: true, bookAgeMs: "5000" });
      return;
    }
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

describeAtEachCadence("2. a silent session goes stale within its bound", () => {
  it("after the last frame at 6.000 s: fresh at 7.900 s (1 900 ms), stale at 8.100 s (2 100 ms)", async () => {
    const events = [...quietYesTimeline(), tick(7.9, "64001"), tick(8.0, "64002"), tick(8.1, "64003")];
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the 7.900 s tick is evaluated (1 900 ms after the
      // 6.000 s evaluation) and fresh; the ticks at 8.000 s and 8.100 s come
      // 100 and 200 ms after it and are coalesced (ADR-026 D2.4). So the
      // stale reading is taken in a run whose only later tick is 8.100 s,
      // which the cadence evaluates (2 100 ms after 6.000 s).
      expect(evaluatedSeconds(parts)).toEqual([...QUIET_AT_PRODUCTION, 7.9]);
      expect(evaluationAt(parts, 7.9).stale).toBe(false);
      const later = await run({ basis: "CONNECTION_CONFIRMED" }, [...quietYesTimeline(), tick(8.1, "64003")]);
      expect(evaluationAt(later, 8.1)).toMatchObject({ stale: true, bookAgeMs: "2100" });
      return;
    }
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
    if (cadence.production) {
      // `TC-LOWS-1` (O07): ticks every 100 ms evaluate the market once per
      // second (ADR-026 D2.4): 7.000, 8.000 and 9.000 s. None of them is a
      // confirmation: fresh at 8.000 s (2 000 ms after A1's last frame, the
      // bound itself), stale at 9.000 s (3 000 ms).
      expect(evaluatedSeconds(parts)).toEqual([...QUIET_AT_PRODUCTION, 7, 8, 9]);
      expect(evaluationAt(parts, 8).stale).toBe(false);
      expect(evaluationAt(parts, 9)).toMatchObject({ stale: true, bookAgeMs: "3000" });
      return;
    }
    expect(evaluationAt(parts, 8).stale).toBe(false);
    expect(evaluationAt(parts, 8.1).stale).toBe(true);
    expect(evaluationAt(parts, 9.2).stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. A disconnection mid-quiet is detected
// ---------------------------------------------------------------------------

describeAtEachCadence("3. a disconnection mid-quiet is detected", () => {
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
      if (cadence.production) {
        // `TC-LOWS-1` (O07): after 6.000 s the new session's changes evaluate
        // the market at 7.100 s and 8.300 s (ADR-026 D2.4); the ticks at
        // 7.950 and 8.050 s are coalesced. Fresh at 7.100 s (1 100 ms after the
        // old session's last frame), stale at 8.300 s (2 300 ms), although the
        // new session is busy.
        expect(evaluatedSeconds(parts)).toEqual([...QUIET_AT_PRODUCTION, 7.1, 8.3]);
        expect(evaluationAt(parts, 7.1).stale).toBe(false);
        expect(evaluationAt(parts, 8.3)).toMatchObject({ stale: true, bookAgeMs: "2300" });
        return;
      }
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
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the new session's changes evaluate the market once
      // per second (ADR-026 D2.4), the last at 11.350 s; the 11.500 s tick is
      // coalesced. Every evaluation is fresh, the last included.
      expect(evaluatedSeconds(parts)).toEqual([...QUIET_AT_PRODUCTION, 7.35, 8.35, 9.35, 10.35, 11.35]);
      expect(evaluations(parts).filter((evaluation) => evaluation.stale)).toEqual([]);
      return;
    }
    expect(evaluationAt(parts, 11.5).stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The fail-closed fallbacks
// ---------------------------------------------------------------------------

describeAtEachCadence("the fallbacks to the last change (fail closed)", () => {
  it("a data-quality incident naming NO market taints the gateway epoch: the quiet book is stale at once", async () => {
    const events = [...quietYesTimeline()];
    // Before 6.200 s's tick: the incident arrives, then one more frame on A1.
    events.splice(events.length - 1, 0, incident(6.05, "gw-polymarket-market-1"), noChange(6.1, A1, "999"));
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the 6.200 s tick comes 200 ms after the 6.000 s
      // evaluation and is coalesced (ADR-026 D2.4), so the reading after the
      // incident is a tick the cadence evaluates: 7.000 s. Stale at once, its
      // age the LAST CHANGE's (1.000 s): 6 000 ms.
      const later = await run({ basis: "CONNECTION_CONFIRMED" }, [...events, tick(7, "64005")]);
      expect(evaluationAt(later, 6).stale).toBe(false);
      expect(evaluationAt(later, 7)).toMatchObject({ stale: true, bookAgeMs: "6000" });
      return;
    }
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
    if (cadence.production) {
      // `TC-LOWS-1` (O07): A2's changes evaluate the market once per second
      // (ADR-026 D2.4); the 11.500 s tick is coalesced. Every reading ages by
      // the re-delivered YES book's own last change (6.300 s): fresh at
      // 7.350 s (1 050 ms), stale from 8.350 s (2 050 ms) to 11.350 s (5 050 ms).
      expect(evaluatedSeconds(parts)).toEqual([...QUIET_AT_PRODUCTION, 7.35, 8.35, 9.35, 10.35, 11.35]);
      expect(evaluationAt(parts, 7.35).stale).toBe(false);
      expect(evaluationAt(parts, 8.35)).toMatchObject({ stale: true, bookAgeMs: "2050" });
      expect(evaluationAt(parts, 11.35)).toMatchObject({ stale: true, bookAgeMs: "5050" });
      return;
    }
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
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the same evaluations as the tainted epoch's above
      // (ADR-026 D2.4), and every one of them fresh: epoch B is clean.
      expect(evaluatedSeconds(parts)).toEqual([...QUIET_AT_PRODUCTION, 7.35, 8.35, 9.35, 10.35, 11.35]);
      expect(evaluations(parts).filter((evaluation) => evaluation.stale)).toEqual([]);
      return;
    }
    expect(evaluationAt(parts, 11.5).stale).toBe(false);
  });

  it("an active incident on THIS market falls back to the last change", async () => {
    const events = [...quietYesTimeline()];
    events.splice(events.length - 1, 0, incident(6.05, "gw-lifecycle-1", [MARKET_ID]));
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the 6.200 s tick is coalesced (ADR-026 D2.4); the
      // reading is taken at a tick the cadence evaluates, 7.000 s: stale, aged
      // by the last change (1.000 s).
      const later = await run({ basis: "CONNECTION_CONFIRMED" }, [...events, tick(7, "64005")]);
      expect(evaluationAt(later, 7)).toMatchObject({ stale: true, bookAgeMs: "6000" });
      return;
    }
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    const after = evaluationAt(parts, 6.2);
    expect(after.stale).toBe(true);
    expect(after.bookAgeMs).toBe("5200");
  });

  it("an incident naming ANOTHER market neither taints the session nor touches this market", async () => {
    const events = [...quietYesTimeline()];
    events.splice(events.length - 1, 0, incident(6.05, "gw-lifecycle-9", [OTHER_MARKET_ID]));
    if (cadence.production) {
      // `TC-LOWS-1` (O07): read at a tick the cadence evaluates, 7.000 s
      // (ADR-026 D2.4): fresh, 1 000 ms after A1's last frame.
      const later = await run({ basis: "CONNECTION_CONFIRMED" }, [...events, tick(7, "64005")]);
      expect(evaluationAt(later, 7).stale).toBe(false);
      return;
    }
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
    if (cadence.production) {
      // `TC-LOWS-1` (O07): read at the production cadence's evaluations
      // (QUIET_AT_PRODUCTION; the 6.200 s tick is coalesced): A1's traffic
      // confirms nothing, so the book ages by itself — 5 000 ms at 6.000 s.
      expect(evaluatedSeconds(parts)).toEqual(QUIET_AT_PRODUCTION);
      expect(evaluationAt(parts, 6)).toMatchObject({ stale: true, bookAgeMs: "5000" });
      return;
    }
    const after = evaluationAt(parts, 6.2);
    expect(after.stale).toBe(true);
    expect(after.bookAgeMs).toBe("5200");
  });
});

describeAtEachCadence("r1 X5: a REST snapshot replaces a socket-delivered book's session", () => {
  it("socket book on A1, then a REST snapshot, then A1 keeps flowing: the book ages from the REST snapshot", async () => {
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1), noSnapshot(1.1, A1)];
    // A1 is busy, and the YES book is re-fetched over REST at 2.000 s.
    events.push(yesSnapshot(2, undefined));
    for (let step = 0; step < 8; step += 1) events.push(noChange(2.5 + step * 0.5, A1, String(700 + step)));
    events.push(tick(6.2));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    // A1's frames (the last at 6.000 s) confirm nothing about a book whose
    // last update came over REST: its age is its own, 4 200 ms. Mutant M6
    // (keep the previous session when an update carries none) reads fresh.
    if (cadence.production) {
      // `TC-LOWS-1` (O07): read at the production cadence's evaluations
      // (QUIET_AT_PRODUCTION; the 6.200 s tick is coalesced): fresh while the
      // REST snapshot is within 2 000 ms, then aged by it — 4 000 ms at 6.000 s.
      expect(evaluatedSeconds(parts)).toEqual(QUIET_AT_PRODUCTION);
      expect(evaluationAt(parts, 4).stale).toBe(false);
      expect(evaluationAt(parts, 6)).toMatchObject({ stale: true, bookAgeMs: "4000" });
      return;
    }
    const after = evaluationAt(parts, 6.2);
    expect(after.stale).toBe(true);
    expect(after.bookAgeMs).toBe("4200");
  });

  it("a socket frame for the same asset after the REST snapshot restores the session", async () => {
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1), noSnapshot(1.1, A1), yesSnapshot(2, undefined)];
    events.push(yesSnapshot(2.4, A1));
    for (let step = 0; step < 8; step += 1) events.push(noChange(2.5 + step * 0.5, A1, String(710 + step)));
    events.push(tick(6.2));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    if (cadence.production) {
      // `TC-LOWS-1` (O07): read at the production cadence's evaluations
      // (QUIET_AT_PRODUCTION; the 6.200 s tick is coalesced): every one is
      // fresh, A1 confirming the book again from 2.400 s.
      expect(evaluatedSeconds(parts)).toEqual(QUIET_AT_PRODUCTION);
      expect(evaluations(parts).filter((evaluation) => evaluation.stale)).toEqual([]);
      return;
    }
    expect(evaluationAt(parts, 6.2).stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// r1 finding X1 — the per-book ceiling on the last-change age (D2 rule 6)
// ---------------------------------------------------------------------------

describeAtEachCadence("r1 X1: a book whose OWN delivery stalls is bounded by the per-book ceiling", () => {
  /**
   * The YES snapshot at 1.000 s on A1, then ONLY another market's frames on
   * the same session, every 500 ms, until `until` s: a busy session whose YES
   * token is never delivered again (a per-asset stall no signal reports).
   */
  function stalledYes(until: number, ticks: readonly number[]): Recorded[] {
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1), noSnapshot(1.1, A1)];
    for (let at = 1.5; at <= until + 1e-9; at += 0.5) events.push(otherMarketSnapshot(Math.round(at * 1000) / 1000, A1));
    const sorted = [...events];
    for (const [index, at] of ticks.entries()) {
      // Insert each tick after every frame at or before its instant.
      const position = sorted.findIndex((recorded) => recorded.at > at);
      sorted.splice(position === -1 ? sorted.length : position, 0, tick(at, String(64000 + index)));
    }
    return sorted;
  }

  it("the verifiers' reproduction: at 121 s the book is STALE with its own 120 000 ms age (it read fresh at f341d5f)", async () => {
    const parts = await run({ basis: "CONNECTION_CONFIRMED", ceilingMs: 30_000 }, stalledYes(121, [121]));
    const at121 = evaluationAt(parts, 121);
    expect(at121.stale).toBe(true);
    expect(at121.bookAgeMs).toBe("120000");
  });

  it("fresh while the last change is within the ceiling, stale 1 ms past it (ceiling 5 000 ms)", async () => {
    const parts = await run({ basis: "CONNECTION_CONFIRMED", ceilingMs: 5_000 }, stalledYes(7, [5.9, 6, 6.001, 6.5]));
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the other market's frames owe this market nothing,
      // so it is evaluated at 1.000 s, at 2.000 s (the NO snapshot's owed
      // evaluation, carried), at the 5.900 s tick, and at 7.000 s (the ticks
      // at 6.000, 6.001 and 6.500 s, carried, at the first close 1 000 ms
      // after 5.900 s: ADR-026 D2.4, D2.6-D2.7). Fresh at 5.900 s (4 900 ms),
      // stale at 7.000 s (6 000 ms, its own last change).
      expect(evaluatedSeconds(parts)).toEqual([1, 2, 5.9, 7]);
      expect(evaluationAt(parts, 5.9).stale).toBe(false);
      expect(evaluationAt(parts, 7)).toMatchObject({ stale: true, bookAgeMs: "6000" });
      // The edge itself, at the production cadence: a lone tick is evaluated
      // (four seconds after 2.000 s), so each side of the ceiling gets a run.
      const atCeiling = await run({ basis: "CONNECTION_CONFIRMED", ceilingMs: 5_000 }, stalledYes(7, [6]));
      expect(evaluationAt(atCeiling, 6).stale).toBe(false);
      const pastCeiling = await run({ basis: "CONNECTION_CONFIRMED", ceilingMs: 5_000 }, stalledYes(7, [6.001]));
      expect(evaluationAt(pastCeiling, 6.001)).toMatchObject({ stale: true, bookAgeMs: "5001" });
      return;
    }
    // 4 900 ms and exactly 5 000 ms since the YES book's own change: vouched for.
    expect(evaluationAt(parts, 5.9).stale).toBe(false);
    expect(evaluationAt(parts, 6).stale).toBe(false);
    // 5 001 ms: the ceiling is passed, so the book ages by its own last change.
    const past = evaluationAt(parts, 6.001);
    expect(past.stale).toBe(true);
    expect(past.bookAgeMs).toBe("5001");
    expect(evaluationAt(parts, 6.5).bookAgeMs).toBe("5500");
  });

  it("§9.8 check 7 honours the same ceiling: a stalled YES book is refused by risk too", async () => {
    // The strategy's bound is moved out of the way so only check 7 gates.
    const cheapAsks = [
      { price: "0.34", size: "100" },
      { price: "0.35", size: "100" },
    ];
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1, cheapAsks)];
    for (let step = 0; step < 16; step += 1) events.push(otherMarketSnapshot(1.5 + step * 0.5, A1));
    events.push(noSnapshot(9.1, A1));
    const within = await run(
      { basis: "CONNECTION_CONFIRMED", ceilingMs: 10_000, paramsVersion: 1, strategyMaxAgeMs: 600_000, riskMaxAgeMs: 2_000 },
      events,
    );
    expect(within.trader.loop.orderProvenance().length).toBeGreaterThan(0);
    // `TC-LOWS-1` (O07): at the production cadence the quiet market is
    // evaluated by its HEARTBEAT at 6.000 s, 5 000 ms after its 1.000 s
    // evaluation (ADR-026 D2.4), and Static Bracket enters there — not at the
    // NO snapshot (9.100 s). A 5 000 ms ceiling still vouches for a change
    // exactly 5 000 ms old (measured: admitted), so the production run puts
    // the ceiling below the heartbeat's age, 4 000 ms: past it, check 7 refuses.
    const past = await run(
      {
        basis: "CONNECTION_CONFIRMED",
        ceilingMs: cadence.production ? 4_000 : 5_000,
        paramsVersion: 1,
        strategyMaxAgeMs: 600_000,
        riskMaxAgeMs: 2_000,
      },
      events,
    );
    expect(past.trader.loop.orderProvenance()).toHaveLength(0);
    expect(past.trader.loop.health().risk.refusalsByCode["RISK_BOOK_STALE"] ?? 0).toBeGreaterThan(0);
    if (cadence.production) {
      // `TC-LOWS-1` r1 (`TCL1-R1-04`): the reason the production run lowers
      // the ceiling, pinned. The market is evaluated at 1.000 s, then by its
      // HEARTBEAT at 6.000 s — the entry, its fill and the two order updates
      // harvested at that close — then at the NO snapshot (9.100 s; measured).
      expect(evaluatedSeconds(within)).toEqual([1, 6, 6, 6, 6, 9.1, 9.1]);
      // The entry is the heartbeat's: placed at 6.000 s, the YES change then
      // exactly 5 000 ms old.
      expect(entryEvaluatedSeconds(within)).toEqual([6]);
      // And the refusal is check 7's at that same heartbeat: past a 4 000 ms
      // ceiling, the 5 000 ms-old book is stale.
      expect(
        past.store.riskRefusals.map((refusal) => [
          (Date.parse(refusal.occurredAt) - Date.parse(T_OPEN)) / 1000,
          refusal.refusals.map((each) => each.code),
        ]),
      ).toEqual([[6, ["RISK_BOOK_STALE"]]]);
    }
  });

  /**
   * r1 finding X2, the documented gap: the epoch taint lives in process
   * memory, and the gateway deduplicates its incidents, so a trader that
   * starts (or restarts) AFTER an epoch's incident never learns of it. What
   * bounds that trader is the ceiling: it cannot vouch for a book past it.
   */
  it("r1 X2: a process that missed the epoch's incident is still bounded by the ceiling", async () => {
    const afterIncident = stalledYes(40, [20, 31.5]);
    // The process that consumed the incident falls back at once...
    const consumed = await run({ basis: "CONNECTION_CONFIRMED", ceilingMs: 30_000 }, [
      incident(0.5, "gw-polymarket-market-1"),
      ...afterIncident,
    ]);
    expect(evaluationAt(consumed, 20).stale).toBe(true);
    // ...the one that started after it cannot see the taint (the gap)...
    const late = await run({ basis: "CONNECTION_CONFIRMED", ceilingMs: 30_000 }, afterIncident);
    expect(evaluationAt(late, 20).stale).toBe(false);
    // ...but past the ceiling it ages by the book's own last change.
    const bounded = evaluationAt(late, 31.5);
    expect(bounded.stale).toBe(true);
    expect(bounded.bookAgeMs).toBe("30500");
  });
});

// ---------------------------------------------------------------------------
// §9.8 check 7 — the risk engine's VENUE_BOOK measurement
// ---------------------------------------------------------------------------

describeAtEachCadence("§9.8 check 7 measures the same confirmed age (risk freshness)", () => {
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
// r2 X9: a lagging trader, or a replay of old data, is not vouched for by
// the backlog (the process-lag guard, ADR-023 D7)
// ---------------------------------------------------------------------------

describeAtEachCadence("r2 X9: a lagging trader or a live replay of old data gets no more than unguarded CONNECTION_CONFIRMED at its own instant", () => {
  /** The reviewers' check-7 timeline (YES 09:00:01, NO snapshot 09:00:04.100 on the same session). */
  function checkSevenTimeline(): Recorded[] {
    const cheapAsks = [
      { price: "0.34", size: "100" },
      { price: "0.35", size: "100" },
    ];
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1, cheapAsks)];
    for (let step = 0; step < 6; step += 1) events.push(otherMarketSnapshot(1.5 + step * 0.5, A1));
    events.push(noSnapshot(4.1, A1));
    return events;
  }
  const checkSeven = { paramsVersion: 1 as const, strategyMaxAgeMs: 600_000, riskMaxAgeMs: 2_000 };
  const BACKLOG_CLOCK = "2026-05-01T09:30:00.000Z";

  it("the reviewers' reproduction: 09:00 events processed at 09:30 admit 0 orders, as under LAST_CHANGE (2 at a0a5f24)", async () => {
    const confirmed = await run(
      { ...checkSeven, basis: "CONNECTION_CONFIRMED", processClockAt: BACKLOG_CLOCK },
      checkSevenTimeline(),
    );
    const lastChange = await run({ ...checkSeven, basis: "LAST_CHANGE", processClockAt: BACKLOG_CLOCK }, checkSevenTimeline());
    for (const parts of [confirmed, lastChange]) {
      expect(parts.trader.loop.orderProvenance()).toHaveLength(0);
      expect(parts.trader.loop.health().risk.approvals).toBe(0);
      expect(parts.trader.loop.health().risk.refusalsByCode["RISK_BOOK_STALE"] ?? 0).toBeGreaterThan(0);
    }
  });

  it("the quiet-YES timeline replayed 30 minutes late: every evaluation is exactly the LAST_CHANGE one", async () => {
    const confirmed = await run({ basis: "CONNECTION_CONFIRMED", processClockAt: BACKLOG_CLOCK }, quietYesTimeline());
    const lastChange = await run({ basis: "LAST_CHANGE", processClockAt: BACKLOG_CLOCK }, quietYesTimeline());
    expect(evaluations(confirmed)).toEqual(evaluations(lastChange));
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the 6.200 s tick is coalesced (ADR-026 D2.4); the
      // last evaluation is 6.000 s, aged by the last change: 5 000 ms.
      expect(evaluatedSeconds(confirmed)).toEqual(QUIET_AT_PRODUCTION);
      expect(evaluationAt(confirmed, 6)).toMatchObject({ stale: true, bookAgeMs: "5000" });
      return;
    }
    expect(evaluationAt(confirmed, 6.2)).toMatchObject({ stale: true, bookAgeMs: "5200" });
  });

  it("a live process 1 700 ms behind is still vouched for at 6.200 s (1 900 ms); 1 900 ms behind, it is stale (2 100 ms)", async () => {
    if (cadence.production) {
      // `TC-LOWS-1` (O07): the 6.200 s tick is coalesced (ADR-026 D2.4). The
      // production cadence evaluates at the NO change at each whole second,
      // and a frame never vouches at its own close (r8, R8-H1): the latest
      // proven frame is 500 ms earlier, not 200 ms. So the same edge — the
      // lag plus the confirmed age against the 2 000 ms bound — lies at a lag
      // of 1 500 ms: vouched for at 6.000 s (2 000 ms); 1 600 ms behind, stale
      // (2 100 ms).
      const atBound = await run({ basis: "CONNECTION_CONFIRMED", processLagMs: 1_500 }, quietYesTimeline());
      expect(evaluationAt(atBound, 6).stale).toBe(false);
      const pastBound = await run({ basis: "CONNECTION_CONFIRMED", processLagMs: 1_600 }, quietYesTimeline());
      expect(evaluationAt(pastBound, 6)).toMatchObject({ stale: true, bookAgeMs: "2100" });
      return;
    }
    const within = await run({ basis: "CONNECTION_CONFIRMED", processLagMs: 1_700 }, quietYesTimeline());
    expect(evaluationAt(within, 6.2).stale).toBe(false);
    const beyond = await run({ basis: "CONNECTION_CONFIRMED", processLagMs: 1_900 }, quietYesTimeline());
    expect(evaluationAt(beyond, 6.2)).toMatchObject({ stale: true, bookAgeMs: "2100" });
  });

  it("a replay clock positioned at each event (no lag) decides exactly as the unlagged run", async () => {
    const positioned = await run({ basis: "CONNECTION_CONFIRMED", processLagMs: 0 }, quietYesTimeline());
    const unlagged = await run({ basis: "CONNECTION_CONFIRMED" }, quietYesTimeline());
    const records = (parts: Run) => JSON.stringify(parts.store.decisions.map((recorded) => recorded.record));
    expect(records(positioned)).toBe(records(unlagged));
    expect(evaluations(positioned).filter((evaluation) => evaluation.stale)).toEqual([]);
  });

  it("r3 O-L1: a 3 ms process lag leaves every stale/fresh outcome unchanged but changes the decision records (no byte parity with replay)", async () => {
    const lagged = await run({ basis: "CONNECTION_CONFIRMED", processLagMs: 3 }, quietYesTimeline());
    const unlagged = await run({ basis: "CONNECTION_CONFIRMED", processLagMs: 0 }, quietYesTimeline());
    const verdicts = (parts: Run) => evaluations(parts).map((evaluation) => evaluation.stale);
    expect(verdicts(lagged)).toEqual(verdicts(unlagged));
    const records = (parts: Run) => parts.store.decisions.map((recorded) => JSON.stringify(recorded.record));
    expect(records(lagged)).toHaveLength(records(unlagged).length);
    expect(records(lagged)).not.toEqual(records(unlagged));
    // Under LAST_CHANGE no clock is read: the lag leaves the records byte-identical.
    const lastChangeLagged = await run({ basis: "LAST_CHANGE", processLagMs: 3 }, quietYesTimeline());
    const lastChangeUnlagged = await run({ basis: "LAST_CHANGE", processLagMs: 0 }, quietYesTimeline());
    expect(records(lastChangeLagged)).toEqual(records(lastChangeUnlagged));
  });
});

// ---------------------------------------------------------------------------
// 4. Replay determinism, and backward compatibility
// ---------------------------------------------------------------------------

describeAtEachCadence("4. replay is deterministic", () => {
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
    // `TC-LOWS-1` (O07): at the production cadence the market is evaluated
    // once per second (ADR-026 D2.4), so fewer decisions are made (8,
    // measured); the same bytes twice either way (D6).
    expect(first.store.decisions.length).toBeGreaterThan(cadence.production ? 5 : 10);
  });
});

// ---------------------------------------------------------------------------
// r8 (R8-H1, and the class R6-H1 and R7-H1 belong to): a frame vouches for
// a book only once this process has PROVEN it whole
// ---------------------------------------------------------------------------

describeAtEachCadence("r8 R8-H1: no evaluation takes a confirmation from a frame this loop has not proven whole", () => {
  const CHEAP_ASKS = [
    { price: "0.34", size: "100" },
    { price: "0.35", size: "100" },
  ];
  /** Both freshness gates at 2 000 ms: the strategy's (version 2) and check 7's. */
  const BOTH_GATES = { basis: "CONNECTION_CONFIRMED" as const, riskMaxAgeMs: 2_000 };

  /**
   * `TC-LOWS-1` (O07): the instant of the frame that FOLLOWS the 4.100 s
   * one. At the per-frame cadence, 4.200 s. At the production cadence an
   * event 100 ms after the 4.100 s evaluation is coalesced (ADR-026 D2.4) and
   * would evaluate nothing, so the following frame comes at 5.100 s, the
   * first instant the cadence evaluates the market again: the frame it
   * follows is the same one, and what it may vouch for is the same question.
   */
  function following(offsetMs = 0): number {
    return (cadence.production ? 5.1 : 4.2) + offsetMs / 1000;
  }

  /**
   * The R8-H1 shape at the loop. The YES book (asks under the 0.35 trigger)
   * at 1.000 s, then nothing on the session until 4.100 s, when ONE venue
   * frame carries `noCount` NO snapshots and then the YES change that moves
   * the YES asks above the trigger. Static Bracket can enter only once the
   * NO book exists, so the only evaluations that could enter are the ones
   * this frame closes: an entry means the frame vouched for a YES book its
   * own change had not reached yet.
   */
  function splitFrameTimeline(noCount: number): Recorded[] {
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1, CHEAP_ASKS)];
    for (let index = 0; index < noCount; index += 1) events.push({ ...noSnapshot(4.1, A1), frame: "late" });
    events.push({ ...yesSnapshot(4.1, A1), frame: "late" });
    return events;
  }

  it("the R8-H1 reproduction at the loop: a frame handed out in two batches, its YES change in the second, admits nothing (2 orders at 298199d)", async () => {
    const events = splitFrameTimeline(3);
    // Everything up to the frame's three NO snapshots, then the YES change:
    // `RedisMarketEventFeed` at `receiveBatchSize` 6 hands this frame out so.
    const confirmed = await runInBatches(BOTH_GATES, events, [6, 1]);
    expect(confirmed.trader.loop.orderProvenance(), "orders on a book whose change was in the unread part").toHaveLength(0);
    expect(confirmed.trader.loop.health().risk.approvals).toBe(0);
    // Refused for the right reason: at the first batch's close the YES book
    // is 3 100 ms old, because the frame it sits in is not yet proven.
    const headClose = evaluations(confirmed).filter((evaluation) => Date.parse(evaluation.at) === Date.parse(iso(4.1)));
    expect(headClose.length).toBeGreaterThan(0);
    expect(headClose[0]).toMatchObject({ stale: true, bookAgeMs: "3100" });
    const lastChange = await runInBatches({ ...BOTH_GATES, basis: "LAST_CHANGE" }, events, [6, 1]);
    expect(lastChange.trader.loop.orderProvenance()).toHaveLength(0);
  });

  it("wherever the batch ends inside the frame, and at every batch size down to 1, nothing is admitted", async () => {
    const events = splitFrameTimeline(4);
    const partitions: number[][] = [];
    // A cut after each of the frame's NO snapshots.
    for (let head = 1; head <= 4; head += 1) partitions.push([3 + head, 4 - head + 1]);
    // `receiveBatchSize` 1, 2 and 3: batches of that size, the last one short.
    for (const size of [1, 2, 3]) {
      const sizes: number[] = [];
      for (let left = events.length; left > 0; left -= size) sizes.push(Math.min(size, left));
      partitions.push(sizes);
    }
    for (const batches of partitions) {
      const parts = await runInBatches(BOTH_GATES, events, batches);
      expect(parts.trader.loop.orderProvenance(), `batches ${JSON.stringify(batches)}`).toHaveLength(0);
      expect(parts.trader.loop.health().risk.approvals, `batches ${JSON.stringify(batches)}`).toBe(0);
    }
  });

  it("a frame vouches from the next frame of its epoch on, never at its own close", async () => {
    // A single NO snapshot at 4.100 s (a frame of one), then a NO change at
    // 4.200 s. At 298199d the NO snapshot vouched for the YES book at its own
    // close and the entry was admitted at 4.100 s.
    const events: Recorded[] = [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_ASKS),
      noSnapshot(4.1, A1),
      noChange(following(), A1, "250"),
    ];
    const parts = await run(BOTH_GATES, events);
    expect(evaluationAt(parts, 4.1)).toMatchObject({ stale: true, bookAgeMs: "3100" });
    // At 4.200 s the entry is evaluated first (the fill's callbacks follow it
    // at the same instant), on a YES book vouched for by the 4.100 s frame.
    // (`TC-LOWS-1`: 5.100 s at the production cadence; see `following`.)
    const at42 = evaluations(parts).filter((evaluation) => Date.parse(evaluation.at) === Date.parse(iso(following())));
    expect(at42[0]?.stale).toBe(false);
    const provenance = parts.trader.loop.orderProvenance();
    expect(provenance.length).toBeGreaterThan(0);
    // The entry is the 4.200 s event's evaluation: ordinal 5.
    expect(provenance[0]?.sourceEventId).toBe(`018f5c20-9000-7a90-8b00-${String(5).padStart(12, "0")}`);
  });

  it("a frame that nothing follows never vouches (fail closed), and a later frame of ANOTHER epoch does not prove it", async () => {
    const lastFrame: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1, CHEAP_ASKS), noSnapshot(4.1, A1)];
    const alone = await run(BOTH_GATES, lastFrame);
    expect(alone.trader.loop.orderProvenance()).toHaveLength(0);
    // A gateway restart: its first frame is epoch B's, so the epoch-A frame
    // at 4.100 s stays unproven (its tail may have been lost in the restart).
    const restarted = await run(BOTH_GATES, [...lastFrame, noChange(following(), B1, "250")]);
    expect(restarted.trader.loop.orderProvenance()).toHaveLength(0);
    // A reference tick of epoch A, by contrast, follows it in the same stream.
    const followed = await run(BOTH_GATES, [...lastFrame, tick(following(), "64001")]);
    expect(followed.trader.loop.orderProvenance().length).toBeGreaterThan(0);
  });

  it("the answer is a function of the event sequence, not of the batches: every partition admits the same entry, at the same event", async () => {
    // A frame of five NO snapshots at 4.100 s and no YES change, then frames
    // of one at 4.200 s and 4.300 s. Under r8 the entry is the 4.200 s
    // event's whatever the batches; at 298199d a batch ending inside the
    // frame moved it earlier, onto the frame's own unproven head.
    const events: Recorded[] = [tick(-2), marketOpened(0), yesSnapshot(1, A1, CHEAP_ASKS)];
    for (let index = 0; index < 5; index += 1) events.push({ ...noSnapshot(4.1, A1), frame: "late" });
    // `TC-LOWS-1` (O07): 5.100 s and 5.200 s at the production cadence (`following`).
    events.push(noChange(following(), A1, "250"), noChange(following(100), A1, "251"));
    const partitions: number[][] = [[events.length], Array.from({ length: events.length }, () => 1), [4, 6], [5, 2, 3], [7, 1, 2]];
    const sources: string[][] = [];
    for (const batches of partitions) {
      const parts = await runInBatches(BOTH_GATES, events, batches);
      sources.push(parts.trader.loop.orderProvenance().map((link) => link.sourceEventId));
    }
    expect(sources[0]?.length).toBeGreaterThan(0);
    for (const [index, found] of sources.entries()) expect(found, `partition ${String(index)}`).toEqual(sources[0]);
    // The entry is the 4.200 s event's evaluation (ordinal 9), in every partition.
    expect(sources[0]?.[0]).toBe(`018f5c20-9000-7a90-8b00-${String(9).padStart(12, "0")}`);
  });

  it("an incident that FOLLOWS a frame (the pre-r6 order) proves the frame and taints its epoch in the same step: nothing is admitted", async () => {
    // What `74e17ca`'s gateway published for R6-H1 and `f341d5f`'s for X8:
    // the frame's accepted NO snapshot, then the incident for the event it
    // lost. The frame's confirmation is released only by the incident, which
    // taints the epoch before any evaluation can read it.
    const events: Recorded[] = [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_ASKS),
      { ...noSnapshot(4.1, A1), frame: "late" },
      incident(4.1, "gw-polymarket-market-r6"),
      noChange(following(), A1, "250"),
    ];
    const parts = await run(BOTH_GATES, events);
    expect(parts.trader.loop.orderProvenance()).toHaveLength(0);
    // `TC-LOWS-1` (O07): aged by the last change (1.000 s) — 3 200 ms at
    // 4.200 s, 4 100 ms at the production cadence's 5.100 s (`following`).
    expect(evaluationAt(parts, following())).toMatchObject({ stale: true, bookAgeMs: cadence.production ? "4100" : "3200" });
  });
});

describeAtEachCadence("backward compatibility: a document with no bookFreshness block", () => {
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

  it("r6 O-R6-I1: under LAST_CHANGE the loop records no delivery session for a book; under CONNECTION_CONFIRMED it does", async () => {
    const sessionsOf = (parts: Run) => {
      const market = parts.trader.markets.get(MARKET_ID);
      return [market?.bookSession("YES"), market?.bookSession("NO")];
    };
    const absent = await run({ paramsVersion: 1 }, quietYesTimeline());
    const lastChange = await run({ basis: "LAST_CHANGE", paramsVersion: 1 }, quietYesTimeline());
    const confirmed = await run({ basis: "CONNECTION_CONFIRMED" }, quietYesTimeline());
    expect(sessionsOf(absent)).toEqual([undefined, undefined]);
    expect(sessionsOf(lastChange)).toEqual([undefined, undefined]);
    const session = sessionKeyOf({
      eventType: "BookSnapshot",
      gatewayEpoch: A1.epoch,
      connectionId: A1.connectionId,
      subscriptionGeneration: A1.generation,
    });
    expect(session).toBeDefined();
    expect(sessionsOf(confirmed)).toEqual([session, session]);
  });

  it("refuses an unknown basis and an unknown key in the block", () => {
    const withBlock = (block: unknown) => ({ ...traderConfig({ paramsVersion: 1 }), bookFreshness: block });
    expect(parseTraderConfig(withBlock({ basis: "HEARTBEAT" })).ok).toBe(false);
    expect(parseTraderConfig(withBlock({ basis: "CONNECTION_CONFIRMED", maxAgeMs: 5 })).ok).toBe(false);
    expect(parseTraderConfig(withBlock({})).ok).toBe(false);
  });

  it("r1 X1: CONNECTION_CONFIRMED REQUIRES a bounded integer ceiling; LAST_CHANGE refuses one", () => {
    const withBlock = (block: unknown) => ({ ...traderConfig({ paramsVersion: 1 }), bookFreshness: block });
    const accepted = parseTraderConfig(withBlock({ basis: "CONNECTION_CONFIRMED", maximumLastChangeAgeMs: 600_000 }));
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(bookFreshnessBasisOf(accepted.config)).toBe("CONNECTION_CONFIRMED");
      expect(bookFreshnessCeilingMsOf(accepted.config)).toBe(600_000);
    }
    // No ceiling, a zero, a fraction, past the ten-minute cap, a string.
    for (const ceiling of [undefined, 0, -1, 1.5, 600_001, "30000"]) {
      const block = ceiling === undefined ? { basis: "CONNECTION_CONFIRMED" } : { basis: "CONNECTION_CONFIRMED", maximumLastChangeAgeMs: ceiling };
      expect(parseTraderConfig(withBlock(block)).ok, String(ceiling)).toBe(false);
    }
    expect(parseTraderConfig(withBlock({ basis: "LAST_CHANGE", maximumLastChangeAgeMs: 30_000 })).ok).toBe(false);
    const lastChange = parseTraderConfig(withBlock({ basis: "LAST_CHANGE" }));
    expect(lastChange.ok).toBe(true);
    if (lastChange.ok) expect(bookFreshnessCeilingMsOf(lastChange.config)).toBeUndefined();
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
    const common = {
      sessionKey: key,
      marketHasActiveIncident: false,
      liveness,
      nowEpochMs: 9_500,
      processNowEpochMs: 9_500,
      maximumLastChangeAgeMs: 30_000,
    };
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

  it("r1 X1: past the per-book ceiling the answer is the last change; at it, still the confirmation", () => {
    const liveness = new DeliverySessionLiveness();
    const key = sessionKeyOf(bookEvent(A1)) as string;
    liveness.observe(bookEvent(A1), at(40_000));
    const common = { basis: "CONNECTION_CONFIRMED" as const, sessionKey: key, marketHasActiveIncident: false, liveness, lastChange: at(10_000) };
    const at_ = (nowEpochMs: number) => ({ nowEpochMs, processNowEpochMs: nowEpochMs });
    expect(bookConfirmedAt({ ...common, ...at_(40_000), maximumLastChangeAgeMs: 30_000 })?.epochMs).toBe(40_000);
    expect(bookConfirmedAt({ ...common, ...at_(40_001), maximumLastChangeAgeMs: 30_000 })?.epochMs).toBe(10_000);
    // No ceiling (the door never allows it under this basis): the extension is off.
    expect(bookConfirmedAt({ ...common, ...at_(11_000), maximumLastChangeAgeMs: undefined })?.epochMs).toBe(10_000);
    // A non-finite instant cannot pass the ceiling check.
    expect(bookConfirmedAt({ ...common, ...at_(Number.NaN), maximumLastChangeAgeMs: 30_000 })?.epochMs).toBe(10_000);
  });

  it("r2 X9: the process-lag guard moves a confirmation back by the lag, never before the last change", () => {
    const liveness = new DeliverySessionLiveness();
    const key = sessionKeyOf(bookEvent(A1)) as string;
    liveness.observe(bookEvent(A1), at(5_000));
    const common = {
      basis: "CONNECTION_CONFIRMED" as const,
      sessionKey: key,
      marketHasActiveIncident: false,
      liveness,
      lastChange: at(1_000),
      nowEpochMs: 5_000,
      maximumLastChangeAgeMs: 30_000,
    };
    // No lag (a replay clock at the event), and a process clock BEHIND event
    // time (never read as a negative lag): the confirmation itself.
    expect(bookConfirmedAt({ ...common, processNowEpochMs: 5_000 })).toEqual(at(5_000));
    expect(bookConfirmedAt({ ...common, processNowEpochMs: 4_000 })).toEqual(at(5_000));
    // 1 500 ms behind: the confirmation moves back 1 500 ms, in both forms.
    expect(bookConfirmedAt({ ...common, processNowEpochMs: 6_500 })).toEqual({
      iso: "1970-01-01T00:00:03.500Z",
      epochMs: 3_500,
    });
    // Behind by the confirmation's whole lead over the last change, or more
    // (the reviewers' backlog: 30 minutes): exactly the last change.
    expect(bookConfirmedAt({ ...common, processNowEpochMs: 9_000 })).toEqual(at(1_000));
    expect(bookConfirmedAt({ ...common, processNowEpochMs: 5_000 + 1_800_000 })).toEqual(at(1_000));
    // An unreadable process clock is doubt: the extension is off.
    expect(bookConfirmedAt({ ...common, processNowEpochMs: undefined })).toEqual(at(1_000));
    expect(bookConfirmedAt({ ...common, processNowEpochMs: Number.NaN })).toEqual(at(1_000));
    expect(bookConfirmedAt({ ...common, processNowEpochMs: Number.POSITIVE_INFINITY })).toEqual(at(1_000));
    // The ceiling is judged at the process's instant: 29 000 ms of event-time
    // age plus 1 001 ms of lag is past a 30 000 ms ceiling.
    expect(
      bookConfirmedAt({ ...common, nowEpochMs: 30_000, processNowEpochMs: 31_001, lastChange: at(1_000) }),
    ).toEqual(at(1_000));
    // LAST_CHANGE never needs the process clock.
    expect(bookConfirmedAt({ ...common, basis: "LAST_CHANGE", processNowEpochMs: undefined })).toEqual(at(1_000));
  });

  it("r3 R3-L1: the guard is bounded by unguarded CONNECTION_CONFIRMED, not by LAST_CHANGE, until the shifted confirmation stops leading", () => {
    const liveness = new DeliverySessionLiveness();
    const key = sessionKeyOf(bookEvent(A1)) as string;
    liveness.observe(bookEvent(A1), at(5_000));
    const common = {
      basis: "CONNECTION_CONFIRMED" as const,
      sessionKey: key,
      marketHasActiveIncident: false,
      liveness,
      lastChange: at(0),
      nowEpochMs: 5_200,
      maximumLastChangeAgeMs: 30_000,
    };
    // The reviewers' counterexample: lag 1 700 leaves the book 1 900 ms old
    // (fresh at 2 000), where LAST_CHANGE reads it 5 200 ms old (stale).
    const guarded = bookConfirmedAt({ ...common, processNowEpochMs: 6_900 });
    expect(guarded).toEqual({ iso: "1970-01-01T00:00:03.300Z", epochMs: 3_300 });
    expect(5_200 - (guarded?.epochMs ?? Number.NaN)).toBe(1_900);
    const lastChange = bookConfirmedAt({ ...common, basis: "LAST_CHANGE", processNowEpochMs: 6_900 });
    expect(lastChange).toEqual(at(0));
    // At every lag the guarded instant is between LAST_CHANGE and the unguarded
    // confirmation, and equals LAST_CHANGE once the lag covers the lead.
    const unguarded = bookConfirmedAt({ ...common, processNowEpochMs: 5_200 });
    expect(unguarded).toEqual(at(5_000));
    for (const lag of [0, 1, 3, 1_700, 4_999, 5_000, 5_001, 60_000]) {
      const answer = bookConfirmedAt({ ...common, processNowEpochMs: 5_200 + lag })?.epochMs ?? Number.NaN;
      expect(answer).toBeLessThanOrEqual(5_000);
      expect(answer).toBeGreaterThanOrEqual(0);
      expect(answer).toBe(Math.max(0, 5_000 - lag));
    }
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

  describe("r8 FrameCompletionGate", () => {
    const framed = (
      session: Session,
      ingestSeq: string,
      frame: string | undefined,
      eventType = "BookSnapshot",
      source = "polymarket",
    ) => ({
      ...bookEvent(session, eventType, source),
      ingestSeq,
      ...(frame === undefined ? {} : { causationId: `raw:${session.epoch}:${frame}` }),
    });

    it("holds a frame's confirmations until a later event of the SAME epoch from ANOTHER frame proves the frame whole", () => {
      const liveness = new DeliverySessionLiveness();
      const gate = new FrameCompletionGate(liveness);
      const a1 = sessionKeyOf(bookEvent(A1)) as string;
      const b1 = sessionKeyOf(bookEvent(B1)) as string;
      gate.offer(framed(A1, "10", "f1"), at(1_000));
      gate.offer(framed(A1, "11", "f1"), at(1_001));
      // More of the same frame (a second batch of it) proves nothing.
      expect(liveness.confirmation(a1)).toBeUndefined();
      expect(gate.unprovenFrames).toBe(1);
      // An event of ANOTHER epoch proves nothing (a restart may have lost the tail).
      gate.offer(framed(B1, "12", "g1"), at(1_002));
      expect(liveness.confirmation(a1)).toBeUndefined();
      expect(liveness.confirmation(b1)).toBeUndefined();
      expect(gate.unprovenFrames).toBe(2);
      // A later event of epoch A from another frame, even one that confirms
      // nothing itself, proves f1 whole: its LATEST confirmation is released.
      gate.offer({ eventType: "ReferenceTradeObserved", source: "binance", gatewayEpoch: EPOCH_A, ingestSeq: "13" }, at(1_500));
      expect(liveness.confirmation(a1)?.epochMs).toBe(1_001);
      expect(liveness.confirmation(b1)).toBeUndefined();
      expect(gate.unprovenFrames).toBe(1);
      // A frame of one, without a causation, is its own frame: held, then
      // proven by the next event of its epoch.
      gate.offer(framed(A1, "14", undefined), at(2_000));
      expect(liveness.confirmation(a1)?.epochMs).toBe(1_001);
      gate.offer(framed(A1, "15", undefined), at(2_100));
      expect(liveness.confirmation(a1)?.epochMs).toBe(2_000);
    });

    it("releases every session a proven frame carried, and holds back what the next frame carries", () => {
      const liveness = new DeliverySessionLiveness();
      const gate = new FrameCompletionGate(liveness);
      gate.offer(framed(A1, "20", "f2"), at(3_000));
      gate.offer(framed(A2, "21", "f2"), at(3_001));
      gate.offer(framed(A1_GEN2, "22", "f3"), at(3_100));
      expect(liveness.confirmation(sessionKeyOf(bookEvent(A1)) as string)?.epochMs).toBe(3_000);
      expect(liveness.confirmation(sessionKeyOf(bookEvent(A2)) as string)?.epochMs).toBe(3_001);
      expect(liveness.confirmation(sessionKeyOf(bookEvent(A1_GEN2)) as string)).toBeUndefined();
    });

    it("an event that confirms nothing still proves the frame before it, and an event naming no frame neither proves nor confirms", () => {
      const liveness = new DeliverySessionLiveness();
      const gate = new FrameCompletionGate(liveness);
      const a1 = sessionKeyOf(bookEvent(A1)) as string;
      gate.offer(framed(A1, "30", "f4"), at(4_000));
      // No `ingestSeq` and no causation: no frame key (unreachable behind the
      // event door, which requires both identity fields).
      gate.offer({ ...bookEvent(A1), ingestSeq: "" }, at(4_100));
      expect(liveness.confirmation(a1)).toBeUndefined();
      expect(gate.unprovenFrames).toBe(1);
      // A binance-sourced book event confirms nothing, but it is a later
      // event of the epoch from another frame.
      gate.offer(framed(A1, "31", "f5", "BookLevelChanged", "binance"), at(4_200));
      expect(liveness.confirmation(a1)?.epochMs).toBe(4_000);
      expect(gate.unprovenFrames).toBe(0);
    });

    it("is bounded: past MAXIMUM_UNPROVEN_FRAMES epochs the oldest held frame is forgotten, and confirms nothing (stricter, never looser)", () => {
      const liveness = new DeliverySessionLiveness();
      const gate = new FrameCompletionGate(liveness);
      const epochOf = (index: number) => `018f5c20-5000-7a50-8b00-${String(index).padStart(12, "0")}`;
      const sessionOf = (index: number): Session => ({ epoch: epochOf(index), connectionId: "c", generation: 1 });
      for (let index = 0; index <= MAXIMUM_UNPROVEN_FRAMES; index += 1) {
        gate.offer(framed(sessionOf(index), "1", "f"), at(5_000));
      }
      expect(gate.unprovenFrames).toBe(MAXIMUM_UNPROVEN_FRAMES);
      // A later event of each epoch from another frame (a reference tick: it
      // proves, and holds nothing of its own).
      const nextOf = (index: number) => ({
        eventType: "ReferenceTradeObserved",
        source: "binance",
        gatewayEpoch: epochOf(index),
        ingestSeq: "2",
      });
      // Epoch 0's frame was forgotten: its epoch's next event releases nothing.
      gate.offer(nextOf(0), at(5_100));
      expect(liveness.confirmation(sessionKeyOf(bookEvent(sessionOf(0))) as string)).toBeUndefined();
      // Epoch 1's is still held, and its epoch's next event releases it.
      gate.offer(nextOf(1), at(5_100));
      expect(liveness.confirmation(sessionKeyOf(bookEvent(sessionOf(1))) as string)?.epochMs).toBe(5_000);
      expect(gate.unprovenFrames).toBe(MAXIMUM_UNPROVEN_FRAMES - 1);
    });
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

// ---------------------------------------------------------------------------
// `C1-HALTS` (the user's rulings of 2026-10-08)
// ---------------------------------------------------------------------------

const CHEAP_YES_ASKS = [
  { price: "0.34", size: "100" },
  { price: "0.35", size: "100" },
];

/** A YES snapshot carrying NO subscription generation: refused `ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION` (a DIVERGENCE). */
function unstampedYesSnapshot(at: number): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, bids: [{ price: "0.32", size: "200" }], asks: CHEAP_YES_ASKS },
    at,
    epoch: EPOCH_A,
  };
}

function yesChange(at: number, session: Session, price: string, size: string, market = MARKET_ID, token = YES_TOKEN): Recorded {
  return { eventType: "BookLevelChanged", payload: { internalMarketId: market, tokenId: token, side: "ASK", price, size }, at, session };
}

function bookFor(market: string, token: string, at: number, session: Session, asks: readonly { price: string; size: string }[]): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: { internalMarketId: market, tokenId: token, bids: [{ price: "0.32", size: "200" }], asks },
    at,
    session,
  };
}

function marketTwoOpened(at: number): Recorded {
  return {
    eventType: "MarketOpened",
    payload: { internalMarketId: MARKET_2, conditionId: `${CONDITION_ID}-2`, openedAt: T_OPEN },
    at,
  };
}

/** The markets that placed orders, in the order each first placed one (by its instance's run). */
function entryMarkets(parts: Run): readonly string[] {
  const marketOfRun = new Map([
    [RUN_ID, MARKET_ID],
    [RUN_2, MARKET_2],
  ]);
  return [...new Set(parts.trader.loop.orderProvenance().map((link) => marketOfRun.get(link.runId) ?? link.runId))];
}

function bookNotSynchronizedRefusals(parts: Run): number {
  return parts.trader.loop.health().risk.refusalsByCode["RISK_BOOK_NOT_SYNCHRONIZED"] ?? 0;
}

/** The strategy's own freshness gate out of the way: the gate under test is risk check 8. */
const CHECK_8_ONLY: ConfigOptions = { paramsVersion: 1, strategyMaxAgeMs: 600_000 };

describe("C1-HALTS BOOK-WAITS: a desynchronized book waits for its next snapshot instead of halting", () => {
  beforeAll(() => {
    cadence = REPRODUCTION;
  });

  it("a refused snapshot after a good one: no halt; the book waits, and risk check 8 refuses the entry it would have placed", async () => {
    const parts = await run(CHECK_8_ONLY, [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      // The venue's next authoritative state, which this book cannot take.
      unstampedYesSnapshot(1.5),
      // Both books now exist and the YES ask satisfies the trigger: the
      // strategy enters — and check 8 refuses, because the YES book waits.
      noSnapshot(2, A1),
    ]);
    expect(parts.trader.halts.anyHalt).toBe(false);
    expect(entryMarkets(parts)).toEqual([]);
    expect(bookNotSynchronizedRefusals(parts)).toBe(1);
    expect(parts.trader.markets.get(MARKET_ID)?.bookFor("YES").baseline()).toBeUndefined();
    expect(parts.trader.loop.bookRefusals()[MARKET_ID]).toEqual({ benign: 0, divergence: 1, waiting: ["YES"] });
    // While it waits, a later level change is refused too (no baseline), and
    // the book still waits: only a snapshot re-arms it.
    const still = await run(CHECK_8_ONLY, [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      unstampedYesSnapshot(1.5),
      yesChange(1.7, A1, "0.34", "120"),
    ]);
    // (The NO book has had no snapshot yet, so it waits too.)
    expect(still.trader.loop.bookRefusals()[MARKET_ID]).toEqual({ benign: 0, divergence: 2, waiting: ["NO", "YES"] });
    expect(still.trader.markets.get(MARKET_ID)?.bookFor("YES").levels("ASK")[0]).toEqual({ price: "0.34", size: "100" });
  });

  it("the next applied snapshot re-arms a waiting book on its own, and the market trades", async () => {
    const parts = await run(CHECK_8_ONLY, [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      unstampedYesSnapshot(1.5),
      // Re-armed here: nothing but this snapshot does it.
      yesSnapshot(2, A1, CHEAP_YES_ASKS),
      noSnapshot(2.5, A1),
    ]);
    expect(parts.trader.halts.anyHalt).toBe(false);
    expect(parts.trader.loop.bookRefusals()[MARKET_ID]).toEqual({ benign: 0, divergence: 1, waiting: [] });
    expect(bookNotSynchronizedRefusals(parts)).toBe(0);
    expect(entryMarkets(parts)).toEqual([MARKET_ID]);
  });

  it("REDUCTIONS are refused too: a held position's protective exit, while its book waits, is refused by check 8 (cancels still go out)", async () => {
    // The entry fills at 2.000 s and its take-profit rests. The YES book is
    // refused an update at 10 s and waits. Past the maximum holding time
    // (180 s) the strategy cancels the take-profit (210 s) and then emits its
    // protected reduction (240 s) — which check 8 refuses.
    const events: Recorded[] = [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      noSnapshot(2, A1),
      unstampedYesSnapshot(10),
    ];
    for (let at = 30; at <= 270; at += 30) events.push(tick(at, String(64_000 + at)));
    const parts = await run(CHECK_8_ONLY, events);
    expect(parts.trader.halts.anyHalt).toBe(false);
    expect(entryMarkets(parts)).toEqual([MARKET_ID]);
    const health = parts.trader.loop.health();
    // The cancel of the resting take-profit went out and was confirmed…
    expect(health.execution.cancelsConfirmed).toBe(1);
    // …and the protected reduction after it was refused by check 8.
    expect(health.risk.refusedExitsByCode).toEqual({ RISK_BOOK_NOT_SYNCHRONIZED: 1 });
    expect(health.risk.refusalsByCode).toEqual({ RISK_BOOK_NOT_SYNCHRONIZED: 1 });
  });

  it("the restart case: a run that starts mid-stream with level changes before any snapshot does NOT halt, and trades once the snapshots arrive", async () => {
    const parts = await run(CHECK_8_ONLY, [
      tick(-2),
      marketOpened(0),
      // THROUGHPUT-1a deviation 3: the stream's first book events are changes
      // with no baseline in this process (ORDER_BOOK_NO_BASELINE_SNAPSHOT).
      yesChange(0.2, A1, "0.36", "50"),
      { eventType: "BookLevelChanged", payload: { internalMarketId: MARKET_ID, tokenId: NO_TOKEN, side: "BID", price: "0.58", size: "150" }, at: 0.3, session: A1 },
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      noSnapshot(1.1, A1),
    ]);
    expect(parts.trader.halts.records()).toEqual([]);
    expect(parts.trader.loop.bookRefusals()[MARKET_ID]).toEqual({ benign: 0, divergence: 2, waiting: [] });
    expect(entryMarkets(parts)).toEqual([MARKET_ID]);
  });

  it("another market keeps trading while one waits: market 1's book waits and its entry is refused, market 2 enters; market 1's next snapshot re-arms it", async () => {
    const options: ConfigOptions = { ...CHECK_8_ONLY, secondMarket: true };
    const waiting: Recorded[] = [
      tick(-2),
      marketOpened(0),
      marketTwoOpened(0.1),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      unstampedYesSnapshot(1.2),
      noSnapshot(1.3, A1),
      bookFor(MARKET_2, YES_TOKEN_2, 1.4, A1, CHEAP_YES_ASKS),
      bookFor(MARKET_2, NO_TOKEN_2, 1.5, A1, [{ price: "0.6", size: "200" }]),
      tick(2, "64001"),
    ];
    const during = await run(options, waiting);
    expect(during.trader.halts.anyHalt).toBe(false);
    expect(entryMarkets(during)).toEqual([MARKET_2]);
    expect(bookNotSynchronizedRefusals(during)).toBe(1);
    expect(during.trader.loop.bookRefusals()).toEqual({
      [MARKET_ID]: { benign: 0, divergence: 1, waiting: ["YES"] },
      [MARKET_2]: { benign: 0, divergence: 0, waiting: [] },
    });
    const after = await run(options, [...waiting, yesSnapshot(3, A1, CHEAP_YES_ASKS)]);
    expect(after.trader.loop.bookRefusals()[MARKET_ID]?.waiting).toEqual([]);
    expect(after.trader.halts.anyHalt).toBe(false);
  });

  it("r1 (L3): while a book waits, a superseded-generation REST snapshot does NOT re-arm it (a BENIGN drop); the current generation's snapshot does", async () => {
    const waiting: Recorded[] = [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      // A generation-2 change: a newer subscription, so the book waits.
      yesChange(1.2, A1_GEN2, "0.34", "120"),
      // The REST fetch for generation 1's gap, in flight before generation 2
      // began, lands now (the gateway publishes it before markResynchronized).
      yesSnapshot(1.5, undefined, CHEAP_YES_ASKS),
      noSnapshot(2, A1_GEN2),
    ];
    const during = await run(CHECK_8_ONLY, waiting);
    expect(during.trader.halts.anyHalt).toBe(false);
    expect(during.trader.loop.bookRefusals()[MARKET_ID]).toEqual({ benign: 1, divergence: 1, waiting: ["YES"] });
    expect(entryMarkets(during)).toEqual([]);
    expect(bookNotSynchronizedRefusals(during)).toBe(1);
    const after = await run(CHECK_8_ONLY, [...waiting, yesSnapshot(3, A1_GEN2, CHEAP_YES_ASKS)]);
    expect(after.trader.loop.bookRefusals()[MARKET_ID]?.waiting).toEqual([]);
    expect(after.trader.halts.anyHalt).toBe(false);
  });

  it("a BENIGN drop (a stale subscription generation) is counted only: the book stays synchronized and the entry goes out", async () => {
    const parts = await run(CHECK_8_ONLY, [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1_GEN2, CHEAP_YES_ASKS),
      // A late update from the superseded generation 1: rejected (§9.4), harmless.
      yesChange(1.2, A1, "0.34", "1"),
      noSnapshot(2, A1_GEN2),
    ]);
    expect(parts.trader.halts.anyHalt).toBe(false);
    expect(parts.trader.loop.bookRefusals()[MARKET_ID]).toEqual({ benign: 1, divergence: 0, waiting: [] });
    expect(parts.trader.markets.get(MARKET_ID)?.bookFor("YES").levels("ASK")[0]).toEqual({ price: "0.34", size: "100" });
    expect(entryMarkets(parts)).toEqual([MARKET_ID]);
  });

  it("a FAULT (a token that is neither of the market's two) still halts, as BOOK_DESYNCHRONIZED, and ends the run", async () => {
    const parts = await run(CHECK_8_ONLY, [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      yesChange(1.2, A1, "0.34", "1", MARKET_ID, "9999"),
      noSnapshot(2, A1),
    ]);
    expect(parts.trader.halts.records().map((halt) => [halt.scope, halt.code])).toEqual([
      [{ kind: "MARKET", marketId: MARKET_ID }, "BOOK_DESYNCHRONIZED"],
    ]);
    expect(parts.trader.halts.records()[0]?.detail).toContain("ORDER_BOOK_UNKNOWN_TOKEN");
    expect(entryMarkets(parts)).toEqual([]);
  });

  it("r1 (L2): a FAULT on one of the market's OWN tokens halts too — the class alone decides, not an unknown outcome", async () => {
    // Generation 0 passes the envelope's door (a non-negative integer) but not
    // the book's (generations start at 1): ORDER_BOOK_INGEST_META_INVALID, a
    // FAULT, on the YES token — so the outcome IS known.
    const generationZero: Session = { epoch: EPOCH_A, connectionId: "polymarket-market-a1", generation: 0 };
    const parts = await run(CHECK_8_ONLY, [
      tick(-2),
      marketOpened(0),
      yesSnapshot(1, A1, CHEAP_YES_ASKS),
      yesChange(1.2, generationZero, "0.34", "1"),
      noSnapshot(2, A1),
    ]);
    expect(parts.trader.halts.records().map((halt) => [halt.scope, halt.code])).toEqual([
      [{ kind: "MARKET", marketId: MARKET_ID }, "BOOK_DESYNCHRONIZED"],
    ]);
    expect(parts.trader.halts.records()[0]?.detail).toContain("ORDER_BOOK_INGEST_META_INVALID");
    // Not treated as a divergence: the YES book was not cleared to wait.
    expect(parts.trader.loop.bookRefusals()[MARKET_ID]).toMatchObject({ divergence: 0 });
    expect(entryMarkets(parts)).toEqual([]);
  });

  it("CONNECTION_CONFIRMED: a waiting book keeps no session, so sibling frames cannot vouch for it — it reads stale within its bound", async () => {
    // The quiet-YES timeline (NO changes on A1 every 500 ms keep A1 alive),
    // with the YES book refused an update at 1.200 s: from then on its age is
    // its last APPLIED change (1.000 s), however busy A1 stays.
    const events = [...quietYesTimeline()];
    events.splice(4, 0, unstampedYesSnapshot(1.2));
    const parts = await run({ basis: "CONNECTION_CONFIRMED" }, events);
    expect(parts.trader.halts.anyHalt).toBe(false);
    expect(evaluationAt(parts, 2.5).stale).toBe(false);
    expect(evaluationAt(parts, 3.5)).toMatchObject({ stale: true, bookAgeMs: "2500" });
    expect(evaluationAt(parts, 6.2)).toMatchObject({ stale: true, bookAgeMs: "5200" });
  });
});

/** A market-less incident as the gateway or an adapter publishes it. */
function feedIncident(at: number, input: { readonly reasonCode: string; readonly source: string; readonly feedId?: string }): Recorded {
  return {
    eventType: "DataQualityIncidentOpened",
    payload: {
      incidentId: `incident-${input.reasonCode}`,
      openedAt: iso(at),
      reasonCode: input.reasonCode,
      severity: "NOTIFY",
      ...(input.feedId === undefined ? {} : { feedId: input.feedId }),
    },
    at,
    source: input.source,
    epoch: EPOCH_A,
  };
}

/** The quiet-YES timeline with one market-less incident before the 6.200 s tick: is the book stale at 6.200 s? */
async function staleAfter(incident: Recorded, options: ConfigOptions = {}): Promise<boolean> {
  const events = [...quietYesTimeline()];
  events.splice(events.length - 1, 0, incident, noChange(6.1, A1, "999"));
  const parts = await run({ basis: "CONNECTION_CONFIRMED", ...options }, events);
  expect(evaluationAt(parts, 6).stale).toBe(false);
  return evaluationAt(parts, 6.2).stale;
}

describe("C1-HALTS TAINT: only the market channel's market-less incidents, or gateway-wide faults, taint the epoch (ruled NARROW 2026-10-08)", () => {
  beforeAll(() => {
    cadence = REPRODUCTION;
  });

  it("a Binance start notice (source binance, feedId binance-reference) does NOT taint", async () => {
    expect(
      await staleAfter(feedIncident(6.05, { reasonCode: "BINANCE_SUBSCRIPTION_START_NO_REPLAY", source: "binance", feedId: "binance-reference" })),
    ).toBe(false);
  });

  it("a Coinbase notice (source coinbase, no feedId) does NOT taint: the reference venue's source alone excludes it", async () => {
    expect(await staleAfter(feedIncident(6.05, { reasonCode: "COINBASE_TOP_OF_BOOK_UNCHANGED", source: "coinbase" }))).toBe(false);
  });

  it("an internal incident naming a REFERENCE feed (a Binance stall) does NOT taint", async () => {
    expect(await staleAfter(feedIncident(6.05, { reasonCode: "GATEWAY_FEED_STALL", source: "internal", feedId: "binance-reference" }))).toBe(false);
  });

  it("the routine no-op tick-size pair (UNASSIGNED_PARAMETER_VERSION on the market channel) does NOT taint", async () => {
    expect(
      await staleAfter(feedIncident(6.05, { reasonCode: "UNASSIGNED_PARAMETER_VERSION", source: "polymarket", feedId: "polymarket-market" })),
    ).toBe(false);
  });

  it("UNKNOWN_EVENT_TYPE on the Polymarket market channel DOES taint", async () => {
    expect(await staleAfter(feedIncident(6.05, { reasonCode: "UNKNOWN_EVENT_TYPE", source: "polymarket", feedId: "polymarket-market" }))).toBe(true);
  });

  it("an internal WAL refusal on the market channel DOES taint", async () => {
    expect(
      await staleAfter(feedIncident(6.05, { reasonCode: "GATEWAY_WAL_FRAME_REFUSED", source: "internal", feedId: "polymarket-market" })),
    ).toBe(true);
  });

  it("a gateway-wide fault with no feedId (a refused envelope) DOES taint", async () => {
    expect(await staleAfter(feedIncident(6.05, { reasonCode: "GATEWAY_ENVELOPE_REJECTED", source: "internal" }))).toBe(true);
  });

  it("the market-channel feed id is configurable: under another id, polymarket-market no longer taints and that id does", async () => {
    const options = { marketChannelFeedId: "polymarket-market-2" };
    expect(
      await staleAfter(feedIncident(6.05, { reasonCode: "UNKNOWN_EVENT_TYPE", source: "polymarket", feedId: "polymarket-market" }), options),
    ).toBe(false);
    expect(
      await staleAfter(feedIncident(6.05, { reasonCode: "UNKNOWN_EVENT_TYPE", source: "polymarket", feedId: "polymarket-market-2" }), options),
    ).toBe(true);
  });

  it("the configuration: the id defaults to polymarket-market, and a configured one is read as an own property", () => {
    const absent = parseTraderConfig(traderConfig({ basis: "CONNECTION_CONFIRMED" }));
    const configured = parseTraderConfig(traderConfig({ basis: "CONNECTION_CONFIRMED", marketChannelFeedId: "custom-market" }));
    const lastChange = parseTraderConfig(traderConfig({ basis: "LAST_CHANGE" }));
    expect(absent.ok && configured.ok && lastChange.ok).toBe(true);
    if (!absent.ok || !configured.ok || !lastChange.ok) return;
    expect(marketChannelFeedIdOf(absent.config)).toBe("polymarket-market");
    expect(marketChannelFeedIdOf(configured.config)).toBe("custom-market");
    expect(marketChannelFeedIdOf(lastChange.config)).toBe("polymarket-market");
    const malformed = parseTraderConfig(traderConfig({ basis: "CONNECTION_CONFIRMED", marketChannelFeedId: "not a code" }));
    expect(malformed.ok).toBe(false);
  });
});

describe("C1-HALTS DQ-CLOSE: a DataQualityIncidentClosed reaches the markets that hold it, and the strategy un-pauses", () => {
  beforeAll(() => {
    cadence = REPRODUCTION;
  });

  function closed(at: number, incidentId: string): Recorded {
    return {
      eventType: "DataQualityIncidentClosed",
      payload: { incidentId, closedAt: iso(at), resolutionCode: "GATEWAY_CONDITION_CLEARED" },
      at,
      source: "internal",
      epoch: EPOCH_A,
    };
  }

  const pausedByIncident = (): Recorded[] => [
    tick(-2),
    marketOpened(0),
    // A lifecycle poll failed: the gateway's market-scoped incident.
    { ...incident(0.5, "gw-lifecycle-1", [MARKET_ID]), payload: { incidentId: "gw-lifecycle-1", openedAt: iso(0.5), reasonCode: "GATEWAY_LIFECYCLE_POLL_FAILED", severity: "NOTIFY", feedId: "polymarket-lifecycle", affectedMarketIds: [MARKET_ID] } },
    yesSnapshot(1, A1, CHEAP_YES_ASKS),
    noSnapshot(1.1, A1),
    tick(1.5, "64001"),
  ];

  it("while the incident is open the market does not enter; the close (routed by incidentId) un-pauses it and the entry goes out", async () => {
    const open = await run(CHECK_8_ONLY, pausedByIncident());
    expect(entryMarkets(open)).toEqual([]);
    expect(open.trader.markets.get(MARKET_ID)?.activeIncidents().map((held) => held.incidentId)).toEqual(["gw-lifecycle-1"]);

    const after = await run(CHECK_8_ONLY, [...pausedByIncident(), closed(2, "gw-lifecycle-1"), noChange(2.5, A1, "201"), tick(3, "64002")]);
    expect(after.trader.markets.get(MARKET_ID)?.activeIncidents()).toEqual([]);
    expect(entryMarkets(after)).toEqual([MARKET_ID]);
  });

  it("a close for an incident no market holds changes nothing", async () => {
    const parts = await run(CHECK_8_ONLY, [...pausedByIncident(), closed(2, "gw-other-7"), noChange(2.5, A1, "201"), tick(3, "64002")]);
    expect(parts.trader.markets.get(MARKET_ID)?.activeIncidents().map((held) => held.incidentId)).toEqual(["gw-lifecycle-1"]);
    expect(entryMarkets(parts)).toEqual([]);
  });
});
