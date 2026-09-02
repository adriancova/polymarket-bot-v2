# Recorder runbook

Owner: `WP-140`. Covers the Wave 1 recorder: the Market Data Gateway
(`apps/data-gateway`, `WP-120`) and the compaction pipeline
(`apps/research-worker` + `packages/storage-parquet`, `WP-130`), plus their
observability (`packages/observability/src/recorder`, `infra/grafana/recorder`,
`infra/prometheus`) and the soak harness (`test/soak/recorder`).

Authority for venue facts: current official Polymarket documentation. For
architecture: `docs/spec/polymarket-bot-orchestrator-handoff.md` (§9.1, §14).
This runbook **subsumes** the operator restart procedure previously written in
`infra/compose/data-gateway/README.md` (per the WP-120 hand-off's follow-up:
fold, do not duplicate); that README remains authoritative for the compose
fragment's environment table and configuration notes and should shrink to
point here (its owner is `WP-120`; noted in `docs/handoffs/WP-140.md`).

**Safety.** The recorder consumes public, unauthenticated market data only.
No credential, signer, wallet, or order path exists in any covered process.
`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are
untouched by everything here. Metrics endpoints must never be publicly
exposed (handoff §15).

---

## 1. The process contract (what "healthy" means)

The gateway's exit contract is **bidirectional** (WP-120, remediation rounds
2–6):

- **It runs until signalled.** A healthy recorder holds a referenced lifetime
  anchor and lives through transport outages, feed reconnect waits, and
  publication halts. `SIGINT`/`SIGTERM` is the ONLY sanctioned way to stop
  it; a clean stop drains in-flight work, finalizes the active WAL segment
  (footer + manifest), closes the transport, logs
  `data-gateway: shutting down`, and exits `0`.
- **Any fatal startup defect exits nonzero, promptly.** Missing or invalid
  configuration, or a WAL that will not open, exits `1` loudly. On the fatal
  path every acquired resource's independent cleanup is INITIATED — a cleanup
  that hangs cannot block a sibling's from being called, and every settled
  cleanup failure is logged as it is collected (`[disposal]` lines). Release
  is not guaranteed: the cleanup deadline (below) may force the exit with a
  hung disposal incomplete, leaving the WAL tail to be crash-recovered on the
  next start (the WP-050 recovery shape).

**Alarm on BOTH failure directions:**

1. **The recorder EXITED** and no operator asked it to — Prometheus alert
   `RecorderExited` (`up{job="recorder"} == 0` / absent). Page.
2. **The recorder FAILED to exit** after a shutdown was requested — this is a
   **log-line signal, not a metric** (the exporter lives inside the process
   that is wedged; see §4). The signals are in §2.

Both cleanup paths (fatal startup and signal shutdown) are guarded by a hard
deadline, `GATEWAY_CLEANUP_DEADLINE_MS` (default `10000`; validated
fail-closed, whole number 100–2147483647). If a resource's cleanup hangs or
fails while holding a referenced handle, the process force-exits nonzero at
expiry instead of wedging.

## 2. Forced-exit signals (operator-facing log lines)

All operational logging is on **stderr**. The lines below are exact
substrings; a log-pipeline alarm should match them verbatim.

| Line | Meaning | Action |
| --- | --- | --- |
| `data-gateway running: epoch <uuid>, stream <name>, wal <path>` | startup complete; the epoch identifies this run's WAL directory | none |
| `… — PUBLICATION HALTED, RECORDING ONLY` (suffix of the banner) | started while the event bus was unreachable; recording anyway (§4.2) | bring the bus back, then restart per §3 |
| `[incident] <severity> <reasonCode> (<id>): <detail>` | a data-quality incident opened | severity `PAGE` pages; see §3's cause table |
| `[halt] publication halted (<cause>) at ingestSeq <n>: <detail>` | publication halted — terminal for this epoch; recording continues | §3 |
| `[wal] recording failure (<reason>): <detail>` | the WAL refused or failed a write — **the raw record is incomplete** | treat as a page; disk first |
| `[publish] the transport refused ingestSeq <n>: <detail>` | non-outage transport refusal — a gateway-side defect | capture detail + WAL segment; defect report |
| `data-gateway: shutting down` | a requested shutdown began | expect exit 0 shortly |
| `[disposal] <resource> cleanup failed: <message>` | one resource's cleanup failed during stop/fatal-exit; siblings were still run | collect for the incident record; expect the deadline to force exit if the process does not end |
| `data-gateway: cleanup deadline (<n> ms) expired on the <fatal-startup\|shutdown> path; …` | **forced exit**: a cleanup hung or failed holding a referenced handle; the process force-exits `1` mid-cleanup | treat the WAL tail as crash-recovered — the next start recovers it (WP-050); chart forced exits DISTINCTLY from clean nonzero exits |
| `data-gateway: fatal <error>` | fatal startup defect; cleanup already initiated | fix the named defect; exit 1 follows (at latest at the deadline) |

**The FAILED-to-exit alarm**: a shutdown was requested (operator action, or
`data-gateway: shutting down` present) and the process still exists past
`GATEWAY_CLEANUP_DEADLINE_MS` + margin **without** the deadline line — or the
deadline line printed and the process is somehow still alive (would indicate a
broken `forceExit` wiring; WP-120 round-4 known risk 3). Either way:
`SIGKILL`, treat the WAL tail as crash-recovered, file an incident with the
`[disposal]` lines. The soak harness observes exactly this from outside and
records `forcedKill: true` (§7) — a window that needed a kill can never
qualify as soak evidence.

## 3. Publication halts and the restart procedure

Publication in this gateway is **terminal for the epoch** — no automatic
resume, by design: events assigned during an outage were never in the stream,
and resuming mid-epoch would hand consumers an undetectable gap. A restart
mints a new epoch and a fresh authoritative-snapshot obligation (§7.1
recovery path).

**Recording is unaffected by any of this.** The WAL path does not run through
the publisher. Do not kill a halted recorder in a hurry: the frames it is
writing are the ones that cannot be re-fetched later.

Causes (one PAGE incident each, on stderr and — when the bus is reachable —
in the stream):

| Reason code | What happened | What to do |
| --- | --- | --- |
| `GATEWAY_TRANSPORT_UNAVAILABLE` | event bus unreachable — at startup or mid-run | bring Redis back, confirm, restart the gateway |
| `GATEWAY_PUBLISH_QUEUE_FULL` | WP-060's producer queue saturated | find why the bus stopped draining; restart after |
| `GATEWAY_PUBLISH_ADMISSION_OVERFLOW` | this gateway's admission queue filled (`publisher.maxQueueDepth` / `maxQueueBytes`) | same; raise bounds only with a reason (§5) |
| `GATEWAY_PUBLISH_REJECTED` | transport refused an envelope for a non-outage reason | **gateway-side defect** — capture detail + WAL segment, then restart |
| `RTDS_UNRECOVERABLE_GAP` | RTDS TWAP stream broke; venue offers no replay; normalized RTDS publication halted for the epoch | restart for a new observation window; the unobserved interval is permanently unobserved; TWAP-dependent consumers must halt (ADR-009 §6) |

The procedure, in order:

1. **Do not restart first.** Read the publisher metrics — `halt.cause`,
   `halt.haltedAtIngestSeq`, `queueMaxDepthObserved`, `oldestQueuedAgeMs`
   (dashboard: "Publication" panels; in-process: `metrics().publisher`) — and
   the incident detail. They say which row above you are in.
2. **Confirm recording is healthy**: WAL state `open`
   (`recorder_wal_faulted` = 0), `recorder_wal_queue_messages_dropped_total`
   = 0. If the WAL is faulted you have a *second, worse* incident
   (`GATEWAY_WAL_WRITE_FAULT`) and the disk is the priority.
3. **Fix the cause** (the bus for the first three rows; a defect report for
   `GATEWAY_PUBLISH_REJECTED`).
4. **Restart the process.** `SIGINT`/`SIGTERM`; kill only per §2's
   FAILED-to-exit procedure.
5. **Expect a new epoch**: a new `<walRoot>/<gatewayEpoch>` directory,
   `ingestSeq` restarting at 1, consumers resuming on the same `streamName`
   with fresh authoritative snapshots.
6. **Nothing recorded during the halt is lost.** Those segments are complete
   and manifested; `WP-130` compacts them like any others.

Local operation (compose fragment, environment table, configuration notes):
`infra/compose/data-gateway/README.md`.

## 4. Metrics, dashboard, and alerts

- **Exporter**: `packages/observability/src/recorder` — pure render functions
  mapping `DataGateway.metrics()` and `ResearchWorkerMetrics` to Prometheus
  text. The canonical metric table is `metric-families.ts`; every dashboard
  panel and alert is machine-checked against it
  (`infra-consistency.test.ts`).
- **Dashboard**: `infra/grafana/recorder/recorder-dashboard.json` — queue
  depth, lag, gaps, fsync, compaction, upload status (the WP-140
  acceptance-1 set), plus liveness, feeds, validation, and soak panels.
- **Alerts**: `infra/prometheus/recorder-alerts.yaml`; scrape fragment
  `infra/prometheus/recorder-scrape.yaml`. Meanings are annotated on each
  rule; the two deliberately log-based alarms are in §2.
- **Wiring status, disclosed**: no process serves `/metrics` yet. The
  exporter is wired into the apps by a follow-up recorded in
  `docs/handoffs/WP-140.md` (the apps are outside WP-140's paths). Until
  then, gateway state is read from stderr + `metrics()` in-process, and
  validation/soak metrics are point-in-time text files
  (`*.prom`, textfile-collector-ready) written by the jobs in §6–§7.

**The fsync interval is the data-loss bound (ADR-004 §3), written down:**
`wal.fsyncIntervalMs` — default **1000 ms** — is the published bound on what
a power loss can cost: the frames of the last un-fsynced interval. The
writer republishes it as `recorder_wal_data_loss_bound_ms`, and the live
exposure at any instant is `recorder_wal_unproven_frame_count` /
`recorder_wal_bytes_unsynced`. The configuration schema refuses
`tickIntervalMs > fsyncIntervalMs`, because an idle recorder is fsynced only
by the tick — a slower tick would make the published bound false. Changing
the interval changes the bound: record it here and on the dashboard, not
only in the config file. `RecorderFsyncOverdue` fires when the cadence falls
behind the bound.

## 5. Queue and admission bounds (and sizing them from soak data)

Two bounded queues protect the recorder; **crossing a publisher bound is a
terminal halt, never a drop** — so the alarms are set to warn BEFORE the
bound:

| Bound | Default | Meaning |
| --- | --- | --- |
| `publisher.maxQueueDepth` | 1024 envelopes | unpublished work held while the transport is slow |
| `publisher.maxQueueBytes` | 8 MiB | same, in bytes |
| WAL queue depth / bytes | WP-050 defaults | frames accepted, not yet handed to the segment writer |

Watch `recorder_publisher_oldest_queued_age_ms`
(`RecorderPublishQueueAgeHigh`, > 5 s) and the 80%-of-bound headroom alert
(`RecorderPublishQueueNearBound`). These are **safety parameters, not
throughput knobs**: raising them buys tolerance for a longer transport stall
and costs memory plus a longer window of events that exist only in the WAL.

**Sizing from soak data — explicitly pending.** The bounds are reasoned, not
measured (WP-120 `known_risks`; carried follow-up "size the admission bounds
from soak data"). No soak data exists yet (§7). When a real soak has run,
size them from the recorded evidence: the observed
`queueMaxDepthObserved` / `queueMaxBytesObserved` high-water marks and
`oldestQueuedAgeMs` under real feed volume, with the bound set a comfortable
multiple above the observed peak and the age alarm well inside the implied
drain time. The same soak is where WP-130's memory profile comes from (the
compactor holds one segment in memory — bounded by `maxSegmentBytes`,
reasoned not profiled) and where §9.1's under-5 ms p99
gateway-receipt-to-dispatch benchmark remains to be measured. Record the
numbers and the reasoning in this file when they exist.

## 6. Compaction, dataset validation, and the finding classes

Operate compaction per `WP-130`: the research worker compacts verified WAL
segments to Parquet, uploads with post-upload checksum verification, writes
the dataset manifest + digest sidecar (read-back-verified), and only then
deletes WAL segments. A failed cycle touches nothing. Compaction lag on the
dashboard **only counts segments a cycle looked at and refused** — combine
with `recorder_wal_active_segment_age_ms` (WP-130 known risk 3).

Validate datasets with the DuckDB job: `pnpm ops:validate-dataset -- <args>`
(`python/research/compaction/validate.py`). It returns **findings, never
raises**; exit 2 = the manifest itself is unusable; exit 3 = the defensive
backstop. The book snapshot-comparison job (§6.1) reports in the same shape.

**Finding classes as operational signals** — what each class group means and
what to do (`recorder_validation_findings{class=…}`;
`RecorderValidationFindings` pages on error-severity findings):

| Class group | Classes | Operational meaning | Action |
| --- | --- | --- | --- |
| Object integrity | `object-present`, `object-length`, `object-checksum`, `object-read`, `object-not-a-file`, `object-parquet` | bit rot, truncated upload, or a manifest pinning something that is not the uploaded object; the dataset is DEGRADED and row-level checks are skipped | do not serve the dataset for replay; re-compact from WAL if segments still exist; storage incident |
| Manifest self-integrity | `manifest-digest-absent` / `-unreadable` / `-malformed` / `-mismatch` | the manifest's own sidecar digest is broken — the compactor verifies it before any deletion, so this is corruption after the fact, not a new dataset | quarantine the dataset; storage incident |
| Layout | `layout-id`, `layout-version`, `layout-columns`, `layout-column-type`, `layout-column-nullability` | a writer changed schema without bumping `parquetLayoutVersion`, or pins contradict the file | encoder-drift investigation; ADR before any byte-changing upgrade (WP-130 follow-up) |
| Counts & ordinals | `dataset-row-count`, `object-row-count`, `object-replay-eligible-count`, `records-declared-vs-read`, `records-read-vs-written`, `replay-eligible-arithmetic`, `ordinal-density`, `ordinal-uniqueness`, `segment-row-count`, `segment-pinned` | a dropped page, mis-stated count, or unpinned segment in the data; dispatch-order reconstruction is no longer proven | dataset unusable for replay until explained |
| Row integrity | `ingest-seq-grammar`, `frame-line-digest`, `payload-digest`, `exclusion-reason-shape` | byte-exactness broken somewhere between venue frame and archive — the digests are recomputed, never trusted | treat as data corruption; trace with the named ordinals |
| Deduplication | `deduplication`, `duplicate-count`, `duplicate-provenance` | a mislabeled duplicate would silently drop a genuine record from replay | dataset unusable for replay until explained |
| Incident exclusion | `incident-window-grammar`, `incident-exclusion-applied` / `-count` / `-pinned` / `-range` / `-segments` / `-total` | the operator incident file and the dataset disagree — a window nobody wrote down is a window nobody excluded (WP-130 known risk 4) | fix the incident file (`loadIncidentWindows` seam); re-run |
| Retention | `retention-receipt`, `retention-receipt-absent`, `deleted-segment-object`, `excluded-segment-absent` | the deletion receipt and reality disagree | verify the object store before anything else is deleted |
| Job health | `validator-query` | DuckDB failed mid-check; the finding names the query | validator/environment bug, not (necessarily) data |
| Book comparison | `book-divergence`, `book-frame-unparseable`, `book-level-grammar`, `book-delta-before-snapshot`, `book-crossed-reconstruction` | §6.1 | §6.1 |

The class list is pinned in
`packages/observability/src/recorder/validation-findings.ts` and tested
against the validator's source, so this table cannot silently rot.

### 6.1 Book snapshot comparison (Wave 1 closeout: "Book reconstruction is checked against snapshots")

`pnpm --dir test/soak/recorder run soak:compare-books` with
`SOAK_WAL_DIR=<walRoot>` replays every recorded Polymarket epoch: starting
from each authoritative `book` snapshot it applies every recorded
`price_change` delta and checks the result against the NEXT recorded
snapshot, per outcome token, on canonical decimal strings (no floats). It
writes `book-comparison.json` + `book-comparison.prom` into the evidence
directory and **fails on any divergence**.

- `book-divergence` (error): the recording does not reproduce the venue's
  own snapshot — a missed/duplicated delta or a venue contract change
  (cf. ADR-013). Do not trust the affected epoch for book-dependent
  research; investigate before `WP-150` builds on the pattern.
- `book-frame-unparseable` / `book-level-grammar` (error): recorded payload
  does not match the verified venue schema — venue drift; re-verify against
  current venue docs.
- `book-delta-before-snapshot` (info): capture started mid-stream for an
  asset; expected for the first frames of a subscription, noteworthy in bulk.
- `book-crossed-reconstruction` (warning): transiently crossed reconstruction
  at comparison time; investigate if paired with divergences.

## 7. Soak evidence (the external-evidence gate)

**Status right now: PENDING. No soak has run.** Handoff §16.7: time-based
gates cannot be faked; they stay `PENDING_EXTERNAL_EVIDENCE` until real
elapsed-time evidence exists. Nothing in this repository can mark the soak
complete — the evaluator is fail-closed and the threshold is a reviewed
constant (24 h, `SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS`; a conservative
assumption recorded in `docs/handoffs/WP-140.md`, since neither the handoff
nor the work plan states a duration).

### Running a real soak

1. Prepare a **reviewed** gateway configuration (real venue endpoints,
   reviewed markets, a real WAL root with capacity) — see
   `infra/compose/data-gateway/README.md` — and a reachable event bus
   (`GATEWAY_REDIS_URL`), or accept the recording-only posture knowingly.
2. Start the window (this builds the real bundle and runs it):

   ```bash
   SOAK_DURATION_MS=93600000 \
   SOAK_CONFIG_PATH=/path/to/reviewed-gateway.json \
   SOAK_EVIDENCE_DIR=/path/to/evidence \
     pnpm --dir test/soak/recorder run soak:run
   ```

   (26 h requested so a ≥ 24 h qualifying window survives operational
   slack.) The harness observes the process from outside: stderr signals,
   exit behavior, and the WAL manifests it leaves. On `SIGTERM` after the
   window it expects a clean exit; a recorder that fails to exit is
   force-killed and the record says so (`forcedKill: true` — the window then
   cannot qualify).
3. **Where evidence lands**: one `soak-window-<startedAt>.json` per window in
   the evidence directory. The record's duration is first-class
   (`startedAt`/`endedAt`/`elapsedMs`, cross-checked at evaluation); it
   carries **no status field**.
4. Evaluate:

   ```bash
   SOAK_EVIDENCE_DIR=/path/to/evidence \
     pnpm --dir test/soak/recorder run soak:evaluate
   ```

   writes `soak-status.json` + `soak-status.prom`. **What marks it
   complete**: `SATISFIED` requires ONE contiguous valid window ≥ 24 h in
   which the recorder demonstrably ran and recorded
   (`runningBannerSeen`, `wal.records > 0`), shut down cleanly on request,
   and reported **zero** unexplained-gap signals (WAL recording failures and
   GAP-reason incidents both count — the conservative direction; a window
   with venue-side gaps stays PENDING until an operator reviews and either
   re-runs or explains them in the completion record). `INVALID` means an
   evidence record failed validation — evaluation never skips bad evidence;
   resolve the named record.
5. Run the validation jobs over the soak's output: §6's dataset validation
   on anything compacted, and §6.1's book comparison with
   `SOAK_WAL_DIR=<the soak's WAL root>`.
6. Report the outcome to the orchestrator with the status artifacts. The
   package-status line "External time-based evidence" moves off `pending`
   only on a `SATISFIED` evaluation over real records — never on a claim.

The automated smoke (`pnpm --dir test/soak/recorder run soak:smoke`) runs
the SAME harness for seconds against closed loopback ports and asserts the
machinery works and that the result is honestly PENDING. It proves the
pipeline, not the soak.

## 8. Known gaps (stated, with owners)

- **Exporter wiring**: no `/metrics` endpoint in the apps yet
  (`docs/handoffs/WP-140.md` follow-up; apps are outside WP-140's paths).
- **`data.raw_segments` (§10.2) has no writer** — unassigned; escalated to
  the orchestrator by WP-120's hand-off. Consumers expecting it populated
  will find it empty.
- **Log-based alarms** (§2) need a log pipeline; Prometheus alone cannot see
  a wedged process's last words.
- **Bounds and latency are unmeasured** until the first real soak (§5).
- **`infra/compose/data-gateway/README.md`** still contains the restart
  procedure this runbook subsumed; trimming it to a pointer is a WP-120-path
  edit.
