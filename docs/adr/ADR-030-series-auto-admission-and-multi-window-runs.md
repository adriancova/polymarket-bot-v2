# ADR-030: Series auto-admission and multi-window runs, in PAPER only

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A5 and
  its sub-ruling).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `ROLLOVER-1`, merged `ae11daa` (2026-10-05).
  [Amendment 1](#amendment-1-2026-10-05-rollover-1) (2026-10-05) records the
  admission policies it implemented, as the orchestrator's interim rulings.
  [Amendment 2](#amendment-2-2026-10-05-venue-4) (2026-10-05) adapts
  admission and resolution to Polymarket Protocol V2. `V2-1` and `V2-3`
  implement it; not yet.
- **Supersedes / Superseded by:** none. It **amends** handoff §9.2 for PAPER,
  the gateway's "no discovery" contract, and the run-boundary semantics. It
  does not amend ADR-009 §1 (see "What it amends"). It is **not**
  auto-approval for live trading (Decision 2).
- **Handoff sections:** §6 (invariant 9), §8.2, §9.2, §9.6, §11, §12.5.
  **ADRs:** ADR-009, ADR-010, ADR-025.

## Context

1. Crypto up/down markets are short windows. A `btc-15m-updown` window lasts
   15 minutes. This comes from the series name and the H1 recordings
   (`LEAN-1` §1 and §2). It is not a verified venue fact, and this ADR does
   not rely on any window schedule.
2. §9.2 gives the Universe Service two duties that pull apart: "Discover
   current and upcoming crypto markets" and "Series binding is configuration,
   not heuristic-only. The system may suggest a series match, but a new market
   pattern is not auto-approved for live trading."
3. The gateway reads markets from reviewed configuration only. Its subscription
   plan says: "It performs no discovery. Markets come from reviewed
   configuration (§9.2)" (`apps/data-gateway/src/subscription-plan.ts`). Its
   configuration check says: "subscriptions and the universe directory are
   configuration, not discovery (§9.2)" (`apps/data-gateway/src/config.ts`).
4. So every run covers a fixed market list. H1 runs held one window each,
   through a driver that restarts the processes at every window (`LEAN-1` §1).
5. Every trader start is a new run. §9.6 says: "Start a new run for every code,
   config, model, feature, or state-schema change."
6. No PAPER entry can pass today. Every entry is vetoed until a `btc-15m-updown`
   settlement spec is reviewed (`CLOSEOUT-2` N2).

## The ruling

The user's ruling A5 (`docs/handoffs/LEAN-1.md`, "The user's rulings
(2026-09-30)"):

> **A4 + A5: yes to both.** … Series auto-admission of each new window in
> PAPER, with one run spanning many windows.

The proposal the user accepted (`LEAN-1` §6, row A5):

> A reviewed series (for example `btc-15m-updown`) admits each new window
> automatically, in PAPER only. Sub-ruling: one run spans many windows
> **[Yes]** rather than one run per window.

## Decision

### 1. A reviewed series admits its new windows automatically

1. A **reviewed series** is a series entry in reviewed configuration. It names
   the series id and the exact pattern a window must match. It names the
   market parameters the review accepted: outcome labels and their order (for
   example Up and Down), tick size, minimum size, fee schedule, trading delay
   and settlement-spec binding.
2. Some facts are new in every window: the outcome token ids, the condition
   id, and the open and close times. They are not reviewed parameters. They
   must be present and well formed, and the close must follow the open. They
   are not compared with any reviewed value.
3. When a new window of that series appears, it is **admitted** without a
   configuration change: the gateway subscribes to it, and the trader adds it
   to the run.
4. A window is admitted only if it matches the reviewed pattern and every
   reviewed parameter exactly. Anything else is not admitted. It opens an
   incident and waits for a human review.
5. Admission fails closed. If the facts are missing or unclear, the window is
   not admitted.
6. Admission does not bypass ADR-009. A model-dependent strategy still needs a
   verified `SettlementSpec` before it may enter (§9.2).
7. Admission uses only documented venue surfaces, as recorded in
   `docs/venue/verified-*.md`. `ROLLOVER-1` cites them. It invents no venue
   behaviour.
8. A run has a configured cap on concurrent admitted markets. `SCALE-8` raises
   it step by step.

### 2. PAPER only, and never auto-approval for live trading

1. Admission runs only when the run mode is PAPER or BACKTEST. In any other
   mode it refuses to start.
2. This ADR does **not** auto-approve anything for live trading. §9.2's rule
   stays in force word for word for every mode above PAPER: "a new market
   pattern is not auto-approved for live trading."
3. A live mode would need its own ruling and ADR.

### 3. Admission is a recorded, ordered event

1. The gateway journals every raw venue response it admits from, before it
   derives anything (the `UNIV-4` rule).
2. It publishes each admission as an ordered event through the same publisher
   as every other feed. `ROLLOVER-1` first uses the existing §7.4 contracts:
   `MarketDiscovered@1` for the admitted window (it carries the market
   reference, both token ids, `seriesId` and a metadata version), and the
   existing lifecycle and `TradingParametersChanged` events for its times
   and parameters. The trader's event door consumes neither
   `MarketDiscovered` nor `TradingParametersChanged` today; `ROLLOVER-1` adds
   them to `CONSUMED_EVENTS` (`packages/trading-core/src/event-door.ts`).
3. If those contracts cannot carry an admission, or a refused window's
   incident, faithfully, `ROLLOVER-1` stops and asks for a
   `packages/domain/**` grant. It does not add or change an event contract on
   its own.
4. Replay reproduces admission from those recorded events. It never asks the
   venue.
5. Each admitted market's parameters are versioned on admission (§6
   invariant 9).

### 4. One run spans many windows

1. A run no longer ends when its window closes. It continues across windows.
2. The run record pins the reviewed series through the run's configuration
   version, not a fixed market list. The run record is the run's
   `strategy.runs` row (§10.3) and the configuration version it names
   (`config_id`). Each admission is recorded as its ordered event
   (Decision 3), which names the admitted market. So the run's admitted
   markets are the admission events in its range (§12.5). `ROLLOVER-1` names
   the fields it uses and pins them with a test. If that needs a schema
   change, `ROLLOVER-1` stops and asks for a `db/migrations/**` grant.
3. §9.6 is kept. A new window is not a configuration change, so it does not
   start a new run. A change to the series configuration itself still starts a
   new run, as does any other §9.6 change.
4. A closed window is torn down after its resolution is handled. Its books,
   features and strategy state are released. Its ledger rows stay.
5. A trader restart still starts a new run.

### 5. Admission is safety-relevant code

1. The admission logic gets an independent adversarial review before merge.
2. Its tests cover a matching window, each kind of mismatch, a missing field, a
   restart during admission, and replay of a recorded admission.

## What it amends

| Text | As written | How it now reads |
| --- | --- | --- |
| Handoff §9.2 | "Discover current and upcoming crypto markets." and "Series binding is configuration, not heuristic-only. The system may suggest a series match, but a new market pattern is not auto-approved for live trading." | In PAPER and BACKTEST, a reviewed series admits each new window that exactly matches it (Decision 1). The binding of a series is still configuration. A new pattern is still never auto-approved for live trading (Decision 2) |
| ADR-009 §1 | "Series binding is configuration, not heuristic-only. … a new market pattern is **not auto-approved for live trading** (§9.2)." | Not amended. Admission of a window of a reviewed series is not a new pattern, and it is PAPER only |
| Gateway contract, `subscription-plan.ts` | "It performs no discovery. Markets come from reviewed configuration (§9.2)" | It performs no discovery outside reviewed series. Markets come from reviewed configuration, or are admitted windows of a reviewed series (Decision 1) |
| Gateway contract, `config.ts` | "subscriptions and the universe directory are configuration, not discovery (§9.2)" | The same, except for admitted windows of a reviewed series |
| Run boundary (§9.6, today's practice) | a run covers a fixed market list; the H1 driver restarts at every window | One run spans many windows. The run record pins the series, and each admission is an ordered event (Decision 4) |

Not amended: ADR-009 §1, §9.6's list of changes that start a new run, §6
invariant 9, and every live-mode rule.

## Consequences

- **Continuous operation.** No restart at each window open. This unblocks a
  second market and every 5-minute market.
- **Admission becomes safety-relevant code.** A wrong match would trade a
  market nobody reviewed, even in PAPER.
- **Run records get longer.** One run can hold hundreds of windows. Reports
  must be able to slice a run by window.
- **The code files change.** `ROLLOVER-1` edits the two quoted gateway comments
  and the configuration check to match this ADR.

## Evidence

- `docs/handoffs/LEAN-1.md` §1, §6 row A5, §7 (ROLLOVER-1), §11 risk 2, and
  "The user's rulings (2026-09-30)".
- `docs/spec/polymarket-bot-orchestrator-handoff.md` §6 invariant 9, §8.2,
  §9.2, §9.6, §12.5.
- ADR-009 §1.
- `packages/domain/src/events/market-lifecycle.ts` (`MarketDiscovered`) and
  `packages/trading-core/src/event-door.ts` (the contracts the trader
  consumes).
- `apps/data-gateway/src/subscription-plan.ts` (module header) and
  `apps/data-gateway/src/config.ts` (the configured-market check).
- `docs/status-archive/work-packages-rounds.md`, `UNIV-4` (journal before
  derive).
- `IMPLEMENTATION_STATUS.md` and `CLOSEOUT-2`, finding N2 (the settlement veto).
- No venue fact is relied on. The 15-minute window length in Context 1 comes
  from the series name and the H1 recordings. `ROLLOVER-1` must ground
  admission in the verified venue documents.

## Amendment 1 (2026-10-05, ROLLOVER-1)

- **Recorded by:** `GOV-NOTES-3`, from `ROLLOVER-1`'s known risk
  R2-FABLE-03.
- **Source:** `ROLLOVER-1`, merged `ae11daa` (PR #68) after a joint ACCEPT
  at `61a0ab2`. Its record is `docs/handoffs/ROLLOVER-1.md`.
- **Standing:** rules 1-8 are **confirmed by the user, 2026-10-05**. They
  were recorded as the orchestrator's interim rulings for PAPER and
  BACKTEST, the modes admission runs in (Decision 2.1). Each records a
  policy `ROLLOVER-1` implemented and its verifiers accepted. None reaches
  a live mode (Decision 2). Rule 8's stated item 6 (R8-FABLE-01) stays
  open for the pre-live risk work.
- **User rulings:** none is changed. Ruling A5 (2026-09-30) and rulings
  Q1-Q4 (2026-10-04) stand as ruled.
- **Decision 1, as merged.** Ruling Q3 and `ROLLOVER-1` r7 shape two
  reviewed parameters. Neither is a new ruling here.
  - **Tick size** is per-window data (ruling Q3). The review pins
    `allowedTickSizes`, 1 to 8 values. The gateway and the trader each
    require the admission's tick size to belong to that list: the gateway
    in `judgeSeriesWindow` (`packages/universe/src/series-admission.ts`),
    the trader in `SeriesWindowAdmissions` (refusal `TICK_SIZE`). The
    gateway also requires the CLOB's `mts` to equal Gamma's tick. This is
    how Decision 1.4's "every reviewed parameter exactly" applies to tick
    size.
  - **Negative risk.** The gateway's and the trader's review schemas accept
    only `negRisk: false` (`ROLLOVER-1` r7, R6-FABLE-01). A review stating
    `true` fails parsing, because augmented negative risk is neither
    reviewed nor read. The gateway refuses a window whose `Market.negRisk`
    or `Event.negRisk` is not exactly `false`.
- **Decision 3, as merged.** The existing contracts could not carry a
  window's scheduled open and close, so `ROLLOVER-1` stopped (Decision 3.3).
  The user granted `SeriesWindowAdmitted@1` (Q1). Its records are
  `docs/contracts/protected-contracts.md` §5 and `docs/contracts/domain.md`
  §12.
  - One frame publishes `MarketDiscovered@1`, `TradingParametersChanged@1`
    and `SeriesWindowAdmitted@1`.
  - The trader consumes `MarketDiscovered@1` and `SeriesWindowAdmitted@1`
    (`CONSUMED_EVENTS`, `packages/trading-core/src/event-door.ts`).
    Decision 3.2 also named `TradingParametersChanged@1`, which the trader
    does not consume. A window's version-1 tick size travels on
    `SeriesWindowAdmitted@1`.

Each rule names the decision it refines and why it fails closed. Code is
cited by symbol. "The gateway" is `SeriesAdmissionFeedDriver`
(`apps/data-gateway/src/feeds/series-admission.ts`) and its
`AdmissionLedger` (`apps/data-gateway/src/admission-ledger.ts`). "The
trader" is `CoreLoop` (`packages/trading-core/src/loop.ts`) and
`SeriesWindowAdmissions` (`packages/trading-core/src/series-admission.ts`).
The rules are numbered within this amendment. From outside it, cite one as
"ADR-030 Amendment 1, rule 3".

### Rule 1. The cap counts every live window and never evicts one

**Refines:** Decision 1.8.

1. The cap is per reviewed series: `maximumConcurrentWindows`, 1 to 64, part
   of the series' review. Configured markets do not count toward it. A run's
   admitted windows are bounded by the sum of its series' caps.
2. Every live window counts, on both sides.
   - **The gateway** counts every `ADMITTED` ledger record of the series
     (`AdmissionLedger.liveWindows`). That includes an admission intent not
     yet confirmed, a window past its unresolved bound, and a window whose
     resolution is owed (rule 2).
   - **The trader** counts every window the run admitted and has not torn
     down, a `HELD_UNRESOLVED` window included.
3. At the cap the gateway admits nothing more. It opens
   `GATEWAY_SERIES_CAP_REACHED` (NOTIFY), naming the held window, and
   reconsiders that window next cycle. Once the window has closed, it is
   skipped as late. A held window with no derivable id is named by a
   reference id (ADR-023 Amendment 1).
4. The trader refuses an admission past its own cap (`CAP_REACHED`).
5. No live window is retired to make room. A window still unresolved
   `unresolvedTeardownSeconds` after its scheduled close is not retired by a
   timer. The gateway keeps it subscribed and in its slot, and opens
   `GATEWAY_SERIES_WINDOW_UNRESOLVED` (NOTIFY) naming it.

**Why it fails closed:** a run never holds more windows than its reviews
allow, whatever their state. Evicting a window would cut the only route its
resolution has to a trader that may hold it. The cost is liveness: windows
awaiting a resolution can stop a series' admissions. Rule 4 is the recovery.

### Rule 2. The gateway retires a window only once its resolution is published

**Refines:** Decision 4.4 ("torn down after its resolution is handled").

1. The gateway's market feed (`feeds/polymarket.ts`) hands each
   `MarketResolved` it dispatched to `noteResolution`, with that envelope's
   publication outcome.
2. The resolution is first recorded on the window's ledger record, as owed.
   Only a `published: true` outcome discharges it (`publishedAt`). Only a
   discharged resolution retires the window `RESOLVED` (`#tearDown`).
3. While its resolution is owed, a window stays `ADMITTED`: subscribed,
   registered and in its cap slot.
   - A `published: false` outcome opens
     `GATEWAY_SERIES_RESOLUTION_UNPUBLISHED` (PAGE).
   - The next gateway epoch re-publishes the recorded payload unchanged
     (`#replayResolutions`), after that epoch's first successful keyset read.
4. If the ledger write fails, the resolution is held in memory, owed, and
   written again every cycle (`#recordUnrecorded`). If the gateway stops
   before a write succeeds, the resolution is lost. The window then waits
   like one whose resolution was never observed (rule 4).
5. The ledger refuses a `RESOLVED` retirement without a published
   resolution, on write and at open.
6. Retirement detaches the window: its tokens are unsubscribed, the
   lifecycle feed stops polling it, and the directory releases it
   (`#detach`).

**Why it fails closed:** a window keeps its route until its resolution has
reached the stream. A publication halt delays a resolution but cannot
swallow it, unless its ledger write also fails before a stop (item 4). The
cost is at-least-once delivery: a resolution whose
`publishedAt` write was lost is published again. Rule 3 makes a repeat
harmless at the trader.

### Rule 3. A resolution is final at the trader

**Refines:** Decision 4.4.

1. A market resolves once. `MarketState.markResolved` refuses a repeat, and
   the first resolution stands. A repeat calls no `onMarketResolved`.
2. After the resolution, a `MarketOpened` or `MarketClosing` changes nothing
   and calls no strategy (`MarketState.markLifecycle`).
3. Both hold for every market the trader runs, configured markets included.

Why it is needed: delivery is at least once (rule 2). The gateway's
lifecycle feed polls a window until the cycle that retires it, so it can
report `MarketClosing` after the resolution.

**Why it fails closed:** a strategy never sees a resolved market reopen, and
never handles one resolution twice. A late lifecycle event cannot hide the
resolution from teardown.

### Rule 4. An operator may retire a named window whose resolution never arrived

**Refines:** Decisions 1.8 and 4.4.

A resolution the gateway never observes would hold its window's slot for
good. That happens when the gateway is down, asleep or disconnected at the
resolution instant. The market channel is not documented to replay it.

1. The recovery is configuration: `seriesAdmission.operatorRetirements`,
   at most 32 entries of `{ internalMarketId, reason }`.
   - Each entry names one window, and a window is named once.
   - The reason is 1 to 500 characters and not blank.
   - The list is outside every series' review, so it changes no
     `seriesConfigHash`. It is read at start, so a change takes a restart.
2. The gateway applies an entry only to a live window past its
   `unresolvedTeardownSeconds` bound with no resolution owed, in the ledger
   or in memory (rule 2).
3. Such a window is retired `OPERATOR`, with the reason (`operatorReason`).
   It is detached like a resolved window and announced by
   `GATEWAY_SERIES_WINDOW_RETIRED_BY_OPERATOR` (NOTIFY).
4. An entry for a window not yet past its bound, or with a resolution owed,
   is not applied. It opens `GATEWAY_SERIES_OPERATOR_RETIREMENT_DEFERRED`
   (NOTIFY). An owed resolution is re-published instead, and retires the
   window `RESOLVED`.
5. An entry naming no window in the ledger retires nothing. It is reported
   once per epoch (`GATEWAY_SERIES_OPERATOR_RETIREMENT_UNMATCHED`, NOTIFY).
6. The ledger requires the reason exactly on an `OPERATOR` retirement, and
   refuses one that carries a resolution.
7. Nothing else retires a window.
8. It frees the gateway's slot only. No resolution is published for the
   window. A trader holding inventory in it keeps it `HELD_UNRESOLVED`, in
   the trader's cap slot, until a new run. If that fills the trader's cap,
   the trader refuses later windows `CAP_REACHED` while the gateway admits
   them.

**Why it fails closed:** the act is bounded. It never retires a window
whose resolution may still arrive inside the bound. It never overrides an
observed resolution. The operator must judge that the window really
resolved, because the gateway cannot verify it. The gateway stays the
ledger's only writer, and each retirement is announced in the stream.

### Rule 5. A flat, idle window may be torn down unresolved

**Refines:** Decision 4.4.

1. The trader tears a window down `UNRESOLVED_AFTER_CLOSE` when it is still
   unresolved `unresolvedTeardownSeconds` after its scheduled close, on event
   time, holds no inventory and is idle (`CoreLoop.#tearDownWindows`).
   - No inventory: no actual balance and no instance's virtual position on
     either of its tokens (`#windowHoldsInventory`).
   - Idle: no tracked order, no pending cancel, and no allocator commitment
     naming its market (`#windowHoldsWork`; rule 7).
2. A window past the bound that holds inventory is not torn down. It is
   reported once (`HELD_UNRESOLVED`), counted (`heldUnresolved`), and keeps
   its cap slot. A later `MarketResolved` still reaches its strategy.
3. The gateway has no such exception. It keeps an unresolved window until
   it resolves or rule 4 retires it.

**Why it fails closed:** a flat window leaves nothing for its resolution to
settle. Any holding keeps the window, so no position loses its owner before
it resolves. As Decision 4.4 says, the window's ledger rows stay.

### Rule 6. A resolution a halt suppressed still releases its window

**Refines:** Decision 4.4.

1. A resolution is handled when its `onMarketResolved` reached every
   instance of the window's market.
2. It is not handled when a MARKET or GLOBAL halt suppressed the callback,
   or an instance was halted, had no computable snapshot, or refused
   (`#resolutionUnhandled`).
3. Such a window is still torn down once idle, with the reason
   `RESOLVED_UNHANDLED`. Its counter is `tornDownResolvedUnhandled`, and
   `tornDownResolved` counts handled resolutions only.

**Why it fails closed:** halts latch for the run, and a skipped callback is
never redelivered, so keeping the window would only hold its slot. The
record never claims the resolution was handled, and the halt stays latched.
Teardown still waits until the window is idle.

### Rule 7. A window is held while capital is committed against its market

**Refines:** Decision 4.4.

1. The trader does not tear a window down while any allocator commitment
   names its market (`AllocatorGate.holdsCommitmentIn`, read by
   `#windowHoldsWork`). The wait is counted (`teardownsBlocked`).
2. On ordinary paths this never binds. An owned order leaves tracking only
   once settled with every filled share booked, which closes its
   commitment.
3. It binds for a commitment that never closes, such as a fill booked
   UNATTRIBUTED. That commitment holds its window, the market's owner and a
   cap slot for the rest of the run.
4. **Masked today.** A fill booked UNATTRIBUTED also latches its market's
   `UNATTRIBUTED_ACTIVITY` halt (`#bookUnownedFill`). While any halt is
   latched, check 1 refuses every non-CANCEL intent: the trader passes
   `runStatePermitsIntent` as `!halts.anyHalt`. No running trader releases
   a halt. So today check 1 already refuses every intent the allocator
   would refuse, exits included, whether or not the window is held. The
   hold matters once a halt can be released (`FOLD-RELATCH`).

**Why it fails closed:** teardown would remove the market's live owner while
the allocator still re-applies the commitment. A LIVE commitment without an
owner is refused `CAPITAL_LIVE_OWNERSHIP_MISSING`, so every later allocator
question would be refused for the run, protective exits included (item 4
says why that is masked today). Holding the window costs a slot: fewer
windows, never more.

### Rule 8. Checks 16 and 17 judge a series-bound instance across its live windows

**Refines:** Decision 4.1, for handoff §9.8 checks 16 and 17.

1. For a series-bound instance, a placement's §9.8 portfolio covers every
   live window of the instance (`CoreLoop.#riskPortfolioFor`,
   `#otherLiveRegistrationsOf`):
   - each window's booked positions;
   - each window's own working orders, at their unfilled remainder;
   - each window's allocator-reported unbooked BUY exposure, asked under the
     instance id (`#unbookedFillsFor`, `AllocatorGate.unbookedExposure`).
     Unbooked SELLs are not deducted from booked positions (item 7);
   - a check-17 mark for each window, from its own YES book's best bid
     (`#scenariosFor`).
2. A held window whose YES book has no bid has no mark. Check 17 then
   refuses the entry `RISK_SCENARIO_MARKS_INCOMPLETE`.
3. Checks 16 and 17 refuse entries only (`evaluateIntent`,
   `packages/risk/src/engine.ts`). So another window's holdings never block
   an exit through them.
4. A market-bound instance has no other registration, so its input is
   unchanged.
5. A torn-down window is not live, so it leaves both measures. Its ledger
   rows stay, and the allocator's §9.7 caps still count them. **Not ruled
   here:** whether a resolved, torn-down window's holdings should stay in
   both measures until redemption (`ROLLOVER-1` r7, known risk 2). In PAPER
   no redemption is booked, so those shares stay in the ledger at cost.
6. **Not ruled here.** Check 17 nets marked values across windows. A marked
   gain in one window can offset a loss in another, so check 17 can admit
   an entry its window alone would fail. The other windows' marks have no
   freshness bound. `ROLLOVER-1`'s round-8 review raised this
   (R8-FABLE-01). Check 16's primary measure is committed cost, which
   another window can only raise.
7. **Not ruled here.** Unbooked SELLs are not deducted from booked
   positions. A sale the ledger has not booked leaves its shares in the
   position. When their mark exceeds their cost, check 17 and check 16's
   resolution limit can admit an entry the booked account would refuse.
   This is `CAP-1`'s pre-existing residual OBS-1
   (`docs/handoffs/CAP-1.md`, known_risks), named `CAP1-OPUS-OBS-1` in the
   doc of `AllocatorGate.unbookedExposure`. A market-bound instance has it
   too. That record owes a risk ADR before any mode above PAPER.

**Why it fails closed:** an instance can no longer pass the primary limit
window by window while exceeding it in sum. A held window that cannot be
marked stops entries; it never lets one pass. Items 6 and 7 are the
exceptions: item 6 for check 17, and item 7 for check 17 and check 16's
resolution limit.

## Amendment 2 (2026-10-05, VENUE-4)

- **Recorded by:** `V2-0`.
- **Source:** `VENUE-4`, merged `f925a43` after a joint ACCEPT at
  `caf502d`. Its record is `docs/handoffs/VENUE-4.md`.
  - The facts are `docs/venue/verified-2026-10-05.md`, cited here by id
    (`F-nn`, `C-nn`, `U-nn`, `O.n`).
  - The plan is `docs/venue/protocol-v2-migration-plan.md`. §5 item 1 lists
    the five points this amendment decides.
- **Standing:**
  - Rules 1-4 are the orchestrator's, made 2026-10-05. Rule 1 follows the
    venue's documented instruction (F-38 to F-40). Rules 2-4 apply
    Decisions 1.4, 1.7 and 3.1 to it.
  - Rule 5 is **the orchestrator's interim ruling for PAPER and BACKTEST**,
    made 2026-10-05. The user may confirm or overrule it.
- **User rulings:**
  - Ruling A5 (2026-09-30) and rulings Q1-Q4 (2026-10-04) stand unchanged.
  - The user confirmed Amendment 1's rules on 2026-10-05. Rule 5 below
    **refines three of them: rules 1, 2 and 4** (rule 5, "Refines"). That
    refinement is the orchestrator's interim ruling, not the user's. The
    user's confirmation or overruling of rule 5 covers it. Every other
    confirmed rule stands as confirmed.
  - The user's SDK-scope ruling of 2026-10-05 keeps the reads below on our
    own clients (ADR-010 §4, note of 2026-10-05).
- **Mode:** PAPER and BACKTEST, the modes admission runs in (Decision 2.1).
  It changes nothing above PAPER, and auto-approves nothing for live trading
  (Decision 2).
- **The handoff:** nothing in it is departed from. Rule 5 adds a venue
  source for `MarketResolved`, and the handoff names none (§7.4, §9.3).
  Two rules depart from this ADR's Decision 1.7 ("only documented venue
  surfaces"), each on the authority named in it: rule 1 item 7 (refusal
  only) and rule 5's use of observed `Resolution` fields.
- **Why now:**
  - Our series is still all V1 (O.5). Its windows may become V2 from about
    2026-11-02 (C-23, U-37).
  - Today admission reads only `clobTokenIds`, and never `version` (plan
    A1). A V2 window whose `clobTokenIds` is `null`, as the documented
    example has it (F-40), is refused. A V2 window that carries both fields
    is judged on its CTF ids, subject to the other checks (plan A1, F-40).
  - No V2 `market_resolved` frame has been observed (F-62, U-38).

The rules are numbered within this amendment. From outside it, cite one as
"ADR-030 Amendment 2, rule 3". Code is cited by symbol.

### Rule 1. The trading ids are selected by Gamma `version`

**Amends:** Decision 1.2, which names "the outcome token ids". **Refines:**
Decision 1.7, for item 7 only: an undocumented field is read, and it can
only refuse.

1. A window's trading ids are taken from the field its Gamma market's
   `version` selects (F-38):
   - `"v2"`: `positionIds`, an array of decimal strings;
   - `"v1"`: `clobTokenIds`, a JSON-encoded array of decimal strings, decoded
     first.
2. The selection holds "even when both fields are present" (F-38). Presence
   never selects the protocol (F-40). The other field is never read as an
   id.
3. Each of these is refused by name, and fails closed with the existing
   refusal incident (Decisions 1.4 and 1.5):
   - a missing or null `version`, or any value but `"v1"` and `"v2"` (F-39,
     F-40);
   - a selected field that is absent or null: "the IDs are not yet
     available" (F-40);
   - an id that is not a decimal string (F-39);
   - not exactly two ids, or two equal ids (plan `V2-1` acceptance 2);
   - outcomes that do not match the reviewed labels and order, as today
     (F-39; Decision 1.1).
4. Index 0 is YES and index 1 is NO (F-40). The CLOB `t[]` pairing check
   stays as merged. For a V2 market, `t[].t` carries the position ids
   (O.3).
5. Decision 1.2 now reads: "Some facts are new in every window: the outcome
   trading ids, selected by the window's `version` (Amendment 2, rule 1),
   the condition id, and the open and close times." The version is checked
   against the review (rule 2).
6. The ids travel in the existing contracts' token-id fields. A V2 position
   id is a 75-digit decimal string (F-44), which the repository's token-id
   schema accepts (plan A17). No event contract changes.
7. The CLOB's `v` field is undocumented (C-21). It is never an authority,
   and it can only refuse. A present `v` that differs from Gamma's `version`
   refuses the window; an absent `v` refuses nothing (plan `V2-1`
   acceptance 8).
   - This refines Decision 1.7, which admits from documented surfaces only.
     An undocumented field is read here, but it never admits a window.
   - The authority is the orchestrator's decision (Standing), under C-21's
     verdict: "`v` may be read as a cross-check of Gamma `version`,
     labelled undocumented, never alone".

**Why it fails closed:** every unclear case is a refusal. A V2 window whose
Gamma record also carries `clobTokenIds` can no longer be admitted with the
CTF ids (plan A1).

**Note, 2026-10-06 (`V2-3` item 7): ids not yet available.**
- **Standing:** the orchestrator's interim ruling for PAPER and BACKTEST,
  made 2026-10-06, on `V2-1`'s known risk V21-FABLE-03. The user may confirm
  or overrule it. It refines item 3's second bullet only.
- **The problem.** The gateway judges a window once, and a refusal is final
  (Decision 1.4). Gamma lists a series' windows up to about a day ahead.
  Whether `positionIds` is present at listing is unknown (U-I3). If a V2
  window's ids are filled in later, every V2 window would be refused at first
  sight.
- **The ruling.**
  1. A window whose `version` is accepted (rule 2), but whose selected id
     field is absent or `null` ("the IDs are not yet available", F-40), is
     **not yet admissible**. It is not a refusal: no `REFUSED` record is
     written and no incident is raised, and it is judged again at each later
     discovery poll.
  2. It becomes a final refusal, with the existing incident, if the field is
     still absent or `null` when it is judged at or after the window's
     scheduled open, on event time: the receipt instant of the read it was
     judged from.
  3. Every other refusal reason stays final, as `V2-1` made it. A window that
     has another mismatch beside its missing ids is refused at once.
- **As implemented** (`judgeSeriesWindow`'s `NOT_YET_ADMISSIBLE`,
  `packages/universe/src/series-admission.ts`; `SeriesAdmissionFeedDriver`).
  - With no ids, the CLOB `t[]` pairing cannot compare ids, so only its
    labels are judged until the ids arrive.
  - For `"v1"`, the series-window door reads `clobTokenIds` as a string or
    `null`, and its `null` also covers a value of another type. So that
    reading never shows that the field is absent or `null`, and ruling 3
    keeps a malformed value final. A `"v1"` window whose `clobTokenIds`
    reads `null` is therefore refused at once, as `V2-1` refused it
    (Decision 1.5; `V2-3` r1, V23-R1-CODEX-01).
  - A `"v2"` window's `positionIds` is held until the open only when the
    door reads it as absent or `null`; read as another type, it is refused
    at once.
  - **Open for `"v1"`** (`V2-3` r2, I-1): ruling 1 is not met for `"v1"`.
    Holding a `"v1"` field known to be absent or `null` needs the door to
    tell absent, `null` and another type apart. That change is outside
    `V2-3`'s paths and was not made. It awaits either a grant of that door
    or a ruling that narrows ruling 1 for `"v1"`; until then, `"v1"` fails
    closed, as above.
- **Why it fails closed:** a not-yet-admissible window is never admitted, and
  holds no cap slot. Once its ids arrive, it is judged in full, exactly as at
  first sight. Past its open, the refusal is final, as before.

### Rule 2. The accepted protocol versions are a reviewed series parameter

**Refines:** Decisions 1.1 and 1.4, and Decision 4.3.

1. A reviewed series names `acceptedProtocolVersions`: a non-empty list of
   distinct values, each `"v1"` or `"v2"`. The gateway never infers it.
2. A window whose `version` is not in the list is refused, with the
   existing incident. This is how Decision 1.4's "every reviewed parameter
   exactly" applies to the version, as `allowedTickSizes` does for tick
   size (Amendment 1, "Decision 1, as merged").
3. The list is part of the review, so it is part of `seriesConfigHash`.
   - The venue moving a series from `"v1"` to `"v2"` changes no hash.
   - Only a review that changes the list does. That starts a new run
     (§9.6; Decision 4.3).
4. Both copies of the review schema carry it, so the gateway's and the
   trader's hashes stay equal: `ReviewedSeriesSchema` in
   `packages/universe` and its mirror in `packages/trading-core` (plan A6).
5. `SeriesWindowAdmitted@1` carries no version, so the gateway alone judges
   it. A version on an event would need a `packages/domain/**` grant
   (Decision 3.3). This amendment asks for none.

**Why it fails closed:** a series admits V2 windows only after a person has
reviewed the switch. Until then its V2 windows are refused. The cost is
liveness: a series meant to trade through the switchover needs a review that
accepts `"v2"` before its first V2 window.

### Rule 3. Gamma's condition id is the identity; the CLOB and the Data API get 32 bytes

**Refines:** Decision 1.2 (the condition id) and the reads of Decision 3.1.

1. Gamma's condition id, as Gamma serves it, stays the window's identity.
   `windowInternalMarketId` hashes it, and the events carry it (plan A7).
2. A V2 condition id is `bytes31`. Boundaries that take `bytes32` "use the
   same values right-padded with zero bytes" (F-43).
   - Gamma's documented V2 example is the 31-byte form (F-43).
   - The width Gamma serves for our series is unobserved (U-36).
3. So every condition-keyed CLOB or Data API read under this ADR sends the
   32-byte form:
   - a 31-byte id (62 hex digits) is right-padded with one zero byte;
   - a 32-byte id (64 hex digits) is sent unchanged;
   - any other width is refused, and no read is made.
4. The reason: `/clob-markets` answers the 31-byte form with 404, and
   `/v2/resolutions` with 400. Both answer the 32-byte form (F-70; C-19).
5. A condition id in a CLOB or Data API answer is compared with the window's
   padded form, never with Gamma's text.
6. The user-stream filter and market-wide cancel are outside this ADR. Their
   width is U-41.

**Why it fails closed:** one identity is used throughout, so a window's id
never depends on the boundary. An id of any other width is refused.

### Rule 4. `GET /v2/resolutions` is a journaled public read

**Refines:** Decision 3.1.

1. The gateway may read Data API `GET /v2/resolutions` for an admitted
   window, keyed by `condition` in the padded form (rule 3; F-57).
   - The Data API v2 states "**Auth**: none" (F-67).
   - The read is made only for a window past its scheduled close whose
     resolution is neither published nor owed (Amendment 1, rule 2). No
     grace period applies (rule 5, "Polling and the incident", item 5).
   - It is made again while the window stays so, until rule 5 publishes
     from a row or refuses one (rule 5, "Polling and the incident"). Every
     read, each repeat included, is requested within the §9.13 budget. The
     interval is the implementing package's choice, inside that budget.
2. The gateway journals the raw body of every response before it derives
   anything (Decision 3.1). That includes a miss, `{ "data": [] }` (F-57),
   an error, and a row it refuses.
3. Replay reproduces what was derived from the journal. It never asks the
   venue (Decision 3.4).
4. The read stays on our own client in `packages/polymarket-public`, not on
   the SDK. The SDK exposes no raw body (§S.4), and it converts `payouts`
   to collateral units (F-78; plan §7.1 S4(b)).

**Why it fails closed:** a resolution derived from a row traces to the bytes
the venue sent, and replays without the venue.

### Rule 5. A resolution row may publish the resolution the market channel did not

**Refines:** Decision 4.4, and Amendment 1, rules 1, 2 and 4, which the user
confirmed on 2026-10-05:
- rule 1 item 5: when `GATEWAY_SERIES_WINDOW_UNRESOLVED` opens;
- rule 2: a second source of the resolution that retires a window;
- rule 4: a recovery that comes before the operator's.

**Standing:** the orchestrator's interim ruling for PAPER and BACKTEST,
made 2026-10-05. The user may confirm or overrule it, in whole or in part.
Every part of this rule belongs to it: the conditions, the resolution
instant, what a read finds, the polling and the incident, and its
refinement of the confirmed rules above.

**The problem.**
- The market channel's `market_resolved` names a `winning_asset_id`, which
  the gateway matches against the window's ids (F-61).
- V2 `market_resolved` frames are unobserved (U-38). A frame may never
  arrive, or may name an id the window does not carry. Then nothing is
  published.
- The window then holds its cap slot until an operator retires it
  (Amendment 1, rules 1 and 4). Every V2 window would do so, and PAPER on
  the series would stall.

**The ruling.** A journaled `/v2/resolutions` row MAY publish the window's
resolution, as `MarketResolved@1`, when all of these hold:
1. it is the response's only row, and its `condition_id` is the window's
   padded condition id (rule 3);
2. its `status` is `"resolved"`. The SDK guide: "Use payouts only from a
   row whose `status` is `"resolved"`" (F-56);
3. its raw wire `payouts` is exactly `[1000000,0]` or `[0,1000000]`, in
   micro-USDC per share (F-57; observed, F-59).
   - It is mapped by index, and index 0 is YES (F-40). So `[1000000,0]` is
     `YES_WIN`, and `[0,1000000]` is `NO_WIN`.
   - The vectors are compared by value, as fixed integer vectors, and no
     amount is taken from them (ADR-009 §8, note of 2026-10-05).
   - The SDK's collateral-unit form, `["1","0"]` (F-78), never reaches this
     read. A tuple in that form is refused, never read a millionfold low;
4. its `resolved_at` is present and is a well-formed instant. It becomes
   `resolvedAt` ("The resolution instant", below);
5. the row was journaled before anything was derived from it (rule 4);
6. no resolution of the window is owed or published, and no
   `market_resolved` frame for the window maps to the other outcome.

**The resolution instant.**
- `MarketResolved@1` requires `resolvedAt` (`MarketResolvedPayloadSchema`).
  The market-channel path takes it from the venue's frame, and substitutes
  nothing for a missing one (`normalizeMarketResolved`). Rule 5 does the
  same.
- A row's `resolvedAt` is its `resolved_at`, unchanged. A row without one,
  or with one that is not a well-formed instant, is refused (below). No
  other time stands in for it: not the read's receipt time, and not the
  window's close.
- **`resolved_at` is observed, not documented.** F-59 quotes it from a
  resolved V2 row (S-A11). The report quotes four fields of the documented
  `Resolution`: `status`, `reporter`, `payouts` and `market_type` (F-57).
  The same holds for `condition_id`, which a `/v2/resolutions` answer was
  observed to carry (F-44, S-L04). Condition 1 uses it only to refuse.
- Reading these two fields departs from Decision 1.7 ("only documented
  venue surfaces"). The authority is this interim ruling.
- If the user overrules the use of `resolved_at`, no row publishes, and
  rule 5 only alarms. Its pending and refusal rules below still apply, and
  the operator's retirement stays the recovery.
- **A gap for the next venue round.** `docs/adr/README.md` says that an ADR
  needing a venue fact the report lacks records it as a gap. The round
  should settle whether the Data API v2 OpenAPI's `Resolution` (S-O06)
  documents `condition_id` and `resolved_at`, and which instant
  `resolved_at` names.

**What a read finds.** Every answer is journaled first (rule 4). Each is one
of four kinds:
1. **Publishable:** a row that meets every condition above. It publishes,
   and the row path ends for the window.
2. **Pending:** a miss, `{ "data": [] }` (F-57), or a single row for the
   window's condition whose `status` is another of F-57's values:
   `initialized`, `posed`, `proposed`, `challenged`, `reproposed`,
   `disputed`, `active` or `arbitration`.
   - It publishes nothing. A `disputed` row publishes no resolution
     (ADR-009 §4).
   - An open window's row is `active`, with no `payouts` (F-59, S-L04).
3. **Failed:** no answer within the read's timeout, an HTTP error status,
   or a body that is not JSON. It publishes nothing.
4. **Refused:** anything else. It publishes nothing. That covers:
   - more than one row, or a row for another condition;
   - a `"resolved"` row whose `payouts` are missing or are any other
     vector, the SDK's collateral-unit form included;
   - a split payout (F-73: "A binary market can resolve to a split
     payout"; plan D18);
   - a `"resolved"` row without a well-formed `resolved_at`;
   - a JSON body without the documented `data` list (F-65), a `status`
     outside F-57's list, and any other row shape;
   - a disagreement with a `market_resolved` frame (condition 6).

**Polling and the incident.**
1. After a pending or failed read, the window is read again, within the
   §9.13 budget, while it is live and nothing is owed (rule 4). Such a
   read raises no incident of its own.
2. The existing unresolved-window incident, `GATEWAY_SERIES_WINDOW_UNRESOLVED`
   (Amendment 1, rule 1 item 5), still opens at the
   `unresolvedTeardownSeconds` bound, as today. Its text carries the latest
   read's result.
3. A refusal raises `GATEWAY_SERIES_WINDOW_UNRESOLVED` at once, with the
   reason, before the bound if need be. The operator then learns now that
   the row path will not deliver this window. A disagreement raises it
   under a scope of its own ("How it fits", item 2).
4. A refusal ends the row path for the window: no more reads, and no row
   publishes for it.
   - Without that, a later answer that happened to qualify could publish
     after the venue had already served one the ruling refuses.
   - The market channel still may publish. The operator's retirement
     (Amendment 1, rule 4) stays the recovery, after the bound, as today.
5. No grace period applies.
   - The first read may follow the close at once. A read that comes early
     finds a miss or a pending row, which publishes nothing.
   - A frame observed first is the window's resolution, and then no row is
     read.

**How it fits the rules already in force.**
1. A resolution published from a row is recorded, owed and discharged like
   one from the market channel. The window then retires `RESOLVED`
   (Amendment 1, rule 2).
2. **Two sources, and a disagreement.**
   - Rule 5 never holds back or filters the market channel. A frame's
     `MarketResolved` is dispatched as today (Amendment 1, rule 2 item 1).
   - The first resolution observed for a window stands: at the gateway,
     where `noteResolution` keeps it, and at the trader (Amendment 1,
     rule 3). A row publishes only while nothing is owed (condition 6).
   - So a frame observed first is the resolution, and a row read then in
     flight publishes nothing.
   - After a row has published, a frame that agrees is a repeat, which
     Amendment 1, rule 3 makes harmless. A frame that disagrees still
     reaches the stream, and the trader calls nothing for it (Amendment 1,
     rule 3).
   - In either order, a disagreement the gateway observes raises
     `GATEWAY_SERIES_WINDOW_UNRESOLVED` (NOTIFY) at once. It names the
     window, both outcomes and both sources.
   - That incident is opened under a scope of its own, which the window's
     retirement does not close. Retirement closes only the window's own
     unresolved scope (`#detach`), and the window retires once its first
     resolution is published. The disagreement must outlive it.
   - A frame that would arrive only after the window is unsubscribed
     (Amendment 1, rule 2 item 6) is never received. A disagreement it
     would show is not seen.
3. Rule 5 applies to every admitted window, V1 or V2. Its conditions do not
   depend on the version, and V1 rows are documented and observed (F-57,
   "terminal CTF state"; F-59).
4. Gamma's `resolutionStatus` (F-54) never publishes a resolution. The
   Gamma OpenAPI and the SDK lack it (C-18), and it is unobserved (U-36).
5. When no row publishes, because the row stays pending past the bound or
   is refused, the operator's retirement (Amendment 1, rule 4) stays the
   recovery. No timer retires a window (Amendment 1, rule 1 item 5).

**Why it fails closed:** each condition narrows what may publish, and any
doubt publishes nothing, which is today's behaviour. A wrong publication
needs the venue's own resolved row to name the wrong outcome before any
frame says otherwise. Rule 5 adds no rule for choosing between sources.
- Before a resolution is owed, a disagreement publishes nothing from the
  row.
- After one, the arrival-order rule already in force decides (Amendment 1,
  rule 3, confirmed by the user), and the disagreement is reported.
- The residual is item 2's last case: a disagreement that would arrive
  after the window is unsubscribed is not seen.

### What Amendment 2 amends

| Text | As written | How it now reads |
| --- | --- | --- |
| Decision 1.2 | "the outcome token ids" | The outcome trading ids, selected by the window's `version` (rule 1) |
| Decisions 1.1 and 1.4 | The reviewed parameters: outcome labels, tick size, minimum size, fee schedule, trading delay and settlement binding | Also `acceptedProtocolVersions` (rule 2) |
| Decision 1.7 | "Admission uses only documented venue surfaces" | Refined twice. The undocumented CLOB `v` may refuse a window, never admit one (rule 1 item 7). A `/v2/resolutions` row's observed `condition_id` and `resolved_at` are read (rule 5, interim) |
| Decision 3.1 | The gateway journals every raw venue response it admits from | Also every `/v2/resolutions` response; condition-keyed reads send 32 bytes (rules 3 and 4) |
| Decision 4.4; Amendment 1, rules 1, 2 and 4 | A resolution comes from the market channel; otherwise an operator retires the window. `GATEWAY_SERIES_WINDOW_UNRESOLVED` opens at the bound | A qualifying `/v2/resolutions` row may also publish it. A refused row, or a disagreement, raises that incident at once (rule 5, interim) |

Not amended: Decision 2, Decision 3.3, Amendment 1's rules 3 and 5 to 8,
rulings A5 and Q1-Q4, and every live-mode rule. Amendment 1's rules 1, 2
and 4, which the user confirmed, are refined by rule 5 alone, on the
orchestrator's interim ruling ("User rulings", above).
