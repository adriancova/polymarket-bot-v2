/**
 * The backtest run: verify a dataset, replay it deterministically, report.
 *
 * §11: `BACKTEST` is historical replay with a SIMULATED venue and NO credentials.
 * Nothing in this file opens a socket, signs anything, or places an order, and
 * {@link ./safety.js} refuses the process before it gets here if the environment
 * suggests otherwise.
 *
 * What this run does, and what it deliberately does not:
 *
 * - It verifies the dataset against its manifest (checksums, dispatch order,
 *   counts, exclusions), replays every recorded event through the injected
 *   normalizer, positions the injected simulated venue at each one, hands each
 *   one to the injected `coreLoop`, and emits the §12.4 canonical serialization
 *   — which carries the orders, fills and economics that venue produced.
 * - It does NOT construct the trading core, and it cannot. Books, features,
 *   the strategy runtime, risk, the allocator, the planner and the ledger are
 *   wired by `WP-230` into `apps/trader`'s `createPaperTrader`, and
 *   `docs/contracts/dependency-direction.md` §2 rules that nothing may depend on
 *   an app. What this app ships is the DRIVER of that core
 *   ({@link ./core-loop.js}: replay clock → `ingest` → `drain`, the live
 *   pump's own order), so a caller holding both apps hands the real core in
 *   and every recorded event reaches the same decision/risk/planning/ledger
 *   path the paper trader runs. At base `1aa2238` the hook below had NO
 *   producer anywhere in the repository (GOV-2B B3); the composition root's
 *   half of the fix is here, and the fixture-driven proof is
 *   `test/unit/simulation/backtest-static-bracket-replay.test.ts`.
 */

import {
  readDatasetManifestBytes,
  readRunPins,
  runReplay,
  type ReplayCoreLoop,
  type ReplayDataset,
  type ReplayRunPins,
  type ReplayRunResult,
  type ReplayNormalizer,
  type SimulatedVenue,
  type SimulationRefusal,
  type SimulationResult,
} from "@polymarket-bot/simulation";

import { fileSystemArchiveReader, readManifestBytes, sha256Hex } from "./archive.js";
import { BACKTEST_RUN_MODE, checkBacktestSafety, type SafetyViolation } from "./safety.js";

/** The dataset-manifest file name `WP-130` writes. */
export const DATASET_MANIFEST_OBJECT_NAME = "dataset-manifest.json";

/** Inputs to a backtest run. */
export interface BacktestRunOptions {
  /** Directory holding the dataset manifest and its objects. */
  readonly datasetDirectory: string;
  readonly manifestFileName?: string;
  readonly normalizer: ReplayNormalizer;
  readonly runPins: ReplayRunPins;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /**
   * The shared core, driven per recorded event. Build it with
   * {@link ./core-loop.js#replayDrivenCoreLoop} over the real loop. Absent
   * means "verify and drive only" — the base-`1aa2238` behaviour, kept for
   * `verify`, which is what the CLI's own executable still runs today.
   */
  readonly coreLoop?: ReplayCoreLoop;
  /**
   * The simulated venue the core submits to. When supplied, `runReplay`
   * positions it at every recorded event (§6 invariant 15) and the §12.4
   * serialization carries its orders, fills, economics and bands — so a
   * replay that produced decisions shows them as bytes, not as a claim.
   */
  readonly venue?: SimulatedVenue;
}

/** What a backtest run produced, or why it did not run. */
export type BacktestOutcome =
  | { readonly ok: true; readonly runMode: typeof BACKTEST_RUN_MODE; readonly result: ReplayRunResult }
  | { readonly ok: false; readonly refusal: SimulationRefusal }
  | { readonly ok: false; readonly safety: readonly SafetyViolation[] };

/** Verifies the environment, then verifies and replays the dataset. */
export async function runBacktest(options: BacktestRunOptions): Promise<BacktestOutcome> {
  const safety = checkBacktestSafety(options.environment);
  if (!safety.ok) {
    return { ok: false, safety: safety.violations };
  }

  const pins = readRunPins(options.runPins);
  if (!pins.ok) return { ok: false, refusal: pins.refusal };

  const manifestBytes = await readManifestBytes(
    options.datasetDirectory,
    options.manifestFileName ?? DATASET_MANIFEST_OBJECT_NAME,
  );
  const dataset: SimulationResult<ReplayDataset> = readDatasetManifestBytes(manifestBytes);
  if (!dataset.ok) return { ok: false, refusal: dataset.refusal };

  const result = await runReplay({
    dataset: dataset.value,
    archive: fileSystemArchiveReader(options.datasetDirectory),
    digestSha256: sha256Hex,
    normalizer: options.normalizer,
    runPins: pins.value,
    ...(options.coreLoop === undefined ? {} : { coreLoop: options.coreLoop }),
    ...(options.venue === undefined ? {} : { venue: options.venue }),
  });
  if (!result.ok) return { ok: false, refusal: result.refusal };

  return { ok: true, runMode: BACKTEST_RUN_MODE, result: result.value };
}

/**
 * Renders the outcome for an operator.
 *
 * The run's own §12.4 serialization is printed verbatim: it is the artifact a
 * determinism claim is made about, so the report must not reformat it.
 */
export function renderBacktestOutcome(outcome: BacktestOutcome): string {
  if (outcome.ok) {
    return [
      `run_mode=${outcome.runMode}`,
      `events_delivered=${String(outcome.result.eventsDelivered)}`,
      `rows_read=${String(outcome.result.load.rowsRead)}`,
      `rows_delivered=${String(outcome.result.load.rowsDelivered)}`,
      `excluded_incident=${String(outcome.result.load.rowsExcludedByIncident)}`,
      `excluded_duplicate=${String(outcome.result.load.rowsExcludedAsDuplicate)}`,
      `objects_verified=${String(outcome.result.load.objectsVerified)}`,
      `wal_segment_verification=${outcome.result.load.walSegmentVerification}`,
      // Two different disagreements, reported separately: recorded ARRIVAL wall
      // clock out of order across the ordered rows, and normalized envelopes
      // whose VENUE timestamp is out of order against recorded dispatch order
      // (§8.4 — replay follows dispatch order and never sorts by venue time).
      `received_at_inversions=${String(outcome.result.load.receivedAtInversions)}`,
      `venue_timestamp_inversions=${String(outcome.result.delivery.venueTimestampInversions)}`,
      `envelopes_without_venue_timestamp=${String(outcome.result.delivery.envelopesWithoutVenueTimestamp)}`,
      "",
      outcome.result.serialization,
    ].join("\n");
  }
  if ("safety" in outcome) {
    return [
      "REFUSED: startup safety validation failed (§6 invariant 17, §11, AGENTS.md)",
      ...outcome.safety.map((violation) => `  ${violation.code}: ${violation.detail}`),
    ].join("\n");
  }
  return [
    `REFUSED: ${outcome.refusal.code}`,
    `  ${outcome.refusal.message}`,
    ...Object.keys(outcome.refusal.details)
      .sort()
      .map((key) => `  ${key}=${String(outcome.refusal.details[key])}`),
  ].join("\n");
}
