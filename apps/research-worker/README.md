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
   segment of every source event already located included.
3. **Pins.** A window with a fill (kept forever), an intent, a refusal or a halt (30 days),
   and every operator pin, is copied exactly — whole WAL segments, through the `WP-130`
   compactor — under `pins/<pinId>/`. A pin, once extracted, is a durable fact: a window
   whose existing pin already holds everything it requires stays bound to that pin, even
   after the segment holding its chain's source event has expired under it.
4. **Plan.** Every sealed segment is decided, with every reason it is kept. A segment may
   expire only when its newest frame is at least 72 h old, its research tier verifies,
   every market it names is registered and every frame could be identified, every window it
   could overlap is classified, every overlapping pin is extracted and verified, and no
   operator pin covers it. "Every overlapping pin" is every pin in the store, not only the
   ones this cycle derives: a window that is unclassified this cycle (the trader database
   unreachable, say), re-derived or re-registered still has its pin verified and named in
   the receipt. A pin record that does not read keeps every segment.
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

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESEARCH_WORKER_WAL_ROOT` | required | The gateway's WAL root (`<root>/<gatewayEpoch>/…`) |
| `RESEARCH_WORKER_OBJECT_STORE_ROOT` | required | The filesystem object store |
| `RESEARCH_WORKER_EXPIRY_MODE` | `dry-run` | `execute` deletes, subject to the marker |
| `RESEARCH_WORKER_STATE_DIR` | none | Where durable expiry plans live; required for `execute` |
| `RESEARCH_WORKER_WINDOW_REGISTRY` | none | The market windows (below). With none, every segment that names a Polymarket market is kept |
| `RESEARCH_WORKER_OPERATOR_PINS` | none | Operator pins (below) |
| `RESEARCH_WORKER_TRADER_DATABASE_URL` | none | The trader's PostgreSQL, read-only. With none, no trader window classifies |
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

The registry may be pruned of windows whose segments have all expired: a segment that
names a pruned window's market is then unclassified and kept, never deleted.

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
