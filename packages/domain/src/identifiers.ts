/**
 * Canonical identifiers — handoff §7.2.
 *
 * The §7.2 listing types every identifier as `string` and annotates the format
 * of four of them. This module keeps exactly that promise:
 *
 * - `InternalMarketId` is a UUIDv7 (annotated in §7.2).
 * - `TokenId` is a venue integer encoded as a string (annotated in §7.2), so it
 *   is validated as a canonical unsigned integer with no leading zeros. Venue
 *   adapters normalize the wire form before constructing a domain value, in the
 *   same way decimal strings are normalized at the adapter boundary.
 * - `ConditionId`, `VenueOrderId` and `VenueTradeId` are opaque venue strings;
 *   their internal structure is a volatile venue fact (§1.2) that this package
 *   deliberately does not encode.
 * - `StrategyRunId`, `DecisionId`, `IntentId`, `ExecutionPlanId` and
 *   `SubmissionAttemptId` have no format annotation in §7.2, so they are
 *   validated as bounded non-empty strings rather than being pinned to an
 *   invented format.
 */

import { z } from "zod";

import { MAX_IDENTIFIER_LENGTH, NonEmptyStringSchema } from "./primitives.js";

/** Lowercase canonical UUID of any version (RFC 9562 variant bits). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Lowercase canonical UUIDv7 (time-ordered), as required for `eventId` (§7.1). */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * A canonical lowercase UUID.
 *
 * Lowercase is required so an identifier has exactly one representation in
 * database keys, stream keys, and hashes. Every UUID in this system is
 * generated in-process, so this costs nothing at the venue boundary.
 */
export const UuidSchema = z.string().regex(UUID_PATTERN, "must be a lowercase canonical UUID");

/** A canonical lowercase UUIDv7. */
export const Uuidv7Schema = z
  .string()
  .regex(UUID_V7_PATTERN, "must be a lowercase canonical UUIDv7");

/** An opaque venue-supplied identifier. */
export const VenueIdentifierSchema = NonEmptyStringSchema;

/** An internally generated identifier with no format pinned by §7.2. */
export const InternalIdentifierSchema = NonEmptyStringSchema;

/** `InternalMarketId` — UUIDv7 (§7.2). */
export const InternalMarketIdSchema = Uuidv7Schema;

/** `ConditionId` — opaque venue string (§7.2). */
export const ConditionIdSchema = VenueIdentifierSchema;

/** `TokenId` — venue integer encoded as a canonical decimal string (§7.2). */
export const TokenIdSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^(?:0|[1-9][0-9]*)$/u, "must be a canonical unsigned integer string");

/** `VenueOrderId` — order hash or venue string (§7.2). */
export const VenueOrderIdSchema = VenueIdentifierSchema;

/** `VenueTradeId` — venue string (§7.2). */
export const VenueTradeIdSchema = VenueIdentifierSchema;

/** `StrategyRunId` (§7.2). */
export const StrategyRunIdSchema = InternalIdentifierSchema;

/** `DecisionId` (§7.2). */
export const DecisionIdSchema = InternalIdentifierSchema;

/** `IntentId` (§7.2). */
export const IntentIdSchema = InternalIdentifierSchema;

/** `ExecutionPlanId` (§7.2). */
export const ExecutionPlanIdSchema = InternalIdentifierSchema;

/** `SubmissionAttemptId` (§7.2). */
export const SubmissionAttemptIdSchema = InternalIdentifierSchema;

export type InternalMarketId = z.infer<typeof InternalMarketIdSchema>;
export type ConditionId = z.infer<typeof ConditionIdSchema>;
export type TokenId = z.infer<typeof TokenIdSchema>;
export type VenueOrderId = z.infer<typeof VenueOrderIdSchema>;
export type VenueTradeId = z.infer<typeof VenueTradeIdSchema>;
export type StrategyRunId = z.infer<typeof StrategyRunIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;
export type IntentId = z.infer<typeof IntentIdSchema>;
export type ExecutionPlanId = z.infer<typeof ExecutionPlanIdSchema>;
export type SubmissionAttemptId = z.infer<typeof SubmissionAttemptIdSchema>;
export type Uuid = z.infer<typeof UuidSchema>;
export type Uuidv7 = z.infer<typeof Uuidv7Schema>;

/** Outcome side of a binary Polymarket market (§7.6, §7.7). */
export const OutcomeSideSchema = z.enum(["YES", "NO"]);
export type OutcomeSide = z.infer<typeof OutcomeSideSchema>;

/** Book side. Used by normalized book events (§7.4). */
export const BookSideSchema = z.enum(["BID", "ASK"]);
export type BookSide = z.infer<typeof BookSideSchema>;
