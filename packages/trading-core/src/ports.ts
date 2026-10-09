/**
 * The trader's infrastructure ports — handoff §12.1 "Swappable infrastructure".
 *
 * > "Everything between event input and the `ExecutionVenue` interface is
 * > shared."
 *
 * That sentence is the whole design of this process. The core loop is written
 * ONCE against the ports below, and the difference between a PAPER run against
 * Redis and a BACKTEST replay against a dataset is which implementations are
 * handed to `createPaperTrader` — not a second code path, not a flag inside the
 * loop, and not a "replay mode" branch. §8.4's replay ordering is therefore the
 * same ordering the live path uses, because it is the same code.
 *
 * `Clock`, `MarketEventSource` and `ExecutionVenue` are DECLARED by
 * `packages/simulation` (`WP-210` deviation 3: the three §12.1 port interfaces
 * landed there). This layer-1 package consumes them across
 * `dependency-direction.md` §2.1 row S15 (ADR-022), and the two composition
 * roots that build the core — `apps/trader` and, from `BACKTEST-2` on,
 * `apps/backtest-cli` — hand in the implementations. So this module imports
 * them rather than restating them — a restatement is a shape that can drift
 * from the one the simulated venue actually implements.
 *
 * The two ports this module ADDS are the ones §12.1 does not name because they
 * are not simulation seams: the durable store (§10, PostgreSQL) and the event
 * transport's failure surface (§4.2, Redis). Both are here as ports for the
 * reason §4.2 gives them:
 *
 * > "A Redis outage stops publication and therefore halts trading… A PostgreSQL
 * > outage stops new trading decisions and order submission."
 *
 * A port whose failures are DATA is a port whose failures the loop can act on.
 * Every method below answers a discriminated union rather than throwing, and
 * the loop's response to the failure arm is a latched halt.
 */

import type {
  Clock,
  EventEnvelope,
  ExecutionVenue,
  MarketEventSource,
  RecordedEventIdentity,
} from "@polymarket-bot/simulation";
import type {
  DecisionRecord,
  DecisionTelemetry,
  StrategyStateCheckpoint,
} from "@polymarket-bot/strategy-runtime";
import type { AppendedLedgerTransaction } from "@polymarket-bot/ledger";
import type { PnlSnapshot } from "@polymarket-bot/pnl";

export type { Clock, EventEnvelope, ExecutionVenue, MarketEventSource, RecordedEventIdentity };

/**
 * Why a port could not answer. Named so the caller can pick the halt CODE it
 * records (e.g. `RESYNC_REQUIRED` → `TRANSPORT_RESYNC_REQUIRED`); every halt
 * ends the run (`C1-HALTS`), so the kind chooses no rung.
 */
export type PortFailureKind =
  /** The connection is gone, refused, or timed out. */
  | "UNAVAILABLE"
  /** The port answered, but with something this process cannot use. */
  | "UNREADABLE"
  /** ADR-003 §3.3: retention removed events this consumer never read. */
  | "RESYNC_REQUIRED";

export interface PortFailure {
  readonly kind: PortFailureKind;
  readonly detail: string;
}

export type PortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: PortFailure };

export function portOk<T>(value: T): PortResult<T> {
  return { ok: true, value };
}

export function portFailed<T>(kind: PortFailureKind, detail: string): PortResult<T> {
  return { ok: false, failure: { kind, detail } };
}

/**
 * One event as the loop receives it: the §7.1 envelope plus the recorded
 * identity every simulated outcome is anchored to (§6 invariant 15 — replay
 * "must not use future venue timestamps unavailable to the live process").
 *
 * The identity is carried BESIDE the envelope rather than derived from it
 * inside the loop, because the dataset path already has an authoritative
 * `datasetRowOrdinal` and the live path has to mint one; making the producer
 * state it keeps the loop free of a branch.
 */
export interface IngestedEvent {
  readonly envelope: EventEnvelope<unknown>;
  readonly identity: RecordedEventIdentity;
}

/**
 * The trader's read side of the event transport.
 *
 * Structurally the receive half of `packages/event-bus`'s `EventSubscription`,
 * reduced to what the loop consumes and with the throwing surface converted to
 * data. `adapters/redis-feed.ts` binds the real subscription to it.
 */
export interface MarketEventFeed {
  /**
   * The next batch in publication order, or a failure.
   *
   * An empty batch means "nothing right now", which is not a failure. A
   * `RESYNC_REQUIRED` failure is ADR-003 §3.3's hard resync and is NOT
   * recoverable inside the loop: §7.1 requires a new authoritative snapshot
   * before affected markets resume, so the loop halts and says so.
   */
  poll(): Promise<PortResult<readonly IngestedEvent[]>>;
  /**
   * Records that everything delivered so far is consumed — or, given a
   * {@link FeedMark} from {@link MarketEventFeed.mark}, everything delivered
   * up to that mark (`THROUGHPUT-1a`: the pump's pipelined path records a
   * batch's position once the batch's decisions are durable, which it learns
   * after the NEXT batch was delivered).
   */
  commit(upTo?: FeedMark): Promise<PortResult<null>>;
  /**
   * `THROUGHPUT-1a`, optional: an opaque mark of the position delivered so
   * far, for a later `commit(mark)`. `undefined` when nothing was delivered
   * since the last commit. A feed without it is committed as before: right
   * after each drain.
   */
  mark?(): FeedMark | undefined;
  close(): Promise<void>;
}

/** `THROUGHPUT-1a`: an opaque delivered position of one {@link MarketEventFeed}. */
export interface FeedMark {
  readonly feedMark: true;
}

/**
 * `PROVENANCE-1` — where an evaluation's triggering event lies in the
 * gateway's dispatch order: the §7.1 envelope's own `eventId`, `gatewayEpoch`
 * and `ingestSeq`, copied from the envelope and never derived.
 *
 * §7.1: "`gatewayEpoch + ingestSeq` defines the exact order consumed during
 * one gateway epoch." A decision that carries it can be placed in that order
 * without a join through the event id, which is what the research worker's
 * durable dispatch frontier reads (ADR-028 Decision 2.3; `H1R1-PROVENANCE`).
 */
export interface DispatchPosition {
  readonly eventId: string;
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
}

/**
 * `PROVENANCE-1` — one intent the §9.8 pre-trade risk check REFUSED, as the
 * loop saw it: the persisted decision that emitted it, the refusals, and the
 * evaluation's instant and dispatch position.
 *
 * Every field is the loop's own data at the refusal; nothing is read from a
 * clock. `ops.risk_events` is its table (`apps/trader`'s adapter binds one row
 * per refusal), and it is what the research worker reads as a window's refusal
 * evidence (ADR-028 Decision 3.1).
 */
export interface RiskRefusalRecord {
  readonly runId: string;
  readonly instanceId: string;
  readonly marketId: string;
  /** The persisted decision that emitted the refused intent. */
  readonly evaluationSeq: number;
  /** The strategy's own `intentId` (§7.7); `""` for an id-less intent. */
  readonly intentId: string;
  /** The loop's protective-exit classification of the intent (`risk.refusedExits`). */
  readonly protectiveExit: boolean;
  /** The strict-UTC instant of the evaluation the decision was made at. */
  readonly occurredAt: string;
  /** Every refusal the check answered, in its order (never empty). */
  readonly refusals: readonly { readonly code: string; readonly message: string }[];
  /** The decision's triggering event, or `null` for a loop-originated evaluation. */
  readonly sourceEvent: DispatchPosition | null;
}

/**
 * The durable store the process writes through (§10, PostgreSQL).
 *
 * §6 invariant 3 makes exactly one persisted `DecisionResult` per callback the
 * runtime's guarantee, and §6 invariant 8 makes the ledger the rebuildable
 * source of truth. Both are writes to this port, and both are why a store
 * failure is a FULL HALT rather than a retry: a decision the process took but
 * could not record is a decision that does not exist for reconciliation.
 */
export interface TraderStore {
  persistDecision(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
  ): Promise<PortResult<null>>;
  /**
   * `PROVENANCE-1`: records one refused intent ({@link RiskRefusalRecord}).
   * The loop writes it with the event's other rows — through the group commit
   * when the store has one ({@link StagedEvaluations.riskRefusals}), otherwise
   * here, after the event's decisions and checkpoints — and never after a
   * store failure it has halted on. A failure is a store failure like any
   * other: the loop halts `STORE_UNAVAILABLE`.
   */
  persistRiskRefusal(refusal: RiskRefusalRecord): Promise<PortResult<null>>;
  /**
   * `CKPT-1` (ADR-027 D3) — writes one decision AND the checkpoint it owes in
   * ONE transaction: both rows are durable, or neither is. The per-row path
   * calls it for every decision that owes a checkpoint (ADR-027 Decision 1);
   * a decision that owes none goes through {@link TraderStore.persistDecision}.
   * There is no lone-checkpoint write: until `CKPT-1` a `saveCheckpoint`
   * method wrote a checkpoint in its own autocommit, after its decision's, so
   * a failure or crash between the two left a decision durable without its
   * checkpoint (`DURABLE-1` LOW-3). The group commit
   * ({@link GroupCommit}) keeps the same rule by staging a checkpoint in its
   * decision's staging.
   *
   * @param capturedAt the strict-UTC instant of the evaluation this checkpoint
   *   belongs to. §10.3's `state_checkpoints.captured_at` is NOT NULL and the
   *   checkpoint value itself carries no instant — the runtime reads no clock —
   *   so the loop supplies the one the evaluation used, not a wall-clock read.
   */
  persistDecisionWithCheckpoint(
    record: DecisionRecord,
    telemetry: DecisionTelemetry,
    checkpoint: StrategyStateCheckpoint,
    capturedAt: string,
  ): Promise<PortResult<null>>;
  appendLedgerTransaction(
    transaction: AppendedLedgerTransaction,
  ): Promise<PortResult<null>>;
  /**
   * Inserts one §9.16 row. `accounting.pnl_snapshots_scope_unique` admits ONE
   * row per (scope, environment, account_ref, instance_id, market_id, as_of),
   * so a second row of an identity is REFUSED — as the database refuses it —
   * never merged or skipped (`SNAP-1`).
   */
  writePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>>;
  /**
   * `SNAP-1` r1: rewrites the ONE existing row of the snapshot's
   * `pnl_snapshots_scope_unique` identity with the snapshot's values, and
   * REFUSES when there is no such row (it never inserts one). The loop calls it
   * for exactly one case: a later harvest at an instant whose row this process
   * already inserted for the instance, so that row holds the state after the
   * LAST fill booked at that instant (the user's ruling, 2026-09-28) while
   * every write still lands before its harvest's deliveries (§4.2). The table
   * is the "rebuildable reporting projection" (`0006_accounting.up.sql`), not
   * append-only. A refusal is a store failure like any other: the loop halts.
   */
  replacePnlSnapshot(snapshot: PnlSnapshot): Promise<PortResult<null>>;
  /**
   * `ROLLOVER-1` (ADR-030): records one ADMITTED series window's catalog row —
   * `catalog.markets` with its tokens and its first parameter version — under
   * the window's own `marketId` (the derived id the gateway published), BEFORE
   * any durable row references it (every decision, checkpoint, ledger entry
   * and PnL row of the window does). Idempotent: a row already registered for
   * this `marketId` with the same condition id and tokens answers
   * `{ registered: true }`.
   *
   * `ROLLOVER-1` r1 (R1-FABLE-07): a CONFLICT with what the catalog already
   * holds — another condition or tokens under this `marketId`, or this
   * condition or a token under another market — is an ANSWER, not a failure:
   * `{ registered: false, conflict }`, nothing written. The loop refuses that
   * one window (`CATALOG_CONFLICT`) and goes on. A FAILURE (the database could
   * not answer) is a store failure like any other: the loop halts and the
   * window is not admitted. OPTIONAL: an in-memory store has no catalog to
   * write.
   */
  registerAdmittedMarket?(market: AdmittedMarketRegistration): Promise<PortResult<AdmittedMarketRegistered>>;
  close(): Promise<void>;
  /**
   * `THROUGHPUT-1a` — GROUP COMMIT, optional. A store that offers it lets the
   * loop write the decisions and checkpoints of SEVERAL consecutive events in
   * ONE transaction instead of two autocommits per decision; a store without
   * it (every in-memory one) is written exactly as before. See
   * {@link GroupCommit} for the contract and `loop.ts` for when the loop
   * commits.
   */
  readonly groupCommit?: GroupCommit;
}

/**
 * `ROLLOVER-1` r1 (R1-FABLE-07): what {@link TraderStore.registerAdmittedMarket}
 * answers when the store could answer — the row is registered (now, or already
 * with the same facts), or it CONFLICTS with what the catalog holds.
 */
export type AdmittedMarketRegistered =
  | { readonly registered: true }
  | { readonly registered: false; readonly conflict: string };

/** `ROLLOVER-1`: one admitted window's catalog row ({@link TraderStore.registerAdmittedMarket}). */
export interface AdmittedMarketRegistration {
  readonly marketId: string;
  readonly conditionId: string;
  /** The window's title, verbatim: the venue's question for it. */
  readonly questionTitle: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  /** The reviewed outcome labels, in order (index 0 the YES outcome). */
  readonly yesLabel: string;
  readonly noLabel: string;
  readonly tickSize: string;
  readonly minimumOrderSize: string;
  /** The review's catalog statement (`catalogTradingDelaySeconds`). */
  readonly tradingDelaySeconds: number;
  readonly negRisk: boolean;
  readonly openTime: string;
  readonly closeTime: string;
  /** The admission event's instant. */
  readonly observedAt: string;
}

/**
 * `THROUGHPUT-1a` — one event's decisions and checkpoints, as the loop's
 * outbox drained them (decisions in evaluation order, then checkpoints in the
 * same order), each checkpoint with the instant its row's `captured_at` takes.
 *
 * `CKPT-1` (ADR-027 D3): every checkpoint here follows a decision of THIS
 * staging — the loop never stages a checkpoint apart from its decision — so a
 * store that commits a staging in one transaction (as {@link GroupCommit}
 * requires) makes each decision and its checkpoint durable together. Since
 * ADR-027 a staging holds a checkpoint only for the decisions that owe one.
 */
export interface StagedEvaluations {
  readonly decisions: readonly { readonly record: DecisionRecord; readonly telemetry: DecisionTelemetry }[];
  readonly checkpoints: readonly { readonly checkpoint: StrategyStateCheckpoint; readonly capturedAt: string }[];
  /**
   * `PROVENANCE-1`: the event's refused intents, written in the same
   * transaction as the rows staged with them — so no decision of a LATER
   * event becomes durable before them (the commit chain is in stage order).
   */
  readonly riskRefusals: readonly RiskRefusalRecord[];
}

/**
 * `THROUGHPUT-1a` — the group-commit capability of a {@link TraderStore}.
 *
 * The contract, which the durable trader's crash-recovery proof tests:
 *
 * - {@link GroupCommit.stage} is synchronous and does no I/O. It turns one
 *   event's rows into the exact column values `persistDecision` /
 *   `persistDecisionWithCheckpoint` would bind, or answers the failure those
 *   would have answered (then nothing of that event is staged);
 * - {@link GroupCommit.commit} writes EVERYTHING staged, in stage order, in
 *   ONE database transaction, and resolves only once that transaction
 *   committed — or answers the failure, having committed nothing. Either way
 *   the staged rows are gone afterwards: a failed batch is not retried (the
 *   loop halts, as it does on any store failure);
 * - nothing is committed except by `commit`.
 *
 * So the durable rows are always a whole number of committed batches — a
 * PREFIX of the run's decisions and checkpoints, never a gap — and a crash
 * loses at most the staged, uncommitted tail, whose events the transport
 * still holds: the pump records the stream position only after the drain,
 * and the drain ends with a commit (`loop.ts`).
 */
export interface GroupCommit {
  stage(evaluations: StagedEvaluations): PortResult<null>;
  /**
   * Stagings not yet committed: one per `stage` call. The loop stages once
   * per outbox flush — once per event before ADR-024, once per venue FRAME
   * since (`THROUGHPUT-2` r1, `TP2-R1-M2`; `loop.ts` states the bounds).
   */
  readonly stagedEvents: number;
  commit(): Promise<PortResult<{ readonly decisions: number; readonly checkpoints: number }>>;
}

/**
 * A synchronous decision/checkpoint buffer.
 *
 * `packages/strategy-runtime`'s `DecisionSink` and `CheckpointStore` are
 * SYNCHRONOUS ports — `evaluate()` calls them inside the evaluation and treats a
 * throw as a halt — while {@link TraderStore} is asynchronous, because a
 * database is. §8.1 settles the conflict:
 *
 * > "The core loop must never wait on external I/O. Database writes, Redis
 * > reads, and venue calls are handled through bounded adapters and completion
 * > events. **The loop may synchronously append to a local journal/outbox**…"
 *
 * So the runtime writes into this in-memory outbox synchronously, and the loop
 * drains it to the store after the evaluation, halting on a store failure. The
 * outbox is BOUNDED for the same reason every other queue is (§8.3), and a full
 * outbox makes the synchronous port throw — which the runtime turns into its
 * own `HALTED` outcome, which the loop turns into a latched halt. Nothing is
 * dropped on any path.
 *
 * `CKPT-1` (ADR-027 D3): the shape is one entry per decision, carrying the
 * checkpoint it owes (or `undefined`), so a drain can never hand a store a
 * decision without its owed checkpoint or a checkpoint without its decision.
 * It was two parallel lists (`decisions`, `checkpoints`); the loop's
 * `DecisionOutboxBuffer` is the implementation.
 */
export interface DecisionOutbox {
  drain(): readonly {
    readonly record: DecisionRecord;
    readonly telemetry: DecisionTelemetry;
    readonly checkpoint: StrategyStateCheckpoint | undefined;
  }[];
}
