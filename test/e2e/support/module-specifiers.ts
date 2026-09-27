/**
 * Every module specifier a TypeScript source names, read from its SYNTAX TREE
 * (`RECON-2`, closing `RECON1-SCAN`).
 *
 * ONE helper, shared by the two scans in this tree that ask "what does this
 * file import?":
 *
 * - `safety-posture.test.ts`'s allowlist scan over every file this package
 *   owns — the guard that keeps signing, wallet and other non-allowlisted
 *   packages out of the e2e tree;
 * - `reconciliation-attribution.test.ts`'s independence pin — `support/reconcile.ts`
 *   may import only the decimal arithmetic and the artefact's types.
 *
 * WHY A PARSE AND NOT A LINE REGEX. Both scans used to match lines. An
 * end-of-line anchor let a trailing comment hide an import — the `RECON-1` r2
 * review planted
 * `import { strict as reviewAssert } from "node:assert"; // review plant` in an
 * e2e file and the allowlist scan passed it — while a looser pattern matched
 * the word "from" in prose. In a syntax tree comments and string data are
 * inert, and every place the grammar allows a module reference is a node kind:
 *
 * | Shape | Node |
 * | --- | --- |
 * | `import … from "m"`, `import type … from "m"` | `ImportDeclaration` |
 * | `import "m"` (side effect) | `ImportDeclaration` without a clause |
 * | `export … from "m"`, `export * from "m"` | `ExportDeclaration` with a specifier |
 * | `import x = require("m")` | `ImportEqualsDeclaration` → `ExternalModuleReference` |
 * | `import("m")` | `CallExpression` on the `import` keyword |
 * | `typeof import("m")`, `import("m").T` in a type | `ImportTypeNode` |
 * | `require("m")` | `CallExpression` on the identifier `require` |
 *
 * A specifier that is not a string literal (a variable, a concatenation, an
 * interpolated template) is reported as {@link COMPUTED_SPECIFIER}, which no
 * allowlist contains, so a scan that cannot READ a specifier fails rather than
 * passing it. The walk is `test/contract/coinbase/isolation.test.ts`'s,
 * extended to `require(…)`, import types and the computed case.
 *
 * `typescript` is a root devDependency, used here to PARSE text only: no
 * program, no type check, no file read, no network.
 */

import ts from "typescript";

/** What a specifier the parser cannot read as a literal is reported as. */
export const COMPUTED_SPECIFIER = "<computed>";

/**
 * Every module specifier `text` names, in source order, duplicates included.
 *
 * `fileName` only labels the parse; it is never read.
 */
export function moduleSpecifiersIn(text: string, fileName = "probe.ts"): readonly string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const literal = (node: ts.Node | undefined): string =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : COMPUTED_SPECIFIER;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) specifiers.push(literal(node.moduleSpecifier));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifiers.push(literal(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      specifiers.push(ts.isLiteralTypeNode(argument) ? literal(argument.literal) : COMPUTED_SPECIFIER);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(literal(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return Object.freeze(specifiers);
}
