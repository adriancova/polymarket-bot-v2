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
packages/trading-core     (the shared trading core; see below)
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

`packages/trading-core` is the shared deterministic trading core:
`createPaperTrader`, `CoreLoop`, and the modules in their import closure.
`CORE-MOVE` moved it out of the trader application under the H8 ruling
(option A, ruled by the user on 2026-09-28;
[ADR-022](../adr/ADR-022-shared-trading-core-is-a-layer-1-package.md)). It is
layer 1 by this section's own definition: rules, state machines and
computation that own no connection. Measured at `a8a3a63`, its 25-file closure
reaches only layer-0 and layer-1 packages plus `zod`; it imports no adapter
and no Node built-in, reads no clock, and references no process global.
Everything that owns a connection stays in the layer-3 trader application: the
Redis feed, the PostgreSQL store and registration check, the health server,
the pump, and the process entry point. The trader application builds the
core, and `apps/backtest-cli` builds it from `BACKTEST-2` on; both are
composition roots depending on it downward. Its same-layer dependencies are
§2.1 rows S8-S19, and it needs no §2.2 row. Because it is layer 1, F12 fails
any edge its manifest declares to a layer-2 package. §3's F8, F6 and F7 also
apply here: they fail an import of a Redis client, of the venue SDK, or of an
archived Polymarket client. That was all the gate enforced at `a8a3a63` of "a
backtest cannot reach Redis, PostgreSQL or a signer through the core". At that
commit the check did not fail a PostgreSQL client such as `pg`, or a generic
signing library, declared and imported here. Nor did it fail an adapter import
that no manifest entry declares. F16 covers the relative form, but the check
did not implement F16 then. The measured closure does none of these. Keeping it
so rests on review until a §3 rule binds this package (ADR-022 D3). The Layer 3
rule "Nothing may depend on an app." is unchanged and stays true: no app is ever
a dependency under this arrangement.

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
| S3 | `packages/capital-allocator` → `packages/risk` | 1 | GOV-2A 2026-09-04 mirror-collapse ruling (the subsection below); ADR-020 §3; `docs/contracts/schema-boundary.md` §1. The consumed surface is the prototype-free parse door only — `plain-data.ts` and `schema-arena.ts` — exported through `packages/risk`'s `exports` map (F16). No rule, policy, or evaluation logic may travel this edge; a consumer needing that has found a different problem. |
| S4 | `packages/execution-planner` → `packages/risk` | 1 | GOV-2A 2026-09-04 mirror-collapse ruling (the subsection below); ADR-020 §3; `docs/contracts/schema-boundary.md` §1. The consumed surface is the prototype-free parse door only — `plain-data.ts` and `schema-arena.ts` — exported through `packages/risk`'s `exports` map (F16). No rule, policy, or evaluation logic may travel this edge; a consumer needing that has found a different problem. |
| S5 | `packages/ledger` → `packages/risk` | 1 | `docs/contracts/schema-boundary.md` §5 item 1 (the `WP-200-FU1` owner assignment) and §1 (the D1-D4 door rule); ADR-020 §3; the GOV-2A mirror-collapse ruling in the subsection below, whose §5 item 5 states that a later consumer "consumes one implementation instead of copying a fourth". Measured basis for the grant: schema-boundary §3's `packages/ledger` row — a non-enumerable inherited `marketId` defeats `WP-040` obligation **F16**, and a non-enumerable `skipChecks` admits `ledgerTransactionId: "totally-not-a-uuid"`. The consumed surface is the prototype-free parse door only — `plain-data.ts` and `schema-arena.ts`, and since `SER-1` (2026-09-15) the own-data JSON encoder `plain-json.ts`, on the measured basis of `docs/handoffs/SER-0-sweep.md`: an inherited `Object.prototype`/`Array.prototype` `toJSON` collapsed `attributionBucketKey`, `legKeyOfValidated`, `balanceLineKey` and `virtualPositionKey` to one constant key, so a cross-account parity breach and a non-compensating reversal were accepted and the projection's balance book emptied — exported through `packages/risk`'s `exports` map (F16). No rule, policy, or evaluation logic may travel this edge; a consumer needing that has found a different problem. Acyclic: `packages/risk` declares only `@polymarket-bot/decimal` and `@polymarket-bot/domain`, so the reverse edge does not and may not exist. |
| S6 | `packages/pnl` → `packages/risk` | 1 | `docs/contracts/schema-boundary.md` §5 item 1 (the `WP-200-FU1` owner assignment) and §1 (the D1-D4 door rule); ADR-020 §3; the GOV-2A mirror-collapse ruling in the subsection below. Measured basis for the grant: schema-boundary §3's `packages/pnl` row — the same classes on the record schemas, plus a cold first parse of the discriminated union that throws an escaped `TypeError` and leaves the schema permanently poisoned. The consumed surface is the prototype-free parse door only — `plain-data.ts` and `schema-arena.ts`, and since `SER-1` (2026-09-15) the own-data JSON encoder `plain-json.ts`, on the measured basis of `docs/handoffs/SER-0-sweep.md`: an inherited `Object.prototype`/`Array.prototype` `toJSON` merged `pnlCompositeKey`'s schedule-versioned fee buckets and per-program reward/estimate buckets into one key, so the §9.16 breakdown fields came back empty — exported through `packages/risk`'s `exports` map (F16). No rule, policy, or evaluation logic may travel this edge; a consumer needing that has found a different problem. Acyclic on the same evidence as **S5**. |
| S7 | `packages/strategy-runtime` → `packages/risk` | 1 | `docs/contracts/schema-boundary.md` §5 item 2 (the `WP-170-FU1` owner assignment — "D2/D3 added to the existing materializer") and §1 (the D1-D4 door rule); ADR-020 §3; the GOV-2A mirror-collapse ruling in the subsection below, whose §5 item 5 states that a later consumer "consumes one implementation instead of copying a fourth" — this is the fifth consumer and it took the edge, not a copy. Measured basis for the grant: schema-boundary §3's `packages/strategy-runtime` row — under a non-enumerable inherited `skipChecks`, an evaluation input carrying `evaluatedAt: "yesterday"` and a non-canonical UPPERCASE `marketId` is **accepted** where a clean process refuses it, so ADR-016's "refused, never case-folded" stops being enforced; the same pollution flips the `DecisionResult` parse at `runtime.ts:918` from `CONTAINED`/`RUNTIME.DECISION_INVALID` to a persisted STRATEGY-attributed decision (§6 invariant 3's one persisted decision, §6 invariant 4's traceability chain). The consumed surface is the prototype-free parse door only — `plain-data.ts` and `schema-arena.ts` — exported through `packages/risk`'s `exports` map (F16). No rule, policy, or evaluation logic may travel this edge; a consumer needing that has found a different problem. Acyclic on the same evidence as **S5**: `packages/risk` declares only `@polymarket-bot/decimal` and `@polymarket-bot/domain`, so the reverse edge does not and may not exist. |
| S8 | `packages/trading-core` → `packages/capital-allocator` | 1 | H8 ruling (option A, the user, 2026-09-28; ADR-022): the paper core moves below layer 3 so that `apps/trader` and `apps/backtest-cli` build one core (handoff §12.1: "Everything between event input and the `ExecutionVenue` interface is shared."; `WP-210` goal, work plan: "Execute the same core logic against historical/live data"; `WP-230` goal: "Assemble books, features, strategy runtime, risk, planner, simulation, and ledger in the trader process" — the trader process still assembles and runs it, ADR-022 D2 — and deliverable "deterministic core event loop"). `WP-230` `depends_on` `WP-180`, the owner of `packages/capital-allocator`. Consumed surface, measured at `a8a3a63`: the allocator's cap parser, reservation evaluation and state, and exposure snapshots (`parseAllocatorCaps`, `evaluateReservation`, `applyReservation`, `createAllocatorState`, `exposureSnapshotCovering`, `shadowExposureSnapshot`, `EXPOSURE_ZERO`). Since `C1-RISK` (2026-10-08; the allocator is the only exposure-cap authority, so no snapshot is padded for the risk engine any more), the consumed surface is `parseAllocatorCaps`, `applyReservation`, `createAllocatorState` and `exposureSnapshot` (the read-only `AllocatorGate.countedExposure`); `evaluateReservation`, `exposureSnapshotCovering`, `shadowExposureSnapshot` and `EXPOSURE_ZERO` are no longer consumed. Acyclic: `packages/capital-allocator` may never declare `packages/trading-core` (the reverse edge would be F9 and an unlisted F13). |
| S9 | `packages/trading-core` → `packages/execution-planner` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-190`, the owner of `packages/execution-planner`. Consumed surface, measured at `a8a3a63`: `buildExecutionPlan` and its plan, placement, result and input types. Acyclic on the S8 terms. |
| S10 | `packages/trading-core` → `packages/features` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-160`, the owner of `packages/features`. Consumed surface, measured at `a8a3a63`: `computeFeatureSnapshot` and `FeatureSnapshot`. Acyclic on the S8 terms. |
| S11 | `packages/trading-core` → `packages/ledger` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-200`, the owner of `packages/ledger`. Consumed surface, measured at `a8a3a63`: the ledger and its projection (`Ledger`, `applyTransaction`, `buildFillPosting`, `allocateFill`, `projectLedger`, `serializeProjection`, and their transaction, allocation and refusal types). The core is not a strategy implementation, so F4 is not engaged; `packages/ledger` still may not import any strategy (F4), nor declare this package. Acyclic on the S8 terms. |
| S12 | `packages/trading-core` → `packages/order-book` | 1 | The H8 basis stated in **S8** ("books"). `packages/order-book` is `WP-150`'s. Consumed surface, measured at `a8a3a63`: `MarketOutcomeBooks`, `executablePrice`, `serializeBook`, and the `OutcomeTokenBook` type. Acyclic on the S8 terms. |
| S13 | `packages/trading-core` → `packages/pnl` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-200`, the owner of `packages/pnl`. Consumed surface, measured at `a8a3a63`: the PnL fold (`applyPnlRecord`, `foldPnlRecords`, `computePnlSnapshot`, `emptyPnlState`, `serializePnlState`, and the record, snapshot, state and stream-identity types), and since `SNAP-1` `toPnlSnapshotRow`, the own-data row the one-snapshot-per-instance-per-instant key is computed over. Acyclic on the S8 terms. |
| S14 | `packages/trading-core` → `packages/risk` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-180`, the owner of `packages/risk`. **This is the one §2.1 edge into `packages/risk` that carries the risk ENGINE**, and it says so because S3-S7 say the opposite: the core is the composition that evaluates every intent, so it consumes `evaluateIntent` and `parseRiskPolicy` (and the `RiskEvaluation` and `RiskPolicy` types) from the package root, plus the prototype-free parse door (`./plain-data` `readPlainData`, `./schema-arena` `prototypeFreeParser`) under ADR-020 §3; measured at `a8a3a63`, it does not consume `./plain-json`. S3-S7's "no rule, policy, or evaluation logic may travel this edge" does NOT apply to this row and may not be cited against it; equally, this row may not be cited to widen S3-S7. Acyclic: `packages/risk` declares only `@polymarket-bot/decimal` and `@polymarket-bot/domain`. |
| S15 | `packages/trading-core` → `packages/simulation` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-210`, the owner of `packages/simulation`. Consumed surface, measured at `a8a3a63`: the handoff §12.1 port interfaces `Clock`, `MarketEventSource` and `ExecutionVenue`, which `WP-210` declared in `packages/simulation` (`docs/handoffs/WP-210.md` deviation 3); the simulated order, fill and result types and the recorded-event identity (`SimulatedOrder`, `SimulatedFill`, `ExecutionResult`, `TimeInForce`, `RecordedEventIdentity`, the structural `EventEnvelope`); and `toFillFact`. `CORE-MOVE`'s venue-policy block (`VenueWiring`, `createExecutionPolicy`, cut from `apps/trader/src/main.ts`) adds the `PlannedOrderView` type. From `BACKTEST-2` on (ADR-022 D5), the surface also includes the simulated-venue construction (`SimulatedVenue`, its fill models such as `tier0Model`, `readFeeScheduleSnapshot`, `unmodeledRateLimits`, and the `BookView` type), serving the ONE venue builder that both composition roots call. The loop itself depends only on the interfaces and never branches on "am I in simulation" (§4; handoff §12.4); the builder is a factory a root chooses to call, and a live root will not call it. This is the first same-layer consumer of the §12.1 interfaces. F5 is unaffected: `packages/simulation` still imports no signer. Acyclic on the S8 terms. |
| S16 | `packages/trading-core` → `packages/strategy-runtime` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-170`, the owner of `packages/strategy-runtime`. Consumed surface, measured at `a8a3a63`: `createStrategyInstanceRuntime` and the checkpoint, decision-sink, telemetry, evaluation and clock types it takes. Acyclic on the S8 terms. |
| S17 | `packages/trading-core` → `packages/strategy-sdk` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-170`, the owner of `packages/strategy-sdk`. Consumed surface, measured at `a8a3a63`: **types only** (the strategy-facing views `MarketView`, `OrderBookView`, `StrategyOrderView`, `StrategyFill`, `VirtualPositionView`, `RiskBudgetView`, `FeatureSnapshot`, `StrategyOrderStatus`); no value is imported. Acyclic on the S8 terms. |
| S18 | `packages/trading-core` → `packages/strategies/static-bracket` | 1 | The H8 basis stated in **S8**. `WP-230` `depends_on` `WP-220`, the owner of `packages/strategies/static-bracket`. Consumed surface, measured at `a8a3a63`: `staticBracketStrategy`, `validateStaticBracketParams`, `staticBracketParamsSchema`. The core runs one strategy today. If a later round makes the core strategy-agnostic (ADR-022 D9; deferred by the user's H8 ruling of 2026-09-28 until a second strategy exists), **this row is removed in that change**. The removal is an obligation on that round. At `a8a3a63` the check did not flag a row that matches no declared edge, so the removal is not a gate result unless the check later gains that `CHK`. The row names the concrete package, not the `packages/strategies/*` class, so a second strategy needs its own cited row and never gets an implicit one. The edge is acyclic on the S8 terms. F3 and F11 still bind the strategy, not the core. |
| S19 | `packages/trading-core` → `packages/universe` | 1 | ADR-030 Decision 4.2 (the run record pins the reviewed series) and the trader's re-judge of every `SeriesWindowAdmitted@1` against that pinned review (`packages/trading-core/src/series-admission.ts`: the configuration hash, the window's schedule and its derived identity); the GOV-2A mirror-collapse ruling in the subsection below, whose §5 item 5 states that a later consumer "consumes one implementation instead of copying a fourth". Added by `C1-UNIV` (`COMPLEXITY-1`, the user's ruling of 2026-10-08, option (a)), which deleted the trader's line-for-line copy of these rules (`packages/trading-core/src/series.ts`, written only because the `ROLLOVER-1` round could not edit the lockfile) and the test that held the copy equal to the gateway's. Consumed surface: `ReviewedSeriesSchema` (parsed through the configuration door's prototype-free arena, so it must stay inside `ARENA_NODE_TYPES`: a node outside it fails the core's module load), `seriesConfigHash`, `deriveWindowSchedule`, `epochMsOfInstant`, `windowInternalMarketId`, `admissionRunModeProblem`, and the `ReviewedSeries` type; re-exported unchanged from the core's root for `apps/trader`: `canonicalSeriesJson`, `SERIES_TITLE_TIME_ZONE`, `SERIES_TITLE_ZONE_LABEL` and the `WindowScheduleResult` type; from `./testing`, only the sample review `reviewedBtc15mSeriesDocument`. The trader's re-judge (its refusal codes and checks) stays in the core and is unchanged; only the shared rules travel this edge, never the gateway's judge (`judgeSeriesWindow`). Acyclic: `packages/universe` declares only `@polymarket-bot/decimal`, `@polymarket-bot/domain` and `zod`, so the reverse edge does not and may not exist. |

#### DONE 2026-09-28: the shared trading core's rows (staged by `H8-GOV`, activated by `CORE-MOVE`)

**The ruling.** On 2026-09-28 the user ruled H8 option A. The
`createPaperTrader` / `CoreLoop` import closure moved out of `apps/trader` into
a new layer-1 package, `packages/trading-core` (`@polymarket-bot/trading-core`),
which both composition roots build
([ADR-022](../adr/ADR-022-shared-trading-core-is-a-layer-1-package.md)).

**Why the text was staged first.** `H8-GOV` staged it here, unparsed, in a
`#### PENDING` subsection, because the check fails closed until the package
exists: a §2 entry for a path with no `package.json` is `F-CLOSED`, and a row
naming an endpoint §2 does not classify is `CHK`. §6.1 item 5 also puts the
pinned allowlist assertion in `test/**`, outside a governance round. This is
the `GOV-2A` → `WP-180-FU2` shape recorded in the DONE subsection below.

**What `CORE-MOVE` did with it,** in the change that created
`packages/trading-core/package.json` (`docs/handoffs/CORE-MOVE.md`):
1. The fence line is in the §2 Layer 1 fence, after the
   `packages/strategies/**` class-entry line.
2. The paragraph follows the paragraph after that fence.
3. Rows S8-S18 are in the table above, after S7, verbatim, each with its
   leading `| ` restored.
4. The pinned allowlist assertion in
   `test/unit/tooling/dependency-direction.test.ts` reads S0..S18.
5. The two S15 sentences are appended to the settled note at the end of this
   section and to §4's execution-venue bullet.
6. §6 records a dated graph note with the measured package and edge counts.
7. This note replaces the subsection. It drops the staged copies of the fence
   line, the paragraph, the rows and the S15 sentences, because a second copy
   of a parsed row is the private copy of the table that §6 forbids. It keeps
   the grant, below.

**The grant, as `H8-GOV` wrote it on 2026-09-28** (quoted verbatim from
`docs/handoffs/H8-GOV.md`; a recorded grant is not edited to match what is
later done):

> **Owner:** `CORE-MOVE`, a bounded `WP-230` follow-up round (ADR-022 D8). It
> runs in an exclusive window: no other grant that touches any path below may be
> in flight.
>
> **Allowed paths.** Everything not listed here is forbidden.
>
> - `packages/trading-core/**` (new):
>   - the moved closure (25 files at `a8a3a63`);
>   - the closure's 14 colocated tests. Two of them,
>     `loop-order-lifecycle.test.ts:106` and `order-provenance.test.ts:44`,
>     change their `./main.js` specifier to `./venue-policy.js`;
>   - `src/testing/index.ts`, a byte-identical copy of the trader's;
>   - `src/venue-policy.ts`, holding the `VenueWiring` / `createExecutionPolicy`
>     block cut from `apps/trader/src/main.ts` (:155-217 at `a8a3a63`);
>   - `src/index.ts`, `package.json` and `tsconfig.json`.
> - `apps/trader/**`, limited to:
>   - deleting the moved files;
>   - the `src/index.ts` and `src/testing/index.ts` facades;
>   - import-specifier-only edits in the files that stay. The core's
>     `src/index.ts` exports what those files import, including
>     `unreplacedPnlSnapshotProblem`, which the trader's `src/index.ts` does
>     not export today;
>   - cutting the venue-policy block out of `src/main.ts`, with the import names
>     only that block used, and adding the lines that import it from the core
>     and re-export it;
>   - `package.json` `dependencies`.
> - `pnpm-lock.yaml`: the `importers` blocks of `packages/trading-core` and
>   `apps/trader` only.
> - `test/unit/trader/health-realized-pnl.test.ts`: the :19 specifier, and the
>   `apps/trader/src/health.ts` path string (:214) in the test "the source files
>   on the path contain no Number(...), parseFloat or parseInt" only.
> - `test/unit/trader/health-server.test.ts`: the :20 specifier only.
> - `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`: the :55, :56 and
>   :63 specifiers only.
> - `test/unit/trader/query-boundary-cast-scan.test.ts`: its scan root
>   (`TRADER_SRC`, :121) and the per-root file labels only.
> - `test/unit/tooling/dependency-direction.test.ts`, limited to:
>   - the `removeDependencies` fixture of the test "does not treat a strategy
>     class entry matching zero packages as an error" (:658), and the option's
>     comment (:224-230);
>   - the allowlist pin in "keeps the shipping contract valid under all of the
>     above" (:1017-1030);
>   - one `layerOf` assertion inside the existing test "classifies every
>     workspace package into exactly one §2 layer" (:442-458).
> - `docs/contracts/dependency-direction.md`, limited to:
>   - the §2 fence line and paragraph;
>   - rows S8-S18, moved verbatim from the PENDING subsection, which becomes a
>     dated DONE note;
>   - the S15 sentences in the §2.1 note and in §4;
>   - a dated §6 graph note with the MEASURED count.
> - `docs/handoffs/CORE-MOVE.md`.
>
> **Not granted.** The suite aliases (`tsconfig.json` and `vitest.config.ts`
> under `test/e2e`, `test/integration/paper-trader` and
> `test/integration/control-api`) and `tsconfig.lint.json` are not granted.
> They name the two facades, which stay at their paths. If a gate proves one of
> them must change, `CORE-MOVE` stops and reports, and the orchestrator amends
> this grant.
>
> **Invariants.**
> - `test/replay-golden/**` stays byte-identical.
> - Every moved file keeps its bytes, except the specifier-only edits named
>   above.
> - Line numbers are at `a8a3a63`. `CORE-MOVE` re-verifies them at its own
>   base by the content named beside each one.

#### DONE 2026-09-04: the `plain-data` / `schema-arena` mirror collapse (ruled by `GOV-2A`, executed by `WP-180-FU2`)

**The ruling is (a): the three byte-identical copies are collapsed to one
canonical implementation behind a same-layer edge. Duplication-with-drift-guard
is NOT ratified as the permanent shape.** `packages/risk`,
`packages/capital-allocator` (`WP-180`, merged `98a6cc1`) and
`packages/execution-planner` (`WP-190`, merged `5aa11e3`) each carried a
byte-identical `src/plain-data.ts` and `src/schema-arena.ts` below their header
markers, guarded three ways by `test/unit/execution-planner/mirrors.test.ts`.
**The collapse is executed**: as of 2026-09-04 (`WP-180-FU2`) the two modules
exist once, in `packages/risk`, and both consumers import them across **S3** and
**S4** above.

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

**The rows are now S3 and S4 in the table above**, moved there verbatim from the
staging block this subsection used to carry (id, edge, layer, basis — one per
consumer, because §2.1 rows are ordered pairs). They are no longer restated
here, because a second copy of a row the check parses is exactly the "private
copy of the table" §6 forbids.

**Why they were staged here first, and what discharged it.** §6.1 item 5 records
that `test/unit/tooling/dependency-direction.test.ts` pins the shipping allowlist
ids. `GOV-2A` reproduced the consequence mechanically in a `/dev/shm` scratch
copy: with S3 and S4 added, `check:deps` still **PASSED** (34 packages / 41
edges, both rows parsed and cross-validated against §2), and
`test/unit/tooling/dependency-direction.test.ts:801` **FAILED**
(`["S0","S1","S2"]` vs `["S0","S1","S2","S3","S4"]`). `test/**` is outside a
governance round's scope, so listing the rows on that day would have broken the
gate this document exists to keep. **That was the case §6.1 item 5 predicted**,
and its own rule was applied: `WP-180-FU2` moved the rows and the pinned
assertion in the **same change**, which is this one. The graph the check now
reports is **34 packages / 43 edges** — the 41 of 2026-09-04 plus S3 and S4.

**The grant, as `GOV-2A` wrote it on 2026-09-04.** Quoted, not paraphrased: a
recorded grant is the evidence of what was authorised, and editing it to match
what was later done destroys the only record a reader could check the work
against.

> **Owner: a bounded `WP-180-FU2` / mirror-collapse package**, with
> `allowed_paths` covering `packages/risk/src/{plain-data,schema-arena}.ts`,
> `packages/{capital-allocator,execution-planner}/**`,
> `test/unit/{risk,capital-allocator,execution-planner}/**`,
> `test/unit/tooling/dependency-direction.test.ts`, and this document.
> Migration path, in one change: move the two modules into `packages/risk`'s
> `exports` map; delete both copies; add the `workspace:*` dependency to each
> consumer; move S3/S4 into the table above; update the pinned allowlist
> assertion; keep `mirrors.test.ts` as a *deletion* guard (it must fail if a
> fourth copy appears) or retire it with its reason recorded. **Acceptance is
> behavioural, not structural**: every `WP-180`/`WP-190` pollution battery must
> still pass against the single implementation, because the point of collapsing
> them is that one fix protects all three — not that the files got shorter.

*(The closing sentence of that quotation was restored 2026-09-04 in
`WP-180-FU2` remediation round 2, review finding LOW-A: the round-1 restoration
stopped at "…or retire it with its reason recorded" and dropped the acceptance
criterion, which is the half of the grant that says what "done" means. Checked
against `8d8d47e:docs/contracts/dependency-direction.md`; the blockquote is now
that paragraph in full.)*

**CORRECTION — 2026-09-04, `WP-180-FU2` remediation round 1 (review finding
MEDIUM-2).** Two paths were written that the quoted list does not name:

- **`packages/risk/package.json`.** The grant listed only
  `packages/risk/src/{plain-data,schema-arena}.ts`, but its own migration
  instruction is "move the two modules into `packages/risk`'s `exports` map",
  and the `exports` map lives in the manifest. The instruction cannot be carried
  out inside the paths the same paragraph lists.
- **`pnpm-lock.yaml`, the two importer blocks only.** "Add the `workspace:*`
  dependency to each consumer" cannot be done without it: a workspace dependency
  that is not in the lockfile fails `pnpm install --frozen-lockfile`, which is a
  gate on every merge here.

**The orchestrator ruled both within the INTENDED authorization** — a `GOV-2A`
drafting error, not implementer overreach — and **ratified them** in
`WP-180-FU2` remediation round 1. The effective `allowed_paths` are therefore
the quoted list **plus** those two entries, and nothing else was written.

This note exists because the first `WP-180-FU2` candidate (`823209a`) instead
**rewrote** the quoted paragraph into a list matching what it had touched, with
no disclosure that the recorded grant had changed. That rewrite is undone above.
A grant that silently grows to fit the diff cannot be used to audit the diff.

**Executed 2026-09-04 by `WP-180-FU2`.** What landed, in one change: the two modules
are exported from `packages/risk`'s `exports` map as `./plain-data` and
`./schema-arena` and nothing else was added to that map; both copies are
**deleted**; each consumer declares `@polymarket-bot/risk: workspace:*`; S3/S4
are in the table above; the pinned allowlist assertion reads
`["S0","S1","S2","S3","S4"]`; and `test/unit/execution-planner/mirrors.test.ts`
is repurposed from a *drift* guard into a **deletion** guard — it fails if either
module's body reappears under any `apps/*/src` or `packages/*/src` outside
`packages/risk` *(the `apps/*` half added 2026-09-04 in remediation round 2,
review finding LOW-B: the round-1 walker read `packages/` only, and a verbatim
`cp` of the door into `apps/trader/src/` passed the guard 7/7 —
`pnpm-workspace.yaml` globs `apps/*` and six apps have `src` trees)*, and it
pins that both consumers resolve the modules through the `exports` map. The
risk copies' bodies were **not** edited: below their markers they are byte for
byte the files `WP-180` review rounds 4-9 left, sha256
`a318a50100758ba968f0360795655d78dbb3ec86beebb861e0b1006793dc7826`
(`plain-data.ts`, 30179 UTF-8 bytes) and
`35aaf0b907ccda16567eb7e7b920df8bb29175102e72ff99d524dc1363dccc53`
(`schema-arena.ts`, 21379 UTF-8 bytes) — the same two hashes all three deleted
copies carried, measured at `8d8d47e` before the deletion and at this tip after
it, and pinned mechanically by the deletion guard.

**Acceptance was behavioural, not structural**, and it held: every
`WP-180`/`WP-190` pollution battery passes against the single implementation
with **no behavioural assertion changed** — not one probe outcome, refusal code,
verdict or parse result was edited to go green. That is the claim that mattered,
because the point of collapsing the copies is that one fix protects all three,
not that the files got shorter.

**The test edits the collapse did force are all DUPLICATION BOOKKEEPING or the
"no edge exists" assertions this ruling overturned**, and they are listed here
rather than left to a handoff, because a reader who finds them later is entitled
to know they were anticipated:

- `test/unit/execution-planner/mirrors.test.ts` — drift guard → deletion guard
  (the ruling's own instruction). Its copy fingerprint has been strengthened
  twice, and the second time because the first attempt's own bar was wrong:
  - *2026-09-04, remediation round 1 (review finding LOW-1)* — the first
    candidate required ALL of three declaration lines per module, so a full
    pasted copy with the single identifier `describeValue` renamed evaded it
    entirely. Replaced by "at least four of twelve distinctive body lines".
  - *2026-09-04, remediation round 2 (review finding MEDIUM-A)* — those twelve
    lines were whole STATEMENTS, and nine of the `plain-data` twelve were
    written in four identifiers (`problems`, `problem`, `out`, `state`). The
    reviewer pasted the whole module into `packages/execution-planner/src` with
    THREE consistent renames and string literals untouched: **3/12, evaded**,
    with `typecheck`, `lint`, `check:deps` and every test still green. Both
    tables were re-derived on one rule — **anchor only on what a
    paste-and-adapt does not change**: refusal payloads, strings the `zod`
    library fixes (`_zod`, `def`/`constr`/`run`/`check`, `jitless`,
    `propValues`), and expressions written solely in built-ins and `lib` types.
    Fourteen anchors per module now, threshold four, and **not one anchor
    carries a local identifier**. Re-measured: the reviewer's three-rename copy
    scores 14/14; renaming all 27 names `plain-data` declares scores 14/14;
    `schema-arena`'s round-1 set, measured rather than assumed, fell to **3/12
    under a mass rename** and its replacement holds at 13/14. The honest bar is
    now that **no identifier rename evades at any scale**, and that evasion
    needs eleven of the fourteen anchors broken — measured cheapest route:
    reword all seven refusal payloads, rename the `detailsNotAnObject` evidence
    key and restyle three construction expressions, i.e. change what the door
    says and how it builds. (Corrected 2026-09-04, review round 3 LOW-1: the
    payload anchors were also reachable SYNTACTICALLY by splitting each literal
    into runtime-identical concatenated halves; the matcher now collapses
    literal concatenation before comparing, measured to restore 14/14 against
    that route with the false-positive maximum unchanged, so the payload half
    of the route requires an actual rewording again.) False positives measured
    over all 510 workspace `.ts` sources: maximum 2 of 14. The test carries the full ladder;
- `test/unit/risk/public-surface.test.ts` — the four round-6 drift tests
  retired, with their reason recorded in place; their subject is deleted;
- `test/unit/risk/freshness.test.ts` — the `node:util` site census is an
  EQUALITY over `packages/{risk,capital-allocator}`, and the allocator's site
  went to zero;
- `test/unit/risk/prototype-access.test.ts` — the registration table listed each
  guarded construct twice, once per copy; the second set became stale
  registrations;
- `test/unit/risk/ports.test.ts` and `test/unit/execution-planner/ports.test.ts`
  — these ASSERTED that no manifest declared another, i.e. exactly the state S3
  and S4 overturn. They now assert the ruling instead, which is strictly
  stronger: the edge must exist, must run only INTO `packages/risk` (F9), and
  must carry only the two door subpaths — a bare `@polymarket-bot/risk` import
  of the engine now FAILS, where the old spelling could not see a subpath at
  all;
- `test/unit/execution-planner/determinism.test.ts` — its import allowlist gains
  the two door subpaths, enumerated one by one rather than by prefix;
- `test/unit/execution-planner/source-scan.ts` *(added 2026-09-04, remediation
  round 1, review finding MEDIUM-1)* — the one recursive source walker the four
  guards above now share. **Why the two preceding claims needed it**: at the
  first candidate (`823209a`) those scans enumerated `<package>/src` ONE LEVEL
  DEEP, so "a bare `@polymarket-bot/risk` import of the engine now FAILS" held
  only for a top-level file. A file at
  `packages/execution-planner/src/nested/sneak.ts` importing `parseRiskPolicy`
  from the package root passed all four guards, `pnpm check:deps` (34/43),
  `pnpm typecheck` and `pnpm lint` — reachability that the collapse itself
  created, because before it the same file failed to compile (TS2307, dependency
  undeclared). Measured both ways at `823209a` and at the remediation tip, with
  a second probe two directories deep and a third importing a NON-door subpath.
  The claims above are true at any depth now, and there is one scan idiom rather
  than three so they cannot drift apart again. *Widened 2026-09-04 in
  remediation round 2 (review finding LOW-B)*: its workspace walk covered
  `packages/` alone, so the deletion guard's "any workspace member" was false
  for the six `apps/*` with `src` trees — a verbatim paste into
  `apps/trader/src/` passed 7/7. It now walks the roots `pnpm-workspace.yaml`
  globs, `apps/*` included, and the app trees are asserted by name so removing
  one fails rather than shrinking the guard;
- `test/unit/risk/schema-arena.test.ts` — the allocator-arena binding is now an
  alias of the canonical one; every differential assertion over the allocator's
  three door schemas, including the `AGENTS.md` live-micro fence, is unchanged.

**2026-09-05, `WP-200-FU1`: two of the four anticipated consumers arrived, and
they took the edge rather than a copy.** *(Authorised and dispatched 2026-09-04
off `main` `761db76`, which is also the tip its base measurements were taken
against; this note was written the following day.)* The paragraph above records that
`docs/contracts/schema-boundary.md` §5 assigns "four more packages that would
otherwise copy it a fourth, fifth, sixth and seventh time." The first of those
assignments — §5 item 1, the monetary path — is executed: `packages/ledger` and
`packages/pnl` now consume the canonical door across **S5** and **S6** above.
Neither package contains a copy of either module's body; the deletion guard in
`test/unit/execution-planner/mirrors.test.ts` covers both `src` trees by the
same workspace walk it already ran, and it passes unchanged. The graph the
check now reports is **34 packages / 49 edges** — the 47 of this tip plus S5 and
S6. The §6.1 item 5 rule was applied again exactly as `WP-180-FU2` applied it:
the two rows and the pinned allowlist assertion in
`test/unit/tooling/dependency-direction.test.ts` (`["S0".."S4"]` →
`["S0".."S6"]`) moved in the **same change**. This note is the evidence that the
collapse's stated purpose held under its first retrofit consumer: one
implementation, two more doors, no fourth copy.

Nothing else is enumerated yet, and that is deliberate: the check **fails closed**
(§6), so the first package that genuinely needs a new same-layer edge adds its
row. One known case will need one and does not have a citation today:

- **`packages/testkit`.** It is layer 1 and test-only. The first layer-1 package
  that takes a `devDependency` on it creates a same-layer edge. The handoff names
  the package (§5 layout) but specifies nothing about it, so no row can be
  written on evidence yet; the owning work package writes it.

*(Settled 2026-09-28 by `H8-GOV`. Until that date this list carried a second
case: where the handoff §12.1 `ExecutionVenue`, `Clock` and `MarketEventSource`
interfaces would be declared. `WP-210` declared all three in
`packages/simulation`, which is layer 1 (`docs/handoffs/WP-210.md`
deviation 3). `packages/simulation` implementing its own interface is no edge
at all, and every consumer was then a layer-3 application depending downward
(`apps/trader`, `apps/backtest-cli`), so no row was needed. That handoff's
`follow_up` 6 asked this document to record the settlement, and this note
records it. The replaced bullet read: "The handoff does not say which package
declares them. If they land in a layer-1 package, then `packages/simulation`
implementing `ExecutionVenue` (`WP-210`) is a same-layer edge needing a row; if
they land lower, it is an ordinary downward edge. `WP-190`/`WP-210` settle
it.") The first same-layer consumer of those interfaces is `packages/trading-core`, on row S15.)*

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
| `packages/risk` | 1 | `node:util` | `types.isProxy` | `src/plain-data.ts:171` (used at `:201`). A pure-JS proxy probe *runs a trap*, i.e. executes caller code inside the door that exists to stop caller code running (`plain-data.ts:92-97`) | `WP-180` R6-1 |
| `packages/execution-planner` | 1 | `node:util` | `types.isProxy` | `src/pluck.ts:28` (used at `:58`) — the §6 invariant 13 minimal-read cancel path | `WP-190` R1-N2 |
| `packages/features` | 1 | `node:crypto` | `createHash` | `src/hash.ts:14`. Content addressing needs SHA-256; a hand-rolled FIPS 180-4 implementation in production code is a correctness liability, and `WP-160`'s review used exactly that as an independent *oracle* rather than as the shipped path | `WP-160` R1-N1 |
| `packages/universe` | 1 | `node:crypto` | `createHash` | `src/series-admission.ts:89` (used at `:383`). The reviewed series' configuration hash is SHA-256 over its canonical JSON, pure and clock-free; a hand-rolled digest in production code is a correctness liability. Consumed by `packages/trading-core` over S19 (`C1-UNIV`), which is why the core's closure reaches `node:crypto` | `C1-UNIV` follow-up 2 |

**The table is exhaustive for the layer-0 and layer-1 PRODUCTION import
surface**, and a package outside it importing any built-in *in a production
source file* is a violation (F17). Verified mechanically at `main` `2d7e7da`,
and **re-run 2026-09-04 after the mirror collapse** (`WP-180-FU2` remediation
round 1): a census of every non-test `node:` import under `packages/` and
`apps/` returns exactly these **three** files below layer 2 —
`packages/risk/src/plain-data.ts`, `packages/execution-planner/src/pluck.ts`,
`packages/features/src/hash.ts` — plus `packages/decimal`'s existing one. Every
other `node:` import in the workspace is in a layer-2 package
(`event-bus`, `storage-wal`, `storage-postgres`, `storage-parquet`) or a layer-3
app (`data-gateway`, `ops-cli`, `research-worker`).

*(Was five at `2d7e7da`. The collapse deleted the two mirrored
`src/plain-data.ts` copies, so `packages/capital-allocator` now imports **no**
Node built-in in production source at all and its row is REMOVED — an allowlist
row for a package that imports nothing over-permits, and this table is the
permission. `packages/execution-planner`'s row loses its `src/plain-data.ts`
citation and keeps `src/pluck.ts`, which is its own non-mirror file. Row removal
and re-citation both happen here, in the same change as the deletion that made
them true; the row and the fact may not drift apart. Corrected 2026-09-04 in
`WP-180-FU2` remediation round 1, review finding LOW-2 — the original candidate
left the over-permitting row and the two stale line citations standing.)*

**Test files are outside this table, and that scope is stated rather than
implied** *(qualified 2026-09-04 in `GOV-2A`'s round-1 review remediation; the
first drafting said "importing any built-in" with no such qualification, and its
own census sentence covered only non-test imports)*. The same census run over
**test** files at `2d7e7da` returns six layer-1 files importing built-ins this
table does not enumerate — `packages/universe/src/{seeds,settlement-binding}.test.ts`,
`packages/settlement/src/seeds.test.ts`,
`packages/observability/src/recorder/{infra-consistency,validation-findings}.test.ts`
and `packages/capital-allocator/src/allocator.test.ts`, all reading seed or
dashboard fixtures through `node:fs` / `node:path` / `node:url` — plus two that
*are* enumerated for their package (`packages/decimal/src/hash.test.ts` and
`packages/features/src/snapshot.test.ts`, both `node:crypto`). An unqualified
F17 would therefore have been violated by merged code on the day it shipped,
which is precisely the "a gate every merged package fails is a gate that gets
waived wholesale" failure mode §6.1 item 1 ruled against.

**Why tests are out of F17's scope while they are IN scope for rule 3** (§6.1
item 2 ruled that a purity-restricted package's test files *are* covered): the
two rules govern different properties. F17 governs a package's **runtime import
surface** — what the shipped module graph is allowed to reach, and a fixture
read that never executes in the trading process does not widen it. Rule 3
governs **purity**, which is a property of *behaviour* and therefore holds
wherever the code runs: a strategy test that reads a real clock or unseeded
randomness reintroduces exactly the nondeterminism §12.4 exists to exclude. So a
strategy test may still not read `Date.now`, and a layer-1 test may read a
fixture file. The rulings are not in tension, and neither may be cited to relax
the other.

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
| F10 | Any package depending on an `apps/*` package | §5 layout; apps are composition roots. **Enforced by the §6 check since `DEPCHECK-1` (2026-09-28)**, in rule 2: a declared workspace edge (any `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies` entry) into an `apps/*` package fails F10, whatever the two layers and whatever §2.1 says. An upward edge into an app also fails F12. A same-layer one fails F10 in place of F13, because F13's remedy, a §2.1 row, is itself a `CHK` error here: a §2.1 row whose `to` endpoint is an application is rejected, since F10 has no §2.1 exception. A relative import of an app's files fails F16 (below). Not checked: an import of an app by package name that no manifest declares, since rule 3 has no F10 arm |
| F11 | A strategy reading a clock or unseeded randomness (`Date.now`, `Math.random`) | §6 invariant 2, §7.6, ADR-005 §1 |
| F12 | Any workspace edge from a lower-numbered layer to a higher-numbered one | §5.2 (the allowed direction is one-way), §2 of this document |
| F13 | Any **same-layer** workspace edge not listed in §2.1 | §2, §2.1 of this document |
| F14 | Inside a **purity-restricted** package (`packages/domain`, `packages/strategies/**`, `packages/ledger`, `packages/simulation`), any construct that makes F1–F8/F11 **unevaluable**: a module load whose specifier is not a static literal; a reference to a module-**loading capability** (`require` and its aliases, a CommonJS `Module` object incl. `process.mainModule`/`require.main`, `createRequire` and its result, `process.getBuiltinModule`, the `node:module` namespace/`Module` class/`register`) in a position that escapes this document's analysis; a computed member read on such a capability; and a reference to an **evaluator** (`eval`, `Function`, or a read of the `.constructor` property) | §5.2 and ADR-005 §1, read as intent rather than as a list of spellings: a package forbidden to perform I/O has no legitimate use for a module loader or an evaluator, and a construct that defeats static checking cannot be permitted to *establish* compliance. Numbered 2026-08-28 (`GOV-1B`) from `docs/handoffs/WP-015.md` `follow_up` 6 |
| F15 | `packages/decimal` importing anything beyond `decimal.js` and `node:crypto` | `docs/contracts/domain.md` §1 ("Dependencies: `decimal.js` and `node:crypto` only … the package performs no I/O") and §2 of this document (the Layer 0 "May import" cell). Numbered 2026-09-02 (`GOV-1C`) from `docs/handoffs/WP-015.md` `follow_up` 4 via §6.1 item 4 — the allowlist was "enforced by construction" with no F-row, so a violating edit would have been a review finding rather than a gate failure. **Not yet implemented by the §6 check** (the same tooling follow-up as the F14 machine-id swap); until then, enforcement-by-construction and review remain the mechanism |
| F16 | A cross-package **deep import** — any workspace import specifier that resolves inside another workspace package other than through that package's `package.json` `exports` map | `docs/handoffs/WP-015.md` `follow_up` 3 via §6.1 item 4, numbered 2026-09-02 (`GOV-1C`) on the evidence that **every** workspace package (28/28 as of this date) declares an `exports` map, so "bypassing the entry point" is well-defined. Largely platform-enforced already: Node refuses an unexported subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`) and `NodeNext` resolution mirrors it at typecheck — the row exists so a widened `exports` map or a bundler that resolves around encapsulation is a contract violation, not a loophole. **The relative half is enforced by the §6 check since `DEPCHECK-1` (2026-09-28)**, in rule 3. A relative specifier fails F16 when it resolves, lexically from the importing file, outside the importing package's root (into another package, into an application, or into no package at all) or through a `node_modules` directory. This is wider than a deep import, on purpose: a package reaches nothing outside its own root by path. Rule 3 applies it to every specifier it reads as a literal: static `import` and `export … from` (type-only and `export *` included), `import x = require(…)`, an `import("…")` type, a dynamic `import()`, and a `require`-family load. Not covered: a specifier that is not a literal (F14's business, and only in the purity-restricted packages); `require.resolve`, `import.meta.resolve("<relative>")` (added 2026-09-28 by `DOCS-1`: measured, it is not judged), a `/// <reference path>`, a JSDoc `import("…")` type in a `.js` file, a `vi.mock` path, and a file read by path such as `new URL(…, import.meta.url)`; a symlink inside a package's own tree; and files outside every workspace package (`test/**`, `tools/**`). **The bare-name half — a subpath import around a package's `exports` map — is not yet implemented** (same tooling follow-up); Node and `NodeNext` refuse an unexported subpath, as above |
| F17 | A **layer-0 or layer-1** package importing, **in a production (non-test) source file**, a Node built-in binding that §2.2's table does not enumerate for that package | §2.2 (ruled 2026-09-04 by `GOV-2A`), discharging `WP-180` `follow_up` R6-1, `WP-190` R1-N2, and `WP-160` R1-N1, which each disclosed an instance and asked the contract owner to rule rather than ratifying it locally. Generalises F2 (`packages/domain`: none) and F15 (`packages/decimal`: `node:crypto` only) into one criterion — trap-free, entropy-free, clock-free, I/O-free, synchronous and pure — plus an exhaustive per-package enumeration, so a new import is a cited contract edit rather than a reviewer's judgment call. Layers 2 and 3 are **not** constrained by this row. **The production-only scope is part of the rule** *(qualified 2026-09-04 in `GOV-2A`'s round-1 review remediation, which measured six layer-1 **test** files importing un-enumerated built-ins at the tip that shipped this row — see §2.2, which also states why test files are outside F17 while §6.1 item 2 holds them inside rule 3: F17 governs a package's runtime import surface, rule 3 governs purity, which is a property of behaviour everywhere)*. **Note the id namespace:** this F17 is a §3 forbidden-edge id and is unrelated to `WP-040` obligation **F17** (the OMS may not label an order `SIGNED` before its submission-attempt row exists), re-assigned to `WP-270` in [`protected-contracts.md`](./protected-contracts.md) §8.1 **R-9**; the two reached the same number by coincidence on the same date. **Not yet implemented by the §6 check** (same tooling follow-up as F15/F16) |

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
  does not say which package declares these interfaces. `WP-210` declared them in
  `packages/simulation` (layer 1; `docs/handoffs/WP-210.md` deviation 3), and the
  composition roots consume them downward. *(Settled 2026-09-28 by `H8-GOV`,
  discharging `WP-210` `follow_up` 6. This sentence previously ended "whichever
  package does must be classified in §2 and any resulting same-layer edge listed
  in §2.1"; `packages/simulation` is classified in §2, and no same-layer edge
  resulted.)* `packages/trading-core` consumes them across §2.1 row S15.

---

## 5. What is already enforced today

| Mechanism | Status |
| --- | --- |
| `packages/domain` imports only `zod` and `@polymarket-bot/decimal`; no Node built-in, no `process`/`globalThis`, no clock, no randomness | **Enforced by construction** in the frozen package; documented in `docs/contracts/domain.md` §2 |
| `packages/decimal` imports only `decimal.js` and `node:crypto` and performs no I/O | **Enforced by construction**; `docs/contracts/domain.md` §1. Numbered **F15** in §3 (2026-09-02); not yet evaluated by the §6 check |
| TypeScript project references and `pnpm` workspace resolution | A package can only import a workspace package it declares as a dependency |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | Run locally and in CI (`.github/workflows/ci.yml`) |
| **The §6 check itself** — cycles (F9), no dependency on an application (F10), layer conformance (F12/F13), forbidden specifiers and impure globals (F1–F8, F11), the opaque-construct rule (F14), the relative half of F16 (no relative import leaving its package), and two §2.1 row checks (a row whose `to` endpoint is an application, and a row that matches no declared edge, are `CHK` errors). F10, the relative half of F16 and the two row checks were added by `DEPCHECK-1` (2026-09-28) | **Implemented and CI-wired.** `tools/check-dependency-direction.mjs`, run by the root script `check:deps` and by the "Dependency direction and package boundaries" step in `.github/workflows/ci.yml`, between the lint and unit-test steps. It parses §2 and §2.1 from **this document** at run time (§6) and fails closed on a contract it cannot parse |

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

**The graph as of 2026-09-15** (recorded by `GOV-2C`, discharging the
`SER-3` follow-up that asked this document to "record the six new downward
`risk` edges and the consumed subpath `./plain-json`"; verified by running the
check at `main` `1aa2238`): **34 workspace packages, 78 declared workspace
edges**, and it passes. The 2026-08-28 table above is left as history; the
intermediate counts this document already carries (43 after `WP-180-FU2`, 49
after `WP-200-FU1`, both in §2.1) are likewise history. What the
inherited-`toJSON` sweep added is **seven ordinary downward edges**, each a
consumer of one export — the own-data JSON encoder
`packages/risk/src/plain-json.ts`, exported from `packages/risk`'s `exports`
map as `./plain-json` (the map now carries exactly `.`, `./plain-data`,
`./plain-json`, `./schema-arena`) — and none of them is a §2.1 row because
none is same-layer:

| Edge | Layers | Verdict | Added by |
| --- | --- | --- | --- |
| `packages/event-bus` → `packages/risk` | 2 → 1 | downward | `SER-1` (merged `c065d63`; `check:deps` 34/71 → 34/72) |
| `packages/storage-wal`, `packages/storage-parquet`, `packages/storage-postgres` → `packages/risk` | 2 → 1 | downward (3 edges) | `SER-2` (merged `0d8b6a0`; 34/72 → 34/75) |
| `packages/polymarket-public`, `packages/coinbase-adapter` → `packages/risk` | 2 → 1 | downward (2 edges) | `SER-3` (merged `603a49c`; 34/75 → 34/78, with the row below) |
| `apps/data-gateway` → `packages/risk` | 3 → 1 | downward | `SER-3` (`apps/control-api` and `apps/trader` already declared `packages/risk` since `WP-240` `0e7227d` and `WP-230` `8425e03`) |

Two things this table is NOT. It is not a widening of S3/S4/S7: those rows'
"consumed surface is the prototype-free parse door only" clauses are unchanged
and true — `packages/capital-allocator`, `packages/execution-planner` and
`packages/strategy-runtime` do not import `./plain-json` (grep at `1aa2238`);
S5 and S6 were widened in place by `SER-1` and say so. And it is not a
statement that every layer-2 package now depends on `packages/risk`:
`packages/binance-adapter` and `packages/polymarket-secure` do not. The
direction question a reader might raise — a layer-2 adapter depending on a
layer-1 *risk* package for a JSON encoder — is the same one the 2026-09-04
mirror-collapse ruling answered for the parse door: `packages/risk` is the
canonical home of the own-data machinery (`schema-boundary.md` §1, §5 items
5 and 11), the edge is downward, and no rule, policy or evaluation logic
travels it. If that home ever moves to a lower layer, every row in this table
moves with it and the count is re-recorded here.

**The graph as of 2026-09-28** (recorded by `CORE-MOVE`; measured by running
the check on the round's tree, base `main` `ac0b12f`): **35 workspace packages,
89 declared workspace edges**, and it passes. The check reported 34 packages and
80 edges at the base. The new package is `packages/trading-core`, which §2
classifies in layer 1 (§2.1's DONE note of the same date). The edge changes
below come from diffing the check's `--json` edge list at the base and after the
move, and they net to +9:

| Edge | Layers | Verdict | Count |
| --- | --- | --- | --- |
| `packages/trading-core` → `packages/capital-allocator`, `packages/execution-planner`, `packages/features`, `packages/ledger`, `packages/order-book`, `packages/pnl`, `packages/risk`, `packages/simulation`, `packages/strategy-runtime`, `packages/strategy-sdk`, `packages/strategies/static-bracket` | 1 → 1 | same-layer; §2.1 rows **S8-S18**, one per edge | +11 |
| `packages/trading-core` → `packages/decimal`, `packages/domain` | 1 → 0 | downward | +2 |
| `apps/trader` → `packages/trading-core` | 3 → 1 | downward | +1 |
| `apps/trader` → `packages/decimal`, `packages/execution-planner`, `packages/features`, `packages/order-book`, `packages/strategies/static-bracket` | 3 → 0, 3 → 1 | removed: no `apps/trader` source file imports these after the move (ADR-018 §3; the orchestrator's `CORE-MOVE` ruling) | −5 |

The core declares `zod` as its one external runtime dependency, and it imports
no `node:` module, so it needs no §2.2 row.

**The graph as of 2026-09-28, after `BACKTEST-2`** (recorded by `BACKTEST-2`;
measured by running the check on the round's tree, base `main` `f8aedec`, and
diffing its `--json` edge list against the base's): **35 workspace packages,
90 declared workspace edges**, and it passes, with the §2.1 allowlist still
exactly S0..S18 and every row matching a declared edge. The check reported 35
packages and 89 edges at the base. The one change is `apps/backtest-cli` →
`packages/trading-core` (layer 3 → layer 1, a `dependencies` entry): downward,
so no §2.1 row, and not an edge into an application (F10). It is the edge
ADR-022 D5 names: the backtest executable now builds the shared core itself
(`apps/backtest-cli/src/assembly.ts`). No other edge was added or removed.
Across row S15 the core's consumed surface of `packages/simulation` now
includes the simulated-venue construction the row's `BACKTEST-2` sentence
names, in `packages/trading-core/src/venue-builder.ts`: `SimulatedVenue`,
`tier0Model`, `readFeeScheduleSnapshot`, `unmodeledRateLimits`, the `BookView`
type, and the types of those calls' own inputs and results
(`FeeScheduleSnapshot`, `RateLimitBudget`, `SimulatedVenueOptions`,
`SimulationRefusal`).

**The graph as of 2026-10-09, after `C1-UNIV`** (recorded by `C1-UNIV`;
measured by running the check on the round's tree, base `main` `8589174`):
**35 workspace packages, 106 declared workspace edges**, and it passes, with
the §2.1 allowlist now exactly S0..S19 and every row matching a declared edge.
The check reported 35 packages and 105 edges at the base. The one change is
`packages/trading-core` → `packages/universe` (layer 1 → layer 1, a
`dependencies` entry), the same-layer edge row **S19** lists. No other edge was
added or removed. The core's own source still imports no `node:` module; its
closure reaches `node:crypto` through `packages/universe`'s `createHash`, as it
already did through `packages/features` (S10), so the core needs no §2.2 row.

1. **Cycle detection.** Fail on any cycle in that graph. Non-zero exit, named
   cycle in the output. This is the rule §5.2 states literally, and it is what
   makes same-layer edges safe to permit at all (F9).
2. **Layer conformance**, evaluated per edge `A → B` against §2 and §2.1:
   - `B` is an application (`apps/*`) → **fail** (F10), whatever the two
     layers and whatever §2.1 says. The layer rules below still apply, except
     that a same-layer edge into an app reports F10 without F13: F13's remedy
     is a §2.1 row, and no row may permit this edge.
   - `layer(B) < layer(A)` → **pass**.
   - `layer(B) > layer(A)` → **fail** (F12), reporting both packages and both
     layers.
   - `layer(B) = layer(A)` and the ordered pair `(A, B)` is in §2.1 → **pass**.
   - `layer(B) = layer(A)` and the pair is **not** in §2.1 → **fail** (F13), with
     a message that names §2.1 as the place to add a cited row.
   - Either package unclassified in §2 → **fail** (see fail-closed below).
   `packages/strategies/**` is layer 1 for this rule; F3 and F11 constrain it
   further and are checked by rule 3, not here.
   Two §2.1 rows are `CHK` errors, like a row that does not parse:
   - a row whose `to` endpoint denotes an application, because F10 has no §2.1
     exception;
   - a row that matches no declared workspace edge, because §2.1 lists the
     same-layer edges the repository has, and a stale row would silently
     re-permit its edge if the edge came back. The change that removes an
     edge removes its row, and a new row lands with its edge. Two cases are
     not reported as stale: a row naming a class glob that matches no
     workspace package (as for a §2 class entry), and a row naming a path
     that has no manifest (already `F-CLOSED`).
   *(F10 and both row checks enforced since `DEPCHECK-1`, 2026-09-28.)*
3. **Forbidden-specifier scan.** Fail on any import specifier that violates F1–F8
   and F11 inside the offending package's source — for example `@polymarket/client`
   outside `packages/polymarket-secure`, `node:fs` inside `packages/strategies/**`,
   an archived client anywhere, or `Date.now`/`Math.random` inside a strategy.
   This rule reads source, not `package.json`, because a bare `node:` import
   appears in neither dependency list. It also fails the relative half of F16:
   a relative specifier, in any form the rule reads as a literal, that resolves
   outside the importing package's root or through a `node_modules` directory.
   Only files inside a workspace package are read, so `test/**` and `tools/**`
   are outside this rule. *(The F16 half enforced since `DEPCHECK-1`,
   2026-09-28.)*

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
