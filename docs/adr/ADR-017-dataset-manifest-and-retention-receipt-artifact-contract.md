# ADR-017: The dataset-manifest and retention-receipt artifact contract

- **Status:** Accepted
- **Date:** 2026-09-02
- **Recorded by:** `GOV-1C` (orchestrator-authorized contract-owner governance
  round at Wave 1 closeout)
- **Implemented by:** `WP-130` (`packages/storage-parquet`,
  `python/research/compaction`, `apps/research-worker`) — **already shipped and
  merged**; this record pins the shipped decisions and changes no code
- **Supersedes / Superseded by:** none

## Context

`WP-130` produced two persisted, pinned artifacts of the archive: the **dataset
manifest** (`polymarket-bot/dataset-manifest/v1`, version constant
`DATASET_MANIFEST_VERSION = 1`) and the **retention receipt**
(`RETENTION_RECEIPT_FORMAT_ID` / `RETENTION_RECEIPT_VERSION`). Both are
checksummed documents other components will rely on for years — the same
argument `wal-format.md` §12 makes for the WAL bytes — and `WP-130`'s own
follow-ups (7, 9, 10, 11, 12, 13, accumulated across its remediation rounds)
asked for exactly this ADR, because each decision below was reviewed into the
implementation but recorded only in a handoff. `WP-140`'s validation harness
already relies on several of them.

This record pins four decisions. Everything else about the formats (field
lists, canonical encoding with fixed key order and a sidecar digest, the
`replayPins` explicit-`null` discipline) is specified by the module headers of
`packages/storage-parquet/src/dataset-manifest.ts` and
`retention-receipt.ts` and is evidence here, not re-decided.

## Decision

### 1. Two per-segment digests with two distinct roles — never interchangeable

Every `segments[]` entry of a dataset manifest carries **both** digests, and a
consumer must use each for its own role only:

| Digest | Coverage | Role |
| --- | --- | --- |
| `segmentSha256` | the WAL segment's **checksummed span** — header line plus every frame line (`wal-format.md` §7); under WAL format `polymarket-bot/wal/v1` this **excludes the footer line**, necessarily (the footer contains the digest) | **WAL-chain identity.** The value the WAL's own footer and sidecar manifest declare; what ties a dataset entry back to the recorded chain and what `validateSegment` re-verifies |
| `segmentFileSha256` | the segment file's **entire** `byteSize` bytes, footer included, computed at compaction time from bytes that were verified and archived | **Deletion-time identity.** The only digest that can detect a same-length post-compaction mutation of the footer (round-2 review, L-2); retention (`retention-proof.ts`) requires the file it is about to delete to hash to this pin over its full length |

Bindings:

1. **The coverage split is per-WAL-version.** "`segmentSha256` excludes the
   footer" is a fact about `polymarket-bot/wal/v1`'s checksum-coverage rule,
   not a timeless one. A future WAL version that changes checksum coverage
   (`wal-format.md` §12 rule 3) must restate **both** digests' coverage for
   that version before a compactor consumes it, and this ADR must be amended
   in the same change.
2. **The store-side verification boundary is stated, not implied**
   (`WP-130` follow-up 11): `segmentFileSha256`'s *presence and grammar* are
   validator-checkable forever; its *value* is provable only against a file
   retention has not yet deleted. After deletion, the pin is history — a
   record of what was verified at deletion time — and no tool may claim to
   "re-verify" it.
3. **Neither digest substitutes for the other.** Verifying the checksummed
   span proves nothing about the footer; verifying the whole file against
   `segmentFileSha256` does not re-derive the WAL-chain identity. A consumer
   that needs both properties checks both.

### 2. `nullable` pins Parquet repetition, in both directions

A dataset object's schema pin `nullable` means exactly the Parquet **schema
repetition** of the column: `nullable: true` ⇔ the column is `OPTIONAL`,
`nullable: false` ⇔ `REQUIRED`. It is not a statement about observed data
("no nulls happened to occur"), and validation is **bidirectional**: a pinned
`REQUIRED` column that is actually `OPTIONAL` fails, and a pinned `OPTIONAL`
column that is actually `REQUIRED` fails, both reconciled against the object's
real repetition metadata (round-4 review flipped a pin and required the
validator to notice; `python/research/compaction/validate.py` reads
`parquet_schema(...)` via DuckDB and compares). The TypeScript writer honors
the same meaning (`parquet-object.ts` passes `column.nullable` through to the
encoder's repetition). As of `DATASET_COLUMNS` today, every column is
`REQUIRED` except `exclusionReason`, which is `OPTIONAL` — changing that set
is a dataset-format change under §4 of this record's evidence rules, not a
reinterpretation.

### 3. The strict-JSON reading profile is the contract, not a parser accident

A reader of the manifest, the digest sidecar, or the retention receipt applies
the **strict-JSON profile** the shipped Python reader enforces
(`parse_strict_json`, `python/research/compaction/manifest.py`), stated here so
a second reader implements the same refusals **deliberately** rather than
inheriting whatever its JSON library happens to accept (`WP-130` follow-up 13):

1. **UTF-8 bytes only.** The document is decoded as UTF-8 and refused on any
   invalid sequence; a decoded string that cannot be re-encoded to UTF-8
   (an unpaired surrogate such as `"\ud800"` spelled via a JSON escape) is
   likewise refused.
2. **RFC 8259 literals only.** `NaN`, `Infinity`, and `-Infinity` are refused
   even where a host parser accepts them as an extension.
3. **Unique object keys.** A duplicate key is refused (`object_pairs_hook`
   style), never resolved last-wins — under last-wins, a second spelling of a
   pinned field is an undetected override of a checksummed claim.

The refusals are fail-closed: a document that violates the profile is a
malformed artifact (a typed validation failure), never a best-effort parse.
The writer side already emits within the profile by construction (canonical
serialization, fixed key order).

### 4. The retention receipt is reporting, not proof

The receipt records **what retention actually deleted, after the fact**. The
*proof* a deletion relies on is the persisted dataset manifest itself, which
the retention implementation re-fetches from the store and re-verifies against
the bytes it is about to delete (`retention-proof.ts`; the ADR-004 §5
upload → verify → delete order made mechanical). Consequences:

1. A crash after a deletion but before the receipt write loses **only the
   report** — the manifest is already durable and every deleted record is in a
   verified object it pins. No recovery path may treat a missing receipt as
   evidence that a deletion did not happen.
2. Deletion state lives **only** in receipts, never in the manifest: the
   manifest is immutable and is persisted before retention may delete, so a
   per-segment deletion flag in it would be either false when written or a
   mutation of pinned bytes (the round-1 H1 ordering finding).
3. No component may cite a receipt as an integrity proof. It is operational
   accounting (which segments, against which verified object, what failed);
   integrity claims come from the manifest and its digests (§1).

## Consequences

- The two digest roles, the repetition semantics, the reading profile, and the
  receipt's role now have a supersession path; before this record, changing
  any of them meant contradicting a merged handoff with nothing to supersede.
- A second reader (any language) has a normative refusal list; divergence
  between readers is a defect against §3, not a matter of parser taste.
- A future WAL version cannot silently inherit §1's coverage split (§1.1
  binds the amendment into the same change).
- **No code changes and no version moves.** The shipped implementation already
  conforms — this record is the pin, and it was verified against the code
  cited below on 2026-09-02. **Schema-version consequence for recorded data:
  none; no emitted field set changed, and the artifact version constants
  (`DATASET_MANIFEST_VERSION`, `RETENTION_RECEIPT_VERSION`,
  `PARQUET_LAYOUT_VERSION`) are unchanged.**

## Evidence

- `packages/storage-parquet/src/dataset-manifest.ts` — the module header
  (§12.5 pin table, canonical encoding, deletion-state-lives-elsewhere) and
  `DatasetSegmentEntry` (both digests, with the `segmentFileSha256` doc
  comment citing round-2 L-2); `constants.ts` (`DATASET_MANIFEST_FORMAT_ID`,
  versions).
- `packages/storage-parquet/src/retention-receipt.ts` — the header's
  "reporting, not proof" statement and the receipt shape;
  `retention-proof.ts` — the re-fetch-and-re-verify gate.
- `packages/storage-parquet/src/parquet-layout.ts` (`DATASET_COLUMNS`,
  per-column `nullable`) and `parquet-object.ts` (repetition passed to the
  writer).
- `python/research/compaction/manifest.py` (`parse_strict_json` and the UTF-8
  gate) and `validate.py` (the bidirectional repetition reconciliation, §
  around its `parquet_schema` query).
- `docs/handoffs/WP-130.md` — deviations and follow-ups 7, 9, 10, 11, 12, 13
  (each of which asked for a piece of this record), review rounds H1, L-2,
  round 4 M-A, round 5.
- `wal-format.md` §7 (checksum coverage), §12 (format versioning), and
  [ADR-004](./ADR-004-wal-format-durability-and-compaction.md) §5 (the
  upload/verify/delete order).
- **Venue facts:** none — this record asserts no venue behavior.
- **Safety:** no run-mode default is touched (ADR-010).
