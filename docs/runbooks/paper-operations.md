# PAPER operations

One page for a PAPER burn-in: the data gateway publishes into Redis, the trader
consumes it and writes PostgreSQL, and the control API reads. Details stay where
they are owned; this page gives the order and links to them.

**Safety.** `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`. The
trader and the control API check them at startup and refuse a weakened value;
the data gateway places no orders and only reads its run mode. Nothing here
needs or accepts a credential, signer or wallet.

## Before a burn-in

A rolling-series burn-in starts from two shipped examples, not from the market-list ones:
[`trader.series.example.json`](../../infra/compose/trader/trader.series.example.json) and
[`gateway.series.example.json`](../../infra/compose/data-gateway/gateway.series.example.json).
Both carry the same reviewed `btc-15m-updown` document; a test pins that they agree.

- **Copy both.** Mint the instance's ids with `register --series`, whose template has no `instanceId`,
  `runId` or `configId`. Delete those three keys from the copy by hand (or
  `node -e` / `jq 'del(.seriesInstances[0].instanceId, .seriesInstances[0].runId, .seriesInstances[0].configId)'`).
  Every later start needs a new run: `register --new-run <instanceId>`
  ([`apps/trader/README.md`](../../apps/trader/README.md); the series form is in `register --help`).
- **An older config is refused at startup (exit 78).** The `COMPLEXITY-1` changes are:
  - Static Bracket entry: `FAK` and `FOK` are refused, `SB_IMMEDIATE_ORDER_TYPE_PARKED_UNTIL_EXECUTION_PROBE`;
    `GTC` too, `SB_IMMEDIATE_ORDER_TYPE_GTC_NEEDS_DEADLINE_CANCEL`. Use `GTD` with an explicit `order_validity_ms`.
  - `riskPolicy.limits.*ExposureCap`: refused `TRADER_RISK_POLICY_REFUSED`. State each cap in `allocatorCaps`.
  - `simulation.startingCash` and `infrastructure.retentionMaxEvents`: refused `TRADER_CONFIG_INVALID`.
    The venue opens with `accounting.startingCash`.
  - The halt `action` field: a halt record or health snapshot that carries one is refused. No config states it.
  - Details: [`apps/trader/README.md`](../../apps/trader/README.md), "Configuration changes in `C1-RISK`".
- **Protocol V2.** New markets switch to V2 about 2026-11-02. Keep `acceptedProtocolVersions`
  `["v1","v2"]` in the review (both examples do), or the gateway refuses V2 windows
  (`docs/handoffs/V2-3.md`, item 3).
- **The stack.** Start Redis and PostgreSQL from [`infra/compose/paper`](../../infra/compose/paper/compose.yaml) (section 1).
- **The review is a sample.** Its `reviewedBy` is `sample-reviewer`; no human has reviewed the series' settlement.
  Both reviews set `modelDependentActivationAllowed: true`, the owner's PAPER-only ruling of 2026-10-05
  ([why](../../infra/compose/trader/README.md)). With `false` the risk engine refuses every entry,
  `RISK_SETTLEMENT_UNVERIFIED`, and the burn-in places no order.

## 1. Start, in this order

From the repository root. One stack serves every process,
[`infra/compose/paper/compose.yaml`](../../infra/compose/paper/compose.yaml), on
its own project and ports, so the root stack's `pnpm test:compose` cannot stop it.

```bash
# 1. Redis (127.0.0.1:56379) and PostgreSQL 16.6 (127.0.0.1:55432).
docker compose -f infra/compose/paper/compose.yaml up -d --wait
export REDIS_URL=redis://127.0.0.1:56379
export DATABASE_URL=postgres://devlocal:devlocal-only-not-a-secret@127.0.0.1:55432/polymarket_bot_paper

# 2. The schema.
pnpm --filter @polymarket-bot/storage-postgres db:migrate

# 3. The gateway. Wait for its "data-gateway running: epoch …" line.
GATEWAY_REDIS_URL=$REDIS_URL GATEWAY_CONFIG_PATH=/path/to/gateway.json \
  pnpm --filter @polymarket-bot/data-gateway start
```

4. **Register a new run** for the trader: every start needs one (`BOOT-1`).
   See [`infra/compose/trader/README.md`](../../infra/compose/trader/README.md),
   "Registering the run first".
5. **Start the trader** on the document the registration wrote:

   ```bash
   MAX_RUN_MODE=PAPER ALLOW_REAL_ORDERS=false \
   LIVE_MICRO_MAX_ORDER_NOTIONAL=0 LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0 \
   TRADER_CONFIG_PATH=/path/to/trader.config.json \
   TRADER_HEALTH_BIND=127.0.0.1 TRADER_HEALTH_PORT=9470 \
     pnpm --filter @polymarket-bot/trader start
   ```

6. **Optionally, the control API** ([`apps/control-api/README.md`](../../apps/control-api/README.md),
   "Running it"), with `traderHalts` `postgres` and `traderHealth` at the
   trader's health port. It only reads: its `POST` routes answer `501`.

Gateway configuration: [`infra/compose/data-gateway/README.md`](../../infra/compose/data-gateway/README.md).
A gateway banner ending `PUBLICATION HALTED, RECORDING ONLY` means Redis was
unreachable: fix that before starting the trader. The old per-app stacks are
gone; their PostgreSQL 17.5 volume cannot be opened by 16.6, so this stack
starts empty.

## 2. Stop

Stop the trader first, then the gateway. Press **Ctrl-C** or send **SIGTERM**
to each.

- **The trader** stops in order and prints `trader stopped: exit <code> — …`.
  A **second** signal forces exit `130`; a stop past
  `TRADER_SHUTDOWN_DEADLINE_MS` (default 8,000 ms) exits `124`. Under `pnpm`,
  the trader's own code is hidden: run `node apps/trader/dist/main.mjs` to see it.
- **The gateway** finalizes its WAL segment and exits `0`. If its cleanup
  hangs, it is forced out at `GATEWAY_CLEANUP_DEADLINE_MS`; see
  [`recorder.md`](recorder.md) §1-§2.
- **The stack:** `docker compose -f infra/compose/paper/compose.yaml stop`.
  Never `down -v`: it deletes the volumes.

## 3. The trader's exit codes

| Exit | Meaning | Action |
| --- | --- | --- |
| `0` | A clean stop. No halt is latched, and the shutdown check matched. | None. Register a new run to continue. |
| `78` | Refused at startup: the environment is unsafe, the configuration is invalid, or the registration is missing. | **Fix and restart.** The log names the field. |
| `69` | PostgreSQL or Redis was unreachable at startup. | **Fix and restart.** Bring the stack up (§1), then start again. |
| `75` | A halt is latched. | **Halt response** (§4). |
| `124`, `130` | The stop was late or forced. The `SHUTDOWN …` line names any latched halt. | If the line names a halt, follow **halt response**. Otherwise register a new run. |
| `70` | The shutdown rebuild check failed (`ACCOUNTING_REBUILD_MISMATCH`). | **Defect.** Keep the database as it is, report it with the log, and do not reuse the run. |

## 4. Halt response

**Every halt ends the run.** The trader makes no further decision and exits
`75`; nothing resumes a halted run.

1. **Read the halt** on stderr first. It is also an open `TRADER_HALT:*` row in
   `ops.incidents` (§6) when the record landed. If stderr says `HALT RECORD NOT
   DURABLE` or `UNCONFIRMED` (for example, PostgreSQL was down), keep the logs:
   they are the only record.
2. **Fix the cause** the halt names.
3. **Register a new run and start it** (§1, steps 4-5).

A halted **gateway** differs: publication is terminal for the epoch, but
**recording continues** ([`recorder.md`](recorder.md) §3).

## 5. Restart after a Redis or gateway outage: gateway first

A Redis outage longer than about 1 s (connection refused) or 5 s (stalled)
ends the gateway epoch's publication and also the trader run
(`TRANSPORT_UNAVAILABLE`, exit `75`). Restart in this order:

1. **Redis.** Run `docker compose -f infra/compose/paper/compose.yaml up -d --wait`.
2. **The gateway.** Stop it, then start it ([`recorder.md`](recorder.md) §3).
   It opens a new epoch. Wait for its running line.
3. **A new trader run** (§1, steps 4-5), only once the gateway publishes.
4. **Check the old run's halt row** in `ops.incidents` (§6). While it is
   open, `TraderHaltOpenOrUnknown` keeps firing.

Known gap: until a separate round's restart change lands, a new trader run can
halt again right after it starts. If it does, read that halt (§4) first.

**Why the Redis latch is kept.** Revisit that decision if any of these happens:

- the burn-in records 2 or more Redis-caused `TRANSPORT_UNAVAILABLE` halts;
- the restart and resume design (R10) is done, before any mode above PAPER;
- the trader halts `TRANSPORT_UNAVAILABLE` while the gateway kept publishing.
  That points to a trader-side stall or network fault, which is the one case
  where a trader-only wait-and-resume would pay off.

## 6. Where health and halts are read

| What | Where |
| --- | --- |
| Trader halts and exit | Trader stderr: the halt lines and the final `trader stopped: exit <code> — …`. |
| Halts that outlive the trader | `ops.incidents`, the open `TRADER_HALT:*` rows, when the record landed (stderr says otherwise). The control API reads them on `GET /v1/health` and `/v1/metrics` (`control_trader_halts_state`; the alert is `TraderHaltOpenOrUnknown`). |
| Trader health | `GET /health` on `TRADER_HEALTH_BIND:TRADER_HEALTH_PORT`, which the control API relays. |
| Gateway incidents and halts | Gateway stderr: `[incident]`, `[halt]` and `[wal]` lines ([`recorder.md`](recorder.md) §2). The gateway serves no `/metrics` yet. |
| Dashboards | `infra/grafana/control/`, through the control API scrape (`infra/prometheus/control-api-scrape.yaml`). |

## 7. The series watch (`ROLLOVER-1`)

Watch the gateway's `[incident]` lines for these two:

- **`GATEWAY_SERIES_CAP_REACHED` with awaiting > 0.** The series is at its
  window cap, and some of its live windows are past their bound without a
  resolution. They keep their slots, so no new window is admitted.
- **`GATEWAY_SERIES_WINDOW_UNRESOLVED`.** The gateway reads the window's
  `/v2/resolutions` row every cycle, so a missed `market_resolved` usually
  clears within a poll. Retire the window by name
  (`seriesAdmission.operatorRetirements`, then a restart) only when the
  incident says its row path has **ended**, or when the reads keep failing.
  Retiring the window frees only the gateway's slot. A trader holding that
  window stays at its cap until a new run. Repeated long stalls here are the
  trigger to revisit the held-slot design.

## 8. Live, inert at PAPER

[`emergency.md`](emergency.md) (every venue-touching command refuses at
PAPER), [`reconciliation.md`](reconciliation.md) (no PAPER process composes
the coordinator) and [`signer.md`](signer.md) (no signer is wired) describe live
components. They are not part of the PAPER procedure above.
