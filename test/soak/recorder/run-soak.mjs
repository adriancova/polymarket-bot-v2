/**
 * Recorder soak-window runner (`WP-140`).
 *
 * Runs the REAL data-gateway bundle (the same artifact
 * `pnpm --filter @polymarket-bot/data-gateway start` executes — the WP-120
 * esbuild/subprocess precedent, `test/integration/data-gateway/
 * process-liveness.test.ts`) for a bounded window, observes it from the
 * outside (stderr signals + the WAL artifacts it leaves on disk), and writes
 * ONE machine-readable evidence record per window.
 *
 * Duration is FIRST-CLASS in the record (`startedAt`/`endedAt`/`elapsedMs`)
 * and the record carries NO status field and NO derived claims — primitives
 * only (exit code/signal, which signals the harness sent, which log lines it
 * saw, what the WAL scan found); anything derived ("was the shutdown clean",
 * "how many unexplained-gap signals") is computed by the fail-closed
 * evaluator (`packages/observability/src/recorder/soak-evidence.ts`, run by
 * `pnpm run soak:evaluate` in this directory), whose best terminal state is
 * QUALIFYING_WINDOW_FOUND — a CANDIDATE for out-of-band provenance review,
 * never completion. The harness and the evaluator share a filesystem trust
 * domain, so the evaluator checks internal consistency, not provenance;
 * closing the external-evidence gate is a governance act recorded in
 * IMPLEMENTATION_STATUS.md. A real soak is THIS script run longer with a
 * reviewed configuration — same harness, same record shape, honest elapsed
 * time either way. Nothing here can mark a soak complete.
 *
 * Defaults are LOOPBACK-ONLY and self-contained: with no SOAK_CONFIG_PATH a
 * throwaway config is written that points the one configured feed at a
 * closed loopback port (`wss://127.0.0.1:1`) and the transport at
 * `redis://127.0.0.1:1`, so nothing leaves the machine — the smoke posture.
 * An operator starting a REAL soak passes a reviewed config
 * (see docs/runbooks/recorder.md, "Running a real soak").
 *
 * Environment:
 *   SOAK_DURATION_MS        (required) window length in whole milliseconds
 *   SOAK_CONFIG_PATH        gateway config JSON; default: generated loopback
 *   SOAK_EVIDENCE_DIR       default: <this dir>/evidence
 *   SOAK_WORK_DIR           default: a fresh temp directory
 *   SOAK_SKIP_BUILD=1       reuse apps/data-gateway/dist/main.cjs as-is
 *   SOAK_SHUTDOWN_GRACE_MS  default 30000: SIGTERM -> wait -> SIGKILL
 *   GATEWAY_REDIS_URL       passed through; default redis://127.0.0.1:1
 *   GATEWAY_RETENTION_EVENTS, GATEWAY_CLEANUP_DEADLINE_MS: passed through
 *
 * Exit codes: 0 = window completed and ended in a clean requested shutdown;
 * 2 = a record was written but the window did not complete cleanly (early
 * exit, forced kill, deadline expiry); 1 = harness failure, no record.
 *
 * Safety: public market data only; no credential, signer, wallet, or order
 * surface exists in the gateway or here. PAPER-only defaults untouched.
 */

import { spawn } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delayTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const bundlePath = resolve(repoRoot, "apps/data-gateway/dist/main.cjs");

/**
 * The evidence record is encoded from OWN DATA (`SER-3`, 2026-09-15).
 *
 * This repository's safety rule treats `soak-window-*.json` as REAL evidence,
 * and at base it was written with `JSON.stringify(record, null, 2)`, which
 * resolves `toJSON` through the prototype chain: under an inherited
 * `Object.prototype.toJSON` a window's evidence — however long — was the bare
 * string `"POLLUTED"` at write time, refused only later by the evaluator
 * (`docs/handoffs/SER-0-sweep.md`, `extra-soak-record-writer-object-proto`,
 * HIGH). `encodePlainJson` (`packages/risk/src/plain-json.ts`) is
 * byte-identical to the clean `JSON.stringify` for plain data and never
 * consults `toJSON`; the record is plain by construction. The generated
 * loopback config takes the same route for uniformity — a config the gateway
 * could not read would make a smoke window fail for a reason that is not the
 * recorder's.
 *
 * WHY A RESOLVE HOOK. This is a plain `.mjs` run by `node` (the smoke spawns
 * `process.execPath run-soak.mjs`), and it consumes the primitive FROM SOURCE
 * by relative path: there is no runtime build of workspace TypeScript outside
 * the esbuild-bundled apps. Node 24 type-strips a `.ts` module natively, but
 * it does NOT rewrite the `.js` specifier convention TypeScript sources use
 * (`plain-json.ts` imports `./plain-data.js`, which does not exist on disk) —
 * measured: `import("…/plain-json.ts")` fails with `ERR_MODULE_NOT_FOUND` for
 * `./plain-data.js`. The synchronous hook below (`module.registerHooks`,
 * Node ≥ 23.5) rewrites exactly that case: a RELATIVE `.js` specifier whose
 * importer is a `.ts` file, where the `.js` target is absent and the `.ts`
 * sibling exists. Nothing else is touched, and the primitive is loaded with a
 * dynamic import so the hook is registered first (a static import would be
 * hoisted above it).
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith(".js") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      typeof context.parentURL === "string" &&
      context.parentURL.endsWith(".ts")
    ) {
      const target = fileURLToPath(new URL(specifier, context.parentURL));
      if (!existsSync(target) && existsSync(`${target.slice(0, -3)}.ts`)) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { encodePlainJson } = await import("../../../packages/risk/src/plain-json.ts");

const RUNNING_BANNER = "data-gateway running:";
const RECORDING_ONLY = "PUBLICATION HALTED, RECORDING ONLY";
const SHUTDOWN_LOG = "data-gateway: shutting down";
const CLEANUP_DEADLINE_EXPIRED = /cleanup deadline \(\d+ ms\) expired/u;
const DISPOSAL_LINE = "[disposal]";
const INCIDENT_LINE = /^\[incident\] (?<severity>\S+) (?<reason>\S+)/u;
const HALT_LINE = "[halt] publication halted";
const WAL_FAILURE_LINE = "[wal] recording failure";

function fail(message) {
  console.error(`run-soak: ${message}`);
  process.exit(1);
}

function parseDurationMs(raw) {
  if (raw === undefined || raw === "") {
    fail("SOAK_DURATION_MS is required (whole milliseconds, >= 1000)");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1000) {
    fail(`SOAK_DURATION_MS must be a whole number of milliseconds >= 1000, got ${raw}`);
  }
  return value;
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    delayTimeout(resolvePromise, ms);
  });
}

async function buildBundle() {
  await new Promise((resolvePromise, rejectPromise) => {
    const build = spawn("pnpm", ["--filter", "@polymarket-bot/data-gateway", "run", "build"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    build.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    build.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    build.on("error", rejectPromise);
    build.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`gateway bundle build failed (exit ${String(code)}):\n${output}`));
      }
    });
  });
}

/** Sum finalized-segment manifests under the WAL root (epoch directories). */
async function scanWal(walRoot) {
  const wal = { epochs: 0, segments: 0, records: 0, bytes: 0 };
  let epochDirs = [];
  try {
    epochDirs = (await readdir(walRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return wal; // no WAL root => nothing recorded; the record says so honestly
  }
  wal.epochs = epochDirs.length;
  for (const epoch of epochDirs) {
    const epochPath = join(walRoot, epoch);
    let files = [];
    try {
      files = await readdir(epochPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".wal.manifest.json")) {
        continue;
      }
      try {
        const manifest = JSON.parse(await readFile(join(epochPath, file), "utf8"));
        wal.segments += 1;
        if (Number.isSafeInteger(manifest.recordCount)) {
          wal.records += manifest.recordCount;
        }
        if (Number.isSafeInteger(manifest.byteSize)) {
          wal.bytes += manifest.byteSize;
        }
      } catch {
        // An unreadable manifest is not silently dropped from evidence: it
        // shows up as a segment the totals do not cover. Count the segment.
        wal.segments += 1;
      }
    }
  }
  return wal;
}

async function main() {
  const durationMs = parseDurationMs(process.env.SOAK_DURATION_MS);
  const graceMsRaw = process.env.SOAK_SHUTDOWN_GRACE_MS ?? "30000";
  const graceMs = Number(graceMsRaw);
  if (!Number.isSafeInteger(graceMs) || graceMs < 1000) {
    fail(`SOAK_SHUTDOWN_GRACE_MS must be a whole number >= 1000, got ${graceMsRaw}`);
  }
  const evidenceDir = process.env.SOAK_EVIDENCE_DIR ?? join(here, "evidence");
  await mkdir(evidenceDir, { recursive: true });

  let workDir = process.env.SOAK_WORK_DIR;
  if (workDir === undefined || workDir === "") {
    workDir = await mkdtemp(join(tmpdir(), "recorder-soak-"));
  } else {
    await mkdir(workDir, { recursive: true });
  }

  let configPath = process.env.SOAK_CONFIG_PATH;
  if (configPath === undefined || configPath === "") {
    // The smoke posture: loopback-only, one feed at a closed port. Identical
    // in shape to the WP-120 process-liveness subprocess test.
    configPath = join(workDir, "gateway.loopback.json");
    await writeFile(
      configPath,
      encodePlainJson(
        {
          streamName: "market-events",
          wal: { rootPath: join(workDir, "wal"), fsyncIntervalMs: 100 },
          tickIntervalMs: 100,
          markets: [],
          coinbase: { productIds: ["BTC-USD"], endpoint: "wss://127.0.0.1:1" },
        },
        { indent: 2 },
      ),
    );
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const walRoot = config?.wal?.rootPath;
  if (typeof walRoot !== "string" || walRoot === "") {
    fail(`the gateway config at ${configPath} has no wal.rootPath`);
  }

  if (process.env.SOAK_SKIP_BUILD !== "1") {
    console.error("run-soak: building the gateway bundle…");
    await buildBundle();
  }

  const startedAtMs = Date.now();
  const startedMonotonic = process.hrtime.bigint();
  console.error(
    `run-soak: window of ${String(durationMs)} ms starting; config ${configPath}, wal ${walRoot}, evidence ${evidenceDir}`,
  );

  const child = spawn(process.execPath, [bundlePath], {
    env: {
      ...process.env,
      GATEWAY_CONFIG_PATH: configPath,
      GATEWAY_REDIS_URL: process.env.GATEWAY_REDIS_URL ?? "redis://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const observed = {
    runningBannerSeen: false,
    recordingOnly: false,
    shutdownLogSeen: false,
    cleanupDeadlineExpired: false,
    disposalFailures: 0,
    incidents: 0,
    // Of the incidents, those with a GAP-shaped reason code — a PRIMITIVE
    // observation; the evaluator derives "unexplained-gap signals" from it
    // (plus walRecordingFailures) and refuses to qualify over any.
    gapIncidents: 0,
    halts: 0,
    walRecordingFailures: 0,
  };
  let stderrTail = [];
  let pending = "";
  child.stderr.on("data", (chunk) => {
    pending += String(chunk);
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      stderrTail.push(line);
      if (stderrTail.length > 200) {
        stderrTail = stderrTail.slice(-200);
      }
      if (line.includes(RUNNING_BANNER)) {
        observed.runningBannerSeen = true;
        if (line.includes(RECORDING_ONLY)) {
          observed.recordingOnly = true;
        }
      }
      if (line.includes(SHUTDOWN_LOG)) {
        observed.shutdownLogSeen = true;
      }
      if (CLEANUP_DEADLINE_EXPIRED.test(line)) {
        observed.cleanupDeadlineExpired = true;
      }
      if (line.startsWith(DISPOSAL_LINE)) {
        observed.disposalFailures += 1;
      }
      const incident = INCIDENT_LINE.exec(line);
      if (incident !== null) {
        observed.incidents += 1;
        // Gap-shaped incidents count toward the derived "unexplained" tally:
        // the evaluator refuses to qualify over them, and an operator
        // explains them (or does not) in review — the conservative direction.
        if (incident.groups.reason.toUpperCase().includes("GAP")) {
          observed.gapIncidents += 1;
        }
      }
      if (line.startsWith(HALT_LINE)) {
        observed.halts += 1;
      }
      if (line.startsWith(WAL_FAILURE_LINE)) {
        observed.walRecordingFailures += 1;
      }
    }
  });

  let exited;
  const exitPromise = new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      resolvePromise({ code, signal });
    });
  });

  // The window. An early exit ends it early — that is evidence, not an error.
  await Promise.race([delay(durationMs), exitPromise]);

  let forcedKill = false;
  let requestedShutdown = false;
  if (exited === undefined) {
    requestedShutdown = true;
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      exitPromise,
      delay(graceMs).then(() => "timed-out"),
    ]);
    if (outcome === "timed-out") {
      // The FAILED-to-exit case, observed from outside: the runbook's
      // forced-exit section is about exactly this.
      console.error(
        `run-soak: the recorder did not exit within ${String(graceMs)} ms of SIGTERM — force-killing; this window cannot qualify`,
      );
      forcedKill = true;
      child.kill("SIGKILL");
      await exitPromise;
    }
  }

  const endedAtMs = Date.now();
  const elapsedMs = Number((process.hrtime.bigint() - startedMonotonic) / 1000000n);
  // For the harness EXIT CODE only — this is deliberately NOT recorded: the
  // record carries the primitives and the evaluator derives cleanliness.
  const cleanShutdown =
    requestedShutdown &&
    !forcedKill &&
    exited !== undefined &&
    exited.code === 0 &&
    exited.signal === null &&
    observed.shutdownLogSeen &&
    !observed.cleanupDeadlineExpired;

  const wal = await scanWal(walRoot);
  const record = {
    schemaVersion: 2,
    kind: "recorder-soak-window",
    harness: "test/soak/recorder/run-soak.mjs",
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs,
    exit: {
      code: exited?.code ?? null,
      signal: exited?.signal ?? null,
      shutdownRequested: requestedShutdown,
      forcedKill,
    },
    observed,
    wal,
    notes: `stderr tail (${String(stderrTail.length)} lines) follows the record in the run log; window requested ${String(durationMs)} ms`,
  };

  const recordPath = join(
    evidenceDir,
    `soak-window-${record.startedAt.replaceAll(":", "-")}.json`,
  );
  await writeFile(recordPath, `${encodePlainJson(record, { indent: 2 })}\n`);
  console.error(`run-soak: evidence written to ${recordPath}`);
  console.error(
    `run-soak: window ${String(elapsedMs)} ms; records ${String(wal.records)}; clean shutdown ${String(cleanShutdown)} (derived, not recorded). Status is decided ONLY by soak:evaluate — a short window is honestly PENDING, and the best any evidence can reach is QUALIFYING_WINDOW_FOUND, a candidate for human provenance review.`,
  );
  for (const line of stderrTail.slice(-40)) {
    console.error(`  | ${line}`);
  }
  process.exit(cleanShutdown ? 0 : 2);
}

main().catch((error) => {
  console.error("run-soak: harness failure", error);
  process.exit(1);
});
