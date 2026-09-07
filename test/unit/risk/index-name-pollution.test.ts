/**
 * THE INDEX-NAME REGRESSION for the canonical door (`WP-020-FU1`).
 *
 * `WP-200-FU1`'s review round 1 measured an ADR-020 §6 hole this package's own
 * batteries could not see, because `inherited-state.test.ts` EXCLUDES
 * array-index names from its material by design (the exclusion, and its two
 * measured reasons, are documented at its `ARRAY_INDEX` constant). Round 1
 * ruled the whole append surface in scope — GRANT-AND-WIDEN — and supplied the
 * measurements, taken through the ledger door on an HONEST input:
 *
 * ```text
 * get-only accessor at Object.prototype["0"]     base 761db76   tip 7d5ac34
 *   Ledger.empty("PAPER")                        OK             LedgerConfigurationError
 *   Ledger.rebuild("PAPER", [])                  OK             LedgerConfigurationError
 *   emptyPnlState(valid identity)                bare TypeError PnlConfigurationError
 * ```
 *
 * The cause was one primitive: `plain-data.ts` accumulated with
 * `Array.prototype.push`, which is `Set`, which consults the prototype chain
 * FOR THE INDEX NAME — so an inherited get-only accessor (or a read-only data
 * property) at `"0"` made the FIRST append to an empty array throw, the
 * module's outer guard caught it, and an honest input was REFUSED. Reproduced
 * at base `b4ce0aa` before this round wrote anything: 18 divergences across two
 * index names and three shapes, every one an AVAILABILITY move.
 *
 * WHAT THIS FILE ASSERTS. Over every (index name × shape × door) cell, the
 * door's answer is byte-identical to the clean one — not merely fail-closed.
 * That is what "permission does not vary" means once the availability half is
 * closed too, and it is what lets the ledger battery's index-`"0"` disclosure
 * SHRINK in the same commit.
 *
 * THE HARNESS RULES, from `test/unit/ledger/pollution.ts`: no `expect` inside a
 * polluted window, no own property of an intrinsic replaced (every name here is
 * an index name, which neither prototype owns), and no `push` in the harness
 * itself — the first draft of that harness was defeated by this very class
 * while it was recording a divergence.
 *
 * SCOPE. Configurable shapes only: a non-configurable property cannot be
 * removed and would poison every later test file in the worker.
 */
import { describe, expect, it } from "vitest";

import { resizeApprovedIntent } from "../../../packages/risk/src/approved-intent.js";
import { checkExposureLimits } from "../../../packages/risk/src/exposure-limits.js";
import { assessFreshness } from "../../../packages/risk/src/freshness.js";
import {
  RiskEvaluationInputSchema,
  validateEvaluationInput,
} from "../../../packages/risk/src/inputs.js";
import { buildIntentView } from "../../../packages/risk/src/intent-view.js";
import { buildWorstCaseLots } from "../../../packages/risk/src/lots.js";
import {
  MAX_DEPTH,
  ownDataDetails,
  readPlainData,
  withSchemaDefaults,
} from "../../../packages/risk/src/plain-data.js";
import { assessScenarios } from "../../../packages/risk/src/scenario.js";
import { prototypeFreeParser } from "../../../packages/risk/src/schema-arena.js";
import {
  assessWorstCase,
  type MarketHoldingLot,
} from "../../../packages/risk/src/worst-case.js";
import { evaluateIntent } from "../../../packages/risk/src/index.js";
import {
  INSTANCE,
  MARKET_A,
  MARKET_B,
  allScenarios,
  entryInput,
  exitInput,
  exposureSnapshot,
  freshObservations,
  position,
  positionIntent,
  riskPolicy,
} from "./fixtures.js";

/** Appends with `CreateDataProperty` semantics — never `push`. See the header. */
function appendData<T>(target: T[], value: T): void {
  const descriptor = Object.create(null) as Record<string, unknown>;
  descriptor["value"] = value;
  descriptor["writable"] = true;
  descriptor["enumerable"] = true;
  descriptor["configurable"] = true;
  Object.defineProperty(target, `${target.length}`, descriptor);
}

interface Shape {
  readonly name: string;
  readonly descriptor: () => PropertyDescriptor;
}

const SHAPES: readonly Shape[] = [
  // The two shapes `WP-200-FU1` measured: `Set` at an absent index cannot
  // complete, so the FIRST append throws.
  { name: "accessor-get-only", descriptor: () => ({ get: () => "9", enumerable: false, configurable: true }) },
  {
    name: "accessor-throws",
    descriptor: () => ({
      get: () => {
        throw new Error("hostile getter");
      },
      enumerable: false,
      configurable: true,
    }),
  },
  { name: "data-readonly", descriptor: () => ({ value: "9", writable: false, enumerable: false, configurable: true }) },
  // Data shapes: `Set` COMPLETES here, so the append works — but the value the
  // array reports for an index it does not own does not, which is why the
  // battery keeps them.
  { name: "data-NE-9", descriptor: () => ({ value: "9", writable: true, enumerable: false, configurable: true }) },
  { name: "data-E-1", descriptor: () => ({ value: 1, writable: true, enumerable: true, configurable: true }) },
  {
    name: "accessor-get-set",
    descriptor: () => {
      const held = Object.create(null) as Record<string, unknown>;
      return {
        get: () => held["v"],
        set: (value: unknown) => {
          held["v"] = value;
        },
        enumerable: false,
        configurable: true,
      };
    },
  },
];

/**
 * `"0"` is the index every accumulator reaches first and the only one the
 * `WP-200-FU1` constructors answered at; `"1"`, `"2"` and `"6"` cover the later
 * appends (a refusal list with several entries, an array member, the string
 * inventory), and `"6"` is one of the two indices the ledger battery's derived
 * material already contained.
 */
const INDEX_NAMES: readonly string[] = ["0", "1", "2", "6"];

interface Door {
  readonly name: string;
  /**
   * The door's accumulator is CONSUMED rather than returned, so its answer
   * carries no populated array and the shape-based non-vacuity check below
   * cannot see it. Declared per door rather than inferred, because "the answer
   * has no array" is exactly what a vacuous row looks like too. Exactly one
   * door is like this (`assessFreshness` folds `bookAges`/`referenceAges`/
   * `featureAges` into three findings), and its appends are proved by the base
   * measurement instead: it diverges at `88e3a5b` under all three
   * `Set`-defeating shapes at `"0"`.
   */
  readonly internalAccumulator?: true;
  /** Any value: {@link quietly} encodes it, so a door may answer in its own shape. */
  readonly run: () => unknown;
}

function quietly(run: () => unknown): string {
  try {
    return JSON.stringify(run()) ?? "undefined";
  } catch (error) {
    const thrown = error as { constructor: { name: string }; message?: unknown };
    return `THREW ${thrown.constructor.name}: ${String(thrown.message)}`;
  }
}

const POLICY = riskPolicy();

/** A deep, wide value: several appends at several indices, in one read. */
const RICH: Record<string, unknown> = {
  id: "01890000-0000-7000-8000-000000000001",
  nested: { a: "one", b: "two", c: { d: "three" } },
  list: ["x", "y", "z", "p", "q", "r", "s", "t"],
  matrix: [["a"], ["b", "c"], []],
  flags: { yes: true, no: false },
  count: 3,
};

/** A value with SEVERAL problems, so the refusal list itself needs appends. */
function broken(): Record<string, unknown> {
  const value: Record<string, unknown> = {
    good: "ok",
    aFunction: () => 1,
    aSymbolValue: Symbol("s"),
    aBigInt: 1n,
    sparse: (() => {
      const holes: unknown[] = [];
      Object.defineProperty(holes, "3", {
        value: "late",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return holes;
    })(),
  };
  Object.defineProperty(value, "accessor", { get: () => "code", enumerable: true, configurable: true });
  Object.defineProperty(value, "__proto__", {
    value: "forbidden",
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return value;
}

const DOORS: readonly Door[] = [
  { name: "readPlainData(rich)", run: () => readPlainData(RICH, "record") },
  { name: "readPlainData(empty object)", run: () => readPlainData({}, "record") },
  { name: "readPlainData(empty array)", run: () => readPlainData({ list: [] }, "record") },
  { name: "readPlainData(broken)", run: () => readPlainData(broken(), "record") },
  { name: "readPlainData(string)", run: () => readPlainData("plain", "record") },
  {
    name: "readPlainData(too deep)",
    run: () => {
      let deep: unknown = "leaf";
      for (let level = 0; level <= MAX_DEPTH + 2; level += 1) deep = { down: deep };
      return readPlainData(deep, "record");
    },
  },
  {
    name: "withSchemaDefaults(all present)",
    run: () => {
      const read = readPlainData({ economics: { riskBuffer: "0.1" } }, "record");
      return read.ok
        ? withSchemaDefaults(read.value, [{ path: ["economics", "riskBuffer"], value: "9" }])
        : read;
    },
  },
  {
    name: "withSchemaDefaults(applies, array default)",
    run: () => {
      const read = readPlainData({ economics: {} }, "record");
      return read.ok
        ? withSchemaDefaults(read.value, [
            { path: ["economics", "kinds"], value: ["A", "B", "C", "D"] },
            { path: ["economics", "riskBuffer"], value: "0.1" },
          ])
        : read;
    },
  },
  {
    name: "withSchemaDefaults(unfilled)",
    run: () => {
      const read = readPlainData({}, "record");
      return read.ok
        ? withSchemaDefaults(read.value, [
            { path: ["missing", "one"], value: 1 },
            { path: ["missing", "two"], value: 2 },
          ])
        : read;
    },
  },
  { name: "ownDataDetails(plain)", run: () => ownDataDetails({ a: 1, b: "two", c: [1, 2, 3] }) },
  { name: "ownDataDetails(hostile)", run: () => ownDataDetails(broken()) },
  { name: "ownDataDetails(not an object)", run: () => ownDataDetails(42) },
];

/**
 * THE OTHER TEN MODULES, EACH CALLED DIRECTLY (`WP-180-FU3`).
 *
 * `WP-020-FU1` closed `plain-data.ts` and left this as its named successor
 * obligation: **77** further `.push(` sites, in ten modules the composite probe
 * below can only reach through `evaluateIntent`, where one refusal hides every
 * accumulator behind it. These doors are called directly instead, so each
 * module's own accumulator is the thing under test, and every module with a
 * converted site is represented — the mapping is stated per row so a module
 * that loses its coverage loses it visibly:
 *
 * ```text
 *   freshness        3 sites   assessFreshness            bookAges/referenceAges/featureAges
 *   intent-view      9         buildIntentView            legs, refusals
 *   lots             1         buildWorstCaseLots         built
 *   worst-case       1         assessWorstCase            perMarket
 *   scenario         1         assessScenarios            unmarkedMarketIds
 *   exposure-limits  5         checkExposureLimits        refusals
 *   inputs           1         validateEvaluationInput    refusals
 *   approved-intent  8         resizeApprovedIntent       refusals
 *   schema-arena     1         prototypeFreeParser        items (a def slot's array)
 *   engine          47         evaluateIntent             refusals, recommendations, contexts, reasons, legs
 * ```
 *
 * WHICH ROWS ARE HELD TO BYTE-IDENTITY, AND WHY THE OTHERS ARE NOT. The first
 * six modules compute with nothing but their own accumulators and
 * `packages/decimal` (itself closed by `WP-020-FU1`), so they are held to
 * BYTE-IDENTITY: {@link MODULE_DOORS}. The last four reach `zod` — whose OWN
 * arrays are the residual this round does not own, measured in two places:
 * `payload.issues.push(…)` and `handleArrayResult`'s `final.value[index] = …`
 * into a `payload.value = Array(input.length)` container. They are held to the
 * §6 BOUND instead: {@link ZOD_BOUNDED_DOORS}. `schema-arena`'s single site is
 * BUILD-TIME ONLY (`arenaSlot` runs while `prototypeFreeParser` constructs a
 * copy, which every door in this repository does at module load, in a clean
 * process, by that module's own design) and has no runtime route at all, so it
 * is stated rather than swept — see the test that says so.
 *
 * REPRODUCE-FIRST. At base `88e3a5b` the byte-identity table below is NOT
 * empty; at this tip it is. The engine row is the composite and keeps its own
 * weaker claim (see `COMPOSITE_PROBES`), for the same `zod` reason.
 */
const MODULE_DOORS: readonly Door[] = [
  {
    name: "freshness.assessFreshness",
    internalAccumulator: true,
    run: () =>
      assessFreshness(freshObservations(MARKET_A) as never, riskPolicy().freshness, MARKET_A),
  },
  {
    name: "intent-view.buildIntentView(position)",
    run: () => buildIntentView(positionIntent() as never, { positions: [], openOrders: [] } as never),
  },
  {
    name: "intent-view.buildIntentView(refusing)",
    run: () =>
      buildIntentView(positionIntent({ targetShares: "0" }) as never, {
        positions: [],
        openOrders: [],
      } as never),
  },
  { name: "lots.buildWorstCaseLots", run: () => lotsFixture() },
  { name: "worst-case.assessWorstCase", run: () => assessWorstCase(lotsFixture()) },
  {
    name: "scenario.assessScenarios",
    run: () => assessScenarios(allScenarios() as never, lotsFixture(), []),
  },
  {
    // A SPARSE snapshot, deliberately: the absent-snapshot arm returns an array
    // LITERAL and never touches the accumulator, so a probe built on it would
    // measure nothing. A snapshot that is present but does not measure the
    // queried scopes drives `entryMissing` through the module's own `push`
    // helper — the five converted sites.
    name: "exposure-limits.checkExposureLimits(sparse snapshot)",
    run: () =>
      checkExposureLimits(
        riskPolicy({
          limits: {
            maxWorstCaseContractualLoss: "10000",
            globalExposureCap: "500",
            perInstanceExposureCap: "500",
            perMarketExposureCap: "500",
            perSeriesExposureCap: "500",
          },
        }).limits,
        exposureSnapshot() as never,
        {
          strategyInstanceId: INSTANCE,
          perMarketContribution: new Map([
            [MARKET_A, "10" as never],
            [MARKET_B, "10" as never],
          ]),
          scopeByMarket: new Map([[MARKET_A, { seriesKey: "btc-15m" } as never]]),
          totalContribution: "20" as never,
        },
      ),
  },
];

/**
 * The three doors whose accumulators are closed but whose PARSE is `zod`'s.
 *
 * Their own `.push(` sites are converted like every other module's; what still
 * moves under them is the library's array handling (module comment above). They
 * are therefore held to ADR-020 §6's bound — no PERMISSION move, no ESCAPE —
 * exactly as the composite is, and NOT to byte-identity, because that claim
 * would be false and this file's whole discipline is not to make one.
 */
const ZOD_BOUNDED_DOORS: readonly Door[] = [
  { name: "inputs.validateEvaluationInput(valid)", run: () => validateEvaluationInput(entryInput()) },
  {
    name: "inputs.validateEvaluationInput(refusing)",
    run: () => validateEvaluationInput({ intent: 1 }),
  },
  { name: "approved-intent.resizeApprovedIntent(refusing)", run: () => resizeFixture() },
];

/** `buildWorstCaseLots` on a portfolio that holds both markets. */
function lotsFixture(): readonly MarketHoldingLot[] {
  const portfolio = {
    positions: [position(), position({ marketId: MARKET_B })],
    openOrders: [],
  };
  const view = buildIntentView(positionIntent() as never, portfolio as never).view;
  const built = buildWorstCaseLots(portfolio as never, view);
  // `undefined` means "the view is not one this module can build lots for",
  // which would make every row that consumes this vacuous — so it is a failure
  // of the FIXTURE, stated here rather than absorbed by a `?? []`.
  if (built === undefined) throw new Error("the lots fixture built no lots");
  return built;
}

/**
 * `resizeApprovedIntent` on a HAND-BUILT record that refuses — the shape that
 * drives `approved-intent.ts`'s refusal accumulator without needing the engine
 * to approve first (which would make the row a composite probe again).
 */
function resizeFixture(): unknown {
  return resizeApprovedIntent({ lineage: "ORIGINAL" } as never, {
    approvedIntentId: "01890000-0000-7000-8000-0000000000ab",
    resizedAt: "2026-09-03T12:00:01.000Z",
    newTargetShares: "50",
    reason: "shrink",
  });
}

/**
 * The arena's own append: `arenaSlot` copies a definition slot that is an ARRAY
 * (a `checks` list) one element at a time. Building a copy is what exercises
 * it, and building is the only thing that does.
 */
function arenaBuild(): unknown {
  return prototypeFreeParser(RiskEvaluationInputSchema) !== undefined;
}

/**
 * The package's PUBLIC composite door, measured SEPARATELY and to a weaker
 * claim — because that is what is still true.
 *
 * `WP-020-FU1` wrote here that `evaluateIntent` "runs `plain-data.ts` and then
 * eight other modules … and every one of those still accumulates with
 * `Array.prototype.push`". `WP-180-FU3` closed that: all **77** `.push(` sites
 * in the other TEN modules are `CreateDataProperty` appends through the one
 * exported `appendData` primitive `plain-data.ts` already used, and the
 * divergence census moved from **21 rows to 18** on EACH intrinsic (the three
 * killed rows are
 * quoted at the battery below, and they are the ones that were corrupting a
 * refusal vocabulary rather than merely refusing).
 *
 * WHAT REMAINS IS NOT THIS PACKAGE'S, AND IT IS NAMED. The 18 survivors are
 * the library's own array assembly — TWO sites, not one, both in the same
 * fail-closed direction (the second measured by review round 1): a WARMED
 * schema's `handleArrayResult` does `final.value[index] =
 * result.value` (`zod@4.4.3`, `v4/core/schemas.js:678`) into the container
 * `$ZodArray` allocated one line earlier as `payload.value = Array(input.length)`
 * — a SPARSE ordinary array. `schema-arena.ts` substitutes a prototype-free
 * container only for a FRESH EMPTY one (`isFreshOrdinaryContainer` requires
 * `length === 0`, deliberately: it replaces the assembly container and nothing
 * else), so a non-empty array's assembly still writes through
 * `Array.prototype`. Measured, with the stack, at this tip:
 *
 * ```text
 * TypeError: Cannot set property 0 of #<Object> which has only a getter
 *   at handleArrayResult (zod/v4/core/schemas.js:678:24)
 *   at inst._zod.parse   (zod/v4/core/schemas.js:705:17)   ← $ZodArray
 *   at copy._zod.run     (packages/risk/src/schema-arena.ts)
 * ```
 *
 * A COLD schema (first parse) throws one stop earlier instead: `Doc.write`
 * (`zod/v4/core/doc.js:24:26`) reached via `generateFastpass`
 * (`schemas.js:878`), before `handleArrayResult` runs. Same class, same
 * fail-closed direction; the enumeration was corrected from "one line" to
 * these two sites by review round 1 (its own stack capture).
 *
 * Widening the predicate would make every parsed ARRAY OUTPUT prototype-free
 * for every consumer of the shared arena (`capital-allocator`, `ledger`, `pnl`,
 * `strategy-runtime`), which is a behaviour change to four merged packages and
 * not this round's grant. It is reported as a follow-up instead. So what is
 * asserted here is still ADR-020 §6's bound rather than byte-identity: **no
 * PERMISSION move and no ESCAPE**, with the surviving class enumerated so it
 * cannot grow silently.
 */
const COMPOSITE_PROBES: readonly Door[] = [
  { name: "evaluateIntent(entry)", run: () => evaluateIntent(POLICY, entryInput()) },
  { name: "evaluateIntent(exit)", run: () => evaluateIntent(POLICY, exitInput()) },
  {
    name: "evaluateIntent(refused: not an object)",
    run: () => evaluateIntent(POLICY, "not an evaluation input"),
  },
];

/**
 * The PERMISSION of a `RiskEvaluation`, and nothing else.
 *
 * ADR-020 §6 permits refusal COMPOSITION to vary and forbids permission to. So
 * the composite comparison carries the approval flag and the refusal codes —
 * the permission's vocabulary — and deliberately not the message text or the
 * evidence payloads.
 */
function permissionOf(run: () => unknown): string {
  try {
    const outcome = run() as {
      readonly approved?: unknown;
      readonly refusals?: readonly { readonly code?: unknown }[];
    };
    const codes = Array.isArray(outcome.refusals)
      ? outcome.refusals.map((one) => String(one.code)).sort().join(",")
      : "";
    return outcome.approved === true ? "APPROVED" : `REFUSED ${codes}`;
  } catch (error) {
    return `THREW ${(error as { constructor: { name: string } }).constructor.name}`;
  }
}

interface Divergence {
  readonly property: string;
  readonly shape: string;
  readonly door: string;
  readonly clean: string;
  readonly polluted: string;
}

function sweep(target: object, doors: readonly Door[] = DOORS): readonly Divergence[] {
  const baseline = new Map<string, string>();
  for (const door of doors) baseline.set(door.name, quietly(door.run));
  const moved: Divergence[] = [];
  for (const property of INDEX_NAMES) {
    for (const shape of SHAPES) {
      let installed = false;
      try {
        Object.defineProperty(target, property, shape.descriptor());
        installed = true;
        for (const door of doors) {
          const polluted = quietly(door.run);
          const clean = baseline.get(door.name) ?? "";
          if (polluted !== clean) {
            appendData(moved, { property, shape: shape.name, door: door.name, clean, polluted });
          }
        }
      } finally {
        if (installed) {
          Reflect.deleteProperty(target, property);
          // Deleting an index never lowers an array's length, and
          // `Array.prototype` is an array.
          if (target === Array.prototype) Array.prototype.length = 0;
        }
      }
    }
  }
  return moved;
}

/** How many NON-EMPTY arrays a door's answer carries, at any depth. */
function populatedArrays(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || typeof value !== "object") return 0;
  let found = 0;
  if (Array.isArray(value)) {
    if (value.length > 0) found += 1;
    for (const member of value) found += populatedArrays(member, depth + 1);
    return found;
  }
  for (const member of Object.values(value as Record<string, unknown>)) {
    found += populatedArrays(member, depth + 1);
  }
  return found;
}

function render(moved: readonly Divergence[]): readonly string[] {
  return moved.map(
    (one) =>
      `${one.property} | ${one.shape} | ${one.door}: ${one.clean.slice(0, 90)} -> ${one.polluted.slice(0, 90)}`,
  );
}

describe("THE BOUND at an index name: neither permission nor availability varies", () => {
  it("every `plain-data` door is byte-identical under every shape at every index (`Object.prototype`)", () => {
    expect(render(sweep(Object.prototype))).toEqual([]);
  });

  it("every `plain-data` door is byte-identical under every shape at every index (`Array.prototype`)", () => {
    // The lower link. `plain-data.ts` appends to ARRAYS, so a shape here is
    // found before `Object.prototype` is consulted at all.
    expect(render(sweep(Array.prototype))).toEqual([]);
  });

  it("every SELF-CONTAINED module's own door is byte-identical too (`Object.prototype`)", () => {
    // `WP-180-FU3`: the 77-site conversion, measured where it lives rather than
    // only through `evaluateIntent`, where one refusal hides every accumulator
    // behind it. At base `88e3a5b` this list is NOT empty.
    expect(render(sweep(Object.prototype, MODULE_DOORS))).toEqual([]);
  });

  it("every SELF-CONTAINED module's own door is byte-identical too (`Array.prototype`)", () => {
    expect(render(sweep(Array.prototype, MODULE_DOORS))).toEqual([]);
  });

  it("NON-VACUITY of the module table: every door really runs, and none is a no-op", () => {
    // A door that throws in a CLEAN process would make its row trivially
    // "identical" (the same throw, polluted or not) and measure nothing; a door
    // whose answer carries NO populated array never reached an append, which is
    // the same vacuity one level down (it is how the first draft of the
    // `exposure-limits` row was caught: its absent-snapshot arm returns an
    // array literal and never touches the accumulator).
    for (const door of [...MODULE_DOORS, ...ZOD_BOUNDED_DOORS]) {
      const clean = quietly(door.run);
      expect(clean.startsWith("THREW"), `${door.name} throws in a clean process: ${clean}`).toBe(
        false,
      );
      if (door.internalAccumulator === true) continue;
      expect(populatedArrays(door.run()), `${door.name} appended nothing`).toBeGreaterThan(0);
    }
    // The exemption is CLOSED: exactly one door claims it, by name.
    expect(
      [...MODULE_DOORS, ...ZOD_BOUNDED_DOORS]
        .filter((door) => door.internalAccumulator === true)
        .map((door) => door.name),
    ).toEqual(["freshness.assessFreshness"]);
    // …and the modules the two tables claim to cover are all named in them, so
    // a module that silently loses its row fails HERE.
    const named = [...MODULE_DOORS, ...ZOD_BOUNDED_DOORS].map((door) => door.name.split(".")[0]);
    expect([...new Set(named)].sort()).toEqual([
      "approved-intent",
      "exposure-limits",
      "freshness",
      "inputs",
      "intent-view",
      "lots",
      "scenario",
      "worst-case",
    ]);
  });
});

describe("the `zod`-bounded doors: the §6 bound, and the library's arrays named", () => {
  it("never moves PERMISSION and never lets a throw escape, on either intrinsic", () => {
    for (const target of [Object.prototype, Array.prototype]) {
      for (const row of render(sweep(target, ZOD_BOUNDED_DOORS))) {
        // Every survivor is a refusal turning into another refusal, or an
        // acceptance turning into a refusal. Never the other direction, and
        // never an escape: `quietly` renders a throw as `THREW …`, and the
        // package's own containment means one never reaches it.
        expect(row, row).not.toContain("-> THREW");
        expect(row, row).not.toMatch(/: \{"ok":false.* -> \{"ok":true/u);
      }
    }
  });

  it("NON-VACUITY: the class is real here — these doors DO still move", () => {
    // If the library is ever fixed (or the arena's container substitution is
    // widened, the named follow-up), this fails and the rows above should be
    // promoted to byte-identity rather than left describing a fiction.
    expect(render(sweep(Object.prototype, ZOD_BOUNDED_DOORS)).length).toBeGreaterThan(0);
  });
});

describe("`schema-arena`'s single site is BUILD-TIME, and building is clean by design", () => {
  it("a copy built in a clean process is what every door in this repository holds", () => {
    // The arena's contract (module header): a schema it cannot copy is a BUILD
    // failure rather than an unprotected parse, and every consumer builds its
    // copy at module load. `arenaSlot`'s converted append therefore has no
    // runtime route — there is no caller that can reach it under pollution
    // without first having polluted the intrinsics before this module loaded,
    // at which point `warmNode` has already failed the build loudly.
    expect(arenaBuild()).toBe(true);
    // Non-vacuity of the claim that building is the only route: a BUILT copy
    // parses without ever appending through `arenaSlot` again.
    const copy = prototypeFreeParser(RiskEvaluationInputSchema) as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(copy.safeParse({}).success).toBe(false);
  });
});

/**
 * The composite door, measured to ADR-020 §6's bound and its remainder
 * ENUMERATED.
 *
 * This is the honest edge of the round. `packages/risk` is closed — all eleven
 * modules — and `zod`'s array assembly is not, and pretending otherwise would
 * repeat exactly the mistake `WP-200-FU1` review round 1 found ("a pass-through
 * for every legitimate call", measurably false at `"0"`). What holds is the
 * bound.
 */
describe("the composite door: the §6 bound holds, and the remainder is stated", () => {
  const compositeSweep = (): { readonly permission: string[]; readonly kinds: Set<string> } => {
    const baseline = new Map<string, string>();
    for (const probe of COMPOSITE_PROBES) baseline.set(probe.name, permissionOf(probe.run));
    const permission: string[] = [];
    const kinds = new Set<string>();
    for (const property of INDEX_NAMES) {
      for (const shape of SHAPES) {
        let installed = false;
        try {
          Object.defineProperty(Object.prototype, property, shape.descriptor());
          installed = true;
          for (const probe of COMPOSITE_PROBES) {
            const clean = baseline.get(probe.name) ?? "";
            const polluted = permissionOf(probe.run);
            const raw = quietly(probe.run);
            if (raw !== quietly(() => probe.run())) {
              // Two identical calls in the same window must agree: a door that
              // is not deterministic under pollution is a different finding.
              kinds.add("NONDETERMINISTIC");
            }
            if (polluted === clean) continue;
            if (polluted.startsWith("THREW")) {
              kinds.add("ESCAPE");
            } else if (clean === "APPROVED" && polluted.startsWith("REFUSED")) {
              kinds.add("AVAILABILITY");
            } else if (clean.startsWith("REFUSED") && polluted.startsWith("REFUSED")) {
              kinds.add("COMPOSITION");
            } else {
              kinds.add("PERMISSION");
            }
            appendData(permission, `${property} | ${shape.name} | ${probe.name}: ${clean} -> ${polluted}`);
          }
        } finally {
          if (installed) Reflect.deleteProperty(Object.prototype, property);
        }
      }
    }
    return { permission, kinds };
  };

  it("never turns a refusal into an approval, and never lets a throw escape", () => {
    const { kinds } = compositeSweep();
    expect([...kinds].sort()).not.toContain("PERMISSION");
    expect([...kinds].sort()).not.toContain("ESCAPE");
    expect([...kinds].sort()).not.toContain("NONDETERMINISTIC");
  });

  it("the remainder is exactly AVAILABILITY, and it is THIRD-PARTY (`WP-180-FU3`)", () => {
    // THE ROW THIS REPLACES, AND WHY IT WAS DELETED. `WP-020-FU1` wrote a row
    // here titled "the remainder is exactly AVAILABILITY, and it is NOT empty",
    // whose own comment said: "the day the rest of the package's append surface
    // is widened this test must be deleted rather than left describing a
    // fiction". That day is this round. The row enumerated THREE refusal
    // vocabularies; two of them were `packages/risk` accumulators corrupting
    // under the get/set shape (where every ordinary array in the process shares
    // one backing slot) and they are GONE:
    //
    //   deleted  REFUSED RISK_TIME_TO_CLOSE_UNKNOWN,RISK_TRADING_PARAMETERS_UNKNOWN,undefined
    //   deleted  REFUSED RISK_TRADING_PARAMETERS_UNKNOWN,undefined
    //
    // A refusal list containing the literal `undefined` was never a refusal
    // this package can emit — it was an accumulator reading a polluted slot —
    // so those two rows are the measured behaviour change, not a count.
    //
    // WHAT IS LEFT is one vocabulary and one cause, both named in the block
    // comment above `COMPOSITE_PROBES`: `zod`'s own `handleArrayResult` writing
    // into `Array(input.length)`. It is still AVAILABILITY (an APPROVED
    // evaluation becomes a refused one, fail-closed), still no COMPOSITION move
    // at all, and it is NOT empty — asserted in both directions so neither a
    // silent regrowth nor a silent library fix passes unnoticed.
    const { kinds, permission } = compositeSweep();
    expect(permission.length).toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual(["AVAILABILITY"]);
    for (const row of permission) expect(row, row).toContain("APPROVED -> REFUSED");
    expect(
      [...new Set(permission.map((row) => row.slice(row.indexOf("-> ") + 3)))].sort(),
    ).toEqual(["REFUSED RISK_INPUT_INVALID"]);
  });
});

describe("NON-VACUITY: the class is real, and `push` is what carries it", () => {
  it("`Array.prototype.push` still throws at the FIRST append under a get-only `0`", () => {
    // The primitive the module used to use, measured directly. If this ever
    // stops throwing, the battery above is no longer testing anything and the
    // `appendData` comment in `plain-data.ts` is describing a fiction.
    let pushed: string;
    let defined: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        get: () => "9",
        enumerable: false,
        configurable: true,
      });
      pushed = quietly(() => {
        const target: unknown[] = [];
        target.push("first");
        return target.length;
      });
      defined = quietly(() => {
        const target: unknown[] = [];
        appendData(target, "first");
        return target.length;
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(pushed.startsWith("THREW TypeError")).toBe(true);
    expect(defined).toBe("1");
  });

  it("a READ-ONLY inherited `0` breaks `push` too — the class is not only accessors", () => {
    let pushed: string;
    try {
      Object.defineProperty(Object.prototype, "0", {
        value: "9",
        writable: false,
        enumerable: false,
        configurable: true,
      });
      pushed = quietly(() => {
        const target: unknown[] = [];
        target.push("first");
        return target.length;
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(pushed.startsWith("THREW TypeError")).toBe(true);
  });

  it("the door really does produce the appends the battery needs", () => {
    // Non-vacuity of the MATERIAL: the rich read must populate the string
    // inventory past index 6, and the broken read must produce several
    // problems, or the sweep would be polluting indices nothing reaches.
    const rich = readPlainData(RICH, "record");
    expect(rich.ok).toBe(true);
    if (rich.ok) expect(rich.strings.length).toBeGreaterThan(6);
    const bad = readPlainData(broken(), "record");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.length).toBeGreaterThan(2);
  });
});

describe("the widening did not change what the door SAYS", () => {
  it("still refuses every shape it refused, with the same paths", () => {
    const bad = readPlainData(broken(), "record");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const problems = bad.problems.map((one) => `${one.path} :: ${one.problem}`).sort();
    expect(problems.map((one) => one.split(" :: ")[0])).toEqual([
      "record.__proto__",
      "record.aBigInt",
      "record.aFunction",
      "record.aSymbolValue",
      "record.accessor",
      "record.sparse",
    ]);
    expect(problems.map((one) => (one.split(" :: ")[1] ?? "").slice(0, 22))).toEqual([
      'a "__proto__" property',
      "a record carries data,",
      "a record carries data,",
      "a record carries data,",
      "an accessor property: ",
      "a sparse array: a reco",
    ]);
  });

  it("still emits an own, prototype-free, ordered tree", () => {
    const read = readPlainData(RICH, "record");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const value = read.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.keys(value)).toEqual(["id", "nested", "list", "matrix", "flags", "count"]);
    expect(value["list"]).toEqual(["x", "y", "z", "p", "q", "r", "s", "t"]);
    expect(Array.isArray(value["list"])).toBe(true);
    expect(value["matrix"]).toEqual([["a"], ["b", "c"], []]);
    // Every element is an OWN data property of the array, not a hole.
    const list = value["list"] as unknown[];
    expect(Object.getOwnPropertyNames(list).sort()).toEqual(
      ["0", "1", "2", "3", "4", "5", "6", "7", "length"].sort(),
    );
    for (const index of ["0", "7"]) {
      const descriptor = Object.getOwnPropertyDescriptor(list, index);
      expect(descriptor?.enumerable).toBe(true);
      expect(descriptor?.writable).toBe(true);
      expect(descriptor?.configurable).toBe(true);
    }
  });
});
