/**
 * The dashboard CONTRACT — `WP-240`'s deliverable "operations/trading/fidelity
 * dashboards", stated as data so it can be machine-checked against the shipped
 * Grafana JSON.
 *
 * ## What this file is for
 *
 * A dashboard is an operator surface, and the failure mode that matters is not
 * "the JSON is malformed" — it is "a panel is bound to a metric nothing
 * produces", which looks identical to "the system is quiet". `dashboards.test.ts`
 * reads the real files under `infra/grafana/control/` and requires:
 *
 * 1. every series a panel binds is a family in `PLATFORM_METRIC_FAMILIES` or in
 *    `WP-140`'s `RECORDER_METRIC_FAMILIES` (a series matching neither fails);
 * 2. every family in `PLATFORM_METRIC_FAMILIES` appears on at least one panel
 *    (the other direction — a metric with no panel is either dead or the
 *    dashboard is incomplete, and both are findings);
 * 3. every panel that is NOT bound to data declares itself
 *    {@link PENDING_PRODUCER_MARKER} with a producer and an owner, in the exact
 *    grammar below;
 * 4. every dashboard's required panel titles exist, so a deliverable cannot be
 *    quietly dropped;
 * 5. no dashboard carries a production secret name (ADR-010 §3) or a live-mode
 *    control token.
 *
 * ## The pending-producer rule
 *
 * The packet's instruction is explicit: "do not invent metrics with no
 * producer — map each dashboard panel to a real source or mark the panel as
 * pending-its-producer with the owner named." A pending panel is therefore a
 * Grafana **text** panel whose content begins with {@link PENDING_PRODUCER_MARKER}
 * and names both what would produce the signal and who owns building it. It
 * displays that sentence to the operator, which is the honest thing for a panel
 * that cannot show data to do.
 */

/** The exact prefix a pending panel's text must start with. */
export const PENDING_PRODUCER_MARKER = "PENDING PRODUCER:" as const;

/**
 * The grammar of a pending panel's declaration.
 *
 * `PENDING PRODUCER: <what would produce it> — OWNER: <who owns building it>`
 *
 * Both halves are required. "Pending" with no owner is a TODO nobody holds.
 */
export const PENDING_PRODUCER_OWNER_MARKER = "— OWNER:" as const;

export type ControlDashboardId = "operations" | "trading" | "fidelity";

export interface ControlDashboardSpec {
  readonly id: ControlDashboardId;
  /** The file under `infra/grafana/control/`. */
  readonly file: string;
  /** The `title` the JSON must carry, exactly. */
  readonly title: string;
  /**
   * Panel titles this dashboard must contain.
   *
   * Drawn from the work-package deliverable and the packet: operations (halts,
   * queue depths, seam metrics, observe-only intents), trading (decisions, risk
   * vetoes including the risk-seam caveat counts, fills, PnL), fidelity
   * (replay/determinism indicators, dataset/staleness).
   */
  readonly requiredPanels: readonly string[];
}

export const CONTROL_DASHBOARDS: readonly ControlDashboardSpec[] = Object.freeze([
  Object.freeze({
    id: "operations",
    file: "operations-dashboard.json",
    title: "Polymarket bot — operations (paper)",
    requiredPanels: Object.freeze([
      "Run mode and ceiling",
      "Trader health report available",
      "Latched halts",
      "Halt detail",
      "Queue depth",
      "Queue oldest message age",
      "Queue backpressure",
      "Seam: fill deduplication",
      "Seam: inventory reservations",
      "Seam: cancels",
      "Seam: order views",
      "Seam: capital allocator",
      "Observe-only intents (shadow instances)",
      "Kill switches engaged",
      "Strategy instances by run state",
      "Control-plane refusals",
      "Audit log",
    ]),
  }),
  Object.freeze({
    id: "trading",
    file: "trading-dashboard.json",
    title: "Polymarket bot — trading (paper)",
    requiredPanels: Object.freeze([
      "Decisions persisted",
      "Evaluations and containments",
      "Risk approvals and refusals",
      "Risk vetoes by reason code",
      "Refused protective exits by reason code",
      "The WP-220 risk-seam caveat",
      "Execution plans and submissions",
      "Fills",
      "Cancels",
      "Ledger and PnL record counts",
      "Realized PnL",
      "Reserved collateral (exact decimals)",
    ]),
  }),
  Object.freeze({
    id: "fidelity",
    file: "fidelity-dashboard.json",
    title: "Polymarket bot — fidelity (paper)",
    requiredPanels: Object.freeze([
      "Dataset validation",
      "Feed staleness and gaps",
      "Recorder WAL data-loss bound",
      "Compaction lag",
      "Replay determinism",
      "Predicted versus actual fills",
      "Markout",
    ]),
  }),
]);

/**
 * Every panel that ships PENDING, with the producer it waits on and the owner.
 *
 * Stated here as well as in the dashboard JSON so the two are cross-checked:
 * `dashboards.test.ts` requires this list and the set of text panels carrying
 * {@link PENDING_PRODUCER_MARKER} to match EXACTLY, in both directions. A panel
 * quietly converted from pending to data-bound without updating this list
 * fails; so does an entry here for a panel that has since gained a producer.
 *
 * **None of these is a metric `WP-240` could have produced.** Each names a
 * signal whose producer lives in a tree this package does not own, and inventing
 * a family for it would put a name in the exporter with nothing behind it.
 */
export const PENDING_PRODUCER_PANELS: readonly {
  readonly dashboard: ControlDashboardId;
  readonly panel: string;
  readonly producer: string;
  readonly owner: string;
}[] = Object.freeze([
  Object.freeze({
    dashboard: "trading",
    panel: "Realized PnL",
    producer:
      "an exact-decimal PnL value on the trader's health surface; today it carries only " +
      "accounting.pnlRecords (a COUNT), and packages/pnl's snapshot values never reach an exporter",
    owner: "a future apps/trader grant (the health surface is apps/trader-owned; WP-240 is read-only there)",
  }),
  Object.freeze({
    dashboard: "fidelity",
    panel: "Replay determinism",
    producer:
      "a determinism indicator emitted by whatever executes a replay; §12.4 determinism is " +
      "proven today by `pnpm test:replay` and test/replay-golden, which emit no metric at all",
    owner:
      "a future packages/simulation or apps/backtest-cli grant (WP-250 verifies determinism but " +
      "its allowed paths forbid packages/** and apps/**, so it cannot add a producer)",
  }),
  Object.freeze({
    dashboard: "fidelity",
    panel: "Predicted versus actual fills",
    producer:
      "§12.2's execution-calibration model, which compares simulated fills against observed ones. " +
      "It requires EXECUTION_PROBE data that does not and may not exist under MAX_RUN_MODE=PAPER",
    owner: "WP-290 / phase-4 execution probes (out of scope for phase 2 by the phase plan)",
  }),
  Object.freeze({
    dashboard: "fidelity",
    panel: "Markout",
    producer:
      "§12.3 markout computation over fills; packages/simulation computes markouts for research " +
      "output, and nothing exports them as a time series",
    owner: "a future packages/simulation or apps/research-worker grant",
  }),
]);
