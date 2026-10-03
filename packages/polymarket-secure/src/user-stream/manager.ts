/**
 * The user-stream subscription manager (WP-280 deliverables 1 and 3; handoff
 * §9.12 "Subscribe to the authenticated user channel", §9.17 reconciler
 * trigger "user-stream reconnect").
 *
 * CONSTRUCTION GOES THROUGH WP-260's RUN-MODE GATE FIRST.
 * {@link createUserStreamManager} runs `assertSignerGate` on the caller's
 * run-mode context BEFORE it reads the transport, the timers or anything else.
 * In BACKTEST, PAPER, SHADOW, REPLAY or any unreadable context it throws
 * `SignerBoundaryRefusal`, so no port method is ever called and no socket can
 * open (`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`: no process built from
 * this repository today can construct one). There is no other way to build a
 * manager.
 *
 * THE STATE MACHINE ({@link USER_STREAM_TRANSITIONS}; any other transition
 * faults the manager, which then closes itself and requests reconciliation):
 *
 * ```text
 * IDLE ──start──▶ CONNECTING ──opened, subscription frame sent──▶ SUBSCRIBED
 *                     │                                              │
 *                     │ closed / connect timeout / send failed       │ no PONG within staleAfterMs
 *                     ▼                                              ▼
 *                DISCONNECTED ◀──────── closed / send failed ─────  STALE
 *                     │                 │
 *                     │                 └─ the credentials refused {@link MAX_CONSECUTIVE_AUTH_REJECTIONS}
 *                     │                    times in a row ──▶ CLOSED
 *                     ▼ backoff scheduled
 *                RECONNECTING ──backoff elapsed──▶ CONNECTING
 *
 * any state ──stop or fault──▶ CLOSED (terminal)
 * ```
 *
 * AUTHENTICATION FAILURES. An `AUTH_REJECTED` loss requests reconciliation
 * and reconnects like any other loss, but the manager stops re-sending the
 * credentialed subscription once the credentials have been refused
 * {@link MAX_CONSECUTIVE_AUTH_REJECTIONS} times in a row with no recognized
 * message (a `PONG`, an order or a trade event) in between: it then closes
 * (a client choice; the venue documents no policy).
 *
 * RECONCILIATION, AND WHAT THIS ADAPTER DOES NOT DO. The venue states that
 * real-time updates do not replace authoritative account reads and do not
 * deliver the changes missed during a disconnection; the client must fetch
 * open orders and recent trades after reconnecting (`venue-facts.ts`
 * `RECONNECT_GUIDANCE`). This adapter therefore has NO way to obtain missed
 * events: no cursor, no offset, no "since", nothing it could ask the venue
 * for, and it never synthesises an event. Instead it REQUESTS RECONCILIATION:
 *
 * - on every loss of the stream (each {@link StreamLossCause}: the socket
 *   closed, a stale heartbeat, a server error, an authentication failure, a
 *   transport failure, a connect timeout, a failed send, an unclassified close);
 * - on every (re)subscription, after the subscription frame is sent:
 *   `SUBSCRIPTION_STARTED` for the first, `RESUBSCRIBED` (naming the loss
 *   before it) for every later one. Events from before a subscription are
 *   never on the stream, so the authoritative read must follow it;
 * - for markets added to a live subscription (`MARKETS_ADDED`);
 * - for every gap in what it could apply: an unrecognized message, and an
 *   event the OMS projection could not fully apply (`oms-projection.ts`);
 * - for every order or trade event the listener failed to take (it threw):
 *   `EVENT_NOT_DELIVERED`, naming the event's market and identifiers;
 * - when the owner stops a live stream, and when the manager faults.
 *
 * A request about the stream as a whole (a loss, a stop, a fault, an
 * unrecognized message, the overflow) covers EVERYTHING THE STREAM COVERS:
 * every market in the list, and every market the connection's own frames had
 * subscribed it to. A market removed from the list stays in scope until its
 * unsubscribe frame has been sent, so a loss whose unsubscribe never went out
 * (or failed) still covers it. The scope of a loss is read before the lost
 * connection is retired.
 *
 * Every request is emitted to the listener AND kept in a backlog until the
 * consumer acknowledges it, so a listener failure cannot lose one, and an
 * event the listener failed to take becomes a request of its own. The backlog
 * is bounded: when it is full, ONE `BACKLOG_OVERFLOW` request stands for
 * everything that did not fit. Each request that does not fit REPLACES it
 * with a new one (a new id) that covers the union of the markets the previous
 * one covered, the markets of the request that did not fit and everything the
 * stream covers, at the newest subscription generation and after the
 * newest loss. Acknowledging a replaced overflow request clears nothing (its
 * id is unknown by then). If that union outgrows
 * {@link MAX_OVERFLOW_MARKETS}, the manager faults closed rather than grow
 * without bound.
 *
 * NOTHING THROWS after construction: every port call, timer call, clock read
 * and listener call is contained, and what they throw is dropped unread.
 */

import { SignerBoundaryRefusal } from "../errors.js";
import { assertSignerGate } from "../run-mode-gate.js";

import {
  normalizeUserChannelFrame,
  type NormalizedOrderEvent,
  type NormalizedTradeEvent,
  type UnrecognizedMessageReason,
} from "./normalize.js";
import {
  projectOrderEventForOms,
  projectTradeEventForOms,
  type OrderProjection,
  type ProjectionShortfall,
  type TradeProjection,
} from "./oms-projection.js";
import type { AuthenticatedUserSocketPort, UserSocketCloseCause, UserSocketConnection, UserSocketHandlers } from "./socket-port.js";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_STALE_AFTER_MS,
  PING_INTERVAL_MS,
} from "./venue-facts.js";
import { readConditionId } from "./wire.js";

// ---------------------------------------------------------------------------
// States, causes, outputs.

export const USER_STREAM_STATES = ["IDLE", "CONNECTING", "SUBSCRIBED", "STALE", "DISCONNECTED", "RECONNECTING", "CLOSED"] as const;
export type UserStreamState = (typeof USER_STREAM_STATES)[number];

/** The only legal transitions. */
export const USER_STREAM_TRANSITIONS: Readonly<Record<UserStreamState, readonly UserStreamState[]>> = Object.freeze({
  IDLE: Object.freeze(["CONNECTING", "CLOSED"] as const),
  CONNECTING: Object.freeze(["SUBSCRIBED", "DISCONNECTED", "CLOSED"] as const),
  SUBSCRIBED: Object.freeze(["STALE", "DISCONNECTED", "CLOSED"] as const),
  STALE: Object.freeze(["DISCONNECTED", "CLOSED"] as const),
  DISCONNECTED: Object.freeze(["RECONNECTING", "CLOSED"] as const),
  RECONNECTING: Object.freeze(["CONNECTING", "CLOSED"] as const),
  CLOSED: Object.freeze([] as const),
});

/** Why the stream was lost. Every one requests reconciliation. */
export const STREAM_LOSS_CAUSES = [
  "SOCKET_CLOSED",
  "SERVER_ERROR",
  "AUTH_REJECTED",
  "TRANSPORT_ERROR",
  "UNCLASSIFIED_CLOSE",
  "HEARTBEAT_STALE",
  "CONNECT_TIMEOUT",
  "CONNECT_FAILED",
  "SEND_FAILED",
] as const;
export type StreamLossCause = (typeof STREAM_LOSS_CAUSES)[number];

export const RECONCILIATION_CAUSES = [
  ...STREAM_LOSS_CAUSES,
  "SUBSCRIPTION_STARTED",
  "RESUBSCRIBED",
  "MARKETS_ADDED",
  "UNRECOGNIZED_MESSAGE",
  "EVENT_NOT_FULLY_APPLICABLE",
  "EVENT_NOT_DELIVERED",
  "STREAM_STOPPED",
  "MANAGER_FAULT",
  "BACKLOG_OVERFLOW",
] as const;
export type ReconciliationCause = (typeof RECONCILIATION_CAUSES)[number];

/** A request that the reconciler (WP-290) read authoritative orders and trades. */
export interface UserStreamReconciliationRequest {
  readonly requestId: string;
  readonly cause: ReconciliationCause;
  /**
   * For `RESUBSCRIBED`: the loss that preceded this subscription. For
   * `BACKLOG_OVERFLOW`: the newest loss when it was (re)built, if any.
   */
  readonly afterLoss: StreamLossCause | null;
  /**
   * The condition ids the read must cover. For a request about the stream as
   * a whole (a loss, `STREAM_STOPPED`, `MANAGER_FAULT`,
   * `UNRECOGNIZED_MESSAGE`, `BACKLOG_OVERFLOW`): every market in the list and
   * every market the connection's frames had subscribed it to, a removal not
   * yet unsubscribed on the wire included.
   */
  readonly markets: readonly string[];
  readonly subscriptionGeneration: number;
  /** For `EVENT_NOT_FULLY_APPLICABLE`: why the event could not be applied in full. */
  readonly shortfalls: readonly ProjectionShortfall[];
  /** For `UNRECOGNIZED_MESSAGE`: the reason code. */
  readonly unrecognized: UnrecognizedMessageReason | null;
  /** For an event-level request (`EVENT_NOT_FULLY_APPLICABLE`, `EVENT_NOT_DELIVERED`): the identifiers the event named, exactly. */
  readonly venueOrderIds: readonly string[];
  readonly venueTradeId: string | null;
  /** From the injected clock; `null` when the clock could not be read. */
  readonly requestedAt: string | null;
}

/** Where and when a message arrived. */
export interface UserStreamReceipt {
  /** Increments with every connection attempt (handoff §7.1: a resubscription is a new generation). */
  readonly subscriptionGeneration: number;
  /** 1-based count of frames on this connection. */
  readonly frameSequence: number;
  /** Position of the message within its frame (a frame may hold a batch). */
  readonly indexInFrame: number;
  readonly receivedAt: string | null;
}

export type UserStreamOutput =
  | {
      readonly kind: "STATE";
      readonly from: UserStreamState;
      readonly to: UserStreamState;
      readonly cause: StreamLossCause | null;
      readonly subscriptionGeneration: number;
    }
  | { readonly kind: "ORDER"; readonly event: NormalizedOrderEvent; readonly oms: OrderProjection; readonly receipt: UserStreamReceipt }
  | { readonly kind: "TRADE"; readonly event: NormalizedTradeEvent; readonly oms: TradeProjection; readonly receipt: UserStreamReceipt }
  | {
      readonly kind: "UNRECOGNIZED_MESSAGE";
      readonly reason: UnrecognizedMessageReason;
      readonly field: string | null;
      readonly receipt: UserStreamReceipt;
    }
  | { readonly kind: "RECONCILIATION_REQUESTED"; readonly request: UserStreamReconciliationRequest };

export type UserStreamListener = (output: UserStreamOutput) => void;

/** The injected clock and timers (no global clock is read). */
export interface UserStreamTimers {
  /** Epoch milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type MarketChange =
  | { readonly ok: true; readonly changed: readonly string[] }
  | { readonly ok: false; readonly reason: "INVALID_MARKETS" | "WOULD_EMPTY_SUBSCRIPTION" | "CLOSED" };

export interface UserStreamDiagnostics {
  readonly framesReceived: number;
  readonly pongsReceived: number;
  readonly ordersEmitted: number;
  readonly tradesEmitted: number;
  readonly unrecognizedMessages: number;
  readonly reconciliationRequests: number;
  /** Handler calls from a connection that was already retired (ignored; their gap was already reported). */
  readonly ignoredFromRetiredConnections: number;
  readonly listenerFailures: number;
  readonly faults: number;
}

export interface UserStreamManager {
  state(): UserStreamState;
  subscriptionGeneration(): number;
  markets(): readonly string[];
  /** Begin connecting. `false` unless the manager is IDLE. */
  start(): boolean;
  /** Close for good. Idempotent. */
  stop(): void;
  addMarkets(markets: readonly string[]): MarketChange;
  removeMarkets(markets: readonly string[]): MarketChange;
  /** Requests not yet acknowledged, oldest first. */
  pendingReconciliationRequests(): readonly UserStreamReconciliationRequest[];
  /** The reconciler has taken this request. `false` for an unknown id. */
  acknowledgeReconciliationRequest(requestId: string): boolean;
  diagnostics(): UserStreamDiagnostics;
}

/** Client guards (no venue fact bounds these). */
export const MAX_SUBSCRIBED_MARKETS = 1_000;
export const MAX_PENDING_RECONCILIATION_REQUESTS = 1_024;
/** The most markets the one `BACKLOG_OVERFLOW` request may cover before the manager faults closed. */
export const MAX_OVERFLOW_MARKETS = 10 * MAX_SUBSCRIBED_MARKETS;
/** CLIENT CHOICE: refused credentials, in a row with no recognized message between, before the manager closes. */
export const MAX_CONSECUTIVE_AUTH_REJECTIONS = 3;
const MAX_TIMING_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Construction.

export type UserStreamConfigurationErrorCode = "TRANSPORT_INVALID" | "TIMERS_INVALID" | "MARKETS_INVALID" | "LISTENER_INVALID" | "TIMING_INVALID";

/** A configuration refusal. Carries a fixed code and a fixed message; never a value. */
export class UserStreamConfigurationError extends Error {
  override readonly name = "UserStreamConfigurationError";
  readonly code: UserStreamConfigurationErrorCode;

  constructor(code: UserStreamConfigurationErrorCode) {
    super(`user-stream configuration refused: ${code}`);
    this.code = code;
    Object.freeze(this);
  }
}

export interface CreateUserStreamManagerOptions {
  /** `{ runMode, maximumRunMode, allowRealOrders }` from the composition root; see `run-mode-gate.ts`. */
  readonly runModeContext: unknown;
  readonly transport: AuthenticatedUserSocketPort;
  readonly timers: UserStreamTimers;
  /** 1 … {@link MAX_SUBSCRIBED_MARKETS} condition ids. */
  readonly markets: readonly string[];
  readonly onOutput: UserStreamListener;
  /** CLIENT CHOICE; default {@link DEFAULT_STALE_AFTER_MS}. Must exceed the 10 s PING cadence. */
  readonly staleAfterMs?: number;
  readonly connectTimeoutMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

function ownOption(options: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  return descriptor !== undefined && "value" in descriptor ? (descriptor.value as unknown) : undefined;
}

/** A method of a foreign object, read once and bound; `undefined` when it is not a function or cannot be read. */
function method(target: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) return undefined;
    const value: unknown = (target as Record<string, unknown>)[name];
    if (typeof value !== "function") return undefined;
    return (...args: unknown[]) => Reflect.apply(value as (...a: unknown[]) => unknown, target, args) as unknown;
  } catch {
    return undefined;
  }
}

function readMarkets(value: unknown, allowEmpty: boolean): readonly string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length > MAX_SUBSCRIBED_MARKETS) return undefined;
    if (length < 1 && !allowEmpty) return undefined;
    const out: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      const market = readConditionId(descriptor.value);
      if (market === undefined) return undefined;
      if (!out.includes(market)) out.push(market);
    }
    return Object.freeze(out);
  } catch {
    return undefined;
  }
}

function timing(value: unknown, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > MAX_TIMING_MS) {
    throw new UserStreamConfigurationError("TIMING_INVALID");
  }
  return value;
}

/**
 * The ONLY way to build a user-stream manager. Runs WP-260's run-mode gate
 * first; nothing is read from `transport` unless the gate permits. The gate
 * guards this manager's use of the port, not the port's own construction
 * (`socket-port.ts`).
 *
 * @throws {SignerBoundaryRefusal} when the gate refuses (every PAPER process).
 * @throws {UserStreamConfigurationError} for an invalid option.
 */
export function createUserStreamManager(options: CreateUserStreamManagerOptions): UserStreamManager {
  if (typeof options !== "object" || options === null) throw new SignerBoundaryRefusal(["CONTEXT_UNREADABLE"]);
  const option = (key: keyof CreateUserStreamManagerOptions): unknown => {
    try {
      return ownOption(options, key);
    } catch {
      throw new SignerBoundaryRefusal(["CONTEXT_UNREADABLE"]);
    }
  };

  // 1. The run-mode gate, before the transport (or anything else) is read.
  assertSignerGate(option("runModeContext"));

  // 2. Everything else, each read once.
  const transport = option("transport");
  const connect = method(transport, "connect");
  if (connect === undefined) throw new UserStreamConfigurationError("TRANSPORT_INVALID");
  const isAccountOwner = method(transport, "isAccountOwner");
  const timers = option("timers");
  const now = method(timers, "now");
  const setTimer = method(timers, "setTimeout");
  const clearTimer = method(timers, "clearTimeout");
  if (now === undefined || setTimer === undefined || clearTimer === undefined) throw new UserStreamConfigurationError("TIMERS_INVALID");
  const markets = readMarkets(option("markets"), false);
  if (markets === undefined) throw new UserStreamConfigurationError("MARKETS_INVALID");
  const listener = option("onOutput");
  if (typeof listener !== "function") throw new UserStreamConfigurationError("LISTENER_INVALID");
  const staleAfterMs = timing(option("staleAfterMs"), DEFAULT_STALE_AFTER_MS, PING_INTERVAL_MS + 1);
  const connectTimeoutMs = timing(option("connectTimeoutMs"), DEFAULT_CONNECT_TIMEOUT_MS, 1);
  const initialBackoffMs = timing(option("initialBackoffMs"), DEFAULT_INITIAL_BACKOFF_MS, 1);
  const maxBackoffMs = timing(option("maxBackoffMs"), DEFAULT_MAX_BACKOFF_MS, initialBackoffMs);

  return new SubscriptionManager({
    connect: (handlers) => connect(handlers),
    // The raw verdict is passed on: `normalize.ts` reads only `true` (OWN) and `false` (OTHER); anything else is UNDETERMINED.
    isAccountOwner: isAccountOwner === undefined ? undefined : (owner) => isAccountOwner(owner) as boolean,
    now,
    setTimer: (callback, delayMs) => setTimer(callback, delayMs),
    clearTimer: (handle) => {
      clearTimer(handle);
    },
    markets,
    listener: listener as UserStreamListener,
    staleAfterMs,
    connectTimeoutMs,
    initialBackoffMs,
    maxBackoffMs,
  });
}

// ---------------------------------------------------------------------------
// The manager.

interface Settings {
  readonly connect: (handlers: UserSocketHandlers) => unknown;
  readonly isAccountOwner: ((owner: string) => boolean) | undefined;
  readonly now: () => unknown;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly markets: readonly string[];
  readonly listener: UserStreamListener;
  readonly staleAfterMs: number;
  readonly connectTimeoutMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}

type HandlerCall = { readonly kind: "opened" } | { readonly kind: "frame"; readonly text: unknown } | { readonly kind: "closed"; readonly cause: unknown };

interface Connection {
  readonly generation: number;
  handle: unknown;
  retired: boolean;
  frameSequence: number;
  /** The markets this connection's frames have subscribed it to; `null` until its subscription frame is sent. */
  subscribed: Set<string> | null;
}

type TimerSlot = "connect" | "ping" | "stale" | "backoff";

interface TimerEntry {
  handle: unknown;
  /** True while `setTimeout` is running for this entry. */
  scheduling: boolean;
  firedWhileScheduling: boolean;
}

type EventOutput = Extract<UserStreamOutput, { readonly kind: "ORDER" | "TRADE" }>;

/** The scope of an event-level request: the event's market and the identifiers it named, exactly. */
function eventScope(output: EventOutput): {
  readonly markets: readonly string[];
  readonly venueOrderIds: readonly string[];
  readonly venueTradeId?: string;
} {
  if (output.kind === "ORDER") return { markets: [output.event.market], venueOrderIds: [output.event.venueOrderId] };
  const event = output.event;
  return {
    markets: [event.market],
    venueOrderIds: [event.takerOrderId, ...(event.makerOrders ?? []).map((maker) => maker.venueOrderId)],
    venueTradeId: event.venueTradeId,
  };
}

/** An internal invariant failure: the manager faults (fail closed). */
class ManagerFault extends Error {}

const CLOSE_CAUSES: Readonly<Record<UserSocketCloseCause, StreamLossCause>> = Object.freeze({
  CLOSED_BY_PEER: "SOCKET_CLOSED",
  SERVER_ERROR: "SERVER_ERROR",
  AUTH_REJECTED: "AUTH_REJECTED",
  TRANSPORT_ERROR: "TRANSPORT_ERROR",
});

function lossCauseOf(cause: unknown): StreamLossCause {
  return typeof cause === "string" && Object.prototype.hasOwnProperty.call(CLOSE_CAUSES, cause)
    ? CLOSE_CAUSES[cause as UserSocketCloseCause]
    : "UNCLASSIFIED_CLOSE";
}

class SubscriptionManager implements UserStreamManager {
  readonly #settings: Settings;
  #state: UserStreamState = "IDLE";
  #generation = 0;
  #current: Connection | null = null;
  #markets: string[];
  readonly #timers = new Map<TimerSlot, TimerEntry>();
  #backoffMs: number;
  #lastLoss: StreamLossCause | null = null;
  #consecutiveAuthRejections = 0;
  readonly #pending = new Map<string, UserStreamReconciliationRequest>();
  /** The id of the one `BACKLOG_OVERFLOW` request in `#pending`, if any. */
  #overflowId: string | null = null;
  #overflowFaultQueued = false;
  #requestCounter = 0;
  readonly #outbox: UserStreamOutput[] = [];
  readonly #deferred: (() => void)[] = [];
  #depth = 0;
  #flushing = false;
  readonly #counts = {
    framesReceived: 0,
    pongsReceived: 0,
    ordersEmitted: 0,
    tradesEmitted: 0,
    unrecognizedMessages: 0,
    reconciliationRequests: 0,
    ignoredFromRetiredConnections: 0,
    listenerFailures: 0,
    faults: 0,
  };

  constructor(settings: Settings) {
    this.#settings = settings;
    this.#markets = [...settings.markets];
    this.#backoffMs = settings.initialBackoffMs;
  }

  // -- public surface ------------------------------------------------------

  state(): UserStreamState {
    return this.#state;
  }

  subscriptionGeneration(): number {
    return this.#generation;
  }

  markets(): readonly string[] {
    return Object.freeze([...this.#markets]);
  }

  start(): boolean {
    if (this.#state !== "IDLE") return false;
    this.#run(() => this.#connect());
    return true;
  }

  stop(): void {
    if (this.#state === "CLOSED") return;
    this.#run(() => {
      const wasSubscribed = this.#state === "SUBSCRIBED" || this.#state === "STALE";
      // Read before `#shutDown` retires the connection.
      const scope = this.#streamScope(this.#current);
      this.#shutDown(null);
      if (wasSubscribed) this.#request("STREAM_STOPPED", { markets: scope });
    });
  }

  /*
   * Market changes are validated AND applied to the market list at once, at the call, so a later call
   * (one made from inside a port call or a listener included) always sees every earlier one. Only the
   * frames wait for a step: `#syncSubscription` sends the live connection the difference between what
   * it is subscribed to and the market list, so queued changes can neither be lost nor sent twice.
   */

  addMarkets(markets: readonly string[]): MarketChange {
    if (this.#state === "CLOSED") return Object.freeze({ ok: false, reason: "CLOSED" });
    const requested = readMarkets(markets, false);
    if (requested === undefined) return Object.freeze({ ok: false, reason: "INVALID_MARKETS" });
    const added = requested.filter((market) => !this.#markets.includes(market));
    if (this.#markets.length + added.length > MAX_SUBSCRIBED_MARKETS) return Object.freeze({ ok: false, reason: "INVALID_MARKETS" });
    if (added.length > 0) {
      this.#markets.push(...added);
      this.#run(() => this.#syncSubscription());
    }
    return Object.freeze({ ok: true, changed: Object.freeze([...added]) });
  }

  removeMarkets(markets: readonly string[]): MarketChange {
    if (this.#state === "CLOSED") return Object.freeze({ ok: false, reason: "CLOSED" });
    const requested = readMarkets(markets, false);
    if (requested === undefined) return Object.freeze({ ok: false, reason: "INVALID_MARKETS" });
    const removed = requested.filter((market) => this.#markets.includes(market));
    // An empty `markets` list is not "no markets": the venue makes the list optional, and an
    // undocumented reading of an empty one is not something to rely on.
    if (removed.length === this.#markets.length) return Object.freeze({ ok: false, reason: "WOULD_EMPTY_SUBSCRIPTION" });
    if (removed.length > 0) {
      this.#markets = this.#markets.filter((market) => !removed.includes(market));
      this.#run(() => this.#syncSubscription());
    }
    return Object.freeze({ ok: true, changed: Object.freeze([...removed]) });
  }

  pendingReconciliationRequests(): readonly UserStreamReconciliationRequest[] {
    return Object.freeze([...this.#pending.values()]);
  }

  acknowledgeReconciliationRequest(requestId: string): boolean {
    const known = this.#pending.delete(requestId);
    if (known && requestId === this.#overflowId) this.#overflowId = null;
    return known;
  }

  diagnostics(): UserStreamDiagnostics {
    return Object.freeze({ ...this.#counts });
  }

  // -- the step runner -------------------------------------------------------

  /**
   * Run one step. Steps never interleave: a step requested while another runs
   * (a port handler called synchronously inside a port call, an earlier timer
   * firing inside one, or a public method called from inside one) is queued
   * and runs after it. A timer that fires inside its OWN `setTimeout` call is
   * not queued: it breaks the timers contract, and the manager faults
   * (`#schedule`). An internal fault closes the manager. When no step is
   * running, every queued output is delivered, in order.
   */
  #run(step: () => void): void {
    if (this.#depth > 0) {
      this.#deferred.push(step);
      return;
    }
    this.#depth += 1;
    try {
      for (let next: (() => void) | undefined = step; next !== undefined; next = this.#deferred.shift()) {
        try {
          next();
        } catch {
          this.#fault();
        }
      }
    } finally {
      this.#depth -= 1;
    }
    this.#flush();
  }

  #flush(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      for (let output = this.#outbox.shift(); output !== undefined; output = this.#outbox.shift()) {
        const delivered = output;
        try {
          this.#settings.listener(delivered);
        } catch {
          // Dropped unread. A reconciliation request stays in the backlog until acknowledged; an order or
          // trade event the listener did not take becomes a request of its own (delivered next, in this
          // loop). A failure on that request, or on any other output, makes no further request.
          this.#counts.listenerFailures += 1;
          if (delivered.kind === "ORDER" || delivered.kind === "TRADE") {
            this.#run(() => this.#request("EVENT_NOT_DELIVERED", eventScope(delivered)));
          }
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  #emit(output: UserStreamOutput): void {
    this.#outbox.push(Object.freeze(output));
  }

  #transition(to: UserStreamState, cause: StreamLossCause | null): void {
    const from = this.#state;
    if (!USER_STREAM_TRANSITIONS[from].includes(to)) throw new ManagerFault();
    this.#state = to;
    this.#emit({ kind: "STATE", from, to, cause, subscriptionGeneration: this.#generation });
  }

  #fault(): void {
    this.#counts.faults += 1;
    if (this.#state === "CLOSED") return;
    // Read before `#shutDown` retires the connection.
    const scope = this.#streamScope(this.#current);
    try {
      this.#shutDown(null);
    } catch {
      this.#state = "CLOSED";
    }
    this.#request("MANAGER_FAULT", { markets: scope });
  }

  /**
   * Everything the stream covers: every market in the list (an addition not
   * yet sent, or whose send failed, included), then every market the frames of
   * `connection` subscribed it to that the list no longer holds (a removal
   * whose unsubscribe was not yet sent, or failed). The list's order comes
   * first, so with nothing pending this is exactly the list.
   */
  #streamScope(connection: Connection | null): readonly string[] {
    const scope = new Set<string>(this.#markets);
    if (connection !== null && connection.subscribed !== null) for (const market of connection.subscribed) scope.add(market);
    return [...scope];
  }

  #nowIso(): string | null {
    try {
      const value = this.#settings.now();
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) return null;
      return new Date(value).toISOString();
    } catch {
      return null;
    }
  }

  // -- timers ------------------------------------------------------------------

  #schedule(slot: TimerSlot, delayMs: number, fire: () => void): void {
    this.#cancel(slot);
    const entry: TimerEntry = { handle: undefined, scheduling: true, firedWhileScheduling: false };
    const callback = (): void => {
      if (this.#timers.get(slot) !== entry) return; // cancelled or replaced: a no-op
      if (entry.scheduling) {
        entry.firedWhileScheduling = true;
        return;
      }
      this.#timers.delete(slot);
      this.#run(fire);
    };
    // Registered BEFORE `setTimeout` runs, so a fire inside it is seen rather than dropped.
    this.#timers.set(slot, entry);
    try {
      entry.handle = this.#settings.setTimer(callback, delayMs);
    } catch {
      if (this.#timers.get(slot) === entry) this.#timers.delete(slot);
      // Without its timers the manager cannot keep its guarantees: fault (fail closed).
      throw new ManagerFault();
    } finally {
      entry.scheduling = false;
    }
    // A timer that fires inside its own `setTimeout` makes every delay zero; honouring it could spin the
    // reconnect loop without end. The timers port is broken: fault (fail closed).
    if (entry.firedWhileScheduling) throw new ManagerFault();
  }

  #cancel(slot: TimerSlot): void {
    const entry = this.#timers.get(slot);
    if (entry === undefined) return;
    this.#timers.delete(slot);
    try {
      this.#settings.clearTimer(entry.handle);
    } catch {
      // The entry check in the callback makes a timer that still fires a no-op.
    }
  }

  // -- connections ---------------------------------------------------------------

  #connect(): void {
    this.#generation += 1;
    const connection: Connection = { generation: this.#generation, handle: undefined, retired: false, frameSequence: 0, subscribed: null };
    this.#current = connection;
    this.#transition("CONNECTING", null);
    this.#schedule("connect", this.#settings.connectTimeoutMs, () => this.#lose(connection, "CONNECT_TIMEOUT"));
    let handle: unknown;
    try {
      handle = this.#settings.connect(this.#handlersFor(connection));
    } catch {
      this.#lose(connection, "CONNECT_FAILED");
      return;
    }
    if (typeof handle !== "object" || handle === null) {
      this.#lose(connection, "CONNECT_FAILED");
      return;
    }
    // Handler calls made while `connect` ran were queued by `#run`; they run after this step, with the handle set.
    connection.handle = handle;
  }

  /** The handlers of one connection. Every call becomes a step (`#run`), so it never interleaves with another. */
  #handlersFor(connection: Connection): UserSocketHandlers {
    const deliver = (call: HandlerCall): void => this.#run(() => this.#dispatch(connection, call));
    return Object.freeze({
      opened: (): void => deliver({ kind: "opened" }),
      frame: (text: string): void => deliver({ kind: "frame", text }),
      closed: (cause: UserSocketCloseCause): void => deliver({ kind: "closed", cause }),
    });
  }

  #dispatch(connection: Connection, call: HandlerCall): void {
    if (connection.retired || connection !== this.#current) {
      this.#counts.ignoredFromRetiredConnections += 1;
      return;
    }
    switch (call.kind) {
      case "opened":
        this.#onOpened(connection);
        return;
      case "frame":
        this.#onFrame(connection, call.text);
        return;
      case "closed":
        this.#lose(connection, lossCauseOf(call.cause));
        return;
    }
  }

  /** Call a method of the connection's handle; a throw is a lost connection. */
  #send(connection: Connection, call: (handle: unknown) => void): boolean {
    try {
      call(connection.handle);
      return true;
    } catch {
      this.#lose(connection, "SEND_FAILED");
      return false;
    }
  }

  #closeHandle(handle: unknown): void {
    try {
      (handle as UserSocketConnection).close();
    } catch {
      // Already gone; nothing it threw is carried.
    }
  }

  #onOpened(connection: Connection): void {
    if (this.#state !== "CONNECTING") return; // a repeated `opened` changes nothing
    this.#cancel("connect");
    const markets = Object.freeze([...this.#markets]);
    // "Send the subscription frame immediately after connecting" (S-D16). The port adds the credentials.
    if (!this.#send(connection, (handle) => (handle as UserSocketConnection).subscribe(markets))) return;
    connection.subscribed = new Set(markets);
    this.#transition("SUBSCRIBED", null);
    this.#backoffMs = this.#settings.initialBackoffMs;
    this.#schedule("stale", this.#settings.staleAfterMs, () => this.#onStale(connection));
    this.#schedulePing(connection);
    // The stream never holds what happened before this subscription: the read must follow it.
    if (this.#lastLoss === null) this.#request("SUBSCRIPTION_STARTED", { markets });
    else this.#request("RESUBSCRIBED", { markets, afterLoss: this.#lastLoss });
  }

  /**
   * Bring the live connection's subscription to the market list: only the
   * difference is sent, additions first (so the connection is never left
   * subscribed to nothing), and the added markets request reconciliation.
   */
  #syncSubscription(): void {
    const connection = this.#current;
    // Not subscribed: the next subscription frame carries the market list, and its own request covers it.
    if (this.#state !== "SUBSCRIBED" || connection === null || connection.subscribed === null) return;
    const subscribed = connection.subscribed;
    const added = Object.freeze(this.#markets.filter((market) => !subscribed.has(market)));
    const removed = Object.freeze([...subscribed].filter((market) => !this.#markets.includes(market)));
    if (added.length > 0) {
      if (!this.#send(connection, (handle) => (handle as UserSocketConnection).updateSubscription("subscribe", added))) return;
      for (const market of added) subscribed.add(market);
      this.#request("MARKETS_ADDED", { markets: added });
    }
    if (removed.length > 0) {
      if (!this.#send(connection, (handle) => (handle as UserSocketConnection).updateSubscription("unsubscribe", removed))) return;
      for (const market of removed) subscribed.delete(market);
    }
  }

  #schedulePing(connection: Connection): void {
    this.#schedule("ping", PING_INTERVAL_MS, () => {
      if (connection.retired || connection !== this.#current || this.#state !== "SUBSCRIBED") return;
      if (this.#send(connection, (handle) => (handle as UserSocketConnection).ping())) this.#schedulePing(connection);
    });
  }

  #onStale(connection: Connection): void {
    if (connection.retired || connection !== this.#current || this.#state !== "SUBSCRIBED") return;
    this.#transition("STALE", "HEARTBEAT_STALE");
    this.#lose(connection, "HEARTBEAT_STALE");
  }

  /**
   * The stream is lost: retire the connection, request reconciliation, and schedule the reconnect, or,
   * once the credentials have been refused too often in a row, close.
   */
  #lose(connection: Connection, cause: StreamLossCause): void {
    if (connection.retired || connection !== this.#current) return;
    // Read BEFORE the connection is retired: what its frames subscribed it to is lost with it.
    const scope = this.#streamScope(connection);
    connection.retired = true;
    this.#current = null;
    this.#cancel("connect");
    this.#cancel("ping");
    this.#cancel("stale");
    if (connection.handle !== undefined) this.#closeHandle(connection.handle);
    this.#transition("DISCONNECTED", cause);
    this.#lastLoss = cause;
    this.#request(cause, { markets: scope });
    if (cause === "AUTH_REJECTED") {
      this.#consecutiveAuthRejections += 1;
      if (this.#consecutiveAuthRejections >= MAX_CONSECUTIVE_AUTH_REJECTIONS) {
        // The credentials keep being refused: stop re-sending them (fail closed). The request above stands.
        for (const slot of [...this.#timers.keys()]) this.#cancel(slot);
        this.#transition("CLOSED", cause);
        return;
      }
    }
    this.#transition("RECONNECTING", null);
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#settings.maxBackoffMs);
    this.#schedule("backoff", delay, () => {
      if (this.#state === "RECONNECTING") this.#connect();
    });
  }

  #shutDown(cause: StreamLossCause | null): void {
    for (const slot of [...this.#timers.keys()]) this.#cancel(slot);
    const connection = this.#current;
    this.#current = null;
    if (connection !== null) {
      connection.retired = true;
      if (connection.handle !== undefined) this.#closeHandle(connection.handle);
    }
    this.#transition("CLOSED", cause);
  }

  // -- frames ------------------------------------------------------------------

  #onFrame(connection: Connection, text: unknown): void {
    connection.frameSequence += 1;
    this.#counts.framesReceived += 1;
    const messages = normalizeUserChannelFrame(text, { isAccountOwner: this.#settings.isAccountOwner });
    const receivedAt = this.#nowIso();
    for (const [indexInFrame, message] of messages.entries()) {
      if (connection.retired) {
        this.#counts.ignoredFromRetiredConnections += 1;
        continue;
      }
      const receipt: UserStreamReceipt = Object.freeze({
        subscriptionGeneration: connection.generation,
        frameSequence: connection.frameSequence,
        indexInFrame,
        receivedAt,
      });
      // A recognized message is evidence that the server took the subscription and its credentials.
      if (message.kind !== "UNRECOGNIZED") this.#consecutiveAuthRejections = 0;
      switch (message.kind) {
        case "PONG":
          this.#counts.pongsReceived += 1;
          if (this.#state === "SUBSCRIBED") this.#schedule("stale", this.#settings.staleAfterMs, () => this.#onStale(connection));
          break;
        case "ORDER": {
          const oms = projectOrderEventForOms(message.event);
          this.#counts.ordersEmitted += 1;
          this.#emit({ kind: "ORDER", event: message.event, oms, receipt });
          if (oms.shortfalls.length > 0) {
            this.#request("EVENT_NOT_FULLY_APPLICABLE", {
              markets: [message.event.market],
              shortfalls: oms.shortfalls,
              venueOrderIds: [message.event.venueOrderId],
            });
          }
          break;
        }
        case "TRADE": {
          const oms = projectTradeEventForOms(message.event);
          this.#counts.tradesEmitted += 1;
          this.#emit({ kind: "TRADE", event: message.event, oms, receipt });
          if (oms.shortfalls.length > 0) {
            this.#request("EVENT_NOT_FULLY_APPLICABLE", { ...eventScope({ kind: "TRADE", event: message.event, oms, receipt }), shortfalls: oms.shortfalls });
          }
          break;
        }
        case "UNRECOGNIZED":
          this.#counts.unrecognizedMessages += 1;
          this.#emit({ kind: "UNRECOGNIZED_MESSAGE", reason: message.reason, field: message.field, receipt });
          this.#request("UNRECOGNIZED_MESSAGE", { unrecognized: message.reason });
          break;
      }
    }
  }

  // -- reconciliation requests -----------------------------------------------------

  #request(
    cause: ReconciliationCause,
    detail: {
      readonly markets?: readonly string[];
      readonly afterLoss?: StreamLossCause;
      readonly shortfalls?: readonly ProjectionShortfall[];
      readonly unrecognized?: UnrecognizedMessageReason;
      readonly venueOrderIds?: readonly string[];
      readonly venueTradeId?: string;
    },
  ): void {
    const request = this.#makeRequest(cause, detail);
    this.#counts.reconciliationRequests += 1;
    // One slot is kept for the overflow request.
    const held = this.#pending.size - (this.#overflowId === null ? 0 : 1);
    if (held < MAX_PENDING_RECONCILIATION_REQUESTS - 1) this.#pending.set(request.requestId, request);
    else this.#mergeIntoOverflow(request);
    this.#emit({ kind: "RECONCILIATION_REQUESTED", request });
  }

  /**
   * The backlog is full. The one `BACKLOG_OVERFLOW` request is REPLACED, under
   * a new id, by one that covers the markets the previous one covered, the
   * markets of `request`, and everything the stream covers (`#streamScope`),
   * at the current subscription generation and after the newest loss. The
   * replaced id is unknown from then on, so acknowledging it clears nothing
   * newer.
   */
  #mergeIntoOverflow(request: UserStreamReconciliationRequest): void {
    const previous = this.#overflowId === null ? undefined : this.#pending.get(this.#overflowId);
    const markets = new Set<string>(previous?.markets ?? []);
    for (const market of request.markets) markets.add(market);
    for (const market of this.#streamScope(this.#current)) markets.add(market);
    if (previous !== undefined) this.#pending.delete(previous.requestId);
    const overflow = this.#makeRequest("BACKLOG_OVERFLOW", { markets: [...markets], ...(this.#lastLoss === null ? {} : { afterLoss: this.#lastLoss }) });
    this.#pending.set(overflow.requestId, overflow);
    this.#overflowId = overflow.requestId;
    if (markets.size > MAX_OVERFLOW_MARKETS && this.#state !== "CLOSED" && !this.#overflowFaultQueued) {
      // The union would grow without bound: fail closed. A closed manager adds little after that: its own
      // markets, and those of events still being handed to the listener.
      this.#overflowFaultQueued = true;
      this.#run(() => {
        this.#fault();
      });
    }
  }

  #makeRequest(
    cause: ReconciliationCause,
    detail: {
      readonly markets?: readonly string[];
      readonly afterLoss?: StreamLossCause;
      readonly shortfalls?: readonly ProjectionShortfall[];
      readonly unrecognized?: UnrecognizedMessageReason;
      readonly venueOrderIds?: readonly string[];
      readonly venueTradeId?: string;
    },
  ): UserStreamReconciliationRequest {
    this.#requestCounter += 1;
    return Object.freeze({
      requestId: `user-stream-reconcile-${String(this.#requestCounter)}`,
      cause,
      afterLoss: detail.afterLoss ?? null,
      // No explicit scope: the request is about the stream as a whole.
      markets: Object.freeze([...(detail.markets ?? this.#streamScope(this.#current))]),
      subscriptionGeneration: this.#generation,
      shortfalls: Object.freeze([...(detail.shortfalls ?? [])]),
      unrecognized: detail.unrecognized ?? null,
      venueOrderIds: Object.freeze([...new Set(detail.venueOrderIds ?? [])]),
      venueTradeId: detail.venueTradeId ?? null,
      requestedAt: this.#nowIso(),
    });
  }
}
