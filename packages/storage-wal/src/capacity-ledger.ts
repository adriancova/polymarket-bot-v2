/**
 * The capacity ledger: the bytes `maxTotalBytes` counts, one entry per segment
 * file (`WALCAP-1`, finding J10 of `STORAGE-1`).
 *
 * ## Why a ledger and not a running sum
 *
 * Before `WALCAP-1` the writer's count was recovery's tally of its own
 * directory plus every byte it wrote, and it was never lowered. Raw-WAL expiry
 * (ADR-028 Decision 2) deletes sealed segments from another process, so a
 * gateway that reached its cap stayed refused after expiry freed the space.
 * The gateway also opens a new directory per epoch, so a restart started the
 * count again from zero while the previous epochs' segments were still on
 * disk.
 *
 * A ledger fixes both, and it can say exactly what may lower it.
 *
 * - **Scope.** Every segment file (`*.wal.jsonl`) in the writer's own
 *   directory, in the capacity root when one is named, and in the root's
 *   immediate subdirectories. That is the layout the gateway writes
 *   (`<root>/<gatewayEpoch>/`), and the one the research worker inventories.
 * - **What raises an entry.** This writer's own writes (exact, because the
 *   writer is the only appender to its own segments), or a `fileByteLength`
 *   that reads more than the entry holds.
 * - **What lowers the count.** Two things, and nothing else. A direct
 *   `fileByteLength` of a path that answers "absent" removes its entry; that
 *   is raw-WAL expiry. And the writer's own truncation of a torn tail, on its
 *   fault path, records the truncated file at its new, exact size
 *   (`writer.ts`, `#finalizeFaultedSegment`; `WALCAP-1` r2, finding N-4). A
 *   directory listing never removes anything: a path the ledger knows and a
 *   listing omits is read directly, and kept if it is still there. So a stale
 *   or partial listing can only keep bytes, never drop them.
 * - **Sealed files are exact.** A segment whose sidecar manifest exists can no
 *   longer grow (`wal-format.md` §6; the manifest is written last). Its size is
 *   read once with the manifest present and then trusted until the file is
 *   gone, which keeps a re-derivation to one listing per directory.
 * - **The open segment is never forgotten.** Its descriptor is held, so its
 *   bytes stay on disk until it is closed even if its name is removed.
 *
 * ## Never undercount, and what that means exactly
 *
 * Every entry is at least the size of its file: a sealed one equals it, an
 * unsealed one is the largest size anyone has seen or written. An entry leaves
 * only when its file is gone. What the ledger cannot see is a segment file
 * another process creates under the root after a re-derivation; one writer per
 * WAL root is a premise (ADR-025 Decision 10, `wal-format.md` §2), and the
 * next re-derivation counts it anyway.
 *
 * The writer's own writes reach the ledger when they return, so the precise
 * statement has two halves (`WALCAP-1` r1, findings A-01 and O-L1):
 *
 * - **The ledger alone is never below the disk while none of the writer's
 *   writes is in flight.** During one — a header, an append, a footer — its
 *   bytes can be on disk a moment before the ledger counts them. A write that
 *   fails is counted before the writer faults: the writer reads the file's
 *   length, or counts the most the write can have left when that read fails
 *   too (`writer.ts`, `#countAfterFailedWrite`).
 * - **What admission compares with `maxTotalBytes` is never below the disk,
 *   at any instant.** It is the ledger, plus every accepted frame not yet in
 *   the ledger — the ones a drain took and is writing, and the queued ones —
 *   plus the framing reserved for them and for the open segment's footer. A
 *   write in flight is always one of those, so its bytes are charged before
 *   they land and released only when the ledger holds them.
 *
 * ## What it never does
 *
 * It deletes nothing and writes nothing: it reads directory listings and file
 * lengths. Reaching the cap still refuses new frames and never deletes or
 * overwrites (ADR-028 Decision 5.3), and nothing here can make expiry run
 * (Decision 5.4).
 */

import { isSegmentFileName, manifestFileName, segmentIdFromFileName } from "./manifest.js";
import type { WalFileSystem } from "./ports.js";

type LedgerEntry = {
  readonly directory: string;
  bytes: number;
  /** The size was taken with the sidecar manifest present: the file can no longer change. */
  sealed: boolean;
};

/** What one re-derivation did. */
export type CapacityRescanOutcome = {
  readonly previousBytes: number;
  readonly countedBytes: number;
  /** Counted bytes of segment files found gone: the room expiry gave back. */
  readonly relievedBytes: number;
  readonly segmentsForgotten: number;
};

/** Which directories a re-derivation reads. */
export type CapacityScope = {
  /** The writer's own directory. Always read, whatever the root is. */
  readonly ownDirectory: string;
  /** The WAL root `maxTotalBytes` covers, or `null` for the own directory alone. */
  readonly rootPath: string | null;
  /** True for a path whose bytes must stay counted while it exists or not: the open segment. */
  readonly retain: (path: string) => boolean;
};

export class SegmentByteLedger {
  readonly #entries = new Map<string, LedgerEntry>();
  #totalBytes = 0;

  /** The bytes `maxTotalBytes` is compared against. */
  get totalBytes(): number {
    return this.#totalBytes;
  }

  /** Segment files the ledger counts. */
  get segmentCount(): number {
    return this.#entries.size;
  }

  /**
   * This writer's own segment, at the size it knows it wrote.
   *
   * The writer is the only appender to its own segments, so its size is
   * authoritative: it overwrites whatever a re-derivation read.
   */
  recordOwn(path: string, directory: string, bytes: number, sealed: boolean): void {
    this.#put(path, { directory, bytes, sealed });
  }

  /** The directories the ledger holds entries in. */
  directories(): readonly string[] {
    const directories = new Set<string>();
    for (const entry of this.#entries.values()) {
      directories.add(entry.directory);
    }
    return [...directories];
  }

  /** Paths the ledger counts in one directory. */
  pathsIn(directory: string): readonly string[] {
    const paths: string[] = [];
    for (const [path, entry] of this.#entries) {
      if (entry.directory === directory) {
        paths.push(path);
      }
    }
    return paths;
  }

  /** Whether the entry for `path` is sealed (its size is exact and final). */
  isSealed(path: string): boolean {
    return this.#entries.get(path)?.sealed === true;
  }

  /** Whether the ledger counts `path`. */
  has(path: string): boolean {
    return this.#entries.has(path);
  }

  /**
   * A length read from disk for an existing file.
   *
   * Sealed: the read is exact and final, so it replaces the entry. Unsealed:
   * the entry becomes the larger of the two, because the file may still be
   * growing under this writer's own appends.
   */
  observe(path: string, directory: string, bytes: number, sealed: boolean): void {
    const entry = this.#entries.get(path);
    if (entry !== undefined && entry.sealed) {
      return;
    }
    if (sealed) {
      this.#put(path, { directory, bytes, sealed: true });
      return;
    }
    this.#put(path, { directory, bytes: Math.max(bytes, entry?.bytes ?? 0), sealed: false });
  }

  /**
   * Remove a path a direct read found gone. Returns the bytes it counted.
   *
   * The only way the count goes down.
   */
  forget(path: string): number {
    const entry = this.#entries.get(path);
    if (entry === undefined) {
      return 0;
    }
    this.#entries.delete(path);
    this.#totalBytes -= entry.bytes;
    return entry.bytes;
  }

  #put(path: string, entry: LedgerEntry): void {
    const previous = this.#entries.get(path);
    this.#entries.set(path, entry);
    this.#totalBytes += entry.bytes - (previous?.bytes ?? 0);
  }
}

/**
 * Re-derive the ledger from the disk.
 *
 * Reads, in order: the root's subdirectories, then for each directory in scope
 * its listing, a length for every segment it lists that is new or unsealed,
 * and a length for every path the ledger knows there that the listing omits.
 * Each change it makes is justified by the read just before it, so a failure
 * part-way leaves a ledger that is still never below the disk; the error is
 * re-thrown for the caller to count.
 *
 * Calls run one at a time, never in parallel (the gateway's observing
 * filesystem counts that, `apps/data-gateway/src/testing`).
 */
export async function rescanSegmentBytes(
  fileSystem: WalFileSystem,
  ledger: SegmentByteLedger,
  scope: CapacityScope,
): Promise<CapacityRescanOutcome> {
  const previousBytes = ledger.totalBytes;
  const directories = new Set<string>([scope.ownDirectory]);
  if (scope.rootPath !== null) {
    const listDirectoryNames = fileSystem.listDirectoryNames;
    if (listDirectoryNames === undefined) {
      throw new Error("the WAL filesystem cannot list directories, so a capacity root cannot be read");
    }
    directories.add(scope.rootPath);
    for (const name of await listDirectoryNames.call(fileSystem, scope.rootPath)) {
      directories.add(fileSystem.joinPath(scope.rootPath, name));
    }
  }
  // A directory that held counted segments and is gone from the root's listing
  // is read too: its listing is empty, and each of its paths is read directly.
  for (const directory of ledger.directories()) {
    directories.add(directory);
  }

  let relievedBytes = 0;
  let segmentsForgotten = 0;
  const forget = (path: string): void => {
    if (!ledger.has(path)) {
      return;
    }
    segmentsForgotten += 1;
    relievedBytes += ledger.forget(path);
  };
  for (const directory of [...directories].sort()) {
    const names = await fileSystem.listFileNames(directory);
    const listed = new Set(names);
    const listedPaths = new Set<string>();
    for (const name of [...names].sort()) {
      if (!isSegmentFileName(name)) {
        continue;
      }
      const path = fileSystem.joinPath(directory, name);
      listedPaths.add(path);
      if (ledger.isSealed(path)) {
        continue;
      }
      const segmentId = segmentIdFromFileName(name);
      const sealed = segmentId !== null && listed.has(manifestFileName(segmentId));
      const bytes = await fileSystem.fileByteLength(path);
      if (bytes === null) {
        // Listed, then gone before its length was read.
        if (!scope.retain(path)) {
          forget(path);
        }
        continue;
      }
      ledger.observe(path, directory, bytes, sealed);
    }
    for (const path of ledger.pathsIn(directory)) {
      if (listedPaths.has(path) || scope.retain(path)) {
        continue;
      }
      // Known, and not in this listing: read it directly. A stale or partial
      // listing keeps it; only the file being gone lets it go.
      const bytes = await fileSystem.fileByteLength(path);
      if (bytes === null) {
        forget(path);
        continue;
      }
      ledger.observe(path, directory, bytes, false);
    }
  }
  return { previousBytes, countedBytes: ledger.totalBytes, relievedBytes, segmentsForgotten };
}
