/**
 * `apps/backtest-cli` executable entry (ADR-018: app-local esbuild bundle).
 *
 * SAFETY (§11, §6 invariant 17, ADR-010, `AGENTS.md`): this process runs in
 * `BACKTEST` mode against a SIMULATED venue. It holds no credential, opens no
 * venue connection, signs nothing, and places no order. It never reads, defaults
 * or raises `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`, or either live-micro cap —
 * {@link ./safety.js} treats all four as a floor and REFUSES to start if the
 * environment tries to raise them or supplies anything that looks like a key.
 *
 * Usage:
 *
 * ```text
 * backtest-cli verify --dataset <dir> --pins <run-pins.json>
 * backtest-cli run --dataset <dir> --pins <run-pins.json> --config <trader-config.json>
 *                  --artifact <file> [--id-namespace <namespace>]
 * backtest-cli approx-run --store <dir> --manifests <key>[,<key>...]
 *                  --gamma-markets <marketId>=<gammaMarketId>[,...] --pins <run-pins.json>
 *                  --config <trader-config.json> --artifact <file> [--id-namespace <namespace>]
 * ```
 *
 * `verify` reads the dataset manifest, verifies every pinned object's checksum,
 * reconciles the dispatch ordinals, counts and exclusions against the manifest's
 * own numbers, replays every recorded frame through the normalizer the run
 * pins name ({@link normalizerFor}), and prints the §12.4 canonical
 * serialization. It drives NO core: it is verification and the venue-free
 * replay, over any dataset.
 *
 * `run` (`BACKTEST-2`) is the backtest. It runs startup safety validation
 * FIRST, before any file is opened (§6 invariant 17: this root's own check and
 * the core's), then reads the run pins and the operator configuration, BUILDS
 * the shared trading core itself (`assembly.ts`: the core's
 * `createPaperTrader` over its ONE simulated-venue builder and its production
 * in-memory store, on a replay clock), drives it through the shipped
 * `runBacktest` + `replayDrivenCoreLoop`, and writes the artifact
 * (`artifact.ts`) to `--artifact`, never over an existing file. It takes no
 * core from its caller. `--id-namespace` is the seed every derived identifier
 * is minted from; absent, it is the instances' run ids joined, as the paper
 * trader derives it. Over the committed fixture
 * `test/replay-golden/backtest/static-bracket/` with
 * `--id-namespace backtest-1-static-bracket-replay`, the artifact is
 * byte-identical to that directory's `expected-artifact.txt`.
 *
 * The artifact and the report are SIMULATED: every fill is
 * `SIMULATED_NOT_REAL_EVIDENCE`, and the report says `core_run_mode=PAPER`
 * beside the root's `run_mode=BACKTEST` (ADR-022 D6; BT1-R5).
 *
 * `approx-run` (`APPROX-REPLAY-1`, ADR-029) is the APPROXIMATE backtest: the
 * same core, driven by a verified research-tier dataset of one gateway epoch
 * (`approximate/`). Every line it prints and every line of the artifact it
 * writes is labelled with the manifests' `fidelity` (`approximate`); it is
 * never determinism, calibration, promotion or soak evidence. `verify` and
 * `run` stay exact: both refuse an approximate manifest
 * (`REPLAY_MANIFEST_APPROXIMATE`). A replay across gateway epochs stops and
 * asks (exit {@link EXIT_ASK}).
 */

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import {
  parseStrictJsonBytes,
  readRunPins,
  type ReplayNormalizer,
  type ReplayRunPins,
} from "@polymarket-bot/simulation";
import { fileSystemObjectStore } from "@polymarket-bot/storage-parquet";

import { sha256Hex } from "./archive.js";
import { renderBacktestArtifact } from "./artifact.js";
import { BACKTEST_CORE_RUN_MODE, checkBacktestCoreSafety, runBacktestCore, type BacktestRefusal } from "./assembly.js";
import {
  NORMALIZED_ENVELOPE_NORMALIZER_VERSION,
  normalizedEnvelopeNormalizer,
  recordedFrameNormalizer,
} from "./normalizer.js";
import { renderBacktestOutcome, runBacktest } from "./run.js";
import { runApproximateBacktest, type ApproximateRunRefusal } from "./approximate/run.js";
import {
  fidelityLine,
  renderApproximateArtifact,
  serializeApproximateRun,
} from "./approximate/serialize.js";

/**
 * The shipped normalizer the run pins name, or the verification-only one.
 *
 * The pin is what a dataset and a run agree on (§6 invariant 9), and the
 * replay's pin door refuses a disagreement by name — so an unrecognised
 * version is NOT an error here: it falls to the passthrough, whose own
 * version then fails the pin reconciliation with both values printed, which
 * is the base-`1aa2238` behaviour for every dataset that pins something
 * else. `polymarketMarketNormalizer` is not selectable from the executable
 * because it needs a market directory this command has no option for.
 */
export function normalizerFor(pins: ReplayRunPins): ReplayNormalizer {
  if (pins.normalizerVersion === NORMALIZED_ENVELOPE_NORMALIZER_VERSION) {
    return normalizedEnvelopeNormalizer(sha256Hex);
  }
  return recordedFrameNormalizer(sha256Hex);
}

/** Exit codes, so an operator's script can branch. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
/**
 * `run` only: the core latched a halt (BT1-R3) — the replay stopped where the
 * live pump returns `HALTED`, or the end-of-run accounting check latched one
 * over a completed run. The paper trader's `EXIT_CODES.halted` value.
 */
export const EXIT_HALTED = 75;
/**
 * `approx-run` only: the replay STOPPED AND ASKS (ADR-029 Decision 5.4,
 * wal-format.md §12.1). The datasets span more than one gateway epoch, and no
 * recorded evidence orders one epoch against another; nothing was replayed.
 */
export const EXIT_ASK = 4;

/** The usage lines, printed on any usage error. */
export const USAGE_LINES: readonly string[] = Object.freeze([
  "usage: backtest-cli verify --dataset <dir> --pins <run-pins.json>",
  "       backtest-cli run --dataset <dir> --pins <run-pins.json> --config <trader-config.json> " +
    "--artifact <file> [--id-namespace <namespace>]",
  "       backtest-cli approx-run --store <dir> --manifests <key>[,<key>...] " +
    "--gamma-markets <marketId>=<gammaMarketId>[,...] --pins <run-pins.json> --config <trader-config.json> " +
    "--artifact <file> [--id-namespace <namespace>]",
]);

interface ParsedArguments {
  readonly command: string;
  readonly options: Readonly<Record<string, string>>;
}

/** Parses `command --key value` argument vectors. Total: never throws. */
export function parseArguments(argv: readonly string[]): ParsedArguments | { readonly usage: string } {
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith("--")) {
    return { usage: "a command is required: verify, run or approx-run" };
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      return { usage: `option ${String(key)} needs a value` };
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

async function readPinsFile(path: string): Promise<ReplayRunPins | { readonly problem: string }> {
  const buffer = await readFile(path);
  const parsed = parseStrictJsonBytes(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  if (!parsed.ok) {
    return { problem: `the run-pins file is not strict JSON: ${parsed.problem.problem}` };
  }
  const pins = readRunPins(parsed.value);
  if (!pins.ok) return { problem: `${pins.refusal.code}: ${pins.refusal.message}` };
  return pins.value;
}

/**
 * Reads a JSON document under the ADR-017 §3 strict profile (the reader the
 * run pins use), or says why not. A file that cannot be read is a problem,
 * not an exception.
 */
async function readStrictJsonFile(
  path: string,
  what: string,
): Promise<{ readonly value: unknown } | { readonly problem: string }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    return { problem: `the ${what} could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = parseStrictJsonBytes(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  if (!parsed.ok) return { problem: `the ${what} is not strict JSON: ${parsed.problem.problem}` };
  return { value: parsed.value };
}

function refusalLines(refusal: BacktestRefusal): string[] {
  return [`REFUSED: ${refusal.code}: ${refusal.detail}`, ...refusal.issues.map((issue) => `  ${issue}`)];
}

interface CliIo {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * The `run` command. Safety FIRST — before the pins, the configuration or the
 * dataset is opened — then the core's own assembly, the run, the artifact.
 */
async function runCommand(options: Readonly<Record<string, string>>, io: CliIo): Promise<number> {
  const datasetDirectory = options["dataset"];
  const pinsPath = options["pins"];
  const configPath = options["config"];
  const artifactPath = options["artifact"];
  if (
    datasetDirectory === undefined ||
    pinsPath === undefined ||
    configPath === undefined ||
    artifactPath === undefined
  ) {
    io.err("backtest-cli: run needs --dataset, --pins, --config and --artifact");
    for (const line of USAGE_LINES) io.err(line);
    return EXIT_USAGE;
  }
  const known = new Set(["dataset", "pins", "config", "artifact", "id-namespace"]);
  const unknown = Object.keys(options).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    io.err(`backtest-cli: run does not take ${unknown.map((key) => `--${key}`).join(", ")}`);
    for (const line of USAGE_LINES) io.err(line);
    return EXIT_USAGE;
  }

  // --- 1. §6 invariant 17: nothing is opened before this --------------------
  const safety = checkBacktestCoreSafety(io.environment);
  if (!safety.ok) {
    io.err("REFUSED: startup safety validation failed (§6 invariant 17, §11, §15, AGENTS.md); no file was read and no core was built");
    for (const violation of safety.violations) io.err(`  ${violation}`);
    return EXIT_REFUSED;
  }

  // --- 2. the run pins and the operator configuration ------------------------
  let pins: ReplayRunPins | { readonly problem: string };
  try {
    pins = await readPinsFile(pinsPath);
  } catch (error) {
    pins = { problem: `the run-pins file could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if ("problem" in pins) {
    io.err(`backtest-cli: ${pins.problem}`);
    return EXIT_REFUSED;
  }
  const config = await readStrictJsonFile(configPath, "trader configuration");
  if ("problem" in config) {
    io.err(`backtest-cli: ${config.problem}`);
    return EXIT_REFUSED;
  }

  // --- 3. the core, built HERE, and the run ---------------------------------
  const idNamespace = options["id-namespace"];
  const started = await runBacktestCore({
    environment: io.environment,
    traderConfig: config.value,
    runPins: pins,
    datasetDirectory,
    ...(idNamespace === undefined ? {} : { idNamespace }),
    log: io.err,
  });
  if (!started.ok) {
    for (const line of refusalLines(started.refusal)) io.err(line);
    return EXIT_REFUSED;
  }
  const { outcome, core, driver } = started.run;
  const halts = core.trader.halts
    .records()
    .map((record) => `${record.code}@${record.scope.kind}`)
    .join(",");
  try {
    if (!outcome.ok) {
      io.err(renderBacktestOutcome(outcome));
      if (core.trader.halts.anyHalt) {
        io.err(`HALTED: the core latched ${halts}; the replay stopped where the live pump returns HALTED (BT1-R3)`);
        return EXIT_HALTED;
      }
      return EXIT_REFUSED;
    }

    // --- 4. the artifact --------------------------------------------------------
    const artifact = renderBacktestArtifact({ outcome, trader: core.trader, store: core.store, driver });
    if (!artifact.ok) {
      io.err(`REFUSED: no artifact was written: ${artifact.problem}`);
      return EXIT_REFUSED;
    }
    const bytes = new Uint8Array(Buffer.from(artifact.text, "utf8"));
    try {
      // `wx`: an artifact is evidence, and a run never overwrites one.
      await writeFile(artifactPath, bytes, { flag: "wx" });
    } catch (error) {
      io.err(
        `REFUSED: the artifact could not be written to ${artifactPath} ` +
          `(${error instanceof Error ? error.message : String(error)}); run never overwrites an existing file`,
      );
      return EXIT_REFUSED;
    }
    io.out(renderBacktestOutcome(outcome));
    io.out("");
    io.out(`core_run_mode=${BACKTEST_CORE_RUN_MODE}`);
    io.out("evidence=SIMULATED_NOT_REAL_EVIDENCE");
    io.out(`id_namespace=${core.idNamespace}`);
    io.out(`halts=${halts}`);
    io.out(`artifact=${artifactPath}`);
    io.out(`artifact_bytes=${String(bytes.byteLength)}`);
    io.out(`artifact_sha256=${sha256Hex(bytes)}`);
    // FOLD-1: a completed run whose end-of-run check latched a halt is written
    // (its health line shows the halt) and exits halted, as the paper trader does.
    return core.trader.halts.anyHalt ? EXIT_HALTED : EXIT_OK;
  } finally {
    await core.store.close();
  }
}

/** `--gamma-markets a=1,b=2` → the map, or why it is not one. */
export function parseGammaMarkets(value: string): ReadonlyMap<string, string> | { readonly problem: string } {
  const map = new Map<string, string>();
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    const marketId = separator < 0 ? "" : entry.slice(0, separator);
    const gammaMarketId = separator < 0 ? "" : entry.slice(separator + 1);
    if (marketId === "" || gammaMarketId === "" || map.has(marketId)) {
      return { problem: `--gamma-markets takes <marketId>=<gammaMarketId>[,...] with each market once; got ${JSON.stringify(entry)}` };
    }
    map.set(marketId, gammaMarketId);
  }
  return map;
}

function approximateRefusalLines(refusal: ApproximateRunRefusal): { readonly lines: string[]; readonly code: number } {
  // Labelled from the manifests once one verified; before that there is no
  // approximate output to label, and the line says so.
  const label = refusal.fidelity === undefined ? "" : `${refusal.fidelity} `;
  const unlabelled = refusal.fidelity === undefined ? " (no research-tier manifest verified, so this refusal carries no fidelity label)" : "";
  if (refusal.code === "APPROX_REPLAY_CROSS_EPOCH") {
    return {
      code: EXIT_ASK,
      lines: [
        `${label}ASK: ${refusal.code}: ${refusal.detail}`,
        ...refusal.issues.map((issue) => `${label}  ${issue}`),
        `${label}QUESTION: replay each gateway epoch separately (one --manifests list per epoch), or first record ` +
          "evidence that orders the epochs and amend ADR-004 (wal-format.md §12.1 rule 5)? Nothing was replayed.",
      ],
    };
  }
  return {
    code: EXIT_REFUSED,
    lines: [`${label}REFUSED: ${refusal.code}: ${refusal.detail}${unlabelled}`, ...refusal.issues.map((issue) => `${label}  ${issue}`)],
  };
}

/**
 * The `approx-run` command (`APPROX-REPLAY-1`). Safety FIRST, then the pins
 * and the configuration, then the research tier through its verifier, the
 * core's own assembly, the run and the artifact. Every line printed after a
 * manifest verified starts with the manifests' fidelity.
 */
async function approximateRunCommand(options: Readonly<Record<string, string>>, io: CliIo): Promise<number> {
  const required = ["store", "manifests", "gamma-markets", "pins", "config", "artifact"];
  const missing = required.filter((key) => options[key] === undefined);
  if (missing.length > 0) {
    io.err(`backtest-cli: approx-run needs ${missing.map((key) => `--${key}`).join(", ")}`);
    for (const line of USAGE_LINES) io.err(line);
    return EXIT_USAGE;
  }
  const known = new Set([...required, "id-namespace"]);
  const unknown = Object.keys(options).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    io.err(`backtest-cli: approx-run does not take ${unknown.map((key) => `--${key}`).join(", ")}`);
    for (const line of USAGE_LINES) io.err(line);
    return EXIT_USAGE;
  }
  const gammaMarkets = parseGammaMarkets(options["gamma-markets"] as string);
  if ("problem" in gammaMarkets) {
    io.err(`backtest-cli: ${gammaMarkets.problem}`);
    return EXIT_USAGE;
  }
  const manifestObjectKeys = (options["manifests"] as string).split(",");

  // --- 1. §6 invariant 17: nothing is opened before this --------------------
  const safety = checkBacktestCoreSafety(io.environment);
  if (!safety.ok) {
    io.err("REFUSED: startup safety validation failed (§6 invariant 17, §11, §15, AGENTS.md); no file was read and no core was built");
    for (const violation of safety.violations) io.err(`  ${violation}`);
    return EXIT_REFUSED;
  }

  // --- 2. the run pins and the operator configuration ------------------------
  const pins = await readStrictJsonFile(options["pins"] as string, "run-pins file");
  if ("problem" in pins) {
    io.err(`backtest-cli: ${pins.problem}`);
    return EXIT_REFUSED;
  }
  const config = await readStrictJsonFile(options["config"] as string, "trader configuration");
  if ("problem" in config) {
    io.err(`backtest-cli: ${config.problem}`);
    return EXIT_REFUSED;
  }

  // --- 3. the research tier, the core, the run --------------------------------
  const idNamespace = options["id-namespace"];
  const started = await runApproximateBacktest({
    environment: io.environment,
    traderConfig: config.value,
    runPins: pins.value,
    objectStore: fileSystemObjectStore(options["store"] as string),
    manifestObjectKeys,
    gammaMarketIds: gammaMarkets,
    ...(idNamespace === undefined ? {} : { idNamespace }),
    log: io.err,
  });
  if (!started.ok) {
    const refused = approximateRefusalLines(started.refusal);
    for (const line of refused.lines) io.err(line);
    return refused.code;
  }
  const { outcome, core, driver, fidelity } = started.run;
  const label = (line: string): string => `${fidelity} ${line}`;
  const halts = core.trader.halts
    .records()
    .map((record) => `${record.code}@${record.scope.kind}`)
    .join(",");
  try {
    if (!outcome.ok) {
      io.err(label(fidelityLine(fidelity)));
      io.err(label(`STOPPED: ${outcome.refusal.code}: ${outcome.refusal.message}`));
      for (const key of Object.keys(outcome.refusal.details).sort()) {
        io.err(label(`  ${key}=${String(outcome.refusal.details[key])}`));
      }
      io.err(label(`release_frames_read=${String(started.run.source.releaseFrames.length)}`));
      if (core.trader.halts.anyHalt) {
        io.err(label(`HALTED: the core latched ${halts}; the replay stopped where the live pump returns HALTED (BT1-R3)`));
        return EXIT_HALTED;
      }
      return EXIT_REFUSED;
    }

    // --- 4. the artifact: approximate, labelled on every line -------------------
    const artifact = renderApproximateArtifact({ result: outcome.result, trader: core.trader, store: core.store, driver });
    if (!artifact.ok) {
      io.err(label(`REFUSED: no artifact was written: ${artifact.problem}`));
      return EXIT_REFUSED;
    }
    const bytes = new Uint8Array(Buffer.from(artifact.text, "utf8"));
    try {
      await writeFile(options["artifact"] as string, bytes, { flag: "wx" });
    } catch (error) {
      io.err(
        label(
          `REFUSED: the artifact could not be written to ${options["artifact"] as string} ` +
            `(${error instanceof Error ? error.message : String(error)}); approx-run never overwrites an existing file`,
        ),
      );
      return EXIT_REFUSED;
    }
    const health = core.trader.loop.health();
    io.out(label(fidelityLine(fidelity)));
    for (const statement of outcome.result.source.admissibility) io.out(label(`admissibility=${statement}`));
    io.out(label(`run_mode=${outcome.result.runMode}`));
    io.out(label(`core_run_mode=${BACKTEST_CORE_RUN_MODE}`));
    io.out(label(`release_frames=${String(outcome.result.source.releaseFrames.length)}`));
    io.out(label(`release_frames_delivered=${String(outcome.result.releaseFramesDelivered)}`));
    io.out(label(`samples_read=${String(outcome.result.source.samplesRead)}`));
    io.out(label(`envelopes_delivered=${String(outcome.result.envelopesDelivered)}`));
    io.out(label(`decisions_persisted=${String(health.loop.decisionsPersisted)}`));
    io.out(label(`risk_evaluations=${String(health.risk.evaluations)}`));
    io.out(label(`risk_refusals=${String(health.risk.refusals)}`));
    io.out(
      label(
        `risk_refusals_by_code=${Object.entries(health.risk.refusalsByCode)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([code, count]) => `${code}:${String(count)}`)
          .join(",")}`,
      ),
    );
    io.out(label(`fills=${String(health.execution.fillsObserved)}`));
    io.out(label(`id_namespace=${core.idNamespace}`));
    io.out(label(`halts=${halts}`));
    io.out("");
    io.out(serializeApproximateRun(outcome.result));
    io.out("");
    io.out(label(`artifact=${options["artifact"] as string}`));
    io.out(label(`artifact_bytes=${String(bytes.byteLength)}`));
    io.out(label(`artifact_sha256=${sha256Hex(bytes)}`));
    return core.trader.halts.anyHalt ? EXIT_HALTED : EXIT_OK;
  } finally {
    await core.store.close();
  }
}

/** Runs the CLI. Returns an exit code; writes through the injected sinks. */
export async function main(input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}): Promise<number> {
  const parsed = parseArguments(input.argv);
  if ("usage" in parsed) {
    input.err(`backtest-cli: ${parsed.usage}`);
    for (const line of USAGE_LINES) input.err(line);
    return EXIT_USAGE;
  }
  if (parsed.command === "run") return await runCommand(parsed.options, input);
  if (parsed.command === "approx-run") return await approximateRunCommand(parsed.options, input);
  if (parsed.command !== "verify") {
    input.err(`backtest-cli: unknown command ${JSON.stringify(parsed.command)}`);
    return EXIT_USAGE;
  }
  const datasetDirectory = parsed.options["dataset"];
  const pinsPath = parsed.options["pins"];
  if (datasetDirectory === undefined || pinsPath === undefined) {
    input.err("backtest-cli: verify needs --dataset and --pins");
    return EXIT_USAGE;
  }

  const pins = await readPinsFile(pinsPath);
  if ("problem" in pins) {
    input.err(`backtest-cli: ${pins.problem}`);
    return EXIT_REFUSED;
  }

  const outcome = await runBacktest({
    datasetDirectory,
    normalizer: normalizerFor(pins),
    runPins: pins,
    environment: input.environment,
  });
  const rendered = renderBacktestOutcome(outcome);
  if (outcome.ok) {
    input.out(rendered);
    return EXIT_OK;
  }
  input.err(rendered);
  return EXIT_REFUSED;
}

/* c8 ignore start -- the process wiring; `main` above is what tests drive. */
const isExecutable = process.argv[1] !== undefined && import.meta.url.endsWith(".mjs");
if (isExecutable) {
  const code = await main({
    argv: process.argv.slice(2),
    environment: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
/* c8 ignore stop */
