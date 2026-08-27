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
 *     purity-restricted package: a dynamic `import()`, a `require`-capability
 *     call (bare, aliased, `module.require`, or reflected) or a
 *     `process.getBuiltinModule(...)` call whose specifier is not a static
 *     literal (an interpolated template, a variable, a concatenation, an array
 *     passed to `.apply`), a reference to `eval`/`Function`, a read of the
 *     `constructor` property (round 6 — see "the evaluator surface" below), a
 *     **loader capability that escapes** into a value this check cannot follow
 *     (WP-015 review round 4; see "the capability escape rule" below), or a
 *     **computed member read on a capability** (round 5). Each defeats static
 *     checking entirely, so inside `packages/domain`, `packages/strategies/**`,
 *     `packages/ledger`, and `packages/simulation` it is itself a finding rather
 *     than a silent pass. Elsewhere it is allowed (composition roots
 *     legitimately load modules by name); see `docs/handoffs/WP-015.md` for that
 *     trade-off.
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
 *     nodes, dynamic `import(...)`, and any call that resolves to a module
 *     *loader capability* — the CommonJS `require` or `process.getBuiltinModule`
 *     (see below). A string literal or a no-substitution template literal is a
 *     specifier; anything else is `F-OPAQUE` in a purity-restricted package.
 *   - **The `require` capability, tracked like an impure global** (WP-015 review
 *     round 3). Recognising `require` only as the bare identifier callee let a
 *     restricted package reach forbidden modules through aliases and wrappers,
 *     so a call is a require-load when its callee (after stripping parentheses
 *     and `as`/`satisfies`/`!` wrappers) resolves to the capability:
 *       - the ambient/global `require` — even when it is only ever named through
 *         an ambient `declare const require`, which is a type assertion over the
 *         global, not a real local implementation, and so does *not* shadow it;
 *       - an alias bound to it: `const r = require` / `= module.require` /
 *         `= createRequire(...)` / `= module`, or `const { require } = module`,
 *         makes a later `r(...)` (or `m.require(...)`) a require-load;
 *       - `module.require(...)` / `module["require"](...)`, where `module` is the
 *         CommonJS module global (not a genuine local of that name);
 *       - `require.call(thisArg, spec)` / `require.apply(...)` reflection, whose
 *         specifier is the argument at index 1 (a non-literal there, e.g. the
 *         array `.apply` takes, is `F-OPAQUE`);
 *       - a directly-invoked `createRequire(...)(spec)`.
 *     A *genuinely* local `require` (a real function, a parameter, an import, a
 *     destructured non-module binding) still shadows, and a *method* call such
 *     as `registry.require(eventType, version)` is not a module load because its
 *     callee is a property access on an object that is not the module global.
 *   - **`process.getBuiltinModule` is a loader too** (WP-015 review round 5).
 *     It returns a Node built-in namespace by name, so a call to it is a module
 *     load and its specifier is classified exactly like an import's
 *     (`getBuiltinModule("node:fs")` in a strategy is F3); a computed argument is
 *     `F-OPAQUE`. It is recognised through `process.getBuiltinModule`,
 *     `globalThis.process.getBuiltinModule`, a tracked `process` alias, a
 *     `const { getBuiltinModule } = process` destructure, and `.call`/`.apply`
 *     reflection. `getBuiltinModule("node:module")` — like `require("node:module")`,
 *     a namespace import of it, or `await import("node:module")` — yields the
 *     module namespace whose `.createRequire` member is the factory, so the whole
 *     chain back to a working `require` is one capability expression.
 *     `process` itself is a **carrier**, not a loader: it is resolved so the
 *     loader can be found through it, but a bare `process` reference is not an
 *     escape (`packages/ledger` and `packages/simulation` legitimately read the
 *     environment; only `packages/domain` and `packages/strategies/**` are under
 *     the impure-global rules).
 *   - **A computed member read on a capability fails closed** (round 5). When
 *     the object of an element access resolves to a capability and the member is
 *     not a literal — `getBuiltinModule("node:module")["create" + "Require"]`,
 *     `process[key]`, `require[k]` — the member cannot be classified, so the
 *     access itself is `F-OPAQUE` rather than `null`. That composition (an
 *     unrecognised loader plus a computed member) is what silently produced a
 *     working `require` in `packages/simulation` before round 5. A computed
 *     member on a NON-capability object is out of scope and adds no noise.
 *   - **The capability escape rule** (WP-015 review round 4, widened in round 5
 *     to every loader capability above). The list of analysed positions
 *     enumerates the places in which this check can *read* what a capability
 *     loads. Enumerating positions is not a total rule, and round 4 found seven
 *     legal spellings that reached a module while naming none of them:
 *     `({ r: require }).r("node:fs")`, `[require][0](...)`,
 *     `exports.load = require` plus a later call through the wrapper,
 *     `Reflect.apply(require, null, [...])`, `const { r } = { r: require }`,
 *     `require.bind(null)(...)`, and `let r; r = require;` (an assignment, which
 *     the declaration-only alias tracker never saw). So the rule is inverted and
 *     made total by construction, in the same identifier-reference layer that
 *     already detects `Date`/`process`:
 *
 *       In a purity-restricted package, ANY reference to a loader capability
 *       that is not in a position this check analyses is ITSELF a finding.
 *
 *     A "loader capability" is the ambient `require`, the CommonJS `module`
 *     global, `createRequire` (which manufactures one), the result of calling
 *     it, `process.getBuiltinModule`, the `node:module` namespace (round 5), and
 *     any alias this check tracks to one of those. The positions that do
 *     *not* additionally flag — because the check follows the value through them
 *     — are exactly: the callee of an analyzed call (which yields a specifier or
 *     an `F-OPAQUE`), the `.call`/`.apply` reflection callee, the initializer of
 *     a declaration whose binding the alias tracker follows (the alias is then
 *     tracked, and an *alias* reference that escapes is caught by this same
 *     rule), the base of a larger capability expression (`module` in
 *     `module.require`, `createRequire` in `createRequire(...)`), the base of a
 *     computed member read (which the computed-access rule reports at the access
 *     itself, so the construct yields one finding rather than two), a `typeof`
 *     operand, and a type position (never walked as a value). Everything else —
 *     object/array literal element, assignment right-hand side, call argument,
 *     `.bind`/any other property read, return value, export value — is an
 *     escape, reported as `F-OPAQUE` with the escape shape named.
 *
 *     This is deliberately noisy for contrived-but-legal wrapping: an escape
 *     finding does not prove a forbidden module was loaded, only that the check
 *     can no longer prove one was not. That is the accepted trade
 *     (noisy-never-silent), and it costs nothing in practice because a
 *     purity-restricted package has no legitimate use of a module loader at all —
 *     ADR-005 §1 and contract §3 (F1/F2/F3) forbid the I/O it exists to reach.
 *     The rule is total over the loader references the walk *sees*: it inherits
 *     the KNOWN LIMITs below (no cross-file resolution, no reachability, a
 *     capability handed in from another package is invisible), which is why
 *     round 5's `process.getBuiltinModule` gap mattered — an unrecognised loader
 *     is not a reference the rule can be total over.
 *   - **The evaluator surface** (WP-015 review round 6). Until round 6 this was
 *     an identifier list — `eval` and `Function` — which meant the *indirect*
 *     acquisition of the same capability was silent and ran:
 *
 *       (function () {}).constructor('return process.getBuiltinModule("node:fs")')()
 *       queueMicrotask.constructor('…createRequire…')()
 *
 *     both exit 0 in `packages/simulation`, `packages/ledger`, `packages/domain`
 *     and a strategy, and both are arbitrary code evaluation (runtime-verified
 *     on Node 24). For every function `f`, `f.constructor === Function`; whether
 *     an arbitrary expression is function-valued is not statically decidable, so
 *     the rule fails **closed** and takes no non-function exemption:
 *
 *       In a purity-restricted package, a member read whose property resolves to
 *       `constructor` is ITSELF an evaluator-acquisition finding.
 *
 *     "Resolves to" folds the computed spellings — `f["constructor"]`,
 *     `f["constr" + "uctor"]`, ``f[`constr${"uctor"}`]``, and
 *     `const k = "constructor"; f[k]` — and the destructures
 *     `const { constructor } = f` / `const { constructor: F } = f` /
 *     `const { ["constructor"]: F } = f`. `[].constructor` is `Array`, not
 *     `Function`, and is flagged anyway: see `EVALUATOR_PROPERTY` for why the
 *     exemption is refused. *Declaring* a `constructor` member
 *     (`class C { constructor() {} }`, `{ constructor: f }`) is not a read and is
 *     untouched; the rule does not run in unrestricted packages (`apps/**`).
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
 *   - **A property name computed at run time is not resolved.** The round-6
 *     evaluator rule folds literals, `+` concatenations, template literals and
 *     file-level string constants, but nothing more: `f[parts.join("")]` reaches
 *     `constructor` and this check cannot see it. Fixing that by flagging *every*
 *     dynamic-key read would contradict the accepted round-5 ruling that
 *     `table[key]` on a non-capability object adds no noise, so it is disclosed
 *     rather than closed. The durable fix is the positive rule in
 *     `docs/handoffs/WP-015.md` follow_up 8, not another recognised spelling.
 *
 * KNOWN LIMIT — **every catalogue in this file is a list, not a proof.** The
 * loader family (`LOADER_CAPABILITIES`), the evaluator surface (`EVALUATORS` +
 * `EVALUATOR_PROPERTY`) and the library catalogues below all enumerate what this
 * check *recognises*. Review rounds 3, 4, 5 and 6 each found exactly one missing
 * member — the `require` family, unconsumed capability references,
 * `process.getBuiltinModule`, and `.constructor` — and the honest reading is that
 * the list is still assumed incomplete. Rules stated over a recognised list are
 * total only over what they recognise. See `docs/handoffs/WP-015.md` follow_up 8
 * for the positive form (a checker total over "no call whose callee resolves to a
 * declared import") that would end the pattern.
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
  // `node:module` exposes `createRequire`, which manufactures a CommonJS
  // `require` capable of loading any of the above by name. Importing it into a
  // restricted package is itself the finding that closes the createRequire
  // route (WP-015 review round 3).
  ["module", "process/environment"],
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
 *
 * This is an identifier list, and until round 6 it was the *whole* evaluator
 * surface — which is why `EVALUATOR_PROPERTY` exists below.
 */
const EVALUATORS = new Set(["eval", "Function"]);

/**
 * The property that hands out the `Function` constructor without ever naming
 * it (WP-015 review round 6). For **any** function-valued expression `f`,
 * `f.constructor === Function`, so
 *
 *   (function () {}).constructor('return process.getBuiltinModule("node:fs")')()
 *   queueMicrotask.constructor('return process.getBuiltinModule("node:module")' +
 *                              '.createRequire(process.argv[1])')()
 *
 * are arbitrary code evaluation and a reconstituted `require` respectively —
 * both runtime-verified on Node 24, and both silent (exit 0) in every
 * purity-restricted package before this rule existed, because `EVALUATORS`
 * matched only identifiers literally spelled `eval`/`Function`.
 *
 * Deciding "is this expression function-valued" is undecidable without a type
 * checker (and would still be undecidable with one, across `any`/`unknown`), so
 * the rule fails **closed** and takes no non-function exemption: a member read
 * whose property resolves to `constructor`, anywhere in a purity-restricted
 * package, is an `F-OPAQUE` evaluator-acquisition finding. `[].constructor` is
 * `Array` and not an evaluator, and it is still flagged — deliberately, because
 * the exemption that would clear it is exactly the kind of recognised-shape list
 * that rounds 3–6 each found a hole in, and because `[].constructor.constructor`
 * *is* `Function` anyway. See `docs/handoffs/WP-015.md` for the boundary.
 *
 * What the boundary intentionally leaves clean: *declaring* a member named
 * `constructor` (`class C { constructor() {} }`, `{ constructor: f }` as an
 * object-literal key) is a declaration, not a read, and is untouched.
 */
const EVALUATOR_PROPERTY = "constructor";

/**
 * The shapes in which a package can hold, or reach, a module-loading
 * capability. `capabilityOf` (below) maps an expression to one of these or to
 * `null`; the escape rule described in this file's header treats a reference to
 * any *loader* capability as a finding unless the reference sits in a position
 * the check analyses.
 *
 * `CAP_PROCESS` is a **carrier**, not a loader: `process` is where
 * `process.getBuiltinModule` lives, so the check must resolve it, but a bare
 * `process` reference is not itself a module-loading escape (WP-015 review
 * round 5 — `packages/ledger` and `packages/simulation` are not fully
 * purity-restricted and legitimately read `process`; the *loader* member is what
 * the contract's F-rows reach).
 */
const CAP_REQUIRE = "require-loader";
const CAP_MODULE = "module-global";
const CAP_FACTORY = "createRequire-factory";
const CAP_BUILTIN_LOADER = "getBuiltinModule-loader";
const CAP_MODULE_NS = "module-namespace";
const CAP_PROCESS = "process-global";

/** How each capability is named in an escape finding. */
const CAPABILITY_LABELS = new Map([
  [CAP_REQUIRE, "the CommonJS `require` capability"],
  [CAP_MODULE, "the CommonJS `module` global (from which `module.require` is reachable)"],
  [CAP_FACTORY, "`createRequire`, which manufactures a CommonJS `require`"],
  [CAP_BUILTIN_LOADER, "`process.getBuiltinModule`, which loads any Node built-in by name"],
  [CAP_MODULE_NS, "the `node:module` namespace (from which `createRequire` is reachable)"],
  [CAP_PROCESS, "the `process` global (from which `process.getBuiltinModule` is reachable)"],
]);

/**
 * Capabilities whose *reference* is subject to the escape rule (WP-015 review
 * round 4, widened in round 5). `CAP_PROCESS` is deliberately absent: see above.
 */
const LOADER_CAPABILITIES = new Set([
  CAP_REQUIRE,
  CAP_MODULE,
  CAP_FACTORY,
  CAP_BUILTIN_LOADER,
  CAP_MODULE_NS,
]);

/**
 * Capabilities that are *called* with a specifier, and the label the finding
 * uses for that call. Both are classified exactly like an import: a string or
 * no-substitution template literal argument is an exact specifier fed through
 * F1–F8/F11, and anything else is `F-OPAQUE` in a purity-restricted package.
 */
const LOADER_CALL_LABELS = new Map([
  [CAP_REQUIRE, "require"],
  [CAP_BUILTIN_LOADER, "getBuiltinModule"],
]);

/**
 * Which member of a capability-bearing object is itself a capability, for
 * destructuring (`const { require: r } = module`,
 * `const { getBuiltinModule } = process`). Member access spells the same thing
 * and is resolved by `capabilityOf`.
 */
const DESTRUCTURED_CAPABILITY_MEMBERS = new Map([
  [CAP_MODULE, new Map([["require", CAP_REQUIRE]])],
  [CAP_PROCESS, new Map([["getBuiltinModule", CAP_BUILTIN_LOADER]])],
  [CAP_MODULE_NS, new Map([["createRequire", CAP_FACTORY]])],
]);

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
   * Names bound by a **non-ambient** declaration in each enclosing scope. A
   * `declare const require`/`declare function require` is a type assertion over
   * the ambient global, not a real local implementation, so it is present in
   * `scopes` (it is a name) but absent here — which is what lets the ambient
   * `require` capability still be caught through it (WP-015 review round 3).
   */
  const genuineScopes = [];
  /**
   * Names bound to a require **capability** in each enclosing scope, as a
   * `Map<name, capability kind>`: an alias to `require`/`module.require`/
   * `createRequire(...)`/`module`/`createRequire`, or a `const { require } =
   * module` destructure. A later call to a `CAP_REQUIRE` name is a require-load,
   * and a reference to any tracked name obeys the escape rule.
   */
  const requireAliasScopes = [];

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
  const isGenuinelyDeclared = (name) => genuineScopes.some((scope) => scope.has(name));

  /**
   * The capability an alias name is bound to, or `null`. Frames are searched
   * innermost-first and a genuine binding in a *nearer* scope shadows an outer
   * alias, so `const r = require; function f(r) { r(x); }` resolves the inner
   * `r` to the parameter. `requireAliasScopes` and `genuineScopes` are pushed
   * together, so index `i` names the same scope in both (during hoisting the
   * alias frame for the scope being entered is not yet pushed, which is exactly
   * right: it is the frame being computed).
   */
  const trackedAliasKind = (name) => {
    for (let index = requireAliasScopes.length - 1; index >= 0; index -= 1) {
      const kind = requireAliasScopes[index].get(name);
      if (kind !== undefined) return kind;
      if (genuineScopes[index].has(name)) return null;
    }
    return null;
  };

  /** True when a scope-creating node carries the ambient `declare` modifier. */
  const hasDeclareModifier = (node) => {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(modifiers && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword));
  };

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
  const addStatementDeclarations = (statements, into, genuineOnly = false) => {
    for (const statement of statements) {
      // In `genuineOnly` mode an ambient declaration binds no runtime value, so
      // it is not a real local shadow (WP-015 review round 3).
      if (genuineOnly && hasDeclareModifier(statement)) continue;
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
        addStatementDeclarations([statement.statement], into, genuineOnly);
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
      const all = new Set();
      const genuine = new Set();
      addStatementDeclarations(node.statements, all, false);
      addStatementDeclarations(node.statements, genuine, true);
      return { all, genuine };
    }
    if (ts.isCaseBlock(node)) {
      const all = new Set();
      const genuine = new Set();
      for (const clause of node.clauses) {
        addStatementDeclarations(clause.statements, all, false);
        addStatementDeclarations(clause.statements, genuine, true);
      }
      return { all, genuine };
    }
    // Parameters, class names, `for`/`catch` binders are always real runtime
    // bindings, so `all` and `genuine` coincide for these scopes.
    if (isFunctionLike(node)) {
      const into = new Set();
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && ts.isIdentifier(node.name)) {
        into.add(node.name.text);
      }
      for (const parameter of node.parameters ?? []) addBindingName(parameter.name, into);
      return { all: into, genuine: into };
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const into = new Set();
      if (node.name) into.add(node.name.text);
      return { all: into, genuine: into };
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const into = new Set();
      const initializer = node.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)) {
        for (const declaration of initializer.declarations) addBindingName(declaration.name, into);
      }
      return { all: into, genuine: into };
    }
    if (ts.isCatchClause(node)) {
      const into = new Set();
      if (node.variableDeclaration) addBindingName(node.variableDeclaration.name, into);
      return { all: into, genuine: into };
    }
    return null;
  };

  /** Strip transparent wrappers (parens, `as`, `satisfies`, `!`) off an expression. */
  const unwrapExpression = (node) => {
    let current = node;
    while (current && TRANSPARENT_KINDS.has(current.kind) && current.expression) {
      current = current.expression;
    }
    return current;
  };

  /** `obj.name` / `obj["name"]` — the statically known member name, or `null`. */
  const staticMemberName = (node) => {
    if (ts.isPropertyAccessExpression(node)) return ts.isIdentifier(node.name) ? node.name.text : null;
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      return node.argumentExpression.text;
    }
    return null;
  };

  /**
   * Names this file binds to a statically foldable string, filled by a pre-pass
   * in document order (so `const a = "constr"; const k = a + "uctor";` resolves)
   * and used only by the round-6 evaluator-acquisition rule. Scoping is
   * deliberately ignored: the map is file-wide, so a shadowed name can only make
   * the rule *more* eager, never silent — and a restricted package that declares
   * a constant whose value is `"constructor"` is the smell the rule is looking
   * for.
   */
  const constantStrings = new Map();

  /**
   * The string an expression statically denotes, or `null`. Folds string and
   * no-substitution-template literals, `+` concatenation, template literals
   * whose every span folds, and identifiers in `constantStrings`. This is what
   * stops `f["constr" + "uctor"]` and `const k = "constructor"; f[k]` from
   * walking around the rule; a key computed at run time still cannot be folded
   * and is a disclosed limit (see the header's KNOWN LIMIT on the evaluator
   * surface).
   */
  const foldString = (expr, depth = 0) => {
    if (!expr || depth > 8) return null;
    const inner = unwrapExpression(expr);
    if (!inner) return null;
    if (ts.isStringLiteralLike(inner)) return inner.text;
    if (ts.isIdentifier(inner)) {
      const value = constantStrings.get(inner.text);
      return value === undefined ? null : value;
    }
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = foldString(inner.left, depth + 1);
      if (left === null) return null;
      const right = foldString(inner.right, depth + 1);
      return right === null ? null : left + right;
    }
    if (ts.isTemplateExpression(inner)) {
      let folded = inner.head.text;
      for (const span of inner.templateSpans) {
        const value = foldString(span.expression, depth + 1);
        if (value === null) return null;
        folded += value + span.literal.text;
      }
      return folded;
    }
    return null;
  };

  const collectConstantStrings = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = foldString(node.initializer);
      if (value !== null) constantStrings.set(node.name.text, value);
    }
    ts.forEachChild(node, collectConstantStrings);
  };

  /**
   * The property name a member access reads, folding the computed forms
   * `staticMemberName` deliberately does not (it must keep returning `null` for
   * a computed access so the round-5 fail-closed rule still fires on
   * `capability["create" + "Require"]`).
   */
  const resolvedMemberName = (node) => {
    const direct = staticMemberName(node);
    if (direct !== null) return direct;
    if (ts.isElementAccessExpression(node)) return foldString(node.argumentExpression);
    return null;
  };

  /**
   * The property a binding element reads off its object, including the computed
   * form `const { ["constructor"]: F } = fn`. Kept separate from
   * `bindingPropertyName` so the capability-destructure logic is untouched.
   */
  const destructuredPropertyName = (element) => {
    const property = element.propertyName;
    if (property === undefined) return ts.isIdentifier(element.name) ? element.name.text : null;
    if (ts.isIdentifier(property)) return property.text;
    if (ts.isStringLiteralLike(property)) return property.text;
    if (ts.isComputedPropertyName(property)) return foldString(property.expression);
    return null;
  };

  /** True when a specifier names Node's `module` built-in, whose namespace holds `createRequire`. */
  const isModuleNamespaceSpecifier = (argument) =>
    Boolean(argument) && ts.isStringLiteralLike(argument) && normalizeBuiltin(argument.text) === "module";

  /**
   * Which capability, if any, an expression denotes (see this file's header).
   * `extraAliases` lets alias hoisting see earlier same-scope aliases, so a
   * chain (`const a = require; const b = a;`) resolves.
   *
   * `createRequire` and `getBuiltinModule` are matched by name **without** the
   * genuine-shadow test, because the ordinary way to hold either is to import or
   * destructure it — and both bind genuine declarations
   * (`import { createRequire } from "node:module"`,
   * `const { getBuiltinModule } = process`). Importing `node:module` is already
   * an F1/F3 finding, so the only cost of the wider match is a possible escape
   * finding on an unrelated local of one of those two names, which is the
   * accepted noisy-never-silent direction.
   */
  const capabilityOf = (expr, extraAliases) => {
    if (!expr) return null;
    const inner = unwrapExpression(expr);
    if (!inner) return null;
    if (ts.isIdentifier(inner)) {
      const name = inner.text;
      const pending = extraAliases ? extraAliases.get(name) : undefined;
      if (pending !== undefined) return pending;
      const tracked = trackedAliasKind(name);
      if (tracked !== null) return tracked;
      if (name === "createRequire") return CAP_FACTORY;
      if (name === "getBuiltinModule") return CAP_BUILTIN_LOADER;
      // A genuine local of that name is a real implementation, not the global.
      if (isGenuinelyDeclared(name)) return null;
      if (name === "require") return CAP_REQUIRE;
      if (name === "module") return CAP_MODULE;
      // Not a loader; `process.getBuiltinModule` is reached through it.
      if (name === "process") return CAP_PROCESS;
      return null;
    }
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      const member = staticMemberName(inner);
      // A computed member is handled by the caller (`computedCapabilityAccess`),
      // which fails closed rather than resolving to `null` (review round 5).
      if (member === null) return null;
      // `mod.createRequire` / `mod["createRequire"]` — the namespace form.
      if (member === "createRequire") return CAP_FACTORY;
      // `process.getBuiltinModule` is a module loader in exactly the sense
      // `require` is: it returns a Node built-in namespace by name, and
      // `getBuiltinModule("node:module").createRequire` reconstitutes `require`
      // itself (review round 5).
      if (member === "getBuiltinModule") return CAP_BUILTIN_LOADER;
      const rootKind = capabilityOf(inner.expression, extraAliases);
      const root = unwrapExpression(inner.expression);
      const isEnvironmentRoot = Boolean(
        root && ts.isIdentifier(root) && ENVIRONMENT_ROOTS.has(root.text) && !isGenuinelyDeclared(root.text),
      );
      // `globalThis.process` / `window["process"]` is the same carrier as a bare
      // `process`, and a tracked alias (`const p = process`) already resolves.
      if (member === "process" && isEnvironmentRoot) return CAP_PROCESS;
      if (member !== "require") return null;
      if (rootKind === CAP_MODULE) return CAP_REQUIRE;
      // `globalThis.require` / `window["require"]` reaches the same ambient
      // capability. The root is separately an impure-global finding, but only
      // in `packages/domain` and `packages/strategies/**`; without this branch
      // the identical construct is silent in `packages/ledger` and
      // `packages/simulation`, which run no globals rule.
      if (isEnvironmentRoot) return CAP_REQUIRE;
      return null;
    }
    if (ts.isCallExpression(inner)) {
      // Calling the factory yields the loader: `createRequire(import.meta.url)`.
      const calleeKind = capabilityOf(inner.expression, extraAliases);
      if (calleeKind === CAP_FACTORY) return CAP_REQUIRE;
      // A module load of `node:module` — by `require`, by
      // `process.getBuiltinModule`, or by dynamic `import()` — yields the
      // namespace whose `createRequire` member is the factory. Naming it as a
      // capability is what makes a *computed* member read on it fail closed.
      const loadsModuleNamespace =
        (calleeKind === CAP_REQUIRE || calleeKind === CAP_BUILTIN_LOADER) &&
        isModuleNamespaceSpecifier(inner.arguments[0]);
      if (loadsModuleNamespace) return CAP_MODULE_NS;
      // `require.call(thisArg, "node:module")` / `.apply(thisArg, [...])`.
      if (isLoaderReflection(inner.expression) && isModuleNamespaceSpecifier(inner.arguments[1])) {
        return CAP_MODULE_NS;
      }
      if (
        inner.expression.kind === ts.SyntaxKind.ImportKeyword &&
        isModuleNamespaceSpecifier(inner.arguments[0])
      ) {
        return CAP_MODULE_NS;
      }
      return null;
    }
    // `await import("node:module")` / `(await import("node:module"))`.
    if (ts.isAwaitExpression(inner)) return capabilityOf(inner.expression, extraAliases);
    return null;
  };

  /**
   * `require.call(...)` / `require.apply(...)` — reflection over a loader
   * capability. Returns the loader kind being reflected, or `null`.
   * `process.getBuiltinModule.call(null, "node:fs")` is the same shape and is
   * read the same way (review round 5).
   */
  const reflectedLoaderKind = (callee) => {
    if (!callee) return null;
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null;
    const member = staticMemberName(callee);
    if (member !== "call" && member !== "apply") return null;
    const kind = capabilityOf(callee.expression);
    return LOADER_CALL_LABELS.has(kind) ? kind : null;
  };

  const isLoaderReflection = (callee) => reflectedLoaderKind(callee) !== null;

  /** The member a binding element reads off its object, or `null`. */
  const bindingPropertyName = (element) => {
    const property = element.propertyName ?? element.name;
    if (ts.isIdentifier(property)) return property.text;
    return ts.isStringLiteralLike(property) ? property.text : null;
  };

  /**
   * Names a scope binds to a module-loading capability, hoisted on scope entry
   * *after* the scope's own `scopes`/`genuineScopes` frames are pushed, so a
   * genuine local `require`/`module` in the same scope correctly shadows.
   * Declarations are processed in source order and fed back through
   * `extraAliases`, so a chain (`const a = require; const b = a;`) resolves.
   */
  const collectAliasDecls = (statements, into) => {
    for (const statement of statements) {
      if (ts.isLabeledStatement(statement)) {
        collectAliasDecls([statement.statement], into);
        continue;
      }
      // `import * as m from "node:module"` / `import m = require("node:module")`
      // bind the namespace whose `createRequire` member is the factory. Naming
      // it makes a *computed* member read on it fail closed (review round 5).
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        if (!isModuleNamespaceSpecifier(statement.moduleSpecifier)) continue;
        const clause = statement.importClause;
        if (clause.name) into.set(clause.name.text, CAP_MODULE_NS);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) into.set(bindings.name.text, CAP_MODULE_NS);
        continue;
      }
      if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
        if (isModuleNamespaceSpecifier(statement.moduleReference.expression) && ts.isIdentifier(statement.name)) {
          into.set(statement.name.text, CAP_MODULE_NS);
        }
        continue;
      }
      if (!ts.isVariableStatement(statement) || hasDeclareModifier(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        const kind = capabilityOf(declaration.initializer, into);
        if (ts.isIdentifier(declaration.name)) {
          if (kind !== null) into.set(declaration.name.text, kind);
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name)) continue;
        // `const { require: r } = module` binds `r` to `module.require`;
        // `const { getBuiltinModule: g } = process` binds `g` to the builtin
        // loader; `const { createRequire } = m` is matched by name anyway.
        const members = DESTRUCTURED_CAPABILITY_MEMBERS.get(kind);
        if (!members) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const propertyName = bindingPropertyName(element);
          const bound = propertyName === null ? undefined : members.get(propertyName);
          if (bound !== undefined) into.set(element.name.text, bound);
        }
      }
    }
  };

  const requireAliasNames = (node) => {
    const into = new Map();
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      collectAliasDecls(node.statements, into);
    } else if (ts.isCaseBlock(node)) {
      for (const clause of node.clauses) collectAliasDecls(clause.statements, into);
    }
    return into;
  };

  /**
   * True when a declaration's binding consumed the capability its initializer
   * denotes — i.e. the alias tracker followed it, so the value has not escaped
   * and the alias's own references are subject to the same escape rule.
   */
  const declarationTracksCapability = (declaration) => {
    if (ts.isIdentifier(declaration.name)) return trackedAliasKind(declaration.name.text) !== null;
    if (ts.isObjectBindingPattern(declaration.name)) {
      return declaration.name.elements.some(
        (element) =>
          ts.isBindingElement(element) &&
          ts.isIdentifier(element.name) &&
          trackedAliasKind(element.name.text) !== null,
      );
    }
    return false;
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
   * True when a *larger* enclosing expression is itself a capability, so that
   * expression — not this one — is the one whose position decides the escape.
   * `module` in `module.require`, and `createRequire` in `createRequire(...)`,
   * are absorbed this way; `require` in `require("x")` is not, because
   * `require("x")` denotes the loaded module, not a capability.
   */
  const isAbsorbedCapability = (node) => {
    const outer = outerOf(node);
    const parent = outer.parent;
    if (!parent) return false;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isCallExpression(parent)) &&
      parent.expression === outer
    ) {
      return capabilityOf(parent) !== null;
    }
    return false;
  };

  /**
   * True when the capability sits in a position this check analyses, so it needs
   * no escape finding. See the header's "capability escape rule" for why this
   * list is closed and everything outside it is a finding.
   */
  const capabilityIsConsumed = (node, kind) => {
    const outer = outerOf(node);
    const parent = outer.parent;
    if (!parent) return false;
    // `typeof require` is a shadow-safe existence test that loads nothing.
    if (ts.isTypeOfExpression(parent)) return true;
    // A computed member read on this capability is reported by
    // `computedCapabilityAccess` at the access itself, so the base is consumed
    // and the construct yields exactly one finding (review round 5).
    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === outer &&
      staticMemberName(parent) === null
    ) {
      return true;
    }
    if (LOADER_CALL_LABELS.has(kind)) {
      // The callee of a call the module-call visitor reads.
      if (ts.isCallExpression(parent) && parent.expression === outer) return true;
      // `require.call(thisArg, spec)` / `require.apply(thisArg, [spec])`.
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === outer
      ) {
        const member = staticMemberName(parent);
        if (member === "call" || member === "apply") {
          const access = outerOf(parent);
          return Boolean(access.parent && ts.isCallExpression(access.parent) && access.parent.expression === access);
        }
      }
    }
    // The initializer of a declaration whose binding the alias tracker follows.
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      return declarationTracksCapability(parent);
    }
    return false;
  };

  /** Names the shape of the escape, so the finding says what to look at. */
  const escapeShapeOf = (node) => {
    const outer = outerOf(node);
    const parent = outer.parent;
    if (!parent) return "an unattached expression";
    if (ts.isPropertyAssignment(parent) && parent.initializer === outer) return "an object-literal property value";
    if (ts.isShorthandPropertyAssignment(parent)) return "an object-literal shorthand property";
    if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) return "a spread element";
    if (ts.isArrayLiteralExpression(parent)) return "an array-literal element";
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === outer
    ) {
      return "the right-hand side of an assignment (which binds no declaration for the alias tracker to follow)";
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== outer) {
      return "a call argument";
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      return "a callee this check cannot resolve to a module load";
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      const member = staticMemberName(parent);
      return member === null ? "a computed property read" : `a property read (\`.${member}\`)`;
    }
    if (ts.isReturnStatement(parent)) return "a return value";
    if (ts.isArrowFunction(parent) && parent.body === outer) return "a concise arrow-function body";
    if (ts.isExportAssignment(parent)) return "an export value";
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      return "a declaration initializer whose binding this check cannot follow";
    }
    if (ts.isTemplateSpan(parent)) return "a template-literal interpolation";
    if (ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent)) return "an operand of an expression";
    return "a position this check cannot follow";
  };

  const recordCapabilityEscape = (node, kind) => {
    opaque.push({
      call: "capability",
      form: `${CAPABILITY_LABELS.get(kind)} escapes into ${escapeShapeOf(node)}`,
      line: lineOf(node),
    });
  };

  /**
   * `capability[<not a literal>]` — a computed member read on a
   * capability-bearing expression. `capabilityOf` cannot say which member is
   * read, and returning `null` there is what let
   * `getBuiltinModule("node:module")["create" + "Require"](__filename)` acquire a
   * working `require` in silence (WP-015 review round 5). The rule fails closed
   * instead: the access itself is the finding, and the base is treated as
   * consumed so the construct is reported once.
   */
  const recordComputedCapabilityAccess = (node, kind) => {
    opaque.push({
      call: "capability-computed",
      form: `${CAPABILITY_LABELS.get(kind)} is read with a computed member expression (\`[...]\`), so the member this check would have to classify is not statically known`,
      line: lineOf(node),
    });
  };

  /**
   * `f.constructor` / `f["constructor"]` / `const { constructor } = f` — the
   * `Function` constructor acquired without naming it (WP-015 review round 6).
   * See `EVALUATOR_PROPERTY` for why this fails closed on every object rather
   * than trying to prove the object is not a function.
   */
  const recordEvaluatorAcquisition = (node, shape) => {
    opaque.push({ call: "evaluator-acquisition", form: shape, line: lineOf(node) });
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
   * `import(...)` or a `require`-capability call. A string or no-substitution
   * template literal at `argIndex` is an exact specifier; anything else is
   * opaque. `argIndex` is 1 for `require.call`/`require.apply` reflection, where
   * the specifier follows the `thisArg` (WP-015 review round 3), and 0
   * otherwise. This is what closes the computed-`require` bypasses.
   */
  const recordModuleCall = (call, kind, argIndex) => {
    const argument = call.arguments[argIndex];
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

    // WP-015 review round 6 — indirect acquisition of the `Function`
    // constructor. Reading `constructor` off any function-valued expression
    // yields `Function`, so this is evaluator acquisition and is reported
    // wherever the property name resolves, fail-closed on the object's type.
    // The finding is emitted only inside a purity-restricted package (see the
    // `F-OPAQUE` block in `runCheck`).
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (resolvedMemberName(node) === EVALUATOR_PROPERTY) {
        recordEvaluatorAcquisition(
          node,
          ts.isPropertyAccessExpression(node)
            ? "the `constructor` property (`.constructor`)"
            : "the `constructor` property (a `[...]` member read that resolves to `constructor`)",
        );
      }
    } else if (ts.isBindingElement(node) && destructuredPropertyName(node) === EVALUATOR_PROPERTY) {
      recordEvaluatorAcquisition(node, "the `constructor` property (a `{ constructor }` destructure)");
    }

    // WP-015 review round 4 — the capability escape rule. Every expression that
    // denotes a require capability is checked here, in the same reference layer
    // that detects `Date`/`process`, so a capability which leaves the positions
    // this check analyses is a finding rather than a silent module load. The
    // finding is emitted only inside a purity-restricted package (see the
    // `F-OPAQUE` block in `runCheck`).
    if (
      ts.isIdentifier(node)
        ? isValueReference(node)
        : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)
    ) {
      // WP-015 review round 5 — a computed member read on a capability-bearing
      // object fails closed rather than resolving to `null`. A key that folds to
      // `constructor` is reported by the round-6 rule just above instead, so the
      // construct still yields exactly one finding.
      if (
        ts.isElementAccessExpression(node) &&
        staticMemberName(node) === null &&
        resolvedMemberName(node) !== EVALUATOR_PROPERTY
      ) {
        const objectKind = capabilityOf(node.expression);
        if (objectKind !== null) recordComputedCapabilityAccess(node, objectKind);
      }
      const capability = capabilityOf(node);
      if (
        capability !== null &&
        LOADER_CAPABILITIES.has(capability) &&
        !isAbsorbedCapability(node) &&
        !capabilityIsConsumed(node, capability)
      ) {
        recordCapabilityEscape(node, capability);
      }
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) recordSpecifier(moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) recordSpecifier(expression);
      else recordOpaque(node, "import", expression);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const reflected = reflectedLoaderKind(callee);
      const direct = reflected === null ? capabilityOf(callee) : null;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) {
        recordModuleCall(node, "import", 0);
      } else if (reflected !== null) {
        // `require.call(thisArg, spec)` / `require.apply(thisArg, [spec])`, and
        // the same reflection over `process.getBuiltinModule`.
        recordModuleCall(node, LOADER_CALL_LABELS.get(reflected), 1);
      } else if (LOADER_CALL_LABELS.has(direct)) {
        // `require(spec)` and `process.getBuiltinModule(spec)` — both name a
        // module, and both are classified exactly like an import.
        recordModuleCall(node, LOADER_CALL_LABELS.get(direct), 0);
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
    scopes.push(names.all);
    genuineScopes.push(names.genuine);
    // Alias hoisting runs after this scope's shadow frames are pushed, so a
    // genuine local `require`/`module` here correctly suppresses the capability.
    requireAliasScopes.push(requireAliasNames(node));
    ts.forEachChild(node, visit);
    requireAliasScopes.pop();
    genuineScopes.pop();
    scopes.pop();
  };

  // Document-order pre-pass, so the round-6 rule can fold a computed member key
  // that is spelled through a constant (`const k = "constructor"; f[k](...)`).
  collectConstantStrings(sourceFile);
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

/**
 * The `F-OPAQUE` sentence for one scanner hit. A lookup rather than a ternary
 * chain: round 6 added the sixth kind, and the chain had stopped being readable.
 */
const OPAQUE_MESSAGES = new Map([
  [
    "evaluator",
    (hit, dir) =>
      `references ${hit.form}, which evaluates code no static check can read; in \`${dir}\` rules F1-F8/F11 cannot be evaluated at all for whatever it evaluates`,
  ],
  [
    "evaluator-acquisition",
    (hit, dir) =>
      `reads ${hit.form}; on any function-valued expression that property IS the \`Function\` constructor, so \`x.constructor("…")()\` evaluates arbitrary code and can reconstitute \`require\` — whether the object is a function is not statically decidable, so this fails closed and in \`${dir}\` rules F1-F8/F11 cannot be evaluated at all for whatever it evaluates`,
  ],
  [
    "capability",
    (hit, dir) =>
      `${hit.form}; from there it can load any module by name, so in \`${dir}\` rules F1-F8/F11 cannot be evaluated at all for whatever it loads — and a purity-restricted package has no legitimate use of a module loader`,
  ],
  [
    "capability-computed",
    (hit, dir) =>
      `${hit.form}; a computed member on a module-loading capability is exactly how \`createRequire\` is reached without ever naming it, so in \`${dir}\` rules F1-F8/F11 cannot be evaluated at all for whatever it loads`,
  ],
  [
    "require",
    (hit, dir) =>
      `calls \`require()\` whose specifier is ${hit.form}; in \`${dir}\` the required module must be statically readable, or rules F1-F8/F11 cannot be evaluated at all`,
  ],
  [
    "getBuiltinModule",
    (hit, dir) =>
      `calls \`process.getBuiltinModule()\` whose specifier is ${hit.form}; it loads a Node built-in by name, so in \`${dir}\` that name must be statically readable, or rules F1-F8/F11 cannot be evaluated at all`,
  ],
]);

const OPAQUE_FIXES = new Map([
  [
    "capability",
    "delete the reference; a package under F1/F2/F3 loads no module at run time, and receives every capability it needs as a constructor/StrategyContext argument",
  ],
  [
    "capability-computed",
    "name the member statically — or, better, delete the reference: a package under F1/F2/F3 loads no module at run time",
  ],
  [
    "evaluator-acquisition",
    "delete the reference; a purity-restricted package has no reason to read `.constructor` (declaring a `constructor` member on a class or object literal is untouched by this rule)",
  ],
]);

function opaqueMessage(hit, packageDir) {
  const render = OPAQUE_MESSAGES.get(hit.call);
  return render
    ? render(hit, packageDir)
    : `uses a dynamic \`import()\` whose specifier is ${hit.form}; in \`${packageDir}\` the imported module must be statically readable, or rules F1-F8/F11 cannot be evaluated at all`;
}

function opaqueFix(hit) {
  return (
    OPAQUE_FIXES.get(hit.call) ??
    "import the module statically, or receive the capability through StrategyContext/a constructor argument"
  );
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
            message: opaqueMessage(hit, pkg.dir),
            doc: `${CONTRACT_REL} §6 rule 3; ADR-005 §1`,
            fix: opaqueFix(hit),
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
    lines.push("      import()/require() and no evaluator (eval/Function/.constructor) in a");
    lines.push("      restricted package, every workspace package classified.");
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
  F-OPAQUE  no dynamic import()/require() with a non-static specifier, no
            require capability escaping into a value the check cannot follow, and
            no evaluator — eval/Function, or the .constructor property that hands
            out the Function constructor — in a package whose purity is
            constrained (domain, strategies, ledger, simulation)
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
