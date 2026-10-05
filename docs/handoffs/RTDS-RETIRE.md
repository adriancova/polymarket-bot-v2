# RTDS-RETIRE: retire the RTDS reference-price producer, and keep the historical readers

**Status:** Complete (2026-10-05). Merged `81f683a` (PR #69; CI run `37332676086` green; a duplicate run failed on the recorded flake FLAKE-KILLSWITCH-ENGAGE). It acts on `V3-C13-REFERENCE-TWAP` (E-09 to E-12).
**Reviewer:** Codex gpt-6-astra. ACCEPT on `1e80d4d`.
**Base:** `096c649`. The branch merged `main` at `0879884` before the PR, and the orchestrator re-ran every gate and integration suite on the merge `134b23b`.
**Ruling:** the user, 2026-10-04: the free route only. The venue moved its reference/TWAP prices to PolyBolt, which needs authentication, and removes the legacy RTDS topics around 2026-10-23 (U-20).

## summary

1. **The refusal.** The gateway config no longer has an `rtds` block.
   - Before the schema runs, `parseGatewayConfig` refuses any operator-written `rtds` key, whatever its value, with a `GatewayConfigurationError`.
   - The error carries `RTDS_RETIRED_REASON`. It is dated, cites V3-C13 and `verified-2026-09-30.md` E-09 to E-12, C-13 and U-20, and says what the operator should do.
   - An inherited prototype key is neither read nor refused; both pollution variants are tested.
   - A test pins that the example config has no `rtds` key.
2. **The gateway's RTDS driver is removed:** about 409 lines, its wiring, the `rtdsSocketFactory` port, `metrics().rtds` and the RTDS subscription plan. With the door refusing the key, it could only run by bypassing the door. Its tests went with it.
3. **The readers are untouched:** `packages/domain`, `apps/research-worker`, `apps/backtest-cli` and `packages/event-bus`. The new test `test/integration/data-gateway/rtds-retired.test.ts` shows three things:
   - recorded RTDS frames from the 2026-08-24 fixture read back byte-identical from a WAL segment;
   - the research worker interprets them with exact decimals;
   - the `ReferenceTwapObserved` envelope passes the domain registry, the event bus's validation, and an encode/decode round trip.
4. **Alerts and dashboards: nothing misfires, so nothing changed.**
   - No `recorder_rtds_*` series is emitted when RTDS is absent.
   - `RecorderRtdsHalted` cannot fire on a missing series, and no `absent()` rule names one.
   - promtool `check rules` passes, and a scratch rule test, including a positive control, confirms both.
5. **ADR-009 §6** has a dated correction: the 30 s window is gone with RTDS; PolyBolt says "Only 60 exists today."; Chainlink still lists a live 30 s stream that the rules do not name (F-32).
6. **The RTDS adapter, its contract suite and the fixture are kept** as the 2026-08-24 record. The research worker imports the adapter's read functions, and `apps/ops-cli` verify-venue claims the fixture. Only the adapter's module header changed.

## tests_run
- **On the merge `134b23b` (orchestrator), all exit 0:**
  - typecheck, lint and check:deps;
  - unit: 11542;
  - e2e: 216;
  - replay: 19;
  - contract;
  - fault: 848.
- **Integration suites:**

  | Suite | Tests |
  |---|---|
  | storage-postgres | 257 |
  | event-bus | 112 |
  | research-worker | 43 |
  | data-gateway | 149 |
  | trader | 403 |
  | control-api | 310 |

- **CI:** GitHub CI on the PR #69 merge ref: run `37332676086` was green. A duplicate run, `37332689128`, failed 2 tests in WP-320's moved kill-switch test (`FLAKE-KILLSWITCH-ENGAGE`), unrelated to this round.

## deviations
- **The driver was removed** rather than kept unreachable, for the reason in summary item 2.

## known_risks
- **Recorded RTDS data stays readable,** but no new RTDS data will be produced. Any research that needs a reference TWAP uses Gamma's public `priceToBeat`/`finalPrice` (V3-C13), which are observed fields.

## follow_up
- None owed by this round.

## commit_sha
`1e80d4d`
