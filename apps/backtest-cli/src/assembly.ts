/**
 * The backtest executable's OWN assembly of the shared trading core
 * (`BACKTEST-2`; ADR-022 D5; closes blocker B3).
 *
 * Until `BACKTEST-2` this executable could not build the core: `createPaperTrader`
 * lived in `apps/trader`, and an app may not depend on an app
 * (`dependency-direction.md` §2, F10). A test harness built it and handed the
 * driver in. `CORE-MOVE` moved the core into the layer-1 package
 * `@polymarket-bot/trading-core`, and this app now depends on it downward
 * (layer 3 → layer 1, no §2.1 row), so the `run` command builds the SAME core
 * the paper trader builds — the same `createPaperTrader`, over the core's ONE
 * simulated-venue builder — and nothing hands it a core from outside.
 *
 * ## What is swapped, and nothing else (§12.1)
 *
 * | Seam | `apps/trader` (`main.ts`) | this assembly |
 * | --- | --- | --- |
 * | clock | a wall clock | `packages/simulation`'s `ReplayClock`, positioned at the dataset's first recorded instant and advanced only by the driver |
 * | event source | Redis, through `pump` | the recorded dataset, through `runBacktest` → `replayDrivenCoreLoop` |
 * | durable store | `PostgresTraderStore` | the core's PRODUCTION `InMemoryTraderStore`; a backtest's durable output is its artifact |
 * | venue | `buildSimulatedVenue` over the parsed configuration | the same call |
 *
 * ## The startup order (§6 invariant 17 first)
 *
 * 1. **Safety, before anything is read.** Two checks, on the operator's REAL
 *    environment record: this root's own `checkBacktestSafety` (`safety.ts`)
 *    and the core's `checkPaperTraderSafety`, which `createPaperTrader` runs
 *    again on the same record. The core's check is the one that refuses a
 *    production secret NAME by presence (ADR-010 §3 — `POLY_API_KEY` passes
 *    the root's value-triggered pattern scan), so it runs here, before the
 *    manifest, the pins or the configuration are opened.
 * 2. **The configuration door** — the core's `parseTraderConfig`.
 * 3. **The run pins against the configuration (BT1-R2).** The fill model the
 *    venue fills with, the fee snapshot it charges and every instance's run
 *    seed come from the configuration; the §12.4 serialization prints the
 *    run pins. A disagreement would make the artifact's `pins` line a claim
 *    about a run that did not happen, so it is REFUSED, naming every field.
 * 3b. **The evaluation cadence (`CADENCE-1`, ADR-026 D1.3-D1.6).** The run
 *    pins carry `evaluationIntervalMs` and `evaluationHeartbeatMs`, and the
 *    core runs with exactly those. A replay that is not a reproduction uses
 *    exactly 1,000 ms and 5,000 ms; the per-frame value 0 is accepted only
 *    when the caller DECLARES what the replay reproduces (`reproduces`: a
 *    golden or an ADR-024 run; the `run` command's `--reproduces`). Anything
 *    else is REFUSED here, before a core is built.
 * 4. **The replay clock**, at the dataset's first recorded instant, so the
 *    core's constructor reads a recorded value.
 * 5. **The venue, the store, the core, the driver** — in that order, the
 *    venue's holder filled the instant the trader exists (`venue-builder.ts`).
 *
 * ## The run mode (ADR-022 D6; BT1-R5, recorded, not changed)
 *
 * This ROOT runs in `BACKTEST` mode (`safety.ts`). The CORE it builds is the
 * PAPER core: its run-mode constants are the paper trader's, unchanged, and
 * its own safety check accepts `RUN_MODE` only unset or `PAPER`. So a
 * backtest is "the PAPER core driven by recorded events under the BACKTEST
 * root", and the `run` command prints `core_run_mode=PAPER` beside the
 * report's `run_mode=BACKTEST`.
 *
 * SAFETY: no credential, no venue connection, no signer, no order. The venue
 * is `packages/simulation`'s, which refuses `EXECUTION_PROBE`, `LIVE_MICRO`
 * and `LIVE` by name. `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS` and both live-micro
 * caps are read only as floors, by both checks, and never raised.
 */

import {
  createReplayClock,
  readDatasetManifestBytes,
  type RecordedInstant,
  type ReplayClock,
  type ReplayRunPins,
  type SimulatedVenue,
} from "@polymarket-bot/simulation";
import {
  InMemoryTraderStore,
  TRADER_RUN_MODE,
  buildSimulatedVenue,
  checkPaperTraderSafety,
  createPaperTrader,
  evaluationCadenceProblem,
  parseTraderConfig,
  type EvaluationCadenceOption,
  type AccountingChecks,
  type PaperTrader,
  type TraderConfig,
} from "@polymarket-bot/trading-core";

import { readManifestBytes, sha256Hex } from "./archive.js";
import {
  recordFraming,
  replayDrivenCoreLoop,
  type ReplayDrivenCoreLoop,
  type ReplayDriverObservations,
  type ReplayFraming,
} from "./core-loop.js";
import { NORMALIZED_ENVELOPE_NORMALIZER_VERSION, normalizedEnvelopeNormalizer } from "./normalizer.js";
import { DATASET_MANIFEST_OBJECT_NAME, runBacktest, type BacktestOutcome } from "./run.js";
import { checkBacktestSafety } from "./safety.js";

/** The run mode of the core this root builds (ADR-022 D6; BT1-R5). Not the root's. */
export const BACKTEST_CORE_RUN_MODE = TRADER_RUN_MODE;

/** Why the assembly, or the run around it, refused before a core was driven. */
export interface BacktestRefusal {
  readonly code:
    | "BACKTEST_UNSAFE_ENVIRONMENT"
    | "BACKTEST_NORMALIZER_NOT_SUPPORTED"
    | "BACKTEST_DATASET_REFUSED"
    | "BACKTEST_CONFIG_REFUSED"
    | "BACKTEST_PINS_DISAGREE_WITH_CONFIG"
    | "BACKTEST_CADENCE_REFUSED"
    | "BACKTEST_VENUE_REFUSED"
    | "BACKTEST_CORE_REFUSED";
  readonly detail: string;
  readonly issues: readonly string[];
}

function refuse(
  code: BacktestRefusal["code"],
  detail: string,
  issues: readonly string[] = [],
): { readonly ok: false; readonly refusal: BacktestRefusal } {
  return { ok: false, refusal: { code, detail, issues } };
}

/**
 * Startup safety validation for a process that builds the core: the root's
 * own check AND the core's, on the same record. Pure; reads only `env`.
 */
export function checkBacktestCoreSafety(
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true } | { readonly ok: false; readonly violations: readonly string[] } {
  const root = checkBacktestSafety(env);
  const core = checkPaperTraderSafety(env);
  const violations = [
    ...(root.ok ? [] : root.violations.map((violation) => `${violation.code}: ${violation.detail}`)),
    ...(core.ok ? [] : core.violations.map((violation) => `${violation.code}: ${violation.detail}`)),
  ];
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

function unsafe(violations: readonly string[]): { readonly ok: false; readonly refusal: BacktestRefusal } {
  return refuse(
    "BACKTEST_UNSAFE_ENVIRONMENT",
    "startup safety validation failed (§6 invariant 17, §11, §15, AGENTS.md); nothing was read and no " +
      "core was built",
    violations,
  );
}

/**
 * BT1-R2 — every run pin the core's configuration ALSO states, compared by
 * exact string equality. Answers one line per disagreement (empty when they
 * agree). Pure.
 *
 * - `fillModelVersion` and `fillModelParametersHash` ↔ `simulation.*`: the
 *   venue's fill model is built from the configuration (`venue-builder.ts`),
 *   and every simulated fill carries its version;
 * - `feeSnapshotVersion` ↔ `simulation.feeSchedule.snapshotVersion`: the fee
 *   snapshot the venue charges;
 * - `runSeed` ↔ EVERY instance's `runSeed`: a run has one seed (§12.5).
 */
export function reconcileRunPinsWithCoreConfig(pins: ReplayRunPins, config: TraderConfig): readonly string[] {
  const mismatches: string[] = [];
  const compare = (pin: string, pinned: string, field: string, configured: string): void => {
    if (pinned !== configured) {
      mismatches.push(
        `${pin}: the run pins say ${JSON.stringify(pinned)} and the core's configuration says ` +
          `${JSON.stringify(configured)} (${field})`,
      );
    }
  };
  compare("fillModelVersion", pins.fillModelVersion, "simulation.fillModelVersion", config.simulation.fillModelVersion);
  compare(
    "fillModelParametersHash",
    pins.fillModelParametersHash,
    "simulation.fillModelParametersHash",
    config.simulation.fillModelParametersHash,
  );
  compare(
    "feeSnapshotVersion",
    pins.feeSnapshotVersion,
    "simulation.feeSchedule.snapshotVersion",
    config.simulation.feeSchedule.snapshotVersion,
  );
  for (const instance of config.instances) {
    compare("runSeed", pins.runSeed, `instances[${instance.instanceId}].runSeed`, instance.runSeed);
  }
  return mismatches;
}

/**
 * `main.ts`'s identifier namespace, for a caller that states none: the
 * instances' run ids, joined — so two runs of one configuration mint the same
 * ids (§12.4).
 */
export function defaultIdNamespace(config: TraderConfig): string {
  return config.instances.map((instance) => instance.runId).join("|");
}

/** Inputs to {@link assembleBacktestCore}. No core: the assembly builds its own. */
export interface BacktestCoreOptions {
  /** The operator's environment record — checked, then handed to the core, which checks it again. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The operator configuration document, unparsed; the core's door parses it. */
  readonly traderConfig: unknown;
  /** The §12.5 run pins, already through `readRunPins`. */
  readonly runPins: ReplayRunPins;
  /** Where the replay clock starts: the dataset's first recorded instant. */
  readonly clockStart: RecordedInstant;
  /** The identifier namespace; {@link defaultIdNamespace} when absent. */
  readonly idNamespace?: string;
  /**
   * `FOLD-1`: the core's rebuild-check cadence. Absent: the PAPER cadence a
   * real backtest keeps (`run` never sets it); the replay suite passes the
   * every-fill cadence in code (orchestrator call O1).
   */
  readonly accountingChecks?: AccountingChecks;
  /**
   * `CADENCE-1` (ADR-026 D1.6): what this replay REPRODUCES — a golden or a run
   * recorded under ADR-024 — or absent for a replay that reproduces nothing.
   * Only a declared reproduction may run the per-frame value 0 its pins state.
   * 1-256 printable ASCII characters without a space; the artifact prints it.
   */
  readonly reproduces?: string;
  /** Where the venue's policy logs an unresolvable time-in-force. */
  readonly log?: (line: string) => void;
}

/**
 * `CADENCE-1` (ADR-026 D1.3-D1.6): the evaluation cadence a replay runs with —
 * its run pins' two values, and what it reproduces when it declares that. Pure.
 */
export function replayEvaluationCadence(pins: ReplayRunPins, reproduces: string | undefined): EvaluationCadenceOption {
  return {
    intervalMs: pins.evaluationIntervalMs,
    heartbeatMs: pins.evaluationHeartbeatMs,
    ...(reproduces === undefined ? {} : { reproduces }),
  };
}

/** What the assembly built. */
export interface BacktestCore {
  readonly trader: PaperTrader;
  readonly venue: SimulatedVenue;
  readonly store: InMemoryTraderStore;
  readonly clock: ReplayClock;
  /** The driver over `trader.loop`, bound to its clock and its halt latch. */
  readonly driver: ReplayDrivenCoreLoop;
  readonly idNamespace: string;
  /**
   * `THROUGHPUT-2`: the driver's record framing; a run hands the replay
   * `framing.wrap(normalizer)` so the driver drains once per recorded frame.
   */
  readonly framing: ReplayFraming;
}

export type BacktestCoreAssembly =
  | { readonly ok: true; readonly core: BacktestCore }
  | { readonly ok: false; readonly refusal: BacktestRefusal };

/** Builds the shared core for a backtest, or refuses. Total: never throws. */
export function assembleBacktestCore(options: BacktestCoreOptions): BacktestCoreAssembly {
  // --- 1. safety, before anything is read ---------------------------------
  const safety = checkBacktestCoreSafety(options.environment);
  if (!safety.ok) return unsafe(safety.violations);

  // --- 2. the configuration door ------------------------------------------
  const parsed = parseTraderConfig(options.traderConfig);
  if (!parsed.ok) {
    return refuse("BACKTEST_CONFIG_REFUSED", parsed.refusal.detail, parsed.refusal.issues);
  }
  const config = parsed.config;

  // --- 3. BT1-R2: the run pins against the configuration --------------------
  const mismatches = reconcileRunPinsWithCoreConfig(options.runPins, config);
  if (mismatches.length > 0) {
    return refuse(
      "BACKTEST_PINS_DISAGREE_WITH_CONFIG",
      "the run pins and the core's configuration disagree; the artifact would print pins the core did " +
        "not run with (ADR-012 §4: a result whose fill-model parameters are not pinned is not evidence), " +
        "so the run is refused before a core is built",
      mismatches,
    );
  }

  // --- 3b. CADENCE-1: the evaluation cadence the pins state (ADR-026 D1) ----
  const cadence = replayEvaluationCadence(options.runPins, options.reproduces);
  const cadenceProblem = evaluationCadenceProblem(cadence);
  if (cadenceProblem !== undefined) {
    return refuse(
      "BACKTEST_CADENCE_REFUSED",
      "the evaluation cadence the run pins state is refused: a replay that is not a reproduction uses exactly " +
        "1000 ms and 5000 ms, and the per-frame value 0 needs a declared reproduction (ADR-026 D1.5-D1.6; the " +
        "run command's --reproduces); no core was built",
      [cadenceProblem],
    );
  }

  // --- 4. the replay clock --------------------------------------------------
  const clock = createReplayClock(options.clockStart);
  if (!clock.ok) {
    return refuse(
      "BACKTEST_DATASET_REFUSED",
      `the replay clock refused the dataset's first recorded instant (${clock.refusal.code}: ${clock.refusal.message})`,
    );
  }

  // --- 5. the venue, the store, the core, the driver ------------------------
  const built = buildSimulatedVenue({
    clock: clock.value,
    settings: config.simulation,
    startingCash: config.accounting.startingCash,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  if (!built.ok) {
    return refuse(
      "BACKTEST_VENUE_REFUSED",
      `the configured fee snapshot was refused by the simulator (${built.refusal.code}: ` +
        `${built.refusal.message}); a run without a valid fee snapshot cannot charge a fee (§6 invariant 9)`,
    );
  }
  const store = new InMemoryTraderStore();
  const idNamespace = options.idNamespace ?? defaultIdNamespace(config);
  const created = createPaperTrader({
    env: options.environment,
    config: options.traderConfig,
    clock: clock.value,
    // UNCAST, as `main.ts` hands it: the venue satisfies the loop's port.
    venue: built.venue,
    store,
    idNamespace,
    ...(options.accountingChecks === undefined ? {} : { accountingChecks: options.accountingChecks }),
    // `CADENCE-1`: the pinned cadence, checked above; the core checks it again.
    evaluationCadence: cadence,
    ...(options.log === undefined
      ? {}
      : {
          onCadenceAlarm: (alarm) => {
            options.log?.(
              `CADENCE CLOCK ${alarm.kind === "RAISED" ? "FORWARD JUMP" : "CAUGHT UP"}: event ${alarm.eventAt} lies ` +
                `${String(alarm.behindMs)} ms behind the event clock ${alarm.clockAt} (bound ${String(alarm.boundMs)} ms; ` +
                "ADR-026 D2.10)",
            );
          },
        }),
  });
  if (!created.ok) {
    return refuse(
      "BACKTEST_CORE_REFUSED",
      `${created.refusal.code}: ${created.refusal.detail}`,
      created.refusal.issues,
    );
  }
  built.wiring.trader = created.trader;

  // `THROUGHPUT-2` (ADR-024): the driver drains once per recorded frame; the
  // run hands the replay `framing.wrap(normalizer)` so the framing can tell.
  const framing = recordFraming();
  const driver = replayDrivenCoreLoop({
    loop: created.trader.loop,
    clock: clock.value,
    // BT1-R3: the core's own halt latch, as `pump.ts` is handed it.
    halts: created.trader.halts,
    framing,
  });
  return {
    ok: true,
    core: { trader: created.trader, venue: built.venue, store, clock: clock.value, driver, idNamespace, framing },
  };
}

/** Inputs to {@link runBacktestCore}. No core: the run builds its own. */
export interface BacktestCoreRunOptions extends Omit<BacktestCoreOptions, "clockStart"> {
  /** Directory holding the dataset manifest and its objects. */
  readonly datasetDirectory: string;
  readonly manifestFileName?: string;
}

/** A backtest that ran — completed, or refused part-way — and the core it ran. */
export interface BacktestCoreRun {
  readonly outcome: BacktestOutcome;
  readonly core: BacktestCore;
  readonly driver: ReplayDriverObservations;
}

export type BacktestCoreRunResult =
  | { readonly ok: true; readonly run: BacktestCoreRun }
  | { readonly ok: false; readonly refusal: BacktestRefusal };

/**
 * The whole backtest, in memory: safety, the dataset manifest, the core's
 * assembly, and the shipped `runBacktest` driving it through
 * `replayDrivenCoreLoop`. What the `run` command runs, and what the replay
 * suite drives (`test/unit/simulation/backtest-static-bracket-replay.test.ts`).
 *
 * A refusal here means no core was driven. A run that STARTED answers
 * `ok: true` with its `outcome`, which may itself be a refusal (a tampered
 * object, a halted core — BT1-R3); the core is returned either way so a
 * caller can read what it did.
 */
export async function runBacktestCore(options: BacktestCoreRunOptions): Promise<BacktestCoreRunResult> {
  // --- 1. safety, before the manifest is read -------------------------------
  const safety = checkBacktestCoreSafety(options.environment);
  if (!safety.ok) return unsafe(safety.violations);

  // --- 2. the one normalizer that yields what the core consumes -------------
  if (options.runPins.normalizerVersion !== NORMALIZED_ENVELOPE_NORMALIZER_VERSION) {
    return refuse(
      "BACKTEST_NORMALIZER_NOT_SUPPORTED",
      `run drives the core, which consumes the normalized §7.4 stream; the run pins name ` +
        `${JSON.stringify(options.runPins.normalizerVersion)}, and the one shipped normalizer that ` +
        `replays that stream from a recording is ${JSON.stringify(NORMALIZED_ENVELOPE_NORMALIZER_VERSION)} ` +
        "(verify runs any pinned normalizer, with no core)",
    );
  }

  // --- 3. the manifest: the replay clock starts at its first instant --------
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await readManifestBytes(
      options.datasetDirectory,
      options.manifestFileName ?? DATASET_MANIFEST_OBJECT_NAME,
    );
  } catch (error) {
    return refuse(
      "BACKTEST_DATASET_REFUSED",
      `the dataset manifest could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const dataset = readDatasetManifestBytes(manifestBytes);
  if (!dataset.ok) {
    return refuse("BACKTEST_DATASET_REFUSED", `${dataset.refusal.code}: ${dataset.refusal.message}`);
  }
  const first = dataset.value.firstEvent;
  if (first === null) {
    return refuse(
      "BACKTEST_DATASET_REFUSED",
      "the dataset records no event, so there is no recorded instant to start the core's clock at and " +
        "nothing to drive it with",
    );
  }

  // --- 4. the core ----------------------------------------------------------
  const assembled = assembleBacktestCore({
    environment: options.environment,
    traderConfig: options.traderConfig,
    runPins: options.runPins,
    // The core's clock starts at the first recorded instant; its monotonic
    // origin is 0 and the driver advances it to each record's own
    // `receivedMonotonicNs` before the core reads it (BT1-R6).
    clockStart: { receivedAt: first.receivedAt, receivedMonotonicNs: "0" },
    ...(options.idNamespace === undefined ? {} : { idNamespace: options.idNamespace }),
    ...(options.accountingChecks === undefined ? {} : { accountingChecks: options.accountingChecks }),
    ...(options.reproduces === undefined ? {} : { reproduces: options.reproduces }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  if (!assembled.ok) return assembled;
  const core = assembled.core;

  // --- 5. the shipped root drives it ----------------------------------------
  const outcome = await runBacktest({
    datasetDirectory: options.datasetDirectory,
    ...(options.manifestFileName === undefined ? {} : { manifestFileName: options.manifestFileName }),
    normalizer: core.framing.wrap(normalizedEnvelopeNormalizer(sha256Hex)),
    runPins: options.runPins,
    environment: options.environment,
    coreLoop: core.driver.coreLoop,
    venue: core.venue,
    dataset: dataset.value,
  });
  return { ok: true, run: { outcome, core, driver: core.driver.observations() } };
}
