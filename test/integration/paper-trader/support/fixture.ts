/**
 * The end-to-end paper fixture: one market, one Static Bracket instance, one
 * recorded event sequence, and the REAL assembled system behind them.
 *
 * WHAT IS REAL HERE (everything the packet calls "subject behaviour"):
 * `packages/order-book`, `packages/features`, `packages/strategy-runtime`,
 * `packages/strategies/static-bracket`, `packages/capital-allocator`,
 * `packages/risk`, `packages/execution-planner`, `packages/simulation`'s
 * `SimulatedVenue`, `packages/ledger` and `packages/pnl`.
 *
 * WHAT IS DOUBLED (only §12.1 seams and §4.2 boundaries): the clock, the event
 * transport, and the durable store.
 *
 * ## The configuration is derived, not invented
 *
 * The strategy's own §13.2 configuration is the shape `WP-220`'s acceptance
 * suite uses, and the two feature keys are the ones `packages/strategies/static-bracket`'s
 * README obligation 2 names — `polymarket.executable_buy_price@50` bound to
 * `executable_ask` and `polymarket.executable_sell_price@50` bound to
 * `executable_bid` — so the projection this trader performs is exercised
 * against the exact keys the strategy demands rather than against a key chosen
 * to make a test pass.
 *
 * ## The book makes the trigger fire, and the numbers say why
 *
 * `entry.trigger_price_lte` is `"0.35"`. The YES ask ladder is `0.34 × 200`, so
 * the executable BUY price for the configured quantity of 50 shares is exactly
 * `0.34` — one level, no averaging, no division — which is `≤ 0.35`. Nothing in
 * the fixture depends on a rounding policy.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type RecordedEventIdentity,
  type TimeInForce,
} from "@polymarket-bot/simulation";
import {
  createPaperTrader,
  type CreateTraderResult,
  type IngestedEvent,
  type PaperTrader,
} from "@polymarket-bot/trader";
import { ManualClock, MemoryEventFeed, MemoryTraderStore } from "@polymarket-bot/trader/testing";

export const MARKET_ID = "018f4a7e-1111-7abc-8def-0123456789ab";
export const YES_TOKEN = "111";
export const NO_TOKEN = "222";
export const INSTANCE_ID = "a18f4a7e-2222-7abc-8def-0123456789ab";
export const RUN_ID = "018f4a7e-3333-7abc-8def-0123456789ab";
export const CONFIG_ID = "018f4a7e-4444-7abc-8def-0123456789ab";
export const GATEWAY_EPOCH = "018f4a7e-5555-7abc-8def-0123456789ab";

export const T_OPEN = "2026-03-04T12:00:00.000Z";
export const T_CLOSE = "2026-03-04T12:15:00.000Z";

export const TRIGGER_KEY = "polymarket.executable_buy_price@50";
export const STOP_KEY = "polymarket.executable_sell_price@50";
export const INCIDENT_KEY = "quality.active_incidents@any";

/** A safe, PAPER-only environment. Carries no production secret name. */
export function safeEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    NODE_ENV: "test",
  };
}

/** The §13.2 strategy configuration, with the feature keys obligation 2 names. */
export function strategyParams(): Record<string, unknown> {
  return {
    strategy: "static-bracket",
    version: 1,
    market_selector: { series_id: "btc-15m-updown", direction: "YES" },
    entry: {
      trigger_basis: "executable_ask",
      trigger_feature_key: TRIGGER_KEY,
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
      take_profit: { price: "0.50", liquidity_preference: "MAKER_ONLY", post_only: true },
      stop: {
        enabled: true,
        trigger_basis: "executable_bid",
        trigger_feature_key: STOP_KEY,
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
      maximum_book_participation: "0.5",
    },
    data_quality: {
      maximum_book_age_ms: 600000,
      incident_feature_key: INCIDENT_KEY,
      on_stale_book: "PAUSE_AND_CANCEL",
      on_incident: "PAUSE_AND_CANCEL",
    },
  };
}

/** The §9.8 policy, permissive enough that the trade is decided by the strategy. */
export function riskPolicy(): Record<string, unknown> {
  return {
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
  };
}

/** §9.7 caps. Both live-micro caps are the fenced `"0"` floor. */
export function allocatorCaps(): Record<string, unknown> {
  return {
    globalAccountCap: "10000",
    perStrategyCap: "1000",
    liveMicroMaxOrderNotional: "0",
    liveMicroMaxAccountExposure: "0",
  };
}

export function traderConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "PAPER",
    riskPolicy: riskPolicy(),
    allocatorCaps: allocatorCaps(),
    accounting: {
      accountRef: "paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "venue-clearing",
      attributionClearingRef: "attribution-clearing",
      feeExpenseRef: "fee-expense",
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
      submissionUnknownAfterMs: 5_000,
    },
    simulation: {
      fillModelVersion: "tier0.fixture",
      fillModelParametersHash: "a".repeat(64),
      feeSchedule: {
        snapshotVersion: "fixture.2026-03-04",
        takerFeeRate: "0",
        makerFeeRate: "0",
        roundingDecimalPlaces: 6,
        roundingMode: "HALF_UP",
        minimumChargedFee: "0",
        feeCurrency: "pUSD",
      },
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
      consumerId: "trader-1",
      receiveBatchSize: 128,
      retentionMaxEvents: 100_000,
    },
    markets: [
      {
        marketId: MARKET_ID,
        conditionId: "0xcondition",
        yesTokenId: YES_TOKEN,
        noTokenId: NO_TOKEN,
        tickSize: "0.01",
        minimumOrderSize: "5",
        makerFeeRate: "0",
        takerFeeRate: "0",
        parametersVersion: 1,
        settlementReadiness: { modelDependentActivationAllowed: true },
        openTime: T_OPEN,
        closeTime: T_CLOSE,
        seriesKey: "btc-15m-updown",
        underlyingKey: "BTC",
        resolutionWindowKey: "w2026-03-04T12.15",
      },
    ],
    instances: [
      {
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        configId: CONFIG_ID,
        runSeed: "424242",
        marketId: MARKET_ID,
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5_000_000,
        params: strategyParams(),
      },
    ],
    ...overrides,
  };
}

let eventOrdinal = 0;

function eventId(ordinal: number): string {
  return `018f4a7e-6666-7abc-8def-${String(ordinal).padStart(12, "0")}`;
}

/** Builds one §7.1 envelope plus the recorded identity the venue anchors to. */
export function ingested(
  eventType: string,
  payload: unknown,
  input: {
    readonly receivedAt: string;
    readonly ingestSeq: number;
    /**
     * §7.1's authoritative provenance. A reference event's payload restates its
     * `venue`, and the envelope contract REFUSES a document where the two
     * disagree — so a reference event is published under its own venue source,
     * exactly as `apps/data-gateway` publishes it.
     */
    readonly source?: "polymarket" | "binance" | "coinbase" | "rtds" | "internal";
  },
): IngestedEvent {
  eventOrdinal += 1;
  const identity: RecordedEventIdentity = {
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(input.ingestSeq),
    receivedAt: input.receivedAt,
    datasetRowOrdinal: input.ingestSeq,
  };
  const envelope: EventEnvelope<unknown> = {
    eventId: eventId(eventOrdinal),
    eventType,
    schemaVersion: 1,
    source: input.source ?? "polymarket",
    sourceChannel: "market",
    receivedAt: input.receivedAt,
    receivedMonotonicNs: String(input.ingestSeq * 1_000_000),
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(input.ingestSeq),
    subscriptionGeneration: 1,
    payload,
  };
  return { envelope, identity };
}

/** Resets the fixture's event-id counter so two runs mint identical ids. */
export function resetEventIds(): void {
  eventOrdinal = 0;
}

/**
 * The recorded event sequence.
 *
 * `MarketOpened` then a `BookSnapshot` whose YES ask ladder puts the executable
 * buy price for 50 shares at exactly `0.34` — under the configured `0.35`
 * trigger — so the Static Bracket's entry fires on the snapshot's own
 * evaluation.
 */
export function recordedEvents(): readonly IngestedEvent[] {
  resetEventIds();
  return Object.freeze([
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
      { receivedAt: "2026-03-04T11:59:58.000Z", ingestSeq: 1, source: "binance" },
    ),
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100100", size: "0.25" },
      { receivedAt: "2026-03-04T11:59:59.000Z", ingestSeq: 2, source: "binance" },
    ),
    ingested(
      "MarketOpened",
      { internalMarketId: MARKET_ID, conditionId: "0xcondition", openedAt: T_OPEN },
      { receivedAt: "2026-03-04T12:00:00.000Z", ingestSeq: 3 },
    ),
    ingested(
      "BookSnapshot",
      {
        internalMarketId: MARKET_ID,
        tokenId: YES_TOKEN,
        bids: [
          { price: "0.32", size: "200" },
          { price: "0.31", size: "300" },
        ],
        asks: [
          { price: "0.34", size: "200" },
          { price: "0.35", size: "300" },
        ],
      },
      { receivedAt: "2026-03-04T12:00:01.000Z", ingestSeq: 4 },
    ),
    ingested(
      "BookSnapshot",
      {
        internalMarketId: MARKET_ID,
        tokenId: NO_TOKEN,
        bids: [{ price: "0.65", size: "200" }],
        asks: [{ price: "0.66", size: "200" }],
      },
      { receivedAt: "2026-03-04T12:00:02.000Z", ingestSeq: 5 },
    ),
    ingested(
      "BookLevelChanged",
      {
        internalMarketId: MARKET_ID,
        tokenId: YES_TOKEN,
        side: "ASK",
        price: "0.34",
        size: "150",
      },
      { receivedAt: "2026-03-04T12:00:03.000Z", ingestSeq: 6 },
    ),
  ]);
}

/** The 2026-08-24 venue fee snapshot shape, with zero fees for a clean fixture. */
export function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "fixture-2026-03-04",
    takerFeeRate: "0",
    makerFeeRate: "0",
    roundingDecimalPlaces: 6,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

/** A book provider over the trader's own market state, for the Tier-0 venue. */
export interface BookSource {
  book(input: { readonly marketId: string; readonly side: "YES" | "NO" }): BookView | undefined;
}

export interface Assembled {
  readonly trader: PaperTrader;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly feed: MemoryEventFeed;
  readonly clock: ManualClock;
}

/**
 * Assembles the whole system.
 *
 * The venue is a REAL `SimulatedVenue` at Tier 0 (the pipeline-smoke model,
 * whose `deploymentDecisionUse` is `FORBIDDEN` and which this fixture uses for
 * exactly what it is for: proving the wiring). Its book provider reads the
 * trader's own live books, so the venue executes against the same state the
 * strategy saw.
 */
export function assemble(
  options: {
    readonly config?: Record<string, unknown>;
    readonly env?: Record<string, string | undefined>;
    readonly idNamespace?: string;
  } = {},
): { readonly result: CreateTraderResult; readonly parts: Assembled | undefined } {
  const clock = new ManualClock("2026-03-04T12:00:00.000Z");
  const store = new MemoryTraderStore();
  const feed = new MemoryEventFeed();

  const books = new Map<string, BookView>();
  const bookSource: BookSource = {
    book(input) {
      return books.get(`${input.marketId}|${input.side}`);
    },
  };

  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error("the fixture fee snapshot was refused");

  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({
      fillModelVersion: "tier0/fixture",
      fillModelParametersHash: "a".repeat(64),
    }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits(
      "the paper fixture models no venue rate limit; §9.13's budget arrives with WP-310",
    ),
    policy: {
      // The `immediate_order_type` resolution lives in the trader
      // (`pipeline.ts`); this fixture policy asks the trader's book through the
      // hook the venue provides. The fixture's strategy configures `FAK`, so an
      // unfilled remainder is cancelled rather than rested.
      timeInForceFor(): TimeInForce {
        return "FAK";
      },
      statedExpiryNsFor(): bigint | undefined {
        return undefined;
      },
      sameInstantAdditionsFor() {
        return { observedShares: "0" } as const;
      },
    },
    startingCash: "1000",
    books: bookSource,
  });

  const result = createPaperTrader({
    env: options.env ?? safeEnvironment(),
    config: options.config ?? traderConfig(),
    clock,
    venue: venue as unknown as Parameters<typeof createPaperTrader>[0]["venue"],
    store,
    idNamespace: options.idNamespace ?? "wp-230-fixture",
  });
  if (!result.ok) return { result, parts: undefined };

  // The venue's book provider is bound to the trader's own market state, so the
  // venue executes against exactly the ladder the strategy read.
  bindBooks(result.trader, books);

  return { result, parts: { trader: result.trader, venue, store, feed, clock } };
}

/**
 * Points the venue's book provider at the trader's live books.
 *
 * `BookView` is the §12.1 structural port (`top()` / `ladder()`), and
 * `packages/order-book`'s `OutcomeTokenBook` answers both shapes — so this is a
 * PROJECTION of the real book, not a copy of it: a level applied to the
 * trader's book is visible to the venue on the next read. That is what makes
 * the venue execute against exactly the ladder the strategy saw.
 */
function bindBooks(trader: PaperTrader, into: Map<string, BookView>): void {
  for (const market of trader.config.markets) {
    for (const side of ["YES", "NO"] as const) {
      const state = trader.markets.get(market.marketId);
      if (state === undefined) continue;
      into.set(`${market.marketId}|${side}`, {
        internalMarketId: market.marketId,
        tokenId: side === "YES" ? market.yesTokenId : market.noTokenId,
        top() {
          const top = state.bookFor(side).topOfBook();
          return {
            ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
            ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
            ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
            ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
            ...(top.spread === undefined ? {} : { spread: top.spread }),
          };
        },
        ladder(bookSide) {
          return state
            .bookFor(side)
            .levels(bookSide)
            .map((level) => ({ price: level.price, size: level.size }));
        },
      });
    }
  }
}
