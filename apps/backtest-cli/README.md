# `@polymarket-bot/backtest-cli` (WP-210, BACKTEST-1)

The composition root for a `BACKTEST` run: it verifies a `WP-130` dataset against
its own manifest, replays it deterministically through
`@polymarket-bot/simulation`, and drives the shared paper core through the
replay hook (`replayDrivenCoreLoop`).

## Safety

§11: `BACKTEST` is "Historical replay / Simulated / **None**" — no credentials at
all. This process:

- holds no credential, opens no venue connection, signs nothing, and places no
  order;
- never reads, defaults, or raises `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`,
  `LIVE_MICRO_MAX_ORDER_NOTIONAL` or `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE`;
- **REFUSES TO START** if the environment raises any of those four, or carries a
  variable whose NAME looks like a key (§6 invariant 17: "A real key cannot be
  loaded by paper or backtest processes. Startup validation rejects this
  configuration"). The variable's name is reported; its value never is.

## Why this is the only place with `node:fs`, `node:crypto` and layer-2 adapters

`docs/contracts/dependency-direction.md` §2: this is a layer-3 composition root,
so it is the correct — and the only permitted — place where the layer-1
simulation package meets `@polymarket-bot/storage-parquet` (the archived rows),
`@polymarket-bot/polymarket-public` (the venue normalizer), `@polymarket-bot/domain`
and `@polymarket-bot/risk`'s `./schema-arena` door (the frozen §7.4 contracts a
normalized-stream recording is validated against), and Node built-ins.
`packages/simulation` is layer 1, is not on §2.2's built-in allowlist, and
therefore takes all three as PORTS: a SHA-256 function, an archive reader, and a
normalizer.

## Usage

```text
backtest-cli verify --dataset <dir> --pins <run-pins.json>
```

`verify` reads `<dir>/dataset-manifest.json` under the ADR-017 §3 strict-JSON
profile, digests every object the manifest pins and compares it with the pin,
re-derives each record's `payloadSha256`, reconciles the dispatch ordinals,
counts and exclusions against the manifest's own numbers, replays every recorded
frame in recorded dispatch order, and prints the §12.4 canonical run
serialization.

`--pins` is the complete §12.5 run-scoped pin set. Every field is REQUIRED and
NOTHING ELSE is accepted — `readRunPins` refuses an unknown key, so a pin set
carrying a field nothing reads is a refusal rather than a silent pass-through.
ADR-012 §4 — "A result whose fill-model parameters are not pinned is not
reproducible and is not evidence of anything."

The report prints two ordering diagnostics, and they measure different things:
`received_at_inversions` counts recorded ARRIVAL wall clocks out of order across
the dispatch-ordered rows, and `venue_timestamp_inversions` counts DELIVERED
envelopes whose `venueTimestamp` is earlier than one already delivered — the
§8.4 disagreement. Both are compared on epoch milliseconds, both are reported,
and neither reorders anything.

## The three shipped normalizers

| Normalizer | Version | What it does |
| --- | --- | --- |
| `recordedFrameNormalizer` | `backtest-cli/recorded-frame-passthrough/v1` | Verification only. **No venue interpretation at all** — it envelopes the recorded frame as-is so a dataset's ordering, checksums and counts can be verified without a market directory. Its version says so in its name, so a dataset pinned to a real normalizer refuses it. |
| `polymarketMarketNormalizer` | `polymarket-public/market-channel/v1` | The REAL `@polymarket-bot/polymarket-public` market-channel normalizer, given a `PublicMarketDirectory`. |
| `normalizedEnvelopeNormalizer` | `backtest-cli/normalized-envelope/v1` | Replays a recording of the NORMALIZED §7.4 stream — the envelopes the paper core consumes. Each frame's payload carries what the gateway ADDED to a raw frame (`eventType`, `schemaVersion`, `sourceChannel`, optional `venueTimestamp`, `payload`); provenance is the frame's own. Every envelope is validated against its frozen `packages/domain` contract through a prototype-free arena copy before delivery (schema-boundary §6 rule 1). It exists because `MarketOpened` and `MarketClosing` have no raw-frame origin and no producer in the repository yet, so a raw-frame dataset cannot drive the core through a lifecycle. |

A normalization problem is a REFUSAL that stops the replay, never a dropped
event (§8.3).

## The shared core in replay (BACKTEST-1, GOV-2B B3)

At base `1aa2238` nothing in the repository supplied `runBacktest`'s `coreLoop`:
every replay verified and drove the dataset with no decision, no order and no
fill, so handoff §7 checklist item 4's replay half did not exist. This app now
ships the DRIVER of the shared core — `replayDrivenCoreLoop`, which turns one
delivered replay event into: advance the `ReplayClock` to the recorded instant
→ `ingest` → `drain`, the same two loop methods `apps/trader/src/pump.ts` calls
in the same order — and `runBacktest` takes the simulated `venue` so the §12.4
serialization carries the orders, fills and economics the core produced.

The core itself — `apps/trader`'s `createPaperTrader` over the real books,
feature engine, strategy runtime, Static Bracket, allocator, risk engine,
planner, `SimulatedVenue`, ledger and PnL engine — is **not constructed here,
and cannot be**: `docs/contracts/dependency-direction.md` §2 rules that nothing
may depend on an app, and a second loop written here would be the second code
path §12.1 forbids. The caller that holds both apps is
`test/unit/simulation/backtest-replay-support.ts`, and the fixture-driven proof
— Static Bracket completing an entry → exit round trip through this root over
the committed dataset `test/replay-golden/backtest/static-bracket/`, byte-identical
across runs — is `test/unit/simulation/backtest-static-bracket-replay.test.ts`,
gated by `pnpm test:replay`.

Consequently the executable's `verify` command still runs the verification-only
normalizer with no core. Making the binary construct the core itself needs the
composition moved below layer 3 (or a ruled §2.1 exception), which is the
follow-up the BACKTEST-1 round records.

## What is deliberately NOT here

A second trading loop. Books, features, the strategy runtime, risk, the
allocator, the planner and the ledger are assembled by `WP-230` in `apps/trader`,
exactly once; this app drives that assembly and never re-implements any part of
it.
