# Replay-golden fixture — Static Bracket through the shipped replay root (BACKTEST-1)

Consumed by `test/unit/simulation/backtest-static-bracket-replay.test.ts`
(support: `test/unit/simulation/backtest-replay-support.ts`), which
`pnpm test:replay` runs. Handoff §7 checklist item 4: "Static Bracket runs in
replay **and** live-data paper mode through the same code" — this fixture is
the evidence for the REPLAY half, which did not exist at `1aa2238`
(GOV-2B **B3**: `coreLoop` was declared and passed through, never supplied).

## What it is

A synthetic `WP-130` dataset (`dataset-manifest.json` + one real Parquet
object, `part-00000.parquet`, written by `@polymarket-bot/storage-parquet`'s
own writer) whose eight recorded frames are a recording of the **normalized
§7.4 stream** the paper core consumes, plus the run-scoped inputs a replay of
it needs:

| File | What it is |
| --- | --- |
| `frames.json` | the eight recorded frames, readable: provenance per frame, and the `{eventType, schemaVersion, sourceChannel, payload}` the gateway added to each raw frame. **The source of truth**; the test re-derives the Parquet object from it and pins the committed bytes. |
| `part-00000.parquet` | the archived object, `hyparquet-writer` `UNCOMPRESSED`, deterministic (written twice at generation, byte-equal) |
| `dataset-manifest.json` | `polymarket-bot/dataset-manifest/v1`, `WP-130`'s shape; `objects[0].sha256` / `byteLength` are the real digests of the committed object, so the loader re-derives and refuses a mismatch; `replayPins.normalizerVersion` is pinned to `backtest-cli/normalized-envelope/v1` because the dataset knows what it recorded |
| `run-pins.json` | the complete §12.5 run-scoped pin set the shipped CLI's `--pins` reads |
| `trader-config.json` | the operator document `apps/trader`'s `createPaperTrader` parses — the shared core's configuration |
| `expected-artifact.txt` | the `polymarket-bot/backtest-static-bracket-replay/v1` artefact, compared **byte for byte** |

## Provenance

**No live venue connection was made, by this round or for this fixture.**
Every value is synthetic and declared here, or repository-assigned by design
(§7.1, §7.2: `gatewayEpoch`, `ingestSeq`, `receivedAt`, `receivedMonotonicNs`,
`connectionId`, `subscriptionGeneration`, `segmentId`, `datasetId`,
`objectKey`, every row ordinal). The `segmentSha256` / `segmentFileSha256`
digests are real SHA-256 values over the declared literal strings
`"backtest1-segment-span"` / `"backtest1-segment-file"` (no WAL segment
exists; `walSegments=NOT_AVAILABLE_ARCHIVED_ONLY` says so in the artefact).
The `frameLine*` fields are the byte accounting of `JSON.stringify(record) +
"\n"`, so they are checkable rather than random. `payloadSha256` and the
object's `sha256` / `byteLength` are real digests of the fixture's own bytes.

The **scenario** — the book, the sizes, the prices, the fee schedule, the
strategy parameters — is `test/e2e/support/scenario.ts`'s (`WP-250`, as
`RISK-2` left it), reproduced with this fixture's own identities. That is
deliberate: `RISK-2` derived every economic number of that scenario by hand
and its golden is a capture of the paper core driven by the e2e harness. This
fixture drives the **same core** through the **shipped replay root** over a
**recorded dataset** and reaches the same numbers, which is what "through the
same code" means when it is measured rather than claimed.

## Why the frames are normalized envelopes and not raw venue frames

`apps/backtest-cli` already ships the real `@polymarket-bot/polymarket-public`
market-channel normalizer for raw `book` / `price_change` /
`last_trade_price` frames (`polymarketMarketNormalizer`, covered by
`test/replay-golden/simulation/`). It cannot drive this round trip alone: two
of the events Static Bracket needs — `MarketOpened` (without it the market is
`PENDING`, the risk engine reads `UNKNOWN`, and every entry fails closed) and
`MarketClosing` (the exit cutoff) — have **no raw-frame origin on any venue
channel and no producer anywhere in this repository** (the only non-test
references are `apps/trader`'s consumer and `packages/universe`'s fold). The
reference trades likewise come from a different venue adapter. So the
recording is of the stream the core consumes — handoff §8.4, verbatim: "Replay
consumes the same normalized event envelopes in the exact recorded dispatch
order" — and `normalizedEnvelopeNormalizer` validates every recorded envelope
against its frozen `packages/domain` contract, through a prototype-free arena
copy, before delivery. A raw-frame fixture through the venue normalizer, once a
lifecycle producer exists, is a follow-up, not a substitute.

## The recorded events, in dispatch order

| ordinal | `ingestSeq` | event | `receivedAt` | why it is there |
| --- | --- | --- | --- | --- |
| 0 | 1 | `ReferenceTradeObserved` binance BTCUSDT `64000 × 0.5` | `08:59:58Z` | §9.8 check on `REFERENCE_FEED` freshness fails closed on an ABSENT feed |
| 1 | 2 | `ReferenceTradeObserved` binance BTCUSDT `64100 × 0.25` | `08:59:59Z` | a second print, so the feature engine's reference window is non-trivial |
| 2 | 3 | `MarketOpened` | `09:00:00Z` | `PENDING → OPEN`; the strategy's `onMarketOpen` |
| 3 | 4 | `BookSnapshot` YES: bids `0.32×200, 0.31×300`; asks `0.34×30, 0.35×40` | `09:00:01Z` | the strategy ARMS |
| 4 | 5 | `BookSnapshot` NO: bid `0.65×200`, ask `0.66×200` | `09:00:02Z` | the strategy ENTERS (executable buy for 50 = `17.2/50 = 0.344 ≤ 0.35`) |
| 5 | 6 | `BookLevelChanged` YES BID `0.31 → 250` | `09:00:03Z` | an evaluation that changes nothing economic |
| 6 | 7 | `BookSnapshot` YES: bids as before; asks `0.36×40` | `09:14:49Z` | refreshes the book inside the exit cutoff so `on_stale_book` does not mask the `PROTECTED_REDUCE` path; the strategy REDUCES |
| 7 | 8 | `MarketClosing` `closesAt 09:15:00Z` | `09:14:50Z` | the cutoff callback, delivered to a CLOSED instance (its reentry limit of 1 answers it) |

`receivedMonotonicNs` is `ordinal × 1 000 000`; the replay clock advances
only on these values and the wall clock never regresses
(`wallClockRegressions=0`).

## What the run produces, derived by hand

- **Entry** (`seq=1`, `enter`): 50 shares walk both ask levels — `30 @ 0.34`
  and `20 @ 0.35`, two fills, cost `10.2 + 7 = 17.2`. Fees at taker `0.0195`,
  HALF_UP to 3 places: `30 × 0.0195 × 0.34 × 0.66 = 0.131274 → 0.131` and
  `20 × 0.0195 × 0.35 × 0.65 = 0.088725 → 0.089`.
- **Take-profit** (`seq=2`, `exit`): a `MAKER_ONLY` post-only REST sell of the
  first fill's 30 shares at `0.5`, later **cancelled** by the strategy's own
  safety cancel (`seq=6`) when the second fill arrives and the exit is
  re-sized. It never fills — `RISK-2` residual `RISK2-R6`, unchanged: the
  repository still has no evidence a take-profit can FILL.
- **Cutoff reduce** (`seq=8`, `reduce`, `SB.FINAL_PROTECTED_REDUCE`): sells
  all 50 into the `0.32` bid at limit `0.3`; fee `50 × 0.0195 × 0.32 × 0.68 =
  0.2121 → 0.212`.
- **Realized**: `16 − 17.2 = −1.2`; fees `0.131 + 0.089 + 0.212 = 0.432`;
  `coreNetPnl −1.632` = the one remaining ledger line (`pUSD`, `COLLATERAL`,
  `−1.632`); `capitalCommitted 0`; no `OUTCOME_TOKEN` position remains.
- **Risk**: 4 evaluations, 4 approvals, 0 refusals, 0 refused exits —
  `RISK-2`'s B2 fix, observed through the replay root.
- **Counts**: 12 decisions persisted (one per callback), 4 plans, 4 accepted
  submissions, 3 fills, 1 cancel confirmed, 9 ledger transactions, 12 PnL
  records, 3 PnL snapshots; `halts=[]`, `healthy=true`. (18 decisions before
  `TRDR-4` — see "How `expected-artifact.txt` was produced" below.)

## Residual 5 (`docs/handoffs/RISK-2.md`) — observed here, pinned, and RESOLVED by `BRACKET-1a`

**What `BACKTEST-1` recorded.** `seq=9` (`onFill`, the reduction's own fill):
`SB.UNATTRIBUTED_FILL → SB.POSITION_MISMATCH → SB.NO_BLIND_FLATTEN →
SB.PAUSED`; `seq=11` (`onMarketClosing`): `SB.RESUMED, …, SB.PAUSED` again. The
pause was the strategy's own state — the runtime's `instanceStatus()` stayed
`ACTIVE` — and the ledger was clean. Reported, not fixed: `packages/strategies/**`
was outside `BACKTEST-1`'s grant.

**What the run shows now.** `BRACKET-1a` gave the protective reduction its own
order track, so through this replay root too `seq=9` reads `SB.EXIT_FILLED,
SB.CLOSED` (the fill folds into the reduction's track and the bracket closes)
and `seq=11` reads `SB.REFUSED_MAXIMUM_ENTRIES` (the closed bracket answers the
fixture's reentry limit of 1, which `planRearm` checks before the cool-down).
Nothing pauses; `instanceStatus()` is still `ACTIVE`; the ledger is still clean
(`unattributedActivity 0`, `unexplainedMovements 0`). This fixture still cannot
show a SECOND bracket — its limit is 1, and a cutoff reduction is always after
the entry cutoff — so it does not close §7 checklist item 1 on its own either.

## How `expected-artifact.txt` was produced

**Captured**, not derived by hand: it is `renderArtifact` over one run of the
suite's own `replayThroughShippedRoot({ withCore: true })`, written once by a
scratch probe (not committed) and confirmed byte-equal to a second run before
it was committed. Its economic lines are checkable against the derivations
above; its identifiers are deterministic functions of the fixture
(`eventId` from `deriveReplayEventId` over the recorded identity; every core
id from `DeterministicIdFactory` under the namespace
`backtest-1-static-bracket-replay`; every `snapshot=` a `packages/features`
content address). If a change moves these bytes, re-derive the economics the
same way and re-capture; do not paste an output whose numbers you have not
checked.

**Re-captured by `TRDR-4` (2026-09-26), the same way** (a scratch probe calling
`renderArtifact(await replayThroughShippedRoot({ withCore: true }))` twice,
byte-equal, written once), because the user's ruling R1 changed the core
loop's delivery rule: a TERMINAL order's view is delivered through
`onOrderUpdate` until one delivery has been EVALUATED, and then the order is
retired — it is no longer re-delivered on every later harvest. The six
decisions that were those re-deliveries (old `seq=7, 11, 12, 15, 16, 17`, every
one an `onOrderUpdate` `hold` with reason `SB.IDLE` and no intent) are gone;
the later decisions renumber (the reduce `9 → 8`, its fill's `onFill` `10 → 9`,
the reduce order's own terminal view `13 → 10`, `onMarketClosing` `14 → 11`),
and so do the reduce trace's `evaluationSeq`, the health line's `evaluations`
and `decisionsPersisted` and the store line's `decisions` and `checkpoints`
(`18 → 12`). Every order, fill, economics, ledger and PnL line is
byte-identical — proven line by line, with the removed decisions identified
by the order each delivered, in the round's handoff.

**Re-captured by `BRACKET-1a` (2026-09-28), the same way** (a scratch probe
calling `renderArtifact(await replayThroughShippedRoot({ withCore: true }))`
twice, byte-equal, written ONCE over the restored base bytes), because the
strategy's protective reduction now has an order track. Exactly two lines
moved — line 28 (`seq=9`, `reasons=SB.EXIT_FILLED,SB.CLOSED`) and line 30
(`seq=11`, `reasons=SB.REFUSED_MAXIMUM_ENTRIES`); see "Residual 5" above for
why. Every order, fill, economics, trace, ledger, PnL, health, store and
driver line is byte-identical (`store decisions=12` included): the same
decisions exist, only two of them now say something else.

## Relationship to the other goldens

`test/replay-golden/simulation/` (`WP-210`) pins the replay driver and the
Tier-1 venue with **no core loop**; `test/replay-golden/paper-e2e/` (`WP-250`)
pins the paper core driven by the **e2e harness**, not by the replay root.
This fixture is the third artefact of the same kind over the composition the
first two bracket: the shipped replay root **and** the shipped core, in one
run.

## What this fixture does NOT show

The CLI executable (`backtest-cli verify`) still runs the verification-only
normalizer with no core: `apps/backtest-cli` cannot construct
`createPaperTrader` because `docs/contracts/dependency-direction.md` §2 rules
that nothing may depend on an app. The composition is assembled in the test's
support module, which is the one place that may hold both apps; moving the
core below layer 3 so the binary can do it itself is the follow-up the
`BACKTEST-1` round records in its handoff.
