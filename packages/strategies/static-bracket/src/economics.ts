/**
 * Exact-decimal economics for a pure strategy.
 *
 * §6 invariant 1: prices, sizes, costs and fees are canonical decimal strings
 * and are never JavaScript numbers. This module is the only place this package
 * touches economic arithmetic, and it exists to give the decision logic TOTAL
 * operations: `@polymarket-bot/decimal` throws on a non-canonical argument, and
 * a strategy callback that throws is contained by the runtime as a
 * RUNTIME-attributed skip that PAUSES the instance (ADR-005 §3). A malformed
 * price on a view must produce a recorded refusal, not a paused instance, so
 * every entry point here validates first and answers with an {@link Outcome}.
 *
 * DIVISION IS NEVER PERFORMED. Every economic quantity this strategy computes —
 * an entry cost, a fee, an expected net edge, a participation cap, an exit size
 * — is an exact addition, subtraction, multiplication or comparison. That is a
 * deliberate design property, not an accident: it means no rounding policy,
 * precision choice, or tie-breaking rule exists inside a trading decision, so
 * two runs of the same inputs cannot diverge on a rounding mode. The
 * proportional exit needs no division either, because §13.3's rule is that the
 * exit size EQUALS the actual allocated filled size.
 */

import {
  addDecimal,
  compareDecimal,
  explainHashableDecimalString,
  isCanonicalDecimalString,
  isTickConformant,
  mulDecimal,
  normalizeHashableDecimalString,
  subDecimal,
  type DecimalRange,
  type DecimalString,
} from "@polymarket-bot/decimal";

import { bad, describe, ok, type Outcome } from "./plain.js";

/** A canonical decimal string in `[0, 1]` (§7.3 price rule). */
export type Price = DecimalString;
/** A canonical non-negative decimal string of shares. */
export type Shares = DecimalString;
/** A canonical decimal string of money. */
export type Money = DecimalString;

export const ZERO = "0";
export const ONE = "1";

/** Total predicate: a canonical price in the unit interval. */
export function isPrice(value: unknown): value is Price {
  return isCanonicalDecimalString(value, { range: "UNIT_INTERVAL" });
}

/** Total predicate: a canonical non-negative decimal. */
export function isNonNegative(value: unknown): value is DecimalString {
  return isCanonicalDecimalString(value, { range: "NON_NEGATIVE" });
}

/** Total predicate: a canonical strictly positive decimal. */
export function isPositive(value: unknown): value is DecimalString {
  return isCanonicalDecimalString(value, { range: "POSITIVE" });
}

/** Total predicate: any canonical decimal, sign unconstrained. */
export function isDecimal(value: unknown): value is DecimalString {
  return isCanonicalDecimalString(value);
}

export function readPrice(value: unknown, path: string): Outcome<Price> {
  if (!isPrice(value)) {
    return bad(
      `${path} must be a canonical decimal price in [0, 1] — received ${describe(value)}` +
        (typeof value === "string" ? ` (${JSON.stringify(value)})` : "") +
        "; a non-canonical spelling such as \"0.0\" or \"0.350\" is refused, never normalized here",
    );
  }
  return ok(value);
}

export function readNonNegative(value: unknown, path: string): Outcome<DecimalString> {
  if (!isNonNegative(value)) {
    return bad(
      `${path} must be a canonical non-negative decimal string — received ${describe(value)}` +
        (typeof value === "string" ? ` (${JSON.stringify(value)})` : ""),
    );
  }
  return ok(value);
}

/**
 * Reads one economic value out of OPERATOR-AUTHORED CONFIGURATION.
 *
 * This is the one place in the package that accepts a non-canonical spelling,
 * and the relaxation is exactly the one §7.3 sanctions: redundant leading
 * zeros, trailing fractional zeros and signed zero (`normalizeHashableDecimal
 * String`'s grammar). It exists because §13.2's own example writes
 * `price: "0.50"`, which is a legal decimal a human types and which the strict
 * canonical grammar refuses — and because a configuration file is the
 * operator's wire format, so it is the door that owns normalization, exactly as
 * `docs/contracts/domain.md`'s boundary decision puts venue normalization in
 * the adapter that owns the venue's wire format.
 *
 * Everything §7.3 forbids still refuses, unnormalized: a leading `+`, a
 * trailing decimal point, an omitted integer part, scientific notation,
 * whitespace, and any non-string. The value STORED is always canonical, so
 * every later comparison in this package is exact and one config value has one
 * representation.
 *
 * VIEW data is NOT read through here. A price on a book view has already
 * crossed a domain boundary and must be canonical; `readPrice` refuses
 * anything else rather than repairing it.
 */
export function readConfigDecimal(
  value: unknown,
  path: string,
  range: DecimalRange,
): Outcome<DecimalString> {
  if (typeof value !== "string") {
    return bad(`${path} must be a decimal string; received ${describe(value)}`);
  }
  const problem = explainHashableDecimalString(value, { range });
  if (problem !== null) {
    return bad(
      `${path}: ${problem} — configuration accepts the canonical form plus redundant ` +
        "leading/trailing zeros (§7.3), and nothing else",
    );
  }
  return guarded(path, () => normalizeHashableDecimalString(value, { range }));
}

function guarded<T>(path: string, compute: () => T): Outcome<T> {
  try {
    return ok(compute());
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "a non-Error value was thrown";
    return bad(`${path}: exact decimal arithmetic refused (${detail})`);
  }
}

/** Exact sum of two pre-validated canonical decimals. */
export function add(a: DecimalString, b: DecimalString, path: string): Outcome<DecimalString> {
  return guarded(path, () => addDecimal(a, b));
}

/** Exact difference of two pre-validated canonical decimals. */
export function sub(a: DecimalString, b: DecimalString, path: string): Outcome<DecimalString> {
  return guarded(path, () => subDecimal(a, b));
}

/** Exact product of two pre-validated canonical decimals. */
export function mul(a: DecimalString, b: DecimalString, path: string): Outcome<DecimalString> {
  return guarded(path, () => mulDecimal(a, b));
}

/**
 * Total three-way comparison. Both arguments must already be canonical; a
 * non-canonical one is a programming error here, so the refusal names the
 * value rather than guessing an ordering.
 */
export function compare(a: DecimalString, b: DecimalString, path: string): Outcome<-1 | 0 | 1> {
  return guarded(path, () => compareDecimal(a, b));
}

/** `a <= b` for pre-validated canonical decimals. */
export function lessOrEqual(a: DecimalString, b: DecimalString, path: string): Outcome<boolean> {
  const ordering = compare(a, b, path);
  return ordering.ok ? ok(ordering.value <= 0) : ordering;
}

/** `a >= b` for pre-validated canonical decimals. */
export function greaterOrEqual(a: DecimalString, b: DecimalString, path: string): Outcome<boolean> {
  const ordering = compare(a, b, path);
  return ordering.ok ? ok(ordering.value >= 0) : ordering;
}

export function isZero(value: DecimalString): boolean {
  return value === ZERO;
}

/**
 * Tick conformance of a price against a market's current tick size, guarded so
 * a malformed tick size on a view refuses instead of throwing.
 */
export function onTickGrid(price: Price, tickSize: DecimalString, path: string): Outcome<boolean> {
  if (!isPositive(tickSize)) {
    return bad(`${path}: tick size ${describe(tickSize)} is not a canonical positive decimal`);
  }
  return guarded(path, () => isTickConformant(price, tickSize));
}

/**
 * The complement price, `1 - price`.
 *
 * This is the ONLY economic relation between the YES and NO legs this strategy
 * uses, and it is a definition rather than a venue fact: a binary market's two
 * outcome tokens pay 1 and 0 in complementary states, so buying YES at `p` and
 * selling an owned NO at `1 - p` establish the same directional exposure. No
 * claim about minting, splitting, merging, fees, or short selling is made here
 * or anywhere in this package.
 */
export function complement(price: Price, path: string): Outcome<Price> {
  const value = sub(ONE, price, path);
  if (!value.ok) return value;
  if (!isPrice(value.value)) {
    return bad(`${path}: 1 - ${price} = ${value.value} is not a price in [0, 1]`);
  }
  return ok(value.value);
}
