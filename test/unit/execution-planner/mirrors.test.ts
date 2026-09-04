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
 *    outside `packages/risk` carries either module's body. The scan walks every
 *    `packages/<name>/src` — and `packages/strategies/<name>/src` — recursively,
 *    and it matches by CONTENT, not by filename: a copy renamed `parse-door.ts`,
 *    or pasted into the middle of a larger file, is caught by the same
 *    fingerprint, because renaming the file is the first thing a copy would do.
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
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

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
 * Every `.ts` file under some workspace package's `src`, recursively, with its
 * repository-relative path. Test files are included deliberately: a copy of the
 * door parked in a `.test.ts` is still a second implementation to fix.
 */
function workspaceSourceFiles(): readonly string[] {
  const found: string[] = [];

  const walk = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const childAbsolute = join(absolute, entry);
      const childRelative = `${relative}/${entry}`;
      if (statSync(childAbsolute).isDirectory()) walk(childAbsolute, childRelative);
      else if (entry.endsWith(".ts")) found.push(childRelative);
    }
  };

  const packagesRoot = resolve(repoRoot, "packages");
  for (const entry of readdirSync(packagesRoot)) {
    const packageDir = join(packagesRoot, entry);
    if (!statSync(packageDir).isDirectory()) continue;
    // `packages/strategies/*` nests one level deeper.
    const candidates = existsSync(join(packageDir, "package.json"))
      ? [[packageDir, `packages/${entry}`] as const]
      : readdirSync(packageDir)
          .map((nested) => [join(packageDir, nested), `packages/${entry}/${nested}`] as const)
          .filter(([absolute]) => statSync(absolute).isDirectory());
    for (const [absolute, relative] of candidates) {
      const source = join(absolute, "src");
      if (existsSync(source)) walk(source, `${relative}/src`);
    }
  }

  return found;
}

/**
 * Distinctive lines from each body, used as the copy fingerprint.
 *
 * A whole-body hash catches only a VERBATIM paste. These are exact source lines
 * from deep inside each module — not from its header, and not generic enough to
 * appear in ordinary code — so a copy that edits a comment, reflows a line, or
 * pastes two thirds of the module is still caught. All three must appear in a
 * file for it to be reported, which is what keeps an incidental one-line
 * coincidence from failing this test.
 */
const FINGERPRINTS: Readonly<Record<string, readonly string[]>> = {
  "packages/risk/src/plain-data.ts": [
    "export function readPlainData(",
    "export function ownDataDescriptor(",
    "export function describeValue(",
  ],
  "packages/risk/src/schema-arena.ts": [
    "export function prototypeFreeParser<",
    "function severOrdinaryChain(",
    "function arenaNode(",
  ],
};

describe("the collapsed parse door exists in exactly one package (WP-180-FU2)", () => {
  it("the canonical bodies are the ones the collapse claimed: unchanged, byte for byte", () => {
    for (const module of MODULES) {
      const body = bodyOf(module.file, module.marker);
      expect(Buffer.byteLength(body, "utf8"), `${module.file} body length`).toBe(module.bodyBytes);
      expect(sha256(body), `${module.file} body sha256`).toBe(module.bodySha256);
    }
  });

  it("the fingerprints are non-vacuous: every one of them is in the canonical file", () => {
    for (const module of MODULES) {
      const lines = FINGERPRINTS[module.file];
      expect(lines, `no fingerprint registered for ${module.file}`).toBeDefined();
      expect(lines ?? []).not.toHaveLength(0);
      const text = read(module.file);
      for (const line of lines ?? []) {
        expect(text, `${module.file} no longer contains its own fingerprint: ${line}`).toContain(
          line,
        );
      }
    }
  });

  it("the scan is non-vacuous: it walks every workspace package's src, not one directory", () => {
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
  });

  it("NO FOURTH COPY: no file outside packages/risk carries either module's body", () => {
    const offenders: string[] = [];

    for (const file of workspaceSourceFiles()) {
      if (file.startsWith(`${CANONICAL}/`)) continue;
      const text = read(file);
      for (const module of MODULES) {
        const lines = FINGERPRINTS[module.file] ?? [];
        if (lines.every((line) => text.includes(line))) {
          offenders.push(
            `${file} reproduces the body of ${module.file} — the parse door was collapsed to` +
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
