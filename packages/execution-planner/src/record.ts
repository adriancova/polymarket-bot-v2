/**
 * The approved-intent record door — WP-180's output, consumed STRUCTURALLY.
 *
 * `packages/risk` and this package are both layer 1 and
 * `docs/contracts/dependency-direction.md` §2.1 lists no same-layer edge
 * between them (F13), so the planner consumes `ApprovedIntentRecord` by shape
 * — the exact arrangement `packages/risk` itself uses for the allocator's
 * verdict, pinned the same way (`test/unit/execution-planner/ports.test.ts`
 * parses REAL records produced by the risk engine at `98a6cc1`).
 *
 * THE SHAPE IS TAKEN AS IT IS, NOT RE-DERIVED AND NOT WIDENED (WP-190 binding
 * constraint 4): {@link APPROVED_INTENT_RECORD_KEYS} is the record's key set
 * at `98a6cc1` verbatim, closed in both directions — an unknown key refuses,
 * and validation of each CONSUMED field matches what risk's own emission
 * boundary guarantees (bounded identifiers under ADR-016 §2, the frozen §7.7
 * intent contract, a §7.1-style instant, the §11 run-mode vocabulary). Fields
 * the planner does NOT consume (`reasons`, `worstCase`, `recommendations`,
 * `resizeReason`, `supersedesApprovedIntentId`) are read as data but not
 * re-validated: re-implementing risk's emission rules here would be exactly
 * the re-derivation the packet forbids.
 *
 * `worstCaseBasis` IS consumed, per WP-180's `follow_up` 3: a record with
 * `INHERITED_UPPER_BOUND` has not been re-evaluated against a fresh
 * portfolio, and this package cannot re-run `evaluateIntent` (no edge), so
 * every plan RECORDS the basis it acted on in its provenance.
 *
 * THE CANCEL PATH READS LESS, BY DESIGN (§6 invariant 13; module header of
 * `pluck.ts`): {@link readApprovedCancel} plucks only the fields a cancel plan
 * carries, so a hostile or malformed `worstCase`, `reasons` or
 * `recommendations` value — fields no cancel consumes — can neither throw nor
 * refuse a valid cancel.
 */

import { RUN_MODES, type Intent, type RunMode } from "@polymarket-bot/domain";

import { IntentDoor, IsoTimestampDoor } from "./doors.js";
import { pluck } from "./pluck.js";
import {
  plannerFailure,
  plannerRefusal,
  readInputAsData,
  type PlannerResult,
} from "./refusals.js";
import {
  asIdentifier,
  asMember,
  asRecord,
  problem,
  requireKnownKeys,
  type Problem,
} from "./validate.js";

/** The record's complete key set at `98a6cc1` (`packages/risk/src/approved-intent.ts`). */
export const APPROVED_INTENT_RECORD_KEYS: ReadonlySet<string> = new Set([
  "approvedIntentId",
  "lineage",
  "supersedesApprovedIntentId",
  "rootApprovedIntentId",
  "sourceIntentId",
  "intent",
  "approvedAt",
  "runMode",
  "strategyInstanceId",
  "reasons",
  "worstCase",
  "worstCaseBasis",
  "recommendations",
  "resizeReason",
]);

export const APPROVED_INTENT_LINEAGES = ["ORIGINAL", "RESIZED"] as const;
export const WORST_CASE_BASES = ["EVALUATED", "INHERITED_UPPER_BOUND"] as const;

/** What the planner consumes of an approved-intent record. Materialized data. */
export interface ApprovedIntentView {
  readonly approvedIntentId: string;
  readonly rootApprovedIntentId: string;
  readonly sourceIntentId?: string;
  readonly strategyInstanceId: string;
  readonly approvedAt: string;
  readonly runMode: RunMode;
  readonly lineage: (typeof APPROVED_INTENT_LINEAGES)[number];
  readonly worstCaseBasis: (typeof WORST_CASE_BASES)[number];
  readonly intent: Intent;
}

function refusalFromProblems(
  code: "PLAN_RECORD_INVALID",
  what: string,
  problems: readonly Problem[],
): PlannerResult<never> {
  return plannerFailure(
    plannerRefusal(code, `${what} failed validation (fail closed)`, {
      issues: problems.map((entry) => `${entry.path}: ${entry.problem}`),
    }),
  );
}

/** Validates the consumed identity/vocabulary fields of a materialized record. */
function viewFromMaterialized(
  data: Readonly<Record<string, unknown>>,
  problems: Problem[],
): ApprovedIntentView | undefined {
  const approvedIntentId = asIdentifier(data["approvedIntentId"], "record.approvedIntentId", problems);
  const rootApprovedIntentId = asIdentifier(
    data["rootApprovedIntentId"],
    "record.rootApprovedIntentId",
    problems,
  );
  const strategyInstanceId = asIdentifier(
    data["strategyInstanceId"],
    "record.strategyInstanceId",
    problems,
  );
  const sourceIntentId =
    data["sourceIntentId"] === undefined
      ? undefined
      : asIdentifier(data["sourceIntentId"], "record.sourceIntentId", problems);
  const lineage = asMember(data["lineage"], "record.lineage", APPROVED_INTENT_LINEAGES, problems);
  const worstCaseBasis = asMember(
    data["worstCaseBasis"],
    "record.worstCaseBasis",
    WORST_CASE_BASES,
    problems,
  );
  const runMode = asMember(data["runMode"], "record.runMode", RUN_MODES, problems);

  const approvedAtValue = data["approvedAt"];
  let approvedAt: string | undefined;
  if (typeof approvedAtValue !== "string" || !IsoTimestampDoor.safeParse(approvedAtValue).success) {
    problem(problems, "record.approvedAt", "expected an ISO-8601 instant with explicit offset");
  } else {
    approvedAt = approvedAtValue;
  }

  // The §7.7 contract itself answers whether this is an intent; the ANSWER is
  // used and the parse output discarded — the intent this package acts on is
  // the materialized tree (cross-package schema hazard, Open blockers).
  const intentValue = data["intent"];
  let intent: Intent | undefined;
  const parsed = IntentDoor.safeParse(intentValue);
  if (!parsed.success) {
    problem(
      problems,
      "record.intent",
      "does not satisfy the frozen §7.7 intent contract (packages/domain IntentSchema)",
    );
  } else {
    intent = intentValue as Intent;
  }

  if (
    approvedIntentId === undefined ||
    rootApprovedIntentId === undefined ||
    strategyInstanceId === undefined ||
    lineage === undefined ||
    worstCaseBasis === undefined ||
    runMode === undefined ||
    approvedAt === undefined ||
    intent === undefined ||
    (data["sourceIntentId"] !== undefined && sourceIntentId === undefined)
  ) {
    return undefined;
  }
  return {
    approvedIntentId,
    rootApprovedIntentId,
    ...(sourceIntentId === undefined ? {} : { sourceIntentId }),
    strategyInstanceId,
    approvedAt,
    runMode,
    lineage,
    worstCaseBasis,
    intent,
  };
}

/**
 * Reads a whole approved-intent record (every non-cancel path).
 *
 * ALL-OR-NOTHING: the record is materialized in one read, the key set is
 * closed against {@link APPROVED_INTENT_RECORD_KEYS}, and the consumed fields
 * are validated. A record this door refuses plans nothing — which is the
 * correct coupling for a PLACEMENT, where any hostile field is reason enough
 * not to place orders.
 */
export function readApprovedIntentRecord(record: unknown): PlannerResult<ApprovedIntentView> {
  const read = readInputAsData(record, "record", "approved-intent record", "PLAN_RECORD_INVALID");
  if (!read.ok) return plannerFailure(read.refusal);
  const problems: Problem[] = [];
  const data = asRecord(read.value, "record", problems);
  if (data === undefined) {
    return refusalFromProblems("PLAN_RECORD_INVALID", "the approved-intent record", problems);
  }
  requireKnownKeys(data, "record", APPROVED_INTENT_RECORD_KEYS, problems);
  for (const required of [
    "approvedIntentId",
    "lineage",
    "rootApprovedIntentId",
    "intent",
    "approvedAt",
    "runMode",
    "strategyInstanceId",
    "reasons",
    "worstCase",
    "worstCaseBasis",
    "recommendations",
  ]) {
    if (data[required] === undefined) {
      problem(problems, `record.${required}`, "a required field of an approved-intent record is absent");
    }
  }
  const view = viewFromMaterialized(data, problems);
  if (view === undefined || problems.length > 0) {
    return refusalFromProblems("PLAN_RECORD_INVALID", "the approved-intent record", problems);
  }
  return { ok: true, value: view };
}

/**
 * Reads ONLY what a cancel plan carries (§6 invariant 13 — see the module
 * headers here and in `pluck.ts`). Fields no cancel consumes are never
 * touched, so a hostile `worstCase` getter or a malformed `reasons` array
 * cannot block a valid cancel. A field the cancel DOES need that is hostile or
 * malformed still refuses — nothing converts a refusal into a cancel.
 */
export function readApprovedCancel(record: unknown): PlannerResult<ApprovedIntentView> {
  const problems: Problem[] = [];
  const picked: Record<string, unknown> = {};
  for (const key of [
    "approvedIntentId",
    "rootApprovedIntentId",
    "strategyInstanceId",
    "approvedAt",
    "runMode",
    "lineage",
    "worstCaseBasis",
    "intent",
  ]) {
    const plucked = pluck(record, "record", [key]);
    if (!plucked.ok) {
      problem(problems, plucked.problem.path, plucked.problem.problem);
      continue;
    }
    picked[key] = plucked.read.value;
  }
  if (problems.length > 0) {
    return refusalFromProblems("PLAN_RECORD_INVALID", "the approved cancel record", problems);
  }
  const view = viewFromMaterialized(picked, problems);
  if (view === undefined || problems.length > 0) {
    return refusalFromProblems("PLAN_RECORD_INVALID", "the approved cancel record", problems);
  }
  if (view.intent.type !== "CANCEL") {
    return plannerFailure(
      plannerRefusal("PLAN_RECORD_INVALID", "the cancel door was handed a non-cancel intent", {
        intentType: view.intent.type,
      }),
    );
  }
  return { ok: true, value: view };
}
