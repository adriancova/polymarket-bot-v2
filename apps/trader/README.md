# `@polymarket-bot/trader`

The paper trader (`WP-230`; handoff §4.1's `apps/trader`). It is the layer-3
composition root that assembles the already-merged packages into one
deterministic core event loop, and it is the repository's first full
paper-trading system.

**It is not presumed profitable**, and a paper fill is **not evidence** about
real fill quality (ADR-012 §2, §12.2). Every fill this process observes carries
`evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"` from the venue that produced it.

## What it assembles

| Layer | Package | Role |
| --- | --- | --- |
| books | `@polymarket-bot/order-book` | §9.4 per-outcome-token reconstruction under ADR-013 |
| features | `@polymarket-bot/features` | §9.5 versioned, content-addressed snapshots |
| strategy | `@polymarket-bot/strategy-runtime` + `@polymarket-bot/strategy-static-bracket` | §9.6 exactly one persisted decision per callback |
| allocation | `@polymarket-bot/capital-allocator` | §9.7 caps (both live-micro caps fenced at `0`), asked for a reservation verdict before **every** risk check — `src/allocation.ts` |
| risk | `@polymarket-bot/risk` | §9.8's twenty pre-trade checks |
| planning | `@polymarket-bot/execution-planner` | §9.10 immutable execution plans |
| venue | `@polymarket-bot/simulation` | the §12.1 `ExecutionVenue`, simulated |
| accounting | `@polymarket-bot/ledger` + `@polymarket-bot/pnl` | §9.15 / §9.16 |

Nothing in this app re-implements a rule any of those own. Where a policy
decision appears here it is a WIRING decision — which port, which order, which
identity — and each one says so in its own module.

## Safety

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both live-micro caps at `0`
are untouched by this process and **enforced** by it. `src/safety.ts` refuses to
start:

- under a `MAX_RUN_MODE` above `PAPER` — refused, never clamped, because a clamp
  turns an attempt to raise the ceiling into a silent no-op;
- under a `RUN_MODE` that places real orders or needs a live signer — by name;
- under `ALLOW_REAL_ORDERS` ≠ `false` or a non-zero live-micro cap;
- in an environment that **references** a production secret NAME (§15; the names
  are ADR-010 §3's, read from `docs/venue/verified-2026-08-24.md` §16.1–§16.3).
  The NAME is the violation: an exported-but-empty `POLYMARKET_PRIVATE_KEY`
  refuses too, and no refusal ever prints a value.

There is no signer, no credential, no venue client and no real-order path
anywhere in this app, and none is representable in its types: the only
`ExecutionVenue` it can be handed is `packages/simulation`'s, which refuses
`EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` by name.

## The core loop

`src/loop.ts` implements §8.1 step for step. Three properties are structural
rather than conventional:

1. **One code path for live and replay** (§12.1). There is no replay branch. The
   difference between a `PAPER` run against Redis and a `BACKTEST` replay
   against a dataset is which `Clock`, `MarketEventFeed` and `ExecutionVenue`
   were handed to `createPaperTrader`.
2. **§8.4's ordering is structural.** The loop never sorts events. It processes
   them in the order the feed delivered them, and the only ordering decision it
   makes at all is §8.2's, over strategy instances.
3. **Nothing is dropped** (§8.3). `BoundedQueue.offer` has no path that
   discards; a refusal latches a `QUEUE_BACKPRESSURE` halt, and
   `messagesDropped` is reported as `0` because nothing can move it.

## `ownership: "SHADOW"` means OBSERVE here

§6 invariant 11: "One active live strategy owns a market in v1. Other strategies
may observe or run in shadow mode." In this process a `SHADOW` instance is
**observe-only**:

| It does | It does not |
| --- | --- |
| evaluate, in its §8.2 position after the owner | reach `allocate capital` (§8.1 step 6) |
| produce `DecisionResult`s, which are persisted | reach the risk gate, the planner or the venue |
| appear in the run manifest | move cash, inventory or the ledger |

The intents it emits are counted on the health surface as
`execution.observeOnlyIntents` — not dropped silently, so "the strategy emitted
nothing" and "the process declined to route what it emitted" stay
distinguishable.

**Why not simulated shadow execution.** ADR-011 §1 describes `SHADOW` as "live
data, simulated execution, independent accounting", and §5 states the observable
consequence: shadow instances "evaluate, produce decisions, and write records;
they do not consume venue rate limits, **because they submit nothing**". This
process holds ONE book — one cash balance, one `Ledger`, one `SimulatedVenue`,
shared by every instance — so there is nothing for a shadow's accounting to be
independent *of*. Review round 2 measured what the alternative costs: with the
allocator asked on its SHADOW arm (which skips the ADR-011 ownership gate, the
live-micro fence and the collateral and inventory checks) and the order still
submitted to the shared venue, a `globalAccountCap` of `"20"` bound for two
owners and evaporated for a shadow — two fills, 34 pUSD committed, zero allocator
refusals, on a market with no recorded owner. Independent shadow execution is a
design (a second book, a second attribution stream, a second PnL surface), not a
configuration value; until it exists, `SHADOW` here means observe. Recorded as a
follow-up below.

## The `WP-220` composition-root obligations

`packages/strategies/static-bracket/README.md` states ten conditions the
strategy's correctness rests on. Each is implemented here and named by a test in
`test/integration/paper-trader/obligations-wp220.test.ts`.

| # | Obligation | Where |
| --- | --- | --- |
| 1 | strict-UTC timestamps, offsets normalised HERE | `src/time.ts` |
| 2 | the scalar feature projection and the `@`-selector | `src/projection.ts` |
| 3 | the position view already includes the fill | `src/loop.ts` — the ledger posting precedes the `onFill` delivery |
| 4 | adopted orders delivered through `onOrderUpdate` | `src/orders.ts`, `src/loop.ts` |
| 5 | order views repeat-safe; **fills at most once** | `src/orders.ts`, `src/fills.ts` |
| 6 | fresh views per evaluation; the revoked-context error is not swallowed | discharged by `packages/strategy-runtime` (see below) |
| 7 | `filledShares` read as evidence, never as allocation | `src/orders.ts` |
| 8 | fills delivered while the instance is PAUSED — **and withheld from a HALTED scope**, whose books are still posted | `src/loop.ts`, `src/fills.ts` |
| 9 | reservations honoured before the next reduction is planned | `src/reservations.ts`, `src/allocation.ts`, `src/pipeline.ts` |
| 10 | every cancel resolved to a terminal fact | `src/cancels.ts` |

**Obligation 6 is discharged by construction upstream**, and this app relies on
that rather than re-implementing it: `packages/strategy-runtime`'s remediation
round 3 replaced freeze-in-place with acquire-a-snapshot, and its own
`input.ts` records the obligation as "DISCHARGED by construction as of this
round: the runtime copies, so a producer may keep and mutate its own view
objects". This app therefore hands the runtime views it may keep, and
`StrategyContextRevokedError` never reaches it because the runtime contains it
into a typed outcome.

### The `immediate_order_type` question, resolved

`WP-220` recorded it open: the strategy tags its entry intent
`sb.order-type:FAK`, `packages/risk` never reads tags, and the planner's
`PlannedOrder` carries no time-in-force. The seam that needs one is
`packages/simulation`'s `ExecutionPolicy.timeInForceFor`, whose own comment
forbids a default — "a silently assumed `FAK` would change every unfilled
remainder's fate".

**The resolution: read the tag; fall back to the emitting instance's configured
`immediate_order_type`; never default.** `src/pipeline.ts`'s
`OrderTimeInForceBook` records the answer per planned order at plan time, when
both the intent's tags and the emitting instance are still in hand, and the
venue policy reads that book. An order whose value cannot be resolved is
refused rather than submitted.

## The risk-seam caveat is wired honestly, and it is VISIBLE

`WP-220`'s accepted residual: every exit the Static Bracket emits is a §7.7
`POSITION` intent, and `packages/risk` derives the disposition from the intent
TYPE alone, so a protective reduction is classified `ENTRY`. Protective
reductions are therefore refused inside the entry cutoff, on `CLOSE_ONLY`
markets, with the entry-shaped staleness code, and — under the default
`requirePositiveNetEdgeForEntries` — for want of an `expectedNetEdge`.

**This process does not compensate.** It does not re-tag intents, resize them,
lower a policy bound, retry, or bypass `evaluateIntent`. A refused exit is the
accepted posture until the risk-side follow-up lands.

**What it does instead is refuse to let the consequence be invisible.** The
health surface counts refusals of intents the emitting strategy tagged
protective, broken down by the risk reason code that refused them
(`risk.refusedExits`, `risk.refusedExitsByCode`), and `riskSeamCaveat` travels
with every snapshot.

**OBSERVED, not predicted.** In the end-to-end fixture the Static Bracket's
take-profit is emitted after its entry fills and is refused with
`RISK_EDGE_INPUTS_MISSING` — the caveat's fourth row, live. The assertion is in
`test/integration/paper-trader/obligations-wp220.test.ts`.

## Schema-boundary conformance (ADR-020 §5)

Two doors parse caller- or wire-supplied values, and both conform on arrival.

| Door | D1 | D2 | D3 | D4 | Battery |
| --- | --- | --- | --- | --- | --- |
| `parseTraderConfig` (`src/config.ts`) | `readPlainData` | warmed arena | from the materialized tree | prototype-free, frozen | `src/config.test.ts` |
| `readEventEnvelope` (`src/event-door.ts`) | `readPlainData` | warmed arena copies of the FROZEN contracts' envelope schemas | from the materialized tree | prototype-free, frozen | `src/event-door.test.ts` |

Both consume the canonical `packages/risk` door over the permitted layer-3 →
layer-1 edge, through that package's `exports` map (so no F16 deep import), and
neither pastes a copy — `WP-180-FU2`'s deletion guard walks `apps/*` precisely
because "a verbatim `cp` of the door into `apps/trader/src/pasted-door.ts`
passed this file 7/7".

The wire door is the trader's half of two rows `docs/contracts/schema-boundary.md`
§3 records as **LIVE** — `packages/domain`'s `skipChecks` class (whose owner
assignment is "closed by ADR-020 §3 **at each door**") and `packages/event-bus`'s
— and both are pinned as regressions in `src/event-door.test.ts`.

### A measured finding: the arena protects the parse, not the ERROR construction

Measured against the pinned `zod@4.4.3`, with one non-enumerable inherited
`Object.prototype.get`:

```text
arena.safeParse(VALID)    -> ok
arena.safeParse(INVALID)  -> TypeError: Invalid property descriptor.
                             Cannot both specify accessors and a value or
                             writable attribute
```

That is schema-boundary §2's "Descriptor literals" class arriving on the
**refusal** path — so a door with no containment guard turns "this input is
invalid" into an escaped `TypeError`, on exactly the input it exists to refuse.
Both doors here are wrapped in a total guard for that reason. The same class
also disables `vitest`'s own assertion path, which is why the batteries measure
under pollution and assert after removing it; that corroborates the repository's
recorded R8-1 tooling residual independently.

## Reported cross-package conflicts

Wiring the merged engines together surfaced four frictions. **None was patched
around by editing a package.** Each is handled by making the trader's own door
refuse at STARTUP, with the conflict named in the refusal, and each is reported
here.

### 1. `strategyInstanceId` cannot satisfy both merged doors (BLOCKING for a real deployment)

- `packages/ledger`'s `AllocationClaim.instanceId` and `packages/pnl`'s
  `PnlOwner.instanceId` are `Uuidv7Schema`;
- `packages/risk`'s `RiskEvaluationInput.context.strategyInstanceId` is
  `CodeStringSchema`, whose pattern is `^[A-Za-z][A-Za-z0-9_.:-]*$` — a **letter
  first**.

A UUIDv7's first 48 bits are a Unix-millisecond timestamp, so every genuinely
minted one begins with the digit `0` for every instant this century. Such an
identifier satisfies the ledger and **fails** the risk engine, and the two
cannot both be satisfied. The intersection is non-empty only for a UUID whose
first hex digit is `a`–`f`, which no timestamp produces.

The trader's door refuses anything outside that intersection at startup, naming
the conflict, rather than letting it appear mid-run as a `RISK_INPUT_INVALID`
with no order placed. **The real fix is a contract-owner decision** — widen
`CodeStringSchema` for this field, or type it as an identifier rather than a
code — and it belongs to whoever owns `packages/risk`'s input surface.

### 2. §9.8's fail-closed inputs have no upstream producer yet

Four §9.8 checks fail closed on inputs no merged package currently produces for
a live trader: check 6's settlement readiness (§9.2/§9.3, `packages/universe` +
`packages/settlement`), check 9's `parametersVersion`, check 17's shock
scenarios, and check 19's rate-limit headroom (§9.13, `WP-310`).

Each is a **required, operator-stated, undefaulted** configuration field here,
documented with the upstream that will replace it. Two of them are additionally
MEASURED rather than merely stated: the scenario MARKS are computed from the
book at evaluation time (the operator states only the shock), and the rate-limit
headroom counts this process's OWN submissions against the stated capacity.

`markets[].settlementReadiness.modelDependentActivationAllowed` deserves its own
sentence: it is `false` in the shipped example, because `btc-15m-updown` has no
human-reviewed settlement specification in this repository, and under `false`
§9.8 check 6 refuses every entry. That is the truthful configuration for that
series.

### 3. `packages/risk` requires cost estimates the planner produces later

§9.8 check 12 refuses without `feeEstimate` and `slippageEstimate` — "an
unsupplied cost is not a zero cost (fail closed)" — but risk runs BEFORE the
planner that estimates them. The trader measures both from state it already
holds: the fee from the market's configured versioned taker rate, and the
slippage from `executablePrice`'s exact ladder walk minus the top-of-book cost.
No division, no VWAP, no rounding policy. Where the book cannot fill the size,
the slippage is OMITTED and §9.8 refuses — which is correct.

### 4. `strategy.decisions` has no repository

`packages/storage-postgres` ships repositories for definitions, configs,
instances and runs, but no writer for `strategy.decisions`, whose table exists
in the schema types and in `db/migrations/0004_strategy.up.sql`. The insert is
in `src/adapters/postgres-store.ts`, which is the "composition root binds them
to the tables" arrangement `WP-200` describes. Whether it should move into the
package is a question for that package's owner.

## What was NOT verified

**No PostgreSQL and no Redis were reached.** Docker is absent from the
development environment, as `WP-210` recorded for its own migration work. The
adapters in `src/adapters/` are **typecheck-pinned only** against
`packages/storage-postgres`'s shipped table types and `packages/event-bus`'s
subscription interface, and **no integration evidence is claimed for them**.
§4.2's two boundaries are proved at the PORTS with failure injection, which is
the `WP-120` precedent for the same class of claim.

**No soak, no execution probe, no live gate, and no real order.** None occurred
and none is claimed.

## Follow-ups

1. **Wire `packages/universe` and `packages/settlement`** so
   `settlementReadiness` comes from `evaluateMarketReadiness` rather than from
   configuration. Until then the operator asserts it and is accountable for it.
2. **The `strategyInstanceId` conflict** (above) needs a contract-owner ruling.
3. ~~**`packages/risk`'s exposure snapshot is not supplied.**~~ **DONE in
   remediation round 1** and the entry was left stale; corrected in round 2.
   `src/allocation.ts` builds the §9.8 check-15 snapshot with
   `packages/capital-allocator`'s own `exposureSnapshotCovering`, and
   `src/loop.ts` passes it unaltered. A configured exposure cap is now a real
   comparison — `test/integration/paper-trader/capital-allocation.test.ts` drives
   both directions, including a per-underlying cap that binds only because a
   HELD position consumes it.
4. **Independent SHADOW execution** (review round 2, HIGH-1). ADR-011 §1's
   "simulated execution, independent accounting" needs a second book: a separate
   cash balance, a separate ledger stream and a separate PnL surface, so a shadow
   instance's simulated fills never touch the owner's. Until that exists,
   `ownership: "SHADOW"` is observe-only here (see above) and the process says so
   in the configuration schema, the registry and this README rather than
   implying an execution mode it does not have.
5. **`WP-310`'s rate-limit budget** replaces the interim `requestBudget`.
6. **A live integration suite** against real Redis and PostgreSQL, when an
   environment with Docker exists.
7. **Root-script wiring** for `pnpm test:integration` (orchestrator-owned at
   merge; `package.json` is a protected path). The suite runs today through
   `pnpm --filter @polymarket-bot/trader test:integration`.
8. **`packages/observability`** is still a placeholder, so the health state is a
   value rather than a metrics endpoint. `WP-240` owns the surface that reads it.
