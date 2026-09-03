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
  'TypeOnlyExportedClass.constructor [PACKAGE] (seed) <constructor>',
  'TypeOnlyExportedClass.describe [PUBLIC] (value) <method>',
  'arrowConst [PUBLIC] (value) <callable const>',
  'clauseOnly [PUBLIC] (value) <function>',
  'directlyInTheEntryPoint [PUBLIC] (value, label) <function>',
  'makeFacade [PUBLIC] () <function>',
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
