/**
 * THE EXTERNAL-HISTORY BARRIER: no history the SQL layer admits can produce an
 * unattributed actual movement without a halt (review round 2, HIGH-1).
 *
 * The threat model, stated precisely, because the round-1 barrier was correct
 * about the wrong thing. `Ledger.append` refuses a transaction whose actual
 * movement is not attributed in its own `(accountRef, assetId)` bucket, so
 * nothing this package appends can hide an arrival. But the WP-040 tables
 * enforce only the per-asset zero-sum, in a SQL trigger — the attribution
 * partition is not a database constraint. So history written by ANOTHER writer
 * can be perfectly legal to the database and reach `applyTransaction` through a
 * projection rebuild, having never passed the refusal.
 *
 * Round 1 answered that with a classification rule keyed on the UNATTRIBUTED
 * entry's OWN bucket. That rule asks where the writer PUT the attribution, and
 * a writer that put it in the wrong bucket is exactly the writer it is supposed
 * to catch. Four admissible shapes defeated it, all of them recorded below as
 * tests rather than as prose:
 *
 *   1. CROSS-ASSET   — the real movement in pUSD, the attribution in USDC;
 *   2. CROSS-ACCOUNT — the real movement in account A, the attribution in B;
 *   3. NO ENTRY      — a real movement with no UNATTRIBUTED entry anywhere, so
 *                      there was nothing to classify at all;
 *   4. THREE-WAY     — the real movement in A, split attribution in B and C.
 *
 * Each nets to zero per asset, so `accounting.ledger_transactions`' trigger
 * admits every one. The fold now validates the ADR-006 §2 partition itself, on
 * every transaction it sees, and fails CLOSED: an unmatched bucket becomes an
 * `UnexplainedActualMovementRecord` with `haltRequired: true`, and no entry of
 * a transaction whose partition is broken can be reported as a harmless
 * re-attribution.
 *
 * Every fixture here is checked to be SQL-admissible before it is used, so the
 * suite cannot quietly drift into testing shapes the database would reject.
 */

import { describe, expect, it } from "vitest";

import { checkAttributionParity, checkPerAssetBalance } from "./balance.js";
import { Ledger } from "./ledger.js";
import {
  applyTransaction,
  auditAttributionPartition,
  emptyProjection,
  projectLedger,
  serializeProjection,
  unattributedExposure,
} from "./projections.js";
import type { LedgerProjection } from "./projections.js";
import {
  ACCOUNT,
  INSTANCE_A,
  MARKET_A,
  OTHER_ACCOUNT,
  PUSD,
  USDC,
  VENUE_CLEARING,
  YES_TOKEN,
  collateral,
  reattribute,
  transaction,
  tx,
  unattributedDeposit,
} from "./testing/scenarios.js";
import { validateTransactionInput } from "./transaction.js";
import type { LedgerEntryInput, LedgerTransactionInput } from "./transaction.js";

const THIRD_ACCOUNT = "acct-paper-3";

function usdc(
  scope: LedgerEntryInput["scope"],
  accountRef: string,
  amount: string,
  extra: Partial<LedgerEntryInput> = {},
): LedgerEntryInput {
  return { scope, accountRef, assetId: USDC, assetKind: "COLLATERAL", amount, ...extra };
}

/**
 * Folds one transaction the way externally-written history reaches a
 * projection: validated for SHAPE (a database row is well-formed) but never
 * passed through `Ledger.append`'s accounting rules.
 */
function foldExternal(input: LedgerTransactionInput): LedgerProjection {
  const validated = validateTransactionInput(input);
  if (!validated.ok) {
    throw new Error(`fixture is not well-formed: ${JSON.stringify(validated.refusals)}`);
  }
  return applyTransaction(emptyProjection(), { sequence: 0, transaction: validated.value });
}

/** The reviewer's CROSS-ASSET probe: real pUSD in, attribution stated in USDC. */
const CROSS_ASSET: LedgerTransactionInput = transaction({
  ledgerTransactionId: tx(1),
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
    usdc("UNATTRIBUTED", ACCOUNT, "5"),
    usdc("VIRTUAL_STRATEGY", ACCOUNT, "-5", { instanceId: INSTANCE_A }),
  ],
});

/** CROSS-ACCOUNT: real pUSD into A, attribution stated in B. */
const CROSS_ACCOUNT: LedgerTransactionInput = transaction({
  ledgerTransactionId: tx(2),
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
    collateral("UNATTRIBUTED", OTHER_ACCOUNT, "5"),
    collateral("VIRTUAL_STRATEGY", OTHER_ACCOUNT, "-5", { instanceId: INSTANCE_A }),
  ],
});

/** NO ENTRY: the plainest hidden arrival — nothing to classify at all. */
const BARE_ARRIVAL: LedgerTransactionInput = transaction({
  ledgerTransactionId: tx(3),
  eventType: "DEPOSIT_OBSERVED",
  marketId: MARKET_A,
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
  ],
});

/** THREE-WAY: real pUSD into A, attribution split across B and C. */
const THREE_WAY_SPLIT: LedgerTransactionInput = transaction({
  ledgerTransactionId: tx(4),
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
    collateral("UNATTRIBUTED", OTHER_ACCOUNT, "3"),
    collateral("VIRTUAL_STRATEGY", OTHER_ACCOUNT, "-3", { instanceId: INSTANCE_A }),
    collateral("UNATTRIBUTED", THIRD_ACCOUNT, "2"),
    collateral("VIRTUAL_STRATEGY", THIRD_ACCOUNT, "-2", { instanceId: INSTANCE_A }),
  ],
});

/** A token-side variant: the real outcome tokens arrive, the pUSD is "explained". */
const CROSS_ASSET_TOKEN: LedgerTransactionInput = transaction({
  ledgerTransactionId: tx(5),
  eventType: "OUTCOME_TOKEN_RECEIPT",
  marketId: MARKET_A,
  entries: [
    {
      scope: "ACTUAL_ACCOUNT",
      accountRef: ACCOUNT,
      assetId: YES_TOKEN,
      assetKind: "OUTCOME_TOKEN",
      amount: "10",
      marketId: MARKET_A,
    },
    {
      scope: "EXTERNAL_CLEARING",
      accountRef: VENUE_CLEARING,
      assetId: YES_TOKEN,
      assetKind: "OUTCOME_TOKEN",
      amount: "-10",
      marketId: MARKET_A,
    },
    collateral("UNATTRIBUTED", ACCOUNT, "10"),
    collateral("VIRTUAL_STRATEGY", ACCOUNT, "-10", { instanceId: INSTANCE_A }),
  ],
});

const ADMISSIBLE: readonly (readonly [string, LedgerTransactionInput])[] = [
  ["cross-asset", CROSS_ASSET],
  ["cross-account", CROSS_ACCOUNT],
  ["no unattributed entry anywhere", BARE_ARRIVAL],
  ["three-way split", THREE_WAY_SPLIT],
  ["cross-asset, token side", CROSS_ASSET_TOKEN],
];

describe("the preconditions: every shape below is SQL-admissible and append-refused", () => {
  it.each(ADMISSIBLE)("%s balances per asset, so the WP-040 trigger admits it", (_name, input) => {
    // `accounting.ledger_transactions` enforces the per-asset zero-sum and
    // NOTHING about attribution, so this is the whole of the database's check.
    expect(checkPerAssetBalance(input)).toEqual([]);
  });

  it.each(ADMISSIBLE)("%s is REFUSED by Ledger.append", (_name, input) => {
    // The append barrier is intact: these reach a fold only from outside.
    expect(checkAttributionParity(input).length).toBeGreaterThan(0);
    expect(Ledger.empty("PAPER").append(input).ok).toBe(false);
  });
});

describe("folded as external history, every shape raises the §9.15 halt", () => {
  it.each(ADMISSIBLE)("%s records an unexplained actual movement", (_name, input) => {
    const projection = foldExternal(input);
    expect(projection.unexplainedMovements.length).toBeGreaterThan(0);
    for (const movement of projection.unexplainedMovements) {
      expect(movement.haltRequired).toBe(true);
    }
  });

  it.each(ADMISSIBLE)("%s raises haltRequired in the exposure summary", (_name, input) => {
    // `unattributedExposure` is the one surface an operator reads for the halt
    // obligation, so the barrier has to be visible THERE, not only in a field
    // a caller has to know to look at.
    const exposure = unattributedExposure(foldExternal(input));
    expect(exposure.some((line) => line.haltRequired)).toBe(true);
  });

  it.each(ADMISSIBLE)("%s classifies no entry of it as a harmless REATTRIBUTION", (_name, input) => {
    // Fail closed: a transaction whose partition is broken cannot prove that
    // any entry in it is a mere remediation.
    const kinds = foldExternal(input).unattributedActivity.map((r) => r.activityKind);
    expect(kinds).not.toContain("REATTRIBUTION");
  });
});

describe("the movement is named exactly, per (account, asset)", () => {
  it("cross-asset: names the pUSD bucket, its account, and the exact 5 nobody claimed", () => {
    const projection = foldExternal(CROSS_ASSET);
    expect(projection.unexplainedMovements).toEqual([
      {
        ledgerTransactionId: tx(1),
        sequence: 0,
        accountRef: ACCOUNT,
        assetId: PUSD,
        actualDelta: "5",
        attributedDelta: "0",
        unexplained: "5",
        affectedMarketId: null,
        haltRequired: true,
      },
    ]);
    // The USDC entry — which round 1 reported as a harmless remediation — is
    // now an arrival, because its transaction's partition does not hold.
    expect(projection.unattributedActivity[0]).toMatchObject({
      assetId: USDC,
      activityKind: "ACTUAL_ARRIVAL",
      haltRequired: true,
    });
  });

  it("cross-asset: the exposure names BOTH buckets, and only one of them nets", () => {
    // Sorted by account then asset: "USDC" precedes "pUSD" (code-unit order).
    expect(unattributedExposure(foldExternal(CROSS_ASSET))).toEqual([
      {
        accountRef: ACCOUNT,
        assetId: USDC,
        // The attribution the writer DID state, in the wrong bucket.
        net: "5",
        unexplainedActualMovement: "0",
        affectedMarketIds: [],
        haltTriggerCount: 1,
        haltRequired: true,
      },
      {
        accountRef: ACCOUNT,
        assetId: PUSD,
        // No UNATTRIBUTED entry was written here, so the recorded net is zero
        // and the unexplained movement is 5. Kept apart on purpose: `net`
        // still equals the bucket's UNATTRIBUTED balance line.
        net: "0",
        unexplainedActualMovement: "5",
        affectedMarketIds: [],
        haltTriggerCount: 1,
        haltRequired: true,
      },
    ]);
  });

  it("cross-account: names account A, not the account the attribution sat in", () => {
    const projection = foldExternal(CROSS_ACCOUNT);
    expect(projection.unexplainedMovements).toHaveLength(1);
    expect(projection.unexplainedMovements[0]).toMatchObject({
      accountRef: ACCOUNT,
      assetId: PUSD,
      unexplained: "5",
    });
  });

  it("no unattributed entry anywhere: the arrival is still named, with its market", () => {
    // The case a classification rule structurally cannot see: there is no
    // UNATTRIBUTED entry to classify. Round 1 folded this into a projection
    // that said nothing at all.
    const projection = foldExternal(BARE_ARRIVAL);
    expect(projection.unattributedActivity).toEqual([]);
    expect(projection.unexplainedMovements).toEqual([
      {
        ledgerTransactionId: tx(3),
        sequence: 0,
        accountRef: ACCOUNT,
        assetId: PUSD,
        actualDelta: "5",
        attributedDelta: "0",
        unexplained: "5",
        affectedMarketId: MARKET_A,
        haltRequired: true,
      },
    ]);
    // §9.15: "the affected market is halted" — the halt has a target.
    expect(unattributedExposure(projection)[0]?.affectedMarketIds).toEqual([MARKET_A]);
  });

  it("three-way split: one breach in A, and both remediation entries fail closed", () => {
    const projection = foldExternal(THREE_WAY_SPLIT);
    expect(
      projection.unexplainedMovements.map((m) => [m.accountRef, m.unexplained]),
    ).toEqual([[ACCOUNT, "5"]]);
    expect(projection.unattributedActivity.map((r) => r.activityKind)).toEqual([
      "ACTUAL_ARRIVAL",
      "ACTUAL_ARRIVAL",
    ]);
    expect(
      unattributedExposure(projection).map((line) => [line.accountRef, line.haltRequired]),
    ).toEqual([
      [ACCOUNT, true],
      [OTHER_ACCOUNT, true],
      [THIRD_ACCOUNT, true],
    ]);
  });

  it("attribution that OVERSHOOTS the real movement is a breach too", () => {
    // 5 arrived; 7 was attributed. Balances per asset, partition broken by 2.
    const overshoot = transaction({
      ledgerTransactionId: tx(6),
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
        collateral("VIRTUAL_STRATEGY", ACCOUNT, "7", { instanceId: INSTANCE_A }),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-7"),
      ],
    });
    expect(checkPerAssetBalance(overshoot)).toEqual([]);
    expect(foldExternal(overshoot).unexplainedMovements[0]).toMatchObject({
      accountRef: ACCOUNT,
      actualDelta: "5",
      attributedDelta: "7",
      unexplained: "-2",
    });
  });
});

describe("what the barrier must NOT break", () => {
  it("a ledger-derived projection never records an unexplained movement", () => {
    // Append enforces the partition per transaction, so the fold's own check is
    // vacuous for anything this package produced — which is the point: it costs
    // the honest path nothing.
    const seeded = Ledger.empty("PAPER").append(unattributedDeposit(tx(1), "100"));
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }
    const next = seeded.value.ledger.append(reattribute(tx(2), "40", INSTANCE_A));
    expect(next.ok).toBe(true);
    if (!next.ok) {
      return;
    }
    const projection = projectLedger(next.value.ledger);
    expect(projection.unexplainedMovements).toEqual([]);
    expect(auditAttributionPartition(projection)).toEqual([]);
    // And the honest re-attribution is still a re-attribution.
    expect(projection.unattributedActivity[1]).toMatchObject({
      activityKind: "REATTRIBUTION",
      haltRequired: false,
    });
    expect(unattributedExposure(projection)[0]?.unexplainedActualMovement).toBe("0");
  });

  it("a re-attribution in a transaction whose partition HOLDS stays harmless", () => {
    // Two buckets in one transaction: a fully attributed real payment out of
    // pUSD, and a token-side remediation. Nothing is unexplained, so nothing
    // fails closed.
    const mixed = transaction({
      ledgerTransactionId: tx(7),
      entries: [
        collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "5"),
        collateral("VIRTUAL_STRATEGY", ACCOUNT, "-5", { instanceId: INSTANCE_A }),
        collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "5"),
        {
          scope: "UNATTRIBUTED",
          accountRef: ACCOUNT,
          assetId: YES_TOKEN,
          assetKind: "OUTCOME_TOKEN",
          amount: "-3",
        },
        {
          scope: "VIRTUAL_STRATEGY",
          accountRef: ACCOUNT,
          assetId: YES_TOKEN,
          assetKind: "OUTCOME_TOKEN",
          amount: "3",
          instanceId: INSTANCE_A,
        },
      ],
    });
    const appended = Ledger.empty("PAPER").append(mixed);
    expect(appended.ok).toBe(true);
    const projection = foldExternal(mixed);
    expect(projection.unexplainedMovements).toEqual([]);
    expect(projection.unattributedActivity[0]).toMatchObject({
      activityKind: "REATTRIBUTION",
      haltRequired: false,
    });
  });
});

describe("the byte oracle covers the new evidence", () => {
  it("a projection that recorded a breach does not serialize like one that did not", () => {
    // If the oracle omitted `unexplainedMovements`, a rebuild that lost the
    // halt would compare byte-equal to one that kept it.
    const breached = foldExternal(CROSS_ACCOUNT);
    const clean = foldExternal(
      transaction({
        ledgerTransactionId: tx(2),
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
          collateral("UNATTRIBUTED", ACCOUNT, "5"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
        ],
      }),
    );
    expect(serializeProjection(breached)).not.toBe(serializeProjection(clean));
    expect(serializeProjection(breached)).toContain("unexplainedMovements");
  });

  it("rebuild equals incremental when external history breaches the partition", () => {
    // The fold stays TOTAL: damaged history still projects, so it can still be
    // seen, and both paths see the same thing.
    const validated = validateTransactionInput(CROSS_ASSET);
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    const appended = { sequence: 0, transaction: validated.value };
    const incremental = applyTransaction(emptyProjection(), appended);
    const rebuilt = applyTransaction(emptyProjection(), appended);
    expect(serializeProjection(rebuilt)).toBe(serializeProjection(incremental));
  });
});
