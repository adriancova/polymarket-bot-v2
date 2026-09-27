/**
 * `TRDR-4` item 7 — a DETERMINISTIC LONG SYNTHETIC RUN of the real `CoreLoop`.
 *
 * NOT soak evidence. Handoff §16.7: "Time-based operational gates cannot be
 * faked by an agent." This is a unit-style test over recorded instants that
 * proves one structural claim — the loop's per-order state tracks WORKING
 * orders rather than history, and per-event `onOrderUpdate` deliveries do not
 * grow with the number of orders ever placed — and nothing about elapsed-time
 * memory behaviour. It also does not claim the process is memory-bounded:
 * `#pnlRecords`, the in-memory `Ledger` and the `SimulatedVenue` still grow
 * (`LOOPMEM-FOLD`, `LOOPMEM-SIM`).
 *
 * WHAT IS REAL: the `CoreLoop`, the strategy RUNTIME, feature engine, books,
 * capital allocator, risk engine, execution planner, `SimulatedVenue` (Tier 0),
 * ledger and PnL. WHAT IS DOUBLED: the clock and the durable store (the
 * trader's own in-memory doubles), and the STRATEGY — Static Bracket opens one
 * bracket per market and then pauses (`RISK-2` residual 5), so it cannot place
 * hundreds of orders. The double runs through the real runtime and emits the
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
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
} from "@polymarket-bot/simulation";
import {
  createStrategyInstanceRuntime,
  type EvaluationInput,
  type EvaluationOutcome,
} from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext, StrategyOrderView } from "@polymarket-bot/strategy-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
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

function traderConfig(): Record<string, unknown> {
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
      tradeWindowMs: 60_000,
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

const cyclingStrategy: Strategy<unknown, CyclingState> = {
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
    const immediate = step % IMMEDIATE_EVERY_STEPS === 0;
    const buy: Intent = {
      type: "POSITION",
      intentId: `trdr4-buy-${String(step)}`,
      marketId: MARKET_ID,
      direction: "YES",
      targetMode: "DELTA",
      targetShares: "50",
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

interface Harness {
  readonly loop: CoreLoop;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly evaluations: { readonly event: number; readonly input: EvaluationInput; readonly outcome: EvaluationOutcome }[];
  event: number;
}

/** `createPaperTrader`'s assembly, with the cycling double's runtime registered. */
function assemble(retention: RetentionBounds): Harness {
  const parsed = parseTraderConfig(traderConfig());
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
    strategy: cyclingStrategy,
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

describe("a deterministic long synthetic run (NOT a soak — §16.7)", () => {
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
      while (harness.venue.ordersSnapshot().length < TARGET_ORDERS || ticks % 2 === 1) {
        // A run that stops placing orders fails here instead of looping forever.
        expect(ticks, "the synthetic run stopped placing orders").toBeLessThan(400);
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
      });

      // Per-event onOrderUpdate deliveries do NOT grow with history: at most
      // one per working order plus one per newly terminal order (ten each at
      // most), and the busiest late tick is no busier than the busiest early one.
      expect(Math.max(...deliveriesPerTick)).toBeLessThanOrEqual(20);
      const early = deliveriesPerTick.slice(0, 50);
      const late = deliveriesPerTick.slice(-50);
      expect(Math.max(...late)).toBeLessThanOrEqual(Math.max(...early));
      expect(late.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(
        early.reduce((sum, count) => sum + count, 0) + 20,
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
    },
    60_000,
  );
});
