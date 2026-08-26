/**
 * Fencing-lease repository (§9.18, ADR-008).
 *
 * "Redis is not sufficient as the only fence. Use a PostgreSQL advisory lock or
 * lease with a monotonic fencing token persisted with every live submission."
 *
 * Three database facts do the work, and this repository only sequences them:
 *
 *   * a partial unique index permits one ACTIVE lease per account and
 *     environment, so two live writers cannot both hold authority;
 *   * a BEFORE INSERT trigger rejects a token that is not above every token ever
 *     issued for that account, so a token is never reused;
 *   * `execution.orders` and `execution.submission_attempts` carry a composite
 *     foreign key to `(lease, token)` plus a validity trigger.
 *
 * A takeover is deliberately not free: it requires the incumbent lease to have
 * expired. ADR-008 — "Failover is not instant and must not be."
 */

import type { IsoTimestamp } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { StoragePostgresError, withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import type { Detail, Identifier, UuidV7Column } from "../schema/columns.js";
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
     * A transaction-scoped advisory lock serializes acquisitions for one
     * account, so two simultaneous callers cannot both read the same "highest
     * token". The trigger would reject the loser anyway; the lock turns a
     * constraint violation into an ordinary wait.
     */
    async acquireLease(input: AcquireLeaseInput): Promise<FencingLease> {
      return inTransaction(db, async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`fencing:${input.accountRef}:${input.environment}`}))`.execute(
          trx,
        );

        const incumbent = await trx
          .selectFrom("ops.fencing_leases")
          .select(["fencing_lease_id", "holder_id", "expires_at"])
          .where("account_ref", "=", input.accountRef)
          .where("environment", "=", input.environment)
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

        const highest = await trx
          .selectFrom("ops.fencing_leases")
          .select((eb) => eb.fn.max("fencing_token").as("highest_token"))
          .where("account_ref", "=", input.accountRef)
          .where("environment", "=", input.environment)
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
          .executeTakeFirst(),
      );

      return (result.numUpdatedRows ?? 0n) > 0n;
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

    /** The current ACTIVE lease for an account and environment, if any. */
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
