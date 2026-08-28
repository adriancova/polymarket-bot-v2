/**
 * Settlement observations — the measured facts a payoff model settles on.
 *
 * The SPEC says where a value comes from (`resolution_source`, `strike_source`,
 * `reference_open_source`); the OBSERVATION carries the value itself. They are
 * separate because a spec is reviewed once per series and an observation exists
 * once per market: `btc-15m-updown` has one spec and one reference open per
 * fifteen-minute market.
 *
 * Every observation is tagged with the payoff model it belongs to. That makes
 * the mismatched pair — a terminal-spot reading handed to the TWAP model, or the
 * reverse, which is the §9.3 failure this package exists to prevent —
 * unrepresentable in typed code, and a runtime refusal for a value that arrived
 * as `unknown`.
 *
 * DECIMALS: every measured price, strike, and threshold is a canonical decimal
 * string (§7.3, ADR-001). Reference-venue prices are non-negative decimals
 * rather than `PriceString`: the `[0, 1]` constraint belongs to Polymarket
 * outcome-token probabilities, not to a BTC/USD print
 * (`docs/contracts/domain.md` §4).
 */

import {
  CodeStringSchema,
  IsoTimestampSchema,
  NonNegativeDecimalStringSchema,
  PositiveIntegerSchema,
} from "@polymarket-bot/domain";
import { z } from "zod";

/**
 * Which end of the observed range a threshold-by-date observation carries.
 *
 * "Will X reach 150000 by December?" is answered by the MAXIMUM observed in the
 * period; "will X fall below 20000 by December?" by the MINIMUM. Carrying the
 * wrong one produces a confident, wrong settlement, so the kind is explicit and
 * checked against the spec's comparison rather than inferred.
 */
export const ObservedExtremeKindSchema = z.enum(["MAX", "MIN"]);
export type ObservedExtremeKind = z.infer<typeof ObservedExtremeKindSchema>;

const observationCommonShape = {
  /** Must equal the spec's `reference_symbol`; checked at evaluation. */
  referenceSymbol: CodeStringSchema,
} as const;

/** A single terminal observation at an instant. */
export const TerminalSpotObservationSchema = z.strictObject({
  ...observationCommonShape,
  model: z.literal("TerminalSpotBinaryModel"),
  observedValue: NonNegativeDecimalStringSchema,
  observedAt: IsoTimestampSchema,
  /** The strike the spec's `strike_source` resolved to for this market. */
  strike: NonNegativeDecimalStringSchema,
});

/** A time-weighted average over a closed window. */
export const TwapObservationSchema = z.strictObject({
  ...observationCommonShape,
  model: z.literal("TwapBinaryModel"),
  /**
   * The exact-decimal TWAP value.
   *
   * ADR-009 §6 rule 2: the exact path uses the feed's `full_accuracy_value`,
   * never its floating `value`. The adapter that owns the wire format does that
   * conversion; this contract accepts only the canonical decimal result.
   */
  twapValue: NonNegativeDecimalStringSchema,
  /** Must equal the spec's `window_seconds`; checked at evaluation. */
  windowSeconds: PositiveIntegerSchema,
  windowStartAt: IsoTimestampSchema,
  windowEndAt: IsoTimestampSchema,
  strike: NonNegativeDecimalStringSchema,
});

/** An up/down reading: a settlement value against the market's own reference open. */
export const ReferenceOpenUpDownObservationSchema = z.strictObject({
  ...observationCommonShape,
  model: z.literal("ReferenceOpenUpDownModel"),
  referenceOpen: NonNegativeDecimalStringSchema,
  referenceOpenAt: IsoTimestampSchema,
  observedValue: NonNegativeDecimalStringSchema,
  observedAt: IsoTimestampSchema,
  /**
   * Present when the spec settles this series on a TWAP observation; required
   * in that case and forbidden otherwise (checked at evaluation against the
   * spec's `observation_type`).
   */
  windowSeconds: PositiveIntegerSchema.optional(),
  windowStartAt: IsoTimestampSchema.optional(),
  windowEndAt: IsoTimestampSchema.optional(),
});

/** Whether a threshold was met at any point in a period ending at a deadline. */
export const ThresholdByDateObservationSchema = z.strictObject({
  ...observationCommonShape,
  model: z.literal("ThresholdByDateModel"),
  threshold: NonNegativeDecimalStringSchema,
  extremeKind: ObservedExtremeKindSchema,
  /** The extreme value observed within `[periodStartAt, min(asOf, deadlineAt)]`. */
  extremeValue: NonNegativeDecimalStringSchema,
  extremeObservedAt: IsoTimestampSchema,
  periodStartAt: IsoTimestampSchema,
  deadlineAt: IsoTimestampSchema,
  /**
   * The instant this evaluation is made "as of".
   *
   * Data, never a clock read: a replayed run must reach the same verdict it
   * reached live (§6 invariant 2, §12.4).
   */
  asOf: IsoTimestampSchema,
});

/** Any settlement observation, discriminated by the model that consumes it. */
export const SettlementObservationSchema = z.discriminatedUnion("model", [
  TerminalSpotObservationSchema,
  TwapObservationSchema,
  ReferenceOpenUpDownObservationSchema,
  ThresholdByDateObservationSchema,
]);

export type TerminalSpotObservation = z.infer<typeof TerminalSpotObservationSchema>;
export type TwapObservation = z.infer<typeof TwapObservationSchema>;
export type ReferenceOpenUpDownObservation = z.infer<
  typeof ReferenceOpenUpDownObservationSchema
>;
export type ThresholdByDateObservation = z.infer<typeof ThresholdByDateObservationSchema>;
export type SettlementObservation = z.infer<typeof SettlementObservationSchema>;
