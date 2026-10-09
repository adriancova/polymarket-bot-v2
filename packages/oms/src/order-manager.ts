/**
 * The order manager: the §9.11 idempotent submission protocol, the order and
 * settlement state machines, cancel and replace, many-to-many attribution and
 * reservations (WP-270; handoff §9.11; ADR-007).
 *
 * ## The submission protocol (§9.11 steps 1-10), and where each step lives
 *
 * | Step | Here |
 * | --- | --- |
 * | 0. Reserve before submission (§9.10) | `#reserveSignPersist`: the order row is durable as `PLANNED` first, then `reserve`, then a durable `RESERVED` event |
 * | 1. Create `submission_attempt_id` | `#reserveSignPersist`: drawn from the injected `newId` BEFORE signing |
 * | 2. Sign locally | `venue.createLimitOrder`; a FAILED outcome means no order exists (WP-260) |
 * | 3. Persist payload, salt, expected hash, plan link | one store transaction: `INSERT_ATTEMPT` (ciphertext only; `expectedOrderHash: null`, see below) |
 * | 4. Commit `SIGNED` | the same transaction moves the order to `SIGNED`, naming the attempt (WP-040 F17) |
 * | 5. Mark `SENDING`, transmit | `#transmit`: the `SENDING` mark is DURABLE before the port is called |
 * | 6. Persist the response or timeout | `#applyPlacement`, `declareTransmissionLost` |
 * | 7. Lost response → `SUBMISSION_UNKNOWN` | every UNKNOWN class, a throw, a malformed answer, a watchdog timeout |
 * | 8. Authoritative query by signed identity | `#issue`: a `ReconciliationRequest` carrying the signed identity |
 * | 9. Retry the same signed order only when safe and supported | `retransmitSameSignedOrder`; see RETRANSMISSION |
 * | 10. No new salt until the prior attempt is closed | `#saltGate`; see THE SALT GATE |
 *
 * ## THE SALT GATE (step 10)
 *
 * A new signed order (a new salt) for an execution group is created only when
 * EVERY earlier attempt of that group is closed:
 * - `ABANDONED`: never transmitted (the durable `SENDING` mark proves it), or
 *   nothing left the process (`NOT_SENT`), or an authoritative read found it
 *   absent; or
 * - `RESPONDED` and its order is terminal with an authoritatively known final
 *   matched size and no open evidence conflict (a definitive rejection is
 *   terminal with final size 0), and no transmission of it is still in flight
 *   in this process (r3: its answer could yet name another venue order, a
 *   VENUE-ID CONFLICT, which must be seen before a new salt, not after).
 * The check and the claim of the group happen in one synchronous step, so two
 * concurrent submissions cannot both pass. The new order's size is capped by
 * the group's remaining quantity, computed exactly from the final sizes.
 *
 * ## RETRANSMISSION (step 9), and why it is this narrow
 *
 * The one documented resubmission of a signed request is after an HTTP 425
 * restart (`VENUE_FACTS.RESTART_RESUBMIT`), and the venue says to retry only
 * restart rejections (`VENUE_FACTS.RETRY_ONLY_RESTART`). WP-260 maps a 425 to
 * an UNKNOWN effect, so ADR-007 §3 still applies: the attempt is reconciled
 * first. `retransmitSameSignedOrder` therefore sends the SAME signed order
 * (same salt; no re-signing) only when the attempt's last transmission ended
 * with the restart kind, an authoritative read made after that transmission
 * found it absent, no post-only refusal was seen (`POST_ONLY_NO_UNCHANGED_
 * RETRY`), no VENUE-ID CONFLICT is open on its order, and nothing is in
 * flight. Every other case is refused. The handoff flags this reading for a
 * ruling.
 *
 * ## THE EXPECTED ORDER HASH: STOPPED
 *
 * The pinned SDK exposes no order-hash computation and the verified reports
 * document none, so the OMS persists `expectedOrderHash: null` ("unique where
 * known", §10.7) and never computes one. Reconciliation runs on the signed
 * identity (salt and signed fields) and, once known, the venue order id. The
 * options for an ADR are in the WP-270 handoff.
 *
 * ## THE QUIESCENCE RULE (ABSENT), flagged for a ruling
 *
 * "Absent at the moment of the read" proves "never placed" only if no
 * transmission of the attempt can still arrive afterwards. In-process, the
 * OMS refuses ABSENT while its own port call is pending
 * (`OMS_RECONCILIATION_IN_FLIGHT`), and after a watchdog timeout it asks for
 * a fresh read once the call settles. But a request can outlive the call
 * that sent it: a client-side timeout while the venue still processes it, or
 * a process that died after sending (a recovered SENDING attempt). A
 * clockless layer-1 OMS cannot see that. So every ABSENT answer must carry
 * `transmissionQuiescent: true`: the reconciler's attestation (it owns the
 * clock) that its read was made after the attempt's last transmission could
 * still arrive. Without it, ABSENT is refused
 * (`OMS_RECONCILIATION_NOT_QUIESCENT`) and nothing changes. No venue fact
 * bounds that horizon, so its value needs an ADR; WP-290 owns honouring it.
 * The seeded property (`salt-gate.property.test.ts`) found this: a read made
 * between a crash and the late arrival of the dead process's request.
 *
 * ## VENUE-ID CONFLICTS (sticky and durable)
 *
 * When a placement answer (in time or late) or an authoritative read names,
 * for one signed order, a venue order id other than the one the OMS tracks
 * for it, or one another order holds, the OMS cannot rule out a venue order
 * it does not track. Such a conflict raises a market-halt alert and is
 * recorded in the order's event log (`conflictingVenueOrderId`), so it
 * survives a restart (recovery re-raises the alert). It is never cleared by
 * the OMS: not by a read of the tracked id, not by a cancel, not by
 * abandonment. While it is open, the group's salt gate stays closed, the
 * order's reservation stays held, and its signed order is never retransmitted
 * (an ABSENT answer abandons the attempt instead of holding it for step 9).
 * Resolving it is an operator's act.
 *
 * ## STATE CONFLICTS (cleared only by an authoritative read)
 *
 * Evidence about a TERMINAL order that the OMS cannot reconcile with
 * "terminal" reopens it to RECONCILING with a market-halt alert and its final
 * size unknown again (`finalSize: null`). A stream status saying the venue may
 * still hold it (LIVE, DELAYED, UNMATCHED) and an UNRECOGNISED stream status
 * alike (never an assumption that an unknown status is harmless) ask for a
 * fresh authoritative read; an authoritative read finding it open moves it on
 * to that open state. The order then carries a STATE conflict (`conflict`,
 * durable in the event payload). Only an authoritative read of the tracked
 * venue order that finds it terminal clears it, fixing the final matched size
 * at the same time; until then the group's salt gate stays closed and the
 * remainder stays reserved. A terminal order with an open state conflict
 * always needs that read (`#needs`), so the conflict can never be stranded:
 * not after a restart, and not when fills complete a reopened order.
 *
 * ## UNATTRIBUTED EVIDENCE (a fill or an observation racing its placement answer)
 *
 * No venue fact orders the user stream against the placement response, so a
 * fill or an observation for our own order can arrive while its placement is
 * still in flight (a marketable order matches at once), or while a lost
 * response is being reconciled: before the OMS knows the order's venue id.
 * Such evidence is never dropped while an attempt that could own it is
 * unresolved (no venue order id yet; SENDING, SUBMISSION_UNKNOWN or
 * RECONCILING; not held absent). It is RETAINED, in memory, with the set of
 * those candidate attempts (the caller gets `OMS_EVIDENCE_RETAINED`; at most
 * `MAX_RETAINED_EVIDENCE` items). When a placement answer or an authoritative
 * read adopts that venue order id, the evidence is applied to the order
 * through the ordinary fill and observation paths, in arrival order, and an
 * order still open afterwards goes to RECONCILING with a fresh authoritative
 * read (durable: a restart re-requests it). Once none of its candidates can
 * own it any more, the evidence is released with a market-halt
 * `UNKNOWN_VENUE_ORDER` alert naming the venue order id; with no candidate at
 * all it is refused at once, with the same alert. Evidence beyond the bound is
 * refused with that alert too, and every attempt that could have owned it gets
 * the forced read once it is identified. Retained evidence dies with the
 * process: after a restart the attempt is reconciled by its signed identity
 * (the read carries the venue's matched size, which fixes the group's
 * remainder; the reservation stays held until the fills are delivered again).
 *
 * ## PAUSE AND RESUME (§9.17 step 1)
 *
 * The manager starts PAUSED when recovery finds a never-transmitted SIGNED
 * attempt or anything `resume()` would refuse (an attempt still unresolved,
 * or an order still RECONCILING). `resume()` refuses while any attempt is
 * SENDING, SUBMISSION_UNKNOWN or RECONCILING, or any order is RECONCILING,
 * EXCEPT an attempt held for the retransmission decision: an authoritative,
 * quiescent read found it absent and nothing of it is in flight. Nothing of
 * that attempt can still arrive, and its group's gate stays closed until it
 * is retransmitted or abandoned, so §9.11 step 9 stays reachable after a
 * restart.
 *
 * ## DURABILITY ORDER
 *
 * Decisions are taken synchronously on the in-memory model; their writes go
 * to the store through ONE serialized chain, in decision order. A venue call
 * (place, cancel) is made only after every earlier write is durable. A store
 * rejection FAULTS the manager: it refuses everything until reopened from the
 * store (`OrderManager.open`), because the in-memory state may then be ahead
 * of the durable one. Reservation calls are ordered so that a crash leaves a
 * recoverable record: the order is durable before `reserve`; a fill is durable
 * before `consume` (a replayed consume is refused by the inventory as a
 * duplicate pending id, which reads as done); `release` precedes its durable
 * `RESERVATION_RELEASED` event (a replayed release reads as done).
 *
 * ## ONE EXECUTABLE QUANTITY (ADR-034 D2; `CO3-N1`)
 *
 * The planner floors every share quantity to the venue's 0.01 grid once; the
 * OMS never rounds. The ticket door refuses an off-grid `shares` with
 * `OMS_SIZE_OFF_GRID` before the PLANNED row and before `reserve` (and a
 * staged replacement before it is staged), and `identityMismatch` requires the
 * signed `makerAmount` and `takerAmount` to be the order's shares and shares ×
 * price, exactly, in base units. So the ticket, `originalShares`, the
 * reservation basis, the signed share amount and the venue's original size
 * that reconciliation compares are one number.
 *
 * ## RESERVATIONS (§9.10; work-plan acceptance 3; ADR-006 §9)
 *
 * A fill consumes exactly its debit of the reserved asset (BUY: shares x fill
 * price, plus a fee charged in the collateral asset; SELL: shares). The
 * unused remainder (reserved minus consumed) is released only when the order
 * is terminal AND its final matched size is authoritatively known AND the
 * recorded fills sum to exactly that size: a reservation never stops
 * constraining while a fill may still arrive.
 *
 * Nothing here reads a clock, draws randomness or performs I/O: ids and
 * request tokens come from injected sources, and every effect leaves through a
 * port.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal, type DecimalString } from "@polymarket-bot/decimal";

import {
  canonicalFlatJson,
  compositeKey,
  isCode,
  isIdentifier,
  isNonNegativeAmount,
  isOnShareGrid,
  isOpenUnitPrice,
  isPositiveAmount,
  isTokenId,
  isUnitPrice,
  isUuidV7,
  parseFlatJson,
  readArray,
  readBaseUnitInteger,
  readField,
  readFields,
  wholeUnits,
} from "./guards.js";
import {
  classifyBatch,
  fillKey,
  isVenueId,
  readCancelOutcome,
  readPlacementOutcome,
  readSignOutcome,
  type AcceptedStatus,
  type CancelClass,
  type PlacementClass,
} from "./outcomes.js";
import type {
  AttemptRecord,
  EncryptedPayload,
  FillAllocationRecord,
  FillRecord,
  GroupRecord,
  IntentOrderLinkRecord,
  JsonValue,
  OmsReservationPort,
  OmsStore,
  OmsVenuePort,
  OrderEventRecord,
  OrderRecord,
  PayloadCipher,
  ReconciliationPurpose,
  ReconciliationRequest,
  ReconciliationRequester,
  RestoreSignedOrder,
  SignedOrderHandle,
  SignedOrderIdentity,
  StoreSnapshot,
  StoreWrite,
  TradeSettlementRecord,
  VenueMode,
} from "./ports.js";
import { ok, refuse, type OmsResult } from "./refusals.js";
import {
  TERMINAL_ORDER_STATES,
  isAttemptState,
  isLegalAttemptTransition,
  isLegalOrderTransition,
  isLegalSettlementTransition,
  isOrderState,
  isSettlementState,
  type AttemptState,
  type OrderState,
  type SettlementState,
} from "./states.js";
import { AMOUNT_BASE_DECIMALS, MAX_ORDERS_PER_BATCH, SHARE_SIZE_DECIMALS } from "./venue-facts.js";

// ---------------------------------------------------------------------------
// Public input and view types.

export type Side = "BUY" | "SELL";

/**
 * An execution group (a slice or leg): every attempt of the group shares the salt gate. It carries every
 * column of its `execution.groups` row (migration 0005; `GroupRecord`), plus the plan's market, account and
 * post-only preference.
 */
export interface GroupSpec {
  readonly executionGroupId: string;
  readonly planId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly accountRef: string;
  readonly side: Side;
  /** The group's total planned shares (`groups.shares`); every attempt is capped by what remains of it. */
  readonly plannedShares: DecimalString;
  /** Fixed for the group: changing an order to post-only is a new plan (ADR-007 §7). */
  readonly postOnly: boolean;
  /** `groups.group_ordinal`: unique within the plan, at least 0. */
  readonly groupOrdinal: number;
  /** `groups.group_kind`. */
  readonly groupKind: GroupKind;
  /** `groups.limit_price`: a canonical decimal in [0, 1] (`internal.price_string`). */
  readonly limitPrice: DecimalString;
  /** `groups.release_after_group_id` (nullable); omitted: `null`. */
  readonly releaseAfterGroupId?: string | null;
  /** `groups.leg_risk_limit` (nullable); omitted: `null`. */
  readonly legRiskLimit?: DecimalString | null;
}

/** `internal.execution_group_kind` (migration 0001). */
export type GroupKind = "SLICE" | "LEG";

/** One intent's share of an order (`execution.intent_order_links`; ADR-006 §4). */
export interface AttributionSpec {
  readonly intentId: string;
  readonly approvedIntentId?: string | null;
  readonly instanceId: string;
  readonly shares: DecimalString;
}

/** One order to submit, within a registered group. */
export interface OrderTicket {
  readonly orderId: string;
  readonly executionGroupId: string;
  readonly limitPrice: DecimalString;
  readonly shares: DecimalString;
  /** Unix seconds: a GTD order. Omitted: GTC. */
  readonly expirationUnixSeconds?: number;
  /** The planner's reservation (§9.10). BUY: the collateral asset, at least price x shares. SELL: the token, at least shares. */
  readonly reservation: { readonly reservationId: string; readonly assetId: string; readonly amount: DecimalString };
  /** Sums to exactly `shares`. One intent at most once per order. */
  readonly attributions: readonly AttributionSpec[];
}

/** An authoritative reconciliation answer (WP-290's), bound to one request by its exact id. */
export interface ReconciliationAnswer {
  readonly requestId: string;
  readonly submissionAttemptId: string;
  readonly verdict: "ABSENT" | "PRESENT" | "UNRESOLVED";
  /**
   * Required `true` on an ABSENT verdict: the reconciler's attestation that
   * its read was made after every transmission of the attempt could still
   * arrive at the venue (THE QUIESCENCE RULE in the header). The OMS has no
   * clock; the reconciler does, and a configured horizon (an ADR; no venue
   * fact bounds it) decides it. Ignored on other verdicts.
   */
  readonly transmissionQuiescent?: boolean;
  readonly order?: {
    readonly venueOrderId: string;
    readonly status: string;
    readonly sizeMatched: DecimalString;
    readonly originalSize: DecimalString;
  };
}

/** A non-authoritative venue order observation (the user stream, normalized by WP-280). */
export interface OrderObservation {
  readonly venueOrderId: string;
  readonly status: string;
}

/** A venue trade against one of our orders (normalized by WP-280 / WP-290). */
export interface FillReport {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly allocationDiscriminator?: string;
  readonly shares: DecimalString;
  readonly price: DecimalString;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly feeAmount?: DecimalString;
  readonly feeAssetId?: string | null;
  readonly matchedAt: string;
}

export interface SettlementObservation {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly allocationDiscriminator?: string;
  readonly status: string;
  readonly transactionHash?: string | null;
  readonly observedAt: string;
}

/** Something the composition must act on (handoff §9.9). The OMS halts nothing itself. */
export interface OmsAlert {
  readonly kind:
    | "EVIDENCE_CONFLICT"
    | "UNKNOWN_VENUE_ORDER"
    | "FILL_INCONSISTENT"
    | "RESERVATION_SHORTFALL"
    | "RESERVATION_RELEASE_FAILED"
    | "SETTLEMENT_FAILED"
    | "SETTLEMENT_CONFLICT"
    | "PAYLOAD_UNREADABLE"
    | "RECONCILIATION_UNDELIVERED"
    | "EVIDENCE_UNAPPLIED";
  /** True when the affected market should stop taking new entries (§6 invariant 7, §9.9). */
  readonly haltMarket: boolean;
  readonly marketId: string | null;
  readonly orderId: string | null;
  readonly submissionAttemptId: string | null;
  /**
   * The venue order id the evidence named: the unknown id of an `UNKNOWN_VENUE_ORDER` alert, the conflicting
   * id of a venue-id conflict; otherwise the order's own venue order id, when known.
   */
  readonly venueOrderId: string | null;
  readonly detail: string;
}

/** One item of UNATTRIBUTED EVIDENCE (see the header) the manager holds while an attempt that could own it is unresolved. */
export interface RetainedEvidenceView {
  readonly kind: "FILL" | "OBSERVATION";
  readonly venueOrderId: string;
  /** A fill's trade id and discriminator; `null` for an observation. */
  readonly venueTradeId: string | null;
  readonly allocationDiscriminator: string | null;
  /** The attempts that could own it when it arrived (unresolved, without a venue order id). */
  readonly candidateAttemptIds: readonly string[];
}

export interface SubmissionReport {
  readonly orderId: string;
  readonly submissionAttemptId: string;
  readonly orderState: OrderState;
  readonly attemptState: AttemptState;
  /** The classified placement answer, or `null` when nothing was transmitted (the venue mode changed). */
  readonly placement: PlacementClass | null;
}

export interface OrderView {
  readonly orderId: string;
  readonly executionGroupId: string;
  readonly marketId: string;
  readonly side: Side;
  readonly state: OrderState;
  readonly submissionAttemptId: string | null;
  readonly venueOrderId: string | null;
  readonly limitPrice: DecimalString;
  readonly originalShares: DecimalString;
  readonly filledShares: DecimalString;
  readonly venueSizeMatched: DecimalString | null;
  readonly finalSize: DecimalString | null;
  /** An open evidence conflict of either kind (a state conflict, or a sticky venue-id conflict). */
  readonly conflict: boolean;
  /** A VENUE-ID CONFLICT (see the header): sticky and durable; the OMS never clears it. */
  readonly venueIdConflict: boolean;
  readonly reservation: {
    readonly reservationId: string;
    readonly assetId: string;
    readonly amount: DecimalString;
    readonly consumed: DecimalString;
    readonly held: boolean;
    readonly released: boolean;
  };
}

export interface AttemptView {
  readonly submissionAttemptId: string;
  readonly executionGroupId: string;
  readonly orderId: string;
  readonly attemptOrdinal: number;
  readonly salt: string;
  readonly expectedOrderHash: string | null;
  readonly state: AttemptState;
  readonly responseStatus: string | null;
  readonly errorCode: string | null;
  readonly venueOrderId: string | null;
  readonly inFlight: boolean;
  readonly absentConfirmed: boolean;
  readonly signedPayloadAvailable: boolean;
  readonly currentRequestId: string | null;
}

export interface SaltGateView {
  readonly open: boolean;
  readonly blockers: readonly { readonly id: string; readonly reason: string }[];
  /** The group's remaining quantity when every earlier order is final; `null` while any is not. */
  readonly remaining: DecimalString | null;
}

export interface OrderManagerDependencies {
  readonly venue: OmsVenuePort;
  readonly restoreSignedOrder: RestoreSignedOrder;
  readonly store: OmsStore;
  readonly cipher: PayloadCipher;
  readonly reservations: OmsReservationPort;
  readonly reconciler: ReconciliationRequester;
  /** UUIDv7 ids for submission attempts and fills (a composition binds a UUIDv7 generator). */
  readonly newId: () => string;
  /** Unguessable request tokens (ADR-032 D3: a CSPRNG in the composition). */
  readonly requestToken: () => string;
  /** The venue mode from WP-310's detector. Anything unreadable is TRADING_UNAVAILABLE. */
  readonly venueMode: () => VenueMode;
  /** The collateral (pUSD) asset id a BUY reserves (`AssetRegistry.pusdAssetId`). */
  readonly collateralAssetId: string;
}

/** ADR-032 D2's bound, applied to order reconciliation tokens. */
export const MAX_REQUEST_TOKEN_LENGTH = 128;
/** At most this many intents may share one order. */
export const MAX_ATTRIBUTIONS_PER_ORDER = 64;
/** At most this many items of UNATTRIBUTED EVIDENCE (see the header) are retained at once. */
export const MAX_RETAINED_EVIDENCE = 1024;

// ---------------------------------------------------------------------------
// Internal models.

interface AttributionModel {
  readonly intentId: string;
  readonly approvedIntentId: string | null;
  readonly instanceId: string;
  readonly shares: DecimalString;
}

interface ReservationSpec {
  readonly reservationId: string;
  readonly assetId: string;
  readonly amount: DecimalString;
}

interface OrderModel {
  readonly orderId: string;
  readonly planId: string;
  readonly groupId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly accountRef: string;
  readonly side: Side;
  readonly limitPrice: DecimalString;
  readonly originalShares: DecimalString;
  readonly postOnly: boolean;
  readonly expirationUnixSeconds: number | null;
  readonly reservation: ReservationSpec;
  readonly attributions: readonly AttributionModel[];
  state: OrderState;
  attemptId: string | null;
  venueOrderId: string | null;
  filledShares: DecimalString;
  debited: DecimalString;
  reservationHeld: boolean;
  /** Recovery only: a crash may have come between the durable PLANNED row and `reserve`; a missing reservation is then expected. */
  reservationUncertain: boolean;
  reservationReleased: boolean;
  consumeFailed: boolean;
  venueSizeMatched: DecimalString | null;
  finalSize: DecimalString | null;
  /** A STATE conflict (a terminal order contradicted, or observed with an unrecognised status); see STATE CONFLICTS. */
  conflict: boolean;
  /** A VENUE-ID CONFLICT: sticky and durable (the `conflictingVenueOrderId` event payload); never cleared here. */
  venueIdConflict: boolean;
  /** A post-only-mode refusal arrived for this order's attempt after its watchdog (the `postOnlyRefused` event payload). */
  latePostOnlyRefusal: boolean;
  cancelRevert: OrderState | null;
  nextOrdinal: number;
}

interface AttemptModel {
  readonly attemptId: string;
  readonly groupId: string;
  readonly planId: string;
  readonly orderId: string;
  readonly accountRef: string;
  readonly ordinal: number;
  readonly salt: string;
  readonly signedPayload: EncryptedPayload;
  readonly expectedOrderHash: string | null;
  handle: SignedOrderHandle | null;
  identity: SignedOrderIdentity | null;
  state: AttemptState;
  responseStatus: string | null;
  errorCode: string | null;
  venueOrderId: string | null;
  inFlight: boolean;
  lostDeclared: boolean;
  absentConfirmed: boolean;
  postOnlyRefused: boolean;
  requestCount: number;
  currentRequestId: string | null;
  requestOwed: boolean;
}

interface GroupModel {
  readonly record: GroupRecord;
  readonly attemptIds: string[];
  readonly orderIds: string[];
  claim: string | null;
  staged: ValidatedTicket | null;
  nextOrdinal: number;
}

interface RequestModel {
  readonly requestId: string;
  readonly attemptId: string;
  readonly purpose: ReconciliationPurpose;
  delivered: boolean;
  consumed: boolean;
}

interface FillModel {
  readonly record: FillRecord;
  readonly debit: DecimalString;
  settlement: SettlementState | null;
  settlementOrdinal: number;
  /** Every transaction hash recorded for the CURRENT settlement state (a repeat of any of them is a duplicate). */
  stateHashes: Set<string>;
}

/** One item of UNATTRIBUTED EVIDENCE (see the header). Exactly one of `fill` and `observation` is set. */
interface RetainedEvidence {
  readonly venueOrderId: string;
  readonly fill: ValidatedFill | null;
  /** An observation: its status, or `null` for an unrecognised one. */
  readonly observation: { readonly status: ObservedStatus | null } | null;
  readonly candidates: ReadonlySet<string>;
}

interface ValidatedTicket {
  readonly orderId: string;
  readonly groupId: string;
  readonly limitPrice: DecimalString;
  readonly shares: DecimalString;
  readonly expirationUnixSeconds: number | null;
  readonly reservation: ReservationSpec;
  readonly attributions: readonly AttributionModel[];
}

interface Prepared {
  readonly ticket: ValidatedTicket;
  readonly group: GroupModel;
  readonly ordinal: number;
}

interface SignedItem {
  readonly attempt: AttemptModel;
  readonly order: OrderModel;
}

/** Effects a flow collects: durable writes first, then releases and reconciliation requests. */
interface Effects {
  readonly writes: StoreWrite[];
  readonly releases: Set<OrderModel>;
  readonly requests: Set<AttemptModel>;
}

function effects(): Effects {
  return { writes: [], releases: new Set(), requests: new Set() };
}

const ZERO: DecimalString = "0";
const OBSERVED_STATUSES = ["LIVE", "DELAYED", "UNMATCHED", "MATCHED", "CANCELED", "EXPIRED"] as const;
type ObservedStatus = (typeof OBSERVED_STATUSES)[number];

function isObservedStatus(value: unknown): value is ObservedStatus {
  return typeof value === "string" && (OBSERVED_STATUSES as readonly string[]).includes(value);
}

/** Internal invariant failure: the manager faults (fail closed). Never carries a payload. */
class OmsInvariantError extends Error {}

function min(a: DecimalString, b: DecimalString): DecimalString {
  return compareDecimal(a, b) <= 0 ? a : b;
}

function max(a: DecimalString, b: DecimalString): DecimalString {
  return compareDecimal(a, b) >= 0 ? a : b;
}

/**
 * Sequential allocation (the WP-270 handoff flags it for a ruling): attribution
 * `i` owns the band `[Σ shares_<i, Σ shares_≤i)` of the order's cumulative
 * filled quantity. Exact; no division, so no rounding. Returns each band's
 * allocated quantity at cumulative fill `total`.
 */
function allocatedAt(attributions: readonly AttributionModel[], total: DecimalString): DecimalString[] {
  const out: DecimalString[] = [];
  let before: DecimalString = ZERO;
  for (const attribution of attributions) {
    const upto = addDecimal(before, attribution.shares);
    const inBand = subDecimal(min(total, upto), min(total, before));
    out.push(max(inBand, ZERO));
    before = upto;
  }
  return out;
}

// ---------------------------------------------------------------------------

export class OrderManager {
  readonly #deps: OrderManagerDependencies;
  readonly #groups = new Map<string, GroupModel>();
  readonly #orders = new Map<string, OrderModel>();
  readonly #attempts = new Map<string, AttemptModel>();
  readonly #ordersByVenueId = new Map<string, string>();
  readonly #salts = new Set<string>();
  readonly #fills = new Map<string, FillModel>();
  readonly #requests = new Map<string, RequestModel>();
  readonly #usedIds = new Set<string>();
  readonly #usedTokens = new Set<string>();
  readonly #namedUnissued = new Set<string>();
  /** UNATTRIBUTED EVIDENCE, in arrival order (memory only). */
  readonly #retained: RetainedEvidence[] = [];
  /** Attempts that could have owned evidence refused at the bound: each gets a forced read once identified. */
  readonly #evidenceLost = new Set<string>();
  readonly #alerts: OmsAlert[] = [];
  #faulted = false;
  #paused = false;
  #chain: Promise<boolean> = Promise.resolve(true);

  private constructor(deps: OrderManagerDependencies) {
    this.#deps = deps;
  }

  /**
   * The only way to obtain a manager. It ALWAYS loads the store first, so a
   * restarted process cannot forget an attempt (§16.6 "Kill trader after
   * transmission but before response persistence"). If the store holds any
   * unresolved attempt, the manager starts PAUSED (§9.17 step 1): new
   * submissions are refused until every one is resolved and `resume()` is
   * called. Cancels and reconciliation are never paused.
   */
  static async open(deps: OrderManagerDependencies): Promise<OmsResult<OrderManager>> {
    const checked = checkDependencies(deps);
    if (checked !== undefined) return refuse("OMS_INVALID_INPUT", checked);
    const manager = new OrderManager(deps);
    let snapshot: unknown;
    try {
      snapshot = await deps.store.load();
    } catch {
      return refuse("OMS_STORE_WRITE_FAILED", "the store could not be loaded; nothing was opened");
    }
    try {
      const recovered = await manager.#recover(snapshot);
      if (!recovered.ok) return recovered;
    } catch {
      return refuse("OMS_FAULTED", "the store snapshot could not be recovered; nothing was opened");
    }
    return ok(manager);
  }

  // -------------------------------------------------------------------------
  // Health and views.

  get faulted(): boolean {
    return this.#faulted;
  }

  get paused(): boolean {
    return this.#paused;
  }

  alerts(): readonly OmsAlert[] {
    return Object.freeze([...this.#alerts]);
  }

  order(orderId: string): OrderView | undefined {
    const order = this.#orders.get(orderId);
    return order === undefined ? undefined : this.#orderView(order);
  }

  attempt(attemptId: string): AttemptView | undefined {
    const attempt = this.#attempts.get(attemptId);
    return attempt === undefined ? undefined : this.#attemptView(attempt);
  }

  attempts(): readonly AttemptView[] {
    return Object.freeze([...this.#attempts.values()].map((attempt) => this.#attemptView(attempt)));
  }

  orders(): readonly OrderView[] {
    return Object.freeze([...this.#orders.values()].map((order) => this.#orderView(order)));
  }

  saltGate(groupId: string): SaltGateView | undefined {
    const group = this.#groups.get(groupId);
    return group === undefined ? undefined : this.#saltGate(group);
  }

  /** Attempts that need an authoritative read and hold no delivered request. */
  outstandingReconciliations(): number {
    let count = 0;
    for (const attempt of this.#attempts.values()) {
      if (this.#needs(attempt) === null) continue;
      const current = attempt.currentRequestId === null ? undefined : this.#requests.get(attempt.currentRequestId);
      if (current === undefined || !current.delivered) count += 1;
    }
    return count;
  }

  /** UNATTRIBUTED EVIDENCE still held, in arrival order (see the header). */
  retainedEvidence(): readonly RetainedEvidenceView[] {
    return Object.freeze(
      this.#retained.map((item) =>
        Object.freeze({
          kind: item.fill === null ? ("OBSERVATION" as const) : ("FILL" as const),
          venueOrderId: item.venueOrderId,
          venueTradeId: item.fill?.venueTradeId ?? null,
          allocationDiscriminator: item.fill?.allocationDiscriminator ?? null,
          candidateAttemptIds: Object.freeze([...item.candidates]),
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Groups.

  async registerGroup(raw: unknown): Promise<OmsResult<GroupRecord>> {
    return this.#guarded(async () => {
      const group = readGroup(raw);
      if (group === undefined) {
        return refuse(
          "OMS_INVALID_INPUT",
          "a group needs UUIDv7 executionGroupId, planId and marketId, a token id, an account, a side, positive plannedShares, a boolean postOnly, " +
            "and its execution.groups columns: a groupOrdinal >= 0, a groupKind (SLICE or LEG), a limitPrice in [0, 1], " +
            "and optionally a UUIDv7 releaseAfterGroupId and a non-negative legRiskLimit",
        );
      }
      const existing = this.#groups.get(group.executionGroupId);
      if (existing !== undefined) {
        return sameGroup(existing.record, group)
          ? ok(existing.record)
          : refuse("OMS_DUPLICATE_GROUP", "this group id is registered with different facts", { executionGroupId: group.executionGroupId });
      }
      // `groups_ordinal_unique (plan_id, group_ordinal)`: one ordinal names one group of a plan.
      for (const other of this.#groups.values()) {
        if (other.record.planId === group.planId && other.record.groupOrdinal === group.groupOrdinal) {
          return refuse("OMS_DUPLICATE_GROUP", "another group of this plan holds this group ordinal", {
            executionGroupId: group.executionGroupId,
            groupOrdinal: group.groupOrdinal,
          });
        }
      }
      this.#groups.set(group.executionGroupId, { record: group, attemptIds: [], orderIds: [], claim: null, staged: null, nextOrdinal: 1 });
      const persisted = await this.#persist([{ kind: "INSERT_GROUP", group }]);
      return persisted ? ok(group) : storeFailed();
    });
  }

  // -------------------------------------------------------------------------
  // Submission (§9.11 steps 1-8).

  /** Submit one order: reserve, sign, persist, mark SENDING, transmit, classify. */
  async submit(raw: unknown): Promise<OmsResult<SubmissionReport>> {
    return this.#guarded(async () => {
      const admitted = this.#admit([raw]);
      if (!admitted.ok) return admitted;
      const signed = await this.#reserveSignPersist(admitted.value);
      if (!signed.ok) return signed;
      const reports = await this.#transmit(signed.value, false);
      if (!reports.ok) return reports;
      const [report] = reports.value;
      if (report === undefined) throw new OmsInvariantError("one report per submission");
      return ok(report);
    });
  }

  /**
   * Submit 1-15 orders (`VENUE_FACTS.BATCH_LIMIT`) as one `postOrders` batch.
   * A refused batch's outcomes are never paired with its inputs by position
   * (`classifyBatch`; WP-260 I-R2-2).
   */
  async submitBatch(raws: unknown): Promise<OmsResult<readonly SubmissionReport[]>> {
    return this.#guarded(async () => {
      const list = readArray(raws, MAX_ORDERS_PER_BATCH + 1);
      if (list === undefined || list.length < 1 || list.length > MAX_ORDERS_PER_BATCH) {
        return refuse("OMS_BATCH_SIZE", "a batch carries 1 to 15 orders (VENUE_FACTS.BATCH_LIMIT)");
      }
      const admitted = this.#admit(list);
      if (!admitted.ok) return admitted;
      const signed = await this.#reserveSignPersist(admitted.value);
      if (!signed.ok) return signed;
      return this.#transmit(signed.value, true);
    });
  }

  /** Transmit a SIGNED attempt that was never transmitted (a recovered one, or one held back by the venue mode). */
  async transmitSigned(attemptId: string): Promise<OmsResult<SubmissionReport>> {
    return this.#guarded(async () => {
      if (this.#paused) return refuse("OMS_PAUSED", "new submissions are paused until every recovered attempt is resolved");
      const attempt = this.#attempts.get(attemptId);
      if (attempt === undefined) return refuse("OMS_UNKNOWN_ATTEMPT", "no such attempt", { attemptId });
      if (attempt.state !== "SIGNED") {
        return refuse("OMS_ILLEGAL_TRANSITION", "only a SIGNED, never-transmitted attempt can be transmitted here", { state: attempt.state });
      }
      if (attempt.handle === null) {
        return refuse("OMS_SIGNED_PAYLOAD_UNAVAILABLE", "the persisted signed payload could not be restored; abandon the attempt instead");
      }
      const order = this.#mustOrder(attempt.orderId);
      const reports = await this.#transmit([{ attempt, order }], false);
      if (!reports.ok) return reports;
      const [report] = reports.value;
      if (report === undefined) throw new OmsInvariantError("one report per transmission");
      return ok(report);
    });
  }

  /**
   * §9.11 step 9: resend the SAME signed order (same salt, no re-signing),
   * only on the documented restart path (see RETRANSMISSION in the header).
   */
  async retransmitSameSignedOrder(attemptId: string): Promise<OmsResult<SubmissionReport>> {
    return this.#guarded(async () => {
      if (this.#paused) return refuse("OMS_PAUSED", "new submissions are paused until every recovered attempt is resolved");
      const attempt = this.#attempts.get(attemptId);
      if (attempt === undefined) return refuse("OMS_UNKNOWN_ATTEMPT", "no such attempt", { attemptId });
      const order = this.#mustOrder(attempt.orderId);
      const refusal = retransmissionRefusal(attempt, order);
      if (refusal !== undefined) return refuse("OMS_RETRANSMIT_NOT_SUPPORTED", refusal, { attemptId });
      const mode = this.#mode();
      if (mode === "TRADING_UNAVAILABLE") return refuse("OMS_TRADING_UNAVAILABLE", "the venue mode admits no placement");
      if (mode === "POST_ONLY" && !order.postOnly) {
        return refuse("OMS_POST_ONLY_MODE", "the venue is in post-only mode; this order is not post-only (VENUE_FACTS.POST_ONLY_NO_UNCHANGED_RETRY)");
      }
      // The read that found it absent is spent: a new transmission needs a new read to conclude anything.
      attempt.absentConfirmed = false;
      this.#consumeCurrentRequest(attempt);
      const reports = await this.#transmit([{ attempt, order }], false);
      if (!reports.ok) return reports;
      const [report] = reports.value;
      if (report === undefined) throw new OmsInvariantError("one report per transmission");
      return ok(report);
    });
  }

  /**
   * Close an attempt that never reached the venue (SIGNED), or one an
   * authoritative read found absent and that waits on the retransmission
   * decision. Its order becomes terminal with final size 0, and its whole
   * reservation is released.
   */
  async abandonAttempt(attemptId: string): Promise<OmsResult<AttemptView>> {
    return this.#guarded(async () => {
      const attempt = this.#attempts.get(attemptId);
      if (attempt === undefined) return refuse("OMS_UNKNOWN_ATTEMPT", "no such attempt", { attemptId });
      const order = this.#mustOrder(attempt.orderId);
      const fx = effects();
      if (attempt.state === "SIGNED" && !attempt.inFlight) {
        this.#setAttempt(attempt, "ABANDONED", "NEVER_TRANSMITTED", attempt.errorCode, fx);
        this.#transition(order, "CANCELED", "ABANDONED", fx, { reasonCode: "NEVER_TRANSMITTED", payload: { finalSize: ZERO } });
        order.finalSize = ZERO;
      } else if (attempt.state === "RECONCILING" && attempt.absentConfirmed && !attempt.inFlight) {
        this.#abandonAbsent(attempt, order, fx);
      } else {
        return refuse("OMS_ILLEGAL_TRANSITION", "only a never-transmitted attempt, or one confirmed absent, can be abandoned", {
          state: attempt.state,
        });
      }
      fx.releases.add(order);
      if (!(await this.#commit(fx))) return storeFailed();
      return ok(this.#attemptView(attempt));
    });
  }

  /**
   * A watchdog's timeout (§9.11 step 6, "persist response or timeout"): the
   * transmission has not answered. The attempt becomes SUBMISSION_UNKNOWN and
   * is reconciled; a late answer is then evidence, never a resolution by
   * itself (ADR-007 §3), except that a late acceptance proves the order exists.
   */
  async declareTransmissionLost(attemptId: string): Promise<OmsResult<AttemptView>> {
    return this.#guarded(async () => {
      const attempt = this.#attempts.get(attemptId);
      if (attempt === undefined) return refuse("OMS_UNKNOWN_ATTEMPT", "no such attempt", { attemptId });
      if (attempt.state !== "SENDING" || !attempt.inFlight) {
        return refuse("OMS_ILLEGAL_TRANSITION", "only a transmission still in flight can be declared lost", { state: attempt.state });
      }
      const order = this.#mustOrder(attempt.orderId);
      const fx = effects();
      attempt.lostDeclared = true;
      this.#setAttempt(attempt, "SUBMISSION_UNKNOWN", "LOST", "TRANSMISSION_TIMEOUT", fx);
      this.#transition(order, "SUBMISSION_UNKNOWN", "TRANSMISSION_LOST", fx, { reasonCode: "TRANSMISSION_TIMEOUT" });
      fx.requests.add(attempt);
      if (!(await this.#commit(fx))) return storeFailed();
      return ok(this.#attemptView(attempt));
    });
  }

  // -------------------------------------------------------------------------
  // Reconciliation (§9.11 step 8; ADR-007 §3).

  /** Re-issue every owed request (undelivered, or never built because a token draw failed). ADR-032 D5's cadence. */
  async retryReconciliationRequests(): Promise<OmsResult<number>> {
    return this.#guarded(async () => {
      let issued = 0;
      for (const attempt of [...this.#attempts.values()]) {
        if (this.#needs(attempt) === null) continue;
        const current = attempt.currentRequestId === null ? undefined : this.#requests.get(attempt.currentRequestId);
        if (current !== undefined && current.delivered && !current.consumed) continue;
        if (this.#issue(attempt)) issued += 1;
      }
      if (!(await this.#settled())) return storeFailed();
      return ok(issued);
    });
  }

  /**
   * An authoritative answer. Bound only to the attempt's CURRENT, delivered
   * request, by exact id (ADR-032 applied to orders): an answer naming an id
   * never issued, superseded, consumed or for another attempt is refused.
   * `ABSENT` is refused while a transmission of the attempt is still in flight.
   */
  async applyReconciliation(raw: unknown): Promise<OmsResult<AttemptView>> {
    return this.#guarded(async () => {
      const fields = readFields(raw, ["requestId", "submissionAttemptId", "verdict", "order", "transmissionQuiescent"]);
      if (fields === undefined || !isIdentifier(fields.requestId) || !isUuidV7(fields.submissionAttemptId)) {
        return refuse("OMS_RECONCILIATION_UNRECOGNISED", "an answer needs a requestId and a submissionAttemptId, as own data");
      }
      const requestId = fields.requestId;
      const request = this.#requests.get(requestId);
      if (request === undefined) {
        this.#namedUnissued.add(requestId);
        return refuse("OMS_RECONCILIATION_UNBOUND", "the answer names a request this manager never issued");
      }
      if (request.attemptId !== fields.submissionAttemptId) {
        return refuse("OMS_RECONCILIATION_SUBJECT_MISMATCH", "the answer names a request issued for another attempt");
      }
      const attempt = this.#attempts.get(request.attemptId);
      if (attempt === undefined) throw new OmsInvariantError("a request names a missing attempt");
      if (attempt.currentRequestId !== requestId || request.consumed) {
        return refuse("OMS_RECONCILIATION_SUPERSEDED", "the answer is for a request that is no longer current");
      }
      if (!request.delivered) return refuse("OMS_RECONCILIATION_UNBOUND", "the answer names a request that was never delivered");
      const verdict = fields.verdict;
      if (verdict === "UNRESOLVED") return ok(this.#attemptView(attempt));
      if (verdict === "ABSENT") {
        if (fields.order !== undefined) return refuse("OMS_RECONCILIATION_UNRECOGNISED", "an ABSENT answer carries no order");
        if (attempt.inFlight) {
          return refuse("OMS_RECONCILIATION_IN_FLIGHT", "a read made while a transmission is in flight cannot prove absence");
        }
        if (fields.transmissionQuiescent !== true) {
          return refuse(
            "OMS_RECONCILIATION_NOT_QUIESCENT",
            "an ABSENT answer must attest that its read was made after every transmission of the attempt could still arrive",
          );
        }
        return this.#applyAbsent(attempt);
      }
      if (verdict === "PRESENT") {
        const venue = readPresentOrder(fields.order);
        if (venue === undefined) {
          return refuse("OMS_RECONCILIATION_UNRECOGNISED", "a PRESENT answer needs the venue order id, a known status and exact sizes");
        }
        return this.#applyPresent(attempt, venue);
      }
      return refuse("OMS_RECONCILIATION_UNRECOGNISED", "the verdict is not ABSENT, PRESENT or UNRESOLVED");
    });
  }

  /** The coordinator's pause (§9.17 step 1). Cancels and reconciliation continue. */
  pause(): void {
    this.#paused = true;
  }

  /**
   * Resume new submissions; refused while any attempt or order still awaits an
   * authoritative read (PAUSE AND RESUME in the header).
   */
  resume(): OmsResult<true> {
    if (this.#faulted) return refuse("OMS_FAULTED", "the manager is faulted; reopen it from the store");
    const blocker = this.#resumeBlocker();
    if (blocker !== undefined) return blocker;
    this.#paused = false;
    return ok(true);
  }

  /**
   * A manual or discrepancy trigger (§9.17: "manual request", "position/balance
   * discrepancy"): an open order known to the venue goes to RECONCILING and an
   * authoritative read is requested. It also clears a cancel whose answer never
   * came: a late cancel answer is then recorded only.
   */
  async requestOrderReconciliation(orderId: string): Promise<OmsResult<OrderView>> {
    return this.#guarded(async () => {
      const order = this.#orders.get(orderId);
      if (order === undefined) return refuse("OMS_UNKNOWN_ORDER", "no such order", { orderId });
      const open =
        order.state === "ACKNOWLEDGED" ||
        order.state === "LIVE" ||
        order.state === "DELAYED" ||
        order.state === "PARTIALLY_FILLED" ||
        order.state === "CANCEL_PENDING";
      if (order.venueOrderId === null || !open) {
        return refuse("OMS_ILLEGAL_TRANSITION", "only an open order with a known venue order id is reconciled here", { state: order.state });
      }
      const attempt = this.#mustAttempt(order.attemptId);
      const fx = effects();
      this.#transition(order, "RECONCILING", "RECONCILIATION_REQUESTED", fx, { reasonCode: "MANUAL_REQUEST" });
      fx.requests.add(attempt);
      if (!(await this.#commit(fx))) return storeFailed();
      return ok(this.#orderView(order));
    });
  }

  // -------------------------------------------------------------------------
  // Cancel and replace.

  /** Cancel one order by its venue id. Never gated by the venue mode (`VENUE_FACTS.CANCELS_IN_CANCEL_ONLY`). */
  async requestCancel(orderId: string): Promise<OmsResult<OrderView>> {
    return this.#guarded(async () => {
      const order = this.#orders.get(orderId);
      if (order === undefined) return refuse("OMS_UNKNOWN_ORDER", "no such order", { orderId });
      const venueOrderId = order.venueOrderId;
      const cancellable =
        order.state === "ACKNOWLEDGED" ||
        order.state === "LIVE" ||
        order.state === "DELAYED" ||
        order.state === "PARTIALLY_FILLED" ||
        order.state === "RECONCILING";
      if (venueOrderId === null || !cancellable) {
        return refuse("OMS_CANCEL_NOT_APPLICABLE", "only an open order with a known venue order id can be canceled by id", {
          state: order.state,
          hasVenueOrderId: venueOrderId !== null,
        });
      }
      const attempt = order.attemptId === null ? undefined : this.#attempts.get(order.attemptId);
      if (attempt === undefined) throw new OmsInvariantError("an order with a venue id has an attempt");
      const fx = effects();
      order.cancelRevert = order.state;
      this.#transition(order, "CANCEL_PENDING", "CANCEL_REQUESTED", fx, { payload: { cancelRevert: order.state } });
      // A cancel is new evidence-causing action: an outstanding read no longer describes the order.
      this.#consumeCurrentRequest(attempt);
      if (!(await this.#commit(fx))) return storeFailed();
      let raw: unknown;
      try {
        raw = await this.#deps.venue.cancelOrder(venueOrderId);
      } catch {
        raw = undefined;
      }
      const cls = readCancelOutcome(raw, venueOrderId);
      const after = effects();
      this.#applyCancel(order, attempt, cls, after);
      if (!(await this.#commit(after))) return storeFailed();
      return ok(this.#orderView(order));
    });
  }

  /**
   * Stage a replacement for an order and cancel the order. The replacement is
   * a NEW order with a NEW salt, so it is submitted only through the salt
   * gate: `submitStagedReplacement` once the old order is terminal with a
   * known final size. Its size is then capped by the group's remainder.
   */
  async requestReplace(orderId: string, replacement: unknown): Promise<OmsResult<OrderView>> {
    return this.#guarded(async () => {
      const order = this.#orders.get(orderId);
      if (order === undefined) return refuse("OMS_UNKNOWN_ORDER", "no such order", { orderId });
      const ticket = readTicket(replacement);
      if (ticket === undefined) return refuse("OMS_INVALID_INPUT", "the replacement is not a valid order ticket");
      // ADR-034 D2.4: an off-grid replacement is refused before it is staged, so nothing is canceled for it.
      const offGrid = offGridRefusal(ticket);
      if (offGrid !== undefined) return offGrid;
      if (ticket.groupId !== order.groupId) {
        return refuse("OMS_GROUP_MISMATCH", "a replacement belongs to the replaced order's group", { executionGroupId: order.groupId });
      }
      if (this.#orders.has(ticket.orderId)) return refuse("OMS_DUPLICATE_ORDER", "the replacement's order id is already used");
      const group = this.#mustGroup(order.groupId);
      group.staged = ticket;
      if (order.state === "ACKNOWLEDGED" || order.state === "LIVE" || order.state === "DELAYED" || order.state === "PARTIALLY_FILLED") {
        const canceled = await this.requestCancel(orderId);
        if (!canceled.ok) return canceled;
      }
      return ok(this.#orderView(order));
    });
  }

  /** Submit the group's staged replacement, through the salt gate. */
  async submitStagedReplacement(groupId: string): Promise<OmsResult<SubmissionReport>> {
    return this.#guarded(async () => {
      const group = this.#groups.get(groupId);
      if (group === undefined) return refuse("OMS_UNKNOWN_GROUP", "no such group", { executionGroupId: groupId });
      const staged = group.staged;
      if (staged === null) return refuse("OMS_NO_STAGED_REPLACEMENT", "this group has no staged replacement");
      const gate = this.#saltGate(group);
      if (!gate.open) {
        return refuse("OMS_REPLACEMENT_NOT_READY", "the replaced order is not yet closed", {
          blockers: gate.blockers.map((blocker) => `${blocker.id}:${blocker.reason}`).join(","),
        });
      }
      const result = await this.submit(stagedTicketInput(staged));
      if (result.ok) group.staged = null;
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // Venue evidence: observations, fills, settlements.

  /**
   * A non-authoritative order observation (the user stream). It moves an open
   * order along; it never resolves RECONCILING (only an authoritative answer
   * does) and never creates a rejection or a cancel from `unmatched`
   * (`VENUE_FACTS.UNMATCHED_ACCEPTED_NOT_FILLED`). An unrecognised status
   * sends a non-terminal order to RECONCILING. On a terminal order, a status
   * that contradicts it and an unrecognised status alike reopen it to
   * RECONCILING with a state conflict (STATE CONFLICTS in the header). An
   * observation naming a venue order id no order holds yet is retained while
   * an unresolved attempt could own it (UNATTRIBUTED EVIDENCE).
   */
  async applyOrderObservation(raw: unknown): Promise<OmsResult<OrderView>> {
    return this.#guarded(async () => {
      const fields = readFields(raw, ["venueOrderId", "status"]);
      if (fields === undefined || !isVenueId(fields.venueOrderId)) {
        return refuse("OMS_OBSERVATION_UNRECOGNISED", "an observation needs a venue order id, as own data");
      }
      const status = isObservedStatus(fields.status) ? fields.status : null;
      const orderId = this.#ordersByVenueId.get(fields.venueOrderId);
      if (orderId === undefined) return this.#unattributed({ venueOrderId: fields.venueOrderId, fill: null, observation: { status } });
      return this.#observe(this.#mustOrder(orderId), status);
    });
  }

  /** An observation of an order this manager holds; `status` is `null` when unrecognised. */
  async #observe(order: OrderModel, status: ObservedStatus | null): Promise<OmsResult<OrderView>> {
    const attempt = this.#mustAttempt(order.attemptId);
    const fx = effects();
    if (status === null) {
      if (TERMINAL_ORDER_STATES.has(order.state)) {
        // Never an assumption that an unknown status is harmless: reopen and read (STATE CONFLICTS).
        this.#reopenTerminal(order, attempt, "OBSERVATION_UNRECOGNISED", "a terminal order was observed with an unrecognised status", fx, {
          reasonCode: "UNRECOGNISED_STATUS",
        });
      } else if (order.state !== "RECONCILING") {
        this.#transition(order, "RECONCILING", "OBSERVATION_UNRECOGNISED", fx, { reasonCode: "UNRECOGNISED_STATUS", source: "polymarket" });
        fx.requests.add(attempt);
      }
    } else {
      this.#applyObservation(order, attempt, status, fx);
    }
    if (!(await this.#commit(fx))) return storeFailed();
    return ok(this.#orderView(order));
  }

  /**
   * One fill (a venue trade against our order). Deduplicated on (trade id,
   * order id, discriminator) (§10.7). A fill that contradicts its order (wrong
   * side of the limit, more than the order, more than a confirmed final size)
   * is refused with a market-halt alert: reconciliation owns it (WP-290). A
   * fill naming a venue order id no order holds yet is retained while an
   * unresolved attempt could own it (UNATTRIBUTED EVIDENCE).
   */
  async recordFill(raw: unknown): Promise<OmsResult<OrderView>> {
    return this.#guarded(async () => {
      const fill = readFill(raw);
      if (fill === undefined) {
        return refuse("OMS_INVALID_INPUT", "a fill needs trade and order ids, positive shares, a unit price, a liquidity role and matchedAt");
      }
      const orderId = this.#ordersByVenueId.get(fill.venueOrderId);
      if (orderId === undefined) return this.#unattributed({ venueOrderId: fill.venueOrderId, fill, observation: null });
      return this.#applyFill(this.#mustOrder(orderId), fill);
    });
  }

  /**
   * A fill of an order this manager holds. Every decision is taken synchronously, before the first await, so
   * that taking a retained fill and deciding on it happen in one step (`#drainRetained`).
   */
  async #applyFill(order: OrderModel, fill: ValidatedFill): Promise<OmsResult<OrderView>> {
    const key = fillKey(fill.venueTradeId, fill.venueOrderId, fill.allocationDiscriminator);
    const existing = this.#fills.get(key);
    if (existing !== undefined) {
      // Every fact of the fill must agree: the money (shares, price, fee), the liquidity role, and the match
      // time as an instant (offsets applied; the coarser text the finer one truncated or rounded: `sameInstant`).
      const same =
        existing.record.shares === fill.shares &&
        existing.record.price === fill.price &&
        existing.record.feeAmount === fill.feeAmount &&
        existing.record.feeAssetId === fill.feeAssetId &&
        existing.record.liquidityRole === fill.liquidityRole &&
        sameInstant(existing.record.matchedAt, fill.matchedAt);
      if (same) return ok(this.#orderView(order));
      this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, order.attemptId, "a fill was reported twice with different facts");
      return refuse("OMS_FILL_CONFLICT", "this fill is already recorded with different facts");
    }
    const inconsistent = this.#fillInconsistency(order, fill);
    if (inconsistent !== undefined) {
      this.#alert("FILL_INCONSISTENT", true, order.marketId, order.orderId, order.attemptId, inconsistent);
      return refuse("OMS_FILL_INCONSISTENT", inconsistent, { orderId: order.orderId });
    }
    const fillId = this.#drawId();
    if (fillId === undefined) return refuse("OMS_ID_SOURCE_FAILED", "the id source gave no fresh UUIDv7");
    const fx = effects();
    const debit = this.#debitOf(order, fill);
    const before = order.filledShares;
    const after = addDecimal(before, fill.shares);
    const record: FillRecord = Object.freeze({
      fillId,
      orderId: order.orderId,
      marketId: order.marketId,
      tokenId: order.tokenId,
      accountRef: order.accountRef,
      venueTradeId: fill.venueTradeId,
      venueOrderId: fill.venueOrderId,
      allocationDiscriminator: fill.allocationDiscriminator,
      side: order.side,
      shares: fill.shares,
      price: fill.price,
      notional: mulDecimal(fill.shares, fill.price),
      feeAmount: fill.feeAmount,
      feeAssetId: fill.feeAssetId,
      liquidityRole: fill.liquidityRole,
      matchedAt: fill.matchedAt,
    });
    const allocations = allocationsFor(order, fillId, before, after);
    this.#fills.set(key, { record, debit, settlement: null, settlementOrdinal: 0, stateHashes: new Set() });
    order.filledShares = after;
    order.debited = addDecimal(order.debited, debit);
    fx.writes.push({ kind: "INSERT_FILL", fill: record, allocations });
    const complete = compareDecimal(after, order.originalShares) === 0;
    const payload = { debit, fillId };
    if (complete && !TERMINAL_ORDER_STATES.has(order.state)) {
      this.#transition(order, "FILLED", "FILL", fx, { sharesDelta: fill.shares, source: "polymarket", payload: { ...payload, finalSize: order.originalShares } });
      order.finalSize = order.originalShares;
      const attempt = this.#mustAttempt(order.attemptId);
      this.#consumeCurrentRequest(attempt);
    } else if (order.state === "ACKNOWLEDGED" || order.state === "LIVE" || order.state === "DELAYED") {
      this.#transition(order, "PARTIALLY_FILLED", "FILL", fx, { sharesDelta: fill.shares, source: "polymarket", payload });
    } else {
      this.#record(order, "FILL", fx, { sharesDelta: fill.shares, source: "polymarket", payload });
    }
    // A read outstanding for this order may predate the fill (and so under-report the matched size):
    // supersede it, so only a read requested after this fill can describe the order (WP-300 R7-X3's rule).
    const owner = this.#mustAttempt(order.attemptId);
    if (owner.currentRequestId !== null && order.state !== "FILLED") fx.requests.add(owner);
    // A filled order needs no read, unless it carries an open state conflict (STATE CONFLICTS): then it needs
    // the read that can clear it, made after this fill.
    if (order.state === "FILLED" && order.conflict) fx.requests.add(owner);
    if (!(await this.#commit(fx))) return storeFailed();
    // Durable first, then consume (a replayed consume is a duplicate pending id: done).
    await this.#consume(order, record, debit);
    await this.#maybeRelease(order);
    if (!(await this.#settled())) return storeFailed();
    return ok(this.#orderView(order));
  }

  /**
   * One trade-settlement observation (§9.11 trade settlement machine; §6
   * invariant 5). Stale deliveries are refused; CONFIRMED against FAILED is a
   * conflict; FAILED raises a halt alert (ADR-006 §5: a compensating reversal
   * is the ledger's). A repeated state is idempotent unless it carries a
   * transaction hash not yet recorded for that state, which is appended as a
   * same-state row (the log keeps the enrichment, or the contradiction with a
   * non-halting alert). A hash already recorded for the state is a duplicate,
   * whichever row recorded it (r3, OP-R3-01: two sources alternating between
   * two hashes add one row and one alert, not one per report).
   */
  async applySettlement(raw: unknown): Promise<OmsResult<SettlementState>> {
    return this.#guarded(async () => {
      const fields = readFields(raw, ["venueTradeId", "venueOrderId", "allocationDiscriminator", "status", "transactionHash", "observedAt"]);
      if (
        fields === undefined ||
        !isIdentifier(fields.venueTradeId) ||
        !isVenueId(fields.venueOrderId) ||
        !(fields.allocationDiscriminator === undefined || isIdentifier(fields.allocationDiscriminator)) ||
        !(fields.transactionHash === undefined || fields.transactionHash === null || isIdentifier(fields.transactionHash)) ||
        !isTimestampText(fields.observedAt)
      ) {
        return refuse("OMS_INVALID_INPUT", "a settlement observation needs trade and order ids and observedAt, as own data");
      }
      const key = fillKey(fields.venueTradeId, fields.venueOrderId, (fields.allocationDiscriminator as string | undefined) ?? "0");
      const fill = this.#fills.get(key);
      if (fill === undefined) return refuse("OMS_UNKNOWN_FILL", "no recorded fill matches; reconcile the trade first");
      const order = this.#mustOrder(fill.record.orderId);
      const status = fields.status;
      if (!isSettlementState(status)) {
        return refuse("OMS_SETTLEMENT_UNRECOGNISED", "the settlement status is not one of MATCHED, MINED, CONFIRMED, RETRYING, FAILED");
      }
      const current = fill.settlement;
      const transactionHash = (fields.transactionHash as string | null | undefined) ?? null;
      if (current === status) {
        // The same state again. Without a transaction hash, or with one already recorded for this state, it is
        // a duplicate (idempotent). With a new one, it is evidence the append-only log keeps, as a same-state
        // row: a hash the earlier reports lacked, or one that differs from every hash recorded, which also
        // raises a non-halting alert (no venue fact says whether a state can be re-reported in another
        // transaction, so it is recorded, not judged).
        if (transactionHash === null || fill.stateHashes.has(transactionHash)) return ok(status);
        if (fill.stateHashes.size > 0) {
          this.#alert(
            "SETTLEMENT_CONFLICT",
            false,
            order.marketId,
            order.orderId,
            order.attemptId,
            `settlement ${status} re-reported with a different transaction hash`,
          );
        }
      } else if (current !== null && !isLegalSettlementTransition(current, status)) {
        // FAILED is terminal: anything after it contradicts it. CONFIRMED then FAILED contradicts too.
        // Anything else is an earlier state delivered late (a regression).
        const conflict = current === "FAILED" || (current === "CONFIRMED" && status === "FAILED");
        if (conflict) {
          this.#alert("SETTLEMENT_CONFLICT", true, order.marketId, order.orderId, order.attemptId, `settlement ${current} contradicted by ${status}`);
          return refuse("OMS_SETTLEMENT_CONFLICT", "the settlement contradicts a terminal settlement state", { current, observed: status });
        }
        return refuse("OMS_SETTLEMENT_REGRESSION", "a stale settlement observation (an earlier state)", { current, observed: status });
      }
      const record: TradeSettlementRecord = Object.freeze({
        fillId: fill.record.fillId,
        stateOrdinal: fill.settlementOrdinal,
        previousState: current,
        state: status,
        venueTradeId: fill.record.venueTradeId,
        transactionHash,
        observedAt: fields.observedAt,
      });
      // A new state starts its own set of recorded hashes.
      if (current !== status) fill.stateHashes = new Set();
      if (transactionHash !== null) fill.stateHashes.add(transactionHash);
      fill.settlement = status;
      fill.settlementOrdinal += 1;
      if (status === "FAILED" && current !== "FAILED") {
        this.#alert("SETTLEMENT_FAILED", true, order.marketId, order.orderId, order.attemptId, "a trade settlement FAILED; the ledger owes a compensating reversal");
      }
      if (!(await this.#persist([{ kind: "APPEND_SETTLEMENT", settlement: record }]))) return storeFailed();
      return ok(status);
    });
  }

  // =========================================================================
  // Internals.

  /** `resume()`'s rule: the first attempt or order still awaiting an authoritative read, as a refusal. */
  #resumeBlocker(): OmsResult<never> | undefined {
    for (const attempt of this.#attempts.values()) {
      // Held for the retransmission decision: authoritatively and quiescently absent, nothing in flight.
      const held = attempt.state === "RECONCILING" && attempt.absentConfirmed && !attempt.inFlight;
      if (held) continue;
      if (attempt.state === "SENDING" || attempt.state === "SUBMISSION_UNKNOWN" || attempt.state === "RECONCILING") {
        return refuse("OMS_RESUME_BLOCKED", "an attempt is still unresolved", { attemptId: attempt.attemptId, state: attempt.state });
      }
      const order = this.#orders.get(attempt.orderId);
      if (order !== undefined && order.state === "RECONCILING") {
        return refuse("OMS_RESUME_BLOCKED", "an order is still reconciling", { orderId: order.orderId });
      }
    }
    return undefined;
  }

  async #guarded<T>(body: () => Promise<OmsResult<T>>): Promise<OmsResult<T>> {
    if (this.#faulted) return refuse("OMS_FAULTED", "the manager is faulted; reopen it from the store");
    try {
      return await body();
    } catch {
      // An internal invariant failed, or a port broke its contract by throwing where it must not.
      this.#faulted = true;
      return refuse("OMS_FAULTED", "an internal invariant failed; the manager is faulted and must be reopened from the store");
    }
  }

  // ----- admission (synchronous: check and claim in one step) --------------

  #admit(raws: readonly unknown[]): OmsResult<readonly Prepared[]> {
    if (this.#paused) return refuse("OMS_PAUSED", "new submissions are paused until every recovered attempt is resolved");
    const tickets: ValidatedTicket[] = [];
    for (const raw of raws) {
      const ticket = readTicket(raw);
      if (ticket === undefined) {
        return refuse(
          "OMS_INVALID_INPUT",
          "a ticket needs a UUIDv7 orderId, a registered group, a limit price in (0,1), positive shares, a reservation and attributions summing to the shares",
        );
      }
      // ADR-034 D2.4: before the PLANNED row and before `reserve`, so nothing is recorded, reserved, signed or sent.
      const offGrid = offGridRefusal(ticket);
      if (offGrid !== undefined) return offGrid;
      tickets.push(ticket);
    }
    const orderIds = new Set<string>();
    const groupIds = new Set<string>();
    for (const ticket of tickets) {
      if (orderIds.has(ticket.orderId) || this.#orders.has(ticket.orderId) || this.#usedIds.has(ticket.orderId)) {
        return refuse("OMS_DUPLICATE_ORDER", "the order id is already used", { orderId: ticket.orderId });
      }
      orderIds.add(ticket.orderId);
      if (groupIds.has(ticket.groupId)) {
        return refuse("OMS_SALT_GATE_CLOSED", "two orders of one group cannot be signed together (§9.11 step 10)", { executionGroupId: ticket.groupId });
      }
      groupIds.add(ticket.groupId);
    }
    const mode = this.#mode();
    const prepared: Prepared[] = [];
    for (const ticket of tickets) {
      const group = this.#groups.get(ticket.groupId);
      if (group === undefined) return refuse("OMS_UNKNOWN_GROUP", "register the group first", { executionGroupId: ticket.groupId });
      const record = group.record;
      if (mode === "TRADING_UNAVAILABLE") return refuse("OMS_TRADING_UNAVAILABLE", "the venue mode admits no placement");
      if (mode === "POST_ONLY" && !record.postOnly) {
        return refuse("OMS_POST_ONLY_MODE", "the venue is in post-only mode; this group is not post-only (a change is a new plan)");
      }
      const gate = this.#saltGate(group);
      if (!gate.open) {
        return refuse("OMS_SALT_GATE_CLOSED", "an earlier attempt of this group is not yet authoritatively closed (§9.11 step 10)", {
          executionGroupId: ticket.groupId,
          blockers: gate.blockers.map((blocker) => `${blocker.id}:${blocker.reason}`).join(","),
        });
      }
      if (!record.postOnly && group.attemptIds.some((id) => this.#attempts.get(id)?.postOnlyRefused === true)) {
        return refuse("OMS_POST_ONLY_RETRY_FORBIDDEN", "a post-only-mode refusal forbids sending this order again unchanged; plan anew", {
          executionGroupId: ticket.groupId,
        });
      }
      const remaining = gate.remaining;
      if (remaining === null || compareDecimal(ticket.shares, remaining) > 0) {
        return refuse("OMS_GROUP_REMAINDER_EXCEEDED", "the order exceeds what remains of its group", {
          shares: ticket.shares,
          remaining,
        });
      }
      const reservationProblem = this.#reservationProblem(record, ticket);
      if (reservationProblem !== undefined) return refuse("OMS_RESERVATION_MISMATCH", reservationProblem);
      prepared.push({ ticket, group, ordinal: group.nextOrdinal });
    }
    // Claim every group in the same synchronous step as the checks above.
    for (const item of prepared) {
      item.group.claim = item.ticket.orderId;
      item.group.nextOrdinal += 1;
    }
    return ok(Object.freeze(prepared));
  }

  #reservationProblem(group: GroupRecord, ticket: ValidatedTicket): string | undefined {
    const { reservation } = ticket;
    if (group.side === "BUY") {
      if (reservation.assetId !== this.#deps.collateralAssetId) return "a BUY reserves the collateral asset";
      if (compareDecimal(reservation.amount, mulDecimal(ticket.limitPrice, ticket.shares)) < 0) {
        return "a BUY reservation must cover limit price x shares";
      }
      return undefined;
    }
    if (reservation.assetId !== group.tokenId) return "a SELL reserves the outcome token it sells";
    if (compareDecimal(reservation.amount, ticket.shares) < 0) return "a SELL reservation must cover the shares";
    return undefined;
  }

  // ----- steps 0-4 ----------------------------------------------------------

  async #reserveSignPersist(prepared: readonly Prepared[]): Promise<OmsResult<readonly SignedItem[]>> {
    const models: OrderModel[] = [];
    const planned = effects();
    for (const item of prepared) {
      const order = this.#newOrder(item);
      models.push(order);
      this.#orders.set(order.orderId, order);
      this.#usedIds.add(order.orderId);
      item.group.orderIds.push(order.orderId);
      planned.writes.push({ kind: "INSERT_ORDER", order: this.#orderRecord(order) });
      planned.writes.push({ kind: "APPEND_ORDER_EVENT", event: this.#plannedEvent(order) });
      for (const attribution of order.attributions) {
        const link: IntentOrderLinkRecord = Object.freeze({
          intentId: attribution.intentId,
          approvedIntentId: attribution.approvedIntentId,
          orderId: order.orderId,
          attributedShares: attribution.shares,
        });
        planned.writes.push({ kind: "INSERT_INTENT_LINK", link });
      }
    }
    if (!(await this.#commit(planned))) {
      this.#releaseClaims(prepared);
      return storeFailed();
    }
    // Reserve in a stable asset order (WP-040 F12: avoid the reservation deadlock).
    const byAsset = [...models].sort((a, b) =>
      a.reservation.assetId === b.reservation.assetId
        ? a.reservation.reservationId < b.reservation.reservationId
          ? -1
          : 1
        : a.reservation.assetId < b.reservation.assetId
          ? -1
          : 1,
    );
    const reservedFx = effects();
    for (const order of byAsset) {
      let answer: unknown;
      try {
        answer = await this.#deps.reservations.reserve({
          reservationId: order.reservation.reservationId,
          holderRef: order.orderId,
          accountRef: order.accountRef,
          assetId: order.reservation.assetId,
          amount: order.reservation.amount,
        });
      } catch {
        answer = undefined;
      }
      const result = readPortResult(answer);
      if (!result.ok) {
        if (result.code === "UNREADABLE_ANSWER" || result.code === "UNREADABLE_REFUSAL" || result.code === "INVENTORY_JOURNAL_FAILED") {
          // The reservation may exist (a thrown or unreadable answer; a journal failure keeps the in-memory effect):
          // release it on rollback, reading "not found" as never made. A definite refusal is never released.
          order.reservationHeld = true;
          order.reservationUncertain = true;
        }
        await this.#commit(reservedFx);
        await this.#rollback(prepared, models, "RESERVATION_REFUSED");
        return refuse("OMS_RESERVATION_REFUSED", "the inventory refused the reservation", { code: result.code, orderId: order.orderId });
      }
      order.reservationHeld = true;
      this.#record(order, "RESERVED", reservedFx, { payload: { reservationId: order.reservation.reservationId } });
    }
    if (!(await this.#commit(reservedFx))) {
      this.#releaseClaims(prepared);
      return storeFailed();
    }
    // Steps 1-3 for each order, then ONE transaction for steps 3-4.
    const signed: { attempt: AttemptModel; order: OrderModel }[] = [];
    const batchSalts = new Set<string>();
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index] as Prepared;
      const order = models[index] as OrderModel;
      const attemptId = this.#drawId(); // step 1, before signing
      if (attemptId === undefined) {
        await this.#rollback(prepared, models, "ID_SOURCE_FAILED");
        return refuse("OMS_ID_SOURCE_FAILED", "the id source gave no fresh UUIDv7");
      }
      let raw: unknown;
      try {
        raw = await this.#deps.venue.createLimitOrder(signRequest(order)); // step 2
      } catch {
        raw = undefined;
      }
      const sign = readSignOutcome(raw);
      if (sign.kind === "FAILED") {
        // WP-260: a FAILED sign outcome means no order exists. Nothing was transmitted.
        await this.#rollback(prepared, models, "SIGN_FAILED");
        return refuse("OMS_SIGN_FAILED", "signing failed; no order exists", { errorKind: sign.errorKind });
      }
      const mismatch = identityMismatch(order, sign.identity);
      if (mismatch !== undefined || this.#salts.has(sign.identity.salt) || batchSalts.has(sign.identity.salt)) {
        await this.#rollback(prepared, models, "SIGNED_ORDER_MISMATCH");
        return refuse("OMS_SIGNED_ORDER_MISMATCH", mismatch ?? "the signed order reuses a salt already recorded");
      }
      batchSalts.add(sign.identity.salt);
      const encrypted = await this.#encrypt(sign.handle, sign.identity);
      if (encrypted === undefined) {
        await this.#rollback(prepared, models, "CIPHER_FAILED");
        return refuse("OMS_CIPHER_FAILED", "the signed payload could not be encrypted and verified; nothing was persisted or sent");
      }
      const attempt: AttemptModel = {
        attemptId,
        groupId: item.group.record.executionGroupId,
        planId: item.group.record.planId,
        orderId: order.orderId,
        accountRef: order.accountRef,
        ordinal: item.ordinal,
        salt: sign.identity.salt,
        signedPayload: encrypted,
        // THE STOP ITEM: never computed here (see the header).
        expectedOrderHash: null,
        handle: sign.handle,
        identity: sign.identity,
        state: "SIGNED",
        responseStatus: null,
        errorCode: null,
        venueOrderId: null,
        inFlight: false,
        lostDeclared: false,
        absentConfirmed: false,
        postOnlyRefused: false,
        requestCount: 0,
        currentRequestId: null,
        requestOwed: false,
      };
      signed.push({ attempt, order });
    }
    const commit = effects();
    for (const { attempt, order } of signed) {
      commit.writes.push({ kind: "INSERT_ATTEMPT", attempt: this.#attemptRecord(attempt) });
      order.attemptId = attempt.attemptId;
      this.#transition(order, "SIGNED", "SIGNED", commit, { payload: { submissionAttemptId: attempt.attemptId } });
    }
    // Register in memory before awaiting: the attempts now hold the gate.
    for (const { attempt } of signed) {
      this.#attempts.set(attempt.attemptId, attempt);
      this.#salts.add(attempt.salt);
      this.#mustGroup(attempt.groupId).attemptIds.push(attempt.attemptId);
    }
    this.#releaseClaims(prepared);
    if (!(await this.#commit(commit))) return storeFailed();
    return ok(Object.freeze(signed.map((item) => Object.freeze(item))));
  }

  /** Undo an admission that never produced a persisted attempt: nothing was transmitted. */
  async #rollback(prepared: readonly Prepared[], models: readonly OrderModel[], reason: string): Promise<void> {
    const fx = effects();
    for (const order of models) {
      if (order.state === "PLANNED") {
        this.#transition(order, "CANCELED", "ABANDONED", fx, { reasonCode: reason, payload: { finalSize: ZERO } });
        order.finalSize = ZERO;
        if (order.reservationHeld) fx.releases.add(order);
      }
    }
    this.#releaseClaims(prepared);
    await this.#commit(fx);
  }

  #releaseClaims(prepared: readonly Prepared[]): void {
    for (const item of prepared) {
      if (item.group.claim === item.ticket.orderId) item.group.claim = null;
    }
  }

  async #encrypt(handle: SignedOrderHandle, identity: SignedOrderIdentity): Promise<EncryptedPayload | undefined> {
    let payload: unknown;
    try {
      payload = handle.revealPayloadForEncryptedPersistence();
    } catch {
      return undefined;
    }
    const plaintext = canonicalFlatJson(payload);
    if (plaintext === undefined) return undefined;
    const salt = readField(payload, "salt");
    const signature = readField(payload, "signature");
    if (salt.kind !== "DATA" || salt.value !== identity.salt) return undefined;
    if (signature.kind !== "DATA" || typeof signature.value !== "string" || signature.value.length < 4) return undefined;
    let encrypted: unknown;
    try {
      encrypted = await this.#deps.cipher.encrypt(plaintext);
    } catch {
      return undefined;
    }
    const sealed = readEncrypted(encrypted);
    if (sealed === undefined) return undefined;
    // Encrypted at rest, not merely renamed: the ciphertext must not carry the signature or the plaintext.
    if (sealed.ciphertext === plaintext || sealed.ciphertext.includes(signature.value)) return undefined;
    // The payload must be recoverable before anything depends on it: decrypt, compare, and restore.
    let decrypted: unknown;
    try {
      decrypted = await this.#deps.cipher.decrypt(sealed);
    } catch {
      return undefined;
    }
    if (decrypted !== plaintext) return undefined;
    const restored = this.#restore(plaintext);
    if (restored === undefined || restored.identity.salt !== identity.salt) return undefined;
    return sealed;
  }

  #restore(plaintext: string): { handle: SignedOrderHandle; identity: SignedOrderIdentity } | undefined {
    const parsed = parseFlatJson(plaintext);
    if (parsed === undefined) return undefined;
    let raw: unknown;
    try {
      raw = this.#deps.restoreSignedOrder(parsed);
    } catch {
      return undefined;
    }
    if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
    const identityRead = readField(raw, "identity");
    if (identityRead.kind !== "DATA") return undefined;
    const sign = readSignOutcome({ kind: "SIGNED", order: raw });
    return sign.kind === "SIGNED" ? { handle: sign.handle, identity: sign.identity } : undefined;
  }

  // ----- steps 5-8 ----------------------------------------------------------

  async #transmit(items: readonly SignedItem[], batch: boolean): Promise<OmsResult<readonly SubmissionReport[]>> {
    const mode = this.#mode();
    const blocked = items.some(
      ({ order }) => mode === "TRADING_UNAVAILABLE" || (mode === "POST_ONLY" && !order.postOnly),
    );
    if (blocked) {
      // Nothing is transmitted; the attempts stay as they are (SIGNED or confirmed absent) and keep the gate closed.
      return ok(Object.freeze(items.map(({ attempt, order }) => this.#report(attempt, order, null))));
    }
    const fx = effects();
    for (const { attempt, order } of items) {
      if (attempt.inFlight || attempt.handle === null) throw new OmsInvariantError("a transmission needs an idle attempt with its signed order");
      // A new transmission: the previous answer no longer describes the attempt. Clearing the codes also means
      // a transmission whose answer is lost (or dies with the process) is never taken for the 425 restart path.
      this.#setAttempt(attempt, "SENDING", null, null, fx);
      this.#transition(order, "SENDING", "SENDING", fx, {});
    }
    // Step 5: the SENDING mark is durable BEFORE the venue is called.
    if (!(await this.#commit(fx))) return storeFailed();
    for (const { attempt } of items) {
      attempt.inFlight = true;
      attempt.lostDeclared = false;
    }
    const handles = items.map(({ attempt }) => attempt.handle as SignedOrderHandle);
    let classes: readonly PlacementClass[];
    if (batch) {
      let raw: unknown;
      try {
        raw = await this.#deps.venue.postOrders(Object.freeze(handles));
      } catch {
        raw = undefined;
      }
      classes = classifyBatch(raw, items.length);
    } else {
      let raw: unknown;
      try {
        raw = await this.#deps.venue.postOrder(handles[0] as SignedOrderHandle);
      } catch {
        raw = Object.freeze({ kind: "UNKNOWN", reason: "PORT_THREW", error: null });
      }
      classes = [readPlacementOutcome(raw)];
    }
    for (const { attempt } of items) attempt.inFlight = false;
    const outcome = effects();
    for (let index = 0; index < items.length; index += 1) {
      const { attempt, order } = items[index] as SignedItem;
      const cls = classes[index];
      if (cls === undefined) throw new OmsInvariantError("one class per transmitted order");
      if (attempt.lostDeclared) this.#applyLateOutcome(attempt, order, cls, outcome);
      else this.#applyPlacement(attempt, order, cls, outcome);
    }
    if (!(await this.#commit(outcome))) return storeFailed();
    // UNATTRIBUTED EVIDENCE: a fill or an observation that raced this answer is applied now (or released).
    if (!(await this.#drainRetained())) return storeFailed();
    return ok(
      Object.freeze(
        items.map(({ attempt, order }, index) => this.#report(attempt, order, classes[index] ?? null)),
      ),
    );
  }

  /** Steps 6-7 for an attempt in SENDING. */
  #applyPlacement(attempt: AttemptModel, order: OrderModel, cls: PlacementClass, fx: Effects): void {
    switch (cls.kind) {
      case "ACCEPTED": {
        if (!this.#venueIdFree(cls.venueOrderId, order.orderId)) {
          this.#toUnknown(attempt, order, "VENUE_ID_CONFLICT", null, fx);
          this.#markVenueIdConflict(order, attempt, cls.venueOrderId, "PLACEMENT_VENUE_ID_CONFLICT", "an accepted placement named a venue order id another order holds", fx);
          return;
        }
        this.#adoptVenueId(attempt, order, cls.venueOrderId);
        this.#setAttempt(attempt, "RESPONDED", "ACCEPTED", null, fx);
        this.#transition(order, acceptedState(cls.status), "PLACEMENT_ACCEPTED", fx, {
          source: "polymarket",
          payload: { status: cls.status },
        });
        return;
      }
      case "REJECTED":
      case "REFUSED": {
        const code = cls.kind === "REJECTED" ? cls.reason : cls.errorKind;
        if (code === "POST_ONLY_MODE") attempt.postOnlyRefused = true;
        this.#setAttempt(attempt, "RESPONDED", cls.kind, code, fx);
        this.#transition(order, "REJECTED", "PLACEMENT_REJECTED", fx, { reasonCode: code, source: "polymarket", payload: { finalSize: ZERO } });
        order.finalSize = ZERO;
        fx.releases.add(order);
        return;
      }
      case "NOT_SENT": {
        this.#setAttempt(attempt, "ABANDONED", "NOT_SENT", cls.errorKind, fx);
        this.#transition(order, "REJECTED", "NOT_SENT", fx, { reasonCode: cls.errorKind ?? "NOT_SENT", payload: { finalSize: ZERO } });
        order.finalSize = ZERO;
        fx.releases.add(order);
        return;
      }
      case "UNKNOWN": {
        this.#toUnknown(attempt, order, cls.reason, cls.errorKind, fx);
        return;
      }
    }
  }

  #toUnknown(attempt: AttemptModel, order: OrderModel, reason: string, errorKind: string | null, fx: Effects): void {
    this.#setAttempt(attempt, "SUBMISSION_UNKNOWN", "UNKNOWN", errorKind ?? reason, fx);
    this.#transition(order, "SUBMISSION_UNKNOWN", "PLACEMENT_UNKNOWN", fx, { reasonCode: errorKind ?? reason });
    fx.requests.add(attempt);
  }

  /**
   * A placement answer that arrives after the watchdog declared the
   * transmission lost. Only an acceptance changes the attempt: it proves the
   * order exists. An acceptance naming another venue order id is a sticky
   * VENUE-ID CONFLICT (see the header). Every other late answer is recorded
   * and ignored (ADR-007 §3), except that a post-only-mode refusal still
   * forbids an unchanged non-post-only retry, durably
   * (`VENUE_FACTS.POST_ONLY_NO_UNCHANGED_RETRY`). Unless the late answer
   * resolved the attempt, the port has now settled, so any outstanding read
   * is replaced by one made after this point.
   */
  #applyLateOutcome(attempt: AttemptModel, order: OrderModel, cls: PlacementClass, fx: Effects): void {
    attempt.lostDeclared = false;
    if (cls.kind === "ACCEPTED") {
      if (attempt.venueOrderId === cls.venueOrderId) return;
      if (attempt.venueOrderId === null && this.#venueIdFree(cls.venueOrderId, order.orderId)) {
        // ABSENT is refused while a transmission is in flight, so an attempt with a pending port call is never
        // ABANDONED or RESPONDED-by-absence here. Anything else is an invariant failure: fault, never guess.
        if (attempt.state !== "SUBMISSION_UNKNOWN" && attempt.state !== "RECONCILING") {
          throw new OmsInvariantError("a late acceptance for an attempt that is no longer unresolved");
        }
        this.#adoptVenueId(attempt, order, cls.venueOrderId);
        this.#setAttempt(attempt, "RESPONDED", "ACCEPTED_LATE", null, fx);
        if (order.state === "SUBMISSION_UNKNOWN") {
          this.#transition(order, "RECONCILING", "LATE_OUTCOME", fx, { reasonCode: "LATE_ACCEPTANCE", source: "polymarket" });
        }
        this.#transition(order, acceptedState(cls.status), "PLACEMENT_ACCEPTED", fx, { source: "polymarket", payload: { status: cls.status } });
        this.#consumeCurrentRequest(attempt);
        return;
      }
      this.#markVenueIdConflict(order, attempt, cls.venueOrderId, "LATE_OUTCOME_CONFLICT", "a late acceptance contradicts the venue order id already known, or names one another order holds", fx);
    } else {
      const code = cls.kind === "REJECTED" ? cls.reason : cls.kind === "REFUSED" ? cls.errorKind : null;
      if (code === "POST_ONLY_MODE") {
        attempt.postOnlyRefused = true;
        order.latePostOnlyRefusal = true;
      }
      this.#record(order, "LATE_OUTCOME_IGNORED", fx, {
        reasonCode: cls.kind,
        source: "polymarket",
        ...(code === "POST_ONLY_MODE" ? { payload: { postOnlyRefused: true } } : {}),
      });
    }
    if (attempt.state === "SUBMISSION_UNKNOWN" || attempt.state === "RECONCILING") {
      // Supersede: only a read requested after the port settled may conclude absence.
      this.#consumeCurrentRequest(attempt);
      fx.requests.add(attempt);
    }
  }

  /** Record a sticky, durable VENUE-ID CONFLICT (see the header), with a market-halt alert. */
  #markVenueIdConflict(order: OrderModel, attempt: AttemptModel, conflictingVenueOrderId: string, eventType: string, detail: string, fx: Effects): void {
    order.venueIdConflict = true;
    this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, attempt.attemptId, detail, conflictingVenueOrderId);
    this.#record(order, eventType, fx, { reasonCode: "VENUE_ID_CONFLICT", source: "polymarket", payload: { conflictingVenueOrderId } });
  }

  #conflicted(order: OrderModel): boolean {
    return order.conflict || order.venueIdConflict;
  }

  // ----- unattributed evidence (see UNATTRIBUTED EVIDENCE in the header) ------

  /**
   * Whether an attempt could own a venue order id the OMS does not yet know: it has none yet and may have
   * reached the venue (SENDING, SUBMISSION_UNKNOWN, or RECONCILING without a quiescent ABSENT holding it).
   */
  #couldOwn(attempt: AttemptModel | undefined): boolean {
    if (attempt === undefined || attempt.venueOrderId !== null) return false;
    if (attempt.state === "SENDING" || attempt.state === "SUBMISSION_UNKNOWN") return true;
    return attempt.state === "RECONCILING" && !(attempt.absentConfirmed && !attempt.inFlight);
  }

  /** Evidence naming a venue order id no order holds: retained while an unresolved attempt could own it. */
  #unattributed(item: Omit<RetainedEvidence, "candidates">): OmsResult<never> {
    const what = item.fill === null ? "an observation" : "a fill";
    const candidates = new Set<string>();
    for (const attempt of this.#attempts.values()) if (this.#couldOwn(attempt)) candidates.add(attempt.attemptId);
    if (candidates.size === 0) {
      this.#alert("UNKNOWN_VENUE_ORDER", true, null, null, null, `${what} names a venue order this manager does not hold`, item.venueOrderId);
      return refuse("OMS_UNKNOWN_VENUE_ORDER", "no order holds this venue order id, and no unresolved attempt could", { venueOrderId: item.venueOrderId });
    }
    // The same evidence again (a redelivery) is held once.
    const duplicate = this.#retained.some(
      (held) =>
        held.venueOrderId === item.venueOrderId &&
        (item.fill === null
          ? held.observation !== null && held.observation.status === item.observation?.status
          : held.fill !== null && sameReportedFill(held.fill, item.fill)),
    );
    if (!duplicate) {
      if (this.#retained.length >= MAX_RETAINED_EVIDENCE) {
        for (const attemptId of candidates) this.#evidenceLost.add(attemptId);
        this.#alert(
          "UNKNOWN_VENUE_ORDER",
          true,
          null,
          null,
          null,
          `${what} names a venue order no order holds yet, and no more evidence can be retained; the attempts that could own it get a fresh read once identified`,
          item.venueOrderId,
        );
        return refuse("OMS_UNKNOWN_VENUE_ORDER", "no order holds this venue order id yet, and the retained-evidence bound is reached", {
          venueOrderId: item.venueOrderId,
          bound: MAX_RETAINED_EVIDENCE,
        });
      }
      this.#retained.push(Object.freeze({ ...item, candidates }));
    }
    return refuse(
      "OMS_EVIDENCE_RETAINED",
      "no order holds this venue order id yet; an unresolved attempt may own it, so the evidence is kept and applied when that attempt's venue order id is known",
      { venueOrderId: item.venueOrderId, candidateAttempts: candidates.size },
    );
  }

  /**
   * Run after anything that can adopt a venue order id or resolve an attempt (a placement answer, an
   * authoritative read): apply the retained evidence an order now holds, in arrival order; release, with a
   * market-halt alert naming its venue order id, the evidence no candidate can own any more; then give every
   * order that evidence touched, if still open, a fresh authoritative read (RECONCILING, durable).
   * Returns whether everything it wrote is durable.
   */
  async #drainRetained(): Promise<boolean> {
    if (this.#faulted) return false;
    if (this.#retained.length === 0 && this.#evidenceLost.size === 0) return this.#settled();
    const touched = new Set<OrderModel>();
    for (const item of [...this.#retained]) {
      const index = this.#retained.indexOf(item);
      if (index < 0) continue; // a concurrent drain has taken it
      const orderId = this.#ordersByVenueId.get(item.venueOrderId);
      if (orderId === undefined) {
        if ([...item.candidates].some((attemptId) => this.#couldOwn(this.#attempts.get(attemptId)))) continue;
        this.#retained.splice(index, 1);
        this.#alert(
          "UNKNOWN_VENUE_ORDER",
          true,
          null,
          null,
          null,
          `${item.fill === null ? "an observation" : "a fill"} named a venue order that no unresolved attempt turned out to own`,
          item.venueOrderId,
        );
        continue;
      }
      const order = this.#mustOrder(orderId);
      touched.add(order);
      // Taken and decided in one synchronous step: both appliers decide before their first await.
      this.#retained.splice(index, 1);
      const result = item.fill !== null ? await this.#applyFill(order, item.fill) : await this.#observe(order, item.observation?.status ?? null);
      if (this.#faulted) return false;
      if (!result.ok && result.refusal.code === "OMS_ID_SOURCE_FAILED") {
        this.#alert("EVIDENCE_UNAPPLIED", true, order.marketId, order.orderId, order.attemptId, "a retained fill could not be recorded (the id source failed); deliver it again");
      }
    }
    for (const attemptId of [...this.#evidenceLost]) {
      const attempt = this.#attempts.get(attemptId);
      if (attempt !== undefined && attempt.venueOrderId !== null) {
        this.#evidenceLost.delete(attemptId);
        touched.add(this.#mustOrder(attempt.orderId));
      } else if (!this.#couldOwn(attempt)) {
        this.#evidenceLost.delete(attemptId);
      }
    }
    const fx = effects();
    for (const order of touched) {
      // The placement answer and the stream raced: an authoritative read settles what the order is now.
      if (order.state === "ACKNOWLEDGED" || order.state === "LIVE" || order.state === "DELAYED" || order.state === "PARTIALLY_FILLED") {
        this.#transition(order, "RECONCILING", "RECONCILIATION_REQUESTED", fx, { reasonCode: "UNATTRIBUTED_EVIDENCE" });
        fx.requests.add(this.#mustAttempt(order.attemptId));
      }
    }
    return this.#commit(fx);
  }

  // ----- reconciliation -----------------------------------------------------

  /** What read an attempt needs, if any. */
  #needs(attempt: AttemptModel): ReconciliationPurpose | null {
    if (attempt.state === "SUBMISSION_UNKNOWN" || (attempt.state === "RECONCILING" && attempt.venueOrderId === null)) {
      return attempt.absentConfirmed ? null : "SUBMISSION_UNKNOWN";
    }
    if (attempt.state !== "RESPONDED") return null;
    const order = this.#orders.get(attempt.orderId);
    if (order === undefined || order.venueOrderId === null) return null;
    if (order.state === "RECONCILING") return "ORDER_STATE";
    if ((order.state === "CANCELED" || order.state === "EXPIRED") && order.finalSize === null) return "FINAL_SIZE";
    // STATE CONFLICTS: a terminal order with an open state conflict always needs the read that can clear it.
    if (order.conflict && TERMINAL_ORDER_STATES.has(order.state)) return "ORDER_STATE";
    return null;
  }

  /**
   * Issue a fresh request for an attempt that needs one. The new request
   * supersedes the current one. Returns whether a request was delivered.
   */
  #issue(attempt: AttemptModel): boolean {
    const purpose = this.#needs(attempt);
    if (purpose === null) return false;
    this.#consumeCurrentRequest(attempt);
    attempt.requestCount += 1;
    const token = this.#drawToken();
    if (token === undefined) {
      attempt.requestOwed = true;
      this.#alert("RECONCILIATION_UNDELIVERED", false, null, attempt.orderId, attempt.attemptId, "the request-token source failed; the request is owed");
      return false;
    }
    const requestId = compositeKey("oms-attempt", attempt.attemptId, "reconciliation", String(attempt.requestCount), token);
    if (this.#namedUnissued.has(requestId)) {
      // ADR-032 D7: an id an answer named before it was issued is never issued.
      attempt.requestOwed = true;
      return false;
    }
    const request: RequestModel = { requestId, attemptId: attempt.attemptId, purpose, delivered: true, consumed: false };
    this.#requests.set(requestId, request);
    attempt.currentRequestId = requestId;
    attempt.requestOwed = false;
    const order = this.#mustOrder(attempt.orderId);
    if (attempt.state === "SUBMISSION_UNKNOWN") {
      const fx = effects();
      this.#setAttempt(attempt, "RECONCILING", attempt.responseStatus, attempt.errorCode, fx);
      if (order.state === "SUBMISSION_UNKNOWN") this.#transition(order, "RECONCILING", "RECONCILIATION_REQUESTED", fx, {});
      void this.#persist(fx.writes);
    }
    const message: ReconciliationRequest = Object.freeze({
      requestId,
      purpose,
      submissionAttemptId: attempt.attemptId,
      orderId: order.orderId,
      executionGroupId: order.groupId,
      marketId: order.marketId,
      tokenId: order.tokenId,
      side: order.side,
      limitPrice: order.limitPrice,
      originalShares: order.originalShares,
      venueOrderId: order.venueOrderId,
      salt: attempt.salt,
      expectedOrderHash: attempt.expectedOrderHash,
      signedIdentity: attempt.identity,
    });
    try {
      this.#deps.reconciler.request(message);
    } catch {
      request.delivered = false;
      attempt.requestOwed = true;
      this.#alert("RECONCILIATION_UNDELIVERED", false, order.marketId, order.orderId, attempt.attemptId, "the reconciler did not take the request; it is owed");
      return false;
    }
    return true;
  }

  #consumeCurrentRequest(attempt: AttemptModel): void {
    if (attempt.currentRequestId !== null) {
      const current = this.#requests.get(attempt.currentRequestId);
      if (current !== undefined) current.consumed = true;
    }
    attempt.currentRequestId = null;
  }

  async #applyAbsent(attempt: AttemptModel): Promise<OmsResult<AttemptView>> {
    const order = this.#mustOrder(attempt.orderId);
    const unresolved = attempt.venueOrderId === null && (attempt.state === "SUBMISSION_UNKNOWN" || attempt.state === "RECONCILING");
    if (!unresolved) {
      // VENUE_FACTS.READ_BY_ID_ANY_STATUS: a by-id read returns any status, so "absent" for a known order contradicts it.
      this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, attempt.attemptId, "an ABSENT answer for an order the venue already identified");
      return refuse("OMS_EVIDENCE_CONFLICT", "an order with a known venue id cannot be authoritatively absent");
    }
    this.#consumeCurrentRequest(attempt);
    const fx = effects();
    if (retransmissionEligible(attempt, order)) {
      // Held for the caller's decision: retransmit the same signed order, or abandon (§9.11 step 9).
      attempt.absentConfirmed = true;
      this.#setAttempt(attempt, "RECONCILING", "RECONCILED_ABSENT", attempt.errorCode, fx);
      if (order.state === "SUBMISSION_UNKNOWN") this.#transition(order, "RECONCILING", "RECONCILIATION_REQUESTED", fx, {});
      this.#record(order, "RECONCILED_ABSENT", fx, { reasonCode: "AWAITING_RETRANSMIT_DECISION" });
    } else {
      this.#abandonAbsent(attempt, order, fx);
      fx.releases.add(order);
    }
    if (!(await this.#commit(fx))) return storeFailed();
    // The attempt can no longer own unattributed evidence: release what none of its candidates can own.
    if (!(await this.#drainRetained())) return storeFailed();
    return ok(this.#attemptView(attempt));
  }

  #abandonAbsent(attempt: AttemptModel, order: OrderModel, fx: Effects): void {
    attempt.absentConfirmed = false;
    this.#setAttempt(attempt, "ABANDONED", "RECONCILED_ABSENT", attempt.errorCode, fx);
    if (order.state === "SUBMISSION_UNKNOWN") this.#transition(order, "RECONCILING", "RECONCILIATION_REQUESTED", fx, {});
    this.#transition(order, "REJECTED", "RECONCILED_ABSENT", fx, { reasonCode: "RECONCILED_ABSENT", payload: { finalSize: ZERO } });
    order.finalSize = ZERO;
  }

  async #applyPresent(attempt: AttemptModel, venue: PresentOrder): Promise<OmsResult<AttemptView>> {
    const order = this.#mustOrder(attempt.orderId);
    if (venue.originalSize !== order.originalShares) {
      this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, attempt.attemptId, "the venue's original size differs from the order's");
      return refuse("OMS_EVIDENCE_CONFLICT", "the PRESENT order's original size differs from this order's");
    }
    if (compareDecimal(venue.sizeMatched, order.filledShares) < 0 || compareDecimal(venue.sizeMatched, order.originalShares) > 0) {
      this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, attempt.attemptId, "the venue's matched size contradicts the recorded fills");
      return refuse("OMS_EVIDENCE_CONFLICT", "the PRESENT matched size is below the recorded fills or above the order");
    }
    const target = presentState(venue);
    if (target === undefined) return refuse("OMS_RECONCILIATION_UNRECOGNISED", "the PRESENT status and sizes do not describe one order state");
    const fx = effects();
    const unresolved = attempt.venueOrderId === null;
    if (unresolved) {
      if (!this.#venueIdFree(venue.venueOrderId, order.orderId)) {
        this.#markVenueIdConflict(order, attempt, venue.venueOrderId, "RECONCILED_VENUE_ID_CONFLICT", "a PRESENT answer named a venue order id another order holds", fx);
        if (!(await this.#commit(fx))) return storeFailed();
        return refuse("OMS_EVIDENCE_CONFLICT", "the PRESENT venue order id belongs to another order");
      }
      this.#adoptVenueId(attempt, order, venue.venueOrderId);
      this.#setAttempt(attempt, "RESPONDED", "RECONCILED_PRESENT", attempt.errorCode, fx);
      attempt.absentConfirmed = false;
      if (order.state === "SUBMISSION_UNKNOWN") this.#transition(order, "RECONCILING", "RECONCILIATION_REQUESTED", fx, {});
    } else if (venue.venueOrderId !== order.venueOrderId) {
      this.#markVenueIdConflict(order, attempt, venue.venueOrderId, "RECONCILED_VENUE_ID_CONFLICT", "a PRESENT answer named a different venue order id", fx);
      if (!(await this.#commit(fx))) return storeFailed();
      return refuse("OMS_EVIDENCE_CONFLICT", "the PRESENT venue order id differs from this order's");
    }
    this.#consumeCurrentRequest(attempt);
    order.venueSizeMatched = venue.sizeMatched;
    const terminalTarget = TERMINAL_ORDER_STATES.has(target);
    const payload: Record<string, JsonValue> = { status: venue.status, venueSizeMatched: venue.sizeMatched };
    if (terminalTarget) payload["finalSize"] = venue.sizeMatched;
    if (TERMINAL_ORDER_STATES.has(order.state)) {
      if (terminalTarget) {
        // Both terminal: the read fixes the final matched size. It resolves a STATE conflict about this venue
        // order; a VENUE-ID CONFLICT is about another venue order, which this read says nothing about.
        order.finalSize = venue.sizeMatched;
        order.conflict = false;
        this.#record(order, "RECONCILED_PRESENT", fx, { source: "polymarket", payload: { ...payload, conflict: false } });
      } else {
        // The venue still holds an order we believed terminal: reopen and track it.
        this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, attempt.attemptId, "an order believed terminal is open at the venue");
        order.finalSize = null;
        order.conflict = true;
        this.#transition(order, "RECONCILING", "EVIDENCE_CONFLICT", fx, { source: "polymarket", payload: { conflict: true, finalSize: null } });
        this.#transition(order, target, "RECONCILED_PRESENT", fx, { source: "polymarket", payload });
      }
    } else {
      if (order.state !== "RECONCILING") this.#transition(order, "RECONCILING", "RECONCILIATION_REQUESTED", fx, {});
      if (terminalTarget) {
        order.finalSize = venue.sizeMatched;
        // The read finds the tracked venue order terminal: it resolves a STATE conflict (STATE CONFLICTS), as in
        // the both-terminal branch above, e.g. for an order a stale or unrecognised observation reopened.
        if (order.conflict) {
          order.conflict = false;
          payload["conflict"] = false;
        }
      }
      this.#transition(order, target, "RECONCILED_PRESENT", fx, { source: "polymarket", payload });
    }
    if (order.finalSize !== null) fx.releases.add(order);
    if (!(await this.#commit(fx))) return storeFailed();
    // UNATTRIBUTED EVIDENCE: evidence retained for the venue order id this read may have adopted is applied now.
    if (!(await this.#drainRetained())) return storeFailed();
    return ok(this.#attemptView(attempt));
  }

  // ----- cancel -------------------------------------------------------------

  #applyCancel(order: OrderModel, attempt: AttemptModel, cls: CancelClass, fx: Effects): void {
    if (order.state !== "CANCEL_PENDING") {
      // The order moved on while the cancel was in flight (a fill completed it, a read resolved it). Record only.
      this.#record(order, "CANCEL_OUTCOME", fx, { reasonCode: cls.kind, source: "polymarket" });
      return;
    }
    switch (cls.kind) {
      case "CANCELED":
        this.#transition(order, "CANCELED", "CANCEL_OUTCOME", fx, { reasonCode: "CANCELED", source: "polymarket" });
        fx.requests.add(attempt);
        return;
      case "NOT_CANCELED":
        this.#transition(order, "RECONCILING", "CANCEL_OUTCOME", fx, { reasonCode: "NOT_CANCELED", source: "polymarket", payload: { reason: cls.reason } });
        fx.requests.add(attempt);
        return;
      case "NOT_APPLIED": {
        const revert = order.cancelRevert ?? "RECONCILING";
        const target: OrderState =
          revert === "RECONCILING" ? "RECONCILING" : compareDecimal(order.filledShares, ZERO) > 0 ? "PARTIALLY_FILLED" : revert;
        this.#transition(order, target, "CANCEL_NOT_APPLIED", fx, { reasonCode: cls.errorKind ?? "NOT_APPLIED" });
        if (target === "RECONCILING") fx.requests.add(attempt);
        return;
      }
      case "UNKNOWN":
        this.#transition(order, "RECONCILING", "CANCEL_OUTCOME", fx, { reasonCode: cls.errorKind ?? "CANCEL_UNKNOWN" });
        fx.requests.add(attempt);
        return;
    }
  }

  // ----- observations -------------------------------------------------------

  #applyObservation(order: OrderModel, attempt: AttemptModel, status: ObservedStatus, fx: Effects): void {
    const opts = { source: "polymarket" as const, payload: { status } };
    const state = order.state;
    if (TERMINAL_ORDER_STATES.has(state)) {
      // MATCHED, CANCELED and EXPIRED are consistent with a terminal order; LIVE, DELAYED or UNMATCHED say the venue may still hold it.
      const consistent = status === "MATCHED" || status === "CANCELED" || status === "EXPIRED";
      if (consistent) {
        this.#record(order, "OBSERVATION", fx, opts);
        return;
      }
      this.#reopenTerminal(order, attempt, "EVIDENCE_CONFLICT", `a terminal order was observed ${status}`, fx, { status });
      return;
    }
    if (state === "RECONCILING") {
      // Only an authoritative answer resolves RECONCILING.
      this.#record(order, "OBSERVATION", fx, opts);
      return;
    }
    switch (status) {
      case "LIVE":
      case "UNMATCHED": {
        if (state === "ACKNOWLEDGED" || state === "DELAYED") {
          const target: OrderState = compareDecimal(order.filledShares, ZERO) > 0 ? "PARTIALLY_FILLED" : "LIVE";
          this.#transition(order, target, "OBSERVATION", fx, opts);
        } else this.#record(order, "OBSERVATION", fx, opts);
        return;
      }
      case "DELAYED": {
        if (state === "ACKNOWLEDGED") this.#transition(order, "DELAYED", "OBSERVATION", fx, opts);
        else this.#record(order, "OBSERVATION", fx, opts);
        return;
      }
      case "MATCHED":
        this.#record(order, "OBSERVATION", fx, opts);
        return;
      case "CANCELED":
      case "EXPIRED": {
        this.#transition(order, status, "OBSERVATION", fx, opts);
        fx.requests.add(attempt);
        return;
      }
    }
  }

  /**
   * Reopen a terminal order on stream evidence it cannot reconcile with
   * "terminal" (STATE CONFLICTS in the header): a market-halt alert, a durable
   * state conflict, the final size unknown again, and a fresh authoritative read.
   */
  #reopenTerminal(
    order: OrderModel,
    attempt: AttemptModel,
    eventType: string,
    detail: string,
    fx: Effects,
    evidence: { readonly status?: ObservedStatus; readonly reasonCode?: string },
  ): void {
    this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, attempt.attemptId, detail);
    order.conflict = true;
    order.finalSize = null;
    const payload: Record<string, JsonValue> = {
      ...(evidence.status === undefined ? {} : { status: evidence.status }),
      conflict: true,
      finalSize: null,
    };
    this.#transition(order, "RECONCILING", eventType, fx, {
      source: "polymarket",
      payload,
      ...(evidence.reasonCode === undefined ? {} : { reasonCode: evidence.reasonCode }),
    });
    fx.requests.add(attempt);
  }

  // ----- fills and reservations ---------------------------------------------

  #fillInconsistency(order: OrderModel, fill: ValidatedFill): string | undefined {
    if (order.venueOrderId === null) return "the order has no venue identity";
    const limitCompare = compareDecimal(fill.price, order.limitPrice);
    if ((order.side === "BUY" && limitCompare > 0) || (order.side === "SELL" && limitCompare < 0)) {
      return "the fill price is on the wrong side of the order's limit";
    }
    const total = addDecimal(order.filledShares, fill.shares);
    if (compareDecimal(total, order.originalShares) > 0) return "the fills would exceed the order's size";
    if (order.finalSize !== null && compareDecimal(total, order.finalSize) > 0) return "the fills would exceed the confirmed final size";
    if (order.state === "REJECTED" || order.state === "PLANNED" || order.state === "SIGNED" || order.state === "SENDING") {
      return `no fill can exist for an order in ${order.state}`;
    }
    return undefined;
  }

  #debitOf(order: OrderModel, fill: ValidatedFill): DecimalString {
    if (order.side === "SELL") return fill.shares;
    const notional = mulDecimal(fill.shares, fill.price);
    return fill.feeAssetId === this.#deps.collateralAssetId ? addDecimal(notional, fill.feeAmount) : notional;
  }

  async #consume(order: OrderModel, fill: FillRecord, debit: DecimalString, replay = false): Promise<void> {
    if (compareDecimal(debit, ZERO) <= 0) return;
    if (!order.reservationHeld) {
      order.consumeFailed = true;
      this.#alert("RESERVATION_SHORTFALL", true, order.marketId, order.orderId, order.attemptId, "a fill arrived for an order without a held reservation");
      return;
    }
    let answer: unknown;
    try {
      answer = await this.#deps.reservations.consume({
        reservationId: order.reservation.reservationId,
        amount: debit,
        pendingId: pendingIdOf(fill),
      });
    } catch {
      answer = undefined;
    }
    const result = readPortResult(answer);
    if (result.ok || result.code === "INVENTORY_DUPLICATE_PENDING_ID" || result.code === "INVENTORY_PENDING_ALREADY_SETTLED") return;
    // A replay after a crash: a reservation consumed to zero (or released after full accounting) is no longer active.
    if (replay && result.code === "INVENTORY_RESERVATION_NOT_ACTIVE") return;
    order.consumeFailed = true;
    const fx = effects();
    this.#record(order, "RESERVATION_SHORTFALL", fx, { reasonCode: result.code, payload: { consumeFailed: true } });
    this.#alert("RESERVATION_SHORTFALL", true, order.marketId, order.orderId, order.attemptId, "the inventory refused a fill's consumption");
    await this.#commit(fx);
  }

  /**
   * Release the unused remainder exactly once, and only when nothing more can
   * fill: the order is terminal, its final matched size is authoritatively
   * known, the recorded fills sum to exactly that size, every consume
   * succeeded, and no evidence conflict is open.
   */
  async #maybeRelease(order: OrderModel): Promise<void> {
    if (!order.reservationHeld || order.reservationReleased || order.consumeFailed || this.#conflicted(order)) return;
    if (!TERMINAL_ORDER_STATES.has(order.state) || order.finalSize === null) return;
    if (compareDecimal(order.filledShares, order.finalSize) !== 0) return;
    const remainder = subDecimal(order.reservation.amount, order.debited);
    if (compareDecimal(remainder, ZERO) < 0) {
      order.consumeFailed = true;
      this.#alert("RESERVATION_SHORTFALL", true, order.marketId, order.orderId, order.attemptId, "the fills debited more than the reservation");
      return;
    }
    if (compareDecimal(remainder, ZERO) > 0) {
      let answer: unknown;
      try {
        answer = await this.#deps.reservations.release({ reservationId: order.reservation.reservationId });
      } catch {
        answer = undefined;
      }
      const result = readPortResult(answer);
      const benign =
        result.ok ||
        // Already released (a replay after a crash), or consumed to zero: nothing is left to release.
        result.code === "INVENTORY_RESERVATION_NOT_ACTIVE" ||
        // A crash between the durable PLANNED row and `reserve`: the reservation was never made.
        (order.reservationUncertain && result.code === "INVENTORY_RESERVATION_NOT_FOUND");
      if (!benign) {
        this.#alert("RESERVATION_RELEASE_FAILED", false, order.marketId, order.orderId, order.attemptId, "the inventory refused the release; the remainder stays reserved");
        return;
      }
    }
    order.reservationReleased = true;
    const fx = effects();
    this.#record(order, "RESERVATION_RELEASED", fx, { payload: { released: remainder, consumed: order.debited } });
    await this.#commit(fx);
  }

  // ----- the salt gate --------------------------------------------------------

  #saltGate(group: GroupModel): SaltGateView {
    const blockers: { id: string; reason: string }[] = [];
    if (group.claim !== null) blockers.push({ id: group.claim, reason: "SIGNING_IN_PROGRESS" });
    for (const attemptId of group.attemptIds) {
      const attempt = this.#attempts.get(attemptId);
      if (attempt === undefined) throw new OmsInvariantError("a group names a missing attempt");
      const order = this.#orders.get(attempt.orderId);
      if (order === undefined) throw new OmsInvariantError("an attempt names a missing order");
      if (attempt.state === "ABANDONED") {
        if (this.#conflicted(order)) blockers.push({ id: attemptId, reason: "EVIDENCE_CONFLICT" });
        continue;
      }
      if (attempt.state !== "RESPONDED") {
        blockers.push({ id: attemptId, reason: `ATTEMPT_${attempt.state}` });
        continue;
      }
      if (!TERMINAL_ORDER_STATES.has(order.state)) blockers.push({ id: attemptId, reason: `ORDER_${order.state}` });
      else if (order.finalSize === null) blockers.push({ id: attemptId, reason: "FINAL_SIZE_UNCONFIRMED" });
      else if (this.#conflicted(order)) blockers.push({ id: attemptId, reason: "EVIDENCE_CONFLICT" });
      // An authoritative read may close the order while its own placement call is still pending (after a watchdog
      // timeout). That call's answer can still name another venue order (a VENUE-ID CONFLICT): wait for it.
      else if (attempt.inFlight) blockers.push({ id: attemptId, reason: "TRANSMISSION_IN_FLIGHT" });
    }
    let remaining: DecimalString | null = group.record.plannedShares;
    for (const orderId of group.orderIds) {
      const order = this.#orders.get(orderId);
      if (order === undefined) throw new OmsInvariantError("a group names a missing order");
      if (order.finalSize === null) {
        remaining = null;
        break;
      }
      remaining = subDecimal(remaining, order.finalSize);
    }
    if (remaining !== null && compareDecimal(remaining, ZERO) < 0) throw new OmsInvariantError("a group's final sizes exceed its plan");
    return Object.freeze({ open: blockers.length === 0, blockers: Object.freeze(blockers.map((b) => Object.freeze(b))), remaining });
  }

  // ----- models, records and events -----------------------------------------

  #newOrder(item: Prepared): OrderModel {
    const { ticket, group } = item;
    return {
      orderId: ticket.orderId,
      planId: group.record.planId,
      groupId: group.record.executionGroupId,
      marketId: group.record.marketId,
      tokenId: group.record.tokenId,
      accountRef: group.record.accountRef,
      side: group.record.side,
      limitPrice: ticket.limitPrice,
      originalShares: ticket.shares,
      postOnly: group.record.postOnly,
      expirationUnixSeconds: ticket.expirationUnixSeconds,
      reservation: ticket.reservation,
      attributions: ticket.attributions,
      state: "PLANNED",
      attemptId: null,
      venueOrderId: null,
      filledShares: ZERO,
      debited: ZERO,
      reservationHeld: false,
      reservationUncertain: false,
      reservationReleased: false,
      consumeFailed: false,
      venueSizeMatched: null,
      finalSize: null,
      conflict: false,
      venueIdConflict: false,
      latePostOnlyRefusal: false,
      cancelRevert: null,
      nextOrdinal: 0,
    };
  }

  #plannedEvent(order: OrderModel): OrderEventRecord {
    const event: OrderEventRecord = Object.freeze({
      orderId: order.orderId,
      eventOrdinal: order.nextOrdinal,
      eventType: "ORDER_PLANNED",
      previousState: null,
      newState: "PLANNED",
      venueOrderId: null,
      sharesDelta: null,
      filledShares: ZERO,
      remainingShares: order.originalShares,
      reasonCode: null,
      payload: Object.freeze({
        postOnly: order.postOnly,
        expirationUnixSeconds: order.expirationUnixSeconds,
        reservation: Object.freeze({ ...order.reservation }),
        attributions: Object.freeze(
          order.attributions.map((a) =>
            Object.freeze({ intentId: a.intentId, approvedIntentId: a.approvedIntentId, instanceId: a.instanceId, shares: a.shares }),
          ),
        ),
      }),
      source: "internal",
    });
    order.nextOrdinal += 1;
    return event;
  }

  #orderRecord(order: OrderModel): OrderRecord {
    return Object.freeze({
      orderId: order.orderId,
      submissionAttemptId: order.attemptId,
      planId: order.planId,
      executionGroupId: order.groupId,
      marketId: order.marketId,
      tokenId: order.tokenId,
      accountRef: order.accountRef,
      side: order.side,
      limitPrice: order.limitPrice,
      originalShares: order.originalShares,
      filledShares: order.filledShares,
      state: order.state,
      venueOrderId: order.venueOrderId,
      venueOrderHash: null,
    });
  }

  #attemptRecord(attempt: AttemptModel): AttemptRecord {
    return Object.freeze({
      submissionAttemptId: attempt.attemptId,
      executionGroupId: attempt.groupId,
      planId: attempt.planId,
      accountRef: attempt.accountRef,
      attemptOrdinal: attempt.ordinal,
      signedPayload: attempt.signedPayload,
      salt: attempt.salt,
      expectedOrderHash: attempt.expectedOrderHash,
      state: attempt.state,
      responseStatus: attempt.responseStatus,
      venueOrderId: attempt.venueOrderId,
      errorCode: attempt.errorCode,
    });
  }

  #setAttempt(attempt: AttemptModel, to: AttemptState, responseStatus: string | null, errorCode: string | null, fx: Effects): void {
    if (attempt.state !== to && !isLegalAttemptTransition(attempt.state, to)) {
      throw new OmsInvariantError(`illegal attempt transition ${attempt.state} -> ${to}`);
    }
    attempt.state = to;
    attempt.responseStatus = responseStatus !== null && isCode(responseStatus) ? responseStatus : null;
    attempt.errorCode = errorCode !== null && isCode(errorCode) ? errorCode : null;
    fx.writes.push({ kind: "UPDATE_ATTEMPT", attempt: this.#attemptRecord(attempt) });
  }

  #transition(
    order: OrderModel,
    to: OrderState,
    eventType: string,
    fx: Effects,
    opts: { readonly reasonCode?: string; readonly payload?: Record<string, JsonValue>; readonly sharesDelta?: DecimalString; readonly source?: "internal" | "polymarket" },
  ): void {
    if (!isLegalOrderTransition(order.state, to)) {
      throw new OmsInvariantError(`illegal order transition ${order.state} -> ${to}`);
    }
    const previous = order.state;
    order.state = to;
    this.#pushEvent(order, previous, eventType, fx, opts);
    fx.writes.push({ kind: "UPDATE_ORDER", order: this.#orderRecord(order) });
  }

  /** An event that records evidence without changing the order's state. */
  #record(
    order: OrderModel,
    eventType: string,
    fx: Effects,
    opts: { readonly reasonCode?: string; readonly payload?: Record<string, JsonValue>; readonly sharesDelta?: DecimalString; readonly source?: "internal" | "polymarket" },
  ): void {
    this.#pushEvent(order, order.state, eventType, fx, opts);
    fx.writes.push({ kind: "UPDATE_ORDER", order: this.#orderRecord(order) });
  }

  #pushEvent(
    order: OrderModel,
    previous: OrderState,
    eventType: string,
    fx: Effects,
    opts: { readonly reasonCode?: string; readonly payload?: Record<string, JsonValue>; readonly sharesDelta?: DecimalString; readonly source?: "internal" | "polymarket" },
  ): void {
    const reason = opts.reasonCode;
    const event: OrderEventRecord = Object.freeze({
      orderId: order.orderId,
      eventOrdinal: order.nextOrdinal,
      eventType,
      previousState: previous,
      newState: order.state,
      venueOrderId: order.venueOrderId,
      sharesDelta: opts.sharesDelta ?? null,
      filledShares: order.filledShares,
      remainingShares: subDecimal(order.originalShares, order.filledShares),
      reasonCode: reason !== undefined && isCode(reason) ? reason : null,
      payload: opts.payload === undefined ? null : Object.freeze({ ...opts.payload }),
      source: opts.source ?? "internal",
    });
    order.nextOrdinal += 1;
    fx.writes.push({ kind: "APPEND_ORDER_EVENT", event });
  }

  #adoptVenueId(attempt: AttemptModel, order: OrderModel, venueOrderId: string): void {
    attempt.venueOrderId = venueOrderId;
    order.venueOrderId = venueOrderId;
    this.#ordersByVenueId.set(venueOrderId, order.orderId);
  }

  #venueIdFree(venueOrderId: string, orderId: string): boolean {
    const holder = this.#ordersByVenueId.get(venueOrderId);
    return holder === undefined || holder === orderId;
  }

  // ----- effects and persistence --------------------------------------------

  /**
   * Serialize `writes` behind every earlier write; one store transaction.
   * Resolves `false` (and faults the manager) if this or any earlier write failed.
   */
  #persist(writes: readonly StoreWrite[]): Promise<boolean> {
    if (writes.length === 0) return this.#chain;
    const batch = Object.freeze([...writes]);
    const chained = this.#chain.then(async (before) => {
      if (!before || this.#faulted) return false;
      try {
        await this.#deps.store.apply(batch);
        return true;
      } catch {
        this.#faulted = true;
        return false;
      }
    });
    this.#chain = chained;
    return chained;
  }

  async #settled(): Promise<boolean> {
    const persisted = await this.#chain;
    return persisted && !this.#faulted;
  }

  /** Persist the writes, then run the releases and issue the requests, then wait for everything they wrote. */
  async #commit(fx: Effects): Promise<boolean> {
    if (!(await this.#persist(fx.writes))) return false;
    for (const order of fx.releases) await this.#maybeRelease(order);
    for (const attempt of fx.requests) this.#issue(attempt);
    return this.#settled();
  }

  // ----- small helpers --------------------------------------------------------

  #mode(): VenueMode {
    let mode: unknown;
    try {
      mode = this.#deps.venueMode();
    } catch {
      return "TRADING_UNAVAILABLE";
    }
    return mode === "NORMAL" || mode === "POST_ONLY" ? mode : "TRADING_UNAVAILABLE";
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

  #drawToken(): string | undefined {
    let token: unknown;
    try {
      token = this.#deps.requestToken();
    } catch {
      return undefined;
    }
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_REQUEST_TOKEN_LENGTH || this.#usedTokens.has(token)) {
      return undefined;
    }
    this.#usedTokens.add(token);
    return token;
  }

  #alert(
    kind: OmsAlert["kind"],
    haltMarket: boolean,
    marketId: string | null,
    orderId: string | null,
    submissionAttemptId: string | null,
    detail: string,
    /** The venue order id the evidence named; omitted: the order's own venue order id, when known. */
    venueOrderId?: string,
  ): void {
    const named = venueOrderId ?? (orderId === null ? null : (this.#orders.get(orderId)?.venueOrderId ?? null));
    this.#alerts.push(Object.freeze({ kind, haltMarket, marketId, orderId, submissionAttemptId, venueOrderId: named, detail }));
  }

  #mustOrder(orderId: string): OrderModel {
    const order = this.#orders.get(orderId);
    if (order === undefined) throw new OmsInvariantError("missing order");
    return order;
  }

  #mustAttempt(attemptId: string | null): AttemptModel {
    const attempt = attemptId === null ? undefined : this.#attempts.get(attemptId);
    if (attempt === undefined) throw new OmsInvariantError("missing attempt");
    return attempt;
  }

  #mustGroup(groupId: string): GroupModel {
    const group = this.#groups.get(groupId);
    if (group === undefined) throw new OmsInvariantError("missing group");
    return group;
  }

  #report(attempt: AttemptModel, order: OrderModel, placement: PlacementClass | null): SubmissionReport {
    return Object.freeze({
      orderId: order.orderId,
      submissionAttemptId: attempt.attemptId,
      orderState: order.state,
      attemptState: attempt.state,
      placement,
    });
  }

  #orderView(order: OrderModel): OrderView {
    return Object.freeze({
      orderId: order.orderId,
      executionGroupId: order.groupId,
      marketId: order.marketId,
      side: order.side,
      state: order.state,
      submissionAttemptId: order.attemptId,
      venueOrderId: order.venueOrderId,
      limitPrice: order.limitPrice,
      originalShares: order.originalShares,
      filledShares: order.filledShares,
      venueSizeMatched: order.venueSizeMatched,
      finalSize: order.finalSize,
      conflict: this.#conflicted(order),
      venueIdConflict: order.venueIdConflict,
      reservation: Object.freeze({
        reservationId: order.reservation.reservationId,
        assetId: order.reservation.assetId,
        amount: order.reservation.amount,
        consumed: order.debited,
        held: order.reservationHeld,
        released: order.reservationReleased,
      }),
    });
  }

  #attemptView(attempt: AttemptModel): AttemptView {
    return Object.freeze({
      submissionAttemptId: attempt.attemptId,
      executionGroupId: attempt.groupId,
      orderId: attempt.orderId,
      attemptOrdinal: attempt.ordinal,
      salt: attempt.salt,
      expectedOrderHash: attempt.expectedOrderHash,
      state: attempt.state,
      responseStatus: attempt.responseStatus,
      errorCode: attempt.errorCode,
      venueOrderId: attempt.venueOrderId,
      inFlight: attempt.inFlight,
      absentConfirmed: attempt.absentConfirmed,
      signedPayloadAvailable: attempt.handle !== null,
      currentRequestId: attempt.currentRequestId,
    });
  }

  // =========================================================================
  // Recovery (`open`).

  async #recover(raw: unknown): Promise<OmsResult<true>> {
    const snapshot = readSnapshot(raw);
    if (snapshot === undefined) return refuse("OMS_INVALID_INPUT", "the store snapshot is not in the store port's shape");
    for (const group of snapshot.groups) {
      this.#groups.set(group.executionGroupId, { record: group, attemptIds: [], orderIds: [], claim: null, staged: null, nextOrdinal: 1 });
    }
    const eventsByOrder = new Map<string, OrderEventRecord[]>();
    for (const event of snapshot.events) {
      const list = eventsByOrder.get(event.orderId) ?? [];
      list.push(event);
      eventsByOrder.set(event.orderId, list);
    }
    for (const record of snapshot.orders) {
      const group = this.#groups.get(record.executionGroupId);
      if (group === undefined) return refuse("OMS_INVALID_INPUT", "an order names an unknown group", { orderId: record.orderId });
      const events = (eventsByOrder.get(record.orderId) ?? []).sort((a, b) => a.eventOrdinal - b.eventOrdinal);
      const order = foldOrder(record, events);
      if (order === undefined) return refuse("OMS_INVALID_INPUT", "an order's events cannot be folded", { orderId: record.orderId });
      this.#orders.set(order.orderId, order);
      this.#usedIds.add(order.orderId);
      group.orderIds.push(order.orderId);
      if (order.venueOrderId !== null) this.#ordersByVenueId.set(order.venueOrderId, order.orderId);
    }
    const orderByAttempt = new Map<string, OrderModel>();
    for (const order of this.#orders.values()) if (order.attemptId !== null) orderByAttempt.set(order.attemptId, order);
    const attemptsByOrdinal = [...snapshot.attempts].sort((a, b) => a.attemptOrdinal - b.attemptOrdinal);
    for (const record of attemptsByOrdinal) {
      const group = this.#groups.get(record.executionGroupId);
      const order = orderByAttempt.get(record.submissionAttemptId);
      if (group === undefined || order === undefined) {
        return refuse("OMS_INVALID_INPUT", "an attempt has no group or no order", { attemptId: record.submissionAttemptId });
      }
      const attempt: AttemptModel = {
        attemptId: record.submissionAttemptId,
        groupId: record.executionGroupId,
        planId: record.planId,
        orderId: order.orderId,
        accountRef: record.accountRef,
        ordinal: record.attemptOrdinal,
        salt: record.salt,
        signedPayload: record.signedPayload,
        expectedOrderHash: record.expectedOrderHash,
        handle: null,
        identity: null,
        state: record.state,
        responseStatus: record.responseStatus,
        errorCode: record.errorCode,
        venueOrderId: record.venueOrderId,
        inFlight: false,
        lostDeclared: false,
        absentConfirmed: false,
        // In time: the attempt's own response; after the watchdog: the order's `postOnlyRefused` event.
        postOnlyRefused:
          (record.errorCode === "POST_ONLY_MODE" && (record.responseStatus === "REFUSED" || record.responseStatus === "REJECTED")) ||
          order.latePostOnlyRefusal,
        requestCount: 0,
        currentRequestId: null,
        requestOwed: false,
      };
      let plaintext: unknown;
      try {
        plaintext = await this.#deps.cipher.decrypt(record.signedPayload);
      } catch {
        plaintext = undefined;
      }
      const restored = typeof plaintext === "string" ? this.#restore(plaintext) : undefined;
      if (restored !== undefined && restored.identity.salt === record.salt) {
        attempt.handle = restored.handle;
        attempt.identity = restored.identity;
      } else {
        this.#alert("PAYLOAD_UNREADABLE", true, order.marketId, order.orderId, attempt.attemptId, "a persisted signed payload could not be decrypted and restored");
      }
      if (this.#salts.has(attempt.salt)) return refuse("OMS_INVALID_INPUT", "two attempts in the store carry one salt", { attemptId: attempt.attemptId });
      this.#attempts.set(attempt.attemptId, attempt);
      this.#usedIds.add(attempt.attemptId);
      this.#salts.add(attempt.salt);
      group.attemptIds.push(attempt.attemptId);
      group.nextOrdinal = Math.max(group.nextOrdinal, attempt.ordinal + 1);
      if (attempt.venueOrderId !== null) this.#ordersByVenueId.set(attempt.venueOrderId, order.orderId);
    }
    for (const record of snapshot.fills) {
      const order = this.#orders.get(record.orderId);
      if (order === undefined) return refuse("OMS_INVALID_INPUT", "a fill names an unknown order", { fillId: record.fillId });
      const debit = order.side === "SELL"
        ? record.shares
        : record.feeAssetId === this.#deps.collateralAssetId
          ? addDecimal(record.notional, record.feeAmount)
          : record.notional;
      this.#fills.set(fillKey(record.venueTradeId, record.venueOrderId, record.allocationDiscriminator), {
        record,
        debit,
        settlement: null,
        settlementOrdinal: 0,
        stateHashes: new Set(),
      });
      this.#usedIds.add(record.fillId);
    }
    const fillById = new Map<string, FillModel>();
    for (const fill of this.#fills.values()) fillById.set(fill.record.fillId, fill);
    for (const settlement of [...snapshot.settlements].sort((a, b) => a.stateOrdinal - b.stateOrdinal)) {
      const fill = fillById.get(settlement.fillId);
      if (fill === undefined) return refuse("OMS_INVALID_INPUT", "a settlement names an unknown fill");
      // The hashes recorded for the current state (OP-R3-01): a state change starts a new set.
      if (fill.settlement !== settlement.state) fill.stateHashes = new Set();
      if (settlement.transactionHash !== null) fill.stateHashes.add(settlement.transactionHash);
      fill.settlement = settlement.state;
      fill.settlementOrdinal = settlement.stateOrdinal + 1;
    }
    // Normalize what a crash can leave behind, then reconcile.
    let unresolved = false;
    const fx = effects();
    for (const order of this.#orders.values()) {
      if (order.state === "PLANNED") {
        // Never signed: nothing reached the venue. Close it; its reservation (if any) is released below.
        this.#transition(order, "CANCELED", "ABANDONED", fx, { reasonCode: "RECOVERY_UNSIGNED", payload: { finalSize: ZERO } });
        order.finalSize = ZERO;
        if (!order.reservationHeld) {
          // A reservation may or may not exist: release it, and read "not found" as never made.
          order.reservationHeld = true;
          order.reservationUncertain = true;
        }
        fx.releases.add(order);
      }
    }
    for (const attempt of this.#attempts.values()) {
      const order = this.#mustOrder(attempt.orderId);
      if (attempt.state === "SENDING") {
        // The SENDING mark was durable, so the order may have been transmitted: unknown, never resent blindly.
        this.#setAttempt(attempt, "SUBMISSION_UNKNOWN", "RECOVERED_SENDING", attempt.errorCode, fx);
        if (order.state === "SENDING") {
          this.#transition(order, "SUBMISSION_UNKNOWN", "RECOVERED_SENDING", fx, { reasonCode: "RECOVERED_SENDING" });
        }
      }
      if (order.state === "CANCEL_PENDING") {
        // A cancel was requested and its answer died with the process: its effect is unknown. Reconcile.
        this.#transition(order, "RECONCILING", "RECOVERED_CANCEL_PENDING", fx, { reasonCode: "RECOVERED_CANCEL_PENDING" });
      }
      if (attempt.state === "SIGNED") unresolved = true;
      if (this.#needs(attempt) !== null) fx.requests.add(attempt);
      if (TERMINAL_ORDER_STATES.has(order.state)) fx.releases.add(order);
    }
    // Start paused on anything `resume()` would refuse too (PAUSE AND RESUME in the header): an unresolved
    // attempt, or an order still RECONCILING (a recovered cancel among them).
    if (this.#resumeBlocker() !== undefined) unresolved = true;
    // An open evidence conflict survives the restart; so does its market-halt alert.
    for (const order of this.#orders.values()) {
      if (this.#conflicted(order)) {
        this.#alert("EVIDENCE_CONFLICT", true, order.marketId, order.orderId, order.attemptId, "recovered with an open evidence conflict");
      }
    }
    // Replay consumption for every fill of an order whose reservation is not yet released (a duplicate reads as done).
    const persisted = await this.#persist(fx.writes);
    if (!persisted) return storeFailed();
    for (const fill of this.#fills.values()) {
      const order = this.#mustOrder(fill.record.orderId);
      if (!order.reservationReleased) await this.#consume(order, fill.record, fill.debit, true);
    }
    for (const order of fx.releases) await this.#maybeRelease(order);
    for (const attempt of fx.requests) this.#issue(attempt);
    this.#paused = unresolved;
    if (!(await this.#settled())) return storeFailed();
    return ok(true);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers.

function storeFailed<T>(): OmsResult<T> {
  return refuse("OMS_STORE_WRITE_FAILED", "a store write failed; the manager is faulted and must be reopened from the store");
}

function checkDependencies(deps: unknown): string | undefined {
  const fields = readFields(deps, [
    "venue",
    "restoreSignedOrder",
    "store",
    "cipher",
    "reservations",
    "reconciler",
    "newId",
    "requestToken",
    "venueMode",
    "collateralAssetId",
  ]);
  if (fields === undefined) return "the dependencies must be own data";
  for (const key of ["venue", "store", "cipher", "reservations", "reconciler"] as const) {
    if (fields[key] === null || typeof fields[key] !== "object") return `${key} is required`;
  }
  for (const key of ["restoreSignedOrder", "newId", "requestToken", "venueMode"] as const) {
    if (typeof fields[key] !== "function") return `${key} must be a function`;
  }
  if (!isIdentifier(fields.collateralAssetId)) return "collateralAssetId is required";
  return undefined;
}

function retransmissionRefusal(attempt: AttemptModel, order: OrderModel): string | undefined {
  if (attempt.state !== "RECONCILING" || !attempt.absentConfirmed) {
    return "the same signed order is resent only after an authoritative read found it absent (ADR-007 §3)";
  }
  if (!retransmissionEligible(attempt, order)) {
    return "only the documented restart path (HTTP 425), with no post-only refusal and no open venue-id conflict, supports resubmitting the signed request (VENUE_FACTS.RESTART_RESUBMIT, RETRY_ONLY_RESTART)";
  }
  if (attempt.inFlight) return "a transmission of this attempt is in flight";
  if (attempt.handle === null) return "the signed payload could not be restored";
  return undefined;
}

/**
 * VENUE_FACTS.RESTART_RESUBMIT and RETRY_ONLY_RESTART; POST_ONLY_NO_UNCHANGED_RETRY. Never while a VENUE-ID
 * CONFLICT is open on the order: resolving one is an operator's act, so an ABSENT answer then abandons the
 * attempt rather than holding it for step 9.
 */
function retransmissionEligible(attempt: AttemptModel, order: OrderModel): boolean {
  return attempt.errorCode === "ENGINE_RESTARTING" && !attempt.postOnlyRefused && attempt.handle !== null && !order.venueIdConflict;
}

function acceptedState(status: AcceptedStatus): OrderState {
  // VENUE_FACTS.DELAYED_IS_NOT_A_FILL; a `matched` placement waits for fill facts (ACKNOWLEDGED).
  return status === "LIVE" ? "LIVE" : status === "DELAYED" ? "DELAYED" : "ACKNOWLEDGED";
}

interface PresentOrder {
  readonly venueOrderId: string;
  readonly status: ObservedStatus;
  readonly sizeMatched: DecimalString;
  readonly originalSize: DecimalString;
}

function readPresentOrder(raw: unknown): PresentOrder | undefined {
  const fields = readFields(raw, ["venueOrderId", "status", "sizeMatched", "originalSize"]);
  if (fields === undefined) return undefined;
  if (!isVenueId(fields.venueOrderId) || !isObservedStatus(fields.status)) return undefined;
  if (!isNonNegativeAmount(fields.sizeMatched) || !isPositiveAmount(fields.originalSize)) return undefined;
  return Object.freeze({ venueOrderId: fields.venueOrderId, status: fields.status, sizeMatched: fields.sizeMatched, originalSize: fields.originalSize });
}

/** The order state an authoritative read describes, or `undefined` when status and sizes disagree. */
function presentState(venue: PresentOrder): OrderState | undefined {
  const matched = compareDecimal(venue.sizeMatched, ZERO) > 0;
  const full = compareDecimal(venue.sizeMatched, venue.originalSize) === 0;
  switch (venue.status) {
    case "CANCELED":
      return "CANCELED";
    case "EXPIRED":
      return "EXPIRED";
    case "MATCHED":
      return !matched ? undefined : full ? "FILLED" : "PARTIALLY_FILLED";
    case "LIVE":
    case "UNMATCHED":
      return full ? undefined : matched ? "PARTIALLY_FILLED" : "LIVE";
    case "DELAYED":
      return matched ? undefined : "DELAYED";
  }
}

function signRequest(order: OrderModel): { assetId: string; side: Side; price: string; size: string; postOnly?: boolean; expirationUnixSeconds?: number } {
  return Object.freeze({
    assetId: order.tokenId,
    side: order.side,
    price: order.limitPrice,
    size: order.originalShares,
    ...(order.postOnly ? { postOnly: true } : {}),
    ...(order.expirationUnixSeconds === null ? {} : { expirationUnixSeconds: order.expirationUnixSeconds }),
  });
}

/**
 * The ticket door's grid check (ADR-034 D2.4): the OMS never rounds a share
 * quantity. The planner floors it once; an off-grid ticket is refused here,
 * before the PLANNED row and before `reserve`.
 */
function offGridRefusal(ticket: ValidatedTicket): OmsResult<never> | undefined {
  if (isOnShareGrid(ticket.shares, SHARE_SIZE_DECIMALS)) return undefined;
  return refuse("OMS_SIZE_OFF_GRID", "the ticket's shares are off the venue's 0.01 grid; the OMS never rounds, the planner quantizes (ADR-034 D2.4)", {
    orderId: ticket.orderId,
    shares: ticket.shares,
  });
}

/**
 * The amounts a GTC or GTD limit order signs for the order's quantities, in
 * base units, EXACTLY (ADR-034 D2.4's table; on-grid inputs need no rounding,
 * `docs/venue/verified-2026-10-06.md` F-102):
 *
 * | Order | `makerAmount` | `takerAmount` |
 * | --- | --- | --- |
 * | GTC or GTD BUY | shares × price | shares |
 * | GTC or GTD SELL | shares | shares × price |
 *
 * `undefined` when either is not a whole number of base units: no signed
 * order can then match, and the order is refused. FAK and FOK rows arrive
 * with ADR-034 R3; their order type is refused before this is reached.
 */
function expectedLimitAmounts(order: OrderModel): { readonly maker: bigint; readonly taker: bigint } | undefined {
  const shares = wholeUnits(order.originalShares, AMOUNT_BASE_DECIMALS);
  const quote = wholeUnits(mulDecimal(order.originalShares, order.limitPrice), AMOUNT_BASE_DECIMALS);
  if (shares === undefined || quote === undefined) return undefined;
  return order.side === "BUY" ? { maker: quote, taker: shares } : { maker: shares, taker: quote };
}

function identityMismatch(order: OrderModel, identity: SignedOrderIdentity): string | undefined {
  if (identity.tokenId !== order.tokenId) return "the signed order's token differs from the order's";
  if (identity.side !== order.side) return "the signed order's side differs from the order's";
  if (identity.postOnly !== order.postOnly) return "the signed order's post-only flag differs from the group's";
  const expiration = order.expirationUnixSeconds ?? 0;
  if (identity.expiration !== expiration) return "the signed order's expiration differs from the order's";
  const orderType = order.expirationUnixSeconds === null ? "GTC" : "GTD";
  if (identity.orderType !== orderType) return "the signed order's type differs from the order's (GTC without expiration, GTD with)";
  // ADR-034 D2.4: the signed amounts are the order's quantities, exactly (one number: D2.5).
  const expected = expectedLimitAmounts(order);
  if (expected === undefined) return "the order's shares and price have no exact signed amounts in base units";
  if (readBaseUnitInteger(identity.makerAmount) !== expected.maker) {
    return "the signed makerAmount differs from the order's quantities (ADR-034 D2.4: exact, in base units)";
  }
  if (readBaseUnitInteger(identity.takerAmount) !== expected.taker) {
    return "the signed takerAmount differs from the order's quantities (ADR-034 D2.4: exact, in base units)";
  }
  return undefined;
}

function readEncrypted(raw: unknown): EncryptedPayload | undefined {
  const fields = readFields(raw, ["keyId", "ciphertext"]);
  if (fields === undefined || !isIdentifier(fields.keyId)) return undefined;
  const ciphertext = fields.ciphertext;
  if (typeof ciphertext !== "string" || ciphertext.length === 0 || ciphertext.length > 1_000_000) return undefined;
  return Object.freeze({ keyId: fields.keyId, ciphertext });
}

function readPortResult(raw: unknown): { readonly ok: true } | { readonly ok: false; readonly code: string } {
  const okRead = readField(raw, "ok");
  if (okRead.kind === "DATA" && okRead.value === true) return { ok: true };
  if (okRead.kind === "DATA" && okRead.value === false) {
    const refusal = readField(raw, "refusal");
    const code = refusal.kind === "DATA" ? readField(refusal.value, "code") : undefined;
    return { ok: false, code: code !== undefined && code.kind === "DATA" && isCode(code.value) ? code.value : "UNREADABLE_REFUSAL" };
  }
  return { ok: false, code: "UNREADABLE_ANSWER" };
}

function pendingIdOf(fill: FillRecord): string {
  return compositeKey("oms-fill", fill.venueTradeId, fill.venueOrderId, fill.allocationDiscriminator);
}

function allocationsFor(order: OrderModel, fillId: string, before: DecimalString, after: DecimalString): readonly FillAllocationRecord[] {
  const previous = allocatedAt(order.attributions, before);
  const next = allocatedAt(order.attributions, after);
  const byInstance = new Map<string, DecimalString>();
  order.attributions.forEach((attribution, index) => {
    const delta = subDecimal(next[index] as DecimalString, previous[index] as DecimalString);
    if (compareDecimal(delta, ZERO) > 0) {
      byInstance.set(attribution.instanceId, addDecimal(byInstance.get(attribution.instanceId) ?? ZERO, delta));
    }
  });
  return Object.freeze(
    [...byInstance.entries()].map(([instanceId, allocatedShares]) =>
      Object.freeze({ fillId, scope: "VIRTUAL_STRATEGY" as const, instanceId, allocatedShares }),
    ),
  );
}

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/u;

/** An instant, exactly: nanoseconds since 1970-01-01T00:00:00Z, and the precision its text carried. */
interface Instant {
  readonly nanos: bigint;
  /** Fraction digits in the text (0-9). */
  readonly digits: number;
}

/** Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant's `days_from_civil`; exact integer arithmetic). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The instant an ISO-8601 timestamp names, its UTC offset applied; `undefined` when the text is not one or a
 * field is out of range (month 13, February 30, hour 24, second 60, ...). Pure: no clock is read.
 */
function instantOf(text: string): Instant | undefined {
  const match = TIMESTAMP.exec(text);
  if (match === null) return undefined;
  // The first six groups always participate in a match; the defaults only satisfy the type checker.
  const [, year = "", month = "", day = "", hour = "", minute = "", second = "", fraction = "", sign = "+", offsetHours = "00", offsetMinutes = "00"] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  const oh = Number(offsetHours);
  const om = Number(offsetMinutes);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) return undefined;
  const offset = (sign === "-" ? -1 : 1) * (oh * 3600 + om * 60);
  const seconds = daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s - offset;
  return { nanos: BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0")), digits: fraction.length };
}

function isTimestampText(value: unknown): value is string {
  return typeof value === "string" && instantOf(value) !== undefined;
}

/**
 * Whether two timestamps name the same instant as far as both texts can tell: offsets are applied, and the
 * coarser text must be the finer instant truncated or rounded to the coarser precision. So a report in
 * whole seconds, or a store that keeps microseconds, still agrees with a nanosecond text of the same
 * instant, while two texts that differ at a precision both carry never do.
 */
function sameInstant(a: string, b: string): boolean {
  const x = instantOf(a);
  const y = instantOf(b);
  if (x === undefined || y === undefined) return false;
  const [coarse, fine] = x.digits <= y.digits ? [x, y] : [y, x];
  const unit = 10n ** BigInt(9 - coarse.digits);
  const excess = fine.nanos - coarse.nanos;
  // Truncation leaves 0 <= excess < unit; rounding leaves -unit/2 <= excess <= unit/2. Equal precisions: excess 0.
  return 2n * excess >= -unit && excess < unit;
}

/** Whether two reports describe the same fill: the same key and every fact of it (as `#applyFill`'s deduplication). */
function sameReportedFill(a: ValidatedFill, b: ValidatedFill): boolean {
  return (
    a.venueTradeId === b.venueTradeId &&
    a.venueOrderId === b.venueOrderId &&
    a.allocationDiscriminator === b.allocationDiscriminator &&
    a.shares === b.shares &&
    a.price === b.price &&
    a.feeAmount === b.feeAmount &&
    a.feeAssetId === b.feeAssetId &&
    a.liquidityRole === b.liquidityRole &&
    sameInstant(a.matchedAt, b.matchedAt)
  );
}

interface ValidatedFill {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly allocationDiscriminator: string;
  readonly shares: DecimalString;
  readonly price: DecimalString;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly feeAmount: DecimalString;
  readonly feeAssetId: string | null;
  readonly matchedAt: string;
}

function readFill(raw: unknown): ValidatedFill | undefined {
  const fields = readFields(raw, [
    "venueTradeId",
    "venueOrderId",
    "allocationDiscriminator",
    "shares",
    "price",
    "liquidityRole",
    "feeAmount",
    "feeAssetId",
    "matchedAt",
  ]);
  if (fields === undefined) return undefined;
  const discriminator = fields.allocationDiscriminator ?? "0";
  const feeAmount = fields.feeAmount ?? ZERO;
  const feeAssetId = fields.feeAssetId ?? null;
  if (
    !isIdentifier(fields.venueTradeId) ||
    !isVenueId(fields.venueOrderId) ||
    !isIdentifier(discriminator) ||
    !isPositiveAmount(fields.shares) ||
    !isUnitPrice(fields.price) ||
    (fields.liquidityRole !== "MAKER" && fields.liquidityRole !== "TAKER") ||
    !isNonNegativeAmount(feeAmount) ||
    !(feeAssetId === null || isIdentifier(feeAssetId)) ||
    (compareDecimal(feeAmount, ZERO) > 0 && feeAssetId === null) ||
    !isTimestampText(fields.matchedAt)
  ) {
    return undefined;
  }
  return Object.freeze({
    venueTradeId: fields.venueTradeId,
    venueOrderId: fields.venueOrderId,
    allocationDiscriminator: discriminator,
    shares: fields.shares,
    price: fields.price,
    liquidityRole: fields.liquidityRole,
    feeAmount,
    feeAssetId,
    matchedAt: fields.matchedAt,
  });
}

function readGroup(raw: unknown): GroupRecord | undefined {
  const fields = readFields(raw, [
    "executionGroupId",
    "planId",
    "marketId",
    "tokenId",
    "accountRef",
    "side",
    "plannedShares",
    "postOnly",
    "groupOrdinal",
    "groupKind",
    "limitPrice",
    "releaseAfterGroupId",
    "legRiskLimit",
  ]);
  if (fields === undefined) return undefined;
  const releaseAfter = fields.releaseAfterGroupId ?? null;
  const legRiskLimit = fields.legRiskLimit ?? null;
  if (
    !isUuidV7(fields.executionGroupId) ||
    !isUuidV7(fields.planId) ||
    !isUuidV7(fields.marketId) ||
    !isTokenId(fields.tokenId) ||
    !isIdentifier(fields.accountRef) ||
    (fields.side !== "BUY" && fields.side !== "SELL") ||
    !isPositiveAmount(fields.plannedShares) ||
    typeof fields.postOnly !== "boolean" ||
    // The `execution.groups` columns (migration 0005): `groups_ordinal_non_negative`, the
    // `execution_group_kind` enum, `internal.price_string`, a self-reference, a non-negative limit.
    typeof fields.groupOrdinal !== "number" ||
    !Number.isSafeInteger(fields.groupOrdinal) ||
    fields.groupOrdinal < 0 ||
    fields.groupOrdinal > 2_147_483_647 ||
    (fields.groupKind !== "SLICE" && fields.groupKind !== "LEG") ||
    !isUnitPrice(fields.limitPrice) ||
    !(releaseAfter === null || (isUuidV7(releaseAfter) && releaseAfter !== fields.executionGroupId)) ||
    !(legRiskLimit === null || isNonNegativeAmount(legRiskLimit))
  ) {
    return undefined;
  }
  return Object.freeze({
    executionGroupId: fields.executionGroupId,
    planId: fields.planId,
    marketId: fields.marketId,
    tokenId: fields.tokenId,
    accountRef: fields.accountRef,
    side: fields.side,
    plannedShares: fields.plannedShares,
    postOnly: fields.postOnly,
    groupOrdinal: fields.groupOrdinal,
    groupKind: fields.groupKind,
    limitPrice: fields.limitPrice,
    releaseAfterGroupId: releaseAfter,
    legRiskLimit,
  });
}

function sameGroup(a: GroupRecord, b: GroupRecord): boolean {
  return (
    a.executionGroupId === b.executionGroupId &&
    a.planId === b.planId &&
    a.marketId === b.marketId &&
    a.tokenId === b.tokenId &&
    a.accountRef === b.accountRef &&
    a.side === b.side &&
    a.plannedShares === b.plannedShares &&
    a.postOnly === b.postOnly &&
    a.groupOrdinal === b.groupOrdinal &&
    a.groupKind === b.groupKind &&
    a.limitPrice === b.limitPrice &&
    a.releaseAfterGroupId === b.releaseAfterGroupId &&
    a.legRiskLimit === b.legRiskLimit
  );
}

function readTicket(raw: unknown): ValidatedTicket | undefined {
  const fields = readFields(raw, ["orderId", "executionGroupId", "limitPrice", "shares", "expirationUnixSeconds", "reservation", "attributions"]);
  if (fields === undefined) return undefined;
  const expiration = fields.expirationUnixSeconds;
  if (
    !isUuidV7(fields.orderId) ||
    !isUuidV7(fields.executionGroupId) ||
    !isOpenUnitPrice(fields.limitPrice) ||
    !isPositiveAmount(fields.shares) ||
    !(expiration === undefined || (typeof expiration === "number" && Number.isSafeInteger(expiration) && expiration > 0))
  ) {
    return undefined;
  }
  const reservationFields = readFields(fields.reservation, ["reservationId", "assetId", "amount"]);
  if (
    reservationFields === undefined ||
    !isIdentifier(reservationFields.reservationId) ||
    !isIdentifier(reservationFields.assetId) ||
    !isPositiveAmount(reservationFields.amount)
  ) {
    return undefined;
  }
  const list = readArray(fields.attributions, MAX_ATTRIBUTIONS_PER_ORDER);
  if (list === undefined || list.length === 0) return undefined;
  const attributions: AttributionModel[] = [];
  const intents = new Set<string>();
  let total: DecimalString = ZERO;
  for (const entry of list) {
    const a = readFields(entry, ["intentId", "approvedIntentId", "instanceId", "shares"]);
    if (a === undefined) return undefined;
    const approved = a.approvedIntentId ?? null;
    if (!isUuidV7(a.intentId) || !(approved === null || isUuidV7(approved)) || !isUuidV7(a.instanceId) || !isPositiveAmount(a.shares)) {
      return undefined;
    }
    if (intents.has(a.intentId)) return undefined;
    intents.add(a.intentId);
    total = addDecimal(total, a.shares);
    attributions.push(Object.freeze({ intentId: a.intentId, approvedIntentId: approved, instanceId: a.instanceId, shares: a.shares }));
  }
  if (compareDecimal(total, fields.shares) !== 0) return undefined;
  return Object.freeze({
    orderId: fields.orderId,
    groupId: fields.executionGroupId,
    limitPrice: fields.limitPrice,
    shares: fields.shares,
    expirationUnixSeconds: expiration === undefined ? null : expiration,
    reservation: Object.freeze({
      reservationId: reservationFields.reservationId,
      assetId: reservationFields.assetId,
      amount: reservationFields.amount,
    }),
    attributions: Object.freeze(attributions),
  });
}

function stagedTicketInput(ticket: ValidatedTicket): OrderTicket {
  return Object.freeze({
    orderId: ticket.orderId,
    executionGroupId: ticket.groupId,
    limitPrice: ticket.limitPrice,
    shares: ticket.shares,
    ...(ticket.expirationUnixSeconds === null ? {} : { expirationUnixSeconds: ticket.expirationUnixSeconds }),
    reservation: ticket.reservation,
    attributions: ticket.attributions,
  });
}

// ----- the store snapshot (read once, validated) ------------------------------

function readSnapshot(raw: unknown): StoreSnapshot | undefined {
  const fields = readFields(raw, ["groups", "orders", "attempts", "events", "links", "fills", "allocations", "settlements"]);
  if (fields === undefined) return undefined;
  const lists: Record<string, readonly unknown[]> = {};
  for (const key of ["groups", "orders", "attempts", "events", "links", "fills", "allocations", "settlements"] as const) {
    const list = readArray(fields[key], 10_000_000);
    if (list === undefined) return undefined;
    lists[key] = list;
  }
  const groups: GroupRecord[] = [];
  for (const entry of lists["groups"] ?? []) {
    const group = readGroup(entry);
    if (group === undefined) return undefined;
    groups.push(group);
  }
  const orders: OrderRecord[] = [];
  for (const entry of lists["orders"] ?? []) {
    const order = readOrderRecord(entry);
    if (order === undefined) return undefined;
    orders.push(order);
  }
  const attempts: AttemptRecord[] = [];
  for (const entry of lists["attempts"] ?? []) {
    const attempt = readAttemptRecord(entry);
    if (attempt === undefined) return undefined;
    attempts.push(attempt);
  }
  const events: OrderEventRecord[] = [];
  for (const entry of lists["events"] ?? []) {
    const event = readEventRecord(entry);
    if (event === undefined) return undefined;
    events.push(event);
  }
  const fills: FillRecord[] = [];
  for (const entry of lists["fills"] ?? []) {
    const fill = readFillRecord(entry);
    if (fill === undefined) return undefined;
    fills.push(fill);
  }
  const settlements: TradeSettlementRecord[] = [];
  for (const entry of lists["settlements"] ?? []) {
    const settlement = readFields(entry, ["fillId", "stateOrdinal", "previousState", "state", "venueTradeId", "transactionHash", "observedAt"]);
    if (
      settlement === undefined ||
      !isUuidV7(settlement.fillId) ||
      typeof settlement.stateOrdinal !== "number" ||
      !Number.isSafeInteger(settlement.stateOrdinal) ||
      !isSettlementState(settlement.state) ||
      !(settlement.transactionHash === null || isIdentifier(settlement.transactionHash))
    ) {
      return undefined;
    }
    settlements.push(entry as TradeSettlementRecord);
  }
  return Object.freeze({
    groups,
    orders,
    attempts,
    events,
    links: (lists["links"] ?? []) as readonly IntentOrderLinkRecord[],
    fills,
    allocations: (lists["allocations"] ?? []) as readonly FillAllocationRecord[],
    settlements,
  });
}

function readOrderRecord(raw: unknown): OrderRecord | undefined {
  const f = readFields(raw, [
    "orderId",
    "submissionAttemptId",
    "planId",
    "executionGroupId",
    "marketId",
    "tokenId",
    "accountRef",
    "side",
    "limitPrice",
    "originalShares",
    "filledShares",
    "state",
    "venueOrderId",
    "venueOrderHash",
  ]);
  if (f === undefined) return undefined;
  if (
    !isUuidV7(f.orderId) ||
    !(f.submissionAttemptId === null || isUuidV7(f.submissionAttemptId)) ||
    !isUuidV7(f.planId) ||
    !isUuidV7(f.executionGroupId) ||
    !isUuidV7(f.marketId) ||
    !isTokenId(f.tokenId) ||
    !isIdentifier(f.accountRef) ||
    (f.side !== "BUY" && f.side !== "SELL") ||
    !isOpenUnitPrice(f.limitPrice) ||
    !isPositiveAmount(f.originalShares) ||
    !isNonNegativeAmount(f.filledShares) ||
    !isOrderState(f.state) ||
    !(f.venueOrderId === null || isVenueId(f.venueOrderId)) ||
    !(f.venueOrderHash === null || isIdentifier(f.venueOrderHash))
  ) {
    return undefined;
  }
  return Object.freeze({
    orderId: f.orderId,
    submissionAttemptId: f.submissionAttemptId,
    planId: f.planId,
    executionGroupId: f.executionGroupId,
    marketId: f.marketId,
    tokenId: f.tokenId,
    accountRef: f.accountRef,
    side: f.side,
    limitPrice: f.limitPrice,
    originalShares: f.originalShares,
    filledShares: f.filledShares,
    state: f.state,
    venueOrderId: f.venueOrderId,
    venueOrderHash: f.venueOrderHash,
  });
}

function readAttemptRecord(raw: unknown): AttemptRecord | undefined {
  const f = readFields(raw, [
    "submissionAttemptId",
    "executionGroupId",
    "planId",
    "accountRef",
    "attemptOrdinal",
    "signedPayload",
    "salt",
    "expectedOrderHash",
    "state",
    "responseStatus",
    "venueOrderId",
    "errorCode",
  ]);
  if (f === undefined) return undefined;
  const payload = readEncrypted(f.signedPayload);
  if (
    !isUuidV7(f.submissionAttemptId) ||
    !isUuidV7(f.executionGroupId) ||
    !isUuidV7(f.planId) ||
    !isIdentifier(f.accountRef) ||
    typeof f.attemptOrdinal !== "number" ||
    !Number.isSafeInteger(f.attemptOrdinal) ||
    f.attemptOrdinal < 1 ||
    payload === undefined ||
    typeof f.salt !== "string" ||
    !/^(?:0|[1-9][0-9]{0,77})$/u.test(f.salt) ||
    !(f.expectedOrderHash === null || isIdentifier(f.expectedOrderHash)) ||
    !isAttemptState(f.state) ||
    !(f.responseStatus === null || isCode(f.responseStatus)) ||
    !(f.venueOrderId === null || isVenueId(f.venueOrderId)) ||
    !(f.errorCode === null || isCode(f.errorCode))
  ) {
    return undefined;
  }
  return Object.freeze({
    submissionAttemptId: f.submissionAttemptId,
    executionGroupId: f.executionGroupId,
    planId: f.planId,
    accountRef: f.accountRef,
    attemptOrdinal: f.attemptOrdinal,
    signedPayload: payload,
    salt: f.salt,
    expectedOrderHash: f.expectedOrderHash,
    state: f.state,
    responseStatus: f.responseStatus,
    venueOrderId: f.venueOrderId,
    errorCode: f.errorCode,
  });
}

function readEventRecord(raw: unknown): OrderEventRecord | undefined {
  const f = readFields(raw, [
    "orderId",
    "eventOrdinal",
    "eventType",
    "previousState",
    "newState",
    "venueOrderId",
    "sharesDelta",
    "filledShares",
    "remainingShares",
    "reasonCode",
    "payload",
    "source",
  ]);
  if (f === undefined) return undefined;
  if (
    !isUuidV7(f.orderId) ||
    typeof f.eventOrdinal !== "number" ||
    !Number.isSafeInteger(f.eventOrdinal) ||
    f.eventOrdinal < 0 ||
    !isCode(f.eventType) ||
    !(f.previousState === null || isOrderState(f.previousState)) ||
    !isOrderState(f.newState) ||
    !(f.payload === null || (typeof f.payload === "object" && !Array.isArray(f.payload)))
  ) {
    return undefined;
  }
  return raw as OrderEventRecord;
}

function readFillRecord(raw: unknown): FillRecord | undefined {
  const f = readFields(raw, [
    "fillId",
    "orderId",
    "venueTradeId",
    "venueOrderId",
    "allocationDiscriminator",
    "shares",
    "price",
    "notional",
    "feeAmount",
    "feeAssetId",
    "liquidityRole",
    "matchedAt",
  ]);
  if (f === undefined) return undefined;
  if (
    !isUuidV7(f.fillId) ||
    !isUuidV7(f.orderId) ||
    !isIdentifier(f.venueTradeId) ||
    !isVenueId(f.venueOrderId) ||
    !isIdentifier(f.allocationDiscriminator) ||
    !isPositiveAmount(f.shares) ||
    !isUnitPrice(f.price) ||
    !isNonNegativeAmount(f.notional) ||
    !isNonNegativeAmount(f.feeAmount) ||
    !(f.feeAssetId === null || isIdentifier(f.feeAssetId)) ||
    // A redelivered fill is compared with these (`recordFill`), so a recovered record must carry them readably.
    (f.liquidityRole !== "MAKER" && f.liquidityRole !== "TAKER") ||
    !isTimestampText(f.matchedAt)
  ) {
    return undefined;
  }
  return raw as FillRecord;
}

/**
 * Rebuild an order's model from its projection row and its append-only
 * events. The `ORDER_PLANNED` event carries what the row does not (the
 * reservation, the attributions, post-only, expiration); later events carry
 * reservation, final-size, conflict and cancel facts in their payloads.
 */
function foldOrder(record: OrderRecord, events: readonly OrderEventRecord[]): OrderModel | undefined {
  const first = events[0];
  if (first === undefined || first.eventType !== "ORDER_PLANNED" || first.eventOrdinal !== 0) return undefined;
  const planned = first.payload;
  if (planned === null) return undefined;
  const reservation = readFields(planned["reservation"], ["reservationId", "assetId", "amount"]);
  const postOnly = planned["postOnly"];
  const expiration = planned["expirationUnixSeconds"];
  const attributionList = readArray(planned["attributions"], MAX_ATTRIBUTIONS_PER_ORDER);
  if (
    reservation === undefined ||
    !isIdentifier(reservation.reservationId) ||
    !isIdentifier(reservation.assetId) ||
    !isPositiveAmount(reservation.amount) ||
    typeof postOnly !== "boolean" ||
    !(expiration === null || (typeof expiration === "number" && Number.isSafeInteger(expiration) && expiration > 0)) ||
    attributionList === undefined
  ) {
    return undefined;
  }
  const attributions: AttributionModel[] = [];
  for (const entry of attributionList) {
    const a = readFields(entry, ["intentId", "approvedIntentId", "instanceId", "shares"]);
    if (a === undefined || !isUuidV7(a.intentId) || !isUuidV7(a.instanceId) || !isPositiveAmount(a.shares)) return undefined;
    const approved = a.approvedIntentId ?? null;
    if (!(approved === null || isUuidV7(approved))) return undefined;
    attributions.push(Object.freeze({ intentId: a.intentId, approvedIntentId: approved, instanceId: a.instanceId, shares: a.shares }));
  }
  const order: OrderModel = {
    orderId: record.orderId,
    planId: record.planId,
    groupId: record.executionGroupId,
    marketId: record.marketId,
    tokenId: record.tokenId,
    accountRef: record.accountRef,
    side: record.side,
    limitPrice: record.limitPrice,
    originalShares: record.originalShares,
    postOnly,
    expirationUnixSeconds: expiration,
    reservation: Object.freeze({ reservationId: reservation.reservationId, assetId: reservation.assetId, amount: reservation.amount }),
    attributions: Object.freeze(attributions),
    state: record.state,
    attemptId: record.submissionAttemptId,
    venueOrderId: record.venueOrderId,
    filledShares: record.filledShares,
    debited: ZERO,
    reservationHeld: false,
    reservationUncertain: false,
    reservationReleased: false,
    consumeFailed: false,
    venueSizeMatched: null,
    finalSize: null,
    conflict: false,
    venueIdConflict: false,
    latePostOnlyRefusal: false,
    cancelRevert: null,
    nextOrdinal: 0,
  };
  let expected = 0;
  for (const event of events) {
    if (event.eventOrdinal !== expected) return undefined;
    expected += 1;
    const payload = event.payload ?? {};
    if (event.eventType === "RESERVED") order.reservationHeld = true;
    if (event.eventType === "RESERVATION_RELEASED") order.reservationReleased = true;
    const debit = payload["debit"];
    if (event.eventType === "FILL" && typeof debit === "string" && isNonNegativeAmount(debit)) order.debited = addDecimal(order.debited, debit);
    if (payload["consumeFailed"] === true) order.consumeFailed = true;
    const sizeMatched = payload["venueSizeMatched"];
    if (typeof sizeMatched === "string" && isNonNegativeAmount(sizeMatched)) order.venueSizeMatched = sizeMatched;
    if ("finalSize" in payload) {
      const finalSize = payload["finalSize"];
      order.finalSize = typeof finalSize === "string" && isNonNegativeAmount(finalSize) ? finalSize : null;
    }
    if ("conflict" in payload) order.conflict = payload["conflict"] === true;
    // Sticky: no later event clears either fact.
    if (isVenueId(payload["conflictingVenueOrderId"])) order.venueIdConflict = true;
    if (payload["postOnlyRefused"] === true) order.latePostOnlyRefusal = true;
    const revert = payload["cancelRevert"];
    if (isOrderState(revert)) order.cancelRevert = revert;
  }
  order.nextOrdinal = expected;
  const last = events[events.length - 1];
  if (last === undefined || last.newState !== record.state) return undefined;
  return order;
}
