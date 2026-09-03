/**
 * The PnL engine's input records (§9.16, ADR-006 §5–§6).
 *
 * The vocabulary is deliberately small and every semantic ambiguity is pushed
 * to an EXPLICIT, machine-checked input rather than resolved by a silent
 * rule:
 *
 * - a `REWARD_ESTIMATE` cannot carry settlement evidence — the field does not
 *   exist on its strict schema, so "an estimate that realizes" is
 *   unrepresentable (§9.16: "Reward estimates are never booked as realized");
 * - a `REWARD_PAYOUT` REQUIRES its ledger transaction id, AND the fold
 *   requires the booked transaction itself before it realizes anything
 *   (`evidence.ts`) — ADR-006 §6: "only an observed payout creates a
 *   REWARD_INCOME entry", and an identifier is not an observation
 *   (remediation round 1, 2026-09-02);
 * - a split's cost-basis partition arrives as an explicit
 *   `COST_BASIS_INJECTION`, never as a guessed 50/50;
 * - fee and reward schedule versions are carried where available (§9.16) and
 *   never invented.
 *
 * STRUCTURAL CONTRACT: `@polymarket-bot/ledger`'s `buildFillPosting` emits
 * objects that parse under `PnlTradeRecordSchema` / `PnlFeeRecordSchema`.
 * There is deliberately no package edge between the two layer-1 packages
 * (no dependency-direction §2.1 row permits one); the agreement is pinned by
 * the cross-package suite in `test/unit/ledger/`.
 */

import {
  CodeStringSchema,
  DetailStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  RunModeSchema,
  Uuidv7Schema,
} from "@polymarket-bot/domain";
import { z } from "zod";

/**
 * The owner of one PnL stream: one state folds exactly one owner.
 *
 * EVERY owner names an account, including a strategy instance's. Attribution
 * is a partition of a REAL account's holdings (ADR-006 §2), the ledger entry
 * that carries it has a NOT NULL `account_ref` for every scope, and
 * `accounting.pnl_snapshots.account_ref` is NOT NULL as well — so an owner
 * without an account is a row that cannot be written and a stream that would
 * silently absorb another account's records for the same instance
 * (remediation round 1, 2026-09-02).
 */
export const PnlOwnerSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("ACTUAL_ACCOUNT"), accountRef: NonEmptyStringSchema }),
  z.strictObject({
    scope: z.literal("VIRTUAL_STRATEGY"),
    accountRef: NonEmptyStringSchema,
    instanceId: Uuidv7Schema,
  }),
  z.strictObject({ scope: z.literal("UNATTRIBUTED"), accountRef: NonEmptyStringSchema }),
]);

export type PnlOwner = Readonly<z.infer<typeof PnlOwnerSchema>>;

/**
 * The identity of one PnL stream — and, field for field, the identity of the
 * `accounting.pnl_snapshots` rows it produces (§10.5).
 *
 * That table's identity is `(scope, environment, account_ref, instance_id,
 * market_id, as_of)` with `scope`, `environment`, and `account_ref` NOT NULL,
 * plus `run_id` for the run that produced the state. A stream that knew only
 * its owner could not be persisted at all: `environment` and `account_ref`
 * are not derivable from a PnL value, and a composition root that invented
 * them would be writing a fact nobody stated — in a monetary table, under a
 * PAPER/LIVE discriminator. So the stream states them, and refuses to open
 * without them.
 *
 * `runId` and `marketId` are optional because they are genuinely optional
 * columns: an account-wide, cross-run stream has neither. When present they
 * SCOPE the stream — the caller is folding only that run's or that market's
 * records — and they are reported unchanged on every row.
 */
export const PnlStreamIdentitySchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("ACTUAL_ACCOUNT"),
    environment: RunModeSchema,
    accountRef: NonEmptyStringSchema,
    runId: Uuidv7Schema.optional(),
    marketId: Uuidv7Schema.optional(),
  }),
  z.strictObject({
    scope: z.literal("VIRTUAL_STRATEGY"),
    environment: RunModeSchema,
    accountRef: NonEmptyStringSchema,
    instanceId: Uuidv7Schema,
    runId: Uuidv7Schema.optional(),
    marketId: Uuidv7Schema.optional(),
  }),
  z.strictObject({
    scope: z.literal("UNATTRIBUTED"),
    environment: RunModeSchema,
    accountRef: NonEmptyStringSchema,
    runId: Uuidv7Schema.optional(),
    marketId: Uuidv7Schema.optional(),
  }),
]);

export type PnlStreamIdentity = Readonly<z.infer<typeof PnlStreamIdentitySchema>>;

/** The owner half of a stream identity — what a record's `owner` must match. */
export function pnlOwnerOf(identity: PnlStreamIdentity): PnlOwner {
  return Object.freeze(
    identity.scope === "VIRTUAL_STRATEGY"
      ? {
          scope: "VIRTUAL_STRATEGY" as const,
          accountRef: identity.accountRef,
          instanceId: identity.instanceId,
        }
      : { scope: identity.scope, accountRef: identity.accountRef },
  );
}

/**
 * Settlement lifecycle vocabulary (venue report §4). `FAILED` is listed so a
 * caller CAN state it — and the engine refuses it as a fresh recognition
 * (`PNL_SETTLEMENT_FAILED_TRADE`), which is a typed rule, not a schema hole.
 */
export const PnlSettlementStateSchema = z.enum([
  "MATCHED_NOT_BROADCASTED",
  "MATCHED",
  "MINED",
  "CONFIRMED",
  "RETRYING",
  "FAILED",
]);

/** ADR-006 §6: the three incentive programs. */
export const PnlRewardProgramSchema = z.enum([
  "MAKER_REBATE",
  "TAKER_REBATE",
  "LIQUIDITY_REWARD",
]);

/** A recognized trade (ADR-006 §5: from the venue's authoritative record). */
export const PnlTradeRecordSchema = z.strictObject({
  kind: z.literal("TRADE"),
  /** Unique per state; the booking ledger-transaction id by convention. */
  ref: Uuidv7Schema,
  owner: PnlOwnerSchema,
  marketId: Uuidv7Schema,
  tokenAssetId: NonEmptyStringSchema,
  /** Explicit denomination (ADR-006 §7: USDC and pUSD never interchange). */
  denominationAsset: NonEmptyStringSchema,
  side: z.enum(["BUY", "SELL"]),
  shares: PositiveDecimalStringSchema,
  price: PriceStringSchema,
  settlementState: PnlSettlementStateSchema.optional(),
});

/** An exact unwind of a previously folded trade (ADR-006 §5.2). */
export const PnlTradeReversalRecordSchema = z.strictObject({
  kind: z.literal("TRADE_REVERSAL"),
  ref: Uuidv7Schema,
  owner: PnlOwnerSchema,
  /** The `ref` of the trade being compensated. */
  reversesRef: Uuidv7Schema,
});

/**
 * A settlement-grade realization of an open position: redeeming winning
 * tokens, or a market resolution fixing the payoff (§9.15 events REDEEM /
 * RESOLUTION; handoff §6.2 terminal outcomes).
 */
export const PnlRealizationRecordSchema = z.strictObject({
  kind: z.literal("REALIZATION"),
  ref: Uuidv7Schema,
  owner: PnlOwnerSchema,
  realizationKind: z.enum(["REDEEM", "RESOLUTION"]),
  tokenAssetId: NonEmptyStringSchema,
  shares: PositiveDecimalStringSchema,
  /** The determined payoff per share (venue report §10.2: $1 backing). */
  payoutPerShare: NonNegativeDecimalStringSchema,
  denominationAsset: NonEmptyStringSchema,
});

/**
 * An explicit cost-basis injection: a split-derived token lot, or an opening
 * position migration. The basis partition of a split is the CALLER's
 * explicit statement — this engine never guesses one.
 */
export const PnlCostBasisInjectionRecordSchema = z.strictObject({
  kind: z.literal("COST_BASIS_INJECTION"),
  ref: Uuidv7Schema,
  owner: PnlOwnerSchema,
  tokenAssetId: NonEmptyStringSchema,
  marketId: Uuidv7Schema.optional(),
  shares: PositiveDecimalStringSchema,
  costBasis: NonNegativeDecimalStringSchema,
  denominationAsset: NonEmptyStringSchema,
  detail: DetailStringSchema.optional(),
});

/** A fee actually paid (venue report §6: taker-only, versioned schedules). */
export const PnlFeeRecordSchema = z.strictObject({
  kind: z.literal("FEE"),
  ref: Uuidv7Schema,
  owner: PnlOwnerSchema,
  denominationAsset: NonEmptyStringSchema,
  amount: PositiveDecimalStringSchema,
  /** §9.16: fee schedules are versioned per market where available. */
  scheduleVersionRef: NonEmptyStringSchema.optional(),
});

/**
 * An OBSERVED reward payout — the settlement-grade fact. It must name the
 * ledger transaction that booked the observed payout (`REWARD_INCOME`
 * scope); an estimate has no such evidence and no way to state one.
 *
 * Naming that transaction is NECESSARY, not sufficient: `applyPnlRecord`
 * realizes the payout only against `PnlSettlementEvidence` containing that
 * booking, checked for event type, environment, settlement state, amount,
 * denomination, and owner (`evidence.ts`). Before remediation round 1 the
 * schema check WAS the whole boundary, and a caller could mint a canonical
 * UUID and realize any amount.
 */
export const PnlRewardPayoutRecordSchema = z.strictObject({
  kind: z.literal("REWARD_PAYOUT"),
  ref: Uuidv7Schema,
  owner: PnlOwnerSchema,
  programType: PnlRewardProgramSchema,
  amount: PositiveDecimalStringSchema,
  denominationAsset: NonEmptyStringSchema,
  /** REQUIRED settlement-grade evidence (ADR-006 §6). */
  ledgerTransactionId: Uuidv7Schema,
  programVersionRef: NonEmptyStringSchema.optional(),
  periodStart: IsoTimestampSchema.optional(),
  periodEnd: IsoTimestampSchema.optional(),
});

/**
 * A reward ESTIMATE — analytics, never money. Its strict schema carries no
 * evidence field, so an estimate asserting settlement is unrepresentable.
 * Folding one changes the estimate bucket and NOTHING else (§9.16, verbatim:
 * "Reward estimates are never booked as realized").
 */
export const PnlRewardEstimateRecordSchema = z.strictObject({
  kind: z.literal("REWARD_ESTIMATE"),
  ref: Uuidv7Schema,
  owner: PnlOwnerSchema,
  programType: PnlRewardProgramSchema,
  amount: NonNegativeDecimalStringSchema,
  denominationAsset: NonEmptyStringSchema,
  methodology: CodeStringSchema,
  periodStart: IsoTimestampSchema,
  periodEnd: IsoTimestampSchema,
  computedAt: IsoTimestampSchema,
  programVersionRef: NonEmptyStringSchema.optional(),
});

export const PnlRecordSchema = z.discriminatedUnion("kind", [
  PnlTradeRecordSchema,
  PnlTradeReversalRecordSchema,
  PnlRealizationRecordSchema,
  PnlCostBasisInjectionRecordSchema,
  PnlFeeRecordSchema,
  PnlRewardPayoutRecordSchema,
  PnlRewardEstimateRecordSchema,
]);

export type PnlTradeRecord = Readonly<z.infer<typeof PnlTradeRecordSchema>>;
export type PnlTradeReversalRecord = Readonly<z.infer<typeof PnlTradeReversalRecordSchema>>;
export type PnlRealizationRecord = Readonly<z.infer<typeof PnlRealizationRecordSchema>>;
export type PnlCostBasisInjectionRecord = Readonly<
  z.infer<typeof PnlCostBasisInjectionRecordSchema>
>;
export type PnlFeeRecord = Readonly<z.infer<typeof PnlFeeRecordSchema>>;
export type PnlRewardPayoutRecord = Readonly<z.infer<typeof PnlRewardPayoutRecordSchema>>;
export type PnlRewardEstimateRecord = Readonly<z.infer<typeof PnlRewardEstimateRecordSchema>>;
export type PnlRecord = Readonly<z.infer<typeof PnlRecordSchema>>;
