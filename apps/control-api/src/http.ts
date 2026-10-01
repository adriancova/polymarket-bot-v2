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
 * refused `415` before the body is parsed. The body is decoded as UTF-8 and
 * parsed as JSON, so a request that declares something else is a request this
 * process would be reading as something its sender did not mean. (It was never
 * a CSRF path — the credential is a bearer header and the bind is loopback —
 * but a control surface that accepts any declared type is one whose input
 * grammar is narrower than its own documentation says.) A body-less request
 * needs no content type.
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
 * The three refusal bodies written here (`413`, `415`, `400`) are built by
 * `encodePlainJson` for the same reason `api.ts`'s `json()` is (`SER-3`,
 * `docs/handoffs/SER-0-sweep.md` `control-http-refusal-bodies`): they are
 * message-only at base, but a server whose ordinary bodies are own-data
 * encoded and whose refusal bodies are not would have two answers to "what
 * does `JSON.stringify` consult" — so it has one. The literals are plain
 * records the encoder cannot refuse.
 */

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ApiRequest, ControlApi } from "./api.js";

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

function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
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
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (refused) return;
      resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    request.on("error", () => {
      resolve({ ok: false });
    });
  });
}

/**
 * The body of a transport-level refusal, encoded from OWN DATA (`SER-3`).
 *
 * Exported so the six-context pin drives THIS function rather than a copy of
 * its literal: a polluted window may not span socket I/O (an inherited
 * `toJSON` installed across a macrotask corrupts vitest's own worker IPC —
 * measured), so the wire-level suites cannot hold one open across a request.
 * The three call sites below (`413`, `415`, `400`) are its only callers.
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
        if (!raw.ok) {
          send(
            response,
            413,
            "application/json; charset=utf-8",
            controlRefusalBody(
              "CONTROL_BODY_TOO_LARGE",
              `a request body may not exceed ${String(options.maxRequestBodyBytes)} bytes`,
              [],
            ),
            true,
          );
          return;
        }

        let body: unknown;
        if (raw.text !== "") {
          if (!isJsonContentType(request.headers["content-type"])) {
            send(
              response,
              415,
              "application/json; charset=utf-8",
              controlRefusalBody(
                "CONTROL_UNSUPPORTED_MEDIA_TYPE",
                "a request body must be declared Content-Type: application/json (charset utf-8 or none); " +
                  "it is read as UTF-8 JSON and as nothing else",
                [],
              ),
            );
            return;
          }
          try {
            body = JSON.parse(raw.text);
          } catch (cause) {
            send(
              response,
              400,
              "application/json; charset=utf-8",
              controlRefusalBody("CONTROL_BODY_NOT_JSON", "the request body is not JSON", [
                cause instanceof Error ? cause.message : String(cause),
              ]),
            );
            return;
          }
        }

        const apiRequest: ApiRequest = {
          method,
          path,
          authorization: request.headers.authorization,
          body,
        };
        const answer = await options.api.handle(apiRequest);
        send(response, answer.status, answer.contentType, answer.body, false, answer.allow);
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
