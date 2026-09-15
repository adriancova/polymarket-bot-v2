/**
 * THE AUDIT RECORD'S CONTAINERS ARE THIS PROCESS'S OWN, WHATEVER SPECIES THE
 * CALLER PASSED (`SER-3` review round 2, finding N1).
 *
 * The round-1 sweep established that every OUTBOUND container is built here
 * rather than taken from a caller — and missed one site, which round 2 closes:
 *
 * ```ts
 * // apps/control-api/src/control-plane.ts, refuseModeRaise (before)
 * { attemptedKeys: keys.map((key) => key) }
 * ```
 *
 * `Array.prototype.map` PRESERVES THE SPECIES of the array it is called on
 * (ECMA-262 `ArraySpeciesCreate`), and `refuseModeRaise(keys: readonly
 * string[], …)` is satisfied by an `Array` SUBCLASS with no cast. So a caller's
 * subclass landed INSIDE the §14.1 audit record's `resultingState`, `#append`
 * merged it in, and `postgres-audit-sink.ts`'s `asJsonInput` handed it to the
 * own-data encoder, which refuses a container whose prototype is neither
 * `Array.prototype` nor `null`. The reviewer measured it on the REAL control
 * plane with a capturing sink:
 *
 * ```text
 * N1 attemptedKeys is Array: true | prototype is Array.prototype: false | ctor: Keys
 * N1 sink encoder: NON_PLAIN at value.attemptedKeys | base pg/JSON.stringify: {"runMode":"PAPER",…
 * ```
 *
 * The append would therefore fail with `AUDIT_SINK_UNAVAILABLE` — and this
 * control plane AUDITS BEFORE IT APPLIES — where `pg`/`JSON.stringify` wrote
 * the document. The spelling is PRE-EXISTING (byte-identical at `a9dcb8a`);
 * what `SER-3` changed is that it now turns into a refusal instead of bytes.
 * Graded LOW because the only in-repo caller (`api.ts`'s forbidden-key branch)
 * passes `forbiddenControlKeysIn(request.body)` — a frozen ordinary array — and
 * `PostgresControlAuditSink` is not wired at HEAD; pinned anyway, because the
 * sink's own comment justifies its safety with the containers its producers
 * build, and that justification has to be TRUE rather than nearly true.
 *
 * The fix is on the PRODUCER side, as M2's was: `[...keys]` is an array-literal
 * spread, which is ordinary whatever the species is (the same spelling
 * `packages/polymarket-public/src/venue/frames.ts` uses for `assets_ids`). The
 * encoder's non-plain refusal is untouched.
 *
 * Every expectation below is BASE'S BYTES: `JSON.stringify` of the same
 * document, computed in this clean process. No inherited `toJSON` is installed
 * anywhere in this file — that is `./inherited-tojson.test.ts`'s subject, and
 * this one is about the container TYPE a caller supplies.
 */

import { describe, expect, it } from "vitest";

import type {
  AuditAppendResult,
  AuditStateDocument,
  ControlAuditRecord,
  ControlAuditSink,
} from "../../../packages/observability/src/index.js";
import type { PolymarketBotDatabase } from "../../../packages/storage-postgres/src/index.js";
import { encodePlainJson } from "../../../packages/risk/src/plain-json.js";

import { PostgresControlAuditSink } from "../../../apps/control-api/src/adapters/postgres-audit-sink.js";
import { ControlPlane, type MutationContext } from "../../../apps/control-api/src/control-plane.js";
import {
  CONTROL_API_RUN_MODE,
  REPOSITORY_MAXIMUM_RUN_MODE,
} from "../../../apps/control-api/src/safety.js";
import {
  bearer,
  createHarness,
  FAKE_OPERATOR_TOKEN,
} from "../../../apps/control-api/src/testing/index.js";

/** The reviewer's fixture: an ordinary `Array` subclass of ordinary strings. */
class Keys extends Array<string> {}

/** A sink that keeps every record BY REFERENCE, so the containers survive. */
class CapturingAuditSink implements ControlAuditSink {
  readonly records: ControlAuditRecord[] = [];

  append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    this.records.push(record);
    return Promise.resolve({ ok: true });
  }
}

/** A fake Kysely handle that captures every row `insertInto(...).values(row).execute()` would write. */
function capturingDb(): {
  readonly db: PolymarketBotDatabase;
  readonly rows: { table: string; row: Record<string, unknown> }[];
} {
  const rows: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    insertInto: (table: string) => ({
      values: (row: Record<string, unknown>) => ({
        execute: () => {
          rows.push({ table, row });
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return { db: db as unknown as PolymarketBotDatabase, rows };
}

const CONTEXT: MutationContext = {
  actor: "operator-a",
  at: "2026-09-05T00:00:01.000Z",
  auditRecordId: "01930000-0000-7000-8000-000000000001",
  reason: "request to POST /v1/kill-switch named runMode, allowRealOrders",
};

/** The REAL control plane over a capturing sink. Nothing here is a double but the sink. */
function realControlPlane(): { readonly plane: ControlPlane; readonly sink: CapturingAuditSink } {
  const sink = new CapturingAuditSink();
  const plane = new ControlPlane({
    audit: sink,
    runMode: CONTROL_API_RUN_MODE,
    maximumRunMode: CONTROL_API_RUN_MODE,
    repositoryMaximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE,
  });
  return { plane, sink };
}

/** The `attemptedKeys` member of a record's resulting-state document. */
function attemptedKeysOf(record: ControlAuditRecord): unknown {
  const state = record.resultingState as { readonly [key: string]: AuditStateDocument };
  return state["attemptedKeys"];
}

/** Base's document for a refused mode-raise attempt naming `keys`. */
function baseDocument(keys: readonly string[]): string {
  return JSON.stringify({
    runMode: CONTROL_API_RUN_MODE,
    maximumRunMode: CONTROL_API_RUN_MODE,
    repositoryMaximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE,
    allowRealOrders: "false",
    runModeIsWritable: "false",
    signerLoaded: "false",
    attemptedKeys: [...keys],
  });
}

describe("the audit record a mode-raise attempt writes (the N1 regression)", () => {
  it("records an ORDINARY attemptedKeys for an Array SUBCLASS of keys", async () => {
    const { plane, sink } = realControlPlane();
    const keys = new Keys("runMode", "allowRealOrders");
    // Non-vacuity: the fixture really IS a foreign container — in type, with no
    // cast — which the encoder is right to refuse if it ever reaches it.
    expect(Array.isArray(keys)).toBe(true);
    expect(Object.getPrototypeOf(keys)).not.toBe(Array.prototype);

    await plane.refuseModeRaise(keys, CONTEXT);

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record.action).toBe("MODE_RAISE_ATTEMPT");
    expect(record.outcome).toBe("REFUSED");
    // THE PROPERTY: the recorded container is this process's own.
    const attempted = attemptedKeysOf(record);
    expect(Array.isArray(attempted)).toBe(true);
    expect(Object.getPrototypeOf(attempted)).toBe(Array.prototype);
    expect(attempted).toEqual(["runMode", "allowRealOrders"]);
    // And the attempt was still counted and still changed nothing.
    expect(plane.modeRaiseAttemptsRefused).toBe(1);
    expect(plane.runState().runMode).toBe(CONTROL_API_RUN_MODE);
  });

  it("the durable sink ACCEPTS that record and hands pg base's bytes", async () => {
    const { plane, sink } = realControlPlane();
    const keys = new Keys("runMode", "allowRealOrders");
    await plane.refuseModeRaise(keys, CONTEXT);
    const record = sink.records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;

    // The own-data encoder accepts the document `asJsonInput` would wrap, and
    // produces exactly the bytes `pg`'s `JSON.stringify` produced at base.
    expect(encodePlainJson(record.resultingState)).toBe(baseDocument(keys));

    // The same through the REAL durable sink, which is where the refusal
    // would have surfaced: an `AUDIT_SINK_UNAVAILABLE` for a mutation base
    // recorded. A refused mode-raise is a `config_change_audit` row.
    const { db, rows } = capturingDb();
    const durable = new PostgresControlAuditSink({ db, environment: "PAPER" });
    const result = await durable.append(record);
    expect(result.ok, result.ok ? "" : `${result.code}: ${result.detail}`).toBe(true);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.table).toBe("ops.config_change_audit");
    expect(typeof row.row["new_value"]).toBe("string");
    expect(row.row["new_value"]).toBe(baseDocument(keys));
    // The prior state is the ceiling, unchanged: an attempt moves nothing.
    expect(row.row["previous_value"]).toBe(
      JSON.stringify({
        runMode: CONTROL_API_RUN_MODE,
        maximumRunMode: CONTROL_API_RUN_MODE,
        repositoryMaximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE,
        allowRealOrders: "false",
        runModeIsWritable: "false",
        signerLoaded: "false",
      }),
    );
  });

  it("the in-repo caller's own array is unchanged: a request naming a forbidden key is 403 and audited", async () => {
    // `api.ts` passes `forbiddenControlKeysIn(request.body)`, a frozen ordinary
    // array — the path that exists today, driven end to end on the REAL API so
    // the fix is pinned where it is actually reached as well as where it is
    // reachable in type.
    const { api, audit } = createHarness();
    const response = await api.handle({
      method: "POST",
      path: "/v1/kill-switch",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: { runMode: "LIVE", reason: "no" },
    });
    expect(response.status).toBe(403);

    const records = audit.records();
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record.action).toBe("MODE_RAISE_ATTEMPT");
    const attempted = attemptedKeysOf(record);
    expect(Object.getPrototypeOf(attempted)).toBe(Array.prototype);
    expect(attempted).toEqual(["runMode"]);
    expect(encodePlainJson(record.resultingState)).toBe(baseDocument(["runMode"]));
  });
});
