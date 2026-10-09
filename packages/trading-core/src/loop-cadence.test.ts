/**
 * `CADENCE-1` — ADR-026 in the REAL core loop: at most one `onFeatures`
 * evaluation per market per `evaluationIntervalMs` of event time, plus a
 * heartbeat, every other callback in place.
 *
 * The harness is `createPaperTrader`'s assembly with a RECORDING strategy
 * double in place of Static Bracket, so what is pinned is WHICH callbacks the
 * loop invokes, at which source event and instant — not what a strategy
 * decides. Two markets, A then B in the configured order, one instance each.
 * Every record is read through the runtime's own `evaluate` (spied) and the
 * store the outbox drains into.
 *
 * Work-plan acceptance, test by test (each `describe` names its criterion):
 *
 * 1. D4 — fill, order-update and lifecycle callbacks fire exactly as before,
 *    and the loop has no start/stop/timer producer under either cadence;
 * 2. D5 — a coalesced market is not evaluated and persists nothing; every
 *    invoked callback persists exactly one decision;
 * 3. D6 — the same events give byte-identical decisions; no clock is read;
 * 4. D2.1/D2.8 — the high-water mark; a backward step neither adds nor stops
 *    an evaluation;
 * 6. D2.1/D3.2-D3.3 — refused events never move the clock or source an
 *    evaluation; carried and heartbeat evaluations take the frame's last
 *    APPLIED event; a frame with none evaluates nothing;
 * 7. D2.12 — owed first, in ADR-024 D3's order, then carried and heartbeat
 *    evaluations in configured order, in one close;
 * 8. the ADR-024 D3 one-event row — callbacks in place, `onFeatures` by the
 *    cadence;
 * 9. D2.10 — a forward jump: the hold, its end, the alarm.
 *
 * (5, the policy, is `cadence.test.ts` and the composition roots' tests; 10
 * and 11 are the control API's and the run record's; 12 is
 * `apps/backtest-cli/src/cadence-one-code-path.test.ts`.)
 *
 * `CADENCE-1` r1 adds, each against a finding of the round-1 review:
 *
 * - J2 — a market's `last` moves only when a runtime was asked: an attempt
 *   with no snapshot is no evaluation (the market stays owed), and a market
 *   whose every instance is halted is not evaluated (its owed evaluation is
 *   dropped);
 * - J1 — the harvest points are ADR-024's: the cadence adds none, moves none
 *   and re-stamps none (r1 delivered a carried-over or heartbeat evaluation's
 *   own effects at the NEXT harvest point; r2 replaces that, below);
 * - O02, O04, O05 — the coalescence count over a longer frame, a lifecycle
 *   event at a carried market, and `[A, A]` under the per-frame value 0.
 *
 * `CADENCE-1` r2 adds, each against a finding of the round-2 review:
 *
 * - RA — a carried-over or heartbeat evaluation whose source is not at its
 *   close's harvest instant has its OWN fills and order views (the orders it
 *   placed or cancelled) booked and delivered at once, at its source's
 *   instant: repeated heartbeats see the position, the end of input loses
 *   nothing, and every other fill and view keeps its ADR-024 harvest point;
 * - RB — a runtime refusal for a cause that can pass (`CLOCK_INVALID`) is no
 *   evaluation; a refusal for good (`INSTANCE_PAUSED`) is;
 * - RC — a market whose every instance is halted has its owed evaluation
 *   dropped before the cadence is asked, also when it is not yet due.
 *
 * `CADENCE-1` r3 adds, each against a finding of the round-3 review — the
 * carried harvest (`#harvestCarriedEffects`) gives its `onFill` decisions what
 * the ORDINARY harvest gives them, compared run against run (the same
 * heartbeat, its close's source an event of A or of X):
 *
 * - A-R3-01 — its settled order's reservation is released BEFORE `onFill`, so
 *   a covered take-profit SELL is admitted under a tight cap on both paths;
 * - A-R3-02 — an order an `onFill` decision places has its view at the same
 *   close (resting, filled at once, or partly filled at once), with the same
 *   release; its immediate fill keeps its ADR-024 harvest point on both paths;
 * - O-R3-02 — the end-of-input closes flush AFTER the carried harvest (every
 *   invocation's decision is in the store), and a placement the venue booked
 *   only IN PART is still the pass's own;
 * - O-R3-03 — each of the runtime's six refusal codes, scripted at the spy,
 *   is classified as the loop's `REFUSAL_PERSISTENCE` table says.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  tokenBucketRateLimits,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type RateLimitBudget,
  type VenueRetentionBounds,
} from "@polymarket-bot/simulation";
import {
  createStrategyInstanceRuntime,
  type EvaluationInput,
  type EvaluationOutcome,
  type EvaluationRefusalCode,
} from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import {
  PAPER_EVALUATION_CADENCE,
  PER_FRAME_EVALUATION_CADENCE,
  type CadenceAlarm,
  type EvaluationCadenceOption,
} from "./cadence.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import { EVERY_FILL_ACCOUNTING_CHECKS } from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer } from "./loop.js";
import { MarketState } from "./market-state.js";
import type { Clock, IngestedEvent } from "./ports.js";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "./safety.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";
import { formatStrictUtc } from "./time.js";

const MARKET_A = "018f5c20-1000-7a10-8b00-0000000000c1";
const MARKET_B = "018f5c20-1000-7a10-8b00-0000000000c2";
/** A market this trader does not run: its events are applied and owe nothing. */
const MARKET_X = "018f5c20-1000-7a10-8b00-0000000000c9";
const TOKENS = {
  [MARKET_A]: { yes: "8101", no: "8102" },
  [MARKET_B]: { yes: "8201", no: "8202" },
  [MARKET_X]: { yes: "8901", no: "8902" },
} as const;
const INSTANCE_A = "e18f5c20-2000-7a20-8b00-0000000000c1";
const INSTANCE_B = "e18f5c20-2000-7a20-8b00-0000000000c2";
/** `CADENCE-1` r1: a SHADOW instance on market A, registered only with `shadowOnA`. */
const INSTANCE_A2 = "e18f5c20-2000-7a20-8b00-0000000000c3";
const RUN_A = "018f5c20-3000-7a30-8b00-0000000000c1";
const RUN_B = "018f5c20-3000-7a30-8b00-0000000000c2";
const RUN_A2 = "018f5c20-3000-7a30-8b00-0000000000c3";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000000c0";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-0000000000c5";
const T0_MS = Date.parse("2026-05-01T09:00:00.000Z");
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-02T09:00:00.000Z";
const PER_FRAME: EvaluationCadenceOption = { ...PER_FRAME_EVALUATION_CADENCE, reproduces: "cadence-1:loop-cadence.test.ts" };

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "cadence1.sim.2026-05-01",
    takerFeeRate: "0",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

function marketDocument(marketId: string, tokens: { readonly yes: string; readonly no: string }): Record<string, unknown> {
  return {
    marketId,
    conditionId: `0xcadence1${marketId.slice(-2)}`,
    yesTokenId: tokens.yes,
    noTokenId: tokens.no,
    tickSize: "0.01",
    minimumOrderSize: "5",
    makerFeeRate: "0",
    takerFeeRate: "0",
    parametersVersion: 1,
    settlementReadiness: { modelDependentActivationAllowed: true },
    openTime: T_OPEN,
    closeTime: T_CLOSE,
    seriesKey: "cadence1-sim",
    underlyingKey: "SIMBTC",
    resolutionWindowKey: "w2026-05-02T09.00",
  };
}

function traderConfig(perStrategyCap = "1000", globalAccountCap = "10000"): Record<string, unknown> {
  return {
    environment: "PAPER",
    riskPolicy: {
      freshness: { venueBookMaxAgeMs: 600_000, referenceFeedMaxAgeMs: 600_000, featuresMaxAgeMs: 600_000 },
      limits: { maxWorstCaseContractualLoss: "1000" },
      scenario: { maxScenarioLoss: "1000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 0 },
      timeToClose: { entryCutoffSeconds: 30 },
    },
    allocatorCaps: {
      globalAccountCap,
      perStrategyCap,
      liveMicroMaxOrderNotional: "0",
      liveMicroMaxAccountExposure: "0",
    },
    accounting: {
      accountRef: "cadence1-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "cadence1-venue-clearing",
      attributionClearingRef: "cadence1-attribution-clearing",
      feeExpenseRef: "cadence1-fee-expense",
      startingCash: "1000",
    },
    queues: { ingestMaximumDepth: 1024, outboxMaximumDepth: 1024 },
    features: {
      depthLevels: [1, 2, 5],
      executableShares: ["10"],
      tradeWindowMs: 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    planning: {
      maxSliceShares: "10",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.cadence1",
      fillModelParametersHash: "c".repeat(64),
      feeSchedule: { ...feeSnapshot() },
      startingCash: "1000",
    },
    requestBudget: { capacity: 1_000_000, windowMs: 60_000 },
    scenarios: [
      { scenarioId: "spot.down", kind: "SPOT", yesPriceShock: "-0.1" },
      { scenarioId: "vol.up", kind: "VOLATILITY", yesPriceShock: "-0.05" },
      { scenarioId: "time.decay", kind: "TIME", yesPriceShock: "-0.02" },
      { scenarioId: "liq.thin", kind: "LIQUIDITY", yesPriceShock: "-0.03" },
    ],
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "cadence-1",
      receiveBatchSize: 128,
      retentionMaxEvents: 100_000,
    },
    markets: [marketDocument(MARKET_A, TOKENS[MARKET_A]), marketDocument(MARKET_B, TOKENS[MARKET_B])],
    instances: [
      { instanceId: INSTANCE_A, runId: RUN_A, configId: CONFIG_ID, runSeed: "7", marketId: MARKET_A, ownership: "OWNER", evaluationPriority: 0, evaluationBudgetUs: 5_000_000, params: {} },
      { instanceId: INSTANCE_B, runId: RUN_B, configId: CONFIG_ID, runSeed: "7", marketId: MARKET_B, ownership: "OWNER", evaluationPriority: 0, evaluationBudgetUs: 5_000_000, params: {} },
    ],
  };
}

function hold(ctx: StrategyContext): DecisionResult {
  return { decisionType: "hold", reasonCodes: ["CADENCE1.HOLD"], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
}

/**
 * `CADENCE-1` r1: an `onFeatures` evaluation at instant `at` places one order
 * — a resting maker BUY (10 YES at 0.30), or with `immediate` a taker BUY that
 * fills at once against the 0.34 ask — so a carried-over or heartbeat
 * evaluation's OWN effects can be followed to the harvest that delivers them.
 * r2: `at` may list several instants; each places one order.
 * r3: `slices` places `slices` × 10 shares instead — one plan of that many
 * 10-share orders (`planning.maxSliceShares`), at the same limit price.
 */
interface PlaceOnFeatures {
  readonly market: string;
  readonly at: string | readonly string[];
  readonly immediate: boolean;
  readonly slices?: number;
}

/**
 * `CADENCE-1` r2 (RA): one market's callback acts at one instant —
 * `cancelOnFeatures`: its `onFeatures` emits a market-scope CANCEL;
 * `placeOnFill`: its `onFill` places a taker BUY that fills at once (with
 * `restsRemainder`, a GTC one: what the book cannot fill RESTS).
 * r3 (A-R3-01, A-R3-02): with `sells`, `onFill` instead places a COVERED
 * resting SELL of the whole position (GTC, maker only, at 0.36) — Static
 * Bracket's take-profit shape (`planTakeProfit`).
 */
interface ActAt {
  readonly market: string;
  readonly at: string;
  readonly restsRemainder?: boolean;
  readonly sells?: boolean;
}

/**
 * The recording double: holds everywhere, except that — when `placeOnOpen` —
 * `onMarketOpen` places ONE resting maker BUY (10 YES at 0.30). Placing from a
 * LIFECYCLE callback, which fires in place under every cadence, gives both
 * cadences the same order at the same event, so what follows from it (order
 * views, the fill) can be compared one to one. With `onFeaturesAt`, its
 * `onFeatures` places one order at that instant ({@link PlaceOnFeatures}).
 */
function recordingStrategy(
  marketId: string,
  placeOnOpen: boolean,
  onFeaturesAt?: PlaceOnFeatures,
  acts: {
    readonly cancelAt?: string;
    readonly placeOnFillAt?: string;
    readonly placeOnFillResting?: boolean;
    readonly placeOnFillSells?: boolean;
    readonly cancelOnFillAt?: string;
    readonly throwAt?: string;
  } = {},
): Strategy<unknown, Record<string, never>> {
  const placeAt = onFeaturesAt === undefined ? [] : typeof onFeaturesAt.at === "string" ? [onFeaturesAt.at] : onFeaturesAt.at;
  const buy = (ctx: StrategyContext, intentId: string, immediate: boolean, restsRemainder = false, slices = 1): Intent => ({
    type: "POSITION",
    intentId,
    marketId,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: String(10 * slices),
    maximumBuyPrice: immediate ? "0.35" : "0.3",
    maximumTotalCost: String((immediate ? 4 : 3) * slices),
    urgency: immediate ? "IMMEDIATE" : "PASSIVE",
    liquidityPreference: immediate ? "TAKER_OK" : "MAKER_ONLY",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: new Date(Date.parse(ctx.now()) + 600_000).toISOString(),
    expectedNetEdge: "5",
    tags: ["cadence1.entry", immediate && !restsRemainder ? "sb.order-type:FAK" : "sb.order-type:GTC"],
  });
  return {
    name: "cadence1-recording-double",
    version: "1.0.0",
    paramsSchema: z.strictObject({}),
    stateSchemaVersion: 1,
    onStart: hold,
    onTimer: hold,
    onStop: hold,
    onFeatures(ctx: StrategyContext): DecisionResult {
      if (acts.throwAt !== undefined && ctx.now() === acts.throwAt) {
        throw new Error("cadence1: this onFeatures fails, so the runtime contains it and PAUSES the instance");
      }
      if (acts.cancelAt !== undefined && ctx.now() === acts.cancelAt) {
        return {
          decisionType: "exit",
          reasonCodes: ["CADENCE1.CANCEL"],
          featureSnapshotRef: ctx.features().snapshotRef,
          intents: [{ type: "CANCEL", marketId, reason: "cadence1: cancel this market's working orders" }],
        };
      }
      const index = placeAt.indexOf(ctx.now());
      if (onFeaturesAt === undefined || index < 0) return hold(ctx);
      return {
        decisionType: "enter",
        reasonCodes: ["CADENCE1.PLACE"],
        featureSnapshotRef: ctx.features().snapshotRef,
        intents: [
          buy(
            ctx,
            index === 0 ? "cadence1-features-buy" : `cadence1-features-buy-${String(index)}`,
            onFeaturesAt.immediate,
            false,
            onFeaturesAt.slices,
          ),
        ],
      };
    },
    onFill(ctx: StrategyContext): DecisionResult {
      if (acts.cancelOnFillAt !== undefined && ctx.now() === acts.cancelOnFillAt) {
        return {
          decisionType: "exit",
          reasonCodes: ["CADENCE1.CANCEL"],
          featureSnapshotRef: ctx.features().snapshotRef,
          intents: [{ type: "CANCEL", marketId, reason: "cadence1: an onFill decision cancels this market's working orders" }],
        };
      }
      if (acts.placeOnFillAt === undefined || ctx.now() !== acts.placeOnFillAt) return hold(ctx);
      if (acts.placeOnFillSells === true) {
        // r3: a covered take-profit — sell the whole position, resting.
        return {
          decisionType: "enter",
          reasonCodes: ["CADENCE1.TAKE_PROFIT"],
          featureSnapshotRef: ctx.features().snapshotRef,
          intents: [
            {
              type: "POSITION",
              intentId: "cadence1-fill-sell",
              marketId,
              direction: "YES",
              targetMode: "ABSOLUTE",
              targetShares: "0",
              minimumSellPrice: "0.36",
              urgency: "PASSIVE",
              liquidityPreference: "MAKER_ONLY",
              partialFillPolicy: "ACCEPT_ANY",
              validUntil: new Date(Date.parse(ctx.now()) + 600_000).toISOString(),
              tags: ["cadence1.take-profit", "sb.order-type:GTC"],
            },
          ],
        };
      }
      return {
        decisionType: "enter",
        reasonCodes: ["CADENCE1.PLACE"],
        featureSnapshotRef: ctx.features().snapshotRef,
        intents: [buy(ctx, "cadence1-fill-buy", true, acts.placeOnFillResting === true)],
      };
    },
    onOrderUpdate: (ctx: StrategyContext) => hold(ctx),
    onMarketClosing: (ctx: StrategyContext) => hold(ctx),
    onMarketResolved: (ctx: StrategyContext) => hold(ctx),
    onMarketOpen(ctx: StrategyContext): DecisionResult {
      if (!placeOnOpen) return hold(ctx);
      return {
        decisionType: "enter",
        reasonCodes: ["CADENCE1.PLACE"],
        featureSnapshotRef: ctx.features().snapshotRef,
        intents: [buy(ctx, "cadence1-resting-buy", false)],
      };
    },
  };
}

/** One recorded invocation of the runtime. */
interface Seen {
  readonly instanceId: string;
  readonly callback: string;
  readonly evaluatedAt: string;
  readonly source: string | undefined;
}

/**
 * `CADENCE-1` r2 (RA): what the same invocation was SHOWN — its position's
 * YES shares and, for `onOrderUpdate`, the order's status — kept beside
 * `seen` (the same index) so every existing comparison of `seen` is unchanged.
 */
interface Shown {
  readonly yesShares: string;
  readonly orderStatus: string | undefined;
}

interface Harness {
  readonly loop: CoreLoop;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly halts: HaltController;
  readonly seen: Seen[];
  /** `CADENCE-1` r2: what each invocation in `seen` was shown, at the same index. */
  readonly shown: Shown[];
  readonly alarms: CadenceAlarm[];
}

interface HarnessOptions {
  readonly cadence: EvaluationCadenceOption;
  readonly placeOnOpen?: boolean;
  readonly clock?: Clock;
  /** `CADENCE-1` r1: one market's `onFeatures` places an order at one instant. */
  readonly placeOnFeatures?: PlaceOnFeatures;
  /** `CADENCE-1` r1 (J2): a second, SHADOW, instance on market A ("A2"), after A's own in §8.2 order. */
  readonly shadowOnA?: boolean;
  /** `CADENCE-1` r2 (RA): one market's `onFeatures` cancels its working orders at one instant. */
  readonly cancelOnFeatures?: ActAt;
  /** `CADENCE-1` r2 (RA): one market's `onFill` places a taker BUY at one instant. */
  readonly placeOnFill?: ActAt;
  /** `CADENCE-1` r3 (A-R3-02): one market's `onFill` cancels its working orders at one instant. */
  readonly cancelOnFill?: ActAt;
  /** `CADENCE-1` r2 (RB): one market's `onFeatures` throws at one instant (contained; the instance PAUSES). */
  readonly throwOnFeatures?: ActAt;
  /** `CADENCE-1` r2 (RA): the venue's history bounds (SIM-2). */
  readonly venueRetention?: VenueRetentionBounds;
  /** `CADENCE-1` r3 (A-R3-01): the allocator's per-strategy cap, in pUSD (default 1,000). */
  readonly perStrategyCap?: string;
  /** `TC-LOWS-1` (CAD1-R4-01, MZ8): the allocator's global account cap, in pUSD (default 10,000). */
  readonly globalAccountCap?: string;
  /** `CADENCE-1` r3 (O-R3-02): the venue's order budget (default: none modelled). */
  readonly rateLimits?: RateLimitBudget;
  /**
   * `CADENCE-1` r3 (O-R3-03): one market's OWNER runtime answers its
   * `onFeatures` at one instant `REFUSED` with this code, without invoking the
   * callback — the runtime's refusal vocabulary, each code as it would come.
   */
  readonly refuseOnFeatures?: { readonly market: string; readonly at: string; readonly code: EvaluationRefusalCode };
}

/** `createPaperTrader`'s assembly, with the recording double's runtimes registered. */
function assemble(options: HarnessOptions): Harness {
  const parsed = parseTraderConfig(traderConfig(options.perStrategyCap, options.globalAccountCap));
  if (!parsed.ok) throw new Error(`config refused: ${parsed.refusal.detail} ${parsed.refusal.issues.join("; ")}`);
  const config = parsed.config;
  const policy = parseRiskPolicy(config.riskPolicy);
  if (!policy.ok) throw new Error("risk policy refused");
  const caps = parseAllocatorCaps(config.allocatorCaps);
  if (!caps.ok) throw new Error("allocator caps refused");
  const clock = options.clock ?? new ManualClock(T_OPEN);
  const markets = new Map<string, MarketState>();
  const tokenAssetIds = new Map<string, string>();
  const allocationMarkets = new Map<string, AllocationMarket>();
  for (const market of config.markets) {
    markets.set(market.marketId, new MarketState({ config: market, tradeWindowMs: config.features.tradeWindowMs, maximumTrades: 512 }));
    tokenAssetIds.set(`${market.marketId}|YES`, `token:${market.yesTokenId}`);
    tokenAssetIds.set(`${market.marketId}|NO`, `token:${market.noTokenId}`);
    allocationMarkets.set(market.marketId, allocationMarketOf(market));
  }
  const outbox = new DecisionOutboxBuffer(config.queues.outboxMaximumDepth);
  const registry = new InstanceRegistry();
  const seen: Seen[] = [];
  const shown: Shown[] = [];
  const instances: (readonly [string, string, string, "OWNER" | "SHADOW", number])[] = [
    [INSTANCE_A, RUN_A, MARKET_A, "OWNER", 0],
    [INSTANCE_B, RUN_B, MARKET_B, "OWNER", 0],
  ];
  if (options.shadowOnA === true) instances.push([INSTANCE_A2, RUN_A2, MARKET_A, "SHADOW", 1]);
  for (const [instanceId, runId, marketId, ownership, evaluationPriority] of instances) {
    const created = createStrategyInstanceRuntime({
      strategy: recordingStrategy(
        marketId,
        options.placeOnOpen === true && instanceId === INSTANCE_A,
        options.placeOnFeatures?.market === marketId && ownership === "OWNER" ? options.placeOnFeatures : undefined,
        ownership !== "OWNER"
          ? {}
          : {
              ...(options.cancelOnFeatures?.market === marketId ? { cancelAt: options.cancelOnFeatures.at } : {}),
              ...(options.placeOnFill?.market === marketId
                ? {
                    placeOnFillAt: options.placeOnFill.at,
                    placeOnFillResting: options.placeOnFill.restsRemainder === true,
                    placeOnFillSells: options.placeOnFill.sells === true,
                  }
                : {}),
              ...(options.cancelOnFill?.market === marketId ? { cancelOnFillAt: options.cancelOnFill.at } : {}),
              ...(options.throwOnFeatures?.market === marketId ? { throwAt: options.throwOnFeatures.at } : {}),
            },
      ),
      params: {},
      run: { runId, instanceId, configId: CONFIG_ID, runSeed: "7" },
      watchdog: { evaluationBudgetUs: 5_000_000 },
      clock: { nowNs: () => clock.monotonicNs() },
      decisionSink: { persist: (record, telemetry) => outbox.appendDecision(record, telemetry) },
      checkpointStore: { save: (checkpoint) => outbox.appendCheckpoint(checkpoint) },
    });
    if (!created.ok) throw new Error(`runtime refused: ${created.refusal.detail}`);
    const evaluate = created.runtime.evaluate.bind(created.runtime);
    const refusal = options.refuseOnFeatures;
    vi.spyOn(created.runtime, "evaluate").mockImplementation((input: EvaluationInput): EvaluationOutcome => {
      seen.push({
        instanceId,
        callback: input.callback,
        evaluatedAt: input.evaluatedAt,
        source: input.sourceEvent?.eventId,
      });
      shown.push({
        yesShares: input.position.yesShares,
        orderStatus: input.callback === "onOrderUpdate" ? input.order.status : undefined,
      });
      if (
        refusal !== undefined &&
        refusal.market === marketId &&
        ownership === "OWNER" &&
        input.callback === "onFeatures" &&
        input.evaluatedAt === refusal.at
      ) {
        return { kind: "REFUSED", refusal: { code: refusal.code, detail: "cadence1: a scripted runtime refusal" } };
      }
      return evaluate(input);
    });
    const registered = registry.register({
      instanceId,
      runId,
      configId: CONFIG_ID,
      marketId,
      ownership,
      evaluationPriority,
      runtime: created.runtime,
      direction: "YES",
      params: {},
      immediateOrderType: "FAK",
      submissionUnknownAfterMs: 5_000,
    });
    if (!registered.ok) throw new Error(registered.detail);
  }
  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error("fees refused");
  const wiring: { loop: CoreLoop | undefined } = { loop: undefined };
  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.cadence1", fillModelParametersHash: "c".repeat(64) }),
    feeSnapshot: fees.value,
    rateLimits: options.rateLimits ?? unmodeledRateLimits("no venue rate-limit budget is modelled in this test"),
    policy: {
      timeInForceFor(order) {
        const resolved = wiring.loop?.timeInForceFor(order.plannedOrderId);
        if (resolved === undefined) throw new Error(`no time-in-force for ${order.plannedOrderId}`);
        return resolved;
      },
      statedExpiryNsFor: () => undefined,
      sameInstantAdditionsFor: () => "NOT_OBSERVED" as const,
    },
    startingCash: "1000",
    ...(options.venueRetention === undefined ? {} : { retention: options.venueRetention }),
    books: {
      book(request): BookView | undefined {
        const market = markets.get(request.marketId);
        if (market === undefined) return undefined;
        return {
          internalMarketId: request.marketId,
          tokenId: request.side === "YES" ? market.config.yesTokenId : market.config.noTokenId,
          top() {
            const top = market.bookFor(request.side).topOfBook();
            return {
              ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
              ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
              ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
              ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
              ...(top.spread === undefined ? {} : { spread: top.spread }),
            };
          },
          ladder(side) {
            return market.bookFor(request.side).levels(side).map((level) => ({ price: level.price, size: level.size }));
          },
        };
      },
    },
  });
  const posting: PostingIdentity = {
    environment: config.environment,
    accountRef: config.accounting.accountRef,
    denominationAssetId: config.accounting.denominationAssetId,
    venueClearingRef: config.accounting.venueClearingRef,
    attributionClearingRef: config.accounting.attributionClearingRef,
    feeExpenseRef: config.accounting.feeExpenseRef,
  };
  const store = new MemoryTraderStore();
  const halts = new HaltController();
  const alarms: CadenceAlarm[] = [];
  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator: new AllocatorGate({ caps: caps.value, markets: allocationMarkets, tokenAssetIds }),
    clock,
    venue,
    store,
    registry,
    markets,
    instanceConfigs: new Map(),
    ledger: Ledger.empty(config.environment),
    ids: new DeterministicIdFactory("cadence-1"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts,
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
    evaluationCadence: options.cadence,
    onCadenceAlarm: (alarm) => alarms.push(alarm),
  });
  wiring.loop = loop;
  return { loop, venue, store, halts, seen, shown, alarms };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let ordinal = 0;

/** One envelope at `offsetMs` after T0. `frame` stamps a shared causationId (one venue frame). */
function event(
  offsetMs: number,
  eventType: string,
  payload: unknown,
  options: { readonly source?: "polymarket" | "binance"; readonly frame?: string } = {},
): IngestedEvent {
  ordinal += 1;
  const receivedAt = new Date(T0_MS + offsetMs).toISOString();
  const wire: EventEnvelope<unknown> = {
    eventId: `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`,
    eventType,
    schemaVersion: 1,
    source: options.source ?? "polymarket",
    sourceChannel: "market",
    receivedAt,
    receivedMonotonicNs: String(ordinal * 1_000_000),
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ordinal),
    subscriptionGeneration: 1,
    ...(options.frame === undefined ? {} : { causationId: `raw:${GATEWAY_EPOCH}:${options.frame}` }),
    payload,
  };
  return { envelope: wire, identity: { gatewayEpoch: GATEWAY_EPOCH, ingestSeq: String(ordinal), receivedAt, datasetRowOrdinal: ordinal } };
}

function idOf(ingested: IngestedEvent): string {
  return (ingested.envelope as { readonly eventId: string }).eventId;
}

/** The loop's own strict-UTC form of an offset's instant (whole seconds carry no fraction). */
function iso(offsetMs: number): string {
  return formatStrictUtc(T0_MS + offsetMs);
}

const reference = (offsetMs: number, frame?: string): IngestedEvent =>
  event(offsetMs, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, {
    source: "binance",
    ...(frame === undefined ? {} : { frame }),
  });

const snapshot = (offsetMs: number, marketId: string, outcome: "yes" | "no", frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "BookSnapshot",
    {
      internalMarketId: marketId,
      tokenId: TOKENS[marketId as keyof typeof TOKENS][outcome],
      bids: [{ price: "0.32", size: "500" }],
      asks: [{ price: "0.34", size: "500" }],
    },
    frame === undefined ? {} : { frame },
  );

const level = (offsetMs: number, marketId: string, price: string, frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "BookLevelChanged",
    { internalMarketId: marketId, tokenId: TOKENS[marketId as keyof typeof TOKENS].yes, side: "BID", price, size: "100" },
    frame === undefined ? {} : { frame },
  );

/** `CADENCE-1` r2: one ASK level of the market's YES book (the venue fills a taker BUY against it). */
const askLevel = (offsetMs: number, marketId: string, price: string, size: string): IngestedEvent =>
  event(offsetMs, "BookLevelChanged", {
    internalMarketId: marketId,
    tokenId: TOKENS[marketId as keyof typeof TOKENS].yes,
    side: "ASK",
    price,
    size,
  });

const opened = (offsetMs: number, marketId: string): IngestedEvent =>
  event(offsetMs, "MarketOpened", { internalMarketId: marketId, conditionId: `0xcadence1${marketId.slice(-2)}`, openedAt: T_OPEN });

const closing = (offsetMs: number, marketId: string): IngestedEvent =>
  event(offsetMs, "MarketClosing", { internalMarketId: marketId, conditionId: `0xcadence1${marketId.slice(-2)}`, closesAt: T_CLOSE });

const resolved = (offsetMs: number, marketId: string): IngestedEvent =>
  event(offsetMs, "MarketResolved", {
    internalMarketId: marketId,
    conditionId: `0xcadence1${marketId.slice(-2)}`,
    outcome: "YES_WIN",
    resolvedAt: new Date(T0_MS + offsetMs).toISOString(),
  });

const trade = (offsetMs: number, marketId: string, price: string, frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "PublicTradeObserved",
    {
      internalMarketId: marketId,
      tokenId: TOKENS[marketId as keyof typeof TOKENS].yes,
      price,
      size: "50",
      takerSide: "ASK",
    },
    frame === undefined ? {} : { frame },
  );

/** An event type the loop does not consume: REFUSED (counted, no halt), never applied. */
const refused = (offsetMs: number, frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "ReferenceTopOfBookChanged",
    { venue: "binance", symbol: "BTCUSDT", bidPrice: "63999", bidSize: "1", askPrice: "64001", askSize: "1" },
    { source: "binance", ...(frame === undefined ? {} : { frame }) },
  );

/** Delivers each group to one drain (a group is a batch the feed hands out). */
async function feed(harness: Harness, ...batches: readonly (IngestedEvent | readonly IngestedEvent[])[]): Promise<void> {
  for (const batch of batches) {
    for (const ingested of Array.isArray(batch) ? batch : [batch as IngestedEvent]) {
      if (!harness.loop.ingest(ingested)) throw new Error("ingest refused");
    }
    await harness.loop.drain();
  }
}

/** An instance's short name in these tests: "A", "B", or "A2" (A's SHADOW instance). */
function label(instanceId: string): string {
  return instanceId === INSTANCE_A ? "A" : instanceId === INSTANCE_B ? "B" : "A2";
}

/** The `onFeatures` invocations since `from`, as `[instance, source event, evaluatedAt]`. */
function featureCalls(harness: Harness, from = 0): [string, string | undefined, string][] {
  return harness.seen
    .slice(from)
    .filter((entry) => entry.callback === "onFeatures")
    .map((entry) => [label(entry.instanceId), entry.source, entry.evaluatedAt]);
}

/**
 * A reference trade, then both markets' books, all at 0 ms, then a reference
 * trade at {@link S}.
 *
 * - The trade at 0 owes both markets an evaluation, but neither has a book, so
 *   no snapshot can be computed and no runtime is asked: NOT an evaluation
 *   (r1, J2). Both stay owed, with no `last`.
 * - A's YES book evaluates A at 0 ms; B, still owed, is tried again by the
 *   carried pass and still has no book. A's NO book is coalesced (+1).
 * - B's YES book evaluates B at 0 ms; A, carried, is coalesced (+1). B's NO
 *   book is coalesced (+1), and A again (+1): 4 coalescences.
 * - The trade at {@link S} evaluates both.
 *
 * After this, `last` is {@link S} for both markets and nothing is owed.
 */
function opening(): IngestedEvent[] {
  return [
    reference(0),
    snapshot(0, MARKET_A, "yes"),
    snapshot(0, MARKET_A, "no"),
    snapshot(0, MARKET_B, "yes"),
    snapshot(0, MARKET_B, "no"),
    reference(S),
  ];
}

/** Where {@link opening} leaves both markets: evaluated at this offset, nothing owed. */
const S = 1_000;

// ---------------------------------------------------------------------------

describe("acceptance 1, ADR-026 D4: every callback but onFeatures fires exactly as before", () => {
  /**
   * One scenario, every event touching a configured market or the reference
   * feed, so ADR-024's harvest points are fixed by the events alone: lifecycle
   * callbacks in place, an order placed from `onMarketOpen`, its WORKING view
   * at every harvest, its fill from a public trade, its terminal view.
   */
  function scenario(): IngestedEvent[] {
    ordinal = 0;
    const events = [
      reference(0),
      snapshot(10, MARKET_A, "yes"),
      snapshot(20, MARKET_A, "no"),
      snapshot(30, MARKET_B, "yes"),
      snapshot(40, MARKET_B, "no"),
      opened(100, MARKET_A),
      opened(150, MARKET_B),
    ];
    for (let offset = 200; offset <= 2_400; offset += 100) {
      events.push(level(offset, offset % 200 === 0 ? MARKET_A : MARKET_B, "0.31"));
    }
    events.push(trade(2_500, MARKET_A, "0.29"));
    for (let offset = 2_600; offset <= 2_900; offset += 100) events.push(level(offset, MARKET_A, "0.31"));
    events.push(closing(3_000, MARKET_A), reference(3_050), resolved(3_100, MARKET_A), level(3_200, MARKET_B, "0.31"));
    return events;
  }

  async function run(cadence: EvaluationCadenceOption): Promise<Harness> {
    const harness = assemble({ cadence, placeOnOpen: true });
    for (const ingested of scenario()) await feed(harness, ingested);
    return harness;
  }

  it("the same fills, order updates and lifecycle callbacks, at the same events and instants, under both cadences", async () => {
    const perFrame = await run(PER_FRAME);
    const paper = await run(PAPER_EVALUATION_CADENCE);
    const others = (harness: Harness) => harness.seen.filter((entry) => entry.callback !== "onFeatures");
    expect(others(paper)).toEqual(others(perFrame));

    // Non-vacuous: every kind is there, the order filled, and the cadences differ on onFeatures.
    const kinds = new Set(others(paper).map((entry) => entry.callback));
    expect([...kinds].sort()).toEqual(["onFill", "onMarketClosing", "onMarketOpen", "onMarketResolved", "onOrderUpdate"]);
    expect(others(paper).filter((entry) => entry.callback === "onOrderUpdate").length).toBeGreaterThan(5);
    expect(paper.venue.fills.length).toBe(1);
    expect(perFrame.venue.fills).toEqual(paper.venue.fills);
    expect(paper.halts.records()).toEqual([]);
    expect(featureCalls(paper).length).toBeLessThan(featureCalls(perFrame).length / 3);
    expect(paper.loop.health().loop.evaluationsCoalesced).toBeGreaterThan(0);
    expect(perFrame.loop.health().loop.evaluationsCoalesced).toBe(0);
    // `onStart`, `onStop` and `onTimer` have no producer in the loop: none fires under either cadence.
    for (const harness of [perFrame, paper]) {
      expect(harness.seen.some((entry) => ["onStart", "onStop", "onTimer"].includes(entry.callback))).toBe(false);
    }
  });
});

describe("acceptance 2, ADR-026 D5: a coalesced market is not evaluated; every invoked callback persists exactly one decision", () => {
  it("counts one coalescence per owed market per close; the runtime is never asked for it; one decision per invocation", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    // Each market's first book evaluates it at 0 ms (the trade at 0 asked no
    // runtime: no book yet), and the trade at S evaluates both.
    expect(featureCalls(harness).map(([market, , at]) => `${market}@${at}`)).toEqual([
      `A@${iso(0)}`,
      `B@${iso(0)}`,
      `A@${iso(S)}`,
      `B@${iso(S)}`,
    ]);
    // The opening's other closes: A's NO book (A +1), B's YES book (A, carried, +1),
    // B's NO book (B +1, A +1): one per owed market per close.
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(4);
    const before = harness.seen.length;
    // Four closes inside the interval: A owed at all four (+4), B owed from the
    // second on (+3, ADR-026 D5.6: "a market that stays owed over three closes
    // adds three"). Nothing is asked of the runtime.
    await feed(harness, level(S + 300, MARKET_A, "0.31"), level(S + 500, MARKET_B, "0.31"));
    await feed(harness, level(S + 600, MARKET_A, "0.3"), level(S + 999, MARKET_A, "0.31"));
    expect(harness.seen.length).toBe(before);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(4 + 7);
    // At S + 1,000 A is owed and due, and B, still owed, is carried and due: both evaluated, nothing coalesced.
    const due = level(S + 1_000, MARKET_A, "0.3");
    await feed(harness, due);
    expect(featureCalls(harness, before)).toEqual([
      ["A", idOf(due), iso(S + 1_000)],
      ["B", idOf(due), iso(S + 1_000)],
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(4 + 7);

    const health = harness.loop.health();
    expect(health.loop.evaluations).toBe(harness.seen.length);
    expect(health.loop.decisionsPersisted).toBe(harness.seen.length);
    expect(harness.store.decisions.length).toBe(harness.seen.length);
    expect(harness.store.decisions.map((entry) => entry.record.sourceEvent?.eventId)).toEqual(
      harness.seen.map((entry) => entry.source),
    );
  });
});

describe("acceptance 3, ADR-026 D6: the same events give byte-identical decisions; no clock is read for it", () => {
  /** A clock that answers wildly different instants and monotonic readings on every call. */
  class WanderingClock extends ManualClock {
    #calls = 0;
    override now(): string {
      this.#calls += 1;
      return new Date(T0_MS + ((this.#calls * 7_919_000) % 86_400_000) - 43_200_000).toISOString();
    }
    override monotonicNs(): bigint {
      this.#calls += 1;
      return BigInt(this.#calls) * 1_234_567n;
    }
  }

  function events(): IngestedEvent[] {
    ordinal = 0;
    const list = [...opening(), opened(S + 100, MARKET_A)];
    // Two-token frames, single events, a backward step, an unknown market, a refused event.
    let frame = 0;
    for (let offset = S + 200; offset <= S + 12_000; offset += 137) {
      frame += 1;
      if (frame % 9 === 0) {
        list.push(refused(offset));
      } else if (frame % 7 === 0) {
        list.push(snapshot(offset, MARKET_X, "yes"));
      } else if (frame % 5 === 0) {
        list.push(level(offset - 900, MARKET_B, "0.3"));
      } else {
        list.push(level(offset, MARKET_A, "0.31", `f${String(frame)}`), level(offset + 1, MARKET_A, "0.3", `f${String(frame)}`));
      }
    }
    return list;
  }

  async function decisionBytes(clock: Clock): Promise<string> {
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, clock });
    // One drain per frame, as the feed hands frames out.
    const list = events();
    for (let start = 0; start < list.length; ) {
      let end = start + 1;
      const key = (list[start]?.envelope as { causationId?: string }).causationId;
      while (key !== undefined && end < list.length && (list[end]?.envelope as { causationId?: string }).causationId === key) end += 1;
      await feed(harness, list.slice(start, end));
      start = end;
    }
    expect(harness.halts.records()).toEqual([]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBeGreaterThan(20);
    return JSON.stringify({
      decisions: harness.store.decisions.map((entry) => entry.record),
      checkpoints: harness.store.checkpoints,
      seen: harness.seen,
      loop: harness.loop.health().loop,
    });
  }

  it("two runs, two unrelated clocks: the same bytes", async () => {
    const first = await decisionBytes(new ManualClock(T_OPEN));
    const second = await decisionBytes(new WanderingClock(T_OPEN));
    expect(second).toBe(first);
  });
});

describe("acceptance 4, ADR-026 D2.1 and D2.8: the high-water mark; a backward step neither stops nor adds an evaluation", () => {
  it("a stamp behind the clock adds no evaluation, and the next one comes when the clock has moved on by the interval", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const ahead = level(S + 1_200, MARKET_A, "0.31");
    await feed(harness, ahead);
    // Back 1,100 ms. Measured from its own instant this event sits 1,100 ms
    // after the S evaluation and would look due; on the high-water mark it is
    // 0 ms after the S + 1,200 one, so it is not evaluated (it stays owed).
    const back = level(S + 100, MARKET_A, "0.3");
    const almost = level(S + 2_199, MARKET_A, "0.31");
    await feed(harness, back, almost);
    expect(featureCalls(harness, start)).toEqual([["A", idOf(ahead), iso(S + 1_200)]]);
    const moved = level(S + 2_200, MARKET_A, "0.3");
    await feed(harness, moved);
    expect(featureCalls(harness, start).slice(1)).toEqual([["A", idOf(moved), iso(S + 2_200)]]);
  });

  it("the same stream without the backward event evaluates at exactly the same events", async () => {
    const run = async (includeBack: boolean): Promise<string[]> => {
      ordinal = 0;
      const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
      await feed(harness, ...opening());
      const list = [S + 1_200, S + 100, S + 2_199, S + 2_200, S + 3_000, S + 3_200].map((offset) => level(offset, MARKET_A, "0.31"));
      for (const [index, ingested] of list.entries()) if (includeBack || index !== 1) await feed(harness, ingested);
      return featureCalls(harness).map(([market, , evaluatedAt]) => `${market}@${evaluatedAt}`);
    };
    const withBack = await run(true);
    expect(withBack).toEqual(await run(false));
    // After the opening's four evaluations (A and B at 0 ms and at S).
    expect(withBack.slice(4)).toEqual([`A@${iso(S + 1_200)}`, `A@${iso(S + 2_200)}`, `A@${iso(S + 3_200)}`]);
  });
});

describe("acceptance 6, ADR-026 D2.1 and D3.2-D3.3: refused events and the source of a carried or heartbeat evaluation", () => {
  it("a refused event never moves the clock: an event stamped 10 s ahead, refused, does not make A due", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    await feed(harness, refused(S + 10_000), level(S + 500, MARKET_A, "0.31"));
    expect(harness.loop.health().loop.eventsRefused).toBe(1);
    expect(featureCalls(harness, start)).toEqual([]);
    expect(harness.alarms).toEqual([]);
  });

  it("a carried evaluation takes the frame's LAST APPLIED event — one for a market this trader does not run — never a refused one", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const start = harness.seen.length;
    // One frame: B owes itself an evaluation, an unknown market's event is
    // applied after it, and a refused event ends it. A is carried and due.
    const owesB = level(S + 1_100, MARKET_B, "0.31", "x1");
    const unknown = snapshot(S + 1_150, MARKET_X, "yes", "x1");
    const refusedLast = refused(S + 1_160, "x1");
    await feed(harness, [owesB, unknown, refusedLast]);
    expect(featureCalls(harness, start)).toEqual([
      ["B", idOf(owesB), iso(S + 1_100)],
      ["A", idOf(unknown), iso(S + 1_150)],
    ]);
  });

  it("a lone event for a market this trader does not run sources a heartbeat, and its close flushes the decisions", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 4_999, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toEqual([]);
    const unknown = snapshot(S + 5_000, MARKET_X, "no");
    await feed(harness, unknown);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(unknown), iso(S + 5_000)],
      ["B", idOf(unknown), iso(S + 5_000)],
    ]);
    // Flushed at that event: the decisions are in the store already.
    expect(harness.store.decisions.slice(-2).map((entry) => entry.record.sourceEvent?.eventId)).toEqual([idOf(unknown), idOf(unknown)]);
  });

  it("a frame with NO applied event evaluates nothing, though a heartbeat would be due; a market still owed stays owed", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const start = harness.seen.length;
    // Every event of these frames is refused, at instants where a carried
    // evaluation and both heartbeats would be due.
    await feed(harness, [refused(S + 6_000, "r1"), refused(S + 6_001, "r1")]);
    await feed(harness, refused(S + 7_000));
    expect(featureCalls(harness, start)).toEqual([]);
    // The first APPLIED close evaluates A, still owed, once the clock allows it.
    const early = snapshot(S + 999, MARKET_X, "yes");
    await feed(harness, early);
    expect(featureCalls(harness, start)).toEqual([]);
    const applied = snapshot(S + 1_000, MARKET_X, "no");
    await feed(harness, applied);
    expect(featureCalls(harness, start)).toEqual([["A", idOf(applied), iso(S + 1_000)]]);
  });
});

describe("acceptance 7, ADR-026 D2.12: at one close, owed markets first (ADR-024 D3's order), then carried and heartbeat ones (configured order)", () => {
  it("a close where B is owed and A is carried evaluates B, then A — although A comes first in the configured order", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const start = harness.seen.length;
    const owesB = level(S + 1_000, MARKET_B, "0.31");
    await feed(harness, owesB);
    expect(featureCalls(harness, start)).toEqual([
      ["B", idOf(owesB), iso(S + 1_000)],
      ["A", idOf(owesB), iso(S + 1_000)],
    ]);
  });

  it("in a longer frame: owed markets in the order of their last owing events, then carried ones; each at most once", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    // B owed, then A, then B again: B moves to the end (ADR-024 r1), each at its last owing event.
    const b1 = level(S + 1_000, MARKET_B, "0.31", "m1");
    const a1 = level(S + 1_001, MARKET_A, "0.31", "m1");
    const b2 = level(S + 1_002, MARKET_B, "0.3", "m1");
    await feed(harness, [b1, a1, b2]);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(a1), iso(S + 1_001)],
      ["B", idOf(b2), iso(S + 1_002)],
    ]);
    // B owed inside the interval: carried. Then a frame owing only A, 5 s on,
    // where B is both carried and heartbeat-due: A first, then B — once.
    await feed(harness, level(S + 1_500, MARKET_B, "0.31"));
    const a2 = level(S + 6_003, MARKET_A, "0.3", "m2");
    const x2 = snapshot(S + 6_004, MARKET_X, "yes", "m2");
    await feed(harness, [a2, x2]);
    expect(featureCalls(harness, start).slice(2)).toEqual([
      ["A", idOf(a2), iso(S + 6_003)],
      ["B", idOf(x2), iso(S + 6_004)],
    ]);
  });

  it("two carried markets come in the configured order — A, then B — whatever order they were owed in", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_B, "0.31"), level(S + 400, MARKET_A, "0.31"));
    const start = harness.seen.length;
    const unknown = snapshot(S + 1_000, MARKET_X, "yes");
    await feed(harness, unknown);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(unknown), iso(S + 1_000)],
      ["B", idOf(unknown), iso(S + 1_000)],
    ]);
  });

  it("the heartbeat: exactly at t − last = 5,000 ms, never before; sourced at the closing event", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    // Only B is touched: B is owed and evaluated each second; A gets its heartbeat at S + 5,000.
    for (const offset of [1_000, 2_000, 3_000, 4_000, 4_999]) await feed(harness, level(S + offset, MARKET_B, "0.31"));
    expect(featureCalls(harness, start).map(([market]) => market)).toEqual(["B", "B", "B", "B"]);
    const beat = level(S + 5_000, MARKET_B, "0.3");
    await feed(harness, beat);
    expect(featureCalls(harness, start).slice(4)).toEqual([
      ["B", idOf(beat), iso(S + 5_000)],
      ["A", idOf(beat), iso(S + 5_000)],
    ]);
  });
});

describe("acceptance 8, the ADR-024 D3 one-event row: callbacks in place, onFeatures by the cadence", () => {
  it("a lone lifecycle event fires its callback in place while the market's onFeatures is not due; a lone book event is coalesced", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const open = opened(S + 200, MARKET_A);
    const book = level(S + 300, MARKET_A, "0.31");
    await feed(harness, open, book);
    expect(harness.seen.slice(start).map((entry) => [entry.callback, entry.source])).toEqual([["onMarketOpen", idOf(open)]]);
    // The book event's onFeatures is owed, not evaluated: it comes at the first close the cadence allows.
    const later = reference(S + 1_000);
    await feed(harness, later);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(later), iso(S + 1_000)],
      ["B", idOf(later), iso(S + 1_000)],
    ]);
  });

  it("under the per-frame value 0 the same events evaluate in place at every event, as ADR-024 did", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PER_FRAME });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const open = opened(S + 200, MARKET_A);
    const book = level(S + 300, MARKET_A, "0.31");
    await feed(harness, open, book);
    expect(harness.seen.slice(start).map((entry) => [entry.callback, entry.source])).toEqual([
      ["onMarketOpen", idOf(open)],
      ["onFeatures", idOf(book)],
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(0);
  });
});

describe("acceptance 9, ADR-026 D2.10: a forward jump in event time", () => {
  const HOUR = 3_600_000;

  it("holds onFeatures — owed or by heartbeat — until the clock has moved on by the interval, and raises the alarm", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const jump = level(HOUR, MARKET_A, "0.31");
    await feed(harness, jump);
    // A owed and due; B by heartbeat (its last is S, an hour before).
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(jump), iso(HOUR)],
      ["B", idOf(jump), iso(HOUR)],
    ]);
    // Twenty seconds of ordinary stamps, both markets touched every second: nothing is evaluated.
    for (let offset = S + 1_000; offset <= S + 20_000; offset += 1_000) {
      await feed(harness, level(offset, MARKET_A, "0.3"), level(offset + 1, MARKET_B, "0.3"));
    }
    expect(featureCalls(harness, start)).toHaveLength(2);
    expect(harness.loop.health().loop.cadenceForwardJumpAlarms).toBe(40);
    expect(harness.alarms).toEqual([
      { kind: "RAISED", eventAt: iso(S + 1_000), clockAt: iso(HOUR), behindMs: HOUR - S - 1_000, boundMs: 5_000 },
    ]);
    // Stamps catch up to within the bound: the episode ends; still no evaluation before HOUR + 1,000.
    await feed(harness, level(HOUR - 5_000, MARKET_A, "0.31"), level(HOUR + 999, MARKET_A, "0.3"));
    expect(featureCalls(harness, start)).toHaveLength(2);
    expect(harness.alarms.at(-1)).toEqual({ kind: "CLEARED", eventAt: iso(HOUR - 5_000), clockAt: iso(HOUR), behindMs: 5_000, boundMs: 5_000 });
    const end = level(HOUR + 1_000, MARKET_A, "0.31");
    await feed(harness, end);
    expect(featureCalls(harness, start).slice(2)).toEqual([
      ["A", idOf(end), iso(HOUR + 1_000)],
      ["B", idOf(end), iso(HOUR + 1_000)],
    ]);
    expect(harness.loop.health().loop.cadenceForwardJumpAlarms).toBe(40);
    expect(harness.halts.records()).toEqual([]);
  });

  it("every other callback still fires during the hold", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(HOUR, MARKET_A, "0.31"));
    const start = harness.seen.length;
    const open = opened(S + 2_000, MARKET_B);
    await feed(harness, open);
    expect(harness.seen.slice(start).map((entry) => [entry.callback, entry.source])).toEqual([["onMarketOpen", idOf(open)]]);
    expect(harness.loop.health().loop.cadenceForwardJumpAlarms).toBe(1);
  });

  it("a throwing alarm hook changes nothing the loop does", async () => {
    const run = async (hook: (alarm: CadenceAlarm) => void): Promise<string> => {
      ordinal = 0;
      const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
      // The harness's hook pushes into `alarms`; route that push to `hook`.
      harness.alarms.push = (...items: CadenceAlarm[]): number => {
        for (const item of items) hook(item);
        return 0;
      };
      await feed(harness, ...opening(), level(HOUR, MARKET_A, "0.31"), level(S + 1_000, MARKET_A, "0.3"), level(HOUR + 1_000, MARKET_A, "0.31"));
      return JSON.stringify({ seen: harness.seen, loop: harness.loop.health().loop, halts: harness.halts.records() });
    };
    let raised = 0;
    const quiet = await run(() => {
      raised += 1;
    });
    const throwing = await run(() => {
      throw new Error("a log sink that fails");
    });
    expect(raised).toBe(2);
    expect(throwing).toBe(quiet);
  });
});

describe("ADR-026 D2.11 (corrected 2026-10-03): a halted market is not evaluated, and its owed evaluation is dropped", () => {
  it("a market halted while owed is neither evaluated nor counted as coalesced afterwards; the other market goes on", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    harness.halts.halt({ kind: "MARKET", marketId: MARKET_A }, "RUNTIME_PERSISTENCE_FAILED", "test", iso(S + 400));
    const start = harness.seen.length;
    const first = level(S + 1_000, MARKET_B, "0.31");
    const second = level(S + 6_000, MARKET_B, "0.3");
    await feed(harness, first, second);
    expect(featureCalls(harness, start)).toEqual([
      ["B", idOf(first), iso(S + 1_000)],
      ["B", idOf(second), iso(S + 6_000)],
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
  });
});

describe("edges of one close", () => {
  it("a market named twice by ONE event is decided once at its close: evaluated once, never also coalesced and carried", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    const start = harness.seen.length;
    const incident = event(S + 1_000, "DataQualityIncidentOpened", {
      incidentId: "cadence1-incident",
      openedAt: iso(S + 1_000),
      reasonCode: "FEED_STALE",
      severity: "NOTIFY",
      affectedMarketIds: [MARKET_A, MARKET_A],
    });
    await feed(harness, incident);
    expect(featureCalls(harness, start)).toEqual([["A", idOf(incident), iso(S + 1_000)]]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
    // Nothing was left owed: a later close that allows a carried evaluation evaluates nothing.
    await feed(harness, snapshot(S + 2_000, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toHaveLength(1);
  });


  it("under the per-frame value 0 a market named twice by ONE event is evaluated twice, as ADR-024 did (r1, O05)", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PER_FRAME });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const incident = event(S + 1_000, "DataQualityIncidentOpened", {
      incidentId: "cadence1-incident-per-frame",
      openedAt: iso(S + 1_000),
      reasonCode: "FEED_STALE",
      severity: "NOTIFY",
      affectedMarketIds: [MARKET_A, MARKET_A],
    });
    await feed(harness, incident);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(incident), iso(S + 1_000)],
      ["A", idOf(incident), iso(S + 1_000)],
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(0);
  });

  it("a LONGER frame's close counts an owed market it coalesces ONCE, though the carried pass walks every market after it (r1, O02; D5.6)", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const before = harness.loop.health().loop.evaluationsCoalesced;
    // A owed twice in one frame inside the interval, and the frame ends with an
    // event for a market this trader does not run: one owed market, one close, +1.
    await feed(harness, [
      level(S + 300, MARKET_A, "0.31", "c1"),
      level(S + 301, MARKET_A, "0.3", "c1"),
      snapshot(S + 302, MARKET_X, "yes", "c1"),
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(before + 1);
    // The next frame owes B (coalesced, +1) and closes with A carried and not due (+1).
    await feed(harness, [level(S + 400, MARKET_B, "0.31", "c2"), snapshot(S + 401, MARKET_X, "no", "c2")]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(before + 3);
    expect(harness.seen.length).toBe(start);
  });

  it("a lone lifecycle event for a market that is carried and due fires its callback in place, then the carried onFeatures at the same close (r1, O04)", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const start = harness.seen.length;
    const close = closing(S + 1_000, MARKET_A);
    await feed(harness, close);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback, entry.source, entry.evaluatedAt])).toEqual([
      ["A", "onMarketClosing", idOf(close), iso(S + 1_000)],
      ["A", "onFeatures", idOf(close), iso(S + 1_000)],
    ]);
  });
});

describe("r1 (J2), ADR-026 D2.3-D2.6: a market's `last` moves only when the loop asked a runtime for its onFeatures", () => {
  it("an owed evaluation with no computable snapshot is no evaluation: the market stays owed, is tried at each later close, and its first usable book evaluates it at once", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    // The trade owes both markets an evaluation; neither has a book: no runtime is asked.
    await feed(harness, reference(0));
    expect(featureCalls(harness)).toEqual([]);
    expect(harness.loop.health().loop.snapshotsUnavailable).toBe(2);
    // Still owed, so a close that owes neither tries both again (the carried pass).
    await feed(harness, snapshot(5, MARKET_X, "yes"));
    expect(featureCalls(harness)).toEqual([]);
    expect(harness.loop.health().loop.snapshotsUnavailable).toBe(4);
    // A's first usable book, 10 ms after the trade: A is evaluated there, not coalesced.
    const bookA = snapshot(10, MARKET_A, "yes");
    await feed(harness, bookA);
    expect(featureCalls(harness)).toEqual([["A", idOf(bookA), iso(10)]]);
    // B, still owed, was tried by that close's carried pass and still had no book.
    expect(harness.loop.health().loop.snapshotsUnavailable).toBe(5);
    const bookB = snapshot(20, MARKET_B, "yes");
    await feed(harness, bookB);
    expect(featureCalls(harness)).toEqual([
      ["A", idOf(bookA), iso(10)],
      ["B", idOf(bookB), iso(20)],
    ]);
    const loop = harness.loop.health().loop;
    expect(loop.evaluations).toBe(2);
    expect(loop.evaluationsCoalesced).toBe(0);
    expect(loop.snapshotsUnavailable).toBe(5);
  });

  it("the same first book under the per-frame value 0 evaluates the market at the same event", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PER_FRAME });
    await feed(harness, reference(0));
    const bookA = snapshot(10, MARKET_A, "yes");
    await feed(harness, bookA);
    expect(featureCalls(harness)).toEqual([["A", idOf(bookA), iso(10)]]);
  });

  it("a market whose ONLY instance is halted is not evaluated, and the owed evaluation is dropped (C1-HALTS: no release exists; the run ends)", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    const scope = { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A } as const;
    harness.halts.halt(scope, "RUNTIME_PERSISTENCE_FAILED", "test", iso(S + 400));
    // A owed and due by the cadence, but its one instance is halted: no runtime is asked.
    await feed(harness, level(S + 1_000, MARKET_A, "0.31"));
    expect(featureCalls(harness, start)).toEqual([]);
    // Dropped, not carried: an event for no configured market evaluates nothing.
    await feed(harness, snapshot(S + 1_100, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toEqual([]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
  });

  it("a HEARTBEAT that finds A's only instance halted is no evaluation either (C1-HALTS: no release exists; the run ends)", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const scope = { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A } as const;
    harness.halts.halt(scope, "RUNTIME_PERSISTENCE_FAILED", "test", iso(S + 4_000));
    // Both heartbeats due; A's one instance is halted, so only B is evaluated.
    const first = snapshot(S + 5_000, MARKET_X, "yes");
    await feed(harness, first);
    expect(featureCalls(harness, start)).toEqual([["B", idOf(first), iso(S + 5_000)]]);
  });

  it("with A's OWNER instance halted and its SHADOW instance evaluated, the market WAS evaluated: `last` moves", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, shadowOnA: true });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    harness.halts.halt({ kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A }, "RUNTIME_PERSISTENCE_FAILED", "test", iso(S + 400));
    const owed = level(S + 1_000, MARKET_A, "0.31");
    await feed(harness, owed);
    expect(featureCalls(harness, start)).toEqual([["A2", idOf(owed), iso(S + 1_000)]]);
    // `last` moved to S + 1,000: A's next owed event, inside the interval, is coalesced.
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    await feed(harness, level(S + 1_200, MARKET_A, "0.3"));
    expect(featureCalls(harness, start)).toHaveLength(1);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced + 1);
  });
});

describe("r1 (J1), ADR-026 D4.2: the harvest points are ADR-024's — the cadence adds none, moves none and re-stamps none", () => {
  /** Every invocation but `onFeatures` since `from`: what D4.2 says fires exactly as before. */
  const others = (harness: Harness, from: number): Seen[] =>
    harness.seen.slice(from).filter((entry) => entry.callback !== "onFeatures");

  it("a mixed frame — A's fill, then an applied event for a market this trader does not run, B heartbeat-due — fires A's fill and order update at the fill's instant, as per-frame does", async () => {
    const run = async (cadence: EvaluationCadenceOption) => {
      ordinal = 0;
      const harness = assemble({ cadence, placeOnOpen: true });
      await feed(harness, ...opening(), opened(S + 100, MARKET_A), level(S + 4_800, MARKET_A, "0.31"));
      const start = harness.seen.length;
      const unknown = snapshot(S + 5_500, MARKET_X, "yes", "mixed");
      await feed(harness, [trade(S + 5_000, MARKET_A, "0.29", "mixed"), unknown]);
      return { harness, start, unknown };
    };
    const perFrame = await run(PER_FRAME);
    const paper = await run(PAPER_EVALUATION_CADENCE);
    expect(others(paper.harness, paper.start)).toEqual(others(perFrame.harness, perFrame.start));
    // Non-vacuous: the order filled, both callbacks came at the fill's instant,
    // A was coalesced there, and B's heartbeat ran at the unknown event.
    expect(others(paper.harness, paper.start).map((entry) => [label(entry.instanceId), entry.callback, entry.evaluatedAt])).toEqual([
      ["A", "onFill", iso(S + 5_000)],
      ["A", "onOrderUpdate", iso(S + 5_000)],
    ]);
    expect(featureCalls(paper.harness, paper.start)).toEqual([["B", idOf(paper.unknown), iso(S + 5_500)]]);
    expect(paper.harness.venue.fills).toHaveLength(1);
  });

  it("heartbeats at lone events for no configured market add no harvest: no fill or order view is delivered there, as per-frame", async () => {
    const run = async (cadence: EvaluationCadenceOption) => {
      ordinal = 0;
      const harness = assemble({ cadence, placeOnOpen: true });
      await feed(harness, ...opening(), opened(S + 100, MARKET_A));
      const start = harness.seen.length;
      for (const offset of [5_100, 10_200, 15_300]) await feed(harness, snapshot(S + offset, MARKET_X, "yes"));
      await feed(harness, level(S + 15_400, MARKET_A, "0.31"));
      return { harness, start };
    };
    const perFrame = await run(PER_FRAME);
    const paper = await run(PAPER_EVALUATION_CADENCE);
    expect(others(paper.harness, paper.start)).toEqual(others(perFrame.harness, perFrame.start));
    // Non-vacuous: three rounds of heartbeats ran, and the old order's WORKING
    // view came only at A's own event, the one harvest point.
    expect(featureCalls(paper.harness, paper.start).map(([market, , at]) => `${market}@${at}`)).toEqual([
      `A@${iso(S + 5_100)}`,
      `B@${iso(S + 5_100)}`,
      `A@${iso(S + 10_200)}`,
      `B@${iso(S + 10_200)}`,
      `A@${iso(S + 15_300)}`,
      `B@${iso(S + 15_300)}`,
    ]);
    expect(others(paper.harness, paper.start).map((entry) => [label(entry.instanceId), entry.callback, entry.evaluatedAt])).toEqual([
      ["A", "onOrderUpdate", iso(S + 15_400)],
    ]);
  });

  it("a longer frame of events for no configured market, at which heartbeats run, harvests nothing; its decisions are flushed at its close", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnOpen: true });
    await feed(harness, ...opening(), opened(S + 100, MARKET_A));
    expect(harness.venue.ordersSnapshot()).toHaveLength(1);
    const start = harness.seen.length;
    const decided = harness.store.decisions.length;
    const x1 = snapshot(S + 5_000, MARKET_X, "yes", "u1");
    const x2 = snapshot(S + 5_001, MARKET_X, "no", "u1");
    await feed(harness, [x1, x2]);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback, entry.source])).toEqual([
      ["A", "onFeatures", idOf(x2)],
      ["B", "onFeatures", idOf(x2)],
    ]);
    // Flushed at this close, not left in the outbox for a later one.
    expect(harness.store.decisions.length).toBe(decided + 2);
  });

  it("a heartbeat at an event that IS its close's harvest point: its own new order is delivered by that harvest, at that instant", async () => {
    ordinal = 0;
    const at = iso(S + 5_000);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: false } });
    // B's market is opened, so the risk engine admits B's entry (§9.8 market status).
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    const owesA = level(S + 5_000, MARKET_A, "0.31");
    await feed(harness, owesA);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback, entry.source, entry.evaluatedAt])).toEqual([
      ["A", "onFeatures", idOf(owesA), at],
      ["B", "onFeatures", idOf(owesA), at],
      ["B", "onOrderUpdate", undefined, at],
    ]);
  });

  it("in a LONGER frame whose last applied event reached the harvest point, a heartbeat's own new order is delivered by that frame's harvest, at its instant", async () => {
    ordinal = 0;
    const at = iso(S + 5_001);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: false } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    const a1 = level(S + 5_000, MARKET_A, "0.31", "s");
    const a2 = level(S + 5_001, MARKET_A, "0.3", "s");
    await feed(harness, [a1, a2]);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback, entry.source, entry.evaluatedAt])).toEqual([
      ["A", "onFeatures", idOf(a2), at],
      ["B", "onFeatures", idOf(a2), at],
      ["B", "onOrderUpdate", undefined, at],
    ]);
  });

  it("in a LONGER frame whose last applied event reached the harvest point, the heartbeat runs BEFORE that harvest, beside the owed evaluation: the harvest then delivers every view at once — an older working order's and the heartbeat's new one (r2)", async () => {
    ordinal = 0;
    const at = iso(S + 5_001);
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      placeOnOpen: true,
      placeOnFeatures: { market: MARKET_B, at, immediate: false },
    });
    await feed(harness, ...opening(), opened(S + 100, MARKET_A), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    await feed(harness, [level(S + 5_000, MARKET_A, "0.31", "s2"), level(S + 5_001, MARKET_A, "0.3", "s2")]);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback, entry.evaluatedAt])).toEqual([
      ["A", "onFeatures", at],
      ["B", "onFeatures", at],
      // The frame's one harvest, after every evaluation of the close: A's
      // older working order, then B's new one, in venue order.
      ["A", "onOrderUpdate", at],
      ["B", "onOrderUpdate", at],
    ]);
  });

  it("a heartbeat at an event for no configured market: its OWN fill and order view are booked and delivered there, at once, stamped at its source's instant (r2, RA; r1's deferral to the next harvest point is gone)", async () => {
    ordinal = 0;
    const at = iso(S + 5_000);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: true } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    const unknown = snapshot(S + 5_000, MARKET_X, "yes");
    await feed(harness, unknown);
    // B's heartbeat placed a taker order, which the venue filled at once: the
    // fill is booked, and B's onFill and onOrderUpdate come at this event, at
    // its instant — the instant of the heartbeat's own source.
    expect(harness.venue.fills).toHaveLength(1);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback, entry.source, entry.evaluatedAt])).toEqual([
      ["A", "onFeatures", idOf(unknown), at],
      ["B", "onFeatures", idOf(unknown), at],
      ["B", "onFill", undefined, at],
      ["B", "onOrderUpdate", undefined, at],
    ]);
    expect(harness.shown.slice(start + 2).map((entry) => [entry.yesShares, entry.orderStatus])).toEqual([
      ["10", undefined],
      ["10", "FILLED"],
    ]);
    const execution = harness.loop.health().execution;
    expect(execution.fillsObserved).toBe(1);
    expect(harness.loop.health().accounting.ledgerTransactions).toBeGreaterThan(0);
    // The next harvest point (A's event; A coalesced) delivers nothing of B's
    // again, and reads the fill neither as new nor as a duplicate.
    await feed(harness, level(S + 5_200, MARKET_A, "0.31"));
    expect(harness.seen.slice(start + 4)).toEqual([]);
    expect(harness.loop.health().execution).toMatchObject({ fillsObserved: 1, duplicateFillsRefused: 0 });
  });

  it("a mixed frame whose tail is for no configured market: the frame's harvest runs at its own instant, first; the heartbeat's own new order is delivered right after, at the heartbeat's source's instant (r2, RA)", async () => {
    const run = async (cadence: EvaluationCadenceOption) => {
      ordinal = 0;
      const harness = assemble({
        cadence,
        placeOnOpen: true,
        placeOnFeatures: { market: MARKET_B, at: iso(S + 5_100), immediate: false },
      });
      await feed(harness, ...opening(), opened(S + 100, MARKET_A), opened(S + 150, MARKET_B));
      const start = harness.seen.length;
      await feed(harness, [level(S + 5_000, MARKET_A, "0.31", "m"), snapshot(S + 5_100, MARKET_X, "yes", "m")]);
      await feed(harness, reference(S + 5_300));
      return { harness, start };
    };
    const paper = await run(PAPER_EVALUATION_CADENCE);
    expect(paper.harness.seen.slice(paper.start).map((entry) => [label(entry.instanceId), entry.callback, entry.evaluatedAt])).toEqual([
      ["A", "onFeatures", iso(S + 5_000)],
      // The frame's harvest: A's resting order, at A's event, exactly where ADR-024 ran it.
      ["A", "onOrderUpdate", iso(S + 5_000)],
      // Then B's heartbeat, at the frame's last applied event; it places a resting order...
      ["B", "onFeatures", iso(S + 5_100)],
      // ...whose view comes at once, at that event's instant: the carried harvest.
      ["B", "onOrderUpdate", iso(S + 5_100)],
      // The next harvest point (the reference trade; A and B coalesced there):
      // both WORKING orders' views, as every harvest delivers them.
      ["A", "onOrderUpdate", iso(S + 5_300)],
      ["B", "onOrderUpdate", iso(S + 5_300)],
    ]);
    // A's own callbacks are exactly per-frame's: the carried harvest delivered
    // no view of A's older order.
    const perFrame = await run(PER_FRAME);
    const ofA = (harness: Harness, from: number) => others(harness, from).filter((entry) => entry.instanceId === INSTANCE_A);
    expect(ofA(paper.harness, paper.start)).toEqual(ofA(perFrame.harness, perFrame.start));
  });
});

describe("r2 (RA), ADR-026 D4 and ruling A1: a carried-over or heartbeat evaluation's own fills and order views are never delayed", () => {
  it("repeated heartbeats at events for no configured market: the first one's own fill is booked and delivered at its close, and every later heartbeat sees the position", async () => {
    ordinal = 0;
    const at = iso(S + 5_000);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: true } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    for (const offset of [5_000, 10_000, 15_000, 20_000]) await feed(harness, snapshot(S + offset, MARKET_X, "yes"));
    const ofB = harness.seen
      .map((entry, index) => ({ entry, shown: harness.shown[index] }))
      .slice(start)
      .filter(({ entry }) => entry.instanceId === INSTANCE_B)
      .map(({ entry, shown }) => [entry.callback, entry.evaluatedAt, shown?.yesShares]);
    expect(ofB).toEqual([
      ["onFeatures", at, "0"],
      ["onFill", at, "10"],
      ["onOrderUpdate", at, "10"],
      ["onFeatures", iso(S + 10_000), "10"],
      ["onFeatures", iso(S + 15_000), "10"],
      ["onFeatures", iso(S + 20_000), "10"],
    ]);
    const health = harness.loop.health();
    expect(health.execution).toMatchObject({ fillsObserved: 1, duplicateFillsRefused: 0 });
    expect(health.accounting.ledgerTransactions).toBeGreaterThan(0);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 1, released: 1 });
    // B's next own event: B is evaluated on the booked position, and nothing
    // of the old order is delivered again.
    const bookB = level(S + 26_000, MARKET_B, "0.31");
    const before = harness.seen.length;
    await feed(harness, bookB);
    expect(harness.seen.slice(before).map((entry, index) => [label(entry.instanceId), entry.callback, harness.shown[before + index]?.yesShares])).toEqual([
      ["B", "onFeatures", "10"],
      ["A", "onFeatures", "0"],
    ]);
  });

  it("under a BACKWARD step in event time, a heartbeat's own fill and view are still stamped at their source's instant — never at a later-arriving, earlier-stamped event's (r2, RD)", async () => {
    ordinal = 0;
    const at = iso(S + 5_000);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: true } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    // The next event steps back 100 ms; it is a harvest point (A's book).
    await feed(harness, level(S + 4_900, MARKET_A, "0.31"));
    expect(harness.seen.slice(start).filter((entry) => entry.callback !== "onFeatures").map((entry) => [label(entry.instanceId), entry.callback, entry.evaluatedAt])).toEqual([
      ["B", "onFill", at],
      ["B", "onOrderUpdate", at],
    ]);
  });

  it("at the END of input — the run's last event is for no configured market — the heartbeat's own fill is booked and delivered before the drain returns", async () => {
    ordinal = 0;
    const at = iso(S + 5_000);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: true } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), snapshot(S + 5_000, MARKET_X, "yes"));
    // No event follows.
    expect(harness.seen.filter((entry) => entry.callback === "onFill" || entry.callback === "onOrderUpdate").map((entry) => [label(entry.instanceId), entry.callback, entry.evaluatedAt])).toEqual([
      ["B", "onFill", at],
      ["B", "onOrderUpdate", at],
    ]);
    const health = harness.loop.health();
    expect(health.execution.fillsObserved).toBe(1);
    expect(health.accounting.ledgerTransactions).toBeGreaterThan(0);
    expect(health.seams.reservations).toMatchObject({ open: 0, released: 1, reservedCollateral: "0" });
    // r3 (O-R3-02, MY8): the outbox is flushed AFTER the carried harvest, so the
    // decisions of its onFill and onOrderUpdate are in the store too — every
    // invoked callback's, with no later event to flush them.
    expect(health.loop.decisionsPersisted).toBe(harness.seen.length);
    expect(harness.store.decisions).toHaveLength(harness.seen.length);
    expect(harness.store.decisions.slice(-2).map((entry) => entry.record.callback)).toEqual(["onFill", "onOrderUpdate"]);
  });

  it("a frame of events for no configured market (no harvest point at all): the heartbeat's own fill is delivered at the frame's close, at its last applied event's instant", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at: iso(S + 5_001), immediate: true } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    const x1 = snapshot(S + 5_000, MARKET_X, "yes", "u2");
    const x2 = snapshot(S + 5_001, MARKET_X, "no", "u2");
    await feed(harness, [x1, x2]);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback, entry.source, entry.evaluatedAt])).toEqual([
      ["A", "onFeatures", idOf(x2), iso(S + 5_001)],
      ["B", "onFeatures", idOf(x2), iso(S + 5_001)],
      ["B", "onFill", undefined, iso(S + 5_001)],
      ["B", "onOrderUpdate", undefined, iso(S + 5_001)],
    ]);
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    // r3 (O-R3-02): the frame's close flushes after its carried harvest — the
    // input ends here, and every invoked callback's decision is in the store.
    expect(harness.store.decisions).toHaveLength(harness.seen.length);
    expect(harness.store.decisions.slice(-2).map((entry) => entry.record.callback)).toEqual(["onFill", "onOrderUpdate"]);
  });

  it("a heartbeat that CANCELS an older working order: the order's terminal view comes at once, at the heartbeat's instant, and its reservation is released there", async () => {
    ordinal = 0;
    const at = iso(S + 5_100);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnOpen: true, cancelOnFeatures: { market: MARKET_A, at } });
    await feed(harness, ...opening(), opened(S + 100, MARKET_A));
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 1, released: 0 });
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 5_100, MARKET_X, "yes"));
    expect(harness.seen.slice(start).map((entry, index) => [label(entry.instanceId), entry.callback, entry.evaluatedAt, harness.shown[start + index]?.orderStatus])).toEqual([
      ["A", "onFeatures", at, undefined],
      ["B", "onFeatures", at, undefined],
      // After the pass, as after any close's evaluations: the carried harvest.
      ["A", "onOrderUpdate", at, "CANCELED"],
    ]);
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 0, released: 1, reservedCollateral: "0" });
    // Retired there, but SETTLED only by the ordinary harvest, which books every fill first.
    expect(harness.loop.health().seams.orders).toMatchObject({ settled: 0, settleMismatches: 0 });
    // Retired: the next harvest point does not deliver it again.
    const before = harness.seen.length;
    await feed(harness, reference(S + 5_200));
    expect(harness.seen.slice(before).filter((entry) => entry.callback !== "onFeatures")).toEqual([]);
    expect(harness.loop.health().seams.orders).toMatchObject({ settled: 1, settleMismatches: 0 });
  });

  it("an EARLIER decision's fill keeps its ADR-024 harvest point: an onFill decision's own fill, unread at a later heartbeat, is booked at the next harvest point, after the heartbeat's own fill was booked ahead of it — none twice", async () => {
    ordinal = 0;
    const first = iso(S + 5_000);
    const second = iso(S + 10_000);
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      placeOnFeatures: { market: MARKET_B, at: [first, second], immediate: true },
      // B's onFill at the first heartbeat's fill places another taker order:
      // an onFill decision's effect, which ADR-024 delivers at the NEXT harvest point.
      placeOnFill: { market: MARKET_B, at: first },
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    // Three fills at the venue: the first heartbeat's, the onFill decision's, the second heartbeat's.
    expect(harness.venue.fills).toHaveLength(3);
    const bookB = level(S + 10_100, MARKET_B, "0.31");
    await feed(harness, bookB);
    const fills = harness.seen
      .map((entry, index) => ({ entry, shown: harness.shown[index] }))
      .slice(start)
      .filter(({ entry }) => entry.callback === "onFill")
      .map(({ entry, shown }) => [entry.evaluatedAt, shown?.yesShares]);
    expect(fills).toEqual([
      // The first heartbeat's own fill, at once.
      [first, "10"],
      // The second heartbeat's own fill, at once — booked AHEAD of the onFill
      // decision's fill, which is still unread, so the position shows 20.
      [second, "20"],
      // The onFill decision's fill, at the next harvest point, as ADR-024 times it.
      [iso(S + 10_100), "30"],
    ]);
    // Each fill read, booked and delivered once: no duplicate, no recount.
    expect(harness.loop.health().execution).toMatchObject({ fillsObserved: 3, duplicateFillsRefused: 0 });
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 0, taken: 3, released: 3 });
  });

  it("a heartbeat CANCELS an order whose fill is still unread (an onFill decision's GTC order, partly filled at once): that fill keeps its ADR-024 harvest point, and the order's view — and its release — wait for it", async () => {
    ordinal = 0;
    const first = iso(S + 5_000);
    const second = iso(S + 10_000);
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      placeOnFeatures: { market: MARKET_B, at: first, immediate: true },
      placeOnFill: { market: MARKET_B, at: first, restsRemainder: true },
      cancelOnFeatures: { market: MARKET_B, at: second },
    });
    // B's asks: 5 shares at 0.34, then 0.40 — so a 10-share BUY limited to 0.35 fills 5.
    await feed(
      harness,
      ...opening(),
      opened(S + 150, MARKET_B),
      askLevel(S + 200, MARKET_B, "0.4", "500"),
      askLevel(S + 210, MARKET_B, "0.34", "5"),
    );
    const start = harness.seen.length;
    // The first heartbeat's FAK BUY fills 5 and is CANCELLED short; its own fill
    // and view come at once. Its onFill places a GTC BUY: 5 filled at once (an
    // onFill decision's fill, unread until the next harvest point), 5 resting.
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    expect(harness.venue.fills).toHaveLength(2);
    // The second heartbeat cancels B's working order — the GTC one, whose fill is unread.
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(harness.venue.ordersSnapshot().map((order) => `${order.state} ${order.filledShares}/${order.requestedShares}`)).toEqual([
      "CANCELLED 5/10",
      "CANCELLED 5/10",
    ]);
    // Neither that fill nor the cancelled order's view came at the cancel's close:
    // the view reports a fill not yet booked, so its reservation is held too.
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 1 });
    // B's own event: the ordinary harvest books the fill, then delivers the view.
    await feed(harness, level(S + 10_100, MARKET_B, "0.31"));
    const ofB = harness.seen
      .map((entry, index) => ({ entry, shown: harness.shown[index] }))
      .slice(start)
      .filter(({ entry }) => entry.instanceId === INSTANCE_B && entry.callback !== "onFeatures")
      .map(({ entry, shown }) => [entry.callback, entry.evaluatedAt, shown?.yesShares, shown?.orderStatus]);
    expect(ofB).toEqual([
      ["onFill", first, "5", undefined],
      ["onOrderUpdate", first, "5", "CANCELED"],
      // r3 (A-R3-02): the GTC order its onFill placed has its view at the same
      // close, as an ordinary harvest delivers it — reporting the 5 shares
      // filled at once, whose fill keeps its ADR-024 harvest point on both paths.
      ["onOrderUpdate", first, "5", "PARTIALLY_FILLED"],
      ["onFill", iso(S + 10_100), "10", undefined],
      ["onOrderUpdate", iso(S + 10_100), "10", "CANCELED"],
    ]);
    expect(harness.loop.health().execution).toMatchObject({ fillsObserved: 2, duplicateFillsRefused: 0 });
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 0, reservedCollateral: "0" });
    expect(harness.loop.health().seams.orders).toMatchObject({ settled: 2, settleMismatches: 0 });
  });

  it("with nothing earlier unread, a carried harvest moves the fill cursor past its own fills: a venue that retains ONE fill still answers the next one", async () => {
    ordinal = 0;
    const first = iso(S + 5_000);
    const second = iso(S + 10_000);
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      placeOnFeatures: { market: MARKET_B, at: [first, second], immediate: true },
      venueRetention: { fills: 1 },
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(harness.halts.records()).toEqual([]);
    expect(harness.seen.filter((entry) => entry.callback === "onFill").map((entry) => entry.evaluatedAt)).toEqual([first, second]);
    expect(harness.loop.health().execution.fillsObserved).toBe(2);
  });
});

describe("r2 (RB), ADR-026 D2.3 with D5.4-D5.5: a runtime refusal for a cause that can pass is no evaluation; a refusal for good is", () => {
  /** A clock whose `n`-th read from now throws once (the runtime then refuses `CLOCK_INVALID`). */
  class FailsOnceClock extends ManualClock {
    failIn = 0;
    override monotonicNs(): bigint {
      if (this.failIn > 0) {
        this.failIn -= 1;
        if (this.failIn === 0) throw new Error("cadence1: one unreadable runtime start clock");
      }
      return super.monotonicNs();
    }
  }

  it("CLOCK_INVALID before the callback: `last` does not move, so A's next change, 10 ms later, is evaluated — not coalesced", async () => {
    ordinal = 0;
    const clock = new FailsOnceClock(T_OPEN);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, clock });
    await feed(harness, ...opening());
    const count = harness.store.decisions.length;
    clock.failIn = 2;
    await feed(harness, level(S + 1_000, MARKET_A, "0.31"));
    expect(harness.loop.health().loop.refusedEvaluations).toBe(1);
    expect(harness.store.decisions).toHaveLength(count);
    const next = level(S + 1_010, MARKET_A, "0.3");
    await feed(harness, next);
    expect(harness.store.decisions).toHaveLength(count + 1);
    expect(harness.store.decisions.at(-1)?.record.sourceEvent?.eventId).toBe(idOf(next));
  });

  it("CLOCK_INVALID before the callback: A STAYS OWED, so a later close that owes it nothing evaluates it once due", async () => {
    ordinal = 0;
    const clock = new FailsOnceClock(T_OPEN);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, clock });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    clock.failIn = 2;
    await feed(harness, level(S + 1_000, MARKET_A, "0.31"));
    const unknown = snapshot(S + 1_500, MARKET_X, "yes");
    await feed(harness, unknown);
    // The refused call, then the carried one at the event for no configured market.
    expect(featureCalls(harness, start).filter(([market]) => market === "A")).toEqual([
      ["A", featureCalls(harness, start)[0]?.[1], iso(S + 1_000)],
      ["A", idOf(unknown), iso(S + 1_500)],
    ]);
    expect(harness.loop.health().loop.refusedEvaluations).toBe(1);
  });

  it("INSTANCE_PAUSED is a refusal for good: it counts as A's evaluation, so A is not asked again inside the interval", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, throwOnFeatures: { market: MARKET_A, at: iso(S + 1_000) } });
    await feed(harness, ...opening());
    // A's onFeatures throws: contained, and the runtime PAUSES the instance.
    await feed(harness, level(S + 1_000, MARKET_A, "0.31"));
    expect(harness.loop.health().loop.containedEvaluations).toBe(1);
    // Due again: the paused runtime refuses, and that IS A's evaluation.
    await feed(harness, level(S + 2_000, MARKET_A, "0.3"));
    expect(harness.loop.health().loop.refusedEvaluations).toBe(1);
    // 100 ms later: coalesced, not asked again.
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    await feed(harness, level(S + 2_100, MARKET_A, "0.31"));
    expect(harness.loop.health().loop.refusedEvaluations).toBe(1);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced + 1);
  });
});

describe("r2 (RC), ADR-026 D2.11 as corrected: a market whose every instance is halted has its owed evaluation dropped before the cadence is asked", () => {
  it("an owed evaluation NOT YET DUE, while A's only instance is halted, is dropped: nothing is evaluated for it", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const before = harness.loop.health().loop.evaluationsCoalesced;
    const scope = { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A } as const;
    harness.halts.halt(scope, "RUNTIME_PERSISTENCE_FAILED", "test", iso(S + 100));
    await feed(harness, snapshot(S + 200, MARKET_A, "yes"));
    expect(harness.seen.slice(start)).toEqual([]);
    await feed(harness, snapshot(S + 1_000, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toEqual([]);
    // Dropped, not coalesced: nothing was owed any more.
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(before);
  });

  it("a CARRIED evaluation, not yet due, of a market whose only instance is then halted is dropped by the carried pass: nothing is evaluated for it", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    // A owed inside the interval: coalesced and carried.
    await feed(harness, snapshot(S + 200, MARKET_A, "yes"));
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    const scope = { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A } as const;
    harness.halts.halt(scope, "RUNTIME_PERSISTENCE_FAILED", "test", iso(S + 250));
    // A close that owes A nothing, still inside the interval: the carried pass drops A's debt.
    await feed(harness, snapshot(S + 300, MARKET_X, "yes"));
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
    await feed(harness, snapshot(S + 1_000, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toEqual([]);
  });
});

describe("r3 (A-R3-01, A-R3-02), ADR-026 D4 and §9.14: a carried harvest gives its onFill decisions exactly what an ordinary harvest gives them", () => {
  /** What one run did at, and after, the close of interest. */
  interface CloseOutcome {
    /** Every non-`onFeatures` callback at the close, as `[instance, callback, evaluatedAt, order status]`. */
    readonly calls: readonly (readonly [string, string, string, string | undefined])[];
    readonly execution: ReturnType<CoreLoop["health"]>["execution"];
    readonly reservations: ReturnType<CoreLoop["health"]>["seams"]["reservations"];
    readonly allocator: ReturnType<CoreLoop["health"]>["seams"]["allocator"];
    readonly harness: Harness;
  }

  /**
   * B's HEARTBEAT at S + 5,000 places a taker BUY that fills 10 at 0.34 at once.
   * Its close's source is an event of A — a harvest point, so the ORDINARY
   * harvest delivers it (the comparator) — or of X, a market this trader does
   * not run: the CARRIED harvest (`#harvestCarriedEffects`). Everything else is
   * the same, so the two must agree.
   */
  async function heartbeatClose(
    carried: boolean,
    options: Omit<HarnessOptions, "cadence" | "placeOnFeatures">,
    setup: () => readonly IngestedEvent[] = () => [],
  ): Promise<CloseOutcome> {
    ordinal = 0;
    const at = iso(S + 5_000);
    const harness = assemble({ ...options, cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: true } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), ...setup());
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 5_000, carried ? MARKET_X : MARKET_A, "yes"));
    const health = harness.loop.health();
    return {
      calls: harness.seen
        .map((entry, index) => ({ entry, shown: harness.shown[index] }))
        .slice(start)
        .filter(({ entry }) => entry.callback !== "onFeatures")
        .map(({ entry, shown }) => [label(entry.instanceId), entry.callback, entry.evaluatedAt, shown?.orderStatus] as const),
      execution: health.execution,
      reservations: health.seams.reservations,
      allocator: health.seams.allocator,
      harness,
    };
  }

  it("A-R3-01: the heartbeat's FILLED order releases its reservation BEFORE onFill, so under a 4 pUSD cap onFill's covered SELL is admitted, as at an ordinary harvest", async () => {
    const options = { perStrategyCap: "4", placeOnFill: { market: MARKET_B, at: iso(S + 5_000), sells: true } };
    const ordinary = await heartbeatClose(false, options);
    const carried = await heartbeatClose(true, options);
    // The comparator: 3.40 pUSD is in the position, the BUY's 3.40 reservation
    // is released before onFill, and the covered SELL fits the 4 pUSD cap.
    expect(ordinary.execution).toMatchObject({ submissionsAccepted: 2, submissionsRefused: 0 });
    // The carried harvest: the same, at the same instant — the reservation is
    // not counted beside the position that replaced it (§9.14).
    expect(carried.execution).toEqual(ordinary.execution);
    expect(carried.allocator).toEqual(ordinary.allocator);
    expect(carried.reservations).toEqual(ordinary.reservations);
    expect(carried.calls).toEqual(ordinary.calls);
    expect(carried.harness.halts.records()).toEqual([]);
    // Non-vacuous: the SELL rests at the venue on both paths.
    for (const run of [ordinary, carried]) {
      expect(run.harness.venue.ordersSnapshot().map((order) => `${order.action} ${order.state}`)).toEqual([
        "BUY FILLED",
        "SELL RESTING",
      ]);
    }
  });

  it("A-R3-02: an order an onFill delivery places at a carried harvest has its view delivered at that same close, as at an ordinary harvest — not at the next harvest point", async () => {
    const options = { placeOnFill: { market: MARKET_B, at: iso(S + 5_000), sells: true } };
    const ordinary = await heartbeatClose(false, options);
    const carried = await heartbeatClose(true, options);
    const at = iso(S + 5_000);
    expect(ordinary.calls).toEqual([
      ["B", "onFill", at, undefined],
      ["B", "onOrderUpdate", at, "FILLED"],
      // The take-profit SELL onFill placed: its view at the same close.
      ["B", "onOrderUpdate", at, "OPEN"],
    ]);
    expect(carried.calls).toEqual(ordinary.calls);
    expect(carried.reservations).toEqual(ordinary.reservations);
    // Later heartbeats at events for no configured market deliver nothing more:
    // the SELL's view was delivered, and nothing else is the carried passes' own.
    const before = carried.harness.seen.length;
    for (const offset of [10_000, 15_000, 20_000]) await feed(carried.harness, snapshot(S + offset, MARKET_X, "yes"));
    expect(carried.harness.seen.slice(before).filter((entry) => entry.callback !== "onFeatures")).toEqual([]);
  });

  it("A-R3-02, exact parity: an onFill decision's order that FILLS AT ONCE has its FILLED view, and its release, at the same close, as at an ordinary harvest; its fill keeps its ADR-024 harvest point", async () => {
    const options = { placeOnFill: { market: MARKET_B, at: iso(S + 5_000) } };
    const ordinary = await heartbeatClose(false, options);
    const carried = await heartbeatClose(true, options);
    const at = iso(S + 5_000);
    expect(ordinary.calls).toEqual([
      ["B", "onFill", at, undefined],
      ["B", "onOrderUpdate", at, "FILLED"],
      ["B", "onOrderUpdate", at, "FILLED"],
    ]);
    expect(carried.calls).toEqual(ordinary.calls);
    expect(carried.reservations).toEqual(ordinary.reservations);
    expect(carried.reservations).toMatchObject({ open: 0, taken: 2, released: 2, reservedCollateral: "0" });
    expect(carried.allocator).toEqual(ordinary.allocator);
    // The onFill decision's own fill is NOT read at this close on either path:
    // it keeps its ADR-024 harvest point (the next one).
    expect(carried.execution.fillsObserved).toBe(1);
    expect(ordinary.execution.fillsObserved).toBe(1);
    expect(carried.harness.venue.fills).toHaveLength(2);

    // Until that harvest point, heartbeats at events for no configured market
    // see the same position and the same account on BOTH paths: the window
    // before that fill is booked is the cadence's (O-R3-01), not the carried
    // harvest's.
    const later = async (run: CloseOutcome) => {
      const from = run.harness.seen.length;
      for (const offset of [10_000, 15_000]) await feed(run.harness, snapshot(S + offset, MARKET_X, "yes"));
      const health = run.harness.loop.health();
      return {
        calls: run.harness.seen
          .map((entry, index) => ({ entry, shown: run.harness.shown[index] }))
          .slice(from)
          .map(({ entry, shown }) => [label(entry.instanceId), entry.callback, entry.evaluatedAt, shown?.yesShares]),
        reservations: health.seams.reservations,
        allocator: health.seams.allocator,
        fillsObserved: health.execution.fillsObserved,
      };
    };
    const ordinaryLater = await later(ordinary);
    expect(await later(carried)).toEqual(ordinaryLater);
    expect(ordinaryLater.calls).toEqual([
      ["A", "onFeatures", iso(S + 10_000), "0"],
      ["B", "onFeatures", iso(S + 10_000), "10"],
      ["A", "onFeatures", iso(S + 15_000), "0"],
      ["B", "onFeatures", iso(S + 15_000), "10"],
    ]);
    expect(ordinaryLater.fillsObserved).toBe(1);

    // B's own event: the next harvest point books that fill and delivers it
    // once; the order, retired at its FILLED view, is not delivered again, and
    // both orders settle with every share booked.
    const bookB = level(S + 15_100, MARKET_B, "0.31");
    const before = carried.harness.seen.length;
    await feed(carried.harness, bookB);
    expect(
      carried.harness.seen
        .map((entry, index) => ({ entry, shown: carried.harness.shown[index] }))
        .slice(before)
        .filter(({ entry }) => entry.callback !== "onFeatures")
        .map(({ entry, shown }) => [label(entry.instanceId), entry.callback, entry.evaluatedAt, shown?.yesShares]),
    ).toEqual([["B", "onFill", iso(S + 15_100), "20"]]);
    const health = carried.harness.loop.health();
    expect(health.execution).toMatchObject({ fillsObserved: 2, duplicateFillsRefused: 0 });
    expect(health.seams.orders).toMatchObject({ settled: 2, settleMismatches: 0 });
  });

  it("A-R3-02, exact parity: an onFill decision's GTC order PARTLY filled at once has its working view at the same close on both paths, and keeps its reservation", async () => {
    // B's asks: 5 shares at 0.34, then 0.40 — the heartbeat's FAK BUY fills 5
    // and is cancelled short; its onFill's GTC BUY fills 5 at once and rests 5.
    const setup = () => [askLevel(S + 200, MARKET_B, "0.4", "500"), askLevel(S + 210, MARKET_B, "0.34", "5")];
    const options = { placeOnFill: { market: MARKET_B, at: iso(S + 5_000), restsRemainder: true } };
    const ordinary = await heartbeatClose(false, options, setup);
    const carried = await heartbeatClose(true, options, setup);
    const at = iso(S + 5_000);
    expect(ordinary.calls).toEqual([
      ["B", "onFill", at, undefined],
      ["B", "onOrderUpdate", at, "CANCELED"],
      ["B", "onOrderUpdate", at, "PARTIALLY_FILLED"],
    ]);
    expect(carried.calls).toEqual(ordinary.calls);
    expect(carried.reservations).toEqual(ordinary.reservations);
    expect(carried.reservations).toMatchObject({ open: 1, taken: 2, released: 1 });
    expect(carried.allocator).toEqual(ordinary.allocator);
  });

  it("A-R3-02: an order an onFill decision CANCELS at a carried harvest is gated like the pass's own cancels — with a fill still unread, its view and its release wait for the harvest that books that fill", async () => {
    ordinal = 0;
    const first = iso(S + 5_000);
    const second = iso(S + 10_000);
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      placeOnFeatures: { market: MARKET_B, at: [first, second], immediate: true },
      placeOnFill: { market: MARKET_B, at: first, restsRemainder: true },
      cancelOnFill: { market: MARKET_B, at: second },
    });
    // B's asks: 5 shares at 0.34, then 0.40.
    await feed(
      harness,
      ...opening(),
      opened(S + 150, MARKET_B),
      askLevel(S + 200, MARKET_B, "0.4", "500"),
      askLevel(S + 210, MARKET_B, "0.34", "5"),
    );
    const start = harness.seen.length;
    // The first heartbeat: its FAK BUY fills 5; onFill places a GTC BUY that
    // fills 5 at once (that fill unread until the next harvest point) and rests 5.
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    // The second heartbeat: its FAK BUY fills 5; ITS onFill cancels B's working
    // orders — the GTC one, whose fill is still unread.
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(harness.venue.ordersSnapshot().map((order) => `${order.state} ${order.filledShares}/${order.requestedShares}`)).toEqual([
      "CANCELLED 5/10",
      "CANCELLED 5/10",
      "CANCELLED 5/10",
    ]);
    // The GTC order's view and its reservation wait: the view reports a fill not yet booked.
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 1 });
    await feed(harness, level(S + 10_100, MARKET_B, "0.31"));
    const ofB = harness.seen
      .map((entry, index) => ({ entry, shown: harness.shown[index] }))
      .slice(start)
      .filter(({ entry }) => entry.instanceId === INSTANCE_B && entry.callback !== "onFeatures")
      .map(({ entry, shown }) => [entry.callback, entry.evaluatedAt, shown?.yesShares, shown?.orderStatus]);
    expect(ofB).toEqual([
      ["onFill", first, "5", undefined],
      ["onOrderUpdate", first, "5", "CANCELED"],
      ["onOrderUpdate", first, "5", "PARTIALLY_FILLED"],
      ["onFill", second, "10", undefined],
      // The second heartbeat's own FAK order; NOT the GTC order its onFill cancelled.
      ["onOrderUpdate", second, "10", "CANCELED"],
      // B's own event: the ordinary harvest books the GTC order's fill, then delivers its view.
      ["onFill", iso(S + 10_100), "15", undefined],
      ["onOrderUpdate", iso(S + 10_100), "15", "CANCELED"],
    ]);
    expect(harness.loop.health().execution).toMatchObject({ fillsObserved: 3, duplicateFillsRefused: 0 });
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 0, reservedCollateral: "0" });
    expect(harness.loop.health().seams.orders).toMatchObject({ settled: 3, settleMismatches: 0 });
  });
});

describe("r3 (O-R3-02): the carried harvest's flush order, and a placement the venue booked only in part", () => {
  it("MY10: a heartbeat's plan the venue books only IN PART (refused, PARTIAL) — the booked orders are still its own: their views come at its close", async () => {
    ordinal = 0;
    const at = iso(S + 5_000);
    // 16 resting slices; a 15-token order budget books the first batch of 15
    // and refuses the second (all-or-nothing per batch, D-05).
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      placeOnFeatures: { market: MARKET_B, at, immediate: false, slices: 16 },
      rateLimits: tokenBucketRateLimits({
        orderTokensPerWindow: 15,
        cancelTokensPerWindow: 10,
        windowMs: 3_600_000,
        snapshotVersion: "cadence1-r3-partial",
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    const health = harness.loop.health();
    expect(health.execution).toMatchObject({ submissionsRefused: 1, submissionsAccepted: 0, reservationsReleasedOnRefusal: 1 });
    expect(harness.venue.ordersSnapshot()).toHaveLength(15);
    expect(harness.halts.records()).toEqual([]);
    const views = harness.seen
      .map((entry, index) => ({ entry, shown: harness.shown[index] }))
      .slice(start)
      .filter(({ entry }) => entry.callback === "onOrderUpdate")
      .map(({ entry, shown }) => [label(entry.instanceId), entry.evaluatedAt, shown?.orderStatus]);
    expect(views).toEqual(Array.from({ length: 15 }, () => ["B", at, "OPEN"]));
    // Every invocation's decision is in the store when the drain returns.
    expect(harness.store.decisions).toHaveLength(harness.seen.length);
  });
});

describe("r3 (O-R3-03): each runtime refusal code is classified — a refusal that can pass is no evaluation; a refusal for good is", () => {
  const codes: readonly (readonly [EvaluationRefusalCode, "TRANSIENT" | "PERMANENT"])[] = [
    ["CLOCK_INVALID", "TRANSIENT"],
    ["INPUT_INVALID", "TRANSIENT"],
    ["EVALUATION_REENTRANT", "TRANSIENT"],
    ["INSTANCE_PAUSED", "PERMANENT"],
    ["INSTANCE_STOPPED", "PERMANENT"],
    ["EVALUATION_SEQ_EXHAUSTED", "PERMANENT"],
  ];

  it.each(codes)("%s is %s: A's next change, 10 ms later, is evaluated only if the refusal can pass", async (code, persistence) => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, refuseOnFeatures: { market: MARKET_A, at: iso(S + 1_000), code } });
    await feed(harness, ...opening());
    const count = harness.store.decisions.length;
    await feed(harness, level(S + 1_000, MARKET_A, "0.31"));
    expect(harness.loop.health().loop.refusedEvaluations).toBe(1);
    expect(harness.store.decisions).toHaveLength(count);
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    const next = level(S + 1_010, MARKET_A, "0.3");
    await feed(harness, next);
    if (persistence === "TRANSIENT") {
      // `last` did not move: A is asked again, and decides.
      expect(harness.store.decisions).toHaveLength(count + 1);
      expect(harness.store.decisions.at(-1)?.record.sourceEvent?.eventId).toBe(idOf(next));
      expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
    } else {
      // The refusal was A's evaluation: inside the interval A is coalesced, not asked.
      expect(harness.store.decisions).toHaveLength(count);
      expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced + 1);
    }
    expect(harness.loop.health().loop.refusedEvaluations).toBe(1);
  });
});

describe("TC-LOWS-1 (CAD1-R4-01): each round-3 guard of the carried harvest is pinned — the carried path against the ordinary one, and against the values", () => {
  /** What one run showed at, and after, the close of interest. */
  interface Close {
    /** Every non-`onFeatures` callback since `start`, as `[instance, callback, evaluatedAt, YES shares, order status]`. */
    readonly calls: readonly (readonly [string, string, string, string | undefined, string])[];
    readonly submissions: { readonly accepted: number; readonly refused: number };
    readonly riskRefusals: Readonly<Record<string, number>>;
    readonly allocatorRefusals: Readonly<Record<string, number>>;
    readonly reservations: ReturnType<CoreLoop["health"]>["seams"]["reservations"];
    readonly allocator: { readonly open: number; readonly reservedCollateral: string };
    readonly orders: readonly string[];
    readonly halts: number;
  }

  function closeOf(harness: Harness, start: number): Close {
    const health = harness.loop.health();
    return {
      calls: harness.seen
        .map((entry, index) => ({ entry, shown: harness.shown[index] }))
        .slice(start)
        .filter(({ entry }) => entry.callback !== "onFeatures")
        .map(({ entry, shown }) => [label(entry.instanceId), entry.callback, entry.evaluatedAt, shown?.yesShares, shown?.orderStatus ?? ""] as const),
      submissions: { accepted: health.execution.submissionsAccepted, refused: health.execution.submissionsRefused },
      riskRefusals: health.risk.refusalsByCode,
      allocatorRefusals: health.seams.allocator.refusalsByCode,
      reservations: health.seams.reservations,
      allocator: { open: health.seams.allocator.open, reservedCollateral: health.seams.allocator.reservedCollateral },
      orders: harness.venue.ordersSnapshot().map((order) => `${order.action} ${order.state} ${order.filledShares}`),
      halts: harness.halts.records().length,
    };
  }

  it("MZ9 (`#releaseSettledOwn`'s terminal check): a heartbeat's own RESTING order — nothing filled, so every fill it reports is booked — is NOT terminal: the carried harvest keeps its reservation and allocator commitment, as the ordinary harvest does (§9.14)", async () => {
    const at = iso(S + 5_000);
    const run = async (carried: boolean): Promise<Close> => {
      ordinal = 0;
      const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: false } });
      await feed(harness, ...opening(), opened(S + 150, MARKET_B));
      const start = harness.seen.length;
      // B's heartbeat at S + 5 000 places a resting maker BUY (10 at 0.30). The
      // close's source is an event of X (the CARRIED harvest) or of A (ordinary).
      await feed(harness, snapshot(S + 5_000, carried ? MARKET_X : MARKET_A, "yes"));
      return closeOf(harness, start);
    };
    const ordinary = await run(false);
    const carried = await run(true);
    expect(carried.calls).toEqual([["B", "onOrderUpdate", at, "0", "OPEN"]]);
    expect(carried.orders).toEqual(["BUY RESTING 0"]);
    // Still reserved: 10 × 0.30 = 3 pUSD in both books.
    expect(carried.reservations).toMatchObject({ open: 1, taken: 1, released: 0, reservedCollateral: "3" });
    expect(carried.allocator).toEqual({ open: 1, reservedCollateral: "3" });
    expect(carried).toEqual(ordinary);
  });

  it("MZ8 (`#releaseSettledOwn(effects.touched, …)`, not `placed`): a heartbeat that CANCELS A's resting order while B's heartbeat fills — A's cancelled reservation is released BEFORE onFill, so B's onFill BUY is admitted under a 7 pUSD global cap, as at an ordinary harvest", async () => {
    const at = iso(S + 5_000);
    const run = async (carried: boolean): Promise<Close> => {
      ordinal = 0;
      const harness = assemble({
        cadence: PAPER_EVALUATION_CADENCE,
        globalAccountCap: "7",
        // A rests a maker BUY at its open (10 at 0.30: 3 pUSD reserved).
        placeOnOpen: true,
        // At S + 5 000, A's heartbeat cancels it; B's heartbeat BUY fills 10 at 0.34
        // at once, and B's onFill places another taker BUY (up to 4 pUSD).
        cancelOnFeatures: { market: MARKET_A, at },
        placeOnFeatures: { market: MARKET_B, at, immediate: true },
        placeOnFill: { market: MARKET_B, at },
      });
      await feed(harness, ...opening(), opened(S + 100, MARKET_A), opened(S + 150, MARKET_B));
      const start = harness.seen.length;
      // The close's source is an event of X (the CARRIED harvest), or a book
      // of B itself (an ordinary harvest at the same instant).
      await feed(harness, carried ? snapshot(S + 5_000, MARKET_X, "yes") : level(S + 5_000, MARKET_B, "0.31"));
      return closeOf(harness, start);
    };
    const ordinary = await run(false);
    const carried = await run(true);
    // The onFill BUY is admitted: A's 3 pUSD came back before onFill ran.
    expect(carried.submissions).toEqual({ accepted: 4, refused: 0 });
    expect(carried.riskRefusals).toEqual({});
    expect(carried.allocatorRefusals).toEqual({});
    expect(carried.orders).toEqual(["BUY CANCELLED 0", "BUY FILLED 10", "BUY FILLED 10"]);
    expect(carried.calls).toEqual([
      ["B", "onFill", at, "10", ""],
      ["A", "onOrderUpdate", at, "0", "CANCELED"],
      ["B", "onOrderUpdate", at, "10", "FILLED"],
      ["B", "onOrderUpdate", at, "10", "FILLED"],
    ]);
    expect(carried.reservations).toMatchObject({ open: 0, taken: 3, released: 3, reservedCollateral: "0" });
    expect(carried.halts).toBe(0);
    expect(carried).toEqual(ordinary);
  });

  it("MZ6 (the view boundary takes `delivered.touched`, not `placed`): an order an onFill decision CANCELS at a carried harvest — fully booked, a resting covered SELL — has its CANCELED view, and its release, at that close, as at an ordinary harvest", async () => {
    const first = iso(S + 5_000);
    const second = iso(S + 10_000);
    const run = async (carried: boolean): Promise<Close> => {
      ordinal = 0;
      const harness = assemble({
        cadence: PAPER_EVALUATION_CADENCE,
        placeOnFeatures: { market: MARKET_B, at: [first, second], immediate: true },
        // The first heartbeat's fill: onFill rests a covered SELL of the 10 shares.
        placeOnFill: { market: MARKET_B, at: first, sells: true },
        // The second heartbeat's fill: onFill cancels B's working orders (the SELL).
        cancelOnFill: { market: MARKET_B, at: second },
      });
      await feed(harness, ...opening(), opened(S + 150, MARKET_B));
      await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
      const start = harness.seen.length;
      await feed(harness, snapshot(S + 10_000, carried ? MARKET_X : MARKET_A, "yes"));
      return closeOf(harness, start);
    };
    const ordinary = await run(false);
    const carried = await run(true);
    expect(carried.calls).toEqual([
      ["B", "onFill", second, "20", ""],
      // The SELL the onFill decision cancelled: its terminal view, at this close.
      ["B", "onOrderUpdate", second, "20", "CANCELED"],
      ["B", "onOrderUpdate", second, "20", "FILLED"],
    ]);
    expect(carried.orders).toEqual(["BUY FILLED 10", "SELL CANCELLED 0", "BUY FILLED 10"]);
    // Every reservation is released: the SELL's with its CANCELED view.
    expect(carried.reservations).toMatchObject({ open: 0, taken: 3, released: 3, reservedCollateral: "0" });
    expect(carried.allocator).toEqual({ open: 0, reservedCollateral: "0" });
    expect(carried).toEqual(ordinary);
  });
});
