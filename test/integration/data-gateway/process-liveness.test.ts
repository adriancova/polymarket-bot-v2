/**
 * Process liveness in the REAL composition root (round-2 review R2-H5).
 *
 * `systemGatewayTimers()` unrefs every timeout and interval so scheduled work
 * never holds the process open past a requested shutdown. At `e9cee46` that
 * policy had no counterweight: a recording-only startup (Redis unreachable,
 * publication halted, WAL open) whose only configured feed was waiting to
 * reconnect held NO referenced handle, and the process printed
 * "PUBLICATION HALTED, RECORDING ONLY" and then EXITED 0 on its own — no
 * signal, no shutdown log, nothing recorded ever again. That contradicted the
 * handoff's exits-only-on-an-unrecordable-defect claim and failed acceptance 4
 * in the real process even though the injected-harness path passed.
 *
 * The fix is a gateway-owned lifetime anchor: `DataGateway.start()` acquires a
 * REFERENCED handle through the optional `lifetime` port and `stop()` releases
 * it exactly once. `main.ts` injects `systemGatewayLifetime()`; the manual
 * harness injects a counting fake, so no test hangs and the unref policy for
 * ordinary timers survives untouched.
 *
 * This file proves both halves:
 *
 * 1. a SUBPROCESS smoke against the real CJS bundle — closed LOOPBACK ports
 *    only (`redis://127.0.0.1:1`, Coinbase `wss://127.0.0.1:1` — the adapter
 *    requires the wss scheme, and TLS to a closed port fails at the TCP
 *    connect, so nothing is sent anywhere); no venue, no
 *    credential, nothing outside this machine — pinning the reviewer's exact
 *    failure shape as the negative: the process must still be alive well after
 *    the recording-only banner, and must exit 0 WITH the shutdown log only
 *    after SIGTERM. Against the unfixed blob this test fails at the liveness
 *    assertion (verified probe-first: the child exits 0 unprompted).
 * 2. harness-level accounting — acquire exactly once at start, release exactly
 *    once at stop, no double release under double stop.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildHarness } from "./support/harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const bundlePath = resolve(repoRoot, "apps/data-gateway/dist/main.cjs");

/**
 * How long the child must survive AFTER announcing recording-only startup.
 *
 * At `e9cee46` the child exited within a few hundred milliseconds of the
 * banner (the Coinbase connect to the closed port fails at once and the
 * reconnect wait holds only unref'd timers), so two seconds is comfortably on
 * the failing side of the old behavior without slowing the suite much.
 */
const LIVENESS_WAIT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(describeFailure());
    }
    await delay(50);
  }
}

describe("process liveness in the real composition root (R2-H5)", () => {
  let workDir: string;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    // Build the REAL bundle from the current sources — the same artifact
    // `pnpm --filter @polymarket-bot/data-gateway start` runs.
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
    workDir = await mkdtemp(join(tmpdir(), "gateway-liveness-"));
  }, 120_000);

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    child = undefined;
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
      workDir = await mkdtemp(join(tmpdir(), "gateway-liveness-"));
    }
  });

  it(
    "recording-only reconnect wait stays alive and exits 0 only when asked (SIGTERM)",
    async () => {
      // The reviewer's probe configuration: Redis unreachable, ONE feed
      // (Coinbase) pointed at a closed loopback port so it can only wait to
      // reconnect. Both endpoints are 127.0.0.1 — nothing leaves this machine.
      const configPath = join(workDir, "gateway.json");
      await writeFile(
        configPath,
        JSON.stringify({
          streamName: "market-events",
          wal: { rootPath: join(workDir, "wal"), fsyncIntervalMs: 100 },
          tickIntervalMs: 100,
          markets: [],
          coinbase: { productIds: ["BTC-USD"], endpoint: "wss://127.0.0.1:1" },
        }),
      );

      const spawned = spawn(process.execPath, [bundlePath], {
        env: {
          ...process.env,
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_REDIS_URL: "redis://127.0.0.1:1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;

      let stderr = "";
      spawned.stderr.on("data", (chunk: Buffer) => {
        stderr += String(chunk);
      });
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolvePromise) => {
          spawned.on("exit", (code, signal) => {
            exited = { code, signal };
            resolvePromise({ code, signal });
          });
        },
      );

      // 1. Startup completes in the recording-only posture: transport failure
      //    line, terminal halt, PAGE incident, and the running banner.
      await waitFor(
        () => stderr.includes("PUBLICATION HALTED, RECORDING ONLY") || exited !== undefined,
        20_000,
        () => `the recording-only banner never appeared; stderr so far:\n${stderr}`,
      );
      expect(
        exited,
        `the process exited before finishing recording-only startup; stderr:\n${stderr}`,
      ).toBeUndefined();

      // 2. THE R2-H5 PIN. At e9cee46 the process exited 0 on its own right
      //    here — no signal, no shutdown log — because every timer was unref'd
      //    and nothing owned a referenced lifetime handle. The fixed gateway
      //    must still be alive, waiting to reconnect and record.
      await delay(LIVENESS_WAIT_MS);
      expect(
        exited,
        `R2-H5 regression: the recording-only process exited on its own ` +
          `(code ${String(exited?.code)}, signal ${String(exited?.signal)}); stderr:\n${stderr}`,
      ).toBeUndefined();
      expect(stderr).not.toContain("data-gateway: shutting down");

      // 3. The unref policy still does its job: a REQUESTED shutdown is
      //    prompt and clean — shutdown log, exit code 0, no lingering handle.
      spawned.kill("SIGTERM");
      const outcome = await Promise.race([
        exitPromise,
        delay(10_000).then(() => "timed-out" as const),
      ]);
      if (outcome === "timed-out") {
        spawned.kill("SIGKILL");
        throw new Error(`the process did not exit within 10s of SIGTERM; stderr:\n${stderr}`);
      }
      expect(stderr).toContain("data-gateway: shutting down");
      expect(outcome.code).toBe(0);
      expect(outcome.signal).toBeNull();
    },
    60_000,
  );

  it(
    "a start() that throws releases the handle: the fatal path exits 1 instead of hanging",
    async () => {
      // The Coinbase adapter refuses a non-wss endpoint INSIDE
      // `DataGateway.start()`, after the lifetime handle is acquired. Without
      // the release-on-throw guard the referenced anchor would outlive the
      // fatal error and the process would hang forever with exitCode set;
      // with it, the process exits 1 promptly. Still loopback-only: the
      // refused endpoint is never dialled.
      const configPath = join(workDir, "gateway-fatal.json");
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

      const spawned = spawn(process.execPath, [bundlePath], {
        env: {
          ...process.env,
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_REDIS_URL: "redis://127.0.0.1:1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
      let stderr = "";
      spawned.stderr?.on("data", (chunk: Buffer) => {
        stderr += String(chunk);
      });
      const exitPromise = new Promise<{ code: number | null }>((resolvePromise) => {
        spawned.on("exit", (code) => {
          resolvePromise({ code });
        });
      });

      const outcome = await Promise.race([
        exitPromise,
        delay(15_000).then(() => "timed-out" as const),
      ]);
      if (outcome === "timed-out") {
        spawned.kill("SIGKILL");
        throw new Error(
          `the fatal startup path hung instead of exiting — the lifetime handle was ` +
            `not released on a throwing start(); stderr:\n${stderr}`,
        );
      }
      expect(stderr).toContain("data-gateway: fatal");
      expect(outcome.code).toBe(1);
    },
    30_000,
  );

  it("the gateway acquires the lifetime handle at start and releases it exactly once at stop", async () => {
    const harness = await buildHarness({
      config: {
        markets: [],
        coinbase: { productIds: ["BTC-USD"] },
      },
    });
    expect(harness.lifetime).toEqual({ acquired: 0, released: 0 });

    harness.gateway.start();
    expect(harness.lifetime).toEqual({ acquired: 1, released: 0 });

    await harness.gateway.stop();
    expect(harness.lifetime).toEqual({ acquired: 1, released: 1 });

    // Double stop must not double-release: the handle is cancelled exactly once.
    await harness.gateway.stop();
    expect(harness.lifetime).toEqual({ acquired: 1, released: 1 });
  });
});
