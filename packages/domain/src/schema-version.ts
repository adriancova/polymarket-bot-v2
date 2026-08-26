/**
 * Schema versioning (handoff §7: "All contracts live in `packages/domain`, use
 * Zod schemas, expose inferred TypeScript types, and include an explicit
 * `schemaVersion`").
 *
 * ## Where the version lives
 *
 * - For **events**, `schemaVersion` is a field of the envelope (§7.1) and is
 *   pinned to a literal by each event contract. It is deliberately not
 *   duplicated inside the payload: two copies of the same fact will eventually
 *   disagree, and the envelope copy is the one a consumer reads before it can
 *   pick a payload schema.
 * - For **non-event contracts** whose §7 shape has no version field
 *   (`DecisionResult`, the intent types), the version is an exported constant
 *   registered in {@link DOMAIN_CONTRACT_VERSIONS}. Adding a `schemaVersion`
 *   field to those objects would contradict the exact field lists in §7.5 and
 *   §7.7, so the version is carried alongside the contract instead.
 *
 * ## When to increment
 *
 * Increment the `schemaVersion` of a contract when a change is not backward
 * compatible for an existing consumer or for recorded historical data:
 *
 * - removing or renaming a field;
 * - narrowing a type, enum, or constraint;
 * - making an optional field required;
 * - changing the meaning or unit of an existing field.
 *
 * Adding a new *optional* field with no meaning change may reuse the current
 * version. Anything else requires a new version, with the previous version's
 * schema retained in the registry so recorded data stays replayable (§8.4,
 * §12.5). Contract changes after WP-020 acceptance additionally require an ADR
 * (see `docs/contracts/domain.md`).
 */

import { z } from "zod";

/** Schema versions are positive integers starting at 1. */
export const SchemaVersionSchema = z.int().positive();

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

/** The version every contract frozen by WP-020 starts at. */
export const INITIAL_SCHEMA_VERSION = 1;

/** Version of the event envelope contract itself (§7.1). */
export const EVENT_ENVELOPE_SCHEMA_VERSION = INITIAL_SCHEMA_VERSION;

/** Version of the strategy callback result contract (§7.5). */
export const DECISION_RESULT_SCHEMA_VERSION = INITIAL_SCHEMA_VERSION;

/** Version of the intent contracts (§7.7). */
export const INTENT_SCHEMA_VERSION = INITIAL_SCHEMA_VERSION;

/**
 * Explicit version of every non-event contract in this package.
 *
 * Consumers that persist one of these structures must persist the matching
 * version from this table so historical records remain interpretable.
 */
export const DOMAIN_CONTRACT_VERSIONS = {
  EventEnvelope: EVENT_ENVELOPE_SCHEMA_VERSION,
  DecisionResult: DECISION_RESULT_SCHEMA_VERSION,
  PositionIntent: INTENT_SCHEMA_VERSION,
  QuoteIntent: INTENT_SCHEMA_VERSION,
  BasketIntent: INTENT_SCHEMA_VERSION,
  CancelIntent: INTENT_SCHEMA_VERSION,
  ReducePositionIntent: INTENT_SCHEMA_VERSION,
} as const satisfies Record<string, SchemaVersion>;

export type DomainContractName = keyof typeof DOMAIN_CONTRACT_VERSIONS;

/** Version lookup for a non-event contract. */
export function domainContractVersion(name: DomainContractName): SchemaVersion {
  return DOMAIN_CONTRACT_VERSIONS[name];
}
