/**
 * `WP-320` r5 (CI run 37314515160, finding `CI-CONTROL1B-R4`): this tree's
 * runner never executes the control API's code, and this tree never names it.
 *
 * `CONTROL-1b` r4 holds that the control API's code executes only under a
 * runner that installs its run-time no-signer guard. This runner installs
 * none, and it loads the secure adapter on purpose: the heartbeat controller,
 * its errors and the network tripwire. So a test here that loaded the control
 * plane would run it beside the secure adapter, unguarded. Up to 0382165 the
 * real-PostgreSQL kill-switch read did exactly that, under a second runner
 * config here whose comment named the control API. CONTROL-1b's acceptance 3
 * failed in CI on both counts. That test now lives in the control API's
 * guarded real-PostgreSQL suite. The checks below are this tree's own
 * tripwire for the same property. Acceptance 3 stays the authority; this
 * file only fails sooner, in the suite's own script.
 *
 * The control API's package name is built from parts below, so this file
 * does not spell it either.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
/** The control API's directory and package-name segment. */
const CONTROL_API = ["control", "api"].join("-");

/** The same file names acceptance 3 reads as a test runner's configuration. */
const isRunnerConfig = (name: string): boolean => /^(vite|vitest)\.(config|workspace)\.|\.config\.[cm]?[jt]s$/u.test(name);

/** Every file under `directory`, recursively; `node_modules` is never descended. */
function filesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

/** The files among `files` whose text names the control API in any way: a load, a path, prose. */
function namingControlApi(files: readonly string[]): readonly string[] {
  return files.filter((path) => readFileSync(path, "utf8").includes(CONTROL_API)).map((path) => relative(REPO_ROOT, path));
}

describe("CI-CONTROL1B-R4: this tree's runner never executes the control API's code", () => {
  const files = filesUnder(HERE);

  it("no file in this tree names the control API: no load of it, no runner config that runs it, not even a comment", () => {
    // Non-vacuity: the walk reaches this tree's tests, its support and its configs.
    expect(files.length).toBeGreaterThanOrEqual(18);
    expect(files.map((path) => relative(HERE, path))).toEqual(expect.arrayContaining(["vitest.config.ts", "tsconfig.json", "runner-hygiene.test.ts", "support/placing-oms.ts"]));
    expect(namingControlApi(files)).toEqual([]);
  });

  it("this tree has exactly ONE runner config, the Docker-free one beside this file", () => {
    expect(files.filter((path) => isRunnerConfig(relative(HERE, path).split("/").at(-1) ?? "")).map((path) => relative(HERE, path))).toEqual(["vitest.config.ts"]);
  });

  it("the suite's script runs only this tree's runner, and names nothing else", () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "apps/trader/package.json"), "utf8")) as { scripts?: Record<string, string> };
    const script = manifest.scripts?.["test:fault:live-safety"] ?? "";
    const configs = [...script.matchAll(/--config\s+(\S+)/gu)].map((match) => relative(REPO_ROOT, resolve(REPO_ROOT, "apps/trader", match[1] ?? "")));
    expect(configs).toEqual(["test/fault-injection/live-safety/vitest.config.ts"]);
    expect(script.includes(CONTROL_API)).toBe(false);
  });

  it("the real-PostgreSQL evidence it held (r1 I6, I7; r2 X2) still exists, in the control API's GUARDED real-PostgreSQL suite", () => {
    const moved = resolve(REPO_ROOT, "test/integration", CONTROL_API, "postgres/trader-kill-switch-postgres.test.ts");
    expect(existsSync(moved)).toBe(true);
    const text = readFileSync(moved, "utf8");
    for (const marker of ["r1 I6", "r1 I7", "r2 X2", "new ControlPlane(", "new PostgresControlAuditSink(", "createPostgresKillSwitchReader(", "new KillSwitchMonitor(", "startPostgresContainer()"]) {
      expect(text.includes(marker), marker).toBe(true);
    }
    // That suite's runner installs the guard and runs the file (acceptance 3 pins its config exactly).
    const guarded = readFileSync(resolve(REPO_ROOT, "test/integration", CONTROL_API, "postgres/vitest.config.ts"), "utf8");
    expect(guarded).toContain("plugins: [noSignerVitePlugin()]");
    expect(guarded).toContain("setupFiles: [NO_SIGNER_SETUP_FILE]");
    expect(guarded).toContain(`include: ["test/integration/${CONTROL_API}/postgres/**/*.test.ts"]`);
  });

  it("the detectors are not vacuous: on a planted copy of 0382165's shape they find the nested runner config and every naming file", () => {
    const directory = mkdtempSync(join(tmpdir(), "wp320-r5-runner-hygiene-"));
    try {
      mkdirSync(join(directory, "postgres"));
      const plant = (name: string, text: string): void => {
        writeFileSync(join(directory, name), text, "utf8");
      };
      // A second runner whose comment alone names the control API (0382165's `postgres/vitest.config.ts`).
      plant("postgres/vitest.config.ts", `/** the precedent of test/integration/${CONTROL_API}/postgres */\nexport default {};\n`);
      // A test that loads the control plane by path, and one by package name.
      plant("postgres/by-path.pg.test.ts", `import { ControlPlane } from "../../../../apps/${CONTROL_API}/src/control-plane.js";\nexport const c = ControlPlane;\n`);
      plant("by-name.test.ts", `import { ControlPlane } from "@polymarket-bot/${CONTROL_API}";\nexport const c = ControlPlane;\n`);
      plant("innocent.test.ts", "export const n = 1;\n");
      plant("vitest.config.ts", "export default {};\n");
      const planted = filesUnder(directory);
      expect(planted).toHaveLength(5);
      expect(namingControlApi(planted).map((path) => relative(directory, resolve(REPO_ROOT, path))).sort()).toEqual(["by-name.test.ts", "postgres/by-path.pg.test.ts", "postgres/vitest.config.ts"]);
      expect(planted.filter((path) => isRunnerConfig(relative(directory, path).split("/").at(-1) ?? "")).map((path) => relative(directory, path)).sort()).toEqual(["postgres/vitest.config.ts", "vitest.config.ts"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(isRunnerConfig("vitest.workspace.ts")).toBe(true);
    expect(isRunnerConfig("x.config.mts")).toBe(true);
    expect(isRunnerConfig("two-writers.test.ts")).toBe(false);
  });
});
