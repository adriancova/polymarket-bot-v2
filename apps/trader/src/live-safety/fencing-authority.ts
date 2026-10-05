/**
 * The process's hold on the PostgreSQL fence (WP-320; handoff §9.18, §6
 * invariant 16; ADR-008 §1–§2).
 *
 * The lease row is the fence (`@polymarket-bot/storage-postgres`'s
 * `createFencingLeaseStore`); this class is the PROCESS's answer to "may I
 * still act under it?", which the database cannot give in time: a submission
 * or a heartbeat is decided in memory, and must not be decided under a lease
 * the database has already let go.
 *
 * ## The local deadline
 *
 * Every grant or renewal is timed on the process's MONOTONIC clock from the
 * instant read just BEFORE the call that obtained it. The database writes
 * `expires_at = clock_timestamp() + ttl` while executing that call, which is
 * no earlier than the instant read before it, so
 *
 *     local deadline = (monotonic time before the call) + ttl − safetyMargin
 *
 * never falls after the database's expiry, as long as the two clocks run at
 * the same rate to within `safetyMargin` over one lease. Nothing here reads a
 * wall clock: a wall-clock step moves neither deadline.
 *
 * - **Held** means: a grant, not lost, and at least `transmitMarginMs` left
 *   before the local deadline. A submission or heartbeat starts only then, so
 *   one that starts may finish within the lease (`WP-040` R12: "refresh the
 *   lease before a batch rather than rely on the batch being fast").
 * - **Lost** is LATCHED, with its reason: the deadline passed (`EXPIRED`), the
 *   database answered that the lease is no longer this holder's (`RENEW_LOST`:
 *   released, revoked, expired or taken over), the monotonic clock went
 *   backwards or became unreadable (`CLOCK_FAULT`), or the holder released it.
 *   A lost grant is never renewed again: a STALE HOLDER can never renew. Only
 *   {@link FencingAuthority.acquire} restores authority, and only with a new
 *   grant, whose token the database allocates above every earlier one.
 * - **A renewal whose outcome is unknown** (the database was unreachable)
 *   changes nothing: the old deadline stands, and the grant is lost when it
 *   passes. A renewal that the database applied but whose answer was lost
 *   leaves the database's lease LONGER than the local one: the safe direction.
 *
 * ## A takeover waits out the incumbent on THIS process's clock (r1, I1)
 *
 * The store answers `LAPSED` while the realm's latest lease has ended
 * (expired by the database's clock, revoked, released) and grants a new
 * lease only to a caller presenting that lease's exact VERSION back. This
 * class presents it only after it has seen the SAME version, unchanged, for
 * {@link FencingAuthority.takeoverWaitMs} = `ttl + safetyMargin` on its own
 * monotonic clock, timed from the END of the call that first returned it (the
 * version was committed before then). Why that suffices, whatever the
 * database's clock did and whether or not the old holder was revoked: the
 * old holder acts only until ITS local deadline, its last successful
 * renewal's call start + ttl − safetyMargin; that renewal committed the
 * version before this process saw it; so a whole lease plus the margin
 * later, by a clock that runs at the same rate to within the margin (the
 * assumption the local deadline already makes), the old holder's deadline
 * has passed, and with it every transmission it started with its transmit
 * margin left. A version that changes meanwhile restarts the wait. What it
 * does NOT cover (disclosed residuals): a process paused longer than the
 * transmit margin between its check and its send, and a clock whose rate
 * drifts by more than the margin over one lease.
 *
 * ## Paper mode cannot acquire live fencing; nor can a process above its ceiling
 *
 * {@link FencingAuthority.create} reads the process's RUN-MODE CONTEXT
 * (`runMode`, `maximumRunMode`, `allowRealOrders`: exactly three own data
 * properties of a plain object, the context `assertSignerGate` reads) FIRST,
 * and refuses unless all three conditions of ADR-010 §1 hold at once: the run
 * mode submits real orders (`RUN_MODE_REQUIRES_LIVE_SIGNER`: not BACKTEST,
 * PAPER or SHADOW, and nothing that is not a §11 run mode), it does not
 * exceed `maximumRunMode`, and `allowRealOrders` is the boolean `true`. Under
 * the repository's defaults (`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`)
 * nothing passes, so no fence is acquired (r1, I8). The store refuses the
 * same three again before any SQL, and the database's
 * `fencing_leases_real_modes_only` CHECK refuses a simulated mode a third
 * time (ADR-008 §2; ADR-010). As with the signer gate, the context is the
 * composition root's to make true: a root that lies about its own ceiling is
 * not detectable here.
 */

import { RUN_MODE_REQUIRES_LIVE_SIGNER, RUN_MODES, runModeExceeds, type RunMode } from "@polymarket-bot/domain";
import type { FencingAcquireOutcome, FencingIncumbent, FencingLeaseRef, FencingRenewOutcome, FencingGrant, FencingTakeover } from "@polymarket-bot/storage-postgres";

import type { MonotonicClock } from "./ports.js";

/** The slice of the fencing lease store this class uses. */
export interface FencingLeasePort {
  acquire(input: {
    readonly accountRef: string;
    readonly environment: string;
    readonly maximumRunMode: string;
    readonly allowRealOrders: boolean;
    readonly holderId: string;
    readonly holderHostname?: string | null;
    readonly holderPid?: number | null;
    readonly ttlMs: number;
    readonly takeover?: FencingTakeover | null;
  }): Promise<FencingAcquireOutcome>;
  renew(lease: FencingLeaseRef, ttlMs: number): Promise<FencingRenewOutcome>;
  release(lease: FencingLeaseRef, reason: string): Promise<boolean>;
  recordHeartbeatId(lease: FencingLeaseRef, heartbeatId: string): Promise<boolean>;
}

export type FenceLossReason = "EXPIRED" | "RENEW_LOST" | "CLOCK_FAULT" | "RELEASED";

/** The (lease, token) pair a live submission is persisted with (§9.18; migration 0005's attempt columns). */
export interface Fence {
  readonly fencingLeaseId: string;
  readonly fencingToken: string;
}

export type FenceCheck =
  | { readonly held: true; readonly fence: Fence; readonly remainingMs: number }
  | { readonly held: false; readonly reason: "NOT_ACQUIRED" | "EXPIRING" | FenceLossReason };

export type AcquireResult =
  | { readonly kind: "ACQUIRED"; readonly fence: Fence; readonly inheritedHeartbeatId: string | null }
  | { readonly kind: "HELD_ELSEWHERE"; readonly holderId: string; readonly expiresAt: string }
  /** The incumbent has ended; this process is waiting it out (module header). Ask again after `remainingMs`. */
  | { readonly kind: "LAPSED_WAITING"; readonly holderId: string; readonly status: string; readonly remainingMs: number }
  | { readonly kind: "CONTENDED" }
  | { readonly kind: "ALREADY_HELD" }
  | { readonly kind: "STORE_FAILED" };

/** `IN_PROGRESS`: another renewal of this grant is still outstanding (renewals are serialized); nothing was asked. */
export type RenewResult = "RENEWED" | "LOST" | "UNKNOWN" | "NOT_HELD" | "IN_PROGRESS";

/** Why a run-mode context may not hold the live fence (the `assertSignerGate` vocabulary). */
export type LiveFencingRefusalReason =
  | "CONTEXT_UNREADABLE"
  | "RUN_MODE_UNKNOWN"
  | "RUN_MODE_REQUIRES_NO_SIGNER"
  | "MAXIMUM_RUN_MODE_UNKNOWN"
  | "RUN_MODE_ABOVE_MAXIMUM"
  | "REAL_ORDERS_NOT_ALLOWED";

/** A run-mode context that may never hold the live fence. A fixed message; the refused value is named only if it is a §11 mode. */
export class LiveFencingRefusal extends Error {
  override readonly name = "LiveFencingRefusal";
  readonly runMode: string;
  readonly reasons: readonly LiveFencingRefusalReason[];

  constructor(runMode: unknown, reasons: readonly LiveFencingRefusalReason[]) {
    const named = RUN_MODES.find((candidate) => candidate === runMode) ?? "(not a run mode)";
    super(`run mode ${named} cannot acquire live fencing: ${reasons.join(", ")} (ADR-008 §2; ADR-010)`);
    this.runMode = named;
    this.reasons = Object.freeze([...reasons]);
    Object.freeze(this);
  }
}

/**
 * The process's run-mode context, as its composition root establishes it (`RUN_MODE`, `MAX_RUN_MODE`,
 * `ALLOW_REAL_ORDERS`): the same three fields `assertSignerGate` reads.
 */
export interface RunModeContext {
  readonly runMode: string;
  readonly maximumRunMode: string;
  readonly allowRealOrders: boolean;
}

/** A context {@link evaluateLiveFencingContext} permitted. */
export interface PermittedRunModeContext {
  readonly runMode: RunMode;
  readonly maximumRunMode: RunMode;
  readonly allowRealOrders: true;
}

const CONTEXT_KEYS = ["allowRealOrders", "maximumRunMode", "runMode"] as const;

function isRunMode(value: unknown): value is RunMode {
  return typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);
}

/**
 * ADR-010 §1, as the signer gate applies it: permitted only when the run mode requires a live signer, does not exceed
 * `maximumRunMode` (a §11 run mode), and `allowRealOrders` is the boolean `true`. The context is read as EXACTLY three
 * own data properties of a plain object, each read once and copied; anything else — a getter, an extra or inherited
 * field, a reflection that throws — is `CONTEXT_UNREADABLE`. Never throws.
 */
export function evaluateLiveFencingContext(
  input: unknown,
): { readonly permitted: true; readonly context: PermittedRunModeContext } | { readonly permitted: false; readonly runMode: unknown; readonly reasons: readonly LiveFencingRefusalReason[] } {
  let values: Record<string, unknown> | undefined;
  try {
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const prototype: unknown = Object.getPrototypeOf(input);
      const keys = Reflect.ownKeys(input);
      if ((prototype === Object.prototype || prototype === null) && keys.length === CONTEXT_KEYS.length) {
        const read: Record<string, unknown> = {};
        let complete = true;
        for (const key of CONTEXT_KEYS) {
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (descriptor === undefined || !("value" in descriptor)) {
            complete = false;
            break;
          }
          read[key] = descriptor.value;
        }
        if (complete) values = read;
      }
    }
  } catch {
    values = undefined;
  }
  if (values === undefined) return Object.freeze({ permitted: false as const, runMode: undefined, reasons: Object.freeze(["CONTEXT_UNREADABLE" as const]) });
  const { runMode, maximumRunMode, allowRealOrders } = values;
  const reasons: LiveFencingRefusalReason[] = [];
  if (!isRunMode(runMode)) reasons.push("RUN_MODE_UNKNOWN");
  else if (!RUN_MODE_REQUIRES_LIVE_SIGNER[runMode]) reasons.push("RUN_MODE_REQUIRES_NO_SIGNER");
  if (!isRunMode(maximumRunMode)) reasons.push("MAXIMUM_RUN_MODE_UNKNOWN");
  else if (isRunMode(runMode) && runModeExceeds(runMode, maximumRunMode)) reasons.push("RUN_MODE_ABOVE_MAXIMUM");
  if (allowRealOrders !== true) reasons.push("REAL_ORDERS_NOT_ALLOWED");
  if (reasons.length > 0 || !isRunMode(runMode) || !isRunMode(maximumRunMode) || allowRealOrders !== true) {
    return Object.freeze({ permitted: false as const, runMode, reasons: Object.freeze(reasons.length > 0 ? reasons : ["CONTEXT_UNREADABLE" as const]) });
  }
  return Object.freeze({ permitted: true as const, context: Object.freeze({ runMode, maximumRunMode, allowRealOrders: true as const }) });
}

/**
 * Throwing form of {@link evaluateLiveFencingContext}.
 *
 * @throws {LiveFencingRefusal} with every applicable reason.
 */
export function assertLiveFencingContext(input: unknown): PermittedRunModeContext {
  const verdict = evaluateLiveFencingContext(input);
  if (!verdict.permitted) throw new LiveFencingRefusal(verdict.runMode, verdict.reasons);
  return verdict.context;
}

/** An option this class refuses. */
export class FencingAuthorityConfigurationError extends Error {
  override readonly name = "FencingAuthorityConfigurationError";
  constructor(readonly field: string) {
    super(`fencing authority configuration refused: ${field}`);
    Object.freeze(this);
  }
}

/** The run modes that submit real orders (§11; `RUN_MODE_REQUIRES_LIVE_SIGNER`). Anything else is refused. */
export function isLiveRunMode(value: unknown): value is RunMode {
  const mode = RUN_MODES.find((candidate) => candidate === value);
  return mode !== undefined && RUN_MODE_REQUIRES_LIVE_SIGNER[mode];
}

export interface FencingAuthorityOptions {
  /** The process's run-mode context. Checked FIRST: a simulated mode, or one above the ceiling, is refused before anything else is read. */
  readonly runModeContext: RunModeContext;
  readonly accountRef: string;
  readonly holderId: string;
  readonly holderHostname?: string | null;
  readonly holderPid?: number | null;
  readonly store: FencingLeasePort;
  readonly clock: MonotonicClock;
  /** The lease's lifetime, applied by the database's clock. */
  readonly ttlMs: number;
  /** Subtracted from every local deadline: the clock-rate drift and scheduling allowance. */
  readonly safetyMarginMs: number;
  /** The least validity left at which a submission or a heartbeat may still START. */
  readonly transmitMarginMs: number;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new FencingAuthorityConfigurationError(field);
  return value;
}

/** An ended incumbent this process is waiting out, and when it was first seen (monotonic, after the call). */
interface Observation {
  readonly incumbent: FencingIncumbent;
  readonly firstSeenAtMs: number;
}

export class FencingAuthority {
  readonly #options: FencingAuthorityOptions;
  readonly #context: PermittedRunModeContext;
  #grant: FencingGrant | null = null;
  #observed: Observation | null = null;
  /** The local deadline (monotonic), or `null` with no grant. */
  #deadline: number | null = null;
  #lost: FenceLossReason | null = null;
  #lastNow: number | null = null;
  #renewing = false;
  #acquiring = false;

  private constructor(options: FencingAuthorityOptions, context: PermittedRunModeContext) {
    this.#options = options;
    this.#context = context;
  }

  /**
   * @throws {LiveFencingRefusal} for a run-mode context that may not submit real orders, before anything else is read.
   * @throws {FencingAuthorityConfigurationError} for margins that leave no usable lease.
   */
  static create(options: FencingAuthorityOptions): FencingAuthority {
    const context = assertLiveFencingContext(typeof options === "object" && options !== null ? options.runModeContext : undefined);
    const ttl = positiveInteger(options.ttlMs, "ttlMs");
    const safety = positiveInteger(options.safetyMarginMs, "safetyMarginMs");
    const transmit = positiveInteger(options.transmitMarginMs, "transmitMarginMs");
    if (safety + transmit >= ttl) throw new FencingAuthorityConfigurationError("margins");
    if (typeof options.store !== "object" || options.store === null) throw new FencingAuthorityConfigurationError("store");
    if (typeof options.clock !== "object" || options.clock === null) throw new FencingAuthorityConfigurationError("clock");
    return new FencingAuthority(Object.freeze({ ...options }), context);
  }

  /** How long an ended incumbent's version must stay unchanged, on this clock, before a takeover is presented. */
  get takeoverWaitMs(): number {
    return this.#options.ttlMs + this.#options.safetyMarginMs;
  }

  /**
   * Acquire the fence: a new grant with a new token. Refused while this process already holds one. Over an ended
   * incumbent, `LAPSED_WAITING` until its version has stayed unchanged for {@link FencingAuthority.takeoverWaitMs}
   * on this clock; the composition asks again (module header).
   */
  async acquire(): Promise<AcquireResult> {
    if (this.#acquiring) return Object.freeze({ kind: "CONTENDED" as const });
    if (this.check().held) return Object.freeze({ kind: "ALREADY_HELD" as const });
    // A grant still on record (expiring, or lost) ends first: locally at once, and in the database best effort, so its
    // row records why. Its token is never used again.
    const previous = this.#grant;
    this.#acquiring = true;
    try {
      if (previous !== null) {
        this.#lose("RELEASED");
        await this.#releaseQuietly(previous, "superseded by a new acquisition of the same process");
      }
      const before = this.#now();
      if (before === null) {
        this.#observed = null;
        return Object.freeze({ kind: "STORE_FAILED" as const });
      }
      const observed = this.#observed;
      const waitedOut = observed !== null && before - observed.firstSeenAtMs >= this.takeoverWaitMs;
      const takeover: FencingTakeover | null =
        waitedOut && observed !== null
          ? { fencingLeaseId: observed.incumbent.fencingLeaseId, fencingToken: observed.incumbent.fencingToken, version: observed.incumbent.version }
          : null;
      let outcome: FencingAcquireOutcome;
      try {
        outcome = await this.#options.store.acquire({
          accountRef: this.#options.accountRef,
          environment: this.#context.runMode,
          maximumRunMode: this.#context.maximumRunMode,
          allowRealOrders: this.#context.allowRealOrders,
          holderId: this.#options.holderId,
          holderHostname: this.#options.holderHostname ?? null,
          holderPid: this.#options.holderPid ?? null,
          ttlMs: this.#options.ttlMs,
          takeover,
        });
      } catch {
        return Object.freeze({ kind: "STORE_FAILED" as const });
      }
      if (outcome.kind === "HELD") {
        this.#observed = null;
        return Object.freeze({ kind: "HELD_ELSEWHERE" as const, holderId: outcome.holderId, expiresAt: outcome.expiresAt });
      }
      if (outcome.kind === "CONTENDED") {
        this.#observed = null;
        return Object.freeze({ kind: "CONTENDED" as const });
      }
      if (outcome.kind === "LAPSED") {
        // First sight of this version is timed AFTER the call: the version was committed before it returned.
        const after = this.#now();
        const incumbent = outcome.incumbent;
        if (after === null) {
          this.#observed = null;
          return Object.freeze({ kind: "STORE_FAILED" as const });
        }
        const same =
          observed !== null &&
          observed.incumbent.fencingLeaseId === incumbent.fencingLeaseId &&
          observed.incumbent.fencingToken === incumbent.fencingToken &&
          observed.incumbent.version === incumbent.version;
        const current: Observation = same ? observed : { incumbent, firstSeenAtMs: after };
        this.#observed = current;
        return Object.freeze({
          kind: "LAPSED_WAITING" as const,
          holderId: incumbent.holderId,
          status: incumbent.status,
          remainingMs: Math.max(0, current.firstSeenAtMs + this.takeoverWaitMs - after),
        });
      }
      this.#observed = null;
      this.#grant = outcome.grant;
      this.#deadline = before + this.#options.ttlMs - this.#options.safetyMarginMs;
      this.#lost = null;
      return Object.freeze({
        kind: "ACQUIRED" as const,
        fence: Object.freeze({ fencingLeaseId: outcome.grant.fencingLeaseId, fencingToken: outcome.grant.fencingToken }),
        inheritedHeartbeatId: outcome.grant.inheritedHeartbeatId,
      });
    } finally {
      this.#acquiring = false;
    }
  }

  /** Extend the grant. A lost grant is never renewed: only a new acquisition restores authority. */
  async renew(): Promise<RenewResult> {
    const grant = this.#grant;
    if (grant === null) return "NOT_HELD";
    // A deadline that has passed is lost now (`check` latches it), whatever the database would say; a lost grant is
    // never renewed, even when the database would still accept it (a renewal it applied but whose answer was lost).
    this.check();
    if (this.#lost !== null) return "NOT_HELD";
    if (this.#renewing) return "IN_PROGRESS";
    this.#renewing = true;
    try {
      const before = this.#now();
      if (before === null) return "NOT_HELD";
      let outcome: FencingRenewOutcome;
      try {
        outcome = await this.#options.store.renew(this.#ref(grant), this.#options.ttlMs);
      } catch {
        // Unknown: the old deadline stands.
        return "UNKNOWN";
      }
      // The grant may have been lost (or replaced) while the call was outstanding: a late answer changes nothing.
      if (this.#grant !== grant || this.#lost !== null) return "NOT_HELD";
      if (outcome.kind === "LOST") {
        this.#lose("RENEW_LOST");
        return "LOST";
      }
      const after = this.#now();
      if (after === null) return "NOT_HELD";
      const next = before + this.#options.ttlMs - this.#options.safetyMarginMs;
      // Never shortened by a renewal, never extended past what this renewal proves.
      if (this.#deadline === null || next > this.#deadline) this.#deadline = next;
      return "RENEWED";
    } finally {
      this.#renewing = false;
    }
  }

  /** Synchronous: whether this process may START a submission or a heartbeat now. */
  check(): FenceCheck {
    const grant = this.#grant;
    if (grant === null) return Object.freeze({ held: false as const, reason: "NOT_ACQUIRED" as const });
    if (this.#lost !== null) return Object.freeze({ held: false as const, reason: this.#lost });
    const now = this.#now();
    if (now === null || this.#deadline === null) return Object.freeze({ held: false as const, reason: this.#lost ?? "CLOCK_FAULT" });
    if (now >= this.#deadline) {
      this.#lose("EXPIRED");
      return Object.freeze({ held: false as const, reason: "EXPIRED" as const });
    }
    const remainingMs = this.#deadline - now;
    if (remainingMs < this.#options.transmitMarginMs) return Object.freeze({ held: false as const, reason: "EXPIRING" as const });
    return Object.freeze({ held: true as const, fence: Object.freeze({ fencingLeaseId: grant.fencingLeaseId, fencingToken: grant.fencingToken }), remainingMs });
  }

  /** The fence a live submission attempt is persisted with, while held; `null` otherwise. */
  currentFence(): Fence | null {
    const check = this.check();
    return check.held ? check.fence : null;
  }

  /** The reason the grant was lost, latched; `null` while held or never acquired. */
  lossReason(): FenceLossReason | null {
    return this.#lost;
  }

  /** Persist the venue heartbeat id on the held lease (ADR-008 §4). `false` when not held, or the store refused. */
  async recordHeartbeatId(heartbeatId: string): Promise<boolean> {
    const grant = this.#grant;
    if (grant === null || !this.check().held) return false;
    try {
      return (await this.#options.store.recordHeartbeatId(this.#ref(grant), heartbeatId)) === true;
    } catch {
      return false;
    }
  }

  /** Release the fence, recording why (in the statement that ends it). Authority ends locally first. */
  async release(reason: string): Promise<boolean> {
    const grant = this.#grant;
    if (grant === null) return false;
    this.#lose("RELEASED");
    return this.#releaseQuietly(grant, reason);
  }

  #ref(grant: FencingGrant): FencingLeaseRef {
    return { fencingLeaseId: grant.fencingLeaseId, fencingToken: grant.fencingToken, holderId: grant.holderId };
  }

  async #releaseQuietly(grant: FencingGrant, reason: string): Promise<boolean> {
    try {
      return (await this.#options.store.release(this.#ref(grant), reason)) === true;
    } catch {
      return false;
    }
  }

  #lose(reason: FenceLossReason): void {
    if (this.#lost === null) this.#lost = reason;
  }

  /** The monotonic clock, or `null` on a fault (unreadable, or behind a reading already seen), which loses the grant. */
  #now(): number | null {
    let value: unknown;
    try {
      value = this.#options.clock.monotonicMs();
    } catch {
      value = undefined;
    }
    const reading = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    if (reading !== null && (this.#lastNow === null || reading >= this.#lastNow)) {
      this.#lastNow = reading;
      return reading;
    }
    if (reading !== null) this.#lastNow = reading;
    if (this.#grant !== null) this.#lose("CLOCK_FAULT");
    return null;
  }
}
