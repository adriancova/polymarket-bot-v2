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
  creation order inside one epoch. A deployment may inject a different factory,
  subject to the width contract in §11.2; identity is whatever the header says,
  never what the file name implies, and a manifest records which of the two
  produced its id (§6.2 `segmentIdKind`).
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
| `segmentIdKind` | provenance of the id: `"default"` or `"opaque"`. Optional; see below |
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

**`segmentIdKind` records where the id came from, and nothing more.** It is
`"default"` exactly when the id is the string `defaultSegmentIdFactory` would
have produced for this manifest's own `gatewayEpoch` and `segmentIndex`, and
`"opaque"` otherwise. Every producer derives it the same way — the segment
writer, the writer's fault path, and recovery, which cannot know which factory a
dead process injected and therefore records only what it can verify from the
bytes.

The field exists because the ordinal cross-check below needs to know when an id
means anything. It is **optional**, under the §12 rule that manifest metadata may
grow: a manifest written before it existed carries no provenance, and the
cross-check is then skipped rather than guessed at. A *present* value must be one
this build understands, because the validator acts on it.

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
- when the manifest records `segmentIdKind: "default"`, the id must be exactly
  what the default factory produces for its `gatewayEpoch` and `segmentIndex`.

That last check runs **only** on recorded default-factory provenance. It used to
run on *shape* — any `<gatewayEpoch>-<digits>` id was read as an encoded ordinal
— and round-3 review reproduced the consequence: a deployment injecting its own
factory produced a valid segment with the id `<epoch>-999999` at `segmentIndex`
0, which `validateSegment` then rejected as `MANIFEST_INCONSISTENT`. §2 says an
id is opaque and identity is what the header says, never what the name implies,
and a shape-based inference contradicts that. Skipping the check where
provenance is unknown costs almost nothing: `MANIFEST_HEADER_DISAGREE` already
compares `segmentIndex` against the header, and the header sits inside the
checksummed bytes, so editing it instead is a `CHECKSUM_MISMATCH`.

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
| `close()` resolves with `null` after a fault | the segment carries **no** manifest, and every accepted frame is in `pendingFrames()` |

A failing `fsync` is a fault, not a warning: the writer stops accepting frames
and the caller must reopen, at which point recovery reads what actually reached
the disk.

### 9.1 The durability watermark, and what a manifest may claim

**Durability is proven by a watermark, not by whichever call returned last.**
Every segment carries one: the byte length and record count covered by the last
`fsync` that succeeded **with no earlier `fsync` or write failure on that
segment's handle**. After any such failure the watermark **freezes**, and no
later `fsync` success can move it again.

The freeze is the point, and it is not defensive decoration. On Linux a
writeback error is reported once and then cleared from the file description's
error cursor, so an `fsync` issued *after* a failed one can return success while
the bytes the failed writeback was carrying never reached the disk; POSIX
likewise leaves the state of a file unspecified after a failed `fsync`. A
success that follows a failure is therefore not evidence. Round-2 review
reproduced the consequence of treating it as evidence: a header fsync that
succeeded, a frame fsync that returned `EIO`, a fault-close fsync that returned
success, and then a power loss — leaving a manifest claiming one record over a
file holding none.

**A manifest is written only when the watermark covers every byte it
describes.** A clean close appends the footer, fsyncs, and only then writes the
sidecar. The fault path (§10.1) compares the watermark against the verified
prefix and, when the watermark falls short, writes **no manifest at all** —
partially describing a segment is not something this format can do, and a
manifest that named the uncovered records would be exactly the claim a power
loss falsifies.

The consequence a consumer can rely on: **a manifest never overcounts.** If a
segment carries a manifest, the file holds at least the records the manifest
declares — after a crash, after a power loss, after a failed `fsync`. A segment
whose durability could not be proven carries no manifest at all, which makes it
unverified and therefore invisible to a compactor (§2), and the recorder reports
it through `unmanifestedFaultedSegments`.

Two costs of the rule, stated rather than hidden:

- **It under-claims on purpose.** Any write or `fsync` failure on a segment's
  handle makes every record past the watermark unmanifestable, even when those
  bytes did in fact reach the disk. A torn append, an `ENOSPC`, or a failed
  periodic `fsync` therefore usually leaves the whole segment unmanifested. The
  records go back to the caller through `pendingFrames()`, so nothing is lost —
  but re-recording them and then letting recovery finalize the abandoned segment
  produces duplicates (§12). Under-claiming costs duplicates; over-claiming
  costs data, and duplicates are detectable while a lost frame is not.

  **This is exactly why a successful `fsync` may not release a record from the
  writer's accountability**, and getting that backwards was the round-3 defect.
  See §10.2.
- **The fault-close `fsync` is still issued**, because on a handle with no
  failure history it genuinely proves the bytes a torn append left behind — that
  is the one case where the watermark still advances at close. Its success
  extends nothing once the watermark is frozen.

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
into `pendingFrames()`, in accept order, **all three** groups of frames it is
still holding:

1. every record appended to the still-unmanifested active segment — including
   records an earlier successful `fsync` covered, because accountability is
   released only by a written manifest, never by `fsync` (`unprovenFrameCount`
   still reports the narrower watermark-uncovered subset in the
   metrics is this group while the writer is still healthy);
2. the frames `drain()` had taken from the queue and not yet appended;
3. **the frames still in the queue.** A faulted writer will never write them —
   `enqueue` refuses from now on and `drain()` refuses to run — so leaving them
   in a queue that looks "still to be written" hides them from the caller. This
   is the case a fault raised by `tick()` produces, since `tick()` takes nothing
   from the queue; round-2 review found such a frame accounted for nowhere.

The queue depth is therefore `0` immediately after a fault, and
`pendingFrameCount` accounts for every frame the writer ever accepted and has
not manifested.

Closing a faulted writer reconciles the segment against the disk:

1. **One last `fsync`, best effort.** It is issued even when the counters believe
   nothing is unsynced, because after a torn append the counters describe the
   last known-good prefix while the file may hold more. On a handle with no
   failure history its success advances the watermark; on a frozen watermark it
   proves nothing and advances nothing (§9.1).
2. **An incomplete final record is truncated** — file hygiene, allowed by
   ADR-004 §3, and independent of any durability claim.
3. **If the watermark covers the whole verified prefix**, the writer writes the
   manifest for it, and **in the same step** removes from `pendingFrames()`
   exactly the records that manifest names. Accountability transfers there and
   nowhere else, which is what makes "never by both" true even across a retry:
   a failed sidecar write leaves every frame with the caller and the segment
   unmanifested, and a later successful attempt moves them exactly once.
4. **Otherwise** — the prefix cannot be verified, or the watermark does not cover
   it — the segment is left **unmanifested**. It stays unverified and out of a
   compactor's reach, and *every* frame it might hold stays with the caller.
   Recovery finalizes it on the next open, describing whatever actually
   survived, which is a disclosed duplicate source (§12).

A fault raised by `close()` itself is reconciled and then re-thrown: a close that
hit a write fault must not look like a clean shutdown, and `pendingFrames()` is
settled and readable in the caller's catch block. If the manifest cannot be
written either (a genuinely full disk), `close()` fails and may be retried once
space exists; if the process dies first, the next recovery finalizes the segment.

### 10.2 Accountability is not durability

Two questions look alike and are not, and the recorder keeps a separate answer
for each. Conflating them is how §10.1's "every frame it might hold" was true of
the document and false of the code until round 3.

| Question | Answer | Advanced by | Released by |
| --- | --- | --- | --- |
| **Durable-for-manifest** — what may a manifest claim? | the segment's durability watermark (§9.1) | a successful `fsync` on a handle with no failure history | never; a failure freezes it |
| **Retained-for-accountability** — which accepted records is the writer still answerable for? | every record appended to the active segment that no *written* manifest names | every append | a manifest write, and nothing else |

The second is never smaller than the first, and the writer exposes both:
`unprovenFrameCount` is the durability number — the frames a power loss would
cost right now — and `retainedRecordCount` is the accountability one, which is
what a fault hands back.

**Why an `fsync` may not release a record.** It is tempting to reason that a
record the disk has confirmed will end up in a manifest, so the writer can stop
holding it. Under the watermark rule it usually will not: a *later* failure
freezes the watermark short of the file, and §10.1 case 4 then writes **no
manifest for the segment at all** — including for the records an earlier `fsync`
did prove. A writer that released on `fsync` therefore left those records named
by no manifest and absent from `pendingFrames()`, which is the silent gap the
invariant exists to forbid. Round-3 review reproduced it three ways: a `tick()`
rotation whose footer write failed, one whose `fsync` failed, and a mid-batch
torn append — in each case with one frame flushed beforehand, and in each case
that frame accounted for nowhere.

**Why a manifest write must release it.** The symmetric error is to retain
forever, which would hand back records a manifest already names and break "never
by both" on every clean close. So the release happens in the same step the
manifest lands, for exactly the records it names — the round-2 rule, unchanged.
A segment that is manifested is finished with; a segment that is not returns
everything.

**What it costs.** The writer holds the raw records of the *active* segment in
memory until that segment is manifested, so its retention is bounded by
`maxSegmentBytes` rather than by the fsync interval. For a healthy writer the
list empties at every rotation. A deployment that wants a smaller resident set
buys it with smaller segments or more frequent rotation; the encoded copies are
not retained, only the records themselves. Paying memory bounded by
configuration is the deliberate trade against an unaccountable frame.

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

> **Corrected 2026-10-04 (`GOV-NOTES-1`): what the threshold counts, what
> admission charges, and when a time rotation waits.** `WALCAP-1` changed all
> three. It merged as `da559ca` on 2026-10-03. Its record is
> `docs/handoffs/WALCAP-1.md`. Where the text below differs, this note states
> the current rule. Symbols are in `packages/storage-wal/src/`.
>
> - **A ledger, not a running sum.** With `maxTotalBytes` set, the writer
>   counts a per-file ledger of segment files (`SegmentByteLedger` in
>   `capacity-ledger.ts`). The old count, recovery's tally plus what the
>   writer wrote, was never lowered.
> - **Its scope.**
>   - Every `*.wal.jsonl` file in the writer's own directory. Sidecar
>     manifests do not count.
>   - When `capacityRootPath` names a WAL root, also every one in the root
>     and in its immediate subdirectories. The gateway names its WAL root, so
>     every epoch counts. It then assumes one writer per WAL root, a wider
>     premise than §2's one writer per directory.
> - **When it is read.**
>   - From the disk at open (`openWalWriter`). A read that fails fails the
>     open.
>   - Again on every `tick()` while the writer is open, one re-derivation at
>     a time (`#rescanCapacity`). A re-derivation that fails part-way keeps
>     the changes it made, and adds one to `capacityRescanFailures`.
> - **What raises it.** The writer's own writes, and a length read of a file
>   it does not count yet, or above its entry (`SegmentByteLedger.observe`).
>   A write that fails is counted before the writer faults
>   (`#countAfterFailedWrite`).
> - **What lowers it.**
>   - An entry is removed only when a direct length read finds its file gone
>     (`SegmentByteLedger.forget`). On a gateway host that is raw-WAL expiry
>     (ADR-028 Decision 2). A listing alone removes nothing, and the open
>     segment is never removed.
>   - Otherwise an entry falls only to a sealed segment's exact size. The
>     fault path does so when it truncates a torn tail and then writes the
>     manifest (`#finalizeFaultedSegment`).
> - **The admission test** at `enqueue` is now:
>
>   ```text
>   ledgerBytes + inFlightFrameBytes + queuedFrameBytes + candidateFrameBytes + B  ≤  maxTotalBytes
>   ```
>
>   - `ledgerBytes` is the ledger's total.
>   - `inFlightFrameBytes` are frames `drain()` has taken from the queue and
>     not yet written. They leave the sum when the ledger counts them.
>   - B is the open segment's footer, if one is open, plus the larger
>     framing overhead of two packings (`CapacityProjection`). Each packs the
>     in-flight frames first, then the queued ones, then the candidate
>     (`#packFrames`).
>   - `bySize` packs them from the open segment's room, as below.
>   - `closedFirst` packs them from a new segment, as if a time rotation
>     closed the open one first. It applies only when the open segment holds
>     a record.
> - **`capacityRemainingBytes`** is
>   `maxTotalBytes − ledgerBytes − inFlightFrameBytes − queuedFrameBytes − B`,
>   clamped at zero. Here B packs no candidate: it is the open segment's
>   footer plus the framing of the unwritten frames alone
>   (`#reservedOverheadBytes`). So a frame of that size may still be refused,
>   when packing it starts a further segment.
> - **A time rotation can wait at the threshold.** With `maxTotalBytes` set,
>   this qualifies §8's `maxSegmentAgeMs` row, where this contract states the
>   time half of handoff §9.1's "Rotate by size and time".
>   - Before a time rotation closes an aged segment, the writer checks the
>     frames still unwritten (`#mayCloseByTime`).
>   - The rotation waits only if both hold:
>     - closing first would cost those frames more framing than keeping the
>       segment open;
>     - the ledger, the unwritten frames, the open segment's footer and that
>       framing would together pass `maxTotalBytes`.
>   - While it waits, the segment stays open past `maxSegmentAgeMs`. Frames
>     go into it by the size rule, and a size rotation can still close it.
>   - The aged segment is closed by time at the first rotation check at which
>     either condition fails. `drain()` checks only before each batch of
>     frames it writes, so it always sees a frame unwritten. It never checks
>     on an empty queue. `tick()` checks with or without a backlog. With no
>     frame unwritten, the first condition always fails, so the first
>     `tick()` that finds no frame unwritten closes it.
>   - A waiting rotation does not hold back `tick()`'s interval `fsync`, so
>     §9's data-loss bound is unchanged.
>   - `timeRotationsDeferred` counts each waiting segment once.
> - **The third consequence below, and §12's "Capacity vs. time-driven
>   rotation" row, no longer hold.** `closedFirst` reserves the framing of a
>   time rotation that admission can foresee. One it could not foresee waits
>   rather than pass `maxTotalBytes`.
> - **The last paragraph's "recovery's tally plus what it has written"** now
>   describes only the `totalSegmentBytes` metric with no threshold set, when
>   `capacityRemainingBytes` is `null`. With a threshold, the count is the
>   ledger. Neither is a `statvfs` reading.
> - **Unchanged:** this package deletes nothing, and reaching the threshold
>   refuses frames with `capacity-exceeded`.

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
  + Σ over the further segments the queued frames will need,
      of (header + footer of that segment)
```

**"Will need" is a packing question, not a division.** A segment holds whole
records, so the number of segments a backlog occupies depends on how the records
pack, not on how many bytes they sum to. The writer therefore places the queued
frames one at a time, exactly as `drain()` will, against the rotation rule of §8:

```text
roomLeft ← maxSegmentBytes − (bytes already in the open segment)
for each queued frame, in order:
    if it fits in roomLeft (or the segment holds no record yet):  roomLeft −= its bytes
    else: start a further segment; roomLeft ← maxSegmentBytes − header − its bytes
```

Dividing instead — `ceil(unwrittenBytes / maxSegmentBytes)` — under-reserves
twice over: it ignores the header each new segment spends out of the same
budget, and it assumes records subdivide. With 900-byte segments and 415-byte
frames, ten frames need ten segments while the division predicts five, and
round-2 review measured queued bursts of 3, 10 and 20 frames overshooting the
threshold by 306, 2,340 and 4,695 bytes. Only a *queued* burst exposes it:
draining between offers leaves one frame unwritten, and one frame never needs
more than one segment.

Header and footer lengths are computed from the real gateway epoch and a
**bounded** segment-id width (§11.2), with every numeric field taken at
`Number.MAX_SAFE_INTEGER`, the timestamp at 24 characters, the longest
`closeReason`, and 64 bytes of slack per segment; the same widened header is what
the packing subtracts from each new segment's usable space. B is deliberately an
over-estimate: over-reserving only refuses sooner, which is the safe direction,
while under-reserving breaks the bound.

`capacityRemainingBytes` is the headroom for *frame bytes* under exactly this
definition — `maxTotalBytes − onDisk − queued − B`, clamped at zero. It is never
negative.

Three consequences worth stating plainly:

- **A threshold smaller than one segment's framing refuses everything.** With a
  427-byte frame, roughly 1,050 bytes are needed before a single frame can be
  admitted. Refusing is the honest answer; silently exceeding the threshold is
  not.
- **A `maxSegmentBytes` smaller than a header's worst-case width refuses
  everything too**, because no segment then has usable space to project into.
  That configuration cannot record anything under a threshold anyway.
- **One case is not pre-accounted: a *time*-driven rotation that fires while
  previously accepted frames are still queued.** Its new segment's header and
  footer were not in B, so the total can transiently exceed `maxTotalBytes` by at
  most one segment's framing overhead per such rotation. The next admission
  decision sees the real bytes and refuses accordingly. Size-driven rotation is
  fully pre-accounted, including for a queued burst.

`maxTotalBytes` counts what the writer knows about — recovery's tally plus what
it has written. It is not a `statvfs` reading, so it bounds the WAL, not the
disk.

### 11.2 The `SegmentIdFactory` contract, and why the bound needs one

A segment id is written into the header line **and** into the footer line, so
its width is part of the framing §11.1 must charge for — before either line
exists. That makes the id's width a capacity input, and an input a bound depends
on has to be bounded itself.

> **The contract.** A `SegmentIdFactory` returns a non-empty string whose JSON
> encoding — `JSON.stringify(segmentId)` — is at most **1024 UTF-8 bytes**
> (`MAX_SEGMENT_ID_ENCODED_BYTES`). A plain-ASCII id may therefore be up to 1022
> characters; an id built from characters JSON must escape is proportionally
> shorter.

The bound is **enforced, not assumed**, at two points, and both refuse rather
than record:

- when the writer is opened, against the factory's first id, so a plainly wrong
  factory costs a `WalConfigurationError` and not a half-started recorder;
- at every segment open, **before the file is created**, so an id that leaves
  the bound later faults the writer loudly with every accepted frame in
  `pendingFrames()`, and never becomes bytes nothing reserved for.

**What the reservation charges.** The default factory is a pure function of the
epoch and the ordinal — it ignores `createdAtMs` — so its id is computed exactly,
and the numbers above are unchanged. **Any injected factory is charged the full
1024-byte bound**, because `SegmentIdContext` carries `createdAtMs` and a factory
is entitled to use it: the id measured when a frame is admitted then has no
relation to the id written when the segment opens. Round-3 review measured
exactly that — a projection taken against a short id, a much longer id at open,
and `maxTotalBytes` exceeded by 7,964 bytes; a second probe, with ids growing
from 27 to 546 encoded bytes, finished 756 bytes past a 6,000-byte threshold.
Sixty-four bytes of slack cannot cover an input that is free to change by
kilobytes, and no measurement can bound a function of the clock.

Two consequences, in the safe direction:

- An injected factory costs roughly **1 KB more reservation per segment** than
  the default one, so it reaches `capacity-exceeded` sooner. Over-reserving only
  refuses earlier.
- A `maxSegmentBytes` below the widened header refuses everything for an injected
  factory, for the same reason §11.1 already gives. A deployment that wants tight
  segments should use the default factory or accept the reservation.

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

### 12.1 Cross-epoch chronology — ruled: epochs are identity, not chronology

*(Added 2026-09-02 by `GOV-1C`, the contract-owner governance round, closing
`WP-130` `follow_up` 8. This is a ruling on what this format has always
defined, not a change to any byte.)*

1. **A `gatewayEpoch` establishes identity, never order.** This format defines
   **no** chronological order — total or partial — between two segments whose
   headers carry different `gatewayEpoch` values. `segmentIndex` is a
   per-directory ordinal **within one epoch** (§4: "ordering aid, not
   identity"), and nothing a reader can see in the bytes orders one epoch
   against another.
2. **A compaction batch is single-epoch.** A consumer that must dispatch
   records in a defined order (the `WP-130` compactor; any future replay
   assembler) processes one epoch at a time and **refuses** mixed-epoch input
   rather than inventing an order. This ratifies the shipped behavior:
   `packages/storage-parquet` raises `CrossEpochOrderError`
   ("`CROSS_EPOCH_ORDER`") on a verified batch spanning epochs, and a caller
   compacts epoch by epoch via `segmentIds`.
3. **Mixed-epoch *directories* are not ruled out.** They arise legitimately — a
   recorder restart in place writes new-epoch segments beside old-epoch ones
   (§12's single-writer row already notes the interleaving) — and remain valid
   on disk. What is ruled out is deriving a cross-epoch *chronology* from
   anything this format records.
4. **What may NOT be used as a chronology**, each rejected on evidence:
   - the epoch id's UUIDv7 timestamp bits, or any lexical/derived ordering of
     epoch ids — `WP-130` review round 1 (finding M1) reproduced a
     chronologically older epoch archived after a newer one under exactly that
     inference, and the id is opaque by §2;
   - header/footer wall-clock fields (`createdAt`, `closedAt`) or frame
     `receivedAt` — wall clocks step across restarts and carry no cross-boot
     monotonic guarantee (`receivedMonotonicNs` is explicitly per-process);
   - file names or directory listing order — §2: identity is what the header
     says, never what the name implies, and ADR-004 §5 has replay consume
     manifests, not listings.
5. **The reopen path is stated, not left open.** If cross-epoch ordering is
   ever needed, it requires **new recorded evidence** — a record written at
   epoch start that a reader can verifiably order (for example a monotonic
   epoch-succession record naming the predecessor epoch), which is a frame- or
   header-shape change — and therefore an ADR-004 amendment **before**
   implementation, with a `walSchemaVersion` bump, per rules 1 and 3 of this
   section. Until then, any component that claims a cross-epoch order is
   asserting something this contract does not contain.

### Open items and known limits

| Item | Status |
| --- | --- |
| Single-writer-per-directory | An invariant, not an enforced one: no lock file exists. A second writer would refuse to reopen an existing segment file, but two writers with different epochs can interleave segments in one directory. |
| Cross-epoch chronology | **Ruled 2026-09-02 (§12.1): none is defined.** Epochs are identity, not chronology; a compaction batch is single-epoch (`CrossEpochOrderError` ratified); defining an order later requires new recorded evidence and an ADR-004 amendment with a version bump. |
| Directory fsync | Not performed; file-creation durability depends on the filesystem. |
| Binary payloads | Out of scope; requires an ADR-004 amendment (§5.1). |
| Compaction, upload, deletion, dataset manifests | `WP-130`. This package writes and verifies; it never deletes. |
| Per-record digest verification on read | Available via `assertPayloadDigest`, not performed by the reader by default; the segment checksum already covers the bytes. |
| At-least-once at a fault boundary | If a caller re-enqueues `pendingFrames()` without the reconciliation `close()` performs, duplicate raw records are possible. Duplicates are detectable by `(gatewayEpoch, ingestSeq)`; losing a frame is not. |
| Unmanifested faulted segments | A segment whose durability could not be proven (§10.1 case 4) keeps its bytes but gets no manifest until recovery runs. Its records are also in `pendingFrames()`, so re-recording them and then recovering the old segment produces duplicates — detectable, and preferred to loss. The watermark rule of §9.1 makes this the **usual** outcome of a write or `fsync` failure, not a rare one: expect duplicates at a fault boundary, and reconcile on `(gatewayEpoch, ingestSeq)`. |
| Durability under-claiming | The watermark freezes on any failure on a segment's handle, so records that did reach the disk can still be reported as unproven. That is deliberate (§9.1) and it costs duplicates, not data. Relaxing it — for instance to freeze only on `fsync` failure — is a durability-semantics change and needs an ADR, not a patch. |
| Capacity vs. time-driven rotation | `maxTotalBytes` is pre-accounted for size-driven rotation only, including for a queued burst; see §11.1 for the bounded residual. |
| Byte-threshold fsync | A high-water mark bounded by the threshold plus one record, not a hard cap (§9). |
| Accountability retention | The writer holds the active segment's records in memory until that segment is manifested (§10.2), so its resident set is bounded by `maxSegmentBytes` rather than by the fsync interval. Smaller segments buy a smaller one. |
| Segment id width | Bounded by contract and enforced at open (§11.2). An injected factory is charged the full bound, so it refuses sooner than the default one would. |

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
| `segment-writer.ts` | one open segment: appends, running digest, and the §9.1 durability watermark |
| `writer.ts` | rotation, durability policy, refusals, fault handling, the §10.2 accountability retention, the §11.1 capacity projection and the §11.2 id bound |
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
| §10.1 accepted-frame invariant, on every failing write path, including a fault raised by `tick()` with frames still queued | `accepted-frame-invariant.test.ts` |
| §9.1 a manifest never overcounts, including after a power loss, and a post-failure `fsync` success extends no claim | `accepted-frame-invariant.test.ts`, `torn-write-recovery.test.ts`, `fsync-policy.test.ts` |
| §10.1 accountability transfers at the manifest write and nowhere else, across sidecar retries | `accepted-frame-invariant.test.ts`, `wal-capacity.test.ts` |
| §10.2 an unmanifested segment returns **every** record it might hold, including ones an earlier `fsync` proved — and returns no record a manifest names | `at-least-once-accountability.test.ts` |
| §6.3 field-by-field agreement, and the ordinal cross-check only on recorded default provenance | `manifest-agreement.test.ts`, `checksum-validation.test.ts` |
| §11.1 the capacity bound, framing included, for a **queued burst** at cap-exact thresholds | `wal-capacity.test.ts` |
| §11.2 the bound holds against an injected `segmentIdFactory`, and an over-long id is refused rather than charged | `wal-capacity.test.ts` |
| §9 the fsync bound and the byte high-water mark | `fsync-policy.test.ts` |

The defects rounds 2 and 3 found are also covered at unit level, in
`packages/storage-wal/src/writer.test.ts` and
`packages/storage-wal/src/manifest.test.ts`, because the fault tree is not yet in
the root gate or in CI.
