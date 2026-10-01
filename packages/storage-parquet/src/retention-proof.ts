/**
 * The proof a WAL deletion must present, verified against the durable store.
 *
 * ## A caller cannot be trusted
 *
 * Round-1 review of `WP-130` invoked `deleteAfterVerifiedUploadRetention`
 * directly with an arbitrary non-Parquet object, that object's own digest, and
 * a nonexistent dataset-manifest key — and it deleted both WAL files. The
 * implementation had compared the caller's digest against the caller's object,
 * which proves only that the caller can hash. ADR-004 §5's precondition —
 * "Parquet upload **and** checksum verification both succeed" — is a fact
 * about the durable store and the segment's own bytes, so that is where this
 * module reads it from:
 *
 * 1. The **persisted dataset manifest** named by the request must exist in the
 *    store, and its digest sidecar must match its bytes. The manifest is
 *    written and read-back-verified before any deletion is granted
 *    (`compactor.ts` step 7), so its presence is not a formality — it is the
 *    durable record that makes a deleted segment recoverable.
 * 2. The manifest must **pin this exact segment**: id, gateway epoch, segment
 *    checksum, checksummed byte length, byte size, record count, and the
 *    object key — and pin the object with the checksum the request claims.
 * 3. The **segment file about to be deleted** must hash to the pinned segment
 *    checksum over the checksummed span **and** to the pinned whole-file
 *    digest (`segmentFileSha256`) over its entire length, footer included. A
 *    file that changed since compaction is not the file the manifest
 *    describes, and deleting it would destroy unarchived bytes. The span
 *    digest alone cannot see the footer — the WAL's `segmentSha256`
 *    necessarily excludes the line that carries it (`wal-format.md` §7) — so
 *    round-2 review mutated `closeReason` in place without changing the file
 *    length and the guard deleted the file. The whole-file pin, computed at
 *    compaction time before any deletion eligibility, closes that gap; a
 *    manifest that does not pin it is refused rather than trusted.
 * 4. The **stored object** must hash to the manifest's pin and must actually
 *    provide the segment's rows: exactly `recordCount` rows for this segment,
 *    with dense record indices, each re-encoding to the exact byte range of
 *    the segment file it claims to preserve.
 *
 * Every failure is a {@link RetentionGuardError}; nothing is unlinked unless
 * all of it holds.
 */

import { DATASET_MANIFEST_DIGEST_OBJECT_NAME, DATASET_MANIFEST_OBJECT_NAME } from "./constants.js";
import { parseDatasetManifest } from "./dataset-manifest.js";
import type { DatasetManifest } from "./dataset-manifest.js";
import { RetentionGuardError } from "./errors.js";
import { readParquetObject } from "./parquet-object.js";
import type { ObjectStore, SegmentDeletionRequest } from "./ports.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import { encodeFrameLine, sha256Hex } from "./wal-format.js";

/** What {@link verifyRetentionProof} needs beyond the request itself. */
export type RetentionProofContext = {
  readonly objectStore: ObjectStore;
  /** Bytes of the WAL segment file the caller intends to delete. */
  readonly readSegmentFile: () => Promise<Uint8Array>;
};

function refuse(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new RetentionGuardError(`refusing to delete a WAL segment: ${message}`, details);
}

function digestSidecarKeyFor(manifestKey: string): string {
  const suffix = DATASET_MANIFEST_OBJECT_NAME;
  if (manifestKey === suffix) {
    return DATASET_MANIFEST_DIGEST_OBJECT_NAME;
  }
  if (!manifestKey.endsWith(`/${suffix}`)) {
    refuse("the dataset manifest key does not name a dataset manifest object", {
      datasetManifestKey: manifestKey,
    });
  }
  return `${manifestKey.slice(0, manifestKey.length - suffix.length)}${DATASET_MANIFEST_DIGEST_OBJECT_NAME}`;
}

async function fetchVerifiedManifest(
  objectStore: ObjectStore,
  request: SegmentDeletionRequest,
): Promise<DatasetManifest> {
  const manifestKey = request.datasetManifestKey;
  if ((await objectStore.head(manifestKey)) === null) {
    refuse("the dataset manifest that must pin it is not in the store", {
      segmentId: request.segmentId,
      datasetManifestKey: manifestKey,
    });
  }
  const manifestBytes = await objectStore.get(manifestKey);
  const manifestSha256 = sha256Hex(manifestBytes);

  const sidecarKey = digestSidecarKeyFor(manifestKey);
  if ((await objectStore.head(sidecarKey)) === null) {
    refuse("the dataset manifest's digest sidecar is not in the store", {
      segmentId: request.segmentId,
      digestObjectKey: sidecarKey,
    });
  }
  const sidecar = Buffer.from(await objectStore.get(sidecarKey)).toString("utf8").trim();
  if (sidecar !== manifestSha256) {
    refuse("the dataset manifest's bytes do not match its digest sidecar", {
      segmentId: request.segmentId,
      datasetManifestKey: manifestKey,
      sidecarDigest: sidecar,
      observedDigest: manifestSha256,
    });
  }

  try {
    // ADR-017 §3: the strict-JSON profile. This guard also re-reads every pin
    // manifest on the expired-after-extract path (`expiry-proof.ts`).
    return parseDatasetManifest(parseStrictJsonBytes(manifestBytes));
  } catch (error) {
    return refuse("the persisted dataset manifest could not be parsed", {
      segmentId: request.segmentId,
      datasetManifestKey: manifestKey,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Verify, from the durable store and the segment's own bytes, that deleting
 * the segment named by `request` is permitted. Throws {@link RetentionGuardError}
 * otherwise. The caller-supplied fields of the request are treated as claims
 * to check, never as proof.
 */
export async function verifyRetentionProof(
  context: RetentionProofContext,
  request: SegmentDeletionRequest,
): Promise<void> {
  const manifest = await fetchVerifiedManifest(context.objectStore, request);

  // -- 2. The manifest pins this exact segment and this exact object. -------
  const segments = Array.isArray(manifest.segments) ? manifest.segments : [];
  const segmentEntry = segments.find((entry) => entry.segmentId === request.segmentId);
  if (segmentEntry === undefined) {
    refuse("the persisted dataset manifest does not pin it", {
      segmentId: request.segmentId,
      datasetManifestKey: request.datasetManifestKey,
    });
  }
  const disagreements: string[] = [];
  if (segmentEntry.gatewayEpoch !== request.gatewayEpoch) disagreements.push("gatewayEpoch");
  if (segmentEntry.segmentSha256 !== request.segmentSha256) disagreements.push("segmentSha256");
  if (segmentEntry.recordCount !== request.recordCount) disagreements.push("recordCount");
  if (segmentEntry.objectKey !== request.verifiedObjectKey) disagreements.push("objectKey");
  if (disagreements.length > 0) {
    refuse("the request contradicts what the persisted manifest pins", {
      segmentId: request.segmentId,
      fields: disagreements,
    });
  }

  const objects = Array.isArray(manifest.objects) ? manifest.objects : [];
  const objectEntry = objects.find((entry) => entry.objectKey === request.verifiedObjectKey);
  if (objectEntry === undefined) {
    refuse("the persisted manifest does not pin the object named by the request", {
      segmentId: request.segmentId,
      objectKey: request.verifiedObjectKey,
    });
  }
  if (objectEntry.sha256 !== request.verifiedObjectSha256) {
    refuse("the request's object digest is not the one the persisted manifest pins", {
      segmentId: request.segmentId,
      objectKey: request.verifiedObjectKey,
      pinned: objectEntry.sha256,
      claimed: request.verifiedObjectSha256,
    });
  }
  if (!objectEntry.segmentIds.includes(request.segmentId)) {
    refuse("the pinned object does not claim to hold this segment", {
      segmentId: request.segmentId,
      objectKey: request.verifiedObjectKey,
    });
  }

  // -- 3. The file about to be deleted is the file the manifest describes. --
  const segmentBytes = Buffer.from(await context.readSegmentFile());
  if (segmentBytes.byteLength !== segmentEntry.byteSize) {
    refuse("the segment file's length differs from the pinned byteSize", {
      segmentId: request.segmentId,
      pinned: segmentEntry.byteSize,
      observed: segmentBytes.byteLength,
    });
  }
  const observedSegmentSha256 = sha256Hex(
    segmentBytes.subarray(0, segmentEntry.checksummedByteLength),
  );
  if (observedSegmentSha256 !== segmentEntry.segmentSha256) {
    refuse("the segment file's checksum differs from the pinned segmentSha256", {
      segmentId: request.segmentId,
      pinned: segmentEntry.segmentSha256,
      observed: observedSegmentSha256,
    });
  }
  // The span digest above cannot cover the footer line (`wal-format.md` §7),
  // so a same-length footer mutation would pass it. The whole-file pin is what
  // makes "this is the file that was archived" true of every byte. A manifest
  // without the pin proves nothing about the footer and is refused: the pin is
  // produced at compaction time, before deletion eligibility ever exists.
  const pinnedFileSha256: unknown = (segmentEntry as { segmentFileSha256?: unknown })
    .segmentFileSha256;
  if (typeof pinnedFileSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pinnedFileSha256)) {
    refuse("the persisted manifest does not pin a whole-file digest for it", {
      segmentId: request.segmentId,
      segmentFileSha256: pinnedFileSha256,
    });
  }
  const observedFileSha256 = sha256Hex(segmentBytes);
  if (observedFileSha256 !== pinnedFileSha256) {
    refuse("the segment file's bytes differ from the pinned whole-file digest", {
      segmentId: request.segmentId,
      pinned: pinnedFileSha256,
      observed: observedFileSha256,
    });
  }

  // -- 4. The stored object matches its pin and provides the segment's rows.
  if ((await context.objectStore.head(request.verifiedObjectKey)) === null) {
    refuse("its verified object is not in the store", {
      segmentId: request.segmentId,
      objectKey: request.verifiedObjectKey,
    });
  }
  const objectBytes = await context.objectStore.get(request.verifiedObjectKey);
  const observedObjectSha256 = sha256Hex(objectBytes);
  if (observedObjectSha256 !== objectEntry.sha256) {
    refuse("the stored object's digest differs from the pinned one", {
      segmentId: request.segmentId,
      objectKey: request.verifiedObjectKey,
      pinned: objectEntry.sha256,
      observed: observedObjectSha256,
    });
  }

  let rows;
  try {
    rows = await readParquetObject(objectBytes);
  } catch (error) {
    return refuse("the stored object does not decode as a dataset object", {
      segmentId: request.segmentId,
      objectKey: request.verifiedObjectKey,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const segmentRows = rows.filter((row) => row.segmentId === request.segmentId);
  if (segmentRows.length !== segmentEntry.recordCount) {
    refuse("the stored object does not hold the pinned number of rows for it", {
      segmentId: request.segmentId,
      objectKey: request.verifiedObjectKey,
      pinned: segmentEntry.recordCount,
      observed: segmentRows.length,
    });
  }
  const seenRecordIndices = new Set<number>();
  for (const row of segmentRows) {
    if (
      row.segmentRecordIndex < 0 ||
      row.segmentRecordIndex >= segmentEntry.recordCount ||
      seenRecordIndices.has(row.segmentRecordIndex)
    ) {
      refuse("the stored object's rows do not cover the segment's records once each", {
        segmentId: request.segmentId,
        segmentRecordIndex: row.segmentRecordIndex,
      });
    }
    seenRecordIndices.add(row.segmentRecordIndex);

    const end = row.frameLineByteOffset + row.frameLineByteLength;
    if (row.frameLineByteOffset < 0 || end > segmentBytes.byteLength) {
      refuse("a stored row points outside the segment file it claims to preserve", {
        segmentId: request.segmentId,
        segmentRecordIndex: row.segmentRecordIndex,
      });
    }
    const slice = segmentBytes.subarray(row.frameLineByteOffset, end);
    const encoded = Buffer.from(encodeFrameLine(row.record));
    if (sha256Hex(slice) !== row.frameLineSha256 || !encoded.equals(slice)) {
      refuse("a stored row does not reproduce the exact bytes it claims to preserve", {
        segmentId: request.segmentId,
        segmentRecordIndex: row.segmentRecordIndex,
        frameLineSha256: row.frameLineSha256,
      });
    }
  }
}
