/**
 * Settlement vocabularies — handoff §9.3.
 *
 * Every enum here is transcribed from a named source and nothing is invented:
 *
 * | Vocabulary | Source |
 * | --- | --- |
 * | `ObservationType` | handoff §9.3 `observation_type` (`TERMINAL_SPOT | TWAP | VWAP | EVENT_RESULT | MANUAL_ORACLE`) |
 * | `ComparisonOperator` | handoff §9.3 `comparison` (`GT | GTE | LT | LTE`) |
 * | `PayoffModelId` | handoff §9.3 payoff models (`TerminalSpotBinaryModel`, `TwapBinaryModel`, `ReferenceOpenUpDownModel`, `ThresholdByDateModel`) |
 * | `VerificationStatus` | `db/migrations/0001_foundation.up.sql` `internal.verification_status` (`UNVERIFIED | VERIFIED | REJECTED`), which WP-040 derived from §9.3 `verified_by`/`verified_at` |
 * | `MarketOutcomeState` | re-exported from `@polymarket-bot/domain`; the §9.3 required outcome states are frozen there and are NOT redefined here |
 *
 * The first four match the PostgreSQL enums WP-040 created
 * (`internal.observation_type`, `internal.comparison_operator`,
 * `internal.payoff_model`, `internal.verification_status`) member for member, so
 * a persisted row and an in-memory spec cannot disagree about the vocabulary.
 * They are declared here rather than imported from `packages/domain` because
 * `packages/domain` is frozen (WP-020) and contains no settlement-spec contract;
 * see `README.md` §"Why these vocabularies live here".
 */

import {
  MarketOutcomeStateSchema,
  TerminalMarketOutcomeStateSchema,
  isTerminalMarketOutcomeState,
  type MarketOutcomeState,
  type TerminalMarketOutcomeState,
} from "@polymarket-bot/domain";
import { z } from "zod";

/** §9.3 `observation_type`. */
export const ObservationTypeSchema = z.enum([
  "TERMINAL_SPOT",
  "TWAP",
  "VWAP",
  "EVENT_RESULT",
  "MANUAL_ORACLE",
]);
export type ObservationType = z.infer<typeof ObservationTypeSchema>;

/** Every §9.3 observation type, in specification order. */
export const OBSERVATION_TYPES = ObservationTypeSchema.options;

/** §9.3 `comparison`. */
export const ComparisonOperatorSchema = z.enum(["GT", "GTE", "LT", "LTE"]);
export type ComparisonOperator = z.infer<typeof ComparisonOperatorSchema>;

/** Every §9.3 comparison operator, in specification order. */
export const COMPARISON_OPERATORS = ComparisonOperatorSchema.options;

/** The four §9.3 payoff models. There is no fifth, and no "default" model. */
export const PayoffModelIdSchema = z.enum([
  "TerminalSpotBinaryModel",
  "TwapBinaryModel",
  "ReferenceOpenUpDownModel",
  "ThresholdByDateModel",
]);
export type PayoffModelId = z.infer<typeof PayoffModelIdSchema>;

/** Every §9.3 payoff model, in specification order. */
export const PAYOFF_MODEL_IDS = PayoffModelIdSchema.options;

/**
 * Review outcome of a settlement spec.
 *
 * `VERIFIED` is the only value that permits model-dependent strategy activation
 * (§9.2, ADR-009 §1). `REJECTED` is a reviewed refusal and is distinct from
 * `UNVERIFIED` (not yet reviewed) so an operator can tell "nobody looked" from
 * "somebody looked and said no".
 */
export const VerificationStatusSchema = z.enum(["UNVERIFIED", "VERIFIED", "REJECTED"]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export {
  MarketOutcomeStateSchema,
  TerminalMarketOutcomeStateSchema,
  isTerminalMarketOutcomeState,
};
export type { MarketOutcomeState, TerminalMarketOutcomeState };
