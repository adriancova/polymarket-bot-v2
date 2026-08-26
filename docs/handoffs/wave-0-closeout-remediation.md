# Wave 0 closeout remediation — handoff record

Canonical work-package handoff per `AGENTS.md` (required fields) and
`docs/spec/polymarket-bot-workplan.yaml` (`required_handoff_fields`).

- Package: **Wave 0 closeout remediation** — a bounded, orchestrator-authorized
  repair package, not a numbered work package. It is the first instance of the
  mechanism now written down in `docs/contracts/protected-contracts.md` §3.1.
- Implementing agent: isolated worktree
  `.claude/worktrees/agent-a83b2d25f60ca4374`, branch
  `worktree-agent-a83b2d25f60ca4374`
- Base commit: `b1431e4` (`governance: ratify WP-040/WP-050 lockfile and handoff
  paths; open Wave 1 batch 1A`) — verified as `HEAD` at session start
- Final commit: see [`commit_sha`](#commit_sha) (branch HEAD = the handoff-record
  commit; the implementation commit is `2d41c97`)
- Scope authority: the dispatch packet, which enumerates the nine findings and
  ratifies the allowed paths (recorded as a precedent row in
  `docs/contracts/protected-contracts.md` §5)
- Independent adversarial review: **not performed** — the implementing agent may
  not review its own work (`AGENTS.md`; handoff §18.1). This record is input to
  that review.
- Safety: maximum run mode unchanged (`PAPER`). No credential, no wallet, no
  signer, no network access of any kind — every fact used here was already in the
  repository. No order path, live gate, soak, or execution probe was touched or
  claimed. `ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, and
  `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are untouched.

---

## summary

The Wave 0 closeout audits (recorded in `IMPLEMENTATION_STATUS.md` → "Wave 0
closeout (2026-08-26)") left nine findings unrepaired: one HIGH, four MEDIUM,
three LOW, one NOTE. This package repairs exactly those nine and nothing else.

The substantive change is that **three artifacts instructed the frozen
`packages/domain` to accept `null`** and the frozen code does not — a contract
document that contradicts the contract. The correction states the rule where it
actually belongs (the adapter maps `null` to *absent* before the boundary) and
records that the venue report's identical phrasing is superseded on this
architectural point rather than editing the frozen report.

The rest is defect and governance repair: two typed-error defects in
`packages/decimal` where the error class and its `code` disagreed and an argument
error was reported as an inexactness; the `ops:verify-venue` script wired to the
`WP-000` verification run that already existed; `apps/ops-cli`'s undeclared
dependencies declared; a false fact about `packages/strategies/static-bracket`
corrected; the incomplete narrowing list in ADR-002 §7 completed against
`checks.ts`; and four items that nobody owned (the duplicated decimal grammar, a
`WP-000` follow-up dropped when `WP-020` closed, the unratified inferred shapes,
and the report-§15 wiring deferral) registered with owners in
`protected-contracts.md` §8.1.

Two structural decisions worth a reviewer's attention, both explained under
`deviations`:

1. `pnpm ops:verify-venue` compiles with `tsc` and runs the emitted JavaScript.
   Node 24 does strip types, but it does **not** rewrite a `./foo.js` specifier
   to `./foo.ts` (verified empirically on Node v24.13.0), and the existing module
   tree is written with the `.js` specifiers `verbatimModuleSyntax` + `NodeNext`
   require. Changing those specifiers would have meant editing `apps/ops-cli/`
   `tsconfig.json`, which is outside the allowed paths.
2. The new `DECIMAL_INVALID_PRECISION` code rides on the already-exported
   `DecimalRangeError` rather than a new error class, because
   `packages/decimal/src/index.ts` is outside the allowed paths and an
   unexported error class would be worse than a well-documented shared one.

**No economic behavior changed.** No canonical grammar, hash preimage, golden
digest, arithmetic result, schema, type, emitted field set, or `schemaVersion`
was modified. The only behavioral deltas are two typed-error identities
(`DecimalRangeError`/`DECIMAL_INVALID_PRECISION` for a bad `precision` argument;
`DECIMAL_INVALID_TICK` on an unreachable tick-module invariant guard) and the
root `ops:verify-venue` script now succeeding instead of exiting 1.

---

## finding-by-finding matrix

| # | Finding | Verified against | Fix | Evidence |
| --- | --- | --- | --- | --- |
| **H1** | ADR-002 §7 (was line 206) and `protected-contracts.md` §9 (was line 237) instructed a runtime parser **"and `packages/domain`"** to accept `null` wherever the SDK declares `.nullish()`. This contradicts ADR-001 §8.1 (adapters map the sibling `""` case to absent *before* the boundary) and the frozen code | Read both texts; grepped `packages/domain/src` for `.nullable(`/`z.null()`: **zero** `.nullable()`, one `z.null()` (`decision.ts:37`, `ModelOutputValueSchema`, which handoff §7.5 specifies as a model-output *value*, not a venue field) | Both documents now state: the **adapter** accepts `null` and maps it to **absent before the domain boundary**; `packages/domain` stays strict per ADR-001 §8.1, cross-referenced. ADR-002 §7 gained a "where the relaxation lives" paragraph and the closing general rule was scoped to adapters. ADR-001 §8.1 gained the matching `null` clause. Both record that `docs/venue/verified-2026-08-24.md` §17's phrasing ("and `packages/domain` (WP-020)") is **superseded on this architecture point** under the handoff §1.1 authority order — venue report governs venue facts, ADRs govern internal architecture. **The report is not edited** | `docs/adr/ADR-002-…md` §7; `docs/adr/ADR-001-…md` §8.1; `docs/contracts/protected-contracts.md` §9 |
| **M2** | (a) `packages/domain/src/events/book.ts` stated absolute-size/zero-removal semantics flatly, where an implementer reads them. (b) Nobody owned `packages/domain` after `WP-020` closed | (a) Read lines 10-13 and 58 of the file at base; both stated the semantics with no status marker. (b) `WP-020` is complete and no open package lists those paths | (a) **Comment-only** markers: a module-header block and a field comment recording the handoff §23 assumption as UNVERIFIED (C-1/U-1), `WP-070`'s obligation to confirm, and the ADR-002 §8.4 new-`schemaVersion` remedy on contrary evidence. (b) New `protected-contracts.md` §3.1: post-freeze change to a protected package = orchestrator-authorized **bounded repair package** (enumerated scope + accepted ADR + orchestrator approval + schema-version statement + independent review + handoff), plus a row in the §10 quick reference | `packages/domain/src/events/book.ts`; `docs/contracts/protected-contracts.md` §3.1, §8 (C-1/U-1 row now names the code markers), §10 |
| **M4** | ADR-002 §7's "binding list" had four rows while `checks.ts` marks more deliberate narrowings | Read every `NARROWING` marker in `checks.ts` (lines 43, 58, 112, 135, 148, 381, 389, 419, 447, 796, 829) and each cited construct | Table extended to **eight** rows: per-layer trade-status spelling pinning (`checks.ts:107-131`, used `1063`/`1110`), `EPOCH_LIKE` pinned to epoch forms while the SDK also accepts date-like strings (`133-140`, used `980`/`1100`/`1104`), prices canonicalized + bounded to `[0, 1]` where the SDK types unbounded `DecimalString` (`42-46`, `148-159`), and `side`/`status` enumerated where the catalog records the SDK as typing a free string (`42-46`, `796-807`, `89-90` + usages). Each row keeps the runtime-must-not-inherit rule and says what the adapter must do instead; the price row keeps the `[0, 1]` **domain** bound and inherits only the spelling relaxation. A closing note states the list is now complete and must grow with `checks.ts` | `docs/adr/ADR-002-…md` §7 |
| **M5** | (a) The canonical-decimal grammar exists twice (`fixtures.ts:314`, `canonical.ts:85`) with nothing linking them. (b) A `WP-000` follow-up was silently dropped when `WP-020` shipped | (a) Read both implementations. (b) `docs/handoffs/WP-000.md` `follow_up` line 975-977, addressed to `WP-020`, absent from `WP-020`'s deliverables and from the register | (a) New `apps/ops-cli/src/verify-venue/canonical-grammar.test.ts` imports `@polymarket-bot/decimal` (new devDependency of `apps/ops-cli`) and asserts agreement over a 65-row pinned vector table (verdicts fixed by ADR-001 §2, so shared drift is caught too) plus a 1080-value systematic sweep, in both the plain and `[0, 1]` forms, and pins the one documented divergence (`MAX_DECIMAL_STRING_LENGTH`). (b) Registered as **R-1** and **R-2** in `protected-contracts.md` §8.1, R-2 owned by the `WP-070` packet for venue-adjacent schemas | `apps/ops-cli/src/verify-venue/canonical-grammar.test.ts` (70 tests); `docs/contracts/protected-contracts.md` §8.1 |
| **M6** | `dependency-direction.md` §6 claimed `packages/strategies/static-bracket` "is a directory with no `package.json` today" | `ls packages/strategies/static-bracket/package.json` → present (`@polymarket-bot/strategy-static-bracket`, `WP-010` scaffold); `pnpm-workspace.yaml` includes `packages/strategies/*`; `pnpm install` reports 35 workspace projects | §6's fail-closed mirror rule re-derived as two rules — a **named** §2 entry must resolve to a manifest; a **class** entry (`packages/strategies/*`) matches zero or more packages, each match is classified layer 1, and a match is **not** exempt. States that static-bracket is in the graph today (node, no edge; the §2.1 S2 row will permit its `strategy-sdk` edge at `WP-220`). The false claim is corrected in place and the correction is noted | `docs/contracts/dependency-direction.md` §6 |
| **L9** | (a) `tick.ts:41-46` threw `InvalidTickSizeError` with code `"DECIMAL_INEXACT"`. (b) `arithmetic.ts:170-173` reported an out-of-range `precision` **argument** as `DecimalInexactError` | Read both sites; confirmed every other `InvalidTickSizeError` carries `DECIMAL_INVALID_TICK`, and that `DecimalInexactError` is documented as "an operation could not be represented exactly" | (a) Code changed to `DECIMAL_INVALID_TICK` (class kept, so the class↔code pairing holds package-wide); the unreachable guard keeps its cause in the message. (b) New `DECIMAL_INVALID_PRECISION` code, additive to `DecimalErrorCode`, raised as `DecimalRangeError`. `errors.ts` now documents the class↔code table; ADR-001 §5 gained an additive typed-error subsection. **No golden digest, grammar, or arithmetic-result change** — asserted and evidenced by the unchanged `hash.test.ts` (44) and `canonical.test.ts` (137) suites | `packages/decimal/src/{errors,tick,arithmetic}.ts`; new `errors.test.ts` (30 tests, every reachable throw site); `tick.test.ts` (+1 test); `arithmetic.test.ts` (updated expectation); `docs/adr/ADR-001-…md` §5 |
| **L11** | Root `ops:verify-venue` was a NOT IMPLEMENTED stub while `runVenueVerification()`, the formatter, and the exit-code mapping already existed | Ran the stub (exit 1); read report §15's three numbered items | New `apps/ops-cli/src/verify-venue/main.ts` (prints the summary, sets `process.exitCode` from `venueVerificationExitCode`), new `apps/ops-cli` `verify-venue` script, root script points at it. `pnpm ops:verify-venue` runs offline, prints the summary (19 checks: 17 PASS, 2 DOCUMENTED, report validation OK) and **exits 0**. Report §15's deferral is closed in the register only (**R-4**), including the residue that §15 item 1 named `apps/ops-cli/src/index.ts`, outside the allowed paths | `apps/ops-cli/src/verify-venue/main.ts`; root `package.json`; `docs/contracts/protected-contracts.md` §8.1 R-4 |
| **L12** | `apps/ops-cli/package.json` declared only `typescript`, while its tests import `vitest` and its sources use `node:fs`/`node:path`/`node:url` | Read the manifest and the imports in `index.ts`, `fixtures.ts`, `fixtures.test.ts` | Declared `vitest`, `@types/node`, and (per M5) `@polymarket-bot/decimal` as devDependencies, per `dependency-direction.md` §7.2 (own the dependency in the owning package). Lockfile update is mechanical: **+9 lines, 0 removed** | `apps/ops-cli/package.json`; `pnpm-lock.yaml` |
| **N13** | `domain.md` §8 records inferred shapes; only some are named by a ratifying ADR in §10 | Compared every §8 row against the §10 ratification table | The four unratified inferences named in the packet — `TokenId` format, lowercase-only UUIDs, incident `severity` vocabulary, and payload field sets beyond §7.4's names — registered as **R-3** open ratification items, owned by the next ADR-modifying package or an orchestrator governance round. **`domain.md` is not edited** | `docs/contracts/protected-contracts.md` §8.1 R-3 |

---

## files_changed

Thirteen modified, three added — sixteen files, all inside the ratified paths.

**Modified**

1. `docs/adr/ADR-001-exact-decimal-representation.md` — §8.1 `null` clause (H1);
   additive typed-error subsection in §5 (L9).
2. `docs/adr/ADR-002-event-envelope-and-ordering-semantics.md` — §7 rewritten for
   H1 and extended to eight rows for M4; closing general rule scoped to adapters.
3. `docs/contracts/protected-contracts.md` — new §3.1 (M2b); §5 precedent row for
   this package's ratified paths; §8 C-1/U-1 row now names the code markers (M2a);
   new §8.1 register with R-1…R-4 (M5b, N13, L11); §9 corrected (H1); §10 row.
4. `docs/contracts/dependency-direction.md` — §6 graph-construction fact updated
   for the new `ops-cli` → `decimal` edge; fail-closed mirror rule re-derived (M6).
5. `package.json` (root) — the single `ops:verify-venue` script line (L11).
6. `apps/ops-cli/package.json` — `build`/`verify-venue` scripts; `vitest`,
   `@types/node`, `@polymarket-bot/decimal` devDependencies (L11, L12, M5).
7. `pnpm-lock.yaml` — mechanical, additive only (+9 / −0).
8. `packages/decimal/src/errors.ts` — `DECIMAL_INVALID_PRECISION` added to the
   code union; class↔code table; class docs sharpened (L9).
9. `packages/decimal/src/tick.ts` — guard code `DECIMAL_INEXACT` →
   `DECIMAL_INVALID_TICK` + rationale comment (L9).
10. `packages/decimal/src/arithmetic.ts` — precision-argument validation raises
    `DecimalRangeError`/`DECIMAL_INVALID_PRECISION`; module header and `@throws`
    updated (L9).
11. `packages/decimal/src/arithmetic.test.ts` — the precision expectation now
    asserts the argument error and asserts it is **not** a `DecimalInexactError`.
12. `packages/decimal/src/tick.test.ts` — new class/code agreement test.
13. `packages/domain/src/events/book.ts` — **comment-only** (M2a); proven below.

**Added**

14. `apps/ops-cli/src/verify-venue/main.ts` — CLI entry point (L11).
15. `apps/ops-cli/src/verify-venue/canonical-grammar.test.ts` — cross-grammar
    consistency test (M5a).
16. `packages/decimal/src/errors.test.ts` — typed-error taxonomy tests (L9).

Plus this handoff record, `docs/handoffs/wave-0-closeout-remediation.md`.

**Not touched, deliberately:** `docs/venue/verified-2026-08-24.md` (frozen dated
snapshot), `docs/contracts/domain.md`, any other ADR, any schema or type in
`packages/domain`, `IMPLEMENTATION_STATUS.md` (orchestrator-owned),
`docs/spec/**`, `apps/ops-cli/tsconfig.json`, `packages/decimal/src/index.ts`,
`.github/**`.

---

## tests_run

All commands run in the worktree, offline, on Node v24.13.0 / pnpm 11.17.0.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` (after the one lockfile-updating install) | exit 0, "Already up to date" |
| `pnpm typecheck` | exit 0 (all 35 workspace projects + `test/tsconfig.json`) |
| `pnpm lint` | exit 0 |
| `pnpm test` | exit 0 — **1203 passed / 1203**, 17 files (base `b1431e4`: 1102 / 15; +101 = 70 cross-grammar + 30 error-taxonomy + 1 tick) |
| `pnpm ops:verify-venue` | exit 0 — report validation OK, overall PASS, 17 PASS + 2 DOCUMENTED across 19 checks |
| `git status --porcelain` after commit | clean |

**Targeted evidence beyond the gate set**

- **`book.ts` is comment-only.** Beyond reading `git diff -U0`, the base and
  working versions were transpiled with `removeComments: true` (the repository's
  own `typescript` 5.9.3) and the outputs compared byte for byte: **identical**.
  The diff adds a module-header block and expands one field comment; no schema,
  type, export, or emitted field set changed, so `schemaVersion` is unchanged per
  ADR-002 §3.
- **The cross-grammar test detects drift** (mutation check). Relaxing
  `fixtures.ts`'s `CANONICAL_DECIMAL_RE` fraction group from `\.\d*[1-9]` to
  `\.\d+` (accepting trailing fractional zeros) made **7 of 70** tests fail; the
  mutation was reverted and the file is byte-identical to base.
- **No golden-digest or arithmetic change.** `hash.test.ts` (44) and
  `canonical.test.ts` (137) are untouched and pass unchanged; the two pinned
  golden digests are unmodified.
- **Lockfile is additive.** `diff` against the pre-install copy: 9 added lines,
  0 removed, all inside the `apps/ops-cli` importer block.

**Not run and not claimed:** `pnpm test:compose` (Docker infrastructure, outside
this package's scope and unaffected), `pnpm audit` (no new external dependency
was introduced — the three additions are already-resolved workspace/dev packages
in the same lockfile), and any network, soak, execution-probe, or live gate.

---

## assumptions

1. **Path authority.** The dispatch packet's enumerated allowed paths are treated
   as orchestrator ratification per `protected-contracts.md` §5, and are recorded
   as a precedent row there. Nothing outside them was modified.
2. **Comment-only means comment-only.** M2's markers are authorized under
   ADR-002 §8's own mandate ("marked UNVERIFIED wherever it appears") and bump no
   version, because ADR-002 §3 ties a version bump to a change in the **emitted
   field set**.
3. **`checks.ts` is the authority for what the fixture catalog narrows.** M4's
   new rows cite `checks.ts` line ranges verified in this session, and where the
   SDK's own typing is asserted (e.g. `side` as a free string) the ADR attributes
   the claim to the catalog's header note rather than restating it as a directly
   verified venue fact. No official documentation was fetched; none was needed.
4. **`ORDER_TYPE`, `USER_ORDER_STATUS`, `USER_ORDER_EVENT_TYPE` are not
   narrowings** — each cites a real SDK enum in `checks.ts` — so they are named as
   exclusions rather than added as rows.
5. **The `[0, 1]` price bound is a domain constraint, not an inherited fixture
   narrowing** (ADR-001 §2 and its Consequences), so M4's price row keeps the
   bound and relaxes only canonical *spelling* at the adapter.

---

## deviations

1. **`ops:verify-venue` compiles before running.** The packet suggested that
   "Node 24 runs erasable-syntax TS directly" and asked that the chosen
   invocation be verified. It was, and the direct invocation **does not work**
   here: Node 24 strips types but does not resolve a `./foo.js` specifier to
   `./foo.ts` (reproduced on v24.13.0 with a minimal case and with
   `--experimental-strip-types` / `--experimental-transform-types`;
   `ERR_MODULE_NOT_FOUND` each time), and the existing `verify-venue` modules use
   `.js` specifiers as `verbatimModuleSyntax` + `NodeNext` require. Rewriting them
   to `.ts` specifiers needs `allowImportingTsExtensions`, i.e. an edit to
   `apps/ops-cli/tsconfig.json`, which is outside the allowed paths. The script
   therefore runs `tsc && node ./dist/verify-venue/main.js`. `dist/` is already
   git-ignored and ESLint-ignored, and `git status` stays clean after a run.
2. **`DECIMAL_INVALID_PRECISION` rides on `DecimalRangeError`** instead of a new
   error class. A new class would have to be exported from
   `packages/decimal/src/index.ts` to be catchable by name, and that file is
   outside the allowed paths; an unexported error class is worse than a shared
   one. `DecimalRangeError` now carries two codes, documented explicitly, and
   callers branch on the code. If a reviewer prefers a dedicated
   `InvalidPrecisionError`, it is a small additive follow-up that needs
   `index.ts` in its allowed paths.
3. **Report §15 item 1 is satisfied in substance, not literally.** It named a
   subcommand inside `apps/ops-cli/src/index.ts`; that file is outside the
   allowed paths, so the entry point is `src/verify-venue/main.ts`. The residue
   (a command *router* in `index.ts` once `ops-cli` has more than one command) is
   registered as R-4's open residue against the owning package.
4. **A precedent row and a `§10` row were added to `protected-contracts.md`**
   beyond the literal finding list, to record this package's own path
   ratification and the §3.1 route. Both are inside the allowed paths and are
   disclosed here for the reviewer's verdict.
5. **`arithmetic.test.ts`'s existing precision expectation was changed**, not
   removed: it now asserts `DecimalRangeError` and additionally asserts the error
   is *not* a `DecimalInexactError`. No test was deleted or weakened anywhere in
   this package; the suite grew by 101 tests.

---

## known_risks

1. **The `tsc`-then-run invocation is heavier than a direct run.** It adds a
   compile (~1-2 s) to every `pnpm ops:verify-venue`, and it emits `dist/`. If
   the repository later adopts a TS runner (or `allowImportingTsExtensions`), the
   script should be simplified — the entry module itself would not change.
2. **`DecimalRangeError` now means two things.** Any caller that catches it and
   assumes "an economic value was out of range" must branch on the code. Nothing
   in the repository catches it today (grepped), so the risk is prospective and
   is why the distinction is documented in three places.
3. **The cross-grammar test pins agreement, not identity.** The two grammars
   remain separate implementations; the test's vector set is broad (65 pinned +
   1080 swept spellings) but is not a proof. R-1 stays open until the duplication
   is removed by whichever package resolves R-2.
4. **The M4 rows about `side`/`status` rest on `checks.ts`'s header note**, not on
   a re-fetched SDK source. That is the strongest in-repo evidence and it is
   attributed as such; the next phase-gate verification (handoff §1.2) is where a
   fresh source check belongs.
5. **C-1/U-1 is still open.** The markers make the uncertainty visible; they do
   not resolve it. `WP-070` still owes the confirmation before `WP-150` treats
   the semantics as truth.
6. **The `IMPLEMENTATION_STATUS.md` record is not updated** by this package (it
   is orchestrator-owned), so Wave 0 is not marked COMPLETE here.

---

## follow_up

1. **Orchestrator:** run the independent adversarial review of this branch; then
   record the outcome and mark Wave 0 COMPLETE in `IMPLEMENTATION_STATUS.md`.
2. **Orchestrator:** carry **R-2** ("replace the hand-transcribed stand-in
   schemas so transcription stops being load-bearing") into the `WP-070` packet's
   acceptance criteria, as `protected-contracts.md` §8.1 assigns.
3. **Next ADR-modifying package / governance round:** ratify or amend **R-3**'s
   four inferences (`TokenId` format, lowercase-only UUIDs, incident `severity`,
   payload field sets beyond §7.4's names).
4. **`WP-330` (or the package that owns `apps/ops-cli/**`):** close R-4's
   residue — a subcommand router in `apps/ops-cli/src/index.ts` — and consider
   dropping the compile step if a TS runner is adopted.
5. **`WP-015`** (dependency-direction CI enforcement): the §6 check now has one
   more edge and a corrected class rule to implement; `packages/strategies/*`
   must be classified, not exempted.
6. **Optional, additive:** a dedicated `InvalidPrecisionError` exported from
   `packages/decimal/src/index.ts`, if review prefers a class over a code on
   `DecimalRangeError` (deviation 2).
7. **Consider running `pnpm ops:verify-venue` in CI** (`.github/workflows/ci.yml`
   is outside these allowed paths): the command is offline, deterministic, and
   currently green, so it would fail closed if the frozen report or a fixture
   drifted.

---

## commit_sha

- Base: `b1431e4`
- Branch: `worktree-agent-a83b2d25f60ca4374`, worktree
  `.claude/worktrees/agent-a83b2d25f60ca4374`
- Implementation commit: `2d41c97` (16 files: the 13 modified and 3 added
  listed above)
- Handoff-record commit: the child of `2d41c97` on the same branch, adding only
  this file — it is the branch HEAD and the SHA to review
- Full changed-file set to review: `git diff b1431e4..HEAD --stat` → 17 files
