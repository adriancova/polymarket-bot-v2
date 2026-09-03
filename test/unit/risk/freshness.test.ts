/**
 * Freshness classification (§9.8 check 7) and the no-clock guarantee.
 *
 * Staleness is a CALLER-SUPPLIED measurement. These tests pass ages directly
 * and never advance or read a clock, which is the property that makes the same
 * decision reproducible on replay (§6 invariant 2, §12.4).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assessFreshness,
  blocksAsStale,
  isExpired,
  instantMilliseconds,
} from "../../../packages/risk/src/index.js";
import { MARKET_A, MARKET_B } from "./fixtures.js";
import { auditNodeBuiltins, auditScannedFiles } from "./prototype-access-scan.js";

const policy = { venueBookMaxAgeMs: 1000, referenceFeedMaxAgeMs: 2000, featuresMaxAgeMs: 2000 };

describe("assessFreshness", () => {
  it("classifies a measured, in-limit feed as FRESH", () => {
    const assessment = assessFreshness(
      [{ feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 1000 }],
      policy,
      MARKET_A,
    );
    expect(assessment.venueBook.status).toBe("FRESH");
    expect(blocksAsStale(assessment.venueBook)).toBe(false);
  });

  it("classifies an over-limit feed as STALE (the limit itself is inclusive)", () => {
    const assessment = assessFreshness(
      [{ feed: "VENUE_BOOK", marketId: MARKET_A, ageMs: 1001 }],
      policy,
      MARKET_A,
    );
    expect(assessment.venueBook.status).toBe("STALE");
    expect(blocksAsStale(assessment.venueBook)).toBe(true);
  });

  it("classifies an UNMEASURED feed as UNKNOWN, and unknown blocks like stale", () => {
    const assessment = assessFreshness([], policy, MARKET_A);
    expect(assessment.venueBook.status).toBe("UNKNOWN");
    expect(assessment.referenceFeed.status).toBe("UNKNOWN");
    expect(assessment.features.status).toBe("UNKNOWN");
    expect(blocksAsStale(assessment.venueBook)).toBe(true);
    expect(blocksAsStale(assessment.referenceFeed)).toBe(true);
    expect(blocksAsStale(assessment.features)).toBe(true);
  });

  it("lets the STALEST measurement of a feed govern (fail closed)", () => {
    const assessment = assessFreshness(
      [
        { feed: "FEATURES", ageMs: 10 },
        { feed: "FEATURES", ageMs: 9000 },
      ],
      policy,
      MARKET_A,
    );
    expect(assessment.features.ageMs).toBe(9000);
    expect(assessment.features.status).toBe("STALE");
  });

  it("counts a VENUE_BOOK measurement only for the market it names", () => {
    const other = assessFreshness(
      [{ feed: "VENUE_BOOK", marketId: MARKET_B, ageMs: 10 }],
      policy,
      MARKET_A,
    );
    expect(other.venueBook.status).toBe("UNKNOWN");
  });

  it("returns a frozen assessment", () => {
    const assessment = assessFreshness([], policy, MARKET_A);
    expect(Object.isFrozen(assessment)).toBe(true);
  });
});

describe("deadline comparison reads no clock", () => {
  it("compares two caller-supplied instants", () => {
    expect(isExpired("2026-09-02T11:00:00.000Z", "2026-09-02T12:00:00.000Z")).toBe(true);
    expect(isExpired("2026-09-02T13:00:00.000Z", "2026-09-02T12:00:00.000Z")).toBe(false);
  });

  it("compares by instant, not lexicographically, across UTC offsets", () => {
    expect(isExpired("2026-09-02T13:00:00.000+02:00", "2026-09-02T12:00:00.000Z")).toBe(true);
    expect(instantMilliseconds("2026-09-02T12:00:00.000Z")).toBe(
      instantMilliseconds("2026-09-02T14:00:00.000+02:00"),
    );
  });

  it("returns undefined — not a verdict — for an unparseable instant", () => {
    expect(instantMilliseconds("not-a-time")).toBeUndefined();
    expect(isExpired("not-a-time", "2026-09-02T12:00:00.000Z")).toBeUndefined();
  });

  /**
   * Comments are stripped before the scan: `time.ts` DOCUMENTS that it does not
   * call `Date.now()`, and a scan that could not tell prose from code would
   * make that sentence unwriteable. The stripper is a test-local heuristic, not
   * a parser — the authoritative check is `tools/check-dependency-direction.mjs`
   * (F11 and its `new Date()` allowance), which walks the AST.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|\s)\/\/.*$/gmu, "$1");
  }

  /**
   * THE ONE AUDITED NODE BUILT-IN LINE (review round 5).
   *
   * This scan used to assert `not.toMatch(/from\s+"node:/)` — no built-in
   * import at all — under the label "performs I/O". Round 5's second BLOCKER
   * required rejecting a `Proxy` BEFORE any reflective operation touches it,
   * and portable JavaScript cannot do that: every reflective operation on a
   * `Proxy` runs a trap, so a portable probe is already the thing being
   * prevented. `util.types.isProxy` is a V8-level type predicate that consults
   * no trap.
   *
   * The blanket spelling is therefore replaced by an EXACT-MATCH ALLOWLIST,
   * which is stronger everywhere except on the single audited line: any other
   * `node:` import — `node:fs`, `node:crypto`, a different binding from
   * `node:util`, a renamed one, a dynamic `import("node:…")` — fails, and the
   * audited line is pinned character for character. The next test pins WHERE it
   * may appear and HOW the binding may be used, across BOTH packages (this scan
   * covered only `packages/risk`).
   *
   * The label's claim is unchanged in substance: a type predicate opens no
   * connection, reads no clock, touches no filesystem and consumes no entropy.
   * `docs/handoffs/WP-180.md` (remediation round 5) records the argument and
   * the gate evidence.
   */
  const AUDITED_BUILTIN_IMPORT = 'import { types } from "node:util";';

  it("this package's source contains no clock read and no unseeded randomness", () => {
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/risk/src");
    const scanned: string[] = [];
    for (const entry of readdirSync(source)) {
      if (!entry.endsWith(".ts")) continue;
      scanned.push(entry);
      const code = stripComments(readFileSync(join(source, entry), "utf8"));
      expect(code, `${entry} reads a clock`).not.toMatch(/Date\.now\s*\(/u);
      expect(code, `${entry} constructs a current Date`).not.toMatch(/new\s+Date\s*\(\s*\)/u);
      expect(code, `${entry} uses unseeded randomness`).not.toMatch(/Math\.random/u);
      expect(code, `${entry} performs I/O`).not.toMatch(/import\s*\(\s*["']node:/u);
      for (const line of code.split("\n")) {
        if (!/node:/u.test(line)) continue;
        expect(line.trim(), `${entry} performs I/O`).toBe(AUDITED_BUILTIN_IMPORT);
      }
    }
    // The scan is only meaningful if it actually saw the module that parses
    // instants; an empty or mis-pathed directory would pass vacuously.
    expect(scanned).toContain("time.ts");
    expect(scanned.length).toBeGreaterThan(10);
  });

  it("the audited `node:util` line appears exactly where it is allowed, used only as a type predicate", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const sites: string[] = [];
    for (const pkg of ["risk", "capital-allocator"] as const) {
      const source = resolve(root, "packages", pkg, "src");
      for (const entry of readdirSync(source)) {
        // `packages/capital-allocator` colocates its suite in `src`; a TEST may
        // read the filesystem, and does (this file does too).
        if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
        const code = stripComments(readFileSync(join(source, entry), "utf8"));
        for (const line of code.split("\n")) {
          if (!/node:/u.test(line)) continue;
          expect(line.trim(), `packages/${pkg}/src/${entry}`).toBe(AUDITED_BUILTIN_IMPORT);
          sites.push(`${pkg}/${entry}`);
        }
      }
    }
    // Exactly one site per package: the mirrored data-record boundary. NOT a
    // "greater than zero" check — a second site would be a second thing to
    // audit, and this test is the audit.
    expect(sites.sort()).toEqual(["capital-allocator/plain-data.ts", "risk/plain-data.ts"]);
  });

  /**
   * HOW THE BINDING MAY BE USED — AST, NOT TEXT (review round 6, LOW B).
   *
   * The previous version of this check matched the regular expression
   * `\btypes\s*\.\s*[A-Za-z0-9_$]+` and required every hit to read `isProxy`.
   * Review round 6 showed the pin is LEXICAL and bypassable four ways, and gave
   * the transcript:
   *
   * ```text
   * types.isDate               rejected
   * const t = types; t.isDate  accepted
   * const { isDate } = types   accepted
   * types["isDate"]            accepted
   * ```
   *
   * The replacement resolves the IMPORT to its local binding and classifies
   * every reference to that binding by its syntactic parent, so an alias, a
   * destructuring and a computed access are each reported as what they are. The
   * reviewer was explicit that this is a STRENGTHENING and not a retraction:
   * the shipped source uses only `types.isProxy`, and `util.types` predicates
   * introduce no I/O.
   */
  it("the audited binding is used ONLY as `types.isProxy`, by AST and not by text", () => {
    const audited = auditScannedFiles().filter((entry) => !entry.file.endsWith(".test.ts"));
    const failures: string[] = [];
    const importedFiles: string[] = [];

    for (const { file, audit } of audited) {
      for (const specifier of audit.dynamicSpecifiers) {
        if (specifier.startsWith("node:")) {
          failures.push(`${file}: dynamic import of ${specifier}`);
        }
      }
      for (const entry of audit.imports) {
        importedFiles.push(file);
        if (entry.specifier !== "node:util" || entry.form !== "named" || entry.imported !== "types") {
          failures.push(
            `${file}:${String(entry.line)}: ${entry.form} import of ${entry.imported} from ${entry.specifier}`,
          );
          continue;
        }
        if (entry.binding !== "types") {
          failures.push(`${file}:${String(entry.line)}: renamed binding \`${entry.binding}\``);
        }
        for (const use of entry.uses) {
          if (use !== "types.isProxy") failures.push(`${file}: ${use}`);
        }
        if (entry.uses.length === 0) {
          failures.push(`${file}: the audited import is never used`);
        }
      }
    }

    expect(failures).toEqual([]);
    expect(importedFiles.sort()).toEqual([
      "packages/capital-allocator/src/plain-data.ts",
      "packages/risk/src/plain-data.ts",
    ]);
  });

  it("the AST audit rejects each of the four bypasses the reviewer demonstrated", () => {
    const usesOf = (body: string): readonly string[] => {
      const audit = auditNodeBuiltins(`import { types } from "node:util";\n${body}\n`);
      return audit.imports.flatMap((entry) => entry.uses);
    };

    expect(usesOf("export const a = types.isProxy(x);")).toEqual(["types.isProxy"]);
    // 1. a different member
    expect(usesOf("export const a = types.isDate(x);")).toEqual(["types.isDate"]);
    // 2. an alias
    expect(usesOf("const t = types;\nexport const a = t.isDate(x);")[0]).toContain(
      "ALIASED or DESTRUCTURED",
    );
    // 3. destructuring
    expect(usesOf("const { isDate } = types;\nexport const a = isDate(x);")[0]).toContain(
      "ALIASED or DESTRUCTURED",
    );
    // 4. computed access
    expect(usesOf('export const a = types["isDate"](x);')[0]).toContain("[computed]");
    // …and a bare reference passed somewhere else
    expect(usesOf("export const a = use(types);")[0]).toContain("BARE REFERENCE");
    // a renamed binding is seen as itself
    const renamed = auditNodeBuiltins(
      'import { types as t } from "node:util";\nexport const a = t.isProxy(x);\n',
    );
    expect(renamed.imports[0]?.binding).toBe("t");
    // a dynamic import is seen
    expect(
      auditNodeBuiltins('export const fs = await import("node:fs");').dynamicSpecifiers,
    ).toEqual(["node:fs"]);
    // a property that merely shares the name is not a use
    expect(usesOf("export const a = other.types;")).toEqual([]);
  });
});
