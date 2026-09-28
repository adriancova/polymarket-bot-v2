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

/** The ISO-8601 spelling this module reads: a date, a time, 0+ fraction digits, a zone. */
const AS_OF_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

const SECONDS_PER_DAY = 86_400;
const MICROS_PER_SECOND = 1_000_000;

/** Days in each month of a common year; February gains one in a Gregorian leap year. */
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The days `month` has in `year` — `0` for a month that does not exist (`00`, `13`), so no day fits it. */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/**
 * Days from 1970-01-01 to a proleptic-Gregorian civil date, in integer
 * arithmetic only (Howard Hinnant's `days_from_civil`). NOT `Date.UTC`, which
 * reads a year `0`–`99` as `1900`–`1999`: `0099-05-01` and `1999-05-01` were
 * one key, while PostgreSQL stores two instants 1900 years apart
 * (`SNAP1-R3`). A four-digit year here is the year written.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/**
 * The fraction's microseconds, as PostgreSQL 16.6 answered for every fraction
 * measured (`SNAP1-R3`): the digits read as the nearest double, scaled by one
 * million in double arithmetic, then rounded half-to-even — C's
 * `rint(strtod(".ddd") * 1000000)`. NOT a decimal rounding of the digits:
 * PostgreSQL reads `.5185705` as `.518571` (the double sits just above the
 * tie), where a decimal half-to-even gives `.518570`. `Number` reads the digits
 * to the nearest double (the language lets a runtime round differently past
 * the 20th significant digit; V8, the runtime here, agreed with PostgreSQL on
 * every fraction probed, up to 28 digits). `scaled - floor` is exact for
 * `0 <= scaled <= 1000000`.
 */
function fractionMicros(fraction: string): number {
  if (fraction === "") return 0;
  const scaled = Number(`0.${fraction}`) * MICROS_PER_SECOND;
  const floor = Math.floor(scaled);
  const above = scaled - floor;
  if (above < 0.5) return floor;
  if (above > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * `timestamptz` equality for `as_of`: the instant at MICROSECOND resolution,
 * whatever the zone or the number of fraction digits the string carries — so
 * `…T09:00:02Z`, `…T09:00:02.000Z` and `…T11:00:02+02:00` are one key, as they
 * are in PostgreSQL.
 *
 * Over every string {@link AS_OF_PATTERN} reads, two strings share a key
 * exactly when PostgreSQL 16 reads them as ONE instant (`SNAP1-R3`; measured
 * string by string against a real PostgreSQL 16.6):
 *
 * - the year is the year written: `0099` is not `1999` ({@link daysFromCivil});
 * - a value PostgreSQL REFUSES is never rolled over into another instant's
 *   key: year `0000` (there is no year zero), month `00` or `13`, a day the
 *   month does not have (`2026-02-30`, `1900-02-29`), minute `60`, second
 *   `61`, a time of day past `24:00:00` once the fraction is rounded, a zone
 *   past `±15:59` or with minute `60`. Such a string keys as ITSELF, below;
 * - what PostgreSQL rolls over, this rolls over identically: `24:00:00` is the
 *   next day's midnight, second `60` the next minute's `:00`, and a fraction
 *   that rounds to a whole second carries (`23:59:59.9999996` is the next day);
 * - digits past the sixth round as {@link fractionMicros} says.
 *
 * A string this cannot read, or that PostgreSQL refuses, keys as itself (the
 * real column would refuse it, with a different error the in-memory double
 * does not model), so it is never conflated with an instant. The loop's own
 * instants are strict-UTC milliseconds (`time.ts`), which this reads exactly.
 */
function asOfKey(asOf: unknown): string {
  if (typeof asOf !== "string") return JSON.stringify(String(asOf));
  const match = AS_OF_PATTERN.exec(asOf);
  if (match === null) return JSON.stringify(asOf);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone = "Z"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  let micros = fractionMicros(fraction);
  const timeOfDayMicros = ((hour * 60 + minute) * 60 + second) * MICROS_PER_SECOND + micros;
  // What PostgreSQL 16.6 refused when measured. A month that does not exist
  // has no day; an hour past 24 is a time of day past 24:00:00.
  if (
    year < 1 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    minute > 59 ||
    second > 60 ||
    timeOfDayMicros > SECONDS_PER_DAY * MICROS_PER_SECOND ||
    zoneHours > 15 ||
    zoneMinutes > 59
  ) {
    return JSON.stringify(asOf);
  }
  const offsetSeconds = (zone.startsWith("-") ? -1 : 1) * (zoneHours * 3600 + zoneMinutes * 60);
  let seconds =
    daysFromCivil(year, month, day) * SECONDS_PER_DAY + (hour * 60 + minute) * 60 + second - offsetSeconds;
  if (micros === MICROS_PER_SECOND) {
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
