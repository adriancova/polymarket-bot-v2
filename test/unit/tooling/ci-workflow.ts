/**
 * CI-2 (`CI1-L5`) — the reader and the drift check behind
 * `ci-step-split.test.ts`.
 *
 * WHY. `GATE1-R4` holds per STEP: a failing gate no longer hides the gates
 * after it. But `typecheck`, `test:contract` and `test:integration` are `&&`
 * chains in the root `package.json`, and since `CI-5` so is `test:fault`
 * (the WAL, OMS and reconciliation fault suites, and since `CI-6` the
 * live-safety and live chaos suites). When one ran as a single
 * step, the chain's first failure hid the rest of that step. So `ci.yml` now
 * runs every chained command as its own gated step. The commands still live
 * in the PROTECTED `package.json`, so the two copies can drift apart. The
 * drift check here fails when they do.
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
 * - in each gated job (`GATED_JOBS`: `node` after its `id: install` step,
 *   `python` after its `id: sync` step), a gate without that job's gating
 *   `if:`, or with a key the check does not expect (for example
 *   `continue-on-error`);
 * - a gate that runs an `&&` chain as ONE step, other than through the split
 *   steps (`CI-2` r1, L5-1). Either its own `run` holds `&&`, or one of its
 *   commands runs a root script that is an `&&` chain other than the split
 *   ones (`SPLIT_CHAINS`). A root script of a spelling below is followed to the script
 *   it runs;
 * - a gate that runs MORE THAN ONE command in one step (`DEPCHECK-1`,
 *   `CI2-L5-2`). GitHub runs a `run` block with `bash -e`, so its first failing
 *   command ends the step and hides the rest: the `&&` hazard without the
 *   `&&`. The commands of a `run` are its lines and its `;`-separated parts;
 *   blank lines and `#` comments are not commands, and a line ending in `\`
 *   continues on the next. A block whose commands genuinely need each other
 *   is recorded in `DEPENDENT_RUN_BLOCKS` with its exact text and the reason;
 *   today that is the python audit step, whose second line reads the file its
 *   first line writes. A recorded block that no gate runs any more is also a
 *   finding.
 *
 * WHICH SPELLINGS RUN A ROOT SCRIPT (`DEPCHECK-1`, `CI2-L5-3`). Each command is
 * split into words (single quotes, and double quotes holding no `$`, backquote
 * or backslash, are read; a word holding anything else unquoted is not). After
 * any leading `NAME=value` assignments, a command runs the root script `<s>`,
 * where `<s>` is in the root `package.json`, when it is:
 * - `pnpm [options] [run|run-script] [options] <s>` with no option that moves
 *   it off the root (`-r`, or a `-C`/`--dir`/`--filter`/`-F` naming anything
 *   else), or with one that moves it onto the root: `-C`/`--dir` naming `.`
 *   (`-C .`, `--dir ./`, `--dir=.`), `-w`/`--workspace-root`,
 *   `--include-workspace-root`, or a `--filter`/`-F` selector that names the
 *   root package (`polymarket-bot`, also with a `...` prefix or suffix) or the
 *   directory `.` (`.`, `./`, `{.}`). An option that is none of these is taken
 *   to be a flag without a value, and `<s>` is the first later word that names
 *   a root script, so a word misread on the way can only over-report;
 * - `npm [options] run|run-script [options] <s>`, or `npm [options] test|t|start`
 *   for the scripts `test` and `start`, where no `-w`/`--workspace`/
 *   `--workspaces` moves it off the root and a `--prefix` names `.`. As for
 *   pnpm, any other option is taken for a flag, and any other word before
 *   `run` is passed over.
 * A root script's own text is followed through its first command only.
 *
 * NOT CHECKED by the one-step-chain rule, on purpose:
 * - `||`, `|` and `&` inside a `run` or a script: none of them is the
 *   fail-fast hazard (`||` and `&` hide a failure instead, a different
 *   defect), and `;` inside a root SCRIPT, which `sh` runs without `-e`;
 * - chains inside workspace packages' own scripts, which a `pnpm -r`,
 *   `--filter <package>` or `--dir <package>` step runs (every package's
 *   `typecheck` is a `tsc … && tsc …` chain today). Those manifests are
 *   outside this check;
 * - a root script reached through a wrapper or another launcher: `npx`,
 *   `corepack`, `env`, `bash -c`, `timeout`, `yarn`, `bun`, a `cd`, a subshell
 *   or brace group, a shell variable or substitution, or a `--filter` selector
 *   with `^`, `!` or a glob (`pnpm exec pnpm <s>` IS followed, since `<s>` is
 *   the first word that names a root script);
 * - root scripts that no gate runs (`test:compose`, `ops:validate-dataset`),
 *   and the compose job's `run` block, which is no gate: that job has a single
 *   step and is not in `GATED_JOBS`.
 * A `pnpm <name>` step is taken to run the root script `<name>` whenever one
 * exists, even where pnpm runs its own built-in command of that name (`pnpm
 * audit`). That can only over-report, never hide a chain.
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
 *
 * THE INTEGRATION-SCRIPT RULE (`CI-7`, CLOSEOUT-3 L1). The split check above
 * holds the steps to the chains, but nothing held the chains to the packages:
 * WP-330's `ops-cli` `test:integration` ran in no gate from its merge
 * (`c1e6909`) until CLOSEOUT-3 found it.
 * `integrationScriptFindings` reports:
 * - a workspace package's `test:integration` script, or `test:integration:<x>`
 *   one, that the root `test:integration` chain does not run as
 *   `pnpm --filter <package name> <script>` and that `UNCHAINED_INTEGRATION_SCRIPTS`
 *   does not exempt with a reason. Only that spelling counts as chained, so a
 *   misread can only over-report;
 * - a `pnpm --filter <name> <script>` command of any split chain whose package
 *   is not in the workspace, or has no such script. pnpm 11 exits 0 when a
 *   filter matches no package ("No projects matched the filters"), so a
 *   renamed package would otherwise leave a green step that ran nothing;
 * - an exemption that no longer applies: its script is chained after all, its
 *   package or script is gone, or it gives no reason.
 * The workspace's packages are the ones `readWorkspaceManifests` finds. It reads
 * the globs from `pnpm-workspace.yaml` (`workspacePackageGlobs`), then lists each
 * glob's directory. Since `CI-7` r1 (CI7-R1-01), it admits exactly what pnpm
 * 11.17.0 admits wherever it can read the package, and THROWS wherever it cannot.
 * - A directory symlink is followed, as pnpm's glob follows it. r0 skipped one
 *   silently, so a symlinked package's suite could stay ungated.
 * - A `package.yaml` or `package.json5` manifest is refused. pnpm admits one,
 *   but the rule reads only `package.json`.
 * - An entry that does not resolve is refused, such as a broken symlink. Its
 *   target may exist on another machine, where pnpm would admit it.
 * - A hidden, `node_modules` or `bower_components` directory is refused when it
 *   holds a manifest. pnpm skips such a directory, so its package could not
 *   run; r0 admitted one of the last two, so a chained command naming it
 *   passed the existence check.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

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

/** The `if:` of a gate that runs after the setup step with this `id` (`CI-1`, GATE1-R4). */
function gateCondition(setupId: string): string {
  return `\${{ !cancelled() && steps.${setupId}.outcome == 'success' }}`;
}

/** The `if:` every gate after the node job's install step carries (`CI-1`, GATE1-R4). */
export const GATE_IF = gateCondition("install");

/**
 * The jobs whose steps after a setup step are gates (`CI-1`, GATE1-R4), and the
 * `id` of that setup step. Every such gate must carry `gateCondition(setup)`:
 * it runs even after an earlier gate failed, but never when the setup did not
 * succeed. The `compose` job has a single step and so no gates.
 */
export const GATED_JOBS = [
  { job: "node", setup: "install" },
  { job: "python", setup: "sync" },
] as const;

/**
 * The root scripts that are `&&` chains, and the label their split steps' names
 * begin with. `CI-5` added `test:fault`, when the OMS (`WP-270`) and
 * reconciliation (`WP-290`) suites joined the WAL suite in that script.
 * `CI-6` chained the live-safety (`WP-320`) and live chaos (`WP-340`) suites
 * after them, and the live chaos suite's PostgreSQL half to
 * `test:integration`. `CI-7` chained the emergency CLI's PostgreSQL suite
 * (`WP-330`) to `test:integration`.
 */
export const SPLIT_CHAINS = [
  { script: "typecheck", label: "Typecheck" },
  { script: "test:contract", label: "Venue contract tests" },
  { script: "test:integration", label: "Integration tests" },
  { script: "test:fault", label: "Fault-injection tests" },
] as const;

/**
 * A chained command the check can map to one step: words of safe characters
 * separated by single spaces. Quotes, `$`, `;`, `|`, `&`, redirections, globs
 * and parentheses are all outside it.
 */
const PLAIN_COMMAND = /^[A-Za-z0-9@%+=:,./_-]+(?: [A-Za-z0-9@%+=:,./_-]+)*$/u;

/** Every script of the root `package.json`, by name. Throws unless `scripts` is an object of strings. */
function rootScripts(packageJsonText: string): ReadonlyMap<string, string> {
  const parsed: unknown = JSON.parse(packageJsonText);
  const scripts =
    typeof parsed === "object" && parsed !== null ? (parsed as { readonly scripts?: unknown }).scripts : undefined;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("package.json: no `scripts` object");
  }
  const byName = new Map<string, string>();
  for (const [name, text] of Object.entries(scripts as Readonly<Record<string, unknown>>)) {
    if (typeof text !== "string") throw new Error(`package.json: script \`${name}\` is not a string`);
    byName.set(name, text);
  }
  return byName;
}

/**
 * Every chain's commands, in order, read from `package.json` text. Throws when a
 * chain is missing or is anything but plain commands joined by ` && `.
 */
export function chainCommands(packageJsonText: string): ReadonlyMap<string, readonly string[]> {
  const scripts = rootScripts(packageJsonText);
  const chains = new Map<string, readonly string[]>();
  const seen = new Map<string, string>();
  for (const { script } of SPLIT_CHAINS) {
    const text = scripts.get(script);
    if (text === undefined) throw new Error(`package.json: script \`${script}\` is missing or not a string`);
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

/** A word of a shell command, and whether the reader could read it (see WHICH SPELLINGS above). */
interface ShellWord {
  readonly text: string;
  readonly plain: boolean;
}

/** One command of a `run` or a script: its words, and its text for messages. */
interface ShellCommand {
  readonly words: readonly ShellWord[];
  readonly text: string;
}

/** Characters that end a word and stand as a word of their own: operators and redirections. */
const SHELL_OPERATOR = new Set(["&", "|", "<", ">", "(", ")"]);

/**
 * The commands of `source`, a `run` or a script (`DEPCHECK-1`, `CI2-L5-2`).
 * A command ends at an unquoted newline or `;`. A `#` that starts a word
 * starts a comment, a backslash before a newline joins two lines, and a
 * command with no word (a blank or comment line) is dropped. The reader does
 * not guess: a word holding an unquoted `$`, backquote or backslash, a double
 * quote around any of those, or an unterminated quote is kept but marked as
 * not plain, and no spelling is followed through it.
 */
export function shellCommands(source: string): readonly ShellCommand[] {
  const commands: ShellCommand[] = [];
  let words: ShellWord[] = [];
  let text = "";
  let plain = true;
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push({ text, plain });
    text = "";
    plain = true;
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push({ words, text: words.map((word) => word.text).join(" ") });
    words = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char === "\\" && source[index + 1] === "\n") {
      index += 1;
      continue;
    }
    if (char === "\n" || char === ";") {
      endCommand();
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (char === "#" && !inWord) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (SHELL_OPERATOR.has(char)) {
      endWord();
      words.push({ text: char, plain: false });
      continue;
    }
    inWord = true;
    if (char === "'" || char === '"') {
      const end = source.indexOf(char, index + 1);
      const inner = source.slice(index + 1, end < 0 ? source.length : end);
      if (end < 0 || (char === '"' && /[$`\\]/u.test(inner))) plain = false;
      text += inner;
      index = end < 0 ? source.length : end;
      continue;
    }
    if (char === "$" || char === "`" || char === "\\") plain = false;
    text += char;
  }
  endCommand();
  return commands;
}

/** True when a `-C`/`--dir`/`--prefix` value names the directory the command already runs in. */
function namesThisDirectory(value: string): boolean {
  return /^\.(?:\/\.?)*\/?$/u.test(value);
}

/** True when a pnpm `--filter` selector selects the root package: by name, or as the directory `.`. */
function selectsRoot(selector: string, rootName: string | undefined): boolean {
  const bare = selector.replace(/^\.\.\./u, "").replace(/\.\.\.$/u, "");
  const directory = /^\{(.*)\}$/u.exec(bare)?.[1] ?? bare;
  return (rootName !== undefined && bare === rootName) || namesThisDirectory(directory);
}

/** pnpm options that take a value in the next word (unless written `--option=value`). */
const PNPM_VALUE_OPTIONS = new Set(["-C", "--dir", "--filter", "-F"]);

/** The root script a `pnpm …` command runs, given the words after `pnpm` (see WHICH SPELLINGS). */
function pnpmRootScript(
  args: readonly ShellWord[],
  scripts: ReadonlyMap<string, string>,
  rootName: string | undefined,
): string | undefined {
  let offRoot = false;
  let ontoRoot = false;
  let sawRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined || !word.plain) return undefined;
    const equals = word.text.startsWith("--") ? word.text.indexOf("=") : -1;
    const option = equals < 0 ? word.text : word.text.slice(0, equals);
    if (PNPM_VALUE_OPTIONS.has(option)) {
      let value: string | undefined = equals < 0 ? undefined : word.text.slice(equals + 1);
      if (value === undefined) {
        const next = args[index + 1];
        if (next === undefined || !next.plain) return undefined;
        value = next.text;
        index += 1;
      }
      const toRoot = option === "-C" || option === "--dir" ? namesThisDirectory(value) : selectsRoot(value, rootName);
      if (toRoot) ontoRoot = true;
      else offRoot = true;
      continue;
    }
    if (option === "-w" || option === "--workspace-root" || option === "--include-workspace-root") {
      ontoRoot = true;
      continue;
    }
    if (option === "-r" || option === "--recursive") {
      offRoot = true;
      continue;
    }
    if (word.text.startsWith("-")) continue; // a flag without a value
    if (!sawRun && (word.text === "run" || word.text === "run-script")) {
      sawRun = true;
      continue;
    }
    if (offRoot && !ontoRoot) return undefined;
    // The first word that names a root script. A word before it that names
    // none (the value of an option taken above for a flag, or `exec` in
    // `pnpm exec pnpm lint`) is passed over rather than ending the search, so
    // a misread can only over-report.
    if (scripts.has(word.text)) return word.text;
  }
  return undefined;
}

/** npm's own names for running the `test` and `start` scripts. */
const NPM_SCRIPT_ALIASES: ReadonlyMap<string, string> = new Map([
  ["test", "test"],
  ["t", "test"],
  ["start", "start"],
]);

/** The root script an `npm …` command runs, given the words after `npm` (see WHICH SPELLINGS). */
function npmRootScript(args: readonly ShellWord[], scripts: ReadonlyMap<string, string>): string | undefined {
  let sawRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined || !word.plain) return undefined;
    const equals = word.text.startsWith("--") ? word.text.indexOf("=") : -1;
    const option = equals < 0 ? word.text : word.text.slice(0, equals);
    if (option === "-w" || option === "--workspace" || option === "-ws" || option === "--workspaces") return undefined;
    if (option === "--prefix") {
      let value: string | undefined = equals < 0 ? undefined : word.text.slice(equals + 1);
      if (value === undefined) {
        const next = args[index + 1];
        if (next === undefined || !next.plain) return undefined;
        value = next.text;
        index += 1;
      }
      if (!namesThisDirectory(value)) return undefined;
      continue;
    }
    if (word.text.startsWith("-")) continue; // a flag without a value
    if (sawRun) return scripts.has(word.text) ? word.text : undefined;
    if (word.text === "run" || word.text === "run-script") {
      sawRun = true;
      continue;
    }
    const alias = NPM_SCRIPT_ALIASES.get(word.text);
    if (alias !== undefined && scripts.has(alias)) return alias;
    // Any other word before `run` (the value of an option taken above for a
    // flag, say) is passed over, as in `pnpmRootScript`: a misread can only
    // over-report.
  }
  return undefined;
}

/** The root script `command` runs, if it is one of the spellings above for a script that exists. */
function rootScriptRun(
  command: ShellCommand | undefined,
  scripts: ReadonlyMap<string, string>,
  rootName: string | undefined,
): string | undefined {
  if (command === undefined) return undefined;
  let start = 0;
  while (start < command.words.length) {
    const word = command.words[start];
    if (word === undefined || !word.plain || !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word.text)) break;
    start += 1;
  }
  const launcher = command.words[start];
  if (launcher === undefined || !launcher.plain) return undefined;
  const args = command.words.slice(start + 1);
  if (launcher.text === "pnpm") return pnpmRootScript(args, scripts, rootName);
  if (launcher.text === "npm") return npmRootScript(args, scripts);
  return undefined;
}

/**
 * The root scripts `command` runs, the first one it names, then each script
 * the previous one runs through its first command. Stops at a script it has
 * already visited, such as `audit` (`pnpm audit --audit-level high`), which
 * names itself.
 */
function rootScriptPath(
  command: ShellCommand,
  scripts: ReadonlyMap<string, string>,
  rootName: string | undefined,
): readonly string[] {
  const visited: string[] = [];
  let name = rootScriptRun(command, scripts, rootName);
  while (name !== undefined && !visited.includes(name)) {
    visited.push(name);
    name = rootScriptRun(shellCommands(scripts.get(name) ?? "")[0], scripts, rootName);
  }
  return visited;
}

/**
 * Gate `run` blocks whose commands genuinely need one another, so running them
 * as one step is not the `&&` hazard (`DEPCHECK-1`, `CI2-L5-2`). Each entry is
 * matched on its job, its step name and its EXACT `run` text: any edit to the
 * block makes it a multi-command finding again until the entry is re-justified.
 */
export const DEPENDENT_RUN_BLOCKS = [
  {
    job: "python",
    step: "Dependency vulnerability scan (uv lockfile)",
    run:
      "uv export --frozen --no-emit-project --format requirements-txt > /tmp/requirements-audit.txt\n" +
      "uvx pip-audit --strict -r /tmp/requirements-audit.txt\n",
    why: "the second command audits the requirements file the first one writes, so neither is a gate without the other",
  },
] as const;

/** The root `package.json`'s `name`, which a `--filter` selector may name. */
function rootPackageName(packageJsonText: string): string | undefined {
  const parsed: unknown = JSON.parse(packageJsonText);
  const name = typeof parsed === "object" && parsed !== null ? (parsed as { readonly name?: unknown }).name : undefined;
  return typeof name === "string" ? name : undefined;
}

/**
 * Words that mark a step as running one of the chains, split or not. Like
 * `test:contract` in `test:contract:rtds`, `test:fault` also matches inside
 * `test:fault:reconciliation`; a step that runs a chained command is exempt
 * before this is consulted.
 */
const CHAIN_WORD = /\b(?:typecheck|tsc|test:contract|test:integration|test:fault)\b/u;

/** The keys a gate step may have. Anything else is reported. */
const GATE_KEYS = new Set(["name", "if", "run"]);

interface WorkflowStep {
  readonly index: number;
  readonly label: string;
  readonly keys: readonly string[];
  readonly name: string | undefined;
  readonly id: string | undefined;
  readonly condition: string | undefined;
  readonly run: string | undefined;
}

/** The steps of the workflow's job `job`, read from workflow text. Throws on an unexpected shape. */
export function jobSteps(workflowText: string, job: string): readonly WorkflowStep[] {
  const root = mappingAt(parseWorkflowYaml(workflowText), "the document");
  const jobs = mappingAt(root.get("jobs"), "jobs");
  const steps = mappingAt(jobs.get(job), `jobs.${job}`);
  return sequenceAt(steps.get("steps"), `jobs.${job}.steps`).map((value, index) => {
    const where = `jobs.${job}.steps[${index}]`;
    const step = mappingAt(value, where);
    const name = stringAt(step, "name", where);
    const run = stringAt(step, "run", where);
    const uses = stringAt(step, "uses", where);
    return {
      index,
      label: `jobs.${job} step ${index + 1} "${name ?? uses ?? run ?? "?"}"`,
      keys: [...step.keys()],
      name,
      id: stringAt(step, "id", where),
      condition: stringAt(step, "if", where),
      run,
    };
  });
}

/** The `node` job's steps, read from workflow text. Throws on an unexpected shape. */
export function nodeJobSteps(workflowText: string): readonly WorkflowStep[] {
  return jobSteps(workflowText, "node");
}

/**
 * The gates of one gated job, the steps after its setup step, and every way
 * they break GATE1-R4. `gates` is undefined when the setup step is not there
 * exactly once, since then no step is known to be a gate.
 */
function gateFindings(
  workflowText: string,
  job: string,
  setup: string,
): { readonly gates: readonly WorkflowStep[] | undefined; readonly findings: readonly string[] } {
  const steps = jobSteps(workflowText, job);
  const setups = steps.filter((step) => step.id === setup);
  if (setups.length !== 1) {
    return {
      gates: undefined,
      findings: [`the ${job} job has ${setups.length} steps with \`id: ${setup}\`; the gates' \`if:\` needs exactly one`],
    };
  }
  const gates = steps.slice((setups[0]?.index ?? 0) + 1);
  const condition = gateCondition(setup);
  const findings: string[] = [];
  for (const gate of gates) {
    if (gate.condition !== condition) {
      findings.push(
        `${gate.label} runs after ${setup} without the gate condition: its \`if:\` is ` +
          `${gate.condition === undefined ? "missing" : JSON.stringify(gate.condition)}, not ${JSON.stringify(condition)}`,
      );
    }
    for (const key of gate.keys) {
      if (!GATE_KEYS.has(key)) findings.push(`${gate.label} has the key \`${key}\`, which a gate step may not have`);
    }
    if (gate.name === undefined || gate.run === undefined) findings.push(`${gate.label} needs both a \`name\` and a \`run\``);
  }
  return { gates, findings };
}

/**
 * Every way `gate` runs an `&&` chain, or several commands, as one step
 * (L5-1, `CI2-L5-2`, `CI2-L5-3`; see THE DRIFT CHECK above). `dependent` is
 * true when the gate's block is recorded in `DEPENDENT_RUN_BLOCKS`.
 */
function oneStepChain(
  gate: WorkflowStep,
  scripts: ReadonlyMap<string, string>,
  rootName: string | undefined,
  dependent: boolean,
): string[] {
  const run = gate.run;
  if (run === undefined) return [];
  if (run.includes("&&")) {
    return [
      `${gate.label} chains commands with \`&&\` in its own \`run\`, so its first failure hides the rest of ` +
        `the step; give each command its own gated step: ${JSON.stringify(run)}`,
    ];
  }
  const findings: string[] = [];
  const commands = shellCommands(run);
  for (const command of commands) {
    const path = rootScriptPath(command, scripts, rootName);
    const chained = path.find((name) => (scripts.get(name) ?? "").includes("&&"));
    if (chained === undefined) continue;
    findings.push(
      `${gate.label} runs the root script ${path.map((name) => `\`${name}\``).join(" -> ")} as one step, and ` +
        `\`${chained}\` is an \`&&\` chain (${JSON.stringify(scripts.get(chained))}), so its first failure hides the ` +
        "rest; run each of its commands as its own gated step and add the script to SPLIT_CHAINS in " +
        "test/unit/tooling/ci-workflow.ts",
    );
  }
  if (commands.length > 1 && !dependent) {
    findings.push(
      `${gate.label} runs ${commands.length} commands in one step (${commands
        .map((command) => JSON.stringify(command.text))
        .join(", ")}); GitHub runs a \`run\` block with \`bash -e\`, so the first failure hides the rest, as an ` +
        "`&&` chain would; give each independent command its own gated step, or, if each command needs the ones " +
        "before it, record the block in DEPENDENT_RUN_BLOCKS in test/unit/tooling/ci-workflow.ts with the reason",
    );
  }
  return findings;
}

/**
 * Every way the workflow's gates and the root `package.json` chains have
 * drifted apart (see THE DRIFT CHECK above). An empty list means they agree.
 * Throws, rather than reporting, when either text is outside what the check
 * can read.
 */
export function splitStepDrift(workflowText: string, packageJsonText: string): string[] {
  const scripts = rootScripts(packageJsonText);
  const rootName = rootPackageName(packageJsonText);
  const chains = chainCommands(packageJsonText);
  const findings: string[] = [];

  const gatesByJob = new Map<string, readonly WorkflowStep[]>();
  for (const { job, setup } of GATED_JOBS) {
    const checked = gateFindings(workflowText, job, setup);
    findings.push(...checked.findings);
    if (checked.gates !== undefined) gatesByJob.set(job, checked.gates);
  }
  // Without exactly one install step no node step is known to be a gate, and
  // the split checks are skipped; the one-step-chain rule still runs below for
  // every job whose gates are known.
  const lookAlikes = new Set<WorkflowStep>();
  const gates = gatesByJob.get("node");
  if (gates !== undefined) findings.push(...splitFindings(gates, chains, lookAlikes));

  const isRecorded = (job: string, gate: WorkflowStep, block: (typeof DEPENDENT_RUN_BLOCKS)[number]): boolean =>
    block.job === job && block.step === gate.name && block.run === gate.run;
  for (const [job, jobGates] of gatesByJob) {
    for (const gate of jobGates) {
      if (lookAlikes.has(gate)) continue;
      const dependent = DEPENDENT_RUN_BLOCKS.some((block) => isRecorded(job, gate, block));
      findings.push(...oneStepChain(gate, scripts, rootName, dependent));
    }
  }
  // A recorded block that no gate runs any more is stale: the entry would
  // silently excuse a block of that name and text if it came back. Checked
  // only for a job whose gates are known.
  for (const block of DEPENDENT_RUN_BLOCKS) {
    const jobGates = gatesByJob.get(block.job);
    if (jobGates === undefined || jobGates.some((gate) => isRecorded(block.job, gate, block))) continue;
    findings.push(
      `DEPENDENT_RUN_BLOCKS records the ${block.job} step ${JSON.stringify(block.step)} as a dependent block, but no ` +
        `gate of that job runs that exact block any more; update the entry with its reason, or remove it`,
    );
  }
  return findings;
}

/**
 * The split checks on the node job's gates: each chained command is run by
 * exactly one gate, in chain order and named for its position, and no other
 * gate looks like a split step. Every look-alike is added to `lookAlikes`, so
 * the one-step-chain rule does not report it a second time (`pnpm typecheck`
 * would be both).
 */
function splitFindings(
  gates: readonly WorkflowStep[],
  chains: ReadonlyMap<string, readonly string[]>,
  lookAlikes: Set<WorkflowStep>,
): string[] {
  const findings: string[] = [];
  const chainRuns = new Set<string>();
  for (const { script, label } of SPLIT_CHAINS) {
    const commands = chains.get(script) ?? [];
    let previous: WorkflowStep | undefined;
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
      lookAlikes.add(gate);
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

// ---------------------------------------------------------------------------
// CI-7 (CLOSEOUT-3 L1): every workspace package's integration script is
// chained. See THE INTEGRATION-SCRIPT RULE above.

/**
 * A workspace package's manifest: its directory relative to the repository
 * root, and its `package.json` text. For a directory symlink, `dir` is the
 * link's path, which is the path pnpm lists it at.
 */
export interface WorkspaceManifest {
  readonly dir: string;
  readonly text: string;
}

/** A package integration script the root `test:integration` chain deliberately does not run, and why. */
export interface UnchainedIntegrationScript {
  readonly package: string;
  readonly script: string;
  readonly why: string;
}

/**
 * The workspace packages' integration scripts that the root `test:integration`
 * chain deliberately does NOT run, each with its reason (`CI-7`). EMPTY at
 * `CI-7`: every such script is chained. An entry would read, for example,
 * `{ package: "@polymarket-bot/example", script: "test:integration:soak",
 * why: "a manual multi-hour soak, not a gate" }`. An entry whose script is
 * chained after all, whose package or script is gone, or that gives no reason
 * is itself a finding, so a stale entry cannot silently excuse a script that
 * comes back.
 */
export const UNCHAINED_INTEGRATION_SCRIPTS: readonly UnchainedIntegrationScript[] = [];

/** The package scripts the rule covers: `test:integration`, and `test:integration:<x>` (CI-5 chained control-api's `:postgres`). */
const INTEGRATION_SCRIPT = /^test:integration(?::[A-Za-z0-9_.-]+)*$/u;

/** The root chain that must run them. */
const INTEGRATION_CHAIN = "test:integration";

/** The one spelling the rule accepts as "chained": the one every chained package suite uses. */
export function packageScriptCommand(packageName: string, script: string): string {
  return `pnpm --filter ${packageName} ${script}`;
}

/** A chained command of that spelling, read back into its package name and script. */
const PACKAGE_SCRIPT_COMMAND = /^pnpm --filter (\S+) (\S+)$/u;

/** A workspace glob the reader accepts: a directory path, then `/*`, as pnpm-workspace.yaml spells each today. */
const DIRECTORY_GLOB = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/\*$/u;

/**
 * The `packages:` globs of `pnpm-workspace.yaml` text. It reads only that
 * top-level block: `  - <glob>` items, plain or quoted, with blank and comment
 * lines between them. It throws on anything else in the block, and on any
 * glob other than `<directory>/*` (a `**`, a `!` exclusion, a brace), rather
 * than guess which packages the workspace admits.
 */
export function workspacePackageGlobs(workspaceYamlText: string): readonly string[] {
  if (workspaceYamlText.includes("\r")) throw new Error("pnpm-workspace.yaml: CR line ends are refused");
  const lines = workspaceYamlText.split("\n");
  const start = lines.findIndex((line) => line === "packages:");
  if (start < 0 || lines.filter((line) => /^packages\s*:/u.test(line)).length !== 1) {
    throw new Error("pnpm-workspace.yaml: expected exactly one top-level `packages:` line, with its items below it");
  }
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s*#/u.test(line)) continue;
    if (/^\S/u.test(line)) break; // the next top-level key
    const item = /^ {2}- (?:"([^"]*)"|'([^']*)'|([^\s"'#]+))(?: +#.*)?$/u.exec(line);
    const glob = item === null ? undefined : (item[1] ?? item[2] ?? item[3]);
    if (glob === undefined || !DIRECTORY_GLOB.test(glob)) {
      throw new Error(
        `pnpm-workspace.yaml: ${JSON.stringify(line)} is not a \`  - <directory>/*\` item; ` +
          "the integration-script rule reads only that form (extend test/unit/tooling/ci-workflow.ts deliberately)",
      );
    }
    if (globs.includes(glob)) throw new Error(`pnpm-workspace.yaml: the glob ${JSON.stringify(glob)} appears twice`);
    globs.push(glob);
  }
  if (globs.length === 0) throw new Error("pnpm-workspace.yaml: `packages:` lists no glob");
  return globs;
}

/**
 * The manifest file names pnpm 11 reads for a workspace project. Its reader
 * globs `<pattern>/package.{json,yaml,json5}`; the rule reads only `package.json`.
 */
const PNPM_MANIFEST_NAMES: ReadonlySet<string> = new Set(["package.json", "package.yaml", "package.json5"]);

/**
 * Directory names pnpm 11.17.0 never admits under a `<directory>/*` glob.
 * `node_modules` and `bower_components` are on its workspace reader's ignore
 * list, and `*` does not match a hidden name, since tinyglobby leaves `dot` off.
 */
function pnpmSkipsDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "bower_components";
}

/** The workspace as `readWorkspaceManifests` reads it. */
export interface WorkspaceRead {
  readonly globs: readonly string[];
  readonly manifests: readonly WorkspaceManifest[];
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The globs of `<root>/pnpm-workspace.yaml`, and the manifest of every workspace
 * package they admit, in the order of the globs and then of the directory names
 * (CI-7 r1, CI7-R1-01). Each glob is `<directory>/*`, so listing that directory
 * gives the whole match. Every entry is resolved through any symlink, as pnpm's
 * glob resolves it (tinyglobby's `followSymbolicLinks` defaults to true).
 * - An entry that resolves to anything but a directory is not a package.
 * - So is a directory that holds none of `PNPM_MANIFEST_NAMES`.
 * Every case where pnpm and this reader could disagree THROWS (see THE
 * INTEGRATION-SCRIPT RULE above): an entry that does not resolve, a
 * `package.yaml` or `package.json5` manifest, and a directory pnpm skips that
 * holds a manifest.
 */
export async function readWorkspaceManifests(root: string): Promise<WorkspaceRead> {
  const globs = workspacePackageGlobs(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8"));
  const manifests: WorkspaceManifest[] = [];
  const advice = "the integration-script rule refuses to guess (extend test/unit/tooling/ci-workflow.ts deliberately)";
  for (const glob of globs) {
    const parent = glob.slice(0, -"/*".length);
    for (const name of (await readdir(path.join(root, parent))).sort(byCodeUnits)) {
      const dir = `${parent}/${name}`;
      const where = path.join(root, dir);
      const target = await stat(where).catch((error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error);
        throw new Error(
          `${dir} does not resolve (${code}). A broken symlink may resolve on another machine, where pnpm would ` +
            `admit its package, so ${advice}`,
        );
      });
      if (!target.isDirectory()) continue;
      const found = (await readdir(where)).filter((entry) => PNPM_MANIFEST_NAMES.has(entry)).sort(byCodeUnits);
      if (found.length === 0) continue;
      if (pnpmSkipsDirectory(name)) {
        throw new Error(
          `${dir} holds ${found.join(" and ")}, but pnpm 11 admits no hidden, node_modules or bower_components ` +
            `directory as a workspace package, so no \`--filter\` could run it; ${advice}`,
        );
      }
      if (found.length !== 1 || found[0] !== "package.json") {
        throw new Error(
          `${dir} holds ${found.join(" and ")}. pnpm 11 admits a package.yaml or package.json5 manifest, but the ` +
            `integration-script rule reads only package.json, so ${advice}`,
        );
      }
      manifests.push({ dir, text: await readFile(path.join(where, "package.json"), "utf8") });
    }
  }
  return { globs, manifests };
}

/** A workspace package as the rule reads it. Throws on a manifest without a name, or with a non-string script. */
function readManifest(manifest: WorkspaceManifest): { readonly name: string; readonly scripts: readonly string[] } {
  const parsed: unknown = JSON.parse(manifest.text);
  const record = typeof parsed === "object" && parsed !== null ? (parsed as { readonly name?: unknown; readonly scripts?: unknown }) : {};
  if (typeof record.name !== "string" || record.name === "") {
    throw new Error(`${manifest.dir}/package.json: no \`name\`, so no \`--filter\` can select it`);
  }
  const scripts = record.scripts ?? {};
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error(`${manifest.dir}/package.json: \`scripts\` is not an object`);
  }
  const names = Object.entries(scripts as Readonly<Record<string, unknown>>).map(([name, text]) => {
    if (typeof text !== "string") throw new Error(`${manifest.dir}/package.json: script \`${name}\` is not a string`);
    return name;
  });
  return { name: record.name, scripts: names };
}

/**
 * Every way the root chains and the workspace packages' scripts disagree (see
 * THE INTEGRATION-SCRIPT RULE above). An empty list means every package
 * integration script runs in the root `test:integration` chain or is exempted
 * with a reason, and every `pnpm --filter` command of a chain runs a script
 * that exists. Throws when a text is outside what the check can read.
 */
export function integrationScriptFindings(
  packageJsonText: string,
  manifests: readonly WorkspaceManifest[],
  exemptions: readonly UnchainedIntegrationScript[] = UNCHAINED_INTEGRATION_SCRIPTS,
): string[] {
  const chains = chainCommands(packageJsonText);
  const chained = new Set(chains.get(INTEGRATION_CHAIN) ?? []);
  const packages = new Map<string, { readonly dir: string; readonly scripts: readonly string[] }>();
  for (const manifest of [...manifests].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))) {
    const { name, scripts } = readManifest(manifest);
    const other = packages.get(name);
    if (other !== undefined) {
      throw new Error(`${other.dir}/package.json and ${manifest.dir}/package.json are both named ${name}`);
    }
    packages.set(name, { dir: manifest.dir, scripts });
  }
  const isExempt = (name: string, script: string): boolean =>
    exemptions.some((entry) => entry.package === name && entry.script === script);

  const findings: string[] = [];
  for (const [name, { dir, scripts }] of packages) {
    for (const script of scripts) {
      if (!INTEGRATION_SCRIPT.test(script)) continue;
      const command = packageScriptCommand(name, script);
      if (chained.has(command) || isExempt(name, script)) continue;
      findings.push(
        `${dir}/package.json's \`${script}\` script runs in no gate: the root \`${INTEGRATION_CHAIN}\` chain has no ` +
          `${JSON.stringify(command)}; chain it (the split-step check then requires its own CI step), or record it ` +
          "in UNCHAINED_INTEGRATION_SCRIPTS in test/unit/tooling/ci-workflow.ts with the reason",
      );
    }
  }

  for (const { script: chain } of SPLIT_CHAINS) {
    for (const command of chains.get(chain) ?? []) {
      const match = PACKAGE_SCRIPT_COMMAND.exec(command);
      if (match === null) continue;
      const name = match[1] ?? "";
      const script = match[2] ?? "";
      const found = packages.get(name);
      if (found === undefined) {
        findings.push(
          `the root \`${chain}\` command ${JSON.stringify(command)} names ${name}, which is no workspace package; ` +
            "pnpm exits 0 when a filter matches nothing, so its step would pass having run nothing",
        );
      } else if (!found.scripts.includes(script)) {
        findings.push(
          `the root \`${chain}\` command ${JSON.stringify(command)} runs \`${script}\`, which ${found.dir}/package.json does not define`,
        );
      }
    }
  }

  for (const entry of exemptions) {
    const label = `UNCHAINED_INTEGRATION_SCRIPTS exempts ${entry.package} \`${entry.script}\``;
    const found = packages.get(entry.package);
    if (!INTEGRATION_SCRIPT.test(entry.script)) {
      findings.push(`${label}, which is not an integration script the rule covers; remove the entry`);
    } else if (found === undefined || !found.scripts.includes(entry.script)) {
      findings.push(`${label}, but no workspace package defines that script any more; remove the entry`);
    } else if (chained.has(packageScriptCommand(entry.package, entry.script))) {
      findings.push(`${label}, but the root \`${INTEGRATION_CHAIN}\` chain runs it; remove the entry`);
    }
    if (entry.why.trim() === "") findings.push(`${label} without a reason`);
  }
  return findings;
}
