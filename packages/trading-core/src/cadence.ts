/**
 * `CADENCE-1` — the evaluation cadence (ADR-026): at most one `onFeatures`
 * evaluation per market per `evaluationIntervalMs` of EVENT time, plus a
 * heartbeat after `evaluationHeartbeatMs`.
 *
 * This module is PURE: it reads no clock, no environment and no I/O. Its only
 * input is the instants of the events the loop APPLIED (ADR-026 D2.1), in
 * delivery order, so which evaluations run is a function of the delivered
 * sequence and its recorded instants alone (D6). `CoreLoop` drives it, and
 * every composition root drives `CoreLoop`: the live PAPER trader and the
 * backtest share this one code path (ADR-022).
 *
 * ## The settings (ADR-026 D1)
 *
 * | Setting | Live PAPER, and every replay that is not a reproduction | A reproduction (D1.6) |
 * | --- | --- | --- |
 * | `intervalMs` | exactly {@link EVALUATION_INTERVAL_MS} (1,000) | 1,000, or 0 |
 * | `heartbeatMs` | exactly {@link EVALUATION_HEARTBEAT_MS} (5,000) | 5,000, or 0 |
 *
 * The value 0 (both settings) is ADR-024's per-frame cadence, unchanged, with
 * no heartbeat. Only a run that DECLARES what it reproduces — a golden, or a
 * run recorded under ADR-024 — may use it ({@link EvaluationCadenceOption}'s
 * `reproduces`). Every other value is refused: other values need a new
 * ruling (D1.5). {@link evaluationCadenceProblem} is the one policy.
 *
 * ## The rule (ADR-026 D2), per market
 *
 * - `now` is the high-water mark of the instants of APPLIED events. A refused
 *   event never reaches this module, and an earlier instant leaves `now`
 *   unchanged, so `now` never moves backwards (D2.1, D2.8).
 * - At a frame close, with `t = now`, a market is evaluated when it is owed and
 *   has no `last`, or it is owed and `t − last ≥ intervalMs`, or
 *   `t − last ≥ heartbeatMs` (D2.4). Its `last` then becomes `t` (D2.5).
 *   Otherwise a market that is owed stays owed — CARRIED — until a later close
 *   allows it (D2.6, D2.7).
 * - A market that has never been evaluated has no `last`, so it gets no
 *   heartbeat until it is first owed.
 *
 * ## The forward-jump alarm (ADR-026 D2.10)
 *
 * One applied event stamped far ahead moves `now` there, and later stamps
 * lie behind it: no market is evaluated again until `now` has moved on by the
 * interval. The rule does not recover early (an early recovery would let a
 * backward step add evaluations, which D2.8 forbids). So the clock RAISES AN
 * ALARM for every applied event whose instant lies MORE than the alarm bound
 * behind `now`: `heartbeatMs`, or {@link FORWARD_JUMP_ALARM_FALLBACK_MS} when
 * the heartbeat is off. Consecutive alarmed events form one EPISODE; the
 * first applied event within the bound ends it.
 */

/** ADR-026 D1.1: the default, and the only live value, of `evaluationIntervalMs`. */
export const EVALUATION_INTERVAL_MS = 1_000;
/** ADR-026 D1.2: the default, and the only live value, of `evaluationHeartbeatMs`. */
export const EVALUATION_HEARTBEAT_MS = 5_000;
/** ADR-026 D2.10: the alarm bound when the heartbeat is off (the per-frame cadence). */
export const FORWARD_JUMP_ALARM_FALLBACK_MS = 5_000;

/** The two run settings ADR-026 D1 pins in the run record. */
export interface EvaluationCadenceSettings {
  readonly intervalMs: number;
  readonly heartbeatMs: number;
}

/**
 * What a composition root hands the loop: the two settings and, for a
 * reproduction only, what it reproduces (ADR-026 D1.6).
 *
 * `reproduces` names the golden or the ADR-024 run being reproduced — for
 * example a golden's repository path or a run id — as 1 to 256 printable
 * ASCII characters without a space, so it can be printed on one line of an
 * artifact. It is REQUIRED for the per-frame value 0 and allowed with the
 * defaults. A live-data composition root never sets it.
 */
export interface EvaluationCadenceOption extends EvaluationCadenceSettings {
  readonly reproduces?: string;
}

/** ADR-026 D1.5: the cadence every live PAPER run, and every replay that is not a reproduction, uses. */
export const PAPER_EVALUATION_CADENCE: EvaluationCadenceSettings = Object.freeze({
  intervalMs: EVALUATION_INTERVAL_MS,
  heartbeatMs: EVALUATION_HEARTBEAT_MS,
});

/** ADR-026 D1.6: ADR-024's per-frame cadence, for a declared reproduction only. */
export const PER_FRAME_EVALUATION_CADENCE: EvaluationCadenceSettings = Object.freeze({
  intervalMs: 0,
  heartbeatMs: 0,
});

/** A `reproduces` label: printable ASCII, no space, 1-256 characters (one artifact line). */
const REPRODUCES_LABEL = /^[\x21-\x7e]{1,256}$/u;

/**
 * Why `option` is not an evaluation cadence a run may use, or `undefined` when
 * it is (ADR-026 D1.5-D1.6). TOTAL and pure: never throws, reads only `option`.
 *
 * - (1,000, 5,000): accepted, with or without `reproduces`;
 * - (0, 0): accepted ONLY with a valid `reproduces` label;
 * - anything else — another number, a mixed pair, a non-integer, a missing
 *   field — is refused: other values need a new ruling.
 */
export function evaluationCadenceProblem(option: unknown): string | undefined {
  if (typeof option !== "object" || option === null) {
    return "the evaluation cadence must be a record of intervalMs and heartbeatMs (ADR-026 D1)";
  }
  const intervalMs = ownValue(option, "intervalMs");
  const heartbeatMs = ownValue(option, "heartbeatMs");
  const reproduces = ownValue(option, "reproduces");
  if (reproduces !== undefined && (typeof reproduces !== "string" || !REPRODUCES_LABEL.test(reproduces))) {
    return (
      "reproduces must name the golden or the ADR-024 run being reproduced in 1-256 printable ASCII " +
      "characters without a space (ADR-026 D1.6)"
    );
  }
  if (intervalMs === EVALUATION_INTERVAL_MS && heartbeatMs === EVALUATION_HEARTBEAT_MS) return undefined;
  if (intervalMs === 0 && heartbeatMs === 0) {
    if (reproduces !== undefined) return undefined;
    return (
      "evaluationIntervalMs 0 (ADR-024's per-frame cadence) is accepted only by a replay that declares the " +
      "golden or the ADR-024 run it reproduces (ADR-026 D1.6); a live-data run, and every replay that is not " +
      "a reproduction, uses exactly 1000 ms and 5000 ms"
    );
  }
  return (
    `evaluationIntervalMs ${describe(intervalMs)} and evaluationHeartbeatMs ${describe(heartbeatMs)} are refused: ` +
    `a run uses exactly ${String(EVALUATION_INTERVAL_MS)} ms and ${String(EVALUATION_HEARTBEAT_MS)} ms, or 0 and 0 ` +
    "when it reproduces a golden or an ADR-024 run; other values need a new ruling (ADR-026 D1.5-D1.6)"
  );
}

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? (descriptor.value as unknown) : undefined;
}

function describe(value: unknown): string {
  return typeof value === "number" ? String(value) : value === undefined ? "(absent)" : `(${typeof value})`;
}

/**
 * The alarm transition an applied event caused (ADR-026 D2.10), for the
 * composition root's log line. `RAISED` starts an episode, `CLEARED` ends one.
 */
export interface CadenceAlarm {
  readonly kind: "RAISED" | "CLEARED";
  /** The applied event's own instant (strict UTC). */
  readonly eventAt: string;
  /** The cadence clock: the instant of the applied event that set `now`. */
  readonly clockAt: string;
  /** How far the event lies behind `now`, in milliseconds (0 or more). */
  readonly behindMs: number;
  /** The alarm bound: `heartbeatMs`, or 5,000 ms when the heartbeat is off. */
  readonly boundMs: number;
}

/** What {@link EvaluationCadenceClock.observeApplied} reports for one applied event. */
export interface CadenceObservation {
  /** `true` when the event lies more than the alarm bound behind `now`: count it. */
  readonly alarmed: boolean;
  /** The episode transition this event caused, if any. */
  readonly transition: CadenceAlarm | undefined;
}

/**
 * The D2 state of one run: `now`, each market's `last`, the carried set and
 * the alarm episode. See the module header. Every method is O(1).
 *
 * At the per-frame value 0 every owed market is due, nothing is carried and
 * there is no heartbeat: exactly ADR-024's cadence.
 */
export class EvaluationCadenceClock {
  readonly settings: EvaluationCadenceSettings;
  readonly #alarmBoundMs: number;
  #now: number | undefined;
  #nowAt = "";
  readonly #last = new Map<string, number>();
  readonly #carried = new Set<string>();
  #alarmActive = false;

  constructor(settings: EvaluationCadenceSettings) {
    this.settings = Object.freeze({ intervalMs: settings.intervalMs, heartbeatMs: settings.heartbeatMs });
    this.#alarmBoundMs = settings.heartbeatMs > 0 ? settings.heartbeatMs : FORWARD_JUMP_ALARM_FALLBACK_MS;
  }

  /** `true` at the per-frame value 0 (ADR-024's cadence, no carry, no heartbeat). */
  get perFrame(): boolean {
    return this.settings.intervalMs === 0;
  }

  /** The cadence clock, or `undefined` before the first applied event. */
  get now(): number | undefined {
    return this.#now;
  }

  /** The alarm bound (ADR-026 D2.10). */
  get alarmBoundMs(): number {
    return this.#alarmBoundMs;
  }

  /**
   * ADR-026 D2.1: one APPLIED event's instant moves the high-water mark, and
   * D2.10's alarm is judged against it. Called once per applied event, in
   * delivery order, and never for a refused one.
   */
  observeApplied(epochMs: number, at: string): CadenceObservation {
    if (this.#now === undefined || epochMs > this.#now) {
      this.#now = epochMs;
      this.#nowAt = at;
    }
    const behindMs = this.#now - epochMs;
    const alarmed = behindMs > this.#alarmBoundMs;
    let transition: CadenceAlarm | undefined;
    if (alarmed !== this.#alarmActive) {
      this.#alarmActive = alarmed;
      transition = Object.freeze({
        kind: alarmed ? "RAISED" : "CLEARED",
        eventAt: at,
        clockAt: this.#nowAt,
        behindMs,
        boundMs: this.#alarmBoundMs,
      });
    }
    return { alarmed, transition };
  }

  /**
   * ADR-026 D2.4 at a close whose `t` is the current `now`: may `marketId` be
   * evaluated now, given whether it is `owed`? Pure: moves nothing.
   */
  due(marketId: string, owed: boolean): boolean {
    if (this.perFrame) return owed;
    const t = this.#now;
    if (t === undefined) return false;
    const last = this.#last.get(marketId);
    if (last === undefined) return owed;
    const since = t - last;
    return (owed && since >= this.settings.intervalMs) || since >= this.settings.heartbeatMs;
  }

  /** ADR-026 D2.5: `marketId` is evaluated at this close; `last` becomes `t`, and it is owed nothing. */
  markEvaluated(marketId: string): void {
    this.#carried.delete(marketId);
    if (this.perFrame || this.#now === undefined) return;
    this.#last.set(marketId, this.#now);
  }

  /** ADR-026 D2.6: `marketId` was owed and not evaluated at this close; it stays owed. */
  carry(marketId: string): void {
    if (this.perFrame) return;
    this.#carried.add(marketId);
  }

  /** Is `marketId` still owed from an earlier close? */
  isCarried(marketId: string): boolean {
    return this.#carried.has(marketId);
  }

  /**
   * ADR-026 D2.11: a halted market is not evaluated, and its owed evaluation
   * is DROPPED, as a halted market's per-frame evaluation always was. Its
   * `last` is kept.
   */
  dropOwed(marketId: string): void {
    this.#carried.delete(marketId);
  }

  /** How many markets are still owed from an earlier close (for tests). */
  carriedCount(): number {
    return this.#carried.size;
  }
}
