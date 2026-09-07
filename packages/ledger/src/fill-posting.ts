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
 * packages (no §2.1 row permits one; the `WP-200-FU1` rows **S5** and **S6**
 * both run to `packages/risk` and carry the parse door only) — and is pinned by
 * the cross-package suite in `test/unit/ledger/`.
 *
 * THE DOOR (ADR-020 §3; `WP-200-FU1`, 2026-09-04). All THREE arguments of
 * {@link buildFillPosting} are caller-supplied, including the first — its type
 * says `FillAllocationResult`, and a type stops a TypeScript caller and nobody
 * else. Measured at `main` `761db76`, before this change (probe P):
 *
 * ```text
 * P7  an id set with no own tokenTransactionId, clean        → LEDGER_INPUT_INVALID
 * P8  the same, NE inherited tokenTransactionId              → ACCEPTED, adopted id
 *                                                              on a REAL transaction
 * P9  accounts with no own feeExpenseRef, clean              → LEDGER_INPUT_INVALID
 * P10 the same, NE inherited feeExpenseRef                   → ACCEPTED
 * ```
 *
 * An adopted `tokenTransactionId` is the primary key of a booked movement, and
 * an adopted account reference is the account the other side of a real posting
 * lands in.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import { isZeroDecimal, mulDecimal, negateDecimal } from "@polymarket-bot/decimal";
import { NonEmptyStringSchema, Uuidv7Schema } from "@polymarket-bot/domain";
import { appendData } from "@polymarket-bot/risk/plain-data";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";
import { z } from "zod";

import type { FillAllocationResult } from "./allocation.js";
import { plainFrozen } from "./immutable.js";
import type { LedgerResult } from "./refusals.js";
import {
  contained,
  ledgerFailure,
  ledgerOk,
  ledgerRefusal,
  readInputAsData,
} from "./refusals.js";
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

/**
 * **D2** — the two parsing copies, built and WARMED at module load
 * (`@polymarket-bot/risk/schema-arena`, §2.1 **S5**). Their ANSWERS are used;
 * their OUTPUTS are discarded (**D3**).
 */
const PostingAccountsDoor = prototypeFreeParser(PostingAccountsSchema);
const FillPostingIdsDoor = prototypeFreeParser(FillPostingIdsSchema);

/**
 * The owner of a PnL stream (mirrored structurally by `@polymarket-bot/pnl`).
 *
 * EVERY owner names the account whose holdings it concerns, including a
 * strategy instance's: attribution is a partition of a real account's balance
 * (ADR-006 §2), the ledger entry carrying it has a NOT NULL `account_ref`, and
 * `accounting.pnl_snapshots.account_ref` is NOT NULL as well. An
 * account-less strategy owner made two accounts' records interchangeable in
 * one stream (remediation round 1, 2026-09-02).
 */
export type PnlOwner =
  | { readonly scope: "ACTUAL_ACCOUNT"; readonly accountRef: string }
  | {
      readonly scope: "VIRTUAL_STRATEGY";
      readonly accountRef: string;
      readonly instanceId: string;
    }
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
 *
 * A PROTOTYPE-FREE DOOR (`WP-200-FU1`): **D1** all three arguments are
 * materialized prototype-free — the allocation too, because `allocation
 * .unattributed`, `alloc.runId` and `fill.feeAmount` are OPTIONAL reads and an
 * ordinary object answers an absent optional from `Object.prototype`; **D2**
 * the two schema parses go through the warmed arena copies; **D3** every value
 * used below comes from a materialized tree; **D4** every entry, transaction
 * and PnL record this function emits is built prototype-free and frozen.
 *
 * The allocation is materialized rather than re-validated against a schema:
 * this function's contract is unchanged — the allocation's invariants still
 * come from `allocateFill` and are still re-checked by `Ledger.append` — and a
 * new schema here would be a new rule, which this package is not re-ruling.
 */
export function buildFillPosting(
  allocation: FillAllocationResult,
  accountsInput: unknown,
  idsInput: unknown,
): LedgerResult<FillPosting> {
  return contained(() => buildMaterializedFillPosting(allocation, accountsInput, idsInput));
}

function buildMaterializedFillPosting(
  allocationInput: FillAllocationResult,
  accountsInput: unknown,
  idsInput: unknown,
): LedgerResult<FillPosting> {
  const readAccounts = readInputAsData(accountsInput, "accounts", "posting accounts object");
  if (!readAccounts.ok) {
    return ledgerFailure(readAccounts.refusal);
  }
  const accountsParsed = PostingAccountsDoor.safeParse(readAccounts.value);
  if (!accountsParsed.success) {
    return ledgerFailure(
      ledgerRefusal("LEDGER_INPUT_INVALID", "the value is not a posting accounts object", {
        issues: accountsParsed.error.issues.map((issue) => issue.message),
      }),
    );
  }
  const readIds = readInputAsData(idsInput, "ids", "fill posting id set");
  if (!readIds.ok) {
    return ledgerFailure(readIds.refusal);
  }
  const idsParsed = FillPostingIdsDoor.safeParse(readIds.value);
  if (!idsParsed.success) {
    return ledgerFailure(
      ledgerRefusal("LEDGER_INPUT_INVALID", "the value is not a fill posting id set", {
        issues: idsParsed.error.issues.map((issue) => issue.message),
      }),
    );
  }
  const readAllocation = readInputAsData(allocationInput, "allocation", "fill allocation result");
  if (!readAllocation.ok) {
    return ledgerFailure(readAllocation.refusal);
  }
  // D3 — every value below comes from a materialized tree.
  const accounts = readAccounts.value as PostingAccounts;
  const ids = readIds.value as FillPostingIds;
  const allocation = readAllocation.value as FillAllocationResult;
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
  //
  // D4 applies to these INTERNAL slices too, and for a reason that is a
  // decision rather than a style: `mirrorCollateralEntry` and
  // `mirrorTokenEntry` choose between the `VIRTUAL_STRATEGY` and
  // `UNATTRIBUTED` scopes on `slice.instanceId !== undefined`. On an ordinary
  // object that read is answered by `Object.prototype`, so an inherited
  // `instanceId` would have turned the explicitly UNATTRIBUTED remainder into
  // an attributed leg — silently reassigning a share of a real fill to a
  // strategy instance, which is exactly the "silent absorption path" this
  // module's header says does not exist.
  const slices: OwnerSlice[] = allocation.allocations.map((alloc) =>
    plainFrozen({
      owner: plainFrozen({
        scope: "VIRTUAL_STRATEGY" as const,
        accountRef: fill.accountRef,
        instanceId: alloc.instanceId,
      }),
      shares: alloc.shares,
      cost: mulDecimal(fill.price, alloc.shares),
      fee: alloc.feeAmount,
      instanceId: alloc.instanceId,
      ...(alloc.runId === undefined ? {} : { runId: alloc.runId }),
    }),
  );
  if (allocation.unattributed !== undefined) {
    appendData(
      slices,
      plainFrozen({
        owner: plainFrozen({
          scope: "UNATTRIBUTED" as const,
          accountRef: fill.accountRef,
        }),
        shares: allocation.unattributed.shares,
        cost: mulDecimal(fill.price, allocation.unattributed.shares),
        fee: allocation.unattributed.feeAmount,
      }),
    );
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
      for (const entry of [
        mirrorCollateralEntry(slice, fill, sliceDelta),
        collateralEntry(
          "EXTERNAL_CLEARING",
          accounts.attributionClearingRef,
          fill,
          negateDecimal(sliceDelta),
        ),
      ]) appendData(entries, entry);
    }
    appendData(
      transactions,
      plainFrozen({
        ledgerTransactionId: ids.principalTransactionId,
        eventType: "TRADE_PRINCIPAL" as const,
        entries: Object.freeze(entries),
        ...shared,
      }),
    );
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
      for (const entry of [
        mirrorTokenEntry(slice, fill, sliceDelta),
        tokenEntry(
          "EXTERNAL_CLEARING",
          accounts.attributionClearingRef,
          fill,
          negateDecimal(sliceDelta),
        ),
      ]) appendData(entries, entry);
    }
    appendData(
      transactions,
      plainFrozen({
        ledgerTransactionId: ids.tokenTransactionId,
        eventType: buying ? ("OUTCOME_TOKEN_RECEIPT" as const) : ("OUTCOME_TOKEN_DELIVERY" as const),
        entries: Object.freeze(entries),
        ...shared,
      }),
    );
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
      for (const entry of [
        mirrorCollateralEntry(slice, fill, negateDecimal(slice.fee)),
        collateralEntry("EXTERNAL_CLEARING", accounts.attributionClearingRef, fill, slice.fee),
      ]) appendData(entries, entry);
    }
    appendData(
      transactions,
      plainFrozen({
        ledgerTransactionId: ids.feeTransactionId,
        eventType: "PLATFORM_FEE" as const,
        entries: Object.freeze(entries),
        ...shared,
      }),
    );
  }

  // PnL records: the actual-account stream plus one stream per owner slice.
  const tradeRef = ids.tokenTransactionId;
  const owners: readonly OwnerSlice[] = [
    plainFrozen({
      owner: plainFrozen({ scope: "ACTUAL_ACCOUNT" as const, accountRef: fill.accountRef }),
      shares: fill.shares,
      cost: totalCost,
      fee,
    }),
    ...slices,
  ];
  for (const slice of owners) {
    appendData(
      pnlRecords,
      plainFrozen({
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
      appendData(
        pnlRecords,
        plainFrozen({
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
    plainFrozen({
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
  return plainFrozen({
    scope,
    accountRef,
    assetId: fill.denominationAssetId,
    assetKind: "COLLATERAL" as const,
    amount,
    marketId: fill.marketId,
  });
}

function tokenEntry(
  scope: "ACTUAL_ACCOUNT" | "EXTERNAL_CLEARING",
  accountRef: string,
  fill: FillLike,
  amount: DecimalString,
): LedgerEntryInput {
  return plainFrozen({
    scope,
    accountRef,
    assetId: fill.tokenAssetId,
    assetKind: "OUTCOME_TOKEN" as const,
    amount,
    marketId: fill.marketId,
  });
}

function mirrorCollateralEntry(
  slice: OwnerSlice,
  fill: FillLike,
  amount: DecimalString,
): LedgerEntryInput {
  if (slice.instanceId !== undefined) {
    return plainFrozen({
      scope: "VIRTUAL_STRATEGY" as const,
      accountRef: fill.accountRef,
      assetId: fill.denominationAssetId,
      assetKind: "COLLATERAL" as const,
      amount,
      instanceId: slice.instanceId,
      ...(slice.runId === undefined ? {} : { runId: slice.runId }),
      marketId: fill.marketId,
    });
  }
  return plainFrozen({
    scope: "UNATTRIBUTED" as const,
    accountRef: fill.accountRef,
    assetId: fill.denominationAssetId,
    assetKind: "COLLATERAL" as const,
    amount,
    marketId: fill.marketId,
  });
}

function mirrorTokenEntry(
  slice: OwnerSlice,
  fill: FillLike,
  amount: DecimalString,
): LedgerEntryInput {
  if (slice.instanceId !== undefined) {
    return plainFrozen({
      scope: "VIRTUAL_STRATEGY" as const,
      accountRef: fill.accountRef,
      assetId: fill.tokenAssetId,
      assetKind: "OUTCOME_TOKEN" as const,
      amount,
      instanceId: slice.instanceId,
      ...(slice.runId === undefined ? {} : { runId: slice.runId }),
      marketId: fill.marketId,
    });
  }
  return plainFrozen({
    scope: "UNATTRIBUTED" as const,
    accountRef: fill.accountRef,
    assetId: fill.tokenAssetId,
    assetKind: "OUTCOME_TOKEN" as const,
    amount,
    marketId: fill.marketId,
  });
}
