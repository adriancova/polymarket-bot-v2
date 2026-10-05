/**
 * The durable kill-switch read: its SQL, compiled, and `read()` itself, run
 * over a RECORDING database handle (no database is reached here) — both
 * orderings are executed and both answers returned, in order, with the VOID
 * lookup's answer mapped fail-closed (r1, findings I6 and I7). The read runs
 * against a real PostgreSQL, under the control API's no-signer guard (r5), in
 * `test/integration/control-api/postgres/trader-kill-switch-postgres.test.ts`.
 */

import { createDatabase } from "@polymarket-bot/storage-postgres";
import { describe, expect, it } from "vitest";

import { createPostgresKillSwitchReader, killSwitchLatestRowQueries } from "./kill-switch-postgres.js";

// A pool that is never asked for a connection: compiling a query needs none.
const db = createDatabase({} as never);

/** A handle whose every statement is recorded and answered by `answer(sql)`. */
function recordingDatabase(answer: (sql: string) => readonly Record<string, unknown>[]): { readonly db: ReturnType<typeof createDatabase>; readonly executed: string[] } {
  const executed: string[] = [];
  const client = {
    query: async (sql: string): Promise<{ command: string; rowCount: number; rows: readonly Record<string, unknown>[] }> => {
      executed.push(sql);
      await Promise.resolve();
      const rows = answer(sql);
      return { command: "SELECT", rowCount: rows.length, rows };
    },
    release: (): void => undefined,
  };
  const pool = { connect: async () => client, end: async () => undefined };
  return { db: createDatabase(pool as never), executed };
}

function row(id: string, voided: unknown): Record<string, unknown> {
  return { kill_switch_event_id: id, environment: "LIVE_MICRO", scope: "GLOBAL", scope_ref: null, action: "FULL_HALT", resulting_state: { engaged: "false", scope: "GLOBAL", scopeRef: null }, voided };
}

describe("the durable kill-switch read (compiled SQL)", () => {
  it("selects the latest row of every (environment, scope, scope_ref) by the database's clock, tie broken by the event id", () => {
    const { sql } = killSwitchLatestRowQueries(db).byRecorded.compile();
    expect(sql).toContain('select distinct on ("e"."environment", "e"."scope", "e"."scope_ref")');
    expect(sql).toContain('from "ops"."kill_switch_events" as "e"');
    expect(sql).toContain('order by "e"."environment", "e"."scope", "e"."scope_ref", "e"."recorded_at" desc, "e"."kill_switch_event_id" desc');
  });

  it("and again by the control plane's instant", () => {
    const { sql } = killSwitchLatestRowQueries(db).byOccurred.compile();
    expect(sql).toContain('order by "e"."environment", "e"."scope", "e"."scope_ref", "e"."occurred_at" desc, "e"."kill_switch_event_id" desc');
    expect(sql).toContain('distinct on ("e"."environment", "e"."scope", "e"."scope_ref")');
  });

  it("r1 I6: each row carries whether a control-plane VOID record names it (config_change_audit, target ops.kill_switch_events, case-insensitive)", () => {
    for (const query of [killSwitchLatestRowQueries(db).byRecorded, killSwitchLatestRowQueries(db).byOccurred]) {
      const { sql, parameters } = query.compile();
      expect(sql).toContain(
        'exists (select 1 as "one" from "ops"."config_change_audit" as "v" where "v"."target_schema" = $1 and "v"."target_table" = $2 and lower(jsonb_extract_path_text("v"."new_value", $3)) = cast("e"."kill_switch_event_id" as text)) as "voided"',
      );
      expect(parameters).toEqual(["ops", "kill_switch_events", "voidsRecordId"]);
    }
  });
});

describe("r1 I7: read() runs BOTH orderings and returns every row of both", () => {
  it("executes the recorded_at ordering, then the occurred_at ordering, and returns both answers in that order", async () => {
    const { db: recording, executed } = recordingDatabase((sql) => (sql.includes('"e"."recorded_at" desc') ? [row("by-recorded", false)] : [row("by-occurred", false)]));
    const rows = await createPostgresKillSwitchReader(recording).read();
    expect(executed).toHaveLength(2);
    expect(executed[0]).toContain('"e"."recorded_at" desc');
    expect(executed[1]).toContain('"e"."occurred_at" desc');
    expect(rows.map((entry) => entry.killSwitchEventId)).toEqual(["by-recorded", "by-occurred"]);
    expect(rows.map((entry) => entry.voided)).toEqual([false, false]);
  });

  it("maps the VOID lookup fail-closed: only the boolean false is unvoided", async () => {
    const { db: recording } = recordingDatabase((sql) => (sql.includes('"e"."recorded_at" desc') ? [row("a", true), row("b", null), row("c", "f")] : [row("d", false)]));
    const rows = await createPostgresKillSwitchReader(recording).read();
    expect(rows.map((entry) => [entry.killSwitchEventId, entry.voided])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
      ["d", false],
    ]);
  });

  it("a failed statement fails the read (the monitor reads it as unknown state)", async () => {
    const { db: recording } = recordingDatabase((sql) => {
      if (sql.includes('"e"."occurred_at" desc')) throw new Error("relation lookup failed (synthetic)");
      return [];
    });
    await expect(createPostgresKillSwitchReader(recording).read()).rejects.toThrow();
  });
});
