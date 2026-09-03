/**
 * Read-only view contracts a strategy may see (handoff §7.6; ADR-005 §6).
 *
 * ADR-005 §6 ratifies that these view types are owned by WP-170, not by the
 * frozen `packages/domain`: they are interfaces over live runtime state whose
 * producing components (book, feature engine, allocator, risk engine) arrive
 * with their own work packages. Each interface here is deliberately NARROW —
 * the minimum a strategy needs to reason — because every field is a contract
 * the composition root must populate and every widening is a reviewable SDK
 * change. Nothing here imports a sibling Wave-2 package; only frozen domain
 * shapes are referenced (task-packet rule for WP-170).
 *
 * Purity: these are declarations only. No method performs I/O (§7.6), no
 * field is a function, and the runtime hands instances out deep-frozen.
 * Economic values are canonical decimal strings (§6 invariant 1); a
 * JavaScript `number` appears only for non-economic integers.
 */

import type {
  DecimalString,
  InternalMarketId,
  IsoTimestamp,
  ConditionId,
  MoneyString,
  OutcomeSide,
  PriceString,
  SharesString,
  TerminalMarketOutcomeState,
  TokenId,
  UnsignedBigIntString,
  Uuid,
} from "@polymarket-bot/domain";

/** One resting price level of a book view, best-first ordering by the runtime's caller. */
export interface BookLevelView {
  readonly price: PriceString;
  readonly shares: SharesString;
}

/**
 * §7.6 `MarketView` — identity plus the versioned trading parameters nearly
 * every strategy decision needs without a catalog round trip (§9.2).
 */
export interface MarketView {
  readonly marketId: InternalMarketId;
  readonly conditionId: ConditionId;
  readonly yesTokenId: TokenId;
  readonly noTokenId: TokenId;
  readonly tickSize: PriceString;
  readonly minimumOrderSize: SharesString;
  /** Scheduled open/close parameters where known (§9.2); absent when unknown. */
  readonly openTime?: IsoTimestamp;
  readonly closeTime?: IsoTimestamp;
}

/**
 * §7.6 `OrderBookView` — one outcome token's resting book as of `asOf`.
 * Levels are aggregates sorted best-first (bids descending, asks ascending).
 */
export interface OrderBookView {
  readonly bids: readonly BookLevelView[];
  readonly asks: readonly BookLevelView[];
  /** Logical time of the last applied book event for this token. */
  readonly asOf: IsoTimestamp;
}

/**
 * §7.6 `FeatureSnapshot` view — the immutable, content-addressed snapshot the
 * strategy saw (§9.5). `snapshotRef` is what a `DecisionResult` must echo as
 * `featureSnapshotRef`; the runtime refuses a decision that names any other
 * snapshot (§6 invariant 4 traceability).
 *
 * Values reuse the §7.5 model-output vocabulary: a numeric feature is a
 * canonical decimal string, never a JavaScript `number`.
 */
export interface FeatureSnapshot {
  readonly snapshotRef: string;
  readonly asOf: IsoTimestamp;
  readonly values: Readonly<Record<string, DecimalString | string | boolean | null>>;
}

/**
 * §7.6 `VirtualPositionView` — this instance's virtual allocation (§6
 * invariant 7: virtual attribution, not the actual account).
 */
export interface VirtualPositionView {
  readonly yesShares: SharesString;
  readonly noShares: SharesString;
  /** Signed net cost of the open virtual position, when the projector supplies it. */
  readonly netCost?: MoneyString;
  readonly asOf: IsoTimestamp;
}

/** Order lifecycle states a strategy can observe. Terminal: FILLED, CANCELED, REJECTED, EXPIRED. */
export type StrategyOrderStatus =
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

/**
 * §7.6 / §9.6 `StrategyOrderView` — one of this instance's own working orders.
 * Quantities are first-class partials (§6 invariant 10): `filledShares` is
 * confirmed fill quantity, never the requested size.
 */
export interface StrategyOrderView {
  readonly orderId: string;
  readonly marketId: InternalMarketId;
  readonly outcome: OutcomeSide;
  readonly side: "BUY" | "SELL";
  readonly price: PriceString;
  readonly requestedShares: SharesString;
  readonly filledShares: SharesString;
  readonly status: StrategyOrderStatus;
  readonly placedAt: IsoTimestamp;
}

/**
 * §9.6 `StrategyFill` — one confirmed fill delivered to `onFill`.
 * `shares` is the actual filled quantity of this fill event.
 */
export interface StrategyFill {
  readonly orderId: string;
  readonly marketId: InternalMarketId;
  readonly outcome: OutcomeSide;
  readonly side: "BUY" | "SELL";
  readonly price: PriceString;
  readonly shares: SharesString;
  readonly fee?: MoneyString;
  readonly filledAt: IsoTimestamp;
}

/**
 * §9.6 `ResolutionView` — a determined terminal outcome (§7.4 `MarketResolved`;
 * `DISPUTED`/`PENDING` are market state, never a resolution — domain contract
 * §6.2).
 */
export interface ResolutionView {
  readonly marketId: InternalMarketId;
  readonly outcome: TerminalMarketOutcomeState;
  readonly resolvedAt: IsoTimestamp;
}

/**
 * §7.6 `RiskBudgetView` — the headroom the allocator/risk layer exposes to the
 * strategy. All caps are non-negative money amounts; an absent optional cap
 * means "not constrained at this level", never "unknown".
 */
export interface RiskBudgetView {
  readonly availableCollateral: MoneyString;
  readonly remainingInstanceAllocation?: MoneyString;
  readonly remainingMarketExposure?: MoneyString;
  readonly asOf: IsoTimestamp;
}

/**
 * §7.1 information-arrival identity of the event that triggered an evaluation
 * (§8.4 replay ordering). Optional as a group: timer-driven evaluations have
 * no source event.
 */
export interface SourceEventRef {
  readonly eventId?: Uuid;
  readonly gatewayEpoch?: Uuid;
  readonly ingestSeq?: UnsignedBigIntString;
}
