/**
 * `TRDR-4` — the trader loop's per-order lifecycle, pinned against the REAL
 * composition (books, features, strategy runtime, Static Bracket, allocator,
 * risk, planner, `SimulatedVenue`, ledger, PnL).
 *
 * What is doubled, and only where a test needs a state the real run does not
 * reach on its own: the clock and the durable store are the trader's own
 * in-memory doubles; a `TraderVenue` WRAPPER around the real `SimulatedVenue`
 * injects a fill, misreports one order's `filledShares`, or loses one cancel
 * answer; `vi.spyOn` on the runtime's `evaluate` RECORDS every evaluation (the
 * input's `ctx.orders()` and the outcome) and, in one case, answers the
 * runtime's own `REFUSED / INSTANCE_PAUSED` outcome.
 *
 * Pinned, by the packet's acceptance numbering:
 *
 * 1. R1 — a terminal order is delivered until ONE evaluated delivery, then
 *    retired: the golden-shaped run; an immediate order; a halted instance
 *    (suppressed deliveries do not count; after the halt is released the view
 *    is delivered and evaluated); a PAUSED runtime (a REAL pause through the
 *    watchdog, and the runtime's refusal answer); `ctx.orders()` excludes
 *    retired orders.
 * 2. Settlement needs (a)-(d): a booked-shares mismatch is counted once and
 *    never pruned; a pending cancel blocks it until the cancel resolves.
 * 3. An ownerless fill is posted UNATTRIBUTED, halts its market and is
 *    counted: a fill for a SETTLED order, one for an UNKNOWN order, one whose
 *    tombstone was EVICTED, and the ORPHAN of a plan a venue refused while
 *    still holding part of it (the defensive path, through a scripted answer).
 *    And, since SIM-1 (ruling R3), the REAL venue's partly executed plan is
 *    NOT an orphan: its booked slice is owned and its fills attributed.
 * 4. The time-in-force leak on an allocator refusal is closed.
 * 5. Retention bounds reach the loop through `createPaperTrader`, and evict
 *    oldest-first, counted.
 * 6. SIM-1 (O1-O4): a remainder the venue can no longer work is TERMINAL — a
 *    FAK partial CANCELLED, an unfillable FOK REJECTED, a partly filled GTD
 *    EXPIRED — or REGISTERED to rest and filled later (a GTC protective
 *    reduce). Each time the loop's terminal release fires, the order is
 *    retired after one evaluated terminal delivery and settled (`TERM-K`), and
 *    risk stops counting it as an open order. Only the VENUE's view of the
 *    book is clipped (the book moving between decision and execution), and a
 *    pass-through observer records the open orders risk is handed.
 *
 * The scenario is `test/e2e/support/scenario.ts`'s WP-250 run, restated
 * compactly (as `order-provenance.test.ts` does, because this package's
 * `tsconfig` roots at `src/`). PAPER only: the four repository floors are
 * stated as values below. No network, no credential, no signer, no real order.
 */

import { addDecimal } from "@polymarket-bot/decimal";
import type { EventEnvelope } from "@polymarket-bot/domain";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type ExecutionResult,
  type FeeScheduleSnapshot,
  type MarketBookProvider,
  type RateLimitBudget,
  type SimulatedFill,
  type SimulatedOrder,
} from "@polymarket-bot/simulation";
import type { EvaluationInput, EvaluationOutcome } from "@polymarket-bot/strategy-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Pipeline from "./pipeline.js";

// A PASS-THROUGH OBSERVER on the risk input builder, for the SIM-1 cases: it
// records the open orders every risk evaluation is handed (`#openOrdersFor`)
// and changes nothing it passes on.
const riskInputs = vi.hoisted(() => ({
  event: 0,
  calls: [] as { readonly event: number; readonly intentType: string; readonly openOrderIds: readonly string[] }[],
}));
vi.mock("./pipeline.js", async (importOriginal) => {
  const original = await importOriginal<typeof Pipeline>();
  return {
    ...original,
    buildRiskEvaluationInput(context: Parameters<typeof original.buildRiskEvaluationInput>[0]) {
      riskInputs.calls.push({
        event: riskInputs.event,
        intentType: context.intent.type,
        openOrderIds: context.openOrders.map((open) => open.orderId),
      });
      return original.buildRiskEvaluationInput(context);
    },
  };
});

import { projectionOf } from "./accounting.js";
import { AllocatorGate } from "./allocation.js";
import type { TraderVenue } from "./loop.js";
import { createExecutionPolicy, type VenueWiring } from "./main.js";
import type { RetentionBounds } from "./order-lifecycle.js";
import type { IngestedEvent } from "./ports.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";
import { createPaperTrader, type PaperTrader } from "./trader.js";

const MARKET_ID = "018f5c20-1000-7a10-8b00-000000000001";
const CONDITION_ID = "0xwp250condition";
const YES_TOKEN = "9001";
const NO_TOKEN = "9002";
const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-000000000002";
const RUN_ID = "018f5c20-3000-7a30-8b00-000000000003";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-000000000004";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-000000000005";
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-01T09:15:00.000Z";
const YES_BIDS = [
  { price: "0.32", size: "200" },
  { price: "0.31", size: "300" },
];

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
    snapshotVersion: "wp250.sim.2026-05-01",
    takerFeeRate: "0.0195",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

function traderConfig(
  input: { readonly maxSliceShares?: string; readonly immediateOrderType?: string } = {},
): Record<string, unknown> {
  const fees = feeSnapshot();
  return {
    environment: "PAPER",
    riskPolicy: {
      freshness: {
        venueBookMaxAgeMs: 600_000,
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
      accountRef: "wp250-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "wp250-venue-clearing",
      attributionClearingRef: "wp250-attribution-clearing",
      feeExpenseRef: "wp250-fee-expense",
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
      maxSliceShares: input.maxSliceShares ?? "100",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.wp250",
      fillModelParametersHash: "b".repeat(64),
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
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "trdr-4-order-lifecycle",
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
        // The SIMULATED market this file specifies in full; see
        // `test/e2e/support/scenario.ts`'s header for why this is truthful.
        settlementReadiness: { modelDependentActivationAllowed: true },
        openTime: T_OPEN,
        closeTime: T_CLOSE,
        seriesKey: "wp250-paper-sim",
        underlyingKey: "SIMBTC",
        resolutionWindowKey: "w2026-05-01T09.15",
      },
    ],
    instances: [
      {
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        configId: CONFIG_ID,
        runSeed: "250250",
        marketId: MARKET_ID,
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5_000_000,
        params: {
          strategy: "static-bracket",
          version: 1,
          market_selector: { series_id: "wp250-paper-sim", direction: "YES" },
          entry: {
            trigger_basis: "executable_ask",
            trigger_feature_key: "polymarket.executable_buy_price@50",
            trigger_price_lte: "0.35",
            size_shares: "50",
            maximum_total_cost: "18",
            economic_leg_policy: "DIRECT_ONLY",
            execution: {
              liquidity_preference: "TAKER_OK",
              passive_price: "0.34",
              convert_to_aggressive_after_ms: 0,
              maximum_buy_price: "0.35",
              immediate_order_type: input.immediateOrderType ?? "FAK",
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
            maximum_book_age_ms: 600000,
            incident_feature_key: "quality.active_incidents@any",
            on_stale_book: "PAUSE_AND_CANCEL",
            on_incident: "PAUSE_AND_CANCEL",
          },
        },
      },
    ],
  };
}

interface Recorded {
  readonly eventType: string;
  readonly payload: unknown;
  readonly receivedAt: string;
  readonly source?: "polymarket" | "binance";
}

/**
 * The WP-250 event list (1-based below): entry at event 5, take-profit
 * withdrawn at event 6, protective reduce at event 7, cutoff at event 8.
 */
const RECORDED: readonly Recorded[] = [
  {
    eventType: "ReferenceTradeObserved",
    payload: { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" },
    receivedAt: "2026-05-01T08:59:58.000Z",
    source: "binance",
  },
  {
    eventType: "ReferenceTradeObserved",
    payload: { venue: "binance", symbol: "BTCUSDT", price: "64100", size: "0.25" },
    receivedAt: "2026-05-01T08:59:59.000Z",
    source: "binance",
  },
  {
    eventType: "MarketOpened",
    payload: { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN },
    receivedAt: "2026-05-01T09:00:00.000Z",
  },
  {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      bids: YES_BIDS,
      asks: [
        { price: "0.34", size: "30" },
        { price: "0.35", size: "40" },
      ],
    },
    receivedAt: "2026-05-01T09:00:01.000Z",
  },
  {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "200" }],
      asks: [{ price: "0.66", size: "200" }],
    },
    receivedAt: "2026-05-01T09:00:02.000Z",
  },
  {
    eventType: "BookLevelChanged",
    payload: { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, side: "BID", price: "0.31", size: "250" },
    receivedAt: "2026-05-01T09:00:03.000Z",
  },
  {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      bids: YES_BIDS,
      asks: [{ price: "0.36", size: "40" }],
    },
    receivedAt: "2026-05-01T09:14:49.000Z",
  },
  {
    eventType: "MarketClosing",
    payload: { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, closesAt: T_CLOSE },
    receivedAt: "2026-05-01T09:14:50.000Z",
  },
];

function ingested(recorded: Recorded, ordinal: number): IngestedEvent {
  const envelope: EventEnvelope<unknown> = {
    eventId: `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`,
    eventType: recorded.eventType,
    schemaVersion: 1,
    source: recorded.source ?? "polymarket",
    sourceChannel: "market",
    receivedAt: recorded.receivedAt,
    receivedMonotonicNs: String(ordinal * 1_000_000),
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ordinal),
    subscriptionGeneration: 1,
    payload: recorded.payload,
  };
  return {
    envelope,
    identity: {
      gatewayEpoch: GATEWAY_EPOCH,
      ingestSeq: String(ordinal),
      receivedAt: recorded.receivedAt,
      datasetRowOrdinal: ordinal,
    },
  };
}

/** A `BookLevelChanged` that changes nothing economic, at a chosen instant. */
function quietEvent(ordinal: number, receivedAt: string): IngestedEvent {
  return ingested(
    {
      eventType: "BookLevelChanged",
      payload: { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, side: "BID", price: "0.31", size: "250" },
      receivedAt,
    },
    ordinal,
  );
}

/**
 * A `TraderVenue` around the REAL `SimulatedVenue`, with three test hooks.
 *
 * - `inject(fill)` appends a fill to the stream the loop harvests. The stream
 *   is kept APPEND-ONLY in arrival order (the loop's cursor indexes into it),
 *   merging the inner venue's new fills as they appear.
 * - `misreport(orderId, filledShares)` makes the order VIEW report a filled
 *   size the booked fills do not back (a settlement-mismatch state).
 * - `afterSubmit(plan, result)` runs after every real submission; returning
 *   `"LOSE_ANSWER"` throws instead of answering, AFTER the venue processed the
 *   plan — the §6 invariant 6 lost-response case.
 * - `rewriteAnswer(result)` replaces the venue's answer (the venue's STATE is
 *   untouched): how a test states a venue that refuses a plan while still
 *   holding part of it.
 */
class WrappedVenue implements TraderVenue {
  readonly inner: SimulatedVenue;
  readonly #merged: SimulatedFill[] = [];
  #innerSeen = 0;
  readonly #misreported = new Map<string, string>();
  afterSubmit: ((plan: unknown, result: ExecutionResult) => "LOSE_ANSWER" | undefined) | undefined;
  rewriteAnswer: ((result: ExecutionResult) => ExecutionResult) | undefined;

  constructor(inner: SimulatedVenue) {
    this.inner = inner;
  }

  observe(identity: Parameters<TraderVenue["observe"]>[0]): { readonly ok: boolean } {
    return this.inner.observe(identity);
  }

  observeTrade(
    input: Parameters<TraderVenue["observeTrade"]>[0],
  ): ReturnType<TraderVenue["observeTrade"]> {
    return this.inner.observeTrade(input);
  }

  async submit(plan: unknown): Promise<ExecutionResult> {
    const result = await this.inner.submit(plan as Parameters<SimulatedVenue["submit"]>[0]);
    if (this.afterSubmit?.(plan, result) === "LOSE_ANSWER") {
      throw new Error("the venue processed the plan but its answer was lost (test double)");
    }
    return this.rewriteAnswer?.(result) ?? result;
  }

  ordersSnapshot(): readonly SimulatedOrder[] {
    return this.inner
      .ordersSnapshot()
      .map((order) => {
        const filledShares = this.#misreported.get(order.simulatedOrderId);
        return filledShares === undefined ? order : { ...order, filledShares };
      });
  }

  get fills(): readonly SimulatedFill[] {
    const inner = this.inner.fills;
    for (let index = this.#innerSeen; index < inner.length; index += 1) {
      const fill = inner[index];
      if (fill !== undefined) this.#merged.push(fill);
    }
    this.#innerSeen = inner.length;
    return Object.freeze([...this.#merged]);
  }

  inject(fill: SimulatedFill): void {
    void this.fills;
    this.#merged.push(fill);
  }

  misreport(orderId: string, filledShares: string): void {
    this.#misreported.set(orderId, filledShares);
  }
}

interface Evaluation {
  readonly callback: EvaluationInput["callback"];
  /** `onOrderUpdate` only: the delivered view's order id and status. */
  readonly orderId: string | undefined;
  readonly orderStatus: string | undefined;
  /** `ctx.orders()` as the loop built it for this evaluation. */
  readonly ctxOrderIds: readonly string[];
  readonly outcome: EvaluationOutcome["kind"];
  readonly reasonCodes: readonly string[];
  /** 1-based index of the event being processed when it ran. */
  readonly event: number;
}

interface Assembled {
  readonly trader: PaperTrader;
  readonly venue: WrappedVenue;
  readonly clock: ManualClock;
  readonly store: MemoryTraderStore;
  readonly evaluations: Evaluation[];
  /** Replaces the runtime's answer for one evaluation; `undefined` passes through. */
  override: ((input: EvaluationInput) => EvaluationOutcome | undefined) | undefined;
  event: number;
}

function assemble(
  input: {
    readonly retention?: RetentionBounds;
    readonly rateLimits?: RateLimitBudget;
    readonly maxSliceShares?: string;
    /** Wraps the venue's book provider (a book that vanishes mid-plan). */
    readonly books?: (base: MarketBookProvider) => MarketBookProvider;
    /** The entry's `immediate_order_type` (FAK by default). */
    readonly immediateOrderType?: string;
    /** A stated GTD expiry the venue's policy answers (the trader's own states none). */
    readonly statedExpiryNs?: bigint;
  } = {},
): Assembled {
  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error(`the scenario's fee snapshot was refused: ${fees.refusal.code}`);
  const wiring: VenueWiring = { trader: undefined };
  const clock = new ManualClock(T_OPEN);
  const inner = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.wp250", fillModelParametersHash: "b".repeat(64) }),
    feeSnapshot: fees.value,
    rateLimits:
      input.rateLimits ?? unmodeledRateLimits("no venue rate-limit budget is modelled in this unit test"),
    policy: {
      ...createExecutionPolicy(wiring, () => undefined),
      ...(input.statedExpiryNs === undefined ? {} : { statedExpiryNsFor: () => input.statedExpiryNs }),
    },
    startingCash: "1000",
    books: (input.books ?? ((base: MarketBookProvider) => base))({
      book(request): BookView | undefined {
        const market = wiring.trader?.markets.get(request.marketId);
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
            return market
              .bookFor(request.side)
              .levels(side)
              .map((level) => ({ price: level.price, size: level.size }));
          },
        };
      },
    }),
  });
  const venue = new WrappedVenue(inner);
  const store = new MemoryTraderStore();
  const result = createPaperTrader({
    env: paperEnvironment(),
    config: traderConfig({
      ...(input.maxSliceShares === undefined ? {} : { maxSliceShares: input.maxSliceShares }),
      ...(input.immediateOrderType === undefined ? {} : { immediateOrderType: input.immediateOrderType }),
    }),
    clock,
    venue,
    store,
    idNamespace: "trdr-4-order-lifecycle",
    ...(input.retention === undefined ? {} : { retention: input.retention }),
  });
  if (!result.ok) {
    throw new Error(`${result.refusal.code}: ${result.refusal.detail}`);
  }
  wiring.trader = result.trader;

  const assembled: Assembled = {
    trader: result.trader,
    venue,
    clock,
    store,
    evaluations: [],
    override: undefined,
    event: 0,
  };
  const runtime = result.trader.registry.get(INSTANCE_ID)?.runtime;
  if (runtime === undefined) throw new Error("the instance is not registered");
  const original = runtime.evaluate.bind(runtime);
  vi.spyOn(runtime, "evaluate").mockImplementation((evaluation: EvaluationInput) => {
    const outcome = assembled.override?.(evaluation) ?? original(evaluation);
    assembled.evaluations.push({
      callback: evaluation.callback,
      orderId: evaluation.callback === "onOrderUpdate" ? evaluation.order.orderId : undefined,
      orderStatus: evaluation.callback === "onOrderUpdate" ? evaluation.order.status : undefined,
      ctxOrderIds: evaluation.orders.map((order) => order.orderId),
      outcome: outcome.kind,
      reasonCodes:
        outcome.kind === "DECIDED" || outcome.kind === "CONTAINED"
          ? [...outcome.record.decision.reasonCodes]
          : [],
      event: assembled.event,
    });
    return outcome;
  });
  return assembled;
}

/** Ingests events `from`..`to` (1-based, inclusive), draining after each. */
async function drive(parts: Assembled, from: number, to: number): Promise<void> {
  for (let ordinal = from; ordinal <= to; ordinal += 1) {
    const recorded = RECORDED[ordinal - 1];
    if (recorded === undefined) throw new Error(`no recorded event ${String(ordinal)}`);
    await driveOne(parts, ingested(recorded, ordinal), ordinal);
  }
}

async function driveOne(parts: Assembled, event: IngestedEvent, ordinal: number): Promise<void> {
  parts.event = ordinal;
  riskInputs.event = ordinal;
  if (!parts.trader.loop.ingest(event)) {
    throw new Error(`the ingest queue refused event ${String(ordinal)}`);
  }
  await parts.trader.loop.drain();
}

/** The venue's orders by role, in submission (= id) order: entry, take-profit, reduce. */
function ordersByRole(parts: Assembled): {
  readonly entry: SimulatedOrder;
  readonly takeProfit: SimulatedOrder | undefined;
  readonly reduce: SimulatedOrder | undefined;
} {
  const orders = parts.venue.inner.ordersSnapshot();
  const entry = orders.find((order) => order.action === "BUY");
  if (entry === undefined) throw new Error("no entry order was placed");
  return {
    entry,
    takeProfit: orders.find((order) => order.action === "SELL" && order.limitPrice === "0.5"),
    reduce: orders.find((order) => order.action === "SELL" && order.limitPrice !== "0.5"),
  };
}

function deliveriesOf(parts: Assembled, orderId: string): readonly Evaluation[] {
  return parts.evaluations.filter(
    (evaluation) => evaluation.callback === "onOrderUpdate" && evaluation.orderId === orderId,
  );
}

/**
 * Asserts the R1 retirement rule for one order: every evaluation AFTER the one
 * that retired it (its first DECIDED terminal delivery) neither delivers it
 * nor carries it in `ctx.orders()`; and nothing before that point skipped it.
 */
function expectRetiredAfterFirstEvaluatedTerminalDelivery(parts: Assembled, orderId: string): void {
  const index = parts.evaluations.findIndex(
    (evaluation) =>
      evaluation.callback === "onOrderUpdate" &&
      evaluation.orderId === orderId &&
      ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(evaluation.orderStatus ?? "") &&
      evaluation.outcome === "DECIDED",
  );
  expect(index, `order ${orderId} was never delivered terminal and evaluated`).toBeGreaterThanOrEqual(0);
  // The retiring evaluation itself still SAW the order in ctx.orders().
  expect(parts.evaluations[index]?.ctxOrderIds).toContain(orderId);
  for (const later of parts.evaluations.slice(index + 1)) {
    expect(later.orderId === orderId, "a retired order was delivered again").toBe(false);
    expect(later.ctxOrderIds, "a retired order is still in ctx.orders()").not.toContain(orderId);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  riskInputs.calls.length = 0;
  riskInputs.event = 0;
});

describe("R1 — a terminal order is delivered until ONE evaluated delivery, then retired", () => {
  it("the WP-250 run: one terminal delivery per order, then out of ctx.orders(), settled, pruned", async () => {
    const parts = assemble();
    await drive(parts, 1, 8);
    const { entry, takeProfit, reduce } = ordersByRole(parts);
    if (takeProfit === undefined || reduce === undefined) throw new Error("the run lost an order");

    // The entry filled on submission: ONE delivery, its terminal view.
    expect(deliveriesOf(parts, entry.simulatedOrderId).map((d) => d.orderStatus)).toEqual(["FILLED"]);
    // The take-profit is re-delivered while WORKING and once more when CANCELED.
    expect(deliveriesOf(parts, takeProfit.simulatedOrderId).map((d) => d.orderStatus)).toEqual([
      "OPEN",
      "CANCELED",
    ]);
    // The reduce filled on submission: ONE delivery.
    expect(deliveriesOf(parts, reduce.simulatedOrderId).map((d) => d.orderStatus)).toEqual(["FILLED"]);
    for (const order of [entry, takeProfit, reduce]) {
      expectRetiredAfterFirstEvaluatedTerminalDelivery(parts, order.simulatedOrderId);
    }

    // Every order is terminal, retired and SETTLED: the per-order maps are
    // empty, three tombstones remain, and nothing arrived unowned.
    const loop = parts.trader.loop;
    expect(loop.retainedOrderState()).toEqual({
      owners: 0,
      instanceOrderSets: 0,
      instanceOrderIds: 0,
      traceLookup: 0,
      bookedShares: 0,
      retiredUnsettled: 0,
      orderViews: 0,
      tombstones: 3,
    });
    const health = loop.health();
    expect(health.seams.orders).toEqual({
      tracked: 0,
      settled: 3,
      tombstones: 3,
      maximumTombstones: 100_000,
      tombstoneEvictions: 0,
      unownedFills: 0,
      lateFillsAfterSettlement: 0,
      settleMismatches: 0,
    });
    // Four views emitted (entry, take-profit twice, reduce), no repeat of a
    // terminal view anywhere; the tracker forgot every settled order.
    expect(health.seams.orderViews).toEqual({ emitted: 4, repeats: 0, tracked: 0 });
    // 12 persisted decisions, one per callback; the six terminal REPEATS the
    // pre-R1 loop evaluated are gone. Settling pruned nothing the audit logs
    // hold: every provenance record and every trace is still returned.
    expect(loop.decisions()).toHaveLength(12);
    expect(parts.store.decisions).toHaveLength(12);
    expect(loop.orderProvenance().map((record) => record.venueOrderId)).toEqual([
      entry.simulatedOrderId,
      takeProfit.simulatedOrderId,
      reduce.simulatedOrderId,
    ]);
    expect(loop.traces()).toHaveLength(3);
    expect(health.seams.retention).toEqual({
      decisions: { retained: 12, maximumRetained: 100_000, evicted: 0 },
      traces: { retained: 3, maximumRetained: 50_000, evicted: 0 },
      provenance: { retained: 3, maximumRetained: 50_000, evicted: 0 },
    });
  });

  it("an IMMEDIATE order, terminal before any tick, is still seen — through its first evaluated delivery", async () => {
    const parts = assemble();
    await drive(parts, 1, 5);
    const { entry } = ordersByRole(parts);
    expect(entry.state).toBe("FILLED");

    // The onFill evaluations of the entry's harvest ran while the order was
    // terminal and not yet retired, so ctx.orders() still carried it…
    const fills = parts.evaluations.filter((evaluation) => evaluation.callback === "onFill");
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) expect(fill.ctxOrderIds).toContain(entry.simulatedOrderId);
    // …and its FIRST onOrderUpdate is the terminal view, evaluated, with the
    // strategy recording the entry order's terminal transition.
    const [first] = deliveriesOf(parts, entry.simulatedOrderId);
    expect(first?.orderStatus).toBe("FILLED");
    expect(first?.outcome).toBe("DECIDED");
    expect(first?.ctxOrderIds).toContain(entry.simulatedOrderId);
    expect(first?.reasonCodes).toContain("SB.ENTRY_ORDER_TERMINAL");

    // The very next evaluation — a later event's tick — no longer sees it.
    await drive(parts, 6, 6);
    const next = parts.evaluations.find((evaluation) => evaluation.event === 6);
    expect(next?.callback).toBe("onFeatures");
    expect(next?.ctxOrderIds).not.toContain(entry.simulatedOrderId);
    expectRetiredAfterFirstEvaluatedTerminalDelivery(parts, entry.simulatedOrderId);
  });

  it("a HALTED instance: suppressed deliveries do not count; after release the view is delivered, evaluated, then retired", async () => {
    const parts = assemble();
    const scope = { kind: "STRATEGY_INSTANCE" as const, instanceId: INSTANCE_ID };
    // Latch the halt the moment the entry has been submitted: the entry fills
    // on submission and its harvest (the same event) meets a halted instance.
    parts.venue.afterSubmit = () => {
      parts.trader.halts.halt(scope, "RUNTIME_PERSISTENCE_FAILED", "TRDR-4 test: halted after submit", T_OPEN);
      parts.venue.afterSubmit = undefined;
      return undefined;
    };
    await drive(parts, 1, 6);
    const { entry } = ordersByRole(parts);
    const loop = parts.trader.loop;

    // The accounting happened (the fills are booked) but the deliveries were
    // suppressed on events 5 and 6 — so the terminal entry is NOT retired and
    // NOT settled, and the strategy never saw it.
    expect(deliveriesOf(parts, entry.simulatedOrderId)).toEqual([]);
    expect(loop.health().loop.deliveriesSuppressedByHalt).toBeGreaterThanOrEqual(2);
    expect(loop.retainedOrderState()).toMatchObject({ owners: 1, retiredUnsettled: 0, tombstones: 0 });
    expect(loop.health().seams.orders.settled).toBe(0);

    // Release the halt against evidence, then process the next event.
    expect(
      parts.trader.halts.release(scope, {
        authoritativeSnapshotApplied: true,
        reason: "TRDR-4 test: the instance's state was re-established",
      }),
    ).toBe(true);
    await drive(parts, 7, 7);
    const delivered = deliveriesOf(parts, entry.simulatedOrderId);
    expect(delivered.map((d) => [d.orderStatus, d.outcome, d.event])).toEqual([["FILLED", "DECIDED", 7]]);
    // The retiring evaluation still carried the order in ctx.orders()…
    expect(delivered[0]?.ctxOrderIds).toContain(entry.simulatedOrderId);
    // …and from then on it is retired and settled.
    expect(loop.health().seams.orders.settled).toBeGreaterThanOrEqual(1);
    await drive(parts, 8, 8);
    expectRetiredAfterFirstEvaluatedTerminalDelivery(parts, entry.simulatedOrderId);
    expect(deliveriesOf(parts, entry.simulatedOrderId)).toHaveLength(1);
  });

  it("a PAUSED runtime (a REAL pause, through the watchdog): every refused offer leaves the order deliverable, never retired", async () => {
    const parts = assemble();
    // The moment the entry is submitted, make the runtime's monotonic clock
    // jump 10 s per read: the next evaluation (the entry's first onFill)
    // overruns its 5 s budget, the runtime CONTAINS it and PAUSES the
    // instance — permanently, as the runtime documents ("resumption is a new
    // run").
    parts.venue.afterSubmit = () => {
      parts.venue.afterSubmit = undefined;
      let now = 1_000_000_000_000n;
      // Left in place to the end of the test (`afterEach` restores it): once
      // the instance is PAUSED the runtime refuses before reading any clock.
      vi.spyOn(parts.clock, "monotonicNs").mockImplementation(() => {
        now += 10_000_000_000n;
        return now;
      });
      return undefined;
    };
    await drive(parts, 1, 8);
    const { entry } = ordersByRole(parts);
    const loop = parts.trader.loop;
    expect(parts.trader.registry.get(INSTANCE_ID)?.runtime.instanceStatus()).toBe("PAUSED");
    expect(loop.health().loop.containedEvaluations).toBe(1);

    // The entry's terminal view was OFFERED on every harvest from event 5 to
    // event 8, and every offer was REFUSED by the paused runtime — so none
    // counted, and the order is still tracked and not retired.
    const offers = deliveriesOf(parts, entry.simulatedOrderId);
    expect(offers.map((offer) => [offer.event, offer.orderStatus, offer.outcome])).toEqual([
      [5, "FILLED", "REFUSED"],
      [6, "FILLED", "REFUSED"],
      [7, "FILLED", "REFUSED"],
      [8, "FILLED", "REFUSED"],
    ]);
    expect(loop.retainedOrderState()).toMatchObject({ owners: 1, retiredUnsettled: 0, tombstones: 0 });
    expect(loop.health().seams.orders).toMatchObject({ tracked: 1, settled: 0 });
  });

  it("a PAUSED refusal does not count: the runtime's REFUSED answer leaves the view deliverable, and the next evaluated delivery retires it", async () => {
    const parts = assemble();
    // For event 5 only, answer every onOrderUpdate with the runtime's own
    // paused refusal — the outcome `evaluate()` returns for a PAUSED instance
    // without invoking the callback (a real pause cannot be lifted within a
    // run, so the lifted case needs the runtime's answer, not its state).
    parts.override = (input) =>
      input.callback === "onOrderUpdate" && parts.event === 5
        ? {
            kind: "REFUSED",
            refusal: { code: "INSTANCE_PAUSED", detail: "TRDR-4 test: the runtime's paused answer" },
          }
        : undefined;
    await drive(parts, 1, 5);
    const { entry } = ordersByRole(parts);
    expect(deliveriesOf(parts, entry.simulatedOrderId).map((d) => d.outcome)).toEqual(["REFUSED"]);
    expect(parts.trader.loop.retainedOrderState()).toMatchObject({ owners: 2, retiredUnsettled: 0 });

    await drive(parts, 6, 8);
    const delivered = deliveriesOf(parts, entry.simulatedOrderId);
    expect(delivered.map((d) => [d.event, d.outcome])).toEqual([
      [5, "REFUSED"],
      [6, "DECIDED"],
    ]);
    expectRetiredAfterFirstEvaluatedTerminalDelivery(parts, entry.simulatedOrderId);
    expect(parts.trader.loop.health().seams.orders.settled).toBe(3);
  });
});

describe("settlement needs (a)-(d)", () => {
  it("(b) a booked-shares MISMATCH is counted once and the order is never pruned", async () => {
    const parts = assemble();
    await drive(parts, 1, 4);
    // From the entry's submission on, the venue VIEW of the entry claims 60
    // filled; the booked fills are 30 + 20 = 50.
    parts.venue.afterSubmit = (_plan, result) => {
      for (const order of result.orders) if (order.action === "BUY") parts.venue.misreport(order.simulatedOrderId, "60");
      parts.venue.afterSubmit = undefined;
      return undefined;
    };
    await drive(parts, 5, 8);
    const { entry } = ordersByRole(parts);
    // Retired (delivered terminal and evaluated) but NOT settled: the mismatch
    // is counted ONCE although every later harvest re-checked it.
    expect(deliveriesOf(parts, entry.simulatedOrderId)).toHaveLength(1);
    const health = parts.trader.loop.health();
    expect(health.seams.orders.settleMismatches).toBe(1);
    expect(health.seams.orders.settled).toBe(2);
    expect(health.seams.orders.tracked).toBe(1);
    expect(parts.trader.loop.retainedOrderState()).toMatchObject({
      owners: 1,
      traceLookup: 1,
      bookedShares: 1,
      retiredUnsettled: 1,
      tombstones: 2,
    });

    // …and "never pruned" is behaviour, not only a count: a fill that still
    // arrives for it finds its OWNER, is attributed to the instance and traced,
    // and raises no UNATTRIBUTED halt.
    const yesBefore = virtualYes(parts.trader.loop);
    parts.venue.inject(lateFill(parts, entry.simulatedOrderId, "trdr4-mismatch-fill-1"));
    await driveOne(parts, quietEvent(9, "2026-05-01T09:14:51.000Z"), 9);
    const after = parts.trader.loop.health();
    expect(after.seams.orders.unownedFills).toBe(0);
    expect(after.halts.map((halt) => halt.code)).not.toContain("UNATTRIBUTED_ACTIVITY");
    expect(virtualYes(parts.trader.loop)).toBe(addDecimal(yesBefore, "5"));
    expect(parts.trader.loop.traces().some((trace) => trace.venueFillId === "trdr4-mismatch-fill-1")).toBe(true);
  });

  it("(d) a PENDING cancel naming a retired order blocks its settlement until the cancel resolves", async () => {
    const parts = assemble();
    await drive(parts, 1, 5);
    // Event 6 withdraws the take-profit. The venue CANCELS it, and the answer
    // is lost: the cancel stays pending in the CancelLedger (§6 invariant 6),
    // and the rest of event 6 never runs.
    parts.venue.afterSubmit = (plan) => {
      if ((plan as { planKind?: string }).planKind !== "CANCEL") return undefined;
      parts.venue.afterSubmit = undefined;
      return "LOSE_ANSWER";
    };
    parts.event = 6;
    const recorded = RECORDED[5];
    if (recorded === undefined) throw new Error("no event 6");
    expect(parts.trader.loop.ingest(ingested(recorded, 6))).toBe(true);
    await expect(parts.trader.loop.drain()).rejects.toThrow(/answer was lost/u);
    const { takeProfit } = ordersByRole(parts);
    if (takeProfit === undefined) throw new Error("no take-profit");
    expect(takeProfit.state).toBe("CANCELLED");
    expect(parts.trader.loop.health().seams.cancels.pending).toBe(1);

    // One second later (inside the 5 s silence bound): the CANCELED view is
    // delivered and evaluated — retired — but the pending cancel names it, so
    // it is NOT settled.
    await driveOne(parts, quietEvent(9, "2026-05-01T09:00:04.000Z"), 9);
    expect(deliveriesOf(parts, takeProfit.simulatedOrderId).at(-1)).toMatchObject({
      orderStatus: "CANCELED",
      outcome: "DECIDED",
    });
    expect(parts.trader.loop.retainedOrderState()).toMatchObject({ owners: 1, retiredUnsettled: 1 });
    expect(parts.trader.loop.health().seams.orders.settled).toBe(1);

    // Past the bound the cancel resolves SILENCE_EXCEEDED (and halts the
    // market for reconciliation). Nothing names the order any more: settled.
    await driveOne(parts, quietEvent(10, "2026-05-01T09:00:10.000Z"), 10);
    const health = parts.trader.loop.health();
    expect(health.seams.cancels).toMatchObject({ pending: 0, silenceExceeded: 1 });
    expect(health.halts.map((halt) => halt.code)).toContain("CANCEL_UNRESOLVED");
    expect(health.seams.orders.settled).toBe(2);
    expect(parts.trader.loop.retainedOrderState()).toMatchObject({ owners: 0, retiredUnsettled: 0 });
    expect(deliveriesOf(parts, takeProfit.simulatedOrderId).filter((d) => d.orderStatus === "CANCELED")).toHaveLength(1);

    // Settled is behaviour, not only a count: a fill that now arrives for the
    // take-profit finds no owner and is posted UNATTRIBUTED (late after
    // settlement); before settlement it would have been the instance's.
    const unattributedBefore = health.accounting.unattributedActivity;
    parts.venue.inject({
      ...lateFill(parts, takeProfit.simulatedOrderId, "trdr4-after-settlement-1"),
      action: "SELL",
      price: "0.5",
    });
    await driveOne(parts, quietEvent(11, "2026-05-01T09:00:11.000Z"), 11);
    const late = parts.trader.loop.health();
    expect(late.accounting.unattributedActivity).toBeGreaterThan(unattributedBefore);
    expect(late.seams.orders).toMatchObject({ unownedFills: 1, lateFillsAfterSettlement: 1 });
  });
});

/** A fill for `orderId`, shaped like the venue's real entry fill. */
function lateFill(parts: Assembled, orderId: string, fillId: string): SimulatedFill {
  const template = parts.venue.inner.fills[0];
  if (template === undefined) throw new Error("no fill to shape the injected one after");
  return { ...template, simulatedFillId: fillId, simulatedOrderId: orderId, shares: "5", feeAmount: "0" };
}

describe("an ownerless fill is never skipped — UNATTRIBUTED, halted, counted (§6 invariant 7)", () => {
  it("a fill for a SETTLED order: posted UNATTRIBUTED, the market halts naming the PROBABLE owner, never attributed", async () => {
    const parts = assemble();
    await drive(parts, 1, 5);
    const { entry } = ordersByRole(parts);
    const loop = parts.trader.loop;
    expect(loop.health().seams.orders.settled).toBe(1);
    const yesBefore = virtualYes(loop);
    const transactionsBefore = parts.store.transactions.length;

    parts.venue.inject(lateFill(parts, entry.simulatedOrderId, "trdr4-late-fill-1"));
    await drive(parts, 6, 6);

    const health = loop.health();
    expect(health.seams.orders).toMatchObject({ unownedFills: 1, lateFillsAfterSettlement: 1 });
    expect(health.accounting.unattributedActivity).toBeGreaterThan(0);
    const halt = health.halts.find((record) => record.code === "UNATTRIBUTED_ACTIVITY");
    expect(halt?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halt?.action).toBe("RECONCILE_ACCOUNT");
    expect(halt?.detail).toContain(`instance ${INSTANCE_ID} as the PROBABLE owner`);
    expect(halt?.detail).toContain("NOT attributed");
    // The ledger holds an ACTUAL_ARRIVAL that requires the halt, and the store
    // received the postings.
    const arrivals = projectionOf(loop.ledger()).unattributedActivity.filter(
      (record) => record.activityKind === "ACTUAL_ARRIVAL",
    );
    expect(arrivals.length).toBeGreaterThan(0);
    expect(arrivals.every((record) => record.haltRequired)).toBe(true);
    expect(parts.store.transactions.length).toBeGreaterThan(transactionsBefore);
    // NOT attributed: the instance's virtual position did not move, no onFill
    // named the late fill, and no trace was written for it.
    expect(virtualYes(loop)).toBe(yesBefore);
    expect(loop.traces().some((trace) => trace.venueFillId === "trdr4-late-fill-1")).toBe(false);
    expect(
      parts.evaluations.filter((evaluation) => evaluation.callback === "onFill" && evaluation.event === 6),
    ).toEqual([]);
  });

  it("a fill for an UNKNOWN order: posted UNATTRIBUTED, halted, counted — not late", async () => {
    const parts = assemble();
    await drive(parts, 1, 5);
    parts.venue.inject(lateFill(parts, "never-placed-by-this-process:g0:o0", "trdr4-unknown-fill-1"));
    await drive(parts, 6, 6);
    const health = parts.trader.loop.health();
    expect(health.seams.orders).toMatchObject({ unownedFills: 1, lateFillsAfterSettlement: 0 });
    const halt = health.halts.find((record) => record.code === "UNATTRIBUTED_ACTIVITY");
    expect(halt?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halt?.detail).toContain("which this process does not own");
    expect(health.execution.fillsObserved).toBe(3);
  });

  it("a fill for an order whose tombstone was EVICTED: still UNATTRIBUTED and halted, counted as unknown", async () => {
    const parts = assemble({ retention: { tombstones: 1 } });
    await drive(parts, 1, 8);
    const { entry } = ordersByRole(parts);
    expect(parts.trader.loop.health().seams.orders).toMatchObject({
      settled: 3,
      tombstones: 1,
      maximumTombstones: 1,
      tombstoneEvictions: 2,
    });
    parts.venue.inject(lateFill(parts, entry.simulatedOrderId, "trdr4-evicted-fill-1"));
    await driveOne(parts, quietEvent(9, "2026-05-01T09:14:51.000Z"), 9);
    const health = parts.trader.loop.health();
    expect(health.seams.orders).toMatchObject({ unownedFills: 1, lateFillsAfterSettlement: 0 });
    expect(health.halts.map((halt) => halt.code)).toContain("UNATTRIBUTED_ACTIVITY");
  });

  it("the ORPHAN of a plan a venue refused while still HOLDING part of it is booked UNATTRIBUTED and halts (the defensive path)", async () => {
    // A 50-share entry sliced into 30 + 20 (`planning.maxSliceShares`); the
    // venue's book is MISSING for the second slice, so the REAL venue books the
    // first slice (FILLED 30/30) and refuses the second (NO_BOOK). The
    // SCRIPTED ANSWER then drops what was booked — a venue that answers
    // "refused" while holding part of the plan, which the real simulator no
    // longer does (SIM-1, R3) but a live adapter's incomplete answer can. The
    // loop owns nothing it was not told it booked, so the executed slice's
    // fills reach the next harvest ownerless. Before TRDR-4 they were skipped
    // with no posting, counter or halt.
    //
    // TRDR-4 round 1 (TRDR4-R1): the refusal itself halts the market, naming
    // the slice the venue holds, and releases ONLY the slice the venue never
    // booked; the held slice's entries are released by the harvest that sees
    // it terminal (here the same iteration's, after its fills are booked).
    // `loop-refused-plan.test.ts` pins the RESTING variant.
    const parts = assemble({ maxSliceShares: "30", books: bookMissingOnCall(2) });
    parts.venue.rewriteAnswer = (result) =>
      result.outcome === "PARTIAL"
        ? { ...result, outcome: "REFUSED", orders: [], fills: [], bands: [] }
        : result;
    await drive(parts, 1, 5);
    const loop = parts.trader.loop;
    const orphaned = parts.venue.inner.ordersSnapshot();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.state).toBe("FILLED");
    const health = loop.health();
    expect(health.execution.submissionsRefused).toBe(1);
    expect(health.seams.orders.tracked).toBe(0);
    // Every fill the venue produced was observed, and every one was POSTED.
    expect(health.execution.fillsObserved).toBe(parts.venue.inner.fills.length);
    expect(health.seams.orders.unownedFills).toBe(parts.venue.inner.fills.length);
    expect(health.seams.orders.lateFillsAfterSettlement).toBe(0);
    expect(health.accounting.ledgerTransactions).toBeGreaterThan(0);
    const halt = health.halts.find((record) => record.code === "UNATTRIBUTED_ACTIVITY");
    expect(halt?.scope).toEqual({ kind: "MARKET", marketId: MARKET_ID });
    expect(halt?.detail).toContain("partly executed and then refused");
    const held = orphaned[0];
    if (held === undefined) throw new Error("the venue holds no order");
    expect(halt?.detail).toContain("1 of its 2 planned orders");
    expect(halt?.detail).toContain(`${held.simulatedOrderId} (planned ${held.plannedOrderId}) FILLED 30/30`);
    // Only the slice the venue never booked was released AT the refusal; the
    // held (FILLED) slice's entries came back at the terminal harvest.
    expect(health.execution.reservationsReleasedOnRefusal).toBe(1);
    expect(health.seams.reservations).toMatchObject({ open: 0, taken: 2, released: 2, reservedCollateral: "0" });
    expect(health.seams.allocator).toMatchObject({ open: 0, applied: 2, released: 2, reservedCollateral: "0" });
    expect(loop.timeInForceFor(held.plannedOrderId)).toBeUndefined();
    // The account side follows the venue: the ledger holds the shares, all of
    // them UNATTRIBUTED; no instance holds any.
    expect(virtualYes(loop)).toBe("0");
  });

  it("SIM-1 R3: the REAL venue's partly executed plan is NOT an orphan — the booked slice is owned, its fills ATTRIBUTED, and nothing halts", async () => {
    // The same state at the venue as the case above — slice 1 FILLED 30/30,
    // slice 2 refused NO_BOOK — with the venue's REAL answer: PARTIAL, slice 1
    // listed as booked, slice 2 in `notPlaced`.
    const parts = assemble({ maxSliceShares: "30", books: bookMissingOnCall(2) });
    const answers: ExecutionResult[] = [];
    parts.venue.afterSubmit = (_plan, result) => {
      answers.push(result);
      return undefined;
    };
    await drive(parts, 1, 5);
    const loop = parts.trader.loop;
    const entry = answers[0];
    if (entry === undefined) throw new Error("the entry was never submitted");
    expect(entry).toMatchObject({ accepted: false, outcome: "PARTIAL", refusalCode: "SIMULATED_VENUE_NO_BOOK" });
    expect(entry.orders.map((order) => `${order.state} ${order.filledShares}/${order.requestedShares}`)).toEqual([
      "FILLED 30/30",
    ]);
    expect(entry.notPlaced.map((notPlaced) => notPlaced.refusalCode)).toEqual(["SIMULATED_VENUE_NO_BOOK"]);
    const booked = entry.orders[0];
    if (booked === undefined) throw new Error("nothing was booked");

    const health = loop.health();
    expect(health.execution.submissionsRefused).toBe(1);
    // Every fill is ATTRIBUTED to the instance: none is ownerless, and each
    // has its full §6 invariant 4 chain.
    expect(health.execution.fillsObserved).toBe(parts.venue.inner.fills.length);
    expect(health.seams.orders).toMatchObject({ unownedFills: 0, lateFillsAfterSettlement: 0 });
    expect(health.accounting.unattributedActivity).toBe(0);
    const traced = loop.traces().filter((trace) => trace.venueOrderId === booked.simulatedOrderId);
    expect(traced.map((trace) => trace.venueFillId)).toEqual(
      parts.venue.inner.fills
        .filter((fill) => fill.simulatedOrderId === booked.simulatedOrderId)
        .map((fill) => fill.simulatedFillId),
    );
    expect(traced.every((trace) => trace.executionPlanId === entry.executionPlanId)).toBe(true);
    expect(loop.orderProvenance().map((record) => record.venueOrderId)).toContain(booked.simulatedOrderId);
    // The instance holds the 30 shares it bought.
    expect(virtualYes(loop)).toBe("30");
    // The strategy saw its order — the fill and the terminal view — and the
    // order was retired and settled (TRDR-4).
    expect(
      parts.evaluations.some(
        (evaluation) => evaluation.callback === "onFill" && evaluation.event === 5,
      ),
    ).toBe(true);
    expect(deliveriesOf(parts, booked.simulatedOrderId).map((delivery) => delivery.orderStatus)).toEqual(["FILLED"]);
    expect(health.seams.orders).toMatchObject({ settled: 1, settleMismatches: 0 });
    // …and RE-PLANNED from what it holds: the take-profit is sized to the 30
    // shares the booked slice bought, not to the 50 the entry asked for, and it
    // is the one order the instance still tracks.
    const takeProfit = parts.venue.inner.ordersSnapshot().find((order) => order.action === "SELL");
    expect(takeProfit).toMatchObject({ state: "RESTING", requestedShares: "30", limitPrice: "0.5" });
    expect(health.seams.orders.tracked).toBe(1);
    expect(loop.retainedOrderState().owners).toBe(1);
    // The refused slice was released at the refusal, the booked one at its
    // terminal harvest; the take-profit's reservation is its own.
    expect(health.execution.reservationsReleasedOnRefusal).toBe(1);
    expect(health.seams.reservations).toMatchObject({ open: 1, taken: 3, released: 2 });
    expect(health.seams.allocator).toMatchObject({ open: 1, applied: 3, released: 2 });
    expect(loop.timeInForceFor(booked.plannedOrderId)).toBeUndefined();
    // A POSITION partial raises no halt.
    expect(health.halts).toEqual([]);
  });
});

/**
 * A book provider that answers NO BOOK on its `call`-th request only — the
 * venue sees no book for one slice of one plan, standing in for a book that
 * vanished between two slices. Only the VENUE's view; the loop's books are
 * untouched, and every later request is answered normally.
 */
function bookMissingOnCall(call: number): (base: MarketBookProvider) => MarketBookProvider {
  return (base) => {
    let answered = 0;
    return {
      book(request) {
        answered += 1;
        return answered === call ? undefined : base.book(request);
      },
    };
  };
}

describe("SIM-1 (O1-O4) — a remainder the venue can no longer work is terminal, so the loop releases, retires and settles it", () => {
  it("O1: a FAK entry that PARTLY fills is CANCELLED 30/50 at once — released, retired after one terminal delivery, settled, never again counted open by risk", async () => {
    // The venue sees only the best YES ask level (30 @ 0.34) when the entry
    // arrives; the loop's own book is untouched.
    const clip: Clip = { apply: (side, ladderSide, levels) => (side === "YES" && ladderSide === "ASK" ? levels.slice(0, 1) : levels) };
    const parts = assemble({ books: clipped(clip) });
    await drive(parts, 1, 5);
    clip.apply = undefined;
    const { entry } = ordersByRole(parts);
    expect(`${entry.state} ${entry.filledShares}/${entry.requestedShares}`).toBe("CANCELLED 30/50");
    const loop = parts.trader.loop;
    expect(loop.timeInForceFor(entry.plannedOrderId)).toBeUndefined();
    // The entry's 50 × 0.35 = 17.5 of collateral came back at the harvest that
    // saw it terminal; what remains open is the take-profit it placed for the
    // 30 shares it holds (a SELL: no collateral).
    expect(loop.health().seams.reservations).toMatchObject({ open: 1, taken: 2, released: 1, reservedCollateral: "0" });
    expect(loop.health().seams.allocator).toMatchObject({ open: 1, applied: 2, released: 1, reservedCollateral: "0" });
    await drive(parts, 6, 8);
    expectTerminalReleasedRetiredSettled(parts, entry.simulatedOrderId, "CANCELED", 5);
    // It is out of every risk evaluation from the event it went terminal at.
    expectNeverCountedOpenAfter(entry.simulatedOrderId, 5);
  });

  it("O2: a FOK entry the venue cannot fill WHOLE is REJECTED 0/50 — nothing filled, released, retired, settled", async () => {
    const clip: Clip = { apply: (side, ladderSide, levels) => (side === "YES" && ladderSide === "ASK" ? levels.slice(0, 1) : levels) };
    const parts = assemble({ books: clipped(clip), immediateOrderType: "FOK" });
    await drive(parts, 1, 5);
    clip.apply = undefined;
    const { entry } = ordersByRole(parts);
    expect(`${entry.state} ${entry.filledShares}/${entry.requestedShares}`).toBe("REJECTED 0/50");
    expect(parts.venue.inner.fills).toEqual([]);
    const loop = parts.trader.loop;
    expect(loop.timeInForceFor(entry.plannedOrderId)).toBeUndefined();
    expect(loop.health().seams.reservations).toMatchObject({ open: 0, reservedCollateral: "0" });
    await drive(parts, 6, 8);
    expectTerminalReleasedRetiredSettled(parts, entry.simulatedOrderId, "REJECTED", 5);
    expectNeverCountedOpenAfter(entry.simulatedOrderId, 5);
  });

  it("O3: a GTC protective reduce that PARTLY fills RESTS its remainder, which a later trade fills — then released, retired, settled", async () => {
    // From the reduce on, the venue sees only 25 shares on the YES bid.
    const clip: Clip = { apply: undefined };
    const parts = assemble({ books: clipped(clip) });
    await drive(parts, 1, 6);
    clip.apply = (side, ladderSide, levels) =>
      side === "YES" && ladderSide === "BID" ? levels.slice(0, 1).map((level) => ({ price: level.price, size: "25" })) : levels;
    await drive(parts, 7, 8);
    clip.apply = undefined;
    const reduce = ordersByRole(parts).reduce;
    if (reduce === undefined) throw new Error("no reduce was placed");
    expect(`${reduce.executionStyle} ${reduce.state} ${reduce.filledShares}/${reduce.requestedShares}`).toBe(
      "MARKETABLE_LIMIT PARTIALLY_FILLED 25/50",
    );
    const loop = parts.trader.loop;
    // Still WORKING: its entries are kept (never released before terminal).
    expect(loop.timeInForceFor(reduce.plannedOrderId)).toBe("GTC");
    expect(loop.health().seams.reservations.open).toBe(1);
    // A public trade THROUGH its 0.3 limit fills the resting 25 as a MAKER.
    await driveOne(
      parts,
      ingested(
        {
          eventType: "PublicTradeObserved",
          payload: { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, price: "0.4", size: "500", takerSide: "BID" },
          receivedAt: "2026-05-01T09:14:52.000Z",
        },
        9,
      ),
      9,
    );
    const filled = parts.venue.inner.ordersSnapshot().find((order) => order.simulatedOrderId === reduce.simulatedOrderId);
    expect(`${String(filled?.state)} ${String(filled?.filledShares)}/50`).toBe("FILLED 50/50");
    expect(
      parts.venue.inner.fills
        .filter((fill) => fill.simulatedOrderId === reduce.simulatedOrderId)
        .map((fill) => `${fill.shares}@${fill.price} ${fill.liquidityRole}`),
    ).toEqual(["25@0.32 TAKER", "25@0.3 MAKER"]);
    await driveOne(parts, quietEvent(10, "2026-05-01T10:00:00.000Z"), 10);
    expectTerminalReleasedRetiredSettled(parts, reduce.simulatedOrderId, "FILLED", 9);
    expect(loop.health().seams.reservations).toMatchObject({ open: 0, reservedCollateral: "0" });
    // Nothing is owned any more, so there is nothing risk could count open:
    // `#openOrdersFor` reads only the instance's own tracked orders. (The
    // strategy pauses on its own reduce — RISK-2 residual 5 — so no later
    // intent reaches risk in this run to observe it directly.)
    expect(loop.retainedOrderState().owners).toBe(0);
    expect(riskInputs.calls.filter((call) => call.event >= 9)).toEqual([]);
  });

  it("O4: a GTD entry that PARTLY fills EXPIRES 30/50 at its expiry — on the next recorded event, with no trade — then released, retired, settled", async () => {
    // Stated expiry 120 s of recorded time after the clock's zero; GTD expires
    // 60 s early (ADR-012 §5.2), so it is effective at 60 s.
    const clip: Clip = { apply: (side, ladderSide, levels) => (side === "YES" && ladderSide === "ASK" ? levels.slice(0, 1) : levels) };
    const parts = assemble({ books: clipped(clip), immediateOrderType: "GTD", statedExpiryNs: 120_000_000_000n });
    await drive(parts, 1, 5);
    clip.apply = undefined;
    const { entry } = ordersByRole(parts);
    expect(`${entry.state} ${entry.filledShares}/${entry.requestedShares}`).toBe("PARTIALLY_FILLED 30/50");
    const loop = parts.trader.loop;
    expect(loop.timeInForceFor(entry.plannedOrderId)).toBe("GTD");
    // WORKING: the entry's 50 × 0.35 = 17.5 stays reserved (never before terminal).
    expect(loop.health().seams.reservations).toMatchObject({ open: 2, taken: 2, released: 0, reservedCollateral: "17.5" });
    // The recorded clock passes the effective expiry; the next event expires it.
    parts.clock.positionAt("2026-05-01T09:00:03.000Z", 61_000_000_000n);
    await drive(parts, 6, 6);
    const expired = parts.venue.inner.ordersSnapshot().find((order) => order.simulatedOrderId === entry.simulatedOrderId);
    expect(`${String(expired?.state)} ${String(expired?.filledShares)}/50`).toBe("EXPIRED 30/50");
    // …and released at the harvest that saw it EXPIRED.
    expect(loop.health().seams.reservations).toMatchObject({ open: 1, taken: 2, released: 1, reservedCollateral: "0" });
    expect(loop.health().seams.allocator).toMatchObject({ open: 1, applied: 2, released: 1, reservedCollateral: "0" });
    await drive(parts, 7, 8);
    expectTerminalReleasedRetiredSettled(parts, entry.simulatedOrderId, "EXPIRED", 6);
    expectNeverCountedOpenAfter(entry.simulatedOrderId, 6);
  });
});

type Level = { readonly price: string; readonly size: string };

/** A mutable clip applied to the VENUE's ladders only; `undefined` passes them through. */
interface Clip {
  apply: ((side: "YES" | "NO", ladderSide: "BID" | "ASK", levels: readonly Level[]) => readonly Level[]) | undefined;
}

function clipped(clip: Clip): (base: MarketBookProvider) => MarketBookProvider {
  return (base) => ({
    book(request) {
      const book = base.book(request);
      if (book === undefined) return undefined;
      return {
        internalMarketId: book.internalMarketId,
        tokenId: book.tokenId,
        top: () => book.top(),
        ladder: (ladderSide) =>
          clip.apply === undefined ? book.ladder(ladderSide) : clip.apply(request.side, ladderSide, book.ladder(ladderSide)),
      };
    },
  });
}

/**
 * The loop's terminal release fired for the order (its time-in-force is gone),
 * its terminal view was delivered ONCE — evaluated at `atEvent` — and then it
 * was retired (`TERM-K`: never delivered again, out of `ctx.orders()`), and it
 * was settled with no mismatch.
 */
function expectTerminalReleasedRetiredSettled(
  parts: Assembled,
  orderId: string,
  terminalStatus: string,
  atEvent: number,
): void {
  const loop = parts.trader.loop;
  const order = parts.venue.inner.ordersSnapshot().find((candidate) => candidate.simulatedOrderId === orderId);
  if (order === undefined) throw new Error(`the venue does not hold ${orderId}`);
  expect(loop.timeInForceFor(order.plannedOrderId)).toBeUndefined();
  const terminal = deliveriesOf(parts, orderId).filter((delivery) => delivery.orderStatus === terminalStatus);
  expect(terminal.map((delivery) => `${String(delivery.event)} ${delivery.outcome}`)).toEqual([`${String(atEvent)} DECIDED`]);
  expectRetiredAfterFirstEvaluatedTerminalDelivery(parts, orderId);
  expect(loop.health().seams.orders.settleMismatches).toBe(0);
  expect(loop.orderProvenance().map((record) => record.venueOrderId)).toContain(orderId);
}

/**
 * No risk evaluation from event `fromEvent` on was handed the order as open —
 * and at least one risk evaluation happened then, so the check has something to
 * check.
 */
function expectNeverCountedOpenAfter(orderId: string, fromEvent: number): void {
  const later = riskInputs.calls.filter((call) => call.event >= fromEvent);
  expect(later.length, "no risk evaluation ran after the order went terminal").toBeGreaterThan(0);
  for (const call of later) expect(call.openOrderIds, `risk at event ${String(call.event)}`).not.toContain(orderId);
}

describe("the time-in-force leak on an allocator refusal is closed", () => {
  it("every planned order's time-in-force entry is released when the allocator refuses the plan", async () => {
    const parts = assemble();
    const planned: string[] = [];
    // The allocator REFUSES the first plan it is asked to apply (the entry):
    // a state the real caps reach only with a contrived book, answered here
    // in the allocator's own refusal shape.
    vi.spyOn(AllocatorGate.prototype, "applyForPlan").mockImplementationOnce((input) => {
      for (const entry of input.entries) planned.push(entry.plannedOrderId);
      return {
        ok: false,
        refusals: [{ code: "CAPITAL_GLOBAL_CAP_EXCEEDED", message: "TRDR-4 test: refused", details: {} }],
      } as unknown as ReturnType<AllocatorGate["applyForPlan"]>;
    });
    await drive(parts, 1, 5);
    const loop = parts.trader.loop;
    expect(loop.health().execution.allocationsRefused).toBe(1);
    expect(planned.length).toBeGreaterThan(0);
    // Nothing reached the venue, and no time-in-force entry survived.
    expect(parts.venue.inner.ordersSnapshot()).toEqual([]);
    for (const plannedOrderId of planned) expect(loop.timeInForceFor(plannedOrderId)).toBeUndefined();
  });
});

describe("retention bounds reach the loop through createPaperTrader, and evict oldest-first, counted", () => {
  it("decisions, traces and provenance keep their newest window; the store keeps everything", async () => {
    const parts = assemble({ retention: { decisions: 3, traces: 1, provenance: 2 } });
    await drive(parts, 1, 8);
    const loop = parts.trader.loop;
    // The durable store is unaffected: all 12 decisions were persisted.
    expect(parts.store.decisions).toHaveLength(12);
    const all = parts.store.decisions.map((written) => written.record.evaluationSeq);
    expect(loop.decisions().map((decision) => decision.evaluationSeq)).toEqual(all.slice(-3));
    const { takeProfit, reduce } = ordersByRole(parts);
    expect(loop.traces().map((trace) => trace.venueOrderId)).toEqual([reduce?.simulatedOrderId]);
    expect(loop.orderProvenance().map((record) => record.venueOrderId)).toEqual([
      takeProfit?.simulatedOrderId,
      reduce?.simulatedOrderId,
    ]);
    expect(loop.health().seams.retention).toEqual({
      decisions: { retained: 3, maximumRetained: 3, evicted: 9 },
      traces: { retained: 1, maximumRetained: 1, evicted: 2 },
      provenance: { retained: 2, maximumRetained: 2, evicted: 1 },
    });
  });

  it("a bound below 1 is REFUSED by name — createPaperTrader stays total", () => {
    expect(() => assemble({ retention: { decisions: 0 } })).toThrow(
      /TRADER_CONFIG_REFUSED: the core loop's retention bounds were refused/u,
    );
    expect(() => assemble({ retention: { tombstones: 1.5 } })).toThrow(/TRADER_CONFIG_REFUSED/u);
    expect(() => assemble({ retention: { provenance: -1 } })).toThrow(/TRADER_CONFIG_REFUSED/u);
  });
});

function virtualYes(loop: PaperTrader["loop"]): string {
  for (const line of projectionOf(loop.ledger()).virtualPositions.values()) {
    if (line.instanceId === INSTANCE_ID && line.assetId === `token:${YES_TOKEN}`) return line.balance;
  }
  return "0";
}
