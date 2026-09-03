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

import { deepFreeze } from "./guards.js";
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
  const entry = (table[key] ??= { openOrderCommitted: "0", positionCommitted: "0" });
  entry[component] = addDecimal(entry[component], amount);
}

function finalize(table: Table): Readonly<Record<string, ExposureEntry>> {
  const out: Record<string, ExposureEntry> = {};
  for (const [key, entry] of Object.entries(table)) {
    out[key] = {
      openOrderCommitted: entry.openOrderCommitted,
      positionCommitted: entry.positionCommitted,
      combined: addDecimal(entry.openOrderCommitted, entry.positionCommitted),
    };
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
