/**
 * A clock a test drives by hand.
 *
 * Every time-dependent behavior in this package — rotation by age, the fsync
 * interval, queue message age — is a function of an injected clock, so a test
 * asserts the policy without sleeping and without a flaky wall-clock race
 * (§12.4).
 */

import type { WalClock } from "../ports.js";

export type ManualClock = WalClock & {
  /** Advance both wall-clock and monotonic time by the same amount. */
  advance(milliseconds: number): void;
  /** Move wall-clock time only, leaving monotonic time alone (NTP step). */
  setWallClock(epochMs: number): void;
  /** Move monotonic time only. */
  advanceMonotonic(milliseconds: number): void;
};

export type ManualClockOptions = {
  /** Initial wall clock. Default: 2026-01-01T00:00:00.000Z. */
  readonly startEpochMs?: number;
  /** Initial monotonic reading. Default: 0. */
  readonly startMonotonicMs?: number;
};

export const DEFAULT_TEST_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

export function createManualClock(options: ManualClockOptions = {}): ManualClock {
  let wallMs = options.startEpochMs ?? DEFAULT_TEST_EPOCH_MS;
  let monotonicMs = options.startMonotonicMs ?? 0;
  return {
    nowMs: () => wallMs,
    monotonicMs: () => monotonicMs,
    advance(milliseconds: number): void {
      wallMs += milliseconds;
      monotonicMs += milliseconds;
    },
    setWallClock(epochMs: number): void {
      wallMs = epochMs;
    },
    advanceMonotonic(milliseconds: number): void {
      monotonicMs += milliseconds;
    },
  };
}
