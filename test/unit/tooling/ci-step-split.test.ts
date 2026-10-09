/**
 * CI-2 (`CI1-L5`) — `.github/workflows/ci.yml` runs every command of the root
 * `package.json`'s `&&` chains (`typecheck`, `test:contract`,
 * `test:integration`, and since `CI-5` `test:fault`; `CI-6` lengthened the
 * last two) as its own gated step, and this pin fails when the two drift
 * apart.
 *
 * WHY. `GATE1-R4` (closed by `CI-1`) made every gate run even after an earlier
 * one failed. That holds per STEP. A chain inside one step still stops at its
 * first failure and hides the rest: a red event-bus suite would hide the
 * data-gateway, trader and control-api suites after it. So each chained
 * command is now a step of its own. The commands still live in the PROTECTED
 * `package.json`, so a suite added to a chain there, or dropped from it, would
 * otherwise silently not match what CI runs.
 *
 * WHAT FAILS HERE, each with a readable finding:
 * - a chained command that no step runs, or that several steps run;
 * - split steps out of the chain's order, or named for the wrong position;
 * - a step that looks like a split step (by its name or its command) but runs
 *   no chained command, including the old one-step `pnpm typecheck`;
 * - a gate after the node job's install step without
 *   `if: ${{ !cancelled() && steps.install.outcome == 'success' }}`, or with a
 *   key a gate may not have (`continue-on-error`, `env`, …);
 * - the same for the python job's gates after its sync step, which need
 *   `if: ${{ !cancelled() && steps.sync.outcome == 'success' }}` (`CI-2` r1);
 * - a gate that runs an `&&` chain as ONE step outside the split steps: a
 *   root script one of its commands runs (directly or through other root
 *   scripts) is a chain other than the split ones (`SPLIT_CHAINS`), or its own
 *   `run` holds `&&` (`CI-2` r1, L5-1). Without this, the `CI1-L5` hazard could
 *   return through any other script, such as `test:replay`. (It did return
 *   through `test:fault` when `CI-5` chained the fault suites, and this rule
 *   made `CI-5` split it.) The root script is
 *   followed through `pnpm <script>` and `pnpm run <script>`, and since
 *   `DEPCHECK-1` (`CI2-L5-3`) also through the other spellings that run the
 *   ROOT script — `pnpm -C .`, `pnpm --dir .`, `pnpm --filter polymarket-bot`,
 *   `pnpm -w`, a quoted script name, `npm run`, and the rest listed in
 *   `ci-workflow.ts` ("WHICH SPELLINGS RUN A ROOT SCRIPT");
 * - a gate that runs more than one command in one step: the lines, or the
 *   `;`-separated parts, of its `run` (`DEPCHECK-1`, `CI2-L5-2`). Under
 *   GitHub's `bash -e` the first failure hides the rest, as an `&&` chain
 *   would. Only a block recorded in `DEPENDENT_RUN_BLOCKS` with its exact text
 *   and reason is exempt (today the python audit step, whose second line reads
 *   the file its first line writes), and a record no gate matches is itself a
 *   finding;
 * - a job without a `timeout-minutes` below GitHub's 360-minute default;
 * - since `CI-7` (CLOSEOUT-3 L1), a workspace package's `test:integration`
 *   (or `test:integration:<x>`) script that the root `test:integration` chain
 *   does not run and `UNCHAINED_INTEGRATION_SCRIPTS` does not exempt with a
 *   reason, as WP-330's `ops-cli` suite was from its merge to CLOSEOUT-3;
 *   a chained `pnpm --filter` command whose package or script does not
 *   exist (pnpm exits 0 when a filter matches nothing); and a stale
 *   exemption. Since `CI-7` r1 (CI7-R1-01), the workspace is read as pnpm
 *   11.17.0 reads it, through directory symlinks. Every layout where the two
 *   could disagree is refused (`readWorkspaceManifests`).
 *
 * HOW. `ci-workflow.ts` reads the workflow with a conservative YAML-subset
 * reader, because no YAML library is declared and `package.json` and the
 * lockfile are protected. It throws on anything outside that subset, rather
 * than guessing. The drift check is a pure function of the two texts, so every
 * mutant below, including a `package.json` whose chain gains a command, is an
 * in-memory copy; no tracked file is touched. The workspace-discovery
 * fixtures (`CI-7` r1) need a real filesystem: each is a temporary directory
 * outside the repository, removed after the file. The one normalization, a bare
 * binary such as `tsc` run as `pnpm exec tsc`, is explained in `ci-workflow.ts`.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEPENDENT_RUN_BLOCKS,
  GATE_IF,
  SPLIT_CHAINS,
  UNCHAINED_INTEGRATION_SCRIPTS,
  type UnchainedIntegrationScript,
  type WorkspaceManifest,
  type WorkspaceRead,
  type YamlValue,
  chainCommands,
  integrationScriptFindings,
  jobSteps,
  jobTimeoutFindings,
  nodeJobSteps,
  packageScriptCommand,
  parseWorkflowYaml,
  readWorkspaceManifests,
  shellCommands,
  splitStepDrift,
  stepRunFor,
  workspacePackageGlobs,
} from "./ci-workflow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface RealTexts {
  readonly workflow: string;
  readonly packageJson: string;
}

let realTexts: Promise<RealTexts> | undefined;

/** The tracked `ci.yml` and root `package.json`, read once. */
function readRealTexts(): Promise<RealTexts> {
  realTexts ??= Promise.all([
    readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(path.join(repoRoot, "package.json"), "utf8"),
  ]).then(([workflow, packageJson]) => ({ workflow, packageJson }));
  return realTexts;
}

let realWorkspace: Promise<WorkspaceRead> | undefined;

/**
 * The tracked `pnpm-workspace.yaml` globs, and the manifest of every workspace
 * package they admit, read once (`CI-7`). Since `CI-7` r1 (CI7-R1-01),
 * `readWorkspaceManifests` admits what pnpm 11.17.0 admits, including a package
 * reached through a directory symlink, and throws wherever the two could
 * disagree. The fixtures below pin that against a real filesystem.
 */
function readRealWorkspace(): Promise<WorkspaceRead> {
  realWorkspace ??= readWorkspaceManifests(repoRoot);
  return realWorkspace;
}

// ---------------------------------------------------------------------------
// Text mutants of ci.yml. Each helper throws when its anchor is missing, so a
// mutant can never silently become the original text.

/** The indentation of a step item in a job's `steps`, and of that step's keys. */
const STEP_ITEM = "      - ";
const STEP_KEY = "        ";

function stepStart(lines: readonly string[], name: string): number {
  const found = lines.flatMap((line, index) => (line === `${STEP_ITEM}name: ${name}` ? [index] : []));
  if (found.length !== 1) throw new Error(`mutant: ${found.length} steps are named ${JSON.stringify(name)}`);
  return found[0] ?? -1;
}

/** One past the last line of the step that starts at `start`. */
function stepEnd(lines: readonly string[], start: number): number {
  let end = start + 1;
  while (end < lines.length && (lines[end] ?? "").startsWith(STEP_KEY)) end += 1;
  return end;
}

function edit(workflow: string, change: (lines: string[]) => void): string {
  const lines = workflow.split("\n");
  change(lines);
  const mutant = lines.join("\n");
  if (mutant === workflow) throw new Error("mutant: the edit changed nothing");
  return mutant;
}

function removeStep(workflow: string, name: string): string {
  return edit(workflow, (lines) => {
    const start = stepStart(lines, name);
    lines.splice(start, stepEnd(lines, start) - start);
  });
}

function insertStepAfter(workflow: string, name: string, step: readonly string[]): string {
  return edit(workflow, (lines) => {
    lines.splice(stepEnd(lines, stepStart(lines, name)), 0, "", ...step);
  });
}

function stepBlock(workflow: string, name: string): string[] {
  const lines = workflow.split("\n");
  const start = stepStart(lines, name);
  return lines.slice(start, stepEnd(lines, start));
}

function moveStepAfter(workflow: string, name: string, after: string): string {
  const block = stepBlock(workflow, name);
  return insertStepAfter(removeStep(workflow, name), after, block);
}

/** Replaces the `key:` line of the named step, or removes it when `value` is undefined. */
function setStepKey(workflow: string, name: string, key: string, value: string | undefined): string {
  return edit(workflow, (lines) => {
    const start = stepStart(lines, name);
    const end = stepEnd(lines, start);
    const at = lines.findIndex((line, index) => index > start && index < end && line.startsWith(`${STEP_KEY}${key}:`));
    if (at < 0) throw new Error(`mutant: step ${JSON.stringify(name)} has no \`${key}:\` line`);
    if (value === undefined) lines.splice(at, 1);
    else lines[at] = `${STEP_KEY}${key}: ${value}`;
  });
}

function gatedStep(name: string, run: string): string[] {
  return [`${STEP_ITEM}name: ${name}`, `${STEP_KEY}if: ${GATE_IF}`, `${STEP_KEY}run: ${run}`];
}

/** A copy of `package.json` text with `script` replaced. */
function withScript(packageJson: string, script: string, text: string): string {
  const parsed = JSON.parse(packageJson) as { scripts: Record<string, string> };
  if (typeof parsed.scripts[script] !== "string") throw new Error(`mutant: no script ${script}`);
  parsed.scripts[script] = text;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** A copy of `package.json` text with a NEW script `script` added. */
function withAddedScript(packageJson: string, script: string, text: string): string {
  const parsed = JSON.parse(packageJson) as { scripts: Record<string, string> };
  if (script in parsed.scripts) throw new Error(`mutant: script ${script} already exists`);
  parsed.scripts[script] = text;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** The root `package.json` scripts, by name. */
function scriptsOf(packageJson: string): Readonly<Record<string, string>> {
  return (JSON.parse(packageJson) as { readonly scripts: Readonly<Record<string, string>> }).scripts;
}

/**
 * The L5-1 and DEPCHECK-1 cases below need a root script that is not a split
 * chain and that a gate runs as one step. They used `test:fault` until `CI-5`
 * made it a split chain; they now use `test:replay`, whose gate still runs
 * `pnpm test:replay`.
 */
const REPLAY_GATE = "Replay determinism goldens (order-book and simulation)";

/** A two-command `test:replay`: the shape of the review's L5-1 case. */
const REPLAY_SCRIPT_CHAIN =
  "vitest run --config test/vitest.config.ts test/unit/order-book/replay-golden.test.ts && " +
  "vitest run --config test/vitest.config.ts test/unit/simulation/golden-replay.test.ts";

/**
 * The gating `if:` of the python job, spelled out here rather than imported,
 * so the pin states the condition itself (`CI-2` r1, RES-PY).
 */
const SYNC_GATE_IF = "${{ !cancelled() && steps.sync.outcome == 'success' }}";

function isYamlMapping(value: YamlValue | undefined): value is ReadonlyMap<string, YamlValue> {
  return value instanceof Map;
}

interface ListedGate {
  /** 1-based position of the step in its job, as the drift check's labels count it. */
  readonly number: number;
  readonly name: string;
  readonly condition: YamlValue | undefined;
}

/**
 * The steps of `job` after the step whose `id` is `setupId`, read with the
 * YAML reader alone, not with the drift check under test.
 */
function gatesAfter(workflow: string, job: string, setupId: string): ListedGate[] {
  const root = parseWorkflowYaml(workflow);
  const jobs = isYamlMapping(root) ? root.get("jobs") : undefined;
  const jobValue = isYamlMapping(jobs) ? jobs.get(job) : undefined;
  const steps = isYamlMapping(jobValue) ? jobValue.get("steps") : undefined;
  if (!Array.isArray(steps)) throw new Error(`fixture: jobs.${job}.steps is not a sequence`);
  const list = steps as readonly YamlValue[];
  const setup = list.findIndex((step) => isYamlMapping(step) && step.get("id") === setupId);
  if (setup < 0) throw new Error(`fixture: jobs.${job} has no step with id ${setupId}`);
  return list.slice(setup + 1).map((step, offset) => {
    const name = isYamlMapping(step) ? step.get("name") : undefined;
    if (!isYamlMapping(step) || typeof name !== "string") throw new Error(`fixture: a jobs.${job} gate has no name`);
    return { number: setup + offset + 2, name, condition: step.get("if") };
  });
}

/** The gate steps after install, as the drift check sees them. */
function gates(workflow: string): ReturnType<typeof nodeJobSteps> {
  const steps = nodeJobSteps(workflow);
  const install = steps.findIndex((step) => step.id === "install");
  if (install < 0) throw new Error("fixture: no install step");
  return steps.slice(install + 1);
}

interface SplitStep {
  readonly name: string;
  readonly script: string;
  /** 1-based position of the command in its chain. */
  readonly position: number;
  readonly command: string;
}

/**
 * The split steps, in workflow order, with the chain command each runs. The
 * mutants below take their anchors from here rather than from hard-coded step
 * names, so only the non-vacuity test pins today's counts.
 */
function splitSteps(workflow: string, packageJson: string): SplitStep[] {
  const byRun = new Map<string, { readonly script: string; readonly position: number; readonly command: string }>();
  for (const [script, commands] of chainCommands(packageJson)) {
    commands.forEach((command, index) => byRun.set(stepRunFor(command), { script, position: index + 1, command }));
  }
  return gates(workflow).flatMap((step) => {
    const found = step.run === undefined ? undefined : byRun.get(step.run);
    return found === undefined || step.name === undefined ? [] : [{ name: step.name, ...found }];
  });
}

/** The split step that runs command `position` (1-based) of `script`. */
function splitStep(workflow: string, packageJson: string, script: string, position: number): SplitStep {
  const found = splitSteps(workflow, packageJson).find((step) => step.script === script && step.position === position);
  if (found === undefined) throw new Error(`fixture: no split step for ${script} command ${position}`);
  return found;
}

describe("ci.yml runs each command of package.json's && chains as its own gated step (CI-2, CI1-L5)", () => {
  it("the real ci.yml and package.json agree: no drift", async () => {
    const { workflow, packageJson } = await readRealTexts();
    expect(splitStepDrift(workflow, packageJson)).toEqual([]);
  });

  // CI-5: `test:integration` gained the control API's PostgreSQL suite (6 -> 7),
  // and `test:fault` became a chain of three (WAL, OMS, reconciliation) that
  // replaced one gate with three: 24 + 1 + 2 = 27 gates, 16 + 1 + 3 = 20 split.
  // CI-6: `test:fault` gained the live-safety suite and the live chaos suite's
  // typecheck and runner (3 -> 6), and `test:integration` gained the live
  // chaos suite's PostgreSQL half (7 -> 8): 27 + 3 + 1 = 31 gates, 20 + 4 = 24
  // split.
  // CI-7: `test:integration` gained the emergency CLI's PostgreSQL suite
  // (8 -> 9): 31 + 1 = 32 gates, 24 + 1 = 25 split.
  it("non-vacuity: 4 + 6 + 9 + 6 chained commands, each run by exactly one gated step, in chain order", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const chains = chainCommands(packageJson);
    expect(SPLIT_CHAINS.map(({ script }) => [script, chains.get(script)?.length])).toEqual([
      ["typecheck", 4],
      ["test:contract", 6],
      ["test:integration", 9],
      ["test:fault", 6],
    ]);
    const gateSteps = gates(workflow);
    expect(gateSteps).toHaveLength(32);
    for (const step of gateSteps) expect(step.condition, step.label).toBe(GATE_IF);
    for (const { script, label } of SPLIT_CHAINS) {
      const commands = chains.get(script) ?? [];
      const indices = commands.map((command, position) => {
        const matching = gateSteps.filter((step) => step.run === stepRunFor(command));
        expect(matching, command).toHaveLength(1);
        expect(matching[0]?.name ?? "", command).toMatch(
          new RegExp(`^${label} ${position + 1}/${commands.length} - `, "u"),
        );
        return matching[0]?.index ?? -1;
      });
      expect(indices, script).toEqual([...indices].sort((a, b) => a - b));
    }
    expect(splitSteps(workflow, packageJson)).toHaveLength(25);
  });

  it("CI-5, CI-6 and CI-7: the fault and PostgreSQL commands are chained, and stepped, in the order the rounds set", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const chains = chainCommands(packageJson);
    expect(chains.get("test:fault")).toEqual([
      // CI-5: the WAL (WP-050), OMS (WP-270) and reconciliation (WP-290) suites.
      "pnpm --filter @polymarket-bot/storage-wal test:fault",
      "pnpm --filter @polymarket-bot/oms test:fault",
      "pnpm --filter @polymarket-bot/ledger test:fault:reconciliation",
      // CI-6: WP-320's live-safety suite, through the trader's script, which
      // typechecks its own tree first. Then WP-340's live chaos suite, which
      // has no package script: its typecheck, then its runner.
      "pnpm --filter @polymarket-bot/trader test:fault:live-safety",
      "tsc --noEmit -p test/fault-injection/live/tsconfig.json",
      "vitest run --config test/fault-injection/live/vitest.config.ts",
    ]);
    expect(chains.get("test:integration")).toEqual([
      // CI-2: the six suites it split.
      "pnpm --filter @polymarket-bot/storage-postgres test:integration",
      "pnpm --filter @polymarket-bot/event-bus test:integration",
      "pnpm --filter @polymarket-bot/research-worker test:integration",
      "pnpm --filter @polymarket-bot/data-gateway test:integration",
      "pnpm --filter @polymarket-bot/trader test:integration",
      "pnpm --filter @polymarket-bot/control-api test:integration",
      // CI-5: the control API's real-PostgreSQL suite.
      "pnpm --filter @polymarket-bot/control-api test:integration:postgres",
      // CI-6: WP-340's real-PostgreSQL half, beside it.
      "vitest run --config test/fault-injection/live/postgres/vitest.config.ts",
      // CI-7 (CLOSEOUT-3 L1): WP-330's emergency CLI suite (real PostgreSQL,
      // the lease revocation, the audit mirror, the shipped bundle).
      "pnpm --filter @polymarket-bot/ops-cli test:integration",
    ]);
    // CI-6: the fault chain stays Docker-free. The live chaos suite's
    // PostgreSQL half is an integration command, not a fault one.
    expect((chains.get("test:fault") ?? []).filter((command) => command.includes("postgres"))).toEqual([]);
    // The old one-step fault gate is gone: nothing runs the root `test:fault` as one step.
    expect(gates(workflow).map((step) => step.run)).not.toContain("pnpm test:fault");
    const stepped = (script: string): (readonly [string, string | undefined])[] => {
      const byName = new Map(gates(workflow).map((step) => [step.name, step.run]));
      return splitSteps(workflow, packageJson)
        .filter((step) => step.script === script)
        .map(({ name }) => [name, byName.get(name)] as const);
    };
    // Each step's name, and the `run` it holds: a bare binary of the chain
    // runs through `pnpm exec` (THE ONE NORMALIZATION in ci-workflow.ts).
    expect(stepped("test:fault")).toEqual([
      ["Fault-injection tests 1/6 - storage-wal WAL (no container)", "pnpm --filter @polymarket-bot/storage-wal test:fault"],
      [
        "Fault-injection tests 2/6 - OMS crash points and restart (WP-270; no container)",
        "pnpm --filter @polymarket-bot/oms test:fault",
      ],
      [
        "Fault-injection tests 3/6 - ledger account reconciliation (WP-290; no container)",
        "pnpm --filter @polymarket-bot/ledger test:fault:reconciliation",
      ],
      [
        "Fault-injection tests 4/6 - trader live safety (WP-320; no container)",
        "pnpm --filter @polymarket-bot/trader test:fault:live-safety",
      ],
      [
        "Fault-injection tests 5/6 - live-micro chaos suite typecheck (WP-340; test/fault-injection/live/tsconfig.json)",
        "pnpm exec tsc --noEmit -p test/fault-injection/live/tsconfig.json",
      ],
      [
        "Fault-injection tests 6/6 - live-micro chaos suite (WP-340; mock venue; no container)",
        "pnpm exec vitest run --config test/fault-injection/live/vitest.config.ts",
      ],
    ]);
    // CI-7 recounted the container labels at its base (see the ci.yml comment
    // above these steps): 3/9, 4/9, 5/9 and 7/9 were stale (CLOSEOUT-3 I5,
    // CI-6's known risk, CLOSEOUT-2 L3).
    expect(stepped("test:integration")).toEqual([
      ["Integration tests 1/9 - storage-postgres (Testcontainers PostgreSQL)", "pnpm --filter @polymarket-bot/storage-postgres test:integration"],
      ["Integration tests 2/9 - event-bus (Testcontainers Redis)", "pnpm --filter @polymarket-bot/event-bus test:integration"],
      [
        "Integration tests 3/9 - research-worker parquet (Testcontainers PostgreSQL in 1 of its 6 files)",
        "pnpm --filter @polymarket-bot/research-worker test:integration",
      ],
      [
        "Integration tests 4/9 - data-gateway (Testcontainers Redis in 1 of its 16 files)",
        "pnpm --filter @polymarket-bot/data-gateway test:integration",
      ],
      [
        "Integration tests 5/9 - trader paper-trader (Testcontainers PostgreSQL and Redis in 23 of its 50 files)",
        "pnpm --filter @polymarket-bot/trader test:integration",
      ],
      ["Integration tests 6/9 - control-api (no container)", "pnpm --filter @polymarket-bot/control-api test:integration"],
      [
        "Integration tests 7/9 - control-api PostgreSQL (Testcontainers PostgreSQL in 4 of its 5 files)",
        "pnpm --filter @polymarket-bot/control-api test:integration:postgres",
      ],
      [
        "Integration tests 8/9 - live-micro fault-injection PostgreSQL half (WP-340; Testcontainers PostgreSQL; mock venue)",
        "pnpm exec vitest run --config test/fault-injection/live/postgres/vitest.config.ts",
      ],
      [
        "Integration tests 9/9 - ops-cli emergency CLI (WP-330; Testcontainers PostgreSQL)",
        "pnpm --filter @polymarket-bot/ops-cli test:integration",
      ],
    ]);
    // CI-6: the PostgreSQL half's step sits directly beside the control API's.
    // CI-7: the emergency CLI's step sits directly after it, the job's last step.
    const at = (script: string, position: number): number =>
      gates(workflow).find((step) => step.name === splitStep(workflow, packageJson, script, position).name)?.index ?? -1;
    expect(at("test:integration", 8)).toBe(at("test:integration", 7) + 1);
    expect(at("test:integration", 9)).toBe(at("test:integration", 8) + 1);
    expect(gates(workflow).at(-1)?.name).toBe(splitStep(workflow, packageJson, "test:integration", 9).name);
  });

  it("normalizes exactly one thing: a bare binary runs through `pnpm exec`, a pnpm command runs verbatim", () => {
    expect(stepRunFor("tsc -p test/tsconfig.json --noEmit")).toBe("pnpm exec tsc -p test/tsconfig.json --noEmit");
    expect(stepRunFor("pnpm -r run typecheck")).toBe("pnpm -r run typecheck");
    expect(stepRunFor("pnpm --filter @polymarket-bot/trader test:integration")).toBe(
      "pnpm --filter @polymarket-bot/trader test:integration",
    );
  });

  it("every job sets a timeout-minutes below GitHub's 360-minute default", async () => {
    const { workflow } = await readRealTexts();
    expect(jobTimeoutFindings(workflow)).toEqual([]);
    const root = parseWorkflowYaml(workflow);
    const jobs = root instanceof Map ? root.get("jobs") : undefined;
    // Non-vacuity: the check walked (at least) the three jobs CI-2 bounded.
    expect(jobs instanceof Map ? [...jobs.keys()] : []).toEqual(expect.arrayContaining(["node", "compose", "python"]));
  });
});

describe("the drift pin fails on each way the steps and the chains can diverge (CI-2, CI1-L5)", () => {
  it("a chained command's step removed from ci.yml — each split step in turn", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const split = splitSteps(workflow, packageJson);
    const commandCount = [...chainCommands(packageJson).values()].reduce((sum, commands) => sum + commands.length, 0);
    expect(split).toHaveLength(commandCount);
    for (const { name, command } of split) {
      expect(splitStepDrift(removeStep(workflow, name), packageJson), name).toEqual([
        expect.stringContaining(`${JSON.stringify(command)} has no gate step`),
      ]);
    }
  });

  it("an extra split step that is not in any chain — by its name, by its command, or the old one-step script", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const last = splitSteps(workflow, packageJson).at(-1)?.name ?? "";
    const extras = [
      // CI-7 chained ops-cli's suite, so this case now names a package no chain runs.
      gatedStep("Integration tests 10/10 - another app (no container)", "pnpm --filter @polymarket-bot/another-app test:integration"),
      gatedStep("Another suite", "pnpm --filter @polymarket-bot/ops-cli test:contract"),
      gatedStep("Typecheck", "pnpm typecheck"),
      gatedStep("Integration tests", "pnpm test:integration"),
      // CI-5: `test:fault` is split now, so its old one-step gate is a look-alike too.
      gatedStep("WAL fault-injection tests", "pnpm test:fault"),
      gatedStep("Fault-injection tests 7/7 - ops-cli (no container)", "pnpm --filter @polymarket-bot/ops-cli test:fault"),
      gatedStep("Another fault suite", "pnpm --filter @polymarket-bot/ops-cli test:fault"),
      // CI-6: a fault step whose bare-binary command is in no chain (its name
      // is the tell), and a typecheck of another tree (its `tsc` is).
      gatedStep("Fault-injection tests 7/7 - another tree", "pnpm exec vitest run --config test/fault-injection/other/vitest.config.ts"),
      gatedStep("Another tree typecheck", "pnpm exec tsc --noEmit -p test/fault-injection/other/tsconfig.json"),
    ];
    for (const extra of extras) {
      expect(splitStepDrift(insertStepAfter(workflow, last, extra), packageJson), extra[0]).toEqual([
        expect.stringContaining("looks like a split step"),
      ]);
    }
  });

  it("the same chained command run by two steps", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const { name } = splitStep(workflow, packageJson, "test:integration", 2);
    const copy = stepBlock(workflow, name).map((line) => line.replace(`name: ${name}`, `name: ${name} again`));
    expect(splitStepDrift(insertStepAfter(workflow, name, copy), packageJson)).toEqual([
      expect.stringContaining("runs in 2 gate steps"),
    ]);
  });

  it("a gate step that loses its if: — each gate after install in turn", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const gateSteps = gates(workflow);
    expect(gateSteps.length).toBeGreaterThan(splitSteps(workflow, packageJson).length);
    for (const step of gateSteps) {
      const mutant = setStepKey(workflow, step.name ?? "", "if", undefined);
      expect(splitStepDrift(mutant, packageJson), step.label).toEqual([
        `${step.label} runs after install without the gate condition: its \`if:\` is missing, not ${JSON.stringify(GATE_IF)}`,
      ]);
    }
  });

  it("a gate step whose if: no longer requires the install, or no longer survives a failure", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const { name } = splitStep(workflow, packageJson, "test:integration", 5);
    for (const condition of ["${{ !cancelled() }}", "${{ success() }}", "${{ always() && steps.install.outcome == 'success' }}"]) {
      expect(splitStepDrift(setStepKey(workflow, name, "if", condition), packageJson), condition).toEqual([
        expect.stringContaining(`its \`if:\` is ${JSON.stringify(condition)}`),
      ]);
    }
  });

  it("a gate step with a key a gate may not have, such as continue-on-error", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const { name } = splitStep(workflow, packageJson, "typecheck", 3);
    const mutant = edit(workflow, (lines) => {
      lines.splice(stepStart(lines, name) + 1, 0, `${STEP_KEY}continue-on-error: true`);
    });
    expect(splitStepDrift(mutant, packageJson)).toEqual([
      expect.stringContaining("has the key `continue-on-error`, which a gate step may not have"),
    ]);
  });

  it("the install step losing its id", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const install = nodeJobSteps(workflow).find((step) => step.id === "install");
    const mutant = setStepKey(workflow, install?.name ?? "", "id", "setup");
    expect(splitStepDrift(mutant, packageJson)).toEqual([expect.stringContaining("steps with `id: install`")]);
  });

  it("split steps out of the chain's order", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const mutant = moveStepAfter(
      workflow,
      splitStep(workflow, packageJson, "test:integration", 2).name,
      splitStep(workflow, packageJson, "test:integration", 4).name,
    );
    expect(splitStepDrift(mutant, packageJson)).toEqual([expect.stringContaining("comes before")]);
  });

  it("a split step named for the wrong position", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const commands = chainCommands(packageJson).get("test:contract") ?? [];
    const { name } = splitStep(workflow, packageJson, "test:contract", 3);
    const right = `Venue contract tests 3/${commands.length} - `;
    const wrong = `Venue contract tests 4/${commands.length} - `;
    expect(name.startsWith(right)).toBe(true);
    const mutant = edit(workflow, (lines) => {
      lines[stepStart(lines, name)] = `${STEP_ITEM}name: ${wrong}${name.slice(right.length)}`;
    });
    expect(splitStepDrift(mutant, packageJson)).toEqual([
      expect.stringContaining(`its name must begin with ${JSON.stringify(right)}`),
    ]);
  });

  it("a step that runs a chained command in any other spelling than the one normalization", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const cases: readonly (readonly [SplitStep, string])[] = [
      // A bare binary without `pnpm exec`: a step's shell cannot find it.
      [splitStep(workflow, packageJson, "typecheck", 2), "tsc -p test/tsconfig.json --noEmit"],
      // `pnpm exec` in front of a pnpm command is not the chain's command.
      [splitStep(workflow, packageJson, "typecheck", 1), "pnpm exec pnpm -r run typecheck"],
      // Whitespace is not folded.
      [
        splitStep(workflow, packageJson, "test:contract", 2),
        "pnpm --filter  @polymarket-bot/polymarket-public test:contract:rtds",
      ],
      // A different package with the same script (one no chain runs: CI-7 chained ops-cli's).
      [splitStep(workflow, packageJson, "test:integration", 4), "pnpm --filter @polymarket-bot/another-app test:integration"],
      // CI-6: the live chaos suite's bare binaries without `pnpm exec`.
      [splitStep(workflow, packageJson, "test:fault", 5), "tsc --noEmit -p test/fault-injection/live/tsconfig.json"],
      [splitStep(workflow, packageJson, "test:fault", 6), "vitest run --config test/fault-injection/live/vitest.config.ts"],
      [
        splitStep(workflow, packageJson, "test:integration", 8),
        "vitest run --config test/fault-injection/live/postgres/vitest.config.ts",
      ],
    ];
    for (const [step, run] of cases) {
      // Each mutant differs from the command the step ran before.
      expect(stepRunFor(step.command), run).not.toBe(run);
      const findings = splitStepDrift(setStepKey(workflow, step.name, "run", run), packageJson);
      expect(findings, run).toEqual([
        expect.stringContaining("has no gate step"),
        expect.stringContaining("looks like a split step"),
      ]);
    }
    // CI-6: the PostgreSQL half's step running the Docker-free runner beside it
    // instead. That runner's command then runs in two steps, and the half's in none.
    const { name } = splitStep(workflow, packageJson, "test:integration", 8);
    const docker = setStepKey(workflow, name, "run", "pnpm exec vitest run --config test/fault-injection/live/vitest.config.ts");
    expect(splitStepDrift(docker, packageJson)).toEqual([
      expect.stringContaining('"vitest run --config test/fault-injection/live/postgres/vitest.config.ts" has no gate step'),
      expect.stringContaining('"vitest run --config test/fault-injection/live/vitest.config.ts" runs in 2 gate steps'),
    ]);
  });

  it("a copy of package.json whose chain gains a command — each of the four chains", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const gained: readonly (readonly [string, string])[] = [
      ["typecheck", "tsc -p test/extra/tsconfig.json --noEmit"],
      ["test:contract", "pnpm --filter @polymarket-bot/ops-cli test:contract"],
      // CI-7 chained ops-cli's suite, so a second copy would be refused as a duplicate.
      ["test:integration", "pnpm --filter @polymarket-bot/another-app test:integration"],
      ["test:fault", "pnpm --filter @polymarket-bot/ops-cli test:fault"],
    ];
    // Non-vacuity: one case per split chain.
    expect(gained.map(([script]) => script)).toEqual(SPLIT_CHAINS.map(({ script }) => script));
    const chains = chainCommands(packageJson);
    for (const [script, command] of gained) {
      const copy = withScript(packageJson, script, [...(chains.get(script) ?? []), command].join(" && "));
      expect(chainCommands(copy).get(script)).toHaveLength((chains.get(script)?.length ?? 0) + 1);
      const findings = splitStepDrift(workflow, copy);
      expect(findings, script).toContainEqual(expect.stringContaining(`${JSON.stringify(command)} has no gate step`));
    }
  });

  it("a copy of package.json whose chain loses a command, or reorders two", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const commands = chainCommands(packageJson).get("test:integration") ?? [];
    const dropped = commands.filter((_, index) => index !== 2);
    expect(splitStepDrift(workflow, withScript(packageJson, "test:integration", dropped.join(" && ")))).toContainEqual(
      expect.stringContaining(`looks like a split step (its name) but runs no command`),
    );
    const swapped = [commands[1], commands[0], ...commands.slice(2)];
    expect(splitStepDrift(workflow, withScript(packageJson, "test:integration", swapped.join(" && ")))).toContainEqual(
      expect.stringContaining("comes before"),
    );
  });

  it("L5-1: the root script a non-split gate runs becomes an && chain — each such gate in turn", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const scripts = scriptsOf(packageJson);
    const split = new Set<string>(SPLIT_CHAINS.map(({ script }) => script));
    const scriptGates = gates(workflow).flatMap((gate) => {
      const script = /^pnpm (?:run )?([^\s-]\S*)(?:\s|$)/u.exec(gate.run ?? "")?.[1];
      return script !== undefined && script in scripts && !split.has(script) ? [{ gate, script }] : [];
    });
    // Non-vacuity: every node gate that runs a root script other than a split
    // chain. `pnpm audit --audit-level high` runs pnpm's built-in `audit`,
    // which the check (like this list) takes for the root script of that name:
    // it can only over-report (see ci-workflow.ts). `test:fault` left this list
    // in `CI-5`, when it became a split chain.
    expect(scriptGates.map(({ script }) => script)).toEqual([
      "lint",
      "check:deps",
      "test",
      "test:e2e",
      "test:replay",
      "test:soak-smoke",
      "audit",
    ]);
    for (const { gate, script } of scriptGates) {
      expect(scripts[script], script).not.toContain("&&");
      const copy = withScript(packageJson, script, `${scripts[script] ?? ""} && node tools/another-check.mjs`);
      expect(splitStepDrift(workflow, copy), script).toEqual([
        expect.stringContaining(
          `${gate.label} runs the root script \`${script}\` as one step, and \`${script}\` is an \`&&\` chain`,
        ),
      ]);
    }
  });

  it("L5-1: the review's two cases, test:fault and test:e2e each becoming a two-command chain", async () => {
    const { workflow, packageJson } = await readRealTexts();
    // test:e2e is still a one-step gate, so the L5-1 rule reports it. So is
    // test:replay, which stands in here for test:fault since CI-5.
    const cases: readonly (readonly [string, string])[] = [
      ["test:replay", REPLAY_SCRIPT_CHAIN],
      ["test:e2e", "vitest run --config test/e2e/vitest.config.ts && vitest run --config test/e2e/other.config.ts"],
    ];
    for (const [script, chain] of cases) {
      expect(splitStepDrift(workflow, withScript(packageJson, script, chain)), script).toEqual([
        expect.stringContaining(`runs the root script \`${script}\` as one step`),
      ]);
    }
    // The review's own test:fault case. Since CI-5, test:fault is a split
    // chain, so the split checks report it, not the L5-1 rule: the new second
    // command has no step, the first is named for the wrong position, and the
    // steps whose commands left the chain (five since CI-6) are look-alikes.
    const fault = splitStepDrift(
      workflow,
      withScript(
        packageJson,
        "test:fault",
        "pnpm --filter @polymarket-bot/storage-wal test:fault && pnpm --filter @polymarket-bot/storage-postgres test:fault",
      ),
    );
    const leftTheChain = splitSteps(workflow, packageJson)
      .filter(({ script, position }) => script === "test:fault" && position > 1)
      .map(({ name }) => name);
    expect(leftTheChain).toHaveLength(5);
    expect(fault).toEqual([
      expect.stringContaining('its name must begin with "Fault-injection tests 1/2 - "'),
      expect.stringContaining('"pnpm --filter @polymarket-bot/storage-postgres test:fault" has no gate step'),
      ...leftTheChain.map((name) => expect.stringContaining(`${JSON.stringify(name)} looks like a split step`)),
    ]);
  });

  it("L5-1: a chain reached through another root script, or written into the step itself", async () => {
    const { workflow, packageJson } = await readRealTexts();
    // `test:replay` (`test:fault` before CI-5 split it) runs a new root script that is a chain.
    const through = withAddedScript(
      withScript(packageJson, "test:replay", "pnpm run test:replay:all"),
      "test:replay:all",
      REPLAY_SCRIPT_CHAIN,
    );
    expect(splitStepDrift(workflow, through)).toEqual([
      expect.stringContaining("runs the root script `test:replay` -> `test:replay:all` as one step"),
    ]);
    // `test:replay` runs a split chain under its own name, which the look-alike
    // check (by name or command) cannot see from the step.
    expect(splitStepDrift(workflow, withScript(packageJson, "test:replay", "pnpm typecheck"))).toEqual([
      expect.stringContaining("runs the root script `test:replay` -> `typecheck` as one step"),
    ]);
    // The chain written into a step's own `run`.
    expect(splitStepDrift(setStepKey(workflow, "Lint", "run", "pnpm lint && pnpm check:deps"), packageJson)).toEqual([
      expect.stringContaining('"Lint" chains commands with `&&` in its own `run`'),
    ]);
  });

  it("RES-PY: a python gate after sync that loses its if: — each in turn", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const pythonGates = gatesAfter(workflow, "python", "sync");
    // Non-vacuity, and the real file's state: every gate carries the sync condition.
    expect(pythonGates.map(({ name, condition }) => [name, condition])).toEqual([
      ["Pytest", SYNC_GATE_IF],
      ["Dependency vulnerability scan (uv lockfile)", SYNC_GATE_IF],
      ["Brief records check", SYNC_GATE_IF],
      ["Brief records self-test", SYNC_GATE_IF],
    ]);
    for (const { number, name } of pythonGates) {
      expect(splitStepDrift(setStepKey(workflow, name, "if", undefined), packageJson), name).toEqual([
        `jobs.python step ${number} "${name}" runs after sync without the gate condition: its \`if:\` is missing, ` +
          `not ${JSON.stringify(SYNC_GATE_IF)}`,
      ]);
    }
  });

  it("RES-PY: a python gate whose if: requires the install instead of the sync, or no longer survives a failure", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const conditions = [
      // The node job's condition: it names a step the python job does not have.
      GATE_IF,
      "${{ !cancelled() }}",
      "${{ success() }}",
      "${{ always() && steps.sync.outcome == 'success' }}",
    ];
    for (const condition of conditions) {
      expect(splitStepDrift(setStepKey(workflow, "Pytest", "if", condition), packageJson), condition).toEqual([
        expect.stringContaining(
          `"Pytest" runs after sync without the gate condition: its \`if:\` is ${JSON.stringify(condition)}`,
        ),
      ]);
    }
  });

  it("RES-PY: a python gate with continue-on-error, and the sync step losing its id", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const audit = "Dependency vulnerability scan (uv lockfile)";
    const withKey = edit(workflow, (lines) => {
      lines.splice(stepStart(lines, audit) + 1, 0, `${STEP_KEY}continue-on-error: true`);
    });
    expect(splitStepDrift(withKey, packageJson)).toEqual([
      expect.stringContaining(`"${audit}" has the key \`continue-on-error\`, which a gate step may not have`),
    ]);
    expect(splitStepDrift(setStepKey(workflow, "Sync (frozen lockfile)", "id", "frozen"), packageJson)).toEqual([
      expect.stringContaining("the python job has 0 steps with `id: sync`"),
    ]);
  });

  it("a job without timeout-minutes, or with one that bounds nothing", async () => {
    const { workflow } = await readRealTexts();
    const without = workflow.replace("\n    timeout-minutes: 30\n", "\n");
    expect(without).not.toBe(workflow);
    expect(jobTimeoutFindings(without)).toEqual([expect.stringContaining("job `node` sets no `timeout-minutes`")]);
    const unbounded = workflow.replace("\n    timeout-minutes: 30\n", "\n    timeout-minutes: 360\n");
    expect(jobTimeoutFindings(unbounded)).toEqual([expect.stringContaining("job `node` has `timeout-minutes: 360`")]);
  });
});

describe("the workflow reader and the chain parser refuse what they cannot read (CI-2, CI1-L5)", () => {
  it("reads the YAML subset it claims", () => {
    const text = [
      "# a comment",
      "name: ci",
      "on:",
      "  push:",
      "    branches: [main, release/x]",
      "  pull_request:",
      "jobs:",
      "  node:",
      "    timeout-minutes: 30 # trailing comment",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "",
      "      # a comment between items",
      "      - name: A step (with; punctuation, and - dashes)",
      "        if: ${{ !cancelled() && steps.install.outcome == 'success' }}",
      "        with:",
      '          version: "24"',
      "          other: 'x'",
      "        run: |",
      "          first line",
      "            # indented content, not a comment",
      "",
      "          last line",
      "",
      "      -",
      "        name: spelled apart",
      "",
    ].join("\n");
    const toPlain = (value: unknown): unknown =>
      value instanceof Map
        ? Object.fromEntries([...value].map(([key, inner]) => [key, toPlain(inner)]))
        : Array.isArray(value)
          ? value.map(toPlain)
          : value;
    expect(toPlain(parseWorkflowYaml(text))).toEqual({
      name: "ci",
      on: { push: { branches: ["main", "release/x"] }, pull_request: null },
      jobs: {
        node: {
          "timeout-minutes": "30",
          steps: [
            { uses: "actions/checkout@v4" },
            {
              name: "A step (with; punctuation, and - dashes)",
              if: "${{ !cancelled() && steps.install.outcome == 'success' }}",
              with: { version: "24", other: "x" },
              run: "first line\n  # indented content, not a comment\n\nlast line\n",
            },
            { name: "spelled apart" },
          ],
        },
      },
    });
  });

  it("refuses YAML outside that subset instead of guessing", () => {
    const refused: readonly (readonly [string, string])[] = [
      ["a tab", "a:\n\tb: c\n"],
      ["a CR line end", "a: b\r\n"],
      ["an anchor", "a: &x b\n"],
      ["an alias", "a: *x\n"],
      ["a tag", "a: !!str b\n"],
      ["a flow mapping", "a: {b: c}\n"],
      ["a folded block", "a: >\n  b\n"],
      ["a chomped literal block", "a: |-\n  b\n"],
      ["an indentation indicator", "a: |2\n  b\n"],
      ["a duplicate key", "a: b\na: c\n"],
      ["an indentless sequence", "a:\n- b\n"],
      ["a document marker", "---\na: b\n"],
      ["`: ` inside a plain scalar", "a: b: c\n"],
      ["an escape in a double-quoted scalar", 'a: "b\\n"\n'],
      ["a multi-line plain scalar", "a: b\n  c\n"],
      ["a quoted flow element", "a: ['b']\n"],
      ["a nested flow sequence", "a: [[b]]\n"],
      ["a quoted key", '"a": b\n'],
      ["two spaces after a dash", "a:\n  -  b: c\n"],
      ["a misaligned key in a sequence item", "a:\n  - b: c\n     d: e\n"],
      ["a non-space before the content", "a:\n\u00a0 b: c\n"],
      ["an empty document", "# only a comment\n"],
      ["a second root node", "a: b\n- c\n"],
    ];
    for (const [what, text] of refused) {
      expect(() => parseWorkflowYaml(text), what).toThrow(/^workflow reader: /u);
    }
  });

  it("refuses a chain that is not plain commands joined by ` && `", async () => {
    const { packageJson } = await readRealTexts();
    const refused = [
      "pnpm a && pnpm b || pnpm c",
      "pnpm a; pnpm b",
      "pnpm a | tee out",
      "pnpm a && pnpm $(b)",
      "pnpm a  && pnpm b",
      'pnpm a && pnpm "b"',
      "pnpm a > out",
      "pnpm a &&pnpm b",
      "pnpm a && ",
    ];
    for (const script of refused) {
      expect(() => chainCommands(withScript(packageJson, "typecheck", script)), script).toThrow(/not a plain command/u);
    }
    const typecheck = chainCommands(packageJson).get("typecheck") ?? [];
    const shared = withScript(packageJson, "test:contract", `${typecheck[0] ?? ""} && pnpm b`);
    expect(() => chainCommands(shared)).toThrow(/appears twice/u);
    const parsed = JSON.parse(packageJson) as { scripts: Record<string, string> };
    delete parsed.scripts["test:integration"];
    expect(() => chainCommands(JSON.stringify(parsed))).toThrow(/script `test:integration` is missing/u);
  });
});

/**
 * `DEPCHECK-1` ride-alongs, the two LOWs of `CI-2` review r2
 * (`docs/handoffs/CI-2.md`; `IMPLEMENTATION_STATUS.md` rows `CI2-L5-2`,
 * `CI2-L5-3`). Every positive case below returns no finding under the drift
 * check at `45c575a`; every negative case fails under a named mutant of the new
 * code. Both proofs are in `docs/handoffs/DEPCHECK-1.md`. They were made with
 * the cases on `test:fault` and its gate; `CI-5` moved the cases to
 * `test:replay` and its gate (`REPLAY_GATE`), unchanged otherwise, when it made
 * `test:fault` a split chain.
 */
describe("DEPCHECK-1 ride-alongs: multi-command run blocks (CI2-L5-2) and the other root-script spellings (CI2-L5-3)", () => {
  /** A gated node step whose `run` is a literal block of `lines`. */
  function gatedBlockStep(name: string, lines: readonly string[]): string[] {
    return [
      `${STEP_ITEM}name: ${name}`,
      `${STEP_KEY}if: ${GATE_IF}`,
      `${STEP_KEY}run: |`,
      ...lines.map((line) => (line === "" ? "" : `${STEP_KEY}  ${line}`)),
    ];
  }

  /** Replaces the named step's one-line `run:` with a literal block of `lines`. */
  function setStepRunBlock(workflow: string, name: string, lines: readonly string[]): string {
    return edit(workflow, (all) => {
      const start = stepStart(all, name);
      const end = stepEnd(all, start);
      const at = all.findIndex((line, index) => index > start && index < end && line.startsWith(`${STEP_KEY}run: `));
      if (at < 0) throw new Error(`mutant: step ${JSON.stringify(name)} has no one-line \`run:\``);
      all.splice(at, 1, `${STEP_KEY}run: |`, ...lines.map((line) => (line === "" ? "" : `${STEP_KEY}  ${line}`)));
    });
  }

  /** A copy of package.json whose `test:replay` is a two-command chain (the shape of the review's L5-1 case). */
  function withChainedReplay(packageJson: string): string {
    return withScript(packageJson, "test:replay", REPLAY_SCRIPT_CHAIN);
  }

  it("CI2-L5-2: a gate running two independent gates in one block, or on one line with `;`, is flagged", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const last = splitSteps(workflow, packageJson).at(-1)?.name ?? "";
    // The review's case: `pnpm lint` then `pnpm check:deps` in one `run: |`.
    const block = insertStepAfter(workflow, last, gatedBlockStep("Lint and boundaries", ["pnpm lint", "pnpm check:deps"]));
    expect(splitStepDrift(block, packageJson)).toEqual([
      expect.stringContaining('"Lint and boundaries" runs 2 commands in one step ("pnpm lint", "pnpm check:deps")'),
    ]);
    const semicolon = insertStepAfter(workflow, last, gatedStep("Lint and boundaries", "pnpm lint; pnpm check:deps"));
    expect(splitStepDrift(semicolon, packageJson)).toEqual([
      expect.stringContaining('"Lint and boundaries" runs 2 commands in one step ("pnpm lint", "pnpm check:deps")'),
    ]);
    const three = insertStepAfter(
      workflow,
      last,
      gatedBlockStep("Suites", ["pnpm test:e2e", "node tools/check-dependency-direction.mjs", "pnpm test:replay"]),
    );
    expect(splitStepDrift(three, packageJson)).toEqual([expect.stringContaining('"Suites" runs 3 commands in one step')]);
  });

  it("CI2-L5-2: every command of a block is followed to a chained root script, not only the first line", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const chained = withChainedReplay(packageJson);
    // A comment is not a command, so this block is one command, on its second line.
    const commentFirst = setStepRunBlock(workflow, REPLAY_GATE, ["# the replay goldens", "pnpm test:replay"]);
    expect(splitStepDrift(commentFirst, chained)).toEqual([
      expect.stringContaining(`"${REPLAY_GATE}" runs the root script \`test:replay\` as one step`),
    ]);
    // Two commands: the chain on the second line, and the block itself.
    const echoFirst = setStepRunBlock(workflow, REPLAY_GATE, ["echo replay goldens", "pnpm test:replay"]);
    expect(splitStepDrift(echoFirst, chained)).toEqual([
      expect.stringContaining(`"${REPLAY_GATE}" runs the root script \`test:replay\` as one step`),
      expect.stringContaining(`"${REPLAY_GATE}" runs 2 commands in one step ("echo replay goldens", "pnpm test:replay")`),
    ]);
  });

  it("CI2-L5-2: blank lines, comments and a `\\` continuation are not extra commands", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const mutant = setStepRunBlock(workflow, REPLAY_GATE, [
      "# one command, continued on the next line",
      "",
      "pnpm test:replay \\",
      "  --reporter=verbose",
    ]);
    expect(splitStepDrift(mutant, packageJson)).toEqual([]);
    const gate = nodeJobSteps(mutant).find((step) => step.name === REPLAY_GATE);
    expect(shellCommands(gate?.run ?? "").map((command) => command.text)).toEqual(["pnpm test:replay --reporter=verbose"]);
  });

  it("CI2-L5-2: the python audit block is recorded as dependent in its exact text; a changed block and its stale record are reported", async () => {
    const { workflow, packageJson } = await readRealTexts();
    // Non-vacuity: exactly one recorded block, and it is the real ci.yml's.
    expect(DEPENDENT_RUN_BLOCKS.map(({ job, step }) => [job, step])).toEqual([
      ["python", "Dependency vulnerability scan (uv lockfile)"],
    ]);
    const [recorded] = DEPENDENT_RUN_BLOCKS;
    const audit = jobSteps(workflow, "python").find((step) => step.name === recorded.step);
    expect(audit?.run).toBe(recorded.run);
    // Genuinely dependent: the second command reads the file the first writes.
    const commands = shellCommands(audit?.run ?? "").map((command) => command.text);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/> \/tmp\/requirements-audit\.txt$/u);
    expect(commands[1]).toMatch(/-r \/tmp\/requirements-audit\.txt$/u);
    // A third, independent command added to the block un-records it.
    const grown = edit(workflow, (lines) => {
      const start = stepStart(lines, recorded.step);
      lines.splice(stepEnd(lines, start), 0, `${STEP_KEY}  uvx pip-audit --version`);
    });
    expect(splitStepDrift(grown, packageJson)).toEqual([
      expect.stringContaining(`"${recorded.step}" runs 3 commands in one step`),
      expect.stringContaining(`DEPENDENT_RUN_BLOCKS records the python step ${JSON.stringify(recorded.step)}`),
    ]);
  });

  it("CI2-L5-3: every spelling that runs the ROOT script is followed", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const chained = withChainedReplay(packageJson);
    const spellings = [
      // The review's five.
      "pnpm -C . test:replay",
      "pnpm --dir . test:replay",
      "pnpm --filter polymarket-bot test:replay",
      'pnpm run "test:replay"',
      "npm run test:replay",
      // Their neighbours.
      "pnpm -C ./ run test:replay",
      "pnpm --dir=. test:replay",
      "pnpm --filter=polymarket-bot run test:replay",
      "pnpm -F polymarket-bot test:replay",
      "pnpm --filter polymarket-bot... test:replay",
      "pnpm --filter . test:replay",
      "pnpm --filter {.} test:replay",
      "pnpm -w test:replay",
      "pnpm --workspace-root run test:replay",
      "pnpm -r --include-workspace-root run test:replay",
      "pnpm run 'test:replay'",
      'pnpm "test:replay"',
      "pnpm --silent run test:replay",
      "CI=true pnpm test:replay",
      "pnpm exec pnpm test:replay",
      "npm run-script test:replay",
      "npm --prefix . run test:replay",
      "npm run --if-present test:replay",
    ];
    for (const run of spellings) {
      expect(splitStepDrift(setStepKey(workflow, REPLAY_GATE, "run", run), chained), run).toEqual([
        expect.stringContaining(`"${REPLAY_GATE}" runs the root script \`test:replay\` as one step`),
      ]);
    }
    // npm's own names for the `test` script.
    const testChained = withScript(
      packageJson,
      "test",
      "vitest run --config test/vitest.config.ts && vitest run --config test/other.config.ts",
    );
    for (const run of ["npm test", "npm t", "npm run test"]) {
      expect(splitStepDrift(setStepKey(workflow, "Unit tests", "run", run), testChained), run).toEqual([
        expect.stringContaining('"Unit tests" runs the root script `test` as one step'),
      ]);
    }
  });

  it("CI2-L5-3: a spelling that runs a workspace package's script, or that the reader cannot read, is not taken for the root's", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const chained = withChainedReplay(packageJson);
    const negatives = [
      // A workspace package's script of the same name (the real fault step's
      // spelling, until CI-5 split `test:fault`).
      "pnpm --filter @polymarket-bot/storage-wal test:replay",
      "pnpm --filter=@polymarket-bot/storage-wal test:replay",
      "pnpm -F ./packages/storage-wal test:replay",
      "pnpm --filter polymarket-bot^... test:replay",
      "pnpm -C packages/storage-wal test:replay",
      "pnpm --dir packages/storage-wal run test:replay",
      "pnpm --dir=packages/storage-wal test:replay",
      "pnpm -r run test:replay",
      "npm --workspace packages/storage-wal run test:replay",
      "npm --workspace=packages/storage-wal run test:replay",
      "npm -w packages/storage-wal run test:replay",
      "npm --workspaces run test:replay",
      "npm --prefix packages/storage-wal run test:replay",
      // A word the reader cannot read ends the search: it could be anything.
      "pnpm $FLAGS test:replay",
      'pnpm run "$SCRIPT"',
    ];
    for (const run of negatives) {
      expect(splitStepDrift(setStepKey(workflow, REPLAY_GATE, "run", run), chained), run).toEqual([]);
    }
  });
});

/**
 * `CI-7` (CLOSEOUT-3 L1). WP-330's `pnpm --filter @polymarket-bot/ops-cli
 * test:integration` ran in no gate from its merge (`c1e6909`) until
 * CLOSEOUT-3 found it: neither the root `test:integration` chain nor `ci.yml`
 * named it, and the split check above only holds the steps to the chains. This rule holds the chains to the
 * workspace packages' scripts (see THE INTEGRATION-SCRIPT RULE in
 * `ci-workflow.ts`). Every mutant below is an in-memory copy of the root
 * `package.json`, of `ci.yml` or of the workspace manifests.
 */
describe("CI-7 (CLOSEOUT-3 L1): every workspace package's integration script runs in the root test:integration chain, or is exempted with a reason", () => {
  const OPS_CLI_COMMAND = "pnpm --filter @polymarket-bot/ops-cli test:integration";

  /** The finding for an unchained `script` of the package in `dir`, up to the advice that follows it. */
  function unchained(dir: string, name: string, script: string): string {
    return (
      `${dir}/package.json's \`${script}\` script runs in no gate: the root \`test:integration\` chain has no ` +
      JSON.stringify(packageScriptCommand(name, script))
    );
  }

  /** A copy of `manifests` whose manifest in `dir` is changed by `change`. */
  function withManifest(
    manifests: readonly WorkspaceManifest[],
    dir: string,
    change: (manifest: { name?: unknown; scripts?: Record<string, string> }) => void,
  ): WorkspaceManifest[] {
    if (manifests.filter((manifest) => manifest.dir === dir).length !== 1) throw new Error(`mutant: no single manifest in ${dir}`);
    return manifests.map((manifest) => {
      if (manifest.dir !== dir) return manifest;
      const parsed = JSON.parse(manifest.text) as { name?: unknown; scripts?: Record<string, string> };
      change(parsed);
      const text = `${JSON.stringify(parsed, null, 2)}\n`;
      if (JSON.stringify(JSON.parse(text)) === JSON.stringify(JSON.parse(manifest.text))) {
        throw new Error(`mutant: the edit of ${dir} changed nothing`);
      }
      return { dir, text };
    });
  }

  /** A new workspace package in `dir` with these scripts. */
  function newManifest(dir: string, name: string, scripts: Readonly<Record<string, string>>): WorkspaceManifest {
    return { dir, text: `${JSON.stringify({ name, private: true, scripts }, null, 2)}\n` };
  }

  /** A copy of `package.json` text whose `test:integration` chain lacks `command`. */
  function withoutIntegrationCommand(packageJson: string, command: string): string {
    const commands = chainCommands(packageJson).get("test:integration") ?? [];
    if (!commands.includes(command)) throw new Error(`mutant: the chain has no ${command}`);
    return withScript(packageJson, "test:integration", commands.filter((each) => each !== command).join(" && "));
  }

  /**
   * The integration scripts of `manifests`, read here without the rule under
   * test: every script named `test:integration` or `test:integration:<x>`.
   */
  function integrationScripts(manifests: readonly WorkspaceManifest[]): (readonly [string, string, string])[] {
    return manifests
      .flatMap((manifest) => {
        const parsed = JSON.parse(manifest.text) as { readonly name: string; readonly scripts?: Readonly<Record<string, string>> };
        return Object.keys(parsed.scripts ?? {})
          .filter((script) => script === "test:integration" || script.startsWith("test:integration:"))
          .map((script) => [manifest.dir, parsed.name, script] as const);
      })
      .sort((a, b) => (`${a[0]} ${a[2]}` < `${b[0]} ${b[2]}` ? -1 : 1));
  }

  it("the real workspace and root chain agree: no finding, and no exemption", async () => {
    const { packageJson } = await readRealTexts();
    const { manifests } = await readRealWorkspace();
    expect(integrationScriptFindings(packageJson, manifests)).toEqual([]);
    expect(UNCHAINED_INTEGRATION_SCRIPTS).toEqual([]);
  });

  it("non-vacuity: three workspace globs, 35 packages, and eight integration scripts of seven packages, each chained", async () => {
    const { packageJson } = await readRealTexts();
    const { globs, manifests } = await readRealWorkspace();
    expect(globs).toEqual(["apps/*", "packages/*", "packages/strategies/*"]);
    // `pnpm -r run typecheck` reports 35 workspace projects besides the root, and check:deps 35 packages.
    expect(manifests).toHaveLength(35);
    expect(manifests.map(({ dir }) => dir)).toEqual(expect.arrayContaining(["apps/ops-cli", "packages/strategies/static-bracket"]));
    const scripts = integrationScripts(manifests);
    expect(scripts).toEqual([
      ["apps/control-api", "@polymarket-bot/control-api", "test:integration"],
      ["apps/control-api", "@polymarket-bot/control-api", "test:integration:postgres"],
      ["apps/data-gateway", "@polymarket-bot/data-gateway", "test:integration"],
      ["apps/ops-cli", "@polymarket-bot/ops-cli", "test:integration"],
      ["apps/research-worker", "@polymarket-bot/research-worker", "test:integration"],
      ["apps/trader", "@polymarket-bot/trader", "test:integration"],
      ["packages/event-bus", "@polymarket-bot/event-bus", "test:integration"],
      ["packages/storage-postgres", "@polymarket-bot/storage-postgres", "test:integration"],
    ]);
    const chain = chainCommands(packageJson).get("test:integration") ?? [];
    for (const [, name, script] of scripts) expect(chain, script).toContain(packageScriptCommand(name, script));
  });

  it("L1, the mutant: a chain that drops the ops-cli command fails the rule, which the split check alone did not", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const { manifests } = await readRealWorkspace();
    const dropped = withoutIntegrationCommand(packageJson, OPS_CLI_COMMAND);
    const finding = unchained("apps/ops-cli", "@polymarket-bot/ops-cli", "test:integration");
    expect(integrationScriptFindings(dropped, manifests)).toEqual([expect.stringContaining(finding)]);
    // With today's ci.yml, the split check also reports the 9/9 step, which now runs no chained command.
    const nine = splitStep(workflow, packageJson, "test:integration", 9).name;
    expect(splitStepDrift(workflow, dropped)).toContainEqual(
      expect.stringContaining(`${JSON.stringify(nine)} looks like a split step (its name) but runs no command`),
    );
    // The tree before CI-7: no 9/9 step, and every other step named x/8. The
    // split check finds nothing, which is how the suite stayed ungated; the
    // new rule reports it.
    const before = removeStep(workflow, nine).replaceAll(/(Integration tests [1-8])\/9 - /gu, "$1/8 - ");
    expect(splitStepDrift(before, dropped)).toEqual([]);
    expect(integrationScriptFindings(dropped, manifests)).toHaveLength(1);
  });

  it("each chained package integration script, dropped from the chain in turn, is reported, and only it", async () => {
    const { packageJson } = await readRealTexts();
    const { manifests } = await readRealWorkspace();
    const scripts = integrationScripts(manifests);
    expect(scripts).toHaveLength(8);
    for (const [dir, name, script] of scripts) {
      const dropped = withoutIntegrationCommand(packageJson, packageScriptCommand(name, script));
      expect(integrationScriptFindings(dropped, manifests), `${dir} ${script}`).toEqual([
        expect.stringContaining(unchained(dir, name, script)),
      ]);
    }
  });

  it("a new integration script, in a new package or an existing one, is reported until it is chained or exempted", async () => {
    const { packageJson } = await readRealTexts();
    const { manifests } = await readRealWorkspace();
    const another = newManifest("apps/another-app", "@polymarket-bot/another-app", {
      "test:integration": "vitest run --config ../../test/integration/another-app/vitest.config.ts",
    });
    expect(integrationScriptFindings(packageJson, [...manifests, another])).toEqual([
      expect.stringContaining(unchained("apps/another-app", "@polymarket-bot/another-app", "test:integration")),
    ]);
    // A `test:integration:<x>` script of a package that is already chained (the CI-5 shape).
    const soak = withManifest(manifests, "packages/event-bus", (manifest) => {
      manifest.scripts = { ...manifest.scripts, "test:integration:soak": "vitest run --config ../../test/integration/event-bus/soak.config.ts" };
    });
    expect(integrationScriptFindings(packageJson, soak)).toEqual([
      expect.stringContaining(unchained("packages/event-bus", "@polymarket-bot/event-bus", "test:integration:soak")),
    ]);
    // Chained: nothing to report.
    const chained = withScript(
      packageJson,
      "test:integration",
      [...(chainCommands(packageJson).get("test:integration") ?? []), "pnpm --filter @polymarket-bot/another-app test:integration"].join(" && "),
    );
    expect(integrationScriptFindings(chained, [...manifests, another])).toEqual([]);
    // Exempted, with a reason: nothing to report.
    const exemption: UnchainedIntegrationScript = {
      package: "@polymarket-bot/another-app",
      script: "test:integration",
      why: "a manual multi-hour soak, not a gate",
    };
    expect(integrationScriptFindings(packageJson, [...manifests, another], [exemption])).toEqual([]);
    // Scripts outside the rule are not reported.
    const others = newManifest("apps/other-app", "@polymarket-bot/other-app", {
      "test:integrationx": "vitest run",
      "test:contract": "vitest run",
      "test:e2e": "vitest run",
      integration: "vitest run",
    });
    expect(integrationScriptFindings(packageJson, [...manifests, others])).toEqual([]);
  });

  it("an exemption that no longer applies, or that gives no reason, is itself a finding", async () => {
    const { packageJson } = await readRealTexts();
    const { manifests } = await readRealWorkspace();
    const another = newManifest("apps/another-app", "@polymarket-bot/another-app", { "test:integration": "vitest run" });
    const cases: readonly (readonly [UnchainedIntegrationScript, readonly WorkspaceManifest[], string])[] = [
      [{ package: "@polymarket-bot/ops-cli", script: "test:integration", why: "x" }, manifests, "but the root `test:integration` chain runs it"],
      [{ package: "@polymarket-bot/another-app", script: "test:integration", why: "x" }, manifests, "no workspace package defines that script any more"],
      [{ package: "@polymarket-bot/ops-cli", script: "test:integration:soak", why: "x" }, manifests, "no workspace package defines that script any more"],
      [{ package: "@polymarket-bot/ops-cli", script: "build", why: "x" }, manifests, "which is not an integration script the rule covers"],
      [{ package: "@polymarket-bot/another-app", script: "test:integration", why: "  " }, [...manifests, another], "without a reason"],
    ];
    for (const [entry, workspace, expected] of cases) {
      expect(integrationScriptFindings(packageJson, workspace, [entry]), JSON.stringify(entry)).toEqual([
        expect.stringContaining(`UNCHAINED_INTEGRATION_SCRIPTS exempts ${entry.package} \`${entry.script}\``),
      ]);
      expect(integrationScriptFindings(packageJson, workspace, [entry])[0], JSON.stringify(entry)).toContain(expected);
    }
  });

  it("a chained `pnpm --filter` command whose package or script is gone (pnpm exits 0 when a filter matches nothing)", async () => {
    const { packageJson } = await readRealTexts();
    const { manifests } = await readRealWorkspace();
    // ops-cli renamed: its script is unchained under the new name, and the chain's command selects nothing.
    const renamed = withManifest(manifests, "apps/ops-cli", (manifest) => {
      manifest.name = "@polymarket-bot/emergency-cli";
    });
    expect(integrationScriptFindings(packageJson, renamed)).toEqual([
      expect.stringContaining(unchained("apps/ops-cli", "@polymarket-bot/emergency-cli", "test:integration")),
      `the root \`test:integration\` command ${JSON.stringify(OPS_CLI_COMMAND)} names @polymarket-bot/ops-cli, which is no ` +
        "workspace package; pnpm exits 0 when a filter matches nothing, so its step would pass having run nothing",
    ]);
    // The script removed from the package.
    const removed = withManifest(manifests, "apps/ops-cli", (manifest) => {
      delete manifest.scripts?.["test:integration"];
    });
    expect(integrationScriptFindings(packageJson, removed)).toEqual([
      `the root \`test:integration\` command ${JSON.stringify(OPS_CLI_COMMAND)} runs \`test:integration\`, which ` +
        "apps/ops-cli/package.json does not define",
    ]);
    // The same check holds for the other split chains' package commands.
    const noInventory = manifests.filter(({ dir }) => dir !== "packages/inventory");
    expect(noInventory).toHaveLength(manifests.length - 1);
    expect(integrationScriptFindings(packageJson, noInventory)).toEqual([
      expect.stringContaining('the root `test:contract` command "pnpm --filter @polymarket-bot/inventory test:contract" names'),
    ]);
    const noWalFault = withManifest(manifests, "packages/storage-wal", (manifest) => {
      delete manifest.scripts?.["test:fault"];
    });
    expect(integrationScriptFindings(packageJson, noWalFault)).toEqual([
      expect.stringContaining('the root `test:fault` command "pnpm --filter @polymarket-bot/storage-wal test:fault" runs `test:fault`'),
    ]);
  });

  it("reads the workspace globs it claims, and refuses a workspace file or a manifest it cannot read", async () => {
    expect(
      workspacePackageGlobs(
        ["# a comment", "packages:", "  # a comment between items", '  - "apps/*"', "", "  - 'packages/*' # trailing", "  - packages/strategies/*", "other: x", ""].join("\n"),
      ),
    ).toEqual(["apps/*", "packages/*", "packages/strategies/*"]);
    const refused: readonly (readonly [string, string])[] = [
      ["an exclusion", 'packages:\n  - "apps/*"\n  - "!apps/legacy"\n'],
      ["a recursive glob", 'packages:\n  - "apps/**"\n'],
      ["a brace glob", 'packages:\n  - "apps/{a,b}"\n'],
      ["a bare directory", "packages:\n  - apps\n"],
      ["a flow sequence", "packages: [apps/*]\n"],
      ["an indentless sequence", "packages:\n- apps/*\n"],
      ["a deeper indentation", "packages:\n    - apps/*\n"],
      ["no packages key", "allowBuilds:\n  esbuild: true\n"],
      ["two packages keys", "packages:\n  - apps/*\npackages:\n  - packages/*\n"],
      ["a duplicate glob", "packages:\n  - apps/*\n  - apps/*\n"],
      ["an empty list", "packages:\nallowBuilds:\n  esbuild: true\n"],
      ["a CR line end", "packages:\r\n  - apps/*\r\n"],
    ];
    for (const [what, text] of refused) {
      expect(() => workspacePackageGlobs(text), what).toThrow(/^pnpm-workspace\.yaml: /u);
    }
    const { packageJson } = await readRealTexts();
    const { manifests } = await readRealWorkspace();
    const nameless = withManifest(manifests, "apps/ops-cli", (manifest) => {
      delete manifest.name;
    });
    expect(() => integrationScriptFindings(packageJson, nameless)).toThrow(/apps\/ops-cli\/package\.json: no `name`/u);
    const twin = newManifest("apps/ops-cli-copy", "@polymarket-bot/ops-cli", {});
    expect(() => integrationScriptFindings(packageJson, [...manifests, twin])).toThrow(/are both named @polymarket-bot\/ops-cli/u);
    const badScript = { dir: "apps/bad-app", text: JSON.stringify({ name: "@polymarket-bot/bad-app", scripts: { "test:integration": 1 } }) };
    expect(() => integrationScriptFindings(packageJson, [...manifests, badScript])).toThrow(/script `test:integration` is not a string/u);
  });

  // CI-7 r1 (CI7-R1-01): r0 listed each glob's directory and skipped every entry
  // that was not itself a directory, so a package reached through a directory
  // symlink was silently left out, although pnpm admits it and `pnpm --filter`
  // runs its scripts. These fixtures are temporary workspaces on a real
  // filesystem, admitting `apps/*`, with real symlinks.
  const fixtureRoots: string[] = [];
  afterAll(async () => {
    await Promise.all(fixtureRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  /** Writes a `package.json` named `name` with these scripts into `<root>/<dir>`. */
  async function writePackage(root: string, dir: string, name: string, scripts: Readonly<Record<string, string>>): Promise<void> {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, "package.json"), `${JSON.stringify({ name, private: true, scripts }, null, 2)}\n`);
  }

  /** A temporary workspace admitting `apps/*`, holding the ordinary package `apps/real-app`; `build` adds the rest. */
  async function fixtureWorkspace(build: (root: string) => Promise<void>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "ci7-workspace-"));
    fixtureRoots.push(root);
    await writeFile(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
    await writePackage(root, "apps/real-app", "@fx/real-app", { "test:integration": "exit 17" });
    await build(root);
    return root;
  }

  /** A root `package.json` whose `test:integration` chain runs `commands`, and whose other split chains run no package script. */
  function fixtureRootPackageJson(commands: readonly string[]): string {
    const scripts = {
      typecheck: "tsc -b",
      "test:contract": "vitest run --project contract",
      "test:integration": commands.join(" && "),
      "test:fault": "vitest run --project fault",
    };
    return `${JSON.stringify({ name: "fixture-root", private: true, scripts }, null, 2)}\n`;
  }

  it("CI7-R1-01: discovery follows a directory symlink and a symlinked manifest, as pnpm 11.17.0 does, and the rule reports their unchained scripts", async () => {
    const root = await fixtureWorkspace(async (root) => {
      // The review's mutant: a package reached through a directory symlink.
      await writePackage(root, "elsewhere/linked-pkg", "@fx/linked", { "test:integration": "exit 17" });
      await symlink(path.join("..", "elsewhere", "linked-pkg"), path.join(root, "apps", "linked"), "dir");
      // A package whose manifest is a symlink.
      await writePackage(root, "elsewhere/manifest-src", "@fx/manifest-link", { "test:integration": "exit 17" });
      await mkdir(path.join(root, "apps", "manifest-link"));
      await symlink(
        path.join("..", "..", "elsewhere", "manifest-src", "package.json"),
        path.join(root, "apps", "manifest-link", "package.json"),
        "file",
      );
      // pnpm 11's workspace reader ignores only node_modules and bower_components, so a `test` directory is a package.
      await writePackage(root, "apps/test", "@fx/test-dir", {});
      // Not packages, for pnpm or for the reader: a file, a symlink to it, and two directories without a manifest.
      await writeFile(path.join(root, "apps", "README.md"), "not a package\n");
      await symlink("README.md", path.join(root, "apps", "file-link"), "file");
      await mkdir(path.join(root, "apps", "empty"));
      await mkdir(path.join(root, "apps", ".cache"));
    });
    const { globs, manifests } = await readWorkspaceManifests(root);
    expect(globs).toEqual(["apps/*"]);
    // The four packages `pnpm ls -r --depth -1` lists for this layout besides the root, measured with pnpm 11.17.0 (CI-7 r1 handoff).
    expect(manifests.map(({ dir }) => dir)).toEqual(["apps/linked", "apps/manifest-link", "apps/real-app", "apps/test"]);
    const packageJson = fixtureRootPackageJson(["pnpm --filter @fx/real-app test:integration"]);
    expect(integrationScriptFindings(packageJson, manifests)).toEqual([
      expect.stringContaining(unchained("apps/linked", "@fx/linked", "test:integration")),
      expect.stringContaining(unchained("apps/manifest-link", "@fx/manifest-link", "test:integration")),
    ]);
    // Chained, both are workspace packages to the existence check as well: nothing to report.
    const chained = fixtureRootPackageJson([
      "pnpm --filter @fx/real-app test:integration",
      "pnpm --filter @fx/linked test:integration",
      "pnpm --filter @fx/manifest-link test:integration",
    ]);
    expect(integrationScriptFindings(chained, manifests)).toEqual([]);
  });

  /** One entry the reader must refuse, the fixture that adds it, and the refusal. */
  const REFUSED_ENTRIES: readonly (readonly [string, (root: string) => Promise<void>, RegExp])[] = [
    [
      "a package.yaml manifest, which pnpm admits",
      async (root) => {
        await mkdir(path.join(root, "apps", "yaml-app"));
        await writeFile(path.join(root, "apps", "yaml-app", "package.yaml"), 'name: "@fx/yaml-app"\n');
      },
      /^apps\/yaml-app holds package\.yaml\. pnpm 11 admits a package\.yaml or package\.json5 manifest/u,
    ],
    [
      "a package.json5 manifest, which pnpm admits",
      async (root) => {
        await mkdir(path.join(root, "apps", "json5-app"));
        await writeFile(path.join(root, "apps", "json5-app", "package.json5"), '{ name: "@fx/json5-app" }\n');
      },
      /^apps\/json5-app holds package\.json5\. pnpm 11 admits/u,
    ],
    [
      "a package.json beside a package.yaml",
      async (root) => {
        await writePackage(root, "apps/both", "@fx/both", { "test:integration": "exit 17" });
        await writeFile(path.join(root, "apps", "both", "package.yaml"), 'name: "@fx/both"\n');
      },
      /^apps\/both holds package\.json and package\.yaml\. pnpm 11 admits/u,
    ],
    [
      "a broken directory symlink, whose target may exist elsewhere",
      async (root) => {
        await symlink(path.join("..", "nowhere"), path.join(root, "apps", "broken-link"), "dir");
      },
      /^apps\/broken-link does not resolve \(ENOENT\)\. A broken symlink may resolve on another machine/u,
    ],
    [
      "a hidden directory holding a manifest",
      async (root) => {
        await writePackage(root, "apps/.hidden-app", "@fx/hidden", { "test:integration": "exit 17" });
      },
      /^apps\/\.hidden-app holds package\.json, but pnpm 11 admits no hidden, node_modules or bower_components directory/u,
    ],
    [
      "a node_modules directory holding a manifest",
      async (root) => {
        await writePackage(root, "apps/node_modules", "@fx/nm", { "test:integration": "exit 17" });
      },
      /^apps\/node_modules holds package\.json, but pnpm 11 admits no hidden/u,
    ],
    [
      "a bower_components directory holding a manifest",
      async (root) => {
        await writePackage(root, "apps/bower_components", "@fx/bower", { "test:integration": "exit 17" });
      },
      /^apps\/bower_components holds package\.json, but pnpm 11 admits no hidden/u,
    ],
  ];

  it.each(REFUSED_ENTRIES)("CI7-R1-01: discovery refuses, rather than skips or admits, %s", async (_what, add, refusal) => {
    const root = await fixtureWorkspace(add);
    await expect(readWorkspaceManifests(root)).rejects.toThrow(refusal);
  });

  it("CI7-R1-01: the pnpm parity was measured with pnpm 11.17.0, the version the root package.json pins", async () => {
    const { packageJson } = await readRealTexts();
    const { packageManager } = JSON.parse(packageJson) as { readonly packageManager?: unknown };
    expect(
      packageManager,
      "readWorkspaceManifests mirrors pnpm 11.17.0's workspace discovery; on a pnpm change, re-measure it (the CI-7 r1 handoff's probe) and update this pin",
    ).toBe("pnpm@11.17.0");
  });
});
