# CLOSEOUT-2: Wave 2 closeout audit (runbook §10)

**Run date:** 2026-09-30. Read-only, on `main` at `8fde4df` (`8fde4dffa9546dc7570f1e53653242c568669c58`, which equals `origin/main`). The audit used a detached worktree, `polymarket-bot-closeout-2`.

**Seven agents took part:**

| Auditor | Scope |
|---|---|
| A-matrix | §10 steps 1-3: the acceptance matrix and the merge SHAs |
| B-checklist | the §7 checklist, B1-B10 and H1-H8 |
| C-gates | step 4: CI and the full local gates |
| D-drift | steps 5-8 |
| E-architecture | the second architectural-consistency pass (Codex) |
| F-critic | completeness critic |
| S-synthesis | this report |

No agent modified a tracked file. The Testcontainers and Ryuk containers were reaped, and `~/pmb-h1/` was only read. The source reports are in `scratchpad/closeout-2/{A-matrix,B-checklist,C-gates,D-drift,E-architecture,F-critic}.md`.

**What was audited:** the tree at `8fde4df`. LOGS-1, which is in flight, is not treated as drift.

**The user's rulings applied:**
- H5: one demonstrated live-data run discharges :509.
- H7: ratified.
- H8: option A.
- ADR-024 is provisionally accepted.
- THROUGHPUT-1c is scheduled after this closeout.

# VERDICT: WAVE 2 IS NOT CLOSED

**The wave is one fix away from closing.**
- **Every GOV-2B blocker is closed.** B1-B10 are all closed or closed with qualification.
- **Every gate is green.** 475 files and 9,805 tests pass locally, and CI run `36688059261` on `8fde4df` succeeded.
- **The H1 evidence holds up under re-derivation.** Five full 15-minute live windows ran with no trader halt on the audited code.
- **Six of the seven checklist items are MET**, outright or with qualification.

**What keeps it open is one seam in the shared core, found by the architectural pass (E-01) and re-verified by F and by me.**
- The loop sends an intent to the venue, harvests the fill and writes ledger rows before the decision that caused them is durable.
- If the store fails at that decision, the trader halts. By then, durable economic effects already exist with no persisted originating decision.
- This contradicts the handoff's pipeline order (§8.1, `docs/spec/polymarket-bot-orchestrator-handoff.md:674-685`, "persist DecisionResults → allocate → risk → plan → submit"), §6 invariants 3 and 4 (`:418-419`) and WP-230 acceptance criterion 4 ("Redis/PostgreSQL failures halt safely").
- No ADR records it.

It is closable by an agent, in one bounded round, or by an explicit user ruling. Either way, it must be settled before Wave 3's OMS (WP-270) builds signed-order persistence on this loop.

## The §7 exit checklist, item by item

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Full paper pipeline works end to end | **NOT MET** (blocker X1) | **Success path, evidenced:** the BRACKET-1c durable test (real PG, Redis, `assembleDurableTrader`, SHUTDOWN rebuild) passes 3/3, and so does BOOT-1's 9/9 (B). Live, gateway → Redis → trader → PG → control API → Prometheus → Grafana held five full windows (B, from `run-N/health-snapshots.jsonl`). **Not held:** the pipeline's own persistence stage. `packages/trading-core/src/trader.ts:300-303` persists a decision only by appending it to the in-memory outbox. `loop.ts:1152-1159` runs evaluate, then `#harvestFills`, then `#flushOutbox`. `loop.ts:1844-1850` commits only the *earlier* staged decisions before routing an intent. E's probe records `venue_submit → ledger_write ×2 → venue_submit → decision_refused`, with `persistedIntentDecisions=0`, `fills=1`, `transactions=2` and `halt=STORE_UNAVAILABLE`, in both the per-row and the group-commit arms (`E-probes/architecture-probes.log`). The live fill → ledger → PnL half has never run on live data (B-F1). |
| 2 | Replaying the same dataset produces identical results | **MET WITH QUALIFICATION** | `test:replay` passes 17/17 and the e2e `determinism-golden` 10/10 (A, C). The shipped backtest bundle, run twice under `env -i`, produced byte-identical artifacts (sha256 `0da3c56f…19fb3e`) that equal the committed golden (B). **Qualification:** every golden is a synthetic fixture (the backtest one has 8 events). The `run` command refuses every normalizer except `normalized-envelope/v1` (`apps/backtest-cli/src/assembly.ts:350-358`), so no live recording can be replayed today (E-3, F-G7). ADR-024 is provisional (L4). |
| 3 | Ledger rebuild equals incremental projections | **MET WITH QUALIFICATION** | e2e `projection-reconciliation` passes 12/12, `fold-held-equals-rebuilt` 3/3, and the BRACKET-1c SHUTDOWN rebuild passes (A, B). **Qualification:** the PAPER cadence turns the PnL check off (`packages/trading-core/src/folds.ts:130`). Durable ledger rows bind `fill_id`/`order_id` to NULL (`apps/trader/src/adapters/postgres-store.ts:487-491`, pinned at `durable-two-brackets-postgres-redis.test.ts:834`). There is no durable read path (R10). No live ledger entry exists. |
| 4 | Static Bracket runs in replay AND live-data paper mode, through the same code | **MET WITH QUALIFICATION** | **Same code:** both roots import `createPaperTrader` from `@polymarket-bot/trading-core` (`apps/trader/src/main.ts:158`; `apps/backtest-cli/src/assembly.ts:66-76`). `check:deps` passes (A, C, D, E). **Replay half:** reproduced byte for byte (B). **Live half:** under the H5 ruling, run 3 is the demonstration, with 216,494 decisions and the same number of checkpoints read back (`~/pmb-h1/run-3/readback.txt`). Runs 7 and 8 reached risk. **Qualifications:** live exits have never executed (B-F1). Live framing (ADR-024) differs from replay framing (M1). The realized-PnL health attachment differs between the two roots (D-02, TRDR3-R1). |
| 5 | Dashboards expose decisions, risk vetoes, simulated fills and PnL | **MET WITH QUALIFICATION** | **Reading applied:** "expose" means that the series are produced, scraped and queried by the panels. This is evidenced: <br>• real Prometheus target `up` (`run-3/h3/prometheus-targets.json`); <br>• three real Grafana imports `success`; <br>• all 93 dashboard series are literals in the exposition sources (F-G5); <br>• `trader_realized_pnl_info{exact_decimal}` is tested against real servers (`test/integration/control-api/trader-health-http-source.test.ts:147-183`); <br>• live decisions and the aggregate refusal step render (`run-7/h3/screenshots/trading-dashboard.png`). <br>**Qualifications:** <br>• no real Grafana has rendered a non-empty Fills or PnL panel; <br>• the per-code veto panel cannot show a code's first veto (N3). |
| 6 | No real signer is installed | **MET** | The lockfile has none of ethers, viem, web3, `@polymarket/*`, secp256k1 or `@noble`/`@scure` (B, D). The installed `node_modules/.pnpm` has none either (F-G7). `packages/polymarket-secure` and `packages/oms` are placeholders. acceptance-2 passes 23/23. |
| 7 | Maximum run mode remains PAPER | **MET** | `packages/trading-core/src/safety.ts:67,70`. acceptance-1 passes 15/15 and e2e safety-posture 17/17. Every H1 trader log prints `safety: OK — run mode PAPER, ceiling PAPER, real orders disabled` (B, D). |

## GOV-2B re-graded

| Id | Grade | Evidence |
|---|---|---|
| B1 pnl_snapshots column binding | CLOSED | `f3da220`; `durable-pnl-snapshot-postgres` 3/3 on real PG (B) |
| B2 protective exit refused as ENTRY | CLOSED | `133eac1`; the backtest artifact shows the cutoff reduce APPROVED and filled, `refusedExits=0` (B) |
| B3 replay half absent | CLOSED | `bb58edb` → `33b7d0b` → `fd12be0`; the golden was reproduced byte for byte (B) |
| B4 live half never run | CLOSED | H1 runs 3 and 5-8 on `8fde4df` (`commit.txt` for all seven runs; B, F-G7) |
| B5 dashboards | CLOSED WITH QUALIFICATION | Code: `da9c58e`. Infrastructure: real Prometheus and Grafana. Residuals: N3, and fill/PnL never rendered |
| B6 e2e not gated | CLOSED | `.github/workflows/ci.yml:113,120`; CI `36688059261` green |
| B7 audit exits 1 | CLOSED | `pnpm audit --audit-level high` exits 0 (B, C) |
| B8 ledger self-contradiction | CLOSED | `## Open blockers` is populated; new staleness is under L5 |
| B9 halt on first decision | CLOSED (first start) | `0d09eb5`; 9/9. Resume is still refused by design (R10) |
| B10 no lifecycle producer | CLOSED | `7c08af7`; live `SB.ARMED`, `SB.REFUSED_ENTRY_CUTOFF` and `SB.MARKET_CLOSED` in run 3's read-back |
| G-01 phase-2 venue gate | CLOSED | `docs/venue/verified-2026-09-16.md` (`d6aedee`) |
| R1-R9 | DISCHARGED | R1 TRDR-2, R2 RISK-2, R3 BACKTEST-1/2, R4 TRDR-3, R5 H3, R6/R7 GATE-1, R8 BOOT-1+TRDR-2+BRACKET-1c, R9 GOV-2C (F-G8) |
| R10 durable read path | OPEN | Owned only as "Wave 3", with no named round (status `B9` row; F-G8) |
| H1 live-data paper run | CLOSED, decisions and vetoes only | Runs 3 and 5-8. Run 1 halted fail-closed (`docs/handoffs/H1-RUN-1.md`) |
| H2 real CI | CLOSED | Run `36282501033`, and now `36688059261` on `8fde4df` |
| H3 real Grafana import | CLOSED WITH QUALIFICATION | `h3/`, `run-3/h3/`, `run-7/h3/`; qualified by N3 and the empty fill/PnL panels |
| H4 elapsed soak | OPEN; not a Wave 2 condition | Status: "Time-based soak evidence: None"; G-03 |
| H5 :509 vs :514 | CLOSED (ruled) | Satisfied by run 3 |
| H6 authorization and order | Ongoing by nature | The orchestrator's |
| H7 ratifications | CLOSED | Ratified 2026-09-28. Whether it covers the four handoffs merged that day is unstated (L2) |
| H8 composition layer | CLOSED (option A) | ADR-022 Accepted; the track merges are ancestors (A, D) |

## Blocking finding

**X1 (HIGH), from E-01: the current decision is not durable before its order and ledger effects.**

**Evidence:**
- **Code:** `trader.ts:300-303`, `loop.ts:1152-1159` (the frame path has the same order at `:1252-1262`), `loop.ts:1844-1850` and `loop.ts:2089` (the submit).
- **Handoff requirement:** `handoff:674-685` sets the order; its only escape clause, a "local journal/outbox … benchmarked" (`:688`), does not cover a volatile buffer flushed after the effects.
- **Records:** no ADR, handoff or residual row records the deviation. BOOT1-R6 (`IMPLEMENTATION_STATUS.md:2570`) covers only the counter (F-G1).
- **Reproduction:** E's probe, on the real `createPaperTrader`, `CoreLoop`, Static Bracket, risk, planner, simulated venue and ledger, with only the store port wrapped.
- **Why the existing tests miss it:** `acceptance-4-infrastructure-halts.test.ts:125-166` fails the store *before* the first event, so it never exercises this seam (E-2).

**Why it blocks, and why now:**
- It contradicts a Wave 2 acceptance criterion (WP-230 #4) and a handoff invariant with no recorded ruling. AGENTS.md forbids a silent override of the handoff.
- It is a composition seam that no per-package test sees. That is the GOV-2B pattern.
- It lives in `packages/trading-core`, which WP-270 (OMS and signed-order persistence) will extend.
- The cost of holding the wave is small. Closure releases only WP-260 (step 10 below), and GOV-2B made the same trade for B1.

**The agent-closable fix (one round in `packages/trading-core/**` plus tests):**
- Before any NEW placement is routed (the `loop.ts:1844` path), stage and commit the current callback's outbox entries, including the just-appended decision, through the group commit or the per-row path. Refuse and halt on failure.
- Keep emergency-cancellation priority.
- Add E's probe, in both arms, as a regression test: no `venue_submit` or `ledger_write` may occur before the originating decision is durable.
- Re-measure the THROUGHPUT-2 bench. Intents are rare (two in runs 2-8), so a cost near zero is expected; the round should measure it.

**The alternative:** the user records a ruling or ADR that accepts the ordering as PAPER-only, with a named owner and a deadline before WP-270. Only the user can make that choice. An auditor cannot.

## Non-blocking findings (each needs an owner recorded)

**MEDIUM**
- **N1 (E-02), live admission runs on event time.**
  - What happens: risk freshness, book age and seconds-to-close use `envelope.receivedAt` (`loop.ts:1051`, `:3780-3790`). The injected wall clock is used only for monotonic time.
  - Observed: E's probe approved two entries, and one filled, with the clock at 12:30 against a 12:15 close.
  - Why it does not block: it is masked live today, because check 6 (settlement) refuses first. It needs a design decision (an ADR) that keeps replay deterministic.
  - Required: resolve it before the settlement veto for any live market is lifted (N2) and before WP-270. It is distinct from THROUGHPUT-1c (F-G8.3).
  - A consequence F raised: a live paper fill would carry zero modelled decision latency.
- **N2 (B-F1), no owner for a reviewed `btc-15m-updown` settlement spec.**
  - Every live entry is vetoed `RISK_SETTLEMENT_UNVERIFIED` (`packages/risk/src/engine.ts:384`; runs 7 and 8), so post-closeout accumulation (:514) yields decisions and vetoes only.
  - B graded this HIGH. I grade it MEDIUM, because the veto is the specified fail-closed check; the gap is ownership, not a defect.
- **N3 (B-F2), the per-code veto panel misses a code's first veto.**
  - The series is born at 1 (`packages/observability/src/control/samples.ts:141-150`), so `increase(...)` reads 0 (`infra/grafana/control/trading-dashboard.json:68`). The same applies to the refused-exit and recommendation families.
  - Fix: emit known codes at 0, or change the query.
- **N4 (A-M1, as corrected by E-3), live and replay are not decision-equivalent on real data.**
  - Frame grouping is live-only. The CLI accepts only a normalizer that has no `causationId`.
  - `TP2-R1-L4` and `TP2-R2-L2` are unowned.
- **N5 (A-M2, D-11, B-F7, F-G3, F-G4), H1 evidence hygiene.**
  - Runs 2-8 are recorded only outside the repository.
  - The runs 2-8 manifest checks 97/98: `run-3/h3/grafana.log` is still being written by a live Grafana. I re-ran the check at 06:26.
  - Run 1's manifest fails on 2 logs.
  - The index says run 3's snapshot "ended early (166)". That is wrong: its last two snapshots are run 4's process on the same port.
- **N6 (B-F3), a dead upstream reads as healthy.** After the gateway's terminal overflow, run 4's trader showed `healthy:true` with no halt for 13+ minutes, with lag climbing to 769 s. THROUGHPUT-1c's scope does not cover it.
- **N7 (B-F4, D-05), capacity margin.** The peak backlog was 93,084 of 100,000 retention (run 8). THROUGHPUT-1a and THROUGHPUT-2 targets were not met, which was disclosed.
- **N8 (D-01), WP-240 M-3 and M-1 still open after 24 days.** An audit-log exhaustion path can disable the kill switch. This is a precondition for Wave 3.
- **N9 (D-04), halts are neither durable nor visible.** `OUT1-R1-HALT-NOT-DURABLE` and `H1R1-HALT-INVISIBLE`. This blocks sustained live-paper accumulation.
- **N10 (D-06), UNIV4-R1.** The lifecycle poll is attributed by request, not by content.
- **N11 (D-02), TRDR3-R1.** The backtest and e2e roots do not attach the realized-PnL health book; `TRDR-3-FU1` was never authorized.

**LOW / INFO**
- **L1:** the THROUGHPUT-1a, 1b and 2 review LOWs are unowned (A-L1).
- **L2:** DEPS-1 has no handoff, and 16 handoffs lack the eight required fields. Whether H7's scope covers the four handoffs merged on 2026-09-28 is unstated (A-L2).
- **L3:** stale CI step labels, the N5 class again: `ci.yml:189` says 4 of 14 files, and the data-gateway step says "no container" (A-L3, C-1).
- **L4:** ADR-024 is live without the precondition its own text set (A-L4, D-07). A user rejection would require re-grading items 2 and 4.
- **L5:** the status file is stale at `8fde4df`: the `Open blockers` header `1aa2238`, the B4 row "re-run after THROUGHPUT-1", and H7 "PARTLY DONE". LOGS-1 is expected to address this (B-F5, D-10).
- **L6:** the decision counts for runs 4-8 come from the pre-write counter (B-F6). Only run 3 has a DB read-back.
- **L7:** nothing mechanically keeps a signing library out of `packages/trading-core` (D-08). This becomes live with WP-260.
- **L8:** residual rows whose "next round touching X" trigger fired but was not taken, for example UNIV4-R2 (D-09).
- **L9:** WP-230 criterion 3 (the traceable chain) is evidenced in memory only, because the durable `fill_id` is NULL (F-G1).
- **I1:** WP-240 M-3 was read from code and not reproduced. `test:soak-smoke` and the Python workspace were covered by CI only (F-G8.4).

## Where the auditors disagreed, and how I resolved it

1. **E (INCONSISTENT) against A, B and C (green or qualified).** I re-read the cited lines and the probe log, and E-01 and E-02 stand. A's "MET" for WP-230 #4 rested on tests that fail the store before the first event. I ruled E-01 BLOCKING (X1) and E-02 non-blocking but owner-required (N1), because E-02 is unreachable live under the settlement veto and needs a design decision, not a bug fix.
2. **The runs 2-8 checksums: B said 98/98; A, D and F said 97/98.** I re-ran the check and got 97/98. The failure is a live Grafana log (the file's mtime is after the manifest's), so it is benign. B checked before Grafana's next append.
3. **Did run 3 cover its window?** B said yes; E called the counter unsuitable. F found that the last two snapshots belong to run 4, and the read-back shows 216,494 decisions from 08:43:48 to 09:15:43. B is right, and the index is wrong (N5).
4. **Replaying a live recording.** A-M1 said a replay would use different framing. E and F showed that the CLI refuses raw normalizers entirely (`assembly.ts:350-358`). I adopted the stronger, corrected statement.
5. **Backtest PnL.** D said replay reports no realized PnL. E showed that only the health aggregate is null, and that PnL snapshots are computed and golden-tested. I adopted E's narrower reading.
6. **Item 4's live half.** A-M3 and B-F1 note that no live fill exists; E says the H5 ruling covers the item. Under H5, item 4 is MET WITH QUALIFICATION. The missing fill bears on item 5's render and on N2, not on item 4.
7. **D's drift baseline (`1aa2238` rather than GOV-2B's `b9bacc1`).** F checked the gap. Its only protected-path touch is GATE-1 `b470880`, which was recorded and reviewed. There is no unratified drift.

## Runbook §10 step 10: exact packages now unblocked

**None, while the verdict is NOT CLOSED.**

From the parsed `depends_on` graph (`docs/spec/polymarket-bot-workplan.yaml`):
- **On closure, exactly one package is released: `WP-260`** (phase-3, gate `security-review`).
  - Its dependencies, WP-000, WP-020 and WP-030, are all merged. It is held only by wave ordering and the signer boundary.
  - Preconditions to attach:
    - the phase-3 venue gate is open (`docs/venue/verified-2026-09-30.md`, VENUE-3 `6a15131`);
    - L7 (a mechanical guard keeping signing libraries out of `trading-core`) lands with or before it;
    - X1 is settled, and N1 and N8 are owned before WP-270.
- **Nothing else.**
  - The Wave 2 dependents all also need WP-260: WP-270 (WP-190, WP-200, WP-260), WP-300 (WP-200, WP-260) and WP-290 (WP-200, WP-270, WP-280).
  - WP-280, WP-310, WP-320, WP-330 and WP-340 are transitively behind WP-260.
  - WP-350, WP-360 and WP-370 are behind WP-340 and WP-350.
- THROUGHPUT-1c and the X1 fix round are not YAML packages, so closure does not gate them.

## What closes the wave

1. An X1 round, implemented by an agent and reviewed adversarially, merged, with E's probe kept as a regression test. Alternatively, a user ruling or ADR accepting the ordering as PAPER-only, with a pre-WP-270 owner.
2. A short re-check of item 1 against that merge: the gates, plus the probe.

No other re-audit is needed. The other six items and B1-B10 stand as graded here.

## Audit confidence

**HIGH** on the gates, the merge SHAs, items 6 and 7, and the B1-B10 re-grade. Each was executed or re-derived independently by at least two auditors.

**HIGH** on X1's facts: the code was re-read by E, F and S, and the probe was reproduced in two arms. A physical PostgreSQL outage at that point was not exercised; the store port was wrapped instead.

**MEDIUM** on grading X1 as blocking rather than recordable. That is a judgement call, and the user may overrule it with a recorded ruling.
