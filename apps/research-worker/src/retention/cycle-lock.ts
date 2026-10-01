/**
 * One storage cycle at a time per state directory (`STORAGE-1` round 5, N2;
 * `STORAGE-1b`).
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
 * the boot and the instant it was taken; removed by its holder when the cycle
 * ends, whether it succeeded or failed. A cycle that finds it held waits
 * (polling) up to a timeout, then refuses: nothing was done, and the error
 * names the holder. A cycle that cannot create it for any other reason
 * (`EACCES`, `EROFS`, `ENOSPC`, `EMFILE`, …) refuses at once with a
 * {@link StorageCycleLockError} that names the error (its `cause`): it runs
 * nothing and removes nothing, since the file at the lock's path may be
 * another cycle's (`STORAGE-1b`, R6-LOCK-OPEN-ERROR-UNTESTED).
 *
 * ## Its name: this boot's
 *
 * Its name carries this host's boot id, which this module reads from the
 * kernel (`/proc/sys/kernel/random/boot_id`; Linux does not namespace it, so
 * every process on the host that CAN read it, containers included, reads the
 * same one): `storage-cycle.<boot id>.lock`. Two cycles exclude each other
 * only when they derive the SAME name.
 *
 * - **A reboot makes the old lock inert.** A lock left by a process that a
 *   reboot ended has another boot's name, so it holds nothing after the
 *   reboot; such a file may be removed by hand.
 * - **A stale lock of this boot is never broken automatically.** A lock left
 *   in the SAME boot by a process that was killed holds: breaking it safely
 *   would need a second protocol, as for the operator-pin lock. Every later
 *   cycle refuses, deleting nothing, until the operator — having checked that
 *   no storage cycle runs — removes it.
 * - **No boot id, no cycle** (`STORAGE-1b`, R6-LOCK-NAME-FALLBACK). A cycle
 *   that cannot read the boot id, or reads anything but a kernel boot id (a
 *   lowercase UUID), refuses with a {@link StorageCycleLockError} naming the
 *   cause, before it creates anything (not even the state directory). There
 *   is no fallback name: a cycle on one would hold another file than every
 *   cycle that reads the boot id, and the two would run at once. So the
 *   command runs only where the kernel's boot id can be read: on Linux, and
 *   not under a `/proc` mounted `subset=pid` — systemd's `ProcSubset=pid`
 *   hides `/proc/sys`, so a unit hardened that way never runs a cycle (it is
 *   not supported).
 * - **The name an earlier version fell back to** (`storage-cycle.lock`, taken
 *   where the boot id could not be read) counts as held: while a file by that
 *   name exists in the state directory, a cycle waits, then refuses, naming
 *   it. No cycle takes or removes it any more; the operator removes it, having
 *   checked that no storage cycle (of an earlier version) runs.
 *
 * It serializes cycles on ONE host whose processes all read its kernel's boot
 * id. A state directory shared between hosts is not supported; nor is one
 * shared with a sandbox that presents a boot id of its own (a gVisor sandbox,
 * a virtual machine): it is another host to this lock.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/** The lock file's name, before its boot id. */
export const STORAGE_CYCLE_LOCK_NAME = "storage-cycle";

/** Where the kernel gives this boot's id (Linux). */
export const KERNEL_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * The lock an earlier version took where it could not read the boot id. No
 * cycle takes it now; while it exists, every cycle counts it as held.
 */
export const LEGACY_STORAGE_CYCLE_LOCK_FILE_NAME = `${STORAGE_CYCLE_LOCK_NAME}.lock`;

/** How long a cycle waits for another to finish before it refuses (5 min). */
export const DEFAULT_STORAGE_CYCLE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export class StorageCycleLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageCycleLockError";
  }
}

/** The lock file's operations. A test substitutes them to fail a step. */
export type StorageCycleLockFileSystem = {
  readonly open: (
    path: string,
    flags: number,
    mode: number,
  ) => Promise<{ writeFile(data: string): Promise<void>; close(): Promise<void> }>;
  readonly lstat: (path: string) => Promise<unknown>;
  readonly unlink: (path: string) => Promise<void>;
};

/** The real filesystem's. */
export const nodeStorageCycleLockFileSystem: StorageCycleLockFileSystem = {
  open: async (path, flags, mode) => await open(path, flags, mode),
  lstat: async (path) => await lstat(path),
  unlink: async (path) => await unlink(path),
};

export type StorageCycleLockOptions = {
  /** How long to wait for a running cycle (default 5 min). */
  readonly timeoutMs?: number;
  /** How often to look again while waiting (default 200 ms). */
  readonly pollMs?: number;
  /**
   * Reads this host's boot id; the kernel's (`hostBootId`) when absent. A
   * rejection, or anything but a kernel boot id, refuses the cycle. A test
   * substitutes it.
   */
  readonly bootId?: () => Promise<string>;
  /** The lock file's operations; the real filesystem's when absent. */
  readonly fileSystem?: StorageCycleLockFileSystem;
};

/**
 * This host's boot id, as the kernel prints it (trimmed). Rejects with the
 * read's own error where it cannot be read: no such file under a `/proc`
 * mounted `subset=pid`, or on a platform without one; a permission denied.
 */
export async function hostBootId(path: string = KERNEL_BOOT_ID_PATH): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

/** Whether `value` is a kernel boot id: a UUID in lowercase hexadecimal, as Linux prints it. */
export function isBootId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

/** The lock file of a boot: `storage-cycle.<boot id>.lock`. Refuses anything but a kernel boot id. */
export function storageCycleLockPath(stateDirectory: string, bootId: string): string {
  if (!isBootId(bootId)) {
    throw new StorageCycleLockError(`${describeValue(bootId)} is not a kernel boot id, so it names no storage cycle lock`);
  }
  return join(stateDirectory, `${STORAGE_CYCLE_LOCK_NAME}.${bootId}.lock`);
}

const BOOT_ID_REQUIRED =
  `every storage cycle with a state directory must read this host's kernel boot id (${KERNEL_BOOT_ID_PATH}), ` +
  "so that all of them take the same lock. A /proc mounted subset=pid (systemd ProcSubset=pid) hides it and is not supported";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value.slice(0, 64)) : String(value);
}

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** This cycle's boot id, or a refusal naming why there is none. */
async function thisBoot(read: () => Promise<string>): Promise<string> {
  let bootId: unknown;
  try {
    bootId = await read();
  } catch (error) {
    throw new StorageCycleLockError(
      `this host's boot id cannot be read (${describeError(error)}); nothing was done: ${BOOT_ID_REQUIRED}`,
      { cause: error },
    );
  }
  if (!isBootId(bootId)) {
    throw new StorageCycleLockError(
      `this host's boot id reads as ${describeValue(bootId)}, which is not a kernel boot id; nothing was done: ${BOOT_ID_REQUIRED}`,
    );
  }
  return bootId;
}

/** Whether the earlier version's lock is present. Anything but "no such file" refuses. */
async function legacyLockPresent(fileSystem: StorageCycleLockFileSystem, legacyPath: string): Promise<boolean> {
  try {
    await fileSystem.lstat(legacyPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new StorageCycleLockError(
      `whether ${legacyPath} exists cannot be read (${describeError(error)}); nothing was done, and nothing was removed`,
      { cause: error },
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `work` holding the state directory's cycle lock. Throws
 * {@link StorageCycleLockError}, having done nothing and removed nothing,
 * when this host's boot id cannot be read, when the lock cannot be created
 * (any error but "already exists"), or when another cycle still holds it — or
 * the earlier version's lock is present — after the timeout.
 */
export async function withStorageCycleLock<T>(
  stateDirectory: string,
  options: StorageCycleLockOptions,
  work: () => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STORAGE_CYCLE_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 200;
  const fileSystem = options.fileSystem ?? nodeStorageCycleLockFileSystem;
  // First, before anything is created: no boot id, no cycle.
  const bootId = await thisBoot(options.bootId ?? (async () => await hostBootId()));
  const path = storageCycleLockPath(stateDirectory, bootId);
  const legacyPath = join(stateDirectory, LEGACY_STORAGE_CYCLE_LOCK_FILE_NAME);
  await mkdir(stateDirectory, { recursive: true });
  const started = performance.now();
  for (;;) {
    const legacy = await legacyLockPresent(fileSystem, legacyPath);
    if (!legacy) {
      let handle;
      try {
        handle = await fileSystem.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          // Not taken, and not known to be held: refuse now. The file at
          // `path`, if any, is not this cycle's, so nothing is removed.
          throw new StorageCycleLockError(
            `the storage cycle lock ${path} cannot be created (${describeError(error)}); nothing was done, and nothing was removed`,
            { cause: error },
          );
        }
      }
      if (handle !== undefined) {
        // Taken. The description is for the operator only: failing to write
        // it does not undo the lock, which is released below like any other.
        await handle
          .writeFile(`${JSON.stringify({ pid: process.pid, bootId, acquiredAt: new Date().toISOString() })}\n`)
          .catch(() => undefined);
        await handle.close().catch(() => undefined);
        break;
      }
    }
    if (performance.now() - started >= timeoutMs) {
      const held = legacy ? legacyPath : path;
      const holder = (await readFile(held, "utf8").catch(() => "(unreadable)")).trim();
      throw new StorageCycleLockError(
        legacy
          ? `an earlier version's storage cycle lock ${legacyPath} is present (${holder}), taken where the boot id could not be read; ` +
              "nothing was done. If no storage cycle runs on this host, remove it"
          : `another storage cycle holds ${path} (${holder}); nothing was done. If no storage cycle runs on this host, remove it`,
      );
    }
    await sleep(pollMs);
  }
  try {
    return await work();
  } finally {
    await fileSystem.unlink(path).catch(() => undefined);
  }
}
