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
 * 1. **No fourth copy.** No file under any workspace member's `src` tree —
 *    `apps/*` as well as `packages/*` and `packages/strategies/*` — outside
 *    `packages/risk` carries either module's body. The scan is
 *    `./source-scan.ts`'s recursive walker — shared with the three other guards
 *    that read this repository's sources, for the reason recorded there — and it
 *    matches by CONTENT, not by filename: a copy renamed `parse-door.ts`, or
 *    pasted into the middle of a larger file, is caught by the same fingerprint,
 *    because renaming the file is the first thing a copy would do. *(The
 *    `apps/*` half of "any workspace member" was added in remediation round 2,
 *    review finding LOW-B: the round-1 walker read `packages/` only, and a
 *    verbatim `cp` of the door into `apps/trader/src/` passed this file 7/7.)*
 * 2. **The canonical bodies are unchanged by the collapse.** Their sha256 below
 *    the header markers is pinned to what the three deleted copies carried.
 *    This is the byte-identity claim the collapse rests on, kept mechanical.
 * 3. **Every consumer resolves the modules from `packages/risk`** — the
 *    dependency is declared, the `exports` map publishes exactly the two
 *    subpaths, every consumer import goes through a package specifier that the
 *    map resolves back to the canonical file, and no relative import of a local
 *    copy survives. *(`WP-200-FU1` review round 1, finding M1: the `CONSUMERS`
 *    table below grew the **S5** and **S6** rows, so "every consumer" now means
 *    four rather than two; `WP-170-FU1` then added **S7** and it means five.
 *    The property these guards do NOT cover — that the
 *    edge carries the door and not the risk ENGINE — is pinned for S3 in
 *    `test/unit/risk/ports.test.ts`, for S4 in
 *    `test/unit/execution-planner/ports.test.ts`, for S5/S6 in
 *    `test/unit/ledger/ports.test.ts`, and for S7 in
 *    `test/unit/strategy-runtime/ports.test.ts`.)*
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
    // RE-DERIVED TWICE SINCE THE COLLAPSE, both times in a round authorized to
    // move it, and each time for a reason recorded here.
    //
    // The collapse's claim was that the body is byte for byte what review
    // rounds 4-9 left in the three deleted copies, and it held from
    // `WP-180-FU2` through `WP-200-FU1`. Then:
    //
    //   `a318a501…dc7826` / 30,179 bytes  the collapse
    //   `1ddba9cd…26b3a9` / 32,765 bytes  `WP-020-FU1`: `WP-200-FU1`'s review
    //                                     round 1 ruled the module's whole
    //                                     APPEND surface in scope
    //                                     (GRANT-AND-WIDEN), and 23
    //                                     `Array.prototype.push` sites became
    //                                     `CreateDataProperty` appends through
    //                                     the new `appendData`, because `push`
    //                                     is `Set` and `Set` consults the
    //                                     prototype chain for the INDEX name
    //   the values below                  `WP-180-FU3`: that round's named
    //                                     successor obligation — the other TEN
    //                                     modules' 77 push sites — is executed
    //                                     through the SAME primitive rather
    //                                     than a second copy of it, so
    //                                     `appendData` is now EXPORTED. The
    //                                     diff is the `export` keyword and the
    //                                     doc comment that records the census.
    //
    // Nothing else about this file's guards changed in either round: the
    // fingerprints below, the match thresholds, the alpha-rename replay, the
    // recursive no-fourth-copy scan and the `exports`/consumer pins are all
    // untouched, and all of them are re-run green in each round's transcript.
    bodySha256: "5761359d12a3b858c9bbfa4f28cf709d2cf365f424679e8efed6c8560ea4d4b6",
    bodyBytes: 33_840,
  },
  {
    subpath: "./schema-arena",
    file: "packages/risk/src/schema-arena.ts",
    marker: /^\/\/ ---- shared body: byte-identical with the mirrored copy -+$/mu,
    // RE-DERIVED ONCE, in `WP-180-FU3`, from `35aaf0b9…3dccc53` / 21,379 bytes.
    // Two changes, both inside that round's grant and both recorded where they
    // live: `ARENA_NODE_TYPES` gains `"null"` with the measurement its own
    // comment demands (`packages/risk/src/schema-arena-null.test.ts`), and
    // `arenaSlot`'s one `Array.prototype.push` becomes a `CreateDataProperty`
    // append through the exported `appendData` — the 77-site conversion's
    // `schema-arena` row. No guard in this file changed.
    bodySha256: "7795b4314eec6ed1c07aaf98f0de609ce14dc69262aab0caa411e51b04e3d36a",
    bodyBytes: 23_159,
  },
];

/**
 * The consumers of the §2.1 door rows, and the edge each row permits.
 *
 * `WP-200-FU1` review round 1, finding M1 added **S5** and **S6**. The two
 * guards below are written over this table, so extending it is the whole
 * change: `packages/ledger` and `packages/pnl` are now held to the same two
 * properties as the original pair — they declare the edge the row permits, and
 * they reach the door only through the package specifier. The DOOR-ONLY half of
 * those rows (no import of the risk engine ROOT, which neither guard here can
 * see because a root specifier ends in neither module name) is pinned in
 * `test/unit/ledger/ports.test.ts`, modelled on `test/unit/risk/ports.test.ts`.
 *
 * `WP-170-FU1` (2026-09-05) added **S7**, `packages/strategy-runtime`, on the
 * same terms — the table grew one row and neither guard below changed. Its
 * door-only half is pinned in `test/unit/strategy-runtime/ports.test.ts`.
 */
const CONSUMERS = [
  { row: "S3", dir: "packages/capital-allocator" },
  { row: "S4", dir: "packages/execution-planner" },
  { row: "S5", dir: "packages/ledger" },
  { row: "S6", dir: "packages/pnl" },
  { row: "S7", dir: "packages/strategy-runtime" },
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
 * Distinctive FRAGMENTS of each body, used as the copy fingerprint.
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
 * WHY NOT "N OF TWELVE WHOLE SOURCE LINES" EITHER — the shape review round 2
 * finding MEDIUM-A defeated, and the reason the table below looks the way it
 * does. Round 1 replaced the conjunction with "at least four of twelve" but
 * kept picking WHOLE STATEMENTS, and nine of the twelve `plain-data` lines were
 * written in four identifiers: `problems`, `problem`, `out`, `state`. The
 * reviewer pasted the whole module at
 * `packages/execution-planner/src/adapted-door.ts` with exactly THREE
 * consistent renames — `problems`→`issues`, `problem`→`issue`, `out`→`dst`,
 * string literals untouched — and it scored **3/12 and EVADED**, while
 * `pnpm typecheck`, `pnpm lint`, `pnpm check:deps` (34/43) and all 138 tests of
 * this package stayed green. That is ordinary paste-and-adapt vocabulary, not
 * an obfuscator. Round 1's own evasion table hid it: its "identifiers renamed"
 * rows renamed `describeValue` and `readPlainData`, which appear in NONE of the
 * twelve lines, so those rows were guaranteed to pass before they were run and
 * measured nothing.
 *
 * THE RULE BOTH TABLES NOW FOLLOW: anchor on what a paste-and-adapt does NOT
 * change. The insight came from `schema-arena` — `_zod` is the LIBRARY's own
 * property name, so a copy cannot rename it and keep working — but only the
 * insight: measuring that module's round-1 set rather than trusting it showed
 * the same defect (below), so both tables were re-derived. Every anchor is one
 * of:
 *
 * - a **refusal payload** — the text this door emits when it says no. An
 *   adapter has no reason to touch it (it names no package), and rewording it
 *   changes what the module SAYS;
 * - a **fixed string** that is not prose: the `"__proto__"` constant the module
 *   must refuse by that exact name, and the `detailsNotAnObject` evidence KEY a
 *   consumer reads;
 * - an **identifier-free expression** — written only in built-ins, literals and
 *   `lib` types (`Object.create(null) as PropertyDescriptor`,
 *   `? Array.prototype : Object.prototype`, `new Map<number, unknown>()`), so
 *   no rename can reach it.
 *
 * **NOT ONE of the fourteen `plain-data` anchors contains a local identifier**,
 * which is the property round 1 lacked. Comparison normalizes runs of
 * whitespace on both sides, so a reindent or a reflow does not help either.
 * {@link MATCH_THRESHOLD} of them make a file a copy: with fourteen anchors,
 * an evader must break **eleven**.
 *
 * THE EVASION BAR, MEASURED RATHER THAN ASSERTED (`WP-180-FU2` remediation
 * round 2). Every variant was derived mechanically from the canonical file by a
 * TypeScript-aware transformer and scored by this file's own matcher; the two
 * marked `compiles` were dropped into `packages/execution-planner/src` and
 * type-checked there:
 *
 * | variant | score | verdict |
 * | --- | --- | --- |
 * | verbatim paste | 14/14 | caught |
 * | round-1 M3: one declared name renamed (`describeValue`) | 14/14 | caught |
 * | **round-2 MEDIUM-A: the reviewer's three renames, verbatim** | **14/14** | **caught** |
 * | all 27 names the module DECLARES renamed | 14/14 | caught |
 * | 30 renames: those 27 + the reviewer's three *(compiles)* | 14/14 | caught |
 * | the same 30, every comment stripped, reindented | 14/14 | caught |
 * | BINDING: the seven refusal payloads reworded, one word each | 7/14 | caught |
 * | BINDING: the five identifier-free expressions restyled | 10/14 | caught |
 * | BINDING: seven payloads reworded + 30 renames + comments stripped | 7/14 | caught |
 * | BINDING: 7 payloads + the evidence key + 3 expressions = 11 broken *(compiles)* | 3/14 | **EVADES** |
 *
 * So the honest bar is: **no identifier rename evades, at any scale** — the
 * whole module can be alpha-renamed and it still scores 14/14. Evasion needs
 * eleven of the fourteen anchors broken, and the cheapest measured way to get
 * there rewords all seven refusal payloads (so the copy no longer says what
 * this door says when it refuses), renames the `detailsNotAnObject` evidence
 * key (so it no longer emits this door's refusal SHAPE), and restyles three of
 * the module's construction expressions. Rewording a payload means CHANGING
 * it: `normalize` collapses string-literal concatenation first, so splitting a
 * payload into runtime-identical halves does not count (round-3 LOW-1 measured
 * that syntactic route and this collapse closing it). The expression restyles
 * remain reachable syntactically; the payload half of the route does not. A genuine re-implementation,
 * sharing behaviour but no text, remains invisible here by construction: this
 * guard answers copy-paste, because pasting is the cheap path back to three
 * implementations, and it does not claim to answer a determined author.
 *
 * `schema-arena` WAS RE-DERIVED TOO, because measuring it refuted the reason it
 * was believed safe: review round 2 reported its set as already robust "because
 * `_zod` is unrenamable", and only three of its twelve round-1 entries were in
 * fact free of local identifiers. The same ladder, with the 23 names that module
 * declares plus 17 of its local and parameter names:
 *
 * | variant | round-1 set | the set below |
 * | --- | --- | --- |
 * | verbatim paste | 12/12 caught | 14/14 caught |
 * | all 23 declared names renamed | 7/12 caught | 14/14 caught |
 * | + 17 local/parameter names renamed | **3/12 EVADES** | 13/14 caught |
 * | + comments stripped and reindented | **3/12 EVADES** | 13/14 caught |
 *
 * (The one anchor that falls at 13/14 does so only because the probe renames
 * `value` inside `{ value: {}, issues: [] }` — `zod`'s own payload property,
 * which a working copy cannot rename. The probe is left un-narrowed so the
 * number stays conservative.)
 *
 * FALSE POSITIVES, MEASURED over all 510 `.ts` files under every workspace
 * member's `src` (`apps/*` included, per finding LOW-B): for `plain-data` the
 * highest score any file other than the canonical one reaches is **2 of 14** —
 * reached twice, by `packages/features/src/materialize.ts` and
 * `packages/features/src/refusals.ts`, which are `WP-160`'s independently
 * written cousins in the same house style. For `schema-arena` it is **0 of 14**:
 * all fourteen are unique to the canonical file. The threshold is 4, so the
 * margin is at least two anchors on both sides.
 */
const FINGERPRINTS: Readonly<Record<string, readonly string[]>> = {
  "packages/risk/src/plain-data.ts": [
    // Refusal payloads: what this door SAYS when it says no.
    "a Proxy: a record is data, and a Proxy is code that answers questions about data — it may answer differently on a second read, omit a property, describe one it does not have, or throw",
    "a non-plain prototype: an inherited property is state the record does not own, and freezing the record cannot freeze it",
    "an accessor property: a getter is code, not data — it can throw, can answer differently on a second read, and cannot be frozen",
    'a "__proto__" property: it is the one property name a strict schema in this repository cannot report as unrecognized, so a field under it could never be validated — and a record whose extra fields cannot be refused is not a record',
    "reading it as data failed unexpectedly; a value that cannot be read is refused rather than emitted (fail closed)",
    "a cycle: a record is a finite tree of data",
    "a sparse array: a record has no holes",
    // Fixed strings that are not prose: the key this module must refuse by that
    // exact name, and the evidence key a consumer reads off a refusal.
    '= "__proto__";',
    "detailsNotAnObject",
    // Identifier-free expressions: built-ins, literals and `lib` types only, so
    // no rename reaches them.
    "Object.create(null) as PropertyDescriptor",
    "? Array.prototype : Object.prototype",
    '? "y" : "ies"',
    "new Map<number, unknown>()",
    ', "value")) return undefined;',
  ],
  // RE-DERIVED IN REMEDIATION ROUND 2 ON THE SAME RULE. Review round 2 reported
  // this module's set as already robust "because `_zod` is unrenamable", and
  // measuring it rather than assuming it showed otherwise: only three of the
  // twelve round-1 entries were free of local identifiers, and the same
  // mechanical alpha-rename that leaves the new `plain-data` set at 14/14 took
  // the round-1 arena set to **3/12 — under the threshold, EVADING**. Six of its
  // entries were whole statements written in `slots`, `internals`, `held`,
  // `given`, `copy`, `target`; two more were `export const` lines naming the
  // constant itself. The entries below are library-fixed instead: `zod`'s own
  // `_zod`/`def`/`constr`/`run`/`check` slot names, its `jitless`/`propValues`
  // switches, the pinned node-type list, and the build-failure messages.
  "packages/risk/src/schema-arena.ts": [
    // Build-failure messages: what this module says when the library moved.
    "the internal layout this arena is pinned to. Re-measure before upgrading.",
    "it could silently discard library state, so this fails the build instead —",
    "re-measure the pinned internals before upgrading the library.",
    "the arena has never measured. Re-measure before upgrading the library.",
    "which the arena cannot copy. A node it cannot copy is a parse it cannot",
    // Strings fixed by the LIBRARY, not by this module's vocabulary.
    "the _zod container of a check copy",
    ": the value handed to the arena is not a schema node (no _zod.def/constr/run)",
    // `"null"` was inserted by `WP-180-FU3` (the arena gained the type, with
    // the measurement `ARENA_NODE_TYPES`' own comment demands). The ANCHOR
    // moves with the list it quotes — it is key material, not an assertion, and
    // its property is unchanged: a copy of this module cannot rename a list of
    // the LIBRARY's own type names and keep working.
    '"array", "boolean", "default", "enum", "literal", "never", "null", "number", "object", "optional", "readonly", "record", "string", "union", "unknown",',
    // Identifier-free expressions over `zod`'s own internal slot names.
    "._zod.run({ value: {}, issues: [] }, ",
    "{ def?: unknown; constr?: unknown; check?: unknown; run?: unknown }",
    "as { _zod?: unknown })._zod;",
    "readonly constr: new (def: unknown) => ",
    ', "jitless", true);',
    ', "propValues"), undefined);',
  ],
};

/**
 * How many fingerprint anchors make a file a copy. Four of fourteen, per
 * module: high enough that no honest file reaches it by coincidence (the
 * measured maximum elsewhere in the workspace is 2), low enough that an evader
 * must break eleven independent anchors — and, since no anchor carries a local
 * identifier, renaming cannot break any of them at all.
 */
const MATCH_THRESHOLD = 4;

/**
 * The smallest fingerprint this file will accept for a module. Three times the
 * threshold, so the ratio that IS the evasion bar cannot be quietly eroded by
 * shortening a table.
 */
const MIN_FINGERPRINT_SIZE = 3 * MATCH_THRESHOLD;

/**
 * Whitespace-insensitive: a copy may reindent or reflow, and often will.
 * Literal concatenation is collapsed first (`"a" + "a"` quote-pairs), so
 * splitting a payload string into runtime-identical concatenated halves does
 * not break an anchor — the round-3 reviewer measured this exact transform
 * defeating seven anchors syntactically, and measured this collapse restoring
 * 14/14 with the workspace false-positive maximum unchanged at 2/14.
 */
function normalize(text: string): string {
  return text.replace(/(["'`])\s*\+\s*\1/gu, "").replace(/\s+/gu, " ");
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
      // Fourteen anchors and a threshold of four: the ratio is the evasion bar,
      // so it is asserted rather than left to the reader to recompute.
      expect((lines ?? []).length, `${module.file} fingerprint size`).toBe(14);
      expect((lines ?? []).length).toBeGreaterThanOrEqual(MIN_FINGERPRINT_SIZE);
      // The detector itself is what is exercised here, not `toContain` — a
      // fingerprint the real matcher cannot find is a fingerprint that is not
      // guarding anything.
      expect(
        matchCount(read(module.file), lines ?? []),
        `${module.file} no longer matches its own fingerprint`,
      ).toBe((lines ?? []).length);
    }
  });

  it("RENAMING DOES NOT HELP, replayed here: the round-2 MEDIUM-A adaptation still scores 14/14", () => {
    // Review round 2's probe, reproduced mechanically so it can never rot: a
    // full copy of `plain-data.ts` with three consistent renames and its string
    // literals untouched. Against the round-1 table it scored 3 of 12 and walked
    // through every gate; against the table above it loses nothing.
    const file = "packages/risk/src/plain-data.ts";
    expect(MODULES.map((module) => module.file)).toContain(file);
    const adapted = read(file)
      .replace(/\bproblems\b/gu, "issues")
      .replace(/\bproblem\b/gu, "issue")
      .replace(/\bout\b/gu, "dst");
    expect(adapted).not.toBe(read(file));
    expect(
      matchCount(adapted, FINGERPRINTS[file] ?? []),
      "the three-rename adaptation is no longer detected",
    ).toBe(14);
  });

  it("RENAMING DOES NOT HELP AT ANY SCALE: every name either module declares, renamed at once", () => {
    // A deliberately CRUDE replacement — whole-word, over the whole file,
    // including comments and string literals. That makes the assertion
    // conservative: a real rename touches only code, so it can only score
    // HIGHER than this. Measured here: 13/14 for `plain-data` and 11/14 for
    // `schema-arena`, both far above the threshold of four; the entries lost are
    // the three refusal texts that happen to contain the English words "state",
    // "internals" and "container".
    const DECLARED = [
      "isProxyValue", "MAX_DEPTH", "describeValue", "PlainDataProblem", "PlainDataString",
      "PlainDataRead", "ReadState", "readPlainData", "readInto", "ownStringKeys", "ownDataValue",
      "ownDataDescriptor", "ownAccessorDescriptor", "defineDataProperty", "FORBIDDEN_KEY",
      "emptyRecord", "dataValue", "SchemaDefault", "DefaultedData", "withSchemaDefaults",
      "targetOf", "copyPlainData", "ownDataDetails", "readObject", "arrayIndex", "reportedLength",
      "readArray", "SCHEMA_ARENA_ERROR", "ARENA_NODE_TYPES", "ArenaPayload", "ArenaNode",
      "ArenaCheck", "ArenaMemo", "emptySlots", "severOrdinaryChain", "defineSlot", "readSlot",
      "isArenaNode", "isArenaCheck", "isFreshOrdinaryContainer", "prototypeFreeContainer",
      "arenaPayload", "ARENA_CONTEXTS", "ARENA_CONTEXT_OF", "arenaContext", "arenaSlot",
      "arenaCheck", "warmNode", "arenaNode", "prototypeFreeParser",
      // …and the locals a paste-and-adapt reaches for first.
      "problems", "problem", "out", "state", "container", "descriptor", "stringKeys", "slots",
      "internals", "held", "given", "arenaDef", "memberPath",
    ];

    for (const module of MODULES) {
      let renamed = read(module.file);
      for (const [index, name] of DECLARED.entries()) {
        renamed = renamed.replace(new RegExp(`\\b${name}\\b`, "gu"), `n${String(index)}_`);
      }
      expect(renamed).not.toBe(read(module.file));
      expect(
        matchCount(renamed, FINGERPRINTS[module.file] ?? []),
        `${module.file} fell to a mass rename`,
      ).toBeGreaterThanOrEqual(2 * MATCH_THRESHOLD);
    }
  });

  it("the scan is non-vacuous, RECURSIVE, and covers apps/* as well as packages/*", () => {
    const files = workspaceSourceFiles();
    expect(files.length).toBeGreaterThan(100);
    for (const module of MODULES) expect(files).toContain(module.file);
    expect(files).toContain("packages/capital-allocator/src/reserve.ts");
    expect(files).toContain("packages/execution-planner/src/pluck.ts");

    // `apps/*` (review round 2, finding LOW-B). `pnpm-workspace.yaml` globs
    // `apps/*` alongside `packages/*`, six apps have `src` trees, and the
    // round-1 walker read none of them: a verbatim `cp` of the door into
    // `apps/trader/src/pasted-door.ts` passed this file 7/7. Every app with a
    // `src` tree is asserted by name, so deleting one from the walk fails here
    // rather than silently shrinking the guard.
    for (const app of [
      "apps/backtest-cli/src/index.ts",
      "apps/control-api/src/index.ts",
      "apps/data-gateway/src/index.ts",
      "apps/ops-cli/src/index.ts",
      "apps/research-worker/src/index.ts",
      "apps/trader/src/index.ts",
    ]) {
      expect(files, `${app} is outside the deletion guard's reach`).toContain(app);
    }
    // …and the descent applies to an app's tree too, not just its top level.
    expect(files).toContain("apps/data-gateway/src/feeds/polymarket.ts");
    expect(files).toContain("apps/ops-cli/src/verify-venue/checks.ts");
    // The THIRD workspace root: nothing else pins that packages/strategies/*
    // members are walked (round-3 LOW-2 — deleting the container branch left
    // every guard green while the scope silently shrank).
    expect(files).toContain("packages/strategies/static-bracket/src/index.ts");
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

  it("NO FOURTH COPY: no file in any package OR APP outside packages/risk carries either body", () => {
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
              ` ${String(lines.length)} fingerprint anchors) — the parse door was collapsed to` +
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

  it("every consumer declares the workspace dependency the §2.1 row permits", () => {
    for (const consumer of CONSUMERS) {
      const manifest: unknown = JSON.parse(read(`${consumer.dir}/package.json`));
      const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies;
      expect(
        dependencies?.["@polymarket-bot/risk"],
        `${consumer.dir} must declare the ${consumer.row} edge`,
      ).toBe("workspace:*");
    }
  });

  it("every consumer imports the door ONLY through the package specifier", () => {
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
