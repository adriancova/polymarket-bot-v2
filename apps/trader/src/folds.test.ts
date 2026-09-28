/**
 * `FOLD-1` — `HeldAccounting` on its own (`folds.ts`), over REAL postings
 * (`postFill` → `packages/ledger`) and REAL PnL records.
 *
 * The loop-level pins are in `loop-folds.test.ts`; these pin the module's own
 * contract: the cadence door, the ledger/view adoption rule, and the PnL
 * stream's RETRY-FROM-FAILURE semantics against the from-zero fold at every
 * step — including the case the scoping could not probe (`PNL-4`): a refusal
 * that is TRANSIENT. The seam for that one case is a pass-through `vi.mock`
 * of `@polymarket-bot/pnl` that refuses ONE apply of ONE record; `foldPnlRecords`
 * folds with the package's module-internal step, so the from-zero model never
 * sees the refusal, which is exactly what a transient refusal would look like
 * to a rebuild run later.
 */

import { Ledger, projectLedger, serializeProjection } from "@polymarket-bot/ledger";
import type * as PnlModule from "@polymarket-bot/pnl";
import {
  foldPnlRecords,
  serializePnlState,
  type PnlRecord,
  type PnlStreamIdentity,
} from "@polymarket-bot/pnl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeterministicIdFactory, postFill, type PostingIdentity } from "./accounting.js";
import {
  EVERY_FILL_ACCOUNTING_CHECKS,
  HeldAccounting,
  PAPER_ACCOUNTING_CHECKS,
  accountingChecksProblem,
} from "./folds.js";

type ApplyPnlRecord = typeof PnlModule.applyPnlRecord;

const hooks = vi.hoisted(() => ({
  applyPnlRecord: undefined as
    | ((original: ApplyPnlRecord, ...args: Parameters<ApplyPnlRecord>) => ReturnType<ApplyPnlRecord>)
    | undefined,
}));

vi.mock("@polymarket-bot/pnl", async (importOriginal) => {
  const original = await importOriginal<typeof PnlModule>();
  return {
    ...original,
    applyPnlRecord(...args: Parameters<ApplyPnlRecord>) {
      const hook = hooks.applyPnlRecord;
      return hook === undefined ? original.applyPnlRecord(...args) : hook(original.applyPnlRecord, ...args);
    },
  };
});

afterEach(() => {
  hooks.applyPnlRecord = undefined;
});

const POSTING: PostingIdentity = {
  environment: "PAPER",
  accountRef: "fold1-unit-account",
  denominationAssetId: "pUSD",
  venueClearingRef: "fold1-unit-venue-clearing",
  attributionClearingRef: "fold1-unit-attribution-clearing",
  feeExpenseRef: "fold1-unit-fee-expense",
};
const MARKET_ID = "018f5c20-1000-7a10-8b00-0000000000e1";
const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-0000000000e2";
const RUN_ID = "018f5c20-3000-7a30-8b00-0000000000e3";
const TOKEN = "9101";

function identity(): PnlStreamIdentity {
  return {
    scope: "VIRTUAL_STRATEGY",
    environment: "PAPER",
    accountRef: POSTING.accountRef,
    instanceId: INSTANCE_ID,
    runId: RUN_ID,
    marketId: MARKET_ID,
  };
}

/** A synthetic taker fill of `shares` at `price` — three ledger transactions, two instance PnL records. */
function fill(ids: DeterministicIdFactory, action: "BUY" | "SELL", shares: string, price: string) {
  return {
    simulatedFillId: ids.next(),
    simulatedOrderId: ids.next(),
    marketId: MARKET_ID,
    tokenId: TOKEN,
    side: "YES" as const,
    action,
    price,
    shares,
    feeAmount: "0.01",
    liquidityRole: "TAKER" as const,
    atEvent: { receivedAt: "2026-05-01T09:00:00.000Z" },
  };
}

/** Posts the fills in order, adopting each through `held`; answers the instance's record stream. */
function post(held: HeldAccounting, ids: DeterministicIdFactory, fills: readonly ReturnType<typeof fill>[]): PnlRecord[] {
  const records: PnlRecord[] = [];
  for (const simulated of fills) {
    const posted = held.fold(
      postFill({
        ledger: held.ledger,
        fill: simulated as never,
        claims: [{ instanceId: INSTANCE_ID, runId: RUN_ID, shares: simulated.shares }],
        identity: POSTING,
        ids,
        tokenAssetId: `token:${TOKEN}`,
      }),
    );
    if (!posted.ok) throw new Error(`posting refused: ${posted.stage} ${posted.code} ${posted.detail}`);
    held.adopt(posted);
    for (const record of posted.pnlRecords as readonly PnlRecord[]) {
      if (record.owner.scope === "VIRTUAL_STRATEGY") records.push(record);
    }
  }
  return records;
}

describe("the cadence door", () => {
  it("admits the two named cadences and refuses what is not a positive safe integer or a boolean", () => {
    expect(PAPER_ACCOUNTING_CHECKS).toEqual({ everyFills: 50, pnl: false });
    expect(EVERY_FILL_ACCOUNTING_CHECKS).toEqual({ everyFills: 1, pnl: true });
    expect(accountingChecksProblem(PAPER_ACCOUNTING_CHECKS)).toBeUndefined();
    expect(accountingChecksProblem(EVERY_FILL_ACCOUNTING_CHECKS)).toBeUndefined();
    expect(accountingChecksProblem({})).toBeUndefined();
    for (const everyFills of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(accountingChecksProblem({ everyFills }), String(everyFills)).toContain("everyFills");
    }
    expect(accountingChecksProblem({ everyFills: "50" as unknown as number })).toContain("everyFills");
    expect(accountingChecksProblem({ pnl: "true" as unknown as boolean })).toContain("pnl");
    expect(() => new HeldAccounting(Ledger.empty("PAPER"), { everyFills: 0 })).toThrow(RangeError);
  });

  it("defaults to the PAPER cadence", () => {
    const health = new HeldAccounting(Ledger.empty("PAPER")).health();
    expect(health).toEqual({
      checkEveryFills: 50,
      pnlCheck: false,
      fillsPosted: 0,
      ledgerChecks: 0,
      pnlChecks: 0,
      fillsAtLastCheck: null,
      ledgerMismatches: 0,
      pnlMismatches: 0,
      pnlRefusals: {},
    });
  });
});

describe("the ledger and its view, moved together", () => {
  it("adopt() answers whether the cadence's check is due; the held view equals the rebuild after every posting", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), { everyFills: 3 });
    const ids = new DeterministicIdFactory("fold-1-unit-cadence");
    const due: boolean[] = [];
    for (let index = 0; index < 7; index += 1) {
      const simulated = fill(ids, index % 2 === 0 ? "BUY" : "SELL", "5", "0.3");
      const posted = held.fold(
        postFill({
          ledger: held.ledger,
          fill: simulated as never,
          claims: [{ instanceId: INSTANCE_ID, runId: RUN_ID, shares: "5" }],
          identity: POSTING,
          ids,
          tokenAssetId: `token:${TOKEN}`,
        }),
      );
      expect(posted.ok).toBe(true);
      if (!posted.ok) return;
      due.push(held.adopt(posted));
      expect(serializeProjection(held.view)).toBe(serializeProjection(projectLedger(held.ledger)));
      expect(held.view.transactionCount).toBe(held.ledger.length);
    }
    expect(due).toEqual([false, false, true, false, false, true, false]);
    expect(held.checkLedger()).toBeUndefined();
    expect(held.health()).toMatchObject({ fillsPosted: 7, ledgerChecks: 1, fillsAtLastCheck: 7, ledgerMismatches: 0 });
  });

  it("a posting that does not extend the held ledger is refused as out of step — the loop never holds a view of a ledger it does not hold", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"));
    const ids = new DeterministicIdFactory("fold-1-unit-branch");
    post(held, ids, [fill(ids, "BUY", "5", "0.3")]);
    // A posting built on ANOTHER ledger (a branch from empty, not the tip).
    const branched = postFill({
      ledger: Ledger.empty("PAPER"),
      fill: fill(ids, "BUY", "5", "0.3") as never,
      claims: [{ instanceId: INSTANCE_ID, runId: RUN_ID, shares: "5" }],
      identity: POSTING,
      ids,
      tokenAssetId: `token:${TOKEN}`,
    });
    const folded = held.fold(branched);
    expect(folded.ok).toBe(false);
    if (folded.ok) return;
    expect(folded.stage).toBe("VIEW_FOLD");
    expect(folded.code).toBe("LEDGER_VIEW_OUT_OF_STEP");
    // Nothing moved.
    expect(held.ledger.length).toBe(3);
    expect(serializeProjection(held.view)).toBe(serializeProjection(projectLedger(held.ledger)));
  });
});

describe("the PnL stream: RETRY FROM THE FAILURE POINT equals the from-zero fold at every step", () => {
  it("a refused record (an oversell) stops the stream at the same record as the from-zero fold, on every later advance; counted ONCE (F3)", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), EVERY_FILL_ACCOUNTING_CHECKS);
    const ids = new DeterministicIdFactory("fold-1-unit-oversell");
    const fills = [
      fill(ids, "BUY", "10", "0.3"),
      fill(ids, "SELL", "5", "0.35"),
      // Sells 10 of the 5 held: `packages/pnl` refuses PNL_OVERSELL.
      fill(ids, "SELL", "10", "0.35"),
      fill(ids, "BUY", "5", "0.3"),
      fill(ids, "SELL", "5", "0.35"),
    ];
    const stream: PnlRecord[] = [];
    const heldAnswers: boolean[] = [];
    const fromZeroAnswers: boolean[] = [];
    for (const simulated of fills) {
      stream.push(...post(held, ids, [simulated]));
      const state = held.advancePnl(INSTANCE_ID, identity, stream);
      heldAnswers.push(state !== undefined);
      const fromZero = foldPnlRecords(identity(), stream);
      fromZeroAnswers.push(fromZero.ok);
      if (state !== undefined && fromZero.ok) {
        expect(serializePnlState(state)).toBe(serializePnlState(fromZero.value));
      }
      expect(held.checkPnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    }
    // The model: a snapshot after fills 1 and 2 only, then never again.
    expect(fromZeroAnswers).toEqual([true, true, false, false, false]);
    expect(heldAnswers).toEqual(fromZeroAnswers);
    expect(held.completePnlState(INSTANCE_ID)).toBeUndefined();
    expect(held.health()).toMatchObject({
      pnlChecks: 5,
      pnlMismatches: 0,
      pnlRefusals: { [INSTANCE_ID]: { PNL_OVERSELL: 1 } },
    });
  });

  it("a TRANSIENT refusal (PNL-4): the stream resumes at the next advance and equals the from-zero fold, which is what retry-from-failure buys over a latch", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), EVERY_FILL_ACCOUNTING_CHECKS);
    const ids = new DeterministicIdFactory("fold-1-unit-transient");
    const stream: PnlRecord[] = [];
    stream.push(...post(held, ids, [fill(ids, "BUY", "10", "0.3")]));
    expect(held.advancePnl(INSTANCE_ID, identity, stream)).toBeDefined();

    stream.push(...post(held, ids, [fill(ids, "SELL", "5", "0.35")]));
    const refusedRecord = stream[2];
    let refusals = 0;
    hooks.applyPnlRecord = (original, state, record, evidence) => {
      if (record === refusedRecord && refusals === 0) {
        refusals += 1;
        return { ok: false, refusals: [{ code: "PNL_INPUT_INVALID", message: "transient", details: {} }] } as never;
      }
      return original(state, record, evidence);
    };
    expect(held.advancePnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    expect(refusals).toBe(1);

    // Next fill: the refused record is RETRIED, succeeds, and the stream
    // equals the from-zero fold of every record — a latch would stay stopped.
    stream.push(...post(held, ids, [fill(ids, "SELL", "5", "0.35")]));
    const state = held.advancePnl(INSTANCE_ID, identity, stream);
    expect(state).toBeDefined();
    const fromZero = foldPnlRecords(identity(), stream);
    expect(fromZero.ok).toBe(true);
    if (state === undefined || !fromZero.ok) return;
    expect(serializePnlState(state)).toBe(serializePnlState(fromZero.value));
    expect(held.checkPnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    expect(held.health().pnlRefusals).toEqual({ [INSTANCE_ID]: { PNL_INPUT_INVALID: 1 } });
  });

  it("an identity packages/pnl refuses THROWS from advancePnl on every call, as foldPnlRecords did from the loop — no stream is stored", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"));
    const ids = new DeterministicIdFactory("fold-1-unit-identity");
    const stream = post(held, ids, [fill(ids, "BUY", "5", "0.3")]);
    // A v4 run id: the trader's door admits any lowercase UUID here; the PnL
    // identity door requires a v7.
    const refused = (): PnlStreamIdentity => ({ ...identity(), runId: "0d8b6a0e-1111-4abc-8def-0123456789ab" });
    expect(() => foldPnlRecords(refused(), stream)).toThrow();
    expect(() => held.advancePnl(INSTANCE_ID, refused, stream)).toThrow();
    expect(() => held.advancePnl(INSTANCE_ID, refused, stream)).toThrow();
    expect(held.pnlStreamIds()).toEqual([]);
  });
});

describe("FOLD1-R1-1: a PnL check answers for the WHOLE record list, never a prefix", () => {
  it("a stream left behind (records adopted, no snapshot since) is CAUGHT UP by the check and compared whole: the held state then folds every record", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), EVERY_FILL_ACCOUNTING_CHECKS);
    const ids = new DeterministicIdFactory("fold-1-unit-behind");
    const stream: PnlRecord[] = [];
    stream.push(...post(held, ids, [fill(ids, "BUY", "10", "0.3")]));
    expect(held.advancePnl(INSTANCE_ID, identity, stream)).toBeDefined();
    // The next fill's records join the list, but its snapshot never runs (a
    // failed store write returns first): the held stream is behind.
    stream.push(...post(held, ids, [fill(ids, "SELL", "5", "0.35")]));
    expect(held.pnlState(INSTANCE_ID)?.recordCount).toBe(2);
    expect(stream).toHaveLength(4);

    expect(held.checkPnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    // Caught up, not certified behind: the held state is the fold of ALL four.
    const fromZero = foldPnlRecords(identity(), stream);
    expect(fromZero.ok).toBe(true);
    const state = held.pnlState(INSTANCE_ID);
    if (state === undefined || !fromZero.ok) throw new Error("no state");
    expect(state.recordCount).toBe(4);
    expect(serializePnlState(state)).toBe(serializePnlState(fromZero.value));
    expect(held.completePnlState(INSTANCE_ID)).toBe(state);
    // The next snapshot's advance has nothing left to fold, and answers the same state.
    expect(held.advancePnl(INSTANCE_ID, identity, stream)).toBe(state);
    expect(held.health()).toMatchObject({ pnlChecks: 1, pnlMismatches: 0, pnlRefusals: {} });
  });

  it("a stream no snapshot has opened yet is opened by the check, from the identity, and compared whole", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), EVERY_FILL_ACCOUNTING_CHECKS);
    const ids = new DeterministicIdFactory("fold-1-unit-unopened");
    const stream = post(held, ids, [fill(ids, "BUY", "10", "0.3"), fill(ids, "SELL", "5", "0.35")]);
    expect(held.pnlStreamIds()).toEqual([]);
    expect(held.checkPnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    expect(held.pnlStreamIds()).toEqual([INSTANCE_ID]);
    expect(held.pnlState(INSTANCE_ID)?.recordCount).toBe(4);
  });

  it("a refusal first met by a check's catch-up is counted ONCE, and the snapshot's retry does not count it again", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), EVERY_FILL_ACCOUNTING_CHECKS);
    const ids = new DeterministicIdFactory("fold-1-unit-check-refusal");
    // Sells 10 of the 5 held: `packages/pnl` refuses PNL_OVERSELL.
    const stream = post(held, ids, [fill(ids, "BUY", "5", "0.3"), fill(ids, "SELL", "10", "0.35")]);
    expect(held.checkPnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    expect(held.advancePnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    expect(held.checkPnl(INSTANCE_ID, identity, stream)).toBeUndefined();
    expect(held.health()).toMatchObject({
      pnlChecks: 2,
      pnlMismatches: 0,
      pnlRefusals: { [INSTANCE_ID]: { PNL_OVERSELL: 1 } },
    });
  });

  it("an identity packages/pnl refuses: the check agrees with the rebuild (neither can open it), stores no stream, and the snapshot still throws", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), EVERY_FILL_ACCOUNTING_CHECKS);
    const ids = new DeterministicIdFactory("fold-1-unit-check-identity");
    const stream = post(held, ids, [fill(ids, "BUY", "5", "0.3")]);
    const refused = (): PnlStreamIdentity => ({ ...identity(), runId: "0d8b6a0e-1111-4abc-8def-0123456789ab" });
    expect(held.checkPnl(INSTANCE_ID, refused, stream)).toBeUndefined();
    expect(held.pnlStreamIds()).toEqual([]);
    expect(() => held.advancePnl(INSTANCE_ID, refused, stream)).toThrow();
    expect(held.health()).toMatchObject({ pnlChecks: 1, pnlMismatches: 0 });
  });

  it("records with no stream and no identity to open one from are NOT checkable: a counted mismatch, never a silent pass", () => {
    const held = new HeldAccounting(Ledger.empty("PAPER"), EVERY_FILL_ACCOUNTING_CHECKS);
    const ids = new DeterministicIdFactory("fold-1-unit-no-identity");
    const stream = post(held, ids, [fill(ids, "BUY", "5", "0.3")]);
    const mismatch = held.checkPnl(INSTANCE_ID, undefined, stream);
    expect(mismatch?.detail).toContain("no registered identity");
    expect(mismatch?.replaced).toBe(false);
    expect(held.health()).toMatchObject({ pnlChecks: 1, pnlMismatches: 1 });
  });
});
