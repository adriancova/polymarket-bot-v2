# ADR-012: Simulation fill-model evidence hierarchy

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-210` (replay clock, dataset source, simulated venue,
  Tier 0 and Tier 1 fill models), `WP-360` (calibration pipeline), `WP-350`
  (execution probes, human-gated) — **not yet implemented**
- **Supersedes / Superseded by:** none

## Context

Handoff §12.2 defines three fill models and closes with the sentence this ADR
exists to make binding: "**Paper fills do not count as independent evidence that
the fill simulator is correct.**" §17 Phase 4's gate repeats it from the other
side: "Maker strategy promotion remains blocked without actual evidence."

The failure this prevents is specific and common: a simulator is written, a
paper run produces attractive fills, the attractive fills are then cited as
evidence that the simulator is realistic, and the strategy is promoted on
circular evidence. Nothing about the process looks dishonest at any single step.

## Decision

### 1. Three tiers, with fixed permissible uses

| Tier | What it does | Permitted use |
| --- | --- | --- |
| **Tier 0 — pipeline smoke** | Immediate orders consume observed top/depth with no latency; maker orders fill on touch/trade-through. | Wiring and regression only. **Never used for deployment decisions** (§12.2). |
| **Tier 1 — latency and queue-estimated** | Adds sampled decision, signing, network, and venue latency; replays market events during the delay; executes against the resulting depth; applies FAK/FOK/limit semantics and **historical** fee parameters. Resting orders estimate quantity ahead at placement, decrement by observed trades, and apply optimistic/base/conservative cancellation assumptions. | Research and comparison. **Reports a result band, not one falsely precise fill result** (§12.2). |
| **Execution calibration model** | Conditional models for fill probability, fill latency, cancel effectiveness, partial-fill distribution, slippage, and post-fill markout. | Fitted **only** from actual `EXECUTION_PROBE` and `LIVE_MICRO` observations (§12.2). |

A Tier 1 result that is quoted as a single number instead of a band has already
violated this ADR.

### 2. The evidence rule

1. **A paper or backtest fill is never evidence about real fill quality.** It is
   evidence about the simulator's own behavior and about strategy logic, state
   handling, risk, and operations — which is exactly what `PAPER` mode is for
   (§11: "Validate signal, state, risk, and operations").
2. **Only actual venue observations calibrate the execution model.** That means
   `EXECUTION_PROBE` and `LIVE_MICRO` data (§12.2), which require a human gate and
   are currently unreachable (ADR-010).
3. **No component may label a simulated fill as real.** Work-plan `WP-210`
   acceptance: "Paper fills are not labeled real evidence"; `WP-360` acceptance:
   "Paper fills are not treated as actual fills."
4. **Maker-strategy promotion is blocked without actual evidence** (§17 Phase 4
   gate). "The simulator says it fills" is not a promotion argument.
5. Predicted and actual distributions are compared **honestly** — reported
   together, including where they disagree (§17 Phase 4 gate; §12.6 "Predicted
   versus actual fill and slippage distributions").

### 3. Markouts are diagnostics, not an extra penalty

Markouts are diagnostics and calibration inputs. **Do not subtract an additional
markout penalty from a replay path that already includes the subsequent adverse
price movement** (§12.3) — that double-counts the same cost and makes a strategy
look worse in a way that is not real. Stress scenarios that apply an extra
penalty are produced **separately** and labeled as stress (§12.3; work-plan
`WP-210` acceptance "Markout is not double-counted").

Required horizons: 100 ms, 500 ms, 1 s, 5 s, 30 s, 300 s, and resolution (§12.3).

### 4. Determinism is a precondition for any of this to mean anything

A fixed dataset, code commit, config, feature version, model version, simulator
version, and seed must produce **byte-identical** decisions, intents, risk
results, execution plans, simulated order events, fills, ledger events, and PnL
outputs (§12.4). CI runs a small golden replay on every change to core contracts
(§12.4).

Replay follows recorded dispatch order and must not sort by venue timestamp
(§8.4, §6 invariant 15, ADR-002 §2). Everything between event input and the
`ExecutionVenue` interface is shared between live and simulated runs (§12.1) —
only the clock, the event source, and the execution venue are swapped (§2).

Every replay run pins the full §12.5 manifest, including the **fill-model version
and parameters** and the **latency-model version and parameters** alongside the
fee/reward snapshot versions and settlement-spec versions. A result whose
fill-model parameters are not pinned is not reproducible and is not evidence of
anything.

### 5. What Tier 1 must model, and why (all venue-grounded)

Each item below changes simulated fill quality materially, and each cites the
verification report rather than assuming venue behavior.

1. **Per-market trading delay.** A marketable order can receive the `delayed`
   status when `market.trading.secondsDelay > 0`, and a delayed response "is
   accepted but has not matched yet … Treat it as a pending order rather than a
   fill" (venue report §2.2, §7). A simulator that fills marketable orders
   immediately on a delayed market **overstates** immediate fills.
2. **GTD's early-expiry offset.** "GTD orders expire one minute before their
   stated expiration as a security threshold", with a minimum stated expiration
   around 3 minutes in the future (venue report §2.3). A simulator that rests a
   GTD order until its stated timestamp **overstates** resting time by 60 seconds.
3. **Order-type semantics.** FAK fills available liquidity and cancels the
   remainder; FOK is all-or-nothing; `postOnly` applies only to resting limit
   types (venue report §2.3).
4. **Taker-only fees, from the historical snapshot.** `fee = C × feeRate × p ×
   (1 − p)`, symmetric around `p = 0.5`, rounded to 5 decimal places, minimum
   charged fee `0.00001`, **makers pay no fees**, taker `feeRate` for Crypto
   `0.07` as of 2026-08-24 (venue report §6). These are volatile program
   parameters; §12.5 requires the fee snapshot **version** to be pinned per run,
   and §9.13 forbids hardcoding them.
5. **Rebates and rewards are not per-fill credits**, and the three programs work
   differently (venue report §6; see ADR-006 §6 for the same breakdown):
   **maker rebates** are pool-shared out of taker fees
   (`(your_fee_equivalent / total_fee_equivalent) × rebate_pool` per market),
   paid daily at midnight UTC, `$1` minimum; **taker rebates** are tiered by
   30-day weighted volume with a **daily** pUSD payout, `$1` minimum, and no
   backfill (the report states no midnight-UTC time for this program);
   **liquidity rewards** are scored from one-minute samples over a weekly epoch
   and paid daily at midnight UTC, `$1` minimum. What matters for a fill model is
   the shared property: each is computed over a period from aggregate activity and
   paid on a daily cycle. A simulator therefore **may not credit a rebate to a
   simulated fill**; reward modeling is a separate, clearly labeled estimate
   (§9.16, ADR-006 §6), and core PnL excludes discretionary rewards (§6
   invariant 14).
6. **Rate-limit budgets bound achievable action rates.** Per-signer order and
   cancel token buckets, with all-or-nothing batch admission, plus IP-level
   limits (venue report §8). A simulator that ignores them **overstates**
   achievable cancel/replace rates and therefore maker performance. The simulated
   venue must apply the same budget model as live (§9.13), including that safety
   cancellation outranks new order placement (§6 invariant 13).
7. **Restricted engine modes exist but have no documented base rate.** HTTP 425
   on a matching-engine restart followed by a 2-minute post-only window, plus
   cancel-only and post-only 503 modes (venue report §9). These must be
   **injectable** for fault-injection testing (§16.6), but **no frequency may be
   assumed** in a baseline simulation, because the documentation states none.
8. **Book-update semantics are provisional.** Whether `price_change.size` is
   absolute with `"0"` removing a level is **not documented** (venue report §3,
   conflict **C-1** in §11, unverified **U-1** in §12). Depth reconstruction —
   and therefore every fill decision that consumes depth — inherits that
   uncertainty until `WP-070` confirms it (ADR-002 §8). Simulation results
   produced before that confirmation carry the same unverified marker.
9. **No invented venue sequence number.** Queue-position estimates must be built
   from ingest order, venue timestamps, and venue-provided hashes only (§9.4,
   ADR-002 §2).

### 6. Reporting standards

Standard evaluation outputs are fixed by §12.6 and are part of this decision,
because a fill model is only as honest as the report that presents it:
time-based train/validation/holdout split; block-bootstrap confidence intervals;
effective sample size; parameter-sweep count with a multiple-comparison warning;
core PnL at modeled costs, **1.5× costs, and 2× costs**; results with and without
discretionary rewards; performance by volatility, liquidity, spread,
time-to-close, and market series; calibration curves and Brier score for
probability models; and predicted-versus-actual fill and slippage distributions.

Simulation-fidelity metrics are first-class and monitored: predicted-versus-actual
fill rate, fill latency, slippage, and markout (§14.3), with
"Simulation/live divergence" as a notify-level alert (§14.4).

### 7. Time-based evidence cannot be manufactured

Soak and other time-based operational gates "cannot be faked by an agent. The
orchestrator must mark them `PENDING_EXTERNAL_EVIDENCE` until real elapsed-time
evidence exists" (§16.7); the work plan sets
`time_based_gates_may_be_simulated: false`. No agent or report may claim a soak,
execution probe, or live result occurred without real evidence (`AGENTS.md`).

**Current state:** no execution probe and no live-micro run has occurred, so
**no calibration data exists** and the calibration model has nothing to fit
(`IMPLEMENTATION_STATUS.md` — every human/operational gate "Not requested"; venue
report §13 — "No real order was placed; no execution probe was run").

## Consequences

- **Maker strategies stay blocked for a long time.** They need actual execution
  evidence, which needs a human-gated probe phase (ADR-010). That ordering is
  deliberate: maker performance is exactly where simulation is least trustworthy.
- **Tier 1 output is a band, which is harder to act on than a number.** That is the
  honest shape of the estimate; collapsing it to a point estimate would be
  precision the model does not have.
- **Fee, reward, and rate-limit snapshots become replay inputs.** Every historical
  run must resolve the parameters that applied *then* (§6 invariant 9, §12.5),
  which is more plumbing than a constant and is the only way a backtest means
  anything after the venue changes a rate.
- **Pre-`WP-070` simulation results carry an unverified marker.** Depth
  reconstruction rests on the provisional C-1/U-1 reading, so results produced now
  are provisional too.
- **The simulator must implement the venue's annoyances to be useful.** The GTD
  offset, the trading delay, and the token buckets are the difference between a
  fill model and a wish.
- **Nothing here can be validated end-to-end today.** With no probe data, the only
  available checks are internal consistency and determinism. That gap is closed by
  evidence, not by more simulation.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §2 — simulation uses the same strategy and core engine code; only the clock,
  event source, and execution venue are swapped.
- §6 invariants 9, 13, 14, 15.
- §8.4 — replay consumes recorded dispatch order; manifests include segment
  checksums and excluded data-quality windows.
- §9.4 — the implementation must not invent a venue sequence number.
- §9.13 — rate-limit budgets, priority order, and configuration snapshots.
- §9.16 — reward estimates are never booked as realized.
- §11 — `PAPER` validates signal, state, risk, and operations; `EXECUTION_PROBE`
  and `LIVE_MICRO` require a live signer.
- §12.1 — the `Clock`, `MarketEventSource`, and `ExecutionVenue` interfaces.
- §12.2 — Tier 0, Tier 1, and the execution calibration model, including
  "Never used for deployment decisions", "Report a result band, not one falsely
  precise fill result", and "**Paper fills do not count as independent evidence
  that the fill simulator is correct.**"
- §12.3 — markouts are diagnostics; do not double-count; the required horizons.
- §12.4 — byte-identical determinism requirements and the CI golden replay.
- §12.5 — the dataset-manifest pin list, including fill-model and latency-model
  versions and parameters.
- §12.6 — the evaluation methodology and standard outputs.
- §14.3 — simulation-fidelity metric family.
- §14.4 — "Simulation/live divergence" notify alert.
- §16.6 — fault-injection scenarios including matching-engine `425` restart and
  cancel-only/post-only mode.
- §16.7 — time-based gates cannot be faked.
- §17 Phase 4 — "Predicted and actual distributions are compared honestly. Maker
  strategy promotion remains blocked without actual evidence."

**Work plan** (`docs/spec/polymarket-bot-workplan.yaml`): `WP-210` acceptance
("Replay follows dispatch order, not sorted venue time", "Same manifest/config/
seed is byte-identical", "Markout is not double-counted", "Paper fills are not
labeled real evidence"); `WP-360` acceptance ("Paper fills are not treated as
actual fills", "Markout remains a diagnostic unless used in a separate stress
model", "Calibration artifact is versioned and reproducible"); `WP-350` gated
`human-approval`; `defaults.time_based_gates_may_be_simulated: false`.

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §2.2 — the four order response statuses and the verbatim delayed-order
  semantics.
- §2.3 — GTC/GTD/FAK/FOK; the verbatim GTD 60-second early-expiry rule and the
  ~3-minute minimum; `postOnly` only on resting limit types.
- §3 — market-channel events, and the fact that `price_change.size`
  absolute-versus-delta semantics are **not** stated.
- §6 — the fee formula, 5-decimal rounding, `0.00001` minimum, taker-only fees and
  per-category rates; maker rebates and liquidity rewards paid daily at midnight
  UTC, taker rebates tiered by 30-day weighted volume with a daily payout and no
  stated time — each in pUSD with a $1 minimum accrual. **Volatile snapshot.**
- §7 — dynamic tick size, `minimumOrderSize`, and `secondsDelay`.
- §8 — IP and per-signer rate limits, token costs, all-or-nothing batches, and
  volume tiers. **Snapshot with effective date 2026-08-24.**
- §9 — HTTP 425 restart with no documented body, the 2-minute post-only window,
  and cancel-only/post-only 503 modes. No frequency is documented.
- §11 conflict **C-1** and §12 unverified **U-1** — `price_change` size semantics
  remain **UNVERIFIED**; `WP-070` must confirm.
- §13 — safety attestation: no real order was placed and no execution probe was
  run, so no calibration data exists.

**Related records:**

- [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) §8 — the
  provisional book-update semantics the fill model inherits.
- [ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) §6 — why rebates
  cannot be credited per fill.
- [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) — why
  calibration data does not exist yet and cannot be manufactured.

**Safety:** this ADR changes no run-mode default (ADR-010). It **restricts** what
simulated results may be used to justify, and it explicitly records that no probe
or live evidence exists in this repository.
