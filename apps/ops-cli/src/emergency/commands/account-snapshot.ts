/**
 * account-snapshot: the account's venue truth, read now, with the emergency
 * credential, through WP-310's budget at `RECONCILIATION_READ`. Read-only:
 * nothing is sent but reads, nothing is written but the audit trail.
 *
 * | Read | Route | Why this one |
 * | --- | --- | --- |
 * | open orders | `/data/orders` | "Retrieves live orders for the authenticated user" (E-14) |
 * | positions | `/v2/positions` | Data API v2 only (E-15, V3-E15): v1 retires 2026-10-24 |
 * | collateral | on-chain ERC-20 balance | the CLOB balance cache is not current (U-22, §W.9; WP-290) |
 * | approvals | `/v2/approvals` | §W.8 |
 *
 * An answer tagged with another route is refused, never read as empty.
 */

import { type CommandContext, type CommandResult, printedIds } from "../context.js";
import { EMERGENCY_OPERATIONS, READ_PRIORITY } from "../budget.js";
import { SECTIONS } from "../printer.js";
import type { VenueSession } from "../session.js";
import { EMERGENCY_VENUE_FACTS } from "../venue-facts.js";
import { checkApprovals, checkCollateral, checkOpenOrders, checkPositions, readChecked, ROUTES, type Checked } from "../venue-truth.js";

function status<T>(read: Checked<T>): string {
  if (read.kind === "READ") return read.complete ? "READ" : "READ (INCOMPLETE)";
  return `${read.kind}: ${read.problem}`;
}

export async function runAccountSnapshot(context: CommandContext, session: VenueSession): Promise<CommandResult> {
  const { parsed, printer } = context;
  printer.section(SECTIONS.PLAN, [
    `account ${parsed.accountRef}: signer ${session.identity.signerAddress}, wallet ${session.identity.walletAddress}; reads use the emergency credential (${EMERGENCY_VENUE_FACTS.READS_PER_CREDENTIAL.section})`,
    `read ${ROUTES.OPEN_ORDERS} (${EMERGENCY_OPERATIONS.OPEN_ORDERS} at ${READ_PRIORITY})`,
    `read ${ROUTES.POSITIONS} (${EMERGENCY_OPERATIONS.POSITIONS} at ${READ_PRIORITY}); Data API /v2 only (${EMERGENCY_VENUE_FACTS.DATA_API_V2_ONLY.section})`,
    `read the collateral balance on chain (${ROUTES.COLLATERAL}); never the CLOB balance cache`,
    `read ${ROUTES.APPROVALS} (${EMERGENCY_OPERATIONS.APPROVALS} at ${READ_PRIORITY})`,
    "nothing is sent but these reads; nothing is written but the audit trail",
  ]);

  const orders = await readChecked(() => session.reads.listOpenOrders(), checkOpenOrders);
  const positions = await readChecked(() => session.reads.readPositions(), checkPositions);
  const collateral = await readChecked(() => session.reads.readCollateral(), checkCollateral);
  const approvals = await readChecked(() => session.reads.readApprovals(), checkApprovals);

  const result: string[] = [`open orders: ${status(orders)}`];
  if (orders.kind === "READ") {
    for (const order of orders.value) {
      result.push(`  order ${order.venueOrderId}: ${order.status} ${order.side} ${order.originalSize} of token ${order.tokenId} at ${order.price}, matched ${order.sizeMatched}`);
    }
  }
  result.push(`positions (${ROUTES.POSITIONS}): ${status(positions)}`);
  if (positions.kind === "READ") for (const line of positions.value) result.push(`  token ${line.tokenId}: ${line.size}`);
  result.push(`collateral (${ROUTES.COLLATERAL}): ${status(collateral)}`);
  if (collateral.kind === "READ") result.push(`  asset ${collateral.value.assetId}: ${collateral.value.balance}`);
  result.push(`approvals (${ROUTES.APPROVALS}): ${status(approvals)}`);
  if (approvals.kind === "READ") for (const line of approvals.value) result.push(`  spender ${line.spender}: ${line.approved ? "approved" : "NOT approved"}`);
  for (const record of session.readLog) {
    if (!record.sent) result.push(`${record.read} was NOT SENT: ${record.note ?? "not granted"}`);
  }
  printer.section(SECTIONS.RESULT, result);

  const reads = [orders, positions, collateral, approvals];
  const unknown: string[] = [];
  const names = ["open orders", "positions", "collateral", "approvals"];
  reads.forEach((read, index) => {
    if (read.kind !== "READ") unknown.push(`${names[index] ?? "a read"}: not read (${read.problem})`);
    else if (!read.complete) unknown.push(`${names[index] ?? "a read"}: the venue marked the answer incomplete`);
  });
  unknown.push("orders in flight, trades not yet settled and holdings in transit are not shown as such: a snapshot is not a reconciliation (run reconcile)");
  printer.section(SECTIONS.UNKNOWN, unknown);

  const complete = reads.every((read) => read.kind === "READ" && read.complete);
  return {
    exit: complete ? "COMPLETED" : "READ_INCOMPLETE",
    result: {
      openOrders: orders.kind === "READ" ? { count: orders.value.length, ids: printedIds(orders.value.map((order) => order.venueOrderId)) } : orders.kind,
      positions: positions.kind === "READ" ? positions.value.length : positions.kind,
      collateral: collateral.kind === "READ" ? collateral.value.balance : collateral.kind,
      approvals: approvals.kind === "READ" ? approvals.value.length : approvals.kind,
      reads: session.readLog.map((record) => ({ read: record.read, sent: record.sent, outcome: record.outcome })),
    },
  };
}
