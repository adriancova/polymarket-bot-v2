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
  Uuidv7Schema,
  type Intent,
} from "@polymarket-bot/domain";

import { FreshnessObservationSchema } from "./freshness.js";
import { ownProperty, uuidShapedNotCanonical } from "./guards.js";
import { appendData, readPlainData } from "./plain-data.js";
import { SCENARIO_KINDS } from "./policy.js";
import { contained, riskRefusal, type RiskRefusal } from "./result.js";
import { prototypeFreeParser } from "./schema-arena.js";

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
    /**
     * The strategy instance this evaluation is for — an IDENTITY, not a code
     * token (ADR-021, accepted 2026-09-06).
     *
     * IT WAS `CodeStringSchema` UNTIL `WP-180-FU3`, and that was a mis-typing
     * with a measured consequence. `CodeStringSchema`'s grammar requires a
     * LEADING LETTER; a UUIDv7's first hex digit is the top nibble of its
     * 48-bit millisecond timestamp, and that nibble is `0` for every instant
     * before ~2527. So NO honestly-minted UUIDv7 could pass this door, while
     * `packages/ledger`'s `AllocationClaim.instanceId` and `packages/pnl`'s
     * `PnlOwner.instanceId` — the same value, one layer down — require exactly
     * one. `apps/trader` shipped an intersection grammar (a UUID shape whose
     * first digit happens to be a letter) to keep the three doors satisfiable
     * at all, and ADR-021 ruled THIS door the wrong one: an instance id is a
     * minted identity like `runId`, `configId` and `marketId`, all of which are
     * UUIDs, and nothing depends on the letter-first property.
     *
     * The change is a WIDENING on the honest population — every id the trader
     * can mint today — and a narrowing only on code-shaped strings that no
     * other door in this repository ever admitted.
     *
     * `Uuidv7Schema` carries its format as a CHECK, so the arena copies it with
     * the rest of this schema and the format survives a polluted `skipChecks`
     * (`schema-arena.ts`'s header measures that class; the pin for THIS field
     * is `test/unit/risk/schema-arena.test.ts`).
     */
    strategyInstanceId: Uuidv7Schema,
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
 * The door's parsing copy of the schema above (review round 8).
 *
 * Same validation, node for node — see `schema-arena.ts` — but its output is
 * assembled onto containers with NO PROTOTYPE, and its parse context has none
 * either. The schema above stays the public, inferable one; this is the one the
 * door asks. Built once, at module load: a schema the arena cannot copy is a
 * build failure rather than an unprotected parse.
 */
const RiskEvaluationInputParser = prototypeFreeParser(RiskEvaluationInputSchema);

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
  const ownIntentId = ownProperty(intent, "intentId");
  // `Object.hasOwn`, NOT `"intentId" in intent` (review round 6, BLOCKER 2).
  // `in` answers for an INHERITED name, and both directions were wrong:
  //
  // - an inherited NON-CANONICAL UUID made an otherwise valid CANCEL — which
  //   carries no `intentId` at all — refuse with `RISK_UUID_NOT_CANONICAL`.
  //   That is the CANCEL TRAP §6 invariant 13 exists to prevent, arriving
  //   through the one door a cancel cannot bypass;
  // - an inherited THROWING getter turned this function, and with it
  //   `validateEvaluationInput`, into a throw.
  //
  // An identifier this repository generated is a field the intent OWNS. (The
  // input tree is prototype-free since round 6, so this can no longer be
  // reached through the door either; the own test is the site's own guarantee,
  // not a second copy of that one.)
  return [
    { field: "identifiers.approvedIntentId", value: data.identifiers.approvedIntentId },
    { field: "context.strategyInstanceId", value: data.context.strategyInstanceId },
    ...(ownIntentId.present ? [{ field: "intent.intentId", value: ownIntentId.value }] : []),
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
    appendData(
      refusals,
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
 *
 * THIS FUNCTION DOES NOT THROW (review round 6, BLOCKER 3, non-negotiable).
 * Round 5 wrapped `evaluateIntent` but not this function, and the reviewer's
 * inherited THROWING getter proved the difference: `evaluateIntent` answered
 * `RISK_INPUT_INVALID` while `validateEvaluationInput` — which returns a typed
 * validation union and is exported for a caller to use directly — threw. The
 * site is fixed (`internalIdentityFields` tests own-ness), and the function now
 * also runs inside the containment guard, because a door that answers with an
 * exception has no defined behaviour for the caller standing in it.
 *
 * AND IT DOES NOT REFUSE A CANCEL FOR SOMEBODY ELSE'S BOOKKEEPING (review round
 * 7, BLOCKER). Round 6 made this function refuse whenever the schema's OUTPUT
 * came back smaller than the input, which under a get-only inherited accessor it
 * silently does. The reviewer's probe was a valid `CANCEL` with an intact
 * `intent.reason` and a get-only `Object.prototype.reason`: the parse succeeded,
 * the output had dropped the field, and the door answered `RISK_INPUT_INVALID`.
 * The lost field was an artefact of the LIBRARY'S output assembly, not of the
 * caller's input, so §6 invariant 13 protects that cancel and the refusal was
 * wrong. The fix is not a narrower check — it is that this function no longer
 * reads the library's output at all (see the body, and proposition 5 in
 * `plain-data.ts`).
 *
 * AND NOT READING THAT OUTPUT WAS NOT ENOUGH (review round 8, BLOCKER).
 * Discarding the library's output does not stop the library BUILDING it, and it
 * builds it by ASSIGNMENT onto an ordinary object — so an inherited SETTER runs
 * during the assembly, and a THROWING one aborted the parse. The reviewer's
 * probe was again a valid `CANCEL` with its own `intent.reason` and a throwing
 * `Object.prototype.reason`: `setterCalls=1, approved=false,
 * ["RISK_INPUT_INVALID"]`, the cancel trapped before the choke point could see
 * it. "Ignore an assembly failure and answer valid" is NOT the fix — measured,
 * it is a FAIL-OPEN, because the library validates and assigns key by key, so
 * the abort leaves every later key unvalidated (transcript in
 * `schema-arena.ts`). The fix is that the assembly can no longer reach a
 * polluted prototype: this door parses through {@link RiskEvaluationInputParser},
 * whose containers and parse context have NO PROTOTYPE. Under a throwing or an
 * accepting inherited setter the answer is now byte-identical to the clean one
 * and the setter is invoked ZERO times.
 */
export function validateEvaluationInput(input: unknown): RiskInputValidation {
  return contained(
    () => validateEvaluationInputInner(input),
    (thrown) => ({
      ok: false,
      refusals: [
        riskRefusal(
          "RISK_INPUT_INVALID",
          "validating the evaluation input failed unexpectedly; an input that cannot be validated is not a validated input (fail closed)",
          { thrown },
        ),
      ],
    }),
  );
}

function validateEvaluationInputInner(input: unknown): RiskInputValidation {
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
  const parsed = RiskEvaluationInputParser.safeParse(read.value);
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
  // THE VALIDATED INPUT IS THE MATERIALIZED TREE, NOT THE PARSE OUTPUT
  // (review round 7; see proposition 5 in `plain-data.ts`).
  //
  // The schema was asked a QUESTION and it answered `success`. Its OUTPUT is a
  // separate object it assembles by assignment on an object it created with
  // `{}`, and that assembly is not trustworthy: it ADOPTS an inherited field,
  // and an inherited GET-ONLY accessor makes the assignment fail so a field
  // VANISHES from the output while the parse still reports success. Round 6
  // answered the second by refusing any output smaller than the input, and the
  // reviewer's round-7 probe showed what that costs — a get-only
  // `Object.prototype.reason`, a CANCEL whose own `intent.reason` was intact,
  // and the door refused it: `lost: ["input.intent.reason"]`, a valid cancel
  // trapped by an artefact of somebody else's output assembly (§6 invariant 13).
  //
  // `read.value` is this package's own tree: own data, no prototype, built one
  // `defineProperty` at a time, and the exact bytes the schema just validated.
  // `RiskEvaluationInputSchema` contributes NOTHING of its own — no default, no
  // transform, no coercion — so the validated value and the read value are the
  // same value. That is not an assumption: `test/unit/risk/schema-output.test.ts`
  // walks the schema and fails if any value-producing node is ever added to it.
  const data = read.value as RiskEvaluationInput;
  const refusals = identityRefusals(internalIdentityFields(data));
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, data };
}
