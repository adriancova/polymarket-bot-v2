/**
 * The wallet-operation manager — handoff §9.14 ("Split collateral into complete
 * outcome sets", "Merge balanced outcome sets", "Redeem resolved positions",
 * "Track allowances and trading approvals", "Track relayer transaction
 * lifecycle", "Reconcile all wallet operations"); ADR-006 §8.
 *
 * PAPER ONLY. This module never signs, builds calldata, or sends anything. An
 * operation reaches the outside world only through the injected
 * {@link WalletOperationExecutor} port, which no production code in this
 * package implements; tests use mocks. The executor receives a
 * {@link WalletOperationSubmission}, and no submission has a recipient,
 * destination or bridge field: every operation acts on the account's own
 * holdings (see `venue-facts.ts` for what is and is not documented).
 *
 * Venue facts used (each cited in `venue-facts.ts` or here):
 * - split converts pUSD into a YES and NO pair and merge converts a pair back;
 *   "Every YES and NO pair is backed by exactly `$1` of collateral"
 *   (verified-2026-09-16 §10.2, S-D28 lines 24–42; re-confirmed 2026-09-30
 *   §10.2). So SPLIT of `a` pUSD yields `a` YES and `a` NO; MERGE is its
 *   inverse.
 * - redeem "Exchange[s] resolved outcome tokens for their payout" after
 *   resolution (same source). The payout is credited from the confirmation's
 *   OBSERVED amount. A CANCELLED market is refused: its payout is undocumented
 *   (U-10; GOV-1C's obligation "WP-300 must keep the U-10 CANCELLED refusal").
 *   A non-terminal outcome (DISPUTED, PENDING, PENDING_CLARIFICATION) is
 *   refused (ADR-009 §4, §8).
 * - wrap/unwrap go through the CollateralOnramp/CollateralOfframp, whose
 *   wrap `_asset` "Must be USDC.e" (verified-2026-09-16 D-15; 2026-09-30
 *   §W.8). No rate is documented, so the credit is the OBSERVED amount
 *   (ADR-006 §7 rule 2).
 * - the SDK's `TransactionOutcome` has `transactionHash: TxHash` and
 *   `transactionId: TransactionId | null` (verified-2026-09-16 §10.2; fixture
 *   `positions/split-merge-redeem.json`): a missing relayer id is legal, and
 *   nothing here requires one.
 * - approvals precede the CLOB allowance sync, which precedes trading
 *   (S-D48; `approvals.ts`).
 *
 * UNKNOWN. Any executor result or observation this module does not recognise,
 * any executor exception, and any confirmation lacking required evidence moves
 * the operation to UNKNOWN, and the manager immediately requests
 * reconciliation (trigger `WALLET_OPERATION_UNKNOWN`) and moves it to
 * RECONCILING. While UNKNOWN or RECONCILING the operation's reservations stay
 * held and its effects are not asserted (ADR-006 §8). Only
 * {@link WalletOperationManager.resolveByReconciliation} with authoritative
 * evidence leaves RECONCILING; there is no timeout. The manager is ready to
 * accept that evidence DURING the request call itself, so a requester that
 * answers synchronously is honoured (the operation passes through RECONCILING
 * to the answer); if the request cannot be delivered and nothing answered it,
 * the operation stays UNKNOWN with the request queued for
 * {@link WalletOperationManager.retryReconciliationRequests}.
 *
 * OBSERVATIONS DURING SUBMISSION (WP300-R1-05, WP300-R2-02). While the
 * executor call is still pending:
 * - an UNRECOGNISED observation (UNKNOWN, DROPPED, malformed …) moves the
 *   operation to UNKNOWN at once and requests reconciliation — it never waits
 *   for the executor to answer;
 * - any other observation is buffered (classified on arrival). When the
 *   executor answers SUBMITTED the WHOLE buffer is checked before anything is
 *   applied: an identity conflict, or anything after a terminal observation
 *   other than an exact repeat of it, is conflicting evidence and the
 *   operation goes UNKNOWN with nothing applied. Otherwise the buffer is
 *   applied in arrival order. If the executor answers NOT_SENT, throws, or
 *   answers something unrecognised while observations are buffered, the
 *   operation goes UNKNOWN (never FAILED);
 * - NOTHING CONCLUDES (CONFIRMED or FAILED, which release reservations and end
 *   the in-flight hold) while the executor call is pending (WP300-R3-02): its
 *   answer may still name another transaction. A terminal reconciliation
 *   answer is refused (`WALLET_OP_EVIDENCE_REQUIRED`) and the reconciler is
 *   asked again once the executor answers; a terminal observation on an
 *   operation reconciliation moved to SUBMITTED/MINED is kept (buffered) and
 *   weighed with the executor's answer, exactly like the PLANNED buffer.
 * An executor answer that arrives after the operation already left PLANNED
 * is evidence too: consistent → its identity is learned and any kept
 * observations are applied; contradictory (NOT_SENT, unrecognised, another
 * transaction) → UNKNOWN if the operation is SUBMITTED/MINED, otherwise a
 * fresh reconciliation request carries it. Because nothing concluded while it
 * was pending, that request is always answerable.
 *
 * TRANSACTION IDENTITY (WP300-R1-03, WP300-R3-01). Every transaction hash and
 * relayer id named by any evidence — the executor's answer, an observation
 * (buffered, applied, unrecognised, or refused because the operation is under
 * reconciliation), accepted reconciliation evidence — is WITNESSED on arrival
 * and never forgotten (UNKNOWN does not clear it). The first witnessed value
 * is the operation's identity. Evidence naming a value outside the witnessed
 * set is conflicting: an observation moves the operation to UNKNOWN (and its
 * value joins the set); reconciliation evidence is refused
 * (`WALLET_OP_EVIDENCE_CONFLICT`). Once two or more hashes (or relayer ids)
 * are witnessed, the operation stays RECONCILING until EACH has a terminal
 * authoritative resolution naming it; then it concludes CONFIRMED if any was
 * confirmed (lines await a read), else FAILED. Every reconciliation request
 * carries the witnessed sets. After a terminal state, an observation naming an
 * unwitnessed transaction blocks the operation's lines until an authoritative
 * read and reports a `POSITION_BALANCE_DISCREPANCY`.
 *
 * RECOGNITION BOUNDARY. From submission until the operation resolves
 * (CONFIRMED or FAILED), every line it touches is under an in-flight hold in
 * the book ({@link InventoryBook.holdForOperation}), so an authoritative
 * balance read of those lines is refused and the operation's effect is
 * recognised exactly once: as deltas on confirmation, or — after a
 * reconciled confirmation, which applies no deltas — inside the next balance
 * read.
 */

import { compareDecimal, type DecimalString } from "@polymarket-bot/decimal";
import type { MarketOutcomeState } from "@polymarket-bot/domain";

import type { ApprovalTracker } from "./approvals.js";
import type { AssetRegistry } from "./assets.js";
import {
  compositeKey,
  isIdentifier,
  MAX_IDENTIFIER_LENGTH,
  ownData,
  ownNonEmptyString,
  ownNonNegativeAmount,
  ownPositiveAmount,
} from "./guards.js";
import type { InventoryBook } from "./inventory-book.js";
import { ok, refuse, type InventoryResult } from "./refusals.js";
import { isDocumentedApprovalSpender } from "./venue-facts.js";
import {
  isLegalWalletTransition,
  WALLET_OPERATION_TYPES,
  WALLET_OPERATION_UNKNOWN_TRIGGER,
  type WalletOperationState,
  type WalletOperationType,
} from "./wallet-operations.js";

// ------------------------------------------------------------------ plans --

export type WalletOperationPlan =
  | {
      readonly type: "APPROVE_ERC20";
      readonly operationId: string;
      readonly accountRef: string;
      /** The collateral asset approved (pUSD or USDC.e). */
      readonly assetId: string;
      readonly spender: string;
      readonly allowance: DecimalString;
    }
  | {
      readonly type: "APPROVE_ERC1155";
      readonly operationId: string;
      readonly accountRef: string;
      readonly spender: string;
    }
  | {
      readonly type: "SPLIT" | "MERGE";
      readonly operationId: string;
      readonly accountRef: string;
      readonly conditionId: string;
      readonly amount: DecimalString;
    }
  | {
      readonly type: "REDEEM";
      readonly operationId: string;
      readonly accountRef: string;
      readonly conditionId: string;
      readonly resolution: MarketOutcomeState;
      readonly yesAmount?: DecimalString;
      readonly noAmount?: DecimalString;
    }
  | {
      readonly type: "WRAP_COLLATERAL" | "UNWRAP_COLLATERAL";
      readonly operationId: string;
      readonly accountRef: string;
      readonly amount: DecimalString;
    };

/**
 * Exactly the own keys each plan type may carry. A plan with any other key —
 * `to`, `recipient`, `destination`, `chainId`, `bridge` … — is refused: no
 * operation here can direct funds anywhere but the account's own holdings.
 */
export const WALLET_PLAN_KEYS: Readonly<Record<WalletOperationType, readonly string[]>> = Object.freeze({
  APPROVE_ERC20: Object.freeze(["type", "operationId", "accountRef", "assetId", "spender", "allowance"]),
  APPROVE_ERC1155: Object.freeze(["type", "operationId", "accountRef", "spender"]),
  SPLIT: Object.freeze(["type", "operationId", "accountRef", "conditionId", "amount"]),
  MERGE: Object.freeze(["type", "operationId", "accountRef", "conditionId", "amount"]),
  REDEEM: Object.freeze(["type", "operationId", "accountRef", "conditionId", "resolution", "yesAmount", "noAmount"]),
  WRAP_COLLATERAL: Object.freeze(["type", "operationId", "accountRef", "amount"]),
  UNWRAP_COLLATERAL: Object.freeze(["type", "operationId", "accountRef", "amount"]),
});

/** What the executor port receives. Frozen; carries no recipient of any kind. */
export type WalletOperationSubmission = WalletOperationPlan;

// ------------------------------------------------------------------ ports --

/**
 * The only way an operation leaves this package. A composition root binds it
 * to the secure adapter (`packages/polymarket-secure`, whose run-mode gate
 * refuses PAPER); in this repository only test mocks implement it.
 *
 * Recognised results: `{ status: "NOT_SENT" }` (definitively nothing left the
 * process) and `{ status: "SUBMITTED", transactionHash: string | null,
 * transactionId: string | null }` with at least one non-null. Anything else,
 * or a rejection, is UNKNOWN.
 */
export interface WalletOperationExecutor {
  submit(submission: WalletOperationSubmission): Promise<unknown>;
}

export type ReconciliationTrigger = typeof WALLET_OPERATION_UNKNOWN_TRIGGER | "POSITION_BALANCE_DISCREPANCY";

export interface ReconciliationRequest {
  /** A WP-040 `internal.reconciliation_trigger` value. */
  readonly trigger: ReconciliationTrigger;
  readonly walletOperationId: string;
  readonly accountRef: string;
  readonly reason: string;
  /**
   * Every transaction hash / relayer id any evidence has named for this
   * operation (WP300-R3-01). More than one of either is conflicting evidence:
   * each must be resolved authoritatively before the operation leaves
   * reconciliation.
   */
  readonly transactionHashes: readonly string[];
  readonly transactionIds: readonly string[];
}

/** Hands a reconciliation request to the reconciler (§9.17; WP-290). */
export interface ReconciliationRequester {
  request(request: ReconciliationRequest): void;
}

// ------------------------------------------------------------------ views --

export interface WalletOperationEvent {
  readonly operationId: string;
  readonly ordinal: number;
  readonly previousState: WalletOperationState | null;
  readonly newState: WalletOperationState;
  readonly reason: string;
}

export interface WalletOperationView {
  readonly operationId: string;
  readonly type: WalletOperationType;
  readonly accountRef: string;
  readonly state: WalletOperationState;
  readonly plan: WalletOperationPlan;
  readonly reservationIds: readonly string[];
  readonly transactionHash: string | null;
  readonly transactionId: string | null;
  /** Whether confirmed effects were applied as deltas (false: lines await an observation). */
  readonly effectsApplied: boolean;
  /** Whether the executor call is still pending. */
  readonly submitting: boolean;
  /** Observations received during submission and not yet applied. */
  readonly bufferedObservations: number;
  /** Every transaction hash any evidence has named, in order of arrival (WP300-R3-01). */
  readonly transactionHashes: readonly string[];
  /** Every relayer transaction id any evidence has named, in order of arrival. */
  readonly transactionIds: readonly string[];
  /**
   * With conflicting identities: those still lacking a terminal authoritative
   * resolution (`hash:<h>` / `id:<i>`). The operation cannot resolve while any remain.
   */
  readonly unresolvedTransactions: readonly string[];
}

interface Operation {
  readonly plan: WalletOperationPlan;
  readonly reservations: readonly { readonly reservationId: string; readonly assetId: string; readonly amount: DecimalString }[];
  state: WalletOperationState;
  /** Witnessed identities, first = the operation's identity. Never shrinks (WP300-R3-01). */
  readonly hashes: string[];
  readonly ids: string[];
  /** Terminal authoritative resolutions per witnessed identity (`hash:<h>` / `id:<i>`). */
  readonly resolutions: Map<string, "FAILED" | "CONFIRMED">;
  effectsApplied: boolean;
  submitting: boolean;
  /** A reconciliation request for this operation is being delivered right now. */
  requesting: boolean;
  /** The in-flight hold id while one is in place in the book. */
  holdId: string | null;
  /** A terminal reconciliation answer was refused because the executor call was pending. */
  terminalDeferred: boolean;
  readonly buffered: Classified[];
  ordinal: number;
}

type Classified =
  | { readonly kind: "NOT_SENT" }
  | { readonly kind: "SUBMITTED"; readonly transactionHash: string | null; readonly transactionId: string | null }
  | { readonly kind: "MINED"; readonly transactionHash: string; readonly transactionId: string | null }
  | {
      readonly kind: "CONFIRMED";
      readonly transactionHash: string;
      readonly transactionId: string | null;
      readonly credited: DecimalString | null;
    }
  | { readonly kind: "FAILED"; readonly transactionHash: string | null; readonly transactionId: string | null }
  | { readonly kind: "UNRECOGNISED"; readonly why: string };

const CREDIT_EVIDENCE_TYPES: readonly WalletOperationType[] = ["REDEEM", "WRAP_COLLATERAL", "UNWRAP_COLLATERAL"];

// ---------------------------------------------------------------- manager --

export class WalletOperationManager {
  readonly #book: InventoryBook;
  readonly #registry: AssetRegistry;
  readonly #approvals: ApprovalTracker;
  readonly #executor: WalletOperationExecutor;
  readonly #reconciler: ReconciliationRequester;
  readonly #operations = new Map<string, Operation>();
  readonly #events: WalletOperationEvent[] = [];
  /**
   * Undelivered requests. `advances: true` marks the request that moves an
   * UNKNOWN operation to RECONCILING once delivered; a plain request only
   * carries more evidence for an operation already under reconciliation.
   */
  readonly #outstandingRequests: { readonly request: ReconciliationRequest; readonly advances: boolean }[] = [];

  constructor(deps: {
    readonly book: InventoryBook;
    readonly approvals: ApprovalTracker;
    readonly executor: WalletOperationExecutor;
    readonly reconciler: ReconciliationRequester;
  }) {
    this.#book = deps.book;
    this.#registry = deps.book.registry;
    this.#approvals = deps.approvals;
    this.#executor = deps.executor;
    this.#reconciler = deps.reconciler;
  }

  /**
   * Validate a plan, reserve what it will consume (all or nothing), and record
   * it as PLANNED. Nothing is sent.
   */
  plan(input: unknown): InventoryResult<WalletOperationView> {
    const parsed = this.#parsePlan(input);
    if (!parsed.ok) return parsed;
    const plan = parsed.value;
    if (this.#operations.has(plan.operationId)) {
      return refuse("WALLET_OP_DUPLICATE_ID", "wallet operation ids are single-use", {
        operationId: plan.operationId,
      });
    }
    const needs = this.#reservationNeeds(plan);
    if (!needs.ok) return needs;
    const derived = this.#derivedIdentifiers(plan, needs.value.map((need) => need.assetId));
    const tooLong = derived.find((id: string): boolean => !isIdentifier(id));
    if (tooLong !== undefined) {
      // WP300-R2-03: every identifier this operation will hand the book later
      // (reservation, holder, hold, pending debit and credit ids) must be
      // valid NOW, or its confirmation could never be recorded.
      return refuse(
        "INVENTORY_INVALID_INPUT",
        "operationId is too long: an identifier derived from it would exceed the identifier bound",
        { operationId: plan.operationId, derivedLength: tooLong.length, maxLength: MAX_IDENTIFIER_LENGTH },
      );
    }
    const made: { reservationId: string; assetId: string; amount: DecimalString }[] = [];
    for (const need of needs.value) {
      const reservationId = reservationIdOf(plan.operationId, need.assetId);
      const reserved = this.#book.reserve({
        reservationId,
        holderRef: holderRefOf(plan.operationId),
        accountRef: plan.accountRef,
        assetId: need.assetId,
        amount: need.amount,
      });
      if (!reserved.ok) {
        for (const done of made) this.#book.release({ reservationId: done.reservationId });
        return reserved;
      }
      made.push({ reservationId, assetId: need.assetId, amount: need.amount });
    }
    const operation: Operation = {
      plan,
      reservations: Object.freeze(made.map((m) => Object.freeze(m))),
      state: "PLANNED",
      hashes: [],
      ids: [],
      resolutions: new Map(),
      effectsApplied: false,
      submitting: false,
      requesting: false,
      holdId: null,
      terminalDeferred: false,
      buffered: [],
      ordinal: 0,
    };
    this.#operations.set(plan.operationId, operation);
    this.#record(operation, null, "PLANNED", "planned; reservations held");
    return ok(view(operation));
  }

  /** Hand a PLANNED operation to the executor port. */
  async submit(operationId: string): Promise<InventoryResult<WalletOperationView>> {
    const operation = this.#operations.get(operationId);
    if (operation === undefined) return refuse("WALLET_OP_NOT_FOUND", "no such wallet operation", { operationId });
    if (operation.state !== "PLANNED" || operation.submitting) {
      return refuse("WALLET_OP_ILLEGAL_TRANSITION", "only a PLANNED operation that is not already submitting may be submitted", {
        operationId,
        state: operation.state,
      });
    }
    // From here the operation may leave the process: its lines are in flight.
    // A hold the book refuses is refused here, before anything is sent.
    const held = this.#beginHold(operation);
    if (!held.ok) return held;
    // Claimed synchronously: a concurrent second submit is refused above.
    operation.submitting = true;
    let result: Classified | "THREW";
    let hints: Identity = { transactionHash: null, transactionId: null };
    try {
      const raw = await this.#executor.submit(operation.plan);
      result = classifySubmit(raw);
      hints = identityHints(raw);
    } catch {
      result = "THREW";
    }
    operation.submitting = false;
    if (operation.state !== "PLANNED") {
      // Evidence moved the operation while the executor call was pending.
      this.#lateExecutorAnswer(operation, result, hints);
      return ok(view(operation));
    }
    // Any identity the answer names is witnessed, whatever else it says (WP300-R3-01).
    witness(operation, hints.transactionHash, hints.transactionId);
    if (result === "THREW") {
      this.#toUnknown(operation, `the executor threw; the submission's fate is unknown${this.#bufferedNote(operation)}`);
    } else if (result.kind === "NOT_SENT") {
      if (operation.buffered.length > 0) {
        // Something was observed about this operation while the executor said
        // nothing left the process: conflicting evidence, never assumed.
        this.#toUnknown(operation, `executor: NOT_SENT contradicted${this.#bufferedNote(operation)}`);
      } else {
        this.#transition(operation, "FAILED", "executor: NOT_SENT (nothing left the process)");
        this.#releaseAll(operation);
        this.#endHold(operation);
      }
    } else if (result.kind === "SUBMITTED") {
      this.#transition(operation, "SUBMITTED", "executor: SUBMITTED");
      this.#drainBuffer(operation, result);
    } else {
      this.#toUnknown(
        operation,
        `unrecognised executor result: ${result.kind === "UNRECOGNISED" ? result.why : result.kind}${this.#bufferedNote(operation)}`,
      );
    }
    return ok(view(operation));
  }

  /**
   * Apply a lifecycle observation (the SDK transaction's `wait()` outcome, a
   * relayer or chain read) to a SUBMITTED or MINED operation. Unrecognised or
   * under-evidenced observations move it to UNKNOWN.
   */
  observe(operationId: string, observation: unknown): InventoryResult<WalletOperationView> {
    const operation = this.#operations.get(operationId);
    if (operation === undefined) return refuse("WALLET_OP_NOT_FOUND", "no such wallet operation", { operationId });
    const hints = identityHints(observation);
    if (operation.state === "PLANNED" && operation.submitting) {
      // Witnessed on arrival: the identity survives whatever happens to the
      // buffer (WP300-R3-01).
      witness(operation, hints.transactionHash, hints.transactionId);
      const classified = classifyObservation(observation);
      if (classified.kind === "UNRECOGNISED") {
        // Uncertainty is acted on now, not when (or if) the executor answers.
        this.#toUnknown(
          operation,
          `unrecognised observation during submission: ${classified.why}${this.#bufferedNote(operation)}`,
        );
        return ok(view(operation));
      }
      // The executor has not answered yet; the observation is kept, classified
      // now, and applied once it does (see the header).
      operation.buffered.push(classified);
      return ok(view(operation));
    }
    if (operation.state !== "SUBMITTED" && operation.state !== "MINED") {
      this.#identityOutsideObservation(operation, hints);
      return refuse(
        "WALLET_OP_ILLEGAL_TRANSITION",
        "observations apply only to SUBMITTED or MINED operations; UNKNOWN/RECONCILING resolve only by reconciliation",
        { operationId, state: operation.state },
      );
    }
    const classified = classifyObservation(observation);
    if ((classified.kind === "FAILED" || classified.kind === "CONFIRMED") && operation.submitting) {
      // WP300-R3-02: nothing concludes while the executor call is pending (its
      // answer may name another transaction). A consistent terminal outcome is
      // kept and weighed with the executor's answer; a conflicting one is
      // conflicting evidence now.
      const conflict = identityConflict(operation, classified.transactionHash, classified.transactionId);
      witness(operation, classified.transactionHash, classified.transactionId);
      if (conflict !== null) {
        this.#toUnknown(operation, `observation: ${classified.kind} under a different ${conflict}; conflicting evidence is never assumed`);
        return ok(view(operation));
      }
      operation.buffered.push(classified);
      return ok(view(operation));
    }
    if (classified.kind === "UNRECOGNISED") witness(operation, hints.transactionHash, hints.transactionId);
    this.#applyOutcome(operation, classified, "observation");
    return ok(view(operation));
  }

  /**
   * Resolve a RECONCILING operation from an authoritative read (§9.17 step 4).
   * Evidence must carry `source: "AUTHORITATIVE_READ"` and a recognised state;
   * anything else — including "not found" — leaves the operation RECONCILING.
   * A CONFIRMED resolution releases the reservations and blocks the affected
   * lines until an authoritative balance observation (the reconciler's read
   * already reflects the operation, so its deltas are not re-applied).
   */
  resolveByReconciliation(operationId: string, evidence: unknown): InventoryResult<WalletOperationView> {
    const operation = this.#operations.get(operationId);
    if (operation === undefined) return refuse("WALLET_OP_NOT_FOUND", "no such wallet operation", { operationId });
    // An UNKNOWN operation whose reconciliation request is being delivered
    // right now is ready for the answer (a synchronous requester).
    const answeringRequest = operation.state === "UNKNOWN" && operation.requesting;
    if (operation.state !== "RECONCILING" && !answeringRequest) {
      return refuse("WALLET_OP_ILLEGAL_TRANSITION", "only a RECONCILING operation is resolved by reconciliation", {
        operationId,
        state: operation.state,
      });
    }
    if (ownData(evidence, "source") !== "AUTHORITATIVE_READ") {
      return refuse("WALLET_OP_EVIDENCE_REQUIRED", "reconciliation evidence must be an authoritative read", {
        operationId,
      });
    }
    const state = ownData(evidence, "state");
    const classified = classifyObservation({ ...plainCopy(evidence), status: state });
    if (classified.kind === "NOT_SENT" || classified.kind === "UNRECOGNISED") {
      return refuse("WALLET_OP_EVIDENCE_REQUIRED", "evidence is inconclusive; the operation stays RECONCILING", {
        operationId,
        state: typeof state === "string" ? state : null,
      });
    }
    const conflict = identityConflict(operation, classified.transactionHash, classified.transactionId);
    if (conflict !== null) {
      return refuse(
        "WALLET_OP_EVIDENCE_CONFLICT",
        "reconciliation evidence names a transaction no evidence has named for this operation; the operation stays under reconciliation and its holds stay",
        { operationId, field: conflict },
      );
    }
    const terminal = classified.kind === "FAILED" || classified.kind === "CONFIRMED";
    if (terminal && operation.submitting) {
      // WP300-R3-02: the executor's answer may still name another transaction;
      // no conclusion (release, recognition) before it has answered.
      witness(operation, classified.transactionHash, classified.transactionId);
      operation.terminalDeferred = true;
      return refuse(
        "WALLET_OP_EVIDENCE_REQUIRED",
        `a ${classified.kind} resolution is not accepted while the executor call is pending; the reconciler is asked again once it answers`,
        { operationId },
      );
    }
    if (isConflicted(operation)) {
      // WP300-R3-01: more than one transaction has been named. Each must be
      // resolved terminally, by name, before anything is released.
      if (!terminal) {
        return refuse(
          "WALLET_OP_EVIDENCE_REQUIRED",
          "the operation has conflicting transactions; each must be resolved terminally (CONFIRMED or FAILED) by name",
          { operationId, unresolved: unresolvedOf(operation).join(",") },
        );
      }
      const keys = resolutionKeys(operation, classified.transactionHash, classified.transactionId);
      if (keys === null) {
        return refuse(
          "WALLET_OP_EVIDENCE_REQUIRED",
          "the operation has conflicting transactions; the evidence must name which one it resolves",
          { operationId, unresolved: unresolvedOf(operation).join(",") },
        );
      }
      for (const k of keys) {
        const previous = operation.resolutions.get(k);
        if (previous !== undefined && previous !== classified.kind) {
          return refuse("WALLET_OP_EVIDENCE_CONFLICT", "this transaction was already resolved differently", {
            operationId,
            transaction: k,
            previous,
          });
        }
      }
      if (answeringRequest) this.#transition(operation, "RECONCILING", "reconciliation requested (answered synchronously)");
      for (const k of keys) operation.resolutions.set(k, classified.kind);
      if (unresolvedOf(operation).length > 0) return ok(view(operation));
      const anyConfirmed = [...operation.resolutions.values()].includes("CONFIRMED");
      this.#concludeByReconciliation(operation, anyConfirmed ? "CONFIRMED" : "FAILED");
      return ok(view(operation));
    }
    if (answeringRequest) this.#transition(operation, "RECONCILING", "reconciliation requested (answered synchronously)");
    witness(operation, classified.transactionHash, classified.transactionId);
    switch (classified.kind) {
      case "SUBMITTED":
      case "MINED":
        this.#transition(operation, classified.kind, "reconciliation: still in flight");
        break;
      case "FAILED":
      case "CONFIRMED":
        this.#concludeByReconciliation(operation, classified.kind);
        break;
    }
    return ok(view(operation));
  }

  /** Retry reconciliation requests the requester refused earlier. */
  retryReconciliationRequests(): number {
    const pending = this.#outstandingRequests.splice(0);
    let delivered = 0;
    for (const { request, advances } of pending) {
      const operation = this.#operations.get(request.walletOperationId);
      if (advances && operation !== undefined) {
        if (operation.state !== "UNKNOWN") continue; // already answered
        if (this.#requestReconciliation(operation, request, "reconciliation requested (retry)")) delivered += 1;
        continue;
      }
      if (this.#deliver(request)) delivered += 1;
      else this.#outstandingRequests.push({ request, advances: false });
    }
    return delivered;
  }

  operation(operationId: string): WalletOperationView | undefined {
    const operation = this.#operations.get(operationId);
    return operation === undefined ? undefined : view(operation);
  }

  events(operationId?: string): readonly WalletOperationEvent[] {
    return Object.freeze(
      operationId === undefined ? [...this.#events] : this.#events.filter((e) => e.operationId === operationId),
    );
  }

  outstandingReconciliationRequests(): readonly ReconciliationRequest[] {
    return Object.freeze(this.#outstandingRequests.map((entry) => entry.request));
  }

  // -------------------------------------------------------------- internal --

  #applyOutcome(operation: Operation, outcome: Classified, via: string): void {
    if (outcome.kind === "SUBMITTED" || outcome.kind === "MINED" || outcome.kind === "CONFIRMED" || outcome.kind === "FAILED") {
      const conflict = identityConflict(operation, outcome.transactionHash, outcome.transactionId);
      // Witnessed even when it conflicts: the conflict stays explicit (WP300-R3-01).
      witness(operation, outcome.transactionHash, outcome.transactionId);
      if (conflict !== null) {
        this.#toUnknown(operation, `${via}: ${outcome.kind} under a different ${conflict}; conflicting evidence is never assumed`);
        return;
      }
    }
    switch (outcome.kind) {
      case "MINED":
        // A repeated MINED report (same identity, checked above) changes nothing.
        if (operation.state !== "MINED") this.#transition(operation, "MINED", `${via}: MINED`);
        return;
      case "SUBMITTED":
        // A repeated SUBMITTED report changes nothing; after MINED it is a regression.
        if (operation.state !== "SUBMITTED") {
          this.#toUnknown(operation, `${via}: SUBMITTED after MINED`);
          return;
        }
        return;
      case "FAILED":
        this.#transition(operation, "FAILED", `${via}: FAILED`);
        this.#releaseAll(operation);
        this.#endHold(operation);
        return;
      case "CONFIRMED": {
        const needsCredit = CREDIT_EVIDENCE_TYPES.includes(operation.plan.type);
        if (needsCredit && outcome.credited === null) {
          this.#toUnknown(operation, `${via}: CONFIRMED without the observed credited amount; not assumed`);
          return;
        }
        this.#transition(operation, "CONFIRMED", `${via}: CONFIRMED`);
        this.#recordApprovalIfAny(operation);
        if (!this.#applyConfirmedDeltas(operation, outcome.credited)) {
          // Defensive: while the operation is in flight its lines refuse
          // balance reads, so its debits should always fit.
          this.#releaseAll(operation);
          this.#awaitObservation(operation);
          this.#endHold(operation);
          this.#deliverOrQueue(
            requestFor(
              operation,
              "POSITION_BALANCE_DISCREPANCY",
              "confirmed wallet operation's deltas do not fit the book; lines await an authoritative read",
            ),
          );
          return;
        }
        this.#endHold(operation);
        return;
      }
      default:
        this.#toUnknown(
          operation,
          `unrecognised ${via}: ${outcome.kind === "UNRECOGNISED" ? outcome.why : outcome.kind}`,
        );
    }
  }

  /** Apply a confirmed operation's balance deltas. False (and nothing applied) if they do not fit. */
  #applyConfirmedDeltas(operation: Operation, credited: DecimalString | null): boolean {
    const plan = operation.plan;
    const credits: { assetId: string; amount: DecimalString }[] = [];
    switch (plan.type) {
      case "SPLIT": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair === undefined) return false;
        credits.push({ assetId: pair.yesAssetId, amount: plan.amount }, { assetId: pair.noAssetId, amount: plan.amount });
        break;
      }
      case "MERGE":
        credits.push({ assetId: this.#registry.pusdAssetId, amount: plan.amount });
        break;
      case "REDEEM":
      case "WRAP_COLLATERAL":
        if (credited !== null && compareDecimal(credited, "0") > 0) {
          credits.push({ assetId: this.#registry.pusdAssetId, amount: credited });
        }
        break;
      case "UNWRAP_COLLATERAL": {
        const usdcE = this.#registry.usdcEAssetId;
        if (usdcE === null) return false;
        if (credited !== null && compareDecimal(credited, "0") > 0) credits.push({ assetId: usdcE, amount: credited });
        break;
      }
      default:
        break;
    }
    // Pre-check every step the book will be asked to take: all or nothing.
    // A step the book would refuse (a debit that does not fit, a reservation
    // no longer ACTIVE for its full amount, a pending id already taken) sends
    // the confirmation down the recovery path instead of throwing (WP300-R2-03).
    for (const r of operation.reservations) {
      const line = this.#book.line(plan.accountRef, r.assetId);
      if (line === undefined || compareDecimal(line.actual, r.amount) < 0) return false;
      const reservation = this.#book.reservation(r.reservationId);
      if (reservation?.status !== "ACTIVE" || compareDecimal(reservation.remaining, r.amount) !== 0) return false;
      if (!this.#book.isPendingIdAvailable(debitPendingIdOf(r.reservationId))) return false;
    }
    for (const credit of credits) {
      if (!this.#book.isPendingIdAvailable(creditPendingIdOf(plan.operationId, credit.assetId))) return false;
    }
    for (const r of operation.reservations) {
      const pendingId = debitPendingIdOf(r.reservationId);
      const consumed = this.#book.consume({ reservationId: r.reservationId, amount: r.amount, pendingId });
      if (!consumed.ok) throw new Error(`wallet-operation invariant: consume refused (${consumed.refusal.code})`);
      const settled = this.#book.settlePending({ pendingId, settlement: "APPLIED" });
      if (!settled.ok) throw new Error(`wallet-operation invariant: settle refused (${settled.refusal.code})`);
    }
    for (const credit of credits) {
      const pendingId = creditPendingIdOf(plan.operationId, credit.assetId);
      const expected = this.#book.expectInflow({
        pendingId,
        accountRef: plan.accountRef,
        assetId: credit.assetId,
        amount: credit.amount,
      });
      if (!expected.ok) throw new Error(`wallet-operation invariant: inflow refused (${expected.refusal.code})`);
      const settled = this.#book.settlePending({ pendingId, settlement: "APPLIED" });
      if (!settled.ok) throw new Error(`wallet-operation invariant: settle refused (${settled.refusal.code})`);
    }
    operation.effectsApplied = true;
    return true;
  }

  #recordApprovalIfAny(operation: Operation): void {
    const plan = operation.plan;
    if (plan.type === "APPROVE_ERC20") {
      this.#approvals.recordConfirmedApproval({
        accountRef: plan.accountRef,
        standard: "ERC20",
        assetId: plan.assetId,
        spender: plan.spender,
        walletOperationId: plan.operationId,
      });
      operation.effectsApplied = true;
    } else if (plan.type === "APPROVE_ERC1155") {
      this.#approvals.recordConfirmedApproval({
        accountRef: plan.accountRef,
        standard: "ERC1155",
        assetId: null,
        spender: plan.spender,
        walletOperationId: plan.operationId,
      });
      operation.effectsApplied = true;
    }
  }

  #awaitObservation(operation: Operation): void {
    for (const assetId of this.#touchedAssets(operation)) {
      this.#book.requireObservation(operation.plan.accountRef, assetId);
    }
  }

  #touchedAssets(operation: Operation): readonly string[] {
    return this.#touchedAssetsOf(
      operation.plan,
      operation.reservations.map((r) => r.assetId),
    );
  }

  #touchedAssetsOf(plan: WalletOperationPlan, reservedAssetIds: readonly string[]): readonly string[] {
    const assets = new Set(reservedAssetIds);
    switch (plan.type) {
      case "SPLIT": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair !== undefined) {
          assets.add(pair.yesAssetId);
          assets.add(pair.noAssetId);
        }
        break;
      }
      case "MERGE":
      case "REDEEM":
      case "WRAP_COLLATERAL":
        assets.add(this.#registry.pusdAssetId);
        break;
      case "UNWRAP_COLLATERAL":
        if (this.#registry.usdcEAssetId !== null) assets.add(this.#registry.usdcEAssetId);
        break;
      default:
        break;
    }
    return [...assets];
  }

  #releaseAll(operation: Operation): void {
    for (const r of operation.reservations) {
      if (this.#book.reservation(r.reservationId)?.status === "ACTIVE") {
        this.#book.release({ reservationId: r.reservationId });
      }
    }
  }

  #toUnknown(operation: Operation, reason: string): void {
    this.#transition(operation, "UNKNOWN", reason);
    this.#requestReconciliation(
      operation,
      requestFor(operation, WALLET_OPERATION_UNKNOWN_TRIGGER, reason),
      "reconciliation requested",
    );
  }

  /** Reconciliation reached a terminal conclusion (the executor call is not pending). */
  #concludeByReconciliation(operation: Operation, kind: "FAILED" | "CONFIRMED"): void {
    if (kind === "FAILED") {
      this.#transition(operation, "FAILED", "reconciliation: FAILED");
      this.#releaseAll(operation);
      this.#endHold(operation);
      return;
    }
    this.#transition(operation, "CONFIRMED", "reconciliation: CONFIRMED");
    this.#recordApprovalIfAny(operation);
    this.#releaseAll(operation);
    this.#awaitObservation(operation);
    this.#endHold(operation);
  }

  /**
   * Apply the observations buffered while the executor call was pending, now
   * that it has answered consistently. The whole buffer is checked first:
   * conflicting identities, or anything after a terminal observation other
   * than an exact repeat, send the operation to UNKNOWN with nothing applied.
   */
  #drainBuffer(operation: Operation, seed: Identity): void {
    const conflict = isConflicted(operation)
      ? "more than one transaction has been named"
      : bufferConflict(seed, operation.buffered);
    if (conflict !== null) {
      // Nothing buffered is applied: conflicting evidence goes to reconciliation whole.
      this.#toUnknown(operation, `observations received during submission conflict (${conflict})${this.#bufferedNote(operation)}`);
      return;
    }
    const buffered = operation.buffered.splice(0);
    for (const outcome of buffered) {
      // Re-read the state: each applied outcome may have moved it. After a
      // terminal outcome the rest are exact repeats (checked above); after
      // UNKNOWN they are reconciliation's to weigh.
      const current: WalletOperationState = stateOf(operation);
      if (current !== "SUBMITTED" && current !== "MINED") break;
      this.#applyOutcome(operation, outcome, "observation (received during submission)");
    }
  }

  /**
   * An observation arrived for an operation that does not accept observations
   * (UNKNOWN, RECONCILING, CONFIRMED, FAILED). It is refused, but a
   * transaction identity it names that no evidence has named before is not
   * dropped (WP300-R3-01/R3-02): under reconciliation it becomes one more
   * transaction to resolve; after a terminal state the operation's lines are
   * blocked until an authoritative read and a discrepancy is reported.
   */
  #identityOutsideObservation(operation: Operation, hints: Identity): void {
    const state = operation.state;
    if (state === "PLANNED") return;
    if (!isNewIdentity(operation, hints)) return;
    witness(operation, hints.transactionHash, hints.transactionId);
    if (state === "UNKNOWN" || state === "RECONCILING") {
      this.#deliverOrQueue(
        requestFor(operation, WALLET_OPERATION_UNKNOWN_TRIGGER, "an observation named a transaction not known before; it must be resolved too"),
      );
      return;
    }
    this.#blockAfterTerminal(operation, `an observation named a transaction not known before, after the operation was ${state}`);
  }

  /** Contradictory evidence about a terminal operation: its lines wait for an authoritative read. */
  #blockAfterTerminal(operation: Operation, reason: string): void {
    this.#awaitObservation(operation);
    this.#deliverOrQueue(requestFor(operation, "POSITION_BALANCE_DISCREPANCY", `${reason}; lines await an authoritative read`));
  }

  /**
   * Deliver an UNKNOWN operation's reconciliation request. While the call is
   * in progress the operation accepts {@link resolveByReconciliation} (a
   * synchronous answer). Afterwards, if nothing answered it: delivered →
   * RECONCILING; not delivered → stays UNKNOWN with the request queued.
   */
  #requestReconciliation(operation: Operation, request: ReconciliationRequest, reason: string): boolean {
    operation.requesting = true;
    let delivered: boolean;
    try {
      delivered = this.#deliver(request);
    } finally {
      operation.requesting = false;
    }
    if (operation.state !== "UNKNOWN") return delivered; // answered during the call
    if (delivered) this.#transition(operation, "RECONCILING", reason);
    else this.#outstandingRequests.push({ request, advances: true });
    return delivered;
  }

  #deliver(request: ReconciliationRequest): boolean {
    try {
      this.#reconciler.request(Object.freeze({ ...request }));
      return true;
    } catch {
      return false;
    }
  }

  #beginHold(operation: Operation): InventoryResult<null> {
    const assetIds = this.#touchedAssets(operation);
    if (assetIds.length === 0) return ok(null);
    const holdId = holderRefOf(operation.plan.operationId);
    const held = this.#book.holdForOperation({ holdId, accountRef: operation.plan.accountRef, assetIds });
    if (!held.ok) return held;
    operation.holdId = holdId;
    return ok(null);
  }

  /** Every identifier this plan will hand the book, so it can be validated up front. */
  #derivedIdentifiers(plan: WalletOperationPlan, reservedAssetIds: readonly string[]): readonly string[] {
    const ids = [holderRefOf(plan.operationId)];
    for (const assetId of reservedAssetIds) {
      const reservationId = reservationIdOf(plan.operationId, assetId);
      ids.push(reservationId, debitPendingIdOf(reservationId));
    }
    for (const assetId of this.#touchedAssetsOf(plan, reservedAssetIds)) {
      ids.push(creditPendingIdOf(plan.operationId, assetId));
    }
    return ids;
  }

  #deliverOrQueue(request: ReconciliationRequest): void {
    if (!this.#deliver(request)) this.#outstandingRequests.push({ request, advances: false });
  }

  /**
   * The executor answered after evidence had already moved the operation out
   * of PLANNED (see the header). The answer is weighed, never dropped.
   */
  #lateExecutorAnswer(operation: Operation, result: Classified | "THREW", hints: Identity): void {
    let contradiction: string | null = null;
    const conflict = identityConflict(operation, hints.transactionHash, hints.transactionId);
    // Witnessed whatever it says: a second transaction stays explicit (WP300-R3-01).
    witness(operation, hints.transactionHash, hints.transactionId);
    if (conflict !== null) {
      contradiction = `the executor's late answer names a different ${conflict}`;
    } else if (result === "THREW") {
      // No new fact: the other evidence already says the operation left.
    } else if (result.kind === "SUBMITTED") {
      // Consistent: its identity (witnessed above) is learned.
    } else if (result.kind === "NOT_SENT") {
      contradiction = "the executor's late answer is NOT_SENT, contradicting the evidence received meanwhile";
    } else {
      contradiction = `the executor's late answer is unrecognised (${result.kind === "UNRECOGNISED" ? result.why : result.kind})`;
    }
    const state = operation.state;
    const deferred = operation.terminalDeferred;
    operation.terminalDeferred = false;
    if (state === "SUBMITTED" || state === "MINED") {
      // Reconciliation said "still in flight" while the executor was pending.
      if (contradiction !== null) {
        this.#toUnknown(operation, `${contradiction}${this.#bufferedNote(operation)}`);
        return;
      }
      // Terminal observations kept while the executor was pending are weighed now.
      this.#drainBuffer(operation, { transactionHash: operation.hashes[0] ?? null, transactionId: operation.ids[0] ?? null });
      return;
    }
    if (state === "CONFIRMED" || state === "FAILED") {
      // Unreachable by construction (nothing concludes while the executor is
      // pending — WP300-R3-02); fail closed if it ever happens.
      if (contradiction !== null) this.#blockAfterTerminal(operation, `${contradiction} (operation is ${state})`);
      return;
    }
    if (contradiction === null && !deferred) return;
    this.#deliverOrQueue(
      requestFor(
        operation,
        WALLET_OPERATION_UNKNOWN_TRIGGER,
        contradiction === null
          ? "the executor call has now answered; a terminal resolution refused while it was pending may be given now"
          : `${contradiction} (operation is ${state})`,
      ),
    );
  }

  #endHold(operation: Operation): void {
    if (operation.holdId === null) return;
    this.#book.releaseOperationHold(operation.holdId);
    operation.holdId = null;
  }

  #bufferedNote(operation: Operation): string {
    const count = operation.buffered.length;
    if (count === 0) return "";
    operation.buffered.length = 0;
    return ` (${String(count)} observation(s) received during submission; not applied)`;
  }

  #transition(operation: Operation, to: WalletOperationState, reason: string): void {
    const from = operation.state;
    if (!isLegalWalletTransition(from, to)) {
      throw new Error(`wallet-operation invariant: illegal transition ${from} -> ${to}`);
    }
    operation.state = to;
    this.#record(operation, from, to, reason);
  }

  #record(operation: Operation, from: WalletOperationState | null, to: WalletOperationState, reason: string): void {
    this.#events.push(
      Object.freeze({
        operationId: operation.plan.operationId,
        ordinal: operation.ordinal,
        previousState: from,
        newState: to,
        reason,
      }),
    );
    operation.ordinal += 1;
  }

  #reservationNeeds(
    plan: WalletOperationPlan,
  ): InventoryResult<readonly { readonly assetId: string; readonly amount: DecimalString }[]> {
    switch (plan.type) {
      case "APPROVE_ERC20":
      case "APPROVE_ERC1155":
        return ok([]);
      case "SPLIT":
      case "MERGE": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair === undefined) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "condition has no registered outcome pair", {
            conditionId: plan.conditionId,
          });
        }
        return plan.type === "SPLIT"
          ? ok([{ assetId: this.#registry.pusdAssetId, amount: plan.amount }])
          : ok([
              { assetId: pair.yesAssetId, amount: plan.amount },
              { assetId: pair.noAssetId, amount: plan.amount },
            ]);
      }
      case "REDEEM": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair === undefined) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "condition has no registered outcome pair", {
            conditionId: plan.conditionId,
          });
        }
        const needs: { assetId: string; amount: DecimalString }[] = [];
        if (plan.yesAmount !== undefined) needs.push({ assetId: pair.yesAssetId, amount: plan.yesAmount });
        if (plan.noAmount !== undefined) needs.push({ assetId: pair.noAssetId, amount: plan.noAmount });
        return ok(needs);
      }
      case "WRAP_COLLATERAL": {
        const usdcE = this.#registry.usdcEAssetId;
        if (usdcE === null) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "no USDC.e asset is registered; the onramp wraps USDC.e only");
        }
        return ok([{ assetId: usdcE, amount: plan.amount }]);
      }
      case "UNWRAP_COLLATERAL":
        if (this.#registry.usdcEAssetId === null) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "no USDC.e asset is registered to receive the unwrap");
        }
        return ok([{ assetId: this.#registry.pusdAssetId, amount: plan.amount }]);
    }
  }

  #parsePlan(input: unknown): InventoryResult<WalletOperationPlan> {
    const type = ownData(input, "type");
    if (typeof type !== "string" || !(WALLET_OPERATION_TYPES as readonly string[]).includes(type)) {
      return refuse("WALLET_OP_UNSUPPORTED_TYPE", "unsupported wallet operation type", {
        type: typeof type === "string" ? type : null,
      });
    }
    const opType = type as WalletOperationType;
    const allowed = WALLET_PLAN_KEYS[opType];
    for (const key of Reflect.ownKeys(input as object)) {
      if (typeof key !== "string" || !allowed.includes(key)) {
        return refuse("INVENTORY_INVALID_INPUT", "wallet operation plan carries a field this operation does not have", {
          type: opType,
          field: typeof key === "string" ? key : "<symbol>",
        });
      }
    }
    const operationId = ownNonEmptyString(input, "operationId");
    const accountRef = ownNonEmptyString(input, "accountRef");
    if (operationId === undefined || accountRef === undefined) {
      return refuse("INVENTORY_INVALID_INPUT", "wallet operation needs operationId and accountRef");
    }
    const bad = (message: string): InventoryResult<WalletOperationPlan> =>
      refuse("INVENTORY_INVALID_INPUT", message, { type: opType, operationId });
    switch (opType) {
      case "APPROVE_ERC20": {
        const assetId = ownNonEmptyString(input, "assetId");
        const spender = ownNonEmptyString(input, "spender");
        const allowance = ownPositiveAmount(input, "allowance");
        if (assetId === undefined || spender === undefined || allowance === undefined) {
          return bad("APPROVE_ERC20 needs assetId, spender and a positive allowance");
        }
        const role = this.#registry.lookup(assetId)?.role;
        if (role !== "PUSD" && role !== "USDC_E") {
          return refuse("INVENTORY_ASSET_ROLE_MISMATCH", "an ERC20 approval is for a registered collateral asset", {
            assetId,
          });
        }
        if (!isDocumentedApprovalSpender(spender)) {
          return refuse("WALLET_OP_SPENDER_NOT_DOCUMENTED", "approval spender is not a documented venue contract", {
            spender,
          });
        }
        return ok(Object.freeze({ type: opType, operationId, accountRef, assetId, spender, allowance }));
      }
      case "APPROVE_ERC1155": {
        const spender = ownNonEmptyString(input, "spender");
        if (spender === undefined) return bad("APPROVE_ERC1155 needs spender");
        if (!isDocumentedApprovalSpender(spender)) {
          return refuse("WALLET_OP_SPENDER_NOT_DOCUMENTED", "approval spender is not a documented venue contract", {
            spender,
          });
        }
        return ok(Object.freeze({ type: opType, operationId, accountRef, spender }));
      }
      case "SPLIT":
      case "MERGE": {
        const conditionId = ownNonEmptyString(input, "conditionId");
        const amount = ownPositiveAmount(input, "amount");
        if (conditionId === undefined || amount === undefined) {
          return bad(`${opType} needs conditionId and a positive amount`);
        }
        return ok(Object.freeze({ type: opType, operationId, accountRef, conditionId, amount }));
      }
      case "REDEEM": {
        const conditionId = ownNonEmptyString(input, "conditionId");
        const resolution = ownData(input, "resolution");
        const yesRaw = ownData(input, "yesAmount");
        const noRaw = ownData(input, "noAmount");
        const yesAmount = yesRaw === undefined ? undefined : ownPositiveAmount(input, "yesAmount");
        const noAmount = noRaw === undefined ? undefined : ownPositiveAmount(input, "noAmount");
        if (
          conditionId === undefined ||
          (yesRaw !== undefined && yesAmount === undefined) ||
          (noRaw !== undefined && noAmount === undefined) ||
          (yesAmount === undefined && noAmount === undefined)
        ) {
          return bad("REDEEM needs conditionId and at least one positive yesAmount/noAmount");
        }
        if (resolution === "CANCELLED") {
          return refuse(
            "WALLET_OP_REDEEM_CANCELLED_UNVERIFIED",
            "a CANCELLED market's payout is undocumented (U-10); redemption is refused rather than invented",
            { conditionId },
          );
        }
        if (resolution !== "YES_WIN" && resolution !== "NO_WIN" && resolution !== "SPLIT_50_50") {
          return refuse(
            "WALLET_OP_REDEEM_OUTCOME_NOT_TERMINAL",
            "redeem requires a resolved market (YES_WIN, NO_WIN or SPLIT_50_50); resolution is not settlement (ADR-009 §8)",
            { conditionId, resolution: typeof resolution === "string" ? resolution : null },
          );
        }
        return ok(
          Object.freeze({
            type: opType,
            operationId,
            accountRef,
            conditionId,
            resolution,
            ...(yesAmount === undefined ? {} : { yesAmount }),
            ...(noAmount === undefined ? {} : { noAmount }),
          }),
        );
      }
      case "WRAP_COLLATERAL":
      case "UNWRAP_COLLATERAL": {
        const amount = ownPositiveAmount(input, "amount");
        if (amount === undefined) return bad(`${opType} needs a positive amount`);
        return ok(Object.freeze({ type: opType, operationId, accountRef, amount }));
      }
    }
  }
}

// ------------------------------------------------------------ identifiers --

function holderRefOf(operationId: string): string {
  return compositeKey("wallet-op", operationId);
}

function reservationIdOf(operationId: string, assetId: string): string {
  return compositeKey("wallet-op", operationId, assetId);
}

function debitPendingIdOf(reservationId: string): string {
  return compositeKey(reservationId, "out");
}

function creditPendingIdOf(operationId: string, assetId: string): string {
  return compositeKey("wallet-op", operationId, assetId, "in");
}

/**
 * Why the observations buffered during submission, read together with the
 * executor's SUBMITTED answer, are not one consistent story — or null.
 * Checked before any of them is applied (WP300-R2-02).
 */
function bufferConflict(
  submitted: { readonly transactionHash: string | null; readonly transactionId: string | null },
  buffered: readonly Classified[],
): string | null {
  let hash = submitted.transactionHash;
  let id = submitted.transactionId;
  let terminal: Classified | null = null;
  for (const outcome of buffered) {
    if (outcome.kind === "UNRECOGNISED" || outcome.kind === "NOT_SENT") return `an unrecognised observation`;
    if (outcome.transactionHash !== null && hash !== null && outcome.transactionHash !== hash) {
      return `${outcome.kind} under a different transaction hash`;
    }
    if (outcome.transactionId !== null && id !== null && outcome.transactionId !== id) {
      return `${outcome.kind} under a different relayer transaction id`;
    }
    hash ??= outcome.transactionHash;
    id ??= outcome.transactionId;
    if (terminal !== null) {
      const repeat =
        outcome.kind === terminal.kind &&
        (outcome.kind !== "CONFIRMED" ||
          terminal.kind !== "CONFIRMED" ||
          (outcome.credited === null
            ? terminal.credited === null
            : terminal.credited !== null && compareDecimal(outcome.credited, terminal.credited) === 0));
      if (!repeat) return `${outcome.kind} after ${terminal.kind}`;
    } else if (outcome.kind === "CONFIRMED" || outcome.kind === "FAILED") {
      terminal = outcome;
    }
  }
  return null;
}

// ------------------------------------------------------------ classifiers --

function nullableString(source: unknown, key: string): string | null | undefined {
  const descriptor =
    source !== null && typeof source === "object" ? Object.getOwnPropertyDescriptor(source, key) : undefined;
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * An optional identity field: absent or null → null; a non-empty string →
 * itself; anything else (malformed) → undefined.
 */
function optionalIdentity(source: unknown, key: string): string | null | undefined {
  const descriptor =
    source !== null && typeof source === "object" ? Object.getOwnPropertyDescriptor(source, key) : undefined;
  if (descriptor === undefined) return null;
  if (!("value" in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface Identity {
  readonly transactionHash: string | null;
  readonly transactionId: string | null;
}

/**
 * Which identity field the evidence contradicts, if any: it names a value
 * while other values of that field have been witnessed, none of them this one.
 */
function identityConflict(
  operation: Operation,
  transactionHash: string | null,
  transactionId: string | null,
): "transaction hash" | "relayer transaction id" | null {
  if (transactionHash !== null && operation.hashes.length > 0 && !operation.hashes.includes(transactionHash)) {
    return "transaction hash";
  }
  if (transactionId !== null && operation.ids.length > 0 && !operation.ids.includes(transactionId)) {
    return "relayer transaction id";
  }
  return null;
}

/** Record identities the evidence names. Witnessed identities are never removed (WP300-R3-01). */
function witness(operation: Operation, transactionHash: string | null, transactionId: string | null): void {
  if (transactionHash !== null && !operation.hashes.includes(transactionHash)) operation.hashes.push(transactionHash);
  if (transactionId !== null && !operation.ids.includes(transactionId)) operation.ids.push(transactionId);
}

function isNewIdentity(operation: Operation, hints: Identity): boolean {
  return (
    (hints.transactionHash !== null && !operation.hashes.includes(hints.transactionHash)) ||
    (hints.transactionId !== null && !operation.ids.includes(hints.transactionId))
  );
}

/** More than one transaction hash or relayer id has been named for the operation. */
function isConflicted(operation: Operation): boolean {
  return operation.hashes.length > 1 || operation.ids.length > 1;
}

const hashKey = (hash: string): string => `hash:${hash}`;
const idKey = (id: string): string => `id:${id}`;

/**
 * The resolution keys a terminal answer covers for a conflicted operation, or
 * null when it does not name a value for every conflicted field.
 */
function resolutionKeys(operation: Operation, transactionHash: string | null, transactionId: string | null): string[] | null {
  const keys: string[] = [];
  if (operation.hashes.length > 1) {
    if (transactionHash === null) return null;
    keys.push(hashKey(transactionHash));
  }
  if (operation.ids.length > 1) {
    if (transactionId === null) return null;
    keys.push(idKey(transactionId));
  }
  return keys;
}

/** Conflicted identities still lacking a terminal authoritative resolution. */
function unresolvedOf(operation: Operation): string[] {
  if (!isConflicted(operation)) return [];
  const keys = [
    ...(operation.hashes.length > 1 ? operation.hashes.map(hashKey) : []),
    ...(operation.ids.length > 1 ? operation.ids.map(idKey) : []),
  ];
  return keys.filter((k) => !operation.resolutions.has(k));
}

/**
 * Identity fields an arbitrary input names (own data, non-empty strings),
 * whether or not the rest of it is recognised: a transaction named by
 * unrecognised evidence is still a transaction to account for.
 */
function identityHints(raw: unknown): Identity {
  const hash = nullableString(raw, "transactionHash");
  const id = nullableString(raw, "transactionId");
  return { transactionHash: typeof hash === "string" ? hash : null, transactionId: typeof id === "string" ? id : null };
}

function requestFor(operation: Operation, trigger: ReconciliationTrigger, reason: string): ReconciliationRequest {
  return {
    trigger,
    walletOperationId: operation.plan.operationId,
    accountRef: operation.plan.accountRef,
    reason,
    transactionHashes: Object.freeze([...operation.hashes]),
    transactionIds: Object.freeze([...operation.ids]),
  };
}

/** Classify an executor `submit` result. Only two shapes are recognised. */
export function classifySubmit(raw: unknown): Classified {
  const status = ownData(raw, "status");
  if (status === "NOT_SENT") return { kind: "NOT_SENT" };
  if (status === "SUBMITTED") {
    const transactionHash = nullableString(raw, "transactionHash");
    const transactionId = nullableString(raw, "transactionId");
    if (transactionHash === undefined || transactionId === undefined) {
      return { kind: "UNRECOGNISED", why: "SUBMITTED without transactionHash/transactionId fields" };
    }
    if (transactionHash === null && transactionId === null) {
      return { kind: "UNRECOGNISED", why: "SUBMITTED with neither a transaction hash nor a relayer id" };
    }
    return { kind: "SUBMITTED", transactionHash, transactionId };
  }
  return { kind: "UNRECOGNISED", why: typeof status === "string" ? `status ${status}` : "no status" };
}

/** Classify a lifecycle observation or reconciliation state. */
export function classifyObservation(raw: unknown): Classified {
  const status = ownData(raw, "status");
  switch (status) {
    case "SUBMITTED":
      return classifySubmit(raw);
    case "MINED": {
      const transactionHash = nullableString(raw, "transactionHash");
      const transactionId = optionalIdentity(raw, "transactionId");
      if (typeof transactionHash !== "string") return { kind: "UNRECOGNISED", why: "MINED without a transaction hash" };
      if (transactionId === undefined) return { kind: "UNRECOGNISED", why: "MINED with a malformed transactionId" };
      return { kind: "MINED", transactionHash, transactionId };
    }
    case "CONFIRMED": {
      // TransactionOutcome: transactionHash: TxHash; transactionId: TransactionId | null.
      const transactionHash = nullableString(raw, "transactionHash");
      const transactionIdRaw = optionalIdentity(raw, "transactionId");
      if (typeof transactionHash !== "string") {
        return { kind: "UNRECOGNISED", why: "CONFIRMED without a transaction hash" };
      }
      if (transactionIdRaw === undefined) return { kind: "UNRECOGNISED", why: "CONFIRMED with a malformed transactionId" };
      const creditedRaw = ownData(raw, "credited");
      const credited = creditedRaw === undefined ? null : ownNonNegativeAmount(raw, "credited");
      if (credited === undefined) return { kind: "UNRECOGNISED", why: "CONFIRMED with a malformed credited amount" };
      return { kind: "CONFIRMED", transactionHash, transactionId: transactionIdRaw, credited };
    }
    case "FAILED": {
      const transactionHash = optionalIdentity(raw, "transactionHash");
      const transactionId = optionalIdentity(raw, "transactionId");
      if (transactionHash === undefined || transactionId === undefined) {
        return { kind: "UNRECOGNISED", why: "FAILED with a malformed transaction identity" };
      }
      return { kind: "FAILED", transactionHash, transactionId };
    }
    default:
      return { kind: "UNRECOGNISED", why: typeof status === "string" ? `status ${status}` : "no status" };
  }
}

function plainCopy(source: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  if (source === null || typeof source !== "object") return copy;
  for (const key of ["transactionHash", "transactionId", "credited"]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor !== undefined && "value" in descriptor) copy[key] = descriptor.value;
  }
  return copy;
}

function stateOf(operation: Operation): WalletOperationState {
  return operation.state;
}

function view(operation: Operation): WalletOperationView {
  return Object.freeze({
    operationId: operation.plan.operationId,
    type: operation.plan.type,
    accountRef: operation.plan.accountRef,
    state: operation.state,
    plan: operation.plan,
    reservationIds: Object.freeze(operation.reservations.map((r) => r.reservationId)),
    transactionHash: operation.hashes[0] ?? null,
    transactionId: operation.ids[0] ?? null,
    effectsApplied: operation.effectsApplied,
    submitting: operation.submitting,
    bufferedObservations: operation.buffered.length,
    transactionHashes: Object.freeze([...operation.hashes]),
    transactionIds: Object.freeze([...operation.ids]),
    unresolvedTransactions: Object.freeze(unresolvedOf(operation)),
  });
}
