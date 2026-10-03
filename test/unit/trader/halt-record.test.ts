/**
 * `PROVENANCE-1` (`OUT1-R1-HALT-NOT-DURABLE`) — the durable halt record, as
 * rows and as a bounded write.
 *
 * 1. `haltIncidentRows`: every halt scope maps to `ops.incidents` rows the
 *    research worker's reader matches (`market_id` = the window's market, or
 *    `market_id` NULL with an `instance_id` of the window's), with the halt's
 *    own code, §9.9 action, instant and (bounded) detail. Every
 *    `HaltReasonCode` maps.
 * 2. `PostgresTraderStore.recordHalts`: one transaction that first bounds its
 *    own `statement_timeout`, then inserts; and it ANSWERS WITHIN THE BOUND
 *    whatever the database does — a database that never answers is
 *    `unconfirmed` at the bound, one that refuses is `failed` at once.
 * 3. `recordHaltsBeforeExit`: writes nothing when nothing is latched, logs each
 *    outcome, and never throws.
 *
 * No PostgreSQL: the statements are captured through the REAL
 * `createDatabase` over a pool stand-in (`TRDR-2`'s precedent). The round trip
 * against a real database is the integration suite's.
 */

import { describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import {
  HALT_INCIDENT_KEYS,
  HALT_RECORD_DEADLINE_MS,
  haltIncidentRows,
  recordHaltsBeforeExit,
  type HaltIncidentRow,
} from "../../../apps/trader/src/halt-record.js";
import { createDatabase } from "../../../packages/storage-postgres/src/database.js";
import type { PostgresPool } from "../../../packages/storage-postgres/src/pool.js";
import { HaltController, type HaltReasonCode, type HaltRecord } from "../../../packages/trading-core/src/index.js";

const MARKET = "018f3a5c-0000-7000-8000-0000000000b1";
const INSTANCE_A = "018f3a5c-0000-7000-8000-0000000000b2";
const INSTANCE_B = "018f3a5c-0000-7000-8000-0000000000b3";
const AT = "2026-03-04T12:07:30.250Z";

function latched(...entries: readonly [HaltRecord["scope"], HaltReasonCode, string][]): readonly HaltRecord[] {
  const controller = new HaltController();
  for (const [scope, code, detail] of entries) controller.halt(scope, code, detail, AT);
  return controller.records();
}

const CONTEXT = { accountRef: "paper-account", instanceIds: [INSTANCE_A, INSTANCE_B] } as const;

describe("haltIncidentRows: every halt becomes ops.incidents rows the window classifier reads (PROVENANCE-1)", () => {
  it("a GLOBAL halt: one market-less row per configured instance, each naming the halt's code, action, instant and detail", () => {
    const rows = haltIncidentRows(latched([{ kind: "GLOBAL" }, "TRANSPORT_UNAVAILABLE", "the event transport is unavailable"]), CONTEXT);
    expect(rows).toEqual([
      {
        incident_key: "TRADER_HALT:GLOBAL",
        environment: "PAPER",
        account_ref: "paper-account",
        severity: "PAGE",
        status: "OPEN",
        failure_class: "TRANSPORT_UNAVAILABLE",
        action: "FULL_HALT",
        market_id: null,
        instance_id: INSTANCE_A,
        detail: "the event transport is unavailable",
        opened_at: AT,
      },
      {
        incident_key: "TRADER_HALT:GLOBAL",
        environment: "PAPER",
        account_ref: "paper-account",
        severity: "PAGE",
        status: "OPEN",
        failure_class: "TRANSPORT_UNAVAILABLE",
        action: "FULL_HALT",
        market_id: null,
        instance_id: INSTANCE_B,
        detail: "the event transport is unavailable",
        opened_at: AT,
      },
    ]);
  });

  it("a MARKET halt: one row with the market and no instance; a STRATEGY_INSTANCE halt: one row with the instance and no market", () => {
    const rows = haltIncidentRows(
      latched(
        [{ kind: "MARKET", marketId: MARKET }, "BOOK_DESYNCHRONIZED", "a book refused an update"],
        [{ kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_B }, "RUNTIME_PERSISTENCE_FAILED", "the runtime halted"],
      ),
      CONTEXT,
    );
    expect(rows.map((row) => [row.incident_key, row.failure_class, row.action, row.market_id, row.instance_id])).toEqual([
      [HALT_INCIDENT_KEYS.MARKET, "BOOK_DESYNCHRONIZED", "CANCEL_RESTING_ORDERS", MARKET, null],
      [HALT_INCIDENT_KEYS.STRATEGY_INSTANCE, "RUNTIME_PERSISTENCE_FAILED", "FULL_HALT", null, INSTANCE_B],
    ]);
  });

  it("EVERY halt code maps, with the controller's own §9.9 action — TRANSPORT_RESYNC_REQUIRED and STORE_UNAVAILABLE among them", () => {
    const codes: readonly HaltReasonCode[] = [
      "TRANSPORT_UNAVAILABLE",
      "TRANSPORT_RESYNC_REQUIRED",
      "STORE_UNAVAILABLE",
      "QUEUE_BACKPRESSURE",
      "UNATTRIBUTED_ACTIVITY",
      "UNEXPLAINED_ACTUAL_MOVEMENT",
      "LEDGER_POSTING_REFUSED",
      "ACCOUNTING_REBUILD_MISMATCH",
      "CANCEL_UNRESOLVED",
      "BASKET_PARTIALLY_EXECUTED",
      "VENUE_OBSERVATION_FAILED",
      "RUNTIME_PERSISTENCE_FAILED",
      "EVENT_UNREADABLE",
      "BOOK_DESYNCHRONIZED",
      "OPERATOR_HALT",
    ];
    for (const code of codes) {
      const halts = latched([{ kind: "MARKET", marketId: MARKET }, code, `detail of ${code}`]);
      const [row] = haltIncidentRows(halts, CONTEXT);
      expect(row?.failure_class).toBe(code);
      expect(row?.action).toBe(halts[0]?.action);
      expect(row?.opened_at).toBe(AT);
    }
  });

  it("bounds a long detail (a cause chain) to internal.detail's 2000 characters", () => {
    const [row] = haltIncidentRows(latched([{ kind: "GLOBAL" }, "STORE_UNAVAILABLE", "y".repeat(4000)]), CONTEXT);
    expect(Array.from(row?.detail ?? "")).toHaveLength(2000);
    expect(row?.detail).toMatch(/truncated to fit internal\.detail\]$/u);
  });

  it("no halt: no row", () => {
    expect(haltIncidentRows([], CONTEXT)).toEqual([]);
  });
});

interface Recorded {
  readonly statements: string[];
  readonly parameters: unknown[][];
}

function pool(behaviour: "answer" | "refuse" | "silent", recorded: Recorded): PostgresPool {
  const client = {
    query: (sql: string, parameters: readonly unknown[] = []) => {
      recorded.statements.push(sql);
      recorded.parameters.push([...parameters]);
      if (behaviour === "refuse") return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
      if (behaviour === "silent") return new Promise(() => undefined);
      return Promise.resolve({ command: "INSERT", rowCount: 1, rows: [] });
    },
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client), end: () => Promise.resolve(undefined) } as unknown as PostgresPool;
}

const ROWS: readonly HaltIncidentRow[] = haltIncidentRows(
  latched([{ kind: "GLOBAL" }, "TRANSPORT_RESYNC_REQUIRED", "retention removed 130 event(s)"]),
  { accountRef: "paper-account", instanceIds: [INSTANCE_A] },
);

describe("PostgresTraderStore.recordHalts: one bounded transaction (PROVENANCE-1)", () => {
  it("sets its own statement_timeout to the bound, then inserts the rows, in ONE transaction", async () => {
    const recorded: Recorded = { statements: [], parameters: [] };
    const store = new PostgresTraderStore({ db: createDatabase(pool("answer", recorded)), decisionContractVersion: 1 });
    expect(await store.recordHalts(ROWS, 1234)).toEqual({ status: "written", rows: 1 });
    expect(recorded.statements[0]).toBe("begin");
    expect(recorded.statements[1]).toBe('select set_config($1, $2, $3) as "bound"');
    expect(recorded.parameters[1]).toEqual(["statement_timeout", "1234", true]);
    const insert = recorded.statements[2] ?? "";
    expect(insert).toMatch(/^insert into "ops"\."incidents" \(.*\) values \(\$1, /u);
    const columns = /\(([^)]*)\) values/u.exec(insert)?.[1]?.split(", ").map((quoted) => quoted.replaceAll('"', "")) ?? [];
    expect([...columns].sort()).toEqual(
      ["account_ref", "action", "detail", "environment", "failure_class", "incident_key", "instance_id", "market_id", "opened_at", "severity", "status"],
    );
    expect(recorded.parameters[2]).toEqual(expect.arrayContaining(["TRADER_HALT:GLOBAL", "TRANSPORT_RESYNC_REQUIRED", "FULL_HALT", INSTANCE_A]));
    expect(recorded.statements[3]).toBe("commit");
  });

  it("a database that REFUSES: `failed` at once, never a throw", async () => {
    const recorded: Recorded = { statements: [], parameters: [] };
    const store = new PostgresTraderStore({ db: createDatabase(pool("refuse", recorded)), decisionContractVersion: 1 });
    const started = Date.now();
    const outcome = await store.recordHalts(ROWS, 60_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" ? outcome.detail : "").toContain("ECONNREFUSED");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a database that NEVER ANSWERS: `unconfirmed` at the bound — the caller is never held past it", async () => {
    const recorded: Recorded = { statements: [], parameters: [] };
    const store = new PostgresTraderStore({ db: createDatabase(pool("silent", recorded)), decisionContractVersion: 1 });
    const started = Date.now();
    const outcome = await store.recordHalts(ROWS, 300);
    const took = Date.now() - started;
    expect(outcome).toEqual({
      status: "unconfirmed",
      detail: "the database did not answer within 300 ms; the halt's rows may or may not have been written",
    });
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(3_000);
  });

  it("no row: nothing is sent", async () => {
    const recorded: Recorded = { statements: [], parameters: [] };
    const store = new PostgresTraderStore({ db: createDatabase(pool("answer", recorded)), decisionContractVersion: 1 });
    expect(await store.recordHalts([], 300)).toEqual({ status: "written", rows: 0 });
    expect(recorded.statements).toEqual([]);
  });
});

describe("recordHaltsBeforeExit: logs the outcome, never throws, writes nothing without a halt (PROVENANCE-1)", () => {
  const config = {
    accounting: { accountRef: "paper-account" },
    instances: [{ instanceId: INSTANCE_A }],
  } as unknown as Parameters<typeof recordHaltsBeforeExit>[0]["config"];
  const halts = latched([{ kind: "GLOBAL" }, "TRANSPORT_UNAVAILABLE", "the event transport is unavailable"]);

  it("no latched halt: the write is never called", async () => {
    const lines: string[] = [];
    let called = false;
    const outcome = await recordHaltsBeforeExit({
      halts: [],
      config,
      write: async () => {
        called = true;
        return await Promise.resolve({ status: "written" as const, rows: 0 });
      },
      log: (line) => lines.push(line),
    });
    expect(outcome).toBeUndefined();
    expect(called).toBe(false);
    expect(lines).toEqual([]);
  });

  it("written: the rows go to the write with the default bound, and the line says so", async () => {
    const lines: string[] = [];
    const seen: { rows: readonly HaltIncidentRow[]; deadlineMs: number }[] = [];
    await recordHaltsBeforeExit({
      halts,
      config,
      write: async (rows, deadlineMs) => {
        seen.push({ rows, deadlineMs });
        return await Promise.resolve({ status: "written" as const, rows: rows.length });
      },
      log: (line) => lines.push(line),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.deadlineMs).toBe(HALT_RECORD_DEADLINE_MS);
    expect(seen[0]?.rows.map((row) => [row.failure_class, row.instance_id])).toEqual([["TRANSPORT_UNAVAILABLE", INSTANCE_A]]);
    expect(lines).toEqual(["halt record: 1 row(s) written to ops.incidents for 1 halt(s) (GLOBAL TRANSPORT_UNAVAILABLE)"]);
  });

  it("failed, unconfirmed, or a write that THROWS: logged, answered, never thrown", async () => {
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };
    expect(
      await recordHaltsBeforeExit({ halts, config, log, write: async () => await Promise.resolve({ status: "failed" as const, detail: "ECONNREFUSED" }) }),
    ).toEqual({ status: "failed", detail: "ECONNREFUSED" });
    expect(
      await recordHaltsBeforeExit({ halts, config, log, write: async () => await Promise.resolve({ status: "unconfirmed" as const, detail: "no answer" }) }),
    ).toEqual({ status: "unconfirmed", detail: "no answer" });
    expect(
      await recordHaltsBeforeExit({
        halts,
        config,
        log,
        write: () => Promise.reject(new TypeError("boom")),
      }),
    ).toEqual({ status: "failed", detail: "TypeError: boom" });
    expect(lines[0]).toMatch(/^HALT RECORD NOT DURABLE: the halt could not be written to ops\.incidents \(ECONNREFUSED\); .*exits halted regardless \(fail closed\)$/u);
    expect(lines[1]).toMatch(/^HALT RECORD UNCONFIRMED: no answer; .*exits halted regardless \(fail closed\)$/u);
    expect(lines[2]).toMatch(/^HALT RECORD NOT DURABLE: .*TypeError: boom/u);
  });
});
