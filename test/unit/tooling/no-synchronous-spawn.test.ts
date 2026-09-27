/**
 * CI-1 — no test file may call a SYNCHRONOUS child-process API; CI-2 extends
 * the scan to the helper modules under `test/` and states the real limit.
 *
 * WHY. vitest runs each test file in a worker that reports progress to the
 * main process over birpc, and every birpc call carries a 60 s timeout
 * (`DEFAULT_TIMEOUT = 6e4` in the birpc bundled with vitest 3.2). A
 * synchronous child-process call blocks the worker's event loop for the whole
 * life of the child, and a run of back-to-back synchronous tests never returns
 * to the loop at all: the `await` between two tests drains only microtasks, so
 * the reply to the worker's `onTaskUpdate` call sits unread in the IPC pipe.
 * When the loop finally turns, Node runs the expired timer before it reads the
 * pipe, the call "times out" although its answer arrived long before, and the
 * run fails with `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` and
 * exit 1 while every test passes.
 *
 * That is how this repository's FIRST GitHub Actions run failed (run
 * 36279491795, ubuntu-24.04): 331 files / 7217 tests passed, and
 * `test/unit/tooling/dependency-direction.test.ts` — 187 tests, each launching
 * the checker synchronously — held its worker's loop for 82 s. The same file
 * finishes in under 60 s on a laptop, which is why it never failed reliably
 * there. Reproduced in isolation: 65 tests that each block on a 1 s
 * child → all 65 pass, one unhandled `Timeout calling "onTaskUpdate"`, exit 1;
 * the same 65 awaiting an asynchronous child → exit 0.
 *
 * THE REAL LIMIT (`CI-2`, `CI1-L3`) is wider than this scan. It is about 60 s
 * of SYNCHRONOUS work in one test file, of ANY kind, run without the worker's
 * event loop turning in between. A child-process call is only the easiest way
 * to get there. `Atomics.wait`, a busy loop, or a long synchronous file walk
 * gets there too: the `CI-1` review reproduced the same failure with 34 tests
 * that each blocked for 2 s in `Atomics.wait`, and no child process at all. A
 * test that awaits real I/O or a timer lets the loop turn and resets the
 * clock. Measure against the GitHub runner, not a laptop: the file above took
 * 82 s there and under 60 s locally.
 *
 * WHAT IS CHECKED MECHANICALLY: the NAMES of the three synchronous
 * child-process APIs, and nothing else.
 * - Every tracked `*.test.ts` file in the repository.
 * - Every tracked helper module under `test/` (`.ts`, `.mts`, `.cts`, `.js`,
 *   `.mjs`, `.cjs`) that is not itself a `*.test.ts` file (`CI-2`). A module a
 *   test imports runs in that test's worker, so a synchronous call there blocks
 *   the same loop.
 * - The lists come from `git ls-files`, so a nested worktree or an ignored
 *   scratch file is never scanned.
 * - No module under `test/` is excluded. Some never run in a worker: the
 *   `vitest.config.ts` files and `globalSetup` modules run in vitest's main
 *   process, and the recorder's `run-soak.mjs` and its `--import` preload run
 *   as their own processes, which the smoke test spawns. None of them names an
 *   API today, so an exclusion would only open a blind spot. If one of them
 *   ever needs a synchronous call, exclude it here and give the reason.
 * - A file must not NAME any of the three APIs, in code or in a comment. The
 *   check is textual on purpose: an aliased import, a namespace call or a
 *   bracket access with a string literal still has to spell the name, so all
 *   of them are caught. The names are assembled from parts below, so this file
 *   passes its own scan without exempting itself.
 *
 * NOT CHECKED:
 * - Synchronous work of any other kind (see THE REAL LIMIT). A general
 *   synchronous-time detector is out of scope. The limit stays with the
 *   author, the reviewer, and the slowest file's duration on the runner.
 * - A name assembled at run time (`cp[stem + suffix]`, the way this file
 *   builds its own list) escapes any textual check.
 * - Untracked files. A new file is not scanned until it is added to the Git
 *   index. CI checks out tracked files only, so there the scan covers
 *   everything that runs.
 * - Modules outside `test/` that a test imports, such as workspace source.
 * - The unit suite now needs `git` and a `.git` directory. Without them the
 *   listing fails loudly, and a partial list fails the non-vacuity checks; the
 *   scan never passes by scanning nothing.
 *
 * WHAT TO DO INSTEAD. Await an asynchronous spawn: `promisify(execFile)` where
 * a non-zero exit should throw (the three `test/unit/decimal/*` probes), or
 * `spawn` with collected streams where the test asserts on the exit status
 * (`spawnNode` in `dependency-direction.test.ts`).
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const thisFile = "test/unit/tooling/no-synchronous-spawn.test.ts";

/** The three synchronous child-process APIs, assembled so this file never spells them. */
const SYNC_SUFFIX = "Sync";
const SYNCHRONOUS_APIS = [`spawn${SYNC_SUFFIX}`, `exec${SYNC_SUFFIX}`, `execFile${SYNC_SUFFIX}`] as const;

const SYNCHRONOUS_API = new RegExp(`\\b(?:${SYNCHRONOUS_APIS.join("|")})\\b`, "u");

const REASON = [
  "A synchronous child-process call blocks the vitest worker's event loop for the child's whole life;",
  "a run of such tests never lets the worker read vitest's own RPC replies, birpc's 60 s call timeout fires,",
  'and the run fails with `[vitest-worker]: Timeout calling "onTaskUpdate"` although every test passes —',
  "exactly how GitHub Actions run 36279491795 failed (CI-1). A helper module under test/ runs in the worker",
  "of the test that imports it, so the same holds there (CI-2). Await an asynchronous spawn instead:",
  "`promisify(execFile)`, or `spawn` with collected streams where a non-zero exit is expected",
  "(see test/unit/tooling/no-synchronous-spawn.test.ts). The offending lines are the received array",
].join(" ");

/** `line N: text` for every line of `source` that names a synchronous API. */
function synchronousSpawnLines(source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((text, index) => {
    if (SYNCHRONOUS_API.test(text)) hits.push(`line ${index + 1}: ${text.trim()}`);
  });
  return hits;
}

/** `<file> line N: text` for every offending line in `files` (repository-relative). */
async function offendingLines(files: readonly string[]): Promise<string[]> {
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(path.join(repoRoot, file), "utf8") })),
  );
  return sources.flatMap(({ file, source }) => synchronousSpawnLines(source).map((hit) => `${file} ${hit}`));
}

/** Repository-relative POSIX paths the Git index holds under `pathspec`. */
async function gitListFiles(pathspec: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", pathspec], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\0").filter((entry) => entry !== "");
}

let trackedTestFiles: Promise<string[]> | undefined;

/** Repository-relative POSIX paths of every tracked `*.test.ts`, from the Git index. */
function listTrackedTestFiles(): Promise<string[]> {
  trackedTestFiles ??= gitListFiles("*.test.ts");
  return trackedTestFiles;
}

/** The module extensions a test can import, whether TypeScript or JavaScript. */
const HELPER_MODULE = /\.(?:ts|mts|cts|js|mjs|cjs)$/u;
const TEST_FILE = /\.test\.ts$/u;

/**
 * Keeps the helper modules of a `test/` listing: an importable extension, and
 * not a `*.test.ts` file (those are scanned above).
 */
function helperModules(files: readonly string[]): string[] {
  return files.filter((file) => HELPER_MODULE.test(file) && !TEST_FILE.test(file));
}

let trackedHelperModules: Promise<string[]> | undefined;

/** Repository-relative POSIX paths of every tracked helper module under `test/`. */
function listTrackedHelperModules(): Promise<string[]> {
  trackedHelperModules ??= gitListFiles("test/").then(helperModules);
  return trackedHelperModules;
}

describe("no synchronous child-process API in any test file (CI-1)", () => {
  it("the scan recognises each synchronous API, whatever the import or call shape", () => {
    expect(SYNCHRONOUS_APIS).toHaveLength(3);
    for (const api of SYNCHRONOUS_APIS) {
      const shapes = [
        `import { ${api} } from "node:child_process";`,
        `import { ${api} as run } from "child_process";`,
        `const out = cp.${api}(process.execPath, ["x"]);`,
        `const out = require("node:child_process").${api}("ls");`,
        `const { ${api}: run } = childProcess;`,
        `const out = cp["${api}"](process.execPath, ["x"]);`,
        `const out = cp['${api}']("ls");`,
        `// a comment that names ${api} is flagged too`,
      ];
      for (const shape of shapes) {
        expect(synchronousSpawnLines(shape), shape).toEqual([`line 1: ${shape}`]);
      }
    }
    expect(synchronousSpawnLines(`ok\n${SYNCHRONOUS_APIS[0]}("x")\nok`)).toEqual([
      `line 2: ${SYNCHRONOUS_APIS[0]}("x")`,
    ]);
  });

  it("the scan leaves the asynchronous APIs and longer look-alike names alone", () => {
    const clean = [
      'import { execFile, spawn, exec } from "node:child_process";',
      "const run = await promisify(execFile)(process.execPath, []);",
      "const child = spawn(process.execPath, args, { stdio: 'pipe' });",
      `const ${SYNCHRONOUS_APIS[0]}ronous = 1; // a longer identifier is not the API`,
      `const my${SYNCHRONOUS_APIS[1]} = 2;`,
    ].join("\n");
    expect(synchronousSpawnLines(clean)).toEqual([]);
  });

  it("scans a real file list: the Git index's *.test.ts files, including every file CI-1 converted", async () => {
    const files = await listTrackedTestFiles();
    // Non-vacuity: an empty or partial listing would make the next test pass
    // by scanning nothing.
    expect(files.length).toBeGreaterThan(300);
    for (const expected of [
      thisFile,
      "test/unit/tooling/dependency-direction.test.ts",
      "test/unit/decimal/arithmetic-fold.test.ts",
      "test/unit/decimal/index-name-pollution.test.ts",
      "test/unit/decimal/unneutralizable-shapes.test.ts",
      "test/integration/data-gateway/process-liveness.test.ts",
      "test/soak/recorder/soak-smoke.test.ts",
    ]) {
      expect(files).toContain(expected);
    }
    expect(files.every((file) => file.endsWith(".test.ts"))).toBe(true);
  });

  it("finds none in any tracked *.test.ts file", async () => {
    const files = await listTrackedTestFiles();
    expect(await offendingLines(files), REASON).toEqual([]);
  });
});

describe("no synchronous child-process API in any test helper module under test/ (CI-2)", () => {
  it("the helper filter keeps every importable module extension and drops test files and data", () => {
    const listing = [
      "test/a/helper.ts",
      "test/a/helper.mts",
      "test/a/helper.cts",
      "test/a/helper.js",
      "test/a/helper.mjs",
      "test/a/helper.cjs",
      "test/a/types.d.ts",
      "test/a/case.test.ts",
      "test/a/golden.json",
      "test/a/README.md",
      "test/a/fixture.parquet",
      "test/a/.gitkeep",
      "test/a/helper.ts.txt",
    ];
    expect(helperModules(listing)).toEqual([
      "test/a/helper.ts",
      "test/a/helper.mts",
      "test/a/helper.cts",
      "test/a/helper.js",
      "test/a/helper.mjs",
      "test/a/helper.cjs",
      "test/a/types.d.ts",
    ]);
  });

  it("scans a real file list: the Git index's helper modules under test/", async () => {
    const files = await listTrackedHelperModules();
    // Non-vacuity, as above: 80 helper modules were tracked when CI-2 added
    // this scan.
    expect(files.length).toBeGreaterThan(50);
    for (const expected of [
      "test/unit/decimal/arithmetic-fold.ts",
      "test/unit/decimal/prototype-shape-probe.ts",
      "test/e2e/support/harness.ts",
      "test/integration/data-gateway/support/harness.ts",
      "test/integration/postgres/global-setup.ts",
      "test/soak/recorder/run-soak.mjs",
      "test/soak/recorder/inherited-tojson.preload.mjs",
    ]) {
      expect(files).toContain(expected);
    }
    expect(files.every((file) => file.startsWith("test/"))).toBe(true);
    expect(files.some((file) => TEST_FILE.test(file))).toBe(false);
    expect(files.every((file) => HELPER_MODULE.test(file))).toBe(true);
  });

  it("finds none in any tracked helper module under test/", async () => {
    const files = await listTrackedHelperModules();
    expect(await offendingLines(files), REASON).toEqual([]);
  });
});
