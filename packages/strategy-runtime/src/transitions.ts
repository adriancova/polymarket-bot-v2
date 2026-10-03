/**
 * `CKPT-1` — ADR-027 Decision 1: WHICH persisted decisions owe a checkpoint.
 *
 * §9.6 and ADR-005 §5 say the runtime checkpoints "after defined transitions"
 * without naming them; `WP-170` decision 4 answered "after every persisted
 * decision". ADR-027 (the user's ruling A2) replaces that answer with six
 * transitions. After a persisted decision, a checkpoint is written only when
 * one of these holds:
 *
 * 1. **STATE** — the canonical state bytes differ from the last checkpoint's;
 * 2. **STATUS** — the instance status differs from the last checkpoint's;
 * 3. **RNG** — the seeded generator's state differs from the last
 *    checkpoint's;
 * 4. **START** — the first decision of the instance in the run;
 * 5. **STOP** — the decision of `onStop`;
 * 6. **HEARTBEAT** — at least {@link CHECKPOINT_HEARTBEAT_MS} of EVENT time
 *    (the decisions' `evaluatedAt`, never a wall clock) have passed since the
 *    last checkpoint's instant.
 *
 * Every other decision writes no checkpoint. So the last checkpoint always
 * holds the current state, status and RNG cursor (ADR-027 D2.1): a decision
 * that changed any of the three has one.
 *
 * PURE (ADR-027 D4.1). {@link checkpointTransitions} is a function of the
 * evaluations alone — the bytes, status and RNG lanes before and after, the
 * callback name, and two `evaluatedAt` strings — so which decisions write a
 * checkpoint is the same on every replay of the same dataset, settings and
 * seed. No clock, no I/O, no ambient state.
 *
 * TOTAL. Nothing here throws. An instant this module cannot read (the runtime's
 * input door validates `evaluatedAt` first, so this is a belt) makes the
 * heartbeat answer "due": the fail-safe direction is to WRITE a checkpoint,
 * never to skip one.
 *
 * WHAT "START" MEANS FOR A RESTORED RUNTIME. A runtime restored from a restore
 * point continues a run whose first decision already happened (and was
 * checkpointed, by this same rule). It therefore carries the restored
 * checkpoint as its last mark and applies rules 1-3, 5 and 6 to its first
 * decision exactly as the uninterrupted runtime would have — which is what
 * makes the checkpoints of a restored run byte-identical to an uninterrupted
 * run's (ADR-027 D4.2). START belongs to a runtime created WITHOUT a restore
 * point: the first decision it ever persists.
 */

import type { StrategyCallbackName } from "@polymarket-bot/strategy-sdk";

import type { InstanceStatus } from "./checkpoint.js";
import type { RngState } from "./rng.js";

/**
 * ADR-027 D1.6: the heartbeat, in milliseconds of event time. A WHOLE number
 * of seconds, which {@link elapsedAtLeast} relies on.
 */
export const CHECKPOINT_HEARTBEAT_MS = 60_000;

const HEARTBEAT_SECONDS = BigInt(CHECKPOINT_HEARTBEAT_MS / 1000);

/** The six ADR-027 D1 transitions, by name. */
export type CheckpointTransition = "START" | "STATE" | "STATUS" | "RNG" | "STOP" | "HEARTBEAT";

/** What the last checkpoint pinned, as the rule compares it. */
export interface CheckpointMark {
  /** The canonical state bytes of the last checkpoint. */
  readonly stateJson: string;
  readonly status: InstanceStatus;
  readonly rngState: RngState;
  /**
   * The `evaluatedAt` of the decision the last checkpoint follows: "the last
   * checkpoint's instant" (ADR-027 D1.6).
   */
  readonly evaluatedAt: string;
}

/** One persisted decision, as the rule sees it: what holds AFTER it. */
export interface CheckpointCandidate {
  readonly callback: StrategyCallbackName;
  readonly evaluatedAt: string;
  readonly stateJson: string;
  readonly status: InstanceStatus;
  readonly rngState: RngState;
}

/**
 * ADR-027 D1: the transitions a persisted decision makes, in the order of
 * Decision 1's list. EMPTY means the decision owes no checkpoint.
 *
 * PRECONDITION: both arguments are the runtime's own inert values (the mark it
 * saved, the bytes, status and lanes it computed, the `evaluatedAt` its input
 * door validated). A caller that hands it something else can make a property
 * read throw; the runtime never does.
 *
 * @param last the mark of the last checkpoint, or `undefined` when the runtime
 *   has written none and was not restored — its first decision is a START.
 */
export function checkpointTransitions(
  last: CheckpointMark | undefined,
  next: CheckpointCandidate,
): readonly CheckpointTransition[] {
  // Built from array LITERALS and spreads, never `push`: a literal defines its
  // elements (CreateDataProperty), while `push` ASSIGNS them, and an inherited
  // getter-only accessor on an index name makes that assignment throw (the
  // `schema-door.test.ts` pollution battery, `0/getOnly`).
  const fresh = last === undefined;
  return [
    ...(fresh ? (["START"] as const) : []),
    ...(!fresh && next.stateJson !== last.stateJson ? (["STATE"] as const) : []),
    ...(!fresh && next.status !== last.status ? (["STATUS"] as const) : []),
    ...(!fresh && !sameRngState(next.rngState, last.rngState) ? (["RNG"] as const) : []),
    ...(next.callback === "onStop" ? (["STOP"] as const) : []),
    ...(!fresh && elapsedAtLeast(last.evaluatedAt, next.evaluatedAt) !== false ? (["HEARTBEAT"] as const) : []),
  ];
}

function sameRngState(left: RngState, right: RngState): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3];
}

/**
 * An exact event-time instant: whole UTC seconds since the epoch, plus the
 * fractional digits as written (`""` when none). Exact at any precision the
 * domain's `IsoTimestampSchema` admits, so the heartbeat's boundary — exactly
 * 60 s due, 59.999 s not — never depends on floating point.
 */
export interface ExactInstant {
  readonly epochSeconds: bigint;
  readonly fraction: string;
}

/**
 * The forms `z.iso.datetime({ offset: true })` admits (zod 4.4.3): optional
 * seconds, any number of fractional digits, `Z` or `±HH:MM`.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/**
 * Reads one ISO-8601 instant exactly, or answers `undefined`. Never throws. The
 * calendar arithmetic is integer-only (no `Date`), so a year below 100 is not
 * re-based the way `Date.UTC` would re-base it.
 */
export function parseExactInstant(value: unknown): ExactInstant | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_INSTANT.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = withoutTrailingZeros(match[7] ?? "");
  const sign = match[8] === "-" ? -1 : 1;
  const offsetMinutes = match[8] === undefined ? 0 : Number(match[9]) * 60 + Number(match[10]);
  const days = daysFromCivil(year, month, day);
  const seconds =
    BigInt(days) * 86_400n +
    BigInt(hour * 3600 + minute * 60 + second) -
    BigInt(sign * offsetMinutes * 60);
  return { epochSeconds: seconds, fraction };
}

/** `"5000"` → `"5"`, `"000"` → `""`: a fraction's value without its trailing zeros. */
function withoutTrailingZeros(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end -= 1;
  return digits.slice(0, end);
}

/**
 * Days from 1970-01-01 to the given proleptic Gregorian date (Howard Hinnant's
 * `days_from_civil`), in integers only.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const shiftedMonth = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Compares two fractional-digit strings as the decimal fractions they are. */
function compareFractions(left: string, right: string): number {
  const width = Math.max(left.length, right.length);
  const a = left.padEnd(width, "0");
  const b = right.padEnd(width, "0");
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ADR-027 D1.6: have at least {@link CHECKPOINT_HEARTBEAT_MS} of event time
 * passed from `earlier` to `later`? Exact; `undefined` when either instant
 * cannot be read (the caller treats that as due). An instant that lies BEFORE
 * the earlier one has not passed 60 s.
 */
export function elapsedAtLeast(earlier: string, later: string): boolean | undefined {
  const from = parseExactInstant(earlier);
  const to = parseExactInstant(later);
  if (from === undefined || to === undefined) return undefined;
  const wholeSeconds = to.epochSeconds - from.epochSeconds;
  if (wholeSeconds > HEARTBEAT_SECONDS) return true;
  if (wholeSeconds < HEARTBEAT_SECONDS) return false;
  // Exactly the heartbeat's whole seconds apart: due unless the later
  // instant's fraction is smaller (then it is 59.x s).
  return compareFractions(to.fraction, from.fraction) >= 0;
}
