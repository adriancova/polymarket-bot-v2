/**
 * WP-015 — tests for `tools/check-dependency-direction.mjs`.
 *
 * The checker is exercised as a child process, so these tests assert the exact
 * contract CI depends on: exit status plus actionable output. They import no
 * workspace package.
 *
 * Fixtures are built in temp directories from the *real* manifests and the
 * *real* `docs/contracts/dependency-direction.md`, then mutated. That keeps the
 * seeded-violation tests honest (they run against the shipping contract text,
 * not a hand-written mock of it) and keeps this file free of a private copy of
 * the §2 layer table, which `docs/contracts/dependency-direction.md` §6 names
 * as the way coverage drifts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const checkerPath = path.join(repoRoot, "tools", "check-dependency-direction.mjs");
const contractRel = path.join("docs", "contracts", "dependency-direction.md");

/** Directories the fixture builder mirrors, matching `pnpm-workspace.yaml`. */
const workspaceParents = ["apps", "packages", path.join("packages", "strategies")];

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface CheckerRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

function runChecker(root: string, extraArgs: readonly string[] = []): CheckerRun {
  const result = spawnSync(process.execPath, [checkerPath, "--root", root, ...extraArgs], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? -1, stdout, stderr, output: `${stdout}${stderr}` };
}

interface ReportedPackage {
  readonly dir: string;
  readonly name: string;
  readonly layer: number | null;
}

interface ReportedEdge {
  readonly from: string;
  readonly to: string;
  readonly field: string;
  readonly specifier: string;
}

interface ReportedAllowlistRow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly layer: number | null;
}

interface CheckerJson {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<{
    readonly rule: string;
    readonly subject: string;
    readonly message: string;
    readonly doc: string;
    readonly location: string | null;
  }>;
  readonly packages: readonly ReportedPackage[];
  readonly edges: readonly ReportedEdge[];
  readonly allowlist: readonly ReportedAllowlistRow[];
}

function runCheckerJson(root: string): CheckerJson {
  const run = runChecker(root, ["--json"]);
  return JSON.parse(run.stdout) as CheckerJson;
}

interface Mutations {
  /** Extra workspace dependencies: package directory → dependency name → specifier. */
  readonly addDependencies?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Extra `optionalDependencies`: package directory → dependency name → specifier. */
  readonly addOptionalDependencies?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Package directories whose manifest is removed from the fixture workspace. */
  readonly removePackages?: readonly string[];
  /** Brand-new workspace members: package directory → package name. */
  readonly addPackages?: Readonly<Record<string, string>>;
  /** Extra files: repository-relative POSIX path → contents. */
  readonly files?: Readonly<Record<string, string>>;
  /** Rewrites the copied contract document. */
  readonly patchContract?: (contract: string) => string;
}

function realWorkspaceDirs(): string[] {
  const dirs: string[] = [];
  for (const parent of workspaceParents) {
    const absoluteParent = path.join(repoRoot, parent);
    if (!existsSync(absoluteParent)) continue;
    for (const entry of readdirSync(absoluteParent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = path.join(parent, entry.name);
      if (existsSync(path.join(repoRoot, relative, "package.json"))) dirs.push(relative);
    }
  }
  return dirs.sort();
}

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

/**
 * Builds a temp-directory workspace that mirrors this repository's package
 * graph (names and workspace edges only — no sources), copies the real
 * contract, then applies the requested mutations.
 */
function buildFixture(mutations: Mutations = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "wp015-depdir-"));
  temporaryRoots.push(root);

  writeFixtureFile(root, "pnpm-workspace.yaml", readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"));

  const contract = readFileSync(path.join(repoRoot, contractRel), "utf8");
  writeFixtureFile(root, contractRel, mutations.patchContract ? mutations.patchContract(contract) : contract);

  // The workspace root manifest is present so the fixture proves the checker
  // excludes it from the layered graph (contract §6, "Graph construction").
  writeFixtureFile(
    root,
    "package.json",
    `${JSON.stringify(
      {
        name: "wp015-fixture-root",
        version: "0.0.0",
        private: true,
        devDependencies: { "@polymarket-bot/testkit": "workspace:*" },
      },
      null,
      2,
    )}\n`,
  );

  const removed = new Set(mutations.removePackages ?? []);
  for (const relative of realWorkspaceDirs()) {
    const posixDir = relative.split(path.sep).join("/");
    if (removed.has(posixDir)) continue;
    const real = JSON.parse(readFileSync(path.join(repoRoot, relative, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const workspaceOnly = (block: Record<string, string> | undefined): Record<string, string> => {
      const kept: Record<string, string> = {};
      for (const [name, specifier] of Object.entries(block ?? {})) {
        if (specifier.startsWith("workspace:")) kept[name] = specifier;
      }
      return kept;
    };
    const optional = mutations.addOptionalDependencies?.[posixDir];
    const manifest: Record<string, unknown> = {
      name: real.name,
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { ...workspaceOnly(real.dependencies), ...(mutations.addDependencies?.[posixDir] ?? {}) },
      devDependencies: workspaceOnly(real.devDependencies),
      ...(optional ? { optionalDependencies: optional } : {}),
    };
    writeFixtureFile(root, path.join(relative, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  for (const [dir, name] of Object.entries(mutations.addPackages ?? {})) {
    writeFixtureFile(
      root,
      path.join(dir, "package.json"),
      `${JSON.stringify({ name, version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
    );
  }

  for (const [relativePath, contents] of Object.entries(mutations.files ?? {})) {
    writeFixtureFile(root, relativePath, contents);
  }

  return root;
}

function addAllowlistRow(contract: string, row: string): string {
  const anchor = "| S0 |";
  const index = contract.indexOf(anchor);
  if (index < 0) throw new Error("fixture: §2.1 row S0 not found in the contract document");
  const endOfRow = contract.indexOf("\n", index);
  return `${contract.slice(0, endOfRow + 1)}${row}\n${contract.slice(endOfRow + 1)}`;
}

describe("dependency-direction check on this repository", () => {
  it("passes, and reports the S0 same-layer edge as permitted", () => {
    const run = runChecker(repoRoot);
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("classifies every workspace package into exactly one §2 layer", () => {
    const report = runCheckerJson(repoRoot);
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.packages.length).toBeGreaterThanOrEqual(34);
    for (const entry of report.packages) {
      expect(entry.layer, `${entry.dir} is unclassified`).not.toBeNull();
      expect([0, 1, 2, 3]).toContain(entry.layer);
    }
    const layerOf = (dir: string): number | null =>
      report.packages.find((entry) => entry.dir === dir)?.layer ?? null;
    expect(layerOf("packages/decimal")).toBe(0);
    expect(layerOf("packages/domain")).toBe(0);
    expect(layerOf("packages/strategies/static-bracket")).toBe(1);
    expect(layerOf("packages/event-bus")).toBe(2);
    expect(layerOf("apps/ops-cli")).toBe(3);
  });

  it("builds the §6 graph from declared workspace edges and excludes the root manifest", () => {
    const report = runCheckerJson(repoRoot);
    const edgeKeys = report.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    expect(edgeKeys).toContain("packages/domain -> packages/decimal");
    expect(edgeKeys.some((key) => key.startsWith("."))).toBe(false);
    expect(report.packages.some((entry) => entry.dir === "")).toBe(false);
    const s0 = report.allowlist.find((row) => row.id === "S0");
    expect(s0).toEqual({ id: "S0", from: "packages/domain", to: "packages/decimal", layer: 0 });
  });
});

describe("dependency-direction check on fixture graphs", () => {
  it("passes on an unmutated mirror of this repository's manifests", () => {
    const run = runChecker(buildFixture());
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("fails on a cycle (F9)", () => {
    const root = buildFixture({
      // Both directions are §2.1-listed in this fixture, so only F9 can fire.
      patchContract: (contract) =>
        addAllowlistRow(contract, "| SX | `packages/decimal` → `packages/domain` | 0 | fixture-only row |"),
      addDependencies: { "packages/decimal": { "@polymarket-bot/domain": "workspace:*" } },
    });
    const run = runChecker(root);
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F9]");
    expect(run.output).toContain("circular package dependency");
    expect(run.output).toContain("packages/domain");
    expect(run.output).toContain("packages/decimal");
    expect(run.output).toContain("dependency-direction.md");
  });

  it("fails on an upward edge (F12)", () => {
    const run = runChecker(
      buildFixture({
        addDependencies: { "packages/domain": { "@polymarket-bot/storage-postgres": "workspace:*" } },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F12]");
    expect(run.output).toContain("upward edge `packages/domain` (layer 0) -> `packages/storage-postgres` (layer 2)");
    expect(run.output).toContain("§3 (F12)");
  });

  it("fails on a same-layer edge missing from §2.1 (F13)", () => {
    const run = runChecker(
      buildFixture({ addDependencies: { "packages/oms": { "@polymarket-bot/risk": "workspace:*" } } }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F13]");
    expect(run.output).toContain("same-layer edge `packages/oms` -> `packages/risk` (both layer 1) is not listed in §2.1");
    expect(run.output).toContain("add a cited §2.1 row");
  });

  it("permits a listed same-layer edge (S2) once a strategy declares it", () => {
    const run = runChecker(
      buildFixture({
        addDependencies: {
          "packages/strategies/static-bracket": { "@polymarket-bot/strategy-sdk": "workspace:*" },
        },
      }),
    );
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("fails on forbidden specifiers inside a strategy (F3, F7, F11)", () => {
    const run = runChecker(
      buildFixture({
        files: {
          "packages/strategies/static-bracket/src/leak.ts": [
            'import { readFileSync } from "node:fs";',
            'import { ClobClient } from "@polymarket/clob-client";',
            "export const seed = () => Math.random() + Date.now() + readFileSync.length + ClobClient.length;",
          ].join("\n"),
        },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F3]");
    expect(run.output).toContain("filesystem built-in");
    expect(run.output).toContain("packages/strategies/static-bracket/src/leak.ts:1");
    expect(run.output).toContain("FAIL [F7]");
    expect(run.output).toContain("archived Polymarket client");
    expect(run.output).toContain("FAIL [F11]");
    expect(run.output).toContain("unseeded randomness (`Math.random()`)");
    expect(run.output).toContain("clock (`Date.now()`)");
  });

  it("fails when a package other than polymarket-secure imports the venue SDK (F6)", () => {
    const run = runChecker(
      buildFixture({
        files: { "packages/oms/src/venue.ts": 'import { Client } from "@polymarket/client";\nexport const c = Client;\n' },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F6]");
    expect(run.output).toContain("only `packages/polymarket-secure` may import the venue SDK");
    expect(run.output).toContain("packages/oms/src/venue.ts:1");
  });

  it("allows the venue SDK inside polymarket-secure and Redis inside event-bus (F6, F8 boundaries)", () => {
    const run = runChecker(
      buildFixture({
        files: {
          "packages/polymarket-secure/src/sdk.ts": 'import { Client } from "@polymarket/client";\nexport const c = Client;\n',
          "packages/event-bus/src/redis.ts": 'import { createClient } from "redis";\nexport const c = createClient;\n',
        },
      }),
    );
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("fails when a Redis client is imported outside event-bus (F8)", () => {
    const run = runChecker(
      buildFixture({
        files: { "packages/oms/src/bus.ts": 'import { createClient } from "ioredis";\nexport const c = createClient;\n' },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F8]");
    expect(run.output).toContain("Redis is owned by `packages/event-bus`");
  });

  it("fails when packages/domain imports a Node built-in or reads a process global (F1, F2)", () => {
    const run = runChecker(
      buildFixture({
        files: {
          "packages/domain/src/leak.ts": [
            'import { randomUUID } from "node:crypto";',
            "export const id = () => randomUUID();",
            "export const mode = process.env.RUN_MODE;",
          ].join("\n"),
        },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F2]");
    expect(run.output).toContain("may import no built-in at all");
    expect(run.output).toContain("FAIL [F1]");
    expect(run.output).toContain("process global (`process.*`)");
  });

  it("fails when packages/ledger imports a strategy implementation (F4)", () => {
    const run = runChecker(
      buildFixture({
        files: {
          "packages/ledger/src/leak.ts":
            'import { workspacePackageName } from "@polymarket-bot/strategy-static-bracket";\nexport const n = workspacePackageName;\n',
        },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F4]");
    expect(run.output).toContain("imports strategy implementation `packages/strategies/static-bracket`");
  });

  it("fails when packages/simulation reaches a live signer (F5)", () => {
    const run = runChecker(
      buildFixture({
        files: {
          "packages/simulation/src/leak.ts": 'import { Wallet } from "ethers";\nexport const w = Wallet;\n',
          "packages/simulation/src/leak2.ts":
            'import { secure } from "../../polymarket-secure/src/index.js";\nexport const s = secure;\n',
        },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F5]");
    expect(run.output).toContain("live signer surface: ethers");
    expect(run.output).toContain("live signer surface: packages/polymarket-secure");
  });

  it("fails closed on a workspace package absent from the §2 layer table", () => {
    const run = runChecker(
      buildFixture({ addPackages: { "packages/brand-new": "@polymarket-bot/brand-new" } }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F-CLOSED]");
    expect(run.output).toContain("`packages/brand-new`");
    expect(run.output).toContain("is not classified in §2");
    expect(run.output).toContain("fails closed on an unclassified package");
  });

  it("fails closed on a named §2 entry with no manifest", () => {
    const run = runChecker(buildFixture({ removePackages: ["packages/pnl"] }));
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F-CLOSED]");
    expect(run.output).toContain("classifies `packages/pnl` in layer 1, but that path has no workspace `package.json`");
  });

  it("does not treat a strategy class entry matching zero packages as an error", () => {
    const run = runChecker(buildFixture({ removePackages: ["packages/strategies/static-bracket"] }));
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("fails closed when the §2.1 allowlist cannot be parsed", () => {
    const run = runChecker(
      buildFixture({
        patchContract: (contract) => contract.replace(/^### 2\.1 .*$/m, "### 2.1 (heading renamed by the fixture)").replace(/→/g, "to"),
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [CHK]");
    expect(run.output).toContain("no permitted same-layer edge rows parsed");
  });

  it("ignores forbidden specifiers that appear only in comments or string literals", () => {
    const run = runChecker(
      buildFixture({
        files: {
          "packages/strategies/static-bracket/src/prose.ts": [
            "// A strategy never does: import { readFileSync } from \"node:fs\";",
            "/* and never require(\"ioredis\") either. */",
            'export const note = "do not import @polymarket/client here";',
          ].join("\n"),
        },
      }),
    );
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });
});

/**
 * Round-1 review regressions. Each `it` here reproduces a probe the reviewer ran
 * against commit `c668493` and records the behaviour that replaced it. See
 * `docs/handoffs/WP-015.md` → "Review round 1".
 */
describe("dependency-direction check — round-1 review regressions", () => {
  describe("HIGH: rule-3 scanner bypasses", () => {
    it("catches a template-literal dynamic import specifier (HIGH a)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/leak.ts":
              "export const f = async () => import(`node:fs`);\n",
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("packages/strategies/static-bracket/src/leak.ts:1");
    });

    it("catches a bare `Date()` clock read (HIGH b)", () => {
      const run = runChecker(
        buildFixture({
          files: { "packages/strategies/static-bracket/src/leak.ts": "export const t = () => Date();\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("clock (`Date()`)");
    });

    it("does not report `new Date(<argument>)`, which is deterministic", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/ok.ts":
              "export const at = (ms: number) => new Date(ms).toISOString();\n",
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("applies environment and network globals to a strategy (HIGH c)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/leak.ts": [
              "export const mode = process.env.RUN_MODE;",
              "export const go = async () => fetch('https://example.invalid');",
              "export const t = () => Date();",
              "export const g = globalThis;",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("process global (`process.*`)");
      expect(run.output).toContain("network (`fetch()`)");
      expect(run.output).toContain("process global (`globalThis`)");
      expect(run.output).toContain("clock (`Date()`)");
      // Environment and network are F3 (ADR-005 §1 I/O), the clock is F11.
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("a strategy performs no I/O and reads no environment");
    });

    it("catches a filesystem library that never names `node:fs` (HIGH d)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/leak.ts":
              'import fse from "fs-extra";\nexport const x = fse;\n',
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `fs-extra` (filesystem library)");
    });

    it("reports a dynamic import whose specifier is not statically readable", () => {
      const interpolated = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/leak.ts":
              "export const f = async (n: string) => import(`node:${n}`);\n",
          },
        }),
      );
      expect(interpolated.status).toBe(1);
      expect(interpolated.output).toContain("FAIL [F-OPAQUE]");
      expect(interpolated.output).toContain("an interpolated template literal");

      const variable = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/leak.ts":
              "export const f = async (n: string) => import(n);\n",
          },
        }),
      );
      expect(variable.status).toBe(1);
      expect(variable.output).toContain("FAIL [F-OPAQUE]");
      expect(variable.output).toContain("a non-literal expression");
    });

    it("permits an opaque dynamic import in a composition root, which is not purity-restricted", () => {
      const run = runChecker(
        buildFixture({
          files: { "apps/trader/src/plugin.ts": "export const f = async (n: string) => import(n);\n" },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("MEDIUM-1: graph completeness", () => {
    it("treats `optionalDependencies` as a workspace edge", () => {
      const run = runChecker(
        buildFixture({
          addOptionalDependencies: {
            "packages/domain": { "@polymarket-bot/storage-postgres": "workspace:*" },
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F12]");
      expect(run.output).toContain(
        "upward edge `packages/domain` (layer 0) -> `packages/storage-postgres` (layer 2) via optionalDependencies",
      );
    });

    it("reports a package that declares itself as a cycle (F9)", () => {
      const run = runChecker(
        buildFixture({ addDependencies: { "packages/oms": { "@polymarket-bot/oms": "workspace:*" } } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F9]");
      expect(run.output).toContain("`packages/oms` declares itself as a dependency");
      // Reported once, as a cycle — not additionally as an unlisted same-layer edge.
      expect(run.output).not.toContain("FAIL [F13]");
    });
  });

  describe("MEDIUM-2: literal contents are data, not code", () => {
    it("does not report forbidden-looking text in strings, templates, or comments", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/data.ts": [
              'export const a = `example from "node:fs"`;',
              "export const b = `Math.random()`;",
              'export const c = "Date.now()";',
              "export const d = 'require(\"ioredis\")';",
              'export const e = "@polymarket/clob-client";',
              "// import { readFileSync } from \"node:fs\";",
              '/* process.env.SECRET and import("node:child_process") */',
              "export const f = /Math\\.random\\(/;",
              "export const g = /[\"']/g;",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("still reports genuine imports in the same file as harmless look-alike text", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/mixed.ts": [
              'const note = "this mentions node:fs and Math.random() harmlessly";',
              'import { readFileSync } from "node:fs";',
              'export { createClient } from "ioredis";',
              "export const x = readFileSync.length + note.length;",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("packages/strategies/static-bracket/src/mixed.ts:2");
      expect(run.output).toContain("FAIL [F8]");
      expect(run.output).toContain("packages/strategies/static-bracket/src/mixed.ts:3");
      // The look-alike text on line 1 is not a finding.
      expect(run.output).not.toContain("src/mixed.ts:1");
    });

    it("still scans code inside a template literal's `${...}` interpolation", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/interp.ts":
              "export const s = `seed=${Math.random()}`;\n",
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("unseeded randomness (`Math.random()`)");
    });

    it("is not confused by a regular-expression literal containing quotes", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/regex.ts": [
              "const quoteRe = /[\"']/g;",
              "export const strip = (s: string) => s.replace(quoteRe, '');",
              'import { readFileSync } from "node:fs";',
              "export const r = readFileSync;",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("packages/strategies/static-bracket/src/regex.ts:3");
    });
  });

  describe("LOW: the parsed contract is validated eagerly", () => {
    it("fails on a §2.1 row whose edge cannot be parsed", () => {
      const run = runChecker(
        buildFixture({
          patchContract: (contract) =>
            contract.replace(
              "| S2 | `packages/strategies/*` → `packages/strategy-sdk`",
              "| S2 | `packages/strategies/*` PLUS `packages/strategy-sdk`",
            ),
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [CHK]");
      expect(run.output).toContain("does not state an edge as `from` → `to`");
      expect(run.output).toContain("not silently skipped");
    });

    it("fails on a §2.1 row whose stated layer contradicts §2", () => {
      const run = runChecker(
        buildFixture({
          patchContract: (contract) =>
            contract.replace(
              "| S1 | `packages/strategy-runtime` → `packages/strategy-sdk` | 1 |",
              "| S1 | `packages/strategy-runtime` → `packages/strategy-sdk` | 2 |",
            ),
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [CHK]");
      expect(run.output).toContain('row "S1"');
      expect(run.output).toContain("states layer 2, but §2 classifies its `from` endpoint");
    });

    it("fails on a §2.1 row naming a package §2 does not classify", () => {
      const run = runChecker(
        buildFixture({
          patchContract: (contract) =>
            contract.replace(
              "| S1 | `packages/strategy-runtime` → `packages/strategy-sdk` | 1 |",
              "| S1 | `packages/strategy-runtime` → `packages/nope-not-real` | 1 |",
            ),
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [CHK]");
      expect(run.output).toContain("`packages/nope-not-real`");
      expect(run.output).toContain("§2 classifies no package or class matching it");
    });

    it("fails on a non-numeric §2.1 layer cell", () => {
      const run = runChecker(
        buildFixture({
          patchContract: (contract) =>
            contract.replace(
              "| S0 | `packages/domain` → `packages/decimal` | 0 |",
              "| S0 | `packages/domain` → `packages/decimal` | zero |",
            ),
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [CHK]");
      expect(run.output).toContain('has a non-numeric layer cell "zero"');
      // The row is dropped rather than half-applied, so S0's edge now fails too.
      expect(run.output).toContain("FAIL [F13]");
    });

    it("fails when §2 assigns the same package twice, even within one layer", () => {
      const run = runChecker(
        buildFixture({
          patchContract: (contract) =>
            contract.replace(
              "packages/oms              packages/inventory",
              "packages/oms              packages/inventory\npackages/oms",
            ),
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [CHK]");
      expect(run.output).toContain("lists `packages/oms` twice");
      expect(run.output).toContain("no package appear twice");
    });

    it("still fails when §2 assigns the same package to two different layers", () => {
      const run = runChecker(
        buildFixture({
          patchContract: (contract) =>
            contract.replace(
              "packages/storage-parquet     packages/event-bus",
              "packages/storage-parquet     packages/event-bus\npackages/oms",
            ),
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [CHK]");
      expect(run.output).toContain("exactly one layer per package");
    });

    it("keeps the shipping contract valid under all of the above", () => {
      const report = runCheckerJson(repoRoot);
      expect(report.ok).toBe(true);
      expect(report.allowlist.map((row) => row.id)).toEqual(["S0", "S1", "S2"]);
      for (const row of report.allowlist) expect(row.layer).not.toBeNull();
    });
  });
});

describe("dependency-direction check CLI", () => {
  it("prints usage and exits 0 for --help", () => {
    const result = spawnSync(process.execPath, [checkerPath, "--help"], { encoding: "utf8", cwd: repoRoot });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node tools/check-dependency-direction.mjs");
  });

  it("exits 2 on an unknown argument", () => {
    const result = spawnSync(process.execPath, [checkerPath, "--nope"], { encoding: "utf8", cwd: repoRoot });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument: --nope");
  });

  it("reports the missing contract instead of passing silently", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp015-empty-"));
    temporaryRoots.push(root);
    const run = runChecker(root);
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [CHK]");
    expect(run.output).toContain("could not be read");
  });
});
