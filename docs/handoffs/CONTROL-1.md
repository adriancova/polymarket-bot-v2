# CONTROL-1: CO2-N8 — the kill switch cannot be starved through the audit log; unknown instances refused; the control API's LOWs

**Status:** Complete (2026-10-01). Merged `b9d9818` (PR #43; CI run `36901578263` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 2 on `308e5fe`.
**Base:** `98a814b`. The branch merged `main` at `3615560` before the PR.
**Paths:** `apps/control-api/**` and `test/integration/control-api/**`.
**Posture:** PAPER only. No signer import, and the PAPER defaults are untouched.

## summary

It closes `CO2-N8`, WP-240's r1 findings M-1 and M-3, and the LOWs WP-240 owned to this round.

**M-3: audit-log exhaustion can disable the kill switch.**
- **Reproduced at base,** for the first time; CLOSEOUT-2 I1 noted it had only been read from code. At capacity 3, five mode-raise requests from a READ-only operator filled the log. The authorized GLOBAL FULL_HALT then got `503 CONTROL_NOT_AUDITABLE`.
- **Layer A:** a caller with no mutation grant writes no audit record. Its mode-raise is still refused 403 by name, counted, and reported as "NOT audited". `MUTATION_GRANTS` is derived from the mutating routes.
- **Layer B:** `SafetyReservedAuditSink` splits one capacity C into three tiers, using the new required config field `auditSafetyReserve` R (R ≥ 1, 2R < C):
  - an engage that creates a kill switch, or escalates one to FULL_HALT, may fill the log up to C;
  - a RUNNING → PAUSED pause may fill it up to C−R;
  - every other record may fill it up to C−2R.

  So a STRATEGY_CONTROL holder without KILL_SWITCH cannot starve the kill switch either.
- **Round 1's fix (J-M1).** An identical re-engage is refused `409 CONTROL_ALREADY_IN_STATE`. An engage that would weaken a FULL_HALT is refused `409 CONTROL_ENGAGE_WOULD_WEAKEN`, which sends the operator to the release path and its evidence. Both refusals sit in the ordinary tier.
- **Round 1's fix (J-M2).** Every refusal of an authorized request to a mutating route is now audited, in the ordinary tier. The covered refusals are the transport (413, 415, 400 not JSON), the route parameter and the body door. They are answered only after authentication and authorization. Record content is bounded.
- **Unchanged:** audit first, then apply on success. A mutation that cannot be audited is refused, with the state unmoved.
- **Concurrency.** Mutations are serialized per instance and per switch.

**M-1.**
- An unknown instance is refused `409 CONTROL_UNKNOWN_INSTANCE`, and audited as REFUSED.
- Refusing was chosen over registering from the composition, because no seam yet reaches a trader's strategies.
- `register()` enforces the route's id grammar.

**The LOWs and N-4.**
- L-1, L-2: a total instance-id decoder, with the grammar applied after decoding: 1–256 characters, no `/`, no control characters.
- L-3: a 415 for an undeclared body.
- L-4, L-5: dispatch goes only through one route table. A wrong method gets 405 with an `Allow` header, and `CONTROL_API_ROUTES` is derived from the table.
- L-6: `NOT_AUDITED` is pinned on the wire.
- L-8: closed for strategies by M-1. The kill-switch map is argued, not capped, because capping it would refuse a safety action.
- L-9: explicit server timeouts.
- N-4: the no-signer scan now covers the test suites and `infra/grafana` (read only). It matches any quote character.

## tests_run

- **Gates on `308e5fe`:**
  - `typecheck`, `lint` and `check:deps` exit 0.
  - `test`: 418 files, 9361 tests.
  - `test:e2e`: 9/212.
  - `test:replay`: 3/17.
  - control-api `test:integration`: 15/173. Base had 10/87.
- **Base reproductions:** `m1-unknown-instance` and `m3-audit-exhaustion` fail 4 of 5 at base. The fifth is a positive control.
- **Further suites:**
  - a seeded adversarial suite, 24 seeds × 400 requests, with an independent check of the reserved records;
  - a test through the shipped `main.ts` startup;
  - the round-1 sequences H1a–H1c, pinned over HTTP.
- **Mutation:**
  - round 0: 32 guards, all killed;
  - round 1: 25 mutants, all killed. One first survived; a pin was added.
- **CI:** GitHub CI on the PR #43 merge ref was green before the merge: run `36901578263`.

## assumptions
- "Mutation authority" means holding KILL_SWITCH or STRATEGY_CONTROL, as derived from the route table.
- The safety-direction actions are an engage that creates or escalates a kill switch, and a RUNNING → PAUSED pause.

## deviations
- **The new required field `auditSafetyReserve`.** Every older config is refused at startup with exit 78, naming the field. The in-repo configs are updated.
- **Transport refusals now come after authentication and authorization.** An anonymous caller gets 401, and a caller without the route's grant gets 403. Assertions written to WP-240's earlier rule, "a bad body writes nothing", were rewritten to the J-M2 rule.

## known_risks
- **The reserve.** A KILL_SWITCH holder's real halts at many distinct scopes can use up the reserve. A further escalation then gets 503. The round's invariant covers actors without mutation authority.
- **A stalled sink.** An audit sink append that never settles blocks later mutations of the same instance or switch. A durable sink needs an append timeout.
- **Records, not bytes.** The budget bounds records, not bytes. Mode-raise records still carry the request path and the attempted keys.
- **Refusal bytes.** Audited refusal records can carry caller-controlled bytes, including NUL and U+202E. A Postgres `jsonb` sink would reject NUL.
- **Strategy control is inert in the shipped process.** No trader seam exists yet (WP-240 follow-up 4).
- **Open LOWs:**
  - **CONTROL1-R2-J-L1:** the no-signer scan can still be evaded by three exotic spellings, such as `import '\x76iem'`;
  - **CONTROL1-R2-J-L2:** no test pins the kill-switch lock key, so mutants X13 and X14 survive.
- **Carried INFO:** the instance-id grammar admits `\p{Cf}`, such as U+202E.

## follow_up
1. **Operator.** Any control-api config outside the repo needs `auditSafetyReserve` before its next use. The in-repo example has it.
2. **The kill-switch to trader seam (WP-240 follow-up 4):**
   - align the instance-id grammars, including `\p{Cf}`;
   - state the §14.1 action order;
   - register the real instance set.
3. **Before a durable sink:**
   - add an append timeout;
   - cap the content of mode-raise records;
   - sanitize refusal bytes for `jsonb`.
4. **`CADENCE-1`** starts from this merge, because it also owns `apps/control-api/src/**`. A new mutating route needs a `ROUTE_DEFINITION`.
5. **The two open LOWs:** a later control-api round.

## commit_sha
`308e5fee800740ec4177648aa6b4655afcf3775e`
