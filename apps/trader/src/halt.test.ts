/**
 * The halt controller — §4.2 failure boundaries, §9.9's ladder, and the
 * `WP-200` composition-root obligation.
 *
 * The obligation `WP-200` round 2 left for whoever composed the process:
 *
 * > "A composition-root convention for reading `unexplainedMovements` alongside
 * > `unattributedActivity` when it loads history from the WP-040 tables. The
 * > projection states the obligation; **§9.9 says halting is the composition
 * > root's act**, and no composition root exists yet."
 *
 * `haltOnLedgerProjection` is that act, and this file tests BOTH sections — the
 * "alongside" is the whole point, since reading only one of them was the gap.
 */

import { describe, expect, it } from "vitest";

import { Ledger, projectLedger } from "@polymarket-bot/ledger";

import { HaltController, haltOnLedgerProjection } from "./halt.js";

const AT = "2026-03-04T12:00:00Z";
const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";

describe("HaltController", () => {
  it("latches a halt and keeps the FIRST record for a scope", () => {
    const halts = new HaltController();
    const first = halts.halt({ kind: "GLOBAL" }, "STORE_UNAVAILABLE", "pg down", AT);
    const second = halts.halt({ kind: "GLOBAL" }, "TRANSPORT_UNAVAILABLE", "redis down", AT);
    expect(second).toBe(first);
    expect(halts.globalHalt()?.code).toBe("STORE_UNAVAILABLE");
  });

  it("maps every reason code to a §9.9 ladder action", () => {
    const halts = new HaltController();
    const cases = [
      ["TRANSPORT_UNAVAILABLE", "FULL_HALT"],
      ["TRANSPORT_RESYNC_REQUIRED", "FULL_HALT"],
      ["STORE_UNAVAILABLE", "FULL_HALT"],
      ["QUEUE_BACKPRESSURE", "FULL_HALT"],
      ["UNATTRIBUTED_ACTIVITY", "RECONCILE_ACCOUNT"],
      ["UNEXPLAINED_ACTUAL_MOVEMENT", "RECONCILE_ACCOUNT"],
      ["LEDGER_POSTING_REFUSED", "FULL_HALT"],
      ["CANCEL_UNRESOLVED", "MANAGE_KNOWN_POSITIONS_ONLY"],
      ["BASKET_PARTIALLY_EXECUTED", "MANAGE_KNOWN_POSITIONS_ONLY"],
      ["VENUE_OBSERVATION_FAILED", "RECONCILE_ACCOUNT"],
      ["RUNTIME_PERSISTENCE_FAILED", "FULL_HALT"],
      ["EVENT_UNREADABLE", "FULL_HALT"],
      ["BOOK_DESYNCHRONIZED", "CANCEL_RESTING_ORDERS"],
      ["OPERATOR_HALT", "FULL_HALT"],
    ] as const;
    for (const [code, action] of cases) {
      const record = halts.halt(
        { kind: "STRATEGY_INSTANCE", instanceId: code },
        code,
        "reason",
        AT,
      );
      expect(record.action, code).toBe(action);
    }
  });

  it("a GLOBAL halt halts every market and every instance", () => {
    const halts = new HaltController();
    expect(halts.isMarketHalted(MARKET)).toBe(false);
    halts.halt({ kind: "GLOBAL" }, "STORE_UNAVAILABLE", "pg down", AT);
    expect(halts.isMarketHalted(MARKET)).toBe(true);
    expect(halts.isInstanceHalted("any-instance", MARKET)).toBe(true);
  });

  it("a MARKET halt is scoped to that market", () => {
    const halts = new HaltController();
    halts.halt({ kind: "MARKET", marketId: MARKET }, "BOOK_DESYNCHRONIZED", "gap", AT);
    expect(halts.isMarketHalted(MARKET)).toBe(true);
    expect(halts.isMarketHalted("018f4a7e-9999-7abc-8def-0123456789ab")).toBe(false);
  });

  it("records are emitted in a STABLE order, so a health snapshot is deterministic", () => {
    const halts = new HaltController();
    halts.halt({ kind: "MARKET", marketId: "b" }, "BOOK_DESYNCHRONIZED", "x", AT);
    halts.halt({ kind: "GLOBAL" }, "STORE_UNAVAILABLE", "y", AT);
    halts.halt({ kind: "MARKET", marketId: "a" }, "BOOK_DESYNCHRONIZED", "z", AT);
    expect(halts.records().map((record) => record.scope.kind)).toEqual([
      "GLOBAL",
      "MARKET",
      "MARKET",
    ]);
  });

  it("release DEMANDS the authoritative-snapshot evidence and answers whether it did anything", () => {
    const halts = new HaltController();
    halts.halt({ kind: "GLOBAL" }, "TRANSPORT_RESYNC_REQUIRED", "gap", AT);
    expect(
      halts.release(
        { kind: "GLOBAL" },
        { authoritativeSnapshotApplied: false as unknown as true, reason: "please" },
      ),
    ).toBe(false);
    expect(halts.anyHalt).toBe(true);
    expect(
      halts.release(
        { kind: "GLOBAL" },
        { authoritativeSnapshotApplied: true, reason: "re-snapshotted" },
      ),
    ).toBe(true);
    expect(halts.anyHalt).toBe(false);
    // Releasing a halt that never existed is `false`, so an acknowledgement
    // cannot be mistaken for a recovery.
    expect(
      halts.release(
        { kind: "GLOBAL" },
        { authoritativeSnapshotApplied: true, reason: "again" },
      ),
    ).toBe(false);
  });
});

describe("haltOnLedgerProjection — the WP-200 composition-root obligation", () => {
  it("a clean ledger raises nothing", () => {
    const halts = new HaltController();
    const raised = haltOnLedgerProjection(halts, projectLedger(Ledger.empty("PAPER")), AT);
    expect(raised).toEqual([]);
    expect(halts.anyHalt).toBe(false);
  });

  it("halts on an ACTUAL_ARRIVAL in unattributedActivity, scoped to its market", () => {
    const halts = new HaltController();
    const raised = haltOnLedgerProjection(
      halts,
      {
        transactionCount: 1,
        balances: new Map(),
        virtualPositions: new Map(),
        unattributedActivity: [
          {
            ledgerTransactionId: "018f4a7e-7777-7abc-8def-000000000001",
            sequence: 1,
            assetId: "pUSD",
            assetKind: "COLLATERAL",
            accountRef: "paper-account",
            amount: "5",
            affectedMarketId: MARKET,
            activityKind: "ACTUAL_ARRIVAL",
            haltRequired: true,
          },
        ],
        unexplainedMovements: [],
      },
      AT,
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.code).toBe("UNATTRIBUTED_ACTIVITY");
    expect(halts.isMarketHalted(MARKET)).toBe(true);
  });

  it("does NOT halt on a REATTRIBUTION — a fix may not re-raise the alarm it is fixing", () => {
    const halts = new HaltController();
    const raised = haltOnLedgerProjection(
      halts,
      {
        transactionCount: 1,
        balances: new Map(),
        virtualPositions: new Map(),
        unattributedActivity: [
          {
            ledgerTransactionId: "018f4a7e-7777-7abc-8def-000000000002",
            sequence: 2,
            assetId: "pUSD",
            assetKind: "COLLATERAL",
            accountRef: "paper-account",
            amount: "-5",
            affectedMarketId: MARKET,
            activityKind: "REATTRIBUTION",
            haltRequired: false,
          },
        ],
        unexplainedMovements: [],
      },
      AT,
    );
    expect(raised).toEqual([]);
    expect(halts.anyHalt).toBe(false);
  });

  it("READS BOTH SECTIONS: an unexplained movement halts too — the obligation's own point", () => {
    const halts = new HaltController();
    const raised = haltOnLedgerProjection(
      halts,
      {
        transactionCount: 1,
        balances: new Map(),
        virtualPositions: new Map(),
        // `unattributedActivity` is EMPTY. A root that read only that section —
        // which is what WP-200 recorded as the gap — would see nothing here.
        unattributedActivity: [],
        unexplainedMovements: [
          {
            ledgerTransactionId: "018f4a7e-7777-7abc-8def-000000000003",
            sequence: 3,
            accountRef: "paper-account",
            assetId: "pUSD",
            actualDelta: "5",
            attributedDelta: "0",
            unexplained: "5",
            affectedMarketId: MARKET,
            haltRequired: true,
          },
        ],
      },
      AT,
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.code).toBe("UNEXPLAINED_ACTUAL_MOVEMENT");
    expect(raised[0]?.detail).toContain("WP-200 follow-up 2");
    expect(halts.isMarketHalted(MARKET)).toBe(true);
  });

  it("a finding with NO market halts GLOBALLY rather than nothing", () => {
    const halts = new HaltController();
    haltOnLedgerProjection(
      halts,
      {
        transactionCount: 1,
        balances: new Map(),
        virtualPositions: new Map(),
        unattributedActivity: [],
        unexplainedMovements: [
          {
            ledgerTransactionId: "018f4a7e-7777-7abc-8def-000000000004",
            sequence: 4,
            accountRef: "paper-account",
            assetId: "pUSD",
            actualDelta: "5",
            attributedDelta: "0",
            unexplained: "5",
            affectedMarketId: null,
            haltRequired: true,
          },
        ],
      },
      AT,
    );
    expect(halts.globalHalt()?.code).toBe("UNEXPLAINED_ACTUAL_MOVEMENT");
  });
});
