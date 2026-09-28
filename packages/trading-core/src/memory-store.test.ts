/**
 * `BACKTEST-2` — the PRODUCTION in-memory `TraderStore` the backtest
 * executable builds the core over.
 *
 * Pinned: every write is recorded in order and published read-only; the
 * `pnl_snapshots_scope_unique` identity is ENFORCED exactly as the SNAP-1 test
 * double enforces it — one shared key function (`pnl-snapshot-key.ts`), the
 * same verdicts, the same kind (`UNAVAILABLE`, the adapter's), nothing
 * recorded on a refusal, a replacement rewritten in place and never inserted;
 * and a closed store refuses every write. The parity block drives the SAME
 * sequence — including the SNAP-1 r2 `as_of` spellings PostgreSQL reads as one
 * instant or as two — through this store and through `testing/`'s
 * `MemoryTraderStore`, and compares every answer and the recorded rows.
 *
 * It is not the test double: it has no failure injection, and nothing in this
 * package's shipped source imports `testing/` (`BACKTEST-2`'s census).
 */

import type { PnlSnapshot } from "@polymarket-bot/pnl";
import type { DecisionRecord, DecisionTelemetry, StrategyStateCheckpoint } from "@polymarket-bot/strategy-runtime";
import type { AppendedLedgerTransaction } from "@polymarket-bot/ledger";
import { describe, expect, it } from "vitest";

import {
  IN_MEMORY_DUPLICATE_PNL_SNAPSHOT_DETAIL,
  IN_MEMORY_MISSING_PNL_SNAPSHOT_DETAIL,
  IN_MEMORY_STORE_CLOSED_DETAIL,
  InMemoryTraderStore,
} from "./memory-store.js";
import { PNL_SNAPSHOT_SCOPE_UNIQUE } from "./pnl-snapshot-key.js";
import type { PortResult, TraderStore } from "./ports.js";
import { MemoryTraderStore } from "./testing/index.js";

const INSTANCE = "018f4a7e-2222-7abc-8def-0123456789ab";
const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";

function snapshot(overrides: Partial<PnlSnapshot> = {}): PnlSnapshot {
  return {
    scope: "VIRTUAL_STRATEGY",
    environment: "PAPER",
    accountRef: "paper-account",
    instanceId: INSTANCE,
    runId: "018f4a7e-3333-7abc-8def-0123456789ab",
    marketId: MARKET,
    denominationAsset: "pUSD",
    asOf: "2026-05-01T09:00:02Z",
    grossTradingPnl: "0.3",
    coreNetPnl: "0.08",
    allInPnl: "0.08",
    realizedPnl: "0",
    unrealizedPnlMidpoint: "0.3",
    unrealizedPnlModel: null,
    unrealizedPnlLiquidation: null,
    worstCaseResolutionPnl: "-17.2",
    feesPaid: "0.22",
    rewardEstimateTotal: "0",
    realizedRewards: "0",
    capitalCommitted: "17.2",
    feesByScheduleVersion: {},
    rewardsByProgram: {},
    estimatesByProgram: {},
    ...overrides,
  };
}

const DECISION = { decisionId: "d-1" } as unknown as DecisionRecord;
const TELEMETRY = { evaluationDurationUs: 1 } as unknown as DecisionTelemetry;
const CHECKPOINT = { checkpointId: "c-1" } as unknown as StrategyStateCheckpoint;
const TRANSACTION = { transactionId: "t-1" } as unknown as AppendedLedgerTransaction;

function verdict(result: PortResult<null>): string {
  return result.ok ? "ok" : `refused:${result.failure.kind}`;
}

describe("InMemoryTraderStore — the production in-memory store", () => {
  it("records every write in order and publishes each list", async () => {
    const store = new InMemoryTraderStore();
    expect(verdict(await store.persistDecision(DECISION, TELEMETRY))).toBe("ok");
    expect(verdict(await store.saveCheckpoint(CHECKPOINT, "2026-05-01T09:00:02Z"))).toBe("ok");
    expect(verdict(await store.appendLedgerTransaction(TRANSACTION))).toBe("ok");
    expect(verdict(await store.writePnlSnapshot(snapshot()))).toBe("ok");
    expect(store.decisions).toEqual([{ record: DECISION, telemetry: TELEMETRY }]);
    expect(store.checkpoints).toEqual([CHECKPOINT]);
    expect(store.checkpointInstants).toEqual(["2026-05-01T09:00:02Z"]);
    expect(store.transactions).toEqual([TRANSACTION]);
    expect(store.pnlSnapshots).toEqual([snapshot()]);
  });

  it(`REFUSES a second row of one ${PNL_SNAPSHOT_SCOPE_UNIQUE} identity (UNAVAILABLE), records nothing, and says so in its own words`, async () => {
    const store = new InMemoryTraderStore();
    await store.writePnlSnapshot(snapshot());
    // One instant, a different spelling, different economics: still ONE identity.
    const answer = await store.writePnlSnapshot(snapshot({ asOf: "2026-05-01T09:00:02.000Z", realizedPnl: "-1" }));
    expect(answer).toEqual({ ok: false, failure: { kind: "UNAVAILABLE", detail: IN_MEMORY_DUPLICATE_PNL_SNAPSHOT_DETAIL } });
    expect(IN_MEMORY_DUPLICATE_PNL_SNAPSHOT_DETAIL).toContain(PNL_SNAPSHOT_SCOPE_UNIQUE);
    expect(store.pnlSnapshots).toEqual([snapshot()]);
  });

  it("REPLACES the one row of an identity in place, and REFUSES — never inserts — a replacement with no row", async () => {
    const store = new InMemoryTraderStore();
    await store.writePnlSnapshot(snapshot({ instanceId: "other-instance" }));
    await store.writePnlSnapshot(snapshot());
    const later = snapshot({ realizedPnl: "-1.2", feesPaid: "0.432" });
    expect(verdict(await store.replacePnlSnapshot(later))).toBe("ok");
    expect(store.pnlSnapshots).toEqual([snapshot({ instanceId: "other-instance" }), later]);
    expect(store.pnlSnapshotReplacements).toBe(1);

    const missing = await store.replacePnlSnapshot(snapshot({ asOf: "2026-05-01T09:14:49Z" }));
    expect(missing).toEqual({ ok: false, failure: { kind: "UNAVAILABLE", detail: IN_MEMORY_MISSING_PNL_SNAPSHOT_DETAIL } });
    expect(store.pnlSnapshots.length).toBe(2);
    expect(store.pnlSnapshotReplacements).toBe(1);
  });

  it("after close, refuses every write and keeps what it recorded", async () => {
    const store = new InMemoryTraderStore();
    await store.writePnlSnapshot(snapshot());
    await store.close();
    expect(store.closed).toBe(true);
    const refused = { ok: false, failure: { kind: "UNAVAILABLE", detail: IN_MEMORY_STORE_CLOSED_DETAIL } };
    expect(await store.persistDecision(DECISION, TELEMETRY)).toEqual(refused);
    expect(await store.saveCheckpoint(CHECKPOINT, "2026-05-01T09:00:02Z")).toEqual(refused);
    expect(await store.appendLedgerTransaction(TRANSACTION)).toEqual(refused);
    expect(await store.writePnlSnapshot(snapshot({ asOf: "2026-05-01T09:14:49Z" }))).toEqual(refused);
    expect(await store.replacePnlSnapshot(snapshot())).toEqual(refused);
    expect(store.decisions).toEqual([]);
    expect(store.pnlSnapshots).toEqual([snapshot()]);
  });

  it("has no failure injection: it is not the test double", () => {
    const store = new InMemoryTraderStore() as unknown as Record<string, unknown>;
    expect(store["fail"]).toBeUndefined();
    expect(store["failOnly"]).toBeUndefined();
    expect(store["recover"]).toBeUndefined();
  });
});

describe("parity with the SNAP-1 double: one key function, the same verdicts, the same rows", () => {
  it("drives one sequence through both stores and compares every answer and the recorded snapshots", async () => {
    // SNAP-1 r2's measured spellings: one instant (zone / trailing zeros /
    // sub-microsecond rounding) shares a key; a year 0099 is not 1999; a
    // string PostgreSQL refuses keys as itself; NULL ids are not distinct.
    const sequence: readonly ["write" | "replace", PnlSnapshot][] = [
      ["write", snapshot()],
      ["write", snapshot({ asOf: "2026-05-01T11:00:02+02:00" })],
      ["write", snapshot({ asOf: "2026-05-01T09:00:02.0000004Z" })],
      ["write", snapshot({ asOf: "0099-05-01T09:00:02Z" })],
      ["write", snapshot({ asOf: "1999-05-01T09:00:02Z" })],
      ["write", snapshot({ asOf: "2026-02-30T09:00:02Z" })],
      ["write", snapshot({ asOf: "2026-02-30T09:00:02Z" })],
      ["write", snapshot({ instanceId: null, marketId: null })],
      ["write", snapshot({ instanceId: null, marketId: null, realizedPnl: "5" })],
      ["write", snapshot({ runId: "018f4a7e-9999-7abc-8def-0123456789ab" })],
      ["replace", snapshot({ asOf: "2026-05-01T09:00:02.000Z", realizedPnl: "-1.2" })],
      ["replace", snapshot({ asOf: "2030-01-01T00:00:00Z" })],
      ["write", snapshot({ scope: "ACCOUNT" as PnlSnapshot["scope"] })],
    ];
    const run = async (store: TraderStore & { readonly pnlSnapshots: readonly PnlSnapshot[] }) => {
      const verdicts: string[] = [];
      for (const [operation, value] of sequence) {
        const result =
          operation === "write" ? await store.writePnlSnapshot(value) : await store.replacePnlSnapshot(value);
        verdicts.push(`${operation}:${verdict(result)}`);
      }
      return { verdicts, rows: [...store.pnlSnapshots] };
    };
    const production = await run(new InMemoryTraderStore());
    const double = await run(new MemoryTraderStore());
    expect(production.verdicts).toEqual(double.verdicts);
    expect(production.rows).toEqual(double.rows);
    // Non-vacuity: the sequence exercised both verdicts of both operations.
    expect(production.verdicts).toEqual([
      "write:ok",
      "write:refused:UNAVAILABLE",
      "write:refused:UNAVAILABLE",
      "write:ok",
      "write:ok",
      "write:ok",
      "write:refused:UNAVAILABLE",
      "write:ok",
      "write:refused:UNAVAILABLE",
      "write:refused:UNAVAILABLE",
      "replace:ok",
      "replace:refused:UNAVAILABLE",
      "write:ok",
    ]);
  });
});
