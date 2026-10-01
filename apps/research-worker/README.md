# `@polymarket-bot/research-worker`

Two commands in one bundle (`dist/main.mjs`). Neither holds a credential, opens a venue
connection or places an order; neither reads or relaxes `MAX_RUN_MODE`,
`ALLOW_REAL_ORDERS` or the live-micro caps.

| Command | What it does | Deletes? |
| --- | --- | --- |
| `node dist/main.mjs` | `WP-130` compaction loop: verified WAL segments to exact Parquet datasets | Only with `RESEARCH_WORKER_RETENTION=delete-after-verified-upload` (default `retain`) |
| `node dist/main.mjs storage` | `STORAGE-1` storage cycle: research tier, window classification, pins, raw-WAL expiry plan, metrics (ADR-028, ADR-029) | Only in `execute` mode **and** with the opt-in marker in the WAL root (default `dry-run`) |

Build and run with `pnpm --filter @polymarket-bot/research-worker start` (compaction) or
`pnpm --filter @polymarket-bot/research-worker start storage`.

## The storage cycle (`storage`)

One run does, in order:

1. **Research tier.** Every sealed WAL segment with no research tier yet is verified
   (`validateSegment` and the compactor's reader, over one in-memory read) and downsampled
   into a version 2 `approximate` dataset under `research/<gatewayEpoch>/` in the object
   store. A segment that fails verification is never extracted, so it never expires.
2. **Classification.** Every registered market window is classified: a trader-responsible
   window once the trader's durable rows (read **read-only** from PostgreSQL) have passed
   its end; a gateway-only window at its close.
3. **Pins.** A window with a fill (kept forever), an intent, a refusal or a halt (30 days),
   and every operator pin, is copied exactly — whole WAL segments, through the `WP-130`
   compactor — under `pins/<pinId>/`.
4. **Plan.** Every sealed segment is decided, with every reason it is kept. A segment may
   expire only when its newest frame is at least 72 h old, its research tier verifies,
   every window it could overlap is classified, every overlapping pin is extracted and
   verified, and no operator pin covers it.
5. **Expiry**, only in `execute` mode: the plan is written durably to the state directory
   first, each segment is re-decided and its bytes proved against the research tier and
   the pins immediately before the unlink, and a version 2 retention receipt is written to
   `expiry/<planId>/retention-receipt.json`.
6. **Metrics**: disk use, `maxTotalBytes` headroom, pin budget (an alarm only; no pin is
   ever evicted or reduced), expiry lag, and plans with no receipt.

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
| `RESEARCH_WORKER_DURABILITY_GRACE_MS` | 60 s | Margin the trader's frontier must pass a window's end by |
| `RESEARCH_WORKER_PIN_BUDGET_BYTES_PER_DAY` | 3 GB | The pin-budget alarm (6 GB at 8 markets) |
| `RESEARCH_WORKER_EXPIRY_STUCK_AFTER_MS` | 6 h | Expiry lag that raises the stuck alarm |
| `RESEARCH_WORKER_WAL_MAX_TOTAL_BYTES` | none | The gateway's `maxTotalBytes`, for the headroom metric |
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
`responsibleFrom` (optional; defaults to `windowStart`) is the earliest instant the trader
could have acted on the market. Until the window classifies, every segment from it (less
the lead-in) to the window's end is kept.

### Operator pins

```json
{
  "operatorPinVersion": 1,
  "pins": [{ "pinId": "incident-42", "from": "…Z", "to": "…Z", "reason": "…" }]
}
```

An operator pin keeps the raw WAL it covers, and an exact copy is extracted too. It lasts
until the operator removes it from the file.

### What it does not do yet

- It does not delete a lapsed non-fill pin (30 days); the pin's `keepUntil` is recorded.
- The trader writes no halt or refusal rows today (`OUT1-R1-HALT-NOT-DURABLE`), so a window
  with only those is classified unpinned until it does.
