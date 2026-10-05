/**
 * WP-290 r11: reading a door's salvage (`door.ts`) in the terms the round-4 to round-10 door tests assert.
 *
 * Before r11 a door returned, for an unusable answer only, `named` (every venue order id its rows or legs carried,
 * with its token when the row validated in full, `null` for an id alone) and `salvage` (`rows`, `legs`, `trades`:
 * what validated in full, and the readable trade identities). r11 made salvage the default path: every outcome
 * carries every row as fragments (`Salvage.orders`, `Salvage.trades`, their legs). These helpers derive the old
 * views from the new fragments EXACTLY as the old door built them, so the earlier tests keep asserting the same
 * facts; what r11 keeps beyond them (every fragment, the unreadable ones) is asserted by `units-r11.test.ts` and
 * `door-property.test.ts`.
 */

import type { LegFragments, ReadOutcome, Salvage, TradeFragments } from "../../../../packages/oms/src/reconciliation/door.js";
import type { VenueOrderView, VenueTradeLeg } from "../../../../packages/oms/src/reconciliation/ports.js";

function unusable(outcome: ReadOutcome<unknown>): boolean {
  return outcome.kind === "INCOMPLETE" || outcome.kind === "MALFORMED";
}

function keep(named: Map<string, string | null>, id: string, token: string | null): void {
  if (!named.has(id) || (named.get(id) === null && token !== null)) named.set(id, token);
}

/** The old `named` view: every venue order id an UNUSABLE answer's rows or legs carry (token when in full). */
export function namedOf(outcome: ReadOutcome<unknown>): Map<string, string | null> {
  const named = new Map<string, string | null>();
  if (!unusable(outcome)) return named;
  for (const row of outcome.salvage.orders) if (row.venueOrderId !== null) keep(named, row.venueOrderId, row.inFull === null ? null : row.inFull.tokenId);
  for (const trade of outcome.salvage.trades) {
    for (const leg of trade.legs) if (leg.venueOrderId !== null) keep(named, leg.venueOrderId, leg.inFull === null ? null : leg.inFull.tokenId);
  }
  return named;
}

/** The old `salvage.rows` view: every order row of an UNUSABLE answer that validated in full, a repeated one included. */
export function rowsOf(outcome: ReadOutcome<unknown>): VenueOrderView[] {
  if (!unusable(outcome)) return [];
  return outcome.salvage.orders.flatMap((row) => (row.inFull === null ? [] : [row.inFull]));
}

/** The old `salvage.legs` view: every own leg of an UNUSABLE answer that validated in full, with its row's trade id and status when readable. */
export function legsOf(outcome: ReadOutcome<unknown>): { readonly venueTradeId: string | null; readonly status: string | null; readonly leg: VenueTradeLeg }[] {
  if (!unusable(outcome)) return [];
  return outcome.salvage.trades.flatMap((trade: TradeFragments) =>
    trade.legs.flatMap((leg: LegFragments) => (leg.inFull === null ? [] : [{ venueTradeId: trade.venueTradeId, status: trade.status, leg: leg.inFull }])),
  );
}

/** The old `salvage.trades` view: every readable trade identity of an UNUSABLE answer, with its status and shape. */
export function tradesOf(outcome: ReadOutcome<unknown>): { readonly venueTradeId: string; readonly status: string | null; readonly shape: "IN_FULL" | "OWNERSHIP_UNDETERMINED" | "MALFORMED" }[] {
  if (!unusable(outcome)) return [];
  return outcome.salvage.trades.flatMap((trade) =>
    trade.venueTradeId === null
      ? []
      : [{ venueTradeId: trade.venueTradeId, status: trade.status, shape: trade.inFull === null ? ("MALFORMED" as const) : trade.inFull.ownershipUndetermined ? ("OWNERSHIP_UNDETERMINED" as const) : ("IN_FULL" as const) }],
  );
}

/** The old `salvage.whole` (trades answers). */
export function wholeOf(outcome: ReadOutcome<unknown>): boolean {
  return outcome.salvage.whole;
}

/** Whether an outcome kept anything at all (r11: every row of the answer, valid or not). */
export function keptAnything(salvage: Salvage): boolean {
  return salvage.orders.length + salvage.trades.length + salvage.holdings.length + salvage.members.length > 0;
}
