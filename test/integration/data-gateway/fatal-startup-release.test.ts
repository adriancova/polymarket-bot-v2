/**
 * Fatal startup releases every acquired resource (round-3 review R3-H1).
 *
 * The finding, mirror image of R2-H5: `main.ts` connects and OWNS the Redis
 * transport BEFORE `DataGateway.create()` opens the WAL, and the outer fatal
 * handler only set `process.exitCode = 1` — so a WAL-open failure logged
 * `data-gateway: fatal` and then sat FOREVER on the connected transport's
 * referenced socket (the reviewer's probe: fatal log, then exit 124 by
 * timeout; exit 1 only with transport cleanup enabled).
 *
 * The reviewer's prescribed regression needs a CONNECTED, reference-owning
 * transport, which no closed loopback port can produce and no real Redis or
 * listening stub is permitted here. So this file spawns the dev-only probe
 * entry (`apps/data-gateway/src/testing/fatal-startup-probe-entry.ts`): the
 * REAL `runGatewaySequence` — the same code `main.ts` runs — on the real
 * system ports and real node WAL filesystem, substituting exactly one thing:
 * an in-memory transport holding one referenced handle, whose `close()` logs
 * every call. The fatal defects are injected purely through configuration,
 * the way production would meet them:
 *
 * 1. `wal.rootPath` pointing at an existing regular FILE → `mkdir` fails with
 *    `ENOTDIR` inside `DataGateway.create()`, after the transport connected.
 * 2. a `ws://` Coinbase endpoint → the real adapter refuses it inside
 *    `gateway.start()`, after `create()` succeeded (nothing is ever dialled).
 *
 * Both assert the R3-H1 invariant end to end: fatal log, `close()` called
 * EXACTLY once, prompt exit 1 — no timeout. Probe-first: with the fatal-path
 * cleanup removed from `run.ts` (the `45c231c` semantics), both tests fail by
 * the timeout shape, reproducing the reviewer's exit-124.
 *
 * A third test pins the REAL bundle's fatal path with the only transport
 * state closed loopback ports can produce (the `UnavailableEventTransport`
 * fallback): WAL-open failure → cleanup log → prompt exit 1.
 *
 * SAFETY: closed loopback ports only (`redis://127.0.0.1:1`,
 * `wss://127.0.0.1:1`, and a refused-before-dial `ws://127.0.0.1:1`); no
 * server listens anywhere; no venue, no credential, nothing leaves this
 * machine.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const mainBundlePath = resolve(repoRoot, "apps/data-gateway/dist/main.cjs");
const probeBundlePath = resolve(repoRoot, "apps/data-gateway/dist/fatal-startup-probe-entry.cjs");

/** Fails LOUDLY if the build tooling is missing, per the round-2 discipline. */
function buildWithPnpm(args: readonly string[]): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const build = spawn("pnpm", [...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        rejectPromise(
          new Error(`bundle build failed (exit ${String(code)}): pnpm ${args.join(" ")}\n${output}`),
        );
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

interface SpawnedOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

describe("fatal startup releases every acquired resource (R3-H1)", () => {
  let workDir: string;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    // The real artifact `pnpm --filter @polymarket-bot/data-gateway start`
    // runs, plus the probe entry, both built from the sources under test.
    await buildWithPnpm(["--filter", "@polymarket-bot/data-gateway", "run", "build"]);
    await buildWithPnpm([
      "--filter",
      "@polymarket-bot/data-gateway",
      "exec",
      "esbuild",
      "src/testing/fatal-startup-probe-entry.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node24",
      "--outfile=dist/fatal-startup-probe-entry.cjs",
    ]);
    workDir = await mkdtemp(join(tmpdir(), "gateway-fatal-release-"));
  }, 120_000);

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    child = undefined;
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
      workDir = await mkdtemp(join(tmpdir(), "gateway-fatal-release-"));
    }
  });

  /**
   * Spawns a bundle and requires it to EXIT on its own within `timeoutMs` —
   * the R3-H1 assertion is precisely that the fatal path cannot hang.
   */
  async function runToExit(
    bundlePath: string,
    configPath: string,
    env: Record<string, string>,
    timeoutMs: number,
    hangDescription: string,
  ): Promise<SpawnedOutcome> {
    const spawned = spawn(process.execPath, [bundlePath], {
      env: { ...process.env, GATEWAY_CONFIG_PATH: configPath, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    let stderr = "";
    spawned.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    const exitPromise = new Promise<SpawnedOutcome>((resolvePromise) => {
      spawned.on("exit", (code, signal) => {
        resolvePromise({ code, signal, stderr });
      });
    });
    const outcome = await Promise.race([
      exitPromise,
      delay(timeoutMs).then(() => "timed-out" as const),
    ]);
    if (outcome === "timed-out") {
      spawned.kill("SIGKILL");
      throw new Error(`${hangDescription}; stderr:\n${stderr}`);
    }
    return outcome;
  }

  it(
    "a WAL that will not open AFTER the transport connected closes the transport exactly once and exits 1 promptly",
    async () => {
      // The injected WAL-open failure: the WAL root is an existing regular
      // FILE, so the real filesystem's recursive mkdir of
      // `<root>/<gatewayEpoch>` fails with ENOTDIR inside create().
      const walRootFile = join(workDir, "wal-root-is-a-file");
      await writeFile(walRootFile, "not a directory\n");
      const configPath = join(workDir, "gateway.json");
      await writeFile(
        configPath,
        JSON.stringify({
          streamName: "market-events",
          wal: { rootPath: walRootFile, fsyncIntervalMs: 100 },
          tickIntervalMs: 100,
          markets: [],
          // Never dialled: create() fails before any feed starts. Closed
          // loopback port regardless, so a defect here still reaches no venue.
          coinbase: { productIds: ["BTC-USD"], endpoint: "wss://127.0.0.1:1" },
        }),
      );

      // THE R3-H1 PIN. At 45c231c this composition logged the fatal error and
      // then hung forever on the connected transport's referenced handle (the
      // reviewer's exit-124 shape, reproduced probe-first with the fatal-path
      // cleanup removed). Fixed, it must exit 1 on its own, promptly.
      const outcome = await runToExit(
        probeBundlePath,
        configPath,
        {},
        15_000,
        "R3-H1 regression: the fatal WAL-open path hung instead of exiting — " +
          "the connected transport was not closed",
      );

      expect(outcome.stderr).toContain("data-gateway: fatal");
      expect(outcome.stderr).toContain(
        "startup failed before the gateway existed; closing the event-bus transport",
      );
      expect(outcome.stderr, "close must be called").toContain("[probe] transport.close() call 1");
      expect(outcome.stderr, "close must be called EXACTLY once").not.toContain(
        "[probe] transport.close() call 2",
      );
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
    },
    30_000,
  );

  it(
    "a start() that throws AFTER create() stops the partial gateway (journal + transport) exactly once and exits 1 promptly",
    async () => {
      // Valid WAL root; the fatal strikes one boundary later, inside
      // start(): the real Coinbase adapter refuses a non-wss endpoint before
      // dialling anything.
      const configPath = join(workDir, "gateway.json");
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

      const outcome = await runToExit(
        probeBundlePath,
        configPath,
        {},
        15_000,
        "R3-H1 regression: the fatal start() path hung instead of exiting — " +
          "the created gateway (and with it the connected transport) was not stopped",
      );

      expect(outcome.stderr).toContain("data-gateway: fatal");
      expect(outcome.stderr).toContain("startup failed after the gateway was created; stopping it");
      expect(outcome.stderr).toContain("[probe] transport.close() call 1");
      expect(outcome.stderr).not.toContain("[probe] transport.close() call 2");
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
    },
    30_000,
  );

  it(
    "the REAL bundle's WAL-open fatal path runs the same cleanup and exits 1 promptly (unavailable-transport fallback)",
    async () => {
      // Closed loopback ports can only produce the fallback transport state,
      // which holds nothing referenced — so this cannot reproduce the leak
      // (the probe entry above exists for that). It DOES pin that the real
      // main.cjs runs the transactional cleanup and exits 1 fast on the exact
      // WAL defect of the finding.
      const walRootFile = join(workDir, "wal-root-is-a-file");
      await writeFile(walRootFile, "not a directory\n");
      const configPath = join(workDir, "gateway.json");
      await writeFile(
        configPath,
        JSON.stringify({
          streamName: "market-events",
          wal: { rootPath: walRootFile, fsyncIntervalMs: 100 },
          tickIntervalMs: 100,
          markets: [],
          coinbase: { productIds: ["BTC-USD"], endpoint: "wss://127.0.0.1:1" },
        }),
      );

      const outcome = await runToExit(
        mainBundlePath,
        configPath,
        { GATEWAY_REDIS_URL: "redis://127.0.0.1:1" },
        20_000,
        "the real bundle's fatal WAL-open path hung instead of exiting",
      );

      expect(outcome.stderr).toContain("the event bus was unreachable at startup");
      expect(outcome.stderr).toContain(
        "startup failed before the gateway existed; closing the event-bus transport",
      );
      expect(outcome.stderr).toContain("data-gateway: fatal");
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
    },
    40_000,
  );
});
