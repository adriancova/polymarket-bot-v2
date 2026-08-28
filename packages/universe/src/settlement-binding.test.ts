/**
 * The settlement port is pinned here.
 *
 * The token list mirrors `@polymarket-bot/settlement`'s activation vocabulary,
 * which this package deliberately does not import (same layer, no §2.1 edge —
 * see `settlement-binding.ts`). Pinning it means a change on either side is a
 * deliberate edit here plus a type error at the composition root that wires the
 * two, rather than a silent divergence.
 */

import { describe, expect, it } from "vitest";

import {
  ACTIVATION_PERMITTED_STATUS,
  SETTLEMENT_ACTIVATION_STATUSES,
  isConsistentSettlementActivation,
} from "./settlement-binding.js";
import { permittingSettlementView, unverifiedSettlementView } from "./testing/index.js";

describe("settlement activation port", () => {
  it("pins the status vocabulary", () => {
    expect([...SETTLEMENT_ACTIVATION_STATUSES]).toEqual([
      "REVIEWED_MODEL_BACKED",
      "SPEC_MISSING",
      "SPEC_INVALID",
      "SPEC_NO_PAYOFF_MODEL",
      "SPEC_UNVERIFIED",
      "SPEC_REJECTED",
      "SPEC_VERIFICATION_UNSOUND",
    ]);
  });

  it("permits exactly one status", () => {
    expect(ACTIVATION_PERMITTED_STATUS).toBe("REVIEWED_MODEL_BACKED");
    expect(SETTLEMENT_ACTIVATION_STATUSES.filter((status) => status === ACTIVATION_PERMITTED_STATUS)).toHaveLength(
      1,
    );
  });

  it("accepts a self-consistent verdict", () => {
    expect(isConsistentSettlementActivation(permittingSettlementView())).toBe(true);
    expect(isConsistentSettlementActivation(unverifiedSettlementView())).toBe(true);
  });

  it("rejects a verdict whose flag and status disagree, in either direction", () => {
    expect(
      isConsistentSettlementActivation(
        permittingSettlementView({ modelDependentActivationAllowed: false }),
      ),
    ).toBe(false);
    expect(
      isConsistentSettlementActivation({
        ...unverifiedSettlementView(),
        modelDependentActivationAllowed: true,
      }),
    ).toBe(false);
  });
});
