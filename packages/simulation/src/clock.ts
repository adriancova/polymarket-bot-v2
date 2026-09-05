/**
 * The replay clock (handoff §12.1).
 *
 * ```ts
 * interface Clock { now(): string; monotonicNs(): bigint; }
 * ```
 *
 * THE RULE THIS MODULE EXISTS TO KEEP. A replay must not know anything the live
 * process did not know at the same point (§6 invariant 15). A wall-clock read
 * inside a replay is exactly that leak: it makes the run depend on when it was
 * executed, which breaks §12.4 byte-identical determinism *and* lets a
 * strategy see an instant no recorded event carried. So:
 *
 * - **No production source in this package reads a clock.** No `Date`, no
 *   `Date.now()`, no `performance.now()`, no `process.hrtime`. The restricted
 *   packages already have that rule enforced by
 *   `tools/check-dependency-direction.mjs` (F11); this package holds itself to
 *   the same bar regardless of its layer, and `test/unit/simulation/purity.test.ts`
 *   scans these sources for it.
 * - **Time enters only from recorded events and from the manifest.** The clock
 *   is CONSTRUCTED at the manifest's recorded start-event identity and
 *   ADVANCES only when a recorded event is delivered.
 * - **There is deliberately no `advanceBy(duration)`.** A Tier-1 latency window
 *   is *arithmetic on recorded monotonic nanoseconds* ({@link addNanoseconds}),
 *   not a mutation of the clock: the venue computes the target instant and then
 *   consumes the recorded events that fall inside it. Nothing may move replay
 *   time except a recorded event.
 *
 * ORDERING AUTHORITY. `receivedMonotonicNs` is the per-process monotonic
 * reading (§7.1) and is the value the clock enforces monotonicity on. The
 * wall-clock `receivedAt` is NOT enforced monotone: `docs/contracts/wal-format.md`
 * §12.1 records that header and frame wall clocks are not monotonic, so
 * refusing a regression would assert an invariant the recording does not carry.
 * A regression is COUNTED and reported in {@link ReplayClockObservations}
 * instead of being either enforced or hidden.
 */

import { isIsoTimestamp, isUnsignedIntegerString, isoToEpochMilliseconds } from "./grammar.js";
import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
import {
  simulationFailure,
  simulationOk,
  type SimulationResult,
} from "./refusals.js";

/** The handoff §12.1 clock interface. */
export interface Clock {
  now(): string;
  monotonicNs(): bigint;
}

/** One recorded position: what a recorded event says the time was. */
export interface RecordedInstant {
  /** ISO-8601 `receivedAt`, verbatim from the recording (§7.1). */
  readonly receivedAt: string;
  /** `receivedMonotonicNs`, a canonical unsigned integer string (§7.1). */
  readonly receivedMonotonicNs: string;
}

/** What the clock saw, for a run report. Never used to make a decision. */
export interface ReplayClockObservations {
  readonly advances: number;
  /** Recorded wall-clock regressions. Observed, never enforced (see header). */
  readonly wallClockRegressions: number;
  readonly startedAt: string;
  readonly currentAt: string;
  readonly startedMonotonicNs: string;
  readonly currentMonotonicNs: string;
}

/**
 * A clock positioned by recorded events.
 *
 * `now()` and `monotonicNs()` are total and never throw: the clock cannot exist
 * unpositioned, because {@link createReplayClock} refuses to build one.
 */
export class ReplayClock implements Clock {
  readonly #startedAt: string;
  readonly #startedMonotonicNs: bigint;
  #at: string;
  #monotonicNs: bigint;
  #advances = 0;
  #wallClockRegressions = 0;
  #epochMilliseconds: number;

  private constructor(start: RecordedInstant, startEpochMilliseconds: number) {
    this.#startedAt = start.receivedAt;
    this.#at = start.receivedAt;
    this.#startedMonotonicNs = BigInt(start.receivedMonotonicNs);
    this.#monotonicNs = this.#startedMonotonicNs;
    this.#epochMilliseconds = startEpochMilliseconds;
  }

  /** Internal construction hook; {@link createReplayClock} is the door. */
  static positionedAt(start: RecordedInstant, startEpochMilliseconds: number): ReplayClock {
    return new ReplayClock(start, startEpochMilliseconds);
  }

  /** The recorded wall-clock instant of the last delivered event (§12.1). */
  now(): string {
    return this.#at;
  }

  /** The recorded monotonic reading of the last delivered event (§12.1). */
  monotonicNs(): bigint {
    return this.#monotonicNs;
  }

  /** Epoch milliseconds of {@link now}, derived arithmetically (never parsed). */
  epochMilliseconds(): number {
    return this.#epochMilliseconds;
  }

  /**
   * Moves the clock to a recorded instant.
   *
   * Refuses a monotonic regression: within one gateway epoch the recording is
   * one process, and a decreasing `receivedMonotonicNs` means the stream is not
   * in dispatch order — the failure §8.4 exists to prevent.
   */
  advanceTo(instant: RecordedInstant): SimulationResult<null> {
    // ONE READ PER FIELD (round-3 review, MEDIUM-1's class). This method runs
    // once per delivered event, so materializing here would copy a record per
    // event; instead each of the two PRIMITIVE fields is read exactly once,
    // into a local, and the validation and the state update use that local. No
    // accessor can answer the monotonicity check with one value and position the
    // clock with another.
    if (instant === null || typeof instant !== "object") {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a recorded instant is a record carrying receivedAt and receivedMonotonicNs (§7.1)",
      );
    }
    const receivedAt: unknown = instant.receivedAt;
    const receivedMonotonicNs: unknown = instant.receivedMonotonicNs;
    const validated = validateInstantFields(receivedAt, receivedMonotonicNs);
    if (!validated.ok) return validated;
    const nextNs = BigInt(validated.value.receivedMonotonicNs);
    if (nextNs < this.#monotonicNs) {
      return simulationFailure(
        "REPLAY_CLOCK_NOT_MONOTONE",
        "a recorded event carries a receivedMonotonicNs earlier than the clock's position; " +
          "replay follows information arrival order (§6 invariant 15, §8.4) and a regression " +
          "means the stream is not in dispatch order",
        {
          currentMonotonicNs: this.#monotonicNs.toString(),
          offeredMonotonicNs: validated.value.receivedMonotonicNs,
        },
      );
    }
    const nextEpochMs = validated.value.epochMilliseconds;
    if (nextEpochMs < this.#epochMilliseconds) {
      this.#wallClockRegressions += 1;
    }
    this.#at = validated.value.receivedAt;
    this.#monotonicNs = nextNs;
    this.#epochMilliseconds = nextEpochMs;
    this.#advances += 1;
    return simulationOk(null);
  }

  /** What the clock saw. Diagnostic; prototype-free and frozen. */
  observations(): ReplayClockObservations {
    return ownFrozenTree<ReplayClockObservations>({
      advances: this.#advances,
      wallClockRegressions: this.#wallClockRegressions,
      startedAt: this.#startedAt,
      currentAt: this.#at,
      startedMonotonicNs: this.#startedMonotonicNs.toString(),
      currentMonotonicNs: this.#monotonicNs.toString(),
    });
  }
}

/**
 * Validates the two PRIMITIVE fields of a §7.1 instant, already read out of it.
 *
 * It takes the VALUES rather than the record so that its caller can guarantee
 * one read per field: a validator that re-reads the record is a second read,
 * and two reads of a caller-supplied field are two chances to disagree.
 */
function validateInstantFields(
  receivedAt: unknown,
  receivedMonotonicNs: unknown,
): SimulationResult<{
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly epochMilliseconds: number;
}> {
  if (!isIsoTimestamp(receivedAt)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "receivedAt is not a §7.1 ISO-8601 timestamp with an explicit UTC designator or offset",
      { receivedAt: typeof receivedAt === "string" ? receivedAt : "(not a string)" },
    );
  }
  if (!isUnsignedIntegerString(receivedMonotonicNs)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "receivedMonotonicNs is not a canonical unsigned integer string (§7.1)",
      {
        receivedMonotonicNs:
          typeof receivedMonotonicNs === "string" ? receivedMonotonicNs : "(not a string)",
      },
    );
  }
  const epochMs = isoToEpochMilliseconds(receivedAt);
  if (epochMs === undefined) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "receivedAt could not be converted to epoch milliseconds arithmetically",
      { receivedAt },
    );
  }
  return simulationOk({ receivedAt, receivedMonotonicNs, epochMilliseconds: epochMs });
}

/**
 * Builds a replay clock positioned at a recorded start instant.
 *
 * The start instant comes from the dataset manifest's `eventRange.first`
 * (§12.5 "start/end event identity") or from the first delivered event. There
 * is no other way to position a clock in this package.
 *
 * D1 (round-3 review, MEDIUM-1): the start instant is a CALLER RECORD that the
 * clock keeps — `#startedAt` is printed in the §12.4 `clock` line — so it is
 * materialized once here rather than validated and then re-read by the
 * constructor. This runs once per run; {@link ReplayClock.advanceTo} runs once
 * per event and takes the cheaper one-read-per-field form instead.
 */
export function createReplayClock(offered: RecordedInstant): SimulationResult<ReplayClock> {
  const read = readOwnPlainInput<RecordedInstant>(offered, "the recorded start instant");
  if (!read.ok) return read;
  const start = read.value;
  if (start === null || typeof start !== "object") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a recorded instant is a record carrying receivedAt and receivedMonotonicNs (§7.1)",
    );
  }
  const validated = validateInstantFields(start.receivedAt, start.receivedMonotonicNs);
  if (!validated.ok) return validated;
  return simulationOk(
    ReplayClock.positionedAt(validated.value, validated.value.epochMilliseconds),
  );
}

/** Nanoseconds in one millisecond. Arithmetic constant, not a venue fact. */
export const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Recorded-monotonic arithmetic: `from + milliseconds`, exactly.
 *
 * This is how a Tier-1 latency window is expressed. It moves no clock; it names
 * an instant the replay then consumes recorded events up to.
 */
export function addMilliseconds(from: bigint, milliseconds: number): bigint {
  return from + BigInt(Math.trunc(milliseconds)) * NANOSECONDS_PER_MILLISECOND;
}

/** Recorded-monotonic arithmetic: `from + nanoseconds`, exactly. */
export function addNanoseconds(from: bigint, nanoseconds: bigint): bigint {
  return from + nanoseconds;
}
