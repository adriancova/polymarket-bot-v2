/**
 * The OUTSIDE-IN traceability walk — `WP-250` acceptance criterion 1.
 *
 * ## Why this is a different primitive from `WP-230`'s chain test
 *
 * `test/integration/paper-trader/acceptance-3-traceable-chain.test.ts` walks §6
 * invariant 4 hop by hop from INSIDE a live process: it holds the loop, the
 * venue and the ledger as objects and asks each of them, in turn, whether it
 * agrees with the trace. That is the right test for the process's own suite,
 * and `WP-250` does not repeat it.
 *
 * This module is the other half. It receives ONE PLAIN DOCUMENT — the
 * serialised artefact, the same bytes the golden freezes — and resolves the
 * chain as a CLOSED-WORLD GRAPH over it. It imports nothing from any workspace
 * package and holds no reference to anything that ran. Consequences that matter:
 *
 * - an id that names something outside the document is a BROKEN HOP, because
 *   there is nowhere else to look;
 * - the walk is bidirectional. Forward resolution proves the chain reaches PnL;
 *   the ORPHAN checks prove nothing was persisted that no chain accounts for,
 *   which forward resolution alone can never show;
 * - the walker is falsifiable by construction, and
 *   `traceability-chain-negative.test.ts` mutates one id per hop and asserts
 *   that THAT hop, by name, is the one that breaks.
 *
 * ## Order provenance (`RECON-2`)
 *
 * A trace exists only once a FILL completes a chain, so an order withdrawn
 * unfilled is on no chain. The document's `orderProvenance` section holds, for
 * EVERY order the loop placed, the prefix the loop recorded at SUBMISSION —
 * event, feature snapshot, decision, intent, approved intent, plan, submission
 * attempt, order. The walk treats each record as a node with the same closure
 * as a chain: every record must RESOLVE (its decision, intent, feature
 * snapshot and event, and the booked order under the plan it names), none may
 * be an ORPHAN (a record for an order the venue never booked), no booked order
 * may be WITHOUT one, and every trace must AGREE with its order's record,
 * field for field. Each is a document-level finding with a stable code.
 *
 * The hop vocabulary is §6 invariant 4's own, read in production order and then
 * continued past the invariant's end to the two artefacts the packet asks for:
 * the ledger posting and the PnL that follows from it.
 */

/** The hops, in production order. The invariant states them in reverse. */
export const HOPS = [
  "event",
  "feature",
  "decision",
  "intent",
  "approved-intent",
  "plan",
  "submission",
  "order",
  "fill",
  "ledger-posting",
  "pnl-record",
  "pnl-snapshot",
] as const;

export type Hop = (typeof HOPS)[number];

/**
 * The read model.
 *
 * Declared here, structurally, rather than imported from the producer: this
 * module must be satisfiable by anything that PARSES from the golden bytes, and
 * a dependency on the producer's types would quietly let a future change carry
 * a non-serialisable value across the boundary.
 */
export interface WalkableDocument {
  readonly events: readonly { readonly eventId: string }[];
  readonly decisions: readonly {
    readonly runId: string;
    readonly instanceId: string;
    readonly marketId: string;
    readonly evaluationSeq: number;
    readonly sourceEventId: string | null;
    readonly featureSnapshotRef: string;
    readonly decisionType: string;
    readonly intents: readonly { readonly intentId?: string }[];
  }[];
  readonly traces: readonly {
    readonly sourceEventId: string;
    readonly featureSnapshotRef: string;
    readonly runId: string;
    readonly evaluationSeq: number;
    readonly intentId: string;
    readonly approvedIntentId: string;
    readonly executionPlanId: string;
    readonly submissionAttemptId: string;
    readonly venueOrderId: string;
    readonly venueFillId: string;
    readonly ledgerFillId: string;
    readonly ledgerTransactionIds: readonly string[];
  }[];
  /** Every order's submission-time trace prefix (`RECON-2`, golden format 2). */
  readonly orderProvenance: readonly {
    readonly sourceEventId: string;
    readonly featureSnapshotRef: string;
    readonly runId: string;
    readonly evaluationSeq: number;
    readonly intentId: string;
    readonly approvedIntentId: string;
    readonly executionPlanId: string;
    readonly submissionAttemptId: string;
    readonly venueOrderId: string;
  }[];
  readonly orders: readonly {
    readonly simulatedOrderId: string;
    readonly executionPlanId: string;
    readonly marketId: string;
  }[];
  readonly fills: readonly {
    readonly simulatedFillId: string;
    readonly simulatedOrderId: string;
    readonly marketId: string;
    readonly evidenceClass: string;
  }[];
  readonly ledgerTransactions: readonly {
    readonly ledgerTransactionId: string;
    readonly fillId: string | null;
    readonly environment: string;
    readonly entries: readonly { readonly amount: string }[];
  }[];
  readonly pnlRecords: readonly { readonly ref: string; readonly scope: string }[];
  readonly pnlSnapshots: readonly Readonly<Record<string, unknown>>[];
}

export interface HopResult {
  readonly hop: Hop;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ChainResult {
  readonly index: number;
  readonly hops: readonly HopResult[];
  readonly ok: boolean;
  /** The hops that failed, by name. Empty for a complete chain. */
  readonly brokenHops: readonly Hop[];
}

export interface WalkReport {
  readonly ok: boolean;
  readonly chains: readonly ChainResult[];
  /** Document-level integrity findings, each prefixed by a stable code. */
  readonly findings: readonly string[];
  /** Every hop that broke in any chain, de-duplicated and in hop order. */
  readonly brokenHops: readonly Hop[];
}

const CONTENT_ADDRESS = /^[0-9a-f]{64}$/u;

/** The fields an order's provenance record and each of its chains share. */
const PROVENANCE_FIELDS = [
  "sourceEventId",
  "featureSnapshotRef",
  "runId",
  "evaluationSeq",
  "intentId",
  "approvedIntentId",
  "executionPlanId",
  "submissionAttemptId",
  "venueOrderId",
] as const;

function hop(name: Hop, ok: boolean, detail: string): HopResult {
  return { hop: name, ok, detail };
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/**
 * Walks every chain the document carries and reports the whole result.
 *
 * TOTAL: it never throws on a malformed document. A missing collection, a
 * dangling id or a duplicate key is a finding, because a walker that threw
 * would turn "the chain is broken" into "the test crashed", and only one of
 * those tells an operator where to look.
 */
export function walkChains(document: WalkableDocument): WalkReport {
  const findings: string[] = [];

  const eventIds = new Set(document.events.map((event) => event.eventId));
  const decisionsByKey = new Map<string, WalkableDocument["decisions"][number]>();
  for (const decision of document.decisions) {
    const key = `${decision.runId}|${String(decision.evaluationSeq)}`;
    if (decisionsByKey.has(key)) {
      findings.push(
        `DECISION_KEY_NOT_UNIQUE: two persisted decisions share (runId, evaluationSeq) ${key}; ` +
          "§10.3 makes that pair the primary key",
      );
    }
    decisionsByKey.set(key, decision);
  }

  const ordersById = new Map(document.orders.map((order) => [order.simulatedOrderId, order]));
  const fillsById = new Map(document.fills.map((fill) => [fill.simulatedFillId, fill]));
  const transactionsById = new Map(
    document.ledgerTransactions.map((transaction) => [
      transaction.ledgerTransactionId,
      transaction,
    ]),
  );

  for (const [label, values] of [
    ["EVENT", document.events.map((event) => event.eventId)],
    ["ORDER", document.orders.map((order) => order.simulatedOrderId)],
    ["FILL", document.fills.map((fill) => fill.simulatedFillId)],
    [
      "LEDGER_TRANSACTION",
      document.ledgerTransactions.map((transaction) => transaction.ledgerTransactionId),
    ],
  ] as const) {
    const repeated = duplicates(values);
    if (repeated.length > 0) {
      findings.push(`${label}_ID_NOT_UNIQUE: ${repeated.join(", ")}`);
    }
  }

  if (document.traces.length === 0) {
    findings.push(
      "NO_CHAIN: the run produced no §6 invariant 4 chain at all. An empty walk is not a " +
        "passing walk — there would be nothing to trace",
    );
  }

  const chains: ChainResult[] = document.traces.map((trace, index) => {
    const hops: HopResult[] = [];

    // --- 1. source event ----------------------------------------------------
    hops.push(
      hop(
        "event",
        eventIds.has(trace.sourceEventId),
        `sourceEventId ${trace.sourceEventId} ${
          eventIds.has(trace.sourceEventId) ? "resolves in" : "is absent from"
        } the recorded event list`,
      ),
    );

    // --- 3. decision (resolved first; hops 2 and 4 are read through it) -----
    const key = `${trace.runId}|${String(trace.evaluationSeq)}`;
    const decision = decisionsByKey.get(key);
    hops.push(
      hop(
        "decision",
        decision !== undefined && decision.sourceEventId === trace.sourceEventId,
        decision === undefined
          ? `no persisted decision has key (runId, evaluationSeq) = ${key}`
          : decision.sourceEventId === trace.sourceEventId
            ? `the persisted decision at ${key} names the same source event`
            : `the persisted decision at ${key} names source event ${
                decision.sourceEventId ?? "none"
              }, not ${trace.sourceEventId}`,
      ),
    );

    // --- 2. feature snapshot ------------------------------------------------
    const featureOk =
      CONTENT_ADDRESS.test(trace.featureSnapshotRef) &&
      decision !== undefined &&
      decision.featureSnapshotRef === trace.featureSnapshotRef;
    hops.push(
      hop(
        "feature",
        featureOk,
        !CONTENT_ADDRESS.test(trace.featureSnapshotRef)
          ? `featureSnapshotRef ${trace.featureSnapshotRef} is not a 64-hex content address`
          : decision === undefined
            ? "there is no persisted decision to compare the snapshot reference against"
            : decision.featureSnapshotRef === trace.featureSnapshotRef
              ? "the persisted decision names the same feature snapshot content address"
              : `the persisted decision names snapshot ${decision.featureSnapshotRef}`,
      ),
    );

    // --- 4. intent ----------------------------------------------------------
    const intentIds =
      decision === undefined
        ? []
        : decision.intents
            .map((intent) => intent.intentId)
            .filter((id): id is string => typeof id === "string");
    hops.push(
      hop(
        "intent",
        intentIds.includes(trace.intentId),
        intentIds.includes(trace.intentId)
          ? `intent ${trace.intentId} is one the persisted decision emitted`
          : `intent ${trace.intentId} is not among the persisted decision's intents ` +
            `(${intentIds.join(", ") || "none"})`,
      ),
    );

    // --- 5. approved intent -------------------------------------------------
    const approvedOk =
      trace.approvedIntentId !== "" && trace.approvedIntentId !== trace.executionPlanId;
    hops.push(
      hop(
        "approved-intent",
        approvedOk,
        trace.approvedIntentId === ""
          ? "the chain carries no approved-intent id; the risk engine's approval record is the " +
            "only thing that authorises a plan"
          : trace.approvedIntentId === trace.executionPlanId
            ? "the approved-intent id and the execution-plan id are the same value, so one of " +
              "the two hops is not a real link"
            : `approved intent ${trace.approvedIntentId} is distinct from the plan it authorised`,
      ),
    );

    // --- 8. order (resolved before the plan hop, which reads through it) ----
    const order = ordersById.get(trace.venueOrderId);
    hops.push(
      hop(
        "order",
        order !== undefined,
        order === undefined
          ? `no venue order has id ${trace.venueOrderId}`
          : `the venue booked order ${trace.venueOrderId} in market ${order.marketId}`,
      ),
    );

    // --- 6. execution plan --------------------------------------------------
    const planOk =
      trace.executionPlanId !== "" &&
      order !== undefined &&
      order.executionPlanId === trace.executionPlanId;
    hops.push(
      hop(
        "plan",
        planOk,
        trace.executionPlanId === ""
          ? "the chain carries no execution-plan id"
          : order === undefined
            ? "there is no venue order to confirm the plan id against"
            : order.executionPlanId === trace.executionPlanId
              ? `the booked order was placed under plan ${trace.executionPlanId}`
              : `the booked order names plan ${order.executionPlanId}, not ${trace.executionPlanId}`,
      ),
    );

    // --- 7. submission attempt ---------------------------------------------
    const submissionOk =
      trace.submissionAttemptId !== "" &&
      trace.submissionAttemptId !== trace.executionPlanId &&
      trace.submissionAttemptId !== trace.approvedIntentId;
    hops.push(
      hop(
        "submission",
        submissionOk,
        trace.submissionAttemptId === ""
          ? "the chain carries no submission-attempt id"
          : submissionOk
            ? `submission attempt ${trace.submissionAttemptId} is its own identity`
            : "the submission-attempt id repeats the plan or the approved-intent id, so the " +
              "attempt is not separately identified",
      ),
    );

    // --- 9. fill ------------------------------------------------------------
    const fill = fillsById.get(trace.venueFillId);
    const fillOk =
      fill !== undefined &&
      fill.simulatedOrderId === trace.venueOrderId &&
      fill.evidenceClass === "SIMULATED_NOT_REAL_EVIDENCE";
    hops.push(
      hop(
        "fill",
        fillOk,
        fill === undefined
          ? `no venue fill has id ${trace.venueFillId}`
          : fill.simulatedOrderId !== trace.venueOrderId
            ? `fill ${trace.venueFillId} belongs to order ${fill.simulatedOrderId}, not ` +
              `${trace.venueOrderId}`
            : fill.evidenceClass !== "SIMULATED_NOT_REAL_EVIDENCE"
              ? `fill ${trace.venueFillId} is labelled ${fill.evidenceClass}; ADR-012 §2 requires ` +
                "a paper fill to travel as simulated, non-real evidence"
              : `fill ${trace.venueFillId} was produced by the order this chain names`,
      ),
    );

    // --- 10. ledger posting -------------------------------------------------
    const postings = trace.ledgerTransactionIds.map((id) => transactionsById.get(id));
    const missing = trace.ledgerTransactionIds.filter((id) => !transactionsById.has(id));
    const wrongFill = postings.filter(
      (transaction) => transaction !== undefined && transaction.fillId !== trace.ledgerFillId,
    );
    const thin = postings.filter(
      (transaction) => transaction !== undefined && transaction.entries.length < 2,
    );
    const postingOk =
      trace.ledgerTransactionIds.length > 0 &&
      missing.length === 0 &&
      wrongFill.length === 0 &&
      thin.length === 0;
    hops.push(
      hop(
        "ledger-posting",
        postingOk,
        trace.ledgerTransactionIds.length === 0
          ? "the chain names no ledger transaction; the fill reached no book"
          : missing.length > 0
            ? `these ledger transactions are not in the persisted history: ${missing.join(", ")}`
            : wrongFill.length > 0
              ? "a named transaction carries a different ledger fill identity than the chain does"
              : thin.length > 0
                ? "a named transaction has fewer than two entries, so it cannot be balanced"
                : `${String(trace.ledgerTransactionIds.length)} persisted transactions, all ` +
                  `carrying ledger fill ${trace.ledgerFillId}`,
      ),
    );

    // --- 11. PnL record -----------------------------------------------------
    const named = new Set(trace.ledgerTransactionIds);
    const records = document.pnlRecords.filter((record) => named.has(record.ref));
    hops.push(
      hop(
        "pnl-record",
        records.length > 0 && records.every((record) => record.scope === "VIRTUAL_STRATEGY"),
        records.length === 0
          ? "no §9.16 record refers to any transaction this chain posted"
          : records.every((record) => record.scope === "VIRTUAL_STRATEGY")
            ? `${String(records.length)} PnL record(s) refer to this chain's transactions`
            : "a PnL record reached from this chain is not attributed to the strategy scope",
      ),
    );

    // --- 12. PnL snapshot ---------------------------------------------------
    const snapshot = document.pnlSnapshots.find(
      (candidate) =>
        candidate["runId"] === trace.runId &&
        candidate["instanceId"] === decision?.instanceId &&
        candidate["marketId"] === decision?.marketId,
    );
    hops.push(
      hop(
        "pnl-snapshot",
        snapshot !== undefined && snapshot["environment"] === "PAPER",
        snapshot === undefined
          ? `no persisted PnL snapshot is scoped to run ${trace.runId} and this chain's ` +
            "instance and market"
          : snapshot["environment"] === "PAPER"
            ? "a persisted PAPER PnL snapshot closes the chain"
            : `the persisted snapshot's environment is ${String(snapshot["environment"])}`,
      ),
    );

    const ordered = HOPS.map(
      (name) => hops.find((result) => result.hop === name) ?? hop(name, false, "hop not walked"),
    );
    const broken = ordered.filter((result) => !result.ok).map((result) => result.hop);
    return { index, hops: ordered, ok: broken.length === 0, brokenHops: broken };
  });

  // --- document-level closure: nothing persisted is unaccounted for ---------

  const claimedTransactions = document.traces.flatMap((trace) => trace.ledgerTransactionIds);
  const claimedRepeats = duplicates(claimedTransactions);
  if (claimedRepeats.length > 0) {
    findings.push(
      `LEDGER_TRANSACTION_CLAIMED_TWICE: ${claimedRepeats.join(", ")}; a posting belongs to one ` +
        "fill",
    );
  }
  const claimedSet = new Set(claimedTransactions);
  const orphanTransactions = document.ledgerTransactions
    .map((transaction) => transaction.ledgerTransactionId)
    .filter((id) => !claimedSet.has(id));
  if (orphanTransactions.length > 0) {
    findings.push(
      `ORPHAN_LEDGER_TRANSACTION: ${orphanTransactions.join(", ")} reached the durable store ` +
        "but no chain accounts for them",
    );
  }

  const claimedFills = new Set(document.traces.map((trace) => trace.venueFillId));
  const orphanFills = document.fills
    .map((fill) => fill.simulatedFillId)
    .filter((id) => !claimedFills.has(id));
  if (orphanFills.length > 0) {
    findings.push(
      `ORPHAN_FILL: ${orphanFills.join(", ")} were produced by the venue but no chain traces ` +
        "them to a ledger posting",
    );
  }

  const danglingRecords = document.pnlRecords
    .map((record) => record.ref)
    .filter((ref) => !transactionsById.has(ref));
  if (danglingRecords.length > 0) {
    findings.push(
      `DANGLING_PNL_REF: ${danglingRecords.join(", ")} are §9.16 record references with no ` +
        "ledger transaction behind them",
    );
  }

  // --- order provenance: every record a resolved node, nothing orphaned -----

  // TOTAL here too: a format-1 document has no section at all, and that is a
  // finding — every booked order then also reports ORDER_WITHOUT_PROVENANCE.
  const section: unknown = document.orderProvenance;
  const provenance: WalkableDocument["orderProvenance"] = Array.isArray(section)
    ? document.orderProvenance
    : [];
  if (!Array.isArray(section)) {
    findings.push(
      "PROVENANCE_SECTION_MISSING: the document has no orderProvenance section (golden format " +
        "2 added it), so no order's origin can be resolved by id",
    );
  }
  const provenanceIds = provenance.map((record) => record.venueOrderId);
  const repeatedProvenance = duplicates(provenanceIds);
  if (repeatedProvenance.length > 0) {
    findings.push(
      `PROVENANCE_ORDER_NOT_UNIQUE: ${repeatedProvenance.join(", ")} carry more than one ` +
        "provenance record; the loop records one per order, at submission",
    );
  }
  const provenanceByOrder = new Map(provenance.map((record) => [record.venueOrderId, record]));

  for (const record of provenance) {
    const order = ordersById.get(record.venueOrderId);
    if (order === undefined) {
      findings.push(
        `ORPHAN_PROVENANCE: ${record.venueOrderId} has a provenance record but the venue never ` +
          "booked it, so no order accounts for the record",
      );
    }
    const problems: string[] = [];
    const key = `${record.runId}|${String(record.evaluationSeq)}`;
    const decision = decisionsByKey.get(key);
    if (decision === undefined) {
      problems.push(`no persisted decision has key (runId, evaluationSeq) = ${key}`);
    } else {
      // The loop records `""` for an evaluation it ORIGINATED (`onFill`,
      // `onOrderUpdate`), whose persisted decision states no source event.
      const eventOk =
        decision.sourceEventId === null
          ? record.sourceEventId === ""
          : record.sourceEventId === decision.sourceEventId && eventIds.has(record.sourceEventId);
      if (!eventOk) {
        problems.push(
          `the record names source event ${JSON.stringify(record.sourceEventId)}, the persisted ` +
            `decision ${decision.sourceEventId ?? "none"}` +
            (decision.sourceEventId !== null && !eventIds.has(decision.sourceEventId)
              ? ", which is not in the recorded event list"
              : ""),
        );
      }
      if (
        !CONTENT_ADDRESS.test(record.featureSnapshotRef) ||
        record.featureSnapshotRef !== decision.featureSnapshotRef
      ) {
        problems.push(
          `the record names feature snapshot ${record.featureSnapshotRef}, the persisted ` +
            `decision ${decision.featureSnapshotRef}`,
        );
      }
      const emitted = decision.intents
        .map((intent) => intent.intentId)
        .filter((id): id is string => typeof id === "string");
      if (!emitted.includes(record.intentId)) {
        problems.push(
          `intent ${record.intentId} is not among the persisted decision's intents ` +
            `(${emitted.join(", ") || "none"})`,
        );
      }
    }
    // All three non-empty (`RECON2-R2`: the plan id too — the chain's own plan
    // hop refuses an empty one, and an unfilled order's record is on no chain)
    // and pairwise distinct.
    if (
      record.approvedIntentId === "" ||
      record.executionPlanId === "" ||
      record.approvedIntentId === record.executionPlanId ||
      record.submissionAttemptId === "" ||
      record.submissionAttemptId === record.executionPlanId ||
      record.submissionAttemptId === record.approvedIntentId
    ) {
      problems.push(
        "the approved-intent, plan and submission-attempt ids are not three distinct, non-empty " +
          "identities",
      );
    }
    if (order !== undefined && order.executionPlanId !== record.executionPlanId) {
      problems.push(
        `the record names plan ${record.executionPlanId}, the booked order plan ` +
          order.executionPlanId,
      );
    }
    if (problems.length > 0) {
      findings.push(`PROVENANCE_UNRESOLVED: ${record.venueOrderId}: ${problems.join("; ")}`);
    }
  }

  const unprovenanced = document.orders
    .map((order) => order.simulatedOrderId)
    .filter((id) => !provenanceByOrder.has(id));
  if (unprovenanced.length > 0) {
    findings.push(
      `ORDER_WITHOUT_PROVENANCE: ${unprovenanced.join(", ")} were booked by the venue but carry ` +
        "no provenance record, so nothing names the intent that placed them",
    );
  }

  for (const trace of document.traces) {
    const record = provenanceByOrder.get(trace.venueOrderId);
    if (record === undefined) continue; // the chain's own "order" hop, or ORDER_WITHOUT_PROVENANCE
    const differing = PROVENANCE_FIELDS.filter((field) => trace[field] !== record[field]);
    if (differing.length > 0) {
      findings.push(
        `PROVENANCE_TRACE_MISMATCH: the chain of fill ${trace.venueFillId} disagrees with order ` +
          `${trace.venueOrderId}'s provenance record on ${differing.join(", ")}; the loop builds ` +
          "the chain FROM that record",
      );
    }
  }

  for (const decision of document.decisions) {
    if (decision.sourceEventId !== null && !eventIds.has(decision.sourceEventId)) {
      findings.push(
        `DANGLING_DECISION_SOURCE_EVENT: persisted decision (${decision.runId}, ` +
          `${String(decision.evaluationSeq)}) names event ${decision.sourceEventId}, which is ` +
          "not in the recorded event list",
      );
    }
  }

  for (const transaction of document.ledgerTransactions) {
    if (transaction.environment !== "PAPER") {
      findings.push(
        `NON_PAPER_LEDGER_TRANSACTION: ${transaction.ledgerTransactionId} is booked in ` +
          `${transaction.environment}; §10.8 keeps run modes in separate books and this run is ` +
          "PAPER",
      );
    }
  }

  const brokenHops = HOPS.filter((name) =>
    chains.some((chain) => chain.brokenHops.includes(name)),
  );

  return {
    ok: findings.length === 0 && chains.every((chain) => chain.ok),
    chains,
    findings: Object.freeze(findings),
    brokenHops: Object.freeze(brokenHops),
  };
}

/** A one-line-per-problem explanation, for a failing assertion's message. */
export function explainWalk(report: WalkReport): string {
  const lines: string[] = [...report.findings];
  for (const chain of report.chains) {
    for (const result of chain.hops) {
      if (!result.ok) {
        lines.push(`chain ${String(chain.index)} hop ${result.hop}: ${result.detail}`);
      }
    }
  }
  return lines.length === 0 ? "the walk found nothing" : lines.join("\n");
}
