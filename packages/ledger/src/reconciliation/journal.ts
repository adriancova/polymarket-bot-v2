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
 *   the record was being written);
 * - `EVIDENCE_RECORDED` (r6) names the RUNNING run, or no run (an
 *   observation recorded between runs: the user stream, an operator's
 *   release). It is the coordinator's EVIDENCE: every validated venue
 *   observation, from every source, whatever the run's soundness, so that a
 *   restart rebuilds it from this journal alone ({@link
 *   ReconciliationJournal.evidence}). It is a third projection beside the two
 *   `ops` tables; a composition that persists only the two tables must also
 *   persist these events (the WP-290 handoff's follow-up).
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

/** What one evidence record is about (see {@link EvidenceRecordedEvent}). */
export const EVIDENCE_KINDS = ["ORDER", "LEG", "TRADE", "UNKEYED_LEG", "ORPHAN_LEG", "UNKEYED_ORDER", "UNKEYED_TRADE", "HOLDING", "MEMBER", "SETTLED"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Whether a source SHOWED the venue order (or, for a `TRADE`, the trade row) in full (a valid row, a valid leg, a by-id
 * read that found it) or only NAMED its id.
 */
export const EVIDENCE_PROVENANCES = ["SHOWN", "NAMED"] as const;
export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCES)[number];

/**
 * One VALIDATED VENUE OBSERVATION (WP-290 r6, the coordinator's EvidenceStore), recorded the moment it was made,
 * whatever the run's soundness or the answer's completeness, so a restart rebuilds the coordinator's evidence from
 * this journal alone. Append-only, like every event: evidence is never edited or withdrawn.
 *
 * - `ORDER`: one observation of one venue order (a list row, a valid row of an unusable answer, the id alone of a
 *   malformed row, a by-id read that found it, an id the user stream named): `size` is its matched size, `status`
 *   its status as read, when the source showed them.
 * - `LEG`: one of the account's own legs of one venue trade (`venueTradeId`): `size` is the leg's shares, `status`
 *   the trade's settlement status as read.
 * - `TRADE` (WP-290 r9): one trade row's trade identity (`venueTradeId`), whatever its legs, and its settlement
 *   `status` as read: a row that validated in full (its ownership determined or not, legless or not), or the readable
 *   id of a row that did not. It names no order (`venueOrderId` is `null`) and carries nothing else: no economics.
 * - `UNKEYED_LEG` (WP-290 r10): one of the account's own legs, SHOWN in full on its venue order in a trade row whose
 *   trade id was unreadable (`venueTradeId` is `null`): `size` is its shares, with every fill fact, and `level` is how
 *   many such legs of exactly those facts its answer showed on the order (at least one). The coordinator holds the
 *   order until the reads have shown that many trades of exactly those facts on it, under readable trade ids, beyond
 *   every trade the evidence held when this record was folded (journal order); for good when its answer was not whole
 *   (its source `TRADES_LEG_UNKEYED_PARTIAL`). Never booked.
 * - `SETTLED`: a SOUND run classified the venue order consistently with all of its evidence, up to `level` (the
 *   number of informative records about it then), or an operator released its not-found quarantine. It stops the
 *   order being read by id until new evidence about it arrives.
 *
 * (WP-290 r11, the class fix at the coordinator's door layer) Every fragment a door validated reaches the evidence,
 * and every fragment present but unreadable is an explicit UNREADABLE obligation (`unreadable`: the names of the
 * fields the observation carried but could not read):
 * - `ORDER` and `LEG` may be NAMED with every fragment of a row that did not validate in full (its sizes, status,
 *   fill facts), and `ORDER` from `BY_ID_FOUND` records a by-id answer's `found: true` for the order asked about;
 * - `UNKEYED_LEG` may also come from a leg with a fact (or its order) unreadable, or from the user stream: no read can
 *   ever answer those (`venueOrderId` is `null` when the order id was unreadable too);
 * - `ORPHAN_LEG`: an own leg shown under a readable trade id (`venueTradeId`) whose order id was unreadable;
 * - `UNKEYED_ORDER`: an order row whose order id was unreadable; `UNKEYED_TRADE`: a trade row whose trade id was
 *   unreadable and that carried no own leg the door could keep, or a user-stream entry or list that could not be read
 *   (r12: a missing list included; a missing ORDER observation is an `UNKEYED_ORDER`);
 * - `HOLDING`: a position, the collateral balance or an approval an answer showed (`subject`, `value`: detail only);
 * - `MEMBER`: what one read of a wallet member, by name (`subject`), showed (`status`: its state, `value`: the amount
 *   credited, `transactionHash`).
 * A record written before r11 carries none of `unreadable`, `transactionHash`, `subject` and `value`; it is read with
 * them empty.
 */
export interface EvidenceRecordedEvent {
  readonly kind: "EVIDENCE_RECORDED";
  /** The RUNNING run that observed it, or `null` for an observation recorded between runs (the user stream, a release). */
  readonly runId: string | null;
  readonly evidenceKind: EvidenceKind;
  /** The venue order; `null` only for a `TRADE` (r9), which names no order. */
  readonly venueOrderId: string | null;
  /** `LEG` and `TRADE` only: the venue trade. */
  readonly venueTradeId: string | null;
  readonly provenance: EvidenceProvenance;
  /** Where it was observed (a code, e.g. `OPEN_ORDERS_LIST`, `BY_ID`, `STREAM_FILL`, `OMS_RETAINED`). */
  readonly source: string;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly price: string | null;
  readonly originalSize: string | null;
  readonly size: string | null;
  readonly status: string | null;
  /** `SETTLED`: the level it covers; `UNKEYED_LEG` (r10): how many such unkeyed legs its answer showed (at least one). `null` otherwise. */
  readonly level: number | null;
  /**
   * `LEG` and (r10) `UNKEYED_LEG` only (r7, WP-290 WP290-CX-R7-02): the leg's fill facts as the observation fixed them
   * (`null` when it did not), so a restart compares every later read of the fill against them: its exact fee, the
   * fee's asset, its liquidity role and its match time (ISO-8601). Every other record carries `null`.
   */
  readonly feeAmount: string | null;
  readonly feeAssetId: string | null;
  readonly role: "MAKER" | "TAKER" | null;
  readonly matchedAt: string | null;
  /** (r11) The names of the fields the observation carried but could not read, sorted (empty: none). */
  readonly unreadable: readonly string[];
  /** (r11) A trade's, a leg's or a member's transaction hash, as read. */
  readonly transactionHash: string | null;
  /** (r11) A `HOLDING`'s key (a token, an asset, a spender); a `MEMBER`'s member. */
  readonly subject: string | null;
  /** (r11) A `HOLDING`'s value; a `MEMBER`'s amount credited; a trade row's ownership flag (`DETERMINED`, `UNDETERMINED`). */
  readonly value: string | null;
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
  | ResumeRefusedEvent
  | EvidenceRecordedEvent;

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

/** One evidence record as appended (its position in the journal included). */
export type EvidenceRecordView = EvidenceRecordedEvent & { readonly sequence: number };

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

function isPositiveDecimal(value: unknown): value is string {
  return isCanonicalDecimalString(value, { range: "POSITIVE" });
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
  EVIDENCE_RECORDED: [
    "kind",
    "runId",
    "evidenceKind",
    "venueOrderId",
    "venueTradeId",
    "provenance",
    "source",
    "tokenId",
    "side",
    "price",
    "originalSize",
    "size",
    "status",
    "level",
    "feeAmount",
    "feeAssetId",
    "role",
    "matchedAt",
    "atMs",
  ],
});

/** A token id (`internal.token_id`): a canonical unsigned decimal integer string. */
const TOKEN_ID = /^(?:0|[1-9][0-9]{0,199})$/u;
/** An ISO-8601 instant with an offset (a trade leg's match time, as the coordinator's door reads it). */
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;

/** (r11) The fields an evidence record written from r11 on carries beyond the r10 ones. */
const EVIDENCE_R11_KEYS = ["unreadable", "transactionHash", "subject", "value"] as const;

/**
 * (r11) Every name an evidence record's `unreadable` list may carry: the coordinator's door vocabularies (WP-290's
 * `door.ts`: an order row's, a trade leg's, a trade row's, a holding's, a wallet member's and a user-stream item's
 * fields, and an answer's own fields). Mirrored there; a name outside it is refused.
 */
const UNREADABLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "approved",
  "approvals",
  "assetId",
  "balance",
  "complete",
  "credited",
  "entry",
  "feeAmount",
  "feeAssetId",
  "fills",
  "found",
  "kind",
  "liquidityRole",
  "matchedAt",
  "observation",
  "oms",
  "order",
  "orders",
  "originalSize",
  "ownLegs",
  "ownershipUndetermined",
  "positions",
  "price",
  "role",
  "route",
  "settlements",
  "shares",
  "side",
  "size",
  "sizeMatched",
  "source",
  "spender",
  "state",
  "status",
  "tokenId",
  "trades",
  "transactionHash",
  "venueOrderId",
  "venueTradeId",
]);

function isUnreadableNames(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 64) return false;
  for (let index = 0; index < value.length; index += 1) {
    const name: unknown = value[index];
    if (typeof name !== "string" || !UNREADABLE_FIELD_NAMES.has(name)) return false;
    if (index > 0 && !((value[index - 1] as string) < name)) return false;
  }
  return true;
}

/** (r11) The kind each source introduced in r11 belongs to, and only to (the coordinator's door checks the same). */
const SOURCE_KIND: Readonly<Record<string, EvidenceKind>> = Object.freeze({
  TRADES_LEG_UNKEYED_FRAGMENTS: "UNKEYED_LEG",
  TRADES_LEG_FRAGMENTS: "LEG",
  TRADES_LEG_ORPHAN: "ORPHAN_LEG",
  TRADES_ROW_UNKEYED: "UNKEYED_TRADE",
  OPEN_ORDERS_UNKEYED: "UNKEYED_ORDER",
  BY_ID_UNKEYED: "UNKEYED_ORDER",
  BY_ID_FOUND: "ORDER",
  STREAM_ORDER_UNKEYED: "UNKEYED_ORDER",
  STREAM_FILL_ORPHAN: "ORPHAN_LEG",
  STREAM_FILL_UNKEYED: "UNKEYED_LEG",
  STREAM_SETTLEMENT_ORPHAN: "ORPHAN_LEG",
  STREAM_SETTLEMENT_UNKEYED: "UNKEYED_LEG",
  STREAM_UNREADABLE: "UNKEYED_TRADE",
  POSITIONS: "HOLDING",
  COLLATERAL: "HOLDING",
  APPROVALS: "HOLDING",
  WALLET_MEMBER: "MEMBER",
});
const NEW_KINDS: readonly EvidenceKind[] = ["ORPHAN_LEG", "UNKEYED_ORDER", "UNKEYED_TRADE", "HOLDING", "MEMBER"];
/** (r9) The sources of a TRADE record. */
const TRADE_SOURCES: readonly string[] = ["TRADES_ROW", "TRADES_ROW_PARTIAL", "TRADES_ROW_ID"];

/**
 * Whether an evidence record's fields fit its kind (the coordinator's door, `evidence.ts`'s `readEvidenceRecord`,
 * checks the same): which ids it names, which facts it may carry, which sources it comes from.
 */
function evidenceShape(r: {
  readonly kind: EvidenceKind;
  readonly venueOrderId: string | null;
  readonly venueTradeId: string | null;
  readonly provenance: EvidenceProvenance;
  readonly source: string;
  readonly tokenId: string | null;
  readonly side: string | null;
  readonly price: string | null;
  readonly originalSize: string | null;
  readonly size: string | null;
  readonly status: string | null;
  readonly level: number | null;
  readonly feeAmount: string | null;
  readonly feeAssetId: string | null;
  readonly role: string | null;
  readonly matchedAt: string | null;
  readonly unreadable: readonly string[];
  readonly transactionHash: string | null;
  readonly subject: string | null;
  readonly value: string | null;
}): boolean {
  const { kind, source } = r;
  const owner = SOURCE_KIND[source];
  if (owner !== undefined && owner !== kind) return false;
  if (NEW_KINDS.includes(kind) && owner !== kind) return false;
  const namesOrder = kind === "ORDER" || kind === "LEG" || kind === "SETTLED";
  if (namesOrder && r.venueOrderId === null) return false;
  if (!namesOrder && kind !== "UNKEYED_LEG" && r.venueOrderId !== null) return false;
  // A leg, a trade (r9) and an orphan leg (r11) name their trade; nothing else does.
  if ((kind === "LEG" || kind === "TRADE" || kind === "ORPHAN_LEG") !== (r.venueTradeId !== null)) return false;
  // Only a settlement and (r10) an unkeyed leg carry a level; an unkeyed leg owes at least one trade.
  if ((kind === "SETTLED" || kind === "UNKEYED_LEG") !== (r.level !== null)) return false;
  if (kind === "UNKEYED_LEG" && (r.level as number) < 1) return false;
  // (r9) A trade comes from a trade row (and only a trade does), SHOWN when the row validated in full.
  if ((kind === "TRADE") !== TRADE_SOURCES.includes(source)) return false;
  if (kind === "TRADE" && r.provenance !== (source === "TRADES_ROW_ID" ? "NAMED" : "SHOWN")) return false;
  // Nothing of an order or a fill on a trade, an unkeyed trade, a holding, a member or a settlement.
  const economics = kind !== "TRADE" && kind !== "UNKEYED_TRADE" && kind !== "HOLDING" && kind !== "MEMBER" && kind !== "SETTLED";
  if (!economics && (r.tokenId !== null || r.side !== null || r.price !== null || r.originalSize !== null || r.size !== null)) return false;
  if (kind !== "ORDER" && kind !== "UNKEYED_ORDER" && r.originalSize !== null) return false;
  // A leg's fill facts (r7): only a leg, an unkeyed leg (r10) and an orphan leg (r11) carry them.
  const fill = kind === "LEG" || kind === "UNKEYED_LEG" || kind === "ORPHAN_LEG";
  if (!fill && (r.feeAmount !== null || r.feeAssetId !== null || r.role !== null || r.matchedAt !== null)) return false;
  if (kind === "HOLDING" && r.status !== null) return false;
  if (r.transactionHash !== null && !["LEG", "TRADE", "UNKEYED_TRADE", "UNKEYED_LEG", "ORPHAN_LEG", "MEMBER"].includes(kind)) return false;
  if (kind === "MEMBER" ? r.subject === null : kind !== "HOLDING" && r.subject !== null) return false;
  if (r.value !== null) {
    if (kind === "TRADE" || kind === "UNKEYED_TRADE") {
      if (r.value !== "DETERMINED" && r.value !== "UNDETERMINED") return false;
    } else if (kind === "HOLDING") {
      if (source === "APPROVALS" ? r.value !== "true" && r.value !== "false" : !isDecimal(r.value) || r.value.startsWith("-")) return false;
    } else if (kind === "MEMBER") {
      if (!isDecimal(r.value) || r.value.startsWith("-")) return false;
    } else {
      return false;
    }
  }
  // (r10) Only an unkeyed leg comes from an answer that was not whole.
  if (source === "TRADES_LEG_UNKEYED_PARTIAL" && kind !== "UNKEYED_LEG") return false;
  if (kind === "UNKEYED_LEG") {
    if (source === "TRADES_LEG_UNKEYED" || source === "TRADES_LEG_UNKEYED_PARTIAL") {
      // (r10) An unkeyed leg was SHOWN in full: its order, its token and side, its price and shares, its role and match
      // time (its fee may be unfixed), nothing of it unreadable (r11: but its row's status or hash), nothing of an
      // order's size.
      if (
        r.provenance !== "SHOWN" ||
        r.venueOrderId === null ||
        r.unreadable.some((name) => name !== "status" && name !== "transactionHash") ||
        r.tokenId === null ||
        r.side === null ||
        r.price === null ||
        r.size === null ||
        !isPositiveDecimal(r.size) ||
        r.role === null ||
        r.matchedAt === null
      ) {
        return false;
      }
    } else if (owner !== "UNKEYED_LEG") {
      return false;
    } else if (r.provenance !== (source.startsWith("STREAM_") ? "NAMED" : "SHOWN")) {
      return false;
    }
  }
  if ((kind === "ORPHAN_LEG" || kind === "UNKEYED_ORDER" || kind === "UNKEYED_TRADE") && r.provenance !== "NAMED") return false;
  if ((kind === "UNKEYED_ORDER" || kind === "UNKEYED_TRADE") && r.venueTradeId !== null) return false;
  if ((kind === "HOLDING" || kind === "MEMBER") && r.provenance !== (r.unreadable.length === 0 ? "SHOWN" : "NAMED")) return false;
  if (kind === "ORDER" && source === "BY_ID_FOUND" && (r.provenance !== "NAMED" || r.tokenId !== null || r.size !== null || r.status !== null || r.unreadable.length > 0)) return false;
  return true;
}

/** The shape of an evidence record's fields (see {@link EvidenceRecordedEvent}); `undefined` when any is out of its domain. */
function readEvidence(record: unknown, at: number): EvidenceRecordedEvent | undefined {
  const runId = field(record, "runId");
  const evidenceKind = field(record, "evidenceKind");
  const venueOrderId = field(record, "venueOrderId");
  const venueTradeId = field(record, "venueTradeId");
  const provenance = field(record, "provenance");
  const source = field(record, "source");
  const tokenId = field(record, "tokenId");
  const side = field(record, "side");
  const price = field(record, "price");
  const originalSize = field(record, "originalSize");
  const size = field(record, "size");
  const status = field(record, "status");
  const level = field(record, "level");
  const feeAmount = field(record, "feeAmount");
  const feeAssetId = field(record, "feeAssetId");
  const role = field(record, "role");
  const matchedAt = field(record, "matchedAt");
  const unreadableField = field(record, "unreadable");
  const transactionHashField = field(record, "transactionHash");
  const subjectField = field(record, "subject");
  const valueField = field(record, "value");
  const unreadable = unreadableField === undefined ? [] : unreadableField;
  const transactionHash = transactionHashField === undefined ? null : transactionHashField;
  const subject = subjectField === undefined ? null : subjectField;
  const value = valueField === undefined ? null : valueField;
  if (!nullable(runId, isUuidV7) || typeof evidenceKind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(evidenceKind)) return undefined;
  if (!nullable(venueOrderId, isIdentifier) || !nullable(venueTradeId, isIdentifier)) return undefined;
  if (typeof provenance !== "string" || !(EVIDENCE_PROVENANCES as readonly string[]).includes(provenance) || typeof source !== "string" || !CODE.test(source)) return undefined;
  if (!(tokenId === null || (typeof tokenId === "string" && TOKEN_ID.test(tokenId))) || !(side === null || side === "BUY" || side === "SELL")) return undefined;
  if (!nullable(price, isDecimal) || !nullable(originalSize, isDecimal) || !nullable(size, isDecimal) || !nullable(status, isIdentifier) || !nullable(level, isCount)) return undefined;
  if (!nullable(feeAmount, isDecimal) || !nullable(feeAssetId, isIdentifier) || !(role === null || role === "MAKER" || role === "TAKER")) return undefined;
  if (!(matchedAt === null || (typeof matchedAt === "string" && INSTANT.test(matchedAt)))) return undefined;
  if (!isUnreadableNames(unreadable) || !nullable(transactionHash, isIdentifier) || !nullable(subject, isIdentifier) || !nullable(value, isIdentifier)) return undefined;
  if (
    !evidenceShape({
      kind: evidenceKind as EvidenceKind,
      venueOrderId,
      venueTradeId,
      provenance: provenance as EvidenceProvenance,
      source,
      tokenId: tokenId as string | null,
      side: side as string | null,
      price,
      originalSize,
      size,
      status,
      level,
      feeAmount,
      feeAssetId,
      role: role as string | null,
      matchedAt: matchedAt as string | null,
      unreadable,
      transactionHash,
      subject,
      value,
    })
  ) {
    return undefined;
  }
  return {
    kind: "EVIDENCE_RECORDED",
    runId,
    evidenceKind: evidenceKind as EvidenceKind,
    venueOrderId,
    venueTradeId,
    provenance: provenance as EvidenceProvenance,
    source,
    tokenId: tokenId as string | null,
    side: side as "BUY" | "SELL" | null,
    price,
    originalSize,
    size,
    status,
    level,
    feeAmount,
    feeAssetId,
    role: role as "MAKER" | "TAKER" | null,
    matchedAt: matchedAt as string | null,
    unreadable: Object.freeze([...unreadable]),
    transactionHash,
    subject,
    value,
    atMs: at,
  };
}

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
  const tail = withSequence ? ["sequence"] : [];
  // (r11) An evidence record carries the four r11 fields, or (written before r11) none of them.
  const exact = exactKeys(record, [...keys, ...tail]) || (kind === "EVIDENCE_RECORDED" && exactKeys(record, [...keys, ...EVIDENCE_R11_KEYS, ...tail]));
  if (!exact) return undefined;
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
    case "EVIDENCE_RECORDED": {
      event = readEvidence(record, at);
      if (event === undefined) return undefined;
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
  readonly #evidence: EvidenceRecordView[] = [];
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

  /** Every evidence record, in the order it was appended (the coordinator's EvidenceStore is rebuilt from it). */
  evidence(): readonly EvidenceRecordView[] {
    return Object.freeze([...this.#evidence]);
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
      case "EVIDENCE_RECORDED":
        // An observation names the RUNNING run, or none (one recorded between runs). A run's classification
        // (`SETTLED`) is that run's: a settlement naming no run is an operator's release, recorded outside runs.
        if (event.runId !== null && running !== event.runId) return "evidence names the RUNNING run, or none";
        return undefined;
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
      case "EVIDENCE_RECORDED":
        appendData(this.#evidence, event);
        return;
      case "ANSWER_RECORDED":
      case "RESUME_REFUSED":
        return;
    }
  }
}
