# DEPS-3: patch tinypool (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) and source-map-js (GHSA-68fv-2mgg-jv7q)

**Status:** Complete (2026-10-05). Merged `1237afe` (PR #76; CI run `37412071507` green). An orchestrator-authorized CI-health fix.
**Reviewer:** an independent Claude Fable adversarial-reviewer. ACCEPT at round 1 on `5411d0f`.
**Base:** `f0243f7`.
**Paths:** `pnpm-lock.yaml` and `pnpm-workspace.yaml` (the overrides section only).

- **Why:** two critical advisories against `tinypool`, and one high advisory against `source-map-js`, were published on 2026-10-05. They made `pnpm audit --audit-level high` fail on every PR (first seen on PR #75, CI-6), blocking CI-6, TRADER-SIGNALS and VENUE-4.
- **The changes:**
  1. **`source-map-js`:** a lockfile-only, in-range bump, 1.2.1 → 1.2.2. Its only dependent, postcss 8.5.26, accepts `^1.2.1`.
  2. **`tinypool`:** one override, `vitest@3>tinypool: ^2.2.0`, in `pnpm-workspace.yaml`. pnpm 11.17 no longer reads `pnpm.overrides` from `package.json`.
     - It resolves to 2.2.0, and vitest stays at 3.2.7.
     - It is scoped to vitest 3: once vitest moves to 4 or later, which drops `tinypool`, the entry does nothing.
- **Compatibility:**
  - The implementer compared every `tinypool` function, option and export that vitest 3.2.7's pool code uses against the published 1.1.1 and 2.2.0 code. All are unchanged, and the child-process worker entry is byte-identical.
  - The changelog items between them: Node 18 dropped; a default CPU count vitest overrides; the two prototype-free option copies (the fixes); two additive options.
- **Evidence:**
  - All 25 vitest configs give the same file and test counts before and after: unit 11,893; e2e 216; replay 19; every contract, fault and integration suite, the CI-6 additions included.
  - No log shows a pool error or a hang.
  - A clean `pnpm install --frozen-lockfile` succeeds.
  - An A/B run of the unit suite shows no consistent speed change.
- **No runtime exposure:** every path to either package ends at a devDependency, and none of the 7 app bundles' esbuild inputs include them.
- **Result:** the audit exits 0. Two moderate advisories in vitest and @vitest/mocker 3.2.7 remain; see `DEPS1-VITEST`, which a vitest major would clear.
- **Follow-up:** the vitest major upgrade (the `DEPS1-VITEST` tooling round). It would also retire this override.
