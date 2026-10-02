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

/** What the process exits with, so an operator can script against it. */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  /** The environment is unsafe (§6 invariant 17, §15, ADR-010). */
  unsafeEnvironment: 78,
  /** The configuration was refused. */
  configurationRefused: 78,
});

export interface StartupPorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly readConfig: (path: string) => Promise<string>;
  readonly log: (line: string) => void;
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

  ports.log(
    `control API configuration accepted: ${String(config.operators.length)} operator(s), ` +
      `audit bound ${String(config.auditCapacity)} (the last ${String(config.auditSafetyReserve)} ` +
      `for kill-switch engages, the ${String(config.auditSafetyReserve)} before them for ` +
      `safety-direction actions), trader health source ${config.traderHealth.kind}`,
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
    // read and its surface stays byte-identical to `WP-240`'s.
    refreshHealthOnRead: config.traderHealth.kind === "http",
  });

  const server = await startControlHttpServer({
    api,
    host: config.bindHost,
    port: config.bindPort,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
  });

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

  const shutdown = (): void => {
    void server.close().then(
      () => {
        ports.log("control API stopped.");
      },
      (cause: unknown) => {
        ports.log(`control API stop failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      },
    );
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
    },
    { serve: !argv.includes("--check") },
  );
  if (code !== EXIT_CODES.ok) process.exitCode = code;
}
