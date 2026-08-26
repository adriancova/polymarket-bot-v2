# ADR-005: Strategy purity and the `DecisionResult` contract

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-020` (`DecisionResult`, intent types — done and
  frozen); `WP-170` (`StrategyContext`, runtime, watchdog, checkpointing);
  `WP-220` (first strategy)
- **Supersedes / Superseded by:** none

## Context

Handoff §2 locks the strategy contract ("Deterministic, synchronous,
side-effect-free strategies return `DecisionResult` objects containing zero or
more intents") and the execution boundary ("Strategies emit intents; risk,
allocation, execution planning, OMS, and venue adapters own orders"). Handoff §6
invariants 2 and 3 restate purity and the one-decision-per-callback rule as
enforced invariants. Handoff §1.3 makes "allowing a strategy to perform I/O or
submit orders directly" an ADR-gated change.

`WP-020` froze `DecisionResult` and the five intent types but had to **infer**
two shapes that §7.7 references without defining — `QuoteLevel` and `BasketLeg` —
and flagged both for ratification here (`docs/handoffs/WP-020.md` →
`deviations` 3, `known_risks` 3, `follow_up` 2). `WP-020` also deliberately left
`StrategyContext` and the §7.6 view types out of `packages/domain`
(`docs/contracts/domain.md` §1).

## Decision

### 1. Purity is absolute, and it is a package-boundary property

A strategy has **no side effects**: no network, database, filesystem,
environment, global clock, or unseeded randomness (§6 invariant 2). Concretely:

- Time comes from `ctx.now()`; a strategy never reads `Date.now()` or a system
  clock.
- Randomness comes from `ctx.rng()`, a per-run deterministically seeded generator
  (§9.6); a strategy never calls `Math.random()`.
- A strategy never logs. It returns `reasonCodes`, `modelOutputs`, and a
  `statePatch`, and the runtime persists them (§7.5).
- A strategy never submits, cancels, or amends an order. It emits intents
  (§2, §7.7).
- No context method performs network or database I/O; the runtime builds the
  context from current in-memory state (§7.6).

Purity is enforced structurally, not by convention: `packages/strategies/**` may
not depend on venue clients, Redis, PostgreSQL, or filesystem APIs (§5.2, and see
`docs/contracts/dependency-direction.md`). A strategy that needs a fact it cannot
see must get it through a feature (§9.5) or a context view (§7.6) — never by
reaching for I/O.

### 2. Exactly one persisted `DecisionResult` per callback

Every strategy callback returns exactly one `DecisionResult`, and **the runtime,
not the strategy, guarantees that exactly one decision record is persisted**
(§6 invariant 3, §9.6).

`DecisionResult` is the §7.5 shape:

```ts
export type DecisionResult = {
  decisionType: "enter" | "exit" | "quote" | "hold" | "skip" | "cancel" | "reduce";
  reasonCodes: string[];
  featureSnapshotRef: string;
  modelOutputs?: Record<string, DecimalString | string | boolean | null>;
  statePatch?: Record<string, unknown>;
  intents: Intent[];
  nextWakeupAt?: string;
};
```

- **`intents` may be empty.** A `hold` or `skip` is a decision and is persisted
  like any other; "no action" is a recorded fact, not an absence.
- The runtime adds timing, run, market, event, and strategy identifiers (§7.5).
  A strategy cannot forge them.
- `featureSnapshotRef` ties the decision to the immutable, content-addressed
  feature snapshot it saw (§9.5), which is what makes §6 invariant 4's
  traceability chain complete.

### 3. Watchdog timeouts still produce exactly one record

§9.6 requires evaluation-time watchdogs, and §6 invariant 3 requires exactly one
persisted decision per callback. These meet when a callback exceeds its budget.

**Decision:** when the watchdog fires, the runtime persists exactly one decision
record for that evaluation, attributed to the **runtime** rather than to the
strategy, carrying a `skip` decision type, a reserved reason code, and no intents;
it discards any value the strategy later returns for that evaluation; and it
pauses the instance and raises an incident. The evaluation is thereby recorded as
having happened and having produced no intent, which is both true and
replayable.

The mechanism (how the budget is measured, how the instance is paused) belongs to
`WP-170`. What is fixed here is that a timeout may not produce zero records, may
not produce two, and may not be attributed to the strategy as though the strategy
had decided to skip.

### 4. Strategies emit intents; nothing else

The execution hierarchy is one-directional (§9.10):

```text
Decision → Intent → Approved Intent → Execution Plan → Execution Group
        → Submission Attempt → Venue Order → Order Event → Fill
        → Fill Allocation → Settlement Event
```

- **A risk veto never silently mutates an intent.** A resize creates a **new
  approved-intent record linked to the original** (§7.7). The strategy's original
  intent stays in the record exactly as emitted, which is what makes veto and
  resize analytics honest (§14.3 "vetoes by reason").
- **Exit quantity is based on confirmed actual allocation, never requested entry
  size** (§6 invariant 10). A strategy that sizes an exit from its own entry
  intent is wrong even when the numbers happen to agree.
- **No blind flatten** (§6 invariant 12): unknown position or book state causes
  cancel and reconciliation before any protected reduction. A strategy cannot
  opt out of this, because it does not own orders.

### 5. Determinism

Given a fixed dataset, code commit, config, feature version, model version,
simulator version, and seed, decisions and intents must be **byte-identical**
(§12.4), and CI runs a small golden replay on every change to core contracts.
Strategies are evaluated in a stable, recorded order: market ownership priority,
then instance priority, then instance UUID (§8.2).

A new run starts for every code, config, model, feature, or state-schema change
(§9.6). Strategy state is checkpointed after defined transitions and restored on
restart only when compatible (§9.6).

### 6. `StrategyContext` stays out of `packages/domain`

Ratified: `StrategyContext` and the §7.6 view types (`MarketView`,
`OrderBookView`, `FeatureSnapshot`, `VirtualPositionView`, `StrategyOrderView`,
`RiskBudgetView`, `SeededRandom`) are **owned by `WP-170`**, not by the frozen
domain package.

Rationale: `packages/domain` is a declarations-only package with no behavior
(`docs/contracts/domain.md` §2). `StrategyContext` is an interface over live
runtime state whose view shapes depend on components that do not exist yet (the
book, the feature engine, the risk engine). Freezing them now would either invent
those shapes or freeze a placeholder that every later package has to work around.

### 7. Ratified inferred shapes

§7.7 references `QuoteLevel` and `BasketLeg` without defining them. The `WP-020`
inferences are **ratified as the v1 minimum**:

| Type | Ratified shape | Rationale |
| --- | --- | --- |
| `QuoteLevel` | `{ price: PriceString, shares: SharesString (non-negative) }` | The minimum needed to express a quote level. A quote level is a price and a size; anything else (queue position, replace policy, tags) is execution policy and already lives on `QuoteIntent` (`quoteLifetimeMs`, `replaceThresholdTicks`, `maximumInventory`) or in the execution planner (§9.10). |
| `BasketLeg` | `{ marketId, direction, targetShares, maximumBuyPrice?, minimumSellPrice? }` | Mirrors the per-leg subset of `PositionIntent` that a coordinated basket needs. Basket-level economics (`maximumCombinedCost`, `minimumLockedEdge`, `legRiskLimit`, `failurePolicy`) are already on `BasketIntent` and must not be duplicated per leg. |

Supporting decisions ratified with them:

- `marketId` in intents is an `InternalMarketId` (UUIDv7). §7.7 types it `string`;
  §7.2 makes `InternalMarketId` the canonical internal market identifier, so
  intents validate it as one rather than accepting any string.
- Magnitude caps are non-negative: `maximumTotalCost`, `maximumInventory`,
  `maximumCombinedCost`, `legRiskLimit`, `minimumFillShares`. A negative magnitude
  cap is a bug, not a strategy.
- `targetShares` on a `PositionIntent` may be negative, because `targetMode` may
  be `DELTA` (§7.7).
- Identifiers §7.2 leaves unformatted (`StrategyRunId`, `DecisionId`, `IntentId`,
  `ExecutionPlanId`, `SubmissionAttemptId`) remain bounded non-empty strings.
  Inventing a format would be a silent contract.

**Extending either shape after this ratification requires a `schemaVersion`
increment under ADR-002 §3 plus orchestrator approval** — they are inside the
frozen `packages/domain` (`docs/contracts/protected-contracts.md`).

Venue grounding for one detail: `QuoteIntent.postOnly` is the literal `true`
(§7.7), which matches the venue fact that post-only applies **only to resting
limit types** (venue report §2.3). A quote that is not post-only is not a quote in
this system's vocabulary; it is a `PositionIntent` with a liquidity preference.

### 8. Basket execution is coordinated, never atomic

§7.7: "Basket execution is coordinated, not assumed atomic." §3.2 puts "multi-leg
arbitrage that assumes atomic execution" out of scope. `BasketIntent.failurePolicy`
(`ABANDON | PROTECTED_UNWIND | HOLD_FILLED_LEGS`) is mandatory precisely because
partial completion is the expected case. No component may label a basket
atomic (work-plan `WP-190` acceptance: "Coordinated basket is never labeled
atomic").

## Consequences

- **A strategy cannot observe anything the runtime does not hand it.** That is the
  point, and it means every new signal is a feature-engine change with a version
  (§9.5), reviewable and replayable, rather than an ad-hoc read.
- **Decision volume is high and decisions are persisted.** One record per
  evaluation per subscribed instance is a real write-volume commitment; §9.5
  already anticipates it ("High-frequency snapshots may live in the event archive;
  important action decisions store a durable snapshot reference plus selected
  indexed values in PostgreSQL").
- **The watchdog ruling makes a timeout visible in decision analytics.** A run
  whose instance times out repeatedly shows up as runtime-attributed skips, not as
  a mysterious absence of decisions.
- **Ratifying minimal `QuoteLevel`/`BasketLeg` shapes will cost a version bump
  later.** The market-making path (`WP-190`, and the passive-market-maker strategy
  in §18 Phase 6) may need more per-level or per-leg fields. That is accepted: a
  version bump with a recorded reason is cheaper than freezing speculative fields
  now, and strict schemas make the omission fail loudly rather than silently.
- **Purity is only as strong as the boundary check.** Nothing today mechanically
  prevents a strategy package from importing `node:fs`; the dependency-direction
  CI check that would (`docs/contracts/dependency-direction.md`) is **not yet
  implemented**. Until it exists, purity rests on review plus the determinism
  golden test.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §1.3 — allowing a strategy to perform I/O or submit orders directly requires an
  ADR.
- §2 — the locked strategy contract and execution boundary.
- §3.2 — multi-leg arbitrage assuming atomic execution is out of scope.
- §5.2 — strategies may not import venue clients, Redis, PostgreSQL, or filesystem
  APIs.
- §6 invariants 2, 3, 4, 10, 12, 15.
- §7.2 — canonical identifiers, including `InternalMarketId` as UUIDv7.
- §7.5 — the `DecisionResult` shape and "the runtime adds timing, run, market,
  event, and strategy identifiers and persists exactly one decision record after
  the callback returns".
- §7.6 — `StrategyContext` and the rule that no context method performs I/O.
- §7.7 — the five intent types; `QuoteLevel` and `BasketLeg` referenced but not
  defined; `postOnly: true` on `QuoteIntent`; "A risk veto never silently mutates
  an intent. A resize creates a new approved-intent record linked to the
  original"; "Basket execution is coordinated, not assumed atomic".
- §8.2 — stable strategy evaluation order recorded in the run manifest.
- §9.5 — feature snapshots are immutable and content-addressed.
- §9.6 — strategy runtime responsibilities, including seeded RNG, watchdogs,
  exactly one persisted `DecisionResult`, checkpointing, and a new run per code/
  config/model/feature/state-schema change; the `Strategy<TParams, TState>`
  callback interface.
- §9.10 — the execution hierarchy.
- §12.4 — determinism requirements and the CI golden replay.
- §13.3 — Static Bracket rules: exit size equals actual allocated filled size; a
  stop on stale data is forbidden.
- §14.3 — metric families including strategy evaluation latency and vetoes by
  reason.

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §2.3 — order types GTC/GTD/FAK/FOK; **`postOnly` applies only to resting limit
  types**. This is the only venue fact this ADR relies on.

**Implementation and prior handoffs:**

- `docs/contracts/domain.md` §1 (`StrategyContext` and the §7.6 views deliberately
  absent, owned by `WP-170`), §8 (the inferred-shape table, including
  `QuoteLevel`, `BasketLeg`, `marketId`, the non-negative caps, and the
  unformatted identifiers).
- `docs/handoffs/WP-020.md` — `deviations` 3 and 4, `known_risks` 3, `follow_up` 2
  (explicitly asking this ADR to confirm the inferred shapes).

**Safety:** this ADR changes no run-mode default (ADR-010). A pure strategy holds
no credential by construction, and simulation must not import a live signer
(§5.2).
