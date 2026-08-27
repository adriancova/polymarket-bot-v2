/**
 * A transport binding for the Node 24 global `WebSocket`.
 *
 * WHY NO DEPENDENCY. `docs/contracts/dependency-direction.md` §7 starts with
 * "Prefer no dependency… Every dependency in the live trading process must have
 * a concrete purpose." Binance's public streams are plain WebSocket over TLS,
 * and Node 24 ships a WHATWG `WebSocket` in the global scope, so a client
 * library would buy nothing here. This file is a thin adapter from that
 * interface to {@link BinanceSocketFactory}, and it is the only file in the
 * package that touches a socket at all.
 *
 * WHY THE CONSTRUCTOR IS INJECTABLE. Tests run offline (no network in tests or
 * CI), so the constructor is a parameter with a global default. That makes the
 * decode path, the event mapping, and the endpoint guard testable without ever
 * opening a connection.
 *
 * WHAT IT DOES ABOUT THE UNDOCUMENTED FRAME OPCODE (`BNC-U1`). The venue does
 * not document whether market-data events arrive as text or binary frames on the
 * JSON endpoint, so this binding handles both: `binaryType` is set to
 * `"arraybuffer"` and a binary payload is decoded as UTF-8 with a *fatal*
 * decoder. A payload that is not valid UTF-8 becomes an `ERROR` event, never a
 * silently mangled frame — which is exactly the behavior ADR-004 §1 needs, since
 * a payload that cannot be represented as a UTF-8 string cannot be recorded in
 * the WAL's `payloadUtf8` either.
 *
 * NO CREDENTIALS. The constructor is called with a URL and nothing else: no
 * header, no API key, no signature. `web-socket-streams.md` requires none, and
 * the one Binance market-data endpoint that does require one is refused by
 * `./venue.ts` before a URL is ever built.
 */

import type { BinanceSocket, BinanceSocketFactory, BinanceSocketRequest } from "./connection.js";
import { BinanceConfigurationError } from "./errors.js";

/** The subset of the WHATWG `WebSocket` interface this binding uses. */
export type WebSocketLike = {
  binaryType: string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
};

/** A constructor producing a {@link WebSocketLike}. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * Resolves the runtime's global `WebSocket`.
 *
 * Fails with a typed configuration error rather than a `TypeError` deep inside
 * the connect path, because "this runtime has no WebSocket" is an operator
 * problem with an obvious fix and deserves to say so.
 */
export function resolveGlobalWebSocket(): WebSocketConstructor {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof candidate !== "function") {
    throw new BinanceConfigurationError(
      "this runtime exposes no global `WebSocket`; Node 24 does, and any other transport must be supplied as an explicit BinanceSocketFactory",
    );
  }
  return candidate as WebSocketConstructor;
}

/**
 * Builds a {@link BinanceSocketFactory} over a WHATWG `WebSocket`.
 *
 * The factory performs exactly one action — construct the socket and wire four
 * listeners. Reconnect timing, generations, and feed-status events belong to
 * `BinanceReferenceFeed`, which is what keeps the reconnect logic testable
 * without a network.
 */
export function createWebSocketFactory(
  webSocketConstructor?: WebSocketConstructor,
): BinanceSocketFactory {
  return (request: BinanceSocketRequest): BinanceSocket => {
    const Constructor = webSocketConstructor ?? resolveGlobalWebSocket();
    const socket = new Constructor(request.url);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      request.onEvent({ type: "OPEN", connectionId: request.connectionId });
    });

    socket.addEventListener("message", (event: unknown) => {
      const decoded = decodeMessageData(readProperty(event, "data"));
      if (decoded.ok) {
        request.onEvent({ type: "MESSAGE", data: decoded.text });
        return;
      }
      request.onEvent({
        type: "ERROR",
        reasonCode: "BINANCE_FRAME_UNDECODABLE",
        detail: decoded.detail,
      });
    });

    socket.addEventListener("error", (event: unknown) => {
      const message = readProperty(event, "message");
      request.onEvent({
        type: "ERROR",
        ...(typeof message === "string" && message.length > 0 ? { detail: message } : {}),
      });
    });

    socket.addEventListener("close", (event: unknown) => {
      const code = readProperty(event, "code");
      const reason = readProperty(event, "reason");
      request.onEvent({
        type: "CLOSE",
        ...(typeof code === "number" ? { code } : {}),
        ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
      });
    });

    return {
      close(code?: number, reason?: string): void {
        socket.close(code, reason);
      },
    };
  };
}

type DecodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Turns a WHATWG message payload into a string.
 *
 * A `TextDecoder` with `fatal: true` is used on purpose: a lenient decoder
 * substitutes U+FFFD for invalid bytes, which would hand the normalizer a frame
 * that is *nearly* the venue's and record a corrupted `payloadUtf8` downstream.
 */
export function decodeMessageData(data: unknown): DecodeResult {
  if (typeof data === "string") {
    return { ok: true, text: data };
  }
  if (data instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return decodeBytes(
      new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
    );
  }
  return {
    ok: false,
    detail: `message payload is ${data === null ? "null" : typeof data}; expected a string or binary payload (see BNC-U1)`,
  };
}

function decodeBytes(bytes: Uint8Array): DecodeResult {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail: `binary frame is not valid UTF-8 (${error instanceof Error ? error.message : "decode failed"}); it cannot be recorded in the WAL's payloadUtf8 either (ADR-004 §1)`,
    };
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
