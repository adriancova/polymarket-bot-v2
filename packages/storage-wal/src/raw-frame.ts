/**
 * The `RawFrameRecord` (handoff §9.1) and its validation.
 *
 * The type is declared **here**, not in `packages/domain`, per ADR-004: the
 * domain contract package is frozen and holds no storage-layer type. Any change
 * to this shape is a WAL format change and follows
 * `docs/contracts/wal-format.md` §9.
 *
 * Two rules matter more than the rest:
 *
 * - `payloadUtf8` is the frame **exactly as received** — not normalized, not
 *   re-serialized, not required to be JSON. The CLOB and RTDS heartbeats are the
 *   bare text frames `PING`/`PONG` (venue report §3, §4, §10.3) and are stored
 *   verbatim like any other frame.
 * - `payloadSha256` is computed over exactly those UTF-8 bytes.
 */

import { createHash } from "node:crypto";

import {
  MAX_ENDPOINT_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_PAYLOAD_BYTES,
} from "./constants.js";
import { WalRecordValidationError } from "./errors.js";

/**
 * Handoff §9.1 raw frame record, field-for-field.
 *
 * `ingestSeq` and `receivedMonotonicNs` are bigints serialized as canonical
 * unsigned decimal strings (§7.1 conventions). No field on this record is an
 * economic value, so no decimal-string field appears here.
 */
export type RawFrameRecord = {
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
};

/**
 * The §9.1 field order. Serialization writes keys in exactly this order, so the
 * bytes a given record produces are byte-identical across processes (§12.4).
 */
export const RAW_FRAME_RECORD_KEYS = [
  "gatewayEpoch",
  "ingestSeq",
  "source",
  "endpoint",
  "connectionId",
  "subscriptionGeneration",
  "receivedAt",
  "receivedMonotonicNs",
  "payloadUtf8",
  "payloadSha256",
] as const satisfies readonly (keyof RawFrameRecord)[];

/** Input to {@link buildRawFrameRecord}: everything except the payload digest. */
export type RawFrameRecordInput = Omit<RawFrameRecord, "payloadSha256">;

const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/u;
const LOWERCASE_SHA256_HEX = /^[0-9a-f]{64}$/u;
const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

/** Maximum digits accepted for a bigint-as-string field (2^256 has 78 digits). */
const MAX_BIGINT_STRING_DIGITS = 40;

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof value === "string" ? Buffer.from(value, "utf8") : value);
  return hash.digest("hex");
}

/**
 * The digest of a frame payload: SHA-256 over the exact UTF-8 bytes of
 * `payloadUtf8`.
 */
export function payloadDigest(payloadUtf8: string): string {
  return sha256Hex(payloadUtf8);
}

/**
 * Build a validated `RawFrameRecord`, computing `payloadSha256` from the exact
 * payload bytes.
 */
export function buildRawFrameRecord(input: RawFrameRecordInput): RawFrameRecord {
  if (typeof input !== "object" || input === null) {
    throw new WalRecordValidationError("raw frame input must be an object", {
      received: typeof input,
    });
  }
  const payloadUtf8: unknown = (input as { payloadUtf8?: unknown }).payloadUtf8;
  if (typeof payloadUtf8 !== "string") {
    throw new WalRecordValidationError("payloadUtf8 must be a string", {
      field: "payloadUtf8",
      received: typeof payloadUtf8,
    });
  }
  return parseRawFrameRecord({ ...input, payloadSha256: payloadDigest(payloadUtf8) });
}

function requireString(
  value: unknown,
  field: string,
  options: { readonly minLength: number; readonly maxLength: number },
): string {
  if (typeof value !== "string") {
    throw new WalRecordValidationError(`${field} must be a string`, {
      field,
      received: value === null ? "null" : typeof value,
    });
  }
  if (value.length < options.minLength) {
    throw new WalRecordValidationError(`${field} must not be empty`, { field });
  }
  if (value.length > options.maxLength) {
    throw new WalRecordValidationError(
      `${field} exceeds the maximum length of ${options.maxLength}`,
      { field, length: value.length },
    );
  }
  return value;
}

function requireBigintString(value: unknown, field: string): string {
  const text = requireString(value, field, {
    minLength: 1,
    maxLength: MAX_BIGINT_STRING_DIGITS,
  });
  if (!CANONICAL_UNSIGNED_INTEGER.test(text)) {
    throw new WalRecordValidationError(
      `${field} must be a canonical unsigned integer string (bigint serialized as string)`,
      { field, value: text },
    );
  }
  return text;
}

function requireIso8601(value: unknown, field: string): string {
  const text = requireString(value, field, { minLength: 1, maxLength: 64 });
  if (!ISO_8601_INSTANT.test(text) || Number.isNaN(Date.parse(text))) {
    throw new WalRecordValidationError(
      `${field} must be an ISO-8601 instant with an explicit offset`,
      { field, value: text },
    );
  }
  return text;
}

/**
 * Validate an untrusted value as a `RawFrameRecord` and return it with keys in
 * the canonical §9.1 order.
 *
 * Unknown keys are rejected rather than stripped: silently dropping a field on
 * the recording path would destroy the evidence the recording exists to keep.
 */
export function parseRawFrameRecord(value: unknown): RawFrameRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WalRecordValidationError("raw frame record must be a JSON object", {
      received: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    });
  }

  const candidate = value as Record<string, unknown>;
  const presentKeys = Object.keys(candidate);
  const unknownKeys = presentKeys.filter(
    (key) => !(RAW_FRAME_RECORD_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new WalRecordValidationError("raw frame record has unknown keys", {
      unknownKeys,
    });
  }
  const missingKeys = RAW_FRAME_RECORD_KEYS.filter((key) => !(key in candidate));
  if (missingKeys.length > 0) {
    throw new WalRecordValidationError("raw frame record is missing required keys", {
      missingKeys,
    });
  }

  const subscriptionGeneration = candidate["subscriptionGeneration"];
  if (
    typeof subscriptionGeneration !== "number" ||
    !Number.isSafeInteger(subscriptionGeneration) ||
    subscriptionGeneration < 0
  ) {
    throw new WalRecordValidationError(
      "subscriptionGeneration must be a non-negative safe integer",
      { field: "subscriptionGeneration", value: subscriptionGeneration },
    );
  }

  const payloadUtf8 = candidate["payloadUtf8"];
  if (typeof payloadUtf8 !== "string") {
    throw new WalRecordValidationError("payloadUtf8 must be a string", {
      field: "payloadUtf8",
      received: payloadUtf8 === null ? "null" : typeof payloadUtf8,
    });
  }
  const payloadByteLength = Buffer.byteLength(payloadUtf8, "utf8");
  if (payloadByteLength > MAX_PAYLOAD_BYTES) {
    throw new WalRecordValidationError(
      `payloadUtf8 exceeds the maximum of ${MAX_PAYLOAD_BYTES} bytes`,
      { field: "payloadUtf8", byteLength: payloadByteLength },
    );
  }

  const payloadSha256 = requireString(candidate["payloadSha256"], "payloadSha256", {
    minLength: 64,
    maxLength: 64,
  });
  if (!LOWERCASE_SHA256_HEX.test(payloadSha256)) {
    throw new WalRecordValidationError(
      "payloadSha256 must be 64 lowercase hexadecimal characters",
      { field: "payloadSha256", value: payloadSha256 },
    );
  }

  return {
    gatewayEpoch: requireString(candidate["gatewayEpoch"], "gatewayEpoch", {
      minLength: 1,
      maxLength: MAX_IDENTIFIER_LENGTH,
    }),
    ingestSeq: requireBigintString(candidate["ingestSeq"], "ingestSeq"),
    source: requireString(candidate["source"], "source", {
      minLength: 1,
      maxLength: MAX_IDENTIFIER_LENGTH,
    }),
    endpoint: requireString(candidate["endpoint"], "endpoint", {
      minLength: 1,
      maxLength: MAX_ENDPOINT_LENGTH,
    }),
    connectionId: requireString(candidate["connectionId"], "connectionId", {
      minLength: 1,
      maxLength: MAX_IDENTIFIER_LENGTH,
    }),
    subscriptionGeneration,
    receivedAt: requireIso8601(candidate["receivedAt"], "receivedAt"),
    receivedMonotonicNs: requireBigintString(
      candidate["receivedMonotonicNs"],
      "receivedMonotonicNs",
    ),
    payloadUtf8,
    payloadSha256,
  };
}

/**
 * Assert that `payloadSha256` really is the digest of `payloadUtf8`.
 *
 * The writer runs this on every accepted frame by default: a digest that does
 * not match its payload makes the record useless as evidence, and the cheapest
 * place to catch it is before it reaches the disk.
 */
export function assertPayloadDigest(record: RawFrameRecord): void {
  const expected = payloadDigest(record.payloadUtf8);
  if (expected !== record.payloadSha256) {
    throw new WalRecordValidationError(
      "payloadSha256 does not match the SHA-256 of payloadUtf8",
      {
        field: "payloadSha256",
        declared: record.payloadSha256,
        computed: expected,
        ingestSeq: record.ingestSeq,
      },
    );
  }
}

/** Compare two canonical unsigned integer strings (`ingestSeq` ordering). */
export function compareIngestSeq(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
