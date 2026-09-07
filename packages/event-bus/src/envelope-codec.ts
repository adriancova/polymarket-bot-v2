/**
 * §7.1 envelope validation and JSON encoding. Payload semantics remain opaque;
 * its own enumerable data is deep-copied in key order without normalization.
 * Honest JSON bytes are preserved, while callers receive a fresh frozen
 * null-prototype tree rather than the live object or the schema output.
 */

import { UnknownPayloadEventEnvelopeSchema } from "@polymarket-bot/domain";
import type { EventEnvelope } from "@polymarket-bot/domain";

import {
  containedJudgement,
  matchesOrderingFormat,
  ORDERING_FORMAT_KEYS,
  readOwnWireValue,
} from "./envelope-door.js";
import { EventBusEnvelopeError } from "./errors.js";

/** Validate own data and return the fresh frozen envelope snapshot. */
export function validateEnvelope(value: unknown): EventEnvelope<unknown> {
  return containedJudgement(() => {
    if (typeof value !== "object" || value === null) {
      throw new EventBusEnvelopeError("an event envelope must be an object (§7.1)", {
        received: typeof value,
      });
    }
    const own = readOwnWireValue(value) as Record<string, unknown>;
    // `payload` is validated as `unknown`, which accepts an absent key. §7.1
    // types it as required, and a transport that delivered an envelope with no
    // payload would be delivering nothing at all.
    if (!Object.hasOwn(own, "payload")) {
      throw new EventBusEnvelopeError("an event envelope must carry a payload (§7.1)", {});
    }
    const result = UnknownPayloadEventEnvelopeSchema.safeParse(own);
    if (!result.success) {
      throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    for (const key of ORDERING_FORMAT_KEYS) {
      if (!matchesOrderingFormat(key, own[key])) {
        throw new EventBusEnvelopeError("value is not a valid §7.1 event envelope", {
          issues: [{ path: key, message: "the own ordering field does not match its schema format" }],
        });
      }
    }
    return own as EventEnvelope<unknown>;
  });
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
