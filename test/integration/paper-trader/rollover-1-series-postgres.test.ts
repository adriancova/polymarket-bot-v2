/**
 * `ROLLOVER-1` against a real PostgreSQL (Testcontainers, throwaway
 * credentials; the container is this file's own and is stopped in `afterAll`).
 *
 * What is proven, by name:
 *
 * 1. **REGISTER-1 `--series`** registers ONE series-bound instance and its run
 *    and NO market; `strategy.configs.parameters` is the document
 *    `{ strategy, series }` — the run record's pin of the reviewed series
 *    (ADR-030 Decision 4.2; the user's ruling Q4).
 * 2. **BOOT-1** accepts the completed document, and REFUSES it, naming
 *    `/series/maximumConcurrentWindows`, once the review is changed.
 * 3. **The durable multi-window run** — the assembled durable trader consumes
 *    the gateway's recorded stream: each admitted window gets its catalog row
 *    (`catalog.markets`, its version-1 parameter history and its two tokens)
 *    under its derived id BEFORE any decision names it; every decision and
 *    checkpoint lands, `(run_id, evaluation_seq)` and `(run_id,
 *    checkpoint_seq)` unique across the windows (ruling Q2), and every
 *    checkpoint row names its window (`market_id`, no migration).
 * 4. **`registerAdmittedMarket` is idempotent** for the same window and
 *    REFUSES another condition under a registered id.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseTraderConfig } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import { assembleDurableTrader } from "../../../apps/trader/src/main.js";
import { REGISTER_EXIT_CODES } from "../../../apps/trader/src/register/main.js";
import { startReadyPostgresContainer } from "./support/containers.js";
import { FIXTURE_FIRST_EVENT_AT, RebasedSystemPaperClock } from "./support/host-clock.js";
import { CODE_COMMIT, CREATED_BY, Scratch, assemble, printedIdentities, registerEnvironment, runRegister } from "./support/register-command.js";
import { withFreshDatabase as withFreshDatabaseOn, type Fresh } from "./support/registration.js";
import { ingestedOf, review, seriesConfig, seriesStream, W1, W2, W3 } from "./support/series-windows.js";

let container: Awaited<ReturnType<typeof startReadyPostgresContainer>>;
const scratch = new Scratch("rollover-1");

beforeAll(async () => {
  container = await startReadyPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
  await scratch.remove();
});

async function withFreshDatabase<T>(label: string, run: (fresh: Fresh) => Promise<T>): Promise<T> {
  return await withFreshDatabaseOn(container.getConnectionUri(), label, run);
}

/** The series configuration as a `register --series` template: its three identities removed. */
function seriesTemplate(): Record<string, unknown> {
  const document = seriesConfig();
  const instance = (document["seriesInstances"] as Record<string, unknown>[])[0] ?? {};
  const minted = ["instanceId", "runId", "configId"];
  const rest = Object.fromEntries(Object.entries(instance).filter(([key]) => !minted.includes(key)));
  return { ...document, seriesInstances: [rest] };
}

async function registerSeries(label: string, connectionString: string) {
  const directory = await scratch.directory(label);
  const template = await scratch.write(directory, "template.json", seriesTemplate());
  const out = path.join(directory, "completed.json");
  const run = await runRegister(
    ["--series", "--template", template, "--out", out, "--instance-name", `btc-15m-${label}`, "--code-commit", CODE_COMMIT, "--created-by", CREATED_BY],
    registerEnvironment(connectionString),
  );
  expect(run.code, run.log).toBe(REGISTER_EXIT_CODES.registered);
  const completed = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
  return { run, ids: printedIdentities(run), completed };
}

describe("ROLLOVER-1: a series-bound run, durable (REGISTER-1 --series, BOOT-1, catalog rows, checkpoint windows)", () => {
  it("register --series pins { strategy, series } and no market; BOOT-1 accepts it, and refuses a changed review by name", async () => {
    await withFreshDatabase("rollover1-register", async ({ connectionString, context }) => {
      const { run, ids, completed } = await registerSeries("register", connectionString);
      expect(ids.marketId).toBeNull();
      expect(run.log).toContain("catalog.markets: none");
      expect(run.log).toContain("REMINDER (ROLLOVER-1)");
      expect(await context.db.selectFrom("catalog.markets").select("market_id").execute()).toEqual([]);
      const config = await context.db
        .selectFrom("strategy.configs")
        .select(["parameters", "parameters_hash"])
        .where("config_id", "=", ids.configId)
        .executeTakeFirstOrThrow();
      const pinned = config.parameters as { strategy: Record<string, unknown>; series: Record<string, unknown> };
      // jsonb keeps its own key order; the document is the two halves.
      expect(Object.keys(pinned).sort()).toEqual(["series", "strategy"]);
      expect(pinned.series["seriesId"]).toBe("btc-15m-updown");
      expect(pinned.series["maximumConcurrentWindows"]).toBe("2");
      const instance = (completed["seriesInstances"] as Record<string, unknown>[])[0];
      expect([instance?.["instanceId"], instance?.["runId"], instance?.["configId"]]).toEqual([ids.instanceId, ids.runId, ids.configId]);

      const accepted = await assemble(completed, connectionString);
      expect(accepted.result.ok ? "ok" : accepted.log).toBe("ok");
      if (accepted.result.ok) await accepted.result.store.close();
      expect(accepted.log).toContain("registration: OK");

      const changed = { ...completed, series: [{ ...review(), maximumConcurrentWindows: 3 }] };
      const refused = await assemble(changed, connectionString);
      expect(refused.result.ok).toBe(false);
      expect(refused.log).toMatch(/\/series\/maximumConcurrentWindows: /u);
    });
  });

  it("the durable trader admits each window into the catalog first, and every checkpoint names its window", async () => {
    await withFreshDatabase("rollover1-durable", async ({ connectionString, context }) => {
      const { ids, completed } = await registerSeries("durable", connectionString);
      const envelopes = await seriesStream();
      // The process clock reads the stream's LAST instant now: every event is
      // recorded in the past, at most ~2.5 minutes ago (the risk engine's
      // features bound is 10 minutes).
      const last = envelopes.at(-1)?.receivedAt ?? FIXTURE_FIRST_EVENT_AT;
      const parsed = parseTraderConfig(completed);
      if (!parsed.ok) throw new Error(parsed.refusal.issues.join("; "));
      const lines: string[] = [];
      const assembled = await assembleDurableTrader({
        env: registerEnvironment(connectionString),
        config: parsed.config,
        document: completed,
        postgresUrl: connectionString,
        clock: new RebasedSystemPaperClock(last),
        log: (line) => {
          lines.push(line);
        },
      });
      if (!assembled.ok) throw new Error(lines.join("\n"));
      const { trader, store } = assembled;
      try {
        for (const event of ingestedOf(envelopes)) expect(trader.loop.ingest(event)).toBe(true);
        await trader.loop.drain();
        expect(trader.loop.health().halts).toEqual([]);
        // The operator's lines: every admission and teardown, by window.
        expect(lines.filter((line) => line.startsWith("[admission]")).map((line) => line.split(" ").slice(1, 4).join(" "))).toEqual([
          `ADMITTED window ${W1.marketId}`,
          `ADMITTED window ${W2.marketId}`,
          `TORN DOWN window`,
          `ADMITTED window ${W3.marketId}`,
        ]);

        // --- the windows' catalog rows, under their derived ids ---------------
        const markets = await context.db
          .selectFrom("catalog.markets")
          .select(["market_id", "condition_id", "question_title", "tick_size", "minimum_order_size", "neg_risk", "open_time", "close_time"])
          .orderBy("open_time")
          .execute();
        expect(markets.map((row) => [row.market_id, row.condition_id, row.question_title])).toEqual([
          [W1.marketId, W1.conditionId, W1.title],
          [W2.marketId, W2.conditionId, W2.title],
          [W3.marketId, W3.conditionId, W3.title],
        ]);
        expect(markets.map((row) => String(row.tick_size).replace(/0+$/u, ""))).toEqual(["0.001", "0.01", "0.01"]);
        const tokens = await context.db.selectFrom("catalog.market_tokens").select(["market_id", "token_id", "outcome_side", "outcome_label"]).execute();
        expect(tokens).toHaveLength(6);
        expect(tokens).toEqual(
          expect.arrayContaining([
            { market_id: W1.marketId, token_id: W1.yesTokenId, outcome_side: "YES", outcome_label: "Up" },
            { market_id: W1.marketId, token_id: W1.noTokenId, outcome_side: "NO", outcome_label: "Down" },
          ]),
        );
        const history = await context.db.selectFrom("catalog.market_parameter_history").select(["market_id", "parameters_version"]).execute();
        expect(history.map((row) => [row.market_id, row.parameters_version]).sort()).toEqual(
          [W1.marketId, W2.marketId, W3.marketId].map((id) => [id, 1]).sort(),
        );

        // --- decisions and checkpoints: one run, one sequence, each row its window
        const decisions = await context.db
          .selectFrom("strategy.decisions")
          .select(["evaluation_seq", "market_id"])
          .where("run_id", "=", ids.runId)
          .orderBy("evaluation_seq")
          .execute();
        expect(decisions.length).toBe(trader.loop.decisions().length);
        expect(decisions.map((row) => Number(row.evaluation_seq))).toEqual(decisions.map((_row, index) => index));
        expect(new Set(decisions.map((row) => row.market_id))).toEqual(new Set([W1.marketId, W2.marketId, W3.marketId]));
        const checkpoints = await context.db
          .selectFrom("strategy.state_checkpoints")
          .select(["checkpoint_seq", "market_id"])
          .where("run_id", "=", ids.runId)
          .execute();
        expect(checkpoints.length).toBeGreaterThanOrEqual(1);
        const marketOfSeq = new Map(decisions.map((row) => [Number(row.evaluation_seq), row.market_id]));
        for (const row of checkpoints) {
          expect(row.market_id, `checkpoint ${String(row.checkpoint_seq)}`).not.toBeNull();
          expect(row.market_id).toBe(marketOfSeq.get(Number(row.checkpoint_seq)));
        }
        expect(new Set(checkpoints.map((row) => row.market_id)).size).toBeGreaterThanOrEqual(2);
      } finally {
        await store.close();
      }

      // --- the catalog write is idempotent, and refuses another condition ---
      const direct = new PostgresTraderStore({ db: context.db, decisionContractVersion: 1 });
      const again = {
        marketId: W2.marketId,
        conditionId: W2.conditionId,
        questionTitle: W2.title,
        yesTokenId: W2.yesTokenId,
        noTokenId: W2.noTokenId,
        yesLabel: "Up",
        noLabel: "Down",
        tickSize: W2.tickSize,
        minimumOrderSize: "5",
        tradingDelaySeconds: 0,
        negRisk: false,
        openTime: W2.openAt,
        closeTime: W2.closeAt,
        observedAt: W2.openAt,
      };
      expect(await direct.registerAdmittedMarket(again)).toEqual({ ok: true, value: null });
      const other = await direct.registerAdmittedMarket({ ...again, conditionId: W3.conditionId });
      expect(other.ok).toBe(false);
      const swapped = await direct.registerAdmittedMarket({ ...again, yesTokenId: W2.noTokenId, noTokenId: W2.yesTokenId });
      expect(swapped.ok).toBe(false);
      expect(await context.db.selectFrom("catalog.markets").select("market_id").execute()).toHaveLength(3);
    });
  }, 120_000);
});
