/**
 * Reads back what the gateway recorded, from the in-memory WAL filesystem.
 *
 * Deliberately parses the on-disk bytes rather than asking the writer: the
 * acceptance criteria are about what a compactor and a replay would find, and
 * `wal-format.md` §3 is the contract those readers hold.
 */

import type { MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";

export interface RecordedFrame {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly source: string;
  readonly endpoint: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly payloadUtf8: string;
  readonly payloadSha256: string;
}

/** Every WAL directory the gateway created, one per gateway epoch. */
export function walEpochDirectories(fileSystem: MemoryFileSystem): readonly string[] {
  const epochs = new Set<string>();
  for (const path of Object.keys(fileSystem.snapshot())) {
    const match = /^\/wal\/([^/]+)\//u.exec(path);
    if (match?.[1] !== undefined) epochs.add(match[1]);
  }
  return [...epochs];
}

/** Frame records in one epoch's segments, in `ingestSeq` order. */
export function recordedFrames(
  fileSystem: MemoryFileSystem,
  gatewayEpoch: string,
): readonly RecordedFrame[] {
  const frames: RecordedFrame[] = [];
  const snapshot = fileSystem.snapshot();
  const segmentPaths = Object.keys(snapshot)
    .filter((path) => path.startsWith(`/wal/${gatewayEpoch}/`) && path.endsWith(".wal.jsonl"))
    .sort();
  for (const path of segmentPaths) {
    const contents = snapshot[path];
    if (contents === undefined) continue;
    for (const line of contents.split("\n")) {
      if (line === "") continue;
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      // Header and footer lines carry a `record` key; a frame never does.
      if ("record" in parsed) continue;
      frames.push(parsed as RecordedFrame);
    }
  }
  return frames.sort((a, b) => (BigInt(a.ingestSeq) < BigInt(b.ingestSeq) ? -1 : 1));
}

/** Segment manifests written in one epoch's directory. */
export function segmentManifests(
  fileSystem: MemoryFileSystem,
  gatewayEpoch: string,
): readonly unknown[] {
  const snapshot = fileSystem.snapshot();
  return Object.entries(snapshot)
    .filter(
      ([path]) =>
        path.startsWith(`/wal/${gatewayEpoch}/`) && path.endsWith(".wal.manifest.json"),
    )
    .map(([, contents]) => JSON.parse(contents) as unknown);
}
