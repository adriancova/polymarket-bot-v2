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
 *   - `F-OPAQUE` — a construct that makes F1–F8/F11 unevaluable inside a
 *     purity-restricted package: a dynamic `import()` or a global `require()`
 *     whose specifier is not a static literal (an interpolated template, a
 *     variable, a concatenation), or a reference to `eval`/`Function`. Each
 *     defeats static checking entirely, so inside `packages/domain`,
 *     `packages/strategies/**`, `packages/ledger`, and `packages/simulation`
 *     it is itself a finding rather than a silent pass. Elsewhere it is
 *     allowed (composition roots legitimately load modules by name); see
 *     `docs/handoffs/WP-015.md` for that trade-off.
 *
 * How source is read. Rule 3 uses the **TypeScript compiler API**
 * (`ts.createSourceFile` + a full AST walk); there is no regular expression
 * over source text anywhere in it. `typescript` is already a root
 * devDependency and this tool runs after `pnpm install` in dev and CI, so this
 * adds no dependency and does not touch the lockfile; if it cannot be resolved
 * the check emits a `CHK` error and exits non-zero rather than scanning
 * nothing. Comments and string data are inert in an AST, so text that merely
 * *mentions* `node:fs` or `Math.random()` is structurally incapable of
 * producing a finding, and a specifier is recognised wherever the grammar puts
 * one regardless of intervening trivia. What the walk collects:
 *
 *   - **Module specifiers** (exact, position-independent): `ImportDeclaration`
 *     and `ExportDeclaration` module specifiers (so `export * from "x"` counts),
 *     `import x = require("x")` external module references, `import("x")` type
 *     nodes, dynamic `import(...)`, and `require(...)` where the callee is the
 *     identifier `require` and that identifier is *not* declared in an
 *     enclosing scope of the file. A string literal or a
 *     no-substitution template literal is a specifier; anything else is
 *     `F-OPAQUE` in a purity-restricted package. A locally declared `require`
 *     (a function, a parameter, an import) is not a module load; a *method*
 *     call such as `registry.require(eventType, version)` is not one either,
 *     because its callee is a property access rather than the bare identifier.
 *   - **Impure globals** in `packages/domain` (F1) and `packages/strategies/**`
 *     (F3/F11), detected by *identifier reference* rather than by call
 *     spelling. See `GLOBAL_ROOTS` below for the exact semantics.
 *   - **Syntax errors**, reported as `CHK`. The parser recovers from a broken
 *     file and returns a partial tree; scanning that tree and reporting nothing
 *     would be a silent coverage hole, so an unparseable file fails the run.
 *
 * KNOWN LIMIT — AST semantics, stated precisely so the boundaries are testable:
 *   - **"Global" means "not declared in this file."** The walk maintains a
 *     scope stack (source file, block, module block, `case` block, every
 *     function-like node with its parameters and type parameters, class
 *     declarations/expressions, `for`/`for-in`/`for-of` initialisers, and
 *     `catch` clauses) whose names are hoisted on scope entry from that scope's
 *     statement-level declarations. If an enclosing scope declares the name,
 *     the reference is shadowed and is **not** a finding —
 *     `function f(Date: string) { return Date; }` is clean. There is no type
 *     checker and no cross-file resolution, so a `var` declared inside a nested
 *     block and used in an outer scope is *not* seen as a shadow: that direction
 *     produces a spurious finding naming an exact `file:line`, never a silent
 *     pass.
 *   - **Type positions are not value references.** The walk does not descend
 *     into type nodes, so `const d: Date = ...` and `typeof process` are not
 *     findings; `import("node:fs")` *type* nodes are still collected as
 *     specifiers, and a heritage clause's expression (`class X extends Date`)
 *     is still walked as a value.
 *   - **`new Date(arg, ...)` with at least one argument is deliberately
 *     allowed**: constructing a date from a value the caller already holds is
 *     deterministic. Every other reference to `Date` is a finding, including a
 *     bare one used as a value (`const D = Date`), because ADR-005 §1's
 *     prohibition is absolute and an alias defeats any call-shape check.
 *   - `globalThis.X`, `window.X`, `self.X` and `global.X` (dotted or with a
 *     string index) are resolved to a reference to global `X`, so
 *     `window.Date()` is the same finding as `Date()`; the environment root
 *     itself is additionally reported.
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
 * No network and no credentials. The only module loaded outside Node's
 * built-ins is `typescript`, which the repository already installs.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * Families of impure global. The family selects the rule id: clock and
 * randomness are F11 in a strategy (contract §3), environment and network are
 * F3 (ADR-005 §1's I/O list); inside `packages/domain` all four are F1.
 */
const CLOCK = "clock";
const RANDOMNESS = "randomness";
const ENVIRONMENT = "environment";
const NETWORK = "network";

/**
 * Roots whose property access is unwrapped: `globalThis.Date`, `window.Date`,
 * `self.Date` and `global.Date` are references to the global `Date`. Round 2
 * found `window.Date()` passing because the old catalogue matched call
 * spellings rather than references.
 */
const ENVIRONMENT_ROOTS = new Set(["globalThis", "window", "self", "global"]);

/** `crypto` members that are unseeded randomness by name. */
const CRYPTO_RANDOM_MEMBERS = new Set([
  "randomUUID",
  "getRandomValues",
  "randomBytes",
  "randomInt",
  "randomFill",
  "randomFillSync",
]);

/**
 * Globals that evaluate code the checker cannot read. A reference to one of
 * them inside a purity-restricted package is `F-OPAQUE` for the same reason a
 * computed `import()` specifier is: whatever they evaluate is unevaluable by
 * F1-F8/F11.
 */
const EVALUATORS = new Set(["eval", "Function"]);

/**
 * The global identifiers rule 3 rejects inside a purity-restricted package,
 * and every global root the scanner knows about. `classifyGlobalUse` below is
 * the single place that decides what a *reference* to one of them means.
 */
const GLOBAL_ROOTS = new Set([
  "Date",
  "Math",
  "performance",
  "crypto",
  "process",
  "navigator",
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "EventSource",
  "setTimeout",
  "setInterval",
  "setImmediate",
  ...ENVIRONMENT_ROOTS,
]);

/**
 * F1 (`packages/domain`) / F3 and F11 (`packages/strategies/**`): what a
 * reference to a global name means.
 *
 * `use` describes the *reference*, not a text pattern: `member` is the property
 * read off it (`Date.now` → `"now"`), `isCalled`/`isNew` say whether the
 * resulting value is immediately called or constructed, and `argumentCount` is
 * that call's arity.
 *
 * Detecting by reference is what closes the round-2 aliasing bypasses: a bare
 * `Date` (`const D = Date; D()`) is a finding because ADR-005 §1's prohibition
 * is absolute and no call-shape check survives an alias. The single deliberate
 * exception is `new Date(argument, ...)`, which is deterministic.
 *
 * `Math` is the one root with a pure majority, so only `Math.random` and a bare
 * `Math` reference (which can reach `random` through an alias or a destructure)
 * are findings; `Math.max(a, b)` is not.
 */
function classifyGlobalUse(name, use) {
  switch (name) {
    case "Date":
      if (use.member === "now") return { family: CLOCK, what: "clock (`Date.now()`)" };
      if (use.isNew) {
        return use.argumentCount >= 1 ? null : { family: CLOCK, what: "clock (`new Date()`)" };
      }
      if (use.isCalled && use.member === null) return { family: CLOCK, what: "clock (`Date()`)" };
      if (use.member !== null) return { family: CLOCK, what: `clock (\`Date.${use.member}\`)` };
      return { family: CLOCK, what: "clock (`Date` reference, which can be aliased and called later)" };
    case "Math":
      if (use.member === "random") return { family: RANDOMNESS, what: "unseeded randomness (`Math.random()`)" };
      if (use.member === null) {
        return {
          family: RANDOMNESS,
          what: "unseeded randomness (`Math` reference, from which `Math.random` is reachable)",
        };
      }
      return null;
    case "performance":
      if (use.member === "now") return { family: CLOCK, what: "clock (`performance.now()`)" };
      if (use.member === null) return { family: CLOCK, what: "clock (`performance` reference)" };
      return { family: CLOCK, what: `clock (\`performance.${use.member}\`)` };
    case "crypto":
      if (use.member !== null && CRYPTO_RANDOM_MEMBERS.has(use.member)) {
        return { family: RANDOMNESS, what: "unseeded randomness (`crypto` random)" };
      }
      if (use.member === null) return { family: RANDOMNESS, what: "unseeded randomness (`crypto` reference)" };
      return { family: RANDOMNESS, what: `unseeded randomness (\`crypto.${use.member}\`)` };
    case "process":
      if (use.member === "hrtime") return { family: CLOCK, what: "clock (`process.hrtime`)" };
      return { family: ENVIRONMENT, what: "process global (`process.*`)" };
    case "navigator":
      if (use.member === "sendBeacon") return { family: NETWORK, what: "network (`navigator.sendBeacon()`)" };
      return { family: ENVIRONMENT, what: "process global (`navigator`)" };
    case "fetch":
      return {
        family: NETWORK,
        what: use.isCalled || use.isNew ? "network (`fetch()`)" : "network (`fetch` reference)",
      };
    case "WebSocket":
    case "XMLHttpRequest":
    case "EventSource":
      return { family: NETWORK, what: `network (\`${name}\`)` };
    case "setTimeout":
    case "setInterval":
    case "setImmediate":
      return { family: CLOCK, what: `clock/scheduling (\`${name}\`)` };
    default:
      if (ENVIRONMENT_ROOTS.has(name)) return { family: ENVIRONMENT, what: `process global (\`${name}\`)` };
      return null;
  }
}

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
// Source scanning (TypeScript compiler API)
// ---------------------------------------------------------------------------

/**
 * Resolves and loads `typescript`. It is a root devDependency and this tool
 * runs after `pnpm install` in dev and in CI, so it is not a new dependency and
 * the lockfile is untouched. Resolution is attempted from this file first (the
 * repository's own `node_modules`), then from the scanned root, so a checker
 * invoked with `--root <elsewhere>` still finds the compiler it was installed
 * beside. Failure is a `CHK` error and a non-zero exit — never a run that
 * quietly scans nothing.
 */
function loadTypeScript(rootDir) {
  const attempts = [];
  const candidates = [
    { label: "this checker's own location", from: import.meta.url },
    { label: `the scanned root (${rootDir})`, from: pathToFileURL(path.join(rootDir, "package.json")).href },
  ];
  for (const candidate of candidates) {
    try {
      const loaded = createRequire(candidate.from)("typescript");
      if (loaded && typeof loaded.createSourceFile === "function") return { ts: loaded, error: null };
      attempts.push(`${candidate.label}: resolved a module with no createSourceFile export`);
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      attempts.push(`${candidate.label}: ${detail}`);
    }
  }
  return { ts: null, error: attempts.join("; ") };
}

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

/** Parse each file under the dialect its extension declares. */
function scriptKindFor(ts, fileRel) {
  switch (path.extname(fileRel)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * One AST walk per file, producing everything rule 3 needs:
 *
 *   - `specifiers`: `{ specifier, line }` for every module specifier the
 *     grammar contains (static import/export, `import x = require(...)`,
 *     `import("...")` type node, dynamic `import(...)`, global `require(...)`).
 *   - `opaque`: `{ call, form, line }` for a dynamic `import()`/`require()`
 *     whose specifier is not a static literal — `F-OPAQUE` in a
 *     purity-restricted package.
 *   - `globals`: `{ family, what, line }` for every reference to an impure
 *     global that is not shadowed by a declaration in the file.
 *
 * The walk never descends into type nodes (a type annotation is not a value
 * reference) except to collect `import("...")` type specifiers and to follow a
 * heritage clause's expression.
 */
function scanSourceFile(ts, rootDir, fileRel) {
  const text = readFileSync(path.join(rootDir, fileRel), "utf8");
  const sourceFile = ts.createSourceFile(
    fileRel,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(ts, fileRel),
  );

  const specifiers = [];
  const opaque = [];
  const globals = [];
  /** Stack of names declared by each enclosing scope; see the header's KNOWN LIMIT. */
  const scopes = [];

  /**
   * Wrappers that do not change which value an expression denotes. Skipping
   * them is what makes `(window as any).Date()` and `value! / Math.random()`
   * read the same as their unwrapped forms.
   */
  const TRANSPARENT_KINDS = new Set([
    ts.SyntaxKind.ParenthesizedExpression,
    ts.SyntaxKind.AsExpression,
    ts.SyntaxKind.SatisfiesExpression,
    ts.SyntaxKind.NonNullExpression,
    ts.SyntaxKind.TypeAssertionExpression,
  ]);

  const lineOf = (node) =>
    ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile, false)).line + 1;

  const isDeclaredLocally = (name) => scopes.some((scope) => scope.has(name));

  const addBindingName = (name, into) => {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      into.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingName(element.name, into);
      }
    }
  };

  /**
   * Names a statement list binds as *values*. Interfaces and type aliases are
   * deliberately absent: `interface Date {}` merges with the global type and
   * binds no value, so treating it as a shadow would hide a real reference.
   */
  const addStatementDeclarations = (statements, into) => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBindingName(declaration.name, into);
        }
        continue;
      }
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name) into.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) into.add(bindings.name.text);
        else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) into.add(element.name.text);
        }
        continue;
      }
      if (ts.isLabeledStatement(statement)) {
        addStatementDeclarations([statement.statement], into);
        continue;
      }
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement)) &&
        statement.name &&
        ts.isIdentifier(statement.name)
      ) {
        into.add(statement.name.text);
      }
    }
  };

  const isFunctionLike = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);

  /**
   * The value names a scope-creating node introduces, or `null` when the node
   * creates no scope. Type parameters are not included: they bind types, and
   * the walk never resolves an identifier in a type position, so counting them
   * could only hide a value reference.
   *
   * A method's own name is not included either — `class C { Date() { … } }`
   * does not shadow the global `Date` inside its body — while a function
   * expression's name does bind inside itself.
   */
  const scopeNames = (node) => {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      const into = new Set();
      addStatementDeclarations(node.statements, into);
      return into;
    }
    if (ts.isCaseBlock(node)) {
      const into = new Set();
      for (const clause of node.clauses) addStatementDeclarations(clause.statements, into);
      return into;
    }
    if (isFunctionLike(node)) {
      const into = new Set();
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && ts.isIdentifier(node.name)) {
        into.add(node.name.text);
      }
      for (const parameter of node.parameters ?? []) addBindingName(parameter.name, into);
      return into;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const into = new Set();
      if (node.name) into.add(node.name.text);
      return into;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const into = new Set();
      const initializer = node.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)) {
        for (const declaration of initializer.declarations) addBindingName(declaration.name, into);
      }
      return into;
    }
    if (ts.isCatchClause(node)) {
      const into = new Set();
      if (node.variableDeclaration) addBindingName(node.variableDeclaration.name, into);
      return into;
    }
    return null;
  };

  /** The outermost expression denoting the same value as `node`. */
  const outerOf = (node) => {
    let current = node;
    while (
      current.parent &&
      TRANSPARENT_KINDS.has(current.parent.kind) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    return current;
  };

  /** `obj.name` / `obj["name"]` read off a reference, or `null`. */
  const memberAccessOf = (node) => {
    const outer = outerOf(node);
    const parent = outer.parent;
    if (!parent) return null;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer && ts.isIdentifier(parent.name)) {
      return { node: parent, name: parent.name.text };
    }
    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === outer &&
      parent.argumentExpression &&
      ts.isStringLiteralLike(parent.argumentExpression)
    ) {
      return { node: parent, name: parent.argumentExpression.text };
    }
    return null;
  };

  /** What is done with a reference: member read, call, construction, arity. */
  const useContext = (node) => {
    const access = memberAccessOf(node);
    const outer = outerOf(access ? access.node : node);
    const parent = outer.parent;
    let isCalled = false;
    let isNew = false;
    let argumentCount = 0;
    if (parent && ts.isCallExpression(parent) && parent.expression === outer) {
      isCalled = true;
      argumentCount = parent.arguments.length;
    } else if (parent && ts.isNewExpression(parent) && parent.expression === outer) {
      isNew = true;
      argumentCount = parent.arguments ? parent.arguments.length : 0;
    }
    return { member: access ? access.name : null, isCalled, isNew, argumentCount };
  };

  /**
   * True when this identifier *reads* a binding. Property names, declaration
   * names, import/export clause names, labels and object-literal keys are not
   * reads; a shorthand property (`{ Date }`) is.
   */
  const isValueReference = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isQualifiedName(parent) || ts.isMetaProperty(parent)) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
    if (ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isNamespaceExport(parent)) return false;
    if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;
    if (
      (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isModuleDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeParameterDeclaration(parent) ||
        ts.isImportEqualsDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    return true;
  };

  const recordSpecifier = (literal) => {
    specifiers.push({ specifier: literal.text, line: lineOf(literal) });
  };

  const recordOpaque = (node, call, argument) => {
    opaque.push({
      call,
      form:
        argument && ts.isTemplateExpression(argument)
          ? "an interpolated template literal"
          : "a non-literal expression",
      line: lineOf(node),
    });
  };

  /**
   * `eval(...)` and `Function(...)`/`new Function(...)` evaluate code this
   * checker cannot read, which makes F1-F8/F11 unevaluable for whatever they
   * evaluate — the same fault `F-OPAQUE` already names for a computed
   * specifier. `x instanceof Function` is a type test, not code evaluation, and
   * is excluded.
   */
  const recordEvaluator = (node) => {
    const outer = outerOf(node);
    const parent = outer.parent;
    if (
      node.text === "Function" &&
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      parent.right === outer
    ) {
      return;
    }
    opaque.push({ call: "evaluator", form: `\`${node.text}\``, line: lineOf(node) });
  };

  /**
   * `import(...)` or `require(...)`. A string or no-substitution template
   * literal is an exact specifier; anything else is opaque. This is what closes
   * the round-2 computed-`require` bypass.
   */
  const recordModuleCall = (call, kind) => {
    const argument = call.arguments[0];
    if (!argument) return;
    if (ts.isStringLiteralLike(argument)) {
      recordSpecifier(argument);
      return;
    }
    recordOpaque(call, kind, argument);
  };

  /** Type nodes contribute `import("...")` specifiers and nothing else. */
  const walkTypeNode = (node) => {
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (argument && ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        recordSpecifier(argument.literal);
      } else {
        recordOpaque(node, "import", argument);
      }
    }
    ts.forEachChild(node, walkTypeNode);
  };

  const visit = (node) => {
    // A type annotation is not a value reference; only its `import("...")`
    // specifiers matter. `ExpressionWithTypeArguments` (a heritage clause) is
    // in the type-node kind range but carries a real expression, so it is
    // walked normally.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
      walkTypeNode(node);
      return;
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) recordSpecifier(moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) recordSpecifier(expression);
      else recordOpaque(node, "import", expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        recordModuleCall(node, "import");
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        !isDeclaredLocally("require")
      ) {
        recordModuleCall(node, "require");
      }
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      globals.push({ family: ENVIRONMENT, what: "module environment (`import.meta`)", line: lineOf(node) });
    } else if (
      ts.isIdentifier(node) &&
      EVALUATORS.has(node.text) &&
      isValueReference(node) &&
      !isDeclaredLocally(node.text)
    ) {
      recordEvaluator(node);
    } else if (
      ts.isIdentifier(node) &&
      GLOBAL_ROOTS.has(node.text) &&
      isValueReference(node) &&
      !isDeclaredLocally(node.text)
    ) {
      const finding = classifyGlobalUse(node.text, useContext(node));
      if (finding) globals.push({ ...finding, line: lineOf(node) });
      if (ENVIRONMENT_ROOTS.has(node.text)) {
        // `globalThis.Date` / `window["Date"]` is a reference to global `Date`.
        const access = memberAccessOf(node);
        if (access && GLOBAL_ROOTS.has(access.name)) {
          const unwrapped = classifyGlobalUse(access.name, useContext(access.node));
          if (unwrapped) globals.push({ ...unwrapped, line: lineOf(node) });
        }
      }
    }

    const names = scopeNames(node);
    if (names === null) {
      ts.forEachChild(node, visit);
      return;
    }
    scopes.push(names);
    ts.forEachChild(node, visit);
    scopes.pop();
  };

  visit(sourceFile);

  // A file the parser could not read is a coverage hole, not a clean file: the
  // recovered tree may be missing the very import or global the scan is looking
  // for. Report the first syntax error per file as a `CHK` so the run fails
  // rather than passing on a partial parse. (`parseDiagnostics` is not part of
  // the documented API surface; if a future compiler build stops exposing it
  // the scan degrades to its pre-existing behaviour rather than crashing.)
  const parseDiagnostics = Array.isArray(sourceFile.parseDiagnostics) ? sourceFile.parseDiagnostics : [];
  const syntaxErrors = parseDiagnostics.slice(0, 1).map((diagnostic) => ({
    line: ts.getLineAndCharacterOfPosition(sourceFile, diagnostic.start ?? 0).line + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));

  return { specifiers, opaque, globals, syntaxErrors };
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

  // Rule 3 parses source with the TypeScript compiler API. If the compiler
  // cannot be resolved the check stops here: a run that skipped the source scan
  // and still exited 0 would be exactly the silent acceptance this package
  // exists to prevent.
  const { ts, error: typescriptError } = loadTypeScript(rootDir);
  if (ts === null) {
    push({
      rule: "CHK",
      subject: "typescript",
      message: `the TypeScript compiler API could not be loaded, so the rule-3 source scan cannot run (${typescriptError})`,
      doc: `${CONTRACT_REL} §6 rule 3`,
      fix: "run `pnpm install --frozen-lockfile` first; `typescript` is a root devDependency of this repository",
    });
    return { ok: false, violations, packages: [], edges: [], allowlist: [] };
  }

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
      const scan = scanSourceFile(ts, rootDir, fileRel);

      for (const problem of scan.syntaxErrors) {
        push({
          rule: "CHK",
          subject: pkg.dir,
          location: `${fileRel}:${problem.line}`,
          message: `could not be parsed (${problem.message}); rule 3 cannot evaluate a file it cannot parse, so this is an error rather than a silently skipped file`,
          doc: `${CONTRACT_REL} §6 rule 3`,
          fix: "fix the syntax error — `pnpm typecheck` reports the same file",
        });
      }

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

      // F11 / F3 — a strategy may not read a clock, unseeded randomness, the
      // environment, or the network. ADR-005 §1's list is "network, database,
      // filesystem, environment, global clock, or unseeded randomness": the
      // clock and randomness halves are F11 (contract §3), the environment and
      // network halves are F3, and both are reachable through a global with no
      // import to catch (WP-015 review round 1, HIGH(c)).
      if (isStrategy) {
        for (const hit of scan.globals) {
          const isDeterminismRule = hit.family === CLOCK || hit.family === RANDOMNESS;
          push(
            isDeterminismRule
              ? {
                  rule: "F11",
                  subject: pkg.dir,
                  location: `${fileRel}:${hit.line}`,
                  message: `reads ${hit.what}; time comes from \`ctx.now()\` and randomness from \`ctx.rng()\``,
                  doc: `${CONTRACT_REL} §3 (F11); handoff §6 invariant 2, §7.6; ADR-005 §1`,
                  fix: "take the value from StrategyContext so replay stays deterministic",
                }
              : {
                  rule: "F3",
                  subject: pkg.dir,
                  location: `${fileRel}:${hit.line}`,
                  message: `reads ${hit.what}; a strategy performs no I/O and reads no environment`,
                  doc: `${CONTRACT_REL} §3 (F3); handoff §5.2, §6 invariant 2; ADR-005 §1`,
                  fix: "receive the fact through a feature (§9.5) or a StrategyContext view (§7.6)",
                },
          );
        }
      }

      // F1 — packages/domain may not touch a process global, clock, or randomness.
      if (isDomain) {
        for (const hit of scan.globals) {
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

      // F-OPAQUE — a module load a static check cannot read. Restricted to the
      // packages whose whole point is a purity constraint; elsewhere a
      // composition root may legitimately load a module by computed name.
      if (isPurityRestricted) {
        for (const hit of scan.opaque) {
          push({
            rule: "F-OPAQUE",
            subject: pkg.dir,
            location: `${fileRel}:${hit.line}`,
            message:
              hit.call === "evaluator"
                ? `references ${hit.form}, which evaluates code no static check can read; in \`${pkg.dir}\` rules F1-F8/F11 cannot be evaluated at all for whatever it evaluates`
                : hit.call === "require"
                  ? `calls \`require()\` whose specifier is ${hit.form}; in \`${pkg.dir}\` the required module must be statically readable, or rules F1-F8/F11 cannot be evaluated at all`
                  : `uses a dynamic \`import()\` whose specifier is ${hit.form}; in \`${pkg.dir}\` the imported module must be statically readable, or rules F1-F8/F11 cannot be evaluated at all`,
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
    lines.push("      import()/require() in a restricted package, every workspace package classified.");
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
  F-OPAQUE  no dynamic import()/require() with a non-static specifier in a
            package whose purity is constrained (domain, strategies, ledger,
            simulation)
The §2 layer table and the §2.1 allowlist are parsed from the contract and
validated eagerly; an unparseable or inconsistent row is a CHK error, not a
skipped row. Source is parsed with the TypeScript compiler API (a root
devDependency); if it cannot be loaded the check fails closed. Exits 0 when
clean, 1 on any violation, 2 on a usage error.
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
