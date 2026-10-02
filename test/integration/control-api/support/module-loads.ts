/**
 * Every module a source file could LOAD, read from its SYNTAX TREE
 * (`CONTROL-1b`, closing `CONTROL1-R2-J-L1`; widened at `CONTROL-1b` r1,
 * closing `CONTROL1B-R1-J-H2` and `CONTROL1B-R1-J-H3`) — and, since
 * `CONTROL-1b` r2, every LITERAL it holds outside a load (closing
 * `CONTROL1B-R2-J-H1`), and only the REAL calling forms of each loader as
 * loads (closing `CONTROL1B-R2-J-H2`).
 *
 * ## Why a parse, again
 *
 * `acceptance-3-no-signer.test.ts`'s import scan was a regular expression. Its
 * second version (`CONTROL-1` r1) accepted any quote and block comments around
 * the keyword, and the round-2 verifiers still walked three valid imports past
 * it: a LINE comment between `from` and the specifier, a line comment inside a
 * dynamic `import(`, and an ESCAPED specifier (`'\x76iem'` is the string
 * `viem`). A lexical scan has to re-implement the grammar to be right, and it
 * keeps being nearly right. This module asks TypeScript's own parser instead —
 * `typescript` is a devDependency of `apps/control-api` and of the repository
 * root, used here to PARSE text only: no program over the tree, no type check,
 * no file read, no network. (`test/e2e/support/module-specifiers.ts` is the
 * same idea for the e2e tree; this one goes further, below.)
 *
 * In a syntax tree comments and string DATA are inert, and every place the
 * grammar allows a module reference is a node kind. Each is read as the
 * EVALUATED literal (`StringLiteral.text`), so escapes and line continuations
 * resolve exactly as the runtime would resolve them:
 *
 * | Shape | Finding kind |
 * | --- | --- |
 * | `import … from "m"`, `import type …`, `import "m"`, `import defer …` | `import` |
 * | `export … from "m"`, `export * from "m"`, `export type … from "m"` | `export-from` |
 * | `import x = require("m")`, `export import x = require("m")` | `import-equals` |
 * | `typeof import("m")`, `import("m").T` in a type | `import-type` |
 * | `import("m")`, with or without options | `dynamic-import` |
 * | `require("m")` — also `require?.(…)`, `(require)(…)`, `\u0072equire(…)`, `module.require(…)` — with ONE argument | `require` |
 * | `process.getBuiltinModule("m")`, read off `process`, with ONE argument | `builtin` |
 * | vitest's `vi.importActual("m")`, `importMock`, `mock`, `doMock`, `unmock`, `doUnmock` — read off `vi` or `vitest` | `vi-load` |
 * | `/// <reference types/path/lib="m" />`, `/// <amd-dependency path="m" />` | `reference` |
 * | JSDoc `@import … from "m"` | `jsdoc-import` |
 * | `declare module "m" { … }` | `declare-module` |
 *
 * Every executable extension is read with its own grammar (`CONTROL-1b` r1,
 * closing `CONTROL1B-R1-J-H2`: `.tsx` and `.jsx` were not read at all, and a
 * computed import in a `.tsx` helper loaded the secure adapter): TypeScript for
 * `.ts`/`.mts`/`.cts`, TSX for `.tsx`, JavaScript for `.js`/`.mjs`/`.cjs`, JSX
 * for `.jsx`, and JSON for `.json`.
 *
 * ## What cannot be read FAILS
 *
 * A scan that proves an ABSENCE must refuse what it cannot read, not pass it:
 *
 * - a specifier that is not a string literal — a variable, a concatenation, an
 *   interpolated template — is {@link COMPUTED};
 * - a NAMED LOADER or EVALUATOR, wherever the code can reach it, is
 *   `<loader:NAME>` (`CONTROL-1b` r1, closing `CONTROL1B-R1-J-H3`: round 0
 *   flagged `Function` only as a callee, so `const F = Function`,
 *   `(() => {}).constructor` and `process.getBuiltinModule("node:vm")` each
 *   reached an evaluator and loaded the venue SDK past it):
 *   - every `createRequire`, `eval`, `_load`, `_compile`, `_extensions`,
 *     `dlopen`, `binding`, `_linkedBinding`, `ShadowRealm` and `constructor` —
 *     as an identifier or a property name in ANY position;
 *   - every name beginning `__vite` — vite-node runs each module inside a
 *     wrapper whose parameters `__vite_ssr_import__` and
 *     `__vite_ssr_dynamic_import__` are loaders in scope, and vitest keeps its
 *     runtime on `globalThis.__vitest_*__` (`CONTROL-1b` r1: the implementer's
 *     own plant loaded the secure adapter through the first);
 *   - `Function` in any VALUE position — called, constructed, aliased, passed,
 *     extended or read as a property — while `f: Function`, `typeof Function`
 *     in a type and `implements Function` stay legal: types load nothing;
 *   - `require`, `getBuiltinModule` and vitest's module loaders outside a
 *     REAL call of the form in the table above (`vi.mock` and `vi.unmock`
 *     only when read off `vi` or `vitest`, since `fn.mock.calls` is a spy's
 *     record, not a loader). `CONTROL-1b` r2 (closing `CONTROL1B-R2-J-H2`):
 *     round 1 read EVERY `x.require(…)` as a load of its first argument, but
 *     `ts.sys.require(baseDir, moduleName)` takes the module SECOND — the
 *     verifiers loaded the venue SDK through it while the scan judged the
 *     test file's own path. So `x.require(…)` is a load only off `module`,
 *     any other `.require` — and any `require` call with other than one
 *     argument — is `<loader:require>`; `getBuiltinModule` is a load only off
 *     `process`; and vitest's loaders only off `vi` or `vitest`;
 *   - any of those names as a STRING in a value position: `x["eval"]`,
 *     `Reflect.get(globalThis, "eval")`;
 *   - `import.meta.glob` and `import.meta.globEager`, which load every module
 *     a pattern matches;
 * - a file that does not parse under its own extension's grammar is
 *   {@link UNPARSEABLE}: an escaped keyword (`import`) is a syntax error,
 *   and a tree with an error in it is a tree this scan did not fully read. A
 *   `.json` file that parses holds no import at all — JSON has no syntax for
 *   one.
 *
 * The scan's caller decides where each literal LANDS and whether that is
 * forbidden (`support/load-judge.ts`): a path is judged by the file it
 * reaches, a bare name by its package (from an explicit list), and a builtin
 * by an allowlist.
 *
 * ## Every literal is read too (`CONTROL-1b` r2, closing `CONTROL1B-R2-J-H1`)
 *
 * Round 1 judged a literal only in a LOAD position. The round-2 verifiers
 * reached a loader without spelling its name — `getBuiltinModule` and
 * `createRequire` built with `.join("")`, `Function` found by enumerating the
 * function prototype — and handed it a LITERAL path or package name, which sat
 * in the file unjudged. {@link scanSource} therefore also returns every
 * {@link SourceLiteral} outside a load position and outside a type: each
 * string literal; each template's text, both as evaluated and RAW (what
 * `String.raw` yields); each regular expression's body; JSX text; every
 * identifier and private name (`Function.prototype.name` and `Object.keys`
 * turn a name into a string); and, in JSON, every key and string value. The
 * caller judges each one by what it NAMES (`load-judge.ts`, `judgeLiteral`).
 * Comments are not read: code reaching one goes through `toString` and a
 * slice, which is a computed value.
 *
 * Since `CONTROL-1b` r3 (closing `CONTROL1B-R3-J-H1`) a literal with a PATH
 * form — and a path quoted inside one — is also judged where a loader handed it
 * would LAND (`load-judge.ts`, "A literal PATH is judged where it lands"): the
 * round-3 verifiers handed a computed `createRequire` a literal path to an
 * inert `.md` and to a `.cjs` outside every tree, and each loaded the venue SDK.
 *
 * ## What a static scan cannot see
 *
 * A load whose loader the scan does not name — reached by a COMPUTED key
 * (`globalThis[atob("…")]`), by enumeration, by spreading an object that holds
 * one, or through an API of a permitted package other than those named above
 * — AND whose target the scan does not reach from a literal: a path or name
 * computed at run time (from parts, by slicing, from encoded data or from the
 * program's own text); a literal joined at run time to a base the program
 * supplies (`join(root, "x")`, a `createRequire` anchor other than the file's
 * own, a URL base), since the scan resolves a literal path only against its
 * own file's directory and, when absolute, the repository root; a value
 * another module exports; or a file that does not exist when the scan runs
 * (one a test writes, and then loads). That is beyond any static scan, and
 * this one does not claim it. The control API's integration runners close it
 * at RUN time (`no-signer-guard.ts`), and `acceptance-3-no-signer.test.ts`
 * ("What this does not prove") states where they do not — the repository's
 * unit runner among them.
 */

import ts from "typescript";

/** A specifier the parser cannot read as a literal. */
export const COMPUTED = "<computed>";

/** A file that does not parse under its extension's grammar. */
export const UNPARSEABLE = "<unparseable>";

/** The finding a named loader reference produces: `<loader:eval>` etc. */
export function loaderFinding(name: string): string {
  return `<loader:${name}>`;
}

/**
 * Names whose purpose is to load or evaluate code, flagged WHEREVER they
 * appear as an identifier or a property name (module header). `constructor`
 * is here because every function's `constructor` is an evaluator.
 */
export const LOADER_NAMES: readonly string[] = Object.freeze([
  "createRequire",
  "eval",
  "_load",
  "_compile",
  // `CONTROL-1b` r2: `Module._extensions[ext](module, file)` compiles a file
  // without running any loader hook (`no-signer-guard.ts`).
  "_extensions",
  "dlopen",
  "binding",
  "_linkedBinding",
  "ShadowRealm",
  "constructor",
]);

/**
 * Every name beginning with this is the test runner's own machinery
 * (module header): flagged wherever it appears, like {@link LOADER_NAMES}.
 */
export const RUNTIME_LOADER_PREFIX = "__vite";

/** Flagged in a VALUE position only; `: Function` as a type loads nothing. */
export const EVALUATOR_CONSTRUCTORS: readonly string[] = Object.freeze(["Function"]);

export type ModuleLoadKind =
  | "import"
  | "export-from"
  | "import-equals"
  | "import-type"
  | "dynamic-import"
  | "require"
  | "builtin"
  | "vi-load"
  | "reference"
  | "jsdoc-import"
  | "declare-module"
  | "loader"
  | "unparseable";

/**
 * Loaders whose first argument is a module specifier: a call is read as a load
 * of that literal, and any other reference to the name is a named loader.
 */
export const SPECIFIER_LOADERS: ReadonlyMap<string, ModuleLoadKind> = new Map<string, ModuleLoadKind>([
  ["require", "require"],
  ["getBuiltinModule", "builtin"],
  ["importActual", "vi-load"],
  ["importMock", "vi-load"],
  ["doMock", "vi-load"],
  ["doUnmock", "vi-load"],
  ["mock", "vi-load"],
  ["unmock", "vi-load"],
]);

/**
 * Of {@link SPECIFIER_LOADERS}, the names a NON-call reference flags only when
 * read off `vi` or `vitest`: `fn.mock.calls` is a spy's record.
 */
export const VITEST_ONLY_WHEN_ON_VI: readonly string[] = Object.freeze(["mock", "unmock"]);
const VITEST_OBJECTS: readonly string[] = Object.freeze(["vi", "vitest"]);

/** `import.meta.<NAME>` properties that load modules (vite). */
export const IMPORT_META_LOADERS: readonly string[] = Object.freeze(["glob", "globEager"]);

/**
 * A literal a file holds OUTSIDE a load position and outside a type
 * (module header, "Every literal is read too"). `identifier` is a name, which
 * the caller judges only as a whole.
 */
export interface SourceLiteral {
  readonly kind: "string" | "template" | "template-raw" | "regex" | "jsx-text" | "identifier" | "json";
  readonly text: string;
  /** 1-based line, for the failure message (1 in JSON). */
  readonly line: number;
}

export interface ModuleLoad {
  readonly kind: ModuleLoadKind;
  /** The EVALUATED literal, or {@link COMPUTED}, `<loader:…>`, {@link UNPARSEABLE}. */
  readonly specifier: string;
  /** 1-based line of the node, for the failure message. */
  readonly line: number;
}

/** The executable extensions this scan reads, each with its own grammar. */
export const CODE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"] as const;

/** Every extension this scan reads: code, and JSON. */
export const SCANNED_EXTENSIONS = [...CODE_EXTENSIONS, ".json"] as const;

/** The grammar each scanned extension is read with. */
export function scriptKindFor(fileName: string): ts.ScriptKind | "JSON" {
  if (fileName.endsWith(".json")) return "JSON";
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Skips the wrappers that leave an expression's value unchanged. */
function outerOf(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (parent === undefined) return current;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return current;
  }
}

/**
 * The call or construction `name` is the callee of — directly, through
 * wrappers, or as the property name of the callee (`module.require(…)`) — or
 * `undefined`.
 */
function calleeOf(name: ts.Identifier): ts.CallExpression | ts.NewExpression | undefined {
  let target: ts.Node = name;
  const parent = name.parent as ts.Node | undefined;
  if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === name) target = parent;
  const outer = outerOf(target);
  const call = outer.parent as ts.Node | undefined;
  if (call !== undefined && (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === outer) {
    return call;
  }
  return undefined;
}

/**
 * Whether `node` sits where only a TYPE can be: inside a type node, an
 * interface or a type alias, or an `implements` clause. A class's `extends`
 * clause and an instantiation expression (`f<T>`) are VALUES, although
 * TypeScript files their node under the type kinds.
 */
function inTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node = node; current.parent !== undefined; current = current.parent) {
    const parent = current.parent;
    if (ts.isExpressionWithTypeArguments(parent)) {
      const clause = parent.parent as ts.Node | undefined;
      if (clause === undefined || !ts.isHeritageClause(clause)) return false;
      return clause.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(clause.parent);
    }
    if (ts.isTypeNode(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) return true;
  }
  return false;
}

/** The identifier a property-name identifier is read off (`vi` in `vi.mock`), or `undefined`. */
function objectNameOf(name: ts.Identifier): string | undefined {
  const parent = name.parent as ts.Node | undefined;
  if (parent === undefined || !ts.isPropertyAccessExpression(parent) || parent.name !== name) return undefined;
  return ts.isIdentifier(parent.expression) ? parent.expression.text : undefined;
}

/** Whether `name` is the property name of a property access (`require` in `x.require`). */
function isPropertyName(name: ts.Identifier): boolean {
  const parent = name.parent as ts.Node | undefined;
  return parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === name;
}

/**
 * The call through which `name` — one of {@link SPECIFIER_LOADERS} — REALLY
 * loads its first argument, or `undefined` (module header, `CONTROL1B-R2-J-H2`):
 *
 * - `require`: called as itself (through any wrapper, escape or optional
 *   call), or as `module.require`, with exactly ONE argument;
 * - `getBuiltinModule`: called as `process.getBuiltinModule`, with exactly one;
 * - vitest's loaders: called off `vi` or `vitest`, the module first.
 */
function realLoaderCall(name: string, node: ts.Identifier): ts.CallExpression | undefined {
  const call = calleeOf(node);
  if (call === undefined || !ts.isCallExpression(call)) return undefined;
  const objectName = objectNameOf(node);
  const asProperty = isPropertyName(node);
  // Keyed by the KIND each name produces, so this file spells no loader name
  // beyond its vocabulary lists (acceptance 3 counts them exactly).
  switch (SPECIFIER_LOADERS.get(name)) {
    case "vi-load":
      return asProperty && VITEST_OBJECTS.includes(objectName ?? "") && call.arguments.length >= 1 ? call : undefined;
    case "builtin":
      return asProperty && objectName === "process" && call.arguments.length === 1 ? call : undefined;
    default:
      return (!asProperty || objectName === "module") && call.arguments.length === 1 ? call : undefined;
  }
}

/** Whether `name` loads or evaluates code when spelled as a string key. */
function namesLoader(name: string): boolean {
  return (
    LOADER_NAMES.includes(name) ||
    EVALUATOR_CONSTRUCTORS.includes(name) ||
    SPECIFIER_LOADERS.has(name) ||
    name.startsWith(RUNTIME_LOADER_PREFIX)
  );
}

/**
 * Every module `text` could load, in source order, duplicates included.
 * `fileName` selects the grammar by extension and labels the parse; it is
 * never read.
 */
export function moduleLoadsIn(text: string, fileName: string): readonly ModuleLoad[] {
  return scanSource(text, fileName).loads;
}

/** Every key and string value of a parsed JSON document. */
function jsonStrings(value: unknown, out: SourceLiteral[]): void {
  if (typeof value === "string") {
    out.push({ kind: "json", text: value, line: 1 });
  } else if (Array.isArray(value)) {
    for (const entry of value) jsonStrings(entry, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out.push({ kind: "json", text: key, line: 1 });
      jsonStrings(entry, out);
    }
  }
}

/**
 * Every module `text` could load ({@link moduleLoadsIn}) and every literal it
 * holds outside a load position and outside a type (module header, "Every
 * literal is read too"), in source order, duplicates included.
 */
export function scanSource(
  text: string,
  fileName: string,
): { readonly loads: readonly ModuleLoad[]; readonly literals: readonly SourceLiteral[] } {
  const kind = scriptKindFor(fileName);
  if (kind === "JSON") {
    try {
      const literals: SourceLiteral[] = [];
      jsonStrings(JSON.parse(text) as unknown, literals);
      return { loads: Object.freeze([]), literals: Object.freeze(literals) };
    } catch {
      return { loads: Object.freeze([{ kind: "unparseable", specifier: UNPARSEABLE, line: 1 }]), literals: Object.freeze([]) };
    }
  }

  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const loads: ModuleLoad[] = [];
  const literals: SourceLiteral[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (loadKind: ModuleLoadKind, specifier: string, node: ts.Node): void => {
    loads.push({ kind: loadKind, specifier, line: lineOf(node) });
  };
  // The nodes read as a load's specifier: judged as LOADS, so not again as literals.
  const specifiers = new Set<ts.Node>();
  const literal = (node: ts.Node | undefined): string => {
    if (node !== undefined) specifiers.add(node);
    return node !== undefined && ts.isStringLiteralLike(node) ? node.text : COMPUTED;
  };

  // A file with a syntax error is a file this scan did not fully read. The
  // diagnostics come from the public `transpileModule` API, which reports the
  // syntactic ones for exactly the grammar the extension selects.
  const diagnostics =
    ts.transpileModule(text, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
    }).diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    loads.push({ kind: "unparseable", specifier: UNPARSEABLE, line: 1 });
  }

  for (const reference of [
    ...source.referencedFiles,
    ...source.typeReferenceDirectives,
    ...source.libReferenceDirectives,
  ]) {
    loads.push({
      kind: "reference",
      specifier: reference.fileName,
      line: source.getLineAndCharacterOfPosition(reference.pos).line + 1,
    });
  }
  for (const dependency of source.amdDependencies) {
    loads.push({ kind: "reference", specifier: dependency.path, line: 1 });
  }

  /** A name that loads or evaluates code, met as an identifier or a property name. */
  const identifier = (node: ts.Identifier): void => {
    // `Identifier.text` is the name with its escapes resolved, so
    // `require` is `require` here, as it is to the runtime.
    const name = node.text;
    const specifierKind = SPECIFIER_LOADERS.get(name);
    if (specifierKind !== undefined) {
      const call = realLoaderCall(name, node);
      if (call !== undefined) {
        add(specifierKind, literal(call.arguments[0]), node);
      } else if (!VITEST_ONLY_WHEN_ON_VI.includes(name) || VITEST_OBJECTS.includes(objectNameOf(node) ?? "")) {
        add("loader", loaderFinding(name), node);
      }
    } else if (LOADER_NAMES.includes(name) || name.startsWith(RUNTIME_LOADER_PREFIX)) {
      add("loader", loaderFinding(name), node);
    } else if (EVALUATOR_CONSTRUCTORS.includes(name) && !inTypePosition(node)) {
      add("loader", loaderFinding(name), node);
    }
  };

  /** A literal outside a load position and outside a type (module header). */
  const collect = (node: ts.Node): void => {
    if (specifiers.has(node)) return;
    let found: readonly (readonly [SourceLiteral["kind"], string | undefined])[] = [];
    if (ts.isStringLiteral(node)) {
      found = [["string", node.text]];
    } else if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found = [
        ["template", node.text],
        ["template-raw", node.rawText],
      ];
    } else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const raw = (node as ts.RegularExpressionLiteral).text;
      found = [["regex", raw.slice(1, raw.lastIndexOf("/"))]];
    } else if (ts.isJsxText(node)) {
      found = [["jsx-text", node.text.trim()]];
    } else if (ts.isIdentifier(node)) {
      found = [["identifier", node.text]];
    } else if (ts.isPrivateIdentifier(node)) {
      found = [["identifier", node.text.slice(1)]];
    }
    if (found.length === 0 || inTypePosition(node)) return;
    const seen = new Set<string>();
    for (const [literalKind, value] of found) {
      if (value === undefined || value === "" || seen.has(value)) continue;
      seen.add(value);
      literals.push({ kind: literalKind, text: value, line: lineOf(node) });
    }
  };

  const seenTags = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    for (const tag of ts.getJSDocTags(node)) {
      if (seenTags.has(tag)) continue;
      seenTags.add(tag);
      if (ts.isJSDocImportTag(tag)) add("jsdoc-import", literal(tag.moduleSpecifier), tag);
    }

    if (ts.isImportDeclaration(node)) {
      add("import", literal(node.moduleSpecifier), node);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) add("export-from", literal(node.moduleSpecifier), node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        add("import-equals", literal(node.moduleReference.expression), node);
      }
    } else if (ts.isImportTypeNode(node)) {
      add("import-type", ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : COMPUTED, node);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      specifiers.add(node.name);
      add("declare-module", node.name.text, node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add("dynamic-import", literal(node.arguments[0]), node);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      IMPORT_META_LOADERS.includes(node.name.text)
    ) {
      add("loader", loaderFinding(`import.meta.${node.name.text}`), node);
    } else if (ts.isIdentifier(node)) {
      identifier(node);
    } else if (ts.isStringLiteralLike(node) && namesLoader(node.text) && !inTypePosition(node)) {
      // A loader named by a STRING in a value position: `module["require"]`,
      // `Reflect.get(globalThis, "eval")`, `{ "constructor": … }`.
      add("loader", loaderFinding(node.text), node);
    }
    collect(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { loads: Object.freeze(loads), literals: Object.freeze(literals) };
}
