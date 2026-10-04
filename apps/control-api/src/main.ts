/**
 * The control API's process entry point.
 *
 * This is the ONLY file in the package that touches `process` — the
 * environment, the exit code, the signal handlers, the clock — which is what
 * makes every other module a pure function of its arguments and keeps
 * `safety.ts` a pure function of a record.
 *
 * ## The startup sequence, and why nothing may move ahead of step 1
 *
 * ```text
 * 1. checkControlApiSafety(env)      ← §6 invariant 17, §15, ADR-010
 * 2. read and parse the configuration ← ADR-020 D1-D4, §15 loopback
 *    and the trader-halt database URL ← CONTROL-2 r1: one variable, read once, never printed
 * 3. construct the audit sink         ← in-memory, behind the audit budget
 * 4. construct the control plane      ← audits before it applies
 * 5. bind loopback and serve
 * ```
 *
 * Step 1 runs on the ENVIRONMENT RECORD before a configuration file is opened
 * and before a socket exists.
 *
 * ## `--check` exits after step 2
 *
 * A deployment can validate its environment and configuration without binding
 * anything. It is also how the build is smoke-tested: `node dist/main.mjs
 * --check` proves the bundle loads and the whole module graph resolves, with no
 * port bound and no database reached.
 *
 * ## Safety, restated where an operator will read it
 *
 * There is no signer here, no venue client, no order path and no wallet
 * operation. `safety.ts` refuses to start under a raised `MAX_RUN_MODE`, under
 * a run mode that would need a signer, or in an environment that so much as
 * references a production secret NAME. `config.ts` refuses a bind host that is
 * not loopback (§15). No route can raise a run mode, because no route names
 * one.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ControlAuditSink } from "@polymarket-bot/observability";
import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";

import { PostgresTraderHaltSource } from "./adapters/postgres-trader-halts.js";
import { ControlApi, type ApiEnvironment } from "./api.js";
import { createBudgetedAuditLog } from "./audit-budget.js";
import { OperatorRegistry } from "./auth.js";
import { ControlPlane, type AuditRecordSource } from "./control-plane.js";
import { parseControlApiConfig, type ControlApiConfig } from "./config.js";
import {
  AbsentTraderHealthSource,
  HttpTraderHealthSource,
  TraderHealthCache,
  type TraderHealthSource,
} from "./health-source.js";
import { startControlHttpServer } from "./http.js";
import {
  CONTROL_API_RUN_MODE,
  REPOSITORY_MAXIMUM_RUN_MODE,
  checkControlApiSafety,
} from "./safety.js";
import {
  AbsentTraderHaltSource,
  TraderHaltCache,
  type TraderHaltFetch,
  type TraderHaltSource,
} from "./trader-halts.js";

/**
 * `CONTROL-2` r1 — the ONE environment variable the trader-halt database URL
 * comes from (`traderHalts.kind` `postgres`).
 *
 * The URL carries a credential, so it is not a configuration field: it is
 * read from the environment ONCE, in {@link startup}, and handed to the pool.
 * It is never logged, never part of a refusal, and never echoed in a health
 * answer — a driver error that held it, or its password, would reach both
 * with them replaced by `<redacted>` ({@link redactDatabaseUrl}). The role it
 * names needs `USAGE` on the schema `ops` and `SELECT` on `ops.incidents`, and
 * nothing else (README, "Open trader halts"); without them every read is
 * `UNKNOWN`.
 *
 * ONE variable is all the driver reads. `pg`, like libpq, fills a component
 * the URL omits from the `PG*` environment variables (`PGPASSWORD`,
 * `PGHOST`, `PGSSLMODE`, …), from the password file (`~/.pgpass`, or
 * `PGPASSFILE`) and from `USER`; so the URL must name a user, a password, a
 * host and a database ({@link planTraderHalts}), and a `PG*` variable in the
 * environment refuses the start.
 *
 * And the URL's AUTHORITY is its one source (`CONTROL2-R1-C2`). The driver's
 * parser (`pg-connection-string`) copies every query parameter into the
 * connection parameters FIRST, and takes the user, password, host and port
 * before the `@` only where the query named none; and the driver lets the URL's
 * parameters override the pool's own (`options`, which carries the session's
 * `statement_timeout`, and `application_name`). A `?password=` would therefore
 * be the password the driver sends, while {@link redactDatabaseUrl} redacts
 * the authority's. So the only query parameter admitted is one `sslmode` with
 * a value from {@link TRADER_HALTS_URL_SSLMODES}; any other refuses the start.
 */
export const TRADER_HALTS_DATABASE_URL_ENV = "CONTROL_API_TRADER_HALTS_DATABASE_URL";

/**
 * `CONTROL2-R1-C2`: the values the one admitted query parameter, `sslmode`, may
 * take — no TLS (a loopback database), or TLS with the server's certificate
 * and name verified. Neither reads a file or names a credential; `sslcert`,
 * `sslkey`, `sslrootcert` and every other parameter are refused. The driver's
 * other modes are refused too: it treats `prefer`, `require` and `verify-ca`
 * as aliases of `verify-full` and warns that its next major version weakens
 * them, and `no-verify` would send the URL's password to a server whose
 * certificate nobody checked.
 */
export const TRADER_HALTS_URL_SSLMODES: readonly string[] = Object.freeze(["disable", "verify-full"]);

/** libpq's environment namespace, which `pg` reads for every parameter the URL omits. */
const LIBPQ_VARIABLE = /^PG[A-Z]/u;

/** The names of the `PG*` variables `env` sets to a non-empty value, sorted — never their values. */
export function libpqVariablesIn(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return Object.keys(env)
    .filter((name) => LIBPQ_VARIABLE.test(name) && (env[name] ?? "") !== "")
    .sort();
}

/**
 * Why a `traderHalts.kind` `none` deployment reads no `ops.incidents`, for its
 * log and its health answer: the state is `NOT_CONFIGURED`, never "no halts".
 */
export const TRADER_HALTS_NOT_CONFIGURED =
  "traderHalts.kind is none, so this process reads no open TRADER_HALT rows from ops.incidents; " +
  "read them there directly (status not RESOLVED), or configure traderHalts.kind postgres";

/** What the reader's sessions are called in `pg_stat_activity`, so a stuck read is attributable. */
export const TRADER_HALTS_APPLICATION_NAME = "polymarket-bot-control-api";

/**
 * Connections the reader's pool may hold. Reads are single-flight (`api.ts`),
 * so one is in use at a time; the second lets a read proceed while a read
 * that missed its bound still holds the first, until the server's own
 * `statement_timeout` (the same bound) ends it.
 */
export const TRADER_HALTS_POOL_MAX = 2;

/** How long a shutdown waits for the reader's pool to close before it ENDS the connections the pool still holds. */
export const TRADER_HALTS_CLOSE_WAIT_MS = 5_000;

/**
 * `CTL2-L2`: how long a shutdown waits, after ending those connections, before
 * it stops waiting and reports the stop as failed. The process then exits
 * either way, through the `exit` port (`StartupPorts`).
 */
export const TRADER_HALTS_TERMINATE_WAIT_MS = 1_000;

const REDACTED = "<redacted>";

/**
 * `text` with every occurrence of the database URL `url`, and of its password
 * as written and percent-decoded, replaced by `<redacted>` (longest first).
 * Applied to every driver text that can reach a log line or a health answer.
 * TOTAL.
 */
export function redactDatabaseUrl(text: string, url: string): string {
  const secrets = new Set<string>([url]);
  try {
    const password = new URL(url).password;
    if (password !== "") {
      secrets.add(password);
      try {
        secrets.add(decodeURIComponent(password));
      } catch {
        // A password that is not valid percent-encoding is redacted as written.
      }
    }
  } catch {
    // A URL that does not parse is refused at startup, before any read.
  }
  let redacted = text;
  for (const secret of [...secrets].filter((value) => value !== "").sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/**
 * What a configuration and the one database-URL variable decide about the
 * trader-halt source: a plan, or a refusal that names the variable and never
 * its value. TOTAL.
 */
export type TraderHaltsPlan =
  | { readonly ok: true; readonly kind: "none" }
  | { readonly ok: true; readonly kind: "postgres"; readonly url: string; readonly timeoutMs: number }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export function planTraderHalts(
  config: ControlApiConfig["traderHalts"],
  url: string | undefined,
  libpqVariables: readonly string[] = [],
): TraderHaltsPlan {
  const given = url !== undefined && url !== "";
  if (config.kind === "none") {
    return given
      ? {
          ok: false,
          code: "CONTROL_TRADER_HALTS_URL_UNUSED",
          detail:
            `${TRADER_HALTS_DATABASE_URL_ENV} is set, but traderHalts.kind is none, so this process would read no ` +
            "open trader halts while its environment says it should; set traderHalts.kind to postgres, or unset the " +
            "variable (its value is not printed)",
        }
      : { ok: true, kind: "none" };
  }
  if (!given) {
    return {
      ok: false,
      code: "CONTROL_TRADER_HALTS_URL_MISSING",
      detail:
        `traderHalts.kind is postgres, and ${TRADER_HALTS_DATABASE_URL_ENV} names no database: there is no default, ` +
        "because which database holds the trader's ops.incidents is a deployment decision",
    };
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")) {
    return {
      ok: false,
      code: "CONTROL_TRADER_HALTS_URL_INVALID",
      detail:
        `${TRADER_HALTS_DATABASE_URL_ENV} is not a postgres:// or postgresql:// URL (its value is not printed: it ` +
        "may carry a credential)",
    };
  }
  // `CONTROL2-R1-C2`: the authority is the one source; the query may say one sslmode and nothing else.
  const keys = [...parsed.searchParams.keys()];
  const sslmodes = parsed.searchParams.getAll("sslmode");
  if (
    keys.some((key) => key !== "sslmode") ||
    sslmodes.length > 1 ||
    sslmodes.some((mode) => !TRADER_HALTS_URL_SSLMODES.includes(mode))
  ) {
    return {
      ok: false,
      code: "CONTROL_TRADER_HALTS_URL_PARAMETERS",
      detail:
        `${TRADER_HALTS_DATABASE_URL_ENV} carries a query parameter other than one sslmode ` +
        `(${TRADER_HALTS_URL_SSLMODES.join(", ")}); its keys and values are not printed. The PostgreSQL driver reads ` +
        "every query parameter as a connection parameter, and one there replaces the URL's own (a password, user or " +
        "host given in the query overrides the one before the @, and options or application_name the session's), so " +
        "put the credential and the host in the URL's authority and nothing else in its query",
    };
  }
  const missing = [
    ...(parsed.username === "" ? ["user"] : []),
    ...(parsed.password === "" ? ["password"] : []),
    ...(parsed.hostname === "" ? ["host"] : []),
    ...(parsed.pathname === "" || parsed.pathname === "/" ? ["database"] : []),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      code: "CONTROL_TRADER_HALTS_URL_INCOMPLETE",
      detail:
        `${TRADER_HALTS_DATABASE_URL_ENV} names no ${missing.join(", no ")} (its value is not printed): the driver would ` +
        "fill what the URL omits from the PG* environment variables, the password file or the process user, and the " +
        "URL is to be the one source of the connection",
    };
  }
  if (libpqVariables.length > 0) {
    return {
      ok: false,
      code: "CONTROL_TRADER_HALTS_LIBPQ_ENVIRONMENT",
      detail:
        `the environment sets ${libpqVariables.join(", ")} (values not printed), which the PostgreSQL driver reads as ` +
        `connection parameters beside ${TRADER_HALTS_DATABASE_URL_ENV}; put what they say in the URL and unset them`,
    };
  }
  return { ok: true, kind: "postgres", url, timeoutMs: config.timeoutMs };
}

/** The composed trader-halt read: the cache the API reads, and how to release what it holds. */
interface ComposedTraderHalts {
  readonly cache: TraderHaltCache;
  readonly close: () => Promise<void>;
  /**
   * `CTL2-L2`: ends every connection the pool still holds — `pg` destroys the
   * socket of one with a statement outstanding, which a frozen server would
   * otherwise hold open, and with it `close` and the process — and returns how
   * many it ended.
   */
  readonly terminate: () => number;
}

/**
 * Composes the plan (`CONTROL-2` r1). `none`: an `AbsentTraderHaltSource`,
 * `NOT_CONFIGURED`. `postgres`: the PostgreSQL source over a pool of its own —
 * the session bounded by the read's own bound, every driver text redacted, and
 * a connection that fails while idle or between statements logged (redacted)
 * and dropped rather than left to crash the process as an unhandled `error`
 * event.
 */
function composeTraderHalts(plan: Extract<TraderHaltsPlan, { ok: true }>, log: (line: string) => void): ComposedTraderHalts {
  if (plan.kind === "none") {
    return {
      cache: new TraderHaltCache(new AbsentTraderHaltSource(TRADER_HALTS_NOT_CONFIGURED)),
      close: () => Promise.resolve(),
      terminate: () => 0,
    };
  }
  const { url, timeoutMs } = plan;
  const pool = createPostgresPool({
    connectionString: url,
    maxConnections: TRADER_HALTS_POOL_MAX,
    statementTimeoutMs: timeoutMs,
    connectionTimeoutMs: timeoutMs,
    applicationName: TRADER_HALTS_APPLICATION_NAME,
  });
  pool.on("error", (cause: unknown) => {
    log(
      `trader halts: an idle ops.incidents connection failed and was dropped (${redactDatabaseUrl(describeCause(cause), url)}); ` +
        "the next read opens another",
    );
  });
  // A connection that fails while a read holds it, between two statements, is
  // that read's failure (UNKNOWN); without a listener of its own its `error`
  // event would be unhandled. `CTL2-L2`: every connection is also held here
  // until the pool removes it, so a shutdown can end one a frozen server holds.
  const held = new Set<{ end(): Promise<void> }>();
  pool.on("connect", (client) => {
    held.add(client);
    client.on("error", () => undefined);
  });
  pool.on("remove", (client) => {
    held.delete(client);
  });
  const db = createDatabase(pool);
  const source = new PostgresTraderHaltSource({ db, timeoutMs });
  const redacting: TraderHaltSource = {
    configured: true,
    fetch: async (): Promise<TraderHaltFetch> => {
      try {
        const fetched = await source.fetch();
        return fetched.fetched ? fetched : { fetched: false, detail: redactDatabaseUrl(fetched.detail, url) };
      } catch (cause) {
        return { fetched: false, detail: redactDatabaseUrl(`the trader halt source threw (contained): ${describeCause(cause)}`, url) };
      }
    },
  };
  return {
    cache: new TraderHaltCache(redacting),
    close: () => db.destroy(),
    terminate: () => {
      const ending = [...held];
      for (const client of ending) {
        client.end().catch(() => undefined);
      }
      return ending.length;
    },
  };
}

/** `work`, or `false` once `ms` have passed without it settling (the timer is unreferenced). */
function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref();
  });
  return Promise.race([work.then(() => true), expired]).finally(() => {
    clearTimeout(timer);
  });
}

/** What a signal's shutdown closes, logs and exits through (`CTL2-L2`; {@link shutdownControlApi}). */
export interface ShutdownSteps {
  readonly closeServer: () => Promise<void>;
  /** Closes the trader-halt pool; may never settle while a frozen server holds a connection. */
  readonly closeHalts: () => Promise<void>;
  /** Ends every connection the pool still holds, and says how many. */
  readonly terminateHalts: () => number;
  readonly log: (line: string) => void;
  /** Every text from a cause passes through it before it is logged (the database URL redacted). */
  readonly redact: (text: string) => string;
  /** `StartupPorts.exit`; absent, nothing is told to exit. */
  readonly exit?: (code: number) => void;
  /** Defaults to {@link TRADER_HALTS_CLOSE_WAIT_MS}; a suite passes a shorter one. */
  readonly closeWaitMs?: number;
  /** Defaults to {@link TRADER_HALTS_TERMINATE_WAIT_MS}; a suite passes a shorter one. */
  readonly terminateWaitMs?: number;
}

/**
 * A signal's shutdown (`CTL2-L2`), in order: close the server; close the
 * trader-halt pool — whatever the server did — bounded by `closeWaitMs`; at
 * that bound END the connections the pool still holds (`pg` destroys the
 * socket of one with a statement outstanding: a frozen server's) and give the
 * pool `terminateWaitMs` more; log `control API stopped.` or `control API stop
 * failed: …` (redacted); then tell the process to exit — 0, or
 * {@link EXIT_CODES.stopFailed} — so nothing still referenced keeps it alive.
 * Returns that code. Never rejects.
 */
export async function shutdownControlApi(steps: ShutdownSteps): Promise<number> {
  const closeWaitMs = steps.closeWaitMs ?? TRADER_HALTS_CLOSE_WAIT_MS;
  const terminateWaitMs = steps.terminateWaitMs ?? TRADER_HALTS_TERMINATE_WAIT_MS;
  let failure: unknown;
  try {
    await steps.closeServer();
  } catch (cause) {
    failure = cause;
  }
  // `CONTROL-2` r1: the reader's pool, whatever the server did, and bounded —
  // a connection a frozen server still holds must not hold the shutdown with
  // it. `CTL2-L2`: at the bound the pool's connections are ENDED, and the pool
  // gets one more, shorter, bound to close.
  const closing = Promise.resolve()
    .then(() => steps.closeHalts())
    .catch((cause: unknown) => {
      failure ??= cause;
    });
  let closed = await settlesWithin(closing, closeWaitMs);
  if (!closed) {
    let ended = 0;
    try {
      ended = steps.terminateHalts();
    } catch (cause) {
      failure ??= cause;
    }
    steps.log(
      `trader halts: the ops.incidents pool did not close within ${String(closeWaitMs)}ms; ` +
        `ending the ${String(ended)} connection(s) it still holds`,
    );
    closed = await settlesWithin(closing, terminateWaitMs);
    if (!closed) {
      failure ??= new Error(`the ops.incidents pool did not close within ${String(terminateWaitMs)}ms of ending its connections`);
    }
  }
  const code = failure === undefined ? EXIT_CODES.ok : EXIT_CODES.stopFailed;
  steps.log(failure === undefined ? "control API stopped." : `control API stop failed: ${steps.redact(describeCause(failure))}`);
  // `CTL2-L2`: the process ENDS here, whatever is still referenced.
  steps.exit?.(code);
  return code;
}

/** What the process exits with, so an operator can script against it. */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  /** The environment is unsafe (§6 invariant 17, §15, ADR-010). */
  unsafeEnvironment: 78,
  /** The configuration was refused. */
  configurationRefused: 78,
  /**
   * `CTL2-L2`: a signal's shutdown could not close what it holds — the
   * server's close failed, or the trader-halt pool did not close even after
   * its connections were ended. The process exits all the same.
   */
  stopFailed: 1,
});

export interface StartupPorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly readConfig: (path: string) => Promise<string>;
  readonly log: (line: string) => void;
  /**
   * `CTL2-L2`: ends the process once a signal's shutdown has run — `0`, or
   * {@link EXIT_CODES.stopFailed} — so nothing still referenced (a connection
   * a frozen database holds, a trader health read still within its bound) can
   * keep a stopped process alive. The shipped process passes `process.exit`;
   * a suite that runs `startup()` in its own process passes a spy or nothing.
   */
  readonly exit?: (code: number) => void;
}

/**
 * The process clock and id source.
 *
 * `randomUUID` is a v4 UUID and §10.7 asks for a sortable v7. The in-memory
 * sink does not care; the PostgreSQL sink writes into an `internal.uuid_v7`
 * domain that WILL refuse a v4, and that is recorded rather than papered over:
 * `packages/storage-postgres` exports `uuidV7()` and the composition that binds
 * the durable sink uses it. This default exists so a deployment with no
 * database still gets unique record ids.
 */
function processEnvironment(): ApiEnvironment {
  return {
    now: () => new Date().toISOString(),
    nextAuditRecordId: () => randomUUID(),
  };
}

/**
 * The control plane the shipped process composes (`CONTROL-1b`): writing
 * through `sink`, at PAPER, with the default append bound
 * (`AUDIT_APPEND_TIMEOUT_MS`), and with every VOID record's instant and id
 * drawn from `environment` (`control-plane.ts`, "An append is bounded").
 *
 * Exported so `main.test.ts` can prove that wiring with a sink that answers
 * LATE: the shipped in-memory log answers at once, so the late path cannot be
 * reached through `startup` itself, and a durable sink bound here later
 * inherits exactly what that test pins.
 */
export function composeControlPlane(sink: ControlAuditSink, environment: AuditRecordSource): ControlPlane {
  return new ControlPlane({
    audit: sink,
    runMode: CONTROL_API_RUN_MODE,
    maximumRunMode: CONTROL_API_RUN_MODE,
    repositoryMaximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE,
    auditRecordSource: environment,
  });
}

function healthSourceFor(config: ControlApiConfig): TraderHealthSource {
  if (config.traderHealth.kind === "none") return new AbsentTraderHealthSource();
  return new HttpTraderHealthSource({
    url: config.traderHealth.url,
    timeoutMs: config.traderHealth.timeoutMs,
    maxBodyBytes: 4_194_304,
  });
}

/**
 * Validates the environment and configuration, and optionally serves.
 *
 * TOTAL with respect to its ports: it returns an exit code and never throws for
 * an operator error.
 */
export async function startup(
  ports: StartupPorts,
  options: { readonly serve: boolean },
): Promise<number> {
  const safety = checkControlApiSafety(ports.env);
  if (!safety.ok) {
    ports.log("REFUSING TO START — the environment is not a safe PAPER environment:");
    for (const violation of safety.violations) {
      ports.log(`  [${violation.code}] ${violation.detail}`);
    }
    return EXIT_CODES.unsafeEnvironment;
  }

  const configPath = ports.env["CONTROL_API_CONFIG"];
  if (configPath === undefined || configPath === "") {
    ports.log(
      "REFUSING TO START — CONTROL_API_CONFIG names no configuration file. There is no default " +
        "configuration: a bind host, an audit bound and an operator set are decisions, not values " +
        "this process may choose for a deployment.",
    );
    return EXIT_CODES.configurationRefused;
  }

  let document: unknown;
  try {
    document = JSON.parse(await ports.readConfig(configPath));
  } catch (cause) {
    ports.log(
      `REFUSING TO START — ${configPath} could not be read as JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return EXIT_CODES.configurationRefused;
  }

  const parsed = parseControlApiConfig(document);
  if (!parsed.ok) {
    ports.log(`REFUSING TO START — ${configPath} was refused:`);
    for (const refusal of parsed.refusals) {
      ports.log(`  [${refusal.code}] ${refusal.detail}`);
      for (const issue of refusal.issues) ports.log(`      ${issue}`);
    }
    return EXIT_CODES.configurationRefused;
  }
  const config = parsed.config;

  // `CONTROL-2` r1: the trader-halt database URL — the one read of the one
  // variable (`TRADER_HALTS_DATABASE_URL_ENV`). Its value is never printed.
  const haltsPlan = planTraderHalts(config.traderHalts, ports.env[TRADER_HALTS_DATABASE_URL_ENV], libpqVariablesIn(ports.env));
  if (!haltsPlan.ok) {
    ports.log(`REFUSING TO START — [${haltsPlan.code}] ${haltsPlan.detail}`);
    return EXIT_CODES.configurationRefused;
  }

  ports.log(
    `control API configuration accepted: ${String(config.operators.length)} operator(s), ` +
      `audit bound ${String(config.auditCapacity)} (the last ${String(config.auditSafetyReserve)} ` +
      `for kill-switch engages, the ${String(config.auditSafetyReserve)} before them for ` +
      `safety-direction actions), trader health source ${config.traderHealth.kind}, trader halt source ` +
      config.traderHalts.kind,
  );

  if (!options.serve) {
    ports.log("--check: environment and configuration are valid; nothing was bound.");
    return EXIT_CODES.ok;
  }

  const environment = processEnvironment();
  // `CONTROL-1` (closing `WP-240` r1 M-3): the log sits behind the audit budget,
  // so only a halt can use the capacity a halt needs (`audit-budget.ts`). No
  // strategy instance is REGISTERED: no seam reaches a running trader's
  // strategies yet, so the control plane knows none and refuses a pause or
  // resume of any id `CONTROL_UNKNOWN_INSTANCE` rather than answering for an
  // instance it cannot control (M-1; README, "the composition obligation").
  const { log: audit, sink } = createBudgetedAuditLog({
    capacity: config.auditCapacity,
    safetyReserve: config.auditSafetyReserve,
  });
  // `CONTROL-1b`: every append is bounded (`AUDIT_APPEND_TIMEOUT_MS`, the
  // default), and an APPLIED record that lands after its bound is VOIDED by a
  // record whose instant and id come from this process's environment
  // (`composeControlPlane`). The in-memory log answers at once, so neither
  // path is reachable in this composition today; `main.test.ts` pins the
  // wiring with a sink that answers late.
  const controlPlane = composeControlPlane(sink, environment);
  const health = new TraderHealthCache(healthSourceFor(config));
  // `CONTROL-2` r1: stated, never defaulted — `none` is NOT_CONFIGURED, and
  // `postgres` reads ops.incidents on every authorized health and metrics read.
  const halts = composeTraderHalts(haltsPlan, ports.log);

  const api = new ControlApi({
    operators: new OperatorRegistry(
      config.operators.map((operator) => ({
        operatorId: operator.operatorId,
        token: operator.token,
        grants: operator.grants,
      })),
    ),
    controlPlane,
    health,
    environment,
    auditCapacity: config.auditCapacity,
    auditSize: () => audit.size,
    // `TRDR-3`: an `http` source is READ — on every authorized health/metrics
    // request (`api.ts`, "Refresh-on-read"). A `none` source has nothing to
    // read, so its trader-health lines are `WP-240`'s.
    refreshHealthOnRead: config.traderHealth.kind === "http",
    // `CONTROL-2`: always stated, so the `control_trader_halts_state` lines
    // and the `traderHalts` section are always there.
    traderHalts: halts.cache,
  });

  let server: Awaited<ReturnType<typeof startControlHttpServer>>;
  try {
    server = await startControlHttpServer({
      api,
      host: config.bindHost,
      port: config.bindPort,
      maxRequestBodyBytes: config.maxRequestBodyBytes,
    });
  } catch (cause) {
    // The reader's pool holds no connection yet (it connects on the first
    // read), but it is released all the same before the failure propagates.
    await halts.close().catch(() => undefined);
    throw cause;
  }

  ports.log(
    `control API listening on ${config.bindHost}:${String(server.port)} — PAPER, no signer, ` +
      "no venue connection, no route that raises a run mode",
  );
  ports.log(
    `server timeouts: headers ${String(server.timeouts.headersTimeoutMs)}ms, request ` +
      `${String(server.timeouts.requestTimeoutMs)}ms, keep-alive ${String(server.timeouts.keepAliveTimeoutMs)}ms; ` +
      "no strategy instance is registered (no seam reaches a running trader's strategies), so a " +
      "pause or resume is refused CONTROL_UNKNOWN_INSTANCE",
  );
  // `CONTROL-1b` r1 (closing `CONTROL1B-R1-J-L1`): read from the control plane
  // this process composed, so a composition that drops the void-record source
  // says so here — and `shipped-root-control-1.test.ts` pins this line.
  ports.log(
    `audit append bound ${String(controlPlane.auditAppendTimeoutMs)}ms; an APPLIED record that lands after it gets ` +
      (controlPlane.voidsLateAppliedRecords
        ? "a VOID record from this process's clock and id source, when the sink and the audit budget admit one"
        : "NO void record: no audit record source was composed"),
  );
  ports.log(
    config.traderHealth.kind === "http"
      ? `trader health: ${config.traderHealth.url} is read on every authorized /v1/health and ` +
          `/v1/metrics request (timeout ${String(config.traderHealth.timeoutMs)}ms); ` +
          "control_trader_health_current says whether the last read passed"
      : "trader health: none configured; the trader_* families have no producer and " +
          "control_trader_health_available reads 0",
  );
  ports.log(
    haltsPlan.kind === "postgres"
      ? `trader halts: the open TRADER_HALT rows of ops.incidents are read on every authorized /v1/health and ` +
          `/v1/metrics request (timeout ${String(haltsPlan.timeoutMs)}ms), from the database ` +
          `${TRADER_HALTS_DATABASE_URL_ENV} names (its value is never logged); control_trader_halts_state says ` +
          'OPEN, NONE_OPEN or UNKNOWN, and UNKNOWN is never "no halts"'
      : `trader halts: NOT CONFIGURED — ${TRADER_HALTS_NOT_CONFIGURED}; /v1/health and ` +
          'control_trader_halts_state say NOT_CONFIGURED, never "no halts"',
  );

  const shutdown = (): void => {
    void shutdownControlApi({
      closeServer: () => server.close(),
      closeHalts: () => halts.close(),
      terminateHalts: () => halts.terminate(),
      log: ports.log,
      redact: (text) => (haltsPlan.kind === "postgres" ? redactDatabaseUrl(text, haltsPlan.url) : text),
      ...(ports.exit === undefined ? {} : { exit: ports.exit }),
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return EXIT_CODES.ok;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith("main.mjs");

if (invokedDirectly || process.env["CONTROL_API_MAIN"] === "1") {
  const argv = process.argv.slice(2);
  const code = await startup(
    {
      env: process.env,
      argv,
      readConfig: (path) => readFile(path, "utf8"),
      log: (line) => {
        process.stdout.write(`${line}\n`);
      },
      // `CTL2-L2`: a signal's shutdown ends the process once it has run.
      exit: (exitCode) => {
        process.exit(exitCode);
      },
    },
    { serve: !argv.includes("--check") },
  );
  if (code !== EXIT_CODES.ok) process.exitCode = code;
}
