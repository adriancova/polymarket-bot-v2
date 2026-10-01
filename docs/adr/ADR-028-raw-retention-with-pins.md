# ADR-028: Raw WAL retention of 72 hours, with pinned windows

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A3).
  Ruling A3b was not taken.
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `STORAGE-1`, merged `a22502b`.
  [Amendment 1](#amendment-1-2026-10-01-storage-1) (2026-10-01) records its
  retention-safety rules and where it stops short of this ADR.
- **Supersedes / Superseded by:** none. It **amends** handoff §2 ("Raw
  archive"), §8.4, §9.1, §12.4 and §12.5, ADR-004 §5, ADR-017 §4 and one
  clause of ADR-017 §1, and the `WP-130` acceptance. It must be
  **re-ruled** before Phase 4 and before any ADR-012 calibration dataset is
  built (Decision 8).
- **Handoff sections:** §2, §4.2, §6 (invariants 4 and 15), §8.4, §9.1,
  §12.4, §12.5, §17. **ADRs:** ADR-004, ADR-012, ADR-017, ADR-025, ADR-029.

## Context

1. The handoff keeps every raw frame. §2: "| Raw archive | Append-only local
   WAL, compacted into checksummed Parquet in object storage |". §9.1:
   "Compaction never deletes a WAL segment until Parquet upload and checksum
   verification succeed."
2. One BTC 15-minute market records about 12-14 GB a day, plus about 6 GB a day
   per reference asset (`LEAN-1` §4). Eight markets would record up to
   119-135 GB a day.
3. A lossless 90-day archive would cost $7-56 a month at eight markets and
   11-45 GB a day of home upload (`LEAN-1` §2, ruling A3b). The user did not
   take it.
4. The laptop host has about 600 GB for the deployment (ADR-025).
5. `WP-130` shipped deletion only after verified compaction. The dataset
   manifest is the proof; the retention receipt is the report (ADR-017 §4).
6. The WAL writer has a hard capacity threshold, `maxTotalBytes`. "Reaching it
   refuses new frames — it never overwrites or deletes"
   (`packages/storage-wal/src/writer.ts`; `docs/contracts/wal-format.md`).

## The ruling

The user's rulings (`docs/handoffs/LEAN-1.md`, "The user's rulings
(2026-09-30)"):

> **A2 + A3: yes to both.** … Raw WAL deleted after 72 h, once the research
> tier and the pins are verified. Fill windows are pinned forever; intent,
> refusal and halt windows for 30 days.

> **A3b:** not taken (no 90-day raw archive for now).

The proposal the user accepted (`LEAN-1` §6, row A3):

> Delete raw WAL after 72 h, once the research tier and every pin covering it
> are verified. Keep fill windows forever and intent, refusal and halt windows
> for 30 days. Never evict a fill pin to meet a cap.

## Decision

### 1. Three kinds of kept data

1. **Raw WAL:** every frame, exactly as today, on local disk. Kept at least
   72 hours.
2. **Pinned windows:** exact copies of chosen market windows (Decision 3).
3. **Research tier:** a downsampled, approximate record, kept forever
   (`LEAN-1` §4). Its dataset class is ADR-029.

### 2. When a raw WAL segment may be deleted

A segment is deleted only when **all** of these hold:

1. The newest `receivedAt` over all of the segment's verified frames is at
   least 72 hours old. This is the maximum, not the last frame's stamp.
   Stamps may repeat or step backwards (ADR-026 Context 5), so the last
   frame in dispatch order is not always the newest. Example: frames
   dispatched with ages 71 h, then 73 h. The last is 73 h old, but the
   segment still holds a 71 h frame, so it is kept.
2. The research tier covering the segment's time span is written and
   verified. Verified means read back from the store and checked against its
   manifest digest.
3. Every market window that overlaps the segment is **classified**. Which
   rule applies depends on whether a trader is responsible for the window. A
   trader is responsible when the host configuration names the market for a
   trader, or a trader run admitted the window (ADR-030). Whether the trader
   process is running does not matter.
   - A window a trader is responsible for is classified when it has closed,
     and the trader's decision, order, fill and halt rows for it are durable.
     If the trader has not processed the segment yet, because it lags or is
     stopped, the window is not classified.
   - A window no trader is responsible for is one the gateway records only
     (for example a `HOST-BENCH` or `SCALE-8` recording). It is classified
     when it has closed. It has no intent, fill, refusal or halt, so only an
     operator pin can keep it.
4. Every pin whose range overlaps the segment is extracted and verified, in
   the ADR-017 §4 way: re-fetched and re-verified against its persisted
   manifest.
5. No operator pin covers the segment.
6. **The bytes are the ones that were extracted.** Before it reads a sealed
   segment, the extractor runs `validateSegment` on it
   (`packages/storage-wal/src/reader.ts`). That re-verifies the WAL-chain
   identity (`segmentSha256`) against the segment's footer and sidecar
   manifest. A segment that fails is not extracted, so it never expires. The
   extractor then computes `segmentFileSha256` over the same verified bytes.
   The verified research-tier manifest lists the segment as a source, with
   both digests (ADR-017 §1). Every overlapping pin manifest lists the same
   two digests for the segment.
7. **The file is checked at deletion time.** Just before deletion, the file
   must hash to that `segmentSha256` over its checksummed span, and to that
   `segmentFileSha256` over its full length. This is ADR-017 §1's
   deletion-time identity check, as `retention-proof.ts` runs it today. A
   truncated, changed or replaced file fails it and is kept.

If any condition fails, the segment is kept. **Never expire what is not
extracted, or what is pinned.** A stuck expiry is a page (`LEAN-1` §8).

### 3. Pins

1. **Which windows are pinned.** A market window is pinned if it had an
   intent, a fill, a refusal or a halt. An operator can also pin any
   window.
2. **What a pin holds.** The whole market window, exact, plus the reference
   feeds over the window and a lead-in before it. The lead-in is at least the
   longest feature lookback; the plan's value is about 15 minutes.
3. **How it is stored.** As lossless Parquet from the existing compactor, with
   its own immutable dataset manifest (ADR-017). It is written to the local
   store and copied to B2 (ADR-025).
4. **The trace must be inside the pin.** For every decision in a fill's
   chain, the decision's source event must lie inside the pinned range. If
   one does not, the pin is widened to include it.
5. **How long a pin lasts:**
   - a window with a fill: **forever**;
   - a window with an intent, a refusal or a halt, and no fill: **30 days**.
     After that, its decision rows, feature snapshots, source event ids and
     the research tier remain;
   - an operator pin: until the operator removes it.
6. **Budget.** A daily pin-budget alarm fires above 3 GB a day at 1-2 markets,
   and above 6 GB a day at 8 (`LEAN-1` §4). The alarm notifies; it deletes
   nothing.
7. **A fill pin is never evicted or reduced to meet a cap or a budget.**
   Evidence is never deleted to meet a budget (`LEAN-1` §5.3). Cutting any
   window down to slices needs a new ruling.

### 4. A new retention-receipt basis

1. Today every deletion names "the verified object that permitted it"
   (`RetentionReceiptDeletion.verifiedObjectKey`). The deleted records are all
   inside that object.
2. A deletion under Decision 2 has a new basis, **expired after extract**. Its
   records are not all kept anywhere. Its receipt entry names:
   - the segment's id and its WAL-chain digest (`segmentSha256`);
   - its whole-file digest (`segmentFileSha256`), checked at deletion time
     against the value pinned in the research-tier manifest (Decision 2.7);
   - the verified research-tier object it relied on;
   - every verified pin dataset that overlaps it, or none.
3. The receipt format gets a new version (`RETENTION_RECEIPT_VERSION` 1 → 2).
   A reader must still accept version 1.
4. The receipt stays reporting, not proof. The proof of a deletion is the
   verified research-tier manifest and the verified pin manifests, with the
   source-segment digests they pin (Decision 2.6).
5. A crash between a deletion and its receipt must not lose the fact of the
   deletion. `STORAGE-1` persists the expiry plan before it deletes anything.
6. Manifests stay immutable. No deletion state is written into a manifest.

### 5. `maxTotalBytes` is a hard stop

1. On this profile `maxTotalBytes` must be set. `null` is refused.
2. It is set below the free disk, with room for pins, the research tier,
   PostgreSQL and backups.
3. Reaching it refuses new frames, as today. It never deletes or overwrites.
   Recording stops and a page fires (§4.2, §8.3).
4. Expiry never runs early to make room. The only path to deletion is
   Decision 2.

### 6. §6 invariant 4 is kept

"Every fill is traceable: `fill → order → submission attempt → execution plan
→ intent → decision → feature snapshot → source event`."

1. Every fill's window is pinned forever, with exact raw frames (Decision 3).
2. So every fill keeps an exact replay and a byte-exact trace to its source
   frame, forever.

### 7. What exact replay covers from now on

1. Exact data exists for the last 72 hours of raw WAL, and for pinned windows.
2. Everything else has only the research tier, which is approximate (ADR-029).
   It cannot show queue position or moves inside one second.
3. A run manifest that pins an expired segment stays a valid record. Its
   replay can no longer be reproduced. Tooling must say so, not fail silently.

### 8. Re-ruled before Phase 4 and before calibration

1. Before Phase 4 (execution probes) starts, the user re-rules raw retention.
2. Before any ADR-012 execution-calibration dataset is built (`WP-360`), the
   user re-rules raw retention.
3. Calibration needs exact data around real orders. This ADR was not written
   for that.

### 9. Ruling A3b is not taken

1. There is no 90-day lossless raw archive.
2. Taking it later is a new ruling. It would use the existing Parquet format.

## What it amends

| Text | As written | How it now reads |
| --- | --- | --- |
| Handoff §2, "Raw archive" | "Append-only local WAL, compacted into checksummed Parquet in object storage" | Append-only local WAL, kept at least 72 h. Pinned windows are compacted into checksummed Parquet in object storage. The rest is kept as the research tier (Decisions 1-3) |
| Handoff §9.1, WAL requirements | "Compaction never deletes a WAL segment until Parquet upload and checksum verification succeed." | A WAL segment is deleted only after verified upload of the Parquet that holds it, or, under this ADR, after 72 h once the research tier and every covering pin are verified (Decision 2) |
| ADR-004 §5 | "Compaction never deletes a WAL segment until Parquet upload and checksum verification both succeed" | The same, plus the second path of Decision 2 |
| ADR-004, Consequences | "The delete-after-verify rule means a broken upload path fills the disk instead of losing data." | Still true. A broken extract or pin path stops expiry, and the disk fills to `maxTotalBytes` (Decision 5) |
| ADR-017 §1, the `segmentFileSha256` row | "computed at compaction time from bytes that were verified and archived" | Computed at compaction time from bytes that were verified and archived, or, for a segment that expires under Decision 2, at extraction time from bytes that `validateSegment` verified and that the research tier was built from (Decision 2.6). Its role, deletion-time identity, is unchanged |
| ADR-017 §4 | "The *proof* a deletion relies on is the persisted dataset manifest itself …"; "every deleted record is in a verified object it pins." | For the expired-after-extract basis, the proof is the verified research-tier and pin manifests. Not every deleted record is kept. The receipt is still reporting, not proof, and manifests stay immutable (Decision 4) |
| Handoff §8.4 | "Dataset manifests include all segment checksums, gateway epochs, event ranges, and excluded data-quality windows." | Unchanged for exact datasets, which now exist only for pins and for raw data under 72 h old (Decision 7). A research-tier manifest also lists the checksums of every source segment (Decision 2.6) |
| Handoff §12.5 | "Every replay run pins: raw segment IDs and checksums …" | Unchanged for exact replays. An approximate replay pins research-tier objects instead (ADR-029) |
| Handoff §12.4 | "A fixed dataset … must produce byte-identical …" | Unchanged for every dataset that exists. Exact datasets older than 72 h exist only as pins (Decision 7) |
| `WP-130` acceptance | "WAL is not deleted before verified upload." | WAL is not deleted before verified upload, or, under ADR-028, before the research tier and every covering pin are verified |

Not amended: §6 invariant 4 (Decision 6), §4.2's hard capacity threshold,
ADR-017 §2-§3, and the rest of ADR-017 §1. Only the provenance clause of §1's
`segmentFileSha256` row is amended (the row above). §1's roles and its three
bindings still hold, and §1 still binds every deletion: the file must match
its pinned `segmentFileSha256` over its full length (Decisions 2.6 and 2.7).
Under this ADR the pinning manifest may be the research-tier manifest.

## Consequences

- **Disk stays bounded for about $0.** At 1-2 markets about 55-100 GB of raw WAL
  is on disk at any time (`LEAN-1` §4).
- **Exact replay of a quiet stretch older than 72 hours is gone for good.**
- **A retention bug could delete evidence, or stall and fill the disk.** The
  guards are verify-before-delete, a deletion-time file check against pinned
  digests, pins that expiry cannot touch, receipts, and a hard stop that
  halts recording rather than loses data.
- **Expiry depends on the trader.** A segment cannot expire until its windows
  are classified, so a stopped trader stops expiry for its markets. The disk
  alarms cover it. Markets that only the gateway records do not wait for a
  trader (Decision 2.3).
- **Intent and refusal evidence ages out.** After 30 days, those windows have
  only their decision rows and the research tier.

## Evidence

- `docs/handoffs/LEAN-1.md` §2, §4, §5.3, §6 rows A3 and A3b, §8, §11 risk 5,
  and "The user's rulings (2026-09-30)".
- `docs/spec/polymarket-bot-orchestrator-handoff.md` §2, §4.2, §6 invariant 4,
  §8.4, §9.1, §12.4, §12.5.
- ADR-004 §5 and Consequences; ADR-017 §1 (the two digests) and §4.
- `packages/storage-wal/src/reader.ts` (`validateSegment`).
- `packages/storage-parquet/src/retention-receipt.ts`,
  `retention-proof.ts` and `constants.ts` (`RETENTION_RECEIPT_VERSION = 1`).
- `packages/storage-wal/src/writer.ts` (`maxTotalBytes`);
  `docs/contracts/wal-format.md` (the hard capacity threshold).
- No venue fact is used.

## Amendment 1 (2026-10-01, STORAGE-1)

- **Recorded by:** `STORAGE-GOV`, from `STORAGE-1`'s follow_up 1.
- **Source:** `STORAGE-1`, merged `a22502b` after a joint ACCEPT at
  `162fcfe`. Its record is `docs/handoffs/STORAGE-1.md`.
- **Scope:** five retention-safety rules that `STORAGE-1` implemented and its
  reviewers accepted (rules 1-5), and where `STORAGE-1` stops short of this
  ADR (rule 6). It decides nothing new.

Each rule names the decision it refines and why it fails closed. Code is
cited by symbol. A path without a package is under
`apps/research-worker/src/`. The rules are numbered within this amendment.
From outside it, cite one as "ADR-028 Amendment 1, rule 3".

### Rule 1. Unreadable trader evidence is never an empty read

**Refines:** Decision 2.3, and Decision 3.1 (which windows are pinned).

1. To classify a trader-responsible window, the worker reads the trader's
   rows through `TraderEvidenceSource`: each instance's dispatch frontier,
   and the market's evidence.
2. If a read fails, the window is unclassified with `evidenceUnreadable` set
   (`classifyWindow`). Any other error while classifying a window does the
   same (`classifyAll` in `retention/cycle.ts`).
3. With no trader database configured, the command reads through
   `unavailableEvidenceSource` (`storageMain`). Every read through it fails.
4. So a trader database that is missing, not configured or unreadable gives
   a failed read, never an empty one.
5. While such a window is not settled (rule 2), every sealed segment is
   kept, not only those the window overlaps. The planner's reason is
   `evidence-unreadable` (`planExpiry`).
6. The failed read is marked in the holds file (rule 2). Only an execute
   cycle clears the mark, including the recheck before each deletion
   (`rememberEvidence`). A dry run never clears it (rule 2, item 4).
   - An execute cycle clears the mark when the window's classification, in
     that cycle or recheck, does not have `evidenceUnreadable` set.
   - It also drops the entry of a window that is settled, holds nothing and
     is no longer registered. The mark goes with it, without a read. A
     settled window's mark does not keep every segment (item 8).
   - Corrected 2026-10-01 (STORAGE-GOV2, `S-GOV-R3-01`): was 'Only a later
     read that succeeds, in an execute cycle, clears the mark'.
7. A window that leaves the registry while marked and not settled still
   keeps every segment.
8. A settled window's failed read does not keep every segment. The code
   treats its evidence as final: its rows were durable when it classified,
   and its pin, if it needed one, holds them. Like any unclassified window,
   it still keeps the segments its potential range overlaps.
9. A gateway-only window never reads the trader's rows. A registry of
   gateway-only windows needs no trader database.

**Why it fails closed:** an empty read would look like a window with no
evidence. When the rows cannot be read, what the window holds is unknown. A
chain's source event can lie in any earlier segment (Decision 3.4), so every
segment is kept.

### Rule 2. Evidence holds are durable, and only an execute cycle releases them

**Refines:** Decisions 2.3, 2.4 and 3.4.

1. A hold protects a time range containing chain evidence found in a trader
   window's durable rows (`WindowEvidenceState` in
   `retention/evidence-holds.ts`).
   - While the window is unclassified and its rows show evidence, it holds
     the range its pin would hold now (`holdRanges`). That is the window,
     widened to every evidence instant and to the span of every located
     source event's segment, with the lead-in before it.
   - While it is classified with evidence and not settled, it holds its
     whole pin extent (`pinExtent`).
2. The holds live in one file in the state directory,
   `evidence-holds.json`. A hold is kept whatever the registry says.
3. Every cycle with a state directory makes what it read durable before it
   plans, in dry run as in execute mode (`runStorageCycle`). Each write goes
   to a temporary file, is synced, is renamed into place, and is read back
   (`persistEvidenceHolds`).
4. A dry run only adds (`accumulateEvidenceHolds`):
   - its holds are the union of the file's and what it read;
   - it never settles a window;
   - it never releases a hold or clears a failed read.
5. Only an execute cycle settles a window and releases its holds
   (`rememberEvidence`, `settledWindowIds`). A window is settled when it is
   classified and one of these is true:
   - Its pin was extracted in this cycle, or already was. Either way, its
     manifests were verified. The pin holds every source event of its chain
     (`sourceEventsInside`). Its range covers every held range and the
     window's pin extent.
   - It has no evidence and holds nothing.
6. The recheck before each deletion may add holds. It settles and releases
   nothing.
7. Only a missing file reads as "no holds". A file that does not read keeps
   every segment and is never overwritten. A cycle that cannot write the
   file durably also keeps every segment. The planner's reason is
   `evidence-holds-unknown`.
8. Removing the file, or an entry in it, can release holds without
   verifying anything. The code never removes the file, or an entry that
   still holds a range or an unsettled failed read (`rememberEvidence`).
   Doing so is an operator's deliberate act.
9. A dry run plans with the holds an execute cycle would write, so its
   report says what execute would do. If its own write failed, it reports
   every segment kept. It deletes nothing.

**Why it fails closed:** a later cycle may not read the rows, or may no
longer register the window. A hold built from one cycle's state alone would
then be lost, and an unlink could follow. `STORAGE-1` rounds 2-5 kept
finding that defect. Round 5 closed it: the holds became durable, and only
an execute cycle that settles a window releases them.

### Rule 3. One storage cycle at a time per state directory

**Refines:** Decision 2. The lock protects the durable state that Decision
2's conditions rely on: rule 2's holds, and the clock guard's state behind
Decision 2.1's age check.

1. A cycle with a state directory runs whole under that directory's cycle
   lock (`withStorageCycleLock`, called by `runStorageCycle`). It takes the
   lock before it reads the clock, and keeps it until the cycle ends.
2. The lock is a file created with `O_EXCL`, named
   `storage-cycle.<boot id>.lock`. The boot id comes from
   `/proc/sys/kernel/random/boot_id`. The file names the holder's pid and
   boot, and when it took the lock.
3. A cycle removes its lock when it ends, whether it succeeded or failed.
4. A cycle that finds the lock held retries for up to 5 minutes by default
   (`DEFAULT_STORAGE_CYCLE_LOCK_TIMEOUT_MS`).
   - If it takes the lock in that time, it runs.
   - If the lock is still held at the timeout, it throws
     `StorageCycleLockError`. That cycle never started: it read no trader
     rows, changed no holds and deleted nothing.
5. Any `open()` error other than EEXIST refuses at once. The cycle throws
   `StorageCycleLockError`, with that error as its `cause`. It runs nothing
   and removes nothing.
   - Tests inject nine errno values through
     `StorageCycleLockOptions.fileSystem`. A further test, skipped as root,
     uses a real EACCES (`retention/cycle-lock.test.ts`).
   - `STORAGE-1b` (merge `7b6499e`) closed `R6-LOCK-OPEN-ERROR-UNTESTED`.
   - Corrected 2026-10-01 (STORAGE-GOV2): was 'Any other error creating the
     lock file is thrown at once, and the cycle does not run. No test covers
     that path yet (`R6-LOCK-OPEN-ERROR-UNTESTED`)'.
6. A lock left by a process that a reboot ended has another boot's name. It
   holds nothing after the reboot.
7. A lock left in the same boot, by a killed process, is never broken
   automatically. Every later cycle waits, refuses and deletes nothing. The
   operator removes the lock after checking that no cycle runs.
8. A cycle that cannot read the kernel boot id, or reads one that is not a
   lowercase UUID, refuses (`thisBoot`, called first by
   `withStorageCycleLock`).
   - It throws `StorageCycleLockError` before it creates the state
     directory or the lock. The cycle never starts, as in item 4.
   - The `storage` command then prints `storage-cycle-fatal` and exits 1.
   - There is no fallback name. No cycle takes `storage-cycle.lock` any
     more.
   - A leftover `storage-cycle.lock` in the state directory, from an
     earlier version, counts as held. A cycle waits up to the timeout
     (item 4), then refuses and names it.
   - No cycle removes that file. The operator removes it by hand, after
     checking that no storage cycle of an earlier version runs.
   - If the check for that file fails with any error but ENOENT, the cycle
     refuses at once and removes nothing.
   - systemd's `ProcSubset=pid` is unsupported. It hides `/proc/sys`, so
     every cycle under it refuses.
   - `STORAGE-1b` (merge `7b6499e`) closed `R6-LOCK-NAME-FALLBACK`. With
     item 5, both lock residuals are closed (`STORAGE1-LOCK-LOWS`).
   - Both were closed under route (a): a cycle refuses, and never removes a
     lock it does not hold.
   - Corrected 2026-10-01 (STORAGE-GOV2): was 'If the boot id cannot be
     read, the lock is named `storage-cycle.lock`. That name is not scoped
     to a boot, so a lock left under it survives a reboot. It still blocks
     every cycle that uses that name, and nothing breaks it automatically. A
     process that cannot read the boot id and one that can use different
     names, so neither excludes the other (`R6-LOCK-NAME-FALLBACK`). Owner
     of both lock residuals (items 5 and 8): a research-worker round, before
     `HOST-1` (`STORAGE1-LOCK-LOWS`)'.
9. The lock serializes cycles on one host. A state directory shared between
   hosts is not supported.

**Why it fails closed:** each cycle rewrites the whole holds file from what
it read. Two cycles at once could lose one's new hold to the other's write.
A cycle that cannot take the lock does nothing. A stale lock stalls expiry,
but it never causes a deletion.

### Rule 4. The storage command needs a state directory in every mode

**Refines:** Decision 4.5, which keeps the expiry plan in durable state,
and, through rule 2, Decisions 2.3 and 3.4.

1. The command refuses to start without `RESEARCH_WORKER_STATE_DIR`, in dry
   run as in execute mode (`loadStorageConfig`).
2. In execute mode, the expiry plan is made durable there before any
   deletion (`persistExpiryPlan`), as Decision 4.5 requires.
3. In both modes, rule 2's holds and rule 3's lock live there.
4. The library function `runStorageCycle` refuses execute mode without a
   state directory. It still accepts a dry run without one. That run makes
   no hold durable and takes no lock. The command never runs one.
5. `STORAGE-1` assumes one state directory for each WAL root. A dry run
   given another directory protects nothing for the scheduled execute
   cycles.

**Why it fails closed:** a dry run reads the trader's rows like any cycle.
Without a state directory, what it read would be lost when it exits. The
window could then leave the registry before an execute cycle reads it again.

### Rule 5. A window leaves the registry only after an execute cycle settles it

**Refines:** Decision 2.3, which keeps a segment until every window that
overlaps it is classified.

1. The windows come from an operator-supplied registry file
   (`loadWindowRegistry`). The host configuration and the window admission
   that Decision 2.3 names do not exist yet (`retention/windows.ts`).
2. The planner sees only registered windows. A window may leave the
   registry only after an execute cycle has settled it (rule 2).
3. This is an operator rule. The code cannot enforce it, because it never
   sees a window that is not registered.
4. If a window leaves earlier, its recorded holds and any unsettled
   failed-read mark stay durable (rules 1 and 2). Re-registering it lets an
   execute cycle read its evidence again. Holds remain until an execute
   cycle settles the window. A successful execute-mode read clears the
   failed-read mark even if the window remains unclassified.
5. What no cycle has read is not held:
   - rows the trader writes after the last read;
   - the potential range of a window that was unclassified with no evidence
     yet (`potentialRange`).
6. The worker's README adds a second condition: the window's segments have
   all expired. If the window leaves sooner, a segment that names its market
   is kept as `unknown-market`, unless a registered window names that
   market.

**Why it fails closed:** once a window is settled, its evidence is final and
any pin it needs is in the store. The planner checks every stored pin,
whatever the registry says (`readExtractedPins`). Before that, only a
registered window has its rows read again and its potential range held. So
pruning waits for settlement.

### Rule 6. Where `STORAGE-1` stops short of this ADR

1. **Decision 5.1 is not enforced.** It requires `maxTotalBytes` on this
   profile and refuses `null`.
   - The gateway's `WalConfigSchema` still accepts `null` or no value.
     `apps/data-gateway` was outside `STORAGE-1`'s grant.
   - The worker only reports headroom against the value, with a 90% alarm.
     It does so only when `RESEARCH_WORKER_WAL_MAX_TOTAL_BYTES` is set
     (`storageMetrics`).
   - Owner: a data-gateway round, after `THROUGHPUT-1c`
     (`STORAGE1-MAXBYTES`). `STORAGE-1`'s follow_up 4 also asks `HOST-1` to
     require the value.
2. **Expiry does not relieve the WAL writer's capacity count (`J10`).**
   - A running `WalWriter` adds every byte it writes to
     `#totalSegmentBytes` (`packages/storage-wal`). It never subtracts a
     deleted segment.
   - So segments expired while it runs still count against
     `maxTotalBytes`. At the limit the writer refuses new frames and deletes
     nothing (Decision 5.3).
   - Owner: the same data-gateway round (`STORAGE1-MAXBYTES`).
3. **Pins and the research tier are written with SNAPPY, not ZSTD.**
   - `DatasetCodec` offers only `UNCOMPRESSED` and `SNAPPY`
     (`packages/storage-parquet`). The pinned `hyparquet-writer` 0.16.6 has
     no built-in ZSTD codec.
   - Decision 3.3 names no codec. The gap is against Decision 3.6's sizing
     basis: its budget comes from `LEAN-1` §4, which assumed 3× compression.
   - `STORAGE-1` projects pins at about 3.4 GB a day at H1's intent rate.
     That is above the 3 GB alarm, which only notifies (Decision 3.6).
   - `STORAGE-1`'s record names two causes of that volume:
     - SNAPPY output is about 3× larger than ZSTD's;
     - overlapping pins each store the segments they share, since
       `extractPin` writes every pin's segments under its own prefix.
   - Owner: a pin-storage ruling or round (`STORAGE1-PIN-VOLUME`).
     `STORAGE-1`'s follow_up 5 asks it to share segments between
     overlapping pins, add a ZSTD codec, or both.
4. **A lapsed non-fill pin is never deleted.**
   - Decision 3.5 lets an intent, refusal or halt pin lapse after 30 days.
   - The pin record carries that instant as `keepUntil`: the window's end
     plus `NON_FILL_PIN_RETENTION_MS`. Nothing acts on it, so more is kept,
     never less.
   - Owner: its own dual-verified round, because deleting a pin deletes
     evidence (`STORAGE-1` follow_up 6). No round is named yet.

Two limits come from the trader, not from this worker.

- **No decision carries its dispatch position yet (`H1R1-PROVENANCE`).**
  - `CoreLoop` (`packages/trading-core`) gives a decision's `sourceEvent`
    only its `eventId`. So `decisionRow` (`apps/trader`) writes every
    decision's `gateway_epoch` and `ingest_seq` as NULL.
  - `dispatchFrontiers` (`retention/evidence-postgres.ts`) skips those
    rows, so no instance has a dispatch frontier.
  - `classificationBlocker` (`retention/classify.ts`) refuses a window with
    no frontier. So no trader-responsible window classifies today, and no
    segment it could overlap expires. This keeps more, never less.
- **Nothing writes refusal or halt rows yet (`OUT1-R1-HALT-NOT-DURABLE`).**
  - `postgresTraderEvidence` reads both tables, but they are empty.
  - Today every trader-responsible window stays unclassified anyway (the
    item above), so every segment it could overlap is kept.
  - Once those windows can classify, the missing rows can leave an
    otherwise evidence-free window unpinned. Decision 3.1 would pin a
    window with a refusal or a halt for 30 days.
- Owner of both: a trader/storage round that persists decision provenance,
  halts and refusals (`STORAGE-1` follow_up 3).
