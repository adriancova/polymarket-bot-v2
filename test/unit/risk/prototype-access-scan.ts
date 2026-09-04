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
 * | `element-read` | `o[k]`, `o?.[k]` | `Get` walks the prototype chain |
 * | `element-write` | `o[k] = v` | `Set` walks the chain and invokes an inherited SETTER |
 * | `element-compound` | `o[k] ??= v`, `o[k] += v`, `o[k]++` | a `Get` and a `Set` |
 * | `delete-element` | `delete o[k]` | own-only, but it is how a table is edited |
 * | `in` | `k in o` | answers TRUE for an inherited or a prototype member |
 * | `object-spread` | `{ ...o }` | own-only READ, but it INVOKES own getters and the RESULT inherits `Object.prototype` |
 * | `object-assign` | `Object.assign(t, o)` | same, plus it invokes inherited setters on the target |
 * | `object-destructure` | `const { v } = o`, `function f({ v })`, `({ v } = o)` | one `Get` per name: the chain, and any getter |
 * | `for-in` | `for (const k in o)` | ENUMERATES inherited enumerable names |
 * | `reflect-chain` | `Reflect.get/set/has/getPrototypeOf/setPrototypeOf` | the chain by construction (and any unrecognized `Reflect` member) |
 * | `object-entries` | `Object.entries(o)`, `Object.values(o)` | own-only, but it INVOKES every own getter |
 * | `structured-clone` | `structuredClone(o)` | invokes own getters, and the clone inherits `Object.prototype` |
 * | `own-enumeration` | `Object.keys`, `Object.getOwnPropertyNames`, `Object.getOwnPropertySymbols`, `Reflect.ownKeys` | own-only names, no getter — safe, enumerated so the census is total |
 * | `computed-key` | `{ [k]: v }` | `CreateDataProperty` — safe, enumerated so the census is total |
 * | `prototype-read` | `Object.getPrototypeOf(o)` | READS the chain — safe only where the answer is used to REFUSE or to classify |
 * | `prototype-write` | `Object.setPrototypeOf(o, p)`, `Object.create(p)` | ESTABLISHES the chain: `Object.create(null)` removes it, any other argument installs one |
 * | `object-from-entries` | `Object.fromEntries(xs)` | iterates its argument AND returns an ORDINARY object, so the result inherits `Object.prototype` |
 * | `object-unclassified` | any other `Object.*` call | FAIL CLOSED: an `Object` member this table does not name becomes a named finding, never silence (review round 8) |
 * | `with-statement` | `with (o) { … }` | resolves EVERY bare identifier in its body against `o`'s prototype chain |
 *
 * The census is the input to a test that requires EVERY site to be either an
 * own-property primitive or an explicitly registered exception carrying a
 * reason. Nothing is classified by being unnoticed.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — THE COMPLETE LIST OF WHAT THIS DETECTOR DOES NOT SEE (round 7)
 * ---------------------------------------------------------------------------
 *
 * Round 6 stated the boundary as "not a plain dotted read". Review round 7
 * measured the boundary instead of reading it, and found it under-stated: four
 * further forms — destructuring, `Reflect.get`, `for…in` and `structuredClone` —
 * were SILENT, so the primary build mechanism would have accepted any of them as
 * a future regression WITHOUT classifying it. All four are detected above now.
 * What remains excluded is listed here IN FULL, each with the reason and with
 * the mechanism that covers it instead; an under-stated boundary is the finding
 * this list exists to prevent recurring.
 *
 * 1. **DOTTED PROPERTY ACCESS, IN BOTH DIRECTIONS** — a READ
 *    (`caps.liveMicroMaxOrderNotional`) and a WRITE (`lot.committedCost = …`).
 *    A read consults the prototype; a WRITE consults it too, and invokes an
 *    inherited SETTER if it finds one (review round 8 corrected this item, which
 *    named only the read). Every field access in both packages is one of these,
 *    so a syntactic rule over them would be noise rather than a gate. Covered
 *    BEHAVIOURALLY by `inherited-state.test.ts`, which augments
 *    `Object.prototype` with each name these packages actually use — including,
 *    since round 8, every PROPERTY-DESCRIPTOR ATTRIBUTE name — and requires
 *    every public answer to be unchanged. That is what caught the caps-fence
 *    hole no syntactic rule would have flagged. Every dotted write in these
 *    packages is onto an object the package itself built in the same function
 *    (a lot accumulator, an exposure entry, a `null`-prototype descriptor, the
 *    arena's own schema copy); a syntactic gate for them is recorded as a
 *    follow-up rather than claimed here.
 * 2. **PER-PROPERTY OWN PREDICATES, DESCRIPTOR READS AND INTEGRITY
 *    PRIMITIVES** — the `Object` members named in {@link OBJECT_SILENT_MEMBERS}
 *    (`hasOwn`, `getOwnPropertyDescriptor(s)`, `defineProperty`/`defineProperties`,
 *    `freeze`/`isFrozen`, `seal`/`isSealed`, `preventExtensions`/`isExtensible`,
 *    `is`), plus `Reflect.getOwnPropertyDescriptor` and `Reflect.defineProperty`.
 *    They are own-only, they invoke no accessor, and they are the very
 *    primitives this review chain prescribes; flagging thirty of them would
 *    drown the table. The list is now EXPLICIT and the detector FAILS CLOSED
 *    around it: any other `Object` member is reported as `object-unclassified`
 *    (review round 8 — the previous version returned `undefined` for an
 *    unrecognized member, so the detector itself failed open, which is the same
 *    class of defect this mechanism exists to prevent).
 *    (`Reflect.*` is nonetheless classified above, so only the `Object.*` forms
 *    are excluded here.)
 * 3. **THE ITERATION PROTOCOL** — `for…of`, array destructuring (`const [a] =
 *    xs`), array spread (`[...xs]`, `f(...xs)`), `yield*`. Each resolves
 *    `Symbol.iterator` on an intrinsic PROTOTYPE, which is round 5's stated
 *    assumption (`plain-data.ts`, proposition 1: the intrinsics are genuine),
 *    not the caller-supplied-value threat model. A caller-supplied value never
 *    reaches one of these before being materialized, and a materialized record
 *    is an array or a prototype-FREE object, which has no `Symbol.iterator` to
 *    inherit.
 * 4. **CALL-SITE AND DATA-FLOW REASONING.** A helper that receives an object and
 *    reads `o[k]` is flagged AT THE HELPER, once; the census says nothing about
 *    what its callers pass, and no site is exonerated by an argument about its
 *    callers. This is a limitation of a syntactic census and is why every
 *    registration carries a reason about the VALUE, not about the syntax.
 * 5. **IMPLICIT COERCION** — `String(o)`, `` `${o}` ``, `o == x`, `+o`,
 *    `JSON.stringify(o)`. Each can invoke an inherited `toString`, `valueOf`,
 *    `@@toPrimitive` or `toJSON`. Round 5's escape was exactly this
 *    (`String(reported)` on a hostile `length`), and the answer was structural
 *    rather than syntactic: `describeValue` never coerces a caller-derived
 *    value, and every public door runs inside a containment guard.
 * 6. **DYNAMIC EVALUATION** — `eval`, `new Function`, dynamic `import()` of a
 *    computed specifier. None appears in either package; the repository-wide
 *    `check:deps` scanner is the mechanism that reports them.
 * 7. **CLASS SYNTAX** — `super.x`, `extends`, `instanceof`. Neither package
 *    declares a class or uses `instanceof`; every object either is a literal,
 *    is materialized with a `null` prototype, or comes from a library.
 *    (`Object.create` is NO LONGER excluded here — review round 8 classifies it
 *    as `prototype-write`, because `Object.create(null)` and `Object.create(p)`
 *    differ by exactly the thing this census is about, and a registration makes
 *    which one it is visible.)
 * 8. **INDIRECTION AROUND A STATIC MEMBER CALL** (review round 9, stated after
 *    the reviewer measured both forms passing the census). The `Object.*` /
 *    `Reflect.*` classification matches one callee shape — an IDENTIFIER named
 *    `Object` or `Reflect`, a dot, a member, a CALL — so two forms evade it:
 *    - **alias capture**: `const zz = Object.getPrototypeOf;` binds the
 *      function without calling it, and the later `zz(o)` call has no `Object`
 *      in its callee. This is item 1's territory (a dotted READ of a member),
 *      but it deserves its own naming because the captured member is one the
 *      table would have CLASSIFIED at a direct call site;
 *    - **a cast in the callee**: `(Object as unknown as { groupBy… }).groupBy(…)`
 *      wraps the identifier in a parenthesized `as`-expression, so
 *      `staticMemberCall` does not see `Object` and the fail-closed
 *      `object-unclassified` default never fires.
 *    The census is a guard against ACCIDENT — an unclassified member arriving
 *    in ordinary code — not against a author writing indirection to defeat it;
 *    that author also has to get the alias or the cast past `pnpm lint`,
 *    `pnpm typecheck` and an adversarial review that has now named both forms.
 *    Neither form appears in either package today, and a detector upgrade
 *    (resolving aliases and unwrapping casts) is recorded as a follow-up in
 *    `docs/handoffs/WP-180.md` rather than claimed here.
 * `with (o) { … }` is NOT an exclusion — review round 8 noted it was absent
 * from a list that called itself complete, and it is now DETECTED
 * (`with-statement`, above) rather than argued about. It is also independently
 * rejected by TypeScript, with diagnostics 1101 ("`with` statements are not
 * allowed in strict mode") and 2410 — but round 8 MEASURED where: both are
 * SEMANTIC diagnostics, so `censusOfPrototypeAccess`'s syntactic-only guard
 * would NOT have caught one, and `pnpm typecheck` is the gate that would.
 * {@link diagnosticsOfSourceText} lets `prototype-access.test.ts` assert that
 * second gate as a measurement instead of a claim.
 * CORRECTED (review round 9, 2026-09-04): round 8's framing had the layers in
 * the wrong order. The reviewer measured that a `// @ts-expect-error` comment
 * suppresses BOTH diagnostics — `pnpm typecheck` exits 0 — and that `pnpm lint`
 * stays clean too, while the census's `with-statement` DETECTOR still fails
 * closed naming the site. The detector, not the type checker, is the layer
 * that survives suppression comments; the round-8 sentences above are kept
 * as written so the correction is visible rather than silent.
 *
 * Items 1–8 are the WHOLE of the exclusion. A form not listed here and not in
 * the table above is an omission, and `prototype-access.test.ts` probes each
 * detected form AND each excluded form so this list is exercised rather than
 * merely written.
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
  | "object-destructure"
  | "for-in"
  | "reflect-chain"
  | "object-entries"
  | "structured-clone"
  | "own-enumeration"
  | "computed-key"
  | "prototype-read"
  | "prototype-write"
  | "object-from-entries"
  | "object-unclassified"
  | "with-statement";

/** Every kind, so a test can prove the vocabulary is closed and exercised. */
export const ACCESS_KINDS: readonly AccessKind[] = [
  "element-read",
  "element-write",
  "element-compound",
  "delete-element",
  "in",
  "object-spread",
  "object-assign",
  "object-destructure",
  "for-in",
  "reflect-chain",
  "object-entries",
  "structured-clone",
  "own-enumeration",
  "computed-key",
  "prototype-read",
  "prototype-write",
  "object-from-entries",
  "object-unclassified",
  "with-statement",
];

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

/**
 * The `Object.*` / `Reflect.*` members whose CALL is a census site, by kind.
 *
 * BOTH ARE NOW CLASSIFIED IN FULL, AND BOTH FAIL CLOSED (review round 8). A
 * `Reflect` member not named below is reported as `reflect-chain`; an `Object`
 * member named neither here nor in {@link OBJECT_SILENT_MEMBERS} is reported as
 * `object-unclassified`. The previous version returned `undefined` for an
 * unrecognized `Object` member, so `Object.getPrototypeOf`,
 * `Object.setPrototypeOf` and `Object.fromEntries` were all SILENT — the
 * reviewer's mutation added exported `getPrototypeOf`/`setPrototypeOf` calls to a
 * product source and the census's "every site is registered" test still passed.
 * A detector that fails open is the defect it exists to prevent.
 */
const OBJECT_MEMBER_KINDS: ReadonlyMap<string, AccessKind> = new Map<string, AccessKind>([
  ["assign", "object-assign"],
  ["entries", "object-entries"],
  ["values", "object-entries"],
  ["keys", "own-enumeration"],
  ["getOwnPropertyNames", "own-enumeration"],
  ["getOwnPropertySymbols", "own-enumeration"],
  ["getPrototypeOf", "prototype-read"],
  ["setPrototypeOf", "prototype-write"],
  ["create", "prototype-write"],
  ["fromEntries", "object-from-entries"],
]);

/**
 * The `Object.*` members that are deliberately SILENT — scope item 2.
 *
 * Every one is own-only and accessor-free: a per-property predicate, a
 * descriptor read or write, or an integrity operation. They are the primitives
 * this review chain prescribes, and reporting thirty of them would drown the
 * registration table in the forms that are the ANSWER rather than the risk.
 *
 * The set is EXPLICIT so the fail-closed default has something to be closed
 * against: `Object.groupBy`, `Object.entries`' future cousins, or anything a
 * later ECMAScript adds is a named finding until somebody classifies it.
 */
const OBJECT_SILENT_MEMBERS: ReadonlySet<string> = new Set([
  "hasOwn",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "defineProperty",
  "defineProperties",
  "freeze",
  "isFrozen",
  "seal",
  "isSealed",
  "preventExtensions",
  "isExtensible",
  "is",
]);

const REFLECT_OWN_MEMBERS: ReadonlySet<string> = new Set([
  "ownKeys",
  "getOwnPropertyDescriptor",
  "defineProperty",
  "deleteProperty",
  "isExtensible",
  "preventExtensions",
  "apply",
  "construct",
]);

/** `X.member(…)` → the member name, when the callee is exactly that shape. */
function staticMemberCall(node: ts.CallExpression, objectName: string): string | undefined {
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === objectName
  ) {
    return callee.name.text;
  }
  return undefined;
}

/** The census kind of a CALL expression, or `undefined` if it is not a site. */
function callKind(node: ts.CallExpression): AccessKind | undefined {
  const objectMember = staticMemberCall(node, "Object");
  if (objectMember !== undefined) {
    const kind = OBJECT_MEMBER_KINDS.get(objectMember);
    if (kind !== undefined) return kind;
    // FAIL CLOSED (review round 8): an `Object` member that is neither
    // classified above nor explicitly silent becomes a NAMED finding.
    return OBJECT_SILENT_MEMBERS.has(objectMember) ? undefined : "object-unclassified";
  }
  const reflectMember = staticMemberCall(node, "Reflect");
  if (reflectMember !== undefined) {
    if (reflectMember === "ownKeys") return "own-enumeration";
    // FAIL CLOSED: anything not on the own-only list is the chain-walking kind.
    return REFLECT_OWN_MEMBERS.has(reflectMember) ? "own-enumeration" : "reflect-chain";
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "structuredClone") {
    return "structured-clone";
  }
  return undefined;
}

/**
 * An object destructuring ASSIGNMENT (`({ a } = o)`), which has no binding
 * pattern node — the left side is parsed as an object LITERAL.
 */
function isDestructuringAssignment(node: ts.BinaryExpression): boolean {
  return (
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isObjectLiteralExpression(node.left)
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
    } else if (ts.isBinaryExpression(node) && isDestructuringAssignment(node)) {
      push(node, "object-destructure");
    } else if (ts.isObjectBindingPattern(node)) push(node, "object-destructure");
    else if (ts.isForInStatement(node)) push(node, "for-in");
    else if (ts.isWithStatement(node)) push(node, "with-statement");
    else if (ts.isSpreadAssignment(node)) push(node, "object-spread");
    else if (ts.isCallExpression(node)) {
      const kind = callKind(node);
      if (kind !== undefined) push(node, kind);
    } else if (
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

/**
 * The COMPILER's diagnostic codes for one source TEXT — the gate behind scope
 * item 8 (review round 8).
 *
 * `with (o) { … }` is the one prototype-consuming construct this census does not
 * classify, because it is independently unavailable: TypeScript reports 1101 and
 * 2410 for it, and {@link censusOfPrototypeAccess} throws on any SYNTACTIC
 * diagnostic in a scanned file. A test can therefore assert the gate rather than
 * assert a claim about it.
 *
 * The program is built over a virtual file so nothing is written to disk; the
 * two diagnostic lists are returned separately because `with`'s grammar error is
 * syntactic (the one the census refuses on) while its typing error is semantic.
 */
export function diagnosticsOfSourceText(
  text: string,
  fileName = "with-probe.ts",
): { readonly syntactic: readonly number[]; readonly semantic: readonly number[] } {
  const filePath = resolve(REPO_ROOT, fileName);
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (requested) => (requested === filePath ? source : undefined),
    writeFile: () => undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => "\n",
    fileExists: (requested) => requested === filePath,
    readFile: (requested) => (requested === filePath ? text : undefined),
  };
  const program = ts.createProgram([filePath], options, host);
  return {
    syntactic: program.getSyntacticDiagnostics(source).map((diagnostic) => diagnostic.code),
    semantic: program.getSemanticDiagnostics(source).map((diagnostic) => diagnostic.code),
  };
}

/** One `X.safeParse(…)` call in a scanned file, with the receiver's text. */
export interface SchemaParseSite {
  readonly file: string;
  readonly line: number;
  /** The text to the left of `.safeParse` — the schema being asked. */
  readonly receiver: string;
  readonly enclosing: string;
}

/**
 * Every `x.safeParse(…)` call in the product sources of both packages.
 *
 * THE ROUND-8 PIN. The fix for the round-8 BLOCKER is that a door asks a
 * PARSING COPY of its schema (`schema-arena.ts`) rather than the schema itself,
 * and "every door does that" is a property a reviewer should not have to check
 * by reading. This resolves it from the syntax tree, so a new door — or a door
 * that quietly goes back to the raw schema — is a failure with a file and a line.
 */
export function schemaParseSites(): readonly SchemaParseSite[] {
  const sites: SchemaParseSite[] = [];
  for (const file of scannedFiles()) {
    const repoRelative = relative(REPO_ROOT, file).split("\\").join("/");
    if (repoRelative.endsWith(".test.ts")) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2023,
      true,
      ts.ScriptKind.TS,
    );
    const ancestors: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "safeParse" || node.expression.name.text === "parse")
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        sites.push({
          file: repoRelative,
          line: line + 1,
          receiver: collapse(node.expression.expression.getText(source)),
          enclosing: enclosingName(ancestors),
        });
      }
      ancestors.push(node);
      ts.forEachChild(node, visit);
      ancestors.pop();
    };
    ts.forEachChild(source, visit);
  }
  return sites;
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
