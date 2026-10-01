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
 * | durable dispatch frontier | `strategy.decisions` `(gateway_epoch, ingest_seq)`: per instance, run and epoch, the largest `ingest_seq` (compared as an integer) and the latest `evaluation_seq` | **NULL today** (`H1R1-PROVENANCE`): no instance has a frontier, so no trader-responsible window is classified until the trader persists them |
 * | intent | `strategy.decisions` with `intent_count > 0` for the market | written; a source event with no `(gateway_epoch, ingest_seq)` is located by its instant |
 * | fill | `execution.fills` for the market; `accounting.ledger_transactions` `TRADE_PRINCIPAL` for the market | only the ledger rows are written today (`BOOT1 fill-link severing`) |
 * | refusal | `ops.risk_events` VETOED or BREAKER for the market | not written today |
 * | halt | `ops.incidents` for the market, or market-less for the instance, inside the window's responsible span | not written today (`OUT1-R1-HALT-NOT-DURABLE`) |
 *
 * So today a window with a refusal or a halt but no intent and no fill is
 * classified unpinned. That is the residual `OUT1-R1-HALT-NOT-DURABLE`
 * already names; this adapter reads the halt and refusal tables so the
 * classification is right the day they are written, without a change here.
 *
 * ## The durable dispatch frontier
 *
 * The frontier is read in DISPATCH order, never from `evaluated_at`: a receipt
 * instant can step backwards (ADR-026 Context 5), so the newest `evaluated_at`
 * does not show that every earlier-dispatched frame was processed. It relies
 * on two facts, stated rather than assumed silently:
 *
 * 1. the trader consumes the gateway's one ordered stream in `ingestSeq`
 *    order, and commits its rows in processing order (the `THROUGHPUT-1a`
 *    commit chain), so a durable decision at `(epoch, n)` means every row from
 *    events dispatched before it in that epoch is durable;
 * 2. within one run, `evaluation_seq` is the processing order, so a decision in
 *    another epoch with a larger `evaluation_seq` than every decision of epoch
 *    `E` means the run had moved past `E` (`completedEpochs`).
 *
 * `ingest_seq` is a canonical unsigned-integer string (`internal.uint_string`,
 * at most 40 digits), so its integer maximum is the maximum of its
 * zero-padded form.
 */

import type { PolymarketBotDatabase, RunModeValue } from "@polymarket-bot/storage-postgres";

import { compareUnsignedIntegerStrings } from "@polymarket-bot/storage-parquet";

import { epochMsOf } from "../research-tier/sampler.js";
import type { IntentEvidence, MarketEvidence, TraderEvidenceSource } from "./classify.js";
import type { DispatchFrontier } from "./wal-index.js";
import type { MarketWindow } from "./windows.js";

/** The width `internal.uint_string` is bounded to (`db/migrations/0001_foundation.up.sql`). */
const UINT_STRING_MAX_DIGITS = 40;

/** One instance's (run, epoch) aggregate. */
export type FrontierRow = {
  readonly runId: string;
  readonly gatewayEpoch: string;
  /** The largest `evaluation_seq` of the run's decisions in the epoch. */
  readonly maxEvaluationSeq: bigint;
  /** The largest `ingest_seq`, as a canonical unsigned-integer string. */
  readonly maxIngestSeq: string;
};

/**
 * Fold one instance's (run, epoch) aggregates into its frontier: the largest
 * `ingest_seq` per epoch over every run, and the epochs some run moved past.
 */
export function frontierFromRows(rows: readonly FrontierRow[]): DispatchFrontier | null {
  if (rows.length === 0) return null;
  const byEpoch = new Map<string, string>();
  for (const row of rows) {
    const known = byEpoch.get(row.gatewayEpoch);
    if (known === undefined || compareUnsignedIntegerStrings(row.maxIngestSeq, known) > 0) {
      byEpoch.set(row.gatewayEpoch, row.maxIngestSeq);
    }
  }
  const completedEpochs = new Set<string>();
  for (const row of rows) {
    const movedOn = rows.some(
      (other) =>
        other.runId === row.runId && other.gatewayEpoch !== row.gatewayEpoch && other.maxEvaluationSeq > row.maxEvaluationSeq,
    );
    if (movedOn) completedEpochs.add(row.gatewayEpoch);
  }
  return { byEpoch, completedEpochs };
}

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
    async dispatchFrontiers(instanceIds: readonly string[]): Promise<ReadonlyMap<string, DispatchFrontier>> {
      const out = new Map<string, DispatchFrontier>();
      if (instanceIds.length === 0) return out;
      return await readOnly(async (trx) => {
        for (const instanceId of instanceIds) {
          const rows = await trx
            .selectFrom("strategy.decisions")
            .select((eb) => [
              "run_id",
              "gateway_epoch",
              eb.fn.max("evaluation_seq").as("max_evaluation_seq"),
              eb.fn
                .max(eb.fn<string>("lpad", ["ingest_seq", eb.val(UINT_STRING_MAX_DIGITS), eb.val("0")]))
                .as("max_ingest_seq_padded"),
            ])
            .where("instance_id", "=", instanceId)
            .where("gateway_epoch", "is not", null)
            .where("ingest_seq", "is not", null)
            .groupBy(["run_id", "gateway_epoch"])
            .execute();
          const frontier = frontierFromRows(
            rows.map((row) => ({
              runId: String(row.run_id),
              gatewayEpoch: String(row.gateway_epoch),
              maxEvaluationSeq: BigInt(String(row.max_evaluation_seq)),
              maxIngestSeq: String(row.max_ingest_seq_padded).replace(/^0+(?=[0-9])/u, ""),
            })),
          );
          // An instance with no decision carrying a dispatch position has no
          // frontier, and is left out: its windows stay unclassified.
          if (frontier !== null) out.set(instanceId, frontier);
        }
        return out;
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
