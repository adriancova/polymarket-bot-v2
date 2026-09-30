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
 * evidence leaves RECONCILING; there is no timeout.
 */

import { compareDecimal, type DecimalString } from "@polymarket-bot/decimal";
import type { MarketOutcomeState } from "@polymarket-bot/domain";

import type { ApprovalTracker } from "./approvals.js";
import type { AssetRegistry } from "./assets.js";
import { compositeKey, ownData, ownNonEmptyString, ownNonNegativeAmount, ownPositiveAmount } from "./guards.js";
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
}

interface Operation {
  readonly plan: WalletOperationPlan;
  readonly reservations: readonly { readonly reservationId: string; readonly assetId: string; readonly amount: DecimalString }[];
  state: WalletOperationState;
  transactionHash: string | null;
  transactionId: string | null;
  effectsApplied: boolean;
  submitting: boolean;
  ordinal: number;
}

type Classified =
  | { readonly kind: "NOT_SENT" }
  | { readonly kind: "SUBMITTED"; readonly transactionHash: string | null; readonly transactionId: string | null }
  | { readonly kind: "MINED"; readonly transactionHash: string }
  | {
      readonly kind: "CONFIRMED";
      readonly transactionHash: string;
      readonly transactionId: string | null;
      readonly credited: DecimalString | null;
    }
  | { readonly kind: "FAILED" }
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
  readonly #outstandingRequests: ReconciliationRequest[] = [];

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
    const made: { reservationId: string; assetId: string; amount: DecimalString }[] = [];
    for (const need of needs.value) {
      const reservationId = compositeKey("wallet-op", plan.operationId, need.assetId);
      const reserved = this.#book.reserve({
        reservationId,
        holderRef: compositeKey("wallet-op", plan.operationId),
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
      transactionHash: null,
      transactionId: null,
      effectsApplied: false,
      submitting: false,
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
    // Claimed synchronously: a concurrent second submit is refused above.
    operation.submitting = true;
    let raw: unknown;
    try {
      raw = await this.#executor.submit(operation.plan);
    } catch {
      operation.submitting = false;
      this.#toUnknown(operation, "the executor threw; the submission's fate is unknown");
      return ok(view(operation));
    }
    operation.submitting = false;
    const result = classifySubmit(raw);
    if (result.kind === "NOT_SENT") {
      this.#transition(operation, "FAILED", "executor: NOT_SENT (nothing left the process)");
      this.#releaseAll(operation);
    } else if (result.kind === "SUBMITTED") {
      operation.transactionHash = result.transactionHash;
      operation.transactionId = result.transactionId;
      this.#transition(operation, "SUBMITTED", "executor: SUBMITTED");
    } else {
      this.#toUnknown(operation, `unrecognised executor result: ${result.kind === "UNRECOGNISED" ? result.why : result.kind}`);
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
    if (operation.state !== "SUBMITTED" && operation.state !== "MINED") {
      return refuse(
        "WALLET_OP_ILLEGAL_TRANSITION",
        "observations apply only to SUBMITTED or MINED operations; UNKNOWN/RECONCILING resolve only by reconciliation",
        { operationId, state: operation.state },
      );
    }
    this.#applyOutcome(operation, classifyObservation(observation), "observation");
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
    if (operation.state !== "RECONCILING") {
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
    if (classified.kind === "SUBMITTED" || classified.kind === "MINED") {
      if (classified.kind === "MINED") operation.transactionHash = classified.transactionHash;
      else {
        operation.transactionHash = classified.transactionHash;
        operation.transactionId = classified.transactionId;
      }
      this.#transition(operation, classified.kind, "reconciliation: still in flight");
      return ok(view(operation));
    }
    if (classified.kind === "FAILED") {
      this.#transition(operation, "FAILED", "reconciliation: FAILED");
      this.#releaseAll(operation);
      return ok(view(operation));
    }
    if (classified.kind === "CONFIRMED") {
      operation.transactionHash = classified.transactionHash;
      operation.transactionId = classified.transactionId;
      this.#transition(operation, "CONFIRMED", "reconciliation: CONFIRMED");
      this.#recordApprovalIfAny(operation);
      this.#releaseAll(operation);
      this.#awaitObservation(operation);
      return ok(view(operation));
    }
    return refuse("WALLET_OP_EVIDENCE_REQUIRED", "evidence is inconclusive; the operation stays RECONCILING", {
      operationId,
      state: typeof state === "string" ? state : null,
    });
  }

  /** Retry reconciliation requests the requester refused earlier. */
  retryReconciliationRequests(): number {
    const pending = this.#outstandingRequests.splice(0);
    let delivered = 0;
    for (const request of pending) {
      if (this.#request(request)) {
        delivered += 1;
        const operation = this.#operations.get(request.walletOperationId);
        if (request.trigger === WALLET_OPERATION_UNKNOWN_TRIGGER && operation?.state === "UNKNOWN") {
          this.#transition(operation, "RECONCILING", "reconciliation requested (retry)");
        }
      }
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
    return Object.freeze([...this.#outstandingRequests]);
  }

  // -------------------------------------------------------------- internal --

  #applyOutcome(operation: Operation, outcome: Classified, via: string): void {
    switch (outcome.kind) {
      case "MINED":
        if (operation.state === "MINED") {
          // A repeated MINED report is idempotent only for the same transaction.
          if (operation.transactionHash !== outcome.transactionHash) {
            this.#toUnknown(operation, `${via}: MINED under a different transaction hash`);
          }
          return;
        }
        operation.transactionHash = outcome.transactionHash;
        this.#transition(operation, "MINED", `${via}: MINED`);
        return;
      case "SUBMITTED":
        // A repeated SUBMITTED report changes nothing; after MINED it is a regression.
        if (operation.state !== "SUBMITTED") this.#toUnknown(operation, `${via}: SUBMITTED after MINED`);
        return;
      case "FAILED":
        this.#transition(operation, "FAILED", `${via}: FAILED`);
        this.#releaseAll(operation);
        return;
      case "CONFIRMED": {
        const needsCredit = CREDIT_EVIDENCE_TYPES.includes(operation.plan.type);
        if (needsCredit && outcome.credited === null) {
          this.#toUnknown(operation, `${via}: CONFIRMED without the observed credited amount; not assumed`);
          return;
        }
        operation.transactionHash = outcome.transactionHash;
        operation.transactionId = outcome.transactionId;
        this.#transition(operation, "CONFIRMED", `${via}: CONFIRMED`);
        this.#recordApprovalIfAny(operation);
        if (!this.#applyConfirmedDeltas(operation, outcome.credited)) {
          this.#releaseAll(operation);
          this.#awaitObservation(operation);
          this.#request({
            trigger: "POSITION_BALANCE_DISCREPANCY",
            walletOperationId: operation.plan.operationId,
            accountRef: operation.plan.accountRef,
            reason: "confirmed wallet operation's deltas do not fit the book; lines await an authoritative read",
          });
        }
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
    // Pre-check every debit against the actual balance: all or nothing.
    for (const r of operation.reservations) {
      const line = this.#book.line(plan.accountRef, r.assetId);
      if (line === undefined || compareDecimal(line.actual, r.amount) < 0) return false;
    }
    for (const r of operation.reservations) {
      const pendingId = compositeKey(r.reservationId, "out");
      const consumed = this.#book.consume({ reservationId: r.reservationId, amount: r.amount, pendingId });
      if (!consumed.ok) throw new Error(`wallet-operation invariant: consume refused (${consumed.refusal.code})`);
      const settled = this.#book.settlePending({ pendingId, settlement: "APPLIED" });
      if (!settled.ok) throw new Error(`wallet-operation invariant: settle refused (${settled.refusal.code})`);
    }
    for (const credit of credits) {
      const pendingId = compositeKey("wallet-op", plan.operationId, credit.assetId, "in");
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
    const plan = operation.plan;
    const assets = new Set(operation.reservations.map((r) => r.assetId));
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
    const delivered = this.#request({
      trigger: WALLET_OPERATION_UNKNOWN_TRIGGER,
      walletOperationId: operation.plan.operationId,
      accountRef: operation.plan.accountRef,
      reason,
    });
    if (delivered) this.#transition(operation, "RECONCILING", "reconciliation requested");
  }

  #request(request: ReconciliationRequest): boolean {
    try {
      this.#reconciler.request(Object.freeze({ ...request }));
      return true;
    } catch {
      this.#outstandingRequests.push(request);
      return false;
    }
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

// ------------------------------------------------------------ classifiers --

function nullableString(source: unknown, key: string): string | null | undefined {
  const descriptor =
    source !== null && typeof source === "object" ? Object.getOwnPropertyDescriptor(source, key) : undefined;
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
      return typeof transactionHash === "string"
        ? { kind: "MINED", transactionHash }
        : { kind: "UNRECOGNISED", why: "MINED without a transaction hash" };
    }
    case "CONFIRMED": {
      // TransactionOutcome: transactionHash: TxHash; transactionId: TransactionId | null.
      const transactionHash = nullableString(raw, "transactionHash");
      const transactionIdRaw = nullableString(raw, "transactionId");
      if (typeof transactionHash !== "string") {
        return { kind: "UNRECOGNISED", why: "CONFIRMED without a transaction hash" };
      }
      const creditedRaw = ownData(raw, "credited");
      const credited = creditedRaw === undefined ? null : ownNonNegativeAmount(raw, "credited");
      if (credited === undefined) return { kind: "UNRECOGNISED", why: "CONFIRMED with a malformed credited amount" };
      return { kind: "CONFIRMED", transactionHash, transactionId: transactionIdRaw ?? null, credited };
    }
    case "FAILED":
      return { kind: "FAILED" };
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

function view(operation: Operation): WalletOperationView {
  return Object.freeze({
    operationId: operation.plan.operationId,
    type: operation.plan.type,
    accountRef: operation.plan.accountRef,
    state: operation.state,
    plan: operation.plan,
    reservationIds: Object.freeze(operation.reservations.map((r) => r.reservationId)),
    transactionHash: operation.transactionHash,
    transactionId: operation.transactionId,
    effectsApplied: operation.effectsApplied,
  });
}
