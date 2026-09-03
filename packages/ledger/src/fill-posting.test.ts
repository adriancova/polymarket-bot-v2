/**
 * The bridge from an allocated fill to balanced ledger transactions.
 *
 * The strongest assertion available here is that every transaction this
 * builder emits APPENDS — that is, it passes the same per-asset zero-sum and
 * attribution-parity checks a hand-written transaction has to pass. The
 * builder is not trusted; it is checked by the same gate.
 */

import { describe, expect, it } from "vitest";

import { allocateFill } from "./allocation.js";
import type { FillAllocationResult } from "./allocation.js";
import { checkAttributionParity, checkPerAssetBalance, netByAsset } from "./balance.js";
import { buildFillPosting } from "./fill-posting.js";
import type { FillPosting } from "./fill-posting.js";
import { Ledger } from "./ledger.js";
import { actualPositions, projectLedger, virtualPositions } from "./projections.js";
import {
  ACCOUNT,
  ATTRIBUTION_CLEARING,
  FEE_EXPENSE,
  INSTANCE_A,
  INSTANCE_B,
  MARKET_A,
  PUSD,
  TIMESTAMP,
  VENUE_CLEARING,
  YES_TOKEN,
  fillId,
  tx,
} from "./testing/scenarios.js";

const ACCOUNTS = {
  venueClearingRef: VENUE_CLEARING,
  attributionClearingRef: ATTRIBUTION_CLEARING,
  feeExpenseRef: FEE_EXPENSE,
};

const IDS = {
  principalTransactionId: tx(1),
  tokenTransactionId: tx(2),
  feeTransactionId: tx(3),
};

const BUY = {
  fillId: fillId(1),
  marketId: MARKET_A,
  environment: "PAPER",
  accountRef: ACCOUNT,
  tokenAssetId: YES_TOKEN,
  denominationAssetId: PUSD,
  side: "BUY",
  shares: "10",
  price: "0.42",
  source: "polymarket",
  occurredAt: TIMESTAMP,
} as const;

function allocate(fill: unknown, claims: readonly unknown[]): FillAllocationResult {
  const result = allocateFill(fill, claims);
  if (!result.ok) {
    throw new Error(`allocation refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function post(
  fill: unknown,
  claims: readonly unknown[],
  ids: unknown = IDS,
): FillPosting {
  const result = buildFillPosting(allocate(fill, claims), ACCOUNTS, ids);
  if (!result.ok) {
    throw new Error(`posting refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

/** Appends every transaction of a posting, asserting each is accepted. */
function appendAll(posting: FillPosting): Ledger {
  let ledger = Ledger.empty("PAPER");
  for (const transaction of posting.transactions) {
    const result = ledger.append(transaction);
    if (!result.ok) {
      throw new Error(
        `${transaction.eventType} refused: ${JSON.stringify(result.refusals)}`,
      );
    }
    ledger = result.value.ledger;
  }
  return ledger;
}

describe("buildFillPosting: every emitted transaction is appendable", () => {
  const cases: readonly (readonly [string, unknown, readonly unknown[]])[] = [
    ["fully attributed buy", BUY, [{ instanceId: INSTANCE_A, shares: "10" }]],
    [
      "split buy",
      BUY,
      [
        { instanceId: INSTANCE_A, shares: "6" },
        { instanceId: INSTANCE_B, shares: "4" },
      ],
    ],
    ["partially attributed buy", BUY, [{ instanceId: INSTANCE_A, shares: "6" }]],
    ["wholly unattributed buy", BUY, []],
    [
      "buy with a fee",
      { ...BUY, feeAmount: "0.07", feeScheduleVersionRef: "fees-2026-09-01" },
      [{ instanceId: INSTANCE_A, shares: "10" }],
    ],
    [
      "sell",
      { ...BUY, side: "SELL", fillId: fillId(2) },
      [{ instanceId: INSTANCE_A, shares: "10" }],
    ],
    [
      "sell with a fee split and an unattributed remainder",
      { ...BUY, side: "SELL", fillId: fillId(3), feeAmount: "0.05" },
      [{ instanceId: INSTANCE_A, shares: "6", feeAmount: "0.03" }],
    ],
  ];

  for (const [name, fill, claims] of cases) {
    it(`balances per asset and satisfies parity: ${name}`, () => {
      const posting = post(fill, claims);
      for (const transaction of posting.transactions) {
        expect(checkPerAssetBalance(transaction)).toEqual([]);
        expect(checkAttributionParity(transaction)).toEqual([]);
      }
      expect(appendAll(posting).length).toBe(posting.transactions.length);
    });
  }
});

describe("buildFillPosting: what the transactions say", () => {
  it("books a BUY as collateral out and tokens in", () => {
    const posting = post(BUY, [{ instanceId: INSTANCE_A, shares: "10" }]);
    const principal = posting.transactions.find(
      (transaction) => transaction.eventType === "TRADE_PRINCIPAL",
    );
    const actualLeg = principal?.entries.find((entry) => entry.scope === "ACTUAL_ACCOUNT");
    expect(actualLeg?.amount).toBe("-4.2");
    expect(actualLeg?.assetId).toBe(PUSD);

    const tokenTransaction = posting.transactions.find(
      (transaction) => transaction.eventType === "OUTCOME_TOKEN_RECEIPT",
    );
    expect(
      tokenTransaction?.entries.find((entry) => entry.scope === "ACTUAL_ACCOUNT")?.amount,
    ).toBe("10");
  });

  it("books a SELL as tokens out and collateral in", () => {
    const posting = post({ ...BUY, side: "SELL" }, [{ instanceId: INSTANCE_A, shares: "10" }]);
    const principal = posting.transactions.find(
      (transaction) => transaction.eventType === "TRADE_PRINCIPAL",
    );
    expect(principal?.entries.find((entry) => entry.scope === "ACTUAL_ACCOUNT")?.amount).toBe(
      "4.2",
    );
    const tokenTransaction = posting.transactions.find(
      (transaction) => transaction.eventType === "OUTCOME_TOKEN_DELIVERY",
    );
    expect(
      tokenTransaction?.entries.find((entry) => entry.scope === "ACTUAL_ACCOUNT")?.amount,
    ).toBe("-10");
  });

  it("computes notional exactly (0.42 x 10 = 4.2, not 4.199999...)", () => {
    const posting = post({ ...BUY, price: "0.07", shares: "3" }, []);
    const principal = posting.transactions.find(
      (transaction) => transaction.eventType === "TRADE_PRINCIPAL",
    );
    expect(netByAsset(principal!).get(PUSD)).toBe("0");
    expect(principal?.entries.find((entry) => entry.scope === "ACTUAL_ACCOUNT")?.amount).toBe(
      "-0.21",
    );
  });

  it("carries the fill and market ids onto every transaction (F15/F16)", () => {
    const posting = post({ ...BUY, feeAmount: "0.07" }, [
      { instanceId: INSTANCE_A, shares: "10" },
    ]);
    expect(posting.transactions).toHaveLength(3);
    for (const transaction of posting.transactions) {
      expect(transaction.fillId).toBe(fillId(1));
      expect(transaction.marketId).toBe(MARKET_A);
      expect(transaction.accountRef).toBe(ACCOUNT);
    }
  });

  it("emits no PLATFORM_FEE transaction when no fee was charged", () => {
    const posting = post(BUY, [{ instanceId: INSTANCE_A, shares: "10" }]);
    expect(posting.transactions.map((transaction) => transaction.eventType)).toEqual([
      "TRADE_PRINCIPAL",
      "OUTCOME_TOKEN_RECEIPT",
    ]);
  });

  it("refuses to build a fee posting without a fee transaction id", () => {
    const result = buildFillPosting(
      allocate({ ...BUY, feeAmount: "0.07" }, [{ instanceId: INSTANCE_A, shares: "10" }]),
      ACCOUNTS,
      { principalTransactionId: tx(1), tokenTransactionId: tx(2) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_INPUT_INVALID");
    expect(result.refusals[0]?.message).toContain("feeTransactionId");
  });

  it("refuses malformed posting accounts", () => {
    const result = buildFillPosting(allocate(BUY, []), { venueClearingRef: "" }, IDS);
    expect(result.ok).toBe(false);
  });
});

describe("the projection a posted fill produces", () => {
  it("shows the actual position and its attribution to two instances", () => {
    const posting = post(BUY, [
      { instanceId: INSTANCE_A, shares: "6" },
      { instanceId: INSTANCE_B, shares: "4" },
    ]);
    const projection = projectLedger(appendAll(posting));

    expect(actualPositions(projection).map((line) => [line.assetId, line.balance])).toEqual([
      [YES_TOKEN, "10"],
    ]);
    expect(
      virtualPositions(projection)
        .filter((line) => line.assetId === YES_TOKEN)
        .map((line) => [line.instanceId, line.balance]),
    ).toEqual([
      [INSTANCE_A, "6"],
      [INSTANCE_B, "4"],
    ]);
  });

  it("surfaces the unattributed remainder of a partially claimed fill", () => {
    const posting = post(BUY, [{ instanceId: INSTANCE_A, shares: "6" }]);
    const projection = projectLedger(appendAll(posting));
    const tokenArrivals = projection.unattributedActivity.filter(
      (record) => record.assetId === YES_TOKEN,
    );
    expect(tokenArrivals).toHaveLength(1);
    expect(tokenArrivals[0]).toMatchObject({
      amount: "4",
      activityKind: "ACTUAL_ARRIVAL",
      haltRequired: true,
      affectedMarketId: MARKET_A,
    });
  });
});

describe("the PnL records a posted fill implies", () => {
  it("emits one TRADE record per owner, plus the actual-account stream", () => {
    const posting = post(BUY, [
      { instanceId: INSTANCE_A, shares: "6" },
      { instanceId: INSTANCE_B, shares: "4" },
    ]);
    const trades = posting.pnlRecords.filter((record) => record.kind === "TRADE");
    expect(trades).toHaveLength(3);
    expect(trades.map((record) => record.owner.scope)).toEqual([
      "ACTUAL_ACCOUNT",
      "VIRTUAL_STRATEGY",
      "VIRTUAL_STRATEGY",
    ]);
    expect(trades.map((record) => (record.kind === "TRADE" ? record.shares : ""))).toEqual([
      "10",
      "6",
      "4",
    ]);
  });

  it("emits a FEE record per fee-bearing owner, carrying the schedule version", () => {
    const posting = post(
      { ...BUY, feeAmount: "0.07", feeScheduleVersionRef: "fees-2026-09-01" },
      [{ instanceId: INSTANCE_A, shares: "10" }],
    );
    const fees = posting.pnlRecords.filter((record) => record.kind === "FEE");
    expect(fees).toHaveLength(2);
    for (const fee of fees) {
      expect(fee).toMatchObject({ amount: "0.07", scheduleVersionRef: "fees-2026-09-01" });
    }
  });

  it("emits no FEE record when the fill charged no fee", () => {
    const posting = post(BUY, [{ instanceId: INSTANCE_A, shares: "10" }]);
    expect(posting.pnlRecords.filter((record) => record.kind === "FEE")).toEqual([]);
  });

  it("gives the unattributed slice its own PnL owner", () => {
    const posting = post(BUY, [{ instanceId: INSTANCE_A, shares: "6" }]);
    const unattributed = posting.pnlRecords.filter(
      (record) => record.owner.scope === "UNATTRIBUTED",
    );
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]).toMatchObject({ kind: "TRADE", shares: "4" });
  });
});
