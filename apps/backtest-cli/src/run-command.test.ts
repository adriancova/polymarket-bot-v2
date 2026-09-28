/**
 * `BACKTEST-2` — the `run` command, driven IN-PROCESS through the executable's
 * own entry point (`main`) with argv `['run', …]`, over the committed fixture
 * `test/replay-golden/backtest/static-bracket/` (read only).
 *
 * The central pin: the artifact the command WRITES is byte-identical to that
 * fixture's `expected-artifact.txt`, on two separate runs — so the operator
 * path (argv → safety → the core's own assembly → the shipped root → the
 * artifact file) is a CI gate, not only the in-memory path the replay suite
 * drives. The command keeps the PAPER rebuild-check cadence (it sets none),
 * where the replay suite runs every-fill; both produce the golden.
 *
 * Also pinned: safety runs before any file is opened; a pins/config
 * disagreement (BT1-R2) writes nothing; a halt the core latches mid-run stops
 * the replay and exits `EXIT_HALTED` with no artifact (BT1-R3); an existing
 * artifact is never overwritten; the report labels the run SIMULATED and
 * names the core's PAPER run mode beside the root's BACKTEST (BT1-R5); usage
 * errors are usage.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER. The only files written are
 * under a fresh temporary directory.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeParquetObject, type DatasetRow } from "@polymarket-bot/storage-parquet";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT_HALTED, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main } from "./main.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "replay-golden",
  "backtest",
  "static-bracket",
);
const GOLDEN = join(FIXTURE, "expected-artifact.txt");
const PINS = join(FIXTURE, "run-pins.json");
const CONFIG = join(FIXTURE, "trader-config.json");
const ID_NAMESPACE = "backtest-1-static-bracket-replay";

const scratch = mkdtempSync(join(tmpdir(), "backtest-2-run-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function safeEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
  };
}

async function cli(
  argv: readonly string[],
  environment: Record<string, string | undefined> = safeEnvironment(),
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({ argv, environment, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function runArgv(artifact: string, overrides: { readonly pins?: string } = {}): string[] {
  return [
    "run",
    "--dataset",
    FIXTURE,
    "--pins",
    overrides.pins ?? PINS,
    "--config",
    CONFIG,
    "--artifact",
    artifact,
    "--id-namespace",
    ID_NAMESPACE,
  ];
}

function sha256(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface FixtureFrames {
  readonly gatewayEpoch: string;
  readonly segmentId: string;
  readonly frames: {
    readonly ingestSeq: string;
    readonly source: string;
    readonly endpoint: string;
    readonly connectionId: string;
    readonly subscriptionGeneration: number;
    readonly receivedAt: string;
    readonly receivedMonotonicNs: string;
    readonly envelope: { readonly payload: Record<string, unknown> } & Record<string, unknown>;
  }[];
}

/**
 * A copy of the committed dataset with ONE recorded frame altered, written
 * the way the fixture was: the rows `frames.json` denotes (the replay suite's
 * derivation, restated), the declared Parquet writer, and the manifest's
 * object pin re-derived. Everything else is the committed fixture's.
 */
function datasetWith(directory: string, alter: (frames: FixtureFrames) => void): void {
  mkdirSync(directory, { recursive: true });
  const frames = JSON.parse(readFileSync(join(FIXTURE, "frames.json"), "utf8")) as FixtureFrames;
  alter(frames);
  let offset = 0;
  const rows: DatasetRow[] = frames.frames.map((frame, index) => {
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
      payloadSha256: sha256(Buffer.from(payloadUtf8, "utf8")),
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
      frameLineSha256: sha256(Buffer.from(line, "utf8")),
      replayEligible: true,
      exclusionReason: null,
    };
    offset += length;
    return row;
  });
  const parquet = writeParquetObject({ rows });
  writeFileSync(join(directory, "part-00000.parquet"), parquet.bytes);
  const manifest = JSON.parse(readFileSync(join(FIXTURE, "dataset-manifest.json"), "utf8")) as {
    objects: { sha256: string; byteLength: number }[];
  };
  const object = manifest.objects[0];
  if (object === undefined) throw new Error("the fixture manifest pins no object");
  object.sha256 = sha256(parquet.bytes);
  object.byteLength = parquet.bytes.byteLength;
  writeFileSync(join(directory, "dataset-manifest.json"), JSON.stringify(manifest, null, 2));
}

describe("backtest-cli run — argv in, artifact out (the operator path)", () => {
  it("writes an artifact BYTE-IDENTICAL to expected-artifact.txt, on two separate runs", async () => {
    const golden = readFileSync(GOLDEN);
    const written: Buffer[] = [];
    for (const name of ["first.txt", "second.txt"]) {
      const artifact = join(scratch, name);
      const result = await cli(runArgv(artifact));
      expect(result.code, result.err).toBe(EXIT_OK);
      const bytes = readFileSync(artifact);
      written.push(bytes);
      expect(bytes.equals(golden)).toBe(true);
      // The report states what the file is, and its digest.
      expect(result.out).toContain(`artifact=${artifact}`);
      expect(result.out).toContain(`artifact_bytes=${String(golden.byteLength)}`);
      expect(result.out).toContain(`artifact_sha256=${sha256(golden)}`);
    }
    expect(written[0]?.equals(written[1] ?? Buffer.alloc(0))).toBe(true);
  });

  it("labels the run SIMULATED and names the core's PAPER run mode beside the root's BACKTEST (BT1-R5)", async () => {
    const result = await cli(runArgv(join(scratch, "labels.txt")));
    expect(result.code, result.err).toBe(EXIT_OK);
    expect(result.out.split("\n")[0]).toBe("run_mode=BACKTEST");
    expect(result.out).toContain("core_run_mode=PAPER");
    expect(result.out).toContain("evidence=SIMULATED_NOT_REAL_EVIDENCE");
    expect(result.out).toContain(`id_namespace=${ID_NAMESPACE}`);
    expect(result.out).toContain("halts=\n");
    expect(readFileSync(join(scratch, "labels.txt"), "utf8")).toContain("SIMULATED_NOT_REAL_EVIDENCE");
  });

  it("safety runs FIRST: a production secret NAME refuses before any file is opened, and nothing is written", async () => {
    const artifact = join(scratch, "unsafe.txt");
    // Every path is missing: a command that read anything would report THAT.
    const result = await cli(
      ["run", "--dataset", join(scratch, "missing"), "--pins", join(scratch, "missing.json"), "--config",
        join(scratch, "missing-config.json"), "--artifact", artifact],
      { ...safeEnvironment(), POLY_API_KEY: "value-never-printed" },
    );
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err).toContain("startup safety validation failed");
    expect(result.err).toContain("PAPER_PRODUCTION_SECRET_NAME_PRESENT");
    expect(result.err).not.toContain("value-never-printed");
    expect(result.err).not.toContain("could not be read");
    expect(existsSync(artifact)).toBe(false);
  });

  it("BT1-R2: a pins file that disagrees with the configuration is refused by name, and no artifact is written", async () => {
    const pins = JSON.parse(readFileSync(PINS, "utf8")) as Record<string, unknown>;
    const mismatched = join(scratch, "mismatched-pins.json");
    writeFileSync(mismatched, JSON.stringify({ ...pins, feeSnapshotVersion: "fees.somewhere-else" }));
    const artifact = join(scratch, "mismatched.txt");
    const result = await cli(runArgv(artifact, { pins: mismatched }));
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err).toContain("BACKTEST_PINS_DISAGREE_WITH_CONFIG");
    expect(result.err).toContain("feeSnapshotVersion");
    expect(existsSync(artifact)).toBe(false);
  });

  it("BT1-R3: a halt the core latches mid-run stops the replay, prints the halt, exits EXIT_HALTED and writes no artifact", async () => {
    // The fourth recorded frame, a BookSnapshot, names a token the market does
    // not have: the core's book refuses it and latches BOOK_DESYNCHRONIZED.
    const dataset = join(scratch, "desynchronized");
    datasetWith(dataset, (frames) => {
      const snapshot = frames.frames[3];
      if (snapshot === undefined) throw new Error("the fixture has no fourth frame");
      snapshot.envelope.payload["tokenId"] = "9999";
    });
    const artifact = join(scratch, "halted.txt");
    const result = await cli(["run", "--dataset", dataset, "--pins", PINS, "--config", CONFIG, "--artifact", artifact,
      "--id-namespace", ID_NAMESPACE]);
    expect(result.code, result.err).toBe(EXIT_HALTED);
    expect(EXIT_HALTED).toBe(75);
    expect(result.err).toContain("REFUSED: SIMULATION_INTERNAL");
    expect(result.err).toContain("BOOK_DESYNCHRONIZED@MARKET");
    expect(result.err).toContain("stoppedAt=AFTER_DRAIN");
    expect(result.err).toContain("ingestSeq=4");
    expect(result.err).toContain("HALTED: the core latched BOOK_DESYNCHRONIZED@MARKET");
    expect(existsSync(artifact)).toBe(false);
  });

  it("never overwrites an existing artifact", async () => {
    const artifact = join(scratch, "existing.txt");
    writeFileSync(artifact, "an earlier run's evidence\n");
    const result = await cli(runArgv(artifact));
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.err).toContain("never overwrites");
    expect(readFileSync(artifact, "utf8")).toBe("an earlier run's evidence\n");
  });

  it("usage: a missing option, or one run does not take, is a usage error; the usage names both commands", async () => {
    const missing = await cli(["run", "--dataset", FIXTURE, "--pins", PINS]);
    expect(missing.code).toBe(EXIT_USAGE);
    expect(missing.err).toContain("run needs --dataset, --pins, --config and --artifact");
    const unknown = await cli([...runArgv(join(scratch, "unknown.txt")), "--core", "mine"]);
    expect(unknown.code).toBe(EXIT_USAGE);
    expect(unknown.err).toContain("run does not take --core");
    const none = await cli([]);
    expect(none.code).toBe(EXIT_USAGE);
    expect(none.err).toContain("backtest-cli: a command is required: verify or run");
    expect(none.err).toContain("usage: backtest-cli verify --dataset <dir> --pins <run-pins.json>");
    expect(none.err).toContain("backtest-cli run --dataset <dir>");
  });
});
