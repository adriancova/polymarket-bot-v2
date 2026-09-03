/**
 * Evaluation input views.
 *
 * Everything the §9.8 pipeline consumes arrives HERE, caller-supplied and
 * validated: this package reads no clock, opens no connection, and queries
 * nothing. A required view that is absent makes the affected check FAIL
 * CLOSED — unknown blocks, never permits.
 *
 * Two views are STRUCTURAL PORTS from `@polymarket-bot/capital-allocator`
 * (`allocation`, `exposures`): the two packages share layer 1 and
 * `docs/contracts/dependency-direction.md` §2.1 lists no edge between them,
 * so the shapes are mirrored structurally (loose objects — this package reads
 * the named fields and ignores the rest) and pinned by the compile-time
 * assignability test in `test/unit/risk/` (the WP-110 universe↔settlement
 * precedent, strengthened: the pin is `tsc`-checked, not source-text-parsed).
 *
 * THIS MODULE OWNS THE WHOLE INPUT SURFACE. {@link validateEvaluationInput} is
 * the single door into the §9.8 pipeline: it parses the schema AND applies
 * ADR-016 §2 identity validation, and it answers before any disposition exists.
 * See the block comment on that function — a well-formedness rule belongs HERE,
 * never as a pipeline gate.
 */

import { z } from "zod";

import {
  CodeStringSchema,
  IntentSchema,
  InternalMarketIdSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
  NonNegativeMoneyStringSchema,
  NonNegativeSharesStringSchema,
  OutcomeSideSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  RunModeSchema,
  type Intent,
} from "@polymarket-bot/domain";

import { FreshnessObservationSchema } from "./freshness.js";
import { uuidShapedNotCanonical } from "./guards.js";
import { readPlainData } from "./plain-data.js";
import { SCENARIO_KINDS } from "./policy.js";
import { riskRefusal, type RiskRefusal } from "./result.js";

/** Scope attribution for the §9.7 exposure dimensions (from the universe layer). */
export const ScopeAttributionSchema = z.strictObject({
  seriesKey: CodeStringSchema.optional(),
  underlyingKey: CodeStringSchema.optional(),
  resolutionWindowKey: CodeStringSchema.optional(),
});
export type ScopeAttribution = z.infer<typeof ScopeAttributionSchema>;

/** Per-market context. Absent optional fields mean UNKNOWN and fail closed. */
export const MarketContextSchema = z.strictObject({
  marketId: InternalMarketIdSchema,
  /** `UNKNOWN` is a legitimate, explicitly-stated ignorance. */
  status: z.enum(["ACTIVE", "CLOSE_ONLY", "HALTED", "UNKNOWN"]),
  tickSize: PositiveDecimalStringSchema.optional(),
  minimumOrderSize: PositiveDecimalStringSchema.optional(),
  parametersVersion: NonNegativeIntegerSchema.optional(),
  secondsToClose: NonNegativeIntegerSchema.optional(),
  /**
   * Structural echo of the universe readiness answer (WP-110
   * `evaluateMarketReadiness`): may model-dependent activation proceed?
   */
  settlement: z
    .looseObject({ modelDependentActivationAllowed: z.boolean() })
    .optional(),
  /** §9.8 check 8. Absent = unknown = fail closed. */
  bookSynchronized: z.boolean().optional(),
  scope: ScopeAttributionSchema.optional(),
});
export type MarketContext = z.infer<typeof MarketContextSchema>;

/** The strategy's own virtual position view (§6 invariant 7). */
export const PortfolioPositionSchema = z.strictObject({
  marketId: InternalMarketIdSchema,
  side: OutcomeSideSchema,
  shares: NonNegativeSharesStringSchema,
  costBasis: NonNegativeMoneyStringSchema,
});
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;

export const PortfolioOpenOrderSchema = z.strictObject({
  /**
   * WHICH ORDER IDENTIFIER THIS IS, IS NOT ESTABLISHED (review round 4).
   *
   * The type here is `NonEmptyString` and nothing more. The repository has TWO
   * order identifiers — an in-process `execution.orders.order_id
   * internal.uuid_v7` and a separate `venue_order_id`
   * (`db/migrations/0005_execution.up.sql`) — and no contract says which one a
   * composition root will put here. Earlier text in this file asserted it was
   * "venue-supplied (§7.2 `VenueOrderId`)"; that assertion is withdrawn, and
   * the annotation is a contract-owner follow-up (`docs/handoffs/WP-180.md`,
   * R3-2). Nothing in this package depends on the answer today — see
   * {@link internalIdentityFields}.
   */
  orderId: NonEmptyStringSchema,
  marketId: InternalMarketIdSchema,
  side: OutcomeSideSchema,
  action: z.enum(["BUY", "SELL"]),
  price: PriceStringSchema,
  shares: PositiveDecimalStringSchema,
});
export type PortfolioOpenOrder = z.infer<typeof PortfolioOpenOrderSchema>;

export const PortfolioViewSchema = z.strictObject({
  positions: z.array(PortfolioPositionSchema).readonly(),
  openOrders: z.array(PortfolioOpenOrderSchema).readonly(),
});
export type PortfolioView = z.infer<typeof PortfolioViewSchema>;

/**
 * STRUCTURAL PORT — one exposure entry as
 * `@polymarket-bot/capital-allocator` publishes it. Loose: the allocator adds
 * `combined`, which this package deliberately RECOMPUTES from the two
 * components rather than trusting.
 */
export const ExposureEntryViewSchema = z.looseObject({
  openOrderCommitted: NonNegativeMoneyStringSchema,
  positionCommitted: NonNegativeMoneyStringSchema,
});
export type ExposureEntryView = z.infer<typeof ExposureEntryViewSchema>;

/**
 * STRUCTURAL PORT — the allocator's whole exposure snapshot.
 *
 * THE SCOPE MAPS MAY BE SPARSE, AND SPARSE IS NOT ZERO. This schema cannot
 * express "complete for the scopes this evaluation will query" — the query set
 * is not known until the intent is normalized — so completeness is enforced
 * where it can be: `exposure-limits.ts` refuses
 * (`RISK_EXPOSURE_ENTRY_MISSING`) when a configured cap's queried key is absent
 * from its table, rather than reading the absence as zero exposure (review
 * round 1, BLOCKER 2). A caller states "this scope holds nothing" with an
 * EXPLICIT zero entry; `@polymarket-bot/capital-allocator`'s
 * `exposureSnapshotCovering` produces exactly that for a declared key set.
 *
 * `global` is REQUIRED: an account-wide total is always well defined, so its
 * absence is a malformed snapshot rather than an unqueried scope.
 */
export const ExposureSnapshotViewSchema = z.looseObject({
  global: ExposureEntryViewSchema,
  byStrategyInstance: z.record(z.string(), ExposureEntryViewSchema),
  byMarket: z.record(z.string(), ExposureEntryViewSchema),
  bySeries: z.record(z.string(), ExposureEntryViewSchema),
  byUnderlying: z.record(z.string(), ExposureEntryViewSchema),
  byResolutionWindow: z.record(z.string(), ExposureEntryViewSchema),
});
export type ExposureSnapshotView = z.infer<typeof ExposureSnapshotViewSchema>;

/**
 * STRUCTURAL PORT — the allocator's reservation verdict (§9.8 check 14:
 * balance, allowance, inventory, and reservations). Loose: the permitted arm
 * carries the reservation, which this package does not read.
 */
export const AllocationVerdictViewSchema = z.looseObject({
  permitted: z.boolean(),
  refusals: z
    .array(z.looseObject({ code: z.string() }))
    .readonly()
    .optional(),
});
export type AllocationVerdictView = z.infer<typeof AllocationVerdictViewSchema>;

/** One scenario's shocked marks (§9.8 check 17). Exact decimals only. */
export const ScenarioViewSchema = z.strictObject({
  scenarioId: CodeStringSchema,
  kind: z.enum(SCENARIO_KINDS),
  /** Shocked YES mark per market; NO is `1 − yes`, computed exactly. */
  marks: z
    .array(z.strictObject({ marketId: InternalMarketIdSchema, yesPrice: PriceStringSchema }))
    .readonly(),
});
export type ScenarioView = z.infer<typeof ScenarioViewSchema>;

export const RiskEvaluationInputSchema = z.strictObject({
  /** The §7.7 intent, validated against the frozen domain contract. */
  intent: IntentSchema,

  /** Caller-supplied evaluation instant (no clock in this package). */
  evaluatedAt: IsoTimestampSchema,

  /** The id the approved-intent record receives IF the intent is approved. */
  identifiers: z.strictObject({
    approvedIntentId: NonEmptyStringSchema,
  }),

  context: z.strictObject({
    runMode: RunModeSchema,
    strategyInstanceId: CodeStringSchema,
    /** §9.8 check 1, caller-computed for THIS intent. */
    runStatePermitsIntent: z.boolean(),
    strategyStatePermitsIntent: z.boolean(),
    /** §9.8 check 4; consulted only when the run mode places real orders. */
    venueEligibility: z
      .enum(["ELIGIBLE", "BLOCKED", "CLOSE_ONLY", "FAILED", "AMBIGUOUS"])
      .optional(),
  }),

  /** Context for every market the intent touches; a missing one fails closed. */
  markets: z.array(MarketContextSchema).readonly(),

  /** Caller-measured staleness (§9.8 check 7). */
  freshness: z.array(FreshnessObservationSchema).readonly(),

  portfolio: PortfolioViewSchema,

  /** §9.8 check 15 input; absent + configured cap = fail closed. */
  exposures: ExposureSnapshotViewSchema.optional(),

  /** §9.8 check 14 input; absent = fail closed. */
  allocation: AllocationVerdictViewSchema.optional(),

  scenarios: z.array(ScenarioViewSchema).readonly(),

  guards: z.strictObject({
    /**
     * Intent ids recently evaluated (§9.8 check 18 duplicate guard). The
     * caller states an EXPLICIT empty list when there are none.
     */
    recentIntentIds: z.array(NonEmptyStringSchema).readonly(),
  }),

  rateLimit: z.strictObject({
    /** Absent = unknown = entries fail closed (§9.8 check 19). */
    availableRequests: NonNegativeIntegerSchema.optional(),
  }),

  economics: z.strictObject({
    /** Estimated fees for the intended order(s). */
    feeEstimate: NonNegativeMoneyStringSchema.optional(),
    /** Estimated slippage cost. */
    slippageEstimate: NonNegativeMoneyStringSchema.optional(),
  }),
});
export type RiskEvaluationInput = z.infer<typeof RiskEvaluationInputSchema>;

/**
 * The REPOSITORY-INTERNAL identifiers this input carries, with their paths.
 *
 * ADR-016 §2 (2026-09-02 amendment) rules that a UUID-shaped identifier
 * arriving at an external input surface must already be canonical lowercase,
 * and that a non-canonical spelling is "a typed refusal at that surface,
 * carrying the raw value … never truncation, never a silent repair, never a
 * case-fold". The rule's own justification is that "every UUID in these
 * contracts is generated in-process", so a mixed-case arrival is evidence of a
 * transforming pipeline in the CALLER.
 *
 * WHAT IS IN SCOPE: identifiers this repository generates. `approvedIntentId`
 * (the record's own identity and its lineage root), `strategyInstanceId`, the
 * intent's own `intentId`, and the duplicate-guard list — which is compared
 * against `intentId`, so a re-cased entry there silently under-matches §9.8
 * check 18 instead of failing.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE, AND ON WHAT AUTHORITY. Corrected
 * 2026-09-03 (adversarial review round 4): the earlier text here put two fields
 * in one clause and claimed both were "VENUE-supplied … (§7.2 `VenueOrderId`)".
 * That is true of one of them and NOT ESTABLISHED of the other, and the two are
 * out of scope for different reasons.
 *
 * - `CancelIntent.orderIds` — venue-supplied BY CONTRACT: the frozen domain
 *   schema types it `z.array(VenueOrderIdSchema)`
 *   (`packages/domain/src/intents.ts`). ADR-016 §2's amendment says the ruling
 *   "does not touch any venue wire format (venue identifiers are not UUIDs;
 *   their rules are ADR-015's)", and its in-process-generation premise is false
 *   for these: a venue string must be round-tripped exactly as the venue
 *   spelled it, so refusing one would reject a legitimate value — and, on a
 *   `CANCEL`, would trap a position for a rule ADR-016 does not impose (§6
 *   invariant 13).
 * - `portfolio.openOrders[].orderId` — PROVENANCE UNDETERMINED. It is typed
 *   only `NonEmptyStringSchema` above, and the repository holds both an
 *   in-process `execution.orders.order_id internal.uuid_v7` and a separate
 *   `venue_order_id` column (`db/migrations/0005_execution.up.sql`), so the
 *   name settles nothing. It stays out of scope on a NARROWER ground that does
 *   not depend on provenance: this function is the door that also admits a
 *   `CANCEL`, so a refusal here can trap a position, while the field itself
 *   never reaches an approved record — `approved-intent.ts` governs what an
 *   emitted record may carry, and no emitted record carries a portfolio. If the
 *   contract owner rules "repository-generated", the check belongs at that
 *   boundary rather than at this door. Recorded as a contract-owner follow-up
 *   (`docs/handoffs/WP-180.md`, R3-2).
 *
 * Market ids need no entry here: `InternalMarketIdSchema` is lowercase-canonical
 * UUIDv7 already, so the schema above refuses a re-cased one as
 * `RISK_INPUT_INVALID`.
 */
function internalIdentityFields(
  data: RiskEvaluationInput,
): readonly { readonly field: string; readonly value: unknown }[] {
  const intent: Intent = data.intent;
  return [
    { field: "identifiers.approvedIntentId", value: data.identifiers.approvedIntentId },
    { field: "context.strategyInstanceId", value: data.context.strategyInstanceId },
    ...("intentId" in intent ? [{ field: "intent.intentId", value: intent.intentId }] : []),
    ...data.guards.recentIntentIds.map((value, index) => ({
      field: `guards.recentIntentIds[${index}]`,
      value,
    })),
  ];
}

/**
 * Refusals for every ADR-016 §2 identity violation in `data`, raw values kept.
 *
 * Total and non-throwing on a hand-built object: a non-string value cannot be
 * a non-canonical UUID, so it is left to the schema (or, for the record shapes
 * `approved-intent.ts` reuses this on, to the caller's own type checking).
 * ALL violations are reported; the check does not stop at the first.
 */
export function identityRefusals(
  fields: readonly { readonly field: string; readonly value: unknown }[],
): readonly RiskRefusal[] {
  const refusals: RiskRefusal[] = [];
  for (const { field, value } of fields) {
    if (typeof value !== "string" || !uuidShapedNotCanonical(value)) continue;
    refusals.push(
      riskRefusal(
        "RISK_UUID_NOT_CANONICAL",
        "a repository identifier is UUID-shaped but not canonical lowercase (ADR-016 §2: refuse at the input surface, never case-fold)",
        { field, value },
      ),
    );
  }
  return refusals;
}

/** A validated input, or the typed refusals that stopped it at the door. */
export type RiskInputValidation =
  | { readonly ok: true; readonly data: RiskEvaluationInput }
  | { readonly ok: false; readonly refusals: readonly RiskRefusal[] };

/**
 * INPUT VALIDATION — the single door into `evaluateIntent`.
 *
 * WHY THIS IS ONE FUNCTION, AND WHY IDENTITY VALIDATION LIVES IN IT
 * (adversarial review round 2, BLOCKER).
 *
 * §6 invariant 13 makes a `CANCEL` immune to every RISK gate: `engine.ts` has a
 * structural choke point that turns any refusal the pipeline accumulated into a
 * non-blocking observation. Remediation round 1 left the ADR-016 identity check
 * inside that pipeline, so a `CANCEL` carrying a UUID-shaped, NON-CANONICAL
 * `approvedIntentId` was APPROVED and the id was copied verbatim into the
 * emitted record — a contract-invalid record, which ADR-016 §2 forbids
 * ("none may accept uppercase 'just for lookups'").
 *
 * Review round 2 ruled the boundary: `evaluateIntent(policy, input: unknown)`
 * IS an input surface, and "safety cancellation outranks new order placement"
 * does not authorize emitting a contract-invalid record. The two invariants do
 * not collide — §6 invariant 13 protects a VALID cancel from being trapped by
 * risk policy; it does not require accepting a malformed identity.
 *
 * So the rule is now: a request whose identity is malformed never becomes a
 * request at all. This function answers BEFORE `buildIntentView`, so there is
 * no disposition to privilege and nothing for the choke point to override — the
 * same standing the schema refusal already had.
 *
 * THE ID IS NEVER NORMALIZED. ADR-016 §2 is refuse-not-fold: the raw value
 * rides back out on `details.value` and no lowercased form is ever produced.
 *
 * DO NOT move a well-formedness check out of this function into the pipeline,
 * and DO NOT add an early `return` between here and the choke point.
 * `test/unit/risk/engine.test.ts` ("ADR-016 §2 — record identity is INPUT
 * VALIDATION, never a cancel override") fails if you do.
 *
 * THE INPUT IS READ AS DATA BEFORE IT IS PARSED (review round 5, BLOCKER 3).
 * `safeParse` is not a safe way to LOOK at a caller's object: `zod` reads
 * properties, so a getter runs, and a getter that throws escapes as an
 * exception from the one function whose entire job is to answer "is this input
 * acceptable?" with a refusal. The reviewer's probe was a valid `CANCEL`
 * representation with a throwing `identifiers` getter: it threw, so the cancel
 * never reached the §6 invariant 13 choke point at all.
 *
 * `readPlainData` materializes the input first — descriptors only, no `Proxy`,
 * no accessor — and the schema then parses THAT. An accessor-bearing
 * representation is still refused, which is correct; what changes is that it is
 * refused as `RISK_INPUT_INVALID` instead of escaping as a `TypeError`. Ordering
 * matters here as much as at the choke point: the read is a well-formedness
 * check, so it belongs in this function, ahead of everything.
 */
export function validateEvaluationInput(input: unknown): RiskInputValidation {
  const read = readPlainData(input, "input");
  if (!read.ok) {
    return {
      ok: false,
      refusals: [
        riskRefusal(
          "RISK_INPUT_INVALID",
          "the evaluation input is not a data record: a request is a finite tree of plain own data, so hidden, inherited, computed or unreadable state is refused rather than inspected (fail closed)",
          { issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`) },
        ),
      ],
    };
  }
  const parsed = RiskEvaluationInputSchema.safeParse(read.value);
  if (!parsed.success) {
    return {
      ok: false,
      refusals: [
        riskRefusal("RISK_INPUT_INVALID", "risk evaluation input failed validation", {
          issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        }),
      ],
    };
  }
  const refusals = identityRefusals(internalIdentityFields(parsed.data));
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, data: parsed.data };
}
