/**
 * `THROUGHPUT-1b` item 3 — a gateway that records markets but no book says so.
 *
 * H1 run 1's first attempt ran the shipped example configuration, which had
 * a market and its lifecycle feed but no `polymarket` block. The gateway
 * therefore never subscribed to the CLOB market channel: it recorded the
 * lifecycle and the reference feeds, produced ZERO order-book events, and
 * nothing announced it; the trader made no decision in five minutes because
 * no feature snapshot could be computed without a book.
 *
 * Pinned here:
 * - markets configured and no `polymarket` block → ONE NOTIFY incident,
 *   `GATEWAY_BOOK_FEED_ABSENT`, at start: through the observer (which
 *   `main.ts` writes as the `[incident]` log line) and in the stream; for a
 *   lifecycle-only configuration (H1 attempt 1's shape) and a reference-only
 *   one alike;
 * - with the `polymarket` block, or with no markets at all, nothing;
 * - the shipped example configuration passes the configuration door, carries
 *   the `polymarket` block, and a gateway built from it announces nothing of
 *   the kind;
 * - the REAL bundle prints the `[incident]` line on stderr at start.
 *
 * Offline: in-memory transport and filesystem, scripted sockets; the bundle
 * test uses closed loopback ports only, as `process-liveness.test.ts` does.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { parseGatewayConfig } from "@polymarket-bot/data-gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarness, MARKET, type Harness } from "./support/harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const EXAMPLE_CONFIG = resolve(repoRoot, "infra/compose/data-gateway/gateway.config.example.json");
const BOOK_FEED_ABSENT = "GATEWAY_BOOK_FEED_ABSENT";

function announced(harness: Harness): { readonly observed: number; readonly published: number } {
  const observed = harness.incidents.filter((incident) => incident.reasonCode === BOOK_FEED_ABSENT);
  const published = harness
    .publishedOfType("DataQualityIncidentOpened")
    .filter(
      (envelope: EventEnvelope<unknown>) =>
        (envelope.payload as Record<string, unknown>)["reasonCode"] === BOOK_FEED_ABSENT,
    );
  return { observed: observed.length, published: published.length };
}

async function started(config: Record<string, unknown>): Promise<Harness> {
  const harness = await buildHarness({ config });
  harness.gateway.start();
  await harness.settle();
  await harness.gateway.stop();
  return harness;
}

const LIFECYCLE_ONLY = {
  markets: [{ ...MARKET, gammaMarketId: "900001" }],
  lifecycle: { feedId: "polymarket-lifecycle", baseUrl: "http://gamma.stub", pollIntervalMs: 10_000 },
};

const BINANCE = {
  feedId: "binance-reference",
  symbols: ["BTCUSDT"],
  stalenessThresholdMs: 30_000,
};

describe("GATEWAY_BOOK_FEED_ABSENT — markets without a book feed are announced at start", () => {
  it("a lifecycle-only gateway (H1 attempt 1's shape) announces it once, NOTIFY, in the log path and in the stream", async () => {
    const harness = await started(LIFECYCLE_ONLY);
    const incident = harness.incidents.find((candidate) => candidate.reasonCode === BOOK_FEED_ABSENT);
    expect(incident?.severity).toBe("NOTIFY");
    expect(incident?.detail).toContain("1 Polymarket market(s) are configured but no `polymarket` feed is");
    expect(incident?.detail).toContain("no BookSnapshot/BookLevelChanged is ever produced");
    expect(incident?.detail).toContain('{"feedId": "polymarket-market"}');
    expect(announced(harness)).toEqual({ observed: 1, published: 1 });
    // It is the FIRST thing the gateway says: announced at start, before any feed ran.
    expect(harness.incidents[0]?.reasonCode).toBe(BOOK_FEED_ABSENT);
    const envelope = harness.publishedOfType("DataQualityIncidentOpened")[0];
    expect((envelope?.payload as Record<string, unknown> | undefined)?.["severity"]).toBe("NOTIFY");
  });

  it("a reference-only gateway with configured markets announces it too", async () => {
    const harness = await started({ binance: BINANCE });
    expect(announced(harness)).toEqual({ observed: 1, published: 1 });
  });

  it("with the polymarket block, or with no markets, nothing is announced", async () => {
    const withBooks = await started({ ...LIFECYCLE_ONLY, polymarket: { feedId: "polymarket-market" } });
    expect(announced(withBooks)).toEqual({ observed: 0, published: 0 });

    const noMarkets = await started({ markets: [], binance: BINANCE });
    expect(announced(noMarkets)).toEqual({ observed: 0, published: 0 });
  });

  it("the shipped example configuration passes the door, subscribes to books, and announces nothing of the kind", async () => {
    const example = JSON.parse(await readFile(EXAMPLE_CONFIG, "utf8")) as Record<string, unknown>;
    // The door, exactly as `main.ts` applies it.
    const parsed = parseGatewayConfig(example);
    expect(parsed.polymarket).toEqual({ feedId: "polymarket-market" });
    expect(parsed.markets.length).toBeGreaterThan(0);

    // A gateway built from it (the WAL moved onto the in-memory filesystem).
    const harness = await started({ ...example, wal: { ...(example["wal"] as object), rootPath: "/wal" } });
    expect(announced(harness)).toEqual({ observed: 0, published: 0 });
    expect(harness.polymarketSockets).toBeDefined();
  });
});

describe("GATEWAY_BOOK_FEED_ABSENT in the REAL bundle's [incident] log", () => {
  let workDir: string;
  let bundlePath: string;
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "gateway-book-feed-absent-"));
    bundlePath = join(workDir, "main.cjs");
    // Built into this test's own directory with the gateway's own esbuild and
    // flags, so it cannot race the other files that build `dist/main.cjs`.
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const build = spawn(
        resolve(repoRoot, "apps/data-gateway/node_modules/.bin/esbuild"),
        [
          resolve(repoRoot, "apps/data-gateway/src/main.ts"),
          "--bundle",
          "--platform=node",
          "--format=cjs",
          "--target=node24",
          "--log-level=warning",
          `--outfile=${bundlePath}`,
        ],
        { cwd: resolve(repoRoot, "apps/data-gateway"), stdio: ["ignore", "pipe", "pipe"] },
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
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`bundle build failed (exit ${String(code)}):\n${output}`));
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await rm(workDir, { recursive: true, force: true });
  });

  it("prints `[incident] NOTIFY GATEWAY_BOOK_FEED_ABSENT` at start and still exits 0 on SIGTERM", async () => {
    // A market, and ONE feed (Coinbase) on a closed loopback port; Redis on a
    // closed loopback port too. Nothing leaves this machine.
    const configPath = join(workDir, "gateway.json");
    await writeFile(
      configPath,
      JSON.stringify({
        streamName: "market-events",
        wal: { rootPath: join(workDir, "wal"), fsyncIntervalMs: 100 },
        tickIntervalMs: 100,
        markets: [MARKET],
        coinbase: { productIds: ["BTC-USD"], endpoint: "wss://127.0.0.1:1" },
      }),
    );
    const spawned = spawn(process.execPath, [bundlePath], {
      env: { ...process.env, GATEWAY_CONFIG_PATH: configPath, GATEWAY_REDIS_URL: "redis://127.0.0.1:1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    let stderr = "";
    spawned.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolvePromise) => {
      spawned.on("exit", (code) => {
        resolvePromise(code);
      });
    });

    // Wait for the running banner as well as the incident: `run.ts` installs
    // the shutdown handlers in the same synchronous turn that prints the
    // banner, AFTER `start()` announced the incident. A SIGTERM sent on the
    // incident line alone can arrive before the handlers exist and kill the
    // process with the default action (exit code null).
    const deadline = Date.now() + 20_000;
    while (
      !(stderr.includes(`NOTIFY ${BOOK_FEED_ABSENT}`) && stderr.includes("data-gateway running:")) &&
      Date.now() < deadline &&
      spawned.exitCode === null
    ) {
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 50);
      });
    }
    expect(stderr, stderr).toMatch(/\[incident\] NOTIFY GATEWAY_BOOK_FEED_ABSENT \(gw-books-\d+\): 1 Polymarket market/u);
    expect(stderr, stderr).toContain("data-gateway running:");

    spawned.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<"timed-out">((resolveTimeout) => {
        setTimeout(() => {
          resolveTimeout("timed-out");
        }, 10_000);
      }),
    ]);
    expect(code, stderr).toBe(0);
    expect(stderr).toContain("data-gateway: shutting down");
  }, 60_000);
});
