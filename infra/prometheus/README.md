# Prometheus configuration fragments

| File | Owner | Purpose |
| --- | --- | --- |
| `recorder-scrape.yaml` | `WP-140` | Scrape jobs for the recorder (`apps/data-gateway`) and the compaction worker (`apps/research-worker`), plus the `rule_files` hookup. Read its header: the exporter wiring into the apps is a disclosed follow-up, and targets must stay loopback/private (handoff §15). |
| `recorder-alerts.yaml` | `WP-140` | Alert rules for the recorder. Two alarms are deliberately log-based, not PromQL — the header names them; `docs/runbooks/recorder.md` explains every alarm and the operator action. |

Both files are validated by
`packages/observability/src/recorder/infra-consistency.test.ts`: every
`recorder_*` series an alert references must be one the exporter emits, and
the declared alert-name set must match the expected set EXACTLY in both
directions — a renamed alert fails as missing and as unexpected at once.
