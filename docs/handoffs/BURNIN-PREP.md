# BURNIN-PREP: a ready-to-use PAPER series burn-in configuration

**Status:** Complete. Merge: via PR #— (the orchestrator fills it).
**Base:** `d03da95`.
**Paths:** two new example configs, one test, two README pointer lines, `docs/runbooks/paper-operations.md`, this handoff and its INDEX row. No code under `apps/` or `packages/`.

## summary
1. **Trader example.** `infra/compose/trader/trader.series.example.json`: PAPER, `markets: []`, `instances: []`, one `btc-15m-updown` review, one Static Bracket `seriesInstances` entry (GTD, `order_validity_ms` 30000, `allocatorCaps`). Everything else is copied from `trader.config.example.json`.
2. **Gateway example.** `infra/compose/data-gateway/gateway.series.example.json`: the same WAL, stream and feed ids as `gateway.config.example.json`, `markets: []`, `polymarket.customFeatureEnabled: true` (the series door requires it), and a `seriesAdmission` block with the same review (`admissionLeadSeconds` 120, poll 30 s).
3. **The review.** The universe sample `reviewedBtc15mSeriesDocument`, with one change: `acceptedProtocolVersions` is `["v1","v2"]`. Venue values are copied as they are.
4. **Agreement test.** `test/unit/trader/series-burn-in-examples.test.ts` (runs in `pnpm test`).
5. **Runbook.** A "Before a burn-in" section in `paper-operations.md` (25 lines), linking to the READMEs.

## files_changed
`infra/compose/trader/trader.series.example.json`, `infra/compose/trader/README.md`, `infra/compose/data-gateway/gateway.series.example.json`, `infra/compose/data-gateway/README.md`, `test/unit/trader/series-burn-in-examples.test.ts`, `docs/runbooks/paper-operations.md`, `docs/handoffs/BURNIN-PREP.md`, `docs/handoffs/INDEX.md`.

## tests_run
- The new test: 4 passed.
- Mutation: with the trader example's entry changed to `FAK`, the GTD test failed and the other three passed. The file was restored.
- `pnpm typecheck`, `pnpm lint` clean; `pnpm test` 555 files, 12584 tests passed; `check-brief.py` PASS; `selftest-brief.py --repo .` PASS.

## assumptions
- The test lives in `test/unit/trader/` because the root runner is the one place that can import the trader door and the gateway door together (neither app depends on the other). It imports both by relative path.
- "The gateway's own config parser accepts" is `parseGatewayConfig`, which runs `checkSeriesAdmission`.
- `admissionLeadSeconds` 120 is my choice (the entry cutoff is 45 s). No document states a default; the schema requires one.
- The instance ids in the trader example are placeholders, as in the market-list example. `register --series` needs a template without them; the runbook gives the `jq`.
- `register --series` was not run (it needs PostgreSQL). The template path is documented from `register --help`, not exercised here.

## deviations
- The halt `action` field is not a config field. It is a halt-record and health-snapshot field (`C1-TIDY`). The runbook says so, and the test cannot check it in a config.
- `parseTraderConfig` does not refuse a FAK entry. That refusal is the strategy validator's, at composition. The test therefore pins GTD and `order_validity_ms` directly.

## known_risks
- The review's `reviewedBy` is `sample-reviewer` and `modelDependentActivationAllowed` is `false`. No human has reviewed the series' settlement (`CLOSEOUT-2` N2). The runbook says so. Static Bracket reads no review.
- The example is not run end to end against the live venue here.

## follow_up
- Not built: a test that runs `register --series` on the example. It needs PostgreSQL. Trigger: the first burn-in that fails at registration.
- Not built: a second test for the gateway to trader feed-id agreement on the series pair. The existing `market-channel-feed-id.test.ts` covers the market-list pair, and the new test asserts the gateway's `polymarket-market` id.

## Outcome
Reviewer: pending.
