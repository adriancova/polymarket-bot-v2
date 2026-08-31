/**
 * Test doubles for the compaction ports.
 *
 * Exported as a separate entry point (`@polymarket-bot/storage-parquet/testing`)
 * so a consumer's production build never reaches them, following the
 * `WP-040`/`WP-060` house pattern.
 *
 * The doubles here are deliberately *honest* rather than permissive: the
 * in-memory object store enforces the same immutability rule as the filesystem
 * one, so a test that passes against it is testing the real precondition.
 */

export {
  buildSegmentFixture,
  encodeManifest,
  frameRecord,
  type FrameInput,
  type SegmentFixture,
  type SegmentFixtureOptions,
} from "./wal-fixture.js";

import { CompactionError, ObjectImmutabilityError } from "../errors.js";
import type {
  CompactionClock,
  CompactionFileSystem,
  ObjectHead,
  ObjectStore,
  SegmentDeletionRequest,
  WalSegmentRetention,
} from "../ports.js";
import { sha256Hex } from "../wal-format.js";

/** A clock that advances only when a test says so. */
export type ManualClock = CompactionClock & {
  /** Set the wall clock. */
  setNowMs(value: number): void;
  /** Advance both clocks by `deltaMs`. */
  advance(deltaMs: number): void;
};

/** A deterministic clock for tests (§12.4: no ambient time in a fixture). */
export function manualClock(startMs = Date.parse("2026-01-01T00:00:00.000Z")): ManualClock {
  let nowMs = startMs;
  let monotonicMs = 0;
  return {
    nowMs: () => nowMs,
    monotonicMs: () => monotonicMs,
    setNowMs(value: number): void {
      nowMs = value;
    },
    advance(deltaMs: number): void {
      nowMs += deltaMs;
      monotonicMs += deltaMs;
    },
  };
}

/** An in-memory object store with the same immutability rule as the real one. */
export type MemoryObjectStore = ObjectStore & {
  /** Every key currently stored, sorted. */
  keys(): readonly string[];
  /** Replace an object's bytes without going through `put`, to simulate rot. */
  corrupt(key: string, bytes: Uint8Array): void;
  /** Remove an object without going through any policy. */
  forget(key: string): void;
};

export function memoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const existing = objects.get(key);
      if (existing !== undefined) {
        if (sha256Hex(existing) === sha256Hex(bytes)) {
          return;
        }
        throw new ObjectImmutabilityError(
          "object key already holds different bytes; datasets are immutable",
          { key },
        );
      }
      objects.set(key, Uint8Array.from(bytes));
    },
    async head(key: string): Promise<ObjectHead | null> {
      const stored = objects.get(key);
      return stored === undefined ? null : { byteLength: stored.byteLength };
    },
    async get(key: string): Promise<Uint8Array> {
      const stored = objects.get(key);
      if (stored === undefined) {
        throw new CompactionError("OBJECT_VERIFICATION", "object not found", { key });
      }
      return Uint8Array.from(stored);
    },
    keys(): readonly string[] {
      return [...objects.keys()].sort();
    },
    corrupt(key: string, bytes: Uint8Array): void {
      objects.set(key, Uint8Array.from(bytes));
    },
    forget(key: string): void {
      objects.delete(key);
    },
  };
}

/** An in-memory filesystem holding whole files under absolute-ish paths. */
export type MemoryFileSystem = CompactionFileSystem & {
  /** Put a file at `<directory>/<name>`. */
  write(directoryPath: string, fileName: string, bytes: Uint8Array | string): void;
  /** Remove a file. */
  remove(directoryPath: string, fileName: string): void;
  /** Every file name in a directory. */
  list(directoryPath: string): readonly string[];
};

export function memoryFileSystem(): MemoryFileSystem {
  const files = new Map<string, Uint8Array>();
  const join = (...segments: readonly string[]): string =>
    segments.join("/").replace(/\/+/gu, "/");

  return {
    async listFileNames(directoryPath: string): Promise<readonly string[]> {
      const prefix = `${directoryPath.replace(/\/+$/u, "")}/`;
      const names: string[] = [];
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          if (!rest.includes("/")) {
            names.push(rest);
          }
        }
      }
      return names.sort();
    },
    async fileByteLength(path: string): Promise<number | null> {
      const stored = files.get(path);
      return stored === undefined ? null : stored.byteLength;
    },
    async readWholeFile(path: string): Promise<Uint8Array> {
      const stored = files.get(path);
      if (stored === undefined) {
        throw new CompactionError("CONFIGURATION", "file not found", { path });
      }
      return Uint8Array.from(stored);
    },
    joinPath: join,
    write(directoryPath: string, fileName: string, bytes: Uint8Array | string): void {
      files.set(
        join(directoryPath, fileName),
        typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Uint8Array.from(bytes),
      );
    },
    remove(directoryPath: string, fileName: string): void {
      files.delete(join(directoryPath, fileName));
    },
    list(directoryPath: string): readonly string[] {
      const prefix = `${directoryPath.replace(/\/+$/u, "")}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
        .sort();
    },
  };
}

/** A retention policy that records what it was asked to delete. */
export type RecordingRetention = WalSegmentRetention & {
  readonly requests: readonly SegmentDeletionRequest[];
};

/**
 * Retention that deletes from a {@link MemoryFileSystem} after re-checking the
 * object store, mirroring the real implementation's guard.
 */
export function recordingRetention(options: {
  readonly fileSystem: MemoryFileSystem;
  readonly walDirectoryPath: string;
  readonly objectStore: ObjectStore;
}): RecordingRetention {
  const requests: SegmentDeletionRequest[] = [];
  return {
    policyName: "delete-after-verified-upload",
    requests,
    async deleteSegment(request: SegmentDeletionRequest): Promise<void> {
      const stored = await options.objectStore.get(request.verifiedObjectKey);
      if (sha256Hex(stored) !== request.verifiedObjectSha256) {
        throw new CompactionError(
          "RETENTION_GUARD",
          "refusing to delete a WAL segment: the stored object's digest changed",
          { segmentId: request.segmentId },
        );
      }
      requests.push(request);
      options.fileSystem.remove(options.walDirectoryPath, `${request.segmentId}.wal.jsonl`);
      options.fileSystem.remove(
        options.walDirectoryPath,
        `${request.segmentId}.wal.manifest.json`,
      );
    },
  };
}
