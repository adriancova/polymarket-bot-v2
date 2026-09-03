/**
 * THE MECHANISM (remediation round 6): a compiler-resolved census of every
 * PROTOTYPE-CONSULTING construct in `packages/risk` and
 * `packages/capital-allocator`.
 *
 * WHY THIS EXISTS, STATED AS THE HISTORY THAT FORCED IT. Four consecutive
 * review rounds falsified a hand-made list in this package:
 *
 * - round 3: the identity field list missed a sixth field;
 * - round 4: the `Object.entries` walk missed non-enumerable and inherited
 *   properties;
 * - round 5: the "every table now uses `ownEntry`/`setOwn`" sweep missed
 *   `reserve.ts`'s three sites, `exposure.ts`'s global lookup, and the `in`
 *   operator entirely;
 * - round 6: the reviewer found all of those, and one of them
 *   (`state.liveOwners[req.marketId]`) was a FAIL-OPEN on the live-ownership
 *   gate — an inherited owner authorized a LIVE reservation.
 *
 * Every one of those was found by looking. This module stops looking. It parses
 * both packages with the TypeScript compiler and enumerates, from the syntax
 * tree rather than from a reader's memory, every construct that can reach a
 * property the object does not own:
 *
 * | kind | construct | why it is prototype-consulting |
 * | --- | --- | --- |
 * | `element-read` | `o[k]` | `Get` walks the prototype chain |
 * | `element-write` | `o[k] = v` | `Set` walks the chain and invokes an inherited SETTER |
 * | `element-compound` | `o[k] ??= v`, `o[k] += v`, `o[k]++` | a `Get` and a `Set` |
 * | `delete-element` | `delete o[k]` | own-only, but it is how a table is edited |
 * | `in` | `k in o` | answers TRUE for an inherited or a prototype member |
 * | `object-spread` | `{ ...o }` | own-only READ, but the RESULT inherits `Object.prototype` |
 * | `object-assign` | `Object.assign(t, o)` | same, plus it invokes inherited setters on the target |
 * | `computed-key` | `{ [k]: v }` | `CreateDataProperty` — safe, enumerated so the census is total |
 *
 * The census is the input to a test that requires EVERY site to be either an
 * own-property primitive or an explicitly registered exception carrying a
 * reason. Nothing is classified by being unnoticed.
 *
 * SCOPE, STATED SO IT IS NOT A FOURTH ABSOLUTE. This census covers COMPUTED
 * member access, `in`, spreads and `Object.assign`. It does NOT cover a plain
 * dotted read (`caps.liveMicroMaxOrderNotional`), which also consults the
 * prototype: every field read in both packages is one, so a rule over them
 * would be noise rather than a gate. The complementary mechanism for that class
 * is behavioural rather than syntactic — `inherited-state.test.ts` augments
 * `Object.prototype` with each key these packages actually use and requires
 * every public answer to be unchanged — and it is what caught the caps-fence
 * hole that no syntactic rule would have flagged.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The two packages this work package owns. */
export const SCANNED_PACKAGES = ["risk", "capital-allocator"] as const;

export type AccessKind =
  | "element-read"
  | "element-write"
  | "element-compound"
  | "delete-element"
  | "in"
  | "object-spread"
  | "object-assign"
  | "computed-key";

export interface AccessSite {
  /** Repository-relative path, POSIX separators. */
  readonly file: string;
  readonly line: number;
  readonly kind: AccessKind;
  /** Enclosing function/method name, or `<module>` at the top level. */
  readonly enclosing: string;
  /** The site's source text, whitespace-collapsed and bounded. */
  readonly text: string;
}

function sourceFilesOf(packageName: string): string[] {
  const directory = resolve(REPO_ROOT, "packages", packageName, "src");
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(directory, entry))
    .sort();
}

/**
 * Every `.ts` file of both packages — colocated tests included — plus the
 * shared fixture module.
 *
 * `test/unit/risk/fixtures.ts` is in the census because review round 5 found the
 * identical prototype defect in it (`zeroFilled`'s `out[key] ??= …` silently
 * skipped a scope it claimed to measure), and a fixture that quietly measures
 * nothing makes the tests above it vacuous. The `*.test.ts` files under
 * `test/unit/risk` are NOT scanned; that boundary is stated in the test that
 * consumes this census, with its reason.
 */
export function scannedFiles(): string[] {
  return [
    ...SCANNED_PACKAGES.flatMap((packageName) => sourceFilesOf(packageName)),
    resolve(REPO_ROOT, "test/unit/risk/fixtures.ts"),
  ];
}

function collapse(text: string): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length > 120 ? `${single.slice(0, 117)}...` : single;
}

/**
 * The nearest enclosing named function, from the ancestor stack.
 *
 * The stack is carried by the walk rather than read from `node.parent`: a
 * `ts.Program`'s nodes do not carry parent pointers unless the source was
 * parsed with `setParentNodes`, and a census that silently saw `undefined`
 * there would be exactly the kind of quiet blindness this module exists to end.
 */
function enclosingName(ancestors: readonly ts.Node[]): string {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const current = ancestors[index];
    if (current === undefined) continue;
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      if (current.name !== undefined && ts.isIdentifier(current.name)) return current.name.text;
      const parent = ancestors[index - 1];
      if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      return "<anonymous>";
    }
  }
  return "<module>";
}

const COMPOUND_TOKENS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

function elementAccessKind(node: ts.ElementAccessExpression, parent: ts.Node | undefined): AccessKind {
  if (parent === undefined) return "element-read";
  if (ts.isDeleteExpression(parent)) return "delete-element";
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return "element-write";
    if (COMPOUND_TOKENS.has(parent.operatorToken.kind)) return "element-compound";
  }
  if (
    (ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return "element-compound";
  }
  return "element-read";
}

function isObjectAssign(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "assign"
  );
}

/**
 * The census, resolved by the compiler.
 *
 * A `ts.Program` is built (rather than a lone `createSourceFile`) so the files
 * are parsed exactly as the build parses them, and so a syntax error anywhere in
 * either package fails this loudly instead of silently yielding an empty list.
 */
export function censusOfPrototypeAccess(): readonly AccessSite[] {
  const files = scannedFiles();
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
  });

  const syntactic = files.flatMap((file) => {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`the compiler did not load ${file}`);
    return [...program.getSyntacticDiagnostics(source)];
  });
  if (syntactic.length > 0) {
    throw new Error(
      `the census cannot run on unparseable sources: ${syntactic
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
        .join("; ")}`,
    );
  }

  const sites: AccessSite[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) continue;
    sites.push(...sitesIn(source, relative(REPO_ROOT, file).split("\\").join("/")));
  }
  return sites;
}

/**
 * The same walk over a source TEXT, so the DETECTOR can be tested directly.
 *
 * A census whose detector nobody has exercised is a list again — this is how
 * the test above it proves each of the four historically-missed constructs is
 * seen, without editing a product file to find out.
 */
export function censusOfSourceText(text: string, fileName = "probe.ts"): readonly AccessSite[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  return sitesIn(source, fileName);
}

function sitesIn(source: ts.SourceFile, repoRelative: string): AccessSite[] {
  const sites: AccessSite[] = [];
  const ancestors: ts.Node[] = [];
  const push = (node: ts.Node, kind: AccessKind): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    sites.push({
      file: repoRelative,
      line: line + 1,
      kind,
      enclosing: enclosingName(ancestors),
      text: collapse(node.getText(source)),
    });
  };
  const visit = (node: ts.Node): void => {
    const parent = ancestors[ancestors.length - 1];
    if (ts.isElementAccessExpression(node)) push(node, elementAccessKind(node, parent));
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      push(node, "in");
    } else if (ts.isSpreadAssignment(node)) push(node, "object-spread");
    else if (ts.isCallExpression(node) && isObjectAssign(node)) push(node, "object-assign");
    else if (
      ts.isComputedPropertyName(node) &&
      parent !== undefined &&
      ts.isPropertyAssignment(parent)
    ) {
      push(node, "computed-key");
    }
    ancestors.push(node);
    ts.forEachChild(node, visit);
    ancestors.pop();
  };
  ts.forEachChild(source, visit);
  return sites;
}

/** Source text of a scanned file, for tests that need to read it. */
export function readScannedFile(repoRelativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, repoRelativePath), "utf8");
}

// ---------------------------------------------------------------------------
// the audited `node:` built-in — review round 6, LOW B
// ---------------------------------------------------------------------------

/** One `node:` import, and every way its binding is used in the file. */
export interface BuiltinImportAudit {
  readonly file: string;
  readonly specifier: string;
  readonly line: number;
  /** `import { types } from …` → imported `types`, bound as `types`. */
  readonly imported: string;
  readonly binding: string;
  /** `namespace` for `import * as x`, `default` for a default import. */
  readonly form: "named" | "namespace" | "default";
  /**
   * Every reference to the binding OUTSIDE its import, rendered.
   *
   * `types.isProxy` for a property access; anything else is rendered as what it
   * is (`BARE REFERENCE`, `types[…]`, `destructured`), because those are exactly
   * the four bypasses review round 6 demonstrated against the previous LEXICAL
   * pin: `const t = types`, `const { isDate } = types`, `types["isDate"]`, and a
   * bare reference passed somewhere else.
   */
  readonly uses: readonly string[];
}

/** Dynamic `import("node:…")` calls, which no static pin would see. */
export interface BuiltinAuditResult {
  readonly imports: readonly BuiltinImportAudit[];
  readonly dynamicSpecifiers: readonly string[];
}

/**
 * Audits every `node:` built-in import in one source TEXT, by binding.
 *
 * SYNTAX-DIRECTED, NOT LEXICAL. The previous pin matched the regular expression
 * `\btypes\s*\.\s*[A-Za-z0-9_$]+` and was bypassable four ways. This resolves
 * the IMPORT to its local binding name and then finds every reference to that
 * name, classifying each by its parent node — so aliasing, destructuring and
 * computed access are all reported rather than skipped.
 *
 * A local binding that SHADOWS the import (a parameter also called `types`)
 * would be reported as a use, which is the fail-closed direction: the audit
 * would fail and the shadowing name would have to be changed.
 */
export function auditNodeBuiltins(text: string, fileName = "probe.ts"): BuiltinAuditResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const imports: {
    specifier: string;
    line: number;
    imported: string;
    binding: string;
    form: "named" | "namespace" | "default";
    uses: string[];
  }[] = [];
  const dynamicSpecifiers: string[] = [];
  const importNodes = new Set<ts.Node>();

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const collectImports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith("node:")
    ) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      importNodes.add(node);
      if (clause?.name !== undefined) {
        imports.push({
          specifier,
          line: lineOf(node),
          imported: "default",
          binding: clause.name.text,
          form: "default",
          uses: [],
        });
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        imports.push({
          specifier,
          line: lineOf(node),
          imported: "*",
          binding: bindings.name.text,
          form: "namespace",
          uses: [],
        });
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.push({
            specifier,
            line: lineOf(node),
            imported: (element.propertyName ?? element.name).text,
            binding: element.name.text,
            form: "named",
            uses: [],
          });
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        dynamicSpecifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, collectImports);
  };
  ts.forEachChild(source, collectImports);

  const bindings = new Map(imports.map((entry) => [entry.binding, entry]));
  if (bindings.size > 0) {
    const ancestors: ts.Node[] = [];
    const insideImport = (): boolean => ancestors.some((node) => importNodes.has(node));
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && bindings.has(node.text) && !insideImport()) {
        const entry = bindings.get(node.text);
        const parent = ancestors[ancestors.length - 1];
        if (entry !== undefined) {
          if (
            parent !== undefined &&
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node
          ) {
            entry.uses.push(`${node.text}.${parent.name.text}`);
          } else if (
            parent !== undefined &&
            ts.isPropertyAccessExpression(parent) &&
            parent.name === node
          ) {
            // `x.types` — a property that happens to share the name, not a use.
          } else if (
            parent !== undefined &&
            ts.isElementAccessExpression(parent) &&
            parent.expression === node
          ) {
            entry.uses.push(`${node.text}[computed] at line ${String(lineOf(node))}`);
          } else if (parent !== undefined && ts.isVariableDeclaration(parent)) {
            entry.uses.push(`${node.text} ALIASED or DESTRUCTURED at line ${String(lineOf(node))}`);
          } else {
            entry.uses.push(`${node.text} BARE REFERENCE at line ${String(lineOf(node))}`);
          }
        }
      }
      ancestors.push(node);
      ts.forEachChild(node, visit);
      ancestors.pop();
    };
    ts.forEachChild(source, visit);
  }

  return {
    imports: imports.map((entry) => ({ ...entry, file: fileName, uses: [...entry.uses] })),
    dynamicSpecifiers,
  };
}

/** {@link auditNodeBuiltins} over every scanned file, with its repo-relative path. */
export function auditScannedFiles(): readonly { file: string; audit: BuiltinAuditResult }[] {
  return scannedFiles().map((file) => ({
    file: relative(REPO_ROOT, file).split("\\").join("/"),
    audit: auditNodeBuiltins(readFileSync(file, "utf8"), file),
  }));
}
