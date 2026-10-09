/**
 * The RECONCILIATION COORDINATOR (WP-290 deliverables 1 and 3; handoff §9.17).
 *
 * ## Triggers (§9.17)
 *
 * | Trigger | Raised by |
 * | --- | --- |
 * | `STARTUP` | {@link ReconciliationCoordinator.bindOms} (a freshly opened OMS) |
 * | `PERIODIC_TIMER` | the composition's timer, through {@link ReconciliationCoordinator.trigger} |
 * | `USER_STREAM_RECONNECT` | a WP-280 reconciliation request whose cause is a loss, a (re)subscription, a stop or a fault |
 * | `MARKET_STREAM_GAP` | the market-data gateway, through `trigger` |
 * | `SUBMISSION_UNKNOWN` | the OMS's request (purpose `SUBMISSION_UNKNOWN`), through {@link ReconciliationCoordinator.omsRequester} |
 * | `WALLET_OPERATION_UNKNOWN` | the inventory's request, through {@link ReconciliationCoordinator.walletRequester} |
 * | `MANUAL_REQUEST` | an operator, through `trigger`, and every quarantine release |
 * | `POSITION_BALANCE_DISCREPANCY` | an OMS `ORDER_STATE`/`FINAL_SIZE` request; a stream event the OMS could not apply; the inventory's quarantine request |
 *
 * Every trigger PAUSES NEW SUBMISSIONS AT ONCE (§9.17 step 1; `OrderManager.pause`:
 * cancels and reconciliation continue) and queues a run. The composition
 * drives runs with {@link ReconciliationCoordinator.reconcile}; this layer-1
 * class owns no timer.
 *
 * ## One run (§9.17 steps 1–8)
 *
 * 1. Pause. Close a run a crash left RUNNING. Record `RUN_STARTED`. Call the
 *    OMS's and the inventory's `retryReconciliationRequests` (ADR-032 D5: the
 *    regular cadence), so every owed request is delivered before the reads.
 * 2–4. Read, in this order and all AFTER every request the run will answer
 *    was received (`readsStartSeq`): open orders, trades, each order that
 *    must be read by id (E-14: an order absent from the open-orders list is
 *    not proof of cancellation; every venue order with EVIDENCE no sound run
 *    has settled, every tracked order still open or filled, every one an
 *    unresolved break names, every venue order an unresolved break names in
 *    its subject, every id the OMS retains as stream evidence, every tracked
 *    order a request names), positions (`/v2`), the collateral balance,
 *    approvals, the ledger projection, what the ledger still books of each
 *    FAILED fill, and each wallet-operation member a request names. A read
 *    made before a request was received NEVER answers it (ADR-032 D4;
 *    `WP300C-OBLIGATIONS`): a request that arrives during the reads waits for
 *    the next run, which starts at once.
 * 5. EVIDENCE FIRST (r6, class A; `evidence.ts`). Every validated
 *    observation of the reads, from every source (a complete list's row, a
 *    valid row or leg of an unusable answer, the id alone of a malformed one,
 *    r9: every trade row's trade identity and status, whatever its legs, a
 *    legless row and the readable trade id of a malformed row included,
 *    a by-id read that found the order, r10: the order row of an unusable
 *    by-id answer, under the row's own id, and every own leg of a row whose
 *    trade id was unreadable, as an obligation owing new trades by id, an id
 *    the OMS retains as stream evidence) and what the user stream reported
 *    that the OMS did not apply,
 *    is folded into the EVIDENCE STORE and journaled (`EVIDENCE_RECORDED`)
 *    BEFORE anything is classified, whatever the run's soundness. The store
 *    is rebuilt from the journal at every run, so a restart forgets nothing.
 *    (r11, the class fix at the door layer) Every door reads every field of
 *    every row on its own first (`door.ts`: salvage is the default path, and
 *    every outcome carries it), and every door's outcome, whatever its
 *    usability, goes into the store through ONE recording function
 *    (`#recordSalvage`): every fragment a door validated is kept, and every
 *    fragment present but unreadable is an explicit obligation (of its object
 *    when its id is readable; an `UNKEYED_*` obligation of the account, which
 *    holds every run, when its identity is not). Holdings and wallet members
 *    are recorded too; the user stream's items through its own door. (r11,
 *    WP290-V11-UNKEYED-STATUS-DROPPED) An unkeyed row's settlement status is
 *    kept per status and decided on: a witness must agree with it.
 *    Then the store's ONE query (`EvidenceStore.judge`) gives a verdict on
 *    every venue order and trade the run read, or has unsettled evidence of
 *    (and, r7 and r8, every trade the evidence holds, whether a read SHOWED
 *    it or only the user stream NAMED it), against this run's other reads
 *    and ALL the evidence: CONSISTENT (the only view anything is answered,
 *    compared, classified or settled from), a CONFLICT (an observation below
 *    the high-water matched size, live after terminal, a settlement
 *    backwards, a shown order not found by id; r7: an order's fixed fact or
 *    a fill's economics shown with two values, a DURABLE contradiction; r8: a
 *    trade shown both CONFIRMED and FAILED, DURABLE too; a trade a complete
 *    trades read omits while a hold names it or any of its legs is not
 *    accounted for under its own identity (`#accounting`: a leg only the
 *    stream named is never answered by a tracked order or by an order's
 *    matched size), and a leg the stream named that a read of its trade does
 *    not show; r9: a trade a row carried without identifying its own legs,
 *    that no valid row has shown with them, which a complete trades read
 *    omits; r10: an order carrying an own leg shown under no readable trade
 *    id, until the reads have shown by id the new trades it owes: the run is
 *    unsound and holds),
 *    a GHOST (an unclaimed id only NAMED that its by-id
 *    read does not find: no signed-identity answer while it stands, and a
 *    releasable `ORDER_NOT_FOUND_BY_ID`), ACKNOWLEDGED (the same, released by
 *    an operator, nothing new since), MISSING (a claimed order not found: the
 *    OMS comparison's `ORDER_STATE_MISMATCH`), or UNREAD. Fills are then
 *    compared BY IDENTITY and with exact economics, both ways (`#probeFills`,
 *    `#compareFills`): a trade the OMS holds under the same (trade, order)
 *    identity must carry the same facts; the OMS's recorded fill must be
 *    exactly what it holds under the venue's identities; only then is a trade
 *    it does not hold a missed fill, delivered. A read behind the OMS's durable
 *    settlement is a READ_REGRESSION (no restart forgets it), and nothing more
 *    is written to the OMS from that read set. A tracked order's token (its
 *    group's, `tokenOfGroup`), side, price and size are its fixed facts.
 * 6. Record every discrepancy as an append-only break (`BREAK_OPENED`), and
 *    every answer (`ANSWER_RECORDED`).
 * 7. Resolve or quarantine, by the break's rule (the ledger's taxonomy):
 *    deliver missing fills, route state mismatches to the OMS, book confirmed
 *    unexplained holding deltas to UNATTRIBUTED, halt markets. Every halt
 *    obligation is derived again from durable or authoritative state in EVERY
 *    run, whatever its soundness (r6, class C; `#haltObligations`), never only
 *    from process memory, each with its own durable identity (an occurrence,
 *    never a hash of its detail): each ledger arrival (per transaction,
 *    movement kind, asset, market and place), each FAILED settlement the
 *    venue shows (per trade and order), each OMS halting alert (per OMS
 *    incarnation and ordinal), each not-found occurrence of an id (per release
 *    count). A FAILED fill explains only what the ledger still books of it,
 *    and while any of it remains, its reversal is owed
 *    (`SETTLEMENT_REVERSAL_OWED`, a hold only the ledger clears: a release is
 *    not proof of a booking).
 * 8. RESUME ONLY IF EVERY REQUIRED INVARIANT PASSES (see RESUME below).
 *
 * ## The obligations other packages put on this one
 *
 * - **Quiescence (WP-270).** An ABSENT answer always carries
 *   `transmissionQuiescent: true`, and is given only when the reads began at
 *   least `policy.quiescenceHorizonMs` after the coordinator RECEIVED the
 *   request, by its own clock, with no clock fault since. Every transmission
 *   of the attempt began before the OMS issued the request (a retransmission
 *   consumes the request first), so the horizon bounds how long one may
 *   still travel. Before that, the attempt simply stays unresolved. ABSENT
 *   also needs this run to have judged the holdings with no break in the
 *   attempt's token or the collateral, and no unresolved break naming them:
 *   a marketable order matched at once leaves the open-orders list, and a
 *   lagging trades read would hide it, but its fill still moves the
 *   holdings. A clock reading that went backwards is never used, and every
 *   pending request's window restarts after a clock fault. A fault detected
 *   at ANY point of a run (a clock fault, a faulted journal) LATCHES it
 *   (r5, r6 class D; `#mayCommit`, the one helper every commit point calls
 *   after every await before it): from then on the run gives no further
 *   answer (an ABSENT queued before the fault included), delivers no further
 *   fill (inside a multi-fill act too), writes nothing more to the OMS, books
 *   nothing, acts on no break, resolves none, settles no evidence, records
 *   READ_STALE and does not resume.
 * - **Holdings an attempt could explain.** A delta that an unresolved attempt
 *   could explain is held, never booked to UNATTRIBUTED, while that attempt
 *   is unresolved.
 * - **requestId (WP-270, WP-300c, ADR-032 D4).** Every answer echoes the
 *   request's id verbatim; ids are opaque and never derived.
 * - **By signed identity (WP-270 follow_up 3).** An attempt without a venue
 *   order id is resolved only by `identity.ts`'s strict rule: ambiguity in
 *   either direction is refused, never guessed. The expected order hash is
 *   `null` (STOPPED) and is not used. While a GHOST stands (an unclaimed id
 *   only NAMED, by any source: the id alone of a malformed row or leg, an id
 *   the OMS retains as stream evidence, one the stream reported; which the
 *   venue's by-id read does not find: `ORDER_NOT_FOUND_BY_ID`), no attempt is
 *   answered by signed identity at all (r5; r6 for every source): its token
 *   is unknown, so it could be any attempt's.
 * - **Wallet members by name (WP-300 follow_up 3).** Each unresolved member
 *   of a wallet request is read and answered BY NAME, and only with a
 *   terminal state (CONFIRMED or FAILED). A pending, dropped, unknown or
 *   malformed report is never answered: the member is read again next run.
 *   An operation that never named a transaction is quarantined, never
 *   answered.
 * - **The user stream (WP-280).** Its reconciliation requests trigger runs and
 *   are acknowledged, by id, only after a run whose order and trade reads
 *   began after their receipt and were complete, and (r14) that judged every
 *   identity the request named; each acknowledgement is journaled. Its
 *   normalized events are routed to the OMS (outside runs; buffered during
 *   one, and (r14) an output buffered during a run is work that arrived: the
 *   run does not resume, and the next run routes it before it reads). Every
 *   item the OMS did not apply, whatever its answer (a refusal of any code, a
 *   throw), and every item routed while no OMS is bound, is kept as journaled
 *   evidence at once and triggers a run (r7, WP290-V7-STREAM-REFUSAL-DROPPED).
 *   (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) What an output's EVENT names,
 *   and what every request names, is journaled as stream-NAMED evidence at
 *   once (`streamEventRecords`, `streamRequestRecords`): an order read by id;
 *   a trade whose identity is open until a valid trades row shows its own
 *   legs; `unordered` when its status cannot be ordered. An empty projection
 *   or a shortfall requires the event; an identity that cannot be read is an
 *   obligation of the account. (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED) A
 *   request carries no status: the trade it names is `unordered` unless this
 *   coordinator received the output of the very event the request was raised
 *   for IMMEDIATELY before it (WP-280's emission order) with an ordered
 *   status; then the request's record carries that status
 *   (`requestEventStatus`). A request pulled from WP-280's backlog never does.
 * - **Malformed requests.** A request that cannot be read, on any channel, is
 *   refused to its requester (the OMS and the inventory keep it as owed) and
 *   recorded as a REQUEST_MALFORMED break by the next run: a hold, which a
 *   later complete run that no longer receives it clears.
 * - **Data API v2 only (V3-E15).** A positions or approvals read from any
 *   other route is refused (`READ_WRONG_ROUTE`).
 *
 * ## RESUME (§9.17 step 8; work-plan acceptance 1)
 *
 * The coordinator calls `OrderManager.resume()` only when ALL hold:
 * - the run is conclusive: it read everything, completely, without conflict,
 *   regression or an unrecognised status against its own reads or the
 *   evidence, within `policy.maxReadSpanMs`, with a sound clock and a sound
 *   journal from its start to its resume (a fault detected at any point
 *   latches the run; one detected while the PASSED record is written refuses
 *   the resume, `RECON_CLOCK_FAULT` or `RECON_JOURNAL_FAULTED`);
 * - no break is unresolved in the WHOLE journal (any rule: a quarantine from
 *   before a restart included). The journal enforces this too: it refuses a
 *   `PASSED` run while any break is unresolved;
 * - the OMS is bound and not faulted; no attempt or order awaits a read
 *   (except one held for the retransmission decision, as the OMS allows);
 *   no evidence is retained;
 * - no OMS, wallet or stream request is unanswered, and none arrived during
 *   the run; (r14) no user-stream activity output arrived during it (it waits,
 *   unrouted, in the buffer); the inventory holds no undelivered request;
 * - `RUN_COMPLETED` with `PASSED` is durable, AND nothing held the account
 *   while it was being written (a trigger, any request receipt, a pause: the
 *   hold epoch). The decision is taken, the record awaited, and the epoch
 *   compared again just before `resume()`, synchronously. If it moved, the
 *   run records `RESUME_REFUSED` and the next run, at once, answers the work.
 * Anything else leaves submissions paused. Ambiguity breaks are
 * `HOLD_UNTIL_CONSISTENT`: no operator can release them. A break leaves the
 * open state by a run ONLY through `#resolve` (r6, class B), and only when
 * the comparison that actually ran in THIS run positively judged its EXACT
 * subject consistent (`RunState.positive`: a read that answered, a venue
 * order or trade the evidence store judged CONSISTENT, a tracked order
 * compared in full with nothing wrong found, an asset whose holding matched,
 * a wallet member answered and accepted, an attempt judged without ambiguity
 * or answered and accepted, ...), in a CONCLUSIVE run (every read complete,
 * consistent and fresh, the evidence journal readable, every append
 * recorded), with the latch passing: anything not positively judged stays
 * open. A release acknowledges immutable history only; a live contradiction
 * (a tracked order's facts) opens again while it is found. Each OMS halting
 * alert is its own subject (the OMS instance's incarnation id and the
 * alert's ordinal), so a release acknowledges that one alert, never a later
 * one like it.
 *
 * One run at a time: `reconcile()` claims the run synchronously, before its
 * first await.
 *
 * Layer 1: no I/O, no global clock, no randomness, no timer. Every effect
 * leaves through a port in `ports.ts`; the clock is one of them.
 */

import { addDecimal, compareDecimal, type DecimalString } from "@polymarket-bot/decimal";

import { compositeKey, isIdentifier, isPositiveAmount, isTokenId, isUnitPrice, isUuidV7, readArray, readField, readFields } from "../guards.js";
import type { AttemptView, OrderView } from "../order-manager.js";
import { isVenueId } from "../outcomes.js";
import type { ReconciliationRequester } from "../ports.js";
import { TERMINAL_ORDER_STATES, type OrderState } from "../states.js";

import {
  EMPTY_SALVAGE,
  callRead,
  classifyStreamOutput,
  readApprovals,
  readCollateral,
  readOkFlag,
  readOpenOrders,
  readOrderById,
  readPositions,
  readProjectedHoldings,
  readRefusalCode,
  readRemainingBookings,
  readStreamOutput,
  readStreamRequest,
  readTrades,
  readWalletMember,
  tradeStatusOf,
  type LegFragments,
  type ProjectedHoldingsRead,
  type ReadOutcome,
  type StreamEventFragments,
  type StreamItemFragments,
  type StreamRequestFragments,
  type TradeFragments,
  type WalletMemberRead,
} from "./door.js";
import {
  EvidenceStore,
  holdingRecord,
  legRecord,
  memberRecord,
  namedOrder,
  orderFragmentsRecord,
  orphanLegRecord,
  readEvidenceRecords,
  sameFillOfLegs,
  settledRecord,
  shownOrder,
  tradeRecord,
  unkeyedFragmentsLegRecord,
  unkeyedLegRecord,
  unkeyedOrderRecord,
  unkeyedTradeRecord,
  type EvidenceRecord,
  type LegEvidence,
  type LegFacts,
  type EvidenceProblem,
  type OrderVerdict,
  type PartialLeg,
  type TradeVerdict,
} from "./evidence.js";
import { compareHolding, pendingDeltas } from "./holdings.js";
import { couldBelong, resolveBySignedIdentity, type AttemptFacts, type PotentialOwner } from "./identity.js";
import type {
  BookedAmount,
  BreakClass,
  BreakRule,
  BreakScope,
  FillIdentity,
  JournalBreakView,
  JournalInput,
  OmsReconciliationRequest,
  ReconciledOms,
  ReconciledUserStream,
  ReconciledWalletOperations,
  ReconciliationCoordinatorDependencies,
  ReconciliationTrigger,
  StreamReconciliationRequest,
  VenueOrderView,
  VenueTradeLeg,
  VenueTradeStatus,
  VenueTradeView,
  WalletReconciliationRequest,
} from "./ports.js";
import { RECONCILED_WALLET_OPERATION_STATES } from "./ports.js";
import { decodeCompositeKey, venueSubjectOf } from "./subjects.js";
import { isoFromEpochMs } from "./time.js";

/** The most runs one {@link ReconciliationCoordinator.reconcile} call makes when work keeps arriving during a run. */
export const MAX_RUNS_PER_RECONCILE = 4;
/** A guard on the policy's durations (one day); no venue fact bounds them. */
export const MAX_POLICY_MS = 86_400_000;
const MAX_DETAIL = 2000;
const MAX_REQUEST_ID = 2000;

const STREAM_DISCREPANCY_CAUSES: readonly string[] = ["UNRECOGNIZED_MESSAGE", "EVENT_NOT_FULLY_APPLICABLE", "EVENT_NOT_DELIVERED"];
/** Order-level disagreements after which the run's ledger projection is known to be behind, or wrong (see `#runOnce`). */
const DEFERS_HOLDINGS: readonly BreakClass[] = [
  "TRADE_MISSING_IN_OMS",
  "FILL_ECONOMICS_UNFIXED",
  "FILL_MISMATCH",
  "FILL_REFUSED",
  "ORDER_STATE_MISMATCH",
  "ORDER_FILLS_AHEAD_OF_VENUE",
  "ORDER_TRADES_INCOMPLETE",
];
/** Classes only the holding comparison finds (and judges, asset by asset: `#compareHoldings`); also, whether a delta is held. */
const JUDGED_WITH_HOLDINGS: readonly BreakClass[] = [
  "HOLDING_IN_TRANSIT_AMBIGUOUS",
  "HOLDING_DELTA_UNCONFIRMED",
  "CORRECTION_FAILED",
  "APPROVAL_MISSING",
  "WALLET_OPERATION_IN_FLIGHT",
  "SETTLEMENT_REVERSAL_OWED",
];
/**
 * Classes about one tracked order's state or fills (the break names the order): positively judged only for an order
 * the run compared in full and found nothing wrong with (`RunState.ordersComparedInFull`, `#finalJudgements`). A run
 * that skipped the order (its group's token unknown, its venue facts different), or could not verify its fills, did
 * not look, and judges none of them.
 */
const JUDGED_WITH_ORDER: readonly BreakClass[] = [
  "ORDER_STATE_MISMATCH",
  "ORDER_FACTS_MISMATCH",
  "ORDER_TRADES_INCOMPLETE",
  "ORDER_FILLS_AHEAD_OF_VENUE",
  "TRADE_MISSING_IN_OMS",
  "FILL_ECONOMICS_UNFIXED",
  "FILL_REFUSED",
  "FILL_MISMATCH",
];
/** Malformed request receipts itemised between runs; more are counted, and recorded as one break. */
const MAX_MALFORMED_PENDING = 256;
/** Contradictions already shown by the OMS (each probe of one raises an OMS alert); beyond this, they are probed again. */
const MAX_KNOWN_CONFLICTS = 10_000;
/** The read-problem classes a subject keyed by one read's name (or one by-id read) may carry (`#readProblem`). */
const READ_PROBLEM_CLASSES: readonly BreakClass[] = ["READ_MISSING", "READ_MALFORMED", "READ_INCOMPLETE", "READ_WRONG_ROUTE"];
/** The classes a verdict about one venue order or trade judges (`evidence.ts`). */
const VENUE_OBJECT_CLASSES: readonly BreakClass[] = ["READ_CONFLICT", "READ_REGRESSION", "STATUS_UNRECOGNISED", "READ_INCOMPLETE"];
/** Wallet-member classes: judged by an accepted answer for the member, or once the operation's request is gone. */
const WALLET_MEMBER_CLASSES: readonly BreakClass[] = ["WALLET_MEMBER_PENDING", "WALLET_MEMBER_UNREADABLE", "WALLET_ANSWER_REFUSED"];
/** The stand-in operation id of an inventory whose events could not be read (it holds; nothing about it is judged). */
const UNREADABLE_WALLET_EVENTS = "(the inventory's events are unreadable)";
const OPEN_FOR_STATE_CHECK: ReadonlySet<OrderState> = new Set<OrderState>(["ACKNOWLEDGED", "LIVE", "DELAYED", "PARTIALLY_FILLED"]);

/** The bound OMS instance's alert identity: its incarnation id, and the alerts seen so far by ordinal (`#inspectAlerts`). */
interface OmsIncarnation {
  readonly id: string;
  readonly seen: string[];
}

interface Received<T> {
  readonly request: T;
  /** The coordinator's sequence number at receipt: a read with a higher one was made after it. */
  readonly seq: number;
  /** The clock at receipt; `null` until a sound reading was taken (it is then stamped, conservatively, later). */
  readonly atMs: number | null;
}

/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) What a WP-280 request named of the account's activity (its event-level
 * identities), each a subject its acknowledgement waits on: it is acknowledged only by a run that judged every one of
 * them (`#streamRequestDischarged`), never by a run that merely read everything.
 */
interface StreamRequestSubjects {
  readonly trades: readonly string[];
  readonly orders: readonly string[];
  /** An identity it named could not be read: its obligation holds the account, and the request is never acknowledged. */
  readonly unreadable: boolean;
}

interface ReceivedStreamRequest extends Received<StreamReconciliationRequest> {
  readonly named: StreamRequestSubjects;
}

/** A reconciliation request that could not be read, awaiting the run that records it. */
interface MalformedReceipt {
  readonly channel: "oms" | "inventory" | "user-stream";
  readonly seq: number;
  readonly why: string;
}

interface Detection {
  readonly breakClass: BreakClass;
  readonly subjectKey: string;
  readonly scope: BreakScope;
  readonly marketId: string | null;
  readonly orderId: string | null;
  readonly walletOperationId: string | null;
  readonly assetId: string | null;
  readonly expectedValue: string | null;
  readonly observedValue: string | null;
  readonly detail: string;
  /** An UNATTRIBUTED correction already booked for it. */
  readonly ledgerTransactionId: string | null;
  /** An action the break's rule calls for, taken after the break is recorded (§9.17 steps 6 then 7). */
  readonly act: (() => Promise<boolean>) | null;
}

export interface RunReport {
  readonly runId: string | null;
  readonly status: "PASSED" | "FAILED" | "QUARANTINED" | "NOT_RUN";
  readonly resumed: boolean;
  readonly triggers: readonly ReconciliationTrigger[];
  readonly detections: readonly { readonly breakClass: BreakClass; readonly subjectKey: string; readonly detail: string }[];
  readonly answers: readonly {
    readonly channel: "ORDER" | "WALLET_OPERATION" | "USER_STREAM";
    readonly requestId: string;
    readonly subjectId: string;
    readonly verdict: string;
    readonly accepted: boolean;
    readonly refusalCode: string | null;
  }[];
  /** Work (a request, a trigger) arrived during the run: another run follows at once. */
  readonly rerun: boolean;
  readonly reason: string;
}

export interface ReconcileReport {
  readonly runs: readonly RunReport[];
  readonly resumed: boolean;
}

export interface CoordinatorStatus {
  /** The coordinator holds new submissions paused. */
  readonly holding: boolean;
  readonly running: boolean;
  readonly pendingTriggers: readonly ReconciliationTrigger[];
  readonly pendingOmsRequests: number;
  readonly pendingWalletRequests: number;
  readonly pendingStreamRequests: number;
  readonly unresolvedBreaks: readonly JournalBreakView[];
}

type CoordinatorResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

class RunState {
  readonly detections: Detection[] = [];
  readonly subjects = new Set<string>();
  readonly answers: RunReport["answers"][number][] = [];
  ordersChecked = 0;
  fillsChecked = 0;
  walletOperationsChecked = 0;
  /** Every read answered in its shape, completely. */
  readsComplete = true;
  /** The order and trade reads form one consistent view (no conflict, regression or unrecognised status). */
  orderReadsSound = true;
  stale = false;
  /** A clock fault was detected after the run started, and latched into it (`#mayCommit`; r5 and r6). */
  clockFaulted = false;
  /** Holdings were not judged in this run (the OMS and the venue still disagreed about fills or state). */
  holdingsDeferred = false;
  /** Holdings were compared in this run (all reads sound, nothing deferred, no wallet operation in flight). */
  holdingsJudged = false;
  /** Submission-unknown requests with no candidate and a quiet horizon: ABSENT once holdings are judged clean. */
  readonly absentCandidates: Received<OmsReconciliationRequest>[] = [];
  /** Requests received after this were not answerable by the run's reads. */
  readsStartSeq: number | null = null;
  /** Per leg of a tracked order (`compositeKey(trade, order)`): whether the OMS holds a fill under that identity (`#probeFills`). */
  readonly fillProbe = new Map<string, "KNOWN" | "UNKNOWN">();
  /** Tracked orders (order id) whose fills this run could not verify: nothing is delivered for them. */
  readonly unverifiedOrders = new Set<string>();
  /** A tracked order's fills were not compared at all (its token is unknown, or its fixed facts differ). */
  fillsUncompared = false;
  /** Attempts whose signed identity this run judged without ambiguity, and attempts whose answer the OMS accepted in this run. */
  readonly identityJudged = new Set<string>();
  readonly answeredAccepted = new Set<string>();
  /** Tracked orders (order id) this run compared in full, state and fills (`#finalJudgements`). */
  readonly ordersComparedInFull = new Set<string>();
  /**
   * POSITIVE JUDGEMENTS (r6, class B): the exact subject keys the comparison that actually ran in this run found
   * consistent. A break is RESOLVED or NOT_REPRODUCED only through `#resolve`, which requires its subject here,
   * a complete and sound run, and the run-validity latch. Nothing else clears a break: anything not judged here
   * stays open.
   */
  readonly positive = new Set<string>();
  /** The evidence store's verdict on each venue order and trade this run read (`#assembleOrderView`). */
  readonly verdicts = new Map<string, OrderVerdict>();
  readonly tradeVerdicts = new Map<string, TradeVerdict>();
  /** Trades the evidence holds that this run's complete trades read omits, judged a CONFLICT (r7, r8; `#unattributedFromEvidence` names their SHOWN legs). */
  readonly tradesMissing = new Set<string>();
  /** The journal's evidence was readable at the start of the run (otherwise the run concludes nothing). */
  evidenceReadable = true;
  /** Channels a malformed request was taken from by this run (`#takeMalformed`). */
  readonly malformedChannels = new Set<string>();
  /** The journal recorded every event this run appended so far (a failure blocks the decision). */
  journalOk = true;
  constructor(
    readonly runId: string,
    public runStartSeq: number,
  ) {}
}

function freezeDetail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]/gu, " ");
  const trimmed = clean.length === 0 ? "(no detail)" : clean;
  return trimmed.length > MAX_DETAIL ? trimmed.slice(0, MAX_DETAIL) : trimmed;
}

function isText(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sumShares(legs: readonly VenueTradeLeg[]): DecimalString {
  let total: DecimalString = "0";
  for (const leg of legs) total = addDecimal(total, leg.shares);
  return total;
}

function venueTerminal(order: VenueOrderView): boolean {
  return order.status === "CANCELED" || compareDecimal(order.sizeMatched, order.originalSize) === 0;
}

/** (r13) A state of WP-300's closed `WalletOperationState` vocabulary (mirrored: `ports.ts`). */
function isWalletOperationState(state: string): boolean {
  return (RECONCILED_WALLET_OPERATION_STATES as readonly string[]).includes(state);
}

/** An attempt still awaiting an authoritative read (the OMS's own `resume()` rule; a held-absent attempt does not). */
function awaitsRead(attempt: AttemptView): boolean {
  return !isHeld(attempt) && (attempt.state === "SENDING" || attempt.state === "SUBMISSION_UNKNOWN" || attempt.state === "RECONCILING");
}

/** Held for the retransmission decision: an authoritative, quiescent read found it absent, and nothing of it is in flight. */
function isHeld(attempt: AttemptView): boolean {
  return attempt.state === "RECONCILING" && attempt.absentConfirmed && !attempt.inFlight;
}

function heldAttemptIds(attempts: readonly AttemptView[]): Set<string> {
  return new Set(attempts.filter(isHeld).map((attempt) => attempt.submissionAttemptId));
}

/** An attempt that could have placed a venue order the OMS does not track yet (see `identity.ts`). */
function couldHavePlaced(attempt: AttemptView): boolean {
  return attempt.venueOrderId === null && (attempt.state === "SENDING" || attempt.state === "SUBMISSION_UNKNOWN" || attempt.state === "RECONCILING");
}

export class ReconciliationCoordinator {
  readonly #deps: ReconciliationCoordinatorDependencies;
  #oms: ReconciledOms | null = null;
  #wallet: ReconciledWalletOperations | null = null;
  #stream: ReconciledUserStream | null = null;

  #seq = 0;
  #lastClock = -1;
  /** The latest sequence number at which the clock was unreadable or went backwards (-1: never). */
  #clockFaultSeq = -1;
  readonly #usedIds = new Set<string>();

  readonly #triggers: { readonly trigger: ReconciliationTrigger; readonly seq: number }[] = [];
  /** attempt id → its latest request. */
  readonly #omsRequests = new Map<string, Received<OmsReconciliationRequest>>();
  /** attempt id → what it signed (from its requests); an attempt absent here could own any order. */
  readonly #attemptFacts = new Map<string, AttemptFacts>();
  /** wallet operation id → its latest request. */
  readonly #walletRequests = new Map<string, Received<WalletReconciliationRequest>>();
  /** stream request id → the request, and (r14) what it named. */
  readonly #streamRequests = new Map<string, ReceivedStreamRequest>();
  /** Malformed request receipts, each recorded as a REQUEST_MALFORMED break by the next run (`#takeMalformed`). */
  readonly #malformed: MalformedReceipt[] = [];
  #malformedUnitemised = 0;

  /**
   * (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED) The output received immediately before the one being received, when it
   * was an ORDER or TRADE output (else `undefined`). WP-280 emits an event's `EVENT_NOT_FULLY_APPLICABLE` request right
   * after the event's output (`manager.ts` `#onFrame`: `#emit`, then `#request`; `#flush` delivers them in that order),
   * so a request received next names that event, and that output alone says which status it had (`requestEventStatus`).
   * Every output received replaces it; memory only: a restarted coordinator, and a request pulled from WP-280's backlog,
   * have none.
   */
  #previousActivity: unknown = undefined;
  readonly #streamBuffer: unknown[] = [];
  #streamChain: Promise<void> = Promise.resolve();
  #running = false;
  #holding = true;
  /**
   * Advanced by every hold (every trigger, so every request receipt, and every pause). A run decides to resume,
   * then awaits its durable PASSED record; it resumes only if the epoch has not moved meanwhile (`#finish`).
   */
  #holdEpoch = 0;

  /** Asset id → an unexplained delta awaiting confirmation. */
  readonly #unexplained = new Map<string, { readonly delta: DecimalString; readonly firstSeenAtMs: number }>();
  /** Fill and settlement facts the OMS already refused as contradictions: not offered again (each offer raises an OMS alert). */
  readonly #knownConflicts = new Set<string>();
  /**
   * THE EVIDENCE STORE (r6, class A; `evidence.ts`): every validated venue observation from every source, rebuilt
   * from the journal's `EVIDENCE_RECORDED` events at every run (`#loadEvidence`), plus the user stream's between
   * runs. Every answer, classification and resolution about a venue object asks its one query (`judge`).
   */
  #evidence = new EvidenceStore();
  /** Records folded into the store whose journal append has not succeeded yet (appended again at every run). */
  readonly #pendingEvidence: EvidenceRecord[] = [];
  /** The store holds the journal's evidence (a run, or `#ensureEvidence`, folded it). */
  #evidenceLoaded = false;
  /** Records folded during this run's reads, journaled together once the reads end (`#flushEvidence`). */
  readonly #evidenceQueue: EvidenceRecord[] = [];
  /**
   * (r14) The identities a stream request named, received while a run was in progress: a run never folds evidence it
   * did not judge (it settles what it judged at the store's level), so they wait for the next run's evidence load
   * (`#loadEvidence`), or, once the run ends, are recorded at once (`#flushReceipts`).
   */
  readonly #receiptEvidence: EvidenceRecord[] = [];
  /**
   * Each bound OMS instance's alert identity. `OmsAlert` carries no id, and two alerts can be identical (two trades
   * of one order FAILED): an alert is its instance's incarnation id and its ordinal in the instance's append-only
   * list (`#inspectAlerts`). A restart binds a new instance, so ordinals never collide across processes.
   */
  readonly #incarnations = new WeakMap<object, OmsIncarnation>();

  /** Hand this to `OrderManager.open` as its `reconciler`. */
  readonly omsRequester: ReconciliationRequester;
  /** Hand this to `WalletOperationManager` as its `reconciler`. */
  readonly walletRequester: { request(request: WalletReconciliationRequest): void };

  constructor(deps: ReconciliationCoordinatorDependencies) {
    const problem = checkDependencies(deps);
    if (problem !== undefined) throw new TypeError(`ReconciliationCoordinator: ${problem}`);
    this.#deps = deps;
    this.omsRequester = Object.freeze({ request: (request: OmsReconciliationRequest): void => this.#receiveOmsRequest(request) });
    this.walletRequester = Object.freeze({ request: (request: WalletReconciliationRequest): void => this.#receiveWalletRequest(request) });
  }

  // -------------------------------------------------------------------------
  // Binding.

  /** Bind a freshly opened OMS: pause it at once and queue the STARTUP run. Bind before any submission. */
  bindOms(oms: ReconciledOms): void {
    this.#oms = oms;
    this.#hold();
    this.trigger("STARTUP");
  }

  bindWalletOperations(wallet: ReconciledWalletOperations): void {
    this.#wallet = wallet;
  }

  /** Bind the user stream, and take any request it raised before binding. */
  bindUserStream(stream: ReconciledUserStream): void {
    this.#stream = stream;
    this.#pullStreamRequests();
  }

  // -------------------------------------------------------------------------
  // Triggers and inputs.

  /** Any §9.17 trigger: pause new submissions now, and queue a run. */
  trigger(trigger: ReconciliationTrigger): void {
    this.#hold();
    // One pending entry per kind (the queue stays bounded): the next run answers every one received before it.
    if (this.#triggers.some((entry) => entry.trigger === trigger)) return;
    this.#triggers.push({ trigger, seq: ++this.#seq });
  }

  /**
   * A WP-280 `UserStreamOutput`. Requests are taken at once; events are routed to the OMS in order (buffered during a
   * run). How the output is read is decided by the stream door's one classifier (`door.ts`, `classifyStreamOutput`),
   * which the door itself uses too: (r11) an output whose kind cannot be read, and (r13, WP290-V13-STREAM-UNKNOWN-KIND-
   * SILENT = WP290-CX-R13-01) one whose kind is readable but outside WP-280's five, or a non-activity output carrying an
   * ORDER or TRADE output's own key, is ROUTED: the door reads it as an unreadable entry (a journaled obligation of the
   * account, and a run), never as nothing. Only STATE, UNRECOGNIZED_MESSAGE and RECONCILIATION_REQUESTED outputs, as
   * WP-280 emits them, carry nothing to route.
   *
   * (r14, the re-audit of WP290-V14-WP280-EVENT-IDS-DISCARDED) An activity output received DURING a run is account
   * activity that run's reads may predate, held unrouted in the buffer: it is work that arrived during the run, like a
   * trigger or a request. It advances the hold epoch (so a run deciding to resume while it arrives does not resume),
   * the run reruns (`#workArrivedDuring`), and the next run of the same `reconcile` routes it first (`#drainBetweenRuns`).
   * c3cb404 resumed with it still in the buffer: the fill it carried was unapplied at the resume (R1).
   *
   * (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED) A request is read beside the output received immediately before it (the
   * event WP-280 raised it for, when it is one: `requestEventStatus`); every output replaces that output.
   */
  onUserStreamOutput(output: unknown): void {
    const read = classifyStreamOutput(output);
    const previous = this.#previousActivity;
    this.#previousActivity = read.read === "ORDER" || read.read === "TRADE" ? output : undefined;
    if (read.request) {
      const request = readField(output, "request");
      this.#receiveStreamRequest(request.kind === "DATA" ? request.value : undefined, previous);
    }
    if (read.read === "NOTHING") return;
    if (this.#running) {
      this.#streamBuffer.push(output);
      this.#hold();
      return;
    }
    this.#enqueueStream(output);
  }

  /** Resolves once every routed stream event has been applied. */
  async settled(): Promise<void> {
    await this.#streamChain;
  }

  // -------------------------------------------------------------------------
  // Runs.

  /**
   * Run reconciliation: one run, then more while work keeps arriving during a
   * run (at most {@link MAX_RUNS_PER_RECONCILE}). Returns at once, with no
   * run, when a run is already in progress. Never throws.
   */
  async reconcile(): Promise<ReconcileReport> {
    if (this.#running) return Object.freeze({ runs: Object.freeze([notRun([], "a run is already in progress")]), resumed: false });
    // Claimed before the first await: a second call in the same tick, or during this run, finds it taken.
    this.#running = true;
    const runs: RunReport[] = [];
    try {
      await this.#streamChain;
      for (let index = 0; index < MAX_RUNS_PER_RECONCILE; index += 1) {
        // (r14) What arrived during the previous run is taken in before this one reads.
        if (index > 0) await this.#drainBetweenRuns();
        let report: RunReport;
        try {
          report = await this.#runOnce();
        } catch {
          // A port broke its contract by throwing where it must not: nothing is concluded; the hold stays.
          this.#hold();
          report = notRun([], "the run failed unexpectedly; submissions stay paused");
        }
        runs.push(report);
        if (report.resumed || !report.rerun) break;
      }
    } finally {
      this.#running = false;
      this.#flushReceipts();
      for (const output of this.#streamBuffer.splice(0)) this.#enqueueStream(output);
    }
    return Object.freeze({ runs: Object.freeze(runs), resumed: runs.some((run) => run.resumed) });
  }

  /**
   * (r14) Between two runs of one `reconcile`: every output buffered during the previous run is routed (in order) before
   * the next run reads (the identities a request named during it are taken in by that run's evidence load). No run is
   * in progress here.
   */
  async #drainBetweenRuns(): Promise<void> {
    for (const output of this.#streamBuffer.splice(0)) this.#enqueueStream(output);
    await this.#streamChain;
  }

  /**
   * An operator's release of a QUARANTINED break (an UNATTRIBUTED halt or a
   * quarantine), recorded with who and why. It never resumes anything: it
   * queues a `MANUAL_REQUEST` run, which must pass on its own.
   */
  async releaseQuarantine(input: { readonly breakId: string; readonly operatorRef: string; readonly reason: string }): Promise<CoordinatorResult<true>> {
    const fields = readFields(input, ["breakId", "operatorRef", "reason"]);
    if (fields === undefined || !isUuidV7(fields.breakId) || !isIdentifier(fields.operatorRef) || !isText(fields.reason, MAX_DETAIL)) {
      return { ok: false, code: "INVALID_INPUT", message: "a release names the break, the operator and a reason" };
    }
    const atMs = this.#now();
    if (atMs === null) return { ok: false, code: "CLOCK_UNREADABLE", message: "the clock could not be read; nothing was released" };
    const result = await this.#append({
      kind: "BREAK_RESOLVED",
      breakId: fields.breakId,
      runId: null,
      resolution: "OPERATOR_RELEASED",
      operatorRef: fields.operatorRef,
      detail: fields.reason,
      atMs,
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    // A released ORDER_NOT_FOUND_BY_ID is the operator's classification of that id ("the venue does not show it"):
    // it settles the id's evidence at its current level (r6), so the id is no longer read or withheld for, until new
    // evidence about it arrives (which opens a new occurrence: `ghostSubject`).
    const released = this.#breakById(fields.breakId);
    const named = released === undefined ? null : venueSubjectOf(released.breakClass, released.subjectKey);
    if (released?.breakClass === "ORDER_NOT_FOUND_BY_ID" && named !== null) {
      this.#ensureEvidence();
      const level = this.#evidence.order(named.id)?.level;
      if (level !== undefined) await this.#recordEvidenceNow(null, settledRecord(named.id, level, "OPERATOR_RELEASE"), atMs);
    }
    this.trigger("MANUAL_REQUEST");
    return { ok: true, value: true };
  }

  /**
   * The journal's QUARANTINED breaks: what the live entry gate halts new entries on (C1-OMS06; WP-320's
   * `reconciliationHalts`: a MARKET-scope break with a market halts that market, any other the account). It is read
   * from the journal at every call, so an operator's {@link releaseQuarantine} lifts exactly that break's halt.
   * A break still OPEN (any rule) is not in it: the OMS stays paused while any break is unresolved, and a run repairs
   * an OPEN quarantine first.
   *
   * @throws when the journal's unresolved breaks cannot be read: never an empty list in their place (fail closed: the
   * gate refuses an entry it cannot judge, `HALTS_UNREADABLE`). `status().unresolvedBreaks` is NOT a substitute: it
   * reads an unreadable journal as no breaks.
   */
  quarantinedBreaks(): readonly JournalBreakView[] {
    const unresolved = this.#unresolvedBreaks();
    if (unresolved === undefined) throw new Error("the journal's unresolved breaks could not be read");
    return Object.freeze(unresolved.filter((view) => view.status === "QUARANTINED"));
  }

  status(): CoordinatorStatus {
    return Object.freeze({
      holding: this.#holding,
      running: this.#running,
      pendingTriggers: Object.freeze(this.#triggers.map((entry) => entry.trigger)),
      pendingOmsRequests: this.#omsRequests.size,
      pendingWalletRequests: this.#walletRequests.size,
      pendingStreamRequests: this.#streamRequests.size,
      unresolvedBreaks: this.#unresolvedBreaks() ?? [],
    });
  }

  // =========================================================================
  // One run.

  async #runOnce(): Promise<RunReport> {
    const journal = this.#deps.journal;
    if (journal.faulted) {
      this.#hold();
      return notRun([], "the journal is faulted; nothing can be recorded, so nothing resumes");
    }
    const startMs = this.#now();
    if (startMs === null) {
      this.#hold();
      return notRun([], "the clock could not be read; a run is not started");
    }
    // A run a crash left RUNNING is closed first: its breaks stay, and later runs may clear them.
    const interrupted = journal.runningRunId;
    if (interrupted !== null) {
      const closed = await this.#append({
        kind: "RUN_COMPLETED",
        runId: interrupted,
        status: "FAILED",
        ordersChecked: 0,
        fillsChecked: 0,
        walletOperationsChecked: 0,
        breaksFound: 0,
        detail: "interrupted: the run never completed (a restart or a fault)",
        atMs: startMs,
      });
      if (!closed.ok) return notRun([], `an interrupted run could not be closed: ${closed.code}`);
    }
    const runId = this.#drawId();
    if (runId === undefined) {
      this.#hold();
      return notRun([], "the id source gave no fresh UUIDv7; a run is not started");
    }
    // §9.17 step 1.
    this.#hold();
    const oms = this.#oms;
    const run = new RunState(runId, this.#seq + 1);
    if (oms !== null && !oms.faulted) {
      // ADR-032 D5's cadence, before the run's triggers are taken: what it delivers is answered by this run.
      await this.#retryCadence(run, oms);
      this.#pullStreamRequests();
    }
    const runStartSeq = ++this.#seq;
    run.runStartSeq = runStartSeq;
    const triggers = this.#takeTriggers(runStartSeq);
    const started = await this.#append({
      kind: "RUN_STARTED",
      runId,
      accountRef: this.#deps.policy.accountRef,
      trigger: triggers[0] as ReconciliationTrigger,
      triggers,
      atMs: startMs,
    });
    if (!started.ok) {
      this.#hold();
      return notRun(triggers, `the run could not be recorded: ${started.code}`);
    }
    // Every malformed request received before this run is recorded by it, as a break of its own.
    this.#takeMalformed(run, runStartSeq);
    // The evidence, rebuilt from the journal (and any record kept in memory only), before anything is read.
    await this.#loadEvidence(run, startMs);
    if (oms === null || oms.faulted) {
      run.readsComplete = false;
      this.#detect(run, {
        breakClass: "COMPONENT_UNAVAILABLE",
        subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "oms"),
        detail: oms === null ? "no OMS is bound" : "the OMS is faulted; it must be reopened from its store and bound again",
      });
      return this.#finish(run, triggers, startMs);
    }

    // ---- §9.17 steps 2-4: the reads, every one after every request it may answer --------------
    const readsStartSeq = ++this.#seq;
    run.readsStartSeq = readsStartSeq;
    const readsStartedAt = this.#now();
    this.#stampUnclockedRequests(readsStartSeq, readsStartedAt);
    const answerableOms = [...this.#omsRequests.values()].filter((entry) => entry.seq < readsStartSeq);
    const answerableWallet = [...this.#walletRequests.values()].filter((entry) => entry.seq < readsStartSeq);
    const answerableStream = [...this.#streamRequests.values()].filter((entry) => entry.seq < readsStartSeq);
    const reads = await this.#readAll(oms, answerableOms, answerableWallet);
    const readsEndedAt = this.#now();
    // EVERY validated observation of these reads is now durable evidence (r6, class A), BEFORE anything is
    // classified, and whatever the run's soundness: a stale or unusable run's observations count too.
    await this.#flushEvidence(run, readsEndedAt ?? startMs);
    // Every halt obligation that needs no consistent view of the venue, whatever this run's soundness (class C).
    this.#haltObligations(run, oms, reads);
    if (
      readsStartedAt === null ||
      readsEndedAt === null ||
      this.#clockFaultSeq >= runStartSeq ||
      readsEndedAt - readsStartedAt > this.#deps.policy.maxReadSpanMs
    ) {
      run.stale = true;
      run.readsComplete = false;
      this.#detect(run, {
        breakClass: "READ_STALE",
        subjectKey: compositeKey("READ_STALE", "run"),
        detail:
          readsStartedAt === null || readsEndedAt === null || this.#clockFaultSeq >= runStartSeq
            ? "the clock was unreadable or went backwards during the run; its reads are not one view of the account"
            : `the reads took ${String(readsEndedAt - readsStartedAt)} ms, more than the ${String(this.#deps.policy.maxReadSpanMs)} ms bound`,
      });
      // Nothing is concluded from these reads; what they showed is evidence already, and every unclaimed order with
      // evidence is held as such.
      this.#watchUnclassified(run, oms);
      return this.#finish(run, triggers, readsEndedAt ?? startMs);
    }

    // ---- §9.17 step 5: compare, and answer ------------------------------------------------------
    const view = this.#assembleOrderView(run, oms, reads);
    // A trade a read showed that a complete trades read now omits is named under its own identity, whatever this
    // run's soundness: UNATTRIBUTED when no tracked order or unresolved attempt can own its order (r7, R7-03).
    this.#unattributedFromEvidence(run, oms);
    // The trades read against the OMS's durable fills, by identity: a read behind the OMS is not one view of the
    // account, and nothing is answered or compared from it, and nothing more is written from it (`#probeFills`).
    if (run.orderReadsSound) await this.#probeFills(run, oms, view, readsStartedAt);
    if (run.orderReadsSound) {
      await this.#answerOmsRequests(run, oms, answerableOms, view, readsStartedAt);
      await this.#compareOrdersAndTrades(run, oms, view, readsStartedAt);
    }
    // A sound view classifies every venue order it holds (tracked, ORDER_UNRESOLVED or ORDER_UNATTRIBUTED, each a
    // durable record) and records every ghost (ORDER_NOT_FOUND_BY_ID); an unsound one classifies nothing, and every
    // unclaimed order with unsettled evidence is held (its evidence keeps it read by id: E-14).
    if (run.orderReadsSound) this.#recordGhosts(run, oms, view);
    else this.#watchUnclassified(run, oms);
    await this.#answerWalletRequests(run, answerableWallet, reads.walletMembers);
    if (run.orderReadsSound && run.readsComplete) {
      // The ledger projection was read before this run's fill deliveries and routings: while the OMS and the venue
      // disagree about an order's fills or state, or an order's fills were not compared at all, holdings are not
      // judged (the projection may be behind: a delta such an order explains is never booked UNATTRIBUTED), and the
      // run cannot pass; the next run, at once, judges them.
      if (run.fillsUncompared || run.detections.some((detection) => DEFERS_HOLDINGS.includes(detection.breakClass))) {
        run.holdingsDeferred = true;
      } else {
        await this.#compareHoldings(run, oms, view, reads, readsStartedAt);
      }
      await this.#answerAbsent(run, oms, view);
      await this.#acknowledgeStreamRequests(run, answerableStream);
    }
    this.#judgeAttempts(run, oms);
    this.#inspectOms(run, oms);
    this.#inspectWallet(run);
    return this.#finish(run, triggers, this.#now() ?? readsEndedAt);
  }

  async #retryCadence(run: RunState, oms: ReconciledOms): Promise<void> {
    try {
      await oms.retryReconciliationRequests();
    } catch {
      // A throwing OMS is faulted from its side; inspected at the end of the run.
    }
    const wallet = this.#wallet;
    if (wallet === null) {
      run.positive.add(compositeKey("WALLET_REQUESTS_OUTSTANDING", "inventory"));
      return;
    }
    let outstanding = 0;
    try {
      wallet.retryReconciliationRequests();
      outstanding = readArray(wallet.outstandingReconciliationRequests(), 1_000_000)?.length ?? 1;
    } catch {
      outstanding = 1;
    }
    if (outstanding === 0) run.positive.add(compositeKey("WALLET_REQUESTS_OUTSTANDING", "inventory"));
    if (outstanding > 0) {
      this.#detect(run, {
        breakClass: "WALLET_REQUESTS_OUTSTANDING",
        subjectKey: compositeKey("WALLET_REQUESTS_OUTSTANDING", "inventory"),
        detail: "the inventory still holds reconciliation requests it could not deliver (ADR-032 D5)",
      });
    }
  }

  // ---- reads ----------------------------------------------------------------------------------

  async #readAll(
    oms: ReconciledOms,
    answerableOms: readonly Received<OmsReconciliationRequest>[],
    answerableWallet: readonly Received<WalletReconciliationRequest>[],
  ): Promise<RunReads> {
    const ports = this.#deps.reads;
    // Every observation of this run is judged on its own against the evidence as it stands now.
    this.#evidence.beginRun();
    const openCall = await callRead(() => ports.listOpenOrders());
    const open = openCall.ok ? readOpenOrders(openCall.raw) : failed<readonly VenueOrderView[]>();
    const tradesCall = await callRead(() => ports.listTrades());
    const trades = tradesCall.ok ? readTrades(tradesCall.raw) : failed<readonly VenueTradeView[]>();
    // EVIDENCE (r6, class A; r11, the class fix at the door layer): EVERYTHING these answers showed, whatever their
    // completeness, folded into the store at once (and journaled together once the reads end) through the ONE
    // recording function: every row that validated in full SHOWED its object, every row that did not keeps every
    // fragment it validated, and every fragment present but unreadable is an UNREADABLE obligation.
    this.#recordSalvage(oms, { door: "open-orders", outcome: open });
    this.#recordSalvage(oms, { door: "trades", outcome: trades });
    // A venue order id the stream named and the OMS retains (it could not attribute it yet): evidence, only named.
    for (const item of oms.retainedEvidence()) if (isVenueId(item.venueOrderId)) this.#observe(namedOrder(item.venueOrderId, "OMS_RETAINED"));
    // By id (E-14: an order absent from the open-orders list is not proof of cancellation; missing orders are
    // resolved by id): every venue order with evidence no sound run has settled (`EvidenceStore.unsettled`: whatever
    // its source, a restart included), unclaimed open orders, orders named by our trade legs and not listed, tracked
    // orders open or filled and not listed, every tracked order a current request names, every retained id, and
    // every venue order an unresolved break names in its subject.
    const listed = new Set(open.kind === "OK" ? open.value.map((order) => order.venueOrderId) : []);
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    const ids = new Set<string>();
    // An order with unsettled evidence that this run's complete list does not show is read by id (one the list shows
    // is observed by this run already; a tracked one is compared from it, an unclaimed one is read by id below).
    for (const id of this.#evidence.unsettled()) if (isVenueId(id) && !listed.has(id)) ids.add(id);
    if (open.kind === "OK") for (const order of open.value) if (!claimed.has(order.venueOrderId)) ids.add(order.venueOrderId);
    if (trades.kind === "OK") for (const trade of trades.value) for (const leg of trade.ownLegs) if (!listed.has(leg.venueOrderId)) ids.add(leg.venueOrderId);
    // A terminal order with fills stays in the comparison: its fills must still be the venue's. So does any tracked
    // order an unresolved break names (its state or fills): only a run that compares it again may clear the break.
    const named = new Set((this.#unresolvedBreaks() ?? []).filter((view) => JUDGED_WITH_ORDER.includes(view.breakClass)).map((view) => view.orderId));
    for (const order of oms.orders()) {
      if (order.venueOrderId === null || listed.has(order.venueOrderId)) continue;
      if (!TERMINAL_ORDER_STATES.has(order.state) || compareDecimal(order.filledShares, "0") > 0 || named.has(order.orderId)) ids.add(order.venueOrderId);
    }
    for (const entry of answerableOms) if (entry.request.venueOrderId !== null) ids.add(entry.request.venueOrderId);
    for (const item of oms.retainedEvidence()) if (isVenueId(item.venueOrderId)) ids.add(item.venueOrderId);
    for (const id of this.#venueOrdersNamedByHolds()) if (isVenueId(id)) ids.add(id);
    const byId = new Map<string, ReadOutcome<VenueOrderView | null>>();
    for (const id of [...ids].sort()) {
      const call = await callRead(() => ports.readOrder(id));
      byId.set(id, call.ok ? readOrderById(call.raw, id) : failed());
    }
    // (r10, WP290-CX-R10-01; r11) An unusable by-id answer (not found but carrying an order, found unsaid, another
    // order's row, an invalid row) answers nothing about the order asked about (its read break stands), but what its
    // row showed is evidence like any unusable answer's, ALWAYS under the id the row itself carries, never the one
    // asked about; and its `found: true` is the venue's statement that the order asked about exists.
    for (const [id, outcome] of byId) this.#recordSalvage(oms, { door: "by-id", outcome, asked: id });
    const positionsCall = await callRead(() => ports.readPositions());
    const positions = positionsCall.ok ? readPositions(positionsCall.raw) : failed<ReadonlyMap<string, DecimalString>>();
    const collateralCall = await callRead(() => ports.readCollateral());
    const collateral = collateralCall.ok ? readCollateral(collateralCall.raw, this.#deps.policy.collateralAssetId) : failed<DecimalString>();
    const approvalsCall = await callRead(() => ports.readApprovals());
    const approvals = approvalsCall.ok ? readApprovals(approvalsCall.raw) : failed<ReadonlyMap<string, boolean>>();
    // (r11) The holdings too: detail only (not monotonic), but nothing an answer showed is lost.
    this.#recordSalvage(oms, { door: "positions", outcome: positions });
    this.#recordSalvage(oms, { door: "collateral", outcome: collateral });
    this.#recordSalvage(oms, { door: "approvals", outcome: approvals });
    const projectedCall = await callRead(() => this.#deps.holdings.projected());
    const projected = projectedCall.ok ? readProjectedHoldings(projectedCall.raw) : failed<ProjectedHoldingsRead>();
    // What the ledger still books of each FAILED fill the trades read shows (r4, WP290-CX-R4-02; ADR-006 §5): the
    // only holding difference such a fill explains, and, while any of it remains, a reversal owed.
    const failedFills = failedFillsOf(trades);
    const bookingsCall = failedFills.length === 0 ? { ok: true as const, raw: { bookings: [] } } : await callRead(() => this.#deps.holdings.remainingBookings(failedFills));
    const bookings = bookingsCall.ok ? readRemainingBookings(bookingsCall.raw, failedFills) : failed<ReadonlyMap<string, readonly BookedAmount[]>>();
    const walletMembers = new Map<string, ReadOutcome<WalletMemberRead>>();
    for (const entry of answerableWallet) {
      for (const member of walletMembersOf(entry.request)) {
        const parsed = parseMember(member);
        if (parsed === null || walletMembers.has(member)) continue;
        const call = await callRead(() => ports.readWalletMember(parsed));
        const outcome = call.ok ? readWalletMember(call.raw) : failed<WalletMemberRead>();
        walletMembers.set(member, outcome);
        this.#recordSalvage(oms, { door: "wallet-member", outcome, member });
      }
    }
    return { open, trades, byId, positions, collateral, approvals, projected, bookings, walletMembers };
  }

  /**
   * Read-level problems, and the run's one view of the account's orders and trades: EVERY venue order and trade this
   * run read, and every one with evidence, is judged by the evidence store's one query (`EvidenceStore.judge`)
   * against this run's other reads and against ALL its evidence, and the view holds only what that verdict says.
   * Only a CONSISTENT order is in `venueOrders` (and so can be answered, compared, classified or resolved); a
   * CONFLICT makes the view unsound (a hold); a GHOST withholds every signed-identity answer; a MISSING claimed
   * order is the OMS comparison's to hold. Nothing downstream looks at a raw read.
   */
  #assembleOrderView(run: RunState, oms: ReconciledOms, reads: RunReads): OrderTradeView {
    const venueOrders = new Map<string, VenueOrderView>();
    const missing = new Set<string>();
    const ghosts: string[] = [];
    const legsByOrder = new Map<string, { readonly leg: VenueTradeLeg; readonly trade: VenueTradeView; readonly status: VenueTradeStatus | null }[]>();
    const sound = (ok: boolean): void => {
      if (!ok) run.orderReadsSound = false;
    };
    if (!run.evidenceReadable) sound(false);
    sound(this.#readProblem(run, "open-orders", reads.open));
    sound(this.#readProblem(run, "trades", reads.trades));
    // (r11, the class fix) Every account-level UNREADABLE obligation (an order row, a trade row or a leg whose identity
    // was unreadable; an unreadable user-stream entry): no read can account for it exactly, so it holds the account in
    // every run (a READ_CONFLICT no run resolves: nothing ever judges its subject consistent).
    for (const obligation of this.#evidence.accountObligations()) {
      sound(false);
      this.#detect(run, {
        breakClass: "READ_CONFLICT",
        subjectKey: compositeKey("READ_CONFLICT", "unreadable", String(obligation.ordinal)),
        detail: obligation.detail,
      });
    }
    this.#readProblem(run, "positions", reads.positions);
    this.#readProblem(run, "collateral", reads.collateral);
    this.#readProblem(run, "approvals", reads.approvals);
    this.#readProblem(run, "ledger-projection", reads.projected);
    this.#readProblem(run, "ledger-fill-bookings", reads.bookings);
    // The trades: each one this run's trades read shows, and (r7) every trade the evidence holds, judged against its
    // evidence: a fill's economics shown two ways is a durable CONFLICT whether or not this read shows the trade
    // (WP290-CX-R7-02), and a trade a read SHOWED that this complete read omits, not accounted for under its own
    // identity, is a CONFLICT (WP290-CX-R7-03: a durable classification obligation for every observed trade).
    const tradesOk = reads.trades.kind === "OK";
    const tradesShown = new Map(reads.trades.kind === "OK" ? reads.trades.value.map((trade) => [trade.venueTradeId, trade]) : []);
    const accounting = this.#accounting(oms);
    const tradeIds = new Set<string>([...tradesShown.keys(), ...(tradesOk ? this.#evidence.tradeIds() : [])]);
    for (const tradeId of [...tradeIds].sort()) {
      const shown = tradesShown.get(tradeId);
      const verdict = this.#evidence.judge({ trade: tradeId, reads: { tradesOk, shown, held: accounting.held(tradeId), accounted: (leg) => accounting.leg(tradeId, leg) } });
      run.tradeVerdicts.set(tradeId, verdict);
      if (verdict.kind === "CONFLICT") {
        sound(false);
        this.#detectProblems(run, "trade", tradeId, verdict.problems);
        if (shown === undefined) run.tradesMissing.add(tradeId);
      } else if (verdict.kind === "CONSISTENT") {
        for (const breakClass of VENUE_OBJECT_CLASSES) run.positive.add(compositeKey(breakClass, "trade", tradeId));
      }
      if (shown === undefined) continue;
      for (const leg of shown.ownLegs) {
        const list = legsByOrder.get(leg.venueOrderId) ?? [];
        list.push({ leg, trade: shown, status: verdict.kind === "CONSISTENT" ? verdict.status : tradeStatusOf(shown.status) });
        legsByOrder.set(leg.venueOrderId, list);
        run.fillsChecked += 1;
      }
    }
    // The orders: every one listed, read by id, named by a leg, or with unsettled evidence.
    const listed = new Map(reads.open.kind === "OK" ? reads.open.value.map((order) => [order.venueOrderId, order]) : []);
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    const orderIds = new Set<string>([...listed.keys(), ...reads.byId.keys(), ...legsByOrder.keys(), ...this.#evidence.unsettled()]);
    for (const id of [...orderIds].sort()) {
      const outcome = reads.byId.get(id);
      if (outcome !== undefined) {
        const answered = this.#readProblem(run, compositeKey("order", id), outcome);
        sound(answered);
      }
      const byId = outcome?.kind === "OK" ? outcome.value : undefined;
      const legs = (legsByOrder.get(id) ?? []).map((entry) => entry.leg);
      const verdict = this.#evidence.judge({ order: id, reads: { claimed: claimed.has(id), listed: listed.get(id), byId, legs } });
      run.verdicts.set(id, verdict);
      switch (verdict.kind) {
        case "CONSISTENT":
          venueOrders.set(id, verdict.order);
          for (const breakClass of VENUE_OBJECT_CLASSES) run.positive.add(compositeKey(breakClass, "order", id));
          run.positive.add(compositeKey("ORDER_UNRESOLVED", "venue-order", id));
          run.positive.add(compositeKey("ORDER_UNRESOLVED", "venue-order-named", id));
          break;
        case "CONFLICT":
          sound(false);
          this.#detectProblems(run, "order", id, verdict.problems);
          break;
        case "GHOST":
          if (!claimed.has(id)) ghosts.push(id);
          run.positive.add(compositeKey("ORDER_UNRESOLVED", "venue-order-named", id));
          break;
        case "ACKNOWLEDGED":
          run.positive.add(compositeKey("ORDER_UNRESOLVED", "venue-order-named", id));
          break;
        case "MISSING":
          missing.add(id);
          break;
        case "UNREAD":
          // An order with unsettled evidence that nothing this run answered about: nothing about it is concluded.
          if (outcome === undefined && !this.#evidence.order(id)?.settled) {
            sound(false);
            this.#detect(run, {
              breakClass: "READ_MISSING",
              subjectKey: compositeKey("READ_MISSING", compositeKey("order", id)),
              detail: `venue order ${id} has evidence no sound run has settled, and this run did not read it by id`,
            });
          }
          break;
      }
    }
    run.ordersChecked += venueOrders.size;
    return { venueOrders, missing, ghosts, legsByOrder };
  }

  /** Record each problem a verdict names, keyed by the venue order or trade it is about. */
  #detectProblems(run: RunState, kind: "order" | "trade", id: string, problems: readonly EvidenceProblem[]): void {
    for (const entry of problems) {
      this.#detect(run, {
        breakClass: entry.breakClass,
        subjectKey: compositeKey(entry.breakClass, kind, id),
        expectedValue: entry.expected,
        observedValue: entry.observed,
        detail: entry.detail,
      });
    }
  }

  /**
   * The CLASSIFICATION OBLIGATION of every trade identity the evidence holds (r7, WP290-CX-R7-03; r8, WP290-CX-R8-01),
   * so that a complete trades read may omit the trade without a CONFLICT (history may age a classified trade out).
   *
   * HELD: an unresolved break that HOLDS names the trade (a read-problem class or `STATUS_UNRECOGNISED` keyed by the
   * trade, or `SETTLEMENT_REVERSAL_OWED`: the subjects `subjects.ts` decodes as a trade): a hold about it is judged
   * until a read shows it consistent. Its own
   * `TRADE_UNATTRIBUTED` quarantine, released or not, does not hold it: that quarantine IS the trade's classification
   * under its own identity (below), and it halts its market and blocks every resume until an operator releases it.
   *
   * A leg is ACCOUNTED FOR under the trade's own identity:
   * - whatever its source, by a `TRADE_UNATTRIBUTED` break for that trade and order, in any state (recorded from the
   *   evidence when no one can own the order: `#unattributedFromEvidence`, and an UNATTRIBUTED order's legs);
   * - a leg a read SHOWED (r7), also when it is on a venue order the OMS tracks (an order or an attempt claims it: the
   *   OMS comparison judges that order by trade id, and the leg's shares are in the order's high-water matched size,
   *   so no other trade can stand in for it), or on one an unresolved attempt could own (by the leg's token and side:
   *   that attempt's resolution classifies it, and the attempt holds the account meanwhile);
   * - a leg only the user stream NAMED (r8): the OMS did not apply it, so it holds no fill under that identity, and its
   *   shares may be unknown (a settlement without its fill, as WP-280 projects every maker leg). A claimed order, or an
   *   order's matched size that other trades cover, never answers it: only a read showing the trade does. Also
   *   accounted for: a leg on a venue order no read ever SHOWED and no tracked order claims (its by-id read decides:
   *   not found, it is a GHOST, whose `ORDER_NOT_FOUND_BY_ID` quarantine covers the trades named on it and withholds
   *   every signed-identity answer; found, the order is SHOWN, and the leg is judged by the next clause), and a leg on a
   *   SHOWN, unclaimed venue order no unresolved attempt could own (by the order's token and side): it is unmatched
   *   activity, recorded `TRADE_UNATTRIBUTED` from the evidence by every sound run that classifies the order
   *   (`ORDER_UNATTRIBUTED`). A leg on an order an attempt could own is NOT: an answer in the same run could claim the
   *   order after the trade was judged, with nothing left to stand for the leg.
   * The journal unreadable: every trade is held and nothing is accounted for (fail closed).
   */
  #accounting(oms: ReconciledOms): { readonly held: (tradeId: string) => boolean; readonly leg: (tradeId: string, leg: LegEvidence) => boolean } {
    const breaks = this.#allBreaks();
    const unresolved = this.#unresolvedBreaks();
    if (breaks === undefined || unresolved === undefined) return { held: () => true, leg: () => false };
    const unattributed = new Set(breaks.filter((view) => view.breakClass === "TRADE_UNATTRIBUTED").map((view) => view.subjectKey));
    const held = new Set<string>();
    for (const view of unresolved) {
      const named = venueSubjectOf(view.breakClass, view.subjectKey);
      if (named?.kind === "trade") held.add(named.id);
    }
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    const owners = this.#potentialOwners(oms);
    return {
      held: (tradeId) => held.has(tradeId),
      leg: (tradeId, leg) => {
        if (unattributed.has(compositeKey("TRADE_UNATTRIBUTED", tradeId, leg.venueOrderId))) return true;
        if (leg.shown) return claimed.has(leg.venueOrderId) || ownable(owners, leg);
        if (claimed.has(leg.venueOrderId)) return false;
        const order = this.#evidence.order(leg.venueOrderId);
        if (order?.shown !== true) return true;
        return !ownable(owners, { tokenId: leg.tokenId ?? order.tokenId, side: leg.side ?? order.side });
      },
    };
  }

  /**
   * Every trade a read SHOWED that this run's complete trades read omits (`RunState.tradesMissing`: a CONFLICT that
   * holds the run) is named under its own identity, from its evidence, in any run: each shown leg on a venue order
   * no tracked order or attempt claims, and that no unresolved attempt could own (by the leg's token and side), is
   * `TRADE_UNATTRIBUTED` (a quarantine that halts its market). Unmatched actual activity never disappears silently
   * (r7, WP290-CX-R7-03). A leg an attempt could own waits, held by the trade's conflict.
   */
  #unattributedFromEvidence(run: RunState, oms: ReconciledOms): void {
    if (run.tradesMissing.size === 0) return;
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    const owners = this.#potentialOwners(oms);
    for (const tradeId of [...run.tradesMissing].sort()) {
      for (const leg of this.#evidence.trade(tradeId)?.legs ?? []) {
        if (!leg.shown || claimed.has(leg.venueOrderId) || ownable(owners, leg)) continue;
        this.#detect(run, {
          breakClass: "TRADE_UNATTRIBUTED",
          subjectKey: compositeKey("TRADE_UNATTRIBUTED", tradeId, leg.venueOrderId),
          ...(leg.tokenId === null ? {} : this.#marketOf(leg.tokenId)),
          assetId: leg.tokenId,
          observedValue: leg.shares,
          detail: `trade ${tradeId} (${leg.side ?? "?"} ${leg.shares ?? "?"} at ${leg.price ?? "?"}) on venue order ${leg.venueOrderId}, which no tracked order or unresolved attempt can own: an earlier read showed it, and a complete trades read no longer does: UNATTRIBUTED, from its evidence`,
        });
      }
    }
  }

  /**
   * A run that is not one consistent view (or is stale) classifies none of the venue orders its reads showed. Every
   * unclaimed venue order with unsettled evidence is held as an `ORDER_UNRESOLVED` keyed by the venue order, with
   * its provenance as the evidence store holds it (`venue-order` when any source SHOWED it in full, from any run;
   * `venue-order-named` when only its id was named): an operator-visible hold. The evidence itself (durable, in
   * the journal) keeps it read by id in every later run until a sound run classifies it (tracked by a PRESENT
   * answer, `ORDER_UNRESOLVED` while an attempt could own it, `ORDER_UNATTRIBUTED`, or, for an id only named that
   * its by-id read does not find, `ORDER_NOT_FOUND_BY_ID`). Nothing about the order is concluded here.
   */
  #watchUnclassified(run: RunState, oms: ReconciledOms): void {
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    for (const id of this.#evidence.unsettled()) {
      const evidence = this.#evidence.order(id);
      if (claimed.has(id) || evidence === undefined) continue;
      const sources = evidence.sources.join("; ");
      this.#detect(run, {
        breakClass: "ORDER_UNRESOLVED",
        subjectKey: compositeKey("ORDER_UNRESOLVED", evidence.shown ? "venue-order" : "venue-order-named", id),
        ...(evidence.tokenId === null ? {} : this.#marketOf(evidence.tokenId)),
        detail: evidence.shown
          ? `venue order ${id} was seen by a run whose reads were not one consistent view, or by an earlier one, and no sound run has classified it (shown in full by ${sources}; at least ${evidence.matchedHigh} matched${evidence.terminal ? ", terminal" : ""}); no tracked order claims it: it is read by id in every run until a sound run classifies it (E-14), and a by-id read that does not find it, or shows less, is a contradiction`
          : `venue order ${id} was named by a run whose reads were not one consistent view, or by an earlier one (${sources}), but no read showed it in full, and no tracked order claims it: it is read by id in every run until a sound run classifies it, or finds it nowhere (ORDER_NOT_FOUND_BY_ID)`,
      });
    }
  }

  /**
   * A sound run's verdict on each GHOST (`EvidenceStore.judge`): an unclaimed venue order id only NAMED (the id
   * alone of a malformed row or leg; an id the OMS retains as stream evidence; one the stream reported), which the
   * venue's by-id read does not find. No earlier read is contradicted, so it is not a `READ_CONFLICT`: the evidence
   * is kept as an `ORDER_NOT_FOUND_BY_ID` quarantine (the account is halted), read by id while it stands; an
   * operator's release settles the id's evidence ("the venue does not show it"). New evidence about the id after a
   * release is a new occurrence, with its own subject (`ghostSubject`).
   */
  #recordGhosts(run: RunState, oms: ReconciledOms, view: OrderTradeView): void {
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    for (const id of view.ghosts) {
      if (claimed.has(id)) continue;
      const evidence = this.#evidence.order(id);
      // (r9, the P9-C observation) The trades named on it, which this quarantine covers (`#accounting`), by their ids.
      const trades = this.#evidence.legsOn(id).map((entry) => entry.venueTradeId);
      this.#detect(run, {
        breakClass: "ORDER_NOT_FOUND_BY_ID",
        subjectKey: this.#ghostSubject(id),
        ...(evidence?.tokenId === null || evidence?.tokenId === undefined ? {} : this.#marketOf(evidence.tokenId)),
        detail: `venue order ${id} was only named (${evidence?.sources.join(", ") ?? "?"}), no read ever showed it in full, and the venue's by-id read does not find it (E-14: canceled and fully matched orders are found by id): quarantined until an operator releases it; while it stands no attempt is answered by signed identity${trades.length === 0 ? "" : `; it covers the trade(s) named on it: ${trades.join(", ")}`}`,
      });
    }
  }

  /**
   * The subject of one ghost occurrence: the first is keyed by the id alone; after an operator released earlier
   * occurrences, the next is keyed by the id and how many were released (an occurrence id, never a hash of detail).
   */
  #ghostSubject(id: string): string {
    const released = (this.#allBreaks() ?? []).filter(
      (view) => view.breakClass === "ORDER_NOT_FOUND_BY_ID" && view.resolution === "OPERATOR_RELEASED" && venueSubjectOf(view.breakClass, view.subjectKey)?.id === id,
    ).length;
    return released === 0 ? compositeKey("ORDER_NOT_FOUND_BY_ID", id) : compositeKey("ORDER_NOT_FOUND_BY_ID", id, String(released));
  }

  /** The venue orders unresolved breaks name in their subjects (`subjects.ts`). Unreadable: none (that run cannot pass). */
  #venueOrdersNamedByHolds(): string[] {
    const out: string[] = [];
    for (const view of this.#unresolvedBreaks() ?? []) {
      const named = venueSubjectOf(view.breakClass, view.subjectKey);
      if (named !== null && named.kind === "order") out.push(named.id);
    }
    return out;
  }

  /** Record a read's problem; `true` when the read is OK (a positive judgement of every problem keyed by that read). */
  #readProblem(run: RunState, name: string, outcome: ReadOutcome<unknown>): boolean {
    if (outcome.kind === "OK") {
      for (const breakClass of READ_PROBLEM_CLASSES) run.positive.add(compositeKey(breakClass, name));
      return true;
    }
    run.readsComplete = false;
    const map = {
      FAILED: ["READ_MISSING", `the ${name} read failed or was not provided`],
      MALFORMED: ["READ_MALFORMED", `the ${name} read answered outside its shape: ${outcome.kind === "MALFORMED" ? outcome.why : ""}`],
      INCOMPLETE: ["READ_INCOMPLETE", `the ${name} read did not reach its last page`],
      WRONG_ROUTE: ["READ_WRONG_ROUTE", `the ${name} read came from ${outcome.kind === "WRONG_ROUTE" ? outcome.route : ""}, not the required route (Data API v1 is retired; E-15)`],
    } as const;
    const [breakClass, detail] = map[outcome.kind];
    this.#detect(run, { breakClass, subjectKey: compositeKey(breakClass, name), detail });
    return false;
  }

  // ---- answers to the OMS ---------------------------------------------------------------------

  async #answerOmsRequests(
    run: RunState,
    oms: ReconciledOms,
    answerable: readonly Received<OmsReconciliationRequest>[],
    view: OrderTradeView,
    readsStartedAt: number,
  ): Promise<void> {
    for (const received of answerable) {
      const request = received.request;
      const attempt = oms.attempts().find((candidate) => candidate.submissionAttemptId === request.submissionAttemptId);
      if (attempt === undefined || attempt.currentRequestId !== request.requestId) {
        // Superseded or consumed: the OMS no longer waits on it (a newer request, if any, is in the map).
        this.#dropOmsRequest(request);
        continue;
      }
      if (request.venueOrderId !== null) {
        await this.#answerKnownOrder(run, oms, received, view);
        continue;
      }
      if (attempt.inFlight) continue; // the OMS refuses ABSENT while its own transmission is pending
      const facts = this.#attemptFacts.get(request.submissionAttemptId) ?? factsOf(request);
      // A GHOST (`EvidenceStore.judge`: an unclaimed id only NAMED, by any source: the id alone of a malformed row or
      // leg, an id the OMS retains as user-stream evidence, one the stream reported; which the venue's by-id read does
      // not find) is not a candidate, but nothing rules it out either: its token is unknown, so any attempt could own
      // it. While one stands, no attempt is answered by signed identity, neither PRESENT on another candidate nor
      // ABSENT. Its ORDER_NOT_FOUND_BY_ID quarantine halts the account meanwhile; once an operator releases it (which
      // settles its evidence), or the venue shows the order, a later run answers (r5; r6 for every NAMED source).
      const ghosts = view.ghosts;
      if (ghosts.length > 0) {
        // Recorded every run while it stands (so it is reproduced, never cleared, whatever `identityJudged` says).
        this.#detect(run, {
          breakClass: "SIGNED_IDENTITY_AMBIGUOUS",
          subjectKey: compositeKey("SIGNED_IDENTITY_AMBIGUOUS", request.submissionAttemptId),
          marketId: request.marketId,
          orderId: request.orderId,
          detail: `attempt ${request.submissionAttemptId}: venue order ${ghosts.join(", ")} was only named, no read showed it, and the venue's by-id read does not find it (ORDER_NOT_FOUND_BY_ID): it could be this attempt's, so no signed-identity answer is given while it stands`,
        });
        continue;
      }
      const verdict = resolveBySignedIdentity(facts, this.#unclaimed(oms, view), this.#potentialOwners(oms));
      if (verdict.kind !== "AMBIGUOUS") run.identityJudged.add(request.submissionAttemptId);
      if (verdict.kind === "AMBIGUOUS") {
        this.#detect(run, {
          breakClass: "SIGNED_IDENTITY_AMBIGUOUS",
          subjectKey: compositeKey("SIGNED_IDENTITY_AMBIGUOUS", request.submissionAttemptId),
          marketId: request.marketId,
          orderId: request.orderId,
          detail: `attempt ${request.submissionAttemptId}: ${verdict.why} (candidates: ${verdict.candidates.join(", ")})`,
        });
        continue;
      }
      if (verdict.kind === "PRESENT") {
        await this.#answerOms(run, oms, received, {
          requestId: request.requestId,
          submissionAttemptId: request.submissionAttemptId,
          verdict: "PRESENT",
          order: {
            venueOrderId: verdict.order.venueOrderId,
            status: verdict.order.status,
            sizeMatched: verdict.order.sizeMatched,
            originalSize: verdict.order.originalSize,
          },
        });
        continue;
      }
      // NO_CANDIDATE: ABSENT only once quiescent, by this coordinator's own clock (WP-270's QUIESCENCE RULE), and only
      // after this run's holdings are judged clean for the attempt's token and the collateral (`#answerAbsent`).
      if (received.atMs === null || this.#clockFaultSeq >= received.seq || readsStartedAt - received.atMs < this.#deps.policy.quiescenceHorizonMs) {
        continue;
      }
      run.absentCandidates.push(received);
    }
  }

  /**
   * The ABSENT answers this run may give. "No live order and no trade" is what the order and trade reads show;
   * a fill they do not show yet (a marketable order matched at once, whose trade the read lags) would still move
   * the holdings once settled. So ABSENT also needs this run to have judged the holdings, with no holding break
   * in the attempt's token or in the collateral. Anything else waits for a later run (fail closed: the attempt
   * stays unresolved and submissions stay paused).
   */
  async #answerAbsent(run: RunState, oms: ReconciledOms, view: OrderTradeView): Promise<void> {
    if (run.absentCandidates.length === 0) return;
    const collateral = this.#deps.policy.collateralAssetId;
    for (const received of run.absentCandidates) {
      const request = received.request;
      // The evidence's verdicts again (the same run's): every venue object judged without conflict, no ghost
      // stands, and no unclaimed order this run judged could be the attempt's (checked when the request was
      // queued too; nothing here weakens it).
      if (!this.#evidenceJudged(run) || view.ghosts.length > 0) continue;
      const facts = this.#attemptFacts.get(request.submissionAttemptId) ?? factsOf(request);
      if (resolveBySignedIdentity(facts, this.#unclaimed(oms, view), this.#potentialOwners(oms)).kind !== "NO_CANDIDATE") continue;
      // Any break this run found in the token or the collateral (an unexplained or unconfirmed delta, one in transit,
      // a booking, an unattributed order or trade) withholds ABSENT.
      const touched = run.detections.some((detection) => detection.assetId === request.tokenId || detection.assetId === collateral);
      // So does any unresolved break from an earlier run that names them (a quarantined booking, say).
      const open = this.#unresolvedBreaksWithAssets().some((assetId) => assetId === request.tokenId || assetId === collateral);
      if (!run.holdingsJudged || touched || open) continue;
      const attempt = oms.attempts().find((candidate) => candidate.submissionAttemptId === request.submissionAttemptId);
      if (attempt === undefined || attempt.currentRequestId !== request.requestId || attempt.inFlight) continue;
      await this.#answerOms(run, oms, received, {
        requestId: request.requestId,
        submissionAttemptId: request.submissionAttemptId,
        verdict: "ABSENT",
        transmissionQuiescent: true,
      });
    }
  }

  /** ORDER_STATE / FINAL_SIZE: the tracked venue order, read by id after the request was received. */
  async #answerKnownOrder(run: RunState, oms: ReconciledOms, received: Received<OmsReconciliationRequest>, view: OrderTradeView): Promise<void> {
    const request = received.request;
    const venueOrderId = request.venueOrderId as string;
    const venue = view.venueOrders.get(venueOrderId);
    const order = oms.orders().find((candidate) => candidate.orderId === request.orderId);
    if (venue === undefined || order === undefined) {
      this.#detect(run, {
        breakClass: "ORDER_STATE_MISMATCH",
        subjectKey: compositeKey("ORDER_STATE_MISMATCH", request.orderId),
        marketId: request.marketId,
        orderId: request.orderId,
        detail: `the venue does not show tracked order ${request.orderId} (venue id ${venueOrderId})`,
      });
      return;
    }
    // The request names the order's token (its group's): the venue's token is a fixed fact like the others.
    if (!sameOrderFacts(order, venue, request.tokenId)) {
      this.#detect(run, {
        breakClass: "ORDER_FACTS_MISMATCH",
        subjectKey: compositeKey("ORDER_FACTS_MISMATCH", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        detail: `tracked order ${order.orderId}: the venue's token, side, price or size differs from the order's`,
      });
      return;
    }
    if (compareDecimal(venue.sizeMatched, order.filledShares) < 0) {
      this.#detect(run, {
        breakClass: "ORDER_FILLS_AHEAD_OF_VENUE",
        subjectKey: compositeKey("ORDER_FILLS_AHEAD_OF_VENUE", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        expectedValue: order.filledShares,
        observedValue: venue.sizeMatched,
        detail: `tracked order ${order.orderId}: the OMS recorded more fill than the venue shows; no answer is given`,
      });
      return;
    }
    await this.#answerOms(run, oms, received, {
      requestId: request.requestId,
      submissionAttemptId: request.submissionAttemptId,
      verdict: "PRESENT",
      order: { venueOrderId, status: venue.status, sizeMatched: venue.sizeMatched, originalSize: venue.originalSize },
    });
  }

  async #answerOms(run: RunState, oms: ReconciledOms, received: Received<OmsReconciliationRequest>, answer: Readonly<Record<string, unknown>>): Promise<void> {
    const request = received.request;
    // The run-validity latch (r5, r6): no answer once a clock fault is detected in this run, at any await before
    // this one: an ABSENT queued before it would attest a quiescence the faulted clock measured. The request stays
    // owed; a later run answers it.
    if (!this.#mayCommit(run)) return;
    let accepted = false;
    let code: string | null = null;
    try {
      const result: unknown = await oms.applyReconciliation(Object.freeze(answer));
      accepted = readOkFlag(result);
      code = accepted ? null : readRefusalCode(result);
    } catch {
      code = "UNREADABLE";
    }
    const verdict = typeof answer["verdict"] === "string" ? answer["verdict"] : "UNKNOWN";
    await this.#recordAnswer(run, "ORDER", request.requestId, request.submissionAttemptId, verdict, accepted, code);
    if (accepted) {
      run.answeredAccepted.add(request.submissionAttemptId);
      this.#dropOmsRequest(request);
      return;
    }
    if (code === "OMS_RECONCILIATION_SUPERSEDED" || code === "OMS_RECONCILIATION_UNBOUND" || code === "OMS_RECONCILIATION_SUBJECT_MISMATCH") {
      // The OMS no longer waits on this request; a newer one, if owed, arrives on its own.
      this.#dropOmsRequest(request);
      return;
    }
    this.#detect(run, {
      breakClass: "ANSWER_REFUSED",
      subjectKey: compositeKey("ANSWER_REFUSED", request.submissionAttemptId),
      marketId: request.marketId,
      orderId: request.orderId,
      detail: `the OMS refused the ${verdict} answer for attempt ${request.submissionAttemptId}: ${code ?? "UNREADABLE"}`,
    });
  }

  // ---- orders and trades against the OMS ------------------------------------------------------

  /**
   * The IDENTITY PROBE (§6 invariant 5): every leg of a tracked order is offered to the OMS as a settlement
   * observation. The OMS keys a fill on (trade, order, discriminator `"0"`, WP-280's convention), so
   * `OMS_UNKNOWN_FILL` says it holds no fill under the leg's identity, and any other answer says it does. A
   * refusal as stale (a settlement earlier than the one the OMS recorded durably) means the read is behind the
   * OMS: a READ_REGRESSION, which no restart forgets, and nothing is answered or compared from the read. A
   * contradicted terminal settlement is a FILL_MISMATCH. Any other refusal leaves the order unverified.
   *
   * THE PROBE WRITES. A leg the OMS holds whose status is a legal step forward is RECORDED by the OMS (that is
   * what `applySettlement` does; no read-only view of the OMS's fills exists). Each such write is one settlement
   * the venue showed for one (trade, order) identity the OMS already holds, which the OMS itself accepts only as a
   * legal forward transition (it refuses a regression or a contradiction, and writes nothing then). Once the read
   * set is found unsound, NOTHING MORE is written from it: no further leg is probed (`#probeLeg` returns at once,
   * for this caller and for `#compareFills`'s), and nothing is compared or delivered. Legs probed before the
   * regression was found may have been recorded: each was a forward fact on its own, and the run that found the
   * regression does not resume.
   */
  async #probeFills(run: RunState, oms: ReconciledOms, view: OrderTradeView, readsStartedAt: number): Promise<void> {
    for (const order of oms.orders()) {
      if (order.venueOrderId === null) continue;
      for (const entry of view.legsByOrder.get(order.venueOrderId) ?? []) await this.#probeLeg(run, oms, order, entry, readsStartedAt);
    }
  }

  /** Probe one leg of a tracked order (see `#probeFills`). Every outcome is recorded: a KNOWN or UNKNOWN identity, or a break. */
  async #probeLeg(
    run: RunState,
    oms: ReconciledOms,
    order: OrderView,
    entry: { readonly leg: VenueTradeLeg; readonly trade: VenueTradeView; readonly status: VenueTradeStatus | null },
    readsStartedAt: number,
  ): Promise<void> {
    const venueOrderId = entry.leg.venueOrderId;
    const tradeId = entry.trade.venueTradeId;
    const key = compositeKey(tradeId, venueOrderId);
    // Nothing is written to the OMS from a read set found unsound (see `#probeFills`).
    if (run.fillProbe.has(key) || !run.orderReadsSound) return;
    if (entry.status === null) {
      // Unreachable on a sound view (an unrecognised status makes it unsound); fail closed regardless.
      run.unverifiedOrders.add(order.orderId);
      this.#detect(run, {
        breakClass: "STATUS_UNRECOGNISED",
        subjectKey: compositeKey("STATUS_UNRECOGNISED", "trade", tradeId),
        detail: `trade ${tradeId} has a status outside the documented vocabulary`,
      });
      return;
    }
    const conflict = compositeKey("settlement", tradeId, venueOrderId, entry.status);
    let code: string | null = "OMS_SETTLEMENT_CONFLICT";
    if (!this.#knownConflicts.has(conflict)) {
      // The run-validity latch (r6, class D): no OMS write once a fault is detected in this run.
      if (!this.#mayCommit(run)) {
        run.unverifiedOrders.add(order.orderId);
        return;
      }
      let result: unknown;
      try {
        result = await oms.applySettlement({
          venueTradeId: tradeId,
          venueOrderId,
          status: entry.status,
          transactionHash: entry.trade.transactionHash,
          observedAt: isoFromEpochMs(readsStartedAt) as string,
        });
      } catch {
        result = undefined;
      }
      code = readOkFlag(result) ? null : readRefusalCode(result);
    }
    if (code === "OMS_UNKNOWN_FILL") {
      run.fillProbe.set(key, "UNKNOWN");
      return;
    }
    if (code === null || code === "OMS_SETTLEMENT_REGRESSION" || code === "OMS_SETTLEMENT_CONFLICT") run.fillProbe.set(key, "KNOWN");
    if (code === "OMS_SETTLEMENT_REGRESSION") {
      run.orderReadsSound = false;
      this.#detect(run, {
        breakClass: "READ_REGRESSION",
        subjectKey: compositeKey("READ_REGRESSION", "trade", tradeId),
        marketId: order.marketId,
        orderId: order.orderId,
        detail: `trade ${tradeId}: the read shows settlement ${entry.status}, earlier than the OMS recorded durably (a read behind the OMS)`,
      });
    } else if (code === "OMS_SETTLEMENT_CONFLICT") {
      this.#rememberConflict(conflict);
      run.unverifiedOrders.add(order.orderId);
      this.#detect(run, {
        breakClass: "FILL_MISMATCH",
        subjectKey: compositeKey("FILL_MISMATCH", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        detail: `tracked order ${order.orderId}: trade ${tradeId}'s settlement ${entry.status} contradicts the terminal settlement the OMS recorded`,
      });
    } else if (code !== null) {
      run.unverifiedOrders.add(order.orderId);
      this.#detect(run, {
        breakClass: "FILL_REFUSED",
        subjectKey: compositeKey("FILL_REFUSED", "settlement", tradeId, venueOrderId),
        marketId: order.marketId,
        orderId: order.orderId,
        detail: `the OMS refused trade ${tradeId}'s settlement status: ${code}`,
      });
    }
  }

  async #compareOrdersAndTrades(run: RunState, oms: ReconciledOms, view: OrderTradeView, readsStartedAt: number): Promise<void> {
    for (const order of oms.orders()) {
      if (order.venueOrderId === null) continue;
      const venue = view.venueOrders.get(order.venueOrderId);
      if (venue === undefined) {
        // Read by id when open, when it has fills (a terminal execution stays in the comparison; E-14: the by-id
        // read finds canceled and fully matched orders), or when a source showed it: not found is a contradiction.
        const filled = compareDecimal(order.filledShares, "0") > 0;
        const shown = this.#evidence.order(order.venueOrderId)?.shown === true;
        if ((!TERMINAL_ORDER_STATES.has(order.state) || filled || shown) && view.missing.has(order.venueOrderId)) {
          this.#detect(run, {
            breakClass: "ORDER_STATE_MISMATCH",
            subjectKey: compositeKey("ORDER_STATE_MISMATCH", order.orderId),
            marketId: order.marketId,
            orderId: order.orderId,
            detail: `tracked ${order.state} order ${order.orderId} (${order.filledShares} filled): the venue does not find its venue order ${order.venueOrderId}`,
          });
        }
        // Not compared (and so not judged): a break that names it holds until a by-id read finds it again.
        continue;
      }
      // WP-270's OrderView carries no token: the order's group names it (`tokenOfGroup`). Unknown: not compared.
      const tokenId = this.#groupToken(order.executionGroupId);
      if (tokenId === null) {
        run.fillsUncompared = true;
        this.#detect(run, {
          breakClass: "COMPONENT_UNAVAILABLE",
          subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "group-token", order.executionGroupId),
          marketId: order.marketId,
          orderId: order.orderId,
          detail: `the token of execution group ${order.executionGroupId} is unknown: tracked order ${order.orderId} cannot be compared with the venue's`,
        });
        continue;
      }
      if (!sameOrderFacts(order, venue, tokenId)) {
        run.fillsUncompared = true;
        this.#detect(run, {
          breakClass: "ORDER_FACTS_MISMATCH",
          subjectKey: compositeKey("ORDER_FACTS_MISMATCH", order.orderId),
          marketId: order.marketId,
          orderId: order.orderId,
          detail: `tracked order ${order.orderId}: the venue's token, side, price or size differs from the order's`,
        });
        continue;
      }
      const venueOrderId = order.venueOrderId;
      if (OPEN_FOR_STATE_CHECK.has(order.state) && venue.status === "CANCELED") {
        this.#detect(run, {
          breakClass: "ORDER_STATE_MISMATCH",
          subjectKey: compositeKey("ORDER_STATE_MISMATCH", order.orderId),
          marketId: order.marketId,
          orderId: order.orderId,
          detail: `tracked order ${order.orderId} is ${order.state} in the OMS but CANCELED at the venue; routed to the OMS for an authoritative read`,
          act: async () => readOkFlag(await oms.requestOrderReconciliation(order.orderId)),
        });
      } else if (TERMINAL_ORDER_STATES.has(order.state) && !venueTerminal(venue)) {
        this.#detect(run, {
          breakClass: "ORDER_STATE_MISMATCH",
          subjectKey: compositeKey("ORDER_STATE_MISMATCH", order.orderId),
          marketId: order.marketId,
          orderId: order.orderId,
          detail: `tracked order ${order.orderId} is ${order.state} in the OMS but ${venue.status} at the venue; the observation reopens it in the OMS`,
          act: async () => readOkFlag(await oms.applyOrderObservation({ venueOrderId, status: venue.status })),
        });
      }
      await this.#compareFills(run, oms, order, venue, view.legsByOrder.get(venueOrderId) ?? [], readsStartedAt);
      // Compared in full: its state (where the state comparison covers it: an order mid-cancel or reconciling is
      // judged by a later run) and its fills. `#finalJudgements` also requires that nothing this run found names the
      // order (a state or fill discrepancy, an unverifiable fill: each names it).
      if (OPEN_FOR_STATE_CHECK.has(order.state) || TERMINAL_ORDER_STATES.has(order.state)) run.ordersComparedInFull.add(order.orderId);
    }
    // Venue orders and trades no tracked order owns: UNATTRIBUTED, unless an unresolved attempt could own them.
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    const owners = this.#potentialOwners(oms);
    for (const venue of view.venueOrders.values()) {
      if (claimed.has(venue.venueOrderId)) continue;
      const market = this.#marketOf(venue.tokenId);
      if (owners.some((owner) => couldBelong(venue, owner))) {
        this.#detect(run, {
          breakClass: "ORDER_UNRESOLVED",
          subjectKey: compositeKey("ORDER_UNRESOLVED", "venue-order", venue.venueOrderId),
          ...market,
          detail: `venue order ${venue.venueOrderId} is not tracked, and an unresolved attempt could own it`,
        });
        continue;
      }
      this.#detect(run, {
        breakClass: "ORDER_UNATTRIBUTED",
        subjectKey: compositeKey("ORDER_UNATTRIBUTED", venue.venueOrderId),
        ...market,
        assetId: venue.tokenId,
        observedValue: venue.sizeMatched,
        detail: `venue order ${venue.venueOrderId} (${venue.side} ${venue.originalSize} at ${venue.price}, ${venue.status}) is the account's, and no tracked order or unresolved attempt can own it: UNATTRIBUTED`,
      });
      const current = new Set<string>();
      for (const entry of view.legsByOrder.get(venue.venueOrderId) ?? []) {
        current.add(entry.trade.venueTradeId);
        this.#detect(run, {
          breakClass: "TRADE_UNATTRIBUTED",
          subjectKey: compositeKey("TRADE_UNATTRIBUTED", entry.trade.venueTradeId, venue.venueOrderId),
          ...market,
          assetId: entry.leg.tokenId,
          observedValue: entry.leg.shares,
          detail: `trade ${entry.trade.venueTradeId} (${entry.leg.side} ${entry.leg.shares} at ${entry.leg.price}) on untracked venue order ${venue.venueOrderId}: UNATTRIBUTED`,
        });
      }
      // Every trade the evidence holds on it too (r7, WP290-CX-R7-03): one an earlier read showed, or the stream named,
      // that this run's trades read does not show is unmatched activity all the same, under its own identity.
      for (const { venueTradeId, leg } of this.#evidence.legsOn(venue.venueOrderId)) {
        if (current.has(venueTradeId)) continue;
        this.#detect(run, {
          breakClass: "TRADE_UNATTRIBUTED",
          subjectKey: compositeKey("TRADE_UNATTRIBUTED", venueTradeId, venue.venueOrderId),
          ...market,
          assetId: leg.tokenId ?? venue.tokenId,
          observedValue: leg.shares,
          detail: `trade ${venueTradeId} (${leg.side ?? venue.side} ${leg.shares ?? "?"} at ${leg.price ?? "?"}) on untracked venue order ${venue.venueOrderId}, known from its evidence (this trades read does not show it): UNATTRIBUTED`,
        });
      }
    }
  }

  /**
   * EVERY HALT OBLIGATION THAT DOES NOT NEED A CONSISTENT VIEW OF THE VENUE (r6, class C), derived again in EVERY
   * run, whatever its soundness or staleness, from durable or authoritative state alone, so no obligation waits on
   * (or is lost to) a view the account may never get back. Each has its own durable identity, an occurrence (never
   * a hash of its detail), keyed per subject and per market:
   * - each halt obligation the LEDGER records (an UNATTRIBUTED arrival or an unexplained movement), keyed by its
   *   transaction, movement kind, asset, market and place among records equal in all four: one transaction touching
   *   N markets is N obligations, each halting its own market (a crash between a booking and its break included);
   * - each FAILED settlement the venue's trades read shows on a tracked order (ADR-006 §5), keyed by trade and order:
   *   each leg the row shows, and (r9) each leg the evidence holds of the trade that the row does not show (its
   *   ownership undetermined, legless or not: a settlement is the trade's);
   * - each OMS halting alert, keyed by the OMS instance's incarnation and the alert's ordinal (`#inspectAlerts`).
   *
   * The FAILED settlement: the OMS raises `SETTLEMENT_FAILED` only into its in-memory alert list, once, on the
   * transition into FAILED; a process that dies after the OMS recorded the FAILED settlement durably, but before this
   * coordinator journaled that alert, restarts with no alert (the restore replays the settlement silently, and a
   * repeated FAILED is idempotent). FAILED is "terminal failure" (`docs/venue/verified-2026-08-24.md`, the SDK's
   * `TradeStatus`; ADR-006 §5). That the account's trades read KEEPS showing a FAILED trade is an ASSUMPTION about the
   * read port (no document states how long the venue's trades history keeps a trade): on it, every run records this
   * quarantine again until an operator releases it (which acknowledges that one trade's failure for good). The
   * ledger's compensating reversal is a separate hold that only the ledger clears (`SETTLEMENT_REVERSAL_OWED`).
   */
  #haltObligations(run: RunState, oms: ReconciledOms, reads: RunReads): void {
    if (reads.projected.kind === "OK") {
      const subjects = this.#allBreakSubjects();
      if (subjects === undefined) {
        this.#detect(run, {
          breakClass: "COMPONENT_UNAVAILABLE",
          subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "journal"),
          detail: "the journal's breaks could not be read: the ledger's halt obligations cannot be matched to their breaks",
        });
      } else {
        const known = new Set(subjects);
        const places = new Map<string, number>();
        for (const arrival of reads.projected.value.arrivals) {
          const group = compositeKey(arrival.ledgerTransactionId, arrival.kind, arrival.assetId, arrival.marketId ?? "");
          const place = places.get(group) ?? 0;
          places.set(group, place + 1);
          const subjectKey = arrivalSubject(arrival.ledgerTransactionId, arrival.kind, arrival.assetId, arrival.marketId, place);
          if (known.has(subjectKey)) continue;
          this.#detect(run, {
            breakClass: "LEDGER_UNATTRIBUTED_ARRIVAL",
            subjectKey,
            ...this.#marketScope(arrival.marketId),
            assetId: arrival.assetId,
            observedValue: arrival.amount,
            detail: `the ledger records an ${arrival.kind} of ${arrival.amount} ${arrival.assetId} in market ${arrival.marketId ?? "(none: the account)"} (transaction ${arrival.ledgerTransactionId}, record ${String(place + 1)} of its kind, asset and market) that no break records`,
          });
        }
      }
    }
    if (reads.trades.kind === "OK") {
      const tracked = new Map(oms.orders().filter((order) => order.venueOrderId !== null).map((order) => [order.venueOrderId as string, order]));
      for (const trade of reads.trades.value) {
        if (tradeStatusOf(trade.status) !== "FAILED") continue;
        const shownOn = new Set<string>();
        for (const leg of trade.ownLegs) {
          shownOn.add(leg.venueOrderId);
          const order = tracked.get(leg.venueOrderId);
          if (order === undefined) continue;
          this.#detect(run, {
            breakClass: "SETTLEMENT_FAILED",
            subjectKey: compositeKey("SETTLEMENT_FAILED", trade.venueTradeId, leg.venueOrderId),
            ...this.#marketScope(order.marketId),
            orderId: order.orderId,
            assetId: leg.tokenId,
            observedValue: leg.shares,
            detail: `trade ${trade.venueTradeId} of tracked order ${order.orderId} (venue order ${leg.venueOrderId}, ${leg.side} ${leg.shares} at ${leg.price}) FAILED at the venue: the ledger owes a compensating reversal (ADR-006 §5)`,
          });
        }
        // (r9, WP290-V9-UNFOLDED-TERMINAL) A settlement is the TRADE's: every leg the evidence holds of it on a tracked
        // order FAILED too, one this row does not show included (its ownership undetermined, legless or not). Each is
        // the same gate, keyed by trade and order.
        for (const leg of this.#evidence.trade(trade.venueTradeId)?.legs ?? []) {
          if (shownOn.has(leg.venueOrderId)) continue;
          const order = tracked.get(leg.venueOrderId);
          if (order === undefined) continue;
          this.#detect(run, {
            breakClass: "SETTLEMENT_FAILED",
            subjectKey: compositeKey("SETTLEMENT_FAILED", trade.venueTradeId, leg.venueOrderId),
            ...this.#marketScope(order.marketId),
            orderId: order.orderId,
            assetId: leg.tokenId,
            observedValue: leg.shares,
            detail: `trade ${trade.venueTradeId} of tracked order ${order.orderId} FAILED at the venue; its leg on venue order ${leg.venueOrderId} (${leg.side ?? "?"} ${leg.shares ?? "?"} at ${leg.price ?? "?"}) is known from its evidence, and this read does not show it${trade.ownershipUndetermined ? " (the read could not establish which legs are the account's)" : ""}: the ledger owes a compensating reversal (ADR-006 §5)`,
          });
        }
      }
    }
    this.#inspectAlerts(run, oms);
  }

  /**
   * One tracked order's fills against the venue's trades, BY IDENTITY and with exact economics, both ways:
   * - every leg the OMS holds under its identity (`#probeFills`) must carry the OMS's exact economics;
   * - the OMS's recorded fill must equal the shares it holds under the venue's identities: more means it
   *   recorded fills the venue does not show under their ids (ORDER_FILLS_AHEAD_OF_VENUE, or FILL_MISMATCH
   *   when the venue shows trade ids the OMS did not record instead);
   * - only then are the legs it does not hold missing fills, and delivered (TRADE_MISSING_IN_OMS).
   * An order with any mismatch, unverifiable fee or refused probe gets no delivery, and holds.
   */
  async #compareFills(
    run: RunState,
    oms: ReconciledOms,
    order: OrderView,
    venue: VenueOrderView,
    legs: readonly { readonly leg: VenueTradeLeg; readonly trade: VenueTradeView; readonly status: VenueTradeStatus | null }[],
    readsStartedAt: number,
  ): Promise<void> {
    const venueOrderId = venue.venueOrderId;
    // A leg of an order that became tracked during this run (an answer named its venue order) is probed now.
    for (const entry of legs) await this.#probeLeg(run, oms, order, entry, readsStartedAt);
    const traded = sumShares(legs.map((entry) => entry.leg));
    if (compareDecimal(traded, venue.sizeMatched) < 0) {
      this.#detect(run, {
        breakClass: "ORDER_TRADES_INCOMPLETE",
        subjectKey: compositeKey("ORDER_TRADES_INCOMPLETE", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        expectedValue: venue.sizeMatched,
        observedValue: traded,
        detail: `tracked order ${order.orderId}: the venue matched more than its trades show`,
      });
    }
    const probed = (entry: (typeof legs)[number]): "KNOWN" | "UNKNOWN" | undefined => run.fillProbe.get(compositeKey(entry.trade.venueTradeId, venueOrderId));
    const known = legs.filter((entry) => probed(entry) === "KNOWN");
    const unknown = legs.filter((entry) => probed(entry) === "UNKNOWN");
    // Every leg was probed above: each is KNOWN or UNKNOWN, or its order is unverified with a break recorded.
    let verified = !run.unverifiedOrders.has(order.orderId) && known.length + unknown.length === legs.length;
    for (const entry of known) if (!(await this.#verifyEconomics(run, oms, order, entry))) verified = false;
    if (!verified) return;
    const held = sumShares(known.map((entry) => entry.leg));
    const comparison = compareDecimal(order.filledShares, held);
    if (comparison !== 0) {
      // More: the OMS recorded fills the venue does not show under their ids; the read lags (ORDER_FILLS_AHEAD_OF_
      // VENUE), unless the venue shows trade ids the OMS did not record instead (FILL_MISMATCH). Less cannot happen
      // (each fill held was verified equal to a leg); it would be a mismatch too.
      const lagging = comparison > 0 && unknown.length === 0;
      this.#detect(run, {
        breakClass: lagging ? "ORDER_FILLS_AHEAD_OF_VENUE" : "FILL_MISMATCH",
        subjectKey: compositeKey(lagging ? "ORDER_FILLS_AHEAD_OF_VENUE" : "FILL_MISMATCH", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        expectedValue: order.filledShares,
        observedValue: held,
        detail: lagging
          ? `tracked order ${order.orderId}: the OMS recorded more fill than the venue's trades show under the OMS's trade ids`
          : `tracked order ${order.orderId}: the OMS's fills and the venue's trades differ by trade id (it recorded ${order.filledShares}; the venue shows ${held} of it under the same ids, and trades it did not record); nothing is delivered`,
      });
      return;
    }
    // The OMS's fills are exactly the legs it holds: the others are fills it missed.
    if (unknown.length === 0) return;
    if (unknown.some((entry) => entry.leg.feeAmount === null)) {
      this.#detect(run, {
        breakClass: "FILL_ECONOMICS_UNFIXED",
        subjectKey: compositeKey("FILL_ECONOMICS_UNFIXED", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        expectedValue: traded,
        observedValue: order.filledShares,
        detail: `tracked order ${order.orderId}: a missing fill's exact fee is not known; it is not booked with a guess`,
      });
      return;
    }
    this.#detect(run, {
      breakClass: "TRADE_MISSING_IN_OMS",
      subjectKey: compositeKey("TRADE_MISSING_IN_OMS", order.orderId),
      marketId: order.marketId,
      orderId: order.orderId,
      expectedValue: traded,
      observedValue: order.filledShares,
      detail: `tracked order ${order.orderId}: the venue's trades show fills the OMS had not recorded; delivered`,
      act: async () => this.#deliverFills(run, oms, order, unknown),
    });
  }

  /**
   * A leg the OMS holds a fill for, offered with the leg's exact facts: the OMS answers OK only when every fact
   * of its record is the same (`recordFill`'s de-duplication), and refuses a difference (`OMS_FILL_CONFLICT`,
   * with its own halting alert). `true` when verified equal.
   */
  async #verifyEconomics(
    run: RunState,
    oms: ReconciledOms,
    order: OrderView,
    entry: { readonly leg: VenueTradeLeg; readonly trade: VenueTradeView },
  ): Promise<boolean> {
    const { leg, trade } = entry;
    if (leg.feeAmount === null) {
      this.#detect(run, {
        breakClass: "FILL_ECONOMICS_UNFIXED",
        subjectKey: compositeKey("FILL_ECONOMICS_UNFIXED", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        detail: `tracked order ${order.orderId}: the read does not fix trade ${trade.venueTradeId}'s fee, so the fill the OMS recorded cannot be verified`,
      });
      return false;
    }
    const facts = [trade.venueTradeId, leg.venueOrderId, leg.shares, leg.price, leg.feeAmount, leg.feeAssetId ?? "", leg.role, leg.matchedAt];
    const conflict = compositeKey("fill", ...facts);
    let code: string | null = "OMS_FILL_CONFLICT";
    if (!this.#knownConflicts.has(conflict)) {
      // The run-validity latch: the comparison offers the fill to the OMS, a write if the OMS did not hold it.
      if (!this.#mayCommit(run)) return false;
      let result: unknown;
      try {
        result = await oms.recordFill(fillReportOf(leg, trade));
      } catch {
        result = undefined;
      }
      code = readOkFlag(result) ? null : readRefusalCode(result);
    }
    if (code === null) return true;
    if (code === "OMS_FILL_CONFLICT") {
      this.#rememberConflict(conflict);
      this.#detect(run, {
        breakClass: "FILL_MISMATCH",
        subjectKey: compositeKey("FILL_MISMATCH", order.orderId),
        marketId: order.marketId,
        orderId: order.orderId,
        detail: `tracked order ${order.orderId}: trade ${trade.venueTradeId} is recorded in the OMS with other economics (shares, price, fee, role or match time) than the venue's`,
      });
      return false;
    }
    this.#detect(run, {
      breakClass: "FILL_REFUSED",
      subjectKey: compositeKey("FILL_REFUSED", "fill", trade.venueTradeId, leg.venueOrderId),
      marketId: order.marketId,
      orderId: order.orderId,
      detail: `the OMS refused to compare trade ${trade.venueTradeId}'s fill of order ${order.orderId}: ${code}`,
    });
    return false;
  }

  #rememberConflict(key: string): void {
    if (this.#knownConflicts.size < MAX_KNOWN_CONFLICTS) this.#knownConflicts.add(key);
  }

  /**
   * Deliver an order's legs as fills (the OMS de-duplicates identical facts). `true` when every one was accepted.
   * A delivery the OMS refused as a contradiction (`OMS_FILL_INCONSISTENT`, `OMS_FILL_CONFLICT`: each refusal raises
   * its own halting alert, and each alert is its own quarantine) is not offered again in this process; it still
   * holds (FILL_REFUSED). Any other refusal (a store or id-source failure) is offered again by the next run.
   */
  async #deliverFills(
    run: RunState,
    oms: ReconciledOms,
    order: OrderView,
    legs: readonly { readonly leg: VenueTradeLeg; readonly trade: VenueTradeView }[],
  ): Promise<boolean> {
    let all = true;
    for (const { leg, trade } of legs) {
      const contradiction = compositeKey("delivery", trade.venueTradeId, leg.venueOrderId, leg.shares, leg.price, leg.feeAmount ?? "", leg.feeAssetId ?? "", leg.role, leg.matchedAt);
      let code: string | null = "OMS_REFUSED_BEFORE";
      if (!this.#knownConflicts.has(contradiction)) {
        // The run-validity latch before EVERY delivery (r6, WP290-CX-R6-02): a fault detected while an earlier fill
        // of this act was being delivered stops the rest; the break stays open for a fresh run.
        if (!this.#mayCommit(run)) return false;
        let result: unknown;
        try {
          result = await oms.recordFill(fillReportOf(leg, trade));
        } catch {
          result = undefined;
        }
        code = readOkFlag(result) ? null : readRefusalCode(result);
        if (code === "OMS_FILL_INCONSISTENT" || code === "OMS_FILL_CONFLICT") this.#rememberConflict(contradiction);
      }
      if (code !== null) {
        all = false;
        this.#detect(run, {
          breakClass: "FILL_REFUSED",
          subjectKey: compositeKey("FILL_REFUSED", "fill", trade.venueTradeId, leg.venueOrderId),
          marketId: order.marketId,
          orderId: order.orderId,
          detail:
            code === "OMS_REFUSED_BEFORE"
              ? `the OMS refused trade ${trade.venueTradeId}'s fill of order ${order.orderId} as a contradiction; it is not offered again in this process`
              : `the OMS refused trade ${trade.venueTradeId}'s fill of order ${order.orderId}: ${code}`,
        });
      }
    }
    // Every missed fill accepted: the OMS now holds exactly what the venue showed (a positive judgement of the break).
    if (all) run.positive.add(compositeKey("TRADE_MISSING_IN_OMS", order.orderId));
    return all;
  }

  // ---- holdings -------------------------------------------------------------------------------

  async #compareHoldings(run: RunState, oms: ReconciledOms, view: OrderTradeView, reads: RunReads, readsStartedAt: number): Promise<void> {
    if (reads.positions.kind !== "OK" || reads.collateral.kind !== "OK" || reads.projected.kind !== "OK" || reads.approvals.kind !== "OK" || reads.bookings.kind !== "OK") {
      return;
    }
    const bookings = reads.bookings.value;
    const projected = reads.projected.value;
    const policy = this.#deps.policy;
    for (const spender of policy.requiredApprovalSpenders) {
      if (reads.approvals.value.get(spender) === true) run.positive.add(compositeKey("APPROVAL_MISSING", spender));
      if (reads.approvals.value.get(spender) !== true) {
        this.#detect(run, {
          breakClass: "APPROVAL_MISSING",
          subjectKey: compositeKey("APPROVAL_MISSING", spender),
          detail: `the approvals read does not show spender ${spender} approved`,
        });
      }
    }
    if (this.#walletInFlight()) {
      this.#detect(run, {
        breakClass: "WALLET_OPERATION_IN_FLIGHT",
        subjectKey: compositeKey("WALLET_OPERATION_IN_FLIGHT", "holdings"),
        detail: "holdings were not judged: a wallet operation is in flight, reconciling or quarantined",
      });
      return;
    }
    run.positive.add(compositeKey("WALLET_OPERATION_IN_FLIGHT", "holdings"));
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    const inTransit: { readonly leg: VenueTradeLeg; readonly attributed: boolean }[] = [];
    const stillBooked: BookedAmount[] = [];
    for (const [id, legs] of view.legsByOrder) {
      for (const entry of legs) {
        // CONFIRMED is settled; MATCHED, MINED, RETRYING are in transit.
        if (entry.status === "CONFIRMED") continue;
        if (entry.status !== "FAILED") {
          inTransit.push({ leg: entry.leg, attributed: claimed.has(id) });
          continue;
        }
        // FAILED (r4, WP290-CX-R4-02): the chain never moved, and the ledger books the fill until a linked
        // compensating reversal cancels it (ADR-006 §5). What it STILL books is the only difference this fill
        // explains: a fully reversed fill explains nothing, never its nominal delta. While any of it remains, the
        // reversal is owed, and the account holds, whatever an operator released (a release is not a booking).
        const remaining = bookings.get(compositeKey(entry.trade.venueTradeId, entry.leg.venueOrderId));
        if (remaining === undefined) {
          // Unreachable (the door refuses an answer that leaves an asked fill out); fail closed regardless.
          inTransit.push({ leg: entry.leg, attributed: false });
          continue;
        }
        if (remaining.length === 0) {
          // Nothing of the fill is booked any more, read in this very run: the reversal is no longer owed.
          if (run.tradeVerdicts.get(entry.trade.venueTradeId)?.kind === "CONSISTENT") {
            run.positive.add(compositeKey("SETTLEMENT_REVERSAL_OWED", entry.trade.venueTradeId, entry.leg.venueOrderId));
          }
          continue;
        }
        stillBooked.push(...remaining);
        const tracked = oms.orders().find((order) => order.venueOrderId === id);
        this.#detect(run, {
          breakClass: "SETTLEMENT_REVERSAL_OWED",
          subjectKey: compositeKey("SETTLEMENT_REVERSAL_OWED", entry.trade.venueTradeId, entry.leg.venueOrderId),
          ...(tracked === undefined ? this.#marketOf(entry.leg.tokenId) : this.#marketScope(tracked.marketId)),
          orderId: tracked?.orderId ?? null,
          assetId: entry.leg.tokenId,
          observedValue: entry.leg.shares,
          detail: `trade ${entry.trade.venueTradeId} (venue order ${entry.leg.venueOrderId}) FAILED at the venue, and the ledger still books ${remaining.map((amount) => `${amount.amount} ${amount.assetId}`).join(", ")} of its fill: the compensating reversal is owed (ADR-006 §5); held until the ledger books it`,
        });
      }
    }
    const pending = pendingDeltas(inTransit, policy.collateralAssetId, stillBooked);
    run.holdingsJudged = true;
    // Compared: every outcome token (positions) and the policy's collateral. Another collateral-kind asset (e.g. USDC.e
    // after an unwrap) has no read here, so it is not judged (a known limit, in the handoff).
    const tokens = [...projected.lines].filter(([, line]) => line.assetKind === "OUTCOME_TOKEN").map(([assetId]) => assetId);
    // Every asset an unresolved holding break names is judged too (one the reads no longer list reads as 0).
    const held = (this.#unresolvedBreaks() ?? [])
      .filter((view) => JUDGED_WITH_HOLDINGS.includes(view.breakClass) && view.assetId !== null && isTokenId(view.assetId))
      .map((view) => view.assetId as string);
    const assets = new Set<string>([...tokens, ...reads.positions.value.keys(), policy.collateralAssetId, ...held]);
    for (const assetId of [...assets].sort()) {
      const isCollateral = assetId === policy.collateralAssetId;
      const authoritative = isCollateral ? reads.collateral.value : reads.positions.value.get(assetId) ?? "0";
      const line = projected.lines.get(assetId);
      const verdict = compareHolding(authoritative, line?.balance ?? "0", pending.get(assetId));
      if (verdict.kind === "MATCH" || verdict.kind === "MATCH_IN_TRANSIT") {
        this.#unexplained.delete(assetId);
        // A positive judgement of every holding subject of this asset.
        for (const breakClass of ["HOLDING_IN_TRANSIT_AMBIGUOUS", "HOLDING_DELTA_UNCONFIRMED", "CORRECTION_FAILED"] as const) run.positive.add(compositeKey(breakClass, assetId));
        continue;
      }
      const market = isCollateral ? { scope: "ACCOUNT" as const, marketId: null } : this.#marketOf(assetId);
      if (verdict.kind === "IN_TRANSIT_AMBIGUOUS") {
        this.#unexplained.delete(assetId);
        this.#detect(run, {
          breakClass: "HOLDING_IN_TRANSIT_AMBIGUOUS",
          subjectKey: compositeKey("HOLDING_IN_TRANSIT_AMBIGUOUS", assetId),
          ...market,
          assetId,
          expectedValue: line?.balance ?? "0",
          observedValue: authoritative,
          detail: `${assetId}: the holding differs from its projection by ${verdict.delta} while trades in it are unsettled`,
        });
        continue;
      }
      const seen = this.#unexplained.get(assetId);
      if (seen === undefined || compareDecimal(seen.delta, verdict.delta) !== 0) {
        this.#unexplained.set(assetId, Object.freeze({ delta: verdict.delta, firstSeenAtMs: readsStartedAt }));
        this.#detect(run, {
          breakClass: "HOLDING_DELTA_UNCONFIRMED",
          subjectKey: compositeKey("HOLDING_DELTA_UNCONFIRMED", assetId),
          ...market,
          assetId,
          expectedValue: line?.balance ?? "0",
          observedValue: authoritative,
          detail: `${assetId}: an unexplained delta of ${verdict.delta}, seen once; booked only if a later read confirms it`,
        });
        continue;
      }
      // A delta an unresolved attempt could explain (its fill, not yet visible) does not lack attribution: it is not
      // yet known. It is held, never booked, while such an attempt exists (any attempt moves the collateral).
      const explainers = this.#potentialOwners(oms).filter((owner) => isCollateral || owner.facts === null || owner.facts.tokenId === assetId);
      if (explainers.length > 0) {
        this.#detect(run, {
          breakClass: "HOLDING_DELTA_UNCONFIRMED",
          subjectKey: compositeKey("HOLDING_DELTA_UNCONFIRMED", assetId),
          ...market,
          assetId,
          expectedValue: line?.balance ?? "0",
          observedValue: authoritative,
          detail: `${assetId}: an unexplained delta of ${verdict.delta} that unresolved attempt ${explainers[0]?.attemptId ?? "?"} could explain; not booked while it is unresolved`,
        });
        continue;
      }
      if (readsStartedAt - seen.firstSeenAtMs < policy.holdingConfirmationMs) {
        this.#detect(run, {
          breakClass: "HOLDING_DELTA_UNCONFIRMED",
          subjectKey: compositeKey("HOLDING_DELTA_UNCONFIRMED", assetId),
          ...market,
          assetId,
          expectedValue: line?.balance ?? "0",
          observedValue: authoritative,
          detail: `${assetId}: an unexplained delta of ${verdict.delta}, not yet confirmed (${String(policy.holdingConfirmationMs)} ms)`,
        });
        continue;
      }
      await this.#bookUnattributed(run, assetId, isCollateral, line?.assetKind, verdict.delta, line?.balance ?? "0", authoritative, readsStartedAt);
    }
  }

  async #bookUnattributed(
    run: RunState,
    assetId: string,
    isCollateral: boolean,
    projectedKind: "COLLATERAL" | "OUTCOME_TOKEN" | undefined,
    delta: DecimalString,
    projected: DecimalString,
    authoritative: DecimalString,
    atMs: number,
  ): Promise<void> {
    const assetKind = isCollateral ? "COLLATERAL" : projectedKind ?? "OUTCOME_TOKEN";
    const market = isCollateral ? { scope: "ACCOUNT" as const, marketId: null } : this.#marketOf(assetId);
    // Nothing is booked while any venue object this run judged is a conflict, or any order with evidence went
    // unjudged (the evidence store's verdicts: a sound, complete run never has one; defence in depth).
    if (!this.#evidenceJudged(run)) {
      this.#detect(run, {
        breakClass: "HOLDING_DELTA_UNCONFIRMED",
        subjectKey: compositeKey("HOLDING_DELTA_UNCONFIRMED", assetId),
        ...market,
        assetId,
        expectedValue: projected,
        observedValue: authoritative,
        detail: `${assetId}: an unexplained delta of ${delta}, not booked: venue evidence this run could not judge may explain it`,
      });
      return;
    }
    // The run-validity latch (r5, r6): nothing is booked once a clock fault is detected in this run: the
    // confirmation time was measured by the faulted clock. The delta stays unconfirmed (a hold); a later run books it.
    if (!this.#mayCommit(run)) {
      this.#detect(run, {
        breakClass: "HOLDING_DELTA_UNCONFIRMED",
        subjectKey: compositeKey("HOLDING_DELTA_UNCONFIRMED", assetId),
        ...market,
        assetId,
        expectedValue: projected,
        observedValue: authoritative,
        detail: `${assetId}: an unexplained delta of ${delta}, not booked: the clock was unreadable or went backwards during the run`,
      });
      return;
    }
    const ledgerTransactionId = this.#drawId();
    const failedBooking = (why: string): void =>
      this.#detect(run, {
        breakClass: "CORRECTION_FAILED",
        subjectKey: compositeKey("CORRECTION_FAILED", assetId),
        ...market,
        assetId,
        expectedValue: projected,
        observedValue: authoritative,
        detail: `${assetId}: the UNATTRIBUTED correction of ${delta} was not booked: ${why}`,
      });
    if (ledgerTransactionId === undefined) return failedBooking("the id source gave no fresh UUIDv7");
    if (!isCollateral && market.marketId === null) {
      // An outcome token of an unknown market cannot be booked with its market; the account is halted instead.
      return failedBooking("the token's market is unknown");
    }
    let booked = false;
    try {
      booked = readOkFlag(
        await this.#deps.holdings.bookUnattributed({
          ledgerTransactionId,
          reconciliationRunId: run.runId,
          assetId,
          assetKind,
          marketId: market.marketId,
          delta,
          occurredAtMs: atMs,
        }),
      );
    } catch {
      booked = false;
    }
    if (!booked) return failedBooking("the ledger refused it or did not confirm it");
    this.#unexplained.delete(assetId);
    this.#detect(run, {
      breakClass: isCollateral ? "BALANCE_UNATTRIBUTED" : "POSITION_UNATTRIBUTED",
      // The one ACTUAL_ARRIVAL this correction records (its one UNATTRIBUTED entry): the subject the recovery derives.
      subjectKey: arrivalSubject(ledgerTransactionId, "ACTUAL_ARRIVAL", assetId, market.marketId, 0),
      ...market,
      assetId,
      expectedValue: projected,
      observedValue: authoritative,
      detail: `${assetId}: a confirmed delta of ${delta} no activity explains, booked to UNATTRIBUTED (ledger transaction ${ledgerTransactionId})`,
      ledgerTransactionId,
    });
  }

  // ---- wallet operations ----------------------------------------------------------------------

  async #answerWalletRequests(
    run: RunState,
    answerable: readonly Received<WalletReconciliationRequest>[],
    members: ReadonlyMap<string, ReadOutcome<WalletMemberRead>>,
  ): Promise<void> {
    const wallet = this.#wallet;
    if (wallet !== null || answerable.length === 0) run.positive.add(compositeKey("COMPONENT_UNAVAILABLE", "wallet-operations"));
    for (const received of answerable) {
      const request = received.request;
      run.walletOperationsChecked += 1;
      if (wallet === null) {
        this.#detect(run, {
          breakClass: "COMPONENT_UNAVAILABLE",
          subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "wallet-operations"),
          detail: "a wallet-operation request arrived but no wallet-operation manager is bound",
        });
        continue;
      }
      let unanswered = 0;
      const names = walletMembersOf(request);
      if (names.length === 0) {
        // It never named a transaction: nothing exists to read by name, and an answer naming none would conclude
        // FAILED, which no read can establish (the executor may have sent it). Never answered automatically.
        unanswered += 1;
        this.#detect(run, {
          breakClass: "WALLET_OPERATION_UNIDENTIFIABLE",
          subjectKey: compositeKey("WALLET_OPERATION_UNIDENTIFIABLE", request.walletOperationId),
          walletOperationId: isUuidV7(request.walletOperationId) ? request.walletOperationId : null,
          detail: `wallet operation ${request.walletOperationId} never named a transaction: nothing can be read by name`,
        });
      }
      for (const member of names) {
        const parsed = parseMember(member);
        if (parsed === null) {
          unanswered += 1;
          this.#detect(run, {
            breakClass: "WALLET_OPERATION_UNIDENTIFIABLE",
            subjectKey: compositeKey("WALLET_OPERATION_UNIDENTIFIABLE", request.walletOperationId),
            walletOperationId: isUuidV7(request.walletOperationId) ? request.walletOperationId : null,
            detail: `wallet operation ${request.walletOperationId} never named a transaction (member ${member}): nothing can be read by name`,
          });
          continue;
        }
        const outcome = members.get(member);
        const read = outcome?.kind === "OK" ? outcome.value : null;
        if (read === null || (read.state !== "CONFIRMED" && read.state !== "FAILED")) {
          unanswered += 1;
          const unreadable = outcome === undefined || outcome.kind === "FAILED" || read?.state === "UNSUPPORTED";
          this.#detect(run, {
            breakClass: unreadable ? "WALLET_MEMBER_UNREADABLE" : "WALLET_MEMBER_PENDING",
            subjectKey: compositeKey(unreadable ? "WALLET_MEMBER_UNREADABLE" : "WALLET_MEMBER_PENDING", request.walletOperationId, member),
            walletOperationId: isUuidV7(request.walletOperationId) ? request.walletOperationId : null,
            detail: unreadable
              ? `wallet operation ${request.walletOperationId}: member ${member} could not be read`
              : `wallet operation ${request.walletOperationId}: member ${member} is not terminal (${read?.state ?? "an unrecognised report"}); not answered`,
          });
          continue;
        }
        // (r11, the class fix) Every observation of this member, an unusable answer's included (its state and amount
        // validated on their own), must agree: the other terminal state, or another amount credited by a CONFIRMED
        // member, is a durable contradiction (which is the chain's is unknown): never answered.
        const held = this.#evidence.memberEvidence(member);
        const contradiction =
          held === undefined
            ? undefined
            : held.terminals.length > 1
              ? `observations showed it both ${held.terminals.join(" and ")}`
              : read.state === "CONFIRMED" && held.credited.length > 1
                ? `observations showed it credited ${held.credited.join(" and ")}`
                : undefined;
        if (contradiction !== undefined) {
          unanswered += 1;
          this.#detect(run, {
            breakClass: "READ_CONFLICT",
            subjectKey: compositeKey("READ_CONFLICT", "wallet-member", member),
            walletOperationId: isUuidV7(request.walletOperationId) ? request.walletOperationId : null,
            detail: `wallet operation ${request.walletOperationId}: member ${member}: ${contradiction}: which is the chain's is unknown, so it is not answered`,
          });
          continue;
        }
        if (parsed.kind === "HASH" && read.transactionHash !== null && read.transactionHash !== parsed.value) {
          unanswered += 1;
          this.#detect(run, {
            breakClass: "WALLET_MEMBER_PENDING",
            subjectKey: compositeKey("WALLET_MEMBER_PENDING", request.walletOperationId, member),
            walletOperationId: isUuidV7(request.walletOperationId) ? request.walletOperationId : null,
            detail: `wallet operation ${request.walletOperationId}: the read for member ${member} named another transaction; not answered`,
          });
          continue;
        }
        // (r5, WP290-CX-R5-02) No answer once a clock fault is detected in this run: a later run answers the member.
        if (!this.#mayCommit(run)) {
          unanswered += 1;
          continue;
        }
        // By name: the member itself is the identity the answer carries (WP-300 follow_up 3).
        const answer: Record<string, unknown> = {
          source: "AUTHORITATIVE_READ",
          requestId: request.requestId,
          state: read.state,
          transactionHash: parsed.kind === "HASH" ? parsed.value : read.transactionHash,
          transactionId: parsed.kind === "RELAYER_ID" ? parsed.value : null,
        };
        if (read.credited !== null) answer["credited"] = read.credited;
        let result: unknown;
        try {
          result = wallet.resolveByReconciliation(request.walletOperationId, Object.freeze(answer));
        } catch {
          result = undefined;
        }
        const accepted = readOkFlag(result);
        const code = accepted ? null : readRefusalCode(result);
        await this.#recordAnswer(run, "WALLET_OPERATION", request.requestId, request.walletOperationId, read.state, accepted, code);
        // The member answered by name and accepted: a positive judgement of every hold about that member.
        if (accepted) for (const breakClass of WALLET_MEMBER_CLASSES) run.positive.add(compositeKey(breakClass, request.walletOperationId, member));
        if (!accepted) {
          unanswered += 1;
          this.#detect(run, {
            breakClass: "WALLET_ANSWER_REFUSED",
            subjectKey: compositeKey("WALLET_ANSWER_REFUSED", request.walletOperationId, member),
            walletOperationId: isUuidV7(request.walletOperationId) ? request.walletOperationId : null,
            detail: `the inventory refused the ${read.state} answer for member ${member}: ${code ?? "UNREADABLE"}`,
          });
        }
      }
      // Answered in full: the inventory concludes, or issues a fresh request, which replaces this one.
      const latest = this.#walletRequests.get(request.walletOperationId);
      if (unanswered === 0 && latest !== undefined && latest.request.requestId === request.requestId) this.#walletRequests.delete(request.walletOperationId);
    }
  }

  #inspectWallet(run: RunState): void {
    const wallet = this.#wallet;
    const unsettled = wallet === null ? [] : this.#unsettledWalletOperations();
    for (const operationId of unsettled) {
      this.#detect(run, {
        breakClass: "WALLET_OPERATION_UNSETTLED",
        subjectKey: compositeKey("WALLET_OPERATION_UNSETTLED", operationId),
        walletOperationId: isUuidV7(operationId) ? operationId : null,
        detail: `wallet operation ${operationId} is unknown, reconciling or quarantined in the inventory (or, r13, its state or its quarantine flag could not be read)`,
      });
    }
    // The wallet-scoped holds this inspection judges: an operation the inventory no longer holds unsettled (its
    // events readable), and a member hold whose operation no longer has a request pending.
    const readable = !unsettled.includes(UNREADABLE_WALLET_EVENTS);
    for (const view of this.#unresolvedBreaks() ?? []) {
      const parts = decodeCompositeKey(view.subjectKey);
      if (parts === undefined || parts[0] !== view.breakClass || parts[1] === undefined) continue;
      if (view.breakClass === "WALLET_OPERATION_UNSETTLED" && parts.length === 2 && readable && !unsettled.includes(parts[1])) run.positive.add(view.subjectKey);
      if (WALLET_MEMBER_CLASSES.includes(view.breakClass) && parts.length === 3 && !this.#walletRequests.has(parts[1])) run.positive.add(view.subjectKey);
    }
  }

  /**
   * (r13, the closed-vocabulary audit) The inventory's append-only events, read once: each operation's latest state,
   * and whether any event could not be read. An events answer that is not a list, an event that is not own data, or
   * one whose operation id or state is not text, is UNREADABLE (never skipped: a skipped event could be an
   * operation's latest step); a state outside WP-300's closed vocabulary ({@link RECONCILED_WALLET_OPERATION_STATES})
   * is kept as read, and judged unsettled and in flight by both callers, never settled.
   */
  #walletEvents(wallet: ReconciledWalletOperations): { readonly latest: ReadonlyMap<string, string>; readonly unreadable: boolean } {
    const latest = new Map<string, string>();
    let events: readonly unknown[] | undefined;
    try {
      events = readArray(wallet.events(), 10_000_000);
    } catch {
      events = undefined;
    }
    if (events === undefined) return { latest, unreadable: true };
    let unreadable = false;
    for (const event of events) {
      const fields = readFields(event, ["operationId", "newState"]);
      if (fields === undefined || typeof fields.operationId !== "string" || typeof fields.newState !== "string") {
        unreadable = true;
        continue;
      }
      latest.set(fields.operationId, fields.newState);
    }
    return { latest, unreadable };
  }

  /**
   * Operations in UNKNOWN or RECONCILING, or quarantined (from the inventory's append-only events). (r13) Also an
   * operation whose latest state is outside WP-300's vocabulary, or whose view does not say, as own data, that it is
   * NOT quarantined (`quarantined: false`); and, when any event could not be read, the events themselves.
   */
  #unsettledWalletOperations(): string[] {
    const wallet = this.#wallet;
    if (wallet === null) return [];
    const { latest, unreadable } = this.#walletEvents(wallet);
    const out: string[] = unreadable ? [UNREADABLE_WALLET_EVENTS] : [];
    for (const [operationId, state] of latest) {
      let quarantined: boolean;
      try {
        const flag = readField(wallet.operation(operationId), "quarantined");
        quarantined = !(flag.kind === "DATA" && flag.value === false);
      } catch {
        quarantined = true;
      }
      if (!isWalletOperationState(state) || state === "UNKNOWN" || state === "RECONCILING" || quarantined) out.push(operationId);
    }
    return out;
  }

  /**
   * Any wallet operation whose holdings effect is not settled: in flight, unknown, reconciling, or quarantined. (r13)
   * Events that could not be read, and a state outside WP-300's vocabulary, are unsettled
   * ({@link #unsettledWalletOperations}), so in flight too (fail closed).
   */
  #walletInFlight(): boolean {
    const wallet = this.#wallet;
    if (wallet === null) return false;
    for (const state of this.#walletEvents(wallet).latest.values()) if (state === "SUBMITTED" || state === "MINED" || state === "UNKNOWN" || state === "RECONCILING") return true;
    return this.#unsettledWalletOperations().length > 0;
  }

  // ---- the user stream ------------------------------------------------------------------------

  /**
   * Acknowledge, by id, every stream request this run's complete reads answer, and record each acknowledgement
   * in the journal like every other answer (WP-280's manager keeps its backlog in memory only: the journal is
   * the durable record that a request was answered, and by which run).
   */
  async #acknowledgeStreamRequests(run: RunState, answerable: readonly ReceivedStreamRequest[]): Promise<void> {
    const stream = this.#stream;
    for (const received of answerable) {
      // (r5, WP290-CX-R5-02) No acknowledgement once a clock fault is detected in this run: the request stays owed.
      if (!this.#mayCommit(run)) return;
      // (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) A request that named the account's activity is acknowledged only by
      // a run that judged every identity it named: until then it stays owed (and holds the account).
      if (!this.#streamRequestDischarged(run, received.named)) continue;
      const requestId = received.request.requestId;
      let accepted = false;
      try {
        accepted = stream !== null && stream.acknowledgeReconciliationRequest(requestId) === true;
      } catch {
        accepted = false;
      }
      this.#streamRequests.delete(requestId);
      // The journal's subject is an identifier (at most 200 characters); a longer request id stands in the request id only.
      const subjectId = isIdentifier(requestId) ? requestId : "user-stream";
      await this.#recordAnswer(run, "USER_STREAM", requestId, subjectId, "ACKNOWLEDGED", accepted, accepted ? null : "STREAM_UNKNOWN_REQUEST");
    }
  }

  /**
   * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) Whether this run judged every identity a stream request named: each
   * trade without a conflict (the store's verdict, against this run's complete trades read and all the evidence: its
   * identity answered, its status ordered or terminal, its legs accounted for); each order CONSISTENT, ACKNOWLEDGED, or
   * settled by an earlier sound run. A request one of whose identities could not be read never is.
   */
  #streamRequestDischarged(run: RunState, named: StreamRequestSubjects): boolean {
    if (named.unreadable) return false;
    for (const tradeId of named.trades) {
      const verdict = run.tradeVerdicts.get(tradeId);
      if (verdict === undefined || verdict.kind === "CONFLICT") return false;
    }
    for (const orderId of named.orders) {
      const verdict = run.verdicts.get(orderId);
      if (verdict?.kind === "CONSISTENT" || verdict?.kind === "ACKNOWLEDGED") continue;
      if (verdict === undefined && this.#evidence.order(orderId)?.settled === true) continue;
      return false;
    }
    return true;
  }

  #pullStreamRequests(): void {
    const stream = this.#stream;
    if (stream === null) return;
    let pending: readonly unknown[] | undefined;
    try {
      pending = readArray(stream.pendingReconciliationRequests(), 1_000_000);
    } catch {
      pending = undefined;
    }
    if (pending === undefined) {
      this.#receiveMalformed("user-stream", "the stream's request backlog could not be read", "USER_STREAM_RECONNECT");
      return;
    }
    for (const request of pending) {
      const id = readField(request, "requestId");
      if (id.kind === "DATA" && typeof id.value === "string" && this.#streamRequests.has(id.value)) continue;
      this.#receiveStreamRequest(request);
    }
  }

  #enqueueStream(output: unknown): void {
    this.#streamChain = this.#streamChain.then(() => this.#routeStream(output)).catch(() => undefined);
  }

  /**
   * Route one ORDER or TRADE output to the OMS, in order. EVERY item the OMS did not apply, whatever its answer (a
   * retention; a refusal as unknown, inconsistent or contradicting; a store failure that faulted it; a fault already
   * standing; an input or id-source refusal; an unknown fill; a throw), and every item routed while no OMS is bound,
   * is the coordinator's to keep (r6 class A; r7, WP290-V7-STREAM-REFUSAL-DROPPED): recorded in the evidence store and
   * journaled at once, so neither a later lagging read, nor a restart, nor an OMS reopened and bound again forgets it.
   * Each such item triggers a run. Evidence the OMS applied is the OMS's own durable record (its fills, settlements
   * and states).
   *
   * (r11, the stream door) The output is read once (`door.ts`, `readStreamOutput`): every item of every list is routed,
   * whatever its siblings (a list one entry of which is not own data no longer drops the others), and every item the
   * OMS did not apply keeps EVERY fragment it validated (`#streamRecords`): an item whose shares are inexact still
   * names its trade and order. Every entry or list present but unreadable is an UNREADABLE obligation of the account.
   * (r12, WP290-CX-R12-01) So is a projection key that is MISSING (an ORDER's `observation`, a TRADE's `fills` or
   * `settlements`): the door names it unreadable, so it is journaled here as an obligation and a run is triggered.
   *
   * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) What the output's EVENT named is journaled here too, whatever the
   * projection carried (`streamEventRecords`): an order event's order (NAMED, with the facts the event stated: it is read
   * by id until a sound run settles it, so an unknown attempt is never answered ABSENT while it stands); a trade event's
   * trade (its identity OPEN until a valid row shows its own legs in full; `unordered` when its status cannot be
   * ordered) and each leg the event attributes to the account. An output whose projection WP-280 did not attest whole
   * (an empty projection, a shortfall) triggers a run; one whose required event, or its id, cannot be read is an
   * obligation (the door's unreadable entry).
   */
  async #routeStream(output: unknown): Promise<void> {
    const read = readStreamOutput(output);
    const atMs = (): number => Math.max(this.#lastClock, 0);
    if (read.kind === null && read.unreadable.length === 0) {
      // (r13) Only an output the stream door's classifier did NOT read as nothing is routed (`onUserStreamOutput`): one
      // the door now reads as nothing read differently the second time (a proxy, say). It is present but unreadable:
      // the same durable obligation as an unreadable kind, never "nothing".
      await this.#recordEvidenceNow(null, unkeyedTradeRecord({ status: null, transactionHash: null, ownershipUndetermined: null, unreadable: ["kind"] }, "STREAM_UNREADABLE"), atMs());
      this.trigger("POSITION_BALANCE_DISCREPANCY");
      return;
    }
    const oms = this.#oms;
    let unapplied = oms === null || read.unreadable.length > 0;
    for (const entry of read.unreadable) {
      const record =
        entry.kind === "ORDER"
          ? unkeyedOrderRecord({ venueOrderId: null, tokenId: null, side: null, price: null, originalSize: null, sizeMatched: null, status: null, unreadable: [] }, "STREAM_ORDER_UNKEYED")
          : unkeyedTradeRecord({ status: null, transactionHash: null, ownershipUndetermined: null, unreadable: [entry.field] }, "STREAM_UNREADABLE");
      await this.#recordEvidenceNow(null, record, atMs());
    }
    if (read.event !== undefined) {
      for (const record of streamEventRecords(read.event)) await this.#recordEvidenceNow(null, record, atMs());
      if (read.event.required) unapplied = true;
    }
    for (const item of read.items) {
      let result: unknown;
      if (oms !== null) {
        try {
          result =
            item.fragments.kind === "ORDER" ? await oms.applyOrderObservation(item.raw) : item.fragments.kind === "FILL" ? await oms.recordFill(item.raw) : await oms.applySettlement(item.raw);
        } catch {
          result = undefined;
        }
        if (readOkFlag(result)) continue;
      }
      unapplied = true;
      for (const record of streamRecords(item.fragments)) await this.#recordEvidenceNow(null, record, atMs());
    }
    if (unapplied) this.trigger("POSITION_BALANCE_DISCREPANCY");
  }

  // ---- OMS health -----------------------------------------------------------------------------

  #inspectOms(run: RunState, oms: ReconciledOms): void {
    if (oms.faulted) {
      this.#detect(run, {
        breakClass: "COMPONENT_UNAVAILABLE",
        subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "oms"),
        detail: "the OMS is faulted; it must be reopened from its store and bound again",
      });
    } else {
      run.positive.add(compositeKey("COMPONENT_UNAVAILABLE", "oms"));
    }
    // The OMS-scoped holds this inspection judges (each by its exact subject): evidence no longer retained, an
    // attempt that no longer awaits a read, an order no longer reconciling.
    const retained = new Set(oms.retainedEvidence().map((item) => item.venueOrderId));
    const attempts = new Map(oms.attempts().map((attempt) => [attempt.submissionAttemptId, attempt]));
    const heldIds = heldAttemptIds(oms.attempts());
    const orders = new Map(oms.orders().map((order) => [order.orderId, order]));
    for (const view of this.#unresolvedBreaks() ?? []) {
      const parts = decodeCompositeKey(view.subjectKey);
      if (parts === undefined || parts[0] !== view.breakClass) continue;
      if (view.breakClass === "OMS_EVIDENCE_RETAINED" && parts.length === 2 && parts[1] !== undefined && !retained.has(parts[1])) run.positive.add(view.subjectKey);
      if (view.breakClass !== "ORDER_UNRESOLVED") continue;
      if (parts.length === 2 && parts[1] !== undefined) {
        const attempt = attempts.get(parts[1]);
        if (attempt === undefined || !awaitsRead(attempt)) run.positive.add(view.subjectKey);
      } else if (parts.length === 3 && parts[1] === "order" && parts[2] !== undefined) {
        const order = orders.get(parts[2]);
        if (order === undefined || order.state !== "RECONCILING" || (order.submissionAttemptId !== null && heldIds.has(order.submissionAttemptId))) run.positive.add(view.subjectKey);
      }
    }
    // Every halting alert, every run: each is its own subject, so a run re-finds the ones it recorded (no alert is
    // lost to a failed journal write), and a release acknowledges exactly one alert.
    this.#inspectAlerts(run, oms);
    for (const item of oms.retainedEvidence()) {
      this.#detect(run, {
        breakClass: "OMS_EVIDENCE_RETAINED",
        subjectKey: compositeKey("OMS_EVIDENCE_RETAINED", item.venueOrderId),
        detail: `the OMS retains ${item.kind} evidence for venue order ${item.venueOrderId} until an attempt resolves`,
      });
    }
    for (const attempt of oms.attempts()) {
      if (!awaitsRead(attempt)) continue;
      const facts = this.#attemptFacts.get(attempt.submissionAttemptId);
      this.#detect(run, {
        breakClass: "ORDER_UNRESOLVED",
        subjectKey: compositeKey("ORDER_UNRESOLVED", attempt.submissionAttemptId),
        ...this.#marketScope(facts?.marketId ?? null),
        orderId: attempt.orderId,
        detail: `attempt ${attempt.submissionAttemptId} is ${attempt.state}${attempt.inFlight ? " with a transmission in flight" : ""} and still awaits an authoritative read`,
      });
    }
    const held = heldAttemptIds(oms.attempts());
    for (const order of oms.orders()) {
      // An order held for the retransmission decision is RECONCILING, and the OMS allows resume with it (as here).
      if (order.state !== "RECONCILING" || (order.submissionAttemptId !== null && held.has(order.submissionAttemptId))) continue;
      this.#detect(run, {
        breakClass: "ORDER_UNRESOLVED",
        subjectKey: compositeKey("ORDER_UNRESOLVED", "order", order.orderId),
        ...this.#marketScope(order.marketId),
        orderId: order.orderId,
        detail: `order ${order.orderId} is RECONCILING`,
      });
    }
  }

  /**
   * One break per HALTING ALERT OCCURRENCE. `OmsAlert` carries no id, and two alerts can be identical in every
   * field (two trades of one order FAILED raise two equal `SETTLEMENT_FAILED` alerts), so an alert's identity is
   * where it stands: the bound instance's INCARNATION id and the alert's ordinal in its append-only list. The
   * incarnation id is the id of the first run that inspects the instance (a fresh UUIDv7 that run drew; a restart
   * binds a new instance, so ordinals never collide across processes). A release then acknowledges that one
   * alert; a later alert like it is a new subject, opens a new break, and halts its market. The list must be
   * append-only (WP-270's `OrderManager` only appends): each alert's fingerprint is kept by ordinal, and a list
   * that shrinks or rewrites an earlier entry holds the account.
   */
  #inspectAlerts(run: RunState, oms: ReconciledOms): void {
    const incarnation = this.#incarnations.get(oms) ?? { id: run.runId, seen: [] };
    this.#incarnations.set(oms, incarnation);
    const alerts = oms.alerts();
    let appendOnly = alerts.length >= incarnation.seen.length;
    alerts.forEach((alert, ordinal) => {
      const fingerprint = compositeKey(
        alert.kind,
        String(alert.haltMarket),
        alert.marketId ?? "",
        alert.orderId ?? "",
        alert.submissionAttemptId ?? "",
        alert.venueOrderId ?? "",
        alert.detail,
      );
      if (ordinal >= incarnation.seen.length) incarnation.seen.push(fingerprint);
      else if (incarnation.seen[ordinal] !== fingerprint) appendOnly = false;
    });
    if (!appendOnly) {
      this.#detect(run, {
        breakClass: "COMPONENT_UNAVAILABLE",
        subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "oms-alerts"),
        detail: "the OMS's alert list is not append-only (an earlier alert changed or disappeared): its alerts cannot be told apart; bind a freshly opened OMS",
      });
    } else {
      run.positive.add(compositeKey("COMPONENT_UNAVAILABLE", "oms-alerts"));
    }
    alerts.forEach((alert, ordinal) => {
      if (!alert.haltMarket) return;
      this.#detect(run, {
        breakClass: "OMS_HALTING_ALERT",
        subjectKey: compositeKey("OMS_HALTING_ALERT", incarnation.id, String(ordinal), alert.kind, alert.orderId ?? "", alert.submissionAttemptId ?? "", alert.venueOrderId ?? ""),
        ...this.#marketScope(alert.marketId),
        orderId: alert.orderId !== null && isUuidV7(alert.orderId) ? alert.orderId : null,
        detail: `the OMS raised a halting ${alert.kind} alert (alert ${String(ordinal + 1)} of the OMS instance first inspected by run ${incarnation.id}): ${alert.detail}`,
      });
    });
  }

  // =========================================================================
  // Steps 6-8: record, act, resume.

  async #finish(run: RunState, triggers: readonly ReconciliationTrigger[], atMs: number): Promise<RunReport> {
    const runId = run.runId;
    const acknowledged = this.#releasedSubjects();
    const record = async (detection: Detection, unresolved: Map<string, JournalBreakView>, reproduced: Set<string>): Promise<void> => {
      const existing = unresolved.get(detection.subjectKey);
      if (existing !== undefined) {
        reproduced.add(existing.breakId);
        await this.#act(run, detection);
        return;
      }
      // An operator released this very subject. Immutable history (an UNATTRIBUTED trade stays in the account's
      // history for good; an alert the OMS raised) is acknowledged, and not opened again: new activity has new
      // subjects. A LIVE contradiction (a tracked order whose venue facts differ) is not: still found, it opens
      // again, and holds until a fresh comparison shows the subject consistent (the taxonomy decides which).
      const rule = this.#ruleOf(detection.breakClass);
      const releasable = rule === "QUARANTINE_UNTIL_RELEASED" || rule === "UNATTRIBUTED_HALT";
      if (releasable && acknowledged.has(detection.subjectKey) && this.#releaseAcknowledges(detection.breakClass)) return;
      const breakId = this.#drawId();
      if (breakId === undefined) {
        run.journalOk = false;
        return;
      }
      const opened = await this.#append({
        kind: "BREAK_OPENED",
        breakId,
        runId,
        breakClass: detection.breakClass,
        subjectKey: detection.subjectKey,
        scope: detection.scope,
        marketId: detection.marketId,
        orderId: detection.orderId,
        fillId: null,
        walletOperationId: detection.walletOperationId,
        assetId: detection.assetId,
        expectedValue: detection.expectedValue,
        observedValue: detection.observedValue,
        detail: detection.detail,
        atMs,
      });
      if (!opened.ok) {
        run.journalOk = false;
        return;
      }
      reproduced.add(breakId);
      if (releasable) {
        const quarantined = await this.#append({
          kind: "BREAK_QUARANTINED",
          breakId,
          runId,
          resolutionLedgerTransactionId: detection.ledgerTransactionId,
          atMs,
        });
        if (!quarantined.ok) run.journalOk = false;
      }
      // §9.17 step 7, after step 6: act on what was recorded; then resolve it in this run only through the one
      // resolution function (its exact subject positively judged by the act, a conclusive run, the latch checked
      // after the act's every await).
      const fixed = await this.#act(run, detection);
      if (rule === "RESOLVE_IN_RUN" && fixed) await this.#resolve(run, { breakId, subjectKey: detection.subjectKey }, "RESOLVED_IN_RUN", atMs);
    };
    const readable = this.#unresolvedBreaks();
    // The journal's breaks unreadable: nothing is cleared, and the run cannot pass (fail closed).
    if (readable === undefined) run.journalOk = false;
    const unresolvedBefore = readable ?? [];
    // Repair first: a quarantine a crash left OPEN (between its BREAK_OPENED and its BREAK_QUARANTINED) is
    // quarantined now, whether or not this run finds its subject again: an OPEN quarantine does not halt entries
    // (`quarantinedBreaks`), is never cleared by a run (its rule is a release), and cannot be released.
    for (const view of unresolvedBefore) {
      if (view.status !== "OPEN" || (view.rule !== "QUARANTINE_UNTIL_RELEASED" && view.rule !== "UNATTRIBUTED_HALT")) continue;
      const repaired = await this.#append({ kind: "BREAK_QUARANTINED", breakId: view.breakId, runId, resolutionLedgerTransactionId: null, atMs });
      if (!repaired.ok) run.journalOk = false;
    }
    const bySubject = new Map(unresolvedBefore.map((view) => [view.subjectKey, view]));
    const reproduced = new Set<string>();
    // Detections can raise detections (a refused delivery; the READ_STALE of a clock fault latched meanwhile):
    // record, in order, every one not recorded yet, until none is new.
    let recordedUpTo = 0;
    const recordPending = async (): Promise<void> => {
      while (recordedUpTo < run.detections.length) {
        const next = run.detections[recordedUpTo] as Detection;
        recordedUpTo += 1;
        await record(next, bySubject, reproduced);
      }
    };
    await recordPending();
    // The journal's unresolved breaks unreadable now: recorded. (The live gate's halts read them: `quarantinedBreaks`.)
    if (this.#unresolvedBreaks() === undefined) {
      this.#detect(run, {
        breakClass: "COMPONENT_UNAVAILABLE",
        subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "journal"),
        detail: "the journal's unresolved breaks could not be read",
      });
    }
    await recordPending();
    // Clear what this run positively judged consistent (a quarantine never: its rule is a release), each through the
    // one resolution function, which checks the latch after every await before it.
    this.#finalJudgements(run);
    for (const view of unresolvedBefore) {
      if (reproduced.has(view.breakId)) continue;
      if (view.status !== "OPEN" || (view.rule !== "HOLD_UNTIL_CONSISTENT" && view.rule !== "RESOLVE_IN_RUN")) continue;
      await this.#resolve(run, view, "NOT_REPRODUCED", atMs);
    }
    // A conclusive run settles the evidence of every venue order it judged consistent (it is no longer read by id
    // until new evidence about it arrives). A conclusion: through the latch.
    await this.#settleEvidence(run, atMs);
    // A clock fault detected at any point of the run so far (an answer's record, the closing reading, a receipt or a
    // release while the run recorded) is latched before the decision: the run is stale, so it cannot pass, and its
    // READ_STALE is recorded.
    if (!this.#mayCommit(run)) await recordPending();
    // §9.17 step 8. The decision and the epoch it was taken at are read in one synchronous step.
    const epoch = this.#holdEpoch;
    const rerun = this.#workArrivedDuring(run.readsStartSeq ?? run.runStartSeq) || run.holdingsDeferred;
    const invariant = this.#resumeBlocker(run, this.#conclusive(run), run.journalOk, rerun);
    const unresolvedNow = this.#unresolvedBreaks() ?? [];
    const status: "PASSED" | "FAILED" | "QUARANTINED" =
      invariant === undefined ? "PASSED" : unresolvedNow.some((view) => view.status === "QUARANTINED") ? "QUARANTINED" : "FAILED";
    const completed = await this.#append({
      kind: "RUN_COMPLETED",
      runId,
      status,
      ordersChecked: run.ordersChecked,
      fillsChecked: run.fillsChecked,
      walletOperationsChecked: run.walletOperationsChecked,
      breaksFound: run.detections.length,
      detail: freezeDetail(invariant ?? "every required invariant passed"),
      atMs,
    });
    let resumed = false;
    let rerunNext = rerun;
    let reason = invariant ?? "every required invariant passed";
    if (status === "PASSED" && completed.ok) {
      if (this.#holdEpoch !== epoch) {
        // Work arrived (a trigger, a request, a pause) while the PASSED record was being written: the decision
        // predates it, so it does not resume; the next run, at once, answers the new work.
        rerunNext = true;
        reason = "work arrived while the run's completion was being recorded; it does not resume, and another run follows";
        await this.#append({ kind: "RESUME_REFUSED", runId, refusalCode: "RECON_WORK_ARRIVED", atMs });
      } else if (!this.#mayCommit(run)) {
        // The run-validity latch, after the last await (r5, r6): a clock fault detected while the PASSED record was
        // being written (an operator's release attempted meanwhile reads the clock; no hold advanced the epoch), or a
        // journal that faulted meanwhile: the run concludes nothing more, so it does not resume. The next run, at
        // once, reads afresh, with every pending request's window restarted.
        rerunNext = true;
        const clock = run.clockFaulted;
        reason = clock
          ? "the clock was unreadable or went backwards while the run's completion was being recorded; it does not resume, and another run follows"
          : "the journal faulted while the run's completion was being recorded; it does not resume";
        await this.#append({ kind: "RESUME_REFUSED", runId, refusalCode: clock ? "RECON_CLOCK_FAULT" : "RECON_JOURNAL_FAULTED", atMs });
      } else {
        // Resume only after the PASSED record is durable, with nothing new since the decision (synchronous from here).
        const oms = this.#oms as ReconciledOms;
        let result: unknown;
        try {
          result = oms.resume();
        } catch {
          result = undefined;
        }
        if (readOkFlag(result)) {
          this.#holding = false;
          resumed = true;
        } else {
          // The OMS's own rule refused (a race with its state): it stays paused, and the refusal is recorded.
          this.#hold();
          const code = readRefusalCode(result);
          reason = `the OMS refused to resume: ${code}`;
          await this.#append({ kind: "RESUME_REFUSED", runId, refusalCode: code, atMs });
        }
      }
    } else if (!completed.ok) {
      reason = `the run's completion could not be recorded: ${completed.code}`;
    }
    return Object.freeze({
      runId,
      status: completed.ok ? (status === "PASSED" && !resumed ? "FAILED" : status) : "FAILED",
      resumed,
      triggers,
      detections: Object.freeze(run.detections.map((detection) => Object.freeze({ breakClass: detection.breakClass, subjectKey: detection.subjectKey, detail: detection.detail }))),
      answers: Object.freeze([...run.answers]),
      rerun: !resumed && rerunNext,
      reason,
    });
  }

  /**
   * A run whose evidence is complete and sound: every read answered in its shape, completely, consistently, within
   * the span bound, from a readable evidence journal, with every journal append recorded, and no clock fault
   * latched. Only such a run concludes anything about a break.
   */
  #conclusive(run: RunState): boolean {
    return !run.stale && run.readsComplete && run.orderReadsSound && run.evidenceReadable && run.journalOk;
  }

  /**
   * THE ONE RESOLUTION FUNCTION (r6, class B). A break leaves the open state by a run (RESOLVED_IN_RUN or
   * NOT_REPRODUCED) only here, and only when ALL hold: the comparison that actually ran in THIS run positively
   * judged the break's EXACT subject consistent (`RunState.positive`); the run is conclusive (`#conclusive`); and
   * the run-validity latch passes now, after every await before it (`#mayCommit`). Anything else stays open.
   */
  async #resolve(run: RunState, view: { readonly breakId: string; readonly subjectKey: string }, resolution: "RESOLVED_IN_RUN" | "NOT_REPRODUCED", atMs: number): Promise<boolean> {
    if (!this.#conclusive(run) || !run.positive.has(view.subjectKey)) return false;
    if (!this.#mayCommit(run)) return false;
    const resolved = await this.#append({
      kind: "BREAK_RESOLVED",
      breakId: view.breakId,
      runId: run.runId,
      resolution,
      operatorRef: null,
      detail: resolution === "RESOLVED_IN_RUN" ? "fixed in the run that found it" : "a later conclusive run judged its subject consistent",
      atMs,
    });
    if (!resolved.ok) run.journalOk = false;
    return resolved.ok;
  }

  /**
   * The positive judgements made at the end of the run, from what the run's comparisons recorded (each about one
   * exact subject; see `RunState.positive`):
   * - a tracked order compared in full (state and fills) with nothing found about it: every order-scoped subject of
   *   it, and each refused fill or settlement of a leg this run's trades read showed consistent;
   * - the run's clock and reads (`READ_STALE`), the journal, the evidence journal, an execution group's token;
   * - a malformed-request channel this run took nothing from.
   */
  #finalJudgements(run: RunState): void {
    if (!run.stale) run.positive.add(compositeKey("READ_STALE", "run"));
    if (run.journalOk && this.#unresolvedBreaks() !== undefined && this.#allBreaks() !== undefined) run.positive.add(compositeKey("COMPONENT_UNAVAILABLE", "journal"));
    if (run.evidenceReadable) run.positive.add(compositeKey("COMPONENT_UNAVAILABLE", "journal-evidence"));
    const clean = new Set<string>();
    for (const orderId of run.ordersComparedInFull) {
      if (run.detections.some((detection) => detection.orderId === orderId && JUDGED_WITH_ORDER.includes(detection.breakClass))) continue;
      clean.add(orderId);
      for (const breakClass of JUDGED_WITH_ORDER) run.positive.add(compositeKey(breakClass, orderId));
    }
    const venueOf = new Map((this.#oms?.orders() ?? []).map((order) => [order.orderId, order.venueOrderId]));
    for (const view of this.#unresolvedBreaks() ?? []) {
      const parts = decodeCompositeKey(view.subjectKey);
      if (parts === undefined || parts[0] !== view.breakClass) continue;
      if (view.breakClass === "FILL_REFUSED" && parts.length === 4 && view.orderId !== null && clean.has(view.orderId)) {
        const [, , tradeId, venueOrderId] = parts;
        if (tradeId !== undefined && venueOf.get(view.orderId) === venueOrderId && run.tradeVerdicts.get(tradeId)?.kind === "CONSISTENT") run.positive.add(view.subjectKey);
      }
      if (view.breakClass === "COMPONENT_UNAVAILABLE" && parts.length === 3 && parts[1] === "group-token" && parts[2] !== undefined && this.#groupToken(parts[2]) !== null) {
        run.positive.add(view.subjectKey);
      }
      if (view.breakClass === "REQUEST_MALFORMED" && parts.length === 3) {
        const channel = parts[1] ?? "";
        if (channel === "unitemised" ? run.malformedChannels.size === 0 : !run.malformedChannels.has(channel)) run.positive.add(view.subjectKey);
      }
    }
  }

  /** Settle, in a conclusive run, the evidence of every venue order it judged CONSISTENT (through the latch). */
  async #settleEvidence(run: RunState, atMs: number): Promise<void> {
    if (!this.#conclusive(run)) return;
    for (const [id, verdict] of run.verdicts) {
      if (verdict.kind !== "CONSISTENT") continue;
      const evidence = this.#evidence.order(id);
      if (evidence === undefined || evidence.settled) continue;
      if (!this.#mayCommit(run)) return;
      if (!(await this.#recordEvidenceNow(run.runId, settledRecord(id, evidence.level, "SOUND_RUN"), atMs))) run.journalOk = false;
    }
  }

  /** The attempt-scoped subjects this run positively judged (`SIGNED_IDENTITY_AMBIGUOUS`, `ANSWER_REFUSED`). */
  #judgeAttempts(run: RunState, oms: ReconciledOms): void {
    const attempts = new Map(oms.attempts().map((attempt) => [attempt.submissionAttemptId, attempt]));
    for (const view of this.#unresolvedBreaks() ?? []) {
      if (view.breakClass !== "SIGNED_IDENTITY_AMBIGUOUS" && view.breakClass !== "ANSWER_REFUSED") continue;
      const parts = decodeCompositeKey(view.subjectKey);
      const id = parts?.length === 2 ? parts[1] : undefined;
      if (id === undefined) continue;
      const attempt = attempts.get(id);
      const open = attempt !== undefined && couldHavePlaced(attempt);
      if (view.breakClass === "SIGNED_IDENTITY_AMBIGUOUS" && (run.identityJudged.has(id) || !open)) run.positive.add(view.subjectKey);
      if (view.breakClass === "ANSWER_REFUSED" && (run.answeredAccepted.has(id) || (!open && !this.#omsRequests.has(id)))) run.positive.add(view.subjectKey);
    }
  }

  /** The first required invariant that fails, or `undefined` (see RESUME in the header). */
  #resumeBlocker(run: RunState, complete: boolean, journalOk: boolean, rerun: boolean): string | undefined {
    if (!journalOk || this.#deps.journal.faulted) return "the journal did not record every event";
    if (run.stale) return run.clockFaulted ? "the clock was unreadable or went backwards during the run (READ_STALE)" : "the run's reads were stale";
    if (!complete) return "the run did not read everything completely and consistently";
    if (run.holdingsDeferred) return "holdings were not judged: the OMS and the venue disagreed about an order this run";
    // Defence in depth: every path that leaves the holdings unjudged also records a break or an incomplete read.
    if (!run.holdingsJudged) return "holdings were not judged in this run";
    const unresolved = this.#unresolvedBreaks();
    if (unresolved === undefined) return "the journal's breaks could not be read";
    if (unresolved.length > 0) return `${String(unresolved.length)} break(s) unresolved, first ${unresolved[0]?.breakClass ?? "?"}`;
    if (rerun) return "work arrived during the run";
    const oms = this.#oms;
    if (oms === null || oms.faulted) return "the OMS is unavailable";
    if (oms.attempts().some(awaitsRead)) return "an attempt still awaits an authoritative read";
    const held = heldAttemptIds(oms.attempts());
    if (oms.orders().some((order) => order.state === "RECONCILING" && !(order.submissionAttemptId !== null && held.has(order.submissionAttemptId)))) {
      return "an order is still reconciling";
    }
    if (oms.retainedEvidence().length > 0) return "the OMS retains unattributed evidence";
    if (oms.outstandingReconciliations() > 0) return "the OMS has undelivered reconciliation requests";
    if (this.#omsRequests.size > 0) return "an OMS request is unanswered";
    if (this.#walletRequests.size > 0) return "a wallet-operation request is unanswered";
    if (this.#streamRequests.size > 0) return "a user-stream request is unacknowledged";
    const wallet = this.#wallet;
    if (wallet !== null) {
      try {
        if (wallet.outstandingReconciliationRequests().length > 0) return "the inventory holds undelivered requests";
      } catch {
        return "the inventory is unreadable";
      }
    }
    return undefined;
  }

  /**
   * Take the action a break's rule calls for (§9.17 step 7: deliver a missed fill, route a state mismatch to the
   * OMS); `true` when it was taken and accepted. Through the run-validity latch: checked here, and again by every
   * commit inside the act (each delivery of a multi-fill act: `#deliverFills`) and by the resolution after it
   * (`#resolve`), so a fault detected during any await of the act stops the rest of it and resolves nothing; the
   * break stays as recorded (a hold), and a later run acts on it (r5, r6: WP290-CX-R6-02).
   */
  async #act(run: RunState, detection: Detection): Promise<boolean> {
    if (detection.act === null) return false;
    if (!this.#mayCommit(run)) return false;
    let taken = false;
    try {
      taken = await detection.act();
    } catch {
      taken = false;
    }
    // After the act's last await: a fault detected meanwhile means the act concluded nothing.
    return taken && this.#mayCommit(run);
  }

  // ---- receipt of requests --------------------------------------------------------------------

  #receiveOmsRequest(raw: unknown): void {
    const request = readOmsRequest(raw);
    if (request === undefined) {
      this.#receiveMalformed("oms", "outside the OMS's request shape", "POSITION_BALANCE_DISCREPANCY");
      // Thrown, so the OMS records it as undelivered and alerts (it never waits on an answer that cannot come).
      throw new TypeError("a reconciliation request outside the OMS's request shape");
    }
    const seq = ++this.#seq;
    this.#omsRequests.set(request.submissionAttemptId, Object.freeze({ request, seq, atMs: this.#now() }));
    this.#attemptFacts.set(request.submissionAttemptId, factsOf(request));
    this.trigger(request.purpose === "SUBMISSION_UNKNOWN" ? "SUBMISSION_UNKNOWN" : "POSITION_BALANCE_DISCREPANCY");
  }

  #receiveWalletRequest(raw: unknown): void {
    const request = readWalletRequest(raw);
    if (request === undefined) {
      this.#receiveMalformed("inventory", "outside the inventory's request shape", "WALLET_OPERATION_UNKNOWN");
      // Thrown: the inventory then holds it as undelivered and retries (ADR-032 D5).
      throw new TypeError("a reconciliation request outside the inventory's request shape");
    }
    const seq = ++this.#seq;
    this.#walletRequests.set(request.walletOperationId, Object.freeze({ request, seq, atMs: this.#now() }));
    this.trigger(request.trigger === "WALLET_OPERATION_UNKNOWN" ? "WALLET_OPERATION_UNKNOWN" : "POSITION_BALANCE_DISCREPANCY");
  }

  /**
   * One WP-280 reconciliation request, read at its door (`door.ts`, `readStreamRequest`). (r14,
   * WP290-V14-WP280-EVENT-IDS-DISCARDED) What it NAMED is journaled at receipt, whatever its usability
   * (`streamRequestRecords`: a trade it names, NAMED and OPEN, (r15) `unordered` unless `previous`, the output received
   * immediately before it, is the output of the very event it was raised for, with an ordered status
   * (`requestEventStatus`: then the record carries that status; WP290-V15-EFA-REQUEST-STATUS-ASSUMED); the
   * orders an order event's request names, NAMED, read by id; an identity that cannot be read, an obligation of the
   * account), and it is acknowledged only once a run has judged every identity it named. A request whose id or cause
   * cannot be read is refused as malformed (a REQUEST_MALFORMED hold), as before.
   */
  #receiveStreamRequest(raw: unknown, previous: unknown = undefined): void {
    const read = readStreamRequest(raw);
    this.#recordAtReceipt(streamRequestRecords(read, requestEventStatus(read, previous)));
    if (read.opaque || read.requestId === null || read.cause === null) {
      this.#receiveMalformed("user-stream", "outside WP-280's request shape", "USER_STREAM_RECONNECT");
      return;
    }
    const request: StreamReconciliationRequest = Object.freeze({ requestId: read.requestId, cause: read.cause, markets: read.markets });
    const seq = ++this.#seq;
    this.#streamRequests.set(request.requestId, Object.freeze({ request, seq, atMs: this.#now(), named: streamRequestSubjects(read) }));
    this.trigger(STREAM_DISCREPANCY_CAUSES.includes(request.cause) ? "POSITION_BALANCE_DISCREPANCY" : "USER_STREAM_RECONNECT");
  }

  /**
   * (r14) Journal what a stream request named: now (on the stream chain, in order with the outputs) between runs; during
   * a run, by the next run's evidence load (a run never folds evidence it did not judge).
   */
  #recordAtReceipt(records: readonly EvidenceRecord[]): void {
    if (records.length === 0) return;
    this.#receiptEvidence.push(...records);
    if (!this.#running) this.#flushReceipts();
  }

  /** (r14) Record, on the stream chain, every identity a request named that no run has taken in yet. */
  #flushReceipts(): void {
    const records = this.#receiptEvidence.splice(0);
    if (records.length === 0) return;
    this.#streamChain = this.#streamChain
      .then(async () => {
        for (const record of records) await this.#recordEvidenceNow(null, record, Math.max(this.#lastClock, 0));
      })
      .catch(() => undefined);
  }

  /** A request that could not be read: recorded (a REQUEST_MALFORMED break, by the next run), and a run is triggered. */
  #receiveMalformed(channel: MalformedReceipt["channel"], why: string, trigger: ReconciliationTrigger): void {
    const seq = ++this.#seq;
    if (this.#malformed.length < MAX_MALFORMED_PENDING) this.#malformed.push(Object.freeze({ channel, seq, why }));
    else this.#malformedUnitemised += 1;
    this.trigger(trigger);
  }

  /**
   * Record every malformed receipt from before `beforeSeq` as its own REQUEST_MALFORMED break (a hold). The run
   * that records one reads everything after the receipt, but cannot pass with the break open; a later complete
   * run, which no longer receives it, clears it. A requester that keeps presenting an unreadable request (the
   * OMS's and the inventory's retries, WP-280's backlog) is received again by every run, and keeps it held.
   */
  #takeMalformed(run: RunState, beforeSeq: number): void {
    for (let index = 0; index < this.#malformed.length; ) {
      const entry = this.#malformed[index] as MalformedReceipt;
      if (entry.seq >= beforeSeq) {
        index += 1;
        continue;
      }
      this.#malformed.splice(index, 1);
      run.malformedChannels.add(entry.channel);
      this.#detect(run, {
        breakClass: "REQUEST_MALFORMED",
        subjectKey: compositeKey("REQUEST_MALFORMED", entry.channel, String(entry.seq)),
        detail: `a reconciliation request from the ${entry.channel} channel could not be read (${entry.why}); it was not answered`,
      });
    }
    if (this.#malformedUnitemised > 0) {
      run.malformedChannels.add("unitemised");
      this.#detect(run, {
        breakClass: "REQUEST_MALFORMED",
        subjectKey: compositeKey("REQUEST_MALFORMED", "unitemised", String(beforeSeq)),
        detail: `${String(this.#malformedUnitemised)} further malformed reconciliation requests arrived beyond the ${String(MAX_MALFORMED_PENDING)} itemised`,
      });
      this.#malformedUnitemised = 0;
    }
  }

  #dropOmsRequest(request: OmsReconciliationRequest): void {
    const current = this.#omsRequests.get(request.submissionAttemptId);
    if (current !== undefined && current.request.requestId === request.requestId) this.#omsRequests.delete(request.submissionAttemptId);
  }

  /**
   * A request received while the clock was unreadable, or whose window a clock fault restarted, is stamped with
   * this sound reading: its quiescence counts from here (later than its receipt: conservative), and its sequence
   * number is just below the reads', so this run may answer it but no fault before now taints it.
   */
  #stampUnclockedRequests(seq: number, atMs: number | null): void {
    if (atMs === null) return;
    for (const [key, entry] of this.#omsRequests) if (entry.atMs === null) this.#omsRequests.set(key, Object.freeze({ ...entry, seq: seq - 0.5, atMs }));
  }

  #takeTriggers(beforeSeq: number): ReconciliationTrigger[] {
    const taken: ReconciliationTrigger[] = [];
    for (let index = 0; index < this.#triggers.length; ) {
      const entry = this.#triggers[index] as { trigger: ReconciliationTrigger; seq: number };
      if (entry.seq < beforeSeq) {
        if (!taken.includes(entry.trigger)) taken.push(entry.trigger);
        this.#triggers.splice(index, 1);
      } else {
        index += 1;
      }
    }
    if (taken.length === 0) taken.push("MANUAL_REQUEST");
    return taken;
  }

  /**
   * A trigger is pending, or a request arrived after the run's reads began (its answer needs a fresh read), or (r14) an
   * activity output arrived during the run (it waits, unrouted, in the buffer: the run's reads may predate it).
   */
  #workArrivedDuring(sinceSeq: number): boolean {
    if (this.#triggers.length > 0) return true;
    if (this.#streamBuffer.length > 0) return true;
    for (const entry of this.#omsRequests.values()) if (entry.seq > sinceSeq) return true;
    for (const entry of this.#walletRequests.values()) if (entry.seq > sinceSeq) return true;
    for (const entry of this.#streamRequests.values()) if (entry.seq > sinceSeq) return true;
    return false;
  }

  // ---- helpers --------------------------------------------------------------------------------

  #hold(): void {
    this.#holdEpoch += 1;
    this.#holding = true;
    try {
      this.#oms?.pause();
    } catch {
      // A pause that throws is the OMS's fault; the hold stays, and no run passes while it is faulted.
    }
  }

  #detect(run: RunState, partial: Partial<Detection> & Pick<Detection, "breakClass" | "subjectKey" | "detail">): void {
    if (run.subjects.has(partial.subjectKey)) return;
    run.subjects.add(partial.subjectKey);
    run.detections.push(detection(partial));
  }

  #ruleOf(breakClass: BreakClass): BreakRule {
    try {
      return this.#deps.journal.ruleOf(breakClass);
    } catch {
      return "HOLD_UNTIL_CONSISTENT";
    }
  }

  /** The journal's unresolved breaks. Unreadable: `undefined`, which every caller treats as blocking (fail closed). */
  #unresolvedBreaks(): JournalBreakView[] | undefined {
    try {
      const list = readArray(this.#deps.journal.unresolvedBreaks(), 10_000_000);
      return list === undefined ? undefined : [...(list as readonly JournalBreakView[])];
    } catch {
      return undefined;
    }
  }

  /** The assets named by unresolved breaks. Unreadable: a sentinel that matches every asset check (fail closed). */
  #unresolvedBreaksWithAssets(): string[] {
    try {
      return this.#deps.journal.unresolvedBreaks().flatMap((view) => (view.assetId === null ? [] : [view.assetId]));
    } catch {
      return [this.#deps.policy.collateralAssetId];
    }
  }

  /** Whether a release of this class acknowledges its subject (the ledger's taxonomy). Unreadable: no (fail closed: it re-opens). */
  #releaseAcknowledges(breakClass: BreakClass): boolean {
    try {
      return this.#deps.journal.releaseAcknowledgesSubject(breakClass) === true;
    } catch {
      return false;
    }
  }

  /** Subjects an operator released (acknowledged quarantines). Unreadable: none (fail closed: they re-open). */
  #releasedSubjects(): Set<string> {
    try {
      return new Set(this.#deps.journal.breaks().filter((view) => view.resolution === "OPERATOR_RELEASED").map((view) => view.subjectKey));
    } catch {
      return new Set();
    }
  }

  /** Subjects of every break the journal records, resolved or not (for the ledger's halt obligations). */
  #allBreakSubjects(): string[] | undefined {
    return this.#allBreaks()?.map((view) => view.subjectKey);
  }

  /** Every break the journal records, resolved or not. Unreadable: `undefined` (fail closed). */
  #allBreaks(): JournalBreakView[] | undefined {
    try {
      const list = readArray(this.#deps.journal.breaks(), 10_000_000);
      return list === undefined ? undefined : [...(list as readonly JournalBreakView[])];
    } catch {
      return undefined;
    }
  }

  #breakById(breakId: string): JournalBreakView | undefined {
    return this.#allBreaks()?.find((view) => view.breakId === breakId);
  }

  // ---- the evidence store (r6, class A) ---------------------------------------------------------

  /**
   * Rebuild the evidence store from the journal (every `EVIDENCE_RECORDED`, in order), then fold any record whose
   * append failed earlier, and append those again. An unreadable evidence journal concludes nothing: the run is
   * held (`COMPONENT_UNAVAILABLE`), and no answer or clearing is made from it. An append that fails again keeps the
   * record in memory, and the run concludes nothing either (its evidence is not durable: `journalOk`).
   */
  async #loadEvidence(run: RunState, atMs: number): Promise<void> {
    const records = this.#journalEvidence();
    if (records === undefined) {
      run.evidenceReadable = false;
      run.orderReadsSound = false;
      run.readsComplete = false;
      this.#detect(run, {
        breakClass: "COMPONENT_UNAVAILABLE",
        subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "journal-evidence"),
        detail: "the journal's evidence records could not be read: nothing about a venue order is concluded",
      });
      // Keep what memory holds (never less): the records already folded stay.
      return;
    }
    // Observations an earlier run folded but never journaled (its reads threw before the flush) are pending too.
    this.#pendingEvidence.push(...this.#evidenceQueue.splice(0));
    const pending = this.#pendingEvidence.splice(0);
    this.#evidence = EvidenceStore.fold([...records, ...pending]);
    this.#evidenceLoaded = true;
    for (const record of pending) if (!(await this.#appendEvidence(run.runId, record, atMs))) run.journalOk = false;
    // (r14) What a stream request named while a run was in progress (or as this run started): folded now, before
    // anything is read, and journaled when it adds information.
    for (const record of this.#receiptEvidence.splice(0)) {
      if (this.#evidence.add(record) && !(await this.#appendEvidence(run.runId, record, atMs))) run.journalOk = false;
    }
  }

  /** The journal's evidence records, read at their door; `undefined` when unreadable. */
  #journalEvidence(): EvidenceRecord[] | undefined {
    try {
      return readEvidenceRecords(this.#deps.journal.evidence());
    } catch {
      return undefined;
    }
  }

  /**
   * Between runs (the stream's evidence, an operator's release), the store must hold the journal's evidence too: a
   * process that has not run yet since it started folds it now (a run rebuilds it anyway).
   */
  #ensureEvidence(): void {
    if (this.#evidenceLoaded) return;
    const records = this.#journalEvidence();
    if (records === undefined) return;
    this.#evidence = EvidenceStore.fold([...records, ...this.#pendingEvidence]);
    this.#evidenceLoaded = true;
  }

  /** Fold one observation into the store now (synchronously); journaled with the run's others by `#flushEvidence`. */
  #observe(record: EvidenceRecord): void {
    if (this.#evidence.add(record)) this.#evidenceQueue.push(record);
  }

  /**
   * THE ONE RECORDING FUNCTION (r11, the class fix at the door layer). Every door's outcome, whatever its usability,
   * goes into the evidence store through here, and nowhere else: its `salvage` (`door.ts`: every row of the answer as
   * fragments, required on every outcome) becomes evidence records, folded now and journaled with the run's others:
   * - an ORDER row (open orders, by id): in full, SHOWN (`OPEN_ORDERS_LIST` from a usable list, `OPEN_ORDERS_ROW`,
   *   `BY_ID`, `BY_ID_ROW`); its id readable but not in full, NAMED with every fragment it validated
   *   (`OPEN_ORDERS_ID`, `BY_ID_ID`: the order is then read by id until a sound run reads it in full); its id
   *   unreadable, an `UNKEYED_ORDER` obligation (`OPEN_ORDERS_UNKEYED`, `BY_ID_UNKEYED`). A by-id answer's
   *   `found: true` is kept for the order asked about (`BY_ID_FOUND`). Never relabelled (r10);
   * - a TRADE row: its identity and status (r9), its every own leg (`#recordTradeRows`);
   * - a position, the collateral, an approval: a `HOLDING` record (detail only: not monotonic);
   * - a wallet member: a `MEMBER` record, under the member read by name.
   * The answer's own unreadable fields (`salvage.envelope`) are the read's own break (`#readProblem`).
   */
  #recordSalvage(
    oms: ReconciledOms,
    read:
      | { readonly door: "open-orders" | "trades" | "positions" | "collateral" | "approvals"; readonly outcome: ReadOutcome<unknown> }
      | { readonly door: "by-id"; readonly outcome: ReadOutcome<unknown>; readonly asked: string }
      | { readonly door: "wallet-member"; readonly outcome: ReadOutcome<unknown>; readonly member: string },
  ): void {
    const { salvage } = read.outcome;
    const usable = read.outcome.kind === "OK";
    switch (read.door) {
      case "open-orders":
      case "by-id": {
        const shown = read.door === "open-orders" ? (usable ? "OPEN_ORDERS_LIST" : "OPEN_ORDERS_ROW") : usable ? "BY_ID" : "BY_ID_ROW";
        for (const row of salvage.orders) {
          if (row.inFull !== null) this.#observe(shownOrder(row.inFull, shown));
          else if (row.venueOrderId !== null) this.#observe(orderFragmentsRecord(row, read.door === "open-orders" ? "OPEN_ORDERS_ID" : "BY_ID_ID"));
          else this.#observe(unkeyedOrderRecord(row, read.door === "open-orders" ? "OPEN_ORDERS_UNKEYED" : "BY_ID_UNKEYED"));
        }
        // (r11) `found: true` in an unusable answer: the order asked about exists (a usable one SHOWED it), unless the
        // row it carries names another readable id (then the flag may be that row's: kept under that id, never relabelled).
        const row = salvage.orders[0];
        if (read.door === "by-id" && !usable && salvage.found === true && (row === undefined || row.venueOrderId === null || row.venueOrderId === read.asked)) {
          this.#observe(namedOrder(read.asked, "BY_ID_FOUND"));
        }
        return;
      }
      case "trades":
        this.#recordTradeRows(oms, salvage.trades, usable, salvage.whole);
        return;
      case "positions":
      case "collateral":
      case "approvals":
        for (const holding of salvage.holdings) this.#observe(holdingRecord(holding));
        return;
      case "wallet-member":
        for (const member of salvage.members) this.#observe(memberRecord(read.member, member));
        return;
    }
  }

  /**
   * Every row of one trades answer (r6, r9, r10, r11), in this order, so that what the evidence holds when an unkeyed
   * leg is folded includes the answer's own keyed rows (r10):
   * 1. each row whose trade id is readable: a TRADE record (its identity, status, hash and ownership flag; r9);
   * 2. each own leg of such a row on a readable order: in full, SHOWN (`TRADES_LEG` from a usable answer,
   *    `TRADES_LEG_SALVAGED`); not in full, NAMED with every fact it validated (`TRADES_LEG_FRAGMENTS`);
   * 3. each own leg of such a row whose order id was unreadable: an `ORPHAN_LEG` of the trade;
   * 4. the rows whose trade id was unreadable (`#observeUnkeyed`).
   */
  #recordTradeRows(oms: ReconciledOms, rows: readonly TradeFragments[], usable: boolean, whole: boolean): void {
    const keyed = rows.filter((row) => row.venueTradeId !== null);
    for (const row of keyed) {
      const source = row.inFull === null ? "TRADES_ROW_ID" : row.inFull.ownershipUndetermined ? "TRADES_ROW_PARTIAL" : "TRADES_ROW";
      this.#observe(tradeRecord(row.venueTradeId as string, row.status, source, { transactionHash: row.transactionHash, ownershipUndetermined: row.ownershipUndetermined, unreadable: row.unreadable }));
    }
    for (const row of keyed) {
      const tradeId = row.venueTradeId as string;
      for (const leg of row.legs) {
        if (leg.venueOrderId === null) continue;
        if (leg.inFull !== null) this.#observe(legRecord(tradeId, legFacts(leg.inFull), row.status, "SHOWN", usable ? "TRADES_LEG" : "TRADES_LEG_SALVAGED"));
        else this.#observe(legRecord(tradeId, { ...partialLeg(leg), venueOrderId: leg.venueOrderId }, row.status, "NAMED", "TRADES_LEG_FRAGMENTS", leg.unreadable));
      }
    }
    for (const row of keyed) {
      for (const leg of row.legs) if (leg.venueOrderId === null) this.#observe(orphanLegRecord(row.venueTradeId as string, partialLeg(leg), row.status, "TRADES_LEG_ORPHAN", row.transactionHash));
    }
    this.#observeUnkeyed(
      oms,
      rows.filter((row) => row.venueTradeId === null),
      whole,
    );
  }

  /**
   * (r10, WP290-V10-UNKEYED-LEG-DISCHARGED; r11, WP290-V11-UNKEYED-STATUS-DROPPED and the class fix) The rows of one
   * trades answer whose trade id was unreadable. An unkeyed row may be any trade already known on its order, or a new
   * one: fail closed, it is a new one. So, after this answer's keyed rows were folded:
   * - each own leg that validated in full on a readable order is grouped by order and exact fill facts; each group is
   *   an obligation recorded ONCE PER SETTLEMENT STATUS its rows showed (`UNKEYED_LEG`, each with the group's whole
   *   count): the reads owe that many distinct trades of exactly those facts on the order, shown by a readable id,
   *   beyond every trade the evidence holds now (this answer's other rows included: they are folded first), EVERY one
   *   of which agrees with EVERY status (`evidence.ts`, `settlementAgrees`). No status is dropped by the grouping, and
   *   each is journaled and replayed. When the answer was not WHOLE (`door.ts`), a trade it left out could stand in for
   *   the unkeyed one, so the obligation can never be met (`TRADES_LEG_UNKEYED_PARTIAL`: fail closed);
   * - each own leg that did not validate in full (or whose order id was unreadable) is an obligation no read can meet
   *   (`TRADES_LEG_UNKEYED_FRAGMENTS`): on its order when readable, on the account otherwise;
   * - a row with no own leg at all (its list empty or unreadable) is an `UNKEYED_TRADE` obligation of the account;
   * - each readable order's matched size is bounded from below (`TRADES_LEG_UNKEYED`) by the shares of every trade known
   *   on it (the evidence's legs, and the OMS's fills of a tracked order, which the evidence may not hold: a fill the
   *   stream delivered), PLUS this answer's unkeyed legs' readable shares. The order's matched size alone is not
   *   enough: a leg no larger than what the order already showed would add nothing to it.
   */
  #observeUnkeyed(oms: ReconciledOms, rows: readonly TradeFragments[], whole: boolean): void {
    type RowFacts = { readonly status: string | null; readonly hash: string | null; readonly unreadable: readonly ("status" | "transactionHash")[] };
    const groups: { readonly leg: VenueTradeLeg; count: number; readonly statuses: RowFacts[] }[] = [];
    const bounds = new Map<string, { tokenId: string | null; side: "BUY" | "SELL" | null; shares: DecimalString; shown: boolean }>();
    const fragments: { readonly leg: LegFragments; readonly row: TradeFragments }[] = [];
    for (const row of rows) {
      if (row.legs.length === 0) {
        this.#observe(unkeyedTradeRecord({ status: row.status, transactionHash: row.transactionHash, ownershipUndetermined: row.ownershipUndetermined, unreadable: [...row.unreadable] }, "TRADES_ROW_UNKEYED"));
        continue;
      }
      for (const leg of row.legs) {
        if (leg.venueOrderId !== null && leg.shares !== null) {
          const bound = bounds.get(leg.venueOrderId);
          if (bound === undefined) bounds.set(leg.venueOrderId, { tokenId: leg.tokenId, side: leg.side, shares: leg.shares, shown: leg.inFull !== null });
          else {
            bound.shares = addDecimal(bound.shares, leg.shares);
            bound.tokenId ??= leg.tokenId;
            bound.side ??= leg.side;
            bound.shown ||= leg.inFull !== null;
          }
        }
        if (leg.inFull === null) {
          fragments.push({ leg, row });
          continue;
        }
        const full = leg.inFull;
        const same = groups.find((group) => group.leg.venueOrderId === full.venueOrderId && sameFillOfLegs(group.leg, full));
        // The row's own fragments: its status and hash as read, and which of them were unreadable (named, r11).
        const entry: RowFacts = { status: row.status, hash: row.transactionHash, unreadable: row.unreadable.filter((name): name is "status" | "transactionHash" => name === "status" || name === "transactionHash") };
        if (same === undefined) groups.push({ leg: full, count: 1, statuses: [entry] });
        else {
          same.count += 1;
          same.statuses.push(entry);
        }
      }
    }
    for (const [venueOrderId, bound] of bounds) {
      const known = this.#evidence.order(venueOrderId)?.legSum ?? "0";
      const filled = oms.orders().find((order) => order.venueOrderId === venueOrderId)?.filledShares ?? "0";
      const atLeast = addDecimal(compareDecimal(filled, known) > 0 ? filled : known, bound.shares);
      this.#observe(namedOrder(venueOrderId, "TRADES_LEG_UNKEYED", { provenance: bound.shown ? "SHOWN" : "NAMED", tokenId: bound.tokenId, side: bound.side, size: atLeast }));
    }
    // One record per (fill, status, hash) the rows showed, each with the fill's whole count: no status is dropped.
    for (const group of groups) {
      const seen = new Set<string>();
      for (const { status, hash, unreadable } of group.statuses) {
        const key = compositeKey(status ?? "\u0000", hash ?? "\u0000", ...unreadable);
        if (seen.has(key)) continue;
        seen.add(key);
        this.#observe(unkeyedLegRecord(group.leg, status, group.count, whole, hash, unreadable));
      }
    }
    for (const { leg, row } of fragments) {
      const rowUnreadable = row.unreadable.filter((name) => name === "status" || name === "transactionHash");
      this.#observe(unkeyedFragmentsLegRecord({ ...partialLeg(leg), unreadable: [...leg.unreadable, ...rowUnreadable] }, row.status, 1, "TRADES_LEG_UNKEYED_FRAGMENTS", row.transactionHash));
    }
  }

  /**
   * Journal every observation folded during the reads, in order. A failed append keeps it in memory (folded into the
   * next rebuild, and appended again), and the run concludes nothing (`journalOk`): what justified its holds is not
   * durable yet.
   */
  async #flushEvidence(run: RunState, atMs: number): Promise<void> {
    for (const record of this.#evidenceQueue.splice(0)) if (!(await this.#appendEvidence(run.runId, record, atMs))) run.journalOk = false;
  }

  /**
   * Fold one record and, when it adds information, journal it at once (the stream between runs; a release; a
   * settlement). `false` when its append failed (it is kept in memory, appended again by the next run).
   */
  async #recordEvidenceNow(runId: string | null, record: EvidenceRecord, atMs: number): Promise<boolean> {
    this.#ensureEvidence();
    return this.#evidence.add(record) ? this.#appendEvidence(runId, record, atMs) : true;
  }

  /** Journal one record; a failed append keeps it in memory (folded into the next rebuild, appended again). `false` when it failed. */
  async #appendEvidence(runId: string | null, record: EvidenceRecord, atMs: number): Promise<boolean> {
    const appended = await this.#append({ kind: "EVIDENCE_RECORDED", runId, ...record, atMs });
    if (!appended.ok) this.#pendingEvidence.push(record);
    return appended.ok;
  }

  /**
   * Whether every venue order and trade this run had to judge was judged without a conflict, and every order with
   * unsettled evidence has a verdict (the evidence store's verdicts; a booking and an ABSENT need it).
   */
  #evidenceJudged(run: RunState): boolean {
    if (!run.evidenceReadable) return false;
    for (const verdict of run.verdicts.values()) if (verdict.kind === "CONFLICT") return false;
    for (const verdict of run.tradeVerdicts.values()) if (verdict.kind === "CONFLICT") return false;
    for (const id of this.#evidence.unsettled()) {
      const verdict = run.verdicts.get(id);
      if (verdict === undefined || verdict.kind === "UNREAD") return false;
    }
    return true;
  }

  async #append(event: JournalInput): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }> {
    try {
      const result: unknown = await this.#deps.journal.append(event);
      if (readOkFlag(result)) return { ok: true };
      return { ok: false, code: readRefusalCode(result), message: "the journal refused the event" };
    } catch {
      return { ok: false, code: "JOURNAL_THREW", message: "the journal threw" };
    }
  }

  async #recordAnswer(
    run: RunState,
    channel: "ORDER" | "WALLET_OPERATION" | "USER_STREAM",
    requestId: string,
    subjectId: string,
    verdict: string,
    accepted: boolean,
    refusalCode: string | null,
  ): Promise<void> {
    run.answers.push(Object.freeze({ channel, requestId, subjectId, verdict, accepted, refusalCode }));
    // Recorded even when the clock cannot be read now: the latest sound reading stands in for the time.
    const atMs = this.#now() ?? Math.max(this.#lastClock, 0);
    const result = await this.#append({ kind: "ANSWER_RECORDED", runId: run.runId, channel, requestId, subjectId, verdict, accepted, refusalCode, atMs });
    if (!result.ok) {
      this.#detect(run, {
        breakClass: "COMPONENT_UNAVAILABLE",
        subjectKey: compositeKey("COMPONENT_UNAVAILABLE", "journal"),
        detail: `an answer could not be recorded: ${result.code}`,
      });
    }
  }

  #now(): number | null {
    let value: unknown;
    try {
      value = this.#deps.clock.now();
    } catch {
      value = undefined;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      this.#clockFault();
      return null;
    }
    if (value < this.#lastClock) {
      // A backwards step: this reading is never used (not as a receipt time, not as a read time), and later readings
      // are judged from it, so one step back faults once rather than until the clock catches up.
      this.#clockFault();
      this.#lastClock = value;
      return null;
    }
    this.#lastClock = value;
    return value;
  }

  /**
   * The clock was unreadable or went backwards: no earlier reading can be
   * trusted to measure quiescence. Every pending request's window restarts
   * from the next sound reading (`#stampUnclockedRequests`: later, so
   * conservative), so ABSENT stays reachable without trusting the fault.
   */
  #clockFault(): void {
    this.#clockFaultSeq = this.#seq;
    for (const [key, entry] of this.#omsRequests) if (entry.atMs !== null) this.#omsRequests.set(key, Object.freeze({ ...entry, atMs: null }));
  }

  /**
   * THE RUN-VALIDITY LATCH (r5, r6 class D): the ONE helper every commit point of a run calls immediately before it
   * commits, after every await that preceded it: an OMS answer, a wallet answer, a stream acknowledgement, each
   * fill delivery and settlement or economics probe written to the OMS, each act, each UNATTRIBUTED booking, each
   * break resolution (`#resolve`), each evidence settlement, the decision to pass, and the resume. `false` LATCHES
   * the run: from then on it concludes nothing more.
   *
   * What invalidates a run:
   * - a CLOCK FAULT detected at any point of the run (its reads; the record of an answer; a request received
   *   meanwhile; the run's closing reading; an operator's release attempted meanwhile, inside an awaited call
   *   included): no earlier reading of the run can be trusted to measure anything (the quiescence an ABSENT
   *   attests, the time a delta was confirmed over). The run is STALE (`READ_STALE`, a hold); `#clockFault` has
   *   restarted every pending OMS request's quiescence window, so only a later run may answer what this one
   *   withheld. A fault before the run started (`runStartSeq`) is not this run's: its reads all came after it;
   * - a FAULTED JOURNAL: nothing more can be recorded, so nothing more is concluded (an answer given would not be
   *   journaled).
   * Recording a hold (a break opened or quarantined, an evidence observation, an answer already given) is never
   * withheld: it only ever keeps the account held. What a run committed before the fault was detected stands.
   */
  #mayCommit(run: RunState): boolean {
    let journalFaulted: boolean;
    try {
      journalFaulted = this.#deps.journal.faulted === true;
    } catch {
      journalFaulted = true;
    }
    if (journalFaulted) {
      run.journalOk = false;
      return false;
    }
    if (this.#clockFaultSeq < run.runStartSeq) return true;
    run.clockFaulted = true;
    run.stale = true;
    this.#detect(run, {
      breakClass: "READ_STALE",
      subjectKey: compositeKey("READ_STALE", "run"),
      detail:
        "the clock was unreadable or went backwards during the run: nothing more is concluded from it (no further answer, booking, action, clearing or resume), and every pending request's quiescence window restarts",
    });
    return false;
  }

  #drawId(): string | undefined {
    let id: unknown;
    try {
      id = this.#deps.newId();
    } catch {
      return undefined;
    }
    if (!isUuidV7(id) || this.#usedIds.has(id)) return undefined;
    this.#usedIds.add(id);
    return id;
  }

  /** The token an execution group trades (`tokenOfGroup`); `null` when unknown, unreadable or not a token id. */
  #groupToken(executionGroupId: string): string | null {
    let token: unknown;
    try {
      token = this.#deps.tokenOfGroup(executionGroupId);
    } catch {
      token = null;
    }
    return isTokenId(token) ? token : null;
  }

  #marketOf(tokenId: string): { readonly scope: BreakScope; readonly marketId: string | null } {
    let market: unknown;
    try {
      market = this.#deps.marketOfToken(tokenId);
    } catch {
      market = null;
    }
    return this.#marketScope(typeof market === "string" ? market : null);
  }

  #marketScope(marketId: string | null): { readonly scope: BreakScope; readonly marketId: string | null } {
    return marketId !== null && isUuidV7(marketId) ? { scope: "MARKET", marketId } : { scope: "ACCOUNT", marketId: null };
  }

  /** The account's venue orders no OMS order or attempt tracks. */
  #unclaimed(oms: ReconciledOms, view: OrderTradeView): VenueOrderView[] {
    const claimed = claimedVenueIds(oms.orders(), oms.attempts());
    return [...view.venueOrders.values()].filter((order) => !claimed.has(order.venueOrderId));
  }

  #potentialOwners(oms: ReconciledOms): PotentialOwner[] {
    return oms
      .attempts()
      .filter(couldHavePlaced)
      .map((attempt) => ({ attemptId: attempt.submissionAttemptId, facts: this.#attemptFacts.get(attempt.submissionAttemptId) ?? null }));
  }
}

// ---------------------------------------------------------------------------
// Module helpers.

interface RunReads {
  readonly open: ReadOutcome<readonly VenueOrderView[]>;
  readonly trades: ReadOutcome<readonly VenueTradeView[]>;
  readonly byId: ReadonlyMap<string, ReadOutcome<VenueOrderView | null>>;
  readonly positions: ReadOutcome<ReadonlyMap<string, DecimalString>>;
  readonly collateral: ReadOutcome<DecimalString>;
  readonly approvals: ReadOutcome<ReadonlyMap<string, boolean>>;
  readonly projected: ReadOutcome<ProjectedHoldingsRead>;
  /** What the ledger still books of each FAILED fill the trades read shows, by `compositeKey(trade, order)`. */
  readonly bookings: ReadOutcome<ReadonlyMap<string, readonly BookedAmount[]>>;
  readonly walletMembers: ReadonlyMap<string, ReadOutcome<WalletMemberRead>>;
}

/** (r11) The readable facts of one leg's fragments (`door.ts`), with the names of those that were unreadable. */
function partialLeg(leg: LegFragments): PartialLeg {
  return {
    venueOrderId: leg.venueOrderId,
    tokenId: leg.tokenId,
    side: leg.side,
    shares: leg.shares,
    price: leg.price,
    feeAmount: leg.feeAmount,
    feeAssetId: leg.feeAssetId,
    role: leg.role,
    matchedAt: leg.matchedAt,
    unreadable: leg.unreadable,
  };
}

/** A leg's facts as the evidence store records them: every fill fact the read fixed (r7, WP290-CX-R7-02). */
function legFacts(leg: VenueTradeLeg): LegFacts {
  return {
    venueOrderId: leg.venueOrderId,
    tokenId: leg.tokenId,
    side: leg.side,
    shares: leg.shares,
    price: leg.price,
    feeAmount: leg.feeAmount,
    feeAssetId: leg.feeAssetId,
    role: leg.role,
    matchedAt: leg.matchedAt,
  };
}

/**
 * (r11, the stream door) The evidence one routed user-stream item the OMS did not apply carries (WP-280's normalized
 * OMS inputs, `door.ts`'s fragments): EVERY fragment it validated, never guessed, and the names of those it did not:
 * - an order observation: its order and status (`STREAM_ORDER`); its order id unreadable, an `UNKEYED_ORDER`;
 * - a fill: its trade, order, shares, price, fee, fee asset, role and match time (`STREAM_FILL`); a settlement: its
 *   trade, order and status (`STREAM_SETTLEMENT`). Its order id unreadable: an `ORPHAN_LEG` of the trade. Its trade id
 *   unreadable: an `UNKEYED_LEG` no read can answer (the stream is not an answer that shows every trade).
 */
function streamRecords(item: StreamItemFragments): readonly EvidenceRecord[] {
  if (item.kind === "ORDER") {
    if (item.venueOrderId !== null) return [namedOrder(item.venueOrderId, "STREAM_ORDER", { status: item.status, unreadable: item.unreadable })];
    return [
      unkeyedOrderRecord(
        {
          venueOrderId: null,
          tokenId: null,
          side: null,
          price: null,
          originalSize: null,
          sizeMatched: null,
          status: item.status,
          unreadable: item.unreadable.filter((name): name is "venueOrderId" | "status" => name === "venueOrderId" || name === "status"),
        },
        "STREAM_ORDER_UNKEYED",
      ),
    ];
  }
  const leg: PartialLeg = {
    venueOrderId: item.venueOrderId,
    tokenId: null,
    side: null,
    shares: item.shares,
    price: item.price,
    feeAmount: item.feeAmount,
    feeAssetId: item.feeAssetId,
    role: item.role,
    matchedAt: item.matchedAt,
    unreadable: item.unreadable.map((name) => (name === "liquidityRole" ? "role" : name)).filter((name) => name !== "venueTradeId" && name !== "venueOrderId" && name !== "status"),
  };
  const status = item.kind === "SETTLEMENT" ? item.status : null;
  const fill = item.kind === "FILL";
  if (item.venueTradeId === null) {
    return [unkeyedFragmentsLegRecord({ ...leg, unreadable: [...leg.unreadable, ...item.unreadable.filter((name) => name === "venueOrderId" || name === "status")] }, status, 1, fill ? "STREAM_FILL_UNKEYED" : "STREAM_SETTLEMENT_UNKEYED", item.transactionHash)];
  }
  if (item.venueOrderId === null) {
    return [orphanLegRecord(item.venueTradeId, { ...leg, unreadable: [...leg.unreadable, ...item.unreadable.filter((name) => name === "status")] }, status, fill ? "STREAM_FILL_ORPHAN" : "STREAM_SETTLEMENT_ORPHAN", item.transactionHash)];
  }
  return [
    legRecord(
      item.venueTradeId,
      { venueOrderId: item.venueOrderId, tokenId: null, side: null, shares: item.shares, price: item.price, feeAmount: item.feeAmount, feeAssetId: item.feeAssetId, role: item.role, matchedAt: item.matchedAt },
      status,
      "NAMED",
      fill ? "STREAM_FILL" : "STREAM_SETTLEMENT",
      [...leg.unreadable, ...item.unreadable.filter((name) => name === "status")],
      item.transactionHash,
    ),
  ];
}

/** (r14) Every fill fact of a leg, named: an orphan leg the event attributes to the account fixes none of them. */
const EVENT_ORPHAN_UNREADABLE: readonly string[] = ["feeAmount", "feeAssetId", "matchedAt", "price", "role", "shares", "side", "tokenId", "venueOrderId"];

/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) The stream-NAMED evidence an activity output's EVENT carries
 * (`door.ts`, `StreamEventFragments`), whatever its projection carried:
 * - an order event: its order, NAMED (`STREAM_ORDER`), with every fact the event stated (token, side, price, sizes,
 *   status) and the names of those it did not: the order is read by id until a sound run settles it, its matched size
 *   is a lower bound a later read may not go below, and while it stands no attempt is answered ABSENT for it;
 * - a trade event: its trade (`STREAM_TRADE`: its identity OPEN until a valid trades row shows its own legs in full),
 *   and each leg the event attributes to the account (`STREAM_SETTLEMENT`: the trade and the order, no economics: the
 *   stream fixes no fill fact exactly), its status when it can be ordered, else `unordered` (`status` named: only an
 *   observation of the trade at a terminal status answers it); an own leg whose order id cannot be read is an ORPHAN_LEG.
 * An event whose identity cannot be read carries nothing here; when it was required, it is the door's unreadable entry.
 */
function streamEventRecords(event: StreamEventFragments): readonly EvidenceRecord[] {
  if (event.kind === "ORDER") {
    if (event.venueOrderId === null) return [];
    const unreadable = event.unreadable.map((name) => (name === "assetId" ? "tokenId" : name)).filter((name): name is "tokenId" | "side" | "price" | "originalSize" | "sizeMatched" | "status" => name !== "venueOrderId");
    return [
      orderFragmentsRecord(
        {
          venueOrderId: event.venueOrderId,
          tokenId: event.tokenId,
          side: event.side,
          price: event.price,
          originalSize: event.originalSize,
          sizeMatched: event.sizeMatched,
          status: event.status,
          unreadable,
          inFull: null,
        },
        "STREAM_ORDER",
      ),
    ];
  }
  const tradeId = event.venueTradeId;
  if (tradeId === null) return [];
  const status = event.ordered ? event.status : null;
  const statusNames = event.ordered ? [] : ["status"];
  const out: EvidenceRecord[] = [
    tradeRecord(tradeId, status, "STREAM_TRADE", {
      transactionHash: event.transactionHash,
      ownershipUndetermined: !event.legsDetermined,
      unreadable: event.unreadable.filter((name) => name !== "venueTradeId"),
    }),
  ];
  for (const venueOrderId of event.ownOrderIds) {
    out.push(legRecord(tradeId, { venueOrderId, tokenId: null, side: null, shares: null, price: null }, status, "NAMED", "STREAM_SETTLEMENT", statusNames, event.transactionHash));
  }
  if (event.ownOrphans > 0) {
    out.push(
      orphanLegRecord(
        tradeId,
        { venueOrderId: null, tokenId: null, side: null, shares: null, price: null, feeAmount: null, feeAssetId: null, role: null, matchedAt: null, unreadable: [...EVENT_ORPHAN_UNREADABLE, ...statusNames] },
        status,
        "STREAM_SETTLEMENT_ORPHAN",
        event.transactionHash,
      ),
    );
  }
  return out;
}

/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) The stream-NAMED evidence a WP-280 reconciliation request carries
 * (`door.ts`, `StreamRequestFragments`), whatever its usability:
 * - the trade it names: `STREAM_TRADE`, its identity OPEN (only a valid row showing its own legs in full answers it),
 *   (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED) with `eventStatus`, the status of the event the request was raised for
 *   when it is established ({@link requestEventStatus}), else `unordered`: a request carries no status, and "WP-280
 *   recognised it" (an `EVENT_NOT_FULLY_APPLICABLE` with no status shortfall: r14's rule) does not say which (FAILED is
 *   one it recognises). The
 *   orders a trade's request names are every order the trade matched, the counterparties' included (`manager.ts`,
 *   `eventScope`): which are the account's is exactly what that open identity is answered by, so they are not
 *   recorded as the account's orders (no venue document describes a by-id read of another account's order, E-14
 *   covers the account's own, and a NAMED id the by-id read does not find is a ghost: an operator's quarantine);
 * - with no trade: the orders it names (an order event's own order): NAMED, read by id until a sound run settles them;
 * - an identity it names that cannot be read: an obligation of the account (`UNKEYED_TRADE` for its trade, or an
 *   `UNKEYED_ORDER` for its orders).
 */
function streamRequestRecords(request: StreamRequestFragments, eventStatus: string | null): readonly EvidenceRecord[] {
  if (request.venueTradeId !== null) {
    return [tradeRecord(request.venueTradeId, eventStatus, "STREAM_TRADE", { unreadable: [...(eventStatus === null ? ["status"] : []), ...request.unreadable] })];
  }
  if (request.unreadable.includes("venueTradeId")) {
    return [unkeyedTradeRecord({ status: null, transactionHash: null, ownershipUndetermined: null, unreadable: ["venueTradeId"] }, "STREAM_UNREADABLE")];
  }
  const out: EvidenceRecord[] = request.venueOrderIds.map((venueOrderId) => namedOrder(venueOrderId, "STREAM_ORDER", { unreadable: ["status"] }));
  if (request.unreadable.includes("venueOrderIds")) {
    out.push(unkeyedOrderRecord({ venueOrderId: null, tokenId: null, side: null, price: null, originalSize: null, sizeMatched: null, status: null, unreadable: ["venueOrderId"] }, "STREAM_ORDER_UNKEYED"));
  }
  return out;
}

/**
 * (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED) The settlement status of the event a WP-280 request was raised for, when it
 * is ESTABLISHED, else `null` (the request's trade is then `unordered`: only an observation of it at a terminal status
 * answers it). It is established only by that event's own output, received IMMEDIATELY before the request (`previous`;
 * WP-280 emits an event's `EVENT_NOT_FULLY_APPLICABLE` request right after its output, `manager.ts` `#onFrame`): the
 * request is an `EVENT_NOT_FULLY_APPLICABLE` whose status WP-280 recognised, and `previous` is a TRADE output whose
 * event names the same trade at an ORDERED status and whose projection carried exactly the request's shortfalls, in
 * the same order. Nothing else establishes it: the request carries no status, and an earlier observation of the same
 * trade (an earlier event, a read) says nothing of THIS event's (r14 resumed with a FAILED event missed when the
 * request was its only surviving word and a lagging read showed the trade MATCHED). An `EVENT_NOT_DELIVERED` request
 * never names a status (its output was not taken), and a request pulled from WP-280's backlog has no `previous`
 * (`undefined`: no event). A request that names no trade records no trade status (its order event's status is not
 * used: {@link streamRequestRecords}).
 *
 * WP-280's contract this relies on (`manager.ts` `#flush`): an ORDER or TRADE output the listener did not take is
 * followed by its own `EVENT_NOT_DELIVERED` request (unordered). So a request whose own output this coordinator never
 * received, but which came right after an EARLIER output of the same trade with the same shortfalls (two listener
 * failures: that earlier output's request, and this request's output), is matched with the wrong event here, and its
 * trade is still `unordered` by the `EVENT_NOT_DELIVERED` request that follows (delivered, or pulled from the backlog).
 */
function requestEventStatus(request: StreamRequestFragments, previous: unknown): string | null {
  // `statusRecognised` holds only for an EVENT_NOT_FULLY_APPLICABLE request (`door.ts`).
  if (!request.statusRecognised) return null;
  const output = readStreamOutput(previous);
  const event = output.event;
  // (An order event names no trade: its `venueTradeId` is `null`.)
  if (event === undefined || event.venueTradeId !== request.venueTradeId) return null;
  const requested = request.shortfalls;
  const projected = output.shortfalls;
  if (requested === null || projected === undefined || projected.length !== requested.length || projected.some((entry, index) => entry !== requested[index])) return null;
  // A TRADE event's `status` is its ORDERED status, `null` when it cannot be ordered (`door.ts`, `readEventFragments`).
  return event.status;
}

/** (r14) The subjects a stream request's acknowledgement waits on ({@link streamRequestRecords}). */
function streamRequestSubjects(request: StreamRequestFragments): StreamRequestSubjects {
  if (request.venueTradeId !== null) return Object.freeze({ trades: Object.freeze([request.venueTradeId]), orders: Object.freeze([]), unreadable: false });
  const unreadable = request.unreadable.includes("venueTradeId") || request.unreadable.includes("venueOrderIds");
  return Object.freeze({ trades: Object.freeze([]), orders: Object.freeze([...request.venueOrderIds]), unreadable });
}

/** Every own leg of a FAILED trade in a valid trades read, by the venue's identity (frozen: handed to a port). */
function failedFillsOf(trades: ReadOutcome<readonly VenueTradeView[]>): readonly FillIdentity[] {
  if (trades.kind !== "OK") return Object.freeze([]);
  const out: FillIdentity[] = [];
  for (const trade of trades.value) {
    if (tradeStatusOf(trade.status) !== "FAILED") continue;
    for (const leg of trade.ownLegs) out.push(Object.freeze({ venueTradeId: trade.venueTradeId, venueOrderId: leg.venueOrderId }));
  }
  return Object.freeze(out);
}

/** The run's view, built only from the evidence store's verdicts (`#assembleOrderView`). */
interface OrderTradeView {
  /** The venue orders judged CONSISTENT (the only ones anything is answered, compared or classified from). */
  readonly venueOrders: ReadonlyMap<string, VenueOrderView>;
  /** Venue order ids judged MISSING (claimed, or without evidence, and not found by id). */
  readonly missing: ReadonlySet<string>;
  /** Unclaimed venue order ids judged GHOST (only named, not found by id, not settled). */
  readonly ghosts: readonly string[];
  readonly legsByOrder: ReadonlyMap<string, readonly { readonly leg: VenueTradeLeg; readonly trade: VenueTradeView; readonly status: VenueTradeStatus | null }[]>;
}

function failed<T>(): ReadOutcome<T> {
  return Object.freeze({ kind: "FAILED", salvage: EMPTY_SALVAGE });
}

function notRun(triggers: readonly ReconciliationTrigger[], reason: string): RunReport {
  return Object.freeze({
    runId: null,
    status: "NOT_RUN",
    resumed: false,
    triggers: Object.freeze([...triggers]),
    detections: Object.freeze([]),
    answers: Object.freeze([]),
    rerun: false,
    reason,
  });
}

function detection(partial: Partial<Detection> & Pick<Detection, "breakClass" | "subjectKey" | "detail">): Detection {
  const scope = partial.scope ?? "ACCOUNT";
  const marketId = scope === "MARKET" ? partial.marketId ?? null : null;
  return Object.freeze({
    breakClass: partial.breakClass,
    subjectKey: partial.subjectKey,
    scope: marketId === null ? "ACCOUNT" : "MARKET",
    marketId,
    orderId: partial.orderId !== undefined && partial.orderId !== null && isUuidV7(partial.orderId) ? partial.orderId : null,
    walletOperationId: partial.walletOperationId ?? null,
    assetId: partial.assetId !== undefined && partial.assetId !== null && isIdentifier(partial.assetId) ? partial.assetId : null,
    expectedValue: partial.expectedValue ?? null,
    observedValue: partial.observedValue ?? null,
    detail: freezeDetail(partial.detail),
    ledgerTransactionId: partial.ledgerTransactionId ?? null,
    act: partial.act ?? null,
  });
}

/**
 * The subject of one halt obligation the ledger records: its transaction, its movement kind, its asset, its market
 * (or none), and its place among records equal in all four. A correction booked by `#bookUnattributed` records
 * exactly one `ACTUAL_ARRIVAL` (place 0), so booking and recovery derive the same subject.
 */
function arrivalSubject(ledgerTransactionId: string, kind: "ACTUAL_ARRIVAL" | "UNEXPLAINED_MOVEMENT", assetId: string, marketId: string | null, place: number): string {
  return compositeKey("ledger-arrival", ledgerTransactionId, kind, assetId, marketId ?? "", String(place));
}

/** An unresolved attempt could own the venue order this leg is on (its facts unknown, or the leg's token and side unknown or its own). */
function ownable(owners: readonly PotentialOwner[], leg: { readonly tokenId: string | null; readonly side: "BUY" | "SELL" | null }): boolean {
  return owners.some((owner) => owner.facts === null || leg.tokenId === null || leg.side === null || (owner.facts.tokenId === leg.tokenId && owner.facts.side === leg.side));
}

function claimedVenueIds(orders: readonly OrderView[], attempts: readonly AttemptView[]): Set<string> {
  const out = new Set<string>();
  for (const order of orders) if (order.venueOrderId !== null) out.add(order.venueOrderId);
  for (const attempt of attempts) if (attempt.venueOrderId !== null) out.add(attempt.venueOrderId);
  return out;
}

/** A tracked order's fixed facts equal the venue's: its token (its group's), side, limit price and original size. */
function sameOrderFacts(order: OrderView, venue: VenueOrderView, tokenId: string): boolean {
  return (
    venue.tokenId === tokenId &&
    order.side === venue.side &&
    compareDecimal(order.limitPrice, venue.price) === 0 &&
    compareDecimal(order.originalShares, venue.originalSize) === 0
  );
}

/** A leg as the OMS's `FillReport` (discriminator omitted: the OMS's `"0"`, one fill per trade and order). */
function fillReportOf(leg: VenueTradeLeg, trade: VenueTradeView): Readonly<Record<string, unknown>> {
  return Object.freeze({
    venueTradeId: trade.venueTradeId,
    venueOrderId: leg.venueOrderId,
    shares: leg.shares,
    price: leg.price,
    liquidityRole: leg.role,
    feeAmount: leg.feeAmount,
    feeAssetId: leg.feeAssetId,
    matchedAt: leg.matchedAt,
  });
}

function factsOf(request: OmsReconciliationRequest): AttemptFacts {
  return Object.freeze({
    attemptId: request.submissionAttemptId,
    marketId: request.marketId,
    tokenId: request.tokenId,
    side: request.side,
    limitPrice: request.limitPrice,
    originalShares: request.originalShares,
  });
}

/**
 * The members a wallet request must have answered, by name: its `unresolvedTransactions`, or, when it names
 * none (the inventory's simple mode: one identity, nothing weighed), every hash and relayer id it carries.
 * Empty when the operation never named a transaction.
 */
function walletMembersOf(request: WalletReconciliationRequest): readonly string[] {
  if (request.unresolvedTransactions.length > 0) return request.unresolvedTransactions;
  return [...request.transactionHashes.map((hash) => `hash:${hash}`), ...request.transactionIds.map((id) => `id:${id}`)];
}

/** `hash:<h>` and `id:<i>` (the inventory's member names); `null` for `operation` or anything else. */
function parseMember(member: string): { readonly kind: "HASH" | "RELAYER_ID"; readonly value: string } | null {
  if (member.startsWith("hash:") && isIdentifier(member.slice(5))) return { kind: "HASH", value: member.slice(5) };
  if (member.startsWith("id:") && isIdentifier(member.slice(3))) return { kind: "RELAYER_ID", value: member.slice(3) };
  return null;
}

function readOmsRequest(raw: unknown): OmsReconciliationRequest | undefined {
  const fields = readFields(raw, [
    "requestId",
    "purpose",
    "submissionAttemptId",
    "orderId",
    "executionGroupId",
    "marketId",
    "tokenId",
    "side",
    "limitPrice",
    "originalShares",
    "venueOrderId",
    "salt",
    "expectedOrderHash",
    "signedIdentity",
  ]);
  if (fields === undefined) return undefined;
  if (!isText(fields.requestId, MAX_REQUEST_ID)) return undefined;
  if (fields.purpose !== "SUBMISSION_UNKNOWN" && fields.purpose !== "ORDER_STATE" && fields.purpose !== "FINAL_SIZE") return undefined;
  if (!isUuidV7(fields.submissionAttemptId) || !isUuidV7(fields.orderId) || !isUuidV7(fields.executionGroupId) || !isUuidV7(fields.marketId)) return undefined;
  if (!isTokenId(fields.tokenId) || (fields.side !== "BUY" && fields.side !== "SELL")) return undefined;
  if (!isUnitPrice(fields.limitPrice) || !isPositiveAmount(fields.originalShares)) return undefined;
  if (!(fields.venueOrderId === null || isVenueId(fields.venueOrderId)) || !isIdentifier(fields.salt)) return undefined;
  // The expected order hash is STOPPED (WP-270): it is null, and unused here even if a later OMS sets it.
  if (!(fields.expectedOrderHash === null || isIdentifier(fields.expectedOrderHash))) return undefined;
  return Object.freeze({
    requestId: fields.requestId,
    purpose: fields.purpose,
    submissionAttemptId: fields.submissionAttemptId,
    orderId: fields.orderId,
    executionGroupId: fields.executionGroupId,
    marketId: fields.marketId,
    tokenId: fields.tokenId,
    side: fields.side,
    limitPrice: fields.limitPrice,
    originalShares: fields.originalShares,
    venueOrderId: fields.venueOrderId,
    salt: fields.salt,
    expectedOrderHash: fields.expectedOrderHash,
    // The signed identity is not needed beyond the economics the reads show (identity.ts); it is not kept.
    signedIdentity: null,
  });
}

function readWalletRequest(raw: unknown): WalletReconciliationRequest | undefined {
  const fields = readFields(raw, ["requestId", "trigger", "walletOperationId", "accountRef", "reason", "transactionHashes", "transactionIds", "unresolvedTransactions"]);
  if (fields === undefined || !isText(fields.requestId, MAX_REQUEST_ID) || !isIdentifier(fields.walletOperationId) || !isIdentifier(fields.accountRef)) return undefined;
  if (fields.trigger !== "WALLET_OPERATION_UNKNOWN" && fields.trigger !== "POSITION_BALANCE_DISCREPANCY") return undefined;
  const lists = [fields.transactionHashes, fields.transactionIds, fields.unresolvedTransactions].map((value) => readArray(value, 10_000));
  if (lists.some((list) => list === undefined || list.some((entry) => !isText(entry, MAX_REQUEST_ID)))) return undefined;
  const [hashes, ids, unresolved] = lists as (readonly string[])[];
  return Object.freeze({
    requestId: fields.requestId,
    trigger: fields.trigger,
    walletOperationId: fields.walletOperationId,
    accountRef: fields.accountRef,
    reason: typeof fields.reason === "string" ? fields.reason.slice(0, MAX_DETAIL) : "",
    transactionHashes: Object.freeze([...(hashes as readonly string[])]),
    transactionIds: Object.freeze([...(ids as readonly string[])]),
    unresolvedTransactions: Object.freeze([...(unresolved as readonly string[])]),
  });
}

function checkDependencies(deps: unknown): string | undefined {
  const fields = readFields(deps, ["reads", "journal", "holdings", "clock", "newId", "marketOfToken", "tokenOfGroup", "policy"]);
  if (fields === undefined) return "the dependencies must be own data";
  for (const key of ["reads", "journal", "holdings", "clock"] as const) {
    if (fields[key] === null || typeof fields[key] !== "object") return `${key} is required`;
  }
  for (const key of ["newId", "marketOfToken", "tokenOfGroup"] as const) if (typeof fields[key] !== "function") return `${key} must be a function`;
  const policy = readFields(fields.policy, [
    "accountRef",
    "collateralAssetId",
    "quiescenceHorizonMs",
    "maxReadSpanMs",
    "holdingConfirmationMs",
    "requiredApprovalSpenders",
  ]);
  if (policy === undefined) return "policy must be own data";
  if (!isIdentifier(policy.accountRef) || !isIdentifier(policy.collateralAssetId)) return "policy needs the account and the collateral asset";
  for (const key of ["quiescenceHorizonMs", "maxReadSpanMs", "holdingConfirmationMs"] as const) {
    const value = policy[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_POLICY_MS) {
      return `policy.${key} must be a whole number of milliseconds in (0, ${String(MAX_POLICY_MS)}]; it has no default`;
    }
  }
  const spenders = readArray(policy.requiredApprovalSpenders, 1000);
  if (spenders === undefined || !spenders.every(isIdentifier)) return "policy.requiredApprovalSpenders must be a list of ids";
  return undefined;
}
