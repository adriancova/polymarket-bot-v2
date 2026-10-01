/**
 * Verifying one sealed WAL segment before the research tier reads it
 * (ADR-028 Decision 2.6).
 *
 * > "Before it reads a sealed segment, the extractor runs `validateSegment`
 * > on it (`packages/storage-wal/src/reader.ts`). That re-verifies the
 * > WAL-chain identity (`segmentSha256`) against the segment's footer and
 * > sidecar manifest. A segment that fails is not extracted, so it never
 * > expires. The extractor then computes `segmentFileSha256` over the same
 * > verified bytes."
 *
 * "The same verified bytes" is made literal: the segment file and its sidecar
 * manifest are read **once**, into memory, and every check below runs over
 * that one read through a read-only in-memory filesystem:
 *
 * 1. `validateSegment` — the `WP-050` reader, the WAL's own implementation;
 * 2. `readWalSegment` — the compactor's independent reader of the published
 *    format (`packages/storage-parquet`), which yields the records with their
 *    exact byte ranges; the two must agree on the digest and the count;
 * 3. `segmentFileSha256` — SHA-256 over the whole of that one read.
 *
 * A change to the file after this read cannot reach the research tier: what
 * is extracted is what was verified. A change before deletion is caught by
 * the deletion-time check (`expiry-proof.ts`), which requires the file to hash
 * to both digests this module pinned.
 */

import type { WalFileSystem, WalReadHandle } from "@polymarket-bot/storage-wal";
import { validateSegment } from "@polymarket-bot/storage-wal";
import type { CompactionFileSystem, WalRecordEntry, WalSegmentManifest } from "@polymarket-bot/storage-parquet";
import {
  compareUnsignedIntegerStrings,
  readWalSegment,
  sha256Hex,
  walManifestFileName,
  walSegmentFileName,
} from "@polymarket-bot/storage-parquet";

import { epochMsOf } from "./sampler.js";

/** A segment that passed both readers, with what the research tier needs. */
export type VerifiedSegment = {
  readonly status: "verified";
  readonly segmentId: string;
  readonly walDirectoryPath: string;
  readonly manifest: WalSegmentManifest;
  readonly segmentSha256: string;
  /** SHA-256 over the whole file, from the one verified read. */
  readonly segmentFileSha256: string;
  readonly byteSize: number;
  readonly records: readonly WalRecordEntry[];
  /** Smallest receipt instant over every frame, as recorded. */
  readonly minReceivedAt: string | null;
  /**
   * Newest receipt instant over **every** frame — the maximum, not the last
   * frame's stamp (ADR-028 Decision 2.1: stamps can repeat or step back).
   */
  readonly maxReceivedAt: string | null;
  /** Smallest and largest `ingestSeq` over every frame. */
  readonly minIngestSeq: string | null;
  readonly maxIngestSeq: string | null;
};

/** A segment that is not extracted, and why. It never expires. */
export type RefusedSegment = {
  readonly status: "refused";
  readonly segmentId: string;
  readonly walDirectoryPath: string;
  readonly reasons: readonly string[];
};

function snapshotFileSystem(files: ReadonlyMap<string, Uint8Array>, join: (...parts: readonly string[]) => string): WalFileSystem {
  const refuseWrite = (): never => {
    throw new Error("the verification snapshot is read-only");
  };
  return {
    ensureDirectory: () => Promise.reject(new Error("the verification snapshot is read-only")),
    async listFileNames(): Promise<readonly string[]> {
      return [...files.keys()].map((path) => path.slice(path.lastIndexOf("/") + 1)).sort();
    },
    async fileByteLength(path: string): Promise<number | null> {
      return files.get(path)?.byteLength ?? null;
    },
    openAppend: () => Promise.reject(new Error("the verification snapshot is read-only")),
    async openRead(path: string): Promise<WalReadHandle> {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`no such file in the verification snapshot: ${path}`);
      return {
        async read(offset: number, length: number): Promise<Uint8Array> {
          return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
        },
        async close(): Promise<void> {},
      };
    },
    async readWholeFile(path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`no such file in the verification snapshot: ${path}`);
      return bytes;
    },
    writeWholeFile: refuseWrite,
    truncate: refuseWrite,
    joinPath: join,
  };
}

/**
 * Read one sealed segment once and verify it with both readers. Returns
 * `refused` (never throws) for a segment that is missing, unmanifested,
 * corrupt, or that the two readers disagree about.
 */
export async function verifySegmentForExtraction(input: {
  readonly fileSystem: CompactionFileSystem;
  readonly walDirectoryPath: string;
  readonly segmentId: string;
  readonly maxSegmentBytes?: number;
  /** The WAL's validator. A test may observe it; production uses `validateSegment`. */
  readonly validate?: typeof validateSegment;
}): Promise<VerifiedSegment | RefusedSegment> {
  const { fileSystem, walDirectoryPath, segmentId } = input;
  const refuse = (...reasons: string[]): RefusedSegment => ({
    status: "refused",
    segmentId,
    walDirectoryPath,
    reasons,
  });
  const segmentPath = fileSystem.joinPath(walDirectoryPath, walSegmentFileName(segmentId));
  const manifestPath = fileSystem.joinPath(walDirectoryPath, walManifestFileName(segmentId));

  const segmentLength = await fileSystem.fileByteLength(segmentPath);
  const manifestLength = await fileSystem.fileByteLength(manifestPath);
  if (manifestLength === null) return refuse("MANIFEST_MISSING: the segment is not sealed");
  if (segmentLength === null) return refuse("SEGMENT_MISSING: a manifest exists but the segment file does not");
  if (input.maxSegmentBytes !== undefined && segmentLength > input.maxSegmentBytes) {
    return refuse(`SEGMENT_TOO_LARGE: ${String(segmentLength)} bytes`);
  }

  // The one read every check below uses.
  const segmentBytes = await fileSystem.readWholeFile(segmentPath);
  const manifestBytes = await fileSystem.readWholeFile(manifestPath);

  const snapshot = new Map<string, Uint8Array>([
    [segmentPath, segmentBytes],
    [manifestPath, manifestBytes],
  ]);
  const walFs = snapshotFileSystem(snapshot, (...parts) => fileSystem.joinPath(...parts));

  // -- 1. The WAL's own validator. --------------------------------------------
  const report = await (input.validate ?? validateSegment)(walFs, walDirectoryPath, segmentId);
  if (!report.valid || report.manifest === null) {
    return refuse(
      ...(report.issues.length > 0
        ? report.issues.map((issue) => `${issue.code}: ${issue.message}`)
        : ["validateSegment did not accept the segment"]),
    );
  }

  // -- 2. The compactor's independent reader, over the same bytes. -----------
  const parsed = await readWalSegment(
    {
      segmentByteLength: async () => segmentBytes.byteLength,
      readSegment: async () => segmentBytes,
      readManifest: async () => manifestBytes,
    },
    segmentId,
  );
  if (parsed.status !== "verified") {
    return refuse(...parsed.issues.map((issue) => `${issue.code}: ${issue.message}`));
  }
  if (
    parsed.manifest.segmentSha256 !== report.manifest.segmentSha256 ||
    parsed.computedSegmentSha256 !== report.scan.computedSha256 ||
    parsed.records.length !== report.scan.recordCount
  ) {
    return refuse("READERS_DISAGREE: the WAL validator and the compactor's reader disagree about this segment");
  }

  // -- 3. The whole-file digest, from the same verified bytes. ---------------
  const segmentFileSha256 = sha256Hex(segmentBytes);
  if (segmentFileSha256 !== parsed.computedFileSha256) {
    return refuse("FILE_DIGEST_DISAGREE: the whole-file digest is not stable over one read");
  }

  // ADR-028 Decision 2.1: the maximum over every verified frame, not the last.
  let minReceivedAt: string | null = null;
  let maxReceivedAt: string | null = null;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  let minIngestSeq: string | null = null;
  let maxIngestSeq: string | null = null;
  for (const entry of parsed.records) {
    const seq = entry.record.ingestSeq;
    if (minIngestSeq === null || compareUnsignedIntegerStrings(seq, minIngestSeq) < 0) minIngestSeq = seq;
    if (maxIngestSeq === null || compareUnsignedIntegerStrings(seq, maxIngestSeq) > 0) maxIngestSeq = seq;
    const atMs = epochMsOf(entry.record.receivedAt);
    if (atMs < minMs) {
      minMs = atMs;
      minReceivedAt = entry.record.receivedAt;
    }
    if (atMs > maxMs) {
      maxMs = atMs;
      maxReceivedAt = entry.record.receivedAt;
    }
  }

  return {
    status: "verified",
    segmentId,
    walDirectoryPath,
    manifest: parsed.manifest,
    segmentSha256: parsed.manifest.segmentSha256,
    segmentFileSha256,
    byteSize: segmentBytes.byteLength,
    records: parsed.records,
    minReceivedAt,
    maxReceivedAt,
    minIngestSeq,
    maxIngestSeq,
  };
}
