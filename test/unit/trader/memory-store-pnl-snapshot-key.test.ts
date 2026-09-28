/**
 * `SNAP-1` — `MemoryTraderStore` enforces `accounting.pnl_snapshots`' own
 * identity constraint, so the in-memory doubles can no longer mask
 * `BRACKET1C-SNAPKEY`.
 *
 * `db/migrations/0006_accounting.up.sql`:
 * `constraint pnl_snapshots_scope_unique unique nulls not distinct (scope,
 * environment, account_ref, instance_id, market_id, as_of)`, with `as_of
 * timestamptz`. The double used to push every snapshot; the loop wrote one
 * row PER FILL, and the original paper-e2e golden held two rows of one
 * instance at one instant — rows the database refuses, which the durable
 * trader turned into a GLOBAL halt the doubles never showed.
 *
 * What is pinned here:
 *
 * - a second row of one identity is REFUSED, not recorded, with EXACTLY the
 *   port data the Postgres adapter answers for the database's refusal — held
 *   against the REAL `PostgresTraderStore` driven through a stand-in Kysely
 *   handle that throws the driver's error shape (node-postgres names its
 *   `DatabaseError` `error`). The same comparison against a real PostgreSQL
 *   is in `test/integration/paper-trader/durable-two-level-entry-postgres-redis.test.ts`;
 * - the key is exactly the constraint's six columns: `run_id`,
 *   `denomination_asset` and every economic column are NOT in it;
 * - `nulls not distinct`: two NULL instance / market ids are equal;
 * - `as_of` is compared as `timestamptz` does — one instant, whatever its
 *   zone or trailing zeros, at microsecond resolution;
 * - an injected outage still refuses first, and records nothing.
 */

import { describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import type { PortResult } from "../../../apps/trader/src/ports.js";
import {
  DUPLICATE_PNL_SNAPSHOT_DETAIL,
  MemoryTraderStore,
  PNL_SNAPSHOT_SCOPE_UNIQUE,
} from "../../../apps/trader/src/testing/index.js";
import type { PnlSnapshot } from "../../../packages/pnl/src/index.js";
import type { PolymarketBotDatabase } from "../../../packages/storage-postgres/src/database.js";

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

/** Writes `first` then `second` to a fresh double; answers the second write's result and what was recorded. */
async function twice(
  first: PnlSnapshot,
  second: PnlSnapshot,
): Promise<{ readonly answer: PortResult<null>; readonly recorded: number }> {
  const store = new MemoryTraderStore();
  const initial = await store.writePnlSnapshot(first);
  expect(initial.ok).toBe(true);
  const answer = await store.writePnlSnapshot(second);
  return { answer, recorded: store.pnlSnapshots.length };
}

/**
 * A stand-in Kysely handle for `accounting.pnl_snapshots` only: it inserts
 * rows under the constraint's key and, for a second row of one key, THROWS
 * what node-postgres throws for a unique violation — an `Error` whose `name`
 * is `error` (`pg-protocol`'s `DatabaseError`) and whose message names the
 * constraint. `as_of` is compared as `Date.parse` sees it: this fixture's
 * instants carry no sub-millisecond digits.
 */
function uniqueRejectingDatabase(): PolymarketBotDatabase {
  const keys = new Set<string>();
  const handle = {
    insertInto: (table: string) => ({
      values: (row: Readonly<Record<string, unknown>>) => ({
        execute: async (): Promise<unknown[]> => {
          if (table !== "accounting.pnl_snapshots") throw new Error(`unexpected table ${table}`);
          const asOf = row["as_of"];
          const key = JSON.stringify([
            row["scope"],
            row["environment"],
            row["account_ref"],
            row["instance_id"] ?? null,
            row["market_id"] ?? null,
            typeof asOf === "string" ? Date.parse(asOf) : null,
          ]);
          if (keys.has(key)) {
            const error = new Error(`duplicate key value violates unique constraint "${PNL_SNAPSHOT_SCOPE_UNIQUE}"`);
            error.name = "error";
            throw error;
          }
          keys.add(key);
          return await Promise.resolve([]);
        },
      }),
    }),
    destroy: async () => await Promise.resolve(undefined),
  };
  return handle as unknown as PolymarketBotDatabase;
}

describe("SNAP-1: MemoryTraderStore enforces pnl_snapshots_scope_unique", () => {
  it("refuses a second row of one identity with the adapter's own UNAVAILABLE port data, and records nothing", async () => {
    const { answer, recorded } = await twice(snapshot(), snapshot());
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("the duplicate was accepted");
    // The assertions `durable-pnl-snapshot-postgres.test.ts` makes of the real adapter's answer.
    expect(answer.failure.kind).toBe("UNAVAILABLE");
    expect(answer.failure.detail).toContain("the durable store could not write a PnL snapshot");
    expect(answer.failure.detail).toContain("pnl_snapshots_scope_unique");
    expect(answer.failure.detail).toBe(DUPLICATE_PNL_SNAPSHOT_DETAIL);
    // The database inserts nothing on a violation, and neither does the double.
    expect(recorded).toBe(1);
  });

  it("answers EXACTLY what the real PostgresTraderStore answers for the driver's refusal (same kind, same detail)", async () => {
    const adapter = new PostgresTraderStore({ db: uniqueRejectingDatabase(), decisionContractVersion: 1 });
    expect((await adapter.writePnlSnapshot(snapshot())).ok).toBe(true);
    const fromAdapter = await adapter.writePnlSnapshot(snapshot());
    const { answer: fromDouble } = await twice(snapshot(), snapshot());
    expect(fromAdapter.ok).toBe(false);
    expect(fromDouble).toEqual(fromAdapter);
  });

  it("keys on exactly the six constraint columns: a row differing in any one of them is accepted", async () => {
    for (const other of [
      snapshot({ scope: "ACTUAL_ACCOUNT", instanceId: null }),
      snapshot({ environment: "BACKTEST" }),
      snapshot({ accountRef: "another-account" }),
      snapshot({ instanceId: "018f4a7e-2222-7abc-8def-0000000000ff" }),
      snapshot({ marketId: "018f4a7e-1111-7abc-8def-0000000000ff" }),
      snapshot({ asOf: "2026-05-01T09:00:03Z" }),
    ]) {
      const { answer, recorded } = await twice(snapshot(), other);
      expect({ other, ok: answer.ok, recorded }).toEqual({ other, ok: true, recorded: 2 });
    }
  });

  it("run_id, denomination_asset and the economic columns are NOT in the key: a row differing only there is refused", async () => {
    for (const other of [
      snapshot({ runId: "018f4a7e-3333-7abc-8def-0000000000ff" }),
      snapshot({ runId: null }),
      snapshot({ denominationAsset: "USDC" }),
      snapshot({ realizedPnl: "-1.2", coreNetPnl: "-1.632", capitalCommitted: "0" }),
    ]) {
      const { answer, recorded } = await twice(snapshot(), other);
      expect({ other, ok: answer.ok, recorded }).toEqual({ other, ok: false, recorded: 1 });
    }
  });

  it("nulls NOT distinct: two rows with NULL instance and market ids at one instant are one identity", async () => {
    const accountWide = snapshot({ scope: "ACTUAL_ACCOUNT", instanceId: null, marketId: null, runId: null });
    const { answer, recorded } = await twice(accountWide, { ...accountWide });
    expect(answer.ok).toBe(false);
    expect(recorded).toBe(1);
    // …and a NULL is not equal to a value.
    const scoped = await twice(accountWide, { ...accountWide, marketId: MARKET });
    expect(scoped.answer.ok).toBe(true);
  });

  it("as_of is compared as timestamptz: one instant whatever the zone or trailing zeros, at microsecond resolution", async () => {
    const same: readonly (readonly [string, string])[] = [
      ["2026-05-01T09:00:02Z", "2026-05-01T09:00:02.000Z"],
      ["2026-05-01T09:00:02Z", "2026-05-01T11:00:02+02:00"],
      ["2026-05-01T09:00:02Z", "2026-05-01T04:30:02-04:30"],
      ["2026-09-02T14:00:00.250003Z", "2026-09-02T14:00:00.2500030Z"],
      // Sub-microsecond digits, rounded half-to-even as PostgreSQL 16 did when probed.
      ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.0000005Z"],
      ["2026-01-01T00:00:00.000002Z", "2026-01-01T00:00:00.0000015Z"],
      ["2026-01-01T00:00:00.000002Z", "2026-01-01T00:00:00.0000025Z"],
      ["2026-01-01T00:00:00.000004Z", "2026-01-01T00:00:00.0000035Z"],
      ["2026-01-01T00:00:01Z", "2026-01-01T00:00:00.9999996Z"],
      ["2026-01-01T00:00:00.000003Z", "2026-01-01T00:00:00.00000250001Z"],
    ];
    for (const [first, second] of same) {
      const { answer } = await twice(snapshot({ asOf: first }), snapshot({ asOf: second }));
      expect({ first, second, ok: answer.ok }).toEqual({ first, second, ok: false });
    }
    const distinct: readonly (readonly [string, string])[] = [
      ["2026-09-02T14:00:00.250003Z", "2026-09-02T14:00:00.250004Z"],
      ["2026-05-01T09:00:02Z", "2026-05-01T09:00:02.001Z"],
      ["2026-05-01T09:00:02Z", "2026-05-01T09:00:02+02:00"],
      ["2026-01-01T00:00:00.000001Z", "2026-01-01T00:00:00.0000005Z"],
    ];
    for (const [first, second] of distinct) {
      const { answer } = await twice(snapshot({ asOf: first }), snapshot({ asOf: second }));
      expect({ first, second, ok: answer.ok }).toEqual({ first, second, ok: true });
    }
  });

  it("an injected outage refuses FIRST and records nothing, so the same row is accepted once the store recovers", async () => {
    const store = new MemoryTraderStore();
    store.fail("UNAVAILABLE", "connection reset");
    const down = await store.writePnlSnapshot(snapshot());
    expect(down).toEqual({ ok: false, failure: { kind: "UNAVAILABLE", detail: "connection reset" } });
    store.recover();
    expect((await store.writePnlSnapshot(snapshot())).ok).toBe(true);
    const duplicate = await store.writePnlSnapshot(snapshot());
    expect(duplicate).toEqual({ ok: false, failure: { kind: "UNAVAILABLE", detail: DUPLICATE_PNL_SNAPSHOT_DETAIL } });
    expect(store.pnlSnapshots).toHaveLength(1);
  });
});
