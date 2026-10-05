/**
 * Venue truth, read through WP-290's `AccountReadPort` and checked here
 * before it is printed or acted on (WP-330: "venue-truth account snapshot …
 * independent of trader memory").
 *
 * Every answer is read as OWN DATA, once, field by field (no getter, no
 * inherited field, no iterator), and checked against its route tag:
 *
 * | Read | Route tag | Source |
 * | --- | --- | --- |
 * | open orders | `/data/orders` | `docs/venue/verified-2026-09-30.md` §11 E-14 (S-D55) |
 * | positions | `/v2/positions` ONLY | E-15: "use `/v2` only" (V3-E15) |
 * | approvals | `/v2/approvals` ONLY | §W.8 (S-D62) |
 * | collateral | `ONCHAIN_ERC20_BALANCE` | WP-290: the CLOB balance cache is not accepted (U-22, §W.9) |
 *
 * An answer tagged with any other route (a Data API v1 route, the CLOB
 * balance cache) is REFUSED, never read as empty. Exact decimals stay
 * canonical decimal strings (ADR-001); nothing here parses a price or a size
 * into a binary number.
 */

import { compareDecimal, isCanonicalDecimalString, type DecimalString } from "@polymarket-bot/decimal";
import { MAX_READ_ENTRIES, type AccountReadPort, type VenueOrderView } from "@polymarket-bot/oms";
import { SecureVenueError } from "@polymarket-bot/polymarket-secure";

import { withinBound } from "./bounded.js";
import { EMERGENCY_OPERATIONS, READ_PRIORITY, type EmergencyBudget } from "./budget.js";
import { VENUE_ORDER_ID } from "./grammar.js";

export const ROUTES = Object.freeze({
  OPEN_ORDERS: "/data/orders",
  POSITIONS: "/v2/positions",
  APPROVALS: "/v2/approvals",
  COLLATERAL: "ONCHAIN_ERC20_BALANCE",
} as const);

const TOKEN_ID = /^(?:0|[1-9][0-9]{0,199})$/u;

/** Text of 1–200 characters with no ASCII control character (the database's `internal.identifier`). */
function isIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export type Checked<T> =
  | { readonly kind: "READ"; readonly value: T; readonly complete: boolean }
  | { readonly kind: "REFUSED"; readonly problem: string }
  | { readonly kind: "FAILED"; readonly problem: string };

// ---------------------------------------------------------------------------
// Own-data reading.

const OPAQUE = Symbol("opaque");

function own(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return OPAQUE;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) return undefined;
    return "value" in descriptor ? descriptor.value : OPAQUE;
  } catch {
    return OPAQUE;
  }
}

function ownList(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = own(value, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_READ_ENTRIES) return undefined;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = own(value, String(index));
      if (entry === OPAQUE || entry === undefined) return undefined;
      out.push(entry);
    }
    return out;
  } catch {
    return undefined;
  }
}

function routeProblem(answer: unknown, field: "route" | "source", expected: string): string | undefined {
  const route = own(answer, field);
  if (route === expected) return undefined;
  if (typeof route === "string") return `the answer names ${field} ${route.slice(0, 64)}, not ${expected}: refused, never read as empty`;
  return `the answer's ${field} is unreadable: refused`;
}

// ---------------------------------------------------------------------------
// The checks.

/** One open order, checked; `undefined` when any field is not as `AccountReadPort` documents it. */
function checkOrder(row: unknown): VenueOrderView | undefined {
  const venueOrderId = own(row, "venueOrderId");
  const tokenId = own(row, "tokenId");
  const side = own(row, "side");
  const price = own(row, "price");
  const originalSize = own(row, "originalSize");
  const sizeMatched = own(row, "sizeMatched");
  const status = own(row, "status");
  if (typeof venueOrderId !== "string" || !VENUE_ORDER_ID.test(venueOrderId)) return undefined;
  if (typeof tokenId !== "string" || !TOKEN_ID.test(tokenId)) return undefined;
  if (side !== "BUY" && side !== "SELL") return undefined;
  if (!isCanonicalDecimalString(price, { range: "UNIT_INTERVAL" })) return undefined;
  if (!isCanonicalDecimalString(originalSize, { range: "POSITIVE" })) return undefined;
  if (!isCanonicalDecimalString(sizeMatched, { range: "NON_NEGATIVE" })) return undefined;
  if (compareDecimal(sizeMatched, originalSize) > 0) return undefined;
  if (!isIdentifier(status)) return undefined;
  return Object.freeze({ venueOrderId, tokenId, side, price, originalSize, sizeMatched, status });
}

/** `/data/orders`: every open order of the account. */
export function checkOpenOrders(answer: unknown): Checked<readonly VenueOrderView[]> {
  const route = routeProblem(answer, "route", ROUTES.OPEN_ORDERS);
  if (route !== undefined) return { kind: "REFUSED", problem: route };
  const complete = own(answer, "complete");
  if (typeof complete !== "boolean") return { kind: "REFUSED", problem: "the open-orders answer does not say whether it is complete" };
  const rows = ownList(own(answer, "orders"));
  if (rows === undefined) return { kind: "REFUSED", problem: "the open orders are not a list of own-data rows" };
  const orders: VenueOrderView[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const order = checkOrder(row);
    if (order === undefined) return { kind: "REFUSED", problem: "an open order is not an order (id, token, side, exact price and sizes, status)" };
    if (seen.has(order.venueOrderId)) return { kind: "REFUSED", problem: `order ${order.venueOrderId} is listed twice` };
    seen.add(order.venueOrderId);
    orders.push(order);
  }
  return { kind: "READ", value: Object.freeze(orders), complete };
}

export interface PositionLine {
  readonly tokenId: string;
  readonly size: DecimalString;
}

/** `/v2/positions` only (E-15). */
export function checkPositions(answer: unknown): Checked<readonly PositionLine[]> {
  const route = routeProblem(answer, "route", ROUTES.POSITIONS);
  if (route !== undefined) return { kind: "REFUSED", problem: route };
  const complete = own(answer, "complete");
  if (typeof complete !== "boolean") return { kind: "REFUSED", problem: "the positions answer does not say whether it is complete" };
  const rows = ownList(own(answer, "positions"));
  if (rows === undefined) return { kind: "REFUSED", problem: "the positions are not a list of own-data rows" };
  const lines: PositionLine[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const tokenId = own(row, "tokenId");
    const size = own(row, "size");
    if (typeof tokenId !== "string" || !TOKEN_ID.test(tokenId) || !isCanonicalDecimalString(size, { range: "NON_NEGATIVE" })) {
      return { kind: "REFUSED", problem: "a position is not a token id with an exact non-negative size" };
    }
    if (seen.has(tokenId)) return { kind: "REFUSED", problem: `position ${tokenId} is listed twice` };
    seen.add(tokenId);
    lines.push(Object.freeze({ tokenId, size }));
  }
  return { kind: "READ", value: Object.freeze(lines), complete };
}

export interface CollateralLine {
  readonly assetId: string;
  readonly balance: DecimalString;
}

/** The on-chain collateral balance (never the CLOB balance cache). */
export function checkCollateral(answer: unknown): Checked<CollateralLine> {
  const source = routeProblem(answer, "source", ROUTES.COLLATERAL);
  if (source !== undefined) return { kind: "REFUSED", problem: source };
  const assetId = own(answer, "assetId");
  const balance = own(answer, "balance");
  if (!isIdentifier(assetId) || !isCanonicalDecimalString(balance, { range: "NON_NEGATIVE" })) {
    return { kind: "REFUSED", problem: "the collateral answer is not an asset with an exact non-negative balance" };
  }
  return { kind: "READ", value: Object.freeze({ assetId, balance }), complete: true };
}

export interface ApprovalLine {
  readonly spender: string;
  readonly approved: boolean;
}

/** `/v2/approvals` only. */
export function checkApprovals(answer: unknown): Checked<readonly ApprovalLine[]> {
  const route = routeProblem(answer, "route", ROUTES.APPROVALS);
  if (route !== undefined) return { kind: "REFUSED", problem: route };
  const rows = ownList(own(answer, "approvals"));
  if (rows === undefined) return { kind: "REFUSED", problem: "the approvals are not a list of own-data rows" };
  const lines: ApprovalLine[] = [];
  for (const row of rows) {
    const spender = own(row, "spender");
    const approved = own(row, "approved");
    if (!isIdentifier(spender) || typeof approved !== "boolean") {
      return { kind: "REFUSED", problem: "an approval is not a spender with a boolean" };
    }
    lines.push(Object.freeze({ spender, approved }));
  }
  return { kind: "READ", value: Object.freeze(lines), complete: true };
}

// ---------------------------------------------------------------------------
// Reads through the budget.

export interface ReadRecord {
  readonly read: string;
  readonly operationId: string | null;
  readonly sent: boolean;
  readonly outcome: "ANSWERED" | "FAILED" | "NOT_SENT";
  readonly note: string | null;
}

/** A read the budget did not grant: never sent. */
export class ReadNotSentError extends Error {
  override readonly name = "ReadNotSentError";
}

/** A read that got no answer within `venueAnswerBoundMs`: missing, never empty. */
export class ReadUnansweredError extends Error {
  override readonly name = "ReadUnansweredError";
}

type ReadMethod = keyof AccountReadPort;

/** Which budget operation each read is charged to; `null`: an on-chain read with no venue route. */
export const READ_OPERATIONS: Readonly<Record<ReadMethod, string | null>> = Object.freeze({
  listOpenOrders: EMERGENCY_OPERATIONS.OPEN_ORDERS,
  readOrder: EMERGENCY_OPERATIONS.ORDER_BY_ID,
  listTrades: EMERGENCY_OPERATIONS.TRADES,
  readPositions: EMERGENCY_OPERATIONS.POSITIONS,
  readApprovals: EMERGENCY_OPERATIONS.APPROVALS,
  readCollateral: null,
  readWalletMember: null,
});

function errorOfRead(error: unknown): { readonly kind: string; readonly retryAfterSeconds: number | null } {
  return error instanceof SecureVenueError ? { kind: error.kind, retryAfterSeconds: error.retryAfterSeconds } : { kind: "READ_FAILED", retryAfterSeconds: null };
}

/**
 * The reads, each granted by the budget at `RECONCILIATION_READ` before it is
 * sent and completed with its answer. A read the budget does not grant is not
 * sent and REJECTS (WP-290's coordinator reads a rejection as a missing read,
 * never as an empty one).
 */
export function budgetedReads(reads: AccountReadPort, budget: EmergencyBudget, log: ReadRecord[], boundMs: number): AccountReadPort {
  const answerOf = async <T>(read: ReadMethod, call: () => Promise<T>): Promise<T> => {
    const bounded = await withinBound(boundMs, call);
    if (bounded.kind === "UNANSWERED") throw new ReadUnansweredError(`${read} got no answer within venueAnswerBoundMs (${String(boundMs)} ms)`);
    return bounded.value;
  };
  const through = async <T>(read: ReadMethod, call: () => Promise<T>): Promise<T> => {
    const operationId = READ_OPERATIONS[read];
    if (operationId === null) {
      try {
        const answer = await answerOf(read, call);
        log.push({ read, operationId, sent: true, outcome: "ANSWERED", note: "on-chain read: no venue rate-limit operation" });
        return answer;
      } catch (error) {
        log.push({ read, operationId, sent: true, outcome: "FAILED", note: error instanceof ReadUnansweredError ? error.message : "on-chain read failed" });
        throw error;
      }
    }
    const acquired = await budget.acquire({ operationId, priority: READ_PRIORITY });
    if (acquired.kind !== "GRANTED") {
      const note = acquired.kind === "REFUSED" ? `the budget refused it (${acquired.code})` : `the budget's wait would exceed the bound (${String(acquired.waitedMs)} ms waited)`;
      log.push({ read, operationId, sent: false, outcome: "NOT_SENT", note });
      throw new ReadNotSentError(`${read} was not sent: ${note}`);
    }
    try {
      const answer = await answerOf(read, call);
      budget.complete(acquired.grant, { error: null });
      log.push({ read, operationId, sent: true, outcome: "ANSWERED", note: null });
      return answer;
    } catch (error) {
      budget.complete(acquired.grant, { error: error instanceof ReadUnansweredError ? { kind: "UNANSWERED", retryAfterSeconds: null } : errorOfRead(error) });
      log.push({ read, operationId, sent: true, outcome: "FAILED", note: error instanceof SecureVenueError ? error.kind : error instanceof ReadUnansweredError ? error.message : null });
      throw error;
    }
  };
  return Object.freeze({
    listOpenOrders: () => through("listOpenOrders", () => reads.listOpenOrders()),
    readOrder: (venueOrderId: string) => through("readOrder", () => reads.readOrder(venueOrderId)),
    listTrades: () => through("listTrades", () => reads.listTrades()),
    readPositions: () => through("readPositions", () => reads.readPositions()),
    readCollateral: () => through("readCollateral", () => reads.readCollateral()),
    readApprovals: () => through("readApprovals", () => reads.readApprovals()),
    readWalletMember: (member: { readonly kind: "HASH" | "RELAYER_ID"; readonly value: string }) => through("readWalletMember", () => reads.readWalletMember(member)),
  });
}

/** Read and check one answer; a rejection or throw is FAILED, never empty. */
export async function readChecked<T>(read: () => Promise<unknown>, check: (answer: unknown) => Checked<T>): Promise<Checked<T>> {
  let answer: unknown;
  try {
    answer = await read();
  } catch (error) {
    return { kind: "FAILED", problem: error instanceof ReadNotSentError || error instanceof ReadUnansweredError ? error.message : "the read failed or was not answered" };
  }
  try {
    return check(answer);
  } catch {
    return { kind: "REFUSED", problem: "the answer could not be read" };
  }
}

/** `/data/order` by id: the order's status, or that the venue does not show it. */
export function checkOrderById(answer: unknown, venueOrderId: string): Checked<VenueOrderView | null> {
  const route = routeProblem(answer, "route", "/data/order");
  if (route !== undefined) return { kind: "REFUSED", problem: route };
  const found = own(answer, "found");
  if (found === false) return { kind: "READ", value: null, complete: true };
  if (found !== true) return { kind: "REFUSED", problem: "the by-id answer does not say whether the order was found" };
  const order = checkOrder(own(answer, "order"));
  if (order === undefined) return { kind: "REFUSED", problem: "the by-id answer's order is not an order" };
  if (order.venueOrderId !== venueOrderId) return { kind: "REFUSED", problem: "the by-id answer names another order" };
  return { kind: "READ", value: order, complete: true };
}
