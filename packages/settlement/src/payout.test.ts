import { addDecimal, mulDecimal, normalizeDecimalString } from "@polymarket-bot/decimal";
import { MarketOutcomeStateSchema } from "@polymarket-bot/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  LOSING_TOKEN_PAYOUT_PER_SHARE,
  SPLIT_50_50_PAYOUT_PER_SHARE,
  WINNING_TOKEN_PAYOUT_PER_SHARE,
  payoutPerShare,
  positionSettlementValue,
  settlementValue,
} from "./payout.js";

function digits(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength, maxLength })
    .map((values) => values.join(""));
}

/** Canonical non-negative decimal share counts, up to six fractional digits. */
const shareCounts = fc
  .tuple(digits(1, 12), digits(0, 6))
  .map(([integer, fraction]) => normalizeDecimalString(`${integer}.${fraction}`));

describe("payoutPerShare", () => {
  it("pays the winner $1 and the loser $0 (resolution doc, 2026-08-28)", () => {
    expect(payoutPerShare("YES_WIN")).toEqual({ ok: true, value: { yes: "1", no: "0" } });
    expect(payoutPerShare("NO_WIN")).toEqual({ ok: true, value: { yes: "0", no: "1" } });
    expect(WINNING_TOKEN_PAYOUT_PER_SHARE).toBe("1");
    expect(LOSING_TOKEN_PAYOUT_PER_SHARE).toBe("0");
  });

  it("pays each token exactly $0.50 on a 50/50 resolution (acceptance 2)", () => {
    // "Market resolves 50/50 — each token redeems for $0.50"
    // https://docs.polymarket.com/concepts/resolution (accessed 2026-08-28)
    expect(payoutPerShare("SPLIT_50_50")).toEqual({ ok: true, value: { yes: "0.5", no: "0.5" } });
    expect(SPLIT_50_50_PAYOUT_PER_SHARE).toBe("0.5");
  });

  it("refuses to invent a cancellation payout", () => {
    const result = payoutPerShare("CANCELLED");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED",
      ]);
    }
  });

  it.each(["DISPUTED", "PENDING", "PENDING_CLARIFICATION"] as const)(
    "refuses a payoff for the non-terminal state %s (ADR-009 §4)",
    (outcome) => {
      const result = payoutPerShare(outcome);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusals[0]?.code).toBe("SETTLEMENT_OUTCOME_NOT_TERMINAL");
      }
    },
  );

  it("answers every outcome state in the frozen vocabulary", () => {
    for (const outcome of MarketOutcomeStateSchema.options) {
      expect(() => payoutPerShare(outcome)).not.toThrow();
    }
  });

  it("returns frozen payouts that a caller cannot edit", () => {
    const result = payoutPerShare("SPLIT_50_50");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });
});

describe("settlementValue", () => {
  it("multiplies exactly", () => {
    expect(settlementValue("50", "0.5")).toBe("25");
    expect(settlementValue("0.1", "0.5")).toBe("0.05");
    // 3 × 0.5 is 1.5 exactly; a float pipeline that rounded to cents would say 1.5 too,
    // so the interesting case is one binary floating point cannot hold:
    expect(settlementValue("0.3", "0.5")).toBe("0.15");
    expect(settlementValue("1234567890123456789", "0.5")).toBe("617283945061728394.5");
  });

  it("refuses a negative share count", () => {
    expect(() => settlementValue("-1", "0.5")).toThrow(TypeError);
  });

  it("refuses a non-canonical share count", () => {
    expect(() => settlementValue("1.50", "0.5")).toThrow(TypeError);
    expect(() => settlementValue("1e3", "0.5")).toThrow(TypeError);
  });

  it("refuses a JavaScript number", () => {
    expect(() => settlementValue(50 as unknown as string, "0.5")).toThrow();
  });
});

describe("positionSettlementValue", () => {
  it("values each side of a 50/50 market at half the share count", () => {
    expect(positionSettlementValue("SPLIT_50_50", "YES", "50")).toEqual({
      ok: true,
      value: "25",
    });
    expect(positionSettlementValue("SPLIT_50_50", "NO", "50")).toEqual({ ok: true, value: "25" });
  });

  it("values a winning and a losing side", () => {
    expect(positionSettlementValue("YES_WIN", "YES", "50")).toEqual({ ok: true, value: "50" });
    expect(positionSettlementValue("YES_WIN", "NO", "50")).toEqual({ ok: true, value: "0" });
  });

  it("propagates the refusal for an undetermined payoff", () => {
    const result = positionSettlementValue("DISPUTED", "YES", "50");
    expect(result.ok).toBe(false);
  });
});

describe("payoff exactness (property)", () => {
  it("values a 50/50 position at exactly half the shares, for any share count", () => {
    fc.assert(
      fc.property(shareCounts, (shares) => {
        const value = settlementValue(shares, SPLIT_50_50_PAYOUT_PER_SHARE);
        // Exactness stated as an identity that rounding would break:
        // doubling the payout must return the original share count.
        expect(mulDecimal(value, "2")).toBe(shares);
      }),
      { numRuns: 300 },
    );
  });

  it("conserves the $1 backing of every YES/NO pair in every terminal outcome", () => {
    // "Every Yes/No pair in existence is backed by exactly $1 of pUSD collateral"
    // https://docs.polymarket.com/concepts/positions-tokens (accessed 2026-08-28)
    for (const outcome of ["YES_WIN", "NO_WIN", "SPLIT_50_50"] as const) {
      const payout = payoutPerShare(outcome);
      expect(payout.ok).toBe(true);
      if (payout.ok) {
        expect(addDecimal(payout.value.yes, payout.value.no)).toBe("1");
      }
    }
  });

  it("keeps a paired position whole for any share count and terminal outcome", () => {
    fc.assert(
      fc.property(
        shareCounts,
        fc.constantFrom("YES_WIN" as const, "NO_WIN" as const, "SPLIT_50_50" as const),
        (shares, outcome) => {
          const yes = positionSettlementValue(outcome, "YES", shares);
          const no = positionSettlementValue(outcome, "NO", shares);
          expect(yes.ok && no.ok).toBe(true);
          if (yes.ok && no.ok) {
            expect(addDecimal(yes.value, no.value)).toBe(shares);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
