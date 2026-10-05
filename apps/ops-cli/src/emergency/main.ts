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
 * NOT YET RUNNABLE FROM A SHELL (disclosed, `docs/runbooks/emergency.md`).
 * This module imports workspace packages, so ADR-018 §4 requires an esbuild
 * bundle for it, and adding one needs a grant on
 * `test/unit/tooling/app-bundles-load.test.ts` (which pins that ops-cli ships
 * no bundle) and an `esbuild` devDependency: both outside WP-330's paths. The
 * shipped `verify-venue` script is unchanged. Until then `main` is exercised
 * in-process by `main.test.ts`.
 */

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

/** The real terminal, clock and environment of this process. */
export function processIo(): ProcessIo {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  return {
    argv: process.argv.slice(2),
    env: process.env,
    out: { line: (text: string) => void process.stdout.write(`${text}\n`) },
    prompt: {
      interactive,
      async ask(question: string): Promise<string | null> {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
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

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const result = await main(processIo());
  process.exitCode = result.exitCode;
  // The outcome is printed and audited; nothing may keep the process alive past a short grace.
  setTimeout(() => process.exit(result.exitCode), EXIT_GRACE_MS).unref();
}
