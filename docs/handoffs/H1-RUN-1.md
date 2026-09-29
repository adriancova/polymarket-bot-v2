# H1 run 1 and H3 — the first live-data paper run (2026-09-29)

**Who:** the orchestrator (Claude), at the operator's request on 2026-09-29 ("this all
sounds like it should be possible for you to drive it? … What do you need from me?").
The operator page `first-live-paper-run` (H1 steps 1–8, H3 steps 9–12) was followed,
with the corrections recorded below. **Code:** `main` at `3284459`. **Posture:** PAPER only
on every process (`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, both `LIVE_MICRO_*`
caps `0`); public venue data only; no wallet, signer, key or venue credential.

**Evidence** lives outside the repository in `~/pmb-h1/` (261 MB with the gateway WAL):
`EVIDENCE.md` is its index and `SHA256SUMS` covers every file except the WAL segments
and the local control-API token. This record states what the evidence shows; the fresh
Wave 2 closeout audit grades it.

## Outcome

**H1 run 1: ran on live data, then halted fail-closed at the window open.** The pipeline
worked end to end for 34 minutes (gateway → Redis → trader → PostgreSQL → health →
control API → Prometheus → Grafana): **37,546 decisions and 37,546 checkpoints persisted**,
all `hold`, and they read back clean. The trader then fell behind the market's event rate,
the transport's retention trimmed events it had not read, and it halted
`GLOBAL TRANSPORT_RESYNC_REQUIRED (FULL_HALT)` (exit 75), as ADR-003 §3.3 requires. **No
entry was ever evaluated in-window:** 0 risk evaluations, 0 intents, 0 fills, 0 PnL
snapshots. The user ruled (2026-09-29): fix the throughput and re-run (`THROUGHPUT-1`).

**H3: performed.** A real Prometheus 3.5.0 loaded the repository's
`infra/prometheus/control-api-scrape.yaml` verbatim (only `credentials_file` changed;
promtool SUCCESS) and scraped the control API, target **up**. A real Grafana 12.1.1
imported the three `infra/grafana/control/*.json` dashboards through its API (all
`"status":"success"`) and rendered the run's live values (decisions/s, evaluations, feature
snapshots, queue backpressure, trader health). The risk, fill and Realized PnL panels were
flat or "No data", because no entry was evaluated. Both release archives were
SHA-256-verified. Docker Desktop containers cannot reach WSL loopback services, so both
ran as native binaries on 127.0.0.1.

## The market

Gamma `5093631`: "Bitcoin Up or Down - September 29, 5:00PM-5:15PM ET", conditionId
`0x13956ebcd038914b34ae37900d7266c31022f28eab21765b1c2abe1f0e07d7fa`, window 21:00–21:15 UTC.
**UNIV4-R1 discharged for this run:** Gamma `/markets/5093631` and CLOB
`/markets/<conditionId>` agree on the question, conditionId, slug, both token ids
(Up = YES), tick size 0.01, minimum size 5 and negRisk false (`market-verification.txt`).
It was registered with the REGISTER-1 command in one transaction: run
`01a0eed4-9fc6-7ef3-9789-113f3854cb99`, instance `01a0eed4-9fc3-75cf-872f-e5f09c31ae91`,
market `01a0eed4-9faf-7911-bb58-c8e64ab55859`, config v1. The shipped example parameters
were used unchanged; the market's `openTime` is the venue's `acceptingOrdersTimestamp`.

## Timeline (UTC)

- **20:21:** the trader compose fragment ran with `PMB_TRADER_POSTGRES_PORT=55432`, because a system PostgreSQL 14 holds 5432 on this machine; migrations 0002–0009 were applied.
- **20:22–20:27, attempt 1** (`attempt-1-no-book-feed/`):
  - The example gateway configuration has **no `polymarket` block**, so the gateway never subscribed to the CLOB books.
  - The trader read 25,783 reference events and made 0 decisions: every feature snapshot was unavailable.
  - Both processes were stopped; the gateway shut down gracefully.
- **20:28:** the gateway restarted with `"polymarket": {"feedId": "polymarket-market"}`, and the trader restarted on the SAME run (durable resume). The lifecycle feed had confirmed `MarketOpened` at 20:22:46 (`openedAtOrigin: configuration`).
- **20:28–21:02:** live decisions. Reason codes:
  - `SB.ENTRY_TRIGGER_NOT_MET` 17,178;
  - `SB.STALE_BOOK` + `SB.INCIDENT_POLICY_FIRST` + `SB.PAUSED` 20,367;
  - `SB.RESUMED` 91.
- **Halt at event time 20:59:45.822Z:** retention removed 853 events after ordinal 191,633 before the trader read them. The process exited 75 at about 21:02:50 wall time.
- **About 21:03:** the gateway's publication halted too, `GATEWAY_PUBLISH_ADMISSION_OVERFLOW`: the admission queue was full at 1024/1024 at ingestSeq 573,117, while recording continued. The gateway then shut down gracefully (exit 0).

## Findings

1. **Trader throughput (the halt's cause).**
   - `throughput-by-minute.txt`: the trader sustained at most about **35–38 decisions/s**, 10–25/s before the window.
   - Strategy evaluation averages about **0.2 ms**.
   - `latency-probe.txt`: the network round trip is 0.15 ms to Redis and 0.62 ms to PostgreSQL, and PostgreSQL commits in 1.06 ms (pgbench, 945 tps). There are two commits per decision (`xact_commit` 75,908).
   - So about 26 ms per decision-producing event is spent **inside the trader process**; it has not been profiled yet.
   - Event-time lag stayed under 40 s until 20:57, then grew 0:44 → 1:26 → 2:10 → 3:00 as book activity ramped into the window.
2. **The burst.** The last 100,000 stream events (21:02:06–21:04:22, about 735 events/s) are saved as a benchmark fixture: `scratchpad/throughput-1/fixtures/burst-2026-09-29T2100.jsonl`, 68.6 MB.
   - 85,547 of them are `BookLevelChanged`, from 42,774 venue frames: exactly two level events per frame, one per token of the pair.
   - Evaluating between the two sees a half-applied frame. Whether to evaluate once per frame is a semantic question, recorded for a ruling (`H1R1-FRAME-ATOMICITY`).
3. **The trader exposes no transport lag.** Health read `consumerLag 0` throughout, because that counter is the in-process queue, not the stream. Nothing showed the trader running 3 minutes behind.
4. **Gateway publisher throughput.** Admission overflowed at the window's rate. Fail-closed and correct, but it caps any consumer.
5. **Stale-book pauses.** 54% of all decisions paused on `SB.STALE_BOOK`: book age is `now − book.asOf`, the time since the last CHANGE, so a quiet but live book reads stale after `maximum_book_age_ms` (2000). The risk policy's `venueBookMaxAgeMs` is the same shape. The user ruled that this is folded into the round (`THROUGHPUT-1c`).
6. **A halt that exits fast is invisible to Prometheus.** The process exited between 15 s scrapes, so the dashboards showed `halts 0, healthy 1` right up to "health unavailable". This joins `OUT1-R1-HALT-NOT-DURABLE`: the run row still reads `RUNNING`.
7. **Provenance columns are empty.** `strategy.decisions.gateway_epoch`, `ingest_seq` and `feature_snapshot_id` are NULL on all 37,546 rows; `source_event_id` is filled.
8. **The operator procedure's traps** (the page has since been corrected):
   - a system PostgreSQL holds port 5432;
   - `jq` is not installed;
   - the gateway example configuration lacks the `polymarket` block.

## Rulings (the user, 2026-09-29)

- **"Throughput round, re-run":** authorize `THROUGHPUT-1` under the hardening loop and re-run H1 through a full window afterwards. The closeout waits for that run.
- **"Fold into the round":** the stale-book finding becomes `THROUGHPUT-1c`, a liveness-based freshness rule.
