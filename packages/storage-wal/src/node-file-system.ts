/**
 * The Node.js implementation of {@link WalFileSystem}.
 *
 * This is the only module that touches a real disk. It deliberately exposes no
 * delete operation (see `ports.ts`), and it writes manifests through a
 * temp-file-plus-rename so a crash cannot leave a half-written sidecar that
 * would make a good segment look invalid.
 */

import { mkdir, open, readFile, readdir, rename, stat, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { WalAppendHandle, WalFileSystem, WalReadHandle } from "./ports.js";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

class NodeAppendHandle implements WalAppendHandle {
  readonly #handle: FileHandle;
  readonly #path: string;

  constructor(handle: FileHandle, path: string) {
    this.#handle = handle;
    this.#path = path;
  }

  async append(bytes: Uint8Array): Promise<void> {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await this.#handle.write(buffer, offset, buffer.length - offset);
      if (bytesWritten <= 0) {
        throw new Error(`append to ${this.#path} made no progress`);
      }
      offset += bytesWritten;
    }
  }

  async sync(): Promise<void> {
    await this.#handle.sync();
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

class NodeReadHandle implements WalReadHandle {
  readonly #handle: FileHandle;

  constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) {
      return new Uint8Array(0);
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.#handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

/** A {@link WalFileSystem} backed by `node:fs/promises`. */
export function nodeWalFileSystem(): WalFileSystem {
  return {
    async ensureDirectory(directoryPath: string): Promise<void> {
      await mkdir(directoryPath, { recursive: true });
    },

    async listFileNames(directoryPath: string): Promise<readonly string[]> {
      try {
        const entries = await readdir(directoryPath, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },

    async listDirectoryNames(directoryPath: string): Promise<readonly string[]> {
      // A symbolic link is not followed: the WAL root's epoch directories are
      // real directories, exactly as the research worker's inventory reads them
      // (`apps/research-worker/src/research-tier/inventory.ts`).
      try {
        const entries = await readdir(directoryPath, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },

    async fileByteLength(path: string): Promise<number | null> {
      try {
        const stats = await stat(path);
        return stats.size;
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async openAppend(path: string): Promise<WalAppendHandle> {
      const handle = await open(path, "a");
      return new NodeAppendHandle(handle, path);
    },

    async openRead(path: string): Promise<WalReadHandle> {
      const handle = await open(path, "r");
      return new NodeReadHandle(handle);
    },

    async readWholeFile(path: string): Promise<Uint8Array> {
      return readFile(path);
    },

    async writeWholeFile(path: string, bytes: Uint8Array): Promise<void> {
      const temporaryPath = `${path}.tmp`;
      const handle = await open(temporaryPath, "w");
      try {
        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
          if (bytesWritten <= 0) {
            throw new Error(`write to ${temporaryPath} made no progress`);
          }
          offset += bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, path);
    },

    async truncate(path: string, byteLength: number): Promise<void> {
      await truncate(path, byteLength);
    },

    joinPath(...segments: readonly string[]): string {
      return join(...segments);
    },
  };
}
