/**
 * WP-200 acceptance 2, as a multi-component scenario: "Projections rebuild
 * from zero and match incremental state."
 *
 * The colocated suites in `packages/ledger/src` test each module. This one
 * drives the whole path a composition root would: allocate a fill, build its
 * postings, append them, maintain a projection incrementally as they arrive,
 * then persist-and-reload the recorded history and rebuild from zero. The two
 * projections must be byte-identical.
 *
 * The "persist" step is deliberately a JSON round-trip through plain records.
 * This package owns no connection (layer 1), so the storage-shaped hazard it
 * CAN test is the one that does not need a database: whether a projection
 * survives being written out and read back as ordinary data.
 *
 * The suite runs entirely in-process: no socket, no filesystem, no clock.
 *
 * Both packages are imported RELATIVELY through their own `exports` entry
 * modules, because the root test tree declares no dependency on them and the
 * root `package.json` is outside WP-200's allowed paths (the WP-150 precedent
 * in `test/unit/order-book/replay-golden.test.ts`). This is the entry point,
 * not a deep import.
 */

import { describe, expect, it } from "vitest";

import {
  Ledger,
  allocateFill,
  applyTransaction,
  balanceLineKey,
  buildFillPosting,
  emptyProjection,
  projectLedger,
  serializeLedger,
  serializeProjection,
  unattributedExposure,
  virtualPositionKey,
} from "../../../packages/ledger/src/index.js";
import type {
  FillAllocationResult,
  LedgerProjection,
  LedgerTransactionInput,
} from "../../../packages/ledger/src/index.js";

const ACCOUNT = "acct-paper-1";
const VENUE_CLEARING = "clearing-venue";
const ATTRIBUTION_CLEARING = "clearing-attribution";
const FEE_EXPENSE = "expense-platform-fee";
const PUSD = "pUSD";
const YES_TOKEN =
  "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const MARKET_A = "018f3a5c-1111-7000-8000-000000000001";
const INSTANCE_A = "018f3a5c-2222-7000-8000-00000000000a";
const INSTANCE_B = "018f3a5c-2222-7000-8000-00000000000b";
const TIMESTAMP = "2026-09-02T12:00:00.000Z";

const ACCOUNTS = {
  venueClearingRef: VENUE_CLEARING,
  attributionClearingRef: ATTRIBUTION_CLEARING,
  feeExpenseRef: FEE_EXPENSE,
};

function id(prefix: string, n: number): string {
  return `018f3a5c-${prefix}-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

function fill(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fillId: id("5555", n),
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
    ...overrides,
  };
}

function allocate(fillFact: unknown, claims: readonly unknown[]): FillAllocationResult {
  const result = allocateFill(fillFact, claims);
  if (!result.ok) {
    throw new Error(`allocation refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function postingsFor(
  fillFact: unknown,
  claims: readonly unknown[],
  base: number,
): readonly LedgerTransactionInput[] {
  const result = buildFillPosting(allocate(fillFact, claims), ACCOUNTS, {
    principalTransactionId: id("4444", base),
    tokenTransactionId: id("4444", base + 1),
    feeTransactionId: id("4444", base + 2),
  });
  if (!result.ok) {
    throw new Error(`posting refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value.transactions;
}

/**
 * The scenario: three fills through one account and two strategy instances —
 * a clean split buy, a fee-bearing buy, and a partially attributed sell whose
 * remainder is unattributed.
 */
function scenarioTransactions(): readonly LedgerTransactionInput[] {
  return [
    ...postingsFor(
      fill(1),
      [
        { instanceId: INSTANCE_A, shares: "6" },
        { instanceId: INSTANCE_B, shares: "4" },
      ],
      10,
    ),
    ...postingsFor(
      fill(2, { shares: "5", price: "0.45", feeAmount: "0.03", feeScheduleVersionRef: "fees-v1" }),
      [{ instanceId: INSTANCE_A, shares: "5" }],
      20,
    ),
    ...postingsFor(
      fill(3, { side: "SELL", shares: "4", price: "0.5" }),
      [{ instanceId: INSTANCE_B, shares: "3" }],
      30,
    ),
  ];
}

/** Live path: append each transaction and fold it into the projection as it lands. */
function runIncrementally(transactions: readonly LedgerTransactionInput[]): {
  readonly ledger: Ledger;
  readonly projection: LedgerProjection;
} {
  let ledger = Ledger.empty("PAPER");
  let projection = emptyProjection();
  for (const transaction of transactions) {
    const result = ledger.append(transaction);
    if (!result.ok) {
      throw new Error(
        `${transaction.eventType} refused: ${JSON.stringify(result.refusals)}`,
      );
    }
    ledger = result.value.ledger;
    projection = applyTransaction(projection, result.value.appended);
  }
  return { ledger, projection };
}

/** Recovery path: reload recorded history as plain data and rebuild from zero. */
function rebuildFromRecords(records: readonly unknown[]): LedgerProjection {
  const rebuilt = Ledger.rebuild("PAPER", records);
  if (!rebuilt.ok) {
    throw new Error(`rebuild refused: ${JSON.stringify(rebuilt.refusals)}`);
  }
  return projectLedger(rebuilt.value);
}

describe("acceptance 2: a seeded scenario rebuilt from zero", () => {
  const transactions = scenarioTransactions();
  const live = runIncrementally(transactions);
  const recordedJson = JSON.stringify(
    live.ledger.transactions().map((entry) => entry.transaction),
  );

  it("appends every posting the scenario produced", () => {
    expect(live.ledger.length).toBe(transactions.length);
    expect(transactions.length).toBeGreaterThan(5);
  });

  it("matches a from-zero rebuild byte-for-byte", () => {
    const rebuilt = rebuildFromRecords(JSON.parse(recordedJson) as readonly unknown[]);
    expect(serializeProjection(rebuilt)).toBe(serializeProjection(live.projection));
  });

  it("survives a JSON round-trip of recorded history unchanged", () => {
    const reloaded = JSON.parse(recordedJson) as readonly unknown[];
    const rebuiltOnce = rebuildFromRecords(reloaded);
    const rebuiltTwice = rebuildFromRecords(
      JSON.parse(JSON.stringify(reloaded)) as readonly unknown[],
    );
    expect(serializeProjection(rebuiltTwice)).toBe(serializeProjection(rebuiltOnce));
  });

  it("holds the ADR-006 §2 partition end to end", () => {
    const actualTokens = live.projection.balances.get(
      balanceLineKey("ACTUAL_ACCOUNT", ACCOUNT, YES_TOKEN),
    );
    const virtualA = live.projection.virtualPositions.get(
      virtualPositionKey(INSTANCE_A, YES_TOKEN),
    );
    const virtualB = live.projection.virtualPositions.get(
      virtualPositionKey(INSTANCE_B, YES_TOKEN),
    );
    const unattributedTokens = live.projection.balances.get(
      balanceLineKey("UNATTRIBUTED", ACCOUNT, YES_TOKEN),
    );
    // Bought 10 + 5, sold 4 → 11 actual. A: 6 + 5 = 11; B: 4 - 3 = 1;
    // unattributed: -1 (the unclaimed share of the sell). 11 + 1 - 1 = 11.
    expect(actualTokens?.balance).toBe("11");
    expect(virtualA?.balance).toBe("11");
    expect(virtualB?.balance).toBe("1");
    expect(unattributedTokens?.balance).toBe("-1");
  });

  it("surfaces the unattributed remainder with its halt trigger", () => {
    const exposure = unattributedExposure(live.projection).find(
      (line) => line.assetId === YES_TOKEN,
    );
    expect(exposure).toMatchObject({
      net: "-1",
      haltRequired: true,
      affectedMarketIds: [MARKET_A],
    });
  });
});

describe("acceptance 2 mutation probe: one altered historical transaction", () => {
  const live = runIncrementally(scenarioTransactions());
  const recorded = live.ledger.transactions().map((entry) => entry.transaction);
  const baseline = serializeProjection(live.projection);

  /** Deep-copies recorded history so a mutation cannot touch the original. */
  function copyOfHistory(): LedgerTransactionInput[] {
    return JSON.parse(JSON.stringify(recorded)) as LedgerTransactionInput[];
  }

  it("is refused on rebuild when the alteration breaks the per-asset invariant", () => {
    const tampered = copyOfHistory();
    const entries = tampered[1]!.entries as unknown as { amount: string }[];
    entries[0]!.amount = "9999";
    const result = Ledger.rebuild("PAPER", tampered);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals.map((refusal) => refusal.code)).toContain("LEDGER_UNBALANCED_ASSET");
    // The original ledger is untouched: append-only means the tamper had to
    // happen on a copy, and the live projection still says what it said.
    expect(serializeProjection(live.projection)).toBe(baseline);
  });

  it("diverges byte-for-byte when the alteration is internally consistent", () => {
    // Flip the attribution of the first fill: 6/4 becomes 4/6. Every
    // per-asset sum is unchanged and every invariant still holds, so nothing
    // refuses it — the projection bytes are the detector.
    const tampered = copyOfHistory();
    for (const transaction of tampered) {
      for (const entry of transaction.entries as unknown as {
        scope: string;
        instanceId?: string;
        amount: string;
      }[]) {
        if (entry.scope === "VIRTUAL_STRATEGY" && entry.instanceId === INSTANCE_A) {
          if (entry.amount === "6") {
            entry.amount = "4";
          }
        } else if (entry.scope === "VIRTUAL_STRATEGY" && entry.instanceId === INSTANCE_B) {
          if (entry.amount === "4") {
            entry.amount = "6";
          }
        }
      }
    }
    const rebuilt = rebuildFromRecords(tampered);
    expect(serializeProjection(rebuilt)).not.toBe(baseline);
  });

  it("detects a reordering in the LEDGER bytes, which are the record of order", () => {
    // Summing balances is commutative, so two independent transactions in
    // the other order legitimately produce the SAME projection — that is
    // correct behavior for a state projection, not a hole. What must never
    // be order-blind is the append-only record itself, and `serializeLedger`
    // includes each transaction's assigned sequence. This test states both
    // halves so a future change to either is visible.
    const tampered = copyOfHistory();
    const [first, second, ...rest] = tampered;
    const reordered = Ledger.rebuild("PAPER", [second!, first!, ...rest]);
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) {
      return;
    }
    expect(serializeLedger(reordered.value)).not.toBe(serializeLedger(live.ledger));
    expect(serializeProjection(projectLedger(reordered.value))).toBe(baseline);
  });

  it("detects a silently dropped transaction", () => {
    const tampered = copyOfHistory().filter((_, index) => index !== 2);
    const rebuilt = Ledger.rebuild("PAPER", tampered);
    if (rebuilt.ok) {
      expect(serializeProjection(projectLedger(rebuilt.value))).not.toBe(baseline);
    } else {
      expect(rebuilt.refusals.length).toBeGreaterThan(0);
    }
  });
});
