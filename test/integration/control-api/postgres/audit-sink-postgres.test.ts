/**
 * The durable audit sink against a REAL PostgreSQL (`CONTROL-1b`, closing
 * `CONTROL-1` follow-up 3c and the joint INFO `CONTROL1-R2-J-I2`).
 *
 * `src/adapters/postgres-audit-sink.ts` was typecheck-pinned only until this
 * file: nothing had ever inserted a control-plane record into the §10.6 `ops`
 * tables. Two claims are measured here, on a Testcontainers PostgreSQL with
 * every migration applied:
 *
 * 1. **The bytes the round is about really do break a durable append** — the
 *    non-vacuity half. A RAW record with NUL in a `text` column, NUL or a lone
 *    surrogate in a `jsonb` document, an escaped reason longer than
 *    `internal.detail` or a `scope_ref` longer than `internal.identifier` is
 *    REFUSED by PostgreSQL; a lone surrogate in a `text` column is accepted
 *    but silently REPLACED, so the database would hold different text from
 *    the in-memory log.
 * 2. **Through the REAL control plane, every such record lands, and PostgreSQL
 *    holds exactly what memory holds.** The control plane writes through a tee
 *    of the real append-only log and the real durable sink; every hostile
 *    mutation, refusal, mode-raise attempt and void record is appended to
 *    both, and each row read back equals the in-memory record field for field.
 *
 * The characters under test are built from code points, so this file holds
 * none of them raw. Docker is required (`vitest.config.ts` beside this file).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AUDIT_IDENTIFIER_MAX_TEXT, AUDIT_REASON_MAX_TEXT, ControlPlane, escapeAuditText } from "@polymarket-bot/control-api";
import {
  InMemoryControlAuditLog,
  type AuditAppendResult,
  type ControlAuditRecord,
  type ControlAuditSink,
} from "@polymarket-bot/observability";
import { uuidV7 } from "@polymarket-bot/storage-postgres";
import {
  createIsolatedDatabase,
  createMigratedContext,
  startPostgresContainer,
  type TestContext,
} from "@polymarket-bot/storage-postgres/testing";

import { PostgresControlAuditSink } from "../../../../apps/control-api/src/adapters/postgres-audit-sink.js";

const NUL = String.fromCodePoint(0);
const ESC = String.fromCodePoint(0x1b);
const RLO = String.fromCodePoint(0x202e);
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCodePoint(0xfffd);
const HOSTILE = `a${NUL}b${HIGH}c${RLO}d${ESC}[2J${LOW}e`;

let container: Awaited<ReturnType<typeof startPostgresContainer>> | undefined;
let context: TestContext | undefined;

function database(): TestContext {
  if (context === undefined) throw new Error("the PostgreSQL context was not created");
  return context;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const isolated = await createIsolatedDatabase(container.getConnectionUri(), "control_1b_audit");
  context = await createMigratedContext(isolated.connectionString);
});

afterAll(async () => {
  await context?.close();
  await container?.stop();
});

function durable(): PostgresControlAuditSink {
  return new PostgresControlAuditSink({ db: database().db, environment: "PAPER" });
}

/** A record shaped as the control plane builds one — RAW, not escaped. */
function rawRecord(overrides: Partial<ControlAuditRecord> = {}): ControlAuditRecord {
  return {
    recordId: uuidV7(),
    action: "STRATEGY_PAUSE",
    outcome: "REFUSED",
    actor: "operator-a",
    actorKind: "HUMAN",
    scope: "STRATEGY_INSTANCE",
    scopeRef: "sb-1",
    reason: "a stated reason",
    priorState: { refusedAt: "REQUEST_BODY", stateRead: "false" },
    resultingState: { refusedAt: "REQUEST_BODY", stateRead: "false" },
    at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

interface StoredRow {
  readonly table: "kill_switch_events" | "config_change_audit";
  readonly actor: string;
  readonly actor_kind: string;
  readonly target: string | null;
  readonly reason: string;
  readonly kind: string;
  readonly prior: unknown;
  readonly resulting: unknown;
}

/** The row a record id landed as, from whichever §10.6 table holds it. */
async function rowFor(recordId: string): Promise<StoredRow | undefined> {
  const pool = database().pool;
  const killSwitch = await pool.query<StoredRow>(
    `select 'kill_switch_events' as "table", actor, actor_kind::text as actor_kind, scope_ref as target, reason,
            action::text as kind, prior_state as prior, resulting_state as resulting
       from ops.kill_switch_events where kill_switch_event_id = $1`,
    [recordId],
  );
  if (killSwitch.rows[0] !== undefined) return killSwitch.rows[0];
  const config = await pool.query<StoredRow>(
    `select 'config_change_audit' as "table", actor, actor_kind::text as actor_kind, target_id as target, reason,
            change_kind as kind, previous_value as prior, new_value as resulting
       from ops.config_change_audit where config_change_id = $1`,
    [recordId],
  );
  return config.rows[0];
}

describe("CONTROL-1b 3c, the non-vacuity half: PostgreSQL refuses — or rewrites — the raw bytes", () => {
  it.each([
    ["NUL in the reason (text)", { reason: `a${NUL}b` }],
    ["NUL in a state document (jsonb)", { resultingState: { refusalIssues: [`a${NUL}b`] } }],
    ["a lone surrogate in a state document (jsonb)", { resultingState: { refusalIssues: [`a${HIGH}b`] } }],
    ["an ESCAPED reason longer than internal.detail", { reason: escapeAuditText(NUL.repeat(1_024)) }],
    ["a scopeRef longer than internal.identifier", { scopeRef: "x".repeat(AUDIT_IDENTIFIER_MAX_TEXT + 1) }],
  ] as const)("%s: the raw record is REFUSED, so at CONTROL-1 the refusal went unaudited", async (_label, overrides) => {
    const result = await durable().append(rawRecord(overrides as Partial<ControlAuditRecord>));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("AUDIT_SINK_UNAVAILABLE");
  });

  it("a lone surrogate in a text column is ACCEPTED but REPLACED: the database and the in-memory log would disagree", async () => {
    const record = rawRecord({ reason: `a${LOW}b` });
    expect((await durable().append(record)).ok).toBe(true);
    const row = await rowFor(record.recordId);
    expect(row?.reason).toBe(`a${REPLACEMENT}b`);
    expect(row?.reason).not.toBe(record.reason);
  });
});

/** Appends to PostgreSQL first and to the in-memory log only if it landed: the two must agree. */
class TeeSink implements ControlAuditSink {
  readonly memory = new InMemoryControlAuditLog(1_000);
  readonly refused: string[] = [];
  readonly #durable = durable();

  async append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    const stored = await this.#durable.append(record);
    if (!stored.ok) {
      this.refused.push(`${record.action}/${record.outcome}: ${stored.detail}`);
      return stored;
    }
    return this.memory.append(record);
  }
}

describe("CONTROL-1b 3c: through the REAL control plane every hostile record LANDS, and PostgreSQL holds what memory holds", () => {
  it("mutations, refusals, a mode-raise attempt and a void — appended to both, equal field for field", async () => {
    const tee = new TeeSink();
    let stalling = false;
    const held: (() => void)[] = [];
    const sink: ControlAuditSink = {
      append: (record) =>
        stalling && record.outcome === "APPLIED"
          ? new Promise<AuditAppendResult>((resolve) => {
              held.push(() => {
                void tee.append(record).then(resolve);
              });
            })
          : tee.append(record),
    };
    const control = new ControlPlane({
      audit: sink,
      runMode: "PAPER",
      maximumRunMode: "PAPER",
      repositoryMaximumRunMode: "PAPER",
      auditAppendTimeoutMs: 250,
      auditRecordSource: { now: () => new Date().toISOString(), nextAuditRecordId: () => uuidV7() },
    });
    const ctx = (reason = "a stated reason"): Parameters<ControlPlane["pauseStrategy"]>[1] => ({
      actor: "operator-a",
      at: new Date().toISOString(),
      auditRecordId: uuidV7(),
      reason,
    });

    // A door refusal carrying the joint INFO's key, a lone surrogate, a
    // terminal escape and a megabyte of text in its issues.
    await control.refuseRequest(
      "STRATEGY_PAUSE",
      { scope: "STRATEGY_INSTANCE", scopeRef: "sb-1" },
      "REQUEST_BODY",
      {
        code: "CONTROL_REQUEST_INVALID",
        detail: HOSTILE,
        issues: [`: Unrecognized key: "${NUL}k${RLO}"`, HOSTILE, "y".repeat(1_048_576)],
      },
      ctx(HOSTILE),
    );
    // APPLIED engages whose scopeRef and reason hold the same bytes — one with a
    // 256-character scopeRef and a 1024-NUL reason, both legal at the API.
    const market = { scope: "MARKET", scopeRef: `m${HOSTILE}` } as const;
    expect((await control.engageKillSwitch({ ...market, action: "HALT_NEW_ENTRIES" }, ctx(HOSTILE))).ok).toBe(true);
    const longRef = RLO.repeat(256);
    expect((await control.engageKillSwitch({ scope: "MARKET", scopeRef: longRef, action: "FULL_HALT" }, ctx(NUL.repeat(1_024)))).ok).toBe(true);
    // Refusals at the plane, an escalation and a release.
    expect((await control.engageKillSwitch({ ...market, action: "HALT_NEW_ENTRIES" }, ctx(HOSTILE))).ok).toBe(false);
    expect((await control.engageKillSwitch({ ...market, action: "FULL_HALT" }, ctx(HOSTILE))).ok).toBe(true);
    expect(
      (await control.releaseKillSwitch({ ...market, release: { authoritativeSnapshotApplied: true, reason: HOSTILE } }, ctx(HOSTILE))).ok,
    ).toBe(true);
    expect((await control.pauseStrategy(`ghost${RLO}${HIGH}`, ctx(HOSTILE))).ok).toBe(false);
    // A mode-raise attempt naming forty keys, behind a hostile reason.
    const keys = Array.from({ length: 40 }, (_, index) => `runMode${String(index)}`);
    expect(await control.refuseModeRaise(keys, ctx(`request to POST /${HOSTILE.repeat(400)}`))).toEqual({ audited: true });
    // An APPLIED record that lands after its bound, and the void beside it.
    stalling = true;
    const late = await control.engageKillSwitch({ scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" }, ctx(HOSTILE));
    expect(late).toMatchObject({ ok: false, code: "CONTROL_NOT_AUDITABLE" });
    for (const settle of held.splice(0)) settle();
    await vi.waitFor(
      () => {
        expect(control.mutationCounts()).toContainEqual({ action: "KILL_SWITCH_ENGAGE", outcome: "VOIDED", count: 1 });
      },
      { timeout: 10_000 },
    );
    expect(control.killSwitches().map((entry) => entry.scopeRef)).toEqual([longRef]);

    // NOTHING was refused by PostgreSQL, and nothing went unaudited but the
    // one append that outlived its bound.
    expect(tee.refused).toEqual([]);
    expect(control.mutationCounts().filter((entry) => entry.outcome === "NOT_AUDITED")).toEqual([
      { action: "KILL_SWITCH_ENGAGE", outcome: "NOT_AUDITED", count: 1 },
    ]);
    // 1 door refusal, 2 engages, 1 plane refusal, 1 escalation, 1 release,
    // 1 unknown-instance refusal, 1 mode-raise attempt, 1 late APPLIED, 1 void.
    const records = tee.memory.records();
    expect(records.length).toBe(10);

    for (const record of records) {
      const row = await rowFor(record.recordId);
      expect(row, record.recordId).toBeDefined();
      const killSwitchEvent =
        record.outcome === "APPLIED" && (record.action === "KILL_SWITCH_ENGAGE" || record.action === "KILL_SWITCH_RELEASE");
      expect(row?.table).toBe(killSwitchEvent ? "kill_switch_events" : "config_change_audit");
      expect(row?.actor).toBe(record.actor);
      expect(row?.actor_kind).toBe(record.actorKind);
      expect(row?.target).toBe(record.scopeRef);
      expect(row?.reason).toBe(record.reason);
      if (!killSwitchEvent) expect(row?.kind).toBe(`${record.action}_${record.outcome}`);
      expect(row?.prior).toEqual(record.priorState);
      expect(row?.resulting).toEqual(record.resultingState);
      // No silent replacement anywhere: what memory holds is what PostgreSQL holds.
      expect(JSON.stringify(row).includes(REPLACEMENT), record.recordId).toBe(false);
      expect(row?.reason.length).toBeLessThanOrEqual(AUDIT_REASON_MAX_TEXT);
      expect((row?.target ?? "").length).toBeLessThanOrEqual(AUDIT_IDENTIFIER_MAX_TEXT);
    }

    // The void names the record it voids, and both are in the database.
    const voided = records.find((record) => record.actorKind === "AUTOMATED");
    const voidsId = (voided?.resultingState as Record<string, unknown> | undefined)?.["voidsRecordId"];
    expect(typeof voidsId).toBe("string");
    expect((await rowFor(String(voidsId)))?.table).toBe("kill_switch_events");
    // The cut scope_ref column keeps the whole reference in its documents.
    const longRow = records.find((record) => record.reason.startsWith("\\u{0}"));
    expect(longRow?.scopeRef?.endsWith("…")).toBe(true);
    expect((longRow?.resultingState as Record<string, unknown> | undefined)?.["scopeRef"]).toBe(escapeAuditText(longRef));
  });
});
