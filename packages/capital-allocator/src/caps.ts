/**
 * Allocator caps — handoff §9.7.
 *
 * "Initial defaults should reflect user-defined caps rather than hardcoded
 * historical examples. The allocator must support a global account cap,
 * per-strategy cap, and live-micro cap." (§9.7)
 *
 * Consequences implemented here:
 *
 * - `globalAccountCap` and `perStrategyCap` are REQUIRED with no default —
 *   this package invents no example number for a user-defined cap.
 * - The live-micro caps are FENCED AT EXACTLY `"0"`. See "THE LIVE-MICRO
 *   FENCE" below.
 * - The per-scope caps (market, series, underlying, resolution window — the
 *   §9.7 commitment list) are optional; a configured scope cap combined with
 *   an unattributable request FAILS CLOSED (`CAPITAL_SCOPE_KEY_MISSING`).
 *
 * THE LIVE-MICRO FENCE (review round 1, HIGH). `AGENTS.md` declares
 * `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`
 * NON-WEAKENABLE defaults. Defaulting them to `"0"` while accepting any
 * caller-supplied value is not enough: it makes this package a weakening
 * vector, because a caller argument could raise a floor it has no authority
 * over. So a live-micro cap other than the exact canonical `"0"` is REFUSED
 * outright (`CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED`) — at the schema, at
 * {@link parseAllocatorCaps}, and again at the reservation gate in
 * `reserve.ts`, so a hand-built caps object cannot slip past either.
 *
 * Enabling live-micro capacity is therefore a SEPARATE, EXPLICITLY AUTHORIZED,
 * FENCED later-phase work package with its own human approval — never an
 * argument to this one. Until such a package exists and owns the authority,
 * this package grants no real-order capacity at all.
 */

import { z } from "zod";

import { NonNegativeMoneyStringSchema } from "@polymarket-bot/domain";

import {
  capitalFailure,
  capitalOk,
  capitalRefusal,
  type CapitalRefusal,
  type CapitalResult,
} from "./refusals.js";

/**
 * The one permitted live-micro cap value: the exact canonical `AGENTS.md`
 * floor. Compared by exact spelling rather than numerically, so a
 * non-canonical or unparseable value refuses too (fail closed, and total — the
 * comparison cannot throw on a hand-built object).
 */
export const LIVE_MICRO_CAP_FLOOR = "0";

/** The two fenced fields. */
export const LIVE_MICRO_CAP_FIELDS = [
  "liveMicroMaxOrderNotional",
  "liveMicroMaxAccountExposure",
] as const;
export type LiveMicroCapField = (typeof LIVE_MICRO_CAP_FIELDS)[number];

const LIVE_MICRO_FENCE_MESSAGE =
  "a live-micro cap other than the exact \"0\" floor is not permitted; AGENTS.md declares LIVE_MICRO_MAX_ORDER_NOTIONAL=0 and LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0 non-weakenable, and enabling live-micro capacity is a separate authorized work package, not a caller argument";

/** The fenced fields whose supplied value is not the exact floor. */
export function nonFloorLiveMicroCapFields(
  caps: Partial<Record<LiveMicroCapField, unknown>>,
): readonly LiveMicroCapField[] {
  return LIVE_MICRO_CAP_FIELDS.filter((field) => {
    const value = caps[field];
    // Absent is fine: the schema default supplies the floor.
    return value !== undefined && value !== LIVE_MICRO_CAP_FLOOR;
  });
}

/**
 * Typed refusals for every fenced field that is not at the floor.
 *
 * Exported so the reservation gate can apply the same fence to a caps object
 * that never went through {@link parseAllocatorCaps}.
 */
export function liveMicroCapRefusals(
  caps: Partial<Record<LiveMicroCapField, unknown>>,
): readonly CapitalRefusal[] {
  return nonFloorLiveMicroCapFields(caps).map((field) =>
    capitalRefusal("CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED", LIVE_MICRO_FENCE_MESSAGE, {
      field,
      supplied: caps[field],
      permitted: LIVE_MICRO_CAP_FLOOR,
    }),
  );
}

/**
 * Grammar only. Internal: {@link AllocatorCapsSchema} adds the live-micro
 * fence on top, and {@link parseAllocatorCaps} applies the fence separately so
 * it can report the specific typed code rather than a generic schema failure.
 */
const AllocatorCapsShapeSchema = z.strictObject({
  /** Required, user-defined (§9.7). Committed exposure across the account. */
  globalAccountCap: NonNegativeMoneyStringSchema,
  /** Required, user-defined (§9.7). Committed exposure per strategy instance. */
  perStrategyCap: NonNegativeMoneyStringSchema,

  perMarketCap: NonNegativeMoneyStringSchema.optional(),
  perSeriesCap: NonNegativeMoneyStringSchema.optional(),
  perUnderlyingCap: NonNegativeMoneyStringSchema.optional(),
  perResolutionWindowCap: NonNegativeMoneyStringSchema.optional(),

  /**
   * FENCED at the exact decimal `"0"` (`AGENTS.md` non-weakenable safety
   * defaults). The default supplies the floor when the caller says nothing;
   * any other supplied value is REFUSED, not accepted. See the module header.
   */
  liveMicroMaxOrderNotional: NonNegativeMoneyStringSchema.default(LIVE_MICRO_CAP_FLOOR),
  liveMicroMaxAccountExposure: NonNegativeMoneyStringSchema.default(LIVE_MICRO_CAP_FLOOR),
});

/**
 * The caller-facing caps schema: grammar PLUS the live-micro fence, so a
 * caller who parses directly instead of calling {@link parseAllocatorCaps}
 * still cannot construct caps that weaken the `AGENTS.md` floors.
 */
export const AllocatorCapsSchema = AllocatorCapsShapeSchema.superRefine((caps, ctx) => {
  for (const field of nonFloorLiveMicroCapFields(caps)) {
    ctx.addIssue({ code: "custom", path: [field], message: LIVE_MICRO_FENCE_MESSAGE });
  }
});

export type AllocatorCaps = z.infer<typeof AllocatorCapsSchema>;

/**
 * Validates caller-supplied caps; refuses rather than repairing.
 *
 * The grammar is checked first so a malformed decimal reports
 * `CAPITAL_INPUT_INVALID`, then the live-micro fence is applied separately so
 * a raised safety floor reports its own `CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED`
 * rather than hiding inside a generic schema failure.
 */
export function parseAllocatorCaps(input: unknown): CapitalResult<AllocatorCaps> {
  const parsed = AllocatorCapsShapeSchema.safeParse(input);
  if (!parsed.success) {
    return capitalFailure(
      capitalRefusal("CAPITAL_INPUT_INVALID", "allocator caps failed validation", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    );
  }
  const fence = liveMicroCapRefusals(parsed.data);
  if (fence.length > 0) {
    return capitalFailure(...fence);
  }
  return capitalOk(Object.freeze(parsed.data));
}
