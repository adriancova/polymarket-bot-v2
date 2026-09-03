/**
 * Approved-intent records and RISK RESIZE — handoff §7.7, final paragraph:
 *
 * > "A risk veto never silently mutates an intent. A resize creates a new
 * > approved-intent record linked to the original."
 *
 * Workplan WP-180 acceptance 4: "Risk resize creates a new approved-intent
 * record." Both halves are structural here, not conventional:
 *
 * - the ORIGINAL intent and the ORIGINAL record are deeply frozen, so an
 *   attempted in-place edit THROWS rather than succeeding quietly;
 * - {@link resizeApprovedIntent} returns a NEW record with a new
 *   `approvedIntentId`, `lineage: "RESIZED"`, and `supersedesApprovedIntentId`
 *   / `rootApprovedIntentId` naming the chain it descends from. Reusing the
 *   original id is a typed refusal (`RISK_RESIZE_ID_REUSED`), because a reused
 *   id is how "a new record" quietly becomes "an edited record" in storage.
 *
 * A RESIZE MAY ONLY REDUCE. `|newTargetShares| < |originalTargetShares|`,
 * strictly, and the sign may not flip (`RISK_RESIZE_NOT_A_REDUCTION`,
 * `RISK_RESIZE_INCOHERENT`). Risk shrinks exposure; it does not re-aim a
 * strategy's intent, and a "resize" that grew or reversed a position would be
 * this package originating a trading decision it has no authority to make.
 *
 * WHAT IS NOT RESIZED. Ceilings the strategy set (`maximumTotalCost`,
 * `maximumBuyPrice`, `minimumSellPrice`, `validUntil`) are copied unchanged: a
 * ceiling stays valid under a smaller size, and scaling one would be this
 * package inventing a number the strategy did not supply.
 *
 * WORST-CASE BASIS. The resized record inherits the original's assessment and
 * says so (`worstCaseBasis: "INHERITED_UPPER_BOUND"`). That is a genuine upper
 * bound — a strict share reduction cannot raise committed cost, and
 * `maximumContractualLoss` IS committed cost — but it is not a fresh
 * evaluation, so the field states which it is rather than letting a consumer
 * assume. Re-running {@link evaluateIntent} on the resized intent produces an
 * `"EVALUATED"` record.
 */

import { absDecimal, compareDecimal } from "@polymarket-bot/decimal";
import {
  DetailStringSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  SharesStringSchema,
  type Intent,
  type RunMode,
} from "@polymarket-bot/domain";
import { z } from "zod";

import { deepFreeze } from "./guards.js";
import { identityRefusals } from "./inputs.js";
import type { RiskReasonCode } from "./reasons.js";
import type { IncidentActionRecommendation } from "./recommendations.js";
import { riskFailure, riskOk, riskRefusal, type RiskRefusal, type RiskResult } from "./result.js";
import type { WorstCaseAssessment } from "./worst-case.js";

/** Whether a record's worst case was computed for THIS intent or inherited. */
export type WorstCaseBasis = "EVALUATED" | "INHERITED_UPPER_BOUND";

export type ApprovedIntentLineage = "ORIGINAL" | "RESIZED";

/**
 * One approved intent, as risk records it. Immutable and deeply frozen.
 *
 * IDENTITY AND LINEAGE (workplan acceptance 4): `approvedIntentId` is this
 * record's own identity; `supersedesApprovedIntentId` names the record it
 * replaces (absent on an `ORIGINAL`); `rootApprovedIntentId` names the head of
 * the chain, so an arbitrarily long resize chain is traceable in one hop;
 * `sourceIntentId` is the strategy's own `intentId` where §7.7 gives the shape
 * one (`CANCEL` and `REDUCE_POSITION` carry none, so it is absent for them).
 */
export interface ApprovedIntentRecord {
  readonly approvedIntentId: string;
  readonly lineage: ApprovedIntentLineage;
  readonly supersedesApprovedIntentId?: string;
  readonly rootApprovedIntentId: string;
  readonly sourceIntentId?: string;
  /** The exact intent approved. Frozen; a resize never edits it. */
  readonly intent: Intent;
  /** Caller-supplied instant (no clock in this package). */
  readonly approvedAt: string;
  readonly runMode: RunMode;
  readonly strategyInstanceId: string;
  /** Why it was approved — always non-empty, always from the package vocabulary. */
  readonly reasons: readonly RiskReasonCode[];
  readonly worstCase: WorstCaseAssessment;
  readonly worstCaseBasis: WorstCaseBasis;
  /** Recommendations the §9.9 controller may act on. Never actions. */
  readonly recommendations: readonly IncidentActionRecommendation[];
  /** Present only on a `RESIZED` record. */
  readonly resizeReason?: string;
}

export const ResizeRequestSchema = z.strictObject({
  /** The NEW record's identity. Must differ from the record being resized. */
  approvedIntentId: NonEmptyStringSchema,
  /** Caller-supplied instant. */
  resizedAt: IsoTimestampSchema,
  newTargetShares: SharesStringSchema,
  reason: DetailStringSchema,
});
export type ResizeRequest = z.infer<typeof ResizeRequestSchema>;

/** The intent shapes a risk resize can act on. */
function resizableTargetShares(intent: Intent): string | undefined {
  return intent.type === "POSITION" || intent.type === "REDUCE_POSITION"
    ? intent.targetShares
    : undefined;
}

function signOf(value: string): -1 | 0 | 1 {
  const comparison = compareDecimal(value, "0");
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}

/**
 * Creates a NEW approved-intent record that resizes `record` downward.
 *
 * NEVER mutates `record`: the returned value is a distinct, deeply-frozen
 * object, and `record.intent` is returned untouched by identity.
 */
export function resizeApprovedIntent(
  record: ApprovedIntentRecord,
  request: unknown,
): RiskResult<ApprovedIntentRecord> {
  const parsed = ResizeRequestSchema.safeParse(request);
  if (!parsed.success) {
    return riskFailure(
      riskRefusal("RISK_INPUT_INVALID", "resize request failed validation", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    );
  }
  const req = parsed.data;
  const refusals: RiskRefusal[] = [];

  // --- ADR-016 §2 identity validation — the input surface of THIS function ---
  //
  // Both arguments are input. `request` is caller data; `record` is TYPED as an
  // `ApprovedIntentRecord` but is not parsed at runtime, so a hand-built one can
  // carry anything — and every identity field below is copied INTO the new
  // record (`supersedesApprovedIntentId`, `rootApprovedIntentId`,
  // `sourceIntentId`, `strategyInstanceId`, and the intent's own `intentId`).
  // Validating them here is what makes "no path emits a contract-invalid
  // approved record" true of this function too, not only of `evaluateIntent`
  // (adversarial review round 2). Refuse, never case-fold; the raw value rides
  // out on the refusal. Venue-supplied opaque ids are out of scope for the same
  // reason as in `inputs.ts`.
  refusals.push(
    ...identityRefusals([
      { field: "request.approvedIntentId", value: req.approvedIntentId },
      { field: "record.approvedIntentId", value: record.approvedIntentId },
      { field: "record.rootApprovedIntentId", value: record.rootApprovedIntentId },
      { field: "record.supersedesApprovedIntentId", value: record.supersedesApprovedIntentId },
      { field: "record.sourceIntentId", value: record.sourceIntentId },
      { field: "record.strategyInstanceId", value: record.strategyInstanceId },
      ...("intentId" in record.intent
        ? [{ field: "record.intent.intentId", value: record.intent.intentId }]
        : []),
    ]),
  );

  if (
    req.approvedIntentId === record.approvedIntentId ||
    req.approvedIntentId === record.rootApprovedIntentId
  ) {
    refusals.push(
      riskRefusal(
        "RISK_RESIZE_ID_REUSED",
        "a resize must create a NEW approved-intent record; reusing an id in the lineage would edit the original in storage (§7.7)",
        {
          requested: req.approvedIntentId,
          approvedIntentId: record.approvedIntentId,
          rootApprovedIntentId: record.rootApprovedIntentId,
        },
      ),
    );
  }

  const originalShares = resizableTargetShares(record.intent);
  if (originalShares === undefined) {
    refusals.push(
      riskRefusal(
        "RISK_RESIZE_UNSUPPORTED_TYPE",
        "only POSITION and REDUCE_POSITION intents carry a single resizable targetShares; a QUOTE ladder or BASKET leg set is re-proposed by the strategy, not resized here (fail closed)",
        { intentType: record.intent.type },
      ),
    );
  } else {
    const originalSign = signOf(originalShares);
    const newSign = signOf(req.newTargetShares);
    if (newSign !== 0 && originalSign !== 0 && newSign !== originalSign) {
      refusals.push(
        riskRefusal(
          "RISK_RESIZE_INCOHERENT",
          "a resize may not flip the side of the original intent; risk shrinks exposure, it does not re-aim a strategy's decision (§7.7)",
          { originalTargetShares: originalShares, newTargetShares: req.newTargetShares },
        ),
      );
    }
    if (compareDecimal(absDecimal(req.newTargetShares), absDecimal(originalShares)) >= 0) {
      refusals.push(
        riskRefusal(
          "RISK_RESIZE_NOT_A_REDUCTION",
          "a risk resize must strictly reduce the magnitude of targetShares",
          { originalTargetShares: originalShares, newTargetShares: req.newTargetShares },
        ),
      );
    }
  }

  if (refusals.length > 0) {
    return riskFailure(...refusals);
  }

  // Narrowed by `resizableTargetShares` above; rebuilt rather than mutated.
  const resizedIntent: Intent =
    record.intent.type === "POSITION"
      ? { ...record.intent, targetShares: req.newTargetShares }
      : record.intent.type === "REDUCE_POSITION"
        ? { ...record.intent, targetShares: req.newTargetShares }
        : record.intent;

  const reasons: RiskReasonCode[] = [...record.reasons];

  return riskOk(
    deepFreeze({
      approvedIntentId: req.approvedIntentId,
      lineage: "RESIZED" as const,
      supersedesApprovedIntentId: record.approvedIntentId,
      rootApprovedIntentId: record.rootApprovedIntentId,
      ...(record.sourceIntentId === undefined ? {} : { sourceIntentId: record.sourceIntentId }),
      intent: resizedIntent,
      approvedAt: req.resizedAt,
      runMode: record.runMode,
      strategyInstanceId: record.strategyInstanceId,
      reasons,
      worstCase: record.worstCase,
      worstCaseBasis: "INHERITED_UPPER_BOUND" as const,
      recommendations: record.recommendations,
      resizeReason: req.reason,
    }),
  );
}
