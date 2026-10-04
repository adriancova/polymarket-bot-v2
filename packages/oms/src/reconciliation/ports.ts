/**
 * The reconciliation coordinator's ports (WP-290; handoff §9.17).
 *
 * `packages/oms` is layer 1 (`docs/contracts/dependency-direction.md` §2). The
 * coordinator performs no I/O, reads no global clock, draws no randomness and
 * imports no adapter. Everything outside it is reached through these
 * structural interfaces, which a composition root binds:
 *
 * | Port | Bound to | Mirrors |
 * | --- | --- | --- |
 * | {@link AccountReadPort} | the secure adapter's authenticated reads (layer 2) | the CLOB and Data API v2 read routes below |
 * | {@link ReconciledOms} | `OrderManager` (this package, WP-270) | its public methods |
 * | {@link ReconciledWalletOperations} | `WalletOperationManager` (`packages/inventory`, WP-300) | its reconciliation methods |
 * | {@link ReconciledUserStream} | `UserStreamManager` (`packages/polymarket-secure`, WP-280) | its request backlog |
 * | {@link ReconciliationJournalPort} | `ReconciliationJournal` (`packages/ledger`, this package's other half) | the journal |
 * | {@link HoldingsPort} | the ledger projection and `buildUnattributedCorrection` (`packages/ledger`) | — |
 * | {@link HaltPort} | the incident controller (§9.9) | — |
 * | `tokenOfGroup` | the execution groups the composition registered with the OMS (`execution.groups`) | — |
 * | {@link ReconciliationClock} | a MONOTONIC epoch-millisecond clock | — |
 *
 * `packages/oms` may not import `packages/polymarket-secure` (layer 2, F12),
 * `packages/inventory` or `packages/ledger` (same layer, no §2.1 row, F13), so
 * those shapes are mirrored structurally here.
 * `test/fault-injection/reconciliation/port-conformance.test.ts` proves at
 * compile time that the real implementations satisfy these ports, and that
 * the break-class and event mirrors equal the ledger's.
 *
 * READ SURFACES (each cited from `docs/venue/verified-2026-09-30.md`; nothing
 * here is a venue fact that report does not record):
 *
 * | Read | Route tag | Source |
 * | --- | --- | --- |
 * | open orders | `/data/orders` | "Retrieves live orders for the authenticated user", cursor pagination (S-D55; E-14) |
 * | one order by id | `/data/order` | "including canceled or fully matched orders" (S-D57; E-14) |
 * | trades | `/data/trades` | paginated `{limit, next_cursor, count, data}`, `LTE=` ends; statuses prefixed or plain (S-D56; E-13, C-5) |
 * | positions | `/v2/positions` | Data API v2 only; v1 is retired on 2026-10-24 (S-D47, S-D58; E-15) |
 * | approvals | `/v2/approvals` | "Polygon token/operator approval state for one wallet" (S-D62; §W.8) |
 * | collateral | `ONCHAIN_ERC20_BALANCE` | pUSD is a "standard ERC-20" (§W.8). The CLOB balance-allowance read is NOT accepted: its response is undocumented (U-22) and its cache is not current until an L2-authenticated refresh (§W.9) |
 * | a wallet transaction member | — | no relayer status read is documented; a hash is read on chain |
 *
 * The ADAPTER normalizes wire payloads into the shapes below (exact decimal
 * strings, ISO-8601 instants, the account's own trade legs). The coordinator
 * re-reads every answer at its door (`door.ts`) and treats anything outside
 * these shapes as a malformed read: never as an empty one.
 *
 * VISIBILITY (E-16): venue reads are per credential. The binding must read
 * with the credential that placed the orders; a second credential's orders
 * are invisible, so a multi-credential design is unreconcilable until an ADR
 * addresses it.
 */

import type { DecimalString } from "@polymarket-bot/decimal";

import type {
  AttemptView,
  OmsAlert,
  OrderView,
  RetainedEvidenceView,
} from "../order-manager.js";
import type { ReconciliationRequest } from "../ports.js";
import type { OmsResult } from "../refusals.js";

// ---------------------------------------------------------------------------
// The clock.

/**
 * Epoch milliseconds. MUST be monotonic (never stepped backwards or forwards
 * by a wall-clock correction): the quiescence attestation is a difference of
 * two readings, and a forward step would attest early. The coordinator treats
 * a reading below an earlier one as a stale run, and an unreadable one as no
 * reading at all.
 */
export interface ReconciliationClock {
  now(): number;
}

// ---------------------------------------------------------------------------
// Venue reads (normalized by the adapter; re-read at the door).

/** The order statuses the reads may report (the user channel's vocabulary, verified-2026-09-30 §W.4). */
export const VENUE_ORDER_STATUSES = ["LIVE", "MATCHED", "DELAYED", "UNMATCHED", "CANCELED"] as const;
export type VenueOrderStatus = (typeof VENUE_ORDER_STATUSES)[number];

/** Trade statuses (§W.4; E-13: REST serializes `TRADE_STATUS_<X>`, the stream `<X>`; both are accepted). */
export const VENUE_TRADE_STATUSES = ["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"] as const;
export type VenueTradeStatus = (typeof VENUE_TRADE_STATUSES)[number];

/** One order of the account, as a read reports it. */
export interface VenueOrderView {
  readonly venueOrderId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly price: DecimalString;
  readonly originalSize: DecimalString;
  readonly sizeMatched: DecimalString;
  readonly status: string;
}

/** One of the ACCOUNT'S OWN legs of a trade (the adapter decides ownership, as WP-280's projection does). */
export interface VenueTradeLeg {
  readonly venueOrderId: string;
  readonly role: "MAKER" | "TAKER";
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly shares: DecimalString;
  readonly price: DecimalString;
  /** The exact fee amount, or `null` when the read does not fix it (a fee RATE is not an amount; U-16). */
  readonly feeAmount: DecimalString | null;
  /** The asset the fee is charged in; required when the fee is above zero. */
  readonly feeAssetId: string | null;
  /** ISO-8601 instant. */
  readonly matchedAt: string;
}

export interface VenueTradeView {
  readonly venueTradeId: string;
  readonly status: string;
  readonly transactionHash: string | null;
  readonly ownLegs: readonly VenueTradeLeg[];
  /** A leg whose ownership the adapter could not establish (WP-280's `MAKER_LEG_OWNERSHIP_UNDETERMINED`). */
  readonly ownershipUndetermined: boolean;
}

/**
 * The authoritative reads. Every method may answer asynchronously, and may
 * throw or reject: either is a missing read, never an empty one. A paginated
 * read reports `complete: true` only when it reached the last page.
 */
export interface AccountReadPort {
  /** `{ route: "/data/orders", complete, orders: VenueOrderView[] }`: every live order of the account. */
  listOpenOrders(): Promise<unknown>;
  /** `{ route: "/data/order", found: true, order }` or `{ route: "/data/order", found: false }`. */
  readOrder(venueOrderId: string): Promise<unknown>;
  /** `{ route: "/data/trades", complete, trades: VenueTradeView[] }`: every trade of the account. */
  listTrades(): Promise<unknown>;
  /** `{ route: "/v2/positions", complete, positions: [{ tokenId, size }] }`: every position, whatever its status. */
  readPositions(): Promise<unknown>;
  /** `{ source: "ONCHAIN_ERC20_BALANCE", assetId, balance }`. */
  readCollateral(): Promise<unknown>;
  /** `{ route: "/v2/approvals", approvals: [{ spender, approved }] }`. */
  readApprovals(): Promise<unknown>;
  /**
   * One identity member of a wallet operation: `{ state, transactionHash, credited }` with `state` one of
   * `CONFIRMED`, `FAILED` (terminal) or `PENDING`, `DROPPED`, `NOT_FOUND`, `UNSUPPORTED` (not terminal).
   */
  readWalletMember(member: { readonly kind: "HASH" | "RELAYER_ID"; readonly value: string }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// The OMS (WP-270's `OrderManager`, structurally).

export interface ReconciledOms {
  readonly paused: boolean;
  readonly faulted: boolean;
  pause(): void;
  resume(): OmsResult<true>;
  attempts(): readonly AttemptView[];
  orders(): readonly OrderView[];
  /**
   * Every alert the instance raised, oldest first. APPEND-ONLY for the instance's life (`OrderManager` only
   * appends): an alert's identity is its ordinal here, with the instance's incarnation id (the id of the first run
   * that inspects the instance). A list that shrinks or changes an earlier entry holds the account
   * (`COMPONENT_UNAVAILABLE`).
   */
  alerts(): readonly OmsAlert[];
  retainedEvidence(): readonly RetainedEvidenceView[];
  outstandingReconciliations(): number;
  retryReconciliationRequests(): Promise<OmsResult<number>>;
  applyReconciliation(raw: unknown): Promise<OmsResult<AttemptView>>;
  applyOrderObservation(raw: unknown): Promise<OmsResult<OrderView>>;
  recordFill(raw: unknown): Promise<OmsResult<OrderView>>;
  applySettlement(raw: unknown): Promise<OmsResult<unknown>>;
  requestOrderReconciliation(orderId: string): Promise<OmsResult<OrderView>>;
}

/** The OMS's request, as the coordinator receives it (`ports.ts`). */
export type OmsReconciliationRequest = ReconciliationRequest;

// ---------------------------------------------------------------------------
// Wallet operations (WP-300's `WalletOperationManager`, structurally).

/** `packages/inventory`'s `ReconciliationRequest`. */
export interface WalletReconciliationRequest {
  readonly requestId: string;
  readonly trigger: "WALLET_OPERATION_UNKNOWN" | "POSITION_BALANCE_DISCREPANCY";
  readonly walletOperationId: string;
  readonly accountRef: string;
  readonly reason: string;
  readonly transactionHashes: readonly string[];
  readonly transactionIds: readonly string[];
  readonly unresolvedTransactions: readonly string[];
}

/** `packages/inventory`'s `WalletOperationEvent`. */
export interface WalletOperationEventView {
  readonly operationId: string;
  readonly ordinal: number;
  readonly previousState: string | null;
  readonly newState: string;
  readonly reason: string;
}

/** The fields of `packages/inventory`'s `WalletOperationView` the coordinator reads. */
export interface WalletOperationStateView {
  readonly operationId: string;
  readonly state: string;
  readonly quarantined: boolean;
  readonly unresolvedTransactions: readonly string[];
}

export type WalletPortResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly refusal: { readonly code: string; readonly message: string } };

export interface ReconciledWalletOperations {
  resolveByReconciliation(operationId: string, evidence: unknown): WalletPortResult;
  retryReconciliationRequests(): number;
  outstandingReconciliationRequests(): readonly WalletReconciliationRequest[];
  events(): readonly WalletOperationEventView[];
  operation(operationId: string): WalletOperationStateView | undefined;
}

// ---------------------------------------------------------------------------
// The user stream (WP-280's `UserStreamManager`, structurally).

/** The fields of `UserStreamReconciliationRequest` the coordinator reads. */
export interface StreamReconciliationRequest {
  readonly requestId: string;
  readonly cause: string;
  readonly markets: readonly string[];
}

export interface ReconciledUserStream {
  pendingReconciliationRequests(): readonly StreamReconciliationRequest[];
  acknowledgeReconciliationRequest(requestId: string): boolean;
}

// ---------------------------------------------------------------------------
// The journal (`packages/ledger`'s `ReconciliationJournal`, structurally).

/** The break classes (`packages/ledger/src/reconciliation/taxonomy.ts`); the conformance test pins equality. */
export type BreakClass =
  | "READ_MISSING"
  | "READ_MALFORMED"
  | "READ_INCOMPLETE"
  | "READ_WRONG_ROUTE"
  | "READ_STALE"
  | "READ_CONFLICT"
  | "READ_REGRESSION"
  | "STATUS_UNRECOGNISED"
  | "SIGNED_IDENTITY_AMBIGUOUS"
  | "ORDER_UNATTRIBUTED"
  | "ORDER_FACTS_MISMATCH"
  | "ORDER_STATE_MISMATCH"
  | "ORDER_UNRESOLVED"
  | "ORDER_TRADES_INCOMPLETE"
  | "ORDER_FILLS_AHEAD_OF_VENUE"
  | "ORDER_NOT_FOUND_BY_ID"
  | "TRADE_UNATTRIBUTED"
  | "TRADE_MISSING_IN_OMS"
  | "FILL_ECONOMICS_UNFIXED"
  | "FILL_REFUSED"
  | "FILL_MISMATCH"
  | "SETTLEMENT_REVERSAL_OWED"
  | "SETTLEMENT_FAILED"
  | "HOLDING_IN_TRANSIT_AMBIGUOUS"
  | "HOLDING_DELTA_UNCONFIRMED"
  | "POSITION_UNATTRIBUTED"
  | "BALANCE_UNATTRIBUTED"
  | "LEDGER_UNATTRIBUTED_ARRIVAL"
  | "WALLET_OPERATION_IN_FLIGHT"
  | "APPROVAL_MISSING"
  | "CORRECTION_FAILED"
  | "WALLET_MEMBER_PENDING"
  | "WALLET_MEMBER_UNREADABLE"
  | "WALLET_OPERATION_UNIDENTIFIABLE"
  | "WALLET_ANSWER_REFUSED"
  | "WALLET_REQUESTS_OUTSTANDING"
  | "WALLET_OPERATION_UNSETTLED"
  | "OMS_HALTING_ALERT"
  | "OMS_EVIDENCE_RETAINED"
  | "COMPONENT_UNAVAILABLE"
  | "ANSWER_REFUSED"
  | "HALT_DELIVERY_FAILED"
  | "REQUEST_MALFORMED";

export type BreakRule = "RESOLVE_IN_RUN" | "HOLD_UNTIL_CONSISTENT" | "QUARANTINE_UNTIL_RELEASED" | "UNATTRIBUTED_HALT";
export type BreakScope = "ACCOUNT" | "MARKET";
export type ReconciliationTrigger =
  | "STARTUP"
  | "PERIODIC_TIMER"
  | "USER_STREAM_RECONNECT"
  | "MARKET_STREAM_GAP"
  | "SUBMISSION_UNKNOWN"
  | "WALLET_OPERATION_UNKNOWN"
  | "MANUAL_REQUEST"
  | "POSITION_BALANCE_DISCREPANCY";

export type JournalInput =
  | {
      readonly kind: "RUN_STARTED";
      readonly runId: string;
      readonly accountRef: string;
      readonly trigger: ReconciliationTrigger;
      readonly triggers: readonly ReconciliationTrigger[];
      readonly atMs: number;
    }
  | {
      readonly kind: "RUN_COMPLETED";
      readonly runId: string;
      readonly status: "PASSED" | "FAILED" | "QUARANTINED";
      readonly ordersChecked: number;
      readonly fillsChecked: number;
      readonly walletOperationsChecked: number;
      readonly breaksFound: number;
      readonly detail: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "BREAK_OPENED";
      readonly breakId: string;
      readonly runId: string;
      readonly breakClass: BreakClass;
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
  | {
      readonly kind: "BREAK_QUARANTINED";
      readonly breakId: string;
      readonly runId: string;
      readonly resolutionLedgerTransactionId: string | null;
      readonly atMs: number;
    }
  | {
      readonly kind: "BREAK_RESOLVED";
      readonly breakId: string;
      readonly runId: string | null;
      readonly resolution: "RESOLVED_IN_RUN" | "NOT_REPRODUCED" | "OPERATOR_RELEASED";
      readonly operatorRef: string | null;
      readonly detail: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "ANSWER_RECORDED";
      readonly runId: string;
      readonly channel: "ORDER" | "WALLET_OPERATION" | "USER_STREAM";
      readonly requestId: string;
      readonly subjectId: string;
      readonly verdict: string;
      readonly accepted: boolean;
      readonly refusalCode: string | null;
      readonly atMs: number;
    }
  | { readonly kind: "RESUME_REFUSED"; readonly runId: string; readonly refusalCode: string; readonly atMs: number }
  | JournalEvidenceInput;

/**
 * One validated venue observation (r6, the EvidenceStore: `evidence.ts`), appended the moment it is made, so a
 * restart rebuilds the coordinator's evidence from the journal alone (`packages/ledger`'s `EvidenceRecordedEvent`).
 */
export interface JournalEvidenceInput {
  readonly kind: "EVIDENCE_RECORDED";
  readonly runId: string | null;
  readonly evidenceKind: "ORDER" | "LEG" | "TRADE" | "UNKEYED_LEG" | "SETTLED";
  /** `null` only for a TRADE record (r9: a trade identity, whatever its legs). */
  readonly venueOrderId: string | null;
  /** LEG and TRADE: the venue trade. */
  readonly venueTradeId: string | null;
  readonly provenance: "SHOWN" | "NAMED";
  readonly source: string;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly price: string | null;
  readonly originalSize: string | null;
  readonly size: string | null;
  readonly status: string | null;
  /** SETTLED: the level it covers; (r10) UNKEYED_LEG: how many such unkeyed legs its answer showed. */
  readonly level: number | null;
  /** LEG and (r10) UNKEYED_LEG only (r7): the leg's fill facts as the observation fixed them; `null` on every other record. */
  readonly feeAmount: string | null;
  readonly feeAssetId: string | null;
  readonly role: "MAKER" | "TAKER" | null;
  readonly matchedAt: string | null;
  readonly atMs: number;
}

/** An evidence record as the journal returns it (its position included). */
export type JournalEvidenceView = JournalEvidenceInput & { readonly sequence: number };

/** The fields of the journal's break view the coordinator reads. */
export interface JournalBreakView {
  readonly breakId: string;
  readonly runId: string;
  readonly breakClass: BreakClass;
  readonly rule: BreakRule;
  readonly subjectKey: string;
  readonly scope: BreakScope;
  readonly status: "OPEN" | "RESOLVED" | "QUARANTINED";
  readonly marketId: string | null;
  /** The tracked order the break is about: the coordinator clears an order's state and fill breaks only by comparing that order again. */
  readonly orderId: string | null;
  readonly assetId: string | null;
  readonly resolutionLedgerTransactionId: string | null;
  readonly resolution: "RESOLVED_IN_RUN" | "NOT_REPRODUCED" | "OPERATOR_RELEASED" | null;
  readonly detail: string;
}

export type JournalPortResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly refusal: { readonly code: string; readonly message: string } };

export interface ReconciliationJournalPort {
  readonly faulted: boolean;
  readonly runningRunId: string | null;
  ruleOf(breakClass: BreakClass): BreakRule;
  /** Whether an operator's release of this class acknowledges its subject for good (immutable history), or a run that still finds it opens it again (a live contradiction). */
  releaseAcknowledgesSubject(breakClass: BreakClass): boolean;
  /** Every break, resolved or not. */
  breaks(): readonly JournalBreakView[];
  /** Breaks still OPEN or QUARANTINED. */
  unresolvedBreaks(): readonly JournalBreakView[];
  /** Every evidence record, in append order (r6): the coordinator's EvidenceStore is rebuilt from it at every run. */
  evidence(): readonly JournalEvidenceView[];
  append(event: JournalInput): Promise<JournalPortResult>;
}

// ---------------------------------------------------------------------------
// Holdings (the ledger projection and its UNATTRIBUTED corrections).

export interface HoldingsPort {
  /**
   * The account's projected actual holdings, from the ledger:
   * `{ lines: [{ assetId, assetKind, balance }], unattributedArrivals: [{ kind, ledgerTransactionId, assetId, amount, marketId }] }`
   * (`packages/ledger`'s `projectedHoldings`).
   */
  projected(): Promise<unknown>;
  /**
   * Book a confirmed, unexplained delta to the ledger's UNATTRIBUTED scope
   * (`buildUnattributedCorrection`, then `Ledger.append`). `{ ok: true }` only
   * once the transaction is durable.
   */
  bookUnattributed(correction: UnattributedBooking): Promise<unknown>;
  /**
   * What the ledger STILL BOOKS of each named fill (WP-290 r4; ADR-006 §5, decision 2: a settlement that reaches
   * `FAILED` produces a compensating append-only reversal):
   * `{ bookings: [{ venueTradeId, venueOrderId, entries: [{ assetId, amount }] }] }`, exactly one per identity
   * asked, `entries` the non-zero actual-account amounts per asset (empty: never booked, or fully reversed).
   * The composition joins the OMS's fills (`execution.fills`: venue trade and order → fill id) with
   * `packages/ledger`'s `remainingFillBookings`. Asked about every FAILED leg the trades read shows.
   */
  remainingBookings(fills: readonly FillIdentity[]): Promise<unknown>;
}

/** One asset of a fill's remaining booking (`HoldingsPort.remainingBookings`): the actual-account amount still booked. */
export interface BookedAmount {
  readonly assetId: string;
  readonly amount: DecimalString;
}

/** One fill, by the venue's identity (one fill per trade and order: WP-280's convention). */
export interface FillIdentity {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
}

export interface UnattributedBooking {
  readonly ledgerTransactionId: string;
  readonly reconciliationRunId: string;
  readonly assetId: string;
  readonly assetKind: "COLLATERAL" | "OUTCOME_TOKEN";
  readonly marketId: string | null;
  readonly delta: DecimalString;
  readonly occurredAtMs: number;
}

// ---------------------------------------------------------------------------
// Halts (§9.9; the OMS halts nothing itself, nor does the coordinator).

export interface HaltRequest {
  readonly breakId: string;
  readonly breakClass: BreakClass;
  readonly detail: string;
}

export interface HaltPort {
  /** Halt new entries in one market. Must be idempotent: every run re-delivers the halts of open quarantines. */
  haltMarket(request: HaltRequest & { readonly marketId: string }): void;
  /** Halt new entries in the whole account. Idempotent. */
  haltAccount(request: HaltRequest): void;
}

// ---------------------------------------------------------------------------
// Policy.

/**
 * Configuration. No value here is a venue fact: each needs the operator's
 * choice, and the quiescence horizon an ADR before any live mode
 * (`WP270-DECISIONS`). None has a default.
 */
export interface ReconciliationPolicy {
  readonly accountRef: string;
  /** The collateral (pUSD) asset id, as the ledger and the OMS name it. */
  readonly collateralAssetId: string;
  /**
   * How long after the coordinator RECEIVED a submission-unknown request a
   * read must start before an ABSENT answer may attest `transmissionQuiescent`
   * (WP-270's QUIESCENCE RULE). Every transmission of the attempt began
   * before the request was issued, so this bounds how long a transmission may
   * still travel. No venue fact bounds it.
   */
  readonly quiescenceHorizonMs: number;
  /** The longest a run's reads may take, first start to last answer, and still count as one view of the account. */
  readonly maxReadSpanMs: number;
  /** An unexplained holding delta is booked only when a read at least this much later shows the same delta. */
  readonly holdingConfirmationMs: number;
  /** Spenders whose approval trading needs; each must read `approved: true`. */
  readonly requiredApprovalSpenders: readonly string[];
}

export interface ReconciliationCoordinatorDependencies {
  readonly reads: AccountReadPort;
  readonly journal: ReconciliationJournalPort;
  readonly holdings: HoldingsPort;
  readonly halts: HaltPort;
  readonly clock: ReconciliationClock;
  /** UUIDv7 ids for runs, breaks and ledger corrections (a composition binds a UUIDv7 generator). */
  readonly newId: () => string;
  /** The internal market (UUIDv7) of an outcome token, or `null` when unknown (the account is then halted). */
  readonly marketOfToken: (tokenId: string) => string | null;
  /**
   * The outcome token an execution group trades (`execution.groups.token_id`: the `GroupSpec` the composition
   * registered with the OMS), or `null` when unknown. WP-270's `OrderView` carries no token, and a tracked
   * order's token is one of the fixed facts compared against the venue's; an order whose token is unknown
   * is not compared, and holds (`COMPONENT_UNAVAILABLE`).
   */
  readonly tokenOfGroup: (executionGroupId: string) => string | null;
  readonly policy: ReconciliationPolicy;
}
