/**
 * Reads the SPECIFICATION itself, so the tests compare the shipped strategy
 * against handoff §13 mechanically rather than against a hand-copied summary.
 *
 * This is the WP-210 partition precedent applied to §13: a list a test author
 * typed is a list that drifts, while a list derived from the authority fails
 * loudly when either side moves. `node:fs` here is a fixture read in the ROOT
 * test tree, which `dependency-direction.md` §2.2 explicitly places outside
 * F17's runtime-import scope and which the `packages/{ledger,simulation}` root
 * suites already do.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const HANDOFF_PATH = resolve(
  REPO_ROOT,
  "docs/spec/polymarket-bot-orchestrator-handoff.md",
);
export const FEATURES_CONTRACT_PATH = resolve(REPO_ROOT, "docs/contracts/features-v1.md");

export function readRepoFile(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

export function handoffText(): string {
  return readFileSync(HANDOFF_PATH, "utf8");
}

/**
 * The body of one `### <number> <title>` subsection, up to the next heading of
 * the same or a higher level. Throws when the heading is absent, so a renamed
 * section fails the suite instead of silently matching nothing.
 */
export function handoffSection(heading: string): string {
  const text = handoffText();
  const start = text.indexOf(`### ${heading}`);
  if (start < 0) {
    throw new Error(`handoff section "${heading}" not found — the spec moved`);
  }
  const rest = text.slice(start + heading.length);
  const nextHeading = rest.search(/\n#{2,3} /u);
  return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
}

/** Every fenced block in `text`, with its info string. */
export function fencedBlocks(text: string): { info: string; body: string }[] {
  const blocks: { info: string; body: string }[] = [];
  const pattern = /```([a-zA-Z]*)\n([\s\S]*?)```/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    blocks.push({ info: match[1] ?? "", body: match[2] ?? "" });
    match = pattern.exec(text);
  }
  return blocks;
}

export type YamlValue = string | number | boolean | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

/**
 * A deliberately tiny YAML reader for §13.2's block: nested mappings, scalar
 * values, quoted strings, integers and booleans. It supports nothing else, and
 * REFUSES anything else, so it cannot quietly mis-read a spec that grows a list
 * or an anchor.
 */
export function parseSimpleYaml(source: string): YamlMap {
  const root: YamlMap = {};
  const stack: { indent: number; map: YamlMap }[] = [{ indent: -1, map: root }];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\s+$/u, "");
    if (line.length === 0 || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();
    if (body.startsWith("- ")) {
      throw new Error(`the §13.2 YAML subset does not support sequences: ${line}`);
    }
    const separator = body.indexOf(":");
    if (separator < 0) {
      throw new Error(`unsupported YAML line: ${line}`);
    }
    const key = body.slice(0, separator).trim();
    const valueText = body.slice(separator + 1).trim();
    while (stack.length > 1 && indent <= (stack[stack.length - 1] as { indent: number }).indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] as { indent: number; map: YamlMap };
    if (valueText.length === 0) {
      const child: YamlMap = {};
      parent.map[key] = child;
      stack.push({ indent, map: child });
      continue;
    }
    parent.map[key] = parseScalar(valueText);
  }
  return root;
}

function parseScalar(text: string): YamlValue {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/u.test(text)) return Number(text);
  return text;
}

/** Flattens a nested map to `a.b.c -> scalar` entries. */
export function flatten(value: YamlMap, prefix = ""): Map<string, string | number | boolean> {
  const flat = new Map<string, string | number | boolean>();
  for (const [key, member] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (typeof member === "object") {
      for (const [nested, scalar] of flatten(member, path)) {
        flat.set(nested, scalar);
      }
      continue;
    }
    flat.set(path, member);
  }
  return flat;
}
