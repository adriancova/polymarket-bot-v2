/**
 * Run modes — handoff §11.
 *
 * | Mode | Data | Execution | Credentials |
 * |---|---|---|---|
 * | `BACKTEST` | Historical replay | Simulated | None |
 * | `PAPER` | Live | Simulated | Public only |
 * | `SHADOW` | Live | Simulated beside another run | Public only |
 * | `EXECUTION_PROBE` | Live | Tiny real calibration orders | Live signer |
 * | `LIVE_MICRO` | Live | Real, hard capped | Live signer |
 * | `LIVE` | Live | Real | Live signer |
 *
 * "A process has a maximum allowed mode. It cannot be raised through the control
 * API above the startup maximum." {@link assertRunModeWithinMaximum} is the
 * pure predicate that enforces that rule; the process that owns configuration
 * supplies the maximum. This module reads no environment variable and holds no
 * state, so it cannot be tricked into raising its own ceiling.
 */

import { z } from "zod";

import { RunModeNotPermittedError } from "./errors.js";

/**
 * The six run modes in escalation order, least to most capability.
 *
 * The order is the §11 table order and is the ordering used by
 * {@link compareRunMode}.
 */
export const RUN_MODES = [
  "BACKTEST",
  "PAPER",
  "SHADOW",
  "EXECUTION_PROBE",
  "LIVE_MICRO",
  "LIVE",
] as const;

export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

/** Rank of each mode in the escalation order (`BACKTEST` = 0 … `LIVE` = 5). */
export const RUN_MODE_RANK: Readonly<Record<RunMode, number>> = Object.freeze({
  BACKTEST: 0,
  PAPER: 1,
  SHADOW: 2,
  EXECUTION_PROBE: 3,
  LIVE_MICRO: 4,
  LIVE: 5,
});

/**
 * Modes that submit real orders to the venue (§11 "Execution" column).
 *
 * Used by the startup validation that implements §6 invariant 17 ("a real key
 * cannot be loaded by paper or backtest processes").
 */
export const RUN_MODE_PLACES_REAL_ORDERS: Readonly<Record<RunMode, boolean>> = Object.freeze({
  BACKTEST: false,
  PAPER: false,
  SHADOW: false,
  EXECUTION_PROBE: true,
  LIVE_MICRO: true,
  LIVE: true,
});

/** Modes that require a live signer (§11 "Credentials" column). */
export const RUN_MODE_REQUIRES_LIVE_SIGNER: Readonly<Record<RunMode, boolean>> = Object.freeze({
  BACKTEST: false,
  PAPER: false,
  SHADOW: false,
  EXECUTION_PROBE: true,
  LIVE_MICRO: true,
  LIVE: true,
});

/** Three-way comparison on the escalation order. */
export function compareRunMode(left: RunMode, right: RunMode): -1 | 0 | 1 {
  const a = RUN_MODE_RANK[left];
  const b = RUN_MODE_RANK[right];
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `mode` is strictly more capable than `maximum`. */
export function runModeExceeds(mode: RunMode, maximum: RunMode): boolean {
  return compareRunMode(mode, maximum) > 0;
}

/** True when `mode` is permitted for a process whose maximum is `maximum`. */
export function isRunModeWithinMaximum(mode: RunMode, maximum: RunMode): boolean {
  return !runModeExceeds(mode, maximum);
}

/**
 * Asserts that a requested run mode does not exceed the process maximum.
 *
 * @throws {RunModeNotPermittedError} when the requested mode is above the maximum.
 */
export function assertRunModeWithinMaximum(mode: RunMode, maximum: RunMode): RunMode {
  if (runModeExceeds(mode, maximum)) {
    throw new RunModeNotPermittedError(mode, maximum);
  }
  return mode;
}

/** Every mode permitted under a given process maximum, in escalation order. */
export function runModesWithinMaximum(maximum: RunMode): readonly RunMode[] {
  return RUN_MODES.filter((mode) => isRunModeWithinMaximum(mode, maximum));
}
