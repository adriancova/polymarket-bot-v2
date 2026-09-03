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
 *
 * THE EMISSION BOUNDARY (adversarial review round 3). Every path in this
 * package that returns an `ApprovedIntentRecord` goes through
 * {@link sealApprovedIntentRecord}, and that function is the only place a
 * record is frozen and handed out. It does not consult a LIST of identity
 * fields — rounds 2 and 3 both proved a list is a thing reviewers outgrow — it
 * WALKS the record it is about to emit and refuses any string that is
 * UUID-shaped but not canonical (ADR-016 §2), wherever it sits. The default is
 * "checked"; the exceptions are {@link NON_IDENTITY_KEYS}, a closed set in
 * which every entry is a string the frozen domain contract types as something
 * other than a repository identifier. A field added to the record tomorrow is
 * therefore validated with no edit here and no edit in the suite.
 */

import { absDecimal, compareDecimal } from "@polymarket-bot/decimal";
import {
  DetailStringSchema,
  IntentSchema,
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

/**
 * Property names whose strings are NOT repository identifiers, and which the
 * ADR-016 §2 walk therefore skips. THE SET IS CLOSED AND EVERY ENTRY CITES THE
 * CONTRACT THAT MAKES IT A NON-IDENTIFIER — a name not listed here is checked,
 * which is the direction that keeps the rule true of fields nobody has written
 * yet:
 *
 * - `orderId` / `orderIds` — §7.2 `VenueOrderId`, an opaque VENUE string.
 *   ADR-016 §2's amendment says the ruling "does not touch any venue wire
 *   format (venue identifiers are not UUIDs; their rules are ADR-015's)", and
 *   its premise ("every UUID in these contracts is generated in-process") is
 *   false for one: a venue string must round-trip exactly as the venue spelled
 *   it. On a `CANCEL` (`CancelIntent.orderIds`) refusing one would trap a
 *   position for a rule the ADR does not impose — §6 invariant 13's direction.
 * - `reason` / `resizeReason` / `rationale` — `DetailString`, "bounded
 *   human-readable text (never parsed, only displayed or logged)"
 *   (`packages/domain/src/primitives.ts`). `CancelIntent.reason` rides on the
 *   cancel path, so an over-refusal here would trap a position too.
 * - `tags` — §7.7 `tags`, typed `Tag` = `CodeString`, "free-form strategy tag".
 *   A tag admits the UUID grammar, but it names nothing this repository looks
 *   up.
 *
 * A KEY-NAME rule, deliberately: a new field is validated by DEFAULT, and the
 * only way to lose that is to name an identity field `reason`, `rationale`,
 * `tags`, or `orderId`. That tradeoff is stated in `docs/handoffs/WP-180.md`
 * (remediation round 3) rather than left implicit.
 */
const NON_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "orderId",
  "orderIds",
  "reason",
  "resizeReason",
  "rationale",
  "tags",
]);

/**
 * Every identity-bearing string reachable in `value`, with the path it sits at.
 *
 * Total and non-throwing on any value, including a hand-built one carrying
 * `undefined`, functions, or cycles: identity validation must never be the
 * thing that throws out of a function whose contract is a typed refusal.
 */
function identityStringsIn(
  value: unknown,
  path: string,
  seen: WeakSet<object> = new WeakSet(),
): { readonly field: string; readonly value: unknown }[] {
  if (typeof value === "string") return [{ field: path, value }];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => identityStringsIn(item, `${path}[${index}]`, seen));
  }
  return Object.entries(value).flatMap(([key, item]) =>
    NON_IDENTITY_KEYS.has(key) ? [] : identityStringsIn(item, `${path}.${key}`, seen),
  );
}

/**
 * ADR-016 §2 refusals for every identity-bearing string inside `value`.
 *
 * Used by the emission boundary and by the resize's inherited-record check;
 * both walk rather than enumerate.
 */
function walkedIdentityRefusals(value: unknown, path: string): readonly RiskRefusal[] {
  return identityRefusals(identityStringsIn(value, path));
}

/**
 * THE SINGLE EMISSION BOUNDARY for approved-intent records.
 *
 * Every path that returns a record — `evaluateIntent`'s two arms and
 * {@link resizeApprovedIntent} — builds a draft and hands it here. This
 * function walks the draft (see {@link NON_IDENTITY_KEYS}) and either refuses
 * with the raw value intact, or freezes and returns it. Freezing lives here so
 * that "emit a record" and "validate the record being emitted" are one act.
 *
 * WHY A WALK AND NOT A FIELD LIST. Review round 2 fixed one field, swept, and
 * found five plus a duplicate guard; review round 3 still found a sixth
 * (`record.intent.marketId`) and this round's probe found the property false at
 * 43 more positions, including `worstCase.perMarket[].marketId` — an internal
 * market id no list had named. Enumerating fields does not establish the
 * property; deriving it from the record's own shape does.
 *
 * NOTHING IS NORMALIZED. ADR-016 §2 is refuse-not-fold: the draft is returned
 * byte-for-byte or not at all, and the refusal carries the raw value.
 */
export function sealApprovedIntentRecord(
  draft: ApprovedIntentRecord,
): RiskResult<ApprovedIntentRecord> {
  const refusals = walkedIdentityRefusals(draft, "record");
  if (refusals.length > 0) return riskFailure(...refusals);
  return riskOk(deepFreeze(draft));
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

  // --- THE INHERITED BOUNDARY — validated BEFORE anything is constructed -----
  //
  // Both arguments are input. `request` is caller data; `record` is TYPED as an
  // `ApprovedIntentRecord` but is NOT parsed at runtime, so a hand-built one can
  // carry anything — and almost all of it is copied INTO the new record.
  //
  // Round 2 validated a LIST of seven identity fields here. Review round 3
  // found the list still incomplete (`record.intent.marketId`), and this
  // round's probe found 43 further positions at which a hand-built record
  // reached an emitted record uninspected — including
  // `worstCase.perMarket[].marketId`, an internal market id no list had named.
  // So the list is gone. Both arguments are WALKED in full: every string at
  // every depth is checked unless its property name is in `NON_IDENTITY_KEYS`,
  // which is what makes completeness a property of the code's shape rather than
  // of anyone's memory. Refuse, never case-fold; the raw value rides out on the
  // refusal.
  refusals.push(...walkedIdentityRefusals(record, "record"));
  refusals.push(...walkedIdentityRefusals(req, "request"));

  // The intent is not merely COPIED, it is COMPUTED ON (`signOf`,
  // `compareDecimal`, `absDecimal` below), so the inherited intent is parsed
  // against the frozen domain contract before any of that runs. Two things this
  // buys, both found by the round-3 probe: a non-canonical `marketId` anywhere
  // in the intent is a typed refusal rather than an emitted record, and a
  // hand-built `targetShares` of `"f1890000-…"` is a typed refusal rather than
  // an `InvalidDecimalStringError` THROWN out of a function whose whole
  // contract is to return one. The parse OUTPUT is deliberately discarded: the
  // record is built from the original values, so nothing can be normalized on
  // the way through.
  const parsedIntent = IntentSchema.safeParse(record.intent);
  if (!parsedIntent.success) {
    refusals.push(
      riskRefusal(
        "RISK_INPUT_INVALID",
        "the inherited intent does not satisfy the frozen §7.7 contract; a resize computes on it, so it is parsed before it is used (fail closed)",
        {
          issues: parsedIntent.error.issues.map(
            (issue) => `record.intent.${issue.path.join(".")}: ${issue.message}`,
          ),
        },
      ),
    );
    // Every check below reads `record.intent`; with it unparsed there is
    // nothing safe to compute, so report what is known and stop.
    return riskFailure(...refusals);
  }

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

  // The draft goes out through the emission boundary like every other record;
  // the boundary is what freezes it. The walk above already covered everything
  // inherited, so the seal cannot refuse today — it is what keeps the property
  // true when a future edit adds a field sourced from somewhere else.
  return sealApprovedIntentRecord(
    {
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
    },
  );
}
