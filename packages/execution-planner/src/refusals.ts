/**
 * Typed refusals (handoff §21: "Errors are typed and observable").
 *
 * A refusal is DATA, following the established repository pattern
 * (`@polymarket-bot/risk`, `@polymarket-bot/capital-allocator`,
 * `@polymarket-bot/settlement`): the planner answers "no" by returning the
 * reason with its evidence. Nothing here logs, throws for a recoverable
 * condition, or silently tolerates a value the contract forbids — and nothing
 * ever CONVERTS a refusal into a plan, cancel or otherwise (§6 invariant 13
 * forbids trapping a valid cancel behind unrelated refusals; it does not
 * license manufacturing a cancel out of garbage).
 *
 * Codes are stable `CodeString`-shaped identifiers (§14.3 labels metrics by
 * reason code). The vocabulary is PACKAGE-OWNED and documented in `README.md`.
 */

import { describeValue, ownDataDetails, readPlainData } from "./plain-data.js";

/** Why a plan could not be built or sealed. */
export type PlannerRefusalCode =
  // --- input validation -----------------------------------------------------
  /** The planning inputs failed validation (shape, decimal grammar, instants). */
  | "PLAN_INPUT_INVALID"
  /** The approved-intent record failed validation for the fields the planner consumes. */
  | "PLAN_RECORD_INVALID"
  /**
   * A UUID-shaped identifier arrived in a non-canonical (non-lowercase)
   * spelling. ADR-016 §2: REFUSE, never case-fold.
   */
  | "PLAN_UUID_NOT_CANONICAL"
  /** No per-market planning input covers a market the intent trades. */
  | "PLAN_MARKET_INPUT_MISSING"
  /** A supplied book price is off the market's tick grid or the book is crossed. */
  | "PLAN_BOOK_INVALID"

  // --- intent applicability -------------------------------------------------
  /** The intent's `validUntil` is not after `plannedAt`; a dead intent plans nothing. */
  | "PLAN_INTENT_EXPIRED"
  /**
   * §7.7's `QuoteLevel` names no outcome token, so a quote cannot become
   * venue orders without this package INVENTING which token is quoted —
   * recorded domain gap (WP-180 `follow_up` 1; a domain ADR owns the fix).
   */
  | "PLAN_QUOTE_UNSUPPORTED"
  /** The intent resolves to zero executable shares (nothing to do). */
  | "PLAN_NOTHING_TO_EXECUTE"

  // --- price protection (workplan acceptance 2) -------------------------------
  /** No price bound is derivable for a leg; an unprotected order is never planned. */
  | "PLAN_PRICE_PROTECTION_UNAVAILABLE"
  /** A computed or supplied limit price falls outside the open interval (0, 1). */
  | "PLAN_PRICE_OUT_OF_RANGE"

  // --- inventory and collateral (workplan acceptance 1) -----------------------
  /** A sell leg exceeds the instance's ACTUAL unreserved holdings. */
  | "PLAN_INVENTORY_INSUFFICIENT"
  /** A buy leg's worst-case cost exceeds available (unreserved) collateral. */
  | "PLAN_COLLATERAL_INSUFFICIENT"
  /** The plan's worst-case cost exceeds the intent's own `maximumTotalCost` ceiling. */
  | "PLAN_EXCEEDS_MAXIMUM_TOTAL_COST"

  // --- sizing ----------------------------------------------------------------
  /** The executable size is below the market's minimum order size. */
  | "PLAN_BELOW_MINIMUM_ORDER_SIZE"
  /** The slicing policy cannot produce venue-acceptable slices for this market. */
  | "PLAN_SLICING_INCOHERENT"

  // --- coordinated baskets (workplan acceptance 3; §9.10) ---------------------
  /** A buying basket leg carries no price ceiling and no book to derive one from. */
  | "PLAN_BASKET_LEG_UNBOUNDED"
  /** A basket leg's worst-case cost exceeds the intent's own `legRiskLimit`. */
  | "PLAN_BASKET_LEG_RISK_EXCEEDED"
  /** The basket's combined worst-case cost exceeds `maximumCombinedCost`. */
  | "PLAN_BASKET_COMBINED_COST_EXCEEDED"
  /**
   * A draft labeled a coordinated basket "ATOMIC". §7.7: "Basket execution is
   * coordinated, not assumed atomic" — the label is a lie about venue
   * behaviour, so it is refused BY NAME rather than folded into a shape error.
   */
  | "PLAN_ATOMIC_LABEL_FORBIDDEN"

  // --- the emission boundary --------------------------------------------------
  /** The draft handed to the seal does not satisfy the execution-plan contract. */
  | "PLAN_SEAL_INVALID";

/**
 * Every code above, enumerated at runtime. The union is the contract; this
 * list makes it inspectable by a consumer that has only values.
 * {@link PLANNER_REFUSAL_CODES_ARE_EXHAUSTIVE} is a compile-time proof that
 * the list covers the union.
 */
export const PLANNER_REFUSAL_CODES = [
  "PLAN_INPUT_INVALID",
  "PLAN_RECORD_INVALID",
  "PLAN_UUID_NOT_CANONICAL",
  "PLAN_MARKET_INPUT_MISSING",
  "PLAN_BOOK_INVALID",
  "PLAN_INTENT_EXPIRED",
  "PLAN_QUOTE_UNSUPPORTED",
  "PLAN_NOTHING_TO_EXECUTE",
  "PLAN_PRICE_PROTECTION_UNAVAILABLE",
  "PLAN_PRICE_OUT_OF_RANGE",
  "PLAN_INVENTORY_INSUFFICIENT",
  "PLAN_COLLATERAL_INSUFFICIENT",
  "PLAN_EXCEEDS_MAXIMUM_TOTAL_COST",
  "PLAN_BELOW_MINIMUM_ORDER_SIZE",
  "PLAN_SLICING_INCOHERENT",
  "PLAN_BASKET_LEG_UNBOUNDED",
  "PLAN_BASKET_LEG_RISK_EXCEEDED",
  "PLAN_BASKET_COMBINED_COST_EXCEEDED",
  "PLAN_ATOMIC_LABEL_FORBIDDEN",
  "PLAN_SEAL_INVALID",
] as const satisfies readonly PlannerRefusalCode[];

/** The published cardinality of {@link PLANNER_REFUSAL_CODES}. */
export const PLANNER_REFUSAL_CODE_COUNT = 20;

/**
 * Compile-time proof that {@link PLANNER_REFUSAL_CODES} covers the whole
 * union: a code added to `PlannerRefusalCode` but not to the list makes the
 * gap type stop being `never` and this declaration fails to compile.
 */
export const PLANNER_REFUSAL_CODES_ARE_EXHAUSTIVE: Exclude<
  PlannerRefusalCode,
  (typeof PLANNER_REFUSAL_CODES)[number]
> extends never
  ? true
  : ["codes missing from PLANNER_REFUSAL_CODES"] = true;

const PLANNER_CODE_SET: ReadonlySet<string> = new Set(PLANNER_REFUSAL_CODES);

/** True when `code` belongs to this package's vocabulary. */
export function isPlannerRefusalCode(code: string): code is PlannerRefusalCode {
  return PLANNER_CODE_SET.has(code);
}

export type PlannerRefusalDetails = Readonly<Record<string, unknown>>;

/** One refusal, with its evidence. */
export interface PlannerRefusal {
  readonly code: PlannerRefusalCode;
  /** Bounded human-readable text; never parsed. */
  readonly message: string;
  /** The offending value(s), preserved so an incident carries its evidence. */
  readonly details: PlannerRefusalDetails;
}

/**
 * Builds a refusal. TOTAL FOR ANY `details` (WP-180 round 6, BLOCKER 3): a
 * spread of a caller-supplied object runs its traps and getters, so the
 * refusal constructor itself could throw. `ownDataDetails` copies the evidence
 * as own data and COUNTS what it cannot copy rather than dropping it silently.
 */
export function plannerRefusal(
  code: PlannerRefusalCode,
  message: string,
  details: PlannerRefusalDetails = {},
): PlannerRefusal {
  return Object.freeze({ code, message, details: ownDataDetails(details) });
}

/** A successful result, or the refusals that prevented it. */
export type PlannerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: readonly PlannerRefusal[] };

export function plannerOk<T>(value: T): PlannerResult<T> {
  return { ok: true, value };
}

export function plannerFailure<T>(
  ...refusals: readonly PlannerRefusal[]
): PlannerResult<T> {
  return { ok: false, refusals: Object.freeze([...refusals]) };
}

/**
 * THE OUTER CONTAINMENT GUARD (WP-180 round 5 precedent).
 *
 * Every public entry point of this package promises a typed result; whatever
 * happens inside, the caller gets a refusal rather than an exception. The
 * refusal carries only the thrown value's TYPE — never its message and never a
 * coercion of it, because reading `.message` off a caller-supplied thrown
 * object is one more place caller code can run. A genuine bug here becomes a
 * typed refusal rather than a crash: a real loss of signal, accepted because a
 * caller that receives an exception where the contract promises a refusal has
 * no defined behaviour at all.
 */
export function contained<T>(body: () => T, onThrow: (thrown: string) => T): T {
  try {
    return body();
  } catch (error) {
    return onThrow(describeValue(error));
  }
}

/**
 * Reads a caller-supplied `unknown` into plain own data, or refuses.
 *
 * THE DOOR IN FRONT OF EVERY SCHEMA AND EVERY WALK in this package: `safeParse`
 * is a validator, not a safe way to LOOK at a caller's object — it reads
 * properties, so a getter runs and a `Proxy` trap runs. `readPlainData` takes
 * the value apart with descriptors, refuses what is not data, and hands
 * everything downstream a materialized prototype-free snapshot instead of the
 * caller's object.
 */
export function readInputAsData(
  value: unknown,
  path: string,
  what: string,
  code: "PLAN_INPUT_INVALID" | "PLAN_RECORD_INVALID" = "PLAN_INPUT_INVALID",
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly refusal: PlannerRefusal } {
  const read = readPlainData(value, path);
  if (read.ok) return { ok: true, value: read.value };
  return {
    ok: false,
    refusal: plannerRefusal(
      code,
      `the ${what} is not a data record: an input is a finite tree of plain own data, so hidden, inherited, computed or unreadable state is refused rather than inspected (fail closed)`,
      { issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`) },
    ),
  };
}
