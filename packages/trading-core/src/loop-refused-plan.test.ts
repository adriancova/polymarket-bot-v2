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
 * A BASKET IS JUDGED FROM EACH ORDER'S OUTCOME (SIM-1 r2, `SIM1-R2-1`). The
 * venue's `accepted` says every planned order was PLACED, not that each
 * EXECUTED, so the same basket (same seam) halts when:
 *
 * 4a. it was ACCEPTED under FOK and its NO slices were REJECTED 0/5 while its
 *     YES slices FILLED (the verifier's reproduction) — at the answer, before
 *     anything was delivered to the strategy;
 * 4b. it was ACCEPTED under FAK and its NO slices were CANCELLED short (1/5);
 * 4c. its legs were DELAYED (a Tier-1 venue on a 5 s delayed market) and
 *     resolved FILLED / REJECTED at `matchableAtNs` — reached by `observe()`,
 *     or first by a TRADE when the venue's clock lags — and the halt lands
 *     before that event's evaluation;
 * 4d. it was ACCEPTED under GTC with its NO slices RESTING partly filled
 *     (watched, no halt), and the strategy's own market cancel then left them
 *     CANCELLED 1/5 beside a FILLED YES leg — judged in that event's harvest,
 *     before its deliveries.
 *
 *     Controls: every leg FILLED, or every leg REJECTED 0/5 (nothing executed),
 *     raise no halt; no basket watch remains in either.
 *
 * 4e. SIM-1 r3 (`SIM1-R3-1`): the same GTC basket, cancelled by the strategy
 *     from a DELIVERY callback (`onFill`, `onOrderUpdate`) of the harvest that
 *     delivers its fills — the halt is raised at the CANCEL's answer (accepted
 *     or PARTIAL), so the next delivery (which would BUY) is suppressed and the
 *     next intent of the same decision is refused at the risk seam
 *     (`RISK_RUN_STATE_BLOCKS`); nothing else reaches the venue. Control: a
 *     COMPLETE basket, where the same cancel-then-BUY raises no halt. And the
 *     harvest's own judgement, now a BACKSTOP, through a scripted venue whose
 *     order state moves BETWEEN the loop's calls (a venue-side cancel).
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
 * allocator, risk engine, execution planner, `SimulatedVenue` (Tier 0; Tier 1
 * on a delayed market in 4c) and ledger. WHAT IS DOUBLED: the clock and the
 * store (the trader's own in-memory doubles), the STRATEGY — a one-shot
 * double that emits the same §7.7 resting-entry intent shape Static Bracket
 * emits (Static Bracket's passive entry is not needed to reach the loop's
 * refusal branch), plus one follow-up cancel in 4d and the scripted delivery
 * callbacks of 4e — and, in the defensive
 * cases only, the venue's ANSWER (in 4e's backstop case, WHEN its order state
 * moves). PAPER only; no network, credential, signer or real order.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import {
  SimulatedVenue,
  deriveStreams,
  readFeeScheduleSnapshot,
  tier0Model,
  tier1Model,
  tokenBucketRateLimits,
  unmodeledRateLimits,
  type BookView,
  type ExecutionResult,
  type FeeScheduleSnapshot,
  type LatencyModel,
  type MarketBookProvider,
  type PlacementPlanView,
  type QueueModelParameters,
  type RateLimitBudget,
  type SimulatedOrder,
  type VenueRetentionBounds,
} from "@polymarket-bot/simulation";
import {
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  rebuildStateFromPatches,
  type DecisionRecord,
  type DecisionTelemetry,
  type EvaluationInput,
  type StrategyStateCheckpoint,
} from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PER_FRAME_EVALUATION_CADENCE } from "./cadence.js";
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
import { EVERY_FILL_ACCOUNTING_CHECKS } from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer, type TraderVenue } from "./loop.js";
import { MarketState } from "./market-state.js";
import {
  portFailed,
  portOk,
  type GroupCommit,
  type IngestedEvent,
  type PortResult,
  type RiskRefusalRecord,
  type StagedEvaluations,
  type TraderStore,
} from "./ports.js";
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

type Level = { readonly price: string; readonly size: string };

/** Tier-1 inputs for the SIM1-R2-1 DELAYED basket: no latency, and the §12.2 queue arms. */
const ZERO_LATENCY: LatencyModel = {
  latencyModelVersion: "sim1-r2/latency/zero",
  decision: { samples: [{ milliseconds: 0, weight: 1 }] },
  signing: { samples: [{ milliseconds: 0, weight: 1 }] },
  network: { samples: [{ milliseconds: 0, weight: 1 }] },
  venue: { samples: [{ milliseconds: 0, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};
const QUEUE_PARAMETERS: QueueModelParameters = {
  queueModelVersion: "sim1-r2/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

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

type OneShotState = { readonly placed?: boolean; readonly followed?: boolean };

/**
 * SIM1-R3-1: what the one-shot double emits from a DELIVERY callback — the
 * `delivery`-th invocation (from 1) of `onFill` or of `onOrderUpdate` — as ONE
 * decision carrying every listed intent, in order. An empty list holds.
 */
type DeliveryScript = (
  callback: "onFill" | "onOrderUpdate",
  delivery: number,
  ctx: StrategyContext,
) => readonly Intent[];

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
  /** `DURABLE-1`: replaces the entry decision's ONE intent with this list (several intents, one decision). */
  readonly intents?: (ctx: StrategyContext) => readonly Intent[];
  /** SIM1-R2-1: ONE follow-up intent (a cancel), emitted on the next `onFeatures` after the entry. */
  readonly followUp?: (ctx: StrategyContext) => Intent;
  /** SIM1-R3-1: the intents a DELIVERY callback emits (none: hold); see {@link DeliveryScript}. */
  readonly onDelivery?: DeliveryScript;
}): Strategy<unknown, OneShotState> {
  // How many times each delivery callback has been INVOKED (a suppressed
  // delivery is not an invocation), counted from 1.
  const invoked = { onFill: 0, onOrderUpdate: 0 };
  const deliver = (callback: "onFill" | "onOrderUpdate", ctx: StrategyContext): DecisionResult => {
    invoked[callback] += 1;
    const intents = entry.onDelivery?.(callback, invoked[callback], ctx) ?? [];
    if (intents.length === 0) return hold(ctx);
    return {
      decisionType: intents[0]?.type === "CANCEL" ? "cancel" : "enter",
      reasonCodes: ["SIM1R3.DELIVERY"],
      featureSnapshotRef: ctx.features().snapshotRef,
      intents: [...intents],
    };
  };
  return {
    name: "trdr4r1-one-shot-double",
    version: "1.0.0",
    paramsSchema: z.strictObject({}),
    stateSchemaVersion: 1,
    onStart: hold,
    onMarketOpen: hold,
    onTimer: hold,
    onFill: (ctx: StrategyContext) => deliver("onFill", ctx),
    onOrderUpdate: (ctx: StrategyContext) => deliver("onOrderUpdate", ctx),
    onMarketClosing: (ctx: StrategyContext) => hold(ctx),
    onMarketResolved: (ctx: StrategyContext) => hold(ctx),
    onStop: (ctx: StrategyContext) => hold(ctx),
    onFeatures(ctx: StrategyContext): DecisionResult {
      const state = ctx.state<OneShotState>();
      if (state.placed === true && entry.followUp !== undefined && state.followed !== true) {
        return {
          decisionType: "cancel",
          reasonCodes: ["SIM1R2.FOLLOW_UP"],
          featureSnapshotRef: ctx.features().snapshotRef,
          statePatch: { followed: true },
          intents: [entry.followUp(ctx)],
        };
      }
      if (state.placed === true) return hold(ctx);
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
        intents: entry.intents === undefined ? [entry.intent?.(ctx) ?? buy] : [...entry.intents(ctx)],
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

  fillsSince(sequence: number): ReturnType<TraderVenue["fillsSince"]> {
    return this.inner.fillsSince(sequence);
  }

  orderById(venueOrderId: string): ReturnType<TraderVenue["orderById"]> {
    return this.inner.orderById(venueOrderId);
  }

  orderByPlannedId(plannedOrderId: string): ReturnType<TraderVenue["orderByPlannedId"]> {
    return this.inner.orderByPlannedId(plannedOrderId);
  }

  acknowledgeTerminal(venueOrderId: string): boolean {
    return this.inner.acknowledgeTerminal(venueOrderId);
  }
}

/**
 * SIM1-R3-1's BACKSTOP case: a `TraderVenue` whose order state MOVES BETWEEN
 * the loop's calls, as a live venue's does when its user channel reports a
 * venue-side cancel. Armed with an action, it runs it — once — when the loop
 * next reads its fills (SIM-2: `fillsSince`), which is the first thing a
 * harvest does; everything else
 * is the real venue's. The real simulator's state moves only inside
 * `observe()`, `observeTrade()` and `submit()`, each of which the loop judges
 * at its answer; this double is what the harvest's own judgement exists for.
 */
class MovesBetweenCallsVenue implements TraderVenue {
  readonly inner: SimulatedVenue;
  #armed: (() => void) | undefined;

  constructor(inner: SimulatedVenue) {
    this.inner = inner;
  }

  arm(action: () => void): void {
    this.#armed = action;
  }

  observe(identity: Parameters<TraderVenue["observe"]>[0]): { readonly ok: boolean } {
    return this.inner.observe(identity);
  }

  observeTrade(input: Parameters<TraderVenue["observeTrade"]>[0]): ReturnType<TraderVenue["observeTrade"]> {
    return this.inner.observeTrade(input);
  }

  async submit(plan: unknown): Promise<ExecutionResult> {
    return await this.inner.submit(plan as Parameters<SimulatedVenue["submit"]>[0]);
  }

  fillsSince(sequence: number): ReturnType<TraderVenue["fillsSince"]> {
    const armed = this.#armed;
    this.#armed = undefined;
    armed?.();
    return this.inner.fillsSince(sequence);
  }

  orderById(venueOrderId: string): ReturnType<TraderVenue["orderById"]> {
    return this.inner.orderById(venueOrderId);
  }

  orderByPlannedId(plannedOrderId: string): ReturnType<TraderVenue["orderByPlannedId"]> {
    return this.inner.orderByPlannedId(plannedOrderId);
  }

  acknowledgeTerminal(venueOrderId: string): boolean {
    return this.inner.acknowledgeTerminal(venueOrderId);
  }
}

interface Harness {
  readonly loop: CoreLoop;
  /** The loop's clock (and the venue's, unless a Tier-1 case gives it its own). */
  readonly clock: ManualClock;
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
    /** `DURABLE-1`: the entry decision's intents, several in one decision. */
    readonly intents?: (ctx: StrategyContext) => readonly Intent[];
    /** `DURABLE-1`: the store the loop writes to (a fresh `MemoryTraderStore` when absent). */
    readonly store?: TraderStore;
    /** SIM1-R2-1: the one-shot's ONE follow-up intent (a cancel), on the next `onFeatures`. */
    readonly followUp?: (ctx: StrategyContext) => Intent;
    /** SIM1-R3-1: what the one-shot emits from its `onFill` / `onOrderUpdate` deliveries. */
    readonly onDelivery?: DeliveryScript;
    /** Which outcome sides the VENUE sees a book for (the loop's books are untouched). */
    readonly venueBookSides?: readonly ("YES" | "NO")[];
    /**
     * SIM1-R2-1: rewrites the VENUE's ladders only (the loop's books are
     * untouched) — e.g. one share per NO ask level, so a NO leg cannot fill.
     */
    readonly venueLadder?: (side: "YES" | "NO", ladderSide: "BID" | "ASK", levels: readonly Level[]) => readonly Level[];
    /**
     * SIM1-R2-1: the instance's `immediate_order_type` (FAK by default). A
     * BASKET intent carries no order-type tag, so its legs take this one.
     */
    readonly immediateOrderType?: "FAK" | "FOK" | "GTC";
    /**
     * SIM1-R2-1: a TIER-1 venue on a DELAYED market (`secondsDelay`, zero
     * latency) over the same books, optionally on its OWN clock (default: the
     * loop's). The shipped trader runs Tier 0, which never delays.
     */
    readonly tier1?: { readonly secondsDelay: number; readonly venueClock?: ManualClock };
    /** SIM-2 r1: the venue's history bounds (its defaults when absent). */
    readonly venueRetention?: VenueRetentionBounds;
    /**
     * `CKPT-1`: replaces the runtime's checkpoint port (the outbox's
     * `appendCheckpoint`) — the `SAVE_CHECKPOINT` halt case.
     */
    readonly checkpointSave?: (checkpoint: StrategyStateCheckpoint, append: (checkpoint: StrategyStateCheckpoint) => void) => void;
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
      ...(input.intents === undefined ? {} : { intents: input.intents }),
      ...(input.followUp === undefined ? {} : { followUp: input.followUp }),
      ...(input.onDelivery === undefined ? {} : { onDelivery: input.onDelivery }),
    }),
    params: {},
    run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: "41" },
    watchdog: { evaluationBudgetUs: 5_000_000 },
    clock: { nowNs: () => clock.monotonicNs() },
    decisionSink: { persist: (record, telemetry) => outbox.appendDecision(record, telemetry) },
    checkpointStore: {
      save: (checkpoint) => {
        const append = (owed: StrategyStateCheckpoint): void => {
          outbox.appendCheckpoint(owed);
        };
        if (input.checkpointSave === undefined) append(checkpoint);
        else input.checkpointSave(checkpoint, append);
      },
    },
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
    immediateOrderType: input.immediateOrderType ?? "FAK",
    submissionUnknownAfterMs: 5_000,
  });
  if (!registered.ok) throw new Error(registered.detail);

  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error("fees refused");
  const wiring: { loop: CoreLoop | undefined } = { loop: undefined };
  const books: MarketBookProvider = {
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
          const levels = market.bookFor(request.side).levels(side).map((level) => ({ price: level.price, size: level.size }));
          return input.venueLadder === undefined ? levels : input.venueLadder(request.side, side, levels);
        },
      };
    },
  };
  const common = {
    runMode: "PAPER" as const,
    feeSnapshot: fees.value,
    rateLimits: input.rateLimits ?? unmodeledRateLimits("no venue budget is modelled for this case"),
    // `main.ts`'s `createExecutionPolicy` semantics: the loop's recorded
    // time-in-force, and a refusal (throw, contained by the venue) otherwise.
    policy: {
      timeInForceFor(order: { readonly plannedOrderId: string }) {
        const resolved = wiring.loop?.timeInForceFor(order.plannedOrderId);
        if (resolved === undefined) throw new Error(`no time-in-force for ${order.plannedOrderId}`);
        return resolved;
      },
      statedExpiryNsFor: () => undefined,
      sameInstantAdditionsFor: () => "NOT_OBSERVED" as const,
    },
    startingCash: "1000",
    ...(input.venueRetention === undefined ? {} : { retention: input.venueRetention }),
  };
  const tier1 = input.tier1;
  // The Tier-1 venue, once built: its timeline anchors a book to the event it is at.
  const built: { venue?: SimulatedVenue } = {};
  const venue =
    tier1 === undefined
      ? new SimulatedVenue({
          ...common,
          clock,
          model: tier0Model({ fillModelVersion: "tier0.trdr4r1", fillModelParametersHash: "d".repeat(64) }),
          books,
        })
      : new SimulatedVenue({
          ...common,
          clock: tier1.venueClock ?? clock,
          model: tier1Model({ fillModelVersion: "tier1.sim1-r2", fillModelParametersHash: "e".repeat(64) }),
          timeline: {
            bookAt(request) {
              const book = books.book(request);
              const atEvent = built.venue?.atEvent;
              return book === undefined || atEvent === undefined ? undefined : { book, atEvent };
            },
          },
          latencyModel: ZERO_LATENCY,
          streams: deriveStreams("41"),
          marketParameters: () => ({
            marketId: MARKET_ID,
            tickSize: "0.01",
            minimumOrderSize: "5",
            secondsDelay: tier1.secondsDelay,
            parametersVersion: 1,
          }),
          queueParameters: QUEUE_PARAMETERS,
        });
  built.venue = venue;
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
    store: input.store ?? new MemoryTraderStore(),
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
    // `FOLD-1` (orchestrator call O1): checked against the rebuilds after EVERY fill.
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
    // `CADENCE-1` (ADR-026 D1.6; r1, O07): this harness's subject is the refused-plan
    // and capital paths, not the cadence — but its timelines were written for
    // ADR-024's per-frame cadence: a scripted strategy that acts at named events,
    // often at one instant. Under the production cadence (1,000 ms / 5,000 ms) those
    // evaluations are coalesced, and 2 of this file's 26 tests fail under it (measured
    // in r1; the failures were not analysed one by one). So it REPRODUCES the ADR-024
    // behaviour its timelines pin (the value 0, declared); this subject is NOT
    // exercised here under the production cadence. The cadence is pinned by
    // `cadence.test.ts` and `loop-cadence.test.ts`.
    evaluationCadence: { ...PER_FRAME_EVALUATION_CADENCE, reproduces: "adr-024:packages/trading-core/src/loop-refused-plan.test.ts" },
  });
  wiring.loop = loop;

  const harness: Harness = { loop, clock, venue, evaluations: [], submitted: [], answers: [] };
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

/**
 * The R3 basket, as the SIM1-R2-1 cases submit it: BUY 10 YES (≤ 0.35) and
 * BUY 10 NO (≤ 0.67) in ONE market, planned as two groups of two 5-share
 * slices. A basket intent carries no order-type tag, so its slices take the
 * instance's `immediate_order_type`.
 */
function twoLegBasket(ctx: StrategyContext): Intent {
  return {
    type: "BASKET",
    intentId: "sim1-r2-basket",
    legs: [
      { marketId: MARKET_ID, direction: "YES", targetShares: "10", maximumBuyPrice: "0.35" },
      { marketId: MARKET_ID, direction: "NO", targetShares: "10", maximumBuyPrice: "0.67" },
    ],
    maximumCombinedCost: "11",
    minimumLockedEdge: "1",
    legRiskLimit: "7",
    failurePolicy: "HOLD_FILLED_LEGS",
    validUntil: new Date(Date.parse(ctx.now()) + 3_600_000).toISOString(),
  };
}

/** One share per ask level, at the VENUE only, for the named sides: a 5-share slice there cannot fill whole. */
function oneShareAsks(sides: readonly ("YES" | "NO")[]) {
  return (side: "YES" | "NO", ladderSide: "BID" | "ASK", levels: readonly Level[]): readonly Level[] =>
    sides.includes(side) && ladderSide === "ASK" ? levels.map((level) => ({ price: level.price, size: "1" })) : levels;
}

function legs(orders: readonly SimulatedOrder[]): readonly string[] {
  return orders.map((order) => `${order.side} ${order.state} ${order.filledShares}/${order.requestedShares}`);
}

function basketHalts(harness: Harness): ReturnType<CoreLoop["health"]>["halts"] {
  return harness.loop.health().halts.filter((record) => record.code === "BASKET_PARTIALLY_EXECUTED");
}

/** The basket's recorded 5 s delay window, from the submission at recorded monotonic 0. */
const MATCHABLE_NS = 5_000_000_000n;

describe("SIM1-R2-1 — a BASKET is judged from EACH ORDER'S outcome, not from the venue's `accepted`", () => {
  it("the verifier's reproduction: an ACCEPTED FOK basket — YES FILLED, NO REJECTED 0/5 — halts BASKET_PARTIALLY_EXECUTED at submission; its legs stay owned and are released at terminal", async () => {
    const harness = assemble({ immediateOrderType: "FOK", venueLadder: oneShareAsks(["NO"]), intent: twoLegBasket });
    await open(harness);
    const loop = harness.loop;
    const plan = harness.submitted[0] as { readonly planKind: string; readonly executionPlanId: string };
    expect(plan.planKind).toBe("BASKET");
    const planned = plannedOrderIds(harness);
    expect(planned).toHaveLength(4);

    // The venue PLACED every order — `accepted` is true — and two of them
    // executed nothing (O2: a FOK that cannot fill whole is REJECTED 0/n).
    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    expect(answer).toMatchObject({ accepted: true, outcome: "ACCEPTED", notPlaced: [] });
    expect(answer.refusalCode).toBeUndefined();
    expect(legs(answer.orders)).toEqual(["YES FILLED 5/5", "YES FILLED 5/5", "NO REJECTED 0/5", "NO REJECTED 0/5"]);

    const health = loop.health();
    // The market HALTS, naming the basket and each leg's outcome.
    const halts = basketHalts(harness);
    expect(health.halts).toHaveLength(1);
    expect(halts).toHaveLength(1);
    const halt = halts[0];
    expect(halt?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halt?.action).toBe("MANAGE_KNOWN_POSITIONS_ONLY");
    expect(halt?.detail).toContain(`basket plan ${plan.executionPlanId} (failurePolicy HOLD_FILLED_LEGS)`);
    expect(halt?.detail).toContain("booked 4 of its 4 planned orders");
    expect(halt?.detail).toContain("2 booked order(s) ended short of their size");
    for (const order of answer.orders) {
      expect(halt?.detail).toContain(
        `${order.simulatedOrderId} (planned ${order.plannedOrderId}) ${order.state} ${order.filledShares}/5`,
      );
    }

    // Every leg is OWNED — the YES fills are attributed, never UNATTRIBUTED.
    expect(health.execution.submissionsAccepted).toBe(1);
    expect(health.seams.orders).toMatchObject({ unownedFills: 0 });
    expect(health.execution.fillsObserved).toBe(2);
    expect(health.accounting.unattributedActivity).toBe(0);
    expect(loop.orderProvenance().map((record) => record.venueOrderId)).toEqual(
      answer.orders.map((order) => order.simulatedOrderId),
    );
    expect(loop.traces().map((trace) => trace.venueOrderId)).toEqual(
      answer.orders.filter((order) => order.side === "YES").map((order) => order.simulatedOrderId),
    );
    // Nothing was refused, so nothing was released AT the answer; every leg
    // is terminal, so all four came back at the harvest that saw it terminal.
    expect(health.execution.reservationsReleasedOnRefusal).toBe(0);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 4, released: 4, reservedCollateral: "0" });
    for (const plannedOrderId of planned) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();

    // The halt was raised AT the answer — before the harvest delivered
    // anything — so the strategy was never handed the half-built basket.
    expect(harness.evaluations.filter((evaluation) => evaluation.callback === "onFill")).toEqual([]);
    expect(harness.evaluations.filter((evaluation) => evaluation.callback === "onOrderUpdate")).toEqual([]);
    expect(health.loop.deliveriesSuppressedByHalt).toBeGreaterThan(0);
    // The watch ended with the halt; nothing about the basket is retained.
    expect(loop.retainedOrderState().basketWatches).toBe(0);

    const before = harness.evaluations.length;
    await feed(harness, yesBook(5));
    expect(harness.evaluations.slice(before)).toEqual([]);
  });

  it("a FAK basket whose NO slices are CANCELLED short (1 of 5 filled each) halts the same way (O1: a FAK remainder is CANCELLED)", async () => {
    const harness = assemble({ immediateOrderType: "FAK", venueLadder: oneShareAsks(["NO"]), intent: twoLegBasket });
    await open(harness);
    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    expect(answer).toMatchObject({ accepted: true, outcome: "ACCEPTED", notPlaced: [] });
    expect(legs(answer.orders)).toEqual(["YES FILLED 5/5", "YES FILLED 5/5", "NO CANCELLED 1/5", "NO CANCELLED 1/5"]);
    const halts = basketHalts(harness);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.detail).toContain("2 booked order(s) ended short of their size");
    expect(halts[0]?.detail).toContain("CANCELLED 1/5");
    const health = harness.loop.health();
    expect(health.seams.orders).toMatchObject({ unownedFills: 0 });
    expect(health.execution.fillsObserved).toBe(4);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    expect(harness.loop.retainedOrderState().basketWatches).toBe(0);
  });

  it("a DELAYED basket (Tier 1, 5 s delayed market): no halt inside the window; at matchableAtNs its NO slices resolve REJECTED while YES fills, and the market halts BEFORE the strategy is evaluated at that event", async () => {
    const harness = assemble({
      immediateOrderType: "FOK",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      tier1: { secondsDelay: 5 },
    });
    await open(harness);
    const loop = harness.loop;
    const planned = plannedOrderIds(harness);
    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    expect(answer).toMatchObject({ accepted: true, outcome: "ACCEPTED", notPlaced: [] });
    expect(legs(answer.orders)).toEqual(["YES DELAYED 0/5", "YES DELAYED 0/5", "NO DELAYED 0/5", "NO DELAYED 0/5"]);

    // Inside the window every leg can still execute: WATCHED, not halted,
    // and every entry is still held (ADR-006 §9).
    expect(loop.health().halts).toEqual([]);
    expect(loop.retainedOrderState().basketWatches).toBe(1);
    expect(loop.health().seams.reservations).toMatchObject({ open: 4, taken: 4, released: 0 });
    for (const plannedOrderId of planned) expect(loop.timeInForceFor(plannedOrderId)).toBe("FOK");
    await feed(harness, yesBook(5));
    expect(loop.health().halts).toEqual([]);
    expect(loop.retainedOrderState().basketWatches).toBe(1);

    // The recorded clock reaches matchableAtNs; the next event's observe()
    // applies each leg's disposition.
    harness.clock.positionAt(new Date(T_START_MS + 6 * STEP_MS).toISOString(), MATCHABLE_NS);
    const before = harness.evaluations.length;
    await feed(harness, yesBook(6));
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO REJECTED 0/5",
      "NO REJECTED 0/5",
    ]);
    const halts = basketHalts(harness);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halts[0]?.detail).toContain("REJECTED 0/5");
    // Judged right after observe(): the event's own evaluation, the fill
    // deliveries and the order views were all withheld from the strategy.
    expect(harness.evaluations.slice(before)).toEqual([]);
    const health = loop.health();
    expect(health.seams.orders).toMatchObject({ unownedFills: 0 });
    expect(health.execution.fillsObserved).toBe(2);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 4, released: 4, reservedCollateral: "0" });
    for (const plannedOrderId of planned) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();
    expect(loop.retainedOrderState().basketWatches).toBe(0);
  });

  it("the same DELAYED basket reached first by a TRADE (the venue's clock lags the loop's): judged right after observeTrade(), before the trade event's evaluation", async () => {
    const venueClock = new ManualClock(T_OPEN);
    const harness = assemble({
      immediateOrderType: "FOK",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      tier1: { secondsDelay: 5, venueClock },
    });
    await open(harness);
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES DELAYED 0/5",
      "YES DELAYED 0/5",
      "NO DELAYED 0/5",
      "NO DELAYED 0/5",
    ]);
    harness.clock.positionAt(new Date(T_START_MS + 5 * STEP_MS).toISOString(), MATCHABLE_NS);
    // observe() at the VENUE's clock (0): still pending, nothing said.
    await feed(harness, yesBook(5));
    expect(harness.venue.ordersSnapshot().every((order) => order.state === "DELAYED")).toBe(true);
    expect(harness.loop.health().halts).toEqual([]);

    const before = harness.evaluations.length;
    await feed(
      harness,
      envelope(6, "PublicTradeObserved", {
        internalMarketId: MARKET_ID,
        tokenId: YES_TOKEN,
        price: "0.32",
        size: "5",
        takerSide: "ASK",
      }),
    );
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO REJECTED 0/5",
      "NO REJECTED 0/5",
    ]);
    expect(basketHalts(harness)).toHaveLength(1);
    expect(harness.evaluations.slice(before)).toEqual([]);
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 0, released: 4, reservedCollateral: "0" });
    expect(harness.loop.retainedOrderState().basketWatches).toBe(0);
  });

  it("a GTC basket whose NO slices REST partly filled is WATCHED, not halted; the strategy's own market cancel leaves them CANCELLED 1/5 beside a FILLED YES leg, and the market halts at THAT event (at the cancel's answer since r3), before its harvest's deliveries", async () => {
    const harness = assemble({
      immediateOrderType: "GTC",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      followUp: () => ({ type: "CANCEL", marketId: MARKET_ID, reason: "sim1-r2: cancel the basket's working legs" }),
    });
    await open(harness);
    const loop = harness.loop;
    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    expect(answer).toMatchObject({ accepted: true, outcome: "ACCEPTED", notPlaced: [] });
    // O3: a MARKETABLE_LIMIT GTC remainder RESTS — the NO slices can still fill.
    expect(legs(answer.orders)).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO PARTIALLY_FILLED 1/5",
      "NO PARTIALLY_FILLED 1/5",
    ]);
    expect(loop.health().halts).toEqual([]);
    expect(loop.retainedOrderState().basketWatches).toBe(1);

    // Event 5: the strategy cancels its market's working orders — the NO slices.
    const before = harness.evaluations.length;
    await feed(harness, yesBook(5));
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO CANCELLED 1/5",
      "NO CANCELLED 1/5",
    ]);
    const halts = basketHalts(harness);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.at).toBe(new Date(T_START_MS + 5 * STEP_MS).toISOString());
    expect(halts[0]?.detail).toContain("2 booked order(s) ended short of their size");
    // Judged at the cancel's answer (r3, `SIM1-R3-1`; r2 judged it in the
    // harvest), so BEFORE the harvest's deliveries: the only evaluation of
    // event 5 is the one that cancelled; the CANCELLED views were withheld.
    expect(harness.evaluations.slice(before).map((evaluation) => evaluation.callback)).toEqual(["onFeatures"]);
    const health = loop.health();
    expect(health.execution.cancelsConfirmed).toBe(1);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    expect(health.seams.orders).toMatchObject({ unownedFills: 0 });
    expect(loop.retainedOrderState().basketWatches).toBe(0);
  });

  it("the controls: a basket whose every leg FILLED, and one that executed NOTHING (every leg REJECTED 0/5), raise no halt; both are released, delivered and retired, and no watch remains", async () => {
    for (const control of [
      { cap: [] as ("YES" | "NO")[], expected: ["YES FILLED 5/5", "YES FILLED 5/5", "NO FILLED 5/5", "NO FILLED 5/5"], fills: 4 },
      {
        cap: ["YES", "NO"] as ("YES" | "NO")[],
        expected: ["YES REJECTED 0/5", "YES REJECTED 0/5", "NO REJECTED 0/5", "NO REJECTED 0/5"],
        fills: 0,
      },
    ]) {
      const harness = assemble({ immediateOrderType: "FOK", venueLadder: oneShareAsks(control.cap), intent: twoLegBasket });
      await open(harness);
      const answer = harness.answers[0];
      if (answer === undefined) throw new Error("no answer was recorded");
      expect(answer).toMatchObject({ accepted: true, outcome: "ACCEPTED", notPlaced: [] });
      expect(legs(answer.orders)).toEqual(control.expected);
      const health = harness.loop.health();
      expect(health.halts).toEqual([]);
      expect(health.execution.fillsObserved).toBe(control.fills);
      expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
      expect(health.seams.allocator).toMatchObject({ open: 0, applied: 4, released: 4, reservedCollateral: "0" });
      expect(harness.loop.retainedOrderState()).toMatchObject({ basketWatches: 0, owners: 0 });
      expect(health.seams.orders).toMatchObject({ tracked: 0, settled: 4, unownedFills: 0 });
      const delivered = harness.evaluations.flatMap((evaluation) =>
        evaluation.callback === "onOrderUpdate" ? [evaluation.order.orderId] : [],
      );
      expect([...delivered].sort()).toEqual(answer.orders.map((order) => order.simulatedOrderId).sort());
    }
  });
});

/**
 * SIM1-R3-1's follow-on: an AGGRESSIVE 5-share YES BUY (≤ 0.35) that the
 * venue's full YES book fills whole at once — the "another order" a strategy
 * must not be able to execute once its basket has gone short.
 */
function followOnBuy(ctx: StrategyContext): Intent {
  return {
    type: "POSITION",
    intentId: "sim1-r3-follow-on-buy",
    marketId: MARKET_ID,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: "5",
    maximumBuyPrice: "0.35",
    maximumTotalCost: "2",
    urgency: "IMMEDIATE",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: new Date(Date.parse(ctx.now()) + 3_600_000).toISOString(),
    expectedNetEdge: "5",
    tags: ["sim1r3.follow-on", "sb.order-type:FAK"],
  };
}

const MARKET_CANCEL: Intent = { type: "CANCEL", marketId: MARKET_ID, reason: "sim1-r3: cancel the basket's working legs" };

function planKinds(harness: Harness): readonly string[] {
  return harness.submitted.map((plan) => (plan as { readonly planKind: string }).planKind);
}

function callbacks(harness: Harness, from = 0): readonly string[] {
  return harness.evaluations.slice(from).map((evaluation) => evaluation.callback);
}

/** Event 4's instant: the basket is submitted, and its fills harvested and delivered, at it. */
const T_EVENT_4 = new Date(T_START_MS + 4 * STEP_MS).toISOString();

describe("SIM1-R3-1 — a basket a DELIVERY callback leaves short halts at the venue's answer, before any other intent or callback executes", () => {
  it("onFill: the first fill delivery cancels the basket's working NO legs (CANCELLED 1/5 beside FILLED YES); the halt is raised at the cancel's answer, and the second onFill — which would BUY — is never delivered", async () => {
    const harness = assemble({
      immediateOrderType: "GTC",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      onDelivery: (callback, delivery, ctx) =>
        callback !== "onFill" ? [] : delivery === 1 ? [MARKET_CANCEL] : delivery === 2 ? [followOnBuy(ctx)] : [],
    });
    await open(harness);
    const loop = harness.loop;
    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    // O3: the NO slices RESTED partly filled at the answer — the basket was WORKING.
    expect(legs(answer.orders)).toEqual(["YES FILLED 5/5", "YES FILLED 5/5", "NO PARTIALLY_FILLED 1/5", "NO PARTIALLY_FILLED 1/5"]);

    // The cancel was submitted and nothing after it: no POSITION reached the venue.
    expect(planKinds(harness)).toEqual(["BASKET", "CANCEL"]);
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO CANCELLED 1/5",
      "NO CANCELLED 1/5",
    ]);
    const halts = basketHalts(harness);
    expect(loop.health().halts).toHaveLength(1);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halts[0]?.at).toBe(T_EVENT_4);
    expect(halts[0]?.detail).toContain("2 booked order(s) ended short of their size");
    expect(halts[0]?.detail).toContain("CANCELLED 1/5");
    // The ONE onFill that cancelled was the last evaluation: the three other
    // fill deliveries and every order view of this harvest were suppressed.
    expect(callbacks(harness)).toEqual(["onFeatures", "onFill"]);
    const health = loop.health();
    expect(health.execution.cancelsConfirmed).toBe(1);
    expect(health.loop.deliveriesSuppressedByHalt).toBeGreaterThanOrEqual(3);
    expect(health.seams.orders).toMatchObject({ unownedFills: 0 });
    expect(loop.retainedOrderState().basketWatches).toBe(0);
    // Every leg is terminal, so every entry came back — the halt stops
    // decisions, not the capital path (ADR-006 §9: none before terminal).
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 4, released: 4, reservedCollateral: "0" });

    // The next event is not evaluated either.
    const before = harness.evaluations.length;
    await feed(harness, yesBook(5));
    expect(harness.evaluations.slice(before)).toEqual([]);
    expect(planKinds(harness)).toEqual(["BASKET", "CANCEL"]);
  });

  it("onOrderUpdate: the first order view's evaluation cancels the NO legs; the halt is raised at the cancel's answer, and the next view — which would BUY — is never delivered", async () => {
    const harness = assemble({
      immediateOrderType: "GTC",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      onDelivery: (callback, delivery, ctx) =>
        callback !== "onOrderUpdate" ? [] : delivery === 1 ? [MARKET_CANCEL] : delivery === 2 ? [followOnBuy(ctx)] : [],
    });
    await open(harness);
    const loop = harness.loop;
    expect(planKinds(harness)).toEqual(["BASKET", "CANCEL"]);
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO CANCELLED 1/5",
      "NO CANCELLED 1/5",
    ]);
    const halts = basketHalts(harness);
    expect(loop.health().halts).toHaveLength(1);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.at).toBe(T_EVENT_4);
    expect(halts[0]?.detail).toContain("CANCELLED 1/5");
    // Four fill deliveries (held), then ONE order view — the one that cancelled.
    expect(callbacks(harness)).toEqual(["onFeatures", "onFill", "onFill", "onFill", "onFill", "onOrderUpdate"]);
    expect(loop.health().execution.cancelsConfirmed).toBe(1);
    expect(loop.retainedOrderState().basketWatches).toBe(0);

    // The NO legs' views in this harvest's boundary predate the cancel; their
    // entries come back at the next harvest that SEES them terminal, still
    // with no evaluation.
    const before = harness.evaluations.length;
    await feed(harness, yesBook(5));
    expect(harness.evaluations.slice(before)).toEqual([]);
    expect(planKinds(harness)).toEqual(["BASKET", "CANCEL"]);
    expect(loop.health().seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    expect(loop.health().seams.allocator).toMatchObject({ open: 0, applied: 4, released: 4, reservedCollateral: "0" });
  });

  it("ONE decision [CANCEL, POSITION]: the cancel leaves the basket short and halts at its answer, so the decision's next intent is refused at the risk seam (RISK_RUN_STATE_BLOCKS) and never reaches the venue", async () => {
    const harness = assemble({
      immediateOrderType: "GTC",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      onDelivery: (callback, delivery, ctx) =>
        callback === "onFill" && delivery === 1 ? [MARKET_CANCEL, followOnBuy(ctx)] : [],
    });
    await open(harness);
    const loop = harness.loop;
    expect(planKinds(harness)).toEqual(["BASKET", "CANCEL"]);
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO CANCELLED 1/5",
      "NO CANCELLED 1/5",
    ]);
    expect(basketHalts(harness)).toHaveLength(1);
    expect(basketHalts(harness)[0]?.at).toBe(T_EVENT_4);
    const health = loop.health();
    expect(health.risk.refusalsByCode["RISK_RUN_STATE_BLOCKS"]).toBe(1);
    expect(health.execution.cancelsConfirmed).toBe(1);
    expect(callbacks(harness)).toEqual(["onFeatures", "onFill"]);
    expect(loop.retainedOrderState().basketWatches).toBe(0);
  });

  it("a PARTIAL cancel answer (orderIds: a working NO leg and a FILLED YES leg — one cancelled, one 'already FILLED', accepted: false) is judged too: the halt is raised at that answer and the next onFill — which would BUY — is never delivered", async () => {
    // The basket's answer, read by the strategy double through the harness
    // (it is recorded before the harvest delivers anything).
    const wired: { harness?: Harness } = {};
    const harness = assemble({
      immediateOrderType: "GTC",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      onDelivery: (callback, delivery, ctx) => {
        if (callback !== "onFill") return [];
        if (delivery === 1) {
          const booked = wired.harness?.answers[0]?.orders ?? [];
          const yes = booked.find((order) => order.side === "YES");
          const no = booked.find((order) => order.side === "NO");
          if (yes === undefined || no === undefined) throw new Error("the basket's answer was not recorded");
          return [
            {
              type: "CANCEL",
              marketId: MARKET_ID,
              orderIds: [no.simulatedOrderId, yes.simulatedOrderId],
              reason: "sim1-r3: cancel one NO leg, and a YES leg that already FILLED",
            },
          ];
        }
        return delivery === 2 ? [followOnBuy(ctx)] : [];
      },
    });
    wired.harness = harness;
    await open(harness);
    const loop = harness.loop;
    expect(planKinds(harness)).toEqual(["BASKET", "CANCEL"]);
    const cancelAnswer = harness.answers[1];
    if (cancelAnswer === undefined) throw new Error("no cancel answer was recorded");
    expect(cancelAnswer).toMatchObject({ accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATED_VENUE_CANCEL_INCOMPLETE" });
    expect(cancelAnswer.notCancelled.map((entry) => entry.reason)).toEqual(["already FILLED"]);
    // One NO leg CANCELLED short, the other still working — beside FILLED YES.
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO CANCELLED 1/5",
      "NO PARTIALLY_FILLED 1/5",
    ]);
    const halts = basketHalts(harness);
    expect(loop.health().halts).toHaveLength(1);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.at).toBe(T_EVENT_4);
    expect(halts[0]?.detail).toContain("1 booked order(s) ended short of their size");
    expect(callbacks(harness)).toEqual(["onFeatures", "onFill"]);
    const health = loop.health();
    expect(health.execution.cancelsRejected).toBe(1);
    expect(loop.retainedOrderState().basketWatches).toBe(0);
    // The working NO leg keeps its entries while it can still fill (ADR-006 §9).
    expect(health.seams.reservations).toMatchObject({ open: 1, taken: 4, released: 3 });
  });

  it("the harvest's BACKSTOP: a venue whose order state moves BETWEEN the loop's calls (scripted double — a venue-side cancel of the NO legs, first seen by the harvest) halts before that harvest's deliveries", async () => {
    const doubled: { venue?: MovesBetweenCallsVenue } = {};
    const harness = assemble({
      immediateOrderType: "GTC",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      venueDouble: (inner) => {
        const venue = new MovesBetweenCallsVenue(inner);
        doubled.venue = venue;
        return venue;
      },
    });
    await open(harness);
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO PARTIALLY_FILLED 1/5",
      "NO PARTIALLY_FILLED 1/5",
    ]);
    expect(harness.loop.health().halts).toEqual([]);
    expect(harness.loop.retainedOrderState().basketWatches).toBe(1);

    const noLegs = harness.venue
      .ordersSnapshot()
      .filter((order) => order.side === "NO")
      .map((order) => order.simulatedOrderId);
    doubled.venue?.arm(() => {
      void harness.venue.cancel({
        executionPlanId: "sim1-r3-venue-side",
        reason: "sim1-r3: a venue-side cancel the loop did not ask for",
        scope: { orderIds: noLegs },
        priority: "SAFETY_CANCEL",
      });
    });
    const before = harness.evaluations.length;
    await feed(harness, yesBook(5));
    expect(legs(harness.venue.ordersSnapshot())).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO CANCELLED 1/5",
      "NO CANCELLED 1/5",
    ]);
    const halts = basketHalts(harness);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.at).toBe(new Date(T_START_MS + 5 * STEP_MS).toISOString());
    // Event 5's own evaluation ran before the venue moved; the harvest then
    // judged the basket before delivering the CANCELLED views.
    expect(callbacks(harness, before)).toEqual(["onFeatures"]);
    expect(planKinds(harness)).toEqual(["BASKET"]);
    expect(harness.loop.retainedOrderState().basketWatches).toBe(0);
    expect(harness.loop.health().seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
  });

  it("the control: a COMPLETE basket (every leg FILLED, nothing watched) — the same callback cancel then BUY raises no halt, and the BUY is placed: the judgement after an answer halts only a basket that went short", async () => {
    const harness = assemble({
      immediateOrderType: "GTC",
      intent: twoLegBasket,
      onDelivery: (callback, delivery, ctx) =>
        callback !== "onFill" ? [] : delivery === 1 ? [MARKET_CANCEL] : delivery === 2 ? [followOnBuy(ctx)] : [],
    });
    await open(harness);
    expect(legs(harness.answers[0]?.orders ?? [])).toEqual(["YES FILLED 5/5", "YES FILLED 5/5", "NO FILLED 5/5", "NO FILLED 5/5"]);
    expect(planKinds(harness)).toEqual(["BASKET", "CANCEL", "POSITION"]);
    expect(harness.loop.health().halts).toEqual([]);
    expect(legs(harness.venue.ordersSnapshot()).slice(4)).toEqual(["YES FILLED 5/5"]);
    expect(harness.loop.retainedOrderState().basketWatches).toBe(0);
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

    // (4) No instance owns it — and (SIM-2) the loop TRACKS it, because its
    // harvest no longer scans every venue order to find what to release.
    expect(health.seams.orders.tracked).toBe(0);
    expect(loop.retainedOrderState().owners).toBe(0);
    expect(loop.retainedOrderState().heldUnowned).toBe(1);

    // --- still WORKING across later harvests: nothing is released ---------
    await feed(harness, yesBook(5));
    await feed(harness, yesBook(6));
    health = loop.health();
    expect(harness.venue.ordersSnapshot()[0]?.state).toBe("RESTING");
    expect(loop.timeInForceFor(resting.plannedOrderId)).toBe("GTC");
    expect(health.seams.reservations).toMatchObject({ open: 1, released: 9, reservedCollateral: "1" });
    expect(health.seams.allocator).toMatchObject({ open: 1, released: 9, reservedCollateral: "1" });
    expect(loop.retainedOrderState().heldUnowned).toBe(1);

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
    // SIM-2: released, so no longer tracked — and (r1) the venue is told it
    // may forget the order now, and not before.
    expect(loop.retainedOrderState().heldUnowned).toBe(0);
    expect(harness.venue.retention().awaitingAcknowledgment).toBe(0);

    // The strategy never saw the orphan: no delivery, no ctx.orders() view.
    for (const evaluation of harness.evaluations) {
      expect(evaluation.callback === "onOrderUpdate" && evaluation.order.orderId === resting.simulatedOrderId).toBe(false);
      expect(evaluation.orders.map((order) => order.orderId)).not.toContain(resting.simulatedOrderId);
    }
  });

});

describe("SIM-2 r1 — a WATCHED basket's settled leg stays answerable until the watch concludes (the venue retains ONE acknowledged order)", () => {
  it("a GTC basket: the YES legs FILL and SETTLE at once while the NO legs rest; a later trade fills the NO legs — the watch still finds every leg, concludes COMPLETE, and only then are the YES legs acknowledged", async () => {
    const harness = assemble({
      immediateOrderType: "GTC",
      venueLadder: oneShareAsks(["NO"]),
      intent: twoLegBasket,
      venueRetention: { orders: 1, tombstones: 1 },
    });
    await open(harness);
    const loop = harness.loop;
    const answer = harness.answers[0];
    if (answer === undefined) throw new Error("no answer was recorded");
    expect(legs(answer.orders)).toEqual([
      "YES FILLED 5/5",
      "YES FILLED 5/5",
      "NO PARTIALLY_FILLED 1/5",
      "NO PARTIALLY_FILLED 1/5",
    ]);
    const yesLegs = answer.orders.filter((order) => order.side === "YES").map((order) => order.simulatedOrderId);
    // The YES legs were delivered, retired and SETTLED at event 4's harvest —
    // yet the venue still HOLDS them: a watched basket reads them.
    expect(loop.health().halts).toEqual([]);
    expect(loop.health().seams.orders.settled).toBe(2);
    expect(loop.retainedOrderState()).toMatchObject({ basketWatches: 1, owners: 2, watchedOrders: 4 });
    expect(harness.venue.retention()).toMatchObject({ awaitingAcknowledgment: 2, orders: { retained: 0, evicted: 0 } });
    for (const id of yesLegs) expect(harness.venue.orderById(id)?.state).toBe("FILLED");

    // Event 5: a public NO trade through the resting NO legs fills them.
    await feed(
      harness,
      envelope(5, "PublicTradeObserved", {
        internalMarketId: MARKET_ID,
        tokenId: NO_TOKEN,
        price: "0.6",
        size: "20",
        takerSide: "ASK",
      }),
    );
    // Every leg ended FILLED — read from the deliveries, because the venue's
    // history, bounded at ONE acknowledged order, now keeps only the last.
    const noLegs = answer.orders.filter((order) => order.side === "NO").map((order) => order.simulatedOrderId);
    const terminalViews = harness.evaluations.flatMap((evaluation) =>
      evaluation.callback === "onOrderUpdate" && evaluation.order.status === "FILLED" ? [evaluation.order.orderId] : [],
    );
    expect([...terminalViews].sort()).toEqual([...yesLegs, ...noLegs].sort());
    // COMPLETE: no halt of any kind, no watch left behind (at 7c570ed a
    // forgotten leg read as "still working" kept it for ever — or, there, the
    // first leg's eviction inside the submission halted GLOBAL).
    const health = loop.health();
    expect(health.halts).toEqual([]);
    expect(loop.retainedOrderState()).toMatchObject({ basketWatches: 0, watchedOrders: 0, owners: 0 });
    expect(health.seams.orders).toMatchObject({ settled: 4, unownedFills: 0 });
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 4, released: 4, reservedCollateral: "0" });
    // Every leg acknowledged once the watch let go of it; the bound applies now.
    expect(harness.venue.retention()).toMatchObject({
      awaitingAcknowledgment: 0,
      orders: { retained: 1, maximumRetained: 1, evicted: 3 },
    });
  });
});

/**
 * `DURABLE-1` (closeout blocker X1): the durability boundary before a
 * placement, on the branches the Static Bracket fixture cannot reach — a
 * decision with SEVERAL intents, a CANCEL beside a placement, and a staging
 * failure. The store refuses (as data) every decision that carries an intent;
 * everything else is the real loop, risk, allocator, planner and venue.
 */
describe("DURABLE-1: a placement waits for its decision to be durable", () => {
  /** A per-row store that refuses every intent-bearing decision, counting what it was asked. */
  function refusingStore(): { readonly store: TraderStore; readonly inner: MemoryTraderStore; readonly refused: number[] } {
    const inner = new MemoryTraderStore();
    const refused: number[] = [];
    const store: TraderStore = {
      persistDecision: async (record, telemetry) => {
        if (record.decision.intents.length > 0) {
          refused.push(record.evaluationSeq);
          return portFailed<null>("UNAVAILABLE", "durable-1: the store refuses this decision");
        }
        return await inner.persistDecision(record, telemetry);
      },
      // `CKPT-1`: a decision that owes a checkpoint is written WITH it, in one
      // write; the store refuses that write the same way (neither row lands).
      persistDecisionWithCheckpoint: async (record, telemetry, checkpoint, capturedAt) => {
        if (record.decision.intents.length > 0) {
          refused.push(record.evaluationSeq);
          return portFailed<null>("UNAVAILABLE", "durable-1: the store refuses this decision");
        }
        return await inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt);
      },
      appendLedgerTransaction: (transaction) => inner.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
      persistRiskRefusal: (refusal) => inner.persistRiskRefusal(refusal),
      close: () => inner.close(),
    };
    return { store, inner, refused };
  }

  /** `open`, split before its fourth event (the one the entry is decided at). */
  async function openUntilEntry(harness: Harness): Promise<void> {
    await feed(harness, envelope(1, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, "binance"));
    await feed(harness, envelope(2, "MarketOpened", { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN }));
    await feed(harness, envelope(3, "BookSnapshot", {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "5000" }],
      asks: [{ price: "0.66", size: "5000" }],
    }));
  }

  it("a decision with TWO placements whose record is refused: the store is asked ONCE, neither placement is reserved or submitted — each is refused (and counted) at the risk seam under the halt — and nothing of that event is written afterwards", async () => {
    const { store, inner, refused } = refusingStore();
    const harness = assemble({ store, intents: (ctx) => [followOnBuy(ctx), { ...followOnBuy(ctx), intentId: "durable-1-second-buy" }] });
    await openUntilEntry(harness);
    const before = { decisions: inner.decisions.length, checkpoints: inner.checkpoints.length };
    await feed(harness, yesBook(4));
    // The control: with a store that accepts, the same event DOES write a
    // checkpoint (the entry's state patch) — so the equality below is not vacuous.
    const accepting = new MemoryTraderStore();
    const control = assemble({ store: accepting, intents: (ctx) => [followOnBuy(ctx), { ...followOnBuy(ctx), intentId: "durable-1-second-buy" }] });
    await openUntilEntry(control);
    const controlBefore = accepting.checkpoints.length;
    await feed(control, yesBook(4));
    expect(accepting.checkpoints.length).toBeGreaterThan(controlBefore);
    // Nothing of the failing event reached the store after the failure — not
    // its checkpoint either (a failed flush drops what it drained).
    expect({ decisions: inner.decisions.length, checkpoints: inner.checkpoints.length }).toEqual(before);

    expect(refused).toHaveLength(1);
    expect(harness.submitted).toEqual([]);
    const health = harness.loop.health();
    // r1 (LOW-4): each refused placement is COUNTED, under the halt's own code.
    expect(health.risk).toMatchObject({ evaluations: 2, approvals: 0, refusals: 2 });
    expect(health.risk.refusalsByCode).toEqual({ RISK_RUN_STATE_BLOCKS: 2 });
    expect(health.execution.plansBuilt).toBe(0);
    expect(health.seams.allocator.applied).toBe(0);
    expect(health.seams.reservations.taken).toBe(0);
    expect(harness.venue.fills).toHaveLength(0);
    expect(inner.transactions).toHaveLength(0);
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
    // The decision itself was emitted, with both intents on it.
    expect(harness.loop.decisions().filter((decision) => decision.intentIds.length === 2)).toHaveLength(1);
  });

  it("a CANCEL beside a placement, the record refused: the CANCEL is still routed (never held for its record); the placement is not", async () => {
    const { store, refused } = refusingStore();
    const harness = assemble({ store, intents: (ctx) => [MARKET_CANCEL, followOnBuy(ctx)] });
    await open(harness);

    expect(refused).toHaveLength(1);
    // The CANCEL reached risk (approved: §6 invariant 13) and was requested;
    // the placement was refused at the seam under the halt, never reserved
    // or submitted.
    const health = harness.loop.health();
    expect(health.risk).toMatchObject({ evaluations: 2, approvals: 1, refusals: 1 });
    expect(health.risk.refusalsByCode).toEqual({ RISK_RUN_STATE_BLOCKS: 1 });
    expect(health.execution.cancelsRequested).toBe(1);
    expect(planKinds(harness)).toEqual(["CANCEL"]);
    expect(health.seams.allocator.applied).toBe(0);
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
  });

  it("group commit, a STAGING failure at the boundary: nothing is placed, and nothing of that event is committed afterwards", async () => {
    const inner = new MemoryTraderStore();
    const staged: StagedEvaluations[] = [];
    const group: GroupCommit = {
      stage(evaluations) {
        if (evaluations.decisions.some((entry) => entry.record.decision.intents.length > 0)) {
          return portFailed<null>("UNAVAILABLE", "durable-1: this decision cannot be staged");
        }
        staged.push(evaluations);
        return portOk(null);
      },
      get stagedEvents() {
        return staged.length;
      },
      async commit() {
        const batch = staged.splice(0, staged.length);
        let decisions = 0;
        let checkpoints = 0;
        for (const evaluation of batch) {
          for (const entry of evaluation.decisions) {
            await inner.persistDecision(entry.record, entry.telemetry);
            decisions += 1;
          }
          for (const entry of evaluation.checkpoints) {
            await inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
            checkpoints += 1;
          }
          for (const refusal of evaluation.riskRefusals) await inner.persistRiskRefusal(refusal);
        }
        return portOk({ decisions, checkpoints });
      },
    };
    const store: TraderStore = {
      persistDecision: (record, telemetry) => inner.persistDecision(record, telemetry),
      persistDecisionWithCheckpoint: (record, telemetry, checkpoint, capturedAt) =>
        inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
      appendLedgerTransaction: (transaction) => inner.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
      persistRiskRefusal: (refusal) => inner.persistRiskRefusal(refusal),
      close: () => inner.close(),
      groupCommit: group,
    };
    const harness = assemble({ store, intents: (ctx) => [followOnBuy(ctx)] });
    await openUntilEntry(harness);
    const before = { decisions: inner.decisions.length, checkpoints: inner.checkpoints.length };
    await feed(harness, yesBook(4));

    expect(harness.submitted).toEqual([]);
    const health = harness.loop.health();
    expect(health.risk).toMatchObject({ evaluations: 1, approvals: 0, refusals: 1 });
    expect(health.seams.allocator.applied).toBe(0);
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
    expect(health.halts[0]?.detail).toContain("could not be staged");
    // The entry decision was emitted at the fourth event; neither it nor that
    // event's checkpoint became durable after the failure.
    expect(harness.loop.decisions().some((decision) => decision.intentIds.length > 0)).toBe(true);
    expect({ decisions: inner.decisions.length, checkpoints: inner.checkpoints.length }).toEqual(before);
    // r1 (LOW-5): the entry decision never became durable, so the mark says
    // so (base answered `true` here).
    expect(await harness.loop.durabilityMark()).toBe(false);
    expect({ decisions: inner.decisions.length, checkpoints: inner.checkpoints.length }).toEqual(before);
  });

  it("LOW-5, per-row: a refused decision write makes durabilityMark() answer false", async () => {
    const { store } = refusingStore();
    const harness = assemble({ store, intents: (ctx) => [followOnBuy(ctx)] });
    await openUntilEntry(harness);
    expect(await harness.loop.durabilityMark()).toBe(true);
    await feed(harness, yesBook(4));
    expect(harness.submitted).toEqual([]);
    expect(await harness.loop.durabilityMark()).toBe(false);
  });
});

/**
 * `DURABLE-1` r1, finding A01 (astra DURABLE1-ASTRA-R1-01): a CANCEL the
 * strategy has emitted never waits on its OWN decision's record, whatever its
 * position in the decision's intent list. The store HOLDS the intent-bearing
 * decision (per-row: its `persistDecision`; group commit: the commit that
 * carries it) until the test releases it; while it is held, the CANCEL must
 * already be out and the placement must not. Both orderings, both modes.
 */
describe("DURABLE-1 r1 (A01): a CANCEL is not held behind a placement's durability wait", () => {
  function heldStore(grouped: boolean): {
    readonly store: TraderStore;
    readonly inner: MemoryTraderStore;
    readonly held: Promise<void>;
    readonly release: () => void;
  } {
    const inner = new MemoryTraderStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const carriesIntent = (record: { readonly decision: { readonly intents: readonly unknown[] } }): boolean =>
      record.decision.intents.length > 0;
    const staged: StagedEvaluations[] = [];
    const group: GroupCommit = {
      stage(evaluations) {
        staged.push(evaluations);
        return portOk(null);
      },
      get stagedEvents() {
        return staged.length;
      },
      async commit() {
        const batch = staged.splice(0, staged.length);
        if (batch.some((evaluation) => evaluation.decisions.some((entry) => carriesIntent(entry.record)))) {
          reached();
          await gate;
        }
        let decisions = 0;
        let checkpoints = 0;
        for (const evaluation of batch) {
          for (const entry of evaluation.decisions) {
            await inner.persistDecision(entry.record, entry.telemetry);
            decisions += 1;
          }
          for (const entry of evaluation.checkpoints) {
            await inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
            checkpoints += 1;
          }
          for (const refusal of evaluation.riskRefusals) await inner.persistRiskRefusal(refusal);
        }
        return portOk({ decisions, checkpoints });
      },
    };
    const store: TraderStore = {
      persistDecision: async (record, telemetry) => {
        if (carriesIntent(record)) {
          reached();
          await gate;
        }
        return await inner.persistDecision(record, telemetry);
      },
      // `CKPT-1`: the paired write (a decision with the checkpoint it owes) is
      // held the same way.
      persistDecisionWithCheckpoint: async (record, telemetry, checkpoint, capturedAt) => {
        if (carriesIntent(record)) {
          reached();
          await gate;
        }
        return await inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt);
      },
      appendLedgerTransaction: (transaction) => inner.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
      persistRiskRefusal: (refusal) => inner.persistRiskRefusal(refusal),
      close: () => inner.close(),
      ...(grouped ? { groupCommit: group } : {}),
    };
    return { store, inner, held, release };
  }

  async function openUntilEntry(harness: Harness): Promise<void> {
    await feed(harness, envelope(1, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, "binance"));
    await feed(harness, envelope(2, "MarketOpened", { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN }));
    await feed(harness, envelope(3, "BookSnapshot", {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "5000" }],
      asks: [{ price: "0.66", size: "5000" }],
    }));
  }

  const orderings: readonly (readonly [string, (ctx: StrategyContext) => readonly Intent[]])[] = [
    ["[placement, CANCEL]", (ctx) => [followOnBuy(ctx), MARKET_CANCEL]],
    ["[CANCEL, placement]", (ctx) => [MARKET_CANCEL, followOnBuy(ctx)]],
  ];
  for (const grouped of [false, true]) {
    for (const [label, intents] of orderings) {
      it(`${grouped ? "group commit" : "per-row"}, ${label}, the store HOLDING the decision: the CANCEL is out, the placement waits; released, the placement follows`, async () => {
        const held = heldStore(grouped);
        const harness = assemble({ store: held.store, intents });
        await openUntilEntry(harness);
        if (!harness.loop.ingest(yesBook(4))) throw new Error("ingest refused");
        const drained = harness.loop.drain();
        await held.held;
        // Let every turn that does not depend on the held write run.
        for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));

        expect(planKinds(harness)).toEqual(["CANCEL"]);
        expect(harness.loop.health().execution.cancelsRequested).toBe(1);
        expect(harness.venue.fills).toHaveLength(0);
        expect(held.inner.transactions).toHaveLength(0);
        expect(held.inner.decisions.some((entry) => entry.record.decision.intents.length > 0)).toBe(false);

        held.release();
        await drained;
        expect(planKinds(harness)).toEqual(["CANCEL", "POSITION"]);
        expect(harness.loop.health().halts).toEqual([]);
        // The placement's decision was durable before its fill was booked.
        expect(held.inner.decisions.some((entry) => entry.record.decision.intents.length === 2)).toBe(true);
      });
    }
  }
});

/**
 * `CKPT-1` — ADR-027 Decision 3, `CKPT-1`'s choice: a decision that owes a
 * checkpoint and that checkpoint are durable TOGETHER, in one store transaction
 * (the other option, a restore that detects the missing checkpoint and refuses,
 * cannot see an RNG change in a decision row). This closes `DURABLE-1` LOW-3:
 * the durability boundary before a placement used to make the decision durable
 * ALONE — in group mode its own commit, per-row its own autocommit — and leave
 * its checkpoint to the flush after the callback, so a crash between the two
 * left a durable decision whose checkpoint was not.
 *
 * "Crash" here is a store that stops answering — every write after the named
 * one never resolves — which is what a dead process looks like from the
 * database: what was committed stays, nothing after it lands. The real-
 * PostgreSQL version is `test/integration/paper-trader/checkpoint-durable-together-postgres.test.ts`.
 */
describe("CKPT-1 (ADR-027 D3, DURABLE-1 LOW-3): a decision and the checkpoint it owes are durable together", () => {
  async function openUntilEntry(harness: Harness): Promise<void> {
    await feed(harness, envelope(1, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, "binance"));
    await feed(harness, envelope(2, "MarketOpened", { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN }));
    await feed(harness, envelope(3, "BookSnapshot", {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "5000" }],
      asks: [{ price: "0.66", size: "5000" }],
    }));
  }

  /** Lets every turn that does not wait on a dead store run. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  const carriesIntent = (record: DecisionRecord): boolean => record.decision.intents.length > 0;
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  /**
   * The store a dead process leaves behind: per-row writes go to `inner` until
   * the first write that carries an intent-bearing decision has landed; every
   * write after it never resolves. It also offers the lone `saveCheckpoint`
   * write the trader used before `CKPT-1`, so this file can be replayed against
   * that loop, where these tests must fail.
   */
  class CrashAfterIntentDecision implements TraderStore {
    readonly inner = new MemoryTraderStore();
    crashed = false;

    async #write<T>(write: () => Promise<PortResult<T>>, landsIntentDecision: boolean): Promise<PortResult<T>> {
      if (this.crashed) return await never<PortResult<T>>();
      const written = await write();
      if (landsIntentDecision) this.crashed = true;
      return written;
    }

    async persistDecision(record: DecisionRecord, telemetry: DecisionTelemetry): Promise<PortResult<null>> {
      return await this.#write(() => this.inner.persistDecision(record, telemetry), carriesIntent(record));
    }

    async persistDecisionWithCheckpoint(
      record: DecisionRecord,
      telemetry: DecisionTelemetry,
      checkpoint: StrategyStateCheckpoint,
      capturedAt: string,
    ): Promise<PortResult<null>> {
      return await this.#write(
        () => this.inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
        carriesIntent(record),
      );
    }

    async saveCheckpoint(checkpoint: StrategyStateCheckpoint, capturedAt: string): Promise<PortResult<null>> {
      return await this.#write(() => this.inner.saveCheckpoint(checkpoint, capturedAt), false);
    }

    async persistRiskRefusal(refusal: RiskRefusalRecord): Promise<PortResult<null>> {
      return await this.#write(() => this.inner.persistRiskRefusal(refusal), false);
    }

    async appendLedgerTransaction(transaction: Parameters<TraderStore["appendLedgerTransaction"]>[0]): Promise<PortResult<null>> {
      return await this.#write(() => this.inner.appendLedgerTransaction(transaction), false);
    }

    async writePnlSnapshot(snapshot: Parameters<TraderStore["writePnlSnapshot"]>[0]): Promise<PortResult<null>> {
      return await this.#write(() => this.inner.writePnlSnapshot(snapshot), false);
    }

    async replacePnlSnapshot(snapshot: Parameters<TraderStore["replacePnlSnapshot"]>[0]): Promise<PortResult<null>> {
      return await this.#write(() => this.inner.replacePnlSnapshot(snapshot), false);
    }

    async close(): Promise<void> {
      await this.inner.close();
    }
  }

  /**
   * The group-commit form: with `crash`, the first COMMIT that lands an
   * intent-bearing decision is the last one that lands.
   */
  function crashingGroupCommit(
    store: CrashAfterIntentDecision,
    crash: boolean,
  ): { readonly group: GroupCommit; readonly stagings: StagedEvaluations[] } {
    const stagings: StagedEvaluations[] = [];
    let pending: StagedEvaluations[] = [];
    const group: GroupCommit = {
      stage(evaluations) {
        stagings.push(evaluations);
        pending.push(evaluations);
        return portOk(null);
      },
      get stagedEvents() {
        return pending.length;
      },
      async commit() {
        const batch = pending;
        pending = [];
        if (store.crashed) return await never<PortResult<{ decisions: number; checkpoints: number }>>();
        let decisions = 0;
        let checkpoints = 0;
        for (const evaluation of batch) {
          for (const entry of evaluation.decisions) {
            await store.inner.persistDecision(entry.record, entry.telemetry);
            decisions += 1;
          }
          for (const entry of evaluation.checkpoints) {
            await store.inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
            checkpoints += 1;
          }
          for (const refusal of evaluation.riskRefusals) await store.inner.persistRiskRefusal(refusal);
        }
        if (crash && batch.some((evaluation) => evaluation.decisions.some((entry) => carriesIntent(entry.record)))) {
          store.crashed = true;
        }
        return portOk({ decisions, checkpoints });
      },
    };
    return { group, stagings };
  }

  /** `store`'s writes, with `group` as its group commit. */
  function groupedStore(store: CrashAfterIntentDecision, group: GroupCommit): TraderStore {
    return {
      persistDecision: (record, telemetry) => store.persistDecision(record, telemetry),
      persistDecisionWithCheckpoint: (record, telemetry, checkpoint, capturedAt) =>
        store.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
      appendLedgerTransaction: (transaction) => store.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => store.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => store.replacePnlSnapshot(snapshot),
      persistRiskRefusal: (refusal) => store.persistRiskRefusal(refusal),
      close: () => store.close(),
      groupCommit: group,
    };
  }

  /** What a restore would read: every durable decision that changed the state has its checkpoint. */
  function expectDurableTogether(inner: MemoryTraderStore): void {
    const entry = inner.decisions.find((written) => carriesIntent(written.record));
    expect(entry, "the intent-bearing decision is durable (the crash came after it)").toBeDefined();
    const seq = entry?.record.evaluationSeq ?? -1;
    // The checkpoint the entry owed (its patch moved the state) is durable with it…
    expect(inner.checkpoints.map((checkpoint) => checkpoint.checkpointSeq)).toContain(seq);
    // …so the LAST durable checkpoint is the fold of every durable decision's
    // patch: a restore from it does not resume older than a durable change.
    const folded = rebuildStateFromPatches(inner.decisions.map((written) => written.record.decision.statePatch));
    expect(folded.ok && canonicalJsonStringify(folded.state)).toBe(inner.checkpoints.at(-1)?.stateJson);
  }

  it("group commit: the boundary before a placement stages the decision WITH its checkpoint — one staging, one commit (fails at base: checkpoints [])", async () => {
    const store = new CrashAfterIntentDecision();
    // No crash in this case: it reads what the boundary STAGED.
    const { group, stagings } = crashingGroupCommit(store, false);
    const harness = assemble({ store: groupedStore(store, group), intents: (ctx) => [followOnBuy(ctx)] });
    await openUntilEntry(harness);
    await feed(harness, yesBook(4));
    const carrying = stagings.filter((staging) => staging.decisions.some((entry) => carriesIntent(entry.record)));
    expect(carrying).toHaveLength(1);
    const seq = carrying[0]?.decisions.find((entry) => carriesIntent(entry.record))?.record.evaluationSeq;
    expect(carrying[0]?.checkpoints.map((entry) => entry.checkpoint.checkpointSeq)).toContain(seq);
  });

  it("group commit, a CRASH right after the commit that made the entry decision durable: its checkpoint is durable too (fails at base)", async () => {
    const store = new CrashAfterIntentDecision();
    const { group } = crashingGroupCommit(store, true);
    const harness = assemble({ store: groupedStore(store, group), intents: (ctx) => [followOnBuy(ctx)] });
    await openUntilEntry(harness);
    expect(harness.loop.ingest(yesBook(4))).toBe(true);
    void harness.loop.drain();
    await settle();
    expect(store.crashed).toBe(true);
    expectDurableTogether(store.inner);
  });

  it("per-row, a CRASH right after the write that made the entry decision durable: its checkpoint is durable too (fails at base)", async () => {
    const store = new CrashAfterIntentDecision();
    const harness = assemble({ store, intents: (ctx) => [followOnBuy(ctx)] });
    await openUntilEntry(harness);
    expect(harness.loop.ingest(yesBook(4))).toBe(true);
    void harness.loop.drain();
    await settle();
    expect(store.crashed).toBe(true);
    expectDurableTogether(store.inner);
    // Per-row, the pair is ONE write: the store was asked for it, not for a
    // lone checkpoint.
    expect(store.inner.checkpoints.length).toBeGreaterThan(0);
  });

  it("a checkpoint the outbox cannot queue WITH its decision (the runtime's SAVE_CHECKPOINT halt): neither is written, and a GLOBAL halt stops the process", async () => {
    const inner = new MemoryTraderStore();
    let armed = false;
    let refusedSeq = -1;
    const harness = assemble({
      store: inner,
      intents: (ctx) => [followOnBuy(ctx)],
      checkpointSave: (checkpoint, append) => {
        // Once armed, the next checkpoint — the entry's: its decision moved the
        // state — cannot be queued: the port throws, as the outbox does on a
        // broken pairing.
        if (armed) {
          refusedSeq = checkpoint.checkpointSeq;
          throw new Error("ckpt-1: this checkpoint cannot be queued with its decision");
        }
        append(checkpoint);
      },
    });
    await openUntilEntry(harness);
    armed = true;
    const before = { decisions: inner.decisions.length, checkpoints: inner.checkpoints.length };
    await feed(harness, yesBook(4));
    expect(refusedSeq).toBeGreaterThanOrEqual(0);
    // The runtime HALTED that evaluation (its record was handed to the outbox,
    // its checkpoint was not), so it is not in the loop's decision log either.
    expect(harness.loop.decisions().map((decision) => decision.evaluationSeq)).not.toContain(refusedSeq);
    expect(inner.decisions.some((written) => carriesIntent(written.record))).toBe(false);
    const halts = harness.loop.health().halts.map((halt) => [halt.scope.kind, halt.code]);
    expect(halts).toContainEqual(["STRATEGY_INSTANCE", "RUNTIME_PERSISTENCE_FAILED"]);
    expect(halts).toContainEqual(["GLOBAL", "STORE_UNAVAILABLE"]);
    // The decision whose checkpoint could not be queued never became durable,
    // and nothing of that event was written after it.
    expect(inner.decisions.map((written) => written.record.evaluationSeq)).not.toContain(refusedSeq);
    expect({ decisions: inner.decisions.length, checkpoints: inner.checkpoints.length }).toEqual(before);
    expect(harness.submitted).toEqual([]);
    expect(await harness.loop.durabilityMark()).toBe(false);
  });
});

describe("CKPT-1: the outbox holds a checkpoint ON the decision it follows", () => {
  function record(seq: number, intents = 0): DecisionRecord {
    return {
      runId: RUN_ID,
      instanceId: INSTANCE_ID,
      evaluationSeq: seq,
      decision: { intents: Array.from({ length: intents }, () => ({})) },
    } as unknown as DecisionRecord;
  }
  function checkpoint(seq: number, runId: string = RUN_ID): StrategyStateCheckpoint {
    return { runId, instanceId: INSTANCE_ID, checkpointSeq: seq } as unknown as StrategyStateCheckpoint;
  }
  const telemetry = { evaluationDurationUs: 0 };

  it("attaches a checkpoint to the decision appended last, and drains them as pairs", () => {
    const outbox = new DecisionOutboxBuffer(8);
    outbox.appendDecision(record(0), telemetry);
    outbox.appendCheckpoint(checkpoint(0));
    outbox.appendDecision(record(1), telemetry);
    outbox.appendDecision(record(2), telemetry);
    outbox.appendCheckpoint(checkpoint(2));
    expect(outbox.depth).toBe(5);
    const drained = outbox.drain();
    expect(drained.map((entry) => [entry.record.evaluationSeq, entry.checkpoint?.checkpointSeq])).toEqual([
      [0, 0],
      [1, undefined],
      [2, 2],
    ]);
    expect(outbox.drain()).toEqual([]);
  });

  it("refuses — never queues alone — a checkpoint that does not follow the decision appended last", () => {
    const outbox = new DecisionOutboxBuffer(8);
    expect(() => outbox.appendCheckpoint(checkpoint(0))).toThrow(/does not follow/u);
    outbox.appendDecision(record(0), telemetry);
    expect(() => outbox.appendCheckpoint(checkpoint(1))).toThrow(/does not follow/u);
    expect(() => outbox.appendCheckpoint(checkpoint(0, "another-run"))).toThrow(/does not follow/u);
    outbox.appendCheckpoint(checkpoint(0));
    expect(() => outbox.appendCheckpoint(checkpoint(0))).toThrow(/does not follow/u);
    expect(outbox.drain().map((entry) => entry.checkpoint?.checkpointSeq)).toEqual([0]);
  });

  it("the bound counts decisions; a checkpoint never fails for capacity", () => {
    const outbox = new DecisionOutboxBuffer(1);
    outbox.appendDecision(record(0), telemetry);
    expect(() => outbox.appendDecision(record(1), telemetry)).toThrow(/maximum depth/u);
    expect(() => outbox.appendCheckpoint(checkpoint(0))).not.toThrow();
  });
});
