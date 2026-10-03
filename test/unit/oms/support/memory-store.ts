/**
 * An in-memory, transactional stand-in for the OMS store port, enforcing the
 * migration-0005 constraints the OMS's writes touch, so a write order the
 * database would refuse fails here too:
 *
 * - `orders_submission_requires_attempt` (WP-040 F17: no `SIGNED` order
 *   without its attempt; only PLANNED/CANCELED/REJECTED/EXPIRED may lack one,
 *   and then with no venue contact);
 * - `orders_submission_attempt_attach_only`; `orders_filled_within_original`;
 *   `orders_immutable_identity`; `orders_venue_order_id_unique`;
 *   `orders_submission_attempt_plan_fk`;
 * - `submission_attempts_ordinal_unique`;
 *   `submission_attempts_expected_order_hash_unique` (where known);
 *   `submission_attempts_immutable_signature`;
 * - `order_events_ordinal_unique` (here stricter: a gapless sequence from 0);
 * - `groups`: the NOT NULL columns, `groups_ordinal_non_negative`,
 *   `groups_ordinal_unique` (r3, WP270-R3-02);
 * - `intent_order_links_unique`; `fills_venue_identity_unique`;
 *   `fills_order_has_submission_attempt` (PMB11); the fill-allocation sum
 *   (PMB03/PMB04); `trade_settlements_ordinal_unique`.
 *
 * Every `apply` is one transaction: all writes or none. Hooks let the
 * fault-injection suite fail or "kill" around a transaction.
 */

import type {
  AttemptRecord,
  FillAllocationRecord,
  FillRecord,
  GroupRecord,
  IntentOrderLinkRecord,
  OmsStore,
  OrderEventRecord,
  OrderRecord,
  StoreSnapshot,
  StoreWrite,
  TradeSettlementRecord,
} from "../../../../packages/oms/src/index.js";

interface State {
  groups: Map<string, GroupRecord>;
  orders: Map<string, OrderRecord>;
  attempts: Map<string, AttemptRecord>;
  events: OrderEventRecord[];
  links: IntentOrderLinkRecord[];
  fills: FillRecord[];
  allocations: FillAllocationRecord[];
  settlements: TradeSettlementRecord[];
}

function empty(): State {
  return { groups: new Map(), orders: new Map(), attempts: new Map(), events: [], links: [], fills: [], allocations: [], settlements: [] };
}

function clone(state: State): State {
  return {
    groups: new Map(state.groups),
    orders: new Map(state.orders),
    attempts: new Map(state.attempts),
    events: [...state.events],
    links: [...state.links],
    fills: [...state.fills],
    allocations: [...state.allocations],
    settlements: [...state.settlements],
  };
}

/** Exact decimal comparison for the store's own checks (no float). */
function cmp(a: string, b: string): number {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  const width = Math.max(af.length, bf.length);
  const an = BigInt(ai + af.padEnd(width, "0"));
  const bn = BigInt(bi + bf.padEnd(width, "0"));
  return an < bn ? -1 : an > bn ? 1 : 0;
}

function sum(values: readonly string[]): string {
  const width = Math.max(0, ...values.map((value) => (value.split(".")[1] ?? "").length));
  let total = 0n;
  for (const value of values) {
    const [i = "0", f = ""] = value.split(".");
    total += BigInt(i + f.padEnd(width, "0"));
  }
  const text = total.toString().padStart(width + 1, "0");
  const whole = text.slice(0, text.length - width);
  const frac = width === 0 ? "" : text.slice(text.length - width).replace(/0+$/u, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

export class ConstraintViolation extends Error {}

export interface StoreHooks {
  /** Called before a transaction is applied; throwing aborts it (nothing committed). */
  before?: ((writes: readonly StoreWrite[], call: number) => void) | undefined;
  /** Called after a transaction committed; throwing makes `apply` reject AFTER the commit (an ambiguous commit). */
  after?: ((writes: readonly StoreWrite[], call: number) => void) | undefined;
}

export class MemoryStore implements OmsStore {
  #state: State = empty();
  calls = 0;
  readonly log: StoreWrite[][] = [];
  hooks: StoreHooks = {};
  /** When true, every call rejects (a "dead" process cannot write). */
  frozen = false;

  async apply(writes: readonly StoreWrite[]): Promise<void> {
    if (this.frozen) throw new Error("store frozen");
    this.calls += 1;
    const call = this.calls;
    this.hooks.before?.(writes, call);
    const next = clone(this.#state);
    for (const write of writes) applyWrite(next, write);
    checkDeferred(next, writes);
    this.#state = next;
    this.log.push(structuredClone([...writes]));
    this.hooks.after?.(writes, call);
  }

  async load(): Promise<StoreSnapshot> {
    if (this.frozen) throw new Error("store frozen");
    const s = this.#state;
    return structuredClone({
      groups: [...s.groups.values()],
      orders: [...s.orders.values()],
      attempts: [...s.attempts.values()],
      events: s.events,
      links: s.links,
      fills: s.fills,
      allocations: s.allocations,
      settlements: s.settlements,
    });
  }

  /** Everything ever written, as text: the suites scan it for a signature in clear. */
  serialized(): string {
    return JSON.stringify(this.log);
  }

  snapshotSync(): Readonly<State> {
    return this.#state;
  }
}

const IMMUTABLE_ORDER: readonly (keyof OrderRecord)[] = [
  "orderId",
  "planId",
  "executionGroupId",
  "marketId",
  "tokenId",
  "accountRef",
  "side",
  "limitPrice",
  "originalShares",
];
const IMMUTABLE_ATTEMPT: readonly (keyof AttemptRecord)[] = [
  "submissionAttemptId",
  "executionGroupId",
  "planId",
  "accountRef",
  "attemptOrdinal",
  "salt",
];

function checkOrder(state: State, order: OrderRecord): void {
  if (cmp(order.filledShares, order.originalShares) > 0) throw new ConstraintViolation("orders_filled_within_original");
  if (order.submissionAttemptId === null) {
    const exempt =
      ["PLANNED", "CANCELED", "REJECTED", "EXPIRED"].includes(order.state) &&
      order.filledShares === "0" &&
      order.venueOrderId === null &&
      order.venueOrderHash === null;
    if (!exempt) throw new ConstraintViolation("orders_submission_requires_attempt");
  } else {
    const attempt = state.attempts.get(order.submissionAttemptId);
    if (attempt === undefined || attempt.planId !== order.planId) throw new ConstraintViolation("orders_submission_attempt_plan_fk");
  }
  if (order.venueOrderId !== null) {
    for (const other of state.orders.values()) {
      if (other.orderId !== order.orderId && other.venueOrderId === order.venueOrderId) {
        throw new ConstraintViolation("orders_venue_order_id_unique");
      }
    }
  }
}

function applyWrite(state: State, write: StoreWrite): void {
  switch (write.kind) {
    case "INSERT_GROUP": {
      const g = write.group;
      if (state.groups.has(g.executionGroupId)) throw new ConstraintViolation("groups primary key");
      // The NOT NULL columns of `execution.groups` (r3, WP270-R3-02): the write must be a self-sufficient row.
      const row = g as unknown as Record<string, unknown>;
      for (const column of ["groupOrdinal", "groupKind", "limitPrice", "tokenId", "side", "plannedShares", "planId"]) {
        if (row[column] === undefined || row[column] === null) throw new ConstraintViolation(`groups not null: ${column}`);
      }
      if (!Number.isSafeInteger(g.groupOrdinal) || g.groupOrdinal < 0) throw new ConstraintViolation("groups_ordinal_non_negative");
      if (g.groupKind !== "SLICE" && g.groupKind !== "LEG") throw new ConstraintViolation("groups group_kind enum");
      for (const other of state.groups.values()) {
        if (other.planId === g.planId && other.groupOrdinal === g.groupOrdinal) throw new ConstraintViolation("groups_ordinal_unique");
      }
      state.groups.set(g.executionGroupId, g);
      return;
    }
    case "INSERT_ORDER":
      if (state.orders.has(write.order.orderId)) throw new ConstraintViolation("orders primary key");
      checkOrder(state, write.order);
      state.orders.set(write.order.orderId, write.order);
      return;
    case "UPDATE_ORDER": {
      const old = state.orders.get(write.order.orderId);
      if (old === undefined) throw new ConstraintViolation("update of a missing order");
      for (const key of IMMUTABLE_ORDER) {
        if (old[key] !== write.order[key]) throw new ConstraintViolation(`orders_immutable_identity:${key}`);
      }
      if (old.submissionAttemptId !== null && write.order.submissionAttemptId !== old.submissionAttemptId) {
        throw new ConstraintViolation("orders_submission_attempt_attach_only");
      }
      checkOrder(state, write.order);
      state.orders.set(write.order.orderId, write.order);
      return;
    }
    case "INSERT_ATTEMPT": {
      const a = write.attempt;
      if (state.attempts.has(a.submissionAttemptId)) throw new ConstraintViolation("submission_attempts primary key");
      for (const other of state.attempts.values()) {
        if (other.executionGroupId === a.executionGroupId && other.attemptOrdinal === a.attemptOrdinal) {
          throw new ConstraintViolation("submission_attempts_ordinal_unique");
        }
        if (a.expectedOrderHash !== null && other.expectedOrderHash === a.expectedOrderHash) {
          throw new ConstraintViolation("submission_attempts_expected_order_hash_unique");
        }
      }
      if (a.state !== "SIGNED") throw new ConstraintViolation("an attempt is inserted SIGNED (§9.11 step 4)");
      state.attempts.set(a.submissionAttemptId, a);
      return;
    }
    case "UPDATE_ATTEMPT": {
      const old = state.attempts.get(write.attempt.submissionAttemptId);
      if (old === undefined) throw new ConstraintViolation("update of a missing attempt");
      for (const key of IMMUTABLE_ATTEMPT) {
        if (old[key] !== write.attempt[key]) throw new ConstraintViolation(`submission_attempts_immutable_signature:${key}`);
      }
      if (JSON.stringify(old.signedPayload) !== JSON.stringify(write.attempt.signedPayload)) {
        throw new ConstraintViolation("submission_attempts_immutable_signature:signedPayload");
      }
      if (write.attempt.expectedOrderHash !== null) {
        for (const other of state.attempts.values()) {
          if (other.submissionAttemptId !== old.submissionAttemptId && other.expectedOrderHash === write.attempt.expectedOrderHash) {
            throw new ConstraintViolation("submission_attempts_expected_order_hash_unique");
          }
        }
      }
      state.attempts.set(old.submissionAttemptId, write.attempt);
      return;
    }
    case "APPEND_ORDER_EVENT": {
      const e = write.event;
      if (!state.orders.has(e.orderId)) throw new ConstraintViolation("order_events order fk");
      const count = state.events.filter((event) => event.orderId === e.orderId).length;
      if (e.eventOrdinal !== count) throw new ConstraintViolation("order_events ordinal sequence");
      state.events.push(e);
      return;
    }
    case "INSERT_INTENT_LINK": {
      const l = write.link;
      if (!state.orders.has(l.orderId)) throw new ConstraintViolation("intent_order_links order fk");
      if (state.links.some((link) => link.intentId === l.intentId && link.orderId === l.orderId)) {
        throw new ConstraintViolation("intent_order_links_unique");
      }
      state.links.push(l);
      return;
    }
    case "INSERT_FILL": {
      const f = write.fill;
      const order = state.orders.get(f.orderId);
      if (order === undefined) throw new ConstraintViolation("fills order fk");
      if (order.submissionAttemptId === null) throw new ConstraintViolation("PMB11 fills_order_has_submission_attempt");
      if (
        state.fills.some(
          (fill) => fill.venueTradeId === f.venueTradeId && fill.venueOrderId === f.venueOrderId && fill.allocationDiscriminator === f.allocationDiscriminator,
        )
      ) {
        throw new ConstraintViolation("fills_venue_identity_unique");
      }
      const total = sum(write.allocations.map((allocation) => allocation.allocatedShares));
      if (cmp(total, f.shares) !== 0) throw new ConstraintViolation("PMB04 fill allocations sum to the fill");
      state.fills.push(f);
      state.allocations.push(...write.allocations);
      return;
    }
    case "APPEND_SETTLEMENT": {
      const st = write.settlement;
      if (!state.fills.some((fill) => fill.fillId === st.fillId)) throw new ConstraintViolation("trade_settlements fill fk");
      if (state.settlements.some((other) => other.fillId === st.fillId && other.stateOrdinal === st.stateOrdinal)) {
        throw new ConstraintViolation("trade_settlements_ordinal_unique");
      }
      state.settlements.push(st);
      return;
    }
  }
}

function checkDeferred(state: State, writes: readonly StoreWrite[]): void {
  // Every order touched by this transaction re-checked at COMMIT (as the attach and lineage rules are).
  for (const write of writes) {
    if (write.kind === "INSERT_ORDER" || write.kind === "UPDATE_ORDER") {
      const order = state.orders.get(write.order.orderId);
      if (order !== undefined) checkOrder(state, order);
    }
  }
}
