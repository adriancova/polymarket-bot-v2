/**
 * The order-heartbeat controller (WP-320; ADR-033 D1–D4 and D6; ADR-008
 * §2–§4; handoff §9.12 "heartbeat orders", §9.13 rank 1, §9.18).
 *
 * ## Construction goes through WP-260's run-mode gate first (ADR-033 D4)
 *
 * {@link createOrderHeartbeatController} runs `assertSignerGate` on the
 * caller's run-mode context BEFORE it reads the transport or anything else,
 * as `createUserStreamManager` does. In BACKTEST, PAPER, SHADOW, REPLAY, above
 * the process maximum, without real orders allowed, or with an unreadable
 * context it throws `SignerBoundaryRefusal`, and the port is never touched.
 * Under the repository's defaults (`MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false`) no process can construct one. There is no other
 * way to build a controller.
 *
 * ## What the controller owns (ADR-033 D1)
 *
 * 1. **The protocol, as the guide gives it** (provisional, D2;
 *    `venue-facts.ts`): the id chain (an empty id first unless one is
 *    resumed, then each returned id); the documented `400` recovery, ONE new
 *    request with the expected id; repeated `400`s raise
 *    {@link HeartbeatEvent} `LIVE_FENCING_CONFLICT` (ADR-008 §4, §14.4 page);
 *    the 5 s cadence, measured from each send. Every confirmed id, and every
 *    expected id a `400` supplies, is handed to the {@link HeartbeatIdSink}
 *    (ADR-008 §4: the id is persisted with the fencing lease), latest first,
 *    never awaited by the heartbeat path.
 * 2. **The gate.** A heartbeat is sent only when {@link HeartbeatGate}
 *    answers, at that moment, with an own data property `permitted` that is
 *    exactly `true`. The composition's gate says yes only while the process
 *    holds the current fencing token AND the health lease holds
 *    (`apps/trader/src/live-safety/`). Anything else refuses: `false`, a
 *    missing or accessor property, a promise, a throw. "Each must be
 *    confirmed, not assumed: an unknown result fails the gate." Kill-switch
 *    state and the explicit stops (§9.9's "Stop heartbeat", `ops-cli
 *    stop-heartbeat`) reach the controller only through this gate (D1 items
 *    3–4).
 * 3. **Stopping (D1 item 5; ADR-008 §2).** When the gate refuses, nothing is
 *    sent and any pending `400` retry is abandoned. The gate is asked again
 *    at the next tick; the controller sends again only when it passes.
 * 4. **The rate class (D3).** Every request is filed with WP-310's budget as
 *    `clob.heartbeat` at `ORDER_HEARTBEAT`, and completed when its call
 *    settles (a grant never used is completed at once as `NOT_SENT`). A
 *    refused request is not sent. A QUEUED request stays queued, so it keeps
 *    its rank-1 reservation and no lower class can take the capacity it waits
 *    for; its grant reaches the controller through
 *    {@link OrderHeartbeatController.onBudgetEvents}, the gate is asked again,
 *    and only then is it sent. A ticket still queued at the next tick is
 *    withdrawn and the budget asked afresh. Throughout, the lapse clock keeps
 *    running (D3: "A refused or queued request delays or drops the
 *    heartbeat").
 *
 * ## A lapsed heartbeat (D6)
 *
 * - **The clock** is the injected MONOTONIC clock; the budget alone gets the
 *   epoch clock it is specified in. A send time is read just before the port
 *   is called. A monotonic reading that goes backwards, or is unreadable, is
 *   a CLOCK FAULT: every age measured before it is void, so the heartbeat is
 *   lapsed (`LAPSE_STARTED`, cause `CLOCK_FAULT`) and the call in flight, if
 *   any, is abandoned.
 * - **Confirmed** means a success carrying the next id
 *   (`protocol.ts`, `CONFIRMED`) that arrived LESS than 10 s after its send
 *   time. Everything else is unconfirmed: not sent, a transport error, a
 *   timeout, an unknown answer, a `400`, a success without an id (S-D18's
 *   shape fails closed), and a success that arrives 10 s or more after its
 *   send. A late success still advances the id chain; it never moves the
 *   deadline.
 * - **Lapsed** once 10 s have passed since the SEND time of the last
 *   confirmed heartbeat. The controller STARTS LAPSED: `start()` reports
 *   `LAPSE_STARTED` with cause `STARTUP` before anything is sent.
 * - **A lapse ends** when a heartbeat is confirmed (above) while lapsed:
 *   `LAPSE_ENDED`, naming the confirmed send time and the confirmation time.
 *   Ending the entry block it latches is the composition's (D6 steps 1–5,
 *   `apps/trader/src/live-safety/lapse-recovery.ts`).
 *
 * A lapse is reported by a timer set at the deadline, AND checked again on
 * every tick, every answer and every {@link OrderHeartbeatController.isLapsed}
 * read, so a late timer never hides it. The deadline timer keeps running after
 * `stop()`: stopping sends nothing more, but the lapse that follows is still
 * reported. Only `close()` ends it.
 *
 * ## What it never does
 *
 * It holds no credential, signs nothing, opens no socket and performs no I/O:
 * the transport is a port, and no binding of it exists in this repository
 * (ADR-033 D2; D5 is open for the user). It never puts a heartbeat id in an
 * event. PAPER only.
 */

import { SignerBoundaryRefusal } from "../errors.js";
import type { BudgetEffect, BudgetRequest, BudgetResult, Grant, GrantCompletion, RequestDecision } from "../rate-limit/index.js";
import { assertSignerGate } from "../run-mode-gate.js";

import { budgetErrorOf, classifyHeartbeatAnswer, isHeartbeatId, type HeartbeatOutcome, type OrderHeartbeatTransport } from "./protocol.js";
import { BOOTSTRAP_HEARTBEAT_ID, HEARTBEAT_CADENCE_MS, HEARTBEAT_OPERATION_ID, HEARTBEAT_PRIORITY, HEARTBEAT_TIMEOUT_MS } from "./venue-facts.js";

// ---------------------------------------------------------------------------
// Ports.

/** The slice of WP-310's `RateLimitBudget` the controller uses. */
export interface HeartbeatBudget {
  request(input: BudgetRequest, atMs: number): RequestDecision;
  withdraw(ticketId: string): boolean;
  complete(grant: Grant, completion: GrantCompletion): BudgetResult<readonly BudgetEffect[]>;
}

/**
 * The gate (ADR-033 D1 item 2). Answers synchronously, and within the health
 * lease's evaluation budget (ADR-008 §4 consequence 2): `{ permitted: true }`
 * permits; anything else refuses, and its `reasons` (closed codes) are
 * reported.
 */
export interface HeartbeatGate {
  evaluate(): unknown;
}

export interface HeartbeatClock {
  /** The process's monotonic clock, in milliseconds (ADR-033 D6). */
  monotonicMs(): number;
  /** Unix epoch milliseconds, for WP-310's budget only (`RateLimitBudget.request`'s `atMs`). */
  epochMs(): number;
}

export interface HeartbeatTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Persists the venue's current heartbeat id with the fencing lease (ADR-008 §4). `true` means persisted. */
export interface HeartbeatIdSink {
  persist(heartbeatId: string): Promise<unknown>;
}

/** Why a heartbeat was not confirmed. */
export type UnconfirmedReason =
  | "GATE_REFUSED"
  | "BUDGET_QUEUED"
  | "BUDGET_REFUSED"
  | "SUCCESS_WITHOUT_ID"
  | "INVALID_ID"
  | "RATE_LIMITED"
  | "REJECTED"
  | "TRANSPORT_FAILED"
  | "UNKNOWN_OUTCOME"
  | "RESPONSE_TIMEOUT"
  | "LATE_CONFIRMATION"
  | "CLOCK_FAULT"
  | "STOPPED";

/** What a lapse is reported with: the last reason a heartbeat went unconfirmed, or why there was none. */
export type LapseCause = UnconfirmedReason | "STARTUP" | "NO_ATTEMPT";

export type HeartbeatEvent =
  | {
      readonly kind: "LAPSE_STARTED";
      readonly cause: LapseCause;
      /** The gate's reasons when the cause is `GATE_REFUSED` (e.g. the health lease's failed inputs); otherwise empty. */
      readonly gateReasons: readonly string[];
      readonly atMs: number;
      readonly lastConfirmedSendAtMs: number | null;
    }
  | { readonly kind: "LAPSE_ENDED"; readonly confirmedSendAtMs: number; readonly confirmedAtMs: number }
  | { readonly kind: "HEARTBEAT_SENT"; readonly sentAtMs: number; readonly recovery: boolean }
  | { readonly kind: "HEARTBEAT_CONFIRMED"; readonly sentAtMs: number; readonly confirmedAtMs: number }
  | { readonly kind: "HEARTBEAT_UNCONFIRMED"; readonly reason: UnconfirmedReason; readonly gateReasons: readonly string[]; readonly atMs: number }
  /** ADR-008 §4: repeated invalid-id responses are evidence of a second writer (§14.4 page "Live fencing conflict"). */
  | { readonly kind: "LIVE_FENCING_CONFLICT"; readonly invalidIdResponses: number; readonly windowMs: number; readonly atMs: number }
  | { readonly kind: "HEARTBEAT_ID_NOT_PERSISTED"; readonly atMs: number };

export interface HeartbeatStatus {
  readonly started: boolean;
  readonly stopped: boolean;
  readonly closed: boolean;
  readonly lapsed: boolean;
  readonly inFlight: boolean;
  readonly lastConfirmedSendAtMs: number | null;
  readonly lastConfirmedAtMs: number | null;
  /** Whether the chain has an id to send (never the id itself). */
  readonly hasHeartbeatId: boolean;
  readonly lastUnconfirmedReason: UnconfirmedReason | null;
}

export interface OrderHeartbeatController {
  /** Report the startup lapse, then send the first heartbeat (subject to the gate and the budget). Once. */
  start(): void;
  /** Send nothing more, abandoning any pending recovery. The lapse that follows is still reported. Final. */
  stop(): void;
  /** Stop, and clear every timer. Final. */
  close(): void;
  /** D6: whether 10 s have passed since the send time of the last confirmed heartbeat (or none was ever confirmed). */
  isLapsed(): boolean;
  /**
   * Every event a `RateLimitBudget.poll()` returned. The composition's poll loop hands each poll's events here
   * (WP-310 follow_up 1, "run the wake timer"): a queued heartbeat's grant arrives this way, and the gate is asked
   * again before it is sent. Events for other tickets are ignored.
   */
  onBudgetEvents(events: unknown): void;
  status(): HeartbeatStatus;
}

/** CLIENT CHOICES (no venue fact), each configurable within its bound. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 4_000;
export const DEFAULT_INVALID_ID_ALERT_THRESHOLD = 2;
export const DEFAULT_INVALID_ID_WINDOW_MS = 60_000;
const MAX_TIMING_MS = 60_000;
const MAX_GATE_REASONS = 16;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export type HeartbeatConfigurationErrorCode =
  | "TRANSPORT_INVALID"
  | "GATE_INVALID"
  | "BUDGET_INVALID"
  | "CLOCK_INVALID"
  | "TIMERS_INVALID"
  | "LISTENER_INVALID"
  | "SINK_INVALID"
  | "HEARTBEAT_ID_INVALID"
  | "TIMING_INVALID";

/** An option the factory refuses (after the run-mode gate has permitted). A fixed code only. */
export class HeartbeatConfigurationError extends Error {
  override readonly name = "HeartbeatConfigurationError";
  readonly code: HeartbeatConfigurationErrorCode;

  constructor(code: HeartbeatConfigurationErrorCode) {
    super(`order-heartbeat configuration refused: ${code}`);
    this.code = code;
    Object.freeze(this);
  }
}

export interface CreateOrderHeartbeatControllerOptions {
  /** `{ runMode, maximumRunMode, allowRealOrders }` from the composition root; see `run-mode-gate.ts`. Read FIRST. */
  readonly runModeContext: unknown;
  readonly transport: OrderHeartbeatTransport;
  readonly gate: HeartbeatGate;
  readonly budget: HeartbeatBudget;
  readonly clock: HeartbeatClock;
  readonly timers: HeartbeatTimers;
  readonly onEvent: (event: HeartbeatEvent) => void;
  readonly heartbeatIds?: HeartbeatIdSink;
  /** The id to resume the chain with (the fencing lease's `inheritedHeartbeatId`); default `""`, the bootstrap. */
  readonly initialHeartbeatId?: string;
  /** CLIENT CHOICE: an answer later than this abandons the call (`RESPONSE_TIMEOUT`). Default {@link DEFAULT_RESPONSE_TIMEOUT_MS}. */
  readonly responseTimeoutMs?: number;
  /** CLIENT CHOICE: this many invalid-id answers within {@link CreateOrderHeartbeatControllerOptions.invalidIdWindowMs} raise the conflict alert. */
  readonly invalidIdAlertThreshold?: number;
  readonly invalidIdWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Reading foreign objects: own data properties, methods read once and bound.

function own(target: unknown, key: string): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  if (typeof target !== "object" || target === null) return { found: false };
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !("value" in descriptor)) return { found: false };
  return { found: true, value: descriptor.value as unknown };
}

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

function timing(value: unknown, fallback: number, min: number, max: number = MAX_TIMING_MS): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HeartbeatConfigurationError("TIMING_INVALID");
  }
  return value;
}

interface GateVerdict {
  readonly permitted: boolean;
  readonly reasons: readonly string[];
}

const GATE_PERMITS: GateVerdict = Object.freeze({ permitted: true, reasons: Object.freeze([]) });

function refusedGate(reason: string): GateVerdict {
  return Object.freeze({ permitted: false, reasons: Object.freeze([reason]) });
}

/** The gate's answer, read once: own data `permitted === true`, or a refusal with its (closed-code) reasons. */
function readGate(answer: unknown): GateVerdict {
  const permitted = own(answer, "permitted");
  if (permitted.found && permitted.value === true) return GATE_PERMITS;
  const reasonsRead = own(answer, "reasons");
  const reasons: string[] = [];
  if (reasonsRead.found && Array.isArray(reasonsRead.value)) {
    const list: readonly unknown[] = reasonsRead.value;
    for (let index = 0; index < list.length && reasons.length < MAX_GATE_REASONS; index += 1) {
      const entry = own(list, String(index));
      if (entry.found && typeof entry.value === "string" && REASON_CODE.test(entry.value)) reasons.push(entry.value);
    }
  }
  if (reasons.length === 0) reasons.push(permitted.found && permitted.value === false ? "GATE_REFUSED" : "GATE_UNREADABLE");
  return Object.freeze({ permitted: false, reasons: Object.freeze(reasons) });
}

// ---------------------------------------------------------------------------

interface Flight {
  readonly sentAtMs: number;
  readonly grant: Grant;
  readonly recovery: boolean;
  /** The answer arrived (or the call threw). */
  settled: boolean;
  /** A timeout or a clock fault gave up on it: its answer, if any, is not used. */
  abandoned: boolean;
}

interface Dependencies {
  readonly send: (request: { readonly heartbeatId: string }) => unknown;
  readonly gate: () => unknown;
  readonly request: (input: BudgetRequest, atMs: number) => unknown;
  readonly withdraw: (ticketId: string) => unknown;
  readonly complete: (grant: Grant, completion: GrantCompletion) => unknown;
  readonly monotonicMs: () => unknown;
  readonly epochMs: () => unknown;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly onEvent: (event: HeartbeatEvent) => void;
  readonly persist: ((heartbeatId: string) => unknown) | undefined;
  readonly initialHeartbeatId: string;
  readonly responseTimeoutMs: number;
  readonly invalidIdAlertThreshold: number;
  readonly invalidIdWindowMs: number;
}

class HeartbeatController implements OrderHeartbeatController {
  readonly #deps: Dependencies;
  #started = false;
  #stopped = false;
  #closed = false;
  /** The id the next request carries. Never put in an event. */
  #heartbeatId: string;
  /** A `400` supplied the expected id, and the documented ONE recovery request has not been sent yet. */
  #recoveryDue = false;
  #flight: Flight | null = null;
  /** A request the budget queued: it keeps its reservation until its grant is routed here, or the next tick withdraws it. */
  #queuedTicket: string | null = null;
  #lastConfirmedSendAt: number | null = null;
  #lastConfirmedAt: number | null = null;
  /** The current lapse has been reported (`LAPSE_STARTED`) and has not ended. True from `start()`: it starts lapsed. */
  #lapseReported = false;
  #lastUnconfirmed: { readonly reason: UnconfirmedReason; readonly gateReasons: readonly string[] } | null = null;
  #lastNow: number | null = null;
  readonly #invalidIdTimes: number[] = [];
  #tickTimer: unknown = null;
  #deadlineTimer: unknown = null;
  #responseTimer: unknown = null;
  #persistPending: string | null = null;
  #persisting = false;

  constructor(deps: Dependencies) {
    this.#deps = deps;
    this.#heartbeatId = deps.initialHeartbeatId;
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    // D6: the controller starts lapsed. The composition runs the lapse-start steps with cause "startup".
    this.#lapseReported = true;
    const now = this.#now();
    this.#emit({
      kind: "LAPSE_STARTED",
      cause: "STARTUP",
      gateReasons: Object.freeze([]),
      atMs: now ?? 0,
      lastConfirmedSendAtMs: null,
    });
    this.#schedule(0);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#recoveryDue = false;
    this.#clearTick();
    this.#withdrawQueued();
    const now = this.#now();
    this.#unconfirmed("STOPPED", [], now ?? 0);
  }

  close(): void {
    this.stop();
    this.#closed = true;
    this.#clear(this.#deadlineTimer);
    this.#deadlineTimer = null;
    this.#clear(this.#responseTimer);
    this.#responseTimer = null;
  }

  isLapsed(): boolean {
    const now = this.#now();
    if (now === null) return true;
    this.#checkLapse(now);
    return this.#lastConfirmedSendAt === null || now - this.#lastConfirmedSendAt >= HEARTBEAT_TIMEOUT_MS;
  }

  status(): HeartbeatStatus {
    return Object.freeze({
      started: this.#started,
      stopped: this.#stopped,
      closed: this.#closed,
      lapsed: this.isLapsed(),
      inFlight: this.#flight !== null,
      lastConfirmedSendAtMs: this.#lastConfirmedSendAt,
      lastConfirmedAtMs: this.#lastConfirmedAt,
      hasHeartbeatId: this.#heartbeatId.length > 0,
      lastUnconfirmedReason: this.#lastUnconfirmed?.reason ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // The cadence.

  #tick(): void {
    this.#tickTimer = null;
    if (this.#stopped || this.#closed || !this.#started) return;
    const now = this.#now();
    if (now === null) {
      this.#schedule(HEARTBEAT_CADENCE_MS);
      return;
    }
    this.#checkLapse(now);
    // One request at a time: the id rotates on every success, so a second request would carry a stale id.
    if (this.#flight !== null) return;
    // A ticket still queued from the previous tick is stale: it is withdrawn, and the budget is asked afresh.
    this.#withdrawQueued();

    // 1. The gate (D1 item 2): the fence AND the health lease, confirmed now.
    const verdict = this.#evaluateGate();
    if (!verdict.permitted) {
      // D1 item 5: send nothing, and abandon any pending 400 retry.
      this.#recoveryDue = false;
      this.#unconfirmed("GATE_REFUSED", verdict.reasons, now);
      this.#schedule(HEARTBEAT_CADENCE_MS);
      return;
    }

    // 2. The rate class (D3): `clob.heartbeat` at `ORDER_HEARTBEAT`, or nothing is sent.
    const decision = this.#requestGrant();
    if (decision.kind === "QUEUED") {
      // The ticket STAYS queued, so it keeps its rank-1 reservation and no lower class can take the capacity it is
      // waiting for (WP-310). Its grant arrives through `onBudgetEvents`; the next tick withdraws it if it has not.
      this.#queuedTicket = decision.ticketId;
      this.#unconfirmed("BUDGET_QUEUED", [], now);
      this.#schedule(HEARTBEAT_CADENCE_MS);
      return;
    }
    if (decision.kind === "REFUSED") {
      this.#unconfirmed("BUDGET_REFUSED", [], now);
      this.#schedule(HEARTBEAT_CADENCE_MS);
      return;
    }
    this.#send(decision.grant);
  }

  onBudgetEvents(events: unknown): void {
    if (this.#queuedTicket === null || !Array.isArray(events)) return;
    const list: readonly unknown[] = events;
    for (let index = 0; index < list.length; index += 1) {
      const event = own(list, String(index));
      if (!event.found) continue;
      const ticket = own(event.value, "ticketId");
      if (!ticket.found || ticket.value !== this.#queuedTicket) continue;
      this.#queuedTicket = null;
      const kind = own(event.value, "kind");
      const grant = own(event.value, "grant");
      if (kind.found && kind.value === "GRANTED" && grant.found && typeof grant.value === "object" && grant.value !== null) {
        const granted = grant.value as Grant;
        if (this.#stopped || this.#closed || this.#flight !== null) {
          this.#completeUnused(granted);
          return;
        }
        // The gate is asked AGAIN: the process may have become unhealthy while the ticket waited.
        const verdict = this.#evaluateGate();
        if (!verdict.permitted) {
          this.#completeUnused(granted);
          this.#recoveryDue = false;
          this.#unconfirmed("GATE_REFUSED", verdict.reasons, this.#lastNow ?? 0);
          return;
        }
        this.#send(granted);
      } else {
        this.#unconfirmed("BUDGET_REFUSED", [], this.#lastNow ?? 0);
      }
      return;
    }
  }

  /** Send ONE heartbeat under `grant`. The send time is read just before the port is called (D6). */
  #send(grant: Grant): void {
    const recovery = this.#recoveryDue;
    this.#recoveryDue = false;
    const sentAtMs = this.#now();
    if (sentAtMs === null) {
      // A clock fault between the gate and the send: nothing is sent; the grant is closed unused.
      this.#completeUnused(grant);
      this.#schedule(HEARTBEAT_CADENCE_MS);
      return;
    }
    const flight: Flight = { sentAtMs, grant, recovery, settled: false, abandoned: false };
    this.#flight = flight;
    this.#emit({ kind: "HEARTBEAT_SENT", sentAtMs, recovery });
    this.#responseTimer = this.#deps.setTimer(() => {
      this.#onTimeout(flight);
    }, this.#deps.responseTimeoutMs);
    let answer: Promise<unknown>;
    try {
      answer = Promise.resolve(this.#deps.send(Object.freeze({ heartbeatId: this.#heartbeatId })));
    } catch {
      answer = Promise.resolve(undefined);
    }
    answer.then(
      (value) => {
        this.#onAnswer(flight, value);
      },
      () => {
        this.#onAnswer(flight, undefined);
      },
    );
  }

  #evaluateGate(): GateVerdict {
    try {
      return readGate(this.#deps.gate());
    } catch {
      return refusedGate("GATE_THREW");
    }
  }

  /** The budget's decision, read once by own data property. */
  #requestGrant(): { readonly kind: "GRANTED"; readonly grant: Grant } | { readonly kind: "QUEUED"; readonly ticketId: string } | { readonly kind: "REFUSED" } {
    let decision: unknown;
    try {
      const atMs = this.#deps.epochMs();
      if (typeof atMs !== "number") return { kind: "REFUSED" };
      decision = this.#deps.request(Object.freeze({ operationId: HEARTBEAT_OPERATION_ID, priority: HEARTBEAT_PRIORITY }), atMs);
    } catch {
      return { kind: "REFUSED" };
    }
    const kind = own(decision, "kind");
    if (kind.found && kind.value === "GRANTED") {
      const grant = own(decision, "grant");
      return grant.found && typeof grant.value === "object" && grant.value !== null ? { kind: "GRANTED", grant: grant.value as Grant } : { kind: "REFUSED" };
    }
    if (kind.found && kind.value === "QUEUED") {
      const ticket = own(decision, "ticketId");
      if (ticket.found && typeof ticket.value === "string") return { kind: "QUEUED", ticketId: ticket.value };
    }
    return { kind: "REFUSED" };
  }

  #withdrawQueued(): void {
    const ticket = this.#queuedTicket;
    if (ticket === null) return;
    this.#queuedTicket = null;
    try {
      this.#deps.withdraw(ticket);
    } catch {
      // A withdraw that throws leaves a ticket nobody waits for; its grant, if routed, matches no ticket and is closed by the budget's owner.
    }
  }

  /** A grant whose request was never sent: closed at once, so the budget does not hold it outstanding. */
  #completeUnused(grant: Grant): void {
    try {
      const atMs = this.#deps.epochMs();
      this.#deps.complete(grant, Object.freeze({ atMs: typeof atMs === "number" ? atMs : 0, error: Object.freeze({ kind: "NOT_SENT", retryAfterSeconds: null }) }));
    } catch {
      // The budget's own refusal changes nothing here.
    }
  }

  #completeGrant(grant: Grant, outcome: HeartbeatOutcome): void {
    try {
      const atMs = this.#deps.epochMs();
      this.#deps.complete(grant, Object.freeze({ atMs: typeof atMs === "number" ? atMs : 0, error: budgetErrorOf(outcome) }));
    } catch {
      // The budget's own refusal (e.g. INVALID_TIME) changes nothing here.
    }
  }

  #onTimeout(flight: Flight): void {
    if (flight.settled || flight.abandoned || this.#flight !== flight) return;
    flight.abandoned = true;
    this.#flight = null;
    this.#responseTimer = null;
    const now = this.#now();
    if (now === null) return;
    this.#checkLapse(now);
    this.#unconfirmed("RESPONSE_TIMEOUT", [], now);
    this.#scheduleAfter(flight, now);
  }

  #onAnswer(flight: Flight, answer: unknown): void {
    if (flight.settled) return;
    flight.settled = true;
    const outcome = classifyHeartbeatAnswer(answer);
    // The grant is completed when its call settles (WP-310), whether or not its answer is used.
    this.#completeGrant(flight.grant, outcome);
    if (flight.abandoned || this.#closed || this.#flight !== flight) return;
    this.#flight = null;
    this.#clear(this.#responseTimer);
    this.#responseTimer = null;
    const now = this.#now();
    if (now === null) return;
    // A lapse that is due is reported before the answer is applied, so a lapse is never skipped.
    this.#checkLapse(now);

    switch (outcome.kind) {
      case "CONFIRMED": {
        this.#heartbeatId = outcome.nextHeartbeatId;
        this.#persist(outcome.nextHeartbeatId);
        if (now - flight.sentAtMs < HEARTBEAT_TIMEOUT_MS) {
          this.#confirm(flight.sentAtMs, now);
        } else {
          // D6: a confirmation 10 s or more after its send leaves the heartbeat lapsed; a late arrival never moves the deadline.
          this.#unconfirmed("LATE_CONFIRMATION", [], now);
        }
        break;
      }
      case "INVALID_ID": {
        // The expected id is the chain's from now on; ONE new request carries it (S-D17), unless this was that request.
        this.#heartbeatId = outcome.expectedHeartbeatId;
        this.#persist(outcome.expectedHeartbeatId);
        this.#recordInvalidId(now);
        if (!flight.recovery && !this.#stopped) this.#recoveryDue = true;
        this.#unconfirmed("INVALID_ID", [], now);
        break;
      }
      case "SUCCESS_WITHOUT_ID":
        this.#unconfirmed("SUCCESS_WITHOUT_ID", [], now);
        break;
      case "RATE_LIMITED":
        this.#unconfirmed("RATE_LIMITED", [], now);
        break;
      case "REJECTED":
        this.#unconfirmed("REJECTED", [], now);
        break;
      case "FAILED":
        this.#unconfirmed("TRANSPORT_FAILED", [], now);
        break;
      case "UNKNOWN":
        this.#unconfirmed("UNKNOWN_OUTCOME", [], now);
        break;
    }
    this.#scheduleAfter(flight, now);
  }

  #confirm(sentAtMs: number, now: number): void {
    const wasLapsed = this.#lapseReported;
    this.#lastConfirmedSendAt = this.#lastConfirmedSendAt === null ? sentAtMs : Math.max(this.#lastConfirmedSendAt, sentAtMs);
    this.#lastConfirmedAt = now;
    this.#lastUnconfirmed = null;
    this.#invalidIdTimes.length = 0;
    this.#armDeadline(now);
    this.#emit({ kind: "HEARTBEAT_CONFIRMED", sentAtMs, confirmedAtMs: now });
    if (wasLapsed) {
      this.#lapseReported = false;
      this.#emit({ kind: "LAPSE_ENDED", confirmedSendAtMs: sentAtMs, confirmedAtMs: now });
    }
  }

  /** Report the lapse once it is due (10 s after the last confirmed send), unless it is reported already. */
  #checkLapse(now: number): void {
    if (this.#lapseReported || !this.#started) return;
    if (this.#lastConfirmedSendAt !== null && now - this.#lastConfirmedSendAt < HEARTBEAT_TIMEOUT_MS) return;
    this.#lapseReported = true;
    const last = this.#lastUnconfirmed;
    this.#emit({
      kind: "LAPSE_STARTED",
      cause: last?.reason ?? "NO_ATTEMPT",
      gateReasons: last?.gateReasons ?? Object.freeze([]),
      atMs: now,
      lastConfirmedSendAtMs: this.#lastConfirmedSendAt,
    });
  }

  #armDeadline(now: number): void {
    this.#clear(this.#deadlineTimer);
    this.#deadlineTimer = null;
    if (this.#closed || this.#lastConfirmedSendAt === null) return;
    const delay = Math.max(0, this.#lastConfirmedSendAt + HEARTBEAT_TIMEOUT_MS - now);
    this.#deadlineTimer = this.#deps.setTimer(() => {
      this.#deadlineTimer = null;
      const at = this.#now();
      if (at === null) return;
      this.#checkLapse(at);
      // A timer that fired early is set again; one that fired on time found the lapse.
      if (!this.#lapseReported) this.#armDeadline(at);
    }, delay);
  }

  #recordInvalidId(now: number): void {
    const windowMs = this.#deps.invalidIdWindowMs;
    this.#invalidIdTimes.push(now);
    while (this.#invalidIdTimes.length > 0 && now - (this.#invalidIdTimes[0] as number) > windowMs) this.#invalidIdTimes.shift();
    if (this.#invalidIdTimes.length >= this.#deps.invalidIdAlertThreshold) {
      this.#emit({ kind: "LIVE_FENCING_CONFLICT", invalidIdResponses: this.#invalidIdTimes.length, windowMs, atMs: now });
    }
  }

  #unconfirmed(reason: UnconfirmedReason, gateReasons: readonly string[], now: number): void {
    const frozen = Object.freeze([...gateReasons]);
    this.#lastUnconfirmed = Object.freeze({ reason, gateReasons: frozen });
    this.#emit({ kind: "HEARTBEAT_UNCONFIRMED", reason, gateReasons: frozen, atMs: now });
  }

  /** The next tick: at once for a due recovery, else one cadence after the send. */
  #scheduleAfter(flight: Flight, now: number): void {
    if (this.#stopped || this.#closed) return;
    this.#schedule(this.#recoveryDue ? 0 : Math.max(0, flight.sentAtMs + HEARTBEAT_CADENCE_MS - now));
  }

  #schedule(delayMs: number): void {
    if (this.#stopped || this.#closed) return;
    this.#clearTick();
    this.#tickTimer = this.#deps.setTimer(() => {
      this.#tick();
    }, delayMs);
  }

  #clearTick(): void {
    this.#clear(this.#tickTimer);
    this.#tickTimer = null;
  }

  #clear(handle: unknown): void {
    if (handle === null) return;
    try {
      this.#deps.clearTimer(handle);
    } catch {
      // A timer that cannot be cleared fires into a closed or rescheduled controller, which ignores it.
    }
  }

  /**
   * The monotonic clock, or `null` on a CLOCK FAULT (unreadable, or earlier than a reading already seen). A fault
   * voids every age measured before it: the heartbeat is lapsed from here, and the call in flight is abandoned.
   */
  #now(): number | null {
    let value: unknown;
    try {
      value = this.#deps.monotonicMs();
    } catch {
      value = undefined;
    }
    const reading = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    if (reading !== null && (this.#lastNow === null || reading >= this.#lastNow)) {
      this.#lastNow = reading;
      return reading;
    }
    if (reading !== null) this.#lastNow = reading;
    this.#clockFault(reading);
    return null;
  }

  #clockFault(at: number | null): void {
    this.#lastConfirmedSendAt = null;
    this.#clear(this.#deadlineTimer);
    this.#deadlineTimer = null;
    const flight = this.#flight;
    if (flight !== null) {
      flight.abandoned = true;
      this.#flight = null;
      this.#clear(this.#responseTimer);
      this.#responseTimer = null;
    }
    this.#lastUnconfirmed = Object.freeze({ reason: "CLOCK_FAULT" as const, gateReasons: Object.freeze([]) });
    if (this.#started && !this.#lapseReported) {
      this.#lapseReported = true;
      this.#emit({ kind: "LAPSE_STARTED", cause: "CLOCK_FAULT", gateReasons: Object.freeze([]), atMs: at ?? 0, lastConfirmedSendAtMs: null });
    }
    if (this.#started && !this.#stopped && !this.#closed && this.#tickTimer === null) this.#schedule(HEARTBEAT_CADENCE_MS);
  }

  /** Hand the latest id to the sink, one call at a time, never awaited by the heartbeat path. */
  #persist(heartbeatId: string): void {
    const persist = this.#deps.persist;
    if (persist === undefined) return;
    this.#persistPending = heartbeatId;
    if (this.#persisting) return;
    const next = (): void => {
      const id = this.#persistPending;
      this.#persistPending = null;
      if (id === null) {
        this.#persisting = false;
        return;
      }
      this.#persisting = true;
      let result: Promise<unknown>;
      try {
        result = Promise.resolve(persist(id));
      } catch {
        result = Promise.resolve(false);
      }
      result.then(
        (value) => {
          if (value !== true) this.#emit({ kind: "HEARTBEAT_ID_NOT_PERSISTED", atMs: this.#lastNow ?? 0 });
          next();
        },
        () => {
          this.#emit({ kind: "HEARTBEAT_ID_NOT_PERSISTED", atMs: this.#lastNow ?? 0 });
          next();
        },
      );
    };
    next();
  }

  #emit(event: HeartbeatEvent): void {
    try {
      this.#deps.onEvent(Object.freeze(event));
    } catch {
      // A listener that throws loses its event; the controller's state is unaffected.
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * The ONLY way to build an order-heartbeat controller. Runs WP-260's run-mode
 * gate first (ADR-033 D4); nothing is read from the transport, the gate or
 * the budget unless it permits.
 *
 * @throws {SignerBoundaryRefusal} when the run-mode gate refuses (every PAPER process).
 * @throws {HeartbeatConfigurationError} for an invalid option.
 */
export function createOrderHeartbeatController(options: CreateOrderHeartbeatControllerOptions): OrderHeartbeatController {
  if (typeof options !== "object" || options === null) throw new SignerBoundaryRefusal(["CONTEXT_UNREADABLE"]);
  const option = (key: keyof CreateOrderHeartbeatControllerOptions): unknown => {
    try {
      const read = own(options, key);
      return read.found ? read.value : undefined;
    } catch {
      throw new SignerBoundaryRefusal(["CONTEXT_UNREADABLE"]);
    }
  };

  // 1. ADR-033 D4: the run-mode gate, before anything else is read.
  assertSignerGate(option("runModeContext"));

  // 2. Everything else, each read once.
  const send = method(option("transport"), "send");
  if (send === undefined) throw new HeartbeatConfigurationError("TRANSPORT_INVALID");
  const gate = method(option("gate"), "evaluate");
  if (gate === undefined) throw new HeartbeatConfigurationError("GATE_INVALID");
  const budget = option("budget");
  const request = method(budget, "request");
  const withdraw = method(budget, "withdraw");
  const complete = method(budget, "complete");
  if (request === undefined || withdraw === undefined || complete === undefined) throw new HeartbeatConfigurationError("BUDGET_INVALID");
  const clock = option("clock");
  const monotonicMs = method(clock, "monotonicMs");
  const epochMs = method(clock, "epochMs");
  if (monotonicMs === undefined || epochMs === undefined) throw new HeartbeatConfigurationError("CLOCK_INVALID");
  const timers = option("timers");
  const setTimer = method(timers, "setTimeout");
  const clearTimer = method(timers, "clearTimeout");
  if (setTimer === undefined || clearTimer === undefined) throw new HeartbeatConfigurationError("TIMERS_INVALID");
  const listener = option("onEvent");
  if (typeof listener !== "function") throw new HeartbeatConfigurationError("LISTENER_INVALID");
  const sink = option("heartbeatIds");
  const persist = sink === undefined ? undefined : method(sink, "persist");
  if (sink !== undefined && persist === undefined) throw new HeartbeatConfigurationError("SINK_INVALID");
  const initial = option("initialHeartbeatId");
  if (initial !== undefined && initial !== BOOTSTRAP_HEARTBEAT_ID && !isHeartbeatId(initial)) throw new HeartbeatConfigurationError("HEARTBEAT_ID_INVALID");

  return new HeartbeatController({
    send: (heartbeatRequest) => send(heartbeatRequest),
    gate: () => gate(),
    request: (input, atMs) => request(input, atMs),
    withdraw: (ticketId) => withdraw(ticketId),
    complete: (grant, completion) => complete(grant, completion),
    monotonicMs: () => monotonicMs(),
    epochMs: () => epochMs(),
    setTimer: (callback, delayMs) => setTimer(callback, delayMs),
    clearTimer: (handle) => {
      clearTimer(handle);
    },
    onEvent: (event) => {
      Reflect.apply(listener, undefined, [event]);
    },
    persist: persist === undefined ? undefined : (heartbeatId) => persist(heartbeatId),
    initialHeartbeatId: typeof initial === "string" ? initial : BOOTSTRAP_HEARTBEAT_ID,
    responseTimeoutMs: timing(option("responseTimeoutMs"), DEFAULT_RESPONSE_TIMEOUT_MS, 1),
    invalidIdAlertThreshold: timing(option("invalidIdAlertThreshold"), DEFAULT_INVALID_ID_ALERT_THRESHOLD, 1, 100),
    invalidIdWindowMs: timing(option("invalidIdWindowMs"), DEFAULT_INVALID_ID_WINDOW_MS, 1, 3_600_000),
  });
}
