/**
 * A plan the venue did not WHOLLY accept — `TRDR-4` round 1 (finding
 * TRDR4-R1), re-pinned by SIM-1 under the user's ruling R3 (per-order
 * results).
 *
 * THE REAL VENUE (SIM-1, R3). `SimulatedVenue` now reports each planned order's
 * outcome: what it BOOKED is listed in `result.orders` on a partial outcome as
 * on a full one, and the rest in `result.notPlaced`. It admits placements per
 * BATCH of at most 15 orders, all-or-nothing (D-05, ADR-012 §5.6). So:
 *
 * 1. a 20-slice resting BUY against a 15-token budget books its FIRST batch
 *    (15 slices, RESTING) and not its second (5 slices, rate-limited). The
 *    booked slices are OWNED — owner, trace prefix, provenance — delivered
 *    through `onOrderUpdate` and `ctx.orders()`, and keep their entries until
 *    terminal; the 5 refused slices are released, counted; a POSITION partial
 *    raises NO halt; when an observed trade fills the booked slices the fills
 *    are ATTRIBUTED (never UNATTRIBUTED), and the orders are released, retired
 *    and settled like any other;
 * 2. a 10-slice plan (one batch) against a ONE-token budget books NOTHING —
 *    the batch is admitted all-or-nothing — and every slice is released with
 *    no halt (this was `TRDR-4`'s partial state; the venue no longer produces
 *    it);
 * 3. an outright refusal (NO token) releases every planned order and raises no
 *    halt — MEDIUM-4, unchanged;
 * 4. a BASKET the venue executed only IN PART (its NO leg finds no book) keeps
 *    the booked leg owned and attributed, releases the refused leg, and HALTS
 *    the basket's market `BASKET_PARTIALLY_EXECUTED`, because nothing in the
 *    trader consumes the basket's `failurePolicy` yet. The loop supplies §9.8
 *    check 12's fee/slippage estimates for POSITION intents only, so this one
 *    case supplies them for the basket through a pass-through `vi.mock` of the
 *    risk-input builder; risk, allocator, planner and venue stay real.
 *
 * THE DEFENSIVE PATH (a scripted `TraderVenue` double). A venue that REFUSES a
 * plan while still HOLDING part of it — a live adapter whose answer is
 * incomplete — is what `TRDR-4`'s orphan halt exists for, and the real
 * simulator no longer produces it. The double books the plan's FIRST slice at a
 * real `SimulatedVenue` and answers the whole plan REFUSED, listing nothing:
 *
 * 5. the nine slices the venue never booked are released, counted;
 * 6. the RESTING slice keeps all three entries, across later harvests, while
 *    it is working;
 * 7. its market is halted `UNATTRIBUTED_ACTIVITY` / `RECONCILE_ACCOUNT` at the
 *    refusal, naming the plan, the order and its state;
 * 8. no instance owns it: never delivered, never in `ctx.orders()`;
 * 9. when an OBSERVED trade fills it (terminal evidence), the fill is booked
 *    UNATTRIBUTED and counted, and only then are the three entries released.
 *
 * WHAT IS REAL: the `CoreLoop`, strategy runtime, feature engine, books,
 * allocator, risk engine, execution planner, `SimulatedVenue` (Tier 0) and
 * ledger. WHAT IS DOUBLED: the clock and the store (the trader's own in-memory
 * doubles), the STRATEGY — a one-shot double that emits the same §7.7
 * resting-entry intent shape Static Bracket emits (Static Bracket's passive
 * entry is not needed to reach the loop's refusal branch) — and, in the
 * defensive cases only, the venue's ANSWER. PAPER only; no network,
 * credential, signer or real order.
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
  type ExecutionResult,
  type FeeScheduleSnapshot,
  type PlacementPlanView,
  type RateLimitBudget,
} from "@polymarket-bot/simulation";
import { createStrategyInstanceRuntime, type EvaluationInput } from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Pipeline from "./pipeline.js";
import { z } from "zod";

// THE ONE SEAM DOUBLED FOR THE BASKET CASE, and only for a BASKET intent. The
// loop supplies §9.8 check 12's fee and slippage estimates for a POSITION
// intent only (`CoreLoop.#economicsFor`), so the REAL risk engine refuses every
// basket `RISK_EDGE_INPUTS_MISSING` and no basket plan can reach the venue
// through the shipped pipeline today. The wrapper states those two estimates
// for a BASKET intent — the risk engine, allocator, planner and venue all stay
// real — so the loop's partial-basket branch is reached with a REAL basket
// plan. Every other intent passes through untouched.
vi.mock("./pipeline.js", async (importOriginal) => {
  const original = await importOriginal<typeof Pipeline>();
  return {
    ...original,
    buildRiskEvaluationInput(context: Parameters<typeof original.buildRiskEvaluationInput>[0]) {
      return original.buildRiskEvaluationInput(
        context.intent.type === "BASKET"
          ? { ...context, feeEstimate: "0.1", slippageEstimate: "0" }
          : context,
      );
    },
  };
});

import { DeterministicIdFactory, projectionOf, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer, type TraderVenue } from "./loop.js";
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

/**
 * Emits ONE resting BUY at 0.2 (`MAKER_ONLY`, `PASSIVE`, `GTC`) of `entry`'s
 * size, then holds. `planning.maxSliceShares` 5 cuts it into 5-share slices:
 * 50 shares are 10 slices (one venue batch), 100 are 20 (two batches, 15 + 5).
 */
function oneShotStrategy(entry: {
  readonly targetShares: string;
  readonly maximumTotalCost: string;
  /** Replaces the resting BUY with another intent (the BASKET case). */
  readonly intent?: (ctx: StrategyContext) => Intent;
}): Strategy<unknown, OneShotState> {
  return {
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
        targetShares: entry.targetShares,
        maximumBuyPrice: "0.2",
        maximumTotalCost: entry.maximumTotalCost,
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
        intents: [entry.intent?.(ctx) ?? buy],
      };
    },
  };
}

/**
 * The DEFENSIVE-path double: a `TraderVenue` that REFUSES a plan while still
 * HOLDING part of it.
 *
 * It books the plan's FIRST planned order — alone, as a one-order plan — at a
 * REAL `SimulatedVenue`, and answers the loop as if the whole plan had been
 * refused: `accepted: false`, nothing listed as booked. Everything else
 * (positioning, observed trades, the order state, the fills) is the real
 * venue's. This is the state `TRDR-4`'s orphan halt exists for — a live
 * adapter's incomplete answer — which the real simulator no longer produces
 * (it lists what it booked, R3).
 */
class RefusesWhileHoldingVenue implements TraderVenue {
  readonly inner: SimulatedVenue;

  constructor(inner: SimulatedVenue) {
    this.inner = inner;
  }

  observe(identity: Parameters<TraderVenue["observe"]>[0]): { readonly ok: boolean } {
    return this.inner.observe(identity);
  }

  observeTrade(input: Parameters<TraderVenue["observeTrade"]>[0]): ReturnType<TraderVenue["observeTrade"]> {
    return this.inner.observeTrade(input);
  }

  async submit(plan: unknown): Promise<ExecutionResult> {
    const offered = plan as PlacementPlanView;
    const group = offered.groups[0];
    const first = group?.orders[0];
    if (group === undefined || first === undefined) throw new Error("the double expects a placement plan");
    const booked = await this.inner.submit({ ...offered, groups: [{ ...group, orders: [first] }] });
    if (!booked.accepted) throw new Error(`the double's first order was refused: ${String(booked.refusalCode)}`);
    return {
      ...booked,
      accepted: false,
      outcome: "REFUSED",
      orders: [],
      fills: [],
      bands: [],
      notPlaced: [],
      refusalCode: "SIMULATED_VENUE_RATE_LIMITED",
      refusalMessage: "the venue refused the plan (test double: it still holds the plan's first order)",
    };
  }

  ordersSnapshot(): ReturnType<TraderVenue["ordersSnapshot"]> {
    return this.inner.ordersSnapshot();
  }

  get fills(): TraderVenue["fills"] {
    return this.inner.fills;
  }
}

interface Harness {
  readonly loop: CoreLoop;
  /** The REAL venue (behind the double, when one is used). */
  readonly venue: SimulatedVenue;
  readonly evaluations: EvaluationInput[];
  /** Every plan the loop offered the venue, as offered. */
  readonly submitted: unknown[];
  /** Every answer the loop received, in order. */
  readonly answers: ExecutionResult[];
}

/** `createPaperTrader`'s assembly, with the one-shot double's runtime registered. */
function assemble(
  input: {
    readonly rateLimits?: RateLimitBudget;
    /** The entry's size; 50 by default (10 slices, one batch). */
    readonly targetShares?: string;
    readonly maximumTotalCost?: string;
    /** Wraps the real venue in a scripted `TraderVenue` (the defensive path). */
    readonly venueDouble?: (inner: SimulatedVenue) => TraderVenue;
    /** Replaces the one-shot's resting BUY (the BASKET case). */
    readonly intent?: (ctx: StrategyContext) => Intent;
    /** Which outcome sides the VENUE sees a book for (the loop's books are untouched). */
    readonly venueBookSides?: readonly ("YES" | "NO")[];
  } = {},
): Harness {
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
    strategy: oneShotStrategy({
      targetShares: input.targetShares ?? "50",
      maximumTotalCost: input.maximumTotalCost ?? "18",
      ...(input.intent === undefined ? {} : { intent: input.intent }),
    }),
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
    rateLimits: input.rateLimits ?? unmodeledRateLimits("no venue budget is modelled for this case"),
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
        if (input.venueBookSides !== undefined && !input.venueBookSides.includes(request.side)) return undefined;
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
  const traderVenue: TraderVenue = input.venueDouble?.(venue) ?? venue;
  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator: new AllocatorGate({ caps: caps.value, markets: allocationMarkets, tokenAssetIds }),
    clock,
    venue: traderVenue,
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

  const harness: Harness = { loop, venue, evaluations: [], submitted: [], answers: [] };
  const evaluate = created.runtime.evaluate.bind(created.runtime);
  vi.spyOn(created.runtime, "evaluate").mockImplementation((input: EvaluationInput) => {
    harness.evaluations.push(input);
    return evaluate(input);
  });
  const submit = traderVenue.submit.bind(traderVenue);
  vi.spyOn(traderVenue, "submit").mockImplementation(async (plan: unknown) => {
    harness.submitted.push(plan);
    const answer = await submit(plan);
    harness.answers.push(answer);
    return answer;
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

/** A modelled per-signer order budget of `orderTokensPerWindow` per hour. */
function orderBudget(orderTokensPerWindow: number): RateLimitBudget {
  return tokenBucketRateLimits({
    orderTokensPerWindow,
    cancelTokensPerWindow: 10,
    windowMs: 3_600_000,
    snapshotVersion: "sim-1-refused-plan",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SIM-1 R3 — the REAL venue reports what it booked, and the loop OWNS it", () => {
  it("a 20-slice POSITION plan whose SECOND batch is refused: the 15 booked slices are owned, traced and delivered, the 5 refused are released, and nothing halts", async () => {
    // 100 shares at 0.2 in 5-share slices = 20 orders = two venue batches
    // (15 + 5). A 15-token budget admits the first batch and refuses the
    // second, all-or-nothing.
    const harness = assemble({ rateLimits: orderBudget(15), targetShares: "100", maximumTotalCost: "25" });
    await open(harness);
    const loop = harness.loop;
    const planned = plannedOrderIds(harness);
    expect(planned).toHaveLength(20);
    const bookedIds = planned.slice(0, 15);
    const refusedIds = planned.slice(15);

    // --- the venue's per-order answer ---------------------------------------
    expect(harness.answers).toHaveLength(1);
    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    expect(answer).toMatchObject({ accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATED_VENUE_RATE_LIMITED" });
    expect(answer.orders.map((order) => order.plannedOrderId)).toEqual(bookedIds);
    expect(answer.orders.every((order) => order.state === "RESTING")).toBe(true);
    expect(answer.notPlaced.map((entry) => entry.plannedOrderId)).toEqual(refusedIds);
    expect(answer.notPlaced.every((entry) => entry.refusalCode === "SIMULATED_VENUE_RATE_LIMITED")).toBe(true);
    expect(harness.venue.ordersSnapshot().map((order) => order.plannedOrderId).sort()).toEqual([...bookedIds].sort());

    let health = loop.health();
    expect(health.execution.submissionsRefused).toBe(1);
    expect(health.execution.submissionsAccepted).toBe(0);

    // --- the REFUSED slices are released, counted --------------------------
    expect(health.execution.reservationsReleasedOnRefusal).toBe(5);
    for (const plannedOrderId of refusedIds) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();

    // --- the BOOKED slices keep theirs — 15 × 5 × 0.2 = 15 pUSD ---------------
    for (const plannedOrderId of bookedIds) expect(loop.timeInForceFor(plannedOrderId)).toBe("GTC");
    expect(health.seams.reservations).toMatchObject({ open: 15, taken: 20, released: 5, reservedCollateral: "15" });
    expect(health.seams.allocator).toMatchObject({ open: 15, applied: 20, released: 5, reservedCollateral: "15" });

    // --- and are OWNED: owner, trace prefix, provenance ---------------------
    expect(health.seams.orders.tracked).toBe(15);
    expect(loop.retainedOrderState()).toMatchObject({ owners: 15, instanceOrderIds: 15, traceLookup: 15 });
    const plan = harness.submitted[0] as { readonly executionPlanId: string };
    const provenance = loop.orderProvenance();
    expect(provenance.map((record) => record.venueOrderId)).toEqual(answer.orders.map((order) => order.simulatedOrderId));
    expect(new Set(provenance.map((record) => record.executionPlanId))).toEqual(new Set([plan.executionPlanId]));
    expect(new Set(provenance.map((record) => record.submissionAttemptId)).size).toBe(1);
    expect(provenance.every((record) => record.intentId === "trdr4r1-resting-buy")).toBe(true);

    // --- a POSITION partial raises NO halt ----------------------------------
    expect(health.halts).toEqual([]);

    // --- delivered: the strategy sees its orders and can re-plan ------------
    const before = harness.evaluations.length;
    await feed(harness, yesBook(5));
    const later = harness.evaluations.slice(before);
    const updates = later.flatMap((evaluation) =>
      evaluation.callback === "onOrderUpdate" ? [evaluation.order] : [],
    );
    expect(updates.map((view) => view.orderId).sort()).toEqual([...bookedIds].sort());
    expect(updates.every((view) => view.status === "OPEN")).toBe(true);
    for (const evaluation of later) {
      expect(evaluation.orders.map((view) => view.orderId).sort()).toEqual([...bookedIds].sort());
    }

    // --- an OBSERVED trade fills them: ATTRIBUTED, released, retired, settled -
    await feed(
      harness,
      envelope(6, "PublicTradeObserved", {
        internalMarketId: MARKET_ID,
        tokenId: YES_TOKEN,
        price: "0.2",
        size: "75",
        takerSide: "ASK",
      }),
    );
    expect(harness.venue.ordersSnapshot().every((order) => order.state === "FILLED")).toBe(true);
    health = loop.health();
    expect(health.execution.fillsObserved).toBe(15);
    expect(health.seams.orders).toMatchObject({ tracked: 0, settled: 15, unownedFills: 0, settleMismatches: 0 });
    expect(health.accounting.unattributedActivity).toBe(0);
    expect(loop.traces().map((trace) => trace.venueOrderId).sort()).toEqual(
      answer.orders.map((order) => order.simulatedOrderId).sort(),
    );
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 20, released: 20, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 20, released: 20, reservedCollateral: "0" });
    for (const plannedOrderId of bookedIds) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();
    expect(health.halts).toEqual([]);
  });

  it("a plan of at most 15 orders against a budget SMALLER than it books NOTHING — the batch is admitted all-or-nothing (D-05, ADR-012 §5.6)", async () => {
    // TRDR-4's partial state (10 slices, ONE token: one slice booked, the plan
    // refused) — which the venue no longer produces.
    const harness = assemble({ rateLimits: orderBudget(1) });
    await open(harness);
    const loop = harness.loop;
    const planned = plannedOrderIds(harness);
    expect(planned).toHaveLength(10);
    expect(harness.venue.ordersSnapshot()).toEqual([]);
    expect(harness.answers[0]).toMatchObject({
      accepted: false,
      outcome: "REFUSED",
      orders: [],
      fills: [],
      refusalCode: "SIMULATED_VENUE_RATE_LIMITED",
    });
    expect(harness.answers[0]?.notPlaced.map((entry) => entry.plannedOrderId)).toEqual(planned);
    const health = loop.health();
    expect(health.execution.submissionsRefused).toBe(1);
    expect(health.execution.reservationsReleasedOnRefusal).toBe(10);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 10, released: 10, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 10, released: 10, reservedCollateral: "0" });
    for (const plannedOrderId of planned) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();
    expect(health.seams.orders.tracked).toBe(0);
    expect(health.halts).toEqual([]);
  });

  it("a plan the venue refused OUTRIGHT (it booked nothing) releases every planned order and raises no halt — MEDIUM-4 unchanged", async () => {
    // NO placement token: the first batch is refused, so nothing is booked.
    const harness = assemble({ rateLimits: orderBudget(0) });
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

describe("SIM-1 R3 — a BASKET the venue executed only IN PART halts its markets (nothing consumes failurePolicy yet)", () => {
  it("the booked YES leg is owned and attributed; the refused NO leg is released; the market halts BASKET_PARTIALLY_EXECUTED", async () => {
    // A two-leg basket in ONE market — BUY 10 YES (≤ 0.35) and BUY 10 NO
    // (≤ 0.67), planned as two groups of two 5-share slices — against a venue
    // that sees NO book for the NO side: the YES leg fills, the NO leg is
    // refused NO_BOOK. Risk, allocator, planner and venue are real; only the
    // basket's fee/slippage estimates are supplied (see the `vi.mock` above).
    const harness = assemble({
      venueBookSides: ["YES"],
      intent: (ctx) => ({
        type: "BASKET",
        intentId: "sim1-basket",
        legs: [
          { marketId: MARKET_ID, direction: "YES", targetShares: "10", maximumBuyPrice: "0.35" },
          { marketId: MARKET_ID, direction: "NO", targetShares: "10", maximumBuyPrice: "0.67" },
        ],
        maximumCombinedCost: "11",
        minimumLockedEdge: "1",
        legRiskLimit: "7",
        failurePolicy: "HOLD_FILLED_LEGS",
        validUntil: new Date(Date.parse(ctx.now()) + 3_600_000).toISOString(),
      }),
    });
    await open(harness);
    const loop = harness.loop;
    const plan = harness.submitted[0] as { readonly planKind: string; readonly executionPlanId: string };
    expect(plan.planKind).toBe("BASKET");
    const planned = plannedOrderIds(harness);
    expect(planned).toHaveLength(4);

    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    expect(answer).toMatchObject({ accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATED_VENUE_NO_BOOK" });
    expect(answer.orders.map((order) => `${order.side} ${order.state} ${order.filledShares}/${order.requestedShares}`)).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
    ]);
    expect(answer.notPlaced.map((entry) => entry.refusalCode)).toEqual([
      "SIMULATED_VENUE_NO_BOOK",
      "SIMULATED_VENUE_NO_BOOK",
    ]);

    const health = loop.health();
    // The booked leg is OWNED — its fills are attributed, never UNATTRIBUTED.
    expect(health.seams.orders).toMatchObject({ tracked: 2, unownedFills: 0 });
    expect(health.accounting.unattributedActivity).toBe(0);
    expect(loop.orderProvenance().map((record) => record.venueOrderId)).toEqual(
      answer.orders.map((order) => order.simulatedOrderId),
    );
    expect(loop.traces().map((trace) => trace.venueOrderId)).toEqual(
      answer.orders.map((order) => order.simulatedOrderId),
    );
    // The refused leg is released at the refusal; the booked (FILLED) leg at
    // the harvest that saw it terminal.
    expect(health.execution.reservationsReleasedOnRefusal).toBe(2);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 4, released: 4, reservedCollateral: "0" });

    // …and the market HALTS, naming the basket, what was booked and what was not.
    expect(health.halts).toHaveLength(1);
    const halt = health.halts[0];
    expect(halt?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halt?.code).toBe("BASKET_PARTIALLY_EXECUTED");
    expect(halt?.action).toBe("MANAGE_KNOWN_POSITIONS_ONLY");
    expect(halt?.detail).toContain(`basket plan ${plan.executionPlanId} (failurePolicy HOLD_FILLED_LEGS)`);
    expect(halt?.detail).toContain("booked 2 of its 4 planned orders");
    expect(halt?.detail).toContain("(SIMULATED_VENUE_NO_BOOK)");
  });
});

describe("TRDR4-R1, the DEFENSIVE path — a venue that REFUSES a plan while HOLDING part of it (scripted double)", () => {
  it("the RESTING first slice keeps its reservation, allocator commitment and time-in-force until it is terminal; the market halts for reconciliation", async () => {
    const harness = assemble({ venueDouble: (inner) => new RefusesWhileHoldingVenue(inner) });
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

});
