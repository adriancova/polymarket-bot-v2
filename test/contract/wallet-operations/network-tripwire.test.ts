/**
 * The network tripwire's self-test (WP-300c). It makes the setup file's 0-call
 * assertions load-bearing (mutant C-24).
 *
 * `network-tripwire.setup.ts` catches an UNCAUGHT `fetch` where it is made. A
 * SWALLOWED one is caught only by its two 0-call assertions: after each test,
 * and once more after the file. In a passing suite nothing exercises them,
 * because the real test files call nothing; with both assertions removed the
 * suite stayed green (C-24 survived WP-300c round 0).
 *
 * So this file runs the suite's own config, setup file included, over a set of
 * plants (`network-tripwire.plants.config.ts` over `tripwire-plants/`), in a
 * child process, and checks the result of each plant file:
 *
 *   plant                    | the planted fetch                          | expected
 *   clean                    | none (the control)                         | passes
 *   swallowed-at-load        | at module load, error swallowed            | test fails (after each), file fails (after all)
 *   swallowed-async-at-load  | in a microtask queued at load, swallowed   | test fails (after each), file fails (after all)
 *   swallowed-in-test        | inside a test, error swallowed             | test fails (after each), file fails (after all)
 *   swallowed-in-after-all   | in the file's own afterAll, swallowed      | test passes, file fails (after all)
 *   uncaught-at-load         | at module load, not caught                 | file fails to load with the tripwire's error
 *
 * Each failure must carry the tripwire's own message. Removing the after-each
 * assertion, the after-all assertion, the count, or the setup file fails at
 * least one row here. No plant can reach the network: each one checks for the
 * tripwire's mark before it calls `fetch`, and refuses otherwise
 * (`tripwire-plants/support.ts`); a refusal fails a row too.
 *
 * The child is awaited, never run synchronously (`CI-1`,
 * `test/unit/tooling/no-synchronous-spawn.test.ts`), and reports through
 * vitest's JSON reporter on its stdout. It runs vitest from the repository's
 * own `node_modules`; nothing is installed or fetched.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLANT_REFUSAL } from "./tripwire-plants/support.js";

/** `fetch` as this module saw it while loading: the setup file's tripwire, installed before (WP300B-R1-04). */
const fetchAtModuleLoad: unknown = globalThis.fetch;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const PLANTS_CONFIG = resolve(here, "network-tripwire.plants.config.ts");
const VITEST_CLI = resolve(repoRoot, "node_modules/vitest/vitest.mjs");

/**
 * The setup file's two assertion labels and its tripwire's error. Repeated
 * here, not imported: importing the setup file would install a second
 * tripwire and register its hooks twice.
 */
const AFTER_EACH = "fetch calls since the test module was loaded (module load included)";
const AFTER_ALL = "fetch calls in this test file, from module load to its end";
const TRIPWIRE_ERROR = "network tripwire: the wallet-operations contract suite is offline";

/** Every plant under `tripwire-plants/`, sorted: the run must report exactly these. */
const PLANT_FILES = [
  "clean.plant.ts",
  "swallowed-async-at-load.plant.ts",
  "swallowed-at-load.plant.ts",
  "swallowed-in-after-all.plant.ts",
  "swallowed-in-test.plant.ts",
  "uncaught-at-load.plant.ts",
];

const CHILD_DEADLINE_MS = 120_000;
const MAX_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;

/** A child still running when the file ends (its test timed out first) is killed, not orphaned. */
const liveChildren = new Set<ChildProcess>();
afterAll(() => {
  for (const child of liveChildren) child.kill("SIGKILL");
});

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
}

/** The child's environment: this worker's, minus the variables that describe THIS vitest run to it. */
function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST") || key === "FORCE_COLOR") continue;
    environment[key] = value;
  }
  environment["NO_COLOR"] = "1";
  return environment;
}

/** Runs the plants with this suite's config, in a child process, awaited. */
function runPlants(): Promise<ChildRun> {
  return new Promise((settleRun) => {
    const args = [VITEST_CLI, "run", "--config", PLANTS_CONFIG, "--reporter=json"];
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(child);
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    let error: Error | undefined;
    let settled = false;
    const output = (stream: "stdout" | "stderr"): string => Buffer.concat(chunks[stream]).toString("utf8");
    const settle = (status: number | null, cause?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      liveChildren.delete(child);
      settleRun({ status, stdout: output("stdout"), stderr: output("stderr"), error: error ?? cause });
    };
    const collect =
      (stream: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        if (bytes[stream] + chunk.length > MAX_CHILD_OUTPUT_BYTES) {
          error ??= new Error(`the plants' run wrote more than ${MAX_CHILD_OUTPUT_BYTES} bytes to ${stream}`);
          child.kill("SIGKILL");
          return;
        }
        bytes[stream] += chunk.length;
        chunks[stream].push(chunk);
      };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (cause) => settle(null, cause));
    child.on("close", (code) => settle(code));
    // `settle` runs only after an event or this timer fires, so `deadline` is set by then.
    const deadline = setTimeout(() => {
      error ??= new Error(`the plants' run did not finish within ${CHILD_DEADLINE_MS} ms and was killed`);
      child.kill("SIGKILL");
      settle(null);
    }, CHILD_DEADLINE_MS);
  });
}

interface PlantTest {
  readonly title: string;
  readonly status: string;
  readonly failure: string;
}

interface PlantFile {
  readonly status: string;
  /** The file-level error: an after-all failure, or the error that stopped the module loading. */
  readonly message: string;
  readonly tests: readonly PlantTest[];
}

function asRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`the plants' JSON report: ${what} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function asText(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`the plants' JSON report: ${what} is not a string`);
  return value;
}

function asList(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`the plants' JSON report: ${what} is not an array`);
  return value;
}

/** Vitest's JSON report, by plant file name (`testResults[]`, `assertionResults[]`, as vitest 3.2 writes them). */
function parseReport(stdout: string): { readonly success: unknown; readonly files: ReadonlyMap<string, PlantFile> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`the plants' run did not print a JSON report; stdout began: ${stdout.slice(0, 400)}`, { cause });
  }
  const report = asRecord(parsed, "the report");
  const files = new Map<string, PlantFile>();
  for (const [index, entry] of asList(report["testResults"], "testResults").entries()) {
    const file = asRecord(entry, `testResults[${index}]`);
    const name = basename(asText(file["name"], `testResults[${index}].name`));
    if (files.has(name)) throw new Error(`the plants' JSON report lists ${name} twice`);
    const tests = asList(file["assertionResults"], `${name}.assertionResults`).map((test, at): PlantTest => {
      const fields = asRecord(test, `${name}.assertionResults[${at}]`);
      return {
        title: asText(fields["title"], `${name} test ${at} title`),
        status: asText(fields["status"], `${name} test ${at} status`),
        failure: asList(fields["failureMessages"], `${name} test ${at} failureMessages`)
          .map((message, line) => asText(message, `${name} test ${at} failureMessages[${line}]`))
          .join("\n"),
      };
    });
    files.set(name, {
      status: asText(file["status"], `${name}.status`),
      message: asText(file["message"], `${name}.message`),
      tests,
    });
  }
  return { success: report["success"], files };
}

let run: ChildRun | undefined;
let files: ReadonlyMap<string, PlantFile> = new Map();
let success: unknown;

function plant(name: string): PlantFile {
  const file = files.get(name);
  if (file === undefined) throw new Error(`plant ${name} is missing from the report`);
  return file;
}

/** One planted file whose only test must fail on the after-each count, and the file on the after-all count. */
function expectCaughtByBothCounts(name: string): void {
  const file = plant(name);
  expect(file.status).toBe("failed");
  expect(file.tests).toHaveLength(1);
  expect(file.tests[0]?.status).toBe("failed");
  expect(file.tests[0]?.failure).toContain(AFTER_EACH);
  expect(file.message).toContain(AFTER_ALL);
}

describe("offline", () => {
  it("the network tripwire was installed before this module loaded (module-level code is covered)", () => {
    const mark = Symbol.for("polymarket-bot.contract.wallet-operations.network-tripwire");
    expect(typeof fetchAtModuleLoad).toBe("function");
    expect(Reflect.get(fetchAtModuleLoad as object, mark)).toBe(true);
    expect(globalThis.fetch).toBe(fetchAtModuleLoad);
  });
});

describe("the tripwire catches every planted fetch (the plants, run in a child with this suite's config)", () => {
  beforeAll(async () => {
    expect(existsSync(VITEST_CLI), `vitest's CLI at ${VITEST_CLI}`).toBe(true);
    run = await runPlants();
    if (run.error !== undefined) throw run.error;
    ({ files, success } = parseReport(run.stdout));
  }, CHILD_DEADLINE_MS + 30_000);

  it("the run fails, as planted, and reports exactly the six plant files", () => {
    expect(run?.status, run?.stderr).toBe(1);
    expect(success).toBe(false);
    expect([...files.keys()].sort()).toEqual(PLANT_FILES);
  });

  it("no plant was refused: the tripwire was installed in every plant file", () => {
    for (const [name, file] of files) {
      expect(file.message, name).not.toContain(PLANT_REFUSAL);
      for (const test of file.tests) expect(test.failure, `${name}: ${test.title}`).not.toContain(PLANT_REFUSAL);
    }
  });

  it("clean (the control, no fetch) passes", () => {
    const file = plant("clean.plant.ts");
    expect(file.status).toBe("passed");
    expect(file.message).toBe("");
    expect(file.tests.map((test) => test.status)).toEqual(["passed"]);
  });

  it("a fetch at module load whose error is swallowed fails its test (after each) and its file (after all)", () => {
    expectCaughtByBothCounts("swallowed-at-load.plant.ts");
  });

  it("a fetch from a microtask queued at module load, swallowed, fails its test and its file", () => {
    expectCaughtByBothCounts("swallowed-async-at-load.plant.ts");
  });

  it("a fetch inside a test whose error is swallowed fails that test and its file", () => {
    expectCaughtByBothCounts("swallowed-in-test.plant.ts");
  });

  it("a fetch in the file's own afterAll, swallowed, fails the file although its test passed (after all only)", () => {
    const file = plant("swallowed-in-after-all.plant.ts");
    expect(file.status).toBe("failed");
    expect(file.tests.map((test) => test.status)).toEqual(["passed"]);
    expect(file.message).toContain(AFTER_ALL);
  });

  it("a fetch at module load that nothing catches stops the module loading, with the tripwire's error", () => {
    const file = plant("uncaught-at-load.plant.ts");
    expect(file.status).toBe("failed");
    expect(file.tests).toEqual([]);
    expect(file.message).toContain(TRIPWIRE_ERROR);
  });
});
