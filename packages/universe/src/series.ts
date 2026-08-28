/**
 * Rolling series — handoff §9.2, §10.1 (`catalog.series`).
 *
 * §9.2: "Group ephemeral markets into stable series such as `btc-15m-updown`",
 * and then the rule that shapes this entire module:
 *
 * > Series binding is configuration, not heuristic-only. The system may suggest
 * > a series match, but a new market pattern is not auto-approved for live
 * > trading.
 *
 * HOW THAT IS MADE STRUCTURAL. A suggestion and an approval are DIFFERENT TYPES
 * (`MarketSeriesBinding`), not the same type with a confidence field. There is
 * no function anywhere in this package that turns a `SeriesSuggestion` into an
 * `APPROVED` binding: approval takes a human identity and an instant, and
 * {@link suggestSeriesBindings} returns suggestions that carry neither. A
 * heuristic that could promote itself would be exactly the auto-approval §9.2
 * forbids, and it would do so on the day a venue renamed a slug.
 *
 * The suggestion heuristic itself is deliberately dumb, deterministic, and
 * explainable: it reports which signals matched, in a stable order, and it
 * scores by counting them. It is a shortlist for a human, not a classifier.
 */

import {
  CodeStringSchema,
  DetailStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  Uuidv7Schema,
} from "@polymarket-bot/domain";
import { z } from "zod";

import type { MarketIdentity } from "./identity.js";

/**
 * Whether a human has approved this series for binding.
 *
 * Mirrors WP-040's `series_binding_approval_complete` constraint
 * (`binding_approved` ⇔ both reviewer columns present) as a union, so the row
 * that claims approval without an approver cannot be constructed.
 */
export const SeriesBindingApprovalSchema = z.discriminatedUnion("approved", [
  z.strictObject({ approved: z.literal(false) }),
  z.strictObject({
    approved: z.literal(true),
    approvedBy: NonEmptyStringSchema,
    approvedAt: IsoTimestampSchema,
  }),
]);
export type SeriesBindingApproval = z.infer<typeof SeriesBindingApprovalSchema>;

/** A stable rolling market family (`catalog.series`). */
export const SeriesDefinitionSchema = z.strictObject({
  seriesId: Uuidv7Schema,
  /** The stable key strategies configure against, e.g. `btc-15m-updown` (§13.2). */
  seriesKey: CodeStringSchema,
  displayName: NonEmptyStringSchema,
  /** The reference instrument this family tracks, e.g. `btc.usd`. */
  underlyingSymbol: CodeStringSchema,
  /** Cadence token, e.g. `PT15M`. Free vocabulary; not parsed. */
  cadence: CodeStringSchema.optional(),
  description: DetailStringSchema.optional(),
  binding: SeriesBindingApprovalSchema,
  /** The settlement spec currently bound to this series, when one is. */
  activeSettlementSpecId: Uuidv7Schema.optional(),
  active: z.boolean(),
});
export type SeriesDefinition = z.infer<typeof SeriesDefinitionSchema>;

/**
 * How a market is (or is not) attached to a series.
 *
 * `SUGGESTED` is not a weaker `APPROVED`: it carries no approver, and no code
 * path upgrades it. Only {@link approvedSeriesBinding} produces `APPROVED`, and
 * it demands the two facts a review consists of.
 */
export type MarketSeriesBinding =
  | { readonly kind: "UNBOUND" }
  | {
      readonly kind: "SUGGESTED";
      readonly seriesId: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "APPROVED";
      readonly seriesId: string;
      readonly approvedBy: string;
      readonly approvedAt: string;
    };

/** The unbound binding, shared because it is a constant. */
export const UNBOUND_SERIES_BINDING: MarketSeriesBinding = Object.freeze({ kind: "UNBOUND" });

/** Builds an approved binding. The two review facts are required arguments. */
export function approvedSeriesBinding(
  seriesId: string,
  approvedBy: string,
  approvedAt: string,
): MarketSeriesBinding {
  return Object.freeze({ kind: "APPROVED", seriesId, approvedBy, approvedAt });
}

/** Builds a suggested binding. It permits nothing on its own. */
export function suggestedSeriesBinding(
  seriesId: string,
  reasons: readonly string[],
): MarketSeriesBinding {
  return Object.freeze({ kind: "SUGGESTED", seriesId, reasons: Object.freeze([...reasons]) });
}

/** Whether a binding permits treating the market as a member of the series. */
export function isApprovedSeriesBinding(
  binding: MarketSeriesBinding,
): binding is Extract<MarketSeriesBinding, { kind: "APPROVED" }> {
  return binding.kind === "APPROVED";
}

/** One candidate series for a market, with the signals that produced it. */
export interface SeriesSuggestion {
  readonly seriesId: string;
  readonly seriesKey: string;
  /** Number of matched signals. NOT a probability and NOT an approval threshold. */
  readonly score: number;
  readonly reasons: readonly string[];
}

/** Lowercased haystack built from the identifying text a market carries. */
function marketText(market: MarketIdentity): string {
  return [market.venueMarketSlug ?? "", market.questionTitle ?? ""].join(" ").toLowerCase();
}

/** The tokens of a symbol such as `btc.usd`, lowercased. */
function symbolTokens(symbol: string): readonly string[] {
  return symbol
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Suggests series a market might belong to.
 *
 * SUGGESTION ONLY (§9.2). The result is a shortlist for a human reviewer: it
 * never mutates a registry, never returns an approval, and deliberately has no
 * "confidence" number that a caller could threshold into an auto-approval.
 *
 * Deterministic: signals are evaluated in a fixed order and ties are broken by
 * series key, so the same inputs always produce the same list.
 */
export function suggestSeriesBindings(
  market: MarketIdentity,
  series: readonly SeriesDefinition[],
): readonly SeriesSuggestion[] {
  const haystack = marketText(market);
  const suggestions: SeriesSuggestion[] = [];

  for (const candidate of series) {
    if (!candidate.active) {
      continue;
    }
    const reasons: string[] = [];
    const key = candidate.seriesKey.toLowerCase();
    if (haystack.includes(key)) {
      reasons.push(`market text contains the series key "${candidate.seriesKey}"`);
    }
    const tokens = symbolTokens(candidate.underlyingSymbol);
    const base = tokens[0];
    if (base !== undefined && haystack.includes(base)) {
      reasons.push(`market text mentions the underlying "${base}"`);
    }
    if (candidate.cadence !== undefined && haystack.includes(candidate.cadence.toLowerCase())) {
      reasons.push(`market text mentions the cadence "${candidate.cadence}"`);
    }
    if (reasons.length === 0) {
      continue;
    }
    suggestions.push({
      seriesId: candidate.seriesId,
      seriesKey: candidate.seriesKey,
      score: reasons.length,
      reasons: Object.freeze(reasons),
    });
  }

  suggestions.sort(
    (left, right) =>
      right.score - left.score || (left.seriesKey < right.seriesKey ? -1 : left.seriesKey > right.seriesKey ? 1 : 0),
  );
  return Object.freeze(suggestions);
}
