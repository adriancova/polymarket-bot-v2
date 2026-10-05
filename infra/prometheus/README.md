# Prometheus configuration fragments

| File | Owner | Purpose |
| --- | --- | --- |
| `recorder-scrape.yaml` | `WP-140` | Scrape jobs for the recorder (`apps/data-gateway`) and the compaction worker (`apps/research-worker`), plus the `rule_files` hookup. Read its header: the exporter wiring into the apps is a disclosed follow-up, and targets must stay loopback/private (handoff §15). |
| `recorder-alerts.yaml` | `WP-140` | Alert rules for the recorder. Two alarms are deliberately log-based, not PromQL — the header names them; `docs/runbooks/recorder.md` explains every alarm and the operator action. |
| `trader-alerts.yaml` | `CADENCE-1` | Alert rules on the trader's `trader_*` families: `TraderCadenceForwardJump` (`severity: page`), the ADR-026 D2.10 forward-jump alarm — a far-future event stamp holding every `onFeatures` evaluation. Add it to `rule_files` beside the control-api job. The trader logs the same alarm as `CADENCE CLOCK FORWARD JUMP: …`. Validated by `packages/observability/src/control/trader-alerts.test.ts`: every series it references is a declared platform family, and the alert-name set matches exactly. |
| `control-api-scrape.yaml` | `TRDR-3` | The ONE scrape job for `apps/control-api`'s authenticated `GET /v1/metrics` — the producer of every `trader_*` / `control_*` series the `infra/grafana/control/` dashboards bind (the control API reads the trader's loopback `GET /health` on that same request). Read its header: the READ-grant operator token comes from a deployment-provided `credentials_file` and is never committed; the example config's `bindPort` 9465 collides with the compaction worker's target above; and loading this into a real Prometheus is GOV-2B R5 / human item H3, not a claim this file makes. |

The two `WP-140` files are validated by
`packages/observability/src/recorder/infra-consistency.test.ts`: every
`recorder_*` series an alert references must be one the exporter emits, and
the declared alert-name set must match the expected set EXACTLY in both
directions — a renamed alert fails as missing and as unexpected at once.

`trader-alerts.yaml` is validated the same way by
`packages/observability/src/control/trader-alerts.test.ts`, against the
platform family table (`PLATFORM_METRIC_FAMILIES`).

> **Corrected 2026-10-04 (`GOV-NOTES-2`): what `CONTROL-2` added to
> `trader-alerts.yaml` and `control-api-scrape.yaml`.** `CONTROL-2` merged as
> `2f84ad7` on 2026-10-04. Its record is `docs/handoffs/CONTROL-2.md`. The
> two rows above predate it.
>
> - **A second rule group.** `trader-alerts.yaml` now holds the group
>   `trader-halts`, with one alert: `TraderHaltOpenOrUnknown`
>   (`severity: page`, `for: 0m`). It fires when `control_trader_halts_state`
>   is 1 for `OPEN` or `UNKNOWN`. `NONE_OPEN` and `NOT_CONFIGURED` do not
>   page.
> - **The family it reads.** `control_trader_halts_state` is a control API
>   family, not a trader one.
>   - It is a gauge with a `state` label: 1 for the current state, 0 for the
>     other three.
>   - It reports the control API's own read of the open `TRADER_HALT:*` rows
>     in `ops.incidents`. With `traderHalts` configured as `none`, it reports
>     `NOT_CONFIGURED`.
>   - Its producer is `traderHaltSamples` (`apps/control-api/src/trader-halts.ts`).
>     It is a `PLATFORM_METRIC_FAMILIES` entry, beside
>     `control_trader_halts_open` and `control_trader_halt_reads_total`.
> - **The scrape timeout.** The `control-api` job states
>   `scrape_timeout: 10s`. Keep it above the control API's answer deadline,
>   `READ_REFRESH_DEADLINE_MS` (8 s, `apps/control-api/src/api.ts`).
>   - An authorized `/v1/metrics` answers within that deadline. A halt read
>     still running then is answered `UNKNOWN`, which pages.
>   - A scrape that timed out first would be abandoned, so the alert could
>     not fire.
>   - The halt read's own bound is at most `TRADER_HALT_READ_TIMEOUT_MAX_MS`
>     (5 s, `apps/control-api/src/adapters/postgres-trader-halts.ts`).
>   - `test/integration/control-api/trader-halt-shape.test.ts` pins the three
>     values, 5 s, 8 s and 10 s, with at least 2 s between each and the next.
>     It also pins the timeout at or below the 15 s `scrape_interval`.
> - **Validation.**
>   - `trader-alerts.test.ts` holds the new alert to the expected alert-name
>     set and to the declared families.
>   - `trader-halt-shape.test.ts` pins its group, expression, severity and
>     `for`. It also evaluates the rule against the metrics the control API
>     renders in each of the four states: it fires on `OPEN` and `UNKNOWN`
>     only.
