/**
 * Every venue request the emergency CLI makes is granted by WP-310's
 * `RateLimitBudget` first (WP-310 follow_up 4 and OP-R1-09; handoff §9.13).
 *
 * - **Class.** Every cancel is filed at `EMERGENCY_CANCEL` (§9.13 rank 2,
 *   "Emergency cancel and cancel-all"); every venue-truth read at
 *   `RECONCILIATION_READ` (rank 3). A cancel is never filed as a stale-quote
 *   cancel (OP-R1-08).
 * - **The count.** A cancel-all and a cancel-market-orders grant is completed
 *   with the venue's canceled count, so the cancel bucket is debited one token
 *   per order canceled (D-21; OP-R1-09). Every cancel completion carries a
 *   count ({@link canceledCountOf}): the venue's, or, when its answer was
 *   lost, the conservative estimate the command passes (the orders it listed
 *   before; an over-debit only makes the next cancel wait longer).
 * - **Batch size.** A batch cancel by id carries at most the cancel bucket's
 *   burst minus the emergency class's headroom ({@link EmergencyBudget.batchCapacity}),
 *   and never more than WP-260's `MAX_CANCEL_IDS_PER_REQUEST` (C-11): a larger
 *   batch "can never be admitted as one request" and WP-310 refuses it. The
 *   capacity follows the tier the venue reports and the snapshot in effect,
 *   so cancel-all reads it again before every batch (CX330-R4-01).
 * - **Debt.** After a large cancel-all the cancel bucket may be in debt on
 *   the tiers that allow it (D-21). {@link EmergencyBudget.cancelDebtPlan}
 *   prints the estimate before acting, and {@link EmergencyBudget.acquire}
 *   waits for the grant, up to the configured `maxBudgetWaitMs`; past that the
 *   request is not sent, and the output says so.
 * - **Cold start.** A CLI process sees a signer for the first time, so its
 *   buckets start EMPTY (WP-310): it cannot know what the trader, which shares
 *   the venue's bucket for that signer, has spent. Its first cancel waits for
 *   one token's refill.
 *
 * Operation ids are the configuration names WP-310's dated contract snapshot
 * uses (`test/contract/rate-limits/fixtures/rate-limits-2026-09-30.snapshot.json`);
 * the operator's snapshot must define each one the CLI uses, or the request
 * is not sent (fail closed).
 */

import {
  MAX_CANCEL_IDS_PER_REQUEST,
  RateLimitBudget,
  feedbackFromObservation,
  signerBucketOfObservation,
  type BudgetEffect,
  type BudgetRequest,
  type CancelOutcome,
  type Grant,
  type PriorityClass,
  type RateLimitConfiguration,
  type RateLimitObservation,
} from "@polymarket-bot/polymarket-secure";

import type { OpsClock } from "./ports.js";

export const EMERGENCY_OPERATIONS = Object.freeze({
  CANCEL_ORDER: "clob.cancel_order",
  CANCEL_ORDERS: "clob.cancel_orders",
  CANCEL_MARKET_ORDERS: "clob.cancel_market_orders",
  CANCEL_ALL: "clob.cancel_all",
  OPEN_ORDERS: "clob.data_orders",
  ORDER_BY_ID: "clob.get_order",
  TRADES: "clob.get_trades",
  POSITIONS: "data.v2.positions",
  APPROVALS: "data.v2.approvals",
} as const);

export const CANCEL_PRIORITY: PriorityClass = "EMERGENCY_CANCEL";
export const READ_PRIORITY: PriorityClass = "RECONCILIATION_READ";

/** Thousandths of a token: the budget's exact unit (WP-310 `units.ts`). */
const MILLI = 1000;
/** Headroom is given per mille of a capacity (WP-310 `PER_MILLE`). */
const PER_MILLE = 1000;
/** A safety stop on the wait loop: no grant is worth more polls than this. */
const MAX_POLLS = 100_000;

export type AcquireResult =
  | { readonly kind: "GRANTED"; readonly grant: Grant; readonly waitedMs: number }
  | { readonly kind: "REFUSED"; readonly code: string; readonly message: string }
  /** The grant would come later than `maxBudgetWaitMs` allows; the request was withdrawn and nothing was sent. */
  | { readonly kind: "TIMED_OUT"; readonly waitedMs: number; readonly wakeAtMs: number | null };

export interface BatchCapacity {
  readonly tier: string;
  readonly cancelBurst: number;
  readonly headroomPermille: number;
  /** The most ids one `DELETE /orders` request may carry now. */
  readonly maxEntries: number;
}

export interface CancelDebtPlan {
  readonly tier: string;
  readonly cancelBurst: number;
  readonly cancelTokensPerSecond: number;
  readonly negativeCancelBalance: boolean;
  /** The cancel bucket's local level now, in tokens (exact decimal text). */
  readonly levelNow: string;
  /** About how long until the cancel-all itself is granted. */
  readonly firstGrantWaitMs: number;
  /** The orders the plan assumes canceled (the listed count), or `null` when unknown. */
  readonly assumedCanceled: number | null;
  /** The local level just after the debit, in tokens (exact decimal text), or `null` when unknown. */
  readonly levelAfterDebit: string | null;
  /** About how long after the cancel-all a by-id sweep batch of `sweepEntries` ids would be granted. */
  readonly sweepWaitMs: number | null;
  readonly sweepEntries: number;
}

/** Milli-tokens as an exact decimal token string. */
export function tokensText(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const magnitude = Math.abs(milli);
  const whole = Math.floor(magnitude / MILLI);
  const fraction = magnitude % MILLI;
  return fraction === 0 ? `${sign}${String(whole)}` : `${sign}${String(whole)}.${String(fraction).padStart(3, "0").replace(/0+$/u, "")}`;
}

/**
 * The count a cancel completion carries (OP-R1-09: always pass it). The
 * venue's own count when it answered; 0 when nothing was sent or the venue
 * refused it unapplied; else the caller's conservative estimate (the orders
 * listed before), or `null` only when no estimate exists either.
 */
export function canceledCountOf(outcome: CancelOutcome, estimateWhenUnknown: number | null): number | null {
  switch (outcome.kind) {
    case "COMPLETED":
      return outcome.canceled.length;
    case "NOT_SENT":
    case "REFUSED":
      return 0;
    case "UNKNOWN":
      return estimateWhenUnknown;
  }
}

/** The completion error of a cancel outcome (WP-260's error kind; a 429 is `RATE_LIMITED`). */
export function completionErrorOf(outcome: CancelOutcome): { readonly kind: string; readonly retryAfterSeconds: number | null } | null {
  switch (outcome.kind) {
    case "COMPLETED":
      return null;
    case "UNKNOWN":
      return outcome.error === null ? { kind: "UNRECOGNISED_RESPONSE", retryAfterSeconds: null } : { kind: outcome.error.kind, retryAfterSeconds: outcome.error.retryAfterSeconds };
    default:
      return { kind: outcome.error.kind, retryAfterSeconds: outcome.error.retryAfterSeconds };
  }
}

export class EmergencyBudget {
  readonly #budget: RateLimitBudget;
  readonly #clock: OpsClock;
  readonly #maxWaitMs: number;
  #signer: string | null = null;
  readonly #effects: BudgetEffect[] = [];
  readonly #notes: string[] = [];

  private constructor(budget: RateLimitBudget, clock: OpsClock, maxWaitMs: number) {
    this.#budget = budget;
    this.#clock = clock;
    this.#maxWaitMs = maxWaitMs;
  }

  static create(snapshots: readonly unknown[], clock: OpsClock, maxWaitMs: number): { readonly ok: true; readonly value: EmergencyBudget } | { readonly ok: false; readonly problem: string } {
    const built = RateLimitBudget.create(snapshots);
    if (!built.ok) return { ok: false, problem: built.refusal.message };
    return { ok: true, value: new EmergencyBudget(built.value, clock, maxWaitMs) };
  }

  /** The signer whose buckets the cancels draw on (the venue client's identity: not secret). */
  set signer(address: string) {
    this.#signer = address;
  }

  get signer(): string | null {
    return this.#signer;
  }

  /** Every effect the budget reported on a completion or an observation, in order. */
  effects(): readonly BudgetEffect[] {
    return Object.freeze([...this.#effects]);
  }

  /** Problems the budget reported that the commands did not act on (a refused completion, an unusable observation). */
  notes(): readonly string[] {
    return Object.freeze([...this.#notes]);
  }

  configuration(): RateLimitConfiguration | undefined {
    return this.#budget.configurationAt(this.#clock.nowMs());
  }

  /**
   * Ask for one request and wait for its grant, polling at the budget's own
   * wake times. Withdraws and answers `TIMED_OUT` as soon as the grant cannot
   * come within `maxBudgetWaitMs` of the ask.
   */
  async acquire(request: BudgetRequest): Promise<AcquireResult> {
    const start = this.#clock.nowMs();
    const decision = this.#budget.request(request, start);
    if (decision.kind === "GRANTED") return { kind: "GRANTED", grant: decision.grant, waitedMs: 0 };
    if (decision.kind === "REFUSED") return { kind: "REFUSED", code: decision.refusal.code, message: decision.refusal.message };
    const ticket = decision.ticketId;
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      const now = this.#clock.nowMs();
      for (const event of this.#budget.poll(now)) {
        if (event.ticketId !== ticket) continue;
        if (event.kind === "GRANTED") return { kind: "GRANTED", grant: event.grant, waitedMs: now - start };
        return { kind: "REFUSED", code: event.refusal.code, message: event.refusal.message };
      }
      const wake = this.#budget.nextWakeAtMs(now);
      if (wake === null || wake - start > this.#maxWaitMs) {
        this.#budget.withdraw(ticket);
        return { kind: "TIMED_OUT", waitedMs: now - start, wakeAtMs: wake };
      }
      await this.#clock.sleep(Math.max(1, wake - now));
    }
    this.#budget.withdraw(ticket);
    return { kind: "TIMED_OUT", waitedMs: this.#clock.nowMs() - start, wakeAtMs: null };
  }

  /** Close a grant with the venue's answer. Each grant completes once. */
  complete(grant: Grant, completion: { readonly error: { readonly kind: string; readonly retryAfterSeconds: number | null } | null; readonly canceledCount?: number | null }): readonly BudgetEffect[] {
    const result = this.#budget.complete(grant, {
      atMs: this.#clock.nowMs(),
      error: completion.error,
      ...(completion.canceledCount === undefined ? {} : { canceledCount: completion.canceledCount }),
    });
    if (!result.ok) {
      this.#notes.push(`the budget refused a completion of ${grant.operationId}: ${result.refusal.code}`);
      return [];
    }
    this.#effects.push(...result.value);
    return result.value;
  }

  /** WP-260's `onRateLimitUpdate`: one observation for this signer's bucket. */
  observe(observation: RateLimitObservation): void {
    const signer = this.#signer;
    const bucket = signerBucketOfObservation(observation);
    if (signer === null || bucket === null) {
      this.#notes.push("a rate-limit observation named no signer bucket of this process; it was not applied");
      return;
    }
    const result = this.#budget.observeSignerFeedback({ signer, bucket }, feedbackFromObservation(observation), this.#clock.nowMs());
    if (result.ok) this.#effects.push(...result.value);
    else this.#notes.push(`the budget refused an observation: ${result.refusal.code}`);
  }

  #tier(config: RateLimitConfiguration): RateLimitConfiguration["signerTiers"][number] | undefined {
    const known = this.#signer === null ? undefined : this.#budget.view(this.#clock.nowMs()).signers.find((entry) => entry.signer === this.#signer)?.tier;
    return config.signerTiers.find((entry) => entry.tier === known) ?? config.signerTiers.find((entry) => entry.tier === config.policy.assumedSignerTier);
  }

  #cancelLevelMilli(): number {
    if (this.#signer === null) return 0;
    const view = this.#budget.view(this.#clock.nowMs()).signers.find((entry) => entry.signer === this.#signer);
    if (view === undefined) return 0;
    // The view's exact decimal token text, back to thousandths.
    const match = /^(-?)([0-9]+)(?:\.([0-9]{1,3}))?$/u.exec(view.cancel.tokens);
    if (match === null) return 0;
    const milli = Number(match[2]) * MILLI + Number((match[3] ?? "").padEnd(3, "0") || "0");
    return match[1] === "-" ? -milli : milli;
  }

  /**
   * The largest `DELETE /orders` batch the budget can ever admit now: the
   * cancel bucket's burst minus the emergency class's headroom, in the
   * operation's token cost; at most WP-260's `MAX_CANCEL_IDS_PER_REQUEST`.
   */
  batchCapacity(): BatchCapacity | { readonly problem: string } {
    const config = this.configuration();
    if (config === undefined) return { problem: "no rate-limit snapshot is in effect" };
    const operation = config.operations.find((entry) => entry.operationId === EMERGENCY_OPERATIONS.CANCEL_ORDERS);
    if (operation === undefined || operation.signerBucket !== "CANCEL" || operation.tokenCost === null) {
      return { problem: `the snapshot defines no cancel-bucket operation ${EMERGENCY_OPERATIONS.CANCEL_ORDERS}` };
    }
    const tier = this.#tier(config);
    if (tier === undefined) return { problem: "the snapshot defines no tier for this signer" };
    const permille = config.policy.headroomPermille[CANCEL_PRIORITY];
    const capacityMilli = tier.cancelBurst * MILLI;
    const usableMilli = capacityMilli - Math.floor((capacityMilli * permille) / PER_MILLE);
    const { base, perEntry } = operation.tokenCost;
    const byBucket = perEntry === 0 ? MAX_CANCEL_IDS_PER_REQUEST : Math.floor((usableMilli - base * MILLI) / (perEntry * MILLI));
    const maxEntries = Math.max(0, Math.min(byBucket, MAX_CANCEL_IDS_PER_REQUEST));
    return { tier: tier.tier, cancelBurst: tier.cancelBurst, headroomPermille: permille, maxEntries };
  }

  /**
   * The D-21 plan of a cancel-all, before it is sent: when it is granted, the
   * local level after the venue debits `listed` orders, and how long a sweep
   * batch would then wait. An estimate over THIS process's budget; the venue's
   * own balance is shared with the trader and may be lower.
   */
  cancelDebtPlan(listed: number | null, sweepEntries: number): CancelDebtPlan | { readonly problem: string } {
    const config = this.configuration();
    if (config === undefined) return { problem: "no rate-limit snapshot is in effect" };
    const cancelAll = config.operations.find((entry) => entry.operationId === EMERGENCY_OPERATIONS.CANCEL_ALL);
    const batch = config.operations.find((entry) => entry.operationId === EMERGENCY_OPERATIONS.CANCEL_ORDERS);
    if (cancelAll?.tokenCost == null) return { problem: `the snapshot defines no cancel-bucket operation ${EMERGENCY_OPERATIONS.CANCEL_ALL}` };
    const tier = this.#tier(config);
    if (tier === undefined) return { problem: "the snapshot defines no tier for this signer" };
    const rate = tier.cancelTokensPerSecond; // thousandths of a token per millisecond
    const capacityMilli = tier.cancelBurst * MILLI;
    const headroomMilli = Math.floor((capacityMilli * config.policy.headroomPermille[CANCEL_PRIORITY]) / PER_MILLE);
    const levelNow = this.#cancelLevelMilli();
    const costMilli = cancelAll.tokenCost.base * MILLI;
    const needed = costMilli + headroomMilli;
    const firstGrantWaitMs = levelNow >= needed ? 0 : Math.ceil((needed - levelNow) / rate);
    // Granted at the earliest instant: the level then stands at `needed`, and the grant takes its cost.
    const afterGrant = Math.max(levelNow, needed) - costMilli;
    let levelAfterDebit: number | null = null;
    let sweepWaitMs: number | null = null;
    if (listed !== null) {
      const debit = listed * cancelAll.tokenCost.perCanceled * MILLI;
      levelAfterDebit = tier.negativeCancelBalance ? afterGrant - debit : afterGrant >= 0 ? Math.max(afterGrant - debit, 0) : afterGrant;
      if (batch?.tokenCost != null && sweepEntries > 0) {
        const sweepNeed = (batch.tokenCost.base + batch.tokenCost.perEntry * sweepEntries) * MILLI + headroomMilli;
        sweepWaitMs = levelAfterDebit >= sweepNeed ? 0 : Math.ceil((sweepNeed - levelAfterDebit) / rate);
      }
    }
    return {
      tier: tier.tier,
      cancelBurst: tier.cancelBurst,
      cancelTokensPerSecond: tier.cancelTokensPerSecond,
      negativeCancelBalance: tier.negativeCancelBalance,
      levelNow: tokensText(levelNow),
      firstGrantWaitMs,
      assumedCanceled: listed,
      levelAfterDebit: levelAfterDebit === null ? null : tokensText(levelAfterDebit),
      sweepWaitMs,
      sweepEntries,
    };
  }

  /** The cancel bucket as the budget sees it now, for the report. */
  cancelBucketText(): string | null {
    if (this.#signer === null) return null;
    const view = this.#budget.view(this.#clock.nowMs()).signers.find((entry) => entry.signer === this.#signer);
    if (view === undefined) return null;
    return `tier ${view.tier}: cancel bucket ${view.cancel.tokens} of ${String(view.cancel.capacity)} tokens (refill ${String(view.cancel.tokensPerSecond)}/s)${view.cancel.blockedUntilMs === null ? "" : `, blocked until ${new Date(view.cancel.blockedUntilMs).toISOString()}`}`;
  }
}
