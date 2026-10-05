/**
 * The PostgreSQL fencing lease (WP-320 deliverable 1; handoff §9.18, §6
 * invariant 16; ADR-008 §1–§2).
 *
 * > "Redis is not sufficient as the only fence. Use a PostgreSQL advisory lock
 * > or lease with a monotonic fencing token persisted with every live
 * > submission." — handoff §9.18
 *
 * `WP-040` built the fence's database half (`db/migrations/0007_ops.up.sql`,
 * `0008`): one ACTIVE lease per account and execution realm (a partial unique
 * index), a token that only ever rises (`ops.fencing_token_high_water` and the
 * `fencing_leases_monotonic_token` trigger), a forward-only lease state machine
 * (`fencing_leases_forward_only`, SQLSTATE `PMB10`), a CHECK that refuses a
 * lease in a simulated run mode (`fencing_leases_real_modes_only`), and a
 * trigger that refuses a live order or submission attempt naming a lease that
 * is not ACTIVE and unexpired AT THE DATABASE'S CLOCK
 * (`internal.assert_valid_fencing_reference`, `PMB06`). This module is the
 * lease's lifecycle on top of those facts: acquire, renew, record the venue
 * heartbeat id, release and revoke.
 *
 * ## The rules this store adds, and why each is here
 *
 * - **Expiry is the database's clock, never the caller's.** `acquire` and
 *   `renew` take a TTL, and the row's `expires_at` is `clock_timestamp() +
 *   ttl`, computed by PostgreSQL in the statement. `WP-040`'s repository took a
 *   caller-supplied `expiresAt`, so a caller whose wall clock ran ahead could
 *   grant itself a lease that outlives every honest one. The validity trigger
 *   already judges expiry by `clock_timestamp()`; now the expiry it judges was
 *   written by the same clock.
 * - **Every write names the whole grant: lease id, token AND holder.** A
 *   process may renew, record a heartbeat id on, or release only the lease it
 *   was granted, and only while that lease is ACTIVE (renew and the heartbeat
 *   id: and unexpired) at the database's clock. A STALE HOLDER — one whose
 *   lease expired, was released, revoked, or taken over — matches no row, so
 *   it can never renew (ADR-008 §2). It can never submit either: the attempt
 *   insert names its old lease, which the validity trigger refuses.
 * - **A holder write that requires an unexpired lease LOCKS FIRST, then
 *   judges** (`WP-320` r1, finding I4). `renew` and `recordHeartbeatId` take
 *   the row lock with a `SELECT … FOR UPDATE` that judges nothing, and only
 *   then, in a SEPARATE statement of the same transaction, test ACTIVE and
 *   `expires_at > clock_timestamp()`. A single `UPDATE … WHERE expires_at >
 *   clock_timestamp()` evaluates its predicate BEFORE it waits for a row lock,
 *   and PostgreSQL re-checks it after the wait only when the lock holder
 *   CHANGED the row: a lock-only holder (migration 0008's `FOR SHARE` in the
 *   attempt-insert trigger) let a renewal that waited past the expiry revive
 *   the lease. The second statement runs under the lock already held, so it
 *   waits for nothing and its clock is read after the wait.
 * - **A simulated run mode, or one above the process's ceiling, never reaches
 *   SQL.** `acquire` refuses `BACKTEST`, `PAPER`, `SHADOW` and anything that
 *   is not a §11 run mode ({@link NonRealModeFencingLeaseError}), then a run
 *   mode above the caller's `maximumRunMode` or without `allowRealOrders:
 *   true` ({@link FencingRunModeNotPermittedError}; ADR-010 §1–§3, the same
 *   three conditions `assertSignerGate` applies), before it opens a
 *   transaction; the database CHECK is the last layer. "Paper mode cannot
 *   acquire live fencing" (work plan `WP-320` acceptance; ADR-008 §2,
 *   ADR-010).
 * - **No lease is ever longer than {@link FENCING_LEASE_MAX_TTL_MS}** (`WP-320`
 *   r2, finding X1). `acquire` and `renew` — every grant and every renewal
 *   this store makes — refuse a TTL above it before any SQL. It is a CODE
 *   constant, not configuration: it is the bound every successor waits out
 *   (next rule), so two processes can never disagree about it, whatever each
 *   was configured with.
 * - **A takeover waits out the incumbent on the SUCCESSOR's clock, never on
 *   the database's** (`WP-320` r1, finding I1; ADR-008: "Failover is not
 *   instant and must not be"). The incumbent is the realm's ACTIVE lease, or
 *   else its latest lease by token. While it is ACTIVE and unexpired the
 *   answer is `HELD`. Once it has ENDED in any way — expired by the database's
 *   clock, revoked by an operator, released by its holder, labelled EXPIRED —
 *   the answer is `LAPSED`, carrying the incumbent's VERSION (its status,
 *   expiry and last update, as the database wrote them). A grant is made only
 *   to a caller that presents that exact version back as `takeover`, which
 *   the in-process authority (`apps/trader/src/live-safety/fencing-authority.ts`)
 *   does only after it has watched the SAME version, unchanged, for
 *   {@link FENCING_LEASE_MAX_TTL_MS} plus its safety margin on its own
 *   monotonic clock — the longest lease ANY holder can have been granted, not
 *   the successor's own TTL (r2 X1: a successor configured with a shorter TTL
 *   took over while a longer-lived incumbent still held). Why: the old holder
 *   acts on a LOCAL deadline (its last successful renewal's start + its ttl −
 *   its margin, its ttl at most the bound), which neither a revocation nor a
 *   database clock that steps forward shortens; the version it last wrote was
 *   committed before the successor saw it, so a successor that waits the
 *   bound from that sighting starts after the old holder's deadline, whatever
 *   the database's clock did and whatever either was configured with. An
 *   immediate takeover — after a revocation, or after an expiry the database
 *   judged early — left two usable authorities (r1 I1). A version that changes
 *   while the successor waits (a renewal, a relabel) restarts its wait.
 * - **And the incumbent's own expiry must have passed at the database's
 *   clock** (r2 X1, the durable bound). Even with its exact version presented,
 *   a takeover over an incumbent whose `expires_at` still lies ahead (a lease
 *   revoked or released early) is answered `LAPSED`, with the time left by
 *   the database's clock (`databaseRemainingMs`). For every grant this store
 *   made the local wait already covers it; it bounds the grants this store did
 *   NOT make — `WP-040`'s `acquireLease` and `recordHeartbeat` take a caller's
 *   `expiresAt`, which no TTL bound reaches — by the expiry they wrote. The
 *   ACTIVE incumbent is moved to `EXPIRED`, with its reason, in the statement
 *   that ends it (a terminal lease can never be annotated afterwards: `WP-040`
 *   R15/F14), on the acquisition path (`WP-040` F11).
 * - **The next token is the high-water mark plus one**, read under a
 *   transaction-scoped advisory lock on the SAME key `WP-040`'s repository
 *   takes (`fencing:<account>:<realm>`), so the two acquisition paths
 *   serialize against each other. The insert trigger advances and re-checks
 *   the mark; the partial unique index refuses a second ACTIVE lease. A writer
 *   that bypasses the advisory lock therefore still cannot hold authority
 *   twice: it gets {@link FencingAcquireOutcome} `CONTENDED`.
 *   **`WP-040`'s `createFencingRepository().acquireLease` does not wait out a
 *   revoked or early-expired incumbent**; the live composition binds THIS
 *   store, and never that repository's acquisition (disclosed residual).
 * - **The heartbeat id is lease state (ADR-008 §4, consequence 1).** It is
 *   recorded only on the holder's ACTIVE, unexpired lease, and a new grant
 *   reports the id the realm's previous lease last recorded
 *   (`inheritedHeartbeatId`), so a failover can resume the venue's id chain
 *   or bootstrap from empty.
 *
 * ## What this store does not do
 *
 * It keeps no state and reads no clock of its own: whether the PROCESS may
 * still act on a grant is the in-process fencing authority's question
 * (`apps/trader/src/live-safety/fencing-authority.ts`), which measures the
 * grant's lifetime on the process's monotonic clock from the instant BEFORE
 * the call that obtained it. It sends nothing to the venue, and it never
 * writes a lease in a simulated run mode. PAPER only.
 */

import { runModeExceeds } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import {
  FencingTokenNotMonotonicError,
  NonRealModeFencingLeaseError,
  StoragePostgresError,
  UniqueViolationError,
  withMappedErrors,
} from "../errors.js";
import { uuidV7 } from "../ids.js";
import { executionRealm, isRealOrderRunMode, RUN_MODES, type LeaseStatusValue, type RunModeValue } from "../schema/enums.js";
import type { IsoTimestamp } from "../timestamps.js";

/** The shortest lease a caller may ask for. A guard on configuration, not a venue fact. */
export const FENCING_LEASE_MIN_TTL_MS = 1_000;
/**
 * The longest lease ANY holder may be granted or renewed to (one minute): `acquire` and `renew` refuse more, before
 * any SQL. Not configuration but part of the fencing protocol (module header, r2 X1): every successor waits THIS out,
 * plus its safety margin, on its own clock before it presents a takeover, so it covers every incumbent this store
 * granted, whatever TTL either side was configured with. A protocol bound, not a venue fact; a longer lease makes
 * every failover slower by the same amount.
 */
export const FENCING_LEASE_MAX_TTL_MS = 60_000;
/** `internal.identifier`: 1…200 characters. */
export const FENCING_IDENTIFIER_MAX_LENGTH = 200;
/** `internal.detail`: at most 2000 characters. */
export const FENCING_REASON_MAX_LENGTH = 2_000;
/**
 * The longest venue heartbeat id this store records. The venue documents no
 * bound (`docs/venue/verified-2026-09-30.md` §5); this is a guard, and an id
 * beyond it is refused, never truncated.
 */
export const FENCING_HEARTBEAT_ID_MAX_LENGTH = 512;

/** The longest incumbent version a takeover may present (the store writes far shorter ones). */
export const FENCING_VERSION_MAX_LENGTH = 200;

/** What the realm's lapsed leases are labelled with when an acquisition ends them. */
const TAKEOVER_EXPIRY_REASON = "lease expired before a new acquisition (ADR-008: a takeover requires the incumbent to have expired)";

/** A request for the account's fence. */
export interface AcquireFencingLeaseInput {
  readonly accountRef: string;
  /** Read as a §11 run mode; anything else, and every simulated mode, is refused before any SQL. */
  readonly environment: string;
  /** The process's run-mode ceiling (`MAX_RUN_MODE`): `environment` may not exceed it (ADR-010 §1). */
  readonly maximumRunMode: string;
  /** `ALLOW_REAL_ORDERS`: exactly the boolean `true`, or the acquisition is refused before any SQL (ADR-010 §1). */
  readonly allowRealOrders: boolean;
  readonly holderId: string;
  readonly holderHostname?: string | null;
  readonly holderPid?: number | null;
  /** The lease's lifetime, applied by the DATABASE's clock. */
  readonly ttlMs: number;
  /**
   * The ended incumbent this caller has watched, unchanged, for a whole lease on its own monotonic clock
   * (`LAPSED`'s `incumbent`, presented back). A grant over an ended incumbent is made ONLY when this names its
   * current version exactly; `null` or absent asks, and is answered `LAPSED`.
   */
  readonly takeover?: FencingTakeover | null;
}

/** An ended incumbent, as a takeover presents it back. */
export interface FencingTakeover {
  readonly fencingLeaseId: string;
  readonly fencingToken: string;
  readonly version: string;
}

/** The realm's latest lease, ended (expired by the database's clock, revoked, released, or labelled EXPIRED). */
export interface FencingIncumbent {
  readonly fencingLeaseId: string;
  readonly fencingToken: string;
  readonly holderId: string;
  readonly status: LeaseStatusValue;
  readonly expiresAt: IsoTimestamp;
  /** Its status, expiry and last update as the database wrote them: any change to the row changes it. */
  readonly version: string;
  /**
   * How long until `expiresAt` by the DATABASE's clock, in whole milliseconds rounded up (0 once it has passed;
   * capped at 2^31 − 1). A takeover is granted only once it is 0, whatever was presented (module header, r2 X1).
   */
  readonly databaseRemainingMs: number;
}

/** A granted lease: the fence a process may act under until `expiresAt` (database clock). */
export interface FencingGrant {
  readonly fencingLeaseId: string;
  /** `bigint` as a decimal string: 2^63 exceeds what a JavaScript number holds. */
  readonly fencingToken: string;
  readonly accountRef: string;
  readonly environment: RunModeValue;
  readonly holderId: string;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /** The venue heartbeat id the realm's previous lease last recorded (ADR-008 §4), or `null`. */
  readonly inheritedHeartbeatId: string | null;
}

export type FencingAcquireOutcome =
  | { readonly kind: "ACQUIRED"; readonly grant: FencingGrant }
  /** An unexpired ACTIVE lease exists: one fenced live writer per account and realm (§2, ADR-008 §2). */
  | { readonly kind: "HELD"; readonly holderId: string; readonly fencingToken: string; readonly expiresAt: IsoTimestamp }
  /**
   * The realm's latest lease has ended, but no takeover naming its current version was presented, or its expiry
   * still lies ahead by the database's clock: the caller must watch this version, unchanged, for
   * {@link FENCING_LEASE_MAX_TTL_MS} plus its margin on its own clock before presenting it, and is granted only once
   * `databaseRemainingMs` is 0 (module header).
   */
  | { readonly kind: "LAPSED"; readonly incumbent: FencingIncumbent }
  /** A concurrent acquisition that bypassed the advisory lock won the race at the database's constraints. */
  | { readonly kind: "CONTENDED" };

/** The whole grant a write must name: a stale holder's reference matches no row. */
export interface FencingLeaseRef {
  readonly fencingLeaseId: string;
  readonly fencingToken: string;
  readonly holderId: string;
}

export type FencingRenewOutcome =
  | { readonly kind: "RENEWED"; readonly expiresAt: IsoTimestamp }
  /** The lease is not this holder's ACTIVE, unexpired lease any more. Authority is gone; only a new acquisition (a new token) restores it. */
  | { readonly kind: "LOST" };

/** The realm's valid lease, as the database sees it now. */
export interface FencingLeaseView {
  readonly fencingLeaseId: string;
  readonly fencingToken: string;
  readonly accountRef: string;
  readonly environment: RunModeValue;
  readonly holderId: string;
  readonly heartbeatId: string | null;
  readonly expiresAt: IsoTimestamp;
}

export interface FencingLeaseStore {
  /**
   * Acquire the account's fence for this realm, allocating the next token.
   *
   * @throws {NonRealModeFencingLeaseError} for a simulated or unrecognised run mode, before any SQL.
   * @throws {FencingRunModeNotPermittedError} for a run mode above `maximumRunMode`, or without `allowRealOrders`, before any SQL.
   * @throws {FencingLeaseInputError} for an invalid input, before any SQL.
   */
  acquire(input: AcquireFencingLeaseInput): Promise<FencingAcquireOutcome>;
  /** Extend this holder's ACTIVE, unexpired lease to `clock_timestamp() + ttlMs`; `LOST` otherwise. */
  renew(lease: FencingLeaseRef, ttlMs: number): Promise<FencingRenewOutcome>;
  /** Record the venue's current heartbeat id on this holder's ACTIVE, unexpired lease; `false` otherwise. */
  recordHeartbeatId(lease: FencingLeaseRef, heartbeatId: string): Promise<boolean>;
  /** End this holder's ACTIVE lease, recording why in the same statement; `false` when it had already ended. */
  release(lease: FencingLeaseRef, reason: string): Promise<boolean>;
  /**
   * An operator's revocation of an ACTIVE lease, with its reason; `false` when it had already ended. The holder's
   * next renewal finds it LOST; a successor still waits out {@link FENCING_LEASE_MAX_TTL_MS} plus its margin from its
   * first sight of the revoked row, and the revoked row's own expiry by the database's clock (module header).
   */
  revoke(input: { readonly fencingLeaseId: string; readonly reason: string }): Promise<boolean>;
  /** Whether `lease` is still ACTIVE and unexpired at the database's clock. */
  isValid(lease: FencingLeaseRef): Promise<boolean>;
  /** The realm's ACTIVE, unexpired lease, or `null`. */
  current(accountRef: string, environment: string): Promise<FencingLeaseView | null>;
}

/** An input this store refuses before any SQL. Carries a fixed code and the field name only. */
export class FencingLeaseInputError extends StoragePostgresError {
  public constructor(public readonly field: string) {
    super("FENCING_LEASE_INPUT_INVALID", `fencing lease input refused: ${field} is missing or out of bounds`);
  }
}

/**
 * A real-order run mode the process is not permitted to run (ADR-010 §1): above its `maximumRunMode`, a ceiling that
 * is not a §11 run mode, or `allowRealOrders` not exactly `true`. Refused before any SQL. Names the run mode only.
 */
export class FencingRunModeNotPermittedError extends StoragePostgresError {
  public constructor(public readonly environment: string) {
    super(
      "FENCING_RUN_MODE_NOT_PERMITTED",
      `run mode ${environment} is not permitted by this process's ceiling and real-order flag, so it cannot acquire a live fencing lease (ADR-008 §2; ADR-010 §1)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Input readers. Each refuses rather than coerces.

function isRunModeValue(value: unknown): value is RunModeValue {
  return typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);
}

/** ASCII control characters and DEL. */
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > FENCING_IDENTIFIER_MAX_LENGTH || hasControl(value)) {
    throw new FencingLeaseInputError(field);
  }
  return value;
}

function ttl(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < FENCING_LEASE_MIN_TTL_MS || value > FENCING_LEASE_MAX_TTL_MS) {
    throw new FencingLeaseInputError("ttlMs");
  }
  return value;
}

/** `integer`: a non-negative 32-bit process id. */
function processId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new FencingLeaseInputError("holderPid");
  return value;
}

function reasonText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > FENCING_REASON_MAX_LENGTH || hasControl(value)) {
    throw new FencingLeaseInputError("reason");
  }
  return value;
}

/** A positive canonical decimal integer that fits PostgreSQL's `bigint`. */
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new FencingLeaseInputError("fencingToken");
  }
  return value;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function leaseId(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new FencingLeaseInputError("fencingLeaseId");
  return value;
}

function leaseRef(value: FencingLeaseRef): FencingLeaseRef {
  if (typeof value !== "object" || value === null) throw new FencingLeaseInputError("lease");
  return { fencingLeaseId: leaseId(value.fencingLeaseId), fencingToken: token(value.fencingToken), holderId: identifier(value.holderId, "holderId") };
}

function heartbeatIdText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > FENCING_HEARTBEAT_ID_MAX_LENGTH || hasControl(value)) {
    throw new FencingLeaseInputError("heartbeatId");
  }
  return value;
}

/**
 * The run mode, refused unless it is a real-order mode. Checked FIRST, before
 * any other field is read, so a simulated process is refused for what it is
 * whatever else it sent.
 */
function realMode(environment: unknown, accountRef: unknown): RunModeValue {
  const account = typeof accountRef === "string" ? accountRef : "(unreadable)";
  if (!isRunModeValue(environment) || !isRealOrderRunMode(environment)) {
    throw new NonRealModeFencingLeaseError(typeof environment === "string" ? environment : "(unreadable)", account);
  }
  return environment;
}

/**
 * ADR-010 §1, checked SECOND: the real-order mode may not exceed the process's ceiling, the ceiling must be a §11
 * run mode, and `allowRealOrders` must be exactly `true`. Under the repository's defaults (`MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false`) every real-order mode is refused here.
 */
function permittedMode(environment: RunModeValue, maximumRunMode: unknown, allowRealOrders: unknown): void {
  if (!isRunModeValue(maximumRunMode) || runModeExceeds(environment, maximumRunMode) || allowRealOrders !== true) {
    throw new FencingRunModeNotPermittedError(environment);
  }
}

function takeoverOf(value: unknown): FencingTakeover | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw new FencingLeaseInputError("takeover");
  const presented = value as Partial<FencingTakeover>;
  const version = presented.version;
  if (typeof version !== "string" || version.length < 1 || version.length > FENCING_VERSION_MAX_LENGTH || hasControl(version)) {
    throw new FencingLeaseInputError("takeover");
  }
  return { fencingLeaseId: leaseId(presented.fencingLeaseId), fencingToken: token(presented.fencingToken), version };
}

/** The row's version: its status, expiry and last update to the microsecond, as the database wrote them. */
const LEASE_VERSION = sql<string>`concat_ws('|', status::text, to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'))`;

/** Milliseconds until `expires_at` by the database's clock, rounded up, clamped to 0 … 2^31 − 1 (r2 X1). */
const DATABASE_REMAINING_MS = sql<number>`least(greatest(ceil(extract(epoch from (expires_at - clock_timestamp())) * 1000), 0), 2147483647)::integer`;

/** `clock_timestamp() + ttl`: the database's clock, read in the statement that writes it. */
function databaseExpiry(ttlMs: number) {
  return sql<string>`clock_timestamp() + (${ttlMs}::integer * interval '1 millisecond')`;
}

/**
 * Take the row lock on this holder's lease, judging NOTHING but its immutable identity (lease id, token, holder), so
 * that whatever the wait, the caller judges status and expiry afterwards, in its own statement (I4). `false` when no
 * such row exists.
 */
async function lockHolderRow(trx: PolymarketBotDatabase, ref: FencingLeaseRef): Promise<boolean> {
  const locked = await trx
    .selectFrom("ops.fencing_leases")
    .select(["fencing_lease_id"])
    .where("fencing_lease_id", "=", ref.fencingLeaseId)
    .where("fencing_token", "=", ref.fencingToken)
    .where("holder_id", "=", ref.holderId)
    .forUpdate()
    .executeTakeFirst();
  return locked !== undefined;
}

// ---------------------------------------------------------------------------

export function createFencingLeaseStore(db: PolymarketBotDatabase): FencingLeaseStore {
  return {
    async acquire(input: AcquireFencingLeaseInput): Promise<FencingAcquireOutcome> {
      if (typeof input !== "object" || input === null) throw new NonRealModeFencingLeaseError("(unreadable)", "(unreadable)");
      // 1. The run mode, before anything else: a simulated process never reaches SQL; then the process's ceiling.
      const environment = realMode(input.environment, input.accountRef);
      permittedMode(environment, input.maximumRunMode, input.allowRealOrders);
      const accountRef = identifier(input.accountRef, "accountRef");
      const holderId = identifier(input.holderId, "holderId");
      const holderHostname = input.holderHostname === undefined || input.holderHostname === null ? null : identifier(input.holderHostname, "holderHostname");
      const holderPid = input.holderPid === undefined || input.holderPid === null ? null : processId(input.holderPid);
      const ttlMs = ttl(input.ttlMs);
      const takeover = takeoverOf(input.takeover);
      const realm = executionRealm(environment);

      try {
        return await inTransaction(db, async (trx) => {
          // The same key WP-040's repository takes: both acquisition paths serialize on it.
          await sql`select pg_advisory_xact_lock(hashtext(${`fencing:${accountRef}:${realm}`}))`.execute(trx);

          // 2. The incumbent: the realm's ACTIVE lease, or else its latest lease by token. LOCKED FIRST (a renewal
          // of it serializes behind this transaction, or this one behind the renewal), judged after the lock.
          const activeRow = await trx
            .selectFrom("ops.fencing_leases")
            .select(["fencing_lease_id"])
            .where("account_ref", "=", accountRef)
            .where(sql<string>`internal.execution_realm(environment)`, "=", realm)
            .where("status", "=", "ACTIVE")
            .forUpdate()
            .executeTakeFirst();
          const latestRow =
            activeRow ??
            (await trx
              .selectFrom("ops.fencing_leases")
              .select(["fencing_lease_id"])
              .where("account_ref", "=", accountRef)
              .where(sql<string>`internal.execution_realm(environment)`, "=", realm)
              .orderBy("fencing_token", "desc")
              .limit(1)
              .forUpdate()
              .executeTakeFirst());

          let previousHeartbeatId: string | null = null;
          if (latestRow !== undefined) {
            // 3. Judged in a separate statement under the lock: its clock is read after any wait.
            const incumbent = await trx
              .selectFrom("ops.fencing_leases")
              .select(["fencing_lease_id", "fencing_token", "holder_id", "status", "expires_at", "heartbeat_id"])
              .select(sql<boolean>`expires_at <= clock_timestamp()`.as("expired"))
              .select(LEASE_VERSION.as("version"))
              .select(DATABASE_REMAINING_MS.as("remaining_ms"))
              .where("fencing_lease_id", "=", latestRow.fencing_lease_id)
              .executeTakeFirstOrThrow();
            // 3a. ACTIVE and unexpired: one fenced live writer per account and realm.
            if (incumbent.status === "ACTIVE" && incumbent.expired !== true) {
              return Object.freeze({
                kind: "HELD" as const,
                holderId: incumbent.holder_id,
                fencingToken: incumbent.fencing_token,
                expiresAt: incumbent.expires_at,
              });
            }
            // 3b. Ended. Granted only over the exact version the caller has waited out, and only once the incumbent's
            // own expiry has passed by the database's clock too (module header, r2 X1: the durable bound).
            const presented =
              takeover !== null &&
              takeover.fencingLeaseId === incumbent.fencing_lease_id &&
              takeover.fencingToken === incumbent.fencing_token &&
              takeover.version === incumbent.version;
            if (!presented || incumbent.expired !== true) {
              const remaining = Number(incumbent.remaining_ms);
              return Object.freeze({
                kind: "LAPSED" as const,
                incumbent: Object.freeze({
                  fencingLeaseId: incumbent.fencing_lease_id,
                  fencingToken: incumbent.fencing_token,
                  holderId: incumbent.holder_id,
                  status: incumbent.status,
                  expiresAt: incumbent.expires_at,
                  version: incumbent.version,
                  // Unreadable is "not yet": the grant itself is decided by `expired` above, never by this number.
                  databaseRemainingMs: incumbent.expired === true ? 0 : Number.isSafeInteger(remaining) && remaining > 0 ? remaining : 1,
                }),
              });
            }
            // 3c. A lapsed ACTIVE lease ends now, with its reason in the statement that ends it (WP-040 R15/F14).
            if (incumbent.status === "ACTIVE") {
              await trx
                .updateTable("ops.fencing_leases")
                .set({ status: "EXPIRED", released_at: sql<string>`clock_timestamp()`, revoked_reason: TAKEOVER_EXPIRY_REASON })
                .where("fencing_lease_id", "=", incumbent.fencing_lease_id)
                .where("status", "=", "ACTIVE")
                .where("expires_at", "<=", sql<string>`clock_timestamp()`)
                .execute();
            }
            // 4. The id chain the realm's previous lease last recorded (ADR-008 §4).
            previousHeartbeatId = incumbent.heartbeat_id;
          }

          // 5. The next token: the high-water mark plus one (never `max` over rows that can be deleted, ADR-008 §1).
          const highest = await trx
            .selectFrom("ops.fencing_token_high_water")
            .select(["highest_token"])
            .where("account_ref", "=", accountRef)
            .where("execution_realm", "=", realm)
            .executeTakeFirst();
          const nextToken = (BigInt(highest?.highest_token ?? "0") + 1n).toString();

          const inserted = await trx
            .insertInto("ops.fencing_leases")
            .values({
              fencing_lease_id: uuidV7(),
              account_ref: accountRef,
              environment,
              fencing_token: nextToken,
              holder_id: holderId,
              holder_hostname: holderHostname,
              holder_pid: holderPid,
              status: "ACTIVE",
              acquired_at: sql<string>`clock_timestamp()`,
              expires_at: databaseExpiry(ttlMs),
            })
            .returning(["fencing_lease_id", "fencing_token", "account_ref", "environment", "holder_id", "acquired_at", "expires_at"])
            .executeTakeFirstOrThrow();

          return Object.freeze({
            kind: "ACQUIRED" as const,
            grant: Object.freeze({
              fencingLeaseId: inserted.fencing_lease_id,
              fencingToken: inserted.fencing_token,
              accountRef: inserted.account_ref,
              environment: inserted.environment,
              holderId: inserted.holder_id,
              acquiredAt: inserted.acquired_at,
              expiresAt: inserted.expires_at,
              inheritedHeartbeatId: previousHeartbeatId,
            }),
          });
        });
      } catch (error) {
        // The database's own backstops against a writer that bypassed the advisory lock: the partial unique index
        // (a second ACTIVE lease) and the monotonic-token trigger (a token not above the high-water mark).
        if (error instanceof FencingTokenNotMonotonicError) return Object.freeze({ kind: "CONTENDED" as const });
        if (error instanceof UniqueViolationError && error.constraintName === "fencing_leases_one_active_holder") {
          return Object.freeze({ kind: "CONTENDED" as const });
        }
        throw error;
      }
    },

    async renew(lease: FencingLeaseRef, ttlMs: number): Promise<FencingRenewOutcome> {
      const ref = leaseRef(lease);
      const lifetime = ttl(ttlMs);
      const row = await inTransaction(db, async (trx) => {
        // Lock first (module header, I4): this statement judges nothing, so a wait here revives nothing.
        if (!(await lockHolderRow(trx, ref))) return undefined;
        // Then judge, under the lock already held: no wait, and `clock_timestamp()` is read now.
        return trx
          .updateTable("ops.fencing_leases")
          .set({ expires_at: databaseExpiry(lifetime) })
          .where("fencing_lease_id", "=", ref.fencingLeaseId)
          .where("fencing_token", "=", ref.fencingToken)
          .where("holder_id", "=", ref.holderId)
          .where("status", "=", "ACTIVE")
          .where("expires_at", ">", sql<string>`clock_timestamp()`)
          .returning(["expires_at"])
          .executeTakeFirst();
      });
      return row === undefined ? Object.freeze({ kind: "LOST" as const }) : Object.freeze({ kind: "RENEWED" as const, expiresAt: row.expires_at });
    },

    async recordHeartbeatId(lease: FencingLeaseRef, heartbeatId: string): Promise<boolean> {
      const ref = leaseRef(lease);
      const id = heartbeatIdText(heartbeatId);
      return inTransaction(db, async (trx) => {
        if (!(await lockHolderRow(trx, ref))) return false;
        const result = await trx
          .updateTable("ops.fencing_leases")
          .set({ heartbeat_id: id, last_heartbeat_at: sql<string>`clock_timestamp()` })
          .where("fencing_lease_id", "=", ref.fencingLeaseId)
          .where("fencing_token", "=", ref.fencingToken)
          .where("holder_id", "=", ref.holderId)
          .where("status", "=", "ACTIVE")
          .where("expires_at", ">", sql<string>`clock_timestamp()`)
          .executeTakeFirst();
        return (result.numUpdatedRows ?? 0n) > 0n;
      });
    },

    async release(lease: FencingLeaseRef, reason: string): Promise<boolean> {
      const ref = leaseRef(lease);
      const why = reasonText(reason);
      const result = await withMappedErrors(async () =>
        db
          .updateTable("ops.fencing_leases")
          .set({ status: "RELEASED", released_at: sql<string>`clock_timestamp()`, revoked_reason: why })
          .where("fencing_lease_id", "=", ref.fencingLeaseId)
          .where("fencing_token", "=", ref.fencingToken)
          .where("holder_id", "=", ref.holderId)
          .where("status", "=", "ACTIVE")
          .executeTakeFirst(),
      );
      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    async revoke(input: { readonly fencingLeaseId: string; readonly reason: string }): Promise<boolean> {
      if (typeof input !== "object" || input === null) throw new FencingLeaseInputError("revocation");
      const id = leaseId(input.fencingLeaseId);
      const why = reasonText(input.reason);
      const result = await withMappedErrors(async () =>
        db
          .updateTable("ops.fencing_leases")
          .set({ status: "REVOKED", released_at: sql<string>`clock_timestamp()`, revoked_reason: why })
          .where("fencing_lease_id", "=", id)
          .where("status", "=", "ACTIVE")
          .executeTakeFirst(),
      );
      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    async isValid(lease: FencingLeaseRef): Promise<boolean> {
      const ref = leaseRef(lease);
      const row = await withMappedErrors(async () =>
        db
          .selectFrom("ops.fencing_leases")
          .select(["fencing_lease_id"])
          .where("fencing_lease_id", "=", ref.fencingLeaseId)
          .where("fencing_token", "=", ref.fencingToken)
          .where("holder_id", "=", ref.holderId)
          .where("status", "=", "ACTIVE")
          .where("expires_at", ">", sql<string>`clock_timestamp()`)
          .executeTakeFirst(),
      );
      return row !== undefined;
    },

    async current(accountRef: string, environment: string): Promise<FencingLeaseView | null> {
      const account = identifier(accountRef, "accountRef");
      if (!isRunModeValue(environment)) throw new FencingLeaseInputError("environment");
      const realm = executionRealm(environment);
      const row = await withMappedErrors(async () =>
        db
          .selectFrom("ops.fencing_leases")
          .select(["fencing_lease_id", "fencing_token", "account_ref", "environment", "holder_id", "heartbeat_id", "expires_at"])
          .where("account_ref", "=", account)
          .where(sql<string>`internal.execution_realm(environment)`, "=", realm)
          .where("status", "=", "ACTIVE")
          .where("expires_at", ">", sql<string>`clock_timestamp()`)
          .executeTakeFirst(),
      );
      if (row === undefined) return null;
      return Object.freeze({
        fencingLeaseId: row.fencing_lease_id,
        fencingToken: row.fencing_token,
        accountRef: row.account_ref,
        environment: row.environment,
        holderId: row.holder_id,
        heartbeatId: row.heartbeat_id,
        expiresAt: row.expires_at,
      });
    },
  };
}
