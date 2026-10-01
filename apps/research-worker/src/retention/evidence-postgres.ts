/**
 * The read-only PostgreSQL adapter the window classifier reads the trader's
 * rows through (`STORAGE-1` work-plan entry: "The window classifier reads
 * decision, order, fill and halt rows through a read-only adapter inside
 * apps/research-worker").
 *
 * **It only reads.** Every query runs inside a transaction whose access mode
 * is `READ ONLY`, so PostgreSQL itself refuses a write from this path, and
 * the tables are the ones `WP-040` defines, typed through
 * `@polymarket-bot/storage-postgres` so a wrong column name fails the
 * compiler (the `GOV-2B` B1 lesson).
 *
 * ## What it reads, and what is not there yet (disclosed)
 *
 * | Evidence | Rows | State today |
 * | --- | --- | --- |
 * | durable frontier | `strategy.decisions.evaluated_at`, newest per instance; the minimum over instances | written by the trader for every evaluation |
 * | intent | `strategy.decisions` with `intent_count > 0` for the market | written; `gateway_epoch` / `ingest_seq` are NULL today (`H1R1-PROVENANCE`), so a source event is located by its instant |
 * | fill | `execution.fills` for the market; `accounting.ledger_transactions` `TRADE_PRINCIPAL` for the market | only the ledger rows are written today (`BOOT1 fill-link severing`) |
 * | refusal | `ops.risk_events` VETOED or BREAKER for the market | not written today |
 * | halt | `ops.incidents` for the market, or market-less for the instance, inside the window's responsible span | not written today (`OUT1-R1-HALT-NOT-DURABLE`) |
 *
 * So today a window with a refusal or a halt but no intent and no fill is
 * classified unpinned. That is the residual `OUT1-R1-HALT-NOT-DURABLE`
 * already names; this adapter reads the halt and refusal tables so the
 * classification is right the day they are written, without a change here.
 *
 * The durable frontier relies on the trader committing its rows in
 * processing order (the `THROUGHPUT-1a` commit chain); the grace margin in
 * `classify.ts` is applied on top.
 */

import type { PolymarketBotDatabase, RunModeValue } from "@polymarket-bot/storage-postgres";

import { epochMsOf } from "../research-tier/sampler.js";
import type { IntentEvidence, MarketEvidence, TraderEvidenceSource } from "./classify.js";
import type { MarketWindow } from "./windows.js";

function instantMs(value: string): number {
  return epochMsOf(value);
}

/** The PostgreSQL trader evidence source. */
export function postgresTraderEvidence(
  db: PolymarketBotDatabase,
  options: { readonly environment: RunModeValue },
): TraderEvidenceSource {
  const readOnly = <T>(work: (trx: PolymarketBotDatabase) => Promise<T>): Promise<T> =>
    db
      .transaction()
      .setAccessMode("read only")
      .execute((trx) => work(trx as unknown as PolymarketBotDatabase));

  return {
    async durableThroughMs(instanceIds: readonly string[]): Promise<number | null> {
      if (instanceIds.length === 0) return null;
      return await readOnly(async (trx) => {
        let minimum: number | null = null;
        for (const instanceId of instanceIds) {
          const row = await trx
            .selectFrom("strategy.decisions")
            .select((eb) => eb.fn.max("evaluated_at").as("frontier"))
            .where("instance_id", "=", instanceId)
            .executeTakeFirst();
          const frontier = row?.frontier;
          if (frontier === null || frontier === undefined) return null; // an instance with nothing durable
          const ms = instantMs(String(frontier));
          minimum = minimum === null ? ms : Math.min(minimum, ms);
        }
        return minimum;
      });
    },

    async marketEvidence(window: MarketWindow, instanceIds: readonly string[]): Promise<MarketEvidence> {
      const instances = [...instanceIds];
      return await readOnly(async (trx) => {
        const decisions = await trx
          .selectFrom("strategy.decisions")
          .select(["evaluated_at", "source_event_id", "gateway_epoch", "ingest_seq"])
          .where("market_id", "=", window.marketId)
          .where("instance_id", "in", instances)
          .where("intent_count", ">", 0)
          .orderBy("evaluated_at")
          .execute();
        const intents: IntentEvidence[] = decisions.map((row) => ({
          evaluatedAtMs: instantMs(String(row.evaluated_at)),
          sourceEventId: row.source_event_id ?? null,
          gatewayEpoch: row.gateway_epoch ?? null,
          ingestSeq: row.ingest_seq ?? null,
        }));

        const fills = await trx
          .selectFrom("execution.fills")
          .select("matched_at")
          .where("market_id", "=", window.marketId)
          .where("environment", "=", options.environment)
          .execute();
        const ledgerFills = await trx
          .selectFrom("accounting.ledger_transactions")
          .select("occurred_at")
          .where("market_id", "=", window.marketId)
          .where("environment", "=", options.environment)
          .where("event_type", "=", "TRADE_PRINCIPAL")
          .execute();

        const refusals = await trx
          .selectFrom("ops.risk_events")
          .select("occurred_at")
          .where("market_id", "=", window.marketId)
          .where("environment", "=", options.environment)
          .where("outcome", "in", ["VETOED", "BREAKER"])
          .execute();

        const fromIso = new Date(window.responsibleFromMs).toISOString();
        const toIso = new Date(window.windowEndMs).toISOString();
        const halts = await trx
          .selectFrom("ops.incidents")
          .select("opened_at")
          .where("environment", "=", options.environment)
          .where((eb) =>
            eb.or([
              eb("market_id", "=", window.marketId),
              eb.and([eb("market_id", "is", null), eb("instance_id", "in", instances)]),
            ]),
          )
          .where("opened_at", ">=", fromIso)
          .where("opened_at", "<=", toIso)
          .execute();

        return {
          fillsAtMs: [
            ...fills.map((row) => instantMs(String(row.matched_at))),
            ...ledgerFills.map((row) => instantMs(String(row.occurred_at))),
          ],
          intents,
          refusalsAtMs: refusals.map((row) => instantMs(String(row.occurred_at))),
          haltsAtMs: halts.map((row) => instantMs(String(row.opened_at))),
        };
      });
    },
  };
}
