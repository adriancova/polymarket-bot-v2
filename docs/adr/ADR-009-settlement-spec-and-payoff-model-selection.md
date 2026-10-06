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
  2026-10-05 (`V2-0`), two dated notes:
  - §8: a journaled Data API `/v2/resolutions` row may publish a window's
    resolution in PAPER, under ADR-030 Amendment 2, rule 5. Its payouts
    only select `YES_WIN` or `NO_WIN`. `V2-3` implements it; not yet;
  - §5: what U-11 means for Protocol V2 markets.

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

**Note, 2026-10-05 (`V2-0`): U-11 and Protocol V2.** The amendment above
says the `umaResolutionStatus` vocabulary is undocumented (U-11). That still
holds for V1 markets (`docs/venue/verified-2026-10-05.md` §12). A V2 market
uses other fields:
- **Gamma `resolutionStatus`,** documented for V2 as `inactive`, `active`
  or `resolved` (F-54). The Gamma OpenAPI and the SDK lack it (C-18), and no
  V2 market has been read from Gamma (U-36). It is recorded, not
  interpreted (plan `V2-2`), and it never publishes a resolution (ADR-030
  Amendment 2, rule 5).
- **Data API `/v2/resolutions`,** a row per condition with its own `status`
  vocabulary, a `reporter` and `payouts` (F-57). Its vocabulary differs from
  Gamma's: two fields, not one (F-57, INF).
- **`disputed` is one of the row's statuses** (F-57). A `disputed` row
  publishes nothing: it is pending, and the window is read again (§8, note
  of 2026-10-05). §4 is unchanged: this note adds no `MarketDisputed`
  event.

This note adds no rule of its own, and changes nothing above PAPER.

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

**Correction, 2026-10-05 (`RTDS-RETIRE`; ruling `V3-C13`; facts recorded by
`VENUE-3` and `VENUE-SETL-1`): RTDS's 30-second window has no PolyBolt
replacement, and this platform no longer ingests RTDS TWAP.** The text above
is unedited; it records the venue as verified on 2026-08-24. Since then, by
the dated reports and with nothing asserted on this ADR's own authority:

1. **The 30-second window (`crypto_prices_twap_thirty`) is gone with RTDS.**
   The venue moved its reference/TWAP prices from public RTDS to the
   authenticated PolyBolt service ("Reference-price channels require CLOB API
   credentials"). Its migration table maps `crypto_prices_twap_thirty` to "No
   PolyBolt replacement for the 30-second window". It deprecated the legacy
   RTDS price topics, with removal planned "one month after the `0.11.0`
   release": about 2026-10-23 by the report's arithmetic, which is not a date
   the venue states. The Chainlink TWAP page this section's source cites is
   gone, behind a 308 redirect (`docs/venue/verified-2026-09-30.md` E-09 to
   E-11, conflict C-13, U-20).
2. **Polymarket's resolution channel publishes only 60 s.** PolyBolt's
   `price.crypto.twap`, "Chainlink time-weighted average prices used by crypto
   up/down market resolution (gated)", documents `window_seconds` as
   "Averaging window of the TWAP series. Only 60 exists today." Polymarket's
   changelog moved the 5-minute markets from the 30-second lookback to a
   60-second one on 2026-08-14 (`docs/venue/verified-2026-10-04.md` F-24,
   F-25).
3. **Chainlink still lists a 30 s stream, which the rules do not name.**
   Chainlink's Data Streams directory shows both
   `BTC/USD-Streams-TWAP-60s-mainnet-production` and
   `BTC/USD-Streams-TWAP-30s-mainnet-production` as `live`. The market rules
   name `btc-usd-twap-60s-streams`, and matching that name to the 60 s
   directory entry is an inference (`docs/venue/verified-2026-10-04.md` F-32,
   U-31). The directory documents the streams' identity, not their values, and
   reading the 60 s stream's values needs a Chainlink account, a credential
   this repository may not hold. This platform uses neither stream: Chainlink
   Data Streams is a paid feed, which ruling `V3-C13` declined.
4. **Ruling `V3-C13` (the user, 2026-10-04): the free route only.** No
   credential is used for prices, and no paid feed is bought. `RTDS-RETIRE`
   therefore retired the gateway's RTDS producer: the data gateway refuses an
   `rtds` block at startup with a dated reason, and every reader of RTDS data
   recorded before then is unchanged. PAPER positions settle from each
   market's public resolution (`MarketResolved`). An open or close reference
   comes from Gamma's `eventMetadata.priceToBeat`/`finalPrice`, observed and
   undocumented fields (`VENUE-SETL-1`) that are never presented as
   documented.

What this means for the two binding rules. This correction adds no rule and
widens neither. Rule 1 keeps its scope and its wording: it governs a
settlement spec "whose `resolution_source` is the RTDS TWAP feed", and the
windows it lists (30 or 60) are that feed's as of the 2026-08-24
verification. This platform no longer ingests the RTDS TWAP feed for any
window: its 30-second topic has no PolyBolt replacement, its legacy topics are
deprecated with removal planned (U-20), and the gateway refuses an `rtds`
block. Chainlink's 30 s stream is a different source: rule 1 does not reach
it, this correction makes no ruling on a spec that names it, and it is unused
under `V3-C13`. The one documented resolution window is 60 s (F-24, F-25),
and this platform ingests no documented feed of it: PolyBolt's
`price.crypto.twap` needs CLOB API credentials and Chainlink's 60 s stream
needs an account, both unused under `V3-C13`, and the legacy RTDS 60-second
topic is no longer ingested. Rule 2 (exact decimals) and the no-replay halt
above stand for RTDS data recorded before the retirement. This correction does
not edit `packages/settlement`'s `RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24`
(`[30, 60]`), a dated record of the 2026-08-24 verification that
`verified-2026-09-30.md` E-10 names for its owner.

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

**Note, 2026-10-05 (`V2-0`): a Data API resolution row as evidence.**
ADR-030 Amendment 2, rule 5 lets a journaled `/v2/resolutions` row publish
a window's `MarketResolved`. It is the orchestrator's interim ruling for
PAPER and BACKTEST, and the user may confirm or overrule it. The facts are
`docs/venue/verified-2026-10-05.md`, cited by id.

1. **The evidence source.** PAPER positions settle from each market's public
   resolution, `MarketResolved` (§6, correction of 2026-10-05, item 4). That
   resolution now has two venue sources:
   - the market channel's `market_resolved`, as before
     (`docs/venue/verified-2026-08-24.md` §3, under Evidence);
   - a `/v2/resolutions` row (F-57), only under rule 5's conditions, when the
     first does not arrive or does not match.
2. **The unit.** `payouts` is "Per-outcome payout in micro-USDC per share,
   `[outcome0, outcome1]`" (F-57). On the wire it is two JSON integers, such
   as `[1000000,0]` (F-59). The SDK turns them into collateral units,
   `["1","0"]` (F-78). That form never reaches this read.
3. **How the vector is read.** ADR-001 §8 item 6's binary64 rule governs
   SDK sizes, not payouts; this note states the same rule for payouts (plan
   §5 item 6).
   - It is compared by value, as a fixed integer vector, with exactly
     `[1000000,0]` and `[0,1000000]`. Every other vector is refused.
   - Our door reads it after `JSON.parse`. A spelling that parses to the
     same integers, such as `1e6`, is that vector, as an alias is under
     item 6.
   - It only selects `YES_WIN` or `NO_WIN`; index 0 is YES (F-40). No
     amount is taken from it. The payoff follows from the outcome, as for a
     `market_resolved` frame.
4. **Not settled from a row:** `SPLIT_50_50`, `CANCELLED`, and every
   `status` but `"resolved"`.
   - The venue documents a binary split payout, with no ratio (F-73;
     plan D18). U-10 stands.
   - A row whose `status` is another of F-57's values is pending. It
     publishes nothing, the window is read again, and the unresolved-window
     incident opens at its usual bound.
   - A `"resolved"` row that does not qualify, a split among them, is
     refused. It publishes nothing and raises that incident at once (ADR-030
     Amendment 2, rule 5, "What a read finds").
5. **The resolution instant.** `MarketResolved`'s `resolvedAt` is the row's
   `resolved_at`, unchanged. A row without a well-formed one is refused.
   - `resolved_at` is observed (F-59), and is not among the documented
     fields the report quotes (F-57). Its use is part of rule 5's interim
     ruling, and a gap for the next venue round (ADR-030 Amendment 2,
     rule 5, "The resolution instant").
   - It dates the resolution and settles nothing. The payoff follows from
     the outcome alone (item 3).
6. **The resolution source.** Up/down markets resolve from Chainlink TWAP
   (F-58), and a V2 canary row named `reporter` `CHAINLINK` (F-59). The row
   is the venue's record of the outcome, not a price this platform reads.
   Ruling `V3-C13` is unchanged.
7. **What is unchanged:** §1's reviewed spec and its fields, §2's model
   selection, §3's terminal subset and §4's ruling. Whether a series' spec
   names this source is for its settlement review (plan D14).
8. **Mode.** PAPER and BACKTEST only (ADR-030 Decision 2.1). It changes
   nothing above PAPER.

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
