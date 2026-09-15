/**
 * `TRDR-2` — a compiler-resolved census of every TYPE ASSERTION in
 * `apps/trader`'s production source, and a fail-closed rule for the two shapes
 * that disable a check the compiler would otherwise have made.
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
 * ## What is forbidden, and what is merely counted
 *
 * | class | example | verdict |
 * | --- | --- | --- |
 * | `laundering` | `x as never`, `x as any`, `x as unknown as T` | FORBIDDEN — it erases the relationship between the value and the type entirely |
 * | `query-boundary` | any assertion inside a chain rooted at `insertInto` / `updateTable` / `deleteFrom` / `selectFrom` | FORBIDDEN — this is B1's exact shape: the one place a typed SQL builder checks a binding is the one place a cast must never appear |
 * | `const` | `["YES", "NO"] as const` | allowed: it NARROWS, and asserts nothing about a relationship |
 * | `widening` | `JSON.parse(text) as unknown` | allowed: `unknown` RESTORES checking on an `any` |
 * | `other` | `value as Record<string, unknown>` | allowed and COUNTED — a single-step assertion whose target is a real type; most are read-shape narrowings at a parse door, downstream of a validation |
 *
 * `other` is counted rather than banned because banning it would be a claim
 * this round cannot honestly make about twenty-seven sites in files it does not
 * own — and because a rule that forces `@ts-expect-error` to get work done buys
 * nothing. Each is listed in `TRDR-2`'s sweep with a verdict.
 *
 * ## Scope, stated as a boundary rather than as a habit
 *
 * PRODUCTION source only (`*.test.ts` excluded). A test's `as unknown as T` is
 * usually the point — handing a door a value its TYPE forbids is how this
 * repository tests hostile input (`apps/trader/src/halt.test.ts:94`'s
 * `false as unknown as true`) — so scanning tests would either ban that or
 * dilute the rule into an ignore list. The census is over the SYNTAX TREE, not
 * over text: a comment or a string that merely contains "as never" is inert in
 * an AST, and `test/unit/risk/prototype-access-scan.ts` is the precedent for
 * that choice.
 *
 * What it does NOT see, stated in full: an unchecked `any` arriving from an
 * untyped dependency (no cast is written, so there is nothing to find); a
 * generic whose constraint is `any`; a structural mismatch two compatible
 * types share; and `unknown` narrowed by a hand-written type PREDICATE, which
 * is a cast the compiler cannot distinguish from a real check. The last of
 * those is the nearest live gap and has no cheap mechanical answer.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRADER_SRC = join(REPO_ROOT, "apps", "trader", "src");

/** Kysely chain roots: an assertion under one of these is at a query boundary. */
const QUERY_ROOTS = new Set(["insertInto", "updateTable", "deleteFrom", "selectFrom"]);

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
  {
    file: "main.ts",
    text: 'venue as unknown as Parameters<typeof createPaperTrader>[0]["venue"]',
    reason:
      "`TRDR-2` MEASURED this one rather than reading it: with the cast replaced by " +
      "`venue: venue`, `pnpm --filter @polymarket-bot/trader typecheck` exits 0 — the " +
      "`SimulatedVenue` satisfies the port as written, so the cast hides NO mismatch " +
      "today. It is registered rather than deleted only because `apps/trader/src/main.ts` " +
      "is outside TRDR-2's allowed paths (`apps/trader/src/adapters/**`). It remains a " +
      "live instance of B1's class — it disables the check permanently, so the FIRST " +
      "drift between the venue and the port will be silent — and TRDR-2's handoff carries " +
      "its removal as follow-up 1. Delete the cast, delete this entry.",
  },
];

interface Assertion {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly text: string;
  readonly classification: "laundering" | "query-boundary" | "const" | "widening" | "other";
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

function classify(node: ts.AsExpression | ts.TypeAssertion, sf: ts.SourceFile): Assertion["classification"] {
  const target = node.type.getText(sf);
  if (target === "const") return "const";

  const inner = node.expression;
  const launderedThrough =
    (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) &&
    ["unknown", "any"].includes(inner.type.getText(sf));
  if (launderedThrough || target === "never" || target === "any") return "laundering";

  // A Kysely builder chain anywhere above this assertion.
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor !== undefined) {
    if (ts.isCallExpression(ancestor) && chainMethodNames(ancestor).some((n) => QUERY_ROOTS.has(n))) {
      return "query-boundary";
    }
    ancestor = ancestor.parent;
  }

  if (target === "unknown") return "widening";
  return "other";
}

const FILES = sourceFiles(TRADER_SRC);

const ASSERTIONS: readonly Assertion[] = FILES.flatMap((file) => {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const relativePath = relative(TRADER_SRC, file).split(sep).join("/");
  const found: Assertion[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const parent = node.parent;
      const isInnerHalfOfADoubleAssertion =
        (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) &&
        parent.expression === node;
      if (!isInnerHalfOfADoubleAssertion) {
        found.push({
          file: relativePath,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          target: node.type.getText(sf),
          text: node.getText(sf).replace(/\s+/gu, " "),
          classification: classify(node, sf),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
});

/** Text of the `@ts-` and `eslint-disable` escape hatches, per file. */
const SUPPRESSION_COMMENTS: readonly { readonly file: string; readonly line: number; readonly text: string }[] =
  FILES.flatMap((file) => {
    const relativePath = relative(TRADER_SRC, file).split(sep).join("/");
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
    const names = FILES.map((file) => relative(TRADER_SRC, file).split(sep).join("/"));
    expect(names).toContain("adapters/postgres-store.ts");
    expect(names).toContain("adapters/redis-feed.ts");
    expect(names).toContain("loop.ts");
    expect(names).toContain("main.ts");
    // And it really did parse them: the census is non-empty, and it found the
    // `as const`s that are known to be there.
    expect(ASSERTIONS.length).toBeGreaterThan(0);
    expect(ASSERTIONS.filter((entry) => entry.classification === "const").length).toBeGreaterThan(0);
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

  it("has NO assertion inside a Kysely builder chain, anywhere in apps/trader", () => {
    expect(render(ASSERTIONS.filter((entry) => entry.classification === "query-boundary"))).toEqual(
      [],
    );
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
    // Exactly one site is excused today; the handoff carries its removal.
    expect(REGISTERED).toHaveLength(1);
  });

  it("uses no `@ts-expect-error`, `@ts-ignore` or `eslint-disable` to get past the compiler", () => {
    expect(
      SUPPRESSION_COMMENTS.map((entry) => `${entry.file}:${String(entry.line)} ${entry.text}`),
    ).toEqual([]);
  });
});
