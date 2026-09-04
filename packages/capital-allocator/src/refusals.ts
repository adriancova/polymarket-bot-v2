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

import { describeValue, ownDataDetails, readPlainData } from "./plain-data.js";

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
  /** A real-order-mode commitment exceeds the live-micro per-order notional cap (always "0"). */
  | "CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED"
  /** A real-order-mode commitment exceeds the live-micro account exposure cap (always "0"). */
  | "CAPITAL_LIVE_MICRO_EXPOSURE_EXCEEDED"
  /**
   * A caller supplied a live-micro cap other than the exact `"0"` floor.
   * `AGENTS.md` declares `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and
   * `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` NON-WEAKENABLE, so raising them is not
   * a caller argument to this package. Review round 1 (HIGH): the caps merely
   * DEFAULTED to `"0"` and accepted any caller-supplied value, which made this
   * package a weakening vector. Enabling live-micro capacity is a separate,
   * explicitly authorized, fenced later-phase work package — never an argument.
   */
  | "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED";

/**
 * Every code above, enumerated at runtime.
 *
 * The union is the contract; this list makes it inspectable by a consumer that
 * has only values (a metric dashboard, an alert rule, a persisted refusal from
 * an older version). {@link CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE} is a
 * compile-time proof that the list covers the union, so a code added to the
 * union without being added here is a type error rather than a silent gap.
 */
export const CAPITAL_REFUSAL_CODES = [
  "CAPITAL_INPUT_INVALID",
  "CAPITAL_UUID_NOT_CANONICAL",
  "CAPITAL_DUPLICATE_IDENTIFIER",
  "CAPITAL_UNKNOWN_RESERVATION",
  "CAPITAL_OVERSELL_UNBACKED",
  "CAPITAL_COLLATERAL_INSUFFICIENT",
  "CAPITAL_INVENTORY_INSUFFICIENT",
  "CAPITAL_GLOBAL_CAP_EXCEEDED",
  "CAPITAL_STRATEGY_CAP_EXCEEDED",
  "CAPITAL_MARKET_CAP_EXCEEDED",
  "CAPITAL_SERIES_CAP_EXCEEDED",
  "CAPITAL_UNDERLYING_CAP_EXCEEDED",
  "CAPITAL_RESOLUTION_WINDOW_CAP_EXCEEDED",
  "CAPITAL_SCOPE_KEY_MISSING",
  "CAPITAL_LIVE_OWNERSHIP_CONFLICT",
  "CAPITAL_LIVE_OWNERSHIP_MISSING",
  "CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED",
  "CAPITAL_LIVE_MICRO_EXPOSURE_EXCEEDED",
  "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
] as const satisfies readonly CapitalRefusalCode[];

/**
 * The published cardinality of {@link CAPITAL_REFUSAL_CODES}, asserted in
 * `packages/capital-allocator/src/allocator.test.ts` and stated in
 * `README.md` §5. Pinned because a documented count drifted from the real
 * vocabulary once already (review round 1, MEDIUM).
 */
export const CAPITAL_REFUSAL_CODE_COUNT = 19;

/**
 * Compile-time proof that {@link CAPITAL_REFUSAL_CODES} covers the whole
 * union. If a code is added to `CapitalRefusalCode` and not to the list, the
 * gap type stops being `never` and this declaration fails to compile.
 */
export const CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE: Exclude<
  CapitalRefusalCode,
  (typeof CAPITAL_REFUSAL_CODES)[number]
> extends never
  ? true
  : ["codes missing from CAPITAL_REFUSAL_CODES"] = true;

const CAPITAL_CODE_SET: ReadonlySet<string> = new Set(CAPITAL_REFUSAL_CODES);

/** True when `code` belongs to this package's vocabulary. */
export function isCapitalRefusalCode(code: string): code is CapitalRefusalCode {
  return CAPITAL_CODE_SET.has(code);
}

export type CapitalRefusalDetails = Readonly<Record<string, unknown>>;

/** One refusal, with its evidence. */
export interface CapitalRefusal {
  readonly code: CapitalRefusalCode;
  /** Bounded human-readable text; never parsed. */
  readonly message: string;
  /** The offending value(s), preserved so an incident carries its evidence. */
  readonly details: CapitalRefusalDetails;
}

/**
 * Builds a refusal. Kept as a function so every refusal has the same shape.
 *
 * TOTAL FOR ANY `details` (review round 6, BLOCKER 3), for the same reason and
 * by the same mechanism as `@polymarket-bot/risk`'s `riskRefusal`: a spread of
 * a caller-supplied object runs its traps and getters, so the refusal
 * constructor itself could throw. See {@link ownDataDetails}.
 */
export function capitalRefusal(
  code: CapitalRefusalCode,
  message: string,
  details: CapitalRefusalDetails = {},
): CapitalRefusal {
  return Object.freeze({ code, message, details: ownDataDetails(details) });
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

/**
 * THE OUTER CONTAINMENT GUARD (review round 5, BLOCKER 3).
 *
 * Every public entry point of this package promises a typed result, and review
 * round 5 showed one that did not keep the promise: `parseAllocatorCaps` on a
 * valid-SHAPED object whose `globalAccountCap` was a throwing getter threw
 * `Error("caps-getter")` out of the call, because `zod` reads properties and a
 * getter is caller code.
 *
 * The site fix is to read the input as data before parsing it
 * (`plain-data.ts`). This is the structural half: whatever happens inside,
 * the caller gets a refusal. `onThrow` supplies its shape, since this package
 * has both `CapitalResult` and the `ReservationVerdict` arms.
 *
 * The refusal carries only the thrown value's TYPE, never its message and never
 * a coercion of it — reading `.message` off a caller-supplied thrown object is
 * one more place caller code can run. A genuine bug in this package therefore
 * becomes a typed refusal rather than a crash: a real loss of signal, accepted
 * because commitment accounting gates order placement, and a caller who
 * receives an exception where the contract promises a refusal has no defined
 * behaviour at all.
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
 * THE DOOR IN FRONT OF EVERY SCHEMA in this package (review round 5, BLOCKER
 * 3). `safeParse` is a validator, not a safe way to LOOK at a caller's object:
 * it reads properties, so a getter runs and a `Proxy` trap runs. `readPlainData`
 * takes the value apart with descriptors, refuses what is not data, and hands
 * the schema a materialized snapshot instead of the caller's object.
 *
 * `what` names the value in the refusal message ("allocator caps"), and `path`
 * roots the per-problem paths ("caps.globalAccountCap: an accessor property…").
 */
export function readInputAsData(
  value: unknown,
  path: string,
  what: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly refusal: CapitalRefusal } {
  const read = readPlainData(value, path);
  if (read.ok) return { ok: true, value: read.value };
  return {
    ok: false,
    refusal: capitalRefusal(
      "CAPITAL_INPUT_INVALID",
      `the ${what} is not a data record: an input is a finite tree of plain own data, so hidden, inherited, computed or unreadable state is refused rather than inspected (fail closed)`,
      { issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`) },
    ),
  };
}
