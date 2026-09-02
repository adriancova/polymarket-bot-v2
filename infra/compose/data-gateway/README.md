# Data gateway — local operation

Owner: `WP-120` (`apps/data-gateway`).

This directory holds the compose fragment and an example configuration for
running the Market Data Gateway and Recorder on a developer machine. It is
**not** used by any test: the gateway's integration suite runs entirely
offline against injected in-memory transports and scripted sockets.

## What runs where

| Concern | Local operation | Tests |
| --- | --- | --- |
| Event-bus transport | Redis, from `compose.yaml` (or the root `docker-compose.yml`) | in-memory `MarketEventTransport` with failure injection |
| WAL | a real directory under `wal.rootPath` | the `WP-050` in-memory filesystem |
| Venue sockets | the real public endpoints | scripted doubles on the adapters' injected ports |

Acceptance 4 ("Redis outage stops publication but not WAL recording") is
exercised through the transport **interface**, not against a real server — the
boundary under test is the gateway's, and the Redis implementation has its own
Testcontainers suite in `test/integration/event-bus`.

**Redis is not required to start.** If the transport is unreachable at startup,
the gateway still opens the WAL and starts every public feed; publication goes
straight into the terminal halt described below, and recording continues. A
recorder restarted during a Redis outage records everything.

## Running it

```bash
docker compose -f infra/compose/data-gateway/compose.yaml up -d

GATEWAY_CONFIG_PATH=infra/compose/data-gateway/gateway.config.example.json \
  pnpm --filter @polymarket-bot/data-gateway start
```

`start` typechecks, bundles with esbuild, and runs the bundle. The esbuild step
is required: the repository has no runtime build story for TypeScript workspace
imports (`tsc && node dist` fails with `ERR_MODULE_NOT_FOUND`), and this follows
the `apps/research-worker` precedent established by `WP-130`.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_CONFIG_PATH` | *(required)* | JSON file matching `GatewayConfigSchema` |
| `GATEWAY_REDIS_URL` | `redis://127.0.0.1:6379` | transport connection |
| `GATEWAY_RETENTION_EVENTS` | `100000` | transport retention bound |
| `GATEWAY_CLEANUP_DEADLINE_MS` | `10000` | hard deadline (milliseconds) for both cleanup paths — fatal startup and signal shutdown; a whole number from `100` to `2147483647`; unset or empty means the default; any other value refuses startup with exit 1 |
| `PMB_GATEWAY_REDIS_PORT` | `6379` | host port for the compose Redis |

**Retention is a safety parameter, not a tuning knob** (ADR-003). Retention
shorter than the worst tolerated trader restart turns an ordinary restart into
a hard resync plus an authoritative-snapshot cycle.

**The cleanup deadline is a safety parameter too.** If a resource's cleanup
hangs or fails while holding a referenced handle, the process force-exits
nonzero when the deadline expires (stderr shows `cleanup deadline … expired`)
instead of wedging. On a forced exit, disposal may be incomplete: treat the
WAL tail as crash-recovered — the next start recovers it (the `WP-050`
recovery shape) and nothing manifested is lost. The value is validated
fail-closed at startup: below `100` the deadline would race cleanups that are
completing normally (OS/event-loop jitter), and outside Node's timer range
(`1`–`2147483647` ms) the runtime silently coerces the delay to an effectively
immediate timer — either way the "fallback" would punish healthy cleanups, so
such values are refused before any resource is acquired.

## Configuration notes

- `streamName` must be **stable across restarts**. The transport keys durable
  consumer checkpoints, resync state, and lag metrics by it; a per-boot name
  would orphan every checkpoint on every restart. The schema refuses a
  UUID-shaped name for that reason.
- `markets` is **reviewed configuration**, not discovery (§9.2). A market
  announced on the wire that is not configured here is observed, counted, and
  reported — never adopted: the venue documents no pairing rule between
  `assets_ids` and `outcomes`, so nothing can decide which token is YES.
- The example market is a placeholder and is deliberately not a reviewed one.
- The gateway consumes **public, unauthenticated market data only**. There is
  no credential field anywhere in the schema, and the schema is strict, so one
  cannot be added by configuration.
- `tickIntervalMs` **must be at or below** `wal.fsyncIntervalMs` (default
  `1000`), and the schema now refuses a configuration where it is not. The WAL
  writer schedules nothing: an idle recorder is fsynced only by this tick, so a
  slower tick would make the `dataLossBoundMs` the writer publishes a false
  claim.
- `publisher.maxQueueDepth` (default `1024`) and `publisher.maxQueueBytes`
  (default `8388608`) bound how much unpublished work the gateway will hold in
  memory while the transport is slow. They are **safety parameters, not
  throughput knobs**: raising them buys tolerance for a longer transport stall
  and costs memory plus a longer window of events that exist only in the WAL.
  Crossing either bound is a terminal publication halt, never a drop.

## When publication halts: the operator procedure

Publication in this gateway is **terminal for the epoch**. There is no
automatic resume, by design: the events assigned during an outage were never in
the stream, and resuming mid-epoch would hand consumers a gap the transport
cannot detect, because its resync arithmetic watches its own publication
ordinals rather than `ingestSeq`. A restart mints a new epoch and a fresh
authoritative-snapshot obligation, which is the §7.1 recovery path.

**Recording is unaffected by any of this.** The WAL path does not run through
the publisher, so a halted gateway is still doing the job in §0.1. Do not kill
a halted recorder in a hurry; the frames it is writing are the ones that cannot
be re-fetched later.

You will see one PAGE incident, on stderr through the observer (which keeps
working when the transport does not) and, when the bus is reachable, in the
stream:

| Reason code | What happened | What to do |
| --- | --- | --- |
| `GATEWAY_TRANSPORT_UNAVAILABLE` | the event bus was unreachable — at startup or mid-run | bring Redis back, confirm it, then restart the gateway |
| `GATEWAY_PUBLISH_QUEUE_FULL` | WP-060's producer queue saturated (`EVENT_BUS_PUBLISH_QUEUE_FULL`) | find why the bus stopped draining; restart the gateway after |
| `GATEWAY_PUBLISH_ADMISSION_OVERFLOW` | THIS gateway's admission queue filled: the transport was accepting nothing for long enough to reach `publisher.maxQueueDepth`/`maxQueueBytes` | same as above; raise the bounds only with a reason, and know it costs memory |
| `GATEWAY_PUBLISH_REJECTED` | the transport refused an envelope for a non-outage reason (schema, ordering) | this is a **gateway-side defect** — capture the detail and the WAL segment, then restart; the frames are all on disk |
| `RTDS_UNRECOVERABLE_GAP` | the RTDS TWAP stream broke; the venue offers no replay, so normalized RTDS publication halted for the epoch | restart to begin a new observation window; the unobserved interval is permanently unobserved and TWAP-dependent consumers must halt (ADR-009 §6) |

The procedure, in order:

1. **Do not restart first.** Read `metrics().publisher` — `halt.cause`,
   `halt.haltedAtIngestSeq`, `queueMaxDepthObserved`, `oldestQueuedAgeMs` — and
   the incident detail. They say which of the five rows above you are in.
2. **Confirm recording is healthy**: `metrics().wal.state` should be `open`,
   `metrics().wal.queue.messagesDropped` must be `0`. If `state` is `faulted`
   you have a *second*, worse incident (`GATEWAY_WAL_WRITE_FAULT`) and the disk
   is the priority.
3. **Fix the cause.** For the first three rows that means the event bus; for
   `GATEWAY_PUBLISH_REJECTED` it means a defect report, not a config change.
4. **Restart the process.** `SIGINT`/`SIGTERM` shuts down cleanly: in-flight
   drains settle, the active segment is finalized with a footer and a manifest,
   and the transport closes. Kill only if that hangs.
5. **Expect a new epoch.** The restarted gateway writes a NEW
   `<walRoot>/<gatewayEpoch>` directory and restarts `ingestSeq` at 1. That is
   correct: the epoch is the other half of the ordering identity. Consumers
   resume on the same `streamName`, and each takes a fresh authoritative
   snapshot before acting.
6. **Nothing recorded during the halt is lost.** The WAL segments written while
   publication was halted are complete and manifested, and `WP-130` compacts
   them like any others. What was lost is the *live* publication of those
   events, which is what the halt exists to make visible.

## Safety

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are
untouched by this app. The gateway holds no signer, submits no order, and has
no code path that could.
