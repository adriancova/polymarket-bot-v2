/**
 * A minimal HTTP client for the integration suite, over `node:http`.
 *
 * It exists so the acceptance suites drive the API the way an operator's tool
 * would — through a socket, with real headers and a real body — rather than by
 * calling the handler. The handler seam is covered by the unit suites; this
 * tree's job is to prove that the transport does not change any answer.
 *
 * Loopback only, ephemeral ports, closed after every suite.
 */

import { request as httpRequest } from "node:http";

import {
  AbsentTraderHaltSource,
  ControlApi,
  ControlPlane,
  InMemoryTraderHealthSource,
  OperatorRegistry,
  SafetyReservedAuditSink,
  TraderHaltCache,
  TraderHealthCache,
  createBudgetedAuditLog,
  startControlHttpServer,
  type ControlHttpTimeouts,
  type RunningControlHttpServer,
  type TraderHaltSource,
} from "@polymarket-bot/control-api";
import { ScriptedEnvironment } from "@polymarket-bot/control-api/testing";
import { InMemoryControlAuditLog, type ControlAuditSink } from "@polymarket-bot/observability";

export interface HttpResponse {
  readonly status: number;
  readonly contentType: string;
  /** Every response header, lower-cased names (`node:http`'s own record). */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly text: string;
  json(): unknown;
}

export interface ServedApi {
  readonly url: string;
  readonly audit: InMemoryControlAuditLog;
  /** The audit budget the control plane writes through (`audit-budget.ts`). */
  readonly auditBudget: SafetyReservedAuditSink;
  readonly controlPlane: ControlPlane;
  readonly healthSource: InMemoryTraderHealthSource;
  readonly health: TraderHealthCache;
  /** `CONTROL-2`: the trader halt cache the API reads. */
  readonly traderHalts: TraderHaltCache;
  readonly server: RunningControlHttpServer;
  call(
    method: string,
    path: string,
    options?: CallOptions,
  ): Promise<HttpResponse>;
}

export interface CallOptions {
  readonly token?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  /**
   * The `Content-Type` sent with a body. Absent: `application/json`. `null`:
   * none at all (`CONTROL-1`, L-3's probes).
   */
  readonly contentType?: string | null;
}

export interface ServeOptions {
  readonly auditCapacity?: number;
  /** The audit budget's safety reserve. Defaults to `0` (see the harness's note). */
  readonly auditSafetyReserve?: number;
  readonly maxRequestBodyBytes?: number;
  readonly timeouts?: ControlHttpTimeouts;
  readonly operators?: readonly {
    readonly operatorId: string;
    readonly token: string;
    readonly grants: readonly ("READ" | "STRATEGY_CONTROL" | "KILL_SWITCH")[];
  }[];
  /**
   * `CONTROL-1b`: a sink placed BETWEEN the audit budget and the log — a slow,
   * stalling or late-answering durable sink, as a test needs one. Absent: the
   * shipped composition exactly (`createBudgetedAuditLog`).
   */
  readonly auditInner?: (log: InMemoryControlAuditLog) => ControlAuditSink;
  /** `CONTROL-1b`: the control plane's append bound. Absent: its default. */
  readonly auditAppendTimeoutMs?: number;
  /**
   * `CONTROL-2`: the trader halt source. Absent: an `AbsentTraderHaltSource`,
   * as `main.ts` composes today (`NOT_CONFIGURED`).
   */
  readonly traderHaltSource?: TraderHaltSource;
}

/**
 * Starts the REAL server over the REAL API, control plane and audit log, behind
 * the REAL audit budget (`createBudgetedAuditLog`, the composition `main.ts`
 * builds).
 */
export async function serveControlApi(options: ServeOptions = {}): Promise<ServedApi> {
  const budget = { capacity: options.auditCapacity ?? 64, safetyReserve: options.auditSafetyReserve ?? 0 };
  let audit: InMemoryControlAuditLog;
  let auditBudget: SafetyReservedAuditSink;
  if (options.auditInner === undefined) {
    ({ log: audit, sink: auditBudget } = createBudgetedAuditLog(budget));
  } else {
    audit = new InMemoryControlAuditLog(budget.capacity);
    auditBudget = new SafetyReservedAuditSink(options.auditInner(audit), budget);
  }
  const environment = new ScriptedEnvironment();
  const controlPlane = new ControlPlane({
    audit: auditBudget,
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    repositoryMaximumRunMode: "PAPER",
    // As `main.ts` (`CONTROL-1b`): a void record's instant and id.
    auditRecordSource: environment,
    ...(options.auditAppendTimeoutMs === undefined ? {} : { auditAppendTimeoutMs: options.auditAppendTimeoutMs }),
  });
  const healthSource = new InMemoryTraderHealthSource();
  const health = new TraderHealthCache(healthSource);
  const traderHalts = new TraderHaltCache(options.traderHaltSource ?? new AbsentTraderHaltSource());
  const api = new ControlApi({
    operators: new OperatorRegistry([...(options.operators ?? [])]),
    controlPlane,
    health,
    environment,
    auditCapacity: options.auditCapacity ?? 64,
    auditSize: () => audit.size,
    traderHalts,
  });

  const server = await startControlHttpServer({
    api,
    host: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: options.maxRequestBodyBytes ?? 65_536,
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  });
  const url = `http://127.0.0.1:${String(server.port)}`;

  return {
    url,
    audit,
    auditBudget,
    controlPlane,
    healthSource,
    health,
    traderHalts,
    server,
    call: (method, path, callOptions = {}) =>
      call(url, method, path, callOptions),
  };
}

function call(
  base: string,
  method: string,
  path: string,
  options: CallOptions,
): Promise<HttpResponse> {
  const payload =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (payload !== undefined) {
    const contentType = options.contentType === undefined ? "application/json" : options.contentType;
    if (contentType !== null) headers["content-type"] = contentType;
    headers["content-length"] = String(Buffer.byteLength(payload));
  }

  return new Promise<HttpResponse>((resolve, reject) => {
    const request = httpRequest(`${base}${path}`, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          headers: response.headers,
          text,
          json: () => JSON.parse(text) as unknown,
        });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
