/**
 * Deterministic test helpers for the Binance reference adapter.
 *
 * Exported as the `@polymarket-bot/binance-adapter/testing` subpath (the
 * `WP-050`/`WP-060` precedent) so a suite outside the package — the contract
 * tree under `test/contract/binance/**` — can drive the feed without a socket,
 * a timer, or a wall clock.
 *
 * Nothing here is used by the production path, and nothing here reaches the
 * network.
 */

import type { BinanceSocket, BinanceSocketEvent, BinanceSocketRequest } from "../connection.js";
import type { Clock, ReceiptStamp } from "../time.js";

/** Builds a receipt stamp from an explicit instant and monotonic reading. */
export function stampAt(receivedAt: string, receivedMonotonicNs: bigint | string): ReceiptStamp {
  return {
    receivedAt,
    receivedMonotonicNs:
      typeof receivedMonotonicNs === "string" ? receivedMonotonicNs : receivedMonotonicNs.toString(),
  };
}

/** A clock whose readings the test moves by hand. */
export type ManualClock = Clock & {
  /** Moves both readings forward by the same number of milliseconds. */
  advance(milliseconds: number): ReceiptStamp;
  /** The stamp the next `stamp()` would return, without advancing. */
  peek(): ReceiptStamp;
};

/**
 * Creates a deterministic clock.
 *
 * The wall clock and the monotonic clock advance together by default, which is
 * the ordinary case; a test that wants to exercise wall-clock skew sets them
 * apart with {@link stampAt} directly. Wall-clock instants are rendered with
 * millisecond precision, matching what `Date#toISOString` produces in
 * production.
 */
export function createManualClock(
  options: {
    readonly startAt?: string;
    readonly startMonotonicNs?: bigint;
  } = {},
): ManualClock {
  const startAt = options.startAt ?? "2026-08-27T00:00:00.000Z";
  const startMs = Date.parse(startAt);
  if (Number.isNaN(startMs)) {
    throw new TypeError(`startAt must be a parseable ISO-8601 instant, received ${startAt}`);
  }

  let wallMs = startMs;
  let monotonicNs = options.startMonotonicNs ?? 1_000_000_000n;

  const current = (): ReceiptStamp => ({
    receivedAt: new Date(wallMs).toISOString(),
    receivedMonotonicNs: monotonicNs.toString(),
  });

  return {
    stamp: current,
    peek: current,
    advance(milliseconds: number): ReceiptStamp {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new TypeError(
          `advance() takes a non-negative safe integer of milliseconds, received ${String(milliseconds)}`,
        );
      }
      wallMs += milliseconds;
      monotonicNs += BigInt(milliseconds) * 1_000_000n;
      return current();
    },
  };
}

/** A socket that records what it was asked to do and is driven by the test. */
export type ScriptedSocket = BinanceSocket & {
  readonly url: string;
  readonly connectionId: string;
  readonly closeCalls: readonly { readonly code?: number; readonly reason?: string }[];
  /** Delivers one transport event to the feed driver. */
  emit(event: BinanceSocketEvent): void;
};

/** A socket factory that hands every created socket back to the test. */
export function createScriptedSocketFactory(): {
  readonly factory: (request: BinanceSocketRequest) => BinanceSocket;
  readonly sockets: readonly ScriptedSocket[];
} {
  const sockets: ScriptedSocket[] = [];
  return {
    sockets,
    factory(request: BinanceSocketRequest): BinanceSocket {
      const closeCalls: { code?: number; reason?: string }[] = [];
      const socket: ScriptedSocket = {
        url: request.url,
        connectionId: request.connectionId,
        closeCalls,
        emit(event: BinanceSocketEvent): void {
          request.onEvent(event);
        },
        close(code?: number, reason?: string): void {
          closeCalls.push({
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
          });
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
}
