# CO2-N1-ADR: ADR-031 (Proposed) — admitting entries when the trader lags the stream

**Status:** Complete (2026-10-01): ADR-031 is merged as **Proposed**, as `1770be3` (PR #44; CI run `36906946676` green). The user rules on it.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 2 on `24debdc`.
**Base:** `3615560`. The branch merged `main` at `8e95034` before the PR. Docs only.

## summary

ADR-031, `docs/adr/ADR-031-admitting-entries-when-the-trader-lags.md`, frames the decision `CO2-N1` needs before any settlement veto is lifted and before `WP-270`. It decides nothing.

- **The problem.** Every admission input runs on the event's own timestamp: risk freshness, book age and seconds-to-close. The `Clock` port feeds none of them. It is cited by symbol:
  - `CoreLoop.#processEvent`, `#routeIntent`, `#bookAgeMs` and `#secondsToClose`;
  - `featuresAgeMs: 0`;
  - `buildRiskEvaluationInput`, and checks 6, 7 and 20.

  It includes CLOSEOUT-2's reproduction (12:30 against a 12:15 close) and H1 runs 2–8's lags of 18–153 s.
- **The options:**
  - (a) an entry guard on the process clock;
  - (b) every age and seconds-to-close at the later instant;
  - (b-entry) the same, for entries only;
  - (c) a lag pause or halt;
  - (d) accept it as PAPER-only, with a deadline;
  - (e) record and replay the admission clock.

  Each comes with a determinism story, live behaviour, a failure shape, its fit with ADR-023 D7 and ADR-026, and its cost. A comparison table follows.
- **The recommendation: (a), through existing inputs, entries only.**
  - `featuresAgeMs` becomes the lag (check 7, `featuresMaxAgeMs`), and `secondsToClose` is measured from the later instant (check 20).
  - There is no new reason code or policy field, and no change to the risk package. No golden change is expected.
  - Cancels and `EXIT`s keep today's path.
  - "Entry" and "exit" follow risk's disposition (`buildIntentView`), not the strategy's label.
- **For the user (section 3):**
  - the option;
  - **Q1:** whether to reuse existing inputs, or add a dedicated measurement and refusal code;
  - **Q2:** whether a lagging trader's protective exits are refused or taken;
  - **Q3:** whether `CO2-N1` must also close ADR-023's O-R6-I2.
- **For the implementation round:** rules R1–R7 and acceptance tests T1–T11. T1 refuses the closeout's probe, T3 sweeps a lagging trader, and T6 proves replay parity.

## Rounds

| Round | Candidate | Verdict | Notes |
|---|---|---|---|
| 1 | `2013fdf` | CHANGES REQUIRED | 5 MEDIUM and 8 LOW |
| 2 | `24debdc` | **ACCEPT** | — |

The round-1 MEDIUM findings:
- **A-H1:** option (e) overstated live-to-replay equivalence.
- **A-M1:** the options lacked exact ages for entries only, which became (b-entry).
- **A-M2:** no test pinned R1's clock read after `#persistDecisionsBeforePlacement`.
- **O-1:** "entries only" must follow risk's disposition (`buildIntentView`).
- **O-2:** a refusal's lag detail is never observable: the loop keeps only refusal codes.

**Round 2's open LOWs (wording and precision):**
- **CO2N1-R2-L1:** 6.1's re-reading of ADR-026 D3.5 says "admission's ages still run on event time", which contradicts R3.
- **F2-L1:** "between 18 s and 153 s" in-window lag. Run 2's 18 s was before the window.
- **F2-L2:** (b-entry)'s classification cost is charged to the whole option, though only its book half needs it.
- **F2-L3:** reason 4's heading, "It does not obstruct safety exits", is contradicted by its own body.
- **F2-L4:** 2(c) says "`CONTROL-1` owns that path now", but `CONTROL-1` is Complete.
- **F2-L5:** wording nits.

The ruling round fixes them when it sets ADR-031's status.

## tests_run
- `lint` and `check:deps` exit 0. `test`: 417 files, 9375 tests.
- **Quotes:** 26 passages were compared verbatim with their sources, including ADR-023 at `d5dda21`.
- **Symbols:** 54 cited code symbols were checked with `git grep`.
- **No probe was run.** The reproduction is cited from CLOSEOUT-2.
- **CI:** GitHub CI on the PR #44 merge ref was green before the merge: run `36906946676`.

## assumptions
- The `CO2-N1` implementation round runs after `THROUGHPUT-1c` merges.
- The only venue fact used is U-12: there is no documented pushed market-closed signal, so the close is the configured `closeTime`.

## deviations
- Options (b-entry) and (e) were added to the packet's four, because the reviewers and E-02 named them.

## known_risks
- **Under Q1's recommended answer,** lag refusals read as `RISK_FEATURES_STALE`. A close-criterion refusal cannot be told from an ordinary cutoff refusal.
- **Option (a) is coarse.** An admitted entry's book can be up to `venueBookMaxAgeMs` plus the lag bound old: 4000 ms with the example values. Option (b-entry) would be exact.
- **Estimates not yet tested:**
  - the test fallout is estimated from `git grep`, not run;
  - replay parity is argued, not yet run.

## follow_up
1. **The user:** rule on the option and on Q1–Q3. Then the orchestrator sets ADR-031's status and updates the `CO2-N1` row.
2. **If (a) is accepted:**
   - grant the `CO2-N1` round `packages/trading-core/**`, the affected tests under `test/integration/paper-trader/**`, and the `apps/trader/src/transport-lag.ts` comment;
   - require `APPROX-REPLAY-1` to position its clock per sample.

## commit_sha
`24debdce1aa6b0c4fdde6d0c4f03f3bb3c931ec9`
