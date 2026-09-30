# Host-bench tools (`HOST-BENCH-PREP`)

Standalone measurement tools for `HOST-BENCH` on the dedicated laptop. They
need no product code and no credential, and they read public market data only.
The step-by-step guide that uses them is
[`docs/runbooks/laptop-host-bench.md`](../../../docs/runbooks/laptop-host-bench.md).

| File | What it does | Needs |
|---|---|---|
| `setup-wsl-root.sh` | The root part of the WSL setup: systemd, base packages, Docker Engine (`docker-ce`, inside WSL), the `docker` group. The operator runs it once with `sudo` | Ubuntu on WSL2 |
| `record_markets.py` | The multi-market recorder: Gamma discovery, one public market WebSocket per series, rollover, counters, `summary.json` | Python 3.10+, `websockets` (see `requirements.txt`) |
| `recorder_core.py` | The recorder's pure logic: parsing, window selection, subscription diffs, counting, the summary. Every venue fact it uses is cited in its docstring | Python standard library |
| `host_sampler.py` | CPU, memory, pressure, disk, network, free space and per-process RSS every 60 s; optionally Windows-side CPU performance, thermal zones, the WSL VM's memory and the adapters' byte counters | Python standard library; `powershell.exe` through WSL interop for `--windows` |
| `trader-bench.sh` | One trader-throughput bench run on the H1 burst with the guide's fixed inputs; `--pin CPU` runs it under `taskset` | the repository installed; Docker |
| `bench_table.py` | Tabulates the trader-throughput bench's `report.json` files as Markdown | Python standard library |
| `report_tables.py` | Markdown tables from the recorder's `summary.json` and the sampler's summary; `trim` drops the per-window list | Python standard library |
| `tests/` | Offline `unittest` suites, on 28 frames from H1 run 8's WAL and a trimmed Gamma response | Python standard library |

## Offline checks

```sh
python3 -m unittest discover -s tools/bench/host/tests -v
```

`test/unit/tooling/host-bench-tools.test.ts` runs the same suites inside
`pnpm run test`. It also pins that the tools name only documented public
endpoints and no credential.

## The recorder

```sh
python3 -m venv ~/pmb-host-bench/venv
~/pmb-host-bench/venv/bin/pip install -r tools/bench/host/requirements.txt
~/pmb-host-bench/venv/bin/python tools/bench/host/record_markets.py --list-series
~/pmb-host-bench/venv/bin/python tools/bench/host/record_markets.py \
  --out-dir ~/pmb-host-bench/recording --duration-hours 24 --raw
```

How it works:
- **Discovery.** Once a minute it calls Gamma `GET /events?closed=false&end_date_min=…&end_date_max=…` (40 minutes ahead). It keeps the markets whose event's `seriesSlug` is wanted. That is 1-10 requests a minute; the documented `/events` limit is 500 per 10 s.
- **Selection.** Each second, per series, it wants the window that has started and not ended (kept 30 s past its end), plus the next window. The next window is subscribed before it opens, so the open itself is recorded.
- **Connections.** One public market WebSocket per series. It sends the documented subscribe frame, with `custom_feature_enabled: false` and `initial_dump: true` as the gateway sends them. Rollover uses the documented dynamic `subscribe` and `unsubscribe` frames on the same connection.
- **Keep-alive.** `PING` every 10 s. With no `PONG` for 30 s (the SDK's client-side bound), it closes and reconnects. Reconnects use full-jitter backoff from 0.25 s to 30 s.
- **Compression.** The WebSocket compression extension is off, like the gateway's client. Byte counts are therefore the text payloads the gateway would receive.
- **Counting.** It counts every inbound text frame by the `market` (condition id) of each event it carries. A frame with several events has its bytes split by each event's JSON length.
- **Files.** It writes a per-second file, a window log and `summary.partial.json` every 5 minutes. It writes `summary.json` at the end, or on Ctrl-C or SIGTERM.

Outputs in `--out-dir`:

| File | Content |
|---|---|
| `summary.json` | The final summary (below). `summary.partial.json` while running |
| `per-second.jsonl.gz` | `{"t": <epoch s>, "s": {"<series>": [frames, events, envelopes, bytes]}}`, one line per second with traffic |
| `windows.jsonl` | Every window added or removed, with its slug, ids, tokens and times |
| `recorder.log` | Connections, rollovers, Gamma polls, disconnects |
| `raw/<series>/<UTC hour>.jsonl.gz` | With `--raw`: `{"t": <receive epoch s>, "p": "<frame text>"}` per inbound frame |

`summary.json`, per series (`perSeries`), per asset (`perAsset`) and in total
(`all`):
- `bytes`, `frames`, `events`, `envelopesEstimate` and their per-second averages; `bytesPerDay` is scaled from the recording's length;
- `peak1sEnvelopesPerSecond`;
- `whole`: p50, p95 and peak of the 10-second rates over the whole recording;
- `atWindowOpens`: the peak and nearest-rank p95 of the 10-second rates. It uses the 10 s buckets from 30 s before to 90 s after each window open, for opens whose whole interval was recorded. `all.atAlignedOpens` uses only the quarter-hour opens, when every 5- and 15-minute series opens at once;
- `connections`: connects, disconnects, stale closes and close reasons per series;
- `gamma`: polls, failures and skipped markets;
- `windows`: every window with its own totals and event types;
- `rawFrames`: raw text bytes against gzip file bytes, with `--raw`.

Definitions that matter when you read the numbers:
- **Bytes** are the UTF-8 text of each WebSocket message. TLS, WebSocket framing and TCP/IP headers are excluded. The host sampler's interface counters give the real inbound traffic.
- **`envelopesEstimate`** counts one per `price_changes` entry and one per other event. That is how the gateway normalizes (`BookLevelChanged` per level, `BookSnapshot` per `book`, `PublicTradeObserved` per `last_trade_price`). It is the market-channel part of the trader's input rate. The Binance, Coinbase and Chainlink reference feeds are not recorded here.
- **A window open** is the market's `eventStartTime`.

What it does not do:
- It does not run the gateway, Redis or the trader.
- It does not record the reference feeds. H1 measured them at about 6 GB a day per asset (`docs/handoffs/LEAN-1.md` §4).
- It assumes nothing undocumented: no server `PING` timeout (U-2) and no maximum `assets_ids` (U-3). Each connection subscribes 4 tokens.

### Compression ratios (LEAN-1 §9 item 3)

The recorder's `rawFrames` gives gzip level 6 on the JSONL files. For zstd, recompress one hour:

```sh
f=~/pmb-host-bench/recording/raw/btc-up-or-down-15m/<hour>.jsonl.gz
zcat "$f" | wc -c
zcat "$f" | zstd -3 -c | wc -c
zcat "$f" | zstd -19 -T0 -c | wc -c
```

## The host sampler

```sh
python3 tools/bench/host/host_sampler.py sample --out-dir ~/pmb-host-bench/host \
  --interval 60 --duration-hours 24 --path / --path-label wsl-root --windows --raw-commands
python3 tools/bench/host/host_sampler.py summarize ~/pmb-host-bench/host/host-samples.jsonl
```

One JSON line per minute:
- CPU busy, iowait and steal, overall and per virtual CPU;
- load average;
- `/proc/meminfo` (MiB) and pressure stall information (`/proc/pressure`);
- per-disk read and write rates and utilization;
- per-interface network bytes;
- free space of each `--path`, under its label;
- RSS of `node`, `postgres`, `redis-server`, `python3`, `dockerd` and `containerd`.

With `--windows` it also records, from Windows:
- `PercentProcessorPerformance` (under 100 under load is a throttling sign) and `ProcessorFrequency`;
- the thermal zones, with `PercentPassiveLimit` and `ThrottleReasons` when the firmware exposes them;
- free physical memory and the `vmmemWSL` working set;
- the battery status (2 = on AC);
- every adapter's received and sent bytes.

Every query uses a WMI class or a cmdlet, never a localized counter path.
`--raw-commands` appends `vmstat`, `iostat`, `free` and `df` text to
`host-raw.log`, with the host name and home directory replaced. The sampler
records no host name, user name or IP address.

`summarize` prints min, mean, p95 and max of each reading, and disk and
network totals. It lists every gap longer than twice the interval, which is a
suspend, a WSL restart or a clock jump.

## The trader bench table

```sh
python3 tools/bench/host/bench_table.py ~/pmb-host-bench/trader-throughput
```

It prints one row per run, labelled with the run's `--out-dir` name. It adds
min, median and max per group (`catch-up-1` .. `catch-up-3` form `catch-up`),
excluding CPU-profiled runs.
