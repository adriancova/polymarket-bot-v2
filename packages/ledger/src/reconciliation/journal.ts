/**
 * The reconciliation JOURNAL (WP-290; handoff §9.17 step 6 "Emit append-only
 * reconciliation events"; §10.6 `ops.reconciliation_runs` and
 * `ops.reconciliation_breaks`).
 *
 * APPEND-ONLY. The journal is a sequence of immutable events. Nothing is ever
 * edited or deleted: a break that is resolved gets a `BREAK_RESOLVED` event, a
 * run that ends gets a `RUN_COMPLETED` event. The two `ops` tables are
 * PROJECTIONS of this sequence ({@link ReconciliationJournal.runs},
 * {@link ReconciliationJournal.breaks}): every column of a row is derived from
 * the events, so a composition root may write the rows from the events, and
 * a rebuild from the events equals the incremental state.
 *
 * DURABLE FIRST. {@link ReconciliationJournal.append} validates an event
 * against the current state, hands it to the injected {@link JournalSink},
 * and only after the sink has accepted it folds it into memory. So memory is
 * never ahead of what is durable. A sink that rejects or throws FAULTS the
 * journal: the write may or may not have committed (an ambiguous commit), so
 * every later append is refused until the journal is reopened from its
 * history ({@link ReconciliationJournal.open}). A coordinator that cannot
 * record cannot resume (fail closed).
 *
 * TRANSITIONS the journal itself enforces (defence in depth: the coordinator
 * obeys them, and a coordinator that did not would be refused):
 *
 * - one run at a time: `RUN_STARTED` is refused while another run is RUNNING;
 * - every break, answer and quarantine names the RUNNING run;
 * - one unresolved break per subject: `BREAK_OPENED` is refused while another
 *   break with the same `subjectKey` is OPEN or QUARANTINED;
 * - `BREAK_QUARANTINED` only for a rule that quarantines
 *   (`QUARANTINE_UNTIL_RELEASED`, `UNATTRIBUTED_HALT`), and only from OPEN;
 * - `BREAK_RESOLVED`:
 *   - `RESOLVED_IN_RUN` only for `RESOLVE_IN_RUN`, inside the run that opened it;
 *   - `NOT_REPRODUCED` only for `HOLD_UNTIL_CONSISTENT` (or a
 *     `RESOLVE_IN_RUN` break its run left open), inside a LATER run;
 *   - `OPERATOR_RELEASED` only for a QUARANTINED break, naming the operator
 *     and a reason. Ambiguity (HOLD) is never released by an operator;
 * - `RUN_COMPLETED` with `PASSED` only when NO break in the whole journal is
 *   unresolved; with `QUARANTINED` only when some break is QUARANTINED;
 * - `RESUME_REFUSED` only right after the latest run completed `PASSED`
 *   (resume happens only once that record is durable; the OMS may still
 *   refuse it, and so may the coordinator itself, when work arrived while
 *   the record was being written).
 *
 * Times are epoch milliseconds from the coordinator's injected clock (safe
 * non-negative integers). Identifiers are caller-minted (this package draws
 * no randomness): run and break ids are canonical UUIDv7 (`internal.uuid_v7`).
 * No economic value is a JavaScript number: expected and observed values are
 * canonical decimal strings.
 *
 * Pure layer-1 logic: no I/O except through the sink port, no clock, no
 * randomness.
 */

import { isCanonicalDecimalString } from "@polymarket-bot/decimal";
import { appendData } from "@polymarket-bot/risk/plain-data";

import { readInputAsData } from "../refusals.js";

import {
  BREAK_RESOLUTIONS,
  BREAK_SCOPES,
  RECONCILIATION_TRIGGERS,
  breakRule,
  isBreakClass,
  isOperatorReleasable,
  quarantinesOnOpen,
  releaseAcknowledgesSubject,
  type BreakClass,
  type BreakResolution,
  type BreakRule,
  type BreakScope,
  type BreakStatus,
  type ReconciliationRunStatus,
  type ReconciliationTrigger,
} from "./taxonomy.js";

// ---------------------------------------------------------------------------
// Events.

/** The channel an answer went to. */
export const ANSWER_CHANNELS = ["ORDER", "WALLET_OPERATION", "USER_STREAM"] as const;
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number];

export interface RunStartedEvent {
  readonly kind: "RUN_STARTED";
  readonly runId: string;
  readonly accountRef: string;
  /** The trigger the run is recorded under (`ops.reconciliation_runs.trigger_reason`). */
  readonly trigger: ReconciliationTrigger;
  /** Every trigger the run answers, without repetition. */
  readonly triggers: readonly ReconciliationTrigger[];
  readonly atMs: number;
}

export interface RunCompletedEvent {
  readonly kind: "RUN_COMPLETED";
  readonly runId: string;
  readonly status: Exclude<ReconciliationRunStatus, "RUNNING">;
  readonly ordersChecked: number;
  readonly fillsChecked: number;
  readonly walletOperationsChecked: number;
  readonly breaksFound: number;
  readonly detail: string;
  readonly atMs: number;
}

export interface BreakOpenedEvent {
  readonly kind: "BREAK_OPENED";
  readonly breakId: string;
  readonly runId: string;
  readonly breakClass: BreakClass;
  /** What the break is about, as a stable key: at most one unresolved break per subject. */
  readonly subjectKey: string;
  readonly scope: BreakScope;
  readonly marketId: string | null;
  readonly orderId: string | null;
  readonly fillId: string | null;
  readonly walletOperationId: string | null;
  readonly assetId: string | null;
  readonly expectedValue: string | null;
  readonly observedValue: string | null;
  readonly detail: string;
  readonly atMs: number;
}

export interface BreakQuarantinedEvent {
  readonly kind: "BREAK_QUARANTINED";
  readonly breakId: string;
  readonly runId: string;
  /** The ledger transaction that booked the activity to UNATTRIBUTED, when one did (`resolution_ledger_transaction_id`). */
  readonly resolutionLedgerTransactionId: string | null;
  readonly atMs: number;
}

export interface BreakResolvedEvent {
  readonly kind: "BREAK_RESOLVED";
  readonly breakId: string;
  /** The run that resolved it; `null` for an operator's release. */
  readonly runId: string | null;
  readonly resolution: BreakResolution;
  /** Who released it (`OPERATOR_RELEASED` only). */
  readonly operatorRef: string | null;
  readonly detail: string;
  readonly atMs: number;
}

export interface AnswerRecordedEvent {
  readonly kind: "ANSWER_RECORDED";
  readonly runId: string;
  readonly channel: AnswerChannel;
  /** The request's id, echoed verbatim. */
  readonly requestId: string;
  /** The attempt, the wallet operation, or the stream request the answer concerns. */
  readonly subjectId: string;
  /** `ABSENT`, `PRESENT`, a wallet state (`CONFIRMED`, `FAILED`), or `ACKNOWLEDGED`. */
  readonly verdict: string;
  readonly accepted: boolean;
  readonly refusalCode: string | null;
  readonly atMs: number;
}

export interface ResumeRefusedEvent {
  readonly kind: "RESUME_REFUSED";
  readonly runId: string;
  readonly refusalCode: string;
  readonly atMs: number;
}

/** What a caller hands to {@link ReconciliationJournal.append}. */
export type ReconciliationJournalInput =
  | RunStartedEvent
  | RunCompletedEvent
  | BreakOpenedEvent
  | BreakQuarantinedEvent
  | BreakResolvedEvent
  | AnswerRecordedEvent
  | ResumeRefusedEvent;

/** An appended event: the input plus its 0-based position in the journal. */
export type ReconciliationJournalEvent = ReconciliationJournalInput & { readonly sequence: number };

/** The durable store of the journal (a composition binds it to `ops.*`). */
export interface JournalSink {
  append(event: ReconciliationJournalEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Views (the two `ops` tables).

export interface ReconciliationRunView {
  readonly runId: string;
  readonly accountRef: string;
  readonly trigger: ReconciliationTrigger;
  readonly triggers: readonly ReconciliationTrigger[];
  readonly status: ReconciliationRunStatus;
  readonly ordersChecked: number;
  readonly fillsChecked: number;
  readonly walletOperationsChecked: number;
  readonly breaksFound: number;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly detail: string | null;
}

export interface ReconciliationBreakView {
  readonly breakId: string;
  readonly runId: string;
  readonly breakClass: BreakClass;
  readonly rule: BreakRule;
  readonly subjectKey: string;
  readonly scope: BreakScope;
  readonly status: BreakStatus;
  readonly marketId: string | null;
  readonly orderId: string | null;
  readonly fillId: string | null;
  readonly walletOperationId: string | null;
  readonly assetId: string | null;
  readonly expectedValue: string | null;
  readonly observedValue: string | null;
  readonly resolutionLedgerTransactionId: string | null;
  readonly resolution: BreakResolution | null;
  readonly resolvedByRunId: string | null;
  readonly operatorRef: string | null;
  readonly detail: string;
  readonly openedAtMs: number;
  readonly resolvedAtMs: number | null;
}

// ---------------------------------------------------------------------------
// Results.

export const JOURNAL_REFUSAL_CODES = [
  "RECON_EVENT_INVALID",
  "RECON_TRANSITION_ILLEGAL",
  "RECON_JOURNAL_FAULTED",
  "RECON_SINK_FAILED",
  "RECON_HISTORY_INVALID",
] as const;
export type JournalRefusalCode = (typeof JOURNAL_REFUSAL_CODES)[number];

export type JournalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: { readonly code: JournalRefusalCode; readonly message: string } };

function refused<T>(code: JournalRefusalCode, message: string): JournalResult<T> {
  return Object.freeze({ ok: false as const, refusal: Object.freeze({ code, message }) });
}

function accepted<T>(value: T): JournalResult<T> {
  return Object.freeze({ ok: true as const, value });
}

// ---------------------------------------------------------------------------
// Field grammar (the WP-040 domains, migration 0001).

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const MAX_IDENTIFIER = 200;
const MAX_DETAIL = 2000;
/** Subject keys and request ids are composite keys: longer than one identifier, still bounded. */
const MAX_KEY = 2000;

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

function isText(value: unknown, max: number, allowEmpty = false): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isIdentifier(value: unknown): value is string {
  return isText(value, MAX_IDENTIFIER);
}

function isMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullable<T>(value: unknown, check: (candidate: unknown) => candidate is T): value is T | null {
  return value === null || check(value);
}

function isDecimal(value: unknown): value is string {
  return isCanonicalDecimalString(value);
}

function isTrigger(value: unknown): value is ReconciliationTrigger {
  return typeof value === "string" && (RECONCILIATION_TRIGGERS as readonly string[]).includes(value);
}

/** Read one field of a materialized (prototype-free) record: own data only. */
function field(record: unknown, key: string): unknown {
  if (record === null || typeof record !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? (descriptor.value as unknown) : undefined;
}

function exactKeys(record: unknown, keys: readonly string[]): boolean {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  const own = Object.keys(record);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

const KEYS: Readonly<Record<ReconciliationJournalInput["kind"], readonly string[]>> = Object.freeze({
  RUN_STARTED: ["kind", "runId", "accountRef", "trigger", "triggers", "atMs"],
  RUN_COMPLETED: ["kind", "runId", "status", "ordersChecked", "fillsChecked", "walletOperationsChecked", "breaksFound", "detail", "atMs"],
  BREAK_OPENED: [
    "kind",
    "breakId",
    "runId",
    "breakClass",
    "subjectKey",
    "scope",
    "marketId",
    "orderId",
    "fillId",
    "walletOperationId",
    "assetId",
    "expectedValue",
    "observedValue",
    "detail",
    "atMs",
  ],
  BREAK_QUARANTINED: ["kind", "breakId", "runId", "resolutionLedgerTransactionId", "atMs"],
  BREAK_RESOLVED: ["kind", "breakId", "runId", "resolution", "operatorRef", "detail", "atMs"],
  ANSWER_RECORDED: ["kind", "runId", "channel", "requestId", "subjectId", "verdict", "accepted", "refusalCode", "atMs"],
  RESUME_REFUSED: ["kind", "runId", "refusalCode", "atMs"],
});

/**
 * Read an event's SHAPE: own plain data, exact keys, every field in its
 * domain. `undefined` for anything else. The returned event is a fresh frozen
 * copy; nothing of the caller's object is read again.
 */
function readEvent(raw: unknown, withSequence: boolean): ReconciliationJournalEvent | ReconciliationJournalInput | undefined {
  const read = readInputAsData(raw, "event", "reconciliation journal event");
  if (!read.ok) return undefined;
  const record = read.value;
  const kind = field(record, "kind");
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(KEYS, kind)) return undefined;
  const keys = KEYS[kind as ReconciliationJournalInput["kind"]];
  if (!exactKeys(record, withSequence ? [...keys, "sequence"] : keys)) return undefined;
  const at = field(record, "atMs");
  if (!isMs(at)) return undefined;
  let event: ReconciliationJournalInput | undefined;
  switch (kind) {
    case "RUN_STARTED": {
      const runId = field(record, "runId");
      const accountRef = field(record, "accountRef");
      const trigger = field(record, "trigger");
      const triggers = field(record, "triggers");
      if (!isUuidV7(runId) || !isIdentifier(accountRef) || !isTrigger(trigger) || !Array.isArray(triggers)) return undefined;
      if (triggers.length < 1 || triggers.length > RECONCILIATION_TRIGGERS.length) return undefined;
      const list: ReconciliationTrigger[] = [];
      for (const entry of triggers) {
        if (!isTrigger(entry) || list.includes(entry)) return undefined;
        appendData(list, entry);
      }
      if (!list.includes(trigger)) return undefined;
      event = { kind, runId, accountRef, trigger, triggers: Object.freeze(list), atMs: at };
      break;
    }
    case "RUN_COMPLETED": {
      const runId = field(record, "runId");
      const status = field(record, "status");
      const counts = ["ordersChecked", "fillsChecked", "walletOperationsChecked", "breaksFound"].map((key) => field(record, key));
      const detail = field(record, "detail");
      if (!isUuidV7(runId) || (status !== "PASSED" && status !== "FAILED" && status !== "QUARANTINED")) return undefined;
      if (!counts.every(isCount) || !isText(detail, MAX_DETAIL, true)) return undefined;
      const [ordersChecked, fillsChecked, walletOperationsChecked, breaksFound] = counts as number[];
      event = {
        kind,
        runId,
        status,
        ordersChecked: ordersChecked as number,
        fillsChecked: fillsChecked as number,
        walletOperationsChecked: walletOperationsChecked as number,
        breaksFound: breaksFound as number,
        detail,
        atMs: at,
      };
      break;
    }
    case "BREAK_OPENED": {
      const breakId = field(record, "breakId");
      const runId = field(record, "runId");
      const breakClass = field(record, "breakClass");
      const subjectKey = field(record, "subjectKey");
      const scope = field(record, "scope");
      const marketId = field(record, "marketId");
      const orderId = field(record, "orderId");
      const fillId = field(record, "fillId");
      const walletOperationId = field(record, "walletOperationId");
      const assetId = field(record, "assetId");
      const expectedValue = field(record, "expectedValue");
      const observedValue = field(record, "observedValue");
      const detail = field(record, "detail");
      if (!isUuidV7(breakId) || !isUuidV7(runId) || !isBreakClass(breakClass) || !CODE.test(breakClass)) return undefined;
      if (!isText(subjectKey, MAX_KEY) || typeof scope !== "string" || !(BREAK_SCOPES as readonly string[]).includes(scope)) return undefined;
      if (!nullable(marketId, isUuidV7) || !nullable(orderId, isUuidV7) || !nullable(fillId, isUuidV7) || !nullable(walletOperationId, isUuidV7)) return undefined;
      if (!nullable(assetId, isIdentifier) || !nullable(expectedValue, isDecimal) || !nullable(observedValue, isDecimal) || !isText(detail, MAX_DETAIL)) return undefined;
      // A market-scoped break names its market (§9.15: "the affected market is halted").
      if ((scope === "MARKET") !== (marketId !== null)) return undefined;
      event = {
        kind,
        breakId,
        runId,
        breakClass,
        subjectKey,
        scope: scope as BreakScope,
        marketId,
        orderId,
        fillId,
        walletOperationId,
        assetId,
        expectedValue,
        observedValue,
        detail,
        atMs: at,
      };
      break;
    }
    case "BREAK_QUARANTINED": {
      const breakId = field(record, "breakId");
      const runId = field(record, "runId");
      const ledgerTx = field(record, "resolutionLedgerTransactionId");
      if (!isUuidV7(breakId) || !isUuidV7(runId) || !nullable(ledgerTx, isUuidV7)) return undefined;
      event = { kind, breakId, runId, resolutionLedgerTransactionId: ledgerTx, atMs: at };
      break;
    }
    case "BREAK_RESOLVED": {
      const breakId = field(record, "breakId");
      const runId = field(record, "runId");
      const resolution = field(record, "resolution");
      const operatorRef = field(record, "operatorRef");
      const detail = field(record, "detail");
      if (!isUuidV7(breakId) || !nullable(runId, isUuidV7) || typeof resolution !== "string") return undefined;
      if (!(BREAK_RESOLUTIONS as readonly string[]).includes(resolution) || !nullable(operatorRef, isIdentifier) || !isText(detail, MAX_DETAIL)) return undefined;
      // An operator's release names the operator and no run; a run's resolution names the run and no operator.
      if ((resolution === "OPERATOR_RELEASED") !== (operatorRef !== null) || (resolution === "OPERATOR_RELEASED") !== (runId === null)) return undefined;
      event = { kind, breakId, runId, resolution: resolution as BreakResolution, operatorRef, detail, atMs: at };
      break;
    }
    case "ANSWER_RECORDED": {
      const runId = field(record, "runId");
      const channel = field(record, "channel");
      const requestId = field(record, "requestId");
      const subjectId = field(record, "subjectId");
      const verdict = field(record, "verdict");
      const acceptedFlag = field(record, "accepted");
      const refusalCode = field(record, "refusalCode");
      if (!isUuidV7(runId) || typeof channel !== "string" || !(ANSWER_CHANNELS as readonly string[]).includes(channel)) return undefined;
      if (!isText(requestId, MAX_KEY) || !isIdentifier(subjectId) || typeof verdict !== "string" || !CODE.test(verdict)) return undefined;
      if (typeof acceptedFlag !== "boolean" || !(refusalCode === null || (typeof refusalCode === "string" && CODE.test(refusalCode)))) return undefined;
      if (acceptedFlag === (refusalCode !== null)) return undefined;
      event = { kind, runId, channel: channel as AnswerChannel, requestId, subjectId, verdict, accepted: acceptedFlag, refusalCode, atMs: at };
      break;
    }
    case "RESUME_REFUSED": {
      const runId = field(record, "runId");
      const refusalCode = field(record, "refusalCode");
      if (!isUuidV7(runId) || typeof refusalCode !== "string" || !CODE.test(refusalCode)) return undefined;
      event = { kind, runId, refusalCode, atMs: at };
      break;
    }
    default:
      return undefined;
  }
  if (!withSequence) return Object.freeze(event);
  const sequence = field(record, "sequence");
  if (!isCount(sequence)) return undefined;
  return Object.freeze({ ...event, sequence });
}

// ---------------------------------------------------------------------------
// The journal.

interface MutableRun {
  view: ReconciliationRunView;
}

interface MutableBreak {
  view: ReconciliationBreakView;
}

export class ReconciliationJournal {
  readonly #accountRef: string;
  readonly #sink: JournalSink | null;
  readonly #events: ReconciliationJournalEvent[] = [];
  readonly #runs = new Map<string, MutableRun>();
  readonly #breaks = new Map<string, MutableBreak>();
  /** subjectKey → the id of its unresolved (OPEN or QUARANTINED) break. */
  readonly #unresolvedBySubject = new Map<string, string>();
  #runningRunId: string | null = null;
  #lastRunId: string | null = null;
  #faulted = false;
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(accountRef: string, sink: JournalSink | null) {
    this.#accountRef = accountRef;
    this.#sink = sink;
  }

  /**
   * Open a journal for one account over its durable history (events in
   * `sequence` order, as the sink received them). Every history event is
   * validated and replayed under the same transition rules as a live append,
   * so a history that could not have been appended is refused whole.
   */
  static open(input: { readonly accountRef: string; readonly sink: JournalSink; readonly history: readonly unknown[] }): JournalResult<ReconciliationJournal> {
    try {
      const accountRef: unknown = field(input, "accountRef");
      const sink: unknown = field(input, "sink");
      const history: unknown = field(input, "history");
      if (!isIdentifier(accountRef)) return refused("RECON_EVENT_INVALID", "a journal needs the account it reconciles");
      if (sink === null || typeof sink !== "object" || typeof (sink as { append?: unknown }).append !== "function") {
        return refused("RECON_EVENT_INVALID", "a journal needs a sink with an append method");
      }
      if (!Array.isArray(history)) return refused("RECON_HISTORY_INVALID", "the history must be an array of events");
      const journal = new ReconciliationJournal(accountRef, sink as JournalSink);
      for (let index = 0; index < history.length; index += 1) {
        const event = readEvent(history[index], true) as ReconciliationJournalEvent | undefined;
        if (event === undefined || event.sequence !== index) {
          return refused("RECON_HISTORY_INVALID", `history event ${String(index)} is not a journal event at that position`);
        }
        const problem = journal.#check(event);
        if (problem !== undefined) return refused("RECON_HISTORY_INVALID", `history event ${String(index)}: ${problem}`);
        journal.#fold(event);
      }
      return accepted(journal);
    } catch {
      return refused("RECON_HISTORY_INVALID", "the history could not be read");
    }
  }

  get accountRef(): string {
    return this.#accountRef;
  }

  get faulted(): boolean {
    return this.#faulted;
  }

  /** The run currently RUNNING, if any. */
  get runningRunId(): string | null {
    return this.#runningRunId;
  }

  /** The rule of a break class (the taxonomy is the journal's). */
  ruleOf(breakClass: BreakClass): BreakRule {
    return breakRule(breakClass);
  }

  /** Whether an operator's release of this class acknowledges its subject for good (the taxonomy's `RELEASE_ACKNOWLEDGES_SUBJECT`). */
  releaseAcknowledgesSubject(breakClass: BreakClass): boolean {
    return releaseAcknowledgesSubject(breakClass);
  }

  events(): readonly ReconciliationJournalEvent[] {
    return Object.freeze([...this.#events]);
  }

  runs(): readonly ReconciliationRunView[] {
    return Object.freeze([...this.#runs.values()].map((run) => run.view));
  }

  breaks(): readonly ReconciliationBreakView[] {
    return Object.freeze([...this.#breaks.values()].map((entry) => entry.view));
  }

  /** Breaks still OPEN or QUARANTINED, in the order they were opened. */
  unresolvedBreaks(): readonly ReconciliationBreakView[] {
    return Object.freeze([...this.#breaks.values()].map((entry) => entry.view).filter((view) => view.status !== "RESOLVED"));
  }

  /**
   * Append one event: validated, then durable, then folded. Appends are
   * serialized in call order. Never throws.
   */
  append(raw: unknown): Promise<JournalResult<ReconciliationJournalEvent>> {
    const next = this.#chain.then(() => this.#appendNow(raw));
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #appendNow(raw: unknown): Promise<JournalResult<ReconciliationJournalEvent>> {
    if (this.#faulted) return refused("RECON_JOURNAL_FAULTED", "the journal is faulted; reopen it from its history");
    let input: ReconciliationJournalInput | undefined;
    try {
      input = readEvent(raw, false) as ReconciliationJournalInput | undefined;
    } catch {
      input = undefined;
    }
    if (input === undefined) return refused("RECON_EVENT_INVALID", "the value is not a journal event in its domain");
    const event = Object.freeze({ ...input, sequence: this.#events.length }) as ReconciliationJournalEvent;
    const problem = this.#check(event);
    if (problem !== undefined) return refused("RECON_TRANSITION_ILLEGAL", problem);
    try {
      await (this.#sink as JournalSink).append(event);
    } catch {
      this.#faulted = true;
      return refused("RECON_SINK_FAILED", "the sink did not accept the event; the journal is faulted (the write may have committed)");
    }
    this.#fold(event);
    return accepted(event);
  }

  /** The transition rules (see the header). `undefined` when the event may be appended now. */
  #check(event: ReconciliationJournalEvent): string | undefined {
    const running = this.#runningRunId;
    switch (event.kind) {
      case "RUN_STARTED":
        if (event.accountRef !== this.#accountRef) return "the run is for another account";
        if (this.#runs.has(event.runId)) return "the run id was used before";
        if (running !== null) return "another run is RUNNING";
        return undefined;
      case "RUN_COMPLETED": {
        if (running !== event.runId) return "only the RUNNING run can complete";
        const unresolved = [...this.#breaks.values()].filter((entry) => entry.view.status !== "RESOLVED");
        if (event.status === "PASSED" && unresolved.length > 0) return "a run cannot pass while any break is unresolved";
        if (event.status === "QUARANTINED" && !unresolved.some((entry) => entry.view.status === "QUARANTINED")) {
          return "a run is QUARANTINED only while some break is quarantined";
        }
        return undefined;
      }
      case "BREAK_OPENED":
        if (running !== event.runId) return "a break is opened by the RUNNING run";
        if (this.#breaks.has(event.breakId)) return "the break id was used before";
        if (this.#unresolvedBySubject.has(event.subjectKey)) return "an unresolved break already holds this subject";
        return undefined;
      case "BREAK_QUARANTINED": {
        const entry = this.#breaks.get(event.breakId);
        if (entry === undefined) return "no such break";
        if (running !== event.runId) return "a break is quarantined by the RUNNING run";
        if (entry.view.status !== "OPEN") return "only an OPEN break is quarantined";
        if (!quarantinesOnOpen(entry.view.rule)) return `a ${entry.view.rule} break is never quarantined`;
        if (event.resolutionLedgerTransactionId !== null && entry.view.rule !== "UNATTRIBUTED_HALT") {
          return "only an UNATTRIBUTED break carries a correction";
        }
        return undefined;
      }
      case "BREAK_RESOLVED": {
        const entry = this.#breaks.get(event.breakId);
        if (entry === undefined) return "no such break";
        const view = entry.view;
        if (view.status === "RESOLVED") return "the break is already resolved";
        switch (event.resolution) {
          case "RESOLVED_IN_RUN":
            if (view.rule !== "RESOLVE_IN_RUN") return `a ${view.rule} break is not resolved in its run`;
            if (running === null || running !== event.runId || view.runId !== event.runId) return "resolved in run only inside the run that opened it";
            return undefined;
          case "NOT_REPRODUCED":
            if (view.rule !== "HOLD_UNTIL_CONSISTENT" && view.rule !== "RESOLVE_IN_RUN") return `a ${view.rule} break is never cleared by a run`;
            if (running === null || running !== event.runId) return "only the RUNNING run clears a break";
            if (view.runId === event.runId) return "a break is cleared only by a LATER run";
            return undefined;
          case "OPERATOR_RELEASED":
            if (view.status !== "QUARANTINED" || !isOperatorReleasable(view.rule)) return "an operator releases only a quarantined break";
            return undefined;
        }
        return "unknown resolution";
      }
      case "ANSWER_RECORDED":
        if (running !== event.runId) return "only the RUNNING run records answers";
        return undefined;
      case "RESUME_REFUSED": {
        // Recorded after the PASSED completion it follows: resume happens only once that record is durable.
        const last = this.#lastRunId === null ? undefined : this.#runs.get(this.#lastRunId);
        if (last === undefined || last.view.runId !== event.runId || last.view.status !== "PASSED" || running !== null) {
          return "a resume refusal follows the PASSED completion of the latest run";
        }
        return undefined;
      }
    }
    return "unknown event";
  }

  #fold(event: ReconciliationJournalEvent): void {
    appendData(this.#events, event);
    switch (event.kind) {
      case "RUN_STARTED":
        this.#runs.set(event.runId, {
          view: Object.freeze({
            runId: event.runId,
            accountRef: event.accountRef,
            trigger: event.trigger,
            triggers: event.triggers,
            status: "RUNNING",
            ordersChecked: 0,
            fillsChecked: 0,
            walletOperationsChecked: 0,
            breaksFound: 0,
            startedAtMs: event.atMs,
            completedAtMs: null,
            detail: null,
          }),
        });
        this.#runningRunId = event.runId;
        this.#lastRunId = event.runId;
        return;
      case "RUN_COMPLETED": {
        const run = this.#runs.get(event.runId) as MutableRun;
        run.view = Object.freeze({
          ...run.view,
          status: event.status,
          ordersChecked: event.ordersChecked,
          fillsChecked: event.fillsChecked,
          walletOperationsChecked: event.walletOperationsChecked,
          breaksFound: event.breaksFound,
          completedAtMs: event.atMs,
          detail: event.detail,
        });
        this.#runningRunId = null;
        return;
      }
      case "BREAK_OPENED":
        this.#breaks.set(event.breakId, {
          view: Object.freeze({
            breakId: event.breakId,
            runId: event.runId,
            breakClass: event.breakClass,
            rule: breakRule(event.breakClass),
            subjectKey: event.subjectKey,
            scope: event.scope,
            status: "OPEN",
            marketId: event.marketId,
            orderId: event.orderId,
            fillId: event.fillId,
            walletOperationId: event.walletOperationId,
            assetId: event.assetId,
            expectedValue: event.expectedValue,
            observedValue: event.observedValue,
            resolutionLedgerTransactionId: null,
            resolution: null,
            resolvedByRunId: null,
            operatorRef: null,
            detail: event.detail,
            openedAtMs: event.atMs,
            resolvedAtMs: null,
          }),
        });
        this.#unresolvedBySubject.set(event.subjectKey, event.breakId);
        return;
      case "BREAK_QUARANTINED": {
        const entry = this.#breaks.get(event.breakId) as MutableBreak;
        entry.view = Object.freeze({ ...entry.view, status: "QUARANTINED", resolutionLedgerTransactionId: event.resolutionLedgerTransactionId });
        return;
      }
      case "BREAK_RESOLVED": {
        const entry = this.#breaks.get(event.breakId) as MutableBreak;
        entry.view = Object.freeze({
          ...entry.view,
          status: "RESOLVED",
          resolution: event.resolution,
          resolvedByRunId: event.runId,
          operatorRef: event.operatorRef,
          resolvedAtMs: event.atMs,
        });
        this.#unresolvedBySubject.delete(entry.view.subjectKey);
        return;
      }
      case "ANSWER_RECORDED":
      case "RESUME_REFUSED":
        return;
    }
  }
}
