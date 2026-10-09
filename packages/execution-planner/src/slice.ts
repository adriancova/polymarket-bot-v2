/**
 * Order slicing — §9.10 "Slice orders".
 *
 * A leg of `totalShares` becomes at most {@link MAX_PLAN_SLICES} planned
 * orders of at most `maxSliceShares` each, all sized with exact decimal
 * arithmetic (`tick.ts` `sliceDivision`, BigInt over scaled integers):
 *
 * - **slicing is on the venue's grid** (ADR-034 D2.2): the total is the
 *   leg's EXECUTABLE quantity, already floored by the quantizer
 *   (`quantity.ts`), and a total that is not on the grid of the market's tick
 *   size fails closed (`PLAN_SLICING_INCOHERENT`; it would mean a second,
 *   unquantized path). A policy whose `maxSliceShares` is off that grid
 *   refuses (`PLAN_SLICING_INCOHERENT`): every full slice it produces would
 *   be off the grid. An unknown tick size refuses
 *   (`PLAN_TICK_SIZE_UNSUPPORTED`). On-grid inputs give on-grid slices,
 *   remainders and folds, since the grid is closed under subtraction and
 *   addition;
 * - a total below the market's `minimumOrderSize` refuses
 *   (`PLAN_BELOW_MINIMUM_ORDER_SIZE`; D2.3's check, `checkMinimumOrderSize`)
 *   — the venue would reject it, and a smaller intent is the strategy's
 *   decision, not this package's;
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

import { checkMinimumOrderSize, isOnSizeGrid, sizeGridFor } from "./quantity.js";
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
  tickSize: string,
): SliceResult {
  const grid = sizeGridFor(tickSize);
  if (grid === undefined) {
    return {
      ok: false,
      refusal: plannerRefusal(
        "PLAN_TICK_SIZE_UNSUPPORTED",
        "the market's tick size is not in the venue's documented precision table, so its order grid is unknown (ADR-034 D2.1)",
        { tickSize },
      ),
    };
  }
  if (!isOnSizeGrid(totalShares, tickSize)) {
    return {
      ok: false,
      refusal: plannerRefusal(
        "PLAN_SLICING_INCOHERENT",
        "the executable size is off the venue's grid; only the quantizer's floored quantity may be sliced (ADR-034 D2.2; fail closed)",
        { totalShares, grid },
      ),
    };
  }
  if (!isOnSizeGrid(maxSliceShares, tickSize)) {
    return {
      ok: false,
      refusal: plannerRefusal(
        "PLAN_SLICING_INCOHERENT",
        "the slicing policy's maxSliceShares is off the venue's grid; every full slice it produced would be unexecutable as planned (ADR-034 D2.2)",
        { maxSliceShares, grid },
      ),
    };
  }
  const minimum = checkMinimumOrderSize({ kind: "SHARES", executableShares: totalShares }, minimumOrderSize, tickSize);
  if (!minimum.ok) {
    return {
      ok: false,
      refusal:
        minimum.refusals[0] ??
        plannerRefusal("PLAN_BELOW_MINIMUM_ORDER_SIZE", "the minimum order size check failed (fail closed)", { totalShares, minimumOrderSize }),
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
