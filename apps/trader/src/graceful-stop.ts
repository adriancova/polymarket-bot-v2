/**
 * `TRADER-SIGNALS` — the trader stops in order on SIGINT and SIGTERM, within
 * a stated bound, and a second signal forces the exit.
 *
 * ## The defect
 *
 * `main.ts`'s header said the file touched "the signal handlers", and there
 * were none. Node's default for SIGINT and SIGTERM ends the process at once,
 * so Ctrl-C (or a supervisor's SIGTERM) killed the trader wherever it was.
 * Every durable write was already committed per event, so nothing PostgreSQL
 * had acknowledged was lost; but the `FOLD-1` SHUTDOWN rebuild check (§6
 * invariant 8, user ruling F2) never ran, a latched halt was never recorded,
 * and nothing was closed. A run ended that way logged no SHUTDOWN check.
 *
 * ## The stop
 *
 * `main.ts`'s shell installs {@link GracefulStop} before `startup()` reads
 * anything, and hands it to `startup()` as its {@link StopRequest}. The FIRST
 * signal only REQUESTS the stop: this module logs `STOP REQUESTED: …` and arms
 * the deadline. The stop itself is `startup()`'s (`main.ts`
 * `runUntilStopped`), the same sequence a halt has always run:
 *
 * 1. the pump reads no new batch; the batch in hand finishes its durable
 *    writes and records its stream position (`pump.ts`);
 * 2. the `FOLD-1` SHUTDOWN rebuild check runs, and is reported as before;
 * 3. every latched halt is written to `ops.incidents` (`PROVENANCE-1`);
 * 4. what `startup()` opened is closed, in the reverse order of opening;
 * 5. the exit: `0` only when no halt is latched and the check matched — a
 *    latched halt stays `75`, a failed check is `70` (`main.ts` `EXIT_CODES`).
 *
 * The signal changes HOW the pump stops and nothing after it. In particular it
 * never clears or hides a halt: a halt latched before, during or after the
 * signal keeps the exit non-zero and is logged, and one latched before the
 * halt record is recorded, as every halt is.
 *
 * ## The two exits that do not wait for the stop
 *
 * - **A second signal** (SIGINT or SIGTERM, in either order): one line,
 *   `SHUTDOWN FORCED: …`, and exit {@link SHUTDOWN_FORCED_EXIT_CODE} (130).
 * - **The deadline**: a stop that has not finished
 *   {@link DEFAULT_SHUTDOWN_DEADLINE_MS} after the first signal (or what
 *   `TRADER_SHUTDOWN_DEADLINE_MS` states): one line,
 *   `SHUTDOWN DEADLINE EXCEEDED: …`, naming where the stop was, and exit
 *   {@link SHUTDOWN_DEADLINE_EXIT_CODE} (124).
 *
 * Each line says what is safe and what is not, by the phase the stop was in
 * ({@link ShutdownPhase}), and names every halt latched at that moment. So a
 * halt is never hidden by these exits: their code says HOW the process ended
 * (130 or 124, never 0), and their line says that the run is halted, even
 * when the halt was latched too late for a `HALT …` line of its own (in the
 * batch in hand, say). What is always safe: a write PostgreSQL had
 * acknowledged is durable, a write still in flight is PostgreSQL's to commit
 * or roll back (each is one transaction), and the stream position recorded
 * never runs ahead of a durable decision (`pump.ts`), so a consumer resuming
 * from it reads an unfinished batch again.
 *
 * Both exit from their OWN line's write callback, as `process-exit.ts` does:
 * never ahead of a line already logged (`TC-LOWS-1`, `TCL1-R1-01`), so the
 * line saying why reaches the log. When the log is taking lines that is
 * immediate. When it is not, the exit waits for it, as every exit of this
 * process does; a FURTHER signal then exits at once without waiting — the
 * one exit here that can cut the log short, and only when the operator has
 * asked again.
 *
 * ## The deadline: 8,000 ms by default, and why
 *
 * A healthy stop takes milliseconds: the batch in hand, a rebuild check in
 * memory, and the closes, each answered at once. Measured on the shipped
 * bundle with a paper fill in its ledger, ten stops (SIGTERM and SIGINT, in
 * five runs of this round): 18 to 200 ms from the signal to the exit, the
 * higher figures under a host load of 15 to 20 (`test/integration/paper-trader/graceful-stop-postgres-redis.test.ts`
 * logs the figure on every run). The deadline is a backstop for a stop that HANGS, and its
 * value sits between two bounds:
 *
 * - **Above 5,000 ms.** The longest fixed bound inside the stop is the halt
 *   record's, `HALT_RECORD_DEADLINE_MS` (5,000 ms). When PostgreSQL stalls
 *   while a halt is latched, the record answers `UNCONFIRMED` at that bound,
 *   and for an unconfirmed halt its log lines are its only record. A deadline
 *   below it would cut that answer off; 8,000 ms leaves it 3,000 ms of room.
 * - **Below 10,000 ms.** That is how long a supervisor commonly waits between
 *   its SIGTERM and an uncatchable SIGKILL (`docker stop`'s default `-t 10`,
 *   Compose's default `stop_grace_period`). Exiting first means the process's
 *   own `SHUTDOWN DEADLINE EXCEEDED` line, and its exit code, reach the
 *   operator; a SIGKILL leaves neither.
 *
 * The bounds a stop already has (the Redis response bound on each command,
 * `TRADER_REDIS_RESPONSE_TIMEOUT_MS`; the halt record's; the pool's
 * connection timeout) are NOT summed into it: with every default in force
 * their worst case is well over 10 s, and a stop that slow is better ended,
 * said, and restarted than waited on. An operator who wants it longer states
 * it: `TRADER_SHUTDOWN_DEADLINE_MS`, an integer in
 * {@link SHUTDOWN_DEADLINE_RANGE} (1,000 to 60,000 ms), refused at startup
 * otherwise, before anything is opened.
 *
 * The deadline covers the stop, from the first signal until `startup()`
 * returns. After that, `exitAfterStartup` (`process-exit.ts`) bounds the exit
 * itself, as before: {@link GracefulStop.finish} cancels the deadline and
 * gives the signals back to Node's default handling. So a requested stop
 * exits within the deadline plus `PROCESS_EXIT_GRACE_MS` (1,000 ms), plus
 * however long the log takes to accept what was queued before the last line.
 *
 * ## Import-free, and `process`-free
 *
 * Like `process-exit.ts`, this module imports nothing, so a real child
 * process can import it as written (Node 24 strips the types;
 * `graceful-stop.test.ts` does). And it does not touch `process`: `main.ts`
 * stays the only file that does, and its shell hands `process` to
 * {@link gracefulStopPorts}.
 */

/** The signals that request a stop. */
export const STOP_SIGNALS = Object.freeze(["SIGINT", "SIGTERM"] as const);
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** The environment variable that states the stop's deadline. */
export const SHUTDOWN_DEADLINE_ENV = "TRADER_SHUTDOWN_DEADLINE_MS";

/** The deadline when {@link SHUTDOWN_DEADLINE_ENV} is unset. Why this value: the module header. */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 8_000;

/**
 * The accepted range for {@link SHUTDOWN_DEADLINE_ENV}, in milliseconds. Below
 * a second, a healthy stop on a loaded host could trip it; above a minute, a
 * hung process looks alive while it decides nothing (the Redis bound's
 * ceiling, for the same reason).
 */
export const SHUTDOWN_DEADLINE_RANGE = Object.freeze({ minimumMs: 1_000, maximumMs: 60_000 });

/**
 * The exit of a stop a second signal forced. 128 + 2 (SIGINT): what a shell
 * reports for a process Ctrl-C ended, used for a second SIGTERM too, so one
 * code means "the operator ended the stop before it finished".
 */
export const SHUTDOWN_FORCED_EXIT_CODE = 130;

/** The exit of a stop that missed its deadline: 124, the code `timeout(1)` exits with when its command times out. */
export const SHUTDOWN_DEADLINE_EXIT_CODE = 124;

export type ShutdownDeadlineResult =
  | {
      readonly ok: true;
      readonly deadlineMs: number;
      /** `true` when the variable was unset and {@link DEFAULT_SHUTDOWN_DEADLINE_MS} applies. */
      readonly defaulted: boolean;
    }
  | {
      readonly ok: false;
      readonly refusal: { readonly code: "TRADER_SHUTDOWN_DEADLINE_REFUSED"; readonly detail: string };
    };

/**
 * Reads {@link SHUTDOWN_DEADLINE_ENV}. TOTAL: never throws.
 *
 * Unset (or empty) is {@link DEFAULT_SHUTDOWN_DEADLINE_MS}, so a stop is never
 * unbounded. A set value must be a canonical decimal integer inside
 * {@link SHUTDOWN_DEADLINE_RANGE}; anything else is refused rather than
 * clamped, because a clamped bound is one nobody chose. Read as an OWN
 * property only, as `main.ts` reads the Redis bound.
 */
export function readShutdownDeadline(env: Readonly<Record<string, string | undefined>>): ShutdownDeadlineResult {
  const descriptor = Object.hasOwn(env, SHUTDOWN_DEADLINE_ENV)
    ? Object.getOwnPropertyDescriptor(env, SHUTDOWN_DEADLINE_ENV)
    : undefined;
  const raw: unknown = descriptor?.value;
  if (raw === undefined || raw === "") {
    return { ok: true, deadlineMs: DEFAULT_SHUTDOWN_DEADLINE_MS, defaulted: true };
  }
  const { minimumMs, maximumMs } = SHUTDOWN_DEADLINE_RANGE;
  const value = typeof raw === "string" && /^[1-9]\d{0,5}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= minimumMs && value <= maximumMs)) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_SHUTDOWN_DEADLINE_REFUSED",
        detail:
          `${SHUTDOWN_DEADLINE_ENV}=${typeof raw === "string" ? JSON.stringify(raw) : typeof raw} is not an ` +
          `integer number of milliseconds in [${String(minimumMs)}, ${String(maximumMs)}]; it bounds how ` +
          "long a requested stop may take before the process exits without finishing it, and a bound the " +
          "operator did not state correctly is refused rather than guessed",
      },
    };
  }
  return { ok: true, deadlineMs: value, defaulted: false };
}

/**
 * Where a stop is, for the line a forced or late exit writes. `startup()`
 * reports it through {@link StopRequest.enter}. The rebuild check has no
 * phase of its own: it runs synchronously right after the pump returns, so
 * no timer or signal can observe it.
 */
export type ShutdownPhase =
  /** `startup()` is still opening or assembling; the pump has not run. */
  | "STARTING"
  /** The pump: the batch in hand finishing its durable writes and recording its position. */
  | "PUMP"
  /** The halt record (`PROVENANCE-1`), after the rebuild check. */
  | "HALT_RECORD"
  /** The closes; {@link StopRequest.enter}'s `detail` names the one under way. */
  | "CLOSING";

/** What `startup()` reads from the stop, and tells it. */
export interface StopRequest {
  /** The FIRST stop signal received; `undefined` while none has been. */
  readonly signal: StopSignal | undefined;
  /** `startup()` is now in `phase` (`detail`: which close, for `CLOSING`). */
  enter(phase: ShutdownPhase, detail?: string): void;
  /**
   * The deadline `startup()` validated ({@link readShutdownDeadline}). Until
   * it is stated, {@link DEFAULT_SHUTDOWN_DEADLINE_MS} applies; stated after
   * the first signal, it is re-armed from that signal's instant.
   */
  useDeadline(deadlineMs: number): void;
  /**
   * How to read the halts latched right now (`<scope kind> <code>` each),
   * once a trader exists. The stop's own lines name them, so a forced or
   * late exit never hides a halt (the module header).
   */
  watchHalts(latched: () => readonly string[]): void;
}

/** What {@link GracefulStop} needs from the process. {@link gracefulStopPorts} binds them. */
export interface GracefulStopPorts {
  /** Calls `listener` on every delivery of `signal` (`process.on`). */
  readonly listen: (signal: StopSignal, listener: () => void) => void;
  /** Removes it again (`process.off`): the signal's default handling returns. */
  readonly unlisten: (signal: StopSignal, listener: () => void) => void;
  /** Exits NOW with `code` (`process.exit`). */
  readonly exit: (code: number) => void;
  /**
   * Writes one line to the operator's log, and calls `flushed` once it has
   * been handed to the operating system, or has failed. Never throws.
   */
  readonly writeLine: (line: string, flushed: () => void) => void;
  /** Runs `fire` after `ms` on a REFERENCED timer (it holds the process); answers its cancel. */
  readonly timer: (ms: number, fire: () => void) => () => void;
  /** A monotonic clock, in milliseconds. */
  readonly nowMs: () => number;
}

/**
 * The parts of Node's `process` the stop needs. `main.ts`'s shell passes
 * `process` itself; the real-process tests' children do the same.
 */
export interface SignallingProcess {
  on(event: StopSignal, listener: () => void): unknown;
  off(event: StopSignal, listener: () => void): unknown;
  exit(code?: number | string | null): never;
  readonly stderr: { write(chunk: string, callback?: (error?: Error | null) => void): boolean };
}

/**
 * The {@link GracefulStopPorts} of a real process: the log is its stderr (a
 * line counts as flushed only from that write's own callback), the timer is
 * `setTimeout`, and the clock is `performance.now()`.
 */
export function gracefulStopPorts(target: SignallingProcess): GracefulStopPorts {
  return {
    listen: (signal, listener) => {
      target.on(signal, listener);
    },
    unlisten: (signal, listener) => {
      target.off(signal, listener);
    },
    exit: (code) => {
      target.exit(code);
    },
    writeLine: (line, flushed) => {
      try {
        target.stderr.write(`${line}\n`, () => {
          flushed();
        });
      } catch {
        flushed();
      }
    },
    timer: (ms, fire) => {
      const handle = setTimeout(fire, ms);
      return () => {
        clearTimeout(handle);
      };
    },
    nowMs: () => performance.now(),
  };
}

/** The phase, as the forced and late lines name it. */
function describePhase(phase: ShutdownPhase, detail: string | undefined): string {
  switch (phase) {
    case "STARTING":
      return "startup, before the pump ran";
    case "PUMP":
      return "the pump (the batch in hand finishing its durable writes and recording its stream position)";
    case "HALT_RECORD":
      return "the halt record (every latched halt being written to ops.incidents)";
    case "CLOSING":
      return `the closes (${detail ?? "the connections"})`;
  }
}

/** What a stop cut short in `phase` leaves behind: only what is true of that phase. */
function whatIsLeft(phase: ShutdownPhase): string {
  switch (phase) {
    case "STARTING":
      return "no batch had been read and no decision made";
    case "PUMP":
      return (
        "a write PostgreSQL had acknowledged is durable and one still in flight is PostgreSQL's to commit or " +
        "roll back; the stream position recorded never runs ahead of a durable decision, so a consumer " +
        "resuming from it reads the unfinished batch again. The SHUTDOWN rebuild check did not run"
      );
    case "HALT_RECORD":
      return (
        "every decision was final and the SHUTDOWN rebuild check had run (its line is above); whether the " +
        "halt record landed is unknown, and the HALT lines above are the halts' record"
      );
    case "CLOSING":
      return "every durable outcome was final and the SHUTDOWN rebuild check had run (its line is above); only closes remained";
  }
}

/**
 * The stop's signal handling, deadline and forced exits (see the module
 * header). Construct it with {@link installGracefulStop}.
 */
export class GracefulStop implements StopRequest {
  readonly #ports: GracefulStopPorts;
  readonly #listeners = new Map<StopSignal, () => void>();
  #deadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS;
  #first: { readonly signal: StopSignal; readonly atMs: number } | undefined;
  #phase: ShutdownPhase = "STARTING";
  #phaseDetail: string | undefined;
  #cancelDeadline: (() => void) | undefined;
  #latchedHalts: (() => readonly string[]) | undefined;
  /** A forced exit's line is written; its callback exits. */
  #forcing = false;
  #finished = false;

  constructor(ports: GracefulStopPorts) {
    this.#ports = ports;
    for (const signal of STOP_SIGNALS) {
      const listener = (): void => {
        this.#onSignal(signal);
      };
      this.#listeners.set(signal, listener);
      ports.listen(signal, listener);
    }
  }

  get signal(): StopSignal | undefined {
    return this.#first?.signal;
  }

  /** The phase `startup()` last reported. */
  get phase(): ShutdownPhase {
    return this.#phase;
  }

  /** The deadline in force. */
  get deadlineMs(): number {
    return this.#deadlineMs;
  }

  enter(phase: ShutdownPhase, detail?: string): void {
    this.#phase = phase;
    this.#phaseDetail = detail;
  }

  watchHalts(latched: () => readonly string[]): void {
    this.#latchedHalts = latched;
  }

  /** The halts latched now, as the lines name them; `undefined` before a trader exists. Never throws. */
  #halts(): readonly string[] | undefined {
    if (this.#latchedHalts === undefined) return undefined;
    try {
      return this.#latchedHalts();
    } catch {
      return ["(the halts could not be read)"];
    }
  }

  useDeadline(deadlineMs: number): void {
    this.#deadlineMs = deadlineMs;
    if (this.#first === undefined || this.#cancelDeadline === undefined) return;
    this.#cancelDeadline();
    const elapsed = this.#ports.nowMs() - this.#first.atMs;
    this.#armDeadline(Math.max(0, deadlineMs - elapsed));
  }

  /**
   * `startup()` has returned: a requested stop is complete. Cancels the
   * deadline and removes the listeners, so a signal from here on gets Node's
   * default handling while `exitAfterStartup` runs. Answers `false` when a
   * forced exit is already under way — its own line's callback exits, and
   * the shell must not exit with `startup()`'s code over it (the listeners
   * then stay, so a further signal still exits at once).
   */
  finish(): boolean {
    if (this.#finished) return !this.#forcing;
    this.#finished = true;
    this.#cancelDeadline?.();
    this.#cancelDeadline = undefined;
    if (this.#forcing) return false;
    for (const [signal, listener] of this.#listeners) this.#ports.unlisten(signal, listener);
    return true;
  }

  #onSignal(signal: StopSignal): void {
    if (this.#forcing) {
      // A further signal while a forced exit waits on the log: the operator
      // asked again, so the exit no longer waits (the module header).
      this.#ports.writeLine(
        `SHUTDOWN FORCED AGAIN: ${signal} arrived while the exit was waiting for the log to take the line ` +
          `above; the process exits ${String(SHUTDOWN_FORCED_EXIT_CODE)} at once, and lines still queued may be lost`,
        () => undefined,
      );
      this.#ports.exit(SHUTDOWN_FORCED_EXIT_CODE);
      return;
    }
    if (this.#finished) return;
    const first = this.#first;
    if (first === undefined) {
      this.#first = Object.freeze({ signal, atMs: this.#ports.nowMs() });
      this.#ports.writeLine(this.#requestedLine(signal), () => undefined);
      this.#armDeadline(this.#deadlineMs);
      return;
    }
    const elapsed = Math.round(this.#ports.nowMs() - first.atMs);
    this.#forceExit(
      SHUTDOWN_FORCED_EXIT_CODE,
      `SHUTDOWN FORCED: a second stop signal, ${signal}, arrived ${String(elapsed)} ms after the first ` +
        `(${first.signal}), during ${describePhase(this.#phase, this.#phaseDetail)}. The process exits ` +
        `${String(SHUTDOWN_FORCED_EXIT_CODE)} now, without finishing the stop: ${whatIsLeft(this.#phase)}. ` +
        this.#haltsSentence(),
    );
  }

  /** The forced and late lines' last sentence: the halts this exit does not clear. */
  #haltsSentence(): string {
    const halts = this.#halts();
    if (halts === undefined) return "No trader had been assembled, so no halt could be latched";
    if (halts.length === 0) return "No halt was latched";
    return (
      `Latched, and not cleared by this exit — the run is HALTED, not stopped cleanly: ${halts.join(", ")}`
    );
  }

  #requestedLine(signal: StopSignal): string {
    const halts = this.#halts() ?? [];
    return (
      `STOP REQUESTED: ${signal} received during ${describePhase(this.#phase, this.#phaseDetail)}. The trader ` +
      "stops in order: the pump reads no new batch and the batch in hand finishes its durable writes, then the " +
      "SHUTDOWN rebuild check runs, every latched halt is recorded and everything opened is closed. " +
      (halts.length === 0
        ? "A latched halt keeps the exit non-zero. "
        : `${String(halts.length)} halt(s) are latched (${halts.join(", ")}), so the exit stays non-zero. `) +
      `Bounded by ${String(this.#deadlineMs)} ms (${SHUTDOWN_DEADLINE_ENV}): a stop not finished by then exits ` +
      `${String(SHUTDOWN_DEADLINE_EXIT_CODE)}. A second SIGINT or SIGTERM exits ${String(SHUTDOWN_FORCED_EXIT_CODE)} ` +
      "at once, without finishing it"
    );
  }

  #armDeadline(ms: number): void {
    const first = this.#first;
    if (first === undefined) return;
    this.#cancelDeadline = this.#ports.timer(ms, () => {
      this.#cancelDeadline = undefined;
      if (this.#forcing || this.#finished) return;
      this.#forceExit(
        SHUTDOWN_DEADLINE_EXIT_CODE,
        `SHUTDOWN DEADLINE EXCEEDED: the stop ${first.signal} requested had not finished ` +
          `${String(this.#deadlineMs)} ms later (${SHUTDOWN_DEADLINE_ENV}); it was in ` +
          `${describePhase(this.#phase, this.#phaseDetail)}. The process exits ` +
          `${String(SHUTDOWN_DEADLINE_EXIT_CODE)} now, without finishing it: ${whatIsLeft(this.#phase)}. ` +
          this.#haltsSentence(),
      );
    });
  }

  /** The only exits besides a further signal's: from the line's own write callback, once. */
  #forceExit(code: number, line: string): void {
    this.#forcing = true;
    this.#cancelDeadline?.();
    this.#cancelDeadline = undefined;
    let exited = false;
    this.#ports.writeLine(line, () => {
      if (exited) return;
      exited = true;
      this.#ports.exit(code);
    });
  }
}

/** Installs the stop's handlers on `ports` and answers the stop. Called once, first, by the process shell. */
export function installGracefulStop(ports: GracefulStopPorts): GracefulStop {
  return new GracefulStop(ports);
}
