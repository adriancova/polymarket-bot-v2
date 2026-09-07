import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, it } from "vitest";

// WP-200-FU2: ordinary suites survived a reverted append. Pin the entire
// production source tree; parsing excludes the historical `.push(` comments.
// Every executable push site in this package's census was an array append.
it("production accumulators use own-data appends instead of prototype-sensitive push", () => {
  const root = new URL("./", import.meta.url);
  const violations: string[] = [];
  for (const file of readdirSync(fileURLToPath(root), { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const url = new URL(file, root);
    const source = ts.createSourceFile(
      fileURLToPath(url), readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true,
    );
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "push"
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${file}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
