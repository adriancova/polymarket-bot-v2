/**
 * `TC-LOWS-1` (`PROV1-R2-L2`) — the process EXITS once `startup()` has
 * returned, within a stated bound.
 *
 * ## The defect
 *
 * The process shell used to end with `process.exitCode = await startup(...)`
 * and nothing more, so the process exited only when nothing held Node's event
 * loop any longer. On a FROZEN PostgreSQL (a paused server, a partition)
 * `startup()` returns 75 within its bound (`PROVENANCE-1`), but the pool's
 * close ends each idle connection with a Terminate and a half-close
 * (`stream.end()`), and does not wait for the peer. A socket whose peer never
 * answers that close stays open, half-closed, and keeps the process alive
 * until PostgreSQL answers again or TCP gives up. `PROVENANCE-1`'s review
 * measured two such sockets still active 3 s after `startup()` returned, and
 * a standalone check showed one keeps Node alive indefinitely.
 *
 * ## The choice: a bounded exit AFTER `startup()` returns, in the shell
 *
 * {@link exitAfterStartup} sets the exit code, then arms an UNREFERENCED
 * timer of {@link PROCESS_EXIT_GRACE_MS}:
 *
 * - if nothing holds the process, it exits on its own, at once, with that
 *   code — the timer never fires (an unreferenced timer holds nothing), and
 *   every line already written is flushed by Node as it always was;
 * - if something still holds it when the timer fires, one line says so
 *   (`PROCESS EXIT FORCED: …`, naming what holds it), and the process exits
 *   with the SAME code once that line is flushed — or after
 *   {@link PROCESS_EXIT_FLUSH_MS} if the log itself is stuck.
 *
 * WHY THIS IS SAFE. It runs only after `startup()` has RETURNED, and by then
 * every durable outcome is final and nothing is in flight:
 *
 * - the pump has stopped, and every write the loop made was awaited before it
 *   did (`pump`, `CoreLoop.drain`): each was acknowledged or refused, and a
 *   refusal latched its halt;
 * - the halt record (`recordHaltsBeforeExit`) was awaited: written, refused,
 *   or answered `UNCONFIRMED` at its bound — and at that bound its own
 *   connection was already DESTROYED (`PostgresTraderStore.recordHalts`,
 *   `PROVENANCE-1` r1), so exiting cannot change what that connection sent;
 * - the store's close (`pool.end()`) returned only once no connection was
 *   checked out: what is left is idle connections the pool already ENDED,
 *   which carry no query — only the Terminate of a finished session;
 * - every line `startup()` logged was written before it returned, in order,
 *   and the forced path exits only from the write callback of its OWN line,
 *   which comes after them all.
 *
 * So an acknowledged write stays acknowledged — it is the server's, and
 * nothing here can retract it — and no halt record is lost: a record that
 * landed is in `ops.incidents`, and one that could not land was reported as
 * such (`HALT RECORD NOT DURABLE` / `UNCONFIRMED`) before `startup()`
 * returned, beside the `HALT …` line that names it.
 *
 * WHY NOT FIX IT IN THE STORE. Destroying the pool's ended sockets would need
 * `pg`'s private connection objects (`pg-pool` drops a client from its list
 * the moment it ends it), and it would cover PostgreSQL alone, not a Redis
 * connection or any other handle a dependency leaves half-open. One bounded
 * exit at the one point where the process is finished covers every handle,
 * and it cannot run early: before `startup()` returns it is not armed.
 *
 * WHY THE PURE PART LIVES HERE. `main.ts` stays the only file in the package
 * that touches `process` (its module header): it binds the {@link ProcessExitPorts}
 * to the real process; everything decided is here, and is tested with ports
 * (`process-exit.test.ts`) and, through the shipped bundle, against a frozen
 * PostgreSQL (`test/integration/paper-trader/process-exit-frozen-postgres-redis.test.ts`).
 */

/**
 * How long the process may stay alive after `startup()` returned before it is
 * exited by force. Every handle a healthy shutdown leaves closes in
 * milliseconds; one still open after this long is held by a peer that is not
 * answering.
 */
export const PROCESS_EXIT_GRACE_MS = 1_000;

/** How long the forced exit waits for its own log line to be flushed. */
export const PROCESS_EXIT_FLUSH_MS = 1_000;

/** What {@link exitAfterStartup} needs from the process. `main.ts` binds them. */
export interface ProcessExitPorts {
  /** Sets the code a NATURAL exit uses (`process.exitCode`). */
  readonly setExitCode: (code: number) => void;
  /** Exits NOW with `code` (`process.exit`). */
  readonly exit: (code: number) => void;
  /**
   * Writes one line to the operator's log, and calls `flushed` once it has
   * been handed to the operating system — or has failed. Never throws.
   */
  readonly writeLine: (line: string, flushed: () => void) => void;
  /**
   * Runs `fire` after `ms`, on a timer that does NOT hold the process: it
   * fires only while something else does.
   */
  readonly unrefTimer: (ms: number, fire: () => void) => void;
  /** What still holds the process, for the log line (`process.getActiveResourcesInfo`). */
  readonly holders: () => readonly string[];
}

export interface ProcessExitBounds {
  readonly graceMs: number;
  readonly flushMs: number;
}

export const PROCESS_EXIT_BOUNDS: ProcessExitBounds = Object.freeze({
  graceMs: PROCESS_EXIT_GRACE_MS,
  flushMs: PROCESS_EXIT_FLUSH_MS,
});

/**
 * The process's last act, once `startup()` has returned `code`: exit with it
 * within `bounds.graceMs + bounds.flushMs` (see the module header). Called
 * exactly once, by the process shell; never before `startup()` returns.
 */
export function exitAfterStartup(code: number, ports: ProcessExitPorts, bounds: ProcessExitBounds = PROCESS_EXIT_BOUNDS): void {
  ports.setExitCode(code);
  ports.unrefTimer(bounds.graceMs, () => {
    let exited = false;
    const exitOnce = (): void => {
      if (exited) return;
      exited = true;
      ports.exit(code);
    };
    // A log that cannot take the line (a full pipe nobody reads) must not
    // hold the process either.
    ports.unrefTimer(bounds.flushMs, exitOnce);
    let holders: readonly string[];
    try {
      holders = ports.holders();
    } catch {
      holders = [];
    }
    ports.writeLine(forcedExitLine(code, bounds.graceMs, holders), exitOnce);
  });
}

/** The forced exit's one log line. Exported for its test. */
export function forcedExitLine(code: number, graceMs: number, holders: readonly string[]): string {
  return (
    `PROCESS EXIT FORCED: startup() returned ${String(code)} ${String(graceMs)} ms ago, and the process is ` +
    `still held open by ${describeHolders(holders)}: typically a socket whose peer never answers its close ` +
    "(a frozen or partitioned PostgreSQL leaves the pool's ended idle connections half-closed). Nothing is " +
    "in flight: every durable write, and the halt record, was final — acknowledged, refused or reported " +
    `UNCONFIRMED above — when startup() returned. Exiting ${String(code)} now`
  );
}

/** `["TCPSocketWrap", "TCPSocketWrap", "Timeout"]` → `2 × TCPSocketWrap, 1 × Timeout`. */
function describeHolders(holders: readonly string[]): string {
  if (holders.length === 0) return "a handle Node does not name";
  const counts = new Map<string, number>();
  for (const holder of holders) counts.set(holder, (counts.get(holder) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([holder, count]) => `${String(count)} × ${holder}`)
    .join(", ");
}
