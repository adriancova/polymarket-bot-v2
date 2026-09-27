/**
 * CI-2 (`CI1-L5`) — `.github/workflows/ci.yml` runs every command of the root
 * `package.json`'s `&&` chains (`typecheck`, `test:contract`,
 * `test:integration`) as its own gated step, and this pin fails when the two
 * drift apart.
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
 * - a gate after the install step without
 *   `if: ${{ !cancelled() && steps.install.outcome == 'success' }}`, or with a
 *   key a gate may not have (`continue-on-error`, `env`, …);
 * - a job without a `timeout-minutes` below GitHub's 360-minute default.
 *
 * HOW. `ci-workflow.ts` reads the workflow with a conservative YAML-subset
 * reader, because no YAML library is declared and `package.json` and the
 * lockfile are protected. It throws on anything outside that subset, rather
 * than guessing. The drift check is a pure function of the two texts, so every
 * mutant below, including a `package.json` whose chain gains a command, is an
 * in-memory copy; no tracked file is touched. The one normalization, a bare
 * binary such as `tsc` run as `pnpm exec tsc`, is explained in `ci-workflow.ts`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GATE_IF,
  SPLIT_CHAINS,
  chainCommands,
  jobTimeoutFindings,
  nodeJobSteps,
  parseWorkflowYaml,
  splitStepDrift,
  stepRunFor,
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

  it("non-vacuity: 4 + 4 + 6 chained commands, each run by exactly one gated step, in chain order", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const chains = chainCommands(packageJson);
    expect(SPLIT_CHAINS.map(({ script }) => chains.get(script)?.length)).toEqual([4, 4, 6]);
    const gateSteps = gates(workflow);
    expect(gateSteps).toHaveLength(22);
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
    expect(splitSteps(workflow, packageJson)).toHaveLength(14);
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
      gatedStep("Integration tests 7/7 - ops-cli (no container)", "pnpm --filter @polymarket-bot/ops-cli test:integration"),
      gatedStep("Another suite", "pnpm --filter @polymarket-bot/ops-cli test:contract"),
      gatedStep("Typecheck", "pnpm typecheck"),
      gatedStep("Integration tests", "pnpm test:integration"),
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
      // A different package with the same script.
      [splitStep(workflow, packageJson, "test:integration", 4), "pnpm --filter @polymarket-bot/ops-cli test:integration"],
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
  });

  it("a copy of package.json whose chain gains a command — each of the three chains", async () => {
    const { workflow, packageJson } = await readRealTexts();
    const gained: readonly (readonly [string, string])[] = [
      ["typecheck", "tsc -p test/extra/tsconfig.json --noEmit"],
      ["test:contract", "pnpm --filter @polymarket-bot/ops-cli test:contract"],
      ["test:integration", "pnpm --filter @polymarket-bot/ops-cli test:integration"],
    ];
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
