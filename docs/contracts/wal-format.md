# WAL on-disk format

Owner: `WP-050` (`packages/storage-wal`)
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §4.2, §8.3, §9.1,
§10.2, §12.4, §12.5, §14.3, §16.6 and
[ADR-004](../adr/ADR-004-wal-format-durability-and-compaction.md), which is
**binding** for the format, durability, and recovery decisions recorded here.
Related: [`dependency-direction.md`](./dependency-direction.md) (the package is
layer 2, adapters/infrastructure), [`domain.md`](./domain.md).

Consumers: `WP-120` (gateway/recorder) writes it; `WP-130` (Parquet compactor
and dataset manifests) reads it; replay (§8.4, §12.5) depends on it.

This document specifies the bytes. Where it and the implementation disagree, the
disagreement is a bug in one of them — the tests in `packages/storage-wal/src/**`
and `test/fault-injection/wal/**` are what keep them honest.

---

## 1. What the WAL is for

The WAL is the recording substrate for the first deliverable (§0.1): record
Polymarket public market data plus reference feeds **without silent gaps**, and
produce replayable, checksummed datasets.

Three properties follow, and every rule below serves one of them:

1. **Evidence, not interpretation.** A frame is stored exactly as received.
2. **Recoverable at record granularity.** A crash may cost the last partial
   record and nothing else.
3. **Verifiable.** A completed segment states its record count and its SHA-256,
   and both are checkable without trusting the process that wrote them.

---

## 2. Directory layout

A WAL directory contains two files per segment and nothing else that this
package writes:

```text
<walDir>/
  <segmentId>.wal.jsonl           # the segment: append-only JSON Lines
  <segmentId>.wal.manifest.json   # its sidecar manifest (record count + SHA-256)
```

- `segmentId` is opaque to readers. The default factory
  (`defaultSegmentIdFactory`) produces `${gatewayEpoch}-${index padded to 6}`,
  which is unique across restarts because the epoch changes (§7.1) and sorts in
  creation order inside one epoch. A deployment may inject a different factory;
  identity is whatever the header says, never what the file name implies.
  Validation and recovery both check that a segment's header id matches the file
  name it was found under, and report `SEGMENT_ID_MISMATCH` if it does not.
- **A segment with no manifest is unverified**, and a compactor must not consume
  it. That is the mechanism by which a corrupt segment is excluded from dataset
  manifests (§10.2, §12.5) — no manifest, no exposure.
- **This package never deletes a file.** The filesystem port it depends on has no
  delete operation at all (`packages/storage-wal/src/ports.ts`). Deletion belongs
  to `WP-130`, and only after a verified upload (ADR-004 §5).
- Exactly one writer may own a directory at a time. Nothing in this package
  enforces that (see §12, open items).

---

## 3. Framing

The segment file is **append-only JSON Lines** (ADR-004 §1):

| Rule | Value |
| --- | --- |
| Encoding | UTF-8, no BOM |
| Record separator | a single `LF` (`0x0A`) terminating **every** record, including the last one of a completed segment |
| Records per line | exactly one |
| Pretty-printing | forbidden — a record never contains a literal `LF` |
| `CR` | not a separator; a `CR` byte outside a JSON string makes the line invalid |
| Trailing bytes | a completed segment ends immediately after the footer's `LF` |

A record's **byte offset** is the offset of its first byte; its **byte length**
includes its terminating `LF`. Both are stable for the life of the file, because
appends never rewrite earlier bytes.

Three record kinds exist, distinguished by the `record` key:

| Kind | Discriminator | Position |
| --- | --- | --- |
| Header | `"record": "header"` | first line, exactly once |
| Frame | *no* `record` key | zero or more, after the header |
| Footer | `"record": "footer"` | last line, at most once |

A `RawFrameRecord` has exactly the ten §9.1 keys and none of them is `record`,
so the discriminator is unambiguous **and** the recording layer adds no field to
the record the handoff specifies. A reader must reject a frame line carrying an
unknown key rather than ignoring it: on the recording path, an unexplained field
is a defect, not a nicety.

---

## 4. Header record

Written when the segment file is created, and fsynced immediately.

```json
{"record":"header","formatId":"polymarket-bot/wal/v1","walSchemaVersion":1,"segmentId":"…","gatewayEpoch":"…","segmentIndex":0,"createdAt":"2026-01-01T00:01:00.000Z"}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `record` | `"header"` | discriminator |
| `formatId` | string | `"polymarket-bot/wal/v1"`; a reader refuses an unknown value |
| `walSchemaVersion` | integer ≥ 1 | §9.1 "File header includes schema version" |
| `segmentId` | non-empty string | must match the file name |
| `gatewayEpoch` | non-empty string | §9.1 "…and gateway epoch"; every frame in the segment carries the same epoch |
| `segmentIndex` | integer ≥ 0 | per-directory ordinal at creation time; ordering aid, not identity |
| `createdAt` | ISO-8601 instant | wall clock from the injected clock |

Segments are opened **lazily**, on the first frame that needs one, so a writer
that accepts no frames creates no file and `createdAt` is the time of the first
append rather than of process start.

---

## 5. Frame record

Exactly the handoff §9.1 `RawFrameRecord`, with keys emitted in the declared
order, so one record always produces one byte sequence (§12.4 determinism):

```json
{"gatewayEpoch":"…","ingestSeq":"1","source":"polymarket","endpoint":"wss://…/ws/market","connectionId":"conn-1","subscriptionGeneration":0,"receivedAt":"2026-01-01T00:00:00.000Z","receivedMonotonicNs":"1000000","payloadUtf8":"{\"event_type\":\"book\"}","payloadSha256":"eec4…5511"}
```

| Field | Grammar | Notes |
| --- | --- | --- |
| `gatewayEpoch` | non-empty string ≤ 256 chars | §7.1; equals the header's |
| `ingestSeq` | `^(0\|[1-9][0-9]*)$`, ≤ 40 digits | bigint serialized as a string (§7.1); no leading zeros, no sign |
| `source` | non-empty string ≤ 256 | free-form here; the §7.1 `source` vocabulary is enforced in `packages/domain`, not in the archive |
| `endpoint` | non-empty string ≤ 2048 | the URL the frame arrived on |
| `connectionId` | non-empty string ≤ 256 | per-connection identity for gap attribution |
| `subscriptionGeneration` | integer ≥ 0 | incremented by a resubscription (§7.1) |
| `receivedAt` | ISO-8601 instant **with an explicit offset** | wall clock at receipt |
| `receivedMonotonicNs` | `^(0\|[1-9][0-9]*)$`, ≤ 40 digits | bigint nanoseconds, serialized as a string |
| `payloadUtf8` | string, ≤ 8 MiB of UTF-8 | **verbatim**, see below |
| `payloadSha256` | `^[0-9a-f]{64}$` | SHA-256 over the exact UTF-8 bytes of `payloadUtf8` |

No field of a raw frame is an economic value, so no decimal-string rule applies
here; economic values live in normalized events (`docs/contracts/domain.md` §3).

### 5.1 `payloadUtf8` is verbatim

The payload is the frame **exactly as received** — not normalized, not
re-serialized, not required to be JSON (ADR-004 §1, §6). Consequences a reader
must respect:

- **Do not assume it parses as JSON.** The CLOB market and user channels and the
  RTDS stream use the bare text frames `PING`/`PONG` as an application-level
  heartbeat (venue report §3, §4, §10.3), and §6 of ADR-004 requires them stored
  verbatim like any other frame.
- **A payload may contain anything a JSON string can hold** — newlines, tabs,
  control characters, lone surrogates, or text that itself looks like a header or
  footer record. JSON string escaping keeps all of it on one line, and none of it
  can terminate a record early. The fault suite asserts this with adversarial
  payloads (`test/fault-injection/wal/verbatim-frames.test.ts`).
- **A recorded frame need not produce a normalized event** (ADR-004 §6), so a
  compaction or replay consumer must tolerate raw records with no counterpart.
- **Binary frames are out of scope.** `payloadUtf8` is a UTF-8 string. If any
  feed is found to deliver binary payloads — the Binance and Coinbase framings
  are still to verify (`WP-080`, `WP-090`) — ADR-004 must be amended rather than
  reinterpreted, and this format's version bumped.

`payloadSha256` lets a consumer verify one record without rehashing a whole
segment; `assertPayloadDigest` in the package does exactly that.

---

## 6. Footer record and sidecar manifest

§9.1 requires "file footer **or** sidecar" with a record count and a SHA-256.
This format writes **both** for a cleanly closed segment, and the sidecar alone
when recovery closes a segment a dead process left behind (ADR-004 §2: a footer
cannot be written by a process that is no longer running).

### 6.1 Footer

```json
{"record":"footer","formatId":"polymarket-bot/wal/v1","walSchemaVersion":1,"segmentId":"…","gatewayEpoch":"…","recordCount":2,"checksummedByteLength":1069,"segmentSha256":"d8a1…a4d7","closedAt":"2026-01-01T00:01:00.000Z","closeReason":"shutdown"}
```

`recordCount` counts **frame** records only — the header and the footer are not
records in this sense. `closeReason` is one of `size-rotation`, `time-rotation`,
`manual-rotation`, `shutdown`, `recovery`, `write-fault`.

### 6.2 Sidecar manifest

The manifest is a superset of the footer plus the per-segment metadata `WP-130`
needs (id, epoch, record range, byte size, checksum, created/rotated timestamps).
It is pretty-printed, because an operator reads it during an incident, and the
Node filesystem implementation writes it through a temp file, an `fsync`, and a
rename, so a crash cannot leave a half-written sidecar that would make a good
segment look invalid.

| Field | Meaning |
| --- | --- |
| `manifestVersion`, `formatId`, `walSchemaVersion` | document and format identity |
| `segmentId`, `gatewayEpoch`, `segmentIndex`, `segmentFileName` | segment identity |
| `recordCount` | frame records on disk |
| `firstIngestSeq`, `lastIngestSeq` | record range, bigint-as-string; `null` for an empty segment |
| `firstReceivedAt`, `lastReceivedAt` | wall-clock range; `null` for an empty segment |
| `byteSize` | total file bytes, footer included |
| `checksummedByteLength` | bytes covered by `segmentSha256` |
| `segmentSha256` | see §7 |
| `createdAt` | from the header |
| `closedAt`, `closeReason` | preserved from the footer when one exists |
| `footerPresent` | whether the segment also carries an in-file footer |
| `truncatedTailBytes` | bytes removed by recovery as an incomplete final record; `0` for a clean close |

### 6.3 Agreement is field by field

When both a footer and a manifest exist they must agree, and "agree" means
**every field they both carry**, not only the count and the digest. The same
applies to the header, and to the records themselves.

A checksum protects the bytes. It protects nothing about the claims made *about*
those bytes: `gatewayEpoch`, `segmentIndex`, `firstIngestSeq`, `lastReceivedAt`,
`closeReason`, `footerPresent`, and `truncatedTailBytes` can all be edited in the
sidecar while every digest still verifies. Those fields are what `WP-130` carries
into dataset manifests (§12.5), so an edited `ingestSeq` range silently
mislabels which data a dataset contains. `validateSegment` therefore cross-checks:

| Manifest field | Checked against | Issue on disagreement |
| --- | --- | --- |
| `formatId`, `walSchemaVersion`, `segmentId`, `gatewayEpoch`, `segmentIndex`, `createdAt` | the segment header | `MANIFEST_HEADER_DISAGREE` |
| `formatId`, `walSchemaVersion`, `segmentId`, `gatewayEpoch`, `checksummedByteLength`, `closedAt`, `closeReason` | the footer, when present | `FOOTER_MANIFEST_DISAGREE` |
| `recordCount`, `segmentSha256` | the footer, when present | `FOOTER_MANIFEST_DISAGREE` |
| `recordCount`, `checksummedByteLength`, `segmentSha256`, `byteSize` | the bytes on disk | `RECORD_COUNT_MISMATCH`, `CHECKSUM_LENGTH_MISMATCH`, `CHECKSUM_MISMATCH`, `BYTE_SIZE_MISMATCH` |
| `firstIngestSeq`, `lastIngestSeq`, `firstReceivedAt`, `lastReceivedAt`, `footerPresent` | the records on disk | `MANIFEST_CONTENT_DISAGREE` |

and checks the manifest against itself (`MANIFEST_INCONSISTENT`):

- `segmentFileName` must follow from `segmentId`;
- a segment with a footer cannot also have had a tail truncated
  (`footerPresent` implies `truncatedTailBytes === 0`);
- only `recovery` or `write-fault` truncates a tail;
- `checksummedByteLength` cannot exceed `byteSize`;
- `recordCount === 0` exactly when the whole record range is `null`;
- when the segment id encodes an ordinal — the default factory's
  `<gatewayEpoch>-<000000>` shape — it must equal `segmentIndex`. An injected
  factory whose ids encode nothing is not second-guessed: identity is what the
  header says, never what the name implies (§2).

The content comparisons are skipped when the scan stopped on corruption, because
then it describes only a prefix and every field would disagree for the same
underlying reason.

---

## 7. Checksums

`segmentSha256` is SHA-256 over the **first `checksummedByteLength` bytes** of
the segment file: the header line plus every frame line, each including its
terminating `LF`.

The footer is excluded, necessarily — it contains the digest. The sidecar is a
separate file and is likewise not covered.

Verification without any of this code:

```bash
head -c "$(jq -r .checksummedByteLength seg.wal.manifest.json)" seg.wal.jsonl \
  | sha256sum
# must equal .segmentSha256 in the manifest and in the footer line
grep -c . seg.wal.jsonl   # header + records + footer = recordCount + 2
```

A segment is **valid** only when all of the following hold (this is exactly what
`validateSegment` decides):

1. It begins with a well-formed header for this `formatId` and schema version.
2. Every line parses as a header, frame, or footer, in that legal order.
3. There are no bytes after the footer, and no incomplete final record.
4. A manifest exists.
5. The manifest's `recordCount`, `checksummedByteLength`, `byteSize`, and
   `segmentSha256` all match the bytes on disk.
6. Every other field the manifest shares with the header, the footer, or the
   records agrees with them, and the manifest does not contradict itself (§6.3).

---

## 8. Rotation

Segments rotate by size **and** by time (§9.1). Both bounds are configuration and
both are observable (§14.3 includes segment age).

| Bound | Rule |
| --- | --- |
| `maxSegmentBytes` | rotate before appending a record that would take the segment past the bound |
| `maxSegmentAgeMs` | rotate before appending to a segment at least this old, measured on the **monotonic** clock |

Two deliberate exceptions:

- **A record is never split.** If a single record exceeds `maxSegmentBytes`, it
  is written whole into an otherwise empty segment, which therefore exceeds the
  bound. The bound governs when a segment stops accepting *more* records.
- **An empty segment never rotates.** Time-based rotation on an idle writer would
  otherwise produce a stream of empty segments.

Rotation writes the footer, fsyncs, writes the manifest, and only then opens the
next segment. A reader that sees segment *n+1* can therefore rely on segment *n*
being complete.

---

## 9. Durability

Periodic `fsync`, **not one per frame** (§9.1). Two thresholds; whichever trips
first wins:

| Setting | Default | Meaning |
| --- | --- | --- |
| `fsyncIntervalMs` | 1000 | maximum time unsynced data may sit in the page cache |
| `fsyncByteThreshold` | 1 MiB | **high-water mark** for unsynced bytes, not a hard cap |

`fsyncByteThreshold` is a high-water mark and the document says so rather than
implying a guarantee the implementation does not make. A drain stops building a
batch once appending the next record would take the segment past the threshold,
so the trigger fires at the crossing record instead of after an arbitrarily
large batch — but the record that crosses it is written whole, and a single
record may exceed the threshold on its own. **Unsynced bytes are therefore
bounded by `fsyncByteThreshold` plus one record, never by the queue depth.**

**`fsyncIntervalMs` is a published bound on data loss** (ADR-004 §3): a host
power loss can lose at most the frames appended since the last successful
`fsync`. Changing it changes the bound, so it belongs in the recorder runbook and
on the recorder dashboard, not only in a config file. The fault suite makes the
bound concrete rather than rhetorical: it simulates a power loss and requires
that exactly the post-`fsync` frames are the ones missing
(`test/fault-injection/wal/fsync-policy.test.ts`).

What is guaranteed when:

| After | Guarantee |
| --- | --- |
| `enqueue` returns `accepted: true` | the frame is in a bounded in-memory queue; **not** durable |
| `drain()` resolves | the frame's bytes were written to the file; durable only if an fsync was triggered |
| `flush()` resolves | every accepted frame is fsynced |
| `close()` resolves with a manifest | footer and manifest are fsynced; the segment is complete and verifiable |

A failing `fsync` is a fault, not a warning: the writer stops accepting frames
and the caller must reopen, at which point recovery reads what actually reached
the disk.

### 9.1 A manifest never describes unsynced bytes

**A manifest is written only after an `fsync` has covered every byte it
describes.** A clean close appends the footer, fsyncs, and only then writes the
sidecar; §10.1 makes the fault path do the same. The rule exists because a
manifest is a durability claim, and a claim about bytes that are still only in
the page cache is one a power loss can falsify: the segment comes back short
while its sidecar still says how many records it "has".

The consequence a consumer can rely on: **a manifest never overcounts.** If a
segment carries a manifest, the file holds at least the records the manifest
declares — after a crash, after a power loss, after a failed `fsync`. A segment
whose durability could not be proven carries no manifest at all, which makes it
unverified and therefore invisible to a compactor (§2), and the recorder reports
it through `unmanifestedFaultedSegments`.

Not guaranteed: directory-entry durability. The implementation does not fsync the
containing directory after creating a file, so a power loss immediately after a
segment is created may leave no directory entry on some filesystems (see §12).

---

## 10. Recovery

Recovery runs when a writer opens a directory, and can be run on its own by an
ops tool (`recoverWalDirectory`). Per segment:

| Observed state | Outcome | Action |
| --- | --- | --- |
| Manifest already present | `already-finalized` | nothing is read or written |
| Bytes after the last `LF` (incomplete final record) and the rest well-formed | `recovered-truncated` | truncate **exactly** those trailing bytes, then write the manifest |
| Ends on a record boundary, no footer, no manifest | `recovered-clean` | write the manifest |
| Footer present, manifest missing | `recovered-clean` | write the manifest, preserving the footer's `closeReason` and `closedAt` |
| No header survived (empty file, or only a partial header) | `empty` | truncate the partial header; write **no** manifest |
| Any other defect | `integrity-error` | change nothing; write **no** manifest; report the issue |

The rule this table encodes, from ADR-004 §3 and §9.1: **recovery truncates only
an incomplete final record.** It never discards a well-formed record, never
rewrites earlier bytes, and never repairs a mid-file corruption.

Two distinctions that are easy to get wrong, and are tested:

- A record is **incomplete** only if it lacks its terminating `LF`. A record that
  is newline-terminated but malformed is **corrupt**, not incomplete — even when
  it is the last record — and recovery must leave it alone. Deleting it would be
  exactly the silent repair the ADR forbids.
- An `integrity-error` does **not** stop the recorder (§4.2: a storage problem
  must not stop recording). The writer opens a fresh segment and continues; the
  corrupt segment stays on disk, without a manifest, and the caller opens a
  data-quality incident (§10.2 `data_quality_incidents`) so that the affected
  range is excluded from dataset manifests (§12.5).

**Recovery is idempotent.** Running it twice changes no byte: the second pass
finds a manifest and does nothing. `truncatedTailBytes` in the manifest preserves
what the first pass removed.

### 10.1 After a write fault, and the accepted-frame invariant

The invariant the recorder is built around, and the one worth stating before the
mechanism:

> A frame that `enqueue` accepted leaves the writer's accountability only by
> appearing in a segment manifest, or by being handed back through
> `pendingFrames()`. Never by both, and never by neither.

It holds for **every** way a write can fail, not only a failed append: creating
the segment (the header write), rotating it (the footer write), finalizing it,
and `fsync`. That distinction is load-bearing, because `drain()` empties the
queue before it opens, rotates, or syncs anything — so any failure in between
would otherwise leave the frames it had taken accounted for nowhere.

On a fault the writer transitions to `faulted`, refuses further frames, and moves
into `pendingFrames()` both the frames it never appended and the frames it
appended but no `fsync` has covered (`unprovenFrameCount` in the metrics is the
second group while the writer is still healthy).

Closing a faulted writer reconciles the segment against the disk:

1. **One last `fsync`**, to establish whether anything can be asserted at all.
   It is issued even when the counters believe nothing is unsynced, because after
   a torn append the counters describe the last known-good prefix while the file
   may hold more.
2. **If that `fsync` succeeds**, the writer reads back what actually reached the
   disk, truncates an incomplete final record, writes the manifest for the
   verified prefix, and removes from `pendingFrames()` exactly those frames that
   turned out to be durable — so the caller re-enqueues neither a lost frame nor
   a duplicate.
3. **If it fails**, the segment is left exactly as found and **unmanifested**.
   Nothing about the file can be asserted, so no manifest is written (§9.1), the
   segment stays unverified and out of a compactor's reach, and *every* frame it
   might hold stays with the caller. Recovery finalizes it on the next open,
   describing whatever actually survived.

A fault raised by `close()` itself is reconciled and then re-thrown: a close that
hit a write fault must not look like a clean shutdown, and `pendingFrames()` is
settled and readable in the caller's catch block. If the manifest cannot be
written either (a genuinely full disk), `close()` fails and may be retried once
space exists; if the process dies first, the next recovery finalizes the segment.

---

## 11. Ingestion contract (§8.3)

The raw-frame queue is bounded by frame count **and** by encoded bytes, and it
never drops:

- `enqueue` returns `{ accepted: false, reason }` with
  `reason ∈ {queue-overflow, capacity-exceeded, writer-closed, writer-faulted}`.
  The frame stays with the caller, and the refusal is reported through
  `observer.onOverflow`. Per §8.3 and ADR-004 §4, the caller opens a
  data-quality incident and halts affected trading; it does not discard silently.
- A malformed record raises `WalRecordValidationError` **synchronously** — a
  caller bug surfaced, not a frame recorded badly.
- The §8.3 metric `messagesDropped` moves **only** through
  `recordCallerDrop(count, reason)`: a drop is always a decision someone made and
  logged. No code path decrements a queue by discarding.

Exposed metrics use the §8.3 names literally — `currentDepth`, `maximumDepth`,
`oldestMessageAgeMs`, `messagesDropped`, `producerBlockedTimeMs`, `consumerLag` —
plus `overflowSignals`, `highWaterDepth`, and byte-depth counterparts.
`producerBlockedTimeMs` is always `0`, and that is a fact about the design (the
writer refuses instead of blocking), not a missing metric.

The §14.3 recorder family is on `WalWriter.metrics()`: WAL queue depth, bytes
written, fsync latency (`lastFsyncDurationMs`, `totalFsyncDurationMs`), segment
age (`activeSegmentAgeMs`), plus `dataLossBoundMs`, capacity accounting, and
refusal/fault counters. Compaction lag and object-upload status belong to
`WP-130`.

### 11.1 The hard capacity threshold

The hard capacity threshold (§4.2) is `maxTotalBytes`: when the directory reaches
it, frames are refused with `capacity-exceeded`. Nothing is deleted and nothing
is overwritten — filling the disk is the intended failure direction (ADR-004,
Consequences), and reaching the threshold is an incident.

**What the threshold bounds.** `maxTotalBytes` bounds the total bytes of every
segment file in the directory, **framing included** — not the frame lines alone.
A segment costs a header line and a footer line beyond its records, so admitting
frames against the frame bytes alone would let a 427-byte threshold end up with
1,049 bytes on disk, which is what the pre-remediation implementation did.

The admission test at `enqueue` is therefore:

```text
segmentBytesOnDisk + queuedFrameBytes + candidateFrameBytes + B  ≤  maxTotalBytes
```

where **B**, the reserved framing overhead, is:

```text
B = (footer of the open segment, if one is open)
  + N × (header + footer of a segment)
  N = number of further segments the unwritten frame bytes require
    = ceil(max(unwrittenBytes − roomLeftInTheOpenSegment, 0) / maxSegmentBytes)
```

Header and footer lengths are computed from the real gateway epoch and the real
segment ids, with every numeric field taken at `Number.MAX_SAFE_INTEGER`, the
timestamp at 24 characters, the longest `closeReason`, and 64 bytes of slack per
segment. B is deliberately an over-estimate: over-reserving only refuses sooner,
which is the safe direction, while under-reserving breaks the bound.

`capacityRemainingBytes` is the headroom for *frame bytes* under exactly this
definition — `maxTotalBytes − onDisk − queued − B`, clamped at zero. It is never
negative.

Two consequences worth stating plainly:

- **A threshold smaller than one segment's framing refuses everything.** With a
  427-byte frame, roughly 1,050 bytes are needed before a single frame can be
  admitted. Refusing is the honest answer; silently exceeding the threshold is
  not.
- **One case is not pre-accounted: a *time*-driven rotation that fires while
  previously accepted frames are still queued.** Its new segment's header and
  footer were not in B, so the total can transiently exceed `maxTotalBytes` by at
  most one segment's framing overhead per such rotation. The next admission
  decision sees the real bytes and refuses accordingly. Size-driven rotation is
  fully pre-accounted.

`maxTotalBytes` counts what the writer knows about — recovery's tally plus what
it has written. It is not a `statvfs` reading, so it bounds the WAL, not the
disk.

---

## 12. Versioning policy

Two independent version fields:

- **`walSchemaVersion`** (header, footer, manifest) versions the *segment*
  format. Bump it for any change a current reader cannot parse or would
  misinterpret: a new or removed frame field, a changed field grammar, a changed
  checksum coverage rule, a different line terminator, a binary payload
  representation. A reader refuses a version it does not implement rather than
  guessing.
- **`manifestVersion`** versions the sidecar document alone, so manifest
  metadata can grow without reinterpreting existing segments.

`formatId` (`polymarket-bot/wal/v1`) is the coarse discriminator: it changes only
for a wholesale format replacement, which would also be an ADR-004 amendment.

Rules:

1. A format change requires an ADR (or an amendment to ADR-004) **before**
   implementation, because persisted bytes and their checksums are the artifact.
2. Old versions stay readable for as long as segments of that version exist. A
   compactor reconciles counts and hashes across versions (`WP-130`).
3. Changing the checksum coverage, the key order, or the escaping rules changes
   `segmentSha256` for identical logical content, and therefore requires a
   version bump even though every field looks the same.
4. `RawFrameRecord` lives in `packages/storage-wal`, not in the frozen
   `packages/domain` (ADR-004 §1). Changing its shape is a WAL format change and
   follows this section, not the domain contract-freeze rule.

### Open items and known limits

| Item | Status |
| --- | --- |
| Single-writer-per-directory | An invariant, not an enforced one: no lock file exists. A second writer would refuse to reopen an existing segment file, but two writers with different epochs can interleave segments in one directory. |
| Directory fsync | Not performed; file-creation durability depends on the filesystem. |
| Binary payloads | Out of scope; requires an ADR-004 amendment (§5.1). |
| Compaction, upload, deletion, dataset manifests | `WP-130`. This package writes and verifies; it never deletes. |
| Per-record digest verification on read | Available via `assertPayloadDigest`, not performed by the reader by default; the segment checksum already covers the bytes. |
| At-least-once at a fault boundary | If a caller re-enqueues `pendingFrames()` without the reconciliation `close()` performs, duplicate raw records are possible. Duplicates are detectable by `(gatewayEpoch, ingestSeq)`; losing a frame is not. |
| Unmanifested faulted segments | A segment whose durability could not be proven (§10.1 case 3) keeps its bytes but gets no manifest until recovery runs. Its records are also in `pendingFrames()`, so re-recording them and then recovering the old segment produces duplicates — detectable, and preferred to loss. |
| Capacity vs. time-driven rotation | `maxTotalBytes` is pre-accounted for size-driven rotation only; see §11.1 for the bounded residual. |
| Byte-threshold fsync | A high-water mark bounded by the threshold plus one record, not a hard cap (§9). |

---

## 13. Worked example

A two-frame segment closed at shutdown — one JSON book frame and one `PING`
heartbeat — produced by the writer with an injected clock:

`0190a3e0-…-000000.wal.jsonl` (four lines, `LF`-terminated):

```text
{"record":"header","formatId":"polymarket-bot/wal/v1","walSchemaVersion":1,"segmentId":"0190a3e0-0000-7000-8000-000000000001-000000","gatewayEpoch":"0190a3e0-0000-7000-8000-000000000001","segmentIndex":0,"createdAt":"2026-01-01T00:01:00.000Z"}
{"gatewayEpoch":"0190a3e0-0000-7000-8000-000000000001","ingestSeq":"1","source":"polymarket","endpoint":"wss://ws-subscriptions-clob.polymarket.com/ws/market","connectionId":"conn-1","subscriptionGeneration":0,"receivedAt":"2026-01-01T00:00:00.000Z","receivedMonotonicNs":"1000000","payloadUtf8":"{\"event_type\":\"book\",\"asset_id\":\"71321045\"}","payloadSha256":"eec4ed23e761be8a653cab714a3c560548b0d3866264af5f030c5d2afb7c5511"}
{"gatewayEpoch":"0190a3e0-0000-7000-8000-000000000001","ingestSeq":"2","source":"polymarket","endpoint":"wss://ws-subscriptions-clob.polymarket.com/ws/market","connectionId":"conn-1","subscriptionGeneration":0,"receivedAt":"2026-01-01T00:00:10.000Z","receivedMonotonicNs":"10001000000","payloadUtf8":"PING","payloadSha256":"906055e56391a9362ff2e354e21a9e0ded69135ecadbea28eabcdf931686acbd"}
{"record":"footer","formatId":"polymarket-bot/wal/v1","walSchemaVersion":1,"segmentId":"0190a3e0-0000-7000-8000-000000000001-000000","gatewayEpoch":"0190a3e0-0000-7000-8000-000000000001","recordCount":2,"checksummedByteLength":1069,"segmentSha256":"d8a156204f781e83d2d0f6b1ea5c34c2992f03b00fa1aa18840ce26b8f69a4d7","closedAt":"2026-01-01T00:01:00.000Z","closeReason":"shutdown"}
```

The first 1069 bytes — the header and the two frame lines — hash to
`d8a156204f781e83d2d0f6b1ea5c34c2992f03b00fa1aa18840ce26b8f69a4d7`. The file is
1448 bytes; the remaining 379 are the footer line, which the digest does not
cover. The `PING` frame is stored exactly as received: four bytes, no JSON
wrapper, and its `payloadSha256` is the SHA-256 of those four bytes.

The sidecar `0190a3e0-…-000000.wal.manifest.json` repeats the count and the
digest and adds the record range (`firstIngestSeq` `"1"`, `lastIngestSeq` `"2"`),
the byte size, the timestamps, `footerPresent: true`, and
`truncatedTailBytes: 0`.

---

## 14. Reference

Implementation: `packages/storage-wal/src/`

| File | Role |
| --- | --- |
| `raw-frame.ts` | the §9.1 record, its grammar, and payload digests |
| `segment-format.ts` | line encoding and classification |
| `manifest.ts` | sidecar manifests and file naming |
| `queue.ts` | the bounded §8.3 queue |
| `segment-writer.ts` | one open segment: appends, running digest, fsync accounting |
| `writer.ts` | rotation, durability policy, refusals, fault handling |
| `reader.ts` | sequential reads and validation |
| `recovery.ts` | the §10 decision table |
| `node-file-system.ts`, `clock.ts` | the only modules that touch a real disk or clock |

Tests: `packages/storage-wal/src/**/*.test.ts` (unit, run by the root gate) and
`test/fault-injection/wal/**` (fault injection, run by
`pnpm --filter @polymarket-bot/storage-wal test:fault`; root `test:fault` and the
CI step are orchestrator-wired at merge).

The three sections above that state guarantees rather than layout each have a
suite whose job is to try to break them:

| Guarantee | Suite |
| --- | --- |
| §10.1 accepted-frame invariant, on every failing write path | `accepted-frame-invariant.test.ts` |
| §9.1 a manifest never overcounts, including after a power loss | `accepted-frame-invariant.test.ts` |
| §6.3 field-by-field agreement | `manifest-agreement.test.ts`, `checksum-validation.test.ts` |
| §11.1 the capacity bound, framing included | `wal-capacity.test.ts` |
| §9 the fsync bound and the byte high-water mark | `fsync-policy.test.ts` |
