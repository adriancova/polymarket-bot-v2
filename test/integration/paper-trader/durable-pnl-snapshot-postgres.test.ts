/**
 * `TRDR-2` — the trader's durable PnL-snapshot write, against a REAL
 * PostgreSQL.
 *
 * ## Why this file exists
 *
 * `GOV-2B` blocker **B1**: `PostgresTraderStore.writePnlSnapshot` is the
 * repository's only production writer of `accounting.pnl_snapshots`, and it
 * had **zero** coverage — every other reference to `writePnlSnapshot` is the
 * in-memory double in `apps/trader/src/testing/`. The adapter bound
 * `toPnlSnapshotRow`'s camelCase keys straight into the snake_case table
 * behind `.values(row as never)`, so the emitted SQL was
 *
 * ```
 * insert into "accounting"."pnl_snapshots" ("scope", "environment",
 *   "accountRef", "instanceId", … , "asOf") values ($1, … , $20)
 * ```
 *
 * — eighteen quoted identifiers naming columns that do not exist. PostgreSQL
 * rejects it, `#contained` turns the rejection into `UNAVAILABLE` port data,
 * and `loop.ts:1523-1530` escalates that to a GLOBAL `STORE_UNAVAILABLE` halt
 * after EVERY fill (`loop.ts:1421`). The doubles did not approximate that
 * failure; they hid it. Only a real database can answer whether a column
 * binding is real, so this file uses one.
 *
 * ## WHAT THIS FILE DOES NOT PROVE (`TRDR-2` r1, review finding R1)
 *
 * It proves the COLUMN BINDING. It does **not** prove that the assembled
 * trader survives, and the difference is a live blocker rather than a caveat.
 *
 * `accounting.pnl_snapshots` carries three foreign keys —
 * `instance_id → strategy.instances`, `run_id → strategy.runs`,
 * `market_id → catalog.markets` (`db/migrations/0006_accounting.up.sql`). The
 * rows that satisfy them here are created by `createTradingChain`, a fixture in
 * `@polymarket-bot/storage-postgres/testing`, which seeds
 * `catalog.series` → `catalog.markets` → `strategy.definitions` →
 * `strategy.configs` → `strategy.instances` → `strategy.runs` before the first
 * write below. **Nothing in `apps/trader/src` ever creates those rows**: the
 * app's only production inserts are `strategy.decisions`,
 * `strategy.state_checkpoints` and `accounting.pnl_snapshots`
 * (`apps/trader/src/adapters/postgres-store.ts:176`, `:225`, `:390`), and the
 * three parent tables appear in `apps/trader` only in prose.
 *
 * So against the database `apps/trader/src/main.ts` actually builds — migrated
 * and UNSEEDED — this adapter still answers, as the adversarial review of the
 * first `TRDR-2` round measured with the fixed adapter in place:
 *
 * ```
 * {"ok":false,"failure":{"kind":"UNAVAILABLE","detail":"… violates foreign key
 *   constraint \"pnl_snapshots_instance_id_fkey\""}}
 * ```
 *
 * which `loop.ts:1523-1530` escalates to the same GLOBAL `STORE_UNAVAILABLE`
 * halt B1 produced. It is worse for decisions: `strategy.decisions.run_id` and
 * `.instance_id` are NOT NULL foreign keys and `loop.ts:1645-1656` halts on a
 * failed `persistDecision`, so an assembled durable trader would halt on its
 * FIRST DECISION, before any fill. Fixing the column binding was necessary and
 * is not sufficient; the missing piece is a BOOTSTRAP path that registers the
 * market, the strategy instance and the run, which no round has built and which
 * is carried as a separate closeout blocker. Read this file as: the statement
 * this adapter sends is valid SQL against the real schema, and every value
 * lands in the column it belongs to.
 *
 * ## Docker
 *
 * This is the FIRST file in the paper-trader suite that needs Docker
 * (`@polymarket-bot/storage-postgres/testing` → Testcontainers, the same
 * helpers `test/integration/postgres/**` uses, and the same pinned image).
 * The suite's other files remain in-memory; the container is started in this
 * file's own `beforeAll` rather than in a `globalSetup`, so no other file in
 * the suite acquires a Docker dependency. It does NOT skip when Docker is
 * absent: a silent skip is exactly the shape of coverage that let B1 ship.
 *
 * Testcontainers generates a throwaway user, password, port and database that
 * live only as long as the run. No real credential is read or required
 * (§0.2, ADR-010); `environment` is `PAPER` throughout.
 */

import {
  createIsolatedDatabase,
  createMigratedContext,
  createTradingChain,
  type TestContext,
} from "@polymarket-bot/storage-postgres/testing";
import { computePnlSnapshot, foldPnlRecords, type PnlSnapshot } from "@polymarket-bot/pnl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import { startReadyPostgresContainer } from "./support/containers.js";

/** Every column of `accounting.pnl_snapshots`, from `0006_accounting.up.sql`. */
const EVERY_COLUMN = [
  "pnl_snapshot_id",
  "scope",
  "environment",
  "account_ref",
  "instance_id",
  "run_id",
  "market_id",
  "denomination_asset",
  "gross_trading_pnl",
  "core_net_pnl",
  "all_in_pnl",
  "realized_pnl",
  "unrealized_pnl_midpoint",
  "unrealized_pnl_model",
  "unrealized_pnl_liquidation",
  "worst_case_resolution_pnl",
  "fees_paid",
  "reward_estimate_total",
  "realized_rewards",
  "capital_committed",
  "as_of",
  "computed_at",
  "rebuilt_at",
] as const;

/** The three the DATABASE owns: a default id, a default instant, a rebuild's. */
const DATABASE_OWNED = ["pnl_snapshot_id", "computed_at", "rebuilt_at"] as const;

const TOKEN_ASSET = "token-x";
const DENOMINATION = "pUSD";
const ACCOUNT = "test-account";

let container: Awaited<ReturnType<typeof startReadyPostgresContainer>>;
let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;
let store: PostgresTraderStore;

beforeAll(async () => {
  container = await startReadyPostgresContainer();
  const { connectionString } = await createIsolatedDatabase(
    container.getConnectionUri(),
    "trader-pnl-snapshot",
  );
  context = await createMigratedContext(connectionString);
  // The DATABASE STATE is a fixture's: `createTradingChain` seeds the market,
  // the strategy instance and the run that this table's three foreign keys
  // require, and no code in `apps/trader` creates any of them (see "WHAT THIS
  // FILE DOES NOT PROVE" above).
  chain = await createTradingChain(context, { label: "trdr2", accountRef: ACCOUNT });
  // The STORE, by contrast, is the composition root's own construction
  // (`apps/trader/src/main.ts:212`) on the handle `createDatabase` builds —
  // no test-only wrapper stands between this suite and the adapter.
  store = new PostgresTraderStore({ db: context.db, decisionContractVersion: 1 });
}, 300_000);

afterAll(async () => {
  // `store.close()` would destroy the shared handle the reads below use, so the
  // context owns the lifecycle; the container is stopped last.
  await context?.close();
  await container?.stop();
});

/**
 * A snapshot from the REAL `packages/pnl` pipeline, over the real identifiers
 * the chain created — so `instance_id`, `run_id` and `market_id` are values the
 * table's three foreign keys accept, and every measure is computed rather than
 * typed in.
 *
 * A buy, a partial sell and a fee give a NON-ZERO realized PnL, a non-zero
 * remaining position and a non-zero fee, and the model and liquidation marks
 * make the two nullable measures non-null — so most of the twenty columns carry
 * distinct values and a transposition between any two of THOSE cannot pass.
 *
 * It does not follow, and the first round of this file wrongly said it did,
 * that NO transposition can pass: this pipeline makes `coreNetPnl === allInPnl`
 * (§6 invariant 14 — they differ by REALIZED rewards, which need settlement
 * evidence no fixture may forge) and `rewardEstimateTotal === realizedRewards`
 * (both `"0"`), and a swap inside either pair is invisible to every assertion
 * here. The adversarial review demonstrated it: with
 * `core_net_pnl: row.allInPnl, all_in_pnl: row.coreNetPnl` planted in the
 * adapter, this file passed 3/3. That gap is closed in the Docker-free
 * companion — `test/unit/trader/pnl-snapshot-column-binding.test.ts` binds a
 * hand-built snapshot of twenty DISTINCT sentinels, where no permutation
 * survives — and it is closed THERE because it needs no database at all.
 */
function snapshotAt(asOf: string, marks: Record<string, Record<string, string>>): PnlSnapshot {
  const owner = {
    scope: "VIRTUAL_STRATEGY",
    accountRef: ACCOUNT,
    instanceId: chain.instanceId,
  } as const;
  const folded = foldPnlRecords(
    {
      scope: "VIRTUAL_STRATEGY",
      environment: "PAPER",
      accountRef: ACCOUNT,
      instanceId: chain.instanceId,
      runId: chain.runId,
      marketId: chain.marketId,
    },
    [
      {
        kind: "TRADE",
        ref: "018f3a5c-6666-7000-8000-000000000001",
        owner,
        marketId: chain.marketId,
        tokenAssetId: TOKEN_ASSET,
        denominationAsset: DENOMINATION,
        side: "BUY",
        shares: "10",
        price: "0.4",
      },
      {
        kind: "TRADE",
        ref: "018f3a5c-6666-7000-8000-000000000002",
        owner,
        marketId: chain.marketId,
        tokenAssetId: TOKEN_ASSET,
        denominationAsset: DENOMINATION,
        side: "SELL",
        shares: "4",
        price: "0.6",
      },
      {
        kind: "FEE",
        ref: "018f3a5c-6666-7000-8000-000000000003",
        owner,
        denominationAsset: DENOMINATION,
        amount: "0.13",
        scheduleVersionRef: "schedule-1",
      },
    ],
  );
  if (!folded.ok) {
    throw new Error(`the fold refused the records: ${JSON.stringify(folded.refusals)}`);
  }
  const computed = computePnlSnapshot(folded.value, { asOf, marks });
  if (!computed.ok) {
    throw new Error(`the snapshot was refused: ${JSON.stringify(computed.refusals)}`);
  }
  const snapshot = computed.value[0];
  if (snapshot === undefined) {
    throw new Error("the pipeline produced no snapshot");
  }
  return snapshot;
}

async function storedRows(): Promise<
  readonly Readonly<Record<string, unknown>>[]
> {
  return await context.db
    .selectFrom("accounting.pnl_snapshots")
    .selectAll()
    .orderBy("as_of")
    .execute();
}

describe("PostgresTraderStore.writePnlSnapshot against a real PostgreSQL (TRDR-2 / GOV-2B B1)", () => {
  it("inserts the snapshot, and every field reads back from the column it belongs in", async () => {
    const asOf = "2026-09-02T12:00:00.123456Z";
    const snapshot = snapshotAt(asOf, {
      [TOKEN_ASSET]: { midpoint: "0.5", model: "0.52", liquidation: "0.47" },
    });

    const written = await store.writePnlSnapshot(snapshot);
    // The B1 failure lands exactly here: `UNAVAILABLE` carrying the driver's
    // `column "accountRef" of relation "pnl_snapshots" does not exist`.
    expect(written.ok ? "ok" : `${written.failure.kind}: ${written.failure.detail}`).toBe("ok");

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("no row");

    // The row carries EVERY column the table declares — so a column added
    // upstream without a binding here is a failure rather than a silence.
    expect(Object.keys(row).sort()).toEqual([...EVERY_COLUMN].sort());

    // Field for field, camelCase measure to snake_case column.
    expect(row["scope"]).toBe(snapshot.scope);
    expect(row["environment"]).toBe(snapshot.environment);
    expect(row["account_ref"]).toBe(snapshot.accountRef);
    expect(row["instance_id"]).toBe(snapshot.instanceId);
    expect(row["run_id"]).toBe(snapshot.runId);
    expect(row["market_id"]).toBe(snapshot.marketId);
    expect(row["denomination_asset"]).toBe(snapshot.denominationAsset);
    expect(row["gross_trading_pnl"]).toBe(snapshot.grossTradingPnl);
    expect(row["core_net_pnl"]).toBe(snapshot.coreNetPnl);
    expect(row["all_in_pnl"]).toBe(snapshot.allInPnl);
    expect(row["realized_pnl"]).toBe(snapshot.realizedPnl);
    expect(row["unrealized_pnl_midpoint"]).toBe(snapshot.unrealizedPnlMidpoint);
    expect(row["unrealized_pnl_model"]).toBe(snapshot.unrealizedPnlModel);
    expect(row["unrealized_pnl_liquidation"]).toBe(snapshot.unrealizedPnlLiquidation);
    expect(row["worst_case_resolution_pnl"]).toBe(snapshot.worstCaseResolutionPnl);
    expect(row["fees_paid"]).toBe(snapshot.feesPaid);
    expect(row["reward_estimate_total"]).toBe(snapshot.rewardEstimateTotal);
    expect(row["realized_rewards"]).toBe(snapshot.realizedRewards);
    expect(row["capital_committed"]).toBe(snapshot.capitalCommitted);
    expect(row["as_of"]).toBe(asOf);

    // The three the database owns are the database's: an id and a computed
    // instant it supplied, and a rebuild instant no computation may set.
    expect(typeof row["pnl_snapshot_id"]).toBe("string");
    expect(typeof row["computed_at"]).toBe("string");
    expect(row["rebuilt_at"]).toBeNull();

    // Nothing is a `number`: §6 invariant 1 holds across the round trip, so a
    // measure cannot have passed through binary floating point.
    for (const column of EVERY_COLUMN) {
      if ((DATABASE_OWNED as readonly string[]).includes(column)) continue;
      expect(typeof row[column]).not.toBe("number");
    }

    // These nine measures are distinct, so a transposition among THEM could not
    // have satisfied the assertions above. `allInPnl` and `realizedRewards` are
    // deliberately NOT in this list: §6 invariant 14 makes `allInPnl` differ
    // from `coreNetPnl` by REALIZED rewards only, and a realized reward needs
    // settlement evidence this fixture does not forge — so those two pairs are
    // EQUAL here, and a swap inside either is invisible to this file. The
    // equality is asserted rather than hidden, and the transposition pin that
    // does cover the pairs lives in the Docker-free companion (see this file's
    // `snapshotAt` doc).
    const measures = [
      snapshot.grossTradingPnl,
      snapshot.coreNetPnl,
      snapshot.realizedPnl,
      snapshot.unrealizedPnlMidpoint,
      snapshot.unrealizedPnlModel,
      snapshot.unrealizedPnlLiquidation,
      snapshot.worstCaseResolutionPnl,
      snapshot.feesPaid,
      snapshot.capitalCommitted,
    ];
    expect(new Set(measures).size).toBe(measures.length);
    expect(snapshot.allInPnl).toBe(snapshot.coreNetPnl);
    expect(snapshot.realizedRewards).toBe("0");
  });

  it("binds an absent measure as SQL NULL, not as a string", async () => {
    const asOf = "2026-09-02T13:00:00.500001Z";
    const snapshot = snapshotAt(asOf, { [TOKEN_ASSET]: { midpoint: "0.5" } });
    expect(snapshot.unrealizedPnlModel).toBeNull();
    expect(snapshot.unrealizedPnlLiquidation).toBeNull();

    const written = await store.writePnlSnapshot(snapshot);
    expect(written.ok ? "ok" : `${written.failure.kind}: ${written.failure.detail}`).toBe("ok");

    const rows = await storedRows();
    const row = rows.find((candidate) => candidate["as_of"] === asOf);
    if (row === undefined) throw new Error(`no row at ${asOf}; got ${String(rows.length)}`);
    expect(row["unrealized_pnl_model"]).toBeNull();
    expect(row["unrealized_pnl_liquidation"]).toBeNull();
    expect(row["worst_case_resolution_pnl"]).toBe(snapshot.worstCaseResolutionPnl);
  });

  it("turns the table's own identity constraint into UNAVAILABLE port data, never a throw", async () => {
    // `pnl_snapshots_scope_unique` over
    // (scope, environment, account_ref, instance_id, market_id, as_of): the
    // second write of one identity is a constraint violation, which §4.2 makes
    // a halt the loop can act on rather than an exception it never sees.
    const asOf = "2026-09-02T14:00:00.250003Z";
    const snapshot = snapshotAt(asOf, { [TOKEN_ASSET]: { midpoint: "0.5" } });

    const first = await store.writePnlSnapshot(snapshot);
    expect(first.ok).toBe(true);

    const second = await store.writePnlSnapshot(snapshot);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("the duplicate was accepted");
    expect(second.failure.kind).toBe("UNAVAILABLE");
    expect(second.failure.detail).toContain("the durable store could not write a PnL snapshot");
    expect(second.failure.detail).toContain("pnl_snapshots_scope_unique");

    const rows = await storedRows();
    expect(rows.filter((candidate) => candidate["as_of"] === asOf)).toHaveLength(1);
  });
});
