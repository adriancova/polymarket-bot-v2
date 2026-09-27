/**
 * `TRDR-4` round 1, finding TRDR4-R1 — a plan the venue PARTLY EXECUTED and
 * then refused keeps what its still-held orders reserved, and halts its market
 * for reconciliation.
 *
 * The state: the planner slices a 50-share resting BUY into ten 5-share orders
 * (`planning.maxSliceShares: "5"`), and the REAL `SimulatedVenue`'s §9.13
 * budget admits ONE placement per window. The venue books the first slice —
 * it RESTS, well below the ask — refuses the second on its budget, and
 * answers `accepted: false, orders: []` for the WHOLE plan, while the first
 * slice stays working in its book (`venue.ts` `#submitSync` / `#refuse`).
 *
 * At `ed6d656` the loop's refusal branch released every planned order's
 * reservation, allocator commitment and time-in-force — including the RESTING
 * one's — which ADR-006 §9 forbids (never released before terminal), and
 * raised nothing: `reservations.open 0`, `allocator.open 0`,
 * `timeInForceFor(slice 1) undefined`, `halts []`. Pinned here:
 *
 * 1. the nine slices the venue never booked are released, counted;
 * 2. the RESTING slice keeps all three entries, across later harvests, while
 *    it is working;
 * 3. its market is halted `UNATTRIBUTED_ACTIVITY` / `RECONCILE_ACCOUNT` at the
 *    refusal, naming the plan, the order and its state;
 * 4. no instance owns it: never delivered, never in `ctx.orders()`;
 * 5. when an OBSERVED trade fills it (terminal evidence), the fill is booked
 *    UNATTRIBUTED and counted, and only then are the three entries released.
 *
 * WHAT IS REAL: the `CoreLoop`, strategy runtime, feature engine, books,
 * allocator, risk engine, execution planner, `SimulatedVenue` (Tier 0) and
 * ledger. WHAT IS DOUBLED: the clock and the store (the trader's own in-memory
 * doubles) and the STRATEGY — a one-shot double that emits the same §7.7
 * resting-entry intent shape Static Bracket emits (Static Bracket's passive
 * entry is not needed to reach the loop's refusal branch). PAPER only; no
 * network, credential, signer or real order.
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
  type BookView,
  type FeeScheduleSnapshot,
} from "@polymarket-bot/simulation";
import { createStrategyInstanceRuntime, type EvaluationInput } from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DeterministicIdFactory, projectionOf, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer } from "./loop.js";
import { MarketState } from "./market-state.js";
import type { IngestedEvent } from "./ports.js";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "./safety.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";

const MARKET_ID = "018f5c20-1000-7a10-8b00-0000000000b1";
const CONDITION_ID = "0xtrdr4refusedplan";
const YES_TOKEN = "7101";
const NO_TOKEN = "7102";
const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-0000000000b2";
const RUN_ID = "018f5c20-3000-7a30-8b00-0000000000b3";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000000b4";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-0000000000b5";
const T_START_MS = Date.parse("2026-05-01T09:00:00.000Z");
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-02T09:00:00.000Z";
const STEP_MS = 100;

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "trdr4r1.sim.2026-05-01",
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
      accountRef: "trdr4r1-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "trdr4r1-venue-clearing",
      attributionClearingRef: "trdr4r1-attribution-clearing",
      feeExpenseRef: "trdr4r1-fee-expense",
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
      // TEN 5-share slices for the 50-share entry.
      maxSliceShares: "5",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.trdr4r1",
      fillModelParametersHash: "d".repeat(64),
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
      consumerId: "trdr-4-refused-plan",
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
        seriesKey: "trdr4r1-refused-plan-sim",
        underlyingKey: "SIMBTC",
        resolutionWindowKey: "w2026-05-02T09.00",
      },
    ],
    instances: [
      {
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        configId: CONFIG_ID,
        runSeed: "41",
        marketId: MARKET_ID,
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5_000_000,
        params: {},
      },
    ],
  };
}

type OneShotState = { readonly placed?: boolean };

function hold(ctx: StrategyContext): DecisionResult {
  return { decisionType: "hold", reasonCodes: ["TRDR4R1.HOLD"], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
}

/** Emits ONE resting BUY of 50 at 0.2 (`MAKER_ONLY`, `PASSIVE`, `GTC`), then holds. */
const oneShotStrategy: Strategy<unknown, OneShotState> = {
  name: "trdr4r1-one-shot-double",
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
    if (ctx.state<OneShotState>().placed === true) return hold(ctx);
    const buy: Intent = {
      type: "POSITION",
      intentId: "trdr4r1-resting-buy",
      marketId: MARKET_ID,
      direction: "YES",
      targetMode: "DELTA",
      targetShares: "50",
      maximumBuyPrice: "0.2",
      maximumTotalCost: "18",
      urgency: "PASSIVE",
      liquidityPreference: "MAKER_ONLY",
      partialFillPolicy: "ACCEPT_ANY",
      validUntil: new Date(Date.parse(ctx.now()) + 3_600_000).toISOString(),
      expectedNetEdge: "5",
      tags: ["trdr4r1.entry", "sb.order-type:GTC"],
    };
    return {
      decisionType: "enter",
      reasonCodes: ["TRDR4R1.ENTER"],
      featureSnapshotRef: ctx.features().snapshotRef,
      statePatch: { placed: true },
      intents: [buy],
    };
  },
};

interface Harness {
  readonly loop: CoreLoop;
  readonly venue: SimulatedVenue;
  readonly evaluations: EvaluationInput[];
  /** Every plan the loop offered the venue, as offered. */
  readonly submitted: unknown[];
}

/** `createPaperTrader`'s assembly, with the one-shot double's runtime registered. */
function assemble(input: { readonly orderTokensPerWindow?: number } = {}): Harness {
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
    strategy: oneShotStrategy,
    params: {},
    run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: "41" },
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
    model: tier0Model({ fillModelVersion: "tier0.trdr4r1", fillModelParametersHash: "d".repeat(64) }),
    feeSnapshot: fees.value,
    // ONE placement per (hour-long) window: the first slice is booked, the
    // second is refused on the venue's own budget, and so is the whole plan.
    rateLimits: tokenBucketRateLimits({
      orderTokensPerWindow: input.orderTokensPerWindow ?? 1,
      cancelTokensPerWindow: 10,
      windowMs: 3_600_000,
      snapshotVersion: "trdr-4-r1-refused-plan",
    }),
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
  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator: new AllocatorGate({ caps: caps.value, markets: allocationMarkets, tokenAssetIds }),
    clock,
    venue,
    store: new MemoryTraderStore(),
    registry,
    markets,
    instanceConfigs: new Map(),
    ledger: Ledger.empty(config.environment),
    ids: new DeterministicIdFactory("trdr-4-r1-refused-plan"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts: new HaltController(),
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
  });
  wiring.loop = loop;

  const harness: Harness = { loop, venue, evaluations: [], submitted: [] };
  const evaluate = created.runtime.evaluate.bind(created.runtime);
  vi.spyOn(created.runtime, "evaluate").mockImplementation((input: EvaluationInput) => {
    harness.evaluations.push(input);
    return evaluate(input);
  });
  const submit = venue.submit.bind(venue);
  vi.spyOn(venue, "submit").mockImplementation(async (plan) => {
    harness.submitted.push(plan);
    return await submit(plan);
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

/** A full, deep YES book: the resting BUY at 0.2 is far below the 0.34 ask. */
function yesBook(ordinal: number): IngestedEvent {
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

async function feed(harness: Harness, event: IngestedEvent): Promise<void> {
  if (!harness.loop.ingest(event)) throw new Error(`ingest refused ${event.envelope.eventType}`);
  await harness.loop.drain();
}

/** Opening events, then the tick at which the one-shot double enters. */
async function open(harness: Harness): Promise<void> {
  await feed(harness, envelope(1, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, "binance"));
  await feed(harness, envelope(2, "MarketOpened", { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN }));
  await feed(harness, envelope(3, "BookSnapshot", {
    internalMarketId: MARKET_ID,
    tokenId: NO_TOKEN,
    bids: [{ price: "0.65", size: "5000" }],
    asks: [{ price: "0.66", size: "5000" }],
  }));
  await feed(harness, yesBook(4));
}

/** The planned order ids of the ONE placement plan the loop submitted. */
function plannedOrderIds(harness: Harness): readonly string[] {
  expect(harness.submitted).toHaveLength(1);
  const plan = harness.submitted[0] as { readonly groups: readonly { readonly orders: readonly { readonly plannedOrderId: string }[] }[] };
  return plan.groups.flatMap((group) => group.orders.map((order) => order.plannedOrderId));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TRDR4-R1 — a refused plan the venue PARTLY executed keeps what its working order reserved", () => {
  it("the RESTING first slice keeps its reservation, allocator commitment and time-in-force until it is terminal; the market halts for reconciliation", async () => {
    const harness = assemble();
    await open(harness);
    const loop = harness.loop;

    // --- the state the finding names --------------------------------------
    const planned = plannedOrderIds(harness);
    expect(planned).toHaveLength(10);
    const orders = harness.venue.ordersSnapshot();
    expect(orders).toHaveLength(1);
    const resting = orders[0];
    if (resting === undefined) throw new Error("the venue booked no order");
    expect(resting).toMatchObject({ state: "RESTING", requestedShares: "5", filledShares: "0", limitPrice: "0.2" });
    expect(resting.plannedOrderId).toBe(planned[0]);

    let health = loop.health();
    expect(health.execution.submissionsRefused).toBe(1);
    expect(health.execution.submissionsAccepted).toBe(0);

    // (1) The nine slices the venue never booked are released, counted.
    expect(health.execution.reservationsReleasedOnRefusal).toBe(9);
    for (const plannedOrderId of planned.slice(1)) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();

    // (2) The RESTING slice keeps all three entries — 5 × 0.2 = 1 pUSD.
    expect(loop.timeInForceFor(resting.plannedOrderId)).toBe("GTC");
    expect(health.seams.reservations).toMatchObject({ open: 1, taken: 10, released: 9, reservedCollateral: "1" });
    expect(health.seams.allocator).toMatchObject({ open: 1, applied: 10, released: 9, reservedCollateral: "1" });

    // (3) The market is halted for reconciliation, naming the plan's state.
    const halts = health.halts.filter((record) => record.code === "UNATTRIBUTED_ACTIVITY");
    expect(halts).toHaveLength(1);
    const halt = halts[0];
    expect(halt?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halt?.action).toBe("RECONCILE_ACCOUNT");
    expect(halt?.detail).toContain("partly executed and then refused");
    expect(halt?.detail).toContain(`${resting.simulatedOrderId} (planned ${resting.plannedOrderId}) RESTING 0/5`);
    expect(halt?.detail).toContain("1 of its 10 planned orders");
    expect(halt?.detail).toContain("SIMULATED_VENUE_RATE_LIMITED");

    // (4) No instance owns it.
    expect(health.seams.orders.tracked).toBe(0);
    expect(loop.retainedOrderState().owners).toBe(0);

    // --- still WORKING across later harvests: nothing is released ---------
    await feed(harness, yesBook(5));
    await feed(harness, yesBook(6));
    health = loop.health();
    expect(harness.venue.ordersSnapshot()[0]?.state).toBe("RESTING");
    expect(loop.timeInForceFor(resting.plannedOrderId)).toBe("GTC");
    expect(health.seams.reservations).toMatchObject({ open: 1, released: 9, reservedCollateral: "1" });
    expect(health.seams.allocator).toMatchObject({ open: 1, released: 9, reservedCollateral: "1" });

    // --- (5) terminal evidence: an OBSERVED trade fills it ----------------
    await feed(
      harness,
      envelope(7, "PublicTradeObserved", {
        internalMarketId: MARKET_ID,
        tokenId: YES_TOKEN,
        price: "0.2",
        size: "5",
        takerSide: "ASK",
      }),
    );
    const filled = harness.venue.ordersSnapshot()[0];
    expect(filled?.state).toBe("FILLED");
    health = loop.health();
    // The fill is booked UNATTRIBUTED and counted — never attributed.
    expect(health.execution.fillsObserved).toBe(harness.venue.fills.length);
    expect(harness.venue.fills.length).toBeGreaterThan(0);
    expect(health.seams.orders).toMatchObject({ tracked: 0, unownedFills: harness.venue.fills.length, lateFillsAfterSettlement: 0 });
    const arrivals = projectionOf(loop.ledger()).unattributedActivity.filter(
      (record) => record.activityKind === "ACTUAL_ARRIVAL",
    );
    expect(arrivals.length).toBeGreaterThan(0);
    // …and only NOW, at the harvest that saw it terminal, are the three
    // entries released.
    expect(loop.timeInForceFor(resting.plannedOrderId)).toBeUndefined();
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 10, released: 10, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 10, released: 10, reservedCollateral: "0" });
    expect(health.execution.reservationsReleasedOnRefusal).toBe(9);

    // The strategy never saw the orphan: no delivery, no ctx.orders() view.
    for (const evaluation of harness.evaluations) {
      expect(evaluation.callback === "onOrderUpdate" && evaluation.order.orderId === resting.simulatedOrderId).toBe(false);
      expect(evaluation.orders.map((order) => order.orderId)).not.toContain(resting.simulatedOrderId);
    }
  });

  it("a plan the venue refused OUTRIGHT (it booked nothing) releases every planned order and raises no halt — MEDIUM-4 unchanged", async () => {
    // NO placement token: the FIRST slice is refused, so nothing is booked.
    const harness = assemble({ orderTokensPerWindow: 0 });
    await open(harness);
    const loop = harness.loop;
    const planned = plannedOrderIds(harness);
    expect(planned).toHaveLength(10);
    expect(harness.venue.ordersSnapshot()).toEqual([]);
    const health = loop.health();
    expect(health.execution.submissionsRefused).toBe(1);
    expect(health.execution.reservationsReleasedOnRefusal).toBe(10);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 10, released: 10, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 10, released: 10, reservedCollateral: "0" });
    for (const plannedOrderId of planned) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();
    expect(health.halts).toEqual([]);
  });
});

