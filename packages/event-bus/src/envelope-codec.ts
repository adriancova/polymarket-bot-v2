/**
 * Envelope validation and wire encoding for the transport.
 *
 * ## The payload is opaque
 *
 * This module validates the §7.1 envelope and nothing else. The payload is
 * carried through untouched: it is never parsed against an event contract,
 * never normalized, never re-serialized field by field, and a decimal string in
 * it is never converted to a JavaScript `number`. Deciding what a payload
 * *means* belongs to the producer that built it and the consumer that handles
 * it; the transport is not a validation checkpoint for either.
 *
 * ## Round-trip fidelity
 *
 * What a consumer receives must be value-equivalent to what was published, so
 * the wire form is `JSON.stringify` of the caller's own object — not of a
 * schema's output. Zod strips nothing here (the envelope schema is strict, so
 * an unknown key is rejected rather than removed), but encoding the validated
 * *input* rather than the parse *output* means no future schema refinement can
 * quietly rewrite a value in transit.
 *
 * A payload must therefore be JSON-representable. A `bigint` value throws on
 * encode, and an object property explicitly set to `undefined` is absent after
 * the round trip — which is the same fact ADR-002 §7 records, that absence and
 * `null` are different and a domain value carries absence as absence.
 */

import { UnknownPayloadEventEnvelopeSchema } from "@polymarket-bot/domain";
import type { EventEnvelope } from "@polymarket-bot/domain";

import { EventBusEnvelopeError } from "./errors.js";

/**
 * Validates a value as a §7.1 envelope and returns it unchanged.
 *
 * Returns the caller's own object rather than the parse output, so the value
 * that gets encoded is byte-for-byte the value that was checked.
 */
export function validateEnvelope(value: unknown): EventEnvelope<unknown> {
  if (typeof value !== "object" || value === null) {
    throw new EventBusEnvelopeError("an event envelope must be an object (§7.1)", {
      received: typeof value,
    });
  }
  // `payload` is validated as `unknown`, which accepts an absent key. §7.1
  // types it as required, and a transport that delivered an envelope with no
  // payload would be delivering nothing at all.
  if (!Object.hasOwn(value, "payload")) {
    throw new EventBusEnvelopeError("an event envelope must carry a payload (§7.1)", {});
  }
  const result = UnknownPayloadEventEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return value as EventEnvelope<unknown>;
}

/** Validates and encodes an envelope for the wire. */
export function encodeEnvelope(envelope: EventEnvelope<unknown>): string {
  const validated = validateEnvelope(envelope);
  try {
    return JSON.stringify(validated);
  } catch {
    throw new EventBusEnvelopeError(
      "event envelope could not be encoded as JSON; payload values must be JSON-representable",
      { eventId: validated.eventId },
    );
  }
}

/** Decodes a wire value back into a validated envelope. */
export function decodeEnvelope(encoded: string): EventEnvelope<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new EventBusEnvelopeError("stored entry is not valid JSON", {
      byteLength: encoded.length,
    });
  }
  return validateEnvelope(parsed);
}
