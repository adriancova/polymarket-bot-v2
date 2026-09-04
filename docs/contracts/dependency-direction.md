# Dependency direction and package boundaries

Owner: `WP-030`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §5.1, §5.2, §9.12,
§21
Related: [ADR-005](../adr/ADR-005-strategy-purity-and-decision-result.md)
(strategy purity), [ADR-010](../adr/ADR-010-run-mode-enablement-and-production-key-boundary.md)
(SDK and signer boundary), [`protected-contracts.md`](./protected-contracts.md),
[ADR-020](../adr/ADR-020-schema-parse-boundary-integrity.md) /
[`schema-boundary.md`](./schema-boundary.md) (why §2.1's pending mirror-collapse
row exists)

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

#### Pre-authorised, not yet listed: the `plain-data` / `schema-arena` mirror collapse (ruled 2026-09-04 by `GOV-2A`)

**The ruling is (a): the three byte-identical copies are collapsed to one
canonical implementation behind a same-layer edge. Duplication-with-drift-guard
is NOT ratified as the permanent shape.** `packages/risk`,
`packages/capital-allocator` (`WP-180`, merged `98a6cc1`) and
`packages/execution-planner` (`WP-190`, merged `5aa11e3`) each carry a
byte-identical `src/plain-data.ts` and `src/schema-arena.ts` below their header
markers, guarded three ways by `test/unit/execution-planner/mirrors.test.ts`.

The drift guard proves the three copies are *identical*; it cannot make a fix to
them *atomic*. These modules are the repository's only prototype-free parse door
([ADR-020](../adr/ADR-020-schema-parse-boundary-integrity.md) §3), the mechanism
that closes a class measured to defeat a run-mode ceiling, a `WP-040` ledger
obligation, and every format check in the process. A security mechanism that must
be fixed in three places, in three grants, is the wrong shape for exactly that
mechanism — and `docs/contracts/schema-boundary.md` §5 assigns four more packages
that would otherwise copy it a fourth, fifth, sixth and seventh time.

**Canonical source: `packages/risk`.** It is where `WP-180` authored the
mechanism, it is the package whose review rounds 6-10 established the behaviour,
and both other copies are downstream of it in origin as well as in content.
`packages/execution-planner` already consumes `packages/risk`'s
`ApprovedIntentRecord` shape (`docs/handoffs/WP-190.md` `assumptions` 1), so the
dependency is real rather than invented for code sharing.

**The rows to add, verbatim** (id, edge, layer, basis — one per consumer, because
§2.1 rows are ordered pairs):

```text
S3 | `packages/capital-allocator` → `packages/risk` | 1 |
S4 | `packages/execution-planner` → `packages/risk` | 1 |
basis: GOV-2A 2026-09-04 mirror-collapse ruling (this subsection); ADR-020 §3;
docs/contracts/schema-boundary.md §1. The consumed surface is the prototype-free
parse door only — `plain-data.ts` and `schema-arena.ts` — exported through
packages/risk's `exports` map (F16). No rule, policy, or evaluation logic may
travel this edge; a consumer needing that has found a different problem.
```

**Why they are stated here instead of listed in the table above.** §6.1 item 5
records that `test/unit/tooling/dependency-direction.test.ts` pins the shipping
allowlist ids to exactly `["S0", "S1", "S2"]`. `GOV-2A` reproduced the
consequence mechanically in a `/dev/shm` scratch copy: with S3 and S4 added,
`check:deps` still **PASSES** (34 packages / 41 edges, both rows parsed and
cross-validated against §2), and
`test/unit/tooling/dependency-direction.test.ts:801` **FAILS** (`["S0","S1","S2"]`
vs `["S0","S1","S2","S3","S4"]`). `test/**` is outside a governance round's
scope, so listing the rows here today would break the gate this document exists
to keep. **This is the case §6.1 item 5 predicted**, and its own rule applies:
the row and the pinned assertion move in the **same change**.

**Owner: a bounded `WP-180-FU2` / mirror-collapse package**, with
`allowed_paths` covering `packages/risk/src/{plain-data,schema-arena}.ts`,
`packages/{capital-allocator,execution-planner}/**`,
`test/unit/{risk,capital-allocator,execution-planner}/**`,
`test/unit/tooling/dependency-direction.test.ts`, and this document.
Migration path, in one change: move the two modules into `packages/risk`'s
`exports` map; delete both copies; add the `workspace:*` dependency to each
consumer; move S3/S4 into the table above; update the pinned allowlist
assertion; keep `mirrors.test.ts` as a *deletion* guard (it must fail if a fourth
copy appears) or retire it with its reason recorded. **Acceptance is behavioural,
not structural**: every `WP-180`/`WP-190` pollution battery must still pass
against the single implementation, because the point of collapsing them is that
one fix protects all three — not that the files got shorter.

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

### 2.2 Node built-ins below layer 2: a bounded, enumerated allowlist (ruled 2026-09-04 by `GOV-2A`)

Layers 2 and 3 own connections, filesystems, and process boundaries; a Node
built-in there needs no permission from this document (F1–F8 and F11 still
apply). **Layers 0 and 1 are different**, and until now the rule for them existed
only as `packages/domain`'s blanket ban (F2) and `packages/decimal`'s one-line
allowlist (F15). Four merged layer-1 packages then imported a built-in and each
disclosed it as an open contract question — `WP-180` R6-1 (`node:util` in
`packages/risk` and `packages/capital-allocator`), `WP-190` R1-N2 (a third
package *and* a new non-mirror file), `WP-160` R1-N1 (`node:crypto` in
`packages/features`). This subsection is the ruling those three asked for.

**The rule is an allowlist, not a per-instance ratification.** Ratifying case by
case would have to be re-argued at every new import and gives a reviewer no
criterion; a blanket ban would forbid the two uses below, both of which exist
*because* the alternative is worse. So: a layer-0 or layer-1 package may import a
Node built-in **only if** the imported binding satisfies all five properties and
**the package, specifier, and binding are enumerated in the table below**.

The five properties — a binding must be all of them:

1. **Trap-free** — it cannot run user code. (This is why `util.types.isProxy` is
   here at all: every *reflective* way to detect a `Proxy` runs a trap, so the
   pure-JS alternative is the hazard it exists to avoid.)
2. **Entropy-free** — no randomness, seeded or otherwise (§6 invariant 2, §12.4).
3. **Clock-free** — no wall clock, no monotonic clock (§12.4 determinism, F11).
4. **I/O-free** — no filesystem, socket, child process, or environment read.
5. **Synchronous and pure** — same inputs, same output, no observable side
   effect, no scheduling.

`node:crypto`'s `createHash` qualifies on all five; `randomUUID`, `randomBytes`,
and `generateKeyPair` fail (2). `node:util`'s `types` namespace qualifies;
`util.promisify` and `util.inspect` do not (5, and `inspect` can run getters).
The distinction is per **binding**, not per module, and the table names bindings.

| Package | Layer | Specifier | Binding | Why the alternative is worse | Cited by |
| --- | --- | --- | --- | --- | --- |
| `packages/domain` | 0 | *(none)* | — | F2: not even a built-in. Unchanged by this ruling | `domain.md` §2 |
| `packages/decimal` | 0 | `node:crypto` | `createHash` | F15's existing allowlist, restated here for one table | `domain.md` §1, F15 |
| `packages/risk` | 1 | `node:util` | `types.isProxy` | `src/plain-data.ts:157`. A pure-JS proxy probe *runs a trap*, i.e. executes caller code inside the door that exists to stop caller code running (`plain-data.ts:78-83`) | `WP-180` R6-1 |
| `packages/capital-allocator` | 1 | `node:util` | `types.isProxy` | `src/plain-data.ts:27`. Same mirrored module, same reason | `WP-180` R6-1 |
| `packages/execution-planner` | 1 | `node:util` | `types.isProxy` | `src/plain-data.ts:25` (mirror) **and** `src/pluck.ts:28,58` (the §6 invariant 13 minimal-read cancel path) | `WP-190` R1-N2 |
| `packages/features` | 1 | `node:crypto` | `createHash` | `src/hash.ts:14`. Content addressing needs SHA-256; a hand-rolled FIPS 180-4 implementation in production code is a correctness liability, and `WP-160`'s review used exactly that as an independent *oracle* rather than as the shipped path | `WP-160` R1-N1 |

**The table is exhaustive for layers 0 and 1**, and a package outside it importing
any built-in is a violation (F17). Verified mechanically at `main` `2d7e7da`: a
census of every non-test `node:` import under `packages/` and `apps/` returns
exactly these five files below layer 2 — `packages/{risk,capital-allocator}/src/plain-data.ts`,
`packages/execution-planner/src/{plain-data,pluck}.ts`,
`packages/features/src/hash.ts` — plus `packages/decimal`'s existing one. Every
other `node:` import in the workspace is in a layer-2 package
(`event-bus`, `storage-wal`, `storage-postgres`, `storage-parquet`) or a layer-3
app (`data-gateway`, `ops-cli`, `research-worker`).

**Adding a row is a contract edit with a citation**, exactly like §2.1: name the
binding, walk the five properties, and say what the alternative costs. "It was
convenient" is not a basis, and neither is "another package already imports it."

**Not yet implemented by the §6 check.** F17 joins F15 and F16 as a stated rule
the checker does not evaluate; that is the same single tooling follow-up (§6.1
item 4, and `docs/contracts/schema-boundary.md` §5 item 6). Enforcement today is
this table plus review. The check already reads §2 and §2.1 from this document at
run time, so the natural implementation reads §2.2 the same way rather than
copying the table into the tool — a private copy of this table is exactly how
coverage drifts (§6).

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
| F15 | `packages/decimal` importing anything beyond `decimal.js` and `node:crypto` | `docs/contracts/domain.md` §1 ("Dependencies: `decimal.js` and `node:crypto` only … the package performs no I/O") and §2 of this document (the Layer 0 "May import" cell). Numbered 2026-09-02 (`GOV-1C`) from `docs/handoffs/WP-015.md` `follow_up` 4 via §6.1 item 4 — the allowlist was "enforced by construction" with no F-row, so a violating edit would have been a review finding rather than a gate failure. **Not yet implemented by the §6 check** (the same tooling follow-up as the F14 machine-id swap); until then, enforcement-by-construction and review remain the mechanism |
| F16 | A cross-package **deep import** — any workspace import specifier that resolves inside another workspace package other than through that package's `package.json` `exports` map | `docs/handoffs/WP-015.md` `follow_up` 3 via §6.1 item 4, numbered 2026-09-02 (`GOV-1C`) on the evidence that **every** workspace package (28/28 as of this date) declares an `exports` map, so "bypassing the entry point" is well-defined. Largely platform-enforced already: Node refuses an unexported subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`) and `NodeNext` resolution mirrors it at typecheck — the row exists so a widened `exports` map or a bundler that resolves around encapsulation is a contract violation, not a loophole. **Not yet implemented by the §6 check** (same tooling follow-up) |
| F17 | A **layer-0 or layer-1** package importing a Node built-in binding that §2.2's table does not enumerate for that package | §2.2 (ruled 2026-09-04 by `GOV-2A`), discharging `WP-180` `follow_up` R6-1, `WP-190` R1-N2, and `WP-160` R1-N1, which each disclosed an instance and asked the contract owner to rule rather than ratifying it locally. Generalises F2 (`packages/domain`: none) and F15 (`packages/decimal`: `node:crypto` only) into one criterion — trap-free, entropy-free, clock-free, I/O-free, synchronous and pure — plus an exhaustive per-package enumeration, so a new import is a cited contract edit rather than a reviewer's judgment call. Layers 2 and 3 are **not** constrained by this row. **Not yet implemented by the §6 check** (same tooling follow-up as F15/F16) |

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
3. **The id `F-OPAQUE`, which predates the number, is an accepted alias for
   F14.** *(State updated 2026-09-02 by `GOV-1C`, discharging the tooling half
   of `GOV-1B` `follow_up` 5 to the extent a governance round can.)* The
   check's **human-readable findings now lead with `FAIL [F14]`**, each
   carrying an `id:` traceability line naming the alias, and its JSON report
   carries **both** ids (`contractRule: "F14"` alongside the machine field
   `rule: "F-OPAQUE"`). The machine `rule` field was **not** renamed, because
   `test/unit/tooling/dependency-direction.test.ts` pins the alias
   structurally (`entry.rule === "F-OPAQUE"` and `FAIL [F-OPAQUE]` output
   assertions, 30+ sites) and test paths are outside a governance round's
   scope — swapping the machine field and that suite **in one change** is the
   remaining tooling follow-up. Until it lands, a JSON consumer keys on
   `rule: "F-OPAQUE"` or `contractRule: "F14"`; both are stable, and this row
   is the citation for both spellings.

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
| `packages/decimal` imports only `decimal.js` and `node:crypto` and performs no I/O | **Enforced by construction**; `docs/contracts/domain.md` §1. Numbered **F15** in §3 (2026-09-02); not yet evaluated by the §6 check |
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

### 6.1 Contract-owner items about this document (ruled 2026-09-02)

Recorded here so they are owned rather than remembered. Each is a question
`WP-015` raised and deliberately did **not** answer, because answering it means
adding or changing a numbered rule in this document. *(Status column ruled
2026-09-02 by `GOV-1C`, the contract-owner round `GOV-1B` `follow_up` 6
assigned; the item descriptions are kept verbatim as history.)*

| # | Item | Status |
| --- | --- | --- |
| 1 | **The positive callee-resolution rule** (`WP-015` `follow_up` 8): "a purity-restricted package's source may contain no call whose callee does not statically resolve to a declared import binding or a known-pure local." It is the **durable** fix for F14's residuals — reflective acquisition (`Reflect.get(process, "mainModule").require(…)`), runtime-computed member names, and cross-file capability injection — because it is total over what the walk sees regardless of which loader or evaluator the callee names, ending the "add the one spelling the last round missed" pattern that rounds 3–9 each repeated | **RULED 2026-09-02 (`GOV-1C`): NOT adopted, with a binding tripwire.** Not adopted because the frozen `packages/domain` itself dispatches dynamically as a matter of design — every `schema.parse(...)`, registry lookup, and structural-contract callback is a call whose callee is a parameter or property value, not "a declared import binding or a known-pure local" — so the rule as drafted floods the one package it most needs to protect, and a rule that must be waived wholesale for existing frozen code enforces nothing. What is adopted instead is the **tripwire**: the next F14-class escape spelling found that the existing enumerations do not catch is closed by adopting a total rule (this one, or an equivalent), **in the closing change, as a mandatory §3 row with its noise trade-off stated** — declining a second time is not available. Until the tripwire fires, F14's noisy-never-silent floor plus review is the accepted mechanism, and the residuals stay disclosed (item 3) |
| 2 | **Does rule 3 apply to a strategy package's own test files?** (`WP-015` `follow_up` 2, its `assumptions` 6 / risk 3) | **RULED 2026-09-02 (`GOV-1C`): YES — test files inside a purity-restricted package are in scope**, which documents the checker's shipped behavior as the decision rather than an accident. Reasons: a strategy test that reads a real clock or unseeded randomness is exactly the nondeterminism §12.4 exists to exclude, and the repository already has the sanctioned alternatives (injected manual clocks and seeded sources — the `WP-120`/`WP-140` test pattern; fixtures enter as imported modules or inline literals, not `node:fs` reads). Consequence for `WP-220` and every later strategy package: write tests under the same purity rules as the strategy; a genuine need that cannot be met that way is a **cited change to this document first** (a scoped exemption row with its boundary stated), never a checker workaround |
| 3 | **Should a computed property read whose key cannot be statically folded fail closed inside a restricted package?** (`WP-015` `follow_up` 9) | **RULED 2026-09-02 (`GOV-1C`): it stays non-fail-closed**, preserving the accepted `WP-015` ruling that `table[key]` on a non-capability object adds no noise — overturning that would flag ordinary data-table dispatch throughout restricted packages, which is item 1's noise trade-off arriving by another door. The residual (`f[parts.join("")]` as a route to `.constructor`) remains **disclosed, accepted, and covered by item 1's tripwire**: an actual escape through it fires the tripwire and forces the total rule |
| 4 | **A cross-package *deep* import** (bypassing a package's `exports` entry point) has no §3 row (`WP-015` `follow_up` 3), and `packages/decimal`'s documented import allowlist (§5) is "enforced by construction" with no F-row either (`follow_up` 4) | **CLOSED 2026-09-02 (`GOV-1C`) by writing the rows: §3 F15** (the `packages/decimal` allowlist; basis `domain.md` §1) **and §3 F16** (no cross-package deep import around an `exports` map; basis: all 28 workspace packages declare one, and Node/`NodeNext` already refuse unexported subpaths). Neither is implemented in the §6 check yet — that is the same single tooling follow-up as the F14 machine-id swap, and per this item's own rule the cited rows now exist **before** any implementation |
| 5 | **The §2.1 allowlist is pinned by a test.** `test/unit/tooling/dependency-direction.test.ts` asserts the shipping allowlist ids are exactly `["S0", "S1", "S2"]` | **Recorded, not a defect — reviewed 2026-09-02 (`GOV-1C`) and it stands unchanged.** The first package that adds a §2.1 row updates that assertion in the same change; a contract edit alone would fail `pnpm test`. Noted because a governance round that adds rows and a tooling package that owns the test are usually not the same package — exactly the constraint the F14 machine-id swap hit (§3 F14, consequence 3) |

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
