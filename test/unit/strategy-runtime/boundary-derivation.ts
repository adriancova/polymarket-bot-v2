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
  | "declared property function";

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
  private readonly entries = new Map<ts.Symbol, DerivedCallable[]>();
  private readonly unresolved: UnresolvedCallable[] = [];
  private readonly walkedTypes = new Map<ts.Type, Set<Visibility>>();

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

  private record(symbol: ts.Symbol, entry: DerivedCallable): void {
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
    const calls = type.getCallSignatures();
    if (calls.length > 0) {
      this.recordSignatures(id, symbol, calls, visibility, via, depth);
    }
    if (type.getConstructSignatures().length > 0 && (symbol.flags & ts.SymbolFlags.Class) === 0) {
      this.refuse(
        id,
        this.fileOf(symbol),
        "a non-class value with construct signatures: enumerate it in boundary-derivation.ts " +
          "rather than letting this walk guess how it is constructed",
      );
    }
    this.visitProperties(id, type, visibility, depth);
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
      this.record(symbol, {
        id: label,
        file: repoRelative(this.root, declaration.getSourceFile().fileName),
        visibility,
        params: parametersOf(declaration),
        shape,
        via,
      });
      this.visitHandedOut(this.checker.getReturnTypeOfSignature(signature), visibility, depth + 1);
    });
  }

  /** Non-private members of an object type that are declared in these packages. */
  private visitProperties(
    owner: string,
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
      if (!this.isOurs(property) || property.getName().startsWith("#")) {
        continue;
      }
      this.visitMember(`${owner}.${property.getName()}`, property, visibility, "object property", depth);
    }
  }

  private visitClass(className: string, symbol: ts.Symbol): void {
    const declaration = (symbol.getDeclarations() ?? []).find(ts.isClassDeclaration);
    if (declaration === undefined) {
      this.refuse(className, this.fileOf(symbol), "class symbol without a class declaration");
      return;
    }
    // The class VALUE (its constructor and statics) is reachable only where the
    // value itself is exported; INSTANCE members are reachable wherever an
    // instance can escape, which a publicly exported TYPE already implies.
    const valueExported = this.publicValues.has(symbol);
    const staticVisibility: Visibility = valueExported ? "PUBLIC" : "PACKAGE";
    const instanceVisibility: Visibility =
      valueExported || this.publicTypes.has(symbol) ? "PUBLIC" : "PACKAGE";

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
        shape: "constructor",
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
      this.visitHandedOut(
        this.checker.getTypeOfSymbolAtLocation(member, accessors[0] as ts.Declaration),
        visibility,
        depth + 1,
      );
      return;
    }

    const type = this.checker.getTypeOfSymbolAtLocation(member, declarations[0] as ts.Declaration);
    if (depth + 1 > MAX_SURFACE_DEPTH) {
      if (
        type.getCallSignatures().length > 0 ||
        this.checker.getPropertiesOfType(type).some((property) => this.isOurs(property))
      ) {
        this.refuse(
          id,
          this.fileOf(member),
          `the surface walk reached MAX_SURFACE_DEPTH (${String(MAX_SURFACE_DEPTH)}) with ` +
            "callables still below it; flatten the value or classify this branch explicitly",
        );
      }
      return;
    }
    this.visitValue(id, member, type, visibility, via, depth + 1);
  }

  /**
   * Rule 4: a type this package RETURNS is a value this package constructs and
   * hands to someone else, so its callable members are this package's callables.
   */
  private visitHandedOut(type: ts.Type, handedOutBy: Visibility, depth: number): void {
    if (depth > MAX_SURFACE_DEPTH) {
      return;
    }
    const constituents = type.isUnion() || type.isIntersection() ? type.types : [type];
    for (const constituent of constituents) {
      const symbol = constituent.getSymbol() ?? constituent.aliasSymbol;
      if (symbol === undefined || !this.isOurs(symbol)) {
        continue;
      }
      const visibility: Visibility =
        this.isPublicType(symbol) || handedOutBy === "PUBLIC" ? "PUBLIC" : "PACKAGE";
      const name = symbol.getName();
      this.visitProperties(name === "__type" ? "handed out" : name, constituent, visibility, depth);
    }
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
