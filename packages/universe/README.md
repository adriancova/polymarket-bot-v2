# `@polymarket-bot/universe` — the Universe Service

Owner: `WP-110`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §9.2 (with §7.4,
§6 invariant 9, §10.1), [ADR-009](../../docs/adr/ADR-009-settlement-spec-and-payoff-model-selection.md)
Layer: 1 (`docs/contracts/dependency-direction.md` §2) — depends on
`@polymarket-bot/domain`, `@polymarket-bot/decimal`, `zod`, and nothing else.

---

## 1. The §9.2 responsibilities, and where each lives

| §9.2 responsibility | Module |
| --- | --- |
| Store both outcome tokens, condition ID, event ID | `identity.ts` |
| Group ephemeral markets into stable series | `series.ts`, `registry.ts` |
| Store tick size, minimum size, `negRisk`, fee schedule, trading delay, open/close | `parameters.ts` |
| Version market parameters on every change | `parameters.ts` |
| Bind each reviewed series to a `SettlementSpec` | `settlement-binding.ts` (the port) + `registry.ts` |
| Emit lifecycle events | `registry.ts` (`MarketDiscovered`), `parameters.ts` (`TradingParametersChanged`) |
| Reject model-dependent activation on unverified specs | `eligibility.ts` |
| Per-market eligibility and readiness checks | `eligibility.ts` |

"Discover current and upcoming crypto markets" is deliberately NOT here: discovery
is I/O, owned by the adapters (`WP-070`) and the gateway (`WP-120`). This package
is the pure registry those components feed.

## 2. Immutability

A `UniverseRegistry` value is immutable, and so is a `MarketParameterHistory`.
Every operation returns a NEW value; the input keeps object identity for
everything it already held. That is what makes acceptance 4 — "parameter changes
create immutable history" — a structural property rather than a convention:

- appending a version returns a new history whose earlier entries are the SAME
  frozen objects (asserted by identity, not just equality);
- every version, its snapshot, and its `changedParameters` array are frozen, so
  an in-place edit throws a `TypeError` under ES modules' strict mode;
- a change that changes nothing is REFUSED, so a version number always means
  "the parameters differ from the previous version";
- an observation older than the version it would follow is REFUSED, because
  `parametersAsOf` — the function that makes "historical runs use historical
  parameters" (§6 invariant 9) true — depends on the ordering.

## 3. Series binding is configuration (§9.2)

> Series binding is configuration, not heuristic-only. The system may suggest a
> series match, but a new market pattern is not auto-approved for live trading.

A suggestion and an approval are DIFFERENT TYPES, not one type with a confidence
score. `suggestSeriesBindings` returns an explained shortlist and nothing else;
`approvedSeriesBinding` demands an approver and an instant; there is no function
that promotes one to the other. `bindMarketToSeries` additionally requires the
SERIES' own binding to have been approved, so the unreviewed decision cannot be
pushed one level down. A market whose binding is merely `SUGGESTED` is refused
model-dependent activation exactly as an unbound one is.

The emitted `MarketDiscovered` payload names a series (the §7.4 field carries the
series KEY, not the catalog UUID) only when the binding is approved.

## 4. Lifecycle projection

The projection folds the frozen §7.4 events. Four rules shape it:

1. **Only `MarketResolved` sets a terminal outcome.** `recordObservedOutcomeState`
   — the operator path — refuses every terminal state.
2. **`DISPUTED` is non-terminal and has no event.** WP-110's venue re-check
   (2026-08-28, `https://docs.polymarket.com/concepts/resolution`) found a
   documented dispute PROCESS (proposal, 2-hour challenge period, DVM vote) but
   no documented dispute transition or status vocabulary this repository could
   parse, so ADR-009 §4's condition for adding a `MarketDisputed` event is not
   met. A dispute enters as an operator observation.
3. **A post-open clarification is a first-class transition.** Verified
   2026-08-28: "In rare cases, unforeseen circumstances require clarification of
   the rules after trading begins. Polymarket may issue an 'Additional context'
   update…" published "onchain via the bulletin board contract". The projection
   records whether each clarification arrived after open and moves an unresolved
   market to `PENDING_CLARIFICATION`, which blocks activation until a human
   re-reviews. A post-resolution clarification is recorded and does NOT
   un-resolve the market.
4. **An open instant is a fact; a close instant is a schedule.** A second
   `MarketOpened` with a different instant is refused; a `MarketClosing` that
   moves the close is applied, because §9.2 versions `close_time`.

**`CLOSED` is derived, never stored.** The frozen contracts carry `MarketClosing`
and `MarketResolved` and nothing asserting "the trading window has now ended", so
`effectiveLifecycleState(projection, asOf)` computes it from the announced close
instant and the caller's instant. Inventing a `MarketClosed` event would be a
contract change this package may not make; the gap is reported in
`docs/handoffs/WP-110.md`.

Ordering uses `gatewayEpoch + ingestSeq` (§7.1): an event that does not advance
the sequence WITHIN an epoch is refused as a replay, while a new epoch (a gateway
restart) is not a regression.

## 5. The settlement port

`packages/universe` and `packages/settlement` are the same layer, and
`docs/contracts/dependency-direction.md` §2.1 — the exhaustive list of permitted
same-layer edges — has no row for either direction. Neither imports the other.
`settlement-binding.ts` declares the minimal structural shape of the settlement
layer's verdict; the composition root wires the two, and a divergence between the
two status unions is a type error at that wiring site.

The verdict is not taken on faith: `evaluateMarketReadiness` refuses a verdict
whose status and permission flag disagree, and independently refuses activation
when the reviewed spec's rules version is not the version the market is trading
under (§6 invariant 9).

## 6. Readiness: two answers, not one

`observationReady` says whether consuming this market's data is meaningful;
`modelDependentActivationAllowed` says whether a strategy whose PnL depends on a
payoff model may run. They differ deliberately: watching an unreviewed market is
harmless and is how it gets reviewed, while trading it on an unverified payoff
model produces confident, wrong PnL.

Thresholds belong to the caller. `minimumSecondsToClose` is applied only when
supplied, because §13.2 puts entry and exit cutoffs in strategy configuration and
a default here would silently override it. When it IS supplied and no close
instant exists, the check refuses rather than skipping.

## 7. Purity

No I/O, no clock, no randomness, no mutable global state. `Date.parse` is used
only to parse strings the CALLER supplied (`time.ts`); `Date.now()` and
`new Date()` appear nowhere. The one filesystem read in the package is
`seeds.test.ts`, a test.
