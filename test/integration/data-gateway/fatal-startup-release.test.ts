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
 * Round 5 adds four pins: hostile `GATEWAY_CLEANUP_DEADLINE_MS` values are
 * refused fail-closed through the REAL bundle before anything opens, unset or
 * empty means the default (M-1); a valid deadline never punishes a
 * legitimate slow cleanup (M-1); and a `journal.close()` that never settles
 * inside `create()`'s own post-open cleanup still force-exits within the
 * bound (M-2 — before the fix that child hung to this suite's SIGKILL guard
 * with the deadline never armed and the transport never closed).
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
    "a transport whose close() REJECTS while holding its referenced handle: the cleanup deadline forces exit 1 (round 4)",
    async () => {
      // The round-4 finding: at `95c8aa9` a cleanup FAILURE was only logged
      // and the original error rethrown to a handler that merely set
      // `process.exitCode = 1` — no fallback exit existed. A transport whose
      // `close()` rejects before releasing its referenced handle therefore
      // produced the fatal log and then the ORIGINAL hang shape (timeout,
      // exit 124). The fix: a REFERENCED hard-deadline timer armed at
      // fatal-cleanup entry that forces a nonzero exit when cleanup does not
      // complete, cleared only when cleanup succeeds.
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
        probeBundlePath,
        configPath,
        {
          GATEWAY_PROBE_TRANSPORT_CLOSE: "reject-holding-handle",
          GATEWAY_CLEANUP_DEADLINE_MS: "1500",
        },
        15_000,
        "round-4 regression: the fatal path with a rejecting, handle-holding transport " +
          "close hung instead of exiting — no fallback exit deadline fired",
      );

      expect(outcome.stderr, "the cleanup failure itself must be logged").toContain(
        "fatal-path transport close failed",
      );
      expect(outcome.stderr, "the deadline must announce the forced exit").toContain(
        "cleanup deadline",
      );
      expect(outcome.stderr).toContain("data-gateway: fatal");
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
    },
    30_000,
  );

  it(
    "a clean fatal cleanup clears the deadline: exit 1 arrives well before the deadline with no deadline log (round 4)",
    async () => {
      // The round-2 lesson, applied to the new timer: the deadline is the one
      // deliberately REFERENCED fallback, so a cleanup that completes must
      // CLEAR it — a stray referenced deadline would hold the exiting process
      // open until its expiry and then force-exit a process that had already
      // finished its cleanup. Deadline 8 s, exit asserted well under it.
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

      const startedAtMs = Date.now();
      const outcome = await runToExit(
        probeBundlePath,
        configPath,
        { GATEWAY_CLEANUP_DEADLINE_MS: "8000" },
        15_000,
        "round-4 regression: the clean fatal path hung instead of exiting",
      );
      const elapsedMs = Date.now() - startedAtMs;

      expect(outcome.stderr).toContain(
        "startup failed before the gateway existed; closing the event-bus transport",
      );
      expect(outcome.stderr, "a cleared deadline must never fire").not.toContain(
        "cleanup deadline",
      );
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
      expect(
        elapsedMs,
        "a cleared deadline must not hold the exiting process to its expiry",
      ).toBeLessThan(6_000);
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

  it(
    "hostile GATEWAY_CLEANUP_DEADLINE_MS values are refused fail-closed before anything opens (round 5, M-1)",
    async () => {
      // The round-5 finding: `Number(env)` accepted every one of these, and
      // Node's setTimeout coerced each to an effectively immediate deadline —
      // NaN force-exited a LEGITIMATE 50 ms transport close after ~4 ms. The
      // config here is VALID; only the deadline is hostile, so a pass proves
      // the refusal happens before the transport is attempted or the WAL
      // opens (the unreachable-bus line below never appears).
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

      // The five reviewer probes, a float, and a non-numeric string.
      const hostile = ["NaN", "-5", "0", "Infinity", "2147483648", "1500.5", "not-a-number"];
      for (const value of hostile) {
        const outcome = await runToExit(
          mainBundlePath,
          configPath,
          {
            GATEWAY_REDIS_URL: "redis://127.0.0.1:1",
            GATEWAY_CLEANUP_DEADLINE_MS: value,
          },
          15_000,
          `round-5 M-1 regression: GATEWAY_CLEANUP_DEADLINE_MS=${value} did not refuse promptly`,
        );
        expect(outcome.stderr, `${value}: the refusal must name the variable`).toContain(
          "GATEWAY_CLEANUP_DEADLINE_MS",
        );
        expect(outcome.stderr, `${value}: the refusal must name the offending value`).toContain(
          `got "${value}"`,
        );
        expect(outcome.stderr, `${value}: the refusal must name the permitted domain`).toContain(
          "from 100 to 2147483647",
        );
        expect(
          outcome.stderr,
          `${value}: the refusal must precede the transport attempt`,
        ).not.toContain("the event bus was unreachable at startup");
        expect(outcome.stderr, `${value}: nothing may start`).not.toContain(
          "data-gateway running",
        );
        expect(outcome.code, `${value}: exit code`).toBe(1);
        expect(outcome.signal, `${value}: no signal`).toBeNull();
      }
    },
    120_000,
  );

  it(
    "an unset-or-empty GATEWAY_CLEANUP_DEADLINE_MS means the default: the sequence still runs (round 5, M-1)",
    async () => {
      // Pins the decided empty/unset semantics through the REAL bundle: empty
      // is absent (the package's GATEWAY_CONFIG_PATH treatment), so the
      // sequence runs under the default deadline — proven by the fatal
      // cleanup lines appearing with NO deadline refusal.
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
        { GATEWAY_REDIS_URL: "redis://127.0.0.1:1", GATEWAY_CLEANUP_DEADLINE_MS: "" },
        20_000,
        "round-5 M-1 regression: an empty GATEWAY_CLEANUP_DEADLINE_MS hung instead of defaulting",
      );

      expect(outcome.stderr, "empty means default, never a refusal").not.toContain(
        "must be a whole number of milliseconds",
      );
      expect(outcome.stderr, "the sequence ran under the default").toContain(
        "startup failed before the gateway existed; closing the event-bus transport",
      );
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
    },
    40_000,
  );

  it(
    "a valid small deadline never punishes a legitimate slow cleanup (round 5, M-1)",
    async () => {
      // The reviewer's healthy-cleanup control, pinned: a transport close that
      // LEGITIMATELY takes 50 ms under a valid 200 ms deadline completes
      // normally — exit 1 by the ordinary fatal path, deadline log absent.
      // (Unfixed, `NaN` reached setTimeout here and force-exited this same
      // close after ~4 ms with `cleanup deadline (NaN ms)` on stderr.)
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
        probeBundlePath,
        configPath,
        {
          GATEWAY_PROBE_TRANSPORT_CLOSE: "resolve-after-50ms",
          GATEWAY_CLEANUP_DEADLINE_MS: "200",
        },
        15_000,
        "round-5 M-1 regression: the legitimate 50 ms close under a 200 ms deadline hung",
      );

      expect(outcome.stderr, "a healthy cleanup must never see the deadline fire").not.toContain(
        "cleanup deadline",
      );
      expect(outcome.stderr).toContain("[probe] transport.close() call 1");
      expect(outcome.stderr).not.toContain("[probe] transport.close() call 2");
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
    },
    30_000,
  );

  it(
    "a journal close that never settles inside create()'s own cleanup: the deadline forces exit 1 within the bound (round 5, M-2)",
    async () => {
      // The reviewer's exact regression: a post-open feed-construction
      // refusal (the Polymarket ports are omitted while the feed is
      // configured) plus a never-settling journal close, with the
      // reference-owning transport connected. At 767ecfd `create()` awaited
      // `journal.close()` BEFORE rejecting and the sequence's deadline armed
      // only in its catch — so this child stayed pending forever: deadline
      // arms 0, transport closes 0, referenced handle held until this
      // suite's SIGKILL guard. Fixed, create() arms the sequence-supplied
      // deadline the moment its failure path begins, and the expiry forces
      // the exit.
      const configPath = join(workDir, "gateway.json");
      await writeFile(
        configPath,
        JSON.stringify({
          streamName: "market-events",
          wal: { rootPath: join(workDir, "wal"), fsyncIntervalMs: 100 },
          tickIntervalMs: 100,
          markets: [
            {
              internalMarketId: "01990000-0000-7000-8000-000000000001",
              conditionId: "0x" + "ab".repeat(31),
              yesTokenId: "11111",
              noTokenId: "22222",
              parameters: {
                tickSize: "0.01",
                minimumOrderSize: "5",
                negRisk: false,
                tradingDelaySeconds: 0,
                status: "OPEN",
              },
              observedAt: "2026-08-30T12:00:00.000Z",
            },
          ],
          polymarket: { feedId: "pm-main", url: "wss://127.0.0.1:1" },
        }),
      );

      const startedAtMs = Date.now();
      const outcome = await runToExit(
        probeBundlePath,
        configPath,
        {
          GATEWAY_PROBE_OMIT_PORT: "polymarket",
          GATEWAY_PROBE_JOURNAL_CLOSE: "never-settle",
          GATEWAY_CLEANUP_DEADLINE_MS: "1500",
        },
        15_000,
        "round-5 M-2 regression: a never-settling journal close inside create() hung " +
          "instead of force-exiting — the deadline never covered create()'s own cleanup",
      );
      const elapsedMs = Date.now() - startedAtMs;

      expect(outcome.stderr, "the injected hang must have been reached").toContain(
        "[probe] journal.close() will never settle (injected)",
      );
      expect(outcome.stderr, "the deadline must announce the forced exit").toContain(
        "cleanup deadline",
      );
      expect(outcome.stderr).toContain("fatal-startup");
      expect(
        outcome.stderr,
        "the sequence catch never runs — create() is still pending when the deadline fires",
      ).not.toContain("[probe] transport.close() call");
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
      expect(elapsedMs, "the forced exit must arrive within the bound").toBeLessThan(10_000);
    },
    30_000,
  );

  it(
    "SIGTERM with a hanging journal close AND a throwing feed close: every sibling disposal is initiated, the evidence is retained, and the deadline forces exit 1 (round 6, M-1)",
    async () => {
      // The round-6 reviewer's combined probe, end to end. At d2fbbfa
      // `stop()` awaited its disposals SEQUENTIALLY — `journal.close()` had
      // to settle before `transport.close()` was even called — so this child
      // force-exited with socket=1, journal=1, transport=0: the transport
      // cleanup was never attempted, and the collected feed-close failure
      // never reached `GatewayDisposalError` (stop() never settled, so the
      // aggregate error never existed) or any log. Fixed, the two
      // independent disposal families are INITIATED together (the transport
      // close completes despite the hang), every settled failure is reported
      // the moment it is collected, and the shutdown deadline still bounds
      // the hung family with a logged, forced nonzero exit.
      const configPath = join(workDir, "gateway.json");
      await writeFile(
        configPath,
        JSON.stringify({
          streamName: "market-events",
          wal: { rootPath: join(workDir, "wal"), fsyncIntervalMs: 100 },
          tickIntervalMs: 100,
          markets: [],
          // Never dialled: the throwing-close fake socket replaces the real
          // factory; the closed loopback port guards the config regardless.
          coinbase: { productIds: ["BTC-USD"], endpoint: "wss://127.0.0.1:1" },
        }),
      );

      const spawned = spawn(process.execPath, [probeBundlePath], {
        env: {
          ...process.env,
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_PROBE_JOURNAL_CLOSE: "never-settle",
          GATEWAY_PROBE_COINBASE_SOCKET_CLOSE: "throw",
          GATEWAY_CLEANUP_DEADLINE_MS: "1500",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
      let stderr = "";
      spawned.stderr.on("data", (chunk: Buffer) => {
        stderr += String(chunk);
      });
      let exited: SpawnedOutcome | undefined;
      const exitPromise = new Promise<SpawnedOutcome>((resolvePromise) => {
        spawned.on("exit", (code, signal) => {
          exited = { code, signal, stderr };
          resolvePromise({ code, signal, stderr });
        });
      });

      // Startup must complete: this probe is about the SIGNAL disposal path.
      const runningDeadline = Date.now() + 20_000;
      while (!stderr.includes("data-gateway running") && exited === undefined) {
        if (Date.now() > runningDeadline) {
          spawned.kill("SIGKILL");
          throw new Error(`the probe child never finished startup; stderr:\n${stderr}`);
        }
        await delay(50);
      }
      expect(exited, `the child exited during startup; stderr:\n${stderr}`).toBeUndefined();

      const signalledAtMs = Date.now();
      spawned.kill("SIGTERM");
      const outcome = await Promise.race([
        exitPromise,
        delay(15_000).then(() => "timed-out" as const),
      ]);
      if (outcome === "timed-out") {
        spawned.kill("SIGKILL");
        throw new Error(
          "round-6 M-1 regression: the shutdown with a hanging journal close hung past " +
            `the deadline instead of force-exiting; stderr:\n${stderr}`,
        );
      }
      const elapsedMs = Date.now() - signalledAtMs;

      expect(outcome.stderr).toContain("data-gateway: shutting down");
      // journal=1: the hung disposal was initiated (its injected-hang line).
      expect(outcome.stderr).toContain("[probe] journal.close() will never settle (injected)");
      // THE PIN — transport=1, not 0: the sibling family was initiated and
      // completed despite the hang, exactly once.
      expect(
        outcome.stderr,
        "the transport disposal must be initiated despite the hanging journal close",
      ).toContain("[probe] transport.close() call 1");
      expect(outcome.stderr).not.toContain("[probe] transport.close() call 2");
      // Evidence retention: the settled feed-close failure is on stderr even
      // though stop() never settled and the process was force-exited.
      expect(outcome.stderr, "the collected feed-close failure must be observable").toContain(
        "[disposal] coinbase-manager cleanup failed: injected coinbase socket close failure (probe)",
      );
      // The hang's own evidence: the deadline log, then the forced exit.
      expect(outcome.stderr, "the deadline must announce the forced exit").toContain(
        "cleanup deadline",
      );
      expect(outcome.stderr).toContain("shutdown");
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
      expect(elapsedMs, "the forced exit must arrive within the bound").toBeLessThan(10_000);
    },
    60_000,
  );
});
