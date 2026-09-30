# H1 runs 2–8 — live-data PAPER runs after THROUGHPUT-1a/1b/2

**Outcome:** H1 is discharged under the H5 ruling (graded by `CLOSEOUT-2`): decisions and risk vetoes, but no fill. Reviewer: the `CLOSEOUT-2` auditors.
**Evidence** is outside the repository in `~/pmb-h1/` (`EVIDENCE-RUNS-2-8.md`, `SHA256SUMS-runs-2-8`, `run-N/`). Run 1: [`H1-RUN-1.md`](H1-RUN-1.md).

**Code:** `main` at `7d59fd3` and later; see each run's `commit.txt`. **Posture:** PAPER only on every process; public venue data only; no wallet, signer, key or credential.
**Market facts:** every run's market was cross-verified, Gamma against CLOB, in its `market-verification.txt`. Every run was registered by the REGISTER-1 command (`register.stdout`) with the shipped strategy parameters, unchanged.
**Driver:** runs 4–8 were run by `~/pmb-h1/driver.py`, one fresh run per window; its log is `driver.log`. From run 6 on, the gateway's publisher bounds were raised to 16,384 events / 64 MiB, the documented operator-tunable safety bounds, after run 4's overflow.

## Results

| Run | Window (UTC) | Decisions | Risk evals | Refusals | Fills | Max event-time lag | Max entries behind | Trader halts | Gateway publication halt |
|---|---|---|---|---|---|---|---|---|---|
| 2 | 08:45–09:00 | 78,319 (pre-window only) | 0 | — | 0 | 18 s | 2,819 | 0 | no (lost to a tooling limit, see below) |
| 3 | 09:00–09:15 | 216,494 (read-back) | 0 | — | 0 | 43 s | 28,991 | 0 | no |
| 4 | 09:30–09:45 | 93,407 | 0 | — | 0 | 120 s in-window (845 s after the gateway stopped) | 74,777 | 0 | **YES**, `GATEWAY_PUBLISH_ADMISSION_OVERFLOW` at about 09:32:17 (default 1,024 bound) |
| 5 | 10:00–10:15 | 239,795 | 0 | — | 0 | 84 s | 59,032 | 0 | no (default bounds) |
| 6 | 10:30–10:45 | 260,521 | 0 | — | 0 | 38 s | 29,442 | 0 | no |
| 7 | 11:00–11:15 | 189,828 | **1** | `RISK_SETTLEMENT_UNVERIFIED` 1 | 0 | 23 s | 16,473 | 0 | no |
| 8 | 11:30–11:45 | 331,630 | **1** | `RISK_SETTLEMENT_UNVERIFIED` 1 | 0 | 153 s | 93,084 | 0 | no |

## What this shows
- **The full live pipeline held through five complete 15-minute windows** (runs 3, 5, 6, 7, 8). That is gateway → Redis → trader → PostgreSQL → health → control API → Prometheus → Grafana, with no trader halt, and every run caught back up to 0 behind after its window.
- **Live entries happened and were vetoed correctly.** Runs 7 and 8 each produced one real entry intent: `SB.ENTRY_TRIGGER_MET` → `SB.ENTRY_INTENT_EMITTED`. The risk engine refused both with `RISK_SETTLEMENT_UNVERIFIED`. The veto is visible on the trading dashboard (`run-7/h3/screenshots/trading-dashboard.png`).
- **No fill is possible under the truthful configuration.** The shipped trader config sets `settlementReadiness.modelDependentActivationAllowed: false`, because `btc-15m-updown` has no human-reviewed settlement specification in this repository (`apps/trader/README.md` ~:257). Under `false`, §9.8 check 6 refuses every entry. So no live paper fill, and no PnL, can occur until a settlement spec is reviewed; the orchestrator did not flip the flag. In runs 3–5 the market never reached the 0.35 trigger at all (Up's minimum was 0.475–0.535; every window resolved Up).
- **Throughput is still marginal at the window open.** Peak lag was 23–153 s, and the backlog reached 93,084 of the 100,000-event retention (run 8). The stream carried about 1,100 events/s at some window opens, against about 800 events/s of trader throughput after THROUGHPUT-2.
- **The gateway overflowed once (run 4)** at the default 1,024-envelope admission bound, fail-closed with recording continuing. The oldest queued entry was 903 ms old; the cause is not diagnosed (Redis showed no save or fork near 09:32:17).

## Operational notes
- **Run 2 was lost to a tooling limit.** The orchestrator's background-process tool kills its children after 30 minutes, so run 2's processes died at 08:42. Since THROUGHPUT-1a a run that holds decisions cannot be resumed (`TRADER_REGISTRATION_RUN_NOT_RESUMABLE`, fail-closed and by design), so run 3 was registered fresh. Every later process ran detached (`setsid`).
- The run-3 row in `runs-2-8-table.md` shows 166 decisions; `run-3/readback.txt` holds the true count, 216,494.
  Corrected 2026-09-30 (CLOSEOUT-2 N5): was "its snapshot file ended early". Run 3's last two snapshots belong to run 4's process.
- The dashboards: `run-3/h3/screenshots/` and `run-7/h3/screenshots/`. Prometheus targets: `run-3/h3/prometheus-targets.json`.
