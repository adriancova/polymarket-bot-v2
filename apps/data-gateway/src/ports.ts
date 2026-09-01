/**
 * The gateway's own injected ports.
 *
 * Every impure capability the gateway itself needs — wall clock, monotonic
 * counter, identifier minting, timers — arrives through a port, exactly as the
 * adapters and the WAL demand of their callers (§12.1, §12.4). `system.ts`
 * holds the only implementations that touch a runtime global, and nothing in
 * this app imports it except `main.ts`.
 *
 * The adapters' own ports (`PublicMarketClock`, `WalClock`, the Coinbase
 * `Timer`/`WallClock`/`MonotonicClock`, the Binance `ReceiptStamp` source) are
 * all derived from these two in `gateway.ts`, so one injected clock drives the
 * whole process and a test replays it deterministically.
 */

export interface GatewayClock {
  /** Wall-clock milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Monotonic nanoseconds from an arbitrary origin (§7.1 `receivedMonotonicNs`). */
  monotonicNs(): bigint;
}

/**
 * Identifier minting.
 *
 * - `newUuid` mints the `gatewayEpoch` (§7.1: "UUID assigned at gateway
 *   startup"; `UuidSchema` accepts any RFC 9562 version).
 * - `newEventId` mints §7.1 `eventId` values, which MUST be UUIDv7
 *   (`Uuidv7Schema`); the wall-clock instant is passed in so the time bits
 *   come from the injected clock, never from `Date.now()`.
 *
 * Connection ids are NOT minted here: they are derived deterministically per
 * feed in `connection-ids.ts`, because the WP-080 contract requires every
 * attempt to get an id the feed has never seen, and a counter proves that
 * where randomness only makes collisions unlikely.
 */
export interface GatewayIdSource {
  newUuid(): string;
  newEventId(atMs: number): string;
}

/** A cancellable scheduled callback. */
export type CancelScheduled = () => void;

/** Timer source, separated from the clock so tests drive time by hand. */
export interface GatewayTimers {
  setTimeout(handler: () => void, delayMs: number): CancelScheduled;
  setInterval(handler: () => void, intervalMs: number): CancelScheduled;
}

/** A receipt stamp: both §7.1 receipt fields, taken in one clock read. */
export interface GatewayReceipt {
  /** Wall-clock ISO-8601 instant. */
  readonly receivedAt: string;
  /** Monotonic nanoseconds as a canonical unsigned integer string. */
  readonly receivedMonotonicNs: string;
  /** The same wall-clock reading in milliseconds, for interval arithmetic. */
  readonly nowMs: number;
}

/** ISO-8601 instant with millisecond precision from epoch milliseconds. */
export function isoFromMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Takes one receipt stamp from the injected clock. */
export function takeReceipt(clock: GatewayClock): GatewayReceipt {
  const nowMs = clock.nowMs();
  return {
    receivedAt: isoFromMs(nowMs),
    receivedMonotonicNs: clock.monotonicNs().toString(),
    nowMs,
  };
}
