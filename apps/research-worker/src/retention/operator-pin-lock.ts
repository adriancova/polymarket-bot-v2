/**
 * The protocol that serializes operator-pin publication with expiry
 * (`STORAGE-1`; ADR-028 Decision 2.5: "No operator pin covers the segment" —
 * at the unlink, not only when the plan was made).
 *
 * ## The protocol
 *
 * One lock file, beside the operator-pin file (`<pins file>.lock`), created
 * with `O_EXCL`:
 *
 * - **Publication** (`publishOperatorPin`, the `storage pin` command) takes
 *   the lock, writes the new pin file durably (temporary file, `fsync`, atomic
 *   rename, `fsync` of the directory), and only then releases it.
 * - **Expiry** takes the same lock around each segment's final decision: the
 *   fresh re-decision (which re-reads the operator's pins), the byte-level
 *   proof, a last re-read of the pins immediately before the unlink, and the
 *   unlink itself (`execute.ts`).
 *
 * So a publication is linearized at the moment it takes the lock: a deletion
 * that started first completes before the pin is written, and every deletion
 * that starts after it sees the pin. Expiry pauses briefly after releasing the
 * lock before it takes it for the next segment, so a waiting publisher is not
 * starved by a long plan. A pin edited by hand, without the command, is still
 * re-read immediately before each unlink, which narrows the window to the
 * unlink itself; only the command gives the guarantee.
 *
 * A lock left by a crashed process is never broken automatically (breaking
 * it safely would need a second protocol): expiry refuses to delete while it
 * is held, and the error names the file and its holder, for the operator to
 * remove once no storage or pin process runs.
 */

import { constants as fsConstants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { parseOperatorPins } from "./windows.js";
import type { OperatorPin } from "./windows.js";
import { parseStrictJsonBytes } from "@polymarket-bot/storage-parquet";

/** Held around every operator-pin publication and every expiry's final check and unlink. */
export interface OperatorPinLock {
  /** Run `work` while holding the lock. Throws {@link OperatorPinLockError} when it cannot be taken. */
  withLock<T>(work: () => Promise<T>): Promise<T>;
}

export class OperatorPinLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorPinLockError";
  }
}

/** The lock file of an operator-pin file. */
export function operatorPinLockPath(operatorPinsPath: string): string {
  return `${operatorPinsPath}.lock`;
}

/** No pin file is configured, so no pin can be published: nothing to serialize with. */
export function noOperatorPinLock(): OperatorPinLock {
  return { withLock: async (work) => await work() };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The lock as an `O_EXCL` file. */
export function fileOperatorPinLock(
  lockPath: string,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): OperatorPinLock {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 50;
  let releasedAtMs = Number.NEGATIVE_INFINITY;
  return {
    async withLock<T>(work: () => Promise<T>): Promise<T> {
      // Fairness: a holder that just released waits two polls before taking
      // it again, so another waiter (a publisher) gets its turn.
      const pause = releasedAtMs + 2 * pollMs - Date.now();
      if (pause > 0) await sleep(pause);
      const started = Date.now();
      for (;;) {
        try {
          const handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
          try {
            await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
          } finally {
            await handle.close();
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (Date.now() - started >= timeoutMs) {
            const holder = await readFile(lockPath, "utf8").catch(() => "(unreadable)");
            throw new OperatorPinLockError(
              `the operator-pin lock ${lockPath} is held (${holder.trim()}); if no storage or pin process runs, remove it`,
            );
          }
          await sleep(pollMs);
        }
      }
      try {
        return await work();
      } finally {
        await unlink(lockPath).catch(() => undefined);
        releasedAtMs = Date.now();
      }
    },
  };
}

/** Write a file durably: temporary file, fsync, atomic rename, fsync of the directory. */
async function writeDurably(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid.toString(36)}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/**
 * Publish one operator pin under the lock: the pin file is read, the pin is
 * appended (its id must be new), and the file is replaced durably before the
 * lock is released. Returns every pin now in the file.
 */
export async function publishOperatorPin(input: {
  readonly operatorPinsPath: string;
  readonly lock: OperatorPinLock;
  readonly pin: { readonly pinId: string; readonly from: string; readonly to: string; readonly reason: string };
}): Promise<readonly OperatorPin[]> {
  return await input.lock.withLock(async () => {
    let existing: { operatorPinVersion: number; pins: unknown[] } = { operatorPinVersion: 1, pins: [] };
    try {
      const value = parseStrictJsonBytes(await readFile(input.operatorPinsPath));
      parseOperatorPins(value);
      existing = value as typeof existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = { operatorPinVersion: existing.operatorPinVersion, pins: [...existing.pins, input.pin] };
    // Refuses a duplicate id or a malformed pin before anything is written.
    const pins = parseOperatorPins(next);
    await writeDurably(input.operatorPinsPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
    return pins;
  });
}
