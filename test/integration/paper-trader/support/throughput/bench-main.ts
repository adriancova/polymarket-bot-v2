/**
 * `THROUGHPUT-1a` — the benchmark's command-line entry, bundled and run by
 * `tools/bench/trader-throughput/run.sh` (see its README for every flag).
 *
 * It starts a throwaway Redis and PostgreSQL (the H1 compose images, named
 * `<prefix>-redis-*` / `<prefix>-pg-*`, removed at the end unless `--keep`),
 * creates a fresh database, applies every migration, and runs ONE mode of
 * `harness.ts`. In `paced` mode the publisher runs in a SEPARATE Node process
 * (`publish-main.ts`), as the gateway does, so its work never shares the
 * trader's event loop. It prints the report and writes it as JSON.
 *
 * `profile <file.cpuprofile>` summarises an existing profile instead.
 *
 * Throwaway credentials only (`bench`/`bench`), bound to 127.0.0.1 on a random
 * port; PAPER only; no venue, wallet, signer or credential.
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { EventEnvelope } from "@polymarket-bot/domain";
import { EventBusUnavailableError, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { createPostgresPool, migrateUp } from "@polymarket-bot/storage-postgres";

import { firstBaselineIndex, H1_MARKET_ID, readEnvelope, readEnvelopes, withMarketOpened } from "./fixture.js";
import { registerForBench, runTraderThroughput, type ThroughputReport } from "./harness.js";
import { formatProfileSummary, summarizeProfile, type CpuProfile } from "./profile-top.js";
import type { PublishLog, PublishMode } from "./publisher.js";

const execFileAsync = promisify(execFile);

interface Arguments {
  readonly command: "run" | "profile" | "register";
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positional: readonly string[];
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const booleans = new Set(["--cpu-prof", "--keep"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token.startsWith("--")) {
      if (booleans.has(token)) {
        flags.add(token);
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${token} needs a value`);
      values.set(token, value);
      index += 1;
      continue;
    }
    positional.push(token);
  }
  const command = positional[0] === "profile" ? "profile" : positional[0] === "register" ? "register" : "run";
  return { command, values, flags, positional: command === "run" ? positional : positional.slice(1) };
}

function required(args: Arguments, name: string): string {
  const value = args.values.get(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function docker(argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", [...argv], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface Containers {
  readonly redisUrl: string;
  readonly adminUrl: string;
  readonly names: readonly string[];
}

/** The H1 compose images and settings: Redis with AOF, PostgreSQL 17.5. */
async function startContainers(prefix: string, log: (line: string) => void): Promise<Containers> {
  const suffix = randomBytes(4).toString("hex");
  const redisName = `${prefix}-redis-${suffix}`;
  const pgName = `${prefix}-pg-${suffix}`;
  await docker(["run", "-d", "--name", redisName, "-p", "127.0.0.1::6379", "redis:7.4.2-alpine", "redis-server", "--appendonly", "yes"]);
  await docker([
    "run", "-d", "--name", pgName,
    "-e", "POSTGRES_USER=bench", "-e", "POSTGRES_PASSWORD=bench", "-e", "POSTGRES_DB=bench",
    "-p", "127.0.0.1::5432", "postgres:17.5-alpine",
  ]);
  const redisPort = (await docker(["port", redisName, "6379/tcp"])).split("\n")[0]?.split(":").pop() ?? "";
  const pgPort = (await docker(["port", pgName, "5432/tcp"])).split("\n")[0]?.split(":").pop() ?? "";
  log(`containers: ${redisName} (127.0.0.1:${redisPort}), ${pgName} (127.0.0.1:${pgPort})`);
  return {
    redisUrl: `redis://127.0.0.1:${redisPort}`,
    adminUrl: `postgres://bench:bench@127.0.0.1:${pgPort}/bench`,
    names: [redisName, pgName],
  };
}

async function waitForServers(redisUrl: string, adminUrl: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const transport = await RedisStreamsEventTransport.connect({ connection: { url: redisUrl }, retention: { maxEvents: 10 } });
      await transport.close();
      break;
    } catch (cause) {
      if (!(cause instanceof EventBusUnavailableError) || attempt > 60) throw cause;
      await sleep(500);
    }
  }
  for (let attempt = 1; ; attempt += 1) {
    const pool = createPostgresPool({ connectionString: adminUrl, maxConnections: 1 });
    try {
      await pool.query("select 1");
      await pool.end();
      // The image's init restarts the server once; be sure it is the final one.
      await sleep(attempt === 1 ? 1_500 : 0);
      const again = createPostgresPool({ connectionString: adminUrl, maxConnections: 1 });
      await again.query("select 1");
      await again.end();
      return;
    } catch (cause) {
      await pool.end().catch(() => undefined);
      if (attempt > 120) throw cause;
      await sleep(500);
    }
  }
}

/**
 * A fresh database on the server: migrated and empty, or (`cloneOf`) a copy of
 * a registered one, so every run cloned from it shares the minted ids.
 */
async function freshDatabase(
  adminUrl: string,
  label: string,
  migrations: string,
  cloneOf?: string,
): Promise<string> {
  const name = `bench_${label.replaceAll(/[^a-z0-9]+/gu, "_")}_${randomBytes(4).toString("hex")}`;
  const admin = createPostgresPool({ connectionString: adminUrl, maxConnections: 1 });
  try {
    // Both names are generated here or read from the harness's own file; the
    // check below refuses anything that is not a plain identifier.
    if (cloneOf !== undefined && !/^[a-z0-9_]+$/u.test(cloneOf)) throw new Error(`not a database name: ${cloneOf}`);
    await admin.query(
      cloneOf === undefined ? `create database "${name}"` : `create database "${name}" template "${cloneOf}"`,
    );
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  if (cloneOf !== undefined) return url.toString();
  const pool = createPostgresPool({ connectionString: url.toString(), maxConnections: 2, statementTimeoutMs: 120_000 });
  try {
    await migrateUp(pool, { directory: migrations, appliedBy: "throughput-1a-bench" });
  } finally {
    await pool.end();
  }
  return url.toString();
}

/** Paced publication in a separate Node process (`publish-main.ts`, bundled beside this file). */
function childPublisher(options: {
  readonly publisherBundle: string;
  readonly redisUrl: string;
  readonly workDir: string;
  readonly paceFrom: number;
  readonly log: (line: string) => void;
}): (input: {
  readonly stream: string;
  readonly envelopes: readonly EventEnvelope<unknown>[];
  readonly retentionMaxEvents: number;
}) => Promise<PublishLog> {
  return async (input) => {
    const fixture = path.join(options.workDir, "paced-envelopes.jsonl");
    const out = path.join(options.workDir, "paced-publish-log.json");
    await writeFile(fixture, input.envelopes.map((envelope) => JSON.stringify(envelope)).join("\n") + "\n");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          options.publisherBundle,
          "--redis-url", options.redisUrl,
          "--stream", input.stream,
          "--fixture", fixture,
          "--retention", String(input.retentionMaxEvents),
          "--pace-from", String(options.paceFrom),
          "--out", out,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`the publisher exited ${String(code)}`));
      });
    });
    return JSON.parse(await readFile(out, "utf8")) as PublishLog;
  };
}

function printReport(report: ThroughputReport, log: (line: string) => void): void {
  log(
    `RESULT ${report.mode}: ${report.stopped}, consumed ${String(report.consumed)}/${String(report.events)} in ` +
      `${(report.wallMs / 1000).toFixed(2)} s — ${report.eventsPerSecond.toFixed(1)} events/s, ` +
      `${report.decisionsPerSecond.toFixed(1)} decisions/s; process CPU ${(report.cpuMs / 1000).toFixed(2)} s ` +
      `(${((report.cpuMs * 1000) / Math.max(1, report.consumed)).toFixed(0)} µs/event)`,
  );
  log(
    `  lag (publish → durable commit): max ${(report.lag.maxMs / 1000).toFixed(3)} s, p99 ` +
      `${(report.lag.p99Ms / 1000).toFixed(3)} s, p50 ${(report.lag.p50Ms / 1000).toFixed(3)} s over ${String(report.lag.count)} events`,
  );
  log(
    `  durable: ${String(report.durable.decisions)} decisions, ${String(report.durable.checkpoints)} checkpoints, ` +
      `seq ${String(report.durable.minEvaluationSeq)}..${String(report.durable.maxEvaluationSeq)} ` +
      `(${String(report.durable.distinctEvaluationSeqs)} distinct), xact_commit +${String(report.durable.xactCommitDelta)}`,
  );
  log(`  decision content sha256 ${report.durable.decisionContentSha256} (normalized ${report.durable.normalizedDecisionContentSha256})`);
  log(`  checkpoint content sha256 ${report.durable.checkpointContentSha256} (normalized ${report.durable.normalizedCheckpointContentSha256})`);
  log(`  halts: ${report.halts.length === 0 ? "none" : report.halts.map((h) => `${h.scope} ${h.code}: ${h.detail}`).join(" | ")}`);
  log(`  polls ${String(report.polls)} (idle ${String(report.idlePolls)}); publish wall ${(report.publish.wallMs / 1000).toFixed(2)} s, max schedule slip ${report.publish.maxScheduleSlipMs.toFixed(1)} ms`);
}

async function main(argv: readonly string[]): Promise<number> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const args = parseArguments(argv);
  const repo = required(args, "--repo");

  if (args.command === "profile") {
    const file = args.positional[0];
    if (file === undefined) throw new Error("profile needs a .cpuprofile path");
    const profile = JSON.parse(await readFile(file, "utf8")) as CpuProfile;
    const top = Number(args.values.get("--top") ?? "30");
    process.stdout.write(`${formatProfileSummary(summarizeProfile(profile, { top, root: `file://${repo}/` }))}\n`);
    return 0;
  }

  if (args.command === "register") {
    // Registers ONCE into a database of its own, for runs that clone it
    // (`--registered <dir>`): they then share every minted id.
    const dir = path.resolve(required(args, "--registered"));
    await mkdir(dir, { recursive: true });
    const adminUrl = required(args, "--postgres-url");
    const databaseUrl = await freshDatabase(adminUrl, "registered", path.join(repo, "db", "migrations"));
    const document = await registerForBench({
      databaseUrl,
      templatePath: required(args, "--template"),
      workDir: dir,
      instanceName: `throughput-bench-registered-${randomBytes(4).toString("hex")}`,
      codeCommit: args.values.get("--code-commit") ?? "unknown",
      log,
    });
    await writeFile(path.join(dir, "document.json"), `${JSON.stringify(document, null, 2)}\n`);
    await writeFile(path.join(dir, "database.txt"), `${new URL(databaseUrl).pathname.slice(1)}\n`);
    log(`registered into ${new URL(databaseUrl).pathname.slice(1)}; document ${path.join(dir, "document.json")}`);
    return 0;
  }

  const mode = required(args, "--mode") as PublishMode;
  if (mode !== "catch-up" && mode !== "paced") throw new Error("--mode is catch-up or paced");
  const outDir = path.resolve(required(args, "--out-dir"));
  await mkdir(outDir, { recursive: true });
  const recorded = await readEnvelopes(required(args, "--fixture"));
  // The replayable suffix: see `firstBaselineIndex` (H1's burst: 334 leading
  // level changes precede the first authoritative snapshot).
  const cut = firstBaselineIndex(recorded);
  const limit = args.values.has("--limit") ? Number(args.values.get("--limit")) : undefined;
  const burst = recorded.slice(cut, limit === undefined ? undefined : cut + limit);
  log(
    `fixture: ${String(recorded.length)} recorded envelopes; replaying ${String(burst.length)} from index ` +
      `${String(cut)} (the first authoritative BookSnapshot baseline), plus MarketOpened`,
  );
  const envelopes = withMarketOpened(await readEnvelope(required(args, "--market-opened")), burst);
  // Catch-up publishes everything first, so the stream must retain all of it;
  // paced keeps the H1 document's bound unless told otherwise.
  const retention = Number(args.values.get("--retention") ?? (mode === "catch-up" ? String(Math.max(100_000, envelopes.length)) : "100000"));

  let containers: Containers | undefined;
  const redisUrlArg = args.values.get("--redis-url");
  const adminUrlArg = args.values.get("--postgres-url");
  if (redisUrlArg === undefined || adminUrlArg === undefined) {
    containers = await startContainers(args.values.get("--container-prefix") ?? "tp-bench", log);
  }
  const redisUrl = redisUrlArg ?? containers?.redisUrl ?? "";
  const adminUrl = adminUrlArg ?? containers?.adminUrl ?? "";
  try {
    await waitForServers(redisUrl, adminUrl);
    const registeredDir = args.values.get("--registered");
    const registered =
      registeredDir === undefined
        ? undefined
        : {
            document: JSON.parse(await readFile(path.join(registeredDir, "document.json"), "utf8")) as Record<string, unknown>,
            database: (await readFile(path.join(registeredDir, "database.txt"), "utf8")).trim(),
          };
    const databaseUrl = await freshDatabase(adminUrl, mode, path.join(repo, "db", "migrations"), registered?.database);
    const stream = `bench-${mode}-${randomBytes(4).toString("hex")}`;
    const workDir = path.join(outDir, stream);
    await mkdir(workDir, { recursive: true });
    const publisherBundle = args.values.get("--publisher-bundle");
    const report = await runTraderThroughput({
      redisUrl,
      databaseUrl,
      registration:
        registered === undefined
          ? { kind: "register", templatePath: required(args, "--template") }
          : { kind: "registered", document: registered.document },
      workDir,
      envelopes,
      recordedMarketId: args.values.get("--recorded-market-id") ?? H1_MARKET_ID,
      mode,
      stream,
      consumerId: "trader-bench",
      retentionMaxEvents: retention,
      paceFrom: 1,
      ...(mode === "paced" && publisherBundle !== undefined
        ? { startPacedPublisher: childPublisher({ publisherBundle, redisUrl, workDir, paceFrom: 1, log }) }
        : {}),
      ...(args.flags.has("--cpu-prof") ? { cpuProfileDir: workDir } : {}),
      decisionsOut: path.join(workDir, "decisions.jsonl"),
      checkpointsOut: path.join(workDir, "checkpoints.jsonl"),
      codeCommit: args.values.get("--code-commit") ?? "unknown",
      log,
    });
    await writeFile(path.join(workDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    printReport(report, log);
    if (report.cpuProfile !== null) {
      const profile = JSON.parse(await readFile(report.cpuProfile, "utf8")) as CpuProfile;
      const summary = formatProfileSummary(summarizeProfile(profile, { top: 30, root: `file://${repo}/` }));
      await writeFile(path.join(workDir, "profile-top.txt"), `${summary}\n`);
      log(summary);
    }
    log(`artifacts: ${workDir}`);
    return report.stopped === "COMPLETE" && report.consumed === report.events ? 0 : 1;
  } finally {
    if (containers !== undefined && !args.flags.has("--keep")) {
      await docker(["rm", "-f", ...containers.names]).catch(() => "");
      log(`removed ${containers.names.join(", ")}`);
    }
  }
}

process.exitCode = await main(process.argv.slice(2)).catch((cause: unknown) => {
  process.stderr.write(`bench failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  return 2;
});
