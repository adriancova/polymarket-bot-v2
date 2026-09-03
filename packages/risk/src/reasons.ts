/**
 * Structured reason codes — WP-180 deliverable "structured reason codes".
 *
 * PACKAGE-OWNED VOCABULARY. Every rejection, approval, and recommendation this
 * package emits carries codes from this union — typed, stable, and
 * machine-readable. Codes follow the frozen `CodeString` grammar
 * (`docs/contracts/domain.md` §7: `^[A-Za-z][A-Za-z0-9_.:-]*$`, ≤ 64 chars) so
 * they are safe as metric labels (handoff §14.3 labels metrics by reason
 * code). Adding a code is additive; changing the meaning of one is not,
 * because operators alert on them. The full vocabulary with meanings is
 * documented in this package's `README.md` and enumerated at runtime as
 * {@link RISK_REASON_CODES} so a consumer can validate a persisted code
 * against the vocabulary of the version that wrote it.
 *
 * Grouping mirrors the handoff §9.8 pre-trade check list (cheapest first).
 */

/** Every reason code this package can emit. */
export const RISK_REASON_CODES = [
  // --- input validation (before any check runs) ----------------------------
  "RISK_INPUT_INVALID",
  "RISK_UUID_NOT_CANONICAL",
  "RISK_INTENT_EXPIRED",
  "RISK_ZERO_DELTA",
  "RISK_MARKET_CONTEXT_MISSING",

  // --- check 1: run and strategy state -------------------------------------
  "RISK_RUN_STATE_BLOCKS",
  "RISK_STRATEGY_STATE_BLOCKS",

  // --- check 2: run mode within process maximum -----------------------------
  "RISK_RUN_MODE_EXCEEDS_MAXIMUM",

  // --- check 3: real-order enablement and fencing ---------------------------
  "RISK_REAL_ORDER_SURFACE_UNSUPPORTED",

  // --- check 4: venue geographic eligibility --------------------------------
  "RISK_VENUE_ELIGIBILITY_UNVERIFIED",

  // --- check 5: market active and accepting orders --------------------------
  "RISK_MARKET_NOT_ACCEPTING",
  "RISK_MARKET_STATUS_UNKNOWN",
  "RISK_MARKET_CLOSE_ONLY",

  // --- check 6: settlement spec verified ------------------------------------
  "RISK_SETTLEMENT_UNVERIFIED",

  // --- check 7: required feeds fresh and healthy ----------------------------
  "RISK_FEATURES_STALE",
  "RISK_REFERENCE_FEED_STALE",
  "RISK_BOOK_STALE",
  "RISK_FRESHNESS_UNKNOWN",
  "RISK_BOOK_STALE_NO_BLIND_REDUCTION",

  // --- check 8: book synchronized -------------------------------------------
  "RISK_BOOK_NOT_SYNCHRONIZED",

  // --- check 9: trading parameters known ------------------------------------
  "RISK_TRADING_PARAMETERS_UNKNOWN",

  // --- check 10: price tick and bounds --------------------------------------
  "RISK_PRICE_NOT_TICK_CONFORMANT",

  // --- check 11: minimum size and economic floor ----------------------------
  "RISK_SIZE_BELOW_MINIMUM",
  "RISK_NOTIONAL_BELOW_ECONOMIC_FLOOR",

  // --- check 12: expected net edge ------------------------------------------
  "RISK_NET_EDGE_NOT_POSITIVE",
  "RISK_EDGE_INPUTS_MISSING",

  // --- check 13: participation limits ---------------------------------------
  "RISK_PARTICIPATION_LIMIT_EXCEEDED",

  // --- check 14: balance / allowance / inventory / reservations -------------
  "RISK_ALLOCATION_REFUSED",
  "RISK_ALLOCATION_VERDICT_MISSING",
  "RISK_SELL_EXCEEDS_INVENTORY",
  "RISK_QUOTE_MAX_INVENTORY_EXCEEDED",

  // --- check 15: per-order / per-scope / global limits ----------------------
  "RISK_PER_ORDER_NOTIONAL_EXCEEDED",
  "RISK_GLOBAL_EXPOSURE_EXCEEDED",
  "RISK_INSTANCE_EXPOSURE_EXCEEDED",
  "RISK_MARKET_EXPOSURE_EXCEEDED",
  "RISK_SERIES_EXPOSURE_EXCEEDED",
  "RISK_UNDERLYING_EXPOSURE_EXCEEDED",
  "RISK_RESOLUTION_WINDOW_EXPOSURE_EXCEEDED",
  "RISK_EXPOSURE_SNAPSHOT_MISSING",
  "RISK_EXPOSURE_ENTRY_MISSING",
  "RISK_SCOPE_KEY_MISSING",

  // --- check 16: worst-case contractual loss (PRIMARY) ----------------------
  "RISK_WORST_CASE_LOSS_EXCEEDED",
  "RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED",
  "RISK_WORST_CASE_UNBOUNDED",
  "RISK_BASKET_LEG_UNBOUNDED",

  // --- check 17: scenario loss ----------------------------------------------
  "RISK_SCENARIO_LOSS_EXCEEDED",
  "RISK_SCENARIO_MISSING",
  "RISK_SCENARIO_MARKS_INCOMPLETE",

  // --- check 18: self-trade and duplicate-intent guards ---------------------
  "RISK_DUPLICATE_INTENT",
  "RISK_SELF_TRADE",

  // --- check 19: rate-limit headroom ----------------------------------------
  "RISK_RATE_LIMIT_HEADROOM_INSUFFICIENT",
  "RISK_RATE_LIMIT_UNKNOWN",

  // --- check 20: time-to-close policy ---------------------------------------
  "RISK_TIME_TO_CLOSE_ENTRY_BLOCKED",
  "RISK_TIME_TO_CLOSE_UNKNOWN",

  // --- reductions and unknown state (§6 invariants 10 and 12) ---------------
  "RISK_POSITION_STATE_UNKNOWN",

  // --- approvals (visibility codes; an approval also states WHY) ------------
  "RISK_APPROVED",
  "RISK_CANCEL_ALWAYS_PERMITTED",
  "RISK_EXIT_CAPACITY_CHECKS_INAPPLICABLE",

  // --- resize (creates a NEW approved-intent record; §7.7) ------------------
  "RISK_RESIZE_NOT_A_REDUCTION",
  "RISK_RESIZE_ID_REUSED",
  "RISK_RESIZE_UNSUPPORTED_TYPE",
  "RISK_RESIZE_INCOHERENT",
] as const;

export type RiskReasonCode = (typeof RISK_REASON_CODES)[number];

/**
 * The published cardinality of {@link RISK_REASON_CODES}.
 *
 * Pinned as a constant, and asserted against the list in
 * `test/unit/risk/engine.test.ts`, because the documented count drifted from
 * the real vocabulary once already (review round 1, MEDIUM: the handoff claimed
 * 56 against a 61-entry list). The count appears in `README.md` §5 and in
 * `docs/handoffs/WP-180.md`; changing the list without changing all three fails
 * the suite, which is the point.
 */
export const RISK_REASON_CODE_COUNT = 62;

const CODE_SET: ReadonlySet<string> = new Set(RISK_REASON_CODES);

/** True when `code` belongs to this package's vocabulary. */
export function isRiskReasonCode(code: string): code is RiskReasonCode {
  return CODE_SET.has(code);
}

/**
 * The PRIMARY risk measures' codes (§9.8: "maximum contractual loss" and
 * "worst-case resolution PnL" head the primary measures; "Model-derived
 * delta/gamma are secondary analytics, not the primary hard limit"; workplan
 * WP-180 acceptance 2).
 *
 * Enumerated rather than left to a naming convention so a consumer — a metric
 * dashboard, an alert rule, an incident triage view — can separate "the primary
 * hard limit refused this" from "a secondary check refused this" without
 * pattern-matching on strings. `RISK_WORST_CASE_UNBOUNDED` belongs here because
 * an unbounded intent fails the primary limit by being unmeasurable against it,
 * which is the same class of refusal as exceeding it.
 */
export const PRIMARY_RISK_REASON_CODES = [
  "RISK_WORST_CASE_LOSS_EXCEEDED",
  "RISK_WORST_CASE_RESOLUTION_LOSS_EXCEEDED",
  "RISK_WORST_CASE_UNBOUNDED",
  "RISK_BASKET_LEG_UNBOUNDED",
] as const satisfies readonly RiskReasonCode[];

export type PrimaryRiskReasonCode = (typeof PRIMARY_RISK_REASON_CODES)[number];

const PRIMARY_CODE_SET: ReadonlySet<string> = new Set(PRIMARY_RISK_REASON_CODES);

/** True when `code` names a PRIMARY (worst-case contractual loss) refusal. */
export function isPrimaryRiskReasonCode(code: string): code is PrimaryRiskReasonCode {
  return PRIMARY_CODE_SET.has(code);
}
