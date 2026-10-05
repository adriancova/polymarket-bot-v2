# Control-plane Grafana dashboards (`WP-240`)

Three dashboards for a **PAPER** deployment. They are read-only views: nothing
here is a control, and the control API they read from cannot raise a run mode,
enable real orders, raise a live-micro cap, or reach a signer — those inputs are
not representable in its request grammar.

| File | Title | Reads |
| --- | --- | --- |
| `operations-dashboard.json` | Polymarket bot — operations (paper) | the trader health report the control API holds, plus the control plane's own state and (`CONTROL-2`) the open trader halts it reads from `ops.incidents` — the "Open trader halts (ops.incidents)" panel, whose rows outlive a trader that halted and exited |
| `trading-dashboard.json` | Polymarket bot — trading (paper) | the trader health report: decisions, risk, execution, accounting |
| `fidelity-dashboard.json` | Polymarket bot — fidelity (paper) | `WP-140`'s recorder exporter, plus three panels with no producer yet |

## Where the data comes from

```text
apps/trader             HealthSnapshot (apps/trader/src/health.ts)
      │                 five seam sections + observeOnlyIntents + halts
      │                 + risk refusal counts + riskSeamCaveat
      │  (composition obligation — see below)
      ▼
apps/control-api        TraderHealthSource → the health DOOR (ADR-020 D1-D4)
      │                 → packages/observability traderHealthSamples()
      │                 → renderExpositionFor(PLATFORM_METRIC_FAMILIES, …)
      ▼
GET /v1/metrics         Prometheus text exposition (authenticated; loopback)
      ▼
Prometheus  ─────────►  these dashboards

apps/data-gateway  ──►  recorder exporter (WP-140)  ──►  Prometheus
                                                          │
                        the fidelity dashboard's dataset  ┘
                        and staleness panels
```

### The composition obligation, stated plainly

**`apps/trader` does not expose an HTTP health endpoint today.** Its health
state is an in-process value, and `apps/trader/**` is outside `WP-240`'s grant,
so this package could not add one. Two bindings exist here:

- `InMemoryTraderHealthSource` — used by the suites, and by any composition that
  already holds a snapshot;
- `HttpTraderHealthSource` — a loopback `GET` of a JSON health document, proven
  against a real in-process `node:http` server in
  `apps/control-api/src/health-source.test.ts`.

Wiring the second to a running trader requires the trader to serve that
document. **That is a documented obligation on a future `apps/trader` grant, not
a claim that it exists.** Until it does, `control_trader_health_available` reads
`0` and the operations dashboard's first stat panel says so — which is why that
panel is placed before every `trader_*` panel on the page.

## Metrics

Every `trader_*` and `control_*` series is declared in
`packages/observability/src/control/metric-families.ts` and produced by
`samples.ts`. `metric-families.test.ts` asserts the table and the producer cover
each other exactly, so a name on a panel here always has something behind it.

`recorder_*` series are `WP-140`'s and are declared in
`packages/observability/src/recorder/metric-families.ts`.

### Economics are never sample values

A Prometheus sample value is a float64. Prices, sizes, balances, fees and PnL
are exact decimals (§6 invariant 1), so no family carries one as a value.
Where an exact decimal must be visible it is a **label** on an `_info` gauge
whose value is the constant `1`:

```text
trader_seam_reservations_reserved_collateral_info{exact_decimal="0.30"} 1
```

The dashboards display these labels and never chart, sum or `rate()` them; the
dashboard suite asserts that no panel applies a PromQL function to an `_info`
family. The same exact strings are on the control API's JSON read surface.

## Panels that ship PENDING

Three panels have **no producer in this repository** and say so, in the panel
itself, with the owner named. They are Grafana text panels beginning
`PENDING PRODUCER:` and containing `— OWNER:`; the suite requires that set to
match `PENDING_PRODUCER_PANELS` exactly, in both directions.

| Dashboard | Panel | Waiting on | Owner |
| --- | --- | --- | --- |
| trading | Realized PnL | an exact-decimal PnL value on the trader health surface (only a record COUNT exists today) | a future `apps/trader` grant |
| fidelity | Replay determinism | a determinism indicator from whatever executes a replay; today `pnpm test:replay` proves it as a gate and emits no metric | a future `packages/simulation` or `apps/backtest-cli` grant |
| fidelity | Predicted versus actual fills | §12.2's execution-calibration model, which needs `EXECUTION_PROBE` data that may not exist under `MAX_RUN_MODE=PAPER` | `WP-290` / phase-4 execution probes |
| fidelity | Markout | §12.3 markout export as a time series | a future `packages/simulation` or `apps/research-worker` grant |

Inventing a metric family for any of these would put a name in the exporter with
nothing behind it, and a blank panel is indistinguishable from a quiet system.

## Importing

These are plain dashboard JSON documents with one `datasource` template
variable (`DS_PROMETHEUS`). Import them into Grafana and select the Prometheus
data source that scrapes the control API and the recorder. `editable` is
`false`: the repository copy is the source of truth, and an edit made in the UI
is an edit the dashboard suite never sees.

## Safety

- No production secret name (ADR-010 §3) appears in any of these files; the
  suite scans for every enumerated name.
- No panel title, link, or template variable carries a live-mode control token
  (`enable live`, `allow_real_orders`, `max_run_mode`, `signer`, …); the suite
  scans the control-bearing fields for the whole enumerated list.
- The only template variable is the datasource selector. A `textbox` or `custom`
  variable would be a place an operator could type a value that reached a query,
  and the suite refuses one.
- No `annotations`, `links` or panel `url` field points anywhere: nothing here
  navigates to a control surface.
