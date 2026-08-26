# ADR-004: WAL format, durability, and compaction

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-050` (writer, reader, rotation, checksums, recovery),
  `WP-130` (compaction, Parquet, dataset manifests), `WP-120` (gateway
  integration) — **not yet implemented**
- **Supersedes / Superseded by:** none

## Context

Handoff §9.1 states the WAL requirements and explicitly defers the format choice
to this record: "Append-only JSONL **or another ADR-approved recoverable
format**". Handoff §2 locks the raw archive as an "Append-only local WAL,
compacted into checksummed Parquet in object storage", with DuckDB/Polars over
Parquet for research. Handoff §4.2 defines the failure boundaries the WAL must
survive.

The WAL is the recording substrate for the first production deliverable (§0.1: an
always-on Market Data Gateway and Recorder that "records Polymarket public market
data plus external reference feeds **without silent gaps**" and produces
"replayable, checksummed datasets"). Everything downstream — replay ordering
(§8.4), determinism (§12.4), dataset manifests (§12.5) — depends on it.

## Decision

### 1. Format: append-only JSONL

The WAL segment format is **append-only JSON Lines**: one JSON object per line,
UTF-8, newline-terminated, no pretty-printing, no trailing commas, no multi-line
records.

This is the format §9.1 names first, and it is approved here for the reasons that
matter to recovery:

- A partial write is detectable at record granularity — an incomplete final line
  is exactly the failure mode §9.1 says recovery must handle.
- It is streamable and appendable without rewriting earlier bytes, so the writer
  never needs a read-modify-write cycle on a segment.
- It is inspectable by an operator during an incident without a special tool.

Each record is a `RawFrameRecord` (§9.1):

```ts
export type RawFrameRecord = {
  gatewayEpoch: string;
  ingestSeq: string;
  source: string;
  endpoint: string;
  connectionId: string;
  subscriptionGeneration: number;
  receivedAt: string;
  receivedMonotonicNs: string;
  payloadUtf8: string;
  payloadSha256: string;
};
```

`payloadUtf8` is the frame **exactly as received**, not a normalized or
re-serialized form, and `payloadSha256` is computed over those bytes. Normalizing
before recording would destroy the evidence the recording exists to preserve.

**Binary frames are out of scope of this format.** Every feed currently in scope
delivers JSON text frames over WebSocket — the Polymarket market and user
channels (venue report §3, §4) and the RTDS TWAP stream (venue report §10.3). If
a future feed delivers binary payloads, `payloadUtf8` cannot hold them and this
ADR must be amended (a base64 field, or a separate binary segment format) rather
than silently reinterpreted.

### 2. Segment structure

- **Header.** The first record of a segment is a header carrying at least the WAL
  schema version and the `gatewayEpoch` (§9.1: "File header includes schema
  version and gateway epoch").
- **Footer or sidecar.** Each completed segment has a record count and a SHA-256
  over the segment bytes, written as a footer record or a sidecar file (§9.1).
  The sidecar form is preferred for a segment closed by a crash, because a footer
  cannot be written by a process that is no longer running.
- **Rotation** by size **and** time (§9.1). Both bounds are configuration, and
  both are observable (§14.3 recorder metrics include segment age).
- **Segment metadata** is registered in `data.raw_segments` with its checksum
  (§10.2).

### 3. Durability

- **Periodic `fsync`, not one `fsync` per frame** (§9.1). The flush policy is
  configured by a byte threshold and a time interval, whichever comes first.
- The chosen interval is a **stated bound on data loss**: a host power loss can
  lose at most the frames written since the last successful `fsync`. That bound
  must be written into the recorder runbook, and `fsync` latency and WAL queue
  depth are required metrics (§14.3).
- Recovery **truncates only an incomplete final record** (§9.1). It never
  discards a well-formed record, never rewrites earlier bytes, and never
  "repairs" a middle-of-file corruption silently — that is a data-quality
  incident, and the affected range is excluded from dataset manifests (§10.2,
  §12.5).

### 4. Ingestion path and backpressure

1. The gateway **enqueues the exact raw frame to the WAL writer before
   publication** (§9.1; work-plan `WP-120` acceptance "Raw frame is enqueued
   before normalized publication"). Recording is not best-effort behind
   publication.
2. The raw-frame queue is bounded and exposes the §8.3 metrics.
3. **Overflow is never a silent drop** (§8.3). A queue that cannot accept a frame
   opens a data-quality incident and halts affected trading.
4. A Parquet or object-storage outage must not immediately stop recording: the
   WAL continues until a configured **hard capacity threshold** (§4.2). Reaching
   that threshold is an incident, not an excuse to overwrite.

### 5. Compaction

- **Compaction never deletes a WAL segment until Parquet upload and checksum
  verification both succeed** (§9.1; work-plan `WP-130` acceptance "WAL is not
  deleted before verified upload", "Record counts and hashes reconcile").
- Compacted output is checksummed Parquet in object storage (§2), queried by
  DuckDB/Polars for research (§2).
- **Dataset manifests** pin raw segment IDs and checksums, the normalizer
  version, the feature-set version, excluded incident windows, start/end event
  identity, the run seed, and the fill/latency/fee/settlement versions (§12.5).
  Replay consumes the manifest, not a directory listing.
- Raw high-frequency events live primarily in WAL/Parquet, **not** indefinitely in
  PostgreSQL (§10.2).

### 6. What is recorded

**Every received frame is recorded**, including protocol frames that produce no
normalized event.

The market and user CLOB WebSockets use an application-level heartbeat where the
client sends the text frame `PING` every 10 seconds and the server replies `PONG`
(venue report §3, §4); the RTDS stream uses the same mechanism at a 5-second
cadence (venue report §10.3). These frames carry no market data, but they are the
evidence that distinguishes "the venue sent nothing" from "the connection was
dead" — which is exactly what staleness detection and gap attribution need
(§9.1: "Detect per-connection and per-asset staleness"). §9.1 also states the
requirement unconditionally: "Enqueue **exact raw frames** to the WAL writer
before publication."

Consequence: a raw record is not required to produce a normalized event, and a
compaction/replay consumer must tolerate raw records with no normalized
counterpart.

## Consequences

- **Storage grows with frame volume, not with information volume.** Recording
  heartbeats and duplicate frames costs bytes. That cost is accepted for gap
  attribution; §17 Phase 1's operational gate explicitly requires storage growth
  to be measured.
- **JSONL is not compact.** It is chosen for recoverability and inspectability at
  the *recording* layer; the *research* layer is Parquet, where compactness and
  columnar access matter. The two layers have different jobs.
- **The `fsync` interval is a published data-loss bound.** Changing it changes the
  bound, so it belongs in the runbook and in the recorder dashboard, not only in
  a config file.
- **A binary feed would require an ADR amendment.** The format decision is
  explicitly text-payload-shaped, and pretending otherwise later would corrupt
  `payloadSha256` semantics.
- **Compaction cannot be made "eventually consistent".** The delete-after-verify
  rule means a broken upload path fills the disk instead of losing data. That is
  the intended failure direction, and it is why the hard capacity threshold and
  its incident are mandatory rather than optional.
- **Mid-file corruption is an incident, not a recovery case.** Only the final
  record may be truncated. Anything else must surface, be excluded from manifests,
  and be reported.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §0.1 — the first deliverable records without silent gaps and produces
  replayable, checksummed datasets.
- §2 — append-only local WAL compacted into checksummed Parquet in object
  storage; DuckDB/Polars for research; no raw high-frequency archive dependency on
  PostgreSQL.
- §4.2 — a Parquet/object-storage outage must not immediately stop recording; the
  WAL continues to a configured hard capacity threshold.
- §8.3 — bounded queues, required queue metrics, prohibition on silent drops.
- §8.4 — replay consumes recorded dispatch order; manifests include segment
  checksums, gateway epochs, event ranges, and excluded data-quality windows.
- §9.1 — the `RawFrameRecord` type and the full WAL requirement list:
  **"Append-only JSONL or another ADR-approved recoverable format"**, rotation by
  size and time, periodic `fsync` (not one per frame), header with schema version
  and gateway epoch, footer/sidecar with record count and SHA-256, recovery
  truncating only an incomplete final record, and compaction never deleting a
  segment until Parquet upload and checksum verification succeed. Also: enqueue
  exact raw frames before publication; detect per-connection and per-asset
  staleness.
- §10.2 — `data.raw_segments`, `dataset_manifests`, `data_quality_incidents`; raw
  high-frequency events live primarily in WAL/Parquet.
- §12.4, §12.5 — determinism requirements and the exact manifest pin list.
- §14.3 — recorder metric family: WAL queue depth, bytes written, `fsync`
  latency, segment age, compaction lag, object upload status.
- §16.6 — fault-injection scenarios: corrupt the final WAL record; fill disk or
  exceed configured WAL capacity.
- §17 Phase 1 — automated gate (WAL crash recovery succeeds, segment checksums
  validate) and operational gate (sustained recording soak, storage growth
  measured).

**Work plan** (`docs/spec/polymarket-bot-workplan.yaml`): `WP-050` acceptance
("Crash recovery truncates only an incomplete final record", "Full segments
validate by record count and SHA-256", "Queue overflow is observable and never
silently drops frames"); `WP-120` acceptance ("Raw frame is enqueued before
normalized publication", "Redis outage stops publication but not WAL recording");
`WP-130` acceptance ("WAL is not deleted before verified upload", "Record counts
and hashes reconcile", "Manifest pins incident exclusions and schema versions").

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2) — used only to establish that
recorded frames are JSON text and that protocol frames exist:

- §3 — market channel over `wss://ws-subscriptions-clob.polymarket.com/ws/market`;
  JSON event frames; client sends the text frame `PING` every 10 seconds and the
  server replies `PONG`.
- §4 — user channel over the same host; JSON event frames; same 10-second
  `PING`/`PONG` heartbeat.
- §10.3 — RTDS over `wss://ws-live-data.polymarket.com`; JSON update payloads;
  client `PING` every 5 seconds; **"Subscriptions start with the next update.
  There is no snapshot, history, or replay after a disconnect."**
- §12 unverified **U-2** — the server-side disconnect/timeout consequence of
  missed `PING`s is **not documented**. The WAL therefore records heartbeat frames
  as evidence rather than relying on an assumed timeout.

**Safety:** this ADR changes no run-mode default (ADR-010). The WAL records public
market data and requires no credential; §15 additionally forbids logging or
fixturing private wallet material, so a recorder that ever handles authenticated
frames must apply the §15 redaction rules before those frames reach any log —
the raw archive itself is access-controlled storage, not a log sink.
