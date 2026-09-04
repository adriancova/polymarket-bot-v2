/**
 * THE DELETION GUARD — `WP-180-FU2`, 2026-09-04.
 *
 * WHAT THIS FILE USED TO BE. `plain-data.ts` and `schema-arena.ts` were
 * DUPLICATED, not shared, across `packages/risk`,
 * `packages/capital-allocator` and `packages/execution-planner`, and this file
 * was the DRIFT guard: it asserted the three bodies were byte-identical, so a
 * fix landing in one copy failed here until it landed in all three.
 *
 * WHY IT IS NOW THE OPPOSITE TEST. `GOV-2A` ruled the duplication out
 * (`docs/contracts/dependency-direction.md` §2.1, the mirror-collapse
 * subsection). A drift guard proves the copies are *identical*; it cannot make
 * a fix to them *atomic*, and these modules are the repository's only
 * prototype-free parse door (ADR-020 §3) — the mechanism that closes a class
 * measured to defeat a run-mode ceiling and every format check in the process.
 * The three copies were collapsed into `packages/risk`, exported through its
 * `exports` map, and consumed across the §2.1 **S3** / **S4** same-layer edges.
 *
 * So the guard inverts. The failure mode is no longer "one copy drifted"; it is
 * "a fourth copy appeared" — a package that needs the door pasting the body in
 * rather than adding the edge, which is how the repository would silently walk
 * back to the shape `GOV-2A` ruled against. `docs/contracts/schema-boundary.md`
 * §5 names four more packages that will need this door, so the pressure is
 * real and it is not hypothetical.
 *
 * THREE THINGS ARE PINNED, and each fails closed:
 *
 * 1. **No fourth copy.** No file under any workspace package's `src` tree
 *    outside `packages/risk` carries either module's body. The scan is
 *    `./source-scan.ts`'s recursive walker — shared with the three other guards
 *    that read this repository's sources, for the reason recorded there — and it
 *    matches by CONTENT, not by filename: a copy renamed `parse-door.ts`, or
 *    pasted into the middle of a larger file, is caught by the same fingerprint,
 *    because renaming the file is the first thing a copy would do.
 * 2. **The canonical bodies are unchanged by the collapse.** Their sha256 below
 *    the header markers is pinned to what the three deleted copies carried.
 *    This is the byte-identity claim the collapse rests on, kept mechanical.
 * 3. **Both consumers resolve the modules from `packages/risk`** — the
 *    dependency is declared, the `exports` map publishes exactly the two
 *    subpaths, every consumer import goes through a package specifier that the
 *    map resolves back to the canonical file, and no relative import of a local
 *    copy survives.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  packageSourceFiles,
  readSource,
  repoRoot,
  workspaceSourceFiles,
} from "./source-scan.js";

/** The canonical package. Everything else is a copy site. */
const CANONICAL = "packages/risk";

interface Module {
  /** The `exports`-map subpath the consumers import. */
  readonly subpath: string;
  /** The canonical file, relative to the repository root. */
  readonly file: string;
  /** First line of the shared body; everything above it is a package header. */
  readonly marker: RegExp;
  /** sha256 of the body's UTF-8 bytes, as the three collapsed copies carried it. */
  readonly bodySha256: string;
  /** Body length in UTF-8 bytes, so a truncated match cannot pass silently. */
  readonly bodyBytes: number;
}

const MODULES: readonly Module[] = [
  {
    subpath: "./plain-data",
    file: "packages/risk/src/plain-data.ts",
    marker: /^import \{ types \} from "node:util";$/mu,
    bodySha256: "a318a50100758ba968f0360795655d78dbb3ec86beebb861e0b1006793dc7826",
    bodyBytes: 30_179,
  },
  {
    subpath: "./schema-arena",
    file: "packages/risk/src/schema-arena.ts",
    marker: /^\/\/ ---- shared body: byte-identical with the mirrored copy -+$/mu,
    bodySha256: "35aaf0b907ccda16567eb7e7b920df8bb29175102e72ff99d524dc1363dccc53",
    bodyBytes: 21_379,
  },
];

/** The consumers of the two §2.1 rows, and the edge each row permits. */
const CONSUMERS = [
  { row: "S3", dir: "packages/capital-allocator" },
  { row: "S4", dir: "packages/execution-planner" },
] as const;

/** The shared scan's reader, under this file's original short name. */
const read = readSource;

/** Everything from the module's body marker down. */
function bodyOf(relativePath: string, marker: RegExp): string {
  const text = read(relativePath);
  const match = marker.exec(text);
  if (match === null) throw new Error(`no body marker in ${relativePath}`);
  return text.slice(match.index);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Distinctive lines from each body, used as the copy fingerprint.
 *
 * WHY NOT A WHOLE-BODY HASH: it catches only a VERBATIM paste, and a copy is
 * free to reindent.
 *
 * WHY NOT "ALL OF A SHORT LIST" (the shape review round 1 finding LOW-1
 * defeated): this table used to hold three DECLARATION lines per module and
 * required every one of them to be present. A full pasted copy of
 * `plain-data.ts` with the single identifier `describeValue` renamed to
 * `describeVal_` therefore evaded the guard completely — one edit, and the
 * conjunction was false. A conjunction over N lines has the evasion cost of its
 * WEAKEST line, which is 1.
 *
 * WHAT IS PINNED INSTEAD: **at least {@link MATCH_THRESHOLD} of the twelve**
 * lines below, per module. They are exact source lines drawn from across the
 * whole body — not from the header — and deliberately spread over many
 * different identifiers, with several carrying no local identifier at all
 * (refusal strings, library-pin error text, expressions written only in
 * built-ins). Comparison normalizes runs of whitespace on both sides, so a
 * reindent or a reflow does not help either.
 *
 * THE EVASION BAR, MEASURED RATHER THAN ASSERTED. Every variant below was
 * built from the canonical file, dropped into a consumer's `src`, and scored by
 * this file's own matcher (`WP-180-FU2` remediation round 1):
 *
 * | variant | score | verdict |
 * | --- | --- | --- |
 * | verbatim paste | 12/12 | caught |
 * | round-1 M3: one identifier renamed (`describeValue`→`describeVal_`) | 12/12 | caught |
 * | two identifiers renamed (+ `readPlainData`) | 12/12 | caught |
 * | `schema-arena` with ALL THREE of the retired fingerprints renamed | 11/12 | caught |
 * | all comments stripped and the file reindented | 12/12 | caught |
 * | comments stripped AND eight identifiers renamed | 1/12 | **EVADES** |
 *
 * So the bar is: a paste survives renaming, reindenting and comment-stripping
 * individually, and falls only to a systematic obfuscation pass that renames
 * roughly every identifier the code lines are written in — which, for this
 * module, includes the refusal-payload key names `problem` and `state`, so the
 * evading copy no longer emits this module's refusal SHAPE. And a genuine
 * re-implementation, sharing behaviour but no text, is invisible here by
 * construction. That is the honest limit: this guard answers copy-paste,
 * because pasting is the cheap path back to three implementations, and it does
 * not claim to answer a determined author.
 *
 * FALSE POSITIVES: each line was verified unique inside its own module and
 * absent from every other workspace source file at this tip. Four independent
 * exact matches from one module in one unrelated file is not a coincidence a
 * reviewer needs to be protected from.
 */
const FINGERPRINTS: Readonly<Record<string, readonly string[]>> = {
  "packages/risk/src/plain-data.ts": [
    "return value.length > 64 ? `a ${String(value.length)}-character string` : `\"${value}\"`;",
    "const state: ReadState = { problems: [], strings: [], ancestors: new WeakSet() };",
    "if (state.problems.length > 0) return { ok: false, problems: state.problems };",
    "state.problems.push({ path, problem: `a record carries data, not a ${kind}` });",
    'state.problems.push({ path, problem: "a cycle: a record is a finite tree of data" });',
    "problem: `a symbol-keyed property (${String(key)}) is not record data`,",
    "Object.defineProperty(out, key, ownDataDescriptor(value));",
    'if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;',
    'if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;',
    'defineDataProperty(out, "detailsUnreadable", "its own property names could not be read");',
    'problem: "its length is not an own data property, so the array is not data",',
    'state.problems.push({ path, problem: "a sparse array: a record has no holes" });',
  ],
  "packages/risk/src/schema-arena.ts": [
    'export const SCHEMA_ARENA_ERROR = "schema arena";',
    "export const ARENA_NODE_TYPES: readonly string[] = [",
    '" the internal layout this arena is pinned to. Re-measure before upgrading.",',
    '" it could silently discard library state, so this fails the build instead —" +',
    "Object.defineProperty(target, name, ownDataDescriptor(value));",
    "const slots = internals as { def?: unknown; constr?: unknown; check?: unknown; run?: unknown };",
    "Object.getPrototypeOf(value) === Array.prototype && (value as readonly unknown[]).length === 0",
    "held = isFreshOrdinaryContainer(next) ? prototypeFreeContainer(next) : next;",
    'const given = ctx !== null && typeof ctx === "object" ? (ctx as object) : undefined;',
    'severOrdinaryChain(copy._zod, "the _zod container of a check copy");',
    '" the arena has never measured. Re-measure before upgrading the library.",',
    "`${SCHEMA_ARENA_ERROR}: the value handed to the arena is not a schema node (no _zod.def/constr/run)`,",
  ],
};

/**
 * How many fingerprint lines make a file a copy. Four of twelve: high enough
 * that no honest file reaches it by coincidence, low enough that renaming
 * identifiers — the cheap evasion — cannot get under it.
 */
const MATCH_THRESHOLD = 4;

/** Whitespace-insensitive: a copy may reindent or reflow, and often will. */
function normalize(text: string): string {
  return text.replace(/\s+/gu, " ");
}

/** How many of `lines` appear in `text`, comparing whitespace-insensitively. */
function matchCount(text: string, lines: readonly string[]): number {
  const haystack = normalize(text);
  return lines.filter((line) => haystack.includes(normalize(line))).length;
}

describe("the collapsed parse door exists in exactly one package (WP-180-FU2)", () => {
  it("the canonical bodies are the ones the collapse claimed: unchanged, byte for byte", () => {
    for (const module of MODULES) {
      const body = bodyOf(module.file, module.marker);
      expect(Buffer.byteLength(body, "utf8"), `${module.file} body length`).toBe(module.bodyBytes);
      expect(sha256(body), `${module.file} body sha256`).toBe(module.bodySha256);
    }
  });

  it("the fingerprints are non-vacuous: the canonical file matches ALL of its own, well above the threshold", () => {
    for (const module of MODULES) {
      const lines = FINGERPRINTS[module.file];
      expect(lines, `no fingerprint registered for ${module.file}`).toBeDefined();
      // Twelve lines and a threshold of four: the ratio is the evasion bar, so
      // it is asserted rather than left to the reader to recompute.
      expect((lines ?? []).length, `${module.file} fingerprint size`).toBe(12);
      expect((lines ?? []).length).toBeGreaterThanOrEqual(3 * MATCH_THRESHOLD);
      // The detector itself is what is exercised here, not `toContain` — a
      // fingerprint the real matcher cannot find is a fingerprint that is not
      // guarding anything.
      expect(
        matchCount(read(module.file), lines ?? []),
        `${module.file} no longer matches its own fingerprint`,
      ).toBe(12);
    }
  });

  it("the scan is non-vacuous AND RECURSIVE: it walks every workspace src tree, not one directory", () => {
    const files = workspaceSourceFiles();
    expect(files.length).toBeGreaterThan(100);
    for (const module of MODULES) expect(files).toContain(module.file);
    expect(files).toContain("packages/capital-allocator/src/reserve.ts");
    expect(files).toContain("packages/execution-planner/src/pluck.ts");
    // The deleted copies are gone, by name as well as by content.
    expect(files).not.toContain("packages/capital-allocator/src/plain-data.ts");
    expect(files).not.toContain("packages/capital-allocator/src/schema-arena.ts");
    expect(files).not.toContain("packages/execution-planner/src/plain-data.ts");
    expect(files).not.toContain("packages/execution-planner/src/schema-arena.ts");

    // RECURSION, PROVED ON REAL NESTED FILES (review round 1, finding M7). Both
    // exported walkers are the same code path, and both are asserted here
    // because `ports.test.ts` and `determinism.test.ts` now depend on the
    // descent: a `src/nested/sneak.ts` importing the risk ENGINE passed all
    // four of these guards while they enumerated `src` one level deep.
    expect(files).toContain("packages/observability/src/recorder/render.ts");
    expect(files).toContain("packages/domain/src/events/events.test.ts");
    expect(packageSourceFiles("packages/observability")).toContain(
      "packages/observability/src/recorder/render.ts",
    );
    expect(packageSourceFiles("packages/settlement")).toContain(
      "packages/settlement/src/models/registry.ts",
    );
    // …and a package whose `src` is flat is still fully enumerated.
    expect(packageSourceFiles("packages/execution-planner")).toContain(
      "packages/execution-planner/src/pluck.ts",
    );
  });

  it("NO FOURTH COPY: no file outside packages/risk carries either module's body", () => {
    const offenders: string[] = [];

    for (const file of workspaceSourceFiles()) {
      if (file.startsWith(`${CANONICAL}/`)) continue;
      const text = read(file);
      for (const module of MODULES) {
        const lines = FINGERPRINTS[module.file] ?? [];
        const matched = matchCount(text, lines);
        if (matched >= MATCH_THRESHOLD) {
          offenders.push(
            `${file} reproduces the body of ${module.file} (${String(matched)} of` +
              ` ${String(lines.length)} fingerprint lines) — the parse door was collapsed to` +
              ` ${CANONICAL} by GOV-2A; import it as \`@polymarket-bot/risk${module.subpath.slice(1)}\`` +
              " and add the §2.1 same-layer row, do not paste it",
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("packages/risk publishes exactly the two door subpaths, and nothing else new", () => {
    const manifest: unknown = JSON.parse(read(`${CANONICAL}/package.json`));
    const exportsMap = (manifest as { exports: Record<string, string> }).exports;
    expect(Object.keys(exportsMap).sort()).toEqual([".", "./plain-data", "./schema-arena"]);
    for (const module of MODULES) {
      const target = exportsMap[module.subpath];
      expect(target, `${module.subpath} is not exported`).toBeDefined();
      // The map entry resolves back to the canonical file, not to a re-export.
      expect(`${CANONICAL}/${(target ?? "").replace(/^\.\//u, "")}`).toBe(module.file);
      expect(existsSync(resolve(repoRoot, module.file))).toBe(true);
    }
  });

  it("both consumers declare the workspace dependency the §2.1 row permits", () => {
    for (const consumer of CONSUMERS) {
      const manifest: unknown = JSON.parse(read(`${consumer.dir}/package.json`));
      const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies;
      expect(
        dependencies?.["@polymarket-bot/risk"],
        `${consumer.dir} must declare the ${consumer.row} edge`,
      ).toBe("workspace:*");
    }
  });

  it("both consumers import the door ONLY through the package specifier", () => {
    const problems: string[] = [];

    for (const consumer of CONSUMERS) {
      const specifiers = new Set<string>();
      for (const file of workspaceSourceFiles()) {
        if (!file.startsWith(`${consumer.dir}/`)) continue;
        const text = read(file);
        for (const match of text.matchAll(/from "([^"]+)"/gu)) {
          const specifier = match[1] ?? "";
          if (/(?:^|\/)(?:plain-data|schema-arena)(?:\.js)?$/u.test(specifier)) {
            specifiers.add(specifier);
            if (specifier.startsWith(".")) {
              problems.push(`${file} imports a LOCAL copy: ${specifier}`);
            } else if (!specifier.startsWith("@polymarket-bot/risk/")) {
              problems.push(`${file} imports the door from ${specifier}`);
            }
          }
        }
      }
      // Non-vacuity: this consumer really does still use the door.
      expect(specifiers.size, `${consumer.dir} imports neither door module`).toBeGreaterThan(0);
      expect([...specifiers].sort()).toEqual(
        [...specifiers].filter((specifier) => specifier.startsWith("@polymarket-bot/risk/")).sort(),
      );
    }

    expect(problems).toEqual([]);
  });
});
