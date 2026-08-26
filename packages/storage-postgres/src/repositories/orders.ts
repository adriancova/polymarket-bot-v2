/**
 * Order repository (§9.11, §10.4, §10.7).
 *
 * `execution.orders` is the *current projection*; `execution.order_events` is
 * the append-only history (§10.4). Every state change therefore appends an event
 * and updates the projection in one transaction — a projection that moved
 * without an event would break §6 invariant 8 ("rebuildable from append-only
 * events").
 *
 * §10.7 "Every live order references a valid fencing token" is enforced by the
 * database (CHECK + composite foreign key + validity trigger), so this
 * repository simply passes the lease through; it cannot be bypassed by writing
 * around this code.
 */

import type { DecimalString, IsoTimestamp, TokenId } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import type { Code, Detail, Identifier, JsonInput, UuidV7Column } from "../schema/columns.js";
import type {
  EventSourceValue,
  OrderSideValue,
  OrderStateValue,
  RunModeValue,
  SubmissionStateValue,
} from "../schema/enums.js";

/** The fencing authority under which a live order is submitted (ADR-008). */
export type FencingReference = {
  readonly fencingLeaseId: UuidV7Column;
  /** `bigint` as a string. */
  readonly fencingToken: string;
};

export type RecordSubmissionAttemptInput = {
  readonly executionGroupId: UuidV7Column;
  readonly planId: UuidV7Column;
  readonly environment: RunModeValue;
  readonly accountRef?: Identifier | null;
  readonly attemptOrdinal?: number;
  readonly signedPayload: JsonInput;
  readonly salt: Identifier;
  readonly expectedOrderHash?: Identifier | null;
  readonly fencing?: FencingReference | null;
  readonly state?: SubmissionStateValue;
};

export type InsertOrderInput = {
  readonly planId: UuidV7Column;
  readonly executionGroupId?: UuidV7Column | null;
  readonly submissionAttemptId?: UuidV7Column | null;
  readonly marketId: UuidV7Column;
  readonly tokenId: TokenId;
  readonly environment: RunModeValue;
  readonly accountRef?: Identifier | null;
  readonly side: OrderSideValue;
  readonly limitPrice: DecimalString;
  readonly originalShares: DecimalString;
  readonly state?: OrderStateValue;
  readonly venueOrderId?: Identifier | null;
  readonly venueOrderHash?: Identifier | null;
  /** Required for every real-order run mode; rejected as invalid if stale. */
  readonly fencing?: FencingReference | null;
  readonly submittedAt?: IsoTimestamp | null;
};

export type AppendOrderEventInput = {
  readonly orderId: UuidV7Column;
  readonly eventType: Code;
  readonly newState: OrderStateValue;
  readonly source: EventSourceValue;
  readonly occurredAt: IsoTimestamp;
  readonly venueOrderId?: Identifier | null;
  readonly venueEventId?: Identifier | null;
  readonly sharesDelta?: DecimalString | null;
  readonly filledShares?: DecimalString | null;
  readonly remainingShares?: DecimalString | null;
  readonly reasonCode?: Code | null;
  readonly detail?: Detail | null;
  readonly payload?: JsonInput | null;
  /** Set when the new state is terminal, so open-order queries stay cheap. */
  readonly terminal?: boolean;
};

export type OrderRepository = ReturnType<typeof createOrderRepository>;

export function createOrderRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Persists a signed submission attempt (§9.11 steps 1-4).
     *
     * The signed payload, salt, and expected order hash are written *before*
     * transmission, which is what makes §6 invariant 6 possible: an unknown
     * response can be reconciled against the persisted identity instead of being
     * treated as a rejection.
     */
    async recordSubmissionAttempt(input: RecordSubmissionAttemptInput): Promise<UuidV7Column> {
      const submissionAttemptId = uuidV7();

      await withMappedErrors(async () =>
        db
          .insertInto("execution.submission_attempts")
          .values({
            submission_attempt_id: submissionAttemptId,
            execution_group_id: input.executionGroupId,
            plan_id: input.planId,
            environment: input.environment,
            account_ref: input.accountRef ?? null,
            attempt_ordinal: input.attemptOrdinal ?? 1,
            fencing_lease_id: input.fencing?.fencingLeaseId ?? null,
            fencing_token: input.fencing?.fencingToken ?? null,
            signed_payload: input.signedPayload,
            salt: input.salt,
            expected_order_hash: input.expectedOrderHash ?? null,
            state: input.state ?? "SIGNED",
          })
          .execute(),
      );

      return submissionAttemptId;
    },

    /** Marks an attempt's response, including the `SUBMISSION_UNKNOWN` case. */
    async recordSubmissionResponse(input: {
      readonly submissionAttemptId: UuidV7Column;
      readonly state: SubmissionStateValue;
      readonly responseStatus?: Code | null;
      readonly responsePayload?: JsonInput | null;
      readonly venueOrderId?: Identifier | null;
      readonly errorCode?: Code | null;
      readonly errorDetail?: Detail | null;
    }): Promise<void> {
      await withMappedErrors(async () =>
        db
          .updateTable("execution.submission_attempts")
          .set({
            state: input.state,
            response_received_at: sql<string>`now()`,
            response_status: input.responseStatus ?? null,
            response_payload: input.responsePayload ?? null,
            venue_order_id: input.venueOrderId ?? null,
            error_code: input.errorCode ?? null,
            error_detail: input.errorDetail ?? null,
          })
          .where("submission_attempt_id", "=", input.submissionAttemptId)
          .execute(),
      );
    },

    /**
     * Creates the order projection.
     *
     * @throws {ConstraintViolationError} when a real-order run mode supplies no
     *   fencing reference.
     * @throws {FencingReferenceInvalidError} when the lease is expired,
     *   released, or belongs to another account or environment.
     */
    async insertOrder(input: InsertOrderInput): Promise<UuidV7Column> {
      const orderId = uuidV7();

      await withMappedErrors(async () =>
        db
          .insertInto("execution.orders")
          .values({
            order_id: orderId,
            submission_attempt_id: input.submissionAttemptId ?? null,
            plan_id: input.planId,
            execution_group_id: input.executionGroupId ?? null,
            market_id: input.marketId,
            token_id: input.tokenId,
            environment: input.environment,
            account_ref: input.accountRef ?? null,
            side: input.side,
            limit_price: input.limitPrice,
            original_shares: input.originalShares,
            state: input.state ?? "PLANNED",
            venue_order_id: input.venueOrderId ?? null,
            venue_order_hash: input.venueOrderHash ?? null,
            fencing_lease_id: input.fencing?.fencingLeaseId ?? null,
            fencing_token: input.fencing?.fencingToken ?? null,
            submitted_at: input.submittedAt ?? null,
          })
          .execute(),
      );

      return orderId;
    },

    /**
     * Appends a lifecycle event and moves the projection, atomically.
     *
     * The event ordinal is allocated inside the transaction and protected by the
     * unique `(order_id, event_ordinal)` constraint, so two concurrent writers
     * cannot produce a history with a duplicated or missing position.
     */
    async appendOrderEvent(input: AppendOrderEventInput): Promise<UuidV7Column> {
      const orderEventId = uuidV7();

      await inTransaction(db, async (trx) => {
        const current = await trx
          .selectFrom("execution.orders")
          .select(["state", "filled_shares"])
          .where("order_id", "=", input.orderId)
          .forUpdate()
          .executeTakeFirstOrThrow();

        const last = await trx
          .selectFrom("execution.order_events")
          .select(["event_ordinal"])
          .where("order_id", "=", input.orderId)
          .orderBy("event_ordinal", "desc")
          .limit(1)
          .executeTakeFirst();

        const nextOrdinal = (BigInt(last?.event_ordinal ?? "-1") + 1n).toString();

        await trx
          .insertInto("execution.order_events")
          .values({
            order_event_id: orderEventId,
            order_id: input.orderId,
            event_ordinal: nextOrdinal,
            event_type: input.eventType,
            previous_state: current.state,
            new_state: input.newState,
            venue_order_id: input.venueOrderId ?? null,
            venue_event_id: input.venueEventId ?? null,
            shares_delta: input.sharesDelta ?? null,
            filled_shares: input.filledShares ?? null,
            remaining_shares: input.remainingShares ?? null,
            reason_code: input.reasonCode ?? null,
            detail: input.detail ?? null,
            payload: input.payload ?? null,
            source: input.source,
            occurred_at: input.occurredAt,
          })
          .execute();

        await trx
          .updateTable("execution.orders")
          .set({
            state: input.newState,
            filled_shares: input.filledShares ?? current.filled_shares,
            last_event_at: input.occurredAt,
            // Only set when supplied: a later event that does not restate the
            // venue id must not erase the one an earlier event established.
            ...(input.venueOrderId == null ? {} : { venue_order_id: input.venueOrderId }),
            ...(input.terminal === true ? { terminal_at: input.occurredAt } : {}),
          })
          .where("order_id", "=", input.orderId)
          .execute();
      });

      return orderEventId;
    },

    /** Reads the order projection. */
    async findOrder(orderId: UuidV7Column) {
      return withMappedErrors(async () =>
        db
          .selectFrom("execution.orders")
          .selectAll()
          .where("order_id", "=", orderId)
          .executeTakeFirst(),
      );
    },

    /** Reads the append-only history of an order in order. */
    async listOrderEvents(orderId: UuidV7Column) {
      return withMappedErrors(async () =>
        db
          .selectFrom("execution.order_events")
          .selectAll()
          .where("order_id", "=", orderId)
          .orderBy("event_ordinal", "asc")
          .execute(),
      );
    },
  };
}
