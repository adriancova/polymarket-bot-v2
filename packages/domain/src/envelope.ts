/**
 * Event envelope — handoff §7.1.
 *
 * `gatewayEpoch + ingestSeq` defines the exact order consumed during one
 * gateway epoch, so both are REQUIRED on every envelope. A resubscription
 * creates a new `subscriptionGeneration`; a restart or detected gap requires a
 * new authoritative snapshot before affected markets resume.
 *
 * Bigint-like fields (`receivedMonotonicNs`, `ingestSeq`, `rawRecordOffset`)
 * are strings because JavaScript `number` cannot hold them exactly. Timestamps
 * are ISO-8601 strings.
 *
 * Envelopes are validated as STRICT objects: an unknown key is an error, not
 * something to silently strip. Dropping data on the recording path would
 * violate §8.3 ("dropping trading or raw market events silently is forbidden"),
 * and a new field is a schema-version change (see `./schema-version.ts`).
 *
 * `source` is the authoritative provenance. Every envelope schema built here
 * carries the refinement that enforces it against a payload that restates its
 * origin — see {@link envelopeProvenanceRefinement}.
 */

import { z } from "zod";

import { UuidSchema, Uuidv7Schema } from "./identifiers.js";
import {
  CodeStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  UnsignedBigIntStringSchema,
} from "./primitives.js";
import { checkEnvelopePayloadProvenance, type ProvenancePayload } from "./provenance.js";
import { SchemaVersionSchema } from "./schema-version.js";

/** Event origin (§7.1). */
export const EventSourceSchema = z.enum([
  "polymarket",
  "binance",
  "coinbase",
  "rtds",
  "internal",
]);
export type EventSource = z.infer<typeof EventSourceSchema>;

const envelopeCommonShape = {
  /** UUIDv7 (§7.1). */
  eventId: Uuidv7Schema,
  source: EventSourceSchema,
  sourceChannel: NonEmptyStringSchema,

  /** Present only when the source supplies it (§7.1). */
  venueTimestamp: IsoTimestampSchema.optional(),
  receivedAt: IsoTimestampSchema,
  /** bigint serialized as string (§7.1). */
  receivedMonotonicNs: UnsignedBigIntStringSchema,

  /** UUID assigned at gateway startup — REQUIRED (§7.1). */
  gatewayEpoch: UuidSchema,
  /** Monotonic bigint within the epoch — REQUIRED (§7.1). */
  ingestSeq: UnsignedBigIntStringSchema,
  connectionId: NonEmptyStringSchema.optional(),
  subscriptionGeneration: NonNegativeIntegerSchema.optional(),

  rawSegmentId: NonEmptyStringSchema.optional(),
  rawRecordOffset: UnsignedBigIntStringSchema.optional(),
  correlationId: NonEmptyStringSchema.optional(),
  causationId: NonEmptyStringSchema.optional(),
} as const;

/**
 * The §7.1 envelope, exactly as specified.
 *
 * Hand-written (rather than inferred) because the contract is generic over its
 * payload; the Zod schemas below validate the same shape at runtime.
 */
export type EventEnvelope<TPayload> = {
  eventId: string; // UUIDv7
  eventType: string;
  schemaVersion: number;
  source: EventSource;
  sourceChannel: string;

  venueTimestamp?: string; // ISO-8601 when supplied by source
  receivedAt: string; // wall-clock ISO-8601
  receivedMonotonicNs: string; // bigint serialized as string

  gatewayEpoch: string; // UUID assigned at gateway startup
  ingestSeq: string; // monotonic bigint within epoch
  connectionId?: string;
  subscriptionGeneration?: number;

  rawSegmentId?: string;
  rawRecordOffset?: string;
  correlationId?: string;
  causationId?: string;

  payload: TPayload;
};

/**
 * Enforces the §7.1 provenance agreement inside the envelope contract itself.
 *
 * The envelope `source` is authoritative; a payload that restates its origin
 * (the reference-feed `venue`) must agree with it. Leaving this to a helper the
 * caller has to remember would mean the canonical validation path — every
 * contract's `envelopeSchema`, and `DOMAIN_EVENT_REGISTRY.parseEnvelope` on top
 * of it — accepts a document in which the two provenance fields contradict each
 * other, and two readers of the same event would attribute it to different
 * venues. The contract therefore makes that document unrepresentable, exactly
 * as the unconditional gap-recovery invariant is made unrepresentable in
 * `events/feed.ts`.
 *
 * The refinement is silent when `source` is not a string or the payload is not
 * an object: those failures belong to the field schemas, and reporting them
 * twice would only add noise.
 */
export function envelopeProvenanceRefinement(value: unknown, ctx: z.RefinementCtx): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const envelope = value as { source?: unknown; eventType?: unknown; payload?: unknown };
  if (typeof envelope.source !== "string") {
    return;
  }
  const outcome = checkEnvelopePayloadProvenance(
    typeof envelope.eventType === "string"
      ? { source: envelope.source, eventType: envelope.eventType }
      : { source: envelope.source },
    envelope.payload as ProvenancePayload,
  );
  if (!outcome.ok) {
    ctx.addIssue({
      code: "custom",
      message: `${outcome.message}; the envelope source is authoritative (§7.1)`,
      path: ["payload", "venue"],
      input: outcome.payloadVenue,
    });
  }
}

/** Builds a strict envelope schema around a payload schema. */
export function eventEnvelopeSchema<TPayload extends z.ZodType>(payloadSchema: TPayload) {
  return z
    .strictObject({
      ...envelopeCommonShape,
      eventType: CodeStringSchema,
      schemaVersion: SchemaVersionSchema,
      payload: payloadSchema,
    })
    .superRefine(envelopeProvenanceRefinement);
}

/**
 * Builds a strict envelope schema whose `eventType` and `schemaVersion` are
 * pinned to literals. Used by every registered event contract so a payload can
 * never be validated under the wrong event type or version.
 */
export function pinnedEventEnvelopeSchema<TType extends string, TPayload extends z.ZodType>(
  eventType: TType,
  schemaVersion: number,
  payloadSchema: TPayload,
) {
  return z
    .strictObject({
      ...envelopeCommonShape,
      eventType: z.literal(eventType),
      schemaVersion: z.literal(schemaVersion),
      payload: payloadSchema,
    })
    .superRefine(envelopeProvenanceRefinement);
}

/** Envelope schema with an unvalidated payload, for transport-level checks. */
export const UnknownPayloadEventEnvelopeSchema = eventEnvelopeSchema(z.unknown());

/**
 * Minimal projection used to route an unparsed envelope to its contract.
 *
 * Intentionally non-strict: it reads only the two routing fields, after which
 * the original value is re-validated against the full pinned envelope schema.
 */
export const EventEnvelopeRoutingSchema = z.object({
  eventType: CodeStringSchema,
  schemaVersion: SchemaVersionSchema,
});
export type EventEnvelopeRouting = z.infer<typeof EventEnvelopeRoutingSchema>;
