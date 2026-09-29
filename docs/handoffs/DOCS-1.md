# DOCS-1 — append-only documentation owed by the H8 track: the ADR-022 discharge note, ADR-018's third bundling pattern, and `DC1-R1-L1`

- **Package:** `DOCS-1`, authorized 2026-09-28 by the orchestrator
  (`IMPLEMENTATION_STATUS.md`, row `DOCS-1`, commit `ae25450`). It answers
  three queued rows: `ADR022-DISCHARGE`, `DC1-R1-L1` and `BUNDLE1-LOWS` (1).
- **Base:** `ae25450` (`main`). **Branch:** `docs-1`. **Date:** 2026-09-28.
- **Review:** an independent Codex review (the hardening loop) gates the
  merge, and a green GitHub Actions run is the orchestrator's step. The
  implementer did not review its own work. **This round is not marked
  complete here.**
- **Documentation only.** Six paths changed. Every edit is either an append
  or one table row. No code, test, tool, manifest, lockfile or
  `IMPLEMENTATION_STATUS.md` was touched.
- **Safety:** `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both
  live-micro caps at `0` are unchanged. No venue fact is introduced.

---

## What changed

1. **`docs/adr/ADR-022-shared-trading-core-is-a-layer-1-package.md`**
   (append-only). A dated closing note follows the ADR-021 precedent
   (`e6548cf`): a heading, then "Append-only; nothing above this line
   changed.", then the note. It records:
   - the four merges;
   - the measured graph, re-measured at each merge;
   - D1 and D5 as realized, D6 held and D7's facades;
   - B3 CLOSED;
   - three dated statements that `DEPCHECK-1` changed, each re-measured;
   - what stays open.
2. **`docs/adr/README.md`** (the ADR-022 row only). The title cell gains a
   DISCHARGED sentence with the four merge SHAs. The "Implemented by" cell
   changes from "(pending)" to "(done, `<sha>`)".
3. **`docs/adr/ADR-018-app-local-esbuild-runtime-build-convention.md`**
   (append-only). An evidence addendum in the same form records the third
   pattern (ESM plus the `createRequire` banner) and why CJS was rejected
   for the trader. It also records the pin, and `BUNDLE1-LOWS` (2) and (3)
   as latent residuals. It states that no decision changes.
4. **`docs/contracts/dependency-direction.md`** (the §3 F16 Source cell
   only). `import.meta.resolve("<relative>")` joins the not-covered list,
   beside `require.resolve`.
5. **`docs/handoffs/DEPCHECK-1.md`** (append-only). A dated addendum records
   the same missing form, with the measurement.
6. **This record.**

## Evidence

Everything below was run in the worktree, or in scratch copies under the
session scratch directory `…/scratchpad/docs-1/`.

### Append-only proofs

For each file, the base blob (`git show ae25450:<path>`, N bytes) was
compared with the first N bytes of the new file, using `cmp -n N` and also
`head -c N | sha256sum`. `git diff --numstat` shows 0 deleted lines for each
file.

| File | Base bytes | Base sha256 | Prefix |
| --- | --- | --- | --- |
| `docs/adr/ADR-022-shared-trading-core-is-a-layer-1-package.md` | 28167 | `f74167db…ca7573` | identical |
| `docs/adr/ADR-018-app-local-esbuild-runtime-build-convention.md` | 6005 | `595ef1af…62fa75` | identical |
| `docs/handoffs/DEPCHECK-1.md` | 17701 | `b54753fc…9322ac` | identical |

### Single-row proofs

A scratch script (`cell-proof.cjs`) compared base and candidate line by
line, then cell by cell. It splits each row on `" | "` and prints each
changed cell's removed and inserted text.

- **`dependency-direction.md`:**
  - 1,049 lines before and after, and one line changed: 662, the `| F16 |`
    row;
  - three cells before and after, and one cell changed: cell 2, Source;
  - nothing is removed. The inserted text is the form
    `import.meta.resolve("<relative>")` and its dated attribution, placed
    between `require.resolve` and "a `/// <reference path>`".
- **`README.md`:**
  - 213 lines before and after, and one line changed: 103, the
    `| [ADR-022]` row;
  - five cells before and after. Cell 1 (the title) is only appended to.
    Cell 4 ("Implemented by") changes each "(pending)" to "(done, <merge>)",
    with `33b7d0b` for `CORE-MOVE` and `fd12be0` for `BACKTEST-2`.

### `check:deps` is unchanged

`node tools/check-dependency-direction.mjs --json` gives byte-identical
output at base and on the candidate:

- sha256 `6a0bb1d8…a8adce` both times;
- `ok=true`, 35 packages, 90 edges, allowlist S0..S18, 0 violations.

The checker reads this file for §2 and §2.1. §3 falls under its "other"
sections. The F16 cell change is therefore inert to the check, and the
byte-identical `--json` output is the proof.

### Facts checked

Each fact cited in the new text was checked at `ae25450` unless another
commit is named.

- **SHAs.** `git log -1` and `git merge-base --is-ancestor <sha> HEAD` were
  run for each of these. All are ancestors of the base:
  - the merges `bb58edb` (H8-GOV; parents `a8a3a63`, `c41673b`), `d7f2906`
    (DEPCHECK-1; `45c575a`, `ff553e3`), `33b7d0b` (CORE-MOVE; `ac0b12f`,
    `d7c97db`), `fd12be0` (BACKTEST-2; `f8aedec`, `7238ad7`) and `fd30e5f`
    (BUNDLE-1; `1ad2a36`, `8c03d71`);
  - `e6548cf` (the ADR-021 precedent), and the bases `a8a3a63`, `ac0b12f`
    and `1ad2a36`.

  `d7f2906`'s merge message records the Fable r1 ACCEPT and `DC1-R1-L1`.
- **The graph counts.** Each tree was extracted with `git archive <sha>` and
  checked with `--root <tree> --json`. The checker is unchanged since
  `d7f2906` (`git diff d7f2906 HEAD -- tools/check-dependency-direction.mjs`
  is empty).
  - `ac0b12f`: 34 packages / 80 edges, S0..S7.
  - `33b7d0b`: 35 / 89, S0..S18, `packages/trading-core` layer 1.
  - `fd12be0`: 35 / 90. Its output is byte-identical to the base's, because
    the base differs from `fd12be0` only in `IMPLEMENTATION_STATUS.md` and
    `WAVE-2-HANDOVER.md`.
  - Edge-list diff `33b7d0b` → `fd12be0`: added
    `apps/backtest-cli` → `packages/trading-core`, removed none.
  - These agree with `dependency-direction.md` §6's two dated notes, and with
    the `CORE-MOVE` and `BACKTEST-2` records.
- **D1.** Each of the 25 closure files exists under
  `packages/trading-core/src`, and none exists under `apps/trader/src`.
- **D5.**
  - `buildSimulatedVenue` is at `venue-builder.ts:159`, and its
    `new SimulatedVenue(` at `:176` (comment at `:18`).
  - `git grep "new SimulatedVenue(" -- apps packages test ':!packages/simulation'`:
    every other hit is a `*.test.ts` file.
  - The callers of `buildSimulatedVenue(` are `apps/trader/src/main.ts:398`,
    `apps/backtest-cli/src/assembly.ts:260`,
    `test/e2e/support/harness.ts:138` and
    `test/integration/paper-trader/support/fixture.ts:653`.
  - `backtest-replay-support.ts` imports `apps/backtest-cli/src/index.js`.
  - `InMemoryTraderStore` is at `memory-store.ts:81`, and it is constructed at
    `assembly.ts:272`. Its imports are type imports, `./pnl-snapshot-key.js`
    and `./ports.js`; nothing comes from `testing/`.
  - Both apps' manifests declare `@polymarket-bot/trading-core`.
- **D6.** `git rev-parse` gives equal blobs for `a8a3a63:apps/trader/src/safety.ts`
  and `HEAD:packages/trading-core/src/safety.ts` (`1b857bb…`), and likewise
  for `config.ts` (`890c350…`).
- **D7.** `apps/trader/src/testing/index.ts` is
  `export * from "@polymarket-bot/trading-core/testing"`, and
  `apps/trader/src/index.ts` re-exports the core.
- **B3.** `IMPLEMENTATION_STATUS.md` row **B3** reads "B3 CLOSED 2026-09-28
  by `BACKTEST-2` (merged `fd12be0`)".
- **Dated statements, re-measured.** Each was run in a scratch copy of
  `ae25450` with `--root <copy> --json`:
  - from `packages/trading-core/src`, a relative re-export of
    `../../storage-postgres/src/index.js` gives F16;
  - the same re-export by package name, undeclared, gives exit 0;
  - `pg`, declared and imported, gives exit 0;
  - `ethers`, declared and imported, gives exit 0;
  - with the core's `strategy-static-bracket` dependency removed, the result
    is `CHK` on S18 (35 / 89);
  - `apps/backtest-cli` declaring `@polymarket-bot/trader` gives F10
    (35 / 91).

  The checker has no `F17` rule id (`grep` finds none).
- **`DC1-R1-L1`.** In a scratch copy of `ae25450`,
  `apps/backtest-cli/src/probe-resolve.ts` with
  `import.meta.resolve("../../trader/src/main.js")` gives exit 0 and no
  violation. The control, `export * from "../../trader/src/main.js"`, gives
  exit 1 and one F16. The checker's header explains the gap at `:157-159`.
- **ADR-018 addendum.**
  - `apps/trader/package.json` `build` carries the banner with
    `--format=esm` and `--outfile=dist/main.mjs`, and `data-gateway` is
    `--format=cjs`.
  - `packages/event-bus/package.json` declares `ioredis`, and
    `apps/trader/package.json` does not.
  - `loader.ts:33` is `new URL("../../../../db/migrations", import.meta.url)`,
    and `storage-postgres`'s index re-exports `./migrations/index.js`, which
    re-exports `./loader.js`.
  - The trader's `await startup(` is at `main.ts:539` at `ae25450` and at
    `:655` at `1ad2a36`.
  - The trader's entry guard is `endsWith("/main.mjs")` (`:537`),
    control-api's is `endsWith("main.mjs")` and backtest-cli's is
    `endsWith(".mjs")`.
  - `DEFAULT_MIGRATIONS_DIRECTORY` and `readMigrations` appear, outside
    tests, only in `packages/storage-postgres` (`loader.ts`, `runner.ts`,
    `cli/migrate.ts`).
  - The pin lists the five apps (`BUNDLED_APPS`, `:94`), and its coverage
    guard is `startsWith("esbuild ")` (`:181`).
  - The M18 row reads "CLOSED by `BUNDLE-1`".

### Gates

All gates ran with `pnpm_config_verify_deps_before_run=false`. No
`pnpm install` was run.

**The environment as found.** Neither this worktree nor the main checkout
has the gitignored workspace link
`apps/backtest-cli/node_modules/@polymarket-bot/trading-core`. `BACKTEST-2`
added that dependency, and CI's frozen install creates the link. Without it,
the base as found gives:

- `typecheck`: exit 2, with `TS2307` in `apps/backtest-cli`;
- `test`: exit 1, with 5 files failing to load (`Cannot find package
  '@polymarket-bot/trading-core'`), 348 files passing and 7,562 tests
  passing.

I added that one link by hand, as a relative symlink to
`packages/trading-core`. This follows the orchestrator's `CORE-MOVE` gate
recipe. The `@polymarket-bot` directory is this worktree's own (its inode
differs from the main checkout's), so no shared file changed. With the link
in place:

| Gate | Base `ae25450` | Candidate |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm run lint` | exit 0 | exit 0 |
| `pnpm run check:deps` | exit 0, 35 / 90, S0..S18 | exit 0, `--json` byte-identical |
| `pnpm run test` | exit 0, 353 files / 7634 tests | exit 0, 353 files / 7634 tests |

The link was removed after the gates, which leaves the worktree as found.

## Decisions and disclosures

- **"D4 (S18's sunset)".** In the packet, "D4" is the H8 scoping's name for
  the strategy-agnostic core, as ADR-022 Context 6 records it. In ADR-022's
  own numbering, that round is D9, which removes S18. D4 is the list S18
  leaves. The note names both, so neither reading is lost.
- **More than the packet's list, all inside the ADR-022 append:**
  - D1 realized;
  - D6 held;
  - the three dated statements `DEPCHECK-1` changed (D3's third bullet, D9's
    third bullet, Alternatives B);
  - a third open item, D3's catalogue binding (`H8-GOV` `follow_up` 5) and
    F17.

  Leaving them out would let the ADR read as if D3, D9 and B still
  described the current check. Each one was re-measured, not copied.
- **ADR-018's "§1-§4".** ADR-018 numbers its items 1-4 under "Decision".
  The packet and the repository's records (`BUNDLE-1`, `CORE-MOVE`) cite
  them as §1-§4, so the addendum says so once and uses that form. It also
  states that §3 is unaffected.
- **The F16 cell** carries a short dated attribution ("added 2026-09-28 by
  `DOCS-1`: measured, it is not judged"). This follows the contract's habit
  of dating in-cell changes.
- **ADR-022's header** ("Implemented by: … (pending) … No implementation
  exists yet.") is left as written. The closing note says it is superseded,
  as ADR-021's closing note did for its own interim text.

## Follow-ups (outside this grant)

- **`dependency-direction.md` statements that are still stale** (from
  `DEPCHECK-1` "Follow-ups" and `CORE-MOVE` decision 5):
  - §2.2's closing paragraph ("F17 joins F15 and F16 as a stated rule the
    checker does not evaluate");
  - §6.1 item 4's status line;
  - the dated `a8a3a63` sentences in the §2 paragraph and row S18. These are
    still true as dated statements.

  This round's grant was the F16 cell only.
- **`BUNDLE1-LOWS` (2)-(5)** stay with the next tooling or apps round. This
  round only records (2) and (3).
- **`H8-GOV` `follow_up` 5** (H8G-01): a governance round decides whether a
  §3 rule binds the core to the database-client and signing-library
  catalogues.
- **The facade retirement** (ADR-022 D7) and **S18's sunset** (D9) stay
  open.
- **Environment:** the main checkout lacks the
  `apps/backtest-cli` → `trading-core` workspace link. A local gate run
  there fails `typecheck` and five unit files until the link exists.
- `IMPLEMENTATION_STATUS.md`'s `DOCS-1`, `ADR022-DISCHARGE`, `DC1-R1-L1` and
  `BUNDLE1-LOWS` rows are the orchestrator's.
