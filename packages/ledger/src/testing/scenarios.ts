/**
 * Sample values and small builders for this package's tests.
 *
 * TEST-ONLY SUPPORT MODULE. Deliberately not re-exported from `src/index.ts`:
 * WP-200 publishes accounting rules, not fixtures.
 *
 * Every identifier here is a canonical lowercase UUIDv7 with a readable body,
 * because the ADR-016 refusal path only fires on a UUID-shaped value and a
 * test that accidentally used a non-canonical id would be refused for the
 * wrong reason.
 */

import type { LedgerEntryInput, LedgerTransactionInput } from "../transaction.js";

export const ACCOUNT = "acct-paper-1";
export const OTHER_ACCOUNT = "acct-paper-2";
export const VENUE_CLEARING = "clearing-venue";
export const ATTRIBUTION_CLEARING = "clearing-attribution";
export const FEE_EXPENSE = "expense-platform-fee";

/** pUSD and USDC are two DIFFERENT assets here — ADR-006 §7, C-2 unresolved. */
export const PUSD = "pUSD";
export const USDC = "USDC";

export const YES_TOKEN =
  "71321045679252212594626385532706912750332728571942532289631379312455583992563";
export const NO_TOKEN =
  "52114319501245915516055106046884209969926127482827954674443846427813813222426";

export const MARKET_A = "018f3a5c-1111-7000-8000-000000000001";
export const MARKET_B = "018f3a5c-1111-7000-8000-000000000002";
export const INSTANCE_A = "018f3a5c-2222-7000-8000-00000000000a";
export const INSTANCE_B = "018f3a5c-2222-7000-8000-00000000000b";
export const RUN_A = "018f3a5c-3333-7000-8000-00000000000a";

export const TIMESTAMP = "2026-09-02T12:00:00.000Z";

/** Deterministic transaction ids: `tx(1)` … `tx(n)`, all canonical UUIDv7. */
export function tx(n: number): string {
  const suffix = n.toString(16).padStart(12, "0");
  return `018f3a5c-4444-7000-8000-${suffix}`;
}

/** Deterministic fill ids, disjoint from `tx`. */
export function fillId(n: number): string {
  const suffix = n.toString(16).padStart(12, "0");
  return `018f3a5c-5555-7000-8000-${suffix}`;
}

/** A collateral entry. */
export function collateral(
  scope: LedgerEntryInput["scope"],
  accountRef: string,
  amount: string,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  return {
    scope,
    accountRef,
    assetId: PUSD,
    assetKind: "COLLATERAL",
    amount,
    ...extra,
  };
}

/** An outcome-token entry. */
export function token(
  scope: LedgerEntryInput["scope"],
  accountRef: string,
  amount: string,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  return {
    scope,
    accountRef,
    assetId: YES_TOKEN,
    assetKind: "OUTCOME_TOKEN",
    amount,
    marketId: MARKET_A,
    ...extra,
  };
}

/**
 * A transaction with the boilerplate filled in. `entries` and the identity
 * fields are the only things a test normally has to state.
 */
export function transaction(
  overrides: Partial<LedgerTransactionInput> & { readonly entries: readonly LedgerEntryInput[] },
): LedgerTransactionInput {
  return {
    ledgerTransactionId: tx(1),
    eventType: "MANUAL_ADJUSTMENT",
    environment: "PAPER",
    accountRef: ACCOUNT,
    source: "internal",
    occurredAt: TIMESTAMP,
    ...overrides,
  };
}

/**
 * A deposit of `amount` pUSD observed on the actual account, attributed to
 * `UNATTRIBUTED` (nobody asked for it) and cleared externally. Balances per
 * asset and satisfies attribution parity.
 */
export function unattributedDeposit(id: string, amount: string): LedgerTransactionInput {
  return transaction({
    ledgerTransactionId: id,
    eventType: "DEPOSIT_OBSERVED",
    entries: [
      collateral("ACTUAL_ACCOUNT", ACCOUNT, amount),
      collateral("EXTERNAL_CLEARING", VENUE_CLEARING, `-${amount}`),
      collateral("UNATTRIBUTED", ACCOUNT, amount),
      collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, `-${amount}`),
    ],
  });
}

/**
 * Re-attribution: moves `amount` pUSD from `UNATTRIBUTED` to a strategy
 * instance. The actual balance does not move, so parity holds with a zero
 * actual delta on both sides.
 */
export function reattribute(
  id: string,
  amount: string,
  instanceId: string,
): LedgerTransactionInput {
  return transaction({
    ledgerTransactionId: id,
    eventType: "RECONCILIATION_CORRECTION",
    entries: [
      collateral("UNATTRIBUTED", ACCOUNT, `-${amount}`),
      collateral("VIRTUAL_STRATEGY", ACCOUNT, amount, { instanceId }),
    ],
  });
}
