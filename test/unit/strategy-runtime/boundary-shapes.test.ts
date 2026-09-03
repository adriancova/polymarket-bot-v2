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
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  deriveBoundarySurface,
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

/** One program for the whole file; it costs ~45 ms to build. */
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
    const derivation = deriveBoundarySurface({
      root: FIXTURES,
      configRoot: REPO_ROOT,
      packageDirs: ["unnamed/src"],
      entryPoints: ["unnamed/src/index.ts"],
    });
    expect(derivation.diagnostics, "the fixture must be a program that compiles").toEqual([]);
    expect(derivation.unresolved.map((entry) => entry.id).sort()).toEqual([
      // a callable-only string index signature (the reviewer's shape 7)
      "CallableIndex[string]",
      // a chain of returned facades past MAX_SURFACE_DEPTH: it used to truncate
      // in silence, which is how a whole subtree of callables could disappear
      "Hop3.hop (returned)",
      // `readonly ((value: unknown) => string)[]`
      "arrayFactory (returned)[number]",
      // a handed-out value someone can `new` that is not one of our classes
      "constructibleFactory (returned)",
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
      "deepFactory",
      "indexFactory",
      "promiseFactory",
    ]);
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
