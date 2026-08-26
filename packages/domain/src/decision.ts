/**
 * Strategy callback result — handoff §7.5.
 *
 * "A strategy does not call a logger. Each callback returns one result." The
 * runtime adds timing, run, market, event, and strategy identifiers and
 * persists exactly one decision record after the callback returns (§6
 * invariant 3), so those fields are deliberately absent from this contract.
 *
 * `intents` may be EMPTY: a `hold` or `skip` decision is still a decision and
 * is still persisted. This is why the array has no minimum length.
 */

import { z } from "zod";

import { IntentSchema } from "./intents.js";
import { IsoTimestampSchema, NonEmptyStringSchema, ReasonCodeSchema } from "./primitives.js";

/** §7.5 decision types. */
export const DecisionTypeSchema = z.enum([
  "enter",
  "exit",
  "quote",
  "hold",
  "skip",
  "cancel",
  "reduce",
]);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

/**
 * §7.5 model output values: `DecimalString | string | boolean | null`.
 *
 * `DecimalString` is a string alias, so the runtime union is
 * `string | boolean | null`. A JavaScript `number` is rejected — a numeric model
 * output must be serialized as a canonical decimal string first.
 */
export const ModelOutputValueSchema = z.union([z.string(), z.boolean(), z.null()]);
export type ModelOutputValue = z.infer<typeof ModelOutputValueSchema>;

/** §7.5 strategy callback result. */
export const DecisionResultSchema = z.strictObject({
  decisionType: DecisionTypeSchema,
  reasonCodes: z.array(ReasonCodeSchema).readonly(),
  featureSnapshotRef: NonEmptyStringSchema,
  modelOutputs: z.record(z.string(), ModelOutputValueSchema).optional(),
  /** Opaque to the domain; the strategy runtime owns its interpretation. */
  statePatch: z.record(z.string(), z.unknown()).optional(),
  /** Zero or more intents. An empty array is valid and is still persisted. */
  intents: z.array(IntentSchema).readonly(),
  nextWakeupAt: IsoTimestampSchema.optional(),
});

export type DecisionResult = z.infer<typeof DecisionResultSchema>;
