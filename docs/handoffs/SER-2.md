# SER-2 completion record — durable bytes: WAL, Parquet and every `jsonb` write

**Merged:** `0d8b6a0` (`--no-ff`, 2026-09-15). Chain on base `a9dcb8a`:
`cb610e7` (candidate) → `a500f8c` (r1). Review arc: r1 **CHANGES REQUIRED**
(1 HIGH, 1 MEDIUM) → r2 **ACCEPT** (4 LOW, none blocking). One remediation
round, opened by the reviewer.

**What it is.** Round 2 of the `docs/handoffs/SER-0-sweep.md` remediation: every
byte this repository persists is now produced by `encodePlainJson`
(`@polymarket-bot/risk/plain-json`, shipped by `SER-1`), and every object-typed
`jsonb` parameter is handed to `pg` as pre-serialized TEXT.

At base, `JSON.stringify` resolved `toJSON` through the prototype chain, so an
inherited `toJSON` replaced the bytes of any object or `Array.prototype`-backed
array. Measured and independently re-measured this round with a real `WalWriter`:
under `Object.prototype` pollution the persisted frame line was `"POLLUTED"\n`,
fed to the running SHA-256, attested by the footer AND the sidecar manifest, and
the writer reported the frame durable and cleared it from `pendingFrames` — the
evidence existed nowhere else. The `pg` route was worse than a byte change: the
repository's own `assertDecimalSafeJson` guard judges the object and returns the
same reference, and `pg@8.23.0`'s `prepareObject` then encodes it from the
prototype chain (after a plain `val.toPostgres` property get — a second inherited
lookup), so a guard-PASS document could be stored as `"POLLUTED"`.

## What shipped

1. **`packages/storage-wal`** — `segment-format.ts` `encodeLine` (the ONE encoder
   for header, frame and footer lines) and `manifest.ts` `encodeSegmentManifest`
   (`indent: 2`) use the primitive; the typed refusal is classified by an
   own-data read of `kind` and re-thrown as the existing
   `WalSegmentIntegrityError`. `writer.ts`'s reserve-byte functions close through
   `encodeLine`; `encodedSegmentIdBytes` stays `JSON.stringify` of a STRING
   primitive (immune by specification, documented at the site).
2. **`packages/storage-parquet`** — `encodeFrameLine`, `encodeDatasetManifest`
   and `encodeRetentionReceipt` use the primitive.
3. **`packages/storage-postgres`** — new `encodeJsonbText(document, field)` in
   `json.ts`: `null → null`, string → passthrough, object → `encodePlainJson`,
   with the refusal mapped onto the package's existing `DecimalSafeJsonError`
   (`BIGINT` keeps the guard's own wording; every other kind →
   `ECONOMIC_JSON_MALFORMED`). The guard stays exactly where it was; the rule is
   now one sentence: **the guard JUDGES, the repository ENCODES, `pg` receives
   text.** Seven sites bind the string (`orders.ts` ×3, `strategy.ts` ×2,
   `catalog.ts`, `dataset-catalog.ts`'s three identity columns).
4. **`apps/trader/src/adapters/postgres-store.ts`** — `model_outputs` and
   `state_patch` bound through `encodeJsonbText`; both `as never` casts removed.
5. **r1** — the malformed-segment diagnostic is bounded where it is CAPTURED:
   `describeDiscriminator` renders a string verbatim to 256 characters (the
   format's own `MAX_IDENTIFIER_LENGTH`, so a well-formed diagnostic is
   byte-identical) and any other shape as a bounded description;
   `boundedDiagnosticText`/`boundedDiagnosticMessage` truncate stating the true
   length and never split a surrogate pair; `WalSegmentIssue["details"]` is
   narrowed to the exported `WalSegmentIssueDetail`. Both refusal classifiers
   gained hostile-thrown-value pins.
6. Three packages gained the downward `@polymarket-bot/risk` link (layer 2 → 1,
   no §2.1 row); `pnpm-lock.yaml` gained exactly the three importer entries.

## The review arc

- **r1 (`cb610e7`, CHANGES REQUIRED).** **H1 (HIGH):** `wal-format.ts` copied an
  unknown `record` discriminator — arbitrary `JSON.parse` output from a malformed
  WAL line, unbounded in depth AND size — into `issue.details`, which
  `dataset-manifest.ts` carried verbatim into the manifest; `encodePlainJson`'s
  default `maxDepth` 64 then REFUSED, so a malformed segment ABORTED the whole
  compaction batch at `compactor.ts:610` where base excluded it and continued.
  The candidate's own comment calling that refusal "unreachable" was false.
  **M1 (MEDIUM):** the `instanceof` mutant survived every relevant suite on both
  new classifiers. The round also verified, positively: real-Kysely binding over
  7 sites / 9 columns with `prepareObjectEntries=0` and `toPostgresLookups=0`;
  14,000 differential comparisons with zero byte differences; a live PostgreSQL
  round-trip showing a bound string lands as `jsonb_typeof = object` while the
  base-hijacked text lands as the string `"POLLUTED"`.
- **r2 (`a500f8c`, ACCEPT).** H1 closed as a CLASS, not one probe: an independent
  compaction probe over ten discriminator shapes (65 and 5,000 nested objects,
  nested arrays, a 3 MB blob, a 1,000,000-character string, number/boolean/null,
  200 alternating levels) completed 10/10 with the segment excluded and manifest
  + digest + receipt + Parquet produced, and failed 7/10 against the candidate
  with the reviewer's own `NotPlainJson` `DEPTH` error. All 24 `details:` literals
  re-classified; the no-re-encode trace re-verified at `retention-proof.ts:86-87`
  and `:107`, `compactor.ts:610-611` and `validate.py:1503-1507`; the surrogate
  boundary probed at five cut points; the 256 cap confirmed against
  `wal-format.md` §5. M1 closed: each mutant killed by its pin file and by
  nothing else. Regression: 7,000 differential comparisons (vs base and vs a
  clean process) with zero byte differences; 42/42 six-context invariance with
  the injected hook never invoked.

## Residuals (owned)

1. **The `details.record` format change is real and disclosed.** A manifest that
   excludes a segment with a non-string unknown discriminator has different bytes
   and a different digest than base would have produced. Nothing pinned the old
   shape (verified: the Python fixture's `"excludedSegments": []`, the Python
   test helper's `"issues": []`, and no TypeScript test asserting any `details`).
   Issue MESSAGES derived from a caught parse failure are likewise capped at 256
   characters with the true length stated.
2. **`excludedSegments[].gatewayEpoch` remains unbounded** (`compactor.ts:318-322`,
   copied by `dataset-manifest.ts:377`): a 2 MB sidecar value produces a 2 MB
   manifest. Pre-existing at base, size amplification only, never a refusal —
   the encoder is byte-identical to base for such input. Owner: a later
   `storage-parquet` round; the remedy is to apply the same bounding helper.
3. **`parseDatasetManifest`'s cast** (`dataset-manifest.ts:444-457`,
   `return source as unknown as DatasetManifest`) is the one hole in the
   "compiler-checked at every producer" claim: `datasetManifestDigest(
   parseDatasetManifest(JSON.parse(bytes)))` type-checks and would refuse on an
   already-stored manifest carrying an unbounded `details`. No in-repo caller
   composes them. Owner: `packages/storage-parquet`.
4. **`packages/storage-wal` keeps `SegmentIssue.details` as `unknown`** and
   `segment-format.ts:382-384` still captures the raw discriminator. Safe today —
   a segment with fatal issues gets no manifest written (`writer.ts:1503-1516`,
   `recovery.ts:120-131`), verified independently — with a named trigger: **any
   consumer that routes `SegmentIssue.details` or `WalError.details` through
   `encodePlainJson` reopens the class.** Owner: whoever adds such a consumer.
5. **`describeDiscriminator`'s vocabulary is imitable by the text it describes**
   (`{"record":"an object"}` renders as `"an object"`). Diagnostic-only; no
   decision reads it, and `lineIndex`/`byteOffset` still point at the untouched
   line.
6. `encodePlainJson`'s own residual carries over: a `Proxy` handed to it runs its
   traps. Both classifiers are now pinned against whatever such a trap throws.
7. `boundedDiagnosticMessage` reads `error.message` after an `instanceof Error`
   check — the prototype-chain read the classifier pins forbid elsewhere. The
   pre-existing base expression; only a `JSON.parse` `SyntaxError` or this
   module's own failure reaches it. Recorded so the inconsistency is on record.

## Gates at the merged tip `a500f8c`, and on `main` at `0d8b6a0`

`pnpm run test` 313 files / 7016 tests (base `a9dcb8a`: 306 / 6944; +7 files,
+72 tests); `typecheck`, `lint`, `check:deps` 34 packages / 75 edges (72 + 3
downward); `test:fault` 11 files / 89 tests; `storage-postgres test:integration`
14 files / 215 tests (Docker 29.1.2, a real database applied and rolled back);
`trader test:integration` 9 / 110; `research-worker test:integration` 4 / 27
(the Python validator's committed fixture untouched). Post-merge on `main`:
`pnpm install --frozen-lockfile --offline` materialized the three workspace
links, and every gate above was re-run green.

## Process deviation (disclosed)

The confirming review ran as a Claude `adversarial-reviewer` rather than Codex.
Codex refused the packet **four times across two models** (`gpt-6-astra` ×3,
`gpt-5.6-sol` ×1) with a false-positive content-filter error, each time after
80k–300k tokens of real work and with a zero-byte report. Neutral phrasing and
scoping every search to the round's own directories did not help. The reviewer
was independent of both implementing agents, which is what `AGENTS.md` requires;
the model diversity of previous rounds was not available. A filter-killed
reviewer also left a MUTATED TRACKED FILE in its worktree mid-mutant, so every
review worktree was restored and byte-verified before any replacement reviewer
read it.

## Follow-ups (owned)

- `SER-3` (in flight) is the last round of the sweep; residual 4's trigger is
  named for its reviewer.
- After `SER-3`: the docs round on `docs/contracts/schema-boundary.md` §5, which
  can cite `encodeJsonbText` as the `pg` text rule and record the three new
  downward `risk` edges.
- Residuals 2 and 3 are `packages/storage-parquet`'s to close.
- `TRDR-2` candidate (recorded in `SER-0-sweep.md`): `writePnlSnapshot` inserts
  camelCase keys into snake_case `accounting.pnl_snapshots` columns behind
  `.values(row as never)`.
