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
  ControlApi,
  ControlPlane,
  InMemoryTraderHealthSource,
  OperatorRegistry,
  TraderHealthCache,
  startControlHttpServer,
  type RunningControlHttpServer,
} from "@polymarket-bot/control-api";
import { ScriptedEnvironment } from "@polymarket-bot/control-api/testing";
import { InMemoryControlAuditLog } from "@polymarket-bot/observability";

export interface HttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
  json(): unknown;
}

export interface ServedApi {
  readonly url: string;
  readonly audit: InMemoryControlAuditLog;
  readonly controlPlane: ControlPlane;
  readonly healthSource: InMemoryTraderHealthSource;
  readonly health: TraderHealthCache;
  readonly server: RunningControlHttpServer;
  call(
    method: string,
    path: string,
    options?: { readonly token?: string; readonly body?: unknown; readonly rawBody?: string },
  ): Promise<HttpResponse>;
}

export interface ServeOptions {
  readonly auditCapacity?: number;
  readonly maxRequestBodyBytes?: number;
  readonly operators?: readonly {
    readonly operatorId: string;
    readonly token: string;
    readonly grants: readonly ("READ" | "STRATEGY_CONTROL" | "KILL_SWITCH")[];
  }[];
}

/** Starts the REAL server over the REAL API, control plane and audit log. */
export async function serveControlApi(options: ServeOptions = {}): Promise<ServedApi> {
  const audit = new InMemoryControlAuditLog(options.auditCapacity ?? 64);
  const controlPlane = new ControlPlane({
    audit,
    runMode: "PAPER",
    maximumRunMode: "PAPER",
    repositoryMaximumRunMode: "PAPER",
  });
  const healthSource = new InMemoryTraderHealthSource();
  const health = new TraderHealthCache(healthSource);
  const api = new ControlApi({
    operators: new OperatorRegistry([...(options.operators ?? [])]),
    controlPlane,
    health,
    environment: new ScriptedEnvironment(),
    auditCapacity: options.auditCapacity ?? 64,
    auditSize: () => audit.size,
  });

  const server = await startControlHttpServer({
    api,
    host: "127.0.0.1",
    port: 0,
    maxRequestBodyBytes: options.maxRequestBodyBytes ?? 65_536,
  });
  const url = `http://127.0.0.1:${String(server.port)}`;

  return {
    url,
    audit,
    controlPlane,
    healthSource,
    health,
    server,
    call: (method, path, callOptions = {}) =>
      call(url, method, path, callOptions),
  };
}

function call(
  base: string,
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown; readonly rawBody?: string },
): Promise<HttpResponse> {
  const payload =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
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
