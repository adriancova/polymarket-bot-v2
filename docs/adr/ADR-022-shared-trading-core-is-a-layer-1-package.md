# ADR-022: The shared trading core is a layer-1 package that both composition roots build

- **Status:** Accepted
- **Date:** 2026-09-28
- **Recorded by:** `H8-GOV`, an orchestrator-authorized governance round in the
  [`protected-contracts.md`](../contracts/protected-contracts.md) §3.1
  bounded-repair shape. It records the user's ruling **H8** (option A,
  2026-09-28).
- **Implemented by:** CORE-MOVE (pending), BACKTEST-2 (pending). **No
  implementation exists yet.** At this record's date the core still lives in
  `apps/trader/src`, and this ADR changes no code. `CORE-MOVE` moves the core;
  `BACKTEST-2` makes the backtest executable build it and closes blocker B3.
- **Supersedes / Superseded by:** none. It refines handoff §4.1 and §5 as a
  reading, not an edit (D2). It amends
  [`dependency-direction.md`](../contracts/dependency-direction.md) §2 and
  §2.1 through text staged by `H8-GOV` and activated by `CORE-MOVE`
  (D8).
- **Handoff sections:** §2, §4, §4.1, §5, §5.2, §6 (invariant 17), §8.1, §11,
  §12.1, §12.4, §14.2

*Line numbers below are at `a8a3a63`, this round's base. The handoff has never
been edited since the seed commit `58fe7ee`, so its line numbers are stable.
`H8-GOV`'s own edits shift the later lines of `dependency-direction.md` and of
the work plan. For those files, the section or entry named beside each number
is the durable reference.*

## Context

1. **The handoff fixes one core.**
   - §2 (`docs/spec/polymarket-bot-orchestrator-handoff.md:123`) says:
     "Simulation | Same strategy and core engine code; only clock, event
     source, and execution venue are swapped".
   - §8.1 (:672) says: "The trader uses one deterministic core event loop".
   - §12.1 (:1428) says: "Everything between event input and the
     `ExecutionVenue` interface is shared."
   - §4's diagram draws one core box,
     `subgraph CORE[Single Active Trading Process]` (:224). The live
     publisher feeds it (`PUB --> CORE`, :222), and so does the replay path
     (`PARQUET --> REPLAY`, `REPLAY --> SIM`, `SIM --> CORE`, :259-261).
   - §0.1 (:32) wants the first trading deliverable to run "through the same
     strategy, risk, execution-planning, OMS, ledger, and PnL paths later used
     for real orders".
2. **The work plan pulls two ways.**
   - `WP-210`'s goal promises the core from the replay side: "Execute the same
     core logic against historical/live data …" (work plan :817). Its paths
     include `apps/backtest-cli/**` (:821).
   - `WP-230` assigns the assembly to the trader: its goal is "Assemble books,
     features, strategy runtime, risk, planner, simulation, and ledger in the
     trader process" (:883), its path is `apps/trader/**` (:886), and its
     deliverable is "deterministic core event loop" (:906).
   - `WP-230` ran, so the only composition in the repository is
     `createPaperTrader` (`apps/trader/src/trader.ts:173`) and `CoreLoop`
     (`apps/trader/src/loop.ts:490`).
3. **The dependency contract forbids the one edge that would let the backtest
   root build that composition.**
   - `dependency-direction.md` §2 says "Nothing may depend on an app." (:127).
   - §3 F10 forbids "Any package depending on an `apps/*` package" (:506), and
     F13 forbids an unlisted same-layer edge (:509).
   - `BACKTEST-1`'s reviewer proved it: declaring
     `"@polymarket-bot/trader": "workspace:*"` in `apps/backtest-cli` gives
     `FAIL [F13]` (`docs/handoffs/BACKTEST-1.md:50-60`).
   - So blocker **B3** was narrowed, not closed. The shipped replay root drives
     the real core only when a test harness hands it one, and the harness's
     venue wiring is a copy of `main.ts`'s (`IMPLEMENTATION_STATUS.md`, row
     **B3**).
4. **The core is already layer-1 code by construction.** The following was
   measured at `a8a3a63` by `H8-GOV`. The method was the TypeScript
   pre-processor over every static, dynamic and type-only relative import,
   starting at `apps/trader/src/trader.ts`.
   - **Size.** The import closure is 25 files and 11,218 lines: `accounting`,
     `allocation`, `basket-execution`, `cancels`, `config`, `event-door`,
     `fills`, `folds`, `halt`, `health`, `instances`, `loop`, `market-state`,
     `order-lifecycle`, `orders`, `pipeline`, `pnl-snapshot-key`, `ports`,
     `projection`, `queue`, `reference-state`, `reservations`, `safety`,
     `time`, `trader`.
   - **Dependencies.** It reaches 13 workspace packages. Eleven are layer 1:
     `capital-allocator`, `execution-planner`, `features`, `ledger`,
     `order-book`, `pnl`, `risk`, `simulation`, `strategy-runtime`,
     `strategy-sdk` (types only) and `strategies/static-bracket`. The other
     two are the layer-0 `decimal` and `domain`. It also uses `zod`.
   - **What it does not touch.** It imports no layer-2 package: no
     `event-bus`, no `storage-*`, no `polymarket-*`. It imports no `node:`
     module. It reads no clock: its only `Date` construction,
     `apps/trader/src/time.ts:68`, `new Date(epochMs)`, converts an instant it
     was given. It references no process global. Everything that owns a
     connection is outside the closure: the Redis feed, the PostgreSQL store
     and registration check, the `node:http` health server, the pump and the
     entry point.
   - The H8 scoping measured 24 files and 10,879 lines at `60a5d7e`. The one
     file added since is `SNAP-1`'s `pnl-snapshot-key.ts`.
5. **The interim state, set by the same ruling.** §7 item 4's replay half is
   met *with qualification*, and B3 is **accepted as qualified, not closed**
   (`IMPLEMENTATION_STATUS.md`, rows **B3** and **H8 track**). B3 closes when
   `BACKTEST-2` lands.
6. **The ruling.** On 2026-09-28 the user ruled:
   - option A, with the package named `@polymarket-bot/trading-core`;
   - this ADR is written;
   - a strategy-agnostic core (the scoping's "D4") waits for a second
     strategy;
   - `FOLD-2` runs after `BACKTEST-2`;
   - the order is the H1 blockers, then `H8-GOV`, then an optional
     checker-hardening round, then `CORE-MOVE`, then `BACKTEST-2`.

   The ruling is recorded in `IMPLEMENTATION_STATUS.md`, row **H8 track**.

## Decision

### D1. Where the core lives

The `createPaperTrader` / `CoreLoop` import closure moves to
`packages/trading-core` (`@polymarket-bot/trading-core`), which
`dependency-direction.md` §2 classifies in **layer 1**. `apps/trader` keeps
`main.ts`, `pump.ts`, `pnl-observation.ts`, `health-server.ts`, `adapters/*`,
and the two re-export facades (`src/index.ts`, `src/testing/index.ts`). The
name says what the package is in every run mode, not only on today's
execution path ("paper"): the same core is meant to run later behind a real
venue (§2 :123, §12.1).

*Testable:* after `CORE-MOVE`, `check:deps` classifies `packages/trading-core`
as layer 1, and each closure file exists once, under
`packages/trading-core/src`.

### D2. §4.1 describes deployable processes, not where code lives

This is a reading of the handoff, argued from its own text:

1. §4.1 opens with "V1 consists of these deployable processes:" (:271).
   It lists processes.
2. Its `apps/trader` entry "Runs books, features, strategies, risk, OMS,
   user stream, heartbeat, reconciliation, ledger projections, and live
   execution" (:282-283). §5's tree places the modules behind those words
   in `packages/*`, not under `apps/trader`: `order-book`, `features`,
   `strategy-runtime` and `strategies/`, `risk`, `oms`, `ledger`, and
   `polymarket-secure` (:320-349). So "runs" already means that the process
   executes code that lives in packages.
3. §4.1 lists an `apps/cli` (:293) that §5 does not have; §5 has
   `apps/backtest-cli` and `apps/ops-cli` (:318-319). §4.1 is therefore
   not a directory layout.
4. §4's diagram feeds one core box from both the live publisher and the
   replay path (:222, :224, :259-261), which is the arrangement this
   decision makes buildable.

So `apps/trader` still "Owns the live deterministic event loop" (:281) in
§4.1's sense. It remains the **only deployable process that runs the core
on live data**: it assembles the core at startup, feeds it and runs it.
`WP-230`'s "in the trader process" (:883) still holds literally, because
code a process imports runs in that process. `packages/trading-core` owns
the code.

The handoff is **not edited**. Precedence puts it above this record
(handoff :57-62), and it has one commit, the seed. The package's addition to
§5's tree (:311-381) is recorded here, and nowhere in the handoff.

*Testable:* no process other than `apps/trader` runs the core against live
data, and no `H8` round changes
`docs/spec/polymarket-bot-orchestrator-handoff.md`.

### D3. What the core may depend on

The core declares only layer-0 and layer-1 workspace packages, plus `zod`.

- It has no `dependency-direction.md` §2.2 built-in row, because it
  imports no `node:` module.
- The clock, the event source and the venue enter only through the §12.1
  ports: `Clock`, `MarketEventSource` and `ExecutionVenue`, which `WP-210`
  declared in `packages/simulation`.
- **What the gate enforces.** The core is layer 1, so F12 fails any edge its
  manifest declares to a layer-2 package: `event-bus` (Redis), `storage-*`
  (PostgreSQL, WAL, Parquet) or `polymarket-secure` (the signer). The §6
  check also applies three specifier rules to the core, and each fails an
  import:
  - of a Redis client (F8), which only `packages/event-bus` may import;
  - of the venue SDK `@polymarket/client` (F6), which only
    `packages/polymarket-secure` may import;
  - of an archived Polymarket client (F7), which no package may import.
- **What the gate does not enforce.** F12 reads manifest edges only. `H8-GOV`
  round 1 measured each of the following with the check at `a8a3a63`, in a
  scratch copy with the staged text activated. Each passed the check:
  - a PostgreSQL client such as `pg`, declared as an external dependency
    and imported. The check's database-client catalogue binds only
    `packages/domain` (F1) and `packages/strategies/**` (F3);
  - a generic signing library such as `ethers`. The signing-library
    catalogue binds only `packages/strategies/**` (F3) and
    `packages/simulation` (F5);
  - an import of a workspace adapter that the manifest does not declare,
    either by package name or by a relative path into its files. The
    relative form is a deep import under F16, which the check did not
    implement at `a8a3a63`. The optional checker-hardening round's grant
    (`docs/handoffs/H8-GOV.md`) covers that relative half.
- So "a backtest cannot reach Redis, PostgreSQL or a signer through the
  core" is **a gate result only in part**. The gate covers the declared
  edges, the Redis clients and the Polymarket clients. The rest rests on
  the measured closure, which imports none of these (Context 4), and on
  review, until a §3 rule binds the core to the database-client and signer
  catalogues.
- F17 forbids a production `node:` import in the core. F17 is stated but
  not yet implemented by the §6 check, so that half rests on review and
  census until the tooling follow-up lands.

### D4. The core's same-layer edges

The core's same-layer edges are exactly `dependency-direction.md` §2.1 rows
**S8-S18**, with one cited row per target and no class-glob row.

- **No same-layer package may declare the core**, and no row will be
  written for such a reverse edge. Every such edge is an unlisted
  same-layer edge (F13). It is also a cycle (F9) when the core already
  reaches the declaring package. Measured by `H8-GOV` round 1 on an
  activated copy, the layer-1 packages the core reaches are exactly the
  eleven S8-S18 targets, so a reverse edge from any of them fails F9 and
  F13. From any other layer-1 package, such as `packages/config`,
  `packages/oms` or `packages/inventory`, it fails F13 only.
- F10 stays unconditional, and no §2.1 row may run from one app to another.
- Row **S14** is the one edge into `packages/risk` that carries the risk
  **engine**. It may not be cited to widen the door-only rows S3-S7, and
  they may not be cited against it.

*Testable:* after `CORE-MOVE`, `check:deps` passes with the allowlist
exactly S0..S18.

### D5. Both composition roots build the same core

- `apps/trader` builds the core through its exported builders, and so does
  `apps/backtest-cli` from `BACKTEST-2` on. Each root depends on the core
  downward (layer 3 → 1), so neither edge needs a row.
- From `BACKTEST-2` on, the simulated venue is constructed in **one**
  place, a builder in the core. Four copies exist today:
  `apps/trader/src/main.ts:485`, `test/e2e/support/harness.ts:142`,
  `test/integration/paper-trader/support/fixture.ts:671` and
  `test/unit/simulation/backtest-replay-support.ts:264`. All of them call
  the builder instead.
- The loop depends only on the §12.1 interfaces and never branches on
  whether it runs in simulation (`dependency-direction.md` §4; handoff
  §12.4). The builder is a factory that a root chooses to call, and a live
  root will not call it.

*Testable:* after `BACKTEST-2`, `new SimulatedVenue(` appears outside
`packages/simulation` only in the core's builder and in unit tests that
build a venue on purpose.

### D6. The core keeps its PAPER ceiling

- The ceiling is `REPOSITORY_MAXIMUM_RUN_MODE` and `TRADER_RUN_MODE =
  "PAPER"` (`apps/trader/src/safety.ts:67`, `:70`) and
  `environment: z.literal("PAPER")` (`config.ts:429`). These move
  byte-identical with `CORE-MOVE`.
- `BACKTEST` is below that ceiling. The core's accounting type already
  admits `BACKTEST | PAPER | SHADOW` (`accounting.ts:149`), which are the
  three simulated-execution modes (handoff §11 :1396-1398).
- `BACKTEST-2` drives the core with these constants unchanged. The
  mismatch between the backtest root's `BACKTEST` label and the core's
  PAPER constants is recorded as a residual, not changed.
- Every root that builds the core runs its startup safety validation
  first (handoff §6 invariant 17, :432; ADR-010 §3): `apps/trader`'s
  `checkPaperTraderSafety` and `apps/backtest-cli`'s `safety.ts`.
- **Raising the ceiling** is a human-gated change under ADR-010 §1
  (:37-41). So is letting the core run in any mode with real execution,
  and no round may do either without that gate. ADR-010 also rules any
  future ADR that touches these numbers out of order unless a human gate
  is already recorded (:198-200). `MAX_RUN_MODE=PAPER`,
  `ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and
  `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are unchanged.

*Testable:* the core's run-mode constants are byte-identical before and
after each `H8` round.

### D7. The facades stay until a later round retires them

`@polymarket-bot/trader` and `@polymarket-bot/trader/testing` keep
re-exporting every moved symbol under the same name and the same value/type
kind. No per-module shim is left at an old path.

*Testable:* `CORE-MOVE` shows the exported names and kinds of both entry
points are equal before and after the move.

### D8. How the change lands (the `GOV-2A` → `WP-180-FU2` precedent)

- `H8-GOV` stages the contract text in an unparsed `#### PENDING`
  subsection of `dependency-direction.md` §2.1: the §2 fence line, the §2
  paragraph, rows S8-S18 and the `CORE-MOVE` grant. It is staged because:
  - the check fails closed on a §2 entry that has no manifest
    (`F-CLOSED`);
  - it fails closed on a row that names an unclassified endpoint (`CHK`);
  - §6.1 item 5 puts the pinned allowlist assertion in `test/**`, outside
    a governance round.
- `CORE-MOVE` activates the text **in the change that creates
  `packages/trading-core/package.json`**. It:
  - moves the text verbatim into §2 and §2.1, restoring each row's leading
    pipe;
  - updates the pin to S0..S18;
  - records a dated §6 graph note with the **measured** count;
  - replaces the subsection with a dated DONE note that keeps the grant.
- `CORE-MOVE` moves code and changes none. Every moved file keeps its
  bytes except the specifier-only edits its grant enumerates.
  `test/replay-golden/**` stays byte-identical.

### D9. Static Bracket stays wired into the core until the core is made strategy-agnostic

- The core depends on the concrete package
  `packages/strategies/static-bracket` (row S18).
- The user deferred a strategy-agnostic core until a second strategy
  exists. The round that makes the core strategy-agnostic **removes S18 in
  the same change**.
- The check does not flag a row that matches no declared edge, so that
  removal is an obligation on the round, not a gate result.
- A second strategy gets its own cited row. No class-glob row is written.

### D10. The live-execution packages keep their paths and layers, and attach through the core's ports

The live-execution packages are the nine phase-3 packages deferred to Wave 3
(`WP-260` to `WP-340`) and `WP-350`'s execution probes (phase 4). Each keeps
the paths the work plan grants it, and each path keeps the layer that
`dependency-direction.md` §2 already gives its package. The layer beside
each path below is the one the §6 check reports at `a8a3a63`:

| Work package | Component | Paths (work plan `allowed_paths`), each with its §2 layer |
| --- | --- | --- |
| `WP-260` | secure SDK adapter and signer boundary | `packages/polymarket-secure/**` (2) |
| `WP-270` | OMS and signed-order persistence | `packages/oms/**` (1) |
| `WP-280` | authenticated user stream | `packages/polymarket-secure/src/user-stream/**` (2) |
| `WP-290` | account reconciliation | `packages/oms/src/reconciliation/**` (1), `packages/ledger/src/reconciliation/**` (1) |
| `WP-300` | collateral inventory and wallet operations | `packages/inventory/**` (1) |
| `WP-310` | rate-limit budgets and matching-engine modes | `packages/polymarket-secure/src/rate-limit/**` (2), `packages/oms/src/restricted-mode/**` (1) |
| `WP-320` | heartbeat health lease, fencing, geoblock and kill controls | `apps/trader/src/live-safety/**` (3), `packages/polymarket-secure/src/heartbeat/**` (2), `packages/storage-postgres/src/fencing/**` (2) |
| `WP-330` | emergency operations CLI | `apps/ops-cli/**` (3) |
| `WP-340` | live-micro fault-injection verification | test, documentation and status-file paths only; no package |
| `WP-350` | execution-probe planner and hard caps | `packages/execution-planner/src/probes/**` (1), `apps/trader/src/execution-probe/**` (3) |

- **They span three layers.**
  - The OMS, reconciliation, inventory, the restricted-mode logic and the
    probe planner are **layer-1** logic, in the core's own layer.
  - The secure SDK adapter, the user stream, the rate-limit budgets, the
    venue heartbeat and the fencing store are **layer-2** adapters. The
    core may not declare them (F12; D3).
  - The live-process wiring is **layer 3**, in `apps/trader` and
    `apps/ops-cli`. That is the only layer where an adapter meets an
    application module (§2, Layer 3).
- None of these components moves into the core, and this ADR adds no edge
  from the core to any of them. In the live process, `apps/trader`
  composes them with the core, and they reach the loop through its ports.
- If the core itself must later depend on one of the layer-1 packages, the
  edge is same-layer and needs its own cited §2.1 row (F13). The row is
  written with the grant that needs it, and D4's S8-S18 list grows by that
  row. The reverse edge stays barred (D4).
- A live component that needs a hook inside the loop gets a bounded
  `packages/trading-core/**` grant at its authorization. This follows the
  grant-at-authorization precedent (work plan, the `WP-210` comment at
  :806-816).
- `WP-260`, `WP-270`, `WP-300` and `WP-330` are forbidden
  `packages/trading-core/**`, exactly as they are forbidden
  `apps/trader/**` (dated work-plan entries, `H8-GOV`).
- `WP-320` and `WP-350` keep their `apps/trader/src/**` grants. Their
  live-process wiring (a PostgreSQL fencing lease, a venue heartbeat,
  probe orders on a real venue) uses layer-2 packages that the core may
  not declare (F12).

## Consequences

**What this buys.**

- B3 closes at `BACKTEST-2`: the backtest executable builds the same core
  itself, and no harness hands it one.
- F12 fails any layer-2 package the core's manifest declares, so the
  core's adapter dependencies are gated. That is the gated part of "a
  backtest cannot reach Redis, PostgreSQL or a signer through the core",
  together with F6, F7 and F8. The rest rests on the measured closure and
  on review; D3 lists the routes the check does not catch.
- §12.1 holds literally: one core, with three ports swapped.
- Handoff §14.2's `ops-cli replay <manifest> <config>` (:1692) can reuse the
  core through a downward edge. Under option B it would have needed a second
  app-to-app exception.

**What it costs.**

- Eleven same-layer rows (S8-S18), the most of any package. Each one is
  measured and cited.
- A move of about 40 files. It needs an exclusive window, with no other
  `apps/trader/src` grant in flight. Queued packets that name old paths must
  be re-pathed after it.
- Accepted ADRs cite paths that move: ADR-016 :270-273 cites `trader.ts:143`
  and `accounting.ts:289`, and ADR-021 :25 and :86 cite
  `apps/trader/src/config.ts`. Frozen handoff records do the same. They stay
  as history and are not edited (README, "Status vocabulary").
- Some comments become false with the move:
  - `apps/trader/src/ports.ts:14-17` ("consumed only from layer 3");
  - `packages/simulation/src/ports.ts:44-46`;
  - `apps/backtest-cli/src/core-loop.ts:19-36`;
  - `apps/trader/package.json`'s `description`.

  `CORE-MOVE` leaves the moved files byte-identical, so `BACKTEST-2` owns
  these corrections.
- Blame and log on moved files need `--follow` or `-C`.
- Undoing the decision takes another move round.

**What it forecloses.**

- An edge from one app to another stays forbidden.
- The core cannot declare a layer-2 package without failing F12. A live
  concern that needs one stays in a composition root and reaches the loop
  through a port.

**Alternatives rejected.**

- **B, a cited §2.1 exception for `apps/backtest-cli` → `apps/trader`.**
  - It would amend a rule that has no exceptions: §2 :127 is unconditional,
    and so is F10.
  - The check implements no F10 today (the tool contains no `F10` id). The
    H8 scoping reproduced that such a row is **accepted silently** (probe P3:
    exit 0, 81 edges), so the exception would open a hole, not a gate.
  - The backtest's closure would grow to the trader's whole manifest,
    including `event-bus` (Redis) and `storage-postgres`.
- **C, the qualified wording.** Kept only as the interim state until
  `BACKTEST-2` (Context 5).
- **A new layer for compositions, between layer 1 and layer 3.**
  - Placed above layer 2, it would let the core declare adapters downward,
    and D3's F12 check on the core's declared edges would be lost.
  - Placed below layer 2, it is layer 1 by §2's own definition: logic that
    owns no connection. Renumbering would break the tooling suite's layer
    pins for no gain.
- **Leave the core in `apps/trader` and let the backtest root compose its own
  copy.** Rejected. A second assembly is the second code path §12.1 forbids,
  and it is the very qualification B3 carries today: the harness's venue
  wiring is a copy of `main.ts`'s.
- **A strategy-agnostic core now.** Deferred by the ruling, not rejected
  (D9).

## Evidence

- **Handoff** (`docs/spec/polymarket-bot-orchestrator-handoff.md`, unchanged
  since `58fe7ee`):
  - §0.1 :32; §1.1 :57-62; §2 :123;
  - §4 :222, :224, :259-261;
  - §4.1 :271, :280-283, :293;
  - §5 :311-381 (`apps/*` :313-319);
  - §6 invariant 17 :432; §8.1 :672;
  - §11 :1396-1398, :1403; §12.1 :1428; §12.4 :1485;
  - §14.2 :1692.
- **Work plan** (`docs/spec/polymarket-bot-workplan.yaml`, at `a8a3a63`):
  - `WP-210`: :806-816 (the grant-at-authorization comment), :817, :821;
  - `WP-230`: :883, :884, :886, :906;
  - the `forbidden_paths` entries `apps/trader/**` at :984 (`WP-260`),
    :1007 (`WP-270`), :1073 (`WP-300`) and :1141 (`WP-330`);
  - `WP-320` :1112; `WP-350` :1185.
- **Contracts, at `a8a3a63`:**
  - `docs/contracts/dependency-direction.md`: §2 :75-76 and :127; §2.1
    :129-145; §2.2 :385; §3 F10 :506, F12 :508, F13 :509, F17 :513; §4
    :576-582; §6 rule 2 :706-715; §6.1 item 5 :800;
  - `docs/contracts/protected-contracts.md` §3.1 and §5.
- **ADRs:** ADR-010 §1 :37-41, §3 :74-77, and :198-200.
- **Handoff records:**
  - `docs/handoffs/BACKTEST-1.md:50-60` (the F13 proof, and "no third
    option");
  - `docs/handoffs/WP-210.md:80-82` (deviation 3: the §12.1 interfaces land
    in `packages/simulation`) and :122-123 (`follow_up` 6).
- **Status:** `IMPLEMENTATION_STATUS.md` rows **B3**, **BACKTEST-1** and
  **H8 track** (the ruling and the interim state).
- **Measured by `H8-GOV` at `a8a3a63`.** The scripts and outputs are listed
  in `docs/handoffs/H8-GOV.md`.
  - The closure and its bindings (Context 4).
  - `check:deps`: 34 packages, 80 edges, allowlist S0..S7, PASS.
  - The activation dry run in a scratch mirror. The staged fence line and
    rows were activated and a `packages/trading-core/package.json` was added
    declaring the 13 workspace packages plus `zod`. The result was **PASS, 35
    packages, 93 edges, allowlist S0..S18**. Adding
    `apps/trader → trading-core` gave 94 edges and still passed.
- **Measured by `H8-GOV` round 1 at `a8a3a63`** for review findings H8G-01
  to H8G-03. A scratch copy had the staged text and a core manifest
  activated, and the check ran through `--root <copy> --json`. The script is
  `claims-r1.cjs`; the output is quoted in `docs/handoffs/H8-GOV.md`.
  - **D3, what fails.** A declared core edge to `storage-postgres`,
    `polymarket-secure` or `event-bus` fails with F12 alone. An `ioredis`
    import fails F8, a `@polymarket/client` import fails F6, and a
    `@polymarket/clob-client` import fails F7.
  - **D3, what passes.** `pg` and `ethers`, each declared and imported,
    pass (exit 0). So does an undeclared import of
    `@polymarket-bot/storage-postgres`, by name or by a relative path into
    its `src`.
  - **D3, the checker source.** In `tools/check-dependency-direction.mjs`,
    the Redis catalogue is at :390, the database clients at :398 and the
    signing libraries at :450. F7 (:2722) applies to every package. F6
    (:2735) applies to every package except `packages/polymarket-secure`,
    and F8 (:2747) to every package except `packages/event-bus`. The
    database and signer catalogues are applied only under `isDomain`
    (:2763), `isStrategy` (:2806) and `isSimulation` (:2843). Contract §3
    F16 is at :512.
  - **D4.** Each of the 18 other layer-1 packages was made to declare the
    core. Every one gives F13. F9 is added exactly for the 11 the core
    reaches, which are the S8-S18 targets.
  - **D10, layers.** From the check's report: `polymarket-secure` and
    `storage-postgres` are layer 2; `oms`, `inventory`, `ledger` and
    `execution-planner` are layer 1; `apps/trader` and `apps/ops-cli` are
    layer 3.
  - **D10, paths.** Work plan :979 (`WP-260`), :1002 (`WP-270`), :1025
    (`WP-280`), :1046-1047 (`WP-290`), :1068 (`WP-300`), :1091-1092
    (`WP-310`), :1112-1114 (`WP-320`), :1136 (`WP-330`) and :1184-1185
    (`WP-350`). "deferred to Wave 3" is at `IMPLEMENTATION_STATUS.md:5`.
- **Reproduced by the H8 scoping (`wf_5375df07-cc2`, at `60a5d7e`)**, and
  re-run by `H8-GOV` at `a8a3a63` against this round's staged text (the
  output is quoted in `docs/handoffs/H8-GOV.md`):
  - the fail-closed staging failures, `F-CLOSED` and `CHK` (probes A5-A7);
  - the unparsed staging form passes (A8);
  - a pipe-led row is parsed even inside a fence (A9);
  - a fence annotation naming a package path reassigns that package (A10);
  - a class-glob row is `CHK` (A11);
  - a row with no matching edge is not flagged (A12);
  - an app-to-app row is accepted silently (P3).
- **Venue facts:** none. **Safety defaults:** none touched. **Schema
  version:** no emitted field set changes; this record changes no code, so no
  `schemaVersion` changes.

## Closing note (2026-09-28): `CORE-MOVE` and `BACKTEST-2` implemented this ADR — it is discharged

Append-only; nothing above this line changed.

The header's "Implemented by: CORE-MOVE (pending), BACKTEST-2 (pending).
**No implementation exists yet.**" was true at this record's date. This note
supersedes it. It is recorded by `DOCS-1`, on the ADR-021 discharge
precedent (`e6548cf`).

**The four merges.** These are the H8 track, in order. Each round's record is
in `docs/handoffs/`.

| Round | Merge | What it did for this ADR |
| --- | --- | --- |
| `H8-GOV` | `bb58edb` | Wrote this ADR, and staged the §2 and §2.1 text in an unparsed `#### PENDING` subsection (D8). |
| `DEPCHECK-1` | `d7f2906` | The optional checker-hardening round. It added F10, F16's relative half, and a `CHK` for a §2.1 row whose `to` endpoint is an application or that matches no declared edge. |
| `CORE-MOVE` | `33b7d0b` | Moved the 25 closure files and their 14 colocated tests into `packages/trading-core`, behind re-export facades, and activated the staged text (D1, D7, D8). |
| `BACKTEST-2` | `fd12be0` | Made `apps/backtest-cli` build the core itself, with one venue builder (D5), and closed B3. |

**The measured graph.** `DOCS-1` re-measured it. Each merge's tree
(`git archive <sha>`) was checked with this note's base checker, which has
not changed since `d7f2906`
(`node tools/check-dependency-direction.mjs --root <tree> --json`):

- `ac0b12f`, `CORE-MOVE`'s base: 34 packages, 80 edges, allowlist S0..S7.
- `33b7d0b`, after `CORE-MOVE`: **35 packages, 89 edges**. The allowlist is
  S0..S18, `packages/trading-core` is in layer 1, and there is no violation.
- `fd12be0`, after `BACKTEST-2`: **35 packages, 90 edges**, with the same
  allowlist and no violation. The two edge lists differ by exactly one
  added edge, `apps/backtest-cli` → `packages/trading-core`, and none
  removed.

These are the counts in `dependency-direction.md` §6's two dated notes of
2026-09-28. `H8-GOV`'s dry run measured 93 edges, and 94 with
`apps/trader` → `packages/trading-core`. The real count is 89 because
`CORE-MOVE` removed the five `apps/trader` edges that its remaining source
no longer imports (the §6 note's +11, +2, +1 and −5).

**D1 as realized.** The 25 closure files of Context 4 exist only under
`packages/trading-core/src`, and none remains under `apps/trader/src`. The
check classifies the package in layer 1.

**D5 as realized.**

- **One venue builder:** `buildSimulatedVenue`, in
  `packages/trading-core/src/venue-builder.ts`.
  - Outside `packages/simulation`, `new SimulatedVenue(` now appears only
    there (`:176`, and a comment at `:18`) and in `*.test.ts` files that
    build a venue on purpose. That is D5's testable sentence.
  - The four copies D5 named are gone. `apps/trader/src/main.ts`,
    `test/e2e/support/harness.ts` and
    `test/integration/paper-trader/support/fixture.ts` call the builder.
    `test/unit/simulation/backtest-replay-support.ts` now drives the CLI's
    own assembly (`apps/backtest-cli/src/assembly.ts`), which calls it.
- **A production store:** `apps/backtest-cli` builds the core with a
  production `InMemoryTraderStore` (`packages/trading-core/src/memory-store.ts`),
  never the test double. The store imports `pnl-snapshot-key.ts` (shared,
  not copied) and nothing from the core's `testing/`.
- **Both roots depend downward on the core**, layer 3 → layer 1, so neither
  edge needs a §2.1 row. `apps/trader` has done so since `CORE-MOVE`, and
  `apps/backtest-cli` since `BACKTEST-2`.

**D6 held.** `safety.ts` and `config.ts` have the same blob at `a8a3a63`
(under `apps/trader/src`) and at this note's base (under
`packages/trading-core/src`). So the core's PAPER constants are
byte-identical across the four rounds. The backtest root's `BACKTEST` label
over the core's PAPER constants stays a recorded residual (BT1-R5), as D6
said.

**D7: the facades remain.** Both entry points still re-export the core:
`@polymarket-bot/trader` (`apps/trader/src/index.ts`) and
`@polymarket-bot/trader/testing` (`apps/trader/src/testing/index.ts`, which
is `export * from "@polymarket-bot/trading-core/testing"`). `CORE-MOVE`
proved that both entry points' names and kinds were unchanged by the move
(`docs/handoffs/CORE-MOVE.md`).

**B3 is CLOSED**, at `BACKTEST-2`'s merge (`IMPLEMENTATION_STATUS.md`, row
**B3**). The backtest executable builds the core itself and no harness hands
it one. That is the first item of "What this buys".

**Dated statements that `DEPCHECK-1` changed.** Three statements above were
true at `a8a3a63`, and they stay as written: they are history, not current
gate behaviour. `DOCS-1` re-measured each one at this note's base,
`ae25450`, in a scratch copy of the tree, with `--root <copy> --json`:

- **D3, "What the gate does not enforce", third bullet.** The relative route
  now fails F16: a `packages/trading-core/src` file that re-exports
  `../../storage-postgres/src/index.js` fails F16. The other routes still
  pass, with exit 0:
  - the same re-export by package name, undeclared;
  - `pg`, declared and imported;
  - `ethers`, declared and imported.

  So D3's "a gate result only in part" still holds for those three routes.
- **D9, third bullet.** A §2.1 row that matches no declared edge is now a
  `CHK` error. With the core's `@polymarket-bot/strategy-static-bracket`
  dependency removed, row S18 fails `CHK`. So S18's removal is now a gate
  result.
- **"Alternatives rejected", B, second bullet.** The check now implements
  F10. When `apps/backtest-cli` declares `@polymarket-bot/trader`, the check
  fails F10. A §2.1 row naming an application as its `to` endpoint is a
  `CHK` error (`DEPCHECK-1`'s probe P3, in `docs/handoffs/DEPCHECK-1.md`).

**What stays open.**

1. **S18's sunset.** The H8 scoping called the strategy-agnostic core "D4",
   and the ruling deferred it until a second strategy exists (Context 6).
   It is D9's round. That round removes row S18 in the same change, and
   D4's list of the core's same-layer rows loses S18.
2. **The facade retirement (D7).** A later round retires both facades
   (`docs/handoffs/CORE-MOVE.md`, "Follow-ups").
3. **Also still open, as D3 states it:**
   - no §3 rule binds the core to the database-client and signing-library
     catalogues (`H8-GOV` `follow_up` 5, finding H8G-01);
   - the §6 check does not yet implement F17.

**Venue facts:** none. **Safety defaults:** none touched. This note changes
no code.
