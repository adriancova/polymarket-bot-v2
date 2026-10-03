/**
 * An in-memory {@link WalFileSystem} for tests.
 *
 * Exposed on the package's `./testing` subpath rather than its main entry point:
 * it is a test double, and no production composition root should be able to
 * reach it by importing the package barrel.
 *
 * It records `fsync` and append calls so a test can assert the *durability
 * policy* — how often the writer syncs — rather than only the resulting bytes.
 */

import type { WalAppendHandle, WalFileSystem, WalReadHandle } from "../ports.js";

export type MemoryFileSystemStats = {
  appends: number;
  appendedBytes: number;
  syncs: number;
  truncations: number;
  wholeFileWrites: number;
  opensForAppend: number;
  opensForRead: number;
};

export type MemoryFileSystem = WalFileSystem & {
  /** Live view of the stored files, keyed by full path. */
  readonly files: Map<string, Buffer>;
  readonly stats: MemoryFileSystemStats;
  /** Bytes of one file, or `undefined`. */
  peek(path: string): Buffer | undefined;
  /** Overwrite a file's bytes directly — used to simulate corruption. */
  poke(path: string, bytes: Uint8Array): void;
  /** UTF-8 snapshot of every file, for assertions and debugging. */
  snapshot(): Record<string, string>;
  resetStats(): void;
};

function normalize(path: string): string {
  return path.replace(/\/+/gu, "/");
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Create an in-memory filesystem. */
export function createMemoryFileSystem(): MemoryFileSystem {
  const files = new Map<string, Buffer>();
  const directories = new Set<string>(["/"]);
  const stats: MemoryFileSystemStats = {
    appends: 0,
    appendedBytes: 0,
    syncs: 0,
    truncations: 0,
    wholeFileWrites: 0,
    opensForAppend: 0,
    opensForRead: 0,
  };

  const fileSystem: MemoryFileSystem = {
    files,
    stats,

    peek(path: string): Buffer | undefined {
      return files.get(normalize(path));
    },

    poke(path: string, bytes: Uint8Array): void {
      files.set(normalize(path), Buffer.from(bytes));
    },

    snapshot(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [path, bytes] of files) {
        result[path] = bytes.toString("utf8");
      }
      return result;
    },

    resetStats(): void {
      stats.appends = 0;
      stats.appendedBytes = 0;
      stats.syncs = 0;
      stats.truncations = 0;
      stats.wholeFileWrites = 0;
      stats.opensForAppend = 0;
      stats.opensForRead = 0;
    },

    async ensureDirectory(directoryPath: string): Promise<void> {
      directories.add(normalize(directoryPath));
    },

    async listFileNames(directoryPath: string): Promise<readonly string[]> {
      const target = normalize(directoryPath);
      const names: string[] = [];
      for (const path of files.keys()) {
        if (directoryOf(path) === target) {
          names.push(baseNameOf(path));
        }
      }
      return names.sort();
    },

    async listDirectoryNames(directoryPath: string): Promise<readonly string[]> {
      const target = normalize(directoryPath);
      const names = new Set<string>();
      // A directory exists here when it was ensured or when a file lives at or
      // below it, so every ancestor of every file is considered.
      const consider = (directory: string): void => {
        let current = directory;
        while (current !== "/" && current !== "") {
          const parent = directoryOf(current);
          if (parent === target) {
            names.add(baseNameOf(current));
            return;
          }
          if (parent === current) {
            return;
          }
          current = parent;
        }
      };
      for (const directory of directories) {
        consider(directory);
      }
      for (const path of files.keys()) {
        consider(directoryOf(path));
      }
      return [...names].sort();
    },

    async fileByteLength(path: string): Promise<number | null> {
      const bytes = files.get(normalize(path));
      return bytes === undefined ? null : bytes.length;
    },

    async openAppend(path: string): Promise<WalAppendHandle> {
      const key = normalize(path);
      stats.opensForAppend += 1;
      if (!files.has(key)) {
        files.set(key, Buffer.alloc(0));
      }
      const handle: WalAppendHandle = {
        async append(bytes: Uint8Array): Promise<void> {
          const current = files.get(key) ?? Buffer.alloc(0);
          files.set(key, Buffer.concat([current, Buffer.from(bytes)]));
          stats.appends += 1;
          stats.appendedBytes += bytes.length;
        },
        async sync(): Promise<void> {
          stats.syncs += 1;
        },
        async close(): Promise<void> {
          // Nothing to release in memory.
        },
      };
      return handle;
    },

    async openRead(path: string): Promise<WalReadHandle> {
      const key = normalize(path);
      stats.opensForRead += 1;
      const handle: WalReadHandle = {
        async read(offset: number, length: number): Promise<Uint8Array> {
          const bytes = files.get(key);
          if (bytes === undefined) {
            throw new Error(`memory filesystem: ${key} does not exist`);
          }
          return Buffer.from(bytes.subarray(offset, offset + length));
        },
        async close(): Promise<void> {
          // Nothing to release in memory.
        },
      };
      return handle;
    },

    async readWholeFile(path: string): Promise<Uint8Array> {
      const bytes = files.get(normalize(path));
      if (bytes === undefined) {
        throw new Error(`memory filesystem: ${normalize(path)} does not exist`);
      }
      return Buffer.from(bytes);
    },

    async writeWholeFile(path: string, bytes: Uint8Array): Promise<void> {
      files.set(normalize(path), Buffer.from(bytes));
      stats.wholeFileWrites += 1;
    },

    async truncate(path: string, byteLength: number): Promise<void> {
      const key = normalize(path);
      const bytes = files.get(key);
      if (bytes === undefined) {
        throw new Error(`memory filesystem: ${key} does not exist`);
      }
      files.set(key, Buffer.from(bytes.subarray(0, byteLength)));
      stats.truncations += 1;
    },

    joinPath(...segments: readonly string[]): string {
      return normalize(segments.filter((segment) => segment.length > 0).join("/"));
    },
  };

  return fileSystem;
}
