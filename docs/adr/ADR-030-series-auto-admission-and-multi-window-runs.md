# ADR-030: Series auto-admission and multi-window runs, in PAPER only

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A5 and
  its sub-ruling).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `ROLLOVER-1`, after `THROUGHPUT-1c` merges. Not yet
  implemented.
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
