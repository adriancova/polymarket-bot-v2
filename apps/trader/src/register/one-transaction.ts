/**
 * ONE connection, ONE transaction, and every `WP-040` repository call inside it
 * (`REGISTER-1`).
 *
 * ## Why the registration command needs this
 *
 * The operator's registration act is five repository calls —
 * `registerMarket`, `createDefinition`, `createConfig`, `createInstance`,
 * `startRun` — and two of them open a transaction of their own
 * (`inTransaction(db, …)` in `packages/storage-postgres/src/repositories/
 * catalog.ts` and `strategy.ts`). Handed a plain database handle, each call
 * therefore COMMITS on its own, and a failure at the fourth call leaves the
 * first three behind. Three of the tables those calls write are APPEND-ONLY
 * (`strategy.definitions`, `strategy.configs`,
 * `catalog.market_parameter_history`: `internal.enforce_append_only` forbids
 * UPDATE, DELETE and TRUNCATE), so such a partial registration could never be
 * cleaned up — only lived with. And the natural keys a re-run is refused on
 * (`condition_id`, the token ids, the PAPER instance name) would then block
 * the retry.
 *
 * Kysely cannot nest: `Transaction.transaction()` throws ("calling the
 * transaction method for a Transaction is not supported"), so the repositories
 * cannot simply be handed a transaction. They are handed, instead, a database
 * handle over ONE pinned connection on which the outer transaction is already
 * open, and whose transaction-control statements are rewritten one to one:
 *
 * | the repository's Kysely sends | the connection runs |
 * | --- | --- |
 * | `begin` | `savepoint register_repository_call` |
 * | `commit` | `release savepoint register_repository_call` |
 * | `rollback` | `rollback to savepoint register_repository_call` |
 *
 * so each repository transaction becomes a SAVEPOINT of the one outer
 * transaction, and only {@link OneTransaction.commit} commits anything. Any
 * OTHER transaction-control statement (`start transaction …`, `end`, `abort`,
 * a named `savepoint`/`release`, `prepare transaction`) is REFUSED rather than
 * forwarded — a statement this module did not anticipate would otherwise end
 * the outer transaction silently, which is the one failure this module exists
 * to rule out. It fails closed: the registration errors and rolls back.
 *
 * `DEFERRABLE INITIALLY DEFERRED` constraints (`markets_current_parameters_fk`)
 * are checked at the OUTER commit, which is where a savepoint release defers
 * them to: a violation there rolls the whole registration back.
 *
 * ## What is and is not rewritten
 *
 * Only the text of statements sent through the pinned handle. The outer
 * `begin`/`commit`/`rollback` below go to the REAL client. Kysely's
 * `PostgresDriver` (0.29) sends exactly `begin`, `commit` and `rollback` for a
 * transaction without isolation settings, and the repositories set none; the
 * register integration test pins the consequence end to end (a failure at the
 * LAST repository call leaves every table at zero rows).
 *
 * No type assertion is used (`test/unit/trader/query-boundary-cast-scan.test.ts`
 * scans this directory): the two handles are `Proxy` objects of their targets'
 * own types.
 */

import {
  createDatabase,
  createPostgresPool,
  type PolymarketBotDatabase,
} from "@polymarket-bot/storage-postgres";

/** The one savepoint name every repository-level transaction is mapped onto. */
export const REPOSITORY_SAVEPOINT = "register_repository_call";

/** Transaction control a repository's Kysely sends → what the pinned connection runs. */
const INNER_TRANSACTION_CONTROL: ReadonlyMap<string, string> = new Map([
  ["begin", `savepoint ${REPOSITORY_SAVEPOINT}`],
  ["commit", `release savepoint ${REPOSITORY_SAVEPOINT}`],
  ["rollback", `rollback to savepoint ${REPOSITORY_SAVEPOINT}`],
]);

/**
 * Any statement that begins, ends or subdivides a transaction. Matched AFTER the
 * three rewrites above, so what reaches it is a control statement this module
 * did not anticipate — refused.
 */
const ANY_TRANSACTION_CONTROL =
  /^\s*(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare)\b/iu;

/** A statement the pinned handle refused to forward (fail closed). */
export class OneTransactionViolation extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "OneTransactionViolation";
  }
}

export interface OneTransaction {
  /**
   * The handle to give the repositories. Every statement it sends runs on the
   * one connection, inside the one transaction.
   */
  readonly db: PolymarketBotDatabase;
  /** Commits the outer transaction: the only commit this module issues. */
  commit(): Promise<void>;
  /**
   * Rolls the outer transaction back. A no-op once it was committed or rolled
   * back.
   */
  rollback(): Promise<void>;
  /**
   * Destroys the connection and ends the pool. An uncommitted transaction dies
   * with its session, so a failed rollback cannot leave rows behind. Idempotent.
   */
  close(): Promise<void>;
}

export interface OpenOneTransactionOptions {
  /** `DATABASE_URL`. Never logged. */
  readonly connectionString: string;
  /** Reported to `pg_stat_activity`, so the session is attributable. */
  readonly applicationName: string;
}

/**
 * Connects, opens the outer transaction and returns the pinned handle. Rejects
 * with the driver's own error when the database cannot be reached, having
 * released what it opened.
 */
export async function openOneTransaction(
  options: OpenOneTransactionOptions,
): Promise<OneTransaction> {
  const pool = createPostgresPool({
    connectionString: options.connectionString,
    maxConnections: 1,
    applicationName: options.applicationName,
  });
  let client: Awaited<ReturnType<typeof connectTo>>;
  try {
    client = await connectTo(pool);
  } catch (cause) {
    await pool.end();
    throw cause;
  }
  // A checked-out `pg` client whose connection ends unexpectedly EMITS `error`
  // (`pg` `Client`'s `end` handler), and `pg-pool` removes its own idle listener
  // on acquire — so with no listener here that event is an uncaught exception,
  // and the process dies before the rollback, the cleanup and the report. The
  // same failure also rejects the statement in flight (or the next one), which
  // is where the registration hears it; this listener only keeps the event
  // from killing the process. Pinned by the register integration test's
  // connection-cut scenarios.
  client.on("error", () => {
    // Heard through the rejected statement.
  });
  try {
    await client.query("begin");
  } catch (cause) {
    client.release(true);
    await pool.end();
    throw cause;
  }

  let state: "OPEN" | "COMMITTED" | "ROLLED_BACK" | "FAILED" = "OPEN";
  let closed = false;
  const db = createDatabase(pinnedPool(pool, client));

  return {
    db,
    async commit() {
      if (state !== "OPEN") {
        throw new OneTransactionViolation(`commit requested on a transaction that is ${state}`);
      }
      try {
        await client.query("commit");
        state = "COMMITTED";
      } catch (cause) {
        // PostgreSQL ends the transaction whatever a failed COMMIT answered; a
        // connection that died mid-COMMIT leaves the outcome to the server.
        state = "FAILED";
        throw cause;
      }
    },
    async rollback() {
      if (state !== "OPEN") return;
      state = "ROLLED_BACK";
      await client.query("rollback");
    },
    async close() {
      if (closed) return;
      closed = true;
      // `true` destroys the connection rather than returning it to the pool:
      // the pool ends next, and a session that ends discards any transaction
      // it still holds open.
      client.release(true);
      await pool.end();
    },
  };
}

/** `pool.connect()`, named so its client type can be spelled without importing `pg`. */
async function connectTo(pool: ReturnType<typeof createPostgresPool>) {
  return await pool.connect();
}

/**
 * The pool Kysely is given: every `connect()` answers the ONE pinned client,
 * and `end()` is left to {@link OneTransaction.close}.
 */
function pinnedPool<P extends object, C extends object>(pool: P, client: C): P {
  const pinned = pinnedClient(client);
  const connect = async (): Promise<C> => pinned;
  const end = async (): Promise<void> => {
    // Owned by `OneTransaction.close`.
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") return connect;
      if (property === "end") return end;
      return ownMember(target, property);
    },
  });
}

/**
 * The client Kysely is given: `query` rewrites a repository's transaction
 * control onto the savepoint, and `release` is left to
 * {@link OneTransaction.close}.
 */
function pinnedClient<C extends object>(client: C): C {
  const release = (): void => {
    // Owned by `OneTransaction.close`.
  };
  const query = (...args: readonly unknown[]): unknown => forwardQuery(client, args);
  return new Proxy(client, {
    get(target, property) {
      if (property === "query") return query;
      if (property === "release") return release;
      return ownMember(target, property);
    },
  });
}

/** A member of `target`, with a method bound to `target` itself. */
function ownMember(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function forwardQuery(client: object, args: readonly unknown[]): unknown {
  const query: unknown = Reflect.get(client, "query", client);
  if (typeof query !== "function") {
    return Promise.reject(new OneTransactionViolation("the pinned client has no query method"));
  }
  const [text, ...rest] = args;
  if (typeof text !== "string") {
    // Kysely sends SQL text. Anything else (a query config, a cursor) could
    // carry transaction control this module cannot read, so it is refused.
    return Promise.reject(
      new OneTransactionViolation(
        "the registration transaction forwards SQL text only; a non-text query was refused",
      ),
    );
  }
  const mapped = mapStatement(text);
  if (mapped.kind === "SAVEPOINT") return Reflect.apply(query, client, [mapped.statement]);
  if (mapped.kind === "REFUSE") return Promise.reject(new OneTransactionViolation(mapped.detail));
  return Reflect.apply(query, client, [text, ...rest]);
}

/** What the pinned connection does with one statement's text. */
export type MappedStatement =
  | { readonly kind: "FORWARD" }
  | { readonly kind: "SAVEPOINT"; readonly statement: string }
  | { readonly kind: "REFUSE"; readonly detail: string };

/**
 * The rewrite rule, as a pure function: a repository's plain
 * `begin`/`commit`/`rollback` becomes the savepoint's statement, any OTHER
 * transaction control is refused, and everything else is forwarded unchanged.
 */
export function mapStatement(text: string): MappedStatement {
  const inner = INNER_TRANSACTION_CONTROL.get(text.trim().toLowerCase());
  if (inner !== undefined) return { kind: "SAVEPOINT", statement: inner };
  if (ANY_TRANSACTION_CONTROL.test(text)) {
    return {
      kind: "REFUSE",
      detail:
        `refused ${JSON.stringify(text.trim().slice(0, 80))} inside the registration transaction: ` +
        "only a repository's plain begin/commit/rollback is mapped onto the savepoint, and " +
        "forwarding any other transaction control could end the outer transaction early",
    };
  }
  return { kind: "FORWARD" };
}
