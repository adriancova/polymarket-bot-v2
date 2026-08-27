/**
 * Connection pool construction.
 *
 * Two session settings are not optional and are applied to every connection:
 *
 *   * `TimeZone=UTC` and `DateStyle=ISO` — so `timestamps.ts` can convert a
 *     rendering to ISO-8601 exactly rather than guessing.
 *   * `statement_timeout` — an unbounded statement on the trading path holds
 *     locks the OMS needs. §4.2 makes a PostgreSQL stall stop trading; it must
 *     do so promptly and visibly rather than by hanging.
 *
 * Type parsing is configured per pool rather than through `pg.types.setTypeParser`,
 * which mutates process-wide state that another package would inherit silently.
 *
 * This module reads no environment variable. Configuration is passed in, so a
 * process cannot acquire a connection it did not ask for (§15, ADR-010).
 */

import pg from "pg";

import { pgTimestampToIso } from "./timestamps.js";

type PgPool = pg.Pool;
type PgPoolConfig = pg.PoolConfig;

const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;

/** Configuration for {@link createPostgresPool}. */
export type PostgresPoolConfig = {
  /** Full connection string, e.g. `postgres://user:pass@host:5432/db`. */
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  /** Maximum pooled connections. */
  readonly maxConnections?: number;
  /** Statement timeout in milliseconds. Defaults to 30 seconds. */
  readonly statementTimeoutMs?: number;
  /** Idle-in-transaction timeout in milliseconds. Defaults to 60 seconds. */
  readonly idleInTransactionTimeoutMs?: number;
  /** Connection acquisition timeout in milliseconds. Defaults to 10 seconds. */
  readonly connectionTimeoutMs?: number;
  /** Reported to `pg_stat_activity`, so a stuck query is attributable. */
  readonly applicationName?: string;
};

export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
export const DEFAULT_APPLICATION_NAME = "polymarket-bot";

/**
 * `timestamp`, `timestamptz`, and `date` are returned as strings, never as
 * `Date`. `numeric` and `int8` are already returned as strings by `pg`, which is
 * what keeps an economic value away from binary floating point (§6 invariant 1).
 */
const customTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: unknown) => {
    if (oid === OID_TIMESTAMPTZ || oid === OID_TIMESTAMP) {
      return (value: string) => pgTimestampToIso(value);
    }
    if (oid === OID_DATE) {
      return (value: string) => value;
    }
    return pg.types.getTypeParser(oid, format as never);
  }) as pg.CustomTypesConfig["getTypeParser"],
};

/** Creates a pool whose sessions are configured for exact, UTC, bounded work. */
export function createPostgresPool(config: PostgresPoolConfig): PgPool {
  const statementTimeoutMs = config.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const idleInTransactionTimeoutMs =
    config.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;

  const poolConfig: PgPoolConfig = {
    ...(config.connectionString === undefined
      ? {}
      : { connectionString: config.connectionString }),
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.database === undefined ? {} : { database: config.database }),
    ...(config.user === undefined ? {} : { user: config.user }),
    ...(config.password === undefined ? {} : { password: config.password }),
    ...(config.maxConnections === undefined ? {} : { max: config.maxConnections }),
    application_name: config.applicationName ?? DEFAULT_APPLICATION_NAME,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    types: customTypes,
    // Applied by the server before any query on the connection runs, so no
    // statement can observe a different session configuration.
    options: [
      "-c timezone=UTC",
      "-c datestyle=ISO,MDY",
      `-c statement_timeout=${String(statementTimeoutMs)}`,
      `-c idle_in_transaction_session_timeout=${String(idleInTransactionTimeoutMs)}`,
    ].join(" "),
  };

  return new pg.Pool(poolConfig);
}

export type { PgPool as PostgresPool };
