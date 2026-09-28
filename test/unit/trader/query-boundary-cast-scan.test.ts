/**
 * `TRDR-2` — a syntax-tree census of every TYPE ASSERTION in `apps/trader`'s
 * production source, and a fail-closed rule for the shapes that disable a check
 * the compiler would otherwise have made.
 *
 * ## The lesson this encodes
 *
 * `GOV-2B` blocker **B1** was one cast. `apps/trader/src/adapters/postgres-store.ts`
 * bound `toPnlSnapshotRow`'s camelCase record into the snake_case
 * `accounting.pnl_snapshots` behind `.values(row as never)`, and the emitted
 * SQL named eighteen columns that do not exist — a defect that would have
 * GLOBAL-halted the durable trader on its first fill. The mapping was wrong,
 * but the mapping is not why it SHIPPED: it shipped because `as never` told
 * the compiler not to look at an insert it would otherwise have rejected
 * outright, in a file whose own header called itself "typecheck-pinned". The
 * closeout's finding is therefore about the CAST CLASS, not that one line, and
 * a rule nobody can regress is the only form of that finding worth having.
 *
 * ## Two ORTHOGONAL axes, because one of them used to swallow the other
 *
 * Every assertion is measured twice, and B1's own line is the reason:
 *
 * | axis | values | rule |
 * | --- | --- | --- |
 * | RELATIONSHIP — what the assertion does to the type | `laundering` (`x as never`, `x as any`, `x as unknown as T`), `const`, `widening` (`x as unknown`), `other` | `laundering` is FORBIDDEN unless {@link REGISTERED}; the rest are counted |
 * | POSITION — where it sits | at a query boundary, or not | at a query boundary EVERY assertion is FORBIDDEN, `as const` included: the one place a typed SQL builder checks a binding is the one place a cast must never appear |
 *
 * The first round of this file made POSITION a fifth value of RELATIONSHIP,
 * decided in one `if`/`else` chain in which `laundering` came first — so
 * `.values(row as never)`, B1's literal shape, classified as `laundering` and
 * the test named *"has NO assertion inside a Kysely builder chain"* never fired
 * on it. The adversarial review measured exactly that: with the unfixed adapter
 * restored, the query-boundary test PASSED. The rule was being carried by the
 * other two tests, and the one named for the finding was decorative. The two
 * axes are now recorded independently, so B1's line fails BOTH.
 *
 * `other` is counted rather than banned because banning it would be a claim
 * this round cannot honestly make about twenty-five sites in files it does not
 * own — and because a rule that forces `@ts-expect-error` to get work done buys
 * nothing. Measured at `TRDR-2`'s commit: 27 production modules, 34 outermost
 * assertions, spread over 12 files. One was REGISTERED (`main.ts:292`), so the
 * remaining **33** were 25 `other`, 7 `as const` and 1 `as unknown` widening;
 * none `never` or `any`, and none at a query boundary. (The commit message of
 * the first round said "the remaining 27", which was the module count reused
 * by mistake; 34 − 1 = 33.) `BOOT-1` then DELETED the registered cast while
 * factoring `main.ts`'s assembly — `venue` is handed to `createPaperTrader`
 * uncast and `pnpm typecheck` exits 0, confirming TRDR-2's measurement — and
 * added `adapters/postgres-registration.ts` with no assertion at all, so the
 * registry is EMPTY and every laundering assertion in `apps/trader` is now
 * simply forbidden.
 *
 * ## Two evasions the adversarial review reproduced, and what closes them
 *
 * Both were live against the first round of this file:
 *
 * 1. **An alias.** `type X = never; row as X` laundered exactly as `as never`
 *    does, because the classifier compared `node.type.getText()` to the literal
 *    string `"never"`. Local aliases are now EXPANDED — transitively, and
 *    through a generic's name — before either comparison.
 * 2. **A staged builder.** `const b = db.insertInto("t"); b.values(row as T)`
 *    escaped the position axis, because the walk up the ancestors looked for a
 *    chain ROOTED at `insertInto` and the staged call's root is a plain
 *    identifier. An assertion inside an ARGUMENT to `.values(…)` or `.set(…)`
 *    is now a query boundary however the builder was obtained.
 *
 * The last `describe` block drives the scanner over synthetic sources carrying
 * each shape, so these closures are asserted rather than asserted ABOUT. That
 * block is the only place in this repository where B1's exact line still
 * exists — as a string, never as code.
 *
 * ## What it still does NOT see, stated in full
 *
 * This is a SYNTAX scan (`ts.createSourceFile`, no `ts.Program`, no
 * `TypeChecker`), the same choice `test/unit/risk/prototype-access-scan.ts`
 * made, and the honest boundary of that choice is:
 *
 * - an alias IMPORTED from another module (`import type { X } from "./x.js"`,
 *   `x as X`): the alias table is per-file, and following the import needs a
 *   `TypeChecker`. Closing this is the one open item that genuinely requires
 *   `ts.Program`. (A PARENTHESIZED alias — `type X = (never)` — used to evade
 *   the census the same way, and `eslint` and `tsc` alike, because the
 *   resolver compared the text `(never)` to `never`; `TRDR-2` residual R8,
 *   closed by `BOOT-1`: balanced surrounding parentheses are stripped before
 *   every comparison, and a self-test below pins it);
 * - an alias whose right-hand side must be EVALUATED to reach `never`
 *   (`type X<T> = T extends string ? never : T`) — likewise checker-only;
 * - an assertion bound to a variable first (`const bound = row as Wrong;
 *   builder.values(bound)`): the assertion is not inside the `.values`
 *   argument, so the POSITION axis misses it. It is still caught by the
 *   RELATIONSHIP axis whenever the target is `never`/`any`/a double assertion —
 *   B1's own shape — but a cast to a concrete wrong type would escape. The last
 *   test in this file pins that hole so it cannot be forgotten;
 * - a builder passed to another function that calls `.values` there;
 * - `.values(…)`/`.set(…)` on a receiver that is not a query builder at all,
 *   which is counted AS a query boundary. That is a deliberate false positive:
 *   the rule fails closed, and `apps/trader` has no such call today;
 * - an unchecked `any` arriving from an untyped dependency (no cast is written,
 *   so there is nothing to find); a generic whose constraint is `any`; a
 *   structural mismatch two compatible types share; and `unknown` narrowed by a
 *   hand-written type PREDICATE, which is a cast the compiler cannot
 *   distinguish from a real check. The last of those is the nearest live gap
 *   and has no cheap mechanical answer.
 *
 * ## Scope
 *
 * PRODUCTION source only (`*.test.ts` excluded). A test's `as unknown as T` is
 * usually the point — handing a door a value its TYPE forbids is how this
 * repository tests hostile input (`apps/trader/src/halt.test.ts:94`'s
 * `false as unknown as true`) — so scanning tests would either ban that or
 * dilute the rule into an ignore list.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRADER_SRC = join(REPO_ROOT, "apps", "trader", "src");
const CORE_SRC = join(REPO_ROOT, "packages", "trading-core", "src");
const rootOf = (file: string): string => (file.startsWith(CORE_SRC + sep) ? CORE_SRC : TRADER_SRC);

/** Kysely chain roots: an assertion under one of these is at a query boundary. */
const QUERY_ROOTS = new Set(["insertInto", "updateTable", "deleteFrom", "selectFrom"]);

/**
 * Builder methods whose ARGUMENT is a binding. An assertion inside one is at a
 * query boundary however the builder reached that call — which is what makes a
 * staged chain (`const b = db.insertInto(…); b.values(row as never)`) fail.
 */
const BINDING_METHODS = new Set(["values", "set"]);

/** The three type texts that erase a relationship rather than narrow it. */
const ERASING_TARGETS = new Set(["never", "any", "unknown"]);

/**
 * Sites that are permitted DESPITE the rule, each with the measurement that
 * justifies it. A registered site that no longer exists FAILS this suite, so
 * the registry cannot outlive the thing it excuses.
 */
const REGISTERED: readonly {
  readonly file: string;
  readonly text: string;
  readonly reason: string;
}[] = [
  // EMPTY since `BOOT-1`. The one entry this held — `main.ts:292`,
  // `venue as unknown as Parameters<typeof createPaperTrader>[0]["venue"]`,
  // registered by `TRDR-2` with the measurement that `venue: venue` typechecks
  // clean and the instruction "Delete the cast, delete this entry" — was
  // deleted when `BOOT-1` factored that call into `assembleDurableTrader`.
  // The shape of an entry (file, text, reason ≥ 80 chars) and the rule that a
  // stale entry FAILS the suite are unchanged; a future entry pays the same
  // price of a measurement.
];

interface Assertion {
  readonly file: string;
  readonly line: number;
  /** The type text as WRITTEN, before any alias is expanded. */
  readonly target: string;
  readonly text: string;
  /** The RELATIONSHIP axis. */
  readonly classification: "laundering" | "const" | "widening" | "other";
  /** The POSITION axis: why this sits at a query boundary, or `null`. */
  readonly queryBoundary: string | null;
}

function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Every method name in the call chain `node` belongs to, innermost first. */
function chainMethodNames(node: ts.Node): readonly string[] {
  const names: string[] = [];
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isCallExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      names.push(current.name.text);
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return names;
}

/** `type X = never` declarations in one file, by name, at any nesting depth. */
function typeAliases(sf: ts.SourceFile): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) {
      aliases.set(node.name.text, node.type.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return aliases;
}

/**
 * The type text with local aliases expanded, so `type X = never; v as X` reads
 * as `never`. Transitive (`type A = never; type B = A`), cycle-safe, and a
 * generic reference resolves through its NAME (`X<Foo>` → the alias `X`), which
 * is as far as a syntax scan can go: an imported or computed alias needs a
 * `TypeChecker` and is listed in this file's header as open.
 */
function resolveTypeText(text: string, aliases: ReadonlyMap<string, string>): string {
  let current = unparenthesized(text);
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (ERASING_TARGETS.has(current)) {
      return current;
    }
    const name = (current.split("<")[0] ?? current).trim();
    const next = aliases.get(name);
    if (next === undefined) {
      return current;
    }
    current = unparenthesized(next);
  }
  return current;
}

/**
 * `(never)` reads as `never` (`TRDR-2` R8, closed by `BOOT-1`): balanced
 * surrounding parentheses are stripped, repeatedly, before any comparison.
 * Only a pair that encloses the WHOLE text is removed — `(A) | (B)` keeps both.
 */
function unparenthesized(text: string): string {
  let current = text.trim();
  while (current.startsWith("(") && current.endsWith(")") && enclosesWhole(current)) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function enclosesWhole(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    if (text[index] === ")") {
      depth -= 1;
      if (depth === 0 && index < text.length - 1) return false;
    }
  }
  return depth === 0;
}

/** The RELATIONSHIP axis. */
function classify(
  node: ts.AsExpression | ts.TypeAssertion,
  sf: ts.SourceFile,
  aliases: ReadonlyMap<string, string>,
): Assertion["classification"] {
  const target = resolveTypeText(node.type.getText(sf), aliases);
  if (target === "const") return "const";

  const inner = node.expression;
  const innerTarget =
    ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)
      ? resolveTypeText(inner.type.getText(sf), aliases)
      : undefined;
  const launderedThrough = innerTarget === "unknown" || innerTarget === "any";
  if (launderedThrough || target === "never" || target === "any") return "laundering";

  if (target === "unknown") return "widening";
  return "other";
}

/**
 * The POSITION axis: the reason this assertion sits at a query boundary, or
 * `null`. Two shapes count, and the second is what a staged builder needs.
 */
function queryBoundary(node: ts.Node): string | null {
  let child: ts.Node = node;
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor !== undefined) {
    if (ts.isCallExpression(ancestor)) {
      const callee = ancestor.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        BINDING_METHODS.has(callee.name.text) &&
        ancestor.arguments.some((argument) => argument === child)
      ) {
        return `argument of .${callee.name.text}()`;
      }
      const root = chainMethodNames(ancestor).find((name) => QUERY_ROOTS.has(name));
      if (root !== undefined) {
        return `inside a chain rooted at .${root}()`;
      }
    }
    child = ancestor;
    ancestor = ancestor.parent;
  }
  return null;
}

/** The census of one source, by TEXT, so synthetic shapes can be scanned too. */
function scanSource(label: string, text: string): readonly Assertion[] {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const aliases = typeAliases(sf);
  const found: Assertion[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const parent = node.parent;
      const isInnerHalfOfADoubleAssertion =
        (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) &&
        parent.expression === node;
      if (!isInnerHalfOfADoubleAssertion) {
        found.push({
          file: label,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          target: node.type.getText(sf),
          text: node.getText(sf).replace(/\s+/gu, " "),
          classification: classify(node, sf, aliases),
          queryBoundary: queryBoundary(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const FILES = [...sourceFiles(TRADER_SRC), ...sourceFiles(CORE_SRC)];

const ASSERTIONS: readonly Assertion[] = FILES.flatMap((file) =>
  scanSource(relative(rootOf(file), file).split(sep).join("/"), readFileSync(file, "utf8")),
);

/** Text of the `@ts-` and `eslint-disable` escape hatches, per file. */
const SUPPRESSION_COMMENTS: readonly { readonly file: string; readonly line: number; readonly text: string }[] =
  FILES.flatMap((file) => {
    const relativePath = relative(rootOf(file), file).split(sep).join("/");
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        /@ts-(?:expect-error|ignore|nocheck)|eslint-disable/u.test(line)
          ? [{ file: relativePath, line: index + 1, text: line.trim() }]
          : [],
      );
  });

function render(entries: readonly Assertion[]): readonly string[] {
  return entries.map((entry) => `${entry.file}:${String(entry.line)} ${entry.text}`);
}

describe("the scan reaches the source it claims to (fail closed)", () => {
  it("parses apps/trader's production modules, the adapters among them", () => {
    // A scan that silently found nothing would pass every rule below.
    expect(FILES.length).toBeGreaterThanOrEqual(20);
    const names = FILES.map((file) => relative(rootOf(file), file).split(sep).join("/"));
    expect(names).toContain("adapters/postgres-store.ts");
    expect(names).toContain("adapters/redis-feed.ts");
    expect(names).toContain("loop.ts");
    expect(names).toContain("main.ts");
    // And it really did parse them: the census is non-empty, and it found the
    // `as const`s that are known to be there.
    expect(ASSERTIONS.length).toBeGreaterThan(0);
    expect(ASSERTIONS.filter((entry) => entry.classification === "const").length).toBeGreaterThan(0);
  });

  it("gives every assertion exactly one relationship class", () => {
    // The taxonomy is TOTAL: an assertion that fell through it would be
    // silently exempt from every rule below.
    const counted = (["laundering", "const", "widening", "other"] as const).reduce(
      (total, name) => total + ASSERTIONS.filter((entry) => entry.classification === name).length,
      0,
    );
    expect(counted).toBe(ASSERTIONS.length);
  });
});

describe("no cast disables a check at a query boundary in apps/trader (GOV-2B B1)", () => {
  it("has NO assertion of any kind in apps/trader/src/adapters/**", () => {
    // The strongest form of the rule, stated where TRDR-2 owns the files: the
    // two adapters bind ports and tables, and every one of those bindings is
    // now checked by the compiler. `postgres-store.ts` held the only one.
    expect(render(ASSERTIONS.filter((entry) => entry.file.startsWith("adapters/")))).toEqual([]);
  });

  it("binds `accounting.pnl_snapshots` with no cast — B1's own line", () => {
    const adapter = readFileSync(join(TRADER_SRC, "adapters", "postgres-store.ts"), "utf8");
    expect(adapter).toContain('.insertInto("accounting.pnl_snapshots")');
    // The twenty snake_case columns are named literally, as the two sibling
    // inserts in the same file already were.
    for (const column of ["account_ref", "gross_trading_pnl", "as_of", "capital_committed"]) {
      expect(adapter).toContain(`${column}: row.`);
    }
    // That the `as never` is GONE is asserted from the syntax tree above, not
    // from this text: the method's doc comment quotes the old cast and the old
    // SQL on purpose, so that the defect is legible where it happened — and a
    // text rule would read that prose as the defect. This is the same reason
    // the census is an AST walk. (The first draft of this file did use
    // `not.toContain("as never")`, and the comment tripped it.)
    const inAdapter = ASSERTIONS.filter((entry) => entry.file === "adapters/postgres-store.ts");
    expect(render(inAdapter)).toEqual([]);
  });

  it("has NO assertion at a query boundary, anywhere in apps/trader", () => {
    // The POSITION axis, independent of the relationship one — so B1's
    // `.values(row as never)` fails HERE as well as in the laundering test.
    // The last describe in this file proves that on B1's literal shape.
    expect(
      ASSERTIONS.filter((entry) => entry.queryBoundary !== null).map(
        (entry) =>
          `${entry.file}:${String(entry.line)} ${entry.text} (${String(entry.queryBoundary)})`,
      ),
    ).toEqual([]);
  });

  it("launders no value through `never`, `any`, or a double assertion", () => {
    const laundering = ASSERTIONS.filter((entry) => entry.classification === "laundering");
    const unregistered = laundering.filter(
      (entry) =>
        !REGISTERED.some(
          (exception) => exception.file === entry.file && entry.text.includes(exception.text),
        ),
    );
    expect(render(unregistered)).toEqual([]);
  });

  it("keeps the exception registry exact — a stale entry is a failure", () => {
    for (const exception of REGISTERED) {
      const matches = ASSERTIONS.filter(
        (entry) => entry.file === exception.file && entry.text.includes(exception.text),
      );
      expect(`${exception.file}: ${String(matches.length)}`).toBe(`${exception.file}: 1`);
      expect(exception.reason.length).toBeGreaterThan(80);
    }
    // No site is excused today (`BOOT-1` deleted the last one). A new entry
    // changes this number and must carry its measurement.
    expect(REGISTERED).toHaveLength(0);
  });

  it("uses no `@ts-expect-error`, `@ts-ignore` or `eslint-disable` to get past the compiler", () => {
    expect(
      SUPPRESSION_COMMENTS.map((entry) => `${entry.file}:${String(entry.line)} ${entry.text}`),
    ).toEqual([]);
  });
});

/**
 * The scanner, driven over the shapes it is supposed to catch.
 *
 * A guard is worth exactly what its detector is worth, and the first round of
 * this file shipped a detector with holes the adversarial review walked
 * straight through. Each is a case here: the synthetic source IS the evasion,
 * and the assertion is that the census reports it. These sources are strings,
 * never files, so nothing below is compiled, linted, or read by the census
 * above (which walks `apps/trader/src` only).
 */
describe("the census itself is not evadable (TRDR-2 r1)", () => {
  const only = (source: string): Assertion => {
    const found = scanSource("synthetic.ts", source);
    expect(found).toHaveLength(1);
    const entry = found[0];
    if (entry === undefined) throw new Error("the scan found nothing");
    return entry;
  };

  it("reports B1's literal line on BOTH axes", () => {
    const entry = only(`
      declare const db: KyselyLike;
      declare const row: SnapshotRow;
      export async function write(): Promise<void> {
        await db.insertInto("accounting.pnl_snapshots").values(row as never).execute();
      }
    `);
    // The first round classified this as `laundering` ONLY, and the test named
    // for the query boundary therefore passed against the unfixed adapter.
    expect(entry.classification).toBe("laundering");
    expect(entry.queryBoundary).toBe("argument of .values()");
  });

  it("sees through a local alias of `never` (evasion 1)", () => {
    const entry = only(`
      type Whatever = never;
      declare const row: SnapshotRow;
      export function bind(): Whatever {
        return row as Whatever;
      }
    `);
    expect(entry.target).toBe("Whatever");
    expect(entry.classification).toBe("laundering");
  });

  it("sees through a CHAIN of aliases, and through an alias of `any`", () => {
    const chained = only(`
      type A = never;
      type B = A;
      type C = B;
      declare const row: SnapshotRow;
      export const bound = row as C;
    `);
    expect(chained.classification).toBe("laundering");

    const loose = only(`
      type Loose = any;
      declare const row: SnapshotRow;
      export const bound = row as Loose;
    `);
    expect(loose.classification).toBe("laundering");
  });

  it("sees through a PARENTHESIZED alias of `never` (TRDR-2 R8, closed by BOOT-1)", () => {
    const direct = only(`
      declare const row: SnapshotRow;
      export const bound = row as (never);
    `);
    expect(direct.classification).toBe("laundering");

    const aliased = only(`
      type Wrapped = (never);
      declare const row: SnapshotRow;
      export const bound = row as ((Wrapped));
    `);
    expect(aliased.classification).toBe("laundering");

    // A pair that does not enclose the whole text is NOT stripped: this is a
    // union, and neither arm is erasing.
    const union = only(`
      declare const row: SnapshotRow;
      export const bound = row as (SnapshotRow) | (Other);
    `);
    expect(union.classification).toBe("other");
  });

  it("sees a double assertion whose FIRST half is an aliased `unknown`", () => {
    const entry = only(`
      type Opaque = unknown;
      declare const venue: Venue;
      export const bound = venue as Opaque as Port;
    `);
    expect(entry.classification).toBe("laundering");
  });

  it("terminates on a self-referential alias", () => {
    // Not legal TypeScript, but the scanner must terminate on anything the
    // PARSER accepts, and a cycle is the one shape a naive resolver hangs on.
    const entry = only(`
      type Loop = Loop;
      declare const row: SnapshotRow;
      export const bound = row as Loop;
    `);
    expect(entry.classification).toBe("other");
  });

  it("catches a STAGED builder, whose chain root is a plain identifier (evasion 2)", () => {
    const insert = only(`
      declare const db: KyselyLike;
      declare const row: SnapshotRow;
      export async function write(): Promise<void> {
        const builder = db.insertInto("accounting.pnl_snapshots");
        await builder.values(row as { readonly accountRef: string }).execute();
      }
    `);
    expect(insert.queryBoundary).toBe("argument of .values()");

    const update = only(`
      declare const db: KyselyLike;
      declare const patch: Patch;
      export async function amend(): Promise<void> {
        const builder = db.updateTable("accounting.pnl_snapshots");
        await builder.set(patch as { readonly asOf: string }).execute();
      }
    `);
    expect(update.queryBoundary).toBe("argument of .set()");
  });

  it("still catches the UNSTAGED chain, including outside `.values`", () => {
    const entry = only(`
      declare const db: KyselyLike;
      declare const key: string;
      export async function read(): Promise<unknown> {
        return await db
          .selectFrom("accounting.pnl_snapshots")
          .where("account_ref", "=", key as Ref)
          .execute();
      }
    `);
    expect(entry.queryBoundary).toBe("inside a chain rooted at .selectFrom()");
  });

  it("leaves an ordinary narrowing alone, and an `as const` nowhere near a query", () => {
    const narrowing = only(`
      declare const value: unknown;
      export const record = value as Record<string, unknown>;
    `);
    expect(narrowing.classification).toBe("other");
    expect(narrowing.queryBoundary).toBeNull();

    const constant = only(`
      export const sides = ["YES", "NO"] as const;
    `);
    expect(constant.classification).toBe("const");
    expect(constant.queryBoundary).toBeNull();
  });

  it("does NOT read an assertion on the RECEIVER of `map.values()` as a binding", () => {
    // `Map.values()` takes no argument, so the false positive the
    // BINDING_METHODS rule risks cannot be reached that way: the assertion here
    // is on the receiver, which is neither an argument nor under a query root.
    const entry = only(`
      declare const map: unknown;
      export const all = [...(map as ReadonlyMap<string, number>).values()];
    `);
    expect(entry.queryBoundary).toBeNull();
    expect(entry.classification).toBe("other");
  });

  it("pins the hole it still has: an assertion bound to a variable first", () => {
    // Documented in this file's header rather than fixed: closing it needs the
    // `TypeChecker`. It is pinned here so that the day someone closes it, this
    // expectation fails and the header is corrected with it.
    const staged = only(`
      declare const db: KyselyLike;
      declare const row: SnapshotRow;
      export async function write(): Promise<void> {
        const bound = row as { readonly accountRef: string };
        await db.insertInto("accounting.pnl_snapshots").values(bound).execute();
      }
    `);
    expect(staged.queryBoundary).toBeNull();
    // The RELATIONSHIP axis is what covers B1's own target from here: an
    // `as never` is laundering wherever in the file it is written.
    const laundered = only(`
      declare const row: SnapshotRow;
      export const bound = row as never;
    `);
    expect(laundered.classification).toBe("laundering");
  });
});
