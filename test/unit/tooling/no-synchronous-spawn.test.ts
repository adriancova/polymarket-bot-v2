/**
 * CI-1 — no test file may call a SYNCHRONOUS child-process API.
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
 * WHAT IS CHECKED. Every tracked `*.test.ts` file — as `git ls-files` lists
 * them, so a nested worktree or an ignored scratch file is never scanned —
 * must not NAME any of the three synchronous APIs, in code or in a comment. The
 * check is textual on purpose: an aliased import or a namespace call still has
 * to spell the name, so both are caught. The names are assembled from parts
 * below, so this file passes its own scan without exempting itself.
 *
 * NOT CHECKED: a helper module that is not itself a `*.test.ts` file runs in
 * the same worker when a test imports it; none uses a synchronous spawn today,
 * and keeping it that way is on the reviewer, not on this scan. A name built
 * at run time (`cp[stem + suffix]`) evades any textual check.
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
  "exactly how GitHub Actions run 36279491795 failed (CI-1). Await an asynchronous spawn instead:",
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

let trackedTestFiles: Promise<string[]> | undefined;

/** Repository-relative POSIX paths of every tracked `*.test.ts`, from the Git index. */
function listTrackedTestFiles(): Promise<string[]> {
  trackedTestFiles ??= execFileAsync("git", ["ls-files", "-z", "--", "*.test.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).then(({ stdout }) => stdout.split("\0").filter((entry) => entry !== ""));
  return trackedTestFiles;
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
    const sources = await Promise.all(
      files.map(async (file) => ({ file, source: await readFile(path.join(repoRoot, file), "utf8") })),
    );
    const offending = sources.flatMap(({ file, source }) =>
      synchronousSpawnLines(source).map((hit) => `${file} ${hit}`),
    );
    expect(offending, REASON).toEqual([]);
  });
});
