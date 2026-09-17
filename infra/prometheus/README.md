# Prometheus configuration fragments

| File | Owner | Purpose |
| --- | --- | --- |
| `recorder-scrape.yaml` | `WP-140` | Scrape jobs for the recorder (`apps/data-gateway`) and the compaction worker (`apps/research-worker`), plus the `rule_files` hookup. Read its header: the exporter wiring into the apps is a disclosed follow-up, and targets must stay loopback/private (handoff §15). |
| `recorder-alerts.yaml` | `WP-140` | Alert rules for the recorder. Two alarms are deliberately log-based, not PromQL — the header names them; `docs/runbooks/recorder.md` explains every alarm and the operator action. |
| `control-api-scrape.yaml` | `TRDR-3` | The ONE scrape job for `apps/control-api`'s authenticated `GET /v1/metrics` — the producer of every `trader_*` / `control_*` series the `infra/grafana/control/` dashboards bind (the control API reads the trader's loopback `GET /health` on that same request). Read its header: the READ-grant operator token comes from a deployment-provided `credentials_file` and is never committed; the example config's `bindPort` 9465 collides with the compaction worker's target above; and loading this into a real Prometheus is GOV-2B R5 / human item H3, not a claim this file makes. |

The two `WP-140` files are validated by
`packages/observability/src/recorder/infra-consistency.test.ts`: every
`recorder_*` series an alert references must be one the exporter emits, and
the declared alert-name set must match the expected set EXACTLY in both
directions — a renamed alert fails as missing and as unexpected at once.
