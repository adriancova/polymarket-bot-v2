# LEAN-1: a low-cost first deployment, under $100 a month

- Round: LEAN-1, read-only planning. Base: `main` `2a196ec`. No tracked file was edited.
- Inputs: three plans (P1-laptop, P2-cloud, P3-hybrid) and two reviews (JUDGE-OPUS, JUDGE-ASTRA).
- Status: a proposal for you to rule on. Nothing is authorized, built or measured on the target host yet.
- Safety is unchanged: `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, both `LIVE_MICRO_*` caps 0. No wallet, signer or credential is used. Public data only.
- Prices marked "checked" were read from the provider's page by a reviewer on 2026-09-30. All other prices are unverified estimates.

## 1. Recommendation

Run the first deployment on a computer you own, not in the cloud.
- **What runs:** the same five processes, PostgreSQL and Redis, under Linux (WSL2 Ubuntu with systemd, no Docker Desktop).
- **What the cloud does:** Backblaze B2 holds backups and research data, and a free dead-man check watches the machine from outside.
- **Expected bill:** about **$3-20/month at 1-2 markets** and **$5-30/month at 8 markets**. Electricity is almost all of it.
- **How the data shrinks:** evaluate each market at most once per second, keep raw data for 72 hours, and keep two things long term: a downsampled research tier, and exact copies of every window that had a trade decision.
- **The architecture stays.** No SQLite, no merged process and no Redis replacement: none of them saves money on hardware you own.
- **The cloud exit is ready.** The same Linux build runs on a Hetzner server for about $15-35/month. A $1 benchmark decides between the two before launch.
- **First launch:** one BTC 15-minute market. The system cannot yet follow markets from one window to the next without restarts, so a second market and any 5-minute market wait for one more round (ROLLOVER-1).

## 2. Where the two reviewers disagreed, and what I decided

| Question | JUDGE-OPUS | JUDGE-ASTRA | Decision and reason |
|---|---|---|---|
| Host | your laptop (P1) | a Hetzner CX33 (P2) | **Your own machine first; the cloud is the priced exit.** You offered the machine. Compute is free. Its 1 TB disk holds 72 h of raw data and the pinned windows; the 80 GB cloud disk cannot. The trader uses one CPU core, and a laptop performance core is probably faster than a shared cloud vCPU. That is unmeasured, so HOST-BENCH tests both for about $1. Astra's robustness point stands as risk 3. |
| Lossless raw archive | optional, as a ruling | keep it at first | **No bulk archive by default.** You accepted losing exact replay. A 90-day archive means uploading 11-45 GB a day from home and costs $7-56/month at 8 markets, depending on an unmeasured compression ratio. It stays available as ruling A3b. |
| Audit evidence after raw expiry | ±30 s slices when over a cap | slices are not exact replay | **Whole windows by default.** A window with an intent, a fill, a refusal or a halt is kept whole, with a lead-in of the reference feeds. Fill windows are kept forever and never fall back. Other windows fall back to slices, labelled "partial", only above a daily budget. |
| Database backup | (P1/P3: daily incremental exports) | full nightly dumps while small | **Full nightly dumps.** The database stays under about 20 GB for months 1-3, and incremental exports have consistency traps. |
| Restore drill | monthly | before unattended launch | **Before launch.** A backup nobody has restored is not a backup. |
| Evaluation interval | 1,000 ms | 1,000 ms | 1,000 ms by default (P3 proposed 500 ms), set per run and pinned in the run manifest. |
| Rollover | launch-blocking | launch-blocking | **It blocks the second market, not the first.** H1 runs 3 and 5-8 each held a full window under a restart-per-window driver. That driver is enough for one 15-minute market. |

Two factual corrections to the plans, confirmed by both reviewers:
- P2's "trailing evaluation on the gateway's 1 s tick" does not exist. That tick drives WAL and feed maintenance only. Quiet periods simply wait for the next event.
- P3's profile scope "PAPER and SHADOW" is wrong. The profile is PAPER only.

## 3. Topology

```text
Your machine (the ASUS TUF F15; or the Ryzen 9 7900 desktop, if it is yours: see §10)
  Windows 11 Home, on AC power, Ethernet preferred, sleep off
  └─ WSL2 Ubuntu, systemd, sparse disk, about 10-12 GB RAM
     ├─ postgresql 16, redis 7           (127.0.0.1 only)
     ├─ data-gateway  → WAL on ext4      (maxTotalBytes hard stop set)
     ├─ trader (PAPER)                    (a new run at every start, as today)
     ├─ research-worker                   (downsample → pin → expire, on a timer)
     ├─ control-api                       (127.0.0.1 + Tailscale only)
     ├─ prometheus (15 days)
     ├─ backup timer                      (nightly pg_dump + research + pins → B2)
     └─ dead-man timer                    (pings only when the trader is healthy)
Cloud, free or nearly free:
  Backblaze B2 (encrypted; a bucket key that cannot delete) · healthchecks.io
  · ntfy or Telegram alerts · Tailscale · Grafana Cloud free tier (optional)
```

- **Kept:** the five processes of §4.1, PostgreSQL, Redis Streams and the shared trading core (ADR-022). Wave 3 assumes PostgreSQL and Redis, so replacing either would also fork Wave 3.
- **Scaling to 8 markets:** one gateway and one trader first. If one trader cannot keep up, run one trader per asset group, in PAPER only. That needs ruling A6.
- **Cloud exit:** the same systemd units on Ubuntu at Hetzner (Helsinki). Nothing in the design is Windows-specific except the boot task.

## 4. Recording and retention

Volumes are measured on one BTC 15-minute market (H1 runs 6 and 8). About 12-14 GB/day belongs to each market and about 6 GB/day to each reference asset (Binance + Coinbase + Chainlink), which markets of the same asset share. 8 markets means 4 assets × (5-minute + 15-minute). The 8-market figures assume every market is as busy as BTC 15-minute, so they are upper bounds.

| Tier | What | Resolution | Where | Kept for | Per day: 1 / 2 / 8 markets |
|---|---|---|---|---|---|
| **Raw WAL** | every frame, exactly as today | exact | local disk | **72 h** at 1-2 markets; 24-36 h at 8. Deleted only after the research tier and pins are verified | 18-20 / 30-34 / 119-135 GB flowing through. On disk: 55-100 GB at 1-2 markets; 120-200 GB at 8 |
| **Pinned windows** | the whole market window with an intent, a fill, a refusal, a halt or an operator pin, plus the reference feeds over the window and a lead-in (about 15 min; set to the longest feature lookback) | exact (lossless Parquet from the existing compactor) | local + B2 | **fills: forever.** Intents, refusals and halts: 30 days, then the decision rows and the research tier remain. Operator pins: until removed | about 85-90 MB per pinned window (assumed 3× compression). Today about 1 window in 3 has an intent, so about 2.5 GB/day per 15-minute market. A daily budget alarm fires above 3 GB/day at 1-2 markets and 6 GB/day at 8. Fills never fall back to slices |
| **Research tier** (approximate) | per token: top of book with sizes on change, at most every 1 s, plus 5 levels a side every 1 s; a full book every 60 s; every trade; lifecycle and incidents. Per asset: 1 s bars from Binance and Coinbase trades, and every Chainlink tick | downsampled | local + B2 | **forever** | 5-20 MB per market + 2-10 MB per asset: under 0.05 / 0.06 / 0.2 GB |
| **PostgreSQL** | as today, but at most one `onFeatures` decision per market per second. Every other callback, intent, risk result, order, fill and ledger row is unchanged | per evaluation | local | all of months 1-3 | ≤ 105 MB per market with today's checkpoints; ≤ 50 MB after CKPT-1. Down from about 11.7 GB/day today |
| **Database backup** | a full nightly `pg_dump -Fc` | — | B2 | 7 daily + 4 weekly | one dump of about 2-10 GB by month 3 at 1-2 markets, before compression |
| **Metrics and logs** | Prometheus at 15 s; journald | — | local; an allow-listed health set off-host | 15 days; 7 days capped at 5 GB | 20-100 MB (estimate) |

What you keep after 72 hours:
- **Every fill:** exact replay and a byte-exact trace to its source frame, forever (§6 invariant 4 intact).
- **Every intent or refusal:** exact replay for 30 days; after that, the decision row, feature snapshot, source event id and the research tier.
- **Everything else:** approximate replay from the research tier. It cannot show queue position or sub-second moves.

## 5. Cost

### 5.1 Months 1-3, 1-2 markets, on your machine

| Item | Monthly | Notes |
|---|---|---|
| Compute | $0 | owned |
| Electricity | **$2-18** (probably under $8) | 35-70 W for 730 h = 26-51 kWh, at $0.06-0.35/kWh. The CFE tariff and the wattage are unverified. A $10 plug meter settles it |
| Backblaze B2 | $0-1 | up to about 125 GB by month 3 (pins, research, dumps) at $6.95/TB-month (checked); the first 10 GB are free |
| healthchecks.io, Tailscale, ntfy/Telegram | $0 | free tiers; 20 free checks (checked) |
| Grafana Cloud | $0 | optional free tier with a strict series allow-list; paid starts at $19 (checked). Local Grafana over Tailscale is the fallback |
| Internet | $0 extra | assumes no data cap; the feed is about 0.5-0.9 TB/month inbound |
| **Total** | **about $3-20** | |
| One-off, optional | $1 benchmark; $40-80 router UPS; $10 watt meter; $25 cooling pad | a purchase counts in the month it is made; each month stays under $100 |

### 5.2 At 8 markets

| Host | Monthly | Notes |
|---|---|---|
| Your machine | **about $5-30** | 50-90 W = $2-23 of electricity; B2 $1-3 |
| Cloud exit, 1-2 markets: Hetzner CX33 | about $15-35 | CX33 $9.99 (checked) + IPv4 + 20% backups + B2 + possible VAT. Raw retention drops to about 24 h on its 80 GB disk |
| Cloud exit, if a shared vCPU is too slow: CCX13 (dedicated) | about $55-65 | CCX13 $50.49 (checked) |
| Cloud exit, 8 markets: CX43 + 100 GB volume | about $30-45; $65-80 with a 90-day raw archive | CX43 $18.49 (checked); volume price unverified |
| AWS (for comparison) | about $70-87 at 2 markets; about $175-180 at 8 | recalled list prices, unverified. Rejected |

### 5.3 What happens past $100

Nothing scales up by itself. Before any step whose forecast exceeds **$80/month** (an internal ceiling below your $100), I stop and bring you the options:
- stay at fewer markets;
- shorten the intent-pin horizon (a ruling);
- or approve a new cost ceiling.

Evidence is never deleted to meet a budget. The known ways past $100:
- a dedicated Hetzner CCX23 ($101.49 on its own, checked);
- a raw archive at poor compression (about $56/month at 8 markets at 1.5×);
- any AWS host at 8 markets.

## 6. Rulings you need to make

Each is a yes/no. Each becomes an ADR (numbered from ADR-025; ADR-023 is reserved for THROUGHPUT-1c). My recommendation is in brackets.

| # | Ruling | What it amends | Trade-off in one line | Blocks |
|---|---|---|---|---|
| **H** | Deploy months 1-3 on a machine you own, PAPER only, all processes on one host, with the Redis retention raised to the measured need (for example 500k-1M events). **[Yes]** | A profile ADR. It records: §4.2 shared fate on one host; the §9.1 p99 measured on this host; the filesystem store plus B2 as §2's "object storage"; the ADR-003 retention value, which is a safety parameter | $0 compute, but a home machine has more outages than a data centre | launch |
| **A1** | Evaluate each market at most once per 1 s of event time: whenever any event touched it, plus a 5 s heartbeat when quiet. Fills, order updates, lifecycle and stop callbacks are never delayed. **[Yes]** | ADR-024 D3 and its Consequences; §8.1's per-frame reading. §6 invariant 3 and §7.5 stay: a skipped evaluation is not a callback (WP-170 REFUSED precedent) | about 250× fewer decision rows and most of the evaluation CPU (evaluation was about 83% of trader CPU), but the strategy reacts up to about 1 s later: a new strategy behaviour, not comparable with H1 runs | launch |
| **A2** | Save a strategy checkpoint only on a defined transition (a state change, a status change, start and stop), plus a 60 s heartbeat. It must keep the RNG cursor and callback sequence recoverable. **[Yes]** | No spec text: §9.6 and ADR-005 already say "after defined transitions". It re-pins WP-170 item 4 and the OUTAGE-2 and DURABLE-1 checkpoint tests | halves the database again; recovery design must be reviewed | nothing (after A1 it is an optimisation) |
| **A3** | Delete raw WAL after 72 h, once the research tier and every pin covering it are verified. Keep fill windows forever and intent, refusal and halt windows for 30 days. Never evict a fill pin to meet a cap. **[Yes]** | §2 "Raw archive"; §9.1 and ADR-004 §5 "never deletes … until Parquet upload"; ADR-017 §4 (a new receipt basis; manifests stay immutable); §8.4 and §12.5 manifest pinning; §12.4 determinism scope; WP-130 acceptance | disk stays bounded for about $0, but exact replay of a quiet stretch older than 3 days is gone for good | launch |
| **A3b** | Also keep a 90-day lossless raw archive on B2, in the existing Parquet format. **[No, for now]** | none beyond A3 | exact replay for 90 days, for about $7/month at 2 markets and $28-56 at 8, plus 11-45 GB/day of home upload | — |
| **A4** | Add an "approximate" dataset class built from the research tier, never admissible as determinism, calibration or promotion evidence. **[Yes]** | §8.4, §12.4-12.5; a `fidelity` field in the ADR-017 manifest (a version bump); ranked below everything in ADR-012; §6 invariant 15 kept at sample resolution | cheap backtests of new ideas; they can overstate an edge | research only |
| **A5** | A reviewed series (for example `btc-15m-updown`) admits each new window automatically, in PAPER only. Sub-ruling: one run spans many windows **[Yes]** rather than one run per window. **[Yes]** | §9.2 "Discover current and upcoming crypto markets" against "not auto-approved for live trading"; ADR-009; the gateway's "no discovery" contract; run-manifest and run-boundary semantics | continuous operation with no restart at each window open; admission logic becomes safety-relevant code | the second market and every 5-minute market |
| **A6** | Only if SCALE-8 shows one trader cannot carry 8 markets: several PAPER traders, one per asset group, superseded before any live mode. **[Decide later]** | §2 "Process shape" and "Active trader"; §4 single active trading process; §6 invariant 16, ADR-008 and ADR-011 for live | 8 markets fit one machine, but the topology differs from the future live one | growth past 2-4 markets |
| — | Not proposed: collapsing hold decisions (§6 invariant 3, §7.5, §10.3, ADR-005 §2), SQLite, one process, or an in-process queue. **[No]** | — | they save no money on owned hardware and would fork Wave 3 | — |

One decision outside LEAN affects what you will see:
- **No PAPER fill is possible yet.** Every entry is vetoed until a `btc-15m-updown` settlement spec is reviewed (CLOSEOUT-2 N2, no owner).
- Without that spec, three months of running produce intents and refusals, but no trades to audit.
- `CO2-N1` must also close before that veto is lifted.

## 7. Rounds, in order

- **Running now:** WP-260 owns `packages/polymarket-secure/**`. No LEAN round touches it.
- **Also running:** THROUGHPUT-1c owns `packages/trading-core`, `features`, `risk`, `strategies/static-bracket`, `apps/data-gateway`, `apps/trader/src` and `apps/backtest-cli/src`. Rounds marked **after 1c** wait for its merge.
- **Before any code round:** the rulings, written as ADRs and work-plan rows. This step is docs only and blocks every round below. It edits the brief, which the two running packages also update, so those edits are made one at a time.

| # | Round | Scope | Blocks launch? | Overlaps running work? |
|---|---|---|---|---|
| 1 | **STORAGE-1** | In `apps/research-worker` and `packages/storage-parquet`: the research-tier writer; pin classes (whole window + lead-in); the verified-extract expiry policy with its new receipt basis; "never expire what is not extracted or is pinned"; `maxTotalBytes`; disk, pin-budget and expiry-lag metrics. It can land in two parts: extract and pin first, then expire | **Yes** | No |
| 2 | **HOST-BENCH** (measurement only; runs alongside round 1) | See §9. The trader bench on the H1 burst fixture on your machine and on a $1 hourly CX33; a 24 h multi-market recording; watts, free disk, ISP cap, compression ratios | **Yes**: it picks the host | No |
| 3 | **CADENCE-1** | Ruling A1 in `packages/trading-core`, driven by event time only, with a per-run setting pinned in the manifest, an `evaluationsCoalesced` counter, and every golden change explained | **Yes** | **After 1c** (same package) |
| 4 | **HOST-1** | A new `infra/host-wsl2/`: systemd units; the boot task; a halt-aware restart map (a configuration or accounting halt pages you and never loops into new runs); the productised one-market driver; chrony and a clock-skew alert; the dead-man and alert rules; B2 backup and a real restore drill | **Yes** | No |
| 5 | **BURN-IN** | 72 h supervised on one BTC 15-minute market, with fault drills: pull the network, kill each process, `wsl --shutdown`, reboot Windows, pull the power cord. It can count toward H4 only through the runbook §7 procedure | **Yes**: this is the launch gate | No |
| — | **Launch: 1 market** | | | |
| 6 | **ROLLOVER-1** | Ruling A5: series admission of each new window in the gateway and the trader without a restart; teardown of closed windows | No; it blocks the second market and 5-minute markets | **After 1c** (`apps/data-gateway`, `apps/trader`) |
| 7 | **CKPT-1** | Ruling A2 in `packages/strategy-runtime` and the store adapter; also closes DURABLE-1 LOW-3 | No; recommended before 8 markets | Path check needed (goldens under `test/**`) |
| 8 | **APPROX-REPLAY-1** | Ruling A4: a `backtest-cli` source over the research tier, labelled approximate | No | **After 1c** (`apps/backtest-cli`) |
| 9 | **SCALE-8** | Grow 1 → 2 → 4 → 8 markets, with measurements at aligned window opens, during compaction and during backups. It may bring ruling A6. "Fewer than 8 on one machine" is an acceptable answer | No; it blocks growth past 2 | No |
| opt. | **REFDIET** | Lower-rate or no Binance `bookTicker` (24% of raw bytes, 1.2% price changes), if the features allow; a feature-version bump | No | **After 1c** (`packages/features`) |

## 8. Operations

- **Windows settings:** on AC, sleep never, lid "do nothing", hibernate off, "Best performance" mode. Battery charge limit 60-80% if the model supports it. Ethernet, with NIC power saving off. Vents clear.
- **Boot:** a Task Scheduler task at startup starts WSL and `pmb.target`. Starting without a logged-in user must be tested in BURN-IN; auto-logon is the weaker fallback.
- **Windows Update:** widest active hours; install in a chosen quiet hour. Expect some forced reboots anyway.
- **Restarts:**
  - Every trader start is a new run, as today. The gap shows in the run list and as a data-quality incident.
  - A gateway restart starts a new epoch. BURN-IN observes what the trader does then; nothing is assumed.
  - Page-class halts (ledger invariant, accounting mismatch, configuration refusal) do not auto-restart.
- **Power cut:** the laptop rides on battery, but the router does not. A small router UPS covers short cuts. After a long cut, someone must press the power button.
- **Backup:** nightly `pg_dump`, research tier and pins to B2, encrypted. The bucket key cannot delete; lifecycle rules expire old copies. The raw WAL is not backed up: that is ruling A3.
- **Restore drill:** before launch, then monthly. Restore into a scratch database, rebuild the ledger, compare.
- **Monitoring:**
  - The dead-man ping fires only when the trader is healthy and lag is under 30 s. A silent machine alerts you from outside.
  - **Page:** the gateway cannot record; a trader page-class halt; the ledger invariant fails; disk above 85%; `maxTotalBytes` is near; expiry is stuck.
  - **Notify:** lag above 60 s; a feed resync; a new run; backup older than 26 h; clock skew above 250 ms; pin budget exceeded.
  - A daily digest arrives by ntfy or Telegram.
- **Security:** no router port forwards. Every service binds to 127.0.0.1; remote access is Tailscale only. Turn on Device encryption if the model supports it. The machine holds only the B2 key and the alert tokens. §6 invariant 17 startup validation stays on.
- **Shared use:** if you use the machine for other work or games, trader lag rises. Dedicate it for months 1-3 if you can.

## 9. What gets measured first (HOST-BENCH)

1. **The trader's speed on your machine:** the THROUGHPUT bench on the H1 burst fixture, µs per event, with and without evaluation, in "Best performance" mode, over several hours. It also measures the effect of the 12700H's slower efficiency cores. The same bench runs on an hourly Hetzner CX33 (about $1).
2. **A 24 h multi-market recording** (gateway only, through the existing restart driver): BTC, ETH, SOL and XRP, 5-minute and 15-minute. It measures:
   - GB/day per market and per asset;
   - events per second at aligned window opens;
   - how much quieter the non-BTC and 5-minute markets are;
   - the real inbound traffic for your ISP.
3. **Compression:** SNAPPY Parquet, gzip and zstd on real segments. This sizes the pins and the A3b option.
4. **Research-tier sizes:** a prototype run on the 24 h recording.
5. **State churn:** `count(DISTINCT state_hash)` on the H1 databases, which tells whether CKPT-1 saves anything.
6. **Machine limits:** watts at the wall; free disk; RAM per process; Redis bytes per entry; CPU temperature over a day.
7. **Restart behaviour:** the trader's exit codes and its behaviour on a new gateway epoch. HOST-1's restart map depends on them.

## 10. Questions for you

1. **Is the Ryzen 9 7900 desktop, where these sessions run and where every throughput number was measured, yours, and can it stay on around the clock?** If yes, it is the better host: it is the measured machine and has about 600 GB free. The plan is otherwise unchanged.
2. How much free disk does the laptop have? This plan wants about 250 GB at 1-2 markets.
3. Does your home internet have a data cap, and can the machine use Ethernet?
4. Roughly what is your CFE tariff band (is the household on DAC)?
5. Do you want to commission the `btc-15m-updown` settlement spec? Without it there will be no PAPER fills to audit.

## 11. Risks

1. **The trader's speed on your machine is unknown.** Every number came from the Ryzen 9 7900. Even there the trader lagged up to 153 s at a window open. Aligned opens at 8 markets reach several thousand events per second. HOST-BENCH and SCALE-8 decide, and "fewer than 8 per machine" is acceptable.
2. **Nothing runs across windows unattended yet.** Until ROLLOVER-1, only one 15-minute market runs, restarted every window by a driver.
3. **A home machine has gaps.** Windows Update, power, ISP and WSL cause them. Expect several restarts a month. Each restart is a new run, and soak evidence must use explained-gap windows.
4. **A throttled strategy is a different strategy.** Results are not comparable with H1 runs or with a future low-latency live run.
5. **A retention bug could delete evidence, or stall and fill the disk.** Mitigations: verify before delete, pins that expiry cannot touch, receipts, and a hard stop that halts rather than loses data.
6. **No PAPER fills until the settlement spec exists.** Three months may yield intents and refusals only.
7. **Approximate backtests can overstate an edge.** They are labelled and barred from calibration and promotion.
8. **Cost drift at 8 markets** if a dedicated cloud CPU or a raw archive becomes necessary. The $80 forecast stop in §5.3 guards it.
9. **This is a PAPER-only profile.** A home machine is not a live host. Live work needs a cloud host, a new cost ruling and WP-320's live eligibility check.

## Round record

- **summary:** One plan for a sub-$100 first deployment: your own machine first, with a priced cloud exit. Six rulings (H, A1-A5) plus one deferred ruling (A6), and nine rounds starting with STORAGE-1.
- **files_changed:** none tracked. This file, and its copy in `~/pmb-rounds/lean-1/`.
- **tests_run:** none; read-only synthesis of P1-P3 and the two reviews, spot-checked against the handoff (§2, §6, §9.1, §9.2), ADR-003, ADR-004 and ADR-024 at `2a196ec`.
- **assumptions:**
  - The laptop's wattage, the CFE tariff, compression ratios, and the activity of non-BTC and 5-minute markets are all unmeasured.
  - The pin volume uses today's intent rate of about one window in three.
- **deviations:** none. No implementation. ADR numbers are placeholders, not reservations.
- **known_risks:** §11.
- **follow_up:** your rulings (§6) and answers (§10); then the docs-only ADR step; then STORAGE-1 and HOST-BENCH.
- **commit_sha:** none; base `2a196ec`.
- **Reviewers:** JUDGE-OPUS and JUDGE-ASTRA (plans); this synthesis is not yet adversarially reviewed.

## The user's rulings (2026-09-30)
- **H: yes.** A dedicated laptop (ASUS TUF F15: i7-12700H, 16 GB, 1 TB), PAPER only, all processes on one host. The user's desktop is a personal machine (gaming, work), so it is the development machine and the fallback, not the host. About 600 GB can be freed; the connection is 1 Gb/s with no data cap. Electricity cost: not a concern.
- **A1: yes, once per second.** Evaluate each market at most once per 1 s of event time, plus a 5 s heartbeat; fills, order updates, lifecycle and stop callbacks are never delayed.
- **A2 + A3: yes to both.** Checkpoints only on state change (plus a 60 s heartbeat). Raw WAL deleted after 72 h, once the research tier and the pins are verified. Fill windows are pinned forever; intent, refusal and halt windows for 30 days.
- **A3b:** not taken (no 90-day raw archive for now).
- **A4 + A5: yes to both.** An "approximate" research dataset class, never admissible as proof. Series auto-admission of each new window in PAPER, with one run spanning many windows.
- **A6:** deferred until SCALE-8.
- **The budget (the user):** under $100/mo for at least the first 3 months.
