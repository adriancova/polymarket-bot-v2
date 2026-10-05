/**
 * Persistence ports — pure interfaces the COMPOSITION ROOT implements.
 *
 * `packages/strategy-runtime` is a layer-1 application module
 * (`docs/contracts/dependency-direction.md` §2): it owns rules and state, it
 * owns NO connection. §9.6 requires the runtime to "persist exactly one
 * `DecisionResult` per evaluation" and to "checkpoint strategy state after
 * defined transitions"; the storage that satisfies those writes is layer-2
 * (`packages/storage-postgres`, WP-040), and a layer-1 → layer-2 edge is
 * forbidden (F12). So persistence is expressed as ports: the trader app
 * (WP-230, layer 3) implements them over the storage package and injects them
 * here. The runtime guarantees the exactly-once CALL discipline; the
 * implementation guarantees durability (and the database's unique
 * `(run_id, evaluation_seq)` key backstops both).
 *
 * Both ports are SYNCHRONOUS by §8.1: "The core loop must never wait on
 * external I/O... The loop may synchronously append to a local journal/outbox
 * only if benchmarked within the latency budget." An implementation that must
 * do slow I/O appends to a bounded local journal here and drains it outside
 * the loop. A thrown error from either port HALTS the instance (typed outcome,
 * instance paused, no retry — a blind retry could double-persist a write whose
 * fate is unknown, the same reasoning as §6 invariant 6).
 */

import type { DecisionRecord, DecisionTelemetry } from "./record.js";
import type { StrategyStateCheckpoint } from "./checkpoint.js";

export interface DecisionSink {
  /** Called exactly once per evaluation that invoked a callback. */
  persist(record: DecisionRecord, telemetry: DecisionTelemetry): void;
}

export interface CheckpointStore {
  /**
   * Called exactly once after a successfully persisted decision that owes a
   * checkpoint (ADR-027 Decision 1; `CKPT-1`), synchronously, within the same
   * `evaluate()` call and with the decision's own `evaluationSeq` as
   * `checkpointSeq` — so an implementation can pair it with the record the
   * sink was just handed. Not called for a decision that owes none. Until
   * `CKPT-1`: "after every successfully persisted decision".
   *
   * DURABLE TOGETHER (ADR-027 D3, `CKPT-1`'s choice): an implementation that
   * makes records durable must make this checkpoint durable in the SAME
   * transaction as the decision it follows. A restore relies on it: it does
   * not, and cannot, inspect the decisions after the last checkpoint (an RNG
   * draw leaves no trace in a decision record).
   */
  save(checkpoint: StrategyStateCheckpoint): void;
}

/**
 * Injected monotonic time for the watchdog ONLY. Never used for anything a
 * strategy can observe and never part of a persisted record's deterministic
 * content. The composition root passes `process.hrtime.bigint`; tests pass a
 * manual clock. The runtime itself reads no clock (task-packet safety rule).
 */
export interface MonotonicClock {
  nowNs(): bigint;
}
