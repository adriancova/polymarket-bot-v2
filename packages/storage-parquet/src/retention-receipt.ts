/**
 * The retention receipt: what retention actually deleted, stated after the
 * fact.
 *
 * ## Why deletion state is not in the dataset manifest
 *
 * ADR-004 §5 orders upload, checksum verification, and only then deletion.
 * Round-1 review of `WP-130` found the implementation deleting WAL segments
 * *before* the dataset manifest was persisted, so a failed manifest write left
 * the WAL gone and the dataset undescribed. The remediation persists and
 * read-back-verifies the manifest **before** any deletion is permitted — which
 * means the manifest, being immutable, cannot record deletions that have not
 * happened yet and must not be rewritten once they have. Deletion state is
 * therefore not part of a dataset's archival identity at all. It is reported
 * here, in a separate immutable object written after retention ran.
 *
 * The receipt is *reporting*, not proof. The proof a deletion relies on is the
 * persisted dataset manifest itself, which the retention implementation
 * re-fetches from the store and re-verifies against the bytes it is about to
 * delete ({@link ./retention-proof.js}). A crash after a deletion but before
 * the receipt write loses only the report: the manifest is already durable and
 * every deleted record is in a verified object it pins.
 */

import { RETENTION_RECEIPT_FORMAT_ID, RETENTION_RECEIPT_VERSION } from "./constants.js";
import { sha256Hex } from "./wal-format.js";

/** One segment retention removed, and the verified object that permitted it. */
export type RetentionReceiptDeletion = {
  readonly segmentId: string;
  readonly verifiedObjectKey: string;
  readonly verifiedObjectSha256: string;
};

/** One segment retention tried and failed to remove. */
export type RetentionReceiptFailure = {
  readonly segmentId: string;
  readonly detail: string;
};

/** The receipt document. */
export type RetentionReceipt = {
  readonly retentionReceiptFormatId: string;
  readonly retentionReceiptVersion: number;
  readonly datasetId: string;
  /** The persisted manifest whose verification preceded every deletion. */
  readonly datasetManifestObjectKey: string;
  /** SHA-256 of that manifest's bytes as read back from the store. */
  readonly datasetManifestSha256: string;
  readonly walRetentionPolicy: string;
  readonly completedAt: string;
  readonly deletedSegments: readonly RetentionReceiptDeletion[];
  readonly retentionFailures: readonly RetentionReceiptFailure[];
};

/**
 * Serialize a receipt canonically (fixed key order, two-space indentation,
 * trailing newline), mirroring the dataset manifest's encoding rules.
 */
export function encodeRetentionReceipt(receipt: RetentionReceipt): Uint8Array {
  const ordered = {
    retentionReceiptFormatId: receipt.retentionReceiptFormatId,
    retentionReceiptVersion: receipt.retentionReceiptVersion,
    datasetId: receipt.datasetId,
    datasetManifestObjectKey: receipt.datasetManifestObjectKey,
    datasetManifestSha256: receipt.datasetManifestSha256,
    walRetentionPolicy: receipt.walRetentionPolicy,
    completedAt: receipt.completedAt,
    deletedSegments: receipt.deletedSegments.map((deletion) => ({
      segmentId: deletion.segmentId,
      verifiedObjectKey: deletion.verifiedObjectKey,
      verifiedObjectSha256: deletion.verifiedObjectSha256,
    })),
    retentionFailures: receipt.retentionFailures.map((failure) => ({
      segmentId: failure.segmentId,
      detail: failure.detail,
    })),
  };
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

/** SHA-256 of a receipt's canonical bytes. */
export function retentionReceiptDigest(receipt: RetentionReceipt): string {
  return sha256Hex(encodeRetentionReceipt(receipt));
}

/** Build a receipt with this build's format identity. */
export function buildRetentionReceipt(input: Omit<
  RetentionReceipt,
  "retentionReceiptFormatId" | "retentionReceiptVersion"
>): RetentionReceipt {
  return {
    retentionReceiptFormatId: RETENTION_RECEIPT_FORMAT_ID,
    retentionReceiptVersion: RETENTION_RECEIPT_VERSION,
    ...input,
  };
}
