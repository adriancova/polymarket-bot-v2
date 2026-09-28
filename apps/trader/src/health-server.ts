/**
 * The trader's loopback health endpoint (`TRDR-3`, `GOV-2B` B5) — the producer
 * half of the seam `apps/control-api/src/health-source.ts` has consumed since
 * `WP-240` and that nothing served until this round.
 *
 * ## What it is
 *
 * One route: `GET /health` ({@link TRADER_HEALTH_PATH}) answers the CURRENT
 * `HealthSnapshot` — `trader.loop.health()`, taken per request, never cached —
 * as `application/json`, encoded by `encodePlainJson` from own data
 * (`docs/contracts/schema-boundary.md` §6 item 3; the SER sweep's rule: a
 * repo-built container never meets `JSON.stringify` on a wire). The control
 * API reads it through its `HttpTraderHealthSource` and its D1-D4 door.
 *
 * ## What it is NOT — stated where an operator will read it
 *
 * There is no POST, no PUT, no DELETE, no query parameter that does anything,
 * no route that names a run mode, a flag, a cap, an order, a wallet or a
 * signer. Every method but `GET` is `405` and every path but the one above is
 * `404`, each with a tiny fixed body that reflects NOTHING of the request. The
 * only state this server touches is the snapshot it reads. It cannot raise a
 * run mode because there is no code path here that writes anything at all.
 *
 * ## Loopback only, refused at the door
 *
 * {@link readHealthServerEnv} reads `TRADER_HEALTH_BIND` and
 * `TRADER_HEALTH_PORT` and refuses — by name, before a socket exists — any
 * bind host outside {@link TRADER_HEALTH_LOOPBACK_HOSTS}, the way
 * `apps/control-api/src/config.ts` refuses a non-loopback health URL on the
 * reading side (§15: no public exposure for an internal metrics surface; a
 * deployment that needs off-host access owes it a terminator in front). Both
 * variables absent means NO server, and `main.ts` says so in its startup log;
 * one without the other is a refusal, because a half-stated intention is not a
 * default this process may complete.
 *
 * ## Bounds, stated
 *
 * {@link TRADER_HEALTH_BOUNDS}: at most `maxConnections` open sockets (Node
 * refuses the rest at accept), `maxHeadersCount` headers, `headersTimeoutMs`
 * to finish the headers and `requestTimeoutMs` to finish a request, a
 * keep-alive idle bound, `maxRequestsPerSocket` requests per connection, and
 * a request BODY bound: a health read carries no body, so bytes past
 * `maxRequestBodyBytes` are answered `413` with `connection: close` and the
 * socket is destroyed once that answer has flushed; a body within the bound
 * is discarded unread. Node's own `--max-http-header-size` (16 KiB default)
 * bounds the header block. Nothing here allocates in proportion to what a
 * client sends.
 *
 * ## Failure is contained, and the trader does not die of its health page
 *
 * A snapshot that cannot be taken or encoded answers `500` with a fixed code
 * and the encoder's refusal KIND and PATH — read as OWN data off the thrown
 * value, never through `instanceof` (the classifier mutant that survived every
 * SER round until pinned; `test/unit/trader/health-server.test.ts` throws a
 * hostile `Proxy` at it). A socket error after `listen` is logged, not thrown.
 * A `listen` failure (port in use, address unavailable) is the ONE error this
 * module lets out, as a rejected promise the composition root turns into a
 * typed startup refusal.
 */

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";
import { createServer, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

import type { HealthSnapshot } from "@polymarket-bot/trading-core";

/** The one path this server answers. */
export const TRADER_HEALTH_PATH = "/health";

/** The closed set of bind hosts. `0.0.0.0`, `::` and any routable address are refused by name. */
export const TRADER_HEALTH_LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  "127.0.0.1",
  "::1",
  "localhost",
]);

/** Every bound the server applies. See the module header. */
export const TRADER_HEALTH_BOUNDS = Object.freeze({
  /** Concurrent sockets; Node drops the (n+1)th at accept. */
  maxConnections: 8,
  maxHeadersCount: 32,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
  keepAliveTimeoutMs: 1_000,
  maxRequestsPerSocket: 16,
  /** A health read has no body; more than this many body bytes destroys the socket. */
  maxRequestBodyBytes: 1_024,
});

export type HealthServerRefusalCode =
  /** One of the two variables is set without the other, or a value has the wrong grammar. */
  | "TRADER_HEALTH_ENV_INVALID"
  /** The bind host is not loopback. */
  | "TRADER_HEALTH_BIND_REFUSED"
  /** The port is not an integer in 0..65535. */
  | "TRADER_HEALTH_PORT_INVALID";

export interface HealthServerRefusal {
  readonly code: HealthServerRefusalCode;
  readonly detail: string;
  readonly issues: readonly string[];
}

/** Where to listen, once the door has accepted the environment. */
export interface HealthListen {
  readonly host: string;
  /** `0` asks the OS for a port; the startup log states the one bound. */
  readonly port: number;
}

export type HealthServerEnvResult =
  /** `listen` is `undefined` when neither variable is set: no server, stated. */
  | { readonly ok: true; readonly listen: HealthListen | undefined }
  | { readonly ok: false; readonly refusal: HealthServerRefusal };

const BIND_NAME = "TRADER_HEALTH_BIND";
const PORT_NAME = "TRADER_HEALTH_PORT";

/**
 * The grammar. `bind` is any short string — membership in the loopback set is
 * a NAMED refusal after the parse, not a grammar failure, so the operator
 * reads "not loopback" rather than "invalid enum". `port` is a decimal
 * integer string with no sign, no leading zero and at most five digits; the
 * range is checked after the parse for the same reason.
 */
const HealthEnvSchema = z.strictObject({
  bind: z.string().min(1).max(128),
  port: z.string().regex(/^(?:0|[1-9]\d{0,4})$/u),
});

const HealthEnvDoor = prototypeFreeParser(HealthEnvSchema);

/** An own string-valued property of the environment record, or `undefined`. */
function ownEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (!Object.hasOwn(env, name)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  const value = descriptor?.value;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Reads `TRADER_HEALTH_BIND` / `TRADER_HEALTH_PORT`. TOTAL: never throws.
 *
 * D1: the two values are read as own data and placed on a prototype-free
 * record this function built; D2: the arena copy of the schema judges it;
 * D3/D4: the answer is assembled from this function's own reads and frozen.
 */
export function readHealthServerEnv(
  env: Readonly<Record<string, string | undefined>>,
): HealthServerEnvResult {
  try {
    return readHealthServerEnvInner(env);
  } catch (cause) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_HEALTH_ENV_INVALID",
        detail:
          `reading ${BIND_NAME}/${PORT_NAME} failed unexpectedly and was contained (fail ` +
          "closed); a health endpoint whose configuration cannot be evaluated is not started",
        issues: [describeThrown(cause)],
      },
    };
  }
}

function readHealthServerEnvInner(
  env: Readonly<Record<string, string | undefined>>,
): HealthServerEnvResult {
  const bind = ownEnv(env, BIND_NAME);
  const port = ownEnv(env, PORT_NAME);
  if (bind === undefined && port === undefined) return { ok: true, listen: undefined };
  if (bind === undefined || port === undefined) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_HEALTH_ENV_INVALID",
        detail:
          `${bind === undefined ? BIND_NAME : PORT_NAME} is unset while ` +
          `${bind === undefined ? PORT_NAME : BIND_NAME} is set; the health endpoint is either ` +
          "fully stated (both) or absent (neither) — this process completes no half-stated " +
          "bind with a default",
        issues: [],
      },
    };
  }

  const record = Object.create(null) as { bind: string; port: string };
  record.bind = bind;
  record.port = port;
  const parsed = HealthEnvDoor.safeParse(record);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_HEALTH_ENV_INVALID",
        detail: `${BIND_NAME}/${PORT_NAME} failed validation (fail closed)`,
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      },
    };
  }

  if (!TRADER_HEALTH_LOOPBACK_HOSTS.includes(bind)) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_HEALTH_BIND_REFUSED",
        detail:
          `${BIND_NAME}=${bind} is not one of ${TRADER_HEALTH_LOOPBACK_HOSTS.join(", ")}; §15 ` +
          "forbids public network exposure for an internal health or metrics endpoint, and a " +
          "deployment that needs off-host access owes it a terminator in front rather than a " +
          "different string in this variable",
        issues: [],
      },
    };
  }

  // The grammar admitted at most five digits with no sign; only the range is left.
  const portNumber = Number.parseInt(port, 10);
  if (portNumber > 65_535) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_HEALTH_PORT_INVALID",
        detail: `${PORT_NAME}=${port} is not a port (0..65535)`,
        issues: [],
      },
    };
  }

  const listen = Object.create(null) as { host: string; port: number };
  listen.host = bind;
  listen.port = portNumber;
  return { ok: true, listen: Object.freeze(listen) };
}

/** A bounded description of a thrown value for a log line. Never formats a caller value. */
function describeThrown(cause: unknown): string {
  try {
    if (typeof cause === "object" && cause !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "message");
      if (typeof descriptor?.value === "string") return descriptor.value.slice(0, 512);
    }
    if (typeof cause === "string") return cause.slice(0, 512);
    return "non-error value";
  } catch {
    return "unclassifiable value";
  }
}

/**
 * The bytes `GET /health` writes for a snapshot: own-data JSON and a newline.
 *
 * Exported so the six-context inherited-`toJSON` battery drives THIS function
 * (`test/unit/trader/health-server.test.ts`) — a polluted window may not span
 * socket I/O — and so the wire suites can assert the served bytes are exactly
 * these. Throws the encoder's typed refusal for a non-plain snapshot; the
 * handler contains that into a `500`.
 */
export function healthResponseBody(snapshot: HealthSnapshot): string {
  return `${encodePlainJson(snapshot)}\n`;
}

/**
 * Classifies a value thrown while taking or encoding the snapshot, reading
 * `kind` and `path` as OWN data: a `NotPlainJson` names both; anything else —
 * including a value whose every trap throws — is "unclassified". Never
 * `instanceof`, never a property read that could run a getter or a trap
 * unguarded.
 */
export function classifyHealthFailure(cause: unknown): string {
  try {
    if (typeof cause !== "object" || cause === null) return "unclassified";
    const kind = Object.getOwnPropertyDescriptor(cause, "kind")?.value;
    const path = Object.getOwnPropertyDescriptor(cause, "path")?.value;
    if (typeof kind === "string" && typeof path === "string") {
      return `${kind.slice(0, 64)} at ${path.slice(0, 256)}`;
    }
    return "unclassified";
  } catch {
    return "unclassified";
  }
}

/** The fixed refusal bodies. Plain records the encoder cannot refuse; nothing of the request in them. */
const BODIES = Object.freeze({
  methodNotAllowed: `${encodePlainJson({
    code: "TRADER_HEALTH_METHOD_NOT_ALLOWED",
    detail: `only GET ${TRADER_HEALTH_PATH} is served; this endpoint accepts no mutation`,
  })}\n`,
  noSuchPath: `${encodePlainJson({
    code: "TRADER_HEALTH_NO_SUCH_PATH",
    detail: `only GET ${TRADER_HEALTH_PATH} is served`,
  })}\n`,
  tooLarge: `${encodePlainJson({
    code: "TRADER_HEALTH_BODY_TOO_LARGE",
    detail:
      `a health read carries no body; more than ${String(TRADER_HEALTH_BOUNDS.maxRequestBodyBytes)} ` +
      "bytes are refused and the connection is closed",
  })}\n`,
});

function unavailableBody(classification: string): string {
  return `${encodePlainJson({
    code: "TRADER_HEALTH_UNAVAILABLE",
    detail: `the health snapshot could not be produced or encoded (${classification})`,
  })}\n`;
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  extra?: Readonly<Record<string, string>>,
  closeAfter = false,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(extra ?? {}),
  });
  response.end(body, () => {
    if (closeAfter) response.socket?.destroy();
  });
}

export interface TraderHealthServerOptions {
  readonly listen: HealthListen;
  /** The CURRENT snapshot — `trader.loop.health()`. Called once per request. */
  readonly snapshot: () => HealthSnapshot;
  readonly log: (line: string) => void;
}

export interface RunningTraderHealthServer {
  readonly host: string;
  /** The port actually bound (the OS's choice when `0` was asked for). */
  readonly port: number;
  /** `http://<host>:<port>/health`, as the control API's configuration wants it. */
  readonly url: string;
  /** Requests answered `200`, `405`/`404` and `500`, for a test's non-vacuity. */
  readonly counts: { readonly served: number; readonly refused: number; readonly failed: number };
  /** Stops listening and closes every open connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * Starts the server. Resolves once it is listening; rejects if it cannot
 * bind — the one error the composition root turns into a typed refusal.
 */
export function startTraderHealthServer(
  options: TraderHealthServerOptions,
): Promise<RunningTraderHealthServer> {
  const counts = { served: 0, refused: 0, failed: 0 };
  const server: Server = createServer((request, response) => {
    // A health read carries no body. Whatever arrives is discarded up to the
    // bound and the answer is written once the request has ENDED — answering
    // on the headers would make the bound decorative, since the body would
    // still be streaming into a socket this process had already replied on.
    // Past the bound the request is answered `413` at once with
    // `connection: close`, and the socket is destroyed after the answer has
    // flushed (the control API's `http.ts` pattern): nothing a client sends
    // here is worth reading, and a reset with no status is harder to read
    // than a refusal with one.
    let bodyBytes = 0;
    let refusedTooLarge = false;
    request.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > TRADER_HEALTH_BOUNDS.maxRequestBodyBytes && !refusedTooLarge) {
        refusedTooLarge = true;
        counts.refused += 1;
        send(response, 413, BODIES.tooLarge, { connection: "close" }, true);
      }
    });
    request.on("error", () => {
      // A torn-down request; the socket is already gone or going.
    });
    request.on("end", () => {
      if (refusedTooLarge) return;
      const method = request.method ?? "";
      const path = (request.url ?? "").split("?")[0] ?? "";
      if (method !== "GET") {
        counts.refused += 1;
        send(response, 405, BODIES.methodNotAllowed, { allow: "GET" });
        return;
      }
      if (path !== TRADER_HEALTH_PATH) {
        counts.refused += 1;
        send(response, 404, BODIES.noSuchPath);
        return;
      }
      let body: string;
      try {
        body = healthResponseBody(options.snapshot());
      } catch (cause) {
        counts.failed += 1;
        const classification = classifyHealthFailure(cause);
        options.log(`health endpoint: the snapshot could not be served (${classification})`);
        send(response, 500, unavailableBody(classification));
        return;
      }
      counts.served += 1;
      send(response, 200, body);
    });
  });

  server.maxConnections = TRADER_HEALTH_BOUNDS.maxConnections;
  server.maxHeadersCount = TRADER_HEALTH_BOUNDS.maxHeadersCount;
  server.headersTimeout = TRADER_HEALTH_BOUNDS.headersTimeoutMs;
  server.requestTimeout = TRADER_HEALTH_BOUNDS.requestTimeoutMs;
  server.keepAliveTimeout = TRADER_HEALTH_BOUNDS.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = TRADER_HEALTH_BOUNDS.maxRequestsPerSocket;

  return new Promise<RunningTraderHealthServer>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onListenError);
    server.listen(options.listen.port, options.listen.host, () => {
      server.off("error", onListenError);
      // After `listen`, a socket-level error is a log line, never a crash: the
      // trader must not die of its health page.
      server.on("error", (error: Error) => {
        options.log(`health endpoint: server error (${describeThrown(error)})`);
      });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.listen.port;
      const host = options.listen.host;
      const urlHost = host.includes(":") ? `[${host}]` : host;
      let closed: Promise<void> | undefined;
      resolve({
        host,
        port,
        url: `http://${urlHost}:${String(port)}${TRADER_HEALTH_PATH}`,
        counts,
        close: () => {
          closed ??= new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
          return closed;
        },
      });
    });
  });
}
