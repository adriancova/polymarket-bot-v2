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
 * - a `REWARD_PAYOUT` REQUIRES its ledger transaction id — the observed,
 *   ledger-booked payout is the settlement-grade fact (ADR-006 §6: "only an
 *   observed payout creates a REWARD_INCOME entry");
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
  Uuidv7Schema,
} from "@polymarket-bot/domain";
import { z } from "zod";

/** The owner of one PnL stream: one state folds exactly one owner. */
export const PnlOwnerSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("ACTUAL_ACCOUNT"), accountRef: NonEmptyStringSchema }),
  z.strictObject({ scope: z.literal("VIRTUAL_STRATEGY"), instanceId: Uuidv7Schema }),
  z.strictObject({ scope: z.literal("UNATTRIBUTED"), accountRef: NonEmptyStringSchema }),
]);

export type PnlOwner = Readonly<z.infer<typeof PnlOwnerSchema>>;

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
