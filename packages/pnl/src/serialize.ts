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

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import { plainFrozen, plainRecord } from "./immutable.js";
import type { PnlSnapshot } from "./snapshot.js";
import type { OpenLot, PnlState } from "./state.js";

/**
 * Serialization domain prefix; changing the format is a versioned decision.
 *
 * v2 (remediation round 1, 2026-09-02): a state now carries its full stream
 * IDENTITY — scope, environment, account, instance, run, market — where v1
 * carried only an owner. The bytes changed, so the version did.
 *
 * v3 (remediation round 2, 2026-09-03): the REALIZED view carries
 * `consumedRewardEvidence` — which booked ledger transactions this stream has
 * already realized. It belongs in the realized view because it is part of the
 * money: it is the difference between "5 was booked once" and "5 was booked
 * twice from one observation", and a rebuild must reconstruct it or the
 * second booking would slip through.
 */
export const PNL_STATE_SERIALIZATION_DOMAIN = "polymarket-bot/pnl-state/v3";

/** Serialization domain for snapshot rows (v2; the row shape is unchanged). */
export const PNL_SNAPSHOT_SERIALIZATION_DOMAIN = "polymarket-bot/pnl-snapshot/v2";

/**
 * Scalars and keys are encoded by `encodePlainJson` (`SER-1`), for uniformity
 * with every other byte this package emits: a string, number, boolean or null
 * never consulted `toJSON`, so the bytes are identical, but an OUT-OF-TYPE
 * bigint planted in the tree flipped from a `TypeError` to accepted
 * `"INJECTED"` bytes under an inherited `Object.prototype`/`BigInt.prototype`
 * `toJSON` (`SER-0`, oracle-only). `undefined` is the one scalar kept exactly
 * as `JSON.stringify` rendered it through the template below — the word
 * `undefined` — because a stream identity may carry an own `runId`/`marketId`
 * explicitly set to `undefined` (the schema admits it), and this oracle's bytes
 * for that input are pinned by byte-identity, not redesigned here.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return value === undefined ? "undefined" : encodePlainJson(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${encodePlainJson(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * A sorted own-data record from a map.
 *
 * The accumulator is PROTOTYPE-FREE (`WP-200-FU1`): `record[key] = value` on an
 * ordinary object is `Set`, which walks the chain, and these keys are
 * caller-chosen denomination assets and composite `[asset, version]` strings —
 * so an inherited get-only accessor at one of them made this ORACLE throw out
 * of `serializePnlState`, which has no refusal channel to turn it into.
 * Measured by this package's own battery before it was fixed.
 */
function sortedRecord<T>(map: ReadonlyMap<string, T>): Readonly<Record<string, T>> {
  const record = plainRecord<T>();
  for (const key of [...map.keys()].sort()) {
    const value = map.get(key);
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

function lotsRecord(map: ReadonlyMap<string, OpenLot>): Readonly<Record<string, unknown>> {
  const record = plainRecord<unknown>();
  for (const key of [...map.keys()].sort()) {
    const lot = map.get(key);
    if (lot !== undefined) {
      record[key] = plainFrozen({
        shares: lot.shares,
        costBasis: lot.costBasis,
        denominationAsset: lot.denominationAsset,
        marketId: lot.marketId,
      });
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
 *
 * Deliberately INCLUDES `consumedRewardEvidence` (round 2): only a realized
 * reward payout moves it, and it is what stops one booked payout from being
 * realized twice — so it is part of the money, not bookkeeping. Folding an
 * estimate still leaves these bytes identical, which is what acceptance 3
 * asserts.
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
    consumedRewardEvidence: sortedRecord(state.consumedRewardEvidence),
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
