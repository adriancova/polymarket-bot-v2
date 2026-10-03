# Trader-throughput benchmark (`THROUGHPUT-1a`)

Replays a recorded market burst through **real Redis** into the **real durable
trader** on **real PostgreSQL**, and measures what H1 run 1 could not see:
events/s, decisions/s, each event's lag from publication to the trader's
durable commit, halts, and the durable row counts. PAPER only: no venue, no
wallet, no signer, no credential; throwaway containers bound to 127.0.0.1.

## What runs

`run.sh` bundles the harness with the trader's own esbuild and bundle flags and
runs it. The harness sources live in
`test/integration/paper-trader/support/throughput/` (not here: every tracked
`.ts`/`.mjs` file ESLint lints must sit inside the typed lint program, and
`eslint.config.mjs` is protected), where the trader integration suite also
drives them on a committed sample
(`test/integration/paper-trader/throughput-bench-harness-postgres-redis.test.ts`),
so the harness cannot rot.

One run:

1. starts `redis:7.4.2-alpine --appendonly yes` and `postgres:17.5-alpine` (the
   H1 compose images and settings), named `<prefix>-redis-<hex>` /
   `<prefix>-pg-<hex>`, removed at the end unless `--keep` — or uses
   `--redis-url` / `--postgres-url`;
2. creates a fresh database and applies every migration (`migrateUp`);
3. registers ONE market, instance and run with **REGISTER-1's command**
   (`runRegisterCommand`, in-process) from the H1 `template.json`, and rewrites
   the fixture's `payload.internalMarketId` (H1's
   `01a0eed4-9faf-7911-bb58-c8e64ab55859`) to the minted id — the only change
   made to any envelope;
4. publishes through the real `RedisStreamsEventTransport`, in stream order:
   since `THROUGHPUT-2` (ADR-024) each raw frame — a run of consecutive
   envelopes sharing a `causationId` — goes out in ONE atomic `publishBatch`
   call, as the gateway's publisher now writes it, and a single envelope by
   `publish`;
5. runs the trader exactly as `apps/trader/src/main.ts` `startup()` does —
   `RedisStreamsEventTransport.connect`, `assembleDurableTrader` (the real
   `PostgresTraderStore`, the `BOOT-1` registration check, the simulated venue,
   `createPaperTrader`, `SystemPaperClock`), `transport.subscribe`,
   `RedisMarketEventFeed`, `pump` — except that `pump` is called with
   `untilIdle: true` in a loop (it returns at its first empty poll, after
   everything before it is durable and recorded) so the run can stop once
   every event is recorded, and the feed is wrapped in a pass-through observer
   that logs when each stream position was recorded;
6. reports and writes `report.json`, `decisions.jsonl` and `checkpoints.jsonl`
   (the durable decision and checkpoint content per sequence number) and, with
   `--cpu-prof`, the V8 CPU profile of the measured window (sampled every
   250 µs, which itself costs wall time: compare throughput between runs made
   without it) plus its top-N attribution by self and by total time
   (`profile-top.txt`).

### Modes

- `--mode catch-up`: everything is published first, then the trader drains the
  backlog. The ceiling: events/s and decisions/s.
- `--mode paced`: the trader subscribes first; a SEPARATE Node process (the
  gateway is one) publishes each frame at its first envelope's recorded
  `receivedAt` spacing (136 s for the H1 burst). Whether the trader keeps up:
  the lag.

The report's `framesSplit` counts the frames the trader's feed had to hand out
across two batches because one frame filled a whole batch (ADR-024 D2); it is
`0` on the H1 burst. Comparing a `THROUGHPUT-2` run with an earlier commit's:
the earlier harness publishes one envelope per call, which only changes when
the envelopes land in paced mode, never what they are.

Lag is the host-clock time from an envelope's `publish` resolving to the moment
the trader recorded a stream position covering it — which the pump does only
once every decision of the events before it is durable. Max, p99 and p50 are
reported, with the process CPU time (`cpuMs`) of the measured window: the host
is shared, and CPU time is steadier than wall time under contention.

### The fixture

`burst-2026-09-29T2100.jsonl` (H1 run 1's last 100,000 envelopes; not
committed) plus `market-opened-h1.json`, prepended. The burst starts
mid-stream: its first 332 envelopes include level changes whose baseline
snapshot was published before the cut, and the real order book refuses a level
change with no baseline (a `BOOK_DESYNCHRONIZED` market halt, which stops the
pump). The benchmark therefore replays the burst **from index 332** — a
contiguous suffix of the recorded stream, the first point from which every
level change has its baseline (`fixture.ts` `firstBaselineIndex`) — 99,668
envelopes plus `MarketOpened` = 99,669.

## Usage

```sh
F=<dir with the H1 fixtures>
tools/bench/trader-throughput/run.sh --mode catch-up --out-dir /tmp/bench \
  --fixture $F/burst-2026-09-29T2100.jsonl --market-opened $F/market-opened-h1.json \
  --template $F/template.json [--cpu-prof] [--limit N] [--container-prefix tp-bench] \
  [--code-commit $(git rev-parse --short HEAD)]

tools/bench/trader-throughput/run.sh --mode paced --out-dir /tmp/bench ...   # same flags

tools/bench/trader-throughput/run.sh profile /tmp/bench/<run>/<file>.cpuprofile --top 40
```

### Comparing two commits' durable decisions exactly

Two runs register two markets, and a feature snapshot's content address covers
its market id, so their `feature_snapshot_ref` columns differ. The report's
NORMALIZED digests (minted ids replaced by placeholders, the two id-hashing
columns dropped) compare any two runs. For an exact, every-column comparison,
register ONCE and clone:

```sh
tools/bench/trader-throughput/run.sh register --postgres-url postgres://… \
  --template $F/template.json --registered /tmp/reg
tools/bench/trader-throughput/run.sh --mode catch-up --registered /tmp/reg \
  --redis-url redis://… --postgres-url postgres://… --out-dir … --fixture … --market-opened …
```

Each run then clones the registered database (`create database … template …`),
so both runs share every minted id; compare their `decisions.jsonl`.

With `--registered`, the run uses the registered directory's `document.json`
and ignores `--template`: the configuration, a `bookFreshness` block
included, is the one given to `register`. Register once per configuration.

### Recorded timestamps and `CONNECTION_CONFIRMED` (ADR-023 D7)

The harness runs the trader with `SystemPaperClock` and publishes the
fixture's recorded `receivedAt` values unchanged, so every event is hours or
days older than the process clock. Under `bookFreshness.basis:
"CONNECTION_CONFIRMED"` the process-lag guard therefore gives every book its
`LAST_CHANGE` answer: a bench run over recorded data does not exercise the
extension: its book ages are the `LAST_CHANGE` ones. The mechanism is
exercised by the backtest's replay clock and by
`packages/trading-core/src/book-freshness.test.ts`.

`BENCH_BUILD_DIR` keeps the bundles in a directory of your choosing.
