/**
 * External reference features (§9.5 second block): venue returns over the
 * fixed horizons, cross-venue midpoint difference and direction agreement,
 * EWMA realized volatility, and Chainlink TWAPs where configured.
 *
 * Both return endpoints are "the latest observation at or before the
 * instant" — the same last-value-carried-forward rule at both ends, so a
 * return is always a ratio of two prices the live process actually held.
 * Nothing interpolates: an interpolated price is information from the future
 * of one of its neighbors (§6 invariant 15).
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type { DecimalString } from "@polymarket-bot/decimal";

import { dividePolicy, halveExact, quantizePolicy, sqrtPolicy } from "../decimal-policy.js";
import type {
  ReferenceVenueName,
  ValidatedFeatureInput,
  ValidatedReferencePoint,
  ValidatedReferenceSeries,
} from "../inputs.js";
import { RETURN_HORIZONS, TWAP_WINDOWS_SECONDS } from "../registry.js";
import type { ComputedFeature } from "../values.js";
import { absent, ok } from "../values.js";

const VENUES: readonly ReferenceVenueName[] = ["binance", "coinbase"];

/** Latest point with `observedAtEpochMs <= instant`, by binary search. */
export function latestAtOrBefore(
  points: readonly ValidatedReferencePoint[],
  instantMs: number,
): ValidatedReferencePoint | undefined {
  let low = 0;
  let high = points.length - 1;
  let found: ValidatedReferencePoint | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const point = points[middle];
    if (point === undefined) break;
    if (point.observedAtEpochMs <= instantMs) {
      found = point;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

type ReturnOutcome =
  | { readonly kind: "OK"; readonly value: DecimalString }
  | { readonly kind: "NO_SERIES" }
  | { readonly kind: "NO_PRICE"; readonly detail: string };

function horizonReturn(
  series: ValidatedReferenceSeries | undefined,
  asOfEpochMs: number,
  horizonMs: number,
): ReturnOutcome {
  if (series === undefined) {
    return { kind: "NO_SERIES" };
  }
  const now = latestAtOrBefore(series.trades, asOfEpochMs);
  if (now === undefined) {
    return { kind: "NO_PRICE", detail: "no reference price at or before asOf" };
  }
  const then = latestAtOrBefore(series.trades, asOfEpochMs - horizonMs);
  if (then === undefined) {
    return { kind: "NO_PRICE", detail: `no reference price at or before asOf - ${String(horizonMs)}ms` };
  }
  return { kind: "OK", value: dividePolicy(subDecimal(now.price, then.price), then.price) };
}

function midpointOf(series: ValidatedReferenceSeries | undefined): DecimalString | undefined {
  const top = series?.topOfBook;
  if (top?.bidPrice === undefined || top.askPrice === undefined) return undefined;
  return halveExact(addDecimal(top.bidPrice, top.askPrice));
}

/**
 * `THROUGHPUT-1a` — the EWMA's memo. PERFORMANCE ONLY: no value changes.
 *
 * The EWMA realized volatility is a pure function of three things: the feature
 * id (its venue), `lambda`, and the series' PRICES in order — nothing else in
 * the input reaches {@link computeEwmaVolatilityUncached} (not `asOf`, not the
 * instants, not the book). It is also the most expensive computation in a
 * snapshot: two exact divisions, three multiplications and a quantization per
 * consecutive pair, over up to the whole window (512 points per venue in the
 * trader), recomputed for EVERY evaluation — while the series itself changes
 * only when a reference trade arrives (H1's burst: ~28 reference trades a
 * second against ~660 evaluations).
 *
 * So the result is memoized under an EXACT key of those three inputs — the
 * prices are validated canonical decimal strings, which never contain the
 * separator — and a hit returns the very outcome a recomputation would
 * produce. The returned object is never mutated downstream (`bindToRegistry`
 * reads it; `ownFrozenTree` copies it). Bounded: at most
 * {@link EWMA_MEMO_LIMIT} entries, oldest first out.
 */
const EWMA_MEMO_LIMIT = 16;
const ewmaMemo = new Map<string, ComputedFeature>();
/**
 * The same memo by the validated series OBJECT: an entry is written only from
 * the key above (so it is that key's outcome), and a series object is never
 * mutated after validation, so its outcome cannot change.
 */
const ewmaBySeries = new WeakMap<
  ValidatedReferenceSeries,
  { readonly venue: ReferenceVenueName; readonly lambda: DecimalString; readonly feature: ComputedFeature }
>();

function computeEwmaVolatility(
  venue: ReferenceVenueName,
  series: ValidatedReferenceSeries | undefined,
  lambda: DecimalString,
): ComputedFeature {
  if (series === undefined || series.trades.length < 2) {
    return computeEwmaVolatilityUncached(venue, series, lambda);
  }
  // A prepared section hands every snapshot the SAME series object while it
  // is unchanged (`prepared-reference.ts`), so the identity lookup answers
  // without even building the key.
  const byIdentity = ewmaBySeries.get(series);
  if (byIdentity !== undefined && byIdentity.venue === venue && byIdentity.lambda === lambda) {
    return byIdentity.feature;
  }
  let key = `${venue}\n${lambda}`;
  for (const point of series.trades) key += `\n${point.price}`;
  const cached = ewmaMemo.get(key);
  if (cached !== undefined) {
    ewmaBySeries.set(series, { venue, lambda, feature: cached });
    return cached;
  }
  const computed = computeEwmaVolatilityUncached(venue, series, lambda);
  ewmaMemo.set(key, computed);
  ewmaBySeries.set(series, { venue, lambda, feature: computed });
  if (ewmaMemo.size > EWMA_MEMO_LIMIT) {
    const oldest = ewmaMemo.keys().next();
    if (oldest.done !== true) ewmaMemo.delete(oldest.value);
  }
  return computed;
}

/**
 * `THROUGHPUT-1a` (PERFORMANCE ONLY): one consecutive pair's quantized squared
 * simple return — a pure function of the two prices. When the window slides
 * by one point every pair but the newest is one the previous computation
 * already squared, so the last {@link SQUARED_RETURN_MEMO_LIMIT} pairs are
 * kept by their exact price strings (canonical decimals: the separator cannot
 * occur in them). A hit is the value the expression below would produce.
 */
const SQUARED_RETURN_MEMO_LIMIT = 8_192;
const squaredReturns = new Map<string, DecimalString>();

function squaredReturn(previous: DecimalString, current: DecimalString): DecimalString {
  const key = `${previous}/${current}`;
  const cached = squaredReturns.get(key);
  if (cached !== undefined) return cached;
  const simpleReturn = dividePolicy(subDecimal(current, previous), previous);
  const squared = quantizePolicy(mulDecimal(simpleReturn, simpleReturn));
  squaredReturns.set(key, squared);
  if (squaredReturns.size > SQUARED_RETURN_MEMO_LIMIT) {
    const oldest = squaredReturns.keys().next();
    if (oldest.done !== true) squaredReturns.delete(oldest.value);
  }
  return squared;
}

function computeEwmaVolatilityUncached(
  venue: ReferenceVenueName,
  series: ValidatedReferenceSeries | undefined,
  lambda: DecimalString,
): ComputedFeature {
  const id = `reference.${venue}.ewma_realized_volatility`;
  if (series === undefined) {
    return absent(id, "INPUT_MISSING", `no ${venue} reference input was supplied`);
  }
  const points = series.trades;
  if (points.length < 2) {
    return absent(id, "INSUFFICIENT_SERIES", `${String(points.length)} point(s); at least 2 are needed for one return`);
  }
  const oneMinusLambda = subDecimal("1", lambda);
  let variance: DecimalString | undefined;
  let observations = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) continue;
    const squared = squaredReturn(previous.price, current.price);
    variance =
      variance === undefined
        ? squared
        : quantizePolicy(addDecimal(mulDecimal(lambda, variance), mulDecimal(oneMinusLambda, squared)));
    observations += 1;
  }
  if (variance === undefined) {
    return absent(id, "INSUFFICIENT_SERIES", "no consecutive pair produced a return");
  }
  const volatility = sqrtPolicy(variance);
  if (!volatility.ok) {
    return absent(id, "SQRT_UNAVAILABLE", volatility.problem);
  }
  return ok(id, { volatility: volatility.value, variance, observations, lambda });
}

function computeTwap(input: ValidatedFeatureInput, windowSeconds: number): ComputedFeature {
  const id = `reference.chainlink.twap_${String(windowSeconds)}s`;
  const chainlink = input.reference.chainlink;
  if (chainlink === undefined) {
    return absent(id, "NOT_CONFIGURED", "no chainlink input was supplied (§9.5: where configured)");
  }
  let latest: { feedId: string; value: DecimalString; windowEndAt: string; windowEndAtEpochMs: number } | undefined;
  for (const twap of chainlink.twaps) {
    if (twap.windowSeconds !== windowSeconds) continue;
    if (
      latest === undefined ||
      twap.windowEndAtEpochMs > latest.windowEndAtEpochMs ||
      // Deterministic tie rule: equal window ends resolve to the smallest feedId.
      (twap.windowEndAtEpochMs === latest.windowEndAtEpochMs && twap.feedId < latest.feedId)
    ) {
      latest = {
        feedId: twap.feedId,
        value: twap.value,
        windowEndAt: twap.windowEndAt,
        windowEndAtEpochMs: twap.windowEndAtEpochMs,
      };
    }
  }
  if (latest === undefined) {
    return absent(id, "NO_TWAP_OBSERVATION", `no ${String(windowSeconds)}s TWAP observation at or before asOf`);
  }
  return ok(id, { feedId: latest.feedId, value: latest.value, windowSeconds, windowEndAt: latest.windowEndAt });
}

export function computeReferenceFeatures(input: ValidatedFeatureInput): ComputedFeature[] {
  const features: ComputedFeature[] = [];
  const returnsByVenueHorizon = new Map<string, ReturnOutcome>();

  for (const venue of VENUES) {
    const series = input.reference[venue];
    for (const horizon of RETURN_HORIZONS) {
      const outcome = horizonReturn(series, input.asOfEpochMs, horizon.ms);
      returnsByVenueHorizon.set(`${venue}:${horizon.label}`, outcome);
      const id = `reference.${venue}.return_${horizon.label}`;
      if (outcome.kind === "OK") {
        features.push(ok(id, outcome.value));
      } else if (outcome.kind === "NO_SERIES") {
        features.push(absent(id, "INPUT_MISSING", `no ${venue} reference input was supplied`));
      } else {
        features.push(absent(id, "NO_PRICE_AT_HORIZON", outcome.detail));
      }
    }
  }

  // Cross-venue midpoint difference.
  {
    const id = "reference.cross_venue.midpoint_difference";
    if (input.reference.binance === undefined || input.reference.coinbase === undefined) {
      const missing = [
        ...(input.reference.binance === undefined ? ["binance"] : []),
        ...(input.reference.coinbase === undefined ? ["coinbase"] : []),
      ].join(", ");
      features.push(absent(id, "INPUT_MISSING", `no reference input for: ${missing}`));
    } else {
      const binanceMid = midpointOf(input.reference.binance);
      const coinbaseMid = midpointOf(input.reference.coinbase);
      if (binanceMid === undefined || coinbaseMid === undefined) {
        const missing = [
          ...(binanceMid === undefined ? ["binance"] : []),
          ...(coinbaseMid === undefined ? ["coinbase"] : []),
        ].join(", ");
        features.push(absent(id, "NO_TOP_OF_BOOK", `no two-sided top of book for: ${missing}`));
      } else {
        features.push(ok(id, subDecimal(binanceMid, coinbaseMid)));
      }
    }
  }

  // Cross-venue direction agreement, per horizon, over the returns above.
  for (const horizon of RETURN_HORIZONS) {
    const id = `reference.cross_venue.direction_agreement_${horizon.label}`;
    const binance = returnsByVenueHorizon.get(`binance:${horizon.label}`);
    const coinbase = returnsByVenueHorizon.get(`coinbase:${horizon.label}`);
    if (binance === undefined || coinbase === undefined || binance.kind === "NO_SERIES" || coinbase.kind === "NO_SERIES") {
      features.push(absent(id, "INPUT_MISSING", "a venue's reference input is missing"));
      continue;
    }
    if (binance.kind !== "OK" || coinbase.kind !== "OK") {
      features.push(absent(id, "NO_PRICE_AT_HORIZON", "a venue has no price pair at this horizon"));
      continue;
    }
    const binanceSign = compareDecimal(binance.value, "0");
    const coinbaseSign = compareDecimal(coinbase.value, "0");
    const agreement =
      binanceSign === 0 || coinbaseSign === 0 ? "NEUTRAL" : binanceSign === coinbaseSign ? "AGREE" : "DISAGREE";
    features.push(ok(id, agreement));
  }

  features.push(computeEwmaVolatility("binance", input.reference.binance, input.config.ewmaLambda));
  features.push(computeEwmaVolatility("coinbase", input.reference.coinbase, input.config.ewmaLambda));

  for (const windowSeconds of TWAP_WINDOWS_SECONDS) {
    features.push(computeTwap(input, windowSeconds));
  }

  return features;
}
