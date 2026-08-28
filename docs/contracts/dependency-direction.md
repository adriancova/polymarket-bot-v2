# Dependency direction and package boundaries

Owner: `WP-030`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §5.1, §5.2, §9.12,
§21
Related: [ADR-005](../adr/ADR-005-strategy-purity-and-decision-result.md)
(strategy purity), [ADR-010](../adr/ADR-010-run-mode-enablement-and-production-key-boundary.md)
(SDK and signer boundary), [`protected-contracts.md`](./protected-contracts.md)

---

## 1. The rule

Handoff §5.2 permits exactly one direction:

```text
adapters / infrastructure
        ↓
application modules
        ↓
domain contracts and decimal types
```

and forbids, verbatim:

```text
packages/domain importing adapters, PostgreSQL, Redis, SDKs, or process globals
strategies importing venue clients, Redis, PostgreSQL, or filesystem APIs
ledger importing strategy implementations
simulation importing a live signer

Circular package dependencies fail CI.
```

Handoff §21 makes it a definition-of-done item: a work package is complete only
when "No forbidden dependency direction is introduced."

---

## 2. Layers

Every workspace package belongs to **exactly one** layer. No package appears
twice. Given that assignment, a workspace edge `A → B` (A declares B as a
`dependency` or `devDependency`) is:

| Relationship | Verdict |
| --- | --- |
| `layer(B) < layer(A)` | **Permitted** — this is the §5.2 direction. |
| `layer(B) > layer(A)` | **Forbidden**, always (F12). An upward edge inverts §5.2. |
| `layer(B) = layer(A)` | **Permitted only if the edge is listed in §2.1**, and only while the whole workspace graph stays acyclic (F9, F13). |

Same-layer edges are permitted rather than banned because a blanket ban would
forbid edges the work plan intends — `packages/strategy-runtime` must invoke the
strategy interface that `packages/strategy-sdk` declares, and `WP-170` owns both.
They are enumerated rather than free because an unenumerated same-layer edge is
how a layer quietly becomes a single blob and how a cycle appears.

### Layer 0 — foundation contracts

| Package | May import |
| --- | --- |
| `packages/decimal` | `decimal.js`, `node:crypto`. Nothing from this workspace. |
| `packages/domain` | `zod`, `packages/decimal`. Nothing else — **not even a Node built-in**. |

Both sit in layer 0, so `packages/domain` → `packages/decimal` is a **same-layer**
edge and is listed in §2.1 as **S0**. It is acyclic by contract: `packages/decimal`
does **not** import `packages/domain` (`docs/contracts/domain.md` §2, "sits one
level below … and does not import it").

### Layer 1 — application modules

Pure-ish logic over layer 0. These own rules, state machines, and computation;
they do not own connections.

```text
packages/order-book       packages/features        packages/strategy-sdk
packages/strategy-runtime packages/capital-allocator
packages/risk             packages/execution-planner
packages/oms              packages/inventory
packages/ledger           packages/pnl
packages/universe         packages/settlement
packages/simulation       packages/config
packages/observability    packages/testkit (test-only)
packages/strategies/**    (class entry: every concrete strategy package)
```

The `packages/strategies/**` **class entry** above is restricted further than any
other layer-1 package — F3 and F11 in §3 — and it is stated **inside the fence**
so the §6 check reads it from the same shape as every other assignment. Each
concrete strategy package it matches is classified layer 1; a class matching zero
packages is not an error (§6). *(Moved from prose into the fence 2026-08-28 by
`GOV-1B`, closing `docs/handoffs/WP-015.md` `follow_up` 1. The parser also
accepts the prose form `` `<path>` … member of this layer ``, and that phrasing
must now stay out of §2, because a package assigned twice — even to the same
layer — is a `CHK` error by design.)*

### Layer 2 — adapters and infrastructure

These own a connection, a wire format, a filesystem, or a process boundary.

```text
packages/polymarket-public   packages/polymarket-secure
packages/binance-adapter     packages/coinbase-adapter
packages/storage-postgres    packages/storage-wal
packages/storage-parquet     packages/event-bus
```

`packages/event-bus` sits here **as a whole package**. `WP-060` owns
`packages/event-bus/**` and delivers both the transport interface and the Redis
Streams publisher/consumer in it (work plan `WP-060`), so the package declares a
Redis client and meets this layer's definition. It is not split across layers;
see §4 for what that does and does not imply.

### Layer 3 — composition roots

Applications wire the layers together. They are the only place where an adapter
meets an application module.

```text
apps/data-gateway   apps/trader        apps/control-api
apps/research-worker apps/backtest-cli apps/ops-cli
```

Nothing may depend on an app.

### 2.1 Permitted same-layer edges

This table is **exhaustive**. A same-layer workspace edge that is not listed here
is a violation (F13), and the fix is to add a row with a citation — never to
relax the check. Every row must name the work-plan or handoff text that
establishes the edge; "it compiles more easily this way" is not a basis.

| # | Edge | Layer | Basis |
| --- | --- | --- | --- |
| S0 | `packages/domain` → `packages/decimal` | 0 | Already shipped and frozen: `packages/domain/package.json` declares `@polymarket-bot/decimal` as a `workspace:*` dependency, and `docs/contracts/domain.md` §1 fixes it ("Dependencies: `zod` and `@polymarket-bot/decimal`. Nothing else."). Handoff §7.3 makes the domain boundary types decimal strings. Acyclic by contract: `docs/contracts/domain.md` §2 states "`packages/decimal` sits one level below `packages/domain` and does not import it," so the reverse edge is forbidden, not merely absent. |
| S1 | `packages/strategy-runtime` → `packages/strategy-sdk` | 1 | `WP-170` owns both paths and delivers "strategy interface", "context implementation", and "runtime and watchdog" together; its acceptance criterion "Runtime persists exactly one decision per callback" requires the runtime to invoke the SDK-declared callback (work plan `WP-170`; ADR-005 §2, §6). |
| S2 | `packages/strategies/*` → `packages/strategy-sdk` (each concrete strategy package, e.g. `packages/strategies/static-bracket`) | 1 | A strategy implements the `WP-170` interface and receives `StrategyContext` — which ADR-005 §6 places in `WP-170`, not in `packages/domain` — and ADR-005 §1 forbids it from obtaining any of that by I/O. `WP-220` (`packages/strategies/static-bracket/**`) `depends_on` `WP-170` and is forbidden from modifying it, so it consumes it. If `WP-170` declares the interface in `packages/strategy-runtime` instead, this row must be corrected rather than widened. |

Nothing else is enumerated yet, and that is deliberate: the check **fails closed**
(§6), so the first package that genuinely needs a new same-layer edge adds its
row. Two known cases will need one and do not have a citation today:

- **`packages/testkit`.** It is layer 1 and test-only. The first layer-1 package
  that takes a `devDependency` on it creates a same-layer edge. The handoff names
  the package (§5 layout) but specifies nothing about it, so no row can be
  written on evidence yet; the owning work package writes it.
- **The `ExecutionVenue` / `Clock` / `MarketEventSource` interfaces** (handoff
  §12.1). The handoff does not say which package declares them. If they land in a
  layer-1 package, then `packages/simulation` implementing `ExecutionVenue`
  (`WP-210`) is a same-layer edge needing a row; if they land lower, it is an
  ordinary downward edge. `WP-190`/`WP-210` settle it.

---

## 3. Forbidden edges, stated concretely

| # | Forbidden | Source |
| --- | --- | --- |
| F1 | `packages/domain` importing an adapter, PostgreSQL, Redis, an SDK, or a process global (`process`, `globalThis`, env, clock, randomness) | §5.2 |
| F2 | `packages/domain` importing **any** Node built-in, including `node:crypto` | `docs/contracts/domain.md` §2 |
| F3 | `packages/strategies/**` importing a venue client, Redis, PostgreSQL, or a filesystem API | §5.2, §6 invariant 2, ADR-005 |
| F4 | `packages/ledger` importing a strategy implementation | §5.2 |
| F5 | `packages/simulation` importing a live signer | §5.2 |
| F6 | Any package other than `packages/polymarket-secure` importing `@polymarket/client` | §9.12, ADR-010 §4 |
| F7 | Any package importing an archived Polymarket client (`@polymarket/clob-client`, `@polymarket/clob-client-v2`, `@polymarket/builder-relayer-client`, `@polymarket/builder-signing-sdk`) | `docs/venue/verified-2026-08-24.md` §1 (official migration guide instructs their removal; `WP-000` ruled them forbidden) |
| F8 | Any package outside `packages/event-bus` importing a Redis client for market-event transport | §2, ADR-003 §1 |
| F9 | Any cycle between workspace packages | §5.2 ("Circular package dependencies fail CI") |
| F10 | Any package depending on an `apps/*` package | §5 layout; apps are composition roots |
| F11 | A strategy reading a clock or unseeded randomness (`Date.now`, `Math.random`) | §6 invariant 2, §7.6, ADR-005 §1 |
| F12 | Any workspace edge from a lower-numbered layer to a higher-numbered one | §5.2 (the allowed direction is one-way), §2 of this document |
| F13 | Any **same-layer** workspace edge not listed in §2.1 | §2, §2.1 of this document |
| F14 | Inside a **purity-restricted** package (`packages/domain`, `packages/strategies/**`, `packages/ledger`, `packages/simulation`), any construct that makes F1–F8/F11 **unevaluable**: a module load whose specifier is not a static literal; a reference to a module-**loading capability** (`require` and its aliases, a CommonJS `Module` object incl. `process.mainModule`/`require.main`, `createRequire` and its result, `process.getBuiltinModule`, the `node:module` namespace/`Module` class/`register`) in a position that escapes this document's analysis; a computed member read on such a capability; and a reference to an **evaluator** (`eval`, `Function`, or a read of the `.constructor` property) | §5.2 and ADR-005 §1, read as intent rather than as a list of spellings: a package forbidden to perform I/O has no legitimate use for a module loader or an evaluator, and a construct that defeats static checking cannot be permitted to *establish* compliance. Numbered 2026-08-28 (`GOV-1B`) from `docs/handoffs/WP-015.md` `follow_up` 6 |

F3 and F11 are the two that matter most for correctness rather than tidiness:
they are what makes deterministic replay possible (§12.4).

F12 and F13 are the layer model restated as edge rules so that §6's check has
something mechanical to evaluate; they are not additional policy.

**F14 is additional policy, and is stated as such.** It was invented by the §6
check under review pressure (`WP-015` rounds 1–6) and rested on that package's
handoff alone; `WP-015` `follow_up` 6 asked the contract owner to either number
it or drop it. It is numbered here, with three deliberate consequences:

1. **It forbids *holding* the capability, not only using it.** A restricted
   package may not reference a module loader at all, even without loading
   anything forbidden with it. The weaker rule ("do not load a forbidden
   module") is unenforceable, because rounds 3–9 each found one more legal
   spelling that loaded a module while naming none.
2. **It is deliberately noisy for contrived-but-legal wrapping.** A finding does
   not prove a forbidden module was loaded, only that the check can no longer
   prove one was not. The trade is *noisy, never silent*, and it costs nothing in
   practice because the constructs it flags have no legitimate use in a package
   that may not perform I/O.
3. **The check emits this rule under the id `F-OPAQUE`**, which predates the
   number. The id is an accepted alias for F14; renaming it in
   `tools/check-dependency-direction.mjs` and its tests is a **tooling
   follow-up**, not a contract change, and this row is the citation that rule
   was missing either way.

Two ids the check emits are **not** rules of this section: `F-CLOSED`, which is
§6's fail-closed behavior (an unclassified package, or a §2 named entry with no
manifest), and `CHK`, which is a broken contract parse or an unparseable source
file.

---

## 4. Interface-versus-implementation discipline

Two boundaries are defined by an interface with a swappable implementation. That
is an **API-surface** rule, not a second layer assignment: a package still sits in
exactly one layer (§2).

- **Transport.** `packages/event-bus` exposes the publish / subscribe / consumer-
  checkpoint / bounded-retention interface and contains the Redis Streams
  implementation behind it (§9.1, ADR-003 §1). The whole package is layer 2. Its
  consumers are the composition roots: the gateway publishes and the trader
  consumes (handoff §4 architecture diagram, §9.1), and both are layer-3 apps
  depending downward, so no upward edge is needed and none is permitted. If Redis
  concepts (consumer-group names, stream ids, `MAXLEN` trimming) surface in a
  consumer's types, the boundary has been broken in substance even though the
  layer check passes. **If a layer-1 application module ever needs the transport
  interface directly, the answer is to extract the interface into a lower-layer
  package by ADR amendment — not to reclassify `event-bus` and not to permit an
  upward edge.**
- **Execution venue.** `ExecutionVenue`, `Clock`, and `MarketEventSource` (§12.1)
  are the swap points between live and simulated runs. "Everything between event
  input and the `ExecutionVenue` interface is shared" (§12.1). A component that
  branches on "am I in simulation" instead of depending on the interface has
  broken the boundary and, with it, the determinism guarantee (§12.4). The handoff
  does not say which package declares these interfaces; whichever package does
  must be classified in §2 and any resulting same-layer edge listed in §2.1.

---

## 5. What is already enforced today

| Mechanism | Status |
| --- | --- |
| `packages/domain` imports only `zod` and `@polymarket-bot/decimal`; no Node built-in, no `process`/`globalThis`, no clock, no randomness | **Enforced by construction** in the frozen package; documented in `docs/contracts/domain.md` §2 |
| `packages/decimal` imports only `decimal.js` and `node:crypto` and performs no I/O | **Enforced by construction**; `docs/contracts/domain.md` §1 |
| TypeScript project references and `pnpm` workspace resolution | A package can only import a workspace package it declares as a dependency |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | Run locally and in CI (`.github/workflows/ci.yml`) |
| **The §6 check itself** — cycles (F9), layer conformance (F12/F13), forbidden specifiers and impure globals (F1–F8, F11), and the opaque-construct rule (F14) | **Implemented and CI-wired.** `tools/check-dependency-direction.mjs`, run by the root script `check:deps` and by the "Dependency direction and package boundaries" step in `.github/workflows/ci.yml`, between the lint and unit-test steps. It parses §2 and §2.1 from **this document** at run time (§6) and fails closed on a contract it cannot parse |

*(Corrected 2026-08-28 by `GOV-1B`, closing `docs/handoffs/WP-015.md`
`follow_up` 7.)* This section previously said "**No automated
dependency-direction or cycle check exists yet**" and that "nothing today
evaluates the §2 layer assignment or the §2.1 edge list". Both statements were
true when written — `WP-010` delivered typecheck, lint, unit tests, dependency
vulnerability scanning, and a compose health job, but no graph check — and both
became false when **`WP-015`** shipped and merged the check. They are corrected
in place rather than left standing, per
[`protected-contracts.md`](./protected-contracts.md) §4.

What still rests on review rather than on the check is stated in §6's limits
paragraph, not here: the check is a floor over enumerated library names and
recognised loader spellings, not a proof.

---

## 6. CI enforcement: the specification, and the check that implements it

Handoff §5.2 requires that **circular package dependencies fail CI**. The check
that satisfies it must do three things, and it is deliberately specified here so
that the owning work package implements the whole rule rather than only the
cycle half.

**This section is no longer only an expectation.** `WP-015` implemented it as
`tools/check-dependency-direction.mjs`, wired to the root script `check:deps`
and to a CI step of its own (§5). The specification below is unchanged and is
still the authority; what follows it is now a description of something that
runs. **Owner: `WP-015`** (merged). Residual questions the check raised for this
document are collected in §6.1.

It consumes two pieces of data, both of which live **only** here: the §2 layer
assignment (package → layer, total and single-valued) and the §2.1 permitted-
same-layer-edge list (an exhaustive set of ordered pairs). It builds one graph and
runs three rules over it.

**Graph construction.** Nodes are every `packages/*`, `packages/strategies/*`, and
`apps/*` workspace package. Edges are the declared workspace
`dependencies`/`devDependencies` of each (`workspace:` specifiers), directed from
dependent to dependency. The **workspace root** `package.json` is not a layered
node: it owns root tooling, and its `@polymarket-bot/testkit` devDependency is a
root-gate wiring detail, not an inter-package edge.

**The graph as of 2026-08-28** (verified by running the check; it reports the
counts itself): **34 workspace packages, 11 layered edges**, and it passes. The
distribution matters more than the total — every edge except one is an ordinary
downward edge:

| Edge | Layers | Verdict |
| --- | --- | --- |
| `packages/domain` → `packages/decimal` | 0 → 0 | the §2.1 **S0** same-layer edge |
| `apps/ops-cli` → `packages/decimal` (`devDependency`) | 3 → 0 | downward (Wave 0 closeout finding M5: the venue-fixture canonical-decimal grammar is tested against the frozen one) |
| `packages/event-bus` → `packages/domain` | 2 → 0 | downward (`WP-060`) |
| `packages/storage-postgres` → `packages/decimal`, `packages/domain` | 2 → 0 | downward (`WP-040`) |
| `packages/polymarket-public`, `packages/binance-adapter`, `packages/coinbase-adapter` → `packages/decimal`, `packages/domain` (2 each) | 2 → 0 | downward (`WP-070`, `WP-080`, `WP-090`) |

**Finding of fact, batch 1B (recorded 2026-08-28 by `GOV-1B`):** the three
adapters merged in Wave 1 batch 1B created **no same-layer edge**. Each declares
exactly `@polymarket-bot/decimal` and `@polymarket-bot/domain` (both layer 0) as
`dependencies`, and **none takes a `devDependency` on `packages/testkit` or on
any other layer-2 package** — their `devDependencies` are `@types/node`,
`typescript`, and `vitest`, none of which is a workspace member. **No §2.1 row is
therefore added**, and the `packages/testkit` case flagged under §2.1 remains
unevidenced and unwritten.

*(This paragraph replaces a 2026-08-26 statement that the repository declared
"three `workspace:*` dependencies" and that "the layered graph has exactly two
edges", which the check now contradicts by direct count. Corrected in place per
[`protected-contracts.md`](./protected-contracts.md) §4. The original point still
holds and is worth keeping: the spec was written before the graph got
interesting, and it did not have to change when it did.)*

1. **Cycle detection.** Fail on any cycle in that graph. Non-zero exit, named
   cycle in the output. This is the rule §5.2 states literally, and it is what
   makes same-layer edges safe to permit at all (F9).
2. **Layer conformance**, evaluated per edge `A → B` against §2 and §2.1:
   - `layer(B) < layer(A)` → **pass**.
   - `layer(B) > layer(A)` → **fail** (F12), reporting both packages and both
     layers.
   - `layer(B) = layer(A)` and the ordered pair `(A, B)` is in §2.1 → **pass**.
   - `layer(B) = layer(A)` and the pair is **not** in §2.1 → **fail** (F13), with
     a message that names §2.1 as the place to add a cited row.
   - Either package unclassified in §2 → **fail** (see fail-closed below).
   `packages/strategies/**` is layer 1 for this rule; F3 and F11 constrain it
   further and are checked by rule 3, not here.
3. **Forbidden-specifier scan.** Fail on any import specifier that violates F1–F8
   and F11 inside the offending package's source — for example `@polymarket/client`
   outside `packages/polymarket-secure`, `node:fs` inside `packages/strategies/**`,
   an archived client anywhere, or `Date.now`/`Math.random` inside a strategy.
   This rule reads source, not `package.json`, because a bare `node:` import
   appears in neither dependency list.

Requirements on the check itself:

- It runs as part of the existing gate set, so a violation fails the same
  pipeline as a type error.
- It fails **closed** on an unclassified package: a package present in the
  workspace but absent from §2 is an error, not a pass. Otherwise the check
  silently stops covering new code, which is the failure mode the `WP-000` review
  found in a different gate (`docs/handoffs/WP-000.md`, round-5 finding on the
  ungated report sections). The mirror also holds, so the table cannot rot
  unnoticed, and it is stated as two rules because §2 contains two kinds of
  entry:
  - **A named entry** (every `packages/*` and `apps/*` row) must resolve to a
    workspace package with a `package.json`. If it does not, that is an error:
    the table is describing a package that does not exist.
  - **A class entry** — `packages/strategies/*` — matches zero or more concrete
    strategy packages, and **each match is classified layer 1** (rule 2 above).
    A class matching zero packages is not an error; a package it matches is
    **not** exempt from classification. As of 2026-08-26 it matches exactly one
    live workspace member, `packages/strategies/static-bracket`, whose
    `package.json` is the `WP-010` scaffold (`pnpm-workspace.yaml` includes
    `packages/strategies/*`, and `pnpm install` reports 35 workspace projects).
    Its *implementation* arrives with `WP-220`; its *manifest* is already in the
    graph, so the check evaluates it today — it declares no `workspace:*`
    dependency yet, so it contributes a node and no edge, and the S2 row in §2.1
    is what will permit its `packages/strategy-sdk` edge when `WP-220` adds it.

  (Corrected 2026-08-26, Wave 0 closeout finding M6: this bullet previously
  exempted `packages/strategies/*` from the mirror rule on the stated basis that
  `packages/strategies/static-bracket` "is a directory with no `package.json`
  today". That was false when written — `WP-010` scaffolded the manifest — and an
  exemption resting on a false fact would have let a real workspace member sit
  permanently outside the layer check.)
- It fails **closed** on same-layer edges, per rule 2. §2.1 is exhaustive by
  construction; widening it is a documented, cited edit reviewed like any other
  contract change.
- The layer table and the §2.1 edge list live in one place — this document — and
  the check parses them or is generated from them. A test's private copy of either
  table is exactly how coverage drifts.

**The shapes the check parses**, stated here because §2 and §2.1 are now *input
to a program* and an editor needs to know what will still be read (added
2026-08-28, `WP-015` `follow_up` 1):

| Where | Shape that assigns a package |
| --- | --- |
| §2, a `### Layer <n> — …` subsection | a backticked path in the **first cell** of a table row (Layer 0), a path token inside a **fenced block** (Layers 1–3, including the `packages/strategies/**` class entry), or the prose form `` `<path>` … member of this layer `` |
| §2.1 | a table row after the header separator, with **at least three cells**: id, `` `from` → `to` `` (either arrow spelling), and a **numeric** layer |

Two edit hazards follow directly, and both fail the gate rather than degrading
silently: assigning one package **twice** — even to the same layer, and even by
stating it in a fence *and* in the prose form — is a `CHK` error; and a §2.1 row
whose edge, layer, or endpoints do not parse and cross-validate against §2 is a
`CHK` error, not a skipped row.

**Owner: `WP-015`** (merged; `tools/check-dependency-direction.mjs` and its unit
suite). *(Corrected 2026-08-28 by `GOV-1B`, closing `docs/handoffs/WP-015.md`
`follow_up` 7. This paragraph previously read "**Owner: not yet assigned**" and
pointed at a hypothetical successor to `WP-010`.)* Ongoing maintenance the
check's own limits impose stays distributed: every package owner adds a new
filesystem, database, network, or signing dependency to the matching catalogue in
that file **in the same change** (`WP-015` `follow_up` 5), because the catalogues
are enumerations and cannot infer a library's nature from its name.

### 6.1 Open contract-owner items about this document

Recorded here so they are owned rather than remembered. Each is a question
`WP-015` raised and deliberately did **not** answer, because answering it means
adding or changing a numbered rule in this document.

| # | Item | Status |
| --- | --- | --- |
| 1 | **The positive callee-resolution rule** (`WP-015` `follow_up` 8): "a purity-restricted package's source may contain no call whose callee does not statically resolve to a declared import binding or a known-pure local." It is the **durable** fix for F14's residuals — reflective acquisition (`Reflect.get(process, "mainModule").require(…)`), runtime-computed member names, and cross-file capability injection — because it is total over what the walk sees regardless of which loader or evaluator the callee names, ending the "add the one spelling the last round missed" pattern that rounds 3–9 each repeated | **OPEN, and deliberately not implemented on 2026-08-28.** It needs a numbered §3 rule *and* it carries a real noise trade-off: it flags every dynamically-dispatched call inside a restricted package. That is contract-level policy about how those packages may be written, not a tooling preference, so it is not adopted as a side effect of numbering F14. Whoever adopts it writes the §3 row, states the noise trade-off, and only then extends the check |
| 2 | **Does rule 3 apply to a strategy package's own test files?** (`WP-015` `follow_up` 2, its `assumptions` 6 / risk 3) | **OPEN.** Today the scan does not distinguish them. A strategy's test may legitimately need a clock or a fixture loader that ADR-005 §1 forbids the strategy itself; until this is ruled, the answer is the checker's current behavior, not a documented decision. `WP-220` will hit it first |
| 3 | **Should a computed property read whose key cannot be statically folded fail closed inside a restricted package?** (`WP-015` `follow_up` 9) | **OPEN.** Today it does not, which leaves `f[parts.join("")]` as a route to `.constructor`; closing it would overturn the accepted ruling that `table[key]` on a non-capability object adds no noise. The two rulings are in genuine tension and only this document can settle it — item 1 above subsumes it |
| 4 | **A cross-package *deep* import** (bypassing a package's `exports` entry point) has no §3 row (`WP-015` `follow_up` 3), and `packages/decimal`'s documented import allowlist (§5) is "enforced by construction" with no F-row either (`follow_up` 4) | **OPEN.** Both are candidate §3 rows; neither may be implemented in the check before it has a cited row here |
| 5 | **The §2.1 allowlist is pinned by a test.** `test/unit/tooling/dependency-direction.test.ts` asserts the shipping allowlist ids are exactly `["S0", "S1", "S2"]` | **Recorded, not a defect.** The first package that adds a §2.1 row updates that assertion in the same change; a contract edit alone would fail `pnpm test`. Noted because a governance round that adds rows and a tooling package that owns the test are usually not the same package |

---

## 7. Adding a dependency

1. **Prefer no dependency.** "Do not add a framework merely because a subagent
   prefers it. Every dependency in the live trading process must have a concrete
   purpose" (§2.1).
2. Add it to the **owning package's** `package.json`, never to the root, unless
   the root genuinely owns the tool.
3. `pnpm-lock.yaml` is a **protected path**. A mechanical lockfile update caused
   by adding a declared dependency to an owned package needs the ratification
   described in [`protected-contracts.md`](./protected-contracts.md) §5 — this is
   the `WP-020` precedent.
4. A new dependency in `packages/domain` or `packages/decimal` is a **contract
   change** and needs an ADR (`docs/contracts/domain.md` §9).
5. Version pinning for the venue SDK is deferred to `WP-260`; the published
   `@polymarket/client` version is currently **unverified**
   (`docs/venue/verified-2026-08-24.md` §12, item U-7), and no SDK dependency
   exists in this repository today.
6. Dependency lockfiles and vulnerability scanning run in CI (§15); both are
   already wired (`.github/workflows/ci.yml`).

---

## 8. Path ownership is a separate rule

Dependency direction says what a package may **import**. Path ownership says what
a work package may **modify**. They are independent, and both apply:

- "Each work package declares allowed paths. A subagent must not modify another
  package's owned path without orchestrator approval. Shared contracts in
  `packages/domain`, database migrations, and root configuration are protected
  integration surfaces" (§5.1).
- "Never allow two agents to edit the same paths concurrently" (`AGENTS.md`).

See [`protected-contracts.md`](./protected-contracts.md).
