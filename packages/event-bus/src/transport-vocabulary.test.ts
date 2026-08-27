/**
 * Enforces ADR-003's Consequences mechanically.
 *
 * > "If consumer-group names, `XADD` ids, or `MAXLEN` trimming appear in a
 * > consumer's types, the transport is no longer replaceable and this ADR has
 * > been violated in substance while satisfied in form."
 *
 * A review can miss that; a test cannot. The scan is over *declarations*, not
 * prose — comments are stripped first, so this file's own quotation above, and
 * the explanatory notes in the scanned files, do not trip it. What is checked
 * is exactly what ADR-003 cares about: the vocabulary a consumer's types carry.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** Files whose declarations a consumer of this package sees. */
const INTERFACE_FILES = ["transport.ts", "metrics.ts", "index.ts", "redis/index.ts"];

/** Implementation vocabulary that must not reach a consumer's types. */
const FORBIDDEN = [
  "xadd",
  "xread",
  "xrange",
  "xrevrange",
  "xlen",
  "xinfo",
  "xgroup",
  "xack",
  "xautoclaim",
  "xtrim",
  "xdel",
  "maxlen",
  "minid",
  "ioredis",
  "redis.call",
  "consumer group",
  "consumer-group",
  "consumergroup",
  "entryid",
  "streamkey",
];

/**
 * Removes block and line comments.
 *
 * Deliberately simple: these two files declare types and hold no string
 * literal containing `//` or `/*`, so a full tokenizer would add risk without
 * adding accuracy. If that ever stops being true, this test starts passing
 * vacuously — which is why {@link selfCheck} asserts the stripper still finds
 * the declarations it is supposed to scan.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, " ").replaceAll(/\/\/[^\n]*/gu, " ");
}

describe("the transport interface carries no implementation vocabulary", () => {
  for (const file of INTERFACE_FILES) {
    it(`${file} declares nothing in the implementation's own vocabulary`, () => {
      const declarations = stripComments(readFileSync(join(here, file), "utf8")).toLowerCase();

      for (const term of FORBIDDEN) {
        expect(declarations, `\`${term}\` leaked into ${file}`).not.toContain(term);
      }
    });
  }

  it("scans real declarations, so a passing result is not vacuous", () => {
    const declarations = stripComments(readFileSync(join(here, "transport.ts"), "utf8"));

    expect(declarations).toContain("MarketEventTransport");
    expect(declarations).toContain("StreamCheckpoint");
    expect(declarations).toContain("HardResyncCondition");
    // The quotation in transport.ts's header names two forbidden terms; if the
    // stripper stopped working, this assertion would fail alongside the scan.
    expect(declarations).not.toContain("ADR-003's Consequences");
  });
});
