/**
 * The on-disk segment format: JSON Lines, one record per line, UTF-8, LF
 * terminated (ADR-004 §1).
 *
 * Three line kinds exist. A frame line carries **exactly** the ten §9.1
 * `RawFrameRecord` keys and nothing else, so the recording layer adds no field
 * to the record the handoff specifies. Header and footer lines carry a `record`
 * discriminator, a key a `RawFrameRecord` never has — which is what makes the
 * three kinds unambiguous without wrapping frames in an envelope.
 *
 * The authoritative description of the format is
 * `docs/contracts/wal-format.md`; this module is its implementation.
 */

import { encodePlainJson, PLAIN_JSON_REFUSAL_KINDS } from "@polymarket-bot/risk/plain-json";
import type { PlainJsonRefusalKind } from "@polymarket-bot/risk/plain-json";

import { WAL_FORMAT_ID, WAL_SCHEMA_VERSION } from "./constants.js";
import { WalSegmentIntegrityError } from "./errors.js";
import type { WalCloseReason } from "./ports.js";
import { RAW_FRAME_RECORD_KEYS, parseRawFrameRecord } from "./raw-frame.js";
import type { RawFrameRecord } from "./raw-frame.js";

/**
 * First line of every segment (§9.1: "File header includes schema version and
 * gateway epoch").
 */
export type WalSegmentHeader = {
  readonly record: "header";
  readonly formatId: string;
  readonly walSchemaVersion: number;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly createdAt: string;
};

/**
 * Optional last line of a cleanly closed segment (§9.1: "File footer or sidecar
 * includes record count and SHA-256").
 *
 * `segmentSha256` covers the first `checksummedByteLength` bytes of the file:
 * the header line plus every frame line. It cannot cover the footer, because the
 * footer contains the digest.
 */
export type WalSegmentFooter = {
  readonly record: "footer";
  readonly formatId: string;
  readonly walSchemaVersion: number;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly recordCount: number;
  readonly checksummedByteLength: number;
  readonly segmentSha256: string;
  readonly closedAt: string;
  readonly closeReason: WalCloseReason;
};

/** A classified line. */
export type WalSegmentLine =
  | { readonly kind: "header"; readonly header: WalSegmentHeader }
  | { readonly kind: "frame"; readonly record: RawFrameRecord }
  | { readonly kind: "footer"; readonly footer: WalSegmentFooter };

const CLOSE_REASONS: readonly WalCloseReason[] = [
  "size-rotation",
  "time-rotation",
  "manual-rotation",
  "shutdown",
  "recovery",
  "write-fault",
];

const LOWERCASE_SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * The `kind` of the own-data encoder's refusal, read as OWN DATA, or
 * `undefined` for anything else that was thrown.
 *
 * Not `instanceof NotPlainJson`: the encoder's refusal is classified by the
 * closed vocabulary it carries, so the classification consults no prototype
 * (`packages/event-bus/src/envelope-door.ts` records why that matters at a
 * containment boundary). A thrown value that is not an object, carries no own
 * data `kind`, or whose descriptor read throws, is "not the encoder's refusal".
 */
function plainJsonRefusalKind(error: unknown): PlainJsonRefusalKind | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "kind");
  } catch {
    return undefined;
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
  const kind: unknown = descriptor.value;
  return typeof kind === "string" && PLAIN_JSON_REFUSAL_KINDS.includes(kind as PlainJsonRefusalKind)
    ? (kind as PlainJsonRefusalKind)
    : undefined;
}

/** An own string data property of `error`, or `undefined`. */
function ownStringOf(error: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
  return typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/**
 * The ONE encoder for every line this package persists: header, frame, footer.
 *
 * The bytes are `@polymarket-bot/risk/plain-json`'s `encodePlainJson`, the
 * ECMA-262 25.5.2 restatement over OWN DATA — never `JSON.stringify`, which
 * resolves `toJSON` through the value's prototype chain. `SER-0`
 * (`docs/handoffs/SER-0-sweep.md`) measured this site under an inherited
 * `toJSON` on `Object.prototype`: the frame line persisted was the bytes the
 * injected function answered, fed to the running SHA-256, attested by the
 * footer and the manifest, reported durable and cleared from `pendingFrames()`
 * — and the evidence existed nowhere else. Header and footer lines, HIGH by
 * the same route. The primitive reads own data descriptors only, so the bytes
 * of a line are a function of the record and of nothing ambient; for every
 * in-type input they are byte-identical to what a clean process's
 * `JSON.stringify` produced (`docs/contracts/wal-format.md` is unchanged).
 *
 * A value the encoder refuses — `undefined` at the root, a `bigint`, a
 * function or symbol member, an accessor, a non-plain container, a container
 * nested past the default depth — is a `WalSegmentIntegrityError` with the
 * refusal's `kind`, `path` and `problem` in its details. Before this round
 * only a root `JSON.stringify` has no text for (`undefined`, a function, a
 * symbol) reached that error; a bigint was an untyped `TypeError`, and a
 * function member, a `Date` or a `Map` were silently omitted or substituted
 * by `JSON.stringify`. Every record type this module
 * encodes is a literal it builds from primitives, so the refusal is
 * unreachable for a well-formed record and exists so a malformed one fails
 * loudly instead of persisting bytes that are not the record.
 */
function encodeLine(value: unknown): Uint8Array {
  let json: string;
  try {
    json = encodePlainJson(value);
  } catch (error) {
    const kind = plainJsonRefusalKind(error);
    if (kind === undefined) throw error;
    const refusal = error as object;
    throw new WalSegmentIntegrityError("record is not JSON-serializable", {
      kind,
      path: ownStringOf(refusal, "path"),
      problem: ownStringOf(refusal, "problem"),
    });
  }
  if (json.includes("\n")) {
    // The encoder escapes literal newlines inside strings, so this is
    // unreachable for well-formed input; it exists so a future change that
    // introduces pretty-printing fails loudly instead of corrupting framing.
    throw new WalSegmentIntegrityError("encoded record contains a line feed");
  }
  return Buffer.from(`${json}\n`, "utf8");
}

/** Build the header for a new segment. */
export function buildSegmentHeader(input: {
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly createdAt: string;
}): WalSegmentHeader {
  return {
    record: "header",
    formatId: WAL_FORMAT_ID,
    walSchemaVersion: WAL_SCHEMA_VERSION,
    segmentId: input.segmentId,
    gatewayEpoch: input.gatewayEpoch,
    segmentIndex: input.segmentIndex,
    createdAt: input.createdAt,
  };
}

/** Encode a header line, including its trailing newline. */
export function encodeHeaderLine(header: WalSegmentHeader): Uint8Array {
  return encodeLine({
    record: header.record,
    formatId: header.formatId,
    walSchemaVersion: header.walSchemaVersion,
    segmentId: header.segmentId,
    gatewayEpoch: header.gatewayEpoch,
    segmentIndex: header.segmentIndex,
    createdAt: header.createdAt,
  });
}

/**
 * Encode a frame line, including its trailing newline.
 *
 * Keys are emitted in the §9.1 declaration order, so one record always produces
 * one byte sequence.
 */
export function encodeFrameLine(record: RawFrameRecord): Uint8Array {
  return encodeLine({
    gatewayEpoch: record.gatewayEpoch,
    ingestSeq: record.ingestSeq,
    source: record.source,
    endpoint: record.endpoint,
    connectionId: record.connectionId,
    subscriptionGeneration: record.subscriptionGeneration,
    receivedAt: record.receivedAt,
    receivedMonotonicNs: record.receivedMonotonicNs,
    payloadUtf8: record.payloadUtf8,
    payloadSha256: record.payloadSha256,
  });
}

/** Encode a footer line, including its trailing newline. */
export function encodeFooterLine(footer: WalSegmentFooter): Uint8Array {
  return encodeLine({
    record: footer.record,
    formatId: footer.formatId,
    walSchemaVersion: footer.walSchemaVersion,
    segmentId: footer.segmentId,
    gatewayEpoch: footer.gatewayEpoch,
    recordCount: footer.recordCount,
    checksummedByteLength: footer.checksummedByteLength,
    segmentSha256: footer.segmentSha256,
    closedAt: footer.closedAt,
    closeReason: footer.closeReason,
  });
}

function requirePlainObject(
  value: unknown,
  context: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WalSegmentIntegrityError("segment line is not a JSON object", context);
  }
  return value as Record<string, unknown>;
}

function requireStringField(
  candidate: Record<string, unknown>,
  field: string,
  context: Readonly<Record<string, unknown>>,
): string {
  const value = candidate[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new WalSegmentIntegrityError(`segment line field ${field} must be a non-empty string`, {
      ...context,
      field,
    });
  }
  return value;
}

function requireNonNegativeIntegerField(
  candidate: Record<string, unknown>,
  field: string,
  context: Readonly<Record<string, unknown>>,
): number {
  const value = candidate[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WalSegmentIntegrityError(
      `segment line field ${field} must be a non-negative safe integer`,
      { ...context, field, value },
    );
  }
  return value;
}

/** Parse and validate a header object. */
export function parseSegmentHeader(
  value: unknown,
  context: Readonly<Record<string, unknown>> = {},
): WalSegmentHeader {
  const candidate = requirePlainObject(value, context);
  if (candidate["record"] !== "header") {
    throw new WalSegmentIntegrityError("segment header is missing its discriminator", context);
  }
  const formatId = requireStringField(candidate, "formatId", context);
  if (formatId !== WAL_FORMAT_ID) {
    throw new WalSegmentIntegrityError("segment was written in an unknown WAL format", {
      ...context,
      formatId,
      expected: WAL_FORMAT_ID,
    });
  }
  const walSchemaVersion = requireNonNegativeIntegerField(candidate, "walSchemaVersion", context);
  if (walSchemaVersion !== WAL_SCHEMA_VERSION) {
    throw new WalSegmentIntegrityError("segment schema version is not readable by this build", {
      ...context,
      walSchemaVersion,
      supported: WAL_SCHEMA_VERSION,
    });
  }
  return {
    record: "header",
    formatId,
    walSchemaVersion,
    segmentId: requireStringField(candidate, "segmentId", context),
    gatewayEpoch: requireStringField(candidate, "gatewayEpoch", context),
    segmentIndex: requireNonNegativeIntegerField(candidate, "segmentIndex", context),
    createdAt: requireStringField(candidate, "createdAt", context),
  };
}

/** Parse and validate a footer object. */
export function parseSegmentFooter(
  value: unknown,
  context: Readonly<Record<string, unknown>> = {},
): WalSegmentFooter {
  const candidate = requirePlainObject(value, context);
  if (candidate["record"] !== "footer") {
    throw new WalSegmentIntegrityError("segment footer is missing its discriminator", context);
  }
  const formatId = requireStringField(candidate, "formatId", context);
  if (formatId !== WAL_FORMAT_ID) {
    throw new WalSegmentIntegrityError("segment footer declares an unknown WAL format", {
      ...context,
      formatId,
    });
  }
  const segmentSha256 = requireStringField(candidate, "segmentSha256", context);
  if (!LOWERCASE_SHA256_HEX.test(segmentSha256)) {
    throw new WalSegmentIntegrityError(
      "segment footer checksum must be 64 lowercase hexadecimal characters",
      { ...context, segmentSha256 },
    );
  }
  const closeReason = candidate["closeReason"];
  if (typeof closeReason !== "string" || !CLOSE_REASONS.includes(closeReason as WalCloseReason)) {
    throw new WalSegmentIntegrityError("segment footer declares an unknown close reason", {
      ...context,
      closeReason,
    });
  }
  return {
    record: "footer",
    formatId,
    walSchemaVersion: requireNonNegativeIntegerField(candidate, "walSchemaVersion", context),
    segmentId: requireStringField(candidate, "segmentId", context),
    gatewayEpoch: requireStringField(candidate, "gatewayEpoch", context),
    recordCount: requireNonNegativeIntegerField(candidate, "recordCount", context),
    checksummedByteLength: requireNonNegativeIntegerField(
      candidate,
      "checksummedByteLength",
      context,
    ),
    segmentSha256,
    closedAt: requireStringField(candidate, "closedAt", context),
    closeReason: closeReason as WalCloseReason,
  };
}

/**
 * Classify and validate one complete line.
 *
 * Throws {@link WalSegmentIntegrityError} for anything that is not a
 * well-formed header, frame, or footer. The caller decides whether the failing
 * line is an incomplete final record (recoverable by truncation) or corruption
 * (a data-quality incident) — this function does not, because it never sees the
 * file position.
 */
export function classifySegmentLine(
  text: string,
  context: Readonly<Record<string, unknown>> = {},
): WalSegmentLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new WalSegmentIntegrityError("segment line is not valid JSON", {
      ...context,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const candidate = requirePlainObject(parsed, context);
  const discriminator = candidate["record"];
  if (discriminator === "header") {
    return { kind: "header", header: parseSegmentHeader(candidate, context) };
  }
  if (discriminator === "footer") {
    return { kind: "footer", footer: parseSegmentFooter(candidate, context) };
  }
  if (discriminator !== undefined) {
    throw new WalSegmentIntegrityError("segment line has an unknown record discriminator", {
      ...context,
      record: discriminator,
    });
  }
  try {
    return { kind: "frame", record: parseRawFrameRecord(candidate) };
  } catch (error) {
    throw new WalSegmentIntegrityError("segment line is not a valid raw frame record", {
      ...context,
      expectedKeys: RAW_FRAME_RECORD_KEYS,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
