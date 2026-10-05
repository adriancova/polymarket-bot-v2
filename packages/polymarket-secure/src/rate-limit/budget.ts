/**
 * Local rate-limit budgets (WP-310 deliverable 1; handoff §9.13; §6
 * invariant 13; ADR-007 §9).
 *
 * ## The budgets (§9.13 "Maintain separate budgets by")
 *
 * | §9.13 dimension | Here | Model |
 * | --- | --- | --- |
 * | IP endpoint class | `IP_ENDPOINT_CLASS` per configured class | sliding windows (one or more per class: a burst and a sustained limit) |
 * | signer + order bucket | `SIGNER_ORDER_BUCKET` per signer address | token bucket: the signer's tier's order rate and burst |
 * | signer + cancel bucket | `SIGNER_CANCEL_BUCKET` per signer address | token bucket: the tier's cancel rate and burst; may run into debt on tiers that allow a negative cancel balance (D-21) |
 * | relayer bucket | `RELAYER` | sliding windows |
 *
 * Each signer has its own pair of buckets ("separate order and cancel
 * buckets per signer address", venue report §8); activity in one never draws
 * on the other. A request charges every budget its configured operation
 * names, all or nothing: one request per IP class and relayer window, and its
 * token cost in its signer bucket ("a batch is admitted only when the bucket
 * contains enough tokens for every entry", §8).
 *
 * Every number (limits, windows, rates, bursts, costs, headroom, backoff,
 * bounds) comes from the configuration snapshot in effect at the instant in
 * question (`configuration.ts`). A snapshot takes effect at exactly its
 * `effectiveFrom`: token refill is computed segment by segment, each segment
 * under the snapshot in effect during it, and a bucket is capped at the burst
 * in effect at every instant it is read (a lowered burst binds from its
 * effective millisecond, not from the next refill). A window counts the
 * requests granted within it; the budget keeps every grant instant the
 * longest window on its timeline can still count, and refuses a snapshot
 * whose windows would reach back past history it has already dropped
 * (`HISTORY_NOT_RETAINED`): missing history is never read as free capacity.
 *
 * ## The grant order (§9.13 "Priority order")
 *
 * Requests that cannot be granted at once wait in ONE queue, ranked by the
 * §9.13 ladder (`priority.ts`) and, within a class, first come first served.
 * `poll()` walks the queue in rank order:
 *
 * - a waiter is granted when every budget it draws on can pay its cost AFTER
 *   setting aside (a) the costs of every higher-ranked waiter still waiting on
 *   that budget, and (b) its own class's headroom on that budget;
 * - a waiter that cannot be granted RESERVES its cost on every budget it
 *   draws on, so no lower-ranked waiter can take the capacity it is waiting
 *   for. An emergency cancel waiting on its cancel bucket (say, in debt after
 *   a cancel-all) holds its own cost on that bucket and on every IP class it
 *   draws on: a stale-quote cancel or a new order may still use capacity
 *   beyond that cost, never the cost itself, and a request that shares no
 *   budget with it is not affected at all. A waiter held back by a WAIT (a
 *   429 on its operation or its signer bucket) reserves too, for the whole
 *   wait: a lower class that shares a budget with it, a safety class
 *   included, may be queued by that reservation, and is granted as soon as
 *   the capacity beyond it allows (see `nextWakeAtMs`).
 *
 * `request()` grants at once only on the same terms: every waiter ranked
 * above the new request reserves its cost first. A lower class can never
 * take capacity a higher class is waiting for, and with headroom configured
 * it cannot drain the last of a budget before a higher class arrives.
 *
 * `nextWakeAtMs()` predicts on the same terms: each waiter's earliest grant
 * is computed net of the reservations of every waiter ranked above it, so a
 * timer set from it never sleeps through a grant that `poll()` would make.
 *
 * ## Feedback
 *
 * `complete()` closes a grant with what the venue answered: the mapped error
 * (WP-260's `SecureVenueError` fields), the parsed headers (`headers.ts`) and,
 * for cancel-all / cancel-market-orders, the number of orders canceled.
 * `observeSignerFeedback()` takes WP-260's `onRateLimitUpdate` observations.
 * An observation carries no request identity: any grant outstanding on its
 * bucket when it arrives may be the request it answers, and it may also be
 * the late answer to a grant already completed. What each documented header
 * does is in `#applyFeedback`.
 *
 * - **A reported balance is a cap, charged only with what came after it.**
 *   `Poly-RateLimit-Remaining` (and `Poly-RateLimit-Warning`: a balance below
 *   the request's cost) is the venue's balance after accounting one request,
 *   so an upper bound on the bucket. It is applied the moment it arrives.
 *   From then on it is charged with every request granted after it arrived
 *   and with the post-hoc debit of every cancel-all granted after it
 *   arrived, never with the post-hoc debit of a cancel-all that was already
 *   outstanding when it arrived: it may be that cancel-all's own answer,
 *   which includes it. The local estimate is charged with everything, and the
 *   bucket's level is the lower of the two. Each response's balance and each
 *   debit therefore count once, however many grants overlap and in whatever
 *   order their answers (late ones included) arrive.
 * - **One wait per response.** A 429's wait is resolved once: its
 *   `Retry-After` exactly; else a later `Poly-RateLimit-Reset` (bounded);
 *   else the snapshot's fallback backoff. A wait that an observation sets
 *   while grants are outstanding on its bucket is PENDING on those grants
 *   (any of them may be its request). When one of them completes with a 429,
 *   every pending wait it may be the source of is withdrawn and the
 *   completion's own wait applies, so no header of the same response
 *   lengthens it: the pinned SDK reports a response's headers before the
 *   call settles, so that response's observation is always pending on its
 *   grant when the grant completes (provided the composition completes a
 *   grant only after its call settles). A pending wait whose grants all
 *   complete without a 429 stays, and so does every wait of a response that
 *   cannot be this one (an observation that arrived while the grant was not
 *   outstanding, or another completion's).
 * - **Whose wait.** A 429 on a request that drew on a signer bucket is the
 *   per-signer limiter's ("`Retry-After` on 429", §8): that bucket waits. A
 *   429 on a request that drew on no signer bucket is documented nowhere
 *   (IP limits throttle rather than reject, `IP_THROTTLED`): it holds back
 *   only that OPERATION, for the request's own class and the classes ranked
 *   below it. It never blocks an IP class, so it can never hold back a
 *   heartbeat, an emergency cancel or any other operation (a lower class
 *   never starves a higher one, §9.13).
 *
 * ## Time
 *
 * No clock is read: every call takes `atMs`, Unix epoch milliseconds, from the
 * caller. A time earlier than one already seen is read as the latest seen
 * (no refill is invented, no block is shortened).
 *
 * Exactness: token levels are integers of thousandths of a token
 * (`units.ts`). Every configured token figure is at most
 * `MAX_TOKEN_MAGNITUDE`, every configured duration at most
 * `MAX_DURATION_MS`, every level at most `MAX_TOKEN_MAGNITUDE` tokens either
 * side of zero, every `Retry-After` at most WP-260's bound, and every instant
 * at most `MAX_EPOCH_MS`; so every level, cost, headroom and deadline derived
 * from them is an exact safe integer. A figure beyond those bounds is
 * refused, never rounded.
 *
 * Nothing here performs I/O, holds a credential, or retries anything: it
 * only says when a request may be sent. PAPER only.
 */

import { MAX_RETRY_AFTER_SECONDS } from "../errors.js";

import {
  parseRateLimitConfiguration,
  PER_MILLE,
  RateLimitConfigurationTimeline,
  type OperationConfig,
  type RateLimitConfiguration,
  type SignerBucket,
  type SlidingWindowLimit,
} from "./configuration.js";
import { HTTP_TOO_MANY_REQUESTS, type FeedbackFlag, type RateLimitFeedback } from "./headers.js";
import { isEpochMs, isIntegerAtLeast, readList, readOwn } from "./plain-data.js";
import { isPermittedPriority, isPriorityClass, PRIORITY_LADDER, priorityRank, type PriorityClass } from "./priority.js";
import { isExactLevelMilli, isExactTokenCount, MILLI_PER_TOKEN, MS_PER_SECOND } from "./units.js";

const SIGNER = /^0x[0-9a-fA-F]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;

// ---------------------------------------------------------------------------
// Public types.

export interface BudgetRequest {
  /** An `operationId` of the snapshot in effect. */
  readonly operationId: string;
  readonly priority: PriorityClass;
  /** The signer address; required exactly when the operation draws on a signer bucket. */
  readonly signer?: string;
  /** Batch size (orders) or id count (batch cancel); required exactly when the operation's token cost has `perEntry`. */
  readonly entries?: number;
}

export type BudgetDimension = "IP_ENDPOINT_CLASS" | "SIGNER_ORDER_BUCKET" | "SIGNER_CANCEL_BUCKET" | "RELAYER";

export type BudgetKeyView =
  | { readonly dimension: "IP_ENDPOINT_CLASS"; readonly classId: string }
  | { readonly dimension: "SIGNER_ORDER_BUCKET"; readonly signer: string }
  | { readonly dimension: "SIGNER_CANCEL_BUCKET"; readonly signer: string }
  | { readonly dimension: "RELAYER" };

/** One budget a request draws on, and what it costs there (requests for a window, tokens for a bucket). */
export interface Charge {
  readonly budget: BudgetKeyView;
  readonly cost: number;
}

export interface Grant {
  readonly grantId: string;
  readonly ticketId: string;
  readonly operationId: string;
  readonly priority: PriorityClass;
  readonly signer: string | null;
  readonly entries: number | null;
  readonly charges: readonly Charge[];
  readonly grantedAtMs: number;
  readonly snapshotId: string;
}

export type BudgetRefusalCode =
  | "INVALID_TIME"
  | "INVALID_REQUEST"
  | "NO_ACTIVE_CONFIGURATION"
  | "UNKNOWN_OPERATION"
  | "PRIORITY_NOT_PERMITTED"
  | "SIGNER_REQUIRED"
  | "SIGNER_NOT_EXPECTED"
  | "ENTRIES_REQUIRED"
  | "ENTRIES_NOT_EXPECTED"
  | "COST_EXCEEDS_CAPACITY"
  | "QUEUE_FULL"
  | "EVICTED_BY_HIGHER_PRIORITY"
  | "UNKNOWN_GRANT"
  | "GRANT_ALREADY_COMPLETED"
  | "INVALID_COMPLETION"
  | "INVALID_CONFIGURATION"
  | "EFFECTIVE_TIME_NOT_IN_FUTURE"
  /** The snapshot's windows would count requests older than the history this budget has kept. */
  | "HISTORY_NOT_RETAINED";

export interface BudgetRefusal {
  readonly code: BudgetRefusalCode;
  readonly message: string;
}

export type RequestDecision =
  | { readonly kind: "GRANTED"; readonly ticketId: string; readonly grant: Grant }
  | { readonly kind: "QUEUED"; readonly ticketId: string }
  | { readonly kind: "REFUSED"; readonly refusal: BudgetRefusal };

export type PollEvent =
  | { readonly kind: "GRANTED"; readonly ticketId: string; readonly grant: Grant }
  /** A queued request that can no longer be granted (evicted, or the snapshot now in effect no longer admits it). */
  | { readonly kind: "REFUSED"; readonly ticketId: string; readonly refusal: BudgetRefusal };

/** What the venue answered a granted request. */
export interface GrantCompletion {
  readonly atMs: number;
  /** WP-260's `SecureVenueError` fields when the request failed (`kind`, `retryAfterSeconds`); `null` on success. */
  readonly error?: { readonly kind: string; readonly retryAfterSeconds: number | null } | null;
  /** The answer's documented rate-limit headers (`parseRateLimitHeaders` / `feedbackFromObservation`). */
  readonly feedback?: RateLimitFeedback | null;
  /** cancel-all / cancel-market-orders: how many orders the venue reports canceled. */
  readonly canceledCount?: number | null;
}

export type WaitBasis = "RETRY_AFTER" | "RESET" | "FALLBACK";

export type BudgetEffect =
  | { readonly kind: "REMAINING_APPLIED"; readonly budget: BudgetKeyView; readonly tokens: string }
  | { readonly kind: "TIER_APPLIED"; readonly signer: string; readonly tier: string }
  | { readonly kind: "TIER_UNRECOGNISED"; readonly signer: string; readonly fallbackTier: string }
  | { readonly kind: "WARNING_MODE"; readonly budget: BudgetKeyView }
  /** A signer bucket waits until `untilMs`. */
  | { readonly kind: "WAIT_APPLIED"; readonly budget: BudgetKeyView; readonly untilMs: number; readonly basis: WaitBasis }
  /** A 429 on a request with no signer bucket: that operation waits, for `priorities` only (the request's class and those below it). */
  | {
      readonly kind: "OPERATION_WAIT_APPLIED";
      readonly operationId: string;
      readonly priorities: readonly PriorityClass[];
      readonly untilMs: number;
      readonly basis: WaitBasis;
    }
  | { readonly kind: "RESET_WAIT_CAPPED"; readonly budget: BudgetKeyView | null }
  /**
   * The balance just reported arrived while these cancel-all grants were outstanding: it may already include
   * their post-hoc debit, so that debit is never charged to it again (the local estimate still takes it).
   */
  | { readonly kind: "BALANCE_MAY_INCLUDE_DEBIT"; readonly budget: BudgetKeyView; readonly grantIds: readonly string[] }
  /** An observation's wait, pending on the grants outstanding when it arrived: a 429 completing one of them withdraws it. */
  | { readonly kind: "WAIT_PENDING"; readonly budget: BudgetKeyView; readonly untilMs: number; readonly basis: WaitBasis; readonly grantIds: readonly string[] }
  /** A pending wait withdrawn by a 429 completion that may be its response: that response's one wait is the completion's. */
  | { readonly kind: "PENDING_WAIT_WITHDRAWN"; readonly budget: BudgetKeyView; readonly untilMs: number; readonly basis: WaitBasis }
  | { readonly kind: "CANCELED_DEBITED"; readonly budget: BudgetKeyView; readonly tokens: number }
  | { readonly kind: "CANCELED_COUNT_UNKNOWN"; readonly budget: BudgetKeyView }
  | { readonly kind: "CANCELED_COUNT_NOT_APPLICABLE" }
  | { readonly kind: "FEEDBACK_WITHOUT_SIGNER_BUCKET" }
  | { readonly kind: "FEEDBACK_FLAG"; readonly flag: FeedbackFlag };

export type BudgetResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: BudgetRefusal };

export interface WindowView {
  readonly limit: number;
  readonly windowMs: number;
  readonly used: number;
}

export interface WindowBudgetView {
  readonly budget: BudgetKeyView;
  readonly windows: readonly WindowView[];
}

/** An operation held back by a 429 on a request with no signer bucket, for one class. */
export interface OperationWaitView {
  readonly operationId: string;
  readonly priority: PriorityClass;
  readonly untilMs: number;
}

export interface BucketView {
  readonly budget: BudgetKeyView;
  /** The local estimate, an exact decimal string of tokens (may be negative: cancel debt). */
  readonly tokens: string;
  readonly capacity: number;
  readonly tokensPerSecond: number;
  readonly blockedUntilMs: number | null;
  readonly warnings: number;
}

export interface BudgetView {
  readonly atMs: number;
  readonly snapshotId: string | null;
  readonly ipEndpointClasses: readonly WindowBudgetView[];
  readonly relayer: WindowBudgetView | null;
  readonly signers: readonly { readonly signer: string; readonly tier: string; readonly order: BucketView; readonly cancel: BucketView }[];
  readonly queue: readonly { readonly ticketId: string; readonly operationId: string; readonly priority: PriorityClass; readonly signer: string | null }[];
  readonly operationWaits: readonly OperationWaitView[];
}

// ---------------------------------------------------------------------------
// Internal state.

/** A reported balance held apart from the post-hoc debits it may already include. */
interface BalanceCap {
  /** Thousandths of a token: charged with every later grant and every post-hoc debit except those of `exempt`. */
  milli: number;
  /** The cancel-all grants outstanding when the balance arrived. Never empty: an empty one rejoins the estimate. */
  readonly exempt: Set<GrantRecord>;
}

/** A wait an observation set while grants were outstanding on its bucket (any of them may be its request). */
interface PendingWait {
  untilMs: number;
  basis: WaitBasis;
  /** Never empty: a wait with no candidate left is an ordinary one. */
  readonly candidates: Set<GrantRecord>;
}

interface BucketState {
  /** The local estimate, thousandths of a token: charged with every grant and every post-hoc debit. */
  levelMilli: number;
  /** Reported balances still exempt from an outstanding post-hoc debit; each is below `levelMilli`. */
  caps: BalanceCap[];
  lastMs: number;
  /** The waits of responses known to be this bucket's (a completion, or an observation with no grant outstanding). */
  blockedUntilMs: number;
  /** The waits of observations that a 429 completing one of their candidate grants may withdraw. */
  pending: PendingWait[];
  fallbackCount: number;
  warnings: number;
}

interface SignerState {
  readonly signer: string;
  tier: string;
  readonly order: BucketState;
  readonly cancel: BucketState;
}

interface WindowState {
  /** Grant instants, ascending (one entry per request). */
  readonly times: number[];
}

interface OperationWaitState {
  /** By §9.13 rank: until when requests of that class for this operation wait (a 429 with no signer bucket). */
  readonly untilByRank: number[];
  fallbackCount: number;
}

interface NormalizedRequest {
  readonly operationId: string;
  readonly priority: PriorityClass;
  readonly signer: string | null;
  readonly entries: number | null;
}

interface Waiter {
  readonly ticketId: string;
  readonly seq: number;
  readonly request: NormalizedRequest;
}

type InternalCharge =
  | { readonly type: "WINDOW"; readonly key: string; readonly view: BudgetKeyView; readonly windows: readonly SlidingWindowLimit[]; readonly cost: number }
  | {
      readonly type: "BUCKET";
      readonly key: string;
      readonly view: BudgetKeyView;
      readonly signer: string;
      readonly bucket: SignerBucket;
      /** Tokens. */
      readonly cost: number;
    };

interface GrantRecord {
  readonly grant: Grant;
  readonly operation: OperationConfig;
  readonly charges: readonly InternalCharge[];
  /** The signer-bucket charge, if the request drew on one. */
  readonly bucket: Extract<InternalCharge, { type: "BUCKET" }> | null;
  /** Whether the operation is debited per canceled order after its answer (cancel-all, cancel-market-orders). */
  readonly postHocDebit: boolean;
  /**
   * The latest SDK observation that arrived while this grant was outstanding: the pinned SDK reports a
   * response's headers just before the call settles, so at completion it is this grant's own response unless
   * another answer arrived in between. A 429 completion with neither `Retry-After` nor its own feedback reads
   * its `Poly-RateLimit-Reset` (and its documented 429 `Retry-After`) from it.
   */
  latestObservation: RateLimitFeedback | null;
}

/** How a response's headers may set a wait (`#applyFeedback`). */
type WaitContext =
  /** A completion whose 429 wait is already resolved: no header of the response sets another. */
  | "RESOLVED"
  /** A completion that was not a 429: a later Reset is a wait only in a wait period (a balance below zero). */
  | "ANSWER"
  /** An SDK observation: as ANSWER, but with the documented 429 status its Retry-After, else its later Reset, is the wait. */
  | "OBSERVATION";

/** Where a response's headers came from, for what they may be charged with and whose 429 may withdraw their wait. */
interface FeedbackOrigin {
  /** The cancel-all grants outstanding on the bucket when it arrived: its balance may include their debit. */
  readonly exempt: ReadonlySet<GrantRecord>;
  /** The grants that may be its request (empty: it is known to be the bucket's, and its wait is ordinary). */
  readonly candidates: ReadonlySet<GrantRecord>;
}

/** Scratch availability during one planning pass. */
type Availability =
  | { readonly type: "WINDOW"; readonly free: number[]; readonly limits: readonly number[] }
  | { readonly type: "BUCKET"; readonly blocked: boolean; free: number; readonly capacityMilli: number };

function freezeRefusal(code: BudgetRefusalCode, message: string): BudgetRefusal {
  return Object.freeze({ code, message });
}

function refused(code: BudgetRefusalCode, message: string): { readonly kind: "REFUSED"; readonly refusal: BudgetRefusal } {
  return Object.freeze({ kind: "REFUSED" as const, refusal: freezeRefusal(code, message) });
}

function failure<T>(code: BudgetRefusalCode, message: string): BudgetResult<T> {
  return Object.freeze({ ok: false as const, refusal: freezeRefusal(code, message) });
}

/** Thousandths of a token as an exact decimal string. */
function tokensText(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const magnitude = Math.abs(milli);
  const whole = Math.floor(magnitude / MILLI_PER_TOKEN);
  const fraction = magnitude - whole * MILLI_PER_TOKEN;
  if (fraction === 0) return `${sign}${String(whole)}`;
  const digits = String(MILLI_PER_TOKEN).length - 1;
  return `${sign}${String(whole)}.${String(fraction).padStart(digits, "0").replace(/0+$/u, "")}`;
}

/** `capacity` scaled by a per-mille share, rounded down: the headroom a class must leave. */
function headroomOf(capacity: number, permille: number): number {
  return Math.floor((capacity * permille) / PER_MILLE);
}

/** A bucket's level after `ms` of refill at `rate` tokens/s, capped at `capacityMilli`. Exact integers. */
function refill(levelMilli: number, rate: number, capacityMilli: number, ms: number): number {
  if (levelMilli >= capacityMilli) return levelMilli;
  const deficit = capacityMilli - levelMilli;
  if (ms >= Math.ceil(deficit / rate)) return capacityMilli;
  return levelMilli + rate * ms;
}

/** `initialMs × multiplier^count`, capped; never computes a product above the cap (every step stays exact). */
function backoffDelay(policy: { readonly initialMs: number; readonly multiplier: number; readonly capMs: number }, count: number): number {
  let delay = Math.min(policy.initialMs, policy.capMs);
  for (let step = 0; step < count && delay < policy.capMs; step += 1) {
    delay = delay > policy.capMs / policy.multiplier ? policy.capMs : delay * policy.multiplier;
  }
  return delay;
}

/** What may be spent: the local estimate, capped by every reported balance still held apart from a debit. */
function levelOf(state: BucketState): number {
  let level = state.levelMilli;
  for (const cap of state.caps) level = Math.min(level, cap.milli);
  return level;
}

/** Until when the bucket waits: its ordinary waits and its pending ones. */
function blockedUntilOf(state: BucketState): number {
  let until = state.blockedUntilMs;
  for (const wait of state.pending) until = Math.max(until, wait.untilMs);
  return until;
}

/**
 * Apply a monotone change (a refill, a burst, a charge every balance must take) to the estimate and to every
 * held balance. A held balance at or above the estimate can never bind again (every change keeps it there),
 * so it is dropped.
 */
function changeLevels(state: BucketState, change: (milli: number) => number): void {
  state.levelMilli = change(state.levelMilli);
  for (const cap of state.caps) cap.milli = change(cap.milli);
  state.caps = state.caps.filter((cap) => cap.milli < state.levelMilli);
}

function sameMembers<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const member of a) if (!b.has(member)) return false;
  return true;
}

function grantIdsOf(records: ReadonlySet<GrantRecord>): readonly string[] {
  return Object.freeze([...records].map((record) => record.grant.grantId));
}

function bucketParams(
  config: RateLimitConfiguration,
  tier: string,
  bucket: SignerBucket,
): { readonly rate: number; readonly capacityMilli: number; readonly negativeAllowed: boolean } {
  const found =
    config.signerTiers.find((entry) => entry.tier === tier) ??
    config.signerTiers.find((entry) => entry.tier === config.policy.assumedSignerTier);
  if (found === undefined) throw new TypeError("a validated snapshot always declares its assumed tier");
  return bucket === "ORDER"
    ? { rate: found.orderTokensPerSecond, capacityMilli: found.orderBurst * MILLI_PER_TOKEN, negativeAllowed: false }
    : { rate: found.cancelTokensPerSecond, capacityMilli: found.cancelBurst * MILLI_PER_TOKEN, negativeAllowed: found.negativeCancelBalance };
}

/** First index of `times` (ascending) whose value is strictly greater than `bound`. */
function firstAfter(times: readonly number[], bound: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((times[middle] ?? 0) > bound) high = middle;
    else low = middle + 1;
  }
  return low;
}

// ---------------------------------------------------------------------------
// The budget.

export class RateLimitBudget {
  #timeline: RateLimitConfigurationTimeline;
  #lastMs = 0;
  #seq = 0;
  #grantCounter = 0;
  readonly #signers = new Map<string, SignerState>();
  readonly #windows = new Map<string, WindowState>();
  readonly #operationWaits = new Map<string, OperationWaitState>();
  /** Per signer bucket: the grants issued and not yet completed, in grant order. */
  readonly #outstanding = new Map<string, GrantRecord[]>();
  /** The latest grant instant dropped from any window's history (`null`: none dropped yet). */
  #droppedThroughMs: number | null = null;
  #queue: Waiter[] = [];
  #pending: PollEvent[] = [];
  readonly #issued = new WeakMap<Grant, GrantRecord>();
  readonly #completed = new WeakSet<Grant>();

  private constructor(timeline: RateLimitConfigurationTimeline) {
    this.#timeline = timeline;
  }

  /**
   * A budget over one or more snapshot documents (each validated by
   * `parseRateLimitConfiguration`). Refuses if any document is invalid or two
   * share an id or an effective time.
   */
  static create(configurations: readonly unknown[]): BudgetResult<RateLimitBudget> {
    let timeline = RateLimitConfigurationTimeline.empty();
    const documents = Array.isArray(configurations) ? configurations : [];
    if (documents.length === 0) return failure("INVALID_CONFIGURATION", "at least one configuration snapshot is required");
    for (const raw of documents) {
      const parsed = parseRateLimitConfiguration(raw);
      if (!parsed.ok) return failure("INVALID_CONFIGURATION", parsed.problems.join("; "));
      const next = timeline.with(parsed.value);
      if (!next.ok) return failure("INVALID_CONFIGURATION", next.problem);
      timeline = next.value;
    }
    return Object.freeze({ ok: true as const, value: new RateLimitBudget(timeline) });
  }

  /**
   * Add a snapshot that takes effect LATER than every instant this budget has
   * already processed (a retroactive change would rewrite history it has
   * already acted on), and late enough that every window it declares counts
   * only requests whose history is still kept: a window longer than any on
   * the timeline so far could otherwise reach back past dropped history and
   * read it as unused capacity.
   */
  addConfiguration(raw: unknown): BudgetResult<{ readonly snapshotId: string; readonly effectiveFromMs: number }> {
    const parsed = parseRateLimitConfiguration(raw);
    if (!parsed.ok) return failure("INVALID_CONFIGURATION", parsed.problems.join("; "));
    if (parsed.value.effectiveFromMs <= this.#lastMs) {
      return failure("EFFECTIVE_TIME_NOT_IN_FUTURE", "a new snapshot must take effect after every instant already processed");
    }
    // A window counts the grants strictly after `effectiveFrom - windowMs`; none of those may have been dropped.
    const reach = longestWindowMs(parsed.value);
    if (this.#droppedThroughMs !== null && parsed.value.effectiveFromMs - reach < this.#droppedThroughMs) {
      return failure(
        "HISTORY_NOT_RETAINED",
        `its longest window would count requests this budget no longer holds: take effect at ${String(this.#droppedThroughMs + reach)} or later`,
      );
    }
    const next = this.#timeline.with(parsed.value);
    if (!next.ok) return failure("INVALID_CONFIGURATION", next.problem);
    this.#timeline = next.value;
    return Object.freeze({ ok: true as const, value: Object.freeze({ snapshotId: parsed.value.snapshotId, effectiveFromMs: parsed.value.effectiveFromMs }) });
  }

  /** The snapshot in effect at `atMs` (no state change). */
  configurationAt(atMs: number): RateLimitConfiguration | undefined {
    return isEpochMs(atMs) ? this.#timeline.activeAt(atMs) : undefined;
  }

  // -------------------------------------------------------------------------
  // Requests.

  /**
   * Ask to send one request. GRANTED: send it now (its costs are already
   * debited). QUEUED: wait for a `poll()` that grants its ticket. REFUSED:
   * never send it as asked (e.g. a batch whose cost exceeds the bucket's burst
   * can never be admitted: split it).
   */
  request(input: BudgetRequest, atMs: number): RequestDecision {
    const t = this.#time(atMs);
    if (t === undefined) return refused("INVALID_TIME", "atMs must be a non-negative safe integer of epoch milliseconds");
    const config = this.#timeline.activeAt(t);
    if (config === undefined) return refused("NO_ACTIVE_CONFIGURATION", "no rate-limit snapshot is in effect at this instant");
    const request = normalizeRequest(input);
    if (request === undefined) return refused("INVALID_REQUEST", "the request is not an own-data { operationId, priority, signer?, entries? }");
    const resolved = this.#resolve(request, config);
    if (!resolved.ok) return Object.freeze({ kind: "REFUSED" as const, refusal: resolved.refusal });

    this.#seq += 1;
    const waiter: Waiter = Object.freeze({ ticketId: `ticket-${String(this.#seq)}`, seq: this.#seq, request });
    // Every waiter ranked above the newcomer reserves its cost first.
    const reserved = new Map<string, number>();
    const availability = new Map<string, Availability>();
    for (const above of this.#ranked()) {
      if (compareWaiters(above, waiter) > 0) continue;
      const charges = this.#resolve(above.request, config);
      if (charges.ok) for (const charge of charges.value) reserved.set(charge.key, (reserved.get(charge.key) ?? 0) + reservationOf(charge));
    }
    if (this.#operationWaitUntil(request) <= t && this.#affordable(resolved.value, request.priority, config, t, availability, reserved)) {
      const grant = this.#commit(waiter, resolved.value, config, t);
      return Object.freeze({ kind: "GRANTED" as const, ticketId: waiter.ticketId, grant });
    }

    if (this.#queue.length >= config.policy.maxQueuedRequests) {
      const ranked = this.#ranked();
      const lowest = ranked[ranked.length - 1];
      if (lowest === undefined || priorityRank(lowest.request.priority) <= priorityRank(request.priority)) {
        return refused("QUEUE_FULL", "the queue is full of requests that rank at or above this one");
      }
      // A higher class never waits behind a full queue of lower ones: the lowest-ranked waiter makes room.
      this.#queue = this.#queue.filter((entry) => entry !== lowest);
      this.#pending.push(
        Object.freeze({
          kind: "REFUSED" as const,
          ticketId: lowest.ticketId,
          refusal: freezeRefusal("EVICTED_BY_HIGHER_PRIORITY", "evicted from a full queue by a higher-ranked request"),
        }),
      );
    }
    this.#queue.push(waiter);
    return Object.freeze({ kind: "QUEUED" as const, ticketId: waiter.ticketId });
  }

  /** Withdraw a queued request (e.g. the order it was for was abandoned). `true` when it was queued. */
  withdraw(ticketId: string): boolean {
    const before = this.#queue.length;
    this.#queue = this.#queue.filter((waiter) => waiter.ticketId !== ticketId);
    return this.#queue.length !== before;
  }

  /**
   * Grant every queued request that may now be sent, in §9.13 order, and
   * report queued requests that never can be. Events are in grant order.
   */
  poll(atMs: number): readonly PollEvent[] {
    const t = this.#time(atMs);
    const events: PollEvent[] = [...this.#pending];
    this.#pending = [];
    if (t === undefined) return Object.freeze(events);
    const config = this.#timeline.activeAt(t);
    if (config === undefined) return Object.freeze(events);
    const plan = this.#plan(config, t);
    for (const refusal of plan.refusals) {
      this.#queue = this.#queue.filter((waiter) => waiter !== refusal.waiter);
      events.push(Object.freeze({ kind: "REFUSED" as const, ticketId: refusal.waiter.ticketId, refusal: refusal.refusal }));
    }
    for (const item of plan.grants) {
      this.#queue = this.#queue.filter((waiter) => waiter !== item.waiter);
      const grant = this.#commit(item.waiter, item.charges, config, t);
      events.push(Object.freeze({ kind: "GRANTED" as const, ticketId: item.waiter.ticketId, grant }));
    }
    return Object.freeze(events);
  }

  /**
   * The earliest instant at which a `poll()` could grant something (`atMs`
   * itself when one would grant now), or `null` with nothing queued. Each
   * waiter's earliest grant is computed as `poll()` decides it: net of the
   * cost every waiter ranked above it reserves (a higher waiter keeps its
   * reservation until it is granted, and a grant takes no less than it
   * reserved), its class's headroom, its bucket's waits and its operation's
   * wait. So no `poll()` before this instant grants anything, and a timer set
   * from it never sleeps through a grant. It is a lower bound for the budget
   * as it stands: re-read it after every call that changes the budget
   * (`request`, `withdraw`, `complete`, `observeSignerFeedback`,
   * `addConfiguration`, `poll`); polling then may still grant nothing.
   */
  nextWakeAtMs(atMs: number): number | null {
    const t = this.#time(atMs);
    if (t === undefined || (this.#queue.length === 0 && this.#pending.length === 0)) return null;
    if (this.#pending.length > 0) return t;
    const config = this.#timeline.activeAt(t);
    const change = this.#timeline.nextChangeAfter(t);
    if (config === undefined) return change ?? null;
    const plan = this.#plan(config, t);
    if (plan.grants.length > 0 || plan.refusals.length > 0) return t;
    // Nothing is grantable now, so every waiter waits and reserves, in rank order, exactly as in `#plan`.
    let wake = change ?? Number.POSITIVE_INFINITY;
    const reserved = new Map<string, number>();
    for (const waiter of this.#ranked()) {
      const charges = this.#resolve(waiter.request, config);
      if (!charges.ok) continue;
      let eta = Math.max(t, this.#operationWaitUntil(waiter.request));
      for (const charge of charges.value) eta = Math.max(eta, this.#etaOf(charge, waiter.request.priority, config, t, reserved.get(charge.key) ?? 0));
      if (eta > t) wake = Math.min(wake, eta);
      for (const charge of charges.value) reserved.set(charge.key, (reserved.get(charge.key) ?? 0) + reservationOf(charge));
    }
    return Number.isFinite(wake) ? wake : null;
  }

  // -------------------------------------------------------------------------
  // Feedback.

  /**
   * Close a grant with the venue's answer. Applies, in order:
   *
   * 1. the post-hoc cancel debit (cancel-all / cancel-market-orders, D-21),
   *    charged to the local estimate and to every reported balance that
   *    arrived before this grant, never to one that arrived while it was
   *    outstanding (that balance may already include it: see "Feedback");
   *    the grant is then no longer outstanding, and a balance held apart
   *    from its debit alone rejoins the estimate;
   * 2. a 429's wait, resolved once for the response: every wait pending on
   *    this grant (an observation's that this response may be) is withdrawn
   *    first; any other answer leaves a pending wait in place, and one with
   *    no candidate grant left becomes an ordinary wait;
   * 3. the completion's own documented headers, if it carries them.
   *
   * Each grant completes once.
   */
  complete(grant: Grant, completion: GrantCompletion): BudgetResult<readonly BudgetEffect[]> {
    const record = this.#issued.get(grant);
    if (record === undefined) return failure("UNKNOWN_GRANT", "not a grant this budget issued");
    if (this.#completed.has(grant)) return failure("GRANT_ALREADY_COMPLETED", "this grant was already completed");
    const read = readCompletion(completion);
    if (read === undefined) return failure("INVALID_COMPLETION", "the completion is not an own-data { atMs, error?, feedback?, canceledCount? }");
    const t = this.#time(read.atMs);
    if (t === undefined) return failure("INVALID_TIME", "atMs must be a non-negative safe integer of epoch milliseconds");
    const config = this.#timeline.activeAt(t);
    if (config === undefined) return failure("NO_ACTIVE_CONFIGURATION", "no rate-limit snapshot is in effect at this instant");

    const bucketCharge = record.bucket;
    const signerState = bucketCharge === null ? undefined : this.#signer(bucketCharge.signer, t);
    const state = bucketCharge === null || signerState === undefined ? undefined : this.#bucketState(signerState, bucketCharge.bucket);

    // 1. The post-hoc cancel debit: "the bucket is debited one additional token for every order successfully
    // canceled". Computed before anything changes, so a count too large to account exactly refuses the completion.
    const perCanceled = record.operation.tokenCost?.perCanceled ?? 0;
    let debited: { readonly level: number; readonly caps: readonly number[]; readonly tokens: number } | null = null;
    if (perCanceled > 0 && bucketCharge !== null && signerState !== undefined && state !== undefined && read.canceledCount !== null) {
      this.#advance(signerState, bucketCharge.bucket, t);
      const params = bucketParams(config, signerState.tier, bucketCharge.bucket);
      const tokens = perCanceled * read.canceledCount;
      const debit = tokens * MILLI_PER_TOKEN;
      // Tiers without a negative cancel balance "floor the post-cancel balance at zero regardless of debit size";
      // a balance already below zero (a venue Remaining) is left as it is.
      const charge = (milli: number): number => (params.negativeAllowed ? milli - debit : milli >= 0 ? Math.max(milli - debit, 0) : milli);
      const level = charge(state.levelMilli);
      // A balance that arrived while this grant was outstanding may be its own answer, which includes the debit.
      const caps = state.caps.map((cap) => (cap.exempt.has(record) ? cap.milli : charge(cap.milli)));
      if (!isExactTokenCount(tokens) || !isExactLevelMilli(level) || !caps.every(isExactLevelMilli)) {
        return failure("INVALID_COMPLETION", "the canceled count is too large to account exactly");
      }
      debited = { level, caps, tokens };
    }
    this.#completed.add(grant);

    const effects: BudgetEffect[] = [];
    if (read.canceledCount !== null && perCanceled === 0) effects.push(Object.freeze({ kind: "CANCELED_COUNT_NOT_APPLICABLE" as const }));
    if (perCanceled > 0 && bucketCharge !== null && state !== undefined) {
      if (debited === null) {
        effects.push(Object.freeze({ kind: "CANCELED_COUNT_UNKNOWN" as const, budget: bucketCharge.view }));
      } else {
        state.levelMilli = debited.level;
        debited.caps.forEach((milli, index) => {
          const cap = state.caps[index];
          if (cap !== undefined) cap.milli = milli;
        });
        effects.push(Object.freeze({ kind: "CANCELED_DEBITED" as const, budget: bucketCharge.view, tokens: debited.tokens }));
      }
    }
    // No longer outstanding: no later balance can include this grant's debit unseen, and those held apart from it rejoin.
    this.#release(record);

    // 2. A 429: ONE wait for the response. With a signer bucket, that bucket waits (the per-signer limiter's
    // 429). Without one, only this operation waits, for this class and the classes below it.
    const rateLimited = read.error !== null && read.error.kind === "RATE_LIMITED" ? read.error : null;
    if (rateLimited !== null) {
      if (bucketCharge !== null && signerState !== undefined) {
        // The response's headers: the completion's own, else the latest observation that arrived while this grant
        // was outstanding (the pinned SDK reports them just before the call settles).
        const source = read.feedback ?? record.latestObservation;
        const headerRetry = source !== null && source.httpStatus === HTTP_TOO_MANY_REQUESTS ? source.retryAfterSeconds : null;
        effects.push(...this.#bucketRateLimited(signerState, bucketCharge, record, rateLimited.retryAfterSeconds ?? headerRetry, source, config, t));
      } else {
        const headerRetry = read.feedback !== null && read.feedback.httpStatus === HTTP_TOO_MANY_REQUESTS ? read.feedback.retryAfterSeconds : null;
        effects.push(...this.#operationRateLimited(grant.operationId, grant.priority, rateLimited.retryAfterSeconds ?? headerRetry, read.feedback, config, t));
      }
    } else {
      // Not a 429: a wait pending on this grant is not this response's 429 wait; it stays for its other candidates.
      if (state !== undefined) this.#settlePending(state, record);
      if (read.error === null) {
        // A request the venue answered without a 429 ends the consecutive-fallback run on what it drew on.
        if (state !== undefined) state.fallbackCount = 0;
        else {
          const waits = this.#operationWaits.get(grant.operationId);
          if (waits !== undefined) waits.fallbackCount = 0;
        }
      }
    }
    record.latestObservation = null;

    // 3. The completion's own headers: this grant's response. Its balance may include the debit of every cancel-all
    // still outstanding; its wait, if any, is an ordinary one; a 429's wait is already resolved.
    if (read.feedback !== null) {
      if (bucketCharge !== null && signerState !== undefined) {
        const origin: FeedbackOrigin = { exempt: this.#postHocOutstanding(bucketCharge.key), candidates: NO_GRANTS };
        effects.push(...this.#applyFeedback(signerState, bucketCharge.bucket, read.feedback, config, t, rateLimited !== null ? "RESOLVED" : "ANSWER", origin));
      } else {
        for (const flag of read.feedback.flags) effects.push(Object.freeze({ kind: "FEEDBACK_FLAG" as const, flag }));
        if (read.feedback.remaining !== null || read.feedback.resetUnixSeconds !== null || read.feedback.tier !== null || read.feedback.warning) {
          // The headers describe "the applicable bucket" of a covered request; this request had none.
          effects.push(Object.freeze({ kind: "FEEDBACK_WITHOUT_SIGNER_BUCKET" as const }));
        }
      }
    }
    return Object.freeze({ ok: true as const, value: Object.freeze(effects) });
  }

  /**
   * Take one rate-limit observation not tied to a grant by the caller
   * (WP-260's `onRateLimitUpdate`, whose `bucket` names the signer bucket).
   * It carries no request identity, so it is applied at once, as the answer
   * to any grant outstanding on that bucket (or to one already completed):
   *
   * - its balance (`Remaining`, `Warning`) lowers the bucket at once, held
   *   apart from the post-hoc debit of every cancel-all outstanding on the
   *   bucket (it may already include it);
   * - its wait (a `Reset` in a wait period; with the documented 429 status,
   *   its `Retry-After`, else its `Reset`) blocks the bucket at once, PENDING
   *   on the grants outstanding on the bucket: a 429 completing one of them
   *   withdraws it (see `complete`). With no grant outstanding, it is an
   *   ordinary wait;
   * - each outstanding grant remembers it as the latest observation of its
   *   time in flight.
   */
  observeSignerFeedback(
    target: { readonly signer: string; readonly bucket: SignerBucket },
    feedback: RateLimitFeedback,
    atMs: number,
  ): BudgetResult<readonly BudgetEffect[]> {
    const t = this.#time(atMs);
    if (t === undefined) return failure("INVALID_TIME", "atMs must be a non-negative safe integer of epoch milliseconds");
    const config = this.#timeline.activeAt(t);
    if (config === undefined) return failure("NO_ACTIVE_CONFIGURATION", "no rate-limit snapshot is in effect at this instant");
    const signerRead = readOwn(target, "signer");
    const bucketRead = readOwn(target, "bucket");
    const signer = signerRead.kind === "DATA" ? canonicalSigner(signerRead.value) : undefined;
    const bucket = bucketRead.kind === "DATA" && (bucketRead.value === "ORDER" || bucketRead.value === "CANCEL") ? bucketRead.value : undefined;
    const read = readFeedback(feedback);
    if (signer === undefined || bucket === undefined || read === undefined || read === null) {
      return failure("INVALID_REQUEST", "the target must be { signer, bucket: ORDER | CANCEL } and the feedback a RateLimitFeedback");
    }
    const key = bucketKey(signer, bucket);
    const outstanding = this.#outstanding.get(key) ?? [];
    for (const record of outstanding) record.latestObservation = read;
    const origin: FeedbackOrigin = { exempt: this.#postHocOutstanding(key), candidates: new Set(outstanding) };
    const state = this.#signer(signer, t);
    const effects = this.#applyFeedback(state, bucket, read, config, t, "OBSERVATION", origin);
    return Object.freeze({ ok: true as const, value: Object.freeze(effects) });
  }

  // -------------------------------------------------------------------------
  // Introspection.

  view(atMs: number): BudgetView {
    const t = this.#time(atMs) ?? this.#lastMs;
    const config = this.#timeline.activeAt(t);
    const windowView = (key: string, view: BudgetKeyView, windows: readonly SlidingWindowLimit[]): WindowBudgetView => {
      const state = this.#window(key);
      return Object.freeze({
        budget: view,
        windows: Object.freeze(
          windows.map((window) => Object.freeze({ limit: window.limit, windowMs: window.windowMs, used: state.times.length - firstAfter(state.times, t - window.windowMs) })),
        ),
      });
    };
    const bucketView = (signer: SignerState, bucket: SignerBucket): BucketView => {
      const state = this.#bucketState(signer, bucket);
      this.#advance(signer, bucket, t);
      const params = config === undefined ? undefined : bucketParams(config, signer.tier, bucket);
      return Object.freeze({
        budget: bucketKeyView(signer.signer, bucket),
        tokens: tokensText(levelOf(state)),
        capacity: params === undefined ? 0 : params.capacityMilli / MILLI_PER_TOKEN,
        tokensPerSecond: params?.rate ?? 0,
        blockedUntilMs: blockedUntilOf(state) > t ? blockedUntilOf(state) : null,
        warnings: state.warnings,
      });
    };
    return Object.freeze({
      atMs: t,
      snapshotId: config?.snapshotId ?? null,
      ipEndpointClasses: Object.freeze(
        (config?.ipEndpointClasses ?? []).map((entry) =>
          windowView(ipKey(entry.classId), Object.freeze({ dimension: "IP_ENDPOINT_CLASS" as const, classId: entry.classId }), entry.windows),
        ),
      ),
      relayer: config === undefined ? null : windowView(RELAYER_KEY, RELAYER_VIEW, config.relayer.windows),
      signers: Object.freeze(
        [...this.#signers.values()].map((signer) => Object.freeze({ signer: signer.signer, tier: signer.tier, order: bucketView(signer, "ORDER"), cancel: bucketView(signer, "CANCEL") })),
      ),
      queue: Object.freeze(
        this.#ranked().map((waiter) =>
          Object.freeze({ ticketId: waiter.ticketId, operationId: waiter.request.operationId, priority: waiter.request.priority, signer: waiter.request.signer }),
        ),
      ),
      operationWaits: Object.freeze(
        [...this.#operationWaits.entries()].flatMap(([operationId, state]) =>
          PRIORITY_LADDER.flatMap((priority, rank) => {
            const until = state.untilByRank[rank] ?? 0;
            return until > t ? [Object.freeze({ operationId, priority, untilMs: until })] : [];
          }),
        ),
      ),
    });
  }

  // -------------------------------------------------------------------------
  // Internals.

  #time(atMs: unknown): number | undefined {
    if (!isEpochMs(atMs)) return undefined;
    if (atMs > this.#lastMs) this.#lastMs = atMs;
    return this.#lastMs;
  }

  #ranked(): Waiter[] {
    return [...this.#queue].sort(compareWaiters);
  }

  #signer(signer: string, t: number): SignerState {
    let state = this.#signers.get(signer);
    if (state === undefined) {
      const config = this.#timeline.activeAt(t);
      // A signer first seen starts with EMPTY buckets: this process cannot know what another one (or its own
      // previous life) has spent, and a cancel-all may have left the cancel bucket in debt (D-21).
      const empty = (): BucketState => ({ levelMilli: 0, caps: [], lastMs: t, blockedUntilMs: 0, pending: [], fallbackCount: 0, warnings: 0 });
      state = { signer, tier: config?.policy.assumedSignerTier ?? "", order: empty(), cancel: empty() };
      this.#signers.set(signer, state);
    }
    return state;
  }

  #bucketState(signer: SignerState, bucket: SignerBucket): BucketState {
    return bucket === "ORDER" ? signer.order : signer.cancel;
  }

  #window(key: string): WindowState {
    let state = this.#windows.get(key);
    if (state === undefined) {
      state = { times: [] };
      this.#windows.set(key, state);
    }
    return state;
  }

  /** The instant until which `request`'s operation waits for its class (a 429 with no signer bucket); 0 if none. */
  #operationWaitUntil(request: NormalizedRequest): number {
    return this.#operationWaits.get(request.operationId)?.untilByRank[priorityRank(request.priority)] ?? 0;
  }

  /**
   * A grant no longer outstanding on its signer bucket. No balance held apart is exempt from its debit any more:
   * one exempt from no outstanding debit rejoins the estimate, and balances left with the same exemptions merge.
   */
  #release(record: GrantRecord): void {
    const charge = record.bucket;
    if (charge === null) return;
    const list = this.#outstanding.get(charge.key);
    if (list !== undefined) {
      const rest = list.filter((entry) => entry !== record);
      if (rest.length === 0) this.#outstanding.delete(charge.key);
      else this.#outstanding.set(charge.key, rest);
    }
    const signer = this.#signers.get(charge.signer);
    if (signer === undefined) return;
    const state = this.#bucketState(signer, charge.bucket);
    const caps: BalanceCap[] = [];
    for (const cap of state.caps) {
      cap.exempt.delete(record);
      if (cap.exempt.size === 0) {
        state.levelMilli = Math.min(state.levelMilli, cap.milli);
        continue;
      }
      const same = caps.find((other) => sameMembers(other.exempt, cap.exempt));
      if (same === undefined) caps.push(cap);
      else same.milli = Math.min(same.milli, cap.milli);
    }
    state.caps = caps.filter((cap) => cap.milli < state.levelMilli);
  }

  /** The cancel-all grants outstanding on a signer bucket: a balance reported now may include their debit. */
  #postHocOutstanding(key: string): ReadonlySet<GrantRecord> {
    return new Set((this.#outstanding.get(key) ?? []).filter((record) => record.postHocDebit));
  }

  /**
   * A reported balance (thousandths): it lowers the estimate itself when it may include no outstanding debit;
   * otherwise it is held apart from the debits it may include, until those grants complete.
   */
  #holdBalance(state: BucketState, milli: number, exempt: ReadonlySet<GrantRecord>): void {
    if (exempt.size === 0) {
      state.levelMilli = Math.min(state.levelMilli, milli);
      state.caps = state.caps.filter((cap) => cap.milli < state.levelMilli);
      return;
    }
    // At or above the estimate it can never bind (see `changeLevels`).
    if (milli >= state.levelMilli) return;
    const same = state.caps.find((cap) => sameMembers(cap.exempt, exempt));
    if (same === undefined) state.caps.push({ milli, exempt: new Set(exempt) });
    else same.milli = Math.min(same.milli, milli);
  }

  /** An observation's wait, pending on the grants that may be its request; waits pending on the same grants merge. */
  #holdWait(state: BucketState, untilMs: number, basis: WaitBasis, candidates: ReadonlySet<GrantRecord>): void {
    const same = state.pending.find((wait) => sameMembers(wait.candidates, candidates));
    if (same === undefined) state.pending.push({ untilMs, basis, candidates: new Set(candidates) });
    else if (untilMs > same.untilMs) {
      same.untilMs = untilMs;
      same.basis = basis;
    }
  }

  /** A grant completed without a 429: no longer a candidate of any pending wait; one with no candidate left is ordinary. */
  #settlePending(state: BucketState, record: GrantRecord): void {
    const kept: PendingWait[] = [];
    for (const wait of state.pending) {
      wait.candidates.delete(record);
      if (wait.candidates.size === 0) {
        state.blockedUntilMs = Math.max(state.blockedUntilMs, wait.untilMs);
        continue;
      }
      const same = kept.find((other) => sameMembers(other.candidates, wait.candidates));
      if (same === undefined) kept.push(wait);
      else if (wait.untilMs > same.untilMs) {
        same.untilMs = wait.untilMs;
        same.basis = wait.basis;
      }
    }
    state.pending = kept;
  }

  /**
   * Refill a bucket up to `toMs`, segment by segment, each under the snapshot in effect during it, and cap it
   * at the burst in effect at `toMs`: a snapshot that lowers the burst binds from its effective instant, even
   * when that instant is exactly `toMs` or no time has passed since the last read.
   */
  #advance(signer: SignerState, bucket: SignerBucket, toMs: number): void {
    const state = this.#bucketState(signer, bucket);
    const start = state.lastMs;
    const now = Math.max(state.lastMs, toMs);
    const active = this.#timeline.activeAt(now);
    // The estimate and every balance held apart refill alike (a refill is the same monotone change for each).
    changeLevels(state, (milli) => {
      let from = start;
      let level = milli;
      while (from < toMs) {
        const config = this.#timeline.activeAt(from);
        const change = this.#timeline.nextChangeAfter(from);
        const end = change === undefined || change > toMs ? toMs : change;
        if (config !== undefined) {
          const params = bucketParams(config, signer.tier, bucket);
          level = refill(Math.min(level, params.capacityMilli), params.rate, params.capacityMilli, end - from);
        }
        from = end;
      }
      if (active !== undefined) level = Math.min(level, bucketParams(active, signer.tier, bucket).capacityMilli);
      return level;
    });
    state.lastMs = now;
    // A pending wait that has run out holds nothing back; withdrawing it later would change nothing.
    state.pending = state.pending.filter((wait) => wait.untilMs > now);
  }

  /** Drop window entries no snapshot on the timeline can still count, and remember the latest one dropped. */
  #prune(key: string, t: number): WindowState {
    const state = this.#window(key);
    let longest = 0;
    for (const snapshot of this.#timeline.snapshots) longest = Math.max(longest, longestWindowMs(snapshot));
    const keep = firstAfter(state.times, t - longest);
    if (keep > 0) {
      const last = state.times[keep - 1] ?? t;
      this.#droppedThroughMs = this.#droppedThroughMs === null ? last : Math.max(this.#droppedThroughMs, last);
      state.times.splice(0, keep);
    }
    return state;
  }

  /** The charges of `request` under `config`, or why it cannot be granted under it. */
  #resolve(request: NormalizedRequest, config: RateLimitConfiguration): BudgetResult<readonly InternalCharge[]> {
    const operation = config.operations.find((entry) => entry.operationId === request.operationId);
    if (operation === undefined) return failure("UNKNOWN_OPERATION", "the snapshot in effect has no such operation");
    if (!isPermittedPriority(operation.kind, request.priority)) {
      return failure("PRIORITY_NOT_PERMITTED", `a ${operation.kind} operation may not be filed as ${request.priority}`);
    }
    const charges: InternalCharge[] = [];
    for (const classId of operation.ipEndpointClasses) {
      const entry = config.ipEndpointClasses.find((candidate) => candidate.classId === classId);
      if (entry === undefined) return failure("UNKNOWN_OPERATION", "the operation names an undeclared class");
      charges.push(Object.freeze({ type: "WINDOW" as const, key: ipKey(classId), view: Object.freeze({ dimension: "IP_ENDPOINT_CLASS" as const, classId }), windows: entry.windows, cost: 1 }));
    }
    if (operation.relayer) {
      charges.push(Object.freeze({ type: "WINDOW" as const, key: RELAYER_KEY, view: RELAYER_VIEW, windows: config.relayer.windows, cost: 1 }));
    }
    if (operation.signerBucket === null || operation.tokenCost === null) {
      if (request.signer !== null) return failure("SIGNER_NOT_EXPECTED", "this operation draws on no signer bucket");
      if (request.entries !== null) return failure("ENTRIES_NOT_EXPECTED", "this operation has no per-entry cost");
    } else {
      if (request.signer === null) return failure("SIGNER_REQUIRED", "this operation draws on a signer bucket: name the signer");
      const cost = operation.tokenCost;
      if (cost.perEntry > 0 && request.entries === null) return failure("ENTRIES_REQUIRED", "this operation costs per entry: give the entry count");
      if (cost.perEntry === 0 && request.entries !== null) return failure("ENTRIES_NOT_EXPECTED", "this operation has no per-entry cost");
      const tokens = cost.base + cost.perEntry * (request.entries ?? 0);
      charges.push(
        Object.freeze({
          type: "BUCKET" as const,
          key: bucketKey(request.signer, operation.signerBucket),
          view: bucketKeyView(request.signer, operation.signerBucket),
          signer: request.signer,
          bucket: operation.signerBucket,
          cost: tokens,
        }),
      );
    }
    // A request whose cost plus its class's headroom exceeds a budget's capacity can never be admitted
    // ("A batch whose token cost exceeds the tier's burst capacity can never be admitted as one request").
    const permille = config.policy.headroomPermille[request.priority];
    for (const charge of charges) {
      if (charge.type === "WINDOW") {
        if (charge.windows.some((window) => charge.cost + headroomOf(window.limit, permille) > window.limit)) {
          return failure("COST_EXCEEDS_CAPACITY", "the request exceeds a window's limit: it can never be admitted");
        }
      } else {
        const tier = this.#signers.get(charge.signer)?.tier ?? config.policy.assumedSignerTier;
        const params = bucketParams(config, tier, charge.bucket);
        if (charge.cost * MILLI_PER_TOKEN + headroomOf(params.capacityMilli, permille) > params.capacityMilli) {
          return failure("COST_EXCEEDS_CAPACITY", "the token cost exceeds the bucket's burst capacity: split the request");
        }
      }
    }
    return Object.freeze({ ok: true as const, value: Object.freeze(charges) });
  }

  #availability(charge: InternalCharge, config: RateLimitConfiguration, t: number, scratch: Map<string, Availability>): Availability {
    let found = scratch.get(charge.key);
    if (found !== undefined) return found;
    if (charge.type === "WINDOW") {
      const state = this.#prune(charge.key, t);
      found = {
        type: "WINDOW",
        free: charge.windows.map((window) => window.limit - (state.times.length - firstAfter(state.times, t - window.windowMs))),
        limits: charge.windows.map((window) => window.limit),
      };
    } else {
      const signer = this.#signer(charge.signer, t);
      this.#advance(signer, charge.bucket, t);
      const state = this.#bucketState(signer, charge.bucket);
      const params = bucketParams(config, signer.tier, charge.bucket);
      found = { type: "BUCKET", blocked: blockedUntilOf(state) > t, free: levelOf(state), capacityMilli: params.capacityMilli };
    }
    scratch.set(charge.key, found);
    return found;
  }

  /** Can every charge be paid now, after the reservations of higher-ranked waiters and this class's headroom? */
  #affordable(
    charges: readonly InternalCharge[],
    priority: PriorityClass,
    config: RateLimitConfiguration,
    t: number,
    scratch: Map<string, Availability>,
    reserved: ReadonlyMap<string, number>,
  ): boolean {
    const permille = config.policy.headroomPermille[priority];
    for (const charge of charges) {
      const available = this.#availability(charge, config, t, scratch);
      if (available.type === "BUCKET" && available.blocked) return false;
      const held = reserved.get(charge.key) ?? 0;
      if (available.type === "WINDOW") {
        for (let index = 0; index < available.free.length; index += 1) {
          const free = available.free[index] ?? 0;
          const limit = available.limits[index] ?? 0;
          if (free - held - charge.cost < headroomOf(limit, permille)) return false;
        }
      } else if (available.free - held - charge.cost * MILLI_PER_TOKEN < headroomOf(available.capacityMilli, permille)) {
        return false;
      }
    }
    return true;
  }

  /** One planning pass at `t`: which waiters to grant (in rank order) and which can never be granted. */
  #plan(
    config: RateLimitConfiguration,
    t: number,
  ): {
    readonly grants: readonly { readonly waiter: Waiter; readonly charges: readonly InternalCharge[] }[];
    readonly refusals: readonly { readonly waiter: Waiter; readonly refusal: BudgetRefusal }[];
  } {
    const scratch = new Map<string, Availability>();
    const reserved = new Map<string, number>();
    const grants: { readonly waiter: Waiter; readonly charges: readonly InternalCharge[] }[] = [];
    const refusals: { readonly waiter: Waiter; readonly refusal: BudgetRefusal }[] = [];
    for (const waiter of this.#ranked()) {
      const resolved = this.#resolve(waiter.request, config);
      if (!resolved.ok) {
        refusals.push({ waiter, refusal: resolved.refusal });
        continue;
      }
      if (this.#operationWaitUntil(waiter.request) <= t && this.#affordable(resolved.value, waiter.request.priority, config, t, scratch, reserved)) {
        grants.push({ waiter, charges: resolved.value });
        for (const charge of resolved.value) {
          const available = scratch.get(charge.key);
          if (available === undefined) continue;
          if (available.type === "WINDOW") for (let index = 0; index < available.free.length; index += 1) available.free[index] = (available.free[index] ?? 0) - charge.cost;
          else available.free -= charge.cost * MILLI_PER_TOKEN;
        }
      } else {
        // A waiter that cannot go yet holds its cost on every budget it waits on.
        for (const charge of resolved.value) reserved.set(charge.key, (reserved.get(charge.key) ?? 0) + reservationOf(charge));
      }
    }
    return { grants, refusals };
  }

  /** Debit the charges and issue the grant. */
  #commit(waiter: Waiter, charges: readonly InternalCharge[], config: RateLimitConfiguration, t: number): Grant {
    for (const charge of charges) {
      if (charge.type === "WINDOW") {
        this.#prune(charge.key, t).times.push(t);
      } else {
        const signer = this.#signer(charge.signer, t);
        this.#advance(signer, charge.bucket, t);
        // Granted after every balance held apart arrived: none of them can include it.
        const debit = charge.cost * MILLI_PER_TOKEN;
        changeLevels(this.#bucketState(signer, charge.bucket), (milli) => milli - debit);
      }
    }
    const operation = config.operations.find((entry) => entry.operationId === waiter.request.operationId);
    if (operation === undefined) throw new TypeError("a resolved request names a configured operation");
    const bucket = charges.find((charge): charge is Extract<InternalCharge, { type: "BUCKET" }> => charge.type === "BUCKET") ?? null;
    this.#grantCounter += 1;
    const grant: Grant = Object.freeze({
      grantId: `grant-${String(this.#grantCounter)}`,
      ticketId: waiter.ticketId,
      operationId: waiter.request.operationId,
      priority: waiter.request.priority,
      signer: waiter.request.signer,
      entries: waiter.request.entries,
      charges: Object.freeze(charges.map((charge) => Object.freeze({ budget: charge.view, cost: charge.cost }))),
      grantedAtMs: t,
      snapshotId: config.snapshotId,
    });
    const record: GrantRecord = { grant, operation, charges, bucket, postHocDebit: (operation.tokenCost?.perCanceled ?? 0) > 0, latestObservation: null };
    this.#issued.set(grant, record);
    if (bucket !== null) this.#outstanding.set(bucket.key, [...(this.#outstanding.get(bucket.key) ?? []), record]);
    return grant;
  }

  /**
   * The earliest instant `charge` could be paid by a request of `priority` while `held` (the reservations of
   * the waiters ranked above it, as in `#plan`) stays set aside on its budget, if nothing else changes;
   * `Infinity` when it cannot be while they wait (one of them must be granted first).
   */
  #etaOf(charge: InternalCharge, priority: PriorityClass, config: RateLimitConfiguration, t: number, held: number): number {
    const permille = config.policy.headroomPermille[priority];
    if (charge.type === "WINDOW") {
      const state = this.#prune(charge.key, t);
      let eta = t;
      for (const window of charge.windows) {
        const allowed = window.limit - held - charge.cost - headroomOf(window.limit, permille);
        if (allowed < 0) return Number.POSITIVE_INFINITY;
        const start = firstAfter(state.times, t - window.windowMs);
        const excess = state.times.length - start - allowed;
        // The window admits it once its `excess` oldest requests have left it.
        if (excess > 0) eta = Math.max(eta, (state.times[start + excess - 1] ?? t) + window.windowMs);
      }
      return eta;
    }
    const signer = this.#signer(charge.signer, t);
    this.#advance(signer, charge.bucket, t);
    const state = this.#bucketState(signer, charge.bucket);
    const params = bucketParams(config, signer.tier, charge.bucket);
    const need = held + charge.cost * MILLI_PER_TOKEN + headroomOf(params.capacityMilli, permille);
    if (need > params.capacityMilli) return Number.POSITIVE_INFINITY;
    const level = levelOf(state);
    const refillAt = level >= need ? t : t + Math.ceil((need - level) / params.rate);
    return Math.max(refillAt, blockedUntilOf(state));
  }

  /**
   * A later `Poly-RateLimit-Reset` as a wait deadline, bounded by the snapshot's `maxHeaderWaitMs`; `null` when
   * the response carries none, or one not after `t`.
   */
  #resetDeadline(feedback: RateLimitFeedback | null, config: RateLimitConfiguration, t: number): { readonly untilMs: number; readonly capped: boolean } | null {
    if (feedback === null || feedback.resetUnixSeconds === null) return null;
    const bound = t + config.policy.maxHeaderWaitMs;
    // Compared in whole seconds first: a Reset too far ahead to hold exactly in milliseconds is never multiplied.
    if (feedback.resetUnixSeconds > Math.ceil(bound / MS_PER_SECOND)) return { untilMs: bound, capped: true };
    const resetMs = feedback.resetUnixSeconds * MS_PER_SECOND;
    if (resetMs <= t) return null;
    return { untilMs: Math.min(resetMs, bound), capped: resetMs > bound };
  }

  /**
   * ONE response's 429 wait: `Retry-After` exactly; else a later `Poly-RateLimit-Reset` (bounded); else the
   * snapshot's fallback backoff, which escalates only on a 429 seen after the previous wait ran out (a 429 for
   * a request sent before the running wait began is not a new failed attempt).
   */
  #resolveWait(
    retryAfterSeconds: number | null,
    feedback: RateLimitFeedback | null,
    running: { readonly untilMs: number; readonly fallbackCount: number },
    config: RateLimitConfiguration,
    t: number,
  ): { readonly untilMs: number; readonly basis: WaitBasis; readonly capped: boolean; readonly fallbackCount: number } {
    if (retryAfterSeconds !== null) {
      return { untilMs: t + retryAfterSeconds * MS_PER_SECOND, basis: "RETRY_AFTER", capped: false, fallbackCount: running.fallbackCount };
    }
    const reset = this.#resetDeadline(feedback, config, t);
    if (reset !== null) return { untilMs: reset.untilMs, basis: "RESET", capped: reset.capped, fallbackCount: running.fallbackCount };
    if (running.untilMs > t) return { untilMs: running.untilMs, basis: "FALLBACK", capped: false, fallbackCount: running.fallbackCount };
    return {
      untilMs: t + backoffDelay(config.policy.rateLimitedFallback, running.fallbackCount),
      basis: "FALLBACK",
      capped: false,
      fallbackCount: running.fallbackCount + 1,
    };
  }

  /**
   * A 429 on a request that drew on a signer bucket: that bucket waits (the per-signer limiter's 429), for
   * this response's ONE wait. Every wait pending on this grant (an observation that may be this very response)
   * is withdrawn first; waits of other responses stay.
   */
  #bucketRateLimited(
    signer: SignerState,
    charge: Extract<InternalCharge, { type: "BUCKET" }>,
    record: GrantRecord,
    retryAfterSeconds: number | null,
    feedback: RateLimitFeedback | null,
    config: RateLimitConfiguration,
    t: number,
  ): BudgetEffect[] {
    const state = this.#bucketState(signer, charge.bucket);
    const effects: BudgetEffect[] = [];
    const kept: PendingWait[] = [];
    for (const pending of state.pending) {
      if (!pending.candidates.has(record)) kept.push(pending);
      else effects.push(Object.freeze({ kind: "PENDING_WAIT_WITHDRAWN" as const, budget: charge.view, untilMs: pending.untilMs, basis: pending.basis }));
    }
    state.pending = kept;
    const wait = this.#resolveWait(retryAfterSeconds, feedback, { untilMs: blockedUntilOf(state), fallbackCount: state.fallbackCount }, config, t);
    state.fallbackCount = wait.fallbackCount;
    state.blockedUntilMs = Math.max(state.blockedUntilMs, wait.untilMs);
    if (wait.capped) effects.push(Object.freeze({ kind: "RESET_WAIT_CAPPED" as const, budget: charge.view }));
    effects.push(Object.freeze({ kind: "WAIT_APPLIED" as const, budget: charge.view, untilMs: blockedUntilOf(state), basis: wait.basis }));
    return effects;
  }

  /**
   * A 429 on a request that drew on no signer bucket. No venue fact says what it limits (IP limits throttle
   * rather than reject), so it is applied as narrowly as it can be honoured: THIS operation waits, for the
   * request's class and every class ranked below it. No IP class is blocked, so no other operation, and no
   * higher class of this one, is held back by it.
   */
  #operationRateLimited(
    operationId: string,
    priority: PriorityClass,
    retryAfterSeconds: number | null,
    feedback: RateLimitFeedback | null,
    config: RateLimitConfiguration,
    t: number,
  ): BudgetEffect[] {
    let state = this.#operationWaits.get(operationId);
    if (state === undefined) {
      state = { untilByRank: PRIORITY_LADDER.map(() => 0), fallbackCount: 0 };
      this.#operationWaits.set(operationId, state);
    }
    const rank = priorityRank(priority);
    const wait = this.#resolveWait(retryAfterSeconds, feedback, { untilMs: state.untilByRank[rank] ?? 0, fallbackCount: state.fallbackCount }, config, t);
    state.fallbackCount = wait.fallbackCount;
    for (let below = rank; below < state.untilByRank.length; below += 1) {
      state.untilByRank[below] = Math.max(state.untilByRank[below] ?? 0, wait.untilMs);
    }
    const effects: BudgetEffect[] = [];
    if (wait.capped) effects.push(Object.freeze({ kind: "RESET_WAIT_CAPPED" as const, budget: null }));
    effects.push(
      Object.freeze({
        kind: "OPERATION_WAIT_APPLIED" as const,
        operationId,
        priorities: Object.freeze(PRIORITY_LADDER.slice(rank)),
        untilMs: state.untilByRank[rank] ?? wait.untilMs,
        basis: wait.basis,
      }),
    );
    return effects;
  }

  /**
   * The documented headers, applied to one signer bucket:
   *
   * - `Poly-RateLimit-Tier`: the signer's buckets take that tier's rate and
   *   burst (both buckets: the tier belongs to the signer, D-22). A value
   *   that names no tier of the snapshot falls back to the assumed tier, and
   *   is flagged.
   * - `Poly-RateLimit-Remaining`: the venue's balance after accounting. The
   *   bucket's level never exceeds it (it can only be lowered: local
   *   requests in flight are not yet in the venue's figure). It may be
   *   negative (D-21). Held apart from the post-hoc debit of every cancel-all
   *   in `origin.exempt` (see "Feedback").
   * - `Poly-RateLimit-Warning: true`: enforcement would have rejected the
   *   request, so the bucket had less than its cost: a balance of at most
   *   zero, held the same way, and the warning is counted for alerting.
   * - Waits, ONE per response (`context`):
   *   - a completion whose 429 wait is already resolved (`RESOLVED`): none;
   *   - otherwise `Poly-RateLimit-Reset` is a wait only while the bucket is
   *     in a wait period (a balance below zero, D-21: "remain blocked"),
   *     capped by `maxHeaderWaitMs` and flagged when capped; a balance of
   *     zero alone is not a wait (the pinned SDK: "do not back off solely
   *     because this value is zero");
   *   - an SDK observation (`OBSERVATION`) that carries the documented 429
   *     status: its `Retry-After` exactly, else its later `Reset`; never
   *     both.
   *   A wait from headers that may answer an outstanding grant
   *   (`origin.candidates`) is PENDING on those grants; any other is an
   *   ordinary wait.
   */
  #applyFeedback(
    signer: SignerState,
    bucket: SignerBucket,
    feedback: RateLimitFeedback,
    config: RateLimitConfiguration,
    t: number,
    context: WaitContext,
    origin: FeedbackOrigin,
  ): BudgetEffect[] {
    const effects: BudgetEffect[] = feedback.flags.map((flag) => Object.freeze({ kind: "FEEDBACK_FLAG" as const, flag }));
    this.#advance(signer, "ORDER", t);
    this.#advance(signer, "CANCEL", t);
    if (feedback.tier !== null) {
      const match = config.signerTiers.find((entry) => entry.tier.toLowerCase() === feedback.tier?.toLowerCase());
      signer.tier = match?.tier ?? config.policy.assumedSignerTier;
      effects.push(
        match === undefined
          ? Object.freeze({ kind: "TIER_UNRECOGNISED" as const, signer: signer.signer, fallbackTier: signer.tier })
          : Object.freeze({ kind: "TIER_APPLIED" as const, signer: signer.signer, tier: signer.tier }),
      );
      for (const which of ["ORDER", "CANCEL"] as const) {
        const capacity = bucketParams(config, signer.tier, which).capacityMilli;
        changeLevels(this.#bucketState(signer, which), (milli) => Math.min(milli, capacity));
      }
    }
    const state = this.#bucketState(signer, bucket);
    const view = bucketKeyView(signer.signer, bucket);
    if (feedback.remaining !== null) {
      this.#holdBalance(state, feedback.remaining * MILLI_PER_TOKEN, origin.exempt);
      effects.push(Object.freeze({ kind: "REMAINING_APPLIED" as const, budget: view, tokens: tokensText(levelOf(state)) }));
    }
    if (feedback.warning) {
      this.#holdBalance(state, 0, origin.exempt);
      state.warnings += 1;
      effects.push(Object.freeze({ kind: "WARNING_MODE" as const, budget: view }));
    }
    if ((feedback.remaining !== null || feedback.warning) && origin.exempt.size > 0) {
      effects.push(Object.freeze({ kind: "BALANCE_MAY_INCLUDE_DEBIT" as const, budget: view, grantIds: grantIdsOf(origin.exempt) }));
    }
    let wait: { readonly untilMs: number; readonly basis: WaitBasis; readonly capped: boolean } | null = null;
    if (context === "OBSERVATION" && feedback.httpStatus === HTTP_TOO_MANY_REQUESTS) {
      if (feedback.retryAfterSeconds !== null) {
        wait = { untilMs: t + feedback.retryAfterSeconds * MS_PER_SECOND, basis: "RETRY_AFTER", capped: false };
      } else {
        const reset = this.#resetDeadline(feedback, config, t);
        if (reset !== null) wait = { untilMs: reset.untilMs, basis: "RESET", capped: reset.capped };
      }
    } else if (context !== "RESOLVED" && feedback.remaining !== null && feedback.remaining < 0) {
      const reset = this.#resetDeadline(feedback, config, t);
      if (reset !== null) wait = { untilMs: reset.untilMs, basis: "RESET", capped: reset.capped };
    }
    if (wait !== null) {
      if (wait.capped) effects.push(Object.freeze({ kind: "RESET_WAIT_CAPPED" as const, budget: view }));
      if (origin.candidates.size === 0) {
        state.blockedUntilMs = Math.max(state.blockedUntilMs, wait.untilMs);
        effects.push(Object.freeze({ kind: "WAIT_APPLIED" as const, budget: view, untilMs: blockedUntilOf(state), basis: wait.basis }));
      } else {
        this.#holdWait(state, wait.untilMs, wait.basis, origin.candidates);
        effects.push(
          Object.freeze({ kind: "WAIT_PENDING" as const, budget: view, untilMs: wait.untilMs, basis: wait.basis, grantIds: grantIdsOf(origin.candidates) }),
        );
      }
    }
    return effects;
  }
}

// ---------------------------------------------------------------------------
// Helpers.

const RELAYER_KEY = "relayer";
const NO_GRANTS: ReadonlySet<GrantRecord> = Object.freeze(new Set<GrantRecord>());
const RELAYER_VIEW: BudgetKeyView = Object.freeze({ dimension: "RELAYER" as const });

/** The longest window a snapshot declares (IP classes and the relayer): how far back its counts reach. */
function longestWindowMs(config: RateLimitConfiguration): number {
  let longest = 0;
  for (const entry of config.ipEndpointClasses) for (const window of entry.windows) longest = Math.max(longest, window.windowMs);
  for (const window of config.relayer.windows) longest = Math.max(longest, window.windowMs);
  return longest;
}

function ipKey(classId: string): string {
  return `ip|${classId}`;
}

function bucketKey(signer: string, bucket: SignerBucket): string {
  return `${bucket === "ORDER" ? "order" : "cancel"}|${signer}`;
}

function bucketKeyView(signer: string, bucket: SignerBucket): BudgetKeyView {
  return bucket === "ORDER"
    ? Object.freeze({ dimension: "SIGNER_ORDER_BUCKET" as const, signer })
    : Object.freeze({ dimension: "SIGNER_CANCEL_BUCKET" as const, signer });
}

/** What a waiting request holds back on a budget: requests for a window, thousandths of a token for a bucket. */
function reservationOf(charge: InternalCharge): number {
  return charge.type === "WINDOW" ? charge.cost : charge.cost * MILLI_PER_TOKEN;
}

/** §9.13 rank first; within a class, first come first served. */
function compareWaiters(a: Waiter, b: Waiter): number {
  return priorityRank(a.request.priority) - priorityRank(b.request.priority) || a.seq - b.seq;
}

/** A `Retry-After` in whole seconds within WP-260's bound (`MAX_RETRY_AFTER_SECONDS`), as `headers.ts` reads it. */
function isRetryAfterSeconds(value: unknown): value is number {
  return isIntegerAtLeast(value, 0) && value <= MAX_RETRY_AFTER_SECONDS;
}

function canonicalSigner(value: unknown): string | undefined {
  return typeof value === "string" && SIGNER.test(value) ? value.toLowerCase() : undefined;
}

function normalizeRequest(input: unknown): NormalizedRequest | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const fields = ["operationId", "priority", "signer", "entries"].map((key) => readOwn(input, key));
  if (fields.some((field) => field.kind === "OPAQUE")) return undefined;
  const [operationRead, priorityRead, signerRead, entriesRead] = fields;
  const value = (read: (typeof fields)[number] | undefined): unknown => (read?.kind === "DATA" ? read.value : undefined);
  const operationId = value(operationRead);
  const priority = value(priorityRead);
  const signerRaw = value(signerRead);
  const entriesRaw = value(entriesRead);
  if (typeof operationId !== "string" || !IDENTIFIER.test(operationId) || !isPriorityClass(priority)) return undefined;
  const signer = signerRaw === undefined || signerRaw === null ? null : canonicalSigner(signerRaw);
  if (signer === undefined) return undefined;
  if (entriesRaw !== undefined && entriesRaw !== null && !isIntegerAtLeast(entriesRaw, 1)) return undefined;
  return Object.freeze({ operationId, priority, signer, entries: entriesRaw === undefined || entriesRaw === null ? null : entriesRaw });
}

function readFeedback(value: unknown): RateLimitFeedback | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const keys = ["httpStatus", "remaining", "resetUnixSeconds", "tier", "warning", "retryAfterSeconds", "flags"] as const;
  const reads = keys.map((key) => readOwn(value, key));
  if (reads.some((read) => read.kind !== "DATA")) return undefined;
  const [status, remaining, reset, tier, warning, retry, flags] = reads.map((read) => (read.kind === "DATA" ? read.value : undefined));
  const intOrNull = (candidate: unknown, minimum: number | null): boolean =>
    candidate === null || (typeof candidate === "number" && Number.isSafeInteger(candidate) && (minimum === null || candidate >= minimum));
  if (
    !intOrNull(status, null) ||
    !(remaining === null || isExactTokenCount(remaining)) ||
    !intOrNull(reset, 0) ||
    !(tier === null || (typeof tier === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(tier))) ||
    typeof warning !== "boolean" ||
    !(retry === null || isRetryAfterSeconds(retry))
  ) {
    return undefined;
  }
  const flagList = readList(flags);
  if (flagList === undefined) return undefined;
  return Object.freeze({
    httpStatus: status as number | null,
    remaining: remaining as number | null,
    resetUnixSeconds: reset as number | null,
    tier: tier as string | null,
    warning,
    retryAfterSeconds: retry as number | null,
    flags: Object.freeze([...(flagList as readonly FeedbackFlag[])]),
  });
}

function readCompletion(
  value: unknown,
): { readonly atMs: unknown; readonly error: { readonly kind: string; readonly retryAfterSeconds: number | null } | null; readonly feedback: RateLimitFeedback | null; readonly canceledCount: number | null } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const reads = ["atMs", "error", "feedback", "canceledCount"].map((key) => readOwn(value, key));
  if (reads.some((read) => read.kind === "OPAQUE")) return undefined;
  const [atRead, errorRead, feedbackRead, canceledRead] = reads;
  const value_ = (read: (typeof reads)[number] | undefined): unknown => (read?.kind === "DATA" ? read.value : undefined);
  const errorRaw = value_(errorRead) ?? null;
  let error: { readonly kind: string; readonly retryAfterSeconds: number | null } | null = null;
  if (errorRaw !== null) {
    const kind = readOwn(errorRaw, "kind");
    const retry = readOwn(errorRaw, "retryAfterSeconds");
    if (kind.kind !== "DATA" || typeof kind.value !== "string" || retry.kind === "OPAQUE") return undefined;
    const retryValue = retry.kind === "DATA" ? retry.value : null;
    if (!(retryValue === null || isRetryAfterSeconds(retryValue))) return undefined;
    error = Object.freeze({ kind: kind.value, retryAfterSeconds: retryValue });
  }
  const feedback = readFeedback(value_(feedbackRead) ?? null);
  if (feedback === undefined) return undefined;
  const canceledRaw = value_(canceledRead) ?? null;
  if (!(canceledRaw === null || isIntegerAtLeast(canceledRaw, 0))) return undefined;
  return Object.freeze({ atMs: value_(atRead), error, feedback, canceledCount: canceledRaw });
}

/** Construct a budget over snapshot documents; see {@link RateLimitBudget.create}. */
export function createRateLimitBudget(configurations: readonly unknown[]): BudgetResult<RateLimitBudget> {
  return RateLimitBudget.create(configurations);
}
