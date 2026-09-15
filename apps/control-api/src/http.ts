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
 * ## Every byte this server writes is encoded from own data
 *
 * The two refusal bodies written here (`413`, `400`) are built by
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

export interface ControlHttpServerOptions {
  readonly api: ControlApi;
  readonly host: string;
  readonly port: number;
  readonly maxRequestBodyBytes: number;
}

export interface RunningControlHttpServer {
  readonly port: number;
  close(): Promise<void>;
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
 * The two call sites below are its only callers.
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
): void {
  response.writeHead(status, {
    "content-type": contentType,
    // An operator surface is not cacheable and is not for a browser to sniff.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(close ? { connection: "close" } : {}),
  });
  response.end(body, () => {
    if (close) response.socket?.destroy();
  });
}

/** Starts the server. Resolves once it is listening. */
export function startControlHttpServer(
  options: ControlHttpServerOptions,
): Promise<RunningControlHttpServer> {
  const server: Server = createServer((request, response) => {
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
      send(response, answer.status, answer.contentType, answer.body);
    })();
  });

  return new Promise<RunningControlHttpServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        port,
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
