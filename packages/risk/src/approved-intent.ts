/**
 * Approved-intent records — handoff §7.7, final paragraph:
 *
 * > "A risk veto never silently mutates an intent. A resize creates a new
 * > approved-intent record linked to the original."
 *
 * The ORIGINAL intent and the record are deeply frozen, so an attempted
 * in-place edit THROWS rather than succeeding quietly.
 *
 * NO RESIZE PATH EXISTS (C1-RISK, TRADE-08, 2026-10-08). This package used to
 * export `resizeApprovedIntent`, which nothing outside its own tests called:
 * the execution planner refuses an intent it cannot fill
 * (`PLAN_INVENTORY_INSUFFICIENT`) rather than downsizing it, and a refusal
 * never mutates an intent. It was deleted with its request schema and its four
 * `RISK_RESIZE_*` codes, so WP-180's "risk resize creates a new approved-intent
 * record" now holds vacuously. The record keeps its stored lineage fields
 * (`lineage`, `supersedesApprovedIntentId`, `rootApprovedIntentId`,
 * `worstCaseBasis`, `resizeReason`): they are a stored contract the execution
 * planner reads, and every record this package emits today is an `ORIGINAL`
 * with an `EVALUATED` worst case.
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
 *    `deepFreeze` and (until C1-RISK) `exposure-limits.ts` traversed too. What is true is the
 *    thing that matters here — the ADR-016 §2 IDENTITY check walks nothing of
 *    its own; it consumes the inventory the read produced.
 *
 * TOTALITY IS NOW STRUCTURAL. The public function below runs inside
 * {@link contained}, so an exception cannot leave a function whose contract is a
 * typed result — however wrong an assumption above turns out to be. Three
 * rounds running, the escape was a site nobody had thought of.
 */

import {
  DetailStringSchema,
  IntentSchema,
  IsoTimestampSchema,
  NonEmptyStringSchema,
  RunModeSchema,
  type Intent,
  type RunMode,
} from "@polymarket-bot/domain";
import { z } from "zod";

import { deepFreeze } from "./guards.js";
import { identityRefusals } from "./inputs.js";
import { appendData, readPlainData, type PlainDataString } from "./plain-data.js";
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
import { prototypeFreeParser } from "./schema-arena.js";

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
  /** Present only on a `RESIZED` record (none is produced since C1-RISK). */
  readonly resizeReason?: string;
}

/**
 * THE COMPLETE RUNTIME SHAPE of {@link ApprovedIntentRecord} (review round 4).
 *
 * A draft is built from values TypeScript types but nothing parsed. A type
 * annotation is not a runtime guarantee, so the emission
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
 *   `DetailStringSchema` (its producer, the resize request, was deleted by
 *   C1-RISK; a stored `RESIZED` record may still carry it).
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
 * The door's parsing copy of {@link ApprovedIntentRecordSchema} (review round 8).
 *
 * Same validation, node for node — see `schema-arena.ts` — assembled onto
 * containers with NO PROTOTYPE, with a parse context that has none either. An
 * inherited SETTER can no longer be invoked while the library builds an output
 * this door discards, and an inherited `skipChecks` can no longer turn the
 * library's format checks into no-ops.
 */
const ApprovedIntentRecordParser = prototypeFreeParser(ApprovedIntentRecordSchema);

/**
 * THE SINGLE EMISSION BOUNDARY for approved-intent records.
 *
 * Every path that returns a record — `evaluateIntent`'s two arms — builds a
 * draft and hands it here. This
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
      const shape = ApprovedIntentRecordParser.safeParse(data.value);
      if (!shape.success) {
        appendData(
          refusals,
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
