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
- The review's `reviewedBy` is `sample-reviewer`; `modelDependentActivationAllowed` is `true` (r1, PAPER-only owner ruling 2026-10-05) because `false` makes the risk engine refuse every entry (`RISK_SETTLEMENT_UNVERIFIED`). No human has reviewed the series' settlement. The runbook says so.
- The example is not run end to end against the live venue here.

## follow_up
- Not built: a test that runs `register --series` on the example. It needs PostgreSQL. Trigger: the first burn-in that fails at registration.
- Not built: a second test for the gateway to trader feed-id agreement on the series pair. The existing `market-channel-feed-id.test.ts` covers the market-list pair, and the new test asserts the gateway's `polymarket-market` id.

## commit_sha
r0 `58e1e9f`; r1 is the next commit on `burnin-prep` (`git log burnin-prep -- docs/handoffs/BURNIN-PREP.md`).

## Remediation r1
| Finding | Result | Pin |
| --- | --- | --- |
| M1 | fixed: flag `true` in both reviews, documented in the runbook | test "both reviews assert modelDependentActivationAllowed" |
| L1 | fixed: runbook names the GTC code | none (prose) |
| L2 | fixed: runbook no longer claims the READMEs document `register --series`; points at `register --help` | none (prose) |
| L3 | fixed: manual/node alternative first, jq second | none (prose) |
| L4 | fixed: `infrastructure.retentionMaxEvents` listed | none (prose) |
| L5 | fixed: `commit_sha` section | check-brief |
| L6 | fixed: `readSeriesTemplate` run on the example with ids removed | test "passes register --series (readSeriesTemplate)" |
| L7 | argued: pre-existing, values copied from the universe sample and market example; changing fee rates would invent venue facts. Trigger: a burn-in whose PnL is compared with venue fees. | none |

The runbook section is 28 lines (was 25); the added lines carry M1, L1 and L4.

## Outcome
Reviewer: pending.
