/**
 * Quality features (§9.5 fourth block; WP-160 acceptance 2: input staleness
 * is included — the age of every input feed, and the active data-quality
 * incident flags).
 *
 * Ages are DERIVED from the input sections actually supplied, not from a
 * parallel caller-maintained map, so a feed that fed this computation cannot
 * be missing from the staleness record. `ageMs = asOf - lastEventAt`; a
 * negative age (the feed's stamp is ahead of the evaluated event's time) is
 * reported as-is, mirroring the order-book package's never-clamped staleness
 * rule.
 *
 * `lastEventAt` is the CALLER's statement of when each feed last vouched for
 * its section; this module computes the same `asOf - lastEventAt` whatever the
 * caller meant. The trader's composition root supplies, for the book, the
 * instant its configured book-freshness basis vouches for (ADR-023: the last
 * change under `LAST_CHANGE`, the delivery-session confirmation under
 * `CONNECTION_CONFIRMED`), and its strategy gate reads the resulting
 * `polymarket.book` age. No definition here changed for that.
 */

import type { ValidatedFeatureInput } from "../inputs.js";
import type { ComputedFeature, FeatureData } from "../values.js";
import { ok } from "../values.js";

/** The stable feed identifiers ages are reported under. */
export const FEED_IDS = Object.freeze({
  book: "polymarket.book",
  trades: "polymarket.trades",
  binance: "reference.binance",
  coinbase: "reference.coinbase",
  chainlink: "reference.chainlink",
} as const);

export function computeQualityFeatures(input: ValidatedFeatureInput): ComputedFeature[] {
  const ages: { feedId: string; ageMs: number }[] = [
    { feedId: FEED_IDS.book, ageMs: input.asOfEpochMs - input.book.lastEventAtEpochMs },
  ];
  if (input.trades !== undefined) {
    ages.push({ feedId: FEED_IDS.trades, ageMs: input.asOfEpochMs - input.trades.lastEventAtEpochMs });
  }
  if (input.reference.binance !== undefined) {
    ages.push({ feedId: FEED_IDS.binance, ageMs: input.asOfEpochMs - input.reference.binance.lastEventAtEpochMs });
  }
  if (input.reference.coinbase !== undefined) {
    ages.push({ feedId: FEED_IDS.coinbase, ageMs: input.asOfEpochMs - input.reference.coinbase.lastEventAtEpochMs });
  }
  if (input.reference.chainlink !== undefined) {
    ages.push({ feedId: FEED_IDS.chainlink, ageMs: input.asOfEpochMs - input.reference.chainlink.lastEventAtEpochMs });
  }
  ages.sort((a, b) => (a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0));

  const incidents: FeatureData[] = [...input.quality.activeIncidents]
    .sort((a, b) => (a.incidentId < b.incidentId ? -1 : a.incidentId > b.incidentId ? 1 : 0))
    .map((incident) => ({
      incidentId: incident.incidentId,
      reasonCode: incident.reasonCode,
      severity: incident.severity,
      ...(incident.feedId === undefined ? {} : { feedId: incident.feedId }),
    }));

  return [
    ok("quality.input_feed_ages", ages),
    ok("quality.active_incidents", incidents),
  ];
}
