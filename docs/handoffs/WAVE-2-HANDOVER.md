# Wave 2 handover — what the agents closed, what only you can

**Written 2026-09-17 by the orchestrator at `main` after the `UNIV-4` flip.**
Instruction it answers (2026-09-15): "drive wave 2 fully to completion and I'll
take it from there." This is the "take it from there" document. Everything in it
is verifiable from `IMPLEMENTATION_STATUS.md` (the authority), the per-round
records under `docs/handoffs/`, and `git log --first-parent main`.

## 1. The verdict, stated honestly

**Wave 2's package work is complete; Wave 2 is not closed out.** The runbook §10
read-only audit (`GOV-2B`, 2026-09-15, `docs/handoffs/GOV-2B-wave-2-closeout.md`)
found every one of the eleven packages meeting its own acceptance criteria and
three *composition* seams failing — places where each package passes and the
assembled system does not. The §7 exit checklist has no "or explicitly pending"
carve-out, so an unevidenced item is NOT MET, not deferred.

Since the audit, **every blocker an agent could close has been closed**, in nine
rounds, each with reproduce-first, an independent adversarial review, and mutation
non-vacuity. The residue is human evidence, human infrastructure, or a ruling.

**§7 checklist, as it stands at `main`:**

| # | Item | State | Why |
| --- | --- | --- | --- |
| 1 | Full paper pipeline works end to end | **OPEN** | One bracket, one round trip, closed by the cutoff reduce, ending PAUSED (`RISK-2` residual 5: the reduction creates no order track, so the instance pauses on its own exit). No take-profit has ever filled in any recorded run. Not a blocker of any human item; a strategy-package round. *(2026-09-28: the PAUSED ending is CLOSED by `BRACKET-1a` (`11969f3`): the run now ends CLOSED. The item stays OPEN for `BRACKET-1b` (a filled take-profit and a second bracket) and `BRACKET-1c` (a durable round trip), per the user's ruling R1.)* *(2026-09-28: `BRACKET-1b` (`7252150`) recorded the two-bracket run with a FILLED take-profit, reconciled per bracket (in-memory doubles). `BRACKET-1c` remains.)* |
| 2 | Replay produces identical results | MET with qualification | Byte-identical replays are gated (`test:replay`, 3 files / 17 tests) — through the shipped root when a caller supplies the core (B3, below). |
| 3 | Ledger rebuild equals projections | MET with qualification | Rebuild from durable rows cannot reproduce per-fill economics until the execution chain is persisted (`BOOT-1`'s disclosed fill-link severing). |
| 4 | Static Bracket in replay AND live-data paper through the same code | **replay half: NARROWED; live half: attemptable, never attempted** | B3 (H8) and B4 (H1) below. |
| 5 | Dashboards expose decisions, vetoes, fills, PnL | **code half MET; infra half OPEN** | Every `trader_*` series has a runtime producer and realized PnL is an exact-decimal panel target (`TRDR-3`); no real Prometheus/Grafana has ever loaded them (H3). |
| 6 | No real signer installed | MET | Unchanged; every round re-checked. |
| 7 | Maximum run mode remains PAPER | MET | `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, both LIVE_MICRO limits 0 — untouched by every round, pinned in every test environment. |

## 2. What the agents closed since the audit (all on `main`, all `--no-ff`)

| Round | Merge | Closed | The one thing to know |
| --- | --- | --- | --- |
| `TRDR-2` | `f3da220` | B1 cause | The pnl_snapshots column binding hid behind `as never`; an AST census now keeps every trader query boundary cast-free. Raised B9. |
| `RISK-2` | `133eac1` | B2 | A covered SELL is an EXIT; the golden reaches realized `-1.2` through a complete round trip for the first time. Ends PAUSED (item 1). |
| `GATE-1` | `0434c82` | B6, B7 | The e2e evidence tree and `test:replay` are CI gates; `pnpm audit` exits 0. |
| `GOV-2C` | `33c36f9` | B8 + docs debt | The ledger no longer says "Open blockers: None" above 219 lines of open findings; a 30+-row residual queue with owners is the authority — **and nothing checks it**. |
| `BACKTEST-1` | `b462501` | B3 → NARROWED | The shipped replay root drives the real paper core to RISK-2's exact numbers, byte-identical, when a caller supplies the core. The executable cannot construct it: `dependency-direction.md` forbids an app depending on an app (proven). Needs **H8**. |
| `BOOT-1` | `0d09eb5` | B9 | The durable trader refuses to start unless its `catalog.markets`/`strategy.instances`/`strategy.runs` rows exist and match, and refuses to resume a run that already holds decisions (a restart used to halt on its first decision). First test that proves the assembled trader survives its first fill against real Postgres + Redis. `ledger_transactions.fill_id` is bound NULL — a disclosed severing until the execution chain is persisted. |
| `VENUE-2` | `d6aedee` | G-01 | The phase-2 §1.2 twelve-item venue gate, run for the first time: `docs/venue/verified-2026-09-16.md`, 62 hashed fetches, 31 drift rows, no fixture payload changed. Documentary only. |
| `TRDR-3` | `da9c58e` | B5 code half | The trader serves `GET /health` (loopback, bounded, own-data); the control API refreshes on every authorized read (WP-240 M-2, dead since 09-07); realized PnL is an exact-decimal `_info` family. The e2e golden's `realizedPnl` is `null` (harness path lacks the observer; one line in `trader.ts`). |
| `UNIV-4` | `7c08af7` | B10 | Nothing produced `MarketOpened`/`MarketClosing` — a live run could never leave PENDING. The gateway now derives both from the venue's documented polled market state (`isTradeReady = active && !closed && acceptingOrders`), with a write-ahead ledger where *publication*, not dispatch, seals an event. First run in the repository that opens a market from a venue-shaped response. |

Gates on `main` after the last merge: `pnpm run test` 331 files / 7217 tests;
`test:contract` 637 / 65 / 158 / 95; data-gateway integration 12/94; trader
integration 14/129 (real PostgreSQL 16.6 + Redis 7.4.2); control-api 10/85; e2e
6/78; replay 3/17; `check:deps` 34 packages / 80 edges; `pnpm audit` 0;
typecheck 0; lint 0. All on one laptop — see H2.

## 3. What only you can discharge

Ordered by what unblocks the most. Each names exactly what is needed and what
the agents left in place for it.

### H2 — a real CI run (highest leverage, cheapest)
`git remote -v` is **empty** across the whole history. `.github/workflows/ci.yml`
has never executed once; every gate count in every record is a laptop number.
Push to a GitHub remote and let the workflow run. Expect: `js-yaml 4.3.2`
materializes on the fresh install (`GATE1-R3`, already exercised locally); the
`node` job is one fail-fast chain, so a failing early step hides later ones
(`GATE1-R4`); the integration step label still says "two of them" need Docker
when four do (`N5`). None of those is a code risk; all three are one-line fixes
for whoever next owns `ci.yml`.

*(DISCHARGED 2026-09-26 by `CI-1`, merged `7248073`; record
`docs/handoffs/CI-1.md`.) You pushed to `adriancova/polymarket-bot-v2`. The
first run (`36279491795`) failed at "Unit tests" with every test passing: a
synchronous child process held the test worker past vitest's 60 s RPC
timeout, which no laptop run had hit. The fail-fast chain then skipped seven
gates, as `GATE1-R4` predicted. `CI-1` fixed both. PR #1 run `36282501033`
passed every gate on GitHub, the six integration suites included. Correction
to the paragraph above: THREE suites need Docker (postgres, event-bus,
paper-trader). "Four" counted the container-starting files inside
paper-trader, not suites.*

### H1 — the live-data paper run (now attemptable, never attempted)
Every agent-closable precondition is closed. What the run needs from you:
1. **Register the rows** (BOOT-1 refuses to start otherwise): one `catalog.markets`,
   one `strategy.instances`, one `strategy.runs` through WP-040's repository
   functions (`registerMarket` → `createDefinition` → `createConfig` →
   `createInstance` → `startRun`). There is no CLI; `docs/handoffs/BOOT-1.md`
   and the acceptance test show the two-step shape. Point the trader config's
   `runId` at the minted run.
2. **Configure the gateway's `lifecycle` block** (`infra/compose/data-gateway/`)
   with a **verified `gammaMarketId`** for each configured market. Nothing checks
   that the id points at the market you think (`UNIV4-R1`: the venue does not
   document `conditionId` on the response, so a mis-pointed id opens this market
   on another's readiness, silently). Verify it by hand against
   `GET https://gamma-api.polymarket.com/markets/{id}` before the run.
3. **Decide on `BOOT1-R7` first**: a Redis outage HANGS the real trader process
   (measured 60 s+ without returning) instead of latching a halt — §4.2 is
   evidenced only against the in-memory feed. Either accept it for a supervised
   run or authorize a small `packages/event-bus` round for a receive bound.
4. Set `TRADER_HEALTH_BIND=127.0.0.1` / `TRADER_HEALTH_PORT` so the control API
   can read the trader (optional; `none` is the documented absence).
Then `docs/handoffs/GOV-2B-wave-2-closeout.md` H1 and the runbook §7 tell you
what evidence the run must produce. **Nothing here has contacted the live venue;
every "real" in the records means real PostgreSQL/Redis and a venue-shaped
stub.**

### H3 — dashboards, infra half
Load `infra/prometheus/control-api-scrape.yaml` into a real Prometheus (note the
`credentials_file` path; the example config's port 9465 collides with the
recorder scrape — the fragment targets 9466), provision a Grafana, import
`infra/grafana/control/*.json`, and look at "Realized PnL" with a trader running.
No test validates the fragment; no import has ever happened.

### H5 — a ruling: runbook :509 vs :514
Does ONE demonstrated live-data paper run discharge :509 ("Static Bracket runs
in … live-data paper mode"), or is the "meaningful live-data paper evidence" :514
describes a Wave 2 condition? The closeout could not decide it; the ledger row
`H5` waits on you.

### H8 — a ruling: the composition layer (closes B3)
`createPaperTrader`/`CoreLoop` live in `apps/trader`; `dependency-direction.md`
§2 says "Nothing may depend on an app", so the backtest executable cannot build
the core. Either move the composition below layer 3 (a package both roots can
depend on) or rule a cited §2.1 exception. The work plan itself created the
tension (`WP-230` assigns the assembly to the trader; `WP-210` promises the same
core from the CLI).

*(RULED 2026-09-28 by the user: **option A**. The core moves into a new layer-1
package that both roots build from, through three queued rounds: `H8-GOV` →
`CORE-MOVE` → `BACKTEST-2`. Until those land, B3 is ACCEPTED AS QUALIFIED
(interim), recorded with option C's wording in the ledger's B3 row. Scoping:
workflow `wf_b7a8d34d-4f9`.)*

### H4 — elapsed soak evidence
Wave 1's carry-over (`WP-140`), not a Wave 2 condition. `soak:evaluate` and
`soak:compare-books` have run nowhere (`G-03`); only `soak:smoke` is gated.

### H7 — ratifications
Recorded, not ruled: the four Wave 2 handoffs' field format (N6); the four
orchestrator root-wiring commits without recorded reviewer sign-off; the SER
confirming reviews run as Claude reviewers after Codex's content filter refused
the packet; `BACKTEST-1`'s one-line touch of the protected root `package.json`
(N11, ratified at merge by the orchestrator — your call whether that stands).

### Two register/ADR items surfaced by the venue gate
- **C-2 reopen condition met** (`VENUE-2` D-15): the venue now documents pUSD
  as an on-chain wrap of USDC.e. The register says such an assertion "authorizes
  an explicit recorded conversion, never a fold." Needs a dated ADR-006/register
  amendment — a governance round with `docs/adr/**` in grant.
- **U-11** (D-20): the SDK carries a closed five-value `UmaResolutionStatus`
  enum while the docs still say nullable string.

## 4. Optional rounds an agent could run next (not started; your call)

- **`TRDR-3-FU1`** (small): the `trader.ts` one-liner that makes the e2e golden's
  `realizedPnl` show `-1.2`; `connectionsCheckingInterval` so the health
  server's stated 5 s timeouts enforce at 5 s; three READMEs held stale by pins.
- **A `packages/event-bus` receive bound** for `BOOT1-R7` (before H1 if you want
  the halt guarantee).
- **`apps/trader` lifecycle rank-guard** (`UNIV4-R2`): a late `MarketClosing` or a
  replayed `MarketOpened` can regress a RESOLVED market to ACTIVE/CLOSE_ONLY.
- **The strategy round for §7 item 1**: give the protective reduce an order
  track so an instance survives its own exit and a take-profit can fill.
- **§5 item 6** (detector/tooling): unassigned since the SER sweep.

## 5. Things the records say plainly that a green board would hide

- The residual queue (32+ rows, `## Open blockers`) is now the ledger's
  authority for what is open, and **nothing checks it** — the same failure class
  `GOV-2C` recorded as N3. It must be maintained by hand on every merge.
- The durable ledger cannot group one fill's transactions (`BOOT-1` severing).
- `health.loop.decisionsPersisted` counts outbox appends before the write; it
  read **1 with zero rows persisted** (`BOOT1-R6`). Do not trust it on a dashboard
  until the next `loop.ts` round.
- A polled market state is a statement about the venue's catalog at poll time,
  not an observed closure event; a market closed between polls is seen up to
  one interval late (`UNIV4-R5`).
- Every "first" in these records is a first against real infrastructure and a
  venue-shaped stub. The venue has never been contacted by the trading path.

## 6. Where everything is

- `IMPLEMENTATION_STATUS.md` — rows for every round; `## Open blockers` (the
  blocker table, the residual queue, the human items); `## Pending external
  evidence` (CI; C-2); `## Deviations from specification` (N3, N6, N7, N9, N11).
- `docs/handoffs/GOV-2B-wave-2-closeout.md` — the audit; `docs/handoffs/{TRDR-2,
  RISK-2, GATE-1, GOV-2C, BACKTEST-1, BOOT-1, VENUE-2, TRDR-3, UNIV-4}.md` — one
  record per round, each with the eight required fields, the review verdicts,
  the mutation tables and the residuals.
- `docs/venue/verified-2026-09-16.md` — the phase-2 venue authority; D-30 is
  what `UNIV-4` was licensed to rely on.
- `git log --first-parent main` from `b9bacc1` (the audit's base) to here.
