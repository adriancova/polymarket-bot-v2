/**
 * The trader's health state — the `WP-230` deliverable "bounded queues and
 * health state", shaped by handoff §14.3's metric families.
 *
 * What this module is NOT: a dashboard, an HTTP endpoint or a Prometheus
 * exporter. Those are `WP-240` (control API and paper dashboards),
 * `packages/observability`, and — since `TRDR-3` — this app's own
 * `health-server.ts`, which serves the snapshot below over the loopback. This
 * is the STATE those read — one value, snapshot-able, deterministic, with no
 * clock of its own.
 *
 * ## What the packet requires this to expose, and where each lives
 *
 * | Required | Field |
 * | --- | --- |
 * | run mode | `runMode`, `maximumRunMode` |
 * | queue depths | `queues` (the full §8.3 metric set per queue) |
 * | halt reason | `halts` (every latched record: scope, code, action, detail, instant) |
 * | risk-refusal counts | `risk.refusalsByCode`, `risk.refusedExits`, `risk.approvals` |
 *
 * ## The risk-refusal counts are the risk-seam caveat made visible
 *
 * This section used to open: "`WP-220`'s accepted residual: every exit the
 * static-bracket strategy emits is a `POSITION` intent, and `packages/risk`
 * derives its disposition from the intent TYPE alone, so a protective
 * reduction is classified `ENTRY` … That is the accepted posture … until the
 * risk-side follow-up lands" — and that follow-up landed as `RISK-2`
 * (`133eac1`), so the sentence is superseded: the current caveat, what it
 * says and why, is {@link RISK_SEAM_CAVEAT} below. What has not changed is the
 * rule: this process must NOT weaken risk policy, re-tag the intent or bypass
 * the engine to compensate for anything the seam does.
 *
 * What it CAN do — and does — is refuse to let the consequence be invisible.
 * `refusedExits` counts refusals of intents the emitting strategy tagged as
 * protective (`sb.protected-reduce` / `sb.take-profit`), broken down by the
 * risk reason code that refused them, so an operator sees "the exits are being
 * refused, and here is the code that did it" on the health surface rather than
 * discovering it in an incident. `riskSeamCaveat` states the whole thing in
 * one string that travels with the snapshot.
 *
 * DETERMINISM. Counters are integers, maps are emitted in sorted key order, and
 * no method reads a clock: every instant is supplied. Two identical runs
 * produce identical snapshots.
 *
 * ## Realized PnL, as an EXACT decimal (`TRDR-3`, `GOV-2B` B5)
 *
 * `accounting.realizedPnl` carries the PnL engine's OWN value — the
 * `realizedPnl` of the latest `PnlSnapshot` the durable store accepted, per
 * strategy instance, plus their exact sum — as decimal STRINGS. It is not a
 * second accounting: nothing here multiplies a price by a size. The value is
 * observed at the store port ({@link RealizedPnlBook}, fed by
 * `pnl-observation.ts` from the same `writePnlSnapshot` call that persists
 * the row), so the health surface reports what the database holds and never a
 * number computed on the way. `Number(...)` does not appear in this file; the
 * sum is `@polymarket-bot/decimal`'s `addDecimal`, and
 * `test/unit/trader/health-realized-pnl.test.ts` proves the round trip on a
 * value float64 cannot represent.
 *
 * WHY A BOOK THE ROOT ATTACHES, rather than a counter the loop increments: the
 * loop hands `writePnlSnapshot` its snapshot and reads back only `ok`; the
 * composition root (`main.ts`) is the one place that holds the store BEFORE
 * the trader exists and the health state AFTER, so it wraps the store and
 * attaches the book — {@link HealthState.attachRealizedPnl}. Until a book is
 * attached (a composition that does not observe its store —
 * `test/e2e/support/harness.ts` today) the field reads `byInstance: {}` and
 * `account: null`: "no snapshot observed", stated as such rather than as a
 * zero nobody measured.
 */

import { addDecimal } from "@polymarket-bot/decimal";

import type { AllocatorMetrics } from "./allocation.js";
import type { CancelLedgerMetrics } from "./cancels.js";
import type { FillDeduplicatorMetrics } from "./fills.js";
import type { HaltRecord } from "./halt.js";
import type { OrderLifecycleMetrics, RetentionHealth } from "./order-lifecycle.js";
import type { OrderViewMetrics } from "./orders.js";
import type { QueueMetrics } from "./queue.js";
import type { ReservationMetrics } from "./reservations.js";

/**
 * The disclosure that travels with every health snapshot.
 *
 * It is a constant rather than prose in a comment because an operator reading
 * the health surface is exactly the person who needs it, and a caveat that only
 * exists in a README is a caveat nobody reads during an incident.
 *
 * CORRECTED by `BOOT-1` (`RISK-2` residual R2). Until then this constant
 * shipped, on every `HealthSnapshot.riskSeamCaveat` and through the control
 * API, the text quoted in its first sentence below — a statement `RISK-2`
 * (`133eac1`) made false. The superseded wording is kept inside the constant,
 * quoted, so an operator who saw the old caveat can recognise what changed.
 */
export const RISK_SEAM_CAVEAT =
  'SUPERSEDED (RISK-2, 133eac1): this caveat used to read "WP-220 accepted residual: every ' +
  "exit the static-bracket strategy emits is a §7.7 POSITION intent, and packages/risk derives " +
  "the disposition from the intent TYPE alone, so a protective reduction is classified ENTRY. " +
  'Protective reductions are therefore refused …" — that is no longer true: packages/risk ' +
  "decides disposition from the intent SHAPE and the supplied portfolio, never from a tag — " +
  "a POSITION resolving to a SELL fully covered by the instance's confirmed holding is an " +
  "EXIT and clears the seam; anything with a BUY leg, an over-held sell and every QUOTE/BASKET " +
  "stays ENTRY — so refusedExits reads 0 in a healthy run. THE CAVEAT NOW: RISK-2 residual 5 — " +
  "planProtectedReduce creates no order track, so when the instance's own exit FILLS the " +
  "strategy cannot attribute it (SB.UNATTRIBUTED_FILL → SB.POSITION_MISMATCH → " +
  "SB.NO_BLIND_FLATTEN → SB.PAUSED) and the instance ends PAUSED after its round trip; the " +
  "money is right and the pause is strictly after the exit is booked, but a paused instance " +
  "opens no second bracket. The trader does not weaken risk policy, re-tag intents or bypass " +
  "the engine to compensate; it counts refusals here.";

/** Counters for the §14.3 `risk` family plus the seam's own visibility. */
export interface RiskHealth {
  readonly evaluations: number;
  readonly approvals: number;
  readonly refusals: number;
  /** Refusal count per `packages/risk` reason code, sorted by code. */
  readonly refusalsByCode: Readonly<Record<string, number>>;
  /**
   * Refusals of intents the strategy tagged protective — the risk-seam
   * caveat's own counter.
   */
  readonly refusedExits: number;
  /** Refused-exit count per reason code, sorted by code. */
  readonly refusedExitsByCode: Readonly<Record<string, number>>;
  /** §9.9 incident recommendations the engine returned, per action. */
  readonly recommendationsByAction: Readonly<Record<string, number>>;
}

/** Counters for the §14.3 `execution` family, at the granularity this process has. */
export interface ExecutionHealth {
  readonly plansBuilt: number;
  readonly plansRefused: number;
  readonly submissionsAccepted: number;
  readonly submissionsRefused: number;
  readonly fillsObserved: number;
  /** Fills the dedup seam refused as redeliveries (obligation 5). */
  readonly duplicateFillsRefused: number;
  readonly cancelsRequested: number;
  readonly cancelsConfirmed: number;
  readonly cancelsRejected: number;
  /** Cancels closed by `submission_unknown_after_ms` (§6 invariant 6). */
  readonly cancelsSilenceExceeded: number;
  /**
   * Plans the §9.7 allocator refused to reserve capital for.
   *
   * Distinct from `submissionsRefused`: nothing was offered to the venue.
   * §9.10 reserves BEFORE submission, so a refusal here is a plan that never
   * left this process.
   */
  readonly allocationsRefused: number;
  /**
   * Reservations returned because the VENUE refused the submission.
   *
   * Review round 1, MEDIUM-4: a refused submission produces no order view, so
   * before the fix nothing ever released what it had reserved. A non-zero
   * count here is the release happening; `seams.reservations.open` returning to
   * its prior value is the same fact measured from the book.
   *
   * `TRDR-4` round 1: only a planned order the venue does NOT hold is released
   * here. An order a refused plan nonetheless left at the venue keeps its
   * reservation until it is terminal (ADR-006 §9), and its market is halted
   * `UNATTRIBUTED_ACTIVITY` for reconciliation.
   */
  readonly reservationsReleasedOnRefusal: number;
  /**
   * Intents a NON-OWNER instance emitted, which were never routed (§6 invariant
   * 11, ADR-011 §5: a shadow instance "submits nothing").
   *
   * Review round 2, HIGH-1. Counted rather than dropped silently: an operator
   * who configured `ownership: "SHADOW"` and sees no fills is entitled to tell
   * "the strategy emitted nothing" from "the process declined to route what it
   * emitted", and those two states are otherwise identical on this surface. The
   * decisions themselves are still persisted, so the intents are also visible
   * on the decision log — this counter is the routing side of the same fact.
   */
  readonly observeOnlyIntents: number;
}

/** Counters for the loop itself and the strategy runtime it drives. */
export interface LoopHealth {
  readonly eventsAccepted: number;
  readonly eventsProcessed: number;
  /** Events the wire door refused, or whose instant could not be normalised. */
  readonly eventsRefused: number;
  readonly featureSnapshots: number;
  /**
   * Evaluations skipped because no feature snapshot could be computed.
   *
   * Counted SEPARATELY from `eventsRefused`, because the two are different
   * facts with different fixes: a refused event is a stream this process cannot
   * read, while an uncomputable snapshot is ordinary early-run state (no book
   * has arrived yet). Merging them would make a healthy start look like a feed
   * problem.
   */
  readonly snapshotsUnavailable: number;
  /** Keys the projection could not produce (`projection.ts` rule R5). */
  readonly featureProjectionRefusals: number;
  readonly evaluations: number;
  readonly decisionsPersisted: number;
  /** ADR-005 §3 containments: the runtime paused an instance. */
  readonly containedEvaluations: number;
  readonly refusedEvaluations: number;
  /**
   * Fill and order-view deliveries the §4.2 halt gate withheld from a strategy.
   *
   * The ACCOUNTING for those events still happened — the ledger posting is
   * unconditional, because the money moved whatever this process's state is —
   * and this counter is the other half of that sentence: the number of times a
   * halted scope was not allowed to decide on what it had booked.
   */
  readonly deliveriesSuppressedByHalt: number;
}

/** The integer counters of the §14.3 `accounting` family — what {@link HealthState.countAccounting} moves. */
export interface AccountingCounters {
  readonly ledgerTransactions: number;
  readonly ledgerRefusals: number;
  readonly unattributedActivity: number;
  readonly unexplainedMovements: number;
  readonly pnlRecords: number;
}

/**
 * Realized PnL on the health surface, as EXACT decimal strings (`TRDR-3`).
 *
 * Every value is a `PnlSnapshot.realizedPnl` the store accepted, or the exact
 * `addDecimal` fold of those values. See the module header.
 */
export interface RealizedPnlHealth {
  /**
   * The latest persisted snapshot's `realizedPnl` per strategy instance,
   * keyed by instance id, in sorted key order.
   */
  readonly byInstance: Readonly<Record<string, string>>;
  /**
   * The exact sum over `byInstance`, or `null` while NO snapshot has been
   * observed — a composition that attached no book, or a run that has not
   * produced a snapshot yet. Never a defaulted `"0"`: an absent measurement
   * and a flat account are different facts.
   */
  readonly account: string | null;
}

/** The §14.3 `accounting` family: the counters plus the exact realized PnL. */
export interface AccountingHealth extends AccountingCounters {
  readonly realizedPnl: RealizedPnlHealth;
}

/** The shape {@link RealizedPnlBook.record} reads — `PnlSnapshot`'s two relevant fields. */
export interface RealizedPnlObservation {
  readonly instanceId: string | null;
  readonly realizedPnl: string;
}

/** The "nothing observed" view, frozen once. */
const NO_REALIZED_PNL: RealizedPnlHealth = Object.freeze({
  byInstance: Object.freeze(Object.create(null) as Record<string, string>),
  account: null,
});

/**
 * The latest realized PnL per instance, as the store accepted it.
 *
 * Owned by the composition root, written by `pnl-observation.ts`'s store
 * decorator AFTER a successful `writePnlSnapshot`, read by
 * {@link HealthState.snapshot} once attached. Holding the values here rather
 * than inside `HealthState` is what lets the root wrap the store before the
 * trader (and therefore the health state) exists, without losing a write that
 * happened in between — there is none today, and the design does not rely on
 * that.
 */
export class RealizedPnlBook {
  readonly #byInstance = new Map<string, string>();
  #observed = 0;

  /**
   * Records one accepted snapshot. A snapshot with no instance id (a
   * non-strategy stream) is not per-instance and is NOT recorded: the trader
   * writes only `VIRTUAL_STRATEGY` streams today, and a future account-scope
   * stream would need its own field rather than being folded into this one.
   */
  record(snapshot: RealizedPnlObservation): void {
    if (snapshot.instanceId === null) return;
    this.#byInstance.set(snapshot.instanceId, snapshot.realizedPnl);
    this.#observed += 1;
  }

  /** How many snapshots were recorded. */
  get observed(): number {
    return this.#observed;
  }

  /** The frozen, sorted view with the exact account sum. */
  view(): RealizedPnlHealth {
    if (this.#byInstance.size === 0) return NO_REALIZED_PNL;
    const byInstance: Record<string, string> = Object.create(null) as Record<string, string>;
    let account = "0";
    for (const instanceId of [...this.#byInstance.keys()].sort()) {
      const value = this.#byInstance.get(instanceId) ?? "0";
      byInstance[instanceId] = value;
      account = addDecimal(account, value);
    }
    return Object.freeze({ byInstance: Object.freeze(byInstance), account });
  }
}

/**
 * The composition-root SEAMS, as counters an operator can read.
 *
 * WHY THIS SECTION EXISTS (review round 1, MEDIUM-2). Each of these seams
 * already published a `metrics()` — and NOTHING CALLED IT outside its own unit
 * test. `fills.ts` said "a run that evicts is a run whose bound is too small,
 * and `evictions > 0` on the health surface says so", and there was no health
 * surface it appeared on. The claim is now true: every seam that bounds, dedups
 * or reserves reports here, on the one surface `WP-240` will read.
 */
export interface SeamHealth {
  /** `fills.ts` — the at-most-once gate, and how close it is to its bound. */
  readonly fills: FillDeduplicatorMetrics;
  /** `reservations.ts` — `WP-220` obligation 9's inventory book. */
  readonly reservations: ReservationMetrics;
  /** `cancels.ts` — obligation 10: every cancel reaches a terminal fact. */
  readonly cancels: CancelLedgerMetrics;
  /** `orders.ts` — obligations 4 and 5a: deliveries and labelled repeats. */
  readonly orderViews: OrderViewMetrics;
  /** `allocation.ts` — the §9.7 commitment book behind §9.8 checks 14 and 15. */
  readonly allocator: AllocatorMetrics;
  /**
   * `TRDR-4` — the loop's per-order state: live owned orders, settled ones,
   * the bounded tombstone map, and the fills whose owner lookup missed
   * (`order-lifecycle.ts`).
   *
   * OPTIONAL ON THIS TYPE ONLY, and deliberately: `HealthState.snapshot` is also
   * called by holders of no loop (unit fixtures that build the five original
   * seams), and a counter this class invented for them would be a zero nobody
   * measured. `CoreLoop.health()` ALWAYS supplies it (its return type,
   * `LoopHealthSnapshot`, says so), and the control API's strict door REQUIRES
   * it — so a producer that omits it is refused at the door, never defaulted.
   */
  readonly orders?: OrderLifecycleMetrics;
  /**
   * `TRDR-4` — the three in-process audit logs' bounded retention
   * (`decisions()`, `traces()`, `orderProvenance()`): `retained`,
   * `maximumRetained`, `evicted` each. Optional on this type for the same
   * reason as {@link SeamHealth.orders}, and always supplied by the loop.
   */
  readonly retention?: RetentionHealth;
}

export interface HealthSnapshot {
  readonly runMode: string;
  readonly maximumRunMode: string;
  /** `true` while no scope is halted and the loop may make decisions. */
  readonly healthy: boolean;
  readonly halts: readonly HaltRecord[];
  readonly queues: readonly QueueMetrics[];
  readonly loop: LoopHealth;
  readonly risk: RiskHealth;
  readonly execution: ExecutionHealth;
  readonly accounting: AccountingHealth;
  /** The composition-root seams' own counters. See {@link SeamHealth}. */
  readonly seams: SeamHealth;
  readonly riskSeamCaveat: typeof RISK_SEAM_CAVEAT;
  /** The instant this snapshot was taken, from the injected clock. */
  readonly asOf: string;
}

function sortedCounts(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of [...counts.keys()].sort()) {
    out[key] = counts.get(key) ?? 0;
  }
  return Object.freeze(out);
}

/**
 * The mutable counter set the loop increments and the health surface reads.
 *
 * Every mutation is a named method rather than a public field, so a reviewer
 * can enumerate every place a counter can move by searching for the method.
 */
export class HealthState {
  readonly runMode: string;
  readonly maximumRunMode: string;

  #loop = {
    eventsAccepted: 0,
    eventsProcessed: 0,
    eventsRefused: 0,
    featureSnapshots: 0,
    snapshotsUnavailable: 0,
    featureProjectionRefusals: 0,
    evaluations: 0,
    decisionsPersisted: 0,
    containedEvaluations: 0,
    refusedEvaluations: 0,
    deliveriesSuppressedByHalt: 0,
  };

  #risk = { evaluations: 0, approvals: 0, refusals: 0, refusedExits: 0 };
  readonly #refusalsByCode = new Map<string, number>();
  readonly #refusedExitsByCode = new Map<string, number>();
  readonly #recommendationsByAction = new Map<string, number>();

  #execution = {
    plansBuilt: 0,
    plansRefused: 0,
    submissionsAccepted: 0,
    submissionsRefused: 0,
    fillsObserved: 0,
    duplicateFillsRefused: 0,
    cancelsRequested: 0,
    cancelsConfirmed: 0,
    cancelsRejected: 0,
    cancelsSilenceExceeded: 0,
    allocationsRefused: 0,
    reservationsReleasedOnRefusal: 0,
    observeOnlyIntents: 0,
  };

  #accounting = {
    ledgerTransactions: 0,
    ledgerRefusals: 0,
    unattributedActivity: 0,
    unexplainedMovements: 0,
    pnlRecords: 0,
  };

  /** The realized-PnL book, once the composition root attaches one. */
  #realizedPnl: RealizedPnlBook | undefined;

  constructor(options: { readonly runMode: string; readonly maximumRunMode: string }) {
    this.runMode = options.runMode;
    this.maximumRunMode = options.maximumRunMode;
  }

  countLoop(field: keyof LoopHealth, by = 1): void {
    this.#loop[field] += by;
  }

  countExecution(field: keyof ExecutionHealth, by = 1): void {
    this.#execution[field] += by;
  }

  countAccounting(field: keyof AccountingCounters, by = 1): void {
    this.#accounting[field] += by;
  }

  /**
   * Attaches the book `accounting.realizedPnl` is read from (`TRDR-3`).
   *
   * Called once by the composition root, after `createPaperTrader` returns and
   * before the first event is pumped (`main.ts`, `assembleDurableTrader`). A
   * snapshot taken before this call reports "no snapshot observed"; a second
   * call replaces the book, which no composition does.
   */
  attachRealizedPnl(book: RealizedPnlBook): void {
    this.#realizedPnl = book;
  }

  countRiskApproval(): void {
    this.#risk.evaluations += 1;
    this.#risk.approvals += 1;
  }

  /**
   * Records one risk refusal.
   *
   * `protectiveExit` is the risk-seam caveat's discriminator: the loop passes
   * `true` when the refused intent carried a tag the emitting strategy uses for
   * an exit. The trader does not act on that fact — it does not re-tag, resize
   * or re-submit — it only counts it, so the consequence is visible.
   */
  countRiskRefusal(codes: readonly string[], protectiveExit: boolean): void {
    this.#risk.evaluations += 1;
    this.#risk.refusals += 1;
    if (protectiveExit) this.#risk.refusedExits += 1;
    for (const code of codes) {
      this.#refusalsByCode.set(code, (this.#refusalsByCode.get(code) ?? 0) + 1);
      if (protectiveExit) {
        this.#refusedExitsByCode.set(code, (this.#refusedExitsByCode.get(code) ?? 0) + 1);
      }
    }
  }

  countRecommendations(actions: readonly string[]): void {
    for (const action of actions) {
      this.#recommendationsByAction.set(
        action,
        (this.#recommendationsByAction.get(action) ?? 0) + 1,
      );
    }
  }

  /** Snapshots the whole surface. Pure with respect to the state it reads. */
  snapshot(input: {
    readonly asOf: string;
    readonly halts: readonly HaltRecord[];
    readonly queues: readonly QueueMetrics[];
    /**
     * The seams' own counters, read from the seams by the caller.
     *
     * Passed IN rather than held here, for the same reason `queues` is: these
     * are the live objects' answers at snapshot time, and a copy this class
     * kept would be a second version of a number the seam already owns.
     */
    readonly seams: SeamHealth;
  }): HealthSnapshot {
    return Object.freeze({
      runMode: this.runMode,
      maximumRunMode: this.maximumRunMode,
      healthy: input.halts.length === 0,
      halts: input.halts,
      queues: input.queues,
      loop: Object.freeze({ ...this.#loop }),
      risk: Object.freeze({
        ...this.#risk,
        refusalsByCode: sortedCounts(this.#refusalsByCode),
        refusedExitsByCode: sortedCounts(this.#refusedExitsByCode),
        recommendationsByAction: sortedCounts(this.#recommendationsByAction),
      }),
      execution: Object.freeze({ ...this.#execution }),
      accounting: Object.freeze({
        ...this.#accounting,
        realizedPnl: this.#realizedPnl?.view() ?? NO_REALIZED_PNL,
      }),
      seams: Object.freeze({
        fills: input.seams.fills,
        reservations: input.seams.reservations,
        cancels: input.seams.cancels,
        orderViews: input.seams.orderViews,
        allocator: input.seams.allocator,
        // `TRDR-4`: carried when the caller measured them, and ABSENT — not
        // zeroed — when it did not (see `SeamHealth.orders`).
        ...(input.seams.orders === undefined ? {} : { orders: input.seams.orders }),
        ...(input.seams.retention === undefined ? {} : { retention: input.seams.retention }),
      }),
      riskSeamCaveat: RISK_SEAM_CAVEAT,
      asOf: input.asOf,
    });
  }
}
