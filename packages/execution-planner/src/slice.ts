/**
 * Order slicing — §9.10 "Slice orders".
 *
 * A leg of `totalShares` becomes at most {@link MAX_PLAN_SLICES} planned
 * orders of at most `maxSliceShares` each, all sized with exact decimal
 * arithmetic (`tick.ts` `sliceDivision`, BigInt over scaled integers):
 *
 * - a total below the market's `minimumOrderSize` refuses
 *   (`PLAN_BELOW_MINIMUM_ORDER_SIZE`) — the venue would reject it, and a
 *   smaller intent is the strategy's decision, not this package's;
 * - a policy whose `maxSliceShares` is below the market's minimum refuses
 *   (`PLAN_SLICING_INCOHERENT`): every slice it produces would be
 *   unplaceable;
 * - a remainder smaller than the minimum order size is FOLDED into the final
 *   slice (that slice then exceeds `maxSliceShares` by less than one
 *   minimum) rather than dropped — dropping would silently downsize the
 *   intent, and emitting it would plan an unplaceable order. The fold is the
 *   only place a slice may exceed the policy bound, and the sum of slices
 *   ALWAYS equals `totalShares` exactly;
 * - more than {@link MAX_PLAN_SLICES} slices refuses
 *   (`PLAN_SLICING_INCOHERENT`): a plan is an instruction an operator can
 *   read, not an unbounded order stream, and an absurd count is a mis-sized
 *   policy, not a plan.
 *
 * Depth-aware participation capping (WP-180 `known_risks` 4 hands it to this
 * package) needs per-level book depth the planning inputs do not yet carry;
 * it is recorded as an explicit follow-up in `docs/handoffs/WP-190.md`
 * rather than half-built against a top-of-book number that does not mean
 * depth.
 */

import { addDecimal, compareDecimal } from "@polymarket-bot/decimal";

import { plannerRefusal, type PlannerRefusal } from "./refusals.js";
import { sliceDivision } from "./tick.js";

/** The most planned orders one leg may produce. */
export const MAX_PLAN_SLICES = 100;

export type SliceResult =
  | { readonly ok: true; readonly sizes: readonly string[] }
  | { readonly ok: false; readonly refusal: PlannerRefusal };

export function sliceShares(
  totalShares: string,
  maxSliceShares: string,
  minimumOrderSize: string,
): SliceResult {
  if (compareDecimal(totalShares, minimumOrderSize) < 0) {
    return {
      ok: false,
      refusal: plannerRefusal(
        "PLAN_BELOW_MINIMUM_ORDER_SIZE",
        "the executable size is below the market's minimum order size; the venue would reject it, and resizing the intent is not this package's decision",
        { totalShares, minimumOrderSize },
      ),
    };
  }
  if (compareDecimal(maxSliceShares, minimumOrderSize) < 0) {
    return {
      ok: false,
      refusal: plannerRefusal(
        "PLAN_SLICING_INCOHERENT",
        "the slicing policy's maxSliceShares is below the market's minimum order size; every slice it produces would be unplaceable",
        { maxSliceShares, minimumOrderSize },
      ),
    };
  }
  const division = sliceDivision(totalShares, maxSliceShares);
  if (division === undefined) {
    return {
      ok: false,
      refusal: plannerRefusal(
        "PLAN_SLICING_INCOHERENT",
        "the slice sizes could not be computed exactly (fail closed)",
        { totalShares, maxSliceShares },
      ),
    };
  }
  const remainderIsZero = compareDecimal(division.remainder, "0") === 0;
  const sliceCount = division.fullSlices + (remainderIsZero ? 0n : 1n);
  if (sliceCount > BigInt(MAX_PLAN_SLICES)) {
    return {
      ok: false,
      refusal: plannerRefusal(
        "PLAN_SLICING_INCOHERENT",
        `slicing would produce more than ${String(MAX_PLAN_SLICES)} orders; an unbounded order stream is a mis-sized policy, not a plan`,
        { totalShares, maxSliceShares, sliceCount: sliceCount.toString() },
      ),
    };
  }

  const sizes: string[] = [];
  for (let index = 0n; index < division.fullSlices; index += 1n) {
    sizes.push(maxSliceShares);
  }
  if (!remainderIsZero) {
    if (compareDecimal(division.remainder, minimumOrderSize) < 0 && sizes.length > 0) {
      // FOLD (module header): the venue-unplaceable remainder joins the final
      // full slice, so the sum still equals totalShares exactly.
      const last = sizes[sizes.length - 1];
      if (last !== undefined) {
        sizes[sizes.length - 1] = addDecimal(last, division.remainder);
      }
    } else {
      sizes.push(division.remainder);
    }
  }
  return { ok: true, sizes };
}
