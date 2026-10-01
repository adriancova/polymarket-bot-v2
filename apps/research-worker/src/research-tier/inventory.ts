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
 * them, and its sidecar is only parsed here to learn its epoch and ordinal.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CompactionFileSystem } from "@polymarket-bot/storage-parquet";
import {
  listManifestedSegmentIds,
  parseWalSegmentManifest,
  walManifestFileName,
} from "@polymarket-bot/storage-parquet";

/** One sealed segment, as its sidecar manifest describes it. */
export type InventoriedSegment = {
  readonly walDirectoryPath: string;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly byteSize: number;
  readonly closedAt: string;
};

/** A sealed segment whose sidecar could not even be parsed. It never expires. */
export type UnreadableSegment = {
  readonly walDirectoryPath: string;
  readonly segmentId: string;
  readonly reason: string;
};

export type WalInventory = {
  /** Every readable sealed segment, grouped by epoch, each epoch in segment order. */
  readonly byEpoch: ReadonlyMap<string, readonly InventoriedSegment[]>;
  readonly unreadable: readonly UnreadableSegment[];
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
  for (const directory of directories) {
    for (const segmentId of await listManifestedSegmentIds(fileSystem, directory)) {
      try {
        const bytes = await fileSystem.readWholeFile(fileSystem.joinPath(directory, walManifestFileName(segmentId)));
        const manifest = parseWalSegmentManifest(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
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
          closedAt: manifest.closedAt,
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
  return { byEpoch, unreadable };
}
