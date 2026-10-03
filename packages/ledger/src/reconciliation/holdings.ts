/**
 * Holdings against the ledger (WP-290; handoff §9.15, §9.17 step 5; §6
 * invariants 7 and 8).
 *
 * Two things the reconciliation coordinator needs from the ledger, and no
 * more:
 *
 * 1. {@link projectedHoldings}: the account's PROJECTED actual holdings (the
 *    `ACTUAL_ACCOUNT` balance lines of a ledger projection), plus every halt
 *    obligation the projection records for the account: each `UNATTRIBUTED`
 *    entry that is an `ACTUAL_ARRIVAL`, and each unexplained actual movement.
 *    The obligation is never waived (`projections.ts`); the coordinator makes
 *    sure each one has a reconciliation break, so a crash between booking a
 *    correction and journaling its break cannot lose the market halt.
 * 2. {@link buildUnattributedCorrection}: the `RECONCILIATION_CORRECTION`
 *    transaction that books a confirmed, unexplained holding delta to the
 *    `UNATTRIBUTED` scope (§9.15: "Any actual balance change lacking
 *    attribution is allocated to UNATTRIBUTED, and the affected market is
 *    halted"). Shape, as `testing/scenarios.ts`'s `unattributedDeposit`:
 *
 *    | Scope | Account | Amount |
 *    | --- | --- | --- |
 *    | `ACTUAL_ACCOUNT` | the account | +delta |
 *    | `EXTERNAL_CLEARING` | the venue clearing account | −delta |
 *    | `UNATTRIBUTED` | the account | +delta |
 *    | `EXTERNAL_CLEARING` | the attribution clearing account | −delta |
 *
 *    It balances per asset and keeps the ADR-006 §2 partition (the actual
 *    movement is attributed, to UNATTRIBUTED), so `Ledger.append` accepts it,
 *    and the projection folds it into an `ACTUAL_ARRIVAL` with
 *    `haltRequired: true`. A negative delta (a holding the venue no longer
 *    shows) is the same transaction with every sign flipped.
 *
 * The COMPARISON itself (which delta is unexplained) is the coordinator's
 * (`packages/oms/src/reconciliation/holdings.ts`): it needs the venue reads
 * and the trades in transit, which this package never sees.
 *
 * Pure: no I/O, no clock, no randomness. Exact decimal strings throughout.
 */

import { isCanonicalDecimalString, isZeroDecimal, negateDecimal, type DecimalString } from "@polymarket-bot/decimal";
import type { RunMode } from "@polymarket-bot/domain";
import { appendData } from "@polymarket-bot/risk/plain-data";

import type { LedgerProjection } from "../projections.js";
import { ledgerFailure, ledgerRefusal, readInputAsData, type LedgerResult } from "../refusals.js";
import { validateTransactionInput, type LedgerEntryInput, type LedgerTransactionInput } from "../transaction.js";
import type { AssetKind } from "../vocabulary.js";

/** One projected actual holding of the account. */
export interface ProjectedHoldingLine {
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly balance: DecimalString;
}

/** One halt obligation the projection records for the account. */
export interface UnattributedArrivalView {
  /** `ACTUAL_ARRIVAL`: an UNATTRIBUTED entry that moved a holding; `UNEXPLAINED_MOVEMENT`: an actual movement nobody claimed. */
  readonly kind: "ACTUAL_ARRIVAL" | "UNEXPLAINED_MOVEMENT";
  readonly ledgerTransactionId: string;
  readonly assetId: string;
  readonly amount: DecimalString;
  readonly marketId: string | null;
}

export interface ProjectedHoldings {
  readonly lines: readonly ProjectedHoldingLine[];
  readonly unattributedArrivals: readonly UnattributedArrivalView[];
}

/** The account's projected actual holdings and its recorded halt obligations. Zero lines are absent. */
export function projectedHoldings(projection: LedgerProjection, accountRef: string): ProjectedHoldings {
  const lines: ProjectedHoldingLine[] = [];
  for (const line of projection.balances.values()) {
    if (line.scope !== "ACTUAL_ACCOUNT" || line.accountRef !== accountRef) continue;
    appendData(lines, Object.freeze({ assetId: line.assetId, assetKind: line.assetKind, balance: line.balance }));
  }
  lines.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  const arrivals: UnattributedArrivalView[] = [];
  for (const record of projection.unattributedActivity) {
    if (record.activityKind !== "ACTUAL_ARRIVAL" || record.accountRef !== accountRef) continue;
    appendData(
      arrivals,
      Object.freeze({
        kind: "ACTUAL_ARRIVAL" as const,
        ledgerTransactionId: record.ledgerTransactionId,
        assetId: record.assetId,
        amount: record.amount,
        marketId: record.affectedMarketId,
      }),
    );
  }
  for (const record of projection.unexplainedMovements) {
    if (record.accountRef !== accountRef) continue;
    appendData(
      arrivals,
      Object.freeze({
        kind: "UNEXPLAINED_MOVEMENT" as const,
        ledgerTransactionId: record.ledgerTransactionId,
        assetId: record.assetId,
        amount: record.unexplained,
        marketId: record.affectedMarketId,
      }),
    );
  }
  return Object.freeze({ lines: Object.freeze(lines), unattributedArrivals: Object.freeze(arrivals) });
}

/** What a correction books. Every id is caller-minted (this package draws no randomness). */
export interface UnattributedCorrectionInput {
  readonly ledgerTransactionId: string;
  readonly reconciliationRunId: string;
  readonly environment: RunMode;
  readonly accountRef: string;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  /** Required for an outcome token (its market is the one halted); `null` for collateral. */
  readonly marketId: string | null;
  /** The confirmed, unexplained delta: authoritative minus projected. Never zero. */
  readonly delta: DecimalString;
  readonly occurredAt: string;
  readonly venueClearingAccount: string;
  readonly attributionClearingAccount: string;
}

const CORRECTION_KEYS = [
  "ledgerTransactionId",
  "reconciliationRunId",
  "environment",
  "accountRef",
  "assetId",
  "assetKind",
  "marketId",
  "delta",
  "occurredAt",
  "venueClearingAccount",
  "attributionClearingAccount",
] as const;

function own(record: unknown, key: string): unknown {
  if (record === null || typeof record !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? (descriptor.value as unknown) : undefined;
}

/**
 * Build the `RECONCILIATION_CORRECTION` that books `delta` of one asset to
 * the account's `UNATTRIBUTED` scope (see the header). The result went
 * through the ledger's own door (`validateTransactionInput`); appending it is
 * the caller's (`Ledger.append`, which also checks the per-asset balance and
 * the partition).
 */
export function buildUnattributedCorrection(input: unknown): LedgerResult<LedgerTransactionInput> {
  const read = readInputAsData(input, "correction", "unattributed correction");
  if (!read.ok) return ledgerFailure(read.refusal);
  const record = read.value;
  const keys = record !== null && typeof record === "object" ? Object.keys(record) : [];
  if (keys.length !== CORRECTION_KEYS.length || !CORRECTION_KEYS.every((key) => keys.includes(key))) {
    return ledgerFailure(ledgerRefusal("LEDGER_INPUT_INVALID", "an unattributed correction carries exactly its eleven fields", { keys }));
  }
  const delta = own(record, "delta");
  if (!isCanonicalDecimalString(delta) || isZeroDecimal(delta)) {
    return ledgerFailure(ledgerRefusal("LEDGER_ENTRY_AMOUNT_ZERO", "a correction books a non-zero canonical decimal delta", { delta: typeof delta === "string" ? delta : null }));
  }
  const assetKind = own(record, "assetKind");
  const marketId = own(record, "marketId");
  if (assetKind === "OUTCOME_TOKEN" && (typeof marketId !== "string" || marketId.length === 0)) {
    return ledgerFailure(ledgerRefusal("LEDGER_MARKET_REQUIRED", "an outcome-token correction names the market it halts"));
  }
  if (marketId !== null && typeof marketId !== "string") {
    return ledgerFailure(ledgerRefusal("LEDGER_INPUT_INVALID", "marketId is a market id or null"));
  }
  const accountRef = own(record, "accountRef") as string;
  const assetId = own(record, "assetId") as string;
  const negated = negateDecimal(delta);
  const market = typeof marketId === "string" ? { marketId } : {};
  const leg = (scope: LedgerEntryInput["scope"], account: unknown, amount: DecimalString, withMarket: boolean): unknown => ({
    scope,
    accountRef: account,
    assetId,
    assetKind,
    amount,
    ...(withMarket ? market : {}),
  });
  const transaction = {
    ledgerTransactionId: own(record, "ledgerTransactionId"),
    eventType: "RECONCILIATION_CORRECTION",
    environment: own(record, "environment"),
    accountRef,
    source: "internal",
    occurredAt: own(record, "occurredAt"),
    reconciliationRunId: own(record, "reconciliationRunId"),
    ...market,
    detail: "WP-290: a confirmed holding delta no activity explains, booked to UNATTRIBUTED (handoff §9.15)",
    entries: [
      leg("ACTUAL_ACCOUNT", accountRef, delta, true),
      leg("EXTERNAL_CLEARING", own(record, "venueClearingAccount"), negated, false),
      leg("UNATTRIBUTED", accountRef, delta, true),
      leg("EXTERNAL_CLEARING", own(record, "attributionClearingAccount"), negated, false),
    ],
  };
  return validateTransactionInput(transaction);
}

/** The days from 1970-01-01 to a civil date's inverse (H. Hinnant's `civil_from_days`; exact integer arithmetic). */
function civilFromDays(days: number): { readonly year: number; readonly month: number; readonly day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * An epoch-millisecond instant as an ISO-8601 UTC timestamp
 * (`YYYY-MM-DDTHH:MM:SS.mmmZ`), by integer arithmetic (no clock is read and no
 * `Date` is built). `undefined` outside years 1970–9999.
 */
export function isoFromEpochMs(ms: number): string | undefined {
  if (!Number.isSafeInteger(ms) || ms < 0) return undefined;
  const days = Math.floor(ms / 86_400_000);
  const rest = ms - days * 86_400_000;
  const { year, month, day } = civilFromDays(days);
  if (year > 9999) return undefined;
  const hours = Math.floor(rest / 3_600_000);
  const minutes = Math.floor((rest % 3_600_000) / 60_000);
  const seconds = Math.floor((rest % 60_000) / 1000);
  const millis = rest % 1000;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}Z`;
}
