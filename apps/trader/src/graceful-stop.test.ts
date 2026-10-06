/**
 * `TRADER-SIGNALS` — the stop's signal handling, deadline and forced exits
 * (`graceful-stop.ts`).
 *
 * Three layers, as `process-exit.test.ts` has:
 *
 * 1. {@link readShutdownDeadline}, the door for `TRADER_SHUTDOWN_DEADLINE_MS`;
 * 2. {@link GracefulStop} through recording ports: the first signal only
 *    requests (one line, the deadline armed, no exit); a second forces exit
 *    130, and only from its own line's write callback; a further one exits at
 *    once; the deadline exits 124 the same way; `finish` cancels the deadline
 *    and hands the signals back; and every line says where the stop was;
 * 3. REAL child processes bound by {@link gracefulStopPorts}`(process)`, as
 *    `main.ts`'s shell binds it, around a stand-in for `startup()`: SIGTERM
 *    and SIGINT each stop it in order with exit 0; a second signal during a
 *    slow stop exits 130 at once; and a stop that never finishes — an
 *    unsettled promise, nothing else holding the process — exits 124 at the
 *    deadline, saying where it was.
 *
 * The sequence a stop runs (`runUntilStopped`) is `graceful-stop-sequence.test.ts`;
 * the shipped bundle against real PostgreSQL and Redis is
 * `test/integration/paper-trader/graceful-stop-postgres-redis.test.ts`.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  GracefulStop,
  SHUTDOWN_DEADLINE_ENV,
  SHUTDOWN_DEADLINE_EXIT_CODE,
  SHUTDOWN_DEADLINE_RANGE,
  SHUTDOWN_FORCED_EXIT_CODE,
  STOP_SIGNALS,
  gracefulStopPorts,
  installGracefulStop,
  readShutdownDeadline,
  type GracefulStopPorts,
  type SignallingProcess,
  type StopSignal,
} from "./graceful-stop.js";
import { EXIT_CODES } from "./main.js";

describe(`${SHUTDOWN_DEADLINE_ENV}: the stop's stated deadline`, () => {
  it("unset or empty is the default, 8 000 ms; the range is seconds, not minutes", () => {
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBe(8_000);
    expect(SHUTDOWN_DEADLINE_RANGE).toStrictEqual({ minimumMs: 1_000, maximumMs: 60_000 });
    expect(readShutdownDeadline({})).toStrictEqual({ ok: true, deadlineMs: 8_000, defaulted: true });
    expect(readShutdownDeadline({ [SHUTDOWN_DEADLINE_ENV]: "" })).toStrictEqual({ ok: true, deadlineMs: 8_000, defaulted: true });
  });

  it.each(["1000", "8000", "15000", "60000"])("accepts %s", (raw) => {
    expect(readShutdownDeadline({ [SHUTDOWN_DEADLINE_ENV]: raw })).toStrictEqual({ ok: true, deadlineMs: Number(raw), defaulted: false });
  });

  it.each(["999", "60001", "0", "-5", "1e4", "08000", "8000.0", " 8000", "8000 ", "0x1f40", "8s", "1000000"])(
    "refuses %j rather than clamping or guessing",
    (raw) => {
      const result = readShutdownDeadline({ [SHUTDOWN_DEADLINE_ENV]: raw });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("accepted");
      expect(result.refusal.code).toBe("TRADER_SHUTDOWN_DEADLINE_REFUSED");
      expect(result.refusal.detail).toContain(`${SHUTDOWN_DEADLINE_ENV}=${JSON.stringify(raw)} is not an integer number of milliseconds in [1000, 60000]`);
    },
  );

  it("reads an OWN property only: a value inherited through the environment's prototype is not a statement", () => {
    const inherited = Object.create({ [SHUTDOWN_DEADLINE_ENV]: "1000" }) as Record<string, string | undefined>;
    expect(readShutdownDeadline(inherited)).toStrictEqual({ ok: true, deadlineMs: 8_000, defaulted: true });
  });
});

describe("the exit codes, next to the existing ones", () => {
  it("a forced stop exits 130 and a late one 124, and main.ts's EXIT_CODES names both — distinct from every other code", () => {
    expect(SHUTDOWN_FORCED_EXIT_CODE).toBe(130);
    expect(SHUTDOWN_DEADLINE_EXIT_CODE).toBe(124);
    expect(EXIT_CODES.shutdownForced).toBe(SHUTDOWN_FORCED_EXIT_CODE);
    expect(EXIT_CODES.shutdownDeadlineExceeded).toBe(SHUTDOWN_DEADLINE_EXIT_CODE);
    expect(EXIT_CODES.shutdownCheckFailed).toBe(70);
    const others = [EXIT_CODES.ok, EXIT_CODES.halted, EXIT_CODES.configurationRefused, EXIT_CODES.infrastructureUnavailable];
    for (const code of [EXIT_CODES.shutdownForced, EXIT_CODES.shutdownDeadlineExceeded, EXIT_CODES.shutdownCheckFailed]) {
      expect(others).not.toContain(code);
    }
    expect(new Set([EXIT_CODES.shutdownForced, EXIT_CODES.shutdownDeadlineExceeded, EXIT_CODES.shutdownCheckFailed]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Through recording ports
// ---------------------------------------------------------------------------

/** Ports that record every call, with signals, timers, flushes and the clock driven by hand. */
function recordingPorts() {
  const calls: string[] = [];
  const listeners = new Map<StopSignal, () => void>();
  const timers: { readonly ms: number; readonly fire: () => void; cancelled: boolean }[] = [];
  const lines: string[] = [];
  const flushes: (() => void)[] = [];
  let now = 1_000;
  const ports: GracefulStopPorts = {
    listen: (signal, listener) => {
      calls.push(`listen(${signal})`);
      listeners.set(signal, listener);
    },
    unlisten: (signal, listener) => {
      calls.push(`unlisten(${signal})`);
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
    exit: (code) => {
      calls.push(`exit(${String(code)})`);
    },
    writeLine: (line, flushed) => {
      calls.push("writeLine");
      lines.push(line);
      flushes.push(flushed);
    },
    timer: (ms, fire) => {
      calls.push(`timer(${String(ms)})`);
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        calls.push(`cancel(${String(ms)})`);
        timer.cancelled = true;
      };
    },
    nowMs: () => now,
  };
  /** Delivers `signal` as the process would: to the listener installed for it. */
  const deliver = (signal: StopSignal): void => {
    const listener = listeners.get(signal);
    if (listener === undefined) throw new Error(`no listener for ${signal}`);
    listener();
  };
  const advance = (ms: number): void => {
    now += ms;
  };
  const exits = (): string[] => calls.filter((call) => call.startsWith("exit("));
  return { ports, calls, listeners, timers, lines, flushes, deliver, advance, exits };
}

describe("GracefulStop, through its ports", () => {
  it("installs one listener for SIGINT and one for SIGTERM, and does nothing else until a signal arrives", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    expect(STOP_SIGNALS).toStrictEqual(["SIGINT", "SIGTERM"]);
    expect(recorded.calls).toStrictEqual(["listen(SIGINT)", "listen(SIGTERM)"]);
    expect(stop.signal).toBeUndefined();
    expect(stop.phase).toBe("STARTING");
    expect(stop.deadlineMs).toBe(DEFAULT_SHUTDOWN_DEADLINE_MS);
  });

  it("the FIRST signal only requests the stop: one line, the deadline armed, no exit", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    stop.enter("PUMP");
    recorded.deliver("SIGTERM");
    expect(stop.signal).toBe("SIGTERM");
    expect(recorded.exits()).toStrictEqual([]);
    expect(recorded.timers.map((timer) => timer.ms)).toStrictEqual([DEFAULT_SHUTDOWN_DEADLINE_MS]);
    expect(recorded.lines).toStrictEqual([
      "STOP REQUESTED: SIGTERM received during the pump (the batch in hand finishing its durable writes and " +
        "recording its stream position). The trader stops in order: the pump reads no new batch and the batch " +
        "in hand finishes its durable writes, then the SHUTDOWN rebuild check runs, every latched halt is " +
        "recorded and everything opened is closed. A latched halt keeps the exit non-zero. Bounded by 8000 ms " +
        "(TRADER_SHUTDOWN_DEADLINE_MS): a stop not finished by then exits 124. A second SIGINT or SIGTERM " +
        "exits 130 at once, without finishing it",
    ]);
  });

  it("a signal during a halt's shutdown is a FIRST signal too: it requests, says where the stop already is, and arms the deadline — it does not exit", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    stop.enter("HALT_RECORD");
    recorded.deliver("SIGINT");
    expect(recorded.lines[0]).toMatch(/^STOP REQUESTED: SIGINT received during the halt record \(every latched halt being written to ops\.incidents\)\. /u);
    expect(recorded.lines[0]).toContain("A latched halt keeps the exit non-zero");
    expect(recorded.exits()).toStrictEqual([]);
    expect(recorded.timers).toHaveLength(1);
  });

  it("a SECOND signal forces exit 130 — only from its own line's write callback, once — and cancels the deadline", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    stop.watchHalts(() => []);
    stop.enter("CLOSING", "the PostgreSQL pool");
    recorded.deliver("SIGTERM");
    recorded.advance(1_234);
    recorded.deliver("SIGINT");
    expect(recorded.lines[1]).toBe(
      "SHUTDOWN FORCED: a second stop signal, SIGINT, arrived 1234 ms after the first (SIGTERM), during the " +
        "closes (the PostgreSQL pool). The process exits 130 now, without finishing the stop: every durable " +
        "outcome was final and the SHUTDOWN rebuild check had run (its line is above); only closes remained. " +
        "No halt was latched",
    );
    expect(recorded.timers[0]?.cancelled).toBe(true);
    // Not before the line is out.
    expect(recorded.exits()).toStrictEqual([]);
    recorded.flushes[1]?.();
    expect(recorded.exits()).toStrictEqual(["exit(130)"]);
    recorded.flushes[1]?.();
    expect(recorded.exits()).toStrictEqual(["exit(130)"]);
    // The signal that was requested stays the first one.
    expect(stop.signal).toBe("SIGTERM");
  });

  it("the same signal twice is a second signal too (SIGINT, SIGINT)", () => {
    const recorded = recordingPorts();
    installGracefulStop(recorded.ports);
    recorded.deliver("SIGINT");
    recorded.deliver("SIGINT");
    expect(recorded.lines[1]).toMatch(
      /^SHUTDOWN FORCED: a second stop signal, SIGINT, arrived 0 ms after the first \(SIGINT\), during startup, before the pump ran\. The process exits 130 now, without finishing the stop: no batch had been read and no decision made\. No trader had been assembled, so no halt could be latched$/u,
    );
    recorded.flushes[1]?.();
    expect(recorded.exits()).toStrictEqual(["exit(130)"]);
  });

  it("a log that has not taken the forced line holds that exit; a FURTHER signal then exits 130 at once, without waiting", () => {
    const recorded = recordingPorts();
    installGracefulStop(recorded.ports);
    recorded.deliver("SIGTERM");
    recorded.deliver("SIGTERM");
    expect(recorded.exits()).toStrictEqual([]);
    recorded.deliver("SIGINT");
    expect(recorded.exits()).toStrictEqual(["exit(130)"]);
    expect(recorded.lines[2]).toMatch(/^SHUTDOWN FORCED AGAIN: SIGINT arrived while the exit was waiting for the log /u);
  });

  it("the DEADLINE: a stop not finished in time exits 124 from its line's callback, naming where it was — and every halt latched by then, which it does not clear", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    const latched: string[] = [];
    stop.watchHalts(() => latched);
    stop.enter("PUMP");
    recorded.deliver("SIGTERM");
    // A halt latched in the batch in hand, after the signal and before any HALT line.
    latched.push("GLOBAL STORE_UNAVAILABLE");
    recorded.timers[0]?.fire();
    expect(recorded.lines[1]).toBe(
      "SHUTDOWN DEADLINE EXCEEDED: the stop SIGTERM requested had not finished 8000 ms later " +
        "(TRADER_SHUTDOWN_DEADLINE_MS); it was in the pump (the batch in hand finishing its durable writes and " +
        "recording its stream position). The process exits 124 now, without finishing it: a write PostgreSQL " +
        "had acknowledged is durable and one still in flight is PostgreSQL's to commit or roll back; the stream " +
        "position recorded never runs ahead of a durable decision, so a consumer resuming from it reads the " +
        "unfinished batch again. The SHUTDOWN rebuild check did not run. Latched, and not cleared by this exit " +
        "— the run is HALTED, not stopped cleanly: GLOBAL STORE_UNAVAILABLE",
    );
    expect(recorded.exits()).toStrictEqual([]);
    recorded.flushes[1]?.();
    expect(recorded.exits()).toStrictEqual(["exit(124)"]);
    // A signal while that line waits on the log: the operator asked, so it no longer waits.
    recorded.deliver("SIGINT");
    expect(recorded.exits()).toStrictEqual(["exit(124)", "exit(130)"]);
  });

  it("a signal while halts are latched names them in STOP REQUESTED; a halt reader that throws still leaves a line", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    stop.watchHalts(() => ["GLOBAL TRANSPORT_UNAVAILABLE", "MARKET UNATTRIBUTED_ACTIVITY"]);
    stop.enter("CLOSING", "the event subscription");
    recorded.deliver("SIGTERM");
    expect(recorded.lines[0]).toContain(
      "2 halt(s) are latched (GLOBAL TRANSPORT_UNAVAILABLE, MARKET UNATTRIBUTED_ACTIVITY), so the exit stays non-zero. ",
    );
    expect(recorded.lines[0]).not.toContain("A latched halt keeps the exit non-zero");

    const broken = recordingPorts();
    const failing = installGracefulStop(broken.ports);
    failing.watchHalts(() => {
      throw new Error("the controller is gone");
    });
    broken.deliver("SIGTERM");
    broken.deliver("SIGINT");
    expect(broken.lines[1]).toMatch(/Latched, and not cleared by this exit — the run is HALTED, not stopped cleanly: \(the halts could not be read\)$/u);
    broken.flushes[1]?.();
    expect(broken.exits()).toStrictEqual(["exit(130)"]);
  });

  it("the deadline's line says what is left for each phase it can find the stop in", () => {
    const expectations: readonly (readonly [Parameters<GracefulStop["enter"]>, string])[] = [
      [["STARTING"], "it was in startup, before the pump ran. The process exits 124 now, without finishing it: no batch had been read and no decision made"],
      [["HALT_RECORD"], "whether the halt record landed is unknown, and the HALT lines above are the halts' record"],
      [["CLOSING", "the Redis transport"], "it was in the closes (the Redis transport). The process exits 124 now, without finishing it: every durable outcome was final"],
    ];
    for (const [phase, text] of expectations) {
      const recorded = recordingPorts();
      const stop = installGracefulStop(recorded.ports);
      stop.enter(...phase);
      recorded.deliver("SIGTERM");
      recorded.timers[0]?.fire();
      expect(recorded.lines[1]).toContain(text);
    }
  });

  it("useDeadline: stated before a signal, it is the bound armed; stated after one, it is re-armed from that signal's instant", () => {
    const before = recordingPorts();
    const early = installGracefulStop(before.ports);
    early.useDeadline(2_000);
    expect(before.timers).toHaveLength(0);
    before.deliver("SIGTERM");
    expect(before.timers.map((timer) => timer.ms)).toStrictEqual([2_000]);
    expect(before.lines[0]).toContain("Bounded by 2000 ms (TRADER_SHUTDOWN_DEADLINE_MS)");

    const after = recordingPorts();
    const late = installGracefulStop(after.ports);
    after.deliver("SIGTERM");
    after.advance(1_500);
    late.useDeadline(5_000);
    expect(after.timers.map((timer) => [timer.ms, timer.cancelled])).toStrictEqual([
      [DEFAULT_SHUTDOWN_DEADLINE_MS, true],
      [3_500, false],
    ]);
    // A deadline already past is due at once, never negative.
    after.advance(10_000);
    late.useDeadline(1_000);
    expect(after.timers.at(-1)?.ms).toBe(0);
  });

  it("finish(): the stop is complete — the deadline is cancelled and both signals are handed back; nothing fires afterwards", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    const sigint = recorded.listeners.get("SIGINT");
    recorded.deliver("SIGTERM");
    expect(stop.finish()).toBe(true);
    expect(recorded.timers[0]?.cancelled).toBe(true);
    expect(recorded.calls.slice(-3)).toStrictEqual([`cancel(${String(DEFAULT_SHUTDOWN_DEADLINE_MS)})`, "unlisten(SIGINT)", "unlisten(SIGTERM)"]);
    expect(recorded.listeners.size).toBe(0);
    // Even a stray delivery to the old listener, or the old timer, does nothing.
    sigint?.();
    recorded.timers[0]?.fire();
    expect(recorded.exits()).toStrictEqual([]);
    expect(recorded.lines).toHaveLength(1);
    expect(stop.finish()).toBe(true);
  });

  it("finish() with no signal ever received: nothing to cancel, the listeners removed", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    expect(stop.finish()).toBe(true);
    expect(recorded.calls).toStrictEqual(["listen(SIGINT)", "listen(SIGTERM)", "unlisten(SIGINT)", "unlisten(SIGTERM)"]);
  });

  it("finish() while a forced exit waits on the log answers false — the shell must not exit with startup()'s code over it — and keeps the listeners", () => {
    const recorded = recordingPorts();
    const stop = installGracefulStop(recorded.ports);
    recorded.deliver("SIGTERM");
    recorded.deliver("SIGINT");
    expect(stop.finish()).toBe(false);
    expect(recorded.calls).not.toContain("unlisten(SIGINT)");
    recorded.flushes[1]?.();
    expect(recorded.exits()).toStrictEqual(["exit(130)"]);
  });
});

/** A stand-in for `process`: records what the binding does with it. */
function recordingProcess(options: { readonly writeThrows?: boolean } = {}) {
  const on: string[] = [];
  const off: string[] = [];
  const writes: { readonly chunk: string; readonly callback: (() => void) | undefined }[] = [];
  const exits: number[] = [];
  const target: SignallingProcess = {
    on: (event) => on.push(event),
    off: (event) => off.push(event),
    exit: (code) => {
      exits.push(Number(code));
      return undefined as never;
    },
    stderr: {
      write: (chunk, callback) => {
        if (options.writeThrows === true) throw new Error("EPIPE");
        writes.push({ chunk, callback: callback === undefined ? undefined : () => callback() });
        return true;
      },
    },
  };
  return { target, on, off, writes, exits };
}

describe("gracefulStopPorts, the binding main.ts's shell hands process to", () => {
  it("binds the listeners, the exit and stderr — one line, newline-terminated, flushed only from its write's own callback", () => {
    const { target, on, off, writes, exits } = recordingProcess();
    const ports = gracefulStopPorts(target);
    const listener = (): void => undefined;
    ports.listen("SIGTERM", listener);
    ports.unlisten("SIGTERM", listener);
    expect(on).toStrictEqual(["SIGTERM"]);
    expect(off).toStrictEqual(["SIGTERM"]);
    let flushed = 0;
    ports.writeLine("SHUTDOWN FORCED: x", () => {
      flushed += 1;
    });
    expect(writes.map((write) => write.chunk)).toStrictEqual(["SHUTDOWN FORCED: x\n"]);
    expect(flushed).toBe(0);
    writes[0]?.callback?.();
    expect(flushed).toBe(1);
    ports.exit(130);
    expect(exits).toStrictEqual([130]);
  });

  it("a write that throws counts as flushed: a broken log cannot hold a forced exit", () => {
    const { target } = recordingProcess({ writeThrows: true });
    let flushed = 0;
    gracefulStopPorts(target).writeLine("line", () => {
      flushed += 1;
    });
    expect(flushed).toBe(1);
  });

  it("the timer is a real, cancellable one, and the clock is monotonic", async () => {
    const ports = gracefulStopPorts(recordingProcess().target);
    let fired = 0;
    const cancel = ports.timer(5, () => {
      fired += 1;
    });
    cancel();
    ports.timer(5, () => {
      fired += 10;
    });
    const first = ports.nowMs();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(10);
    expect(ports.nowMs()).toBeGreaterThan(first);
  });

  it("GracefulStop is what installGracefulStop answers", () => {
    expect(installGracefulStop(recordingPorts().ports)).toBeInstanceOf(GracefulStop);
  });
});

// ---------------------------------------------------------------------------
// A real process
// ---------------------------------------------------------------------------

const MODULE_URL = new URL("./graceful-stop.ts", import.meta.url).href;

/**
 * A child Node process bound exactly as `main.ts`'s shell binds it —
 * `installGracefulStop(gracefulStopPorts(process))` first, `finish()` last —
 * around a stand-in for `startup()`: it "pumps" until a stop is requested,
 * then runs a stop that takes `stopMs`, or never finishes (`hang`: an
 * unsettled promise, and nothing but the stop's own deadline holding the
 * process).
 */
function childScript(options: { readonly stopMs?: number; readonly hang?: boolean; readonly deadlineMs?: number }): string {
  return `
import { gracefulStopPorts, installGracefulStop } from ${JSON.stringify(MODULE_URL)};
const stop = installGracefulStop(gracefulStopPorts(process));
${options.deadlineMs === undefined ? "" : `stop.useDeadline(${String(options.deadlineMs)});`}
stop.enter("PUMP");
const pumping = setInterval(() => {}, 1_000);
process.stderr.write("ready\\n");
await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (stop.signal !== undefined) { clearInterval(poll); clearInterval(pumping); resolve(); }
  }, 5);
});
process.stderr.write("pump stopped: STOPPED on " + stop.signal + "\\n");
stop.enter("CLOSING", "the stand-in connection");
${options.hang === true ? "await new Promise(() => {});" : `await new Promise((resolve) => setTimeout(resolve, ${String(options.stopMs ?? 0)}));`}
process.stderr.write("trader stopped: exit 0\\n");
if (stop.finish()) process.exitCode = 0;
`;
}

interface ChildRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  /** Milliseconds from the FIRST signal sent to the exit. */
  readonly afterFirstSignalMs: number;
  /** Milliseconds from the LAST signal sent to the exit. */
  readonly afterLastSignalMs: number;
}

/**
 * Runs {@link childScript}, sends `signals` in order — the first once the
 * child is ready, each later one once the previous line has arrived — and
 * waits for the exit (SIGKILL at 20 s).
 */
async function runChild(script: string, signals: readonly StopSignal[], waitFor: readonly string[] = []): Promise<ChildRun> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  const arrived: ((text: string) => void)[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    for (const check of arrived) check(stderr);
  });
  const until = async (marker: string): Promise<void> => {
    await new Promise<void>((resolve) => {
      if (stderr.includes(marker)) {
        resolve();
        return;
      }
      arrived.push((text) => {
        if (text.includes(marker)) resolve();
      });
    });
  };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal, at: Date.now() });
    });
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    await until("ready\n");
    let firstAt = 0;
    let lastAt = 0;
    for (const [index, signal] of signals.entries()) {
      if (index > 0) await until(waitFor[index - 1] ?? "STOP REQUESTED");
      lastAt = Date.now();
      if (index === 0) firstAt = lastAt;
      child.kill(signal);
    }
    const exit = await exited;
    return { code: exit.code, signal: exit.signal, stderr, afterFirstSignalMs: exit.at - firstAt, afterLastSignalMs: exit.at - lastAt };
  } finally {
    clearTimeout(killer);
  }
}

describe("a real process bound as main.ts's shell binds it", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("%s: the stop runs in order, and the process exits 0 by itself — not killed by the signal", async (signal) => {
    const run = await runChild(childScript({ stopMs: 50 }), [signal]);
    expect(run.signal, run.stderr).toBeNull();
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stderr.split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("ready");
    expect(lines[1]).toMatch(new RegExp(`^STOP REQUESTED: ${signal} received during the pump `, "u"));
    expect(lines.slice(2)).toStrictEqual([`pump stopped: STOPPED on ${signal}`, "trader stopped: exit 0"]);
    expect(run.stderr).not.toContain("SHUTDOWN FORCED");
    expect(run.stderr).not.toContain("SHUTDOWN DEADLINE EXCEEDED");
  }, 30_000);

  it("a second signal during a slow stop: one SHUTDOWN FORCED line naming the phase, and exit 130 at once — the stop is not waited on", async () => {
    const run = await runChild(childScript({ stopMs: 10_000 }), ["SIGTERM", "SIGINT"], ["pump stopped: STOPPED"]);
    expect(run.signal, run.stderr).toBeNull();
    expect(run.code, run.stderr).toBe(SHUTDOWN_FORCED_EXIT_CODE);
    expect(run.stderr).toMatch(
      /SHUTDOWN FORCED: a second stop signal, SIGINT, arrived \d+ ms after the first \(SIGTERM\), during the closes \(the stand-in connection\)\. The process exits 130 now, without finishing the stop: /u,
    );
    expect(run.stderr).not.toContain("trader stopped");
    // "At once": well inside the 10 s the stand-in stop would take.
    expect(run.afterLastSignalMs).toBeLessThan(2_000);
  }, 30_000);

  it("a stop that NEVER finishes (an unsettled promise, nothing else holding the process): the deadline holds it, and it exits 124 at the deadline, saying where it was", async () => {
    const run = await runChild(childScript({ hang: true, deadlineMs: 1_000 }), ["SIGTERM"]);
    expect(run.signal, run.stderr).toBeNull();
    expect(run.code, run.stderr).toBe(SHUTDOWN_DEADLINE_EXIT_CODE);
    expect(run.stderr).toContain(
      "SHUTDOWN DEADLINE EXCEEDED: the stop SIGTERM requested had not finished 1000 ms later (TRADER_SHUTDOWN_DEADLINE_MS); " +
        "it was in the closes (the stand-in connection). The process exits 124 now",
    );
    expect(run.stderr).not.toContain("trader stopped");
    expect(run.afterFirstSignalMs).toBeGreaterThanOrEqual(1_000 - 50);
    // The deadline, plus a margin for a loaded host.
    expect(run.afterFirstSignalMs).toBeLessThan(1_000 + 2_500);
  }, 30_000);
});
