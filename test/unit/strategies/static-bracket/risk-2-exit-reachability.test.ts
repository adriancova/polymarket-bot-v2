/**
 * `RISK-2` — the two `static-bracket` defects that kept a protective exit off
 * the venue even after the risk seam started approving it.
 *
 * GOV-2B blocker B2 was the first gate: `packages/risk` classified every
 * `POSITION` as an `ENTRY`, so the protective exits were refused
 * `RISK_EDGE_INPUTS_MISSING` and nothing downstream of the risk engine had ever
 * executed. Fixing B2 (consumer-side, in `packages/risk`) exposed two further
 * defects in THIS package, each of which independently prevented a realized
 * round trip. Both are pinned here, and each row fails against the base source.
 *
 * 1. THE EXITS NAMED NO VENUE ORDER TYPE. A composition root resolves
 *    time-in-force from the `sb.order-type:` tag first and the instance's
 *    configured `immediate_order_type` second. Only the ENTRY carried the tag,
 *    so a `MAKER_ONLY` take-profit — which §9.10 plans `REST` — inherited the
 *    entry's `FAK`, and a FAK order cannot rest (venue report §2.3). The
 *    simulated venue refused the submission outright
 *    (`SIMULATED_VENUE_PLAN_UNSUPPORTED`).
 *
 * 2. `legBaselineShares` WAS DERIVED FROM A VIEW THAT LEADS THE FILL STREAM.
 *    It was written at the first `onFill` as `held − allocated`. `WP-220`
 *    obligation 3 requires the position view to include the fill an `onFill` is
 *    about "and, if two fills arrive together, both of them", so on a batched
 *    harvest the view holds the WHOLE batch while `allocated` counts one fill.
 *    The baseline came out high by the difference, `legExposure` was understated
 *    forever, and `positionAgrees` — which demands equality — refused the
 *    protective reduction and PAUSED the instance holding a position it could no
 *    longer exit.
 *
 * Neither fix reads a tag as a disposition, and neither changes a risk verdict:
 * `packages/risk` decides disposition from the parsed intent shape and the
 * portfolio view alone.
 */

import { describe, expect, it } from "vitest";

import type { Intent } from "../../../../packages/domain/src/index.js";
import {
  REASONS,
  TAGS,
  orderTypeTag,
  staticBracketParamsSchema,
  staticBracketStrategy,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import type { StaticBracketState } from "../../../../packages/strategies/static-bracket/src/index.js";
import { configWith, context, parsedParams, stateWith, T_NOW } from "./helpers.js";

const params = () => parsedParams(staticBracketParamsSchema);

const NOW_MS = Date.parse(T_NOW);

const ARMED = stateWith({ instanceState: "ARMED" });

function positionIntents(decision: { readonly intents: readonly Intent[] }): Intent[] {
  return decision.intents.filter((intent) => intent.type === "POSITION");
}

function tagsOf(intent: Intent): readonly string[] {
  return intent.type === "POSITION" ? intent.tags : [];
}

/** An OPEN bracket holding `allocated` of YES, entered at 0.35. */
function openBracket(overrides: Partial<StaticBracketState> = {}): StaticBracketState {
  return stateWith({
    instanceState: "OPEN",
    legOutcome: "YES",
    legBaselineShares: "0",
    allocatedShares: "50",
    allocatedCost: "17.5",
    entriesExecuted: 1,
    openedAtMs: NOW_MS - 1000,
    ...overrides,
  });
}

describe("RISK-2 defect 1 — every exit names the venue order type it needs", () => {
  it("the take-profit carries sb.order-type:GTC", () => {
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openBracket(), { yesShares: "50" }),
    );
    const exits = positionIntents(decision);
    expect(exits).toHaveLength(1);
    expect(tagsOf(exits[0] as Intent)).toContain(TAGS.takeProfit);
    // A `MAKER_ONLY` take-profit is planned REST, and FAK — the value the
    // entry's `immediate_order_type` would have supplied — cannot rest.
    expect(tagsOf(exits[0] as Intent)).toContain(orderTypeTag("GTC"));
    expect(tagsOf(exits[0] as Intent)).not.toContain(orderTypeTag("FAK"));
  });

  it("the protected reduction carries sb.order-type:GTC", () => {
    // Inside `exit_cutoff_before_close_seconds` of the close, with
    // `final_policy: PROTECTED_REDUCE` and nothing resting to withdraw.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openBracket(), {
        yesShares: "50",
        now: "2026-03-04T12:14:50.000Z",
      }),
    );
    expect(decision.reasonCodes).toContain(REASONS.finalProtectedReduce);
    const exits = positionIntents(decision);
    expect(exits).toHaveLength(1);
    expect(tagsOf(exits[0] as Intent)).toContain(TAGS.protectedReduce);
    expect(tagsOf(exits[0] as Intent)).toContain(orderTypeTag("GTC"));
  });

  it("the ENTRY still names the CONFIGURED immediate order type — unchanged", () => {
    // The fix is that an exit states its OWN order type, not that the entry's
    // configuration stopped mattering. `baseConfig()` configures `FAK`.
    const decision = staticBracketStrategy.onFeatures(context(params(), ARMED, {}));
    expect(decision.decisionType).toBe("enter");
    const entries = positionIntents(decision);
    expect(entries).toHaveLength(1);
    expect(tagsOf(entries[0] as Intent)).toContain(TAGS.entry);
    expect(tagsOf(entries[0] as Intent)).toContain(orderTypeTag("FAK"));
  });

  it("the order-type tag is not a disposition signal: it rides beside the existing tags", () => {
    // The tag channel is time-in-force only. The tags that name WHAT the intent
    // is are untouched, so `apps/trader`'s `refusedExits` counter and the
    // strategy's own `protectedReductions` filter still read what they read.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openBracket(), { yesShares: "50" }),
    );
    const tags = tagsOf(positionIntents(decision)[0] as Intent);
    expect(tags).toEqual([TAGS.strategy, TAGS.takeProfit, "sb.leg:YES", orderTypeTag("GTC")]);
  });
});

describe("RISK-2 defect 2 — legBaselineShares is OBSERVED at plan time, not derived at the fill", () => {
  it("planning the entry records the inventory the bracket starts from", () => {
    // `risk.maximum_position_shares` is raised because the §13.2 example caps
    // the projected position at exactly the entry size, which refuses any
    // bracket opened over pre-existing inventory. The cap is what is relaxed
    // here, not the baseline rule under test.
    const withInventory = parsedParams(
      staticBracketParamsSchema,
      configWith({ "risk.maximum_position_shares": "100" }),
    );
    const decision = staticBracketStrategy.onFeatures(
      context(withInventory, ARMED, { yesShares: "17" }),
    );
    expect(decision.decisionType).toBe("enter");
    const patch = decision.statePatch as Record<string, unknown>;
    // Observed, with no subtraction: the bracket has filled nothing yet, so
    // everything the instance's own view holds of this leg is pre-existing.
    expect(patch["legBaselineShares"]).toBe("17");
  });

  it("a bracket over an empty book records a zero baseline", () => {
    const decision = staticBracketStrategy.onFeatures(context(params(), ARMED, {}));
    const patch = decision.statePatch as Record<string, unknown>;
    expect(patch["legBaselineShares"]).toBe("0");
  });

  it("A BATCHED FIRST FILL NO LONGER CORRUPTS IT — the B2-masked trap", () => {
    // The exact shape the paper end-to-end scenario produces: one 50-share
    // entry fills 30 then 20 in a SINGLE harvest, so the first `onFill` is
    // delivered 30 while the position view already holds all 50.
    const planned = staticBracketStrategy.onFeatures(context(params(), ARMED, {}));
    const afterPlan = planned.statePatch as unknown as StaticBracketState;

    const firstFill = staticBracketStrategy.onFill(
      context(params(), afterPlan, { yesShares: "50" }),
      {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "BUY",
        price: "0.34",
        shares: "30",
        filledAt: T_NOW,
      } as never,
    );
    const afterFirst = firstFill.statePatch as unknown as StaticBracketState;

    // The derivation this replaced computed `50 − 30 = 20` here and froze it.
    expect(afterFirst.legBaselineShares).toBe("0");
    expect(afterFirst.allocatedShares).toBe("30");

    const secondFill = staticBracketStrategy.onFill(
      context(params(), afterFirst, { yesShares: "50" }),
      {
        orderId: "order-1",
        marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
        outcome: "YES",
        side: "BUY",
        price: "0.35",
        shares: "20",
        filledAt: T_NOW,
      } as never,
    );
    const afterSecond = secondFill.statePatch as unknown as StaticBracketState;
    expect(afterSecond.legBaselineShares).toBe("0");
    expect(afterSecond.allocatedShares).toBe("50");
  });

  it("…and the protective reduction the corruption trapped is now EMITTED", () => {
    // The consequence, end to end through this package: with the baseline
    // correct, `positionAgrees` holds (exposure 50 == open 50) and the exit
    // cutoff produces a reduction. With the old `held − allocated`, exposure
    // read 30 against an open 50 and this decision was
    // `SB.POSITION_MISMATCH` / `SB.NO_BLIND_FLATTEN` / `SB.PAUSED`.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openBracket({ legBaselineShares: "0" }), {
        yesShares: "50",
        now: "2026-03-04T12:14:50.000Z",
      }),
    );
    expect(decision.reasonCodes).toContain(REASONS.finalProtectedReduce);
    expect(decision.reasonCodes).not.toContain(REASONS.positionMismatch);
    expect(decision.reasonCodes).not.toContain(REASONS.noBlindFlatten);
    expect(positionIntents(decision)).toHaveLength(1);
  });

  it("the corrupted baseline STILL refuses — the gate that caught it is intact", () => {
    // Discrimination: the fix removes the cause, not the gate. A state that
    // really does disagree with its confirmed allocation is still refused, so
    // §6 invariant 12's "no blind flatten" has not been relaxed.
    const decision = staticBracketStrategy.onFeatures(
      context(params(), openBracket({ legBaselineShares: "20" }), {
        yesShares: "50",
        now: "2026-03-04T12:14:50.000Z",
      }),
    );
    expect(decision.reasonCodes).toContain(REASONS.positionMismatch);
    expect(decision.reasonCodes).toContain(REASONS.noBlindFlatten);
    expect(positionIntents(decision)).toHaveLength(0);
  });
});
