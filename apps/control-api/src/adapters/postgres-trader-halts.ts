/**
 * `CONTROL-2` — the PostgreSQL trader halt source: the open `TRADER_HALT:*`
 * rows of `ops.incidents` (`trader-halts.ts`), READ ONLY and BOUNDED.
 *
 * ## What it reads
 *
 * Two statements in ONE `REPEATABLE READ, READ ONLY` transaction, so both see
 * one snapshot (the door checks that the count and the list agree):
 *
 * 1. the exact counts: every open row in the namespace, and each of the
 *    trader's three keys (`count(*) filter (where …)`, rendered as text);
 * 2. the newest {@link TRADER_HALT_LIST_LIMIT} open rows, every column the
 *    health answer lists, `opened_at` rendered as an ISO-8601 UTC instant by
 *    the SERVER (`to_char(timezone('UTC', opened_at), …)`) so the text does not
 *    depend on the session's `TimeZone`/`DateStyle` or on the pool's type
 *    parsers.
 *
 * "Open" is `status <> 'RESOLVED'`, the table's own partial-index predicate;
 * the namespace is `starts_with(upper(incident_key), 'TRADER_HALT:')` — not a
 * `LIKE`, whose `_` is a wildcard. No environment or account filter: an open
 * row in the trader's namespace is shown wherever it came from.
 *
 * ## It writes nothing
 *
 * The transaction is `READ ONLY`, so PostgreSQL itself refuses any write in
 * it; the statements are `select`s and one `set_config`, which is local to the
 * transaction. No `insertInto`, `updateTable` or `deleteFrom` appears in this
 * file. `test/integration/control-api/postgres/trader-halts-postgres.test.ts`
 * records every statement this source sends and holds them to that.
 *
 * ## It answers within its bound, whatever the database does
 *
 * - **A database that answers slowly** (a lock, an overloaded server): the
 *   transaction first sets its own `statement_timeout` to `timeoutMs`
 *   (`set_config(…, true)`), so the SERVER cancels a statement at the bound
 *   and the read fails — `UNAVAILABLE`, so the state is `UNKNOWN`.
 * - **A database that does not answer at all** (frozen, partitioned, or a
 *   connection that never opens): a timer of `timeoutMs` (unreferenced, so it
 *   never holds the process open) answers `UNAVAILABLE` at the bound. The
 *   abandoned statement's eventual outcome is swallowed; its connection is the
 *   pool's to end (`createPostgresPool`'s connection timeout and the server's
 *   own `statement_timeout`), and a later read takes another one. A server
 *   that froze mid-statement never ends it: at shutdown `main.ts` ends every
 *   connection the pool still holds once its bounded wait expires, and `pg`
 *   destroys the socket of one with a statement outstanding (`CTL2-L2`).
 *
 * Every failure is DATA (`{ fetched: false }`), never a throw: a control API
 * whose database is down keeps serving its controls, and says the halts are
 * unknown.
 *
 * ## No credential here
 *
 * The caller hands this source a `Kysely` handle, exactly as
 * `postgres-audit-sink.ts` is handed one: connection configuration is the
 * composition root's business, and this file reads no environment and names
 * no credential. It imports `@polymarket-bot/storage-postgres` for TYPES only:
 * the driver is `main.ts`'s to compose.
 *
 * ## Composed by the shipped process (`CONTROL-2` r1)
 *
 * Round 0 composed it nowhere, because the shipped bundle held no PostgreSQL
 * client. Since r1 `main.ts` composes it for `traderHalts.kind` `postgres`,
 * over a pool of its own built from the one URL variable
 * (`TRADER_HALTS_DATABASE_URL_ENV`), every failure detail redacted of that
 * URL; acceptance 3's shipped-artifact check admits the driver exactly
 * (`test/integration/control-api/support/driver-shims.ts`), and
 * `postgres/shipped-bundle-halts-postgres.test.ts` runs the SHIPPED bundle
 * against a real PostgreSQL.
 */

import type { PolymarketBotDatabase } from "@polymarket-bot/storage-postgres";

import {
  TRADER_HALT_INCIDENT_KEYS,
  TRADER_HALT_INCIDENT_KEY_PREFIX,
  TRADER_HALT_LIST_LIMIT,
  type TraderHaltFetch,
  type TraderHaltSource,
} from "../trader-halts.js";

/**
 * The longest bound a read may be given: a health read is not a report query.
 *
 * `CTL2-F1`: 5 s, below the API's answer deadline (`api.ts`,
 * `READ_REFRESH_DEADLINE_MS`, 8 s), which is itself below the control-api
 * scrape job's explicit `scrape_timeout` (10 s,
 * `infra/prometheus/control-api-scrape.yaml`). Until `CTL2-F1` it was 60 s, so a
 * read bound the configuration accepted could outlast the scrape: the scrape
 * was abandoned and the read's `UNKNOWN` never reached the page. Capped here,
 * a read that keeps its bound has settled before the answer is due.
 * `test/integration/control-api/trader-halt-shape.test.ts` pins the order of
 * the three.
 */
export const TRADER_HALT_READ_TIMEOUT_MAX_MS = 5_000;

/** The ISO-8601 UTC rendering the server applies to `opened_at` (microseconds, `Z`). */
const ISO_UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

export interface PostgresTraderHaltSourceOptions {
  readonly db: PolymarketBotDatabase;
  /**
   * The bound of one read, in milliseconds: the server cancels a statement at
   * it, and the read answers `UNAVAILABLE` at it whatever the server does.
   * An integer from 1 to {@link TRADER_HALT_READ_TIMEOUT_MAX_MS}.
   */
  readonly timeoutMs: number;
}

/** Why `timeoutMs` is not a bound this source runs with, or `undefined`. */
export function traderHaltReadTimeoutProblem(timeoutMs: number): string | undefined {
  return Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= TRADER_HALT_READ_TIMEOUT_MAX_MS
    ? undefined
    : `the trader halt read bound must be an integer from 1 to ${String(TRADER_HALT_READ_TIMEOUT_MAX_MS)} ms`;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

export class PostgresTraderHaltSource implements TraderHaltSource {
  readonly configured = true;
  readonly #db: PolymarketBotDatabase;
  readonly #timeoutMs: number;

  constructor(options: PostgresTraderHaltSourceOptions) {
    const problem = traderHaltReadTimeoutProblem(options.timeoutMs);
    if (problem !== undefined) throw new RangeError(problem);
    this.#db = options.db;
    this.#timeoutMs = options.timeoutMs;
  }

  /** The bound of one read, in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  fetch(): Promise<TraderHaltFetch> {
    const timeoutMs = this.#timeoutMs;
    const work: Promise<TraderHaltFetch> = this.#read().then(
      (result): TraderHaltFetch => ({ fetched: true, result }),
      (cause: unknown): TraderHaltFetch => ({
        fetched: false,
        detail: `ops.incidents could not be read: ${describeCause(cause)}`,
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<TraderHaltFetch>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          fetched: false,
          detail: `ops.incidents did not answer within ${String(timeoutMs)} ms`,
        });
      }, timeoutMs);
      timer.unref();
    });
    return Promise.race([work, expired]).finally(() => {
      clearTimeout(timer);
    });
  }

  async #read(): Promise<{ readonly counts: readonly unknown[]; readonly rows: readonly unknown[] }> {
    const timeoutMs = this.#timeoutMs;
    return await this.#db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (trx) => {
        // The server's own bound, local to this transaction (module header).
        await trx
          .selectNoFrom((eb) =>
            eb.fn<string>("set_config", [eb.val("statement_timeout"), eb.val(String(timeoutMs)), eb.val(true)]).as("bound"),
          )
          .execute();

        const counts = await trx
          .selectFrom("ops.incidents")
          .where((eb) =>
            eb.and([
              eb.fn<boolean>("starts_with", [eb.fn<string>("upper", [eb.ref("incident_key")]), eb.val(TRADER_HALT_INCIDENT_KEY_PREFIX)]),
              eb("status", "<>", "RESOLVED"),
            ]),
          )
          .select((eb) => [
            eb.cast<string>(eb.fn.countAll(), "text").as("total"),
            eb.cast<string>(eb.fn.countAll().filterWhere("incident_key", "=", TRADER_HALT_INCIDENT_KEYS.GLOBAL), "text").as("global"),
            eb.cast<string>(eb.fn.countAll().filterWhere("incident_key", "=", TRADER_HALT_INCIDENT_KEYS.MARKET), "text").as("market"),
            eb
              .cast<string>(eb.fn.countAll().filterWhere("incident_key", "=", TRADER_HALT_INCIDENT_KEYS.STRATEGY_INSTANCE), "text")
              .as("strategy_instance"),
          ])
          .execute();

        const rows = await trx
          .selectFrom("ops.incidents")
          .where((eb) =>
            eb.and([
              eb.fn<boolean>("starts_with", [eb.fn<string>("upper", [eb.ref("incident_key")]), eb.val(TRADER_HALT_INCIDENT_KEY_PREFIX)]),
              eb("status", "<>", "RESOLVED"),
            ]),
          )
          .select((eb) => [
            eb.cast<string>("incident_id", "text").as("incident_id"),
            eb.cast<string>("incident_key", "text").as("incident_key"),
            eb.cast<string>("environment", "text").as("environment"),
            eb.cast<string | null>("account_ref", "text").as("account_ref"),
            eb.cast<string>("severity", "text").as("severity"),
            eb.cast<string>("status", "text").as("status"),
            eb.cast<string>("failure_class", "text").as("failure_class"),
            eb.cast<string | null>("action", "text").as("action"),
            eb.cast<string | null>("market_id", "text").as("market_id"),
            eb.cast<string | null>("instance_id", "text").as("instance_id"),
            eb.cast<string>("detail", "text").as("detail"),
            eb
              .fn<string>("to_char", [eb.fn("timezone", [eb.val("UTC"), eb.ref("opened_at")]), eb.val(ISO_UTC_FORMAT)])
              .as("opened_at"),
          ])
          // The TABLE's columns, qualified: a bare name would order by the
          // text renderings selected above.
          .orderBy("ops.incidents.opened_at", "desc")
          .orderBy("ops.incidents.incident_id", "desc")
          .limit(TRADER_HALT_LIST_LIMIT)
          .execute();

        return { counts, rows };
      });
  }
}
