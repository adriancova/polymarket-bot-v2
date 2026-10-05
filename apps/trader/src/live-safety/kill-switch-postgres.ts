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
 * Each row also carries `voided`: whether a control-plane VOID record in
 * `ops.config_change_audit` (target `ops.kill_switch_events`) names it in
 * `new_value ->> 'voidsRecordId'` (r1, I6: a release whose append outlived
 * the control plane's bound was refused and not applied, though its row
 * landed). Compared case-insensitively: a voided row can only be missed by
 * NOT matching, which would honour a refused release.
 *
 * Read-only: it selects from two append-only tables and writes nothing. The
 * composition binds it to a connection whose role needs `SELECT` on
 * `ops.kill_switch_events` and `ops.config_change_audit` only. Its SQL is
 * pinned by the typechecker against `@polymarket-bot/storage-postgres`'s table
 * types and compiled in `kill-switch-postgres.test.ts`, which also runs
 * `read()` over a recording handle (both orderings, in order); it runs against
 * a real PostgreSQL, under the control API's no-signer guard (r5), in
 * `test/integration/control-api/postgres/trader-kill-switch-postgres.test.ts`.
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
  readonly voided: unknown;
}

function toRow(row: SelectedRow): KillSwitchRow {
  return Object.freeze({
    killSwitchEventId: row.kill_switch_event_id,
    environment: row.environment,
    scope: row.scope,
    scopeRef: row.scope_ref,
    action: row.action,
    resultingState: row.resulting_state,
    // Anything but the boolean `false` is voided (fail closed: the fold honours only `voided === false`).
    voided: row.voided !== false,
  });
}

/** Whether a VOID record names the row `e` (module header), as a selection of the latest-row queries. */
function voidedSelection(db: PolymarketBotDatabase) {
  return db
    .selectFrom("ops.kill_switch_events as e")
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom("ops.config_change_audit as v")
            .select(eb.lit(1).as("one"))
            .where("v.target_schema", "=", "ops")
            .where("v.target_table", "=", "kill_switch_events")
            .where((w) =>
              w(w.fn<string>("lower", [w.fn<string>("jsonb_extract_path_text", [w.ref("v.new_value"), w.val("voidsRecordId")])]), "=", w.cast<string>("e.kill_switch_event_id", "text")),
            ),
        )
        .as("voided"),
    );
}

/** The two queries, built (not run): the latest row per `(environment, scope, scope_ref)` by each ordering. */
export function killSwitchLatestRowQueries(db: PolymarketBotDatabase) {
  const byRecorded = voidedSelection(db)
    .select(["e.kill_switch_event_id", "e.environment", "e.scope", "e.scope_ref", "e.action", "e.resulting_state"])
    .distinctOn(["e.environment", "e.scope", "e.scope_ref"])
    .orderBy("e.environment")
    .orderBy("e.scope")
    .orderBy("e.scope_ref")
    .orderBy("e.recorded_at", "desc")
    .orderBy("e.kill_switch_event_id", "desc");
  const byOccurred = voidedSelection(db)
    .select(["e.kill_switch_event_id", "e.environment", "e.scope", "e.scope_ref", "e.action", "e.resulting_state"])
    .distinctOn(["e.environment", "e.scope", "e.scope_ref"])
    .orderBy("e.environment")
    .orderBy("e.scope")
    .orderBy("e.scope_ref")
    .orderBy("e.occurred_at", "desc")
    .orderBy("e.kill_switch_event_id", "desc");
  return { byRecorded, byOccurred };
}

/** Both orderings' latest rows, the `recorded_at` ordering first (the fold needs every one; I7). */
export function createPostgresKillSwitchReader(db: PolymarketBotDatabase): KillSwitchReader {
  return Object.freeze({
    async read(): Promise<readonly KillSwitchRow[]> {
      const { byRecorded, byOccurred } = killSwitchLatestRowQueries(db);
      const recorded = await byRecorded.execute();
      const occurred = await byOccurred.execute();
      return Object.freeze([...recorded.map(toRow), ...occurred.map(toRow)]);
    },
  });
}
