# Gateway publish benchmark (`THROUGHPUT-1b`)

H1 run 1 (`docs/handoffs/H1-RUN-1.md`) halted the gateway's publication at a
BTC 15-minute window open. The admission queue filled, 1024/1024, and
publication halted `GATEWAY_PUBLISH_ADMISSION_OVERFLOW`: fail-closed, and
recording continued. This benchmark reproduces that failure and measures the
fix.

## What it drives

- The REAL `GatewayPublisher` (`apps/data-gateway/src/publisher.ts`) over the
  REAL `RedisStreamsEventTransport` (`packages/event-bus/src/redis/`).
- A real Redis: a fresh `redis:7.4.2-alpine` container per offered rate.
- The publisher's DEFAULT admission bounds: 1,024 envelopes and 8 MiB.
- Nothing is mocked. Every envelope passes the publisher's admission (the
  byte bound's encode), its pump, the transport's envelope door, and the
  server-side publish script.

It does NOT drive the rest of the gateway: sockets, frame parsing, the WAL,
`completeEnvelope`. In a live gateway those share the event loop with the
publisher, so the rates below are a ceiling for the publish path, not for the
whole process.

## Input

- The 100,000 normalized envelopes the H1 stream carried at the window open
  (21:02:06–21:04:22Z, a mean of 735 events/s). The fixture is 68.6 MB and
  is not committed. The committed sample
  (`test/integration/data-gateway/fixtures/burst-sample-2026-09-29T2100.jsonl`)
  is 2,800 of them, about 1.8 MB, around the busiest second.
- Each run re-stamps them with one epoch and `ingestSeq` 1..n. Every other
  field and its key order are kept.
- The recording is bursty:
  - 3,107 events in its busiest second;
  - 1,070 in its busiest 250 ms;
  - 67 inside one millisecond.

  A uniform rate hides that, so the benchmark offers load two ways (below).

## Offered load

- `--pacing uniform --rate R`: envelope `i` is due `i / R` seconds after the
  start.
- `--pacing recorded --rate R`: envelope `i` is due at its RECORDED receipt
  instant (`receivedMonotonicNs`), with the timeline scaled to a mean of R.
  - At R = 735 this replays the burst as the gateway received it.
  - At R = 1,500 it is the same burst, 2.04× faster.
- `--rate saturate` measures the unthrottled ceiling. The driver keeps the
  admission queue topped up to half its bound, so the publisher is never idle
  and never overflows. An open-loop unthrottled producer would overflow the
  1,024 bound in its first turn, which measures nothing.
- The driver admits every due envelope synchronously, in order, as the
  dispatcher does, then yields for about a millisecond. Offering stops at the
  first halt.
- `--prefill N` first publishes N envelopes under other epochs, so the
  measured run meets a stream at its retention bound (100,000, the gateway's
  default), and every publish trims, as in a long-running gateway.

## Running it

```bash
tools/bench/gateway/run.sh --fixture <envelopes.jsonl> \
  --rates "735 1500 3000 saturate" --pacing recorded --prefill 100000
```

- It prints one JSON document per rate, with:
  - `sustainedPublishRate`, `overflowed`, `haltCause`, `haltedAtIngestSeq`;
  - `queueMaxDepthObserved` and `queueMaxBytesObserved` (the high-water
    marks);
  - `submissions` (transport round trips; absent on base, whose publisher
    does not report it).
- Other options:
  - `--redis-url` uses an existing server instead of starting containers;
  - `--cpu-prof DIR` writes a V8 CPU profile per rate;
  - `--epoch` and `--stream` fix the identity, so two runs' streams can be
    compared entry by entry.
- To measure base, check out `051d058` in its own worktree, copy
  `tools/bench/gateway/run.sh` and `test/integration/data-gateway/bench/` into
  it, and run the same command there.
- `test/integration/data-gateway/publish-throughput.test.ts` runs the harness
  and this script on the committed sample, so neither can rot.

## Results (2026-09-29)

Host: WSL2 to Docker Desktop, Redis at 127.0.0.1; the H1 probe measured
`PING` at a 0.147 ms median. Node 24.13.0.

- Every run used the full 100,000-envelope fixture, `--prefill 100000`, and
  the default bounds.
- Base is `051d058`; the candidate is this package (`96226ee` onward).
- Two repetitions per side are shown (r2 and r3). A first repetition (r1)
  agreed on every overflow and no-overflow outcome except base uniform
  3,000, which overflowed in r1 at envelope 84,828.

| Offered load | Base r2 | Base r3 | Candidate r2 | Candidate r3 |
| --- | --- | --- | --- | --- |
| 735/s, uniform | no overflow; HWM 23 | no overflow; HWM 26 | no overflow; HWM 29 | no overflow; HWM 25 |
| 1,500/s, uniform | no overflow; HWM 7 | no overflow; HWM 123 | no overflow; HWM 5 | no overflow; HWM 22 |
| 3,000/s, uniform | no overflow; HWM 20 | no overflow; HWM 14 | no overflow; HWM 12 | no overflow; HWM 11 |
| 735/s, recorded (1×, the H1 burst) | no overflow; **HWM 402** | no overflow; **HWM 396** | no overflow; HWM 65 | no overflow; HWM 67 |
| 1,500/s, recorded (2×) | **OVERFLOW** at envelope 73,109 | **OVERFLOW** at envelope 73,210 | no overflow; HWM 175; 1,499.9/s | no overflow; HWM 201; 1,499.9/s |
| 3,000/s, recorded (4×) | **OVERFLOW** at envelope 34,129 | **OVERFLOW** at envelope 35,496 | no overflow; HWM 343; 2,999.4/s | no overflow; HWM 337; 2,999.5/s |
| unthrottled ceiling | **4,021/s** | **4,216/s** | **29,011/s** | **27,877/s** |

Notes on the table:
- HWM is the admission queue's depth high-water mark, out of 1,024.
- Every run that did not overflow published all 100,000 envelopes, at the
  offered rate within 0.1%.
- Each base overflow halted `GATEWAY_PUBLISH_ADMISSION_OVERFLOW` at
  1024/1024.
- The candidate's round trips (`submissions`) per 100,000 envelopes were:
  - uniform: about 99,960 at 735/s, 89,558–94,963 at 1,500/s, and
    40,045–41,306 at 3,000/s;
  - recorded: 36,294–36,815 at 735/s, about 27,000 at 1,500/s, and about
    19,870 at 3,000/s;
  - saturate: 392 (batches of up to 256).

  So batches stay small at a steady load and grow only in bursts.

On the committed sample (2,800 envelopes, a mean of 3,132/s at 1×), recorded
pacing, two runs each:

- at 2×, base overflowed both times, having published 692 and 660;
- at 3×, base overflowed both times;
- the candidate peaked at HWM 42–60 at 2× and 3×.

The committed test replays the sample at 2×.

### Where the time goes (V8 `--cpu-prof`, no prefill)

- **Base, closed loop:** 100,000 envelopes in 23.1 s, 231 µs each.
  - 52.9% idle: waiting on one round trip per envelope (about 124 µs).
  - `RedisStreamsEventTransport.publish` 29.3% (69 µs):
    - the envelope door, `encodeEnvelope`, 14.4% (34 µs): own-data copy,
      zod parse, encode;
    - the socket write, `sendCommand`, 12.6% (30 µs), of which the native
      `writeUtf8String` is 10.5% (25 µs);
    - `ioredis`'s per-command timers 2.3%.
  - The publisher's admission byte count 4.4% (10 µs).
  - The harness 7.9%, GC 1.5%.
- **Base at 1,500/s recorded:** it overflowed while **81.3% idle**. The
  limit is not CPU but the serialized per-envelope round trip. During a
  burst, the pump moves one envelope per round trip while hundreds arrive.
- **Candidate, closed loop:** 100,000 envelopes in 3.62 s, 36 µs each.
  - 0.5% idle: CPU-bound on per-envelope work this package does not change:
    - the transport's door 22.0%;
    - the admission byte count 19.5%;
    - the harness's admission loop and parse.
  - The socket write is now 4.6%: one write per batch, not per envelope.
- **Candidate at 1,500/s recorded:** 91.8% idle.

### Fail-closed, unchanged

Base and candidate were both run at 1,500/s uniform on 20,000 envelopes,
with the Redis container paused (a literal `docker pause`) for 3 s mid-run.
Both behaved identically:

- the admission queue filled to 1024/1024;
- publication halted `GATEWAY_PUBLISH_ADMISSION_OVERFLOW` at the last
  envelope offered;
- 1,025 envelopes were not published: 1,024 queued plus the refused one;
- after the pause, the stream was the contiguous prefix `1..published`,
  ending before the halt.

`publish-throughput.test.ts` pins the same behaviour with a frozen TCP hop.
That is the `docker pause` shape from the client's side.
