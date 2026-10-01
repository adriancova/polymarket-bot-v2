/**
 * The socket plumbing over {@link ControlApi} — and nothing else.
 *
 * Everything that decides anything is in `api.ts`. This module reads a bounded
 * body, parses JSON, calls the handler, and writes the answer. Keeping it that
 * thin is what lets the integration suite drive the REAL decision path over
 * real HTTP while the unit suites drive the same functions directly, with no
 * doubled subject behaviour in either.
 *
 * ## Bounds are enforced before anything is parsed
 *
 * A request body larger than the configured bound is refused at `413` while it
 * is still arriving, and the socket is destroyed. Parsing first and checking
 * afterwards would mean an unbounded allocation on an operator surface.
 *
 * ## Loopback is enforced at the bind, not by a middleware
 *
 * `config.ts` refuses a non-loopback `bindHost` at startup (§15). This module
 * binds what it is given; a check here would be a second, weaker copy of a rule
 * that has already been applied to a value nobody can change afterwards.
 *
 * ## A body must SAY it is JSON (`CONTROL-1`, `WP-240` r1 L-3)
 *
 * A request with a non-empty body must carry `Content-Type: application/json`,
 * optionally with `charset=utf-8` and no other parameter; anything else is
 * refused `415` and never acted on. The body is decoded as UTF-8 and parsed as
 * JSON, so a request that declares something else is a request this process
 * would be reading as something its sender did not mean. (It was never a CSRF
 * path — the credential is a bearer header and the bind is loopback — but a
 * control surface that accepts any declared type is one whose input grammar is
 * narrower than its own documentation says.) A body-less request needs no
 * content type.
 *
 * ## The transport DECIDES its refusals; the API ANSWERS them (`CONTROL-1` r1)
 *
 * The three refusals this module makes while reading a body — `413` too large,
 * `415` undeclared, `400` not JSON — are not written here. Each is handed to
 * {@link ControlApi.handle} as a typed {@link TransportRefusal}, carrying the
 * exact response rendered here, and the API answers it only after
 * authentication, the by-name mode-raise refusal, routing and the route's
 * authorization (`api.ts`, module header). So an anonymous caller learns
 * nothing about its body (`401`); an authorized caller's refusal on a mutating
 * route is AUDITED (`CONTROL1-J-M2`: at round 0 these three were written here,
 * before authentication, and an authorized operator's refusal left no record);
 * and a caller without mutation authority still writes nothing (`WP-240` r1
 * M-3). An undeclared body that nonetheless parses as JSON is passed along for
 * ONE purpose — so that a body naming `runMode` is still refused BY NAME, and
 * audited for a mutation-grant holder, as it was before L-3 — and is never
 * acted on.
 *
 * Two things still never reach the API, and so are never audited: a request
 * whose body never arrived whole (the client went away; Node's own `408`), and
 * anything Node's HTTP parser refuses itself.
 *
 * ## Explicit timeouts (`CONTROL-1`, `WP-240` r1 L-9)
 *
 * The server's header, request and keep-alive timeouts are this module's
 * {@link CONTROL_HTTP_TIMEOUTS}, set on the server rather than inherited from
 * whatever Node version runs it, together with the interval at which Node
 * checks them — without which a short `headersTimeout` is only enforced every
 * 30 s (Node's default `connectionsCheckingInterval`). A client that dribbles
 * its headers or body is answered `408` and disconnected within those bounds.
 *
 * ## Every byte this server writes is encoded from own data
 *
 * The three refusal bodies rendered here (`413`, `415`, `400`) are built by
 * `encodePlainJson` for the same reason `api.ts`'s `json()` is (`SER-3`,
 * `docs/handoffs/SER-0-sweep.md` `control-http-refusal-bodies`): they are
 * message-only at base, but a server whose ordinary bodies are own-data
 * encoded and whose refusal bodies are not would have two answers to "what
 * does `JSON.stringify` consult" — so it has one. The literals are plain
 * records the encoder cannot refuse.
 */

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ApiRequest, ApiResponse, ControlApi, TransportRefusal, TransportRefusalCode } from "./api.js";

/** The server's timeouts, in milliseconds. */
export interface ControlHttpTimeouts {
  /** The whole header block must arrive within this (Node `headersTimeout`). */
  readonly headersTimeoutMs: number;
  /** The whole request, body included, must arrive within this (`requestTimeout`). */
  readonly requestTimeoutMs: number;
  /** An idle keep-alive connection is closed after this (`keepAliveTimeout`). */
  readonly keepAliveTimeoutMs: number;
  /** How often Node checks the two above (`connectionsCheckingInterval`). */
  readonly connectionsCheckingIntervalMs: number;
}

/**
 * The shipped timeouts. Sized for an operator tool on the loopback sending a
 * body of at most `maxRequestBodyBytes` (≤ 1 MiB): ten seconds for the
 * headers and thirty for the whole request are orders of magnitude more than
 * that needs, and orders of magnitude less than Node's five-minute default
 * request timeout.
 */
export const CONTROL_HTTP_TIMEOUTS: ControlHttpTimeouts = Object.freeze({
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  connectionsCheckingIntervalMs: 1_000,
});

export interface ControlHttpServerOptions {
  readonly api: ControlApi;
  readonly host: string;
  readonly port: number;
  readonly maxRequestBodyBytes: number;
  /** Defaults to {@link CONTROL_HTTP_TIMEOUTS}; tests shorten them to measure them. */
  readonly timeouts?: ControlHttpTimeouts;
}

export interface RunningControlHttpServer {
  readonly port: number;
  /** The timeouts the listening server actually holds, read back from it. */
  readonly timeouts: Omit<ControlHttpTimeouts, "connectionsCheckingIntervalMs">;
  close(): Promise<void>;
}

/**
 * Whether a `Content-Type` header value declares JSON this process will read:
 * the media type `application/json`, case-insensitively, with no parameter
 * other than `charset=utf-8` (quoted or not, any case). TOTAL.
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [mediaType = "", ...parameters] = header.split(";");
  if (mediaType.trim().toLowerCase() !== "application/json") return false;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) return false;
    const name = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/u, "$1")
      .toLowerCase();
    if (name !== "charset" || (value !== "utf-8" && value !== "utf8")) return false;
  }
  return true;
}

type BodyRead =
  | { readonly ok: true; readonly text: string }
  /**
   * `TOO_LARGE`: the bound was crossed, and the request is answered `413`
   * through the API. `ABORTED`: the request errored before its body arrived
   * whole — it is not a request anyone can be answered for, so the API never
   * sees it.
   */
  | { readonly ok: false; readonly reason: "TOO_LARGE" | "ABORTED" };

function readBody(request: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // STOP ACCUMULATING, but do not destroy the request here: the client is
        // still sending, and tearing the socket down before the response is
        // written turns a `413` into a socket hang-up the caller cannot read.
        // The answer is written with `connection: close`, and the socket is
        // destroyed after it has been flushed (see `send`).
        refused = true;
        chunks.length = 0;
        resolve({ ok: false, reason: "TOO_LARGE" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (refused) return;
      resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    request.on("error", () => {
      resolve({ ok: false, reason: "ABORTED" });
    });
  });
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * A transport refusal, typed, with the exact response this module renders for
 * it — the API returns that response verbatim once the request is authorized.
 */
function transportRefusal(
  status: 400 | 413 | 415,
  code: TransportRefusalCode,
  detail: string,
  issues: readonly string[],
): TransportRefusal {
  const response: ApiResponse = {
    status,
    contentType: JSON_CONTENT_TYPE,
    body: controlRefusalBody(code, detail, issues),
  };
  return { code, detail, issues, response };
}

/** `JSON.parse`, as data. TOTAL. */
function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * The body of a transport-level refusal, encoded from OWN DATA (`SER-3`).
 *
 * Exported so the six-context pin drives THIS function rather than a copy of
 * its literal: a polluted window may not span socket I/O (an inherited
 * `toJSON` installed across a macrotask corrupts vitest's own worker IPC —
 * measured), so the wire-level suites cannot hold one open across a request.
 * Its callers are the three refusals below (`413`, `415`, `400`), all through
 * `transportRefusal`, and the aborted-body answer.
 *
 * The record is plain, so the encoder cannot refuse it.
 */
export function controlRefusalBody(
  code: string,
  detail: string,
  issues: readonly string[],
): string {
  return `${encodePlainJson({ code, detail, issues })}\n`;
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  close = false,
  allow?: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    // An operator surface is not cacheable and is not for a browser to sniff.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(close ? { connection: "close" } : {}),
    // RFC 9110 §15.5.6: a 405 names the methods the resource does serve.
    ...(allow === undefined ? {} : { allow }),
  });
  response.end(body, () => {
    if (close) response.socket?.destroy();
  });
}

/** Starts the server. Resolves once it is listening. */
export function startControlHttpServer(
  options: ControlHttpServerOptions,
): Promise<RunningControlHttpServer> {
  const timeouts = options.timeouts ?? CONTROL_HTTP_TIMEOUTS;
  const server: Server = createServer(
    {
      headersTimeout: timeouts.headersTimeoutMs,
      requestTimeout: timeouts.requestTimeoutMs,
      keepAliveTimeout: timeouts.keepAliveTimeoutMs,
      connectionsCheckingInterval: timeouts.connectionsCheckingIntervalMs,
    },
    (request, response) => {
      void (async () => {
        const url = request.url ?? "/";
        const path = url.split("?")[0] ?? "/";
        const method = request.method ?? "GET";

        const raw = await readBody(request, options.maxRequestBodyBytes);
        const tooLargeDetail = `a request body may not exceed ${String(options.maxRequestBodyBytes)} bytes`;
        if (!raw.ok && raw.reason === "ABORTED") {
          // The body never arrived whole, so there is no request to answer
          // (module header): nothing reaches the API, and the socket is closed.
          send(response, 413, JSON_CONTENT_TYPE, controlRefusalBody("CONTROL_BODY_TOO_LARGE", tooLargeDetail, []), true);
          return;
        }

        // The transport DECIDES; the API answers, after authorization (module header).
        let body: unknown;
        let refused: TransportRefusal | undefined;
        if (!raw.ok) {
          refused = transportRefusal(413, "CONTROL_BODY_TOO_LARGE", tooLargeDetail, []);
        } else if (raw.text !== "") {
          const parsed = parseJson(raw.text);
          if (!isJsonContentType(request.headers["content-type"])) {
            refused = transportRefusal(
              415,
              "CONTROL_UNSUPPORTED_MEDIA_TYPE",
              "a request body must be declared Content-Type: application/json (charset utf-8 or none); " +
                "it is read as UTF-8 JSON and as nothing else",
              [],
            );
            // Carried ONLY for the by-name mode-raise refusal; never acted on.
            if (parsed.ok) body = parsed.value;
          } else if (!parsed.ok) {
            refused = transportRefusal(400, "CONTROL_BODY_NOT_JSON", "the request body is not JSON", [parsed.message]);
          } else {
            body = parsed.value;
          }
        }

        const apiRequest: ApiRequest = {
          method,
          path,
          authorization: request.headers.authorization,
          body,
          ...(refused === undefined ? {} : { transportRefusal: refused }),
        };
        const answer = await options.api.handle(apiRequest);
        // A body refused for its SIZE was never drained: whatever the answer,
        // the connection closes once it is flushed.
        send(response, answer.status, answer.contentType, answer.body, !raw.ok, answer.allow);
      })();
    },
  );

  return new Promise<RunningControlHttpServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        port,
        timeouts: Object.freeze({
          headersTimeoutMs: server.headersTimeout,
          requestTimeoutMs: server.requestTimeout,
          keepAliveTimeoutMs: server.keepAliveTimeout,
        }),
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => {
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}
