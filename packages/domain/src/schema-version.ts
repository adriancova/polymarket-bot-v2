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
 * **Every change to the emitted field set increments `schemaVersion`.** There
 * is no "additive optional field reuses the current version" exemption.
 *
 * This follows directly from the strict-object decision: every contract in this
 * package rejects unknown keys (`z.strictObject`), because silently stripping a
 * field on the recording path would violate §8.3. Under strict rejection an
 * "additive" change is *not* backward compatible in the direction that matters:
 * a consumer still running the old build of v1 would reject a document that a
 * newer producer emitted as v1 with the extra field. It would also break the
 * registry's core promise, that `(eventType, schemaVersion)` identifies exactly
 * one historical schema — two different field sets sharing one key makes
 * recorded data ambiguous on replay (§8.4, §12.5).
 *
 * So a new version is required for all of:
 *
 * - adding a field, optional or required;
 * - removing or renaming a field;
 * - widening or narrowing a type, enum, or constraint;
 * - making an optional field required, or a required field optional;
 * - changing the meaning or unit of an existing field.
 *
 * Changes that do NOT alter what a producer may emit or a consumer must accept
 * — documentation, error-message wording, internal refactoring — do not.
 *
 * When a version is added, the previous version's contract **stays registered**
 * so recorded data remains replayable against the schema it was recorded with.
 * Contract changes after WP-020 acceptance additionally require an ADR (see
 * `docs/contracts/domain.md`).
 */

import { z } from "zod";

import { InvalidSchemaVersionError } from "./errors.js";

/** Schema versions are positive integers starting at 1. */
export const SchemaVersionSchema = z.int().positive();

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

/**
 * Runtime guard for a schema version.
 *
 * `SchemaVersion` is statically just `number`, so nothing in the type system
 * stops `0`, `-1`, `1.5`, `NaN`, or `Infinity` from reaching a contract
 * definition or a registry key. Contract construction and registry insertion
 * both call this so an invalid version fails at startup, where it is a loud
 * typed error, rather than becoming an unreachable registry key at runtime.
 *
 * @throws {InvalidSchemaVersionError} when `value` is not a positive integer.
 */
export function assertSchemaVersion(value: unknown, label = "schemaVersion"): SchemaVersion {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidSchemaVersionError(value, label);
  }
  return value;
}

/** Predicate form of {@link assertSchemaVersion}. */
export function isSchemaVersion(value: unknown): value is SchemaVersion {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

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
