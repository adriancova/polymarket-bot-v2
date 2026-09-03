/**
 * Typed refusals (handoff §21: "Errors are typed and observable").
 *
 * A refusal is DATA, following the established repository pattern
 * (`@polymarket-bot/settlement`, `@polymarket-bot/universe`,
 * `@polymarket-bot/order-book`): the allocator answers "no" by returning the
 * reason, carrying the evidence, so the composition root can record an
 * incident with the offending value attached. Nothing here logs, throws for a
 * recoverable condition, or silently tolerates a value the contract forbids.
 *
 * Codes are stable `CodeString`-shaped identifiers (§14.3 labels metrics by
 * reason code). The vocabulary is PACKAGE-OWNED: adding a code is additive;
 * changing the meaning of one is not, because operators alert on them. The
 * full vocabulary is documented in this package's `README.md`.
 */

/** Why an allocator construction, reservation, or transition was refused. */
export type CapitalRefusalCode =
  // --- input validation -----------------------------------------------------
  /** The input failed its schema (shape, decimal grammar, id grammar). */
  | "CAPITAL_INPUT_INVALID"
  /**
   * A UUID-shaped identifier arrived in a non-canonical (non-lowercase)
   * spelling. ADR-016 §2 (2026-09-02 amendment): REFUSE, never case-fold. The
   * raw value rides on the refusal so the caller's defect is diagnosable.
   */
  | "CAPITAL_UUID_NOT_CANONICAL"
  /** Two positions, open orders, or reservations share an identifier. */
  | "CAPITAL_DUPLICATE_IDENTIFIER"
  /** The named reservation does not exist in this state. */
  | "CAPITAL_UNKNOWN_RESERVATION"

  // --- conservation ---------------------------------------------------------
  /**
   * Open sell orders reserve more outcome tokens than the account holds
   * (§9.14 "Prevent double reservation" — a state that oversells cannot be
   * constructed).
   */
  | "CAPITAL_OVERSELL_UNBACKED"

  // --- capacity -------------------------------------------------------------
  /** A buy commitment exceeds available (unreserved) pUSD. */
  | "CAPITAL_COLLATERAL_INSUFFICIENT"
  /** A sell reservation exceeds the instance's unreserved holdings. */
  | "CAPITAL_INVENTORY_INSUFFICIENT"

  // --- caps (§9.7: global account cap, per-strategy cap, live-micro cap; ----
  // --- scope caps per the §9.7 commitment list) -----------------------------
  | "CAPITAL_GLOBAL_CAP_EXCEEDED"
  | "CAPITAL_STRATEGY_CAP_EXCEEDED"
  | "CAPITAL_MARKET_CAP_EXCEEDED"
  | "CAPITAL_SERIES_CAP_EXCEEDED"
  | "CAPITAL_UNDERLYING_CAP_EXCEEDED"
  | "CAPITAL_RESOLUTION_WINDOW_CAP_EXCEEDED"
  /**
   * A cap is configured for a scope dimension the request cannot be
   * attributed to (no series/underlying/window key supplied). Fail closed:
   * an unattributable request cannot be proven within the cap.
   */
  | "CAPITAL_SCOPE_KEY_MISSING"

  // --- live ownership (§9.7 v1; ADR-011) ------------------------------------
  /** Another strategy instance is the live owner of this market. */
  | "CAPITAL_LIVE_OWNERSHIP_CONFLICT"
  /** No live owner is recorded for this market; a live commitment needs one. */
  | "CAPITAL_LIVE_OWNERSHIP_MISSING"

  // --- real-order modes (safety §0.2; workplan defaults) --------------------
  /** A real-order-mode commitment exceeds the live-micro per-order notional cap (default "0"). */
  | "CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED"
  /** A real-order-mode commitment exceeds the live-micro account exposure cap (default "0"). */
  | "CAPITAL_LIVE_MICRO_EXPOSURE_EXCEEDED";

export type CapitalRefusalDetails = Readonly<Record<string, unknown>>;

/** One refusal, with its evidence. */
export interface CapitalRefusal {
  readonly code: CapitalRefusalCode;
  /** Bounded human-readable text; never parsed. */
  readonly message: string;
  /** The offending value(s), preserved so an incident carries its evidence. */
  readonly details: CapitalRefusalDetails;
}

/** Builds a refusal. Kept as a function so every refusal has the same shape. */
export function capitalRefusal(
  code: CapitalRefusalCode,
  message: string,
  details: CapitalRefusalDetails = {},
): CapitalRefusal {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

/** A successful result, or the refusals that prevented it. */
export type CapitalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: readonly CapitalRefusal[] };

export function capitalOk<T>(value: T): CapitalResult<T> {
  return { ok: true, value };
}

export function capitalFailure<T>(
  ...refusals: readonly CapitalRefusal[]
): CapitalResult<T> {
  return { ok: false, refusals: Object.freeze([...refusals]) };
}
