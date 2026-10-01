# STORAGE-1: research tier, pinned windows, verified raw expiry, disk metrics (ADR-028, ADR-029)

**Status:** Complete (2026-10-01). Joint ACCEPT at round 6 on `162fcfe`, from Claude Opus and Codex gpt-6-astra after reconciliation. Merged `a22502b` (PR #36; CI run `36868340106` green), after a merge of `main` at `6ca8262`.
**Base:** `64bbd92`. **Branch:** `storage-1`. **Paths:** `apps/research-worker/**`, `packages/storage-parquet/**`, `packages/simulation/src/**`, `test/unit/simulation/**`, `python/research/**`, `test/integration/parquet/**`, and `pnpm-lock.yaml` (only the research-worker importer changed).
**Posture:** PAPER only. **Deletion is opt-in:** dry run is the default, and the command needs `execute` mode, a state directory, and an opt-in marker file in the WAL root.

The implementer handoffs for every round (`handoff-r0.md` … `handoff-r5.md`) and the joint reports are kept outside the repository, in `~/pmb-rounds/storage-1/`. This record summarises them.

## summary

**Manifest v2 (ADR-029):**
- The dataset manifest gains a required `fidelity` field. The format id stays `polymarket-bot/dataset-manifest/v1`.
- Every reader accepts v1 and v2: `packages/storage-parquet`, `python/research` and the `packages/simulation` exact replay door.
- The replay door refuses an approximate manifest with `REPLAY_MANIFEST_APPROXIMATE`.

**Retention receipt v2 (ADR-028 D4):** every deletion names its basis, `verified-upload` or `expired-after-extract`.

**Research tier (ADR-029 D5):**
- Each sealed segment is read once.
- A downsampled, provenance-carrying dataset is written from it, and a verifier checks that dataset. Every sample carries its release frame's `gatewayEpoch`, `ingestSeq` and receipt instant.
- A segment that fails validation is never extracted, so it never expires.

**Classification and pins (ADR-028 D2.3, D3):**
- Windows come from an operator registry file. Trader evidence is read through a read-only PostgreSQL adapter.
- A trader-responsible window is classified once every responsible instance's durable frontier has passed its end plus a grace margin.
- A pin is an exact whole-segment dataset. It covers the window and its lead-in, widened to every fill-chain source event.
- Fill pins are permanent.

**Expiry:** a segment may expire only when all of these hold:
- its newest receivedAt is at least 72 h old;
- its research tier verifies;
- every window that could overlap it is classified;
- every overlapping pin is extracted, verified and holds it;
- no operator pin covers it.

Before any deletion:
- the plan is written durably first;
- each segment is re-checked against fresh pins, holds and windows;
- the file must hash to both pinned digests at deletion time.

**Fail-closed evidence holds (rounds 2–5):**
- Evidence holds are durable. They only grow until an execute cycle settles a window.
- An unreadable or unconfigured trader database counts as unreadable evidence. It never counts as an empty read.
- A dry run makes what it reads durable but releases nothing.
- One storage cycle at a time runs per state directory, under a boot-scoped `O_EXCL` lock.

**Disk metrics:**
- disk use and `maxTotalBytes` headroom;
- the pin budget;
- expiry lag and a stuck alarm;
- segments kept, by reason;
- plans without a receipt.

**Measured on H1 runs 3–8 (read-only; checksums prove nothing changed):**
- The research tier takes 22.4 MB/day of tables, or 24.9 MB/day with all files. LEAN-1 projected 7–30 MB/day.
- One pin of run 6's range is about 105 MB. At H1's intent rate, pins project to about 3.4 GB/day, above the 3 GB/day alarm. See known_risks.

## Rounds

All rounds used dual verification (Opus and astra, reconciled).

| Round | Candidate | Verdict | Agreed blocking findings |
|---|---|---|---|
| 1 | `db1499a` | CHANGES REQUIRED | 10 (4 HIGH: unknown-market fail-open, frontier, pin race, chain widening; 6 MEDIUM) and 6 LOW |
| 2 | `6078e0d` | CHANGES REQUIRED | K1 HIGH (a pending source drops located holds), K3 HIGH (ephemeral pin specs), K2 and K4 MEDIUM |
| 3 | `3d64e2e` | CHANGES REQUIRED | L1 HIGH (holds dropped on an evidence read failure), L2 and L3 MEDIUM |
| 4 | `a0ce5e6` | CHANGES REQUIRED | M1 HIGH (a classified, unsettled window's hold is lost), M2 MEDIUM (holds-file I/O untested) |
| 5 | `9fa2969` | CHANGES REQUIRED | N1 HIGH (a missing DB URL fails open), N2 HIGH (dry-run holds are not durable) |
| 6 | `162fcfe` | **ACCEPT** | none; R6-LOCK-OPEN-ERROR-UNTESTED and R6-LOCK-NAME-FALLBACK are LOW and open |

Rounds 2–5 kept finding one class of defect: a hold built from one cycle's transient state was lost when that state was unavailable, and an unlink followed. The state went missing through an outage, a missing configuration, a dry run, or registry pruning. Round 5 closed the class: holds became durable and grow-only, and an unknown input became unreadable evidence.

## files_changed

- **`apps/research-worker/**`:**
  - the `storage` command (`storage-main.ts`, `storage-config.ts`);
  - `research-tier/*` (interpret, sampler, segment-verify, identity, inventory, extract);
  - `retention/*` (windows, classify, evidence-postgres, evidence-holds, pins, plan, execute, cycle, cycle-lock, operator-pin-lock, metrics, wal-index);
  - their tests and the README.
- **`packages/storage-parquet/**`:**
  - manifest v2 and receipt v2;
  - research-tier layout, object, manifest and writer;
  - expiry proof;
  - the node file-system port.
- **`packages/simulation/src/**`:** the replay door accepts v1 and v2, and refuses approximate manifests.
- **`test/unit/simulation/**`, `test/integration/parquet/**`, `python/research/**`.**
- **`pnpm-lock.yaml`:** the research-worker importer.

Across rounds 0–5 it changed 87 paths, all within the allowed paths.

## tests_run

Both round-6 verifiers ran the gates on `162fcfe`, with identical counts:

| Gate | Result |
|---|---|
| `typecheck`, `lint` | exit 0 |
| `check:deps` | 35 packages, 96 edges |
| `test` | 399 files, 8604 tests |
| `test:e2e` | 9 files, 212 tests |
| `test:replay` | 3 files, 17 tests |
| research-worker `test:integration` | 6 files, 43 tests, including real PostgreSQL |
| `uv run --offline pytest -q` | 155 passed |

**Round 5's mutation sets (the full tables are in `~/pmb-rounds/storage-1/`):**

| Set | Killed | Survived | Moved |
|---|---|---|---|
| Round 5's own mutants | 31 of 31 | 0 | 0 |
| Rounds 1–4's mutants | 199 of 212 | 0 | 13 |
| Opus's round-5 set | 53 of 54 | 1 | 1 |

- **The orchestrator's checks after merging main:** after the merge of `main` at `6ca8262` into the branch, the orchestrator ran an offline frozen install, `typecheck` and `check:deps`, and all passed.
- **CI:** GitHub CI on the PR #36 merge ref was green before the merge: run `36868340106`.

## assumptions

- A missing trader database means "rows unknown", never "no rows".
- One host per state directory. A state directory shared between hosts is unsupported.
- One deployment runs a single state directory for each WAL root. A manual dry run given another directory protects nothing for the timer.
- Dispatch order defines span membership (ADR-029).
- Pin records are immutable and identity-checked.

## deviations

- The receipt builder stays source-compatible with an out-of-grant test. `basis` defaults to `verified-upload`, but the written document is always the full v2 shape.
- There is no separate `build:storage` script. The command ships in the existing bundle as `dist/main.mjs storage`.
- Pins and the research tier use **SNAPPY**, not ZSTD. The pinned `hyparquet-writer` 0.16.6 has no ZSTD codec.
- **`maxTotalBytes` is not enforced.** ADR-028 D5 requires it, but `apps/data-gateway` was outside this grant. The worker only reports headroom. The WAL writer's capacity counter only grows, so expiry never relieves it (finding J10; see follow_up).
- A lapsed non-fill pin is never deleted. The 30-day lapse is recorded as `keepUntil` only, which keeps more, not less.
- The command requires `RESEARCH_WORKER_STATE_DIR` in dry-run mode too.
- The cycle lock covers the whole cycle.

## known_risks

- **No trader-responsible window classifies until `H1R1-PROVENANCE`, so raw WAL that such a window could overlap never expires.**
  - `CoreLoop` gives a decision only its `eventId`, so the trader writes `gateway_epoch` and `ingest_seq` as NULL.
  - `dispatchFrontiers` skips those rows, and `classificationBlocker` refuses a window with no dispatch frontier.
  - This keeps more, never less. But wherever a trader runs, the 72 h expiry does not run, so `BURN-IN`'s criterion "Raw expiry, pins and backups ran and were verified" cannot be met until it is fixed (`PROVENANCE-1`).
  - Corrected 2026-10-01 (STORAGE-GOV review): was 'Classification and chain containment are supersets until `H1R1-PROVENANCE`… This keeps more raw data, never less.'
- **A stale cycle lock blocks expiry.** A cycle killed mid-run leaves its lock, and every later cycle refuses and deletes nothing until the operator removes it. A reboot clears it.
- **No trader database while an unsettled trader window is registered: nothing expires.**
- **A window settled only by dry runs, then pruned from the registry, keeps its holds.** They stay until it is re-registered and settled by `execute`.
- **Pin volume.** About 3.4 GB/day at H1's intent rate, above the 3 GB/day alarm. Segments shared between overlapping pins are stored twice, and SNAPPY is about 3× larger than ZSTD.
- **One unreadable pin record, or an unreadable `evidence-holds.json`, stalls every expiry.** It fails closed.
- **R6-LOCK-OPEN-ERROR-UNTESTED (LOW): closed by `STORAGE-1b` (`7b6499e`).** The refusal on an `open()` error other than EEXIST is correct but unpinned.
- **R6-LOCK-NAME-FALLBACK (LOW): closed by `STORAGE-1b` (`7b6499e`); an unreadable boot id now refuses, and `ProcSubset=pid` is unsupported.** If the boot id cannot be read, the lock name falls back to `storage-cycle.lock`. Two participants that derive different names do not exclude each other. One trigger: `/proc` mounted with `subset=pid`, as under systemd `ProcSubset=pid`.

## follow_up

1. **`STORAGE-GOV` (authorized 2026-10-01): an ADR-028 amendment (governance; `docs/adr` is protected) must record:**
   - a missing trader database is unreadable evidence;
   - a dry run makes what it reads durable and releases nothing;
   - one storage cycle at a time runs per state directory;
   - the command requires a state directory in every mode;
   - the registry may be pruned only after an execute cycle settles the window.
2. **A data-gateway round:**
   - enforce `maxTotalBytes`;
   - make the WAL writer's capacity counter account for expired segments (J10).
3. **`PROVENANCE-1` (`H1R1-PROVENANCE`, `OUT1-R1-HALT-NOT-DURABLE`):** persist decision provenance (`gateway_epoch`, `ingest_seq`, `feature_snapshot_id`), halts and refusals. Until then no trader-responsible window classifies, and raw WAL under it never expires. It blocks `BURN-IN`.
4. **`HOST-1`:**
   - run the storage timer in `execute` mode, with `RESEARCH_WORKER_STATE_DIR` set and the opt-in marker on the live WAL root only;
   - produce the window registry;
   - require `maxTotalBytes`;
   - add alerts for a non-zero storage exit, long-lived holds or unreadable marks, and clock skew;
   - back up `evidence-holds.json`;
   - export the storage metrics to Prometheus.
   - Leave `ProcSubset` unset: the cycle refuses under `ProcSubset=pid` (`STORAGE-1b`).
5. **A pin-storage ruling or round:** share segments between overlapping pins, and/or add a ZSTD codec.
6. **Deleting lapsed non-fill pins** deletes evidence, so it needs its own dual-verified round.
7. **`APPROX-REPLAY-1`** can now consume the research tier.
8. **Before `SCALE-8`:** add a durable classification cache, or prune the registry.
9. The two round-6 LOWs: closed by `STORAGE-1b` (`7b6499e`).

## commit_sha

`162fcfeb597a39c5f1eb6f0a41da6bb8d4c485ae`. The branch merged `main` (`ab675fa`) before PR #36, and was merged as `a22502b`.
