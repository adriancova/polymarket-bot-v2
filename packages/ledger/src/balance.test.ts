/**
 * WP-200 acceptance 1: "Every transaction balances per asset."
 *
 * The probe this suite is built around is the one the work package names:
 * an unbalanced append is refused with a typed error naming the asset AND the
 * imbalance, and the zero-sum is verified PER ASSET, never globally. The
 * "never globally" half is the interesting one — a global sum would accept a
 * transaction that is short 5 pUSD and long 5 outcome tokens, which is not
 * accounting, it is a rounding of two different things into one number.
 */

import { describe, expect, it } from "vitest";

import {
  checkAttributionParity,
  checkPerAssetBalance,
  isExactNegation,
  legDeltas,
  netByAsset,
} from "./balance.js";
import { Ledger } from "./ledger.js";
import {
  ACCOUNT,
  ATTRIBUTION_CLEARING,
  INSTANCE_A,
  MARKET_A,
  OTHER_ACCOUNT,
  PUSD,
  USDC,
  VENUE_CLEARING,
  YES_TOKEN,
  collateral,
  token,
  transaction,
  tx,
} from "./testing/scenarios.js";

describe("netByAsset", () => {
  it("nets exactly, per asset, with no float rounding", () => {
    const nets = netByAsset(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "0.1"),
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "0.2"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-0.3"),
          collateral("UNATTRIBUTED", ACCOUNT, "0.3"),
          collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-0.3"),
        ],
      }),
    );
    // 0.1 + 0.2 - 0.3 is exactly 0 here; in IEEE-754 doubles it is not.
    expect(nets.get(PUSD)).toBe("0");
  });

  it("keeps assets separate rather than summing them", () => {
    const nets = netByAsset(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
          token("ACTUAL_ACCOUNT", ACCOUNT, "5"),
        ],
      }),
    );
    expect([...nets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      [YES_TOKEN, "5"],
      [PUSD, "-5"],
    ]);
  });
});

describe("checkPerAssetBalance", () => {
  it("accepts a transaction that nets to zero for every asset", () => {
    expect(
      checkPerAssetBalance(
        transaction({
          entries: [
            collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10"),
            collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "10"),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("names the asset and the exact imbalance", () => {
    const refusals = checkPerAssetBalance(
      transaction({
        ledgerTransactionId: tx(7),
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "9.75"),
        ],
      }),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("LEDGER_UNBALANCED_ASSET");
    expect(refusals[0]?.details).toMatchObject({
      ledgerTransactionId: tx(7),
      assetId: PUSD,
      netImbalance: "-0.25",
    });
    expect(refusals[0]?.message).toContain(PUSD);
    expect(refusals[0]?.message).toContain("-0.25");
  });

  it("PER ASSET, not globally: two imbalances that cancel across assets are two violations", () => {
    // Short 5 pUSD, long 5 outcome tokens. A global sum is exactly zero.
    const refusals = checkPerAssetBalance(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
          token("ACTUAL_ACCOUNT", ACCOUNT, "5"),
        ],
      }),
    );
    expect(refusals).toHaveLength(2);
    const byAsset = new Map(
      refusals.map((refusal) => [refusal.details["assetId"], refusal.details["netImbalance"]]),
    );
    expect(byAsset.get(PUSD)).toBe("-5");
    expect(byAsset.get(YES_TOKEN)).toBe("5");
  });

  it("does not net two different collateral assets together (ADR-006 §7, C-2)", () => {
    const refusals = checkPerAssetBalance(
      transaction({
        entries: [
          { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", amount: "-1" },
          { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: USDC, assetKind: "COLLATERAL", amount: "1" },
        ],
      }),
    );
    expect(refusals).toHaveLength(2);
  });

  it("reports EVERY unbalanced asset, never only the first", () => {
    const refusals = checkPerAssetBalance(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-1"),
          token("ACTUAL_ACCOUNT", ACCOUNT, "1"),
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: ACCOUNT,
            assetId: USDC,
            assetKind: "COLLATERAL",
            amount: "3",
          },
        ],
      }),
    );
    expect(refusals.map((refusal) => refusal.details["assetId"])).toHaveLength(3);
  });
});

describe("Ledger.append (acceptance 1: the invariant is machine-checked on every append)", () => {
  it("refuses an unbalanced append with a typed refusal naming asset and imbalance", () => {
    const result = Ledger.empty("PAPER").append(
      transaction({
        ledgerTransactionId: tx(1),
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "9"),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const unbalanced = result.refusals.filter(
      (refusal) => refusal.code === "LEDGER_UNBALANCED_ASSET",
    );
    expect(unbalanced).toHaveLength(1);
    expect(unbalanced[0]?.details).toMatchObject({ assetId: PUSD, netImbalance: "-1" });
  });

  it("refuses, never adjusts: the ledger stays empty after a refusal", () => {
    const ledger = Ledger.empty("PAPER");
    const result = ledger.append(
      transaction({ entries: [collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10")] }),
    );
    expect(result.ok).toBe(false);
    expect(ledger.length).toBe(0);
    expect(ledger.transactions()).toEqual([]);
  });

  it("accepts the balanced transaction the refusal asked for", () => {
    const result = Ledger.empty("PAPER").append(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "10"),
          collateral("UNATTRIBUTED", ACCOUNT, "-10"),
          collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "10"),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("checkAttributionParity (ADR-006 §2)", () => {
  it("refuses an actual movement with no attribution", () => {
    const refusals = checkAttributionParity(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "10"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-10"),
        ],
      }),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("LEDGER_ATTRIBUTION_PARITY_BROKEN");
    expect(refusals[0]?.details).toMatchObject({
      assetId: PUSD,
      actualDelta: "10",
      attributedDelta: "0",
    });
  });

  it("refuses an attribution no actual movement backs", () => {
    const refusals = checkAttributionParity(
      transaction({
        entries: [
          collateral("VIRTUAL_STRATEGY", ACCOUNT, "10", { instanceId: INSTANCE_A }),
          collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-10"),
        ],
      }),
    );
    expect(refusals[0]?.details).toMatchObject({ actualDelta: "0", attributedDelta: "10" });
  });

  it("accepts a re-attribution that moves no actual value", () => {
    expect(
      checkAttributionParity(
        transaction({
          entries: [
            collateral("UNATTRIBUTED", ACCOUNT, "-10"),
            collateral("VIRTUAL_STRATEGY", ACCOUNT, "10", { instanceId: INSTANCE_A }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("ignores FEE_EXPENSE and REWARD_INCOME scopes, which are not holdings", () => {
    expect(
      checkAttributionParity(
        transaction({
          entries: [
            collateral("FEE_EXPENSE", "expense", "1"),
            collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-1"),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe("legDeltas / isExactNegation (ADR-006 §5.2)", () => {
  it("keys legs by the ENTRY account, so a transfer is two legs (WP-040 F20)", () => {
    const deltas = legDeltas(
      transaction({
        accountRef: ACCOUNT,
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-4"),
          collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "4"),
        ],
      }),
    );
    expect(deltas.size).toBe(2);
    expect(deltas.get(`ACTUAL_ACCOUNT|${ACCOUNT}||${PUSD}`)).toBe("-4");
    expect(deltas.get(`ACTUAL_ACCOUNT|${OTHER_ACCOUNT}||${PUSD}`)).toBe("4");
  });

  it("treats an exact leg-for-leg negation as a compensating reversal", () => {
    const original = legDeltas(
      transaction({
        entries: [
          token("ACTUAL_ACCOUNT", ACCOUNT, "3", { marketId: MARKET_A }),
          token("EXTERNAL_CLEARING", VENUE_CLEARING, "-3", { marketId: MARKET_A }),
        ],
      }),
    );
    const mirror = legDeltas(
      transaction({
        entries: [
          token("ACTUAL_ACCOUNT", ACCOUNT, "-3", { marketId: MARKET_A }),
          token("EXTERNAL_CLEARING", VENUE_CLEARING, "3", { marketId: MARKET_A }),
        ],
      }),
    );
    expect(isExactNegation(original, mirror)).toBe(true);
  });

  it("rejects a near-negation that differs by any amount", () => {
    const original = legDeltas(
      transaction({ entries: [collateral("ACTUAL_ACCOUNT", ACCOUNT, "3")] }),
    );
    const near = legDeltas(
      transaction({ entries: [collateral("ACTUAL_ACCOUNT", ACCOUNT, "-2.999999")] }),
    );
    expect(isExactNegation(original, near)).toBe(false);
  });
});
