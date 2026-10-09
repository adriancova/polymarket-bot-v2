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
| C1-RISK | The capital allocator is the only exposure-cap authority (it sums multi-leg intents; check 15 keeps only maxOrderNotional; 9 codes and 6 settings removed; old configs refused naming allocatorCaps); check 17 values an unmarked lot at 0 (RISK_SCENARIO_MARKS_INCOMPLETE removed; domination pin); the resize path removed (4 codes); the trader's retentionMaxEvents knob and metric removed. Reason codes 62 to 48; +1,079/-2,333 lines | dual ACCEPT in round 2 (`b16fc50`; round 1: a MEDIUM test-timeout risk and 3 LOWs, all fixed) | via PR #94 |
| C1-TIF | The ADR-034 re-sequence: time-in-force carried on the plan (`PlannedOrder.timeInForce`; GTD's `expirationUnixSeconds` = deadline + 60 s); `OrderTimeInForceBook` deleted; Static Bracket refuses a FAK/FOK entry (`SB_IMMEDIATE_ORDER_TYPE_PARKED_UNTIL_EXECUTION_PROBE`) and a GTC one until D3.4's deadline cancel exists; the shipped entry is GTD, and a bracket is not finished while its entry's remainder rests (C1-TIF-01); OMS-VENUE-TIME and TIF-COLLATERAL parked; ADR-034 dated note. Goldens: the two paper-e2e goldens change only the entry's tag (`sb.order-type:FAK` to `GTD`); the backtest golden's artifact is unchanged | dual ACCEPT in round 2 (`6b6fca6`; round 1: MEDIUM C1-TIF-01, a GTD entry remainder filling after the bracket closed, fixed and pinned; 5 LOWs fixed) | via PR #96 |
| C1-UNIV | The trader imports universe's series code (§2.1 row S19, trading-core → universe; the one lockfile importer entry); its copy `series.ts`, `series.test.ts` and the mirror test deleted; universe's `outcomes` an array of exactly two (the arena copies no tuple); 3 config-door tests (hash equal to the gateway's, negRisk true and one or three outcomes refused); the trader's re-judge unchanged. Code and tests: +71/-866 lines | astra review pending (`c1-univ` r0) | — |
| C1-TIDY | The COMPLEXITY-1 follow-ups: the halt `action` field and the `trader_halt_info` `action` label removed (the health door is strict, so a halt carrying one is refused); `bookRefusals` on the trader health snapshot and through the control-api door; `simulation.startingCash` deleted (the venue opens with `accounting.startingCash`; an old config is refused naming it; `crossFieldRefusal`'s cash branch and its tests gone); 5 small LOWs (planner's `TIME_IN_FORCE_VALUES`, two stale comments, the stale dashboard text, universe's `node:crypto` in §2.2). Replay-golden artifacts byte-identical. Code and tests: +152/-206 lines | Opus ACCEPT in round 1 (`f382e13`; standard tier: Sonnet implemented, one Opus reviewer; 5 LOWs, the dashboard wording fixed by the orchestrator, the rest follow-ups) | via PR #97 |
| C1-OPS | The control API answers an audited 501 CONTROL_NOT_WIRED in PAPER; one PAPER compose stack (`infra/compose/paper`, its own project and ports); RecorderRtdsHalted deleted and the recorder fragments marked not deployable; `docs/runbooks/paper-operations.md`; the series messages corrected; the brief check and self-test in CI | astra ACCEPT on the second attempt (`a645c6d`) after the orchestrator widened a too-narrow grant and reverted a scope retreat; LOW R1-01 fixed (`b1db4f8`) | via PR #92 |
| C1-OMS06 | One latch for reconciliation halts (audit OMS-06, the skeptic's amendment): the live entry gate derives its halts from the coordinator's journal at every ask, through `quarantinedBreaks()`, which throws when the journal cannot be read (`HALTS_UNREADABLE`, fail closed; never `status().unresolvedBreaks`); `HaltPort`/`HaltRequest`, `#deliverHalts`, `HALT_DELIVERY_FAILED` (43 break classes to 42), live-safety's latch and `releaseReconciliationHalts()`, and the ops-cli halts recorder deleted; one `releaseQuarantine` lifts exactly that break's halt; pins 5a-5e against the real coordinator; ADR-033 dated note. Production +72/-127 lines. Two forced doc edits were STOPPED and granted by the orchestrator (`3e303da`): the WP340-F1 release counts in `docs/experiments/phase-3-verification.md` §5 (the halt calls were crash kill points) and the emergency runbook's halt-port row | dual (Opus + astra) ACCEPT in round 1 (`3e303da`); 2 LOWs: the stale halt-port records, fixed; the tautological property check, a follow-up | via PR #98 |

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

## C1-RISK notes
- **Deferred:** removing `simulation.startingCash` (OPS-07). It needs `apps/backtest-cli/src/assembly.ts`, and the duplicate costs little.
- **Vacuous now:** WP-180's criterion "risk resize creates a new approved-intent record". No resize path exists, and the planner refuses instead.
- **Operators:** a burn-in config that still carries a retired `*ExposureCap` field is refused at startup (exit 78), naming its `allocatorCaps` replacement.
- **Follow-ups:**
  - The allocator's cap checks on sell legs can refuse an exit when a scope is already over its cap, for example after a cap is lowered while a position is open.
  - Static Bracket has no lower entry bound; a minimum trigger price or bid depth belongs in the strategy.

## C1-TIF notes
- **Ratified:** the brief's "Authorized now" bullet was edited along with the two named rows (R2-L1); the edit is correct.
- **Follow-ups** (all LOW):
  - narrow the `entryMayStillFill` doc comment, because planTick's market-closed shortcut still checks only `entryExecutionUnfolded` (R2-L3);
  - an active cancel of a live GTD entry when the bracket goes flat (R2-L5; bounded by the share cap and the 30 s deadline);
  - `pipeline.ts` keeps a private `TIME_IN_FORCE_VALUES`; fold it into the planner's export on the next edit (R2-L4);
  - the stale "FAK taker" wording in `test/integration/paper-trader/support/fixture.ts` `restingEntryConfig` (R2-L2).
- **Operators:** burn-in configs must move `immediate_order_type` from FAK to GTD, with an explicit `order_validity_ms`; a FAK/FOK entry is refused at startup (`SB_IMMEDIATE_ORDER_TYPE_PARKED_UNTIL_EXECUTION_PROBE`).

## C1-OMS06 notes
- **Follow-up (LOW R1-02):** the reconciliation property's "a quarantine is not halted" check in `test/fault-injection/reconciliation/support/property.ts` (around :1317-1321) now compares the journal's QUARANTINED set with itself, so it cannot fail. Delete it or re-aim it at the live gate. Fault pins 5a-5e carry the real coverage.
