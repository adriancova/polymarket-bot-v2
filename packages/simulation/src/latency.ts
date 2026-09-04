/**
 * The Tier-1 latency model (§12.2, ADR-012 §1).
 *
 * §12.2, immediate orders under Tier 1:
 *
 * > 1. Add sampled decision, signing, network, and venue latency.
 * > 2. Replay market events during the delay.
 * > 3. Execute against resulting depth.
 * > 4. Apply FAK/FOK/limit semantics and historical fee parameters.
 *
 * This module owns step 1. It samples from a **discrete empirical distribution
 * supplied by the caller** rather than from a parametric family, for one reason:
 * ADR-012 §7 records that no execution probe and no live-micro run has occurred,
 * so **no calibration data exists**. Fitting a lognormal to nothing and calling
 * its parameters a model would manufacture precision. A weighted list of
 * candidate latencies is honest about being an assumption, is exactly
 * reproducible, and is pinned per run as the §12.5 "latency-model parameters".
 *
 * Every draw comes from a named seeded stream ({@link ./seed.js}), so the four
 * latency components are independent of each other and of the queue model.
 */

import { isNonEmptyString, isNonNegativeInteger, isPositiveInteger } from "./grammar.js";
import { ownFrozenTree } from "./plain.js";
import { simulationFailure, simulationOk, type SimulationResult } from "./refusals.js";
import type { SeededStream, SeededStreams } from "./seed.js";

/** One candidate latency and its integer weight. */
export interface LatencySample {
  readonly milliseconds: number;
  /** A positive integer. Integer weights keep the draw exactly reproducible. */
  readonly weight: number;
}

/** A discrete empirical latency distribution. */
export interface LatencyDistribution {
  readonly samples: readonly LatencySample[];
}

/** The four §12.2 components, plus the version §12.5 pins. */
export interface LatencyModel {
  readonly latencyModelVersion: string;
  readonly decision: LatencyDistribution;
  readonly signing: LatencyDistribution;
  readonly network: LatencyDistribution;
  readonly venue: LatencyDistribution;
  /**
   * ADR-012 §7. Stated on the model so a report cannot present these numbers as
   * measurements.
   */
  readonly basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS";
}

/** Validates a distribution. An empty or zero-weight one is refused. */
export function readLatencyDistribution(
  distribution: LatencyDistribution,
  what: string,
): SimulationResult<LatencyDistribution> {
  if (!Array.isArray(distribution.samples) || distribution.samples.length === 0) {
    return simulationFailure(
      "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
      `${what} has no samples; a latency model with nothing to draw from would silently mean "no latency", which is the Tier-0 assumption §12.2 bounds to wiring use`,
      { component: what },
    );
  }
  let total = 0;
  for (const sample of distribution.samples) {
    if (!isNonNegativeInteger(sample.milliseconds)) {
      return simulationFailure(
        "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
        `${what} carries a latency that is not a non-negative integer number of milliseconds`,
        { component: what },
      );
    }
    if (!isPositiveInteger(sample.weight)) {
      return simulationFailure(
        "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
        `${what} carries a weight that is not a positive integer; integer weights are what make the draw exactly reproducible`,
        { component: what },
      );
    }
    total += sample.weight;
    if (!Number.isSafeInteger(total)) {
      return simulationFailure(
        "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
        `${what} has weights that overflow exact integer arithmetic`,
        { component: what },
      );
    }
  }
  return simulationOk(ownFrozenTree(distribution));
}

/** Validates a whole latency model. */
export function readLatencyModel(model: LatencyModel): SimulationResult<LatencyModel> {
  if (!isNonEmptyString(model.latencyModelVersion)) {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "the latency model must name its version; §12.5 pins the latency-model version and parameters per run",
    );
  }
  if (model.basis !== "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS") {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "the latency model must state its basis; ADR-012 §7 records that no probe or live-micro observation exists to fit one",
    );
  }
  for (const [what, distribution] of [
    ["decision", model.decision],
    ["signing", model.signing],
    ["network", model.network],
    ["venue", model.venue],
  ] as const) {
    const read = readLatencyDistribution(distribution, what);
    if (!read.ok) return read;
  }
  return simulationOk(ownFrozenTree(model));
}

/**
 * Draws one latency, exactly.
 *
 * The cumulative walk is over integers, and the draw is `nextBelow(total)`, so
 * the selection is unbiased and depends only on `(seed, stream label, draw
 * index)`.
 */
export function sampleLatencyMs(distribution: LatencyDistribution, stream: SeededStream): number {
  let total = 0;
  for (const sample of distribution.samples) total += sample.weight;
  const draw = Number(stream.nextBelow(BigInt(total)));
  let cumulative = 0;
  for (const sample of distribution.samples) {
    cumulative += sample.weight;
    if (draw < cumulative) return sample.milliseconds;
  }
  /* c8 ignore next 2 -- unreachable: `draw < total` and cumulative reaches total. */
  return distribution.samples[distribution.samples.length - 1]?.milliseconds ?? 0;
}

/** One sampled latency budget, component by component. */
export interface SampledLatency {
  readonly decisionMs: number;
  readonly signingMs: number;
  readonly networkMs: number;
  readonly venueMs: number;
  readonly totalMs: number;
  readonly latencyModelVersion: string;
}

/** Draws the four §12.2 components and their total. */
export function sampleLatency(model: LatencyModel, streams: SeededStreams): SampledLatency {
  const decisionMs = sampleLatencyMs(model.decision, streams["latency.decision"]);
  const signingMs = sampleLatencyMs(model.signing, streams["latency.signing"]);
  const networkMs = sampleLatencyMs(model.network, streams["latency.network"]);
  const venueMs = sampleLatencyMs(model.venue, streams["latency.venue"]);
  return ownFrozenTree<SampledLatency>({
    decisionMs,
    signingMs,
    networkMs,
    venueMs,
    totalMs: decisionMs + signingMs + networkMs + venueMs,
    latencyModelVersion: model.latencyModelVersion,
  });
}
