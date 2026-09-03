/**
 * Per-scope exposure accounting — handoff §9.7 commitment list.
 *
 * THE CENTRAL RULE (workplan WP-180 acceptance 1): open orders and positions
 * BOTH consume limits. Every exposure entry therefore carries the two
 * components separately plus their exact sum, and every cap in this package
 * and every §9.8 check 15 consumer compares against the SUM. A limit fully
 * consumed by open orders blocks new commitments even with zero positions,
 * and vice versa.
 *
 * What counts as committed pUSD exposure:
 *
 * - a position contributes its `costBasis` (capital already spent);
 * - an open BUY order contributes `price × shares` (capital contractually
 *   committed the moment it fills — and it can fill at any time);
 * - an applied live BUY reservation contributes its `cost` (capital set aside
 *   pre-submission, §9.10 "Reserve collateral/inventory before submission");
 * - open SELL orders and SELL reservations contribute `"0"` here — they
 *   reserve OUTCOME TOKENS, which is tracked by the inventory accounting in
 *   `state.ts`, not by the pUSD exposure table.
 *
 * Items without a series/underlying/window attribution do not appear in those
 * dimensions; the reservation gate fails closed on the REQUEST side
 * (`CAPITAL_SCOPE_KEY_MISSING`) when a cap is configured for a dimension the
 * request cannot be attributed to. A pre-existing position supplied without
 * attribution is the caller's data gap and is disclosed in `README.md`.
 */

import { addDecimal, mulDecimal } from "@polymarket-bot/decimal";
import type { MoneyString } from "@polymarket-bot/domain";

import { deepFreeze, ownEntry, setOwn } from "./guards.js";
import type { AllocatorState, AppliedReservation, OpenOrderCommitment, PositionHolding } from "./state.js";

/** One scope's exposure. Both components consume; `combined` is their sum. */
export interface ExposureEntry {
  readonly openOrderCommitted: MoneyString;
  readonly positionCommitted: MoneyString;
  readonly combined: MoneyString;
}

export interface ExposureSnapshot {
  readonly global: ExposureEntry;
  readonly byStrategyInstance: Readonly<Record<string, ExposureEntry>>;
  readonly byMarket: Readonly<Record<string, ExposureEntry>>;
  readonly bySeries: Readonly<Record<string, ExposureEntry>>;
  readonly byUnderlying: Readonly<Record<string, ExposureEntry>>;
  readonly byResolutionWindow: Readonly<Record<string, ExposureEntry>>;
}

interface MutableEntry {
  openOrderCommitted: MoneyString;
  positionCommitted: MoneyString;
}

type Table = Record<string, MutableEntry>;

function bump(
  table: Table,
  key: string | undefined,
  component: "openOrderCommitted" | "positionCommitted",
  amount: MoneyString,
): void {
  if (key === undefined) return;
  // OWN lookup, OWN definition. `key` is caller data: a scope key is a bounded
  // non-empty string, so `"__proto__"` is admissible, and `table[key] ??= …`
  // would have read `Object.prototype` as an existing entry and then written
  // this package's commitment components onto the intrinsic itself (review
  // round 5, the BLOCKER-1 sweep). See `guards.ts`.
  let entry = ownEntry<MutableEntry>(table, key);
  if (entry === undefined) {
    entry = { openOrderCommitted: "0", positionCommitted: "0" };
    setOwn(table, key, entry);
  }
  entry[component] = addDecimal(entry[component], amount);
}

function finalize(table: Table): Readonly<Record<string, ExposureEntry>> {
  const out: Record<string, ExposureEntry> = {};
  for (const [key, entry] of Object.entries(table)) {
    setOwn(out, key, {
      openOrderCommitted: entry.openOrderCommitted,
      positionCommitted: entry.positionCommitted,
      combined: addDecimal(entry.openOrderCommitted, entry.positionCommitted),
    });
  }
  return out;
}

const ZERO_ENTRY: ExposureEntry = Object.freeze({
  openOrderCommitted: "0",
  positionCommitted: "0",
  combined: "0",
});

/** The zero exposure entry (exported so consumers compare against a constant). */
export const EXPOSURE_ZERO: ExposureEntry = ZERO_ENTRY;

interface Tables {
  global: Table;
  byStrategyInstance: Table;
  byMarket: Table;
  bySeries: Table;
  byUnderlying: Table;
  byResolutionWindow: Table;
}

const GLOBAL_KEY = "GLOBAL";

function bumpAll(
  tables: Tables,
  item: Pick<PositionHolding, "marketId" | "strategyInstanceId"> & {
    readonly scope?: PositionHolding["scope"];
  },
  component: "openOrderCommitted" | "positionCommitted",
  amount: MoneyString,
): void {
  bump(tables.global, GLOBAL_KEY, component, amount);
  bump(tables.byStrategyInstance, item.strategyInstanceId, component, amount);
  bump(tables.byMarket, item.marketId, component, amount);
  bump(tables.bySeries, item.scope?.seriesKey, component, amount);
  bump(tables.byUnderlying, item.scope?.underlyingKey, component, amount);
  bump(tables.byResolutionWindow, item.scope?.resolutionWindowKey, component, amount);
}

function emptyTables(): Tables {
  return {
    global: {},
    byStrategyInstance: {},
    byMarket: {},
    bySeries: {},
    byUnderlying: {},
    byResolutionWindow: {},
  };
}

function snapshotFromItems(
  positions: readonly PositionHolding[],
  openOrders: readonly OpenOrderCommitment[],
  reservations: readonly AppliedReservation[],
): ExposureSnapshot {
  const tables = emptyTables();
  for (const position of positions) {
    bumpAll(tables, position, "positionCommitted", position.costBasis);
  }
  for (const order of openOrders) {
    if (order.action !== "BUY") continue;
    bumpAll(tables, order, "openOrderCommitted", mulDecimal(order.price, order.shares));
  }
  for (const reservation of reservations) {
    if (reservation.action !== "BUY") continue;
    bumpAll(tables, reservation, "openOrderCommitted", reservation.cost);
  }
  return deepFreeze({
    global: finalize(tables.global)[GLOBAL_KEY] ?? ZERO_ENTRY,
    byStrategyInstance: finalize(tables.byStrategyInstance),
    byMarket: finalize(tables.byMarket),
    bySeries: finalize(tables.bySeries),
    byUnderlying: finalize(tables.byUnderlying),
    byResolutionWindow: finalize(tables.byResolutionWindow),
  });
}

/**
 * The LIVE exposure snapshot: positions + open orders + applied live
 * reservations. This is the structural view §9.8 check 15 consumes
 * (`@polymarket-bot/risk` mirrors the shape; no package edge exists — see
 * `docs/contracts/dependency-direction.md` §2.1 and this package's README).
 */
export function exposureSnapshot(state: AllocatorState): ExposureSnapshot {
  return snapshotFromItems(state.positions, state.openOrders, state.reservations);
}

/**
 * The scope keys a consumer intends to QUERY this snapshot for.
 *
 * Every listed key is guaranteed to be present in the returned snapshot, with
 * an explicit zero entry when the state does not otherwise mention it.
 */
export interface ExposureCoverage {
  readonly strategyInstanceIds?: readonly string[];
  readonly marketIds?: readonly string[];
  readonly seriesKeys?: readonly string[];
  readonly underlyingKeys?: readonly string[];
  readonly resolutionWindowKeys?: readonly string[];
}

function withExplicitZeros(
  table: Readonly<Record<string, ExposureEntry>>,
  keys: readonly string[] | undefined,
): Readonly<Record<string, ExposureEntry>> {
  if (keys === undefined || keys.length === 0) return table;
  const out: Record<string, ExposureEntry> = { ...table };
  for (const key of keys) {
    // OWN test, OWN definition (review round 5, the BLOCKER-1 sweep). With
    // `out[key] ??= ZERO_ENTRY` a coverage key of `"__proto__"` read
    // `Object.prototype` as already present, so the EXPLICIT ZERO this function
    // exists to guarantee was silently not written — and the risk side's
    // `RISK_EXPOSURE_ENTRY_MISSING` (round 1, BLOCKER 2) would have read the
    // same inherited object as a measurement.
    if (ownEntry(out, key) === undefined) setOwn(out, key, ZERO_ENTRY);
  }
  return out;
}

/**
 * {@link exposureSnapshot} with an EXPLICIT ZERO ENTRY for every key in
 * `coverage` the state does not otherwise mention.
 *
 * WHY THIS EXISTS. `exposureSnapshot` is sparse by construction: a scope with
 * no positions, orders, or reservations simply has no row. A consumer that
 * enforces a cap cannot read that absence as "zero" — absence is *unknown*,
 * and `@polymarket-bot/risk`'s §9.8 check 15 refuses it
 * (`RISK_EXPOSURE_ENTRY_MISSING`) rather than passing a cap against unmeasured
 * exposure (review round 1, BLOCKER 2). This builder is how a composition root
 * turns "I am about to query these scopes" into a snapshot that ANSWERS for
 * every one of them, with a zero that is a measurement rather than a gap.
 *
 * The zeros are exact and honest: this state is the allocator's own complete
 * record of commitments, so a key it does not mention genuinely holds nothing.
 * Only the SNAPSHOT is sparse; the state is not.
 */
export function exposureSnapshotCovering(
  state: AllocatorState,
  coverage: ExposureCoverage,
): ExposureSnapshot {
  const snapshot = exposureSnapshot(state);
  return deepFreeze({
    global: snapshot.global,
    byStrategyInstance: withExplicitZeros(
      snapshot.byStrategyInstance,
      coverage.strategyInstanceIds,
    ),
    byMarket: withExplicitZeros(snapshot.byMarket, coverage.marketIds),
    bySeries: withExplicitZeros(snapshot.bySeries, coverage.seriesKeys),
    byUnderlying: withExplicitZeros(snapshot.byUnderlying, coverage.underlyingKeys),
    byResolutionWindow: withExplicitZeros(
      snapshot.byResolutionWindow,
      coverage.resolutionWindowKeys,
    ),
  });
}

/**
 * One instance's SHADOW book (§9.7 "preserves independent shadow
 * accounting"): built ONLY from that instance's shadow reservations. Shadow
 * commitments never consume live collateral and live commitments never
 * consume shadow books.
 */
export function shadowExposureSnapshot(
  state: AllocatorState,
  strategyInstanceId: string,
): ExposureSnapshot {
  return snapshotFromItems(
    [],
    [],
    state.shadowReservations.filter(
      (reservation) => reservation.strategyInstanceId === strategyInstanceId,
    ),
  );
}
