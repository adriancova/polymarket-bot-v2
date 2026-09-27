/**
 * `RECON-2` — `CoreLoop.orderProvenance()`, pinned.
 *
 * The loop builds every order's §6 invariant 4 trace PREFIX at SUBMISSION and
 * completes it into a `TraceLink` only when a fill arrives. An order that rests
 * and is withdrawn unfilled therefore has no trace, and until this accessor
 * nothing outside the loop could name its origin by id. `test/e2e`'s reconciler
 * reads the prefixes through this accessor to attribute every order — filled or
 * not — to the decision that placed it.
 *
 * Three properties are pinned, against the REAL composition (books, features,
 * strategy runtime, Static Bracket, allocator, risk, planner, `SimulatedVenue`,
 * ledger, PnL); only the clock and the durable store are the trader's own
 * in-memory doubles, and the venue's execution policy is `main.ts`'s own:
 *
 * 1. the withdrawn, UNFILLED take-profit's provenance is present and names the
 *    `exit` decision that placed it;
 * 2. the answer is a COPY: frozen, fresh on every call, and nothing a caller
 *    does to it reaches the loop;
 * 3. no behaviour change: a FILLED order's provenance is exactly its traces'
 *    prefix, and every booked order has exactly one record.
 *
 * The scenario is a compact copy of `test/e2e/support/scenario.ts`'s WP-250 run
 * (same book, sizes, prices, fee schedule and event list). It is restated here
 * because this package's `tsconfig` roots at `src/`, so it cannot import from
 * `test/`. Every number is that file's, and its reasons are stated there.
 *
 * PAPER only: the four repository floors are stated as values below. No
 * network, no credential, no signer, no real order.
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

import { createExecutionPolicy, type VenueWiring } from "./main.js";
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

function traderConfig(): Record<string, unknown> {
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
      maxSliceShares: "100",
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
      consumerId: "recon-2-order-provenance",
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

/** The WP-250 event list: entry at event 5, take-profit withdrawn at event 6, reduce at 7. */
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

interface Assembled {
  readonly trader: PaperTrader;
  readonly venue: SimulatedVenue;
}

/** The composition, with `main.ts`'s execution policy and book wiring. */
function assemble(): Assembled {
  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error(`the scenario's fee snapshot was refused: ${fees.refusal.code}`);
  const wiring: VenueWiring = { trader: undefined };
  const clock = new ManualClock(T_OPEN);
  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.wp250", fillModelParametersHash: "b".repeat(64) }),
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
  const result = createPaperTrader({
    env: paperEnvironment(),
    config: traderConfig(),
    clock,
    venue,
    store: new MemoryTraderStore(),
    idNamespace: "recon-2-order-provenance",
  });
  if (!result.ok) {
    throw new Error(`${result.refusal.code}: ${result.refusal.detail}`);
  }
  wiring.trader = result.trader;
  return { trader: result.trader, venue };
}

/** Ingests events `from`..`to` (1-based, inclusive) and drains the loop. */
async function drive(parts: Assembled, from: number, to: number): Promise<void> {
  for (let ordinal = from; ordinal <= to; ordinal += 1) {
    const recorded = RECORDED[ordinal - 1];
    if (recorded === undefined) throw new Error(`no recorded event ${String(ordinal)}`);
    if (!parts.trader.loop.ingest(ingested(recorded, ordinal))) {
      throw new Error(`the ingest queue refused event ${String(ordinal)}`);
    }
  }
  await parts.trader.loop.drain();
}

/** A trace without its three fill-side fields: what the loop built at submission. */
function prefixOf(trace: ReturnType<PaperTrader["loop"]["traces"]>[number]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(trace).filter(
      ([key]) => key !== "venueFillId" && key !== "ledgerFillId" && key !== "ledgerTransactionIds",
    ),
  );
}

describe("CoreLoop.orderProvenance — every order's origin, by id, filled or not", () => {
  it("the withdrawn, UNFILLED take-profit has a provenance record naming the exit decision", async () => {
    const parts = assemble();
    // Through event 6: the entry fills, the take-profit rests, and the
    // allocation grows, so the take-profit is withdrawn (cancel-before-replace).
    await drive(parts, 1, 6);
    const loop = parts.trader.loop;

    const withdrawn = parts.venue
      .ordersSnapshot()
      .filter((order) => order.state === "CANCELLED" && order.filledShares === "0");
    expect(withdrawn).toHaveLength(1);
    const order = withdrawn[0];
    if (order === undefined) return;
    // Non-vacuous: no TRACE names it — the loop completes a chain only on a
    // fill — so before this accessor nothing linked it to its intent by id.
    expect(loop.traces().some((trace) => trace.venueOrderId === order.simulatedOrderId)).toBe(false);
    expect(loop.health().execution.cancelsConfirmed).toBe(1);

    const records = loop
      .orderProvenance()
      .filter((record) => record.venueOrderId === order.simulatedOrderId);
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) return;
    expect(record.executionPlanId).toBe(order.executionPlanId);
    expect(record.runId).toBe(RUN_ID);
    // The decision at (runId, evaluationSeq) is the `exit` decision, and it
    // emitted exactly this intent: the take-profit.
    const decision = loop
      .decisions()
      .find((candidate) => candidate.runId === record.runId && candidate.evaluationSeq === record.evaluationSeq);
    expect(decision?.decisionType).toBe("exit");
    expect(decision?.intentIds).toEqual([record.intentId]);
    expect(record.intentId).toBe(`sb-take-profit-1-${MARKET_ID}`);
    expect(record.featureSnapshotRef).toBe(decision?.featureSnapshotRef);
    // An `onFill` evaluation has no triggering event: the loop records `""`
    // (it passes `""` to `#consumeOutcome` for the deliveries it originates).
    expect(decision?.callback).toBe("onFill");
    expect(record.sourceEventId).toBe("");
    expect(record.approvedIntentId).not.toBe("");
    expect(record.submissionAttemptId).not.toBe("");
  });

  it("the answer is a COPY: frozen, fresh on every call, and a caller cannot reach the loop", async () => {
    const parts = assemble();
    await drive(parts, 1, 6);
    const loop = parts.trader.loop;

    const first = loop.orderProvenance();
    const before = JSON.stringify(first);
    expect(first.length).toBeGreaterThan(0);
    const head = first[0];
    if (head === undefined) return;

    // Frozen, list and entries alike: mutation throws (ES modules are strict).
    expect(Object.isFrozen(first)).toBe(true);
    for (const record of first) expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      (first as unknown as unknown[]).push({ venueOrderId: "tampered" });
    }).toThrow(TypeError);
    expect(() => {
      (head as { intentId: string }).intentId = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      delete (head as { runId?: string }).runId;
    }).toThrow(TypeError);

    // Fresh on every call: a new list of new objects, never the loop's own
    // records — so even a caller that got past the freeze would hold a copy.
    const second = loop.orderProvenance();
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(head);
    expect(JSON.stringify(second)).toBe(before);

    // A caller's own copy of the answer is freely mutable, and the loop does
    // not see it.
    const scratch = JSON.parse(before) as Record<string, unknown>[];
    for (const record of scratch) record["intentId"] = "tampered";
    expect(JSON.stringify(loop.orderProvenance())).toBe(before);

    // The run continues unaffected: the reduce at event 7 is placed and filled,
    // its record is APPENDED, and every earlier record is byte-identical.
    await drive(parts, 7, 8);
    const after = loop.orderProvenance();
    expect(after.length).toBe(first.length + 1);
    expect(JSON.stringify(after.slice(0, first.length))).toBe(before);
  });

  it("no behaviour change: every booked order has one record, and a filled order's is its traces' prefix", async () => {
    const parts = assemble();
    await drive(parts, 1, 8);
    const loop = parts.trader.loop;
    const provenance = loop.orderProvenance();
    const orders = parts.venue.ordersSnapshot();

    // One record per booked order, and no record for an order the venue does
    // not hold: entry, take-profit and protective reduce, in submission order.
    expect(provenance.map((record) => record.venueOrderId)).toEqual(
      orders.map((order) => order.simulatedOrderId),
    );
    expect(new Set(provenance.map((record) => record.venueOrderId)).size).toBe(provenance.length);
    expect(provenance).toHaveLength(3);
    for (const order of orders) {
      const record = provenance.find((candidate) => candidate.venueOrderId === order.simulatedOrderId);
      expect(record?.executionPlanId).toBe(order.executionPlanId);
    }

    // Every trace is its order's provenance record plus the three fill-side
    // fields: the accessor exposes the SAME prefix the loop completes on a fill.
    const traces = loop.traces();
    expect(traces).toHaveLength(3);
    for (const trace of traces) {
      const record = provenance.find((candidate) => candidate.venueOrderId === trace.venueOrderId);
      expect(record).toBeDefined();
      expect({ ...record }).toEqual(prefixOf(trace));
    }
    // The two filled orders are traced; the withdrawn take-profit is not.
    const traced = new Set(traces.map((trace) => trace.venueOrderId));
    expect(provenance.filter((record) => !traced.has(record.venueOrderId))).toHaveLength(1);
  });
});
