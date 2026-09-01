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

import type { CancelScheduled, GatewayClock, GatewayIdSource, GatewayTimers } from "./ports.js";

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
