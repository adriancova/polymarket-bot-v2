/**
 * Filesystem fault injection for the WAL suite.
 *
 * Wraps the package's in-memory filesystem so a test can reproduce the failures
 * handoff §16.6 requires — a process killed mid-append, a full disk, a failing
 * `fsync`, a host power loss — deterministically and without a real disk.
 *
 * The wrapper models the one thing that matters for durability: a torn append
 * leaves a **prefix** of the bytes in the file, and a power loss loses
 * everything appended since the last successful `fsync`.
 */

import type { MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import type { WalAppendHandle, WalFileSystem, WalReadHandle } from "@polymarket-bot/storage-wal";

/** How an injected append behaves: write `writeBytes` of the buffer, then fail. */
export type AppendFault = {
  readonly writeBytes: number;
  readonly error: Error;
};

export type FaultyFileSystemOptions = {
  /** Return a fault to inject on the given (1-based) append call. */
  readonly onAppend?: (call: number, path: string, bytes: Uint8Array) => AppendFault | undefined;
  /** Return an error to throw on the given (1-based) fsync call. */
  readonly onSync?: (call: number, path: string) => Error | undefined;
  /**
   * Total bytes the "disk" can hold across all files. An append that would
   * exceed it writes the bytes that fit and then fails with `ENOSPC`, which is
   * what a real full disk does.
   */
  readonly diskCapacityBytes?: number;
};

export type FaultyFileSystem = WalFileSystem & {
  readonly appendCalls: () => number;
  readonly syncCalls: () => number;
  /** Change the simulated disk size — an operator freeing (or losing) space. */
  readonly setDiskCapacityBytes: (bytes: number | undefined) => void;
  /**
   * Discard every byte that was appended but never fsynced, in every file — a
   * host power loss. This is the concrete meaning of the published data-loss
   * bound.
   */
  readonly simulatePowerLoss: () => void;
};

export function enospc(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOSPC: no space left on device, write ${path}`);
  error.code = "ENOSPC";
  error.errno = -28;
  error.syscall = "write";
  error.path = path;
  return error;
}

export function createFaultyFileSystem(
  base: MemoryFileSystem,
  options: FaultyFileSystemOptions = {},
): FaultyFileSystem {
  let appendCalls = 0;
  let syncCalls = 0;
  let diskCapacityBytes = options.diskCapacityBytes;
  /** Byte length of each file as of its last successful fsync. */
  const durableLength = new Map<string, number>();

  const totalBytes = (): number => {
    let total = 0;
    for (const bytes of base.files.values()) {
      total += bytes.length;
    }
    return total;
  };

  const faulty: FaultyFileSystem = {
    ...base,

    appendCalls: () => appendCalls,
    syncCalls: () => syncCalls,

    setDiskCapacityBytes(bytes: number | undefined): void {
      diskCapacityBytes = bytes;
    },

    simulatePowerLoss(): void {
      for (const [path, bytes] of [...base.files.entries()]) {
        const durable = durableLength.get(path) ?? 0;
        if (bytes.length > durable) {
          base.files.set(path, Buffer.from(bytes.subarray(0, durable)));
        }
      }
    },

    async openAppend(path: string): Promise<WalAppendHandle> {
      const inner = await base.openAppend(path);
      if (!durableLength.has(path)) {
        durableLength.set(path, (await base.fileByteLength(path)) ?? 0);
      }
      return {
        async append(bytes: Uint8Array): Promise<void> {
          appendCalls += 1;
          const fault = options.onAppend?.(appendCalls, path, bytes);
          if (fault !== undefined) {
            if (fault.writeBytes > 0) {
              await inner.append(bytes.subarray(0, fault.writeBytes));
            }
            throw fault.error;
          }
          if (diskCapacityBytes !== undefined) {
            const free = diskCapacityBytes - totalBytes();
            if (bytes.length > free) {
              if (free > 0) {
                await inner.append(bytes.subarray(0, free));
              }
              throw enospc(path);
            }
          }
          await inner.append(bytes);
        },
        async sync(): Promise<void> {
          syncCalls += 1;
          const error = options.onSync?.(syncCalls, path);
          if (error !== undefined) {
            throw error;
          }
          await inner.sync();
          durableLength.set(path, (await base.fileByteLength(path)) ?? 0);
        },
        async close(): Promise<void> {
          await inner.close();
        },
      };
    },

    async openRead(path: string): Promise<WalReadHandle> {
      return base.openRead(path);
    },

    async writeWholeFile(path: string, bytes: Uint8Array): Promise<void> {
      if (diskCapacityBytes !== undefined) {
        const existing = (await base.fileByteLength(path)) ?? 0;
        if (totalBytes() - existing + bytes.length > diskCapacityBytes) {
          throw enospc(path);
        }
      }
      await base.writeWholeFile(path, bytes);
      durableLength.set(path, bytes.length);
    },

    async truncate(path: string, byteLength: number): Promise<void> {
      await base.truncate(path, byteLength);
      durableLength.set(path, Math.min(durableLength.get(path) ?? 0, byteLength));
    },
  };

  return faulty;
}
