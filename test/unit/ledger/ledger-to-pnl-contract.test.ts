/**
 * The structural contract between `@polymarket-bot/ledger` and
 * `@polymarket-bot/pnl`, and the end-to-end path a composition root walks:
 *
 *   fill → allocation → ledger postings → projection
 *                    ↘ PnL records      → PnL state → snapshot
 *
 * Why this suite exists at all: the two packages are BOTH layer 1, and
 * `docs/contracts/dependency-direction.md` §2.1 enumerates the permitted
 * same-layer edges exhaustively — none of the listed rows covers
 * ledger → pnl. So `buildFillPosting` cannot import the PnL schemas to
 * guarantee its output parses under them, and the agreement is structural:
 * `PnlTradeRecord`/`PnlFeeRecord` are declared independently in each package.
 *
 * A structural agreement with nothing checking it is a latent break. This is
 * the check. It lives in the root test tree because that is the only place
 * allowed to depend on both packages at once, and if it ever fails, the fix
 * is either to correct the divergent side or to add a §2.1 row with a
 * citation — never to loosen the assertion.
 */

import { describe, expect, it } from "vitest";

import {
  Ledger,
  allocateFill,
  buildFillPosting,
  projectLedger,
} from "../../../packages/ledger/src/index.js";
import type {
  FillAllocationResult,
  FillPosting,
  PnlOwner as LedgerPnlOwner,
} from "../../../packages/ledger/src/index.js";
import {
  PnlRecordSchema,
  computePnlSnapshot,
  emptyPnlState,
  foldPnlRecords,
} from "../../../packages/pnl/src/index.js";
import type { PnlOwner, PnlSnapshot, PnlState } from "../../../packages/pnl/src/index.js";

const ACCOUNT = "acct-paper-1";
const PUSD = "pUSD";
const YES_TOKEN =
  "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const MARKET_A = "018f3a5c-1111-7000-8000-000000000001";
const INSTANCE_A = "018f3a5c-2222-7000-8000-00000000000a";
const INSTANCE_B = "018f3a5c-2222-7000-8000-00000000000b";
const TIMESTAMP = "2026-09-02T12:00:00.000Z";

const ACCOUNTS = {
  venueClearingRef: "clearing-venue",
  attributionClearingRef: "clearing-attribution",
  feeExpenseRef: "expense-platform-fee",
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

function posting(
  fillFact: unknown,
  claims: readonly unknown[],
  base: number,
): FillPosting {
  const result = buildFillPosting(allocate(fillFact, claims), ACCOUNTS, {
    principalTransactionId: id("4444", base),
    tokenTransactionId: id("4444", base + 1),
    feeTransactionId: id("4444", base + 2),
  });
  if (!result.ok) {
    throw new Error(`posting refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

/** Compile-time half of the contract: the two `PnlOwner` shapes are assignable. */
function assertOwnersAgree(ledgerOwner: LedgerPnlOwner): PnlOwner {
  return ledgerOwner;
}

function foldFor(owner: PnlOwner, records: readonly unknown[]): PnlState {
  const result = foldPnlRecords(owner, records);
  if (!result.ok) {
    throw new Error(`fold refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

function snapshotFor(state: PnlState, marks: Record<string, unknown>): readonly PnlSnapshot[] {
  const result = computePnlSnapshot(state, { asOf: TIMESTAMP, marks });
  if (!result.ok) {
    throw new Error(`snapshot refused: ${JSON.stringify(result.refusals)}`);
  }
  return result.value;
}

describe("every record the ledger emits parses under the PnL schemas", () => {
  const cases: readonly (readonly [string, unknown, readonly unknown[]])[] = [
    ["fully attributed buy", fill(1), [{ instanceId: INSTANCE_A, shares: "10" }]],
    [
      "split buy",
      fill(2),
      [
        { instanceId: INSTANCE_A, shares: "6" },
        { instanceId: INSTANCE_B, shares: "4" },
      ],
    ],
    ["partially attributed buy", fill(3), [{ instanceId: INSTANCE_A, shares: "6" }]],
    ["wholly unattributed buy", fill(4), []],
    [
      "buy with a fee",
      fill(5, { feeAmount: "0.07", feeScheduleVersionRef: "fees-2026-09-01" }),
      [{ instanceId: INSTANCE_A, shares: "10" }],
    ],
    [
      "fee split across owners",
      fill(6, { feeAmount: "0.07" }),
      [
        { instanceId: INSTANCE_A, shares: "6", feeAmount: "0.042" },
        { instanceId: INSTANCE_B, shares: "4", feeAmount: "0.028" },
      ],
    ],
  ];

  for (const [name, fillFact, claims] of cases) {
    it(`parses: ${name}`, () => {
      const records = posting(fillFact, claims, 10).pnlRecords;
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        const parsed = PnlRecordSchema.safeParse(record);
        if (!parsed.success) {
          throw new Error(
            `ledger emitted a record the PnL engine rejects: ` +
              `${JSON.stringify(record)} — ${JSON.stringify(parsed.error.issues)}`,
          );
        }
      }
    });
  }

  it("agrees on the owner shape at compile time as well as at runtime", () => {
    expect(assertOwnersAgree({ scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT })).toEqual({
      scope: "ACTUAL_ACCOUNT",
      accountRef: ACCOUNT,
    });
    expect(assertOwnersAgree({ scope: "VIRTUAL_STRATEGY", instanceId: INSTANCE_A })).toEqual({
      scope: "VIRTUAL_STRATEGY",
      instanceId: INSTANCE_A,
    });
    expect(assertOwnersAgree({ scope: "UNATTRIBUTED", accountRef: ACCOUNT })).toEqual({
      scope: "UNATTRIBUTED",
      accountRef: ACCOUNT,
    });
  });

  it("emits every record with an owner the PnL engine can fold", () => {
    const records = posting(fill(1), [{ instanceId: INSTANCE_A, shares: "6" }], 10).pnlRecords;
    for (const record of records) {
      // Each record must be foldable into a state opened for its own owner.
      const state = emptyPnlState(record.owner);
      const result = foldPnlRecords(state.owner, [record]);
      expect(result.ok).toBe(true);
    }
  });
});

describe("end to end: one fill, one ledger, one PnL snapshot", () => {
  const buyPosting = posting(
    fill(1, { feeAmount: "0.06", feeScheduleVersionRef: "fees-2026-09-01" }),
    [
      { instanceId: INSTANCE_A, shares: "6", feeAmount: "0.036" },
      { instanceId: INSTANCE_B, shares: "4", feeAmount: "0.024" },
    ],
    10,
  );
  const sellPosting = posting(
    fill(2, { side: "SELL", shares: "6", price: "0.55" }),
    [{ instanceId: INSTANCE_A, shares: "6" }],
    20,
  );

  function ledgerOf(): Ledger {
    let ledger = Ledger.empty("PAPER");
    for (const transaction of [...buyPosting.transactions, ...sellPosting.transactions]) {
      const result = ledger.append(transaction);
      if (!result.ok) {
        throw new Error(`append refused: ${JSON.stringify(result.refusals)}`);
      }
      ledger = result.value.ledger;
    }
    return ledger;
  }

  const allRecords = [...buyPosting.pnlRecords, ...sellPosting.pnlRecords];
  const recordsFor = (owner: PnlOwner): readonly unknown[] =>
    allRecords.filter((record) => {
      if (record.owner.scope !== owner.scope) {
        return false;
      }
      return owner.scope === "VIRTUAL_STRATEGY"
        ? record.owner.scope === "VIRTUAL_STRATEGY" &&
            record.owner.instanceId === owner.instanceId
        : true;
    });

  it("keeps the ledger and the PnL engine telling the same position story", () => {
    const projection = projectLedger(ledgerOf());
    const virtualA = projection.virtualPositions.get(`${INSTANCE_A}|${YES_TOKEN}`);
    const ownerA: PnlOwner = { scope: "VIRTUAL_STRATEGY", instanceId: INSTANCE_A };
    const pnlA = foldFor(ownerA, recordsFor(ownerA));

    // Instance A bought 6 and sold 6: flat in both views.
    expect(virtualA).toBeUndefined();
    expect(pnlA.lots.has(YES_TOKEN)).toBe(false);

    const virtualB = projection.virtualPositions.get(`${INSTANCE_B}|${YES_TOKEN}`);
    const ownerB: PnlOwner = { scope: "VIRTUAL_STRATEGY", instanceId: INSTANCE_B };
    const pnlB = foldFor(ownerB, recordsFor(ownerB));
    expect(virtualB?.balance).toBe("4");
    expect(pnlB.lots.get(YES_TOKEN)?.shares).toBe("4");
  });

  it("computes instance A's realized PnL and fee from the same fills", () => {
    const ownerA: PnlOwner = { scope: "VIRTUAL_STRATEGY", instanceId: INSTANCE_A };
    const rows = snapshotFor(foldFor(ownerA, recordsFor(ownerA)), {});
    const row = rows.find((entry) => entry.denominationAsset === PUSD);
    // Bought 6 @ 0.4 (basis 2.4), sold 6 @ 0.55 (proceeds 3.3): realized 0.9.
    expect(row?.realizedPnl).toBe("0.9");
    expect(row?.feesPaid).toBe("0.036");
    expect(row?.coreNetPnl).toBe("0.864");
    expect(row?.feesByScheduleVersion).toEqual({
      [JSON.stringify([PUSD, "fees-2026-09-01"])]: "0.036",
    });
  });

  it("values instance B's open position against a caller-supplied mark", () => {
    const ownerB: PnlOwner = { scope: "VIRTUAL_STRATEGY", instanceId: INSTANCE_B };
    const rows = snapshotFor(foldFor(ownerB, recordsFor(ownerB)), {
      [YES_TOKEN]: { midpoint: "0.5" },
    });
    const row = rows.find((entry) => entry.denominationAsset === PUSD);
    // 4 shares, basis 1.6, marked at 0.5 → 2.0 value, 0.4 unrealized.
    expect(row?.realizedPnl).toBe("0");
    expect(row?.unrealizedPnlMidpoint).toBe("0.4");
    expect(row?.capitalCommitted).toBe("1.6");
  });

  it("reconciles the actual-account stream against the ledger's actual position", () => {
    const projection = projectLedger(ledgerOf());
    const actual = projection.balances.get(`ACTUAL_ACCOUNT|${ACCOUNT}|${YES_TOKEN}`);
    const ownerActual: PnlOwner = { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT };
    const pnlActual = foldFor(ownerActual, recordsFor(ownerActual));
    expect(actual?.balance).toBe("4");
    expect(pnlActual.lots.get(YES_TOKEN)?.shares).toBe("4");
  });
});
