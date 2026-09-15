/**
 * Automated smoke of the soak-evidence machinery (`WP-140`).
 *
 * What this does — and, load-bearing, what it does NOT claim: it runs the
 * REAL gateway bundle through the REAL harness (`run-soak.mjs`) for a
 * SECONDS-long loopback window and proves the evidence-collection machinery
 * works end to end: the record is written, parses under the fail-closed
 * exact-key schema (primitives only — no status, no derived claims), carries
 * first-class honest duration, and evaluates to **PENDING**. A soak's LENGTH
 * cannot be tested by a test; only real elapsed time provides it, and the
 * final assertion here is precisely that this run lands on PENDING — and
 * that no state of the evaluator is presentable as completion (the best is
 * QUALIFYING_WINDOW_FOUND, a candidate for human provenance review).
 *
 * Subprocess pattern per test/integration/data-gateway/process-liveness.test.ts
 * (WP-120): closed LOOPBACK ports only, nothing leaves the machine, and the
 * bundle is built from current sources in beforeAll.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evaluateSoakEvidence,
  parseSoakWindowEvidence,
} from "../../../packages/observability/src/recorder/index.js";
import { renderDivergences, sweepInheritedToJson } from "../../unit/ledger/inherited-tojson.js";
import { renderSoakStatusArtifact } from "./src/status-artifact.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const runnerPath = resolve(here, "run-soak.mjs");

interface RunnerOutcome {
  readonly code: number | null;
  readonly stderr: string;
}

function runRunner(env: Record<string, string>, nodeArgs: readonly string[] = []): Promise<RunnerOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [...nodeArgs, runnerPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      resolvePromise({ code, stderr });
    });
  });
}

async function readOnlyRecord(evidenceDir: string): Promise<unknown> {
  const files = (await readdir(evidenceDir)).filter(
    (name) => name.startsWith("soak-window-") && name.endsWith(".json"),
  );
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(evidenceDir, files[0] ?? ""), "utf8"));
}

describe("soak-smoke: the evidence machinery, end to end", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "soak-smoke-"));
    // Build the real bundle ONCE (the runner is told to skip its own build).
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const build = spawn(
        "pnpm",
        ["--filter", "@polymarket-bot/data-gateway", "run", "build"],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      build.stdout.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      build.stderr.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      build.on("error", rejectPromise);
      build.on("exit", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(new Error(`bundle build failed (exit ${String(code)}):\n${output}`));
        }
      });
    });
  }, 180_000);

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("a healthy loopback window: record written, honest duration, clean shutdown, PENDING", async () => {
    const evidenceDir = join(scratch, "evidence-healthy");
    const workDir = join(scratch, "work-healthy");
    const requestedMs = 4_000;
    const before = Date.now();
    const outcome = await runRunner({
      SOAK_DURATION_MS: String(requestedMs),
      SOAK_EVIDENCE_DIR: evidenceDir,
      SOAK_WORK_DIR: workDir,
      SOAK_SKIP_BUILD: "1",
    });
    const after = Date.now();
    expect(outcome.code, `runner stderr:\n${outcome.stderr}`).toBe(0);

    const raw = await readOnlyRecord(evidenceDir);
    const parsed = parseSoakWindowEvidence(raw);
    expect(parsed.ok, JSON.stringify(raw, null, 2)).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const record = parsed.record;

    // Duration is first-class and HONEST: at least the requested window,
    // bounded by the wall time this test observed around the runner.
    expect(record.elapsedMs).toBeGreaterThanOrEqual(requestedMs);
    expect(record.elapsedMs).toBeLessThanOrEqual(after - before);
    expect(Date.parse(record.endedAt) - Date.parse(record.startedAt)).toBeGreaterThanOrEqual(
      requestedMs,
    );

    // The recorder really ran, in the recording-only posture, and exited 0
    // on request with the shutdown log — the bidirectional exit contract's
    // healthy half, observed from outside. PRIMITIVES ONLY: cleanliness is
    // not in the record; the evaluator derives it from these facts.
    expect(record.observed.runningBannerSeen).toBe(true);
    expect(record.observed.recordingOnly).toBe(true);
    expect(record.observed.shutdownLogSeen).toBe(true);
    expect(record.observed.cleanupDeadlineExpired).toBe(false);
    expect(record.exit).toEqual({
      code: 0,
      signal: null,
      shutdownRequested: true,
      forcedKill: false,
    });

    // The WAL was really scanned, and the scan is honest about a loopback
    // window: the journal opens the epoch directory at startup, but the WAL
    // writer opens its first segment LAZILY on the first frame — no venue
    // frames arrive from closed loopback ports, so zero segments and zero
    // records is the truthful result, not a scan failure.
    expect(record.wal.epochs).toBeGreaterThanOrEqual(1);
    expect(record.wal.segments).toBe(0);
    expect(record.wal.records).toBe(0);
    expect(record.observed.gapIncidents).toBe(0);
    expect(record.observed.walRecordingFailures).toBe(0);

    // THE POINT: a seconds-long window evaluates to PENDING, and the reasons
    // carry the honest arithmetic. No path in this harness can mark the soak
    // complete without real elapsed evidence — and a loopback window can
    // never qualify at ANY length, because it demonstrates no recording.
    const evaluation = evaluateSoakEvidence([raw], Date.now());
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.validWindows).toBe(1);
    expect(evaluation.longestWindowMs).toBeLessThan(evaluation.thresholdMs);
    expect(evaluation.longestQualifyingWindowMs).toBe(0);
    expect(evaluation.reasons.join("\n")).toContain("must demonstrate recording");
    expect(evaluation.reasons.join("\n")).toContain("PENDING");
  }, 120_000);

  it("a fatal-config window: the runner records the defect honestly and exits 2", async () => {
    const evidenceDir = join(scratch, "evidence-fatal");
    const workDir = join(scratch, "work-fatal");
    // The Coinbase adapter refuses a non-wss endpoint inside start(): the
    // WP-120 fatal-startup shape (nonzero exit, prompt) — never dialled.
    const configPath = join(scratch, "gateway-fatal.json");
    await writeFile(
      configPath,
      JSON.stringify({
        streamName: "market-events",
        wal: { rootPath: join(workDir, "wal"), fsyncIntervalMs: 100 },
        tickIntervalMs: 100,
        markets: [],
        coinbase: { productIds: ["BTC-USD"], endpoint: "ws://127.0.0.1:1" },
      }),
    );
    const outcome = await runRunner({
      SOAK_DURATION_MS: String(30_000), // the early exit ends the window early
      SOAK_CONFIG_PATH: configPath,
      SOAK_EVIDENCE_DIR: evidenceDir,
      SOAK_WORK_DIR: workDir,
      SOAK_SKIP_BUILD: "1",
    });
    expect(outcome.code, `runner stderr:\n${outcome.stderr}`).toBe(2);

    const raw = await readOnlyRecord(evidenceDir);
    const parsed = parseSoakWindowEvidence(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // No shutdown was requested (the process died first) — the primitives
    // say so, and the evaluator derives "not clean" from them.
    expect(parsed.record.exit.shutdownRequested).toBe(false);
    expect(parsed.record.exit.code).toBe(1);
    expect(parsed.record.observed.runningBannerSeen).toBe(false);
    // The window ended when the process died, not at the requested 30s.
    expect(parsed.record.elapsedMs).toBeLessThan(30_000);

    // And it cannot satisfy anything.
    const evaluation = evaluateSoakEvidence([raw], Date.now());
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.longestQualifyingWindowMs).toBe(0);
  }, 120_000);

  it("the runner refuses a missing or absurd duration", async () => {
    const noDuration = await runRunner({
      SOAK_EVIDENCE_DIR: join(scratch, "evidence-none"),
      SOAK_SKIP_BUILD: "1",
    });
    expect(noDuration.code).toBe(1);
    expect(noDuration.stderr).toContain("SOAK_DURATION_MS is required");

    const absurd = await runRunner({
      SOAK_DURATION_MS: "50",
      SOAK_EVIDENCE_DIR: join(scratch, "evidence-absurd"),
      SOAK_SKIP_BUILD: "1",
    });
    expect(absurd.code).toBe(1);
    expect(absurd.stderr).toContain(">= 1000");
  });

  /**
   * THE EVIDENCE RECORD DOES NOT DEPEND ON AN INHERITED `toJSON` (`SER-3`).
   *
   * MEASURED AT `main` `d6e05bf` (`SER-0`, `extra-soak-record-writer-object-proto`,
   * HIGH): `run-soak.mjs` wrote the record with `JSON.stringify(record, null, 2)`,
   * which resolves `toJSON` through the prototype chain — so under an
   * inherited `Object.prototype.toJSON` a window's evidence, however long,
   * was the bare string `"POLLUTED"` on disk, and under `Array.prototype` any
   * array in it was. This repository's safety rule treats these files as REAL
   * evidence.
   *
   * The pin runs the REAL runner as a subprocess under each of the six
   * contexts (`./inherited-tojson.preload.mjs`, `--import`ed into the RUNNER
   * only — the gateway it spawns is untouched) and requires the file bytes,
   * with the per-run timing values normalized, to equal the clean run's, and
   * the record to parse and evaluate exactly as the clean one does. The
   * normalization is named and narrow: `startedAt`, `endedAt`, `elapsedMs`,
   * the `notes` line and the epoch directory count are the only values a
   * second window may legitimately differ in.
   *
   * NOT A SOAK. Each window is the 1-second minimum against closed loopback
   * ports; nothing here is evidence that a soak ran.
   */
  it("SER-3: the evidence record is written from own data, byte-identical under all six inherited-toJSON contexts", async () => {
    const contexts = [
      "Object.prototype/enumerable",
      "Object.prototype/non-enumerable",
      "Array.prototype/enumerable",
      "Array.prototype/non-enumerable",
      "BigInt.prototype/enumerable",
      "BigInt.prototype/non-enumerable",
    ] as const;
    const preload = resolve(here, "inherited-tojson.preload.mjs");

    /** The file's bytes with the per-run timing values replaced by fixed markers. */
    const normalize = (bytes: string): string =>
      bytes
        .replaceAll(/"(startedAt|endedAt)": "[^"]*"/gu, '"$1": "<instant>"')
        .replaceAll(/"elapsedMs": \d+/gu, '"elapsedMs": <ms>')
        .replaceAll(/"notes": "[^"]*"/gu, '"notes": "<notes>"');

    /**
     * A CORRUPT segment manifest, planted in the WAL root every window scans.
     *
     * The `SER-2` review's HIGH, audited here: an encoder that refuses where
     * base encoded is a worse regression than the byte hijack it closes, and
     * the usual way in is a value PARSED FROM DISK. `run-soak.mjs`'s `scanWal`
     * is this harness's only disk-parsed input, so every window below reads a
     * manifest whose `recordCount`/`byteSize` are a 300-level chain and a
     * `Date`-shaped object — past the encoder's bound and past what the record
     * could ever carry. The record must still be written, parse, and evaluate:
     * the two `Number.isSafeInteger` guards (`run-soak.mjs`, `scanWal`) mean
     * nothing parsed from disk ever enters the encoded tree — only two
     * integers do, and a value that is not one is skipped while the segment is
     * still counted.
     */
    const plantCorruptManifest = async (workDir: string): Promise<void> => {
      const epochDir = join(workDir, "wal", "corrupt-epoch");
      await mkdir(epochDir, { recursive: true });
      let deep: unknown = "leaf";
      for (let index = 0; index < 300; index += 1) deep = { nest: deep };
      await writeFile(
        join(epochDir, "corrupt.wal.manifest.json"),
        JSON.stringify({ recordCount: deep, byteSize: { __proto__: null, toJSON: "not a number" } }),
      );
    };

    const runWindow = async (
      label: string,
      context: string | undefined,
    ): Promise<{ readonly bytes: string; readonly status: string }> => {
      const evidenceDir = join(scratch, `evidence-tojson-${label}`);
      const workDir = join(scratch, `work-tojson-${label}`);
      await plantCorruptManifest(workDir);
      const outcome = await runRunner(
        {
          SOAK_DURATION_MS: "1000",
          SOAK_EVIDENCE_DIR: evidenceDir,
          SOAK_WORK_DIR: workDir,
          SOAK_SKIP_BUILD: "1",
          ...(context === undefined ? {} : { SOAK_TOJSON_CONTEXT: context }),
        },
        context === undefined ? [] : ["--import", preload],
      );
      expect(outcome.code, `${label} stderr:\n${outcome.stderr}`).toBe(0);
      const files = (await readdir(evidenceDir)).filter(
        (name) => name.startsWith("soak-window-") && name.endsWith(".json"),
      );
      expect(files, label).toHaveLength(1);
      const bytes = await readFile(join(evidenceDir, files[0] ?? ""), "utf8");
      // The record still parses under the fail-closed exact-key schema and
      // evaluates to the honest PENDING — the DECISION, not just the bytes.
      const parsed = parseSoakWindowEvidence(JSON.parse(bytes));
      expect(parsed.ok, `${label}: ${bytes}`).toBe(true);
      const evaluation = evaluateSoakEvidence([JSON.parse(bytes)], Date.now());
      return {
        bytes: normalize(bytes),
        status: `${evaluation.status}|${String(evaluation.validWindows)}|${String(
          evaluation.longestQualifyingWindowMs,
        )}`,
      };
    };

    const clean = await runWindow("clean", undefined);
    expect(clean.status).toBe("PENDING|1|0");
    // Non-vacuity: the clean bytes ARE a pretty-printed record with the arrays
    // and objects the pollution would have replaced.
    expect(clean.bytes).toContain('"kind": "recorder-soak-window"');
    expect(clean.bytes).toContain('"observed": {');
    expect(clean.bytes).not.toContain("INJECTED");
    // The corrupt manifest was really read, and nothing it carried entered the
    // record: the segment is COUNTED (evidence that the scan saw it) while its
    // 300-level `recordCount` and non-numeric `byteSize` are skipped by the
    // `Number.isSafeInteger` guards, so the totals stay 0. An encoder refusal
    // here — the `SER-2` failure shape — would have failed the run above.
    expect(clean.bytes).toContain('"segments": 1');
    expect(clean.bytes).toContain('"records": 0');
    expect(clean.bytes).toContain('"bytes": 0');
    expect(clean.bytes).not.toContain('"nest"');

    for (const context of contexts) {
      const polluted = await runWindow(context.replaceAll(/[^a-z]/giu, "-"), context);
      expect(polluted.bytes, context).toBe(clean.bytes);
      expect(polluted.status, context).toBe(clean.status);
    }
  }, 180_000);
});

/**
 * THE `soak-status.json` ARTIFACT DOES NOT DEPEND ON AN INHERITED `toJSON` (`SER-3`).
 *
 * MEASURED AT `main` `d6e05bf` (`SER-0`, `extra-soak-status-artifact-arrays`,
 * HIGH): the `soak:evaluate` job wrote the artifact with
 * `JSON.stringify(…, null, 2)`, so under an inherited `Object.prototype.toJSON`
 * the whole file was the bare injected string and under `Array.prototype` the
 * `recordFiles` and `reasons` arrays were — the status the job COMPUTED was
 * right, the status it WROTE was not.
 *
 * The job now writes through `./src/status-artifact.ts`, which this pins
 * directly (the job body is one `writeFileSync` of its return value): run
 * clean, then under all six contexts, with the injected `toJSON` counted at
 * zero. Lives here rather than beside the job because `soak:evaluate` runs the
 * job for its ARTIFACTS, not as a test of anything (see `evaluate.job.test.ts`),
 * and `soak:smoke` is the gate a suite belongs in.
 */
describe("SER-3: the soak-status artifact is written from own data", () => {
  it("is byte-identical to the clean-process artifact in all six contexts, with the injected toJSON never run", () => {
    const evaluation = evaluateSoakEvidence([], Date.parse("2026-09-15T00:00:00.000Z"));
    const artifact = {
      generatedAt: "2026-09-15T00:00:00.000Z",
      evidenceDir: "/evidence",
      recordFiles: ["soak-window-a.json", "soak-window-b.json"],
      evaluation,
    };
    const sweep = sweepInheritedToJson([
      { name: "soak-status", render: () => renderSoakStatusArtifact(artifact) },
    ]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    // Outside every window: the clean bytes ARE `JSON.stringify(…, null, 2)` + "\n",
    // and they carry the arrays the pollution would have replaced.
    expect(sweep.clean.get("soak-status")).toBe(`ok:${JSON.stringify(artifact, null, 2)}\n`);
    expect(evaluation.status).toBe("PENDING");
    expect(evaluation.reasons.length).toBeGreaterThan(0);
    expect(renderSoakStatusArtifact(artifact)).toContain('"soak-window-a.json"');
  });
});
