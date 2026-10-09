/**
 * The execution-plan contract, and THE SINGLE EMISSION BOUNDARY.
 *
 * Handoff §9.10: "Converts approved intents into immutable execution plans."
 * The execution hierarchy (Decision → Intent → Approved Intent → Execution
 * Plan → Execution Group → Submission Attempt → …) is load-bearing for §6
 * invariant 4's fill traceability, so every plan carries its approved-intent
 * lineage verbatim, and groups/orders/reservations derive their identifiers
 * from the plan's own.
 *
 * WHAT IS STRUCTURAL RATHER THAN CHECKED-LATER:
 *
 * - **Deadline and price protection exist on every plan** (workplan acceptance
 *   2): `deadline` and `priceProtection` are REQUIRED fields of every variant,
 *   every planned order's `limitPrice` is REQUIRED, and {@link sealExecutionPlan}
 *   refuses a draft missing either — construction is impossible, not flagged.
 *   A cancel plan's protection is the strongest expressible:
 *   `NO_NEW_ORDERS` — it places nothing, at any price.
 * - **A coordinated basket is NEVER atomic** (workplan acceptance 3; §7.7
 *   "Basket execution is coordinated, not assumed atomic"): the type admits
 *   only the literal `"COORDINATED"`, and the seal refuses `"ATOMIC"` BY NAME
 *   (`PLAN_ATOMIC_LABEL_FORBIDDEN`) so a hand-built draft cannot smuggle the
 *   label through as a generic shape error nobody alerts on.
 * - **Reservation precedes submission** (§9.10; binding constraint 2): every
 *   planned order carries a `reservationId`, the plan carries the matching
 *   `ReservationRequirement` (the allocator's request shape, consumed
 *   structurally — no §2.1 edge exists), the literal `reservationRule` states
 *   the ordering, and the seal enforces the order↔reservation bijection with
 *   matching economics.
 * - **Estimates are labeled estimates**: the only shape `estimates` admits
 *   carries `basis: "ESTIMATE"`.
 * - **Safety cancellation outranks placement** (§6 invariant 13): `priority`
 *   is a literal per variant, the seal refuses a mislabeled draft in BOTH
 *   directions, and {@link comparePlanPriority} gives rate-limit scheduling
 *   the ordering the invariant demands.
 * - **Plans are immutable once built**: the sealed value is a deeply frozen
 *   materialized tree that shares no object with the draft.
 */

import { addDecimal, compareDecimal, subDecimal } from "@polymarket-bot/decimal";
import { RUN_MODES, type RunMode } from "@polymarket-bot/domain";
import { readPlainData } from "@polymarket-bot/risk/plain-data";

import { InternalMarketIdDoor, IsoTimestampDoor } from "./doors.js";
import { deepFreeze, uuidShapedNotCanonical } from "./guards.js";
import type { ScopeAttribution } from "./inputs.js";
import {
  contained,
  plannerFailure,
  plannerRefusal,
  type PlannerRefusal,
  type PlannerResult,
} from "./refusals.js";
import { isOnSizeGrid, sizeGridFor } from "./quantity.js";
import { isOnTick } from "./tick.js";
import { instantMilliseconds } from "./time.js";
import {
  asArray,
  asDecimal,
  asIdentifier,
  asMember,
  asNonNegativeInteger,
  asOpenUnitPrice,
  asPositiveInteger,
  asRecord,
  problem,
  requireKnownKeys,
  type Problem,
} from "./validate.js";

export type PlanPriority = "SAFETY_CANCEL" | "PLACEMENT";

/**
 * §6 invariant 13: "Safety cancellation outranks new order placement.
 * Rate-limit scheduling reflects this priority." Lower rank schedules first.
 */
export const PLAN_PRIORITY_RANK: Readonly<Record<PlanPriority, number>> = Object.freeze({
  SAFETY_CANCEL: 0,
  PLACEMENT: 1,
});

/** Three-way scheduling comparison; negative means `left` schedules first. */
export function comparePlanPriority(left: PlanPriority, right: PlanPriority): -1 | 0 | 1 {
  const a = PLAN_PRIORITY_RANK[left];
  const b = PLAN_PRIORITY_RANK[right];
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface PlanEstimates {
  /** ESTIMATES, labeled as such (§9.10): projections, never accounting facts. */
  readonly basis: "ESTIMATE";
  readonly worstCaseCost: string;
  readonly expectedProceeds: string;
  readonly fees: string;
  readonly slippage: string;
}

/**
 * What the quantizer could not execute of a leg (ADR-034 D2.3), recorded on
 * the leg's LAST planned order. It keeps both numbers of the intent-to-plan
 * link: the leg's requested quantity and its executable one (the sum of the
 * group's orders). Present only when the request was off the venue's grid,
 * so an on-grid plan is byte-identical to what it was before D2.
 */
export interface UnexecutableRemainder {
  readonly reason: "SUB_GRID";
  /** The remainder's unit. Shares only, until a collateral-targeted order exists (ADR-034 D4, round R3). */
  readonly unit: "SHARES";
  /** `requested − executable`: strictly between 0 and the grid. */
  readonly quantity: string;
  /** What the intent asked of this leg. */
  readonly requested: string;
  /** The leg's executable quantity: the requested one floored to the grid; the sum of its group's orders. */
  readonly executable: string;
}

export interface PlannedOrder {
  readonly plannedOrderId: string;
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  /** REQUIRED: every planned order is a capped limit order (acceptance 2). */
  readonly limitPrice: string;
  /**
   * The ONE executable quantity (ADR-034 D2.5): on the venue's grid for the
   * group's tick size, and exactly the reservation basis, the OMS ticket,
   * the signed share amount and the size the venue books.
   */
  readonly shares: string;
  readonly postOnly: boolean;
  readonly executionStyle: "REST" | "MARKETABLE_LIMIT";
  /** The reservation that must be APPLIED before this order is submitted. */
  readonly reservationId: string;
  /** ADR-034 D2.3: only on a leg's last order, only when its request was off the grid. */
  readonly unexecutableRemainder?: UnexecutableRemainder;
}

export interface ExecutionGroup {
  readonly executionGroupId: string;
  readonly marketId: string;
  /** The versioned parameters the prices were computed under (§6 invariant 9). */
  readonly tickSize: string;
  readonly minimumOrderSize: string;
  readonly orders: readonly PlannedOrder[];
}

/**
 * The allocator's `ReservationRequest` shape, mirrored STRUCTURALLY
 * (`packages/capital-allocator/src/reserve.ts` at `98a6cc1`; no §2.1 edge
 * exists, and `test/unit/execution-planner/ports.test.ts` parses these
 * through the REAL allocator to pin the port).
 */
export interface ReservationRequirement {
  readonly reservationId: string;
  readonly strategyInstanceId: string;
  readonly runMode: RunMode;
  readonly accountingMode: "LIVE" | "SHADOW";
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: string;
  readonly scope?: ScopeAttribution;
}

export interface PlanProvenance {
  readonly approvedAt: string;
  readonly lineage: "ORIGINAL" | "RESIZED";
  /**
   * WP-180 `follow_up` 3: a record with `INHERITED_UPPER_BOUND` was not
   * re-evaluated against a fresh portfolio; the planner cannot re-run the
   * risk engine (no edge), so the plan RECORDS the basis it acted on.
   */
  readonly worstCaseBasis: "EVALUATED" | "INHERITED_UPPER_BOUND";
}

export interface PartialFillHandling {
  readonly policy: "REJECT" | "ACCEPT_ANY" | "ACCEPT_MINIMUM";
  readonly minimumFillShares?: string;
}

export interface ReplaceHysteresis {
  readonly replaceThresholdTicks: number;
  readonly minimumReplaceIntervalMs: number;
}

export type LegSelectionChoice = "BUY_DIRECTION" | "SELL_OPPOSITE" | "SELL_DIRECTION";
export type LegSelectionReason =
  | "DIRECT"
  | "CHEAPER_EXPOSURE"
  | "ONLY_FEASIBLE"
  | "INVENTORY_FALLBACK";

export interface LegSelection {
  readonly selected: LegSelectionChoice;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  /** Per-share cost of the exposure this leg buys (SELL_OPPOSITE: 1 − price). */
  readonly effectiveExposurePrice: string;
  readonly reason: LegSelectionReason;
}

interface PlanBase {
  readonly executionPlanId: string;
  readonly approvedIntentId: string;
  readonly rootApprovedIntentId: string;
  readonly sourceIntentId?: string;
  readonly strategyInstanceId: string;
  readonly runMode: RunMode;
  readonly plannedAt: string;
  /** REQUIRED on every plan (acceptance 2). Strictly after `plannedAt`. */
  readonly deadline: string;
  readonly provenance: PlanProvenance;
}

export interface PlacementPlan extends PlanBase {
  readonly planKind: "POSITION" | "REDUCE_POSITION";
  readonly priority: "PLACEMENT";
  readonly priceProtection: { readonly mode: "CAPPED_LIMIT_ORDERS_ONLY" };
  readonly escalation: { readonly atDeadline: "CANCEL_REMAINING" };
  readonly accountingMode: "LIVE" | "SHADOW";
  readonly legSelection: LegSelection;
  readonly partialFill: PartialFillHandling;
  readonly hysteresis: ReplaceHysteresis;
  readonly reservationRule: "RESERVE_BEFORE_SUBMISSION";
  readonly groups: readonly ExecutionGroup[];
  readonly reservations: readonly ReservationRequirement[];
  readonly estimates: PlanEstimates;
}

export interface BasketPlan extends PlanBase {
  readonly planKind: "BASKET";
  readonly priority: "PLACEMENT";
  /** The ONLY admissible value. `"ATOMIC"` is refused by name at the seal. */
  readonly coordination: "COORDINATED";
  readonly failurePolicy: "ABANDON" | "PROTECTED_UNWIND" | "HOLD_FILLED_LEGS";
  readonly legRiskLimit: string;
  readonly maximumCombinedCost: string;
  readonly priceProtection: { readonly mode: "CAPPED_LIMIT_ORDERS_ONLY" };
  readonly escalation: { readonly atDeadline: "CANCEL_REMAINING" };
  readonly accountingMode: "LIVE" | "SHADOW";
  readonly partialFill: PartialFillHandling;
  readonly hysteresis: ReplaceHysteresis;
  readonly reservationRule: "RESERVE_BEFORE_SUBMISSION";
  readonly groups: readonly ExecutionGroup[];
  readonly reservations: readonly ReservationRequirement[];
  readonly estimates: PlanEstimates;
}

export interface CancelPlan extends PlanBase {
  readonly planKind: "CANCEL";
  readonly priority: "SAFETY_CANCEL";
  /** A cancel places nothing at any price — the strongest price protection. */
  readonly priceProtection: { readonly mode: "NO_NEW_ORDERS" };
  readonly escalation: { readonly atDeadline: "ESCALATE_TO_RECONCILIATION" };
  readonly scope: { readonly marketId?: string; readonly orderIds?: readonly string[] };
  readonly reason: string;
}

export type ExecutionPlan = PlacementPlan | BasketPlan | CancelPlan;

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

const BASE_KEYS = [
  "executionPlanId",
  "approvedIntentId",
  "rootApprovedIntentId",
  "sourceIntentId",
  "strategyInstanceId",
  "runMode",
  "plannedAt",
  "deadline",
  "provenance",
  "planKind",
  "priority",
  "priceProtection",
  "escalation",
] as const;

const PLACEMENT_KEYS: ReadonlySet<string> = new Set([
  ...BASE_KEYS,
  "accountingMode",
  "legSelection",
  "partialFill",
  "hysteresis",
  "reservationRule",
  "groups",
  "reservations",
  "estimates",
]);

const BASKET_KEYS: ReadonlySet<string> = new Set([
  ...BASE_KEYS,
  "accountingMode",
  "coordination",
  "failurePolicy",
  "legRiskLimit",
  "maximumCombinedCost",
  "partialFill",
  "hysteresis",
  "reservationRule",
  "groups",
  "reservations",
  "estimates",
]);

const CANCEL_KEYS: ReadonlySet<string> = new Set([...BASE_KEYS, "scope", "reason"]);

/**
 * Property names whose strings are NOT repository identifiers, and which the
 * ADR-016 §2 identity walk therefore skips (the `packages/risk`
 * `NON_IDENTITY_KEYS` precedent, narrowed to what a plan can carry):
 *
 * - `orderIds` — opaque VENUE strings (§7.2; `CancelIntentSchema.orderIds`),
 *   which must round-trip exactly as the venue spelled them. They ride on the
 *   CANCEL path, so refusing one would trap a cancel for a rule ADR-016 does
 *   not impose (§6 invariant 13).
 * - `reason` — bounded human-readable text (`DetailStringSchema`), never
 *   parsed. Also on the cancel path.
 */
const NON_IDENTITY_KEYS: ReadonlySet<string> = new Set(["orderIds", "reason"]);

function sealProblemsRefusal(problems: readonly Problem[]): readonly PlannerRefusal[] {
  return [
    plannerRefusal("PLAN_SEAL_INVALID", "the draft does not satisfy the execution-plan contract (fail closed)", {
      issues: problems.map((entry) => `${entry.path}: ${entry.problem}`),
    }),
  ];
}

function validInstant(value: unknown, path: string, problems: Problem[]): string | undefined {
  if (typeof value !== "string" || !IsoTimestampDoor.safeParse(value).success) {
    return problem(problems, path, "expected an ISO-8601 instant with explicit offset");
  }
  return value;
}

function validateProvenance(value: unknown, path: string, problems: Problem[]): void {
  const data = asRecord(value, path, problems);
  if (data === undefined) return;
  requireKnownKeys(data, path, new Set(["approvedAt", "lineage", "worstCaseBasis"]), problems);
  validInstant(data["approvedAt"], `${path}.approvedAt`, problems);
  asMember(data["lineage"], `${path}.lineage`, ["ORIGINAL", "RESIZED"] as const, problems);
  asMember(
    data["worstCaseBasis"],
    `${path}.worstCaseBasis`,
    ["EVALUATED", "INHERITED_UPPER_BOUND"] as const,
    problems,
  );
}

function validateLiteralRecord(
  value: unknown,
  path: string,
  key: string,
  literal: string,
  problems: Problem[],
): void {
  const data = asRecord(value, path, problems);
  if (data === undefined) return;
  requireKnownKeys(data, path, new Set([key]), problems);
  if (data[key] !== literal) {
    problem(problems, `${path}.${key}`, `must be exactly "${literal}"`);
  }
}

function validateEstimates(value: unknown, path: string, problems: Problem[]): void {
  const data = asRecord(value, path, problems);
  if (data === undefined) return;
  requireKnownKeys(
    data,
    path,
    new Set(["basis", "worstCaseCost", "expectedProceeds", "fees", "slippage"]),
    problems,
  );
  if (data["basis"] !== "ESTIMATE") {
    problem(problems, `${path}.basis`, 'estimates must be labeled with the literal "ESTIMATE" (§9.10)');
  }
  for (const key of ["worstCaseCost", "expectedProceeds", "fees", "slippage"] as const) {
    asDecimal(data[key], `${path}.${key}`, problems, "NON_NEGATIVE");
  }
}

function validatePartialFill(value: unknown, path: string, problems: Problem[]): void {
  const data = asRecord(value, path, problems);
  if (data === undefined) return;
  requireKnownKeys(data, path, new Set(["policy", "minimumFillShares"]), problems);
  asMember(data["policy"], `${path}.policy`, ["REJECT", "ACCEPT_ANY", "ACCEPT_MINIMUM"] as const, problems);
  if (data["minimumFillShares"] !== undefined) {
    asDecimal(data["minimumFillShares"], `${path}.minimumFillShares`, problems, "NON_NEGATIVE");
  }
}

function validateHysteresis(value: unknown, path: string, problems: Problem[]): void {
  const data = asRecord(value, path, problems);
  if (data === undefined) return;
  requireKnownKeys(data, path, new Set(["replaceThresholdTicks", "minimumReplaceIntervalMs"]), problems);
  asNonNegativeInteger(data["replaceThresholdTicks"], `${path}.replaceThresholdTicks`, problems);
  asPositiveInteger(data["minimumReplaceIntervalMs"], `${path}.minimumReplaceIntervalMs`, problems);
}

function validateLegSelection(value: unknown, path: string, problems: Problem[]): void {
  const data = asRecord(value, path, problems);
  if (data === undefined) return;
  requireKnownKeys(
    data,
    path,
    new Set(["selected", "side", "action", "effectiveExposurePrice", "reason"]),
    problems,
  );
  asMember(data["selected"], `${path}.selected`, ["BUY_DIRECTION", "SELL_OPPOSITE", "SELL_DIRECTION"] as const, problems);
  asMember(data["side"], `${path}.side`, ["YES", "NO"] as const, problems);
  asMember(data["action"], `${path}.action`, ["BUY", "SELL"] as const, problems);
  asOpenUnitPrice(data["effectiveExposurePrice"], `${path}.effectiveExposurePrice`, problems);
  asMember(
    data["reason"],
    `${path}.reason`,
    ["DIRECT", "CHEAPER_EXPOSURE", "ONLY_FEASIBLE", "INVENTORY_FALLBACK"] as const,
    problems,
  );
}

interface OrderFacts {
  readonly reservationId: string;
  readonly marketId: string;
  readonly side: string;
  readonly action: string;
  readonly limitPrice: string;
  readonly shares: string;
}

/**
 * ADR-034 D2.3: an order's `unexecutableRemainder`, if present, is the
 * quantizer's record of its leg and nothing else. It sits on the group's last
 * order only, names `SUB_GRID` and shares, and its numbers agree exactly: the
 * remainder is positive and below the grid, `requested − executable` equals
 * it, and `executable` is the group's total.
 */
function validateRemainders(
  orders: readonly unknown[],
  groupPath: string,
  tickSize: string | undefined,
  problems: Problem[],
): void {
  let total = "0";
  let totalReadable = true;
  for (const order of orders) {
    const shares = order !== null && typeof order === "object" ? (order as Readonly<Record<string, unknown>>)["shares"] : undefined;
    if (typeof shares === "string" && isOnSizeGrid(shares, tickSize ?? "")) total = addDecimal(total, shares);
    else totalReadable = false;
  }
  for (const [index, order] of orders.entries()) {
    if (order === null || typeof order !== "object") continue;
    const value = (order as Readonly<Record<string, unknown>>)["unexecutableRemainder"];
    if (value === undefined) continue;
    const path = `${groupPath}.orders[${String(index)}].unexecutableRemainder`;
    if (index !== orders.length - 1) {
      problem(problems, path, "a leg's unexecutable remainder is recorded on its last order only (ADR-034 D2.3)");
    }
    const data = asRecord(value, path, problems);
    if (data === undefined) continue;
    requireKnownKeys(data, path, new Set(["reason", "unit", "quantity", "requested", "executable"]), problems);
    if (data["reason"] !== "SUB_GRID") problem(problems, `${path}.reason`, 'must be exactly "SUB_GRID" (ADR-034 D2.3)');
    if (data["unit"] !== "SHARES") problem(problems, `${path}.unit`, 'must be exactly "SHARES"');
    const quantity = asDecimal(data["quantity"], `${path}.quantity`, problems, "POSITIVE");
    const requested = asDecimal(data["requested"], `${path}.requested`, problems, "POSITIVE");
    const executable = asDecimal(data["executable"], `${path}.executable`, problems, "POSITIVE");
    const grid = tickSize === undefined ? undefined : sizeGridFor(tickSize);
    if (quantity === undefined || requested === undefined || executable === undefined || grid === undefined) continue;
    if (compareDecimal(quantity, grid) >= 0) {
      problem(problems, `${path}.quantity`, `a sub-grid remainder is below the grid "${grid}"`);
    }
    if (compareDecimal(subDecimal(requested, executable), quantity) !== 0) {
      problem(problems, path, "requested − executable must equal the remainder exactly");
    }
    if (!totalReadable || compareDecimal(executable, total) !== 0) {
      problem(problems, `${path}.executable`, "the leg's executable quantity must equal the sum of its group's orders exactly (ADR-034 D2.5)");
    }
  }
}

function validateOrder(
  value: unknown,
  path: string,
  group: { readonly marketId: string | undefined; readonly tickSize: string | undefined; readonly minimumOrderSize: string | undefined },
  problems: Problem[],
): OrderFacts | undefined {
  const data = asRecord(value, path, problems);
  if (data === undefined) return undefined;
  requireKnownKeys(
    data,
    path,
    new Set([
      "plannedOrderId",
      "marketId",
      "side",
      "action",
      "limitPrice",
      "shares",
      "postOnly",
      "executionStyle",
      "reservationId",
      "unexecutableRemainder",
    ]),
    problems,
  );
  asIdentifier(data["plannedOrderId"], `${path}.plannedOrderId`, problems);
  const marketId = data["marketId"];
  if (typeof marketId !== "string" || !InternalMarketIdDoor.safeParse(marketId).success) {
    problem(problems, `${path}.marketId`, "expected a canonical lowercase UUIDv7 (§7.2)");
  } else if (group.marketId !== undefined && marketId !== group.marketId) {
    problem(problems, `${path}.marketId`, "an order's market must be its group's market");
  }
  const side = asMember(data["side"], `${path}.side`, ["YES", "NO"] as const, problems);
  const action = asMember(data["action"], `${path}.action`, ["BUY", "SELL"] as const, problems);

  // PRICE PROTECTION IS STRUCTURAL (acceptance 2): the limit price must exist,
  // be a canonical decimal strictly inside (0, 1), and sit on the exact tick
  // grid the group's versioned parameters declare (§7.3 exact modulo).
  const limitPrice = asOpenUnitPrice(data["limitPrice"], `${path}.limitPrice`, problems);
  if (limitPrice !== undefined && group.tickSize !== undefined && !isOnTick(limitPrice, group.tickSize)) {
    problem(
      problems,
      `${path}.limitPrice`,
      `not an exact multiple of the market's tick size "${group.tickSize}" (§7.3: exact modulo arithmetic)`,
    );
  }
  const shares = asDecimal(data["shares"], `${path}.shares`, problems, "POSITIVE");
  // ADR-034 D2.5: the one executable quantity is on the venue's grid for the group's tick size.
  if (shares !== undefined && group.tickSize !== undefined && !isOnSizeGrid(shares, group.tickSize)) {
    problem(
      problems,
      `${path}.shares`,
      `not on the venue's order grid "${sizeGridFor(group.tickSize) ?? "unknown"}" for tick size "${group.tickSize}" (ADR-034 D2)`,
    );
  }
  if (
    shares !== undefined &&
    group.minimumOrderSize !== undefined &&
    compareDecimal(shares, group.minimumOrderSize) < 0
  ) {
    problem(
      problems,
      `${path}.shares`,
      `below the market's minimum order size "${group.minimumOrderSize}" (§9.8 check 11)`,
    );
  }
  const postOnly = data["postOnly"];
  if (typeof postOnly !== "boolean") {
    problem(problems, `${path}.postOnly`, "expected a boolean");
  }
  const style = asMember(data["executionStyle"], `${path}.executionStyle`, ["REST", "MARKETABLE_LIMIT"] as const, problems);
  if (typeof postOnly === "boolean" && style !== undefined && postOnly !== (style === "REST")) {
    problem(
      problems,
      `${path}.executionStyle`,
      "a resting order is post-only and a marketable limit is not; any other combination is incoherent",
    );
  }
  const reservationId = asIdentifier(data["reservationId"], `${path}.reservationId`, problems);
  if (
    reservationId === undefined ||
    typeof marketId !== "string" ||
    side === undefined ||
    action === undefined ||
    limitPrice === undefined ||
    shares === undefined
  ) {
    return undefined;
  }
  return { reservationId, marketId, side, action, limitPrice, shares };
}

function validateScopeKeys(value: unknown, path: string, problems: Problem[]): void {
  const data = asRecord(value, path, problems);
  if (data === undefined) return;
  requireKnownKeys(data, path, new Set(["seriesKey", "underlyingKey", "resolutionWindowKey"]), problems);
  for (const key of ["seriesKey", "underlyingKey", "resolutionWindowKey"]) {
    if (data[key] !== undefined) asIdentifier(data[key], `${path}.${key}`, problems);
  }
}

function validateReservations(
  value: unknown,
  path: string,
  plan: Readonly<Record<string, unknown>>,
  orders: readonly OrderFacts[],
  problems: Problem[],
): void {
  const entries = asArray(value, path, problems);
  if (entries === undefined) return;
  if (entries.length !== orders.length) {
    problem(
      problems,
      path,
      `every planned order needs exactly one reservation (§9.10: reserve before submission); ${String(orders.length)} orders, ${String(entries.length)} reservations`,
    );
  }
  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${path}[${String(index)}]`;
    const data = asRecord(entry, entryPath, problems);
    if (data === undefined) continue;
    requireKnownKeys(
      data,
      entryPath,
      new Set([
        "reservationId",
        "strategyInstanceId",
        "runMode",
        "accountingMode",
        "marketId",
        "side",
        "action",
        "price",
        "shares",
        "scope",
      ]),
      problems,
    );
    const id = asIdentifier(data["reservationId"], `${entryPath}.reservationId`, problems);
    if (id !== undefined) {
      if (byId.has(id)) {
        problem(problems, `${entryPath}.reservationId`, "duplicate reservation identifier");
      }
      byId.set(id, data);
    }
    for (const [key, expected] of [
      ["strategyInstanceId", plan["strategyInstanceId"]],
      ["runMode", plan["runMode"]],
      ["accountingMode", plan["accountingMode"]],
    ] as const) {
      if (data[key] !== expected) {
        problem(problems, `${entryPath}.${key}`, "must match the plan's own value exactly");
      }
    }
    if (data["scope"] !== undefined) validateScopeKeys(data["scope"], `${entryPath}.scope`, problems);
  }
  for (const order of orders) {
    const reservation = byId.get(order.reservationId);
    if (reservation === undefined) {
      problem(
        problems,
        path,
        `order reservation "${order.reservationId}" is not among the plan's reservations — submission would precede reservation (§9.10)`,
      );
      continue;
    }
    for (const [key, expected] of [
      ["marketId", order.marketId],
      ["side", order.side],
      ["action", order.action],
      ["price", order.limitPrice],
      ["shares", order.shares],
    ] as const) {
      if (reservation[key] !== expected) {
        problem(
          problems,
          `${path}.${order.reservationId}.${key}`,
          "a reservation must claim exactly what its order commits",
        );
      }
    }
  }
}

function validateGroups(
  value: unknown,
  path: string,
  problems: Problem[],
): readonly OrderFacts[] {
  const groups = asArray(value, path, problems);
  const facts: OrderFacts[] = [];
  if (groups === undefined) return facts;
  if (groups.length === 0) {
    problem(problems, path, "a placement plan with no execution group plans nothing");
    return facts;
  }
  for (const [index, entry] of groups.entries()) {
    const groupPath = `${path}[${String(index)}]`;
    const data = asRecord(entry, groupPath, problems);
    if (data === undefined) continue;
    requireKnownKeys(
      data,
      groupPath,
      new Set(["executionGroupId", "marketId", "tickSize", "minimumOrderSize", "orders"]),
      problems,
    );
    asIdentifier(data["executionGroupId"], `${groupPath}.executionGroupId`, problems);
    const marketIdValue = data["marketId"];
    let marketId: string | undefined;
    if (typeof marketIdValue !== "string" || !InternalMarketIdDoor.safeParse(marketIdValue).success) {
      problem(problems, `${groupPath}.marketId`, "expected a canonical lowercase UUIDv7 (§7.2)");
    } else {
      marketId = marketIdValue;
    }
    const tickSize = asDecimal(data["tickSize"], `${groupPath}.tickSize`, problems, "POSITIVE");
    if (tickSize !== undefined && compareDecimal(tickSize, "1") >= 0) {
      problem(problems, `${groupPath}.tickSize`, "a price tick must be smaller than 1");
    }
    if (tickSize !== undefined && sizeGridFor(tickSize) === undefined) {
      problem(
        problems,
        `${groupPath}.tickSize`,
        "not in the venue's documented precision table, so the order grid is unknown (ADR-034 D2.1; PLAN_TICK_SIZE_UNSUPPORTED)",
      );
    }
    const minimumOrderSize = asDecimal(data["minimumOrderSize"], `${groupPath}.minimumOrderSize`, problems, "POSITIVE");
    const orders = asArray(data["orders"], `${groupPath}.orders`, problems);
    if (orders === undefined) continue;
    if (orders.length === 0) {
      problem(problems, `${groupPath}.orders`, "an execution group with no orders plans nothing");
      continue;
    }
    validateRemainders(orders, groupPath, tickSize, problems);
    for (const [orderIndex, order] of orders.entries()) {
      const orderFacts = validateOrder(
        order,
        `${groupPath}.orders[${String(orderIndex)}]`,
        { marketId, tickSize, minimumOrderSize },
        problems,
      );
      if (orderFacts !== undefined) facts.push(orderFacts);
    }
  }
  return facts;
}

function validatePlacementCommon(
  data: Readonly<Record<string, unknown>>,
  problems: Problem[],
): void {
  validateLiteralRecord(data["priceProtection"], "plan.priceProtection", "mode", "CAPPED_LIMIT_ORDERS_ONLY", problems);
  validateLiteralRecord(data["escalation"], "plan.escalation", "atDeadline", "CANCEL_REMAINING", problems);
  asMember(data["accountingMode"], "plan.accountingMode", ["LIVE", "SHADOW"] as const, problems);
  if (data["reservationRule"] !== "RESERVE_BEFORE_SUBMISSION") {
    problem(
      problems,
      "plan.reservationRule",
      'must be exactly "RESERVE_BEFORE_SUBMISSION" (§9.10: reservation precedes submission)',
    );
  }
  validatePartialFill(data["partialFill"], "plan.partialFill", problems);
  validateHysteresis(data["hysteresis"], "plan.hysteresis", problems);
  validateEstimates(data["estimates"], "plan.estimates", problems);
  const orders = validateGroups(data["groups"], "plan.groups", problems);
  validateReservations(data["reservations"], "plan.reservations", data, orders, problems);
}

function validateCancel(data: Readonly<Record<string, unknown>>, problems: Problem[]): void {
  validateLiteralRecord(data["priceProtection"], "plan.priceProtection", "mode", "NO_NEW_ORDERS", problems);
  validateLiteralRecord(data["escalation"], "plan.escalation", "atDeadline", "ESCALATE_TO_RECONCILIATION", problems);
  const scope = asRecord(data["scope"], "plan.scope", problems);
  if (scope !== undefined) {
    requireKnownKeys(scope, "plan.scope", new Set(["marketId", "orderIds"]), problems);
    if (scope["marketId"] !== undefined) {
      const marketId = scope["marketId"];
      if (typeof marketId !== "string" || !InternalMarketIdDoor.safeParse(marketId).success) {
        problem(problems, "plan.scope.marketId", "expected a canonical lowercase UUIDv7 (§7.2)");
      }
    }
    if (scope["orderIds"] !== undefined) {
      const orderIds = asArray(scope["orderIds"], "plan.scope.orderIds", problems);
      if (orderIds !== undefined) {
        for (const [index, orderId] of orderIds.entries()) {
          // Venue strings: bounded and non-empty, but NEVER UUID-checked
          // (§7.2 opacity; §6 invariant 13 — see NON_IDENTITY_KEYS).
          if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 200) {
            problem(
              problems,
              `plan.scope.orderIds[${String(index)}]`,
              "expected a non-empty venue order id of at most 200 characters",
            );
          }
        }
      }
    }
  }
  const reason = data["reason"];
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 2000) {
    problem(problems, "plan.reason", "expected non-empty human-readable text of at most 2000 characters");
  }
}

/**
 * THE SINGLE EMISSION BOUNDARY for execution plans.
 *
 * Reads the draft into plain own data, checks every identity-bearing string
 * (ADR-016 §2, skipping only {@link NON_IDENTITY_KEYS}), validates the
 * complete plan contract against the draft's `planKind`, and either refuses
 * with the evidence intact or freezes the MATERIALIZED tree and returns it —
 * the exact bytes that were checked, sharing no object with the draft. What
 * this makes impossible rather than unlikely: an unfrozen plan, a plan
 * without a deadline, an order without a limit price, a basket labeled
 * atomic, a placement claiming cancel priority, and a submission the plan
 * does not tie to a prior reservation.
 */
export function sealExecutionPlan(draft: ExecutionPlan): PlannerResult<ExecutionPlan> {
  return contained(
    () => sealInner(draft),
    (thrown) =>
      plannerFailure(
        plannerRefusal(
          "PLAN_SEAL_INVALID",
          "sealing the plan failed unexpectedly; a plan that cannot be sealed is not emitted (fail closed)",
          { thrown },
        ),
      ),
  );
}

function sealInner(draft: ExecutionPlan): PlannerResult<ExecutionPlan> {
  const read = readPlainData(draft, "plan");
  if (!read.ok) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_SEAL_INVALID",
        "the draft is not a data record: a plan is a finite tree of plain own data (fail closed)",
        { issues: read.problems.map((entry) => `${entry.path}: ${entry.problem}`) },
      ),
    );
  }

  const refusals: PlannerRefusal[] = [];
  // ADR-016 §2 identity validation consumes the read's own string inventory —
  // no second walk that could be blind in a different way (WP-180 round 4).
  for (const entry of read.strings) {
    if (entry.keys.some((key) => NON_IDENTITY_KEYS.has(key))) continue;
    if (uuidShapedNotCanonical(entry.value)) {
      refusals.push(
        plannerRefusal(
          "PLAN_UUID_NOT_CANONICAL",
          "an identity-bearing string is UUID-shaped but not canonical lowercase (ADR-016 §2: refuse, never case-fold)",
          { field: entry.path, value: entry.value },
        ),
      );
    }
  }

  const problems: Problem[] = [];
  const data = asRecord(read.value, "plan", problems);
  if (data === undefined) {
    return plannerFailure(...refusals, ...sealProblemsRefusal(problems));
  }

  const planKind = asMember(
    data["planKind"],
    "plan.planKind",
    ["POSITION", "REDUCE_POSITION", "BASKET", "CANCEL"] as const,
    problems,
  );

  // --- the atomic label, refused BY NAME (acceptance 3) ---------------------
  if (planKind === "BASKET") {
    const coordination = data["coordination"];
    if (coordination === "ATOMIC") {
      refusals.push(
        plannerRefusal(
          "PLAN_ATOMIC_LABEL_FORBIDDEN",
          'a coordinated basket is NEVER atomic (§7.7: "Basket execution is coordinated, not assumed atomic"); the label misstates venue behaviour and is refused by name',
          { coordination },
        ),
      );
    } else if (coordination !== "COORDINATED") {
      problem(problems, "plan.coordination", 'must be exactly "COORDINATED"');
    }
    asMember(
      data["failurePolicy"],
      "plan.failurePolicy",
      ["ABANDON", "PROTECTED_UNWIND", "HOLD_FILLED_LEGS"] as const,
      problems,
    );
    asDecimal(data["legRiskLimit"], "plan.legRiskLimit", problems, "NON_NEGATIVE");
    asDecimal(data["maximumCombinedCost"], "plan.maximumCombinedCost", problems, "NON_NEGATIVE");
  }

  // --- §6 invariant 13: the priority literal, coupled in BOTH directions ----
  const priority = data["priority"];
  if (planKind === "CANCEL" && priority !== "SAFETY_CANCEL") {
    problem(problems, "plan.priority", 'a cancel plan schedules as "SAFETY_CANCEL" (§6 invariant 13)');
  }
  if (planKind !== undefined && planKind !== "CANCEL" && priority !== "PLACEMENT") {
    problem(
      problems,
      "plan.priority",
      'a placement plan schedules as "PLACEMENT"; claiming cancel priority would jump the §6 invariant-13 queue',
    );
  }

  if (planKind !== undefined) {
    const known =
      planKind === "CANCEL" ? CANCEL_KEYS : planKind === "BASKET" ? BASKET_KEYS : PLACEMENT_KEYS;
    requireKnownKeys(data, "plan", known, problems);
    for (const key of known) {
      if (key === "sourceIntentId") continue; // §7.7 gives CANCEL/REDUCE no intentId.
      if (planKind === "BASKET" && key === "coordination") continue; // checked above
      if (data[key] === undefined) {
        problem(problems, `plan.${key}`, "a required field of an execution plan is absent");
      }
    }
  }

  asIdentifier(data["executionPlanId"], "plan.executionPlanId", problems);
  asIdentifier(data["approvedIntentId"], "plan.approvedIntentId", problems);
  asIdentifier(data["rootApprovedIntentId"], "plan.rootApprovedIntentId", problems);
  asIdentifier(data["strategyInstanceId"], "plan.strategyInstanceId", problems);
  if (data["sourceIntentId"] !== undefined) {
    asIdentifier(data["sourceIntentId"], "plan.sourceIntentId", problems);
  }
  asMember(data["runMode"], "plan.runMode", RUN_MODES, problems);
  validateProvenance(data["provenance"], "plan.provenance", problems);

  // --- deadline: REQUIRED and strictly after the planning instant -----------
  const plannedAt = validInstant(data["plannedAt"], "plan.plannedAt", problems);
  const deadline = validInstant(data["deadline"], "plan.deadline", problems);
  if (plannedAt !== undefined && deadline !== undefined) {
    const start = instantMilliseconds(plannedAt);
    const end = instantMilliseconds(deadline);
    if (start === undefined || end === undefined || end <= start) {
      problem(
        problems,
        "plan.deadline",
        "every plan carries a deadline strictly after its planning instant (workplan acceptance 2)",
      );
    }
  }

  if (planKind === "CANCEL") {
    validateCancel(data, problems);
  } else if (planKind !== undefined) {
    validatePlacementCommon(data, problems);
    if (planKind !== "BASKET") {
      validateLegSelection(data["legSelection"], "plan.legSelection", problems);
    }
  }

  if (refusals.length > 0 || problems.length > 0) {
    return plannerFailure(
      ...refusals,
      ...(problems.length > 0 ? sealProblemsRefusal(problems) : []),
    );
  }
  return { ok: true, value: deepFreeze(read.value as ExecutionPlan) };
}
