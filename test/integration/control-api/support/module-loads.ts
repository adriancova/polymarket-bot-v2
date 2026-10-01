/**
 * Every module a source file could LOAD, read from its SYNTAX TREE
 * (`CONTROL-1b`, closing `CONTROL1-R2-J-L1`).
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
 * | `require("m")` — also `require?.(…)`, `(require)(…)`, `x.require(…)` | `require` |
 * | `/// <reference types/path/lib="m" />`, `/// <amd-dependency path="m" />` | `reference` |
 * | JSDoc `@import … from "m"` | `jsdoc-import` |
 * | `declare module "m" { … }` | `declare-module` |
 *
 * ## What cannot be read FAILS
 *
 * A scan that proves an ABSENCE must refuse what it cannot read, not pass it:
 *
 * - a specifier that is not a string literal — a variable, a concatenation, an
 *   interpolated template — is {@link COMPUTED};
 * - a reference to a NAMED LOADER outside a literal call — `require` aliased,
 *   passed or read as a property (`const r = require`, `module["require"]`),
 *   and every `createRequire`, `eval`, `_load` (`Module._load`) and
 *   `Function` called or constructed — is `<loader:NAME>`: each exists to load
 *   or evaluate code the parser cannot see;
 * - a file that does not parse under its own extension's grammar (TypeScript
 *   for `.ts`/`.mts`/`.cts`, JavaScript for `.js`/`.mjs`/`.cjs`, JSON for
 *   `.json`) is {@link UNPARSEABLE}: an escaped keyword (`\u0069mport`) is a
 *   syntax error, and a tree with an error in it is a tree this scan did not
 *   fully read. A `.json` file that parses holds no import at all — JSON has
 *   no syntax for one.
 *
 * The scan's caller decides what is FORBIDDEN (`acceptance-3-no-signer.test.ts`):
 * a signing library or the secure adapter, by literal, is never excusable;
 * a computed specifier, a named loader, a loader MODULE (`node:module`,
 * `node:vm`) or an unparseable file is a violation unless an explicit,
 * justified allowlist entry covers it.
 *
 * ## What a static scan cannot see, and the layer behind it
 *
 * Code that reaches a loader through a COMPUTED name it never spells
 * (`globalThis[atob("…")]`) is beyond any static scan. The acceptance test's
 * other layer covers that case independently of syntax: none of the forbidden
 * packages is declared in the manifest or even RESOLVABLE from the scanned
 * trees, so such a load would fail at run time.
 */

import ts from "typescript";

/** A specifier the parser cannot read as a literal. */
export const COMPUTED = "<computed>";

/** A file that does not parse under its extension's grammar. */
export const UNPARSEABLE = "<unparseable>";

/** The finding a named loader reference produces: `<loader:require>` etc. */
export function loaderFinding(name: string): string {
  return `<loader:${name}>`;
}

/** Names whose only purpose is to load or evaluate code (module header). */
export const LOADER_NAMES: readonly string[] = Object.freeze(["require", "createRequire", "eval", "_load"]);

/** Flagged only when CALLED or CONSTRUCTED; `: Function` as a type is not a load. */
export const LOADER_CONSTRUCTORS: readonly string[] = Object.freeze(["Function"]);

/** Modules that exist to build a loader or to evaluate code. */
export const LOADER_MODULES: readonly string[] = Object.freeze(["module", "node:module", "vm", "node:vm"]);

export type ModuleLoadKind =
  | "import"
  | "export-from"
  | "import-equals"
  | "import-type"
  | "dynamic-import"
  | "require"
  | "reference"
  | "jsdoc-import"
  | "declare-module"
  | "loader"
  | "unparseable";

export interface ModuleLoad {
  readonly kind: ModuleLoadKind;
  /** The EVALUATED literal, or {@link COMPUTED}, `<loader:…>`, {@link UNPARSEABLE}. */
  readonly specifier: string;
  /** 1-based line of the node, for the failure message. */
  readonly line: number;
}

/** The extensions this scan reads, and the grammar each is read with. */
export const SCANNED_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"] as const;

function scriptKindFor(fileName: string): ts.ScriptKind | "JSON" {
  if (fileName.endsWith(".json")) return "JSON";
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
 * Every module `text` could load, in source order, duplicates included.
 * `fileName` selects the grammar by extension and labels the parse; it is
 * never read.
 */
export function moduleLoadsIn(text: string, fileName: string): readonly ModuleLoad[] {
  const kind = scriptKindFor(fileName);
  if (kind === "JSON") {
    try {
      JSON.parse(text);
      return Object.freeze([]);
    } catch {
      return Object.freeze([{ kind: "unparseable", specifier: UNPARSEABLE, line: 1 }]);
    }
  }

  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const loads: ModuleLoad[] = [];
  const add = (loadKind: ModuleLoadKind, specifier: string, node: ts.Node): void => {
    loads.push({
      kind: loadKind,
      specifier,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const literal = (node: ts.Node | undefined): string =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : COMPUTED;

  // A file with a syntax error is a file this scan did not fully read. The
  // diagnostics come from the public `transpileModule` API, which reports the
  // syntactic ones for exactly the grammar the extension selects.
  const diagnostics =
    ts.transpileModule(text, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
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
      add("declare-module", node.name.text, node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add("dynamic-import", literal(node.arguments[0]), node);
    } else if (ts.isIdentifier(node)) {
      // `Identifier.text` is the name with its escapes resolved, so
      // `\u0072equire` is `require` here, as it is to the runtime.
      const name = node.text;
      if (name === "require") {
        const call = calleeOf(node);
        if (call !== undefined && ts.isCallExpression(call)) add("require", literal(call.arguments[0]), node);
        else add("loader", loaderFinding(name), node);
      } else if (LOADER_NAMES.includes(name)) {
        add("loader", loaderFinding(name), node);
      } else if (LOADER_CONSTRUCTORS.includes(name) && calleeOf(node) !== undefined) {
        add("loader", loaderFinding(name), node);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      [...LOADER_NAMES, ...LOADER_CONSTRUCTORS].includes(node.argumentExpression.text)
    ) {
      // `module["require"]`, `globalThis["eval"]`: a loader named by a string.
      add("loader", loaderFinding(node.argumentExpression.text), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return Object.freeze(loads);
}
