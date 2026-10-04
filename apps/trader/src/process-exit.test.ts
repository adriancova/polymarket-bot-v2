/**
 * `TC-LOWS-1` (`PROV1-R2-L2`) — the process exits once `startup()` has
 * returned, within a bound (`process-exit.ts`).
 *
 * Two layers:
 *
 * 1. the decision, through its ports: the exit code first, nothing forced
 *    while the grace runs, then one line and an exit with the SAME code — once
 *    — and a stuck log bounded too;
 * 2. a REAL Node process (Node 24 strips the module's types, so a child can
 *    import it as is), bound to the real `process` exactly as `main.ts` binds
 *    it: a half-closed socket whose peer never answers — what a frozen
 *    PostgreSQL leaves of the pool's ended idle connections — keeps a process
 *    that only sets `process.exitCode` alive; the same process exits with its
 *    code within the bound once the module runs; and a process nothing holds
 *    exits at once, with no forced line.
 *
 * The shipped bundle against a frozen PostgreSQL is
 * `test/integration/paper-trader/process-exit-frozen-postgres-redis.test.ts`.
 */

import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PROCESS_EXIT_BOUNDS,
  PROCESS_EXIT_FLUSH_MS,
  PROCESS_EXIT_GRACE_MS,
  exitAfterStartup,
  forcedExitLine,
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
  it("the bounds: 1 000 ms of grace, then at most 1 000 ms for the forced line — 2 000 ms after startup() returned", () => {
    expect(PROCESS_EXIT_GRACE_MS).toBe(1_000);
    expect(PROCESS_EXIT_FLUSH_MS).toBe(1_000);
    expect(PROCESS_EXIT_BOUNDS).toStrictEqual({ graceMs: 1_000, flushMs: 1_000 });
  });

  it("sets the exit code FIRST and arms one unreferenced grace timer — nothing is written and nothing exits while it runs (a process nothing holds exits on its own)", () => {
    const { ports, calls, timers } = recordingPorts();
    exitAfterStartup(75, ports);
    expect(calls).toEqual(["exitCode=75", "timer(1000)"]);
    expect(timers.map((timer) => timer.ms)).toEqual([PROCESS_EXIT_GRACE_MS]);
  });

  it("the grace expired: ONE line naming what holds the process, a flush backstop, and the SAME code's exit once the line is flushed — only once", () => {
    const { ports, calls, timers, pendingFlushes, lines } = recordingPorts();
    exitAfterStartup(75, ports);
    timers[0]?.fire();
    expect(calls).toEqual(["exitCode=75", "timer(1000)", "timer(1000)", "writeLine"]);
    expect(lines).toEqual([forcedExitLine(75, PROCESS_EXIT_GRACE_MS, ["TCPSocketWrap", "TCPSocketWrap", "PipeWrap"])]);
    expect(lines[0]).toContain("still held open by 1 × PipeWrap, 2 × TCPSocketWrap");
    // Not before the line is out.
    expect(calls).not.toContain("exit(75)");
    pendingFlushes[0]?.();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual(["exit(75)"]);
    // The backstop firing afterwards changes nothing.
    timers[1]?.fire();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual(["exit(75)"]);
  });

  it("a log that never takes the line does not hold the process either: the backstop exits with the same code", () => {
    const { ports, calls, timers, pendingFlushes } = recordingPorts();
    exitAfterStartup(69, ports);
    timers[0]?.fire();
    expect(timers.map((timer) => timer.ms)).toEqual([PROCESS_EXIT_GRACE_MS, PROCESS_EXIT_FLUSH_MS]);
    timers[1]?.fire();
    expect(calls.filter((call) => call.startsWith("exit("))).toEqual(["exit(69)"]);
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

  it("the forced line says what happened, why, that nothing was in flight, and the code", () => {
    expect(forcedExitLine(75, 1_000, ["TCPSocketWrap"])).toBe(
      "PROCESS EXIT FORCED: startup() returned 75 1000 ms ago, and the process is still held open by " +
        "1 × TCPSocketWrap: typically a socket whose peer never answers its close (a frozen or partitioned " +
        "PostgreSQL leaves the pool's ended idle connections half-closed). Nothing is in flight: every durable " +
        "write, and the halt record, was final — acknowledged, refused or reported UNCONFIRMED above — when " +
        "startup() returned. Exiting 75 now",
    );
  });
});

// ---------------------------------------------------------------------------
// A real process
// ---------------------------------------------------------------------------

const MODULE_URL = new URL("./process-exit.ts", import.meta.url).href;

/**
 * A child Node process. It writes `startup() returned` to stderr, then either
 * binds `exitAfterStartup` to the real process EXACTLY as `main.ts`'s shell
 * does (`bounded`), or only sets `process.exitCode` (the shell before this
 * round).
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
 */
function childScript(options: { readonly bounded: boolean; readonly frozenPeerPort?: number }): string {
  return `
import { createConnection } from "node:net";
import { exitAfterStartup } from ${JSON.stringify(MODULE_URL)};
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
${
  options.bounded
    ? `
exitAfterStartup(75, {
  setExitCode: (exitCode) => { process.exitCode = exitCode; },
  exit: (exitCode) => { process.exit(exitCode); },
  writeLine: (line, flushed) => {
    try { process.stderr.write(line + "\\n", () => { flushed(); }); } catch { flushed(); }
  },
  unrefTimer: (ms, fire) => { setTimeout(fire, ms).unref(); },
  holders: () => process.getActiveResourcesInfo(),
});
`
    : "process.exitCode = 75;"
}
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

/** The bound, plus a margin for a loaded host. */
const BOUND_MS = PROCESS_EXIT_GRACE_MS + PROCESS_EXIT_FLUSH_MS;
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

  it("the fix: the same process exits 75 within the bound, saying why — the line names the socket that held it", async () => {
    const run = await runChild(childScript({ bounded: true, frozenPeerPort: peer.port }), 10_000);
    expect(run.outcome, run.stderr).toBe(75);
    expect(run.stderr).toContain("PROCESS EXIT FORCED: startup() returned 75 1000 ms ago");
    expect(run.stderr).toMatch(/still held open by [^:]*TCPSocketWrap/u);
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
