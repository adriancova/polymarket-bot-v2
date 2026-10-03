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
 *   and re-stamps none; a carried-over or heartbeat evaluation whose source is
 *   not at its close's harvest instant has its own effects delivered at the
 *   next harvest point;
 * - O02, O04, O05 — the coalescence count over a longer frame, a lifecycle
 *   event at a carried market, and `[A, A]` under the per-frame value 0.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
} from "@polymarket-bot/simulation";
import { createStrategyInstanceRuntime, type EvaluationInput } from "@polymarket-bot/strategy-runtime";
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

function traderConfig(): Record<string, unknown> {
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
      globalAccountCap: "10000",
      perStrategyCap: "1000",
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
 */
interface PlaceOnFeatures {
  readonly market: string;
  readonly at: string;
  readonly immediate: boolean;
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
): Strategy<unknown, Record<string, never>> {
  const buy = (ctx: StrategyContext, intentId: string, immediate: boolean): Intent => ({
    type: "POSITION",
    intentId,
    marketId,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: "10",
    maximumBuyPrice: immediate ? "0.35" : "0.3",
    maximumTotalCost: immediate ? "4" : "3",
    urgency: immediate ? "IMMEDIATE" : "PASSIVE",
    liquidityPreference: immediate ? "TAKER_OK" : "MAKER_ONLY",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: new Date(Date.parse(ctx.now()) + 600_000).toISOString(),
    expectedNetEdge: "5",
    tags: ["cadence1.entry", immediate ? "sb.order-type:FAK" : "sb.order-type:GTC"],
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
      if (onFeaturesAt === undefined || ctx.now() !== onFeaturesAt.at) return hold(ctx);
      return {
        decisionType: "enter",
        reasonCodes: ["CADENCE1.PLACE"],
        featureSnapshotRef: ctx.features().snapshotRef,
        intents: [buy(ctx, "cadence1-features-buy", onFeaturesAt.immediate)],
      };
    },
    onFill: (ctx: StrategyContext) => hold(ctx),
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

interface Harness {
  readonly loop: CoreLoop;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly halts: HaltController;
  readonly seen: Seen[];
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
}

/** `createPaperTrader`'s assembly, with the recording double's runtimes registered. */
function assemble(options: HarnessOptions): Harness {
  const parsed = parseTraderConfig(traderConfig());
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
    vi.spyOn(created.runtime, "evaluate").mockImplementation((input: EvaluationInput) => {
      seen.push({
        instanceId,
        callback: input.callback,
        evaluatedAt: input.evaluatedAt,
        source: input.sourceEvent?.eventId,
      });
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
    rateLimits: unmodeledRateLimits("no venue rate-limit budget is modelled in this test"),
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
  return { loop, venue, store, halts, seen, alarms };
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
    harness.halts.halt({ kind: "MARKET", marketId: MARKET_A }, "OPERATOR_HALT", "test", iso(S + 400));
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

  it("a market whose ONLY instance is halted is not evaluated: `last` stays, the owed evaluation is dropped, and after the release its next owed close evaluates it", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    const scope = { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A } as const;
    harness.halts.halt(scope, "OPERATOR_HALT", "test", iso(S + 400));
    // A owed and due by the cadence, but its one instance is halted: no runtime is asked.
    await feed(harness, level(S + 1_000, MARKET_A, "0.31"));
    expect(featureCalls(harness, start)).toEqual([]);
    expect(harness.halts.release(scope, { authoritativeSnapshotApplied: true, reason: "test" })).toBe(true);
    // Dropped, not carried: an event for no configured market evaluates nothing.
    await feed(harness, snapshot(S + 1_100, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toEqual([]);
    // `last` is still S, so A's next owed close — 200 ms after the halted one — evaluates it.
    const next = level(S + 1_200, MARKET_A, "0.3");
    await feed(harness, next);
    expect(featureCalls(harness, start)).toEqual([["A", idOf(next), iso(S + 1_200)]]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
  });

  it("with A's OWNER instance halted and its SHADOW instance evaluated, the market WAS evaluated: `last` moves", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, shadowOnA: true });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    harness.halts.halt({ kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_A }, "OPERATOR_HALT", "test", iso(S + 400));
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

  it("a heartbeat at an event for no configured market: no harvest there; its own fill and order view come at the next harvest point, stamped there — never before their source", async () => {
    ordinal = 0;
    const at = iso(S + 5_000);
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnFeatures: { market: MARKET_B, at, immediate: true } });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    // B's heartbeat placed a taker order, which the venue filled at once. The
    // order went out at once; nothing is delivered at this event.
    expect(harness.venue.fills).toHaveLength(1);
    expect(harness.seen.slice(start).map((entry) => [label(entry.instanceId), entry.callback])).toEqual([
      ["A", "onFeatures"],
      ["B", "onFeatures"],
    ]);
    // The next harvest point: A's event (A coalesced). B's fill and its order's view, stamped there.
    await feed(harness, level(S + 5_200, MARKET_A, "0.31"));
    expect(harness.seen.slice(start + 2).map((entry) => [label(entry.instanceId), entry.callback, entry.evaluatedAt])).toEqual([
      ["B", "onFill", iso(S + 5_200)],
      ["B", "onOrderUpdate", iso(S + 5_200)],
    ]);
  });

  it("a mixed frame whose tail is for no configured market: the frame's harvest runs at its own instant, first; the heartbeat's own new order is delivered at the next harvest point", async () => {
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
      // Then B's heartbeat, at the frame's last applied event; it places a resting order.
      ["B", "onFeatures", iso(S + 5_100)],
      // The next harvest point (the reference trade; A and B coalesced there): both orders' views.
      ["A", "onOrderUpdate", iso(S + 5_300)],
      ["B", "onOrderUpdate", iso(S + 5_300)],
    ]);
    // A's own callbacks are exactly per-frame's.
    const perFrame = await run(PER_FRAME);
    const ofA = (harness: Harness, from: number) => others(harness, from).filter((entry) => entry.instanceId === INSTANCE_A);
    expect(ofA(paper.harness, paper.start)).toEqual(ofA(perFrame.harness, perFrame.start));
  });
});
