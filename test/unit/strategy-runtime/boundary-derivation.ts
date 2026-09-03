/**
 * The boundary surface, RESOLVED from the module graph's semantics
 * (remediation round 5, 2026-09-03).
 *
 * Why this module replaces round 4's AST scan. Review round 4 found that a
 * hand-written table cannot enumerate every parameter, and round 4 answered
 * with a syntactic scan of the two entry-point files. Review round 5 then found
 * the same defect one level up: a scan that looks at NODE SHAPES in the entry
 * points cannot see the entry points' actual EXPORTS. Reproduced against
 * round 4's oracle before this module was written (transcripts in
 * `docs/handoffs/WP-170.md`, remediation round 5):
 *
 * ```
 * function f() {...}; export { f };  + a barrel re-export  → 0 derived entries, 7/7 tests passed
 * export const api = { method(v) {...} }                   → 0 derived entries, 7/7 tests passed
 * export class C { run = (v) => ... }                      → 0 derived entries, 7/7 tests passed
 * export class C { get x() {} set x(v) {} }                → 0 derived entries, 7/7 tests passed
 * export * from "./m.js"                                   → derived, but marked PACKAGE
 * export function directIndexTomorrow(v, label = "root")   → derived, but marked PACKAGE, so
 *                                                            registering it exactly as the oracle
 *                                                            classified it passed 7/7 and its
 *                                                            hostile `label` was never fuzzed
 * ```
 *
 * `Object.entries` was to property enumeration (review round 4's MEDIUM) what an
 * AST scan is to the module graph: a view that cannot see everything the thing
 * it stands for contains. The answer is the same both times — move to the layer
 * that RESOLVES rather than the layer that pattern-matches. This module builds a
 * `ts.Program` and asks its type checker for each module's EXPORTS, so
 * `export *`, aliases, export-clause-only declarations and barrel re-exports are
 * resolved rather than recognized.
 *
 * What it enumerates, and the reachability rules it uses:
 *
 * 1. every value exported from any module of the two packages — functions,
 *    callable constants, classes;
 * 2. every non-private member of an enumerated class — constructor, statics,
 *    methods, PROPERTY FUNCTIONS (`run = (v) => ...`), getters and setters;
 * 3. every callable property of an enumerated object value, recursively
 *    (`export const api = { method(v) {...} }`);
 * 4. every callable this package HANDS OUT: the members of a type that appears
 *    in the RETURN position of an already-enumerated callable and is declared
 *    inside these two packages. That is how `StrategyContext.book(outcome)` and
 *    the draw-only `SeededRandom` facade — closures built inside a function
 *    body, reachable from no exported name — get onto the list. Parameter types
 *    are deliberately NOT followed: `DecisionSink`, `CheckpointStore`,
 *    `MonotonicClock` and `Strategy` are implemented by the composition root and
 *    by strategy authors, so their totality is not this package's claim to make.
 *
 * And what it refuses to guess: any callable shape it cannot classify with
 * confidence becomes an `unresolved` entry, which is a test failure naming the
 * shape. Failing closed is the point — review round 5's finding is that a
 * mechanism which silently treats an unrecognized boundary as internal is worse
 * than one that stops.
 *
 * ---------------------------------------------------------------------------
 * REMEDIATION ROUND 6, 2026-09-03 — the binding property, stated once
 *
 * Review round 6 found that rule 4 above was true of the shapes it happened to
 * meet and SILENT about three others. `visitHandedOut` called `visitProperties`
 * and nothing else, so a compiler-clean fixture produced callables that appeared
 * in NEITHER `callables` NOR `unresolved`: a getter returning a function, both
 * branches of a generic conditional return, and the value type of a callable-only
 * index signature. Round 5's own fail-closed handling of a class expression and
 * of a non-class constructible proves the mechanism KNEW how to stop; it simply
 * did not do it uniformly.
 *
 * The property this module now holds, and the one every future change must
 * preserve:
 *
 *   **Every callable shape is either ENUMERATED BY NAME or recorded as
 *   `unresolved` BY NAME. Silence is never an outcome.**
 *
 * What that required, mechanically:
 *
 * - a handed-out type's own CALL SIGNATURES are recorded (`X (returned)`), so a
 *   function that returns a function — from a `return`, from a getter, or from
 *   another returned callable — is on the list;
 * - a conditional return type (`T extends … ? Left : Right`) is EXPANDED into
 *   both branches through `ConditionalRoot.node`, and a type parameter becomes
 *   its base constraint; a conditional that cannot be expanded is refused;
 * - an INDEX SIGNATURE whose value type carries callables is refused by name.
 *   That is deliberate rather than lazy: there is no concrete key, so there is
 *   no name the fuzz could drive, and inventing one would be a registry entry no
 *   probe can call. The reviewer's instruction, followed literally;
 * - a foreign generic container's TYPE ARGUMENTS (`readonly Fn[]`,
 *   `Promise<Facade>`, `ReadonlyMap<string, Facade>`) are refused by name for
 *   the same reason — an element has an index, not a name. Our OWN generics are
 *   not refused: their instantiated members are already reached as properties;
 * - a handed-out type with CONSTRUCT signatures is visited when it is one of our
 *   classes and refused otherwise, mirroring `visitValue`'s round-5 rule;
 * - `MAX_SURFACE_DEPTH` now REFUSES when callables remain below it. It used to
 *   return silently on the handed-out path, which truncated a ten-hop chain of
 *   returned facades with no trace at all;
 * - the walk no longer requires the handed-out type's own SYMBOL to be ours. It
 *   did, so `Readonly<OurInterface>` — a mapped type whose alias symbol is the
 *   standard library's — dropped every member. `Readonly<MarketView>` and its
 *   siblings are the SDK's actual return types, so this one was a live hazard
 *   rather than a hypothetical one; it carries no methods today, which is why
 *   nothing was lost.
 *
 * The cost of this shape is over-refusal, never under-enumeration: a container
 * of a NAMED facade is refused even though its members could have been named.
 * That is the same trade the visibility rule makes — over-classifying costs a
 * fuzz obligation, under-classifying costs a defect — and a refusal is a loud,
 * reviewable stop rather than a silence.
 * ---------------------------------------------------------------------------
 * REMEDIATION ROUND 7, 2026-09-03 — the three holes left in the mechanism
 *
 * Round 6 stated the binding property; round 7 found three places that did not
 * hold it. Two were silences of the round-6 kind. The third was worse, because
 * it hid PUBLIC callables from the hostile battery rather than merely from the
 * list:
 *
 * - **M7-3, a handed-out CLASS VALUE lost its visibility.**
 *   `visitReturnedConstructible` called `visitClass` without saying how the
 *   class got into the caller's hands, and `visitClass` asked only the entry
 *   points. So `abstractClassFactory(): typeof AbstractClass` — a PUBLIC
 *   factory — produced `AbstractClass.constructor`, `.concrete` and `.execute`
 *   as PACKAGE, and only the STATIC leaked to PUBLIC (through the property
 *   walk, by accident). PACKAGE entries never enter the battery, so real public
 *   surface went unfuzzed. `visitClass` now takes the handed-out visibility and
 *   distinguishes the four cases the finding named:
 *
 *   | on a class value the caller holds | answer |
 *   | --- | --- |
 *   | a concrete constructor  | PUBLIC `constructor` — `new C(x)` is the caller's |
 *   | an abstract constructor | PUBLIC `abstract constructor` — reached by `super(...)` from a subclass the caller writes, still with the caller's arguments |
 *   | a concrete prototype implementation | PUBLIC — the body is ours, the argument is theirs |
 *   | an abstract declaration | PACKAGE `abstract declaration` — the body is the CALLER's subclass's, so there is nothing of ours to fuzz; enumerated by name so it is never merely absent |
 *
 *   The visited-class guard is keyed by the derived visibilities, so a class
 *   first met as PACKAGE is re-walked when a public path hands it out.
 *
 * - **M7-2, `carriesCallables` turned depth exhaustion into "no callable".** A
 *   boolean that cannot express *I do not know* is exactly what produces
 *   silence: a callable ten property hops beneath a returned string-index value
 *   was in neither list. The predicate is tri-state now (`CallableVerdict`),
 *   and `indeterminate` REFUSES by name everywhere `callable` does.
 *
 * - **M7-1, a key-REMAPPED mapped property was skipped.** `{ [K in keyof T as
 *   `renamed_${K}`]: T[K] }` synthesizes a property symbol with NO declaration
 *   at all, and `visitProperties` gated on `isOurs`, which needs one. The
 *   compiler still knows the property's TYPE and that type's call signature is
 *   declared here, so the callable is enumerated under its actual accessible
 *   name (`renamed_handler`) rather than refused. A synthesized property whose
 *   own call signature is declared elsewhere is refused instead — the walk will
 *   not claim somebody else's implementation.
 * ---------------------------------------------------------------------------
 *
 * Visibility is derived, never assumed:
 * - PUBLIC — the symbol is exported AS A VALUE from one of the ENTRY POINTS, or
 *   it is a member of a class or interface whose TYPE the entry points export.
 *   An instance can escape through a factory even when the class value does not
 *   (`StrategyInstanceRuntime` is exactly that case), so a publicly exported
 *   type makes its INSTANCE members public; the constructor and the statics
 *   need the value export, because `new` and `C.f()` need the value.
 * - PACKAGE — reachable only through another module of the same package.
 * When two reachability paths disagree, PUBLIC wins: over-classifying costs a
 * fuzz obligation, under-classifying costs a defect.
 */

import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import ts from "typescript";

export type Visibility = "PUBLIC" | "PACKAGE";

/**
 * The declaration shapes this derivation knows how to enumerate. A callable
 * whose declaration is not one of these is `unresolved`, not ignored. The
 * `declared …` shapes have no body here: they are the contract a value this
 * package HANDS OUT satisfies (an interface member), and the implementation the
 * fuzz drives through them is this package's.
 */
export type CallableShape =
  | "function"
  | "callable const"
  | "constructor"
  | "method"
  | "property function"
  | "getter"
  | "setter"
  | "declared method"
  | "declared property function"
  /**
   * Round 6: a callable a handed-out TYPE is itself. `makeHandler()` returning
   * `(value) => string`, a getter whose value is a function, a callable
   * interface (the shape a callable `Proxy` is handed out under). Named by the
   * SITE — `makeHandler (returned)` — because that is the expression a probe
   * actually evaluates to reach it.
   */
  | "returned callable"
  /**
   * Round 7: the constructor of an ABSTRACT class. `new C(x)` on the handed-out
   * value is a type error, so this constructor is reached through `super(...)`
   * in a subclass the CALLER writes — with the caller's arguments, running this
   * package's constructor body. It is a caller-data boundary like any other,
   * and it is given its own shape so the reader wiring a probe knows the call
   * has to go through a subclass.
   */
  | "abstract constructor"
  /**
   * Round 7: an ABSTRACT member declaration on a class this package hands out.
   * There is no body here — the CALLER's subclass supplies it — so this is the
   * same ruling review round 6 confirmed for `DecisionSink` and the other ports
   * this package only ever takes: a contract somebody else implements is not
   * this package's callable, and it carries no hostile-argument obligation. It
   * is enumerated anyway, by name and as PACKAGE, because being absent from
   * both lists is the one outcome this module may not have.
   */
  | "abstract declaration";

/**
 * Round 7: the answer to "does this type carry a callable of ours?" has three
 * values, not two. A BOOLEAN cannot say *I ran out of depth before I could
 * tell*, so `carriesCallables` used to turn depth exhaustion into "no
 * callables" and the walk then stayed silent about that branch — review round
 * 7's M7-2, reproduced with a callable ten property hops beneath a returned
 * string-index value, which produced no entry and no refusal at all.
 */
export type CallableVerdict = "none" | "callable" | "indeterminate";

/** Which of the four reachability rules put this callable on the list. */
export type Reachability = "module export" | "class member" | "object property" | "handed out";

export interface DerivedCallable {
  readonly id: string;
  readonly file: string;
  readonly visibility: Visibility;
  readonly params: readonly string[];
  readonly shape: CallableShape;
  readonly via: Reachability;
}

export interface UnresolvedCallable {
  readonly id: string;
  readonly file: string;
  readonly why: string;
}

export interface Derivation {
  readonly callables: readonly DerivedCallable[];
  readonly unresolved: readonly UnresolvedCallable[];
  /** The files the program actually parsed from the given package directories. */
  readonly parsedFiles: readonly string[];
  /**
   * Type errors in those files. A resolution is only as trustworthy as the
   * program it came from: a package that does not compile resolves to nonsense,
   * so this is asserted empty rather than assumed.
   */
  readonly diagnostics: readonly string[];
  /**
   * `@polymarket-bot/*` imports that resolved to a file OUTSIDE `root` — a
   * second copy of a workspace package in the same program. The walk would then
   * treat that copy's declarations as somebody else's and silently drop every
   * callable declared in it, which is the exact failure mode round 5 is about.
   * Asserted empty; stated rather than assumed.
   */
  readonly foreignWorkspaceResolutions: readonly string[];
}

export interface DerivationRequest {
  readonly root: string;
  /** Directories, relative to `root`, whose `.ts` files form the surface. */
  readonly packageDirs: readonly string[];
  /** The modules whose exported VALUES are PUBLIC, relative to `root`. */
  readonly entryPoints: readonly string[];
  /**
   * Where `tsconfig.base.json` lives, when that is not `root`. The shape
   * fixtures are compiled with the repository's own compiler options rather
   * than with defaults invented here, so what the fixture proves about the
   * mechanism is what the mechanism does to the real packages.
   */
  readonly configRoot?: string;
}

/**
 * How deep the walk follows object properties and handed-out types before it
 * refuses to guess. Exceeding it is an `unresolved` entry, not a silent stop —
 * the same fail-closed rule the runtime's own materializer applies with
 * `MAX_MATERIALIZED_DEPTH`.
 */
export const MAX_SURFACE_DEPTH = 8;

/**
 * Type flags that cannot carry a callable declared in these packages: the
 * primitives, the top and bottom types, and `object`. Skipping them is not a
 * silent omission — there is nothing there to omit — and it keeps the walk from
 * enumerating `String.prototype` once per `now(): string`.
 */
const NON_CARRYING_TYPE_FLAGS =
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.Never |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.NonPrimitive;

function sourceFilesUnder(root: string, relativeDir: string): string[] {
  const absolute = join(root, relativeDir);
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(absolute, entry))
    .sort();
}

function compilerOptions(root: string): ts.CompilerOptions {
  const read = ts.readConfigFile(join(root, "tsconfig.base.json"), ts.sys.readFile);
  const base =
    read.config === undefined
      ? {}
      : ts.parseJsonConfigFileContent(read.config as object, ts.sys, root).options;
  return { ...base, noEmit: true, skipLibCheck: true, types: [] };
}

/** POSIX-style repo-relative path, so ids read the same on any platform. */
function repoRelative(root: string, fileName: string): string {
  return relative(root, fileName).split(sep).join("/");
}

function hasModifier(declaration: ts.Declaration, flag: ts.ModifierFlags): boolean {
  return (ts.getCombinedModifierFlags(declaration) & flag) !== 0;
}

/** `export { type X }` / `export type { X }` — the value is NOT exported. */
function isTypeOnlyExport(symbol: ts.Symbol): boolean {
  return (symbol.getDeclarations() ?? []).some((declaration) => {
    if (ts.isExportSpecifier(declaration)) {
      return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
    }
    if (ts.isImportSpecifier(declaration)) {
      // `import type { X }` (the clause) or `import { type X }` (the specifier).
      return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
    }
    return false;
  });
}

function shapeOf(declaration: ts.SignatureDeclaration): CallableShape | undefined {
  if (ts.isFunctionDeclaration(declaration)) {
    return "function";
  }
  if (ts.isMethodDeclaration(declaration)) {
    return "method";
  }
  if (ts.isMethodSignature(declaration)) {
    return "declared method";
  }
  if (ts.isConstructorDeclaration(declaration)) {
    return "constructor";
  }
  if (ts.isGetAccessorDeclaration(declaration)) {
    return "getter";
  }
  if (ts.isSetAccessorDeclaration(declaration)) {
    return "setter";
  }
  if (ts.isFunctionTypeNode(declaration)) {
    return "declared property function";
  }
  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    const parent: ts.Node = declaration.parent;
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return "property function";
    }
    if (ts.isVariableDeclaration(parent)) {
      return "callable const";
    }
    return undefined;
  }
  return undefined;
}

/** The type a member belongs to, when it has a name worth using as an id. */
interface CanonicalOwner {
  readonly name: string;
  readonly symbol: ts.Symbol | undefined;
  readonly via: Reachability;
}

class SurfaceWalk {
  private readonly checker: ts.TypeChecker;
  private readonly ourFiles: ReadonlySet<string>;
  private readonly publicValues = new Set<ts.Symbol>();
  private readonly publicTypes = new Set<ts.Symbol>();
  /**
   * Keyed by the declaring symbol where there is one, and by the derived id
   * where there is not (round 6: a returned callable's signature may belong to
   * an anonymous type). A symbol can carry several callables — every overload,
   * and each half of an accessor pair — which is why the value is a list.
   */
  private readonly entries = new Map<ts.Symbol | string, DerivedCallable[]>();
  private readonly unresolved: UnresolvedCallable[] = [];
  private readonly walkedTypes = new Map<ts.Type, Set<Visibility>>();
  /**
   * Round 6: `visitClass` is reachable from a handed-out `typeof C`, so it is
   * guarded. Round 7: keyed by the DERIVED VISIBILITIES rather than by the
   * symbol alone. A class first met as a package-internal declaration and then
   * handed out by a public factory has to be walked again, or the second,
   * public reading never happens and the first, wrong one stands.
   */
  private readonly visitedClasses = new Map<ts.Symbol, Set<string>>();

  constructor(
    private readonly program: ts.Program,
    private readonly root: string,
    files: readonly string[],
  ) {
    this.checker = program.getTypeChecker();
    this.ourFiles = new Set(files.map((file) => resolve(file)));
  }

  run(entryPoints: readonly string[]): Derivation {
    this.collectPublicSurface(entryPoints);
    const seen = new Set<ts.Symbol>();
    for (const file of [...this.ourFiles].sort()) {
      const source = this.program.getSourceFile(file);
      if (source === undefined) {
        this.refuse(
          repoRelative(this.root, file),
          repoRelative(this.root, file),
          "the program did not parse this file, so its exports are unknown",
        );
        continue;
      }
      const moduleSymbol = this.checker.getSymbolAtLocation(source);
      if (moduleSymbol === undefined) {
        continue; // not a module: it can export nothing
      }
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        const target = this.resolveAlias(exported);
        if (!this.isOurs(target) || seen.has(target)) {
          continue; // a re-export of another package's symbol, or already walked
        }
        seen.add(target);
        this.visitExport(target);
      }
    }
    return {
      callables: [...this.entries.values()].flat().sort(byId),
      unresolved: [...this.unresolved].sort(byId),
      parsedFiles: [...this.ourFiles].map((file) => repoRelative(this.root, file)).sort(),
      diagnostics: this.diagnostics(),
      foreignWorkspaceResolutions: this.foreignWorkspaceResolutions(),
    };
  }

  /**
   * Where each `@polymarket-bot/*` specifier actually landed. The check is
   * semantic (the checker's module symbol), not a path heuristic, because the
   * whole point of round 5 is that resolution beats pattern-matching.
   */
  private foreignWorkspaceResolutions(): string[] {
    const foreign: string[] = [];
    for (const file of this.ourFiles) {
      const source = this.program.getSourceFile(file);
      if (source === undefined) {
        continue;
      }
      source.forEachChild((node) => {
        if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) {
          return;
        }
        const specifier = node.moduleSpecifier;
        if (specifier === undefined || !ts.isStringLiteral(specifier)) {
          return;
        }
        if (!specifier.text.startsWith("@polymarket-bot/")) {
          return;
        }
        const moduleSymbol = this.checker.getSymbolAtLocation(specifier);
        const resolved = (moduleSymbol?.getDeclarations() ?? [])[0]?.getSourceFile().fileName;
        if (resolved === undefined) {
          foreign.push(`${repoRelative(this.root, file)}: ${specifier.text} did not resolve`);
          return;
        }
        const absolute = resolve(resolved);
        if (!absolute.startsWith(resolve(this.root) + sep)) {
          foreign.push(
            `${repoRelative(this.root, file)}: ${specifier.text} resolved OUTSIDE the tree, to ` +
              `${absolute} — the program holds a second copy of a workspace package`,
          );
        }
      });
    }
    return foreign.sort();
  }

  private diagnostics(): string[] {
    return ts
      .getPreEmitDiagnostics(this.program)
      .filter(
        (diagnostic) =>
          diagnostic.file !== undefined && this.ourFiles.has(resolve(diagnostic.file.fileName)),
      )
      .map(
        (diagnostic) =>
          `${repoRelative(this.root, diagnostic.file?.fileName ?? "")}: ` +
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      );
  }

  // --- the public surface, resolved -----------------------------------------

  private collectPublicSurface(entryPoints: readonly string[]): void {
    for (const entry of entryPoints) {
      const source = this.program.getSourceFile(resolve(join(this.root, entry)));
      const moduleSymbol =
        source === undefined ? undefined : this.checker.getSymbolAtLocation(source);
      if (moduleSymbol === undefined) {
        this.refuse(
          entry,
          entry,
          "entry point is not a module in this program, so the PUBLIC surface cannot be resolved",
        );
        continue;
      }
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        const target = this.resolveAlias(exported);
        this.publicTypes.add(target);
        if (!isTypeOnlyExport(exported) && (target.flags & ts.SymbolFlags.Value) !== 0) {
          this.publicValues.add(target);
        }
      }
    }
  }

  private resolveAlias(symbol: ts.Symbol): ts.Symbol {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
      seen.add(current);
      const next = this.checker.getAliasedSymbol(current);
      if (next === current) {
        break;
      }
      current = next;
    }
    return current;
  }

  private isOurs(symbol: ts.Symbol): boolean {
    return (symbol.getDeclarations() ?? []).some((declaration) =>
      this.ourFiles.has(resolve(declaration.getSourceFile().fileName)),
    );
  }

  private fileOf(symbol: ts.Symbol): string {
    const declaration = (symbol.getDeclarations() ?? [])[0];
    return declaration === undefined
      ? "<no declaration>"
      : repoRelative(this.root, declaration.getSourceFile().fileName);
  }

  private isPublicType(symbol: ts.Symbol | undefined): boolean {
    return symbol !== undefined && (this.publicTypes.has(symbol) || this.publicValues.has(symbol));
  }

  // --- recording -------------------------------------------------------------

  private record(symbol: ts.Symbol | string, entry: DerivedCallable): void {
    const existing = this.entries.get(symbol) ?? [];
    this.entries.set(symbol, existing);
    const index = existing.findIndex((previous) => previous.id === entry.id);
    if (index < 0) {
      // A symbol can carry SEVERAL callables: every overload is its own
      // signature, and an accessor pair is a getter and a setter. Round 4's
      // scan collapsed both, so a second overload — and a setter — vanished.
      existing.push(entry);
      return;
    }
    // The same callable reached a second way. PUBLIC wins: over-classifying
    // costs a fuzz obligation, under-classifying costs a defect.
    const previous = existing[index] as DerivedCallable;
    if (entry.visibility === "PUBLIC" && previous.visibility !== "PUBLIC") {
      existing[index] = { ...previous, visibility: "PUBLIC" };
    }
  }

  private refuse(id: string, file: string, why: string): void {
    if (!this.unresolved.some((entry) => entry.id === id && entry.why === why)) {
      this.unresolved.push({ id, file, why });
    }
  }

  // --- the walk --------------------------------------------------------------

  private visitExport(symbol: ts.Symbol): void {
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.length === 0) {
      this.refuse(symbol.getName(), "<no declaration>", "exported symbol has no declaration");
      return;
    }
    if ((symbol.flags & ts.SymbolFlags.Class) !== 0) {
      this.visitClass(symbol.getName(), symbol);
      return;
    }
    if ((symbol.flags & ts.SymbolFlags.Value) === 0) {
      // A pure type export. Interfaces and type aliases are entered only where
      // this package HANDS OUT a value of that type (rule 4): a type nobody
      // here constructs is somebody else's implementation.
      return;
    }
    const visibility: Visibility = this.publicValues.has(symbol) ? "PUBLIC" : "PACKAGE";
    const declaration = declarations[0] as ts.Declaration;
    this.visitValue(
      symbol.getName(),
      symbol,
      this.checker.getTypeOfSymbolAtLocation(symbol, declaration),
      visibility,
      "module export",
      0,
    );
  }

  /** A value: possibly callable, possibly an object carrying callables, possibly both. */
  private visitValue(
    id: string,
    symbol: ts.Symbol,
    type: ts.Type,
    visibility: Visibility,
    via: Reachability,
    depth: number,
  ): void {
    const file = this.fileOf(symbol);
    for (const constituent of this.concreteConstituents(id, file, type)) {
      const calls = constituent.getCallSignatures();
      if (calls.length > 0) {
        this.recordSignatures(id, symbol, calls, visibility, via, depth);
      }
      if (
        constituent.getConstructSignatures().length > 0 &&
        (symbol.flags & ts.SymbolFlags.Class) === 0
      ) {
        this.refuse(
          id,
          file,
          "a non-class value with construct signatures: enumerate it in boundary-derivation.ts " +
            "rather than letting this walk guess how it is constructed",
        );
      }
      this.visitCarrier(id, file, constituent, visibility, depth);
    }
  }

  private recordSignatures(
    id: string,
    symbol: ts.Symbol,
    signatures: readonly ts.Signature[],
    visibility: Visibility,
    via: Reachability,
    depth: number,
  ): void {
    signatures.forEach((signature, index) => {
      const label =
        signatures.length === 1
          ? id
          : `${id} (overload ${String(index + 1)} of ${String(signatures.length)})`;
      const declaration = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
      const shape = declaration === undefined ? undefined : shapeOf(declaration);
      if (declaration === undefined || shape === undefined) {
        this.refuse(
          label,
          this.fileOf(symbol),
          declaration === undefined
            ? "a call signature with no declaration: its parameters cannot be enumerated"
            : `unrecognized callable declaration ${ts.SyntaxKind[declaration.kind]}: teach ` +
              "boundary-derivation.ts this shape or classify it explicitly",
        );
        return;
      }
      const file = repoRelative(this.root, declaration.getSourceFile().fileName);
      this.record(symbol, {
        id: label,
        file,
        visibility,
        params: parametersOf(declaration),
        shape,
        via,
      });
      this.visitHandedOut(
        label,
        file,
        this.checker.getReturnTypeOfSignature(signature),
        visibility,
        depth + 1,
      );
    });
  }

  /** Non-private members of an object type that are declared in these packages. */
  private visitProperties(
    owner: string,
    file: string,
    type: ts.Type,
    visibility: Visibility,
    depth: number,
  ): void {
    const walked = this.walkedTypes.get(type);
    if (walked?.has(visibility) === true) {
      return;
    }
    this.walkedTypes.set(type, (walked ?? new Set<Visibility>()).add(visibility));
    for (const property of this.checker.getPropertiesOfType(type)) {
      const name = property.getName();
      if (name.startsWith("#")) {
        continue; // a private field is not reachable from outside its class
      }
      const declarations = property.getDeclarations() ?? [];
      if (declarations.length === 0) {
        // Round 7, M7-1: a property the compiler SYNTHESIZED. The `isOurs` gate
        // below needs a declaration, and a key-remapped mapped property has
        // none, so it used to be skipped in silence.
        this.visitSynthesizedProperty(`${owner}.${name}`, file, property, visibility, depth);
        continue;
      }
      if (!this.isOurs(property)) {
        continue; // a foreign declaration: somebody else's implementation
      }
      this.visitMember(`${owner}.${name}`, property, visibility, "object property", depth);
    }
  }

  /**
   * @param handedOut how the class VALUE reached the caller, when a walk
   * already established that it did. Round 7's M7-3: this used to be dropped,
   * so a class returned by a public factory was classified as though the entry
   * points were the only way to reach it.
   */
  private visitClass(className: string, symbol: ts.Symbol, handedOut?: Visibility): void {
    const declaration = (symbol.getDeclarations() ?? []).find(ts.isClassDeclaration);
    if (declaration === undefined) {
      this.refuse(className, this.fileOf(symbol), "class symbol without a class declaration");
      return;
    }
    // The class VALUE (its constructor and statics) is reachable where the value
    // itself is exported OR where a public callable HANDS IT OUT — `new C(x)`
    // and `C.f(x)` both need the value, and a factory returning `typeof C` gives
    // the caller exactly that. INSTANCE members are reachable wherever an
    // instance can escape, which a publicly exported TYPE already implies and
    // which holding the class value implies too.
    const valueInCallersHands = this.publicValues.has(symbol) || handedOut === "PUBLIC";
    const staticVisibility: Visibility = valueInCallersHands ? "PUBLIC" : "PACKAGE";
    const instanceVisibility: Visibility =
      valueInCallersHands || this.publicTypes.has(symbol) ? "PUBLIC" : "PACKAGE";
    const reading = `${staticVisibility}/${instanceVisibility}`;
    const visited = this.visitedClasses.get(symbol) ?? new Set<string>();
    if (visited.has(reading)) {
      return; // round 6: also reachable from a handed-out `typeof C`
    }
    this.visitedClasses.set(symbol, visited.add(reading));
    // An ABSTRACT class cannot be `new`ed, on the handed-out value or anywhere
    // else; its constructor runs from a subclass's `super(...)`, with whatever
    // arguments that subclass passes. Still a caller-data boundary, but not one
    // a probe can drive with `new`, so it is named as what it is.
    const abstractClass = hasModifier(declaration, ts.ModifierFlags.Abstract);

    const staticType = this.checker.getTypeOfSymbolAtLocation(symbol, declaration);
    for (const signature of staticType.getConstructSignatures()) {
      const constructor = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
      if (constructor === undefined || !ts.isConstructorDeclaration(constructor)) {
        continue; // an implicit constructor declares no parameter to classify
      }
      if (hasModifier(constructor, ts.ModifierFlags.Private)) {
        continue;
      }
      this.record(this.checker.getSymbolAtLocation(constructor) ?? symbol, {
        id: `${className}.constructor`,
        file: repoRelative(this.root, constructor.getSourceFile().fileName),
        visibility: staticVisibility,
        params: parametersOf(constructor),
        shape: abstractClass ? "abstract constructor" : "constructor",
        via: "class member",
      });
    }
    for (const member of this.checker.getPropertiesOfType(staticType)) {
      if (member.getName() === "prototype" || !this.isOurs(member)) {
        continue;
      }
      this.visitMember(
        `${className}.${member.getName()}`,
        member,
        staticVisibility,
        "class member",
        0,
        staticVisibility,
      );
    }
    for (const member of this.checker.getPropertiesOfType(
      this.checker.getDeclaredTypeOfSymbol(symbol),
    )) {
      if (!this.isOurs(member) || member.getName().startsWith("#")) {
        continue;
      }
      this.visitMember(
        `${className}.${member.getName()}`,
        member,
        instanceVisibility,
        "class member",
        0,
      );
    }
  }

  /** One member of a class, of an object value, or of a type this package hands out. */
  private visitMember(
    pathId: string,
    member: ts.Symbol,
    fallbackVisibility: Visibility,
    fallbackVia: Reachability,
    depth: number,
    forcedVisibility?: Visibility,
  ): void {
    const declarations = member.getDeclarations() ?? [];
    if (declarations.length === 0) {
      this.refuse(pathId, "<no declaration>", "member symbol without a declaration");
      return;
    }
    if (declarations.some((declaration) => hasModifier(declaration, ts.ModifierFlags.Private))) {
      return; // not reachable from outside the class
    }
    const owner = this.canonicalOwner(member);
    const id = owner === undefined ? pathId : `${owner.name}.${member.getName()}`;
    const via = owner?.via ?? fallbackVia;
    // PUBLIC from EITHER direction: the declaring type is publicly exported, or
    // the path that reached this member was already public (a value a public
    // callable returns is in the caller's hands whatever its type is named).
    let visibility: Visibility =
      forcedVisibility ??
      (this.isPublicType(owner?.symbol) || fallbackVisibility === "PUBLIC" ? "PUBLIC" : "PACKAGE");
    if (declarations.some((declaration) => hasModifier(declaration, ts.ModifierFlags.Protected))) {
      visibility = "PACKAGE"; // reachable to subclasses only, which live here
    }

    // Round 7, M7-3: an ABSTRACT member has no body in these packages. Calling
    // it runs the CALLER's subclass, which is the same ruling review round 6
    // confirmed for `DecisionSink` and the other ports this package only takes:
    // not our implementation, so not our hostile-argument obligation. It is
    // enumerated by name and as PACKAGE rather than dropped, because absence
    // from both lists is the outcome this module may not have — and it is
    // enumerated HERE, before the accessor and value branches, so no later path
    // can quietly re-record it as a concrete implementation of ours.
    if (declarations.every((declaration) => hasModifier(declaration, ts.ModifierFlags.Abstract))) {
      this.recordAbstractDeclarations(id, member, declarations, via);
      return;
    }

    const accessors = declarations.filter(
      (declaration): declaration is ts.AccessorDeclaration =>
        ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration),
    );
    if (accessors.length > 0) {
      for (const accessor of accessors) {
        const isGetter = ts.isGetAccessorDeclaration(accessor);
        this.record(member, {
          id: `${id} (${isGetter ? "getter" : "setter"})`,
          file: repoRelative(this.root, accessor.getSourceFile().fileName),
          visibility,
          params: parametersOf(accessor),
          shape: isGetter ? "getter" : "setter",
          via,
        });
      }
      // Round 6: the accessor's VALUE may itself be a callable. `get handler():
      // (value) => string` used to record the getter and lose the handler.
      this.visitHandedOut(
        id,
        this.fileOf(member),
        this.checker.getTypeOfSymbolAtLocation(member, accessors[0] as ts.Declaration),
        visibility,
        depth + 1,
      );
      return;
    }

    const type = this.checker.getTypeOfSymbolAtLocation(member, declarations[0] as ts.Declaration);
    if (depth + 1 > MAX_SURFACE_DEPTH) {
      const verdict = this.carriesCallables(type);
      if (verdict !== "none") {
        this.refuse(
          id,
          this.fileOf(member),
          verdict === "callable"
            ? `the surface walk reached MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}) with ` +
                "callables still below it; flatten the value or classify this branch explicitly"
            : // Round 7, M7-2: the predicate hit its own bound, so "no callables"
              // is unknown rather than established.
              `the surface walk reached MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}) and ` +
                "the predicate that looks below it ran out of depth too, so this branch cannot " +
                "be shown callable-free; flatten the value or classify this branch explicitly",
        );
      }
      return;
    }
    this.visitValue(id, member, type, visibility, via, depth + 1);
  }

  /**
   * An ABSTRACT member, enumerated by name and classified PACKAGE. Round 7's
   * M7-3 asked for the distinction between a concrete prototype implementation
   * — whose body is here, and which therefore takes caller data into OUR code —
   * and an abstract declaration, whose body is the caller's. This is the second
   * half of it, and it is a classification rather than an omission so that a
   * reader can see the mechanism made the distinction on purpose.
   */
  private recordAbstractDeclarations(
    id: string,
    member: ts.Symbol,
    declarations: readonly ts.Declaration[],
    via: Reachability,
  ): void {
    for (const declaration of declarations) {
      const file = repoRelative(this.root, declaration.getSourceFile().fileName);
      if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) {
        this.record(member, {
          id: `${id} (${ts.isGetAccessorDeclaration(declaration) ? "getter" : "setter"})`,
          file,
          visibility: "PACKAGE",
          params: parametersOf(declaration),
          shape: "abstract declaration",
          via,
        });
        continue;
      }
      if (ts.isMethodDeclaration(declaration)) {
        this.record(member, {
          id,
          file,
          visibility: "PACKAGE",
          params: parametersOf(declaration),
          shape: "abstract declaration",
          via,
        });
        continue;
      }
      // `abstract handler: (value) => string` — a PROPERTY whose type is
      // callable. A plain `abstract readonly tag: string` is not a callable at
      // all, so there is nothing there to enumerate and nothing to omit.
      const signatures = this.checker
        .getTypeOfSymbolAtLocation(member, declaration)
        .getCallSignatures();
      signatures.forEach((signature, index) => {
        const label =
          signatures.length === 1
            ? id
            : `${id} (overload ${String(index + 1)} of ${String(signatures.length)})`;
        const signatureDeclaration = signature.getDeclaration() as
          | ts.SignatureDeclaration
          | undefined;
        if (signatureDeclaration === undefined) {
          this.refuse(
            label,
            file,
            "an abstract member whose call signature has no declaration: its parameters cannot " +
              "be enumerated, so the shape is refused rather than guessed at",
          );
          return;
        }
        this.record(member, {
          id: label,
          file,
          visibility: "PACKAGE",
          params: parametersOf(signatureDeclaration),
          shape: "abstract declaration",
          via,
        });
      });
    }
  }

  /**
   * A property the COMPILER synthesized: it has a NAME and a TYPE but no
   * declaration anywhere. Round 7's M7-1 — `{ [K in keyof T as
   * `renamed_${K}`]: T[K] }` produces exactly this, and the `isOurs` gate in
   * `visitProperties` needs a declaration, so the callable beneath
   * `renamed_handler` was in neither list.
   *
   * The name is real and a caller can drive it, so the walk enumerates rather
   * than refuses — but only when the callable underneath is DECLARED here. A
   * synthesized property whose own call signature comes from another package is
   * somebody else's implementation, which is the frontier round 6 fixed for
   * returned signatures; here it is loud instead of silent, because a mapped
   * type over a foreign source is a shape a reader should look at.
   */
  private visitSynthesizedProperty(
    id: string,
    file: string,
    property: ts.Symbol,
    visibility: Visibility,
    depth: number,
  ): void {
    if (property.getName() === "prototype") {
      // A class's own instance side. `visitClass` enumerates it WITH the
      // abstract/concrete distinction, which this path cannot make; walking it
      // again through `C.prototype` would add nothing and bypass that.
      return;
    }
    const type = this.checker.getTypeOfSymbol(property);
    const verdict = this.carriesCallables(type);
    if (verdict === "none") {
      return; // a data property: an answer, not a silence
    }
    if (verdict === "indeterminate") {
      this.refuse(
        id,
        file,
        "a synthesized property (a mapped type's remapped key, or a union member) whose value " +
          `type could not be shown callable-free within MAX_SURFACE_DEPTH (${String(
            MAX_SURFACE_DEPTH,
          )}): it is refused rather than assumed empty. Flatten the type or classify this ` +
          "branch explicitly",
      );
      return;
    }
    if (depth + 1 > MAX_SURFACE_DEPTH) {
      this.refuse(
        id,
        file,
        `the surface walk reached MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}) at a ` +
          "synthesized property with callables still below it; flatten the value or classify " +
          "this branch explicitly",
      );
      return;
    }
    const calls = type.getCallSignatures();
    if (calls.length > 0 && !calls.every((signature) => this.isOurSignature(signature))) {
      this.refuse(
        id,
        file,
        "a synthesized property whose own call signature is declared OUTSIDE these packages: " +
          "the walk will not claim somebody else's implementation, and it will not pass over " +
          "the callables it does own underneath. Give the value type a named declaration this " +
          "walk can enumerate, or classify this branch explicitly",
      );
      return;
    }
    this.visitValue(id, property, type, visibility, "object property", depth + 1);
  }

  /**
   * Rule 4: a type this package RETURNS is a value this package constructs and
   * hands to someone else, so its callable members are this package's callables.
   *
   * Round 6 made this TOTAL over the type. Before, it called `visitProperties`
   * and nothing else, so a returned callable, an unresolved conditional branch
   * and a callable index signature were all silently absent. Now every branch
   * ends in an entry or a refusal.
   */
  private visitHandedOut(
    ownerId: string,
    file: string,
    type: ts.Type,
    handedOutBy: Visibility,
    depth: number,
  ): void {
    for (const constituent of this.concreteConstituents(ownerId, file, type)) {
      if ((constituent.flags & NON_CARRYING_TYPE_FLAGS) !== 0) {
        continue; // a primitive, `void`, `never`: nothing to omit
      }
      if (depth > MAX_SURFACE_DEPTH) {
        const verdict = this.carriesCallables(constituent);
        if (verdict !== "none") {
          this.refuse(
            `${ownerId} (returned)`,
            file,
            verdict === "callable"
              ? `the handed-out walk reached MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}) ` +
                  "with callables still below it; flatten the chain of returned facades or " +
                  "classify this branch explicitly"
              : // Round 7, M7-2: unknown is not empty.
                `the handed-out walk reached MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}) ` +
                  "and the predicate that looks below it ran out of depth too, so this branch " +
                  "cannot be shown callable-free; flatten the chain of returned facades or " +
                  "classify this branch explicitly",
          );
        }
        continue;
      }
      const symbol = constituent.getSymbol() ?? constituent.aliasSymbol;
      const named = symbol !== undefined && this.isOurs(symbol) ? symbol.getName() : undefined;
      const visibility: Visibility =
        this.isPublicType(symbol) || handedOutBy === "PUBLIC" ? "PUBLIC" : "PACKAGE";

      // 1. The type IS a callable — `makeHandler(): (value) => string`, a getter
      //    whose value is a function, a callable interface. Named by the site.
      this.recordReturnedSignatures(ownerId, file, constituent, visibility, depth);

      // 2. The type is CONSTRUCTIBLE. One of our classes is walked as a class,
      //    WITH the visibility this walk just derived (round 7's M7-3: dropping
      //    it left every member of a publicly returned class PACKAGE, and a
      //    PACKAGE entry never reaches the hostile battery); anything else is
      //    refused, exactly as `visitValue` refuses it.
      this.visitReturnedConstructible(ownerId, file, constituent, symbol, visibility);

      // 3. Its members, its index signatures and its container type arguments.
      this.visitCarrier(
        named === undefined || named === "__type" || named === "__object"
          ? `${ownerId} (returned)`
          : named,
        file,
        constituent,
        visibility,
        depth,
      );
    }
  }

  /** The call signatures a handed-out type carries, when they are declared here. */
  private recordReturnedSignatures(
    ownerId: string,
    file: string,
    type: ts.Type,
    visibility: Visibility,
    depth: number,
  ): void {
    const signatures = type.getCallSignatures();
    signatures.forEach((signature, index) => {
      const declaration = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
      const label =
        signatures.length === 1
          ? `${ownerId} (returned)`
          : `${ownerId} (returned, overload ${String(index + 1)} of ${String(signatures.length)})`;
      if (declaration === undefined) {
        this.refuse(
          label,
          file,
          "a returned call signature with no declaration: its parameters cannot be enumerated",
        );
        return;
      }
      if (!this.ourFiles.has(resolve(declaration.getSourceFile().fileName))) {
        // Somebody else's callable, handed straight through. Rule 4 is about
        // values this package CONSTRUCTS; a foreign declaration is outside it,
        // the same way a foreign property is.
        return;
      }
      this.record(label, {
        id: label,
        file: repoRelative(this.root, declaration.getSourceFile().fileName),
        visibility,
        params: parametersOf(declaration),
        shape: "returned callable",
        via: "handed out",
      });
      this.visitHandedOut(
        label,
        file,
        this.checker.getReturnTypeOfSignature(signature),
        visibility,
        depth + 1,
      );
    });
  }

  /** A handed-out value someone can `new`: our class, or a refusal. */
  private visitReturnedConstructible(
    ownerId: string,
    file: string,
    type: ts.Type,
    symbol: ts.Symbol | undefined,
    handedOut: Visibility,
  ): void {
    const constructs = type
      .getConstructSignatures()
      .filter((signature) => this.isOurSignature(signature));
    if (constructs.length === 0) {
      return;
    }
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0 && this.isOurs(symbol)) {
      this.visitClass(symbol.getName(), symbol, handedOut);
      return;
    }
    this.refuse(
      `${ownerId} (returned)`,
      file,
      "a handed-out value with construct signatures that is not one of our classes: enumerate it " +
        "in boundary-derivation.ts rather than letting this walk guess what `new` runs",
    );
  }

  /**
   * The parts of a type that carry callables but are not call signatures:
   * properties, index signatures, and a foreign container's type arguments.
   * Shared by the value walk and the handed-out walk so both fail closed the
   * same way.
   */
  private visitCarrier(
    ownerId: string,
    file: string,
    type: ts.Type,
    visibility: Visibility,
    depth: number,
  ): void {
    if ((type.flags & NON_CARRYING_TYPE_FLAGS) !== 0) {
      return;
    }
    this.visitProperties(ownerId, file, type, visibility, depth);
    let refusedByIndex = false;
    for (const info of this.checker.getIndexInfosOfType(type)) {
      const verdict = this.carriesCallables(info.type);
      if (verdict === "none") {
        continue;
      }
      refusedByIndex = true;
      this.refuse(
        `${ownerId}[${this.checker.typeToString(info.keyType)}]`,
        file,
        verdict === "callable"
          ? "an index signature whose value type carries a callable: an index has no NAME, so " +
              "there is no expression the hostile battery could drive. Give the value type a " +
              "named declaration this walk can enumerate, or classify this branch explicitly — " +
              "inventing a synthetic id here would be a registry entry no probe can call"
          : // Round 7, M7-2. The predicate ran out of depth before it could tell,
            // and "I do not know" is not "there is nothing there".
            "an index signature whose value type could not be shown callable-free within " +
              `MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}): a callable may sit below the ` +
              "bound, and an index has no name to drive it with either way, so this branch is " +
              "refused rather than assumed empty. Flatten the value type or classify it explicitly",
      );
    }
    if (refusedByIndex) {
      // An array is both: `readonly Fn[]` has a `[number]` index signature AND a
      // type argument. One named refusal per site is loud enough; two is noise.
      return;
    }
    this.foreignTypeArguments(type).forEach((argument, index) => {
      const verdict = this.carriesCallables(argument);
      if (verdict === "none") {
        return;
      }
      this.refuse(
        `${ownerId} (type argument ${String(index + 1)} of ${this.checker.typeToString(type)})`,
        file,
        verdict === "callable"
          ? "a container declared outside these packages whose type argument carries a callable " +
              "(an array element, a promised value, a map value): the element has an index or a " +
              "key, not a name, so no probe can drive it. Hand out a named facade instead, or " +
              "classify this branch explicitly"
          : // Round 7, M7-2, on the container path.
            "a container declared outside these packages whose type argument could not be shown " +
              `callable-free within MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}): a callable ` +
              "may sit below the bound, and an element has an index or a key rather than a name, " +
              "so this branch is refused rather than assumed empty. Hand out a named facade " +
              "instead, or classify this branch explicitly",
      );
    });
  }

  /**
   * Reduces a type to the constituents this walk can classify: unions and
   * intersections are flattened, a CONDITIONAL type is expanded into both of its
   * branches, and a type parameter becomes its base constraint. A conditional
   * that cannot be expanded is REFUSED rather than skipped, which is the whole
   * point of round 6.
   */
  private concreteConstituents(ownerId: string, file: string, type: ts.Type): ts.Type[] {
    const concrete: ts.Type[] = [];
    const pending: ts.Type[] = [type];
    const seen = new Set<ts.Type>();
    while (pending.length > 0) {
      const current = pending.pop() as ts.Type;
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (current.isUnion() || current.isIntersection()) {
        pending.push(...current.types);
        continue;
      }
      if ((current.flags & ts.TypeFlags.Conditional) !== 0) {
        const branches = conditionalBranches(this.checker, current as ts.ConditionalType);
        if (branches === undefined) {
          this.refuse(
            `${ownerId} (conditional)`,
            file,
            "a conditional type whose branches this walk cannot expand: every callable in each " +
              "branch would be invisible, so it stops instead. Return a named union of the " +
              "branch types, or classify this branch explicitly",
          );
          continue;
        }
        pending.push(...branches);
        continue;
      }
      if ((current.flags & ts.TypeFlags.Instantiable) !== 0) {
        // A type PARAMETER. Its constraint is the most this package can know;
        // an unconstrained `T` (`params<T>(): Readonly<T>`) is the CALLER's
        // type, and a callable in it is the caller's callable, not ours.
        const constraint = this.checker.getBaseConstraintOfType(current);
        if (constraint !== undefined) {
          pending.push(constraint);
        }
        continue;
      }
      concrete.push(current);
    }
    return concrete;
  }

  /** Type arguments of a generic declared OUTSIDE these packages. */
  private foreignTypeArguments(type: ts.Type): readonly ts.Type[] {
    if ((type.flags & ts.TypeFlags.Object) === 0) {
      return [];
    }
    if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) {
      return [];
    }
    const reference = type as ts.TypeReference;
    const target = reference.target.getSymbol();
    if (target !== undefined && this.isOurs(target)) {
      // One of OUR generics: `visitProperties` already walks its instantiated
      // members, so refusing on the type argument would be a false alarm.
      return [];
    }
    return this.checker.getTypeArguments(reference);
  }

  /**
   * Does this type carry a callable DECLARED IN THESE PACKAGES, anywhere a
   * bounded walk can reach? Used where the answer decides between "nothing to
   * see" and "refuse by name": the depth bound, index signatures, container
   * type arguments and (round 7) synthesized properties.
   *
   * ROUND 7, M7-2 — why this returns three values and not two. It used to
   * return `false` both for *there is no callable here* and for *I ran out of
   * depth before I could tell*, and the callers treated the second as the
   * first. A callable ten property hops beneath a returned string-index value
   * was therefore in NEITHER list — the exact silence the binding property
   * forbids, sitting behind a bound that was documented as always refusing.
   * `indeterminate` now propagates out of every branch that truncates, and each
   * caller refuses by name for it.
   *
   * `seen` remembers the DEPTH at which a type was explored rather than merely
   * that it was: a type first met near the bound (and truncated there) must be
   * explored again when a shallower path reaches it, or the truncation would be
   * inherited as a definite "none" by a branch that had the budget to look.
   */
  private carriesCallables(
    type: ts.Type,
    depth = 0,
    seen = new Map<ts.Type, number>(),
  ): CallableVerdict {
    if ((type.flags & NON_CARRYING_TYPE_FLAGS) !== 0) {
      return "none"; // a primitive, `void`, `never`: there is nothing to omit
    }
    if (depth > MAX_SURFACE_DEPTH) {
      return "indeterminate";
    }
    const exploredAt = seen.get(type);
    if (exploredAt !== undefined && exploredAt <= depth) {
      // Already explored with at least this much budget — including the
      // co-inductive case of a type currently on the stack, which is how a
      // recursive facade terminates.
      return "none";
    }
    seen.set(type, depth);

    let truncated = false;
    /** True as soon as a definite callable is found; records truncation on the way. */
    const carries = (candidate: ts.Type): boolean => {
      const verdict = this.carriesCallables(candidate, depth + 1, seen);
      if (verdict === "callable") {
        return true;
      }
      if (verdict === "indeterminate") {
        truncated = true;
      }
      return false;
    };
    const settle = (): CallableVerdict => (truncated ? "indeterminate" : "none");

    if (type.isUnion() || type.isIntersection()) {
      for (const constituent of type.types) {
        if (carries(constituent)) {
          return "callable";
        }
      }
      return settle();
    }
    if (
      [...type.getCallSignatures(), ...type.getConstructSignatures()].some((signature) =>
        this.isOurSignature(signature),
      )
    ) {
      return "callable";
    }
    for (const property of this.checker.getPropertiesOfType(type)) {
      const declarations = property.getDeclarations() ?? [];
      if (
        property.getName().startsWith("#") ||
        declarations.some((declaration) => hasModifier(declaration, ts.ModifierFlags.Private))
      ) {
        continue;
      }
      if (declarations.length === 0) {
        // Round 7, M7-1: a synthesized property, which the enumeration now
        // follows. The predicate follows it too, so the two agree about what is
        // down there.
        if (property.getName() === "prototype") {
          continue; // the class's instance side, which `visitClass` owns
        }
        if (carries(this.checker.getTypeOfSymbol(property))) {
          return "callable";
        }
        continue;
      }
      if (!this.isOurs(property)) {
        continue;
      }
      const declaration = declarations[0];
      if (declaration === undefined) {
        continue;
      }
      if (carries(this.checker.getTypeOfSymbolAtLocation(property, declaration))) {
        return "callable";
      }
    }
    for (const info of this.checker.getIndexInfosOfType(type)) {
      if (carries(info.type)) {
        return "callable";
      }
    }
    if ((type.flags & ts.TypeFlags.Object) !== 0) {
      const object = type as ts.ObjectType;
      if ((object.objectFlags & ts.ObjectFlags.Reference) !== 0) {
        for (const argument of this.checker.getTypeArguments(type as ts.TypeReference)) {
          if (carries(argument)) {
            return "callable";
          }
        }
      }
    }
    return settle();
  }

  private isOurSignature(signature: ts.Signature): boolean {
    const declaration = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
    return (
      declaration !== undefined &&
      this.ourFiles.has(resolve(declaration.getSourceFile().fileName))
    );
  }

  /** The named type a member belongs to, when there is one. */
  private canonicalOwner(member: ts.Symbol): CanonicalOwner | undefined {
    const declaration = (member.getDeclarations() ?? [])[0];
    if (declaration === undefined) {
      return undefined;
    }
    const parent: ts.Node = declaration.parent;
    if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name !== undefined) {
      return {
        name: parent.name.getText(parent.getSourceFile()),
        symbol: this.checker.getSymbolAtLocation(parent.name),
        via: "class member",
      };
    }
    if (ts.isInterfaceDeclaration(parent)) {
      return {
        name: parent.name.getText(parent.getSourceFile()),
        symbol: this.checker.getSymbolAtLocation(parent.name),
        via: "handed out",
      };
    }
    if (ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)) {
      return {
        name: parent.parent.name.getText(parent.getSourceFile()),
        symbol: this.checker.getSymbolAtLocation(parent.parent.name),
        via: "handed out",
      };
    }
    return undefined;
  }
}

/**
 * Both branches of a conditional return type. A generic `T extends X ? A : B`
 * is never resolved by the checker — the call has no argument yet — so the
 * branches are read from the conditional's own declaration node, which is
 * public API (`ConditionalRoot.node`). `undefined` means "could not expand",
 * which the caller turns into a named refusal rather than a silent skip.
 */
function conditionalBranches(
  checker: ts.TypeChecker,
  type: ts.ConditionalType,
): readonly ts.Type[] | undefined {
  if (type.resolvedTrueType !== undefined && type.resolvedFalseType !== undefined) {
    return [type.resolvedTrueType, type.resolvedFalseType];
  }
  const node: ts.ConditionalTypeNode | undefined = type.root.node;
  if (node === undefined) {
    return undefined;
  }
  return [checker.getTypeFromTypeNode(node.trueType), checker.getTypeFromTypeNode(node.falseType)];
}

function parametersOf(declaration: ts.SignatureDeclaration): string[] {
  return declaration.parameters.map((parameter) =>
    parameter.name.getText(declaration.getSourceFile()),
  );
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

/** Builds one program and walks it. Callers cache: the program costs ~250 ms. */
export function deriveBoundarySurface(request: DerivationRequest): Derivation {
  const files = request.packageDirs.flatMap((dir) => sourceFilesUnder(request.root, dir));
  const program = ts.createProgram({
    rootNames: files,
    options: compilerOptions(request.configRoot ?? request.root),
  });
  return new SurfaceWalk(program, request.root, files).run(request.entryPoints);
}
