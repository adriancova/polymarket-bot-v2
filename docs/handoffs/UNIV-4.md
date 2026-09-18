# UNIV-4 — the market lifecycle producer (GOV-2B closeout blocker B10)

Branch `univ-4`, rebased onto `main` `da9c58e` (VENUE-2 `d6aedee` + TRDR-3
`da9c58e` on the original base `df1b346`). Linear chain:

| Commit | Content |
| --- | --- |
| `f687513` | the reproduction at base: the published stream never carries `MarketOpened` / `MarketClosing`; the documented polled surface is never consulted (data-gateway integration 12 / 59 at the original base). **It does not flip** (r1 LOW-1): the feed is opt-in and that test never configured `lifecycle`, so its absence assertions pass against the tip too; it was REWRITTEN into the round's test file, whose first test is the real pin (19 of the round's 20 tests fail with the wiring reverted), and the absence it measured is now announced at start as `GATEWAY_LIFECYCLE_FEED_ABSENT` |
| `bc7871d` | the round: `packages/polymarket-public/src/market-state/`, the gateway's `lifecycle` feed, its ledger, its configuration door, the contract fixture and tests, acceptance (a)/(b)/(d) |
| `615cabb` | part (c): the trader opens a market from the gateway's REAL `MarketOpened`, over Redis (Testcontainers) and in memory |
| `6788e26` | this handoff |
| `acc122a` | the ledger record built as its own type (a forbidden `as unknown as` removed; behaviour unchanged) |
| `7564db6` | this file's commit-SHA table updated — the commit the adversarial review examined |
| `9e9f154` | **r1**: intent-before-dispatch / confirmation-after-publication in the ledger, replay of unconfirmed intents by the next epoch, the ledger write-failure pin, LOW-1…LOW-6, the MEDIUM-2 disclosure |
| `29b2e9d` | the r1 handoff — the commit the confirming review examined (ACCEPT on HIGH-1; one new MEDIUM on the replay path) |
| `5109a88` | **r2**: the replay stops at the first event that does not land and a fresh closing is held back behind an unconfirmed earlier event (MEDIUM-R1); every ledger instant validated at load (MEDIUM-R1); the unpublished incident names every owed intent (LOW-R1); wording (LOW-R2); the RESOLVED regression named (LOW-R3) |
| the r2 tip | this file, updated for r2 |

## summary

`MarketOpened` / `MarketClosing` were produced nowhere; a live-data paper
run could never leave `PENDING`. The venue pushes no open/close signal
(`docs/venue/verified-2026-09-16.md` D-30, U-12); it documents a polled
surface, `GET https://gamma-api.polymarket.com/markets/{id}`, with the
readiness predicate `active && !closed && acceptingOrders`. This round:

1. **`packages/polymarket-public/src/market-state/`** — a door over the
   documented `Market` shape: the six documented fields typed `boolean | null`
   (`gameStartTime`: `string | null`), an ABSENT field admitted as `null`,
   every other top-level scalar recorded as the venue spelled it and never
   interpreted, unknown top-level keys admitted (the venue adds properties
   between releases, D-19); a fail-closed readiness predicate (`null` in any
   of the three is not ready — stricter than the literal JavaScript snippet on
   `closed: null`, pinned); a two-layer fetcher (`requestGammaMarket` returns
   the raw response so a recorder can journal before judging;
   `fetchGammaMarket` is the loud `snapshot/fetcher.ts`-style whole read).
   Exported from the barrel and as the `./market-state` subpath. The door is
   hand-written, with no `zod` schema — argued in its header and below.
2. **The gateway's `lifecycle` feed** (`apps/data-gateway/src/feeds/market-lifecycle.ts`):
   polls every configured market at a budgeted cadence, journals every
   response body to the WAL BEFORE deriving anything, derives the two events
   by six argued rules (R1–R6, quoted below), and publishes them through the
   same dispatcher, sequencer and publisher as every other feed, with a
   `causationId` naming the journaled response. Poll failures open
   market-scoped incidents (`affectedMarketIds`) and derive nothing; N
   consecutive failures publish `FeedStale` and open `GATEWAY_FEED_STALL`; a
   WAL refusal suppresses the derivation with a PAGE incident; overlapping
   cycles are skipped and counted, never stacked.
3. **The lifecycle ledger** (`apps/data-gateway/src/lifecycle-ledger.ts`):
   `<walRoot>/market-lifecycle-ledger.json`, written through the same
   `WalFileSystem` port as the journal (temp + fsync + rename), encoded by the
   own-data encoder, read back as own data at start; an unreadable ledger
   fails the start. It is what makes `openedAt` stable across restarts when
   the instant is the first observation.
4. **Configuration**: `lifecycle { feedId, baseUrl?, pollIntervalMs,
   consecutiveFailureThreshold }` on `GatewayConfigSchema`; `gammaMarketId`
   (optional) on `MarketConfigSchema`, REQUIRED by the door when the feed is
   configured; the door refuses a cadence under 1 s, a configured set over
   the request budget (arithmetic in the message), a missing `gammaMarketId`,
   and an `openTime` / `closeTime` that is not an ISO-8601 instant.
5. **Part (c)** (after TRDR-3): the REAL gateway composition with the REAL
   `RedisStreamsEventTransport` publishes the lifecycle feed's `MarketOpened`
   (from a venue-shaped stub response) onto a Redis stream; the REAL trader
   composition root (`assembleDurableTrader`, Testcontainers PostgreSQL,
   registered through the `WP-040` repositories) consumes it through the
   process's own `RedisMarketEventFeed` and `pump`, leaves `PENDING`, and
   admits an entry that lands in `strategy.decisions`. An in-memory sibling
   proves the same claim without Docker.
6. **r1 (`9e9f154`), the review's HIGH-1**: the first round wrote the ledger
   ONCE, after a fire-and-forget dispatch — so a publication halt (including
   the gateway's designed recording-only startup mode, `run.ts`) sealed an
   instant nobody received, and every later epoch, seeding its phase from the
   ledger, skipped the market forever (the reviewer's reproduction: 0
   `MarketOpened` in both epochs, 0 lifecycle incidents in the second). Now
   every event goes through one path (`#emit`): the chosen instant is
   persisted as an INTENT before dispatch; the dispatch outcome is AWAITED;
   `published: true` writes the CONFIRMATION; `published: false` opens a
   PAGE incident (`GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED`) and leaves the intent
   unconfirmed. At the next start an unconfirmed intent is RE-EMITTED with
   the persisted instant on the market's first successful poll (citing that
   epoch's journaled response), in lifecycle order, never past a confirmed
   later event (an unconfirmed OPEN is not replayed past a confirmed CLOSING —
   the one regression the trader's unguarded `markLifecycle` cannot absorb);
   a terminal market with an unconfirmed closing is polled every interval
   until that closing is CONFIRMED (LOW-R2's wording; budget-bounded — one
   request per interval). The ledger rolls its in-memory record back when a
   write fails, so the feed never acts on an intent that did not land. The design
   closes both windows: a halt (intent persisted, unconfirmed → replayed)
   and a crash between dispatch and write (intent persisted first → the same
   instant is reused; the fold sees an idempotent replay). Plus MEDIUM-1
   (the ledger-write-failure PAGE pinned: intent first, so NO event is
   dispatched and the next poll re-derives), MEDIUM-2 (disclosure: a
   mis-pointed `gammaMarketId` opens this market on another's readiness,
   silently — D-30 licenses no interpretation of the response's
   `conditionId`), LOW-1 (`GATEWAY_LIFECYCLE_FEED_ABSENT` at start; the base
   pin's story corrected), LOW-2 (R2 refined below), LOW-3 (a response after
   `stop()` is journaled, counted, not derived), LOW-4 (the `MAX_WIRE_DEPTH`
   16 refusal disclosed), LOW-5 (records carry `conditionId` +
   `gammaMarketId`; a pair mismatch refuses the start; a CONTRADICTED record
   raises its incident every start; a foreign record is named and carried),
   LOW-6 (R6 names the null field).
7. **r2, the confirming review's MEDIUM-R1** — `#replay` continued past a
   failed intent write or an unpublished earlier event, so a LATER event
   could publish first and the guard (correctly) sealed the open out forever
   (the reviewer's probe N5: a one-shot `EIO` on the opened replay's put →
   stream `["MarketClosing"]`, `openedAt` never confirmable again). Now (1)
   the replay STOPS at the first event that is not confirmed — after a halt
   nothing later could publish anyway; after a non-halting rejection a
   later event must not overtake — and a replay whose intent write failed
   stays owed, so the next poll retries it; (2) the same rule governs a
   FRESH derivation: a closing derived while anything earlier is still owed
   (`owedReplays` of the current record non-empty) has its intent persisted
   and is NOT dispatched (`eventsHeldBack`); the next epoch replays it in
   order — and, because the rule is `owedReplays`, a closing behind an open
   the guard will never replay (a confirmed closing already exists) still
   goes out; (3) every ledger instant is validated with the frozen
   `IsoTimestampSchema` at LOAD, so a corrupt instant refuses the start
   (typed, naming the field) instead of reaching the publisher as a
   non-halting rejection. LOW-R1: `GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED` is
   raised once at the END of a poll that left anything unpublished or held
   back, its detail listing EVERY unconfirmed intent the ledger holds for
   the market (kind + instant) plus the publisher's last reason; when a
   later poll leaves a grown set, the standing incident is closed and a
   fresh one names the whole set. LOW-R2: wording fixed here and in the
   header. LOW-R3: named under known_risks 2(a) and follow_up 4.

### The derivation rules (the module header's text, condensed)

- **R1** `MarketOpened` once per configured market, when the documented
  predicate is observed TRUE at poll time — never from configuration alone,
  never for an unconfigured market; `restricted` recorded, not acted on.
- **R2** `openedAt` stable across restarts, and honest (r1): the configured
  `openTime` when present, already past at the observation, AND no NOT-ready
  poll was journaled for the market at or after it (LOW-2 — a market the
  venue reported not ready after `openTime` demonstrably did not open then;
  the ledger records the first such observation, `notReadyAfterOpenTimeAt`,
  so a restart mid-wait keeps the history); otherwise the first ready
  observation's receipt instant. BOTH branches are persisted as an intent
  BEFORE dispatch, so a restart re-reads the instant whether the first
  emission was published, halted, or lost to a crash between dispatch and
  confirmation. Venue ready BEFORE the configured `openTime` → the
  observation instant (the venue's state wins over the schedule). On restart
  a CONFIRMED open is not re-announced (the trader's `markLifecycle` is
  unguarded, so a replay after a `MarketClosing` would regress it to OPEN);
  an UNCONFIRMED open is re-emitted with the persisted instant (the fold
  accepts a same-instant replay as idempotent).
- **R3** the scheduled `MarketClosing` (`closesAt = closeTime`) is emitted by
  the first poll at or past `closeTime` while OPEN — **not at the open**. The
  packet's wording ("emitted from the configured `closeTime` … once the
  market is OPEN") was first implemented as "immediately after the open";
  the staged part (c) test then failed: the trader maps CLOSING to §9.8
  `CLOSE_ONLY` (`apps/trader/src/pipeline.ts` `marketStatusOf`) and the risk
  engine refuses every entry on it (`RISK_MARKET_CLOSE_ONLY`), so announcing
  the close at the open reproduces the B10 symptom by another route. The
  frozen contract defines `MarketClosing` as the record that the transition
  "has actually been observed"; the strategy's own cutoffs read the reviewed
  `closeTime` from configuration (`observation.market.closeTimeMs`), so
  nothing is lost by waiting; `secondsRemaining` is then 0, the end-of-market
  policy's trigger. A market first observed ready after `closeTime` gets
  both events on the same poll, open first. No `closeTime` → no scheduled
  closing.
- **R4** re-emitted with `closesAt` = the poll's receipt instant when a poll
  shows `closed === true` or `acceptingOrders === false` while OPEN (the
  reschedule the fold accepts); not the venue's `closedTime` (no documented
  semantics; a poll is not an observed event). Terminal for this feed.
- **R5** `closed`/`archived` observed before ever OPEN → nothing derived,
  `GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED` (NOTIFY), not polled again.
- **R6** readiness lost while OPEN through `active`/`archived` alone →
  nothing derived, `GATEWAY_LIFECYCLE_STATE_UNEXPECTED` (NOTIFY).

**Ordering guarantee.** The sequencer and publisher are shared, so every
lifecycle envelope is totally ordered with the market-data feed's by
`(gatewayEpoch, ingestSeq)`; but the two feeds are independent producers, so
a consumer may NOT assume `MarketOpened` precedes the first `BookSnapshot`
(the WebSocket delivers the book on subscription; the poll's answer follows an
HTTP round trip) and must hold a book for a PENDING market — which §9.8's
`PENDING → UNKNOWN` already requires. It MAY assume: per market,
`MarketOpened` precedes every `MarketClosing`; a scheduled closing precedes
an observed one when both exist; at most one of each, ever, across restarts;
every lifecycle envelope's `causationId` names a journaled raw response with
a strictly lower `ingestSeq`.

**Rate-limit arithmetic (acceptance (d)).** The venue's documented Gamma
`/markets` limit is 300 requests / 10 s (general 4,000 / 10 s; §8, S-D24;
`rate-limits.json` `gamma_markets`). The STRICTER figure is budgeted against
because `GET /markets/{id}` is under `/markets` and the report does not say
the per-endpoint figure excludes it. The feed may use 5 %: 15 requests /
10 s. The door refuses `N × 10 000 / pollIntervalMs > 15`: at the default
10 s cadence 15 markets, at 60 s 90, at the 1 s floor exactly one. Pinned in
`apps/data-gateway/src/config.test.ts` with the message's arithmetic.

**Why the door has no `zod` schema.** The contract suite's SDK-anchor guard
requires every EXPORTED object schema to be anchored to the official SDK at
the pinned commit with a field count read from its source; D-30 records the
SDK parsing seven state fields, not `restricted` or `gameStartTime`, so an
honest anchor could not be written. Independently, `zod@4.4.3`'s `ZodError`
constructor runs `JSON.stringify` over its issues — measured here: under an
inherited `toJSON` the hook ran once per refusal — which the six-context
battery then had to tolerate as "refusal composition". A six-field door
re-stated in full on its own reads has no library to defeat; the documented
types live once in `GAMMA_MARKET_DOCUMENTED_FIELDS` and the contract suite
reads that table. D1/D3/D4 performed; D2 not applicable (no library parse).

## files_changed

Round (`bc7871d`):

- `packages/polymarket-public/src/market-state/door.ts`, `fetcher.ts`, `index.ts` (new)
- `packages/polymarket-public/src/errors.ts` (two codes and two classes: `PUBLIC_MARKET_STATE_UNAVAILABLE`, `PUBLIC_MARKET_STATE_INVALID`)
- `packages/polymarket-public/src/index.ts` (barrel export), `package.json` (`./market-state` subpath)
- `apps/data-gateway/src/config.ts` (`LifecycleFeedConfigSchema`, `gammaMarketId`, the door checks, the budget constants), `config.test.ts` (+17)
- `apps/data-gateway/src/feeds/market-lifecycle.ts` (new), `lifecycle-ledger.ts` (new), `lifecycle-ledger.test.ts` (new, 15)
- `apps/data-gateway/src/gateway.ts` (ledger open in `create()`, feed build/start/stop/settle/metrics), `index.ts` (exports)
- `infra/compose/data-gateway/gateway.config.example.json` (the `lifecycle` block, `gammaMarketId`, `openTime`/`closeTime`), `README.md` (the configuration note)
- `test/contract/polymarket-public/fixtures/gamma-market-by-id.json` (new), `gamma-market-state.test.ts` (new, 54)
- `test/integration/data-gateway/univ-4-market-lifecycle.test.ts` (the pin, flipped; 20 tests)

r1 (`9e9f154`):

- `apps/data-gateway/src/feeds/market-lifecycle.ts` (the `#emit` path: intent → awaited dispatch → confirmation / PAGE; `#replay`; `owedReplays`; the LOW-5 start checks; LOW-2/LOW-3/LOW-6; the MEDIUM-2 and HIGH-1 header sections)
- `apps/data-gateway/src/lifecycle-ledger.ts` (`conditionId`, `gammaMarketId`, `notReadyAfterOpenTimeAt`, the three `*ConfirmedAt` fields; confirmation-without-intent refused; rollback on a failed write), `lifecycle-ledger.test.ts` (+4)
- `apps/data-gateway/src/gateway.ts` (`GATEWAY_LIFECYCLE_FEED_ABSENT` at `start()`)
- `packages/polymarket-public/src/market-state/door.ts` (header only: the LOW-4 disclosure)
- `test/integration/data-gateway/support/faulty-file-system.ts` (`failWholeFileWrites` / `healWholeFileWrites`), `univ-4-market-lifecycle.test.ts` (20 → 32 tests; the header's pin story corrected)
- `infra/compose/data-gateway/README.md` (the ledger's intents/confirmations and incidents; the `gammaMarketId` obligation; the feed-absent incident)

r2:

- `apps/data-gateway/src/feeds/market-lifecycle.ts` (`#replay` returns whether every owed event landed and stops at the first that did not, re-owing a replay whose intent write failed; `#emitBehind` — the hold-back rule from `owedReplays`; `#reportUnpublished` / `#unconfirmedIntents` — the end-of-poll incident naming every owed intent; metrics `lastUnpublishedReason`, `eventsHeldBack`; header sections)
- `apps/data-gateway/src/lifecycle-ledger.ts` (`INSTANT_KEYS` validated with `IsoTimestampSchema` at load), `lifecycle-ledger.test.ts` (+4)
- `test/integration/data-gateway/univ-4-market-lifecycle.test.ts` (32 → 36 tests)

Part (c) (`615cabb`):

- `test/integration/paper-trader/univ-4-gateway-opens-trader-redis.test.ts` (new, 2), `univ-4-gateway-opens-trader.test.ts` (new, 2)
- `test/integration/paper-trader/vitest.config.ts` (nine alias rows; the dated Docker-file correction), `tsconfig.json` (the matching `paths`)

Not touched: `packages/domain/**`, `packages/universe/**`, `apps/trader/src/**`, `db/**`, `docs/adr/**`, `docs/spec/**`, `docs/venue/**`, `IMPLEMENTATION_STATUS.md`, root `package.json`, `tsconfig.base.json`, `eslint.config.mjs`, `docker-compose.yml`, `pnpm-lock.yaml` (no dependency added), `test/fixtures/venue/**`, `test/e2e/**`.

## tests_run

Gates (baseline: `main` `da9c58e` after TRDR-3; the reviewed tips
`7564db6` (r0) and `29b2e9d` (r1) in the middle columns; the r2 tip last):

| Gate | Baseline | `7564db6` | `29b2e9d` | r2 tip |
| --- | --- | --- | --- | --- |
| `pnpm run typecheck` | 0 | 0 | 0 | 0 |
| `pnpm run lint` | 0 | 0 | 0 | 0 |
| `pnpm run check:deps` | 34 packages / 80 edges | 34 / 80 | 34 / 80 | 34 / 80 (no new edge) |
| `pnpm run test` | 330 files / 7177 | 331 / 7209 | 331 / 7213 | **331 / 7217** (+4: three malformed-instant refusals, the named-field pin) |
| `pnpm test:contract` | 583 / 65 / 158 / 95 | 637 / 65 / 158 / 95 | 637 / 65 / 158 / 95 | 637 / 65 / 158 / 95 |
| data-gateway integration | 11 / 58 | 12 / 78 | 12 / 90 | **12 / 94** (+4: MEDIUM-R1 (a) and (b), the held-back closing + LOW-R1 one-incident pin, the grown-incident pin) |
| trader integration | 12 / 125 | 14 / 129 | 14 / 129 | 14 / 129 |
| control-api integration | 10 / 85 | 10 / 85 | 10 / 85 | 10 / 85 |
| `pnpm test:e2e` | 6 / 78 | 6 / 78 | 6 / 78 | 6 / 78 |
| `pnpm run test:replay` | 3 / 17 | 3 / 17 | 3 / 17 | 3 / 17 |

The reproduction at the original base `df1b346`: 12 files / 59 tests, the
pin passing on the absence (`f687513`, then rebased).

**Non-vacuity table** — each mutation applied to the shipped source, the
lifecycle integration file run, the source restored (the runner is outside
the tree; every mutation killed):

| Mutation (r2 table; every one killed against the r2 code) | Failing pins |
| --- | --- |
| ledger read removed (`options.ledger.get` → `undefined`) | 13 |
| **HIGH-1: seal on dispatch** — an unpublished outcome treated as confirmed | 4: recording-only startup, mid-run halt, the LOW-R1 pin, the grown-incident pin |
| **HIGH-1: replay removed** (`owedReplays` → `[]`) | 7 |
| **HIGH-1: an unconfirmed OPEN replayed past a confirmed CLOSING** | 4: the guard, and (because `owedReplays` is now also the hold-back rule) the three r2 ordering pins |
| **HIGH-1 / MEDIUM-1: intent after dispatch** (`void this.#persist(intent)`, not awaited) | 2: the write-failure pin, MEDIUM-R1 (a) |
| **MEDIUM-1: write failure not held back** (`await persist` without honouring `false`) | 2: the write-failure pin, MEDIUM-R1 (a) |
| **MEDIUM-R1: the replay continues past a failure** (the `break`/`return false` removed) | 1: (a) — the closing overtakes the open |
| **MEDIUM-R1: the instant validation at load removed** | 1: (b) — the malformed `openedAt` reaches the publisher |
| **MEDIUM-R1: the hold-back removed** (a fresh closing dispatched behind an unconfirmed open) | 2: the LOW-R1 pin, the grown-incident pin |
| **LOW-R1: the incident re-raise on a grown set removed** | 1: the grown-incident pin |
| R1: open from configuration alone (`status: "OPEN"` opens when not ready) | 4: the pin, LOW-2, all-null, the stall test |
| R2: `openedAt` minted fresh (observation instant even with a past `openTime`) | 4 |
| **LOW-2: `openTime` used despite a not-ready poll after it** | 2: the pin, the LOW-2 restart-mid-wait test |
| R3: scheduled closing never emitted | 5 |
| R3: scheduled closing at the open, not at `closeTime` | 5 |
| R4: observed closing deleted | 10 |
| R4: `closesAt` from the venue's `closedTime` instead of the receipt instant | 4 |
| R5: contradiction opens anyway | 3 |
| **LOW-5: CONTRADICTED incident not raised at start** | 1 |
| **LOW-5: pair mismatch not refused** | 1 |
| **LOW-5: foreign record not named** | 1 |
| R6: incident deleted | 1 |
| **LOW-6: the null field not named** | 1 |
| `restricted` gated | 1 |
| derivation proceeds on a WAL-refused frame | 1 |
| **LOW-3: the `stop()` check before the journal write** | 1 |
| stall never opened | 1 |
| terminal market still polled | 6 |
| overlapping cycles stacked | 1 |
| **LOW-1: the feed-absent incident removed** (`gateway.ts`) | 1 |
| door: readiness as the literal `active && !closed && acceptingOrders` | 1 (`closed: null` is NOT ready; unchanged from r0) |

**The restart mutation, as the packet asked:** with the ledger read removed,
`configured openTime: the second epoch emits no second MarketOpened` and
`no configured openTime: … re-read, never re-minted` both fail on the count
(a second `MarketOpened` in the second epoch); the second one's fold
assertion shows what that second event would have done — the universe fold
refuses a `MarketOpened` minted at the restart's first poll with
`UNIVERSE_LIFECYCLE_CONFLICT`, while it accepts the same-instant replay as
idempotent.

**The r1 HIGH-1 pins, on the harness:** (1) `startupTransportFailure` +
ready stub → 0 published, `marketOpenedEmitted 1`, `eventsUnpublished 1`,
the PAGE `GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED` naming `MarketOpened` and its
`openedAt`, the ledger holding the unconfirmed intent, no second attempt in
the halted epoch; a second harness over the same WAL fs with a working
transport, an hour later → exactly ONE `MarketOpened`, the FIRST epoch's
instant, published in the SECOND epoch, citing the second epoch's journaled
response, `replaysEmitted 1`, the ledger confirmed, not re-announced by the
next poll, the fold accepting the stream; (2) `haltPublication("EVENT_BUS_UNAVAILABLE")`
after a published open, then a CLOSED poll → 0 `MarketClosing`, the intent
persisted unconfirmed, the PAGE incident; restart → the market is polled
ONCE more, the observed `MarketClosing` is published with the persisted
instant, the open is NOT re-announced (confirmed), then no further request;
(3) a seeded unconfirmed open → the same instant re-emitted, `replaysEmitted 1`,
`marketOpenedEmitted 0`; (4) a seeded unconfirmed open + a fresh CLOSED poll →
open then closing on the same poll, same `causationId`, the fold reaching
CLOSING; (5) the guard: an unconfirmed open beside a confirmed observed
closing → not polled, nothing emitted; beside a confirmed scheduled closing →
not replayed, the market still polled for the venue's own close. Reverting
to seal-on-dispatch (the mutation row above) fails (1) and (2).

**MEDIUM-1, on the harness** with `support/faulty-file-system.ts`'s new
`failWholeFileWrites` (appends keep working, so the WAL is unaffected and
the fault isolates the ledger): the intent write fails → PAGE
`GATEWAY_LIFECYCLE_LEDGER_WRITE_FAILED`, `ledgerWriteFailures 1`, NO
`MarketOpened` dispatched, phase `PENDING`, the raw response still
journaled, no ledger file; a repeat on the next poll (counter 2); after
`healWholeFileWrites` the next poll emits and confirms. The order chosen is
intent BEFORE dispatch: an event whose instant is not durable could
contradict itself after a restart, so it is held back and re-derived by the
next poll rather than emitted unrecorded.

**MEDIUM-R1, on the harness (r2):** (a) the reviewer's probe N5 — a seeded
unconfirmed open + unconfirmed scheduled closing, `failWholeFileWrites`
during the first poll (the opened replay's intent put rejects) → NOTHING
published that poll, `replaysEmitted 1`, `ledgerWriteFailures 1`, both
intents still unconfirmed (the record byte-identical to the seed), the PAGE
`GATEWAY_LIFECYCLE_LEDGER_WRITE_FAILED`; the disk healed → the next poll
replays open THEN closing (`ingestSeq` order asserted), both confirmed, the
fold reaching CLOSING; (b) a seeded `openedAt: "Thursday morning"` →
`buildHarness` rejects with `GatewayStateError` naming `openedAt`,
`ISO-8601`, `{ key, value }`, the file untouched. The hold-back rule: a
recording-only start with the venue ready AFTER `closeTime` → the open
dispatched into the halt (`eventsUnpublished 1`), the scheduled closing NOT
dispatched (`eventsHeldBack 1`), ONE `GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED`
naming "2 lifecycle event(s)", both intents and `publication-halted`; the
next epoch replays open then closing (`replaysEmitted 2`). An observed
closing derived in a halted epoch while the open is still owed → held back,
phase `CLOSED_OBSERVED`, the standing incident closed and a fresh one naming
both; the next epoch replays both in order. Reverting the `break` fails (a);
removing the validation fails (b); removing the hold-back fails the two
ordering pins.

**Part (c) evidence:** `univ-4-gateway-opens-trader-redis.test.ts` ran
against `postgres:16.6-alpine` and `redis:7.4.2-alpine` Testcontainers
(2 tests, ~5 s): every envelope the trader consumed carried the gateway's
epoch; the only `MarketOpened` had `source: "polymarket"`,
`sourceChannel: "polymarket:gamma-market-rest"`, a `raw:<epoch>:<seq>`
`causationId` and `openedAt = T_OPEN`; the market read `OPEN`; risk
approvals ≥ 1, plans ≥ 1, submissions ≥ 1, fills ≥ 1; the `enter`
decision's `source_event_id` is in `strategy.decisions` under the registered
run. The contrast scenario (no lifecycle feed) stayed `PENDING` with zero
approvals. Before the lifecycle feed existed the in-memory sibling was also
run against `bc7871d`'s predecessor through a temporary combined vitest
config outside the tree; it is what surfaced the R3 correction
(`RISK_MARKET_CLOSE_ONLY`) and the reference-feed requirement
(`RISK_FRESHNESS_UNKNOWN` without Binance trades).

## assumptions

Every venue fact relied on, with its D-30 line (`docs/venue/verified-2026-09-16.md:533` unless noted):

1. The market WebSocket's lifecycle events are exactly `new_market` and `market_resolved`; nothing pushes open/close/closing (§3, U-12 `:813`).
2. `GET https://gamma-api.polymarket.com/markets/{id}` (S-D34; also S-D23) returns a `Market` with `MarketState { active, closed, archived, acceptingOrders, enableOrderBook, negRisk, startDate, endDate, closedTime }`, all nullable (S-D23 lines 199–209).
3. `isTradeReady = state.active && !state.closed && state.acceptingOrders` (S-D23 lines 227–231). Evaluated fail-closed on `null` (stricter; pinned).
4. The six documented semantics: `active`, `closed`, `acceptingOrders`, `restricted`, `archived` (S-D23 302–307), `gameStartTime` (876).
5. The name-only fields (`acceptingOrdersTimestamp`, `ready`, `funded`, `automaticallyActive`, `clearBookOnStart`, `manualActivation`, `closedTime`, `enableOrderBook`, `startDate`, `endDate`, `umaEndDate`, `new`, `startDateIso`, `endDateIso`) are read and recorded, never interpreted; `endDate` is a schedule.
6. Gamma general 4,000 / 10 s and `/markets` 300 / 10 s (§8 `:537-560`, S-D24; `rate-limits.json` `gamma_markets`).
7. A polled field is a statement about the venue's catalog at poll time, not an observed closure event (U-12 stands). No poll is presented as a venue event; the observed `MarketClosing`'s instant is the poll's receipt.
8. The `Market` object gains and loses properties between releases (D-19 `:531`; §10.5 `:751-775`: the OpenAPI is a subset of what the SDK models) — the argument for top-level passthrough.

Repository assumptions: the fold's contract (`packages/universe/src/lifecycle.ts:546-580`, unchanged); the trader's `markLifecycle` is unguarded (`apps/trader/src/market-state.ts:151`) and CLOSING maps to `CLOSE_ONLY` (`pipeline.ts:340-347`); `WalFileSystem.writeWholeFile` is atomic (`packages/storage-wal/src/node-file-system.ts:116-134`); the manual gateway clock starts at `2025-10-09T08:53:20.000Z` (asserted in the test, not assumed).

## deviations

1. **The fixture's location.** The packet named `test/fixtures/venue/markets/get-market-by-id.json`. `apps/ops-cli/src/verify-venue/fixtures.test.ts` ("every fixture file on disk is claimed by exactly one check") walks that whole tree and runs in `pnpm run test`, and its validator rejects an explicit `null` outside four documented fields while every D-30 field is nullable; `apps/ops-cli/**` is outside this packet's paths. The fixture therefore lives at `test/contract/polymarket-public/fixtures/gamma-market-by-id.json`, the `WP-070` precedent for a REST fixture "NOT part of the frozen WP-000 catalogue", with the README's envelope (`retrieved: "2026-09-16"`, source URL, `sanitized: true`, a provenance note).
2. **The fixture is reconstructed from D-30's property list, not from S-D34's example body**, which is not in the repository (the report records the property list with line numbers and S-D23's `MarketState` types; no cached page). Only field names and nullability are evidence; every value is synthetic; fields whose wire TYPE D-30 does not record (`id`, `slug`, `clobTokenIds`, `acceptingOrdersTimestamp`, …) are omitted. Stated in the fixture's note.
3. **`{id}` is configuration (`gammaMarketId`), not derivation.** S-D34's path-parameter description is not in the repository, so the round does not assert whether it is the numeric Gamma id or the condition id; the operator supplies the value verified for the market, and the door refuses a lifecycle-configured market without one.
4. **R3's timing** — "at `closeTime`", not "immediately after the open" (argued under summary; measured by the part (c) test).
5. **The door has no `zod` schema** (argued under summary).
6. **The "stub Gamma server" is the gateway's injected `PublicHttpClient` port**, the repository's established REST double (as the snapshot fetcher's tests), not a loopback HTTP listener. No socket is opened for it.
7. **Part (c) landed in two files**, the Redis/PostgreSQL drive the coordinator asked for and an in-memory sibling; nine alias rows were added to the paper-trader suite's vitest config and tsconfig, and its header gained a dated correction (four Docker files, one of them Redis). `test/e2e/**` untouched.
8. **`packages/polymarket-public/src/errors.ts` and `src/index.ts`** edited for wiring (two error codes; the barrel export), as the packet allows with disclosure.
9. **The worktree.** The environment named `.claude/worktrees/agent-…`; the packet named `/home/adriancova/proyects/tradeBot/polymarket-bot-univ-4` (branch `univ-4`, hardlinked `node_modules`). The packet's worktree was used throughout; the agent worktree was not touched.

## known_risks

1. **A poll cannot tell an operator when the venue closed.** A market closed between two polls is seen late by up to one interval (default 10 s); a market that closed and reopened inside one interval is not seen at all. The venue's `endDate` was NOT used — it has no documented semantics and is a schedule, not an observation; the reviewed `closeTime` carries the schedule. The observed `MarketClosing`'s `closesAt` is the poll's receipt instant, which is the honest statement and is up to one interval late.
2. **What the ledger's two writes leave open (r1; the r0 text here was inaccurate — persistence did not depend on the publish outcome, so the loss was open on EVERY halt, not only a crash race).** With intent-before-dispatch and confirmation-after-publication, an event is never sealed unpublished and never re-minted; what remains: (a) a CONFIRMATION write that fails after a successful publish leaves the intent unconfirmed (PAGE `GATEWAY_LIFECYCLE_LEDGER_WRITE_FAILED`), so the next epoch re-emits a same-instant duplicate — idempotent for the universe fold; the trader's unguarded `markLifecycle` re-marks OPEN (harmless while no CLOSING was confirmed, and the guard never replays an OPEN past a confirmed CLOSING). **The RESOLVED regression (r2, LOW-R3, trader-owned):** the trader marks lifecycle on receipt with no rank guard (`apps/trader/src/loop.ts:577-580`, `market-state.ts:151`), so a same-instant replayed `MarketOpened`, or an R4 `MarketClosing` that lands AFTER the WebSocket's `MarketResolved` (the poll can see `closed: true` up to one interval later), regresses the trader's market from RESOLVED to OPEN or CLOSING, which `pipeline.ts:340-347` then maps to ACTIVE / CLOSE_ONLY instead of HALTED. The universe fold is correct on both (same-instant → unchanged; a closing on RESOLVED → refused); the trader is not. This feed cannot prevent it — it does not consume `market_resolved` and a poll cannot know the market resolved — so it is the trader owner's fix (follow_up 4); (b) a process killed between the publisher's acknowledgement and the confirmation write is case (a); (c) an INTENT write that fails holds the derivation back — the market stays PENDING, loudly, until the disk accepts the write; a venue that closes meanwhile is then seen as R5 (contradicted) rather than opened-then-closed, which is the fail-closed reading. Within one epoch no retry is attempted after `published: false`: every publication halt is terminal for the epoch by design, and the restart is the recovery.
3. **The budget figure is a documentary snapshot.** If a later venue round establishes that `GET /markets/{id}` is not under the 300 / 10 s `/markets` bucket, `GAMMA_MARKETS_RATE_LIMIT_PER_10S` is a one-line change with its source; the 5 % share stays. Enforcement status of the limiter itself is UNVERIFIED (U-14).
4. **The lifecycle ledger is a second persisted derived-state file** beside the WAL. It records only what THIS gateway emitted; two gateways sharing a WAL root would share it, which the single-writer-per-directory invariant already forbids for the WAL.
5. **R6 is a reporting rule, not a venue rule**: readiness lost through `active`/`archived` alone opens an incident and derives nothing, because no documented transition reads that way. If the venue documents one, that cell changes.
6. **`gameStartTime` is carried verbatim, no format asserted** — a door that refused a non-ISO string on a field no derivation reads would be the refuse-what-the-venue-sends class.
6a. **The response is attributed by REQUEST, not by content (r1, MEDIUM-2).** D-30 does not record the response's `conditionId`, so the feed may not interpret it and does not: a MIS-POINTED `gammaMarketId` opens THIS market on ANOTHER market's readiness, silently, and nothing in the gateway can notice — until the next venue round establishes the response's `conditionId`, at which point a mismatch must refuse the poll with an incident. Stated in the feed header and the README; verifying `gammaMarketId` before enabling the feed is an operator obligation.
6b. **The door refuses a body nested deeper than `MAX_WIRE_DEPTH` (16) as a whole (r1, LOW-4)** — the CLOB door's residual, inherited through the shared materializer: a `Market` whose nested metadata ever exceeded that depth would fail the poll loudly (`GATEWAY_LIFECYCLE_STATE_INVALID`) rather than open the market. Every documented value is top-level, so the cap is far from what the venue publishes today.
7. **Consumers that join a later epoch** (a trader started fresh after the gateway's open) receive no re-announcement of a CONFIRMED event; they must obtain the lifecycle state from the stream's history (the default subscription starts at the oldest retained event) or a durable projection. Re-announcing confirmed events was rejected because of the trader's unguarded `markLifecycle` (R2); only UNCONFIRMED intents are re-emitted (r1).
8. The part (c) Redis file adds a second container image to the trader suite's cold-cache pull.

## follow_up

1. **`IMPLEMENTATION_STATUS.md`**: mark `UNIV-4` complete after review; B10 closes (H1 becomes attemptable, not discharged).
2. **The venue fact the round could not license**: S-D34's `{id}` path parameter (numeric Gamma id vs condition id) and its example body — for the next venue round to record, after which `gammaMarketId` could be derived from `conditionId` if that is what the parameter is.
3. **`apps/ops-cli/verify-venue`**: a spec for the Gamma `Market` shape would let the fixture move to `test/fixtures/venue/markets/` (its owner's change; the validator today claims every file and refuses nulls).
4. **`apps/trader`** (its owner): `markLifecycle` is unguarded — a `MarketOpened` after `MarketClosing`, and (r2, LOW-R3) a same-instant replayed `MarketOpened` or a late R4 `MarketClosing` after `MarketResolved`, regress the trader's lifecycle (RESOLVED → OPEN/CLOSING → ACTIVE/CLOSE_ONLY instead of HALTED); the trader should rank-guard `markLifecycle` as the universe fold does. Also: the trader's `lifecycle` feature input reads `openedAt`/`closesAt` from CONFIGURATION, not from the events — if the reviewed schedule and the venue disagree, the strategy's cutoff follows the schedule while the market status follows the events.
5. **Operator runbook**: how to repair or remove `market-lifecycle-ledger.json` (an unreadable ledger fails the start by design), and that a market's `gammaMarketId` must be verified before the feed is enabled.
6. `MarketResolved` remains the WebSocket's; the strategy's cutoff and `packages/universe`'s fold are untouched, as scoped.
7. **(r1) The response's `conditionId`** — for the next venue round: once D-30's successor records it, the feed must refuse a poll whose body names a different market (MEDIUM-2's residual; today a disclosure).
8. **(r1) `publisher.ts`'s halt detail** ("the event remains in the WAL", `publisher.ts:461`) is true of raw frames and false of this feed's derived events; the feed's own incident detail states the truth and the outcome text is consumed nowhere else, so the publisher was left untouched (its owner's wording).

## commit_sha

- reproduction pin: `f687513`
- round: `bc7871d`
- part (c): `615cabb`
- handoff: `6788e26`
- the `as unknown as` removal: `acc122a`
- the r0 tip the review examined: `7564db6`
- r1 code: `9e9f154`; r1 tip (the confirming review's input): `29b2e9d`
- r2 code: `5109a88`; r2 tip: the commit carrying this table (recorded in the hand-back message)
