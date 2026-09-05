/**
 * THE MECHANISM, PART 2 — an inherited property changes no answer.
 *
 * WHY A BEHAVIOURAL MECHANISM AS WELL AS THE SYNTACTIC ONE
 * (`prototype-access.test.ts`). Review round 6's first BLOCKER had two probes,
 * and the second is the one that generalizes: augmenting `Object.prototype`
 * with a single non-enumerable property — a market's UUID — flipped a
 * reservation that a LIBRARY-CREATED state had correctly refused
 * (`CAPITAL_LIVE_OWNERSHIP_MISSING`) into `permitted=true, no refusals`. No
 * hostile input was involved. A syntactic rule over computed reads would not
 * have caught the two other members of the same class this suite found:
 *
 * - `zod` ADOPTS an inherited optional field into its parse output, so an
 *   absent `venueEligibility` arrived as `"ELIGIBLE"` — measured, see below;
 * - the live-micro fence read `caps[field]` as "absent, therefore fine" while
 *   the enforcement site read the SAME inherited value as the cap, which is a
 *   weakening of an `AGENTS.md` non-weakenable floor by prototype augmentation
 *   alone.
 *
 * So this test does not look for sites. For every public door of both packages
 * it takes the answer, then re-takes it with `Object.prototype` carrying one
 * extra property — drawn MECHANICALLY from the names and strings that door's
 * own inputs contain, plus the composite keys these packages build and every
 * property-descriptor attribute name — in six shapes: a data string, a data
 * object, a two-answer getter, a throwing getter, an ACCEPTING SETTER and a
 * THROWING SETTER (the last two are round 8's).
 *
 * THE PROPERTY IT ENFORCES, STATED EXACTLY. An inherited property may cost
 * AVAILABILITY; it may never buy PERMISSION, and it may never silently change
 * data:
 *
 * - an answer carrying a permission bit must be IDENTICAL, or must have become
 *   a typed REFUSAL (a refusal may also change its reason);
 * - EXCEPT ON A CANCEL, where it must be IDENTICAL, full stop (review round 7).
 *   "It became a refusal instead" is fail-closed for an entry and a TRAPPED
 *   POSITION for a cancel — §6 invariant 13 — which is exactly the BLOCKER round
 *   7 reported. See {@link Scenario.identicalOrFail};
 * - an answer carrying no permission bit — an exposure snapshot — must be
 *   identical, full stop;
 * - nothing may throw;
 * - for a door that runs NO schema, no inherited getter may be invoked at all.
 *   For a door that runs one, `zod`'s own compiled parser reads declared field
 *   names off objects IT creates, which this package cannot prevent; that
 *   measurement, and why it is not a hole, is recorded on {@link Scenario};
 * - and, since round 8, NO INHERITED SETTER MAY BE INVOKED BY ANY DOOR, parsing
 *   or not, for any key, in either setter mode. A read can be forced on this
 *   package by a library; a WRITE of an inherited name is always somebody
 *   assembling a value onto an ordinary object, and no door does that any more
 *   (`schema-arena.ts`). Measured: ZERO across every scenario and key.
 *
 * WHAT ROUND 7 ADDED, AND WHY EACH WAS A BLIND SPOT:
 *
 * - the key material now includes every name a SCHEMA DEFAULT occupies
 *   ({@link SCHEMA_DEFAULT_NAMES}). A defaulted field is absent from the input by
 *   definition, so input-derived keys could never name one — and that is where
 *   round 7 found three fail-opens (§9.8 checks 2, 6 and 12 silently skipped
 *   because `zod` could not assign its own default over a get-only inherited
 *   accessor, and the later read walked the chain);
 * - THE JOIN: every public FUNCTION of both packages must now be swept by a
 *   scenario or registered with a reason, so a new door cannot arrive without
 *   one (round 6 follow-up R6-2).
 *
 * SCOPE, STATED. The sweep proves the property for the scenarios it runs, which
 * are the public doors with their fully-passing fixtures and their principal
 * refusal arms. It is not a proof for a path no scenario reaches. Array-index
 * names are excluded, with the measured reason at {@link ARRAY_INDEX}. The
 * intrinsics assumption is unchanged and is NOT what this tests: adding a
 * property to `Object.prototype` does not replace `Object`, `Reflect`,
 * `Array.prototype` or `util.types`, and review round 6 ruled that augmentation
 * in scope.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Namespace imports for THE JOIN (R6-2): the swept surface is read from the
// module rather than from a hand list, exactly as `public-surface.test.ts` does.
import * as allocatorModule from "../../../packages/capital-allocator/src/index.js";
import * as riskModule from "../../../packages/risk/src/index.js";
import {
  createAllocatorState,
  evaluateReservation,
  applyReservation,
  exposureSnapshotCovering,
  liveMicroCapRefusals,
  nonFloorLiveMicroCapFields,
  parseAllocatorCaps,
  releaseReservation,
  withLiveOwner,
  type AllocatorCaps,
  type AllocatorState,
} from "../../../packages/capital-allocator/src/index.js";
import { ALLOCATOR_CAPS_DEFAULTS } from "../../../packages/capital-allocator/src/caps.js";
import { deepFreeze as allocatorDeepFreeze } from "../../../packages/capital-allocator/src/guards.js";
import { deepFreeze as riskDeepFreeze } from "../../../packages/risk/src/guards.js";
import {
  evaluateIntent,
  parseRiskPolicy,
  resizeApprovedIntent,
  validateEvaluationInput,
} from "../../../packages/risk/src/index.js";
import { RISK_POLICY_DEFAULTS } from "../../../packages/risk/src/policy.js";
import {
  cancelIntent,
  codesOf,
  entryInput,
  exitInput,
  EVALUATED_AT,
  FIXTURE_MEASURING,
  INSTANCE,
  MARKET_A,
  MARKET_B,
  exposureEntry,
  exposureSnapshot as exposureSnapshotFixture,
  riskPolicy,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// the pollution harness
// ---------------------------------------------------------------------------

/**
 * How one extra property is put on `Object.prototype`.
 *
 * All six are NON-ENUMERABLE and CONFIGURABLE. Round 6 justified excluding
 * enumerable data properties with "an enumerable one would break every
 * `for…in` in the process and prove nothing about this package" — and review
 * round 9 PARTIALLY FALSIFIED that (2026-09-04, measured): on a COLD first
 * parse the schema library's own lazy `for…in` walk met the inherited
 * enumerable key DETERMINISTICALLY INSIDE the door, threw, and the containment
 * guard trapped a valid CANCEL as `RISK_INPUT_INVALID` — an order-dependent
 * defect this warm-process sweep could never see (any one clean parse warms
 * the lazies and the trap stops firing). The rationale's other half still
 * stands: in THIS process, which is mid-test-run, a long-lived enumerable
 * pollutant would perturb the harness itself, so the enumerable-data class is
 * covered where coldness can be controlled instead — `cold-first-parse.test.ts`
 * (a worker whose first door parse happens inside the polluted window) and the
 * cold-by-construction copies in `schema-arena.test.ts`. The two getters below
 * are the round-6 reviewer's exactly — one that answers differently on a
 * second read (the inventory probe) and one that throws.
 *
 * THE TWO SETTER MODES ARE ROUND 8'S (the reviewer's BLOCKER). A getter is
 * invoked when something READS a name; a SETTER is invoked when something
 * WRITES one — and the schema library writes every validated field onto an
 * ordinary object while assembling an output this package discards. An
 * ACCEPTING setter measured that write happening at all (three invocations
 * across one validation and one evaluation, at the reviewed tip); a THROWING
 * one aborted the parse, and the valid `CANCEL` carrying its own
 * `intent.reason` came back `RISK_INPUT_INVALID`. Both modes now run against
 * every door, on every key, and the CANCEL scenarios additionally require a
 * BYTE-IDENTICAL answer ({@link Scenario.identicalOrFail}).
 */
type PollutionMode =
  | "data-string"
  | "data-entry"
  | "two-answer-getter"
  | "throwing-getter"
  | "accepting-setter"
  | "throwing-setter";

const POLLUTION_MODES: readonly PollutionMode[] = [
  "data-string",
  "data-entry",
  "two-answer-getter",
  "throwing-getter",
  "accepting-setter",
  "throwing-setter",
];

const POISON_ENTRY = Object.freeze({
  openOrderCommitted: "1000",
  positionCommitted: "1000",
  combined: "1000",
  // enough of an allocator verdict / owner / scope to be mistaken for one
  permitted: true,
  refusals: [],
  seriesKey: "poison",
  underlyingKey: "poison",
  resolutionWindowKey: "poison",
});

interface PollutionResult {
  readonly answer: string;
  readonly grade: "permissive" | "refusal" | "opaque";
  readonly getterCalls: number;
  /**
   * How many times an inherited SETTER was invoked (review round 8).
   *
   * Counted separately from reads because the property it supports is
   * different and absolute: a read may be forced on this package by a library
   * it does not control, but a WRITE of an inherited name is always somebody
   * assembling a value onto an ordinary object — and after round 8 no door
   * does that, for any key, in any mode. The sweep requires ZERO.
   */
  readonly setterCalls: number;
  readonly threw: string | undefined;
}

function pollutionDescriptor(
  mode: PollutionMode,
  count: () => void,
  countWrite: () => void,
): PropertyDescriptor {
  switch (mode) {
    case "data-string":
      return { value: "1000", writable: true, enumerable: false, configurable: true };
    case "data-entry":
      return { value: POISON_ENTRY, writable: true, enumerable: false, configurable: true };
    case "two-answer-getter": {
      let reads = 0;
      return {
        get(): unknown {
          count();
          reads += 1;
          return reads === 1 ? "1000" : "0";
        },
        enumerable: false,
        configurable: true,
      };
    }
    case "throwing-getter":
      return {
        get(): never {
          count();
          throw new Error("inherited-getter");
        },
        enumerable: false,
        configurable: true,
      };
    case "accepting-setter":
      // Round 8: a getter for anything that READS the name, and a setter that
      // ACCEPTS — so a write is measured rather than turned into a failure. It
      // is also the shape that shows what a polluted prototype could HARVEST.
      return {
        get(): unknown {
          count();
          return "1000";
        },
        set(): void {
          countWrite();
        },
        enumerable: false,
        configurable: true,
      };
    default:
      // The reviewer's BLOCKER probe: a non-enumerable, configurable, THROWING
      // setter. Nothing may write the name; everything must still answer.
      return {
        get(): unknown {
          count();
          return "1000";
        },
        set(): never {
          countWrite();
          throw new TypeError("inherited-setter");
        },
        enumerable: false,
        configurable: true,
      };
  }
}

function withPollution(key: string, mode: PollutionMode, body: () => unknown): PollutionResult {
  let calls = 0;
  let writes = 0;
  const descriptor = pollutionDescriptor(
    mode,
    () => {
      calls += 1;
    },
    () => {
      writes += 1;
    },
  );
  Object.defineProperty(Object.prototype, key, descriptor);
  try {
    const answer = body();
    return {
      answer: describe_(answer),
      grade: permissiveness(answer),
      getterCalls: calls,
      setterCalls: writes,
      threw: undefined,
    };
  } catch (error) {
    return {
      answer: "THREW",
      grade: "opaque",
      getterCalls: calls,
      setterCalls: writes,
      threw: error instanceof Error ? error.message : String(error),
    };
  } finally {
    delete (Object.prototype as Record<string, unknown>)[key];
  }
}

/** A stable, order-sensitive rendering of an answer. */
function describe_(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The candidate keys for one scenario, derived from its own inputs.
 *
 * Every own property NAME and every STRING VALUE in the input tree, plus the
 * composite keys these packages build (`instance|market|side`) and the names
 * the packages use internally. Names already present on `Object.prototype` or
 * `Array.prototype` are excluded: this sweep ADDS a property, it does not
 * replace an intrinsic member, which is a different threat model and the one
 * both packages explicitly do not answer.
 */
function candidateKeys(material: unknown, extra: readonly string[] = []): string[] {
  const found = new Set<string>();
  const harvest = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      found.add(value);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, member] of Object.entries(value)) {
      found.add(key);
      harvest(member, depth + 1);
    }
  };
  harvest(material, 0);
  for (const key of extra) found.add(key);
  return [...found].filter(
    (key) =>
      key.length > 0 &&
      key.length < 90 &&
      !ARRAY_INDEX.test(key) &&
      !Object.hasOwn(Object.prototype, key) &&
      // Names OWN on `Array.prototype` are excluded because the sweep ADDS,
      // never replaces — EXCEPT the audited round-9 carve-outs, where the own
      // member shadows the chain and adding the name to `Object.prototype`
      // replaces nothing an array can see ({@link ZOD_ARRAY_SHADOWED_NAMES}).
      (!Object.hasOwn(Array.prototype, key) || ZOD_ARRAY_SHADOWED_NAMES.has(key)),
  );
}

/**
 * An array-index NAME, excluded from the sweep — with the reason measured
 * rather than assumed.
 *
 * A property named `"0"` on `Object.prototype` is not a fact about these
 * packages; it is a fact about ARRAY INDEXING everywhere in the process, and
 * two measurements make that concrete:
 *
 * - as a GET-ONLY accessor it makes `Array.prototype.push` THROW on any empty
 *   array (`Cannot set property 0 of #<Object> which has only a getter`) —
 *   including inside the test runner and inside `decimal.js`;
 * - as a data property it is read by `decimal.js`'s own internals, which
 *   changed an arithmetic result and therefore a refusal CODE, with no code in
 *   either of these packages involved.
 *
 * Neither package reads an array element by computed key in product code (the
 * round-6 census confirms: zero numeric `element-read` sites outside the test
 * files), so the exclusion removes noise about third-party array machinery
 * without hiding a site of ours. It is recorded as a residual in
 * `docs/handoffs/WP-180.md`.
 *
 * WHAT `WP-020-FU1` CHANGED, and why this exclusion nevertheless stays. The
 * SECOND reason above is now false: `packages/decimal` neutralizes index names
 * on both prototypes for the duration of every operation, so an inherited data
 * property no longer changes any arithmetic result. The FIRST is still true —
 * `Array.prototype.push` remains `Set` — and `packages/risk` still accumulates
 * with `push` in the eight modules OUTSIDE `plain-data.ts`, whose 23 appends
 * that round converted. So the exclusion still removes real third-party and
 * out-of-file noise from THIS sweep, and the class it excludes is measured
 * directly instead, per shape and per index, in
 * `test/unit/risk/index-name-pollution.test.ts` — including the remainder this
 * file would otherwise be silently carrying.
 */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

/**
 * Every NAME a schema DEFAULT occupies — derived from the doors' own tables.
 *
 * THE BLIND SPOT THIS CLOSES (review round 7). The key material above is
 * harvested from a scenario's INPUT, and a defaulted field is by definition
 * ABSENT from the input: `maxRunMode`, `requireVerifiedSettlementForEntries`,
 * `requiredKinds`, `riskBuffer` and `requirePositiveNetEdgeForEntries` were
 * therefore never candidate keys, and the sweep could not see the class round 7
 * found — a get-only inherited accessor defeats `zod`'s assignment of its OWN
 * default, so the key is missing from the output and the later read walks the
 * chain. At the round-6 tip that silently skipped §9.8 checks 6 and 12 and
 * APPROVED entries both refuse today.
 *
 * Derived from `RISK_POLICY_DEFAULTS` / `ALLOCATOR_CAPS_DEFAULTS` rather than
 * hand-listed, so a default added to a door is swept without anyone remembering
 * — and `schema-output.test.ts` independently binds those tables to the schemas.
 */
const SCHEMA_DEFAULT_NAMES: readonly string[] = [
  ...RISK_POLICY_DEFAULTS,
  ...ALLOCATOR_CAPS_DEFAULTS,
].flatMap((entry) => [...entry.path]);

/**
 * Every PROPERTY-DESCRIPTOR ATTRIBUTE name (review round 8).
 *
 * THE BLIND SPOT THIS CLOSES. `Object.defineProperty(o, k, { value, writable:
 * true, … })` passes an ORDINARY OBJECT, and the specification reads a
 * descriptor's fields with `HasProperty` — through the prototype chain. So one
 * property on `Object.prototype` changes what every descriptor in these
 * packages MEANS. None of these names is an input field name or a package
 * concept, so neither the input-derived key material nor {@link INTERNAL_NAMES}
 * had ever named them, and the round-8 probe measured the consequence on the
 * round-7 tip with a valid `CANCEL` and nothing else:
 *
 * ```text
 * Object.prototype.get = "1000"        → evaluateIntent THREW (Getter must be a function)
 * Object.prototype.get = () => "1000"  → evaluateIntent THREW (accessors and a value)
 * Object.prototype.set = …             → the same, both shapes
 * ```
 *
 * THREW, not refused: the containment guard builds a refusal, and building one
 * defines properties too. Both packages now build every descriptor with a `null`
 * prototype (`plain-data.ts`, `ownDataDescriptor` / `ownAccessorDescriptor`),
 * and these names are swept from here on so the class cannot come back.
 */
const DESCRIPTOR_ATTRIBUTE_NAMES: readonly string[] = [
  "value",
  "get",
  "set",
  "writable",
  "enumerable",
  "configurable",
];

/**
 * Every name the SCHEMA LIBRARY'S PARSE PATH can consult on a container it
 * built (review round 9).
 *
 * THE BLIND SPOT THIS CLOSES. The library keeps per-node state in `inst._zod`
 * — an ordinary object literal — and reads OPTIONAL fields off it, off its
 * parse context, off check definitions and off its payload objects at parse
 * time. None of those names is an input field, a schema default or a
 * descriptor attribute, so no earlier key material ever named one — and round
 * 9 measured two as LIVE FAIL-OPENS at the round-8 tip: `optin`+`optout`
 * together waived every required key, and `when: () => false` skipped every
 * custom check (`docs/handoffs/WP-180.md`, round 9, transcripts). The arena
 * now severs every container it builds (`schema-arena.ts`,
 * `severOrdinaryChain`), and these names are swept from here on so the class
 * cannot come back.
 *
 * DERIVED, NOT REMEMBERED. {@link consultedZodSlotNames} re-extracts the
 * `_zod.<name>` reads from the library's SHIPPED source at test time, and the
 * audit test below requires this hand-reviewed list to cover that extraction
 * IN FULL — so a `zod` upgrade that starts consulting a new instance slot
 * arrives as a FAILING TEST, not as a silent hole. The names beyond the
 * `_zod.` extraction are the parse-context switches (`skipChecks`,
 * `direction`, `jitless`, `async` — round 8's finding, kept swept), the
 * definition/check switches (`when`, `abort`, `coerce`, `catchall`,
 * `unionFallback`, `inclusive`, `discriminator`), the payload/issue fields the
 * abort logic reads (`aborted`, `continue`), and `disc` (the reviewer's name
 * for the discriminator-map state; a closure in the shipped build, swept
 * anyway so a future version that materializes it is already covered).
 */
const ZOD_PARSE_STATE_NAMES: readonly string[] = [
  // _zod instance slots (the mechanical extraction, hand-reviewed below)
  "bag",
  "check",
  "constr",
  "def",
  "deferred",
  "innerType",
  "onattach",
  "optin",
  "optout",
  "parent",
  "parse",
  "pattern",
  "propValues",
  "qin",
  "run",
  "traits",
  "values",
  "version",
  // parse-context switches (round 8's class, kept in the material)
  "skipChecks",
  "direction",
  "jitless",
  "async",
  // definition and check switches read during a parse
  "when",
  "abort",
  "coerce",
  "catchall",
  "unionFallback",
  "inclusive",
  "discriminator",
  // payload/issue fields the abort logic reads
  "aborted",
  "continue",
  // the discriminator-map state, by the reviewer's name
  "disc",
];

/**
 * Names on {@link ZOD_PARSE_STATE_NAMES} that are OWN properties of
 * `Array.prototype` and would otherwise be dropped by {@link candidateKeys}'
 * intrinsic filter. Adding one of these to `Object.prototype` REPLACES no
 * intrinsic — an array still finds `Array.prototype.values` first, because the
 * own member shadows the chain — so the sweep may carry them. (`keys` and
 * `entries` would need the same carve-out but are not consulted `_zod` slots;
 * they are normalized-table fields the library always writes as OWN.)
 */
const ZOD_ARRAY_SHADOWED_NAMES: ReadonlySet<string> = new Set(["values"]);

const INTERNAL_NAMES: readonly string[] = [
  ...SCHEMA_DEFAULT_NAMES,
  ...DESCRIPTOR_ATTRIBUTE_NAMES,
  ...ZOD_PARSE_STATE_NAMES,
  "GLOBAL",
  "value",
  "combined",
  "openOrderCommitted",
  "positionCommitted",
  "liveMicroMaxOrderNotional",
  "liveMicroMaxAccountExposure",
  "globalAccountCap",
  "perStrategyCap",
  "perMarketCap",
  "perSeriesCap",
  "perUnderlyingCap",
  "perResolutionWindowCap",
  "permitted",
  "refusals",
  "scope",
  "seriesKey",
  "underlyingKey",
  "resolutionWindowKey",
  "intentId",
  "venueEligibility",
  "bookSynchronized",
  "exposures",
  "allocation",
  "byMarket",
  "bySeries",
  "byUnderlying",
  "byResolutionWindow",
  "byStrategyInstance",
  "global",
  "reason",
  "sourceIntentId",
  `${INSTANCE}|${MARKET_A}|YES`,
  `${INSTANCE}|${MARKET_A}|NO`,
  `${INSTANCE}|${MARKET_B}|YES`,
];

interface Scenario {
  readonly name: string;
  /**
   * The PUBLIC EXPORTS this scenario exercises, by name.
   *
   * THE JOIN (round 6 follow-up R6-2, closed in round 7). Round 6 left the
   * scenario list and the exported surface as two tables nothing connected, so
   * adding a public door without adding a scenario was caught by nothing. The
   * test at the bottom of this file requires every FUNCTION export of both
   * packages to appear here or in {@link NOT_SWEPT} with a reason.
   */
  readonly doors: readonly string[];
  /**
   * The answer under test. Must be deterministic, and must do NOTHING but call
   * the subject: every input is built at module scope, OUTSIDE the polluted
   * window, so that what is measured is the product's behaviour and not the
   * fixture builders' (they read optional fields off ordinary objects, as test
   * builders may).
   */
  readonly answer: () => unknown;
  /** The value whose names and strings the sweep draws its keys from. */
  readonly material: unknown;
  /**
   * Whether the door runs a `zod` schema.
   *
   * MEASURED, NOT ASSUMED (review round 6). `zod`'s compiled object parser
   * reads its declared field names back off objects IT creates with `{}`, so an
   * inherited getter named like a schema field IS invoked inside `safeParse` —
   * stack captured, `zod/v4/core/schemas.js` → the compiled parser, with the
   * input this package handed it being prototype-free. That is not reachable
   * from this package without dropping `zod`, so for parsing doors the sweep
   * asserts the ANSWER property (which contains a throwing getter as a
   * refusal), and for NON-parsing doors — pure computation, where every read is
   * ours — it additionally requires ZERO invocations. The reviewer's own site
   * probes below assert zero at the sites the BLOCKER named.
   */
  readonly parses: boolean;
  /**
   * When true, the ONE tolerated divergence is not tolerated for this scenario:
   * the answer must be byte-identical under every key and every mode.
   *
   * SET FOR THE CANCEL, AND ONLY FOR THE CANCEL (review round 7, BLOCKER). §6
   * invariant 13 says a valid cancel is not blocked; "it became a typed refusal
   * instead" is a fail-closed answer for an ENTRY and a TRAPPED POSITION for a
   * cancel, which is what the reviewer's probe demonstrated. Measured after the
   * round-7 fix: with the tolerance disabled everywhere, the surviving
   * divergences are all on ENTRY-shaped parsing doors and all in the two GETTER
   * modes — `zod`'s own compiled parser reading declared names off objects it
   * created, contained as a typed refusal — and the CANCEL scenario has NONE.
   *
   * IF THIS EVER FAILS, A CANCEL IS BEING TRAPPED AGAIN. It is a finding, not a
   * flag to clear.
   */
  readonly identicalOrFail?: boolean;
}

/**
 * How permissive an answer is, for the one divergence this sweep tolerates.
 *
 * THE PROPERTY THIS SWEEP ENFORCES: prototype augmentation may cost
 * AVAILABILITY, never PERMISSION, and never silently alters data. An answer
 * that is identical passes; an answer that turned from permitted into a typed
 * REFUSAL passes (that is fail-closed, and is what an inherited get-only
 * accessor can cause — it makes `zod`'s own output assembly drop a field, since
 * an assignment finds the inherited accessor and cannot write); anything else
 * fails, including any change to an answer that carries no permission bit at
 * all.
 */
function permissiveness(answer: unknown): "permissive" | "refusal" | "opaque" {
  if (answer === null || typeof answer !== "object") return "opaque";
  const record = answer as Record<string, unknown>;
  for (const flag of ["approved", "permitted", "ok"]) {
    if (Object.hasOwn(record, flag)) return record[flag] === true ? "permissive" : "refusal";
  }
  return "opaque";
}

/** Where two renderings first diverge, with a little context on each side. */
function divergence(baseline: string, polluted: string): string {
  let index = 0;
  while (index < baseline.length && index < polluted.length && baseline[index] === polluted[index]) {
    index += 1;
  }
  const from = Math.max(0, index - 40);
  return `at ${String(index)}: …${baseline.slice(from, index + 60)} → …${polluted.slice(from, index + 60)}`;
}

function sweep(scenario: Scenario): string[] {
  const baselineAnswer = scenario.answer();
  const baseline = describe_(baselineAnswer);
  const baselineGrade = permissiveness(baselineAnswer);
  const failures: string[] = [];
  for (const key of candidateKeys(scenario.material, INTERNAL_NAMES)) {
    for (const mode of POLLUTION_MODES) {
      const result = withPollution(key, mode, scenario.answer);
      if (result.threw !== undefined) {
        failures.push(`${scenario.name} | ${mode} on "${key}" | THREW ${result.threw}`);
        continue;
      }
      if (result.answer !== baseline) {
        // The one tolerated divergence: an answer that carries a permission bit
        // may become a REFUSAL (a refusal may also change its reason). It may
        // never become permissive, never stay permissive with different
        // content, and an answer with no permission bit at all — a snapshot —
        // may not change in any way.
        const tolerated =
          scenario.identicalOrFail !== true &&
          baselineGrade !== "opaque" &&
          result.grade === "refusal";
        if (!tolerated) {
          failures.push(
            `${scenario.name} | ${mode} on "${key}" | ANSWER CHANGED (${baselineGrade} → ${result.grade}) ${divergence(baseline, result.answer)}`,
          );
        }
        continue;
      }
      if (result.setterCalls > 0) {
        // ROUND 8, AND IT HOLDS FOR EVERY DOOR — parsing or not. An inherited
        // setter runs only when something WRITES the name onto an ordinary
        // object; the schema library did exactly that while assembling an
        // output these doors discard, which is how a valid CANCEL was trapped.
        // Each door now parses through a prototype-free arena, so the count is
        // zero everywhere, and this asserts it rather than tolerating it.
        failures.push(
          `${scenario.name} | ${mode} on "${key}" | an inherited SETTER was INVOKED ${String(result.setterCalls)}×`,
        );
        continue;
      }
      if (result.getterCalls > 0 && !scenario.parses) {
        failures.push(
          `${scenario.name} | ${mode} on "${key}" | an inherited getter was INVOKED ${String(result.getterCalls)}× and the answer did not change`,
        );
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// the scenarios: every public door, with its inputs
// ---------------------------------------------------------------------------

const CAPS_INPUT = { globalAccountCap: "1000", perStrategyCap: "1000" };

function caps(overrides: Record<string, unknown> = {}): AllocatorCaps {
  const parsed = parseAllocatorCaps({ ...CAPS_INPUT, ...overrides });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.value;
}

const STATE_INPUT = {
  accountEquity: "1000",
  availableCollateral: "1000",
  positions: [
    {
      positionId: "p-1",
      marketId: MARKET_A,
      strategyInstanceId: INSTANCE,
      side: "YES",
      shares: "100",
      costBasis: "40",
      scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
    },
  ],
  openOrders: [],
  liveOwners: [{ marketId: MARKET_A, strategyInstanceId: INSTANCE }],
};

const UNOWNED_STATE_INPUT = { ...STATE_INPUT, liveOwners: [] };

function state(input: unknown = STATE_INPUT): AllocatorState {
  const created = createAllocatorState(input);
  if (!created.ok) throw new Error(JSON.stringify(created.refusals));
  return created.value;
}

const BUY_REQUEST = {
  reservationId: "res-1",
  strategyInstanceId: INSTANCE,
  runMode: "PAPER",
  accountingMode: "LIVE",
  marketId: MARKET_A,
  side: "YES",
  action: "BUY",
  price: "0.5",
  shares: "100",
  scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
};

const SELL_REQUEST = {
  ...BUY_REQUEST,
  reservationId: "res-2",
  action: "SELL",
  shares: "10",
};

const POLICY_INPUT = {
  freshness: { venueBookMaxAgeMs: 1000, referenceFeedMaxAgeMs: 2000, featuresMaxAgeMs: 2000 },
  limits: { maxWorstCaseContractualLoss: "10000" },
  scenario: { maxScenarioLoss: "10000" },
  economics: {},
  participation: {},
  rateLimit: { safetyReserveRequests: 5 },
  timeToClose: { entryCutoffSeconds: 60 },
};

/** An entry whose §9.8 check 15 path is fully exercised: caps AND a snapshot. */
function exposureInput(): ReturnType<typeof entryInput> {
  const input = entryInput();
  input.exposures = exposureSnapshotFixture({
    byMarket: { [MARKET_A]: exposureEntry("10", "10") },
    measuring: FIXTURE_MEASURING,
  });
  return input;
}

const EXPOSURE_POLICY = riskPolicy({
  limits: {
    maxWorstCaseContractualLoss: "10000",
    globalExposureCap: "10000",
    perInstanceExposureCap: "10000",
    perMarketExposureCap: "10000",
    perSeriesExposureCap: "10000",
    perUnderlyingExposureCap: "10000",
    perResolutionWindowExposureCap: "10000",
  },
});

function approvedRecord(): Record<string, unknown> {
  const evaluation = evaluateIntent(riskPolicy(), entryInput());
  if (!evaluation.approved) throw new Error(JSON.stringify(codesOf(evaluation)));
  return structuredClone(evaluation.record) as unknown as Record<string, unknown>;
}

const RESIZE_REQUEST = {
  approvedIntentId: "approved-2",
  resizedAt: EVALUATED_AT,
  newTargetShares: "50",
  reason: "risk reduction",
};

// Every input is built HERE, at module scope, outside any polluted window.
const POLICY = riskPolicy();
const ENTRY = entryInput();
const EXIT = exitInput();
const CANCEL = (() => {
  const input = entryInput();
  input.intent = cancelIntent();
  return input;
})();
const EXPOSURE_ENTRY_INPUT = exposureInput();
const NO_SNAPSHOT_INPUT = (() => {
  const input = entryInput();
  delete input.exposures;
  return input;
})();
const CAPS = caps();
const OWNED_STATE = state();
const UNOWNED_STATE = state(UNOWNED_STATE_INPUT);
const FLAT_STATE = state({ ...STATE_INPUT, positions: [] });
const APPLIED = applyReservation(OWNED_STATE, CAPS, BUY_REQUEST);
const APPLIED_STATE = APPLIED.ok ? APPLIED.value.state : OWNED_STATE;
const RECORD = approvedRecord();
const COVERAGE = {
  strategyInstanceIds: [INSTANCE],
  marketIds: [MARKET_A, MARKET_B],
  seriesKeys: ["btc-15m"],
  underlyingKeys: ["BTC"],
  resolutionWindowKeys: ["w1"],
};
const SELL_NO_SIDE = { ...SELL_REQUEST, side: "NO" };

const SCENARIOS: readonly Scenario[] = [
  {
    name: "evaluateIntent — a fully passing ENTRY",
    doors: ["evaluateIntent"],
    answer: () => evaluateIntent(POLICY, ENTRY),
    material: ENTRY,
    parses: true,
  },
  {
    name: "evaluateIntent — a fully passing EXIT",
    doors: ["evaluateIntent"],
    answer: () => evaluateIntent(POLICY, EXIT),
    material: EXIT,
    parses: true,
  },
  {
    name: "evaluateIntent — a CANCEL (§6 invariant 13)",
    doors: ["evaluateIntent"],
    answer: () => evaluateIntent(POLICY, CANCEL),
    material: CANCEL,
    parses: true,
    // A cancel that "merely" became a refusal is a TRAPPED POSITION.
    identicalOrFail: true,
  },
  {
    name: "validateEvaluationInput — a CANCEL at the door (§6 invariant 13)",
    doors: ["validateEvaluationInput"],
    answer: () => validateEvaluationInput(CANCEL),
    material: CANCEL,
    parses: true,
    identicalOrFail: true,
  },
  {
    name: "evaluateIntent — every exposure limit configured and measured",
    doors: ["evaluateIntent"],
    answer: () => evaluateIntent(EXPOSURE_POLICY, EXPOSURE_ENTRY_INPUT),
    material: EXPOSURE_ENTRY_INPUT,
    parses: true,
  },
  {
    name: "evaluateIntent — an entry with NO exposure snapshot (fail closed)",
    doors: ["evaluateIntent"],
    answer: () => evaluateIntent(EXPOSURE_POLICY, NO_SNAPSHOT_INPUT),
    material: NO_SNAPSHOT_INPUT,
    parses: true,
  },
  {
    name: "validateEvaluationInput — the door",
    doors: ["validateEvaluationInput"],
    answer: () => validateEvaluationInput(ENTRY),
    material: ENTRY,
    parses: true,
  },
  {
    name: "parseRiskPolicy",
    doors: ["parseRiskPolicy"],
    answer: () => parseRiskPolicy(POLICY_INPUT),
    material: POLICY_INPUT,
    parses: true,
  },
  {
    name: "resizeApprovedIntent",
    doors: ["resizeApprovedIntent"],
    answer: () => resizeApprovedIntent(RECORD as never, RESIZE_REQUEST),
    material: { record: RECORD, request: RESIZE_REQUEST },
    parses: true,
  },
  {
    name: "parseAllocatorCaps",
    doors: ["parseAllocatorCaps"],
    answer: () => parseAllocatorCaps(CAPS_INPUT),
    material: CAPS_INPUT,
    parses: true,
  },
  {
    name: "createAllocatorState",
    doors: ["createAllocatorState"],
    answer: () => createAllocatorState(STATE_INPUT),
    material: STATE_INPUT,
    parses: true,
  },
  {
    name: "evaluateReservation — a LIVE BUY that is permitted",
    doors: ["evaluateReservation"],
    answer: () => evaluateReservation(OWNED_STATE, CAPS, BUY_REQUEST),
    material: { state: STATE_INPUT, request: BUY_REQUEST },
    parses: true,
  },
  {
    name: "evaluateReservation — a LIVE SELL against held inventory",
    doors: ["evaluateReservation"],
    answer: () => evaluateReservation(OWNED_STATE, CAPS, SELL_REQUEST),
    material: { state: STATE_INPUT, request: SELL_REQUEST },
    parses: true,
  },
  {
    name: "evaluateReservation — NO live owner recorded (the round-6 BLOCKER path)",
    doors: ["evaluateReservation"],
    answer: () => evaluateReservation(UNOWNED_STATE, CAPS, BUY_REQUEST),
    material: { state: UNOWNED_STATE_INPUT, request: BUY_REQUEST },
    parses: true,
  },
  {
    name: "evaluateReservation — a SELL with ZERO holdings (the round-6 inventory probe)",
    doors: ["evaluateReservation"],
    answer: () => evaluateReservation(FLAT_STATE, CAPS, SELL_NO_SIDE),
    material: { state: { ...STATE_INPUT, positions: [] }, request: SELL_NO_SIDE },
    parses: true,
  },
  {
    name: "applyReservation",
    doors: ["applyReservation"],
    answer: () => applyReservation(OWNED_STATE, CAPS, BUY_REQUEST),
    material: { state: STATE_INPUT, request: BUY_REQUEST },
    parses: true,
  },
  {
    name: "releaseReservation",
    doors: ["releaseReservation"],
    answer: () => releaseReservation(APPLIED_STATE, "res-1"),
    material: { state: STATE_INPUT, request: BUY_REQUEST },
    parses: false,
  },
  {
    name: "exposureSnapshotCovering",
    doors: ["exposureSnapshotCovering"],
    answer: () => exposureSnapshotCovering(OWNED_STATE, COVERAGE),
    material: { state: STATE_INPUT, coverage: COVERAGE },
    parses: false,
  },
  {
    name: "withLiveOwner",
    doors: ["withLiveOwner"],
    answer: () => withLiveOwner(UNOWNED_STATE, MARKET_A, INSTANCE),
    material: { state: UNOWNED_STATE_INPUT, marketId: MARKET_A, instance: INSTANCE },
    parses: false,
  },
  {
    name: "the live-micro fence (AGENTS.md floors)",
    doors: ["nonFloorLiveMicroCapFields", "liveMicroCapRefusals"],
    answer: () => ({
      fields: nonFloorLiveMicroCapFields(CAPS),
      refusals: liveMicroCapRefusals(CAPS),
    }),
    material: CAPS_INPUT,
    parses: false,
  },
];

describe("THE MECHANISM: an inherited property changes no public answer", () => {
  for (const scenario of SCENARIOS) {
    it(`is unmoved by anything on Object.prototype: ${scenario.name}`, () => {
      expect(sweep(scenario)).toEqual([]);
    });
  }

  it("the sweep is non-vacuous: it really does pollute, and really does compare", () => {
    // A subject that DOES read through the prototype must be caught — otherwise
    // every assertion above is a tautology about a harness that does nothing.
    const naive: Scenario = {
      name: "a deliberately naive subject",
      doors: [],
      answer: () => {
        const table: Record<string, string> = { present: "own" };
        return { read: table["marketId"] ?? "absent" };
      },
      material: { marketId: "x" },
      parses: false,
    };
    const failures = sweep(naive);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join("\n")).toContain("ANSWER CHANGED");

    // …and a subject that READS an inherited value without changing its answer
    // is caught too, so "no getter ran" is a real assertion and not one the
    // harness can only make when something else already failed.
    const quiet: Scenario = {
      name: "a subject that reads the prototype and discards the answer",
      doors: [],
      answer: () => {
        const table: Record<string, string> = {};
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        table["marketId"];
        return { constant: true };
      },
      material: { marketId: "x" },
      parses: false,
    };
    const quietFailures = sweep(quiet);
    expect(quietFailures.join("\n")).toContain("INVOKED");

    // …and the round-8 rule is real too: a subject that WRITES a name onto an
    // ordinary object invokes the inherited SETTER, and is caught even though
    // its answer never changes. Without this, "zero setter invocations" above
    // would be a property of a harness that cannot see one.
    const writer: Scenario = {
      name: "a subject that assembles its answer onto an ordinary object",
      doors: [],
      answer: () => {
        const out: Record<string, unknown> = {};
        out["marketId"] = "x";
        return { constant: true };
      },
      material: { marketId: "x" },
      parses: false,
    };
    const writerFailures = sweep(writer);
    expect(writerFailures.join("\n")).toContain("SETTER was INVOKED");
    // The throwing-setter mode of the same subject is a THROW, which is the
    // reviewer's BLOCKER in miniature: an assembly nobody reads, aborting an
    // answer.
    expect(writerFailures.join("\n")).toContain("throwing-setter");
  });

  /**
   * THE JOIN — round 6's follow-up R6-2, closed.
   *
   * Round 6 shipped two tables nothing connected: this file's SCENARIOS and
   * `public-surface.test.ts`'s classified exports. A new public door therefore
   * needed no pollution scenario, and its absence was silent. The exported
   * surface is read HERE from the module namespaces — the same mechanical source
   * the surface test uses — and every FUNCTION must be swept or registered.
   */
  const PROPAGATES_BY_CLASSIFICATION =
    "classified `propagates` in `public-surface.test.ts`: typed parameters and a result type that cannot express a refusal, so it is a helper rather than a door. Every in-repository call site runs inside a containment guard, and the DOOR that contains it is swept above";
  const PRIMITIVE_OVER_PRIMITIVES =
    "a constructor or predicate over primitives and values this package built; it reads no caller-supplied record, so there is no lookup for an inherited property to answer";

  const NOT_SWEPT: readonly { readonly name: string; readonly reason: string }[] = [
    ...(
      [
        "assessWorstCase",
        "settlementValueUnderOutcome",
        "buildWorstCaseLots",
        "assessScenarios",
        "assessFreshness",
        "buildIntentView",
        "heldShares",
        "checkExposureLimits",
        "recommendIncidentActions",
        "exposureSnapshot",
        "shadowExposureSnapshot",
        "heldSharesByKey",
        "reservedSharesByKey",
      ] as const
    ).map((name) => ({ name, reason: PROPAGATES_BY_CLASSIFICATION })),
    ...(
      [
        "riskRefusal",
        "riskOk",
        "riskFailure",
        "isRiskReasonCode",
        "isPrimaryRiskReasonCode",
        "instantMilliseconds",
        "isExpired",
        "blocksAsStale",
        "capitalRefusal",
        "capitalOk",
        "capitalFailure",
        "isCapitalRefusalCode",
        "inventoryKey",
      ] as const
    ).map((name) => ({ name, reason: PRIMITIVE_OVER_PRIMITIVES })),
  ];

  it("every public FUNCTION of both packages is swept, or registered with a reason (R6-2)", () => {
    const exported = [
      ...Object.entries(riskModule as Record<string, unknown>),
      ...Object.entries(allocatorModule as Record<string, unknown>),
    ]
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(exported.length).toBeGreaterThan(20); // non-vacuity

    const swept = new Set(SCENARIOS.flatMap((scenario) => scenario.doors));
    const registered = new Map(NOT_SWEPT.map((entry) => [entry.name, entry.reason]));
    const failures: string[] = [];
    for (const name of exported) {
      if (swept.has(name) || registered.has(name)) continue;
      failures.push(
        `${name} is a public function with NO pollution scenario and no registration — add a scenario to SCENARIOS (naming it in \`doors\`) or register it in NOT_SWEPT with a reason`,
      );
    }
    // and neither table may rot: a registration or a `doors` entry that names
    // nothing exported is a stale claim about coverage.
    for (const [name] of registered) {
      if (!exported.includes(name)) failures.push(`STALE registration: ${name} is not an export`);
    }
    for (const name of swept) {
      if (!exported.includes(name)) failures.push(`STALE scenario door: ${name} is not an export`);
    }
    expect(failures).toEqual([]);
  });

  it("every NOT_SWEPT registration carries a substantive reason", () => {
    for (const entry of NOT_SWEPT) {
      expect(entry.reason.length, entry.name).toBeGreaterThan(40);
    }
  });

  it("the key material is derived from the inputs, not from a hand-written list", () => {
    const keys = candidateKeys({ a: { b: "c" }, d: ["e"] }, ["extra"]);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toContain("c");
    expect(keys).toContain("e");
    expect(keys).toContain("extra");
    // and it never REPLACES an intrinsic member: the NAMES are dropped (their
    // values are still harvested as candidate names, which is the point of the
    // harvest — only the intrinsic spellings are excluded)
    expect(candidateKeys({ toString: "x", hasOwnProperty: "y" })).toEqual(["x", "y"]);
    expect(candidateKeys({ a: "b" }, ["toString", "constructor", "length"])).toEqual(["a", "b"]);
  });
});

describe("the zod slot-name audit is MECHANICAL (review round 9)", () => {
  /**
   * Eight review rounds of this package say hand-enumerated site lists always
   * miss one, so the round-9 slot-name material is not allowed to be one. This
   * re-derives, from the library's SHIPPED parse-path source, every `_zod`
   * instance-slot name it reads with a dotted access, and requires the pinned
   * audit and the swept material to cover the derivation IN FULL — a `zod`
   * upgrade that starts consulting a new slot is therefore a FAILING TEST here,
   * before it can be a silent prototype walk in a door.
   *
   * The `.cjs` build is read (rather than the `.js` one the test runner loads)
   * because the two are compiled from the same source and the text is what is
   * being audited; `versions.cjs` pins the library, and the lockfile pins the
   * version this audit was made against.
   */
  const ZOD_CORE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../packages/domain/node_modules/zod/v4/core",
  );
  /** The files on the synchronous parse path, construction included. */
  const PARSE_PATH_FILES = ["core.cjs", "parse.cjs", "schemas.cjs", "checks.cjs", "util.cjs"];

  /** The audited extraction at `zod@4.4.3`, sorted — the pin an upgrade hits. */
  const EXPECTED_ZOD_SLOT_READS: readonly string[] = [
    "bag",
    "check",
    "constr",
    "def",
    "deferred",
    "innerType",
    "onattach",
    "optin",
    "optout",
    "parent",
    "parse",
    "pattern",
    "propValues",
    "qin",
    "run",
    "traits",
    "values",
    "version",
  ];

  function shippedSource(file: string): string {
    return readFileSync(resolve(ZOD_CORE, file), "utf8");
  }

  it("every `_zod.<name>` read in the shipped library is audited and swept", () => {
    const extracted = new Set<string>();
    for (const file of PARSE_PATH_FILES) {
      for (const match of shippedSource(file).matchAll(/_zod\.([A-Za-z_$][A-Za-z0-9_$]*)/gu)) {
        extracted.add(match[1] ?? "");
      }
    }
    expect([...extracted].sort()).toEqual([...EXPECTED_ZOD_SLOT_READS]);
    const material = new Set(ZOD_PARSE_STATE_NAMES);
    const unswept = [...extracted].filter((name) => !material.has(name));
    expect(unswept).toEqual([]);
  });

  it("the one COMPUTED `_zod[…]` read is pinned, and its keys are already audited", () => {
    // `getTupleOptStart(items, key)` reads `items[i]._zod[key]`; its only two
    // call sites pass "optin" and "optout", both on the audited list. A new
    // computed read — one this extraction cannot name — fails here.
    const counts = PARSE_PATH_FILES.map(
      (file) => (shippedSource(file).match(/_zod\[/gu) ?? []).length,
    );
    expect(counts).toEqual([0, 0, 1, 0, 0]);
    const schemas = shippedSource("schemas.cjs");
    expect(schemas).toContain('getTupleOptStart(items, "optin")');
    expect(schemas).toContain('getTupleOptStart(items, "optout")');
  });

  it("non-vacuity: the extraction sees the two names round 9 measured live", () => {
    const schemas = shippedSource("schemas.cjs");
    expect(schemas).toContain("._zod.optin");
    expect(schemas).toContain("._zod.optout");
    expect(schemas).toContain(".def.when");
  });

  it("the audited names actually REACH the sweep's key material (anti-vacuity)", () => {
    // The round-9 mutation check found this gap in its own first draft: with
    // `ZOD_PARSE_STATE_NAMES` removed from `INTERNAL_NAMES`, every test above
    // still passed, because the derivation only bound the extraction to the
    // CONSTANT and nothing bound the constant to the material the sweep
    // actually runs. This binds it: every audited name must survive
    // `candidateKeys`' filters and arrive as a candidate key.
    const keys = new Set(candidateKeys({}, INTERNAL_NAMES));
    const missing = ZOD_PARSE_STATE_NAMES.filter((name) => !keys.has(name));
    expect(missing).toEqual([]);
  });

  it("the carve-out is exactly what it claims: an ADD that replaces nothing", () => {
    for (const name of ZOD_ARRAY_SHADOWED_NAMES) {
      expect(ZOD_PARSE_STATE_NAMES).toContain(name);
      expect(Object.hasOwn(Array.prototype, name)).toBe(true);
      expect(Object.hasOwn(Object.prototype, name)).toBe(false);
      // an array still answers from its own prototype, not from the chain
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: "inherited",
      });
      try {
        expect(([] as unknown as Record<string, unknown>)[name]).not.toBe("inherited");
        expect(({} as Record<string, unknown>)[name]).toBe("inherited");
      } finally {
        delete (Object.prototype as Record<string, unknown>)[name];
      }
    }
    // and the swept material actually receives the carved-out names
    const keys = candidateKeys({}, [...ZOD_ARRAY_SHADOWED_NAMES]);
    for (const name of ZOD_ARRAY_SHADOWED_NAMES) expect(keys).toContain(name);
  });
});

describe("review round 6 — the reviewer's probes, kept", () => {
  it("REVIEWER'S PROBE (6a): an INHERITED live owner cannot authorize a LIVE reservation", () => {
    const base = state(UNOWNED_STATE_INPUT);
    const hostile: AllocatorState = {
      ...base,
      liveOwners: Object.create({ [MARKET_A]: INSTANCE }) as Record<string, string>,
    };
    expect(Object.hasOwn(hostile.liveOwners, MARKET_A)).toBe(false);
    // the inherited value really is visible to an ordinary read — non-vacuity
    expect((hostile.liveOwners as Record<string, string>)[MARKET_A]).toBe(INSTANCE);

    const verdict = evaluateReservation(hostile, caps(), BUY_REQUEST);
    expect(verdict.permitted).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_OWNERSHIP_MISSING",
    );
  });

  it("REVIEWER'S PROBE (6b): a LIBRARY-CREATED state is not made permissive by Object.prototype", () => {
    const library = state(UNOWNED_STATE_INPUT);
    const before = evaluateReservation(library, caps(), BUY_REQUEST);
    expect(before.permitted).toBe(false);

    const after = withPollution(MARKET_A, "data-string", () =>
      evaluateReservation(library, caps(), BUY_REQUEST),
    );
    expect(after.threw).toBeUndefined();
    expect(after.answer).toBe(describe_(before));
    expect(after.answer).toContain("CAPITAL_LIVE_OWNERSHIP_MISSING");
  });

  it("REVIEWER'S PROBE (6c): an INHERITED two-answer inventory getter cannot fund a SELL", () => {
    const flat = state({ ...STATE_INPUT, positions: [] });
    const inventory = `${INSTANCE}|${MARKET_A}|YES`;
    let calls = 0;
    Object.defineProperty(Object.prototype, inventory, {
      configurable: true,
      enumerable: false,
      get(): string {
        calls += 1;
        return calls === 1 ? "1000" : "0";
      },
    });
    try {
      const verdict = evaluateReservation(flat, caps(), SELL_REQUEST);
      expect(calls).toBe(0);
      expect(verdict.permitted).toBe(false);
      expect(verdict.refusals.map((refusal) => refusal.code)).toContain(
        "CAPITAL_INVENTORY_INSUFFICIENT",
      );
    } finally {
        delete (Object.prototype as Record<string, unknown>)[inventory];
    }
  });

  it("REVIEWER'S PROBE (6d): a valid CANCEL is not trapped by an INHERITED non-canonical intentId", () => {
    const input = entryInput();
    input.intent = cancelIntent();
    const clean = evaluateIntent(riskPolicy(), input);
    expect(clean.approved).toBe(true);

    Object.defineProperty(Object.prototype, "intentId", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: "01890000-0000-7000-8000-00000000000A",
    });
    try {
      const polluted = evaluateIntent(riskPolicy(), input);
      expect(codesOf(polluted)).toEqual([]);
      expect(polluted.approved).toBe(true);
    } finally {
        delete (Object.prototype as Record<string, unknown>)["intentId"];
    }
  });

  it("REVIEWER'S PROBE (6e): an INHERITED THROWING intentId getter does not escape the door", () => {
    const input = entryInput();
    input.intent = cancelIntent();
    let calls = 0;
    Object.defineProperty(Object.prototype, "intentId", {
      configurable: true,
      enumerable: false,
      get(): never {
        calls += 1;
        throw new Error("prototype-intent-getter");
      },
    });
    try {
      const validated = validateEvaluationInput(input);
      const evaluation = evaluateIntent(riskPolicy(), input);
      expect(calls).toBe(0);
      expect(validated.ok).toBe(true);
      expect(evaluation.approved).toBe(true);
    } finally {
        delete (Object.prototype as Record<string, unknown>)["intentId"];
    }
  });

  it("an INHERITED optional field is not ADOPTED by the parse (the measured `zod` behaviour)", () => {
    // `venueEligibility` is absent from the fixture and consulted only when the
    // run mode places real orders; the parse must not invent one, and the
    // engine must not see one.
    const input = entryInput();
    const clean = validateEvaluationInput(input);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(Object.hasOwn(clean.data.context, "venueEligibility")).toBe(false);

    Object.defineProperty(Object.prototype, "venueEligibility", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: "ELIGIBLE",
    });
    try {
      const polluted = validateEvaluationInput(input);
      expect(polluted.ok).toBe(true);
      if (!polluted.ok) return;
      expect(Object.hasOwn(polluted.data.context, "venueEligibility")).toBe(false);
      expect(polluted.data.context.venueEligibility).toBeUndefined();
    } finally {
        delete (Object.prototype as Record<string, unknown>)["venueEligibility"];
    }
  });

  it("an INHERITED live-micro cap cannot raise an AGENTS.md floor", () => {
    // Found by this mechanism, not by the reviewer: the fence read an absent
    // field as "fine" while `reserve.ts` read the inherited value as the cap.
    const handBuilt = Object.create({ liveMicroMaxOrderNotional: "1000" }) as Record<
      string,
      unknown
    >;
    handBuilt["globalAccountCap"] = "1000";
    handBuilt["perStrategyCap"] = "1000";
    handBuilt["liveMicroMaxAccountExposure"] = "0";

    expect(nonFloorLiveMicroCapFields(handBuilt)).toContain("liveMicroMaxOrderNotional");
    const refusals = liveMicroCapRefusals(handBuilt);
    expect(refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
    );

    // …and the reservation gate refuses on it, for every run mode.
    const verdict = evaluateReservation(state(), handBuilt as never, BUY_REQUEST);
    expect(verdict.permitted).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
    );
  });
});

describe("deepFreeze reads descriptors, in both copies (review round 6, LOW A)", () => {
  /**
   * The round-5 mutation M-R5l — `deepFreeze` back to property reads — was
   * reported as surviving. Review round 6 showed it is distinguishable after
   * all: a freeze walk that READS properties invokes an accessor, and a walk
   * that reads DESCRIPTORS does not. This is that observation, for each copy.
   */
  for (const [name, deepFreeze] of [
    ["packages/risk", riskDeepFreeze],
    ["packages/capital-allocator", allocatorDeepFreeze],
  ] as const) {
    it(`${name}: freezing an accessor-bearing object invokes NO getter`, () => {
      let calls = 0;
      const nested = { inner: {} };
      const subject = {
        plain: nested,
        get computed(): string {
          calls += 1;
          return "never-read";
        },
      };

      const frozen = deepFreeze(subject);

      expect(calls).toBe(0);
      expect(frozen).toBe(subject);
      expect(Object.isFrozen(subject)).toBe(true);
      // the DATA members are still reached and frozen at depth — the walk did
      // not simply stop when it met the accessor
      expect(Object.isFrozen(nested)).toBe(true);
      expect(Object.isFrozen(nested.inner)).toBe(true);
      // and the accessor is still an accessor: freezing does not run it
      const descriptor = Object.getOwnPropertyDescriptor(subject, "computed");
      expect(descriptor?.get).toBeTypeOf("function");
      expect(calls).toBe(0);
    });
  }
});
