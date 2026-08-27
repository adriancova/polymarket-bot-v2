/**
 * Fencing-lease repository (§9.18, ADR-008).
 *
 * "Redis is not sufficient as the only fence. Use a PostgreSQL advisory lock or
 * lease with a monotonic fencing token persisted with every live submission."
 *
 * Four database facts do the work, and this repository only sequences them:
 *
 *   * a partial unique index permits one ACTIVE lease per account and
 *     **execution realm**, so `LIVE`, `LIVE_MICRO`, and `EXECUTION_PROBE`
 *     cannot each hold authority over one account at the same time — they all
 *     submit real orders with the same venue credentials, and the venue cannot
 *     tell two of our processes apart (ADR-008 §4);
 *   * a CHECK rejects a lease in any simulated run mode outright: "paper mode
 *     cannot acquire a live fencing lease at all" (ADR-008 §2, ADR-010);
 *   * a BEFORE INSERT trigger rejects a token that is not above every token ever
 *     issued for that account and realm — judged against an append-only
 *     high-water mark rather than against the surviving lease rows, so deleting
 *     lease history cannot release a token — and the lease state machine is
 *     forward-only, so a released lease cannot be reactivated to bring its token
 *     back;
 *   * `execution.orders` and `execution.submission_attempts` carry a composite
 *     foreign key to `(lease, token)` plus a validity trigger that judges expiry
 *     by the database's own clock, under a row lock.
 *
 * A takeover is deliberately not free: it requires the incumbent lease to have
 * expired. ADR-008 — "Failover is not instant and must not be."
 */

import type { IsoTimestamp } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import {
  NonRealModeFencingLeaseError,
  StoragePostgresError,
  withMappedErrors,
} from "../errors.js";
import { uuidV7 } from "../ids.js";
import type { Detail, Identifier, UuidV7Column } from "../schema/columns.js";
import { executionRealm, isRealOrderRunMode } from "../schema/enums.js";
import type { LeaseStatusValue, RunModeValue } from "../schema/enums.js";

export type AcquireLeaseInput = {
  readonly accountRef: Identifier;
  readonly environment: RunModeValue;
  readonly holderId: Identifier;
  readonly holderHostname?: Identifier | null;
  readonly holderPid?: number | null;
  readonly expiresAt: IsoTimestamp;
  /**
   * Whether an expired incumbent lease may be taken over. Defaults to `true`:
   * an expired lease is the normal failover path. An ACTIVE, unexpired lease is
   * never taken over — that would be the "two live writers" state the fence
   * exists to prevent.
   */
  readonly takeoverExpired?: boolean;
};

export type FencingLease = {
  readonly fencingLeaseId: UuidV7Column;
  readonly accountRef: Identifier;
  readonly environment: RunModeValue;
  /** `bigint` as a string: 2^63 exceeds what a JavaScript number holds. */
  readonly fencingToken: string;
  readonly holderId: Identifier;
  readonly status: LeaseStatusValue;
  readonly heartbeatId: string | null;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
};

/** Raised when an unexpired lease is already held by another process. */
export class LeaseHeldByAnotherHolderError extends StoragePostgresError {
  public constructor(
    public readonly accountRef: string,
    public readonly holderId: string,
    public readonly expiresAt: string,
  ) {
    super(
      "FENCING_LEASE_HELD",
      `Fencing lease for ${accountRef} is held by ${holderId} until ${expiresAt}. ` +
        "Only one fenced live order writer per account/signer is permitted (§2, ADR-008).",
    );
  }
}

export type FencingRepository = ReturnType<typeof createFencingRepository>;

export function createFencingRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Acquires the lease, allocating the next monotonic token.
     *
     * A transaction-scoped advisory lock serializes acquisitions for one account
     * and realm, so two simultaneous callers cannot both read the same "highest
     * token". The trigger would reject the loser anyway; the lock turns a
     * constraint violation into an ordinary wait.
     *
     * Everything here is scoped by **execution realm**, not by run mode: a
     * `LIVE_MICRO` process taking over an account a `LIVE` process was fencing
     * is a failover of the same real authority, so it must see the incumbent and
     * continue the same token sequence rather than start a parallel one.
     *
     * @throws {NonRealModeFencingLeaseError} for any simulated run mode.
     * @throws {LeaseHeldByAnotherHolderError} when an unexpired lease is held.
     */
    async acquireLease(input: AcquireLeaseInput): Promise<FencingLease> {
      if (!isRealOrderRunMode(input.environment)) {
        // ADR-008 §2 / ADR-010. The CHECK constraint enforces this; failing
        // here as well means the caller gets a typed error naming the rule
        // rather than a SQLSTATE it has to interpret.
        throw new NonRealModeFencingLeaseError(input.environment, input.accountRef);
      }

      const realm = executionRealm(input.environment);

      return inTransaction(db, async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`fencing:${input.accountRef}:${realm}`}))`.execute(
          trx,
        );

        const incumbent = await trx
          .selectFrom("ops.fencing_leases")
          .select(["fencing_lease_id", "holder_id", "expires_at"])
          .where("account_ref", "=", input.accountRef)
          .where(sql<string>`internal.execution_realm(environment)`, "=", realm)
          .where("status", "=", "ACTIVE")
          .executeTakeFirst();

        if (incumbent !== undefined) {
          const expired = await isExpired(trx, incumbent.expires_at);
          if (!expired || input.takeoverExpired === false) {
            throw new LeaseHeldByAnotherHolderError(
              input.accountRef,
              incumbent.holder_id,
              incumbent.expires_at,
            );
          }
          // The lapse is recorded as a transition, not overwritten silently.
          await trx
            .updateTable("ops.fencing_leases")
            .set({
              status: "EXPIRED",
              released_at: sql<string>`now()`,
              revoked_reason: "lease expired before takeover",
            })
            .where("fencing_lease_id", "=", incumbent.fencing_lease_id)
            .execute();
        }

        // The next token comes from the high-water mark, not from
        // `max(fencing_token)` over the lease rows: a maximum over rows that can
        // be deleted is not a monotonic sequence, and re-issuing a spent token
        // is exactly what ADR-008 §1 forbids. The insert trigger advances and
        // re-checks the same mark, so a concurrent acquirer cannot slip between
        // this read and the write.
        const highest = await trx
          .selectFrom("ops.fencing_token_high_water")
          .select(["highest_token"])
          .where("account_ref", "=", input.accountRef)
          .where("execution_realm", "=", realm)
          .executeTakeFirst();

        const nextToken = (BigInt(highest?.highest_token ?? "0") + 1n).toString();
        const fencingLeaseId = uuidV7();

        const inserted = await trx
          .insertInto("ops.fencing_leases")
          .values({
            fencing_lease_id: fencingLeaseId,
            account_ref: input.accountRef,
            environment: input.environment,
            fencing_token: nextToken,
            holder_id: input.holderId,
            holder_hostname: input.holderHostname ?? null,
            holder_pid: input.holderPid ?? null,
            status: "ACTIVE",
            expires_at: input.expiresAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return toFencingLease(inserted);
      });
    },

    /**
     * Records a heartbeat and extends the lease.
     *
     * ADR-008 §4: the venue's heartbeat id rotates on every successful
     * response, so the current id is lease state — a failover either resumes
     * with it or bootstraps from empty.
     *
     * A lease whose expiry has already passed cannot be extended: ADR-008 §2
     * says a process that lost the lease must stop heartbeating immediately, and
     * an expired lease is lost whether or not anyone has relabelled the row.
     * Reacquisition is the path back, and it allocates a new token.
     */
    async recordHeartbeat(input: {
      readonly fencingLeaseId: UuidV7Column;
      readonly holderId: Identifier;
      readonly heartbeatId: string | null;
      readonly expiresAt: IsoTimestamp;
    }): Promise<boolean> {
      const result = await withMappedErrors(async () =>
        db
          .updateTable("ops.fencing_leases")
          .set({
            heartbeat_id: input.heartbeatId,
            last_heartbeat_at: sql<string>`now()`,
            expires_at: input.expiresAt,
          })
          .where("fencing_lease_id", "=", input.fencingLeaseId)
          .where("holder_id", "=", input.holderId)
          .where("status", "=", "ACTIVE")
          .where("expires_at", ">", sql<string>`now()`)
          .executeTakeFirst(),
      );

      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    /**
     * Moves lapsed ACTIVE leases into the EXPIRED state.
     *
     * Housekeeping, never a precondition for safety: the live-write trigger
     * judges expiry by the database clock, so a lapsed lease authorizes nothing
     * whether or not this has run. It exists so the recorded state machine
     * matches reality for whoever reads the table.
     *
     * @returns how many leases were expired.
     */
    async expireStaleLeases(accountRef?: Identifier): Promise<number> {
      const result = await withMappedErrors(async () =>
        sql<{ expired: number }>`select ops.expire_stale_fencing_leases(${accountRef ?? null}) as expired`.execute(
          db,
        ),
      );
      return Number(result.rows[0]?.expired ?? 0);
    },

    /** Releases the lease. A released lease can never authorize a new order. */
    async releaseLease(
      fencingLeaseId: UuidV7Column,
      reason: Detail = "released by holder",
    ): Promise<void> {
      await withMappedErrors(async () =>
        db
          .updateTable("ops.fencing_leases")
          .set({
            status: "RELEASED",
            released_at: sql<string>`now()`,
            revoked_reason: reason,
          })
          .where("fencing_lease_id", "=", fencingLeaseId)
          .where("status", "=", "ACTIVE")
          .execute(),
      );
    },

    /**
     * The current *valid* lease for an account and environment, if any.
     *
     * ACTIVE and unexpired, judged by the database clock — an ACTIVE row whose
     * expiry has passed authorizes nothing, so returning it would invite a
     * caller to submit under it and be rejected by the trigger.
     */
    async findActiveLease(
      accountRef: Identifier,
      environment: RunModeValue,
    ): Promise<FencingLease | undefined> {
      const row = await withMappedErrors(async () =>
        db
          .selectFrom("ops.fencing_leases")
          .selectAll()
          .where("account_ref", "=", accountRef)
          .where("environment", "=", environment)
          .where("status", "=", "ACTIVE")
          .where("expires_at", ">", sql<string>`now()`)
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : toFencingLease(row);
    },
  };
}

async function isExpired(db: PolymarketBotDatabase, expiresAt: string): Promise<boolean> {
  const result = await sql<{ expired: boolean }>`select ${expiresAt}::timestamptz <= now() as expired`.execute(
    db,
  );
  return result.rows[0]?.expired === true;
}

function toFencingLease(row: {
  fencing_lease_id: string;
  account_ref: string;
  environment: RunModeValue;
  fencing_token: string;
  holder_id: string;
  status: LeaseStatusValue;
  heartbeat_id: string | null;
  acquired_at: string;
  expires_at: string;
}): FencingLease {
  return {
    fencingLeaseId: row.fencing_lease_id,
    accountRef: row.account_ref,
    environment: row.environment,
    fencingToken: row.fencing_token,
    holderId: row.holder_id,
    status: row.status,
    heartbeatId: row.heartbeat_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}
