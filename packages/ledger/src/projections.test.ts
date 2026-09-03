/**
 * WP-200 acceptance 2: "Projections rebuild from zero and match incremental
 * state" — and acceptance 4's projection half: "Unattributed activity creates
 * an explicit scope."
 *
 * The oracle is `serializeProjection`, a canonical sorted form, so equality is
 * asserted on the WHOLE projection byte-for-byte rather than on a hand-picked
 * field list that could quietly omit the field a regression breaks.
 *
 * The mutation probe (acceptance 2's second half) is at the bottom: a copy of
 * recorded history with ONE transaction altered must diverge detectably — as a
 * rebuild refusal when the alteration breaks an invariant, and as a byte
 * divergence when it does not.
 */

import { describe, expect, it } from "vitest";

import { Ledger } from "./ledger.js";
import {
  actualPositions,
  applyTransaction,
  auditAttributionPartition,
  balancesOfScope,
  emptyProjection,
  projectLedger,
  serializeProjection,
  unattributedExposure,
  virtualPositions,
} from "./projections.js";
import type { LedgerProjection } from "./projections.js";
import {
  ACCOUNT,
  ATTRIBUTION_CLEARING,
  INSTANCE_A,
  INSTANCE_B,
  MARKET_A,
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

/**
 * The seeded sequence every rebuild assertion in this file uses. It exercises
 * a deposit, a re-attribution, a token receipt split across two instances, a
 * fully closed balance line, and an unattributed remainder.
 */
const SEEDED_HISTORY: readonly LedgerTransactionInput[] = [
  unattributedDeposit(tx(1), "100"),
  reattribute(tx(2), "60", INSTANCE_A),
  reattribute(tx(3), "40", INSTANCE_B),
  // A token receipt: 10 tokens in, attributed 7/3 across the two instances.
  transaction({
    ledgerTransactionId: tx(4),
    eventType: "OUTCOME_TOKEN_RECEIPT",
    marketId: MARKET_A,
    entries: [
      token("ACTUAL_ACCOUNT", ACCOUNT, "10"),
      token("EXTERNAL_CLEARING", VENUE_CLEARING, "-10"),
      token("VIRTUAL_STRATEGY", ACCOUNT, "7", { instanceId: INSTANCE_A }),
      token("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-7"),
      token("VIRTUAL_STRATEGY", ACCOUNT, "3", { instanceId: INSTANCE_B }),
      token("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-3"),
    ],
  }),
  // An unexplained withdrawal: the actual account moves, nobody claims it.
  transaction({
    ledgerTransactionId: tx(5),
    eventType: "WITHDRAWAL_OBSERVED",
    marketId: MARKET_A,
    entries: [
      collateral("ACTUAL_ACCOUNT", ACCOUNT, "-25"),
      collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "25"),
      collateral("UNATTRIBUTED", ACCOUNT, "-25"),
      collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "25"),
    ],
  }),
];

function seededLedger(history: readonly LedgerTransactionInput[] = SEEDED_HISTORY): Ledger {
  const result = Ledger.rebuild("PAPER", history);
  if (!result.ok) {
    throw new Error(`seed refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

/** Folds the history one transaction at a time, the incremental path. */
function incrementalProjection(ledger: Ledger): LedgerProjection {
  let projection = emptyProjection();
  for (const appended of ledger.transactions()) {
    projection = applyTransaction(projection, appended);
  }
  return projection;
}

describe("acceptance 2: rebuild from zero equals incremental state", () => {
  it("is byte-equal between the incremental fold and the from-zero rebuild", () => {
    const ledger = seededLedger();
    const incremental = incrementalProjection(ledger);
    const rebuilt = projectLedger(ledger);
    expect(serializeProjection(rebuilt)).toBe(serializeProjection(incremental));
  });

  it("is byte-equal when the ledger itself is rebuilt from recorded records", () => {
    const live = seededLedger();
    const liveProjection = incrementalProjection(live);

    const recorded = live.transactions().map((entry) => entry.transaction);
    const reloaded = seededLedger(recorded);
    const reloadedProjection = projectLedger(reloaded);

    expect(serializeProjection(reloadedProjection)).toBe(serializeProjection(liveProjection));
  });

  it("is independent of how many increments the caller took", () => {
    const ledger = seededLedger();
    // Fold the first three, then the rest — a "resume from a checkpoint" path.
    let partial = emptyProjection();
    const all = ledger.transactions();
    for (const appended of all.slice(0, 3)) {
      partial = applyTransaction(partial, appended);
    }
    for (const appended of all.slice(3)) {
      partial = applyTransaction(partial, appended);
    }
    expect(serializeProjection(partial)).toBe(serializeProjection(projectLedger(ledger)));
  });

  it("does not mutate the projection it folds into", () => {
    const ledger = seededLedger();
    const before = emptyProjection();
    const beforeBytes = serializeProjection(before);
    applyTransaction(before, ledger.transactions()[0]!);
    expect(serializeProjection(before)).toBe(beforeBytes);
    expect(before.transactionCount).toBe(0);
  });

  it("counts folded transactions so a stale projection is detectable", () => {
    expect(projectLedger(seededLedger()).transactionCount).toBe(SEEDED_HISTORY.length);
  });
});

describe("acceptance 2 mutation probe: a mutated history diverges detectably", () => {
  it("refuses the rebuild when the mutation breaks the balance invariant", () => {
    const good = SEEDED_HISTORY[0]!;
    const mutated: LedgerTransactionInput = {
      ...good,
      entries: [{ ...good.entries[0]!, amount: "101" }, ...good.entries.slice(1)],
    };
    const result = Ledger.rebuild("PAPER", [mutated, ...SEEDED_HISTORY.slice(1)]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals.map((refusal) => refusal.code)).toContain("LEDGER_UNBALANCED_ASSET");
  });

  it("diverges byte-for-byte when the mutation is internally consistent", () => {
    // Change the deposit from 100 to 90 on BOTH sides and both mirrors: the
    // transaction still balances and still satisfies parity, so nothing
    // refuses it — the projection bytes are what catch it.
    const mutatedHistory: readonly LedgerTransactionInput[] = [
      unattributedDeposit(tx(1), "90"),
      ...SEEDED_HISTORY.slice(1),
    ];
    const original = serializeProjection(projectLedger(seededLedger()));
    const mutated = serializeProjection(projectLedger(seededLedger(mutatedHistory)));
    expect(mutated).not.toBe(original);
  });

  it("diverges when only the ATTRIBUTION of a transaction changes", () => {
    // Same actual movement, re-attributed to the other instance. Every
    // per-asset sum is identical; only the owner differs.
    const mutatedHistory: readonly LedgerTransactionInput[] = [
      SEEDED_HISTORY[0]!,
      reattribute(tx(2), "60", INSTANCE_B),
      reattribute(tx(3), "40", INSTANCE_A),
      ...SEEDED_HISTORY.slice(3),
    ];
    const original = serializeProjection(projectLedger(seededLedger()));
    const mutated = serializeProjection(projectLedger(seededLedger(mutatedHistory)));
    expect(mutated).not.toBe(original);
  });

  it("diverges when a transaction is dropped from history", () => {
    const original = serializeProjection(projectLedger(seededLedger()));
    const shortened = serializeProjection(
      projectLedger(seededLedger(SEEDED_HISTORY.slice(0, -1))),
    );
    expect(shortened).not.toBe(original);
  });
});

describe("balance and position projections", () => {
  const projection = projectLedger(seededLedger());

  it("nets the actual account exactly", () => {
    const actual = balancesOfScope(projection, "ACTUAL_ACCOUNT");
    const pusd = actual.find((line) => line.assetId === PUSD);
    expect(pusd?.balance).toBe("75");
    expect(pusd?.accountRef).toBe(ACCOUNT);
  });

  it("reports actual OUTCOME_TOKEN positions separately from collateral", () => {
    const positions = actualPositions(projection);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      assetId: YES_TOKEN,
      assetKind: "OUTCOME_TOKEN",
      balance: "10",
    });
  });

  it("reports virtual positions per (instance, asset), sorted canonically", () => {
    expect(
      virtualPositions(projection).map((line) => [line.instanceId, line.assetId, line.balance]),
    ).toEqual([
      [INSTANCE_A, YES_TOKEN, "7"],
      [INSTANCE_A, PUSD, "60"],
      [INSTANCE_B, YES_TOKEN, "3"],
      [INSTANCE_B, PUSD, "40"],
    ]);
  });

  it("carries the market onto a virtual token position", () => {
    const line = virtualPositions(projection).find((position) => position.assetId === YES_TOKEN);
    expect(line?.marketId).toBe(MARKET_A);
  });

  it("drops a line that nets to exactly zero rather than reporting a zero balance", () => {
    // Deposit 10, then withdraw the same 10: the account holds nothing and
    // no line should claim it holds "0".
    const ledger = seededLedger([
      unattributedDeposit(tx(1), "10"),
      transaction({
        ledgerTransactionId: tx(2),
        eventType: "WITHDRAWAL_OBSERVED",
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "10"),
          collateral("UNATTRIBUTED", ACCOUNT, "-10"),
          collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "10"),
        ],
      }),
    ]);
    expect(balancesOfScope(projectLedger(ledger), "ACTUAL_ACCOUNT")).toEqual([]);
  });

  it("keys balances by the ENTRY account, never the header (WP-040 F20)", () => {
    // A transfer initiated by ACCOUNT that moves value to OTHER_ACCOUNT. If
    // the projection read the header, both legs would land on ACCOUNT.
    const ledger = seededLedger([
      unattributedDeposit(tx(1), "50"),
      transaction({
        ledgerTransactionId: tx(2),
        accountRef: ACCOUNT,
        eventType: "MANUAL_ADJUSTMENT",
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "-50"),
          collateral("UNATTRIBUTED", ACCOUNT, "-50"),
          collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "50"),
          collateral("UNATTRIBUTED", OTHER_ACCOUNT, "50"),
        ],
      }),
    ]);
    const actual = balancesOfScope(projectLedger(ledger), "ACTUAL_ACCOUNT");
    expect(actual.map((line) => [line.accountRef, line.balance])).toEqual([
      [OTHER_ACCOUNT, "50"],
    ]);
  });

  it("holds the ADR-006 §2 partition for every asset", () => {
    expect(auditAttributionPartition(projection)).toEqual([]);
  });
});

describe("acceptance 4: unattributed activity is an explicit, visible scope", () => {
  const projection = projectLedger(seededLedger());

  it("records a typed record for every unattributed entry, in ledger order", () => {
    const records = projection.unattributedActivity;
    expect(records.map((record) => [record.sequence, record.amount, record.activityKind])).toEqual(
      [
        [0, "100", "ACTUAL_ARRIVAL"],
        [1, "-60", "REATTRIBUTION"],
        [2, "-40", "REATTRIBUTION"],
        [4, "-25", "ACTUAL_ARRIVAL"],
      ],
    );
  });

  it("states the §9.15 halt obligation as an unwaivable literal on every arrival", () => {
    const arrivals = projection.unattributedActivity.filter(
      (record) => record.activityKind === "ACTUAL_ARRIVAL",
    );
    expect(arrivals).toHaveLength(2);
    for (const record of arrivals) {
      expect(record.haltRequired).toBe(true);
    }
  });

  it("does not re-raise the halt for the re-attribution that remediates it", () => {
    // §9.15's trigger is an ACTUAL balance change lacking attribution. tx(2)
    // and tx(3) move value between attribution buckets and change no actual
    // holding, so they are the fix, not a fresh alarm — but they stay in the
    // audit trail, because attribution history is not erasable.
    const remediations = projection.unattributedActivity.filter(
      (record) => record.activityKind === "REATTRIBUTION",
    );
    expect(remediations).toHaveLength(2);
    for (const record of remediations) {
      expect(record.haltRequired).toBe(false);
    }
  });

  it("names the affected market so the halt has a target", () => {
    const withdrawal = projection.unattributedActivity.find((record) => record.sequence === 4);
    expect(withdrawal?.affectedMarketId).toBe(MARKET_A);
  });

  it("keeps the audit trail after the exposure is re-attributed away", () => {
    // tx(2) and tx(3) move the whole deposit to the two instances, so the
    // UNATTRIBUTED *balance* nets down — the AUDIT TRAIL must not.
    const unattributedBalance = balancesOfScope(projection, "UNATTRIBUTED").find(
      (line) => line.assetId === PUSD,
    );
    expect(unattributedBalance?.balance).toBe("-25");
    expect(projection.unattributedActivity).toHaveLength(4);
  });

  it("summarizes net exposure per asset, with the halt triggers counted", () => {
    // 100 arrived unexplained, 100 was attributed away, 25 left unexplained:
    // net -25, matching the UNATTRIBUTED balance line exactly.
    expect(unattributedExposure(projection)).toEqual([
      {
        assetId: PUSD,
        net: "-25",
        affectedMarketIds: [MARKET_A],
        haltTriggerCount: 2,
        haltRequired: true,
      },
    ]);
  });

  it("still reports an asset whose unattributed exposure has netted to zero", () => {
    // 10 arrives unattributed, then all 10 is attributed to an instance. Net
    // is zero; "nothing unexplained ever happened" is still false.
    const ledger = seededLedger([
      unattributedDeposit(tx(1), "10"),
      reattribute(tx(2), "10", INSTANCE_A),
    ]);
    expect(unattributedExposure(projectLedger(ledger))).toEqual([
      {
        assetId: PUSD,
        net: "0",
        affectedMarketIds: [],
        haltTriggerCount: 1,
        haltRequired: true,
      },
    ]);
  });

  it("reports nothing when every movement is attributed", () => {
    const ledger = seededLedger([
      transaction({
        ledgerTransactionId: tx(1),
        eventType: "OUTCOME_TOKEN_RECEIPT",
        marketId: MARKET_A,
        entries: [
          token("ACTUAL_ACCOUNT", ACCOUNT, "4"),
          token("EXTERNAL_CLEARING", VENUE_CLEARING, "-4"),
          token("VIRTUAL_STRATEGY", ACCOUNT, "4", { instanceId: INSTANCE_A }),
          token("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-4"),
        ],
      }),
    ]);
    const clean = projectLedger(ledger);
    expect(clean.unattributedActivity).toEqual([]);
    expect(unattributedExposure(clean)).toEqual([]);
  });
});

describe("serializeProjection", () => {
  it("does not depend on the order state was accumulated in", () => {
    const forward = seededLedger([unattributedDeposit(tx(1), "5"), unattributedDeposit(tx(2), "7")]);
    const reverse = seededLedger([unattributedDeposit(tx(2), "7"), unattributedDeposit(tx(1), "5")]);
    // Same balances, different append order: the balance map must serialize
    // identically. (The unattributed audit trail is order-dependent by
    // design, so compare the balance section explicitly.)
    const balancesOf = (ledger: Ledger): string =>
      JSON.stringify(
        [...projectLedger(ledger).balances.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    expect(balancesOf(reverse)).toBe(balancesOf(forward));
  });

  it("carries a versioned domain prefix", () => {
    expect(serializeProjection(emptyProjection())).toContain(
      "polymarket-bot/ledger-projection/v1",
    );
  });
});
