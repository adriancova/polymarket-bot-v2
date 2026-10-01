/**
 * One storage cycle at a time per state directory (`STORAGE-1` round 5, N2).
 *
 * A storage cycle reads, changes and writes the state directory's files — the
 * evidence holds (`evidence-holds.ts`), the clock guard's state
 * (`clock-guard.ts`) — and, in `execute` mode, keeps the holds it read in
 * memory until its last re-decision. A dry run with a state directory now
 * makes what it learned durable too. Two cycles at once would lose one's
 * update to the other's (each writes the whole file from what IT read), so
 * every cycle with a state directory runs under this lock, from before its
 * clock is read to after its last deletion: the timer and an operator's dry
 * run are serialized, whatever their modes.
 *
 * ## The lock
 *
 * One file in the state directory, created with `O_EXCL`, holding the pid,
 * the boot and the instant it was taken; removed when the cycle ends, whether
 * it succeeded or failed. A cycle that finds it held waits (polling) up to a
 * timeout, then refuses: nothing was done, and the error names the holder.
 *
 * Its name carries this host's boot id (`/proc/sys/kernel/random/boot_id`,
 * read by this module itself, the same for every process on the host,
 * containers included): `storage-cycle.<boot id>.lock`. A lock left by a
 * process that a reboot ended has another boot's name, so it holds nothing
 * after the reboot; such a file is inert and may be removed. A lock left in
 * the SAME boot by a process that was killed is never broken automatically
 * (breaking it safely would need a second protocol, as for the operator-pin
 * lock): every later cycle refuses, deleting nothing, until the operator —
 * having checked that no storage cycle runs — removes it. Where the boot id
 * cannot be read, the name is `storage-cycle.lock`, never broken
 * automatically.
 *
 * It serializes cycles on ONE host. A state directory shared between hosts is
 * not supported.
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { sha256Hex } from "@polymarket-bot/storage-parquet";

/** The lock file's name, before its boot id. */
export const STORAGE_CYCLE_LOCK_NAME = "storage-cycle";

/** How long a cycle waits for another to finish before it refuses (5 min). */
export const DEFAULT_STORAGE_CYCLE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export class StorageCycleLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageCycleLockError";
  }
}

export type StorageCycleLockOptions = {
  /** How long to wait for a running cycle (default 5 min). */
  readonly timeoutMs?: number;
  /** How often to look again while waiting (default 200 ms). */
  readonly pollMs?: number;
  /** This host's boot id; the kernel's (`hostBootId`) when absent. A test substitutes it. */
  readonly bootId?: () => Promise<string | null>;
};

/** This host's boot id, or `null` where the kernel does not give one. */
export async function hostBootId(): Promise<string | null> {
  try {
    const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The lock file for a boot: `storage-cycle.<boot id>.lock`, or `storage-cycle.lock` with none. */
export function storageCycleLockPath(stateDirectory: string, bootId: string | null): string {
  if (bootId === null) return join(stateDirectory, `${STORAGE_CYCLE_LOCK_NAME}.lock`);
  // A boot id is a UUID; anything else is digested into a safe file name.
  const name = /^[0-9A-Za-z-]{1,64}$/u.test(bootId) ? bootId : sha256Hex(Buffer.from(bootId, "utf8")).slice(0, 32);
  return join(stateDirectory, `${STORAGE_CYCLE_LOCK_NAME}.${name}.lock`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `work` holding the state directory's cycle lock. Throws
 * {@link StorageCycleLockError}, having done nothing, when another cycle
 * still holds it after the timeout.
 */
export async function withStorageCycleLock<T>(
  stateDirectory: string,
  options: StorageCycleLockOptions,
  work: () => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STORAGE_CYCLE_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 200;
  const bootId = await (options.bootId ?? hostBootId)();
  await mkdir(stateDirectory, { recursive: true });
  const path = storageCycleLockPath(stateDirectory, bootId);
  const started = performance.now();
  for (;;) {
    let handle;
    try {
      handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() - started >= timeoutMs) {
        const holder = await readFile(path, "utf8").catch(() => "(unreadable)");
        throw new StorageCycleLockError(
          `another storage cycle holds ${path} (${holder.trim()}); nothing was done. If no storage cycle runs on this host, remove it`,
        );
      }
      await sleep(pollMs);
      continue;
    }
    // Taken. The description is for the operator only: failing to write it
    // does not undo the lock, which is released below like any other.
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, bootId, acquiredAt: new Date().toISOString() })}\n`).catch(() => undefined);
    await handle.close().catch(() => undefined);
    break;
  }
  try {
    return await work();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
