# Recorder dashboard (WP-140)

`recorder-dashboard.json` is a Grafana dashboard for the Wave 1 recorder: the
Market Data Gateway (`WP-120`) and the compaction pipeline (`WP-130`). Import
it into Grafana (Dashboards → Import) and point the `Prometheus` datasource
variable at the instance scraping `infra/prometheus/recorder-scrape.yaml`.

It is **code, not decoration**: a test
(`packages/observability/src/recorder/infra-consistency.test.ts`) parses this
JSON and asserts that

- every `recorder_*` series referenced by a panel is a metric the exporter
  (`packages/observability/src/recorder/render.ts`) actually emits, and
- each acceptance-1 signal — queue depth, lag, gaps, fsync, compaction,
  upload status — has at least one panel bound to a metric of that category,

so the `WP-140` acceptance criterion "Dashboard exposes queue depth, lag,
gaps, fsync, compaction, and upload status" is machine-checked. Edit the
dashboard and the exporter together or the gate fails.

The only non-`recorder_*` series used is Prometheus's own `up` (the
process-exit alarm view). The "recorder FAILED to exit" signal is a **log
line**, not a metric — see `docs/runbooks/recorder.md`, "Forced-exit
signals".

Wiring status is disclosed in `infra/prometheus/recorder-scrape.yaml`: no
process serves these metrics yet; the exporter is wired by a follow-up
recorded in `docs/handoffs/WP-140.md`.
