/**
 * One evaluation's validated view of the world.
 *
 * The runtime hands a strategy inert, deep-frozen snapshots (§7.6, and
 * `packages/strategy-runtime/src/input.ts`), but it validates them SHALLOWLY on
 * purpose — "deep economic validation of view contents is deliberately NOT
 * repeated here … the core loop has a latency budget". A price on a book view
 * is therefore a string this package has not checked, and
 * `@polymarket-bot/decimal` throws on a non-canonical argument, so reading one
 * straight into arithmetic would turn a data fault into a thrown callback (an
 * ADR-005 §3 containment, which PAUSES the instance).
 *
 * This module is the read boundary that stops that: it reads each view exactly
 * once, validates every economic value it will use, and answers with an
 * {@link Outcome}. Absence is always read as an own property, because the
 * runtime's copies carry `Object.prototype` and an inherited `closeTime` would
 * otherwise become a real close time.
 */

import type {
  MarketView,
  OrderBookView,
  StrategyContext,
  StrategyOrderView,
  VirtualPositionView,
} from "@polymarket-bot/strategy-sdk";

import {
  add,
  compare,
  isDecimal,
  isPrice,
  mul,
  readNonNegative,
  readPrice,
  sub,
  ZERO,
} from "./economics.js";
import type { FeatureValues } from "./features.js";
import { bad, describe, hasOwn, ok, type Outcome } from "./plain.js";
import { parseInstantMs } from "./time.js";

export interface BookLevel {
  readonly price: string;
  readonly shares: string;
}

export interface BookSnapshot {
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly asOfMs: number;
}

export interface MarketSnapshot {
  readonly marketId: string;
  readonly tickSize: string;
  readonly minimumOrderSize: string;
  readonly closeTimeMs: number | null;
  readonly openTimeMs: number | null;
}

export interface PositionSnapshot {
  readonly yesShares: string;
  readonly noShares: string;
}

export interface TrackedOrderView {
  readonly orderId: string;
  readonly outcome: "YES" | "NO";
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly requestedShares: string;
  readonly filledShares: string;
  readonly status: string;
}

export interface Observation {
  readonly nowMs: number;
  readonly nowIso: string;
  readonly snapshotRef: string;
  readonly market: MarketSnapshot;
  readonly books: Readonly<Record<"YES" | "NO", BookSnapshot>>;
  readonly features: FeatureValues;
  readonly position: PositionSnapshot;
  readonly orders: readonly TrackedOrderView[];
}

/** How severely an unusable view must be treated. */
export type ViewFaultSeverity = "PAUSE" | "HALT";

export interface ViewFault {
  readonly severity: ViewFaultSeverity;
  readonly problem: string;
}

export type ObserveResult =
  | { readonly ok: true; readonly value: Observation }
  | { readonly ok: false; readonly fault: ViewFault };

function levels(raw: unknown, path: string): Outcome<readonly BookLevel[]> {
  if (!Array.isArray(raw)) {
    return bad(`${path} must be an array of price levels; received ${describe(raw)}`);
  }
  const parsed: BookLevel[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const level: unknown = raw[index];
    const levelPath = `${path}[${String(index)}]`;
    if (typeof level !== "object" || level === null) {
      return bad(`${levelPath} must be an object`);
    }
    const record = level as Record<string, unknown>;
    if (!hasOwn(record, "price") || !hasOwn(record, "shares")) {
      return bad(`${levelPath} must carry own price and shares`);
    }
    const price = readPrice(record["price"], `${levelPath}.price`);
    if (!price.ok) return price;
    const shares = readNonNegative(record["shares"], `${levelPath}.shares`);
    if (!shares.ok) return shares;
    parsed.push(Object.freeze({ price: price.value, shares: shares.value }));
  }
  return ok(Object.freeze(parsed));
}

function book(view: Readonly<OrderBookView>, path: string): Outcome<BookSnapshot> {
  if (typeof view !== "object" || view === null) {
    return bad(`${path} must be an order-book view`);
  }
  if (!hasOwn(view, "asOf")) {
    return bad(`${path}.asOf is required; a book with no observation time cannot be aged`);
  }
  const asOf = parseInstantMs(view.asOf, `${path}.asOf`);
  if (!asOf.ok) return asOf;
  const bids = levels(hasOwn(view, "bids") ? view.bids : [], `${path}.bids`);
  if (!bids.ok) return bids;
  const asks = levels(hasOwn(view, "asks") ? view.asks : [], `${path}.asks`);
  if (!asks.ok) return asks;
  return ok(Object.freeze({ bids: bids.value, asks: asks.value, asOfMs: asOf.value }));
}

function market(view: Readonly<MarketView>): Outcome<MarketSnapshot> {
  if (typeof view !== "object" || view === null) {
    return bad("market view is required");
  }
  if (!hasOwn(view, "marketId") || typeof view.marketId !== "string" || view.marketId.length === 0) {
    return bad("market.marketId is required");
  }
  if (!hasOwn(view, "tickSize") || !isDecimal(view.tickSize)) {
    return bad("market.tickSize must be a canonical decimal string");
  }
  if (!hasOwn(view, "minimumOrderSize") || !isDecimal(view.minimumOrderSize)) {
    return bad("market.minimumOrderSize must be a canonical decimal string");
  }
  let closeTimeMs: number | null = null;
  if (hasOwn(view, "closeTime")) {
    const parsed = parseInstantMs(view.closeTime, "market.closeTime");
    if (!parsed.ok) return parsed;
    closeTimeMs = parsed.value;
  }
  let openTimeMs: number | null = null;
  if (hasOwn(view, "openTime")) {
    const parsed = parseInstantMs(view.openTime, "market.openTime");
    if (!parsed.ok) return parsed;
    openTimeMs = parsed.value;
  }
  return ok(
    Object.freeze({
      marketId: view.marketId,
      tickSize: view.tickSize,
      minimumOrderSize: view.minimumOrderSize,
      closeTimeMs,
      openTimeMs,
    }),
  );
}

function position(view: Readonly<VirtualPositionView>): Outcome<PositionSnapshot> {
  if (typeof view !== "object" || view === null) {
    return bad("position view is required");
  }
  if (!hasOwn(view, "yesShares") || !isDecimal(view.yesShares)) {
    return bad("position.yesShares must be a canonical decimal string");
  }
  if (!hasOwn(view, "noShares") || !isDecimal(view.noShares)) {
    return bad("position.noShares must be a canonical decimal string");
  }
  return ok(Object.freeze({ yesShares: view.yesShares, noShares: view.noShares }));
}

function orders(views: readonly StrategyOrderView[]): Outcome<readonly TrackedOrderView[]> {
  if (!Array.isArray(views)) {
    return bad("orders must be an array");
  }
  const parsed: TrackedOrderView[] = [];
  for (let index = 0; index < views.length; index += 1) {
    const view = views[index];
    const path = `orders[${String(index)}]`;
    const one = orderView(view, path);
    if (!one.ok) return one;
    parsed.push(one.value);
  }
  // Deterministic order: the runtime's array order is the caller's, and a
  // strategy that adopted "the first matching order" would depend on it.
  const sorted = [...parsed].sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
  return ok(Object.freeze(sorted));
}

export function orderView(view: unknown, path: string): Outcome<TrackedOrderView> {
  if (typeof view !== "object" || view === null) {
    return bad(`${path} must be an order view`);
  }
  const record = view as Record<string, unknown>;
  for (const key of ["orderId", "outcome", "side", "price", "requestedShares", "filledShares", "status"]) {
    if (!hasOwn(record, key)) {
      return bad(`${path}.${key} is required`);
    }
  }
  if (typeof record["orderId"] !== "string" || record["orderId"].length === 0) {
    return bad(`${path}.orderId must be a non-empty string`);
  }
  if (record["outcome"] !== "YES" && record["outcome"] !== "NO") {
    return bad(`${path}.outcome must be YES or NO`);
  }
  if (record["side"] !== "BUY" && record["side"] !== "SELL") {
    return bad(`${path}.side must be BUY or SELL`);
  }
  if (!isPrice(record["price"])) {
    return bad(`${path}.price must be a canonical decimal price`);
  }
  if (!isDecimal(record["requestedShares"])) {
    return bad(`${path}.requestedShares must be a canonical decimal string`);
  }
  if (!isDecimal(record["filledShares"])) {
    return bad(`${path}.filledShares must be a canonical decimal string`);
  }
  if (typeof record["status"] !== "string") {
    return bad(`${path}.status must be a string`);
  }
  return ok(
    Object.freeze({
      orderId: record["orderId"],
      outcome: record["outcome"],
      side: record["side"],
      price: record["price"],
      requestedShares: record["requestedShares"],
      filledShares: record["filledShares"],
      status: record["status"],
    }),
  );
}

/**
 * Builds the observation. A malformed POSITION view is a HALT (an instance that
 * cannot tell what it holds must not act — §6 invariant 12); a malformed
 * market, book or order view is a PAUSE, which is §9.9's response to unusable
 * Polymarket data.
 */
export function observe(ctx: StrategyContext): ObserveResult {
  const nowIso = ctx.now();
  const nowMs = parseInstantMs(nowIso, "now()");
  if (!nowMs.ok) {
    return { ok: false, fault: { severity: "HALT", problem: nowMs.problem } };
  }
  const snapshot = ctx.features();
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !hasOwn(snapshot, "snapshotRef") ||
    typeof snapshot.snapshotRef !== "string" ||
    !hasOwn(snapshot, "values") ||
    typeof snapshot.values !== "object" ||
    snapshot.values === null
  ) {
    return {
      ok: false,
      fault: { severity: "PAUSE", problem: "the feature snapshot view is unusable" },
    };
  }
  const marketSnapshot = market(ctx.market());
  if (!marketSnapshot.ok) {
    return { ok: false, fault: { severity: "PAUSE", problem: marketSnapshot.problem } };
  }
  const yesBook = book(ctx.book("YES"), "book.YES");
  if (!yesBook.ok) {
    return { ok: false, fault: { severity: "PAUSE", problem: yesBook.problem } };
  }
  const noBook = book(ctx.book("NO"), "book.NO");
  if (!noBook.ok) {
    return { ok: false, fault: { severity: "PAUSE", problem: noBook.problem } };
  }
  const positionSnapshot = position(ctx.position());
  if (!positionSnapshot.ok) {
    return { ok: false, fault: { severity: "HALT", problem: positionSnapshot.problem } };
  }
  const orderViews = orders(ctx.orders());
  if (!orderViews.ok) {
    return { ok: false, fault: { severity: "PAUSE", problem: orderViews.problem } };
  }
  return {
    ok: true,
    value: Object.freeze({
      nowMs: nowMs.value,
      nowIso,
      snapshotRef: snapshot.snapshotRef,
      market: marketSnapshot.value,
      books: Object.freeze({ YES: yesBook.value, NO: noBook.value }),
      features: snapshot.values as FeatureValues,
      position: positionSnapshot.value,
      orders: orderViews.value,
    }),
  };
}

/** This instance's virtual holding of one outcome token. */
export function heldShares(observation: Observation, outcome: "YES" | "NO"): string {
  return outcome === "YES" ? observation.position.yesShares : observation.position.noShares;
}

/**
 * Total shares resting on the ask side at or below `limitPrice` — the size a
 * buyer could take without paying more than the limit. Every level's price is
 * already canonical (the book was validated above), so the comparison is exact.
 */
export function askDepthUpTo(snapshot: BookSnapshot, limitPrice: string): Outcome<string> {
  return sumWhile(snapshot.asks, limitPrice, "AT_OR_BELOW");
}

/** Total shares resting on the bid side at or above `limitPrice`. */
export function bidDepthDownTo(snapshot: BookSnapshot, limitPrice: string): Outcome<string> {
  return sumWhile(snapshot.bids, limitPrice, "AT_OR_ABOVE");
}

/**
 * The exact result of consuming one side of the book for a requested size.
 *
 * `INSUFFICIENT_DEPTH` is a typed outcome carrying what WAS available, never a
 * partial answer — the same refusal semantics the order book and the feature
 * engine use (`docs/contracts/features-v1.md` §4, "absent versus zero").
 */
export type BookWalk =
  | {
      readonly outcome: "CONSUMED";
      /** Exact total money of the consumed levels: sum of price * shares. */
      readonly totalMoney: string;
      /** The last (worst) price consumed. */
      readonly worstPrice: string;
    }
  | { readonly outcome: "INSUFFICIENT_DEPTH"; readonly availableShares: string };

/**
 * Walks `bookLevels` best-first, consuming exactly `size` shares.
 *
 * The levels are consumed in the order the view supplies them, which §7.6 fixes
 * as best-first. No division is performed: the answer is a total money amount
 * and a worst price, both exact.
 */
export function walkForSize(
  bookLevels: readonly BookLevel[],
  size: string,
): Outcome<BookWalk> {
  let remaining = size;
  let totalMoney = ZERO;
  let worstPrice: string | null = null;
  let available = ZERO;
  for (const level of bookLevels) {
    const availableNext = add(available, level.shares, "book walk");
    if (!availableNext.ok) return availableNext;
    available = availableNext.value;
    const remainingSign = compare(remaining, ZERO, "book walk");
    if (!remainingSign.ok) return remainingSign;
    if (remainingSign.value <= 0) continue;
    const ordering = compare(level.shares, remaining, "book walk");
    if (!ordering.ok) return ordering;
    const taken = ordering.value <= 0 ? level.shares : remaining;
    const money = mul(taken, level.price, "book walk");
    if (!money.ok) return money;
    const nextTotal = add(totalMoney, money.value, "book walk");
    if (!nextTotal.ok) return nextTotal;
    totalMoney = nextTotal.value;
    const nextRemaining = sub(remaining, taken, "book walk");
    if (!nextRemaining.ok) return nextRemaining;
    remaining = nextRemaining.value;
    worstPrice = level.price;
  }
  const remainingSign = compare(remaining, ZERO, "book walk");
  if (!remainingSign.ok) return remainingSign;
  if (remainingSign.value > 0 || worstPrice === null) {
    return ok(Object.freeze({ outcome: "INSUFFICIENT_DEPTH" as const, availableShares: available }));
  }
  return ok(Object.freeze({ outcome: "CONSUMED" as const, totalMoney, worstPrice }));
}

function sumWhile(
  bookLevels: readonly BookLevel[],
  limitPrice: string,
  direction: "AT_OR_BELOW" | "AT_OR_ABOVE",
): Outcome<string> {
  let total = ZERO;
  for (const level of bookLevels) {
    const ordering = compare(level.price, limitPrice, "book depth");
    if (!ordering.ok) return ordering;
    const included = direction === "AT_OR_BELOW" ? ordering.value <= 0 : ordering.value >= 0;
    if (!included) continue;
    const next = add(total, level.shares, "book depth");
    if (!next.ok) return next;
    total = next.value;
  }
  return ok(total);
}
