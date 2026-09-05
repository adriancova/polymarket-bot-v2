/**
 * Acceptance-coupled oracles built on a DIFFERENT PRIMITIVE.
 *
 * The strategy computes with `decimal.js` through `@polymarket-bot/decimal`'s
 * canonical-string API. Every expectation in this file is computed instead with
 * exact `BigInt` rationals — scaled integers, no library, no strings until the
 * final rendering — so an error inside the decimal layer, inside this package's
 * use of it, or inside a hand-written expected value cannot agree with itself.
 *
 * What is oracled:
 *
 * - the proportional exit size (§13.3 rule 1) over randomised-but-seeded fill
 *   sequences;
 * - the exact entry cost of walking the book;
 * - the fee-aware expected net edge;
 * - the YES/NO economic-leg comparison;
 * - the book-participation allowance.
 */

import { describe, expect, it } from "vitest";

import type { Intent } from "../../../../packages/domain/src/index.js";
import {
  staticBracketParamsSchema,
  staticBracketStrategy,
  type StaticBracketState,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import {
  MARKET_ID,
  T_NOW,
  TRIGGER_KEY,
  configWith,
  context,
  parsedParams,
  stateWith,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// The oracle: exact rationals as scaled BigInts
// ---------------------------------------------------------------------------

interface Rational {
  readonly units: bigint;
  readonly scale: number;
}

function rational(text: string): Rational {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const point = body.indexOf(".");
  const digits = point < 0 ? body : body.slice(0, point) + body.slice(point + 1);
  const scale = point < 0 ? 0 : body.length - point - 1;
  const units = BigInt(digits) * (negative ? -1n : 1n);
  return { units, scale };
}

function align(a: Rational, b: Rational): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * 10n ** BigInt(scale - a.scale),
    b: b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

function plus(a: Rational, b: Rational): Rational {
  const aligned = align(a, b);
  return { units: aligned.a + aligned.b, scale: aligned.scale };
}

function minus(a: Rational, b: Rational): Rational {
  const aligned = align(a, b);
  return { units: aligned.a - aligned.b, scale: aligned.scale };
}

function times(a: Rational, b: Rational): Rational {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

function cmp(a: Rational, b: Rational): number {
  const aligned = align(a, b);
  return aligned.a === aligned.b ? 0 : aligned.a < aligned.b ? -1 : 1;
}

/** Renders a rational in the repository's canonical decimal form. */
function canonical(value: Rational): string {
  const negative = value.units < 0n;
  let digits = (negative ? -value.units : value.units).toString();
  if (value.scale === 0) {
    return `${negative && digits !== "0" ? "-" : ""}${digits}`;
  }
  digits = digits.padStart(value.scale + 1, "0");
  const whole = digits.slice(0, digits.length - value.scale);
  let fraction = digits.slice(digits.length - value.scale);
  fraction = fraction.replace(/0+$/u, "");
  const magnitude = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  const trimmed = magnitude.replace(/^0+(?=\d)/u, "");
  return `${negative && !/^0(\.0*)?$/u.test(trimmed) ? "-" : ""}${trimmed}`;
}

describe("the oracle itself is exact", () => {
  it("round-trips canonical decimals", () => {
    for (const text of ["0", "1", "0.35", "17.5", "-2.55", "0.001", "1000000.000001"]) {
      expect(canonical(rational(text))).toBe(text);
    }
  });

  it("computes with integers, not floats", () => {
    // 0.1 + 0.2 is the canonical demonstration that the primitives differ.
    expect(canonical(plus(rational("0.1"), rational("0.2")))).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(canonical(times(rational("0.35"), rational("50")))).toBe("17.5");
  });
});

// ---------------------------------------------------------------------------
// Oracled acceptance criteria
// ---------------------------------------------------------------------------

function params(config = configWith({})) {
  return parsedParams(staticBracketParamsSchema, config);
}

function fill(shares: string, price = "0.35"): Record<string, unknown> {
  return {
    orderId: "order-1",
    marketId: MARKET_ID,
    outcome: "YES",
    side: "BUY",
    price,
    shares,
    filledAt: T_NOW,
  };
}

function workingEntry(filledShares: string): StaticBracketState {
  return stateWith({
    instanceState: filledShares === "0" ? "ENTRY_WORKING" : "PARTIALLY_OPEN",
    legOutcome: "YES",
    allocatedShares: filledShares,
    allocatedCost: canonical(times(rational(filledShares), rational("0.35"))),
    entriesExecuted: filledShares === "0" ? 0 : 1,
    openedAtMs: filledShares === "0" ? null : 1,
    entryOrder: {
      kind: "ENTRY",
      intentId: "sb-entry-0",
      orderId: "order-1",
      state: "WORKING",
      outcome: "YES",
      side: "BUY",
      limitPrice: "0.35",
      requestedShares: "50",
      filledShares,
      viewFilledShares: filledShares,
      placedAtMs: 1,
      escalated: true,
    },
  });
}

describe("acceptance 1 — the proportional exit equals the exact allocation", () => {
  /**
   * A deterministic pseudo-random fill sequence: a small LCG seeded by a
   * constant, so the case set is varied but the run is reproducible (no
   * `Math.random`, per the strategy's own purity rules).
   */
  function sequences(): string[][] {
    let seed = 20260305;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const built: string[][] = [];
    for (let index = 0; index < 12; index += 1) {
      const parts: string[] = [];
      let remaining = 50;
      while (remaining > 0 && parts.length < 5) {
        const take = (next() % Math.min(remaining, 17)) + 1;
        parts.push(String(take));
        remaining -= take;
      }
      built.push(parts);
    }
    return built;
  }

  it("sizes every take-profit at the exact sum of confirmed fills, never the requested size", () => {
    for (const sequence of sequences()) {
      let allocated = rational("0");
      let state = workingEntry("0");
      for (const shares of sequence) {
        allocated = plus(allocated, rational(shares));
        const held = canonical(allocated);
        const decision = staticBracketStrategy.onFill(
          context(params(), state, { yesShares: held }),
          fill(shares) as never,
        );
        const patch = decision.statePatch as Record<string, unknown> | undefined;
        expect(patch, "every fill must record its allocation").toBeDefined();
        expect(patch?.["allocatedShares"]).toBe(held);
        const exits = decision.intents.filter(
          (intent): intent is Extract<Intent, { type: "POSITION" }> => intent.type === "POSITION",
        );
        if (exits.length > 0) {
          expect(exits[0]?.targetShares).toBe(`-${held}`);
        }
        state = { ...state, ...(patch as Partial<StaticBracketState>) } as StaticBracketState;
        if (cmp(allocated, rational("50")) >= 0) break;
      }
    }
  });
});

describe("the entry economics, oracled", () => {
  it("prices the book walk exactly", () => {
    // Two ask levels are consumed: 30 at 0.34 and 20 at 0.35.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), stateWith({ instanceState: "ARMED" }), {
        yes: {
          bids: [["0.33", "500"]],
          asks: [
            ["0.34", "30"],
            ["0.35", "2000"],
          ],
        },
        features: { [TRIGGER_KEY]: "0.34" },
      }),
    );
    const expected = plus(
      times(rational("30"), rational("0.34")),
      times(rational("20"), rational("0.35")),
    );
    expect(decision.modelOutputs?.["entryCost"]).toBe(canonical(expected));
    expect(canonical(expected)).toBe("17.2");
  });

  it("computes the expected net edge exactly, over a grid of fee rates", () => {
    const size = rational("50");
    const takeProfit = rational("0.5");
    const cost = times(size, rational("0.35"));
    for (const feeText of ["0", "0.001", "0.01", "0.129", "0.1291"]) {
      const config = configWith({
        "entry.economics.entry_fee_per_share": feeText,
        "entry.economics.exit_fee_per_share": "0",
        "entry.economics.minimum_expected_net_edge": "0",
      });
      const decision = staticBracketStrategy.onFeatures(
        context(params(config), stateWith({ instanceState: "ARMED" }), {}),
      );
      const expected = minus(minus(times(takeProfit, size), cost), times(rational(feeText), size));
      const intent = decision.intents.find(
        (candidate): candidate is Extract<Intent, { type: "POSITION" }> =>
          candidate.type === "POSITION",
      );
      expect(intent?.expectedNetEdge, `fee ${feeText}`).toBe(canonical(expected));
    }
  });

  it("refuses exactly when the oracle says the edge is below the configured minimum", () => {
    const size = rational("50");
    const gross = minus(times(rational("0.5"), size), times(size, rational("0.35")));
    for (const feeText of ["0.1289", "0.129", "0.1291", "0.13"]) {
      const config = configWith({
        "entry.economics.entry_fee_per_share": feeText,
        "entry.economics.exit_fee_per_share": "0.001",
        "entry.economics.minimum_expected_net_edge": "1",
      });
      const edge = minus(gross, times(plus(rational(feeText), rational("0.001")), size));
      const sufficient = cmp(edge, rational("1")) >= 0;
      const decision = staticBracketStrategy.onFeatures(
        context(params(config), stateWith({ instanceState: "ARMED" }), {}),
      );
      expect(decision.decisionType, `fee ${feeText} -> edge ${canonical(edge)}`).toBe(
        sufficient ? "enter" : "hold",
      );
    }
  });

  it("chooses the leg the oracle says is cheaper, at and either side of the tie", () => {
    const size = rational("50");
    const directCost = times(size, rational("0.35"));
    for (const bid of ["0.6", "0.64", "0.65", "0.66", "0.7"]) {
      const proceeds = times(size, rational(bid));
      const complementCost = minus(size, proceeds);
      const complementIsCheaper = cmp(complementCost, directCost) < 0;
      const decision = staticBracketStrategy.onFeatures(
        context(
          params(configWith({ "entry.economic_leg_policy": "PREFER_CHEAPEST_WITH_INVENTORY" })),
          stateWith({ instanceState: "ARMED" }),
          {
            noShares: "100",
            no: { bids: [[bid, "2000"]], asks: [["0.99", "2000"]] },
          },
        ),
      );
      const intent = decision.intents.find(
        (candidate): candidate is Extract<Intent, { type: "POSITION" }> =>
          candidate.type === "POSITION",
      );
      expect(
        intent?.direction,
        `bid ${bid}: direct ${canonical(directCost)} vs complement ${canonical(complementCost)}`,
      ).toBe(complementIsCheaper ? "NO" : "YES");
    }
  });

  /**
   * SLIPPAGE IS MEASURED AGAINST ONE REFERENCE ON BOTH LEGS.
   *
   * `LegQuote.cost` is YES-equivalent money on both legs (`size - proceeds` on
   * the complement), so the reference is `trigger_price_lte * size` for both.
   * Complementing the reference for the SELL leg mixed a direction-denominated
   * cost with a complement-denominated price, and made an identically-priced
   * complement leg pass a cap the direct leg failed.
   *
   * The oracle here is the sell-leg measure written out longhand —
   * `(1 - t) * size - proceeds` — which must equal `cost - t * size` exactly.
   */
  it("measures identically-priced legs identically: one refuses ⇒ both refuse", () => {
    const size = rational("50");
    const trigger = rational("0.35");
    const cap = rational("1");
    const referenceCost = times(trigger, size);

    // maximum_buy_price 0.4 gives a complement floor of 0.6, so a 0.61 bid is
    // deep enough to clear the participation cap and the walk is a single level.
    const wide = (leg: string) =>
      configWith({
        "entry.economic_leg_policy": leg,
        "entry.maximum_total_cost": "25",
        "risk.maximum_contractual_loss": "25",
        "entry.execution.maximum_buy_price": "0.4",
        "entry.execution.passive_price": "0.4",
      });

    for (const bid of ["0.59", "0.6", "0.61", "0.65"]) {
      const proceeds = times(size, rational(bid));
      const complementCost = minus(size, proceeds);
      // The longhand sell-leg measure and the reduced one must agree exactly.
      const longhand = minus(times(minus(rational("1"), trigger), size), proceeds);
      const reduced = minus(complementCost, referenceCost);
      expect(canonical(longhand), `bid ${bid}`).toBe(canonical(reduced));

      const slippage = cmp(reduced, rational("0")) <= 0 ? rational("0") : reduced;
      const withinCap = cmp(slippage, cap) <= 0;

      // The DIRECT leg priced to the very same cost: a single ask level whose
      // total is `complementCost` for the same 50 shares.
      const askPrice = canonical({
        units: (complementCost.units * 10n ** BigInt(4 - complementCost.scale)) / 50n,
        scale: 4,
      });
      const direct = staticBracketStrategy.onFeatures(
        context(params(wide("DIRECT_ONLY")), stateWith({ instanceState: "ARMED" }), {
          yes: { bids: [["0.34", "2000"]], asks: [[askPrice, "2000"]] },
        }),
      );
      const complementLeg = staticBracketStrategy.onFeatures(
        context(
          params(wide("PREFER_CHEAPEST_WITH_INVENTORY")),
          stateWith({ instanceState: "ARMED" }),
          {
            noShares: "100",
            // The direct leg is too thin to fill, so the complement is taken.
            yes: { bids: [["0.34", "2000"]], asks: [[askPrice, "10"]] },
            no: { bids: [[bid, "2000"]], asks: [["0.99", "2000"]] },
          },
        ),
      );

      const label = `bid ${bid}: cost ${canonical(complementCost)}, slippage ${canonical(slippage)}`;
      expect(direct.decisionType, `direct ${label}`).toBe(withinCap ? "enter" : "hold");
      expect(complementLeg.decisionType, `complement ${label}`).toBe(withinCap ? "enter" : "hold");
      if (!withinCap) {
        expect(direct.modelOutputs?.["slippage"], `direct ${label}`).toBe(canonical(slippage));
        expect(complementLeg.modelOutputs?.["slippage"], `complement ${label}`).toBe(
          canonical(slippage),
        );
      }
    }
  });

  it("applies the participation cap at exactly the oracle's boundary", () => {
    const participation = rational("0.05");
    for (const depth of ["999", "1000", "1001"]) {
      const allowed = times(participation, rational(depth));
      const permits = cmp(rational("50"), allowed) <= 0;
      const decision = staticBracketStrategy.onFeatures(
        context(params(), stateWith({ instanceState: "ARMED" }), {
          yes: { bids: [["0.33", "500"]], asks: [["0.35", depth]] },
        }),
      );
      expect(
        decision.decisionType,
        `depth ${depth}: allowed ${canonical(allowed)} shares`,
      ).toBe(permits ? "enter" : "hold");
    }
  });
});
