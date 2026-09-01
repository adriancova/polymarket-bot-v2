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
| `PMB_GATEWAY_REDIS_PORT` | `6379` | host port for the compose Redis |

**Retention is a safety parameter, not a tuning knob** (ADR-003). Retention
shorter than the worst tolerated trader restart turns an ordinary restart into
a hard resync plus an authoritative-snapshot cycle.

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

## Safety

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are
untouched by this app. The gateway holds no signer, submits no order, and has
no code path that could.
