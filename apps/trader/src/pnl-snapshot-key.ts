/**
 * The identity of one `accounting.pnl_snapshots` row — `SNAP-1`.
 *
 * `db/migrations/0006_accounting.up.sql` declares
 *
 * ```
 * constraint pnl_snapshots_scope_unique unique nulls not distinct (
 *   scope, environment, account_ref, instance_id, market_id, as_of
 * )
 * ```
 *
 * so the table holds at most ONE row per instance (and market) per instant.
 * The user's ruling (2026-09-28, "one snapshot per instance per instant") made
 * that the trader's own rule. This module is the ONE definition of the
 * identity, read by two parties that must agree:
 *
 * - `loop.ts` (`CoreLoop.#flushPnlSnapshots`), to tell a row it has already
 *   inserted — which a later harvest at the same instant REPLACES — from a row
 *   it has not, which it INSERTS;
 * - `testing/index.ts` (`MemoryTraderStore`), which enforces the constraint as
 *   the database does, so an in-memory run can no longer mask a duplicate
 *   (`BRACKET1C-SNAPKEY`).
 *
 * It reads the row exactly as `adapters/postgres-store.ts` binds it
 * (`toPnlSnapshotRow`, own data fields only). No clock is read; nothing here
 * touches a store.
 */

import { toPnlSnapshotRow, type PnlSnapshot } from "@polymarket-bot/pnl";

/**
 * The name of `accounting.pnl_snapshots`' identity constraint
 * (`db/migrations/0006_accounting.up.sql`).
 */
export const PNL_SNAPSHOT_SCOPE_UNIQUE = "pnl_snapshots_scope_unique";

/**
 * `timestamptz` equality for `as_of`: the instant at MICROSECOND resolution,
 * whatever the zone or the number of fraction digits the string carries — so
 * `…T09:00:02Z`, `…T09:00:02.000Z` and `…T11:00:02+02:00` are one key, as they
 * are in PostgreSQL. Digits past the sixth are rounded half-to-even, which is
 * what PostgreSQL 16 did on every tie probed for `SNAP-1` (`.0000005` → `.000000`,
 * `.0000015` → `.000002`, `.0000025` → `.000002`, `.0000035` → `.000004`). A
 * string this cannot read keys as itself (the real column would refuse it,
 * with a different error the in-memory double does not model). The loop's own
 * instants are strict-UTC milliseconds (`time.ts`), which this reads exactly.
 */
function asOfKey(asOf: unknown): string {
  if (typeof asOf !== "string") return JSON.stringify(String(asOf));
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(asOf);
  if (match === null) return JSON.stringify(asOf);
  const [, year, month, day, hour, minute, second, fraction = "", zone = "Z"] = match;
  const offsetSeconds =
    zone === "Z"
      ? 0
      : (zone.startsWith("-") ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 3600 + Number(zone.slice(4, 6)) * 60);
  let seconds =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) /
      1000 -
    offsetSeconds;
  let micros = Number(fraction.padEnd(6, "0").slice(0, 6));
  const rest = fraction.slice(6);
  if (rest !== "") {
    const first = rest.charCodeAt(0) - 48;
    const beyond = /[1-9]/u.test(rest.slice(1));
    if (first > 5 || (first === 5 && (beyond || micros % 2 === 1))) micros += 1;
  }
  if (micros === 1_000_000) {
    seconds += 1;
    micros = 0;
  }
  return `${String(seconds)}.${String(micros).padStart(6, "0")}`;
}

/**
 * The identity `pnl_snapshots_scope_unique` is declared over —
 * `unique nulls not distinct (scope, environment, account_ref, instance_id,
 * market_id, as_of)` — read from the row exactly as the adapter binds it
 * (`toPnlSnapshotRow`, own fields only). An absent value binds as NULL in the
 * adapter and as `null` here, and two NULLs are EQUAL (`nulls not distinct`).
 * `run_id` and `denomination_asset` are NOT in the key.
 */
export function pnlSnapshotKey(snapshot: PnlSnapshot): string {
  const row = toPnlSnapshotRow(snapshot);
  return JSON.stringify([
    row.scope ?? null,
    row.environment ?? null,
    row.accountRef ?? null,
    row.instanceId ?? null,
    row.marketId ?? null,
    asOfKey(row.asOf),
  ]);
}

/**
 * Why a replacement was refused (`SNAP-1` r1): it must rewrite EXACTLY one row
 * of the snapshot's identity, and `matched` rows did match. The constraint
 * makes more than one impossible, so in practice `matched` is `0` — the row the
 * loop inserted is not there — and the port answers a failure the loop halts
 * on, never an insert in its place. `PostgresTraderStore.replacePnlSnapshot`
 * throws this as an `Error` into `#contained`, and `MemoryTraderStore` answers
 * the same port data, so the two cannot drift apart.
 */
export function unreplacedPnlSnapshotProblem(matched: bigint): string {
  return (
    `a PnL snapshot replacement rewrites exactly one row of its ${PNL_SNAPSHOT_SCOPE_UNIQUE} identity, ` +
    `and ${String(matched)} matched`
  );
}
