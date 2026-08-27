/**
 * The only implementations in this package that touch a global.
 *
 * Everything else here is pure or depends on a port. Keeping the impure surface
 * in one small file is what makes "this adapter reads no configuration and no
 * environment" a checkable claim rather than an assertion: there is exactly one
 * file to read, and it reads a clock, a timer, and a socket — nothing else.
 *
 * NODE 24, NO NEW DEPENDENCY. Node 24 ships a global `WebSocket`, so no `ws`
 * package is declared and the lockfile grows by nothing on this account. The
 * feed is plain public WebSocket over TLS; no SDK and no credential is involved.
 *
 * NOT USED BY ANY TEST. Every test in this package and in
 * `test/contract/coinbase` runs against injected ports, so nothing here is
 * reachable from the suites and no test can open a socket.
 */

import { CoinbaseTransportError } from "./errors.js";
import type {
  CoinbaseSocket,
  CoinbaseSocketFactory,
  CoinbaseSocketListener,
  MonotonicClock,
  Timer,
  TimerHandle,
  WallClock,
} from "./ports.js";

/** Wall clock reading `Date`, formatted as the repository's ISO timestamp. */
export const systemWallClock: WallClock = {
  nowIso(): string {
    return new Date().toISOString();
  },
};

/**
 * Monotonic clock reading `process.hrtime.bigint()`.
 *
 * `bigint` end to end: §7.1 `receivedMonotonicNs` is a canonical unsigned
 * integer string precisely because a JavaScript number cannot hold nanoseconds
 * exactly (ADR-002 §1), so the value is never widened to a float on the way.
 */
export const systemMonotonicClock: MonotonicClock = {
  nowNs(): bigint {
    return process.hrtime.bigint();
  },
};

/** Timer backed by `setTimeout`, with the handle unref'd so it cannot hold the process open. */
export const systemTimer: Timer = {
  schedule(delayMs: number, run: () => void): TimerHandle {
    const handle = setTimeout(run, delayMs);
    handle.unref();
    return {
      cancel(): void {
        clearTimeout(handle);
      },
    };
  },
};

/**
 * Socket factory over Node's global `WebSocket`.
 *
 * The endpoint is passed through unchanged and no header, query parameter, or
 * subprotocol is added: the documented public endpoint needs none, and adding
 * one would be the first step toward a credential.
 *
 * A `message` event whose `data` is not a string is forwarded as bytes rather
 * than decoded. ADR-004 §1 keeps binary frames out of the raw-frame format, so a
 * binary frame has to reach the processor *as* a binary frame to be reported as
 * one; decoding it here would hide the very fact that needs reporting.
 */
export const nodeWebSocketFactory: CoinbaseSocketFactory = {
  connect(endpoint: string, listener: CoinbaseSocketListener): CoinbaseSocket {
    if (!endpoint.startsWith("wss://")) {
      // Public market data over plaintext would be an operator error, and this
      // package has no reason to ever dial one.
      throw new CoinbaseTransportError("the Coinbase endpoint must be a wss:// URL", { endpoint });
    }
    const socket = new WebSocket(endpoint);
    socket.addEventListener("open", () => {
      listener.onOpen();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === "string") {
        listener.onFrame(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        listener.onFrame(new Uint8Array(data));
        return;
      }
      if (ArrayBuffer.isView(data)) {
        listener.onFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        return;
      }
      // Something neither text nor bytes. Reported as a zero-length binary frame
      // rather than coerced to a string, which would fabricate a payload.
      listener.onFrame(new Uint8Array(0));
    });
    socket.addEventListener("error", (event: Event) => {
      listener.onError(event);
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      listener.onClose({
        ...(typeof event.code === "number" ? { code: event.code } : {}),
        ...(typeof event.reason === "string" && event.reason.length > 0
          ? { reason: event.reason }
          : {}),
      });
    });

    return {
      send(text: string): void {
        socket.send(text);
      },
      close(): void {
        socket.close();
      },
    };
  },
};
