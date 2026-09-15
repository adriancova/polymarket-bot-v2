# GATE-1 completion record — gate the evidence; clear the audit step

**Merged:** `0434c82` (`--no-ff`, 2026-09-15). One commit `b470880` on base
`f41fb8d`. Review round 1 **ACCEPT** (1 MEDIUM, 3 LOW, 3 NOTE — all
residual/follow-up class; no gate is vacuous today).

**What it is.** The tooling half of the GOV-2B closeout: findings **B6**, **B7**,
**N4** and **N5**. Three files, no source change, no test-assertion change.

## What shipped

1. **B7 — CI could not reach its integration step.** `pnpm run audit` exited 1 on
   `GHSA-2883-xcg3-v3hh` (js-yaml, dev-only transitive of eslint via
   `@eslint/eslintrc`), and `ci.yml` runs `audit` before the integration step.
   Fixed by `pnpm update js-yaml --recursive --lockfile-only`: a **4-line**
   `pnpm-lock.yaml` change, `4.3.1 → 4.3.2`. No `pnpm.overrides` entry was
   needed — `@eslint/eslintrc` already declares `js-yaml: ^4.3.0`, so the
   advisory was a stale lockfile resolution. **The threshold is untouched**
   (`--audit-level high`, no ignore list, no suppression).
2. **B6 — the evidence ran in no gate.** The six `test/e2e/**` suites — the
   Phase-2 evidence for four of the seven §7 checklist items — are now gated by
   an explicit `pnpm test:e2e` CI step. The root-include route was probed and
   fails technically: `test/e2e/**` sits outside every workspace member, so the
   bare `@polymarket-bot/*` specifiers have no `node_modules` to resolve
   through, and **5 of 6 suites fail to load** under the root config.
3. **N4 — `test:replay` was partly dead.** Its `test/replay-golden` positional
   matched zero test files (that tree holds fixtures and READMEs). It now names
   `test/unit/order-book/replay-golden.test.ts` — whose describe is literally
   "WP-150 acceptance 1" — and `pnpm test:replay` is a CI step, making true the
   claim `infra/grafana/control/fidelity-dashboard.json:83` and
   `packages/observability/src/control/dashboards.ts:160` already made to
   readers ("determinism is a GATE … `pnpm test:replay` must pass").
4. **N5 — two step labels over-credited their commands**: the integration step's
   "Testcontainers - PostgreSQL and Redis" (only two of six chained suites use
   containers) and the audit step's unstated threshold. Both corrected; every
   other label in all three jobs audited and found accurate.

## What the review established independently

- **All six e2e suites broken, each with the reviewer's own assertion in its own
  chosen file** — every one failed the gate. No newly gated suite can be broken
  without the gate failing; zero `.skip`/`.only`/`.todo` anywhere in the tree.
- **The N4 counterfactual re-derived at a different assertion than the
  implementer used**: with the acceptance-1 byte-for-byte serialization broken,
  the OLD script exits **0** and the NEW exits **1**. The gate the dashboards
  cite as the determinism authority had been passing over a broken acceptance
  test. `test/unit/simulation/golden-replay.test.ts` proven non-vacuous too.
- **The lockfile change is exactly and only the js-yaml bump**: all 405
  package/snapshot keys diffed, exactly one changed; the `importers:` section
  byte-identical; the integrity hash verified against the live registry; 4.3.2
  confirmed the minimal patched version.
- **The gate is lockfile-driven, not green by accident**: swapping the base
  lockfile back while leaving `node_modules` untouched returns exit 1.
  `pnpm install --frozen-lockfile` accepts the pin (proven in an isolated
  scratch workspace, never in the worktree).
- **B7's consequence is discharged in effect**: the reviewer ran the previously
  unreachable integration step green (**54 files / 568 tests**) and the python
  job's `pip-audit --strict` step, so "run full CI" now succeeds end to end
  locally.
- **N5 recounted from scratch by a method independent of `globalSetup`**: 32 of
  54 integration files are not container-backed. The closeout's 30 was wrong;
  the round's 32 is right, and the round flagged the discrepancy itself.

## Gates at the merged tip `b470880`, and on `main` at `0434c82`

`typecheck`, `lint`, `check:deps` 0; `pnpm run test` **323 files / 7082 tests**
(identical to base — the diff touches no test file and no vitest config);
`test:e2e` 6/75; `test:replay` **2 files / 9 tests** (was 1/6); `test:fault`
11/89; `test:contract` 27 files / 901 tests; `audit` **exit 0** (was 1).
Post-merge on `main` after `pnpm install --frozen-lockfile --offline`: every one
re-run green.

## Residuals (owned)

1. **`GATE1-M1` (MEDIUM) — `test:replay` is a hand-maintained positional list
   that can silently shrink back to the exact N4 defect.** vitest fails only when
   the *total* filtered set is empty, so if ONE named file is renamed or moved
   the gate drops it and still exits 0. Proven by the reviewer (one positional
   matching nothing → exit 0; both matching nothing → exit 1). Not a present
   defect — both files were broken and both failed the gate — but a regression
   path. **The complete fix needs a grant over `test/unit/**`, which GATE-1 did
   not have.** Owner: a follow-up round; a guard test asserting both golden
   files exist by path, or one directory named in the script.
2. **`GATE1-R2` (LOW) — the B6 justification was a false dichotomy.** A vitest
   `projects` entry in `test/vitest.config.ts` (inside the grant) works, keeps
   each project's own aliases and 60s timeouts, and defeats both stated
   objections — the reviewer built and ran it. The CI-step route is still
   defensible and was explicitly authorized, and the projects route would change
   `pnpm run test`'s 323/7082, a count pinned across the ledger. **Recorded so
   the justification says "declined for count stability" rather than implying no
   third option existed.**
3. **`GATE1-R3` (LOW) — js-yaml 4.3.2 has never executed here.** The bump was
   lockfile-only, so local `node_modules` still holds 4.3.1 and every gate run
   so far used it. CI's frozen install will materialize 4.3.2; attribute any
   lint/typecheck surprise on the first real CI run to this bump, not to GATE-1's
   wiring.
4. **`GATE1-R4` (LOW) — B7's structural cause survives its instance.** The `node`
   job is one fail-fast chain with no `if:` anywhere, so `test:e2e` failing now
   hides five downstream steps — the same pathology B7 named. Out of GATE-1's
   scope. Candidate remedy: `if: ${{ !cancelled() }}` on the independent test
   steps, or splitting them into parallel jobs.
5. `GATE1-N1` (NOTE) the alias block is 17, not the 18 the commit message says.
   `GATE1-N2` (NOTE) the new e2e label does not name the three doubled §12.1/§4.2
   seams, by the standard the round applied to the integration label.
   `GATE1-N3` (NOTE) `docs/experiments/phase-2-verification.md:360` records the
   superseded `test:replay 6/6`; `docs/**` was outside the grant.
6. **Structural, carried:** both candidate gate homes (`ci.yml`,
   `test/vitest.config.ts`) are editable by future packages and neither
   self-checks — a deleted CI step fails no test.
7. **Carried, not GATE-1's:** gating `test/e2e/**` adds regression detection but
   no coverage of the real durable store. GOV-2B **B1** (TRDR-2) is the binding
   gap, and this suite's in-memory doubles are exactly what mask it.

## Follow-ups (owned)

- `GATE1-M1`'s tripwire, in a round granted `test/unit/**`.
- `GATE1-R4`'s CI restructuring so one red step stops erasing the evidence of
  five others.
- Have `ci.yml` invoke the `audit` and `test:compose` scripts rather than
  inlining the same commands, removing the drift risk.
- Track the vitest 4.x bump to clear the two remaining moderate advisories
  (`GHSA-82fw-gwwq-j7x9`), which pass the unchanged `high` threshold and are now
  disclosed by the corrected label.
- **N7 stands and this round adds a tenth touch:** nine of eleven Wave 2 merges
  modified the protected `pnpm-lock.yaml` with only one ratified. Disclosed here
  for ratification.
