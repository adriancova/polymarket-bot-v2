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
 *
 * EVERY CHILD PROCESS HERE IS AWAITED, NEVER SYNCHRONOUS (`CI-1`). Nearly
 * every one of the 187 tests launches the checker. While each launch blocked
 * the vitest worker, the worker's event loop did not turn once for the whole
 * file (measured on a laptop: zero 10 ms timer ticks in 38.7 s; awaited, ~2900
 * ticks in ~31.5 s and a longest gap under 0.25 s), so the reply to vitest's own
 * `onTaskUpdate` RPC sat unread; birpc's 60 s call timeout then fired, and
 * the repository's first GitHub Actions run (36279491795, where this file
 * took 82 s) failed with every test passing. `spawnNode` below yields to the
 * event loop while each child runs. `no-synchronous-spawn.test.ts` keeps the
 * synchronous form out of every test file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const checkerPath = path.join(repoRoot, "tools", "check-dependency-direction.mjs");
const contractRel = path.join("docs", "contracts", "dependency-direction.md");

/** Directories the fixture builder mirrors, matching `pnpm-workspace.yaml`. */
const workspaceParents = ["apps", "packages", path.join("packages", "strategies")];

const temporaryRoots: string[] = [];

/**
 * Children still running. A synchronous launch could never outlive its test;
 * an awaited one can, when its test times out first, so any left over when
 * the file ends is killed here rather than orphaned (`CI-1`).
 */
const liveChildren = new Set<ChildProcess>();

afterAll(() => {
  for (const child of liveChildren) child.kill();
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * What a finished child reported — the fields of the synchronous spawn result
 * this file read before `CI-1`, with the same meanings: `status` is the exit
 * code, or `null` when a signal ended the child; `error` is set when the child
 * could not be started or overflowed `MAX_CHILD_OUTPUT_BYTES`.
 */
interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
}

/**
 * Per-stream output ceiling: the synchronous spawn's default `maxBuffer`, kept
 * so a runaway child still fails its test (the child is killed and `error` is
 * set, as the synchronous form did with `ENOBUFS`) instead of filling memory.
 * The largest real output is the full-repository `--json` report, ~16.5 KB.
 */
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs `node <args>` in `cwd` and resolves once the child has exited and both
 * of its output pipes have closed — without blocking this worker's event loop.
 *
 * It NEVER rejects on a non-zero exit. Most tests here expect the checker to
 * exit 1 (or 2) and assert on that status and on the output that came with
 * it, so a non-zero exit is data, not an error. That is why this is `spawn`
 * with collected streams rather than `promisify(execFile)`: `execFile` rejects
 * on any non-zero exit and reports the status through an `error.code` that is a
 * number for an exit but a string for a spawn failure. Here `close` hands over
 * the exit code and `error` the spawn failure, each through its own channel.
 *
 * `deadlineMs` is optional, and only the two shared repository runs pass it
 * (`CI-2`). When it expires, the child is killed with SIGKILL, because a run
 * past its deadline is abandoned and nothing reads what it would still print.
 * The promise then settles at once with `error` set; it does not wait for
 * `close`, so a child that will not die cannot hold its readers either. If the
 * child is still alive, it stays in `liveChildren` for `afterAll`. Without a
 * deadline a child runs until it ends or its test's timeout fires, as it did
 * before `CI-2`.
 */
function spawnNode(args: readonly string[], cwd: string, deadlineMs?: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    liveChildren.add(child);
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    let error: Error | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: SpawnResult): void => {
      if (deadline !== undefined) clearTimeout(deadline);
      resolve(result);
    };
    const text = (stream: "stdout" | "stderr"): string => Buffer.concat(chunks[stream]).toString("utf8");
    const collect =
      (stream: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        if (bytes[stream] + chunk.length > MAX_CHILD_OUTPUT_BYTES) {
          if (error === undefined) {
            error = new Error(`child ${stream} exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes (node ${args.join(" ")})`);
            child.kill();
          }
          return;
        }
        bytes[stream] += chunk.length;
        chunks[stream].push(chunk);
      };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    // A child that could not be started may never emit `close`; settle now.
    child.on("error", (cause) => {
      liveChildren.delete(child);
      settle({ status: null, stdout: text("stdout"), stderr: text("stderr"), error: error ?? cause });
    });
    child.on("close", (code) => {
      liveChildren.delete(child);
      settle({ status: code, stdout: text("stdout"), stderr: text("stderr"), error });
    });
    if (deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        error ??= new Error(
          `child did not finish within its ${deadlineMs} ms deadline and was killed (node ${args.join(" ")})`,
        );
        child.kill("SIGKILL");
        settle({ status: null, stdout: text("stdout"), stderr: text("stderr"), error });
      }, deadlineMs);
    }
  });
}

interface CheckerRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

async function runChecker(
  root: string,
  extraArgs: readonly string[] = [],
  deadlineMs?: number,
): Promise<CheckerRun> {
  const result = await spawnNode([checkerPath, "--root", root, ...extraArgs], repoRoot, deadlineMs);
  if (result.error) throw result.error;
  const { stdout, stderr } = result;
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

function parseCheckerJson(run: CheckerRun): CheckerJson {
  return JSON.parse(run.stdout) as CheckerJson;
}

async function runCheckerJson(root: string): Promise<CheckerJson> {
  return parseCheckerJson(await runChecker(root, ["--json"]));
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
  /**
   * Workspace dependencies removed from a surviving manifest: package
   * directory → dependency names dropped. Exists so `removePackages` cases
   * stay realistic once real consumers exist — removing
   * `packages/strategies/static-bracket` alone leaves `packages/trading-core`'s
   * real dependency on it dangling (`apps/trader`'s until `CORE-MOVE` moved it,
   * 2026-09-28), and the checker rightly reports `CHK` (`WP-230` integration,
   * 2026-09-05).
   */
  readonly removeDependencies?: Readonly<Record<string, readonly string[]>>;
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
    const dropped = new Set(mutations.removeDependencies?.[posixDir] ?? []);
    const workspaceOnly = (block: Record<string, string> | undefined): Record<string, string> => {
      const kept: Record<string, string> = {};
      for (const [name, specifier] of Object.entries(block ?? {})) {
        if (specifier.startsWith("workspace:") && !dropped.has(name)) kept[name] = specifier;
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

/**
 * The checker's two runs over THIS repository, each made once and shared
 * (`CI-1`).
 *
 * Five tests assert on the unmodified repository: two on the text run
 * (`passes, and reports the S0 same-layer edge as permitted`; round 6's
 * `keeps this repository passing`) and three on the `--json` report
 * (`classifies every workspace package…`, `builds the §6 graph…`, round 1's
 * `keeps the shipping contract valid under all of the above`). Each used to
 * launch its own identical run, and a full-repository run is the slowest thing
 * in this file (~1.2 s alone on a laptop, ~2.5 s under the full suite, 3.6-3.8 s
 * on the GitHub runner — against vitest's 5 s per-test default). Sharing is
 * exact rather than approximate: the command and arguments are unchanged, no
 * test in this file writes inside the repository (every mutation goes to a
 * `mkdtemp` fixture root), and the checker reads only what is on disk — so a
 * second run in the same file could only reproduce the first. "Under all of
 * the above" and "keeps … passing" were never about ordering: the fixtures
 * they follow are copies, and the shipping contract they protect is the one
 * this run reads.
 *
 * HOW A BAD RUN FAILS, AND WHAT IT MAY NOT TAKE WITH IT (`CI-2`, `CI1-L1`).
 * A slow, hung or broken shared run fails exactly the five tests that read it.
 * The other 182 still run.
 *
 * Under `CI-1`, the `beforeAll` hook AWAITED both runs under a 30 s hook
 * timeout. A run that merely rejected already failed only its five readers.
 * A SLOW run did not: the `CI-1` review made the two runs sleep 45 s, and the
 * hook itself timed out (`Hook timed out in 30000ms`), which skipped all 187
 * tests in the file.
 *
 * Now:
 * - `beforeAll` STARTS both runs and returns without awaiting them, so no hook
 *   waits on a child.
 * - Each run carries its own deadline, `REPOSITORY_RUN_DEADLINE_MS`, counted
 *   from its start. At the deadline the child is killed, and the run rejects
 *   with an error that names the deadline.
 * - The deadline sits on the RUN, not on each reader, so the verdict does not
 *   depend on when a reader starts. Consider per-reader timeouts under a 45 s
 *   run: the first reader times out at 30 s; the second starts then, finds the
 *   run finishing at 45 s, and passes. A run over budget would fail one reader
 *   and pass the rest. With the deadline on the run, a run over budget fails
 *   all five, every time.
 * - A no-op `.catch` is attached to each stored promise when it is made. A run
 *   that rejects before any reader awaits it is therefore not an unhandled
 *   rejection. Each reader still awaits the stored promise itself, and fails
 *   with the run's own error.
 * - Each reader has an explicit timeout, `REPOSITORY_READER_TIMEOUT_MS`, set
 *   above the deadline. Both runs start before any test does, so the deadline
 *   always settles a run before a reader's timeout fires.
 */
/**
 * Each shared run's deadline, from measurement. Under `CI-1` it was the ceiling
 * of the hook that awaited both runs:
 * - both runs together took 1.2 s alone and 2.7 s under the full suite, on a
 *   24-thread laptop;
 * - on the GitHub runner one run took up to 3.8 s, so even run one after the
 *   other the pair needs about 7.6 s, too close to vitest's 10 s hook default.
 * 30 s is about 4x that worst case, and about 8x one run, which is now what
 * the deadline bounds.
 */
const REPOSITORY_RUN_DEADLINE_MS = 30_000;

/**
 * Each reader's test timeout: the deadline plus a margin, so the run's own
 * deadline always settles it first. A reader then fails with the run's error,
 * not with vitest's timeout.
 */
const REPOSITORY_READER_TIMEOUT_MS = REPOSITORY_RUN_DEADLINE_MS + 10_000;

const repositoryRuns = new Map<"text" | "json", Promise<CheckerRun>>();

function repositoryRun(mode: "text" | "json"): Promise<CheckerRun> {
  let run = repositoryRuns.get(mode);
  if (run === undefined) {
    run = runChecker(repoRoot, mode === "json" ? ["--json"] : [], REPOSITORY_RUN_DEADLINE_MS);
    // Marks an early rejection as handled. The readers await `run` itself, not
    // this derived promise, so they still see the rejection.
    run.catch(() => undefined);
    repositoryRuns.set(mode, run);
  }
  return run;
}

beforeAll(() => {
  // Started, NOT awaited: a slow run must not time out a hook that every test
  // in this file depends on. The deadline and the `.catch` live in
  // `repositoryRun`.
  void repositoryRun("text");
  void repositoryRun("json");
});

describe("dependency-direction check on this repository", () => {
  it("passes, and reports the S0 same-layer edge as permitted", async () => {
    const run = await repositoryRun("text");
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  }, REPOSITORY_READER_TIMEOUT_MS);

  it("classifies every workspace package into exactly one §2 layer", async () => {
    const report = parseCheckerJson(await repositoryRun("json"));
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
    expect(layerOf("packages/trading-core")).toBe(1);
    expect(layerOf("packages/event-bus")).toBe(2);
    expect(layerOf("apps/ops-cli")).toBe(3);
  }, REPOSITORY_READER_TIMEOUT_MS);

  it("builds the §6 graph from declared workspace edges and excludes the root manifest", async () => {
    const report = parseCheckerJson(await repositoryRun("json"));
    const edgeKeys = report.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    expect(edgeKeys).toContain("packages/domain -> packages/decimal");
    expect(edgeKeys.some((key) => key.startsWith("."))).toBe(false);
    expect(report.packages.some((entry) => entry.dir === "")).toBe(false);
    const s0 = report.allowlist.find((row) => row.id === "S0");
    expect(s0).toEqual({ id: "S0", from: "packages/domain", to: "packages/decimal", layer: 0 });
  }, REPOSITORY_READER_TIMEOUT_MS);
});

describe("dependency-direction check on fixture graphs", () => {
  it("passes on an unmutated mirror of this repository's manifests", async () => {
    const run = await runChecker(buildFixture());
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("fails on a cycle (F9)", async () => {
    const root = buildFixture({
      // Both directions are §2.1-listed in this fixture, so only F9 can fire.
      patchContract: (contract) =>
        addAllowlistRow(contract, "| SX | `packages/decimal` → `packages/domain` | 0 | fixture-only row |"),
      addDependencies: { "packages/decimal": { "@polymarket-bot/domain": "workspace:*" } },
    });
    const run = await runChecker(root);
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F9]");
    expect(run.output).toContain("circular package dependency");
    expect(run.output).toContain("packages/domain");
    expect(run.output).toContain("packages/decimal");
    expect(run.output).toContain("dependency-direction.md");
  });

  it("fails on an upward edge (F12)", async () => {
    const run = await runChecker(
      buildFixture({
        addDependencies: { "packages/domain": { "@polymarket-bot/storage-postgres": "workspace:*" } },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F12]");
    expect(run.output).toContain("upward edge `packages/domain` (layer 0) -> `packages/storage-postgres` (layer 2)");
    expect(run.output).toContain("§3 (F12)");
  });

  it("fails on a same-layer edge missing from §2.1 (F13)", async () => {
    const run = await runChecker(
      buildFixture({ addDependencies: { "packages/oms": { "@polymarket-bot/risk": "workspace:*" } } }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F13]");
    expect(run.output).toContain("same-layer edge `packages/oms` -> `packages/risk` (both layer 1) is not listed in §2.1");
    expect(run.output).toContain("add a cited §2.1 row");
  });

  it("permits a listed same-layer edge (S2) once a strategy declares it", async () => {
    const run = await runChecker(
      buildFixture({
        addDependencies: {
          "packages/strategies/static-bracket": { "@polymarket-bot/strategy-sdk": "workspace:*" },
        },
      }),
    );
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("fails on forbidden specifiers inside a strategy (F3, F7, F11)", async () => {
    const run = await runChecker(
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

  it("fails when a package other than polymarket-secure imports the venue SDK (F6)", async () => {
    const run = await runChecker(
      buildFixture({
        files: { "packages/oms/src/venue.ts": 'import { Client } from "@polymarket/client";\nexport const c = Client;\n' },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F6]");
    expect(run.output).toContain("only `packages/polymarket-secure` may import the venue SDK");
    expect(run.output).toContain("packages/oms/src/venue.ts:1");
  });

  it("allows the venue SDK inside polymarket-secure and Redis inside event-bus (F6, F8 boundaries)", async () => {
    const run = await runChecker(
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

  it("fails when a Redis client is imported outside event-bus (F8)", async () => {
    const run = await runChecker(
      buildFixture({
        files: { "packages/oms/src/bus.ts": 'import { createClient } from "ioredis";\nexport const c = createClient;\n' },
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F8]");
    expect(run.output).toContain("Redis is owned by `packages/event-bus`");
  });

  it("fails when packages/domain imports a Node built-in or reads a process global (F1, F2)", async () => {
    const run = await runChecker(
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

  it("fails when packages/ledger imports a strategy implementation (F4)", async () => {
    const run = await runChecker(
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

  it("fails when packages/simulation reaches a live signer (F5)", async () => {
    const run = await runChecker(
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

  it("fails closed on a workspace package absent from the §2 layer table", async () => {
    const run = await runChecker(
      buildFixture({ addPackages: { "packages/brand-new": "@polymarket-bot/brand-new" } }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F-CLOSED]");
    expect(run.output).toContain("`packages/brand-new`");
    expect(run.output).toContain("is not classified in §2");
    expect(run.output).toContain("fails closed on an unclassified package");
  });

  it("fails closed on a named §2 entry with no manifest", async () => {
    const run = await runChecker(buildFixture({ removePackages: ["packages/pnl"] }));
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [F-CLOSED]");
    expect(run.output).toContain("classifies `packages/pnl` in layer 1, but that path has no workspace `package.json`");
  });

  it("does not treat a strategy class entry matching zero packages as an error", async () => {
    const run = await runChecker(
      buildFixture({
        removePackages: ["packages/strategies/static-bracket"],
        removeDependencies: { "packages/trading-core": ["@polymarket-bot/strategy-static-bracket"] },
      }),
    );
    expect(run.output).toContain("PASS");
    expect(run.status).toBe(0);
  });

  it("fails closed when the §2.1 allowlist cannot be parsed", async () => {
    const run = await runChecker(
      buildFixture({
        patchContract: (contract) => contract.replace(/^### 2\.1 .*$/m, "### 2.1 (heading renamed by the fixture)").replace(/→/g, "to"),
      }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [CHK]");
    expect(run.output).toContain("no permitted same-layer edge rows parsed");
  });

  it("ignores forbidden specifiers that appear only in comments or string literals", async () => {
    const run = await runChecker(
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
    it("catches a template-literal dynamic import specifier (HIGH a)", async () => {
      const run = await runChecker(
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

    it("catches a bare `Date()` clock read (HIGH b)", async () => {
      const run = await runChecker(
        buildFixture({
          files: { "packages/strategies/static-bracket/src/leak.ts": "export const t = () => Date();\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("clock (`Date()`)");
    });

    it("does not report `new Date(<argument>)`, which is deterministic", async () => {
      const run = await runChecker(
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

    it("applies environment and network globals to a strategy (HIGH c)", async () => {
      const run = await runChecker(
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

    it("catches a filesystem library that never names `node:fs` (HIGH d)", async () => {
      const run = await runChecker(
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

    it("reports a dynamic import whose specifier is not statically readable", async () => {
      const interpolated = await runChecker(
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

      const variable = await runChecker(
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

    it("permits an opaque dynamic import in a composition root, which is not purity-restricted", async () => {
      const run = await runChecker(
        buildFixture({
          files: { "apps/trader/src/plugin.ts": "export const f = async (n: string) => import(n);\n" },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("MEDIUM-1: graph completeness", () => {
    it("treats `optionalDependencies` as a workspace edge", async () => {
      const run = await runChecker(
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

    it("reports a package that declares itself as a cycle (F9)", async () => {
      const run = await runChecker(
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
    it("does not report forbidden-looking text in strings, templates, or comments", async () => {
      const run = await runChecker(
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

    it("still reports genuine imports in the same file as harmless look-alike text", async () => {
      const run = await runChecker(
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

    it("still scans code inside a template literal's `${...}` interpolation", async () => {
      const run = await runChecker(
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

    it("is not confused by a regular-expression literal containing quotes", async () => {
      const run = await runChecker(
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
    it("fails on a §2.1 row whose edge cannot be parsed", async () => {
      const run = await runChecker(
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

    it("fails on a §2.1 row whose stated layer contradicts §2", async () => {
      const run = await runChecker(
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

    it("fails on a §2.1 row naming a package §2 does not classify", async () => {
      const run = await runChecker(
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

    it("fails on a non-numeric §2.1 layer cell", async () => {
      const run = await runChecker(
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

    it("fails when §2 assigns the same package twice, even within one layer", async () => {
      const run = await runChecker(
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

    it("still fails when §2 assigns the same package to two different layers", async () => {
      const run = await runChecker(
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

    it("keeps the shipping contract valid under all of the above", async () => {
      const report = parseCheckerJson(await repositoryRun("json"));
      expect(report.ok).toBe(true);
      expect(report.allowlist.map((row) => row.id)).toEqual([
        "S0",
        "S1",
        "S2",
        "S3",
        "S4",
        "S5",
        "S6",
        "S7",
        "S8",
        "S9",
        "S10",
        "S11",
        "S12",
        "S13",
        "S14",
        "S15",
        "S16",
        "S17",
        "S18",
        "S19",
      ]);
      for (const row of report.allowlist) expect(row.layer).not.toBeNull();
    }, REPOSITORY_READER_TIMEOUT_MS);
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
    it("reports `Math.random()` between two division operators", async () => {
      const run = await runChecker(
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

    it("still ignores an actual regular-expression literal that looks like a violation", async () => {
      const run = await runChecker(
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
    it("catches a dynamic import whose specifier follows a long comment", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: `export const f = async () => import(${longComment} "node:fs");\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("catches `export * from` whose specifier follows a long comment", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: `export * from ${longComment} "node:fs";\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("catches a static `require()` specifier in a `.cjs` file", async () => {
      const run = await runChecker(
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

    it("reports a computed `require()` in a restricted package instead of accepting it", async () => {
      const run = await runChecker(
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

    it("does not treat a locally declared `require` as a module load", async () => {
      const run = await runChecker(
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

    it("catches `import x = require(...)` and a type-only import", async () => {
      const run = await runChecker(
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
    it("catches `window.Date()`", async () => {
      const run = await runChecker(
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

    it("catches a `Date` alias created as a value", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: "const D = Date;\nexport const t = () => D();\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F11]");
      expect(run.output).toContain("clock (`Date` reference");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("catches a global reached through `globalThis[\"...\"]`", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: 'export const r = () => globalThis["Math"].random();\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("unseeded randomness (`Math.random()`)");
    });

    it("sees through parentheses, `as` assertions, and non-null assertions", async () => {
      const run = await runChecker(
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

    it("catches a scheduled timer, which is neither deterministic nor synchronous", async () => {
      const run = await runChecker(
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
    it("does not report a parameter that shadows a global", async () => {
      const run = await runChecker(
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

    it("does not report an imported or locally declared binding that shadows a global", async () => {
      const run = await runChecker(
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

    it("does not report a global name used only in a type position", async () => {
      const run = await runChecker(
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

    it("does not report a method or property merely named like a global", async () => {
      const run = await runChecker(
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

    it("allows `new Date(argument)` and reports `new Date()`", async () => {
      const allowed = await runChecker(
        buildFixture({
          files: {
            [strategyFile]: "export const at = (ms: number) => new Date(ms).toISOString();\n",
          },
        }),
      );
      expect(allowed.output).toContain("PASS");
      expect(allowed.status).toBe(0);

      const flagged = await runChecker(
        buildFixture({ files: { [strategyFile]: "export const now = () => new Date();\n" } }),
      );
      expect(flagged.status).toBe(1);
      expect(flagged.output).toContain("FAIL [F11]");
      expect(flagged.output).toContain("clock (`new Date()`)");
    });

    it("allows pure `Math` members but reports a bare `Math` value reference", async () => {
      const pure = await runChecker(
        buildFixture({
          files: {
            [strategyFile]: "export const clamp = (a: number, b: number) => Math.min(Math.max(a, 0), b);\n",
          },
        }),
      );
      expect(pure.output).toContain("PASS");
      expect(pure.status).toBe(0);

      const aliased = await runChecker(
        buildFixture({ files: { [strategyFile]: "const M = Math;\nexport const r = () => M.random();\n" } }),
      );
      expect(aliased.status).toBe(1);
      expect(aliased.output).toContain("FAIL [F11]");
      expect(aliased.output).toContain("`Math` reference");
    });

    it("applies the same reference semantics to packages/domain (F1)", async () => {
      const run = await runChecker(
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
    it("reports `eval` and `new Function(...)` in a restricted package", async () => {
      const run = await runChecker(
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

    it("does not report `instanceof Function`, which evaluates nothing", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: "export const isFn = (v: unknown) => v instanceof Function;\n" },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("the scanner fails closed on input it cannot read", () => {
    it("reports an unparseable source file instead of scanning a partial tree", async () => {
      const run = await runChecker(
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
    it("reports a CHK error instead of scanning nothing", async () => {
      const root = buildFixture();
      // A stub `typescript` that resolves but exports no compiler API. Both
      // resolution candidates (the checker's own location and the scanned root)
      // find it, so the outcome does not depend on the ambient environment.
      writeFixtureFile(root, path.join("node_modules", "typescript", "package.json"), '{"name":"typescript","version":"0.0.0","main":"index.js"}\n');
      writeFixtureFile(root, path.join("node_modules", "typescript", "index.js"), "module.exports = {};\n");
      writeFixtureFile(root, path.join("tools", "check-dependency-direction.mjs"), readFileSync(checkerPath, "utf8"));

      const copied = path.join(root, "tools", "check-dependency-direction.mjs");
      const result = await spawnNode([copied, "--root", root], root);
      const output = `${result.stdout}${result.stderr}`;
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
    it("catches a parenthesized require callee `(require)(...)`", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = (require)("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("catches a require callee behind `as`/non-null wrappers", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: 'export const fs = (require as (m: string) => unknown)!("node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("catches a require alias `const r = require; r(...)`", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: 'const r = require;\nexport const fs = r("node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("catches a chained alias `const a = require; const b = a; b(...)`", async () => {
      const run = await runChecker(
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

    it("catches property-access require `module.require(...)`", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = module.require("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("catches a `const { require: r } = module` destructure", async () => {
      const run = await runChecker(
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
    it("catches `require.call(thisArg, spec)` with the specifier at index 1", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = require.call(null, "node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("fails closed on `require.apply(thisArg, [...])`, whose specifier is not statically readable", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = require.apply(null, ["node:fs"]);\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("calls `require()` whose specifier is a non-literal expression");
    });
  });

  describe("ambient `declare const require` does not suppress the finding", () => {
    it("catches a call to an ambient-declared require", async () => {
      const run = await runChecker(
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
    it("flags importing `node:module` into a strategy", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: 'import { createRequire } from "node:module";\nexport const make = createRequire;\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:module` (process/environment built-in)");
    });

    it("catches a directly-invoked `createRequire(...)(spec)`", async () => {
      // `createRequire` is ambient here so the probe isolates the direct-invoke
      // route (importing it from node:module is its own F3, tested above).
      const run = await runChecker(
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
    it("catches `require(\"ethers\")` through an alias in packages/simulation", async () => {
      const run = await runChecker(
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
    it("does not flag `registry.require(eventType, version)` on a non-require object", async () => {
      const run = await runChecker(
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

    it("does not flag a parameter named `require` that is not the global", async () => {
      const run = await runChecker(
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

    it("does not flag `module` when it is a genuine non-CommonJS local", async () => {
      const run = await runChecker(
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
      it(`reports the capability escaping into ${probe.label}`, async () => {
        const run = await runChecker(buildFixture({ files: { [strategyFile]: probe.source } }));
        expect(run.status).toBe(1);
        expect(run.output).toContain("FAIL [F-OPAQUE]");
        expect(run.output).toContain("the CommonJS `require` capability");
        expect(run.output).toContain(probe.shape);
        expect(run.output).toContain("src/probe.ts:");
      });
    }

    it("propagates the rule to an alias reference that itself escapes", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: "const r = require;\nexport const holder = { r };\n" },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("escapes into an object-literal shorthand property");
      expect(run.output).toContain("src/probe.ts:2");
    });

    it("resolves `globalThis.require(...)` in a package that runs no globals rule", async () => {
      // The globals rule (which reports the `globalThis` reference itself) runs
      // only for packages/domain and packages/strategies/**, so in
      // packages/simulation this construct was silent until round 4.
      const run = await runChecker(
        buildFixture({
          files: { "packages/simulation/src/probe.ts": 'export const signer = globalThis.require("ethers");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });

    it("follows a `const m = module` alias, so `m.require(...)` is still read as a load", async () => {
      const run = await runChecker(
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
    it("reads the specifier of a tracked alias call without reporting an escape", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'const r = require;\nexport const fs = r("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).not.toContain("F-OPAQUE");
    });

    it("does not report `typeof require`, a shadow-safe test that loads nothing", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const isCjs = typeof require === "function";\n' } }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("a genuine local binding is not a reference to the ambient capability", () => {
    it("does not flag a genuine local function named `require`", async () => {
      const run = await runChecker(
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

    it("keeps the round-3 negatives clean under the escape rule", async () => {
      const run = await runChecker(
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
    it("closes the review's `getBuiltinModule(...)[\"create\"+\"Require\"]` acquisition", async () => {
      const run = await runChecker(
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

    it("closes the same acquisition through `require(\"node:module\")`", async () => {
      const run = await runChecker(
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

    it("closes it through a namespace import of `node:module`", async () => {
      const run = await runChecker(
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

    it("closes it through `await import(\"node:module\")`", async () => {
      const run = await runChecker(
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

    it("closes a computed member on the `process` carrier itself", async () => {
      const run = await runChecker(
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

    it("reports a computed member on `require` itself", async () => {
      const run = await runChecker(
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
    it("reports `process.getBuiltinModule(\"node:fs\")` in a strategy as F3", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = process.getBuiltinModule("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("reports a computed `getBuiltinModule` specifier as F-OPAQUE", async () => {
      const run = await runChecker(
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

    it("reads the whole static `getBuiltinModule(...).createRequire(...)` chain", async () => {
      const run = await runChecker(
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

    it("follows a `const g = process.getBuiltinModule` alias without reporting an escape", async () => {
      const run = await runChecker(
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

    it("follows a `const { getBuiltinModule } = process` destructure", async () => {
      const run = await runChecker(
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

    it("resolves `globalThis.process.getBuiltinModule` in a package that runs no globals rule", async () => {
      const run = await runChecker(
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

    it("reads `process.getBuiltinModule.call(thisArg, specifier)` reflection", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [strategyFile]: 'export const fs = process.getBuiltinModule.call(null, "node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });

    it("reports the builtin loader escaping into a call argument", async () => {
      const run = await runChecker(
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
    it("leaves `process.getBuiltinModule` alone in an unrestricted package", async () => {
      const run = await runChecker(
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

    it("leaves computed access on ordinary objects alone", async () => {
      const run = await runChecker(
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

    it("keeps `process` itself a carrier, not a loader, where no globals rule runs", async () => {
      // packages/simulation and packages/ledger are not fully purity-restricted:
      // the contract's F5/F4 rows constrain what they *load*, not whether they
      // may read the environment. Making `process` a capability must therefore
      // not turn an ordinary `process.env` read into a finding.
      const run = await runChecker(
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

    it("lets a genuine local named `process` shadow the carrier", async () => {
      const run = await runChecker(
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

    it("is deliberately noisy for an unrelated member named `getBuiltinModule`", async () => {
      // The same disclosure round 3 made for `createRequire`: the member is
      // matched by name without the shadow test, because the ordinary ways to
      // hold the loader (`const { getBuiltinModule } = process`, an imported
      // `node:process`) all bind genuine declarations. The cost is a finding on
      // an unrelated member of that name — noisy, never silent — and this test
      // pins it so the trade is visible rather than discovered later.
      const run = await runChecker(
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
    it("closes the review's `(function(){}).constructor(...)()` in simulation", async () => {
      const run = await runChecker(
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

    it("closes `queueMicrotask.constructor(...)()`, which reconstitutes `require`", async () => {
      const run = await runChecker(
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

    it("closes `constructor(\"return require\")()` in a strategy", async () => {
      const run = await runChecker(
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

    it("closes the computed `x[\"constructor\"](...)()` spelling in the ledger", async () => {
      const run = await runChecker(
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

    it("closes a bare acquisition (no call) in packages/domain", async () => {
      const run = await runChecker(
        buildFixture({ files: { [domainFile]: "export const F = (function () {}).constructor;\n" } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("packages/domain");
      expect(run.output).toContain("reads the `constructor` property");
    });

    it("flags `[].constructor` too — the boundary refuses a non-function exemption", async () => {
      // `[].constructor` is `Array`, not `Function`. It is flagged anyway: this
      // pins the deliberate fail-closed choice so a reviewer can argue with it
      // rather than discover it. `(() => {}).constructor` IS `Function`.
      const run = await runChecker(
        buildFixture({
          files: {
            [simulationFile]: ["export const A = [].constructor;", "export const F = (() => {}).constructor;"].join(
              "\n",
            ),
          },
        }),
      );
      expect(run.status).toBe(1);
      const report = await runCheckerJson(
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
    it("folds a literal concatenation: `f['constr' + 'uctor']`", async () => {
      const run = await runChecker(
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

    it("folds a file-level string constant: `const k = 'constructor'; f[k]`", async () => {
      const run = await runChecker(
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

    it("folds a template literal whose every span is constant", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [domainFile]: ["declare const f: Record<string, unknown>;", "export const out = f[`constr${'uctor'}`];"].join("\n") },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("a `[...]` member read that resolves to `constructor`");
    });

    it("reads the destructured spellings", async () => {
      const report = await runCheckerJson(
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

    it("reports the construct exactly once when it is also a computed capability read", async () => {
      // `const k = "constructor"; require[k]` would fire the round-5
      // computed-capability rule as well; the round-6 finding is the more
      // specific one, so the round-5 rule stands down and there is one finding.
      const report = await runCheckerJson(
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
    it("keeps `eval(...)`, `Function(...)` and `new Function(...)` findings", async () => {
      const report = await runCheckerJson(
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
    it("leaves every `.constructor` spelling alone in an unrestricted package", async () => {
      const run = await runChecker(
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

    it("leaves `constructor` DECLARATIONS alone in restricted packages", async () => {
      // This is what keeps the shipping `packages/domain/src/errors.ts` clean:
      // it declares seven class constructors and reads none.
      const run = await runChecker(
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

    it("keeps the round-5 computed-access negatives clean", async () => {
      const run = await runChecker(
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

    it("does not read a type position as a value", async () => {
      const run = await runChecker(
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

    it("keeps this repository passing", async () => {
      const run = await repositoryRun("text");
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    }, REPOSITORY_READER_TIMEOUT_MS);
  });

  describe("the noise the refused exemption lands on future package owners", () => {
    it("flags ordinary reflective idioms, and pins that the trade is visible", async () => {
      // `this.constructor.name` and `v.constructor === Object` load nothing and
      // evaluate nothing. They fail the gate anyway, because the object's type
      // is exactly what this rule refuses to guess. Pinned here so `WP-220` and
      // later owners meet the trade in a test rather than in CI, and so a
      // reviewer who thinks it is the wrong call has something concrete to
      // point at (`docs/handoffs/WP-015.md` known_risks 10).
      const report = await runCheckerJson(
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

    it("keeps the documented replacements clean", async () => {
      const run = await runChecker(
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
    it("closes the review's `process.mainModule.require(\"ethers\")` in simulation (.cjs)", async () => {
      const run = await runChecker(
        buildFixture({
          files: { "packages/simulation/src/probe.cjs": 'exports.signer = process.mainModule.require("ethers");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.cjs:1");
    });

    it("closes the same load in a `.ts` compiled to CommonJS", async () => {
      const run = await runChecker(
        buildFixture({ files: { [simulationFile]: 'export const signer = process.mainModule.require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
      expect(run.output).toContain("src/probe.ts:1");
    });

    it("classifies the signer load in a strategy as F3 (beside the incidental `process` read)", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const signer = process.mainModule.require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      // The `ethers` signing-library load is now named — it was unclassified on
      // `900b299`, where only the incidental `process`-global read flagged.
      expect(run.output).toContain("imports `ethers` (signing library)");
      expect(run.output).toContain("process global (`process.*`)");
    });

    it("classifies the built-in load in packages/domain as F2 (beside the F1 `process` read)", async () => {
      const run = await runChecker(
        buildFixture({ files: { [domainFile]: 'export const fs = process.mainModule.require("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("imports Node built-in `node:fs`");
      expect(run.output).toContain("FAIL [F2]");
    });
  });

  describe("`require.main` is the same `Module` object", () => {
    it("reads `require.main.require(\"node:fs\")` in a strategy as the precise F3 (was an escape)", async () => {
      const run = await runChecker(
        buildFixture({ files: { [strategyFile]: 'export const fs = require.main.require("node:fs");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F3]");
      expect(run.output).toContain("imports `node:fs` (filesystem built-in)");
    });
  });

  describe("the whole carrier chain resolves", () => {
    it("resolves `globalThis.process.mainModule.require(\"ethers\")` in simulation", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [simulationFile]: 'export const signer = globalThis.process.mainModule.require("ethers");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F5]");
      expect(run.output).toContain("live signer surface");
    });

    it("follows a tracked `const p = process; p.mainModule.require(\"ethers\")`", async () => {
      const run = await runChecker(
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

    it("follows a `const { mainModule } = process` destructure", async () => {
      const run = await runChecker(
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

    it("follows an aliased `const m = process.mainModule; m.require(\"ethers\")`", async () => {
      const run = await runChecker(
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
    it("reports a computed `process.mainModule.require(x)` specifier as F-OPAQUE", async () => {
      const run = await runChecker(
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

    it("reports a computed member `process.mainModule[\"req\"+\"uire\"](\"node:fs\")` as fail-closed", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [simulationFile]: 'export const fs = process.mainModule["req" + "uire"]("node:fs");\n' },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("is read with a computed member expression");
      expect(run.output).toContain("a CommonJS `Module` object");
    });

    it("reports `process.mainModule` escaping into a call argument as F-OPAQUE", async () => {
      const run = await runChecker(
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
    it("closes the F4 strategy-import route through `process.mainModule.require(...)`", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [ledgerFile]: `export const strat = process.mainModule.require("${strategyPackageName}");\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F4]");
      expect(run.output).toContain("imports strategy implementation `packages/strategies/static-bracket`");
    });

    it("closes the same F4 route through `require.main.require(...)`", async () => {
      const run = await runChecker(
        buildFixture({
          files: { [ledgerFile]: `export const strat = require.main.require("${strategyPackageName}");\n` },
        }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F4]");
    });

    it("reports a computed `process.mainModule.require(x)` in the ledger as F-OPAQUE", async () => {
      const run = await runChecker(
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

    it("leaves `process.mainModule.require(\"ethers\")` in the ledger clean — the ledger may import a signer (F4 is its only specifier rule)", async () => {
      const run = await runChecker(
        buildFixture({ files: { [ledgerFile]: 'export const signer = process.mainModule.require("ethers");\n' } }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("self-audit: the other ambient module-graph routes remain findings", () => {
    it("keeps `module.parent.require(...)` an F-OPAQUE escape (bare `module` is a loader capability)", async () => {
      const run = await runChecker(
        buildFixture({ files: { [simulationFile]: 'export const signer = module.parent.require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
      expect(run.output).toContain("a CommonJS `Module` object");
    });

    it("keeps `module.children[0].require(...)` an F-OPAQUE escape", async () => {
      const run = await runChecker(
        buildFixture({ files: { [simulationFile]: 'export const signer = module.children[0].require("ethers");\n' } }),
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F-OPAQUE]");
    });
  });

  describe("negatives: the new branch adds no noise outside its scope", () => {
    it("leaves `process.mainModule` alone in an unrestricted package", async () => {
      const run = await runChecker(
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

    it("leaves a legitimately-named local `mainModule` that is not process's alone", async () => {
      const run = await runChecker(
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

    it("keeps this repository passing", async () => {
      const run = await runChecker(buildFixture());
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
    it("catches a renamed `createRequire as cr`: `cr(import.meta.url)(\"ethers\")`", async () => {
      const run = await runChecker(
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

    it("catches `M._load(\"ethers\", new M(import.meta.url), false)`", async () => {
      const run = await runChecker(
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

    it("catches `new M(import.meta.url).require(\"ethers\")`", async () => {
      const run = await runChecker(
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

    it("catches `M.prototype.require.call(new M(import.meta.url), \"ethers\")`", async () => {
      const run = await runChecker(
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
    it("catches an unrenamed `import { Module }` then `Module._load(\"ethers\", ...)`", async () => {
      const run = await runChecker(
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

    it("catches the default-style `import { createRequire }` then `createRequire(...)(\"ethers\")`", async () => {
      const run = await runChecker(
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

    it("catches the `.cjs` destructure `const { Module } = require(\"node:module\")`", async () => {
      const run = await runChecker(
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

    it("catches the renamed CJS destructure `const { createRequire: cr } = require(\"node:module\")`", async () => {
      const run = await runChecker(
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
    it("classifies `register(\"ethers\")` in simulation as an F5 load", async () => {
      const run = await runChecker(
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

    it("reports a computed `register(spec)` specifier as F-OPAQUE", async () => {
      const run = await runChecker(
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
    it("reports a computed `M[\"_lo\"+\"ad\"](\"ethers\")` as fail-closed", async () => {
      const run = await runChecker(
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

    it("reports a computed `M._load(x)` specifier as F-OPAQUE", async () => {
      const run = await runChecker(
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

    it("reports a bare `Module` escaping into a call argument as F-OPAQUE", async () => {
      const run = await runChecker(
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
    it("classifies a named `Module._load(\"node:fs\")` in a strategy as F3, plus the F3 on the import", async () => {
      const run = await runChecker(
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

    it("keeps a namespace `mod.Module._load(\"ethers\")` flagging (no regression)", async () => {
      const run = await runChecker(
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

    it("keeps a namespace `mod.createRequire(...)(\"ethers\")` flagging (no regression)", async () => {
      const run = await runChecker(
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
    it("leaves inert `import { builtinModules, isBuiltin }` used inertly clean in simulation", async () => {
      const run = await runChecker(
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

    it("leaves the named loader imports alone in an unrestricted package (apps/ops-cli)", async () => {
      const run = await runChecker(
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

    it("leaves a genuine local `Module` unrelated to node:module clean", async () => {
      const run = await runChecker(
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

    it("keeps this repository passing", async () => {
      const run = await runChecker(buildFixture());
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
    it("closes the review probe `load(new M(__filename))` (the helper param is untracked)", async () => {
      const run = await runChecker(
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
      const report = await runCheckerJson(
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

    it("flags the same escape in a strategy, beside the F3 on the `node:module` import", async () => {
      const run = await runChecker(
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

    it("reports `[new M(url)]` as an array-literal-element escape", async () => {
      const report = await runCheckerJson(
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

    it("reports `return new M(url)` as a return-value escape", async () => {
      const report = await runCheckerJson(
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

    it("consumes the `new M(url)` initializer but flags the tracked alias that escapes (round-4)", async () => {
      // `const x = new M(url)` binds a tracked `CAP_MODULE` alias: the
      // initializer is consumed (no escape on line 3), and it is the alias
      // reference `x` leaving as a call argument on line 4 that is the finding.
      const report = await runCheckerJson(
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
    it("keeps the direct chain `new M(url).require(\"ethers\")` a single F5 (the `new` result is absorbed)", async () => {
      const report = await runCheckerJson(
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

    it("keeps `M.prototype.require.call(new M(url), \"ethers\")` a single F5 (the `new` result is the analysed thisArg)", async () => {
      const report = await runCheckerJson(
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

    it("keeps `M._load(\"ethers\", new M(url), false)` a single F5 (the `new` result is the analysed parent arg)", async () => {
      const report = await runCheckerJson(
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
    it("leaves a `new Module(...)` that escapes alone in an unrestricted package (apps/ops-cli)", async () => {
      const run = await runChecker(
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

    it("leaves a genuine local `class Module {}` instance clean — the capability must come from `node:module`", async () => {
      const run = await runChecker(
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
    it("pins that `pass(createRequire(url))` (no intervening binding) is an F-OPAQUE call-result escape", async () => {
      const report = await runCheckerJson(
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

    it("pins that a `const r = createRequire(url)` alias escaping is an F-OPAQUE finding (round-4)", async () => {
      const report = await runCheckerJson(
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
  it("prints usage and exits 0 for --help", async () => {
    const result = await spawnNode([checkerPath, "--help"], repoRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node tools/check-dependency-direction.mjs");
  });

  it("exits 2 on an unknown argument", async () => {
    const result = await spawnNode([checkerPath, "--nope"], repoRoot);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument: --nope");
  });

  it("reports the missing contract instead of passing silently", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp015-empty-"));
    temporaryRoots.push(root);
    const run = await runChecker(root);
    expect(run.status).toBe(1);
    expect(run.output).toContain("FAIL [CHK]");
    expect(run.output).toContain("could not be read");
  });
});

/**
 * `DEPCHECK-1` — the H8 track's checker-hardening round (`docs/handoffs/H8-GOV.md`,
 * "The optional checker-hardening grant"; `docs/handoffs/DEPCHECK-1.md`).
 *
 * Four holes the H8 scoping measured, each closed in the checker and pinned here:
 * - item 1, F10: a declared edge into an application failed only as F12/F13, and
 *   an app-to-app edge with a §2.1 row passed (probes P2, P3);
 * - item 2: a §2.1 row whose `to` endpoint is an application was accepted;
 * - item 3, the relative half of F16: `apps/backtest-cli/src` importing
 *   `../../trader/src/trader.js` passed (probe P8);
 * - item 4: a §2.1 row matching no declared edge passed silently (ADR-022 D9's
 *   S18 obligation rested on review alone).
 *
 * Every positive test here fails against the checker at `45c575a`; every
 * negative test fails against a named mutant of the new code. Both proofs are in
 * the round record. Each fixture batches its cases into one child process, to
 * keep this file's added wall time small (`CI-1`).
 */
describe("dependency-direction check — DEPCHECK-1 (F10, the §2.1 row CHKs, F16's relative half)", () => {
  /** The violations' machine rule ids, sorted, so a test pins the exact SET a fixture produces. */
  const rulesOf = (report: CheckerJson): string[] => report.violations.map((entry) => entry.rule).sort();

  /**
   * Every real workspace package under `within` that declares `name` as a
   * workspace dependency, as a `removeDependencies` map. A fixture that drops
   * an edge or a package takes its consumers from the real manifests, so it
   * stays exact when later rounds add consumers (`CORE-MOVE` adds
   * `packages/trading-core` with thirteen workspace dependencies).
   */
  const declaring = (name: string, within = ""): Record<string, string[]> => {
    const found: Record<string, string[]> = {};
    for (const relative of realWorkspaceDirs()) {
      const dir = relative.split(path.sep).join("/");
      if (!dir.startsWith(within)) continue;
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, relative, "package.json"), "utf8")) as Readonly<
        Record<string, unknown>
      >;
      const declares = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((field) => {
        const block = manifest[field];
        if (typeof block !== "object" || block === null) return false;
        const specifier = (block as Readonly<Record<string, unknown>>)[name];
        return typeof specifier === "string" && specifier.startsWith("workspace:");
      });
      if (declares) found[dir] = [name];
    }
    return found;
  };

  describe("F10: a declared edge into an application fails, whatever the layers and whatever §2.1 says (item 1)", () => {
    it("P2: an app that declares another app is F10, and not F13, whose `add a row` remedy is forbidden", async () => {
      const root = buildFixture({
        addDependencies: { "apps/backtest-cli": { "@polymarket-bot/trader": "workspace:*" } },
      });
      const [report, run] = await Promise.all([runCheckerJson(root), runChecker(root)]);
      expect(report.ok).toBe(false);
      expect(rulesOf(report)).toEqual(["F10"]);
      const [finding] = report.violations;
      expect(finding?.subject).toBe("apps/backtest-cli");
      expect(finding?.message).toContain("declares the application `apps/trader` via dependencies");
      expect(finding?.doc).toContain("§3 (F10)");
      expect(run.status).toBe(1);
      expect(run.output).toContain("FAIL [F10] apps/backtest-cli");
      expect(run.output).not.toContain("FAIL [F13]");
    });

    it("reports F10 beside F12 from a lower layer, and F10 alone within layer 3, through every dependency field", async () => {
      // Replaces the mirrored `apps/ops-cli` manifest: its real workspace
      // dependencies are kept, and a dev and a peer edge into two apps added.
      const opsCli = JSON.parse(readFileSync(path.join(repoRoot, "apps", "ops-cli", "package.json"), "utf8")) as {
        readonly name: string;
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
      };
      const workspaceOnly = (block: Readonly<Record<string, string>> | undefined): Record<string, string> =>
        Object.fromEntries(Object.entries(block ?? {}).filter(([, specifier]) => specifier.startsWith("workspace:")));
      const report = await runCheckerJson(
        buildFixture({
          addDependencies: { "packages/oms": { "@polymarket-bot/trader": "workspace:*" } },
          addOptionalDependencies: { "packages/features": { "@polymarket-bot/data-gateway": "workspace:*" } },
          files: {
            "apps/ops-cli/package.json": `${JSON.stringify(
              {
                name: opsCli.name,
                version: "0.0.0",
                private: true,
                type: "module",
                dependencies: workspaceOnly(opsCli.dependencies),
                devDependencies: {
                  ...workspaceOnly(opsCli.devDependencies),
                  "@polymarket-bot/research-worker": "workspace:*",
                },
                peerDependencies: { "@polymarket-bot/control-api": "workspace:*" },
              },
              null,
              2,
            )}\n`,
          },
        }),
      );
      // F9 is left out of the pinned set: whether these edges close a cycle
      // depends on the apps' own manifests, which later rounds change.
      expect(rulesOf(report).filter((rule) => rule !== "F9")).toEqual(["F10", "F10", "F10", "F10", "F12", "F12"]);
      const f10 = report.violations.filter((entry) => entry.rule === "F10").map((entry) => entry.message);
      expect(f10).toEqual(
        expect.arrayContaining([
          expect.stringContaining("`packages/oms` declares the application `apps/trader` via dependencies"),
          expect.stringContaining("`packages/features` declares the application `apps/data-gateway` via optionalDependencies"),
          expect.stringContaining("`apps/ops-cli` declares the application `apps/research-worker` via devDependencies"),
          expect.stringContaining("`apps/ops-cli` declares the application `apps/control-api` via peerDependencies"),
        ]),
      );
      // F12 is unchanged: the upward edges still report it, beside F10.
      const f12 = report.violations.filter((entry) => entry.rule === "F12").map((entry) => entry.message);
      expect(f12).toEqual(
        expect.arrayContaining([
          expect.stringContaining("upward edge `packages/oms` (layer 1) -> `apps/trader` (layer 3)"),
          expect.stringContaining("upward edge `packages/features` (layer 1) -> `apps/data-gateway` (layer 3)"),
        ]),
      );
    });
  });

  describe("CHK: a §2.1 row whose `to` endpoint is an application (item 2)", () => {
    const appRow = "| SX | `apps/backtest-cli` → `apps/trader` | 3 | probe P3 |";

    it("P3: an app-to-app row plus its dependency fails with CHK and F10", async () => {
      const report = await runCheckerJson(
        buildFixture({
          patchContract: (contract) => addAllowlistRow(contract, appRow),
          addDependencies: { "apps/backtest-cli": { "@polymarket-bot/trader": "workspace:*" } },
        }),
      );
      expect(rulesOf(report)).toEqual(["CHK", "F10"]);
      const chk = report.violations.find((entry) => entry.rule === "CHK");
      expect(chk?.message).toContain('§2.1 row "SX"');
      expect(chk?.message).toContain("names `apps/trader`, an application, as its `to` endpoint");
      expect(chk?.message).toContain("F10 has no §2.1 exception");
      // The row is still listed as parsed; it is the CHK, not a silent drop.
      expect(report.allowlist.map((row) => row.id)).toContain("SX");
    });

    it("reports the row alone as ONE CHK: it is not also reported as a stale row", async () => {
      const report = await runCheckerJson(
        buildFixture({ patchContract: (contract) => addAllowlistRow(contract, appRow) }),
      );
      expect(rulesOf(report)).toEqual(["CHK"]);
      expect(report.violations[0]?.message).toContain("an application, as its `to` endpoint");
    });

    it("reads the class spelling `apps/*` and a glob whose first segment is not spelled `apps`", async () => {
      const report = await runCheckerJson(
        buildFixture({
          patchContract: (contract) =>
            addAllowlistRow(
              addAllowlistRow(contract, "| SX | `apps/backtest-cli` → `apps/*` | 3 | fixture |"),
              "| SY | `apps/ops-cli` → `a*/trader` | 3 | fixture |",
            ),
        }),
      );
      expect(rulesOf(report)).toEqual(["CHK", "CHK"]);
      const messages = report.violations.map((entry) => entry.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining('row "SX" (line'),
          expect.stringContaining('row "SY" (line'),
        ]),
      );
      for (const message of messages) expect(message).toContain("an application, as its `to` endpoint");
    });
  });

  describe("F16: a relative specifier that leaves its package's root fails (item 3)", () => {
    /** One file per import form the scanner reads, each at line 1, all from `apps/backtest-cli/src`. */
    const p8 = "../../trader/src/trader.js";
    const p8Forms: Readonly<Record<string, string>> = {
      "p8-import.ts": `import { createPaperTrader } from "${p8}";\nexport const t = createPaperTrader;\n`,
      "p8-import-type.ts": `import type { PaperTrader } from "${p8}";\nexport type T = PaperTrader;\n`,
      "p8-side-effect.ts": `import "${p8}";\n`,
      "p8-export-star.ts": `export * from "${p8}";\n`,
      "p8-export-named.ts": `export { createPaperTrader } from "${p8}";\n`,
      "p8-export-type.ts": `export type { PaperTrader } from "${p8}";\n`,
      "p8-dynamic.ts": `export const load = () => import("${p8}");\n`,
      "p8-template.ts": `export const load = () => import(\`${p8}\`);\n`,
      "p8-type-node.ts": `export type T = import("${p8}").PaperTrader;\n`,
      "p8-import-equals.ts": `import trader = require("${p8}");\nexport const t = trader;\n`,
      "p8-require.ts": `export const t: unknown = require("${p8}");\n`,
      "p8-require.cjs": `module.exports = require("${p8}");\n`,
    };

    it("P8: fails `apps/backtest-cli` importing `apps/trader` by relative path, in every form the scanner reads", async () => {
      const files: Record<string, string> = {};
      for (const [name, text] of Object.entries(p8Forms)) files[`apps/backtest-cli/src/${name}`] = text;
      const report = await runCheckerJson(buildFixture({ files }));
      const names = Object.keys(p8Forms);
      expect(rulesOf(report)).toEqual(names.map(() => "F16"));
      expect(report.violations.map((entry) => entry.location).sort()).toEqual(
        names.map((name) => `apps/backtest-cli/src/${name}:1`).sort(),
      );
      for (const entry of report.violations) {
        expect(entry.subject).toBe("apps/backtest-cli");
        expect(entry.message).toContain(
          `relative import \`${p8}\` resolves to \`apps/trader/src/trader.js\`, outside \`apps/backtest-cli\` and inside the application \`apps/trader\``,
        );
        expect(entry.doc).toContain("§3 (F16, and F10");
      }
    });

    it("fails an escape into another package, into no package, into a same-prefix sibling, and through node_modules", async () => {
      const report = await runCheckerJson(
        buildFixture({
          files: {
            "packages/oms/src/deep.ts": 'import { evaluateIntent } from "../../risk/src/index.js";\nexport const e = evaluateIntent;\n',
            "packages/oms/src/tool.ts": 'import "../../../tools/check-dependency-direction.mjs";\n',
            "packages/pnl/src/sibling.ts": 'export * from "../../pnl-extra/src/index.js";\n',
            "packages/strategies/static-bracket/src/sdk.ts":
              'export type { StrategyContext } from "../../../strategy-sdk/src/index.js";\n',
            "apps/backtest-cli/src/nm.ts":
              'export { createPaperTrader } from "../node_modules/@polymarket-bot/trader/src/trader.js";\n',
          },
        }),
      );
      expect(rulesOf(report)).toEqual(["F16", "F16", "F16", "F16", "F16"]);
      const byLocation = new Map(report.violations.map((entry) => [entry.location, entry.message]));
      expect(byLocation.get("packages/oms/src/deep.ts:1")).toContain(
        "resolves to `packages/risk/src/index.js`, outside `packages/oms` and inside `packages/risk`",
      );
      expect(byLocation.get("packages/oms/src/tool.ts:1")).toContain(
        "resolves to `tools/check-dependency-direction.mjs`, outside `packages/oms` and outside every workspace package",
      );
      expect(byLocation.get("packages/pnl/src/sibling.ts:1")).toContain(
        "resolves to `packages/pnl-extra/src/index.js`, outside `packages/pnl`",
      );
      expect(byLocation.get("packages/strategies/static-bracket/src/sdk.ts:1")).toContain(
        "outside `packages/strategies/static-bracket` and inside `packages/strategy-sdk`",
      );
      expect(byLocation.get("apps/backtest-cli/src/nm.ts:1")).toContain(
        "reaches `apps/backtest-cli/node_modules/@polymarket-bot/trader/src/trader.js` through a `node_modules` directory",
      );
    });

    it("leaves relative imports that stay inside the importing package alone, tests included; `test/**` is no package", async () => {
      const run = await runChecker(
        buildFixture({
          files: {
            "packages/oms/src/a.ts": [
              'import { b } from "./b.js";',
              'import { c } from "../src/nested/c.js";',
              'import root from "..";',
              'export * from "./nested/../b.js";',
              "export const a = [b, c, root];",
            ].join("\n"),
            "packages/oms/src/b.ts": "export const b = 1;\n",
            "packages/oms/src/nested/c.ts": 'import "../../src/b.js";\nexport const c = 2;\n',
            "packages/oms/test/a.test.ts": 'import { a } from "../src/a.js";\nexport const t = a;\n',
            "packages/strategies/static-bracket/src/local.ts": 'export { b } from "../src/local-b.js";\n',
            "packages/strategies/static-bracket/src/local-b.ts": "export const b = 1;\n",
            // Outside every workspace package, so outside rule 3 entirely.
            "test/unit/reaches-into-an-app.test.ts": 'import { createPaperTrader } from "../../apps/trader/src/trader.js";\nexport const t = createPaperTrader;\n',
          },
        }),
      );
      expect(run.output).toContain("PASS");
      expect(run.status).toBe(0);
    });
  });

  describe("CHK: a §2.1 row that matches no declared edge (item 4)", () => {
    it("reports S6 once `packages/pnl` stops declaring `packages/risk`", async () => {
      const report = await runCheckerJson(
        buildFixture({ removeDependencies: { "packages/pnl": ["@polymarket-bot/risk"] } }),
      );
      expect(rulesOf(report)).toEqual(["CHK"]);
      expect(report.violations[0]?.message).toContain(
        '§2.1 row "S6" (line',
      );
      expect(report.violations[0]?.message).toContain(
        "permits `packages/pnl` → `packages/risk`, but no workspace package declares a matching edge",
      );
    });

    it("reports the class row S2 when its class matches a package but no package declares the edge", async () => {
      // Every concrete strategy that declares the SDK drops it, so a second
      // strategy (ADR-022 D9) cannot quietly re-match S2.
      const strategies = declaring("@polymarket-bot/strategy-sdk", "packages/strategies/");
      expect(Object.keys(strategies).length).toBeGreaterThan(0);
      const report = await runCheckerJson(buildFixture({ removeDependencies: strategies }));
      expect(rulesOf(report)).toEqual(["CHK"]);
      expect(report.violations[0]?.message).toContain(
        'row "S2" (line',
      );
      expect(report.violations[0]?.message).toContain("permits `packages/strategies/*` → `packages/strategy-sdk`");
    });

    it("reports a newly listed row until its edge is declared, then passes it", async () => {
      const row = "| SX | `packages/oms` → `packages/inventory` | 1 | fixture-only row |";
      const [withoutEdge, withEdge] = await Promise.all([
        runCheckerJson(
          buildFixture({
            patchContract: (contract) => addAllowlistRow(contract, row),
            removeDependencies: { "packages/oms": ["@polymarket-bot/inventory"] },
          }),
        ),
        runCheckerJson(
          buildFixture({
            patchContract: (contract) => addAllowlistRow(contract, row),
            addDependencies: { "packages/oms": { "@polymarket-bot/inventory": "workspace:*" } },
          }),
        ),
      ]);
      expect(rulesOf(withoutEdge)).toEqual(["CHK"]);
      expect(withoutEdge.violations[0]?.message).toContain('row "SX"');
      expect(withEdge.ok).toBe(true);
      expect(withEdge.violations).toHaveLength(0);
      expect(withEdge.allowlist.map((entry) => entry.id)).toContain("SX");
    });

    it("leaves a row whose package has no manifest to F-CLOSED, one finding for one defect", async () => {
      // Every real consumer drops `packages/pnl` too; a dangling dependency
      // would be a CHK of its own.
      const consumers = declaring("@polymarket-bot/pnl");
      expect(Object.keys(consumers).length).toBeGreaterThan(0);
      const report = await runCheckerJson(
        buildFixture({ removePackages: ["packages/pnl"], removeDependencies: consumers }),
      );
      // S6 (`packages/pnl` → `packages/risk`) now matches no edge, but its
      // package's §2 entry is already F-CLOSED; no stale-row CHK is added.
      expect(rulesOf(report)).toEqual(["F-CLOSED"]);
      expect(report.violations[0]?.subject).toBe("packages/pnl");
    });
  });
});
