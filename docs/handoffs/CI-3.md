# CI-3 — run the secure-SDK contract suite in CI (WP260-L1)

**Status:** Complete (2026-09-30). Merged `a145fa4`, PR #32, CI run `36781066014`.
**Reviewer:** an independent Opus adversarial-reviewer. r1 CHANGES REQUIRED (CI3-1 HIGH: the CI-2 drift pin still counted four contract commands; CI3-2 LOW: the record omitted that test) → r2 ACCEPT; a planted sixth command without a step failed the pin.
**Files changed:**
- `package.json`: the `test:contract` chain adds `pnpm --filter @polymarket-bot/polymarket-secure test:contract`.
- `.github/workflows/ci.yml`: the contract steps are renumbered N/5, and a 5/5 step is added.
- `test/unit/tooling/ci-step-split.test.ts`: the pin moves to 4+5+6 chains, 23 gated steps and 15 split steps (closes CI3-2 by listing it here).

All five contract suites pass: 637 / 65 / 158 / 95 / 31.
