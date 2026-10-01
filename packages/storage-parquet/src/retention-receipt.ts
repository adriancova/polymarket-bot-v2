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
 * The receipt is *reporting*, not proof (ADR-017 §4). The proof a deletion
 * relies on is a persisted manifest the guard re-fetches from the store and
 * re-verifies against the bytes it is about to delete.
 *
 * ## Version 2: the deletion basis (ADR-028 Decision 4)
 *
 * Version 1 had one basis, implicitly: every deleted record is inside the
 * verified object the entry names. ADR-028 adds a second, and version 2 makes
 * the basis an explicit field of every deletion entry:
 *
 * - `verified-upload` — the `WP-130` basis, unchanged: the entry names the
 *   verified object that holds every record of the segment
 *   (`retention-proof.ts`).
 * - `expired-after-extract` — the ADR-028 basis: the segment was at least
 *   72 hours old, and its records are kept only as the verified research tier
 *   and the verified pins that overlap it. **Not every deleted record is kept
 *   anywhere.** The entry names the segment's id, both of its digests (the
 *   whole-file one was checked at deletion time against the research-tier
 *   manifest's pin), the research-tier dataset it relied on, and every
 *   overlapping verified pin, or none (Decision 4.2). The proof is those
 *   manifests (`expiry-proof.ts`); the plan that ordered the deletion was
 *   durable before it (Decision 4.5), and this receipt names it.
 *
 * A reader accepts version 1 and version 2. A version 1 entry has no `basis`
 * and reads as `verified-upload`.
 */

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import {
  READABLE_RETENTION_RECEIPT_VERSIONS,
  RETENTION_RECEIPT_FORMAT_ID,
  RETENTION_RECEIPT_VERSION,
} from "./constants.js";
import { DatasetManifestError } from "./errors.js";
import { sha256Hex } from "./wal-format.js";

/** The `WP-130` basis: every record of the segment is in the named verified object. */
export type VerifiedUploadDeletion = {
  readonly basis: "verified-upload";
  readonly segmentId: string;
  readonly verifiedObjectKey: string;
  readonly verifiedObjectSha256: string;
};

/** A verified dataset an expired-after-extract deletion relied on. */
export type ReliedOnDataset = {
  readonly datasetId: string;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
};

/** The ADR-028 basis: deleted after 72 h once the research tier and every pin verified. */
export type ExpiredAfterExtractDeletion = {
  readonly basis: "expired-after-extract";
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentSha256: string;
  readonly segmentFileSha256: string;
  readonly researchTier: ReliedOnDataset;
  /** Every verified pin whose range overlapped the segment, or none. */
  readonly pins: readonly (ReliedOnDataset & { readonly pinId: string })[];
};

/** One segment retention removed, with the basis that permitted it. */
export type RetentionReceiptDeletion = VerifiedUploadDeletion | ExpiredAfterExtractDeletion;

/** One segment retention tried and failed to remove. */
export type RetentionReceiptFailure = {
  readonly segmentId: string;
  readonly detail: string;
};

/** The receipt document. */
export type RetentionReceipt = {
  readonly retentionReceiptFormatId: string;
  readonly retentionReceiptVersion: number;
  /** The compacted dataset whose verification preceded the deletions, or `null` for an expiry run. */
  readonly datasetId: string | null;
  readonly datasetManifestObjectKey: string | null;
  readonly datasetManifestSha256: string | null;
  /** The durable expiry plan that ordered the deletions (ADR-028 Decision 4.5), or `null`. */
  readonly expiryPlanId: string | null;
  readonly expiryPlanSha256: string | null;
  readonly walRetentionPolicy: string;
  readonly completedAt: string;
  readonly deletedSegments: readonly RetentionReceiptDeletion[];
  readonly retentionFailures: readonly RetentionReceiptFailure[];
};

function orderedDeletion(deletion: RetentionReceiptDeletion): Record<string, unknown> {
  if (deletion.basis === "verified-upload") {
    return {
      basis: deletion.basis,
      segmentId: deletion.segmentId,
      verifiedObjectKey: deletion.verifiedObjectKey,
      verifiedObjectSha256: deletion.verifiedObjectSha256,
    };
  }
  return {
    basis: deletion.basis,
    segmentId: deletion.segmentId,
    gatewayEpoch: deletion.gatewayEpoch,
    segmentSha256: deletion.segmentSha256,
    segmentFileSha256: deletion.segmentFileSha256,
    researchTier: {
      datasetId: deletion.researchTier.datasetId,
      manifestObjectKey: deletion.researchTier.manifestObjectKey,
      manifestSha256: deletion.researchTier.manifestSha256,
    },
    pins: deletion.pins.map((pin) => ({
      pinId: pin.pinId,
      datasetId: pin.datasetId,
      manifestObjectKey: pin.manifestObjectKey,
      manifestSha256: pin.manifestSha256,
    })),
  };
}

/**
 * Serialize a receipt canonically (fixed key order, two-space indentation,
 * trailing newline), mirroring the dataset manifest's encoding rules. Only the
 * version this build writes is encoded.
 */
export function encodeRetentionReceipt(receipt: RetentionReceipt): Uint8Array {
  if (receipt.retentionReceiptVersion !== RETENTION_RECEIPT_VERSION) {
    throw new DatasetManifestError("refusing to encode a retention receipt version this build does not write", {
      version: receipt.retentionReceiptVersion,
    });
  }
  const ordered = {
    retentionReceiptFormatId: receipt.retentionReceiptFormatId,
    retentionReceiptVersion: receipt.retentionReceiptVersion,
    datasetId: receipt.datasetId,
    datasetManifestObjectKey: receipt.datasetManifestObjectKey,
    datasetManifestSha256: receipt.datasetManifestSha256,
    expiryPlanId: receipt.expiryPlanId,
    expiryPlanSha256: receipt.expiryPlanSha256,
    walRetentionPolicy: receipt.walRetentionPolicy,
    completedAt: receipt.completedAt,
    deletedSegments: receipt.deletedSegments.map(orderedDeletion),
    retentionFailures: receipt.retentionFailures.map((failure) => ({
      segmentId: failure.segmentId,
      detail: failure.detail,
    })),
  };
  // The own-data encoder, as for the dataset manifest (`SER-0`, `SER-2`).
  return Buffer.from(`${encodePlainJson(ordered, { indent: 2 })}\n`, "utf8");
}

/** SHA-256 of a receipt's canonical bytes. */
export function retentionReceiptDigest(receipt: RetentionReceipt): string {
  return sha256Hex(encodeRetentionReceipt(receipt));
}

/**
 * A deletion as a caller states it: a `verified-upload` entry may omit its
 * basis, which is the version 1 meaning and the only one a caller written
 * before version 2 knows.
 */
export type RetentionReceiptDeletionInput =
  | (Omit<VerifiedUploadDeletion, "basis"> & { readonly basis?: "verified-upload" })
  | ExpiredAfterExtractDeletion;

/** What {@link buildRetentionReceipt} takes. The expiry-plan fields default to `null`. */
export type RetentionReceiptInput = Omit<
  RetentionReceipt,
  "retentionReceiptFormatId" | "retentionReceiptVersion" | "expiryPlanId" | "expiryPlanSha256" | "deletedSegments"
> & {
  readonly expiryPlanId?: string | null;
  readonly expiryPlanSha256?: string | null;
  readonly deletedSegments: readonly RetentionReceiptDeletionInput[];
};

/**
 * Build a receipt with this build's format identity, every field present and
 * in the canonical key order — so the built object and its encoding agree key
 * for key — and every deletion carrying its basis.
 */
export function buildRetentionReceipt(input: RetentionReceiptInput): RetentionReceipt {
  return {
    retentionReceiptFormatId: RETENTION_RECEIPT_FORMAT_ID,
    retentionReceiptVersion: RETENTION_RECEIPT_VERSION,
    datasetId: input.datasetId,
    datasetManifestObjectKey: input.datasetManifestObjectKey,
    datasetManifestSha256: input.datasetManifestSha256,
    expiryPlanId: input.expiryPlanId ?? null,
    expiryPlanSha256: input.expiryPlanSha256 ?? null,
    walRetentionPolicy: input.walRetentionPolicy,
    completedAt: input.completedAt,
    deletedSegments: input.deletedSegments.map((deletion): RetentionReceiptDeletion =>
      deletion.basis === "expired-after-extract"
        ? {
            basis: "expired-after-extract",
            segmentId: deletion.segmentId,
            gatewayEpoch: deletion.gatewayEpoch,
            segmentSha256: deletion.segmentSha256,
            segmentFileSha256: deletion.segmentFileSha256,
            researchTier: {
              datasetId: deletion.researchTier.datasetId,
              manifestObjectKey: deletion.researchTier.manifestObjectKey,
              manifestSha256: deletion.researchTier.manifestSha256,
            },
            pins: deletion.pins.map((pin) => ({
              pinId: pin.pinId,
              datasetId: pin.datasetId,
              manifestObjectKey: pin.manifestObjectKey,
              manifestSha256: pin.manifestSha256,
            })),
          }
        : {
            basis: "verified-upload",
            segmentId: deletion.segmentId,
            verifiedObjectKey: deletion.verifiedObjectKey,
            verifiedObjectSha256: deletion.verifiedObjectSha256,
          },
    ),
    retentionFailures: input.retentionFailures.map((failure) => ({
      segmentId: failure.segmentId,
      detail: failure.detail,
    })),
  };
}

function receiptError(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new DatasetManifestError(`retention receipt: ${message}`, details);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) receiptError(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) receiptError(`${what} must be a non-empty string`);
  return value;
}

function nullableText(value: unknown, what: string): string | null {
  return value === null ? null : text(value, what);
}

function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) receiptError(`${what} must be an array`);
  return value;
}

function reliedOn(value: unknown, what: string): ReliedOnDataset {
  const source = record(value, what);
  return {
    datasetId: text(source["datasetId"], `${what}.datasetId`),
    manifestObjectKey: text(source["manifestObjectKey"], `${what}.manifestObjectKey`),
    manifestSha256: text(source["manifestSha256"], `${what}.manifestSha256`),
  };
}

function parseDeletion(value: unknown, version: number, index: number): RetentionReceiptDeletion {
  const at = `deletedSegments[${String(index)}]`;
  const source = record(value, at);
  const segmentId = text(source["segmentId"], `${at}.segmentId`);
  if (version === 1 && Object.prototype.hasOwnProperty.call(source, "basis")) {
    receiptError(`${at}: a version 1 entry has no basis field`);
  }
  // Version 1 had one basis and no field naming it.
  const basis = version === 1 ? "verified-upload" : source["basis"];
  if (basis === "verified-upload") {
    return {
      basis,
      segmentId,
      verifiedObjectKey: text(source["verifiedObjectKey"], `${at}.verifiedObjectKey`),
      verifiedObjectSha256: text(source["verifiedObjectSha256"], `${at}.verifiedObjectSha256`),
    };
  }
  if (basis === "expired-after-extract") {
    return {
      basis,
      segmentId,
      gatewayEpoch: text(source["gatewayEpoch"], `${at}.gatewayEpoch`),
      segmentSha256: text(source["segmentSha256"], `${at}.segmentSha256`),
      segmentFileSha256: text(source["segmentFileSha256"], `${at}.segmentFileSha256`),
      researchTier: reliedOn(source["researchTier"], `${at}.researchTier`),
      pins: list(source["pins"], `${at}.pins`).map((pin, pinIndex) => {
        const pinAt = `${at}.pins[${String(pinIndex)}]`;
        return { pinId: text(record(pin, pinAt)["pinId"], `${pinAt}.pinId`), ...reliedOn(pin, pinAt) };
      }),
    };
  }
  return receiptError(`${at}: unknown deletion basis`, { basis: String(basis) });
}

/**
 * Read a retention receipt of version 1 or version 2 (ADR-028 Decision 4.3:
 * "A reader must still accept version 1"). A version 1 receipt is returned in
 * the version 2 shape: every entry `verified-upload`, no expiry plan. The
 * receipt stays reporting; nothing may cite the result as an integrity proof
 * (ADR-017 §4.3).
 */
export function parseRetentionReceipt(value: unknown): RetentionReceipt {
  const source = record(value, "retention receipt");
  if (source["retentionReceiptFormatId"] !== RETENTION_RECEIPT_FORMAT_ID) {
    receiptError("unknown format", { formatId: String(source["retentionReceiptFormatId"]) });
  }
  const version = source["retentionReceiptVersion"];
  if (typeof version !== "number" || !READABLE_RETENTION_RECEIPT_VERSIONS.includes(version)) {
    receiptError("version is not readable by this build", {
      version: String(version),
      supported: [...READABLE_RETENTION_RECEIPT_VERSIONS],
    });
  }
  const deletedSegments = list(source["deletedSegments"], "deletedSegments").map((entry, index) =>
    parseDeletion(entry, version, index),
  );
  const retentionFailures = list(source["retentionFailures"], "retentionFailures").map((entry, index) => {
    const at = `retentionFailures[${String(index)}]`;
    const failure = record(entry, at);
    const detail = failure["detail"];
    if (typeof detail !== "string") receiptError(`${at}.detail must be a string`);
    return { segmentId: text(failure["segmentId"], `${at}.segmentId`), detail };
  });
  const common = {
    retentionReceiptFormatId: RETENTION_RECEIPT_FORMAT_ID,
    walRetentionPolicy: text(source["walRetentionPolicy"], "walRetentionPolicy"),
    completedAt: text(source["completedAt"], "completedAt"),
    deletedSegments,
    retentionFailures,
  };
  if (version === 1) {
    for (const key of ["expiryPlanId", "expiryPlanSha256"]) {
      if (Object.prototype.hasOwnProperty.call(source, key)) receiptError(`a version 1 receipt has no ${key} field`);
    }
    return {
      ...common,
      retentionReceiptVersion: 1,
      datasetId: text(source["datasetId"], "datasetId"),
      datasetManifestObjectKey: text(source["datasetManifestObjectKey"], "datasetManifestObjectKey"),
      datasetManifestSha256: text(source["datasetManifestSha256"], "datasetManifestSha256"),
      expiryPlanId: null,
      expiryPlanSha256: null,
    };
  }
  return {
    ...common,
    retentionReceiptVersion: 2,
    datasetId: nullableText(source["datasetId"], "datasetId"),
    datasetManifestObjectKey: nullableText(source["datasetManifestObjectKey"], "datasetManifestObjectKey"),
    datasetManifestSha256: nullableText(source["datasetManifestSha256"], "datasetManifestSha256"),
    expiryPlanId: nullableText(source["expiryPlanId"], "expiryPlanId"),
    expiryPlanSha256: nullableText(source["expiryPlanSha256"], "expiryPlanSha256"),
  };
}
