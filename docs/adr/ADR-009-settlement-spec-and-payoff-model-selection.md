# ADR-009: `SettlementSpec` and payoff-model selection

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-110` (universe, settlement specs, payoff-model
  registry), `WP-040` (`catalog.settlement_specs` and rule versioning) — **not
  yet implemented**. The outcome-state vocabulary and the `MarketResolved`
  contract are already frozen by `WP-020`.
- **Supersedes / Superseded by:** none
- **Amendments:** 2026-09-02 (`GOV-1C`) — §5 gains a dated block recording that
  its §5.2/§5.3 conditions are **discharged**: `WP-110`'s mandated 2026-08-28
  verification closed U-6 documentarily (the 50/50 payout is $0.50 per token,
  stated directly by the venue). The original §5 text is unedited; the
  register row is `docs/contracts/protected-contracts.md` §8 U-6. `CANCELLED`
  mechanics remain unverified (new register row **U-10**) and §4's
  `MarketDisputed` condition remains unmet.

## Context

Handoff §9.3 specifies the required settlement-spec fields, the required outcome
states, and the four payoff models, and closes with a rule that exists because
getting it wrong is silent: "A terminal-spot model must not be used for a
TWAP-settled market." Handoff §9.2 requires the Universe Service to bind each
reviewed series to a `SettlementSpec` and to "Reject model-dependent strategy
activation on unverified settlement specs".

`WP-020` froze the outcome-state vocabulary and made a ruling that this ADR must
ratify: `MarketResolved` carries a **terminal outcome only**, and `DISPUTED` is
**not** terminal (`docs/contracts/domain.md` §6.2; `docs/handoffs/WP-020.md`
Review round 1 MEDIUM-2 and `known_risks` 8).

The venue side is unusually thin here, and that shapes this record. The 50/50
resolution outcome and post-open on-chain clarification are asserted by handoff
§23 but **could not be confirmed** during venue verification: the resolution
documentation page was not successfully captured (venue report §12, unverified
item **U-6**; §11 notes 50/50 is a handoff-asserted resolution-process fact).

## Decision

### 1. A settlement spec is a reviewed artifact, not a heuristic

The §9.3 field list is mandatory:

```text
settlement_spec_id, series_id, rules_version_id, resolution_source,
reference_symbol, observation_type, window_seconds, window_start_rule,
window_end_rule, comparison, strike_source, reference_open_source,
timestamp_boundary, rounding_rule, fallback_source, dispute_policy,
clarification_policy, verified_by, verified_at
```

- `verified_by` / `verified_at` are what make a spec usable. **A spec without
  them blocks model-dependent strategy activation** (§9.2; work-plan `WP-110`
  acceptance "Unverified settlement spec blocks model-dependent activation").
- **Series binding is configuration, not heuristic-only.** The system may suggest
  a series match, but a new market pattern is **not auto-approved for live
  trading** (§9.2).
- Market rules, settlement specs, fee schedules, tick sizes, minimum sizes, and
  delays are versioned, and historical runs use historical parameters (§6
  invariant 9). `catalog.market_rule_versions` holds immutable full rules and
  hashes (§10.1); parameter changes create immutable history (work-plan `WP-110`
  acceptance).

### 2. Payoff-model selection is driven by the spec, not by convenience

The four models (§9.3) are `TerminalSpotBinaryModel`, `TwapBinaryModel`,
`ReferenceOpenUpDownModel`, and `ThresholdByDateModel`. Selection is a function
of the settlement spec — principally `observation_type`
(`TERMINAL_SPOT | TWAP | VWAP | EVENT_RESULT | MANUAL_ORACLE`), with
`comparison`, `window_*`, `strike_source`, and `reference_open_source` fixing the
rest.

**A terminal-spot model must not be used for a TWAP-settled market** (§9.3;
work-plan `WP-110` acceptance). The registry must make the mismatch an error, not
a default.

An `observation_type` with no implementing model (`VWAP`, `EVENT_RESULT`,
`MANUAL_ORACLE` have no model in the §9.3 list) is a spec that cannot be
activated for model-dependent strategies. It is not an invitation to approximate
with the nearest available model.

### 3. Outcome states: full vocabulary is *state*, `MarketResolved` is terminal-only

The §9.3 required outcome states are `YES_WIN`, `NO_WIN`, `SPLIT_50_50`,
`CANCELLED`, `DISPUTED`, `PENDING`, `PENDING_CLARIFICATION`. That full vocabulary
is the right type for the question "what settlement state is this market in" — it
is what the catalog, the settlement layer, and the payoff models consume.

**`MarketResolved` carries only the terminal subset:** `YES_WIN`, `NO_WIN`,
`SPLIT_50_50`, `CANCELLED`.

### 4. Ruling: `DISPUTED` is NOT terminal

**Ratified.** A dispute is an in-flight process, not an outcome. A disputed market
has no determined payoff, so a `MarketResolved` carrying `DISPUTED` would assert a
resolution that has not happened and would invite a settlement consumer to compute
a payoff from it. When the dispute concludes, the market resolves to one of the
four terminal states and `MarketResolved` is emitted then.

- `PENDING` and `PENDING_CLARIFICATION` are excluded for the same reason.
- `CANCELLED` **is** included: it is terminal and its payoff (a refund) is
  determined.
- The dispute remains fully observable as market *state*, and through
  `MarketClarificationObserved` and `DataQualityIncidentOpened`.
- Helpers exist so consumers branch explicitly rather than by string comparison
  (`isTerminalMarketOutcomeState`, `NON_TERMINAL_MARKET_OUTCOME_STATES`).

**Open follow-up: there is no dedicated dispute event.** A venue transition into
dispute is currently expressible only as `MarketClarificationObserved` plus a
data-quality incident plus market state. If `WP-110` (or `WP-070`) finds that the
venue publishes an explicit dispute transition, the correct response is to **add a
`MarketDisputed` event type under a new schema version** (ADR-002 §3), **not** to
loosen `MarketResolved`. This is recorded as an open item in
`docs/contracts/protected-contracts.md`.

### 5. 50/50 support is required; 50/50 mechanics are UNVERIFIED

Handoff §23 states that "Resolution can include a rare 50/50 outcome and may
receive on-chain clarification after trading begins", and work-plan `WP-110`
requires "50/50 resolution is supported".

**The venue verification could not confirm either fact.** Venue report §12 records
**U-6**: the 50/50 outcome and post-open on-chain clarification were "not
confirmable from the pages fetched in this pass;
`https://docs.polymarket.com/concepts/resolution` was not successfully captured",
with the instruction "Retain as handoff-asserted; `WP-110` must verify against the
resolution doc before settlement-spec implementation." Venue report §11 repeats
that 50/50 is a resolution-process fact asserted by handoff §23 rather than
re-confirmed.

Decision:

1. `SPLIT_50_50` and `PENDING_CLARIFICATION` **stay in the vocabulary** and the
   payoff models **must support a 50/50 payoff**. Supporting an outcome that never
   occurs costs a branch; failing to support one that does occur corrupts
   settlement accounting.
2. **No component may assert the venue's 50/50 or clarification mechanics as
   verified.** Documentation, comments, and reports must carry the UNVERIFIED
   marker until `WP-110` closes U-6.
3. What *is* verified is the collateral backing: "Every YES and NO pair is backed
   by exactly $1 of collateral locked through the CTF contracts" (venue report
   §10.2). **If** the venue's 50/50 outcome pays both sides from that same
   backing, the payoff is 0.5 per share on each side. That arithmetic follows from
   the cited backing statement; **the existence and mechanics of the 50/50 outcome
   itself remain unverified** and must not be implemented as though confirmed.
4. `clarification_policy` and `dispute_policy` are required spec fields (§9.3), so
   every reviewed spec must state what happens on a post-open clarification even
   while the venue mechanics are unverified. "Halt and escalate" is a legitimate
   policy; "unspecified" is not.

**Amendment, 2026-09-02 (`GOV-1C`): the §5.2 condition is discharged and the
§5.3 conditional is confirmed.** `WP-110` performed the verification this
section mandated, on 2026-08-28, against the exact page U-6 named
(`https://docs.polymarket.com/concepts/resolution`, HTTP 200 in rendered and
Markdown forms; verbatim quotes, dates, and method in
`docs/handoffs/WP-110.md` §"venue facts verified"). The venue states the 50/50
payout **directly** — "Market resolves 50/50 — each token redeems for \$0.50"
— so the payout is no longer an inference from the collateral statement:
`SPLIT_50_50_PAYOUT_PER_SHARE = "0.5"` is venue-verified as of that date, and
the §5.2 UNVERIFIED-marker obligation **for the 50/50 outcome and post-open
clarification** is lifted. Recorded under the `docs/adr/README.md` bounded
exception for a ratifying record of a work package's **mandated** verification
(all four conditions met: §1.1 precedence; URL + date + verbatim quotes held
in the `WP-110` handoff, documentary-not-observational stated; the frozen
report cited for U-6's origin and not edited; the gap recorded — the
resolution page is still absent from any report's source index and is listed
as owed in `docs/venue/verified-2026-09-02.md`). Three things this amendment
does **not** do: it does not verify `CANCELLED` mechanics (register row
**U-10**; the `SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED` refusal stands), it
does not change §4 (no dispute transition event was found; the
`umaResolutionStatus` vocabulary is undocumented — register row **U-11**),
and it claims nothing observational (handoff §1.2 keeps the fact volatile;
each phase gate re-verifies).

### 6. TWAP specs must name a window the feed actually publishes

Verified (venue report §10.3): Chainlink TWAP arrives over RTDS at
`wss://ws-live-data.polymarket.com` on exactly two topics —
`crypto_prices_twap_thirty` (30-second window) and `crypto_prices_twap_sixty`
(60-second window). Symbols are lowercase slash-delimited pairs (`btc/usd`). The
`filters` subscription field is **optional** ("Omit it to receive every available
symbol"); when present it must be the exact compact JSON form. The update payload
carries `{symbol, value (number), full_accuracy_value (string integer),
timestamp (unix ms), window_s}`.

Two binding rules:

1. A settlement spec whose `resolution_source` is the RTDS TWAP feed may only
   declare a `window_seconds` the feed publishes (30 or 60 as of the verification
   date). A spec naming any other window **cannot be marked verified**, because
   nothing would produce the observation it depends on. Handoff §23 says the same
   thing in the other direction: "settlement specs must determine whether those
   feeds are relevant to a specific series."
2. The exact-decimal path uses `full_accuracy_value`, never the floating `value`
   (ADR-001 §8.3).

**There is no replay after a disconnect.** Verbatim: "Subscriptions start with the
next update. There is no snapshot, history, or replay after a disconnect" (venue
report §10.3). Therefore a TWAP-dependent strategy must **halt** on an RTDS gap
rather than interpolate or backfill; no missing history may be fabricated
(work-plan `WP-100` acceptance; §8.3).

### 7. Neg-risk markets are recorded, not modeled, in v1

Verified (venue report §7, §10.2): negative risk is exposed as
`market.state.negRisk` (Gamma `negRisk`), with event-level `enableNegRisk` and
`negRiskAugmented` for the augmented case; neg-risk markets settle through the
**Negative Risk CTF Exchange** contract and support converting one NO token into
YES tokens of the event's other outcomes.

Decision: `negRisk` is part of the versioned per-market parameter set (ADR-002
§6) and must be recorded on every spec binding. **Payoff modeling of the
neg-risk conversion is out of v1 scope** — §3.2 excludes multi-leg arbitrage that
assumes atomic execution, and a conversion-aware payoff model is exactly that
class of problem. A spec bound to a neg-risk market may be verified for ordinary
binary settlement; it may not claim to model conversion.

### 8. Resolution is not settlement

**Order state and settlement state are separate** (§6 invariant 5), and that
extends to resolution: a `MarketResolved` event asserts the payoff is determined,
not that redemption has occurred. Redemption is a wallet operation with its own
lifecycle (§9.14, ADR-006 §8) — "Redeem: claim pUSD for winning tokens after
resolution" (venue report §10.2).

A position's economic value at resolution and the pUSD actually received are
separate facts, recorded separately, and reconciled (§9.17).

## Consequences

- **Some series will not be tradeable for a while.** A spec that cannot be
  verified blocks model-dependent activation. That is the point: an unverified
  payoff model produces confident, wrong PnL.
- **U-6 gates `WP-110`.** Settlement-spec implementation cannot honestly begin
  until the resolution documentation is captured. This is a real schedule
  dependency, not a formality, and it is recorded as an open venue item.
- **The DISPUTED ruling costs expressiveness today.** Until a `MarketDisputed`
  event exists, a dispute is reconstructed from clarification plus incident plus
  state. That is uglier than a dedicated event and safer than a `MarketResolved`
  that means "maybe".
- **The TWAP window constraint couples settlement specs to feed availability.** If
  the venue changes the published windows, previously verified specs must be
  re-verified — which is exactly what §6 invariant 9's versioning is for.
- **Excluding neg-risk conversion from v1 leaves value on the table** and keeps a
  whole class of atomicity assumptions out of the payoff layer. Revisiting it
  needs a new ADR plus venue verification of the conversion mechanics.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §1.2 — venue facts are volatile; position split/merge/redemption workflows and
  Chainlink symbols/windows are re-verified each phase.
- §3.2 — multi-leg arbitrage assuming atomic execution is out of scope.
- §6 invariants 5 and 9.
- §7.4 — the lifecycle event list, including `MarketResolved`,
  `MarketClarificationObserved`, `MarketRulesChanged`, and
  `TradingParametersChanged`.
- §9.2 — universe responsibilities: bind each reviewed series to a
  `SettlementSpec`; reject model-dependent strategy activation on unverified
  settlement specs; series binding is configuration, not heuristic-only.
- §9.3 — the required settlement-spec fields, the required outcome states, the
  four payoff models, and "A terminal-spot model must not be used for a
  TWAP-settled market."
- §9.14 — redeem as a first-class wallet operation.
- §9.17 — reconciliation.
- §10.1 — `catalog.settlement_specs`, `market_rule_versions`,
  `market_clarifications`, `market_parameter_history`.
- §23 — handoff-time notes, including "Resolution can include a rare 50/50 outcome
  and may receive on-chain clarification after trading begins" and the 30 s/60 s
  Chainlink TWAP note. §23 opens with "These notes must be reverified at build
  time."

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §3 — the market channel's enhanced lifecycle events `new_market` and
  `market_resolved` (`winning_asset_id`, `winning_outcome`), available with
  `custom_feature_enabled`.
- §7 — per-market parameters including `negRisk` and the augmented neg-risk
  fields.
- §10.2 — split/merge/redeem; "Every YES and NO pair is backed by exactly $1 of
  collateral locked through the CTF contracts"; neg-risk markets use the separate
  Negative Risk CTF Exchange and support NO→(other outcomes' YES) conversion;
  published contract addresses.
- §10.3 — RTDS topics `crypto_prices_twap_thirty` / `crypto_prices_twap_sixty`,
  lowercase slash-delimited symbols, optional `filters`, the update payload
  including `full_accuracy_value`, and verbatim: "Subscriptions start with the
  next update. There is no snapshot, history, or replay after a disconnect."
- §11 — the §23 re-confirmation list, with the explicit parenthetical that "50/50
  resolution is a resolution-process fact asserted by handoff §23; see UNVERIFIED
  item U-6."
- §12 unverified **U-6** — the 50/50 outcome and post-open on-chain clarification
  are **NOT CONFIRMED**; the resolution page was not captured; `WP-110` must
  verify before settlement-spec implementation.
- §12 unverified **U-5 residual** — additional exchange-contract addresses,
  including the Negative Risk CTF Exchange settlement contract, must be
  re-verified in `WP-300`.

**Implementation and prior handoffs:**

- `docs/contracts/domain.md` §6.2 (the terminal-subset decision and the DISPUTED
  ruling in full), §8 (`MarketOutcomeState` reuses the §9.3 vocabulary;
  `MarketResolved.outcome` is the terminal subset).
- `docs/handoffs/WP-020.md` — Review round 1 MEDIUM-2 (the finding that produced
  the ruling) and `known_risks` 8 ("`DISPUTED` has no dedicated event … a
  `MarketDisputed` event type should be added under an ADR rather than by
  loosening `MarketResolved`").
- `docs/handoffs/WP-000.md` — `follow_up`: "`WP-110`: verify 50/50 resolution and
  post-open clarification (U-6) against the resolution documentation."

**Safety:** this ADR changes no run-mode default (ADR-010). It enables nothing;
its main operational effect is to *block* activation of model-dependent
strategies on unverified specs.
