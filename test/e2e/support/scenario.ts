/**
 * `WP-250`'s OWN deterministic paper scenario.
 *
 * This is not `test/integration/paper-trader`'s fixture and does not import it.
 * `WP-230`'s fixture already asserts the §6 invariant-4 chain hop by hop from
 * INSIDE the running process; this package's obligation is a different
 * primitive — an outside-in walk over what the run PERSISTED — so it drives the
 * same merged composition through a scenario it owns, with values chosen to
 * make the projected/realized differences OBSERVABLE rather than absent.
 *
 * ## Every number here is chosen, and the reason is stated
 *
 * | Choice | Why |
 * | --- | --- |
 * | YES ask ladder `0.34 x 30` then `0.35 x 40` | a 50-share entry consumes TWO levels, so the realized average price differs from the top of book by LADDER WALK and `packages/simulation`'s "one fill per consumed level" is exercised |
 * | `entry.trigger_price_lte` `"0.35"` | executable buy price for 50 shares is `(30*0.34 + 20*0.35)/50 = 17.2/50 = 0.344`, exactly representable, `<= 0.35`, so the trigger fires without depending on a rounding policy |
 * | `maximum_buy_price` `"0.35"` | the second level is inside the limit; a tighter limit would make the fixture a partial-fill fixture instead |
 * | `takerFeeRate` `"0.0195"` with `roundingDecimalPlaces` 3 | the venue fee is `shares * rate * price * (1 - price)` (`packages/simulation/src/fees.ts`); at these values level 1 rounds HALF_UP **up** and level 2 rounds **down**, so the rounding rule's DIRECTION is observable in both directions rather than assumed |
 * | `makerFeeRate` `"0"` | ADR-012 §5.4 / the venue report: makers pay no fees |
 * | series `wp250-paper-sim` | see the settlement-readiness note below |
 *
 * ## Settlement readiness is a TRUTHFUL statement here
 *
 * `apps/trader`'s config door requires `settlementReadiness` with NO default,
 * because §9.8 check 6 refuses an entry into a market whose settlement
 * specification is not verified. Its own documentation records that
 * `btc-15m-updown` has no human-reviewed settlement specification in this
 * repository, so a truthful configuration for THAT series states `false` and
 * every entry is refused.
 *
 * This scenario therefore does not use that series. Its market is a SIMULATED
 * market this suite defines end to end (`wp250-paper-sim`): the settlement rule
 * is "the recorded `MarketResolved` event in this scenario's own event list",
 * which is specified, reviewed and verifiable by reading this file. Stating
 * `modelDependentActivationAllowed: true` about it is a true statement about a
 * market whose specification is right here, and it is the ONLY honest way to
 * get a trading run without weakening a gate.
 *
 * ## Determinism
 *
 * No wall clock, no `Math.random`, no host entropy, no file read. Instants are
 * literals, ordinals are counted, and the trader's `idNamespace` fixes every
 * minted id (`DeterministicIdFactory`).
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { FeeScheduleSnapshot, RecordedEventIdentity } from "@polymarket-bot/simulation";
import type { IngestedEvent } from "@polymarket-bot/trader";

import type { Scenario } from "./scenario-contract.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The `idNamespace` handed to `createPaperTrader`.
 *
 * `DeterministicIdFactory` folds it into every minted ledger and PnL id, so it
 * is the seed the golden bytes are frozen against. Changing this string changes
 * the golden.
 */
export const ID_NAMESPACE = "wp-250-paper-e2e";

export const MARKET_ID = "018f5c20-1000-7a10-8b00-000000000001";
export const CONDITION_ID = "0xwp250condition";
export const YES_TOKEN = "9001";
export const NO_TOKEN = "9002";

/**
 * The strategy instance id.
 *
 * A canonical lowercase UUIDv7 whose FIRST hex digit is a LETTER. That WAS the
 * intersection of two conflicting doors: `packages/ledger` and `packages/pnl`
 * required `Uuidv7Schema` while `packages/risk` typed
 * `context.strategyInstanceId` as a `CodeString` (leading letter), so
 * `apps/trader`'s config door refused anything else AT STARTUP and this
 * scenario observed the residual by configuring inside it, exactly as
 * `WP-230`'s fixture did.
 *
 * ADR-021 resolved the conflict — the field is an identity, typed
 * `Uuidv7Schema` at every door — so the letter lead is no longer required. The
 * value is UNCHANGED: it is still valid, the golden is frozen against it, and
 * `residuals-observed.test.ts` now pins it as the COMPATIBILITY half of the
 * ruling rather than as the only shape that works.
 */
export const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-000000000002";
export const RUN_ID = "018f5c20-3000-7a30-8b00-000000000003";
export const CONFIG_ID = "018f5c20-4000-7a40-8b00-000000000004";
export const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-000000000005";

/** A SHADOW observer over the same market — ADR-011 §5: it submits nothing. */
export const SHADOW_INSTANCE_ID = "f18f5c20-6000-7a60-8b00-000000000006";
export const SHADOW_RUN_ID = "018f5c20-7000-7a70-8b00-000000000007";
export const SHADOW_CONFIG_ID = "018f5c20-8000-7a80-8b00-000000000008";

export const SERIES_KEY = "wp250-paper-sim";
export const UNDERLYING_KEY = "SIMBTC";
export const RESOLUTION_WINDOW_KEY = "w2026-05-01T09.15";

export const ACCOUNT_REF = "wp250-paper-account";
export const DENOMINATION_ASSET_ID = "pUSD";

export const T_OPEN = "2026-05-01T09:00:00.000Z";
export const T_CLOSE = "2026-05-01T09:15:00.000Z";

export const TRIGGER_KEY = "polymarket.executable_buy_price@50";
export const STOP_KEY = "polymarket.executable_sell_price@50";
export const INCIDENT_KEY = "quality.active_incidents@any";

// ---------------------------------------------------------------------------
// The book, stated once so the fixture and the arithmetic cannot disagree
// ---------------------------------------------------------------------------

/** One price level of the recorded YES ask ladder. */
export interface Level {
  readonly price: string;
  readonly size: string;
}

/** The recorded YES ask ladder, in book order. A 50-share BUY walks BOTH. */
export const YES_ASKS: readonly Level[] = Object.freeze([
  Object.freeze({ price: "0.34", size: "30" }),
  Object.freeze({ price: "0.35", size: "40" }),
]);

export const YES_BIDS: readonly Level[] = Object.freeze([
  Object.freeze({ price: "0.32", size: "200" }),
  Object.freeze({ price: "0.31", size: "300" }),
]);

/** The configured entry size, in shares. */
export const ENTRY_SHARES = "50";

/** The configured entry trigger, and the plan's price ceiling. */
export const TRIGGER_PRICE_LTE = "0.35";
export const MAXIMUM_BUY_PRICE = "0.35";
export const MAXIMUM_TOTAL_COST = "18";
/**
 * CANONICAL, not `"0.50"`: §6 invariant 1's canonical decimal form has no
 * trailing fractional zero, and `@polymarket-bot/decimal` refuses the padded
 * spelling. The strategy's own validator normalises either form, but this
 * scenario's constants are read directly by the reconciliation's exact
 * arithmetic, so they are canonical at the source.
 */
export const TAKE_PROFIT_PRICE = "0.5";

/** The strategy's own configured per-share fee model (`entry.economics`). */
export const ENTRY_FEE_PER_SHARE = "0.001";
export const EXIT_FEE_PER_SHARE = "0.001";
export const MINIMUM_EXPECTED_NET_EDGE = "1";

/** Starting cash, both for the accounting book and for the simulated venue. */
export const STARTING_CASH = "1000";

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/**
 * The PAPER-only environment this suite runs the trader in.
 *
 * The four repository floors are stated here as VALUES, not defaults, so a
 * reader can see them: `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, both
 * live-micro caps at `"0"`. Nothing in this tree can raise them — `safety.ts`
 * refuses rather than clamps — and `safety-posture.test.ts` proves it.
 *
 * Carries NO production secret name (ADR-010 §3).
 */
export function paperEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    NODE_ENV: "test",
  };
}

// ---------------------------------------------------------------------------
// The venue fee schedule
// ---------------------------------------------------------------------------

/**
 * The operator-stated fee snapshot (§6 invariant 9: a versioned venue fact).
 *
 * NON-ZERO on purpose. `WP-230`'s fixture zeroes both rates to keep its
 * arithmetic clean; this package's acceptance criterion is the opposite — every
 * difference between a projected and a realized value must be explained by a
 * NAMED mechanism, and a fee schedule of zero exercises no fee mechanism at
 * all.
 */
export function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "wp250.sim.2026-05-01",
    takerFeeRate: "0.0195",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: DENOMINATION_ASSET_ID,
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The §13.2 Static Bracket configuration. */
export function strategyParams(): Record<string, unknown> {
  return {
    strategy: "static-bracket",
    version: 1,
    market_selector: { series_id: SERIES_KEY, direction: "YES" },
    entry: {
      trigger_basis: "executable_ask",
      trigger_feature_key: TRIGGER_KEY,
      trigger_price_lte: TRIGGER_PRICE_LTE,
      size_shares: ENTRY_SHARES,
      maximum_total_cost: MAXIMUM_TOTAL_COST,
      economic_leg_policy: "DIRECT_ONLY",
      execution: {
        liquidity_preference: "TAKER_OK",
        passive_price: "0.34",
        convert_to_aggressive_after_ms: 0,
        maximum_buy_price: MAXIMUM_BUY_PRICE,
        immediate_order_type: "FAK",
        partial_fill_policy: "ACCEPT_ANY",
        minimum_fill_shares: "10",
        submission_unknown_after_ms: 5000,
        order_validity_ms: 30000,
      },
      economics: {
        entry_fee_per_share: ENTRY_FEE_PER_SHARE,
        exit_fee_per_share: EXIT_FEE_PER_SHARE,
        minimum_expected_net_edge: MINIMUM_EXPECTED_NET_EDGE,
      },
    },
    exit: {
      take_profit: {
        price: TAKE_PROFIT_PRICE,
        liquidity_preference: "MAKER_ONLY",
        post_only: true,
      },
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
      maximum_position_shares: ENTRY_SHARES,
      maximum_contractual_loss: MAXIMUM_TOTAL_COST,
      maximum_slippage: "1",
      maximum_book_participation: "0.9",
    },
    data_quality: {
      maximum_book_age_ms: 600000,
      incident_feature_key: INCIDENT_KEY,
      on_stale_book: "PAUSE_AND_CANCEL",
      on_incident: "PAUSE_AND_CANCEL",
    },
  };
}

/**
 * The §9.8 policy.
 *
 * Permissive on the dimensions this scenario does not measure, so the trade is
 * decided by the STRATEGY and not by a risk knob tuned to produce it. Nothing
 * here disables a check: `economics`, `participation` and the settlement gate
 * keep `packages/risk`'s own defaults — which is why this run once OBSERVED the
 * protective-exit refusal (GOV-2B B2, fixed by `RISK-2`) instead of hiding it,
 * and why it now shows that exit approved on its merits (`risk.refusedExits`
 * 0).
 */
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

/** §9.7 caps. Both live-micro caps are the repository floor, `"0"`. */
export function allocatorCaps(): Record<string, unknown> {
  return {
    globalAccountCap: "10000",
    perStrategyCap: "1000",
    liveMicroMaxOrderNotional: "0",
    liveMicroMaxAccountExposure: "0",
  };
}

/**
 * The whole operator document.
 *
 * @param options.withShadow adds a second, `SHADOW` instance over the SAME
 *   market. ADR-011 §5 makes it observe-only in this process: its decisions are
 *   persisted, none of its intents is routed, and the routing side of that fact
 *   is `execution.observeOnlyIntents` on the health surface.
 */
export function traderConfig(
  options: { readonly withShadow?: boolean } = {},
): Record<string, unknown> {
  const owner = {
    instanceId: INSTANCE_ID,
    runId: RUN_ID,
    configId: CONFIG_ID,
    runSeed: "250250",
    marketId: MARKET_ID,
    ownership: "OWNER",
    evaluationPriority: 0,
    evaluationBudgetUs: 5_000_000,
    params: strategyParams(),
  };
  const shadow = {
    ...owner,
    instanceId: SHADOW_INSTANCE_ID,
    runId: SHADOW_RUN_ID,
    configId: SHADOW_CONFIG_ID,
    ownership: "SHADOW",
    evaluationPriority: 1,
  };
  const fees = feeSnapshot();
  return {
    environment: "PAPER",
    riskPolicy: riskPolicy(),
    allocatorCaps: allocatorCaps(),
    accounting: {
      accountRef: ACCOUNT_REF,
      denominationAssetId: DENOMINATION_ASSET_ID,
      venueClearingRef: "wp250-venue-clearing",
      attributionClearingRef: "wp250-attribution-clearing",
      feeExpenseRef: "wp250-fee-expense",
      startingCash: STARTING_CASH,
    },
    queues: { ingestMaximumDepth: 1024, outboxMaximumDepth: 1024 },
    features: {
      depthLevels: [1, 2, 5],
      executableShares: [ENTRY_SHARES],
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
      feeSchedule: {
        snapshotVersion: fees.snapshotVersion,
        takerFeeRate: fees.takerFeeRate,
        makerFeeRate: fees.makerFeeRate,
        roundingDecimalPlaces: fees.roundingDecimalPlaces,
        roundingMode: fees.roundingMode,
        minimumChargedFee: fees.minimumChargedFee,
        feeCurrency: fees.feeCurrency,
      },
      startingCash: STARTING_CASH,
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
      consumerId: "wp250-e2e",
      receiveBatchSize: 128,
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
        // TRUE about THIS market: it is the simulated market this file
        // specifies in full, including its resolution event. See the header.
        settlementReadiness: { modelDependentActivationAllowed: true },
        openTime: T_OPEN,
        closeTime: T_CLOSE,
        seriesKey: SERIES_KEY,
        underlyingKey: UNDERLYING_KEY,
        resolutionWindowKey: RESOLUTION_WINDOW_KEY,
      },
    ],
    instances: options.withShadow === true ? [owner, shadow] : [owner],
  };
}

// ---------------------------------------------------------------------------
// The recorded event sequence
// ---------------------------------------------------------------------------

/** Mints the scenario's event ids from an ordinal. No entropy anywhere. */
function eventId(ordinal: number): string {
  return `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`;
}

/**
 * One recorded event, before it is given its identity. Exported (`BRACKET-1b`)
 * so a second scenario mints its events through {@link recordedEventsOf}, the
 * same function — and therefore the same identity scheme — as this one.
 */
export interface Recorded {
  readonly eventType: string;
  readonly payload: unknown;
  readonly receivedAt: string;
  readonly source?: "polymarket" | "binance";
}

/**
 * The recorded events, in publication order.
 *
 * `ingestSeq` is the array position plus one, and `receivedAt` is a literal, so
 * the same list produces the same identities on every run and across processes.
 *
 * The shape of the run:
 *
 * 1. two reference trades (the §9.5 reference feed has to be non-empty before
 *    the feature engine can produce a snapshot the strategy can act on);
 * 2. `MarketOpened`;
 * 3. the YES book, then the NO book — the Static Bracket ARMS on the first
 *    evaluation and ENTERS on the second (the NO book's evaluation), so two
 *    book events are required before an entry can exist at all; the entry
 *    fills 30 + 20 at once and its take-profit is placed from the first
 *    `onFill`;
 * 4. a level change that leaves the ladder intact — the evaluation on which the
 *    take-profit, sized to the first fill, is cancelled to be re-sized to the
 *    grown allocation;
 * 5. the YES book refreshed INSIDE `exit_cutoff_before_close_seconds` (see its
 *    own note below): the evaluation on which the strategy's `final_policy:
 *    PROTECTED_REDUCE` emits the protective reduction. The risk seam APPROVES it
 *    (`RISK-2`; it used to classify it `ENTRY` and refuse it), it fills against
 *    the bid, and — since `BRACKET-1a` gave the reduction its own order track —
 *    its fill closes the bracket (`SB.EXIT_FILLED`, `SB.CLOSED`) where it used
 *    to leave the instance PAUSED (`RISK-2` residual 5);
 * 6. `MarketClosing`, to which the CLOSED bracket answers its reentry limit of
 *    1 (`SB.REFUSED_MAXIMUM_ENTRIES`).
 */
const RECORDED: readonly Recorded[] = Object.freeze([
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
      bids: YES_BIDS.map((level) => ({ price: level.price, size: level.size })),
      asks: YES_ASKS.map((level) => ({ price: level.price, size: level.size })),
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
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      side: "BID",
      price: "0.31",
      size: "250",
    },
    receivedAt: "2026-05-01T09:00:03.000Z",
  },
  {
    // The book, refreshed just before the close. WITHOUT this event the book is
    // ~15 minutes old by `MarketClosing` and the strategy's own
    // `data_quality.on_stale_book: PAUSE_AND_CANCEL` fires first — a real
    // behaviour, but one that would MASK the `final_policy: PROTECTED_REDUCE`
    // path this scenario exists to observe. A live feed publishes a book far
    // more often than once per market; the scenario says so explicitly rather
    // than leaving the staleness to be discovered as an accident.
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      bids: YES_BIDS.map((level) => ({ price: level.price, size: level.size })),
      asks: [{ price: "0.36", size: "40" }],
    },
    receivedAt: "2026-05-01T09:14:49.000Z",
  },
  {
    eventType: "MarketClosing",
    payload: { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, closesAt: T_CLOSE },
    receivedAt: "2026-05-01T09:14:50.000Z",
  },
]);

/** Builds one §7.1 envelope plus the recorded identity the venue anchors to. */
function ingested(recorded: Recorded, ordinal: number): IngestedEvent {
  const identity: RecordedEventIdentity = {
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ordinal),
    receivedAt: recorded.receivedAt,
    datasetRowOrdinal: ordinal,
  };
  const envelope: EventEnvelope<unknown> = {
    eventId: eventId(ordinal),
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
  return { envelope, identity };
}

/**
 * Any recorded list's events: `ingestSeq` is the array position plus one, and
 * the identity is a pure function of that ordinal and the literal instant.
 */
export function recordedEventsOf(list: readonly Recorded[]): readonly IngestedEvent[] {
  return Object.freeze(list.map((recorded, index) => ingested(recorded, index + 1)));
}

/** The scenario's events. A pure function of module constants. */
export function recordedEvents(): readonly IngestedEvent[] {
  return recordedEventsOf(RECORDED);
}

// ---------------------------------------------------------------------------
// The scenario, as the harness, the capture and the golden take it
// ---------------------------------------------------------------------------

/**
 * THIS scenario as a {@link Scenario} value (`BRACKET-1b`, E1): every field is
 * one of the constants or functions above, unchanged, so a run driven by it is
 * the run this module always described, and the committed
 * `paper-e2e-run.json` is its golden. It is the default everywhere a scenario
 * can be passed.
 */
export const PAPER_E2E_SCENARIO: Scenario = Object.freeze({
  name: "paper-e2e",
  idNamespace: ID_NAMESPACE,
  clockStart: T_OPEN,
  constants: Object.freeze({
    marketId: MARKET_ID,
    yesTokenId: YES_TOKEN,
    noTokenId: NO_TOKEN,
    instanceId: INSTANCE_ID,
    runId: RUN_ID,
    accountRef: ACCOUNT_REF,
    denominationAssetId: DENOMINATION_ASSET_ID,
    startingCash: STARTING_CASH,
    entryShares: ENTRY_SHARES,
    triggerPriceLte: TRIGGER_PRICE_LTE,
    maximumBuyPrice: MAXIMUM_BUY_PRICE,
    maximumTotalCost: MAXIMUM_TOTAL_COST,
    takeProfitPrice: TAKE_PROFIT_PRICE,
    entryFeePerShare: ENTRY_FEE_PER_SHARE,
    exitFeePerShare: EXIT_FEE_PER_SHARE,
  }),
  feeSnapshot,
  traderConfig,
  events: recordedEvents,
  goldenFile: "paper-e2e-run.json",
});
