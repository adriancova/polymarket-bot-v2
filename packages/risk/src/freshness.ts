/**
 * Freshness assessment — handoff §9.8 check 7 ("Required feeds are fresh and
 * healthy"). Workplan WP-180 acceptance 3: "Stale data blocks entries."
 *
 * NO CLOCK IS READ IN THIS PACKAGE. Staleness arrives as CALLER-SUPPLIED
 * measurements (`ageMs`, measured by the component that owns a clock); this
 * module only classifies them against policy limits. A required feed with no
 * measurement is `UNKNOWN`, and unknown is treated exactly like stale — fail
 * closed, never permit.
 *
 * WHAT STALENESS DOES TO EXITS — pinned from the handoff, verbatim sources:
 *
 * | Stale/unknown feed      | Entry intent | Exit/reduce intent | Cancel |
 * | ----------------------- | ------------ | ------------------ | ------ |
 * | features/reference feed | BLOCKED      | PERMITTED          | PERMITTED |
 * | venue book              | BLOCKED      | BLOCKED, with cancel+reconcile recommendations | PERMITTED |
 *
 * - §9.9 failure table, row 1 — "External reference feed stale, Polymarket
 *   healthy → Cancel signal-dependent quotes; halt new entries": the venue
 *   book is healthy, so exits (which depend on the venue book, not on the
 *   signal feed) are NOT halted. Blanket-blocking exits on a signal-feed
 *   staleness would be dangerous and is exactly what the row avoids.
 * - §9.9 failure table, row 2 — "Polymarket book stale → Cancel resting
 *   orders; no blind aggressive orders": no NEW order may be placed blind
 *   into a stale book — reducing included.
 * - §6 invariant 12 — "No blind flatten. Unknown position or book state
 *   causes cancel and reconciliation before any protected reduction action":
 *   a reduction into a stale/unknown book is refused NOW, carrying the
 *   CANCEL_RESTING_ORDERS + RECONCILE_ACCOUNT recommendations; the protected
 *   reduction happens after reconciliation, under the incident controller
 *   (§9.9 — a later package).
 * - §6 invariant 13 — "Safety cancellation outranks new order placement":
 *   CANCEL intents are never blocked by staleness.
 */

import { z } from "zod";

import { InternalMarketIdSchema, NonNegativeIntegerSchema } from "@polymarket-bot/domain";

/** The feed kinds this package classifies. */
export const FRESHNESS_FEEDS = ["VENUE_BOOK", "REFERENCE_FEED", "FEATURES"] as const;
export type FreshnessFeed = (typeof FRESHNESS_FEEDS)[number];

/** One caller-supplied staleness measurement. `ageMs` is a duration, not an economic value. */
export const FreshnessObservationSchema = z.strictObject({
  feed: z.enum(FRESHNESS_FEEDS),
  /** Required for `VENUE_BOOK` (books are per market); enforced in `assessFreshness`. */
  marketId: InternalMarketIdSchema.optional(),
  ageMs: NonNegativeIntegerSchema,
});
export type FreshnessObservation = z.infer<typeof FreshnessObservationSchema>;

/** Per-feed maximum ages. Durations, not economic values. */
export const FreshnessPolicySchema = z.strictObject({
  venueBookMaxAgeMs: NonNegativeIntegerSchema,
  referenceFeedMaxAgeMs: NonNegativeIntegerSchema,
  featuresMaxAgeMs: NonNegativeIntegerSchema,
});
export type FreshnessPolicy = z.infer<typeof FreshnessPolicySchema>;

export type FreshnessStatus = "FRESH" | "STALE" | "UNKNOWN";

export interface FreshnessFinding {
  readonly feed: FreshnessFeed;
  readonly status: FreshnessStatus;
  /** The stalest matching measurement, when one exists. */
  readonly ageMs?: number;
  readonly limitMs: number;
}

export interface FreshnessAssessment {
  readonly venueBook: FreshnessFinding;
  readonly referenceFeed: FreshnessFinding;
  readonly features: FreshnessFinding;
}

function classify(
  feed: FreshnessFeed,
  ages: readonly number[],
  limitMs: number,
): FreshnessFinding {
  if (ages.length === 0) {
    return { feed, status: "UNKNOWN", limitMs };
  }
  // Multiple measurements for one feed: the STALEST governs (fail closed).
  const ageMs = Math.max(...ages);
  return { feed, status: ageMs > limitMs ? "STALE" : "FRESH", ageMs, limitMs };
}

/**
 * Classifies the supplied measurements for an intent on `marketId`.
 * A `VENUE_BOOK` measurement counts only when it names THIS market.
 */
export function assessFreshness(
  observations: readonly FreshnessObservation[],
  policy: FreshnessPolicy,
  marketId: string,
): FreshnessAssessment {
  const bookAges: number[] = [];
  const referenceAges: number[] = [];
  const featureAges: number[] = [];
  for (const observation of observations) {
    if (observation.feed === "VENUE_BOOK") {
      if (observation.marketId === marketId) {
        bookAges.push(observation.ageMs);
      }
      continue;
    }
    if (observation.feed === "REFERENCE_FEED") {
      referenceAges.push(observation.ageMs);
      continue;
    }
    featureAges.push(observation.ageMs);
  }
  return Object.freeze({
    venueBook: classify("VENUE_BOOK", bookAges, policy.venueBookMaxAgeMs),
    referenceFeed: classify("REFERENCE_FEED", referenceAges, policy.referenceFeedMaxAgeMs),
    features: classify("FEATURES", featureAges, policy.featuresMaxAgeMs),
  });
}

/** Stale and unknown are one class for gating purposes (fail closed). */
export function blocksAsStale(finding: FreshnessFinding): boolean {
  return finding.status !== "FRESH";
}
