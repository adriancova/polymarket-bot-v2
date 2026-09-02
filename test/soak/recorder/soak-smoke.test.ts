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
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evaluateSoakEvidence,
  parseSoakWindowEvidence,
} from "../../../packages/observability/src/recorder/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const runnerPath = resolve(here, "run-soak.mjs");

interface RunnerOutcome {
  readonly code: number | null;
  readonly stderr: string;
}

function runRunner(env: Record<string, string>): Promise<RunnerOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runnerPath], {
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
});
