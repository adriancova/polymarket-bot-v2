/**
 * The ports this adapter needs from its host process.
 *
 * WHY PORTS AT ALL. Handoff §12.1 makes the swap between a live run and a
 * simulated one an interface boundary, and §12.4 makes replay deterministic.
 * A socket, a wall clock, a monotonic clock, and a timer are exactly the four
 * impure things this package touches, so they are declared here and injected.
 * The consequence that matters for this work package: every test in
 * `test/contract/coinbase` and every colocated unit test runs OFFLINE, because
 * nothing in the pure modules can reach a network.
 *
 * `node-runtime.ts` holds the only implementations that touch a global.
 */

/**
 * A frame as the transport delivers it.
 *
 * `string` is what the venue actually sends (ADR-004 §1 required Coinbase
 * framing to be verified; observation O-CB-1 found only UTF-8 text carrying
 * JSON). `Uint8Array` is present so a binary frame is *representable* and
 * therefore reportable: `payloadUtf8` in the WAL format cannot hold binary, so
 * a binary frame must surface as a typed anomaly rather than be decoded on a
 * guess or dropped.
 */
export type CoinbaseRawFrame = string | Uint8Array;

/** Wall-clock time, as an ISO-8601 string with an explicit offset. */
export interface WallClock {
  /** Current time as `IsoTimestampSchema` accepts it. */
  nowIso(): string;
}

/**
 * A monotonic nanosecond counter for §7.1 `receivedMonotonicNs`.
 *
 * Separate from {@link WallClock} because the envelope keeps both and they
 * answer different questions: the wall clock says when, the monotonic clock
 * orders receipts across a wall-clock adjustment. `bigint`, never `number`:
 * ADR-002 §1 states the field cannot be held exactly by a JavaScript number.
 */
export interface MonotonicClock {
  nowNs(): bigint;
}

/** A cancellable one-shot timer, so reconnect backoff is testable without waiting. */
export interface Timer {
  /** Schedules `run` after `delayMs`; the returned handle cancels it. */
  schedule(delayMs: number, run: () => void): TimerHandle;
}

export interface TimerHandle {
  cancel(): void;
}

/** What the adapter can do to an open socket. */
export interface CoinbaseSocket {
  /** Sends one text frame. */
  send(text: string): void;
  /** Requests an orderly close. Idempotent. */
  close(): void;
}

/** What the transport tells the adapter. */
export interface CoinbaseSocketListener {
  onOpen(): void;
  onFrame(frame: CoinbaseRawFrame): void;
  /**
   * The socket closed.
   *
   * `code` and `reason` are the WebSocket close frame's, when the transport
   * supplies them. Neither is required: a socket that dies without a close frame
   * still has to report the close, and inventing a code would misreport it.
   */
  onClose(info: { readonly code?: number; readonly reason?: string }): void;
  /** A transport-level error. The transport is expected to close afterwards. */
  onError(error: unknown): void;
}

/** Opens sockets. The only place a network endpoint is dialed. */
export interface CoinbaseSocketFactory {
  connect(endpoint: string, listener: CoinbaseSocketListener): CoinbaseSocket;
}
