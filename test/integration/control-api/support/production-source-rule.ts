/**
 * The PRODUCTION-SOURCE rule of acceptance 3 (`CONTROL-1b` r4): no
 * dynamic-loading primitive at all in `apps/control-api/src/**`, its test
 * files excluded. One of the two AUTHORITATIVE checks of "no signer is
 * loaded" — the other is the shipped bundle's metafile
 * (`acceptance-3-shipped-artifact.test.ts`); the run-time guard
 * (`no-signer-guard.ts`) covers the test runners. The test-tree scan
 * (`module-loads.ts`, `load-judge.ts`) is best-effort lint.
 *
 * Production source is the code that ships. It has no reason to load a module
 * it does not name, to evaluate text, or to reach a loader by name at run
 * time, so this rule forbids each of those outright, read from TypeScript's
 * own syntax tree (comments and string data are inert there):
 *
 * | Rule | What fails |
 * | --- | --- |
 * | `specifier` | a static import, re-export, `import x = require()`, `import()` or `require()` of anything but a relative path that stays inside the package's `src`, a builtin from `PERMITTED_BUILTINS` (`node:vm`, `node:module`, `node:child_process`, `node:worker_threads` and the rest are not on it), one of the package's own declared `dependencies` (a subpath included), or — in a driver shim the scope names, and there only — that shim's own `node:` builtin (`CONTROL-2` r1, `driver-shims.ts`) |
 * | `non-literal` | an `import()` or `require()` whose specifier is not a string literal |
 * | `require-form` | `require` (or `x.require`) anywhere but as the callee of such a call with ONE literal argument |
 * | `name` | an identifier, property name, private name or string key that names a loader or an evaluator — the scan's own vocabulary (`createRequire`, `eval`, `_load`, `_compile`, `_extensions`, `dlopen`, `binding`, `_linkedBinding`, `ShadowRealm`, `constructor`), `getBuiltinModule`, `Function` in a VALUE position, and the prototype reflection that reaches an evaluator BY VALUE (`getPrototypeOf`, `__proto__`) |
 * | `global` | `globalThis`, `global`, `process` or `module` used other than as the object of a non-computed property access (`process.env`): aliased, passed, spread, destructured, shadowed — and the same for one reached as a non-computed MEMBER of another (`globalThis.process`, `global.globalThis.module`; `CONTROL-2`, closing `CTRL1B-R5-L1`) |
 * | `computed-global` | a COMPUTED member access on one of them, or on a member of one (`process[x]`, `globalThis.process[x]`) — except a read of `process.env[…]` or `process.argv[…]`, which hold strings only |
 * | `import-meta` | `import.meta.glob` / `globEager` |
 * | `unparseable` | a file that does not parse under its extension's grammar |
 *
 * Types are not read: they load nothing.
 *
 * ## What it does not see
 *
 * It is a rule over source text, not a proof about the program. A computed key
 * on an ORDINARY value (`fn[k]` where `k` is built at run time) can still reach
 * a function's constructor, and a value another module exports can be a
 * loader. A member of a global object that is not itself one of the four
 * (`process.mainModule`) can still be aliased and then indexed: its loader is
 * refused where it is NAMED (`require`), not where it is reached by a computed
 * key. Production source is reviewed code; this rule refuses every loading
 * primitive it can NAME, and the shipped bundle's metafile states what the
 * shipped artifact holds.
 */

import { dirname, relative, resolve, sep } from "node:path";

import ts from "typescript";

import { PERMITTED_BUILTINS } from "./load-judge.js";
import { EVALUATOR_CONSTRUCTORS, IMPORT_META_LOADERS, LOADER_NAMES, SPECIFIER_LOADERS, scriptKindFor } from "./module-loads.js";

/** One finding: the rule broken, what broke it, and where. */
export interface DynamicLoadingFinding {
  readonly rule: "specifier" | "non-literal" | "require-form" | "name" | "global" | "computed-global" | "import-meta" | "unparseable";
  readonly text: string;
  /** 1-based line. */
  readonly line: number;
}

/** The global objects a program reaches loaders through by name. */
export const GLOBAL_OBJECTS: readonly string[] = Object.freeze(["globalThis", "global", "process", "module"]);

/** Members of a global object that hold strings only: a computed read of them loads nothing. */
export const DATA_MEMBERS: readonly string[] = Object.freeze(["process.env", "process.argv"]);

/** The names `require` calls go by (the scan's vocabulary: `require`). */
const REQUIRE_NAMES: readonly string[] = [...SPECIFIER_LOADERS].filter(([name, kind]) => name === kind).map(([name]) => name);

/** `getBuiltinModule` (the scan's vocabulary, by the load kind it produces). */
const BUILTIN_LOADERS: readonly string[] = [...SPECIFIER_LOADERS].filter(([, kind]) => kind === "builtin").map(([name]) => name);

/**
 * Names refused wherever they appear in a value position (module header,
 * `name`): the scan's loader vocabulary, the builtin loader, and the prototype
 * reflection that reaches `Function` — or the async and generator function
 * constructors — by value, with no name spelled.
 */
export const REFUSED_NAMES: readonly string[] = Object.freeze([...LOADER_NAMES, ...BUILTIN_LOADERS, "getPrototypeOf", "__proto__"]);

/** Skips the wrappers that leave an expression's value unchanged. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Whether `node` sits where only a type can be (types load nothing). */
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

/**
 * Whether the identifier `node` is a property NAME — of a property access, an
 * object literal or class member, a binding pattern's key — rather than a
 * reference to a variable.
 */
function isPropertyNamePosition(node: ts.Identifier | ts.PrivateIdentifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isQualifiedName(parent)) return parent.right === node;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent)
  ) {
    return parent.name === node;
  }
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  return false;
}

/** The dotted path of a non-computed property-access chain rooted at an identifier (`process.env`), or `undefined`. */
function dottedPath(node: ts.Expression): string | undefined {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    const head = dottedPath(inner.expression);
    return head === undefined ? undefined : `${head}.${inner.name.text}`;
  }
  return undefined;
}

/**
 * Whether `node` evaluates to one of the {@link GLOBAL_OBJECTS} by NAME: the
 * identifier itself, or a NON-COMPUTED member chain every link of which is one
 * of them (`globalThis.process`, `global.globalThis.module`). `CONTROL-2`,
 * closing `CTRL1B-R5-L1`: `const p = globalThis.process; p[k]` and
 * `Reflect.get(globalThis.process, k)` reached `process` through `globalThis`
 * and were never judged as `process`.
 */
function namesGlobalObject(node: ts.Expression): boolean {
  const path = dottedPath(node);
  return path !== undefined && path.split(".").every((segment) => GLOBAL_OBJECTS.includes(segment));
}

/** The identifier a member-access chain is rooted at (`process` in `process.a[b].c`), or `undefined`. */
function chainRoot(node: ts.Expression): string | undefined {
  let current = unwrap(node);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression);
  return ts.isIdentifier(current) ? current.text : undefined;
}

/** What the rule admits for one package: its declared runtime `dependencies`, and its source root. */
export interface ProductionScope {
  readonly dependencies: readonly string[];
  /** The package's `src` directory: a relative specifier must resolve inside it. */
  readonly sourceRoot: string;
  /**
   * `CONTROL-2` r1: the driver shims, by ABSOLUTE file, each with the one
   * builtin it may load — as `node:<builtin>`, from that file only
   * (`driver-shims.ts`). A builtin outside `PERMITTED_BUILTINS` is admitted
   * nowhere else.
   */
  readonly builtinShims?: Readonly<Record<string, string>>;
}

/**
 * Whether `specifier`, loaded from `fileName`, is one the rule admits: a
 * relative path that stays inside the source root, a permitted builtin, or a
 * declared dependency or its subpath.
 */
function admitsSpecifier(specifier: string, fileName: string, scope: ProductionScope): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const inside = relative(scope.sourceRoot, resolve(dirname(fileName), specifier));
    return inside !== "" && !inside.startsWith(`..${sep}`) && inside !== ".." && !inside.startsWith(sep);
  }
  const builtin = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  if ((PERMITTED_BUILTINS as readonly string[]).includes(builtin)) return true;
  const shim = scope.builtinShims !== undefined && Object.hasOwn(scope.builtinShims, fileName) ? scope.builtinShims[fileName] : undefined;
  if (shim !== undefined && specifier === `node:${shim}`) return true;
  return scope.dependencies.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
 * Every finding of the rule in `text` (module header). `fileName` — absolute —
 * selects the grammar by extension and anchors relative specifiers.
 */
export function dynamicLoadingIn(text: string, fileName: string, scope: ProductionScope): readonly DynamicLoadingFinding[] {
  const kind = scriptKindFor(fileName);
  if (kind === "JSON") return [];
  const findings: DynamicLoadingFinding[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (rule: DynamicLoadingFinding["rule"], what: string, node: ts.Node): void => {
    findings.push({ rule, text: what, line: lineOf(node) });
  };

  const diagnostics =
    ts.transpileModule(text, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
    }).diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    findings.push({ rule: "unparseable", text: fileName, line: 1 });
  }

  /** A load's specifier: a string literal the rule admits, or a finding. */
  const judgeSpecifier = (node: ts.Node | undefined, form: string, at: ts.Node): void => {
    if (node === undefined || !ts.isStringLiteralLike(node)) {
      add("non-literal", `${form} with a specifier that is not a string literal`, at);
    } else if (!admitsSpecifier(node.text, fileName, scope)) {
      add("specifier", node.text, at);
    }
  };

  /** The call `node` (an identifier) is the callee of — directly, or as `x.node` — or `undefined`. */
  const calleeCall = (node: ts.Identifier): ts.CallExpression | undefined => {
    let target: ts.Node = node;
    const parent = node.parent as ts.Node | undefined;
    if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node) target = parent;
    while (target.parent !== undefined && ts.isParenthesizedExpression(target.parent)) target = target.parent;
    const call = target.parent as ts.Node | undefined;
    return call !== undefined && ts.isCallExpression(call) && call.expression === target ? call : undefined;
  };

  const visit = (node: ts.Node): void => {
    if (inTypePosition(node)) return;
    // A static load's specifier is judged as a load, not again as a string key.
    if (ts.isImportDeclaration(node)) {
      judgeSpecifier(node.moduleSpecifier, "a static import", node);
      if (node.importClause !== undefined) ts.forEachChild(node.importClause, visit);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      judgeSpecifier(node.moduleSpecifier, "a static re-export", node);
      if (node.exportClause !== undefined) ts.forEachChild(node.exportClause, visit);
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      judgeSpecifier(node.moduleReference.expression, "import x = require()", node);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      judgeSpecifier(node.arguments[0], "import()", node);
      for (const argument of node.arguments.slice(1)) visit(argument);
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      IMPORT_META_LOADERS.includes(node.name.text)
    ) {
      add("import-meta", `import.meta.${node.name.text}`, node);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const root = chainRoot(node.expression);
      const owner = dottedPath(node.expression);
      if (root !== undefined && GLOBAL_OBJECTS.includes(root) && !(owner !== undefined && DATA_MEMBERS.includes(owner))) {
        add("computed-global", `a computed member of ${owner ?? root}`, node);
        // The chain's own identifiers are not judged again as aliases.
        visit(node.argumentExpression);
        return;
      }
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = ts.isPrivateIdentifier(node) ? node.text.slice(1) : node.text;
      if (ts.isIdentifier(node) && REQUIRE_NAMES.includes(name)) {
        const call = calleeCall(node);
        const parent = node.parent as ts.Node | undefined;
        const asProperty = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node;
        const off = asProperty ? dottedPath((parent as ts.PropertyAccessExpression).expression) : undefined;
        if (call !== undefined && call.arguments.length === 1 && (!asProperty || off === "module")) {
          judgeSpecifier(call.arguments[0], "require()", call);
        } else if (call !== undefined && call.arguments.length === 1 && asProperty) {
          add("require-form", `${off ?? "a value"}.${name}(…)`, node);
        } else {
          add("require-form", `${name} other than called with one specifier`, node);
        }
      } else if (REFUSED_NAMES.includes(name)) {
        add("name", name, node);
      } else if (EVALUATOR_CONSTRUCTORS.includes(name)) {
        add("name", name, node);
      } else if (ts.isIdentifier(node) && GLOBAL_OBJECTS.includes(name) && !isPropertyNamePosition(node)) {
        const parent = node.parent as ts.Node | undefined;
        const asObject = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node;
        if (!asObject) add("global", name, node);
      } else if (ts.isIdentifier(node) && GLOBAL_OBJECTS.includes(name)) {
        // `CONTROL-2` (`CTRL1B-R5-L1`): a global object reached as a
        // NON-COMPUTED member of another (`globalThis.process`) is that global
        // object, under the same rule: only as the object of a further
        // non-computed property access.
        const access = node.parent as ts.Node | undefined;
        if (access !== undefined && ts.isPropertyAccessExpression(access) && access.name === node && namesGlobalObject(access)) {
          const outer = access.parent as ts.Node | undefined;
          const asObject = outer !== undefined && ts.isPropertyAccessExpression(outer) && outer.expression === access;
          if (!asObject) add("global", dottedPath(access) ?? name, node);
        }
      }
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      if (REFUSED_NAMES.includes(node.text) || EVALUATOR_CONSTRUCTORS.includes(node.text) || REQUIRE_NAMES.includes(node.text)) {
        add("name", node.text, node);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
