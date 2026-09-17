/**
 * The MAPPING from a producer's snapshot to `PLATFORM_METRIC_FAMILIES` samples.
 *
 * Every line here is one dashboard panel's real source. If a family has no line
 * in this file it has no producer, and `metric-families.test.ts` fails: the
 * table and this mapping are asserted to cover each other exactly, so an
 * invented metric with nothing behind it cannot ship.
 *
 * DETERMINISM. Map-valued sections (`refusalsByCode`, `recommendationsByAction`,
 * the allocator's `refusalsByCode`) are emitted in sorted key order, and no
 * function here reads a clock or a global. The same snapshot renders the same
 * bytes, which is what makes a dashboard diff meaningful and what
 * `samples.test.ts` asserts.
 *
 * EXACT DECIMALS (§6 invariant 1). `reservedCollateral` and, since `TRDR-3`,
 * `accounting.realizedPnl` (per instance and the account sum) are decimal
 * STRINGS and are emitted as `_info` labels, never as sample values.
 * `Number(...)` does not appear in this file, and `samples.test.ts` proves the
 * point on a value float64 cannot represent.
 */

import type { MetricSample } from "./exposition.js";
import type {
  ControlPlaneMetricsInput,
  TraderHaltInput,
  TraderHealthReportInput,
} from "./metric-shapes.js";

const bool = (value: boolean): number => (value ? 1 : 0);

function sortedEntries(
  counts: Readonly<Record<string, number>>,
): readonly (readonly [string, number])[] {
  return Object.keys(counts)
    .sort()
    .map((key) => [key, counts[key] ?? 0] as const);
}

/** Own string-valued entries in sorted key order; the values are exact decimals and are never parsed. */
function sortedDecimalEntries(
  values: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function scopeLabels(scope: TraderHaltInput["scope"]): {
  readonly scope: string;
  readonly scope_ref: string;
} {
  switch (scope.kind) {
    case "GLOBAL":
      return { scope: "GLOBAL", scope_ref: "" };
    case "MARKET":
      return { scope: "MARKET", scope_ref: scope.marketId };
    case "STRATEGY_INSTANCE":
      return { scope: "STRATEGY_INSTANCE", scope_ref: scope.instanceId };
  }
}

/**
 * Samples for one trader health report.
 *
 * Reads exactly the five seam sections, `observeOnlyIntents`, the halts and the
 * risk refusal counts `WP-230` handed over — see `docs/handoffs/WP-230.md`
 * follow-up 4 ("the health surface it will read is in place").
 */
export function traderHealthSamples(
  report: TraderHealthReportInput,
): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  const add = (name: string, value: number, labels?: Readonly<Record<string, string>>): void => {
    samples.push(labels === undefined ? { name, value } : { name, value, labels });
  };

  add("trader_run_mode_info", 1, {
    run_mode: report.runMode,
    maximum_run_mode: report.maximumRunMode,
  });

  add("trader_healthy", bool(report.healthy));
  add("trader_halt_count", report.halts.length);
  for (const halt of report.halts) {
    const labels = scopeLabels(halt.scope);
    add("trader_halt_info", 1, {
      scope: labels.scope,
      scope_ref: labels.scope_ref,
      code: halt.code,
      action: halt.action,
    });
  }

  for (const queue of report.queues) {
    const queueLabel = { queue: queue.name };
    add("trader_queue_depth", queue.currentDepth, queueLabel);
    add("trader_queue_max_depth", queue.maximumDepth, queueLabel);
    // `null` is ABSENT, not zero. See the family help.
    if (queue.oldestMessageAgeMs !== null) {
      add("trader_queue_oldest_message_age_ms", queue.oldestMessageAgeMs, queueLabel);
    }
    add("trader_queue_consumer_lag", queue.consumerLag, queueLabel);
    add("trader_queue_producer_blocked_ms_total", queue.producerBlockedMs, queueLabel);
    add("trader_queue_messages_dropped_total", queue.messagesDropped, queueLabel);
    add("trader_queue_accepted_total", queue.accepted, queueLabel);
    add("trader_queue_consumed_total", queue.consumed, queueLabel);
  }

  const loop = report.loop;
  add("trader_events_accepted_total", loop.eventsAccepted);
  add("trader_events_processed_total", loop.eventsProcessed);
  add("trader_events_refused_total", loop.eventsRefused);
  add("trader_feature_snapshots_total", loop.featureSnapshots);
  add("trader_snapshots_unavailable_total", loop.snapshotsUnavailable);
  add("trader_feature_projection_refusals_total", loop.featureProjectionRefusals);
  add("trader_evaluations_total", loop.evaluations);
  add("trader_decisions_persisted_total", loop.decisionsPersisted);
  add("trader_contained_evaluations_total", loop.containedEvaluations);
  add("trader_refused_evaluations_total", loop.refusedEvaluations);
  add("trader_deliveries_suppressed_by_halt_total", loop.deliveriesSuppressedByHalt);

  const risk = report.risk;
  add("trader_risk_evaluations_total", risk.evaluations);
  add("trader_risk_approvals_total", risk.approvals);
  add("trader_risk_refusals_total", risk.refusals);
  for (const [code, count] of sortedEntries(risk.refusalsByCode)) {
    add("trader_risk_refusals_by_code_total", count, { code });
  }
  add("trader_risk_refused_exits_total", risk.refusedExits);
  for (const [code, count] of sortedEntries(risk.refusedExitsByCode)) {
    add("trader_risk_refused_exits_by_code_total", count, { code });
  }
  add("trader_risk_seam_caveat_active", bool(risk.refusedExits > 0));
  for (const [action, count] of sortedEntries(risk.recommendationsByAction)) {
    add("trader_risk_incident_recommendations_total", count, { action });
  }

  const execution = report.execution;
  add("trader_plans_built_total", execution.plansBuilt);
  add("trader_plans_refused_total", execution.plansRefused);
  add("trader_submissions_accepted_total", execution.submissionsAccepted);
  add("trader_submissions_refused_total", execution.submissionsRefused);
  add("trader_fills_observed_total", execution.fillsObserved);
  add("trader_duplicate_fills_refused_total", execution.duplicateFillsRefused);
  add("trader_cancels_requested_total", execution.cancelsRequested);
  add("trader_cancels_confirmed_total", execution.cancelsConfirmed);
  add("trader_cancels_rejected_total", execution.cancelsRejected);
  add("trader_cancels_silence_exceeded_total", execution.cancelsSilenceExceeded);
  add("trader_allocations_refused_total", execution.allocationsRefused);
  add(
    "trader_reservations_released_on_refusal_total",
    execution.reservationsReleasedOnRefusal,
  );
  add("trader_observe_only_intents_total", execution.observeOnlyIntents);

  const accounting = report.accounting;
  add("trader_ledger_transactions_total", accounting.ledgerTransactions);
  add("trader_ledger_refusals_total", accounting.ledgerRefusals);
  add("trader_unattributed_activity_total", accounting.unattributedActivity);
  add("trader_unexplained_movements_total", accounting.unexplainedMovements);
  add("trader_pnl_records_total", accounting.pnlRecords);
  // Realized PnL (`TRDR-3`): EXACT decimals as `_info` labels, one series per
  // instance in sorted order and one for the account sum. `account: null` is
  // "no snapshot observed" and is OMITTED, exactly as an empty queue's age is —
  // a `"0"` here would be a number nobody measured.
  const realizedPnl = accounting.realizedPnl;
  for (const [instanceId, exactDecimal] of sortedDecimalEntries(realizedPnl.byInstance)) {
    add("trader_realized_pnl_info", 1, { instance_id: instanceId, exact_decimal: exactDecimal });
  }
  if (realizedPnl.account !== null) {
    add("trader_account_realized_pnl_info", 1, { exact_decimal: realizedPnl.account });
  }

  const seams = report.seams;
  add("trader_seam_fills_remembered", seams.fills.remembered);
  add("trader_seam_fills_maximum_remembered", seams.fills.maximumRemembered);
  add("trader_seam_fills_admitted_total", seams.fills.admitted);
  add("trader_seam_fills_refused_total", seams.fills.refused);
  add("trader_seam_fills_evictions_total", seams.fills.evictions);

  add("trader_seam_reservations_open", seams.reservations.open);
  add("trader_seam_reservations_taken_total", seams.reservations.taken);
  add("trader_seam_reservations_released_total", seams.reservations.released);
  add("trader_seam_reservations_reserved_collateral_info", 1, {
    exact_decimal: seams.reservations.reservedCollateral,
  });

  add("trader_seam_cancels_pending", seams.cancels.pending);
  add("trader_seam_cancels_requested_total", seams.cancels.requested);
  add("trader_seam_cancels_confirmed_total", seams.cancels.confirmed);
  add("trader_seam_cancels_rejected_total", seams.cancels.rejected);
  add("trader_seam_cancels_silence_exceeded_total", seams.cancels.silenceExceeded);

  add("trader_seam_order_views_emitted_total", seams.orderViews.emitted);
  add("trader_seam_order_views_repeats_total", seams.orderViews.repeats);
  add("trader_seam_order_views_tracked", seams.orderViews.tracked);

  add("trader_seam_allocator_open", seams.allocator.open);
  add("trader_seam_allocator_applied_total", seams.allocator.applied);
  add("trader_seam_allocator_released_total", seams.allocator.released);
  add("trader_seam_allocator_reserved_collateral_info", 1, {
    exact_decimal: seams.allocator.reservedCollateral,
  });
  for (const [code, count] of sortedEntries(seams.allocator.refusalsByCode)) {
    add("trader_seam_allocator_refusals_by_code_total", count, { code });
  }

  return Object.freeze(samples);
}

/** Samples for the control plane's own state. */
export function controlPlaneSamples(
  input: ControlPlaneMetricsInput,
): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  const add = (name: string, value: number, labels?: Readonly<Record<string, string>>): void => {
    samples.push(labels === undefined ? { name, value } : { name, value, labels });
  };

  add("control_run_mode_info", 1, {
    run_mode: input.runMode,
    maximum_run_mode: input.maximumRunMode,
    repository_maximum_run_mode: input.repositoryMaximumRunMode,
  });
  add("control_allow_real_orders", bool(input.allowRealOrders));
  add("control_mode_raise_attempts_refused_total", input.modeRaiseAttemptsRefused);

  add("control_trader_health_available", bool(input.traderHealthAvailable));
  add("control_trader_health_current", bool(input.traderHealthCurrent));
  for (const [outcome, count] of sortedEntries(input.traderHealthReadsByOutcome)) {
    add("control_trader_health_reads_total", count, { outcome });
  }

  for (const [state, count] of sortedEntries(input.strategyInstancesByState)) {
    add("control_strategy_instances", count, { state });
  }
  for (const instanceId of [...input.pausedInstanceIds].sort()) {
    add("control_strategy_paused", 1, { instance_id: instanceId });
  }

  add("control_kill_switches_active", input.killSwitches.length);
  for (const entry of input.killSwitches) {
    add("control_kill_switch_active", 1, {
      scope: entry.scope,
      scope_ref: entry.scopeRef ?? "",
      action: entry.action,
    });
  }

  for (const [reason, count] of sortedEntries(input.authenticationFailuresByReason)) {
    add("control_authentication_failures_total", count, { reason });
  }
  for (const [grant, count] of sortedEntries(input.authorizationFailuresByGrant)) {
    add("control_authorization_failures_total", count, { grant });
  }

  for (const entry of input.mutationsByActionAndOutcome) {
    add("control_mutations_total", entry.count, {
      action: entry.action,
      outcome: entry.outcome,
    });
  }
  add("control_audit_records", input.auditRecords);
  add("control_audit_capacity", input.auditCapacity);
  add("control_audit_append_failures_total", input.auditAppendFailures);

  return Object.freeze(samples);
}
