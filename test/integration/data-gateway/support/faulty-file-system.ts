/**
 * A WAL filesystem that can be made to fail, wrapping the WP-050 in-memory
 * one.
 *
 * Only what this suite needs: appends and fsyncs that start failing on
 * command. That is enough to drive the writer into its fault state and prove
 * the gateway turns a write fault into a PAGE incident rather than a silent
 * stop (WP-050 `follow_up` 4).
 */

import type { MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";

export interface FaultyWalFileSystem extends MemoryFileSystem {
  /** Every append and fsync from now on rejects. */
  failWrites(reason?: string): void;
  /** Writes succeed again. */
  healWrites(): void;
}

export function createFaultyWalFileSystem(): FaultyWalFileSystem {
  const inner = createMemoryFileSystem();
  let failure: string | undefined;

  const wrapped: FaultyWalFileSystem = {
    ...inner,
    files: inner.files,
    stats: inner.stats,
    peek: (path) => inner.peek(path),
    poke: (path, bytes) => {
      inner.poke(path, bytes);
    },
    snapshot: () => inner.snapshot(),
    resetStats: () => {
      inner.resetStats();
    },
    ensureDirectory: (path) => inner.ensureDirectory(path),
    listFileNames: (path) => inner.listFileNames(path),
    fileByteLength: (path) => inner.fileByteLength(path),
    openRead: (path) => inner.openRead(path),
    readWholeFile: (path) => inner.readWholeFile(path),
    joinPath: (...segments) => inner.joinPath(...segments),
    truncate: (path, byteLength) => inner.truncate(path, byteLength),
    writeWholeFile: async (path, bytes) => {
      if (failure !== undefined) throw new Error(failure);
      await inner.writeWholeFile(path, bytes);
    },
    openAppend: async (path) => {
      const handle = await inner.openAppend(path);
      return {
        append: async (bytes) => {
          if (failure !== undefined) throw new Error(failure);
          await handle.append(bytes);
        },
        sync: async () => {
          if (failure !== undefined) throw new Error(failure);
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
    failWrites: (reason = "injected write failure") => {
      failure = reason;
    },
    healWrites: () => {
      failure = undefined;
    },
  };
  return wrapped;
}
