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
 * - It does NOT construct the trading core; it DRIVES one. The core — books,
 *   features, the strategy runtime, risk, the allocator, the planner and the
 *   ledger, wired by `createPaperTrader` — lives in the layer-1 package
 *   `@polymarket-bot/trading-core` (ADR-022), and since `BACKTEST-2` this
 *   app's `run` command builds it itself ({@link ./assembly.js}) and hands
 *   this function the driver's `coreLoop` ({@link ./core-loop.js}: replay
 *   clock → `ingest` → `drain`, the live pump's own order), so every recorded
 *   event reaches the same decision/risk/planning/ledger path the paper
 *   trader runs. At base `1aa2238` the hook below had NO producer anywhere in
 *   the repository (GOV-2B B3); `BACKTEST-1` shipped the driver and
 *   `BACKTEST-2` the executable's own assembly.
 */

import {
  readDatasetManifestBytes,
  readRunPins,
  runReplay,
  simulationRefusal,
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
import { endOfRunBoundTo } from "./core-loop.js";
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
   * {@link ./core-loop.js#replayDrivenCoreLoop} over the real loop — the `run`
   * command's assembly ({@link ./assembly.js}) does. Absent means "verify and
   * drive only" — the base-`1aa2238` behaviour, kept for `verify`.
   *
   * `FOLD-1` (`FOLD1-R1-3`): the driver BINDS the core's end-of-run
   * accounting rebuild check to the `coreLoop` it builds, and this run calls
   * it ONCE when the replay returns — completed or refused part-way — so a
   * caller cannot drive the core and leave that check out. A backtest core
   * keeps the PAPER cadence (a check every 50 posted fills) plus this one; a
   * mismatch latches the core's own GLOBAL halt, which the caller reads from
   * the core. A `coreLoop` the driver did not build is REFUSED before
   * anything is read (`SIMULATION_INPUT_INVALID`): this run cannot tell
   * whether such a core keeps accounting, so it cannot promise the check.
   */
  readonly coreLoop?: ReplayCoreLoop;
  /**
   * The simulated venue the core submits to. When supplied, `runReplay`
   * positions it at every recorded event (§6 invariant 15) and the §12.4
   * serialization carries its orders, fills, economics and bands — so a
   * replay that produced decisions shows them as bytes, not as a claim.
   */
  readonly venue?: SimulatedVenue;
  /**
   * `BACKTEST-2`: the dataset manifest, already read through its door
   * (`readDatasetManifestBytes`) from THIS directory by a caller that needed
   * it first — the `run` command starts the core's replay clock at the
   * manifest's first recorded instant, before the core exists. Absent, the
   * manifest is read here. Either way every object it pins is read from
   * `datasetDirectory` and verified against its checksum below.
   */
  readonly dataset?: ReplayDataset;
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

  // `FOLD1-R1-3`: a core is driven only with the end-of-run check its driver bound to it.
  const endOfRun = options.coreLoop === undefined ? undefined : endOfRunBoundTo(options.coreLoop);
  if (options.coreLoop !== undefined && endOfRun === undefined) {
    return {
      ok: false,
      refusal: simulationRefusal(
        "SIMULATION_INPUT_INVALID",
        "runBacktest drives a core only through replayDrivenCoreLoop, which binds the core's end-of-run " +
          "accounting rebuild check to the coreLoop it builds; this coreLoop was not built by it, so the run " +
          "could not promise that check (FOLD-1) and is refused before anything is read",
      ),
    };
  }

  const pins = readRunPins(options.runPins);
  if (!pins.ok) return { ok: false, refusal: pins.refusal };

  const dataset: SimulationResult<ReplayDataset> =
    options.dataset === undefined
      ? readDatasetManifestBytes(
          await readManifestBytes(options.datasetDirectory, options.manifestFileName ?? DATASET_MANIFEST_OBJECT_NAME),
        )
      : { ok: true, value: options.dataset };
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
  // `FOLD-1`: the end of the run — the core's final accounting rebuild check,
  // once, whether the replay completed or was refused part-way. The real
  // core's check is total; a check that throws is this run's own failure.
  let endOfRunThrew: string | undefined;
  try {
    endOfRun?.();
  } catch (error) {
    endOfRunThrew = error instanceof Error ? error.name : typeof error;
  }
  if (!result.ok) return { ok: false, refusal: result.refusal };
  if (endOfRunThrew !== undefined) {
    return {
      ok: false,
      refusal: simulationRefusal(
        "SIMULATION_INTERNAL",
        `the core's end-of-run accounting rebuild check threw a ${endOfRunThrew}, so the run cannot be ` +
          "reported as checked (FOLD-1)",
      ),
    };
  }

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
