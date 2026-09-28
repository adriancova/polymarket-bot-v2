/**
 * The trader health document's door — ADR-020 D1-D4 (see `doors.ts`).
 *
 * ## Why a health report is caller/wire input, and is treated as such
 *
 * `apps/control-api` cannot import `apps/trader`: layer 3 depends on nothing at
 * layer 3, and `docs/contracts/dependency-direction.md` F10 makes "any package
 * depending on an `apps/*` package" a violation. So the health surface
 * `WP-230` shipped reaches this process as a JSON DOCUMENT over a wire, which
 * is the exposure class ADR-020 §4 ranks highest, and it gets the full door.
 *
 * That is not a workaround. The dashboards' numbers come from here, an operator
 * makes decisions from those numbers, and a report this process could not fully
 * read is a report it must not half-read. Every counter below is REQUIRED: a
 * report that omits one is refused rather than defaulted to zero, because a
 * counter that silently reads 0 for "the producer stopped sending this" is
 * worse than no metric at all.
 *
 * ## The shape is `WP-230`'s, and the pin is executable
 *
 * The schema mirrors `apps/trader/src/health.ts`'s `HealthSnapshot` field for
 * field — the five seam sections, `observeOnlyIntents`, `halts`, the risk
 * refusal counts and `riskSeamCaveat` (`docs/handoffs/WP-230.md` follow-up 4) —
 * plus, since `TRDR-4`, the two seams the trader's core loop always publishes:
 * `seams.orders` (its per-order state) and `seams.retention` (its three audit
 * logs' bounded retention), and since `FOLD-1` a third, `seams.folds` (its
 * held accounting state and rebuild checks). All three are REQUIRED here like
 * every other counter; the trader's own type carries them as optional only for
 * holders of no loop, and a document without them is refused, not defaulted.
 * `test/integration/control-api/trader-health-shape.test.ts` builds a snapshot
 * with the REAL `HealthState` class and drives it through this door, so a
 * rename in the trader fails a suite rather than emptying a dashboard.
 */

import { z } from "zod";
import type { TraderHealthReportInput } from "@polymarket-bot/observability";

import { buildDoor, type DoorResult } from "./doors.js";

/** A counter: a non-negative safe integer. Never defaulted, never optional. */
const Counter = z.number().int().min(0);

/**
 * An economic value on this surface, as an EXACT decimal string.
 *
 * Checked as a string with a decimal shape and NEVER converted to a number
 * anywhere in this process (§6 invariant 1). The grammar is deliberately
 * permissive about scale — this door's job is to refuse a value that is not a
 * decimal at all, not to re-adjudicate `packages/decimal`'s canonical form for
 * a value another process already computed.
 */
const DecimalText = z.string().regex(/^-?\d+(?:\.\d+)?$/u);

const HaltScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("GLOBAL") }),
  z.strictObject({ kind: z.literal("MARKET"), marketId: z.string().min(1).max(256) }),
  z.strictObject({
    kind: z.literal("STRATEGY_INSTANCE"),
    instanceId: z.string().min(1).max(256),
  }),
]);

const Halt = z.strictObject({
  scope: HaltScope,
  code: z.string().min(1).max(128),
  detail: z.string().max(4096),
  at: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
});

const Queue = z.strictObject({
  name: z.string().min(1).max(128),
  currentDepth: Counter,
  maximumDepth: Counter,
  oldestMessageAgeMs: z.union([Counter, z.literal(null)]),
  messagesDropped: Counter,
  producerBlockedMs: Counter,
  consumerLag: z.number().int(),
  accepted: Counter,
  consumed: Counter,
});

const CountsByKey = z.record(z.string().min(1).max(256), Counter);

/** `TRDR-4`: one audit log's bounded retention (`order-lifecycle.ts`). */
const Retention = z.strictObject({
  retained: Counter,
  maximumRetained: Counter,
  evicted: Counter,
});

/**
 * `TRDR-4`: the trader loop's per-order state — orders still owned
 * (`tracked`), settled and pruned, the bounded settled-order tombstone map,
 * fills whose owner lookup missed (each posted UNATTRIBUTED and halted), the
 * late subset of those, and settlement mismatches.
 */
const OrderLifecycleSeam = z.strictObject({
  tracked: Counter,
  settled: Counter,
  tombstones: Counter,
  maximumTombstones: Counter,
  tombstoneEvictions: Counter,
  unownedFills: Counter,
  lateFillsAfterSettlement: Counter,
  settleMismatches: Counter,
});

/** `TRDR-4`: the three in-process audit logs' bounded retention. */
const RetentionSeam = z.strictObject({
  decisions: Retention,
  traces: Retention,
  provenance: Retention,
});

/**
 * `FOLD-1`: the trader loop's HELD accounting state (`apps/trader`'s
 * `folds.ts`, `FoldHealth`) — the rebuild-check cadence, how many ledger and
 * PnL checks ran, the posted-fill count at the last check (`null` before the
 * first: an absent measurement, never a zero), the mismatches (each a GLOBAL
 * `ACCOUNTING_REBUILD_MISMATCH` halt in the same document), and the refused
 * PnL records per instance and refusal code (user ruling F3). Every field is
 * REQUIRED, like every other counter here. Bounded: instance ids and codes as
 * the other keyed counters are (256 / 128 characters).
 */
const FoldsSeam = z.strictObject({
  checkEveryFills: z.number().int().min(1),
  pnlCheck: z.boolean(),
  fillsPosted: Counter,
  ledgerChecks: Counter,
  pnlChecks: Counter,
  fillsAtLastCheck: z.union([Counter, z.literal(null)]),
  ledgerMismatches: Counter,
  pnlMismatches: Counter,
  pnlRefusals: z.record(z.string().min(1).max(256), z.record(z.string().min(1).max(128), Counter)),
});

/**
 * A complete trader health DOCUMENT as this door reads it: the observability
 * package's `TraderHealthReportInput` plus the two `TRDR-4` seams and the
 * `FOLD-1` seam, which that package does not (yet) read — it is unchanged by
 * `TRDR-4` and `FOLD-1`, additions only.
 */
export type TraderHealthDocument = TraderHealthReportInput & {
  readonly seams: TraderHealthReportInput["seams"] & {
    readonly orders: z.output<typeof OrderLifecycleSeam>;
    readonly retention: z.output<typeof RetentionSeam>;
    /** `FOLD-1`: the loop's held accounting state. */
    readonly folds: z.output<typeof FoldsSeam>;
  };
};

const TraderHealthSchema = z.strictObject({
  runMode: z.string().min(1).max(64),
  maximumRunMode: z.string().min(1).max(64),
  healthy: z.boolean(),
  halts: z.array(Halt).max(4096),
  queues: z.array(Queue).max(256),
  loop: z.strictObject({
    eventsAccepted: Counter,
    eventsProcessed: Counter,
    eventsRefused: Counter,
    featureSnapshots: Counter,
    snapshotsUnavailable: Counter,
    featureProjectionRefusals: Counter,
    evaluations: Counter,
    decisionsPersisted: Counter,
    containedEvaluations: Counter,
    refusedEvaluations: Counter,
    deliveriesSuppressedByHalt: Counter,
  }),
  risk: z.strictObject({
    evaluations: Counter,
    approvals: Counter,
    refusals: Counter,
    refusalsByCode: CountsByKey,
    refusedExits: Counter,
    refusedExitsByCode: CountsByKey,
    recommendationsByAction: CountsByKey,
  }),
  execution: z.strictObject({
    plansBuilt: Counter,
    plansRefused: Counter,
    submissionsAccepted: Counter,
    submissionsRefused: Counter,
    fillsObserved: Counter,
    duplicateFillsRefused: Counter,
    cancelsRequested: Counter,
    cancelsConfirmed: Counter,
    cancelsRejected: Counter,
    cancelsSilenceExceeded: Counter,
    allocationsRefused: Counter,
    reservationsReleasedOnRefusal: Counter,
    observeOnlyIntents: Counter,
  }),
  accounting: z.strictObject({
    ledgerTransactions: Counter,
    ledgerRefusals: Counter,
    unattributedActivity: Counter,
    unexplainedMovements: Counter,
    pnlRecords: Counter,
    /**
     * `TRDR-3`: realized PnL as EXACT decimal strings — the trader's
     * `RealizedPnlHealth`. `byInstance` is keyed by instance id; `account` is
     * the trader's exact sum, or `null` while it has observed no snapshot
     * (a union with `null`, never an optional key — ADR-020 §1's adoptable
     * class). Bounded: at most 4096 instances, ids up to 256 characters.
     */
    realizedPnl: z.strictObject({
      byInstance: z.record(z.string().min(1).max(256), DecimalText),
      account: z.union([DecimalText, z.literal(null)]),
    }),
  }),
  seams: z.strictObject({
    fills: z.strictObject({
      remembered: Counter,
      maximumRemembered: Counter,
      admitted: Counter,
      refused: Counter,
      evictions: Counter,
    }),
    reservations: z.strictObject({
      open: Counter,
      taken: Counter,
      released: Counter,
      reservedCollateral: DecimalText,
    }),
    cancels: z.strictObject({
      pending: Counter,
      requested: Counter,
      confirmed: Counter,
      rejected: Counter,
      silenceExceeded: Counter,
    }),
    orderViews: z.strictObject({
      emitted: Counter,
      repeats: Counter,
      tracked: Counter,
    }),
    allocator: z.strictObject({
      open: Counter,
      applied: Counter,
      released: Counter,
      reservedCollateral: DecimalText,
      refusalsByCode: CountsByKey,
    }),
    orders: OrderLifecycleSeam,
    retention: RetentionSeam,
    folds: FoldsSeam,
  }),
  riskSeamCaveat: z.string().min(1).max(8192),
  asOf: z.string().min(1).max(64),
});

/**
 * D3: the value returned is read from the MATERIALIZED tree.
 *
 * The tree is already prototype-free and structurally correct — the schema said
 * so — so this cast is the D3 step, not a shortcut around it: the schema's own
 * output object is discarded and never reaches a caller.
 */
const TraderHealthDoor = buildDoor(
  TraderHealthSchema,
  "trader health report",
  (materialized): TraderHealthReportInput => materialized as TraderHealthReportInput,
);

/** Reads one trader health document through the door. TOTAL: never throws. */
export function readTraderHealthReport(input: unknown): DoorResult<TraderHealthReportInput> {
  return TraderHealthDoor(input);
}
