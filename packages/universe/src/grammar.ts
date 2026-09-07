/**
 * THE TWO FORMATS THE DOORS LEFT UNSTATED — `docs/contracts/schema-boundary.md`
 * §5 item 9(c), UNIV-1 r1 MED-2 and NOTE-2.
 *
 * ## What this module is for
 *
 * `./lifecycle-door.ts`, `./caller-door.ts` and `./registration-door.ts` all
 * disclose the same residual: they re-state PRESENCE, TYPE, BOUNDS and
 * VOCABULARY, but not the FORMATS — "the decimal grammar on
 * `tickSize`/`minimumOrderSize`, and the full ISO-8601 shape on the four
 * instants (the door re-states only that an instant PARSES)". `UNIV-1` ranked
 * the instant half MED-2 because it REACHES THE IRREVERSIBLE TRANSITION:
 * measured again at base `c2c0733`, with a non-enumerable inherited
 * `skipChecks` a `MarketResolved` carrying `resolvedAt: "Aug 28 2026"`,
 * `"2026-08-28"`, an offsetless `"2026-08-28T12:15:30"` or the non-existent
 * `"2026-02-30T00:00:00Z"` **resolves the market** and writes that string into
 * `projection.resolvedAt`, where every one of the four is refused clean.
 * `UNIV-1`'s NOTE-2 is the decimal half of the same residual: under the same
 * `skipChecks`, `tickSize: "1.50"` reached `equalsDecimal` and threw
 * `InvalidDecimalStringError` straight OUT of `applyMarketLifecycleEvent`,
 * which returns a typed result and which no caller in this repository wraps.
 *
 * ## Why this is not a second opinion about what a valid value is
 *
 * `docs/contracts/schema-boundary.md` §1 warns that a hand-written copy of a
 * frozen grammar drifts from it. Neither predicate here writes one:
 *
 * - {@link isPositiveDecimalString} calls `isCanonicalDecimalString`, which is
 *   the function `PositiveDecimalStringSchema` itself calls inside its
 *   `superRefine` (`packages/domain/src/decimals.ts`: "The canonical form itself
 *   is decided by `@polymarket-bot/decimal`, so schema validation and direct
 *   validation can never drift apart"). Same function, same constraints — the
 *   accept sets are equal by construction, not by test.
 * - {@link isIsoTimestamp} tests `IsoTimestampSchema`'s OWN compiled pattern,
 *   read off the schema at module load. `./grammar.test.ts` sweeps the two
 *   against each other differentially, clean and under an inherited
 *   `skipChecks`, and asserts per-corpus-row non-vacuity, so "recomposed, not
 *   rewritten" is a measured claim rather than a comment.
 *
 * If a future `zod` stops exposing that pattern, {@link isIsoTimestamp} falls
 * back to the schema itself: never STRICTER than the contract, and the residual
 * simply returns to its `UNIV-1` state instead of the package refusing every
 * instant. The suite pins that the pattern IS derivable today, so the
 * degradation cannot happen silently.
 */

import { isCanonicalDecimalString } from "@polymarket-bot/decimal";
import { IsoTimestampSchema } from "@polymarket-bot/domain";

/**
 * `IsoTimestampSchema`'s own compiled pattern, or `undefined` on a `zod` whose
 * internals moved.
 *
 * Read through `Object.hasOwn` steps rather than a dotted path: this module is
 * part of a prototype-integrity round, and a dotted read of `_zod.def.pattern`
 * would be answerable from `Object.prototype` exactly like everything else this
 * grant closes.
 */
function derivePattern(): RegExp | undefined {
  const schema: unknown = IsoTimestampSchema;
  if (typeof schema !== "object" || schema === null || !Object.hasOwn(schema, "_zod")) {
    return undefined;
  }
  const internals = (schema as Record<string, unknown>)["_zod"];
  if (typeof internals !== "object" || internals === null || !Object.hasOwn(internals, "def")) {
    return undefined;
  }
  const def = (internals as Record<string, unknown>)["def"];
  if (typeof def !== "object" || def === null || !Object.hasOwn(def, "pattern")) {
    return undefined;
  }
  const pattern = (def as Record<string, unknown>)["pattern"];
  return pattern instanceof RegExp ? pattern : undefined;
}

/** The pattern, resolved once. Exported so the suite can pin that it exists. */
export const ISO_TIMESTAMP_PATTERN: RegExp | undefined = derivePattern();

/**
 * Whether the value is an ISO-8601 instant with an explicit UTC designator or
 * offset — `IsoTimestampSchema`'s own verdict, restated.
 *
 * The pattern is used WITHOUT `lastIndex` state: a global or sticky pattern
 * would answer differently on alternate calls, so a fresh non-global copy is
 * built at module load.
 */
const ISO_TEST: RegExp | undefined =
  ISO_TIMESTAMP_PATTERN === undefined
    ? undefined
    : new RegExp(ISO_TIMESTAMP_PATTERN.source, ISO_TIMESTAMP_PATTERN.flags.replace(/[gy]/gu, ""));

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  /* c8 ignore next 3 -- the fallback only runs on a zod whose internals moved. */
  if (ISO_TEST === undefined) {
    return IsoTimestampSchema.safeParse(value).success;
  }
  return ISO_TEST.test(value);
}

/**
 * Whether the value is a canonical decimal string greater than zero —
 * `PositiveDecimalStringSchema`'s own verdict, restated by calling the same
 * predicate the schema calls.
 */
export function isPositiveDecimalString(value: unknown): value is string {
  return isCanonicalDecimalString(value, { range: "POSITIVE" });
}
