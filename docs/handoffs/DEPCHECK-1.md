# DEPCHECK-1 — the H8 track's checker-hardening round: F10, the §2.1 row checks, the relative half of F16 (with `CI2-L5-2` and `CI2-L5-3` riding along)

- **Package:** `DEPCHECK-1`, the optional checker-hardening round that
  `docs/handoffs/H8-GOV.md` ("The optional checker-hardening grant") defines.
  `IMPLEMENTATION_STATUS.md` authorizes it (2026-09-28). The orchestrator
  widened the grant to `test/unit/tooling/{ci-step-split.test.ts,ci-workflow.ts}`
  for the two `CI-2` review LOWs.
- **Base:** `45c575a` (`main`, with `H8-GOV` merged). **Branch:**
  `depcheck-1`. **Date:** 2026-09-28.
- **Review:** a Fable adversarial reviewer (the hardening loop) gates the
  merge, and a green GitHub Actions run is the orchestrator's step. The
  implementer did not review its own work. **This round is not marked
  complete.**
- **Paths touched:** the five the grant names, and nothing else:
  - `tools/check-dependency-direction.mjs` (items 1-4);
  - `test/unit/tooling/dependency-direction.test.ts` (12 new tests, 0 lines
    removed);
  - `test/unit/tooling/ci-workflow.ts` and `ci-step-split.test.ts` (the two
    ride-alongs; 6 new tests, 0 existing assertions changed);
  - `docs/contracts/dependency-direction.md` (the §3 F10 and F16 Source cells,
    the §5 check row, the §6 rule 2 and rule 3 text);
  - this record.

  The §2 fences, the §2.1 table, the §2.1 PENDING subsection, §4 and §6.1 are
  byte-identical to base.

---

## What changed

### The check (`tools/check-dependency-direction.mjs`)

1. **F10, in rule 2.**
   - A declared workspace edge into an `apps/**` package fails F10, whatever
     the two layers and whatever §2.1 says. "Declared" means any of
     `dependencies`, `devDependencies`, `peerDependencies` or
     `optionalDependencies`.
   - F12 is unchanged, so an upward edge into an app reports F12 and F10.
   - A same-layer edge into an app reports F10 **in place of** F13. F13's
     remedy is "add a cited §2.1 row", and item 2 makes that row a `CHK`
     error. Every edge that failed at base still fails.
   - Probe P2 (`apps/backtest-cli` declares `apps/trader`) was F13 at base and
     is F10 now.
2. **A §2.1 row whose `to` endpoint is an application is a `CHK` error**,
   citing F10, in `parseContract`'s cross-validation.
   - "Application" covers a concrete or glob path under `apps/`, and a glob
     spelled another way (`a*/trader`) that matches a §2 `apps/…` assignment.
   - Probe P3 (the app-to-app row plus its dependency) passed at base, and is
     `CHK` + F10 now. The row alone is one `CHK`.
3. **The relative half of F16, in rule 3.**
   - A relative specifier fails when it resolves, lexically from the
     importing file, outside the importing package's root: into another
     package, an application, or no package at all.
   - It also fails when it passes through a `node_modules` directory. That is
     how the reviewer's "`../` through a symlinked `node_modules`" reaches
     another package, and it is the same deep import by a longer path.
   - **Forms judged:** every specifier rule 3 records as a literal:
     - static `import` and `export … from`, type-only and `export *` included;
     - `import x = require(…)`;
     - an `import("…")` type;
     - a dynamic `import()` with a string or no-substitution template;
     - a `require`-family load.

     Each form is pinned by the P8 test.
   - Probe P8 (`apps/backtest-cli/src/x.ts` importing
     `"../../trader/src/trader.js"`) passed at base, and is F16 now.
4. **A §2.1 row that matches no declared edge is a `CHK` error**, reported
   after rule 2. Three kinds of row are exempt:
   - a row that already failed cross-validation, so one defect gives one
     finding;
   - a row naming a class glob that matches no workspace package, following
     §6's "a class matching zero packages is not an error". The existing test
     that removes `packages/strategies/static-bracket` depends on this;
   - a row naming a path with no manifest, whose §2 entry is already
     `F-CLOSED`.

   With this check, removing S18 becomes a gate result, where ADR-022 D9
   relied on review.
5. **Report text:** the header, the PASS lines and `--help` name F10, F16
   and the two row checks. The `--json` shape is unchanged: the new internal
   `crossValidated` flag is not serialized.

### The contract (`docs/contracts/dependency-direction.md`)

- **§3 F10 Source cell:** F10 is enforced, and the cell says how. It says F13
  gives way to F10, and that an import of an app by package name, with no
  manifest entry, is not checked.
- **§3 F16 Source cell:** the relative half is enforced. The cell gives its
  scope, which is wider than a deep import on purpose, the forms it judges,
  and what it does not cover. The bare-name half is still not implemented.
- **§5 check row:** now lists F10, the relative half of F16 and the two row
  checks.
- **§6 rule 2:** the F10 bullet, and the two row `CHK`s with their exemptions.
- **§6 rule 3:** the F16 sentence, and that `test/**` and `tools/**` are
  outside the rule.

### The CI drift pin (`ci-workflow.ts`, `ci-step-split.test.ts`)

- **`CI2-L5-2`: a gate's `run` is read as commands.**
  - A `run` splits into commands at unquoted newlines and `;`. Blank lines
    and `#` comments are not commands, and a trailing `\` continues the line.
  - Each command is followed to a chained root script, not only the first
    line.
  - A gate that runs more than one command in one step is a finding.
  - The exception is a block recorded in `DEPENDENT_RUN_BLOCKS`, matched on
    its job, its step name and its **exact** text, with a stated reason.
  - A record that no gate matches is itself a finding.
- **Today's two blocks.**
  - The python audit step is recorded. Its second line
    (`uvx pip-audit … -r /tmp/requirements-audit.txt`) reads the file its
    first line writes, and the pin asserts both halves of that.
  - The compose job's block is not a gate: that job has one step and is not in
    `GATED_JOBS`.
  - The header now says both.
- **`CI2-L5-3`: a shell-word reader follows the other root-script
  spellings.**
  - The review's five: `pnpm -C .`, `pnpm --dir .`,
    `pnpm --filter polymarket-bot`, `pnpm run "<s>"` and `npm run <s>`.
  - Their neighbours:
    - `--dir=.` and `-C ./`;
    - `--filter=`, `-F`, `…...`, `.` and `{.}` as root selectors;
    - `-w`, `--workspace-root` and `--include-workspace-root`;
    - single-quoted script names;
    - `NAME=value` prefixes;
    - `npm run-script`, `npm --prefix .`, and `npm test`/`t`/`start`.
  - **What stays off the root:**
    - `-r`;
    - a `-C`/`--dir`/`--filter` naming anything else;
    - npm `-w`/`--workspace`/`--workspaces`;
    - a word the reader cannot read (an unquoted `$`, a backquote or a
      backslash).
  - **Misreads over-report:** an option the reader does not know is taken
    for a flag, and the script is the first later word that names a root
    script. So a misread can only over-report.
  - The header's false claim ("a flag … never matches") is replaced by this
    grammar, and by the list of what is not followed.

## Evidence

All of it was run in the worktree or in scratch copies under the session
scratch directory `…/scratchpad/depcheck-1/`. The tracked tree was restored
after every probe and checked by hash.

**The repository report is byte-identical.** `node
tools/check-dependency-direction.mjs --json` at base and on the candidate:
`ok=true packages=34 edges=80 allowlist=S0,S1,S2,S3,S4,S5,S6,S7
violations=0`, sha256 `1a8c2347…aaabd0` both times.

**Census.** An independent TypeScript walk (`census.cjs`) covered 34
packages and 697 source files. It found:
- 3,339 specifiers in all (the scoping counted 3,337 in 696 files at
  `60a5d7e`);
- 2,412 relative specifiers in 555 files;
- **0** that leave their package root, and **0** through `node_modules`.

The one path-based reference that leaves a package is a data read, not an
import: `packages/storage-postgres/src/migrations/loader.ts:33`,
`new URL("../../../../db/migrations", import.meta.url)`. It is outside F16.
No symlink is tracked, and none exists outside `node_modules` under `apps/`
or `packages/`.

**The H8-GOV activation dry run and the hazard probes.**
- **Method:** H8-GOV's `activate-probe.cjs`, adapted as `activate-dc1.cjs`:
  - the mirror is a tar copy of the worktree;
  - the staged PENDING text is read out of its fences exactly as written;
  - the checker is passed explicitly.
- **Base:** the base checker reproduces H8-GOV's recorded lines exactly.
- **Candidate:**

```text
[AS-IS] exit=0 ok=true packages=34 edges=80 allowlist=S0..S7 violations={}
[P2-APP-DEP] exit=1 packages=34 edges=81 violations={"F10":1}          (base: {"F13":1})
[P3-APP-ROW] exit=1 packages=34 edges=81 violations={"CHK":1,"F10":1}  (base: exit 0, {})
[P3-ROW-ONLY] exit=1 packages=34 edges=80 violations={"CHK":1}         (base: exit 0, {})
[P8-RELATIVE] exit=1 packages=34 edges=80 violations={"F16":1}         (base: exit 0, {})
[STALE-S6] exit=1 packages=34 edges=79 violations={"CHK":1}            (base: exit 0, {})
[ACT] exit=0 ok=true packages=35 edges=93 layer(trading-core)=1 allowlist=S0..S18 violations={}
[ACT+PROSE] exit=0 ok=true packages=35 edges=93 allowlist=S0..S18 violations={}
[ACT+TRADER] exit=0 ok=true packages=35 edges=94 allowlist=S0..S18 violations={}
[ACT+TRADER+BT] exit=0 ok=true packages=35 edges=95 allowlist=S0..S18 violations={}
[ACT+CLOSURE+TRADER+BT] exit=0 ok=true packages=35 edges=95 allowlist=S0..S18 violations={}  (new variant; base: same)
[FENCE-NO-MANIFEST] exit=1 violations={"F-CLOSED":1}                   (base: same)
[ROWS-NO-FENCE] exit=1 violations={"CHK":11}                           (base: same)
[FENCE+ROWS-NO-MANIFEST] exit=1 violations={"F-CLOSED":1}              (base: same)
[S18-NO-EDGE] exit=1 packages=35 edges=92 allowlist=S0..S18 violations={"CHK":1}  (base: exit 0, {})
```

`ACT+CLOSURE+TRADER+BT` is new in this round. It copies the 25 real closure
files of `createPaperTrader`/`CoreLoop` into `packages/trading-core/src` at
their relative paths, so rule 3, F16 included, reads the files `CORE-MOVE`
will move.

**The new tests, inside an activated `CORE-MOVE` mirror.** The mirror is the
`ACT+CLOSURE+TRADER+BT` copy with `node_modules` linked.
- The 12 new tests all pass there.
- The whole file fails exactly 2 tests, and the base checker with the base
  suite fails the same 2:
  - "does not treat a strategy class entry matching zero packages as an
    error" (:654);
  - "keeps the shipping contract valid under all of the above" (:1017).
- Those are the two pinned tests `CORE-MOVE`'s grant already lets it edit. So
  this round adds nothing `CORE-MOVE` must change.
- The fixtures that drop an edge or a package read the edge's consumers from
  the real manifests, so they stay exact when the core adds 13 edges.

**The new tests fail against base.** The whole file ran against the base
checker: **10 failed, 189 passed** (199). Every positive test failed. The 2
that pass are negatives:
- "leaves relative imports that stay inside the importing package alone…";
- "leaves a row whose package has no manifest to F-CLOSED…".

Each negative is killed by a mutant below.

**Checker mutants (14).** Each mutant was run against the full test file.
Every one is killed:

| Mutant | Tests failed |
| --- | --- |
| M1 no F10 push | 3 |
| M2 F13 not suppressed on an app target | 2 |
| M3 app token matched literally only | 1 |
| M4 no cross-validation skip | 2 |
| M5 no `node_modules` clause | 1 |
| M6 root prefix without `/` | 1 |
| M7 every glob row exempt | 1 |
| M8 no missing-package exemption | 1 |
| M9 no F16 | 2 |
| M10 F16 on every relative specifier | 7 |
| M11 the root itself counted outside | 1 |
| M12 no zero-match class exemption | 1 (the existing :654 test) |
| M13 no stale check | 3 |
| M14 no app-row `CHK` | 3 |

One mutant survived an earlier draft: excluding self-edges from the stale
match changes nothing observable, because a self-edge is already F9. That
clause was deleted, not kept untested.

**The CI pins fail against base.** A scratch script (`ci-proof.mts`) ran each
new synthetic workflow through base's `splitStepDrift` and the new one.
- **32/32 cases give no finding under base**, and each gives its finding
  under the new check.
- The cases: six for `CI2-L5-2` (a two-line block, the `;` line, a
  three-command block, a chain on line 2 twice, and the grown audit block),
  and 26 spellings for `CI2-L5-3`.
- The real `ci.yml` gives 0 findings under both.

**CI mutants (15), all killed:**
- C1 every directory is the root;
- C2 `-r` not off-root;
- C3 npm `--workspace` ignored;
- C4 unreadable words read as plain;
- C5 no `\` continuation;
- C6 comments as words;
- C7 recorded blocks ignored;
- C8 no stale-record check;
- C9 `;` not a separator;
- C10 first command only;
- C11 no `...` suffix;
- C12 `^` selects the root;
- C13 no multi-command rule;
- C14 the filter name ignored;
- C15 npm `--prefix` ignored.

C3 survived the first draft: npm parsing stopped at the option's value word.
The fix made npm parsing pass over unknown words, like pnpm, and added the
`--workspace=` and `--workspaces` negatives.

**Timing.** `dependency-direction.test.ts`, run alone in two alternating
rounds, as reported by vitest:
- base: 38.7 s and 39.2 s, for 187 tests;
- candidate: 41.3 s and 41.1 s, for 199 tests;
- so the file grows by about 2.3 s.

Every new test spawns through the file's existing async `spawnNode` and does
no synchronous work. `no-synchronous-spawn.test.ts` passes. The CI pin file
stays under 0.2 s.

**Gates.** Every gate below ran on the final tree, with
`pnpm_config_verify_deps_before_run=false`, and each exited 0:

| Gate | Base `45c575a` | Candidate |
| --- | --- | --- |
| `pnpm run typecheck` | 0 | 0 |
| `pnpm run lint` | 0 | 0 |
| `pnpm run check:deps` | 34 packages / 80 edges, S0..S7 | 34 / 80, S0..S7 |
| `pnpm run test` | 348 files / 7576 tests | 348 / 7594 (+18: 12 dependency-direction, 6 CI pin) |
| `pnpm run test:e2e` | 8 / 206 | 8 / 206 |
| `pnpm run test:replay` | 3 / 17 | 3 / 17 |

The tooling files under the full unit gate:
- `dependency-direction.test.ts`: 199 tests;
- `ci-step-split.test.ts`: 32;
- `no-synchronous-spawn.test.ts`: 7;
- `lint-typed-program.test.ts`: 14;
- `app-bundles-load.test.ts`: 15.

Every existing tooling test passes unchanged.

## Decisions and disclosures

- **F13 gives way to F10 on a same-layer edge into an app, and F12 does
  not.** The edge still fails.
  - F12's fix ("move the shared code below both") agrees with F10's.
  - F13's fix ("add a cited §2.1 row") would now produce a `CHK`.
  - No existing test asserts F13 or F12 on an app target.
- **F16's relative half is wider than the row's "deep import".** It also fails
  an escape to a path in no package, such as repo-root `tools/`. The grant
  words it this way ("resolves outside the importing package's root"), and
  measured, nothing does it.
- **F16 is lexical.**
  - A `node_modules` segment is caught, whether or not it is a symlink on
    disk.
  - A symlink inside a package's own tree that points outside is not
    followed. None exists.
- **Not covered by F16; each is listed in its §3 cell:**
  - a non-literal specifier, such as a template with a substitution or a
    concatenation. It is F14 in the purity-restricted packages and silent
    elsewhere;
  - `require.resolve`, `/// <reference path>`, JSDoc `import("…")` types in
    `.js` files, `vi.mock` paths, and a file read by path;
  - files outside every workspace package (`test/**`, `tools/**`).

  These were measured, not assumed. A mirror held one file per form in
  `apps/backtest-cli/src` (`uncovered-probe.cjs`):
  - not caught: a template with a substitution, a concatenation,
    `require.resolve`, `/// <reference path>`, a JSDoc `import("…")` type, a
    `vi.mock` path and `new URL(…)`;
  - caught, as the controls: a static re-export and a no-substitution
    template, each as F16.
- **No rule-3 F10 arm.** An import of an app by package name with no
  manifest entry is not flagged, because items 1-4 do not include it. A
  declared one is rule 2's F10. A relative one is F16.
- **The dependent-block record pins the python audit block's exact text.**
  Any edit to that block needs its reason re-stated. That is deliberate.
- **`;` in a gate's own `run` is a separator; `||`, `|` and `&` are not.**
  None of those three is the fail-fast hazard. `;` inside a root **script**
  stays unchecked, because `sh` runs it without `-e`.

## Follow-ups (outside this grant)

These statements are now stale, and **no path below was touched**:

- **ADR-022 D9, third bullet:** "The check does not flag a row that matches no
  declared edge, so that removal is an obligation on the round, not a gate
  result." It is now a gate result.
- **ADR-022, "Alternatives rejected", B:** "The check implements no F10 today
  (the tool contains no `F10` id). The H8 scoping reproduced that such a row
  is **accepted silently** (probe P3…)". Both halves are now false.
- **`dependency-direction.md` §2.2, closing paragraph:** "F17 joins F15 and
  F16 as a stated rule the checker does not evaluate". F16's relative half is
  now evaluated.
- **`dependency-direction.md` §6.1 item 4 status:** "Neither is implemented in
  the §6 check yet". This holds for F15 and for F16's bare-name half only.

These two stay true because they are dated: the staged S18 and §2 paragraph
sentences, which `H8-GOV` r1 dated at `a8a3a63` for exactly this round.

A docs round owns the edits above.

`IMPLEMENTATION_STATUS.md`'s `CI2-L5-2`, `CI2-L5-3`, `DEPCHECK-1` and H8
track rows are the orchestrator's.

---

## Addendum (2026-09-28, `DOCS-1`): `import.meta.resolve` is also not judged by F16

Append-only; nothing above this line changed.

This round merged as `d7f2906`. Its Fable adversarial review returned r1
ACCEPT with one LOW, `DC1-R1-L1`: F16's relative half does not judge
`import.meta.resolve("<relative>")`. Two not-covered lists omit that form:

- the "Not covered by F16" list under "Decisions and disclosures" above;
- the §3 F16 Source cell that this round wrote.

**Measured by `DOCS-1`** at `ae25450`, in a scratch copy of the tree, with
`node tools/check-dependency-direction.mjs --root <copy> --json`:

- `apps/backtest-cli/src/probe-resolve.ts`, containing
  `export const target = import.meta.resolve("../../trader/src/main.js");`,
  gives exit 0 and no violation.
- The control, `apps/backtest-cli/src/probe-control.ts`, containing
  `export * from "../../trader/src/main.js";`, gives exit 1 and one F16.

**Why the form is not judged.** Rule 3 judges only the specifiers it records
as module loads, the forms listed under "What changed", item 3.
`import.meta.resolve` resolves a specifier to a URL without loading it (the
checker's header says so, in its F14 discussion). So, like
`require.resolve`, it is not recorded.

**Now recorded.** `DOCS-1` adds `import.meta.resolve("<relative>")` to the
not-covered list in the §3 F16 Source cell of
`docs/contracts/dependency-direction.md`, beside `require.resolve`. The
check itself is unchanged.
