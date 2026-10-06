# CI-7: run the emergency CLI's real-PostgreSQL suite in the integration chain and CI

**Status:** Complete (2026-10-06). Merged `9e28bc2` (PR #80; CI run `37436745021` green). It closes `CLOSEOUT-3` L1 and I5.
**Reviewer:** Codex gpt-6-astra. ACCEPT at round 2 on `a84268e`.
**Base:** `28333f2`.
**Paths:**
- the root `package.json` (`scripts` only);
- `.github/workflows/ci.yml`;
- `test/unit/tooling/**`;
- `test/integration/ops-cli/vitest.config.ts` (its follow-up comment only).

## summary

1. **The root `test:integration` chain** gains `pnpm --filter @polymarket-bot/ops-cli test:integration` as command 9/9. It is WP-330's suite: 6 tests on real PostgreSQL, covering the shipped bundle, the lease revocation and the audit mirror.
2. **`ci.yml`:**
   - a new step, "Integration tests 9/9 - ops-cli emergency CLI";
   - the integration steps renumbered x/9;
   - four stale container labels recounted and fixed (3/9, 4/9, 5/9 and 7/9; `CLOSEOUT-3` I5 and `CLOSEOUT-2` L3).
3. **The drift pin** (`ci-step-split.test.ts`, `ci-workflow.ts`) counts 4 + 6 + 9 + 6 chained commands, 32 gates and 25 split steps, with the integration chain pinned in full. It adds two rules:
   - **chain completeness:** every workspace package's `test:integration` or `test:integration:<x>` must be chained as `pnpm --filter <name> <script>`, or listed with a reason in `UNCHAINED_INTEGRATION_SCRIPTS`, which is empty. The workspace is read from `pnpm-workspace.yaml`, and symlinked packages are included (round 1's MEDIUM);
   - **filter existence:** every chained `pnpm --filter` command, in all four chains, must name a real package and script. pnpm 11.17 exits 0 when a filter matches no package, so a renamed package would otherwise leave a green step that ran nothing.

## tests_run
- **Unit:** 11,964 tests; the drift pin passes 41 of 41.
- **The full root `test:integration`:** 127 files and 1,326 tests, run uninterrupted once. A first run hit `TC-LOCAL-FLAKE` at 5/9, and that command passed when re-run alone.
- **The ops-cli suite:** 6 of 6, five times.
- **Mutation:** 24 file-level mutants, all failing the pin.
- **CI:** the PR #80 merge ref was green before the merge.

## known_risks
- **Step 9/9** runs esbuild inside the suite. The unit step already builds the same bundle on `ubuntu-latest`.
- **The node job** runs about 12 of its 30 minutes. That is still below CI-2's 6× margin rule (CI-5 follow-up 2).

## commit_sha
`a84268e`
