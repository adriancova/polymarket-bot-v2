/**
 * WP-280: the user-stream test doubles (`user-stream/testing/**`: the fake
 * socket port, the manual clock, the harness) are reachable by TEST files
 * only, as WP-260's TEST-ONLY rule requires of `src/testing/**`.
 *
 * - No non-test source file of this package imports `user-stream/testing/`
 *   (except the testing directory's own files).
 * - Nothing outside this package can reach it: the package's `exports` map
 *   still names only `.` and `./testing` (WP-260's), neither entry re-exports
 *   it, and `check:deps` (F16) refuses a relative import from another package.
 *
 * NON-VACUOUS: the detector flags a planted import.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const PACKAGE_ROOT = path.resolve(SRC, "..");
const TESTING_DIR = path.join(HERE, "testing");

function specifiers(text: string, fileName: string): string[] {
  const out: string[] = [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function reachesTesting(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(file), specifier);
  return resolved === TESTING_DIR || resolved.startsWith(`${TESTING_DIR}${path.sep}`);
}

async function sources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sources(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("the user-stream test doubles are test-only", () => {
  it("no non-test source file of the package imports user-stream/testing", async () => {
    const offenders: string[] = [];
    for (const file of await sources(SRC)) {
      if (file.startsWith(`${TESTING_DIR}${path.sep}`)) continue;
      for (const specifier of specifiers(await readFile(file, "utf8"), file)) {
        if (reachesTesting(file, specifier)) offenders.push(`${path.relative(SRC, file)} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the package exports map is unchanged: only `.` and `./testing`", async () => {
    const manifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { exports: Record<string, string> };
    expect(manifest.exports).toEqual({ ".": "./src/index.ts", "./testing": "./src/testing/index.ts" });
  });

  it("NON-VACUOUS: a planted import from a production file is detected", () => {
    const file = path.join(HERE, "manager.ts");
    const planted = specifiers('import { FakeUserSocketPort } from "./testing/fake-socket-port.js";', file);
    expect(planted.some((specifier) => reachesTesting(file, specifier))).toBe(true);
    const fromPackageIndex = path.join(SRC, "index.ts");
    expect(reachesTesting(fromPackageIndex, "./user-stream/testing/harness.js")).toBe(true);
    expect(reachesTesting(fromPackageIndex, "./user-stream/index.js")).toBe(false);
  });
});
