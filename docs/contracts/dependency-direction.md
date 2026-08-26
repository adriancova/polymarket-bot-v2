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

Every workspace package belongs to exactly one layer. A package may depend on
packages in a **lower-numbered** layer and on nothing else in the workspace.

### Layer 0 — foundation contracts

| Package | May import |
| --- | --- |
| `packages/decimal` | `decimal.js`, `node:crypto`. Nothing from this workspace. |
| `packages/domain` | `zod`, `packages/decimal`. Nothing else — **not even a Node built-in**. |

`packages/decimal` does **not** import `packages/domain`
(`docs/contracts/domain.md` §2).

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
packages/event-bus        (interface half — see §4)
packages/observability    packages/testkit (test-only)
```

`packages/strategies/**` is a **restricted** member of this layer: see §3.

### Layer 2 — adapters and infrastructure

These own a connection, a wire format, a filesystem, or a process boundary.

```text
packages/polymarket-public   packages/polymarket-secure
packages/binance-adapter     packages/coinbase-adapter
packages/storage-postgres    packages/storage-wal
packages/storage-parquet     packages/event-bus (Redis Streams implementation)
```

### Layer 3 — composition roots

Applications wire the layers together. They are the only place where an adapter
meets an application module.

```text
apps/data-gateway   apps/trader        apps/control-api
apps/research-worker apps/backtest-cli apps/ops-cli
```

Nothing may depend on an app.

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

F3 and F11 are the two that matter most for correctness rather than tidiness:
they are what makes deterministic replay possible (§12.4).

---

## 4. Interface-versus-implementation split

Two boundaries deliberately place an interface in a lower layer than its
implementation:

- **Transport.** The publish/subscribe/checkpoint/retention interface is
  consumed by application code; the Redis Streams implementation is
  infrastructure (§9.1, ADR-003). Consumers depend on the interface. If Redis
  concepts (consumer-group names, stream ids, `MAXLEN` trimming) appear in a
  consumer's types, the boundary has been broken in substance.
- **Execution venue.** `ExecutionVenue`, `Clock`, and `MarketEventSource` (§12.1)
  are the swap points between live and simulated runs. "Everything between event
  input and the `ExecutionVenue` interface is shared" (§12.1). A component that
  branches on "am I in simulation" instead of depending on the interface has
  broken the boundary and, with it, the determinism guarantee (§12.4).

---

## 5. What is already enforced today

| Mechanism | Status |
| --- | --- |
| `packages/domain` imports only `zod` and `@polymarket-bot/decimal`; no Node built-in, no `process`/`globalThis`, no clock, no randomness | **Enforced by construction** in the frozen package; documented in `docs/contracts/domain.md` §2 |
| `packages/decimal` imports only `decimal.js` and `node:crypto` and performs no I/O | **Enforced by construction**; `docs/contracts/domain.md` §1 |
| TypeScript project references and `pnpm` workspace resolution | A package can only import a workspace package it declares as a dependency |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | Run locally and in CI (`.github/workflows/ci.yml`) |

**No automated dependency-direction or cycle check exists yet.** `WP-010`
delivered typecheck, lint, unit tests, dependency vulnerability scanning, and a
compose health job — not a graph check
(`.github/workflows/ci.yml`, `docs/handoffs/WP-010.md`). Until the check in §6
exists, F1–F11 rest on review, on the frozen packages' construction, and on the
determinism golden test.

---

## 6. CI enforcement expectation

Handoff §5.2 requires that **circular package dependencies fail CI**. The check
that satisfies it must do three things, and it is deliberately specified here so
that the owning work package implements the whole rule rather than only the
cycle half:

1. **Cycle detection.** Build the workspace dependency graph from the declared
   `dependencies`/`devDependencies` of every `packages/*`, `packages/strategies/*`,
   and `apps/*` package, and fail on any cycle. Non-zero exit, named cycle in the
   output.
2. **Layer conformance.** Fail on any workspace edge that points from a
   lower-numbered layer to a higher-numbered one, using the §2 assignment table as
   data rather than as prose.
3. **Forbidden-specifier scan.** Fail on any import specifier that violates F1–F8
   and F11 inside the offending package's source — for example `@polymarket/client`
   outside `packages/polymarket-secure`, `node:fs` inside `packages/strategies/**`,
   an archived client anywhere, or `Date.now`/`Math.random` inside a strategy.

Requirements on the check itself:

- It runs as part of the existing gate set, so a violation fails the same
  pipeline as a type error.
- It fails **closed** on an unclassified package: a new package with no layer
  assignment is an error, not a pass. Otherwise the check silently stops covering
  new code, which is the failure mode the `WP-000` review found in a different
  gate (`docs/handoffs/WP-000.md`, round-5 finding on the ungated report
  sections).
- The layer table lives in one place. A test's private copy of the table is
  exactly how coverage drifts.

**Owner: not yet assigned.** The natural home is the workspace-tooling package
that owns root quality gates (`WP-010`'s successor for repository tooling); it is
recorded as follow-up in `docs/handoffs/WP-030.md`, and `WP-010`'s own follow-up
already anticipates it ("Consider automated repository-inventory/path-ownership
validation as tooling in a later work package").

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
