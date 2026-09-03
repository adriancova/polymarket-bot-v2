/**
 * Two ways a VALID booking still produced invented money (review round 2).
 *
 * Round 1 made a reward realize only against `PnlSettlementEvidence` — the
 * booked ledger transaction itself, checked six ways. Both findings here start
 * AFTER that check passes on a genuine booking, which is what makes them
 * interesting: the boundary was right about the document and wrong about time.
 *
 * HIGH-2 — the check is STATELESS, so it says yes every time it is asked. Two
 * payout records with different `ref`s naming the SAME booked 5 pUSD
 * transaction both folded, and `realizedRewards` became 10. Deduplicating the
 * record's own `ref` says nothing about the money: the money is the booking.
 *
 * HIGH-3 — the check ran on a document that could be rewritten afterwards.
 * `from()` froze the transaction object and left its legs writable, and
 * `find()` handed the internal value out, so a genuine 5 pUSD booking could be
 * edited into a 999 pUSD booking after it was validated.
 *
 * Both are asserted here on GENUINE evidence, and the rebuild-equals-
 * incremental property is asserted alongside the first, because a
 * consumed-evidence set that did not survive a rebuild would re-open it.
 */

import { describe, expect, it } from "vitest";

import { PnlSettlementEvidence } from "./evidence.js";
import { serializePnlState, serializeRealizedPnl } from "./serialize.js";
import { applyPnlRecord, emptyPnlState, foldPnlRecords } from "./state.js";
import type { PnlState } from "./state.js";
import {
  ACCOUNT_OWNER,
  ACCOUNT_STREAM,
  INSTANCE_STREAM,
  PUSD,
  evidenceOf,
  ledgerTx,
  ref,
  rewardPayout,
  rewardPayoutEvidence,
} from "./testing/samples.js";

/** One genuine booking of 5 pUSD, and the payout record that names it. */
const BOOKING = rewardPayoutEvidence(1, "5");
const PAYOUT: Record<string, unknown> = rewardPayout(1, "5");

/** A DIFFERENT record ref naming the SAME booked transaction — the probe. */
const SECOND_CLAIM: Record<string, unknown> = {
  ...rewardPayout(2, "5"),
  ledgerTransactionId: ledgerTx(1),
};

function foldedOnce(): PnlState {
  const result = applyPnlRecord(
    emptyPnlState(INSTANCE_STREAM),
    PAYOUT,
    evidenceOf([BOOKING]),
  );
  if (!result.ok) {
    throw new Error(`the genuine payout was refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

describe("one observed payout is realized exactly once", () => {
  it("the two records really are different records naming one booking", () => {
    // The precondition of the finding, stated so the test cannot drift off it.
    expect(PAYOUT["ref"]).not.toBe(SECOND_CLAIM["ref"]);
    expect(PAYOUT["ledgerTransactionId"]).toBe(SECOND_CLAIM["ledgerTransactionId"]);
    expect(PAYOUT["ledgerTransactionId"]).toBe(ledgerTx(1));
  });

  it("realizes the first one, against the booking", () => {
    expect(foldedOnce().realizedRewards.get(PUSD)).toBe("5");
  });

  it("REFUSES the second, naming the record that already consumed the booking", () => {
    const result = applyPnlRecord(foldedOnce(), SECOND_CLAIM, evidenceOf([BOOKING]));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "PNL_REWARD_EVIDENCE_ALREADY_REALIZED",
    ]);
    expect(result.refusals[0]?.details).toEqual({
      ref: ref(2),
      ledgerTransactionId: ledgerTx(1),
      alreadyRealizedBy: ref(1),
    });
  });

  it("leaves the money exactly where it was after the refusal", () => {
    // Refusal-as-data: a refused record changes nothing at all.
    const state = foldedOnce();
    const before = serializeRealizedPnl(state);
    expect(applyPnlRecord(state, SECOND_CLAIM, evidenceOf([BOOKING])).ok).toBe(false);
    expect(serializeRealizedPnl(state)).toBe(before);
    expect(state.realizedRewards.get(PUSD)).toBe("5");
  });

  it("refuses the whole fold rather than booking 10", () => {
    const folded = foldPnlRecords(
      INSTANCE_STREAM,
      [PAYOUT, SECOND_CLAIM],
      evidenceOf([BOOKING]),
    );
    expect(folded.ok).toBe(false);
    if (folded.ok) {
      return;
    }
    expect(folded.refusals.map((refusal) => refusal.code)).toContain(
      "PNL_REWARD_EVIDENCE_ALREADY_REALIZED",
    );
  });

  it("records WHICH booking was consumed, by which record", () => {
    expect([...foldedOnce().consumedRewardEvidence.entries()]).toEqual([
      [ledgerTx(1), ref(1)],
    ]);
  });

  it("survives a rebuild: the consumed booking is part of the folded state", () => {
    // A consumed set held only in memory would vanish here and let the second
    // claim through on the rebuilt state. The set is derived from the records,
    // so the rebuild reconstructs it exactly.
    const evidence = evidenceOf([BOOKING]);
    const rebuilt = foldPnlRecords(INSTANCE_STREAM, [PAYOUT], evidence);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) {
      return;
    }
    expect(serializePnlState(rebuilt.value)).toBe(serializePnlState(foldedOnce()));
    expect(applyPnlRecord(rebuilt.value, SECOND_CLAIM, evidence).ok).toBe(false);
  });

  it("carries the consumed evidence in the byte oracle", () => {
    // If the oracle omitted it, a rebuild that lost it would compare equal.
    expect(serializeRealizedPnl(foldedOnce())).toContain("consumedRewardEvidence");
    expect(serializeRealizedPnl(foldedOnce())).toContain(ledgerTx(1));
  });

  it("still admits a SECOND, genuinely different booking", () => {
    // The rule is one realization per booking, not one reward per stream.
    const evidence = evidenceOf([BOOKING, rewardPayoutEvidence(3, "7")]);
    const folded = foldPnlRecords(
      INSTANCE_STREAM,
      [PAYOUT, rewardPayout(3, "7")],
      evidence,
    );
    expect(folded.ok).toBe(true);
    if (!folded.ok) {
      return;
    }
    expect(folded.value.realizedRewards.get(PUSD)).toBe("12");
    expect(folded.value.consumedRewardEvidence.size).toBe(2);
  });

  it("does not leak consumption between two streams", () => {
    // Consumption is per stream, because a stream is one row of
    // `accounting.pnl_snapshots`. A booking that credits a different owner is a
    // different owner's realization, and the evidence check is what decides it.
    const accountBooking = rewardPayoutEvidence(4, "3", ACCOUNT_OWNER);
    const other = foldPnlRecords(
      ACCOUNT_STREAM,
      [rewardPayout(4, "3", ACCOUNT_OWNER)],
      evidenceOf([accountBooking]),
    );
    expect(other.ok).toBe(true);
    if (!other.ok) {
      return;
    }
    expect(other.value.realizedRewards.get(PUSD)).toBe("3");
    expect(foldedOnce().consumedRewardEvidence.has(ledgerTx(4))) .toBe(false);
  });
});

describe("validated evidence cannot be rewritten after the fact", () => {
  it("refuses to edit an exposed booking's REWARD_INCOME leg", () => {
    const evidence = evidenceOf([BOOKING]);
    const booked = evidence.find(ledgerTx(1));
    expect(booked).toBeDefined();
    if (booked === undefined) {
      return;
    }
    const legs = booked.entries as unknown as { amount: string }[];
    expect(legs[1]?.amount).toBe("-5");
    expect(() => {
      const leg = legs[1];
      if (leg !== undefined) {
        leg.amount = "-999";
      }
    }).toThrow(TypeError);
    expect(evidence.find(ledgerTx(1))?.entries[1]?.amount).toBe("-5");
  });

  it("refuses to edit the owner's credited leg, the entries array, or the header", () => {
    const evidence = evidenceOf([BOOKING]);
    const booked = evidence.find(ledgerTx(1));
    if (booked === undefined) {
      throw new Error("evidence lost the booking");
    }
    expect(() => {
      const leg = booked.entries[2] as unknown as { amount: string } | undefined;
      if (leg !== undefined) {
        leg.amount = "999";
      }
    }).toThrow(TypeError);
    expect(() => {
      (booked.entries as unknown as unknown[]).push({ forged: true });
    }).toThrow(TypeError);
    expect(() => {
      (booked as unknown as { environment: string }).environment = "LIVE";
    }).toThrow(TypeError);
    expect(() => {
      (booked as unknown as { eventType: string }).eventType = "MANUAL_ADJUSTMENT";
    }).toThrow(TypeError);
  });

  it("hands out a COPY, so even a successful edit could not reach the evidence", () => {
    // Defence in depth: nothing outside the class holds the value the
    // verification reads.
    const evidence = evidenceOf([BOOKING]);
    expect(evidence.find(ledgerTx(1))).not.toBe(evidence.find(ledgerTx(1)));
    expect(evidence.find(ledgerTx(1))).toEqual(evidence.find(ledgerTx(1)));
  });

  it("the 999 payout the reviewer realized is now refused", () => {
    // The whole probe, end to end: build evidence from a genuine 5 pUSD
    // booking, try to edit it into 999, claim 999.
    const evidence = evidenceOf([BOOKING]);
    const booked = evidence.find(ledgerTx(1));
    if (booked === undefined) {
      throw new Error("evidence lost the booking");
    }
    for (const index of [1, 2]) {
      expect(() => {
        const leg = booked.entries[index] as unknown as { amount: string } | undefined;
        if (leg !== undefined) {
          leg.amount = index === 1 ? "-999" : "999";
        }
      }).toThrow(TypeError);
    }
    const inflated: Record<string, unknown> = { ...rewardPayout(1, "999") };
    const result = applyPnlRecord(emptyPnlState(INSTANCE_STREAM), inflated, evidence);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "PNL_REWARD_EVIDENCE_MISMATCH",
      "PNL_REWARD_EVIDENCE_MISMATCH",
    ]);
  });

  it("editing the value HANDED TO from() cannot reach the sealed booking either", () => {
    // The evidence set owns its own copy, so a caller that keeps a reference to
    // the object it supplied cannot change what was validated.
    const supplied = rewardPayoutEvidence(5, "5");
    const evidence = evidenceOf([supplied]);
    const entries = supplied["entries"] as { amount: string }[];
    const leg = entries[1];
    if (leg !== undefined) {
      leg.amount = "-999";
    }
    expect(evidence.find(ledgerTx(5))?.entries[1]?.amount).toBe("-5");
    const result = applyPnlRecord(
      emptyPnlState(INSTANCE_STREAM),
      { ...rewardPayout(5, "999") },
      evidence,
    );
    expect(result.ok).toBe(false);
  });

  it("a forged object shaped like evidence still proves nothing", () => {
    // Unchanged from round 1, re-pinned because the internal accessor moved.
    const forged = Object.create(PnlSettlementEvidence.prototype) as PnlSettlementEvidence;
    const result = applyPnlRecord(emptyPnlState(INSTANCE_STREAM), PAYOUT, forged);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "PNL_REWARD_EVIDENCE_UNKNOWN",
    ]);
  });
});
