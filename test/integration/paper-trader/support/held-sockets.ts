/**
 * `TC-LOWS-1` r1 (`TCL1-R1-03`) — the TCP sockets a LIVE child process still
 * holds open, and in which state, read from Linux's `/proc`.
 *
 * WHY. `PROCESS EXIT FORCED: …` names what holds the process by Node's handle
 * type only (`process.getActiveResourcesInfo()`): a `TCPSocketWrap` to a
 * frozen PostgreSQL and one to a frozen Redis read the same. A test that must
 * show WHICH peer's socket held the process reads the socket table instead:
 * `/proc/<pid>/fd` maps the process's descriptors to socket inodes, and
 * `/proc/<pid>/net/tcp` (and `tcp6`) maps each inode to its ports and its
 * TCP state. A connection the client has half-closed — written its last bytes
 * and sent its FIN — against a peer that never answers sits in `FIN_WAIT2`:
 * the kernel of the peer acknowledged the FIN, the peer never sent its own.
 *
 * Linux only, as this suite's Testcontainers runs are. Read only; nothing here
 * touches the process.
 */

import { readFile, readdir, readlink } from "node:fs/promises";

/** The kernel's TCP states (`include/net/tcp_states.h`), as `/proc/net/tcp` writes them. */
const TCP_STATES: Readonly<Record<string, string>> = {
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
};

export interface HeldTcpSocket {
  readonly localPort: number;
  readonly remotePort: number;
  /** `ESTABLISHED`, `FIN_WAIT2`, … */
  readonly state: string;
}

/**
 * The TCP sockets process `pid` holds open now, or `undefined` once it holds
 * no descriptor at all (it has exited, or is exiting).
 */
export async function tcpSocketsHeldBy(pid: number): Promise<readonly HeldTcpSocket[] | undefined> {
  let descriptors: string[];
  try {
    descriptors = await readdir(`/proc/${String(pid)}/fd`);
  } catch {
    return undefined;
  }
  if (descriptors.length === 0) return undefined;
  const inodes = new Set<string>();
  for (const descriptor of descriptors) {
    try {
      const target = await readlink(`/proc/${String(pid)}/fd/${descriptor}`);
      const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
      if (inode !== undefined) inodes.add(inode);
    } catch {
      // Closed between the listing and the read.
    }
  }
  const held: HeldTcpSocket[] = [];
  for (const table of ["tcp", "tcp6"]) {
    let text: string;
    try {
      text = await readFile(`/proc/${String(pid)}/net/${table}`, "utf8");
    } catch {
      return undefined;
    }
    for (const row of text.split("\n").slice(1)) {
      const fields = row.trim().split(/\s+/u);
      const [local, remote, state, inode] = [fields[1], fields[2], fields[3], fields[9]];
      if (local === undefined || remote === undefined || state === undefined || inode === undefined) continue;
      if (!inodes.has(inode)) continue;
      held.push({
        localPort: Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16),
        remotePort: Number.parseInt(remote.slice(remote.lastIndexOf(":") + 1), 16),
        state: TCP_STATES[state.toUpperCase()] ?? `0x${state}`,
      });
    }
  }
  return held;
}

/** One reading of {@link tcpSocketsHeldBy}, with the instant it was taken. */
export interface HeldSocketsSample {
  readonly at: number;
  readonly sockets: readonly HeldTcpSocket[];
  /**
   * Milliseconds from this reading to the sampler's NEXT attempt (the one
   * that found the process gone, or the end of the sampling). For a failure
   * message only (`TC-LOWS-1` r2, `TCL1-R2-03`): about `everyMs` plus one
   * read while the sampling process keeps up, so a gap far beyond that says
   * the SAMPLING process stalled, not the process it reads.
   */
  readonly nextAttemptAfterMs: number;
}

/**
 * Samples {@link tcpSocketsHeldBy} every `everyMs` until `until` settles, and
 * returns the LAST sample taken while the process still held descriptors —
 * the closest reading to its exit — or `undefined` if none was.
 */
export async function lastHeldSocketsBefore(
  pid: number,
  until: Promise<unknown>,
  everyMs = 20,
): Promise<HeldSocketsSample | undefined> {
  let settled = false;
  const settle = (): void => {
    settled = true;
  };
  until.then(settle, settle);
  let last: { readonly at: number; readonly sockets: readonly HeldTcpSocket[] } | undefined;
  let nextAttemptAfterMs: number | undefined;
  while (!settled) {
    // `at` is when the descriptors were listed: the process was alive then.
    // A socket table read after it exited lists no inode of it (an orphaned
    // socket reads inode 0), so a late read can only under-report.
    const at = Date.now();
    if (last !== undefined && nextAttemptAfterMs === undefined) nextAttemptAfterMs = at - last.at;
    const sockets = await tcpSocketsHeldBy(pid);
    if (sockets !== undefined) {
      last = { at, sockets };
      nextAttemptAfterMs = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  if (last === undefined) return undefined;
  return { ...last, nextAttemptAfterMs: nextAttemptAfterMs ?? Date.now() - last.at };
}
