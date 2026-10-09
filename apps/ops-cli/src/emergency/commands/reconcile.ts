/**
 * reconcile: WP-290's `ReconciliationCoordinator`, run once over venue truth,
 * READ-ONLY (WP-290's obligation on WP-330: it "never resumes a trader or
 * releases a quarantine").
 *
 * The coordinator is the real one, over its read ports (`AccountReadPort`,
 * each read granted by WP-310's budget first). Everything it could WRITE is
 * bound to a port that records and refuses:
 *
 * | Port | Bound to | Effect |
 * | --- | --- | --- |
 * | `ReconciledOms` | {@link ReadOnlyOmsView}: no tracked orders, no attempts (this CLI holds no trader memory) | `resume()` is refused (`OMS_RESUME_BLOCKED`); every write is refused and counted |
 * | journal | a `ReconciliationJournal` over an in-memory sink, opened empty | nothing reaches the trader's journal or `ops.reconciliation_*` |
 * | holdings | the durable ledger projection, read only, when one is configured | `bookUnattributed` is refused and counted |
 *
 * `releaseQuarantine` is never called. Because the view holds no trader
 * memory, every order the venue lists is UNATTRIBUTED by construction: this
 * is an independent second opinion of venue truth against the durable
 * projection, not the trader's own reconciliation (which its composition runs).
 */

import { ReconciliationJournal, type ReconciliationJournalEvent } from "@polymarket-bot/ledger";
import {
  ReconciliationCoordinator,
  type AttemptView,
  type HoldingsPort,
  type OmsAlert,
  type OmsRefusalCode,
  type OmsResult,
  type OrderView,
  type ReconciledOms,
  type RetainedEvidenceView,
} from "@polymarket-bot/oms";

import type { AuditValue } from "../audit-log.js";
import { READ_PRIORITY } from "../budget.js";
import { auditText, MAX_AUDITED_IDS, type CommandContext, type CommandResult } from "../context.js";
import type { ProjectionSource } from "../ports.js";
import { SECTIONS } from "../printer.js";
import type { VenueSession } from "../session.js";

const EMPTY: readonly never[] = Object.freeze([]);

/** The longest break text (`<break class> <subject key>`) an OUTCOME record holds; the record is bounded by construction (WP330-V1-01). */
export const MAX_AUDITED_BREAK_LENGTH = 300;

function refusal<T>(code: OmsRefusalCode, message: string): OmsResult<T> {
  return Object.freeze({ ok: false as const, refusal: Object.freeze({ code, message, details: Object.freeze({}) }) });
}

/**
 * The OMS as this CLI sees it: none. No order, no attempt, no alert, no
 * evidence; paused for good. It refuses every write, and `resume()`, so a run
 * that passes resumes nothing. Each refused call is counted for the report.
 */
export class ReadOnlyOmsView implements ReconciledOms {
  readonly paused = true;
  readonly faulted = false;
  readonly refusedWrites: string[] = [];
  resumeRefusals = 0;

  pause(): void {
    // Already paused, for good.
  }

  resume(): OmsResult<true> {
    this.resumeRefusals += 1;
    return refusal("OMS_RESUME_BLOCKED", "ops-cli reconcile is read-only: it resumes nothing");
  }

  attempts(): readonly AttemptView[] {
    return EMPTY;
  }

  orders(): readonly OrderView[] {
    return EMPTY;
  }

  alerts(): readonly OmsAlert[] {
    return EMPTY;
  }

  retainedEvidence(): readonly RetainedEvidenceView[] {
    return EMPTY;
  }

  outstandingReconciliations(): number {
    return 0;
  }

  retryReconciliationRequests(): Promise<OmsResult<number>> {
    return Promise.resolve(Object.freeze({ ok: true as const, value: 0 }));
  }

  applyReconciliation(): Promise<OmsResult<AttemptView>> {
    this.refusedWrites.push("applyReconciliation");
    return Promise.resolve(refusal("OMS_UNKNOWN_ATTEMPT", "ops-cli reconcile holds no attempt"));
  }

  applyOrderObservation(): Promise<OmsResult<OrderView>> {
    this.refusedWrites.push("applyOrderObservation");
    return Promise.resolve(refusal("OMS_UNKNOWN_VENUE_ORDER", "ops-cli reconcile holds no order"));
  }

  recordFill(): Promise<OmsResult<OrderView>> {
    this.refusedWrites.push("recordFill");
    return Promise.resolve(refusal("OMS_UNKNOWN_ORDER", "ops-cli reconcile holds no order"));
  }

  applySettlement(): Promise<OmsResult<unknown>> {
    this.refusedWrites.push("applySettlement");
    return Promise.resolve(refusal("OMS_UNKNOWN_FILL", "ops-cli reconcile holds no fill"));
  }

  requestOrderReconciliation(): Promise<OmsResult<OrderView>> {
    this.refusedWrites.push("requestOrderReconciliation");
    return Promise.resolve(refusal("OMS_UNKNOWN_ORDER", "ops-cli reconcile holds no order"));
  }
}

/** The holdings port: reads from the durable projection when configured; books nothing. */
export function readOnlyHoldings(source: ProjectionSource | null, refusedBookings: string[]): HoldingsPort {
  return Object.freeze({
    projected: (): Promise<unknown> => (source === null ? Promise.reject(new Error("no ledger projection is configured")) : source.projected()),
    remainingBookings: (fills: Parameters<HoldingsPort["remainingBookings"]>[0]): Promise<unknown> =>
      source === null ? Promise.reject(new Error("no ledger projection is configured")) : source.remainingBookings(fills),
    bookUnattributed: (correction: Parameters<HoldingsPort["bookUnattributed"]>[0]): Promise<unknown> => {
      refusedBookings.push(`${correction.assetKind} ${correction.assetId}: ${correction.delta}`);
      return Promise.resolve(Object.freeze({ ok: false, reason: "OPS_CLI_READ_ONLY" }));
    },
  });
}

export async function runReconcile(context: CommandContext, session: VenueSession, projection: ProjectionSource | null): Promise<CommandResult> {
  const { parsed, printer } = context;
  const policy = session.configuration.reconciliation;
  printer.section(SECTIONS.PLAN, [
    "run WP-290's ReconciliationCoordinator once (triggers STARTUP and MANUAL_REQUEST), reading venue truth with the emergency credential",
    `reads: /data/orders, /data/orders by id, /data/trades, /v2/positions, /v2/approvals (each at ${READ_PRIORITY}), and the on-chain collateral balance`,
    `against: no trader memory (a read-only, empty OMS view: every venue order is unattributed by construction) and ${projection === null ? "NO ledger projection (none is configured: the holdings comparison holds as unread)" : "the durable ledger projection, read only"}`,
    "read-only: nothing is resumed (the view refuses), no quarantine is released, nothing is booked (refused), and the journal is in memory only (nothing reaches the trader's)",
  ]);
  if (policy === null) {
    printer.section(SECTIONS.RESULT, ["nothing was run: the ops configuration has no reconciliation policy (it has no default)"]);
    printer.section(SECTIONS.UNKNOWN, ["the account's reconciliation state"]);
    return { exit: "CONFIGURATION_REFUSED", result: { ran: false } };
  }

  const events: ReconciliationJournalEvent[] = [];
  const journal = ReconciliationJournal.open({
    accountRef: parsed.accountRef,
    sink: {
      append: (event: ReconciliationJournalEvent): Promise<void> => {
        events.push(event);
        return Promise.resolve();
      },
    },
    history: [],
  });
  if (!journal.ok) {
    printer.section(SECTIONS.RESULT, [`nothing was run: the in-memory journal refused to open (${journal.refusal.code})`]);
    printer.section(SECTIONS.UNKNOWN, ["the account's reconciliation state"]);
    return { exit: "INTERNAL_ERROR", result: { ran: false } };
  }
  const refusedBookings: string[] = [];
  const oms = new ReadOnlyOmsView();
  const coordinator = new ReconciliationCoordinator({
    reads: session.reads,
    journal: journal.value,
    holdings: readOnlyHoldings(projection, refusedBookings),
    clock: { now: () => context.clock.nowMs() },
    newId: context.newId,
    // No catalog is consulted: an unknown market's break is the account's (reported only).
    marketOfToken: () => null,
    // The view registers no execution group.
    tokenOfGroup: () => null,
    policy: {
      accountRef: parsed.accountRef,
      collateralAssetId: policy.collateralAssetId,
      quiescenceHorizonMs: policy.quiescenceHorizonMs,
      maxReadSpanMs: policy.maxReadSpanMs,
      holdingConfirmationMs: policy.holdingConfirmationMs,
      requiredApprovalSpenders: policy.requiredApprovalSpenders,
    },
  });
  coordinator.bindOms(oms);
  coordinator.trigger("MANUAL_REQUEST");
  const report = await coordinator.reconcile();

  const runs = journal.value.runs();
  const passed = runs.some((run) => run.status === "PASSED");
  const result: string[] = [];
  for (const run of report.runs) {
    const durable = runs.find((view) => view.runId === run.runId);
    result.push(`run ${run.runId ?? "(not started)"}: ${durable?.status ?? run.status} — ${run.reason}`);
    for (const detection of run.detections) result.push(`  break ${detection.breakClass} ${detection.subjectKey}: ${detection.detail}`);
  }
  result.push(
    report.resumed
      ? "resumed: YES — unexpected for a read-only view; treat the report as unreliable"
      : `resumed: no${oms.resumeRefusals > 0 ? ` (the coordinator asked ${String(oms.resumeRefusals)} time(s); the read-only view refused)` : ""}`,
  );
  result.push(`quarantines released: none (never called)`);
  for (const booking of refusedBookings) result.push(`UNATTRIBUTED booking refused (read-only): ${booking}`);
  if (oms.refusedWrites.length > 0) result.push(`OMS writes refused (read-only): ${oms.refusedWrites.join(", ")}`);
  for (const record of session.readLog) if (!record.sent) result.push(`${record.read} was NOT SENT: ${record.note ?? "not granted"}`);
  printer.section(SECTIONS.RESULT, result);

  const unknown: string[] = [
    "the trader's own reconciliation state: this run is independent of it and changes nothing in it",
    "which venue orders the trader tracks: this CLI holds no trader memory, so every venue order reads as unattributed here",
  ];
  if (projection === null) unknown.push("the ledger projection: none is configured, so holdings were not compared");
  printer.section(SECTIONS.UNKNOWN, unknown);

  const notRun = report.runs.every((run) => run.status === "NOT_RUN");
  const detected = report.runs.flatMap((run) => run.detections.map((detection) => `${detection.breakClass} ${detection.subjectKey}`));
  // Bounded by construction: at most MAX_AUDITED_IDS breaks of bounded text; the count is always recorded.
  const breaks: AuditValue = detected.slice(0, MAX_AUDITED_IDS).map((text) => auditText(text, MAX_AUDITED_BREAK_LENGTH));
  return {
    exit: notRun ? "READ_INCOMPLETE" : passed ? "COMPLETED" : "RECONCILE_BREAKS",
    result: {
      runs: report.runs.map((run) => ({ runId: run.runId, status: runs.find((view) => view.runId === run.runId)?.status ?? run.status, resumed: run.resumed })),
      breaks,
      breakCount: detected.length,
      bookingsRefused: refusedBookings.length,
      journalEvents: events.length,
      resumed: report.resumed,
    },
  };
}
