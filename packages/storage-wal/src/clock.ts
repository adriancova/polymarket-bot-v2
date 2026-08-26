/**
 * The default {@link WalClock}.
 *
 * This is the only module in the package that reads a real clock, and nothing
 * imports it except a composition root that chooses to. Every other module
 * takes the clock as a parameter (§12.4).
 */

import type { WalClock } from "./ports.js";

/** ISO-8601 UTC instant with milliseconds, from epoch milliseconds. */
export function isoFromEpochMs(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`epoch milliseconds must be finite, received ${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}

/**
 * Wall clock from `Date.now()`, monotonic time from `performance.now()`.
 *
 * `performance.now()` is used for intervals so that an NTP step or a manual
 * clock change cannot make a segment look older or younger than it is.
 */
export function systemWalClock(): WalClock {
  return {
    nowMs: () => Date.now(),
    monotonicMs: () => performance.now(),
  };
}
