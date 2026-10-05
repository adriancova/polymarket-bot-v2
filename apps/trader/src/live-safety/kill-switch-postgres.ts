/**
 * The durable kill-switch read (WP-320; `kill-switch.ts` argues why the
 * table): the latest `ops.kill_switch_events` row of every
 * `(environment, scope, scope_ref)`, under TWO orderings.
 *
 * - by `recorded_at`, the DATABASE's clock at insert, tie broken by the
 *   event id;
 * - by `occurred_at`, the control plane's instant, tie broken by the event id.
 *
 * Both are returned. The fold treats a switch as released only when every
 * latest row for it is a release, so a clock that steps backwards on either
 * side can make a released switch read as engaged, never the reverse.
 *
 * Read-only: it selects from one append-only table and writes nothing. The
 * composition binds it to a connection whose role needs `SELECT` on
 * `ops.kill_switch_events` only. Like every adapter in this app written
 * without a database, its SQL is pinned by the typechecker against
 * `@polymarket-bot/storage-postgres`'s table types; an integration test of it
 * against PostgreSQL is a follow-up (this package's integration grant covers
 * the fencing race only).
 */

import type { PolymarketBotDatabase } from "@polymarket-bot/storage-postgres";

import type { KillSwitchReader, KillSwitchRow } from "./kill-switch.js";

interface SelectedRow {
  readonly kill_switch_event_id: string;
  readonly environment: string;
  readonly scope: string;
  readonly scope_ref: string | null;
  readonly action: string;
  readonly resulting_state: unknown;
}

function toRow(row: SelectedRow): KillSwitchRow {
  return Object.freeze({
    killSwitchEventId: row.kill_switch_event_id,
    environment: row.environment,
    scope: row.scope,
    scopeRef: row.scope_ref,
    action: row.action,
    resultingState: row.resulting_state,
  });
}

export function createPostgresKillSwitchReader(db: PolymarketBotDatabase): KillSwitchReader {
  return Object.freeze({
    async read(): Promise<readonly KillSwitchRow[]> {
      const byRecorded = await db
        .selectFrom("ops.kill_switch_events")
        .select(["kill_switch_event_id", "environment", "scope", "scope_ref", "action", "resulting_state"])
        .distinctOn(["environment", "scope", "scope_ref"])
        .orderBy("environment")
        .orderBy("scope")
        .orderBy("scope_ref")
        .orderBy("recorded_at", "desc")
        .orderBy("kill_switch_event_id", "desc")
        .execute();
      const byOccurred = await db
        .selectFrom("ops.kill_switch_events")
        .select(["kill_switch_event_id", "environment", "scope", "scope_ref", "action", "resulting_state"])
        .distinctOn(["environment", "scope", "scope_ref"])
        .orderBy("environment")
        .orderBy("scope")
        .orderBy("scope_ref")
        .orderBy("occurred_at", "desc")
        .orderBy("kill_switch_event_id", "desc")
        .execute();
      return Object.freeze([...byRecorded.map(toRow), ...byOccurred.map(toRow)]);
    },
  });
}
