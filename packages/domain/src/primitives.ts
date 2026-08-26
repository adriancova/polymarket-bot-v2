/**
 * Shared non-economic primitives used by the contracts in this package.
 *
 * Every string field is length-bounded. These bounds are not venue facts; they
 * are boundary hygiene for a process that parses untrusted frames, and they
 * keep metric label cardinality and database column widths predictable. They
 * are documented in `docs/contracts/domain.md`.
 *
 * Economic values never appear here — they live in `./decimals.ts` and are
 * always canonical decimal strings, never JavaScript numbers.
 */

import { z } from "zod";

/** Upper bound for identifier-like strings. */
export const MAX_IDENTIFIER_LENGTH = 200;

/** Upper bound for short vocabulary strings (reason codes, tags, channels). */
export const MAX_CODE_LENGTH = 64;

/** Upper bound for human-readable free text carried on operational events. */
export const MAX_DETAIL_LENGTH = 2000;

/** A bounded, non-empty string. */
export const NonEmptyStringSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);

/** Bounded human-readable text (never parsed, only displayed or logged). */
export const DetailStringSchema = z.string().min(1).max(MAX_DETAIL_LENGTH);

/**
 * A stable machine vocabulary token: reason codes, tags, feed identifiers,
 * channel names.
 *
 * Restricted to characters that are safe as a Prometheus label value and as a
 * database enum-like key (§14.3 labels metrics by reason code).
 */
export const CodeStringSchema = z
  .string()
  .min(1)
  .max(MAX_CODE_LENGTH)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u, "must be an alphanumeric code without whitespace");

/** Reason code as used by `DecisionResult.reasonCodes` (§7.5) and risk vetoes. */
export const ReasonCodeSchema = CodeStringSchema;

/** Free-form strategy tag (§7.7 `tags`). */
export const TagSchema = CodeStringSchema;

/**
 * ISO-8601 timestamp with an explicit UTC designator or offset.
 *
 * Zod validates the calendar date as well as the shape, so `2026-02-30T00:00:00Z`
 * is rejected. Timestamps are strings everywhere in the contracts; `Date` is not
 * used because it silently normalizes and loses the original offset.
 */
export const IsoTimestampSchema = z.iso.datetime({ offset: true });

/**
 * A non-negative big integer serialized as a decimal string (§7.1
 * `receivedMonotonicNs`, `ingestSeq`, `rawRecordOffset`).
 *
 * Canonical form: no leading zeros, no sign. JavaScript `number` cannot hold
 * these values exactly, which is why they are strings.
 */
export const UnsignedBigIntStringSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^(?:0|[1-9][0-9]*)$/u, "must be a canonical unsigned integer string");

/** A non-negative safe integer (counters and generations only, never economics). */
export const NonNegativeIntegerSchema = z.int().nonnegative();

/** A strictly positive safe integer (durations and counts, never economics). */
export const PositiveIntegerSchema = z.int().positive();

export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;
export type UnsignedBigIntString = z.infer<typeof UnsignedBigIntStringSchema>;
export type CodeString = z.infer<typeof CodeStringSchema>;
