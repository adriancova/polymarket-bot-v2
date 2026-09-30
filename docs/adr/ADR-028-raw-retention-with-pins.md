# ADR-028: Raw WAL retention of 72 hours, with pinned windows

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A3).
  Ruling A3b was not taken.
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `STORAGE-1`. Not yet implemented.
- **Supersedes / Superseded by:** none. It **amends** handoff §2 ("Raw
  archive"), §8.4, §9.1, §12.4 and §12.5, ADR-004 §5, ADR-017 §4, and the
  `WP-130` acceptance. It must be **re-ruled** before Phase 4 and before any
  ADR-012 calibration dataset is built (Decision 8).
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

1. Its last frame's `receivedAt` is at least 72 hours old.
2. The research tier covering the segment's time span is written and
   verified. Verified means read back from the store and checked against its
   manifest digest.
3. Every market window that overlaps the segment is **classified**. A window
   is classified when it has closed, and the trader's decision, order, fill
   and halt rows for it are durable. If the trader has not processed the
   segment yet, its windows are not classified.
4. Every pin whose range overlaps the segment is extracted and verified, in
   the ADR-017 §4 way: re-fetched and re-verified against its persisted
   manifest.
5. No operator pin covers the segment.

If any condition fails, the segment is kept. **Never expire what is not
extracted, or what is pinned.** A stuck expiry is a page (`LEAN-1` §8).

### 3. Pins

1. **Which windows are pinned.** A market window is pinned if it had an
   intent, a fill, a risk refusal or a halt. An operator can also pin any
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
   - its file digest, computed at deletion time;
   - the verified research-tier object it relied on;
   - every verified pin dataset that overlaps it, or none.
3. The receipt format gets a new version (`RETENTION_RECEIPT_VERSION` 1 → 2).
   A reader must still accept version 1.
4. The receipt stays reporting, not proof. The proof of a deletion is the
   verified research-tier manifest and the verified pin manifests.
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
| ADR-017 §4 | "The *proof* a deletion relies on is the persisted dataset manifest itself …"; "every deleted record is in a verified object it pins." | For the expired-after-extract basis, the proof is the verified research-tier and pin manifests. Not every deleted record is kept. The receipt is still reporting, not proof, and manifests stay immutable (Decision 4) |
| Handoff §8.4 | "Dataset manifests include all segment checksums, gateway epochs, event ranges, and excluded data-quality windows." | Unchanged for exact datasets, which now exist only for pins and for raw data under 72 h old (Decision 7) |
| Handoff §12.5 | "Every replay run pins: raw segment IDs and checksums …" | Unchanged for exact replays. An approximate replay pins research-tier objects instead (ADR-029) |
| Handoff §12.4 | "A fixed dataset … must produce byte-identical …" | Unchanged for every dataset that exists. Exact datasets older than 72 h exist only as pins (Decision 7) |
| `WP-130` acceptance | "WAL is not deleted before verified upload." | WAL is not deleted before verified upload, or, under ADR-028, before the research tier and every covering pin are verified |

Not amended: §6 invariant 4 (Decision 6), §4.2's hard capacity threshold, and
ADR-017 §1-§3.

## Consequences

- **Disk stays bounded for about $0.** At 1-2 markets about 55-100 GB of raw WAL
  is on disk at any time (`LEAN-1` §4).
- **Exact replay of a quiet stretch older than 72 hours is gone for good.**
- **A retention bug could delete evidence, or stall and fill the disk.** The
  guards are verify-before-delete, pins that expiry cannot touch, receipts, and
  a hard stop that halts recording rather than loses data.
- **Expiry depends on the trader.** A segment cannot expire until its windows
  are classified, so a stopped trader stops expiry. The disk alarms cover it.
- **Intent and refusal evidence ages out.** After 30 days, those windows have
  only their decision rows and the research tier.

## Evidence

- `docs/handoffs/LEAN-1.md` §2, §4, §5.3, §6 rows A3 and A3b, §8, §11 risk 5,
  and "The user's rulings (2026-09-30)".
- `docs/spec/polymarket-bot-orchestrator-handoff.md` §2, §4.2, §6 invariant 4,
  §8.4, §9.1, §12.4, §12.5.
- ADR-004 §5 and Consequences; ADR-017 §1 and §4.
- `packages/storage-parquet/src/retention-receipt.ts`,
  `retention-proof.ts` and `constants.ts` (`RETENTION_RECEIPT_VERSION = 1`).
- `packages/storage-wal/src/writer.ts` (`maxTotalBytes`);
  `docs/contracts/wal-format.md` (the hard capacity threshold).
- No venue fact is used.
