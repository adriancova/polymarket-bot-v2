/**
 * Did a BASKET plan's booked orders EXECUTE together? — SIM-1 r2
 * (`SIM1-R2-1`), the trader's reading of the user's ruling R3 for baskets.
 *
 * WHY THE VENUE'S `accepted` IS NOT THE ANSWER. `ExecutionResult.accepted`
 * says every planned order was PLACED — booked at the venue — and nothing
 * about how each one then executed. A booked order can end at once without
 * executing (SIM-1 O2: a FOK that cannot fill whole is booked `REJECTED` with
 * nothing filled; O1: a FAK's unfilled remainder is `CANCELLED`), and on a
 * delayed market every marketable order is booked `DELAYED` and only reaches
 * its outcome at `matchableAtNs` (O5). So a basket whose YES leg FILLED and
 * whose NO leg was REJECTED is answered `accepted: true` — and is exactly the
 * half-built basket §7.7's `failurePolicy` exists for. Nothing in this process
 * consumes `failurePolicy` yet, so the trader halts such a basket's markets;
 * this function is the rule it halts by, judged from EACH ORDER'S OWN outcome.
 *
 * THE RULE. A basket is PARTIALLY EXECUTED when
 *
 * - (a) the venue booked some of it and did NOT place the rest (a `PARTIAL`
 *   answer: `notPlaced` is non-empty) — R3's rule, unchanged; or
 * - (b) a booked order is TERMINAL SHORT of its size — `REJECTED`,
 *   `CANCELLED` or `EXPIRED` with `filledShares < requestedShares` — while
 *   some part of the basket EXECUTED (an order with a fill) or can still
 *   execute (an order that is not terminal).
 *
 * A basket that executed NOTHING — every booked order terminal with no fill —
 * is, like a wholly refused plan, not partial: there is no leg to unwind or
 * hold, and its capital comes back through the ordinary terminal release. A
 * basket whose every booked order FILLED is COMPLETE. Anything else is still
 * WORKING and is judged again when its orders move.
 *
 * FAIL-CLOSED. An order the venue's state does not list (`undefined`) is
 * treated as still working — never as settled — and a quantity that is not a
 * canonical decimal is read as "executed" and as "short", so an unreadable
 * order can only ever cause a halt, never hide one.
 */

import { compareDecimal, isCanonicalDecimalString } from "@polymarket-bot/decimal";
import type { SimulatedOrder } from "@polymarket-bot/simulation";

import { isTerminalStatus, toStrategyOrderView } from "./orders.js";

export type BasketExecutionVerdict =
  /** Something can still execute and nothing ended short yet: judge again later. */
  | { readonly kind: "WORKING" }
  /** Every booked order is terminal: all of them FILLED, or none of them executed anything. */
  | { readonly kind: "COMPLETE" }
  /** The basket executed only IN PART; halt its markets (nothing consumes `failurePolicy`). */
  | {
      readonly kind: "PARTIALLY_EXECUTED";
      /** Rule (a): the venue's answer did not place every planned order. */
      readonly notAllPlaced: boolean;
      /** Rule (b): the booked orders that ended terminal short of their size. */
      readonly endedShort: readonly SimulatedOrder[];
    };

export function judgeBasketExecution(input: {
  /** The orders the venue BOOKED for the basket, as it holds them now (`undefined`: not listed). */
  readonly booked: readonly (SimulatedOrder | undefined)[];
  /** How many of the basket's planned orders the venue did NOT place. */
  readonly notPlaced: number;
}): BasketExecutionVerdict {
  const endedShort: SimulatedOrder[] = [];
  let executedOrWorking = false;
  let allTerminal = true;
  for (const order of input.booked) {
    if (order === undefined) {
      executedOrWorking = true;
      allTerminal = false;
      continue;
    }
    const terminal = isTerminal(order);
    if (!terminal) {
      executedOrWorking = true;
      allTerminal = false;
    }
    if (hasFill(order)) executedOrWorking = true;
    if (terminal && isShort(order)) endedShort.push(order);
  }
  const notAllPlaced = input.booked.length > 0 && input.notPlaced > 0;
  if (notAllPlaced || (endedShort.length > 0 && executedOrWorking)) {
    return Object.freeze({
      kind: "PARTIALLY_EXECUTED",
      notAllPlaced,
      endedShort: Object.freeze(endedShort),
    });
  }
  return allTerminal ? Object.freeze({ kind: "COMPLETE" }) : Object.freeze({ kind: "WORKING" });
}

function isTerminal(order: SimulatedOrder): boolean {
  // The trader's ONE terminal definition (the strategy's order machine), so a
  // basket is judged terminal exactly when its orders' capital is released.
  return isTerminalStatus(toStrategyOrderView(order, { marketId: order.marketId, placedAt: "" }).status);
}

/** A fill was booked for it. An unreadable quantity counts as one (fail-closed). */
function hasFill(order: SimulatedOrder): boolean {
  if (!isCanonicalDecimalString(order.filledShares)) return true;
  return compareDecimal(order.filledShares, "0") > 0;
}

/** It holds less than it asked for. An unreadable quantity counts as short (fail-closed). */
function isShort(order: SimulatedOrder): boolean {
  if (!isCanonicalDecimalString(order.filledShares) || !isCanonicalDecimalString(order.requestedShares)) {
    return true;
  }
  return compareDecimal(order.filledShares, order.requestedShares) < 0;
}
