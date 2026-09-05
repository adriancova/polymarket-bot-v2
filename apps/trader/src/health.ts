/**
 * The trader's health state — the `WP-230` deliverable "bounded queues and
 * health state", shaped by handoff §14.3's metric families.
 *
 * What this module is NOT: a dashboard, an HTTP endpoint or a Prometheus
 * exporter. Those are `WP-240` (control API and paper dashboards) and
 * `packages/observability`. This is the STATE those will read — one value,
 * snapshot-able, deterministic, with no clock of its own.
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
 * `WP-220`'s accepted residual: every exit the static-bracket strategy emits is
 * a `POSITION` intent, and `packages/risk` derives its disposition from the
 * intent TYPE alone, so a protective reduction is classified `ENTRY`. Under the
 * default `economics.requirePositiveNetEdgeForEntries` it is then refused for
 * want of an `expectedNetEdge` — and inside the entry cutoff, and on a
 * `CLOSE_ONLY` market. That is the accepted posture (a refused exit, never a
 * wrong order) until the risk-side follow-up lands, and this process must NOT
 * weaken risk policy, re-tag the intent or bypass the engine to compensate.
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
 */

import type { HaltRecord } from "./halt.js";
import type { QueueMetrics } from "./queue.js";

/**
 * The disclosure that travels with every health snapshot.
 *
 * It is a constant rather than prose in a comment because an operator reading
 * the health surface is exactly the person who needs it, and a caveat that only
 * exists in a README is a caveat nobody reads during an incident.
 */
export const RISK_SEAM_CAVEAT =
  "WP-220 accepted residual: every exit the static-bracket strategy emits is a §7.7 POSITION " +
  "intent, and packages/risk derives the disposition from the intent TYPE alone, so a " +
  "protective reduction is classified ENTRY. Protective reductions are therefore refused " +
  "inside the entry cutoff, on CLOSE_ONLY markets, with the entry-shaped staleness code, and " +
  "— under the default requirePositiveNetEdgeForEntries — for want of expectedNetEdge. This " +
  "is fail-closed (a refused exit, never a wrong order) and is the ACCEPTED posture until the " +
  "risk-side follow-up lands. The trader does not weaken risk policy, re-tag intents or " +
  "bypass the engine to compensate; it counts the refusals here.";

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
}

/** Counters for the §14.3 `accounting` family. */
export interface AccountingHealth {
  readonly ledgerTransactions: number;
  readonly ledgerRefusals: number;
  readonly unattributedActivity: number;
  readonly unexplainedMovements: number;
  readonly pnlRecords: number;
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
  };

  #accounting = {
    ledgerTransactions: 0,
    ledgerRefusals: 0,
    unattributedActivity: 0,
    unexplainedMovements: 0,
    pnlRecords: 0,
  };

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

  countAccounting(field: keyof AccountingHealth, by = 1): void {
    this.#accounting[field] += by;
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
      accounting: Object.freeze({ ...this.#accounting }),
      riskSeamCaveat: RISK_SEAM_CAVEAT,
      asOf: input.asOf,
    });
  }
}
