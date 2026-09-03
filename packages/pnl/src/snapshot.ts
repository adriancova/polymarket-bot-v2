/**
 * The §9.16 reporting snapshot — one row per denomination asset.
 *
 * Unrealized PnL is computed HERE, at snapshot time, from open lots and
 * caller-supplied marks; it never enters the folded state, so realized and
 * unrealized cannot mix by construction. A missing midpoint mark is a typed
 * refusal — `unrealized PnL at midpoint` is a required measure and is never
 * guessed. Model and liquidation values are `null` unless a mark supplies
 * them for EVERY open lot of the denomination: a partially-marked measure is
 * not a measure.
 *
 * Formulas (recorded WP-200 decisions; the handoff lists the measures
 * without formulas):
 *
 *   realizedPnl              = realized trading PnL (fees and rewards are
 *                              their own measures, as in the §10.5 columns)
 *   grossTradingPnl          = realizedPnl + unrealizedPnlMidpoint
 *   coreNetPnl               = grossTradingPnl − feesPaid          (§6 inv. 14:
 *                              excludes rewards, realized or estimated)
 *   allInPnl                 = coreNetPnl + realizedRewards        (realized
 *                              ONLY; estimates NEVER enter any PnL figure)
 *   worstCaseResolutionPnl   = realizedPnl − Σ openCostBasis       (every open
 *                              token resolving to 0 — a sound lower bound for
 *                              a long-only inventory; shorts cannot exist
 *                              here because oversell is refused)
 *   capitalCommitted         = Σ openCostBasis + reservedCapital   (open
 *                              orders' reservations are the caller's input;
 *                              reservation lifecycles are WP-190's domain)
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { addDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import {
  IsoTimestampSchema,
  NonNegativeDecimalStringSchema,
  NonEmptyStringSchema,
  PriceStringSchema,
} from "@polymarket-bot/domain";
import { z } from "zod";

import type { PnlResult } from "./refusals.js";
import { pnlFailure, pnlOk, pnlRefusal } from "./refusals.js";
import type { PnlOwner } from "./records.js";
import type { PnlState } from "./state.js";

const ZERO: DecimalString = "0";

/** Valuation marks for one token asset. Prices are venue probabilities. */
export const PnlMarkSchema = z.strictObject({
  midpoint: PriceStringSchema,
  model: PriceStringSchema.optional(),
  liquidation: PriceStringSchema.optional(),
});

export const PnlSnapshotInputSchema = z.strictObject({
  asOf: IsoTimestampSchema,
  /** tokenAssetId -> marks. Every open lot needs at least a midpoint. */
  marks: z.record(NonEmptyStringSchema, PnlMarkSchema),
  /** denominationAsset -> reserved capital (optional caller input). */
  reservedCapital: z.record(NonEmptyStringSchema, NonNegativeDecimalStringSchema).optional(),
});

export type PnlSnapshotInput = Readonly<z.infer<typeof PnlSnapshotInputSchema>>;

/** One §10.5 `pnl_snapshots`-shaped row. All measures share one denomination. */
export interface PnlSnapshot {
  readonly owner: PnlOwner;
  readonly denominationAsset: string;
  readonly asOf: string;
  readonly grossTradingPnl: DecimalString;
  /** §6 invariant 14: excludes discretionary rewards entirely. */
  readonly coreNetPnl: DecimalString;
  /** Includes REALIZED rewards only; estimates never (§9.16). */
  readonly allInPnl: DecimalString;
  readonly realizedPnl: DecimalString;
  readonly unrealizedPnlMidpoint: DecimalString;
  readonly unrealizedPnlModel: DecimalString | null;
  readonly unrealizedPnlLiquidation: DecimalString | null;
  readonly worstCaseResolutionPnl: DecimalString;
  readonly feesPaid: DecimalString;
  readonly rewardEstimateTotal: DecimalString;
  readonly realizedRewards: DecimalString;
  readonly capitalCommitted: DecimalString;
  /** [denominationAsset, scheduleVersionRef|""] -> fees (§9.16 versioning). */
  readonly feesByScheduleVersion: Readonly<Record<string, DecimalString>>;
  readonly rewardsByProgram: Readonly<Record<string, DecimalString>>;
  readonly estimatesByProgram: Readonly<Record<string, DecimalString>>;
}

function formatIssues(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

function sortedRecordFromMap(
  map: ReadonlyMap<string, DecimalString>,
  filterKey: (key: string) => boolean,
): Readonly<Record<string, DecimalString>> {
  const record: Record<string, DecimalString> = {};
  for (const key of [...map.keys()].sort()) {
    if (filterKey(key)) {
      const value = map.get(key);
      if (value !== undefined) {
        record[key] = value;
      }
    }
  }
  return Object.freeze(record);
}

function compositeKeyBelongsTo(denomination: string): (key: string) => boolean {
  return (key) => {
    try {
      const parsed: unknown = JSON.parse(key);
      return Array.isArray(parsed) && parsed[0] === denomination;
    } catch {
      return false;
    }
  };
}

/**
 * Computes the §9.16 snapshot rows for every denomination the state has
 * touched. Denominations are NEVER summed together (ADR-006 §7).
 */
export function computePnlSnapshot(
  state: PnlState,
  input: unknown,
): PnlResult<readonly PnlSnapshot[]> {
  const parsed = PnlSnapshotInputSchema.safeParse(input);
  if (!parsed.success) {
    return pnlFailure(
      pnlRefusal("PNL_INPUT_INVALID", "the value is not a snapshot input", {
        issues: formatIssues(parsed.error),
      }),
    );
  }
  const { asOf, marks } = parsed.data;
  const reservedCapital = parsed.data.reservedCapital ?? {};

  // Per-denomination unrealized aggregation over open lots.
  const unrealizedMid = new Map<string, DecimalString>();
  const unrealizedModel = new Map<string, DecimalString>();
  const unrealizedLiquidation = new Map<string, DecimalString>();
  const modelComplete = new Map<string, boolean>();
  const liquidationComplete = new Map<string, boolean>();
  const openBasis = new Map<string, DecimalString>();

  for (const [tokenAssetId, lot] of state.lots) {
    const mark = marks[tokenAssetId];
    if (mark === undefined) {
      return pnlFailure(
        pnlRefusal(
          "PNL_MARK_MISSING",
          `open position in token ${tokenAssetId} has no midpoint mark; unrealized ` +
            "PnL at midpoint is a required measure and is never guessed (§9.16)",
          { tokenAssetId, shares: lot.shares },
        ),
      );
    }
    const denom = lot.denominationAsset;
    openBasis.set(denom, addDecimal(openBasis.get(denom) ?? ZERO, lot.costBasis));
    const midValue = subDecimal(mulDecimal(mark.midpoint, lot.shares), lot.costBasis);
    unrealizedMid.set(denom, addDecimal(unrealizedMid.get(denom) ?? ZERO, midValue));

    if (mark.model === undefined) {
      modelComplete.set(denom, false);
    } else if (modelComplete.get(denom) !== false) {
      modelComplete.set(denom, true);
      const modelValue = subDecimal(mulDecimal(mark.model, lot.shares), lot.costBasis);
      unrealizedModel.set(denom, addDecimal(unrealizedModel.get(denom) ?? ZERO, modelValue));
    }
    if (mark.liquidation === undefined) {
      liquidationComplete.set(denom, false);
    } else if (liquidationComplete.get(denom) !== false) {
      liquidationComplete.set(denom, true);
      const liquidationValue = subDecimal(
        mulDecimal(mark.liquidation, lot.shares),
        lot.costBasis,
      );
      unrealizedLiquidation.set(
        denom,
        addDecimal(unrealizedLiquidation.get(denom) ?? ZERO, liquidationValue),
      );
    }
  }

  const denominations = new Set<string>([
    ...openBasis.keys(),
    ...state.realizedTrading.keys(),
    ...state.feesPaid.keys(),
    ...state.realizedRewards.keys(),
    ...state.rewardEstimates.keys(),
  ]);

  const snapshots: PnlSnapshot[] = [];
  for (const denomination of [...denominations].sort()) {
    const realizedPnl = state.realizedTrading.get(denomination) ?? ZERO;
    const feesPaid = state.feesPaid.get(denomination) ?? ZERO;
    const realizedRewards = state.realizedRewards.get(denomination) ?? ZERO;
    const rewardEstimateTotal = state.rewardEstimates.get(denomination) ?? ZERO;
    const midpoint = unrealizedMid.get(denomination) ?? ZERO;
    const basis = openBasis.get(denomination) ?? ZERO;

    const grossTradingPnl = addDecimal(realizedPnl, midpoint);
    const coreNetPnl = subDecimal(grossTradingPnl, feesPaid);
    const allInPnl = addDecimal(coreNetPnl, realizedRewards);
    const belongs = compositeKeyBelongsTo(denomination);

    snapshots.push(
      Object.freeze({
        owner: state.owner,
        denominationAsset: denomination,
        asOf,
        grossTradingPnl,
        coreNetPnl,
        allInPnl,
        realizedPnl,
        unrealizedPnlMidpoint: midpoint,
        unrealizedPnlModel:
          modelComplete.get(denomination) === true
            ? (unrealizedModel.get(denomination) ?? ZERO)
            : null,
        unrealizedPnlLiquidation:
          liquidationComplete.get(denomination) === true
            ? (unrealizedLiquidation.get(denomination) ?? ZERO)
            : null,
        worstCaseResolutionPnl: subDecimal(realizedPnl, basis),
        feesPaid,
        rewardEstimateTotal,
        realizedRewards,
        capitalCommitted: addDecimal(basis, reservedCapital[denomination] ?? ZERO),
        feesByScheduleVersion: sortedRecordFromMap(state.feesBySchedule, belongs),
        rewardsByProgram: sortedRecordFromMap(state.rewardsByProgram, belongs),
        estimatesByProgram: sortedRecordFromMap(state.estimatesByProgram, belongs),
      }),
    );
  }

  return pnlOk(Object.freeze(snapshots));
}
