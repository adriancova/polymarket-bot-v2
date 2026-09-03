/**
 * The settlement-evidence boundary for reward payouts (review round 1,
 * MEDIUM).
 *
 * §9.16's rule has two halves. "Reward estimates are never booked as realized"
 * was airtight — an estimate has no evidence field to state, and
 * `reward-estimate.test.ts` pins that. The other half, ADR-006 §6's "only an
 * observed payout creates a `REWARD_INCOME` entry", was NOT: the engine
 * accepted any canonical UUIDv7 as `ledgerTransactionId` and realized the
 * money. The reviewer's probe minted `018f3a5c-dead-7000-8000-00000000beef`
 * and booked 9999 pUSD of realized rewards.
 *
 * This suite is that probe, permanently. It asserts the forged payout is
 * REFUSED, that the money did not move (byte-for-byte over the realized
 * projection, not over a hand-picked field), and that each half of the
 * evidence — the event type, the environment, the settlement state, the
 * `REWARD_INCOME` amount, the denomination, the owner, the account — is
 * independently load-bearing. Every mismatch below is a payout that would have
 * realized before this boundary existed.
 */

import { describe, expect, it } from "vitest";

import { PnlSettlementEvidence } from "./evidence.js";
import { PnlConfigurationError } from "./refusals.js";
import { serializeRealizedPnl } from "./serialize.js";
import { applyPnlRecord, emptyPnlState, foldPnlRecords } from "./state.js";
import type { PnlState } from "./state.js";
import {
  ACCOUNT,
  ACCOUNT_OWNER,
  ACCOUNT_STREAM,
  INSTANCE_B,
  INSTANCE_OWNER,
  INSTANCE_STREAM,
  PUSD,
  USDC,
  evidenceOf,
  ledgerTx,
  ref,
  rewardPayout,
  rewardPayoutEvidence,
} from "./testing/samples.js";

/** The reviewer's forged id: canonical UUIDv7 shape, booked nowhere. */
const FORGED_LEDGER_TX = "018f3a5c-dead-7000-8000-00000000beef";

function codesOf(state: PnlState, record: unknown, evidence?: PnlSettlementEvidence): readonly string[] {
  const result = applyPnlRecord(state, record, evidence);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

function refusalsOf(
  record: unknown,
  evidence?: PnlSettlementEvidence,
): readonly { readonly code: string; readonly details: Readonly<Record<string, unknown>> }[] {
  const result = applyPnlRecord(emptyPnlState(INSTANCE_STREAM), record, evidence);
  if (result.ok) {
    throw new Error("expected the payout to be refused");
  }
  return result.refusals;
}

describe("an identifier is not an observed payout", () => {
  it("refuses a canonical UUID that names no booking, and moves no money", () => {
    const empty = emptyPnlState(INSTANCE_STREAM);
    const before = serializeRealizedPnl(empty);
    const forged = { ...rewardPayout(1, "9999"), ledgerTransactionId: FORGED_LEDGER_TX };

    const result = applyPnlRecord(empty, forged);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "PNL_REWARD_EVIDENCE_MISSING",
    ]);
    expect(empty.realizedRewards.size).toBe(0);
    expect(serializeRealizedPnl(empty)).toBe(before);
  });

  it("refuses it through the fold path too, naming the record index", () => {
    const result = foldPnlRecords(INSTANCE_STREAM, [
      { ...rewardPayout(1, "9999"), ledgerTransactionId: FORGED_LEDGER_TX },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.details).toMatchObject({ index: 0 });
    expect(result.refusals.map((refusal) => refusal.code)).toContain(
      "PNL_REWARD_EVIDENCE_MISSING",
    );
  });

  it("refuses an id that is not in the evidence it was given", () => {
    const evidence = evidenceOf([rewardPayoutEvidence(1, "5")]);
    expect(
      codesOf(
        emptyPnlState(INSTANCE_STREAM),
        { ...rewardPayout(2, "5"), ledgerTransactionId: FORGED_LEDGER_TX },
        evidence,
      ),
    ).toEqual(["PNL_REWARD_EVIDENCE_UNKNOWN"]);
  });

  it("refuses a hand-made object shaped like evidence", () => {
    const forgery = {
      find: () => rewardPayoutEvidence(1, "5"),
      size: 1,
    } as unknown as PnlSettlementEvidence;
    expect(codesOf(emptyPnlState(INSTANCE_STREAM), rewardPayout(1, "5"), forgery)).toEqual([
      "PNL_REWARD_EVIDENCE_MISSING",
    ]);
  });

  it("cannot be constructed except through from()", () => {
    const Constructible = PnlSettlementEvidence as unknown as new (
      token: symbol,
      transactions: Map<string, unknown>,
    ) => PnlSettlementEvidence;
    expect(() => new Constructible(Symbol("forged"), new Map())).toThrow(PnlConfigurationError);
  });
});

describe("the evidence must book THIS payout", () => {
  it("realizes exactly the claimed amount when it does", () => {
    const result = applyPnlRecord(
      emptyPnlState(INSTANCE_STREAM),
      rewardPayout(1, "5"),
      evidenceOf([rewardPayoutEvidence(1, "5")]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.realizedRewards.get(PUSD)).toBe("5");
  });

  it("refuses a booking of a different amount, naming both figures", () => {
    const refusals = refusalsOf(
      rewardPayout(1, "6"),
      evidenceOf([rewardPayoutEvidence(1, "5")]),
    );
    expect(refusals.map((refusal) => refusal.code)).toEqual([
      "PNL_REWARD_EVIDENCE_MISMATCH",
      "PNL_REWARD_EVIDENCE_MISMATCH",
    ]);
    expect(refusals[0]?.details).toMatchObject({
      claimedAmount: "6",
      rewardIncome: "-5",
      expectedRewardIncome: "-6",
    });
  });

  it("refuses a booking in another denomination (ADR-006 §7: never interchangeable)", () => {
    const refusals = refusalsOf(
      { ...rewardPayout(1, "5"), denominationAsset: USDC },
      evidenceOf([rewardPayoutEvidence(1, "5")]),
    );
    expect(refusals[0]?.code).toBe("PNL_REWARD_EVIDENCE_MISMATCH");
    expect(refusals[0]?.details).toMatchObject({
      denominationAsset: USDC,
      rewardIncome: "0",
    });
  });

  it("refuses a booking that is not a reward posting at all", () => {
    const notAReward = { ...rewardPayoutEvidence(1, "5"), eventType: "TRADE_PRINCIPAL" };
    const refusals = refusalsOf(rewardPayout(1, "5"), evidenceOf([notAReward]));
    expect(refusals[0]?.details).toMatchObject({
      expectedEventType: "LIQUIDITY_REWARD",
      eventType: "TRADE_PRINCIPAL",
    });
  });

  it("refuses a booking whose program does not match the claim", () => {
    const refusals = refusalsOf(
      { ...rewardPayout(1, "5"), programType: "MAKER_REBATE" },
      evidenceOf([rewardPayoutEvidence(1, "5")]),
    );
    expect(refusals[0]?.details).toMatchObject({
      programType: "MAKER_REBATE",
      expectedEventType: "MAKER_REBATE_PAYOUT",
      eventType: "LIQUIDITY_REWARD",
    });
  });

  it("refuses a booking with no REWARD_INCOME leg", () => {
    const noIncome = {
      ...rewardPayoutEvidence(1, "5"),
      entries: (rewardPayoutEvidence(1, "5")["entries"] as readonly Record<string, unknown>[]).map(
        (entry) => (entry["scope"] === "REWARD_INCOME" ? { ...entry, scope: "EXTERNAL_CLEARING" } : entry),
      ),
    };
    const refusals = refusalsOf(rewardPayout(1, "5"), evidenceOf([noIncome]));
    expect(refusals[0]?.code).toBe("PNL_REWARD_EVIDENCE_MISMATCH");
    expect(refusals[0]?.details).toMatchObject({ rewardIncome: "0" });
  });

  it("refuses a booking from another environment (§10.8 separation)", () => {
    const backtest = { ...rewardPayoutEvidence(1, "5"), environment: "BACKTEST" };
    const refusals = refusalsOf(rewardPayout(1, "5"), evidenceOf([backtest]));
    expect(refusals[0]?.details).toMatchObject({
      streamEnvironment: "PAPER",
      evidenceEnvironment: "BACKTEST",
    });
  });

  it("refuses an unsettled or failed booking", () => {
    for (const settlementState of ["MATCHED", "RETRYING", "FAILED"]) {
      const refusals = refusalsOf(
        rewardPayout(1, "5"),
        evidenceOf([{ ...rewardPayoutEvidence(1, "5"), settlementState }]),
      );
      expect(refusals[0]?.details).toMatchObject({ settlementState });
    }
  });

  it("accepts a booking explicitly marked CONFIRMED", () => {
    const result = applyPnlRecord(
      emptyPnlState(INSTANCE_STREAM),
      rewardPayout(1, "5"),
      evidenceOf([{ ...rewardPayoutEvidence(1, "5"), settlementState: "CONFIRMED" }]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("the evidence must credit THIS owner", () => {
  it("refuses another instance's payout", () => {
    const otherInstance = rewardPayoutEvidence(1, "5", {
      scope: "VIRTUAL_STRATEGY",
      accountRef: ACCOUNT,
      instanceId: INSTANCE_B,
    });
    const refusals = refusalsOf(rewardPayout(1, "5"), evidenceOf([otherInstance]));
    expect(refusals[0]?.code).toBe("PNL_REWARD_EVIDENCE_MISMATCH");
    expect(refusals[0]?.details).toMatchObject({ creditedToOwner: "0", claimedAmount: "5" });
  });

  it("refuses the same instance's payout booked in another account", () => {
    const otherAccount = rewardPayoutEvidence(1, "5", {
      scope: "VIRTUAL_STRATEGY",
      accountRef: "acct-paper-2",
      instanceId: INSTANCE_OWNER.scope === "VIRTUAL_STRATEGY" ? INSTANCE_OWNER.instanceId : "",
    });
    const refusals = refusalsOf(rewardPayout(1, "5"), evidenceOf([otherAccount]));
    expect(refusals[0]?.details).toMatchObject({ creditedToOwner: "0" });
  });

  it("refuses a strategy payout claimed by the account-wide stream", () => {
    // The booking credits the instance's bucket, not the account's own
    // unattributed one; an ACTUAL_ACCOUNT stream still sees the actual leg,
    // so this case asserts the opposite direction: an UNATTRIBUTED stream
    // cannot claim it.
    const result = applyPnlRecord(
      emptyPnlState({ ...ACCOUNT_STREAM, scope: "UNATTRIBUTED" }),
      { ...rewardPayout(1, "5"), owner: { scope: "UNATTRIBUTED", accountRef: ACCOUNT } },
      evidenceOf([rewardPayoutEvidence(1, "5")]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_REWARD_EVIDENCE_MISMATCH");
  });

  it("accepts the account-wide stream's own payout", () => {
    const result = applyPnlRecord(
      emptyPnlState(ACCOUNT_STREAM),
      rewardPayout(1, "5", ACCOUNT_OWNER),
      evidenceOf([rewardPayoutEvidence(1, "5", ACCOUNT_OWNER)]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.realizedRewards.get(PUSD)).toBe("5");
  });
});

describe("building an evidence set", () => {
  it("refuses a value that is not a booked transaction", () => {
    const result = PnlSettlementEvidence.from([{ ledgerTransactionId: ledgerTx(1) }]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("PNL_INPUT_INVALID");
  });

  it("refuses two bookings claiming one id", () => {
    const result = PnlSettlementEvidence.from([
      rewardPayoutEvidence(1, "5"),
      rewardPayoutEvidence(1, "7"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.message).toContain("one id is one booking");
  });

  it("refuses a numeric amount inside a booking", () => {
    const booking = rewardPayoutEvidence(1, "5");
    const entries = (booking["entries"] as Record<string, unknown>[]).map((entry, index) =>
      index === 0 ? { ...entry, amount: 5 } : entry,
    );
    expect(PnlSettlementEvidence.from([{ ...booking, entries }]).ok).toBe(false);
  });

  it("holds exactly the bookings it was given", () => {
    const evidence = evidenceOf([rewardPayoutEvidence(1, "5"), rewardPayoutEvidence(2, "7")]);
    expect(evidence.size).toBe(2);
    expect(evidence.find(ledgerTx(1))?.entries).toHaveLength(4);
    expect(evidence.find(ref(1))).toBeUndefined();
  });
});
