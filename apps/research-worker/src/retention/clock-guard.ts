/**
 * A guard against the wall clock stepping forward (`STORAGE-1`; the HOST-1
 * clock alert does not exist yet, and an alert would not stop a deletion).
 *
 * ADR-028 Decision 2.1 measures a segment's age by the wall clock against its
 * frames' receipt stamps. A forward step of the host clock would make every
 * segment look older by the size of the step and let it expire early. This
 * guard measures, between storage cycles on the same boot, how far the wall
 * clock moved against the time since boot, and treats any unexplained
 * forward movement as **skew**: the storage cycle's "now" is the wall clock
 * LESS the accumulated skew, so a forward step can never shorten the 72 hours.
 *
 * - Same boot: `delta = (wall − previous wall) − (since-boot − previous
 *   since-boot)`. A |delta| within the tolerance is ordinary drift. A larger
 *   positive delta is a forward step and adds to the skew; a larger negative
 *   one (the clock corrected back) subtracts from it. The skew never goes
 *   below zero: the guard can only make "now" earlier, never later.
 * - Within one cycle, "now" can never run ahead of the monotonic clock since
 *   the cycle started (plus the tolerance), so a step during a cycle cannot
 *   reach the deletions after it.
 * - A new boot (or no previous reading) cannot be measured: the skew carries
 *   over unchanged. A step while the host is down is not detected — that is
 *   the residual the host clock discipline (`HOST-1`) must close.
 *
 * Time since boot is read from `/proc/uptime` (Linux `CLOCK_BOOTTIME`, which
 * counts suspend, so a laptop's sleep is not a step). Where that is
 * unavailable, the process's monotonic clock is used, which does not count
 * suspend: a sleep then reads as a forward step, which only delays expiry.
 *
 * The state is one small file in the state directory. Removing it resets the
 * skew to zero; do that only after checking the host clock (for example
 * `chronyc tracking`). The skew is reported in the metrics.
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";

import type { CompactionClock } from "@polymarket-bot/storage-parquet";
import { parseStrictJsonBytes } from "@polymarket-bot/storage-parquet";

/** The clock-guard state file in the state directory. */
export const CLOCK_STATE_FILE_NAME = "clock-state.json";

/** The version of the state file. */
export const CLOCK_STATE_VERSION = 1;

/** Ordinary drift between two cycles, below which nothing is a step. */
export const DEFAULT_CLOCK_STEP_TOLERANCE_MS = 60_000;

/** The time since boot, and which boot. */
export interface BootClock {
  bootId(): Promise<string | null>;
  sinceBootMs(): Promise<number>;
}

/** The host's: `/proc/sys/kernel/random/boot_id` and `/proc/uptime`, else `os.uptime()`. */
export function systemBootClock(): BootClock {
  return {
    async bootId(): Promise<string | null> {
      try {
        return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || null;
      } catch {
        return null;
      }
    },
    async sinceBootMs(): Promise<number> {
      try {
        const seconds = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/u)[0]);
        if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
      } catch {
        // Fall through to the portable reading.
      }
      return Math.round(uptime() * 1000);
    },
  };
}

/** What the guard concluded this cycle. */
export type ClockAssessment = {
  readonly status: "unchecked" | "first-reading" | "new-boot" | "steady" | "forward-step" | "backward-step";
  /** This cycle's step, in ms (positive forward), or 0. */
  readonly stepMs: number;
  /** The accumulated forward skew subtracted from the wall clock. */
  readonly skewMs: number;
};

type ClockState = {
  readonly clockStateVersion: number;
  readonly wallMs: number;
  readonly sinceBootMs: number;
  readonly bootId: string | null;
  readonly skewMs: number;
};

async function readState(path: string): Promise<ClockState | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = parseStrictJsonBytes(bytes) as Partial<ClockState> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    value.clockStateVersion !== CLOCK_STATE_VERSION ||
    typeof value.wallMs !== "number" ||
    typeof value.sinceBootMs !== "number" ||
    typeof value.skewMs !== "number" ||
    value.skewMs < 0 ||
    !(value.bootId === null || typeof value.bootId === "string")
  ) {
    // An unreadable state is not "no skew": refuse, and let the operator look.
    throw new Error(`the clock-guard state ${path} is not one this build reads; check the host clock, then remove it`);
  }
  return value as ClockState;
}

async function writeState(path: string, state: ClockState): Promise<void> {
  const temporary = `${path}.${process.pid.toString(36)}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

/**
 * Assess the wall clock against the previous cycle's reading, persist this
 * reading, and return the skew to subtract. `stateDirectory` or `bootClock`
 * `null`: nothing is measured (the skew is 0, `unchecked`).
 */
export async function assessClock(input: {
  readonly stateDirectory: string | null;
  readonly wallMs: number;
  readonly bootClock: BootClock | null;
  readonly toleranceMs: number;
}): Promise<ClockAssessment> {
  if (input.stateDirectory === null || input.bootClock === null) return { status: "unchecked", stepMs: 0, skewMs: 0 };
  await mkdir(input.stateDirectory, { recursive: true });
  const path = join(input.stateDirectory, CLOCK_STATE_FILE_NAME);
  const previous = await readState(path);
  const bootId = await input.bootClock.bootId();
  const sinceBootMs = await input.bootClock.sinceBootMs();
  let assessment: ClockAssessment;
  if (previous === null) {
    assessment = { status: "first-reading", stepMs: 0, skewMs: 0 };
  } else if (previous.bootId !== bootId || bootId === null || sinceBootMs < previous.sinceBootMs) {
    assessment = { status: "new-boot", stepMs: 0, skewMs: previous.skewMs };
  } else {
    const delta = input.wallMs - previous.wallMs - (sinceBootMs - previous.sinceBootMs);
    if (Math.abs(delta) <= input.toleranceMs) {
      assessment = { status: "steady", stepMs: 0, skewMs: previous.skewMs };
    } else {
      assessment = {
        status: delta > 0 ? "forward-step" : "backward-step",
        stepMs: delta,
        skewMs: Math.max(0, previous.skewMs + delta),
      };
    }
  }
  await writeState(path, {
    clockStateVersion: CLOCK_STATE_VERSION,
    wallMs: input.wallMs,
    sinceBootMs,
    bootId,
    skewMs: assessment.skewMs,
  });
  return assessment;
}

/**
 * The cycle's clock: the wall clock less the skew, and never ahead of the
 * monotonic time since the cycle started (plus the tolerance).
 */
export function guardedClock(base: CompactionClock, skewMs: number, toleranceMs: number): CompactionClock {
  const startWallMs = base.nowMs();
  const startMonotonicMs = base.monotonicMs();
  return {
    nowMs: () => Math.min(base.nowMs() - skewMs, startWallMs - skewMs + (base.monotonicMs() - startMonotonicMs) + toleranceMs),
    monotonicMs: () => base.monotonicMs(),
  };
}
