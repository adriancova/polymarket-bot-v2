/**
 * The only module in this app that touches a runtime global.
 *
 * Everything else takes its clock, timers, and identifier source as a port
 * (`./ports.ts`); `main.ts` is the only importer of this module. That is the
 * same discipline every upstream package keeps (`runtime.ts` in
 * `polymarket-public`, `node-runtime.ts` in `coinbase-adapter`,
 * `node-file-system.ts` in `storage-wal`), and it is what keeps the whole
 * gateway offline-testable (§12.4).
 *
 * SAFETY: nothing here reads a credential. The gateway consumes public,
 * unauthenticated market data only.
 */

import { randomInt, randomUUID } from "node:crypto";

import type {
  CancelScheduled,
  GatewayClock,
  GatewayIdSource,
  GatewayLifetime,
  GatewayTimers,
  ReleaseLifetime,
} from "./ports.js";

/** Wall clock from `Date.now()`, monotonic nanoseconds from `process.hrtime.bigint()`. */
export function systemGatewayClock(): GatewayClock {
  return {
    nowMs: () => Date.now(),
    monotonicNs: () => process.hrtime.bigint(),
  };
}

/**
 * A canonical lowercase UUIDv7 whose 48 time bits come from `atMs`.
 *
 * The layout follows RFC 9562 §5.7: 48-bit unix-epoch milliseconds, version
 * nibble `7`, variant bits `10`, and 74 random bits. `Uuidv7Schema` in
 * `packages/domain` accepts exactly this shape.
 */
export function uuidV7At(atMs: number, randomByte: () => number): string {
  const timeHex = Math.max(0, Math.trunc(atMs)).toString(16).padStart(12, "0").slice(-12);
  let random = "";
  for (let index = 0; index < 9; index += 1) {
    random += randomByte().toString(16).padStart(2, "0");
  }
  const variant = "89ab".charAt(randomByte() % 4);
  return (
    `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${random.slice(0, 3)}-` +
    `${variant}${random.slice(3, 6)}-${random.slice(6, 18)}`
  );
}

/** Identifier source over `node:crypto`. */
export function systemGatewayIdSource(): GatewayIdSource {
  return {
    newUuid: () => randomUUID(),
    newEventId: (atMs: number) => uuidV7At(atMs, () => randomInt(0, 256)),
  };
}

/**
 * Timers over the host's `setTimeout`/`setInterval`.
 *
 * Handles are unref'd so scheduled work never holds the process open past a
 * requested shutdown — the same choice `polymarket-public`'s runtime makes.
 * The counterweight is `systemGatewayLifetime()` below: process liveness is
 * OWNED by the gateway's start/stop, never borrowed from a scheduled timer.
 */
export function systemGatewayTimers(): GatewayTimers {
  return {
    setTimeout: (handler, delayMs): CancelScheduled => {
      const handle = setTimeout(handler, delayMs);
      handle.unref?.();
      return () => {
        clearTimeout(handle);
      };
    },
    setInterval: (handler, intervalMs): CancelScheduled => {
      const handle = setInterval(handler, intervalMs);
      handle.unref?.();
      return () => {
        clearInterval(handle);
      };
    },
  };
}

/**
 * Node's timer-delay ceiling (2^31 − 1 ms ≈ 24.8 days). The lifetime anchor's
 * interval only bounds how often its no-op callback runs; the handle's
 * EXISTENCE is what holds the event loop, so the period is set to the maximum
 * the runtime accepts without clamping.
 */
const LIFETIME_ANCHOR_INTERVAL_MS = 2_147_483_647;

/**
 * The one deliberately REFERENCED handle in this app (round-2 review R2-H5).
 *
 * Everything `systemGatewayTimers()` schedules is unref'd, and at `e9cee46`
 * that meant a recording-only startup (transport down, publication halted, WAL
 * open) whose configured feed was waiting to reconnect held no referenced
 * handle at all: the real process printed "PUBLICATION HALTED, RECORDING
 * ONLY" and then exited 0 on its own, never reconnecting and never recording.
 * The same hole exists with a live transport whenever every feed is in
 * reconnect wait — a Redis socket holding the loop open is incidental, not
 * owned.
 *
 * `acquire()` takes a referenced no-op interval and returns its release;
 * `DataGateway.start()`/`stop()` own the exactly-once pairing. Release clears
 * the interval, so a requested shutdown still ends the process promptly — the
 * unref policy for ordinary timers is unchanged.
 */
export function systemGatewayLifetime(): GatewayLifetime {
  return {
    acquire: (): ReleaseLifetime => {
      // Deliberately NOT unref'd: this handle is the process's reason to live.
      const handle = setInterval(() => {
        // The handle's existence, not this callback, is the point.
      }, LIFETIME_ANCHOR_INTERVAL_MS);
      return () => {
        clearInterval(handle);
      };
    },
  };
}
