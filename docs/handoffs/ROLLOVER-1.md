# ROLLOVER-1: ADR-030 series auto-admission and multi-window runs

**Status:** Complete (2026-10-05). Merged `ae11daa` (PR #68; CI run `37319841404` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 8 on `61a0ab2`.
**History:**
- **2026-10-03:** the first implementer stopped before any change on B1–B3 (`~/pmb-rounds/rollover-1/handoff-r0-stop.md`).
- **2026-10-04:** the user ruled Q1–Q4, and `VENUE-SETL-1` recorded the Q3 facts.
- **The relaunch (base `d88624f`)** reached joint ACCEPT at round 6 on `bdd76a6`.
- **The merge with `main`** (`95a0b76`, bringing in `CAP-1`) had a focused review in rounds 7 and 8.

**Paths:**
- the work plan's (`apps/data-gateway/src/**`, `apps/trader/src/**`, `packages/trading-core/**`, `packages/universe/**`, `packages/polymarket-public/src/**`, and their tests);
- the user's grants: `packages/domain/**`, only for `SeriesWindowAdmitted@1`; `packages/strategy-runtime/**`, only for the run sequence.

**Posture:** PAPER and BACKTEST only. Admission refuses every other mode.

## summary

1. **Gateway admission:**
   - **Configuration:** a reviewed `seriesAdmission` block, hashed by sha256 over its canonical JSON.
   - **Discovery:** only the documented `GET /events/keyset` (`series_id`, closed, order, ascending, limit, `end_date_min`, `after_cursor`) and `GET /clob-markets/{condition_id}`. Every response is journaled to the WAL before anything is derived from it.
   - **The exact-match judge:** pattern and reviewed parameters must match exactly. Per-window facts are checked for presence and form only (ADR-030 D1.2).
     - The schedule comes from the title's ET range, which must be exactly one 900 s interval; the 2026-11-01 DST repeat is refused.
     - Outcomes pair with token ids by the documented index.
     - `negRisk` must be `false`.
   - **Refusals** are written to a ledger, then raise an incident.
   - **Admission:**
     - it is written as an intent first;
     - then one frame publishes `MarketDiscovered@1`, `TradingParametersChanged@1` and `SeriesWindowAdmitted@1`;
     - the window is confirmed and attached (subscribe plus lifecycle) only after all three publish.
   - **The concurrent-window cap and teardown** (on resolution, or on an unresolved timeout) are enforced.
2. **`SeriesWindowAdmitted@1`** (Q1, `packages/domain`): `{internalMarketId, conditionId, seriesId, seriesConfigHash, yesTokenId, noTokenId, scheduledOpenAt, scheduledCloseAt}`, plus justified fields.
3. **Trader:**
   - each admission is re-judged against the run's own review (hash, a matching discovery, token form, schedule, derived id, tick, shadowing and cap);
   - catalog rows are written under the derived window id before attach, and a failed write is a global `STORE_UNAVAILABLE` halt;
   - each window gets its own runtime, all on the instance's single run sequence (Q2);
   - idle windows are torn down at a frame close on event time, but never while an allocator commitment names the market (R7-FABLE-03);
   - checkpoint rows carry `market_id`.
4. **Q4:** `{strategy, series}` is pinned in `strategy.configs.parameters`. BOOT-1 compares it by name, and `register --series` registers a series-bound instance and run.
5. **`CAP-1` across windows** (R7-FABLE-01). Risk checks 16 and 17 judge a placement over every live window of the strategy instance: booked positions, working orders, unbooked fills and each window's own mark. A missing mark fails closed.
6. **A gateway defect found and fixed:** market-less admission incidents would have tainted every book of the epoch (ADR-023 D2 rule 4).

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 0 (first) | — | STOPPED | B1: no event carried a window's times. B2: per-window runtimes collided. B3: the venue facts were missing. The user ruled Q1–Q4 |
| 1 | `bfe5256` | CHANGES REQUIRED | 3 HIGHs and 3 MEDIUMs |
| 2–5 | `4d1f351` … `d660427` | CHANGES REQUIRED | 2 MEDIUMs in each of rounds 2–4; 1 HIGH in round 5 |
| 6 | `bdd76a6` | **ACCEPT** | LOWs only |
| 7 (merge) | `95a0b76` | CHANGES REQUIRED | R7-FABLE-01 MEDIUM: checks 16 and 17 ran per window, not per strategy instance |
| 8 | `61a0ab2` | **ACCEPT** | none |

Round 8's astra verifier first failed on an API overload (529). The orchestrator resumed it.

## tests_run
- **Final tree `1340474`** (the round-8 implementer and the orchestrator), all exit 0:
  - typecheck, lint and check:deps;
  - unit: 11,211;
  - e2e: 216;
  - replay: 19;
  - contract: 1,112;
  - fault: 848.
- **Integration suites:**

  | Suite | Files / tests |
  |---|---|
  | trader | 49 / 403 |
  | data-gateway | 16 / 149 |
  | event-bus | 10 / 112 |
  | control-api (CONTROL-1b's whole-repo guard) | 22 / 310 |
  | control-api PostgreSQL | 4 / 31 |
  | research-worker | 43 tests |
  | storage-postgres | 228 tests |

- **Mutation:** round 7's table killed 13 of 13, and every earlier table, re-run, kills each applicable row.
- **CI:** GitHub CI on the PR #68 merge ref was green before the merge.

## known_risks
- **R2-FABLE-03.** The dated ADR-030 policy amendment is owed: cap policy, retirement on publication and resolution finality, named operator retirement, and the flat/idle and halt-suppression teardown exceptions.
- **R1-FABLE-06.** The governance records for `SeriesWindowAdmitted@1` are owed: the event count in `docs/contracts/domain.md`, `protected-contracts.md`, and the work plan's dated Q1 exception.
- **R1-FABLE-03(b).** The timestamp-0 UUIDv7 `incidentReferenceId` for a market-less scope needs an ADR-023 ruling.
- **Dated observations can change without notice:** the Gamma field meanings and the ET title format.

## follow_up
1. **The orchestrator:** the three governance items above, as a docs round.
2. **`SCALE-8`:** now unblocked by ROLLOVER-1, but it waits on `BURN-IN`.
3. **The settlement-review recording round** (`VENUE-SETL-1` gaps G-1 to G-7), and the RTDS retirement, can start now that `apps/trader` and `apps/data-gateway` are free.

## commit_sha
`61a0ab2`
