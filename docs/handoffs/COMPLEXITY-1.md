# COMPLEXITY-1: complexity audit with fixes

**Status:** Running (authorized by the user, 2026-10-08). This handoff is updated as each round merges.
**Principle:** AGENTS.md "Design principle: proportionality", adopted 2026-10-08 (`3a2a77a`, formalized `5129b98`).
**Scope (user):** everything, process included, as an audit and fixes in one go. Debatable items go to the user.

## The audit (2026-10-08)
- **Six read-only lenses,** each followed by a skeptic who tried to refute every finding: v1 patterns, the trading path, OMS and halts, the operator surface, process, and the V2-9 scanner. They produced 70 findings.
- **A deep dive** on 8 candidates: an analyst ran the five-question test with recorded-run evidence, and a skeptic challenged it.
- **The finding:** most individual checks are sound. The unjustified complexity sits in three places:
  - blocks that never clear;
  - live-only machinery that PAPER never runs;
  - process overhead.

## Rulings (user, 2026-10-08)
- **ADR-034, re-sequenced.** Build now only what PAPER uses: time-in-force carried on the plan.
  - D1's venue-time machinery and D4's collateral-targeted FAK/FOK BUYs are parked until the execution probe.
  - Immediate entries become share-sized GTC/GTD with a deadline cancel.
  - When D1 is built, it takes the self-clearing form.
- **Halts.** A desynchronized book waits for its next snapshot instead of halting. All other halts stay run-ending, and the unused scope, action and release code is deleted.
- **The ADR-023 taint is narrowed** to Polymarket-channel and gateway-wide faults. This reverses the 2026-10-02 coarse ruling.
- **Exposure caps:** the capital allocator is the only authority, and it sums multi-leg orders first.
- **Universe's series code** is imported, and the trader's copy deleted.
- **Check 17** values an unmarked window at zero.
- **Process:**
  - review effort by risk;
  - a brief capped at 30 KB, with RESIDUALS.md;
  - status written inside the PR;
  - an ADR budget, and a lighter AGENTS.md reading list.
- **No change, with revisit triggers recorded:**
  - **Reference-feed freshness:** narrow it per strategy before any run without Binance or Coinbase.
  - **A Redis outage:** stays terminal. Document the restart order, and give the burn-in its own compose project.
  - **The series slot:** stays held. Correct the stale messages.

## Rounds

| Round | What | Review | Merge |
|---|---|---|---|
| C1-V29 | V2-9's scanner cut from about 6,150 to about 1,540 production lines; no fixture byte changed | astra ACCEPT, round 1 (`726bc19`) | V2-9, `636536a` (PR #90) |
| C1-PROC | The brief from 82 KB to 18 KB, with RESIDUALS.md (127 rows, moved verbatim and proven); check-brief from 41 rules to 7; the preservation tools deleted (`tools/records` from 3,281 to 447 lines); status in the PR; the runbook's current loop; the ADR budget; the lighter reading list | astra ACCEPT, round 1; LOWs R1-01 and R1-02 fixed (`80fc9bb`) | via PR #91 |
| C1-HALTS | Honest halts (`ACTION_FOR`, `release()` and `OPERATOR_HALT` deleted; every halt ends the run); a book divergence clears its baseline and waits for the next snapshot (benign drops counted, faults still halt); the ADR-023 taint narrowed (note appended); data-quality incidents close at the trader; infrastructure halt pages resolve on the next run; `register --new-run` | dual (Opus + astra) ACCEPT on substance in round 1 (`919ec24`); the round-1 LOWs fixed (`084bd46`); the round cap was reached only on SCOPE-1, a forced 2-literal test edit that the orchestrator ratified | via PR #93 |
| C1-RISK | The allocator as the only exposure authority; check 17; the dead resize path and knobs | dual, queued | — |
| C1-TIF | The ADR-034 re-sequence | queued | — |
| C1-UNIV | Import universe's series code | queued | — |
| C1-OPS | The control API answers an audited 501 CONTROL_NOT_WIRED in PAPER; one PAPER compose stack (`infra/compose/paper`, its own project and ports); RecorderRtdsHalted deleted and the recorder fragments marked not deployable; `docs/runbooks/paper-operations.md`; the series messages corrected; the brief check and self-test in CI | astra ACCEPT on the second attempt (`a645c6d`) after the orchestrator widened a too-narrow grant and reverted a scope retreat; LOW R1-01 fixed (`b1db4f8`) | via PR #92 |

## C1-PROC notes
- **The orchestrator granted one STOPPED item:** the status archive's README now names the removed tools instead of documenting them (`2ad210f`).
- **A process incident:** an implementer command briefly ran read-only gates in the main checkout. Only that process tree was killed, by PID, and the checkout stayed clean.

## C1-OPS notes
- **The packet's mistake.** The allowed paths left out the tests that pin the changed behaviour: the control-api integration tests and the recorder alert-count test. Review failed on scope, and a remediation reverted the 501 to satisfy scope. The orchestrator granted the paths, reverted that commit (`d24b247`) and re-reviewed.
- **Follow-ups:**
  - Redis `restart: unless-stopped` (optional);
  - a unit pin of the NOT_WIRED record;
  - the stale header in `engage-reserve.test.ts`;
  - the old trader stack's PostgreSQL 17.5 volume is not migrated: start the PAPER stack fresh.

## C1-HALTS notes
- **The orchestrator's grants.**
  - `apps/backtest-cli/src/assembly.test.ts` is ratified (SCOPE-1). Deleting `OPERATOR_HALT` forces its two literals.
  - The two STOPPED sub-parts were accepted in interim form: the health and metrics `action` is the constant `"FULL_HALT"`, and the book-refusal counts are logged at stop.
- **Follow-ups:**
  - Remove `action` from the control-api health door and from `packages/observability`, and expose the refusal counts on health (a small health round).
  - L1: risk check 8 judges the configured direction's book, not the intent's. This only matters with complement inventory; the shipped configs are DIRECT_ONLY.
  - L6: the stale "until an operator resolves its row" text in the Grafana operations dashboard.
  - OPS-03 (b): key the consumer by run id.
- `FOLD-RELATCH` is moot (RESIDUALS.md).
