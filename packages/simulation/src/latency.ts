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
import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
import {
  describeForRefusal,
  simulationFailure,
  simulationOk,
  totally,
  type SimulationResult,
} from "./refusals.js";
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

/** Validates a distribution. An empty or zero-weight one is refused. Total. */
export function readLatencyDistribution(
  distribution: LatencyDistribution,
  what: string,
): SimulationResult<LatencyDistribution> {
  return totally("reading a latency distribution", () =>
    readLatencyDistributionInner(distribution, what),
  );
}

function readLatencyDistributionInner(
  offered: LatencyDistribution,
  what: string,
): SimulationResult<LatencyDistribution> {
  const component = describeForRefusal(what);
  // D1 (round-2 review, MEDIUM-1): a caller record is materialized before it is
  // read, so a getter is refused without being invoked and a cycle is refused
  // rather than followed until the stack runs out.
  const read = readOwnPlainInput<LatencyDistribution>(offered, `${component}'s latency distribution`);
  if (!read.ok) return read;
  const distribution = read.value;
  if (distribution === null || typeof distribution !== "object") {
    return simulationFailure(
      "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
      `${component} is not a latency distribution`,
      { component },
    );
  }
  if (!Array.isArray(distribution.samples) || distribution.samples.length === 0) {
    return simulationFailure(
      "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
      `${component} has no samples; a latency model with nothing to draw from would silently mean "no latency", which is the Tier-0 assumption §12.2 bounds to wiring use`,
      { component },
    );
  }
  let total = 0;
  for (const sample of distribution.samples) {
    if (sample === null || typeof sample !== "object") {
      return simulationFailure(
        "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
        `${component} carries a sample that is not a record`,
        { component },
      );
    }
    if (!isNonNegativeInteger(sample.milliseconds)) {
      return simulationFailure(
        "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
        `${component} carries a latency that is not a non-negative integer number of milliseconds`,
        { component },
      );
    }
    if (!isPositiveInteger(sample.weight)) {
      return simulationFailure(
        "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
        `${component} carries a weight that is not a positive integer; integer weights are what make the draw exactly reproducible`,
        { component },
      );
    }
    total += sample.weight;
    if (!Number.isSafeInteger(total)) {
      return simulationFailure(
        "FILL_MODEL_LATENCY_DISTRIBUTION_INVALID",
        `${component} has weights that overflow exact integer arithmetic`,
        { component },
      );
    }
  }
  return simulationOk(ownFrozenTree(distribution));
}

/** Validates a whole latency model. Total: no throw escapes. */
export function readLatencyModel(model: LatencyModel): SimulationResult<LatencyModel> {
  return totally("reading the latency model", () => readLatencyModelInner(model));
}

function readLatencyModelInner(offered: LatencyModel): SimulationResult<LatencyModel> {
  // D1 (round-2 review, MEDIUM-1), as in `readLatencyDistribution`.
  const read = readOwnPlainInput<LatencyModel>(offered, "the latency model");
  if (!read.ok) return read;
  const model = read.value;
  if (model === null || typeof model !== "object") {
    return simulationFailure(
      "FILL_MODEL_PARAMETERS_UNPINNED",
      "a latency model is a record naming its version, its four components and its basis (§12.5, ADR-012 §7)",
    );
  }
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
