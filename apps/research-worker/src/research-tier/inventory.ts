/**
 * What sealed WAL segments exist under a WAL root.
 *
 * The gateway writes one directory per gateway epoch under its WAL root
 * (`<root>/<gatewayEpoch>/<segmentId>.wal.jsonl`); a directory written by the
 * `WP-050` writer directly is also accepted. A segment is **sealed** when its
 * sidecar manifest exists (`wal-format.md` §2: "A segment with no manifest is
 * unverified, and a compactor must not consume it"); the active segment has
 * none and is invisible here.
 *
 * Everything here only reads. The inventory is a listing, not a verification:
 * a segment's bytes are verified by `segment-verify.ts` before anything reads
 * them, and its sidecar is only parsed here (strict JSON, ADR-017 §3) to learn
 * its epoch, ordinal, ingest range and close reason. Those sidecar facts are
 * used only where they can HOLD a segment or a window (`wal-index.ts`), never
 * to let one expire: an expiry decision reads the verified research manifest.
 *
 * A sidecar whose segment file is gone is an **orphan**: an expired-after-
 * extract deletion removes the segment, then its sidecar, so a crash between
 * the two leaves one. It is reported, and never planned again (nothing is
 * left to delete, and planning it would fail every later cycle).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CompactionFileSystem } from "@polymarket-bot/storage-parquet";
import {
  listManifestedSegmentIds,
  parseStrictJsonBytes,
  parseWalSegmentManifest,
  walManifestFileName,
  walSegmentFileName,
} from "@polymarket-bot/storage-parquet";

/** One sealed segment, as its sidecar manifest describes it. */
export type InventoriedSegment = {
  readonly walDirectoryPath: string;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly closedAt: string;
  /** Why the writer sealed it (`shutdown` and `recovery` end an epoch). */
  readonly closeReason: string;
  /** First and last `ingestSeq` in dispatch order, as the sidecar states them (unverified). */
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  /** First and last frame's receipt instant, as the sidecar states them (unverified). */
  readonly firstReceivedAt: string | null;
  readonly lastReceivedAt: string | null;
};

/** A sealed segment whose sidecar could not even be parsed. It never expires. */
export type UnreadableSegment = {
  readonly walDirectoryPath: string;
  readonly segmentId: string;
  readonly reason: string;
};

/** A sidecar whose segment file is gone: a deletion interrupted between its two unlinks. */
export type OrphanSidecar = {
  readonly walDirectoryPath: string;
  readonly segmentId: string;
};

export type WalInventory = {
  /** Every readable sealed segment, grouped by epoch, each epoch in segment order. */
  readonly byEpoch: ReadonlyMap<string, readonly InventoriedSegment[]>;
  readonly unreadable: readonly UnreadableSegment[];
  /** Sidecars with no segment file. Never planned; reported. */
  readonly orphans?: readonly OrphanSidecar[];
};

/** The identifier grammar an id must meet to name an object key. */
export const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

async function subdirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** List every sealed segment under a WAL root (the root and its immediate subdirectories). */
export async function inventoryWalRoot(
  fileSystem: CompactionFileSystem,
  walRootPath: string,
): Promise<WalInventory> {
  const directories = [walRootPath, ...(await subdirectories(walRootPath))];
  const segments: InventoriedSegment[] = [];
  const unreadable: UnreadableSegment[] = [];
  const orphans: OrphanSidecar[] = [];
  for (const directory of directories) {
    for (const segmentId of await listManifestedSegmentIds(fileSystem, directory)) {
      if ((await fileSystem.fileByteLength(fileSystem.joinPath(directory, walSegmentFileName(segmentId)))) === null) {
        orphans.push({ walDirectoryPath: directory, segmentId });
        continue;
      }
      try {
        const bytes = await fileSystem.readWholeFile(fileSystem.joinPath(directory, walManifestFileName(segmentId)));
        const manifest = parseWalSegmentManifest(parseStrictJsonBytes(bytes));
        if (manifest.segmentId !== segmentId) throw new Error("the manifest names a different segment");
        // Both name object keys (`research/<epoch>/segments/<segmentId>.json`).
        if (!SAFE_IDENTIFIER.test(manifest.gatewayEpoch) || !SAFE_IDENTIFIER.test(segmentId)) {
          throw new Error("the segment id or gateway epoch is not a safe object-key identifier");
        }
        segments.push({
          walDirectoryPath: directory,
          segmentId,
          gatewayEpoch: manifest.gatewayEpoch,
          segmentIndex: manifest.segmentIndex,
          byteSize: manifest.byteSize,
          createdAt: manifest.createdAt,
          closedAt: manifest.closedAt,
          closeReason: manifest.closeReason,
          firstIngestSeq: manifest.firstIngestSeq,
          lastIngestSeq: manifest.lastIngestSeq,
          firstReceivedAt: manifest.firstReceivedAt,
          lastReceivedAt: manifest.lastReceivedAt,
        });
      } catch (error) {
        unreadable.push({
          walDirectoryPath: directory,
          segmentId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const byEpoch = new Map<string, InventoriedSegment[]>();
  for (const segment of segments) {
    const list = byEpoch.get(segment.gatewayEpoch) ?? [];
    list.push(segment);
    byEpoch.set(segment.gatewayEpoch, list);
  }
  for (const list of byEpoch.values()) {
    list.sort((left, right) =>
      left.segmentIndex !== right.segmentIndex
        ? left.segmentIndex - right.segmentIndex
        : left.segmentId < right.segmentId
          ? -1
          : left.segmentId > right.segmentId
            ? 1
            : 0,
    );
  }
  return { byEpoch, unreadable, orphans };
}
