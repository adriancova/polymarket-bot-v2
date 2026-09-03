/**
 * The append-only ledger value itself: immutability, the cross-transaction
 * rules an isolated transaction cannot express, and rebuild.
 *
 * "Append-only" here is a property of the VALUE, not a promise about a
 * database: `append` returns a new ledger and the receiver is unchanged, so a
 * caller holding an earlier snapshot still sees the history it saw. That is
 * what makes the mutation probe in `projections.test.ts` meaningful — there is
 * no in-place edit path to test, because there is none to have.
 */

import { describe, expect, it } from "vitest";

import { Ledger } from "./ledger.js";
import { LedgerConfigurationError } from "./refusals.js";
import {
  ACCOUNT,
  ATTRIBUTION_CLEARING,
  MARKET_A,
  MARKET_B,
  OTHER_ACCOUNT,
  PUSD,
  VENUE_CLEARING,
  YES_TOKEN,
  collateral,
  reattribute,
  token,
  transaction,
  tx,
  unattributedDeposit,
} from "./testing/scenarios.js";
import type { LedgerTransactionInput } from "./transaction.js";

/** Appends, asserting success, and returns the new ledger. */
function appended(ledger: Ledger, input: LedgerTransactionInput): Ledger {
  const result = ledger.append(input);
  if (!result.ok) {
    throw new Error(`unexpected refusal: ${JSON.stringify(result.refusals)}`);
  }
  return result.value.ledger;
}

function refusalCodes(ledger: Ledger, input: unknown): readonly string[] {
  const result = ledger.append(input);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe("Ledger.empty", () => {
  it("throws a configuration error on a value that is not a run mode", () => {
    expect(() => Ledger.empty("BANANA" as never)).toThrow(LedgerConfigurationError);
  });

  it("starts empty", () => {
    const ledger = Ledger.empty("PAPER");
    expect(ledger.length).toBe(0);
    expect(ledger.environment).toBe("PAPER");
    expect(ledger.byId(tx(1))).toBeUndefined();
  });
});

describe("append-only immutability", () => {
  it("returns a new ledger and leaves the receiver untouched", () => {
    const base = Ledger.empty("PAPER");
    const next = appended(base, unattributedDeposit(tx(1), "100"));
    expect(base.length).toBe(0);
    expect(next.length).toBe(1);
    expect(base.byId(tx(1))).toBeUndefined();
    expect(next.byId(tx(1))?.sequence).toBe(0);
  });

  it("assigns a monotonic 0-based sequence, independent of caller timestamps", () => {
    let ledger = Ledger.empty("PAPER");
    ledger = appended(ledger, unattributedDeposit(tx(1), "1"));
    ledger = appended(ledger, {
      ...unattributedDeposit(tx(2), "2"),
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    expect(ledger.transactions().map((entry) => entry.sequence)).toEqual([0, 1]);
    expect(ledger.transactions().map((entry) => entry.transaction.ledgerTransactionId)).toEqual([
      tx(1),
      tx(2),
    ]);
  });

  it("lets two branches diverge from one snapshot without disturbing each other", () => {
    const base = appended(Ledger.empty("PAPER"), unattributedDeposit(tx(1), "100"));
    const left = appended(base, unattributedDeposit(tx(2), "10"));
    const right = appended(base, unattributedDeposit(tx(3), "20"));

    expect(base.length).toBe(1);
    expect(left.length).toBe(2);
    expect(right.length).toBe(2);
    expect(left.byId(tx(3))).toBeUndefined();
    expect(right.byId(tx(2))).toBeUndefined();
    expect(left.byId(tx(2))?.transaction.entries[0]?.amount).toBe("10");
    expect(right.byId(tx(3))?.transaction.entries[0]?.amount).toBe("20");
  });

  it("freezes appended transactions so a caller cannot edit recorded history", () => {
    const ledger = appended(Ledger.empty("PAPER"), unattributedDeposit(tx(1), "100"));
    const record = ledger.byId(tx(1));
    expect(record).toBeDefined();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.transaction)).toBe(true);
    expect(Object.isFrozen(record?.transaction.entries[0])).toBe(true);
    expect(() => {
      (record?.transaction.entries[0] as { amount: string }).amount = "999999";
    }).toThrow(TypeError);
    expect(ledger.byId(tx(1))?.transaction.entries[0]?.amount).toBe("100");
  });
});

describe("cross-transaction rules", () => {
  it("refuses a duplicate transaction id", () => {
    const ledger = appended(Ledger.empty("PAPER"), unattributedDeposit(tx(1), "100"));
    expect(refusalCodes(ledger, unattributedDeposit(tx(1), "5"))).toContain(
      "LEDGER_DUPLICATE_TRANSACTION_ID",
    );
  });

  it("refuses a transaction from another environment (§10.8 separation)", () => {
    const ledger = Ledger.empty("PAPER");
    const result = ledger.append({
      ...unattributedDeposit(tx(1), "100"),
      environment: "BACKTEST",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const mismatch = result.refusals.find(
      (refusal) => refusal.code === "LEDGER_ENVIRONMENT_MISMATCH",
    );
    expect(mismatch?.details).toMatchObject({
      ledgerEnvironment: "PAPER",
      transactionEnvironment: "BACKTEST",
    });
  });

  it("refuses an asset id whose kind contradicts the recorded one", () => {
    const ledger = appended(Ledger.empty("PAPER"), unattributedDeposit(tx(1), "100"));
    expect(ledger.assetKindOf(PUSD)).toBe("COLLATERAL");
    const codes = refusalCodes(
      ledger,
      transaction({
        ledgerTransactionId: tx(2),
        entries: [
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: ACCOUNT,
            assetId: PUSD,
            assetKind: "OUTCOME_TOKEN",
            amount: "1",
            marketId: MARKET_A,
          },
          {
            scope: "EXTERNAL_CLEARING",
            accountRef: VENUE_CLEARING,
            assetId: PUSD,
            assetKind: "OUTCOME_TOKEN",
            amount: "-1",
            marketId: MARKET_A,
          },
        ],
      }),
    );
    expect(codes).toContain("LEDGER_ASSET_KIND_CONFLICT");
  });

  it("refuses an outcome token posted under a second market", () => {
    let ledger = Ledger.empty("PAPER");
    ledger = appended(
      ledger,
      transaction({
        ledgerTransactionId: tx(1),
        entries: [
          token("ACTUAL_ACCOUNT", ACCOUNT, "5"),
          token("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
          token("UNATTRIBUTED", ACCOUNT, "5"),
          token("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-5"),
        ],
      }),
    );
    expect(ledger.assetMarketOf(YES_TOKEN)).toBe(MARKET_A);
    const codes = refusalCodes(
      ledger,
      transaction({
        ledgerTransactionId: tx(2),
        entries: [
          token("ACTUAL_ACCOUNT", ACCOUNT, "1", { marketId: MARKET_B }),
          token("EXTERNAL_CLEARING", VENUE_CLEARING, "-1", { marketId: MARKET_B }),
          token("UNATTRIBUTED", ACCOUNT, "1", { marketId: MARKET_B }),
          token("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-1", { marketId: MARKET_B }),
        ],
      }),
    );
    expect(codes).toContain("LEDGER_ASSET_MARKET_CONFLICT");
  });
});

describe("compensating reversals (ADR-006 §5.2)", () => {
  const original = transaction({
    ledgerTransactionId: tx(1),
    eventType: "TRADE_PRINCIPAL",
    entries: [
      collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10"),
      collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "10"),
      collateral("UNATTRIBUTED", ACCOUNT, "-10"),
      collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "10"),
    ],
  });
  const exactReversal = transaction({
    ledgerTransactionId: tx(2),
    eventType: "RECONCILIATION_CORRECTION",
    reversesLedgerTransactionId: tx(1),
    entries: [
      collateral("ACTUAL_ACCOUNT", ACCOUNT, "10"),
      collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-10"),
      collateral("UNATTRIBUTED", ACCOUNT, "10"),
      collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-10"),
    ],
  });

  it("accepts an exact leg-for-leg negation", () => {
    const ledger = appended(appended(Ledger.empty("PAPER"), original), exactReversal);
    expect(ledger.length).toBe(2);
  });

  it("refuses a reversal of a transaction this ledger never saw", () => {
    expect(refusalCodes(Ledger.empty("PAPER"), exactReversal)).toContain(
      "LEDGER_REVERSED_TRANSACTION_UNKNOWN",
    );
  });

  it("refuses a second reversal of the same transaction", () => {
    const ledger = appended(appended(Ledger.empty("PAPER"), original), exactReversal);
    expect(
      refusalCodes(ledger, { ...exactReversal, ledgerTransactionId: tx(3) }),
    ).toContain("LEDGER_ALREADY_REVERSED");
  });

  it("refuses a partial 'reversal' — that is an adjustment, and has its own event type", () => {
    const ledger = appended(Ledger.empty("PAPER"), original);
    const partial = transaction({
      ledgerTransactionId: tx(2),
      reversesLedgerTransactionId: tx(1),
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "6"),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-6"),
        collateral("UNATTRIBUTED", ACCOUNT, "6"),
        collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-6"),
      ],
    });
    expect(refusalCodes(ledger, partial)).toContain("LEDGER_REVERSAL_NOT_COMPENSATING");
  });

  it("refuses a reversal that moves the right amounts in the wrong account", () => {
    const ledger = appended(Ledger.empty("PAPER"), original);
    const wrongAccount = transaction({
      ledgerTransactionId: tx(2),
      reversesLedgerTransactionId: tx(1),
      entries: [
        collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "10"),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-10"),
        collateral("UNATTRIBUTED", OTHER_ACCOUNT, "10"),
        collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-10"),
      ],
    });
    expect(refusalCodes(ledger, wrongAccount)).toContain("LEDGER_REVERSAL_NOT_COMPENSATING");
  });
});

describe("Ledger.rebuild", () => {
  it("replays recorded history through the same validation path", () => {
    let ledger = Ledger.empty("PAPER");
    ledger = appended(ledger, unattributedDeposit(tx(1), "100"));
    ledger = appended(ledger, reattribute(tx(2), "40", "018f3a5c-2222-7000-8000-00000000000a"));

    const recorded = ledger.transactions().map((entry) => entry.transaction);
    const rebuilt = Ledger.rebuild("PAPER", recorded);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) {
      return;
    }
    expect(rebuilt.value.length).toBe(2);
    expect(rebuilt.value.transactions()).toEqual(ledger.transactions());
  });

  it("refuses a tampered history and names the offending index", () => {
    const good = unattributedDeposit(tx(1), "100");
    const tampered: LedgerTransactionInput = {
      ...good,
      entries: [
        { ...good.entries[0]!, amount: "999" },
        ...good.entries.slice(1),
      ],
    };
    const result = Ledger.rebuild("PAPER", [tampered]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.details).toMatchObject({ index: 0 });
    expect(result.refusals.map((refusal) => refusal.code)).toContain("LEDGER_UNBALANCED_ASSET");
  });

  it("refuses history recorded under another environment", () => {
    const result = Ledger.rebuild("BACKTEST", [unattributedDeposit(tx(1), "100")]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals.map((refusal) => refusal.code)).toContain(
      "LEDGER_ENVIRONMENT_MISMATCH",
    );
  });
});
