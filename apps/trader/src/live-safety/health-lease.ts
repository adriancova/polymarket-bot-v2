/**
 * The heartbeat health lease (WP-320 deliverable 3; handoff §9.18; ADR-008
 * §3; ADR-033 D1 item 2).
 *
 * > "The heartbeat health lease requires recent proof from market data, user
 * > data, event loop, OMS, database, reconciler, and kill-switch state. A
 * > process that is alive but unhealthy must stop heartbeats." — §9.18
 *
 * A lease on HEALTH, not on liveness (ADR-008 §3): being able to answer is
 * not evidence of anything. Each of the seven inputs is a
 * {@link HealthProofSource} the composition binds, and {@link HealthLease.evaluate}
 * asks EVERY ONE of them at EVERY evaluation. Nothing is cached between
 * evaluations: a source answers with the monotonic instant of its latest
 * positive evidence, and the lease holds only if that instant is no older than
 * the input's configured maximum age and not in the future. So a proof can
 * never be "cached forever": a source that keeps answering with an old
 * instant fails the lease once the instant ages out, whatever it says.
 *
 * Fail closed throughout: a missing input, a source that throws, answers
 * with anything but the two shapes below, reports a future instant, or is
 * older than its bound, fails the lease and names itself.
 *
 * Evaluation is synchronous and does no I/O: the asynchronous evidence (a
 * database round trip, a kill-switch read) is gathered by the composition's
 * refreshers, which RECORD their outcome in a {@link ProofBoard}. So the
 * whole check completes "well inside 5 seconds" (ADR-008 §4 consequence 2).
 */

import type { MonotonicClock } from "./ports.js";

/** The seven inputs of §9.18, in its order. */
export const HEALTH_INPUTS = Object.freeze(["MARKET_DATA", "USER_DATA", "EVENT_LOOP", "OMS", "DATABASE", "RECONCILER", "KILL_SWITCH"] as const);

export type HealthInput = (typeof HEALTH_INPUTS)[number];

/**
 * A source's answer: `{ healthy: true, provenAtMs }`, the monotonic instant of
 * its latest positive evidence; or `{ healthy: false, reason }`, a closed code.
 */
export type HealthProofReading = { readonly healthy: true; readonly provenAtMs: number } | { readonly healthy: false; readonly reason: string };

export interface HealthProofSource {
  read(): HealthProofReading;
}

export interface HealthFailure {
  readonly input: HealthInput;
  readonly reason: string;
}

export interface HealthVerdict {
  readonly healthy: boolean;
  readonly failures: readonly HealthFailure[];
  /** The gate reason codes the heartbeat controller reports: `HEALTH_<INPUT>_<REASON>`. */
  readonly reasons: readonly string[];
  readonly atMs: number | null;
}

export class HealthLeaseConfigurationError extends Error {
  override readonly name = "HealthLeaseConfigurationError";
  constructor(readonly field: string) {
    super(`health lease configuration refused: ${field}`);
    Object.freeze(this);
  }
}

const REASON = /^[A-Z][A-Z0-9_]{0,47}$/u;
/** The longest a proof may be trusted, whatever the configuration says (one minute): a guard, not a venue fact. */
export const MAX_PROOF_AGE_MS = 60_000;

function readReading(value: unknown): HealthProofReading | { readonly healthy: false; readonly reason: "UNREADABLE" } {
  if (typeof value !== "object" || value === null) return { healthy: false, reason: "UNREADABLE" };
  const healthy = Object.getOwnPropertyDescriptor(value, "healthy");
  if (healthy === undefined || !("value" in healthy)) return { healthy: false, reason: "UNREADABLE" };
  if (healthy.value === true) {
    const proven = Object.getOwnPropertyDescriptor(value, "provenAtMs");
    const at: unknown = proven !== undefined && "value" in proven ? proven.value : undefined;
    return typeof at === "number" && Number.isFinite(at) ? { healthy: true, provenAtMs: at } : { healthy: false, reason: "UNREADABLE" };
  }
  if (healthy.value === false) {
    const reason = Object.getOwnPropertyDescriptor(value, "reason");
    const text: unknown = reason !== undefined && "value" in reason ? reason.value : undefined;
    return { healthy: false, reason: typeof text === "string" && REASON.test(text) ? text : "UNHEALTHY" };
  }
  return { healthy: false, reason: "UNREADABLE" };
}

export interface HealthLeaseOptions {
  readonly clock: MonotonicClock;
  /** Exactly the seven inputs; none may be missing. */
  readonly sources: Readonly<Record<HealthInput, HealthProofSource>>;
  /** Per input, the oldest proof the lease accepts, in ms (1 … {@link MAX_PROOF_AGE_MS}). */
  readonly maxAgeMs: Readonly<Record<HealthInput, number>>;
}

export class HealthLease {
  readonly #clock: MonotonicClock;
  readonly #sources: ReadonlyMap<HealthInput, HealthProofSource>;
  readonly #maxAge: ReadonlyMap<HealthInput, number>;

  constructor(options: HealthLeaseOptions) {
    if (typeof options !== "object" || options === null) throw new HealthLeaseConfigurationError("options");
    const sources = new Map<HealthInput, HealthProofSource>();
    const maxAge = new Map<HealthInput, number>();
    for (const input of HEALTH_INPUTS) {
      const source = Object.hasOwn(options.sources, input) ? options.sources[input] : undefined;
      if (typeof source !== "object" || source === null || typeof source.read !== "function") throw new HealthLeaseConfigurationError(`sources.${input}`);
      sources.set(input, source);
      const age = Object.hasOwn(options.maxAgeMs, input) ? options.maxAgeMs[input] : undefined;
      if (typeof age !== "number" || !Number.isSafeInteger(age) || age < 1 || age > MAX_PROOF_AGE_MS) throw new HealthLeaseConfigurationError(`maxAgeMs.${input}`);
      maxAge.set(input, age);
    }
    for (const key of Object.keys(options.sources)) {
      if (!(HEALTH_INPUTS as readonly string[]).includes(key)) throw new HealthLeaseConfigurationError(`sources.${key}`);
    }
    this.#clock = options.clock;
    this.#sources = sources;
    this.#maxAge = maxAge;
  }

  /** Ask every input now. Healthy only if all seven prove themselves within their bounds. */
  evaluate(): HealthVerdict {
    let now: number | null;
    try {
      const value = this.#clock.monotonicMs();
      now = Number.isFinite(value) ? value : null;
    } catch {
      now = null;
    }
    const failures: HealthFailure[] = [];
    for (const input of HEALTH_INPUTS) {
      if (now === null) {
        failures.push({ input, reason: "CLOCK_UNREADABLE" });
        continue;
      }
      const source = this.#sources.get(input);
      const bound = this.#maxAge.get(input);
      if (source === undefined || bound === undefined) {
        failures.push({ input, reason: "NOT_CONFIGURED" });
        continue;
      }
      let reading: ReturnType<typeof readReading>;
      try {
        reading = readReading(source.read());
      } catch {
        reading = { healthy: false, reason: "SOURCE_THREW" };
      }
      if (!reading.healthy) {
        failures.push({ input, reason: reading.reason });
        continue;
      }
      if (reading.provenAtMs > now) {
        failures.push({ input, reason: "PROOF_IN_FUTURE" });
        continue;
      }
      if (now - reading.provenAtMs > bound) failures.push({ input, reason: "PROOF_STALE" });
    }
    return Object.freeze({
      healthy: failures.length === 0,
      failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
      reasons: Object.freeze(failures.map((failure) => `HEALTH_${failure.input}_${failure.reason}`)),
      atMs: now,
    });
  }
}

/**
 * Where the composition's refreshers and subsystems record their evidence:
 * `prove(input, atMs)` after positive evidence observed at `atMs` (monotonic),
 * `fail(input, reason)` when the latest evidence is negative. The board keeps
 * only the LATEST outcome per input; its age is judged by the lease at every
 * evaluation, so a proof recorded once and never again fails the lease once
 * it is older than the input's bound. An input never recorded reads
 * `NO_PROOF`.
 */
export class ProofBoard {
  readonly #latest = new Map<HealthInput, HealthProofReading>();

  prove(input: HealthInput, atMs: number): void {
    if (!Number.isFinite(atMs)) {
      this.fail(input, "PROOF_TIME_INVALID");
      return;
    }
    const current = this.#latest.get(input);
    // A proof never moves backwards: an older proof arriving late does not replace a newer one.
    if (current !== undefined && current.healthy && current.provenAtMs > atMs) return;
    const proof: HealthProofReading = { healthy: true, provenAtMs: atMs };
    this.#latest.set(input, Object.freeze(proof));
  }

  fail(input: HealthInput, reason: string): void {
    const failure: HealthProofReading = { healthy: false, reason: REASON.test(reason) ? reason : "UNHEALTHY" };
    this.#latest.set(input, Object.freeze(failure));
  }

  source(input: HealthInput): HealthProofSource {
    return Object.freeze({ read: (): HealthProofReading => this.#latest.get(input) ?? Object.freeze({ healthy: false as const, reason: "NO_PROOF" }) });
  }
}

/**
 * The event-loop input (§9.18 "event loop"): a timer set every `intervalMs`;
 * when it fires no later than `maxLagMs` after it was due, the loop is proved
 * at the firing instant. A stalled loop fires late (or not at all), proves
 * nothing, and the proof ages out of the lease.
 */
export class EventLoopProbe {
  readonly #board: ProofBoard;
  readonly #clock: MonotonicClock;
  readonly #timers: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };
  readonly #intervalMs: number;
  readonly #maxLagMs: number;
  #handle: unknown = null;
  #running = false;

  constructor(options: {
    readonly board: ProofBoard;
    readonly clock: MonotonicClock;
    readonly timers: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void };
    readonly intervalMs: number;
    readonly maxLagMs: number;
  }) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) throw new HealthLeaseConfigurationError("eventLoop.intervalMs");
    if (!Number.isSafeInteger(options.maxLagMs) || options.maxLagMs < 1) throw new HealthLeaseConfigurationError("eventLoop.maxLagMs");
    this.#board = options.board;
    this.#clock = options.clock;
    this.#timers = options.timers;
    this.#intervalMs = options.intervalMs;
    this.#maxLagMs = options.maxLagMs;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    if (this.#handle !== null) this.#timers.clearTimeout(this.#handle);
    this.#handle = null;
  }

  #arm(): void {
    if (!this.#running) return;
    let due: number;
    try {
      due = this.#clock.monotonicMs() + this.#intervalMs;
    } catch {
      this.#board.fail("EVENT_LOOP", "CLOCK_UNREADABLE");
      return;
    }
    this.#handle = this.#timers.setTimeout(() => {
      this.#handle = null;
      let now: number;
      try {
        now = this.#clock.monotonicMs();
      } catch {
        this.#board.fail("EVENT_LOOP", "CLOCK_UNREADABLE");
        this.#arm();
        return;
      }
      if (now >= due && now - due <= this.#maxLagMs) this.#board.prove("EVENT_LOOP", now);
      else this.#board.fail("EVENT_LOOP", now < due ? "TIMER_EARLY" : "LOOP_LAGGING");
      this.#arm();
    }, this.#intervalMs);
  }
}
