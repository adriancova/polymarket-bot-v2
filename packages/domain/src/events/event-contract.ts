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
import { assertSchemaVersion, type SchemaVersion } from "../schema-version.js";

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

/**
 * Defines one versioned event contract.
 *
 * `schemaVersion` is validated at construction: `SchemaVersion` is statically
 * just `number`, so without this check a contract could be registered under
 * `0`, `-1`, `1.5`, `NaN`, or `Infinity` — keys that no envelope could ever
 * route to, and that would silently shadow a real version in `versionsOf` /
 * `latestVersionOf`. Failing here means the process cannot start with a
 * malformed contract table.
 *
 * @throws {InvalidSchemaVersionError} when `schemaVersion` is not a positive integer.
 */
export function defineEventContract<TType extends string, TPayloadSchema extends z.ZodType>(
  eventType: TType,
  schemaVersion: SchemaVersion,
  payloadSchema: TPayloadSchema,
) {
  assertSchemaVersion(schemaVersion, `${eventType}.schemaVersion`);
  return {
    eventType,
    schemaVersion,
    payloadSchema,
    envelopeSchema: pinnedEventEnvelopeSchema(eventType, schemaVersion, payloadSchema),
  } as const;
}
