# ADR031-ACCEPT: ADR-031 Accepted (option (a)); ADR-032 (unguessable reconciliation request ids)

**Status:** Complete (2026-10-02). Merged `a60ee27` (PR #47; CI run `37098593943` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 1 on `816a279`.
**Base:** `c5157c3`. The branch merged `main` at `315fe80` before the PR. Docs only.

## summary

It records the user's rulings of 2026-10-02. The governance commits that recorded them are `b677fd8` (ADR-031) and `4daa884` (WP-300c's request tokens).

- **ADR-031 is Accepted.** The user ruled option (a): an entry guard on the process clock, through existing inputs, entries only.
  - **Q1:** existing refusal codes. A lag refusal reads as `RISK_FEATURES_STALE`.
  - **Q2:** exits as today. The question is owned by the §9.9 Incident Controller round, and must be answered before any run mode above PAPER.
  - **Q3:** the separate residual `ADR023-CLOCK-STEP`.
  - **The text:**
    - section 3 records the decision;
    - section 4 states the ruling;
    - section 5 states the rule testably, with R1–R7 and T1–T11 unchanged.
  - **ADR-023** is cited on `main`, where it is Accepted. A note in 1.3 records that, since `THROUGHPUT-1c` merged, the loop reads the clock in `#processNowEpochMs` under `CONNECTION_CONFIRMED`.
  - **The round-2 LOWs** are fixed: CO2N1-R2-L1 and F2-L1..L5. F2-L1, for example: the in-window lag in runs 3–8 was 23–153 s.
- **ADR-032 (new, Accepted).** Wallet-operation reconciliation request ids carry an unguessable token, per the user's ruling for `WP-300c`. It is written against `main` at `7e05702`, and its decisions D1–D8 cover every point of WP-300c's G1:
  - the id format and `MAX_REQUEST_TOKEN_LENGTH`;
  - the required `requestToken` dependency and its CSPRNG binding;
  - `WP-290`'s duties to echo the id and never answer with a stale read;
  - failed-draw liveness and its alert;
  - replay reproducibility;
  - persistent refusal of ids named before receipt;
  - the replacement request.

  It states `WP300C-J1` as the reason, and records the rejected alternative: no token, resting on `WP-290`'s contract alone.
- **The README:** the ADR-031 row reads Accepted, and an ADR-032 row is added.

## tests_run
- `lint`, `check:deps` and `test` exit 0: 426 files, 9636 tests.
- A script compared the six ADR-023 passages that ADR-031 quotes against `main`; all match.
- Every code citation in ADR-032 was checked at its pinned commit.
- GitHub CI on the PR #47 merge ref was green before the merge: run `37098593943`.

## assumptions
- Neither ADR quotes the user verbatim. Both cite the governance commits that recorded the rulings.

## deviations
- New explanatory text in ADR-031 (1.3, 1.4 and two 6.1 rows) records what `THROUGHPUT-1c`'s merge changed in admission. It decides nothing.

## known_risks
- **ADR031-ACC-R1-L1 (LOW, open).** A stale quote of the brief in ADR-031 section 1.1.
- **INFO items:** I2–I5. Examples are ADR-032's wording about "other remedy" and its owner of D5. See the joint report: `~/pmb-rounds/adr031-accept/reconcile-r1/joint.md`.
- **A doc comment in `packages/inventory`** says tests use a predictable token source "only to show that". In fact most inventory suites use the counter source.

## follow_up
1. **The `CO2-N1` round:** implement R1–R7 and T1–T11, after `PROVENANCE-1`.
2. **ADR-026's header** can gain one line pointing to ADR-031, in a round whose grant covers ADR-026.
3. **A later inventory round:** correct the `requestToken` doc sentence, alongside R4-01, R4-02 and J9 (`WP300C-OBLIGATIONS`).

## commit_sha
`816a2796ae7461d5b386f0849b999cb8501f782d`
