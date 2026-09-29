/**
 * Support for `backtest-static-bracket-replay.test.ts` (BACKTEST-1, GOV-2B B3;
 * BACKTEST-2): the committed fixture, the run through the backtest
 * EXECUTABLE's own assembly of the shared core, and the canonical artefact the
 * determinism claim is made about.
 *
 * ## What is real — everything
 *
 * Since `BACKTEST-2` this file assembles nothing. The core is built by
 * `apps/backtest-cli`'s own `runBacktestCore` / `assembleBacktestCore`
 * (`assembly.ts`) — the code the `run` command runs: the shared trading core's
 * `createPaperTrader` (`@polymarket-bot/trading-core`, ADR-022) over the real
 * books, feature engine, strategy runtime, Static Bracket, capital allocator,
 * risk engine, execution planner, ledger and PnL engine; the core's ONE
 * simulated-venue builder, the call `apps/trader/src/main.ts` makes; the
 * core's PRODUCTION in-memory store; `packages/simulation`'s replay clock;
 * and the shipped `runBacktest` + `replayDrivenCoreLoop` +
 * `normalizedEnvelopeNormalizer`. The artefact is rendered by the CLI's own
 * `renderBacktestArtifact` (`artifact.ts`). Nothing between the recorded frame
 * and the artefact is a copy, a subset or a re-implementation, and no part is
 * a test double: `BACKTEST-1`'s `MemoryTraderStore` and its copy of
 * `main.ts`'s venue wiring are gone.
 *
 * What this file still states is the fixture's own inputs: the environment
 * record the run is started in ({@link paperEnvironment}), the identifier
 * namespace the golden is frozen against ({@link ID_NAMESPACE}), and the
 * core's rebuild-check cadence — the every-fill cadence by default
 * (orchestrator call O1), where the `run` command keeps the PAPER cadence;
 * `apps/backtest-cli/src/run-command.test.ts` drives the command itself and
 * pins the same golden bytes.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER. The only files read are the
 * committed fixture's.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BACKTEST_ARTIFACT_FORMAT_ID,
  assembleBacktestCore,
  normalizedEnvelopeNormalizer,
  renderBacktestArtifact,
  runBacktest,
  runBacktestCore,
  sha256Hex,
  type BacktestCore,
  type BacktestOutcome,
} from "../../../apps/backtest-cli/src/index.js";
import {
  EVERY_FILL_ACCOUNTING_CHECKS,
  type AccountingChecks,
} from "../../../packages/trading-core/src/index.js";
import type {
  ReplayRunPins,
  SimulatedFill,
  SimulatedOrder,
} from "../../../packages/simulation/src/index.js";
import type { DatasetRow } from "../../../packages/storage-parquet/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The committed fixture. Its README carries provenance and derivations. */
export const FIXTURE_DIRECTORY = join(REPO_ROOT, "test", "replay-golden", "backtest", "static-bracket");
export const FRAMES_FILE = "frames.json";
export const PARQUET_OBJECT_FILE = "part-00000.parquet";
export const MANIFEST_FILE = "dataset-manifest.json";
export const RUN_PINS_FILE = "run-pins.json";
export const TRADER_CONFIG_FILE = "trader-config.json";
export const EXPECTED_ARTIFACT_FILE = "expected-artifact.txt";

/** The format id of the artefact this suite freezes — the CLI's own. Bump = re-derive the golden. */
export const ARTIFACT_FORMAT_ID = BACKTEST_ARTIFACT_FORMAT_ID;

/**
 * The `idNamespace` the core is built with (`run --id-namespace`).
 * `DeterministicIdFactory` folds it into every minted approved-intent, plan,
 * attempt, ledger and PnL id, so it is a seed the golden bytes are frozen
 * against.
 */
export const ID_NAMESPACE = "backtest-1-static-bracket-replay";

/** One recorded frame of the normalized-stream recording, as `frames.json` states it. */
export interface FixtureFrame {
  readonly ingestSeq: string;
  readonly source: string;
  readonly endpoint: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly envelope: {
    readonly eventType: string;
    readonly schemaVersion: number;
    readonly sourceChannel: string;
    readonly venueTimestamp?: string;
    readonly payload: unknown;
  };
}

export interface FixtureFrames {
  readonly fixture: string;
  readonly gatewayEpoch: string;
  readonly segmentId: string;
  readonly objectKey: string;
  readonly frames: readonly FixtureFrame[];
}

export interface Fixture {
  readonly frames: FixtureFrames;
  readonly manifest: { readonly eventRange: { readonly first: { readonly receivedAt: string } } };
  readonly runPins: ReplayRunPins;
  readonly traderConfig: Record<string, unknown>;
  readonly parquetBytes: Uint8Array;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, file), "utf8")) as T;
}

export function loadFixture(): Fixture {
  const buffer = readFileSync(join(FIXTURE_DIRECTORY, PARQUET_OBJECT_FILE));
  return {
    frames: readJson<FixtureFrames>(FRAMES_FILE),
    manifest: readJson<Fixture["manifest"]>(MANIFEST_FILE),
    runPins: readJson<ReplayRunPins>(RUN_PINS_FILE),
    traderConfig: readJson<Record<string, unknown>>(TRADER_CONFIG_FILE),
    parquetBytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  };
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/**
 * The dataset rows `frames.json` denotes — the derivation the fixture's
 * Parquet object was written from, repeated so the test can pin the committed
 * bytes against it.
 *
 * The `frameLine*` fields describe a WAL line that never existed on disk (the
 * fixture is synthetic; its README says so): they are the byte accounting of
 * `JSON.stringify(record) + "\n"`, so they are checkable rather than random.
 */
export function datasetRowsOf(frames: FixtureFrames): readonly DatasetRow[] {
  let offset = 0;
  return frames.frames.map((frame, index) => {
    const payloadUtf8 = JSON.stringify(frame.envelope);
    const record = {
      gatewayEpoch: frames.gatewayEpoch,
      ingestSeq: frame.ingestSeq,
      source: frame.source,
      endpoint: frame.endpoint,
      connectionId: frame.connectionId,
      subscriptionGeneration: frame.subscriptionGeneration,
      receivedAt: frame.receivedAt,
      receivedMonotonicNs: frame.receivedMonotonicNs,
      payloadUtf8,
      payloadSha256: sha256Hex(utf8(payloadUtf8)),
    };
    const line = `${JSON.stringify(record)}\n`;
    const length = Buffer.byteLength(line, "utf8");
    const row: DatasetRow = {
      datasetRowOrdinal: index,
      segmentId: frames.segmentId,
      segmentIndex: 0,
      segmentRecordIndex: index,
      record,
      frameLineByteOffset: offset,
      frameLineByteLength: length,
      frameLineSha256: sha256Hex(utf8(line)),
      replayEligible: true,
      exclusionReason: null,
    };
    offset += length;
    return row;
  });
}

/**
 * The PAPER-only environment both roots are started in. The four repository
 * floors are stated as VALUES so a reader can see them; `apps/backtest-cli`'s
 * `checkBacktestSafety` and the core's `checkPaperTraderSafety` (which the
 * backtest's assembly runs too) each refuse anything above them, and neither
 * can raise them.
 */
export function paperEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    NODE_ENV: "test",
  };
}

/** Everything the CLI's assembly holds that this suite reads. */
export type SharedCore = Pick<BacktestCore, "trader" | "venue" | "store" | "clock">;

/**
 * The shared core as the backtest EXECUTABLE assembles it
 * (`assembleBacktestCore`), over the committed fixture — for a caller that
 * drives it itself. The replay clock starts at the manifest's first recorded
 * instant, as the `run` command starts it.
 */
export function assembleSharedCore(
  fixture: Fixture,
  accountingChecks: AccountingChecks = EVERY_FILL_ACCOUNTING_CHECKS,
): SharedCore {
  const assembled = assembleBacktestCore({
    environment: paperEnvironment(),
    traderConfig: fixture.traderConfig,
    runPins: fixture.runPins,
    clockStart: { receivedAt: fixture.manifest.eventRange.first.receivedAt, receivedMonotonicNs: "0" },
    idNamespace: ID_NAMESPACE,
    accountingChecks,
  });
  if (!assembled.ok) {
    throw new Error(
      `${assembled.refusal.code}: ${assembled.refusal.detail}\n  ${assembled.refusal.issues.join("\n  ")}`,
    );
  }
  return assembled.core;
}

/** What one replay through the shipped root left behind. */
export interface ReplayRun {
  readonly outcome: BacktestOutcome;
  /** Absent when the run was driven WITHOUT the shared core (the base-`1aa2238` behaviour). */
  readonly core: SharedCore | undefined;
  readonly driver: { readonly eventsIngested: number; readonly drains: number } | undefined;
}

/**
 * Replays the committed fixture through the SHIPPED root.
 *
 * `withCore: true` is the backtest executable's own path (`runBacktestCore`,
 * what `run` runs). `withCore: false` is the control arm — `runBacktest`
 * exactly as base `1aa2238` could run it, with no `coreLoop` and no venue —
 * kept in the suite so the difference is measured, not asserted.
 */
export async function replayThroughShippedRoot(options: {
  readonly withCore: boolean;
  readonly datasetDirectory?: string;
  /** `FOLD-1`: the core's check cadence; the every-fill test cadence when omitted. */
  readonly accountingChecks?: AccountingChecks;
}): Promise<ReplayRun> {
  const fixture = loadFixture();
  const datasetDirectory = options.datasetDirectory ?? FIXTURE_DIRECTORY;
  if (!options.withCore) {
    const outcome = await runBacktest({
      datasetDirectory,
      normalizer: normalizedEnvelopeNormalizer(sha256Hex),
      runPins: fixture.runPins,
      environment: paperEnvironment(),
    });
    return { outcome, core: undefined, driver: undefined };
  }
  // The EXECUTABLE's own path: `runBacktestCore` builds the core and drives
  // it through the shipped root; `FOLD-1`'s end-of-run check is bound by the
  // driver it builds and run by `runBacktest` — nothing to pass.
  const started = await runBacktestCore({
    environment: paperEnvironment(),
    traderConfig: fixture.traderConfig,
    runPins: fixture.runPins,
    datasetDirectory,
    idNamespace: ID_NAMESPACE,
    accountingChecks: options.accountingChecks ?? EVERY_FILL_ACCOUNTING_CHECKS,
  });
  if (!started.ok) {
    throw new Error(
      `${started.refusal.code}: ${started.refusal.detail}\n  ${started.refusal.issues.join("\n  ")}`,
    );
  }
  return { outcome: started.run.outcome, core: started.run.core, driver: started.run.driver };
}

// ---------------------------------------------------------------------------
// The artefact
// ---------------------------------------------------------------------------

/**
 * The canonical artefact — rendered by the backtest CLI's own
 * `renderBacktestArtifact` (`apps/backtest-cli/src/artifact.ts`, where
 * `BACKTEST-2` moved this suite's renderer byte for byte), so the bytes this
 * suite freezes are the bytes the `run` command writes. The control arm has
 * no core and renders the one-line core section it always rendered.
 */
export function renderArtifact(run: ReplayRun): string {
  if (!run.outcome.ok) {
    throw new Error(`the replay was refused; there is no artefact to render: ${JSON.stringify(run.outcome)}`);
  }
  if (run.core === undefined) {
    const lines = [ARTIFACT_FORMAT_ID, "--- simulation-run ---", run.outcome.result.serialization];
    lines.push("--- core ---", "core absent", "end");
    return `${lines.join("\n")}\n`;
  }
  const artifact = renderBacktestArtifact({
    outcome: run.outcome,
    trader: run.core.trader,
    store: run.core.store,
    driver: run.driver ?? { eventsIngested: 0, drains: 0 },
  });
  if (!artifact.ok) throw new Error(`the CLI refused to render the artefact: ${artifact.problem}`);
  return artifact.text;
}

/** The venue's orders and fills, for assertions that read them directly. */
export function venueRecords(run: ReplayRun): {
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
} {
  if (run.core === undefined) return { orders: [], fills: [] };
  return { orders: run.core.venue.ordersSnapshot(), fills: run.core.venue.fills };
}
