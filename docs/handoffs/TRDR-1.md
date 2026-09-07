# TRDR-1 completion record — apps/trader instanceId relaxation

**Merged:** `65ae56c` (`--no-ff`, 2026-09-07). Chain `dafce35` (the
trader relaxation) → `f0bdd56` (grant extension `9678e05`: the e2e
residual-1 retirement) on base `d100933`. One review round: ACCEPT
(0 blockers; findings all NOTE/LOW/INFO with owners below).
**ADR-021 is DISCHARGED end to end** — all four merged doors (risk
`8c14b47`, allocator `d9f70a6`, ledger/pnl always) and the trader
startup door now agree on `Uuidv7Schema`.

## What changed

- `UuidAndCodeString` (WP-230's interim letter-leading intersection) is
  DELETED with zero identifier references remaining in `apps/trader`
  (typecheck-enforced); `InstanceConfigSchema.instanceId` is
  `@polymarket-bot/domain`'s own `Uuidv7Schema`, parsed through the
  trader's existing `prototypeFreeParser` arena door (reviewer-verified
  a REAL door — the `skipChecks` row tests what it claims, and an 8-key
  pollution battery holds 32/32).
- Both directions pinned (six-spelling startup table at base and tip,
  reviewer-reproduced through the composition root): the minted
  0-leading population is ADMITTED; a letter-leading v4 AND a
  bad-variant v7 — both of which passed startup at base and were
  refused only mid-run (ALLOC-1 r1 L1) — are refused AT STARTUP.
- The refusal text and in-app comments lost the stale
  cross-package-conflict claim (L2); the `CodeString` scope-key message
  de-staled with the grammar byte-identical; `apps/trader/README.md`'s
  reported-conflict item 1 records the resolution.
- Seven mutants with exact kill sets (5/4/2/1/1/6/7), including M7
  proving the letter-leading COMPATIBILITY row non-vacuous, and the
  reviewer's alias-tamper and message-only-regression mutants both
  killed.
- **Reviewer's A11 (beyond the packet):** the entire e2e scenario driven
  on a 0-leading id — orders=1 fills=2, identical to the letter-leading
  baseline, the id in the trader manifest. The admitted population
  genuinely flows through risk, allocator, ledger and pnl; the
  relaxation does not convert a startup refusal into a mid-run one.

## The tripwire (second commit)

WP-250's `test/e2e/residuals-observed.test.ts` fired on the first
candidate exactly as designed ("the day it is fixed, this file fails and
says which residual moved") — the implementer STOPPED AND REPORTED, the
grant was extended (`9678e05`), and residual 1 was retired
COUNT-NEUTRALLY: the file still carries 13 tests and the suite 6/75, so
the frozen phase-2 report's counts stay true; residuals 2–4 are
byte-identical (sha256-verified by the reviewer); row 1 now pins the
letter-leading compatibility promise, row 2 the inversion (the
previously-refused timestamp-shaped id STARTS; the scenario's own id
with a v4 nibble — accepted at base, a reproduced divergence — is
refused instead, naming no conflict). `scenario.ts` comment-only,
`INSTANCE_ID` unchanged, the frozen golden byte-identical throughout.

## Residuals (owned)

- **Phase-2 report R1 narrative** (`docs/experiments/
  phase-2-verification.md:277-291`) now describes a resolved conflict as
  OPEN — counts remain true; the dated orchestrator ADDENDUM (never a
  silent rewrite) lands in the docs round. Owner: orchestrator.
- `docs/adr/README.md:102` "stays until it lands" — stale on this
  merge. Owner: the same docs round.
- `test/unit/risk/fixtures.ts:28-43` paragraph (stale since ALLOC-1, not
  this round) and the `adr-021-instance-identity.test.ts:49,:99` prose —
  owner: the comment-staleness round (grant-permitted deferral).
- **Local `Uuid` asymmetry** (`config.ts:156`): `runId`/`configId`/
  `marketId` remain any-version UUIDs while `instanceId` is
  v7-enforced — the same five-identity-fields decision class as
  WP-180-FU3 r1 N4. Owner: a future designed round.
- r1 N5: three new rows assert verdict only (each mutation-killed
  today) — optional hardening. r1 N6: the tip refusal message does not
  name the version nibble as the defect — `packages/domain`'s shared
  message, not a TRDR-1 regression.

## Follow-ups (owned)

1. Docs round (orchestrator): the phase-2 R1 addendum; ADR-021's
   closing note (the "After it lands" step executed); the ADR README
   row.
2. The comment-staleness round (fixtures/scenario prose).
3. The five-identity-fields design decision (local `Uuid` + WP-180-FU3
   N4's approved-intent fields, as one round).
