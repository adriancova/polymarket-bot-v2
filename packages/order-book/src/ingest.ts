/**
 * Ingest metadata: the envelope subset a book update is ordered and
 * attributed by.
 *
 * The gateway assigns `gatewayEpoch`, `ingestSeq`, `subscriptionGeneration`,
 * and `receivedAt` on the §7.1 envelope; this package consumes exactly that
 * subset and never mints any of it. §9.4's closing rule binds here: the book
 * never invents a venue sequence number — internal ingest order
 * (`gatewayEpoch + ingestSeq`), venue timestamps, and venue-provided hashes
 * are the only ordering and validation material.
 *
 * Validation is fail-closed:
 *
 * - `gatewayEpoch` must be a canonical lowercase UUID. A UUID-shaped value in
 *   any other case is a typed refusal carrying the raw value, never a
 *   case-fold (ADR-016 §2, 2026-09-02 amendment).
 * - `ingestSeq` must be a canonical unsigned integer string (the envelope's
 *   bigint-serialized form).
 * - `subscriptionGeneration`, when present, must be a positive safe integer:
 *   `WP-070`'s subscription manager starts real generations at `1` and never
 *   carries `0` on an event (`packages/polymarket-public/src/feed/subscriptions.ts`).
 * - `venueTimestamp` / `receivedAt`, when present, must be ISO-8601 with
 *   offset (the envelope grammar). `receivedAt` is additionally parsed to
 *   epoch milliseconds at ingest so staleness is a pure subtraction later.
 */

import { IsoTimestampSchema, UnsignedBigIntStringSchema, UuidSchema } from "@polymarket-bot/domain";

import type { Refused } from "./refusals.js";
import { refuse } from "./refusals.js";

/** The envelope subset an update is ordered by. Input shape (unvalidated). */
export interface BookIngestMeta {
  /** §7.1 `gatewayEpoch` — identity, not chronology (`wal-format.md` §12.1). */
  readonly gatewayEpoch: string;
  /** §7.1 `ingestSeq` — monotonic bigint within one epoch, serialized as string. */
  readonly ingestSeq: string;
  /** §7.1 `subscriptionGeneration` — present on every subscription-attributed update. */
  readonly subscriptionGeneration?: number;
  /** The venue's own timestamp when supplied. Data, never an order (§9.4). */
  readonly venueTimestamp?: string;
  /** Gateway wall-clock arrival, ISO-8601. The basis for staleness. */
  readonly receivedAt?: string;
}

/** A validated ingest meta, with derived comparison values. */
export interface ValidatedIngestMeta {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  /** `ingestSeq` as a bigint, for exact strictly-increasing comparison. */
  readonly ingestSeqValue: bigint;
  readonly subscriptionGeneration?: number;
  readonly venueTimestamp?: string;
  readonly receivedAt?: string;
  /** `receivedAt` parsed to epoch milliseconds (deterministic for ISO-8601). */
  readonly receivedAtEpochMs?: number;
}

export type IngestMetaValidation =
  | { readonly ok: true; readonly meta: ValidatedIngestMeta }
  | ({ readonly ok: false } & Refused);

/** Case-insensitive UUID shape, used only to DETECT a UUID-shaped value. */
const UUID_SHAPE_ANY_CASE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function invalid(detail: string, evidence: Readonly<Record<string, string | number | undefined>>): IngestMetaValidation {
  return { ok: false, ...refuse("ORDER_BOOK_INGEST_META_INVALID", detail, evidence) };
}

/** Validates one ingest meta. Pure; returns a typed refusal, never throws. */
export function validateIngestMeta(meta: BookIngestMeta): IngestMetaValidation {
  if (!UuidSchema.safeParse(meta.gatewayEpoch).success) {
    if (typeof meta.gatewayEpoch === "string" && UUID_SHAPE_ANY_CASE.test(meta.gatewayEpoch)) {
      // ADR-016 §2 (amended 2026-09-02): a UUID-shaped identifier arriving in
      // a non-canonical spelling is REFUSED with the raw value attached —
      // never normalized, never case-folded.
      return {
        ok: false,
        ...refuse(
          "ORDER_BOOK_UUID_NOT_CANONICAL",
          "gatewayEpoch is UUID-shaped but not in the canonical lowercase form (ADR-016 §2: refuse, do not normalize)",
          { gatewayEpoch: meta.gatewayEpoch },
        ),
      };
    }
    return invalid("gatewayEpoch is not a canonical lowercase UUID", {
      gatewayEpoch: meta.gatewayEpoch,
    });
  }

  if (!UnsignedBigIntStringSchema.safeParse(meta.ingestSeq).success) {
    return invalid("ingestSeq is not a canonical unsigned integer string", {
      ingestSeq: meta.ingestSeq,
    });
  }

  if (meta.subscriptionGeneration !== undefined) {
    const generation = meta.subscriptionGeneration;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return invalid(
        "subscriptionGeneration must be a positive safe integer (WP-070 generations start at 1; 0 is never carried by an event)",
        { subscriptionGeneration: generation },
      );
    }
  }

  if (meta.venueTimestamp !== undefined && !IsoTimestampSchema.safeParse(meta.venueTimestamp).success) {
    return invalid("venueTimestamp is not ISO-8601 with offset", {
      venueTimestamp: meta.venueTimestamp,
    });
  }

  let receivedAtEpochMs: number | undefined;
  if (meta.receivedAt !== undefined) {
    if (!IsoTimestampSchema.safeParse(meta.receivedAt).success) {
      return invalid("receivedAt is not ISO-8601 with offset", { receivedAt: meta.receivedAt });
    }
    const parsed = Date.parse(meta.receivedAt);
    if (!Number.isFinite(parsed)) {
      return invalid("receivedAt did not parse to a finite instant", {
        receivedAt: meta.receivedAt,
      });
    }
    receivedAtEpochMs = parsed;
  }

  return {
    ok: true,
    meta: {
      gatewayEpoch: meta.gatewayEpoch,
      ingestSeq: meta.ingestSeq,
      ingestSeqValue: BigInt(meta.ingestSeq),
      ...(meta.subscriptionGeneration === undefined
        ? {}
        : { subscriptionGeneration: meta.subscriptionGeneration }),
      ...(meta.venueTimestamp === undefined ? {} : { venueTimestamp: meta.venueTimestamp }),
      ...(meta.receivedAt === undefined ? {} : { receivedAt: meta.receivedAt }),
      ...(receivedAtEpochMs === undefined ? {} : { receivedAtEpochMs }),
    },
  };
}
