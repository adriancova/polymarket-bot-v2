/**
 * The emergency CLI's process composition (WP-330). It binds the ports of
 * `run.ts` to this process, and binds NOTHING LIVE:
 *
 * | Port | Bound to |
 * | --- | --- |
 * | run-mode flags | the environment record, read by WP-260's `signerGateContextFromSafetyFlags` only (`RUN_MODE`, `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`); the repository defaults refuse |
 * | audit log | `--audit-log`, else `OPS_CLI_AUDIT_LOG`: the append-only JSON Lines file |
 * | audit mirror, fencing lease store | `OPS_CLI_DATABASE_URL`, when set: `ops.config_change_audit` and WP-320's `FencingLeaseStore`; otherwise none |
 * | configuration | `OPS_CLI_CONFIG`: the ops configuration file (`configuration.ts`), read only after the gate permits |
 * | emergency credential | **UNAVAILABLE** (`NO_EMERGENCY_CREDENTIAL_SOURCE`): this repository loads no credential (§15, ADR-010) |
 * | venue | **UNAVAILABLE** (`NO_LIVE_VENUE_BINDING`): the live composition binds WP-260's client and the account reads after ADR-033 D5 and the live-micro gate |
 * | ledger projection | none |
 *
 * No variable this file reads names a secret: `OPS_CLI_DATABASE_URL` is a
 * connection string the operator supplies for the audit mirror and the lease
 * store (its value is never printed), and the rest are paths and the three
 * run-mode flags.
 *
 * RUN FROM A SHELL through the app's ADR-018 bundle (WP-330 r0, under the
 * orchestrator's 2026-10-05 grant). This module imports workspace packages,
 * so ADR-018 §4 requires a bundle: `build` bundles `src/main.ts`, the shipped
 * entry, to `dist/main.mjs`, and `start` (or `node dist/main.mjs <command>`)
 * runs it. `src/main.ts` only calls {@link runIfProcessEntry}; THIS module has
 * no top-level side effect, so the bundle holds exactly one entry guard and an
 * importer (a test) never runs a command. The shipped bundle is built and run
 * by `test/unit/tooling/app-bundles-load.test.ts`; `main` itself is also
 * exercised in-process by `main.test.ts`. The `verify-venue` script keeps its
 * own `tsc` path (its executable imports no workspace package).
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { createDatabase, createFencingLeaseStore, createPostgresPool, uuidV7, type PolymarketBotDatabase } from "@polymarket-bot/storage-postgres";

import { createFileAuditLog } from "./audit-log.js";
import { createPostgresAuditMirror } from "./audit-mirror.js";
import type {
  ConfigurationSource,
  ConfirmationPrompt,
  EmergencyCredentialPort,
  EmergencyVenueFactory,
  FencingLeaseAccessFactory,
  OpsClock,
  OutputPort,
} from "./ports.js";
import { runOpsCli, type OpsCliOutcome } from "./run.js";

export const AUDIT_LOG_ENV = "OPS_CLI_AUDIT_LOG";
export const CONFIG_ENV = "OPS_CLI_CONFIG";
export const DATABASE_URL_ENV = "OPS_CLI_DATABASE_URL";

/** The database is only ever a best-effort mirror and the lease store: short bounds, so a dead one costs seconds, not minutes. */
const DATABASE_CONNECTION_TIMEOUT_MS = 3_000;
const DATABASE_STATEMENT_TIMEOUT_MS = 5_000;
/** The longest the CLI waits to release its database connections before it exits anyway. */
const DATABASE_RELEASE_MS = 2_000;
/** After the outcome is printed, a lingering handle (a wedged socket) may delay the exit this long at most. */
const EXIT_GRACE_MS = 2_000;

export const UNCONFIGURED_CREDENTIALS: EmergencyCredentialPort = Object.freeze({
  load: () => Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "NO_EMERGENCY_CREDENTIAL_SOURCE" }),
});

export const UNBOUND_VENUE: EmergencyVenueFactory = Object.freeze({
  open: () => Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "NO_LIVE_VENUE_BINDING" }),
});

export interface ProcessIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: OutputPort;
  readonly prompt: ConfirmationPrompt;
  readonly clock: OpsClock;
}

function fileConfiguration(path: string | undefined): ConfigurationSource {
  return Object.freeze({
    async load() {
      if (path === undefined || path.length === 0) return { kind: "UNAVAILABLE" as const, reason: "NO_CONFIGURATION" };
      try {
        return { kind: "LOADED" as const, document: JSON.parse(await readFile(path, "utf8")) as unknown };
      } catch {
        return { kind: "UNAVAILABLE" as const, reason: "CONFIGURATION_UNREADABLE" };
      }
    },
  });
}

/** Compose the process's ports, run one invocation, release the database. */
export async function main(io: ProcessIo): Promise<OpsCliOutcome> {
  const databaseUrl = io.env[DATABASE_URL_ENV];
  let db: PolymarketBotDatabase | null = null;
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    // A pool connects on its first query, never here.
    const pool = createPostgresPool({
      connectionString: databaseUrl,
      applicationName: "polymarket-bot-ops-cli",
      maxConnections: 2,
      connectionTimeoutMs: DATABASE_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: DATABASE_STATEMENT_TIMEOUT_MS,
    });
    // An idle connection the server drops must not crash an emergency CLI: the database is best effort here.
    pool.on("error", () => undefined);
    db = createDatabase(pool);
  }
  const database = db;
  const leases: FencingLeaseAccessFactory = Object.freeze({
    open: () =>
      Promise.resolve(
        database === null
          ? { kind: "UNAVAILABLE" as const, reason: "NO_DATABASE_CONFIGURED" }
          : { kind: "OPEN" as const, leases: createFencingLeaseStore(database), close: () => Promise.resolve() },
      ),
  });
  try {
    return await runOpsCli({
      argv: io.argv,
      runModeFlags: io.env,
      defaultAuditLogPath: io.env[AUDIT_LOG_ENV] ?? null,
      out: io.out,
      prompt: io.prompt,
      clock: io.clock,
      newId: () => uuidV7(),
      openAuditLog: (path) => createFileAuditLog(path),
      auditMirror: database === null ? null : createPostgresAuditMirror(database),
      configuration: fileConfiguration(io.env[CONFIG_ENV]),
      credentials: UNCONFIGURED_CREDENTIALS,
      venues: UNBOUND_VENUE,
      leases,
      projection: null,
    });
  } finally {
    // Bounded: a database that wedged mid-connect must not hold an emergency CLI open (its pool can wait forever).
    if (database !== null) await Promise.race([database.destroy().catch(() => undefined), io.clock.sleep(DATABASE_RELEASE_MS)]);
  }
}

/** The terminal streams `processIo` binds: the process's own, unless a test passes its own. */
export interface ProcessStreams {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean | undefined };
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean | undefined };
}

/**
 * The real terminal, clock and environment of this process.
 *
 * A CLOSED STDOUT NEVER KILLS A COMMAND. Output piped to `head`, or a terminal
 * that goes away, makes the next write fail with `EPIPE`, which Node raises as
 * an `error` event; with no listener that is an uncaught exception, and the
 * process would die mid-command, after its ACTING record and before its
 * OUTCOME record (measured on the bundle: `--help | head -3` died so). So an
 * error sink is installed first: the lost output stays lost, the command runs
 * to its bounded end, and the audit log, written and fsynced independently of
 * stdout, stays the record of truth.
 */
export function processIo(streams: ProcessStreams = { stdin: process.stdin, stdout: process.stdout }): ProcessIo {
  const { stdin, stdout } = streams;
  stdout.on("error", () => undefined);
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  return {
    argv: process.argv.slice(2),
    env: process.env,
    out: { line: (text: string) => void stdout.write(`${text}\n`) },
    prompt: {
      interactive,
      async ask(question: string): Promise<string | null> {
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          return await rl.question(question);
        } catch {
          return null;
        } finally {
          rl.close();
        }
      },
    },
    clock: {
      // Epoch-anchored and monotonic: never stepped by a wall-clock correction.
      nowMs: () => Math.floor(performance.timeOrigin + performance.now()),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  };
}

/**
 * Whether the module at `moduleUrl` is the file Node was asked to run (`argv1`
 * is `process.argv[1]`). Compared by URL with that path as given (for
 * `--preserve-symlinks-main`) and resolved through symlinks (as Node names its
 * main module), NEVER by file name: an entry guard keyed on a name exits 0
 * having done nothing when the bundle is renamed, copied or reached through a
 * symlink (ADR-018's renamed-bundle residual), and for an emergency CLI exit 0
 * is `COMPLETED`, a false success. An importer (a test, another module) is
 * never the entry. The trader's `isProcessEntry` (REGISTER-1) is the
 * precedent; it is restated here because ops-cli may not import the trader
 * (§14.2 independence). TOTAL: it never throws.
 */
export function isProcessEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  try {
    if (pathToFileURL(argv1).href === moduleUrl) return true;
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

/**
 * The process shell: when `moduleUrl` (the shipped entry's `import.meta.url`)
 * is the file Node runs, run ONE invocation as this process and set its exit
 * code; otherwise do nothing. `src/main.ts` is its only caller, so the bundle
 * holds exactly one guard.
 */
export async function runIfProcessEntry(moduleUrl: string): Promise<OpsCliOutcome | null> {
  if (!isProcessEntry(moduleUrl, process.argv[1])) return null;
  const result = await main(processIo());
  process.exitCode = result.exitCode;
  // The outcome is printed and audited; nothing may keep the process alive past a short grace.
  setTimeout(() => process.exit(result.exitCode), EXIT_GRACE_MS).unref();
  return result;
}
