/**
 * The durable kill-switch read's SQL, compiled (never run: no database is
 * reached here). Disclosed limit: this pins the statement's SHAPE — the
 * table, the columns, `DISTINCT ON (environment, scope, scope_ref)` and both
 * orderings — not its behaviour against PostgreSQL, which this package's
 * integration grant (the fencing race only) does not cover; that test is a
 * follow-up.
 */

import { createDatabase } from "@polymarket-bot/storage-postgres";
import { describe, expect, it } from "vitest";

import { killSwitchLatestRowQueries } from "./kill-switch-postgres.js";

// A pool that is never asked for a connection: compiling a query needs none.
const db = createDatabase({} as never);

describe("the durable kill-switch read (compiled SQL)", () => {
  it("selects the latest row of every (environment, scope, scope_ref) by the database's clock, tie broken by the event id", () => {
    const { sql } = killSwitchLatestRowQueries(db).byRecorded.compile();
    expect(sql).toBe(
      'select distinct on ("environment", "scope", "scope_ref") "kill_switch_event_id", "environment", "scope", "scope_ref", "action", "resulting_state" from "ops"."kill_switch_events" order by "environment", "scope", "scope_ref", "recorded_at" desc, "kill_switch_event_id" desc',
    );
  });

  it("and again by the control plane's instant", () => {
    const { sql } = killSwitchLatestRowQueries(db).byOccurred.compile();
    expect(sql).toContain('order by "environment", "scope", "scope_ref", "occurred_at" desc, "kill_switch_event_id" desc');
    expect(sql).toContain('distinct on ("environment", "scope", "scope_ref")');
  });
});
