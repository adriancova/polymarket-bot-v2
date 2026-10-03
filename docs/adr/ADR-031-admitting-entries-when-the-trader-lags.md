# ADR-031: Admitting entries when the trader lags the stream (`CO2-N1`)

- **Status:** **Accepted, 2026-10-02: ruled by the user.** Proposed
  2026-10-01. The user accepted section 4's recommendation:
  - option (a), an entry guard on the process clock, through existing inputs,
    entries only;
  - Q1: existing inputs;
  - Q2: exits as today. The question passes to the round that builds the §9.9
    Incident Controller, and must be answered before any run mode above
    PAPER;
  - Q3: a separate residual, `ADR023-CLOCK-STEP`.

  Section 3 records the questions and the answers.
- **Date:** 2026-10-01
- **Recorded by:** `CO2-N1-ADR`. The ruling is recorded by `ADR031-ACCEPT`.
- **Implemented by:** the `CO2-N1` round. Not yet implemented. The brief
  queues it after `PROVENANCE-1`, before any settlement veto is lifted and
  before `WP-270`.
- **Supersedes / Superseded by:** none. It amends no handoff text. It re-reads
  two passages of ADR-026 and two code comments. It names three sentences of
  ADR-023 that it does not change (section 6).
- **Handoff sections:** §6 (invariants 2, 3, 12, 13 and 15), §7.1, §8.1, §8.3,
  §9.1, §9.8 (checks 5, 6, 7 and 20), §9.9, §12.1, §12.4, §13.3. **ADRs:**
  ADR-003, ADR-010, ADR-012, ADR-017, ADR-022, ADR-023, ADR-024, ADR-025,
  ADR-026, ADR-029.
- **Residual it addresses:** `CO2-N1` (`IMPLEMENTATION_STATUS.md`, Residual
  queue), from `CLOSEOUT-2` finding N1 (auditor finding E-02).
- **Code cited:** `main` at `3615560`, unless a citation names `c5157c3`.
  ADR-023 is cited on `main`, where it is Accepted. Its code, the process-lag
  guard included, is cited at `c5157c3`, after `THROUGHPUT-1c` merged
  (`0c270df`). Section 1.3 says what that merge changed in admission.
- **Revision:** r1, 2026-10-02 (`ADR031-ACCEPT`), after the user's ruling.
  - Sections 3, 4 and 5 record the ruling. R1-R7 and T1-T11 are unchanged.
  - ADR-023 was cited as Proposed, on the `THROUGHPUT-1c` branch at
    `d5dda21`. It is now cited on `main`. Section 1.3 gains what
    `THROUGHPUT-1c`'s merge changed.
  - Round 2's six LOWs are fixed. Three corrected a fact. The old text:
    - 1.4: the in-window lag "was between 18 s and 153 s" (`F2-L1`);
    - 2(c): "`CONTROL-1` owns that path now" (`F2-L4`);
    - 6.1, re-reading ADR-026 D3.5: "Admission's ages still run on event
      time" (`CO2N1-R2-L1`).
  - The other three clarify: (b-entry)'s classification cost (`F2-L2`),
    reason 4's heading (`F2-L3`), and four wording nits (`F2-L5`).

## 1. The problem

### 1.1 The residual

`IMPLEMENTATION_STATUS.md` records:

> Live admission (risk freshness, book age, seconds-to-close) runs on event
> time (`envelope.receivedAt`), so a stale backlog can approve entries after
> close. Masked today by the settlement veto.

Its owner is "an ADR and a trading-core round, before any settlement veto is
lifted and before `WP-270`". `CLOSEOUT-2` (N1) adds two points:

- the fix needs a design decision that keeps replay deterministic;
- the finding is distinct from `THROUGHPUT-1c` (F-G8.3). The auditors' reason,
  in their source reports outside the repository: making a book's freshness
  depend on feed activity does not help when the book and the evaluation are
  both old.

### 1.2 Terms

This ADR uses these terms throughout.

- **Event instant** (`eventNow`): the `receivedAt` of the event an evaluation
  runs on. §7.1 calls it "wall-clock". The gateway stamps it from its own
  clock (`apps/data-gateway/src/ports.ts`, `takeReceipt`).
- **Process instant** (`processNow`): the trader's reading of its `Clock` port
  (§12.1) at admission.
- **Lag:** `max(0, processNow − eventNow)`, in milliseconds. A process clock
  behind the event instant reads as lag 0.
- **Entry** and **exit:** risk's disposition, not the strategy's label.
  `buildIntentView` (`packages/risk/src/intent-view.ts`) derives it from the
  intent's shape and the supplied portfolio, which the loop builds per
  instance (`CoreLoop.#positionsFor`):
  - any BUY leg makes an `ENTRY`, and so does every `QUOTE` and `BASKET`;
  - a `REDUCE_POSITION` is an `EXIT`, and so is a `POSITION` that sells no
    more than the instance holds;
  - a `CANCEL` has its own disposition, `CANCEL`: neither entry nor exit.

  Section 2(a) gives the consequences for this ADR.

### 1.3 Where admission reads time

`CoreLoop.#processEvent` (`packages/trading-core/src/loop.ts`) normalizes
`envelope.receivedAt` to strict UTC. That instant is the loop's time for the
event.

`CoreLoop.#routeIntent` builds the §9.8 input with `buildRiskEvaluationInput`
(`packages/trading-core/src/pipeline.ts`). Every time-dependent field is
measured at the evaluation's event instant, or is a constant:

| Field | Value | What reads it |
| --- | --- | --- |
| `evaluatedAt` | the event instant | the intent-deadline pre-check, `RISK_INTENT_EXPIRED` |
| `secondsToClose` | `#secondsToClose`: whole seconds from the event instant to the configured `closeTime` | check 20 |
| `venueBookAgeMs` | `#bookAgeMs`: the event instant minus the YES book's last update | check 7, book row |
| `featuresAgeMs` | the constant `0` | check 7, features row |
| `referenceFeedAgeMs` | `ReferenceState.ageMs` at the event instant | check 7, reference row |
| `availableRequests` | `#availableRequests` at the event instant | check 19 |

`packages/risk` reads no clock. Its `freshness.ts` says: "NO CLOCK IS READ IN
THIS PACKAGE." `evaluateIntentInner` (`packages/risk/src/engine.ts`)
classifies the measurements it is given:

- check 7 refuses an entry on a stale book, stale features or a stale
  reference feed. A stale book also refuses a reduction
  (`RISK_BOOK_STALE_NO_BLIND_REDUCTION`);
- check 20 refuses an entry when `secondsToClose` is at most
  `timeToClose.entryCutoffSeconds` (`RISK_TIME_TO_CLOSE_ENTRY_BLOCKED`).

The `Clock` port is `CoreLoopOptions.clock`. The loop reads it in three places:

- `now()`, once, in the constructor, to seed `#lastInstant`;
- `monotonicNs()` in `#stageOutbox`, for the group-commit age;
- `monotonicNs()` in `#applyEvent`, for the venue's observed-trade stamp.

Outside the loop, the core hands the same port to the strategy runtime's
watchdog (`trader.ts`) and to the simulated venue (`venue-builder.ts`). No
admission input reads the port.

`THROUGHPUT-1c` merged after `3615560` (`0c270df`). At `c5157c3` the loop has
a fourth read: `now()` in `#processNowEpochMs`, ADR-023 D7's process-lag
guard.

- It reads the clock under `bookFreshness` basis `CONNECTION_CONFIRMED` only.
  An absent block means `LAST_CHANGE`, which reads no clock (ADR-023 D4).
- `infra/compose/trader/trader.config.example.json` opts in to
  `CONNECTION_CONFIRMED`.
- Under that basis the book age, an admission input, depends on the reading
  (`#bookAgeMs` calls `#bookConfirmedAt`). So does the feature snapshot.
- The reading can only remove the extension ADR-023 adds. It never makes a
  book fresher than ADR-023's rule without the guard (D7).

So "no admission input reads the port" still holds at `c5157c3` under
`LAST_CHANGE`. Under `CONNECTION_CONFIRMED`, the clock can narrow a book's
freshness. But a book whose last change is fresh in event time stays fresh,
whatever the lag. Section 2(a), "ADR-023 D7", covers how option (a) relates
to the guard.

The other time-to-close signals are event time as well:

- the strategy is pure (§6 invariant 2). Its `ctx.now()` is the evaluation
  instant (`packages/strategy-sdk/src/context.ts`), and Static Bracket's own
  entry cutoff compares it with the close (`decide.ts`);
- check 5 refuses an entry on a `CLOSE_ONLY` market. `marketStatusOf`
  (`pipeline.ts`) derives that from the lifecycle, which moves on a
  `MarketClosing` event. During a backlog, that event waits in the same queue.

So during a backlog, every signal that should refuse a late entry is either
arithmetic on the old event instant or an event that has not been processed
yet.

### 1.4 Why this matters live

- In a PAPER process the clock is `SystemPaperClock`
  (`apps/trader/src/main.ts`), the host's clock. Nothing in admission reads it,
  apart from ADR-023's guard under `CONNECTION_CONFIRMED` (1.3).
- A trader N seconds behind the stream judges each entry as of N seconds ago.
- The simulated venue is positioned at the recorded event (`venue.observe` in
  `#processEvent`). So a paper fill is priced against the old book.
- `TransportLagSampler` (`apps/trader/src/transport-lag.ts`) measures this lag
  as `eventTimeLagMs`, for the health surface only.
- H1 runs 2-8 show the lag is real (`docs/handoffs/H1-RUNS-2-8.md`):
  - in runs 3-8, the maximum in-window event-time lag per run was between
    23 s and 153 s;
  - run 2's processes died before its window. Its maximum, 18 s, was
    pre-window;
  - the peak backlog was 93,084 of 100,000 retained events (run 8).
- Runs 7 and 8 each produced one live entry intent. The settlement veto refused
  both.

### 1.5 The closeout's reproduction

`CLOSEOUT-2`'s architecture auditor ran a scratch probe on `8fde4df`:

- the paper-trader fixture (`test/integration/paper-trader/support/fixture.ts`)
  with its recorded events and its permissive risk policy;
- a `ManualClock` positioned at `2026-03-04T12:30:00.000Z`;
- the market closes at `12:15:00`. The last event is stamped `12:00:03`.

The result: two risk evaluations, two approvals, no refusal, one fill,
`healthy: true`, no halt. `CLOSEOUT-2B` re-ran it on `9ce53a1`, and the entry
was still approved and filled. The probe's source and log are outside the
repository. The implementation round turns it into a test (section 7, T1).

### 1.6 Why nothing catches it today

- **The settlement veto.** §9.8 check 6 refuses every live `ENTRY`,
  `RISK_SETTLEMENT_UNVERIFIED`. No reviewed `btc-15m-updown` settlement spec
  exists (`CLOSEOUT-2` N2). The fixture's readiness permits activation, which
  is why the probe reaches a fill.
- **Retention.** §9.1 and ADR-003 §3.3 make lag beyond retention a hard
  resynchronization. Below retention, nothing reacts to lag.

When any settlement veto is lifted, a lagging PAPER trader admits late entries.
Under `WP-270`, the same seam would admit late live orders.

### 1.7 What any fix must keep

- **Replay determinism.** §12.4 and ADR-012 §4: a fixed dataset, commit,
  configuration and seed give byte-identical decisions, intents, risk results,
  plans, simulated orders, fills, ledger events and PnL.
- **§6 invariant 15:** "Replay follows information arrival order. It must not
  use future venue timestamps unavailable to the live process."
- **One core.** §12.1: "Everything between event input and the
  `ExecutionVenue` interface is shared." ADR-022 D3: the clock enters only
  through the §12.1 port. ADR-022 D5: the loop never branches on simulation.
- **§6 invariant 13:** "Safety cancellation outranks new order placement." The
  user's ruling of 2026-09-30 (`CLOSEOUT-2B`): cancels go first.
- **§6 invariant 3:** every callback produces exactly one persisted decision.
- **§8.3:** "Dropping trading or raw market events silently is forbidden."
- **ADR-026 D7.5:** "If `CO2-N1`'s fix brings processing time into admission,
  the cadence stays on event time. The two clocks are separate."
- **The PAPER ceiling** (ADR-010; ADR-022 D6).
- **No invented venue fact.** The close used here is the configured
  `closeTime` (`MarketConfigSchema`, `packages/trading-core/src/config.ts`).
  No pushed market-closed signal is documented: register row U-12
  (`docs/contracts/protected-contracts.md`), unchanged in
  `docs/venue/verified-2026-09-30.md`. A polled surface exists
  (`docs/venue/verified-2026-09-16.md`, D-30). This ADR relies on no venue
  behaviour at or after the close.

### 1.8 What each clock reads in replay and in tests

These facts decide what each option does to replay and to the tests.

- **The backtest.** `replayDrivenCoreLoop`
  (`apps/backtest-cli/src/core-loop.ts`) advances the `ReplayClock` to each
  record's `frame.receivedAt` before it ingests the record. The
  normalized-envelope normalizer copies that same field into the envelope's
  `receivedAt` (`normalizer.ts`, `envelopeFrom`). For raw frames, every
  envelope of a record shares the record's instant (ADR-024 D4). So at every
  evaluation, `processNow` equals `eventNow`. The lag is 0.
- **The e2e harness** (`test/e2e/support/harness.ts`) builds a `ManualClock` at
  the scenario's `clockStart`, `T_OPEN`, and never moves it. Entries come
  after `T_OPEN`, so their lag is 0. A few reference events come before it;
  their lag is seconds, against the scenarios' 600,000 ms features bound.
- **The paper-trader fixture** builds a `ManualClock` at `12:00:00.000Z`, the
  market's open, and never moves it unless a test does. Its entries come
  after that instant, so their lag is 0.
- **`SystemPaperClock` with recorded events.** Some integration tests and the
  throughput bench drive recorded fixtures through the host's clock. Their
  event instants are days or months old, so their lag is days or months.
  `git grep SystemPaperClock` at `3615560` finds these test files. Those that
  drive events and expect an entry are affected; the implementation round
  lists which:
  - `test/integration/paper-trader/durable-two-brackets-postgres-redis.test.ts`.
    Its system-clock case pins "strategy time is the envelope's receivedAt";
  - in the same directory: `durable-two-level-entry-postgres-redis.test.ts`,
    `durable-trader-first-fill-postgres.test.ts`,
    `durable-decision-before-placement-postgres.test.ts`,
    `registered-config-parameters-postgres.test.ts`,
    `trader-health-endpoint-postgres.test.ts`,
    `transport-lag-postgres-redis.test.ts`,
    `univ-4-gateway-opens-trader-redis.test.ts` and
    `support/register-command.ts`;
  - `test/integration/paper-trader/support/throughput/harness.ts`, which the
    bench bundles (`tools/bench/trader-throughput/run.sh`).
- **Tests that move a `ManualClock` ahead of their events.**
  `packages/trading-core/src/loop-order-lifecycle.test.ts` and
  `loop-refused-plan.test.ts` call `positionAt` to make the venue act.

## 2. The options

Each option is judged on five points: replay and backtest determinism, live
behaviour, the shape of its failure, its interaction with ADR-023 D7 and
ADR-026, and what it changes in the code, the tests and the goldens.

### (a) An entry guard on the process clock

**The rule.** At admission, the loop reads its `Clock` port once per placement
and refuses an `ENTRY` when either holds:

1. **lag criterion:** the lag exceeds a bound;
2. **close criterion:** the process instant is inside the entry cutoff, that is,
   the whole seconds from `max(eventNow, processNow)` to the configured close
   are at most `entryCutoffSeconds`.

**Which intents it judges.** The guard follows risk's disposition (1.2), not
the strategy's label:

- an `EXIT` and a `CANCEL` are not judged. Static Bracket's direct-leg exits,
  the only exits it can emit today, are covered SELLs, so `EXIT`s;
- an exit shaped as a BUY is an `ENTRY`, so the guard judges it. Static
  Bracket closes a complement-leg bracket that way (`legPosture`,
  `exitSide: "BUY"`). Every entry check already applies to it today, the
  settlement veto included;
- a covered SELL that opens exposure is an `EXIT`, so the guard does not judge
  it. Static Bracket's complement-leg entry is one (`chooseLeg`,
  `side: "SELL"`). Check 6, check 7's features row and check 20 already pass
  it today;
- neither shape is reachable today. Positions are per instance, and a Static
  Bracket instance buys only its direction token, so it never holds its
  complement. The example configuration is `DIRECT_ONLY`
  (`infra/compose/trader/trader.config.example.json`). Both shapes belong to
  the `RISK-2 item 7` residual, which this ADR does not change.

**Where it can live.** The loop measures; `packages/risk` classifies. Two
placements are possible:

- **through existing inputs.** The loop supplies `featuresAgeMs` = lag, the
  feature snapshot's age at the process instant. Today that field is the
  constant 0, so check 7's features row can never fire. The loop supplies
  `secondsToClose` measured from `max(eventNow, processNow)`. Both rows already
  apply to `ENTRY`s only (`isEntry` in `evaluateIntentInner`). No new reason
  code, policy field or risk change is needed. The bound is
  `freshness.featuresMaxAgeMs`, 2,000 ms in
  `infra/compose/trader/trader.config.example.json`;
- **through a dedicated measurement.** A new freshness feed, a new policy
  bound and a new reason code in `packages/risk`. The signal is more specific
  for operators. It costs a field in `FreshnessPolicySchema`, which is strict,
  and a reason code. If the field is required, every configuration changes.

**Determinism.** In a backtest the lag is 0 at every evaluation (1.8). The lag
criterion cannot fire. The close criterion reduces to today's check 20. So
every replay decision, intent and risk result is unchanged. In the e2e harness
and the paper-trader fixture, the clock sits before every entry, so the lag
clamps to 0 and nothing changes either.

A live run is not reproduced by replay when the guard refused in live. The
divergence has one direction: live refuses what replay admits, never the
reverse. What the loop keeps of a refusal is its codes:
`CoreLoop.#routeIntent` passes only those to `HealthState.countRiskRefusal`,
and risk's `ageMs` and `limitMs` detail is dropped.

- A `RISK_FEATURES_STALE` count is attributable to lag. Under (a), that row's
  only input is the lag: the field is the constant 0 today.
- A close-criterion refusal is not attributable. It shares
  `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` with an ordinary event-time cutoff
  refusal (Q1).

**Live behaviour.**

- A trader behind by more than the bound refuses every entry until it catches
  up. Nothing latches: the first entry routed below the bound is judged as
  today.
- After a restart, `BOOT-1` requires a new run: a run that holds decisions is
  refused, `TRADER_REGISTRATION_RUN_NOT_RESUMABLE` (`verifyRegisteredRows`).
  The stream consumer is resumed, though. `apps/trader/src/main.ts` subscribes
  with no `start`, so the consumer resumes its stored position
  (`SubscribeOptions.start`, default `stored-checkpoint`; ADR-003 §3.4).
  That position is behind the head if events arrived while it was down. The
  new run refuses entries while its lag exceeds the bound or the close
  criterion applies. A restart that meets no backlog refuses nothing extra.
- Inside the bound, the close criterion refuses an entry whose process instant
  is inside the cutoff, even when its event instant is not.
- `EXIT`s and `CANCEL`s behave as today.
- Every event is still applied and evaluated, and every decision is still
  persisted (§6 invariant 3, §8.3).

**Failure shape.**

- **Fail-closed by construction.** Both criteria only add refusals; the
  process clock can never admit what event time refuses.
- **Coarse, not exact.** Each age is judged in event time, and the lag
  separately. So at the process instant, an admitted entry can carry:
  - a book up to `venueBookMaxAgeMs` plus the bound old: 4,000 ms with the
    example's values (2,000 ms each);
  - a reference price up to `referenceFeedMaxAgeMs` plus the bound old:
    7,000 ms with the example's values (5,000 ms and 2,000 ms);
  - an intent deadline (`validUntil`, `RISK_INTENT_EXPIRED`) already passed by
    up to the bound. R6 keeps `evaluatedAt`, which that check reads, on event
    time.

  Option (b-entry) removes the first two.
- **Two hosts, gateway clock ahead by S.** The lag reads S low. Up to S of real
  lag is invisible to the lag criterion. The close criterion is still safe,
  because it takes the later instant.
- **Two hosts, gateway clock behind by S.** The lag reads S high. If S exceeds
  the bound, every entry is refused until the clocks agree. That is loud and
  fail-closed.
- **One host** (ADR-025's laptop). There is no skew. A clock step moves both
  clocks. Only events in flight at the step are mis-measured, by the step's
  size: a forward step adds transient refusals, and a backward step hides lag
  briefly.
- **A misused clock.** A wall clock injected into a replay refuses every entry.
  A replay that positions its clock once per batch, not per event, may refuse
  some. Both show as refusals, and the golden parity test catches both.

**ADR-023 D7.** D7's process-lag guard reads the same port and computes the
same lag, but only under `CONNECTION_CONFIRMED`. Option (a) leaves every book
age on event time. So there is no double count with D7's shifted
confirmation, and the two are independent. Option (a) does not depend on
ADR-023. Unlike D7's guard, option (a) also reads the clock under
`LAST_CHANGE`.

**ADR-026** (`CADENCE-1`, not yet implemented). The cadence stays on event
time (D7.5). During a backlog the trader still evaluates at the recorded pace
(D7.3). Its entry intents are refused, not skipped. A carried-over or
heartbeat evaluation takes the frame's last applied event as its source
(D3.2), so the lag is measured from that event. A forward jump (D2.10) reads
as lag 0, and the close criterion then takes the jumped event instant, which
is conservative.

**Code, tests and goldens.** Through existing inputs:

- `CoreLoop.#routeIntent`: one `clock.now()` read per routed placement intent,
  after `#persistDecisionsBeforePlacement`; the two values above;
- `pipeline.ts`: `RiskInputContext.featuresAgeMs` may be absent, which risk
  already reads as `UNKNOWN`; two doc comments;
- `apps/trader/src/transport-lag.ts`: one header sentence (section 6);
- `packages/risk`: no change;
- goldens: none expected; section 7 requires proof;
- tests: the `SystemPaperClock` and `positionAt` cases of 1.8 that expect an
  entry. Each one moves to a per-event clock, or asserts the refusal. None is
  deleted.

### (b) Every admission age and seconds-to-close at the later instant

**The rule.** The loop measures `venueBookAgeMs`, `referenceFeedAgeMs`,
`featuresAgeMs` and `secondsToClose` from `max(eventNow, processNow)`. Every
existing bound then applies at the process instant.

**Determinism.** As in (a): the lag is 0 in a backtest, so `max` is the event
instant and nothing changes. Live and replay verdicts differ whenever a live
age crossed a bound because of lag.

**Live behaviour.** This is the exact measure: each age is the age at the
moment of admission. It also changes exits. A stale book refuses reductions
(`RISK_BOOK_STALE_NO_BLIND_REDUCTION`, with cancel and reconcile
recommendations). So a lagging trader cannot take a protective exit until it
catches up. That matches §6 invariant 12 ("No blind flatten") and §13.3 ("A
stop on stale data is forbidden; incident policy applies first"). But the §9.9
Incident Controller is a later component (`packages/trading-core/src/halt.ts`).
Nothing acts on those recommendations yet, so in PAPER the position is simply
held.

**Failure shape.** Fail-closed for entries. For exits, it trades a blind
reduction for a held position. Every normal lag, even milliseconds, is added to
every age, so a book near its bound turns stale slightly sooner. The skew cases
of (a) apply to every age, not to one row.

**ADR-023 D7.** ADR-023 names this case: "a future N1 rule that measures ages
against a wall clock can use `confirmedAt` unchanged. With such a rule the
guard's shift and N1's measurement would count the same lag, so N1 must
measure ages from the UNSHIFTED instant, or drop the guard". The guard cannot
simply be dropped. It also protects the strategy's and the features' book ages,
which (b) leaves on event time. So under `CONNECTION_CONFIRMED`, risk's book
age must start from the confirmation without D7's shift. That needs a second,
unshifted reading of `bookConfirmedAt` (`book-freshness.ts`).

**ADR-026.** As in (a).

**Code, tests and goldens.** `#routeIntent` and the three age helpers in
`loop.ts`; the second confirmation reading; new exit cases; the same test
migrations as (a); no golden change expected.

### (b-entry) Ages at the later instant, for entries only

**The rule.** Option (a), and in addition an `ENTRY`'s `venueBookAgeMs` and
`referenceFeedAgeMs` are measured from `max(eventNow, processNow)`. An
`EXIT`'s and a `CANCEL`'s inputs stay on event time, as today. This is (b)'s
entry half without its exit half.

**Determinism.** As in (a): the lag is 0 in a backtest, so nothing changes.
Live and replay verdicts differ whenever a live entry's age crossed a bound
because of lag.

**Live behaviour.** Exact for entries. At the process instant, an admitted
entry's book is at most `venueBookMaxAgeMs` old and its reference price at
most `referenceFeedMaxAgeMs`. That removes the additive allowance of (a)'s
"Coarse, not exact". It refuses every entry (a) refuses, and more. `EXIT`s
and `CANCEL`s behave as today.

**Failure shape.**

- Fail-closed, as (a): it only adds refusals.
- Every normal lag, even milliseconds, is added to an entry's book and
  reference ages. So a book near its bound turns stale slightly sooner. The
  skew cases of (a) apply to those ages too.
- The intent deadline is still judged in event time. Moving an entry's
  `evaluatedAt` to the later instant would close that gap too. But risk writes
  `evaluatedAt` into the approved-intent record's `approvedAt`, so a live
  record would then carry the process instant under lag.

**The classification it needs.** Only the book half needs one.

- Risk judges check 7's reference row for `ENTRY`s only (`evaluateIntentInner`,
  the `isEntry` block). So the reference age can be measured at the later
  instant for every placement, as (a) does for the features row.
- No `EXIT`'s verdict changes. That half needs no disposition, no risk change
  and no ADR-023 reading.
- It removes the reference allowance of (a)'s "Coarse, not exact": 7,000 ms
  with the example's values.

The book row also judges `EXIT`s (`RISK_BOOK_STALE_NO_BLIND_REDUCTION`). So
for the book half, the loop must know an intent's disposition before it
measures, and risk derives it. There are three ways:

- call `buildIntentView`, which `packages/risk/src/index.ts` exports, on the
  risk input's intent and portfolio. That needs no risk change, but the
  disposition is then derived twice per placement: by the loop, and again
  inside `evaluateIntentInner`;
- duplicate the rule in the loop. `allocation.ts` already mirrors
  `buildIntentView`'s legs, held together by tests. A test would have to hold
  the two dispositions together too;
- pass both measurements to risk and let risk choose by disposition. That
  changes risk's input schema, which (a) leaves alone.

The rule is easy to get wrong: an exit shaped as a BUY is an `ENTRY`, and a
covered SELL is an `EXIT` (2(a)).

**ADR-023 D7.** As (b): under `CONNECTION_CONFIRMED`, an entry's book age at
the process instant would count D7's shift a second time. So risk's book age
must start from the unshifted confirmation. That needs a second reading of
`bookConfirmedAt`. The reference age has no ADR-023 interaction.

**ADR-026.** As in (a).

**Code, tests and goldens.**

- Code: (a)'s changes, the classification and the unshifted reading. The
  reference half alone needs neither.
- Goldens: no change expected.
- Tests beyond (a)'s:
  - an entry whose book, or reference, is fresh in event time but stale at the
    process instant is refused (`RISK_BOOK_STALE`, `RISK_REFERENCE_FEED_STALE`);
  - a covered direct-leg SELL exit with the same ages is judged as today;
  - if the rule is duplicated, the loop's disposition equals risk's for every
    intent shape.

### (c) A lag pause or a lag halt

**The rule.** The loop latches a state when the lag exceeds a bound. Two
variants:

- **a halt:** `HaltController.halt` with a new code, GLOBAL scope. The pump
  returns `HALTED` at a latched halt (`apps/trader/src/pump.ts`), so the
  process stops consuming. A restarted trader cannot resume a run that holds
  decisions (`BOOT-1`), so a new run is needed;
- **a pause:** entries only, released when the lag stays below a lower bound
  for a hold time. It matches §9.9's `HALT_NEW_ENTRIES`.

The pause must act at admission. If it skipped evaluations instead, a stop
decided in `onFeatures` would wait too, the hazard ADR-026 D2.10 names.

**Determinism.** The lag is 0 in a backtest, so the state never latches. Replay
is unchanged.

**Live behaviour and failure shape.**

- The halt turns any lag spike into the end of the run, with an operator
  restart. It stops exits too. With a 2,000 ms bound, each of H1 runs 2-8
  would have halted: each run's maximum lag was at least 18 s.
- The pause over-refuses: it keeps refusing after the lag has recovered, until
  the hold time ends. Its state is not rebuilt from events after a restart.
- Either variant latches on lag alone. Without the close criterion of (a), it
  still admits an entry whose process instant is inside the cutoff while the
  lag is below the bound.

**ADR-023 D7 and ADR-026.** No interaction with ages. The cadence stays on event
time.

**Code, tests and goldens.** The latch, two or three bounds, a halt or pause
code, and a health counter. The control API's health door lists every loop
counter strictly (ADR-026, Consequences), so `apps/control-api` changes too.
The round's grant would have to cover that path. The same test migrations as
(a). No golden change expected.

A sub-variant takes its signal from `TransportLagSampler`'s
`entriesBehindHead`. That number is sampled on a timer outside the core
(`apps/trader`), is not aligned with the decision it would gate, and counts
events, not time. Not recommended.

### (d) Accept the ordering as PAPER-only, with a deadline

**The rule.** No code. The user records that live admission runs on event time
in PAPER, with an owner and a deadline.

**Determinism.** Unchanged.

**Live behaviour.** Unchanged. While the settlement veto holds, no `ENTRY` is
admitted, late or not. The deadline must come before the first settlement veto
is lifted for any run used as evidence, and before `WP-270`. That is the
residual's own deadline today.

**Failure shape.** Once a veto is lifted, a lagging paper trader admits late
entries and fills them against old books. Paper PnL then includes fills a live
trader could not have had. Nothing marks them.

**ADR-023 D7 and ADR-026.** Unchanged. ADR-023's open item O-R6-I2 (6.2) stays
open.

**Code, tests and goldens.** None.

### (e) Record the admission clock and replay it

**The rule.** As (a) live. In addition, the trader persists its process instant
for each routed intent. A replay that reproduces a live run reads those
recorded instants instead of its own clock.

**Determinism.** Recording admission instants reproduces ADR-031's checks
only when the pre-admission state and the intents match the live run. Three
things can make them differ, and none is an admission reading:

- under ADR-023's `CONNECTION_CONFIRMED`, the loop reads the clock for every
  evaluation's feature snapshot, before any intent exists. At `c5157c3`,
  `#computeSnapshot` calls `#bookConfirmedAt`, which calls
  `#processNowEpochMs`. ADR-023 D8 records "a 3 ms lag changed 12 of 13
  decision records with identical outcomes";
- ADR-023 D8 limits parity to "the same initialization and restart
  boundaries";
- frame grouping is live-only (`CO2-N4`).

So full live-to-replay equivalence under lag needs more than (e) records: D7's
per-evaluation readings, the live framing, and a replay that starts where the
live process started. The auditor's E-02 report proposed recording
("recording the relevant admission observations"). That report is
`CLOSEOUT-2`'s source report `E-architecture.md`, outside the repository.

**Cost.** The gateway's dataset does not hold trader readings. So the
reproduction needs a second, trader-side input beside the dataset, which the
ADR-017 manifest does not describe. It needs a persisted shape for the
readings and a second replay mode. Full equivalence would add D7's readings
and `CO2-N4`'s framing work. Not recommended now. It can be added on top of
(a) later, if live-to-replay equivalence under lag becomes a requirement.

### Options set aside

- **Skip old events to catch up.** Forbidden by §8.3 and by §9.1: "not silent
  catch-up from an incomplete stream".
- **A wall-clock lifecycle timer** that flips a market to `CLOSE_ONLY` at
  `closeTime`. It changes market state on a timer, not on an event. The loop
  has no timer (ADR-026, Context 6), and replay could not say when it fired.
- **Rely on the venue to refuse late orders.** This ADR uses no venue
  behaviour at or after the close (1.7). Before the close, nothing at the
  venue tells it that an entry was decided on old data. In PAPER, the
  simulated venue is positioned at the recorded event (1.4).

### Comparison

"Entry" and "exit" are risk's dispositions (1.2). In every option, a covered
SELL that opens exposure is an `EXIT`, and an exit shaped as a BUY is an
`ENTRY` (2(a)).

| | (a) entry guard | (b) ages at the later instant | (b-entry) the same, entries only | (c) pause or halt | (d) accept | (e) record and replay |
| --- | --- | --- | --- | --- | --- | --- |
| Refuses a late entry live | yes | yes | yes | yes, while latched | no | yes |
| Changes exits | no | yes, under lag | no | halt: yes; pause: no | no | as (a) |
| Changes cancels | no | no | no | no | no | no |
| Replay goldens | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged |
| Live vs replay: the divergence it adds | lag refusals, one direction | lag-inflated ages | lag-inflated entry ages | while latched | none | none in ADR-031's checks, when the pre-admission state and intents match |
| ADR-023 D7 | independent | needs the unshifted instant | needs the unshifted instant | independent | unchanged | as (a); full reproduction also records D7's per-evaluation reads |
| New configuration or codes | none, via existing inputs | none | none; the third classification route adds a risk input field | bounds, a code, a health counter | none | a persisted shape |
| Code | admission logic in `trading-core`; one `apps/trader` comment | `trading-core`, including ADR-023's freshness code; one `apps/trader` comment | as (a), plus the classification and ADR-023's freshness code | `trading-core`, `apps/control-api`; one `apps/trader` comment | none | as (a), plus the backtest and storage |
| Test migrations (1.8) | yes | yes | yes | yes | none | yes |

No option removes the divergences that exist today. Frame grouping is
live-only (`CO2-N4`). Under ADR-023's `CONNECTION_CONFIRMED`, D7 reads the
clock at every evaluation, and D8 limits parity to the same initialization and
restart boundaries.

## 3. The decision the user made

The user was asked four questions. On 2026-10-02 the user ruled by accepting
section 4's recommendation. Each question is kept below, with its answer.

1. **Which option:** (a), (b), (b-entry), (c), (d) or (e).
   **Ruled: (a),** through existing inputs, entries only.
2. **Q1, under (a):** existing inputs, or a dedicated measurement and code.
   Under existing inputs, a lag refusal is attributable by its code,
   `RISK_FEATURES_STALE`. A close-criterion refusal is not: it shares
   `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` with an ordinary cutoff refusal. A
   dedicated code per criterion would make close-criterion refusals
   distinguishable too, at the cost of more risk inputs.
   **Ruled: existing inputs.** A lag refusal reads as `RISK_FEATURES_STALE`.
   A dedicated code is a later, additive change.
3. **Q2, reductions under lag.** Should a lagging trader's protective exit be
   refused, as §6 invariant 12 and §13.3 suggest, or taken, as today? Option
   (b) answers "refused" now. Options (a), (b-entry) and (c-pause) leave
   `EXIT`s as today.
   **Ruled: exits as today, in the `CO2-N1` round.** The question passes to
   the round that builds the §9.9 Incident Controller. It must be answered
   before any run mode above PAPER.
4. **Q3, ADR-023's O-R6-I2.** Whether `CO2-N1` must also close it (6.2).
   **Ruled: no.** It is a separate residual, `ADR023-CLOCK-STEP`
   (`IMPLEMENTATION_STATUS.md`, Residual queue).

## 4. The ruling: option (a), through existing inputs, entries only

This was the recommendation, and the user accepted it on 2026-10-02. The
reasons given for it:

1. **It closes the residual as written.** The closeout's probe is refused twice
   over (T1). Every late `ENTRY` is refused at the process instant. A covered
   SELL that opens exposure is an `EXIT` and is not judged, but Static Bracket
   cannot emit one today (2(a)).
2. **Replay is untouched.** The lag is 0 wherever the clock is positioned per
   event. So no golden is expected to change, and no replay mode is added.
3. **It is the smallest change.** One clock read per routed placement and two
   inputs. The admission logic is in `trading-core`. Outside it, one
   `apps/trader` comment changes and the 1.8 tests migrate. No new policy
   field or reason code.
4. **It does not obstruct `EXIT`s or cancels.** Cancels are untouched (§6
   invariant 13). `EXIT`s keep today's path. An exit shaped as a BUY is an
   `ENTRY`. Every entry check already judges it, and the guard judges it too.
   Static Bracket cannot emit one today (2(a)). The auditor's E-02 report
   asked for this: "Gate stale new entries without obstructing safety
   cancellation."
5. **It is independent of ADR-023.** No book age changes, so there is no
   double count with D7's guard. It works under either book-freshness basis.
6. **It makes check 7's features row honest.** `featuresAgeMs: 0` is not a
   measurement. The snapshot's age at admission is the lag.
7. **It fails loudly when misused.** A wrong clock in a replay refuses entries;
   it never admits extra ones.

Why not the others:

- **(b)** is the exact measure, and it may be the right end state for exits.
  But it changes protective exits in PAPER before any Incident Controller
  exists. It also needs a second, unshifted confirmation reading (ADR-023
  D7). Q2 can adopt its exit half later, on top of (a).
- **(b-entry)** is exact for entries and leaves exits alone. Its two halves
  cost differently:
  - the book half needs the disposition before risk runs: a second
    derivation, a duplicated rule, or a change to risk's input. It also needs
    the unshifted confirmation;
  - the reference half needs neither (2(b-entry)). (a) could take it at no
    classification cost. The ruling does not: R6 keeps the reference age on
    event time.

  What (b-entry) removes is bounded: under (a), an admitted entry's book or
  reference is at most the lag bound older than its own bound allows. It only
  adds refusals, so either half can be added on top of (a) later.
- **(c-halt)** would have ended every H1 run 2-8. **(c-pause)** adds state,
  configuration and control-API surface for no gain over (a), and still needs
  the close criterion.
- **(d)** leaves the seam for `WP-270` and makes post-veto paper evidence
  unreliable.
- **(e)** reproduces ADR-031's own refusals in a replay, at the cost of a
  second replay input. Full equivalence would also need D7's readings, the
  live framing (`CO2-N4`) and the same start point. Nothing requires that yet.

On the sub-questions, the user ruled as recommended:

- **Q1:** existing inputs. A dedicated code is a later, additive change if
  operators need it. Until then, a close-criterion refusal cannot be told
  from an ordinary cutoff refusal.
- **Q2:** exits as today, in the `CO2-N1` round. The question is recorded for
  the round that builds the §9.9 Incident Controller, and in any case before
  any run mode above PAPER.
- **Q3:** a separate residual, `ADR023-CLOCK-STEP` (6.2). No option here
  closes it on one host.

## 5. The rule, stated testably

The user ruled for option (a) through existing inputs. The `CO2-N1` round
implements these rules:

1. **R1.** For each routed placement intent, `CoreLoop.#routeIntent` reads
   `clock.now()` once. The read comes after `#persistDecisionsBeforePlacement`
   has resolved, and before the risk input is built. So the time a slow
   commit takes counts as lag. A CANCEL gets no such read; its path is
   unchanged. Under ADR-023's `CONNECTION_CONFIRMED`, D7's own book-age read
   still happens for every routed intent, a CANCEL included.
   - Each placement is measured at its own admission. So two placements from
     one decision can get different verdicts, if a bound is crossed between
     the reads.
   - That is deliberate. One read per decision would judge later placements
     at an older instant, which is less fail-closed.
   - Static Bracket's entry, take-profit and reduction plans each emit one
     intent today.
2. **R2.** `lag = max(0, processNow − eventNow)`, in whole milliseconds, where
   `eventNow` is the instant the decision names (`input.epochMs`).
3. **R3.** The risk input's `featuresAgeMs` is the lag. Check 7 refuses an
   `ENTRY` when it exceeds `freshness.featuresMaxAgeMs` (`RISK_FEATURES_STALE`).
4. **R4.** The risk input's `secondsToClose` is measured from
   `max(eventNow, processNow)`. Check 20 refuses an `ENTRY` when it is at most
   `entryCutoffSeconds` (`RISK_TIME_TO_CLOSE_ENTRY_BLOCKED`).
5. **R5.** A process reading that does not normalize to strict UTC omits the
   features measurement. Check 7 then refuses the entry
   (`RISK_FRESHNESS_UNKNOWN`), and `secondsToClose` uses the event instant.
6. **R6.** Nothing else changes: `evaluatedAt`, the book age, the reference
   age, the rate-limit budget, the strategy's inputs, the cadence and every
   persisted shape.
7. **R7.** No configuration switch turns the guard off. A test that wants old
   instants admitted positions its clock at each event, as replay does.

## 6. What it amends, and what it keeps

### 6.1 Amended readings

| Text | As written | How it reads under (a) |
| --- | --- | --- |
| ADR-026, Context 5 | "The loop reads no wall clock to decide anything." | The loop reads no wall clock to decide which evaluations run (D6). At admission it reads the `Clock` port to refuse an entry (ADR-031). Under `CONNECTION_CONFIRMED` it also reads the port to narrow a book's freshness (ADR-023 D7). Replay positions that clock at each event |
| ADR-026 D3.5 | "Admission (risk freshness, book age, seconds-to-close) runs on event time (`CO2-N1`), so that older instant would make the data look fresher than it is." | The book and reference ages stay on event time. The features' age becomes the lag (ADR-031 R3). Seconds-to-close is measured from the later of the event instant and the process instant (R4). The choice of source event and its reason are unchanged |
| `apps/trader/src/transport-lag.ts`, module header | "The core has no wall clock; this module is where the process's wall clock enters the health surface, and only here." | The core reads its `Clock` port at admission (ADR-031), and under `CONNECTION_CONFIRMED` for book freshness (ADR-023 D7). This module is still the only place the wall clock enters the health surface |
| `packages/trading-core/src/pipeline.ts`, `RiskInputContext.secondsToClose` | "Whole seconds to close, from the loop's instant." | Whole seconds to close, from the later of the event instant and the process instant |

The `CO2-N1-ADR` and `ADR031-ACCEPT` rounds change no code and no existing
ADR but this one. The `CO2-N1` round edits the two code comments. ADR-026 is
Accepted, so its decision text is not edited (README, "Status vocabulary");
this table is its re-reading. ADR-026's header can gain one line pointing
here, as ADR-024's did for ADR-026. That edit needs a round whose grant covers
ADR-026.

### 6.2 ADR-023 (Accepted, on `main`): not amended

- D7: "This ADR does not address `CO2-N1`: live admission runs on event time".
  It stays true of ADR-023. ADR-031 is the admission change ADR-023 left to
  `CO2-N1`.
- D7: "`now` for every age, the `LAST_CHANGE` path (which reads no clock),
  admission, the risk gates' inputs and N1 are all unchanged." It describes
  ADR-023's own effect, and stays true of it. The ruling on the `Clock`-port
  reading is not affected. The user confirmed it by ratifying ADR-023 on
  2026-10-02.
- D7, on O-R6-I2: "Not closed here: it needs a monotonic receipt basis, which
  is the clock-semantics question `CO2-N1` owns." **No option here closes it
  in the cases ADR-023 leaves open:** one host, or two hosts whose clocks step
  together. Every option compares the process clock with the stamps, and both
  stepped by the same amount. A monotonic basis is possible within one gateway
  epoch. `receivedMonotonicNs` is the gateway's per-process monotonic reading
  (§7.1; `packages/simulation/src/clock.ts`), so the difference between two
  stamps of one epoch does not step. Using it would change how every
  event-time age is measured, which is not an admission rule. The user ruled
  it a separate residual, `ADR023-CLOCK-STEP` (Q3).
  `IMPLEMENTATION_STATUS.md` names its owners.

### 6.3 Kept

- Handoff §9.8, check 7 ("Required feeds are fresh and healthy.") and check 20
  ("Time-to-close policy permits entry or reduction."). Option (a) changes how
  the loop measures their inputs, not the checks.
- §6 invariants 2, 3, 12, 13 and 15; §8.1's order; §8.3; §9.1's resync rule;
  §12.1; §12.4.
- ADR-022 D3 and D5: the clock enters only through the port, and the loop does
  not branch on simulation.
- ADR-024 D6 and ADR-026 D6: grouping and cadence read no clock.
- `packages/risk/src/freshness.ts`: "NO CLOCK IS READ IN THIS PACKAGE."
- ADR-017 and ADR-029: no dataset or manifest change. An approximate replay
  (`APPROX-REPLAY-1`) must position its clock at each sample's available
  instant, or it reads a lag.
- The PAPER ceiling and the four safety defaults.

## 7. Acceptance tests for the implementation round

Under option (a) through existing inputs, as ruled. `THROUGHPUT-1c` merged as
`0c270df`, so the conditions of T9 and T11 hold.

| Id | Case | Expected |
| --- | --- | --- |
| T1 | The closeout probe as a test: the paper-trader fixture's `recordedEvents`, `ManualClock` at `12:30:00.000Z`, close `12:15:00`, last event `12:00:03`. The lag is at least 1,797,000 ms, against the fixture's 600,000 ms features bound | `health().risk.approvals` is 0, and nothing fills. In `health().risk.refusalsByCode`, `RISK_FEATURES_STALE` and `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` each count every refusal (each equals `risk.refusals`, at least 1). No surface exposes the lag's value, so the test asserts codes |
| T2 | The close criterion alone: the lag below the bound; the event instant outside the entry cutoff | Process instant at exactly `close − entryCutoffSeconds`: refused, `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` only. At `close − (entryCutoffSeconds + 1) s`: approved, every other check passing. `#secondsToClose` floors, so only this boundary pair is exact |
| T3 | A lagging trader: the clock positioned at each event's instant plus L | L equal to the bound: approved. L one millisecond above: refused, `RISK_FEATURES_STALE`. A backlog whose lag falls below the bound: refused, then approved at the first entry below it |
| T4 | The shipped clock: `assembleDurableTrader` with `SystemPaperClock`. The fixture's instants, open and close are shifted together relative to the host clock | Shifted so the lag exceeds the configured features bound: refused at admission. Shifted to within it: approved |
| T5 | Exits and cancels under lag: a direct-leg position opened at lag 0, then the clock moved 30 minutes ahead. A protective covered SELL of that leg (an `EXIT`) and a CANCEL are routed | Both are judged exactly as at lag 0. An exit shaped as a BUY is an `ENTRY` and would be judged (2(a)); Static Bracket cannot emit one today, so no case routes one |
| T6 | Replay parity | `test:replay` and the e2e determinism goldens pass with no regeneration. `git diff --quiet <base> -- test/replay-golden` holds, where `<base>` is the round's base. The fixture with its clock positioned at each event matches the same run at `<base>`, byte for byte |
| T7 | A clock behind the event instant | Lag 0: entries and exits are judged as today |
| T8 | An unreadable process reading | The entry is refused, `RISK_FRESHNESS_UNKNOWN`. A CANCEL still routes |
| T9 | If `THROUGHPUT-1c` has merged: `CONNECTION_CONFIRMED`, with a lag inside D7's range | The risk input's `venueBookAgeMs` equals its value without ADR-031 |
| T10 | Durability held across a bound: group commit, with the entry decision's commit held open (`run.group.gate`, as `test/integration/paper-trader/group-commit-loop.test.ts` does). While it is held, the clock moves from inside the lag bound to beyond it. A second case moves it from outside the entry cutoff to inside it, with the lag still inside the bound. Then the commit is released | Refused: `RISK_FEATURES_STALE` in the first case, `RISK_TIME_TO_CLOSE_ENTRY_BLOCKED` in the second. Nothing is submitted |
| T11 | Clock reads: a `ManualClock` that counts `now()` calls, positioned at each event (lag 0), under ADR-023's default `LAST_CHANGE` basis if `THROUGHPUT-1c` has merged. One CANCEL and one placement are routed. The counts are compared with the same run at `<base>` | The CANCEL adds no `now()` read. The placement adds exactly one |

Mutants the round runs and tabulates (observed results go in its handoff):

| Mutant | Expected failure |
| --- | --- |
| `featuresAgeMs` back to `0` | T3 and T4; T1 loses its `RISK_FEATURES_STALE` count |
| `secondsToClose` from the event instant only | T2 |
| `min` instead of `max` for the close instant | T2 |
| The lag not clamped at 0 | T7: risk's input door refuses a negative age, `RISK_INPUT_INVALID` |
| The loop refuses any placement whose lag exceeds the bound, whatever its disposition | T5 |
| A CANCEL reads the clock | T11 |
| The clock read before `#persistDecisionsBeforePlacement` resolves | T10 |
| The clock read once, at construction | T3 |
| An unreadable reading taken as lag 0 | T8 |

The implementation handoff lists each affected test from section 1.8 and its
new clock setup or expected refusal. Keep every test. The round also re-runs
the throughput bench and reports any change to its decision digests.

## 8. Consequences

- **Fewer live paper entries during bursts.** At H1's lags, entries during a
  window-open burst would be refused. How much of a window that covers is not
  measured; the next live-data run measures it from the health snapshots.
  Throughput (`CO2-N7`) is the fix for that, not a looser bound.
- **A new divergence between live and replay.** Lag refusals add to the known
  framing difference (`CO2-N4`). It runs in one direction only.
- **The first lag refusal does not show** on the per-code veto panel until
  `CO2-N3` is fixed.
- **Paper fills still carry no decision latency** (Tier 0, §12.2). That is
  ADR-012's Tier 1 question, not this one.
- **The settlement veto can then be lifted** on this residual's account, for
  every `ENTRY`. Today every entry Static Bracket can emit through the core is
  a BUY, so an `ENTRY` (2(a)):
  - positions are per instance, so its complement-leg entry, a covered SELL,
    cannot occur;
  - the shipped configurations are `DIRECT_ONLY` (the example, the throughput
    template, the replay golden, and the e2e and paper-trader fixtures).

  If that shape ever becomes reachable, it is an `EXIT`. No lag rule judges
  it, and check 6 does not refuse it either. That is the `RISK-2 item 7`
  question, not this ADR's. Other preconditions, such as a reviewed
  settlement spec, are unaffected.
- **The options not chosen,** (b), (b-entry), (c), (d) and (e), have their
  consequences in their sections.

## 9. Evidence

- `IMPLEMENTATION_STATUS.md`: Residual queue, `CO2-N1`, `ADR023-CLOCK-STEP`,
  `CO2-N3`, `CO2-N4`, `CO2-N7`, `RISK-2 item 7`; Authorized now,
  `THROUGHPUT-1c`, its rulings.
- The user's ruling of 2026-10-02: recorded in `IMPLEMENTATION_STATUS.md` by
  governance commit `b677fd8` (the `CO2-N1` and `ADR023-CLOCK-STEP` rows).
- `docs/handoffs/CO2-N1-ADR.md`: "Round 2's open LOWs", which this revision
  fixes.
- `docs/handoffs/CLOSEOUT-2-wave-2-closeout.md`: N1, N2, "Where the auditors
  disagreed" item 1. `docs/handoffs/CLOSEOUT-2B-wave-2-regrade.md`: "[INFO] N1
  (E-02) still reproduces on `9ce53a1`", "The user's ruling (2026-09-30)".
- `docs/handoffs/H1-RUNS-2-8.md`: Results, "What this shows".
- `docs/spec/polymarket-bot-orchestrator-handoff.md`: §6, §7.1, §8.1, §8.3,
  §9.1, §9.8, §9.9, §12.1, §12.2, §12.4, §13.3.
- ADR-003 §3; ADR-012 §4; ADR-017; ADR-022 D3, D5 and D6; ADR-024 D4 and D6;
  ADR-025; ADR-026 Context 5 and 6, D2.10, D3, D6 and D7; ADR-029 §5.
- ADR-023 D2, D4, D7 and D8, on `main`, where it is Accepted
  (`docs/adr/ADR-023-book-freshness-by-delivery-session-liveness.md`). Its
  code at `c5157c3`:
  - `packages/trading-core/src/loop.ts`: `#computeSnapshot`, `#bookAgeMs`,
    `#bookConfirmedAt` and `#processNowEpochMs`;
  - `packages/trading-core/src/book-freshness.ts`: `bookConfirmedAt`;
  - `packages/trading-core/src/config.ts`: `bookFreshnessBasisOf`;
  - `infra/compose/trader/trader.config.example.json`: `bookFreshness`.
- Code at `3615560`:
  - `packages/trading-core/src/loop.ts`: `CoreLoop.#processEvent`,
    `#routeIntent`, `#persistDecisionsBeforePlacement`,
    `#persistPendingDecisions`, `#bookAgeMs`, `#secondsToClose`,
    `#availableRequests`, `#positionsFor`, `#stageOutbox`, `#applyEvent`, the
    constructor;
  - `packages/trading-core/src/health.ts`: `HealthState.countRiskRefusal`,
    `risk.refusalsByCode`;
  - `packages/trading-core/src/allocation.ts`: the comment on mirroring
    `buildIntentView`;
  - `packages/trading-core/src/pipeline.ts`: `RiskInputContext`,
    `buildRiskEvaluationInput`, `marketStatusOf`;
  - `packages/trading-core/src/reference-state.ts`: `ReferenceState.ageMs`;
  - `packages/trading-core/src/trader.ts` and `venue-builder.ts`: the other
    holders of the `Clock` port;
  - `apps/data-gateway/src/ports.ts`: `takeReceipt`;
  - `packages/trading-core/src/testing/index.ts`: `ManualClock`;
  - `packages/risk/src/engine.ts`: `evaluateIntentInner` (`isEntry`, the
    intent-deadline pre-check, checks 6, 7 and 20, `approvedAt`);
  - `packages/risk/src/freshness.ts`: `assessFreshness`;
  - `packages/risk/src/intent-view.ts`: `buildIntentView` and its disposition
    table; `packages/risk/src/index.ts`, which exports it;
  - `packages/simulation/src/clock.ts`: `ReplayClock`;
  - `apps/backtest-cli/src/core-loop.ts`: `replayDrivenCoreLoop`;
    `apps/backtest-cli/src/normalizer.ts`: `envelopeFrom`;
  - `apps/trader/src/main.ts`: `SystemPaperClock`, and the subscription
    with no `start`; `apps/trader/src/transport-lag.ts`: `transportHealthOf`;
    `apps/trader/src/pump.ts`;
  - `apps/trader/src/adapters/postgres-registration.ts`:
    `verifyRegisteredRows`; `packages/event-bus/src/transport.ts`:
    `SubscribeOptions.start`;
  - `packages/strategy-sdk/src/context.ts`: `now()`;
  - `packages/strategies/static-bracket/src/decide.ts` (`legPosture`,
    `chooseLeg`) and `observe.ts`;
  - `infra/compose/trader/trader.config.example.json`,
    `test/fixtures/trader-throughput/template.json` and
    `test/replay-golden/backtest/static-bracket/trader-config.json`:
    `economic_leg_policy`;
  - `test/integration/paper-trader/support/fixture.ts` and
    `test/e2e/support/harness.ts`: the test clocks and risk policies;
    `test/integration/paper-trader/group-commit-loop.test.ts`: the held
    commit (`run.group.gate`).
- Venue: `docs/contracts/protected-contracts.md` §8, U-12;
  `docs/venue/verified-2026-09-16.md` D-30 and its U-12 row;
  `docs/venue/verified-2026-09-30.md`, the U-12 row. No other venue fact is
  used.
