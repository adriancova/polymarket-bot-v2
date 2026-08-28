/**
 * The only module in this package that touches a runtime global.
 *
 * Everything else takes its clock, timers, socket, HTTP client and identifier
 * source as a port (`./ports.ts`). This module supplies the Node 24
 * implementations, and nothing inside the package imports it — a composition
 * root chooses it explicitly. That is what keeps the rest of the package
 * offline-testable and replayable (§12.4).
 *
 * Node 24 provides `WebSocket`, `fetch`, and `crypto.randomUUID` as globals, so
 * this package needs no transport dependency at all. It notably does NOT use
 * `@polymarket/client`: F6 grants the unified SDK exclusively to
 * `packages/polymarket-secure` (`docs/contracts/dependency-direction.md` §3,
 * handoff §9.12), and this adapter reads only public, unauthenticated data.
 *
 * SAFETY: no credential, header, signer, or wallet appears on any path here.
 */

import type {
  PublicHttpClient,
  PublicMarketClock,
  PublicMarketTimers,
  PublicWebSocket,
  PublicWebSocketFactory,
  PublicWebSocketHandlers,
} from "./ports.js";

/**
 * Wall clock from `Date.now()`, monotonic time from `performance.now()`.
 *
 * Intervals use the monotonic source so that an NTP step cannot make a healthy
 * feed look stale, or a dead one look alive.
 */
export function systemPublicMarketClock(): PublicMarketClock {
  return {
    nowMs: () => Date.now(),
    monotonicMs: () => performance.now(),
  };
}

/** Timers backed by the host's `setTimeout` / `setInterval`. */
export function systemPublicMarketTimers(): PublicMarketTimers {
  return {
    setTimeout: (handler, delayMs) => {
      const handle = setTimeout(handler, delayMs);
      // Timers must not hold the process open: a paper run that finished should
      // exit even with a reconnect scheduled.
      handle.unref?.();
      return () => {
        clearTimeout(handle);
      };
    },
    setInterval: (handler, intervalMs) => {
      const handle = setInterval(handler, intervalMs);
      handle.unref?.();
      return () => {
        clearInterval(handle);
      };
    },
  };
}

/**
 * A socket factory over the global `WebSocket`.
 *
 * The port contract requires `onClose` after `onError`, which the WHATWG
 * WebSocket satisfies: an error is followed by a close event. Binary frames are
 * decoded as UTF-8 text, because the market channel is a text protocol — its
 * heartbeat is the literal string `PING`.
 */
export function globalWebSocketFactory(): PublicWebSocketFactory {
  return (url: string, handlers: PublicWebSocketHandlers): PublicWebSocket => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      handlers.onOpen();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      handlers.onMessage(decodeFrameData(event.data));
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      handlers.onClose({ code: event.code, reason: event.reason });
    });
    socket.addEventListener("error", (event: Event) => {
      handlers.onError(event);
    });
    return {
      send: (data: string) => {
        socket.send(data);
      },
      close: () => {
        socket.close();
      },
    };
  };
}

function decodeFrameData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return String(data);
}

/**
 * An HTTP client over the global `fetch`.
 *
 * It sends exactly two headers and neither of them authenticates anything:
 * `accept` and, on a POST, `content-type`. There is no code path here that can
 * carry a credential.
 */
export function globalHttpClient(): PublicHttpClient {
  return async (request) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (request.jsonBody !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      ...(request.jsonBody === undefined ? {} : { body: JSON.stringify(request.jsonBody) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return { status: response.status, body: await response.text() };
  };
}

/** Connection identifiers from `crypto.randomUUID()`. */
export function randomConnectionId(): () => string {
  return () => crypto.randomUUID();
}

/** Jitter source for the reconnect backoff. */
export function randomJitter(): () => number {
  return () => Math.random();
}
