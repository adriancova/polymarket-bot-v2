/**
 * WP-340: the end-state oracle every chaos run is held to. It reads only the
 * world (the mock CLOB's ground truth, the OMS store, the journal's durable
 * events, the ledger, the inventory) and the restarted process's own views;
 * nothing here asks the system under test whether it is right.
 *
 * - NO DUPLICATE EXPOSURE: the mock CLOB saw no S2 (a new salt signed while
 *   another of its group was live or travelling), no DUPLICATE_EXPOSURE (two
 *   live orders of one group) and no OVER_EXPOSURE (more than the group's
 *   planned shares exposed), at any instant of the run;
 * - RESUMED ONLY WHEN CONSISTENT (WP-290's R1) and every accepted answer
 *   true when given (R2, R3), at every resume of every incarnation;
 * - CONSISTENT AT THE END: WP-290's `consistencyProblems` (every venue order
 *   of ours tracked exactly once, its recorded fills equal to what the venue
 *   matched, nothing travelling, no attempt awaiting a read, the ledger's
 *   holdings equal to the venue's, reservations conserved);
 * - NOTHING LOST: every salt the venue received is known to the OMS;
 * - RESERVATIONS CONSERVED, exactly, for every order, and every closed
 *   order's unused remainder released. Read against WP-300's inventory book,
 *   which the harness carries across every crash IN MEMORY: WP-300 has no
 *   journal rebuild (`WP300-PERSIST`), so this holds only under that
 *   surviving-inventory assumption (`live-node.ts`, `LiveWorld`; report §2);
 * - NO SIGNATURE IN CLEAR: no signature the mock signer produced appears in
 *   the OMS store, the journal's durable events or the ledger;
 * - the journal's durable history replays.
 */

import { expect } from "vitest";

import { addDecimal, subDecimal } from "../../../../packages/decimal/src/index.js";
import { projectedHoldings, projectLedger, ReconciliationJournal } from "../../../../packages/ledger/src/index.js";
import type { OrderManager } from "../../../../packages/oms/src/index.js";
import { ACCOUNT, consistencyProblems } from "../../reconciliation/support/harness.js";

import type { LiveNode, LiveWorld } from "./live-node.js";

/** Every place a signed payload could leak to at rest. */
export function atRest(world: LiveWorld): string {
  return [world.u.store.serialized(), JSON.stringify(world.u.journalEvents), JSON.stringify(world.u.ledger.transactions())].join("\n");
}

/** The signatures (of the ones the venue issued) that appear in `text`. */
export function signaturesIn(world: LiveWorld, text: string): string[] {
  return [...world.clob.signatures.values()].filter((signature) => text.includes(signature) || text.includes(signature.slice(2)));
}

export interface RecoveryExpectations {
  /** A truthful world needs no UNATTRIBUTED booking and no halt (default true). */
  readonly truthful?: boolean;
}

/** The oracle's violations, without asserting (for property runs that report a seed). */
export function recoveryProblems(world: LiveWorld, node: LiveNode, resumed: boolean, expectations: RecoveryExpectations = {}): string[] {
  const { u, clob } = world;
  const problems: string[] = [];
  const oms = node.oms as OrderManager | null;
  if (oms === null) return ["the restarted process has no OMS"];
  if (!resumed) problems.push("LIVENESS: the restarted coordinator never resumed");
  for (const violation of [...u.violations, ...clob.violations]) problems.push(`ORACLE: ${violation}`);
  for (const problem of consistencyProblems(u, oms)) problems.push(`CONSISTENCY: ${problem}`);
  if (oms.paused) problems.push("submissions are still paused");
  const known = new Set(oms.attempts().map((attempt) => attempt.salt));
  for (const salt of new Set(clob.receipts)) if (!known.has(salt)) problems.push(`LOST: salt ${salt} reached the venue and is unknown to the OMS`);
  for (const order of oms.orders()) {
    const reservation = u.inventory.book.reservation(order.reservation.reservationId);
    if (reservation === undefined) {
      if (order.reservation.consumed !== "0") problems.push(`RESERVATION: ${order.orderId} consumed ${order.reservation.consumed} with no reservation`);
      continue;
    }
    if (addDecimal(addDecimal(reservation.consumed, reservation.released), reservation.remaining) !== reservation.amount) problems.push(`RESERVATION: ${reservation.reservationId} not conserved`);
    if (reservation.consumed !== order.reservation.consumed) problems.push(`RESERVATION: ${reservation.reservationId} consumed ${reservation.consumed}, the OMS says ${order.reservation.consumed}`);
    const closed = ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(order.state) && order.finalSize !== null && order.filledShares === order.finalSize;
    if (closed && reservation.released !== subDecimal(reservation.amount, reservation.consumed)) problems.push(`RESERVATION: closed order ${order.orderId} kept ${reservation.remaining} reserved`);
  }
  for (const problem of u.inventory.book.checkInvariants()) problems.push(`INVENTORY: ${JSON.stringify(problem)}`);
  const leaked = signaturesIn(world, atRest(world));
  if (leaked.length > 0) problems.push(`SIGNATURE IN CLEAR: ${String(leaked.length)} signature(s) at rest`);
  if (node.signer.refusals !== 0) problems.push("the mock signer was asked to sign something that is not a fixture");
  const replay = ReconciliationJournal.open({ accountRef: ACCOUNT, sink: { append: async () => undefined }, history: u.journalEvents });
  if (!replay.ok) problems.push("the journal's durable history does not replay");
  if (expectations.truthful !== false) {
    if (projectedHoldings(projectLedger(u.ledger), ACCOUNT).unattributedArrivals.length > 0) problems.push("UNATTRIBUTED bookings in a truthful world");
    // A halt is excused only when its break is a WP340-F1 quarantine the recovery driver released (`releaseKnownFindings`).
    const excused = new Set(world.findings.map((entry) => entry.breakId));
    const halts = u.halts.filter((halt) => !excused.has(halt.breakId));
    if (halts.length > 0) problems.push(`halts in a truthful world: ${JSON.stringify(halts.map((halt) => halt.marketId))}`);
    if (replay.ok && replay.value.unresolvedBreaks().length > 0) problems.push(`unresolved breaks: ${replay.value.unresolvedBreaks().map((view) => view.breakClass).join(", ")}`);
  }
  return problems;
}

export function expectRecovered(label: string, world: LiveWorld, node: LiveNode, resumed: boolean, expectations: RecoveryExpectations = {}): void {
  expect(recoveryProblems(world, node, resumed, expectations), label).toEqual([]);
}
