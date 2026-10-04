# CONTROL-2: open trader halts in the control API (fail closed); CONTROL-1b's LOWs

**Status:** Complete (2026-10-04). Merged `2f84ad7` (PR #60; CI run `37211109103` green). It closes `H1R1-HALT-INVISIBLE` and `CONTROL1B-LOWS` R5-L1 to R5-L3.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 4 on `be31247`.
**Base:** `072c89c`. The branch merged `main` at `f9fc1c9` before the PR.
**Paths:** `apps/control-api/**` and its unit and integration tests; the halt rule and the halt panel under `infra/`. Two grants (S1 and S2) are recorded in the brief.
**Posture:** PAPER only. The control API stays read-only toward the trader and the database.

## summary

1. **The halt read** (`trader-halts.ts`, `adapters/postgres-trader-halts.ts`).
   - **What it reads.** Open `TRADER_HALT:*` rows in `ops.incidents`: status not RESOLVED, so MITIGATING counts.
   - **How.** One REPEATABLE READ, READ ONLY transaction, with its own `statement_timeout` and a client-side deadline, through a strict door.
   - **The four states.** OPEN, NONE_OPEN, UNKNOWN and NOT_CONFIGURED. NONE_OPEN comes only from a read that succeeded. Every scrape is answered within 8 s, as UNKNOWN if the read has not finished.
   - **Odd rows.** Unknown scopes and irregular rows are counted and listed, never dropped. Text from the table is escaped.
2. **Surfaces.**
   - `/v1/health` gains a `traderHalts` section.
   - **Three platform metric families:** `control_trader_halts_state`, `control_trader_halts_open` and `control_trader_halt_reads_total`.
   - **The alert.** `TraderHaltOpenOrUnknown` pages on OPEN or UNKNOWN. A test applies the rule to the API's rendered metrics in each of the four states.
   - **The panel:** "Open trader halts (ops.incidents)".
3. **The shipped composition (grant S2).**
   - **Config.** A required `traderHalts` field: `{kind: none}` or `{kind: postgres, timeoutMs}`.
   - **The database URL.** It comes from `CONTROL_API_TRADER_HALTS_DATABASE_URL`, read once and never logged.
     - Driver errors pass through a redactor, proven against the driver's real error text.
     - Startup refuses (exit 78) a URL the driver would rewrite, a URL with query parameters, any part that decodes to a NUL, any set `PG*` variable, and the variable set under `none`.
   - **The bundle.** It admits exactly 15 justified `pg`/`kysely` packages and 11 justified builtins, through byte-pinned static shims, with no dynamic `require`. `pg-native` is a stub that throws if loaded. The signing vocabulary and its positive control are unchanged.
   - **The deployment duty** (README): a role with USAGE on schema `ops` and SELECT on `ops.incidents` only.
   - **Measured.** The shipped bundle, against real PostgreSQL through that role, reports OPEN in both `/v1/health` and `/v1/metrics`.
4. **`CONTROL1B-LOWS`:**
   - **R5-L1:** the production-source rule catches a global reached as a member of another.
   - **R5-L2:** the README says `check:deps` F14 covers only `packages/domain` among the bundled packages.
   - **R5-L3:** `@noble/curves`, `@noble/hashes`, `@scure/bip32` and `@scure/bip39` are forbidden and pinned.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 0 | `562ad59` | (stopped) | S1: the observability pins. S2: `pg` in the shipped bundle. The orchestrator granted both (`f9fc1c9`) |
| grant | `1cd9b23` | — | Both grants applied |
| 1 | `1cd9b23` | CHANGES REQUIRED | CTL2-F1 HIGH: a slow halt read held every scrape. R1-C2 MEDIUM: a `?password=` query parameter |
| 2 | `01f23a9` | CHANGES REQUIRED | R2-C1 MEDIUM: the password leaked through re-encoding |
| 3 | `9406bb3` | CHANGES REQUIRED | R3-L1 MEDIUM: NUL truncation |
| 4 | `be31247` | **ACCEPT** | none; two LOWs |

## tests_run
- **Gates per round:** typecheck, lint, check:deps and test; the control-api `test:integration`, including the shipped-artifact acceptance-3 suite; and `test:integration:postgres`.
- **The required real-PostgreSQL tests:**
  - the trader's own writer writes halts, which are read back as OPEN;
  - a lock gives UNKNOWN;
  - a refused privilege gives UNKNOWN;
  - read-only is measured;
  - the shipped bundle reports OPEN.
- **Mutation:** 30 rows in the grant round, all killed.
- **CI:** GitHub CI on the PR #60 merge ref was green before the merge.

## deviations
- **The grants S1 and S2,** recorded in the brief.
- **Builtins** are shimmed rather than loaded through `createRequire`, so the artifact holds no module loader.

## known_risks
- **CTL2-R2-L2 (LOW).** `infra/prometheus/README.md` omits the trader-halts group, its alert, the state family, and the scrape-timeout constraint.
- **CTL2-R4-L1 (LOW).** A handoff claim about `%00` passwords is overbroad for trust-authenticated servers. Startup now refuses NUL anyway.
- **CI does not run `test:integration:postgres`,** which carries this round's real-PostgreSQL evidence. That is a `CONTROL-1b` follow-up, for `CI-5`.
- **The example config uses `none`.** A deployment must choose `postgres` to get halt visibility.

## follow_up
1. **`HOST-1`:**
   - configure `traderHalts: postgres` with the minimal role;
   - route `TraderHaltOpenOrUnknown`;
   - decide whether NOT_CONFIGURED should page on the laptop profile.
2. **`CI-5`:** run the control-api `test:integration:postgres` in CI.
3. **A docs touch:** CTL2-R2-L2.

## commit_sha
`be31247`
