/**
 * CI-2 (`CI1-L5`) — the reader and the drift check behind
 * `ci-step-split.test.ts`.
 *
 * WHY. `GATE1-R4` holds per STEP: a failing gate no longer hides the gates
 * after it. But `typecheck`, `test:contract` and `test:integration` are `&&`
 * chains in the root `package.json`. When one ran as a single step, the
 * chain's first failure hid the rest of that step. So `ci.yml` now runs every
 * chained command as its own gated step. The commands still live in the
 * PROTECTED `package.json`, so the two copies can drift apart. The drift check
 * here fails when they do.
 *
 * THE READER. No YAML library is declared, and `package.json` and the lockfile
 * are protected, so this module reads the workflow itself. It accepts a
 * conservative subset of YAML block syntax, the one `ci.yml` uses, and THROWS
 * on anything else rather than guess:
 * - block mappings with plain keys;
 * - block sequences, including `- key: value` items;
 * - plain scalars without `: ` or ` #` inside;
 * - double- or single-quoted scalars without escapes;
 * - `|` literal blocks;
 * - one-line flow sequences of plain words (`[main]`);
 * - full-line and trailing comments.
 * Scalars stay strings (`timeout-minutes: 30` reads as "30"), and an empty
 * value reads as `null`. Anchors, aliases, tags, flow mappings, folded or
 * chomped blocks, tabs, CR line ends, document markers, duplicate keys and
 * indentless sequences are all refused.
 *
 * THE DRIFT CHECK. `splitStepDrift` reports, as readable findings:
 * - a chained command that no step runs, or that more than one step runs;
 * - split steps out of the chain's order, or named for the wrong position;
 * - a step that looks like a split step but runs no chained command;
 * - a gate after the install step without the gating `if:`, or with a key the
 *   check does not expect (for example `continue-on-error`).
 *
 * THE ONE NORMALIZATION. A step must run each chained command exactly as the
 * chain spells it, with one exception. A command that does not start with
 * `pnpm` is a bare binary (`tsc …`). In a package script it resolves through
 * the `node_modules/.bin` that `pnpm run` puts on PATH. A workflow step's
 * shell has no such PATH, so the step must run it as `pnpm exec <command>`.
 * Nothing else is normalized: no whitespace folding, no `pnpm run x` for
 * `pnpm x`. A chain command with any shell syntax beyond single spaces
 * between words is refused, because splitting on ` && ` would no longer be
 * faithful.
 */

/** A value of the YAML subset: a string, `null` for an empty value, a sequence or a mapping. */
export type YamlValue = string | null | readonly YamlValue[] | ReadonlyMap<string, YamlValue>;

interface SourceLine {
  readonly no: number;
  readonly indent: number;
  /** The line after its indentation. */
  readonly text: string;
  readonly raw: string;
}

/** A mapping key the reader accepts: a plain word, as every key in `ci.yml` is. */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:$| (.*)$)/u;

/** First characters that make a YAML scalar something other than a plain one. */
const INDICATOR_START = /^[[\]{}&*!|>%@`?,'"#]/u;

/** One element of a flow sequence the reader accepts. */
const FLOW_WORD = /^[A-Za-z0-9_./-]+$/u;

function refuse(line: SourceLine | undefined, why: string): never {
  const where = line === undefined ? "end of file" : `line ${line.no}: ${JSON.stringify(line.raw)}`;
  throw new Error(
    `workflow reader: ${why} (${where}). It reads only the YAML subset ci.yml uses and refuses anything else; ` +
      "extend test/unit/tooling/ci-workflow.ts deliberately if the workflow needs more.",
  );
}

/**
 * Parses `source` as the YAML subset described above, or throws.
 */
export function parseWorkflowYaml(source: string): YamlValue {
  if (source.includes("\r")) throw new Error("workflow reader: CR line ends are refused");
  if (source.includes("\t")) throw new Error("workflow reader: tab characters are refused");
  const lines: SourceLine[] = source.split("\n").map((raw, index) => {
    const indent = /^ */u.exec(raw)?.[0].length ?? 0;
    return { no: index + 1, indent, text: raw.slice(indent), raw };
  });
  let position = 0;

  const insignificant = (line: SourceLine): boolean => line.text === "" || line.text.startsWith("#");

  const peek = (): SourceLine | undefined => {
    while (position < lines.length) {
      const line = lines[position];
      if (line === undefined || !insignificant(line)) break;
      position += 1;
    }
    return lines[position];
  };

  const isSequenceItem = (text: string): boolean => text === "-" || text.startsWith("- ");

  for (const line of lines) {
    if (line.text !== line.text.trimStart()) refuse(line, "whitespace other than spaces before the content");
    if (line.indent === 0 && /^(?:---|\.\.\.|%)/u.test(line.text)) refuse(line, "a document marker or directive");
  }

  function parseScalar(text: string, line: SourceLine): YamlValue {
    const first = text[0];
    if (first === '"' || first === "'") {
      const end = text.indexOf(first, 1);
      if (end < 0) refuse(line, "an unterminated quoted scalar");
      const inner = text.slice(1, end);
      if (first === '"' && inner.includes("\\")) refuse(line, "an escape sequence in a quoted scalar");
      const after = text.slice(end + 1);
      if (after !== "" && !/^ +#/u.test(after)) refuse(line, "text after a quoted scalar");
      return inner;
    }
    if (first === "[") {
      const match = /^\[([^[\]{}"'#]*)\](?: +#.*)?$/u.exec(text);
      if (match === null) refuse(line, "a flow sequence other than one line of plain words");
      const words = (match[1] ?? "").split(",").map((word) => word.trim());
      if (words.some((word) => !FLOW_WORD.test(word))) refuse(line, "a flow sequence element that is not a plain word");
      return words;
    }
    if (INDICATOR_START.test(text) || isSequenceItem(text)) refuse(line, "a YAML indicator the reader does not handle");
    const comment = text.indexOf(" #");
    const value = (comment < 0 ? text : text.slice(0, comment)).trimEnd();
    if (value.includes(": ") || value.endsWith(":")) refuse(line, "`: ` inside a plain scalar");
    if (value === "") refuse(line, "an empty plain scalar");
    return value;
  }

  function parseLiteralBlock(parentIndent: number, header: SourceLine): string {
    const content: string[] = [];
    let blockIndent: number | undefined;
    while (position < lines.length) {
      const line = lines[position];
      if (line === undefined) break;
      if (line.text === "") {
        content.push("");
        position += 1;
        continue;
      }
      if (line.indent <= parentIndent) break;
      blockIndent ??= line.indent;
      if (line.indent < blockIndent) refuse(line, "a literal block line indented less than the block's first line");
      content.push(line.raw.slice(blockIndent));
      position += 1;
    }
    if (blockIndent === undefined) refuse(header, "an empty literal block");
    // `|` clips: exactly one line break at the end, whatever blank lines follow.
    while (content.length > 0 && content[content.length - 1] === "") content.pop();
    return `${content.join("\n")}\n`;
  }

  function parseNode(indent: number): YamlValue {
    const line = peek();
    if (line === undefined) return refuse(line, "a missing value");
    return isSequenceItem(line.text) ? parseSequence(indent) : parseMapping(indent);
  }

  function parseMapping(indent: number): ReadonlyMap<string, YamlValue> {
    const mapping = new Map<string, YamlValue>();
    for (let line = peek(); line !== undefined && line.indent >= indent; line = peek()) {
      if (line.indent > indent) refuse(line, "unexpected indentation");
      if (isSequenceItem(line.text)) refuse(line, "a sequence item where a mapping key was expected");
      const match = KEY_LINE.exec(line.text);
      if (match === null) refuse(line, "a line that is not `key: value` or `key:`");
      const key = match[1] ?? "";
      if (mapping.has(key)) refuse(line, `the duplicate key \`${key}\``);
      position += 1;
      const rest = (match[2] ?? "").trimStart();
      if (rest === "" || rest.startsWith("#")) {
        const next = peek();
        mapping.set(key, next !== undefined && next.indent > indent ? parseNode(next.indent) : null);
      } else if (rest === "|" || /^\| +#/u.test(rest)) {
        mapping.set(key, parseLiteralBlock(indent, line));
      } else {
        mapping.set(key, parseScalar(rest, line));
      }
    }
    return mapping;
  }

  function parseSequence(indent: number): readonly YamlValue[] {
    const items: YamlValue[] = [];
    for (let line = peek(); line !== undefined && line.indent >= indent; line = peek()) {
      if (line.indent > indent) refuse(line, "unexpected indentation");
      if (!isSequenceItem(line.text)) refuse(line, "a mapping key where a sequence item was expected");
      if (line.text === "-") {
        position += 1;
        const next = peek();
        if (next === undefined || next.indent <= indent) refuse(line, "an empty sequence item");
        items.push(parseNode(next.indent));
        continue;
      }
      const rest = line.text.slice(2);
      if (rest.startsWith(" ")) refuse(line, "more than one space after `-`");
      if (KEY_LINE.test(rest)) {
        // `- key: value`: a mapping whose first key sits two columns right of
        // the dash; its other keys must line up with it.
        lines[position] = { ...line, indent: indent + 2, text: rest };
        items.push(parseMapping(indent + 2));
      } else {
        position += 1;
        items.push(parseScalar(rest, line));
      }
    }
    return items;
  }

  const first = peek();
  if (first === undefined) refuse(first, "an empty document");
  if (first.indent !== 0) refuse(first, "a document that does not start at column 0");
  const root = parseNode(0);
  const trailing = peek();
  if (trailing !== undefined) refuse(trailing, "content after the document's root node");
  return root;
}

function isMapping(value: YamlValue | undefined): value is ReadonlyMap<string, YamlValue> {
  return value instanceof Map;
}

function mappingAt(value: YamlValue | undefined, where: string): ReadonlyMap<string, YamlValue> {
  if (!isMapping(value)) throw new Error(`workflow shape: ${where} is not a mapping`);
  return value;
}

function sequenceAt(value: YamlValue | undefined, where: string): readonly YamlValue[] {
  if (!Array.isArray(value)) throw new Error(`workflow shape: ${where} is not a sequence`);
  return value as readonly YamlValue[];
}

function stringAt(mapping: ReadonlyMap<string, YamlValue>, key: string, where: string): string | undefined {
  const value = mapping.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`workflow shape: ${where}.${key} is not a string`);
  return value;
}

/** The `if:` every gate after the install step carries (`CI-1`, GATE1-R4). */
export const GATE_IF = "${{ !cancelled() && steps.install.outcome == 'success' }}";

/** The root scripts that are `&&` chains, and the label their split steps' names begin with. */
export const SPLIT_CHAINS = [
  { script: "typecheck", label: "Typecheck" },
  { script: "test:contract", label: "Venue contract tests" },
  { script: "test:integration", label: "Integration tests" },
] as const;

/**
 * A chained command the check can map to one step: words of safe characters
 * separated by single spaces. Quotes, `$`, `;`, `|`, `&`, redirections, globs
 * and parentheses are all outside it.
 */
const PLAIN_COMMAND = /^[A-Za-z0-9@%+=:,./_-]+(?: [A-Za-z0-9@%+=:,./_-]+)*$/u;

/**
 * Every chain's commands, in order, read from `package.json` text. Throws when a
 * chain is missing or is anything but plain commands joined by ` && `.
 */
export function chainCommands(packageJsonText: string): ReadonlyMap<string, readonly string[]> {
  const parsed: unknown = JSON.parse(packageJsonText);
  const scripts =
    typeof parsed === "object" && parsed !== null ? (parsed as { readonly scripts?: unknown }).scripts : undefined;
  if (typeof scripts !== "object" || scripts === null) throw new Error("package.json: no `scripts` object");
  const chains = new Map<string, readonly string[]>();
  const seen = new Map<string, string>();
  for (const { script } of SPLIT_CHAINS) {
    const text: unknown = (scripts as Readonly<Record<string, unknown>>)[script];
    if (typeof text !== "string") throw new Error(`package.json: script \`${script}\` is missing or not a string`);
    const commands = text.split(" && ");
    for (const command of commands) {
      if (!PLAIN_COMMAND.test(command)) {
        throw new Error(
          `package.json: script \`${script}\` holds ${JSON.stringify(command)}, which is not a plain command; ` +
            "the drift check maps only plain commands joined by ` && ` to workflow steps",
        );
      }
      const owner = seen.get(command);
      if (owner !== undefined) {
        throw new Error(
          `package.json: ${JSON.stringify(command)} appears twice (in \`${owner}\` and \`${script}\`); ` +
            "the drift check cannot map one command to two steps",
        );
      }
      seen.set(command, script);
    }
    chains.set(script, commands);
  }
  return chains;
}

/** What a workflow step must run for `command`: see THE ONE NORMALIZATION above. */
export function stepRunFor(command: string): string {
  return command.startsWith("pnpm ") ? command : `pnpm exec ${command}`;
}

/** Words that mark a step as running one of the chains, split or not. */
const CHAIN_WORD = /\b(?:typecheck|tsc|test:contract|test:integration)\b/u;

/** The keys a gate step may have. Anything else is reported. */
const GATE_KEYS = new Set(["name", "if", "run"]);

interface NodeStep {
  readonly index: number;
  readonly label: string;
  readonly keys: readonly string[];
  readonly name: string | undefined;
  readonly id: string | undefined;
  readonly condition: string | undefined;
  readonly run: string | undefined;
}

/** The `node` job's steps, read from workflow text. Throws on an unexpected shape. */
export function nodeJobSteps(workflowText: string): readonly NodeStep[] {
  const root = mappingAt(parseWorkflowYaml(workflowText), "the document");
  const jobs = mappingAt(root.get("jobs"), "jobs");
  const node = mappingAt(jobs.get("node"), "jobs.node");
  return sequenceAt(node.get("steps"), "jobs.node.steps").map((value, index) => {
    const where = `jobs.node.steps[${index}]`;
    const step = mappingAt(value, where);
    const name = stringAt(step, "name", where);
    const run = stringAt(step, "run", where);
    const uses = stringAt(step, "uses", where);
    return {
      index,
      label: `step ${index + 1} "${name ?? uses ?? run ?? "?"}"`,
      keys: [...step.keys()],
      name,
      id: stringAt(step, "id", where),
      condition: stringAt(step, "if", where),
      run,
    };
  });
}

/**
 * Every way the `node` job's steps and the root `package.json` chains have
 * drifted apart. An empty list means they agree. Throws, rather than
 * reporting, when either text is outside what the check can read.
 */
export function splitStepDrift(workflowText: string, packageJsonText: string): string[] {
  const chains = chainCommands(packageJsonText);
  const steps = nodeJobSteps(workflowText);
  const findings: string[] = [];

  const installs = steps.filter((step) => step.id === "install");
  if (installs.length !== 1) {
    findings.push(`the node job has ${installs.length} steps with \`id: install\`; the gates' \`if:\` needs exactly one`);
    return findings;
  }
  const gates = steps.slice((installs[0]?.index ?? 0) + 1);

  for (const gate of gates) {
    if (gate.condition !== GATE_IF) {
      findings.push(
        `${gate.label} runs after install without the gate condition: its \`if:\` is ` +
          `${gate.condition === undefined ? "missing" : JSON.stringify(gate.condition)}, not ${JSON.stringify(GATE_IF)}`,
      );
    }
    for (const key of gate.keys) {
      if (!GATE_KEYS.has(key)) findings.push(`${gate.label} has the key \`${key}\`, which a gate step may not have`);
    }
    if (gate.name === undefined || gate.run === undefined) findings.push(`${gate.label} needs both a \`name\` and a \`run\``);
  }

  const chainRuns = new Set<string>();
  for (const { script, label } of SPLIT_CHAINS) {
    const commands = chains.get(script) ?? [];
    let previous: NodeStep | undefined;
    commands.forEach((command, position) => {
      const run = stepRunFor(command);
      chainRuns.add(run);
      const where = `\`${script}\` command ${position + 1}/${commands.length} ${JSON.stringify(command)}`;
      const matches = gates.filter((gate) => gate.run === run);
      if (matches.length !== 1) {
        findings.push(
          matches.length === 0
            ? `${where} has no gate step; expected one that runs ${JSON.stringify(run)}`
            : `${where} runs in ${matches.length} gate steps (${matches.map((step) => step.label).join(", ")}); expected one`,
        );
        return;
      }
      const step = matches[0];
      if (step === undefined) return;
      const prefix = `${label} ${position + 1}/${commands.length} - `;
      if (!(step.name ?? "").startsWith(prefix)) {
        findings.push(`${step.label} runs ${where}, so its name must begin with ${JSON.stringify(prefix)}`);
      }
      if (previous !== undefined && step.index < previous.index) {
        findings.push(`${step.label} runs ${where} but comes before ${previous.label}, which runs the command before it`);
      }
      previous = step;
    });
  }

  for (const gate of gates) {
    if (gate.run !== undefined && chainRuns.has(gate.run)) continue;
    const byName = SPLIT_CHAINS.some(({ label }) => (gate.name ?? "").startsWith(label));
    const byRun = gate.run !== undefined && CHAIN_WORD.test(gate.run);
    if (byName || byRun) {
      findings.push(
        `${gate.label} looks like a split step (${byName ? "its name" : "its command"}) but runs no command of ` +
          `the ${SPLIT_CHAINS.map(({ script }) => `\`${script}\``).join(", ")} chains in package.json: ` +
          JSON.stringify(gate.run ?? null),
      );
    }
  }
  return findings;
}

/**
 * GitHub's default job timeout, in minutes, which is also the longest a job on
 * a GitHub-hosted runner may run. A `timeout-minutes` this high bounds nothing.
 */
const GITHUB_JOB_TIMEOUT_CEILING_MINUTES = 360;

/** Every job of the workflow that lacks a whole-minute `timeout-minutes` below GitHub's default. */
export function jobTimeoutFindings(workflowText: string): string[] {
  const root = mappingAt(parseWorkflowYaml(workflowText), "the document");
  const jobs = mappingAt(root.get("jobs"), "jobs");
  const findings: string[] = [];
  for (const [id, value] of jobs) {
    const job = mappingAt(value, `jobs.${id}`);
    const timeout = stringAt(job, "timeout-minutes", `jobs.${id}`);
    if (timeout === undefined) {
      findings.push(`job \`${id}\` sets no \`timeout-minutes\`, so a hang runs to GitHub's 360-minute default`);
    } else if (!/^[1-9][0-9]*$/u.test(timeout) || Number(timeout) >= GITHUB_JOB_TIMEOUT_CEILING_MINUTES) {
      findings.push(`job \`${id}\` has \`timeout-minutes: ${timeout}\`; expected a whole number of minutes below 360`);
    }
  }
  return findings;
}
