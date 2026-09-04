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

/**
 * `file:line` for every violation whose message contains `needle`. Used where a
 * test needs to assert the exact *set* of findings a construct produces, not
 * just that one of them appeared.
 */
function locationsMatching(report: CheckerJson, needle: string): (string | null)[] {
  return report.violations.filter((entry) => entry.message.includes(needle)).map((entry) => entry.location);
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
      expect(report.allowlist.map((row) => row.id)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
      for (const row of report.allowlist) expect(row.layer).not.toBeNull();
    });
  });
});

/**
 * Round-2 review regressions. The reviewer's round-2 probes showed the
 * hand-rolled lexer was structurally fail-open in three ways: a `/` misread as
 * a regular-expression literal blanked real code, the fixed 96-character
 * lookbehind lost a specifier separated from its keyword by a long comment, and
 * a global read through an alias or through `window.` escaped the call-shape
 * patterns entirely. The orchestrator's binding direction was to rebuild rule
 * 3's scanner on the TypeScript compiler API; every probe below was reproduced
 * on `c9b59b2` (exit 0) before the rebuild. See `docs/handoffs/WP-015.md` →
 * "Review round 2".
 */
describe("dependency-direction check — round-2 review regressions", () => {
  /** Long enough that the old scanner's 96-character lookbehind could not span it. */
  const longComment = `/* ${"pad ".repeat(40)} */`;
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";

  describe("HIGH-1: the regex/division heuristic blanked executable code", () => {
    it("reports `Math.random()` between two division operators", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: "export const x = (value: number | null) => value! / Math.random() / 2;\n",
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("unseeded randomness (`Math.random()`)");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("still ignores an actual regular-expression literal that looks like a violation", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const re = /Math\\.random\\(\\)|process\\.env|node:fs/g;",
              "export const hit = (s: string) => re.test(s);",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("HIGH-2: specifier recognition is positional, not proximity-based", () => {
    it("catches a dynamic import whose specifier follows a long comment", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: `export const f = async () => import(${longComment} "node:fs");\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("catches `export * from` whose specifier follows a long comment", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: `export * from ${longComment} "node:fs";\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("catches a static `require()` specifier in a `.cjs` file", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/probe.cjs": 'module.exports = require("node:fs");\n',
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.cjs:1");
    });

    it("reports a computed `require()` in a restricted package instead of accepting it", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/probe.cjs":
              'const target = "node:fs";\nmodule.exports = require(target);\n',
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("calls `require()` whose specifier is a non-literal expression");
      expect(run.output).toContain("src/probe.cjs:2");
    });

    it("does not treat a locally declared `require` as a module load", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const require = (key: string, version: number): string => `${key}@${version}`;",
              'export const pinned = require("contract", 1);',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("catches `import x = require(...)` and a type-only import", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/strategies/static-bracket/src/equals.ts":
              'import fs = require("node:fs");\nexport const r = fs;\n',
            "packages/strategies/static-bracket/src/typeonly.ts":
              'import type { Stats } from "node:fs";\nexport type S = Stats;\n',
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("src/equals.ts:1");
      expect(run.output).toContain("src/typeonly.ts:1");
    });
  });

  describe("HIGH-3: impure globals are detected by reference, not by call spelling", () => {
    it("catches `window.Date()`", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: "export const t = () => window.Date();\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("clock (`Date()`)");
      // The environment root itself is reported as well.
      expect(run.output).toContain("process global (`window`)");
    });

    it("catches a `Date` alias created as a value", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: "const D = Date;\nexport const t = () => D();\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("clock (`Date` reference");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("catches a global reached through `globalThis[\"...\"]`", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: 'export const r = () => globalThis["Math"].random();\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("unseeded randomness (`Math.random()`)");
    });

    it("sees through parentheses, `as` assertions, and non-null assertions", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "export const r = () => (Math as typeof Math).random();",
              "export const t = () => (Date!)();",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("unseeded randomness (`Math.random()`)");
      expect(run.output).toContain("clock (`Date()`)");
    });

    it("catches a scheduled timer, which is neither deterministic nor synchronous", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: "export const later = (f: () => void) => setTimeout(f, 10);\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("clock/scheduling (`setTimeout`)");
    });
  });

  describe("AST semantics: shadowing, type positions, and the `new Date(argument)` allowance", () => {
    it("does not report a parameter that shadows a global", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "export function f(Date: string) { return Date; }",
              "export function g(process: { id: string }) { return process.id; }",
              "export const h = (fetch: () => string) => fetch();",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("does not report an imported or locally declared binding that shadows a global", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const Math = { random: () => 0.5 } as const;",
              "export const r = () => Math.random();",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("does not report a global name used only in a type position", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "export const iso = (d: Date): string => d.toISOString();",
              "export type Env = typeof process;",
              "export interface Holder { readonly at: Date }",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("does not report a method or property merely named like a global", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const registry = { require: (k: string, v: number) => `${k}${v}` };",
              'export const pinned = registry.require("contract", 1);',
              "export const shape = { Date: 1, process: 2 };",
              "export class Holder { Date(): number { return 0; } }",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("allows `new Date(argument)` and reports `new Date()`", () => {
      const allowed = runChecker(
        buildFixture({
          files: {
            [strategyFile]: "export const at = (ms: number) => new Date(ms).toISOString();\n",
          },
        }),
      );
      expect(allowed.output).toContain("PASS");
      expect(allowed.status).toBe(0);

      const flagged = runChecker(
        buildFixture({ files: { [strategyFile]: "export const now = () => new Date();\n" } }),
      );
      expect(flagged.status).toBe(1);
      expect(flagged.output).toContain("FAIL [F11]");
      expect(flagged.output).toContain("clock (`new Date()`)");
    });

    it("allows pure `Math` members but reports a bare `Math` value reference", () => {
      const pure = runChecker(
        buildFixture({
          files: {
            [strategyFile]: "export const clamp = (a: number, b: number) => Math.min(Math.max(a, 0), b);\n",
          },
        }),
      );
      expect(pure.output).toContain("PASS");
      expect(pure.status).toBe(0);

      const aliased = runChecker(
        buildFixture({ files: { [strategyFile]: "const M = Math;\nexport const r = () => M.random();\n" } }),
      );
      expect(aliased.status).toBe(1);
      expect(aliased.output).toContain("FAIL [F11]");
      expect(aliased.output).toContain("`Math` reference");
    });

    it("applies the same reference semantics to packages/domain (F1)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/domain/src/probe.ts": [
              "const D = Date;",
              "export const stamp = () => D().length;",
              "export const iso = (d: Date): string => d.toISOString();",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F1]");
      expect(run.output).toContain("clock (`Date` reference");
      expect(run.output).toContain("packages/domain/src/probe.ts:1");
      expect(run.output).not.toContain("packages/domain/src/probe.ts:3");
    });
  });

  describe("constructs that make the rules unevaluable are findings, not passes", () => {
    it("reports `eval` and `new Function(...)` in a restricted package", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "export const a = (src: string) => eval(src);",
              "export const b = (src: string) => new Function(src);",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("references `eval`");
      expect(run.output).toContain("references `Function`");
      expect(run.output).toContain("evaluates code no static check can read");
    });

    it("does not report `instanceof Function`, which evaluates nothing", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: "export const isFn = (v: unknown) => v instanceof Function;\n" },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("the scanner fails closed on input it cannot read", () => {
    it("reports an unparseable source file instead of scanning a partial tree", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: 'export const broken = ;\nimport { readFileSync } from "node:fs";\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [CHK]");
      expect(run.output).toContain("could not be parsed");
      expect(run.output).toContain("silently skipped file");
      expect(run.output).toContain("src/probe.ts:1");
    });
  });

  describe("the scanner fails closed when the compiler API is unavailable", () => {
    it("reports a CHK error instead of scanning nothing", () => {
      const root = buildFixture();
      // A stub `typescript` that resolves but exports no compiler API. Both
      // resolution candidates (the checker's own location and the scanned root)
      // find it, so the outcome does not depend on the ambient environment.
      writeFixtureFile(root, path.join("node_modules", "typescript", "package.json"), '{"name":"typescript","version":"0.0.0","main":"index.js"}\n');
      writeFixtureFile(root, path.join("node_modules", "typescript", "index.js"), "module.exports = {};\n");
      writeFixtureFile(root, path.join("tools", "check-dependency-direction.mjs"), readFileSync(checkerPath, "utf8"));

      const copied = path.join(root, "tools", "check-dependency-direction.mjs");
      const result = spawnSync(process.execPath, [copied, "--root", root], { encoding: "utf8", cwd: root });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status).toBe(1);
      expect(output).toContain("FAIL [CHK]");
      expect(output).toContain("TypeScript compiler API could not be loaded");
      expect(output).toContain("rule-3 source scan cannot run");
      expect(output).not.toContain("PASS");
    });
  });
});

/**
 * WP-015 review round 3. The round-2 rebuild recognised a require-load only
 * when the CallExpression callee was the bare identifier `require`, so a
 * purity-restricted package could still reach forbidden modules through
 * `require` aliases and wrappers. Every probe below produced *no* finding on
 * `7de62d0` (exit 0) and must now be caught. `require` is treated as a
 * capability, like the impure-globals detection already treats `Date`/`process`.
 * See `docs/handoffs/WP-015.md` → "Review round 3".
 */
describe("dependency-direction check — round-3 require-family regressions", () => {
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";
  const simulationFile = "packages/simulation/src/probe.ts";

  describe("the require callee is unwrapped and resolved, not matched literally", () => {
    it("catches a parenthesized require callee `(require)(...)`", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = (require)("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("catches a require callee behind `as`/non-null wrappers", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: 'export const fs = (require as (m: string) => unknown)!("node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("catches a require alias `const r = require; r(...)`", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: 'const r = require;\nexport const fs = r("node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("catches a chained alias `const a = require; const b = a; b(...)`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: ["const a = require;", "const b = a;", 'export const fs = b("node:fs");'].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("catches property-access require `module.require(...)`", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = module.require("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("catches a `const { require: r } = module` destructure", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: "const { require: r } = module;\nexport const fs = r(\"node:fs\");\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });
  });

  describe("reflection over the require capability", () => {
    it("catches `require.call(thisArg, spec)` with the specifier at index 1", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = require.call(null, "node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("fails closed on `require.apply(thisArg, [...])`, whose specifier is not statically readable", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = require.apply(null, ["node:fs"]);\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("calls `require()` whose specifier is a non-literal expression");
    });
  });

  describe("ambient `declare const require` does not suppress the finding", () => {
    it("catches a call to an ambient-declared require", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "declare const require: (m: string) => unknown;",
              'export const fs = require("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:2");
    });
  });

  describe("node:module / createRequire route", () => {
    it("flags importing `node:module` into a strategy", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: 'import { createRequire } from "node:module";\nexport const make = createRequire;\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:module` (process/environment built-in)");
    });

    it("catches a directly-invoked `createRequire(...)(spec)`", () => {
      // `createRequire` is ambient here so the probe isolates the direct-invoke
      // route (importing it from node:module is its own F3, tested above).
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "declare const createRequire: (p: string) => (m: string) => unknown;",
              'export const fs = createRequire("/tmp/x.js")("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:2");
    });
  });

  describe("the require family reaches a live signer in simulation (F5)", () => {
    it("catches `require(\"ethers\")` through an alias in packages/simulation", () => {
      const run = runChecker(
        buildFixture({
          files: { [simulationFile]: 'const r = require;\nexport const signer = r("ethers");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:2");
    });
  });

  describe("genuine locals and property methods stay clean", () => {
    it("does not flag `registry.require(eventType, version)` on a non-require object", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const registry = { require: (eventType: string, version: number) => `${eventType}@${version}` };",
              'export const pinned = registry.require("MarketDiscovered", 1);',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("does not flag a parameter named `require` that is not the global", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "export function f(require: (key: string) => string) {",
              '  return require("contract");',
              "}",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("does not flag `module` when it is a genuine non-CommonJS local", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const module = { require: (name: string) => name.toUpperCase() };",
              'export const shouted = module.require("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });
});

/**
 * Round 3 enumerated the positions in which a require capability can be *read*.
 * Round 4 showed that enumerating positions is not a total rule: seven legal
 * spellings reached a module while naming none of the handled positions, and
 * each passed silently. The rule is now inverted — any reference to a require
 * capability outside the positions this check analyses is itself a finding —
 * so these probes assert the escape is named, not that the specifier is read.
 */
describe("dependency-direction check — round-4 capability-escape regressions", () => {
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";

  const escapes: ReadonlyArray<{ readonly label: string; readonly source: string; readonly shape: string }> = [
    {
      label: "an object-literal property value: `({ r: require }).r(...)`",
      source: 'export const fs = ({ r: require }).r("node:fs");\n',
      shape: "escapes into an object-literal property value",
    },
    {
      label: "an array-literal element: `[require][0](...)`",
      source: 'export const fs = [require][0]("node:fs");\n',
      shape: "escapes into an array-literal element",
    },
    {
      label: "a property assignment: `exports.load = require` plus a later call",
      source: 'exports.load = require;\nexport const fs = exports.load("node:fs");\n',
      shape: "escapes into the right-hand side of an assignment",
    },
    {
      label: "a reflection argument: `Reflect.apply(require, null, [...])`",
      source: 'export const fs = Reflect.apply(require, null, ["node:fs"]);\n',
      shape: "escapes into a call argument",
    },
    {
      label: "a destructure of an object literal: `const { r } = { r: require }`",
      source: 'const { r } = { r: require };\nexport const fs = r("node:fs");\n',
      shape: "escapes into an object-literal property value",
    },
    {
      label: "a bound wrapper: `require.bind(null)(...)`",
      source: 'export const fs = require.bind(null)("node:fs");\n',
      shape: "escapes into a property read (`.bind`)",
    },
    {
      label: "an assignment to an existing binding: `let r; r = require; r(...)`",
      source: 'let r: unknown;\nr = require;\nexport const fs = (r as (m: string) => unknown)("node:fs");\n',
      shape: "escapes into the right-hand side of an assignment",
    },
  ];

  describe("an unconsumed reference to the require capability is itself a finding", () => {
    for (const probe of escapes) {
      it(`reports the capability escaping into ${probe.label}`, () => {
        const run = runChecker(buildFixture({ files: { [strategyFile]: probe.source } }));
        expect(run.status).toBe(1);
        expect(run.output).toContain("FAIL [F-OPAQUE]");
        expect(run.output).toContain("the CommonJS `require` capability");
        expect(run.output).toContain(probe.shape);
        expect(run.output).toContain("src/probe.ts:");
      });
    }

    it("propagates the rule to an alias reference that itself escapes", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: "const r = require;\nexport const holder = { r };\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("escapes into an object-literal shorthand property");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("resolves `globalThis.require(...)` in a package that runs no globals rule", () => {
      // The globals rule (which reports the `globalThis` reference itself) runs
      // only for packages/domain and packages/strategies/**, so in
      // packages/simulation this construct was silent until round 4.
      const run = runChecker(
        buildFixture({
          files: { "packages/simulation/src/probe.ts": 'export const signer = globalThis.require("ethers");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });

    it("follows a `const m = module` alias, so `m.require(...)` is still read as a load", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: 'const m = module;\nexport const fs = m.require("node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });
  });

  describe("the analysed positions do not additionally flag", () => {
    it("reads the specifier of a tracked alias call without reporting an escape", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'const r = require;\nexport const fs = r("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).not.toContain("F-OPAQUE");
    });

    it("does not report `typeof require`, a shadow-safe test that loads nothing", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const isCjs = typeof require === "function";\n' } }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("a genuine local binding is not a reference to the ambient capability", () => {
    it("does not flag a genuine local function named `require`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const require = (m: string) => ({ stub: m });",
              'export const stub = require("x");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("keeps the round-3 negatives clean under the escape rule", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const registry = { require: (eventType: string, version: number) => `${eventType}@${version}` };",
              'export const pinned = registry.require("MarketDiscovered", 1);',
              "export function load(require: (key: string) => string) {",
              '  return require("contract");',
              "}",
            ].join("\n"),
            "packages/strategies/static-bracket/src/local-module.ts": [
              "const module = { require: (name: string) => name.toUpperCase() };",
              'export const shouted = module.require("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });
});

/**
 * Round 5. `process.getBuiltinModule` is a module loader that never entered the
 * require-family machinery, and `capabilityOf` resolved a *computed* member read
 * to `null`. Composed, the two let a purity-restricted package acquire a working
 * `require` in silence:
 *
 *   const cr = process.getBuiltinModule("node:module")["create" + "Require"](__filename);
 *   cr("ethers");
 *
 * The fix binds `getBuiltinModule` into the same specifier machinery as an
 * import, and makes a computed member read on any capability-bearing expression
 * fail closed. Every probe here was reproduced on `a87f26c` (exit 0) first,
 * except where noted as a pre-existing behaviour re-asserted as a regression.
 */
describe("dependency-direction check — round-5 builtin-loader regressions", () => {
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";
  const simulationFile = "packages/simulation/src/probe.ts";

  describe("a computed member read on a capability fails closed", () => {
    it("closes the review's `getBuiltinModule(...)[\"create\"+\"Require\"]` acquisition", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/simulation/src/probe.cjs": [
              'const cr = process.getBuiltinModule("node:module")["create" + "Require"](__filename);',
              'exports.signer = cr("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("the `node:module` namespace");
      expect(run.output).toContain("is read with a computed member expression");
      expect(run.output).toContain("src/probe.cjs:1");
    });

    it("closes the same acquisition through `require(\"node:module\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/simulation/src/probe.cjs": [
              'const cr = require("node:module")["create" + "Require"](__filename);',
              'exports.signer = cr("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("is read with a computed member expression");
    });

    it("closes it through a namespace import of `node:module`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import * as m from "node:module";',
              'const cr = m["create" + "Require"](__filename);',
              'export const signer = cr("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("the `node:module` namespace");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("closes it through `await import(\"node:module\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "export async function load(): Promise<unknown> {",
              '  const m = await import("node:module");',
              '  return m["create" + "Require"](__filename)("ethers");',
              "}",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("is read with a computed member expression");
    });

    it("closes a computed member on the `process` carrier itself", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'const key = "getBuiltin" + "Module";',
              "export const loader = (process as never)[key];",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("the `process` global");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("reports a computed member on `require` itself", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: ["declare const k: string;", "export const anything = (require as never)[k];"].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("the CommonJS `require` capability");
      expect(run.output).toContain("is read with a computed member expression");
    });
  });

  describe("`process.getBuiltinModule` is classified exactly like an import", () => {
    it("reports `process.getBuiltinModule(\"node:fs\")` in a strategy as F3", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = process.getBuiltinModule("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("reports a computed `getBuiltinModule` specifier as F-OPAQUE", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["declare const target: string;", "export const mod = process.getBuiltinModule(target);"].join(
              "\n",
            ),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("calls `process.getBuiltinModule()` whose specifier is a non-literal expression");
    });

    it("reads the whole static `getBuiltinModule(...).createRequire(...)` chain", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]:
              'export const signer = process.getBuiltinModule("node:module").createRequire(__filename)("ethers");\n',
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });

    it("follows a `const g = process.getBuiltinModule` alias without reporting an escape", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "const g = process.getBuiltinModule;",
              'export const signer = g("node:module").createRequire(__filename)("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).not.toContain("F-OPAQUE");
    });

    it("follows a `const { getBuiltinModule } = process` destructure", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "const { getBuiltinModule } = process;",
              'export const signer = getBuiltinModule("node:module").createRequire(__filename)("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
    });

    it("resolves `globalThis.process.getBuiltinModule` in a package that runs no globals rule", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/ledger/src/probe.ts": [
              'const cr = globalThis.process.getBuiltinModule("node:module")["create" + "Require"](__filename);',
              'export const anything = cr("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("packages/ledger");
    });

    it("reads `process.getBuiltinModule.call(thisArg, specifier)` reflection", () => {
      const run = runChecker(
        buildFixture({
          files: { [strategyFile]: 'export const fs = process.getBuiltinModule.call(null, "node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("reports the builtin loader escaping into a call argument", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "declare function wire(load: unknown): void;",
              "export const done = wire(process.getBuiltinModule);",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("`process.getBuiltinModule`, which loads any Node built-in by name");
      expect(run.output).toContain("escapes into a call argument");
    });
  });

  describe("negatives: the new rules add no noise outside their scope", () => {
    it("leaves `process.getBuiltinModule` alone in an unrestricted package", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "apps/ops-cli/src/probe.ts": [
              'export const fs = process.getBuiltinModule("node:fs");',
              "export const loader = process.getBuiltinModule;",
              "declare const k: string;",
              "export const anything = (process as never)[k];",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("leaves computed access on ordinary objects alone", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const table: Record<string, number> = { a: 1 };",
              "export function pick(key: string): number | undefined {",
              "  return table[key];",
              "}",
            ].join("\n"),
            [simulationFile]: [
              "const rows: Record<string, string> = {};",
              "export const first = [1, 2, 3][Number(\"0\")];",
              "export function row(key: string): string | undefined {",
              "  return rows[key];",
              "}",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("keeps `process` itself a carrier, not a loader, where no globals rule runs", () => {
      // packages/simulation and packages/ledger are not fully purity-restricted:
      // the contract's F5/F4 rows constrain what they *load*, not whether they
      // may read the environment. Making `process` a capability must therefore
      // not turn an ordinary `process.env` read into a finding.
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'export const mode = process.env.RUN_MODE ?? "PAPER";',
              "export const argv = process.argv.slice(2);",
              "export function stop(code: number): void {",
              "  process.exit(code);",
              "}",
            ].join("\n"),
            "packages/ledger/src/probe.ts": [
              "const p = process;",
              'export const mode = p.env.RUN_MODE ?? "PAPER";',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("lets a genuine local named `process` shadow the carrier", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "export function run(process: { table: Record<string, string> }, key: string): string | undefined {",
              "  return process.table[key];",
              "}",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("is deliberately noisy for an unrelated member named `getBuiltinModule`", () => {
      // The same disclosure round 3 made for `createRequire`: the member is
      // matched by name without the shadow test, because the ordinary ways to
      // hold the loader (`const { getBuiltinModule } = process`, an imported
      // `node:process`) all bind genuine declarations. The cost is a finding on
      // an unrelated member of that name — noisy, never silent — and this test
      // pins it so the trade is visible rather than discovered later.
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const api = { getBuiltinModule: (name: string) => name };",
              'export const named = api.getBuiltinModule("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });
  });
});

/**
 * Round 6. The evaluator surface was an identifier list — `eval` and `Function`
 * — so acquiring the very same capability through the `constructor` property was
 * silent AND ran. Both of these exit 0 on `a187ccf` in every purity-restricted
 * package, and both are arbitrary code evaluation (runtime-verified on Node 24,
 * v24.13.0):
 *
 *   (function () {}).constructor('return process.getBuiltinModule("node:fs")')()
 *   queueMicrotask.constructor('return process.getBuiltinModule("node:module")' +
 *                              '.createRequire(process.argv[1])')()
 *
 * The fix treats a member read whose property resolves to `constructor` as
 * evaluator acquisition inside a purity-restricted package, failing CLOSED on
 * the object's type because "is this expression function-valued" is not
 * statically decidable.
 *
 * THE BOUNDARY, stated so a reviewer can disagree with it deliberately:
 *   - Every read is flagged, with no non-function exemption. `[].constructor` is
 *     `Array` and is flagged anyway — the exemption that would clear it is the
 *     same recognised-shape list that rounds 3-6 each found a hole in, and
 *     `[].constructor.constructor` is `Function` regardless.
 *   - *Declaring* a `constructor` member (`class C { constructor() {} }`,
 *     `{ constructor: f }` as an object-literal key) is not a read and stays
 *     clean; this is what keeps `packages/domain/src/errors.ts` passing.
 *   - The rule does not run in unrestricted packages (`apps/**`).
 *   - A property name computed at run time (`f[parts.join("")]`) is not folded
 *     and is a disclosed limit, not a closed one — see the checker header.
 *
 * Every probe below was reproduced as a silent pass (exit 0) on `a187ccf` before
 * the fix, except the ones labelled as pre-existing behaviour or as negatives.
 */
describe("dependency-direction check — round-6 evaluator-acquisition regressions", () => {
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";
  const simulationFile = "packages/simulation/src/probe.ts";
  const ledgerFile = "packages/ledger/src/probe.ts";
  const domainFile = "packages/domain/src/probe.ts";

  const acquisitionMessage = "on any function-valued expression that property IS the `Function` constructor";

  describe("acquiring the `Function` constructor through `.constructor` fails closed", () => {
    it("closes the review's `(function(){}).constructor(...)()` in simulation", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]:
              'export const fs = (function () {}).constructor(\'return process.getBuiltinModule("node:fs")\')();\n',
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("packages/simulation");
      expect(run.output).toContain("reads the `constructor` property (`.constructor`)");
      expect(run.output).toContain(acquisitionMessage);
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("closes `queueMicrotask.constructor(...)()`, which reconstitutes `require`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "declare const queueMicrotask: { constructor: (src: string) => () => (m: string) => unknown };",
              "export const signer = queueMicrotask.constructor(",
              "  'return process.getBuiltinModule(\"node:module\").createRequire(process.argv[1])',",
              ")()('ethers');",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("reads the `constructor` property");
      expect(run.output).toContain("can reconstitute `require`");
    });

    it("closes `constructor(\"return require\")()` in a strategy", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const noop = (): void => {};",
              "const F = (noop as never as { constructor: (src: string) => () => (m: string) => unknown }).constructor;",
              "export const signer = F('return require')()('ethers');",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("packages/strategies/static-bracket");
      expect(run.output).toContain("reads the `constructor` property");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("closes the computed `x[\"constructor\"](...)()` spelling in the ledger", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [ledgerFile]: [
              "declare const x: Record<string, (src: string) => () => unknown>;",
              "export const out = x['constructor']('return process.getBuiltinModule(\"node:fs\")')();",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("packages/ledger");
      expect(run.output).toContain("a `[...]` member read that resolves to `constructor`");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("closes a bare acquisition (no call) in packages/domain", () => {
      const run = runChecker(
        buildFixture({ files: { [domainFile]: "export const F = (function () {}).constructor;\n" } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("packages/domain");
      expect(run.output).toContain("reads the `constructor` property");
    });

    it("flags `[].constructor` too — the boundary refuses a non-function exemption", () => {
      // `[].constructor` is `Array`, not `Function`. It is flagged anyway: this
      // pins the deliberate fail-closed choice so a reviewer can argue with it
      // rather than discover it. `(() => {}).constructor` IS `Function`.
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["export const A = [].constructor;", "export const F = (() => {}).constructor;"].join(
              "\n",
            ),
          },
        }),
      );
      expect(run.status).toBe(1);
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: ["export const A = [].constructor;", "export const F = (() => {}).constructor;"].join(
              "\n",
            ),
          },
        }),
      );
      const acquisitions = report.violations.filter((entry) => entry.message.includes(acquisitionMessage));
      expect(acquisitions).toHaveLength(2);
      expect(acquisitions.map((entry) => entry.location)).toEqual([
        `${simulationFile}:1`,
        `${simulationFile}:2`,
      ]);
    });
  });

  describe("the property name is resolved, not matched literally", () => {
    it("folds a literal concatenation: `f['constr' + 'uctor']`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "declare const f: Record<string, (src: string) => () => unknown>;",
              "export const out = f['constr' + 'uctor']('return 1')();",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("a `[...]` member read that resolves to `constructor`");
    });

    it("folds a file-level string constant: `const k = 'constructor'; f[k]`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const k = 'constructor';",
              "declare const f: Record<string, (src: string) => () => unknown>;",
              "export const out = f[k]('return 1')();",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("a `[...]` member read that resolves to `constructor`");
      expect(run.output).toContain("src/probe.ts:3");
    });

    it("folds a template literal whose every span is constant", () => {
      const run = runChecker(
        buildFixture({
          files: { [domainFile]: ["declare const f: Record<string, unknown>;", "export const out = f[`constr${'uctor'}`];"].join("\n") },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("a `[...]` member read that resolves to `constructor`");
    });

    it("reads the destructured spellings", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [ledgerFile]: [
              "declare const fn: { constructor: (src: string) => () => unknown };",
              "const { constructor: A } = fn;",
              "const { ['constructor']: B } = fn;",
              "export const out = [A, B];",
            ].join("\n"),
            [simulationFile]: [
              "declare const fn: { constructor: (src: string) => () => unknown };",
              "const { constructor } = fn;",
              "export const out = constructor;",
            ].join("\n"),
          },
        }),
      );
      expect(locationsMatching(report, acquisitionMessage)).toEqual([
        `${ledgerFile}:2`,
        `${ledgerFile}:3`,
        `${simulationFile}:2`,
      ]);
    });

    it("reports the construct exactly once when it is also a computed capability read", () => {
      // `const k = "constructor"; require[k]` would fire the round-5
      // computed-capability rule as well; the round-6 finding is the more
      // specific one, so the round-5 rule stands down and there is one finding.
      const report = runCheckerJson(
        buildFixture({
          files: {
            [strategyFile]: ["const k = 'constructor';", "export const F = (require as never)[k];"].join("\n"),
          },
        }),
      );
      const opaque = report.violations.filter((entry) => entry.rule === "F-OPAQUE");
      expect(opaque).toHaveLength(1);
      expect(opaque[0]?.message).toContain(acquisitionMessage);
      expect(opaque[0]?.message).not.toContain("is read with a computed member expression");
    });
  });

  describe("the direct evaluator identifiers still flag (pre-existing behaviour)", () => {
    it("keeps `eval(...)`, `Function(...)` and `new Function(...)` findings", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              "export const a = (src: string) => eval(src);",
              "export const b = (src: string) => new Function(src);",
              "export const c = (src: string) => Function(src);",
            ].join("\n"),
          },
        }),
      );
      const evaluators = report.violations.filter((entry) =>
        entry.message.includes("evaluates code no static check can read"),
      );
      expect(evaluators.map((entry) => entry.location)).toEqual([
        `${simulationFile}:1`,
        `${simulationFile}:2`,
        `${simulationFile}:3`,
      ]);
    });
  });

  describe("negatives: the rule stays inside its boundary", () => {
    it("leaves every `.constructor` spelling alone in an unrestricted package", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "apps/ops-cli/src/probe.ts": [
              "const k = 'constructor';",
              "declare const f: Record<string, unknown>;",
              "export const a = (function () {}).constructor;",
              "export const b = [].constructor;",
              "export const c = f['constructor'];",
              "export const d = f[k];",
              "const { constructor: E } = f as never as { constructor: unknown };",
              "export const e = E;",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("leaves `constructor` DECLARATIONS alone in restricted packages", () => {
      // This is what keeps the shipping `packages/domain/src/errors.ts` clean:
      // it declares seven class constructors and reads none.
      const run = runChecker(
        buildFixture({
          files: {
            [domainFile]: [
              "export class Boom extends Error {",
              "  public constructor(message: string) {",
              "    super(message);",
              "  }",
              "}",
              "export const shape = { constructor: 1 };",
            ].join("\n"),
            [ledgerFile]: [
              "export class Entry {",
              "  public constructor(public readonly id: string) {}",
              "}",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("keeps the round-5 computed-access negatives clean", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              "const table: Record<string, number> = { a: 1 };",
              "export function pick(key: string): number | undefined {",
              "  return table[key];",
              "}",
            ].join("\n"),
            [simulationFile]: [
              "const rows: Record<string, string> = {};",
              "export const first = [1, 2, 3][Number('0')];",
              "export function row(key: string): string | undefined {",
              "  return rows[key];",
              "}",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("does not read a type position as a value", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [domainFile]: [
              "interface Shape {",
              "  readonly id: string;",
              "}",
              "export type Id = Shape['id'];",
              "export type Ctor = Record<string, unknown>['constructor'];",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("keeps this repository passing", () => {
      const run = runChecker(repoRoot);
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("the noise the refused exemption lands on future package owners", () => {
    it("flags ordinary reflective idioms, and pins that the trade is visible", () => {
      // `this.constructor.name` and `v.constructor === Object` load nothing and
      // evaluate nothing. They fail the gate anyway, because the object's type
      // is exactly what this rule refuses to guess. Pinned here so `WP-220` and
      // later owners meet the trade in a test rather than in CI, and so a
      // reviewer who thinks it is the wrong call has something concrete to
      // point at (`docs/handoffs/WP-015.md` known_risks 10).
      const report = runCheckerJson(
        buildFixture({
          files: {
            [ledgerFile]: [
              "export class Entry {",
              "  public label(): string {",
              "    return this.constructor.name;",
              "  }",
              "}",
              "export const isPlain = (v: object): boolean => v.constructor === Object;",
            ].join("\n"),
          },
        }),
      );
      expect(locationsMatching(report, acquisitionMessage)).toEqual([`${ledgerFile}:3`, `${ledgerFile}:6`]);
    });

    it("keeps the documented replacements clean", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [ledgerFile]: [
              "export class Foo {}",
              "export const tag = (v: unknown): string => Object.prototype.toString.call(v);",
              "export const isFoo = (v: unknown): boolean => v instanceof Foo;",
              "export const kind = (v: { kind: string }): string => v.kind;",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });
});

/**
 * Round 7. `process.mainModule` is a live CommonJS `Module` object when the
 * process entry point is CommonJS (runtime-verified on Node v24.13.0), and
 * `require.main` is the *same* object (`require.main === process.mainModule`).
 * The round-6 handoff disclosed this as follow_up 10 and deliberately left it
 * open: `capabilityOf` recognised `process` as a carrier (CAP_PROCESS) but did
 * not recognise its `.mainModule` member as yielding a `Module` capability whose
 * `.require` is the loader. So `process.mainModule.require("ethers")` scanned
 * clean in `packages/simulation` — a silent working synchronous module load.
 *
 * The fix binds `process.mainModule` and `require.main` into the same
 * MODULE-object capability the CommonJS `module` global already is, so `.require`
 * on either is classified exactly like `require(...)`/`module.require(...)`
 * (round 3): a string/no-substitution-template argument is that specifier fed
 * through F1-F8/F11, and a computed argument is `F-OPAQUE`. A computed member on
 * the module object fails closed (round 5), and a bare escape is `F-OPAQUE`
 * (round 4).
 *
 * `process` is a carrier that no escape rule catches, so `process.mainModule`
 * HAD to be recognised or the load stays silent; `require` is itself a loader
 * capability, so an *unresolved* `require.main` was already an escape finding and
 * resolving it only makes the finding the precise specifier classification.
 *
 * Base behaviour on `900b299` was measured per probe. Seven spellings exited 0
 * (silent) in packages that run no impure-global rule (`packages/simulation`,
 * `packages/ledger`). In `packages/domain`/a strategy the incidental `process`
 * read was already flagged, but the module LOAD itself (the signer/built-in the
 * follow_up is about) was unclassified; the fix classifies it as a *second*
 * finding. `require.main.require(...)` was an `F-OPAQUE` escape and is now the
 * precise F-row.
 *
 * THE LEDGER NUANCE, stated so a reviewer is not surprised: `packages/ledger`'s
 * only forbidden-specifier rule is F4 (importing a strategy). It is *permitted*
 * to import a signer such as `ethers`, so `process.mainModule.require("ethers")`
 * in the ledger is clean — exactly as plain `require("ethers")` is. The ledger
 * regression therefore exercises the routes the ledger *does* forbid: the F4
 * strategy-import route and the `F-OPAQUE` computed/escape routes.
 */
describe("dependency-direction check — round-7 mainModule-loader regressions", () => {
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";
  const simulationFile = "packages/simulation/src/probe.ts";
  const ledgerFile = "packages/ledger/src/probe.ts";
  const domainFile = "packages/domain/src/probe.ts";
  const strategyPackageName = "@polymarket-bot/strategy-static-bracket";

  describe("`process.mainModule.require(...)` is a require-load, closing follow_up 10", () => {
    it("closes the review's `process.mainModule.require(\"ethers\")` in simulation (.cjs)", () => {
      const run = runChecker(
        buildFixture({
          files: { "packages/simulation/src/probe.cjs": 'exports.signer = process.mainModule.require("ethers");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.cjs:1");
    });

    it("closes the same load in a `.ts` compiled to CommonJS", () => {
      const run = runChecker(
        buildFixture({ files: { [simulationFile]: 'export const signer = process.mainModule.require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("classifies the signer load in a strategy as F3 (beside the incidental `process` read)", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const signer = process.mainModule.require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      // The `ethers` signing-library load is now named — it was unclassified on
      // `900b299`, where only the incidental `process`-global read flagged.
      expect(run.output).toContain("imports `ethers` (signing library)");
      expect(run.output).toContain("process global (`process.*`)");
    });

    it("classifies the built-in load in packages/domain as F2 (beside the F1 `process` read)", () => {
      const run = runChecker(
        buildFixture({ files: { [domainFile]: 'export const fs = process.mainModule.require("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("imports Node built-in `node:fs`");
      expect(run.output).toContain("FAIL [F2]");
    });
  });

  describe("`require.main` is the same `Module` object", () => {
    it("reads `require.main.require(\"node:fs\")` in a strategy as the precise F3 (was an escape)", () => {
      const run = runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = require.main.require("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });
  });

  describe("the whole carrier chain resolves", () => {
    it("resolves `globalThis.process.mainModule.require(\"ethers\")` in simulation", () => {
      const run = runChecker(
        buildFixture({
          files: { [simulationFile]: 'export const signer = globalThis.process.mainModule.require("ethers");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });

    it("follows a tracked `const p = process; p.mainModule.require(\"ethers\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["const p = process;", 'export const signer = p.mainModule.require("ethers");'].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("follows a `const { mainModule } = process` destructure", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["const { mainModule } = process;", 'export const signer = mainModule.require("ethers");'].join(
              "\n",
            ),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("follows an aliased `const m = process.mainModule; m.require(\"ethers\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["const m = process.mainModule;", 'export const signer = m.require("ethers");'].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("src/probe.ts:2");
    });
  });

  describe("computed forms fail closed", () => {
    it("reports a computed `process.mainModule.require(x)` specifier as F-OPAQUE", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["declare const x: string;", "export const mod = process.mainModule.require(x);"].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("calls `require()` whose specifier is a non-literal expression");
    });

    it("reports a computed member `process.mainModule[\"req\"+\"uire\"](\"node:fs\")` as fail-closed", () => {
      const run = runChecker(
        buildFixture({
          files: { [simulationFile]: 'export const fs = process.mainModule["req" + "uire"]("node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("is read with a computed member expression");
      expect(run.output).toContain("a CommonJS `Module` object");
    });

    it("reports `process.mainModule` escaping into a call argument as F-OPAQUE", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["declare function wire(mod: unknown): void;", "export const done = wire(process.mainModule);"].join(
              "\n",
            ),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("a CommonJS `Module` object");
      expect(run.output).toContain("escapes into a call argument");
    });
  });

  describe("the ledger forbids the routes it forbids, and no more", () => {
    it("closes the F4 strategy-import route through `process.mainModule.require(...)`", () => {
      const run = runChecker(
        buildFixture({
          files: { [ledgerFile]: `export const strat = process.mainModule.require("${strategyPackageName}");\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F4]");
      expect(run.output).toContain("imports strategy implementation `packages/strategies/static-bracket`");
    });

    it("closes the same F4 route through `require.main.require(...)`", () => {
      const run = runChecker(
        buildFixture({
          files: { [ledgerFile]: `export const strat = require.main.require("${strategyPackageName}");\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F4]");
    });

    it("reports a computed `process.mainModule.require(x)` in the ledger as F-OPAQUE", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [ledgerFile]: ["declare const x: string;", "export const mod = process.mainModule.require(x);"].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("packages/ledger");
    });

    it("leaves `process.mainModule.require(\"ethers\")` in the ledger clean — the ledger may import a signer (F4 is its only specifier rule)", () => {
      const run = runChecker(
        buildFixture({ files: { [ledgerFile]: 'export const signer = process.mainModule.require("ethers");\n' } }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("self-audit: the other ambient module-graph routes remain findings", () => {
    it("keeps `module.parent.require(...)` an F-OPAQUE escape (bare `module` is a loader capability)", () => {
      const run = runChecker(
        buildFixture({ files: { [simulationFile]: 'export const signer = module.parent.require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("a CommonJS `Module` object");
    });

    it("keeps `module.children[0].require(...)` an F-OPAQUE escape", () => {
      const run = runChecker(
        buildFixture({ files: { [simulationFile]: 'export const signer = module.children[0].require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
    });
  });

  describe("negatives: the new branch adds no noise outside its scope", () => {
    it("leaves `process.mainModule` alone in an unrestricted package", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "apps/ops-cli/src/probe.ts": [
              'export const signer = process.mainModule.require("ethers");',
              "export const mod = process.mainModule;",
              "export const main = require.main;",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("leaves a legitimately-named local `mainModule` that is not process's alone", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "const mainModule = { require: (_m: string): unknown => undefined };",
              'export const value = mainModule.require("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("keeps this repository passing", () => {
      const run = runChecker(buildFixture());
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });
});

/**
 * Round 8. `collectAliasDecls` tracked DEFAULT and NAMESPACE imports of
 * `node:module` but not NAMED (or renamed) ones, so in `packages/simulation`
 * (where importing `node:module` is not itself a finding — only F5 applies)
 * every named-import spelling reached a working synchronous loader in silence:
 *
 *   import { createRequire as cr, Module as M } from "node:module";
 *   cr(import.meta.url)("ethers");                              // silent — loads
 *   M._load("ethers", new M(import.meta.url), false);          // silent — loads
 *   new M(import.meta.url).require("ethers");                  // silent — loads
 *   M.prototype.require.call(new M(import.meta.url), "ethers"); // silent — loads
 *
 * `capabilityOf` treated the renamed bindings as unrelated locals, so F5 never
 * fired. The fix binds each NAMED/renamed `node:module` export that is a loader
 * surface — `createRequire` (→ createRequire-factory), `Module` (→ the Module
 * class, whose `._load`, `.prototype.require`, and instances' `.require` are
 * loaders, mirroring `module.constructor`), and `register` (→ a dynamic import of
 * its arg-0 specifier) — to the capability its call yields. `builtinModules`,
 * `isBuiltin`, `SourceMap`, `syncBuiltinESMExports`, and `_resolveFilename` load
 * nothing and stay clean. Default and namespace imports already flagged; these
 * probes assert the named forms now do too, with no regression.
 *
 * This closes the last ORDINARY-CODE (non-reflective, single-file, statically
 * named) synchronous-load route. The residuals are inherent to a name-enumeration
 * scanner (reflective acquisition, cross-file injection) — see
 * `docs/handoffs/WP-015.md`.
 */
describe("dependency-direction check — round-8 named-node:module-import regressions", () => {
  const simulationFile = "packages/simulation/src/probe.ts";
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";

  describe("the four review probe spellings load a signer in simulation (F5)", () => {
    it("catches a renamed `createRequire as cr`: `cr(import.meta.url)(\"ethers\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { createRequire as cr, Module as M } from "node:module";',
              'export const signer = cr(import.meta.url)("ethers");',
              "void M;",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("catches `M._load(\"ethers\", new M(import.meta.url), false)`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const signer = M._load("ethers", new M(import.meta.url), false);',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("catches `new M(import.meta.url).require(\"ethers\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const signer = new M(import.meta.url).require("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("catches `M.prototype.require.call(new M(import.meta.url), \"ethers\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const signer = M.prototype.require.call(new M(import.meta.url), "ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:2");
    });
  });

  describe("the unrenamed named forms and the CJS destructure mirror", () => {
    it("catches an unrenamed `import { Module }` then `Module._load(\"ethers\", ...)`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module } from "node:module";',
              'export const signer = Module._load("ethers", null, false);',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("catches the default-style `import { createRequire }` then `createRequire(...)(\"ethers\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { createRequire } from "node:module";',
              'export const signer = createRequire(import.meta.url)("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });

    it("catches the `.cjs` destructure `const { Module } = require(\"node:module\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/simulation/src/probe.cjs": [
              'const { Module } = require("node:module");',
              'exports.signer = new Module(__filename).require("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.cjs:2");
    });

    it("catches the renamed CJS destructure `const { createRequire: cr } = require(\"node:module\")`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "packages/simulation/src/probe.cjs": [
              'const { createRequire: cr } = require("node:module");',
              'exports.signer = cr(__filename)("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.cjs:2");
    });
  });

  describe("the named `register` export is a dynamic-import loader", () => {
    it("classifies `register(\"ethers\")` in simulation as an F5 load", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { register } from "node:module";',
              'export const done = register("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("reports a computed `register(spec)` specifier as F-OPAQUE", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { register } from "node:module";',
              "declare const spec: string;",
              "export const done = register(spec);",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("calls `module.register()` whose specifier is a non-literal expression");
    });
  });

  describe("computed and escaping forms of a named `Module` import fail closed", () => {
    it("reports a computed `M[\"_lo\"+\"ad\"](\"ethers\")` as fail-closed", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const signer = M["_lo" + "ad"]("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("is read with a computed member expression");
      expect(run.output).toContain("the `node:module` `Module` class");
    });

    it("reports a computed `M._load(x)` specifier as F-OPAQUE", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              "declare const x: string;",
              "export const mod = M._load(x);",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("calls `Module._load()` whose specifier is a non-literal expression");
    });

    it("reports a bare `Module` escaping into a call argument as F-OPAQUE", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              "declare function wire(klass: unknown): void;",
              "export const done = wire(M);",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("the `node:module` `Module` class");
      expect(run.output).toContain("escapes into a call argument");
    });
  });

  describe("named imports classify in a strategy (F3), and namespace/default forms do not regress", () => {
    it("classifies a named `Module._load(\"node:fs\")` in a strategy as F3, plus the F3 on the import", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              'import { Module } from "node:module";',
              'export const fs = Module._load("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:module` (process/environment built-in)");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("keeps a namespace `mod.Module._load(\"ethers\")` flagging (no regression)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import * as mod from "node:module";',
              'export const signer = mod.Module._load("ethers", null, false);',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });

    it("keeps a namespace `mod.createRequire(...)(\"ethers\")` flagging (no regression)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import * as mod from "node:module";',
              'export const signer = mod.createRequire(import.meta.url)("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });
  });

  describe("negatives: inert exports and unrestricted packages add no noise", () => {
    it("leaves inert `import { builtinModules, isBuiltin }` used inertly clean in simulation", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { builtinModules, isBuiltin } from "node:module";',
              "export const count = builtinModules.length;",
              'export const yes = isBuiltin("node:fs");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("leaves the named loader imports alone in an unrestricted package (apps/ops-cli)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "apps/ops-cli/src/probe.ts": [
              'import { createRequire as cr, Module as M, register } from "node:module";',
              'export const signer = cr(import.meta.url)("ethers");',
              'export const loaded = M._load("ethers", new M(import.meta.url), false);',
              'export const inst = new M(import.meta.url).require("ethers");',
              'export const done = register("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("leaves a genuine local `Module` unrelated to node:module clean", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "class Module {",
              "  public static _load(_m: string): unknown {",
              "    return undefined;",
              "  }",
              "}",
              'export const value = Module._load("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("keeps this repository passing", () => {
      const run = runChecker(buildFixture());
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });
});

/**
 * Round 9. Rounds 4-8 made the escape rule total over the identifier,
 * property/element-access and CALL forms of a loader capability, but the escape
 * visitor never included `NewExpression` even though `capabilityOf` recognises
 * `new Module(...)` as a `Module` instance whose `.require` is the loader (round
 * 8). So a capability-bearing `new` result that flowed anywhere other than a
 * directly analysed loader member/call was silent — the review probe:
 *
 *   const { Module: M } = require("node:module");
 *   function load(mod) { return mod.require("ethers"); } // param — untracked
 *   load(new M(__filename));                             // new M(...) escapes — silent
 *
 * `mod` is a plain parameter the check does not track (interprocedural dataflow
 * is the WP-030 positive-rule / contract-owner fix, follow_up 8), so the only
 * statically visible loader reference is the `new M(...)` result — and it left
 * as a call argument without a finding. The fix adds `NewExpression` to the
 * escape visitor and consumes a `new M(...)` result only where the module-call
 * visitor already reads it: the direct base of `.require(...)` (absorbed), or an
 * argument of an analysed loader call / `.call`/`.apply` reflection
 * (`M._load("x", new M(u), false)`, `M.prototype.require.call(new M(u), "x")`).
 * Everywhere else it is an F-OPAQUE escape that names the shape.
 *
 * Symmetry: a `require`-capability CALL result that escapes
 * (`pass(createRequire(url))`) was ALREADY caught by the round-4 `CallExpression`
 * arm — a probe confirmed it is not silent — so no code change was needed there;
 * the two tests at the end of this block pin that coverage.
 */
describe("dependency-direction check — round-9 new-result-escape regressions", () => {
  const simulationFile = "packages/simulation/src/probe.ts";
  const strategyFile = "packages/strategies/static-bracket/src/probe.ts";

  describe("a capability-bearing `new` result that escapes is a finding", () => {
    it("closes the review probe `load(new M(__filename))` (the helper param is untracked)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              'const { Module: M } = require("node:module");',
              'function load(mod) { return mod.require("ethers"); }',
              "export const signer = load(new M(__filename));",
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("a CommonJS `Module` object");
      expect(run.output).toContain("escapes into a call argument");
      // The escape is the `new M(...)` argument on line 3, not the untracked
      // `mod.require("ethers")` on line 2 (which stays invisible until the
      // positive rule lands) nor the `const { Module: M }` binding on line 1.
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              'const { Module: M } = require("node:module");',
              'function load(mod) { return mod.require("ethers"); }',
              "export const signer = load(new M(__filename));",
            ].join("\n"),
          },
        }),
      );
      expect(locationsMatching(report, "escapes into")).toEqual(["packages/simulation/src/probe.ts:3"]);
    });

    it("flags the same escape in a strategy, beside the F3 on the `node:module` import", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [strategyFile]: [
              'import { Module as M } from "node:module";',
              "declare function load(mod: unknown): unknown;",
              'export const signer = load(new M("/x"));',
            ].join("\n"),
          },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:module`");
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("escapes into a call argument");
      expect(run.output).toContain("src/probe.ts:3");
    });

    it("reports `[new M(url)]` as an array-literal-element escape", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const arr = [new M("/x")];',
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      const escapes = report.violations.filter((entry) => entry.message.includes("escapes into"));
      expect(escapes.map((entry) => entry.rule)).toEqual(["F-OPAQUE"]);
      expect(escapes.map((entry) => entry.location)).toEqual(["packages/simulation/src/probe.ts:2"]);
      expect(escapes.every((entry) => entry.message.includes("a CommonJS `Module` object"))).toBe(true);
      expect(escapes.every((entry) => entry.message.includes("escapes into an array-literal element"))).toBe(true);
    });

    it("reports `return new M(url)` as a return-value escape", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const f = () => { return new M("/x"); };',
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      const escapes = report.violations.filter((entry) => entry.message.includes("escapes into"));
      expect(escapes.map((entry) => entry.rule)).toEqual(["F-OPAQUE"]);
      expect(escapes.map((entry) => entry.location)).toEqual(["packages/simulation/src/probe.ts:2"]);
      expect(escapes.every((entry) => entry.message.includes("escapes into a return value"))).toBe(true);
    });

    it("consumes the `new M(url)` initializer but flags the tracked alias that escapes (round-4)", () => {
      // `const x = new M(url)` binds a tracked `CAP_MODULE` alias: the
      // initializer is consumed (no escape on line 3), and it is the alias
      // reference `x` leaving as a call argument on line 4 that is the finding.
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              "declare function pass(v: unknown): void;",
              'const x = new M("/x");',
              "export const done = pass(x);",
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      const escapes = report.violations.filter((entry) => entry.message.includes("escapes into"));
      expect(escapes.map((entry) => entry.rule)).toEqual(["F-OPAQUE"]);
      expect(escapes.map((entry) => entry.location)).toEqual(["packages/simulation/src/probe.ts:4"]);
      expect(escapes.every((entry) => entry.message.includes("escapes into a call argument"))).toBe(true);
    });
  });

  describe("the analysed `new`-result positions stay the precise F5 and are not double-reported", () => {
    it("keeps the direct chain `new M(url).require(\"ethers\")` a single F5 (the `new` result is absorbed)", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const signer = new M("/x").require("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      expect(report.violations.map((entry) => entry.rule)).toEqual(["F5"]);
      expect(locationsMatching(report, "escapes into")).toEqual([]);
    });

    it("keeps `M.prototype.require.call(new M(url), \"ethers\")` a single F5 (the `new` result is the analysed thisArg)", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const signer = M.prototype.require.call(new M("/x"), "ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      expect(report.violations.map((entry) => entry.rule)).toEqual(["F5"]);
      expect(locationsMatching(report, "escapes into")).toEqual([]);
    });

    it("keeps `M._load(\"ethers\", new M(url), false)` a single F5 (the `new` result is the analysed parent arg)", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [simulationFile]: [
              'import { Module as M } from "node:module";',
              'export const signer = M._load("ethers", new M("/x"), false);',
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      expect(report.violations.map((entry) => entry.rule)).toEqual(["F5"]);
      expect(locationsMatching(report, "escapes into")).toEqual([]);
    });
  });

  describe("negatives: the `new`-escape rule stays inside its boundary", () => {
    it("leaves a `new Module(...)` that escapes alone in an unrestricted package (apps/ops-cli)", () => {
      const run = runChecker(
        buildFixture({
          files: {
            "apps/ops-cli/src/probe.ts": [
              'import { Module as M } from "node:module";',
              "declare function pass(v: unknown): void;",
              'export const arr = [new M(import.meta.url)];',
              "export const done = pass(new M(import.meta.url));",
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });

    it("leaves a genuine local `class Module {}` instance clean — the capability must come from `node:module`", () => {
      const run = runChecker(
        buildFixture({
          files: {
            [simulationFile]: [
              "class Module {",
              "  public constructor(_path: string) {}",
              "  public require(name: string): unknown {",
              "    return name;",
              "  }",
              "}",
              "declare function pass(v: unknown): void;",
              'export const escaped = pass(new Module("/x"));',
              'export const loaded = new Module("/x").require("ethers");',
            ].join("\n"),
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("symmetry: a `require`-capability CALL result that escapes was already a finding", () => {
    it("pins that `pass(createRequire(url))` (no intervening binding) is an F-OPAQUE call-result escape", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [strategyFile]: [
              'import { createRequire } from "node:module";',
              "declare function pass(v: unknown): void;",
              'export const done = pass(createRequire("/x"));',
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      const escapes = report.violations.filter((entry) => entry.message.includes("escapes into"));
      expect(escapes.map((entry) => entry.rule)).toEqual(["F-OPAQUE"]);
      expect(escapes.map((entry) => entry.location)).toEqual(["packages/strategies/static-bracket/src/probe.ts:3"]);
      expect(escapes.every((entry) => entry.message.includes("the CommonJS `require` capability"))).toBe(true);
      expect(escapes.every((entry) => entry.message.includes("escapes into a call argument"))).toBe(true);
    });

    it("pins that a `const r = createRequire(url)` alias escaping is an F-OPAQUE finding (round-4)", () => {
      const report = runCheckerJson(
        buildFixture({
          files: {
            [strategyFile]: [
              'import { createRequire } from "node:module";',
              "declare function pass(v: unknown): void;",
              'const r = createRequire("/x");',
              "export const done = pass(r);",
            ].join("\n"),
          },
        }),
      );
      expect(report.ok).toBe(false);
      const escapes = report.violations.filter((entry) => entry.message.includes("escapes into"));
      expect(escapes.map((entry) => entry.rule)).toEqual(["F-OPAQUE"]);
      expect(escapes.map((entry) => entry.location)).toEqual(["packages/strategies/static-bracket/src/probe.ts:4"]);
      expect(escapes.every((entry) => entry.message.includes("the CommonJS `require` capability"))).toBe(true);
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
