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
  type PlannedOrderView,
  type RateLimitBudget,
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

/**
 * The fixture with a RESTING entry: a post-only BUY at `0.30`, below the best
 * ask, held under `GTC`.
 *
 * WHY IT EXISTS. The shipped fixture's entry is a `FAK` taker that fills and
 * goes terminal in the same instant, so three properties have no observable
 * moment in it: a reservation RISING on submission, a reservation SURVIVING a
 * non-terminal order view, and a fill arriving at an instance that is already
 * PAUSED. Review round 1's L2 and L3 name all three. This variant gives each of
 * them a moment, and it does so by CONFIGURATION — the strategy, the planner and
 * the venue are the same merged packages doing what an operator's own settings
 * ask of them.
 */
export function restingEntryConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = traderConfig();
  const instance = (base["instances"] as Record<string, unknown>[])[0];
  if (instance === undefined) throw new Error("the fixture configuration lost its instance");
  const params = strategyParams();
  const entry = params["entry"] as Record<string, unknown>;
  return {
    ...base,
    instances: [
      {
        ...instance,
        params: {
          ...params,
          entry: {
            ...entry,
            execution: {
              ...(entry["execution"] as Record<string, unknown>),
              liquidity_preference: "MAKER_ONLY",
              passive_price: "0.3",
              immediate_order_type: "GTC",
            },
          },
        },
      },
    ],
    ...overrides,
  };
}

/**
 * The public trade that TOUCHES the resting entry and fills it.
 *
 * §12.2 at Tier 0: "grants the whole remaining size on touch or trade-through".
 * A partially-filled RESTING order is therefore not representable in a Tier-0
 * fixture at all — ADR-012 §1 makes a Tier-1 resting result a BAND rather than a
 * point quantity — so the non-terminal moment this fixture offers is the order
 * RESTING before the trade arrives, which is what the reservation assertions
 * use.
 *
 * Emitted separately from {@link restingEntryEvents} so a test can drive the run
 * UP TO the resting order, do something to the process, and then let the fill
 * arrive.
 */
export function restingEntryTradeEvent(): IngestedEvent {
  return ingested(
    "PublicTradeObserved",
    { internalMarketId: MARKET_ID, tokenId: YES_TOKEN, price: "0.32", size: "20" },
    { receivedAt: "2026-03-04T12:00:05.000Z", ingestSeq: 7 },
  );
}

/** {@link recordedEvents} plus the trade that fills the resting entry. */
export function restingEntryEvents(): readonly IngestedEvent[] {
  return Object.freeze([...recordedEvents(), restingEntryTradeEvent()]);
}

export const MARKET_ID_2 = "018f4a7e-7777-7abc-8def-0123456789ab";
export const YES_TOKEN_2 = "333";
export const NO_TOKEN_2 = "444";
export const INSTANCE_ID_2 = "b18f4a7e-8888-7abc-8def-0123456789ab";
export const RUN_ID_2 = "018f4a7e-9999-7abc-8def-0123456789ab";
export const CONFIG_ID_2 = "018f4a7e-aaaa-7abc-8def-0123456789ab";

/**
 * TWO markets, each with its own OWNER instance, and a starting balance that
 * funds exactly ONE of the two entries.
 *
 * This is the shape review round 1's MEDIUM-4 needs: the trader's
 * {@link ReservationBook} holds COLLATERAL across markets, so a reservation
 * market 1's refused submission failed to release STARVES market 2's entry —
 * and the starvation is observable on the health surface (`plansRefused`)
 * without reaching into a private field.
 *
 * `startingCash` is `"18"`: one 50-share entry bounded at `0.35` reserves
 * `17.5`, leaving `0.5` — less than the second entry needs.
 */
export function twoMarketConfig(startingCash = "18"): Record<string, unknown> {
  const base = traderConfig();
  const market = (base["markets"] as Record<string, unknown>[])[0];
  const instance = (base["instances"] as Record<string, unknown>[])[0];
  if (market === undefined || instance === undefined) {
    throw new Error("the fixture configuration lost its market or its instance");
  }
  return {
    ...base,
    accounting: { ...(base["accounting"] as Record<string, unknown>), startingCash },
    simulation: { ...(base["simulation"] as Record<string, unknown>), startingCash },
    markets: [
      market,
      {
        ...market,
        marketId: MARKET_ID_2,
        yesTokenId: YES_TOKEN_2,
        noTokenId: NO_TOKEN_2,
      },
    ],
    instances: [
      instance,
      {
        ...instance,
        instanceId: INSTANCE_ID_2,
        runId: RUN_ID_2,
        configId: CONFIG_ID_2,
        marketId: MARKET_ID_2,
        evaluationPriority: 1,
      },
    ],
  };
}

/**
 * {@link recordedEvents} for both markets, market 1 FIRST and complete before
 * market 2 opens.
 *
 * The order matters: market 1's entry must be planned, submitted and REFUSED
 * before market 2's entry is planned, or the starvation the probe measures
 * could not be attributed to the leaked reservation.
 *
 * Each market needs TWO book evaluations, because the Static Bracket ARMS on
 * the first (`SB.ARMED`) and enters on the second.
 */
export function twoMarketEvents(): readonly IngestedEvent[] {
  resetEventIds();
  let seq = 0;
  const next = (): number => {
    seq += 1;
    return seq;
  };
  const at = (): string =>
    `2026-03-04T12:00:${String(seq).padStart(2, "0")}.000Z`;
  const reference = [
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
      { receivedAt: (next(), at()), ingestSeq: seq, source: "binance" },
    ),
  ];
  const forMarket = (
    marketId: string,
    yesTokenId: string,
    noTokenId: string,
  ): readonly IngestedEvent[] => [
    ingested(
      "MarketOpened",
      { internalMarketId: marketId, conditionId: "0xcondition", openedAt: T_OPEN },
      { receivedAt: (next(), at()), ingestSeq: seq },
    ),
    ingested(
      "BookSnapshot",
      {
        internalMarketId: marketId,
        tokenId: yesTokenId,
        bids: [
          { price: "0.32", size: "200" },
          { price: "0.31", size: "300" },
        ],
        asks: [
          { price: "0.34", size: "200" },
          { price: "0.35", size: "300" },
        ],
      },
      { receivedAt: (next(), at()), ingestSeq: seq },
    ),
    ingested(
      "BookSnapshot",
      {
        internalMarketId: marketId,
        tokenId: noTokenId,
        bids: [{ price: "0.65", size: "200" }],
        asks: [{ price: "0.66", size: "200" }],
      },
      { receivedAt: (next(), at()), ingestSeq: seq },
    ),
  ];
  return Object.freeze([
    ...reference,
    ...forMarket(MARKET_ID, YES_TOKEN, NO_TOKEN),
    ...forMarket(MARKET_ID_2, YES_TOKEN_2, NO_TOKEN_2),
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
    /**
     * The venue's §9.13 rate-limit budget.
     *
     * Defaults to `unmodeledRateLimits`, as the shipped process does. A test
     * that needs the REAL venue to REFUSE a submission supplies a token bucket
     * with no order tokens: that is a genuine `SIMULATED_VENUE_RATE_LIMITED`
     * refusal produced by the real venue, not a doubled one.
     */
    readonly rateLimits?: RateLimitBudget;
  } = {},
): { readonly result: CreateTraderResult; readonly parts: Assembled | undefined } {
  const clock = new ManualClock("2026-03-04T12:00:00.000Z");
  const store = new MemoryTraderStore();
  const feed = new MemoryEventFeed();
  const document = options.config ?? traderConfig();

  const books = new Map<string, BookView>();
  const bookSource: BookSource = {
    book(input) {
      return books.get(`${input.marketId}|${input.side}`);
    },
  };

  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error("the fixture fee snapshot was refused");

  // The two-phase venue wiring `apps/trader/src/main.ts` uses, for the same
  // reason: the venue asks the COMPOSITION ROOT for the book and for the
  // time-in-force, and both answers live inside the trader the venue is a
  // constructor argument to. The fixture holds the trader the same way the
  // process does, so the seam under test is the shipped one.
  const wiring: { trader: PaperTrader | undefined } = { trader: undefined };

  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({
      fillModelVersion: "tier0/fixture",
      fillModelParametersHash: "a".repeat(64),
    }),
    feeSnapshot: fees.value,
    rateLimits:
      options.rateLimits ??
      unmodeledRateLimits(
        "the paper fixture models no venue rate limit; §9.13's budget arrives with WP-310",
      ),
    policy: {
      /**
       * The `immediate_order_type` resolution lives in the TRADER
       * (`pipeline.ts` records it per planned order at plan time); this policy
       * asks the trader's own book through the hook the venue provides, exactly
       * as `main.ts` does.
       *
       * A literal here would have been a SECOND authority that agreed with the
       * trader by coincidence — review round 1, MEDIUM-3: with a literal
       * `"FAK"`, deleting the trader's recording loop changed nothing any test
       * could see, so the resolution mechanism was proved nowhere. The throw
       * below is the same fail-closed answer `main.ts` gives, and it is
       * contained by `SimulatedVenue.submit`'s own total boundary into a
       * REFUSED `ExecutionResult` (never a rejected promise).
       */
      timeInForceFor(order: PlannedOrderView): TimeInForce {
        const resolved = wiring.trader?.loop.timeInForceFor(order.plannedOrderId);
        if (resolved === undefined) {
          throw new Error(
            `no time-in-force was recorded for planned order ${order.plannedOrderId}; the ` +
              "composition root refuses to assume one (§12.1 ExecutionPolicy)",
          );
        }
        return resolved;
      },
      statedExpiryNsFor(): bigint | undefined {
        return undefined;
      },
      // ALIGNED WITH PRODUCTION (`main.ts`), review round 1 note N7. A book
      // snapshot is an aggregate per level, so this fixture does not observe
      // size added at a price in the same recorded instant either — and `"0"`
      // meant "we looked and saw nothing", which would have been a claim the
      // fixture never measured.
      sameInstantAdditionsFor() {
        return "NOT_OBSERVED" as const;
      },
    },
    // The venue's cash comes from the SAME document the trader parses, so the
    // two `startingCash` fields the configuration carries cannot silently
    // disagree here (review round 1, L5 — `parseTraderConfig` refuses a
    // document in which they do).
    startingCash: simulationStartingCash(document),
    books: bookSource,
  });

  const result = createPaperTrader({
    env: options.env ?? safeEnvironment(),
    config: document,
    clock,
    venue: venue as unknown as Parameters<typeof createPaperTrader>[0]["venue"],
    store,
    idNamespace: options.idNamespace ?? "wp-230-fixture",
  });
  if (!result.ok) return { result, parts: undefined };
  wiring.trader = result.trader;

  // The venue's book provider is bound to the trader's own market state, so the
  // venue executes against exactly the ladder the strategy read.
  bindBooks(result.trader, books);

  return { result, parts: { trader: result.trader, venue, store, feed, clock } };
}

/** `simulation.startingCash` from an UNPARSED document, or the fixture's own. */
function simulationStartingCash(document: Record<string, unknown>): string {
  const simulation = document["simulation"];
  if (typeof simulation !== "object" || simulation === null) return "1000";
  if (!Object.hasOwn(simulation, "startingCash")) return "1000";
  const cash = (simulation as Record<string, unknown>)["startingCash"];
  return typeof cash === "string" ? cash : "1000";
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
