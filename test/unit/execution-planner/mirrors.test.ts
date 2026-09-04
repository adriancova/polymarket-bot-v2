/**
 * The mirrored boundary modules — byte-identical below their headers.
 *
 * `plain-data.ts` and `schema-arena.ts` are DUPLICATED, not shared, across
 * `packages/risk`, `packages/capital-allocator` and this package (no §2.1
 * same-layer edge exists — F13). WP-180's drift test guards its two copies;
 * this is the same guard for the third: the shared body of each module in
 * this package must be byte-identical to BOTH upstream mirrors, so a fix
 * landing in one mirror fails here until it lands in all three.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Everything from the module's first non-comment line down. */
function bodyOf(relativePath: string, marker: RegExp): string {
  const text = readFileSync(resolve(repoRoot, relativePath), "utf8");
  const match = marker.exec(text);
  if (match === null) throw new Error(`no body marker in ${relativePath}`);
  return text.slice(match.index);
}

describe("mirrored modules stay byte-identical below their headers", () => {
  it("plain-data.ts matches both upstream mirrors", () => {
    const marker = /^import \{ types \} from "node:util";$/mu;
    const mine = bodyOf("packages/execution-planner/src/plain-data.ts", marker);
    expect(mine).toBe(bodyOf("packages/risk/src/plain-data.ts", marker));
    expect(mine).toBe(bodyOf("packages/capital-allocator/src/plain-data.ts", marker));
    expect(mine.length).toBeGreaterThan(10_000); // the marker really is the body's head
  });

  it("schema-arena.ts matches both upstream mirrors", () => {
    const marker = /^\/\/ ---- shared body: byte-identical with the mirrored copy -+$/mu;
    const mine = bodyOf("packages/execution-planner/src/schema-arena.ts", marker);
    expect(mine).toBe(bodyOf("packages/risk/src/schema-arena.ts", marker));
    expect(mine).toBe(bodyOf("packages/capital-allocator/src/schema-arena.ts", marker));
    expect(mine.length).toBeGreaterThan(10_000);
  });
});
