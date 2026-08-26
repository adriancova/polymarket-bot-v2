/**
 * Decimal boundary types — handoff §7.3.
 *
 * ```ts
 * type DecimalString = string;
 * type PriceString = DecimalString;
 * type SharesString = DecimalString;
 * type MoneyString = DecimalString;
 * type ProbabilityString = DecimalString;
 * ```
 *
 * "No domain schema accepts `number` for an economic field." Every schema in
 * this module is built on `z.string()`, so a JavaScript number, bigint, or
 * numeric-looking object fails before any further check runs. The canonical
 * form itself is decided by `@polymarket-bot/decimal`, so schema validation and
 * direct validation can never drift apart.
 *
 * STRICT BOUNDARY: these schemas accept the canonical form only. A venue
 * payload that spells a value differently (`"1.50"`, `"+1.5"`, `"01.5"`) must be
 * passed through `normalizeDecimalString` from `@polymarket-bot/decimal` inside
 * the adapter that owns the wire format.
 */

import {
  explainCanonicalDecimalString,
  type DecimalString,
  type DecimalStringConstraints,
} from "@polymarket-bot/decimal";
import { z } from "zod";

/**
 * Builds a canonical-decimal-string schema.
 *
 * Exported so later packages can express additional contextual constraints
 * (for example a non-negative fee) without re-implementing canonicalization.
 */
export function decimalStringSchema(
  constraints?: DecimalStringConstraints,
): z.ZodType<DecimalString, string> {
  return z.string().superRefine((value, ctx) => {
    const problem = explainCanonicalDecimalString(value, constraints);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", message: problem });
    }
  });
}

/** Any canonical decimal string (§7.3 `DecimalString`). */
export const DecimalStringSchema = decimalStringSchema();

/** A canonical decimal string that is greater than or equal to zero. */
export const NonNegativeDecimalStringSchema = decimalStringSchema({ range: "NON_NEGATIVE" });

/** A canonical decimal string that is strictly greater than zero. */
export const PositiveDecimalStringSchema = decimalStringSchema({ range: "POSITIVE" });

/**
 * `PriceString` (§7.3).
 *
 * Polymarket outcome-token prices are probabilities, so the §7.3 rule "price
 * must be in `[0, 1]` where context requires" applies to every price field in
 * these contracts. Reference-venue spot prices (Binance, Coinbase) are NOT
 * prices in this sense and use {@link NonNegativeDecimalStringSchema}.
 */
export const PriceStringSchema = decimalStringSchema({ range: "UNIT_INTERVAL" });

/** `ProbabilityString` (§7.3) — constrained to `[0, 1]`. */
export const ProbabilityStringSchema = decimalStringSchema({ range: "UNIT_INTERVAL" });

/**
 * `SharesString` (§7.3).
 *
 * Unconstrained in sign: a `DELTA` position intent may target a negative share
 * change (§7.7).
 */
export const SharesStringSchema = DecimalStringSchema;

/** A share quantity that cannot be negative (inventory caps, minimum fills). */
export const NonNegativeSharesStringSchema = NonNegativeDecimalStringSchema;

/**
 * `MoneyString` (§7.3).
 *
 * Unconstrained in sign: realized PnL and edges may be negative.
 */
export const MoneyStringSchema = DecimalStringSchema;

/** A monetary magnitude that cannot be negative (cost caps, risk limits). */
export const NonNegativeMoneyStringSchema = NonNegativeDecimalStringSchema;

export type { DecimalString };

/** `PriceString` (§7.3). */
export type PriceString = DecimalString;

/** `SharesString` (§7.3). */
export type SharesString = DecimalString;

/** `MoneyString` (§7.3). */
export type MoneyString = DecimalString;

/** `ProbabilityString` (§7.3). */
export type ProbabilityString = DecimalString;
