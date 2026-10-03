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
 * under the snapshot in effect during it.
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
 *   budget with it is not affected at all.
 *
 * `request()` grants at once only on the same terms: every waiter ranked
 * above the new request reserves its cost first. A lower class can never
 * take capacity a higher class is waiting for, and with headroom configured
 * it cannot drain the last of a budget before a higher class arrives.
 *
 * ## Feedback
 *
 * `complete()` closes a grant with what the venue answered: the mapped error
 * (WP-260's `SecureVenueError` fields), the parsed headers (`headers.ts`) and,
 * for cancel-all / cancel-market-orders, the number of orders canceled.
 * `observeSignerFeedback()` takes WP-260's `onRateLimitUpdate` observations.
 * What each documented header does is in `#applyFeedback`; a 429's
 * `Retry-After` blocks exactly the budget the venue's limiter charged, for
 * exactly that many seconds.
 *
 * ## Time
 *
 * No clock is read: every call takes `atMs`, Unix epoch milliseconds, from the
 * caller. A time earlier than one already seen is read as the latest seen
 * (no refill is invented, no block is shortened).
 *
 * Nothing here performs I/O, holds a credential, or retries anything: it
 * only says when a request may be sent. PAPER only.
 */

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
import { isPermittedPriority, isPriorityClass, priorityRank, type PriorityClass } from "./priority.js";

/** Unit: milliseconds per second. */
export const MS_PER_SECOND = 1000;
/**
 * Token levels are kept in thousandths of a token, so a rate in tokens per
 * second times a span in milliseconds is an exact integer number of them.
 */
const MILLI_PER_TOKEN = MS_PER_SECOND;

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
  | "EFFECTIVE_TIME_NOT_IN_FUTURE";

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

export type BudgetEffect =
  | { readonly kind: "REMAINING_APPLIED"; readonly budget: BudgetKeyView; readonly tokens: string }
  | { readonly kind: "TIER_APPLIED"; readonly signer: string; readonly tier: string }
  | { readonly kind: "TIER_UNRECOGNISED"; readonly signer: string; readonly fallbackTier: string }
  | { readonly kind: "WARNING_MODE"; readonly budget: BudgetKeyView }
  | { readonly kind: "WAIT_APPLIED"; readonly budget: BudgetKeyView; readonly untilMs: number; readonly basis: "RETRY_AFTER" | "RESET" | "FALLBACK" }
  | { readonly kind: "RESET_WAIT_CAPPED"; readonly budget: BudgetKeyView }
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
  readonly blockedUntilMs: number | null;
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
}

// ---------------------------------------------------------------------------
// Internal state.

interface BucketState {
  levelMilli: number;
  lastMs: number;
  blockedUntilMs: number;
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
  blockedUntilMs: number;
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
  readonly operation: OperationConfig;
  readonly charges: readonly InternalCharge[];
}

/** Scratch availability during one planning pass. */
type Availability =
  | { readonly type: "WINDOW"; readonly blocked: boolean; readonly free: number[]; readonly limits: readonly number[] }
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

/** `initialMs × multiplier^count`, capped. */
function backoffDelay(policy: { readonly initialMs: number; readonly multiplier: number; readonly capMs: number }, count: number): number {
  let delay = policy.initialMs;
  for (let step = 0; step < count && delay < policy.capMs; step += 1) delay *= policy.multiplier;
  return Math.min(delay, policy.capMs);
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
   * already acted on).
   */
  addConfiguration(raw: unknown): BudgetResult<{ readonly snapshotId: string; readonly effectiveFromMs: number }> {
    const parsed = parseRateLimitConfiguration(raw);
    if (!parsed.ok) return failure("INVALID_CONFIGURATION", parsed.problems.join("; "));
    if (parsed.value.effectiveFromMs <= this.#lastMs) {
      return failure("EFFECTIVE_TIME_NOT_IN_FUTURE", "a new snapshot must take effect after every instant already processed");
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
    if (this.#affordable(resolved.value, request.priority, config, t, availability, reserved)) {
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
   * itself when one would grant now), or `null` with nothing queued. A
   * lower bound: polling then may still grant nothing (e.g. feedback arrived).
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
    let wake = change ?? Number.POSITIVE_INFINITY;
    for (const waiter of this.#queue) {
      const charges = this.#resolve(waiter.request, config);
      if (!charges.ok) continue;
      let eta = t;
      for (const charge of charges.value) eta = Math.max(eta, this.#etaOf(charge, waiter.request.priority, config, t));
      if (eta > t) wake = Math.min(wake, eta);
    }
    return Number.isFinite(wake) ? wake : null;
  }

  // -------------------------------------------------------------------------
  // Feedback.

  /**
   * Close a grant with the venue's answer. Applies, in order: the post-hoc
   * cancel debit (cancel-all / cancel-market-orders, D-21), a 429's wait,
   * and the documented headers. Each grant completes once.
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
    this.#completed.add(grant);

    const effects: BudgetEffect[] = [];
    const bucketCharge = record.charges.find((charge): charge is Extract<InternalCharge, { type: "BUCKET" }> => charge.type === "BUCKET");
    const signerState = bucketCharge === undefined ? undefined : this.#signer(bucketCharge.signer, t);

    // 1. The post-hoc cancel debit: "the bucket is debited one additional token for every order successfully canceled".
    const perCanceled = record.operation.tokenCost?.perCanceled ?? 0;
    if (read.canceledCount !== null && perCanceled === 0) effects.push(Object.freeze({ kind: "CANCELED_COUNT_NOT_APPLICABLE" as const }));
    if (perCanceled > 0 && bucketCharge !== undefined && signerState !== undefined) {
      if (read.canceledCount === null) {
        effects.push(Object.freeze({ kind: "CANCELED_COUNT_UNKNOWN" as const, budget: bucketCharge.view }));
      } else {
        const state = this.#bucketState(signerState, bucketCharge.bucket);
        this.#advance(signerState, bucketCharge.bucket, t);
        const params = bucketParams(config, signerState.tier, bucketCharge.bucket);
        const debit = perCanceled * read.canceledCount * MILLI_PER_TOKEN;
        // Tiers without a negative cancel balance "floor the post-cancel balance at zero regardless of debit size".
        state.levelMilli = params.negativeAllowed ? state.levelMilli - debit : state.levelMilli >= 0 ? Math.max(state.levelMilli - debit, 0) : state.levelMilli;
        effects.push(Object.freeze({ kind: "CANCELED_DEBITED" as const, budget: bucketCharge.view, tokens: perCanceled * read.canceledCount }));
      }
    }

    // 2. A 429: wait on exactly the budget the per-signer limiter charged (the signer bucket), or, for a
    // request with no signer bucket, on every budget it drew on.
    const feedback = read.feedback;
    if (read.error !== null && read.error.kind === "RATE_LIMITED") {
      const targets = bucketCharge !== undefined ? [bucketCharge] : record.charges;
      const headerRetry = feedback !== null && feedback.httpStatus === HTTP_TOO_MANY_REQUESTS ? feedback.retryAfterSeconds : null;
      const retryAfterSeconds = read.error.retryAfterSeconds ?? headerRetry;
      for (const target of targets) effects.push(this.#rateLimitedWait(target, retryAfterSeconds, feedback, config, t));
    } else if (read.error === null) {
      // A request the venue answered without a 429 ends the consecutive-fallback run on its budgets.
      for (const charge of record.charges) {
        if (charge.type === "WINDOW") this.#window(charge.key).fallbackCount = 0;
        else if (signerState !== undefined) this.#bucketState(signerState, charge.bucket).fallbackCount = 0;
      }
    }

    // 3. The documented headers (a 429's Retry-After is already applied above).
    if (feedback !== null) {
      if (bucketCharge !== undefined && signerState !== undefined) {
        effects.push(...this.#applyFeedback(signerState, bucketCharge.bucket, feedback, config, t, false));
      } else {
        for (const flag of feedback.flags) effects.push(Object.freeze({ kind: "FEEDBACK_FLAG" as const, flag }));
        if (feedback.remaining !== null || feedback.resetUnixSeconds !== null || feedback.tier !== null || feedback.warning) {
          // The headers describe "the applicable bucket" of a covered request; this request had none.
          effects.push(Object.freeze({ kind: "FEEDBACK_WITHOUT_SIGNER_BUCKET" as const }));
        }
      }
    }
    return Object.freeze({ ok: true as const, value: Object.freeze(effects) });
  }

  /**
   * Apply one rate-limit observation that is not tied to a grant (WP-260's
   * `onRateLimitUpdate`, whose `bucket` names the signer bucket). A
   * `Retry-After` is applied only when the feedback carries the documented
   * 429 status.
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
    const state = this.#signer(signer, t);
    const effects = this.#applyFeedback(state, bucket, read, config, t, true);
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
        blockedUntilMs: state.blockedUntilMs > t ? state.blockedUntilMs : null,
      });
    };
    const bucketView = (signer: SignerState, bucket: SignerBucket): BucketView => {
      const state = this.#bucketState(signer, bucket);
      this.#advance(signer, bucket, t);
      const params = config === undefined ? undefined : bucketParams(config, signer.tier, bucket);
      return Object.freeze({
        budget: bucketKeyView(signer.signer, bucket),
        tokens: tokensText(state.levelMilli),
        capacity: params === undefined ? 0 : params.capacityMilli / MILLI_PER_TOKEN,
        tokensPerSecond: params?.rate ?? 0,
        blockedUntilMs: state.blockedUntilMs > t ? state.blockedUntilMs : null,
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
      const empty = (): BucketState => ({ levelMilli: 0, lastMs: t, blockedUntilMs: 0, fallbackCount: 0, warnings: 0 });
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
      state = { times: [], blockedUntilMs: 0, fallbackCount: 0 };
      this.#windows.set(key, state);
    }
    return state;
  }

  /** Refill a bucket up to `toMs`, segment by segment, each under the snapshot in effect during it. */
  #advance(signer: SignerState, bucket: SignerBucket, toMs: number): void {
    const state = this.#bucketState(signer, bucket);
    let from = state.lastMs;
    if (toMs <= from) return;
    let level = state.levelMilli;
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
    state.levelMilli = level;
    state.lastMs = toMs;
  }

  /** Drop window entries no snapshot on the timeline can still count. */
  #prune(key: string, t: number): WindowState {
    const state = this.#window(key);
    let longest = 0;
    for (const snapshot of this.#timeline.snapshots) {
      for (const entry of snapshot.ipEndpointClasses) for (const window of entry.windows) longest = Math.max(longest, window.windowMs);
      for (const window of snapshot.relayer.windows) longest = Math.max(longest, window.windowMs);
    }
    const keep = firstAfter(state.times, t - longest);
    if (keep > 0) state.times.splice(0, keep);
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
        blocked: state.blockedUntilMs > t,
        free: charge.windows.map((window) => window.limit - (state.times.length - firstAfter(state.times, t - window.windowMs))),
        limits: charge.windows.map((window) => window.limit),
      };
    } else {
      const signer = this.#signer(charge.signer, t);
      this.#advance(signer, charge.bucket, t);
      const state = this.#bucketState(signer, charge.bucket);
      const params = bucketParams(config, signer.tier, charge.bucket);
      found = { type: "BUCKET", blocked: state.blockedUntilMs > t, free: state.levelMilli, capacityMilli: params.capacityMilli };
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
      if (available.blocked) return false;
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
      if (this.#affordable(resolved.value, waiter.request.priority, config, t, scratch, reserved)) {
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
        this.#bucketState(signer, charge.bucket).levelMilli -= charge.cost * MILLI_PER_TOKEN;
      }
    }
    const operation = config.operations.find((entry) => entry.operationId === waiter.request.operationId);
    if (operation === undefined) throw new TypeError("a resolved request names a configured operation");
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
    this.#issued.set(grant, Object.freeze({ operation, charges }));
    return grant;
  }

  /** The earliest instant `charge` alone could be paid by a request of `priority` (ignoring other waiters). */
  #etaOf(charge: InternalCharge, priority: PriorityClass, config: RateLimitConfiguration, t: number): number {
    const permille = config.policy.headroomPermille[priority];
    if (charge.type === "WINDOW") {
      const state = this.#prune(charge.key, t);
      let eta = Math.max(t, state.blockedUntilMs);
      for (const window of charge.windows) {
        const start = firstAfter(state.times, t - window.windowMs);
        const used = state.times.length - start;
        const excess = used - (window.limit - charge.cost - headroomOf(window.limit, permille));
        if (excess > 0) eta = Math.max(eta, (state.times[start + excess - 1] ?? t) + window.windowMs);
      }
      return eta;
    }
    const signer = this.#signer(charge.signer, t);
    this.#advance(signer, charge.bucket, t);
    const state = this.#bucketState(signer, charge.bucket);
    const params = bucketParams(config, signer.tier, charge.bucket);
    const need = charge.cost * MILLI_PER_TOKEN + headroomOf(params.capacityMilli, permille);
    const refillAt = state.levelMilli >= need ? t : t + Math.ceil((need - state.levelMilli) / params.rate);
    return Math.max(refillAt, state.blockedUntilMs);
  }

  /** A 429: wait `Retry-After` exactly; else until `Poly-RateLimit-Reset`; else the policy's fallback backoff. */
  #rateLimitedWait(
    charge: InternalCharge,
    retryAfterSeconds: number | null,
    feedback: RateLimitFeedback | null,
    config: RateLimitConfiguration,
    t: number,
  ): BudgetEffect {
    let until: number;
    let basis: "RETRY_AFTER" | "RESET" | "FALLBACK";
    const resetMs = feedback?.resetUnixSeconds === null || feedback === null ? null : feedback.resetUnixSeconds * MS_PER_SECOND;
    let fallbackCount: number;
    const state = charge.type === "WINDOW" ? this.#window(charge.key) : this.#bucketState(this.#signer(charge.signer, t), charge.bucket);
    if (retryAfterSeconds !== null) {
      until = t + retryAfterSeconds * MS_PER_SECOND;
      basis = "RETRY_AFTER";
    } else if (resetMs !== null && resetMs > t) {
      until = Math.min(resetMs, t + config.policy.maxHeaderWaitMs);
      basis = "RESET";
    } else if (state.blockedUntilMs > t) {
      // A 429 for a request sent before the running wait began is not a new failed attempt: no escalation.
      until = state.blockedUntilMs;
      basis = "FALLBACK";
    } else {
      fallbackCount = state.fallbackCount;
      until = t + backoffDelay(config.policy.rateLimitedFallback, fallbackCount);
      state.fallbackCount = fallbackCount + 1;
      basis = "FALLBACK";
    }
    state.blockedUntilMs = Math.max(state.blockedUntilMs, until);
    return Object.freeze({ kind: "WAIT_APPLIED" as const, budget: charge.view, untilMs: state.blockedUntilMs, basis });
  }

  /**
   * The documented headers, applied to one signer bucket:
   *
   * - `Poly-RateLimit-Tier`: the signer's buckets take that tier's rate and
   *   burst (both buckets: the tier belongs to the signer, D-22). A value
   *   that names no tier of the snapshot falls back to the assumed tier, and
   *   is flagged.
   * - `Poly-RateLimit-Remaining`: the venue's balance after accounting. The
   *   local estimate never exceeds it (it can only be lowered: local
   *   requests in flight are not yet in the venue's figure). It may be
   *   negative (D-21).
   * - `Poly-RateLimit-Warning: true`: enforcement would have rejected the
   *   request, so the bucket had less than its cost: the estimate drops to
   *   at most zero, and the warning is counted for alerting.
   * - `Poly-RateLimit-Reset`: when the bucket is in a wait period (a
   *   balance below zero, D-21: "remain blocked"), the bucket waits until
   *   then (capped by `maxHeaderWaitMs`, and flagged when capped). A balance
   *   of zero alone is not a wait (the pinned SDK: "do not back off solely
   *   because this value is zero").
   * - `Retry-After`: only with the documented 429 status, and only when
   *   `applyRetryAfter` (a grant's completion applies it with the error).
   */
  #applyFeedback(
    signer: SignerState,
    bucket: SignerBucket,
    feedback: RateLimitFeedback,
    config: RateLimitConfiguration,
    t: number,
    applyRetryAfter: boolean,
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
        const state = this.#bucketState(signer, which);
        state.levelMilli = Math.min(state.levelMilli, bucketParams(config, signer.tier, which).capacityMilli);
      }
    }
    const state = this.#bucketState(signer, bucket);
    const view = bucketKeyView(signer.signer, bucket);
    if (feedback.remaining !== null) {
      state.levelMilli = Math.min(state.levelMilli, feedback.remaining * MILLI_PER_TOKEN);
      effects.push(Object.freeze({ kind: "REMAINING_APPLIED" as const, budget: view, tokens: tokensText(state.levelMilli) }));
    }
    if (feedback.warning) {
      state.levelMilli = Math.min(state.levelMilli, 0);
      state.warnings += 1;
      effects.push(Object.freeze({ kind: "WARNING_MODE" as const, budget: view }));
    }
    if (feedback.resetUnixSeconds !== null && feedback.remaining !== null && feedback.remaining < 0) {
      const resetMs = feedback.resetUnixSeconds * MS_PER_SECOND;
      if (resetMs > t) {
        const bound = t + config.policy.maxHeaderWaitMs;
        if (resetMs > bound) effects.push(Object.freeze({ kind: "RESET_WAIT_CAPPED" as const, budget: view }));
        state.blockedUntilMs = Math.max(state.blockedUntilMs, Math.min(resetMs, bound));
        effects.push(Object.freeze({ kind: "WAIT_APPLIED" as const, budget: view, untilMs: state.blockedUntilMs, basis: "RESET" as const }));
      }
    }
    if (applyRetryAfter && feedback.httpStatus === HTTP_TOO_MANY_REQUESTS && feedback.retryAfterSeconds !== null) {
      state.blockedUntilMs = Math.max(state.blockedUntilMs, t + feedback.retryAfterSeconds * MS_PER_SECOND);
      effects.push(Object.freeze({ kind: "WAIT_APPLIED" as const, budget: view, untilMs: state.blockedUntilMs, basis: "RETRY_AFTER" as const }));
    }
    return effects;
  }
}

// ---------------------------------------------------------------------------
// Helpers.

const RELAYER_KEY = "relayer";
const RELAYER_VIEW: BudgetKeyView = Object.freeze({ dimension: "RELAYER" as const });

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
    !intOrNull(remaining, null) ||
    !intOrNull(reset, 0) ||
    !(tier === null || (typeof tier === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(tier))) ||
    typeof warning !== "boolean" ||
    !intOrNull(retry, 0)
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
    if (!(retryValue === null || (typeof retryValue === "number" && Number.isSafeInteger(retryValue) && retryValue >= 0))) return undefined;
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
