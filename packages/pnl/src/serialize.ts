/**
 * Deterministic canonical bytes for a folded PnL state and its snapshot rows.
 *
 * This is the byte-equality ORACLE the WP-200 acceptance tests use:
 *
 * - acceptance 2 ("projections rebuild from zero and match incremental
 *   state"): the incrementally folded state and the from-zero rebuild
 *   serialize to identical bytes, so equality is asserted on the whole state
 *   rather than on a hand-picked field list that could silently omit the
 *   field a regression breaks;
 * - acceptance 3 ("reward estimate is not realized PnL"): the REALIZED
 *   projection — everything except the two estimate buckets — is serialized
 *   before and after folding an estimate and must be byte-identical.
 *
 * The format sorts every key, so accumulation order can never leak into the
 * bytes. It is a test/diagnostic oracle and a stable interchange form; it is
 * NOT a persistence format (that is the composition root's binding to the
 * §10.5 `pnl_snapshots` columns).
 */

import type { PnlSnapshot } from "./snapshot.js";
import type { OpenLot, PnlState } from "./state.js";

/**
 * Serialization domain prefix; changing the format is a versioned decision.
 *
 * v2 (remediation round 1, 2026-09-02): a state now carries its full stream
 * IDENTITY — scope, environment, account, instance, run, market — where v1
 * carried only an owner. The bytes changed, so the version did.
 */
export const PNL_STATE_SERIALIZATION_DOMAIN = "polymarket-bot/pnl-state/v2";

/** Serialization domain for snapshot rows (v2 for the same reason). */
export const PNL_SNAPSHOT_SERIALIZATION_DOMAIN = "polymarket-bot/pnl-snapshot/v2";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

function sortedRecord<T>(map: ReadonlyMap<string, T>): Readonly<Record<string, T>> {
  const record: Record<string, T> = {};
  for (const key of [...map.keys()].sort()) {
    const value = map.get(key);
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

function lotsRecord(map: ReadonlyMap<string, OpenLot>): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  for (const key of [...map.keys()].sort()) {
    const lot = map.get(key);
    if (lot !== undefined) {
      record[key] = {
        shares: lot.shares,
        costBasis: lot.costBasis,
        denominationAsset: lot.denominationAsset,
        marketId: lot.marketId,
      };
    }
  }
  return record;
}

/**
 * The MONEY of a folded state: realized trading PnL, open lots and their
 * basis, fees paid (and by schedule version), and observed reward payouts.
 *
 * Deliberately excludes the two estimate buckets, and deliberately excludes
 * `recordCount` / `refs`, because folding ANY record moves those and the
 * question this view answers is "did the money change", not "did anything
 * happen".
 */
function realizedView(state: PnlState): Readonly<Record<string, unknown>> {
  return {
    identity: state.identity,
    lots: lotsRecord(state.lots),
    realizedTrading: sortedRecord(state.realizedTrading),
    feesPaid: sortedRecord(state.feesPaid),
    feesBySchedule: sortedRecord(state.feesBySchedule),
    realizedRewards: sortedRecord(state.realizedRewards),
    rewardsByProgram: sortedRecord(state.rewardsByProgram),
    reversedRefs: [...state.reversedRefs].sort(),
  };
}

/** Canonical bytes for the WHOLE folded state, estimates and bookkeeping included. */
export function serializePnlState(state: PnlState): string {
  return `${PNL_STATE_SERIALIZATION_DOMAIN}:${stableStringify({
    ...realizedView(state),
    recordCount: state.recordCount,
    refs: [...state.refs].sort(),
    rewardEstimates: sortedRecord(state.rewardEstimates),
    estimatesByProgram: sortedRecord(state.estimatesByProgram),
  })}`;
}

/**
 * Canonical bytes for the REALIZED projection only.
 *
 * §9.16's "Reward estimates are never booked as realized" is the assertion
 * that these bytes do not change when an estimate is folded — stated over the
 * whole realized state rather than over a hand-picked field list.
 */
export function serializeRealizedPnl(state: PnlState): string {
  return `${PNL_STATE_SERIALIZATION_DOMAIN}:realized:${stableStringify(realizedView(state))}`;
}

/** Canonical bytes for a set of snapshot rows, in the order produced. */
export function serializePnlSnapshots(snapshots: readonly PnlSnapshot[]): string {
  return `${PNL_SNAPSHOT_SERIALIZATION_DOMAIN}:${stableStringify(snapshots)}`;
}
