/**
 * `PROVENANCE-1` (`OUT1-R1-HALT-NOT-DURABLE`) — the durable halt record, as
 * rows and as a bounded write.
 *
 * 1. `haltIncidentRows`: every halt scope maps to `ops.incidents` rows the
 *    research worker's reader matches (`market_id` = the window's market, or
 *    `market_id` NULL with an `instance_id` of the window's), with the halt's
 *    own code, instant and (bounded) detail, and `action` NULL (`C1-HALTS`:
 *    every halt ends the run, so no §9.9 rung is selected). Every
 *    `HaltReasonCode` maps.
 * 2. `PostgresTraderStore.recordHalts`: one transaction, on ONE connection it
 *    checks out of the pool itself, that first bounds its own
 *    `statement_timeout`, then inserts; and it ANSWERS WITHIN THE BOUND
 *    whatever the database does — a database that never answers is
 *    `unconfirmed` at the bound, one that refuses is `failed` at once. Round
 *    1 (`PROV1-R1-02`): the connection is DESTROYED at the bound, so the
 *    store's close does not wait on it — pinned against a stand-in that keeps
 *    `pg-pool`'s checkout behaviour, and against the REAL `pg` pool talking
 *    to a PostgreSQL that completes its handshake and then never answers.
 * 3. `recordHaltsBeforeExit`: writes nothing when nothing is latched, logs each
 *    outcome, and never throws.
 *
 * No PostgreSQL server: the statements are captured through the REAL
 * `createDatabase` over a pool stand-in (`TRDR-2`'s precedent), and the
 * frozen-server case runs the real `pg` client against an in-process socket
 * that speaks only the handshake. The round trip against a real database is
 * the integration suite's.
 */

import { createServer, type AddressInfo, type Socket } from "node:net";

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
import { createPostgresPool, type PostgresPool } from "../../../packages/storage-postgres/src/pool.js";
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
  it("a GLOBAL halt: one market-less row per configured instance, each naming the halt's code, instant and detail, action NULL", () => {
    const rows = haltIncidentRows(latched([{ kind: "GLOBAL" }, "TRANSPORT_UNAVAILABLE", "the event transport is unavailable"]), CONTEXT);
    expect(rows).toEqual([
      {
        incident_key: "TRADER_HALT:GLOBAL",
        environment: "PAPER",
        account_ref: "paper-account",
        severity: "PAGE",
        status: "OPEN",
        failure_class: "TRANSPORT_UNAVAILABLE",
        action: null,
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
        action: null,
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
      [HALT_INCIDENT_KEYS.MARKET, "BOOK_DESYNCHRONIZED", null, MARKET, null],
      [HALT_INCIDENT_KEYS.STRATEGY_INSTANCE, "RUNTIME_PERSISTENCE_FAILED", null, null, INSTANCE_B],
    ]);
  });

  it("EVERY halt code maps, action NULL — TRANSPORT_RESYNC_REQUIRED and STORE_UNAVAILABLE among them", () => {
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
    ];
    for (const code of codes) {
      const halts = latched([{ kind: "MARKET", marketId: MARKET }, code, `detail of ${code}`]);
      const [row] = haltIncidentRows(halts, CONTEXT);
      expect(row?.failure_class).toBe(code);
      expect(row?.action).toBeNull();
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
  /** Every release of a checked-out connection: `null` given back plainly, else the error it was DESTROYED with. */
  readonly releases: (string | null)[];
  /** Per connection handed out, the `error` listeners attached to it now. */
  readonly errorListeners: Set<(error: Error) => void>[];
  /** Per connection handed out, how many `error` listeners it had while its queries ran. */
  readonly listenersWhileQuerying: number[];
}

function recorded(): Recorded {
  return { statements: [], parameters: [], releases: [], errorListeners: [], listenersWhileQuerying: [] };
}

/**
 * A pool stand-in that keeps `pg-pool`'s CHECKOUT behaviour (review r1,
 * `PROV1-R1-02`: the first stand-in's `end()` resolved at once and its
 * `release()` did nothing, which removed exactly the behaviour that hung the
 * process): `end()` resolves only once every checked-out connection has been
 * released, and a connection released WITH AN ERROR is dropped (destroyed).
 * `connectAfterMs` delays the hand-over.
 */
function pool(
  behaviour: "answer" | "refuse" | "silent" | "fail-insert",
  seen: Recorded,
  options: { readonly connectAfterMs?: number } = {},
): PostgresPool {
  let checkedOut = 0;
  const waiters: (() => void)[] = [];
  const settleWaiters = (): void => {
    if (checkedOut === 0) for (const wake of waiters.splice(0)) wake();
  };
  const connection = () => {
    let released = false;
    const listeners = new Set<(error: Error) => void>();
    seen.errorListeners.push(listeners);
    return {
      on: (event: string, listener: (error: Error) => void) => {
        if (event === "error") listeners.add(listener);
      },
      removeListener: (event: string, listener: (error: Error) => void) => {
        if (event === "error") listeners.delete(listener);
      },
      query: (sql: string, parameters: readonly unknown[] = []) => {
        seen.statements.push(sql);
        seen.parameters.push([...parameters]);
        seen.listenersWhileQuerying.push(listeners.size);
        if (behaviour === "refuse") return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
        if (behaviour === "silent") return new Promise(() => undefined);
        if (behaviour === "fail-insert" && sql.startsWith("insert")) {
          return Promise.reject(new Error('duplicate key value violates unique constraint "incidents_pkey"'));
        }
        return Promise.resolve({ command: "INSERT", rowCount: 1, rows: [] });
      },
      release: (destroy?: Error) => {
        if (released) throw new Error("Release called on client which has already been released to the pool.");
        released = true;
        seen.releases.push(destroy === undefined ? null : destroy.message);
        checkedOut -= 1;
        settleWaiters();
      },
    };
  };
  return {
    connect: async () => {
      if (options.connectAfterMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.connectAfterMs));
      checkedOut += 1;
      return connection();
    },
    end: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
        settleWaiters();
      }),
  } as unknown as PostgresPool;
}

/** A store over `pool`, built as `assembleDurableTrader` builds it: the same pool for `db` and for the halt record. */
function storeOver(over: PostgresPool): PostgresTraderStore {
  return new PostgresTraderStore({ db: createDatabase(over), pool: over, decisionContractVersion: 1 });
}

/** Answers `promise`'s value, or `"pending"` if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => {
          resolve("pending");
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A PostgreSQL that completes the startup handshake (AuthenticationOk,
 * ReadyForQuery) and then NEVER ANSWERS — the frozen server both reviewers
 * reproduced the hang with — so the REAL `pg` client and `pg-pool` run
 * against it: a connection the record checks out has a query in flight when
 * the bound passes. It records when each client socket closes. `drops`: it
 * closes the socket on the first query instead. `mute`: it never answers the
 * handshake either, so the pool is still OPENING the connection at the bound.
 */
async function frozenPostgres(behaviour: "frozen" | "drops" | "mute" = "frozen"): Promise<{
  readonly url: string;
  readonly closedAt: (number | undefined)[];
  close(): Promise<void>;
}> {
  const sockets: Socket[] = [];
  const closedAt: (number | undefined)[] = [];
  const server = createServer((socket) => {
    const index = sockets.push(socket) - 1;
    closedAt[index] = undefined;
    // The CLIENT ended or destroyed its socket (a FIN or a reset reached us).
    const closed = (): void => {
      closedAt[index] ??= Date.now();
    };
    socket.once("end", closed);
    socket.once("close", closed);
    socket.on("error", () => undefined);
    let handshaken = false;
    socket.on("data", () => {
      if (behaviour === "mute") return; // not even the handshake is answered
      if (handshaken) {
        // "frozen": no query is ever answered. "drops": the server goes away
        // mid-query (killed, the link reset), closing the socket.
        if (behaviour === "drops") socket.destroy();
        return;
      }
      handshaken = true;
      // AuthenticationOk ('R', length 8, code 0), then ReadyForQuery ('Z', length 5, idle).
      socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgres://halt:halt@127.0.0.1:${String(port)}/halt`,
    closedAt,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

const ROWS: readonly HaltIncidentRow[] = haltIncidentRows(
  latched([{ kind: "GLOBAL" }, "TRANSPORT_RESYNC_REQUIRED", "retention removed 130 event(s)"]),
  { accountRef: "paper-account", instanceIds: [INSTANCE_A] },
);

describe("PostgresTraderStore.recordHalts: one bounded transaction on ONE connection it owns (PROVENANCE-1)", () => {
  it("sets its own statement_timeout to the bound, then inserts the rows, in ONE transaction, and gives the connection back", async () => {
    const seen = recorded();
    const standIn = pool("answer", seen);
    const store = storeOver(standIn);
    expect(await store.recordHalts(ROWS, 1234)).toEqual({ status: "written", rows: 1 });
    expect(seen.statements[0]).toBe("begin");
    expect(seen.statements[1]).toBe('select set_config($1, $2, $3) as "bound"');
    expect(seen.parameters[1]).toEqual(["statement_timeout", "1234", true]);
    const insert = seen.statements[2] ?? "";
    expect(insert).toMatch(/^insert into "ops"\."incidents" \(.*\) values \(\$1, /u);
    const columns = /\(([^)]*)\) values/u.exec(insert)?.[1]?.split(", ").map((quoted) => quoted.replaceAll('"', "")) ?? [];
    expect([...columns].sort()).toEqual(
      ["account_ref", "action", "detail", "environment", "failure_class", "incident_key", "instance_id", "market_id", "opened_at", "severity", "status"],
    );
    expect(seen.parameters[2]).toEqual(expect.arrayContaining(["TRADER_HALT:GLOBAL", "TRANSPORT_RESYNC_REQUIRED", null, INSTANCE_A]));
    expect(seen.statements[3]).toBe("commit");
    expect(seen.statements).toHaveLength(4);
    // Given back plainly (to be reused), once; its `error` events were the
    // record's while it held it, and are not after.
    expect(seen.releases).toEqual([null]);
    expect(seen.listenersWhileQuerying).toEqual([1, 1, 1, 1]);
    expect(seen.errorListeners.map((listeners) => listeners.size)).toEqual([0]);
    expect(await within(standIn.end(), 1_000)).toBeUndefined();
  });

  it("a database that REFUSES: `failed` at once, never a throw; the connection is destroyed", async () => {
    const seen = recorded();
    const store = storeOver(pool("refuse", seen));
    const started = Date.now();
    const outcome = await store.recordHalts(ROWS, 60_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" ? outcome.detail : "").toContain("ECONNREFUSED");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.releases).toEqual(["connect ECONNREFUSED 127.0.0.1:5432"]);
  });

  it("a statement that FAILS inside the transaction: `failed`, and the connection is DESTROYED, never handed back inside an aborted transaction", async () => {
    const seen = recorded();
    const store = storeOver(pool("fail-insert", seen));
    const outcome = await store.recordHalts(ROWS, 60_000);
    expect(outcome.status).toBe("failed");
    expect(seen.statements.map((sql) => sql.split(" ")[0])).toEqual(["begin", "select", "insert"]);
    expect(seen.releases).toEqual(['duplicate key value violates unique constraint "incidents_pkey"']);
  });

  it("a database that NEVER ANSWERS: `unconfirmed` at the bound, and the connection is DESTROYED, so the store's close does not wait on it (PROV1-R1-02)", async () => {
    const seen = recorded();
    const standIn = pool("silent", seen);
    const store = storeOver(standIn);
    const started = Date.now();
    const outcome = await store.recordHalts(ROWS, 300);
    const took = Date.now() - started;
    expect(outcome).toEqual({
      status: "unconfirmed",
      detail: "the database did not answer within 300 ms; the halt's rows may or may not have been written",
    });
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(3_000);
    expect(seen.releases).toEqual(["the halt record did not answer within 300 ms"]);
    // `pool.end()` — what the store's close awaits — waits for every
    // checked-out connection; the record's is not one any more.
    expect(await within(standIn.end(), 1_000)).toBeUndefined();
  });

  it("a connection the pool hands over only AFTER the bound is destroyed the moment it arrives, and nothing is sent on it", async () => {
    const seen = recorded();
    const standIn = pool("answer", seen, { connectAfterMs: 400 });
    const store = storeOver(standIn);
    expect(await store.recordHalts(ROWS, 100)).toMatchObject({ status: "unconfirmed" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen.statements).toEqual([]);
    expect(seen.releases).toEqual(["the halt record's connection arrived after its 100 ms bound"]);
    expect(await within(standIn.end(), 1_000)).toBeUndefined();
  });

  it("the REAL pg pool, against a PostgreSQL that never answers: `unconfirmed` at the bound, the record's socket is closed, and the pool ends at once (PROV1-R1-02)", async () => {
    const server = await frozenPostgres();
    const realPool = createPostgresPool({ connectionString: server.url });
    realPool.on("error", () => undefined);
    const store = storeOver(realPool);
    try {
      const started = Date.now();
      const outcome = await store.recordHalts(ROWS, 300);
      const answeredAt = Date.now();
      expect(outcome).toMatchObject({ status: "unconfirmed" });
      expect(answeredAt - started).toBeGreaterThanOrEqual(290);
      expect(answeredAt - started).toBeLessThan(3_000);
      // The first round left this connection checked out: `pool.end()` — what
      // the store's close awaits once its driver has run a query, as the
      // trader's has by any halt — never resolved while the server stayed
      // frozen. (Called directly: this store's query builder never ran a
      // query, and Kysely creates its driver, and so ends the pool, only then.)
      expect(await within(realPool.end(), 2_000)).toBeUndefined();
      // The record's socket was closed by the client, at the bound — the
      // server never closes one.
      for (let waited = 0; server.closedAt[0] === undefined && waited < 1_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(server.closedAt).toHaveLength(1);
      const closed = server.closedAt[0];
      expect(closed).toBeDefined();
      expect((closed ?? Infinity) - answeredAt).toBeLessThan(1_000);
    } finally {
      await server.close();
    }
  });

  it("the REAL pg pool, against a PostgreSQL that goes away MID-QUERY: `failed` at once — the client's `error` event is the record's, never an uncaught exception (exit 1)", async () => {
    // `pg-pool` removes its own `error` listener from a connection it hands
    // out, and `pg` emits `error` on a client whose socket closes under a
    // query: unheard, that is an uncaught exception and the process dies.
    const server = await frozenPostgres("drops");
    const realPool = createPostgresPool({ connectionString: server.url });
    realPool.on("error", () => undefined);
    const store = storeOver(realPool);
    try {
      const started = Date.now();
      const outcome = await store.recordHalts(ROWS, 60_000);
      expect(outcome.status).toBe("failed");
      expect(outcome.status === "failed" ? outcome.detail : "").toMatch(/Connection terminated unexpectedly/u);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await within(realPool.end(), 2_000)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("the REAL pg pool, still OPENING the record's connection at the bound: `unconfirmed` at the bound, and the pool ends within its own connection timeout", async () => {
    const server = await frozenPostgres("mute");
    const realPool = createPostgresPool({ connectionString: server.url, connectionTimeoutMs: 600 });
    realPool.on("error", () => undefined);
    const store = storeOver(realPool);
    try {
      const started = Date.now();
      expect(await store.recordHalts(ROWS, 200)).toMatchObject({ status: "unconfirmed" });
      expect(Date.now() - started).toBeLessThan(1_000);
      // The pool's connection timeout (600 ms here; 10 s by default) ends the opening connection.
      expect(await within(realPool.end(), 2_000)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      await server.close();
    }
  });

  it("a store built WITHOUT its pool writes nothing and says why: no connection it could bound", async () => {
    const seen = recorded();
    const store = new PostgresTraderStore({ db: createDatabase(pool("answer", seen)), decisionContractVersion: 1 });
    expect(await store.recordHalts(ROWS, 300)).toEqual({
      status: "failed",
      detail:
        "this store was built without its connection pool, so the halt record has no connection it can bound " +
        "and destroy; nothing was written",
    });
    expect(seen.statements).toEqual([]);
  });

  it("no row: nothing is sent", async () => {
    const seen = recorded();
    const store = storeOver(pool("answer", seen));
    expect(await store.recordHalts([], 300)).toEqual({ status: "written", rows: 0 });
    expect(seen.statements).toEqual([]);
    expect(seen.releases).toEqual([]);
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
