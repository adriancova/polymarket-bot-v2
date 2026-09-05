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
  attributionBucketKey,
  attributionBuckets,
  checkAttributionParity,
  checkPerAssetBalance,
  isExactNegation,
  legDeltas,
  legKey,
  netByAsset,
} from "./balance.js";
// The whole public surface, imported as a namespace, so the last test below can
// assert what this package does and does NOT re-export.
import * as index from "./index.js";
import { Ledger } from "./ledger.js";
import { LedgerConfigurationError } from "./refusals.js";
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
    expect(
      deltas.get(
        legKey({ scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: PUSD }),
      ),
    ).toBe("-4");
    expect(
      deltas.get(
        legKey({ scope: "ACTUAL_ACCOUNT", accountRef: OTHER_ACCOUNT, assetId: PUSD }),
      ),
    ).toBe("4");
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

/**
 * THE D1 DOOR ON THIS MODULE'S EIGHT EXPORTS (`WP-200-FU1` review round 1,
 * finding L1).
 *
 * Every function here is re-exported by `src/index.ts`, so every one of them is
 * a caller boundary — and before this round none of them materialized its
 * argument. Each `it` below REPRODUCES the base behaviour through the raw read
 * it used to perform, then asserts what the door does instead, so none of them
 * is a restatement: the negative control is in the same test.
 */
describe("the D1 door on the balance helpers (review round 1, L1)", () => {
  /** Installs one non-enumerable inherited data property and removes it after. */
  function withInherited<T>(property: string, value: unknown, body: () => T): T {
    Object.defineProperty(Object.prototype, property, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    try {
      return body();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[property];
    }
  }

  /** Installs one inherited THROWING getter and removes it after. */
  function withThrowingGetter<T>(property: string, body: () => T): T {
    Object.defineProperty(Object.prototype, property, {
      get: () => {
        throw new Error("hostile getter");
      },
      enumerable: false,
      configurable: true,
    });
    try {
      return body();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[property];
    }
  }

  /** An ORDINARY (prototype-carrying) UNATTRIBUTED leg with no own instanceId. */
  function ordinaryLeg(): {
    readonly scope: string;
    readonly accountRef: string;
    readonly assetId: string;
  } {
    return { scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId: PUSD };
  }

  it("`legKey` no longer ADOPTS an inherited `instanceId` (base: the leg changed identity)", () => {
    const clean = legKey(ordinaryLeg());
    expect(clean).toContain("null");

    // The negative control: the raw read this function used to perform still
    // exhibits the class, so the assertion below measures the DOOR.
    const rawAdopted = withInherited("instanceId", INSTANCE_A, () => {
      const entry = ordinaryLeg() as { instanceId?: string };
      return entry.instanceId;
    });
    expect(rawAdopted).toBe(INSTANCE_A);

    // The door: absence stays absence, so the UNATTRIBUTED leg keeps its identity.
    const polluted = withInherited("instanceId", INSTANCE_A, () => legKey(ordinaryLeg()));
    expect(polluted).toBe(clean);
    expect(polluted).not.toContain(INSTANCE_A);
  });

  it("`legDeltas` keeps EVERY leg's identity under the same pollution", () => {
    const value = transaction({
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
        collateral("UNATTRIBUTED", ACCOUNT, "-5"),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "5"),
        collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "5"),
      ],
    });
    const clean = [...legDeltas(value).keys()].sort();
    const polluted = withInherited("instanceId", INSTANCE_A, () =>
      [...legDeltas(value).keys()].sort(),
    );
    expect(polluted).toEqual(clean);
    expect(polluted.join("")).not.toContain(INSTANCE_A);
  });

  it("a throwing inherited getter at an ABSENT optional no longer runs at all (base: THREW Error)", () => {
    // Base behaviour, reproduced: reading the absent optional off an ORDINARY
    // object runs the inherited getter, and a bare `Error` escapes the helper.
    expect(() =>
      withThrowingGetter("instanceId", () => (ordinaryLeg() as { instanceId?: string }).instanceId),
    ).toThrow(/hostile getter/u);

    // The door: D1 reads OWN descriptors, so the accessor is never reached and
    // the answer is the clean one — not a throw of any kind.
    const clean = legKey(ordinaryLeg());
    expect(withThrowingGetter("instanceId", () => legKey(ordinaryLeg()))).toBe(clean);

    const value = transaction({
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
        collateral("UNATTRIBUTED", ACCOUNT, "-5"),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "5"),
        collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "5"),
      ],
    });
    const cleanKeys = [...legDeltas(value).keys()].sort();
    expect(withThrowingGetter("instanceId", () => [...legDeltas(value).keys()].sort())).toEqual(
      cleanKeys,
    );
    for (const check of [checkPerAssetBalance, checkAttributionParity]) {
      expect(withThrowingGetter("instanceId", () => check(value))).toEqual([]);
    }
  });

  it("an OWN accessor is refused in each signature's own vocabulary, never thrown out raw", () => {
    // The other half of D1: a getter the input OWNS. `readPlainData` refuses an
    // accessor rather than invoking it, so nothing here runs caller code — and
    // each helper says no in the vocabulary its signature already speaks.
    const hostile = (): unknown => {
      const value = transaction({ entries: [collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5")] }) as Record<
        string,
        unknown
      >;
      const copy: Record<string, unknown> = { ...value };
      Object.defineProperty(copy, "entries", {
        get: () => {
          throw new Error("hostile getter");
        },
        enumerable: true,
        configurable: true,
      });
      return copy;
    };
    // Base behaviour, reproduced: the raw read runs it.
    expect(() => (hostile() as { entries: unknown }).entries).toThrow(/hostile getter/u);

    for (const check of [checkPerAssetBalance, checkAttributionParity]) {
      expect(check(hostile() as never).map((refusal) => refusal.code)).toEqual([
        "LEDGER_INPUT_INVALID",
      ]);
    }
    for (const derive of [netByAsset, attributionBuckets, legDeltas]) {
      expect(() => derive(hostile() as never)).toThrow(LedgerConfigurationError);
    }
  });

  it("a Proxy argument is refused by every one of the eight, in its own vocabulary", () => {
    const value = transaction({ entries: [collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5")] });
    const proxied = new Proxy(value, {}) as typeof value;
    for (const check of [checkPerAssetBalance, checkAttributionParity]) {
      expect(check(proxied).map((refusal) => refusal.code)).toEqual(["LEDGER_INPUT_INVALID"]);
    }
    expect(() => netByAsset(proxied)).toThrow(LedgerConfigurationError);
    expect(() => attributionBuckets(proxied)).toThrow(LedgerConfigurationError);
    expect(() => legDeltas(proxied)).toThrow(LedgerConfigurationError);
    expect(() => legKey(new Proxy(ordinaryLeg(), {}))).toThrow(LedgerConfigurationError);
  });

  it("`attributionBucketKey` refuses a value that only RENDERS as a string", () => {
    // Base behaviour, reproduced: `JSON.stringify` calls `toJSON`, so caller code
    // ran inside the key and produced a REAL account's bucket.
    const impostor = { toJSON: () => ACCOUNT };
    expect(JSON.stringify([impostor, PUSD])).toBe(attributionBucketKey(ACCOUNT, PUSD));

    expect(() => attributionBucketKey(impostor as never, PUSD)).toThrow(LedgerConfigurationError);
    expect(() => attributionBucketKey(ACCOUNT, impostor as never)).toThrow(
      LedgerConfigurationError,
    );
    // The honest call is untouched.
    expect(attributionBucketKey(ACCOUNT, PUSD)).toBe(JSON.stringify([ACCOUNT, PUSD]));
  });

  it("`isExactNegation` refuses a Map LOOKALIKE that would report a false reversal", () => {
    const original = legDeltas(
      transaction({ entries: [collateral("ACTUAL_ACCOUNT", ACCOUNT, "3")] }),
    );
    const lookalike = { size: 1, get: () => "-3" } as unknown as ReadonlyMap<string, string>;
    expect(() => isExactNegation(original, lookalike)).toThrow(LedgerConfigurationError);
    expect(() => isExactNegation(lookalike, original)).toThrow(LedgerConfigurationError);

    // A real negation still answers, and a real non-negation still refuses.
    const mirror = legDeltas(
      transaction({ entries: [collateral("ACTUAL_ACCOUNT", ACCOUNT, "-3")] }),
    );
    expect(isExactNegation(original, mirror)).toBe(true);
    expect(isExactNegation(original, original)).toBe(false);
  });

  it("the `…OfValidated` cores are NOT part of the package's public surface", () => {
    // The cores exist for `ledger.ts` and `projections.ts`, which reach these
    // checks with an already-materialized transaction. Re-exporting one would
    // hand a caller the pre-D1 function back under a new name.
    const exported = Object.keys(index).sort();
    expect(exported.filter((name) => name.endsWith("OfValidated"))).toEqual([]);
    // Non-vacuity: the D1 doors ARE exported.
    for (const name of [
      "attributionBucketKey",
      "attributionBuckets",
      "checkAttributionParity",
      "checkPerAssetBalance",
      "isExactNegation",
      "legDeltas",
      "legKey",
      "netByAsset",
    ]) {
      expect(exported).toContain(name);
    }
  });
});
