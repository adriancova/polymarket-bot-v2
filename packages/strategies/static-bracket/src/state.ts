/**
 * The instance state document: what the strategy remembers between callbacks.
 *
 * The runtime owns state persistence — it folds each `statePatch` into the
 * instance state, serializes it canonically, and checkpoints it (§9.6). What
 * this module owns is the SHAPE: a total document (every key always present),
 * read back through a total parser, and written back whole.
 *
 * Three properties, each load-bearing:
 *
 * 1. **Totality.** Every field is always present, so every read is an
 *    own-property read. The runtime's state object carries the ordinary
 *    prototype, so an absent field would be answerable by a polluted
 *    `Object.prototype`; there are no absent fields.
 * 2. **The patch is the whole document.** The runtime shallow-merges patches,
 *    so a partial patch would leave the document's fields from different
 *    evaluations. Writing the whole document makes the decision log and the
 *    checkpoint agree by construction, which is what
 *    `rebuildStateFromPatches` needs (§6 invariant 8).
 * 3. **Economic values are canonical decimal strings** (§6 invariant 1);
 *    counters and instants are non-economic integers.
 *
 * An UNREADABLE state document is not repaired and is not defaulted away: it
 * halts the instance. A strategy that cannot tell how much it holds must not
 * act (§6 invariant 12, "no blind flatten").
 */

import { ZERO, isDecimal } from "./economics.js";
import {
  readInstanceState,
  readOrderState,
  type InstanceState,
  type OrderState,
} from "./machine.js";
import {
  bad,
  describe,
  isPlainRecord,
  ok,
  plainCopy,
  readOwn,
  type Outcome,
  type PlainJson,
  type PlainRecord,
} from "./plain.js";

/** Bumped whenever this document's shape changes (§9.6 `stateSchemaVersion`). */
export const STATIC_BRACKET_STATE_SCHEMA_VERSION = 1;

export type OrderKind = "ENTRY" | "EXIT";
export type OrderSide = "BUY" | "SELL";
export type Outcome2 = "YES" | "NO";

/** One order the strategy asked for, and everything it knows about it. */
export interface OrderTrack {
  readonly kind: OrderKind;
  readonly intentId: string;
  /** The venue/OMS order id once observed; `null` while nothing has been seen. */
  readonly orderId: string | null;
  readonly state: OrderState;
  readonly outcome: Outcome2;
  readonly side: OrderSide;
  readonly limitPrice: string;
  readonly requestedShares: string;
  readonly filledShares: string;
  readonly placedAtMs: number;
  /** True once the maker-to-aggressive conversion (§13.2) has been applied. */
  readonly escalated: boolean;
}

export interface StaticBracketState {
  readonly schemaVersion: number;
  readonly instanceState: InstanceState;
  /** The bracket state recorded when the instance paused; `null` otherwise. */
  readonly resumeTo: InstanceState | null;
  readonly haltReason: string | null;
  /** ACTUAL entry executions, incremented on an entry order's FIRST confirmed fill (§13.3 rule 3). */
  readonly entriesExecuted: number;
  /** Monotone counter behind every emitted intent id; the only id source. */
  readonly intentSequence: number;
  readonly entryOrder: OrderTrack | null;
  readonly exitOrder: OrderTrack | null;
  /** Confirmed allocated entry shares (§13.3 rule 1). */
  readonly allocatedShares: string;
  /** Confirmed cost of those allocations, fees excluded. */
  readonly allocatedCost: string;
  /** Confirmed exit fills against the allocation. */
  readonly exitedShares: string;
  /** The outcome token the allocation is held in. */
  readonly legOutcome: Outcome2 | null;
  /** Instant of the first confirmed entry fill; drives `maximum_holding_seconds`. */
  readonly openedAtMs: number | null;
  /** Instant the bracket last reached CLOSED; drives `cooldown_seconds`. */
  readonly closedAtMs: number | null;
  /** The last data-quality condition that paused the instance, for the record. */
  readonly lastIncident: string | null;
}

export const INITIAL_STATE: StaticBracketState = Object.freeze({
  schemaVersion: STATIC_BRACKET_STATE_SCHEMA_VERSION,
  instanceState: "DORMANT" as InstanceState,
  resumeTo: null,
  haltReason: null,
  entriesExecuted: 0,
  intentSequence: 0,
  entryOrder: null,
  exitOrder: null,
  allocatedShares: ZERO,
  allocatedCost: ZERO,
  exitedShares: ZERO,
  legOutcome: null,
  openedAtMs: null,
  closedAtMs: null,
  lastIncident: null,
});

const STATE_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "instanceState",
  "resumeTo",
  "haltReason",
  "entriesExecuted",
  "intentSequence",
  "entryOrder",
  "exitOrder",
  "allocatedShares",
  "allocatedCost",
  "exitedShares",
  "legOutcome",
  "openedAtMs",
  "closedAtMs",
  "lastIncident",
]);

const ORDER_KEYS: readonly string[] = Object.freeze([
  "kind",
  "intentId",
  "orderId",
  "state",
  "outcome",
  "side",
  "limitPrice",
  "requestedShares",
  "filledShares",
  "placedAtMs",
  "escalated",
]);

function readCount(record: PlainRecord, key: string, path: string): Outcome<number> {
  const value = readOwn(record, key, path);
  if (!value.ok) return value;
  if (typeof value.value !== "number" || !Number.isSafeInteger(value.value) || value.value < 0) {
    return bad(`${path}.${key} must be a non-negative safe integer; received ${describe(value.value)}`);
  }
  return ok(value.value);
}

function readNullableInstant(record: PlainRecord, key: string, path: string): Outcome<number | null> {
  const value = readOwn(record, key, path);
  if (!value.ok) return value;
  if (value.value === null) return ok(null);
  if (typeof value.value !== "number" || !Number.isSafeInteger(value.value)) {
    return bad(`${path}.${key} must be an integer instant or null; received ${describe(value.value)}`);
  }
  return ok(value.value);
}

function readNullableText(record: PlainRecord, key: string, path: string): Outcome<string | null> {
  const value = readOwn(record, key, path);
  if (!value.ok) return value;
  if (value.value === null) return ok(null);
  if (typeof value.value !== "string" || value.value.length > 500) {
    return bad(`${path}.${key} must be a bounded string or null; received ${describe(value.value)}`);
  }
  return ok(value.value);
}

function readDecimalField(record: PlainRecord, key: string, path: string): Outcome<string> {
  const value = readOwn(record, key, path);
  if (!value.ok) return value;
  if (!isDecimal(value.value)) {
    return bad(
      `${path}.${key} must be a canonical decimal string; received ${describe(value.value)}`,
    );
  }
  return ok(value.value);
}

function readOutcomeField(record: PlainRecord, key: string, path: string): Outcome<Outcome2> {
  const value = readOwn(record, key, path);
  if (!value.ok) return value;
  if (value.value !== "YES" && value.value !== "NO") {
    return bad(`${path}.${key} must be YES or NO`);
  }
  return ok(value.value);
}

function readOrderTrack(value: PlainJson, path: string): Outcome<OrderTrack | null> {
  if (value === null) return ok(null);
  if (!isPlainRecord(value)) {
    return bad(`${path} must be an order record or null; received ${describe(value)}`);
  }
  for (const key of Object.keys(value)) {
    if (!ORDER_KEYS.includes(key)) {
      return bad(`${path}.${key} is not part of the tracked-order shape`);
    }
  }
  const kind = readOwn(value, "kind", path);
  if (!kind.ok) return kind;
  if (kind.value !== "ENTRY" && kind.value !== "EXIT") {
    return bad(`${path}.kind must be ENTRY or EXIT`);
  }
  const intentId = readOwn(value, "intentId", path);
  if (!intentId.ok) return intentId;
  if (typeof intentId.value !== "string" || intentId.value.length === 0) {
    return bad(`${path}.intentId must be a non-empty string`);
  }
  const orderIdValue = readOwn(value, "orderId", path);
  if (!orderIdValue.ok) return orderIdValue;
  if (orderIdValue.value !== null && typeof orderIdValue.value !== "string") {
    return bad(`${path}.orderId must be a string or null`);
  }
  const stateValue = readOwn(value, "state", path);
  if (!stateValue.ok) return stateValue;
  const orderState = readOrderState(stateValue.value, `${path}.state`);
  if (!orderState.ok) return orderState;
  const outcome = readOutcomeField(value, "outcome", path);
  if (!outcome.ok) return outcome;
  const sideValue = readOwn(value, "side", path);
  if (!sideValue.ok) return sideValue;
  if (sideValue.value !== "BUY" && sideValue.value !== "SELL") {
    return bad(`${path}.side must be BUY or SELL`);
  }
  const limitPrice = readDecimalField(value, "limitPrice", path);
  if (!limitPrice.ok) return limitPrice;
  const requestedShares = readDecimalField(value, "requestedShares", path);
  if (!requestedShares.ok) return requestedShares;
  const filledShares = readDecimalField(value, "filledShares", path);
  if (!filledShares.ok) return filledShares;
  const placedAtMs = readCount(value, "placedAtMs", path);
  if (!placedAtMs.ok) return placedAtMs;
  const escalated = readOwn(value, "escalated", path);
  if (!escalated.ok) return escalated;
  if (typeof escalated.value !== "boolean") {
    return bad(`${path}.escalated must be a boolean`);
  }
  return ok(
    Object.freeze({
      kind: kind.value,
      intentId: intentId.value,
      orderId: orderIdValue.value,
      state: orderState.value,
      outcome: outcome.value,
      side: sideValue.value,
      limitPrice: limitPrice.value,
      requestedShares: requestedShares.value,
      filledShares: filledShares.value,
      placedAtMs: placedAtMs.value,
      escalated: escalated.value,
    }),
  );
}

/**
 * Reads the instance state the runtime hands back.
 *
 * An empty document is the FRESH instance (the runtime starts every instance
 * with `{}`), so it yields {@link INITIAL_STATE}. Emptiness is decided from own
 * keys of the materialized copy, so a polluted prototype cannot make a fresh
 * instance look like a running one — or the reverse.
 */
export function readState(raw: unknown): Outcome<StaticBracketState> {
  const materialized = plainCopy(raw, "state");
  if (!materialized.ok) return materialized;
  const record = materialized.value;
  if (!isPlainRecord(record)) {
    return bad(`state must be an object; received ${describe(record)}`);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return ok(INITIAL_STATE);
  }
  for (const key of keys) {
    if (!STATE_KEYS.includes(key)) {
      return bad(`state.${key} is not part of the static-bracket state document`);
    }
  }
  const schemaVersion = readCount(record, "schemaVersion", "state");
  if (!schemaVersion.ok) return schemaVersion;
  if (schemaVersion.value !== STATIC_BRACKET_STATE_SCHEMA_VERSION) {
    return bad(
      `state.schemaVersion ${String(schemaVersion.value)} is not this build's ` +
        `${String(STATIC_BRACKET_STATE_SCHEMA_VERSION)}; §9.6 requires a new run for a ` +
        "state-schema change rather than a migration inside a running instance",
    );
  }
  const instanceStateValue = readOwn(record, "instanceState", "state");
  if (!instanceStateValue.ok) return instanceStateValue;
  const instanceState = readInstanceState(instanceStateValue.value, "state.instanceState");
  if (!instanceState.ok) return instanceState;

  const resumeToValue = readOwn(record, "resumeTo", "state");
  if (!resumeToValue.ok) return resumeToValue;
  let resumeTo: InstanceState | null = null;
  if (resumeToValue.value !== null) {
    const parsed = readInstanceState(resumeToValue.value, "state.resumeTo");
    if (!parsed.ok) return parsed;
    resumeTo = parsed.value;
  }
  const haltReason = readNullableText(record, "haltReason", "state");
  if (!haltReason.ok) return haltReason;
  const entriesExecuted = readCount(record, "entriesExecuted", "state");
  if (!entriesExecuted.ok) return entriesExecuted;
  const intentSequence = readCount(record, "intentSequence", "state");
  if (!intentSequence.ok) return intentSequence;

  const entryOrderValue = readOwn(record, "entryOrder", "state");
  if (!entryOrderValue.ok) return entryOrderValue;
  const entryOrder = readOrderTrack(entryOrderValue.value, "state.entryOrder");
  if (!entryOrder.ok) return entryOrder;
  const exitOrderValue = readOwn(record, "exitOrder", "state");
  if (!exitOrderValue.ok) return exitOrderValue;
  const exitOrder = readOrderTrack(exitOrderValue.value, "state.exitOrder");
  if (!exitOrder.ok) return exitOrder;

  const allocatedShares = readDecimalField(record, "allocatedShares", "state");
  if (!allocatedShares.ok) return allocatedShares;
  const allocatedCost = readDecimalField(record, "allocatedCost", "state");
  if (!allocatedCost.ok) return allocatedCost;
  const exitedShares = readDecimalField(record, "exitedShares", "state");
  if (!exitedShares.ok) return exitedShares;

  const legOutcomeValue = readOwn(record, "legOutcome", "state");
  if (!legOutcomeValue.ok) return legOutcomeValue;
  let legOutcome: Outcome2 | null = null;
  if (legOutcomeValue.value !== null) {
    if (legOutcomeValue.value !== "YES" && legOutcomeValue.value !== "NO") {
      return bad("state.legOutcome must be YES, NO or null");
    }
    legOutcome = legOutcomeValue.value;
  }
  const openedAtMs = readNullableInstant(record, "openedAtMs", "state");
  if (!openedAtMs.ok) return openedAtMs;
  const closedAtMs = readNullableInstant(record, "closedAtMs", "state");
  if (!closedAtMs.ok) return closedAtMs;
  const lastIncident = readNullableText(record, "lastIncident", "state");
  if (!lastIncident.ok) return lastIncident;

  return ok(
    Object.freeze({
      schemaVersion: schemaVersion.value,
      instanceState: instanceState.value,
      resumeTo,
      haltReason: haltReason.value,
      entriesExecuted: entriesExecuted.value,
      intentSequence: intentSequence.value,
      entryOrder: entryOrder.value,
      exitOrder: exitOrder.value,
      allocatedShares: allocatedShares.value,
      allocatedCost: allocatedCost.value,
      exitedShares: exitedShares.value,
      legOutcome,
      openedAtMs: openedAtMs.value,
      closedAtMs: closedAtMs.value,
      lastIncident: lastIncident.value,
    }),
  );
}

function orderToJson(order: OrderTrack | null): PlainJson {
  if (order === null) return null;
  return Object.freeze({
    kind: order.kind,
    intentId: order.intentId,
    orderId: order.orderId,
    state: order.state,
    outcome: order.outcome,
    side: order.side,
    limitPrice: order.limitPrice,
    requestedShares: order.requestedShares,
    filledShares: order.filledShares,
    placedAtMs: order.placedAtMs,
    escalated: order.escalated,
  });
}

/**
 * The whole state document as the `statePatch` of a decision. Plain, frozen,
 * checkpointable JSON: no `undefined`, no accessor, no exotic value.
 */
export function stateToPatch(state: StaticBracketState): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    instanceState: state.instanceState,
    resumeTo: state.resumeTo,
    haltReason: state.haltReason,
    entriesExecuted: state.entriesExecuted,
    intentSequence: state.intentSequence,
    entryOrder: orderToJson(state.entryOrder),
    exitOrder: orderToJson(state.exitOrder),
    allocatedShares: state.allocatedShares,
    allocatedCost: state.allocatedCost,
    exitedShares: state.exitedShares,
    legOutcome: state.legOutcome,
    openedAtMs: state.openedAtMs,
    closedAtMs: state.closedAtMs,
    lastIncident: state.lastIncident,
  };
}

/** Structural copy-with-changes; the state document is immutable by contract. */
export function withState(
  state: StaticBracketState,
  changes: Partial<StaticBracketState>,
): StaticBracketState {
  return Object.freeze({ ...state, ...changes });
}
