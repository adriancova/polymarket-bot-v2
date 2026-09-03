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
 * - The live-micro caps DEFAULT TO EXACTLY `"0"`, mirroring the untouchable
 *   repository safety defaults (`AGENTS.md`:
 *   `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`).
 *   A zero default is a safety floor, not an example. Nothing in this package
 *   raises them implicitly.
 * - The per-scope caps (market, series, underlying, resolution window — the
 *   §9.7 commitment list) are optional; a configured scope cap combined with
 *   an unattributable request FAILS CLOSED (`CAPITAL_SCOPE_KEY_MISSING`).
 */

import { z } from "zod";

import { NonNegativeMoneyStringSchema } from "@polymarket-bot/domain";

import { capitalFailure, capitalOk, capitalRefusal, type CapitalResult } from "./refusals.js";

export const AllocatorCapsSchema = z.strictObject({
  /** Required, user-defined (§9.7). Committed exposure across the account. */
  globalAccountCap: NonNegativeMoneyStringSchema,
  /** Required, user-defined (§9.7). Committed exposure per strategy instance. */
  perStrategyCap: NonNegativeMoneyStringSchema,

  perMarketCap: NonNegativeMoneyStringSchema.optional(),
  perSeriesCap: NonNegativeMoneyStringSchema.optional(),
  perUnderlyingCap: NonNegativeMoneyStringSchema.optional(),
  perResolutionWindowCap: NonNegativeMoneyStringSchema.optional(),

  /**
   * Safety defaults, exact decimal `"0"` (`AGENTS.md` — may not be weakened
   * by this package; raising them is a later-phase, explicitly-configured,
   * gated decision that this package merely validates the grammar of).
   */
  liveMicroMaxOrderNotional: NonNegativeMoneyStringSchema.default("0"),
  liveMicroMaxAccountExposure: NonNegativeMoneyStringSchema.default("0"),
});

export type AllocatorCaps = z.infer<typeof AllocatorCapsSchema>;

/** Validates caller-supplied caps; refuses rather than repairing. */
export function parseAllocatorCaps(input: unknown): CapitalResult<AllocatorCaps> {
  const parsed = AllocatorCapsSchema.safeParse(input);
  if (!parsed.success) {
    return capitalFailure(
      capitalRefusal("CAPITAL_INPUT_INVALID", "allocator caps failed validation", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    );
  }
  return capitalOk(Object.freeze(parsed.data));
}
