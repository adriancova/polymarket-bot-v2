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
 * The parsed contract is validated **eagerly**, before any edge is evaluated:
 * every §2.1 data row must parse into an edge, must carry a numeric layer, and
 * must name packages/classes that §2 classifies at that same layer; no §2
 * pattern may be assigned twice. A contract edit that breaks any of those is a
 * `CHK` error, not a skipped row. That is what makes the parse fail *closed*
 * rather than quietly shrinking coverage.
 *
 * Rules implemented (see `docs/contracts/dependency-direction.md` §3, §6):
 *   1. F9  — no cycle in the workspace dependency graph, including the
 *      degenerate self-cycle of a package that declares itself.
 *   2. F12 — no edge from a lower-numbered layer to a higher-numbered one.
 *      F13 — a same-layer edge must be listed in §2.1.
 *      Fail closed on an unclassified workspace package, and on a named §2
 *      entry with no manifest (§6 "fails closed" bullets).
 *   3. F1–F8, F11 — forbidden import specifiers and non-deterministic globals,
 *      scanned in package source (a bare `node:` import appears in no
 *      dependency list, so `package.json` cannot see it).
 *
 * Two non-contract rule ids appear in output alongside F1–F13:
 *   - `F-CLOSED` — the §6 fail-closed bullets (classification/mirror).
 *   - `F-OPAQUE` — a dynamic `import()` in a purity-restricted package whose
 *     specifier is not a static literal (an interpolated template, a variable,
 *     a concatenation). Such a specifier defeats static checking entirely, so
 *     inside `packages/domain`, `packages/strategies/**`, `packages/ledger`,
 *     and `packages/simulation` it is itself a finding rather than a silent
 *     pass. Elsewhere it is allowed (composition roots legitimately load
 *     modules by name); see `docs/handoffs/WP-015.md` for that trade-off.
 *
 * How source is read (this matters for both false negatives and false
 * positives). `lexSource` runs one pass that tracks code / line comment /
 * block comment / single- and double-quoted string / template literal /
 * regular-expression literal, with `${...}` re-entering code so that
 * `` `${Math.random()}` `` is still real code. It returns:
 *   - `code`: the file with the *contents* of comments, strings, templates and
 *     regex literals replaced by spaces, offsets and newlines preserved, so
 *     reported line numbers match the original file. Global/identifier
 *     patterns are matched against this, so prose or data that merely mentions
 *     `node:fs` or `Math.random()` cannot trip the check.
 *   - `literals`: every string/template literal with its span, its static
 *     value (or `null` when interpolated), and whether it interpolates.
 * Import specifiers are then taken from `literals` whose *preceding code*
 * places them in specifier position (`from`, bare `import`, `import(`,
 * `require(`). A specifier is therefore recognised in a template literal —
 * `` import(`node:fs`) `` is caught — while the same text in an ordinary
 * string is not a specifier and is not scanned.
 *
 * KNOWN LIMIT — the library catalogues below (`REDIS_CLIENTS`,
 * `DATABASE_CLIENTS`, `VENUE_SDKS`, `SIGNER_LIBRARIES`, `NETWORK_LIBRARIES`,
 * `FILESYSTEM_LIBRARIES`) are **enumerations, not classifications**. They name
 * the packages known today; a filesystem, database, network or signing library
 * that is not listed is not caught by rule 3. There is no mechanical way to
 * decide "is this npm package a filesystem wrapper" from its name, so this is a
 * floor, not a ceiling. The compensating controls are that adding any
 * dependency to an owned package is a reviewed, lockfile-touching event
 * (contract §7) and that a workspace edge to an adapter package is still caught
 * by rule 2. Extend these lists when a new library enters the repository.
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

/**
 * Every manifest field that can declare a workspace edge. `optionalDependencies`
 * is included because pnpm links it exactly like `dependencies`: an optional
 * workspace dependency is a real edge and omitting the field let an upward edge
 * through (WP-015 review round 1, MEDIUM-1).
 */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
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

/**
 * F1/F3: database clients. F1/F3 name PostgreSQL specifically; ADR-005 §1 says
 * "database", so the wider set is used and any of them is a finding in a
 * restricted package. Enumeration, not a classification — see the header's
 * KNOWN LIMIT note.
 */
const DATABASE_CLIENTS = [
  "pg",
  "pg-native",
  "pg-promise",
  "postgres",
  "slonik",
  "@databases/pg",
  "@vercel/postgres",
  "knex",
  "sequelize",
  "typeorm",
  "drizzle-orm",
  "@prisma/client",
  "better-sqlite3",
  "sqlite3",
  "mysql",
  "mysql2",
  "mongodb",
  "mongoose",
];

/**
 * F3: filesystem access through a library rather than `node:fs`. ADR-005 §1
 * forbids filesystem I/O, and `fs-extra`/`graceful-fs`/`chokidar` reach the
 * filesystem without ever naming a `node:` builtin (WP-015 review round 1,
 * HIGH(d)). Enumeration, not a classification — see the header's KNOWN LIMIT
 * note.
 */
const FILESYSTEM_LIBRARIES = [
  "fs-extra",
  "graceful-fs",
  "chokidar",
  "memfs",
  "glob",
  "fast-glob",
  "globby",
  "rimraf",
  "mkdirp",
  "del",
  "tmp",
  "write-file-atomic",
  "find-up",
  "load-json-file",
  "read-pkg",
  "cpy",
  "trash",
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

/**
 * F1 (clock/randomness in `packages/domain`) / F11 (clock and unseeded
 * randomness in a strategy). Matched against lexed code, so the same text in a
 * comment or a string literal is not a hit.
 *
 * `Date` is read three ways and all three are here: `Date.now()`, `new Date()`
 * with no argument, and a **bare `Date(...)` call**, which returns the current
 * time as a string regardless of its arguments and was the gap the round-1
 * review found (HIGH(b)). `new Date(<argument>)` is deliberately *not* matched:
 * constructing a date from a value the caller already has is deterministic.
 */
const IMPURE_GLOBALS = [
  { pattern: /\bDate\s*\.\s*now\s*\(/g, what: "clock (`Date.now()`)" },
  { pattern: /new\s+Date\s*\(\s*\)/g, what: "clock (`new Date()`)" },
  { pattern: /(?<![.$\w])(?<!\bnew\s{1,64})Date\s*\(/g, what: "clock (`Date()`)" },
  { pattern: /\bperformance\s*\.\s*now\s*\(/g, what: "clock (`performance.now()`)" },
  { pattern: /\bprocess\s*\.\s*hrtime\b/g, what: "clock (`process.hrtime`)" },
  { pattern: /\bMath\s*\.\s*random\s*\(/g, what: "unseeded randomness (`Math.random()`)" },
  {
    pattern: /\bcrypto\s*\.\s*(?:randomUUID|getRandomValues|randomBytes)\s*\(/g,
    what: "unseeded randomness (`crypto` random)",
  },
];

/** F1/F3: process and environment globals (ADR-005 §1 "environment"). */
const PROCESS_GLOBALS = [
  { pattern: /\bprocess\s*\.\s*[A-Za-z_$]/g, what: "process global (`process.*`)" },
  { pattern: /\bglobalThis\b/g, what: "process global (`globalThis`)" },
  { pattern: /\bimport\s*\.\s*meta\b/g, what: "module environment (`import.meta`)" },
];

/**
 * F1/F3: network reachable through a global, with no import to catch
 * (WP-015 review round 1, HIGH(c)). `node:http`, `node:https`, `node:net`,
 * `node:tls`, `node:dgram` and `node:dns` have no global form — they can only
 * be imported — so they are covered by `IMPURE_BUILTINS` above and are not
 * repeated here.
 */
const NETWORK_GLOBALS = [
  { pattern: /(?<![.$\w])fetch\s*\(/g, what: "network (`fetch()`)" },
  { pattern: /(?<![.$\w])WebSocket\s*\(/g, what: "network (`WebSocket`)" },
  { pattern: /(?<![.$\w])XMLHttpRequest\s*\(/g, what: "network (`XMLHttpRequest`)" },
  { pattern: /(?<![.$\w])EventSource\s*\(/g, what: "network (`EventSource`)" },
  { pattern: /\bnavigator\s*\.\s*sendBeacon\s*\(/g, what: "network (`navigator.sendBeacon()`)" },
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

function isTableSeparatorRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const cells = trimmed.split("|").map((cell) => cell.trim());
  cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  if (isTableSeparatorRow(line)) return null;
  const cells = trimmed.split("|").map((cell) => cell.trim());
  cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function parseContract(text) {
  const lines = text.split(/\r?\n/);
  const assignments = [];
  const sameLayerEdges = [];
  const problems = [];

  let currentLayer = null;
  let inFence = false;
  let pastAllowlistHeader = false;

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
      pastAllowlistHeader = false;
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
      // Every row after the header separator is a data row and MUST parse. A
      // silently skipped row is a silently dropped allowlist entry, which is a
      // fail-open hole (WP-015 review round 1, LOW).
      if (isTableSeparatorRow(line)) {
        pastAllowlistHeader = true;
        continue;
      }
      const cells = splitTableRow(line);
      if (!cells) continue; // prose between/after the table
      if (!pastAllowlistHeader) continue; // the header row itself
      const rowLabel = `${CONTRACT_REL} §2.1 row at line ${index + 1}`;
      if (cells.length < 3) {
        problems.push(`${rowLabel} has ${cells.length} cell(s); an allowlist row needs "# | Edge | Layer | Basis".`);
        continue;
      }
      const [id, edgeCell, layerCell] = cells;
      const edge = edgeCell.match(/`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/);
      if (!edge) {
        problems.push(
          `${rowLabel} ("${id.replace(/`/g, "")}") does not state an edge as \`from\` → \`to\`; the row cannot be applied and is not silently skipped.`,
        );
        continue;
      }
      if (!/^\d+$/.test(layerCell)) {
        problems.push(`${rowLabel} ("${id.replace(/`/g, "")}") has a non-numeric layer cell "${layerCell}".`);
        continue;
      }
      sameLayerEdges.push({
        id: id.replace(/`/g, ""),
        from: edge[1],
        to: edge[2],
        layer: Number(layerCell),
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

  // §2: "Every workspace package belongs to exactly one layer. No package
  // appears twice." A repeat is an error even when both rows agree on the
  // layer, because a duplicate row is how the table drifts out of being a
  // total, single-valued function (WP-015 review round 1, LOW).
  const byPattern = new Map();
  for (const assignment of assignments) {
    const existing = byPattern.get(assignment.pattern);
    if (existing) {
      problems.push(
        existing.layer === assignment.layer
          ? `${CONTRACT_REL} §2 lists \`${assignment.pattern}\` twice (lines ${existing.line} and ${assignment.line}), both in layer ${assignment.layer}; §2 requires that no package appear twice.`
          : `${CONTRACT_REL} §2 assigns \`${assignment.pattern}\` to layer ${existing.layer} (line ${existing.line}) and layer ${assignment.layer} (line ${assignment.line}); §2 requires exactly one layer per package.`,
      );
      continue;
    }
    byPattern.set(assignment.pattern, assignment);
  }

  const seenIds = new Set();
  for (const edge of sameLayerEdges) {
    if (seenIds.has(edge.id)) {
      problems.push(`${CONTRACT_REL} §2.1 repeats row id "${edge.id}" (line ${edge.line}).`);
    }
    seenIds.add(edge.id);
  }

  // Cross-validate §2.1 against §2 now, not only when a live edge happens to
  // match a row. A row naming an unclassified package, or stating a layer §2
  // disagrees with, is a broken contract whether or not the repository
  // currently declares that edge (WP-015 review round 1, LOW).
  const resolved = [...byPattern.values()];
  for (const edge of sameLayerEdges) {
    for (const [role, token] of [
      ["`from` endpoint", edge.from],
      ["`to` endpoint", edge.to],
    ]) {
      const layers = layersForContractToken(token, resolved);
      if (layers.length === 0) {
        problems.push(
          `${CONTRACT_REL} §2.1 row "${edge.id}" (line ${edge.line}) names \`${token}\` as its ${role}, but §2 classifies no package or class matching it.`,
        );
      } else if (layers.length > 1) {
        problems.push(
          `${CONTRACT_REL} §2.1 row "${edge.id}" (line ${edge.line}) names \`${token}\` as its ${role}, which §2 classifies in more than one layer (${layers.join(", ")}).`,
        );
      } else if (layers[0] !== edge.layer) {
        problems.push(
          `${CONTRACT_REL} §2.1 row "${edge.id}" (line ${edge.line}) states layer ${edge.layer}, but §2 classifies its ${role} \`${token}\` in layer ${layers[0]}.`,
        );
      }
    }
  }

  return {
    assignments: resolved,
    sameLayerEdges,
    problems,
  };
}

/**
 * Resolves a §2.1 token — which may be a concrete path or a class glob such as
 * `packages/strategies/*` — to the §2 layer(s) it denotes. A class token and a
 * §2 class entry need not be written identically (§2 states the strategy class
 * as `packages/strategies/**`, §2.1 as `packages/strategies/*`), so each is
 * tested for coverage of the other.
 */
function layersForContractToken(token, assignments) {
  const exact = assignments.filter((entry) => entry.pattern === token);
  if (exact.length > 0) return [...new Set(exact.map((entry) => entry.layer))];
  if (!isGlob(token)) {
    const found = classify(token, assignments);
    if (found === null) return [];
    if (found.ambiguous) return [...new Set(found.ambiguous.map((entry) => entry.layer))];
    return [found.layer];
  }
  const related = assignments.filter(
    (entry) => matchesGlob(entry.pattern, token) || matchesGlob(token, entry.pattern),
  );
  return [...new Set(related.map((entry) => entry.layer))];
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
 * Keywords after which a `/` starts a regular-expression literal rather than a
 * division. Used with the previous significant character to disambiguate.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function regexCanStartHere(previousChar, previousWord) {
  if (previousChar === "") return true; // start of file
  if (previousWord !== "" && REGEX_PRECEDING_KEYWORDS.has(previousWord)) return true;
  if (/[\w$)\]]/.test(previousChar)) return false; // value ended -> division
  return true;
}

/** Minimal unescaping, enough for module specifiers. */
function unescapeLiteral(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_all, code) => {
    if (code.startsWith("u{")) return String.fromCodePoint(Number.parseInt(code.slice(2, -1), 16));
    if (code.startsWith("u")) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    if (code.startsWith("x")) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
    return Object.prototype.hasOwnProperty.call(simple, code) ? simple[code] : code;
  });
}

/**
 * Single-pass lexer over a source file.
 *
 * Returns `{ code, literals }` where `code` is the file with the *contents* of
 * comments, string literals, template literals and regular-expression literals
 * replaced by spaces — offsets and newlines preserved, so a match's line number
 * in `code` is its line number in the original file — and `literals` is every
 * string/template literal with its span and static value.
 *
 * Blanking literal contents is what stops `` const a = `from "node:fs"` `` and
 * `` `Math.random()` `` from being reported as F3/F11 findings (WP-015 review
 * round 1, MEDIUM-2). Import specifiers are not lost by this, because they are
 * recovered from `literals` rather than from `code` (see `specifiersFrom`).
 *
 * A template's `${...}` sections re-enter code state, so interpolated
 * expressions are still scanned: `` `${Math.random()}` `` is a real clock/RNG
 * read and is still caught.
 */
function lexSource(source) {
  const out = source.split("");
  const literals = [];
  /** Context stack; `${` inside a template pushes a fresh code context. */
  const stack = [{ kind: "code", brace: 0 }];
  let previousChar = "";
  let previousWord = "";
  let wordOpen = false;

  const blank = (index) => {
    if (source[index] !== "\n") out[index] = " ";
  };

  let i = 0;
  while (i < source.length) {
    const context = stack[stack.length - 1];
    const char = source[i];
    const next = source[i + 1];

    if (context.kind === "template") {
      if (char === "\\") {
        blank(i);
        if (i + 1 < source.length) blank(i + 1);
        i += 2;
        continue;
      }
      if (char === "$" && next === "{") {
        context.interpolated = true;
        stack.push({ kind: "code", brace: 0 });
        i += 2;
        continue;
      }
      if (char === "`") {
        stack.pop();
        literals.push({
          start: context.start,
          end: i,
          kind: "template",
          interpolated: context.interpolated,
          value: context.interpolated ? null : unescapeLiteral(source.slice(context.start + 1, i)),
        });
        previousChar = "`";
        previousWord = "";
        wordOpen = false;
        i += 1;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }

    // context.kind === "code"
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        blank(i);
        i += 1;
      }
      if (i < source.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          blank(i);
          if (i + 1 < source.length) blank(i + 1);
          i += 2;
          continue;
        }
        if (source[i] === char || source[i] === "\n") break;
        blank(i);
        i += 1;
      }
      const closed = i < source.length && source[i] === char;
      literals.push({
        start,
        end: closed ? i : i - 1,
        kind: "string",
        interpolated: false,
        value: unescapeLiteral(source.slice(start + 1, i)),
      });
      if (closed) i += 1;
      previousChar = char;
      previousWord = "";
      wordOpen = false;
      continue;
    }
    if (char === "`") {
      stack.push({ kind: "template", start: i, interpolated: false });
      i += 1;
      continue;
    }
    if (char === "/" && regexCanStartHere(previousChar, previousWord)) {
      // Regex literals cannot span a line. If no unescaped `/` closes on this
      // line, treat the character as division and blank nothing: that keeps a
      // misjudged `/` from swallowing code (which would fail open).
      let j = i + 1;
      let inClass = false;
      let closedAt = -1;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) {
          closedAt = j;
          break;
        }
        j += 1;
      }
      if (closedAt > 0) {
        for (let k = i + 1; k < closedAt; k += 1) blank(k);
        i = closedAt + 1;
        while (i < source.length && /[dgimsuvy]/.test(source[i])) i += 1; // flags
        previousChar = "/";
        previousWord = "";
        wordOpen = false;
        continue;
      }
    }
    if (char === "{") context.brace += 1;
    else if (char === "}") {
      if (context.brace === 0 && stack.length > 1) {
        stack.pop(); // close a template's `${ ... }` and resume the template
        i += 1;
        continue;
      }
      context.brace -= 1;
    }
    if (/\s/.test(char)) {
      wordOpen = false; // the identifier ended but is still the previous word
    } else if (/[\w$]/.test(char)) {
      previousWord = wordOpen ? previousWord + char : char;
      wordOpen = true;
      previousChar = char;
    } else {
      previousWord = "";
      wordOpen = false;
      previousChar = char;
    }
    i += 1;
  }

  return { code: out.join(""), literals };
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

/**
 * A literal is a module specifier when the code immediately before it is one of
 * these forms. Matching on the *preceding* code (rather than on the literal's
 * own text) is what lets a template literal be a specifier —
 * `` import(`node:fs`) `` is caught (WP-015 review round 1, HIGH(a)) — while an
 * identical-looking template elsewhere in the file is left alone (MEDIUM-2).
 *
 * `from` covers `import … from`, `import type … from` and `export … from`;
 * `require` covers both CommonJS and TypeScript's `import x = require(…)`.
 */
const SPECIFIER_CONTEXTS = [
  /\bfrom\s*$/,
  /(?<![.$\w])import\s*\(\s*$/,
  /(?<![.$\w])require\s*\(\s*$/,
  /(?<![.$\w])import\s*$/,
];

/** How far back to look for the specifier context. */
const SPECIFIER_LOOKBEHIND = 96;

/**
 * A dynamic `import(` whose argument is not a static literal. `import` is a
 * reserved word, so `import(` is unambiguously a dynamic import — unlike
 * `require(`, which may be any function (`packages/domain`'s schema registry
 * has a `require(eventType, schemaVersion)` method), and which is therefore
 * deliberately not matched here.
 */
const DYNAMIC_IMPORT_CALL = /(?<![.$\w])import\s*\(\s*/g;

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

function isSpecifierPosition(code, literalStart) {
  const prefix = code.slice(Math.max(0, literalStart - SPECIFIER_LOOKBEHIND), literalStart);
  return SPECIFIER_CONTEXTS.some((pattern) => pattern.test(prefix));
}

function scanSourceFile(rootDir, fileRel) {
  const raw = readFileSync(path.join(rootDir, fileRel), "utf8");
  const { code, literals } = lexSource(raw);
  const starts = lineStarts(raw);

  const specifiers = [];
  const literalStarts = new Map();
  for (const literal of literals) {
    literalStarts.set(literal.start, literal);
    if (!isSpecifierPosition(code, literal.start)) continue;
    if (literal.interpolated || literal.value === null) continue; // reported below
    specifiers.push({ specifier: literal.value, line: lineNumberAt(starts, literal.start) });
  }

  // Dynamic imports whose specifier is not statically knowable.
  const opaqueImports = [];
  DYNAMIC_IMPORT_CALL.lastIndex = 0;
  let call = DYNAMIC_IMPORT_CALL.exec(code);
  while (call !== null) {
    const argumentStart = call.index + call[0].length;
    const literal = literalStarts.get(argumentStart);
    if (!literal || literal.interpolated || literal.value === null) {
      opaqueImports.push({
        line: lineNumberAt(starts, call.index),
        form: literal?.interpolated ? "an interpolated template literal" : "a non-literal expression",
      });
    }
    call = DYNAMIC_IMPORT_CALL.exec(code);
  }

  return { code, starts, specifiers, opaqueImports };
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
      // A package that declares itself is a self-cycle. It used to be
      // discarded here; §5.2 says "Circular package dependencies fail CI" and a
      // one-node cycle is a cycle, so the edge is kept and rule 1 reports it
      // (WP-015 review round 1, MEDIUM-1).
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
    const isSelf = cycle.length === 2 && cycle[0] === cycle[1];
    push({
      rule: "F9",
      subject: cycle[0],
      message: isSelf
        ? `circular package dependency: \`${cycle[0]}\` declares itself as a dependency`
        : `circular package dependency: ${cycle.join(" -> ")}`,
      doc: `${CONTRACT_REL} §3 (F9), §6 rule 1; handoff §5.2 ("Circular package dependencies fail CI")`,
      fix: isSelf
        ? "remove the self-referential dependency entry from the package manifest"
        : "break the cycle by extracting the shared code into a lower layer",
    });
  }

  // ---- rule 2: layer conformance (F12, F13) -------------------------------
  const allowlist = contract.sameLayerEdges;
  for (const edge of edges) {
    if (edge.from === edge.to) continue; // reported as a self-cycle by rule 1
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
    /** Packages carrying a package-scoped purity rule (F1/F2, F3/F11, F4, F5). */
    const isPurityRestricted = isDomain || isStrategy || isLedger || isSimulation;

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
              specifierMatchesAny(specifier, DATABASE_CLIENTS) ??
              specifierMatchesAny(specifier, REDIS_CLIENTS) ??
              specifierMatchesAny(specifier, NETWORK_LIBRARIES) ??
              specifierMatchesAny(specifier, FILESYSTEM_LIBRARIES);
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
          else if (specifierMatchesAny(specifier, DATABASE_CLIENTS)) reason = "database client";
          else if (specifierMatchesAny(specifier, NETWORK_LIBRARIES)) reason = "network client";
          else if (specifierMatchesAny(specifier, FILESYSTEM_LIBRARIES)) reason = "filesystem library";
          else if (specifierMatchesAny(specifier, SIGNER_LIBRARIES)) reason = "signing library";
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
        // F3 — ADR-005 §1's list is "network, database, filesystem,
        // environment, global clock, or unseeded randomness". The clock and
        // randomness halves are F11 above; environment and network are reachable
        // through globals with no import to catch, so they are scanned here
        // (WP-015 review round 1, HIGH(c)).
        for (const hit of findGlobals(scan, [...PROCESS_GLOBALS, ...NETWORK_GLOBALS])) {
          push({
            rule: "F3",
            subject: pkg.dir,
            location: `${fileRel}:${hit.line}`,
            message: `reads ${hit.what}; a strategy performs no I/O and reads no environment`,
            doc: `${CONTRACT_REL} §3 (F3); handoff §5.2, §6 invariant 2; ADR-005 §1`,
            fix: "receive the fact through a feature (§9.5) or a StrategyContext view (§7.6)",
          });
        }
      }

      // F1 — packages/domain may not touch a process global, clock, or randomness.
      if (isDomain) {
        for (const hit of findGlobals(scan, [...PROCESS_GLOBALS, ...IMPURE_GLOBALS, ...NETWORK_GLOBALS])) {
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

      // F-OPAQUE — a dynamic import a static check cannot read. Restricted to
      // the packages whose whole point is a purity constraint; elsewhere a
      // composition root may legitimately load a module by computed name.
      if (isPurityRestricted) {
        for (const hit of scan.opaqueImports) {
          push({
            rule: "F-OPAQUE",
            subject: pkg.dir,
            location: `${fileRel}:${hit.line}`,
            message: `uses a dynamic \`import()\` whose specifier is ${hit.form}; in \`${pkg.dir}\` the imported module must be statically readable, or rules F1-F8/F11 cannot be evaluated at all`,
            doc: `${CONTRACT_REL} §6 rule 3; ADR-005 §1`,
            fix: "import the module statically, or receive the capability through StrategyContext/a constructor argument",
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
    lines.push("      no forbidden import specifier or impure global (F1-F8, F11), no opaque");
    lines.push("      dynamic import in a restricted package, every workspace package classified.");
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
  F9        no circular workspace dependency (including a self-cycle)
  F12/F13   no upward edge; same-layer edges only when listed in §2.1
  F1-F8,F11 no forbidden import specifier or non-deterministic global
  F-CLOSED  §6 fail-closed: unclassified package, or §2 entry with no manifest
  F-OPAQUE  no dynamic import() with a non-static specifier in a package whose
            purity is constrained (domain, strategies, ledger, simulation)
The §2 layer table and the §2.1 allowlist are parsed from the contract and
validated eagerly; an unparseable or inconsistent row is a CHK error, not a
skipped row. Exits 0 when clean, 1 on any violation, 2 on a usage error.
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
