/**
 * The store decorator that feeds `accounting.realizedPnl` (`TRDR-3`).
 *
 * ## What it does, and the one thing it must not do
 *
 * `observeRealizedPnl(store, book)` answers a `TraderStore` that forwards every
 * call to `store` unchanged and, when `writePnlSnapshot` — or, since `SNAP-1`
 * r1, `replacePnlSnapshot` — SUCCEEDS, records the snapshot's `realizedPnl` in
 * the {@link RealizedPnlBook} the health surface reads. The value recorded is
 * the PnL engine's own `PnlSnapshot.realizedPnl` — the same object, the same
 * field, that `packages/storage-postgres` just persisted — so the health
 * surface can only ever say what the database holds.
 *
 * It must NOT change the store's answer. A refused write is returned as the
 * store refused it and is NOT recorded: the loop halts `STORE_UNAVAILABLE` on
 * that answer (`loop.ts`, `#flushPnlSnapshots`; `#writePnlSnapshot` before
 * `SNAP-1`), and a health surface that reported a value the database does not
 * hold would contradict the halt it sits next to. Recording happens strictly
 * AFTER `ok`, and a throw from the book (there is none — `record` is a
 * `Map.set`) would surface on the loop's own path exactly as any other
 * exception there does; it is not swallowed into a false `ok`.
 *
 * ## Why a decorator, and why here
 *
 * `loop.ts` calls `store.writePnlSnapshot` (or `replacePnlSnapshot`) and reads
 * back only `ok`;
 * `trader.ts` hands `options.store` straight to the loop. Neither is in this
 * round's grant, and neither needs to be: the composition root holds the
 * store before the trader exists, so it can wrap it, and holds the health
 * state after, so it can attach the book (`main.ts`, `assembleDurableTrader`).
 * A composition that does not wrap its store — `test/e2e/support/harness.ts`
 * today — gets the honest "no snapshot observed" reading, never a zero.
 *
 * `Number(...)`, `parseFloat` and unary `+` do not appear in this file.
 */

import type { AppendedLedgerTransaction } from "@polymarket-bot/ledger";
import type { PnlSnapshot } from "@polymarket-bot/pnl";
import type {
  DecisionRecord,
  DecisionTelemetry,
  StrategyStateCheckpoint,
} from "@polymarket-bot/strategy-runtime";

import type { RealizedPnlBook } from "@polymarket-bot/trading-core";
import type { PortResult, TraderStore } from "@polymarket-bot/trading-core";

/** A `TraderStore` that records every ACCEPTED PnL snapshot's realized PnL in `book`. */
export function observeRealizedPnl(store: TraderStore, book: RealizedPnlBook): TraderStore {
  return {
    persistDecision(record: DecisionRecord, telemetry: DecisionTelemetry): Promise<PortResult<null>> {
      return store.persistDecision(record, telemetry);
    },
    saveCheckpoint(checkpoint: StrategyStateCheckpoint, capturedAt: string): Promise<PortResult<null>> {
      return store.saveCheckpoint(checkpoint, capturedAt);
    },
    appendLedgerTransaction(transaction: AppendedLedgerTransaction): Promise<PortResult<null>> {
      return store.appendLedgerTransaction(transaction);
    },
    async writePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
      const written = await store.writePnlSnapshot(snapshot);
      if (written.ok) {
        book.record({ instanceId: snapshot.instanceId, realizedPnl: snapshot.realizedPnl });
      }
      return written;
    },
    // `SNAP-1` r1: a REPLACED row is the instance's latest accepted snapshot
    // too (a later harvest at an instant already written), so it is recorded
    // on exactly the same terms — after `ok`, never on a refusal.
    async replacePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>> {
      const replaced = await store.replacePnlSnapshot(snapshot);
      if (replaced.ok) {
        book.record({ instanceId: snapshot.instanceId, realizedPnl: snapshot.realizedPnl });
      }
      return replaced;
    },
    close(): Promise<void> {
      return store.close();
    },
    // `THROUGHPUT-1a`: the decorator observes PnL snapshots only; the store's
    // group commit (decisions and checkpoints) passes through untouched.
    ...(store.groupCommit === undefined ? {} : { groupCommit: store.groupCommit }),
  };
}
