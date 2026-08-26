/**
 * Event contract definition helper.
 *
 * An *event contract* is the triple `(eventType, schemaVersion, payloadSchema)`
 * plus the strict envelope schema that pins the first two to literals. Pinning
 * them means a payload can never be validated under the wrong event type or the
 * wrong version, which is what makes historical replay (§8.4) safe.
 */

import type { z } from "zod";

import { pinnedEventEnvelopeSchema } from "../envelope.js";
import type { SchemaVersion } from "../schema-version.js";

/**
 * Structural shape every event contract satisfies.
 *
 * The registry stores contracts under this widened type; call sites that know
 * the concrete contract keep full inference by using the contract constant
 * directly.
 */
export interface EventContractLike {
  readonly eventType: string;
  readonly schemaVersion: SchemaVersion;
  readonly payloadSchema: z.ZodType;
  readonly envelopeSchema: z.ZodType;
}

/** Defines one versioned event contract. */
export function defineEventContract<TType extends string, TPayloadSchema extends z.ZodType>(
  eventType: TType,
  schemaVersion: SchemaVersion,
  payloadSchema: TPayloadSchema,
) {
  return {
    eventType,
    schemaVersion,
    payloadSchema,
    envelopeSchema: pinnedEventEnvelopeSchema(eventType, schemaVersion, payloadSchema),
  } as const;
}
