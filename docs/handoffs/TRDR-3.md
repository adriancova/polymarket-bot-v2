# TRDR-3 completion record — the trader health endpoint and an exact-decimal PnL producer (GOV-2B **B5**, code half, R4)

**Branch:** `trdr-3` on base `b3a829c`. Chain: `5742c4d` (reproduction pin) →
`8b7fd48` (the work) → the final commit named under `commit_sha` (the
hostile-throw pin, the Prometheus fragment, this record). Not merged, not
pushed. Implementer: Opus `wp-implementer`; the adversarial review is not this
agent's to perform.

**What B5 still lacks after this round, stated first:** a REAL Prometheus
loading `infra/prometheus/control-api-scrape.yaml`, a provisioned Grafana, and
a REAL import of `infra/grafana/control/*.json` — `GOV-2B` round **R5** (infra)
and human item **H3**. Nothing here claims any of those happened. What this
round closes is the CODE half: every `trader_*` series now has a runtime
producer end to end (trader → loopback HTTP → control API door → exposition),
and the "Realized PnL" panel binds a family that is produced.

## summary

Three seams, one composition:

1. **`apps/trader` serves `GET /health` over the loopback**
   (`apps/trader/src/health-server.ts`, new). The CURRENT `HealthSnapshot`
   (`trader.loop.health()`, per request, never cached) encoded by
   `encodePlainJson` from own data (`schema-boundary.md` §6 item 3),
   `application/json; charset=utf-8`, `cache-control: no-store`. Every other
   method is `405` (`allow: GET`), every other path `404`, a body past 1 KiB
   `413` + `connection: close` — each a fixed body reflecting nothing of the
   request. Bounds stated in `TRADER_HEALTH_BOUNDS`: 8 sockets, 32 headers,
   5 s headers/request timeouts, 1 s keep-alive, 16 requests per socket,
   1 KiB body. Bind and port come from `TRADER_HEALTH_BIND` /
   `TRADER_HEALTH_PORT` through an arena door (`readHealthServerEnv`): both
   unset = no endpoint, logged as such; one without the other, a bad grammar
   → `TRADER_HEALTH_ENV_INVALID`; a non-loopback host (`0.0.0.0`, `::`, any
   routable address — anything outside `127.0.0.1`/`::1`/`localhost`) →
   `TRADER_HEALTH_BIND_REFUSED`; port > 65535 → `TRADER_HEALTH_PORT_INVALID`;
   all exit 78, and the door runs at step 2b of `startup()`, BEFORE Redis or
   PostgreSQL are opened. The server is started inside `assembleDurableTrader`
   at step 4b — after `checkPaperTraderSafety`, after registration, after
   `createPaperTrader` succeeds, before the pump — and closed on every path
   out; a failed `listen` is `TRADER_HEALTH_LISTEN_FAILED` (exit 78) with the
   store closed. A snapshot that cannot be encoded answers `500` with the
   encoder's refusal kind and path read as OWN data (never `instanceof`); a
   hostile thrown `Proxy` is "unclassified" and the trader keeps serving.
   There is no POST, no query parameter that does anything, no code path
   that writes.
2. **`apps/control-api` actually refreshes the cache** — refresh-on-read
   (argued below): an AUTHORIZED `GET /v1/health` or `GET /v1/metrics`
   refreshes first, single-flight, bounded by the source's timeout; enabled
   by `main.ts` for an `http` source only (`refreshHealthOnRead`), so a
   `none` source's surface is byte-identical to `WP-240`'s. The door admits
   `accounting.realizedPnl`. `TraderHealthCache` gains `current` ("the most
   recent read passed the door") beside the unchanged `available` ("a report
   is held"); `control_trader_health_current` is the gauge that drops to 0
   when the source goes away while the last good report is retained.
3. **Realized PnL as EXACT decimal strings.** `AccountingHealth.realizedPnl =
   { byInstance, account }` — the latest `PnlSnapshot.realizedPnl` the store
   ACCEPTED per instance (sorted) and their `addDecimal` sum, `null` while no
   snapshot has been observed. The value is observed at the store port:
   `pnl-observation.ts`'s `observeRealizedPnl(store, book)` records after a
   successful `writePnlSnapshot`, and `assembleDurableTrader` attaches the
   `RealizedPnlBook` to the health state (`HealthState.attachRealizedPnl`).
   `packages/observability` gains `trader_realized_pnl_info{instance_id,
   exact_decimal}` and `trader_account_realized_pnl_info{exact_decimal}`
   (value 1, `infoOnly`), produced by `samples.ts` the way `reservedCollateral`
   is, OMITTED (not `0`) while `account` is `null`; the "Realized PnL" panel is
   a `table` over the labels with two targets, and left `PENDING_PRODUCER_PANELS`.

### The reproduction, at base `b3a829c` (counts)

- (a) `apps/trader/src`: `node:http` 0, `createServer` 0, `listen(` 0, `.listen` 0.
- (b) `refresh()` in `apps/control-api/src` outside tests: 1 occurrence — its
  own declaration; 0 callers. `5742c4d` drives the SHIPPED `startup({serve:
  true})` with an `http` source at a counting loopback stub: **0 stub
  requests** over 1.5 s of serving + two authorized reads;
  `control_trader_health_available 0`; no `control_trader_health_reads_total`
  line; no `trader_*` family. The same file, flipped at `8b7fd48`: 0 requests
  unprompted over 300 ms, then 1 per authorized read.
- (c) `trading-dashboard.json` "Realized PnL": `type: text`, `targets: None`.

### The refresh-mechanism argument (also in `api.ts`'s header)

Interval timer (rejected): reads are instant and the trader is polled at a
fixed rate — but this process does nothing unprompted (`ApiEnvironment`
supplies the clock and ids so no behaviour is a function of wall time the
audit cannot see, `WP-240`'s posture); a 15 s Prometheus scrape would then
sample a cache refreshed on a second, unrelated cadence, so "current" would
mean "as of the last tick"; it needs a floor, a config field and a shutdown
path; and it polls a trader nobody is reading. Refresh-on-read (chosen): the
report an operator or a scrape receives is the trader's answer AT THAT
REQUEST, `control_trader_health_current` means "the read this scrape did
passed", nothing runs between requests, the cost is one loopback GET bounded
by `traderHealth.timeoutMs`, concurrent reads share one in-flight refresh,
and the refresh runs only after authentication AND authorization — an
anonymous or unauthorized caller makes this process ask the trader nothing
(pinned: 401 with 0 stub hits).

**`available` vs the packet's "0 after the source goes away".** The packet
asked for `control_trader_health_available` to read 0 after the source goes
away AND for the last-good-report retention semantics to stay unchanged.
Those two cannot both hold on one gauge: `available` is `#last !== undefined`
and is pinned `true` after a failed read by `health-source.test.ts:185` and
`test/unit/control-api/response-encoder-bound.test.ts:138`, with the retention
prose as its reason. Changing it would have broken a documented promise and
two pins; so `available` is untouched and the staleness signal is a second
gauge, `control_trader_health_current` (`TraderHealthCache.current`), which
the flipped pin measures: after the stub closes, `available 1`, `current 0`,
`reads_total{UNAVAILABLE} 1`, the retained report still served. Disclosed as
a deviation; the reviewer may prefer the alternative.

### The golden — every changed byte, derived

`test/replay-golden/paper-e2e/paper-e2e-run.json` moved by exactly **4
inserted lines** at `health.accounting`:

```json
      "realizedPnl": {
        "account": null,
        "byInstance": {}
      },
```

Nothing else moved (`git diff --stat`: 1 file, 4 insertions, 0 deletions;
`test:e2e` 6/78 green; `determinism-golden` re-runs byte-identical). The field
is `null`/empty rather than the packet's expected `-1.2` because
`test/e2e/support/harness.ts` calls `createPaperTrader` directly with a bare
`MemoryTraderStore` and attaches no `RealizedPnlBook` — the observer lives in
`assembleDurableTrader`, and the grant forbids editing the harness
(`test/e2e/**` golden regeneration only) and `trader.ts`/`loop.ts` (where a
composition-independent hook would go). The same golden's
`pnlSnapshots[2].realizedPnl` is `"-1.2"`, so the field WOULD read
`{ "account": "-1.2", "byInstance": { "e18f5c20-2000-7a20-8b00-000000000002": "-1.2" } }`
the day either the harness attaches the book the way the root does or
`createPaperTrader` wraps its own store (one line in `trader.ts`, the clean
fix — follow-up 1). Recorded in the golden's README. The composed value is
proven where the composition root runs (acceptance (a) below: `-1`).

### Non-vacuity — each producer / wiring reverted → what fails

| # | Mutation (then restored from `8b7fd48`) | Fails |
| --- | --- | --- |
| M1 | `samples.ts`: per-instance `trader_realized_pnl_info` line deleted | `metric-families.test` "emits EVERY declared family"; `samples.test` realized-PnL pin; `health-realized-pnl.test` round trip — 3 |
| M2 | `samples.ts`: `trader_account_realized_pnl_info` line deleted | the same 3 |
| M3 | `samples.ts`: `control_trader_health_current` line deleted | `metric-families.test` "emits EVERY declared family" — 1 |
| M4 | `api.ts`: the refresh branch disabled | `health-refresh-wiring.test` (stub hits 0, expected 1) — 1 |
| M5 | control-api `main.ts`: `refreshHealthOnRead: false` | the same — 1 |
| M6 | `health-door.ts`: `realizedPnl` removed from the schema | 10 across `trader-health-http-source`, `trader-health-shape`, `health-refresh-wiring` (the strict door refuses the trader's field) |
| M7 | trader `main.ts`: `attachRealizedPnl` dropped | `trader-health-endpoint-postgres` (`account: null` vs `"-1"`) — 1 |
| M8 | trader `main.ts`: the raw store handed to `createPaperTrader` | the same — 1 |
| M9 | `pnl-observation.ts`: record regardless of `written.ok` | `health-realized-pnl.test` decorator pin (`999` recorded) — 1 |
| M10 | `health-server.ts`: loopback check disabled | `health-server.test` "REFUSES every non-loopback bind" — 1 |
| M11 | `health.ts`: `addDecimal` → `String(Number(a) + Number(b))` | 5 across `health-realized-pnl.test` (exact sum, round trip, source scan) and `health-server.test` (bytes) |
| M12 | `classifyHealthFailure`: `instanceof Error` gate inside the guard | 2 own-data classifier pins |
| M12b | handler: `cause instanceof Error ? … : …` outside the guard | `trader-health-http-source.test` hostile-Proxy case: unhandled error, request hangs to the 60 s timeout |
| M13 | `trading-dashboard.json` reverted to base (text panel, no targets) | `dashboards.test` pending-set mismatch + 3 orphan families — 2 |

### The pollution battery (schema-boundary §4 item 5)

`test/unit/trader/health-server.test.ts` drives `healthResponseBody(snapshot)`
— the exact bytes the server writes — through `sweepInheritedToJson`'s six
contexts ({`Object.prototype`, `Array.prototype`, `BigInt.prototype`} ×
{enumerable, non-enumerable}), once on a snapshot built outside the window and
once on a snapshot BUILT INSIDE it: **0 divergences, 0 injected calls**. The
battery is shown non-vacuous on the same snapshot: native `JSON.stringify`
diverges in ≥ 4 of the 6 contexts with the injected `toJSON` running. A
polluted window may not span socket I/O (`SER-3`), so the socket-level suites
assert the served body `=== healthResponseBody(snapshot)` instead.

### Acceptance, as measured

- **(a)** `test/integration/paper-trader/trader-health-endpoint-postgres.test.ts`
  (real PostgreSQL 16.6-alpine): register through the `WP-040` repositories →
  `assembleDurableTrader` with `healthListen` from the REAL env door → `GET
  /health` before any event serves `{ byInstance: {}, account: null }` → eight
  events (BOOT-1's six + a refreshed YES book at 12:14:49 + `MarketClosing` at
  12:14:50, inside the 20 s exit cutoff) → `BUY 50 @ 0.34`, `SELL 50 @ 0.32`
  → the served bytes `=== healthResponseBody(trader.loop.health())` and carry
  `realizedPnl { byInstance: { <instanceId>: "-1" }, account: "-1" }`, where
  `-1` is folded in the test from the two TRADE legs with `mulDecimal`/
  `subDecimal`/`addDecimal` (`16 − 17`; fees are `0` in this fixture) and equals
  the persisted `accounting.pnl_snapshots.realized_pnl` column (`["0", "-1"]`).
  The read is `node:http` (why: above); the REAL `HttpTraderHealthSource` reads
  the REAL `startTraderHealthServer` in-process in
  `test/integration/control-api/trader-health-http-source.test.ts` (the one
  tree that aliases both apps), and the SHIPPED control API's refresh is
  measured in `health-refresh-wiring.test.ts`.
- **(b)** `packages/observability`: `metric-families.test` (cover-each-other,
  the `exact_decimal` family list now four), `samples.test` (+2 pins),
  `dashboards.test` (the panel has two non-empty targets over the labels, no
  arithmetic on an `_info` family, every family on a dashboard).
- **(c)** `"0.1000000000000000055511151231257827"` and
  `"-12345678901234567890"` round-trip byte-identical from a `PnlSnapshot`
  through the decorator, the book, `HealthState.snapshot()`,
  `healthResponseBody`, `JSON.parse`, `traderHealthSamples` and
  `renderExpositionFor` (unit), and through the real server + real source +
  door (control-api integration); a source scan pins no `Number(`,
  `parseFloat`, `parseInt` or unary `+` in `health.ts`, `pnl-observation.ts`,
  `samples.ts`, `metric-shapes.ts` (comments stripped).

## files_changed

- `apps/trader/src/health-server.ts` (new), `apps/trader/src/pnl-observation.ts`
  (new), `apps/trader/src/health.ts`, `apps/trader/src/main.ts`,
  `apps/trader/src/index.ts`.
- `apps/control-api/src/api.ts` (refresh-on-read, `current` on both reads, the
  `/v1/health` note made truthful), `apps/control-api/src/health-source.ts`
  (`current`; header made truthful), `apps/control-api/src/health-door.ts`
  (the new field), `apps/control-api/src/main.ts` (`refreshHealthOnRead`, one
  log line), `apps/control-api/src/testing/index.ts` (fixture carries the field).
- `packages/observability/src/control/{metric-shapes,samples,metric-families,testing,dashboards}.ts`,
  `{metric-families,samples}.test.ts`.
- `infra/grafana/control/trading-dashboard.json` (panel 11 → `table`, panel
  14 `stat` for `control_trader_health_current`, panel 12's "only economic
  amounts" wording), `infra/prometheus/control-api-scrape.yaml` (new, the
  one scrape job), `infra/prometheus/README.md` (one row).
- `test/integration/control-api/health-refresh-wiring.test.ts` (new; the pin
  that flips), `trader-health-http-source.test.ts` (new),
  `trader-health-shape.test.ts` (attaches a book; header made truthful; +1 pin).
- `test/integration/paper-trader/trader-health-endpoint-postgres.test.ts`
  (new), `support/registration.ts` (new — BOOT-1's helpers, factored),
  `durable-trader-first-fill-postgres.test.ts` (imports the shared helpers;
  bodies unchanged).
- `test/unit/trader/health-server.test.ts` (new), `health-realized-pnl.test.ts` (new).
- `test/e2e/support/artifact.ts` (one type widened), `test/replay-golden/paper-e2e/paper-e2e-run.json`
  (4 lines), `test/replay-golden/paper-e2e/README.md` (the `realizedPnl` note).
- `docs/handoffs/TRDR-3.md` (this record).

Not touched: `loop.ts`, `trader.ts`, `safety.ts`; `packages/**` outside
`observability/src/control`; `db/**`, `docs/adr/**`, `docs/spec/**`,
`IMPLEMENTATION_STATUS.md`, the lockfile, root `package.json`,
`tsconfig.base.json`, `eslint.config.mjs`, `docker-compose.yml`, the audit
log / operators / control plane / run-mode code, the recorder's dashboards
and scrape file, every README outside `infra/prometheus/` and the golden's.
No `eslint-disable`, `@ts-ignore`, `.skip`, `.only`, `as never`, `as unknown as`
(the cast census `query-boundary-cast-scan.test.ts` passes with an empty
registry). No new workspace dependency, no lockfile edit, no hand-link.

## tests_run

At the final tip (all on this laptop, Docker 29.1.2 for the two Testcontainers
suites):

- `pnpm run typecheck` 0 errors; `pnpm run lint` 0; `pnpm run check:deps`
  PASS, 34 packages / 80 edges (unchanged).
- `pnpm run test` **330 files / 7177 tests** (base 328 / 7154: +2 files,
  +23 tests).
- `pnpm test:e2e` 6 / 78 (golden regenerated, then compared clean);
  `pnpm test:replay` 3 / 17.
- `pnpm --filter @polymarket-bot/trader test:integration` **12 files / 125
  tests** (base 11 / 122).
- `pnpm --filter @polymarket-bot/control-api test:integration` **10 files / 85
  tests** (base 8 / 77).
- `packages/observability/src/control` 6 files / 97 tests (base 95);
  `infra-consistency.test` 19 / 19.
- The 14 mutants above, each restored from the commit afterwards.
- The reproduction at base: `5742c4d`'s test green at base with its
  zero-request assertions (run before the work began).

## assumptions

- `PnlSnapshot.realizedPnl` is a canonical `DecimalString` by construction
  (`packages/pnl`), so `addDecimal` over recorded values cannot throw; the
  book does not re-validate.
- The trader writes only `VIRTUAL_STRATEGY` snapshots (`instanceId` set); a
  snapshot with `instanceId: null` is not per-instance and is NOT recorded
  (documented at `RealizedPnlBook.record`).
- "Recorded after `ok`": the health surface reports what the database holds;
  a refused write halts the loop and is not reported as a value.
- Port `0` is admitted by the env door (OS-assigned; the startup log states
  the bound URL) — needed by the acceptance test and harmless for an operator
  who reads the log.
- `process.emit("SIGINT")` reaches only the control API's handler in a vitest
  worker (measured `listenerCount === 0` before startup).
- The paper-trader fixture's fee schedule is `0`/`0`, so proceeds − cost IS
  realized PnL there; the e2e's `-1.2` derivation (fees excluded from
  realized) is the same rule.

## deviations

1. **The golden carries `account: null`, not `-1.2`** (derived above; grant
   conflict: harness and `trader.ts`/`loop.ts` both out of reach). Reported,
   not worked around.
2. **`test/e2e/support/artifact.ts`: one type widened** (`ArtifactHealth.
   accounting`) so `{ ...health.accounting }` typechecks with the new object
   field. No scenario, harness or reconciliation logic changed; the golden's
   other 1,700+ lines are byte-identical.
3. **`control_trader_health_current` — a new control-plane family, getter and
   trading-dashboard stat panel** instead of changing `available`'s pinned
   semantics (argued above). The panel sits on the trading dashboard because
   the operations dashboard is outside the grant.
4. **`api.ts` `/v1/health` `note` text rewritten** (it said "apps/trader does
   not expose an HTTP health endpoint today", now false on an operator
   surface); the phrase "composition obligation" is kept so `api.test.ts:377`
   still holds. `health-source.ts`'s and `trader-health-shape.test.ts`'s
   headers likewise corrected, superseded text quoted.
5. **`test/integration/paper-trader/support/registration.ts`**: BOOT-1's
   registration helpers moved out of its test file (bodies unchanged) so the
   new Testcontainers file shares them; the BOOT-1 test's own assertions are
   untouched.
6. **The 413 bound** answers with a status and `connection: close` (the
   control API's own pattern) rather than a silent reset — a client should
   read a refusal, not a hang-up.
7. **`infra/prometheus/control-api-scrape.yaml`** added (allowed "at most
   one, disclosed"): a Bearer `credentials_file` path, target `127.0.0.1:9466`
   because the example config's `9465` collides with the compaction worker's
   target in `recorder-scrape.yaml` (pre-existing, disclosed in both headers).
8. The reserved-collateral panel's description no longer says "The only
   economic amounts on this dashboard" (there are now four such families).

## known_risks

- **Stale READMEs with pins that hold them stale** (BOOT-1 R11 class):
  `apps/control-api/README.md:109`, `infra/grafana/control/README.md:38` and
  `apps/trader/README.md` still say "`apps/trader` does not expose an HTTP
  health endpoint today", and `example-config-and-startup.test.ts:60-63` /
  `dashboards.test.ts:304-308` REQUIRE those sentences. All three READMEs are
  outside this grant; the pins were left rather than deleted. A docs round
  must flip both halves together.
- `available` stays 1 while the trader is dead (pinned semantics); the
  operations dashboard's "Trader health report available" stat therefore
  does NOT show staleness — only the trading dashboard's new "current" stat
  does, until a round with the operations dashboard in grant mirrors it.
- Refresh-on-read means an authorized READ operator can make the control API
  issue loopback GETs at its request rate (1:1, single-flight, bounded by the
  timeout); no rate bound exists on the control API (`WP-240` L-9), which is
  unchanged by this round.
- The health server's `snapshot()` is the loop's `health()`; a snapshot that
  throws is contained to a `500`, but a snapshot that is SLOW (it is not
  today: no I/O) would hold a request open up to `requestTimeout`.
- `TRADER_HEALTH_PORT=0` is valid; an operator who sets it must read the log
  to find the port.
- The "Realized PnL" table shows "No data" until the first PnL snapshot of a
  run — by design (absent ≠ zero), but an operator must know it.
- The e2e harness path and the shipped path now DIFFER in one observed
  field (deviation 1); until follow-up 1 lands, a reader of the golden could
  mistake `account: null` for "the surface does not work".

## follow_up

1. **Move the observer into the composition**: `createPaperTrader` wraps
   `options.store` with `observeRealizedPnl` and attaches the book itself
   (one place, `trader.ts`, out of this grant); delete the late attach in
   `main.ts`; regenerate the golden — expected flip derived above
   (`account: "-1.2"`, one instance line), nothing else.
2. The three READMEs and their pins (`apps/control-api/README.md`,
   `infra/grafana/control/README.md`, `apps/trader/README.md`;
   `example-config-and-startup.test.ts`, `dashboards.test.ts`) — flip
   together; document `TRADER_HEALTH_BIND`/`TRADER_HEALTH_PORT` and the
   `traderHealth.http` composition in the trader and control-api READMEs.
3. Mirror `control_trader_health_current` on the operations dashboard beside
   "Trader health report available".
4. Resolve the `9465` port collision between
   `control-api.config.example.json` and `recorder-scrape.yaml`.
5. **R5 / H3**: load `control-api-scrape.yaml` into a real Prometheus,
   provision a Grafana, import the three dashboards, read the Realized PnL
   table with a trader running — human evidence, none claimed here.
6. Brand `TraderHealthReportInput` (`SER-3` residual 2) — unchanged by this
   round; the door still admits the field by shape.
7. `WP-240` L-9 (request/headers timeouts on the control API's own server)
   — the trader's health server states its bounds; the control API's does
   not.

## commit_sha

`5742c4d` (reproduction pin), `8b7fd48` (the work), and the final commit
carrying the hostile-throw pin, the Prometheus fragment and this record —
its SHA is reported in the hand-back message, since this file is part of it.
