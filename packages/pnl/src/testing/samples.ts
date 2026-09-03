/**
 * Sample values and builders for this package's tests.
 *
 * TEST-ONLY SUPPORT MODULE. Deliberately not re-exported from `src/index.ts`.
 */

import type { PnlOwner } from "../records.js";

export const ACCOUNT = "acct-paper-1";
export const INSTANCE_A = "018f3a5c-2222-7000-8000-00000000000a";
export const INSTANCE_B = "018f3a5c-2222-7000-8000-00000000000b";
export const MARKET_A = "018f3a5c-1111-7000-8000-000000000001";

/** pUSD and USDC are two DIFFERENT assets — ADR-006 §7, C-2 unresolved. */
export const PUSD = "pUSD";
export const USDC = "USDC";

export const YES_TOKEN =
  "71321045679252212594626385532706912750332728571942532289631379312455583992563";
export const NO_TOKEN =
  "52114319501245915516055106046884209969926127482827954674443846427813813222426";

export const TIMESTAMP = "2026-09-02T12:00:00.000Z";
export const PERIOD_START = "2026-09-01T00:00:00.000Z";
export const PERIOD_END = "2026-09-02T00:00:00.000Z";

export const INSTANCE_OWNER: PnlOwner = { scope: "VIRTUAL_STRATEGY", instanceId: INSTANCE_A };
export const ACCOUNT_OWNER: PnlOwner = { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT };

/** Deterministic record refs, all canonical lowercase UUIDv7. */
export function ref(n: number): string {
  return `018f3a5c-6666-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A ledger transaction id, disjoint from `ref`. */
export function ledgerTx(n: number): string {
  return `018f3a5c-7777-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function buy(
  n: number,
  shares: string,
  price: string,
  owner: PnlOwner = INSTANCE_OWNER,
): Record<string, unknown> {
  return {
    kind: "TRADE",
    ref: ref(n),
    owner,
    marketId: MARKET_A,
    tokenAssetId: YES_TOKEN,
    denominationAsset: PUSD,
    side: "BUY",
    shares,
    price,
  };
}

export function sell(
  n: number,
  shares: string,
  price: string,
  owner: PnlOwner = INSTANCE_OWNER,
): Record<string, unknown> {
  return { ...buy(n, shares, price, owner), side: "SELL" };
}

export function fee(
  n: number,
  amount: string,
  scheduleVersionRef?: string,
  owner: PnlOwner = INSTANCE_OWNER,
): Record<string, unknown> {
  return {
    kind: "FEE",
    ref: ref(n),
    owner,
    denominationAsset: PUSD,
    amount,
    ...(scheduleVersionRef === undefined ? {} : { scheduleVersionRef }),
  };
}

/** An OBSERVED reward payout: settlement-grade, evidenced by a ledger id. */
export function rewardPayout(
  n: number,
  amount: string,
  owner: PnlOwner = INSTANCE_OWNER,
): Record<string, unknown> {
  return {
    kind: "REWARD_PAYOUT",
    ref: ref(n),
    owner,
    programType: "LIQUIDITY_REWARD",
    amount,
    denominationAsset: PUSD,
    ledgerTransactionId: ledgerTx(n),
  };
}

/** A reward ESTIMATE: analytics, never money. */
export function rewardEstimate(
  n: number,
  amount: string,
  owner: PnlOwner = INSTANCE_OWNER,
): Record<string, unknown> {
  return {
    kind: "REWARD_ESTIMATE",
    ref: ref(n),
    owner,
    programType: "LIQUIDITY_REWARD",
    amount,
    denominationAsset: PUSD,
    methodology: "QUADRATIC_SCORE_V1",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    computedAt: TIMESTAMP,
  };
}

export function realization(
  n: number,
  shares: string,
  payoutPerShare: string,
  owner: PnlOwner = INSTANCE_OWNER,
): Record<string, unknown> {
  return {
    kind: "REALIZATION",
    ref: ref(n),
    owner,
    realizationKind: "REDEEM",
    tokenAssetId: YES_TOKEN,
    shares,
    payoutPerShare,
    denominationAsset: PUSD,
  };
}
