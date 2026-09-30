/**
 * The INPUT shapes `samples.ts` reads — `WP-140`'s `metric-shapes.ts` pattern,
 * applied to the trader health surface and the control plane.
 *
 * ## Why these are structural mirrors and not imports
 *
 * `packages/observability` is a **layer-1** application module and
 * `docs/contracts/dependency-direction.md` §2 states plainly that **nothing may
 * depend on an app** (F10). The producer of every `trader_*` family here is
 * `apps/trader`'s `HealthSnapshot`, which is layer 3. So this package declares
 * the shape it consumes and the composition root supplies a value of it —
 * exactly what `WP-140` wrote for the recorder:
 *
 * > "Producers hand their exported metric snapshots in; exposition text and
 * > reports come out."
 *
 * The shapes are **structurally assignable from** `apps/trader`'s health types
 * — every field name and type matches — and that assignability is pinned by
 * `test/integration/control-api/trader-health-shape.test.ts`, which is outside
 * every workspace package and may therefore alias both trees. A rename in
 * `apps/trader/src/health.ts` fails that suite instead of silently producing an
 * empty dashboard.
 *
 * ## Optional fields are deliberately absent, not defaulted
 *
 * Nothing here carries a `?` on a counter. A health report that omits a counter
 * is a report this package cannot describe, and the control API's door refuses
 * it (ADR-020 §3: no bare `.default()` on anything safety-relevant). A metric
 * that silently reads 0 for "the producer stopped sending this" is worse than
 * no metric at all.
 */

/** §8.3 queue metrics — mirrors `apps/trader/src/queue.ts` `QueueMetrics`. */
export interface TraderQueueMetricsInput {
  readonly name: string;
  readonly currentDepth: number;
  readonly maximumDepth: number;
  /** `null` when empty: an empty queue has no oldest message, and 0 would lie. */
  readonly oldestMessageAgeMs: number | null;
  readonly messagesDropped: number;
  readonly producerBlockedMs: number;
  readonly consumerLag: number;
  readonly accepted: number;
  readonly consumed: number;
}

/** One latched halt — mirrors `apps/trader/src/halt.ts` `HaltRecord`. */
export interface TraderHaltInput {
  readonly scope:
    | { readonly kind: "GLOBAL" }
    | { readonly kind: "MARKET"; readonly marketId: string }
    | { readonly kind: "STRATEGY_INSTANCE"; readonly instanceId: string };
  readonly code: string;
  readonly detail: string;
  readonly at: string;
  readonly action: string;
}

/** Mirrors `apps/trader/src/health.ts` `LoopHealth`. */
export interface TraderLoopHealthInput {
  readonly eventsAccepted: number;
  readonly eventsProcessed: number;
  readonly eventsRefused: number;
  readonly featureSnapshots: number;
  readonly snapshotsUnavailable: number;
  readonly featureProjectionRefusals: number;
  readonly evaluations: number;
  readonly decisionsPersisted: number;
  readonly containedEvaluations: number;
  readonly refusedEvaluations: number;
  readonly deliveriesSuppressedByHalt: number;
}

/** Mirrors `apps/trader/src/health.ts` `RiskHealth`. */
export interface TraderRiskHealthInput {
  readonly evaluations: number;
  readonly approvals: number;
  readonly refusals: number;
  readonly refusalsByCode: Readonly<Record<string, number>>;
  readonly refusedExits: number;
  readonly refusedExitsByCode: Readonly<Record<string, number>>;
  readonly recommendationsByAction: Readonly<Record<string, number>>;
}

/** Mirrors `apps/trader/src/health.ts` `ExecutionHealth`. */
export interface TraderExecutionHealthInput {
  readonly plansBuilt: number;
  readonly plansRefused: number;
  readonly submissionsAccepted: number;
  readonly submissionsRefused: number;
  readonly fillsObserved: number;
  readonly duplicateFillsRefused: number;
  readonly cancelsRequested: number;
  readonly cancelsConfirmed: number;
  readonly cancelsRejected: number;
  readonly cancelsSilenceExceeded: number;
  readonly allocationsRefused: number;
  readonly reservationsReleasedOnRefusal: number;
  readonly observeOnlyIntents: number;
}

/**
 * Mirrors `apps/trader/src/health.ts` `RealizedPnlHealth` (`TRDR-3`).
 *
 * EXACT decimal strings (§6 invariant 1): the PnL engine's own
 * `PnlSnapshot.realizedPnl` per instance and their exact sum. Never parsed to
 * a number here; `samples.ts` carries each as an `_info` label. `account` is
 * `null` while the trader has observed no snapshot — an absent measurement,
 * which the samples then OMIT rather than render as `"0"`.
 */
export interface TraderRealizedPnlInput {
  readonly byInstance: Readonly<Record<string, string>>;
  readonly account: string | null;
}

/** Mirrors `apps/trader/src/health.ts` `AccountingHealth`. */
export interface TraderAccountingHealthInput {
  readonly ledgerTransactions: number;
  readonly ledgerRefusals: number;
  readonly unattributedActivity: number;
  readonly unexplainedMovements: number;
  readonly pnlRecords: number;
  readonly realizedPnl: TraderRealizedPnlInput;
}

/** Mirrors `apps/trader/src/health.ts` `SeamHealth`. */
export interface TraderSeamHealthInput {
  readonly fills: {
    readonly remembered: number;
    readonly maximumRemembered: number;
    readonly admitted: number;
    readonly refused: number;
    readonly evictions: number;
  };
  readonly reservations: {
    readonly open: number;
    readonly taken: number;
    readonly released: number;
    /** EXACT decimal string. Never parsed to a float here (§6 invariant 1). */
    readonly reservedCollateral: string;
  };
  readonly cancels: {
    readonly pending: number;
    readonly requested: number;
    readonly confirmed: number;
    readonly rejected: number;
    readonly silenceExceeded: number;
  };
  readonly orderViews: {
    readonly emitted: number;
    readonly repeats: number;
    readonly tracked: number;
  };
  readonly allocator: {
    readonly open: number;
    readonly applied: number;
    readonly released: number;
    /** EXACT decimal string. Never parsed to a float here (§6 invariant 1). */
    readonly reservedCollateral: string;
    readonly refusalsByCode: Readonly<Record<string, number>>;
  };
}

/**
 * `THROUGHPUT-1a`: mirrors `packages/trading-core/src/health.ts`
 * `TransportHealth` — the input STREAM's lag as the trader samples it. Every
 * measured field is `null` while the trader has no measurement (no sampler
 * attached, no sample yet, no event yet), and `samples.ts` then OMITS its
 * sample rather than render a zero nobody measured.
 */
export interface TraderTransportHealthInput {
  readonly attached: boolean;
  readonly sampleIntervalMs: number | null;
  readonly samples: number;
  readonly sampleFailures: number;
  readonly sampledAt: string | null;
  readonly sampleAgeMs: number | null;
  readonly headPosition: number | null;
  readonly consumerPosition: number | null;
  readonly committedPosition: number | null;
  readonly entriesBehindHead: number | null;
  readonly retentionMaxEvents: number | null;
  readonly lastEventAt: string | null;
  readonly eventTimeLagMs: number | null;
}

/**
 * A trader health report — the whole surface `WP-230` shipped.
 *
 * Structurally assignable from `apps/trader`'s `HealthSnapshot`. The
 * `riskSeamCaveat` field is carried because it travels with the snapshot by
 * design ("a caveat that only exists in a README is a caveat nobody reads
 * during an incident"), and the control API returns it verbatim on its read
 * surface.
 */
export interface TraderHealthReportInput {
  readonly runMode: string;
  readonly maximumRunMode: string;
  readonly healthy: boolean;
  readonly halts: readonly TraderHaltInput[];
  readonly queues: readonly TraderQueueMetricsInput[];
  readonly loop: TraderLoopHealthInput;
  readonly risk: TraderRiskHealthInput;
  readonly execution: TraderExecutionHealthInput;
  readonly accounting: TraderAccountingHealthInput;
  readonly seams: TraderSeamHealthInput;
  /** `THROUGHPUT-1a`: the input stream's lag. */
  readonly transport: TraderTransportHealthInput;
  readonly riskSeamCaveat: string;
  readonly asOf: string;
}

/** The control plane's own counters, for the `control_*` families. */
export interface ControlPlaneMetricsInput {
  readonly runMode: string;
  readonly maximumRunMode: string;
  readonly repositoryMaximumRunMode: string;
  /** Structurally false. There is no request that can set it. */
  readonly allowRealOrders: boolean;
  readonly modeRaiseAttemptsRefused: number;
  /** The control API HOLDS a report that passed its door (possibly retained from an earlier read). */
  readonly traderHealthAvailable: boolean;
  /**
   * The MOST RECENT read of the source passed the door (`TRDR-3`). `false`
   * with `traderHealthAvailable: true` is the stale-report state: the last
   * good report is retained and the last read failed.
   */
  readonly traderHealthCurrent: boolean;
  readonly traderHealthReadsByOutcome: Readonly<Record<string, number>>;
  readonly strategyInstancesByState: Readonly<Record<string, number>>;
  readonly pausedInstanceIds: readonly string[];
  readonly killSwitches: readonly {
    readonly scope: string;
    readonly scopeRef: string | null;
    readonly action: string;
  }[];
  readonly authenticationFailuresByReason: Readonly<Record<string, number>>;
  readonly authorizationFailuresByGrant: Readonly<Record<string, number>>;
  readonly mutationsByActionAndOutcome: readonly {
    readonly action: string;
    readonly outcome: string;
    readonly count: number;
  }[];
  readonly auditRecords: number;
  readonly auditCapacity: number;
  readonly auditAppendFailures: number;
}
