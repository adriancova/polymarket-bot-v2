/**
 * Fill allocation (§9.15, §10.7, ADR-006 §4).
 *
 * "Every fill allocation sum equals the actual fill quantity" (§10.7), and
 * "partial fills never allocate more than actual fill quantity" (§16.2).
 * Attribution of a fill to strategy instances is a PARTITION of the actual
 * quantity: claims may cover it exactly, or under-cover it — in which case
 * the remainder lands in an EXPLICIT `UNATTRIBUTED` scope with a typed
 * record (`haltRequired: true`, §9.15 / §6 invariant 7) — but may never
 * over-cover it. There is no silent absorption path: every share of the fill
 * appears in exactly one returned allocation record.
 */

import type { DecimalString } from "@polymarket-bot/decimal";
import {
  addDecimal,
  compareDecimal,
  isZeroDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";
import {
  DetailStringSchema,
  EventSourceSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeDecimalStringSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  RunModeSchema,
  Uuidv7Schema,
} from "@polymarket-bot/domain";
import { z } from "zod";

import type { LedgerRefusal, LedgerResult } from "./refusals.js";
import { ledgerFailure, ledgerOk, ledgerRefusal } from "./refusals.js";
import { TradeSettlementStateSchema } from "./vocabulary.js";

/**
 * A deduplicated fill fact (the `execution.fills` shape this package needs).
 * `side` is OUR order's side: BUY receives outcome tokens for collateral,
 * SELL delivers them (venue report §10.2: selling requires inventory).
 */
export const FillFactSchema = z.strictObject({
  fillId: Uuidv7Schema,
  marketId: Uuidv7Schema,
  environment: RunModeSchema,
  accountRef: NonEmptyStringSchema,
  /** The outcome-token asset the fill moved (ADR-006: a token IS an asset). */
  tokenAssetId: NonEmptyStringSchema,
  /**
   * The collateral asset the principal is denominated in. Explicit per
   * ADR-006 §7 rule 1 — there is no implicit "cash" asset, and USDC/pUSD are
   * never interchangeable (conflict C-2, unresolved).
   */
  denominationAssetId: NonEmptyStringSchema,
  side: z.enum(["BUY", "SELL"]),
  shares: PositiveDecimalStringSchema,
  price: PriceStringSchema,
  /** Taker fee, when the venue charged one (venue report §6). */
  feeAmount: NonNegativeDecimalStringSchema.optional(),
  /** §9.16: fee schedules are versioned per market where available. */
  feeScheduleVersionRef: NonEmptyStringSchema.optional(),
  settlementState: TradeSettlementStateSchema.optional(),
  source: EventSourceSchema,
  occurredAt: IsoTimestampSchema,
  detail: DetailStringSchema.optional(),
});

export type FillFact = Readonly<z.infer<typeof FillFactSchema>>;

/** One strategy instance's claim on a fill's quantity. */
export const AllocationClaimSchema = z.strictObject({
  instanceId: Uuidv7Schema,
  runId: Uuidv7Schema.optional(),
  shares: PositiveDecimalStringSchema,
  /**
   * Explicit share of the fill's fee carried by this claim. Required exactly
   * when the fill charges a fee and more than one owner shares it — a fee is
   * never prorated by silent division (`LEDGER_FEE_SPLIT_MISMATCH`).
   */
  feeAmount: NonNegativeDecimalStringSchema.optional(),
});

export type AllocationClaim = Readonly<z.infer<typeof AllocationClaimSchema>>;

/** An attributed slice of the fill. */
export interface FillAllocation {
  readonly fillId: string;
  readonly scope: "VIRTUAL_STRATEGY";
  readonly instanceId: string;
  readonly runId?: string;
  readonly shares: DecimalString;
  readonly feeAmount: DecimalString;
}

/**
 * The explicitly unattributed remainder (work-plan acceptance 4). Never
 * silently folded into another allocation; `haltRequired` is the literal
 * `true` — the record can state the §9.15 obligation, never waive it.
 */
export interface UnattributedAllocation {
  readonly fillId: string;
  readonly scope: "UNATTRIBUTED";
  readonly shares: DecimalString;
  readonly feeAmount: DecimalString;
  readonly affectedMarketId: string;
  readonly haltRequired: true;
}

export interface FillAllocationResult {
  readonly fill: FillFact;
  readonly allocations: readonly FillAllocation[];
  /** Present exactly when part (or all) of the fill matched no claim. */
  readonly unattributed?: UnattributedAllocation;
  /** Always equals `fill.shares` exactly — the §10.7 sum rule, restated. */
  readonly allocatedShares: DecimalString;
}

const ZERO: DecimalString = "0";

function formatIssues(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

/**
 * Partitions a fill's actual quantity across the claims.
 *
 * - claims summing over the fill → `LEDGER_ALLOCATION_EXCEEDS_FILL`;
 * - duplicate instance ids → `LEDGER_ALLOCATION_DUPLICATE_INSTANCE`;
 * - a shortfall (or no claims at all) → an explicit `UNATTRIBUTED` record;
 * - fee present with shared owners and no explicit split → refusal;
 * - fee splits not summing exactly to the fee → refusal.
 */
export function allocateFill(
  fillInput: unknown,
  claimsInput: readonly unknown[],
): LedgerResult<FillAllocationResult> {
  const parsedFill = FillFactSchema.safeParse(fillInput);
  if (!parsedFill.success) {
    return ledgerFailure(
      ledgerRefusal("LEDGER_INPUT_INVALID", "the value is not a fill fact", {
        issues: formatIssues(parsedFill.error),
      }),
    );
  }
  const fill: FillFact = parsedFill.data;

  const claims: AllocationClaim[] = [];
  const refusals: LedgerRefusal[] = [];
  claimsInput.forEach((claimInput, index) => {
    const parsed = AllocationClaimSchema.safeParse(claimInput);
    if (!parsed.success) {
      refusals.push(
        ledgerRefusal("LEDGER_INPUT_INVALID", `claim ${index} is not an allocation claim`, {
          claimIndex: index,
          issues: formatIssues(parsed.error),
        }),
      );
    } else {
      claims.push(parsed.data);
    }
  });
  if (refusals.length > 0) {
    return ledgerFailure(...refusals);
  }

  const seenInstances = new Set<string>();
  for (const claim of claims) {
    if (seenInstances.has(claim.instanceId)) {
      refusals.push(
        ledgerRefusal(
          "LEDGER_ALLOCATION_DUPLICATE_INSTANCE",
          `instance ${claim.instanceId} appears in more than one claim for fill ${fill.fillId}`,
          { fillId: fill.fillId, instanceId: claim.instanceId },
        ),
      );
    }
    seenInstances.add(claim.instanceId);
  }

  const claimedShares = claims.reduce<DecimalString>(
    (sum, claim) => addDecimal(sum, claim.shares),
    ZERO,
  );
  if (compareDecimal(claimedShares, fill.shares) > 0) {
    refusals.push(
      ledgerRefusal(
        "LEDGER_ALLOCATION_EXCEEDS_FILL",
        `claims total ${claimedShares} shares but fill ${fill.fillId} filled only ` +
          `${fill.shares} (§10.7: allocations never exceed the actual fill quantity)`,
        {
          fillId: fill.fillId,
          fillShares: fill.shares,
          claimedShares,
          excess: subDecimal(claimedShares, fill.shares),
        },
      ),
    );
  }
  if (refusals.length > 0) {
    return ledgerFailure(...refusals);
  }

  const remainder = subDecimal(fill.shares, claimedShares);
  const fee = fill.feeAmount ?? ZERO;

  // Fee partition. A fee follows the fill's ownership partition, but never by
  // silent proration: with more than one owner every owner's fee share is
  // explicit and the shares must sum exactly.
  const owners = claims.length + (isZeroDecimal(remainder) ? 0 : 1);
  let claimFees: readonly DecimalString[];
  let remainderFee: DecimalString;
  if (isZeroDecimal(fee)) {
    claimFees = claims.map(() => ZERO);
    remainderFee = ZERO;
  } else if (owners <= 1) {
    // A single owner carries the whole fee; an explicit split, if present,
    // must still agree with it.
    claimFees = claims.map((claim) => claim.feeAmount ?? fee);
    remainderFee = claims.length === 0 ? fee : ZERO;
    const total = claimFees.reduce<DecimalString>((sum, f) => addDecimal(sum, f), remainderFee);
    if (!isZeroDecimal(subDecimal(total, fee))) {
      return ledgerFailure(feeSplitRefusal(fill, total, fee));
    }
  } else {
    if (claims.some((claim) => claim.feeAmount === undefined)) {
      return ledgerFailure(
        ledgerRefusal(
          "LEDGER_FEE_SPLIT_MISMATCH",
          `fill ${fill.fillId} charges a fee of ${fee} shared by ${owners} owners; ` +
            "every claim must state its explicit feeAmount (a fee is never prorated silently)",
          { fillId: fill.fillId, feeAmount: fee, owners },
        ),
      );
    }
    claimFees = claims.map((claim) => claim.feeAmount ?? ZERO);
    // The unattributed remainder, when present, carries the rest — computed
    // by exact subtraction, refused if negative.
    const claimedFee = claimFees.reduce<DecimalString>((sum, f) => addDecimal(sum, f), ZERO);
    remainderFee = isZeroDecimal(remainder) ? ZERO : subDecimal(fee, claimedFee);
    const total = addDecimal(claimedFee, remainderFee);
    if (!isZeroDecimal(subDecimal(total, fee)) || compareDecimal(remainderFee, ZERO) < 0) {
      return ledgerFailure(feeSplitRefusal(fill, total, fee));
    }
  }

  const allocations: FillAllocation[] = claims.map((claim, index) =>
    Object.freeze({
      fillId: fill.fillId,
      scope: "VIRTUAL_STRATEGY" as const,
      instanceId: claim.instanceId,
      ...(claim.runId === undefined ? {} : { runId: claim.runId }),
      shares: claim.shares,
      feeAmount: claimFees[index] ?? ZERO,
    }),
  );

  const result: FillAllocationResult = isZeroDecimal(remainder)
    ? Object.freeze({
        fill,
        allocations: Object.freeze(allocations),
        allocatedShares: fill.shares,
      })
    : Object.freeze({
        fill,
        allocations: Object.freeze(allocations),
        unattributed: Object.freeze({
          fillId: fill.fillId,
          scope: "UNATTRIBUTED" as const,
          shares: remainder,
          feeAmount: remainderFee,
          affectedMarketId: fill.marketId,
          haltRequired: true as const,
        }),
        allocatedShares: fill.shares,
      });

  return ledgerOk(result);
}

function feeSplitRefusal(
  fill: FillFact,
  splitTotal: DecimalString,
  fee: DecimalString,
): LedgerRefusal {
  return ledgerRefusal(
    "LEDGER_FEE_SPLIT_MISMATCH",
    `fee split for fill ${fill.fillId} sums to ${splitTotal} but the fill's fee is ${fee}`,
    { fillId: fill.fillId, splitTotal, feeAmount: fee },
  );
}
