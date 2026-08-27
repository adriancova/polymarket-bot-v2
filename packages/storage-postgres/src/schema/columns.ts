/**
 * Column type vocabulary shared by every table definition.
 *
 * The rule this file exists to enforce: **no economic column is ever typed
 * `number`** (§6 invariant 1, `docs/contracts/domain.md` §4). Prices, sizes,
 * fees, balances, and PnL are `DecimalString` — canonical decimal text, stored
 * in a PostgreSQL domain that rejects any other spelling. The only `number`
 * columns are counters, versions, and ordinals, which are not economic values.
 */

import type { DecimalString, IsoTimestamp, TokenId, Uuid } from "@polymarket-bot/domain";
import type { ColumnType } from "kysely";

// `IsoTimestamp` is re-exported by `timestamps.ts`, which owns the conversion;
// re-exporting it here as well would make the package's barrel ambiguous.
export type { DecimalString, TokenId, Uuid };

/** A canonical UUIDv7 primary key (§10.7 sortable ids). */
export type UuidV7Column = string;

/** A column the database fills in when omitted (`DEFAULT`). */
export type WithDefault<T> = ColumnType<T, T | undefined, T>;

/** A column the database computes and no writer may set (`GENERATED ALWAYS`). */
export type DatabaseGenerated<T> = ColumnType<T, never, never>;

/**
 * A column maintained by a database trigger from facts held elsewhere.
 *
 * Readable, never writable through this API — and, unlike a naming convention,
 * the database rejects a write from any other client too
 * (`accounting.balance_projection.reserved_amount` is a projection of
 * `accounting.inventory_reservations`, guarded by a trigger raising `PMB08`).
 */
export type TriggerMaintained<T> = ColumnType<T, never, never>;

/** A column fixed at insert time by a `forbid_column_change` trigger. */
export type InsertOnly<T> = ColumnType<T, T, never>;

/** A column fixed at insert time that the database may default. */
export type InsertOnlyWithDefault<T> = ColumnType<T, T | undefined, never>;

/**
 * Marks every column of a table as un-updatable.
 *
 * Applied to the §10.7 append-only tables, so `updateTable(...).set(...)` on an
 * event or ledger table fails to compile instead of failing at runtime against
 * the `forbid_update_delete` trigger. The trigger is still the enforcement — a
 * type only protects code that goes through these definitions — but a caller
 * should learn at build time.
 */
export type AppendOnlyTable<TColumns> = {
  readonly [K in keyof TColumns]: TColumns[K] extends ColumnType<
    infer TSelect,
    infer TInsert,
    unknown
  >
    ? ColumnType<TSelect, TInsert, never>
    : ColumnType<TColumns[K], TColumns[K], never>;
};

/**
 * A `jsonb` column.
 *
 * `pg` parses `jsonb` into JavaScript values on read and serializes an object on
 * write. `JsonValue` is the *read* shape and admits `number`, because a `jsonb`
 * document may contain one and pretending otherwise would be a lie about what
 * comes back.
 *
 * Write a JSON array as a pre-serialized string: `pg` renders a JavaScript array
 * as a PostgreSQL array literal, not as JSON.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonInput = string | { readonly [key: string]: JsonValue };

export type JsonColumn = ColumnType<JsonValue, JsonInput, JsonInput>;
export type JsonColumnWithDefault = ColumnType<JsonValue, JsonInput | undefined, JsonInput>;
/**
 * A nullable `jsonb` column.
 *
 * `JsonColumn | null` would not work: Kysely reads the insert and update types
 * out of the `ColumnType`, and a union with `null` hides them.
 */
export type NullableJsonColumn = ColumnType<
  JsonValue | null,
  JsonInput | null,
  JsonInput | null
>;

/**
 * A JSON document that may carry economic values (§6 invariant 1).
 *
 * `number` is excluded at every depth. A signed order, an intent, an order
 * event, or a strategy parameter set holds prices and sizes *inside* the
 * document, and `{ price: 0.42 }` is not the value `0.42` — it is the nearest
 * binary double, which is how a rounding error becomes a persisted fact
 * (`docs/contracts/domain.md` §3.2, §4). Economic values are canonical decimal
 * strings there exactly as they are in a column.
 *
 * The type is the compile-time half; `assertDecimalSafeJson()` in `src/json.ts`
 * is the runtime half, because a `jsonb` document reaches this boundary from
 * places TypeScript did not check (`JSON.parse`, a venue response, a test).
 */
export type DecimalSafeJsonValue =
  | string
  | boolean
  | null
  | readonly DecimalSafeJsonValue[]
  | { readonly [key: string]: DecimalSafeJsonValue };

export type DecimalSafeJsonInput = string | { readonly [key: string]: DecimalSafeJsonValue };

/** A `jsonb` column whose document may carry economic values. */
export type DecimalSafeJsonColumn = ColumnType<
  JsonValue,
  DecimalSafeJsonInput,
  DecimalSafeJsonInput
>;

/** A nullable `jsonb` column whose document may carry economic values. */
export type NullableDecimalSafeJsonColumn = ColumnType<
  JsonValue | null,
  DecimalSafeJsonInput | null,
  DecimalSafeJsonInput | null
>;

/** A `text[]` column over the enum-like `internal.code` domain. */
export type TextArrayColumn<T extends string> = ColumnType<T[], readonly T[], readonly T[]>;
export type TextArrayColumnWithDefault<T extends string> = ColumnType<
  T[],
  readonly T[] | undefined,
  readonly T[]
>;

/** `timestamptz`, always rendered as an ISO-8601 UTC instant. */
export type TimestampColumn = IsoTimestamp;
export type TimestampColumnWithDefault = WithDefault<IsoTimestamp>;

/** `bigint`, returned by `pg` as a string because 2^63 exceeds `Number`. */
export type BigIntColumn = string;

/** Canonical unsigned integer string (`ingestSeq`, `receivedMonotonicNs`). */
export type UnsignedIntegerString = string;

/** SHA-256 as 64 lowercase hex characters. */
export type Sha256Hex = string;

/** Bounded non-empty text (`internal.identifier`, max 200 characters). */
export type Identifier = string;

/** Metric-label-safe code (`internal.code`, `^[A-Za-z][A-Za-z0-9_.:-]*$`). */
export type Code = string;

/** Human-readable operational text (`internal.detail`, max 2000 characters). */
export type Detail = string;
