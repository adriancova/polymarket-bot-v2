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
 * checks every string of the record it is about to emit and refuses any that is
 * UUID-shaped but not canonical (ADR-016 §2), wherever it sits. The default is
 * "checked"; the exceptions are {@link NON_IDENTITY_KEYS}, a closed set in
 * which every entry is a string some schema in this repository types as
 * something other than a repository identifier. A field added to the record
 * tomorrow is therefore validated with no edit here and no edit in the suite.
 *
 * THE DATA-RECORD BOUNDARY (adversarial review round 4). Round 3's walk used
 * `Object.entries`, which sees only enumerable own properties — so a
 * non-enumerable, prototype-placed or accessor-backed identity slipped past it,
 * and a throwing getter escaped as an exception from a function whose contract
 * is a typed result. The enumeration primitive had become the new list.
 *
 * The fix is not a better walk; it is refusing to treat a caller-supplied
 * object as a record at all. Both boundaries below now begin by READING their
 * argument into plain own data ({@link readPlainData}, descriptor-based) and
 * then use ONLY that snapshot — for identity validation, for arithmetic, and as
 * the value that is emitted. Two properties follow by construction rather than
 * by argument:
 *
 * - what any walk can see IS what the record carries, because a materialized
 *   record has no hidden, inherited, or computed state left to see;
 * - the emitted record is genuinely deeply immutable: it is a fresh tree of
 *   plain frozen objects, so no post-return edit to a caller's prototype or
 *   getter can change a value read from it.
 *
 * {@link ApprovedIntentRecordSchema} then states the record's complete runtime
 * shape, so "this is an approved-intent record" is checked rather than assumed
 * of a `record` argument that TypeScript alone cannot police.
 *
 * ROUND 5 CORRECTED TWO CLAIMS THIS HEADER USED TO MAKE.
 *
 * 1. It said the read "never invok[es] caller code", flatly. That was false for
 *    a `Proxy`: every reflective operation on one runs a trap, so the read ran
 *    nine of a caller's traps on a nested proxy and accepted the record. The
 *    boundary now refuses a `Proxy` before touching it, by a trap-free
 *    predicate, and `plain-data.ts` states the resulting claim with its
 *    assumptions attached instead of as an absolute.
 * 2. It said the package had "exactly one traversal primitive". Also false:
 *    `deepFreeze` and `exposure-limits.ts` traverse too. What is true is the
 *    thing that matters here — the ADR-016 §2 IDENTITY check walks nothing of
 *    its own; it consumes the inventory the read produced.
 *
 * TOTALITY IS NOW STRUCTURAL. Both public functions below run inside
 * {@link contained}, so an exception cannot leave a function whose contract is a
 * typed result — however wrong an assumption above turns out to be. Three
 * rounds running, the escape was a site nobody had thought of.
 */

import { absDecimal, compareDecimal } from "@polymarket-bot/decimal";
import {
  DetailStringSchema,
  IntentSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  RunModeSchema,
  SharesStringSchema,
  type Intent,
  type RunMode,
} from "@polymarket-bot/domain";
import { z } from "zod";

import { deepFreeze } from "./guards.js";
import { identityRefusals } from "./inputs.js";
import { hardenParsed, readPlainData, type PlainDataString } from "./plain-data.js";
import { RISK_REASON_CODES, type RiskReasonCode } from "./reasons.js";
import {
  IncidentActionRecommendationSchema,
  type IncidentActionRecommendation,
} from "./recommendations.js";
import {
  contained,
  riskFailure,
  riskOk,
  riskRefusal,
  type RiskRefusal,
  type RiskResult,
} from "./result.js";
import { WorstCaseAssessmentSchema, type WorstCaseAssessment } from "./worst-case.js";

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
 * THE COMPLETE RUNTIME SHAPE of {@link ApprovedIntentRecord} (review round 4).
 *
 * `resizeApprovedIntent` takes a `record` argument that TypeScript types but
 * nothing parsed, and almost all of it is copied into the record that comes
 * back out. A type annotation is not a runtime guarantee, so the emission
 * boundary checks the record it is about to emit against this schema: a draft
 * that is not an approved-intent record is a typed refusal, not an emission.
 *
 * HOW STRICT EACH FIELD IS, AND WHY. Vocabulary fields are closed to this
 * package's own lists, `intent` is the frozen domain contract itself (never a
 * copy of its shape kept here — a copy would refuse the day `packages/domain`
 * adds a field, and this schema also runs on the `CANCEL` emission path where a
 * false refusal traps a position). Identifier and decimal fields are typed no
 * more narrowly than their producers guarantee: ADR-016 §2 canonicality is not
 * expressed here but by the identity check below, which names the exact path
 * and carries the raw value, and which round 3 established must not be traded
 * for a vaguer shape refusal.
 *
 * THE OUTPUT IS DISCARDED. This schema validates; it never supplies the value
 * that is emitted. ADR-016 §2 is refuse-not-fold, and a parse output is a
 * second chance to normalize something.
 */
export const ApprovedIntentRecordSchema = z.strictObject({
  approvedIntentId: NonEmptyStringSchema,
  lineage: z.enum(["ORIGINAL", "RESIZED"]),
  supersedesApprovedIntentId: NonEmptyStringSchema.optional(),
  rootApprovedIntentId: NonEmptyStringSchema,
  sourceIntentId: NonEmptyStringSchema.optional(),
  intent: IntentSchema,
  approvedAt: IsoTimestampSchema,
  runMode: RunModeSchema,
  strategyInstanceId: NonEmptyStringSchema,
  reasons: z.array(z.enum(RISK_REASON_CODES)).readonly(),
  worstCase: WorstCaseAssessmentSchema,
  worstCaseBasis: z.enum(["EVALUATED", "INHERITED_UPPER_BOUND"]),
  recommendations: z.array(IncidentActionRecommendationSchema).readonly(),
  resizeReason: DetailStringSchema.optional(),
});

/**
 * Property names whose strings are NOT repository identifiers, and which the
 * ADR-016 §2 identity check therefore skips. THE SET IS CLOSED, AND EVERY ENTRY
 * NAMES THE SCHEMA IN THIS REPOSITORY THAT TYPES IT AS A NON-IDENTIFIER — a
 * name not listed here is checked, which is the direction that keeps the rule
 * true of fields nobody has written yet:
 *
 * - `orderIds` — `CancelIntentSchema.orderIds` is `z.array(VenueOrderIdSchema)`
 *   (`packages/domain/src/intents.ts`): an opaque VENUE string by contract.
 *   ADR-016 §2's amendment says the ruling "does not touch any venue wire
 *   format (venue identifiers are not UUIDs; their rules are ADR-015's)", and
 *   its premise ("every UUID in these contracts is generated in-process") is
 *   false for these: a venue string must round-trip exactly as the venue
 *   spelled it. `orderIds` rides on the `CANCEL` path, so refusing one would
 *   trap a position for a rule the ADR does not impose (§6 invariant 13).
 * - `reason` — `CancelIntentSchema.reason` and
 *   `ReducePositionIntentSchema.reason` are `DetailStringSchema`: "bounded
 *   human-readable text (never parsed, only displayed or logged)"
 *   (`packages/domain/src/primitives.ts`). Also on the cancel path.
 * - `resizeReason` — `ApprovedIntentRecordSchema.resizeReason` above is
 *   `DetailStringSchema`, and its only producer is `ResizeRequestSchema.reason`,
 *   which is the same type.
 * - `rationale` — `IncidentActionRecommendationSchema.rationale`
 *   (`recommendations.ts`) is `DetailStringSchema`. THAT ANNOTATION IS NEW IN
 *   ROUND 4: review round 4 found the field was an unconstrained `string`, so
 *   this entry's stated justification was not backed by any contract. The
 *   annotation was added rather than the exclusion widened.
 * - `tags` — `PositionIntentSchema.tags` / `QuoteIntentSchema.tags` are
 *   `z.array(TagSchema)`; §7.7 calls a tag "free-form". A tag admits the UUID
 *   grammar, but it names nothing this repository looks up.
 *
 * REMOVED IN ROUND 4: singular `orderId`. No field an approved-intent record
 * can carry is typed `VenueOrderId` under that name, and the repository's own
 * `execution.orders` table has an in-process `order_id internal.uuid_v7`
 * ALONGSIDE a separate `venue_order_id` column
 * (`db/migrations/0005_execution.up.sql`) — so the name does not imply "venue".
 * Excluding it was wider than the cited contract; a repository-style uppercase
 * UUID under an `orderId` key is now checked like any other string.
 *
 * A KEY-NAME rule, deliberately: a new field is validated by DEFAULT, and the
 * only way to lose that is to name an identity field `reason`, `resizeReason`,
 * `rationale`, `tags`, or `orderIds`. That tradeoff, and the fact that each
 * exclusion is now bounded by the TYPE its schema gives it (a `resizeReason`
 * longer than a `DetailString`, or a `tag` that is not a `CodeString`, is still
 * refused — by the shape check, not by the identity check), are stated in
 * `docs/handoffs/WP-180.md` (remediation rounds 3 and 4).
 */
const NON_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "orderIds",
  "reason",
  "resizeReason",
  "rationale",
  "tags",
]);

/**
 * ADR-016 §2 refusals for the identity-bearing strings of a materialized value.
 *
 * TAKES THE INVENTORY {@link readPlainData} PRODUCED, and does not enumerate
 * anything itself. That is the round-4 correction in one line: IDENTITY
 * VALIDATION performs no traversal of its own, so there is no second walk to be
 * blind in a different way, and no way to check one view of an object and emit
 * another.
 *
 * (Round 4 stated this as "this package now has exactly one traversal
 * primitive". Review round 5 falsified that — `deepFreeze` in `guards.ts` and
 * the `Object.entries` in `exposure-limits.ts` are traversals too, both over
 * values that have already been materialized or schema-validated. The claim is
 * narrowed to what it was always really about: the identity walk.)
 */
function identityRefusalsFor(strings: readonly PlainDataString[]): readonly RiskRefusal[] {
  return identityRefusals(
    strings
      .filter((entry) => !entry.keys.some((key) => NON_IDENTITY_KEYS.has(key)))
      .map((entry) => ({ field: entry.path, value: entry.value })),
  );
}

/**
 * Reads a caller-supplied value into plain own data, or refuses.
 *
 * A shape this package cannot read AS DATA is a typed `RISK_INPUT_INVALID`
 * refusal naming the path and the reason — never an exception, and never a
 * silent skip. See `plain-data.ts` for what is refused and why.
 */
function readRecordData(
  value: unknown,
  path: string,
):
  | { readonly ok: true; readonly value: unknown; readonly strings: readonly PlainDataString[] }
  | { readonly ok: false; readonly refusal: RiskRefusal } {
  const read = readPlainData(value, path);
  if (read.ok) return read;
  return {
    ok: false,
    refusal: riskRefusal(
      "RISK_INPUT_INVALID",
      "the value is not a data record: a record is a finite tree of plain own data, so hidden, inherited, computed or unreadable state is refused rather than emitted (fail closed)",
      { issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`) },
    ),
  };
}

/**
 * THE SINGLE EMISSION BOUNDARY for approved-intent records.
 *
 * Every path that returns a record — `evaluateIntent`'s two arms and
 * {@link resizeApprovedIntent} — builds a draft and hands it here. This
 * function READS the draft into plain own data, checks every string it read
 * (see {@link NON_IDENTITY_KEYS}) and the record's complete runtime shape (see
 * {@link ApprovedIntentRecordSchema}), and then either refuses with the raw
 * value intact or freezes the materialized record and returns it. Freezing
 * lives here so that "emit a record" and "validate the record being emitted"
 * are one act.
 *
 * WHY NOT A FIELD LIST. Review round 2 fixed one field, swept, and found five
 * plus a duplicate guard; round 3 still found a sixth (`record.intent.marketId`)
 * and its probe found the property false at 43 more positions, including
 * `worstCase.perMarket[].marketId` — an internal market id no list had named.
 * Enumerating fields does not establish the property; deriving it from the
 * record's own shape does.
 *
 * WHY THE RECORD IS RE-BUILT AND NOT MERELY CHECKED. Review round 4 showed that
 * checking a caller's object and then emitting that same object are two
 * different acts: the object can hide a property from the check, inherit one
 * that outlives the freeze, or answer differently the second time it is asked.
 * What is emitted here is the materialized tree — the exact bytes that were
 * checked, and nothing else.
 *
 * NOTHING IS NORMALIZED. ADR-016 §2 is refuse-not-fold: every string is emitted
 * byte-for-byte as it was read, both schemas' outputs are discarded, and a
 * refusal carries the raw value.
 */
export function sealApprovedIntentRecord(
  draft: ApprovedIntentRecord,
): RiskResult<ApprovedIntentRecord> {
  return contained(
    () => {
      const data = readRecordData(draft, "record");
      if (!data.ok) return riskFailure<ApprovedIntentRecord>(data.refusal);
      const refusals: RiskRefusal[] = [...identityRefusalsFor(data.strings)];
      const shape = ApprovedIntentRecordSchema.safeParse(data.value);
      if (!shape.success) {
        refusals.push(
          riskRefusal(
            "RISK_INPUT_INVALID",
            "the record being emitted does not satisfy the approved-intent record contract (fail closed)",
            {
              issues: shape.error.issues.map(
                (issue) => `record.${issue.path.join(".")}: ${issue.message}`,
              ),
            },
          ),
        );
      }
      if (refusals.length > 0) return riskFailure<ApprovedIntentRecord>(...refusals);
      return riskOk(deepFreeze(data.value as ApprovedIntentRecord));
    },
    (thrown) =>
      riskFailure(
        riskRefusal(
          "RISK_INPUT_INVALID",
          "sealing the approved-intent record failed unexpectedly; a record that cannot be sealed is not emitted (fail closed)",
          { thrown },
        ),
      ),
  );
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
 * NEVER MUTATES, NEVER ALIASES, `record`. The returned value is a distinct,
 * deeply-frozen tree that shares no object with the argument: since review
 * round 4 the argument is READ into plain own data before it is used, so the
 * caller cannot reach into an emitted record afterwards — not by editing a
 * sub-object it still holds, not by editing a prototype, not through a getter.
 * `record` itself is never written to.
 */
export function resizeApprovedIntent(
  record: ApprovedIntentRecord,
  request: unknown,
): RiskResult<ApprovedIntentRecord> {
  return contained(
    () => resizeApprovedIntentInner(record, request),
    (thrown) =>
      riskFailure(
        riskRefusal(
          "RISK_INPUT_INVALID",
          "the resize failed unexpectedly; a resize that cannot be computed does not produce a record (fail closed)",
          { thrown },
        ),
      ),
  );
}

function resizeApprovedIntentInner(
  record: ApprovedIntentRecord,
  request: unknown,
): RiskResult<ApprovedIntentRecord> {
  // --- THE REQUEST IS READ AS DATA BEFORE IT IS PARSED (review round 5) -----
  //
  // `request` is a caller-supplied `unknown`, and `safeParse` READS it — so a
  // throwing getter on `reason` or `newTargetShares` escaped this function as
  // an exception rather than becoming a refusal. Round 4 already read the
  // request, but read the zod OUTPUT, which is downstream of the very property
  // reads that were the problem. The read now comes first.
  const requestData = readRecordData(request, "request");
  if (!requestData.ok) return riskFailure(requestData.refusal);

  const parsed = ResizeRequestSchema.safeParse(requestData.value);
  if (!parsed.success) {
    return riskFailure(
      riskRefusal("RISK_INPUT_INVALID", "resize request failed validation", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    );
  }
  // THE PARSE OUTPUT IS HARDENED (review round 6), and this one is not a
  // hypothetical: `zod` assembles its output by ASSIGNMENT, so an inherited
  // GET-ONLY accessor named `approvedIntentId` made the assignment fail, the
  // field vanish from the output, and the following read fall through to the
  // PROTOTYPE — the emitted record's own identity came back as the inherited
  // getter's answer (`"0"`), with the parse still reporting success. Found by
  // `test/unit/risk/inherited-state.test.ts`, which is why that mechanism
  // exists. A truncated request is refused, never resized.
  const hardened = hardenParsed(requestData.value, parsed.data, "request");
  if (!hardened.ok) {
    return riskFailure(
      riskRefusal(
        "RISK_INPUT_INVALID",
        "the validated resize request lost fields between validation and use, so the resize would not be the one that was asked for (fail closed)",
        { lost: [...hardened.lost] },
      ),
    );
  }
  const req = hardened.value as ResizeRequest;
  const refusals: RiskRefusal[] = [];

  // --- THE INHERITED BOUNDARY — read and validated BEFORE anything is built --
  //
  // Both arguments are input. `request` is caller data; `record` is TYPED as an
  // `ApprovedIntentRecord` but is NOT parsed at runtime, so a hand-built one can
  // carry anything — and almost all of it is copied INTO the new record.
  //
  // Round 2 validated a LIST of seven identity fields here. Review round 3
  // found the list still incomplete (`record.intent.marketId`) and its probe
  // found 43 further positions at which a hand-built record reached an emitted
  // record uninspected, so the list became a walk. Review round 4 then found
  // the walk's `Object.entries` blind to a non-enumerable, inherited, or
  // accessor-backed identity, and liable to THROW on one — the enumeration
  // primitive had become the new list.
  //
  // So the record is now READ into plain own data first, and every line below
  // reads `inherited` rather than `record`. That is what closes the class: the
  // value this function validates, computes on, and copies into the new record
  // is one immutable snapshot, taken once, with nothing hidden behind
  // enumerability, a prototype, a getter, or a `Proxy` trap. `request` goes
  // through the same door ABOVE the schema (round 5), so that no value in this
  // function has been trusted on the strength of where it came from.
  const inheritedData = readRecordData(record, "record");
  if (!inheritedData.ok) return riskFailure(inheritedData.refusal);
  // A `record` that is not an object at all reads cleanly AS DATA (`null` and
  // `"x"` are data), so the read cannot be what rejects it — and every line
  // below dereferences it. Round 4 found the unguarded version threw a
  // `TypeError` here, which is the same defect class as the throwing getter:
  // an exception out of a function whose contract is a typed result.
  const inheritedValue: unknown = inheritedData.value;
  if (inheritedValue === null || typeof inheritedValue !== "object") {
    return riskFailure(
      riskRefusal(
        "RISK_INPUT_INVALID",
        "the record to resize is not an approved-intent record (fail closed)",
        { received: inheritedValue === null ? "null" : typeof inheritedValue },
      ),
    );
  }
  const inherited = inheritedValue as ApprovedIntentRecord;

  // Refuse, never case-fold; the raw value rides out on the refusal.
  refusals.push(...identityRefusalsFor(inheritedData.strings));
  refusals.push(...identityRefusalsFor(requestData.strings));

  // THE INHERITED RECORD IS PARSED IN FULL, not just walked. Round 3 parsed
  // only `record.intent`, because that is what the arithmetic below reads.
  // Review round 4 named the wider hole: this function "accepts the record
  // directly without parsing its complete runtime shape", so a value that was
  // not an approved-intent record at all — a missing lineage root, an extra
  // field, an `approvedAt` that is not a timestamp — was resized anyway, and
  // whatever of it the new record copies rode along unexamined.
  //
  // Two things this buys beyond shape, both found by probes rather than by
  // reading: a hand-built `targetShares` of `"f1890000-…"` is a typed refusal
  // rather than an `InvalidDecimalStringError` THROWN out of a function whose
  // whole contract is to return one, and a non-canonical `marketId` anywhere in
  // the intent is refused before anything is constructed. The parse OUTPUT is
  // deliberately discarded: the record is built from the values as they were
  // read, so nothing can be normalized on the way through.
  const parsedRecord = ApprovedIntentRecordSchema.safeParse(inherited);
  if (!parsedRecord.success) {
    refusals.push(
      riskRefusal(
        "RISK_INPUT_INVALID",
        "the record to resize does not satisfy the approved-intent record contract; a resize computes on it and copies most of it forward, so it is parsed before it is used (fail closed)",
        {
          issues: parsedRecord.error.issues.map(
            (issue) => `record.${issue.path.join(".")}: ${issue.message}`,
          ),
        },
      ),
    );
    // Every check below reads `inherited`; with it unparsed there is nothing
    // safe to compute, so report what is known and stop.
    return riskFailure(...refusals);
  }

  if (
    req.approvedIntentId === inherited.approvedIntentId ||
    req.approvedIntentId === inherited.rootApprovedIntentId
  ) {
    refusals.push(
      riskRefusal(
        "RISK_RESIZE_ID_REUSED",
        "a resize must create a NEW approved-intent record; reusing an id in the lineage would edit the original in storage (§7.7)",
        {
          requested: req.approvedIntentId,
          approvedIntentId: inherited.approvedIntentId,
          rootApprovedIntentId: inherited.rootApprovedIntentId,
        },
      ),
    );
  }

  const originalShares = resizableTargetShares(inherited.intent);
  if (originalShares === undefined) {
    refusals.push(
      riskRefusal(
        "RISK_RESIZE_UNSUPPORTED_TYPE",
        "only POSITION and REDUCE_POSITION intents carry a single resizable targetShares; a QUOTE ladder or BASKET leg set is re-proposed by the strategy, not resized here (fail closed)",
        { intentType: inherited.intent.type },
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
    inherited.intent.type === "POSITION"
      ? { ...inherited.intent, targetShares: req.newTargetShares }
      : inherited.intent.type === "REDUCE_POSITION"
        ? { ...inherited.intent, targetShares: req.newTargetShares }
        : inherited.intent;

  // The draft goes out through the emission boundary like every other record;
  // the boundary is what freezes it, and — since round 4 — what re-reads it into
  // the plain own data that is actually emitted. Nothing here is copied by
  // spread from an unread value: `[...inherited.reasons]` would THROW on a
  // hand-built record whose `reasons` is not iterable, and the emission boundary
  // exists precisely so that a malformed inherited field becomes a typed refusal
  // instead. Every inherited field is passed through as it was read and refused
  // there if it is not what the contract says.
  return sealApprovedIntentRecord(
    {
      approvedIntentId: req.approvedIntentId,
      lineage: "RESIZED" as const,
      supersedesApprovedIntentId: inherited.approvedIntentId,
      rootApprovedIntentId: inherited.rootApprovedIntentId,
      ...(inherited.sourceIntentId === undefined
        ? {}
        : { sourceIntentId: inherited.sourceIntentId }),
      intent: resizedIntent,
      approvedAt: req.resizedAt,
      runMode: inherited.runMode,
      strategyInstanceId: inherited.strategyInstanceId,
      reasons: inherited.reasons,
      worstCase: inherited.worstCase,
      worstCaseBasis: "INHERITED_UPPER_BOUND" as const,
      recommendations: inherited.recommendations,
      resizeReason: req.reason,
    },
  );
}
