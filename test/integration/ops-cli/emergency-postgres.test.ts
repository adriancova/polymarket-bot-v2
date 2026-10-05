/**
 * WP-330 against a REAL PostgreSQL (Testcontainers; every migration applied):
 *
 * 1. stop-heartbeat through the SHIPPED composition (`main`), bound to WP-320's
 *    real `FencingLeaseStore`: the dry run shows the ACTIVE lease and revokes
 *    nothing; the confirmed run revokes exactly that lease (status REVOKED,
 *    the operator and reason on the row), after which the holder can neither
 *    renew nor be valid; and every audit record also lands in
 *    `ops.config_change_audit`, joined to the local log by record id.
 * 2. A PAPER refusal through `main` is mirrored too (the gate's verdict is on
 *    the row; no environment is claimed).
 * 3. Acceptance 1 with a database that is REALLY unreachable (a refused local
 *    connection, no tripwire): cancel-all completes from venue truth and the
 *    emergency credential alone, with the real PostgreSQL audit mirror failing
 *    beside it. No trader process exists in this test.
 * 4. The SHIPPED BUNDLE (WP-330 r0; ADR-018 §4), built by the app's own
 *    `build` script and run as a child process in PAPER: refused by the gate,
 *    and both audit records land in this database through the BUNDLED `pg`
 *    driver. `pg` loads `net` only when it connects (`pg/lib/stream.js`), so
 *    this, not a load check, is what proves the bundle's `createRequire`
 *    banner serves the driver's connect path.
 *
 * Throwaway container credentials only. The lease is a DATABASE ROW acquired
 * with live-shaped inputs (the WP-320 `fencing-race` precedent): no order, no
 * heartbeat and no venue call exists anywhere in this file.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabase, createFencingLeaseStore, createPostgresPool, type FencingGrant, type FencingLeaseStore } from "@polymarket-bot/storage-postgres";
import { createIsolatedDatabase, createMigratedContext, startPostgresContainer, type TestContext } from "@polymarket-bot/storage-postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFileAuditLog, createPostgresAuditMirror, EXIT_CODES, runOpsCli, type AuditRecord } from "../../../apps/ops-cli/src/emergency/index.js";
import { ACCOUNT, args, DESTRUCTIVE_REASON, harness, LIVE_FLAGS, NON_INTERACTIVE, OPERATOR, order, REPO_ROOT } from "../../../apps/ops-cli/src/emergency/harness.test-support.js";
import { AUDIT_LOG_ENV, DATABASE_URL_ENV, main } from "../../../apps/ops-cli/src/emergency/main.js";

let container: Awaited<ReturnType<typeof startPostgresContainer>>;
let context: TestContext;
let url: string;
let store: FencingLeaseStore;
let scratch: string;

beforeAll(async () => {
  container = await startPostgresContainer();
  const created = await createIsolatedDatabase(container.getConnectionUri(), "ops_cli");
  url = created.connectionString;
  context = await createMigratedContext(url);
  store = createFencingLeaseStore(context.db);
  scratch = await mkdtemp(path.join(tmpdir(), "ops-cli-integration-"));
});

afterAll(async () => {
  await context?.close();
  await container?.stop();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

/** The process's real clock: the composition's bounded waits (mirror settle, connection release) must really wait. */
const REAL_CLOCK = {
  nowMs: (): number => Math.floor(performance.timeOrigin + performance.now()),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

function processIo(argv: string[], env: Record<string, string | undefined>): Parameters<typeof main>[0] & { readonly lines: string[] } {
  const lines: string[] = [];
  return { argv, env, out: { line: (text: string) => void lines.push(text) }, prompt: NON_INTERACTIVE, clock: REAL_CLOCK, lines };
}

/** The common options, for an account of this test's own (each realm's lease is independent: no takeover wait). */
function stopArgs(account: string, ...extra: string[]): string[] {
  return ["stop-heartbeat", "--account", account, "--operator", OPERATOR, ...DESTRUCTIVE_REASON, ...extra];
}

async function acquireLease(accountRef: string, holderId: string): Promise<FencingGrant> {
  const outcome = await store.acquire({ accountRef, environment: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true, holderId, ttlMs: 60_000 });
  if (outcome.kind !== "ACQUIRED") throw new Error(`expected a grant, got ${outcome.kind}`);
  return outcome.grant;
}

async function auditRows(ids: readonly string[]): Promise<{ config_change_id: string; actor: string; actor_kind: string; change_kind: string; target_table: string; target_id: string | null; environment: string | null; reason: string }[]> {
  return context.db
    .selectFrom("ops.config_change_audit")
    .select(["config_change_id", "actor", "actor_kind", "change_kind", "target_table", "target_id", "environment", "reason"])
    .where("config_change_id", "in", [...ids])
    .orderBy("config_change_id")
    .execute();
}

async function localRecords(file: string): Promise<AuditRecord[]> {
  return (await readFile(file, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as AuditRecord);
}

describe("stop-heartbeat through the shipped composition, against WP-320's real lease store", () => {
  it("--dry-run reads the ACTIVE lease and revokes nothing", async () => {
    const grant = await acquireLease("acct-dry", "trader-dry-run");
    const audit = path.join(scratch, "dry.jsonl");
    const io = processIo(stopArgs("acct-dry", "--dry-run"), { ...LIVE_FLAGS, [AUDIT_LOG_ENV]: audit, [DATABASE_URL_ENV]: url });
    const outcome = await main(io);
    expect(outcome.exitName).toBe("DRY_RUN");
    expect(io.lines.join("\n")).toContain(`--confirm stop-heartbeat:acct-dry:${grant.fencingLeaseId}`);
    expect(await store.isValid({ fencingLeaseId: grant.fencingLeaseId, fencingToken: grant.fencingToken, holderId: "trader-dry-run" })).toBe(true);
  });

  it("the confirmed run revokes exactly that lease: REVOKED, reason recorded, the holder LOST; every record mirrored", async () => {
    const holder = "trader-host-a";
    const grant = await acquireLease("acct-stop", holder);
    const ref = { fencingLeaseId: grant.fencingLeaseId, fencingToken: grant.fencingToken, holderId: holder };
    const audit = path.join(scratch, "stop.jsonl");
    const io = processIo(stopArgs("acct-stop", "--confirm", `stop-heartbeat:acct-stop:${grant.fencingLeaseId}`), {
      ...LIVE_FLAGS,
      [AUDIT_LOG_ENV]: audit,
      [DATABASE_URL_ENV]: url,
    });
    const outcome = await main(io);
    expect(outcome.exitName).toBe("COMPLETED");

    const row = await context.db.selectFrom("ops.fencing_leases").select(["status", "revoked_reason"]).where("fencing_lease_id", "=", grant.fencingLeaseId).executeTakeFirstOrThrow();
    expect(row.status).toBe("REVOKED");
    expect(row.revoked_reason).toBe(`ops-cli stop-heartbeat by ${OPERATOR}: ${DESTRUCTIVE_REASON[1] ?? ""}`);
    expect(await store.isValid(ref)).toBe(false);
    expect(await store.renew(ref, 60_000)).toEqual({ kind: "LOST" });
    expect(await store.current("acct-stop", "LIVE_MICRO")).toBeNull();

    const records = await localRecords(audit);
    expect(records.map((record) => record.phase)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    const rows = await auditRows(records.map((record) => record.recordId));
    expect(rows.map((entry) => entry.change_kind)).toEqual(["OPS_CLI_STOP_HEARTBEAT_INVOKED", "OPS_CLI_STOP_HEARTBEAT_ACTING", "OPS_CLI_STOP_HEARTBEAT_OUTCOME"]);
    expect(rows.every((entry) => entry.actor === OPERATOR && entry.actor_kind === "HUMAN" && entry.target_table === "fencing_leases")).toBe(true);
    expect(rows.map((entry) => entry.environment)).toEqual([null, "LIVE_MICRO", "LIVE_MICRO"]);
    expect(rows[1]?.target_id).toBe(grant.fencingLeaseId);
    expect(io.lines.join("\n")).toContain("database copy (ops.config_change_audit): 3 landed, 0 failed, 0 still pending");
    // The connection string is never printed.
    expect(io.lines.join("\n")).not.toContain(url);
  });

  it("no ACTIVE lease: NOTHING_TO_DO", async () => {
    const io = processIo(stopArgs("acct-none", "--confirm", "x"), { ...LIVE_FLAGS, [AUDIT_LOG_ENV]: path.join(scratch, "none.jsonl"), [DATABASE_URL_ENV]: url });
    expect((await main(io)).exitName).toBe("NOTHING_TO_DO");
  });
});

describe("the audit mirror", () => {
  it("a PAPER refusal is mirrored to ops.config_change_audit with the gate's reasons, and claims no environment", async () => {
    const audit = path.join(scratch, "paper.jsonl");
    const io = processIo(args("account-snapshot"), { [AUDIT_LOG_ENV]: audit, [DATABASE_URL_ENV]: url });
    const outcome = await main(io);
    expect(outcome.exitName).toBe("RUN_MODE_REFUSED");
    const records = await localRecords(audit);
    const rows = await auditRows(records.map((record) => record.recordId));
    expect(rows.map((entry) => entry.change_kind)).toEqual(["OPS_CLI_ACCOUNT_SNAPSHOT_INVOKED", "OPS_CLI_ACCOUNT_SNAPSHOT_OUTCOME"]);
    expect(rows.every((entry) => entry.environment === null && entry.target_id === ACCOUNT && entry.reason.startsWith("ops-cli read-only command"))).toBe(true);
  });
});

describe("acceptance 1, with a database that is really unreachable", () => {
  it("cancel-all completes from venue truth and the emergency credential alone; the real mirror's failures change nothing", async () => {
    // A local port nothing listens on: every connection is refused at once (no tripwire, a real socket).
    const unreachable = createDatabase(createPostgresPool({ connectionString: "postgresql://ops:throwaway@127.0.0.1:1/none", connectionTimeoutMs: 2_000, maxConnections: 1 }));
    const h = harness({ mirror: createPostgresAuditMirror(unreachable) });
    h.venue.add(order("o-1"), order("o-2"));
    const file = path.join(scratch, "independent.jsonl");
    try {
      const outcome = await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`, "--audit-log", file), { openAuditLog: (target) => createFileAuditLog(target) }));
      expect(outcome.exitName).toBe("COMPLETED");
      expect(h.venue.open()).toEqual([]);
      expect(h.touched).toEqual(["configuration", "credentials", "venues"]);
      expect((await localRecords(file)).map((record) => record.phase)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
      expect(h.text()).toMatch(/database copy \(ops\.config_change_audit\): 0 landed/u);
    } finally {
      await Promise.race([unreachable.destroy().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  });
});

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a child process asynchronously (CI-1: never a synchronous child in a vitest worker), killed past 60 s. */
function runChild(command: string, argv: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => void stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => void stderr.push(chunk));
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} did not finish within 60 s`));
    }, 60_000);
    child.on("error", (cause) => {
      clearTimeout(deadline);
      reject(cause);
    });
    child.on("close", (status) => {
      clearTimeout(deadline);
      resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

describe("the SHIPPED bundle against the real database (WP-330 r0; ADR-018 §4)", () => {
  it("built by the app's own build script and run as a child in PAPER: refused by the gate, and both records land in ops.config_change_audit through the BUNDLED pg driver", async () => {
    const appDirectory = path.join(REPO_ROOT, "apps", "ops-cli");
    const manifest = JSON.parse(await readFile(path.join(appDirectory, "package.json"), "utf8")) as { readonly scripts?: Readonly<Record<string, string>> };
    const build = manifest.scripts?.["build"] ?? "";
    expect(build.startsWith("esbuild src/main.ts ")).toBe(true);
    expect(build.split("--outfile=dist/")).toHaveLength(2);
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ops-cli-bundle-")));
    // Substituted into a `sh -c` script unquoted, so it must be shell-safe.
    expect(directory).toMatch(/^[A-Za-z0-9_./-]+$/u);
    try {
      const built = await runChild("sh", ["-c", build.replace("--outfile=dist/", `--outfile=${directory}/`)], {
        cwd: appDirectory,
        env: {
          ...process.env,
          PATH: [path.join(appDirectory, "node_modules", ".bin"), path.join(REPO_ROOT, "node_modules", ".bin"), path.dirname(process.execPath), process.env["PATH"] ?? ""].join(path.delimiter),
        },
      });
      expect(built.status, built.stderr).toBe(0);

      const audit = path.join(directory, "audit.jsonl");
      // An explicit environment: nothing is inherited. PAPER, no credential; only the audit log and this test's database.
      const ran = await runChild(process.execPath, [path.join(directory, "main.mjs"), ...args("account-snapshot")], {
        cwd: directory,
        env: {
          MAX_RUN_MODE: "PAPER",
          RUN_MODE: "PAPER",
          ALLOW_REAL_ORDERS: "false",
          LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
          LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
          [AUDIT_LOG_ENV]: audit,
          [DATABASE_URL_ENV]: url,
        },
      });
      const report = `status ${String(ran.status)}\n--- stdout ---\n${ran.stdout}\n--- stderr ---\n${ran.stderr}`;
      expect(ran.status, report).toBe(EXIT_CODES.RUN_MODE_REFUSED);
      expect(ran.stderr, report).toBe("");
      expect(ran.stdout, report).toContain("REFUSED by WP-260's signer gate (RUN_MODE_REQUIRES_NO_SIGNER, REAL_ORDERS_NOT_ALLOWED)");
      expect(ran.stdout, report).toContain("database copy (ops.config_change_audit): 2 landed, 0 failed, 0 still pending");
      // The connection string, and its password, are never printed.
      expect(ran.stdout, report).not.toContain(url);
      const password = new URL(url).password;
      expect(password.length).toBeGreaterThan(0);
      expect(ran.stdout, report).not.toContain(password);

      const records = await localRecords(audit);
      expect(records.map((record) => record.phase)).toEqual(["INVOKED", "OUTCOME"]);
      const rows = await auditRows(records.map((record) => record.recordId));
      expect(rows.map((entry) => entry.change_kind)).toEqual(["OPS_CLI_ACCOUNT_SNAPSHOT_INVOKED", "OPS_CLI_ACCOUNT_SNAPSHOT_OUTCOME"]);
      expect(rows.every((entry) => entry.environment === null && entry.target_id === ACCOUNT)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
