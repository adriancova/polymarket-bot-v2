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
import { appendData } from "@polymarket-bot/risk/plain-data";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";
import { z } from "zod";

import { plainFrozen } from "./immutable.js";
import type { PnlResult } from "./refusals.js";
import { contained, pnlFailure, pnlOk, pnlRefusal, readInputAsData } from "./refusals.js";
import type { PnlOwner } from "./records.js";
import type { PnlState } from "./state.js";

const ZERO: DecimalString = "0";

/**
 * The empty reserved-capital block: a FROZEN, PROTOTYPE-FREE record.
 *
 * See {@link computePnlSnapshot}. `{}` would answer every
 * `reservedCapital[denomination]` read from `Object.prototype`.
 */
const NO_RESERVATIONS: Readonly<Record<string, DecimalString>> = Object.freeze(
  Object.create(null) as Record<string, DecimalString>,
);

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

/**
 * **D2** — the snapshot input's parsing copy, built and WARMED at module load
 * (`@polymarket-bot/risk/schema-arena`, §2.1 **S6**).
 *
 * Measured at `main` `761db76`, before this change: a snapshot input with no
 * own `asOf`, under one NON-ENUMERABLE `Object.prototype.asOf`, produced rows
 * stamped `2026-01-01T00:00:00Z` — an `as_of` nobody supplied, and `as_of` is
 * part of the §10.5 unique key of the rows this function's output binds to.
 */
const PnlSnapshotInputDoor = prototypeFreeParser(PnlSnapshotInputSchema);

/**
 * One §10.5 `pnl_snapshots`-shaped row. All measures share one denomination.
 *
 * The identity fields are flattened onto the row rather than nested in an
 * owner object, because they ARE the table's identity columns — `scope`,
 * `environment`, and `account_ref` are NOT NULL there, and `instance_id`,
 * `run_id`, and `market_id` participate in its unique key. A composition root
 * binds them with {@link toPnlSnapshotRow}, which is total: every column it
 * produces exists, and every NOT NULL column without a database default is
 * produced (pinned against the migration by the cross-package suite in
 * `test/unit/ledger/`).
 *
 * The three per-version breakdowns have no columns in that table; they are
 * §9.16 analytics this engine reports and the row mapper deliberately does not
 * persist. Dropping them silently in a mapping would be worse than saying so.
 */
export interface PnlSnapshot {
  /** `accounting.pnl_snapshots.scope` — the owner's ledger scope. */
  readonly scope: PnlOwner["scope"];
  /** `environment` — the run mode this stream folds (§10.8 separation). */
  readonly environment: string;
  /** `account_ref` — NOT NULL for every scope, including a strategy stream. */
  readonly accountRef: string;
  /** `instance_id` — the strategy instance, or null for a non-strategy stream. */
  readonly instanceId: string | null;
  /** `run_id` — the run this stream is scoped to, or null. */
  readonly runId: string | null;
  /** `market_id` — the market this stream is scoped to, or null. */
  readonly marketId: string | null;
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
  const record: Record<string, DecimalString> = Object.create(null) as Record<
    string,
    DecimalString
  >;
  for (const key of [...map.keys()].sort()) {
    if (filterKey(key)) {
      const value = map.get(key);
      if (value !== undefined) {
        // D4: a prototype-free target, so this assignment cannot find an
        // inherited setter and a later `record[k]` read cannot be answered by
        // `Object.prototype` — these breakdowns are handed to a caller.
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
 *
 * A PROTOTYPE-FREE DOOR (`WP-200-FU1`): **D1** the input is materialized,
 * **D2** parsed through {@link PnlSnapshotInputDoor}, **D3** `asOf`, `marks`
 * and `reservedCapital` are taken from the materialized tree — which matters
 * twice over here, because `marks[tokenAssetId]` and
 * `reservedCapital[denomination]` are INDEXED reads on caller records: on an
 * ordinary object an inherited `midpoint` would have valued an unmarked
 * position instead of refusing it (`PNL_MARK_MISSING` is a required-measure
 * rule), and an inherited reservation would have entered `capitalCommitted` —
 * **D4** and every emitted row has no prototype.
 */
export function computePnlSnapshot(
  state: PnlState,
  input: unknown,
): PnlResult<readonly PnlSnapshot[]> {
  return contained(() => computeMaterializedPnlSnapshot(state, input));
}

function computeMaterializedPnlSnapshot(
  state: PnlState,
  input: unknown,
): PnlResult<readonly PnlSnapshot[]> {
  const read = readInputAsData(input, "snapshot", "snapshot input");
  if (!read.ok) {
    return pnlFailure(read.refusal);
  }
  const parsed = PnlSnapshotInputDoor.safeParse(read.value);
  if (!parsed.success) {
    return pnlFailure(
      pnlRefusal("PNL_INPUT_INVALID", "the value is not a snapshot input", {
        issues: formatIssues(parsed.error),
      }),
    );
  }
  // D3 — the validated input IS the materialized tree.
  const materialized = read.value as PnlSnapshotInput;
  const { asOf, marks } = materialized;
  // NOT `?? {}` (`WP-200-FU1`, found by this package's own battery). The
  // fallback for an ABSENT `reservedCapital` block was an ordinary object
  // literal, and the read below is `reservedCapital[denomination]` — so a
  // caller who supplied no reservations at all had every one of them answered
  // by `Object.prototype`. With `Object.prototype.pUSD = "1000"` on a stream
  // denominated in pUSD, `capitalCommitted` silently included 1000 of reserved
  // capital nobody stated. The battery caught it because its injected value was
  // not a decimal and the addition threw; with a well-formed decimal it would
  // have been silent. An EMPTY PROTOTYPE-FREE record answers "no reservation"
  // with `undefined`, which is what absence means.
  const reservedCapital = materialized.reservedCapital ?? NO_RESERVATIONS;

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

    appendData(
      snapshots,
      plainFrozen({
        scope: state.identity.scope,
        environment: state.identity.environment,
        accountRef: state.identity.accountRef,
        instanceId:
          state.identity.scope === "VIRTUAL_STRATEGY" ? state.identity.instanceId : null,
        runId: state.identity.runId ?? null,
        marketId: state.identity.marketId ?? null,
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

/**
 * The `accounting.pnl_snapshots` row a snapshot binds to (§10.5), in the
 * camelCase spelling `packages/storage-postgres` uses for its column inputs.
 *
 * This exists because "the record fields mirror the columns" is a claim a
 * composition root has to be able to execute. Before remediation round 1 it
 * could not: a `PnlSnapshot` carried an owner and measures, while the table
 * requires `scope`, `environment`, and a NOT NULL `account_ref`, and keys its
 * rows by `(scope, environment, account_ref, instance_id, market_id, as_of)`.
 * Three of those were underivable from the value, so any binding would have
 * had to invent them.
 *
 * Deliberately absent, each because the DATABASE owns it: `pnl_snapshot_id`
 * (default `uuid_generate_v7()`), `computed_at` (default `now()`), and
 * `rebuilt_at` (set by a rebuild, not by a computation). Deliberately absent
 * because NO column exists: `feesByScheduleVersion`, `rewardsByProgram`, and
 * `estimatesByProgram`.
 */
export interface PnlSnapshotRow {
  readonly scope: string;
  readonly environment: string;
  readonly accountRef: string;
  readonly instanceId: string | null;
  readonly runId: string | null;
  readonly marketId: string | null;
  readonly denominationAsset: string;
  readonly grossTradingPnl: DecimalString;
  readonly coreNetPnl: DecimalString;
  readonly allInPnl: DecimalString;
  readonly realizedPnl: DecimalString;
  readonly unrealizedPnlMidpoint: DecimalString;
  readonly unrealizedPnlModel: DecimalString | null;
  readonly unrealizedPnlLiquidation: DecimalString | null;
  readonly worstCaseResolutionPnl: DecimalString | null;
  readonly feesPaid: DecimalString;
  readonly rewardEstimateTotal: DecimalString;
  readonly realizedRewards: DecimalString;
  readonly capitalCommitted: DecimalString;
  readonly asOf: string;
}

/**
 * The own DATA value of one field of a caller-supplied snapshot, or
 * `undefined`.
 *
 * `WP-200-FU1`. {@link toPnlSnapshotRow} is TOTAL by contract — it maps, it
 * does not refuse — so it cannot answer a hostile value with a typed refusal
 * the way the parsing doors do. What it can do, and now does, is READ like a
 * door: descriptors rather than properties, own rather than inherited. A
 * `PnlSnapshot` handed here is caller-supplied (the type says otherwise, and a
 * type stops a TypeScript caller and nobody else), every field it reads becomes
 * a column of a monetary row, and on an ordinary object a field the snapshot
 * does not carry is answered by `Object.prototype`. An accessor is not invoked;
 * its field arrives as `undefined`, which is a visible hole in the row rather
 * than a value somebody's getter chose.
 */
function ownField(snapshot: PnlSnapshot, key: keyof PnlSnapshot): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(snapshot, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return undefined;
  }
  return descriptor.value;
}

/**
 * Binds one snapshot to its `accounting.pnl_snapshots` row, field for field.
 *
 * **D1-lite / D4** (`WP-200-FU1`): every field is read as OWN DATA
 * ({@link ownField}) and the emitted row has NO PROTOTYPE, so neither the
 * mapper's reads nor a composition root's later reads of the row can be
 * answered from `Object.prototype`. The mapping itself — which columns exist,
 * which are deliberately absent — is unchanged.
 */
export function toPnlSnapshotRow(snapshot: PnlSnapshot): PnlSnapshotRow {
  return plainFrozen({
    scope: ownField(snapshot, "scope"),
    environment: ownField(snapshot, "environment"),
    accountRef: ownField(snapshot, "accountRef"),
    instanceId: ownField(snapshot, "instanceId"),
    runId: ownField(snapshot, "runId"),
    marketId: ownField(snapshot, "marketId"),
    denominationAsset: ownField(snapshot, "denominationAsset"),
    grossTradingPnl: ownField(snapshot, "grossTradingPnl"),
    coreNetPnl: ownField(snapshot, "coreNetPnl"),
    allInPnl: ownField(snapshot, "allInPnl"),
    realizedPnl: ownField(snapshot, "realizedPnl"),
    unrealizedPnlMidpoint: ownField(snapshot, "unrealizedPnlMidpoint"),
    unrealizedPnlModel: ownField(snapshot, "unrealizedPnlModel"),
    unrealizedPnlLiquidation: ownField(snapshot, "unrealizedPnlLiquidation"),
    worstCaseResolutionPnl: ownField(snapshot, "worstCaseResolutionPnl"),
    feesPaid: ownField(snapshot, "feesPaid"),
    rewardEstimateTotal: ownField(snapshot, "rewardEstimateTotal"),
    realizedRewards: ownField(snapshot, "realizedRewards"),
    capitalCommitted: ownField(snapshot, "capitalCommitted"),
    asOf: ownField(snapshot, "asOf"),
  }) as PnlSnapshotRow;
}
