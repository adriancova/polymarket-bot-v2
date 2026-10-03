/**
 * A WAL filesystem that OBSERVES concurrency and can hold an operation open.
 *
 * Round-1 review finding H1: the journal awaited its drain chain and then
 * called the writer OUTSIDE it, so a frame arriving during an fsync or a
 * time-rotation started a second, concurrent writer operation. The WP-050
 * writer guards `drain()` against `drain()` and nothing else, so two
 * overlapping operations corrupt the accepted-frame invariant — a frame ends
 * up BOTH manifested and in `pendingFrames()`.
 *
 * Concurrency is invisible in a passing test unless something counts it. This
 * wrapper counts it at the only place it can be observed without trusting the
 * code under test: the filesystem port. Every asynchronous filesystem call
 * increments a live counter on entry and decrements it on exit, and the
 * high-water mark is retained. The WP-050 writer never issues two filesystem
 * calls in parallel within one operation (no `Promise.all` anywhere in
 * `packages/storage-wal/src/**`), so
 * `observations.maxConcurrentOperations > 1` means two WRITER operations were
 * in flight at once — which is the defect, not a property of the writer.
 *
 * `holdSyncs()` makes every subsequent `fsync` wait, which is what turns "the
 * race is possible" into "the race happens, deterministically, in this test".
 *
 * Dev-only, like everything under `./testing`. Nothing here is exported from
 * the package barrel.
 */

import type { MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";

export interface FileSystemObservations {
  /** Filesystem calls in flight right now. */
  readonly concurrentOperations: number;
  /** The high-water mark. Anything above 1 is two writer operations at once. */
  readonly maxConcurrentOperations: number;
  readonly appends: number;
  readonly syncs: number;
  readonly wholeFileWrites: number;
}

export interface ObservingWalFileSystem extends MemoryFileSystem {
  readonly observations: FileSystemObservations;
  /** Every subsequent `fsync` waits until {@link releaseSyncs} is called. */
  holdSyncs(): void;
  /** Releases held fsyncs and stops holding new ones. */
  releaseSyncs(): void;
}

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function openGate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return { promise, release };
}

export function createObservingWalFileSystem(): ObservingWalFileSystem {
  const inner = createMemoryFileSystem();
  let concurrent = 0;
  let maxConcurrent = 0;
  let appends = 0;
  let syncs = 0;
  let wholeFileWrites = 0;
  let gate: Gate | undefined;

  async function observe<T>(operation: () => Promise<T>): Promise<T> {
    concurrent += 1;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    try {
      return await operation();
    } finally {
      concurrent -= 1;
    }
  }

  const observations: FileSystemObservations = {
    get concurrentOperations() {
      return concurrent;
    },
    get maxConcurrentOperations() {
      return maxConcurrent;
    },
    get appends() {
      return appends;
    },
    get syncs() {
      return syncs;
    },
    get wholeFileWrites() {
      return wholeFileWrites;
    },
  };

  return {
    ...inner,
    files: inner.files,
    stats: inner.stats,
    observations,
    peek: (path) => inner.peek(path),
    poke: (path, bytes) => {
      inner.poke(path, bytes);
    },
    snapshot: () => inner.snapshot(),
    resetStats: () => {
      inner.resetStats();
    },
    joinPath: (...segments) => inner.joinPath(...segments),
    ensureDirectory: async (path) => observe(async () => inner.ensureDirectory(path)),
    listFileNames: async (path) => observe(async () => inner.listFileNames(path)),
    // `WALCAP-1`: a capped writer re-derives its count on every tick, on the
    // same operation chain; observed like every other call. Defined only when
    // the inner filesystem defines it, so a wrapper never turns "cannot list
    // directories" — which the writer refuses at open — into "lists none"
    // (round 1, O-I2).
    ...(inner.listDirectoryNames === undefined
      ? {}
      : {
          listDirectoryNames: async (path: string) =>
            observe(async () => (await inner.listDirectoryNames?.(path)) ?? []),
        }),
    fileByteLength: async (path) => observe(async () => inner.fileByteLength(path)),
    readWholeFile: async (path) => observe(async () => inner.readWholeFile(path)),
    openRead: async (path) => observe(async () => inner.openRead(path)),
    truncate: async (path, byteLength) => observe(async () => inner.truncate(path, byteLength)),
    writeWholeFile: async (path, bytes) =>
      observe(async () => {
        wholeFileWrites += 1;
        await inner.writeWholeFile(path, bytes);
      }),
    openAppend: async (path) => {
      const handle = await observe(async () => inner.openAppend(path));
      return {
        append: async (bytes) =>
          observe(async () => {
            appends += 1;
            await handle.append(bytes);
          }),
        sync: async () =>
          observe(async () => {
            syncs += 1;
            if (gate !== undefined) await gate.promise;
            await handle.sync();
          }),
        close: async () => observe(async () => handle.close()),
      };
    },
    holdSyncs: () => {
      gate ??= openGate();
    },
    releaseSyncs: () => {
      gate?.release();
      gate = undefined;
    },
  };
}
