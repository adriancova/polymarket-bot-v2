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
 * ```
 *
 * `verify` reads the dataset manifest, verifies every pinned object's checksum,
 * reconciles the dispatch ordinals, counts and exclusions against the manifest's
 * own numbers, replays every recorded frame through the normalizer the run
 * pins name ({@link normalizerFor}), and prints the §12.4 canonical
 * serialization. It drives NO core: this executable cannot construct the
 * shared paper core (`run.ts`'s header says why), so `verify` is exactly that
 * — verification and the venue-free replay — over any dataset, including the
 * normalized-stream recording `test/replay-golden/backtest/static-bracket/`.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  parseStrictJsonBytes,
  readRunPins,
  type ReplayNormalizer,
  type ReplayRunPins,
} from "@polymarket-bot/simulation";

import { sha256Hex } from "./archive.js";
import {
  NORMALIZED_ENVELOPE_NORMALIZER_VERSION,
  normalizedEnvelopeNormalizer,
  recordedFrameNormalizer,
} from "./normalizer.js";
import { renderBacktestOutcome, runBacktest } from "./run.js";

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

interface ParsedArguments {
  readonly command: string;
  readonly options: Readonly<Record<string, string>>;
}

/** Parses `command --key value` argument vectors. Total: never throws. */
export function parseArguments(argv: readonly string[]): ParsedArguments | { readonly usage: string } {
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith("--")) {
    return { usage: "a command is required: verify" };
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
    input.err("usage: backtest-cli verify --dataset <dir> --pins <run-pins.json>");
    return EXIT_USAGE;
  }
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
