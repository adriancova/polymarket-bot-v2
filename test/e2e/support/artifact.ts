/**
 * The RUN ARTEFACT: everything the paper run left behind, as plain data.
 *
 * This module is the boundary between "a running process" and "what a
 * verification reads". Two properties make it the right primitive for `WP-250`:
 *
 * 1. **It is what the run PERSISTED.** Decisions, checkpoints, ledger
 *    transactions and PnL snapshots are read from the durable-store double —
 *    the port the shipped process writes PostgreSQL through — not from the
 *    loop's in-memory opinion of what it wrote. `WP-230`'s fixture asserts the
 *    §6 invariant-4 chain hop by hop from INSIDE the process against live
 *    objects; this suite serialises the outside and walks it there. The venue's
 *    orders and fills come from the venue for the same reason: they are the
 *    only record of what the execution seam actually did.
 * 2. **It is plain data all the way down.** Once serialised, the chain walk in
 *    `chain-walk.ts` and the reconciliation in `reconcile.ts` cannot reach a
 *    live object to ask it a question. An id that does not resolve inside the
 *    document is a broken chain, full stop.
 *
 * ## What is deliberately NOT in the artefact, and why
 *
 * | Excluded | Reason |
 * | --- | --- |
 * | `DecisionTelemetry.evaluationDurationUs` | `packages/strategy-runtime` documents it as "machine-dependent by nature; excluded from `DecisionRecord` so §12.4 byte-identity holds". It is a wall-elapsed measurement, and a golden that froze it would be freezing the host. |
 * | `HealthSnapshot.riskSeamCaveat` | a long prose constant owned by `apps/trader`. `residuals-observed.test.ts` pins it by IDENTITY against the exported `RISK_SEAM_CAVEAT`, which is drift-proof; copying its text into a golden this package owns would make an upstream wording fix look like a determinism failure. |
 * | anything read from a clock, an environment or a filesystem | there is none. Every instant in the artefact is derived from the scenario's literal `receivedAt` values. |
 */

import { projectionOf } from "@polymarket-bot/trader";

import { canonicalJson } from "./canonical-json.js";
import {
  ACCOUNT_REF,
  DENOMINATION_ASSET_ID,
  ENTRY_FEE_PER_SHARE,
  ENTRY_SHARES,
  EXIT_FEE_PER_SHARE,
  ID_NAMESPACE,
  INSTANCE_ID,
  MARKET_ID,
  MAXIMUM_BUY_PRICE,
  MAXIMUM_TOTAL_COST,
  NO_TOKEN,
  RUN_ID,
  STARTING_CASH,
  TAKE_PROFIT_PRICE,
  TRIGGER_PRICE_LTE,
  YES_TOKEN,
  feeSnapshot,
  recordedEvents,
} from "./scenario.js";
import { buildReconciliation, type ReconciliationRow } from "./reconcile.js";
import type { Run } from "./harness.js";

/**
 * The format version of the committed golden. Bump = regenerate the golden.
 *
 * `2` (`RECON-2`): the `orderProvenance` section — every order's trace prefix
 * as the loop recorded it at SUBMISSION — so that an order that never filled is
 * attributed to its intent by id rather than by inference.
 */
export const GOLDEN_FORMAT_VERSION = 2;

export interface ArtifactEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly source: string;
  readonly ingestSeq: string;
  readonly receivedAt: string;
  readonly datasetRowOrdinal: number;
}

export interface ArtifactIntent {
  readonly type: string;
  /** §7.7 gives `CANCEL` and `REDUCE_POSITION` no `intentId`; absent, not "". */
  readonly intentId?: string;
  readonly marketId?: string;
  readonly targetShares?: string;
  readonly maximumBuyPrice?: string;
  readonly minimumSellPrice?: string;
  readonly maximumTotalCost?: string;
  readonly expectedNetEdge?: string;
  readonly liquidityPreference?: string;
  readonly urgency?: string;
  readonly validUntil?: string;
  readonly tags?: readonly string[];
}

export interface ArtifactDecision {
  readonly runId: string;
  readonly instanceId: string;
  readonly marketId: string;
  readonly evaluationSeq: number;
  readonly callback: string;
  readonly attribution: string;
  readonly evaluatedAt: string;
  /** `null` when the evaluation had no triggering event (§7.1 timer path). */
  readonly sourceEventId: string | null;
  readonly decisionType: string;
  readonly reasonCodes: readonly string[];
  readonly featureSnapshotRef: string;
  readonly modelOutputs: Readonly<Record<string, string | boolean | null>>;
  readonly intents: readonly ArtifactIntent[];
}

export interface ArtifactTrace {
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
}

/**
 * One order's PROVENANCE: the §6 invariant 4 trace prefix the loop builds when
 * the order is SUBMITTED (`CoreLoop.orderProvenance()`, `RECON-2`).
 *
 * A {@link ArtifactTrace} exists only once a FILL completes the chain, so an
 * order that rested and was withdrawn unfilled has none; this record exists for
 * EVERY order the loop placed, filled or not, and names its origin — the
 * emission `(runId, evaluationSeq, intentId)` — by id. For an order that did
 * fill, every trace of it carries exactly these nine fields.
 *
 * `sourceEventId` is the loop's value verbatim: `""` for an order placed by an
 * evaluation the loop ORIGINATED (`onFill`, `onOrderUpdate`), whose persisted
 * decision carries `sourceEventId: null`.
 */
export interface ArtifactOrderProvenance {
  readonly sourceEventId: string;
  readonly featureSnapshotRef: string;
  readonly runId: string;
  readonly evaluationSeq: number;
  readonly intentId: string;
  readonly approvedIntentId: string;
  readonly executionPlanId: string;
  readonly submissionAttemptId: string;
  readonly venueOrderId: string;
}

export interface ArtifactOrder {
  readonly simulatedOrderId: string;
  readonly plannedOrderId: string;
  readonly executionPlanId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: string;
  readonly action: string;
  readonly limitPrice: string;
  readonly requestedShares: string;
  readonly filledShares: string;
  readonly state: string;
  readonly postOnly: boolean;
  readonly executionStyle: string;
  readonly fillEstimateKind: string;
  readonly atEventIngestSeq: string;
}

export interface ArtifactFill {
  readonly simulatedFillId: string;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: string;
  readonly action: string;
  readonly price: string;
  readonly shares: string;
  readonly feeAmount: string;
  readonly liquidityRole: string;
  readonly evidenceClass: string;
  readonly fillModelVersion: string;
  readonly modelTier: string;
  readonly deploymentDecisionUse: string;
  readonly planningDepthAwareness: string;
  readonly atEventIngestSeq: string;
}

export interface ArtifactLedgerEntry {
  readonly scope: string;
  readonly accountRef: string;
  readonly assetId: string;
  readonly assetKind: string;
  readonly amount: string;
  readonly instanceId: string | null;
  readonly runId: string | null;
  readonly marketId: string | null;
}

export interface ArtifactLedgerTransaction {
  readonly sequence: number;
  readonly ledgerTransactionId: string;
  readonly eventType: string;
  readonly environment: string;
  readonly accountRef: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly fillId: string | null;
  readonly marketId: string | null;
  readonly entries: readonly ArtifactLedgerEntry[];
}

export interface ArtifactPnlRecord {
  readonly kind: string;
  readonly ref: string;
  readonly scope: string;
  readonly instanceId: string | null;
  readonly amount: string | null;
  readonly shares: string | null;
  readonly price: string | null;
  readonly side: string | null;
  readonly tokenAssetId: string | null;
}

export interface ArtifactVirtualPosition {
  readonly instanceId: string;
  readonly assetId: string;
  readonly assetKind: string;
  readonly marketId: string | null;
  readonly balance: string;
}

export interface ArtifactBalance {
  readonly scope: string;
  readonly accountRef: string;
  readonly assetId: string;
  readonly assetKind: string;
  readonly balance: string;
}

/**
 * The health COUNTERS, without prose.
 *
 * Every field is an integer or a sorted map of integers, so this section of the
 * golden is a behavioural fingerprint of the whole run: an off-by-one anywhere
 * in the loop moves a number here.
 */
export interface ArtifactHealth {
  readonly runMode: string;
  readonly maximumRunMode: string;
  readonly healthy: boolean;
  readonly asOf: string;
  readonly halts: readonly {
    readonly scope: string;
    readonly code: string;
    readonly action: string;
    readonly at: string;
  }[];
  readonly loop: Readonly<Record<string, number>>;
  readonly risk: {
    readonly evaluations: number;
    readonly approvals: number;
    readonly refusals: number;
    readonly refusedExits: number;
    readonly refusalsByCode: Readonly<Record<string, number>>;
    readonly refusedExitsByCode: Readonly<Record<string, number>>;
    readonly recommendationsByAction: Readonly<Record<string, number>>;
  };
  readonly execution: Readonly<Record<string, number>>;
  /**
   * The accounting counters plus, since `TRDR-3`, `realizedPnl` — exact
   * decimal STRINGS per instance and their exact sum, or `null` while the
   * composition observed no PnL snapshot (this harness attaches no
   * `RealizedPnlBook`; see `test/replay-golden/paper-e2e/README.md`).
   */
  readonly accounting: Readonly<
    Record<
      string,
      | number
      | { readonly byInstance: Readonly<Record<string, string>>; readonly account: string | null }
    >
  >;
  readonly seams: {
    readonly fills: MetricGroup;
    readonly reservations: MetricGroup;
    readonly cancels: MetricGroup;
    readonly orderViews: MetricGroup;
    readonly allocator: MetricGroup;
  };
}

/**
 * One seam's `metrics()` answer.
 *
 * Counters, exactly-summed decimal strings (§6 invariant 1 — the allocator's
 * reserved collateral is money and travels as a string), and per-code maps.
 */
export type MetricGroup = Readonly<
  Record<string, number | string | Readonly<Record<string, number>>>
>;

export interface PaperRunArtifact {
  readonly goldenFormatVersion: number;
  readonly scenario: {
    readonly idNamespace: string;
    readonly marketId: string;
    readonly yesTokenId: string;
    readonly noTokenId: string;
    readonly instanceId: string;
    readonly runId: string;
    readonly accountRef: string;
    readonly denominationAssetId: string;
    readonly startingCash: string;
    readonly entryShares: string;
    readonly triggerPriceLte: string;
    readonly maximumBuyPrice: string;
    readonly maximumTotalCost: string;
    readonly takeProfitPrice: string;
    readonly entryFeePerShare: string;
    readonly exitFeePerShare: string;
    readonly feeSchedule: {
      readonly snapshotVersion: string;
      readonly takerFeeRate: string;
      readonly makerFeeRate: string;
      readonly roundingDecimalPlaces: number;
      readonly roundingMode: string;
      readonly minimumChargedFee: string;
      readonly feeCurrency: string;
    };
  };
  readonly events: readonly ArtifactEvent[];
  readonly decisions: readonly ArtifactDecision[];
  readonly checkpointInstants: readonly string[];
  readonly traces: readonly ArtifactTrace[];
  /** Every order's submission-time provenance, in submission order (`RECON-2`). */
  readonly orderProvenance: readonly ArtifactOrderProvenance[];
  readonly orders: readonly ArtifactOrder[];
  readonly fills: readonly ArtifactFill[];
  readonly ledgerTransactions: readonly ArtifactLedgerTransaction[];
  readonly pnlRecords: readonly ArtifactPnlRecord[];
  readonly pnlSnapshots: readonly Readonly<Record<string, unknown>>[];
  readonly ledgerProjection: {
    readonly transactionCount: number;
    readonly unattributedActivity: number;
    readonly unexplainedMovements: number;
    readonly balances: readonly ArtifactBalance[];
    readonly virtualPositions: readonly ArtifactVirtualPosition[];
  };
  readonly health: ArtifactHealth;
  readonly reconciliation: readonly ReconciliationRow[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function intentOf(intent: Record<string, unknown>): ArtifactIntent {
  return {
    type: String(intent["type"]),
    ...(optionalString(intent["intentId"]) === undefined
      ? {}
      : { intentId: String(intent["intentId"]) }),
    ...(optionalString(intent["marketId"]) === undefined
      ? {}
      : { marketId: String(intent["marketId"]) }),
    ...(optionalString(intent["targetShares"]) === undefined
      ? {}
      : { targetShares: String(intent["targetShares"]) }),
    ...(optionalString(intent["maximumBuyPrice"]) === undefined
      ? {}
      : { maximumBuyPrice: String(intent["maximumBuyPrice"]) }),
    ...(optionalString(intent["minimumSellPrice"]) === undefined
      ? {}
      : { minimumSellPrice: String(intent["minimumSellPrice"]) }),
    ...(optionalString(intent["maximumTotalCost"]) === undefined
      ? {}
      : { maximumTotalCost: String(intent["maximumTotalCost"]) }),
    ...(optionalString(intent["expectedNetEdge"]) === undefined
      ? {}
      : { expectedNetEdge: String(intent["expectedNetEdge"]) }),
    ...(optionalString(intent["liquidityPreference"]) === undefined
      ? {}
      : { liquidityPreference: String(intent["liquidityPreference"]) }),
    ...(optionalString(intent["urgency"]) === undefined
      ? {}
      : { urgency: String(intent["urgency"]) }),
    ...(optionalString(intent["validUntil"]) === undefined
      ? {}
      : { validUntil: String(intent["validUntil"]) }),
    ...(Array.isArray(intent["tags"])
      ? { tags: (intent["tags"] as unknown[]).map((tag) => String(tag)) }
      : {}),
  };
}

/**
 * Captures the artefact from a completed run.
 *
 * Reads only public surfaces: the durable-store double's four write logs, the
 * venue's orders and fills, the loop's trace, order-provenance and health
 * surfaces, and the §6 invariant 8 projection folded from the append-only
 * ledger.
 */
export function captureArtifact(run: Run): PaperRunArtifact {
  const health = run.trader.loop.health();
  const projection = projectionOf(run.trader.loop.ledger());
  const fees = feeSnapshot();

  const decisions: ArtifactDecision[] = run.parts.store.decisions.map((written) => {
    const record = written.record;
    const decision = record.decision as unknown as Record<string, unknown>;
    const source = record.sourceEvent as { eventId?: string } | undefined;
    return {
      runId: record.runId,
      instanceId: record.instanceId,
      marketId: record.marketId,
      evaluationSeq: record.evaluationSeq,
      callback: record.callback,
      attribution: record.attribution,
      evaluatedAt: record.evaluatedAt,
      sourceEventId: source?.eventId ?? null,
      decisionType: String(decision["decisionType"]),
      reasonCodes: (decision["reasonCodes"] as readonly string[]).map((code) => code),
      featureSnapshotRef: String(decision["featureSnapshotRef"]),
      modelOutputs: (decision["modelOutputs"] ?? {}) as Readonly<
        Record<string, string | boolean | null>
      >,
      intents: (decision["intents"] as readonly Record<string, unknown>[]).map(intentOf),
    };
  });

  const orders: ArtifactOrder[] = run.orders.map((order) => ({
    simulatedOrderId: order.simulatedOrderId,
    plannedOrderId: order.plannedOrderId,
    executionPlanId: order.executionPlanId,
    marketId: order.marketId,
    tokenId: order.tokenId,
    side: order.side,
    action: order.action,
    limitPrice: order.limitPrice,
    requestedShares: order.requestedShares,
    filledShares: order.filledShares,
    state: order.state,
    postOnly: order.postOnly,
    executionStyle: order.executionStyle,
    fillEstimateKind: order.fillEstimateKind,
    atEventIngestSeq: order.atEvent.ingestSeq,
  }));

  const fills: ArtifactFill[] = run.fills.map((fill) => ({
    simulatedFillId: fill.simulatedFillId,
    simulatedOrderId: fill.simulatedOrderId,
    marketId: fill.marketId,
    tokenId: fill.tokenId,
    side: fill.side,
    action: fill.action,
    price: fill.price,
    shares: fill.shares,
    feeAmount: fill.feeAmount,
    liquidityRole: fill.liquidityRole,
    evidenceClass: fill.evidenceClass,
    fillModelVersion: fill.fillModelVersion,
    modelTier: fill.model.tier,
    deploymentDecisionUse: fill.model.deploymentDecisionUse,
    planningDepthAwareness: fill.planningDepthAwareness,
    atEventIngestSeq: fill.atEvent.ingestSeq,
  }));

  const ledgerTransactions: ArtifactLedgerTransaction[] = run.parts.store.transactions.map(
    (appended) => ({
      sequence: appended.sequence,
      ledgerTransactionId: appended.transaction.ledgerTransactionId,
      eventType: appended.transaction.eventType,
      environment: appended.transaction.environment,
      accountRef: appended.transaction.accountRef,
      source: appended.transaction.source,
      occurredAt: appended.transaction.occurredAt,
      fillId: appended.transaction.fillId ?? null,
      marketId: appended.transaction.marketId ?? null,
      entries: appended.transaction.entries.map((entry) => ({
        scope: entry.scope,
        accountRef: entry.accountRef,
        assetId: entry.assetId,
        assetKind: entry.assetKind,
        amount: entry.amount,
        instanceId: entry.instanceId ?? null,
        runId: entry.runId ?? null,
        marketId: entry.marketId ?? null,
      })),
    }),
  );

  const pnlRecords: ArtifactPnlRecord[] = run.trader.loop
    .pnlRecords(INSTANCE_ID)
    .map((record) => {
      const plain = record as unknown as Record<string, unknown>;
      const owner = plain["owner"] as Record<string, unknown>;
      return {
        kind: String(plain["kind"]),
        ref: String(plain["ref"]),
        scope: String(owner["scope"]),
        instanceId: nullableString(owner["instanceId"]),
        amount: nullableString(plain["amount"]),
        shares: nullableString(plain["shares"]),
        price: nullableString(plain["price"]),
        side: nullableString(plain["side"]),
        tokenAssetId: nullableString(plain["tokenAssetId"]),
      };
    });

  const balances: ArtifactBalance[] = [...projection.balances.values()]
    .map((line) => ({
      scope: line.scope,
      accountRef: line.accountRef,
      assetId: line.assetId,
      assetKind: line.assetKind,
      balance: line.balance,
    }))
    .sort((left, right) =>
      `${left.scope}|${left.accountRef}|${left.assetId}`.localeCompare(
        `${right.scope}|${right.accountRef}|${right.assetId}`,
        "en",
      ),
    );

  const virtualPositions: ArtifactVirtualPosition[] = [...projection.virtualPositions.values()]
    .map((line) => ({
      instanceId: line.instanceId,
      assetId: line.assetId,
      assetKind: line.assetKind,
      marketId: line.marketId,
      balance: line.balance,
    }))
    .sort((left, right) =>
      `${left.instanceId}|${left.assetId}`.localeCompare(
        `${right.instanceId}|${right.assetId}`,
        "en",
      ),
    );

  const artifactHealth: ArtifactHealth = {
    runMode: health.runMode,
    maximumRunMode: health.maximumRunMode,
    healthy: health.healthy,
    asOf: health.asOf,
    halts: health.halts.map((halt) => {
      const plain = halt as unknown as Record<string, unknown>;
      return {
        scope: JSON.stringify(plain["scope"]),
        code: String(plain["code"]),
        action: String(plain["action"]),
        at: String(plain["at"] ?? plain["haltedAt"] ?? ""),
      };
    }),
    loop: { ...health.loop },
    risk: {
      evaluations: health.risk.evaluations,
      approvals: health.risk.approvals,
      refusals: health.risk.refusals,
      refusedExits: health.risk.refusedExits,
      refusalsByCode: { ...health.risk.refusalsByCode },
      refusedExitsByCode: { ...health.risk.refusedExitsByCode },
      recommendationsByAction: { ...health.risk.recommendationsByAction },
    },
    execution: { ...health.execution },
    accounting: { ...health.accounting },
    seams: {
      fills: { ...health.seams.fills },
      reservations: { ...health.seams.reservations },
      cancels: { ...health.seams.cancels },
      orderViews: { ...health.seams.orderViews },
      allocator: { ...health.seams.allocator },
    },
  };

  const partial: Omit<PaperRunArtifact, "reconciliation"> = {
    goldenFormatVersion: GOLDEN_FORMAT_VERSION,
    scenario: {
      idNamespace: ID_NAMESPACE,
      marketId: MARKET_ID,
      yesTokenId: YES_TOKEN,
      noTokenId: NO_TOKEN,
      instanceId: INSTANCE_ID,
      runId: RUN_ID,
      accountRef: ACCOUNT_REF,
      denominationAssetId: DENOMINATION_ASSET_ID,
      startingCash: STARTING_CASH,
      entryShares: ENTRY_SHARES,
      triggerPriceLte: TRIGGER_PRICE_LTE,
      maximumBuyPrice: MAXIMUM_BUY_PRICE,
      maximumTotalCost: MAXIMUM_TOTAL_COST,
      takeProfitPrice: TAKE_PROFIT_PRICE,
      entryFeePerShare: ENTRY_FEE_PER_SHARE,
      exitFeePerShare: EXIT_FEE_PER_SHARE,
      feeSchedule: {
        snapshotVersion: fees.snapshotVersion,
        takerFeeRate: fees.takerFeeRate,
        makerFeeRate: fees.makerFeeRate,
        roundingDecimalPlaces: fees.roundingDecimalPlaces,
        roundingMode: fees.roundingMode,
        minimumChargedFee: fees.minimumChargedFee,
        feeCurrency: fees.feeCurrency,
      },
    },
    events: recordedEvents().map((event) => ({
      eventId: event.envelope.eventId,
      eventType: event.envelope.eventType,
      source: event.envelope.source,
      ingestSeq: event.identity.ingestSeq,
      receivedAt: event.identity.receivedAt,
      datasetRowOrdinal: event.identity.datasetRowOrdinal,
    })),
    decisions,
    checkpointInstants: [...run.parts.store.checkpointInstants],
    traces: run.trader.loop.traces().map((trace) => ({
      sourceEventId: trace.sourceEventId,
      featureSnapshotRef: trace.featureSnapshotRef,
      runId: trace.runId,
      evaluationSeq: trace.evaluationSeq,
      intentId: trace.intentId,
      approvedIntentId: trace.approvedIntentId,
      executionPlanId: trace.executionPlanId,
      submissionAttemptId: trace.submissionAttemptId,
      venueOrderId: trace.venueOrderId,
      venueFillId: trace.venueFillId,
      ledgerFillId: trace.ledgerFillId,
      ledgerTransactionIds: [...trace.ledgerTransactionIds],
    })),
    orderProvenance: run.trader.loop.orderProvenance().map((record) => ({
      sourceEventId: record.sourceEventId,
      featureSnapshotRef: record.featureSnapshotRef,
      runId: record.runId,
      evaluationSeq: record.evaluationSeq,
      intentId: record.intentId,
      approvedIntentId: record.approvedIntentId,
      executionPlanId: record.executionPlanId,
      submissionAttemptId: record.submissionAttemptId,
      venueOrderId: record.venueOrderId,
    })),
    orders,
    fills,
    ledgerTransactions,
    pnlRecords,
    pnlSnapshots: run.parts.store.pnlSnapshots.map(
      (snapshot) => ({ ...snapshot }) as Readonly<Record<string, unknown>>,
    ),
    ledgerProjection: {
      transactionCount: projection.transactionCount,
      unattributedActivity: projection.unattributedActivity.length,
      unexplainedMovements: projection.unexplainedMovements.length,
      balances,
      virtualPositions,
    },
    health: artifactHealth,
  };

  return { ...partial, reconciliation: buildReconciliation(partial) };
}

/** The canonical bytes of an artefact. This is what the golden holds. */
export function serializeArtifact(artifact: PaperRunArtifact): string {
  return canonicalJson(artifact);
}
