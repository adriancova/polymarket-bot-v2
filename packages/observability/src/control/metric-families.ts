/**
 * The canonical PLATFORM metric-family table (`WP-240`) — handoff §14.3.
 *
 * Single source of truth for every metric the control API can expose. The
 * renderer in `exposition.ts` refuses to emit a sample whose family is not
 * listed here, and `dashboards.test.ts` asserts that every `trader_*` /
 * `control_*` series bound by a Grafana panel is a family in this table **and**
 * that every family in this table appears on at least one dashboard — both
 * directions, so a metric with no panel and a panel with no metric each fail.
 *
 * ## Relationship to `RECORDER_METRIC_FAMILIES` (`WP-140`)
 *
 * That table owns the `recorder_*` families the data-gateway recorder emits.
 * This one owns the `trader_*` and `control_*` families. They are separate
 * tables with separate producers and separate exporters; the fidelity dashboard
 * binds panels from BOTH, which is why `dashboards.test.ts` validates a series
 * against whichever table its prefix names, and refuses a series that matches
 * neither.
 *
 * ## Naming
 *
 * Prometheus conventions — `snake_case`, unit suffixes (`_ms`), monotonic
 * counters end in `_total`. `trader_` is the §4.1 trader process's surface;
 * `control_` is this API's own state.
 *
 * ## ECONOMIC VALUES ARE NOT SAMPLE VALUES (§6 invariant 1)
 *
 * A Prometheus sample value is a float64. Prices, sizes, balances, fees and PnL
 * are exact decimals whose string form is the boundary representation, and
 * parsing one into a float to chart it is precisely the binary-floating-point
 * economics invariant 1 forbids — silently, and on the surface an operator
 * trusts.
 *
 * So no family here takes an economic value. Where an exact decimal must be
 * VISIBLE, it is carried as a LABEL on an `_info` gauge whose value is the
 * constant `1` (`trader_seam_reservations_reserved_collateral_info{exact_decimal="12.50"} 1`),
 * which is the Prometheus idiom for a string-valued fact. The label is never
 * parsed; the dashboards display it and do not do arithmetic on it, and the
 * exact string is additionally available on the control API's JSON read
 * surface, which is where an operator who needs the number should read it.
 */

export type PlatformMetricType = "gauge" | "counter";

/**
 * Signal categories, one per §14.3 family this table can actually source.
 *
 * `run-mode`, `control-plane` and `audit` are `WP-240`'s own additions: §14.3
 * enumerates what the TRADING platform must measure and says nothing about the
 * control plane, but an operator surface that cannot report whether its own
 * audit log is accepting writes is a surface that can fail silently.
 */
export type PlatformMetricCategory =
  | "run-mode"
  | "halts"
  | "queues"
  | "loop"
  | "risk"
  | "execution"
  | "accounting"
  | "seams"
  | "control-plane"
  | "audit";

export interface PlatformMetricFamily {
  readonly name: string;
  readonly type: PlatformMetricType;
  readonly category: PlatformMetricCategory;
  readonly help: string;
  /** Label keys this family may carry; the renderer refuses others. */
  readonly labels?: readonly string[];
  /**
   * `true` when the family's value is the constant `1` and the FACT is in the
   * labels — an exact decimal, a run-mode name, a halt reason.
   *
   * Recorded in the table rather than inferred from the `_info` suffix so the
   * dashboard suite can require that no panel does arithmetic on one.
   */
  readonly infoOnly?: true;
}

const family = (
  name: string,
  type: PlatformMetricType,
  category: PlatformMetricCategory,
  help: string,
  labels?: readonly string[],
  infoOnly?: true,
): PlatformMetricFamily => {
  const base = { name, type, category, help };
  if (labels === undefined) return base;
  return infoOnly === undefined ? { ...base, labels } : { ...base, labels, infoOnly };
};

/**
 * Every family the control API can expose. Order here is render order.
 *
 * Each `trader_*` family names exactly one field of the trader's health
 * surface (`apps/trader/src/health.ts`, the five seam sections plus
 * `observeOnlyIntents`, `halts`, the risk refusal counts and
 * `riskSeamCaveat`). `samples.ts` is the mapping and
 * `test/integration/control-api/trader-health-shape.test.ts` pins it against a
 * snapshot produced by the REAL `HealthState`.
 */
export const PLATFORM_METRIC_FAMILIES: readonly PlatformMetricFamily[] = [
  // --- run mode and the ceiling (§11, acceptance 1) --------------------------
  family(
    "control_run_mode_info",
    "gauge",
    "run-mode",
    "The control API's own run mode, its process maximum, and the repository ceiling. Value is always 1; the facts are the labels.",
    ["run_mode", "maximum_run_mode", "repository_maximum_run_mode"],
    true,
  ),
  family(
    "control_allow_real_orders",
    "gauge",
    "run-mode",
    "1 if this process would permit a real order. Structurally 0: the control API has no venue connection, no signer, and no request that can set this.",
  ),
  family(
    "control_mode_raise_attempts_refused_total",
    "counter",
    "run-mode",
    "Authenticated requests refused because they attempted to raise a run mode, enable real orders, raise a live-micro cap, or reference a signer. Any increase is an operator or client trying something the API refuses by name; every one is audited.",
  ),
  family(
    "trader_run_mode_info",
    "gauge",
    "run-mode",
    "The reported trader's run mode and process maximum. Value is always 1; the facts are the labels.",
    ["run_mode", "maximum_run_mode"],
    true,
  ),

  // --- halts (§14.1, §9.9) --------------------------------------------------
  family(
    "trader_healthy",
    "gauge",
    "halts",
    "1 when the reported trader has no latched halt at any scope.",
  ),
  family(
    "trader_halt_count",
    "gauge",
    "halts",
    "Number of latched halts on the reported trader, all scopes.",
  ),
  family(
    "trader_halt_info",
    "gauge",
    "halts",
    "One series per latched halt. Value is always 1; the scope, reason code and §9.9 action are the labels.",
    ["scope", "scope_ref", "code", "action"],
    true,
  ),
  // `CONTROL-2` (closing `H1R1-HALT-INVISIBLE`): the OPEN trader halts in
  // `ops.incidents`, which outlive a trader that halted and exited. The
  // control API reads them (`apps/control-api/src/trader-halts.ts` is the
  // producer; this package may not import an app, so
  // `metric-families.test.ts` names it), and
  // `infra/prometheus/trader-alerts.yaml`'s `TraderHaltOpenOrUnknown` pages on
  // OPEN and on UNKNOWN.
  family(
    "control_trader_halts_state",
    "gauge",
    "halts",
    "What this process knows of open trader halts in ops.incidents: 1 for the current state, 0 for the others. OPEN = the most recent read counted at least one open TRADER_HALT row; NONE_OPEN = it counted none; UNKNOWN = no read yet, or the read failed, timed out or was refused (never 'no halts'); NOT_CONFIGURED = this process reads no ops.incidents.",
    ["state"],
  ),
  family(
    "control_trader_halts_open",
    "gauge",
    "halts",
    "Open (not RESOLVED) TRADER_HALT rows in ops.incidents by scope, from the most recent read. Present ONLY when that read succeeded: absent, never 0, while the state is UNKNOWN or NOT_CONFIGURED. UNRECOGNIZED counts every other key in the TRADER_HALT: namespace.",
    ["scope"],
  ),
  family(
    "control_trader_halt_reads_total",
    "counter",
    "halts",
    "Reads of ops.incidents for open trader halts, by outcome: OK (passed the door), REFUSED (the door refused the result), UNAVAILABLE (the read failed or timed out).",
    ["outcome"],
  ),

  // --- §8.3 bounded queues --------------------------------------------------
  family("trader_queue_depth", "gauge", "queues", "Current depth of a trader queue.", ["queue"]),
  family("trader_queue_max_depth", "gauge", "queues", "Configured bound of a trader queue.", [
    "queue",
  ]),
  family(
    "trader_queue_oldest_message_age_ms",
    "gauge",
    "queues",
    "Age of the oldest queued message in milliseconds. Omitted (not zero) when the queue is empty: an empty queue has no oldest message.",
    ["queue"],
  ),
  family(
    "trader_queue_consumer_lag",
    "gauge",
    "queues",
    "Accepted minus consumed: how far the consumer trails the producer.",
    ["queue"],
  ),
  family(
    "trader_queue_producer_blocked_ms_total",
    "counter",
    "queues",
    "Cumulative milliseconds a producer was refused because the queue was full (§8.3 backpressure).",
    ["queue"],
  ),
  family(
    "trader_queue_messages_dropped_total",
    "counter",
    "queues",
    "Messages a trader queue dropped. Must stay 0 — the trader's queues refuse at the bound and never drop; any increase is a contract break.",
    ["queue"],
  ),
  family("trader_queue_accepted_total", "counter", "queues", "Messages accepted by a queue.", [
    "queue",
  ]),
  family("trader_queue_consumed_total", "counter", "queues", "Messages consumed from a queue.", [
    "queue",
  ]),

  // --- THROUGHPUT-1a: the input STREAM, not the ingest queue ------------------
  // `trader_queue_consumer_lag` is the in-process ingest queue, which a pump
  // that drains every batch keeps at 0 however far behind the stream the trader
  // is (H1 run 1 read 0 while three minutes behind). These are the stream side,
  // from the trader's `transport` section. Each is OMITTED (not zero) while the
  // trader has no measurement: no sampler attached, no sample yet, no event yet.
  family(
    "trader_transport_lag_entries",
    "gauge",
    "queues",
    "Events published to the trader's input stream and not yet delivered to it: the stream head minus this consumer's position, at the trader's latest transport sample. At the stream's retention bound (the data gateway's GATEWAY_RETENTION_EVENTS), retention starts removing unread events and the trader halts TRANSPORT_RESYNC_REQUIRED (ADR-003 §3.3). Omitted (not zero) before the first sample.",
  ),
  // `trader_transport_retention_max_events` was dropped by C1-RISK (OPS-07,
  // 2026-10-08): it reported the trader's own retention setting, which trimmed
  // nothing (the trader only consumes) and could differ from the stream's real
  // bound, the data gateway's.
  family(
    "trader_transport_sample_age_seconds",
    "gauge",
    "queues",
    "Seconds since the trader's latest transport sample, when the health report was built. The sampler reads every second; a growing age means the stream positions above are stale. Omitted before the first sample.",
  ),
  family(
    "trader_event_time_lag_seconds",
    "gauge",
    "queues",
    "Wall clock minus the recorded receivedAt of the last event the trader processed, in seconds, when the health report was built: how far behind the market the trader's decisions are. Omitted before the first event, or with no transport sampler attached.",
  ),

  // --- the core loop --------------------------------------------------------
  family("trader_events_accepted_total", "counter", "loop", "Events the loop accepted."),
  family("trader_events_processed_total", "counter", "loop", "Events the loop processed."),
  family(
    "trader_events_refused_total",
    "counter",
    "loop",
    "Events the wire door refused, or whose instant could not be normalised.",
  ),
  family("trader_feature_snapshots_total", "counter", "loop", "Feature snapshots computed."),
  family(
    "trader_snapshots_unavailable_total",
    "counter",
    "loop",
    "Evaluations skipped because no feature snapshot could be computed. Ordinary early-run state, counted separately from refused events on purpose.",
  ),
  family(
    "trader_feature_projection_refusals_total",
    "counter",
    "loop",
    "Feature keys the projection could not produce.",
  ),
  family("trader_evaluations_total", "counter", "loop", "Strategy evaluations run."),
  family(
    "trader_decisions_persisted_total",
    "counter",
    "loop",
    "DecisionResults persisted (§6 invariant 3: exactly one per callback).",
  ),
  family(
    "trader_contained_evaluations_total",
    "counter",
    "loop",
    "ADR-005 §3 containments: the runtime paused an instance.",
  ),
  family("trader_refused_evaluations_total", "counter", "loop", "Evaluations the runtime refused."),
  family(
    "trader_deliveries_suppressed_by_halt_total",
    "counter",
    "loop",
    "Fill and order-view deliveries the §4.2 halt gate withheld from a strategy. The accounting still happened; the halted scope was not allowed to decide on it.",
  ),
  family(
    "trader_evaluations_coalesced_total",
    "counter",
    "loop",
    "ADR-026 D5.6: one per owed market at each frame close where the evaluation cadence (at most one onFeatures evaluation per market per 1 s of event time) did not evaluate it. A coalesced market is not evaluated, so no decision is owed; it stays owed to a later close.",
  ),
  family(
    "trader_cadence_forward_jump_alarms_total",
    "counter",
    "loop",
    "ADR-026 D2.10: applied events whose instant lay more than the alarm bound (5 s) behind the evaluation cadence's event clock. While it rises a far-future stamp is holding every onFeatures evaluation, a stop decided there included; it pages.",
  ),

  // --- §9.8 risk ------------------------------------------------------------
  family("trader_risk_evaluations_total", "counter", "risk", "Risk-engine evaluations."),
  family("trader_risk_approvals_total", "counter", "risk", "Intents the risk engine approved."),
  family("trader_risk_refusals_total", "counter", "risk", "Intents the risk engine refused."),
  family(
    "trader_risk_refusals_by_code_total",
    "counter",
    "risk",
    "Risk refusals per packages/risk reason code (§14.3 risk: vetoes by reason).",
    ["code"],
  ),
  family(
    "trader_risk_refused_exits_total",
    "counter",
    "risk",
    "Refusals of intents the emitting strategy tagged protective — the WP-220 risk-seam residual, counted.",
  ),
  family(
    "trader_risk_refused_exits_by_code_total",
    "counter",
    "risk",
    "Refused protective exits per reason code. This is the risk-seam caveat's own breakdown: read it with the caveat text on the trading dashboard.",
    ["code"],
  ),
  family(
    "trader_risk_seam_caveat_active",
    "gauge",
    "risk",
    "1 when at least one protective exit has been refused, so the WP-220 risk-seam residual is currently affecting this run rather than merely documented.",
  ),
  family(
    "trader_risk_incident_recommendations_total",
    "counter",
    "risk",
    "§9.9 incident actions the risk engine recommended, per action. A recommendation is not an action.",
    ["action"],
  ),

  // --- §9.10 / §9.11 execution ----------------------------------------------
  family("trader_plans_built_total", "counter", "execution", "Execution plans built."),
  family("trader_plans_refused_total", "counter", "execution", "Execution plans refused."),
  family(
    "trader_submissions_accepted_total",
    "counter",
    "execution",
    "Submissions the (simulated) venue accepted.",
  ),
  family(
    "trader_submissions_refused_total",
    "counter",
    "execution",
    "Submissions the (simulated) venue refused.",
  ),
  family(
    "trader_fills_observed_total",
    "counter",
    "execution",
    "Fills the process observed, after deduplication. §6 invariant 10 makes partial fills first class, so this counts fill EVENTS, not filled orders.",
  ),
  family(
    "trader_duplicate_fills_refused_total",
    "counter",
    "execution",
    "Fill redeliveries the dedup seam refused (at-most-once).",
  ),
  family(
    "trader_cancels_requested_total",
    "counter",
    "execution",
    "Cancels the process requested from the (simulated) venue. §6 invariant 13: safety cancellation outranks new order placement.",
  ),
  family(
    "trader_cancels_confirmed_total",
    "counter",
    "execution",
    "Cancels the (simulated) venue confirmed. A confirmation is a terminal fact.",
  ),
  family(
    "trader_cancels_rejected_total",
    "counter",
    "execution",
    "Cancels the (simulated) venue rejected. Also terminal — unlike silence, which is counted separately.",
  ),
  family(
    "trader_cancels_silence_exceeded_total",
    "counter",
    "execution",
    "Cancels closed by submission_unknown_after_ms (§6 invariant 6). Never treated as rejection.",
  ),
  family(
    "trader_allocations_refused_total",
    "counter",
    "execution",
    "Plans the §9.7 allocator refused to reserve capital for. Nothing was offered to the venue.",
  ),
  family(
    "trader_reservations_released_on_refusal_total",
    "counter",
    "execution",
    "Reservations returned because the venue refused the submission.",
  ),
  family(
    "trader_observe_only_intents_total",
    "counter",
    "execution",
    "Intents a NON-OWNER (shadow) instance emitted, which were never routed (§6 invariant 11, ADR-011 §5). A shadow instance submits nothing.",
  ),

  // --- §9.15 / §9.16 accounting ---------------------------------------------
  family(
    "trader_ledger_transactions_total",
    "counter",
    "accounting",
    "Ledger transactions appended.",
  ),
  family(
    "trader_ledger_refusals_total",
    "counter",
    "accounting",
    "Postings the ledger refused. Any increase means an accounting record is incomplete.",
  ),
  family(
    "trader_unattributed_activity_total",
    "counter",
    "accounting",
    "§6 invariant 7 arrivals: actual activity with no strategy attribution. Halts the affected market.",
  ),
  family(
    "trader_unexplained_movements_total",
    "counter",
    "accounting",
    "Actual movements no appended transaction explains.",
  ),
  family("trader_pnl_records_total", "counter", "accounting", "PnL records produced."),
  family(
    "trader_realized_pnl_info",
    "gauge",
    "accounting",
    "Realized PnL of one strategy instance, as the latest PnL snapshot the durable store accepted states it (packages/pnl's own value). Value is always 1; the EXACT decimal is the exact_decimal label and is never parsed to a float (§6 invariant 1). Absent until the instance's first snapshot.",
    ["instance_id", "exact_decimal"],
    true,
  ),
  family(
    "trader_account_realized_pnl_info",
    "gauge",
    "accounting",
    "Realized PnL summed exactly over every instance above (@polymarket-bot/decimal, never float64). Value is always 1; read the exact_decimal label. Absent while the trader has observed no PnL snapshot — an absent measurement is not a zero.",
    ["exact_decimal"],
    true,
  ),

  // --- the composition-root seams -------------------------------------------
  family(
    "trader_seam_fills_remembered",
    "gauge",
    "seams",
    "Fill ids the at-most-once gate currently remembers.",
  ),
  family(
    "trader_seam_fills_maximum_remembered",
    "gauge",
    "seams",
    "Bound on remembered fill ids.",
  ),
  family("trader_seam_fills_admitted_total", "counter", "seams", "Fills the dedup seam admitted."),
  family(
    "trader_seam_fills_refused_total",
    "counter",
    "seams",
    "Fills the dedup seam refused as redeliveries.",
  ),
  family(
    "trader_seam_fills_evictions_total",
    "counter",
    "seams",
    "Fill ids forgotten because the bound was reached. Non-zero means at-most-once can no longer be proven for the whole run.",
  ),
  family(
    "trader_seam_reservations_open",
    "gauge",
    "seams",
    "Inventory reservations currently open (WP-220 obligation 9).",
  ),
  family(
    "trader_seam_reservations_taken_total",
    "counter",
    "seams",
    "Inventory reservations taken against the collateral book.",
  ),
  family("trader_seam_reservations_released_total", "counter", "seams", "Reservations released."),
  family(
    "trader_seam_reservations_reserved_collateral_info",
    "gauge",
    "seams",
    "Reserved collateral as an EXACT decimal string in the label. Value is always 1 — this is never a float (§6 invariant 1).",
    ["exact_decimal"],
    true,
  ),
  family("trader_seam_cancels_pending", "gauge", "seams", "Cancels awaiting a terminal fact."),
  family("trader_seam_cancels_requested_total", "counter", "seams", "Cancels requested at the seam."),
  family("trader_seam_cancels_confirmed_total", "counter", "seams", "Cancels confirmed at the seam."),
  family("trader_seam_cancels_rejected_total", "counter", "seams", "Cancels rejected at the seam."),
  family(
    "trader_seam_cancels_silence_exceeded_total",
    "counter",
    "seams",
    "Cancels whose silence bound elapsed at the seam.",
  ),
  family("trader_seam_order_views_emitted_total", "counter", "seams", "Order views delivered."),
  family(
    "trader_seam_order_views_repeats_total",
    "counter",
    "seams",
    "Order views delivered again and LABELLED as repeats (never dropped).",
  ),
  family("trader_seam_order_views_tracked", "gauge", "seams", "Orders the view tracker holds."),
  family(
    "trader_seam_allocator_open",
    "gauge",
    "seams",
    "§9.7 allocator reservations currently applied (pre-submission).",
  ),
  family("trader_seam_allocator_applied_total", "counter", "seams", "Allocator reservations applied."),
  family(
    "trader_seam_allocator_released_total",
    "counter",
    "seams",
    "Allocator reservations released.",
  ),
  family(
    "trader_seam_allocator_reserved_collateral_info",
    "gauge",
    "seams",
    "Allocator-reserved pUSD as an EXACT decimal string in the label. Value is always 1 (§6 invariant 1).",
    ["exact_decimal"],
    true,
  ),
  family(
    "trader_seam_allocator_refusals_by_code_total",
    "counter",
    "seams",
    "Allocator refusals by the allocator's own code (§9.8 checks 14 and 15).",
    ["code"],
  ),

  // --- the control plane itself ---------------------------------------------
  family(
    "control_trader_health_available",
    "gauge",
    "control-plane",
    "1 when the control API currently holds a trader health report that passed its door. 0 means the trader panels below are stale or empty — read this first.",
  ),
  family(
    "control_trader_health_current",
    "gauge",
    "control-plane",
    "1 when the MOST RECENT read of the trader health source passed the door, so the trader panels show the trader's latest answer. 0 with control_trader_health_available 1 means the held report is RETAINED from an earlier read and the source has since failed — the trader panels are stale; the report's asOf says how stale.",
  ),
  family(
    "control_trader_health_reads_total",
    "counter",
    "control-plane",
    "Attempts to read a trader health report, by outcome.",
    ["outcome"],
  ),
  family(
    "control_strategy_instances",
    "gauge",
    "control-plane",
    "Strategy instances the control plane knows, by run state.",
    ["state"],
  ),
  family(
    "control_strategy_paused",
    "gauge",
    "control-plane",
    "1 when an operator has paused this strategy instance through the control API.",
    ["instance_id"],
  ),
  family(
    "control_kill_switches_active",
    "gauge",
    "control-plane",
    "Number of latched kill switches, all §14.1 scopes.",
  ),
  family(
    "control_kill_switch_active",
    "gauge",
    "control-plane",
    "One series per latched kill switch. Value is always 1; the §14.1 scope and action are the labels.",
    ["scope", "scope_ref", "action"],
    true,
  ),
  family(
    "control_authentication_failures_total",
    "counter",
    "control-plane",
    "Requests refused before reaching the control plane, by reason. An unauthenticated request writes no audit record — it never reached the surface that audits — so this counter is where it becomes visible.",
    ["reason"],
  ),
  family(
    "control_authorization_failures_total",
    "counter",
    "control-plane",
    "Authenticated requests refused for want of an explicit grant (§15), by the grant they lacked.",
    ["grant"],
  ),

  // --- the audit log (acceptance 2) -----------------------------------------
  family(
    "control_mutations_total",
    "counter",
    "audit",
    "Control-plane mutation attempts, by action and outcome. APPLIED and REFUSED are both audited. NOT_AUDITED is a mutation the audit sink would not record, and therefore one that did NOT happen — it is counted under its own outcome so this series never reports a change as applied that the control plane refused to apply.",
    ["action", "outcome"],
  ),
  family(
    "control_audit_records",
    "gauge",
    "audit",
    "Records currently held by the audit sink.",
  ),
  family(
    "control_audit_capacity",
    "gauge",
    "audit",
    "Bound on the audit sink. Reaching it REFUSES further mutations rather than dropping records.",
  ),
  family(
    "control_audit_append_failures_total",
    "counter",
    "audit",
    "Audit appends that failed. Each one is a mutation that did NOT happen — the control plane audits first and applies only on success.",
  ),
];

const BY_NAME: ReadonlyMap<string, PlatformMetricFamily> = new Map(
  PLATFORM_METRIC_FAMILIES.map((entry) => [entry.name, entry]),
);

/** The family with this name, or `undefined`. */
export function platformMetricFamily(name: string): PlatformMetricFamily | undefined {
  return BY_NAME.get(name);
}

/** Every declared family name, in table order. */
export function platformMetricNames(): readonly string[] {
  return PLATFORM_METRIC_FAMILIES.map((entry) => entry.name);
}

/** Every declared family name in one category, in table order. */
export function platformMetricNamesByCategory(
  category: PlatformMetricCategory,
): readonly string[] {
  return PLATFORM_METRIC_FAMILIES.filter((entry) => entry.category === category).map(
    (entry) => entry.name,
  );
}
