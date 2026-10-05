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
 *
 * Throwaway container credentials only. The lease is a DATABASE ROW acquired
 * with live-shaped inputs (the WP-320 `fencing-race` precedent): no order, no
 * heartbeat and no venue call exists anywhere in this file.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabase, createFencingLeaseStore, createPostgresPool, type FencingGrant, type FencingLeaseStore } from "@polymarket-bot/storage-postgres";
import { createIsolatedDatabase, createMigratedContext, startPostgresContainer, type TestContext } from "@polymarket-bot/storage-postgres/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFileAuditLog, createPostgresAuditMirror, runOpsCli, type AuditRecord } from "../../../apps/ops-cli/src/emergency/index.js";
import { ACCOUNT, args, DESTRUCTIVE_REASON, harness, LIVE_FLAGS, NON_INTERACTIVE, OPERATOR, order } from "../../../apps/ops-cli/src/emergency/harness.test-support.js";
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
