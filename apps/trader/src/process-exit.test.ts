/**
 * `TC-LOWS-1` (`PROV1-R2-L2`) — the process exits once `startup()` has
 * returned, within a bound (`process-exit.ts`).
 *
 * Three layers:
 *
 * 1. the decision, through its ports: the exit code first, nothing forced
 *    while the grace runs, then one line and an exit with the SAME code — once
 *    — and only from that line's own write callback: no timer exits ahead of
 *    the log (`TC-LOWS-1` r1, `TCL1-R1-01`);
 * 2. {@link processExitPorts}, the binding `main.ts`'s shell hands `process`
 *    to, against a recording stand-in: a line is "flushed" only from its
 *    write's callback;
 * 3. a REAL Node process (Node 24 strips the module's types, so a child can
 *    import it as is), bound by {@link processExitPorts}`(process)` exactly
 *    as `main.ts`'s shell binds it: a half-closed socket whose peer never
 *    answers — what a frozen PostgreSQL leaves of the pool's ended idle
 *    connections — keeps a process that only sets `process.exitCode` alive;
 *    the same process exits with its code within the bound once the module
 *    runs; a process nothing holds exits at once, with no forced line; and a
 *    process whose log consumer has stalled, with far more than a pipe's
 *    worth of lines queued, delivers EVERY line — the halt lines included —
 *    before it exits. The forced line explains the hold from what Node names
 *    (`TC-LOWS-1` r2, `TCL1-R2-01`): the socket in the first case, the log
 *    still behind in the last — never a socket that is not there; and a
 *    process held by a timer alone is exited the same way, its line blaming
 *    neither a socket nor the log (r3, `NEW-1`).
 *
 * The shipped bundle against a frozen PostgreSQL is
 * `test/integration/paper-trader/process-exit-frozen-postgres-redis.test.ts`.
 */

import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PROCESS_EXIT_GRACE_MS,
  exitAfterStartup,
  forcedExitLine,
  processExitPorts,
  type ExitingProcess,
  type ProcessExitPorts,
} from "./process-exit.js";

/** Ports that record every call, with timers the test fires by hand. */
function recordingPorts(options: { readonly holders?: () => readonly string[] } = {}) {
  const calls: string[] = [];
  const timers: { readonly ms: number; readonly fire: () => void }[] = [];
  const pendingFlushes: (() => void)[] = [];
  const lines: string[] = [];
  const ports: ProcessExitPorts = {
    setExitCode: (code) => calls.push(`exitCode=${String(code)}`),
    exit: (code) => calls.push(`exit(${String(code)})`),
    writeLine: (line, flushed) => {
      calls.push("writeLine");
      lines.push(line);
      pendingFlushes.push(flushed);
    },
    unrefTimer: (ms, fire) => {
      calls.push(`timer(${String(ms)})`);
      timers.push({ ms, fire });
    },
    holders: options.holders ?? (() => ["TCPSocketWrap", "TCPSocketWrap", "PipeWrap"]),
  };
  return { ports, calls, timers, pendingFlushes, lines };
}

describe("exitAfterStartup, through its ports", () => {
  it("the bound: 1 000 ms of grace after startup() returned; the forced exit then waits on the log (TCL1-R1-01)", () => {
    expect(PROCESS_EXIT_GRACE_MS).toBe(1_000);
  });

  it("sets the exit code FIRST and arms one unreferenced grace timer — nothing is written and nothing exits while it runs (a process nothing holds exits on its own)", () => {
    const { ports, calls, timers } = recordingPorts();
    exitAfterStartup(75, ports);
    expect(calls).toEqual(["exitCode=75", "timer(1000)"]);
    expect(timers.map((timer) => timer.ms)).toEqual([PROCESS_EXIT_GRACE_MS]);
  });

  it("the grace expired: ONE line naming what holds the process, and the SAME code's exit once that line is flushed — only once, and no other timer", () => {
    const { ports, calls, timers, pendingFlushes, lines } = recordingPorts();
    exitAfterStartup(75, ports);
    timers[0]?.fire();
    expect(calls).toEqual(["exitCode=75", "timer(1000)", "writeLine"]);
    expect(lines).toEqual([forcedExitLine(75, PROCESS_EXIT_GRACE_MS, ["TCPSocketWrap", "TCPSocketWrap", "PipeWrap"])]);
    expect(lines[0]).toContain("still held open by 1 × PipeWrap, 2 × TCPSocketWrap");
    // Not before the line is out.
    expect(calls).not.toContain("exit(75)");
    pendingFlushes[0]?.();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual(["exit(75)"]);
    // A second callback changes nothing.
    pendingFlushes[0]?.();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual(["exit(75)"]);
  });

  it("a log that has not taken the line HOLDS the exit (TCL1-R1-01): after the grace no timer is armed, so nothing exits until the line's own callback — every line queued before it is out by then", () => {
    const { ports, calls, timers, pendingFlushes } = recordingPorts();
    exitAfterStartup(69, ports);
    timers[0]?.fire();
    // Only the grace timer, ever: nothing can fire an exit ahead of the log.
    expect(timers.map((timer) => timer.ms)).toEqual([PROCESS_EXIT_GRACE_MS]);
    for (const timer of timers) timer.fire();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual([]);
    // However late the log takes the line, the exit follows it, with the code.
    pendingFlushes[0]?.();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual(["exit(69)"]);
  });

  it("every code startup() can return is the code the process exits with — 0 included", () => {
    for (const code of [0, 69, 75, 78]) {
      const { ports, calls, timers, pendingFlushes } = recordingPorts();
      exitAfterStartup(code, ports);
      timers[0]?.fire();
      pendingFlushes[0]?.();
      expect(calls[0]).toBe(`exitCode=${String(code)}`);
      expect(calls.filter((call) => call.startsWith("exit("))).toEqual([`exit(${String(code)})`]);
    }
  });

  it("a holders() that throws still writes the line and exits", () => {
    const { ports, calls, timers, pendingFlushes, lines } = recordingPorts({
      holders: () => {
        throw new Error("no resource info");
      },
    });
    exitAfterStartup(75, ports);
    timers[0]?.fire();
    expect(lines[0]).toContain("still held open by a handle Node does not name");
    pendingFlushes[0]?.();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual(["exit(75)"]);
  });

  it("the forced line says what happened, why, that nothing was in flight, and the code — only what was true when it was WRITTEN: no 'ago', no 'now' (TCL1-R2-01)", () => {
    expect(forcedExitLine(75, 1_000, ["TCPSocketWrap"])).toBe(
      "PROCESS EXIT FORCED: startup() returned 75, and 1000 ms later the process was still held open by " +
        "1 × TCPSocketWrap: typically a socket whose peer never answers its close (a frozen or partitioned " +
        "PostgreSQL leaves the pool's ended idle connections half-closed). Nothing is in flight: every durable " +
        "write, and the halt record, was final — acknowledged, refused or reported UNCONFIRMED above — when " +
        "startup() returned. The process exits 75 once this line has reached the log",
    );
  });

  it("a process held only by its own log, still behind (a pending write beside the stdio pipes), is NOT blamed on a socket (TCL1-R2-01)", () => {
    // What Node 24 lists for a stderr pipe whose consumer has stalled (measured).
    const line = forcedExitLine(75, 1_000, ["SimpleWriteWrap", "PipeWrap", "PipeWrap"]);
    expect(line).toBe(
      "PROCESS EXIT FORCED: startup() returned 75, and 1000 ms later the process was still held open by " +
        "2 × PipeWrap, 1 × SimpleWriteWrap: a write its reader had not yet taken (SimpleWriteWrap): typically " +
        "this log, still behind on the lines above. Nothing is in flight: every durable write, and the halt " +
        "record, was final — acknowledged, refused or reported UNCONFIRMED above — when startup() returned. " +
        "The process exits 75 once this line has reached the log",
    );
    expect(line).not.toContain("socket");
  });

  it("a socket AND a log still behind: the line names both (TCL1-R2-01)", () => {
    const line = forcedExitLine(75, 1_000, ["TCPSocketWrap", "PipeWrap", "WriteWrap", "SimpleWriteWrap"]);
    expect(line).toContain(
      "still held open by 1 × PipeWrap, 1 × SimpleWriteWrap, 1 × TCPSocketWrap, 1 × WriteWrap: typically a socket " +
        "whose peer never answers its close (a frozen or partitioned PostgreSQL leaves the pool's ended idle " +
        "connections half-closed); and a write its reader had not yet taken (SimpleWriteWrap, WriteWrap): " +
        "typically this log, still behind on the lines above. Nothing is in flight",
    );
  });

  it("a TCP connection named and no pending write: the socket explanation stands, whatever else is named — the stdio pipes and a timer included (TCL1-R2-01)", () => {
    for (const holders of [["PipeWrap", "PipeWrap", "TCPSocketWrap", "TCPSocketWrap", "Timeout"], ["TCPSocketWrap"]]) {
      const line = forcedExitLine(75, 1_000, holders);
      expect(line).toContain(": typically a socket whose peer never answers its close (");
      expect(line).not.toContain("a write its reader had not yet taken");
      expect(line).not.toContain("suggest no likelier cause");
    }
  });

  it("neither a TCP connection nor a pending write named — a timer beside the stdio pipes, or nothing Node names: NO cause is blamed, a socket least of all (NEW-1)", () => {
    // What Node 24 lists for a process a timer alone holds (measured by both
    // verifiers, TC-LOWS-1 r3): one stdio pipe and the timer.
    expect(forcedExitLine(75, 1_000, ["PipeWrap", "Timeout"])).toBe(
      "PROCESS EXIT FORCED: startup() returned 75, and 1000 ms later the process was still held open by " +
        "1 × PipeWrap, 1 × Timeout: nothing named is a TCP connection or a pending write, so the names suggest " +
        "no likelier cause. Nothing is in flight: every durable write, and the halt record, was final — " +
        "acknowledged, refused or reported UNCONFIRMED above — when startup() returned. The process exits 75 " +
        "once this line has reached the log",
    );
    for (const holders of [["PipeWrap", "Timeout"], ["PipeWrap", "PipeWrap"], ["Timeout"], ["TCPServerWrap", "Immediate"], []]) {
      const line = forcedExitLine(75, 1_000, holders);
      expect(line).toContain(": nothing named is a TCP connection or a pending write, so the names suggest no likelier cause. ");
      expect(line).not.toContain("socket");
      expect(line).not.toContain("a write its reader had not yet taken");
    }
    // And with nothing named at all, the line still reads.
    expect(forcedExitLine(75, 1_000, [])).toContain(
      "still held open by a handle Node does not name: nothing named is a TCP connection or a pending write",
    );
  });
});

/** A stand-in for `process`: records what the binding does with it. */
function recordingProcess(options: { readonly writeThrows?: boolean } = {}) {
  const writes: { readonly chunk: string; readonly callback: (() => void) | undefined }[] = [];
  const exits: number[] = [];
  const target: ExitingProcess = {
    exitCode: undefined,
    exit: (code) => {
      exits.push(Number(code));
      return undefined as never;
    },
    stderr: {
      write: (chunk, callback) => {
        if (options.writeThrows === true) throw new Error("EPIPE");
        writes.push({
          chunk,
          callback:
            callback === undefined
              ? undefined
              : () => {
                  callback();
                },
        });
        return false;
      },
    },
    getActiveResourcesInfo: () => ["PipeWrap", "TCPSocketWrap"],
  };
  return { target, writes, exits };
}

describe("processExitPorts, the binding main.ts's shell hands process to", () => {
  it("binds the exit code, the exit, the holders, and stderr — one line, newline-terminated", () => {
    const { target, writes, exits } = recordingProcess();
    const ports = processExitPorts(target);
    ports.setExitCode(75);
    expect(target.exitCode).toBe(75);
    expect(ports.holders()).toEqual(["PipeWrap", "TCPSocketWrap"]);
    ports.writeLine("PROCESS EXIT FORCED: x", () => undefined);
    expect(writes.map((write) => write.chunk)).toEqual(["PROCESS EXIT FORCED: x\n"]);
    ports.exit(75);
    expect(exits).toEqual([75]);
  });

  it("a line counts as flushed only from its write's OWN callback — never when the write merely returns (TCL1-R1-01: the write returns at once with the line still queued)", () => {
    const { target, writes } = recordingProcess();
    const ports = processExitPorts(target);
    let flushed = 0;
    ports.writeLine("line", () => {
      flushed += 1;
    });
    expect(flushed).toBe(0);
    writes[0]?.callback?.();
    expect(flushed).toBe(1);
  });

  it("a write that throws counts as flushed: a broken log cannot hold the exit", () => {
    const { target } = recordingProcess({ writeThrows: true });
    let flushed = 0;
    processExitPorts(target).writeLine("line", () => {
      flushed += 1;
    });
    expect(flushed).toBe(1);
  });

  it("end to end through the binding: the process exits from the forced line's callback, not before", () => {
    const { target, writes, exits } = recordingProcess();
    const timers: (() => void)[] = [];
    const ports: ProcessExitPorts = {
      ...processExitPorts(target),
      unrefTimer: (_ms, fire) => {
        timers.push(fire);
      },
    };
    exitAfterStartup(75, ports);
    expect(target.exitCode).toBe(75);
    timers[0]?.();
    expect(writes).toHaveLength(1);
    expect(exits).toEqual([]);
    writes[0]?.callback?.();
    expect(exits).toEqual([75]);
  });
});

// ---------------------------------------------------------------------------
// A real process
// ---------------------------------------------------------------------------

const MODULE_URL = new URL("./process-exit.ts", import.meta.url).href;

/**
 * A child Node process. It writes `startup() returned` to stderr, then either
 * runs `exitAfterStartup(75, processExitPorts(process))` — `main.ts`'s shell,
 * call for call (`bounded`) — or only sets `process.exitCode` (the shell
 * before this round).
 *
 * With `frozenPeerPort`, it first opens a connection to a FROZEN peer — a
 * server in THIS test process that accepts and never reads — and closes it as
 * `pg` closes an idle connection (`Connection.end()` in `pg`, which
 * `pg-pool`'s `end()` calls): it keeps reading, writes the Terminate message
 * (`X`), and half-closes (`end()`) in that write's callback. That socket waits
 * for an answer that never comes. (Measured while writing this test: a socket
 * half-closed with NO write before `end()` did not hold the process; the
 * write-then-end shape does, as the frozen-PostgreSQL probe of
 * `PROVENANCE-1` r2 found.)
 *
 * With `timerHold`, a referenced interval holds it instead, and no socket is
 * opened at all (`TC-LOWS-1` r3, `NEW-1`).
 */
function childScript(options: { readonly bounded: boolean; readonly frozenPeerPort?: number; readonly timerHold?: boolean }): string {
  return `
import { createConnection } from "node:net";
import { exitAfterStartup, processExitPorts } from ${JSON.stringify(MODULE_URL)};
${options.timerHold === true ? "setInterval(() => {}, 1_000_000);" : ""}
${
  options.frozenPeerPort === undefined
    ? ""
    : `
const client = createConnection({ host: "127.0.0.1", port: ${String(options.frozenPeerPort)} });
await new Promise((resolve) => client.on("connect", resolve));
client.on("error", () => {});
client.on("data", () => {});
await new Promise((resolve) => client.write(Buffer.from([0x58, 0, 0, 0, 4]), () => { client.end(); resolve(); }));
`
}
process.stderr.write("startup() returned\\n");
${options.bounded ? "exitAfterStartup(75, processExitPorts(process));" : "process.exitCode = 75;"}
`;
}

/** A peer that accepts and never reads or answers: a frozen PostgreSQL, seen from the client. */
async function frozenPeer(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    socket.pause();
    socket.on("error", () => undefined);
    accepted.add(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the frozen peer did not bind");
  return {
    port: address.port,
    close: async () => {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

interface ChildRun {
  /** The exit code, or `"STILL RUNNING"` when the child had not exited by the deadline (it is then killed). */
  readonly outcome: number | "STILL RUNNING";
  /** Milliseconds from the child's `startup() returned` line to its exit. */
  readonly afterStartupMs: number | undefined;
  readonly stderr: string;
}

async function runChild(script: string, deadlineMs: number): Promise<ChildRun> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let returnedAt: number | undefined;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (returnedAt === undefined && stderr.includes("startup() returned\n")) returnedAt = Date.now();
  });
  return await new Promise<ChildRun>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ outcome: "STILL RUNNING", afterStartupMs: undefined, stderr });
    }, deadlineMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const exitedAt = Date.now();
      resolve({ outcome: code ?? -1, afterStartupMs: returnedAt === undefined ? undefined : exitedAt - returnedAt, stderr });
    });
  });
}

/** The bound — the grace, with a log that keeps up — plus a margin for a loaded host. */
const BOUND_MS = PROCESS_EXIT_GRACE_MS;
const MARGIN_MS = 1_500;

describe("a real process: a half-closed socket whose peer never answers", () => {
  let peer: Awaited<ReturnType<typeof frozenPeer>>;
  beforeAll(async () => {
    peer = await frozenPeer();
  });
  afterAll(async () => {
    await peer.close();
  });

  it("the defect, reproduced: a process that only sets process.exitCode is still running 3 s after it started", async () => {
    const run = await runChild(childScript({ bounded: false, frozenPeerPort: peer.port }), 3_000);
    expect(run.stderr).toContain("startup() returned");
    expect(run.outcome, run.stderr).toBe("STILL RUNNING");
  }, 20_000);

  it("the fix: the same process exits 75 within the bound, saying why — the line names the socket that held it, and blames it (TCL1-R2-01)", async () => {
    const run = await runChild(childScript({ bounded: true, frozenPeerPort: peer.port }), 10_000);
    expect(run.outcome, run.stderr).toBe(75);
    expect(run.stderr).toContain("PROCESS EXIT FORCED: startup() returned 75, and 1000 ms later the process was still held open by ");
    expect(run.stderr).toMatch(/still held open by [^:]*TCPSocketWrap/u);
    // TCL1-R2-01: the log kept up here, so the hold is the socket's alone.
    expect(run.stderr).toMatch(/still held open by [^:]*: typically a socket whose peer never answers its close \(/u);
    expect(run.stderr).not.toContain("a write its reader had not yet taken");
    expect(run.afterStartupMs).toBeGreaterThanOrEqual(PROCESS_EXIT_GRACE_MS - 50);
    expect(run.afterStartupMs).toBeLessThanOrEqual(BOUND_MS + MARGIN_MS);
  }, 20_000);

  it("the control: a process nothing holds exits 75 at once, on its own — no forced line", async () => {
    const run = await runChild(childScript({ bounded: true }), 10_000);
    expect(run.outcome, run.stderr).toBe(75);
    expect(run.stderr).not.toContain("PROCESS EXIT FORCED");
    expect(run.afterStartupMs).toBeLessThan(PROCESS_EXIT_GRACE_MS);
  }, 20_000);
});

describe("a real process a timer alone holds (TC-LOWS-1 r3, NEW-1)", () => {
  it("no socket opened, a log that keeps up: it exits 75 within the bound, and its line names the timer and blames neither a socket nor the log", async () => {
    const run = await runChild(childScript({ bounded: true, timerHold: true }), 10_000);
    expect(run.outcome, run.stderr).toBe(75);
    expect(run.stderr).toContain("PROCESS EXIT FORCED: startup() returned 75, and 1000 ms later the process was still held open by ");
    expect(run.stderr).toMatch(/still held open by [^:]*Timeout[^:]*: nothing named is a TCP connection or a pending write, so the names suggest no likelier cause\. /u);
    expect(run.stderr).not.toContain("TCPSocketWrap");
    expect(run.stderr).not.toContain("socket");
    expect(run.stderr).not.toContain("a write its reader had not yet taken");
    expect(run.afterStartupMs).toBeGreaterThanOrEqual(PROCESS_EXIT_GRACE_MS - 50);
    expect(run.afterStartupMs).toBeLessThanOrEqual(BOUND_MS + MARGIN_MS);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// A real process whose log consumer has stalled (TC-LOWS-1 r1, TCL1-R1-01)
// ---------------------------------------------------------------------------

/** Lines of 1 000 filler bytes queued ahead of the halt lines: 400 KB, far more than a 64 KiB pipe takes. */
const FILLER_LINES = 400;
/** The three lines an unconfirmed halt leaves in the log — its ONLY record. */
const HALT_LINES = [
  "HALT GLOBAL TRANSPORT_UNAVAILABLE (HALT_ALL): the event transport stopped answering",
  "HALT RECORD UNCONFIRMED: the halt record did not answer within 5000 ms",
  'health: {"halts":1}',
] as const;
/** How long the log consumer reads nothing after `startup()` returns: longer than the grace and the first version's backstop together. */
const STALL_MS = 3_000;

function fillerLine(index: number): string {
  return `filler ${String(index).padStart(6, "0")} ${"f".repeat(1_000)}`;
}

/**
 * A child that logs {@link FILLER_LINES} filler lines and then
 * {@link HALT_LINES} to stderr — every write returns at once, queued behind a
 * pipe nobody is reading — reports on STDOUT (read at once) how many bytes
 * its stderr still holds, and runs `exitAfterStartup(75,
 * processExitPorts(process))` exactly as `main.ts`'s shell does.
 */
function stalledLogChildScript(): string {
  return `
import { writeSync } from "node:fs";
import { exitAfterStartup, processExitPorts } from ${JSON.stringify(MODULE_URL)};
for (let index = 0; index < ${String(FILLER_LINES)}; index += 1) {
  process.stderr.write("filler " + String(index).padStart(6, "0") + " " + "f".repeat(1000) + "\\n");
}
for (const line of ${JSON.stringify(HALT_LINES)}) process.stderr.write(line + "\\n");
writeSync(1, "startup() returned; stderr still queued " + String(process.stderr.writableLength) + " bytes\\n");
exitAfterStartup(75, processExitPorts(process));
`;
}

interface StalledLogRun {
  readonly code: number | null;
  /** Bytes the child's stderr still held when `startup()` returned. */
  readonly queuedBytes: number;
  /** Milliseconds from `startup()` returning to the exit, and to the consumer resuming. */
  readonly exitAfterReturnMs: number;
  readonly resumedAfterReturnMs: number;
  /** Every stderr line the consumer received, in order. */
  readonly lines: readonly string[];
}

/**
 * Runs {@link stalledLogChildScript} with a log consumer that reads NOTHING
 * for {@link STALL_MS} after `startup()` returned, then everything. A
 * `readable` listener holds the stream without reading it, so what the pipe
 * already holds is kept even if the child exits during the stall.
 */
async function runWithStalledLog(): Promise<StalledLogRun> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", stalledLogChildScript()], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let returnedAt: number | undefined;
  let resumedAt: number | undefined;
  let stderr = "";
  let resumed = false;
  const drain = (): void => {
    for (let chunk = child.stderr.read() as Buffer | null; chunk !== null; chunk = child.stderr.read() as Buffer | null) {
      stderr += chunk.toString("utf8");
    }
  };
  child.stderr.on("readable", () => {
    if (resumed) drain();
  });
  const returned = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (returnedAt === undefined && stdout.includes("startup() returned")) {
        returnedAt = Date.now();
        resolve();
      }
    });
  });
  const exited = new Promise<{ readonly code: number | null; readonly at: number }>((resolve) => {
    child.on("exit", (code) => {
      resolve({ code, at: Date.now() });
    });
  });
  const ended = new Promise<void>((resolve) => {
    child.stderr.on("end", resolve);
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    await returned;
    await new Promise((resolve) => setTimeout(resolve, STALL_MS));
    resumed = true;
    resumedAt = Date.now();
    drain();
    const exit = await exited;
    await ended;
    const queued = /stderr still queued (\d+) bytes/u.exec(stdout);
    if (returnedAt === undefined || queued === null) throw new Error(`the child never reported its return: ${stdout}`);
    return {
      code: exit.code,
      queuedBytes: Number(queued[1]),
      exitAfterReturnMs: exit.at - returnedAt,
      resumedAfterReturnMs: resumedAt - returnedAt,
      lines: stderr.split("\n").filter((line) => line !== ""),
    };
  } finally {
    clearTimeout(killer);
  }
}

describe("a real process whose log consumer has stalled: the exit never cuts the log short (TC-LOWS-1 r1, TCL1-R1-01)", () => {
  it("128 KiB and more still queued at the return, the consumer stalled 3 s: EVERY line arrives, in order — the halt lines and the forced line last, blaming the log and not a socket (TCL1-R2-01) — and the process exits 75 only once the consumer has taken them", async () => {
    const run = await runWithStalledLog();
    // The premise: far more than a pipe's worth was still queued in the
    // process when startup() returned.
    expect(run.queuedBytes).toBeGreaterThanOrEqual(128 * 1_024);
    expect(run.code).toBe(75);
    // Every line, in order: none dropped, the halt lines intact, and the
    // forced line — written after the grace, behind the stalled log — last.
    const expected = [...Array.from({ length: FILLER_LINES }, (_unused, index) => fillerLine(index)), ...HALT_LINES];
    expect(run.lines.slice(0, expected.length)).toEqual(expected);
    expect(run.lines).toHaveLength(expected.length + 1);
    expect(run.lines.at(-1)).toMatch(/^PROCESS EXIT FORCED: startup\(\) returned 75, and 1000 ms later the process was still held open by /u);
    // TCL1-R2-01: only the log held this process — a write its reader had
    // not taken, as Node names it — and the line says so, not "a socket".
    expect(run.lines.at(-1)).toMatch(
      /still held open by [^:]*SimpleWriteWrap[^:]*: a write its reader had not yet taken \([^)]*SimpleWriteWrap[^)]*\): typically this log, still behind on the lines above\. /u,
    );
    expect(run.lines.at(-1)).not.toContain("socket");
    // The exit waited for the log: not before the consumer resumed.
    expect(run.exitAfterReturnMs).toBeGreaterThanOrEqual(run.resumedAfterReturnMs);
  }, 30_000);
});
