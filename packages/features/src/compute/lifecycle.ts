/**
 * Lifecycle features (§9.5 third block). All durations are integer
 * milliseconds computed from event timestamps only; negative values are
 * reported as-is (a market past its close has a negative time-to-close, and
 * that is information, not an error).
 */

import { subDecimal } from "@polymarket-bot/decimal";

import type { ValidatedFeatureInput } from "../inputs.js";
import { latestAtOrBefore } from "./reference.js";
import type { ComputedFeature } from "../values.js";
import { absent, ok } from "../values.js";

export function computeLifecycleFeatures(input: ValidatedFeatureInput): ComputedFeature[] {
  const features: ComputedFeature[] = [];
  const lifecycle = input.lifecycle;

  features.push(
    lifecycle?.closesAtEpochMs === undefined
      ? absent("lifecycle.time_to_close_ms", "INPUT_MISSING", "closesAt was not supplied")
      : ok("lifecycle.time_to_close_ms", lifecycle.closesAtEpochMs - input.asOfEpochMs),
  );
  features.push(
    lifecycle?.openedAtEpochMs === undefined
      ? absent("lifecycle.time_since_open_ms", "INPUT_MISSING", "openedAt was not supplied")
      : ok("lifecycle.time_since_open_ms", input.asOfEpochMs - lifecycle.openedAtEpochMs),
  );
  features.push(
    lifecycle?.openedAtEpochMs === undefined || lifecycle.closesAtEpochMs === undefined
      ? absent("lifecycle.market_duration_ms", "INPUT_MISSING", "openedAt and closesAt are both required")
      : ok("lifecycle.market_duration_ms", lifecycle.closesAtEpochMs - lifecycle.openedAtEpochMs),
  );

  features.push(computeReferenceOpenDistance(input));
  return features;
}

function computeReferenceOpenDistance(input: ValidatedFeatureInput): ComputedFeature {
  const id = "lifecycle.reference_open_distance";
  const referenceOpenPrice = input.lifecycle?.referenceOpenPrice;
  if (referenceOpenPrice === undefined) {
    return absent(id, "INPUT_MISSING", "referenceOpenPrice was not supplied");
  }
  const venue = input.config.primaryReferenceVenue;
  const series = input.reference[venue];
  if (series === undefined) {
    return absent(id, "INPUT_MISSING", `no ${venue} reference input was supplied (primaryReferenceVenue)`);
  }
  const latest = latestAtOrBefore(series.trades, input.asOfEpochMs);
  if (latest === undefined) {
    return absent(id, "NO_REFERENCE_PRICE", `no ${venue} reference price at or before asOf`);
  }
  return ok(id, {
    venue,
    referencePrice: latest.price,
    referenceOpenPrice,
    distance: subDecimal(latest.price, referenceOpenPrice),
  });
}
