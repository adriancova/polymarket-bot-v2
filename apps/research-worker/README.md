# `@polymarket-bot/research-worker`

Two commands in one bundle (`dist/main.mjs`). Neither holds a credential, opens a venue
connection or places an order; neither reads or relaxes `MAX_RUN_MODE`,
`ALLOW_REAL_ORDERS` or the live-micro caps.

| Command | What it does | Deletes? |
| --- | --- | --- |
| `node dist/main.mjs` | `WP-130` compaction loop: verified WAL segments to exact Parquet datasets | Only with `RESEARCH_WORKER_RETENTION=delete-after-verified-upload` (default `retain`) |
| `node dist/main.mjs storage` | `STORAGE-1` storage cycle: research tier, window classification, pins, raw-WAL expiry plan, metrics (ADR-028, ADR-029) | Only in `execute` mode **and** with the opt-in marker in the WAL root (default `dry-run`) |
| `node dist/main.mjs storage pin <pinId> <from> <to> <reason>` | Publish one operator pin under the expiry's lock | Never |

Build and run with `pnpm --filter @polymarket-bot/research-worker start` (compaction) or
`pnpm --filter @polymarket-bot/research-worker start storage`.

## The storage cycle (`storage`)

One run does, in order:

0. **Clock.** The wall clock is compared with the time since boot (`/proc/uptime`) since
   the last cycle; an unexplained forward step is subtracted from "now", so a clock that
   jumps ahead cannot shorten the 72 hours (`metrics.clock`). Removing
   `<state dir>/clock-state.json` resets it; do that only after checking the host clock.
1. **Research tier.** Every sealed WAL segment with no research tier yet is verified
   (`validateSegment` and the compactor's reader, over one in-memory read) and downsampled
   into a version 2 `approximate` dataset under `research/<gatewayEpoch>/` in the object
   store. A segment that fails verification is never extracted, so it never expires. Each
   source segment's entry in the checksummed manifest also lists every Polymarket market its
   frames name, read from every frame whatever the sampler keeps (`marketIdentities`). A
   frame the inventory cannot read in full — one that does not parse strictly (a duplicate
   key, say), nests deeper than 16 levels, holds a non-name under an identity key, or is an
   RTDS envelope on a topic other than the Chainlink TWAP ones — counts as unidentified, and
   keeps its segment.
2. **Classification.** Every registered market window is classified: a trader-responsible
   window once the trader has durably processed, **in dispatch order**, every sealed frame
   that could be stamped inside the window (its decisions' `gateway_epoch` / `ingest_seq`,
   read **read-only** from PostgreSQL); a gateway-only window at its close. Receipt
   instants are not used for this: they can step backwards. **Until the trader persists
   its decisions' dispatch position (`H1R1-PROVENANCE`), no trader-responsible window
   classifies, so nothing it overlaps expires.** While a window is unclassified, whatever its
   durable rows already show is held as well: the range its pin would hold now, the whole
   segment of every source event already located included. Once it is classified with
   evidence, its whole pin range is held for as long as that pin is not extracted and
   verified with its whole chain inside: while the pin waits for the extraction batch or for
   the pin catalog to read, after a failed pin write, and when the re-decision just before a
   deletion is the first to see the evidence. Those holds are **durable**
   (`<state dir>/evidence-holds.json`, which is why the command requires a state directory
   in either mode), made so by every cycle, **a dry run included**: a dry run only ever adds
   to them — it never releases a hold, settles a window or clears a failed read; only an
   `execute` cycle does. A later cycle keeps them whether or not it can read the trader's
   rows, and whether or not the window is still registered, until an `execute` cycle finds
   the window classified and its pin — verified, with its whole chain inside — covering
   them. A window whose rows cannot be read (the database down, a timeout, or no database
   configured) and whose evidence is not yet settled that way keeps **every** segment: what
   it holds is unknown. A source event whose segment, or whole gateway epoch, has expired
   under the window's own pin is found through that pin's verified manifests.
3. **Pins.** A window with a fill (kept forever), an intent, a refusal or a halt (30 days),
   and every operator pin, is copied exactly — whole WAL segments, through the `WP-130`
   compactor — under `pins/<pinId>/`. A pin, once extracted, is a durable fact: a window
   whose existing pin already holds everything it requires stays bound to that pin, even
   after the segment holding its chain's source event has expired under it. No window pin
   is extracted in a cycle whose pin catalog does not read in full.
4. **Plan.** Every sealed segment is decided, with every reason it is kept. A segment may
   expire only when its newest frame is at least 72 h old, its research tier verifies,
   every market it names is registered and every frame could be identified, every window it
   could overlap is classified, every overlapping pin is extracted and verified, and no
   operator pin covers it. "Every overlapping pin" is every pin in the store, not only the
   ones this cycle derives: a window that is unclassified this cycle (the trader database
   unreachable, say), re-derived or re-registered still has its pin verified and named in
   the receipt. A pin record that does not read keeps every segment; so does a window pin
   record whose id no longer digests its own window, class, range and source events. A
   segment a pin record lists is verified against that pin whatever the record's range
   says, and kept when that range does not cover it. Holds that do not read, or cannot be
   written, keep every segment; the file is then never overwritten.
5. **Expiry**, only in `execute` mode: the plan is written durably to the state directory
   first (never replacing an existing plan), then, under the operator-pin lock, each segment
   is re-decided, its bytes proved against the research tier and the pins, the operator pins
   read once more, and only then unlinked; a version 2 retention receipt is written to
   `expiry/<planId>/retention-receipt.json`.
6. **Metrics**: disk use, WAL capacity as the gateway's writer counts it, pin budget (an
   alarm only; no pin is ever evicted or reduced), expiry lag (a segment the extract path
   cannot verify counts from its sidecar's `closedAt`), orphan sidecars, the clock guard,
   plans with no receipt, and plans that do not read.

A sidecar whose segment is gone (a deletion interrupted between its two unlinks) is
reported as `walOrphanSidecars` and never planned; it may be removed by hand.

It prints one JSON report and exits. Run it on a timer.

**One cycle at a time.** Every cycle holds the lock
`<state dir>/storage-cycle.<boot id>.lock` from its start to its end, in either mode, so an
operator's dry run and the timer's cycle never interleave their reads and writes of the
holds or the clock state. Two cycles exclude each other only when they read the same boot
id. The lock behaves as follows:

- **A held lock.** A cycle that finds the lock held waits up to 5 minutes, then exits
  non-zero having done nothing; the error names the holder.
- **A reboot.** A lock left by a process that a reboot ended carries the old boot's id and
  holds nothing after the reboot; it may be removed.
- **A killed process.** A lock left in the same boot by a killed process (`kill -9`, or a
  service stopped mid-cycle) is never broken automatically: every later cycle refuses,
  deleting nothing, until it is removed after checking that no storage cycle runs.
- **A lock that cannot be created.** If the lock cannot be created for any reason other than
  being held (permission denied, a read-only or full filesystem, too many open files), the
  cycle exits non-zero at once having done nothing. The error names the cause. It removes
  nothing, not even a file at the lock's path.
- **No boot id, no cycle (`STORAGE-1b`).** The boot id is read from
  `/proc/sys/kernel/random/boot_id`. A cycle that cannot read it, or reads anything but a
  lowercase UUID, exits non-zero having done nothing, not even creating the state directory.
  The error (`StorageCycleLockError`, printed as `storage-cycle-fatal`) names the cause.
  There is no fallback lock name: a cycle on another name would not exclude the others.
  - The command therefore runs only on Linux, where every process reads the kernel's boot
    id, containers included.
  - **systemd's `ProcSubset=pid` is not supported.** It mounts `/proc` with `subset=pid`,
    which hides `/proc/sys`, so a timer unit hardened that way refuses every cycle. Leave
    `ProcSubset` unset in the storage unit. `ProtectProc=` does not hide the boot id.
  - A sandbox that presents a boot id of its own, such as gVisor or a virtual machine,
    counts as another host. Do not share a state directory with one.
- **`<state dir>/storage-cycle.lock` must be removed by hand.** Versions before
  `STORAGE-1b` took this lock where they could not read the boot id. A cycle now treats
  that file as held: it waits, then refuses, naming it. Nothing removes it automatically.
  Remove it once no storage cycle of an earlier version runs.

The lock serializes cycles on one host; a state directory shared between hosts is not
supported.

`<state dir>/evidence-holds.json` is never edited by hand in normal operation. Removing it,
or a window's entry in it, releases those holds without verifying anything, so do that only
as a deliberate decision, after checking that every window it names is pinned or has no
evidence. A file that exists but cannot be read (any error but "no such file") keeps every
segment and is never overwritten.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESEARCH_WORKER_WAL_ROOT` | required | The gateway's WAL root (`<root>/<gatewayEpoch>/…`) |
| `RESEARCH_WORKER_OBJECT_STORE_ROOT` | required | The filesystem object store |
| `RESEARCH_WORKER_EXPIRY_MODE` | `dry-run` | `execute` deletes, subject to the marker |
| `RESEARCH_WORKER_STATE_DIR` | required | Where durable expiry plans, the clock guard's state, the evidence holds and the cycle lock live. Required in **either** mode: a dry run makes the evidence holds it learns durable there too (releasing none), so a window pruned from the registry before the first `execute` cycle loses nothing a dry run already read. Give every run against the same WAL root the same state directory: what a cycle reads is held only in its own |
| `RESEARCH_WORKER_WINDOW_REGISTRY` | none | The market windows (below). With none, every segment that names a Polymarket market is kept |
| `RESEARCH_WORKER_OPERATOR_PINS` | none | Operator pins (below) |
| `RESEARCH_WORKER_TRADER_DATABASE_URL` | none | The trader's PostgreSQL, read-only. With none, a trader-responsible window's rows count as **unreadable**, as when the database is down: no trader window classifies, and while one's evidence is not settled every segment is kept, in either mode. A registry of gateway-only windows needs none |
| `RESEARCH_WORKER_TRADER_ENVIRONMENT` | `PAPER` | The run mode whose rows are read |
| `RESEARCH_WORKER_RAW_RETENTION_MS` | 72 h | At least 72 h; shorter is refused |
| `RESEARCH_WORKER_PIN_LEAD_IN_MS` | 15 min | The reference lead-in before a pinned window |
| `RESEARCH_WORKER_DURABILITY_GRACE_MS` | 60 s | How long after its end a window's market can still produce evidence: the trader must have processed every frame stamped up to the end plus this |
| `RESEARCH_WORKER_PIN_BUDGET_BYTES_PER_DAY` | 3 GB | The pin-budget alarm (6 GB at 8 markets) |
| `RESEARCH_WORKER_EXPIRY_STUCK_AFTER_MS` | 6 h | Expiry lag that raises the stuck alarm |
| `RESEARCH_WORKER_WAL_MAX_TOTAL_BYTES` | none | The gateway's `maxTotalBytes`, for the capacity metric. The writer counts every byte written in its epoch and never subtracts an expired segment, so expiry does not give it room back |
| `RESEARCH_WORKER_CLOCK_STEP_TOLERANCE_MS` | 60 s | Clock movement between cycles below which nothing is a step (capped at 10 min) |
| `RESEARCH_WORKER_EXTRACTION_BATCH_DELAY_MS` | 1 h | How long sealed segments wait to be extracted together (capped at 12 h) |
| `RESEARCH_WORKER_MAX_SEGMENTS_PER_RESEARCH_DATASET` | 64 | Segments per research-tier dataset |

### The opt-in marker

Expiry refuses any WAL root that does not hold the file
`.polymarket-bot-raw-wal-expiry-opt-in` with exactly this content (one line, LF-terminated):

```text
polymarket-bot: raw WAL in this directory may expire after a verified extract (ADR-028).
```

Create it only on the host's live WAL root, deliberately. A copy of recorded evidence
kept elsewhere must never carry it.

### The window registry

```json
{
  "windowRegistryVersion": 1,
  "windows": [
    {
      "windowId": "btc-updown-15m-1790764200",
      "marketId": "<catalog.markets.market_id>",
      "conditionId": "0x…",
      "gammaMarketId": "5121169",
      "tokenIds": ["<yes token>", "<no token>"],
      "windowStart": "2026-09-30T10:30:00Z",
      "windowEnd": "2026-09-30T10:45:00Z",
      "responsibleFrom": "2026-09-29T10:37:21Z",
      "responsibility": { "kind": "trader", "instanceIds": ["<strategy instance id>"] }
    }
  ]
}
```

`responsibility` is `{ "kind": "gateway-only" }` for a market only the gateway records.
`gammaMarketId` (optional) is the id the gateway's lifecycle feed polls; a segment whose
polls name an unregistered Gamma id is kept, as one naming an unregistered token is.
`responsibleFrom` is the earliest instant the trader could have acted on the market (its
admission, or the market's open for orders). It is **required** for a trader-responsible
window — a trader can act before the window opens — and defaults to `windowStart` for a
gateway-only one. Until the window classifies, every segment from it (less the lead-in) to
the window's end is kept.

The registry may be pruned of a window once an `execute` cycle has settled it — its pin
extracted and verified with its whole chain inside, or classified with no evidence — and its
segments have all expired. A dry run never settles a window durably: it reports what
`execute` would do, and keeps the window's holds. Pruning a window earlier releases nothing
that a cycle, in either mode, has already read: its durable holds
(what its rows showed while it was unclassified, and its whole pin range while it was
classified and not yet settled) and a failed read of its rows stay in `evidence-holds.json`,
and keep those segments until the window is registered again and settled by an `execute`
cycle, or its entry there is removed deliberately. What is not yet known is not held:
evidence its trader makes after the last cycle read its rows, and the potential range of a
window that was unclassified with no evidence yet (its trader lagging). A segment of the pruned window's range outside its holds
is then decided without it: kept when it names a market no registered window names, but
expired like any other segment when another window of the same market is still registered.

### Operator pins

```json
{
  "operatorPinVersion": 1,
  "pins": [{ "pinId": "incident-42", "from": "…Z", "to": "…Z", "reason": "…" }]
}
```

An operator pin keeps the raw WAL it covers, and an exact copy is extracted too. It lasts
until the operator removes it from the file. Its extracted copy is never deleted: once the
pin is removed, a segment it covers may expire, and that copy is then verified and named in
the receipt like any other pin's.

Publish a pin with the command, not by editing the file:

```text
RESEARCH_WORKER_OPERATOR_PINS=/var/lib/polymarket-bot/operator-pins.json \
  node dist/main.mjs storage pin incident-42 2026-09-30T10:00:00Z 2026-09-30T11:00:00Z "review"
```

It takes the lock `<pins file>.lock`, beside the file's canonical path (symbolic links
resolved), which expiry also holds from each segment's final decision through its unlink,
so a published pin holds every segment that has not already been deleted. Every spelling of
the file reaches the same lock; a pin file with a second hard link, or a symbolic link to a
missing file, is refused. A pin added by hand is re-read just before each unlink, but only the command
is serialized with the unlink itself. A lock left by a crashed process is never broken
automatically: expiry refuses to delete while it is held, and the error names the holder.

### What it does not do yet

- It does not delete a lapsed non-fill pin (30 days); the pin's `keepUntil` is recorded.
- The trader writes no halt or refusal rows today (`OUT1-R1-HALT-NOT-DURABLE`), so a window
  with only those is classified unpinned until it does.
