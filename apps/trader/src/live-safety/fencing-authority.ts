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
 * ## Paper mode cannot acquire live fencing
 *
 * {@link FencingAuthority.create} refuses every run mode that does not submit
 * real orders (`RUN_MODE_REQUIRES_LIVE_SIGNER`: BACKTEST, PAPER, SHADOW) and
 * every value that is not a §11 run mode, before it touches the store. The
 * store refuses them again before any SQL, and the database's
 * `fencing_leases_real_modes_only` CHECK a third time (ADR-008 §2; ADR-010).
 */

import { RUN_MODE_REQUIRES_LIVE_SIGNER, RUN_MODES, type RunMode } from "@polymarket-bot/domain";
import type { FencingAcquireOutcome, FencingLeaseRef, FencingRenewOutcome, FencingGrant } from "@polymarket-bot/storage-postgres";

import type { MonotonicClock } from "./ports.js";

/** The slice of the fencing lease store this class uses. */
export interface FencingLeasePort {
  acquire(input: {
    readonly accountRef: string;
    readonly environment: string;
    readonly holderId: string;
    readonly holderHostname?: string | null;
    readonly holderPid?: number | null;
    readonly ttlMs: number;
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
  | { readonly kind: "CONTENDED" }
  | { readonly kind: "ALREADY_HELD" }
  | { readonly kind: "STORE_FAILED" };

export type RenewResult = "RENEWED" | "LOST" | "UNKNOWN" | "NOT_HELD";

/** A run mode that may never hold the live fence. A fixed message; the refused value is named only if it is a §11 mode. */
export class LiveFencingRefusal extends Error {
  override readonly name = "LiveFencingRefusal";
  readonly runMode: string;

  constructor(runMode: unknown) {
    const named = RUN_MODES.find((candidate) => candidate === runMode) ?? "(not a run mode)";
    super(`run mode ${named} cannot acquire live fencing (ADR-008 §2; ADR-010)`);
    this.runMode = named;
    Object.freeze(this);
  }
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
  /** The process's run mode. Checked FIRST: a simulated mode is refused before anything else is read. */
  readonly runMode: string;
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

export class FencingAuthority {
  readonly #options: FencingAuthorityOptions;
  #grant: FencingGrant | null = null;
  /** The local deadline (monotonic), or `null` with no grant. */
  #deadline: number | null = null;
  #lost: FenceLossReason | null = null;
  #lastNow: number | null = null;
  #renewing = false;
  #acquiring = false;

  private constructor(options: FencingAuthorityOptions) {
    this.#options = options;
  }

  /**
   * @throws {LiveFencingRefusal} for a run mode that does not submit real orders, before anything else is read.
   * @throws {FencingAuthorityConfigurationError} for margins that leave no usable lease.
   */
  static create(options: FencingAuthorityOptions): FencingAuthority {
    const runMode: unknown = typeof options === "object" && options !== null ? options.runMode : undefined;
    if (!isLiveRunMode(runMode)) throw new LiveFencingRefusal(runMode);
    const ttl = positiveInteger(options.ttlMs, "ttlMs");
    const safety = positiveInteger(options.safetyMarginMs, "safetyMarginMs");
    const transmit = positiveInteger(options.transmitMarginMs, "transmitMarginMs");
    if (safety + transmit >= ttl) throw new FencingAuthorityConfigurationError("margins");
    if (typeof options.store !== "object" || options.store === null) throw new FencingAuthorityConfigurationError("store");
    if (typeof options.clock !== "object" || options.clock === null) throw new FencingAuthorityConfigurationError("clock");
    return new FencingAuthority(Object.freeze({ ...options }));
  }

  /** Acquire the fence: a new grant with a new token. Refused while this process already holds one. */
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
      if (before === null) return Object.freeze({ kind: "STORE_FAILED" as const });
      let outcome: FencingAcquireOutcome;
      try {
        outcome = await this.#options.store.acquire({
          accountRef: this.#options.accountRef,
          environment: this.#options.runMode,
          holderId: this.#options.holderId,
          holderHostname: this.#options.holderHostname ?? null,
          holderPid: this.#options.holderPid ?? null,
          ttlMs: this.#options.ttlMs,
        });
      } catch {
        return Object.freeze({ kind: "STORE_FAILED" as const });
      }
      if (outcome.kind === "HELD") return Object.freeze({ kind: "HELD_ELSEWHERE" as const, holderId: outcome.holderId, expiresAt: outcome.expiresAt });
      if (outcome.kind === "CONTENDED") return Object.freeze({ kind: "CONTENDED" as const });
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
    if (grant === null || this.#lost !== null) return "NOT_HELD";
    // A deadline that has passed is lost now, whatever the database would say.
    if (!this.check().held && this.#lost !== null) return "NOT_HELD";
    if (this.#renewing) return "UNKNOWN";
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
