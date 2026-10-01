/**
 * The proof an expired-after-extract deletion must present (ADR-028 Decision
 * 2.2, 2.4, 2.6, 2.7), verified against the durable store and the segment's
 * own bytes immediately before the unlink.
 *
 * ## What a request claims, and what is re-checked
 *
 * A request names the segment, its two digests, the research-tier dataset the
 * deletion relies on, and every pin whose range overlaps the segment. Every
 * one of those is a **claim**, as in `retention-proof.ts`: the guard trusts
 * the store and the file, never the caller.
 *
 * 1. **The segment file is read once**, and every check below runs over those
 *    bytes. They are the bytes that will be unlinked (the caller removes the
 *    file only after this function returns).
 * 2. **The research tier is verified** (Decision 2.2) from the store alone:
 *    its manifest exists, hashes to its digest sidecar and to the digest the
 *    plan pinned, and every object it pins re-hashes to its pin
 *    (`verifyResearchTierDataset`).
 * 3. **The research-tier manifest lists the segment as a source**, with the
 *    request's `segmentSha256` and `segmentFileSha256` (Decision 2.6, ADR-029
 *    Decision 1.5). Those two values were computed by the extractor from the
 *    bytes `validateSegment` verified.
 * 4. **The file is the one that was extracted** (Decision 2.7, ADR-017 §1):
 *    it is exactly `byteSize` bytes long, hashes to `segmentSha256` over its
 *    checksummed span and to `segmentFileSha256` over its full length. A
 *    truncated, changed or replaced file fails here and is kept.
 * 5. **Every named pin is verified the ADR-017 §4 way** (Decision 2.4): its
 *    manifest is re-fetched, hashes to its sidecar and to the digest the plan
 *    pinned, reads as an **exact** dataset (an approximate manifest proves
 *    nothing about raw bytes), lists the segment with the **same two digests**
 *    (Decision 2.6), and its object reproduces every frame line of the file
 *    byte for byte (`verifyRetentionProof`, the `WP-130` guard, run unchanged).
 *
 * Every failure is a {@link RetentionGuardError}; nothing may be unlinked
 * unless all of it holds. Which pins overlap the segment, and whether the
 * segment is old enough and classified, are the planner's decisions
 * (`apps/research-worker`); this guard proves the bytes.
 */

import { DATASET_MANIFEST_DIGEST_OBJECT_NAME, DATASET_MANIFEST_OBJECT_NAME } from "./constants.js";
import { parseDatasetManifest } from "./dataset-manifest.js";
import type { DatasetManifest } from "./dataset-manifest.js";
import { RetentionGuardError } from "./errors.js";
import type { ObjectStore } from "./ports.js";
import type { ResearchSourceSegment } from "./research-tier-manifest.js";
import { verifyResearchTierDataset } from "./research-tier-writer.js";
import { verifyRetentionProof } from "./retention-proof.js";
import type { ReliedOnDataset } from "./retention-receipt.js";
import { parseStrictJsonBytes } from "./strict-json.js";
import { sha256Hex } from "./wal-format.js";

/** One deletion an expiry plan orders. Every field is a claim. */
export type ExpiryDeletionRequest = {
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentSha256: string;
  readonly segmentFileSha256: string;
  readonly researchTier: ReliedOnDataset;
  /** Every pin whose range overlaps the segment (Decision 2.4), or none. */
  readonly pins: readonly (ReliedOnDataset & { readonly pinId: string })[];
};

/** What the guard established, for the receipt. */
export type ExpiryProofOutcome = {
  readonly researchEntry: ResearchSourceSegment;
  readonly fileByteLength: number;
  readonly pinsVerified: number;
};

export type ExpiryProofContext = {
  readonly objectStore: ObjectStore;
  /** Bytes of the WAL segment file the caller intends to delete. */
  readonly readSegmentFile: () => Promise<Uint8Array>;
};

function refuse(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new RetentionGuardError(`refusing to expire a WAL segment: ${message}`, details);
}

function sidecarKeyFor(manifestKey: string): string {
  if (manifestKey === DATASET_MANIFEST_OBJECT_NAME) return DATASET_MANIFEST_DIGEST_OBJECT_NAME;
  if (!manifestKey.endsWith(`/${DATASET_MANIFEST_OBJECT_NAME}`)) {
    refuse("a pin manifest key does not name a dataset manifest object", { manifestKey });
  }
  return `${manifestKey.slice(0, manifestKey.length - DATASET_MANIFEST_OBJECT_NAME.length)}${DATASET_MANIFEST_DIGEST_OBJECT_NAME}`;
}

async function fetchPinManifest(
  objectStore: ObjectStore,
  pin: ReliedOnDataset & { readonly pinId: string },
  segmentId: string,
): Promise<DatasetManifest> {
  if ((await objectStore.head(pin.manifestObjectKey)) === null) {
    refuse("an overlapping pin's manifest is not in the store", { segmentId, pinId: pin.pinId });
  }
  const bytes = await objectStore.get(pin.manifestObjectKey);
  const observed = sha256Hex(bytes);
  if (observed !== pin.manifestSha256) {
    refuse("an overlapping pin's manifest is not the one the plan pinned", {
      segmentId,
      pinId: pin.pinId,
      pinned: pin.manifestSha256,
      observed,
    });
  }
  const sidecarKey = sidecarKeyFor(pin.manifestObjectKey);
  if ((await objectStore.head(sidecarKey)) === null) {
    refuse("an overlapping pin's digest sidecar is not in the store", { segmentId, pinId: pin.pinId });
  }
  const sidecar = Buffer.from(await objectStore.get(sidecarKey)).toString("utf8").trim();
  if (sidecar !== observed) {
    refuse("an overlapping pin's manifest does not match its digest sidecar", { segmentId, pinId: pin.pinId });
  }
  let manifest: DatasetManifest;
  try {
    // ADR-017 §3: the strict-JSON profile (a duplicate key is refused).
    manifest = parseDatasetManifest(parseStrictJsonBytes(bytes));
  } catch (error) {
    return refuse("an overlapping pin's manifest is not an exact dataset manifest this build reads", {
      segmentId,
      pinId: pin.pinId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (manifest.datasetId !== pin.datasetId) {
    refuse("an overlapping pin's manifest names a different dataset", { segmentId, pinId: pin.pinId });
  }
  return manifest;
}

/**
 * Verify, from the durable store and the segment's own bytes, that expiring
 * the segment named by `request` is permitted. Throws
 * {@link RetentionGuardError} otherwise.
 */
export async function verifyExpiryProof(
  context: ExpiryProofContext,
  request: ExpiryDeletionRequest,
): Promise<ExpiryProofOutcome> {
  // -- 1. The bytes about to be unlinked, read once. -----------------------
  const bytes = Buffer.from(await context.readSegmentFile());

  // -- 2. The research tier, verified from the store. ----------------------
  let research;
  try {
    research = await verifyResearchTierDataset(context.objectStore, request.researchTier.manifestObjectKey);
  } catch (error) {
    return refuse("its research tier is not verified", {
      segmentId: request.segmentId,
      manifestObjectKey: request.researchTier.manifestObjectKey,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (research.manifestSha256 !== request.researchTier.manifestSha256) {
    refuse("the research-tier manifest is not the one the plan pinned", {
      segmentId: request.segmentId,
      pinned: request.researchTier.manifestSha256,
      observed: research.manifestSha256,
    });
  }
  if (research.manifest.datasetId !== request.researchTier.datasetId) {
    refuse("the research-tier manifest names a different dataset", { segmentId: request.segmentId });
  }

  // -- 3. The research tier lists this segment, with both digests. ---------
  const entry = research.manifest.sourceSegments.find((source) => source.segmentId === request.segmentId);
  if (entry === undefined) {
    refuse("the verified research tier does not list it as a source", { segmentId: request.segmentId });
  }
  const disagreements: string[] = [];
  if (entry.gatewayEpoch !== request.gatewayEpoch) disagreements.push("gatewayEpoch");
  if (entry.segmentSha256 !== request.segmentSha256) disagreements.push("segmentSha256");
  if (entry.segmentFileSha256 !== request.segmentFileSha256) disagreements.push("segmentFileSha256");
  if (disagreements.length > 0) {
    refuse("the request contradicts what the research-tier manifest pins", {
      segmentId: request.segmentId,
      fields: disagreements,
    });
  }

  // -- 4. The file is the file that was extracted (Decision 2.7). ----------
  if (bytes.byteLength !== entry.byteSize) {
    refuse("the segment file's length differs from the pinned byteSize", {
      segmentId: request.segmentId,
      pinned: entry.byteSize,
      observed: bytes.byteLength,
    });
  }
  const observedSpan = sha256Hex(bytes.subarray(0, entry.checksummedByteLength));
  if (observedSpan !== entry.segmentSha256) {
    refuse("the segment file's checksummed span differs from the pinned segmentSha256", {
      segmentId: request.segmentId,
      pinned: entry.segmentSha256,
      observed: observedSpan,
    });
  }
  const observedFile = sha256Hex(bytes);
  if (observedFile !== entry.segmentFileSha256) {
    refuse("the segment file differs from the pinned whole-file digest", {
      segmentId: request.segmentId,
      pinned: entry.segmentFileSha256,
      observed: observedFile,
    });
  }

  // -- 5. Every overlapping pin, verified the ADR-017 §4 way. --------------
  const seenPins = new Set<string>();
  for (const pin of request.pins) {
    if (seenPins.has(pin.pinId)) {
      refuse("a pin is named twice", { segmentId: request.segmentId, pinId: pin.pinId });
    }
    seenPins.add(pin.pinId);
    const manifest = await fetchPinManifest(context.objectStore, pin, request.segmentId);
    const pinned = (Array.isArray(manifest.segments) ? manifest.segments : []).find(
      (segment) => segment.segmentId === request.segmentId,
    );
    if (pinned === undefined) {
      refuse("an overlapping pin does not hold the segment", { segmentId: request.segmentId, pinId: pin.pinId });
    }
    if (pinned.segmentSha256 !== entry.segmentSha256 || pinned.segmentFileSha256 !== entry.segmentFileSha256) {
      refuse("an overlapping pin lists different digests for the segment than the research tier", {
        segmentId: request.segmentId,
        pinId: pin.pinId,
      });
    }
    const object = (Array.isArray(manifest.objects) ? manifest.objects : []).find(
      (candidate) => candidate.objectKey === pinned.objectKey,
    );
    if (object === undefined) {
      refuse("an overlapping pin's manifest pins no object for the segment", {
        segmentId: request.segmentId,
        pinId: pin.pinId,
      });
    }
    try {
      await verifyRetentionProof(
        { objectStore: context.objectStore, readSegmentFile: () => Promise.resolve(bytes) },
        {
          segmentId: request.segmentId,
          gatewayEpoch: request.gatewayEpoch,
          recordCount: pinned.recordCount,
          segmentSha256: entry.segmentSha256,
          verifiedObjectKey: pinned.objectKey,
          verifiedObjectSha256: object.sha256,
          datasetManifestKey: pin.manifestObjectKey,
        },
      );
    } catch (error) {
      return refuse("an overlapping pin does not preserve the segment's bytes", {
        segmentId: request.segmentId,
        pinId: pin.pinId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { researchEntry: entry, fileByteLength: bytes.byteLength, pinsVerified: request.pins.length };
}
