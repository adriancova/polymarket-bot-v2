# `@polymarket-bot/backtest-cli` (WP-210, BACKTEST-1, BACKTEST-2)

The composition root for a `BACKTEST` run: it verifies a `WP-130` dataset against
its own manifest, replays it deterministically through
`@polymarket-bot/simulation`, and — with the `run` command — BUILDS the shared
trading core (`@polymarket-bot/trading-core`, ADR-022) itself and drives it
through the replay hook (`replayDrivenCoreLoop`), writing a SIMULATED artifact.

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
- `run` builds the core, so it ALSO runs the core's own startup check
  (`checkPaperTraderSafety`) first, before any file is opened: an ADR-010 §3
  production secret or account NAME (`POLY_API_KEY`, `POLYMARKET_PRIVATE_KEY`,
  …) refuses by its mere presence, and `RUN_MODE`, when set, must be `PAPER`
  (the core is the PAPER core; see below).

## Why this is the only place with `node:fs`, `node:crypto` and layer-2 adapters

`docs/contracts/dependency-direction.md` §2: this is a layer-3 composition root,
so it is the correct — and the only permitted — place where the layer-1
simulation package meets `@polymarket-bot/storage-parquet` (the archived rows),
`@polymarket-bot/polymarket-public` (the venue normalizer), `@polymarket-bot/domain`
and `@polymarket-bot/risk`'s `./schema-arena` door (the frozen §7.4 contracts a
normalized-stream recording is validated against), the layer-1 shared trading
core `@polymarket-bot/trading-core` (a downward edge, no §2.1 row), and Node
built-ins.
`packages/simulation` is layer 1, is not on §2.2's built-in allowlist, and
therefore takes all three as PORTS: a SHA-256 function, an archive reader, and a
normalizer.

## Usage

```text
backtest-cli verify --dataset <dir> --pins <run-pins.json>
backtest-cli run --dataset <dir> --pins <run-pins.json> --config <trader-config.json> \
                 --artifact <file> [--id-namespace <namespace>]
backtest-cli approx-run --store <dir> --manifests <key>[,<key>...] \
                 --gamma-markets <marketId>=<gammaMarketId>[,...] --pins <run-pins.json> \
                 --config <trader-config.json> --artifact <file> [--id-namespace <namespace>]
```

`verify` and `run` are EXACT: both read the dataset manifest through
`packages/simulation`'s exact door, which refuses a research-tier
(`approximate`) manifest with `REPLAY_MANIFEST_APPROXIMATE`. `approx-run` is
the approximate backtest over the research tier (below); nothing it produces
is evidence.

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

`normalizedEnvelopeNormalizer` has had a schema-boundary §4 item 5 pollution
battery RUN and PINNED since `BACKTEST-2` (`src/normalizer-battery.test.ts`,
BT1-R4): 33 inherited keys × 2 variants over 20 cases — the 8 fixture frames
and one refused case for each of the door's 12 refusal sites (the containment
catch's case is a record whose read throws). No throw escapes, permission
never widens, every accepted envelope is byte-identical, and only the get-only
numeric names fail closed. Each refused case is pinned to its own site's
reason, and a source census pins that the cases reach every refusal site in
`src/normalizer.ts`'s envelope door, so a refusal added there without a case
fails the battery.
Its first run found, and `BACKTEST-2` fixed, an adopted `venueTimestamp` and
an uncontained throw from zod's refusal construction. The other two
normalizers have had no battery run.

## `run` — the backtest (BACKTEST-2, closes GOV-2B B3)

`run` is the operator-runnable backtest:

1. **Startup safety FIRST**, before any file is opened: this root's check and
   the core's (above).
2. Reads the run pins (`--pins`) and the operator configuration (`--config`,
   the same document the paper trader reads) under the ADR-017 §3 strict-JSON
   profile.
3. **Builds the shared core itself** (`src/assembly.ts`): the core's
   configuration door; the run pins reconciled against it — `fillModelVersion`,
   `fillModelParametersHash`, `feeSnapshotVersion` and every instance's
   `runSeed` must agree, or the run is REFUSED naming the field (BT1-R2); a
   `ReplayClock` at the dataset's first recorded instant; the core's ONE
   simulated-venue builder (`buildSimulatedVenue`, the call the paper trader's
   `main.ts` makes); the core's PRODUCTION in-memory store; `createPaperTrader`;
   and the driver, bound to the core's clock and halt latch. It takes no core
   from its caller.
4. Drives it through the shipped `runBacktest` + `replayDrivenCoreLoop`.
5. Writes the artifact (`src/artifact.ts`) to `--artifact` — never over an
   existing file — and prints the report, `core_run_mode=PAPER`,
   `evidence=SIMULATED_NOT_REAL_EVIDENCE`, the artifact's byte count and its
   sha256.

`run` requires a normalized-stream recording (pins naming
`backtest-cli/normalized-envelope/v1`); `verify` still runs any pinned
normalizer. `--id-namespace` seeds every identifier the core mints; absent,
it is the instances' run ids joined, as the paper trader derives it.

Exit codes: `0` a completed run with no halt; `2` usage; `3` refused
(safety, a file, the configuration, the pins, the dataset, an existing
artifact); `75` the core latched a halt — the replay stopped where the live
pump returns `HALTED`, or the end-of-run accounting check latched one over a
completed run (the artifact is then still written and shows it).

Over the committed fixture the artifact is byte-identical to
`test/replay-golden/backtest/static-bracket/expected-artifact.txt`. From the
repository root, after `pnpm --filter @polymarket-bot/backtest-cli build`:

```text
node apps/backtest-cli/dist/main.mjs run --dataset test/replay-golden/backtest/static-bracket \
  --pins test/replay-golden/backtest/static-bracket/run-pins.json \
  --config test/replay-golden/backtest/static-bracket/trader-config.json \
  --artifact /tmp/artifact.txt --id-namespace backtest-1-static-bracket-replay
```

**Run mode (ADR-022 D6; BT1-R5 — recorded, not changed).** This root runs in
`BACKTEST` mode; the core it builds is the PAPER core, whose run-mode
constants are the paper trader's, unchanged. A backtest is "the PAPER core
driven by recorded events under the BACKTEST root".

## `approx-run` — approximate replay over the research tier (APPROX-REPLAY-1, ADR-029)

`approx-run` replays a research-tier dataset — the downsampled record
`STORAGE-1`'s extractor keeps under `research/<gatewayEpoch>/<datasetId>/` —
through the SAME core `run` builds (`assembleBacktestCore`) and the SAME
driver (`replayDrivenCoreLoop`). Its code is `src/approximate/`.

**Nothing it produces is evidence.** ADR-029 Decision 2: an approximate
dataset, and any result computed from it, is never determinism, calibration,
promotion or soak evidence, and ranks below every ADR-012 tier. So:

- every line it prints, and every line of the artifact it writes after the
  format id, starts with the manifests' own `fidelity` (`approximate`), read
  through the verifier — never inferred from a file name;
- its formats are its own: `polymarket-bot/approximate-run/v1` and
  `polymarket-bot/approximate-backtest-replay/v1`;
- the exact tools refuse it: `verify`, `run`, `runBacktest`,
  `runBacktestCore` (`REPLAY_MANIFEST_APPROXIMATE`) and the exact artifact
  renderer, which refuses any result that states a fidelity or is not an exact
  run's serialization.

**The source** (`approximate/research-source.ts`):

1. every manifest is verified by `storage-parquet`'s `verifyResearchTierDataset`
   first; an unverified dataset is refused and nothing of it is read. Each
   table object is then read once more and digested against the verified pin
   before it is decoded;
2. datasets of more than one gateway epoch STOP AND ASK (exit 4): no recorded
   evidence orders one epoch against another (`wal-format.md` §12.1; ADR-029
   Decision 5.4). Several datasets of one epoch must form one unbroken
   `stateIn` chain;
3. samples are consumed in the dispatch order of their release frames
   (`releaseIngestSeq`), with downsampling v1's fixed tie order — never by
   instant. Both are checked, and so are the span release rules a reader can
   see: a span sample is released at or after its boundary, one frame closes
   at most one span of each length, and boundaries only increase. A dataset
   of another downsampling version is refused: its tie order is unknown here.

**The translation** (`approximate/translate.ts`,
`backtest-cli/research-tier-samples/v1`, pinned by the run pins as their
`normalizerVersion`) turns samples into the envelopes the core consumes, and
states what each loses: a full book or a five-level depth becomes a
`BookSnapshot` (one per token per release frame; no connection, so ADR-023's
session liveness never extends it); a 1 s reference bar becomes one
`ReferenceTradeObserved` at its close; a Polymarket trade a
`PublicTradeObserved`; Gamma polls become `MarketOpened`/`MarketClosing` by
`UNIV-4`'s rules at sample resolution, attributed to a configured market by
the operator-stated `--gamma-markets` id; the configured `closeTime` gives the
scheduled `MarketClosing`. `market_resolved` (no timestamp is kept),
tick-size and new-market events, Chainlink ticks and feed events become
nothing, and are counted in the run record.

**The clock.** The driver advances the replay clock to each release frame's
receipt instant before every envelope is ingested, and every envelope's
`receivedAt` is that instant: the process-lag guard (ADR-023 D7, ADR-031)
reads 0. The research tier records no monotonic reading; the run uses the
receipt instant in milliseconds, never decreasing, and says so
(`monotonicBasis=DERIVED_FROM_AVAILABLE_AT_MILLISECONDS_NON_DECREASING`).

Exit codes: `0` completed; `2` usage; `3` refused or stopped part-way (the
translation, a venue refusal); `4` stopped to ask (more than one gateway
epoch); `75` the core latched a halt. A stopped run writes no artifact.

## The shared core in replay (BACKTEST-1, BACKTEST-2, GOV-2B B3)

At base `1aa2238` nothing in the repository supplied `runBacktest`'s `coreLoop`:
every replay verified and drove the dataset with no decision, no order and no
fill, so handoff §7 checklist item 4's replay half did not exist. `BACKTEST-1`
shipped the DRIVER of the shared core — `replayDrivenCoreLoop`, which turns one
delivered replay event into: advance the `ReplayClock` to the recorded instant
→ `ingest` → `drain`, the same two loop methods `apps/trader/src/pump.ts` calls
in the same order — and `runBacktest` takes the simulated `venue` so the §12.4
serialization carries the orders, fills and economics the core produced. A
halt the core latches stops the replay where the pump returns `HALTED`
(BT1-R3, `BACKTEST-2`).

The core itself — `createPaperTrader` over the real books, feature engine,
strategy runtime, Static Bracket, allocator, risk engine, planner,
`SimulatedVenue`, ledger and PnL engine — lives in `@polymarket-bot/trading-core`
since `CORE-MOVE` (ADR-022), and since `BACKTEST-2` **this app builds it**
(`run`, above): no test harness hands it in. The fixture-driven proof — Static
Bracket completing an entry → exit round trip through this root over the
committed dataset `test/replay-golden/backtest/static-bracket/`, byte-identical
across runs — is `test/unit/simulation/backtest-static-bracket-replay.test.ts`,
gated by `pnpm test:replay`, which now drives this app's own assembly; and
`src/run-command.test.ts` drives `run` itself, argv in, artifact file out, to
the same golden bytes.

The executable's `verify` command runs the normalizer the run pins name
(`normalizerFor`: `normalizedEnvelopeNormalizer` when the pins say
`backtest-cli/normalized-envelope/v1`, else the verification-only passthrough,
whose version then fails the pin reconciliation by name) and drives NO core;
`run` is the command that builds and drives one. *(Corrected by `BACKTEST-2`,
BT1-R1: this paragraph used to say that `verify` "still runs the
verification-only normalizer with no core", which stopped being true when
`BACKTEST-1` made it select the normalizer the pins name.)*

## What is deliberately NOT here

A second trading loop, or a second venue. Books, features, the strategy
runtime, risk, the allocator, the planner and the ledger are assembled by
`createPaperTrader` in `@polymarket-bot/trading-core`, exactly once, and the
simulated venue is built by that package's one builder; this app calls both and
never re-implements any part of either.
