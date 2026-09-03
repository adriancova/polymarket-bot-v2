/**
 * Builds the balanced ledger transactions for an allocated fill (§9.15,
 * ADR-006 §4–§5), plus the PnL-engine records they imply (§9.16).
 *
 * One filled trade books as up to THREE transactions, matching the §9.15
 * event vocabulary one spelling per event (the WP-040 `event_type` column
 * holds exactly one):
 *
 *   1. `TRADE_PRINCIPAL`        — the collateral principal;
 *   2. `OUTCOME_TOKEN_RECEIPT` / `OUTCOME_TOKEN_DELIVERY` — the token side;
 *   3. `PLATFORM_FEE`           — when the venue charged one.
 *
 * Each balances per asset on its own, carries the fill and market ids
 * (traceability, §6 invariant 4; WP-040 obligations F15/F16), and carries the
 * attribution mirror ADR-006 §2 requires: every actual movement is matched by
 * `VIRTUAL_STRATEGY` / `UNATTRIBUTED` legs balanced through the attribution
 * clearing account, so `Ledger.append`'s parity check passes by construction
 * and the partition invariant holds inductively.
 *
 * The PnL bridge: `pnlRecords` are plain frozen objects shaped to parse
 * under `@polymarket-bot/pnl`'s input schemas. The shape agreement is
 * STRUCTURAL — deliberately no package edge exists between the two layer-1
 * packages (no §2.1 row permits one) — and is pinned by the cross-package
 * suite in `test/unit/ledger/`.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { isZeroDecimal, mulDecimal, negateDecimal } from "@polymarket-bot/decimal";
import { NonEmptyStringSchema, Uuidv7Schema } from "@polymarket-bot/domain";
import { z } from "zod";

import type { FillAllocationResult } from "./allocation.js";
import type { LedgerResult } from "./refusals.js";
import { ledgerFailure, ledgerOk, ledgerRefusal } from "./refusals.js";
import type { LedgerEntryInput, LedgerTransactionInput } from "./transaction.js";

/**
 * The clearing/expense account references a posting needs. Caller-supplied:
 * account naming is composition-root configuration, not a ledger rule.
 */
export const PostingAccountsSchema = z.strictObject({
  /** EXTERNAL_CLEARING counter-account for real-world movement (§9.15). */
  venueClearingRef: NonEmptyStringSchema,
  /** EXTERNAL_CLEARING counter-account balancing the attribution mirror. */
  attributionClearingRef: NonEmptyStringSchema,
  /** FEE_EXPENSE account for platform fees. */
  feeExpenseRef: NonEmptyStringSchema,
});

export type PostingAccounts = Readonly<z.infer<typeof PostingAccountsSchema>>;

/** Caller-minted transaction ids (this package reads no randomness). */
export const FillPostingIdsSchema = z.strictObject({
  principalTransactionId: Uuidv7Schema,
  tokenTransactionId: Uuidv7Schema,
  feeTransactionId: Uuidv7Schema.optional(),
});

export type FillPostingIds = Readonly<z.infer<typeof FillPostingIdsSchema>>;

/** The owner of a PnL stream (mirrored structurally by `@polymarket-bot/pnl`). */
export type PnlOwner =
  | { readonly scope: "ACTUAL_ACCOUNT"; readonly accountRef: string }
  | { readonly scope: "VIRTUAL_STRATEGY"; readonly instanceId: string }
  | { readonly scope: "UNATTRIBUTED"; readonly accountRef: string };

/** A trade the PnL engine folds (structural contract with `@polymarket-bot/pnl`). */
export interface PnlTradeRecord {
  readonly kind: "TRADE";
  readonly ref: string;
  readonly owner: PnlOwner;
  readonly marketId: string;
  readonly tokenAssetId: string;
  readonly denominationAsset: string;
  readonly side: "BUY" | "SELL";
  readonly shares: DecimalString;
  readonly price: DecimalString;
  readonly settlementState?: string;
}

/** A fee the PnL engine folds (structural contract with `@polymarket-bot/pnl`). */
export interface PnlFeeRecord {
  readonly kind: "FEE";
  readonly ref: string;
  readonly owner: PnlOwner;
  readonly denominationAsset: string;
  readonly amount: DecimalString;
  readonly scheduleVersionRef?: string;
}

export interface FillPosting {
  readonly transactions: readonly LedgerTransactionInput[];
  readonly pnlRecords: readonly (PnlTradeRecord | PnlFeeRecord)[];
}

const ZERO: DecimalString = "0";

interface OwnerSlice {
  readonly owner: PnlOwner;
  readonly shares: DecimalString;
  readonly cost: DecimalString;
  readonly fee: DecimalString;
  readonly instanceId?: string;
  readonly runId?: string;
}

/**
 * Builds the transactions and PnL records for one allocated fill.
 *
 * The allocation result must come from `allocateFill` (its invariants —
 * exact partition, explicit unattributed remainder — are assumed here and
 * re-checked by `Ledger.append`'s balance and parity rules on every
 * transaction this function returns).
 */
export function buildFillPosting(
  allocation: FillAllocationResult,
  accountsInput: unknown,
  idsInput: unknown,
): LedgerResult<FillPosting> {
  const accountsParsed = PostingAccountsSchema.safeParse(accountsInput);
  if (!accountsParsed.success) {
    return ledgerFailure(
      ledgerRefusal("LEDGER_INPUT_INVALID", "the value is not a posting accounts object", {
        issues: accountsParsed.error.issues.map((issue) => issue.message),
      }),
    );
  }
  const idsParsed = FillPostingIdsSchema.safeParse(idsInput);
  if (!idsParsed.success) {
    return ledgerFailure(
      ledgerRefusal("LEDGER_INPUT_INVALID", "the value is not a fill posting id set", {
        issues: idsParsed.error.issues.map((issue) => issue.message),
      }),
    );
  }
  const accounts: PostingAccounts = accountsParsed.data;
  const ids: FillPostingIds = idsParsed.data;
  const { fill } = allocation;
  const fee = fill.feeAmount ?? ZERO;

  if (!isZeroDecimal(fee) && ids.feeTransactionId === undefined) {
    return ledgerFailure(
      ledgerRefusal(
        "LEDGER_INPUT_INVALID",
        `fill ${fill.fillId} charges a fee of ${fee}; a feeTransactionId is required`,
        { fillId: fill.fillId, feeAmount: fee },
      ),
    );
  }

  // The exact per-owner partition. Multiplication over exact decimals is
  // distributive, so per-owner costs sum to price × fill.shares exactly.
  const slices: OwnerSlice[] = allocation.allocations.map((alloc) => ({
    owner: { scope: "VIRTUAL_STRATEGY", instanceId: alloc.instanceId },
    shares: alloc.shares,
    cost: mulDecimal(fill.price, alloc.shares),
    fee: alloc.feeAmount,
    instanceId: alloc.instanceId,
    ...(alloc.runId === undefined ? {} : { runId: alloc.runId }),
  }));
  if (allocation.unattributed !== undefined) {
    slices.push({
      owner: { scope: "UNATTRIBUTED", accountRef: fill.accountRef },
      shares: allocation.unattributed.shares,
      cost: mulDecimal(fill.price, allocation.unattributed.shares),
      fee: allocation.unattributed.feeAmount,
    });
  }

  const totalCost = mulDecimal(fill.price, fill.shares);
  const buying = fill.side === "BUY";

  const shared = {
    environment: fill.environment,
    accountRef: fill.accountRef,
    source: fill.source,
    occurredAt: fill.occurredAt,
    marketId: fill.marketId,
    fillId: fill.fillId,
    ...(fill.settlementState === undefined ? {} : { settlementState: fill.settlementState }),
  } as const;

  const transactions: LedgerTransactionInput[] = [];
  const pnlRecords: (PnlTradeRecord | PnlFeeRecord)[] = [];

  // 1. TRADE_PRINCIPAL — collateral. BUY pays, SELL receives.
  if (!isZeroDecimal(totalCost)) {
    const actualDelta = buying ? negateDecimal(totalCost) : totalCost;
    const entries: LedgerEntryInput[] = [
      collateralEntry("ACTUAL_ACCOUNT", fill.accountRef, fill, actualDelta),
      collateralEntry("EXTERNAL_CLEARING", accounts.venueClearingRef, fill, negateDecimal(actualDelta)),
    ];
    for (const slice of slices) {
      if (isZeroDecimal(slice.cost)) {
        continue;
      }
      const sliceDelta = buying ? negateDecimal(slice.cost) : slice.cost;
      entries.push(
        mirrorCollateralEntry(slice, fill, sliceDelta),
        collateralEntry(
          "EXTERNAL_CLEARING",
          accounts.attributionClearingRef,
          fill,
          negateDecimal(sliceDelta),
        ),
      );
    }
    transactions.push({
      ledgerTransactionId: ids.principalTransactionId,
      eventType: "TRADE_PRINCIPAL",
      entries,
      ...shared,
    });
  }

  // 2. Token movement. BUY receives tokens, SELL delivers them.
  {
    const actualDelta = buying ? fill.shares : negateDecimal(fill.shares);
    const entries: LedgerEntryInput[] = [
      tokenEntry("ACTUAL_ACCOUNT", fill.accountRef, fill, actualDelta),
      tokenEntry("EXTERNAL_CLEARING", accounts.venueClearingRef, fill, negateDecimal(actualDelta)),
    ];
    for (const slice of slices) {
      const sliceDelta = buying ? slice.shares : negateDecimal(slice.shares);
      entries.push(
        mirrorTokenEntry(slice, fill, sliceDelta),
        tokenEntry(
          "EXTERNAL_CLEARING",
          accounts.attributionClearingRef,
          fill,
          negateDecimal(sliceDelta),
        ),
      );
    }
    transactions.push({
      ledgerTransactionId: ids.tokenTransactionId,
      eventType: buying ? "OUTCOME_TOKEN_RECEIPT" : "OUTCOME_TOKEN_DELIVERY",
      entries,
      ...shared,
    });
  }

  // 3. PLATFORM_FEE — the venue's taker fee, when charged.
  if (!isZeroDecimal(fee) && ids.feeTransactionId !== undefined) {
    const entries: LedgerEntryInput[] = [
      collateralEntry("ACTUAL_ACCOUNT", fill.accountRef, fill, negateDecimal(fee)),
      collateralEntry("FEE_EXPENSE", accounts.feeExpenseRef, fill, fee),
    ];
    for (const slice of slices) {
      if (isZeroDecimal(slice.fee)) {
        continue;
      }
      entries.push(
        mirrorCollateralEntry(slice, fill, negateDecimal(slice.fee)),
        collateralEntry("EXTERNAL_CLEARING", accounts.attributionClearingRef, fill, slice.fee),
      );
    }
    transactions.push({
      ledgerTransactionId: ids.feeTransactionId,
      eventType: "PLATFORM_FEE",
      entries,
      ...shared,
    });
  }

  // PnL records: the actual-account stream plus one stream per owner slice.
  const tradeRef = ids.tokenTransactionId;
  const owners: readonly OwnerSlice[] = [
    {
      owner: { scope: "ACTUAL_ACCOUNT", accountRef: fill.accountRef },
      shares: fill.shares,
      cost: totalCost,
      fee,
    },
    ...slices,
  ];
  for (const slice of owners) {
    pnlRecords.push(
      Object.freeze({
        kind: "TRADE" as const,
        ref: tradeRef,
        owner: slice.owner,
        marketId: fill.marketId,
        tokenAssetId: fill.tokenAssetId,
        denominationAsset: fill.denominationAssetId,
        side: fill.side,
        shares: slice.shares,
        price: fill.price,
        ...(fill.settlementState === undefined
          ? {}
          : { settlementState: fill.settlementState }),
      }),
    );
    if (!isZeroDecimal(slice.fee) && ids.feeTransactionId !== undefined) {
      pnlRecords.push(
        Object.freeze({
          kind: "FEE" as const,
          ref: ids.feeTransactionId,
          owner: slice.owner,
          denominationAsset: fill.denominationAssetId,
          amount: slice.fee,
          ...(fill.feeScheduleVersionRef === undefined
            ? {}
            : { scheduleVersionRef: fill.feeScheduleVersionRef }),
        }),
      );
    }
  }

  return ledgerOk(
    Object.freeze({
      transactions: Object.freeze(transactions),
      pnlRecords: Object.freeze(pnlRecords),
    }),
  );
}

type FillLike = FillAllocationResult["fill"];

function collateralEntry(
  scope: "ACTUAL_ACCOUNT" | "EXTERNAL_CLEARING" | "FEE_EXPENSE",
  accountRef: string,
  fill: FillLike,
  amount: DecimalString,
): LedgerEntryInput {
  return {
    scope,
    accountRef,
    assetId: fill.denominationAssetId,
    assetKind: "COLLATERAL",
    amount,
    marketId: fill.marketId,
  };
}

function tokenEntry(
  scope: "ACTUAL_ACCOUNT" | "EXTERNAL_CLEARING",
  accountRef: string,
  fill: FillLike,
  amount: DecimalString,
): LedgerEntryInput {
  return {
    scope,
    accountRef,
    assetId: fill.tokenAssetId,
    assetKind: "OUTCOME_TOKEN",
    amount,
    marketId: fill.marketId,
  };
}

function mirrorCollateralEntry(
  slice: OwnerSlice,
  fill: FillLike,
  amount: DecimalString,
): LedgerEntryInput {
  if (slice.instanceId !== undefined) {
    return {
      scope: "VIRTUAL_STRATEGY",
      accountRef: fill.accountRef,
      assetId: fill.denominationAssetId,
      assetKind: "COLLATERAL",
      amount,
      instanceId: slice.instanceId,
      ...(slice.runId === undefined ? {} : { runId: slice.runId }),
      marketId: fill.marketId,
    };
  }
  return {
    scope: "UNATTRIBUTED",
    accountRef: fill.accountRef,
    assetId: fill.denominationAssetId,
    assetKind: "COLLATERAL",
    amount,
    marketId: fill.marketId,
  };
}

function mirrorTokenEntry(
  slice: OwnerSlice,
  fill: FillLike,
  amount: DecimalString,
): LedgerEntryInput {
  if (slice.instanceId !== undefined) {
    return {
      scope: "VIRTUAL_STRATEGY",
      accountRef: fill.accountRef,
      assetId: fill.tokenAssetId,
      assetKind: "OUTCOME_TOKEN",
      amount,
      instanceId: slice.instanceId,
      ...(slice.runId === undefined ? {} : { runId: slice.runId }),
      marketId: fill.marketId,
    };
  }
  return {
    scope: "UNATTRIBUTED",
    accountRef: fill.accountRef,
    assetId: fill.tokenAssetId,
    assetKind: "OUTCOME_TOKEN",
    amount,
    marketId: fill.marketId,
  };
}
