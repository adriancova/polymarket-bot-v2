/**
 * The derivation MECHANISM, tested against a fixture that contains every export
 * shape (remediation round 5, 2026-09-03).
 *
 * Why a fixture and not only the real packages. Review round 5's finding was
 * not that a boundary was wrong today — no production callable uses the shapes
 * below — but that the MECHANISM promised to catch tomorrow's boundary and
 * could not. A mechanism's coverage cannot be demonstrated by the code it
 * happens to be pointed at; it has to be demonstrated by code that contains the
 * cases. So `fixtures/boundary-shapes/` is a small, real, compiling two-module
 * "repository" carrying all of them, and this file asserts the EXACT set the
 * derivation yields from it.
 *
 * The reviewer's matrix, reproduced against round 4's scan before any change:
 *
 * | shape                                             | round 4      | now |
 * | ------------------------------------------------- | ------------ | --- |
 * | exported arrow constant                            | caught       | caught |
 * | named re-export of an `export function`            | caught       | caught |
 * | overloads                                          | caught, loud | one entry per signature |
 * | rest parameter                                     | caught       | caught |
 * | destructured parameter                             | caught       | caught |
 * | ordinary method on an exported class               | caught       | caught |
 * | `export *`                                         | MISCLASSIFIED (PACKAGE) | PUBLIC |
 * | `export function` declared IN the entry point      | MISCLASSIFIED (PACKAGE) | PUBLIC |
 * | `function f(); export { f }` + a barrel            | INVISIBLE    | PUBLIC |
 * | method on an exported object literal               | INVISIBLE    | caught |
 * | arrow-function field on an exported class          | INVISIBLE    | caught |
 * | getter / setter on an exported class               | INVISIBLE    | both caught |
 * | class exported as a TYPE with escaping instances    | INVISIBLE    | instance PUBLIC, `new` PACKAGE |
 * | a value with construct signatures that is no class | INVISIBLE    | REFUSED, loudly |
 * | a private member                                    | absent       | absent |
 * | an interface only ever taken as a PARAMETER         | absent       | absent |
 *
 * REMEDIATION ROUND 6, 2026-09-03. Review round 6 pointed the same method at the
 * RETURN position and found the derivation silent — not wrong, silent — for
 * three shapes, and this round's own hunt found four more. The binding property
 * is now stated once, in `boundary-derivation.ts`: *every callable shape is
 * either enumerated by name or recorded as `unresolved` by name; silence is
 * never an outcome.* Both halves are fixtures:
 *
 * | shape (round 6)                                      | round 5           | now |
 * | ---------------------------------------------------- | ----------------- | --- |
 * | a getter whose value is a function                   | SILENTLY ABSENT   | `X (returned)` |
 * | a function that returns a function                   | SILENTLY ABSENT   | `X (returned)` |
 * | a callable returned by a callable returned by a getter | SILENTLY ABSENT | both hops |
 * | `T extends … ? Left : Right`                          | SILENTLY ABSENT   | both branches |
 * | a callable interface (a callable `Proxy`'s type)      | SILENTLY ABSENT   | `X (returned)` |
 * | `Readonly<OurInterface>` (found this round)           | SILENTLY ABSENT   | enumerated |
 * | an anonymous inline return type                       | named `handed out` | named by its site |
 * | a callable-only index signature                       | SILENTLY ABSENT   | REFUSED by name |
 * | `readonly Fn[]` (found this round)                    | SILENTLY ABSENT   | REFUSED by name |
 * | `Promise<Facade>` (found this round)                  | SILENTLY ABSENT   | REFUSED by name |
 * | a handed-out `new (…)` (found this round)             | SILENTLY ABSENT   | REFUSED by name |
 * | a chain past `MAX_SURFACE_DEPTH` (found this round)   | SILENTLY TRUNCATED | REFUSED by name |
 *
 * REMEDIATION ROUND 7, 2026-09-03. Review round 7 found three more, and the
 * first of them is the only one so far that hid PUBLIC callables from the
 * hostile battery rather than merely from the list:
 *
 * | shape (round 7)                                       | round 6           | now |
 * | ----------------------------------------------------- | ----------------- | --- |
 * | a class VALUE returned by a public factory             | every member PACKAGE | PUBLIC, member by member |
 * | …its abstract constructor                              | PACKAGE `constructor` | PUBLIC `abstract constructor` |
 * | …its abstract declarations                             | PACKAGE `method`, as if we implemented it | PACKAGE `abstract declaration` |
 * | a callable far below a returned index value            | SILENTLY ABSENT   | REFUSED by name |
 * | a callable far below a foreign container's argument    | SILENTLY ABSENT   | REFUSED by name |
 * | a callable far below a NAMED property chain            | SILENTLY ABSENT   | REFUSED by name |
 * | a key-REMAPPED mapped property                         | SILENTLY ABSENT   | enumerated under the remapped name |
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  deriveBoundarySurface,
  MAX_SURFACE_DEPTH,
  type Derivation,
  type DerivedCallable,
} from "./boundary-derivation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES = join(HERE, "fixtures", "boundary-shapes");

function describeEntry(entry: DerivedCallable): string {
  return `${entry.id} [${entry.visibility}] (${entry.params.join(", ")}) <${entry.shape}>`;
}

/**
 * Exactly what the fixture's two entry points expose. Written out in full: a
 * subset assertion would pass for a mechanism that saw half the shapes, which
 * is precisely the failure round 5 reported.
 */
const EXPECTED_SHAPES: readonly string[] = [
  // Round 7, M7-3: a class VALUE handed out by a public factory. Neither class
  // is exported by name, so every PUBLIC below is derived from the factory's
  // return type alone — which is exactly what the walk used to drop.
  'AbstractHandedOut.compute [PACKAGE] (value) <abstract declaration>',
  'AbstractHandedOut.concrete [PUBLIC] (value) <method>',
  'AbstractHandedOut.constructor [PUBLIC] (label) <abstract constructor>',
  'AbstractHandedOut.execute [PACKAGE] (value) <abstract declaration>',
  'AbstractHandedOut.handler (getter) [PACKAGE] () <abstract declaration>',
  'AbstractHandedOut.parse [PUBLIC] (raw) <method>',
  'ConcreteHandedOut.constructor [PUBLIC] (seed) <constructor>',
  'ConcreteHandedOut.run [PUBLIC] (value) <method>',
  // …and a class the walk meets as package-internal FIRST and as handed-out
  // second: the visited-class guard has to admit the second reading.
  'TwiceReachedClass.constructor [PUBLIC] (note) <constructor>',
  'TwiceReachedClass.reached [PUBLIC] (value) <method>',
  'abstractClassFactory [PUBLIC] () <function>',
  'concreteClassFactory [PUBLIC] () <function>',
  'twiceReachedFactory [PUBLIC] () <function>',
  // Round 7, M7-1: a key-remapped mapped property, under its remapped name.
  'remappedFactory [PUBLIC] () <function>',
  'remappedFactory (returned).renamed_handler [PUBLIC] (value) <declared method>',
  'ExportedClass.constructor [PUBLIC] (label) <constructor>',
  'ExportedClass.current (getter) [PUBLIC] () <getter>',
  'ExportedClass.current (setter) [PUBLIC] (next) <setter>',
  'ExportedClass.field [PUBLIC] (value) <property function>',
  'ExportedClass.method [PUBLIC] (value) <method>',
  'ExportedClass.staticMethod [PUBLIC] (value) <method>',
  'HandedOutFacade.compute [PUBLIC] (value) <declared property function>',
  'HandedOutFacade.describe [PUBLIC] (value, label) <declared method>',
  // Round 6: both branches of a generic conditional return type.
  'LeftBranch.left [PUBLIC] (value) <declared method>',
  'RightBranch.right [PUBLIC] (value) <declared method>',
  // Round 6: a mapped type in the return position — `Readonly<MarketView>`'s shape.
  'MappedFacade.mapped [PUBLIC] (value) <declared method>',
  // Round 6: a getter whose value is a function, and two hops of the same.
  'ReturningAccessor.handler (getter) [PUBLIC] () <getter>',
  'ReturningAccessor.handler (returned) [PUBLIC] (value) <returned callable>',
  'NestedReturningAccessor.outer (getter) [PUBLIC] () <getter>',
  'NestedReturningAccessor.outer (returned) [PUBLIC] () <returned callable>',
  'NestedReturningAccessor.outer (returned) (returned) [PUBLIC] (value) <returned callable>',
  'TypeOnlyExportedClass.constructor [PACKAGE] (seed) <constructor>',
  'TypeOnlyExportedClass.describe [PUBLIC] (value) <method>',
  'arrowConst [PUBLIC] (value) <callable const>',
  'clauseOnly [PUBLIC] (value) <function>',
  'conditionalFactory [PUBLIC] (flag) <function>',
  'directlyInTheEntryPoint [PUBLIC] (value, label) <function>',
  // Round 6: a callable interface — the type a callable `Proxy` is handed out under.
  'makeCallableFacade [PUBLIC] () <function>',
  'makeCallableFacade (returned) [PUBLIC] (value) <returned callable>',
  'makeFacade [PUBLIC] () <function>',
  // Round 6: an ordinary function that returns a function.
  'makeHandler [PUBLIC] () <function>',
  'makeHandler (returned) [PUBLIC] (value) <returned callable>',
  // Round 6: an anonymous inline return type, named by its SITE rather than
  // by the placeholder "handed out" every such type used to share.
  'makeInline [PUBLIC] () <function>',
  'makeInline (returned).inline [PUBLIC] (value) <declared method>',
  'makeMapped [PUBLIC] () <function>',
  'makeTypeOnly [PUBLIC] (seed) <function>',
  'objectApi.method [PUBLIC] (value) <method>',
  'objectApi.nested.deeper [PUBLIC] (value) <property function>',
  'overloaded (overload 1 of 2) [PUBLIC] (value) <function>',
  'overloaded (overload 2 of 2) [PUBLIC] (value) <function>',
  'packageOnly [PACKAGE] (value) <function>',
  'reexportedFunction [PUBLIC] (value) <function>',
  'starredFunction [PUBLIC] (value) <function>',
  'usesPort [PUBLIC] (port, value) <function>',
  'withDestructuring [PUBLIC] ({ first }) <function>',
  'withRest [PUBLIC] (values) <function>',
];

/** One program for the whole file; it costs ~47 ms to build. */
let cached: Derivation | undefined;
function fixtureSurface(): Derivation {
  cached ??= deriveBoundarySurface({
    root: FIXTURES,
    configRoot: REPO_ROOT,
    packageDirs: ["main/src", "declarations/src"],
    entryPoints: ["main/src/index.ts", "declarations/src/index.ts"],
  });
  return cached;
}

/**
 * The refusal half, cached the same way (~45 ms). Round 7 added a second test
 * over this fixture, and a second program build with it until this cache; the
 * derivation is a pure function of the fixture, so one build answers both.
 */
let cachedUnnamed: Derivation | undefined;
function unnamedSurface(): Derivation {
  cachedUnnamed ??= deriveBoundarySurface({
    root: FIXTURES,
    configRoot: REPO_ROOT,
    packageDirs: ["unnamed/src"],
    entryPoints: ["unnamed/src/index.ts"],
  });
  return cachedUnnamed;
}

describe("the derivation sees every export shape, and classifies each one", () => {
  it("derives exactly the fixture's boundary, shape by shape", () => {
    const derivation = fixtureSurface();
    expect(derivation.diagnostics, "the fixture must be a program that compiles").toEqual([]);
    expect(derivation.unresolved).toEqual([]);
    expect(derivation.callables.map(describeEntry).sort()).toEqual([...EXPECTED_SHAPES].sort());
  });

  it("the three shapes round 4 could not see AT ALL are public now", () => {
    // `function f(); export { f }` behind a barrel, a method on an exported
    // object literal, and an arrow-function field on an exported class. Each
    // produced ZERO derived entries under the scan, so all seven tests passed
    // with the boundary present.
    const byId = new Map(fixtureSurface().callables.map((entry) => [entry.id, entry]));
    for (const id of ["clauseOnly", "objectApi.method", "ExportedClass.field"]) {
      const entry = byId.get(id);
      expect(entry, `${id} is invisible again`).toBeDefined();
      expect(entry?.visibility, `${id} visibility`).toBe("PUBLIC");
      expect(entry?.params, `${id} parameters`).toEqual(["value"]);
    }
  });

  it("the two shapes round 4 MISCLASSIFIED are PUBLIC now", () => {
    // Both were derived but marked PACKAGE, which is worse than invisible: the
    // registry accepted the wrong classification and the fuzz skipped them.
    const byId = new Map(fixtureSurface().callables.map((entry) => [entry.id, entry]));
    expect(byId.get("starredFunction")?.visibility, "export *").toBe("PUBLIC");
    expect(byId.get("directlyInTheEntryPoint")?.visibility, "declared in the entry point").toBe(
      "PUBLIC",
    );
    expect(byId.get("directlyInTheEntryPoint")?.params).toEqual(["value", "label"]);
  });

  it("a class exported as a TYPE still exposes its instance members", () => {
    // `StrategyInstanceRuntime`'s shape: `new` is unreachable from outside, but
    // instances escape through a factory, so the methods are public.
    const byId = new Map(fixtureSurface().callables.map((entry) => [entry.id, entry]));
    expect(byId.get("TypeOnlyExportedClass.describe")?.visibility).toBe("PUBLIC");
    expect(byId.get("TypeOnlyExportedClass.constructor")?.visibility).toBe("PACKAGE");
  });

  it("an accessor pair is TWO callables, and an overload set is one entry per signature", () => {
    // Both used to collapse into a single entry, so a setter — the one half
    // that takes caller data — could be added without any test noticing.
    const ids = fixtureSurface().callables.map((entry) => entry.id);
    expect(ids).toContain("ExportedClass.current (getter)");
    expect(ids).toContain("ExportedClass.current (setter)");
    expect(ids.filter((id) => id.startsWith("overloaded"))).toHaveLength(2);
  });

  it("what it must NOT enumerate: private members, and contracts somebody else implements", () => {
    const ids = fixtureSurface().callables.map((entry) => entry.id);
    // A private method is not reachable from outside the class.
    expect(ids).not.toContain("ExportedClass.hidden");
    // `NeverImplementedPort` is only ever a PARAMETER: the composition root
    // implements it, so classifying its totality would be a claim about code
    // that does not live here. Same for a declarations-only entry point.
    expect(ids).not.toContain("NeverImplementedPort.persist");
    expect(ids).not.toContain("DeclaredOnly.compute");
  });

  it("round 6: a callable reached through the RETURN position is enumerated, by name", () => {
    // Review round 6's finding, made permanent. Every id below appeared in
    // NEITHER `callables` NOR `unresolved` under round 5's walk: the derivation
    // called `visitProperties` on a handed-out type and nothing else, so a
    // returned callable, a conditional branch and a mapped-type member were all
    // silently absent. Silence is the one outcome this mechanism may not have.
    const byId = new Map(fixtureSurface().callables.map((entry) => [entry.id, entry]));
    for (const [id, params] of [
      // a getter whose value is a function, and the reviewer's note that an
      // ordinary function returning a function has the same hole
      ["ReturningAccessor.handler (returned)", ["value"]],
      ["makeHandler (returned)", ["value"]],
      // two hops: a callable returned from a callable returned from a getter
      ["NestedReturningAccessor.outer (returned)", []],
      ["NestedReturningAccessor.outer (returned) (returned)", ["value"]],
      // BOTH branches of `T extends string ? LeftBranch : RightBranch`
      ["LeftBranch.left", ["value"]],
      ["RightBranch.right", ["value"]],
      // a callable interface: the shape a callable `Proxy` is handed out under
      ["makeCallableFacade (returned)", ["value"]],
      // a mapped type — the SDK returns `Readonly<MarketView>` and its siblings
      ["MappedFacade.mapped", ["value"]],
      // an anonymous inline return type, named by its site
      ["makeInline (returned).inline", ["value"]],
    ] as ReadonlyArray<readonly [string, readonly string[]]>) {
      const entry = byId.get(id);
      expect(entry, `${id} is silently absent again`).toBeDefined();
      expect(entry?.visibility, `${id} visibility`).toBe("PUBLIC");
      expect(entry?.params, `${id} parameters`).toEqual(params);
    }
    // …and the walk still refuses nothing over this fixture, so the enumeration
    // above is a real answer rather than a wave of refusals.
    expect(fixtureSurface().unresolved).toEqual([]);
  });

  it("round 6: where no NAME reaches the callable, the walk REFUSES by name", () => {
    // The other half of the binding property. An index has no name, an array
    // element has an index, a promised value has neither; a probe cannot drive
    // any of them, so inventing an id would put a registry entry in front of the
    // hostile battery that it could never call. The reviewer's instruction —
    // "emit `unresolved` where no concrete callable name can be driven" — taken
    // literally. Every one of these was SILENT before this round.
    const derivation = unnamedSurface();
    expect(derivation.diagnostics, "the fixture must be a program that compiles").toEqual([]);
    expect(derivation.unresolved.map((entry) => entry.id).sort()).toEqual([
      // a callable-only string index signature (the reviewer's shape 7)
      "CallableIndex[string]",
      // Round 7, M7-2, at the enumeration's own depth bound: the same chain
      // reached by NAME. Nothing was refused here before, because the predicate
      // that decides whether to refuse answered "nothing below".
      "Deep7.next",
      // Round 7, M7-2: a callable far below a returned string-index value. The
      // predicate ran out of depth and reported "no callables", so this was in
      // NEITHER list — silence behind a bound documented as always refusing.
      "DeepIndex[string]",
      // a chain of returned facades past MAX_SURFACE_DEPTH: it used to truncate
      // in silence, which is how a whole subtree of callables could disappear
      "Hop3.hop (returned)",
      // `readonly ((value: unknown) => string)[]`
      "arrayFactory (returned)[number]",
      // a handed-out value someone can `new` that is not one of our classes
      "constructibleFactory (returned)",
      // Round 7, M7-2, on the foreign-container path.
      "deepContainerFactory (returned) (type argument 1 of Promise<Deep0>)",
      // Round 7, M7-1's other half: a synthesized property whose OWN call
      // signature is the standard library's, with one of ours underneath. The
      // walk will not claim somebody else's implementation, and it will not
      // pass over ours either, so it stops.
      "foreignRemappedFactory (returned).x_stringify",
      // a facade reachable only as a foreign container's type argument
      "promiseFactory (returned) (type argument 1 of Promise<PromisedFacade>)",
    ]);
    for (const entry of derivation.unresolved) {
      // A refusal has to tell the reader what to do about it, or it is just a
      // different kind of dead end.
      expect(entry.why.length, `${entry.id} explanation`).toBeGreaterThan(80);
    }
    // The factories themselves are still enumerated — the refusal is about what
    // they RETURN, not about them — and the reachable part of the deep chain is
    // enumerated up to the bound rather than dropped with it.
    expect(derivation.callables.map((entry) => entry.id).sort()).toEqual([
      "Hop0.hop",
      "Hop1.hop",
      "Hop2.hop",
      "Hop3.hop",
      "arrayFactory",
      "constructibleFactory",
      "deepContainerFactory",
      "deepFactory",
      "deepIndexFactory",
      "deepNamedFactory",
      "foreignRemappedFactory",
      "indexFactory",
      "promiseFactory",
    ]);
  });

  it("round 7: depth exhaustion is REFUSED by name, never answered “no callable”", () => {
    // Review round 7's M7-2. `carriesCallables` was a BOOLEAN, so the one thing
    // it could not say is "I ran out of depth before I could tell" — and every
    // caller read that silence as "there is nothing there". The reviewer's
    // reproduction: a callable ten property hops beneath a returned string-index
    // value gave `callables: [deepIndexFactory]`, `unresolved: []`,
    // `diagnostics: []`, which contradicts both the binding property and the
    // claim that MAX_SURFACE_DEPTH always refuses.
    //
    // Three sites consult the predicate, and the fixture chain is long enough to
    // exhaust it at all three. Each must now name its refusal AND say that the
    // bound, not the type, is the reason — a reader who cannot tell "nothing is
    // there" from "I could not look" is back where round 7 started.
    const why = new Map(unnamedSurface().unresolved.map((entry) => [entry.id, entry.why]));
    for (const id of [
      "DeepIndex[string]", // an index signature's value type
      "deepContainerFactory (returned) (type argument 1 of Promise<Deep0>)", // a container's argument
      "Deep7.next", // the enumeration's own depth bound, over a named chain
    ]) {
      const explanation = why.get(id);
      expect(explanation, `${id} is silently absent again`).toBeDefined();
      expect(explanation, `${id} must say the BOUND is why`).toContain(
        `MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)})`,
      );
      expect(explanation, `${id} must not claim the branch is empty`).toMatch(
        /could not be shown callable-free|cannot be shown callable-free/,
      );
    }
    // …and the refusals that DO know there is a callable still say so, so the
    // two answers are distinguishable rather than merged into one hedge.
    expect(why.get("CallableIndex[string]")).toContain("carries a callable");
    expect(why.get("Hop3.hop (returned)")).toContain("with callables still below it");
  });

  it("round 7: a class VALUE a public factory hands out is PUBLIC, member by member", () => {
    // Review round 7's M7-3, the only finding of rounds 5–7 that hid callables
    // from the hostile BATTERY rather than only from the list.
    // `visitReturnedConstructible` called `visitClass` without saying how the
    // class had reached the caller, so `visitClass` asked the entry points, got
    // "not exported", and produced:
    //
    //   abstractClassFactory          PUBLIC
    //   AbstractHandedOut.parse       PUBLIC   ← by accident, through the property walk
    //   AbstractHandedOut.concrete    PACKAGE
    //   AbstractHandedOut.execute     PACKAGE
    //   AbstractHandedOut.constructor PACKAGE
    //
    // PACKAGE entries never enter `PUBLIC_TOTAL_CALLS`, so those were public
    // callables going unfuzzed. Neither class in the fixture is exported by
    // name: every PUBLIC below is derived from the factory's return type alone.
    const byId = new Map(fixtureSurface().callables.map((entry) => [entry.id, entry]));
    const expected: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [
      // 1 — a CONCRETE constructor: `new C(x)` is the caller's to make.
      ["ConcreteHandedOut.constructor", "PUBLIC", "constructor", ["seed"]],
      // 2 — an ABSTRACT constructor: `new C(x)` will not compile, but a subclass
      //     the caller writes reaches this body through `super(...)`, with the
      //     caller's arguments. Named as what it is so a probe knows how to
      //     drive it.
      ["AbstractHandedOut.constructor", "PUBLIC", "abstract constructor", ["label"]],
      // 3 — CONCRETE prototype implementations: the body is ours.
      ["ConcreteHandedOut.run", "PUBLIC", "method", ["value"]],
      ["AbstractHandedOut.concrete", "PUBLIC", "method", ["value"]],
      // …and a static, which is reachable on the handed-out value itself.
      ["AbstractHandedOut.parse", "PUBLIC", "method", ["raw"]],
      // 4 — ABSTRACT declarations: the body is the CALLER's subclass's, so this
      //     package owes no hostile-argument obligation for them. Enumerated by
      //     name anyway — absence from both lists is the outcome the mechanism
      //     may not have — and PACKAGE, which is what keeps them out of the
      //     battery without hiding them.
      ["AbstractHandedOut.execute", "PACKAGE", "abstract declaration", ["value"]],
      ["AbstractHandedOut.handler (getter)", "PACKAGE", "abstract declaration", []],
      ["AbstractHandedOut.compute", "PACKAGE", "abstract declaration", ["value"]],
    ];
    for (const [id, visibility, shape, params] of expected) {
      const entry = byId.get(id);
      expect(entry, `${id} is missing from the derivation`).toBeDefined();
      expect(entry?.visibility, `${id} visibility`).toBe(visibility);
      expect(entry?.shape, `${id} shape`).toBe(shape);
      expect(entry?.params, `${id} parameters`).toEqual(params);
    }
    // And the ORDER must not decide the answer. `TwiceReachedClass` is exported
    // from its own module, so the walk derives PACKAGE for it before the public
    // factory is ever reached; the visited-class guard has to admit the second,
    // public reading instead of returning early on the symbol it has seen.
    expect(byId.get("TwiceReachedClass.constructor")?.visibility, "PACKAGE first, PUBLIC second").toBe(
      "PUBLIC",
    );
    expect(byId.get("TwiceReachedClass.reached")?.visibility).toBe("PUBLIC");
    // An abstract property that is not callable is not a callable: there is
    // nothing there to enumerate, and nothing there to omit.
    expect([...byId.keys()]).not.toContain("AbstractHandedOut.tag");
    // …and a class NOT handed out keeps its package-internal constructor, so
    // this is a derived distinction rather than a blanket promotion.
    expect(byId.get("TypeOnlyExportedClass.constructor")?.visibility).toBe("PACKAGE");
    expect(fixtureSurface().unresolved).toEqual([]);
  });

  it("round 7: a key-remapped mapped property is enumerated under its REMAPPED name", () => {
    // Review round 7's M7-1. `Readonly<T>` keeps each property's original
    // declaration, which is why round 6's `MappedFacade.mapped` worked; a
    // remapping clause (`as`) synthesizes a fresh symbol with NO declaration
    // anywhere, and `visitProperties` gated on `isOurs`, which needs one. The
    // reviewer's fixture produced `remappedFactory` alone: neither
    // `renamed_handler` nor any refusal.
    //
    // Enumeration rather than refusal, because the name is real and a caller can
    // drive it: `remappedFactory().renamed_handler(value)`.
    const byId = new Map(fixtureSurface().callables.map((entry) => [entry.id, entry]));
    const remapped = byId.get("remappedFactory (returned).renamed_handler");
    expect(remapped, "the remapped callable is silently absent again").toBeDefined();
    expect(remapped?.visibility).toBe("PUBLIC");
    expect(remapped?.params, "the parameters come from the ORIGINAL declaration").toEqual([
      "value",
    ]);
    expect(remapped?.shape).toBe("declared method");
    // The remapped DATA property is not a callable, and the source interface is
    // never returned directly, so neither contributes an entry.
    expect([...byId.keys()]).not.toContain("remappedFactory (returned).renamed_tag");
    expect([...byId.keys()]).not.toContain("RemapSource.handler");
    expect(fixtureSurface().unresolved).toEqual([]);
  });

  it("a callable shape it cannot classify is REFUSED, not ignored", () => {
    // Fail closed. `export const C: { new (v): … } = class { … }` is a
    // constructible public value that is not a class declaration; the walk
    // cannot say what `new C(x)` runs without guessing, so it stops.
    const derivation = deriveBoundarySurface({
      root: FIXTURES,
      configRoot: REPO_ROOT,
      packageDirs: ["unclassifiable/src"],
      entryPoints: ["unclassifiable/src/index.ts"],
    });
    expect(derivation.diagnostics).toEqual([]);
    expect(derivation.unresolved.map((entry) => entry.id)).toEqual(["ConstructibleValue"]);
    expect(derivation.unresolved[0]?.why).toContain("construct signatures");
    // …and it produced no silent "internal" entry for it.
    expect(derivation.callables).toEqual([]);
  });
});
