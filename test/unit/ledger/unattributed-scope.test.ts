/**
 * WP-200 acceptance 4, end to end: "Unattributed activity creates an explicit
 * scope."
 *
 * The probe the work package asks for: a fill matching NO known allocation
 * lands in a NAMED unattributed scope with a typed record, and the projections
 * surface it VISIBLY. "Visibly" is the part worth being strict about — a
 * scope that exists but is only reachable by summing balances by hand is not
 * surfaced, so this suite asserts the record, the balance line, the exposure
 * summary, and the halt obligation, and it asserts that none of them can be
 * reached through the "everything is fine" path.
 */

import { describe, expect, it } from "vitest";

import {
  Ledger,
  allocateFill,
  buildFillPosting,
  balancesOfScope,
  projectLedger,
  unattributedExposure,
  virtualPositions,
} from "../../../packages/ledger/src/index.js";
import type {
  FillAllocationResult,
  FillPosting,
  LedgerProjection,
} from "../../../packages/ledger/src/index.js";
import { foldPnlRecords } from "../../../packages/pnl/src/index.js";

const ACCOUNT = "acct-paper-1";
const PUSD = "pUSD";
const YES_TOKEN =
  "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const MARKET_A = "018f3a5c-1111-7000-8000-000000000001";
const INSTANCE_A = "018f3a5c-2222-7000-8000-00000000000a";
const UNKNOWN_INSTANCE = "018f3a5c-2222-7000-8000-0000000000ff";
const TIMESTAMP = "2026-09-02T12:00:00.000Z";

const ACCOUNTS = {
  venueClearingRef: "clearing-venue",
  attributionClearingRef: "clearing-attribution",
  feeExpenseRef: "expense-platform-fee",
};

function id(prefix: string, n: number): string {
  return `018f3a5c-${prefix}-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

const UNKNOWN_FILL = {
  fillId: id("5555", 1),
  marketId: MARKET_A,
  environment: "PAPER",
  accountRef: ACCOUNT,
  tokenAssetId: YES_TOKEN,
  denominationAssetId: PUSD,
  side: "BUY",
  shares: "10",
  price: "0.4",
  source: "polymarket",
  occurredAt: TIMESTAMP,
} as const;

function allocate(claims: readonly unknown[]): FillAllocationResult {
  const result = allocateFill(UNKNOWN_FILL, claims);
  if (!result.ok) {
    throw new Error(`allocation refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function postingOf(claims: readonly unknown[]): FillPosting {
  const result = buildFillPosting(allocate(claims), ACCOUNTS, {
    principalTransactionId: id("4444", 1),
    tokenTransactionId: id("4444", 2),
  });
  if (!result.ok) {
    throw new Error(`posting refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function projectionOf(posting: FillPosting): LedgerProjection {
  let ledger = Ledger.empty("PAPER");
  for (const transaction of posting.transactions) {
    const result = ledger.append(transaction);
    if (!result.ok) {
      throw new Error(`append refused: ${JSON.stringify(result.refusals)}`);
    }
    ledger = result.value.ledger;
  }
  return projectLedger(ledger);
}

describe("a fill matching no known allocation", () => {
  // The composition root looked up the claims for this fill and found none:
  // no strategy instance it knows about asked for this trade.
  const posting = postingOf([]);
  const projection = projectionOf(posting);

  it("is allocated to a NAMED scope, not dropped and not guessed onto someone", () => {
    const result = allocate([]);
    expect(result.allocations).toEqual([]);
    expect(result.unattributed?.scope).toBe("UNATTRIBUTED");
    expect(result.unattributed?.shares).toBe("10");
  });

  it("still balances per asset: the ledger accepted every posting", () => {
    expect(posting.transactions.length).toBeGreaterThan(0);
    // `projectionOf` throws on any refusal, so reaching here is the assertion;
    // this states the transaction count explicitly so a silent drop shows up.
    expect(projection.transactionCount).toBe(posting.transactions.length);
  });

  it("produces a typed record naming the asset, the account, and the market", () => {
    const tokenRecords = projection.unattributedActivity.filter(
      (record) => record.assetId === YES_TOKEN,
    );
    expect(tokenRecords).toHaveLength(1);
    expect(tokenRecords[0]).toMatchObject({
      assetId: YES_TOKEN,
      assetKind: "OUTCOME_TOKEN",
      accountRef: ACCOUNT,
      amount: "10",
      affectedMarketId: MARKET_A,
      activityKind: "ACTUAL_ARRIVAL",
      haltRequired: true,
    });
  });

  it("records the collateral side as unattributed too, not only the token side", () => {
    const collateralRecords = projection.unattributedActivity.filter(
      (record) => record.assetId === PUSD,
    );
    expect(collateralRecords).toHaveLength(1);
    expect(collateralRecords[0]?.amount).toBe("-4");
  });

  it("shows a real UNATTRIBUTED balance line, not an empty scope", () => {
    const lines = balancesOfScope(projection, "UNATTRIBUTED");
    expect(lines.map((line) => [line.assetId, line.balance])).toEqual([
      [YES_TOKEN, "10"],
      [PUSD, "-4"],
    ]);
  });

  it("attributes the position to NO strategy instance", () => {
    expect(virtualPositions(projection)).toEqual([]);
  });

  it("surfaces the exposure with an open halt obligation per (account, asset)", () => {
    expect(unattributedExposure(projection)).toEqual([
      {
        accountRef: ACCOUNT,
        assetId: YES_TOKEN,
        net: "10",
        affectedMarketIds: [MARKET_A],
        haltTriggerCount: 1,
        haltRequired: true,
      },
      {
        accountRef: ACCOUNT,
        assetId: PUSD,
        net: "-4",
        affectedMarketIds: [MARKET_A],
        haltTriggerCount: 1,
        haltRequired: true,
      },
    ]);
  });

  it("gives the unattributed activity its own PnL stream, not a strategy's", () => {
    const unattributedRecords = posting.pnlRecords.filter(
      (record) => record.owner.scope === "UNATTRIBUTED",
    );
    expect(unattributedRecords).toHaveLength(1);

    const folded = foldPnlRecords(
      { scope: "UNATTRIBUTED", environment: "PAPER", accountRef: ACCOUNT },
      unattributedRecords,
    );
    expect(folded.ok).toBe(true);
    if (!folded.ok) {
      return;
    }
    expect(folded.value.lots.get(YES_TOKEN)?.shares).toBe("10");

    // And the strategy's stream refuses to absorb it.
    const misattributed = foldPnlRecords(
      {
        scope: "VIRTUAL_STRATEGY",
        environment: "PAPER",
        accountRef: ACCOUNT,
        instanceId: INSTANCE_A,
      },
      unattributedRecords,
    );
    expect(misattributed.ok).toBe(false);
    if (misattributed.ok) {
      return;
    }
    expect(misattributed.refusals.map((refusal) => refusal.code)).toContain(
      "PNL_OWNER_MISMATCH",
    );
  });
});

describe("a partially claimed fill splits, it does not round", () => {
  const posting = postingOf([{ instanceId: INSTANCE_A, shares: "7" }]);
  const projection = projectionOf(posting);

  it("attributes exactly the claimed part and no more", () => {
    expect(
      virtualPositions(projection).map((line) => [line.instanceId, line.assetId, line.balance]),
    ).toEqual([
      [INSTANCE_A, YES_TOKEN, "7"],
      [INSTANCE_A, PUSD, "-2.8"],
    ]);
  });

  it("puts the remaining 3 shares in the unattributed scope, not in the claim", () => {
    const line = balancesOfScope(projection, "UNATTRIBUTED").find(
      (entry) => entry.assetId === YES_TOKEN,
    );
    expect(line?.balance).toBe("3");
  });

  it("keeps the actual position equal to attributed plus unattributed", () => {
    const actual = balancesOfScope(projection, "ACTUAL_ACCOUNT").find(
      (entry) => entry.assetId === YES_TOKEN,
    );
    expect(actual?.balance).toBe("10");
  });

  it("still raises the halt obligation for the unclaimed part", () => {
    const exposure = unattributedExposure(projection).find(
      (line) => line.assetId === YES_TOKEN,
    );
    expect(exposure?.haltRequired).toBe(true);
  });
});

describe("the clean path does not touch the unattributed scope", () => {
  const posting = postingOf([{ instanceId: INSTANCE_A, shares: "10" }]);
  const projection = projectionOf(posting);

  it("records no unattributed activity at all", () => {
    expect(projection.unattributedActivity).toEqual([]);
    expect(unattributedExposure(projection)).toEqual([]);
    expect(balancesOfScope(projection, "UNATTRIBUTED")).toEqual([]);
  });

  it("attributes the whole fill to the claiming instance", () => {
    const line = virtualPositions(projection).find((entry) => entry.assetId === YES_TOKEN);
    expect(line).toMatchObject({ instanceId: INSTANCE_A, balance: "10" });
  });
});

describe("an over-claim is refused rather than absorbed", () => {
  it("refuses claims summing past the fill, naming the excess", () => {
    const result = allocateFill(UNKNOWN_FILL, [
      { instanceId: INSTANCE_A, shares: "7" },
      { instanceId: UNKNOWN_INSTANCE, shares: "5" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_ALLOCATION_EXCEEDS_FILL");
    expect(result.refusals[0]?.details).toMatchObject({ excess: "2" });
  });
});
