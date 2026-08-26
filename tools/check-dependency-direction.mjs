#!/usr/bin/env node
/**
 * WP-015 — dependency-direction and package-boundary check.
 *
 * SPECIFICATION: `docs/contracts/dependency-direction.md` §6. This script is an
 * implementation of that section and of nothing else; every failure it emits
 * cites the contract row (F1–F13) that it enforces.
 *
 * Why the layer table is not copied into this file: §6 requires that "the layer
 * table and the §2.1 edge list live in one place — this document — and the
 * check parses them or is generated from them. A test's private copy of either
 * table is exactly how coverage drifts." So the contract Markdown is parsed at
 * run time and is the single source of truth. The parser depends on the
 * document's current shape:
 *
 *   - §2 layer subsections are `### Layer <n> — ...` headings; a package is
 *     assigned by (a) a backticked path in the first cell of a Markdown table
 *     row, (b) a path token inside a fenced block, or (c) a backticked path in
 *     a sentence of the form "`<path>` is a ... member of this layer" (this is
 *     how the `packages/strategies/**` class entry is stated).
 *   - §2.1 rows are Markdown table rows whose second cell contains
 *     "`<from>` → `<to>`"; the third cell is the layer.
 *
 * If a contract edit breaks that shape the check fails closed (packages become
 * unclassified, or the allowlist comes back empty), which is the intended
 * direction of failure: it never silently stops covering code.
 *
 * Rules implemented (see `docs/contracts/dependency-direction.md` §3, §6):
 *   1. F9  — no cycle in the workspace dependency graph.
 *   2. F12 — no edge from a lower-numbered layer to a higher-numbered one.
 *      F13 — a same-layer edge must be listed in §2.1.
 *      Fail closed on an unclassified workspace package, and on a named §2
 *      entry with no manifest (§6 "fails closed" bullets).
 *   3. F1–F8, F11 — forbidden import specifiers and non-deterministic globals,
 *      scanned in package source (a bare `node:` import appears in no
 *      dependency list, so `package.json` cannot see it).
 *
 * No network, no credentials, no installed dependency: Node built-ins only.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CONTRACT_REL = "docs/contracts/dependency-direction.md";
const WORKSPACE_REL = "pnpm-workspace.yaml";

/** Directories never walked when discovering packages or scanning source. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "python",
  "target",
  "out",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];

// ---------------------------------------------------------------------------
// Forbidden specifier catalogues (contract §3, rows F1–F8 and F11).
// These are library/module names, not layer data: they encode "what is a Redis
// client", not "what layer a package is in", so they belong in the checker.
// ---------------------------------------------------------------------------

/** F6: the supported unified SDK (handoff §9.12, ADR-010 §4). */
const UNIFIED_SDK = "@polymarket/client";

/** F7: archived Polymarket clients (verified-2026-08-24 §1). */
const ARCHIVED_CLIENTS = [
  "@polymarket/clob-client",
  "@polymarket/clob-client-v2",
  "@polymarket/builder-relayer-client",
  "@polymarket/builder-signing-sdk",
];

/** F8: Redis clients. */
const REDIS_CLIENTS = ["redis", "ioredis", "@redis/*", "redis-om", "node-redis"];

/** F1/F3: PostgreSQL clients. */
const POSTGRES_CLIENTS = [
  "pg",
  "pg-native",
  "pg-promise",
  "postgres",
  "slonik",
  "@databases/pg",
  "@vercel/postgres",
];

/** F1/F3: venue/exchange SDKs reachable from npm. */
const VENUE_SDKS = ["@polymarket/*", ...ARCHIVED_CLIENTS, "ccxt", "binance-api-node"];

/** F5: signing libraries — a "live signer" in library form (ADR-010 §4). */
const SIGNER_LIBRARIES = [
  "ethers",
  "@ethersproject/*",
  "viem",
  "web3",
  "eth-crypto",
  "@safe-global/*",
  UNIFIED_SDK,
  ...ARCHIVED_CLIENTS,
];

/** F3: HTTP/socket clients — "network" in ADR-005 §1's I/O list. */
const NETWORK_LIBRARIES = [
  "axios",
  "node-fetch",
  "undici",
  "got",
  "superagent",
  "ws",
  "socket.io-client",
];

/**
 * F3: Node built-ins that are I/O, environment, clock, or randomness. Pure
 * built-ins (`path`, `url`, `util`, `assert`, `events`, `buffer`, `stream`) are
 * not listed: ADR-005 §1 forbids "network, database, filesystem, environment,
 * global clock, or unseeded randomness", not every built-in. (`packages/domain`
 * is stricter still — F2 forbids *any* built-in there.)
 */
const IMPURE_BUILTINS = new Map([
  ["fs", "filesystem"],
  ["fs/promises", "filesystem"],
  ["child_process", "process/environment"],
  ["cluster", "process/environment"],
  ["worker_threads", "process/environment"],
  ["process", "process/environment"],
  ["os", "process/environment"],
  ["v8", "process/environment"],
  ["vm", "process/environment"],
  ["inspector", "process/environment"],
  ["repl", "process/environment"],
  ["readline", "process/environment"],
  ["net", "network"],
  ["tls", "network"],
  ["http", "network"],
  ["https", "network"],
  ["http2", "network"],
  ["dgram", "network"],
  ["dns", "network"],
  ["timers", "clock"],
  ["timers/promises", "clock"],
  ["perf_hooks", "clock"],
  ["crypto", "randomness"],
]);

/** F1 (process globals) / F11 (clock and unseeded randomness). */
const IMPURE_GLOBALS = [
  { pattern: /\bDate\s*\.\s*now\s*\(/g, what: "clock (`Date.now()`)" },
  { pattern: /new\s+Date\s*\(\s*\)/g, what: "clock (`new Date()`)" },
  { pattern: /\bperformance\s*\.\s*now\s*\(/g, what: "clock (`performance.now()`)" },
  { pattern: /\bprocess\s*\.\s*hrtime\b/g, what: "clock (`process.hrtime`)" },
  { pattern: /\bMath\s*\.\s*random\s*\(/g, what: "unseeded randomness (`Math.random()`)" },
  {
    pattern: /\bcrypto\s*\.\s*(?:randomUUID|getRandomValues|randomBytes)\s*\(/g,
    what: "unseeded randomness (`crypto` random)",
  },
];

const PROCESS_GLOBALS = [
  { pattern: /\bprocess\s*\.\s*[A-Za-z_$]/g, what: "process global (`process.*`)" },
  { pattern: /\bglobalThis\b/g, what: "process global (`globalThis`)" },
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const toPosix = (value) => value.split(path.sep).join("/");

function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Minimal glob → RegExp over a POSIX relative path.
 * `*` matches within one segment; `**` matches one or more whole segments.
 */
function globToRegExp(glob) {
  const parts = glob.split("/").map((segment) => {
    if (segment === "**") return "[^/]+(?:/[^/]+)*";
    return escapeRegExp(segment).replace(/\*/g, "[^/]*");
  });
  return new RegExp(`^${parts.join("/")}$`);
}

const isGlob = (value) => value.includes("*");

function matchesGlob(candidate, glob) {
  return isGlob(glob) ? globToRegExp(glob).test(candidate) : candidate === glob;
}

/** Matches an npm specifier (including subpaths) against a name or `@scope/*`. */
function specifierMatches(specifier, pattern) {
  if (pattern.endsWith("/*")) {
    const scope = pattern.slice(0, -1);
    return specifier.startsWith(scope);
  }
  return specifier === pattern || specifier.startsWith(`${pattern}/`);
}

function specifierMatchesAny(specifier, patterns) {
  return patterns.find((pattern) => specifierMatches(specifier, pattern));
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

function normalizeBuiltin(specifier) {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  if (builtinModules.includes(specifier)) return true;
  const head = specifier.split("/")[0];
  return builtinModules.includes(head) && specifier.includes("/");
}

function listDirectory(absolute) {
  try {
    return readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileExists(absolute) {
  try {
    statSync(absolute);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

/**
 * Reads the `packages:` sequence out of `pnpm-workspace.yaml`. Deliberately
 * minimal (no YAML dependency) and fails closed on anything it does not
 * understand, including pnpm's `!` exclusion syntax.
 */
function readWorkspaceGlobs(rootDir) {
  const absolute = path.join(rootDir, WORKSPACE_REL);
  const text = readFileSync(absolute, "utf8");
  const globs = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item) {
      const value = item[1].trim().replace(/^["']|["']$/g, "");
      if (value.startsWith("!")) {
        throw new Error(
          `${WORKSPACE_REL} uses an exclusion pattern (${value}); this check does not model exclusions.`,
        );
      }
      globs.push(value);
      continue;
    }
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) break; // next top-level key
  }
  if (globs.length === 0) {
    throw new Error(`${WORKSPACE_REL} declares no workspace package globs.`);
  }
  return globs;
}

/**
 * Discovers workspace members: every directory matching a workspace glob that
 * contains a `package.json`. The workspace root manifest is deliberately not a
 * node (contract §6, "Graph construction").
 */
function discoverPackages(rootDir, globs) {
  const found = [];
  const maxDepth = Math.max(
    ...globs.map((glob) => (glob.includes("**") ? 8 : glob.split("/").length)),
  );

  const walk = (relativeDir, depth) => {
    if (depth > maxDepth) return;
    const absolute = path.join(rootDir, relativeDir);
    for (const entry of listDirectory(absolute)) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const childRel = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      const manifestPath = path.join(rootDir, childRel, "package.json");
      const hasManifest = fileExists(manifestPath);
      if (hasManifest && globs.some((glob) => matchesGlob(childRel, glob))) {
        found.push({ dir: childRel, manifestPath });
        continue; // a workspace member is a leaf for discovery purposes
      }
      if (hasManifest) continue;
      walk(childRel, depth + 1);
    }
  };

  walk("", 1);

  return found
    .map(({ dir, manifestPath }) => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const dependencies = [];
      for (const field of DEPENDENCY_FIELDS) {
        const block = manifest[field];
        if (!block || typeof block !== "object") continue;
        for (const [name, specifier] of Object.entries(block)) {
          dependencies.push({ name, specifier, field });
        }
      }
      return {
        dir,
        name: typeof manifest.name === "string" ? manifest.name : dir,
        dependencies,
      };
    })
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Contract parsing (§2 layer table, §2.1 permitted same-layer edges)
// ---------------------------------------------------------------------------

const PATH_TOKEN = /^(?:packages|apps)\/[A-Za-z0-9._*-]+(?:\/[A-Za-z0-9._*-]+)*$/;

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.split("|").map((cell) => cell.trim());
  cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null; // separator
  return cells;
}

function parseContract(text) {
  const lines = text.split(/\r?\n/);
  const assignments = [];
  const sameLayerEdges = [];
  const problems = [];

  let currentLayer = null;
  let inFence = false;

  const sectionOf = (line) => {
    const layerHeading = line.match(/^###\s+Layer\s+(\d+)\b/);
    if (layerHeading) return { kind: "layer", layer: Number(layerHeading[1]) };
    if (/^###\s+2\.1\b/.test(line)) return { kind: "same-layer" };
    if (/^#{2,3}\s+/.test(line)) return { kind: "other" };
    return null;
  };

  let section = { kind: "other" };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = sectionOf(line);
    if (heading) {
      section = heading;
      currentLayer = heading.kind === "layer" ? heading.layer : null;
      inFence = false;
      continue;
    }

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (section.kind === "layer" && currentLayer !== null) {
      if (inFence) {
        for (const token of line.split(/\s+/)) {
          const candidate = token.replace(/^`|`$/g, "").replace(/[.,;:]$/, "");
          if (candidate === "") continue;
          if (!/^(?:packages|apps)\//.test(candidate)) continue;
          if (!PATH_TOKEN.test(candidate)) {
            problems.push(
              `${CONTRACT_REL} §2 Layer ${currentLayer}: unparseable package path "${candidate}" (line ${index + 1}).`,
            );
            continue;
          }
          assignments.push({ pattern: candidate, layer: currentLayer, line: index + 1 });
        }
        continue;
      }

      const cells = splitTableRow(line);
      if (cells && cells.length >= 2) {
        const firstCell = cells[0].match(/^`([^`]+)`$/);
        if (firstCell && PATH_TOKEN.test(firstCell[1])) {
          assignments.push({ pattern: firstCell[1], layer: currentLayer, line: index + 1 });
        }
        continue;
      }

      // Class entries are stated in prose: "`packages/strategies/**` is a
      // **restricted** member of this layer".
      const prose = line.match(/`((?:packages|apps)\/[^`]+)`[^`]*member of this layer/);
      if (prose && PATH_TOKEN.test(prose[1])) {
        assignments.push({ pattern: prose[1], layer: currentLayer, line: index + 1 });
      }
      continue;
    }

    if (section.kind === "same-layer") {
      const cells = splitTableRow(line);
      if (!cells || cells.length < 3) continue;
      const [id, edgeCell, layerCell] = cells;
      const edge = edgeCell.match(/`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/);
      if (!edge) continue;
      const layer = /^\d+$/.test(layerCell) ? Number(layerCell) : null;
      sameLayerEdges.push({
        id: id.replace(/`/g, ""),
        from: edge[1],
        to: edge[2],
        layer,
        line: index + 1,
      });
    }
  }

  if (assignments.length === 0) {
    problems.push(`${CONTRACT_REL} §2: no layer assignments parsed.`);
  }
  if (sameLayerEdges.length === 0) {
    problems.push(`${CONTRACT_REL} §2.1: no permitted same-layer edge rows parsed.`);
  }

  const byPattern = new Map();
  for (const assignment of assignments) {
    const existing = byPattern.get(assignment.pattern);
    if (existing && existing.layer !== assignment.layer) {
      problems.push(
        `${CONTRACT_REL} §2 assigns \`${assignment.pattern}\` to layer ${existing.layer} (line ${existing.line}) and layer ${assignment.layer} (line ${assignment.line}); §2 requires exactly one layer per package.`,
      );
      continue;
    }
    if (!existing) byPattern.set(assignment.pattern, assignment);
  }

  const seenIds = new Set();
  for (const edge of sameLayerEdges) {
    if (seenIds.has(edge.id)) {
      problems.push(`${CONTRACT_REL} §2.1 repeats row id "${edge.id}" (line ${edge.line}).`);
    }
    seenIds.add(edge.id);
  }

  return {
    assignments: [...byPattern.values()],
    sameLayerEdges,
    problems,
  };
}

function classify(dir, assignments) {
  const exact = assignments.find((entry) => !isGlob(entry.pattern) && entry.pattern === dir);
  if (exact) return exact;
  const matches = assignments.filter((entry) => isGlob(entry.pattern) && matchesGlob(dir, entry.pattern));
  if (matches.length === 0) return null;
  const layers = new Set(matches.map((entry) => entry.layer));
  if (layers.size > 1) return { ambiguous: [...matches] };
  return matches[0];
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/**
 * Replaces comment bodies with spaces, preserving offsets and newlines, so that
 * prose such as "never import node:fs here" cannot trip the specifier scan and
 * reported line numbers still match the original file.
 */
function stripComments(source) {
  const out = source.split("");
  let state = "code";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    switch (state) {
      case "code":
        if (char === "/" && next === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 1;
          state = "line-comment";
        } else if (char === "/" && next === "*") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 1;
          state = "block-comment";
        } else if (char === '"') state = "double";
        else if (char === "'") state = "single";
        else if (char === "`") state = "template";
        break;
      case "line-comment":
        if (char === "\n") state = "code";
        else out[i] = " ";
        break;
      case "block-comment":
        if (char === "*" && next === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 1;
          state = "code";
        } else if (char !== "\n") out[i] = " ";
        break;
      case "double":
      case "single":
      case "template": {
        if (char === "\\") {
          i += 1;
          break;
        }
        if (state === "double" && char === '"') state = "code";
        else if (state === "single" && char === "'") state = "code";
        else if (state === "template" && char === "`") state = "code";
        break;
      }
      default:
        break;
    }
  }
  return out.join("");
}

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineNumberAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /(?:^|[;{}])\s*import\s+["']([^"'\n]+)["']/g,
];

function collectSourceFiles(rootDir, packageDir) {
  const files = [];
  const walk = (relativeDir) => {
    for (const entry of listDirectory(path.join(rootDir, relativeDir))) {
      const childRel = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        walk(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(childRel);
    }
  };
  walk(packageDir);
  return files.sort();
}

function scanSourceFile(rootDir, fileRel) {
  const raw = readFileSync(path.join(rootDir, fileRel), "utf8");
  const code = stripComments(raw);
  const starts = lineStarts(raw);
  const specifiers = [];
  const seen = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(code);
    while (match !== null) {
      const key = `${match.index}:${match[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        specifiers.push({
          specifier: match[1],
          line: lineNumberAt(starts, match.index),
        });
      }
      match = pattern.exec(code);
    }
  }
  return { code, starts, specifiers };
}

function findGlobals(scan, catalogue) {
  const hits = [];
  for (const { pattern, what } of catalogue) {
    pattern.lastIndex = 0;
    let match = pattern.exec(scan.code);
    while (match !== null) {
      hits.push({ what, line: lineNumberAt(scan.starts, match.index) });
      match = pattern.exec(scan.code);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function violation(entry) {
  return {
    rule: entry.rule,
    subject: entry.subject,
    message: entry.message,
    doc: entry.doc,
    fix: entry.fix ?? null,
    location: entry.location ?? null,
  };
}

function findCycles(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  const state = new Map(nodes.map((node) => [node, "white"]));
  const stack = [];
  const cycles = [];
  const seen = new Set();

  const visit = (node) => {
    state.set(node, "grey");
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const colour = state.get(next);
      if (colour === "grey") {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        const key = [...cycle].sort().join("|");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (colour === "white") {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "black");
  };

  for (const node of nodes) {
    if (state.get(node) === "white") visit(node);
  }
  return cycles;
}

function runCheck(rootDir) {
  const violations = [];
  const push = (entry) => violations.push(violation(entry));

  let contractText;
  try {
    contractText = readFileSync(path.join(rootDir, CONTRACT_REL), "utf8");
  } catch {
    push({
      rule: "CHK",
      subject: CONTRACT_REL,
      message: `the dependency-direction contract could not be read at ${path.join(rootDir, CONTRACT_REL)}`,
      doc: `${CONTRACT_REL} §6`,
      fix: "run this check from the repository root, or pass --root <repo>",
    });
    return { ok: false, violations, packages: [], edges: [], allowlist: [] };
  }

  const contract = parseContract(contractText);
  for (const problem of contract.problems) {
    push({
      rule: "CHK",
      subject: CONTRACT_REL,
      message: problem,
      doc: `${CONTRACT_REL} §2, §2.1, §6`,
      fix: "restore the documented table/fence/prose shape the checker parses (see this script's header)",
    });
  }

  let globs;
  try {
    globs = readWorkspaceGlobs(rootDir);
  } catch (error) {
    push({
      rule: "CHK",
      subject: WORKSPACE_REL,
      message: error instanceof Error ? error.message : String(error),
      doc: `${CONTRACT_REL} §6`,
      fix: "declare workspace package globs pnpm and this check both understand",
    });
    return { ok: false, violations, packages: [], edges: [], allowlist: contract.sameLayerEdges };
  }

  const discovered = discoverPackages(rootDir, globs);
  const byName = new Map(discovered.map((pkg) => [pkg.name, pkg]));
  const dirs = new Set(discovered.map((pkg) => pkg.dir));

  // ---- §2 classification, fail-closed in both directions -------------------
  const layerOf = new Map();
  for (const pkg of discovered) {
    const assignment = classify(pkg.dir, contract.assignments);
    if (assignment === null) {
      push({
        rule: "F-CLOSED",
        subject: pkg.dir,
        message: `workspace package \`${pkg.dir}\` (${pkg.name}) is not classified in §2; the check fails closed rather than exempting it`,
        doc: `${CONTRACT_REL} §2, §6 ("fails closed on an unclassified package")`,
        fix: `add \`${pkg.dir}\` to exactly one §2 layer`,
      });
      continue;
    }
    if (assignment.ambiguous) {
      push({
        rule: "F-CLOSED",
        subject: pkg.dir,
        message: `workspace package \`${pkg.dir}\` matches §2 class entries in more than one layer (${assignment.ambiguous
          .map((entry) => `${entry.pattern} → layer ${entry.layer}`)
          .join(", ")})`,
        doc: `${CONTRACT_REL} §2 ("exactly one layer")`,
        fix: "make the §2 class entries disjoint",
      });
      continue;
    }
    layerOf.set(pkg.dir, assignment.layer);
  }

  for (const assignment of contract.assignments) {
    if (isGlob(assignment.pattern)) continue; // class entries may match zero packages
    if (dirs.has(assignment.pattern)) continue;
    push({
      rule: "F-CLOSED",
      subject: assignment.pattern,
      message: `§2 (line ${assignment.line}) classifies \`${assignment.pattern}\` in layer ${assignment.layer}, but that path has no workspace \`package.json\``,
      doc: `${CONTRACT_REL} §6 ("a named entry must resolve to a workspace package")`,
      fix: "create the package, or remove the §2 row that describes a package that does not exist",
    });
  }

  // ---- graph construction (contract §6, "Graph construction") --------------
  const edges = [];
  for (const pkg of discovered) {
    for (const dependency of pkg.dependencies) {
      const target = byName.get(dependency.name);
      if (!target) {
        if (dependency.specifier.startsWith("workspace:")) {
          push({
            rule: "CHK",
            subject: pkg.dir,
            message: `declares \`${dependency.name}\`: "${dependency.specifier}" in ${dependency.field}, but no workspace package is named \`${dependency.name}\``,
            doc: `${CONTRACT_REL} §6`,
            fix: "fix the dependency name, or add the missing workspace package",
          });
        }
        continue;
      }
      if (target.dir === pkg.dir) continue;
      edges.push({
        from: pkg.dir,
        to: target.dir,
        fromName: pkg.name,
        toName: target.name,
        field: dependency.field,
        specifier: dependency.specifier,
      });
    }
  }

  // ---- rule 1: cycles (F9) ------------------------------------------------
  for (const cycle of findCycles([...dirs], edges)) {
    push({
      rule: "F9",
      subject: cycle[0],
      message: `circular package dependency: ${cycle.join(" -> ")}`,
      doc: `${CONTRACT_REL} §3 (F9), §6 rule 1; handoff §5.2 ("Circular package dependencies fail CI")`,
      fix: "break the cycle by extracting the shared code into a lower layer",
    });
  }

  // ---- rule 2: layer conformance (F12, F13) -------------------------------
  const allowlist = contract.sameLayerEdges;
  for (const edge of edges) {
    const fromLayer = layerOf.get(edge.from);
    const toLayer = layerOf.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined) continue; // already reported
    if (toLayer < fromLayer) continue;
    if (toLayer > fromLayer) {
      push({
        rule: "F12",
        subject: edge.from,
        message: `upward edge \`${edge.from}\` (layer ${fromLayer}) -> \`${edge.to}\` (layer ${toLayer}) via ${edge.field}; §5.2 permits only downward edges`,
        doc: `${CONTRACT_REL} §2, §3 (F12), §6 rule 2`,
        fix: "remove the dependency, or move the shared code into a layer below both packages",
      });
      continue;
    }
    const row = allowlist.find(
      (candidate) => matchesGlob(edge.from, candidate.from) && matchesGlob(edge.to, candidate.to),
    );
    if (!row) {
      push({
        rule: "F13",
        subject: edge.from,
        message: `same-layer edge \`${edge.from}\` -> \`${edge.to}\` (both layer ${fromLayer}) is not listed in §2.1`,
        doc: `${CONTRACT_REL} §2.1, §3 (F13), §6 rule 2`,
        fix: "add a cited §2.1 row naming the work-plan or handoff text that establishes the edge — never relax this check",
      });
      continue;
    }
    if (row.layer !== null && row.layer !== fromLayer) {
      push({
        rule: "CHK",
        subject: edge.from,
        message: `§2.1 row ${row.id} states layer ${row.layer}, but \`${edge.from}\` and \`${edge.to}\` are classified layer ${fromLayer} in §2`,
        doc: `${CONTRACT_REL} §2, §2.1`,
        fix: "correct the §2.1 row or the §2 assignment so they agree",
      });
    }
  }

  // ---- rule 3: forbidden specifier scan (F1–F8, F11) ----------------------
  const strategyClass = "packages/strategies/**";
  const packageOfPath = (candidate) => {
    let owner = null;
    for (const pkg of discovered) {
      if (candidate === pkg.dir || candidate.startsWith(`${pkg.dir}/`)) {
        if (owner === null || pkg.dir.length > owner.dir.length) owner = pkg;
      }
    }
    return owner;
  };

  for (const pkg of discovered) {
    const isDomain = pkg.dir === "packages/domain";
    const isStrategy = matchesGlob(pkg.dir, strategyClass);
    const isLedger = pkg.dir === "packages/ledger";
    const isSimulation = pkg.dir === "packages/simulation";
    const isSecureAdapter = pkg.dir === "packages/polymarket-secure";
    const isEventBus = pkg.dir === "packages/event-bus";

    for (const fileRel of collectSourceFiles(rootDir, pkg.dir)) {
      const scan = scanSourceFile(rootDir, fileRel);

      for (const { specifier, line } of scan.specifiers) {
        const at = `${fileRel}:${line}`;

        // Resolve the specifier to a workspace package where possible, so a
        // relative import that escapes the package is judged like a bare one.
        let targetPackage = byName.get(specifier) ?? null;
        if (!targetPackage) {
          const bare = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
          targetPackage = byName.get(bare) ?? null;
        }
        if (!targetPackage && isRelativeSpecifier(specifier)) {
          const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), specifier)));
          const owner = packageOfPath(resolved);
          if (owner && owner.dir !== pkg.dir) targetPackage = owner;
        }
        if (targetPackage && targetPackage.dir === pkg.dir) targetPackage = null;

        const targetIsStrategy = targetPackage !== null && matchesGlob(targetPackage.dir, strategyClass);
        const targetLayer = targetPackage ? layerOf.get(targetPackage.dir) : undefined;

        // F7 — archived Polymarket clients, anywhere.
        const archived = specifierMatchesAny(specifier, ARCHIVED_CLIENTS);
        if (archived) {
          push({
            rule: "F7",
            subject: pkg.dir,
            location: at,
            message: `imports archived Polymarket client \`${specifier}\`; the official migration guide instructs its removal`,
            doc: `${CONTRACT_REL} §3 (F7); docs/venue/verified-2026-08-24.md §1`,
            fix: `use the unified SDK \`${UNIFIED_SDK}\` inside packages/polymarket-secure`,
          });
        }

        // F6 — the unified SDK only inside packages/polymarket-secure.
        if (!isSecureAdapter && specifierMatches(specifier, UNIFIED_SDK)) {
          push({
            rule: "F6",
            subject: pkg.dir,
            location: at,
            message: `imports \`${specifier}\`; only \`packages/polymarket-secure\` may import the venue SDK`,
            doc: `${CONTRACT_REL} §3 (F6); handoff §9.12; ADR-010 §4`,
            fix: "call the secure adapter's interface instead of the SDK",
          });
        }

        // F8 — Redis clients only inside packages/event-bus.
        if (!isEventBus && !archived) {
          const redis = specifierMatchesAny(specifier, REDIS_CLIENTS);
          if (redis) {
            push({
              rule: "F8",
              subject: pkg.dir,
              location: at,
              message: `imports Redis client \`${specifier}\`; Redis is owned by \`packages/event-bus\``,
              doc: `${CONTRACT_REL} §3 (F8); ADR-003 §1`,
              fix: "depend on the event-bus transport interface instead of a Redis client",
            });
          }
        }

        // F1/F2 — packages/domain.
        if (isDomain) {
          if (isNodeBuiltin(specifier)) {
            push({
              rule: "F2",
              subject: pkg.dir,
              location: at,
              message: `imports Node built-in \`${specifier}\`; \`packages/domain\` may import no built-in at all`,
              doc: `${CONTRACT_REL} §3 (F2); docs/contracts/domain.md §2`,
              fix: "keep the value at the boundary type level, or move the code into a layer that owns I/O",
            });
          } else if (
            targetPackage !== null &&
            targetPackage.dir !== "packages/decimal"
          ) {
            push({
              rule: "F1",
              subject: pkg.dir,
              location: at,
              message: `imports workspace package \`${targetPackage.dir}\` via \`${specifier}\`; \`packages/domain\` may import only \`zod\` and \`@polymarket-bot/decimal\``,
              doc: `${CONTRACT_REL} §3 (F1); docs/contracts/domain.md §1, §2`,
              fix: "invert the dependency: the other package imports the contract, never the reverse",
            });
          } else {
            const forbidden =
              specifierMatchesAny(specifier, VENUE_SDKS) ??
              specifierMatchesAny(specifier, POSTGRES_CLIENTS) ??
              specifierMatchesAny(specifier, REDIS_CLIENTS) ??
              specifierMatchesAny(specifier, NETWORK_LIBRARIES);
            if (forbidden) {
              push({
                rule: "F1",
                subject: pkg.dir,
                location: at,
                message: `imports \`${specifier}\` (adapter/SDK/database/transport); \`packages/domain\` may import only \`zod\` and \`@polymarket-bot/decimal\``,
                doc: `${CONTRACT_REL} §3 (F1); docs/contracts/domain.md §1, §2`,
                fix: "move the code into the package that owns the connection",
              });
            }
          }
        }

        // F3 — packages/strategies/**.
        if (isStrategy) {
          let reason = null;
          if (isNodeBuiltin(specifier)) {
            const impure = IMPURE_BUILTINS.get(normalizeBuiltin(specifier));
            if (impure) reason = `${impure} built-in`;
          } else if (specifierMatchesAny(specifier, VENUE_SDKS)) reason = "venue client";
          else if (specifierMatchesAny(specifier, REDIS_CLIENTS)) reason = "Redis client";
          else if (specifierMatchesAny(specifier, POSTGRES_CLIENTS)) reason = "PostgreSQL client";
          else if (specifierMatchesAny(specifier, NETWORK_LIBRARIES)) reason = "network client";
          else if (targetLayer !== undefined && targetLayer >= 2) reason = "adapter/infrastructure package";
          if (reason) {
            push({
              rule: "F3",
              subject: pkg.dir,
              location: at,
              message: `imports \`${specifier}\` (${reason}); a strategy performs no I/O`,
              doc: `${CONTRACT_REL} §3 (F3); handoff §5.2, §6 invariant 2; ADR-005 §1`,
              fix: "receive the fact through a feature (§9.5) or a StrategyContext view (§7.6)",
            });
          }
        }

        // F4 — packages/ledger must not import a strategy implementation.
        if (isLedger && targetIsStrategy) {
          push({
            rule: "F4",
            subject: pkg.dir,
            location: at,
            message: `imports strategy implementation \`${targetPackage.dir}\` via \`${specifier}\``,
            doc: `${CONTRACT_REL} §3 (F4); handoff §5.2`,
            fix: "depend on the recorded decision/intent contracts, not on a strategy",
          });
        }

        // F5 — packages/simulation must not import a live signer.
        if (isSimulation) {
          const signer =
            specifierMatchesAny(specifier, SIGNER_LIBRARIES) ??
            (targetPackage?.dir === "packages/polymarket-secure" ? targetPackage.dir : undefined);
          if (signer) {
            push({
              rule: "F5",
              subject: pkg.dir,
              location: at,
              message: `imports \`${specifier}\` (live signer surface: ${signer}); a simulated venue that can reach a signer is not a simulation`,
              doc: `${CONTRACT_REL} §3 (F5); handoff §5.2; ADR-010 §4`,
              fix: "simulate fills behind the ExecutionVenue interface (§12.1)",
            });
          }
        }
      }

      // F11 — a strategy may not read a clock or unseeded randomness.
      if (isStrategy) {
        for (const hit of findGlobals(scan, IMPURE_GLOBALS)) {
          push({
            rule: "F11",
            subject: pkg.dir,
            location: `${fileRel}:${hit.line}`,
            message: `reads ${hit.what}; time comes from \`ctx.now()\` and randomness from \`ctx.rng()\``,
            doc: `${CONTRACT_REL} §3 (F11); handoff §6 invariant 2, §7.6; ADR-005 §1`,
            fix: "take the value from StrategyContext so replay stays deterministic",
          });
        }
      }

      // F1 — packages/domain may not touch a process global, clock, or randomness.
      if (isDomain) {
        for (const hit of findGlobals(scan, [...PROCESS_GLOBALS, ...IMPURE_GLOBALS])) {
          push({
            rule: "F1",
            subject: pkg.dir,
            location: `${fileRel}:${hit.line}`,
            message: `reads ${hit.what}; \`packages/domain\` is pure contract code`,
            doc: `${CONTRACT_REL} §3 (F1); docs/contracts/domain.md §2`,
            fix: "pass the value in as a boundary-typed argument",
          });
        }
      }
    }
  }

  const packages = discovered.map((pkg) => ({
    dir: pkg.dir,
    name: pkg.name,
    layer: layerOf.has(pkg.dir) ? layerOf.get(pkg.dir) : null,
  }));

  return {
    ok: violations.length === 0,
    violations,
    packages,
    edges: edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      field: edge.field,
      specifier: edge.specifier,
    })),
    allowlist: allowlist.map((row) => ({ id: row.id, from: row.from, to: row.to, layer: row.layer })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function formatReport(result, rootDir) {
  const lines = [];
  const counts = new Map();
  for (const item of result.violations) {
    counts.set(item.rule, (counts.get(item.rule) ?? 0) + 1);
  }

  lines.push(`dependency-direction check (${CONTRACT_REL} §6)`);
  lines.push(`  root:       ${rootDir}`);
  lines.push(
    `  contract:   §2 assignments applied to ${result.packages.length} workspace packages; §2.1 permitted same-layer edges: ${result.allowlist
      .map((row) => `${row.id} ${row.from} -> ${row.to}`)
      .join(", ") || "none"}`,
  );
  lines.push(
    `  graph:      ${result.packages.length} packages (workspace root manifest excluded per §6), ${result.edges.length} declared workspace edges`,
  );
  lines.push("");

  if (result.violations.length === 0) {
    lines.push("PASS: no cycle (F9), no upward edge (F12), no unlisted same-layer edge (F13),");
    lines.push("      no forbidden import specifier (F1-F8, F11), every workspace package classified.");
    return `${lines.join("\n")}\n`;
  }

  for (const item of result.violations) {
    lines.push(`FAIL [${item.rule}] ${item.subject}${item.location ? ` (${item.location})` : ""}`);
    lines.push(`       ${item.message}`);
    lines.push(`  doc: ${item.doc}`);
    if (item.fix) lines.push(`  fix: ${item.fix}`);
    lines.push("");
  }
  const summary = [...counts.entries()].map(([rule, count]) => `${rule}x${count}`).join(", ");
  lines.push(`FAILED: ${result.violations.length} violation(s) [${summary}]`);
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const options = { root: path.resolve(here, ".."), json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root requires a directory argument");
      options.root = path.resolve(value);
      i += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = path.resolve(arg.slice("--root=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const USAGE = `Usage: node tools/check-dependency-direction.mjs [--root <dir>] [--json]

Enforces docs/contracts/dependency-direction.md §6:
  F9        no circular workspace dependency
  F12/F13   no upward edge; same-layer edges only when listed in §2.1
  F1-F8,F11 no forbidden import specifier or non-deterministic global
Fails closed on an unclassified workspace package and on a §2 entry with no
manifest. Exits 0 when clean, 1 on any violation, 2 on a usage error.
`;

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const result = runCheck(options.root);
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result, options.root));
  process.exitCode = result.ok ? 0 : 1;
}

main();
