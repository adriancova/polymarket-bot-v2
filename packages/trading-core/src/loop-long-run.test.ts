/**
 * `TRDR-4` item 7 — a DETERMINISTIC LONG SYNTHETIC RUN of the real `CoreLoop`.
 *
 * NOT soak evidence. Handoff §16.7: "Time-based operational gates cannot be
 * faked by an agent." This is a unit-style test over recorded instants that
 * proves one structural claim — the loop's per-order state tracks WORKING
 * orders rather than history, and per-event `onOrderUpdate` deliveries do not
 * grow with the number of orders ever placed — and nothing about elapsed-time
 * memory behaviour. It also does not claim the process is memory-bounded:
 * `#pnlRecords` and the in-memory `Ledger` still grow (`LOOPMEM-FOLD`).
 *
 * SIM-2 adds a second run in the same harness (the last `describe`), just as
 * synthetic and just as NOT a soak: the `SimulatedVenue` holds its LIVE orders
 * plus bounded, counted history, and the loop makes no call proportional to
 * that history — no `ordersSnapshot()`, no copy of the fill list, one fill
 * cursor read per harvest and lookups by id.
 *
 * WHAT IS REAL: the `CoreLoop`, the strategy RUNTIME, feature engine, books,
 * capital allocator, risk engine, execution planner, `SimulatedVenue` (Tier 0),
 * ledger and PnL. WHAT IS DOUBLED: the clock and the durable store (the
 * trader's own in-memory doubles), and the STRATEGY — Static Bracket opens at
 * most `reentry.maximum_entries_per_market` brackets per market, each a handful
 * of orders (it used to pause after the first, `RISK-2` residual 5, closed by
 * `BRACKET-1a`), so it cannot place hundreds of orders. The double runs through
 * the real runtime and emits the
 * same §7.7 intent shapes Static Bracket emits:
 *
 * - a resting BUY of 50 at 0.2 (`MAKER_ONLY`, `PASSIVE`, `GTC`), which the
 *   planner slices into TEN 5-share orders (`planning.maxSliceShares: "5"`);
 * - on the next tick, a CANCEL naming every working order it sees;
 * - every twentieth cycle instead an immediate BUY of 50 (`TAKER_OK`, FAK),
 *   sliced and FILLED on submission, then an immediate SELL of the whole
 *   holding. Rare on purpose: every booked fill grows the in-memory ledger that
 *   `projectLedger` re-folds on every evaluation (`LOOPMEM-FOLD`, NOT bounded
 *   by `TRDR-4`), so a fill-heavy run measures that fold rather than the maps
 *   this test is about.
 *
 * And it ADOPTS the way Static Bracket's `adoptOrder` does — the first
 * `ctx.orders()` view matching (outcome, side), with NO status filter — and
 * records `TRDR4.ADOPTED_TERMINAL` if that view is terminal. Under the pre-R1
 * loop `ctx.orders()` carried every order ever placed, so a new cycle adopted
 * an earlier cycle's terminal order; this run pins that it never can.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import {
  DEFAULT_VENUE_RETENTION,
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type VenueRetentionBounds,
} from "@polymarket-bot/simulation";
import {
  createStrategyInstanceRuntime,
  type EvaluationInput,
  type EvaluationOutcome,
} from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext, StrategyOrderView } from "@polymarket-bot/strategy-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PAPER_EVALUATION_CADENCE, PER_FRAME_EVALUATION_CADENCE, type EvaluationCadenceOption } from "./cadence.js";
import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import { EVERY_FILL_ACCOUNTING_CHECKS } from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer } from "./loop.js";
import { MarketState } from "./market-state.js";
import type { RetentionBounds } from "./order-lifecycle.js";
import type { IngestedEvent } from "./ports.js";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "./safety.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";

const MARKET_ID = "018f5c20-1000-7a10-8b00-0000000000a1";
const CONDITION_ID = "0xtrdr4longrun";
const YES_TOKEN = "7001";
const NO_TOKEN = "7002";
const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-0000000000a2";
const RUN_ID = "018f5c20-3000-7a30-8b00-0000000000a3";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000000a4";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-0000000000a5";
const T_START_MS = Date.parse("2026-05-01T09:00:00.000Z");
const T_OPEN = "2026-05-01T09:00:00.000Z";
/** Far away: no time-to-close gate fires during the run. */
const T_CLOSE = "2026-05-02T09:00:00.000Z";
/** Recorded spacing between events. 100 ms keeps every freshness window satisfied. */
const STEP_MS = 100;

const TERMINAL = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
/** One immediate round trip per this many strategy steps (two steps per cycle). */
const IMMEDIATE_EVERY_STEPS = 40;

/**
 * `TC-LOWS-1` (O07): every test of this file runs at BOTH evaluation
 * cadences — ADR-024's per-frame value 0, as a declared reproduction
 * (ADR-026 D1.6), under the test names it always had, and the production
 * cadence every new run uses (ADR-026 D1.5: 1,000 ms / 5,000 ms), under the
 * same names with {@link PRODUCTION_SUFFIX}.
 *
 * The events stay {@link STEP_MS} (100 ms) apart at both cadences, so at the
 * production one the double's `onFeatures` runs at most once per ten events:
 * an event less than 1,000 ms of event time after the market's last
 * evaluation does not evaluate it (ADR-026 D2.4) and is coalesced (D5), while
 * every harvest point — every fill and order view — is unchanged (D4). That
 * is the production regime of a busy book, and every per-event claim below is
 * checked at EVERY event of it, coalesced or not. Where a test counts strategy
 * STEPS in events, it says so at the count and scales it by
 * {@link STEPS_APART} (1,000 ms / 100 ms = 10 events per step).
 */
interface CadenceCase {
  readonly production: boolean;
  readonly option: EvaluationCadenceOption;
}
const REPRODUCTION: CadenceCase = {
  production: false,
  option: { ...PER_FRAME_EVALUATION_CADENCE, reproduces: "adr-024:packages/trading-core/src/loop-long-run.test.ts" },
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

/**
 * How many events apart two strategy steps are: 1 at the per-frame cadence,
 * 10 at the production one (ADR-026 D2.4: 1,000 ms of event time at
 * {@link STEP_MS}).
 */
function stepsApart(): number {
  return cadence.production ? 1_000 / STEP_MS : 1;
}

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "trdr4.sim.2026-05-01",
    takerFeeRate: "0.0195",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

/** The harness's knobs; every default is the TRDR-4 run's. */
interface HarnessOptions {
  /** The venue's history bounds (SIM-2); the venue's defaults when absent. */
  readonly venueRetention?: VenueRetentionBounds;
  /** `features.tradeWindowMs`: how much of the public-trade tape a snapshot reads. */
  readonly tradeWindowMs?: number;
  readonly strategy?: Strategy<unknown, CyclingState>;
}

function traderConfig(options: HarnessOptions = {}): Record<string, unknown> {
  const fees = feeSnapshot();
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
      accountRef: "trdr4-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "trdr4-venue-clearing",
      attributionClearingRef: "trdr4-attribution-clearing",
      feeExpenseRef: "trdr4-fee-expense",
      startingCash: "1000",
    },
    queues: { ingestMaximumDepth: 1024, outboxMaximumDepth: 1024 },
    features: {
      depthLevels: [1, 2, 5],
      executableShares: ["50"],
      tradeWindowMs: options.tradeWindowMs ?? 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    planning: {
      maxSliceShares: "5",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.trdr4",
      fillModelParametersHash: "c".repeat(64),
      feeSchedule: { ...fees },
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
      consumerId: "trdr-4-long-run",
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
        // A SIMULATED market this file specifies in full.
        settlementReadiness: { modelDependentActivationAllowed: true },
        openTime: T_OPEN,
        closeTime: T_CLOSE,
        seriesKey: "trdr4-long-run-sim",
        underlyingKey: "SIMBTC",
        resolutionWindowKey: "w2026-05-02T09.00",
      },
    ],
    // The document names the instance (the door requires one); its `params`
    // are the double's own (empty) document, validated by the double's schema
    // when its runtime is created below — this test does not go through
    // `createPaperTrader`, whose strategy is Static Bracket.
    instances: [
      {
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        configId: CONFIG_ID,
        runSeed: "4",
        marketId: MARKET_ID,
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5_000_000,
        params: {},
      },
    ],
  };
}

type CyclingState = { readonly step?: number };

function hold(ctx: StrategyContext): DecisionResult {
  return { decisionType: "hold", reasonCodes: ["TRDR4.HOLD"], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
}

function validUntil(ctx: StrategyContext): string {
  return new Date(Date.parse(ctx.now()) + 30_000).toISOString();
}

/** Static Bracket's `adoptOrder` rule: the first view by id matching (outcome, side), whatever its status. */
function adopt(orders: readonly StrategyOrderView[]): StrategyOrderView | undefined {
  return [...orders]
    .sort((left, right) => (left.orderId < right.orderId ? -1 : left.orderId > right.orderId ? 1 : 0))
    .find((order) => order.outcome === "YES" && order.side === "BUY");
}

/**
 * The cycling double, parametrized (SIM-2): which strategy steps place the
 * IMMEDIATE round trip, and the BUY's size. The TRDR-4 run uses every
 * fortieth step and 50 shares.
 */
function cyclingStrategyWith(options: {
  readonly immediate: (step: number) => boolean;
  readonly targetShares: string;
}): Strategy<unknown, CyclingState> {
  return {
    name: "trdr4-cycling-double",
    version: "1.0.0",
    paramsSchema: z.strictObject({}),
    stateSchemaVersion: 1,
    onStart: hold,
    onMarketOpen: hold,
    onTimer: hold,
    onFill: (ctx: StrategyContext) => hold(ctx),
    onOrderUpdate: (ctx: StrategyContext) => hold(ctx),
    onMarketClosing: (ctx: StrategyContext) => hold(ctx),
    onMarketResolved: (ctx: StrategyContext) => hold(ctx),
    onStop: (ctx: StrategyContext) => hold(ctx),
    onFeatures(ctx: StrategyContext): DecisionResult {
      const step = ctx.state<CyclingState>().step ?? 0;
      const orders = ctx.orders();
      const adopted = adopt(orders);
      const reasonCodes =
        adopted !== undefined && TERMINAL.has(adopted.status) ? ["TRDR4.ADOPTED_TERMINAL"] : ["TRDR4.STEP"];
      const base = { reasonCodes, featureSnapshotRef: ctx.features().snapshotRef, statePatch: { step: step + 1 } };
      const working = orders.filter((order) => !TERMINAL.has(order.status)).map((order) => order.orderId);
      if (working.length > 0) {
        const cancel: Intent = { type: "CANCEL", marketId: MARKET_ID, orderIds: working, reason: "TRDR-4 long run" };
        return { ...base, decisionType: "cancel" as const, intents: [cancel] };
      }
      const held = ctx.position().yesShares;
      if (held !== "0") {
        const sell: Intent = {
          type: "POSITION",
          intentId: `trdr4-sell-${String(step)}`,
          marketId: MARKET_ID,
          direction: "YES",
          targetMode: "DELTA",
          targetShares: `-${held}`,
          minimumSellPrice: "0.3",
          urgency: "IMMEDIATE",
          liquidityPreference: "TAKER_OK",
          partialFillPolicy: "ACCEPT_ANY",
          validUntil: validUntil(ctx),
          tags: ["trdr4.exit", "sb.order-type:FAK"],
        };
        return { ...base, decisionType: "exit" as const, intents: [sell] };
      }
      const immediate = options.immediate(step);
      const buy: Intent = {
        type: "POSITION",
        intentId: `trdr4-buy-${String(step)}`,
        marketId: MARKET_ID,
        direction: "YES",
        targetMode: "DELTA",
        targetShares: options.targetShares,
        maximumBuyPrice: immediate ? "0.35" : "0.2",
        maximumTotalCost: "18",
        urgency: immediate ? "IMMEDIATE" : "PASSIVE",
        liquidityPreference: immediate ? "TAKER_OK" : "MAKER_ONLY",
        partialFillPolicy: "ACCEPT_ANY",
        validUntil: validUntil(ctx),
        expectedNetEdge: "5",
        tags: ["trdr4.entry", immediate ? "sb.order-type:FAK" : "sb.order-type:GTC"],
      };
      return { ...base, decisionType: "enter" as const, intents: [buy] };
    },
  };
}

const cyclingStrategy = cyclingStrategyWith({
  immediate: (step) => step % IMMEDIATE_EVERY_STEPS === 0,
  targetShares: "50",
});

interface Harness {
  readonly loop: CoreLoop;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly evaluations: { readonly event: number; readonly input: EvaluationInput; readonly outcome: EvaluationOutcome }[];
  event: number;
}

/** `createPaperTrader`'s assembly, with the cycling double's runtime registered. */
function assemble(retention: RetentionBounds, options: HarnessOptions = {}): Harness {
  const parsed = parseTraderConfig(traderConfig(options));
  if (!parsed.ok) throw new Error(`config refused: ${parsed.refusal.detail} ${parsed.refusal.issues.join("; ")}`);
  const config = parsed.config;
  const policy = parseRiskPolicy(config.riskPolicy);
  if (!policy.ok) throw new Error("risk policy refused");
  const caps = parseAllocatorCaps(config.allocatorCaps);
  if (!caps.ok) throw new Error("allocator caps refused");
  const clock = new ManualClock(T_OPEN);
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
  const created = createStrategyInstanceRuntime({
    strategy: options.strategy ?? cyclingStrategy,
    params: {},
    run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: "4" },
    watchdog: { evaluationBudgetUs: 5_000_000 },
    clock: { nowNs: () => clock.monotonicNs() },
    decisionSink: { persist: (record, telemetry) => outbox.appendDecision(record, telemetry) },
    checkpointStore: { save: (checkpoint) => outbox.appendCheckpoint(checkpoint) },
  });
  if (!created.ok) throw new Error(`runtime refused: ${created.refusal.detail}`);
  const registry = new InstanceRegistry();
  const registered = registry.register({
    instanceId: INSTANCE_ID,
    runId: RUN_ID,
    configId: CONFIG_ID,
    marketId: MARKET_ID,
    ownership: "OWNER",
    evaluationPriority: 0,
    runtime: created.runtime,
    direction: "YES",
    params: {},
    immediateOrderType: "FAK",
    submissionUnknownAfterMs: 5_000,
  });
  if (!registered.ok) throw new Error(registered.detail);

  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error("fees refused");
  const wiring: { loop: CoreLoop | undefined } = { loop: undefined };
  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.trdr4", fillModelParametersHash: "c".repeat(64) }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits("no venue rate-limit budget is modelled in this synthetic run"),
    // `main.ts`'s `createExecutionPolicy` semantics: the loop's recorded
    // time-in-force, and a refusal (throw, contained by the venue) otherwise.
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
    ids: new DeterministicIdFactory("trdr-4-long-run"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts: new HaltController(),
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    retention,
    // `FOLD-1` (orchestrator call O1): the held ledger view and PnL streams
    // are checked against their rebuilds from zero after EVERY fill.
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
    // `CADENCE-1` (ADR-026 D1.6; r1, O07): this harness's subject is TRDR-4 long-run
    // retention and order settlement, not the cadence — but its timelines were written
    // for ADR-024's per-frame cadence: a scripted strategy that acts at events 100 ms
    // apart. `TC-LOWS-1` (O07): every test now runs at both cadences
    // ({@link describeAtEachCadence}); where a count differs at the production
    // cadence, the test says where and why.
    evaluationCadence: cadence.option,
  });
  wiring.loop = loop;

  const harness: Harness = { loop, venue, store, evaluations: [], event: 0 };
  const original = created.runtime.evaluate.bind(created.runtime);
  vi.spyOn(created.runtime, "evaluate").mockImplementation((input: EvaluationInput) => {
    const outcome = original(input);
    harness.evaluations.push({ event: harness.event, input, outcome });
    return outcome;
  });
  return harness;
}

function envelope(ordinal: number, eventType: string, payload: unknown, source: "polymarket" | "binance" = "polymarket"): IngestedEvent {
  const receivedAt = new Date(T_START_MS + ordinal * STEP_MS).toISOString();
  const wire: EventEnvelope<unknown> = {
    eventId: `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`,
    eventType,
    schemaVersion: 1,
    source,
    sourceChannel: "market",
    receivedAt,
    receivedMonotonicNs: String(ordinal * 1_000_000),
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ordinal),
    subscriptionGeneration: 1,
    payload,
  };
  return {
    envelope: wire,
    identity: { gatewayEpoch: GATEWAY_EPOCH, ingestSeq: String(ordinal), receivedAt, datasetRowOrdinal: ordinal },
  };
}

function openingEvents(): readonly IngestedEvent[] {
  return [
    envelope(1, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, "binance"),
    envelope(2, "MarketOpened", { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN }),
    envelope(3, "BookSnapshot", {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "5000" }],
      asks: [{ price: "0.66", size: "5000" }],
    }),
  ];
}

/** Every cycle tick is a full YES snapshot: a fresh, deep book, nothing economic changes. */
function tick(ordinal: number): IngestedEvent {
  return envelope(ordinal, "BookSnapshot", {
    internalMarketId: MARKET_ID,
    tokenId: YES_TOKEN,
    bids: [
      { price: "0.32", size: "5000" },
      { price: "0.31", size: "5000" },
    ],
    asks: [
      { price: "0.34", size: "5000" },
      { price: "0.35", size: "5000" },
    ],
  });
}

async function feed(harness: Harness, event: IngestedEvent, ordinal: number): Promise<void> {
  harness.event = ordinal;
  if (!harness.loop.ingest(event)) throw new Error(`ingest refused event ${String(ordinal)}`);
  await harness.loop.drain();
}

/** Yields to the macrotask queue so a long synchronous stretch never starves the worker (CI-2). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describeAtEachCadence("a deterministic long synthetic run (NOT a soak — §16.7)", () => {
  it(
    "over 500+ orders: the per-order maps track WORKING orders, per-event deliveries stay flat, retention evicts oldest-first, counted",
    async () => {
      const bounds = { decisions: 256, traces: 32, provenance: 64, tombstones: 64 } as const;
      const harness = assemble(bounds);
      let ordinal = 0;
      for (const event of openingEvents()) {
        ordinal += 1;
        await feed(harness, event, ordinal);
      }

      const deliveriesPerTick: number[] = [];
      const TARGET_ORDERS = 500;
      let ticks = 0;
      // The run ends after a CANCEL step, so nothing is left working: at the
      // per-frame cadence that is an even tick. `TC-LOWS-1` (O07): at the
      // production cadence the double steps once per ten ticks (ADR-026 D2.4),
      // so the run ends once no order is working.
      const working = (): number =>
        harness.venue.ordersSnapshot().filter((order) => !["FILLED", "CANCELLED", "EXPIRED", "REJECTED"].includes(order.state)).length;
      while (harness.venue.ordersSnapshot().length < TARGET_ORDERS || (cadence.production ? working() > 0 : ticks % 2 === 1)) {
        // A run that stops placing orders fails here instead of looping forever.
        // `TC-LOWS-1` (O07): ten times the events at the production cadence,
        // where the double steps once per ten (ADR-026 D2.4).
        expect(ticks, "the synthetic run stopped placing orders").toBeLessThan(400 * stepsApart());
        ordinal += 1;
        ticks += 1;
        const before = harness.evaluations.length;
        await feed(harness, tick(ordinal), ordinal);
        deliveriesPerTick.push(
          harness.evaluations.slice(before).filter((entry) => entry.input.callback === "onOrderUpdate").length,
        );

        // After EVERY event: each per-order map holds exactly the instance's
        // WORKING (non-terminal) orders — never the history.
        const working = harness.venue
          .ordersSnapshot()
          .filter((order) => !["FILLED", "CANCELLED", "EXPIRED", "REJECTED"].includes(order.state)).length;
        const sizes = harness.loop.retainedOrderState();
        expect(sizes.owners, `event ${String(ordinal)}`).toBe(working);
        expect(sizes.instanceOrderIds).toBe(working);
        expect(sizes.instanceOrderSets).toBe(working === 0 ? 0 : 1);
        expect(sizes.traceLookup).toBe(working);
        expect(sizes.bookedShares).toBe(working);
        expect(sizes.retiredUnsettled).toBe(0);
        expect(sizes.orderViews).toBeLessThanOrEqual(working);
        expect(sizes.tombstones).toBeLessThanOrEqual(bounds.tombstones);
        expect(working).toBeLessThanOrEqual(10);

        if (ticks % 25 === 0) await yieldToEventLoop();
      }

      const loop = harness.loop;
      const placed = harness.venue.ordersSnapshot().length;
      const health = loop.health();
      expect(placed).toBeGreaterThanOrEqual(TARGET_ORDERS);
      expect(health.halts).toEqual([]);
      // Both cycle kinds really ran: fills were booked, and resting orders were cancelled.
      const states = new Set(harness.venue.ordersSnapshot().map((order) => order.state));
      expect(states).toEqual(new Set(["FILLED", "CANCELLED"]));
      expect(harness.venue.fills.length).toBeGreaterThan(0);

      // Every order ever placed ended terminal and SETTLED; the tombstone map
      // holds its bound and counted the rest.
      expect(health.seams.orders).toEqual({
        tracked: 0,
        settled: placed,
        tombstones: bounds.tombstones,
        maximumTombstones: bounds.tombstones,
        tombstoneEvictions: placed - bounds.tombstones,
        unownedFills: 0,
        lateFillsAfterSettlement: 0,
        settleMismatches: 0,
      });
      expect(loop.retainedOrderState()).toEqual({
        basketWatches: 0,
        owners: 0,
        instanceOrderSets: 0,
        instanceOrderIds: 0,
        traceLookup: 0,
        bookedShares: 0,
        retiredUnsettled: 0,
        orderViews: 0,
        tombstones: bounds.tombstones,
        heldUnowned: 0,
        watchedOrders: 0,
      });

      // Per-event onOrderUpdate deliveries do NOT grow with history: at most
      // one per working order plus one per newly terminal order (ten each at
      // most), and the busiest late tick is no busier than the busiest early one.
      expect(Math.max(...deliveriesPerTick)).toBeLessThanOrEqual(20);
      // `TC-LOWS-1` (O07): the same number of strategy steps per window — 50
      // events, 500 at the production cadence (ADR-026 D2.4).
      const early = deliveriesPerTick.slice(0, 50 * stepsApart());
      const late = deliveriesPerTick.slice(-50 * stepsApart());
      expect(Math.max(...late)).toBeLessThanOrEqual(Math.max(...early));
      // The windows may differ by ONE resting cycle's deliveries: its ten OPEN
      // views, their repeats at every event while they rest, and its ten
      // CANCELED views — 20 at the per-frame cadence, where the cycle's two
      // steps are adjacent events. `TC-LOWS-1` (O07): at the production
      // cadence the cycle rests for the nine coalesced events between its
      // steps (ADR-026 D2.4), and every harvest point still delivers its
      // working views (D4): 10 + 90 + 10 = 110 (measured: an immediate cycle,
      // which rests for none, delivers 90 fewer, so the two 500-event windows
      // differ by 90 when they hold different numbers of immediate cycles).
      const oneCycle = 10 * (stepsApart() + 1);
      expect(late.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(
        early.reduce((sum, count) => sum + count, 0) + oneCycle,
      );
      // Every order's TERMINAL view was delivered exactly once.
      const terminalDeliveries = new Map<string, number>();
      for (const { input } of harness.evaluations) {
        if (input.callback !== "onOrderUpdate" || !TERMINAL.has(input.order.status)) continue;
        terminalDeliveries.set(input.order.orderId, (terminalDeliveries.get(input.order.orderId) ?? 0) + 1);
      }
      expect(terminalDeliveries.size).toBe(placed);
      expect([...terminalDeliveries.values()].every((count) => count === 1)).toBe(true);

      // STALE ADOPTION IS UNREACHABLE: no evaluation's ctx.orders() ever held a
      // terminal order past its one evaluated terminal delivery, and the
      // adopt-like-Static-Bracket probe never found a terminal BUY view.
      const retiredAt = new Map<string, number>();
      harness.evaluations.forEach(({ input, outcome }, index) => {
        for (const view of input.orders) {
          const retired = retiredAt.get(view.orderId);
          expect(retired === undefined || index <= retired, `order ${view.orderId} seen after retirement`).toBe(true);
        }
        if (input.callback === "onOrderUpdate" && TERMINAL.has(input.order.status) && outcome.kind === "DECIDED") {
          retiredAt.set(input.order.orderId, index);
        }
      });
      const reasons = harness.store.decisions.flatMap((written) => [...written.record.decision.reasonCodes]);
      expect(reasons).toContain("TRDR4.STEP");
      expect(reasons).not.toContain("TRDR4.ADOPTED_TERMINAL");

      // Retention: each audit log kept its newest window, oldest-first, and
      // counted every eviction; the durable store kept every decision.
      const persisted = harness.store.decisions.length;
      const traced = harness.venue.fills.length;
      expect(health.seams.retention).toEqual({
        decisions: { retained: bounds.decisions, maximumRetained: bounds.decisions, evicted: persisted - bounds.decisions },
        traces: { retained: bounds.traces, maximumRetained: bounds.traces, evicted: traced - bounds.traces },
        provenance: { retained: bounds.provenance, maximumRetained: bounds.provenance, evicted: placed - bounds.provenance },
      });
      expect(loop.decisions().map((decision) => decision.evaluationSeq)).toEqual(
        harness.store.decisions.slice(-bounds.decisions).map((written) => written.record.evaluationSeq),
      );
      expect(loop.orderProvenance().map((record) => record.venueOrderId)).toEqual(
        harness.venue.ordersSnapshot().slice(-bounds.provenance).map((order) => order.simulatedOrderId),
      );
      expect(loop.traces().map((trace) => trace.venueFillId)).toEqual(
        harness.venue.fills.slice(-bounds.traces).map((fill) => fill.simulatedFillId),
      );

      // SIM-2: with the venue's DEFAULT bounds this run evicts nothing, so every
      // history read above saw every order and every fill.
      const venueRetention = harness.venue.retention();
      expect(venueRetention.historyEvicted).toBe(false);
      expect(venueRetention.orders.evicted + venueRetention.fills.evicted + venueRetention.tombstones.evicted).toBe(0);
      expect(venueRetention.orders.retained + venueRetention.live.orders).toBe(placed);
      // SIM-2 r1: every order the loop settled was acknowledged, so nothing is
      // left held for it; and nothing reached the duplicate guard's filter.
      expect(venueRetention.awaitingAcknowledgment).toBe(0);
      expect(venueRetention.evictedIds).toMatchObject({ folded: 0, bitsSet: 0, refused: 0 });
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// SIM-2 — the VENUE is bounded, and the loop reads none of its history
// ---------------------------------------------------------------------------

function publicTrade(ordinal: number, price: string): IngestedEvent {
  return envelope(ordinal, "PublicTradeObserved", {
    internalMarketId: MARKET_ID,
    tokenId: YES_TOKEN,
    price,
    size: "75",
    takerSide: "ASK",
  });
}

/** The ids `SimulatedVenue.ordersSnapshot()` orders by: UTF-16 code units. */
function venueOrder(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Counts the venue calls the LOOP makes, by member, while `counting` is on.
 * The test's own reads happen with it off. Plain wrappers on the instance
 * rather than `vi.spyOn`, which would also RECORD every call's arguments —
 * hundreds of thousands of them over this run.
 */
function countVenueCalls(venue: SimulatedVenue): { counting: boolean; readonly calls: Map<string, number> } {
  const probe = { counting: false, calls: new Map<string, number>() };
  const count = (name: string): void => {
    if (probe.counting) probe.calls.set(name, (probe.calls.get(name) ?? 0) + 1);
  };
  const target = venue as unknown as Record<string, unknown>;
  for (const name of [
    "ordersSnapshot",
    "fillsSince",
    "orderById",
    "orderByPlannedId",
    "restingBands",
    "bandHistory",
    "acknowledgeTerminal",
  ]) {
    const original = target[name];
    if (typeof original !== "function") throw new Error(`SimulatedVenue has no ${name}`);
    target[name] = (...args: unknown[]): unknown => {
      count(name);
      return (original as (...parameters: unknown[]) => unknown).apply(venue, args);
    };
  }
  const fills = Object.getOwnPropertyDescriptor(SimulatedVenue.prototype, "fills")?.get;
  if (fills === undefined) throw new Error("SimulatedVenue has no fills getter");
  Object.defineProperty(venue, "fills", {
    configurable: true,
    get(): unknown {
      count("fills");
      return fills.call(venue);
    },
  });
  return probe;
}

describeAtEachCadence("SIM-2: the venue holds LIVE orders plus bounded, counted history, and the loop reads none of it", () => {
  it(
    "over 2,000+ orders and hundreds of public trades (a deterministic synthetic run, NOT a soak — §16.7)",
    async () => {
      // Small venue bounds, so the history really evicts, and a short trade
      // window, so the features engine's own tape stays short. Fills come LATE
      // — the immediate round trip at step 300, and one public trade AT the
      // resting BUYs' price in the final phase — because every booked fill
      // grows the in-memory ledger the loop re-folds on every evaluation
      // (`LOOPMEM-FOLD`, not this round's subject), and a fill-heavy run would
      // measure that fold rather than the venue.
      const venueBounds = { orders: 64, fills: 16, bands: 1, tombstones: 256 } as const;
      const harness = assemble(
        {},
        {
          venueRetention: venueBounds,
          tradeWindowMs: 5_000,
          strategy: cyclingStrategyWith({ immediate: (step) => step === 300, targetShares: "50" }),
        },
      );
      const probe = countVenueCalls(harness.venue);
      let ordinal = 0;
      for (const event of openingEvents()) {
        ordinal += 1;
        await feed(harness, event, ordinal);
      }

      const perEvent: { lookups: number; fills: number }[] = [];
      let trades = 0;
      const placed = (): number => {
        const retention = harness.venue.retention();
        return (
          retention.live.orders + retention.awaitingAcknowledgment + retention.orders.retained + retention.orders.evicted
        );
      };
      let acknowledged = 0;
      const step = async (event: IngestedEvent): Promise<void> => {
        ordinal += 1;
        const fillsBefore = harness.venue.retention().fills.nextSequence;
        const settledBefore = harness.loop.health().seams.orders.settled;
        probe.calls.clear();
        probe.counting = true;
        await feed(harness, event, ordinal);
        probe.counting = false;
        if (event.envelope.eventType === "PublicTradeObserved") trades += 1;

        // The loop made NO call proportional to history: no snapshot, no copy
        // of the fill list — one cursor read per harvest, and lookups by id.
        expect(probe.calls.get("ordersSnapshot") ?? 0, `event ${String(ordinal)}`).toBe(0);
        expect(probe.calls.get("fills") ?? 0).toBe(0);
        expect(probe.calls.get("bandHistory") ?? 0).toBe(0);
        expect(probe.calls.get("fillsSince") ?? 0).toBeLessThanOrEqual(1);
        perEvent.push({
          lookups: (probe.calls.get("orderById") ?? 0) + (probe.calls.get("orderByPlannedId") ?? 0),
          fills: harness.venue.retention().fills.nextSequence - fillsBefore,
        });

        // The venue's LIVE state is exactly the working orders, which the
        // loop's own per-order maps also track; the history is bounded.
        const retention = harness.venue.retention();
        const sizes = harness.loop.retainedOrderState();
        expect(retention.live.orders).toBe(sizes.owners);
        // SIM-2 r1: the loop ACKNOWLEDGED exactly the orders it settled this
        // event — once each, O(1) apiece — so nothing is left held for it.
        const settled = harness.loop.health().seams.orders.settled - settledBefore;
        expect(probe.calls.get("acknowledgeTerminal") ?? 0).toBe(settled);
        acknowledged += settled;
        expect(retention.awaitingAcknowledgment).toBe(0);
        expect(sizes.watchedOrders).toBe(0);
        expect(retention.live.orders).toBeLessThanOrEqual(10);
        expect(retention.live.resting).toBe(retention.live.orders);
        expect(retention.live.bands).toBe(0);
        expect(retention.live.pendingDelayed).toBe(0);
        expect(retention.orders.retained).toBeLessThanOrEqual(venueBounds.orders);
        expect(retention.fills.retained).toBeLessThanOrEqual(venueBounds.fills);
        expect(retention.tombstones.retained).toBeLessThanOrEqual(venueBounds.tombstones);
        // Everything the venue holds about orders: live + held for acknowledgment
        // (none, above) + retained + tombstoned, and a filter of FIXED size.
        expect(
          retention.live.orders +
            retention.awaitingAcknowledgment +
            retention.orders.retained +
            retention.tombstones.retained,
        ).toBeLessThanOrEqual(10 + venueBounds.orders + venueBounds.tombstones);
        expect(retention.evictedIds.bits).toBe(DEFAULT_VENUE_RETENTION.evictedIdFilterBits);
        // Tier 0 holds one instant per (market, side), never the trades.
        expect(retention.trades.retained).toBe(0);
        expect(retention.trades.keys).toBeLessThanOrEqual(1);
      };

      let round = 0;
      while (placed() < 2_000) {
        round += 1;
        // `TC-LOWS-1` (O07): ten times the rounds at the production cadence (ADR-026 D2.4).
        expect(round, "the synthetic run stopped placing orders").toBeLessThan(1_000 * stepsApart());
        await step(tick(ordinal + 1));
        await step(publicTrade(ordinal + 1, "0.33"));
        await step(publicTrade(ordinal + 1, "0.33"));
        if (round % 10 === 0) await yieldToEventLoop();
      }
      // The immediate round trip really ran (step 300) and its fills were booked.
      const roundTrip = harness.venue.retention().fills.nextSequence;
      expect(roundTrip).toBeGreaterThan(0);

      // FINAL PHASE: a public trade AT 0.2 fills the working resting BUYs as
      // MAKER fills (Tier 0, through `observeTrade`), and the next steps sell.
      let guard = 0;
      while (harness.venue.retention().live.orders === 0) {
        guard += 1;
        expect(guard).toBeLessThan(5 * stepsApart());
        await step(tick(ordinal + 1));
      }
      await step(publicTrade(ordinal + 1, "0.2"));
      // `TC-LOWS-1` (O07): four strategy steps — forty events at the production cadence.
      for (let index = 0; index < 4 * stepsApart(); index += 1) await step(tick(ordinal + 1));
      expect(harness.venue.retention().fills.nextSequence).toBeGreaterThan(roundTrip + 5);

      const retention = harness.venue.retention();
      const total = placed();
      expect(total).toBeGreaterThanOrEqual(2_000);
      expect(trades).toBeGreaterThanOrEqual(250);
      // Every eviction is COUNTED: orders forgotten oldest-first, then their ids.
      expect(retention.orders).toEqual({
        retained: venueBounds.orders,
        maximumRetained: venueBounds.orders,
        evicted: total - retention.live.orders - venueBounds.orders,
      });
      expect(retention.tombstones).toEqual({
        retained: venueBounds.tombstones,
        maximumRetained: venueBounds.tombstones,
        evicted: retention.orders.evicted - venueBounds.tombstones,
      });
      // SIM-2 r1: every id past its tombstone is folded into the duplicate
      // guard's filter — counted — and no placement was refused by it.
      expect(retention.evictedIds).toMatchObject({ folded: retention.tombstones.evicted, refused: 0 });
      expect(retention.awaitingAcknowledgment).toBe(0);
      expect(acknowledged).toBe(total - retention.live.orders);
      expect(retention.fills.retained).toBe(venueBounds.fills);
      expect(retention.fills.evicted).toBe(retention.fills.nextSequence - venueBounds.fills);
      expect(retention.fills.evicted).toBeGreaterThan(0);
      expect(retention.historyEvicted).toBe(true);
      // Hundreds of public trades, one (market, side) key, nothing held.
      expect(retention.trades).toEqual({ tier: "TIER_0", keys: 1, retained: 0 });

      // …and the loop never needed any of it: no halt, and it observed and
      // booked EVERY fill the venue produced, though the venue kept only 16.
      const health = harness.loop.health();
      expect(health.halts).toEqual([]);
      expect(health.execution.fillsObserved).toBe(retention.fills.nextSequence);
      expect(health.execution.duplicateFillsRefused).toBe(0);
      expect(health.seams.orders).toMatchObject({ tracked: retention.live.orders, unownedFills: 0, settleMismatches: 0 });
      expect(harness.loop.retainedOrderState()).toMatchObject({ heldUnowned: 0, watchedOrders: 0 });

      // Per-event lookups are bounded by the WORKING orders and the event's own
      // deliveries, not by history: among events that produced no fill (a fill
      // adds its own onFill evaluations), the busiest of the last 60 is no
      // busier than the busiest of the first 60, 2,000 orders later — and no
      // event at all comes near a thousand.
      const quiet = perEvent.filter((entry) => entry.fills === 0).map((entry) => entry.lookups);
      expect(quiet.length).toBeGreaterThan(300);
      expect(Math.max(...quiet.slice(-60))).toBeLessThanOrEqual(Math.max(...quiet.slice(0, 60)));
      expect(Math.max(...perEvent.map((entry) => entry.lookups))).toBeLessThan(1_000);
    },
    180_000,
  );

  it("a plan of 12 slices is delivered, and listed in ctx.orders(), in the VENUE's id order (`:o10` before `:o2`), not insertion order (IF-07)", async () => {
    const harness = assemble(
      {},
      { strategy: cyclingStrategyWith({ immediate: () => false, targetShares: "60" }) },
    );
    let ordinal = 0;
    for (const event of openingEvents()) {
      ordinal += 1;
      await feed(harness, event, ordinal);
    }
    ordinal += 1;
    await feed(harness, tick(ordinal), ordinal);

    const booked = harness.venue.ordersSnapshot().map((order) => order.simulatedOrderId);
    expect(booked).toHaveLength(12);
    const insertion = [...booked].sort((left, right) => Number(left.split(":o")[1]) - Number(right.split(":o")[1]));
    const expected = venueOrder(booked);
    // Non-vacuous: the two orders really differ for twelve slices.
    expect(expected).not.toEqual(insertion);
    expect(expected.slice(0, 4).map((id) => id.split(":").at(-1))).toEqual(["o0", "o1", "o10", "o11"]);

    const updates = harness.evaluations.filter(
      (entry) => entry.event === ordinal && entry.input.callback === "onOrderUpdate",
    );
    expect(updates.map((entry) => (entry.input.callback === "onOrderUpdate" ? entry.input.order.orderId : ""))).toEqual(expected);
    for (const entry of updates) expect(entry.input.orders.map((view) => view.orderId)).toEqual(expected);
    // The next evaluation (the cancel step) reads ctx.orders() in the same order.
    // `TC-LOWS-1` (O07): at the production cadence it is the first event
    // 1,000 ms after this one (ADR-026 D2.4); the events between are not sent.
    ordinal += stepsApart();
    await feed(harness, tick(ordinal), ordinal);
    const next = harness.evaluations.find((entry) => entry.event === ordinal && entry.input.callback === "onFeatures");
    expect(next?.input.orders.map((view) => view.orderId)).toEqual(expected);
  });

  it("a fill cursor that fell behind the venue's retained window HALTS the process and releases nothing (loud, never a skip)", async () => {
    // Step 0's round trip books ten 5-share slices FILLED in one submission —
    // ten fills in one harvest — against a venue that retains four.
    const harness = assemble(
      {},
      { venueRetention: { fills: 4 }, strategy: cyclingStrategyWith({ immediate: (step) => step === 0, targetShares: "50" }) },
    );
    let ordinal = 0;
    for (const event of openingEvents()) {
      ordinal += 1;
      await feed(harness, event, ordinal);
    }
    ordinal += 1;
    await feed(harness, tick(ordinal), ordinal);
    expect(harness.venue.retention().fills).toMatchObject({ nextSequence: 10, retained: 4, evicted: 6 });
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "VENUE_OBSERVATION_FAILED"]]);
    expect(health.halts[0]?.detail).toContain("SIMULATED_VENUE_HISTORY_EVICTED");
    expect(health.halts[0]?.detail).toContain("the fills since sequence 0");
    // Nothing was read, booked or given back: every FILLED slice keeps its
    // reservation, because the position that would replace it is unknown.
    expect(health.execution.fillsObserved).toBe(0);
    expect(health.accounting.ledgerTransactions).toBe(0);
    expect(health.seams.reservations).toMatchObject({ open: 10, released: 0 });
    expect(health.seams.allocator).toMatchObject({ open: 10, released: 0 });
    // A later event asks again from the same cursor, and is refused again.
    ordinal += 1;
    await feed(harness, tick(ordinal), ordinal);
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 10, released: 0 });
  });

  it("SIM2-R1-1, a SUBMISSION batch: ten slices FILLED in ONE submission against a venue that retains ONE acknowledged order — no halt; all ten read, released, settled, and only then acknowledged", async () => {
    // The verifier's probe: at 7c570ed nine of the ten terminal orders were
    // evicted inside the submission itself, and the harvest halted GLOBAL
    // with nine reservations still open.
    const harness = assemble(
      {},
      {
        venueRetention: { orders: 1, tombstones: 1 },
        strategy: cyclingStrategyWith({ immediate: (step) => step === 0, targetShares: "50" }),
      },
    );
    let ordinal = 0;
    for (const event of openingEvents()) {
      ordinal += 1;
      await feed(harness, event, ordinal);
    }
    const probe = countVenueCalls(harness.venue);
    probe.counting = true;
    ordinal += 1;
    await feed(harness, tick(ordinal), ordinal);
    probe.counting = false;
    const health = harness.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.execution.fillsObserved).toBe(10);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 10, released: 10 });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 10, released: 10 });
    expect(health.seams.orders).toMatchObject({ tracked: 0, settled: 10, unownedFills: 0 });
    expect(harness.loop.retainedOrderState()).toMatchObject({ owners: 0, heldUnowned: 0, watchedOrders: 0 });
    // Acknowledged once each, after settlement; the bound applies only now.
    expect(probe.calls.get("acknowledgeTerminal")).toBe(10);
    expect(harness.venue.retention()).toMatchObject({
      awaitingAcknowledgment: 0,
      orders: { retained: 1, maximumRetained: 1, evicted: 9 },
      tombstones: { retained: 1, maximumRetained: 1, evicted: 8 },
      evictedIds: { folded: 8, refused: 0 },
    });
  });

  it("SIM2-R1-1, a CANCELLATION batch: ten resting slices CANCELLED by ONE plan against a venue that retains ONE acknowledged order — no halt; all ten released and settled", async () => {
    const harness = assemble(
      {},
      {
        venueRetention: { orders: 1, tombstones: 1 },
        strategy: cyclingStrategyWith({ immediate: () => false, targetShares: "50" }),
      },
    );
    let ordinal = 0;
    for (const event of openingEvents()) {
      ordinal += 1;
      await feed(harness, event, ordinal);
    }
    // Step 0: ten passive 5-share BUY slices rest.
    ordinal += 1;
    await feed(harness, tick(ordinal), ordinal);
    expect(harness.venue.retention().live.orders).toBe(10);
    expect(harness.loop.retainedOrderState().owners).toBe(10);
    // Step 1: ONE cancel plan names all ten; the venue cancels them in one call.
    // `TC-LOWS-1` (O07): at the production cadence step 1 is the first event
    // 1,000 ms after step 0 (ADR-026 D2.4); the events between are not sent.
    ordinal += stepsApart();
    await feed(harness, tick(ordinal), ordinal);
    const health = harness.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.execution.cancelsConfirmed).toBe(1);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 10, released: 10 });
    expect(health.seams.orders).toMatchObject({ tracked: 0, settled: 10 });
    expect(harness.venue.retention()).toMatchObject({
      live: { orders: 0 },
      awaitingAcknowledgment: 0,
      orders: { retained: 1, evicted: 9 },
    });
  });

  it("the cursor is NON-destructive: a store failure's early return re-reads the same batch (IF-06: 1, then 11 observed, 1 duplicate)", async () => {
    const harness = assemble({}, { strategy: cyclingStrategyWith({ immediate: (step) => step === 0, targetShares: "50" }) });
    let ordinal = 0;
    for (const event of openingEvents()) {
      ordinal += 1;
      await feed(harness, event, ordinal);
    }
    // The first LEDGER write of the ten-fill harvest fails.
    harness.store.failOnly(["appendLedgerTransaction"], "UNAVAILABLE", "SIM-2 test: the ledger table is locked");
    ordinal += 1;
    await feed(harness, tick(ordinal), ordinal);
    let health = harness.loop.health();
    expect(harness.venue.retention().fills.nextSequence).toBe(10);
    expect(health.execution.fillsObserved).toBe(1);
    expect(health.execution.duplicateFillsRefused).toBe(0);
    expect(health.halts.map((halt) => halt.code)).toEqual(["STORE_UNAVAILABLE"]);

    harness.store.recover();
    ordinal += 1;
    await feed(harness, tick(ordinal), ordinal);
    health = harness.loop.health();
    // The whole batch was read again: the fill already booked is refused as a
    // duplicate, and the nine unbooked ones are booked now.
    expect(health.execution.fillsObserved).toBe(11);
    expect(health.execution.duplicateFillsRefused).toBe(1);
    expect(harness.store.transactions.length).toBeGreaterThan(0);
  });
});
