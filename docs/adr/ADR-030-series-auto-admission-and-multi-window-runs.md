# ADR-030: Series auto-admission and multi-window runs, in PAPER only

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A5 and
  its sub-ruling).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `ROLLOVER-1`, merged `ae11daa` (2026-10-05).
  [Amendment 1](#amendment-1-2026-10-05-rollover-1) (2026-10-05) records the
  admission policies it implemented, as the orchestrator's interim rulings.
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
