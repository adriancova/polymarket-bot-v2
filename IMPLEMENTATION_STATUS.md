# Implementation Status

Last updated: 2026-08-30  
Specification version: 2.0.0  
Current phase: `phase-1` — recording-ready (Wave 0 closed 2026-08-26)  
Maximum permitted run mode: `PAPER`

## Safety state

- `MAX_RUN_MODE=PAPER`
- `ALLOW_REAL_ORDERS=false`
- `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`
- `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`
- Production signer configured: **No**
- Real venue credentials required: **No**
- Human live-micro approval: **Not granted**

## Work packages

| Work package           | State    | Dependencies       | Assignment |
| ---------------------- | -------- | ------------------ | ---------- |
| `WP-000`               | Complete | None               | Merged `d427f00` (impl chain `8d16849`→…→`ddc56ff`, 6 review rounds) |
| `WP-010`               | Complete | None               | Merged `12ce0ab` (impl `1bca7cf`) |
| `WP-020`               | Complete | `WP-010` ✓         | Merged `25bc451` (impl chain `815b6cb`→`9790e0a`→`8d9596e`) |
| `WP-030`               | Complete | `WP-000` ✓, `WP-020` ✓ | Merged `59cf254` (impl chain `051bb62`→`1e30ff1`→`66d29a9`→`21a3370`) |
| `WP-015`               | Complete | `WP-030` ✓         | Merged `d77b2ba` (impl chain `bb441dc`→…→`b2b3b9b`, 10 review rounds) |
| `WP-040`               | Complete | All ✓             | Merged `d23bb67` (impl chain `0a73ffe`→…→`f8982bf`, 5 review rounds) |
| `WP-050`               | Complete | All ✓             | Merged `8a607ec` (impl chain `32cb0a8`→`3c2228a`→`a972e96`→`3f35a0c`→`b3a906f`→`22db770`, 4 review rounds) |
| `WP-060`               | Complete | All ✓ | Merged `af29b08` (impl chain `d7bbb0f`→…→`954e764`, 3 review rounds) |
| `WP-090`               | Complete | All ✓ | Merged `335b1b0` (impl chain `aa74419`→…→`fa518e7`, 3 review rounds) |
| `WP-070`               | Complete | All ✓ | Merged `f2f0258` (impl chain `f4d374d`→…→`97ddcf1`, 4 review rounds) |
| `WP-080`               | Complete | All ✓ | Merged `d0d66bf` (impl chain `cff20ba`→…→`a77c8f0`, 6 review rounds) |
| `WP-100`               | Complete | All ✓ | Merged `e3ac6a3` + root wiring `eaf18f4` (impl chain `d51dcd5`→`3624593`→`2e5be65`, 2 review rounds; round 2 **ACCEPT**, Codex `01a049b2-0370-7a01-9553-6b1a503d7979`). See completion record below |
| `WP-110`               | Complete | All ✓ | Merged `ea81f5f` (impl chain `1f15a8e`→`7e03fa9`→`444078d`→`59273bc`→`5ef6c31`→`23b4e3f`→`f227361`→`15f8f17`→`19f3368`, 8 review rounds / 7 remediation rounds; round 8 **ACCEPT**, Codex `01a05aed-090c-7360-930d-59f71bd3df17`). See completion record below |
| `GOV-1B` (contract-owner governance round) | Complete | Batch 1B ✓ | Merged `dd61e1e` (chain `be45ad3`→`6127818`→`deb6050`, review round 1 **ACCEPT** — Codex `01a04995-a14e-7020-97a3-9a196b2eb90e`, 0 findings above LOW; LOW-1 attribution typo fixed pre-merge by the orchestrator, disclosed, `check:deps` re-verified; LOW-2 recorded as open contract item below). ADR-013 closes C-1/U-1 (**WP-150 released** to replace-not-accumulate); ADR-014 rules `takerSide` = the aggressor order's own side (WP-070/WP-090 verified conformant in code; **mandatory WP-080 follow-up dispatched** — map `m:true→ASK`, remove `BOOK_SIDE_CONSUMED`, close BNC-U5); ADR-015 rules the 200-char identifier bound boundary hardening; ADR-016 ratifies the four R-3 shapes; dependency-direction machine-readable (F14; mutation-proved fence; 34/11 edge table). Post-merge gates green (root 2250/2250; check:deps; ops:verify-venue; audit; main-tree lint clean excluding in-flight worktrees). **Open contract items carried**: ADR-016 UUID boundary rule for future external input (normalize-vs-refuse — next governance round); GOV-1B follow-ups 2-6 (ADR-014 comment pointers, domain.md §10 rows, venue-report AsyncAPI indexing, F14 tool rename, §6.1 items incl. WP-015 follow_up 8) |
| `WP-130`               | Complete | All ✓ | Merged `cfa353b` + root wiring `24903d2` (impl chain `a9a0e5a`→`f9c2e48`→`09d4252`→`67c8493`→`a8d54c0`→`517c374`→`e24e955`→`1bcc0f4`, 6 review rounds / 5 remediation rounds; round 6 **ACCEPT**, Codex `01a05b0b-c281-7302-a7ee-66c4297534a5`; LOW-1 closed pre-merge by a disclosed orchestrator addendum). See completion record below |
| `WP-080-FU1` (ADR-014 takerSide conformance) | Complete (merged `ebda609`) | `WP-080` ✓, ADR-014 ✓ | Impl `15e5e10` on base `9a5b551`, branch `worktree-agent-a0b698943b5260f48`. `takerSideFor` now total and unparameterised (`m:true→ASK`, `m:false→BID` per ADR-014 §3); `BOOK_SIDE_CONSUMED` and the whole selectable-convention surface deleted; constructor refuses the removed `takerSideConvention` key with a typed error naming ADR-014; `takerSide` emitted unconditionally (decision recorded: `m` documented on every trade payload, so ADR-002 §6 omit-rather-than-guess does not apply); BNC-U5 moved to a new `BINANCE_RESOLVED` register with authority and dates; new ADR-014-parsing contract test (reads the ADR from disk, checks the biconditional against the Binance row, then the adapter — 13 tests). 12 files all in scope; handoff append-only +231/−0; lockfile untouched. Orchestrator reproduced gates: root 2260/2260, binance contract 146/146 (was 143), check:deps PASS, frozen install clean. Three mutation checks reported (inverted mapping; convention resurrection — first guard caught by only 1 test, strengthened; default-omission revert). Review round 1 (Codex `01a055a4-0f7d-7413-8127-4df6afb9c25b`): **CHANGES REQUIRED** — 1 medium (M1 the ADR-014 contract test's §3 parser is unscoped: it takes the FIRST `m = true → …` match anywhere in the ADR, and the mapping recurs in §7/history text, so rewording or moving the real §3 row silently falls through to the duplicate and all 13 tests still pass — reproduced by the reviewer; contradicts the handoff's loud-failure claim; must isolate the §3 heading span, require exactly one Binance row with both boolean arms, and mutation-prove it), 2 low (L1 the recorded M1 mutation kill count is stale — 6 unit + 5 contract in the committed suite, not 6+4; L2 the handoff's prior contract count "was 143 in 7 files" is wrong — scratch removal of FU1's additions yields 131/7). Runtime conformance judged PASS on all fronts: mapping derived independently from the §1 biconditional and probed both arms end-to-end (raw `m` preserved); deletion total with the typed refusal firing for JSON-shaped/spread/undefined legacy keys and no smuggling path; missing-`m` frames refuse as MALFORMED/SCHEMA_MISMATCH with no guessed side; register move sound; regression sweep clean (frames.ts comment-only; domain field set/schemaVersion unchanged; WP-070/WP-090 untouched); deviations 1-3 all accepted; M2's strengthened guard judged materially stronger. NOTE: orchestrator's dispatch prompt misstated the scope-fact edge count (15 — that is with WP-110's packages; this base has 11); reviewer correctly did not attribute it to the candidate. Remediation round 1 dispatched 2026-08-30. **Remediation round 1 completed** in `1fe5178`, fresh repair session, ZERO production-code changes: both reviewer probes reproduced exactly in a /dev/shm scratch copy first (real ADR never modified; noted §7 line 144 carries BOTH arms on one line, giving the old whole-document parser a complete fallback row); M1 → new span-scoped parser `test/contract/binance/adr014-ruling.ts` (text between `### 3` and `### 4` only, exactly one both-arm row in the span, one side per arm, whitespace-tolerant, typed `Adr014ParseError` otherwise) + 12 permanent mutation probes (reworded/removed/moved row refuses; duplicate-outside-§3 precondition pinned; labelled-SYNTHETIC mechanics for duplicate-in-span/contradictory-arms/heading anomalies); three weakened-parser variants each tripped a named test; L1 → remeasured 6 unit + 5 contract with commands recorded, dated correction appended; L2 → remeasured 131/7 pre-FU1, dated correction appended; handoff append-only +235/−0. Disclosed residual: §1's biconditional parser remains whole-document (no duplicate exists to fall through to today — checked; flagged for the next reviewer). Orchestrator verified scope (4 files, all in test/contract/binance/** + handoff; packages/** and lockfile untouched) and reproduced gates: contract 158/9 (was 146/8), root 2260/72 unchanged; canonical branch fast-forwarded to `1fe5178`; remediation worktree cleaned up. Review round 2 dispatched 2026-08-30. **Review round 2** (fresh Codex `01a055cc-4aaf-7551-808b-5ca24d34ad09`): **ACCEPT** — M1/L1/L2 all FIXED under independent probes (13-case parser mutation matrix incl. `### 30`/`#### 3` headings, split arms, contradictory arms, emphasis wrappers, CRLF; §7-duplicate deletion leaves conformance green while the designed precondition tests fail as intended; inverted ADR row kills 7 tests; meaning bound via §1 cross-derivation and real fixture frames; append-only prefix byte-compared). Residuals (disclosed): LOW — §1's biconditional parser remains whole-document/first-match (no duplicate exists in the ADR today; dormant future-edit risk; optional follow-up to span-scope to `### 1`–`### 2`); NOTE — §7-duplicate precondition intentionally couples the historical probe suite to the ADR wording. **Merged `ebda609`** (`--no-ff`). Post-merge gates on main: frozen install; typecheck; main-tree lint clean; check:deps 34/11; root 2395/2395 (79 files); contract chain 583 + rtds 65 + binance 158 + coinbase 94. Worktree and branch cleaned up. ADR-014 conformance obligation from GOV-1B discharged; BNC-U5 CLOSED. Carried follow-ups: optional §1 parser span-scoping; the packages/domain ADR-014 comment pointer remains owed by the next bounded package owning packages/domain/**; cross-venue aggressor-imbalance comparison once two adapters' trades land in one store (bears on WP-090's open U-CB-3) |
| `WP-120`               | Complete | All ✓ | Merged `0622f45` + root wiring `2a49153` (impl chain `e4b2114`→`4f71f9e`→`e9cee46`→`45c231c`→`95c8aa9`→`767ecfd`→`d2fbbfa`→`01e33f0`→`023819e`, 7 review rounds / 6 remediation rounds; round 7 **ACCEPT**, Codex `01a05ff2-b177-7840-8267-224f804d28c6`; LOW-1 comment wording closed pre-merge by a disclosed orchestrator commit). See completion record below |
| `WP-140`               | Implementation complete; automated checks complete; **external time-based evidence PENDING** (gate open) | All ✓ | Merged `735d330` + root wiring `5757ef3` (impl chain `9b9173a`→`860436c`→`4d0d163`→`e7ded4b`→`f947034`, 4 review rounds / 3 remediation rounds; round 4 **ACCEPT** for implementation+checks, Codex `01a061d3-e4a5-76e1-9548-a484ef46076a`). The external-evidence gate closes only via the runbook §7 governance procedure after a real ≥24h soak. See completion record below |
| `GOV-1C` (contract-owner governance round at Wave 1 closeout) | Complete (merged `3272c4b`, 2026-09-02; Codex review round 1 ACCEPT, zero findings above NOTE; all three UNVERIFIED-by-reviewer sandbox items independently reproduced by the orchestrator incl. exact-match re-fetch of all six venue URLs; both disclosed deviations reviewer-ACCEPTED; post-merge gates: root 3451, check:deps 34/24, typecheck) | Wave 1 ✓ | Candidate orchestrator-verified 2026-09-02: scope exactly 15 files in authorized paths (5 new: ADR-017/018/019, `docs/venue/verified-2026-09-02.md`, `docs/handoffs/GOV-1C.md`; 10 modified incl. ADR-009 dated §5 discharge amendment, ADR-016 §2 UUID-refusal amendment, `packages/domain/src/events/{book,reference}.ts` comment-only, `tools/check-dependency-direction.mjs` F14 surfaces); lockfile/test/** untouched; stripped-transpile hash proofs reproduced by orchestrator (book `e281fcc5…` 2380B, reference `77bcc46a…` 2122B, identical base/tip, matching handoff); F14 mutation proof reproduced (probe → `FAIL [F14]` + JSON `rule:"F-OPAQUE"`+`contractRule:"F14"`; restore → PASS, tree clean); gates at tip: root 3451/122 = main, check:deps PASS 34/24, typecheck, lint, install frozen, ops:verify-venue exit 0. Two implementer-disclosed deviations for the reviewer: (D1) 2d is a dual-surface rename (human id F14, machine `rule` keeps accepted alias F-OPAQUE — a strict swap is jointly unsatisfiable with the no-test-change gate because the pinned tooling suite structurally asserts the legacy id; tool+suite swap registered as a bounded follow-up); (D2) item 7 additionally closed U-6 with a dated ADR-009 §5 discharge (second use of the README bounded venue-fact exception, four conditions walked; severable). Note: first dispatch (2026-09-02, earlier) was killed by an API session limit during its read phase with zero work product; its worktree auto-cleaned; the round was re-dispatched fresh with the identical packet — the completed candidate is entirely the second dispatch's work. Original dispatch scope (unchanged): Scope: (1) ADR-016 UUID boundary rule (normalize-vs-refuse — assigned to this round by GOV-1B); (2) GOV-1B follow-ups 2-6 (ADR-014 comment pointers in frozen domain event modules, comment-only with the stripped-transpile hash-proof precedent; domain.md §10 rows for ADR-013..016; venue-report re-issue indexing the AsyncAPI page, market-WSS URL drift, E18, RTDS unix-ms, GET /book OpenAPI contradictions; F-OPAQUE→F14 tool rename now in-scope; dependency-direction §6.1 open items incl. WP-015 follow_up 8); (3) WP-120's `causationId` format contract registration; (4) the dataset-manifest ADR (WP-130: segmentSha256 vs segmentFileSha256 roles, nullable=repetition, strict-JSON profile, retention receipt); (5) WAL cross-epoch chronology ruling (WP-130 follow-up 8 — define or rule mixed-epoch directories out); (6) the repo-wide runtime-build convention (the app-local esbuild precedent); (7) WP-110's venue-register rows for its non-confirmations; (8) ratify the WP-140 24h soak threshold and no-window-summing rule as policy |
| `WP-150`               | Complete (merged `70c7f1f`, 2026-09-02; three review rounds — r1 single MEDIUM M1 framing, r2 verified remediation + found one residual surface, r3 ACCEPT with M1 closed and zero findings; post-merge gates: root 130/3536, check:deps 34/26, typecheck; see completion record) | All ✓ | — |
| `WP-170`               | Complete (merged `9d0971b`, 2026-09-03; **eight review rounds, round 8 ACCEPT with zero BLOCKER/HIGH/MEDIUM**; post-merge gates: root 173/4188, check:deps 34 packages / 33 edges, typecheck, lint — WP-170 contributes exactly 20 files / 236 tests and 3 downward edges on top of WP-200. Acceptance criteria at merge: exactly-one-decision 19/19, boundary isolation 9/9, determinism 5/5 with a non-vacuous different-seed probe. Registry stable at 44 callables (34 PUBLIC / 10 PACKAGE, 0 unresolved), canonical entry hash identical across the last two rounds, battery file byte-identical. Two LOW residuals carried — see completion record.) | WP-020 ✓ WP-040 ✓ | tip `18cd97d`, rem commit `531c515`, ff-merged; scope exactly 8 files with **ZERO under `packages/` for the THIRD consecutive round**; lockfile byte-identical; **`boundary-surface.test.ts` — the registry and battery — is BYTE-IDENTICAL to base**, independently corroborating the 44→44 claim; gates reproduced: root 150/3772 = base 150/3769 (+3 tests), check:deps unchanged 34/29, typecheck, lint, frozen install. All three r7 MEDIUMs fixed, M7-3 reproduced line-for-line first. `visitReturnedConstructible` now propagates handed-out visibility into `visitClass`, whose visited set is keyed by derived visibility so a class met package-internally FIRST is re-walked when a public path hands it out; the four distinctions are concrete constructor → PUBLIC, abstract constructor → PUBLIC `abstract constructor` (reached via a caller's `super(...)`), concrete prototype implementation → PUBLIC, and abstract declaration → PACKAGE `abstract declaration` enumerated by name but carrying no battery obligation because the body belongs to the caller's subclass — the same ruling round 6 confirmed for caller-supplied ports. `carriesCallables` is now tri-state with `indeterminate` refused by name at all four call sites. Key-remapped properties are enumerated under their real accessible name, or refused if their own call signature is foreign. **Re-derivation: 44 → 44 entry-for-entry, 34 PUBLIC / 10 PACKAGE, 0 unresolved, 0 diagnostics — no real callable changed visibility**, and the handoff states plainly that nothing in either package hands out a class value, uses a key-remapped mapped type, or has a callable under an index/container at any depth. Nine mutations: seven kill, **two disclosed no-kills with reasons** (a depth memo that decides which refusal never whether; a redundancy guard producing identical output). Cost 556 ms (from 523); a fourth `ts.Program` was built, measured at +395 ms, and REMOVED by caching. **ORCHESTRATOR ACCEPTANCE BAR APPLIED TO ROUND 8** (stated in the review packet, and a severity ruling only — not licence to soften anything): rounds 1-4 each found a real runtime defect and all are closed; rounds 5-7 found ONLY mechanism gaps with the product source untouched throughout and the registry stable at 44 since round 5. A finding now BLOCKS only if it affects the PRODUCT or demonstrably hides an unfuzzed PUBLIC callable as r7's M7-3 did; a gap of the form "the type system has another exotic shape", with no live instance and no product consequence, is a LOW/NOTE residual. Round 8 is asked to rule directly on the handoff's own candidate residual — fourteen of twenty-three refusal reasons are unfixtured, claimed to be compiler states unreachable from a compiling fixture or mirror wordings of fixtured branches — and on the one judgement that could still hide surface: whether an abstract DECLARATION classified PACKAGE is genuinely analogous to a caller-supplied port.) Round-7 record (review on `3eb179e`: CHANGES REQUIRED — **NO BLOCKER, NO HIGH; all three product acceptance criteria PASS and no package source changed for a second round**. Round 6's three formerly-silent shapes are confirmed correct, and 7 of 10 NOVEL shapes the reviewer invented are handled properly (intersections, mixed-callability unions, `this` returns, tuple refusal, recursive facades, `Awaited<...>`, overloaded handed-out signatures). Three MEDIUMs remain, all in the mechanism. **M7-3 is the one that matters**: a class value handed out publicly loses PUBLIC visibility — a factory returning `typeof AbstractClass` classified `.concrete`, `.execute` and `.constructor` as PACKAGE, and PACKAGE entries never enter the public hostile-argument battery, so genuinely reachable public callables go unfuzzed; this is an ORDINARY shape, not an exotic one. **M7-2**: `carriesCallables` turns depth exhaustion into "no callable" — a callable ten hops beneath a returned string-index value produced no entry, no unresolved and no diagnostic, contradicting both the binding property and the claim that the depth bound always refuses (known_risk 5 disclosed it accurately but sat beside a claim it falsified). **M7-1**: key-remapped mapped properties are silently absent — the same shape of hole as round 6's `Readonly<T>` alias discovery. Reviewer NOTEs preserved rather than "fixed": duplicate ids from a generic facade at two instantiations fail LOUDLY via the duplicate-id assertion; the array/Promise/Map refusals are deliberate, actionable over-refusal; the two unfixtured defensive branches do not block acceptance; the V8-stack coupling is fragile but fails loudly. **ORCHESTRATOR STOPPING RULE recorded in the packet**: rounds 5-7 have all found mechanism-completeness gaps while the product stayed correct and unchanged. That investment is justified by rounds 1-4 each finding a real runtime defect, but it is not unbounded. This round closes the three findings; after it, further findings of the form "the compiler surface has another exotic type shape" are to be recorded as documented residuals rather than driving another round, UNLESS they demonstrably hide unfuzzed PUBLIC callables the way M7-3 does. A loud, well-documented refusal is an acceptable permanent answer for a shape the package will never plausibly adopt.) Round-7 record (remediation r6 verified 2026-09-03: tip `3eb179e`, rem commit `4dd1c4a`, ff-merged; scope exactly 7 files with **ZERO under `packages/`** — a second consecutive mechanism-only round; lockfile byte-identical; gates reproduced: root 150/3769 = base 150/3765 (+0 files/+4 tests), check:deps unchanged 34/29, typecheck, lint, frozen install. The binding property — *enumerated by name or `unresolved` by name; silence is never an outcome* — is now claimed held: handed-out call signatures are recorded as `X (returned)`, conditionals are expanded or refused, type parameters resolve to their base constraint, index signatures and foreign container type arguments carrying callables are **refused by name** rather than given a synthetic id the fuzz could not call, and the depth bound refuses instead of truncating silently. **Auditing against the property rather than the finding turned up FIVE MORE silent omissions**, of which one is significant: the walk required a returned type's own symbol to be ours, but `Readonly<T>`'s alias symbol belongs to the standard library — so every member was dropped, and `StrategyContext` returns `Readonly<MarketView>` plus four siblings, i.e. **five of its ten capabilities**. Data-only today, so nothing was lost, but the mechanism would have lost every method the day one was added. **Re-deriving the real registry produced 44 → 44 with unresolved 0 → 0 and no registry key changed** — so unlike round 5's 26→44 this was a mechanism hole with no live instance behind it, and the remediation states that plainly rather than dressing it up. L6-1 fixed with valid baselines for every non-target argument plus a `readRecordingProxy` proving the target position is actually reached; **mutation N12 is the decisive evidence** — the same product defect fails a test under the new vector but gave 0 failed / 21 passed under round 5's all-`undefined` vector, i.e. previously invisible. L6-2 resolved by TIGHTER COUPLING rather than narrowing: a witness's thrown error must originate from a stack frame inside the two packages whose function name matches its registered id, with an impostor test rejecting three fakes including one that reaches the packages through a different callable; what human review still carries is stated (origin proved, route not). Twelve mutations, all killing except the one designed not to. Costs measured: real packages 523 ms (+3.4% on round 5, inside its own spread), a third `ts.Program` at +43 ms, root suite 35.60 s vs 36.54 s. Review round 7 dispatched on `3eb179e`, asked to attack the binding property with ten shapes nobody has tried (mapped types with key remapping, intersections, mixed-callability unions, `this`-typed returns, abstract classes, tuples, recursive types, generic facades at two instantiations, `Awaited<...>`, overloaded call signatures on a handed-out type) and to rule on the two refusal reasons that are guarded but have no fixture.) Round-6 record (review on `cb51f00`: CHANGES REQUIRED but **NO BLOCKER, NO HIGH — the runtime passes all three acceptance criteria**, the 18 newly registered callables are confirmed genuine, round 5's ten-shape matrix is confirmed REPAIRED (25 exact callables over the committed fixture, zero diagnostics, zero unresolved), and **the return-versus-parameter frontier was RULED CORRECT** (`DecisionSink`, `CheckpointStore`, `MonotonicClock` and `Strategy` are caller-supplied, so their methods are not this package's implementations). **M6-1 (MEDIUM)**: the return-position walk is neither complete nor uniformly fail-closed — `visitHandedOut` calls only `visitProperties`, so it records no call signatures on handed-out types and detects neither callable index signatures nor unresolved conditional branches. On a compiler-clean fixture, three shapes were **silently absent from BOTH `callables` and `unresolved`**: a getter returning a function, a generic conditional return (`Left.left`/`Right.right`), and a callable-only string index signature — while a class expression and a non-class constructible correctly failed closed as `unresolved`. The same omission affects an ordinary function returning a function, and a callable Proxy would inherit it. **L6-1**: later-parameter hostile probes can be vacuous — every non-target argument is `undefined`, so for `restoreCheckpoint(checkpoint, identity)` the hostile identity is never reached (the undefined checkpoint returns first); a battery-quality gap, not a runtime defect, since a dedicated test still covers it. **L6-2**: the "three-edit dead end" claim is stronger than the witness mechanism proves — an unrelated witness closure that throws deliberately satisfies both the equality check and `toThrow`. Remediation round 6 dispatched with the binding property stated: **every callable shape is either enumerated by name or recorded as `unresolved` by name — silence is never an outcome.** The derivation already does this correctly for class expressions and non-class constructibles; the defect is that it is not uniform. The packet also requires re-deriving the real registry after the fix and reporting whether any newly-appearing callable is a coverage gap or a masked defect, as round 5's 26→44 discovery was.) Round-6 record (remediation r5 verified 2026-09-03: tip `cb51f00`, rem commit `2ec8e22`, ff-merged; scope exactly 13 files with **ZERO under `packages/`** — a test-mechanism round only; lockfile byte-identical; gates reproduced: root 150/3765 = base 149/3755 (+1 file/+10 tests), check:deps unchanged 34/29, typecheck, lint, frozen install. **The syntactic scan is replaced by compiler resolution**: a new `boundary-derivation.ts` builds one `ts.Program` and asks the checker `getExportsOfModule` per module with alias chains resolved, so `export *`, aliases, export-clause-only declarations and barrels stop being four patterns to recognize and become one question the compiler answers. Four reachability rules — module export, class member, object property (recursive), and **handed out** (members of a type in the RETURN position of an already-enumerated callable, which is how the ten `StrategyContext` capabilities and the `SeededRandom` facade — closures no exported name reaches — join the surface). Parameter types are deliberately NOT followed on the stated line that `DecisionSink`/`MonotonicClock`/`Strategy` are somebody else's implementations; anything unclassifiable becomes an `unresolved` entry that fails the suite BY NAME. **The registry went 26 → 44, and the 18 additions are real**: `runtime.ts` ends with `export type { StrategyInstanceRuntime }`, so round 4's scan was missing **`evaluate(input)` — the package's own evaluation entry point** — plus the whole capability facade. All 18 pass the 19-value hostile battery as the code already stood, so this was a COVERAGE gap rather than a runtime divergence, and **no package file was changed** (orchestrator confirmed the packages diff is empty). L5-1 closed: `PUBLIC_PARTIAL_WITNESSES` is equality-checked against the registry and each witness must break its documented precondition and actually throw, turning the two-edit escape into a three-edit dead end. Mutations MA–MF each take one shape END-TO-END in three steps (boundary appears → registry fails; classified as derived → coverage assertion fails; wired → the FUZZ fails), with ME/MF showing round 4's classification now REJECTED; MG/MH/MI/MJ/MK/ML2/MO/MP all kill; **ML killed nothing and is disclosed with its reason**. Also disclosed: three zero-arity RNG adapters were `() => undefined` and asserted nothing at round 4 — they now call the generator, meaning part of round 4's battery was vacuous. Costs measured: derivation 506 ms real / 44 ms fixture; `boundary-surface.test.ts` 106 → 873 ms; full parallel suite 36.54 → 35.71 s (noise). Review round 6 dispatched on `cb51f00`, asked to attack the new enumeration with shapes beyond the ten-case matrix and to rule on the return-vs-parameter frontier — since the runtime DOES invoke caller-supplied `DecisionSink`/`MonotonicClock`/`Strategy`, and rounds 3-4 found real defects in exactly that direction.) Round-5 record (review on `4047982`: CHANGES REQUIRED but **NO BLOCKER and NO HIGH — all three acceptance criteria PASS and rounds 1-4's concrete defects are confirmed closed**. What remains is the completeness of the derivation MECHANISM, not runtime behavior. **M5-1 (MEDIUM)**: the derivation scans SYNTAX rather than resolving SEMANTICS, so it cannot see every public callable — `publicNames()` recognizes only named `export {...}` clauses in the entrypoints; a direct `export function f()` in an entrypoint is marked `PACKAGE`; `export *`, aliases and later export clauses are unresolved; and `derive()` misses methods on exported object literals, arrow-function class fields, accessors, and export-clause-only declarations. The reviewer's ten-shape matrix: six caught, `export *` misclassified, and **three COMPLETELY INVISIBLE** (`function f(); export { f };` plus barrel re-export; a method on an exported object literal; an arrow-function field on an exported class) — 7/7 passing with the boundary present. The M11 tomorrow-guarantee holds only narrowly: a function added directly to `index.ts` did produce the promised failure, but was classified `PACKAGE`, so registering it that way passed everything and its hostile argument was never fuzzed; a barrel-only export produced no failure at all. Verdict on the tomorrow guarantee: FAIL. **L5-1 (LOW)**: a coordinated `TOTAL`→`PARTIAL` downgrade plus removing the call adapter — the natural second edit — passes 7/7, and the "PARTIAL is not a euphemism" test hard-codes today's examples instead of requiring a witness per public partial entry. **Reviewer PASSES to preserve**: sequence exhaustion (exact boundaries probed at `MAX_SAFE_INTEGER-2/-1/MAX`; retaining `number` judged sound because these values travel in JSON documents and the grammar refuses `bigint`); params with NO escape hatch judged an acceptable safety decision; and the uncovered property-read half judged adequately handled, with four deliberate multi-read exceptions documented as reviewed and safe (evaluation views take two guarded enumerations; `isRngState` reads length twice but is wholly guarded and retains nothing; `DeterministicRng.fromState/restore` destructure under preconditions; the injected clock is sampled before and after the callback by the watchdog). Reviewer NOTE recorded: no current production callable uses the invisible shapes, so this is a failure of a promised future-proof mechanism, not a present runtime divergence. Remediation round 5 dispatched with the parallel made explicit: **a syntactic scan is to the module graph exactly what `Object.entries` was to property enumeration** — the fix is to move up to a `ts.Program` type checker, resolve aliases and `export *`, fail closed on any callable shape it cannot classify, and prove by mutation that each formerly-invisible shape now reaches the public hostile-argument battery rather than merely causing a registry mismatch.) Round-5 record (remediation r4 verified 2026-09-03: tip `4047982`, rem commit `e00a617`, ff-merged; scope exactly 16 files, lockfile byte-identical, strategy-sdk and domain untouched; gates reproduced: root 149/3755 = base 145/3718 (+4 files/+37 tests exactly), check:deps unchanged 34/29, typecheck, lint, frozen install. **The methodology was the deliverable and it is now mechanical.** `boundary-surface.test.ts` parses BOTH packages with the TypeScript compiler API, enumerates every exported function and every parameter, and requires that set to EQUAL a registry classifying each `TOTAL`/`PARTIAL`. The AST is the necessary oracle, asserted as its own test: `Function.length` does not count a defaulted parameter, so `materializeCheckpointableJson(value, path = "$")` reports arity **1** — a runtime enumeration would have missed r4's reported defect a SECOND time. Mutation **M11 adds `materializeTomorrow(value, label = "$")`** — tomorrow's version of that defect — and the derivation test fails with no table touched, which is the claim that the class is now closed by mechanism rather than by memory. The behavioral cross-check is a 19-value hostile battery driven into every parameter of every public TOTAL function, with arity taken from the AST. **Two further instances of the same class were found by that derived sweep and fixed, neither reported**: `readOwnFieldsOnce`'s `label`, and `StrategyContextRevokedError`'s `capability` — constructing it with a Symbol threw `TypeError` from the class whose entire purpose is to be a typed refusal. **H1**: `MAX_EVALUATION_SEQ = MAX_SAFE_INTEGER - 1` with a restore refusal for a non-representable successor and a pre-callback `EVALUATION_SEQ_EXHAUSTED` refusal; the counter stays `number` deliberately because it travels in JSON documents and the package's own grammar refuses `bigint`. **H2**: a new `IMMUTABLE_PARAMS` grammar materializes params at creation (`Map`/`Set`/`Date`/class instances/accessors/functions/symbol keys/cycles refuse), with **no escape hatch** though the dispatch allowed one — argued from §9.6/§10.3 that params ARE a JSON config record and derived structures belong on the strategy object. **M1** the diagnostic path is internal behind a total `describeLabel`; **M2** `isolateStatePatch` lifts the patch out before any schema traversal so attribution no longer depends on depth (and the patch is traversed once, not twice); **M3** `present` via guarded `Reflect.has` so `data: undefined` is a parsed value. Round 3's two non-application arguments are explicitly withdrawn with evidence, alongside three more falsified statements. **Performance claim CHANGED and is referred to round 5**: r3 reported the evaluation path at 26.3 → 63.8 µs (~2.4×); this round could NOT resolve a difference from noise (base 76.72/73.42/85.14 vs tip 74.70/75.48/75.60 µs, the base tree alone varying 16%), so the claim made is "no measurable regression", not "no regression". The measured cost moved to the CREATION path: 3.94 → 8.40 µs (~15-property params) and 8.40 → 26.64 µs (~105 properties), once per run, with no optimization applied and none proposed. Disclosed limit: the derivation covers SIGNATURES, not every value read from an object the runtime did not construct — that half is covered by probes, with a static read-once rule as follow-up 1. Review round 5 dispatched on `4047982` with the derivation mechanism as its central question.) Round-4 record (review on `bed2f1c`: CHANGES REQUIRED — 2 HIGH, 3 MEDIUM; acceptance 1 and 3 still fail. **H1**: a checkpoint at `Number.MAX_SAFE_INTEGER` is accepted (checkpoint.ts:248), its successor computed unsafely (:324), and runtime.ts:718 then increments a number that cannot advance — two ordinary DECIDED evaluations persisted the SAME sequence (`sequences=[9007199254740992,9007199254740992]`, `safe=[false,false]`), reopening the reused-sequence class from a new direction. **H2**: `params` is neither inert nor reliably immutable — `Object.freeze(new Map())` does not freeze entries, so two runtimes with identical identity, input and seed produced DIFFERENT decisions after the caller mutated one retained Map, and a frozen accessor object stayed live; this **disproves BOTH of round 3's deliberate non-applications** (params leaks caller/schema-owned data, so the context is not exclusively runtime-owned). **M1**: the exported materializer's own caller-supplied `path` argument breaks totality (a Symbol path threw; a throwing `path.toString()` escaped) — an argument the 25-row sweep never listed. **M2**: a TOP-LEVEL hostile `statePatch` is mis-attributed `DECISION_INVALID` because the whole-result schema parse runs before the patch region, while a NESTED one correctly reports `STATE_PATCH_INVALID`. **M3**: a successful schema result carrying explicit `data: undefined` is discarded, so raw params reach `ctx.params()`. Remediation round 4 dispatched with the lesson made explicit: round 3's table had holes because it was built by hand — derive the boundary list from the code and cross-check it with a different method.) Round-4 record (remediation r3 verified 2026-09-03: tip `bed2f1c`, rem commit `a03fcd6`, ff-merged; scope exactly 20 files incl. two new source modules (`describe.ts`, `read-once.ts`), lockfile byte-identical, strategy-sdk and domain untouched; gates reproduced: root 145/3718 = base 143/3681 (+2 files/+37 tests exactly), check:deps unchanged 34/29, typecheck, lint, frozen install. **The class was swept, not the sites** — a 25-row entry-point table applies P1 (materialize once, reuse everywhere) to the definition and its 8 fields, the strategy identity and its nine callbacks (via `Reflect.apply` on the captured function so `this` still works), the params schema and its result, the run identity, the watchdog budget, each port's method AND receiver, the evaluation input, the checkpoint document and identity, the RNG lanes, the rebuild fold, and the returned patch; and P2 (actually total) to `evaluate`, `createStrategyInstanceRuntime`, `restoreCheckpoint`, `rebuildStateFromPatches`, `validateEvaluationInput`, `materializeCheckpointableJson`, `isRngState`, `isReservedRuntimeReasonCode`, and the clock read. `acquireEvaluationInput` now takes ONE inert deep-frozen snapshot before validation or invocation, and the caller's objects are no longer frozen in place — ownership genuinely changes hands. The JSON boundary moved `Array.isArray` inside the guard, gained a total `describeCause`, went iterative, and refuses past `MAX_MATERIALIZED_DEPTH = 64` (stack safety and a stated downstream contract argued as different guarantees); attribution is now per region. `restoreCheckpoint` accepts r2's out-of-scope ruling as wrong and reads its document once. `checkpointableJsonProblem` was DELETED rather than renamed, since a rename keeps the footgun with a label. **Self-found and disclosed**: because acquisition now invokes a getter, a view getter could re-enter `evaluate()` before the re-entrancy flag was set — found by its own change, fixed, mutation-checked (M13). 13 mutation checks, with a DISCARDED first M4 attempt disclosed rather than reported as a result. Six existing test files changed, all disclosed (the three `json*` files swap the deleted export for a local helper with assertions unchanged; `decision-commit-ordering.test.ts` rewrites the "unfreezable view is REFUSED" test because the old test asserted the mechanism that WAS the defect). **Performance measured, not asserted, and referred to round 4 for judgment**: 26.3 → 63.8 µs/eval on a 40-level book (+37.5 µs, ~2.4×) and 8.24 → 18.12 µs on a small input, after two optimizations took the large case from 118.0 → 65.2 µs first; the mitigation is a WP-230 follow-up to size views to what strategies actually read, since cost is proportional. Review round 4 dispatched on `bed2f1c` with the sweep's COMPLETENESS as its central question.) Round-3 record (review on `15e032f`: CHANGES REQUIRED — round-2's HIGH CLOSED and independently reproduced, but ONE NEW HIGH + 2 MEDIUM + 1 LOW; acceptance 1 and 3 still fail. **NEW HIGH**: evaluation INPUT views are frozen but not MATERIALIZED — `deepFreeze` makes properties non-configurable but leaves Proxy traps and getters live, `validateEvaluationInput` reads unguarded, and `buildRecord()` RE-READS the caller's live `input.market.marketId` outside containment. Two reproductions: a market Proxy throwing on its third read let the callback run and advance the RNG with no record and no checkpoint, reusing sequence 0; and a getter-based view returned market A to the callback but market B to the persisted record — a silent divergence a wider try/catch would not prevent. **M1**: the JSON boundary is not total despite its "never throws" contract — a revoked Proxy escapes through unguarded `Array.isArray` (both exported functions), `describeCause()` itself throws evaluating `cause instanceof Error`, and ~3,500 nested ORDINARY objects overflow the stack; the outer catch contains them but MIS-ATTRIBUTES as `DECISION_INVALID` rather than `STATE_PATCH_INVALID`. **M2**: `restoreCheckpoint` violates the same contract via its disclosed double read — a getter returned noncanonical bytes for parsing and canonical bytes for comparison, and a throwing second read escaped both `restoreCheckpoint` and `createStrategyInstanceRuntime`; **the reviewer REJECTED round 2's out-of-scope ruling** on the grounds that state restoration IS a WP-170 deliverable, the APIs promise never to throw, and WP-230's workplan does not own `packages/strategy-runtime/**`. **LOW**: `checkpointableJsonProblem` remains a validate-then-retain footgun, and since the package is not yet accepted, "removing an export is breaking" is not a strong reason to keep it. The reviewer re-confirmed the `node:` ruling and judged the post-freeze Proxy state patch reaching DECIDED to be SOUND (only the inert one-read copy is retained). Remediation round 3 dispatched with an explicit instruction to apply the underlying principle globally — materialize once, use that snapshot everywhere; make every "never throws" API total — and to enumerate every caller-data entry point, since three rounds have each found the same class on a new surface.) Round-3 record (remediation r2 verified 2026-09-03: tip `15e032f`, rem commit `bd630f0` + test extension `bb5e6f4`, ff-merged; scope exactly 6 files, lockfile byte-identical, NO existing test changed (root 143/3681 = base 141/3661 +2 files/+20 tests, arithmetic closing both ways), check:deps unchanged 34/29. The round-2 HIGH is fixed on BOTH halves. Detection: the boundary now MATERIALIZES rather than detects — `materializeCheckpointableJson` validates and copies in ONE walk reading every own key/descriptor/value exactly once inside a guard, on the reasoning that detection is undecidable (a trap's answer is a program, not a property); `checkpointableJsonProblem` is that same walk with the copy discarded, so validator and materializer cannot drift, and both are now TOTAL. The materialized copy reaches state, checkpoint bytes AND the persisted record (a record holding the strategy's live object would be the same divergence one level down). Ordering: `prepareDecision()` moves the whole fallible region — Zod parse, snapshot-ref and reserved-code checks, materialization, state merge, canonical serialization — ahead of `DecisionSink.persist` and inside containment, leaving only assignments and the checkpoint port after persist; result `first=DECIDED / sequences=[0,1] / checkpoints=[0,1]`. The reproduction found THREE MORE escaped-throw routes beyond the finding (an eagerly-throwing Proxy through the exported validator; a hostile returned decision through `safeParse`; an unfreezable input view through `buildStrategyContext`), all fixed; the last is ruled an INPUT refusal since the callback was never invoked (deviation 1, disclosed). Node built-in question answered correctly and orchestrator-confirmed: dependency-direction §3 does not forbid one here, but WP-170's OWN shipped acceptance-2 pin (package-boundaries.test.ts ~line 176) bans `node:` imports, so `node:util`'s `types.isProxy` would have meant editing a shipped acceptance mechanism — and would have fixed neither the exotic-value class nor the ordering half. Five mutation checks recorded. Review round 3 dispatched on `15e032f`.) Round-2 record (review on `f639bd0`: CHANGES REQUIRED — **H1 CLOSED** (retained-context revocation confirmed by the reviewer's own probes: all ten capabilities refuse post-return, the three RNG methods guard before drawing, the seed-"1" values hold at `2958390140` for both the next decision and the restored tail, retained facade and bound method also revoked, no route found from frozen views to mutable state; the throw-not-return judgment, the reuse of `RUNTIME.CALLBACK_THREW`, and uniform revocation all judged sound), but ONE NEW HIGH: **M1 is still bypassable by a Proxy presenting an `Object.prototype` prototype** — descriptor inspection cannot exclude exotic objects, so `checkpointableJsonProblem({nested: proxy})` returns `null`, and the proxy then throws during `deepFreeze` at commit, i.e. AFTER `DecisionSink.persist()`. Reviewer transcript: `validator=null / first=Error:POST_FREEZE_PROXY_GET / second=DECIDED / sequences=[0,0] / checkpoints=[0] / status=ACTIVE`. Three consequences: an accepted state patch escapes `evaluate()` as an uncaught throw (breaking containment), a decision is persisted with NO checkpoint (durable record and recoverable state disagree), and evaluation sequence `0` is REUSED. Acceptance 1 and 3 FAIL on this; acceptance 2 PASS. All enumerated ordinary forms from round 1 verified correct (nested/top-level symbols, non-enumerable, getter/setter, array extras, holes refuse; normal shapes pass; `getterCalls: 0` — descriptor inspection genuinely never invokes a getter). Remediation round 2 dispatched: the ordering half (no persist before the whole fallible region completes) is weighted equally with the detection half, plus the no-duplicate-sequence and no-escaped-throw invariants as permanent pins.) Round-2 record (remediation r1 verified: tip `f639bd0`, rem commit `48cea4c`, ff-merged into the canonical branch; scope exactly 9 files, lockfile byte-identical, packages/strategy-sdk and packages/domain untouched; gates reproduced: root 141/3661 = base 139/3641 **+2 files/+20 tests exactly**, check:deps unchanged 34/29, typecheck, lint, frozen install. H1 fixed by an invocation-scoped `ScopedStrategyContext` revoked in a `finally` around the callback, with the guard placed BEFORE each RNG draw so a refused draw cannot advance the stream; typed `StrategyContextRevokedError`. The remediation located the reviewer's unstated seed ("1") by searching the sfc32 stream rather than assuming it, and audited all ten capabilities (only `rng` is a determinism hazard; the rest are stale-read hazards; all ten revoked anyway). **M1 was worse than reported**: a top-level symbol key was already caught by the domain schema, but a NESTED one passed the whole runtime — outcome `DECIDED`, entry into live state, checkpoint bytes omitting it, so live and restored instances disagreed; validation now enumerates with `Reflect.ownKeys` and inspects descriptors before reading values (never invoking a getter), refusing symbol keys, non-enumerable, accessor, and non-index array own properties. Six mutation checks recorded. Review round 2 dispatched on `f639bd0`.) Round-1 record: CHANGES REQUIRED — 1 HIGH, 1 MEDIUM, 1 disclosed LOW. **H1**: a retained `StrategyContext` can advance the live RNG after its callback returns — the frozen RNG facade closes over the mutable runtime RNG and is never revoked, so an out-of-band `retainedCtx.rng().nextUint32()` shifted the same-seed second draw from `2958390140` to `798431460`, and a checkpoint-restored tail diverged from the live tail; violates acceptance 3. **M1**: `checkpointableJsonProblem` accepts symbol-keyed state that canonical serialization silently drops (validation and serialization both use `Object.keys`), so the documented "symbols refused" grammar is false and direct callers can lose state. **L1** (accepted as LOW): in-place freezing of caller views is hazardous but candidly disclosed; reviewer's residual ask is a WP-230 integration test proving fresh/copied views. Acceptance 1 PASS (call discipline; no context persist capability exists), acceptance 2 PASS precisely scoped (the boundary test reads manifests and all package source imports — a real pin, not a tautology), acceptance 3 FAIL pending H1. Reviewer independently re-derived the RNG golden (cyrb128/sfc32, seed 12345 → `3778592554`) confirming it is not self-recorded; watchdog containment judged honest incl. its stated inability to preempt a synchronous loop; UUID refusal, purity, and PAPER safety all clean. Remediation round 1 dispatched.) | WP-020 ✓ WP-040 ✓ | Strategy SDK + deterministic runtime (handoff §9.6). Orchestrator verification: 29 files confined to allowed paths; lockfile +11 lines, workspace `link:` entries only inside the two pre-existing importer blocks, zero external packages; reproduced at tip: root 139/3641 (base 130/3536 — growth exactly +9 files/+105 tests), check:deps PASS 34 packages / 29 edges (+3: sdk→domain, runtime→domain, and the pre-listed §2.1 S1 row now live — no contract edit), typecheck, lint, and `pnpm install --frozen-lockfile` PASS. Two disclosed environment conflicts, both orchestrator-resolved: (E1) the harness isolated the relaunched Opus implementer into a NEW worktree instead of the killed Fable agent's, so it ported the predecessor's uncommitted material and committed on its own branch — orchestrator verified the predecessor tree byte-identical (`diff -rq` clean across all sources/tests/manifests) with zero commits, then deleted it; (E2) the implementer's command policy refused `pnpm install` in every form, so its lockfile claim rested on `git diff` inspection — the orchestrator has since run `--frozen-lockfile` successfully. Both are recorded in the review packet for independent judgment. |
| `WP-180`               | REVIEW ROUND 9 IN FLIGHT — re-dispatched 2026-09-04 in-harness. (Dispatch history, orchestrator-verified: the prior session recorded "round 9 dispatched" at `76eba1d` but left NO review job record anywhere — the dispatch did not survive that session's end. The 2026-09-04 re-dispatch via Codex with the saved packet was killed ~9 minutes in by its content filter while reading `schema-arena.test.ts` ("flagged for possible cybersecurity risk"), despite the neutral-framing preamble; a registry sweep of all 102 recorded Codex jobs found NO entry for any of WP-180's eight prior rounds either — this package's prototype-pollution test content does not pass that filter, so its reviews run in-harness. Round 9 now runs as a fresh in-harness adversarial reviewer with the identical technical packet, adapted only for worktree read-only discipline and scratch-copy mutation reproduction.) (remediation r8 verified 2026-09-03: tip `1b962a0`, rem commit `48b3a19`, ff-merged; scope exactly 21 files, lockfile byte-identical; gates reproduced: root 145/4017 = base 144/3960 (+1 file/+57 tests), check:deps PASS 34/30, typecheck, lint, frozen install. **Setter invocations are now ZERO at every door, every key, both setter modes.** The implementer REJECTED the orchestrator's leading candidate with a measurement — "the assembly threw, so the answer is valid" is itself a fail-open because zod interleaves per-key validation with per-key assignment (probe: an invalid `b: 42` was never reported because a throwing inherited setter aborted after one call with `issues: []`) — and instead took the reviewer's other route: a new `schema-arena.ts` returns a PARSING COPY of each schema, built by zod from zod's own definition (no validation rule reimplemented), assembling into a prototype-free container with a null-prototype parse context and the interpreted parser forced. Shared schemas including the frozen `IntentSchema` are CLONED, never mutated. **Two further LIVE fail-opens closed, neither reported: an inherited `skipChecks` turned every format check in every door into a no-op (`"not-a-uuid"` validated at `cd076e9`; orchestrator-confirmed independently), and a descriptor written as an object literal is read through the chain, so an inherited `get` made every `Object.defineProperty` throw — escaping `evaluateIntent`, which falsified round 6's totality claim.** The census now classifies `Object` in full with a FAIL-CLOSED default; mutation M-R8g reproduces the reviewer's strong mutation at both tips (round-7 census: 33/33 PASS — fails open; round-8 census: FAILS naming both sites). Review round 9 dispatched on `1b962a0`.) Round-8 record (review on `cd076e9`: CHANGES REQUIRED — 1 BLOCKER, 1 MEDIUM, zero HIGH/LOW; **all four acceptance criteria PASS**. **BLOCKER — the round-7 rule was necessary but not sufficient**: discarding the schema's output does not stop the library CONSTRUCTING it, and construction assigns onto an ordinary object whose prototype the caller can pollute, so a throwing inherited SETTER at `Object.prototype.reason` still fires during output assembly (`setterCalls=1, approved=false, RISK_INPUT_INVALID`) and containment converts it to a refusal before the disposition is known, leaving the cancel choke point unreachable; an ACCEPTING setter was invoked three times across validation plus evaluation. **The same probe also fails at `d180e3f`, so this is a surviving trap, not one introduced by round 7.** The reviewer explicitly forbade the cheap fix — malformed-input refusals may NOT be let through the cancel override. **MEDIUM — the census fails OPEN on unrecognized `Object` members** (`prototype-access-scan.ts:305` returns `undefined`), and already misses three LIVE product sites (`caps.ts:107`, both `plain-data.ts` copies); a mutation adding exported `Object.getPrototypeOf`/`setPrototypeOf` calls passed BOTH package typechecking and the census's own "every site registered" test. `Object.fromEntries` and `with` are likewise unclassified and absent from the claimed-complete exclusion list. The three current `getPrototypeOf` uses are correctly guarded, so this is a mechanism defect rather than a demonstrated bypass. Remediation round 8 dispatched with the extra clause stated — **the library must not be able to produce side effects we do not consume** — and a leading candidate offered: since the output is discarded anyway, a failure during output ASSEMBLY is irrelevant to the only question asked, and an assembly throw is distinguishable from a validation error (the library reports the latter as its own typed error). The detector must additionally fail CLOSED on any unrecognized `Object` member, which is the single change that stops this class recurring. Reviewer confirmations preserved: `getOwnPropertyDescriptors` under exclusion item 2, `Array.from`/`for…of`/iterators under item 3, `JSON.stringify`/coercion under item 5, `super` under item 7; R6-1 remains open, untouched and non-blocking.) Round-8 record (remediation r7 verified 2026-09-03: tip `cd076e9`, rem commit `d2bd5ba`, ff-merged; scope exactly 17 files, lockfile byte-identical; gates reproduced: root 144/3960 = base 143/3914 (+1 file/+46 tests), check:deps PASS 34/30 unchanged, typecheck, lint, frozen install. **The architectural route was taken and it uncovered three LIVE fail-opens at the reviewed tip that no review had asked about.** No door reads the schema library's output any longer: each materializes the input, asks the schema only the QUESTION, and uses its own prototype-free tree as the value — so adoption and field loss stop being conditions to detect and become unreachable, and the loss machinery is deleted from both copies with no loss arm anywhere. The limit was measured rather than assumed: across all seven door schemas the only value-producing construct is `.default()` (five have none, two have seven between them), and those two now apply defaults from a DECLARED TABLE, because taking a default from the output is the same mistake. **With one get-only inherited accessor and no other hostile input, at the previous tip: `requireVerifiedSettlementForEntries` → §9.8 check 6 skipped, an unverified settlement APPROVED; `requirePositiveNetEdgeForEntries` → check 12 skipped, a negative net edge APPROVED; and `maxRunMode` → check 2 gone, so LIVE no longer exceeded the maximum — a run-mode ceiling silently ceasing to be enforced.** The orchestrator independently confirmed the mechanism (a get-only inherited accessor makes a schema's own `.default()` never land in the output as an own property while the parse still succeeds). Re-probe clean, and all 28 cells of the widened cancel matrix at `same=true approved=true calls=0`. The census gained six kinds (`object-destructure`, `for-in`, `reflect-chain` failing closed on unknown `Reflect` members, `object-entries`, `structured-clone`, `own-enumeration`) with 12 product sites registered with reasons and pinned counts and the excluded forms now stated IN FULL; the null-prototype obligation is consumer guidance in BOTH READMEs with every row measured; **R6-2 is closed**, and a CANCEL now tolerates NO sweep divergence. This round removes six ways to trap a cancel and adds none. Eight mutations, each killing its named test. Review round 8 dispatched on `cd076e9`, asked FIRST to reproduce the three fail-opens at the previous tip and confirm their closure, then to attack the remaining seam — the defaults table itself, where a schema default missing from the table would be a silent fail-open of exactly the kind just closed.) Round-7 record (review on `d180e3f`: CHANGES REQUIRED — 1 BLOCKER, 1 MEDIUM, 1 LOW; **all three round-6 BLOCKERs confirmed CLOSED under the reviewer's own probes and all four acceptance criteria PASS**. **BLOCKER — self-inflicted by the round-6 fix**: the parse-output loss check traps a semantically VALID cancel. With only a get-only `Object.prototype.reason` present, the caller's input kept its own valid `reason`, the prototype-free materialized input was intact and the schema reported success, yet `inputs.ts:463` refused with `RISK_INPUT_INVALID` before the choke point — the lost field was an internal output-assembly artifact, not malformed caller input, so §6 invariant 13 protects this cancel and the round-6 argument does not hold. **MEDIUM**: the census is not complete over prototype-sensitive syntax — destructuring, `Reflect.get`, `for...in`, `Object.entries`/`values` and `structuredClone` are all silent AND undisclosed (only dotted reads were disclosed); no present fail-open was reproduced through them, but a future regression in any of those forms would pass unclassified. **LOW**: the null-prototype public-value change needs consumer-facing guidance (`record instanceof Object` false, `hasOwnProperty`/`toString` undefined, and spread or `structuredClone` silently RESTORE `Object.prototype`, un-hardening the value). Remediation round 7 dispatched with the architectural fix stated: stop treating the validator's constructed output as the value — the prototype-free materialized tree is built BEFORE parsing, so validate with the schema but take the DATA from that tree, which sidesteps adoption and loss together and removes the need for the loss check on the cancel path. **Reviewer resolved a question that had been open since round 5: the `node:util` import does NOT independently block acceptance** — the layer-1 contract has no blanket built-in prohibition, `check:deps` passes and the import is unchanged; R6-1 stays open for the contract owner but is no longer a gate. R6-2 (pollution scenarios not joined to the export matrix) carries; **R6-3 is escalated by the orchestrator to a repository-wide contract-owner item — see "Cross-package risk" under Open blockers**.) Round-7 record (remediation r6 verified 2026-09-03: tip `d180e3f`, rem commit `80dde09`, ff-merged; scope exactly 25 files, lockfile byte-identical; gates reproduced: root 143/3914 = base 140/3856 (+3 files/+58 tests), check:deps PASS 34/30 unchanged, typecheck, lint, frozen install. **The sweep became a machine, and the machine immediately earned its keep.** Three mechanisms were built — a `ts.Program` census of every element access / `in` / compound assignment / `delete` / spread / `Object.assign` (each requiring an own-property primitive or a registered exception with a reason and pinned count), a prototype-pollution differential over 18 public doors with keys derived from each door's own inputs, and an export matrix — and **each found a defect no reviewer had reported**: `"value" in descriptor` in four places (an accessor would have read as data); an inherited get-only accessor making zod's own assignment fail, which had `resizeApprovedIntent` emitting a record whose `approvedIntentId` came from the prototype; the live-micro fence reading an INHERITED cap as "absent, therefore fine" while `reserve.ts` read the same inherited value AS the cap (the two disagreed about one state); and `withLiveOwner` throwing. **The most consequential discovery, orchestrator-confirmed against the pinned version: `zod` ADOPTS an inherited optional field into its validated output** — an object whose own keys are `['a']` with `b` on its prototype parses to `{"a":"x","b":"inherited"}`. A parse output is therefore NOT by itself clean data. The fix accordingly goes beyond own reads: the materialized tree and **every parse output are now prototype-free**, and each door refuses a parse output that LOST a field (adoption adds; a get-only accessor drops — both halves needed). **This may apply to any other package in the repo that parses caller input; recorded as cross-package follow-up R6-3 and put to review round 7 for a repository-wide judgment.** B3's false absolute is replaced by a classification ENUMERATED FROM THE MODULE NAMESPACE with BOTH sides proved — `total` entries by running the hostile call, `propagates` entries by requiring them to throw. **18 mutations, ZERO survivors**, including the four historical misses each killed BY THE CENSUS, BY NAME, with no list edited; round 3's field-list miss is honestly mapped to the round-3/4 tests rather than claimed for the census; round 5's surviving M-R5l is now killed. Cancel choke point re-verified across 14 probes — this round REMOVES a cancel trap and adds none but one disclosed exception. Cost measured: mechanisms 2.05 s / 56 tests; full suite +1.5%. Disclosed public-value change: emitted records now have a `null` prototype. Open for the contract owner (untouched this round): follow-up R6-1, whether a layer-1 package may import a Node built-in.) Round-6 record (review on `f990fb1`: CHANGES REQUIRED — **3 BLOCKER**, 3 LOW. The r5 defects are fixed at their original sites (the reviewer reproduced all three independently from an isolated archive of `2e8ee90` before confirming), but the prototype-chain sweep was incomplete. **B1 — the most serious finding in this package's history, a fail-open on the LIVE-ownership gate**: `reserve.ts:239` reads `state.liveOwners[req.marketId]` through the prototype chain (`:293`/`:294` and `exposure.ts:154` likewise), so an inherited owner gave `permitted=true, refusals=[]` where `CAPITAL_LIVE_OWNERSHIP_MISSING` was owed — and augmenting `Object.prototype` with a valid market UUID flipped a **library-created** state from refused to permitted, so this is not only a hostile-input problem; a two-answer inherited getter also made a SELL with ZERO holdings see `held=1000` and return `permitted=true`. **B2**: `inputs.ts:297` uses `"intentId" in intent`, which consults `Object.prototype`, so an inherited non-canonical UUID TRAPS a valid CANCEL (`RISK_UUID_NOT_CANONICAL`) — the §6 invariant 13 direction — and an inherited throwing getter made `validateEvaluationInput` THROW with the getter invoked twice. **B3**: the unconditional totality claim (risk/README.md:318, handoff:3069) is false — `assessWorstCase`, `riskRefusal`, `exposureSnapshot`, `nonFloorLiveMicroCapFields` and `validateEvaluationInput` all threw on Proxy input; the `contained`-wrapped boundary functions are total but the exported SURFACE is not, and `validateEvaluationInput` (which already returns a typed union) must not throw. LOWs: the `types.isProxy` pin is lexical and bypassable by aliasing/destructuring/computed access (explicitly NOT making the r5 purity-test rewrite a blocker, since the source uses only `isProxy` and other `util.types` predicates introduce no I/O); M-R5l turns out to BE distinguishable so its killing test should be added; the duplicate boundary still needs its byte-comparison guard. **Remediation round 6 dispatched with the sweep made MECHANICAL.** Four consecutive rounds have had an incomplete manual enumeration — r3's field list, r4's `Object.entries` walk, r5's table sweep (which missed `reserve.ts`'s three sites, `exposure.ts:154`, and the `in` operator entirely), and now r6. The primary deliverable is therefore no longer the three fixes but a mechanism that FAILS THE BUILD on any prototype-consulting read of a caller-derived key anywhere in either package — an AST-driven rule enumerating every bracket read, `in`, computed `??=`/`||=`, and spread onto a non-null-prototype object, each of which must be an own-property helper or a registered exception with a reason — proved by reintroducing all four historical misses and showing it fails for each BY NAME with no list edited. This mirrors the sibling WP-170's accepted answer: stop scanning, start resolving.) Round-6 record (remediation r5 verified 2026-09-03: tip `f990fb1`, rem commit `c7a97cc`, ff-merged; scope exactly 22 files, lockfile byte-identical, nothing under domain/oms/adr/contracts/db or the sibling packages; gates reproduced: root 140/3856 = base 140/3831 (+25 tests, +0 files), check:deps PASS 34/30 unchanged, typecheck, lint, frozen install. All three r5 BLOCKERs fixed. **TWO FINDINGS THE ORCHESTRATOR INDEPENDENTLY CONFIRMED, both discovered by the remediation rather than any reviewer.** (1) The `Object.defineProperty` fix for `__proto__` was **NOT sufficient on its own**: zod's `strictObject` is blind to exactly that key — an object carrying own enumerable `__proto__` and `zzz` yields unrecognized-keys `[["zzz"]]` only, and `__proto__` alone parses clean (orchestrator re-ran this against the pinned zod). `__proto__` is therefore now refused as a property name outright. (2) **A live defect in a risk-limit path that no review reported**: a scope key is a `CodeString`, so `"constructor"` is admissible, and `table["constructor"]` answers the `Object` constructor rather than `undefined` — orchestrator confirmed both the base code shape (`exposure.ts:65` `table[key] ??= {…}`, `:186` `out[key] ??= ZERO_ENTRY`) and that `t["constructor"] ?? "MISSING"` yields the constructor. At the previous tip that would have written commitment components onto `Object.prototype` then thrown, made `exposureSnapshotCovering` skip the explicit zero it exists to guarantee, and made **round 1's BLOCKER-2 fix (`RISK_EXPOSURE_ENTRY_MISSING`) read an intrinsic as a measurement**. Every table in both packages now uses `ownEntry`/`setOwn`; the `zeroFilled` fixture had the same defect. B2 route: `node:util`'s trap-free `types.isProxy`, gate-proved (check:deps unchanged, no new workspace edge; `isPurityRestricted` covers only domain/strategies/ledger/simulation, F15 binds only decimal), PLUS all three narrowing mechanics implemented anyway (descriptor-read `length`, a total `describeValue` replacing the `String(reported)` escape, an outer `contained` guard on every public entry point). B3: six entry points materialize before parsing. The falsified absolutes are NARROWED rather than re-asserted. 16 mutations, 13 killed; **three survive and are reported, not hidden** (defence in depth behind the Proxy refusal, with M-R5f reconstructing the whole r5 escape as evidence the layer is live). **Two items referred to round 6 for judgment.** (a) Deviation R5-4: an EXISTING purity assertion was rewritten — `freshness.test.ts` asserted no `node:` import at all; it is now an exact-match allowlist pinning one audited line character-for-character, plus a dynamic-import refusal, plus a new test pinning where that line may appear and that the binding is used only as `types.isProxy`, extended to cover the allocator which it did not before. The implementer flags this as most open to challenge; the review must rule whether it is a legitimate strengthening-with-one-audited-exception or a test relaxed to let the fix pass. (b) The `node:util` import makes both packages structurally **Node-only**, and layer 1 has no documented built-in allowlist — this is the first case. **Contract-owner follow-up R5-1 is open**: whether layer 1 may import Node built-ins at all. Round 6 is asked to rule whether that must be settled by a governance round before acceptance.) Round-5 record (review on `2e8ee90`: CHANGES REQUIRED — **3 BLOCKER**, all inside the data-record boundary r4 introduced; everything else re-verified CLOSED with a clean regression sweep (valid CANCEL still approved under run-mode mismatch, allocator refusal, missing market context and all three at once; `RISK_EXPOSURE_ENTRY_MISSING`; live-micro `"0"` accepted with `"0.0"`/`"0.00"` refused; cardinalities risk 62/62 and allocator 19/19; the standing `orderId` ruling preserved in both source and README). **B1**: `__proto__` is not materialized as an own data property — `out[key] = ...` invokes the inherited `Object.prototype.__proto__` setter, so a draft carrying a non-enumerable own `__proto__` was ACCEPTED (`ok=true, ownProtoKey=false, plainPrototype=false, prototypeFrozen=false`) and adding an uppercase UUID `marketId` to that prototype after return changed `record.marketId`, bypassing identity validation AND deep immutability. **B2**: the boundary DOES run Proxy-controlled caller code and can still throw — a plain-looking Proxy was accepted with three trap invocations, one nested in a resize record with nine, an exotic descriptor executed four getters inside `Object.getOwnPropertyDescriptor`, a lying descriptor still returned `ok:true`, and an array Proxy whose `length` had a throwing `Symbol.toPrimitive` escaped through `String(reported)` so the PUBLIC `resizeApprovedIntent` threw. **B3**: public input paths still inspect caller objects directly through Zod (inputs.ts:367, policy.ts:100, caps.ts:139), so a throwing accessor escapes as an exception from `evaluateIntent`, `parseRiskPolicy` and `parseAllocatorCaps` — the CANCEL never reaches the choke point. Reviewer rulings recorded: the shape-agnostic adaptation is REASONABLE and avoids duplicating the frozen union, but is not equivalent to schema-driven reconstruction as implemented because `__proto__` can change the snapshot's representation before the schema runs; the one-primitive claim PASSES only for identity traversal and FAILS package-wide (`deepFreeze` uses `Object.getOwnPropertyNames`, `exposure-limits.ts` retains `Object.entries`, both on validated data); no new refusal traps an ordinary valid CANCEL; all five remaining exclusions round-trip as intended and `rationale: DetailStringSchema` is real and in-grant. Remediation round 5 dispatched with the meta-lesson made explicit: **three consecutive rounds have falsified an absolute claim this package made about itself**, each true of the tested cases and false of the adversarial one. Key decision referred to the implementer with the facts: portable JS has NO trap-free Proxy detection, but `packages/risk` is NOT purity-restricted (F14 binds only domain/strategies/ledger/simulation; F15 only decimal), so `node:util`'s trap-free `types.isProxy` may be permissible here where WP-170's own acceptance pin forbade it — it must prove `check:deps` still passes, or else take the reviewer's explicit alternative and NARROW the contract honestly (traps may run; guarantee totality and plain-frozen output instead).) Round-5 record (remediation r4 verified 2026-09-03: tip `2e8ee90`, rem commit `7341339`, ff-merged; scope exactly 8 files, lockfile byte-identical, `packages/capital-allocator` byte-identical; gates reproduced: root 140/3831 = base 140/3818 (+13 tests, +0 files), check:deps unchanged 34/30, typecheck, lint, frozen install. **Route chosen: materialize.** A new `packages/risk/src/plain-data.ts` reads a value into plain own data before anything inspects it, taking values from PROPERTY DESCRIPTORS so no caller code runs inside the boundary (`invoked: 0`, `reads: 0` on re-probe); non-plain prototypes, accessors, functions, symbol keys, cycles, sparse arrays and over-deep nesting are typed refusals, while a non-enumerable own DATA property is READ so r4's probe now yields `RISK_UUID_NOT_CANONICAL` naming the exact path. The package now claims exactly ONE traversal primitive, with the identity check consuming the read's string inventory rather than walking again. **Two more defects found by its own probes**: the old code read one property TWICE (a latent validate-then-emit gap) and let an accessor survive INTO the emitted record; plus two further totality holes (a non-object `record` argument and a non-iterable `reasons` spread). **Round 3's surviving mutation M-R3e is now KILLED** — materializing made the engine's use of the boundary observable. Deliberate adaptation referred to round 5: the deep read is SHAPE-AGNOSTIC rather than schema-driven, argued because restating the domain's `Intent` union inside `packages/risk` would copy a frozen contract and refuse the day `packages/domain` adds a field — on a path that also emits cancels; the record's own shape does get a complete schema (`ApprovedIntentRecordSchema`, `intent: IntentSchema`). LOW closed: singular `orderId` removed from the exclusion set, `rationale` GAINED the missing `DetailStringSchema` annotation rather than losing its exclusion, and the `PortfolioOpenOrderSchema.orderId` "venue-supplied" claim is withdrawn in both `inputs.ts` and the README — consistent with the standing orchestrator ruling, which this round asserts nothing contrary to. Test oracles are now module-scope and independent of the product (`Reflect.ownKeys` + descriptors + prototype-chain walking), which was the r4 defect's root. Ten mutations, every new test killed by one. Review round 5 dispatched on `2e8ee90`.) Round-4 record (review on `d81bdce`: CHANGES REQUIRED — 1 BLOCKER, 1 LOW; **the orchestrator's ruling on the escalated MEDIUM was upheld — the reviewer raised no objection to it and instead found the source text overstating the venue-supplied claim, which the remediation must correct**. **BLOCKER**: the structural walk's ENUMERATION PRIMITIVE is the new list — both the product walk and its property test use `Object.entries`, which sees only enumerable own properties, so making the existing `worstCase.perMarket[0].marketId` non-enumerable emitted the uppercase UUID (`ok:true`); moving it to the PROTOTYPE emitted it too AND left the returned record mutable through the prototype despite reporting frozen; and an enumerable getter threw out of `resizeApprovedIntent`, contradicting its total typed-result contract. Because the test walks the same way, it could never catch what the product missed. **LOW**: two exclusions are not contract-backed as claimed — singular `orderId` is not equivalent to `VenueOrderId`, and `IncidentActionRecommendation.rationale` is an unconstrained `string`, not `DetailStringSchema`; a probe round-tripped a repository-style UUID under each excluded key. Remediation round 4 dispatched: establish a data-record boundary (reconstruct through a complete runtime schema into plain own-data, or typed-refuse exotic shapes), and use a test oracle that does NOT repeat `Object.entries`.) Round-4 record (remediation r3 verified 2026-09-03: tip `d81bdce`, rem commit `ced043f`, ff-merged; scope exactly 5 files, lockfile byte-identical, **`packages/capital-allocator` byte-identical because the MEDIUM was escalated, not applied**; gates reproduced: root 140/3818 = base 140/3810 (+8 tests, +0 files), check:deps unchanged 34/30, typecheck, lint, frozen install. **The BLOCKER was one instance of a far wider defect**: driving each of the 62 string positions of valid POSITION and REDUCE_POSITION records hostile produced 45 bad outcomes — 43 emitted contract-invalid records across 27 distinct positions (incl. `worstCase.perMarket[].marketId`) plus 2 uncaught `InvalidDecimalStringError` throws escaping a typed-refusal contract. The field list is gone: `sealApprovedIntentRecord` is now the SINGLE emission boundary all three emitting paths pass through, and it WALKS the record it is about to emit (every string, every depth) rather than consulting names; the resize also walks the inherited record and parses the inherited intent against `IntentSchema`. Exclusions are a closed contract-anchored set (`orderId`/`orderIds` §7.2, `reason`/`resizeReason`/`rationale` prose, `tags` §7.7). A seventh field is caught with no test edit because the new property test generates its cases by the same walk, and asserts the complement so the exclusion set cannot quietly grow. Seven mutations; **M-R3e survives and is disclosed, not hidden** (every engine record string is already door-validated, so no test can distinguish the boundary there; kept as an independent floor). No existing test changed in substance. **ORCHESTRATOR RULING on the escalated MEDIUM — the implementer was right and review round 3 was wrong.** Round 3 directed removing the allocator's ADR-016 check on `openOrders[].orderId` as a venue identifier; the implementer refused per its stop condition and produced contrary evidence, which the orchestrator independently re-verified line by line: `db/migrations/0005_execution.up.sql:213` declares `order_id internal.uuid_v7 primary key default internal.uuid_generate_v7()` with the venue's id in a SEPARATE `venue_order_id` column (:234, unique index :345-348), and `packages/storage-postgres/src/repositories/orders.ts:195` mints it in-process via `uuidV7()`. The two packages hold DIFFERENT fields: `CancelIntent.orderIds` is typed `VenueOrderIdSchema` (intents.ts:171; `VenueOrderIdSchema = VenueIdentifierSchema`, identifiers.ts:65) so risk's exclusion is correct, while the allocator's `OpenOrderCommitmentSchema.orderId` is typed only `NonEmptyStringSchema` (state.ts:76). Ruling: no code change is warranted; the round-3 MEDIUM compared two different fields. **Genuine residual (contract gap, for a future contract-owner round):** annotate which identifier `OpenOrderCommitmentSchema.orderId` and `PortfolioOpenOrderSchema.orderId` carry, so this is settled as a fact rather than a reading. Review round 4 is asked to rule on this orchestrator disposition. Also carried to the contract owner: a digit-leading UUID `strategyInstanceId` refuses as `RISK_INPUT_INVALID` (`CodeStringSchema` requires a leading letter) while `db/migrations/0004_strategy.up.sql:68` defines `instance_id internal.uuid_v7` — needs alignment before a composition root holds UUID instance ids.) Round-3 record (review on `49246d6`: CHANGES REQUIRED — the reported `approvedIntentId` case CLOSED, but the global property is not: **BLOCKER** — `resizeApprovedIntent` validates selected inherited identifiers yet omits the internal `record.intent.marketId`, then copies the whole intent into the new record; a hand-built typed record with a non-canonical `intent.marketId` resized to `{"ok":true,"emittedMarketId":"…000000AB","codes":[]}`. That is the missed SIXTH internal identity and it defeats the new binding-property test, which never mutates an inherited intent market id. **MEDIUM** — the allocator wrongly applies ADR-016 UUID refusal to `openOrders[].orderId` (state.ts:177), a VENUE identifier ADR-016 explicitly excludes; **the reviewer RULED the asymmetry round 2 referred up**: risk's exclusion is faithful and avoids a cancellation trap, the ALLOCATOR is the inconsistent side, no new ADR is needed, and "stricter is not automatically safe when it rejects a legitimate opaque venue identifier." NOTE carried forward: a digit-leading UUID in `strategyInstanceId` refuses as `RISK_INPUT_INVALID` because `CodeStringSchema` requires a letter first — not a trap today, but it needs contract alignment before any composition root chooses UUID strategy-instance ids. Remediation round 3 dispatched with an instruction to establish the property STRUCTURALLY — a single validated boundary every emission path must pass — rather than by another field list, since round 2's sweep of five fields still missed a sixth.) Round-3 record (remediation r2 verified 2026-09-03: tip `49246d6`, rem commit `18dbcf8`, ff-merged; scope exactly 8 files, lockfile byte-identical, live-micro fence files byte-identical so the round-1 HIGH fix is untouched; gates reproduced: root 140/3810 = base 140/3799 (+11 tests, +0 files), check:deps unchanged 34/30, typecheck, lint, frozen install. The ADR-016 identity check MOVED from the pipeline into input validation via a new single door `validateEvaluationInput(input: unknown)` that parses schema AND identity BEFORE `buildIntentView`, so no disposition exists and the cancel choke point has nothing to override; nothing is case-folded (the raw value rides out on `details.value`, and a normalize-instead-of-refuse mutation is killed by the suite). **The required sweep found the defect was broader than the reported site**: stating the property over emitted RECORDS rather than the one known field produced FIVE contract-invalid record fields from THREE input fields, plus `guards.recentIntentIds[]` (a re-cased entry silently under-matched check 18), plus `resizeApprovedIntent`'s never-parsed `record` argument. Deliberate exclusion referred to round 3: venue-supplied opaque ids (`VenueOrderId`) are NOT refused, on the reasoning that ADR-016 §2 does not touch venue wire formats and refusing one would add a way to trap a position on a CANCEL. The LOW was resolved by correcting the claim rather than binding tests to the handoff, reasoning that the handoff is append-only history and coupling would oblige future packages to edit a closed package's governance record. Seven mutation checks; four existing tests changed, each disclosed (the case asserting the UUID violation was *overridden* was removed as encoding the BLOCKER as the contract). Review round 3 dispatched on `49246d6`.) Round-2 record (review on `1aed569`: CHANGES REQUIRED — **B2, H, and M all CLOSED and all four acceptance criteria PASS**, but ONE BLOCKER on the exact residual round 1 referred up: a UUID-shaped but NON-canonical `approvedIntentId` is approved for a `CANCEL` and copied verbatim into the emitted record (engine.ts:181-188, :951-975). The reviewer RULED the referred question: ADR-016 requires a typed refusal at an input surface and forbids accepting uppercase UUIDs for lookup/persistence; `evaluateIntent(input: unknown)` is such a surface; "safety cancellation outranks new order placement" does not authorize emitting a contract-invalid approved record — so §6 invariant 13 protects a *valid* cancel from policy trapping and does not require accepting a malformed identity. Required: make the identity violation input validation, WITHOUT case-folding. Also 1 LOW: two tests claim to bind the handoff but only read the README. The reviewer independently swept all 32 `??`/`||`/`??=` sites and found no remaining peer-data fail-open; it confirmed no additional valid-cancel trapping path beyond the four the remediation fixed. Remediation round 2 dispatched.) Round-2 record (remediation r1 verified 2026-09-03: tip `1aed569`, rem commit `520c570`, ff-merged into the canonical branch; scope exactly 18 files, lockfile byte-identical; gates reproduced: root 140/3799 = base 140/3763 **+36 tests, +0 files** (added to existing files), check:deps unchanged 34/30, typecheck, lint, frozen install. **B1 fixed structurally, not per-gate**: the audit found FOUR gates that could block a cancel — the reviewer's run-mode and allocator-refusal pair PLUS `RISK_MARKET_CONTEXT_MISSING` and `RISK_UUID_NOT_CANONICAL` — so one choke point now converts every accumulated refusal into a non-blocking `cancelPriorityOverrides` observation and approves the cancel with its typed record; gate audit tabulated in packages/risk/README.md §4.1. Disclosed residual referred to round 2: a cancel cannot bypass input validation itself, so a cancel whose `approvedIntentId` violates ADR-016 is approved with the defect on the overrides but the id un-folded (known_risk 1 — round 2 asked to rule). **B2**: `committed()` has no `undefined` arm; absent entries refuse with the new `RISK_EXPOSURE_ENTRY_MISSING`; the allocator gains `exposureSnapshotCovering` representing each declared queried scope as an explicit zero; a 16-site `??`/`||` sweep found one further real defect (`leg.boundedCost ?? "0"`). **H (safety)**: live-micro caps fenced at exactly `"0"` with `CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED` at three layers — schema, `parseAllocatorCaps`, and the reservation gate in EVERY run mode including PAPER — so a hand-built caps object is unusable; enabling live-micro capacity is recorded as a separate authorized work package, never a caller argument. **M**: the true count was 61 at `f1a00c1` ("56" was never right) and is 62 after B2; allocator 18→19; both pinned as exported constants bound to the README tables by test, and the allocator gained the runtime code list the handoff had falsely claimed existed. Four existing tests changed, each disclosed and justified (the defect-encoding assertion at engine.test.ts:689 corrected in place; seven breach cases re-specified to measure their scope at zero so they still reach the breach under the B2 fix; a fixtures field added with sparse still the default) — none deleted, skipped, or weakened. The stale predecessor worktree has been removed. Review round 2 dispatched on `1aed569`.) Round-1 record: CHANGES REQUIRED — 2 BLOCKER, 1 HIGH, 1 MEDIUM. **B1**: `CANCEL` can be blocked — engine.ts:219 refuses it on run-mode mismatch and engine.ts:593 on an allocator verdict, and the package's own test at test/unit/risk/engine.test.ts:689 asserts that wrong behavior; violates §6 invariant 13 (a cancel must never be blocked). **B2**: fail-open limit bypass — exposure-limits.ts:45 substitutes `"0"` for an absent entry while inputs.ts:105 permits sparse scope maps, so omitted exposure is accepted as zero against a configured cap. **H1** (safety): capital-allocator/src/caps.ts:44 defaults live-micro caps to `"0"` but accepts caller-supplied NONZERO values with no fencing authority — a weakening vector against AGENTS.md's non-weakenable zero defaults. **M1**: handoff/README claim 56 reason codes; `RISK_REASON_CODES` has 61, and the no-dead-entry test does not pin cardinality. PASS: acceptance 2 (worst-case primary; reviewer re-derived YES_WIN 100 / NO_WIN 0 / SPLIT_50_50 50 against WP-110), acceptance 3 entry-staleness and reduction rules, acceptance 4 resize lineage incl. chains, real-order refusal (`RISK_REAL_ORDER_SURFACE_UNSUPPORTED` even with LIVE configured), purity/exactness, inert recommendations, allocator lifecycle/ownership. The CANCELLED zero-redemption floor was judged SOUND in both directions (shares are nonnegative; negative inventory is schema-refused). Remediation round 1 dispatched.) | WP-020 ✓ WP-040 ✓ WP-110 ✓ | Capital allocator + scenario risk (handoff §9.7–9.8). Orchestrator verification: 40 files confined to allowed paths; lockfile +32/−0, importer blocks only, zero new `resolution:` entries; reproduced at tip: root 140/3763 (+10 files/+227 tests exactly), check:deps PASS 34/30 (+4 downward; dependency-direction.md unmodified, §2.1 still exactly S0/S1/S2), typecheck, lint, and `pnpm install --frozen-lockfile` PASS (the implementer could only run `--offline`). Same worktree-mismatch disclosure as WP-170/WP-200 (harness isolated it elsewhere; predecessor material carried in, committed on its own branch; the stale predecessor worktree `agent-a2fb3063d08fa5867` is a strict subset minus a lint fix and is pending removal). Load-bearing design call for the reviewer: `CANCELLED` is never valued — WP-110 refuses `payoutPerShare("CANCELLED")` (U-10), so worst-case loss uses a ZERO-REDEMPTION FLOOR and a hedged YES/NO pair is deliberately not credited its hedge; every assessment carries `cancelledOutcomeTreatment: "ZERO_REDEMPTION_FLOOR_UNVERIFIED_U10"`. Disclosed known risk: `QuoteIntent` has no expected-edge field, so under the default `requirePositiveNetEdgeForEntries: true` every quote intent is refused with `RISK_EDGE_INPUTS_MISSING`. |
| `WP-200`               | Complete (merged `7e75f9a`, 2026-09-03; three review rounds — r1 3 HIGH/1 MEDIUM/2 LOW, r2 4 HIGH, **r3 ACCEPT with zero BLOCKER/HIGH/MEDIUM**, all four r2 HIGH closed under the reviewer's own probes; post-merge gates: root 153/3952, check:deps 34/30, typecheck. Carried LOW residual: the deep-freeze memoisation set is added to BEFORE the freeze succeeds, so a throwing freeze leaves an object memoised but unfrozen — reviewer confirmed it does not reach monetary state today and the helper is not exported from either entrypoint; owner: the next bounded grant touching `packages/{ledger,pnl}/src/immutable.ts` (both duplicated modules need the fix and a throw-then-retry regression). Reviewer NOTE carried: halt enforcement is an INTEGRATION obligation — `applyTransaction` always records `haltRequired: true` for a breached bucket and nothing suppresses it, but a caller can ignore `unexplainedMovements`/`unattributedExposure`; the composition-root convention is owed by whoever builds it. A disclosed pre-merge orchestrator doc fix `372bc0f` corrected the round-2 changed-test-file summary phrase per r3 NOTE 2.) | WP-020 ✓ WP-040 ✓ | tip `881d5e1`, rem commit `788027b`, ff-merged; scope exactly 16 files, lockfile byte-identical, zero docs/adr or docs/contracts files; gates reproduced: root 153/3952 = base 151/3890 (+2 files/+62 tests), check:deps unchanged 34/30, typecheck, lint, frozen install. All four HIGH addressed: **H1** — the remediation reproduced the cross-asset probe and found THREE MORE admissible shapes, including a **bare arrival** (`ACTUAL +5` / `EXTERNAL_CLEARING −5`) that a classification rule structurally cannot see; it took BOTH reviewer routes so "mandatory" is literal — ADR-006 §2 partition validation now lives INSIDE `applyTransaction` with a recorded halt as its outcome rather than a throw (reasoned: a throwing fold leaves an operator with no projection and no diagnosis, and §9.15's remedy is to halt the market, not stop reporting; `append` still refuses these shapes outright), so the property holds by case analysis rather than shape enumeration. **H2** — `consumedRewardEvidence` is derived from the record stream AND serialized so a rebuild reconstructs it. **H3** — bookings sealed leg by leg, handed out as frozen copies, verified through a module-private `WeakMap` rather than the mutable class prototype. **H4** — `frozenMap`/`frozenSet` deep-freeze every key and value with `WeakSet` memoisation; tests assert the downstream divergence, not just the throw. Deep-freeze cost **measured, not asserted**: median 27.9 ms shallow vs 33.2 ms deep over 2000 four-entry transactions (~19%, ~2.6 µs/transaction, no asymptotic change). Ten mutation checks; five assertions in four existing test files changed, each strictly more specific. Review round 3 dispatched on `881d5e1`.) Round-2 record (review on `344ad9f`: CHANGES REQUIRED — zero BLOCKER but **FOUR HIGH**, two acceptance criteria failing. **H1**: the external-history barrier is not general — a CROSS-ASSET SQL-admissible probe (`ACTUAL A pUSD +5`, `CLEARING pUSD −5`, `UNATTRIBUTED A USDC +5`, `VIRTUAL A USDC −5`; each asset sums to zero) folds with the USDC entry classified `REATTRIBUTION`/`haltRequired:false` while the audit reports only the pUSD mismatch, so misplaced attribution still hides an actual arrival (projections.ts:193, :243). **H2**: one booked reward transaction can be realized REPEATEDLY — dedup covers only the PnL record `ref`, not consumed ledger evidence, so two record refs naming the same valid 5 pUSD transaction made `realizedRewards` 10 (state.ts:336, :644). **H3**: settlement evidence is mutable after validation — only the transaction object is frozen, not its `entries` array or entries, and the internal transaction is exposed, so a genuine 5 pUSD booking was mutated to −999/+999 and realized 999 (evidence.ts:220, :229). **H4**: round 1's L2 fix guarded only containers — balance, virtual-position, `OpenLot`, and trade-effect objects are inserted unfrozen, so ORDINARY property assignment (no capability bypass) changed a returned balance 5→999, after which incremental read 1001 against a rebuild of 7, and a lot's cost basis 4→999 made a snapshot report `capitalCommitted=999`. Plus a LOW ("Ten" vs eleven mutation checks). The reviewer ACCEPTED the documented `Map.prototype.set.call` capability-bypass limit but not H4's ordinary mutation. Remediation round 2 dispatched for all five.) Round-1 record (remediation r1 verified 2026-09-03: tip `344ad9f`, rem commit `5bfd7f7`, ff-merged; scope exactly 30 files, lockfile byte-identical, **ZERO files under docs/adr/** or docs/contracts/** and the USDC/pUSD vocabulary byte-identical — H3 correctly left to GOV-1D**; gates reproduced: root 151/3890 = base 145/3797 (+6 files/+93 tests), check:deps unchanged 34/30, typecheck, lint, frozen install. **H1**: parity re-keyed by `(accountRef, assetId)` and the halt classification now asks for PRESENCE of an `ACTUAL_ACCOUNT` leg in the entry's own bucket rather than a net, behind TWO barriers because two write paths reach a fold — `append` refuses the shape, and the classifier catches it in history the WP-040 tables permit (SQL enforces per-asset zero-sum, not the partition). **The same key sweep found a further real defect the review had not seen**: `a|b|c` composite keys were ambiguous, so `("a","b|c")` and `("a|b","c")` merged two accounts' balance lines, and a merged leg signature let a transaction moving 7 pass as the exact reversal of one moving 5 — composite keys are now JSON and the serialization domains moved to `v2`. **H2**: `PnlStreamIdentity` carries the six required fields, `emptyPnlState` refuses to open without them, and a new test pins ledger transaction, ledger entry, and PnL snapshot against `db/migrations/0006_accounting.up.sql` by parsing the DDL at runtime AND against storage-postgres table types at compile time. **M**: a settlement-evidence bridge verifies a payout against the booked transaction across six checks, so a minted UUID cannot realize a reward. L1/L2 done; `Map`/`Set` mutators now throw (disclosed as loud-failure, not confinement). Central disclosed deviation referred to round 2: the round-1 review's two asks are **jointly unsatisfiable** — once parity is per-account, the exact counterexample is REFUSED at append (account A's −5 has no attribution leg), so it cannot also be 'accepted'; the remediation pinned all three statements on the surfaces where each is meaningful (refused by append naming both accounts; classified ACTUAL_ARRIVAL/haltRequired when folded as external history; the nearest legal cross-account arrival accepted and classified). Eleven mutation transcripts; eight existing test files changed, each disclosed. Review round 2 dispatched on `344ad9f`.) Round-1 record (review on `79ebc7c`: CHANGES REQUIRED — 3 HIGH, 1 MEDIUM, 2 LOW. **H1**: `haltRequired` nets actual movement by `assetId` across ALL accounts (balance.ts:87, projections.ts:143-203), so the reviewer's one-transaction counterexample — `ACTUAL_ACCOUNT A −5`, `ACTUAL_ACCOUNT B +5`, `VIRTUAL_STRATEGY B −5`, `UNATTRIBUTED B +5` — balances per asset and per parity while account B took a real unattributed +5 arrival, classified `REATTRIBUTION` with `haltRequired: false`; conceals an arrival with no halt, violating §9.15/ADR-006. The implementer's `ACTUAL_ARRIVAL`-vs-`REATTRIBUTION` narrowing was REJECTED as faithful only to same-account moves. **H2**: PnL output cannot bind to WP-040's `accounting.pnl_snapshots` (records.ts:39-43, snapshot.ts:66-87) — the table needs `scope`, `environment`, non-null `account_ref`, `instance_id`, `run_id`, `market_id`; `PnlOwner` carries only `instanceId` and `PnlSnapshot` lacks the rest, so the claimed field-for-field mirroring is false (ledger-side mirroring IS faithful). **H3 (governance, not code)**: ADR-006 §7 item 4 requires C-2 resolved against then-current docs before implementation — the implementer correctly refused and escalated; see GOV-1D below. **M1**: a "settlement-grade" reward payout is only a caller-supplied UUID (records.ts:143-155, state.ts:573-582) — no linked ledger event, type, observed payout, or confirmation is verified, so a minted UUID can realize a reward. **L1** handoff evidence index names the wrong test file; **L2** `Object.freeze` does not freeze `Map`/`Set` internals (state.ts:225-226, projections.ts:118-125). PASS: acceptance 1 (per-asset balance, incl. 300-property perturbation coverage; appended transactions deeply frozen), acceptance 2 (shared-fold rebuild agreement), acceptance 3 narrow invariant (estimate path correctly isolated), safety/purity/no-storage-imports. Acceptance 4 FAIL pending H1. Reviewer confirmed the implementer's F13→F16 citation correction was itself correct. Remediation round 1 dispatched for H1/H2/M1/L1/L2 with H3 explicitly excluded from its grant.) | WP-020 ✓ WP-040 ✓ |
| `GOV-1D` (C-2 resolution: USDC vs pUSD denomination) | Complete (merged `61a7ba5` --no-ff, 2026-09-04; confirming round 2 on `3120fd2` **ACCEPT with zero findings at any severity** — the MEDIUM verified closed at all three fix-2 sites plus the two round-1 sites, the reviewer's own synonym sweep over all five files found no remaining operative ratification, scope exact, pre-amendment ADR body byte-preserved, venue re-fetch remains UNVERIFIED-by-reviewer as required with the orchestrator's same-date fetches standing as evidence. Post-merge gates on main: root suite EXACTLY 173/4188 unchanged — the load-bearing gate for a doc-only round — check:deps 34 packages / 33 edges, typecheck, lint, frozen install, ops:verify-venue exit 0. **Carried item:** WP-200's C-2 conformance ratification is DEFERRED to a later governance action against its merged state `7e75f9a` — natural home: the pending cross-package schema-boundary governance round, which already owes a WP-200 audit. Worktree and branch cleaned up.). Confirming round 1 (Codex `task-mtm8kr95`, 2026-09-04, on `04dc5e7`): CHANGES REQUIRED — the MEDIUM was NOT fully closed: fix 1 qualified the consequences block and the protected-contracts C-2 row, but an earlier ADR-006 amendment paragraph (old lines 196-199) still said "shipped in conformance … ratifies"; the LOW ruled CLOSED; the edit-in-place question ruled LEGITIMATE (blame-verified that every rewritten line originated in unmerged `4b63060`; frozen content untouched); new LOW: the C-2 register row carries no separate dated italic note (the row rewrite is itself the correction). Orchestrator fix 2 `3120fd2` (disclosed, 2 files +23/−7): that ADR paragraph plus TWO further sites an orchestrator sweep found in `docs/handoffs/GOV-1D.md` (the summary line and the ruling recap) now carry the same reports-not-proof / ratification-deferred qualification with dated notes; `known_risks` 7 and `follow_up` 4 left as authored (candid risk disclosures, not ratification claims). (review round 1 on `6484eee`: CHANGES REQUIRED — 1 MEDIUM, 1 LOW, both wording. MEDIUM: the amendment ratified WP-200's shipped behavior as conforming on the strength of an in-flight sibling branch's handoff alone, while WP-200 was still remediating HIGH findings — required remediation was to qualify it as *reported* conformance and defer ratification to WP-200's final review/merged state. LOW: "a documentation inconsistency, not an economic one" asserts more than the evidence establishes — required phrasing is the copy-artifact *reading*. Both applied as a disclosed pre-merge orchestrator fix `04dc5e7` (2 files, +19/−6, dated notes naming the review as finder; root suite still exactly 130/3536). The reviewer ACCEPTED the substance: ruling 5 (no default unit for liquidity rewards; observed-asset-or-`UNATTRIBUTED`+halt) ACCEPT; the bounded-exception stretch ACCEPT as a disclosed one-off not to be generalized; known-risk-1 independence judged TRUE operationally; ADR-006 confirmed append-only 197/0 with frozen reports unchanged; safety PASS. Its re-fetch was UNVERIFIED-by-reviewer (sandbox DNS failure, status 000) — the orchestrator's own same-date fetches of all four URLs stand as the evidence. **A confirming round is owed before merge and cannot run until a reviewer is available.**). Ruling: **C-2 RESOLVED as a documentation inconsistency that does NOT authorize folding the denominations** — distinct asset identifiers stay mandatory (§7 item 2 unchanged), any conversion is an explicit recorded ledger transaction, each entry is denominated in the unit its source asserts (§7 item 3 unchanged); the WP-200 handoff reports conforming shipped behavior — ratification deferred to WP-200's final code review/merged state (corrected per the confirming rounds; WP-200 has since merged at `7e75f9a`, and closing the deferral belongs to a later governance action, not this round); no code changed. Orchestrator verification: exactly 5 doc files; **ADR-006 diff is 197 insertions / 0 deletions — original decision text provably unedited**; frozen venue reports untouched; gates at tip: root 130/3536 EXACTLY unchanged (the load-bearing gate for a doc-only round), check:deps PASS 34/26, typecheck, lint, empty lockfile diff, ops:verify-venue exit 0. **The implementer corrected the orchestrator's own evidence twice, both confirmed by re-derivation**: (1) the orchestrator's token counts were matching-LINE counts — true occurrences are USDC 12/0/0/0 and pUSD 0/9/7/0 across fees/maker/taker/liquidity-rewards; (2) materially, the orchestrator's proposed reading ("rebates from `programs/*-rebates.md` record in pUSD") is WRONG for liquidity-rewards, which contains ZERO `usd` occurrences in any case and names no settlement token, saying only "The minimum reward payout is **$1**" — writing pUSD there would have been an invented venue fact. The round therefore added **ruling 5**: no default unit for liquidity rewards; only an observed payout's own asset may denominate it, else `UNATTRIBUTED` + halt; plus a §4 correction-of-fact note that ADR-006's existing Evidence phrase "each in pUSD" is unsupported for that program. Disclosed stretch for the reviewer to judge (deviation 1): the README bounded venue-fetch exception says "a work package's **own** mandated verification", but the contract owner performed it in WP-200's place because WP-200 could not — the alternatives were leaving item 4 permanently undischargeable or discharging by assumption. | — | Narrow contract-owner round. Orchestrator re-verification 2026-09-03 (four live read-only fetches, all HTTP 200, sha256 recorded): the C-2 inconsistency PERSISTS in current official docs and its shape is now characterised — `trading/fees.md` and `programs/maker-rebates.md` carry VERBATIM-PARALLEL sentences differing only in the token name ("The fee amount in USDC/pUSD is symmetric around 50% probability — a trade at 30¢ incurs the same dollar fee as a trade at 70¢"), the same 0.00001 rounding floor, and the same formula `fee = C × feeRate × p × (1 - p)`; token counts USDC 11/0/0/0 vs pUSD 0/7/7/0 across fees/maker/taker/liquidity-rewards. This characterises a documentation-copy artifact but asserts NO on-chain equivalence, conversion, or linking address — so it does NOT authorize folding the denominations, and ADR-006 §7 item 2 stands. Expected ruling: C-2 resolved as a documentation inconsistency; distinct asset identifiers remain mandatory; each fee/reward entry is denominated in the unit its source asserts. The implementer must re-fetch independently and rule as its own evidence requires. | Append-only ledger, allocations, positions, PnL (handoff §9.15–9.16). Orchestrator verification: 36 files confined to allowed paths; lockfile +38/−0, importer blocks only, zero new `resolution:` entries (zod/fast-check/vitest/@types/node at versions already resolved elsewhere); reproduced at tip: root 145/3797 (+15 files/+261 tests exactly), check:deps PASS 34/30 (+4 downward), typecheck, lint, `pnpm install --frozen-lockfile` PASS. Same worktree-mismatch disclosure; the implementer recorded provenance file-by-file and asked that the carried predecessor files be treated as unreviewed-by-their-author — the review packet directs closest reading there. Two items needing orchestrator/contract-owner action after review: (1) **deviation 3** — ADR-006 §7 item 4 assigns WP-200 the USDC-vs-pUSD obligation (register item C-2), which it correctly refused to discharge (needs live venue docs + `docs/adr/**` edits, both outside its grant) — C-2 stays OPEN for a future GOV round; (2) **follow-up 2** — WP-040 obligations F12/F17/F18/F19 were listed against WP-200 but concern OMS/inventory/reconciler write paths that do not exist yet; they need re-assignment, not assumed closure. Disclosed assumption flagged by the implementer for scrutiny: `haltRequired` distinguishes `ACTUAL_ARRIVAL` from `REATTRIBUTION` (a bucket-to-bucket move changes no actual holding and is the remediation), reading §9.15 more narrowly than "every UNATTRIBUTED entry halts". |
| (superseded row) `WP-150` review trail | REVIEW ROUND 3 (round 2 on `e12fb43`: CHANGES REQUIRED — the single round-1 MEDIUM M1 survived in ONE more active surface, the handoff's implementation-summary bullet 5, while all corrected surfaces, both new tests, acceptance 1–3, deviations 1–3, and safety were verified PASS. Orchestrator applied the residual as a disclosed pre-merge doc-only fix `9e2e40f` (+14/−4, one file, dated disclosure note naming round 2 as finder; fresh residue sweep clean — remaining hits are the true WS-always-stamped claim per connection.ts:827 and the explicitly-superseded historical quotations). Review round 3 dispatched on `9e2e40f` to confirm closure.) Round-2 record (remediation r1 verified: tip `e12fb43`, rem commit `da5be84`, ff-merged into the canonical branch; scope exactly 5 files, lockfile + polymarket-public byte-identical, only non-comment src changes are the two never-parsed refusal detail strings; gates reproduced: root 130/3536 (+1 = the new-epoch/lower-generation lattice pin), focused 8/85, check:deps 34/26, typecheck; strict review round 2 dispatched on `e12fb43`). Round-1 record: CHANGES REQUIRED — one MEDIUM M1, zero BLOCKER/HIGH/LOW; acceptance 1 and 3 PASS, acceptance 2 PASS-as-library-behavior pending M1's framing fix. M1: the handoff/comments state WP-070's generation semantics as a biconditional ("advances exactly when a gap opens"; all legitimate snapshots stamped) but the shipped producer also advances on first connection and changes-while-disconnected (subscriptions.ts), and the generic REST fetcher permits omitted generation which the normalizer then omits — generation-less snapshots are a present capability, not hypothetical; library behavior is safe, framing wrong at the WP-120 boundary. Remediation dispatched: one-way-invariant corrections (handoff, book.ts comment, refusals.ts text), unstamped-snapshot integration-facing test, the new-epoch/lower-generation lattice pin, mutation-checked. Reviewer-sandbox UNVERIFIED items reproduced by orchestrator in /dev/shm: A1a → 2 failed/82 named (matches transcript), A2 → 1 failed/83 named (matches), golden oracle binds (surviving-value input mutation → byte-for-byte failure naming lines; the 0.08 level is transient — removed pre-serialization — so mutations there cannot affect final bytes, correct behavior). Process note: the first round-1 review launch ran from the main-repo cwd (would have reviewed a tree without WP-150) and was killed within seconds, non-authoritative, before relaunch from the candidate worktree. Prior orchestrator verification record: Orchestrator verification: 24 files confined to allowed paths; lockfile +13 additive lines inside the pre-existing order-book importer block only (workspace links decimal/domain + devDeps at already-locked versions, package.json matches the universe convention); reproduced at tip: root 130/3535 (+8 files/+84 tests exactly), check:deps PASS 34 packages / 26 edges (+2 downward: order-book→decimal, order-book→domain), typecheck, lint, install frozen. Fixture provenance verified documentary (frozen WP-000 catalogue + ADR-013 §2 template; no live fetches, no invented venue behavior). Implementer deviations 1–5 disclosed, notably (D2) the golden test imports the package via relative path through its exports entry because the root package.json devDep is outside its grant — orchestrator decision deferred to merge-time wiring. | All ✓ | Local exact-decimal order books (handoff §9.4; ADR-013 replace-not-accumulate + zero-deletes; no invented venue sequence numbers; layer-1 pre-assigned in dependency-direction §2). Bounded lockfile grant: new workspace package entries only. Expected gate drift: check:deps 35 packages / +N declared edges; root suite grows by the package's tests. |
| `WP-260`               | Dependency-ready; DEFERRED to Wave 3 by wave ordering and signer-boundary safety | All ✓ | — |
| All other packages     | Blocked  | See work plan      | —          |

Authorization vocabulary: "Ready (authorized)" rows are the only packages agents
may begin in the current run; "Dependency-ready" rows must not start until this
table says otherwise.

### WP-170 completion record (2026-09-03)

- **Merged** `9d0971b` (candidate `ef2368e`; chain impl `5fcfbca` → r1 `b2f1787` →
  r1-rem `f639bd0` → r2-rem `15e032f` → r3-rem `bed2f1c` → r4-rem `4047982` →
  r5-rem `cb51f00` → r6-rem `3eb179e` → r7-rem `18cd97d` → disclosed orchestrator doc
  fix `ef2368e`; base `68735d1`). Branches and worktrees removed.
- **Eight review rounds.** Rounds 1-4 each found a REAL runtime defect, all closed and
  re-verified at merge: (1) a retained `StrategyContext` could advance the RNG after its
  callback returned, so a checkpoint-restored tail diverged from the live one; (2) an
  exotic state-patch value passed validation then threw AFTER `DecisionSink.persist`,
  leaving a persisted decision with no checkpoint and reusing evaluation sequence 0;
  (3) evaluation input views were frozen but not materialized, so a getter handed one
  market to the callback and a different one to the persisted record; (4) a checkpoint at
  `MAX_SAFE_INTEGER` reopened duplicate sequences, and `params` leaked caller-owned mutable
  state so two runtimes with identical identity, input and seed produced DIFFERENT
  decisions. Rounds 5-8 found only mechanism gaps and changed ZERO package source files.
- **The fixes are structural**: one inert snapshot per boundary, materialized before use and
  reused by every consumer; the whole fallible region moved ahead of the persist call; every
  "never throws" API made genuinely total; an invocation-scoped context revoked in a
  `finally` with the guard PRECEDING each RNG draw; and a params grammar refusing internally
  mutable values rather than freezing them shallowly.
- **The regression net is derived, not written**: a `ts.Program` asks the compiler for every
  exported callable (module export, class member, object property, RETURN position), with
  anything unclassifiable failing the suite BY NAME. It found the package's own `evaluate()`
  entry point absent from coverage (registry 26 → 44) and a `Readonly<T>` alias hole that
  would have dropped five of the ten context capabilities the day one gained a method.
- **Residuals (LOW)**: the depth-memo's refusal-WORDING precision is observable but
  unfixtured; and one refusal branch documented as unreachable is reachable from a compiling
  fixture (`interface Callable { (value: unknown): string }`) though the mechanism FAILED
  CLOSED and hid nothing — taxonomy corrected pre-merge by disclosed edit `ef2368e`.
- **Carried follow-ups** (owners): fixture those two branches (next toucher of the
  derivation); prove each battery adapter calls the callable it names; enumerate callables
  handed out as ARGUMENTS (frontier confirmed correctly drawn but open); the refined
  read-discipline rule distinguishing caller data from stateful ports, total predicates and
  explicitly partial APIs; WP-230 must supply fresh-or-copied views, pass plain checkpoint
  documents, not swallow `StrategyContextRevokedError`, and surface
  `PARAMS_NOT_MATERIALIZABLE` / `EVALUATION_SEQ_EXHAUSTED`; WP-220 authors must know the
  context is invocation-scoped, state deeper than 64 containers is refused, and derived
  structures belong on the strategy object; consider promoting the derivation to shared
  test infrastructure.
- **Cross-package**: the schema-parse-output risk under Open blockers applies to this
  package's parsing surfaces and is NOT discharged by this merge.

### WP-200 completion record (2026-09-03)

- **Merged** `7e75f9a` (candidate `372bc0f`; chain impl `e685aaa` → r1 `79ebc7c` →
  r1-rem `344ad9f` → r2-rem `881d5e1` → disclosed orchestrator doc fix `372bc0f`;
  base `68735d1`). Three review rounds; **r3 ACCEPT, zero BLOCKER/HIGH/MEDIUM**.
- **Rounds 1-2 found seven HIGH between them**, all closed: attribution parity netted by
  asset across ALL accounts (so a balanced transaction hid an unattributed arrival); PnL
  output that could not bind to its own persistence shape; a reward realizable on nothing
  but a caller-supplied UUID; an external-history barrier that missed cross-asset and
  bare-arrival shapes; one booked reward realizable REPEATEDLY; settlement evidence mutable
  AFTER validation (a genuine 5-unit booking became a 999-unit payout); and accounting
  values mutable through map values by ordinary assignment, leaving incremental state at
  1001 against a rebuild of 7.
- **Found by its own key sweep, unreported by any review**: ambiguous string-joined composite
  keys under which two accounts' balance lines merged and a transaction moving 7 passed as
  the exact reversal of one moving 5.
- **The halt barrier is now general by case analysis**, not shape enumeration: ADR-006 §2
  partition validation lives INSIDE `applyTransaction` and records an unwaivable halt rather
  than throwing, so a damaged history still yields a projection and a diagnosis.
- **Residual (LOW, carried)**: the deep-freeze memoisation set is added to BEFORE the freeze
  succeeds, so a throwing freeze leaves an object memoised but unfrozen; reviewer confirmed
  it does not reach monetary state today and the helper is not exported. Owner: the next
  bounded grant touching `packages/{ledger,pnl}/src/immutable.ts` (both duplicated modules
  need the fix plus a throw-then-retry regression).
- **Reviewer NOTE carried**: halt enforcement is an INTEGRATION obligation — nothing
  suppresses `haltRequired`, but a caller can ignore `unexplainedMovements` /
  `unattributedExposure`; the composition-root convention is owed by whoever builds it.
- **Cross-package**: the schema-parse-output risk under Open blockers applies here and is
  **NOT audited** — WP-200 is on `main` and parses caller-supplied records.

### WP-150 completion record (2026-09-02)

- **Merged** `70c7f1f` (candidate `9e2e40f`; chain impl `f87f035` → r1 candidate
  `5441caf` → r1 remediation `da5be84`/`e12fb43` → disclosed orchestrator doc
  fix `9e2e40f`; base `c918e9b`; branches and worktrees removed).
- **Reviews**: three fresh Codex rounds. R1 (session 01a062fe…): CHANGES
  REQUIRED — exactly one MEDIUM (M1: handoff/comments framed WP-070 generation
  semantics as a biconditional; the shipped producer's invariant is one-way
  and its generic REST fetcher can emit unstamped snapshots); everything else
  PASS including an independent hand-derivation of the golden replay. R1
  remediation (fresh agent, resumed once after a session-limit kill with its
  worktree intact): framing-only corrections + the renamed unstamped-snapshot
  obligation test + the new-epoch/lower-generation lattice pin (+1 test;
  detail strings are documented never-parsed, no test asserts them). R2
  (session 01a063d9…): verified all remediation claims and every corrected
  surface against producer sources, acceptance 1–3 PASS behaviorally, but
  found M1's wording surviving in one more active handoff bullet. The
  orchestrator corrected that bullet directly — disclosed pre-merge doc-only
  fix `9e2e40f` (+14/−4, one file, dated note naming r2 as finder; the
  GOV-1B disclosed-fix precedent, escalated here to a MEDIUM residual with a
  confirming round instead of merge-without-re-review). R3 (session
  01a063de…): ACCEPT — M1 closed against the producer sources, fresh residue
  sweep clean, boundary exactly one doc file, zero findings.
- **Orchestrator reproductions** (reviewer sandboxes were read-only): mutation
  A1a → 2 failed/82 naming the ADR-013 replace test + acceptance-1; A2 →
  1 failed/83 naming acceptance-2; golden-oracle bind (surviving-value input
  mutation → byte-for-byte failure naming lines; the 0.08 level is transient
  — zero-removed pre-serialization — so mutations there cannot affect final
  bytes, which is correct); root 130/3536 at e12fb43 and again post-merge.
- **Ships**: packages/order-book — OutcomeTokenBook + MarketOutcomeBooks
  (independent per-token books; ADR-013 replace-not-accumulate, "0" removes;
  canonical decimals only, "0.10" refused not normalized); freshness lattice
  on (gatewayEpoch, subscriptionGeneration) — stale → typed refusal with both
  generations, ahead-delta → awaiting-snapshot, cross-epoch delta → refusal,
  unstamped snapshot → refusal (the WP-120 composition-root stamping
  obligation is pinned by test name), new-epoch snapshot re-baselines under
  documented caller-ordering responsibility; executable-price VWAP (typed
  insufficient-depth, overridable division policy); pure order-independent
  REST comparison (robust to the recorded GET /book ordering contradiction;
  hashes reported never cross-surface-judged); tick-change invalidation
  carrying both tick sizes; replay-golden byte-for-byte fixture with fully
  documentary provenance and a regeneration ban. Lockfile +13 lines confined
  to the pre-existing order-book importer block.
- **Carried follow-ups** (owners): root devDependency + bare-specifier import
  for the golden test (orchestrator, at a future bounded root-wiring grant —
  the current relative import tests the public entry, not package-specifier
  resolution); WP-120 composition root MUST stamp gap-closing REST snapshots
  via the fetcher context (pinned by test name); WP-160 notes (division
  options; absent-vs-zero on empty sides); WP-210 reuses serializeBook
  (versioned polymarket-bot/order-book/v1) rather than inventing a second
  canonical form; WP-070 follow_up 6 (best_bid/best_ask carriage) open,
  unblocked; the renamed obligation test's long name is load-bearing
  documentation — future renames must preserve the recorded obligation.

### GOV-1C completion record (2026-09-02)

- **Merged** `3272c4b` (candidate `537fcb2`, impl `573a8a1`, base `4f20acf`,
  branch worktree-agent-af74389cafb5f2d46, removed after merge). First
  dispatch of the round was killed by an API session limit during its read
  phase with zero work product (worktree auto-cleaned); the candidate is
  entirely the second dispatch's work under the identical eight-item packet.
- **Review**: Codex strict round 1 ACCEPT (session
  01a062d3-72d2-7581-93f5-4bacf0bee043) — zero findings above NOTE; all
  eight items and both disclosed deviations explicitly ACCEPTED. The three
  UNVERIFIED-by-reviewer items were sandbox limits, each independently
  reproduced by the orchestrator: ops:verify-venue exit 0; the F14 mutation
  probe (probe file → `FAIL [F14]` with JSON `rule:"F-OPAQUE"` +
  `contractRule:"F14"`, restore → PASS, tree clean); and all six venue URLs
  re-fetched with EXACT matches to the report table (S1 44794B
  `92a02634…`, S3 16406B `6b8ffab6…`, S4 5690B `fd98e9be…`, S5 215862B
  `82529177…`, S6 33342B `e07d5191…`, S2 308→200 one redirect).
- **Ships**: ADR-016 §2 UUID refusal amendment + R-8 (closed); ADR-017
  dataset-manifest/retention-receipt contract; ADR-018 app-local esbuild
  runtime-build convention; ADR-019 soak policy (24h contiguous single
  window, no summing — the WP-140 evaluator constant is now policy-backed,
  unchanged); domain.md §10 rows ADR-013..016 (R-7 closed) + §11
  causationId contract (`raw:<gatewayEpoch>:<ingestSeq>`, reviewer-matched
  to `rawFrameCausationId()` in apps/data-gateway/src/envelope.ts);
  wal-format §12.1 epochs-are-identity ruling (single-epoch compaction
  ratified); docs/venue/verified-2026-09-02.md (bounded, six fetches);
  register rows U-10/U-11/U-12 added, U-6 closed with the dated ADR-009 §5
  discharge (second bounded venue-fact exception, four conditions walked);
  dependency-direction §6.1 all five items ruled (F15/F16 written,
  not yet checker-enforced); ADR-014 comment pointers in
  packages/domain/src/events/{book,reference}.ts (comment-only,
  hash-proved by implementer, orchestrator, and reviewer independently);
  F14 human-surface rename in the tool (machine `rule` field keeps
  `F-OPAQUE` as the documented accepted alias).
- **Carried follow-ups** (owners): bounded tooling package swapping the
  machine `rule` field to F14 together with the pinned suite assertions,
  and implementing F15/F16 (future bounded grant, tool + test/unit/tooling
  in one change); WP-220 brings tests inside the purity scan; the §6.1
  item-1 callee-resolution tripwire binds future reviewers; next full
  venue verification round adds the resolution page + market-by-id to the
  source index; first market-by-id consumer treats U-11 as opaque; WP-300
  keeps the U-10 CANCELLED refusal; apps/trader builds per ADR-018;
  WP-210/WP-230 parse causationId per domain.md §11 only.

### Wave 1 closeout record (2026-09-02)

Per the runbook's Wave 1 closeout checklist, verified by the orchestrator
against merged, reviewed evidence (no item claimed beyond its evidence):

- **Gateway records all configured sources** — WP-120's four assembled
  adapters + WAL + transport, acceptance suites 17/17 and obligation
  suites 28/28 at merge (round-7 ACCEPT).
- **Raw WAL recovery works** — WP-050 fault-injection suite 89/89 green
  through every subsequent merge; WP-120 journal integration.
- **Parquet manifests and checksums reproduce datasets** — WP-130's
  validator (131 pytest incl. cross-runtime frame-line parity and the
  committed fixture end-to-end) and retention proof chain (round-6 ACCEPT).
- **Book reconstruction is checked against snapshots** — WP-140's
  comparison job (ADR-013 absolute-size semantics; automated fixture
  posture 6/6; real-WAL posture via `SOAK_WAL_DIR` documented in the
  runbook).
- **Gaps and staleness are visible** — stall/gap/RTDS-quality incidents
  (WP-120), machine-checked dashboard + 20 alert rules (WP-140
  acceptance 1).
- **Recorder runs independently of trading deployments** — standalone
  gateway process + compose fragment + runbook; recording survives
  transport outages at startup and mid-run.
- **External soak evidence: explicitly PENDING** — machine-readably
  (`recorder_soak_status_info{status="PENDING"}`); the evaluator's
  ceiling is a candidate state; closure is a documented governance act
  (runbook §7). Never claimed otherwise.
- **No trading path exists yet** — `apps/trader` untouched stubs;
  `dev:paper`/`test:replay` NOT IMPLEMENTED; no order surface anywhere
  (re-verified by every package's safety sweep); PAPER defaults intact.

Wave 1 development is COMPLETE. Deploying the recorder to accumulate real
soak evidence is an operator action per runbook §1F/§7; Wave 2 may proceed
meanwhile.

**C-4 phase-2 start-gate venue re-check EXECUTED 2026-09-02** by the
orchestrator (the owner per the Wave-0 closeout record): both pages
re-fetched live. Result consistent with both prior checks — the
review-claimed archived-SDK references are STILL NOT reproduced.
`/trading/quickstart` demonstrates only the unified client, now observed
in both languages (TS `@polymarket/client` with `createSecureClient` and
`@polymarket/client/viem`; Python `polymarket` with `AsyncSecureClient` —
the Python package is a new observation, relevant to WP-260's pin-with-a-
fresh-check obligation); `/trading/overview` names no SDK.
Protected-contracts §C-4 row updated; next re-check at the phase-3 start
gate. The phase-2 gate is OPEN.

### WP-140 completion record (2026-09-02)

- Implemented by `wp-implementer` on branch `worktree-agent-ac72fe93bf1988ee1`,
  base `77521f3`; 4 review rounds / 3 remediation rounds; ZERO new
  dependencies (lockfile untouched; graph unchanged 34/24). 30 files.
- The run's FIRST BLOCKER was found here, exactly where the review was
  aimed: a hand-written 25h evidence file reached SATISFIED. The fix
  restructured the trust model — evidence records carry no status;
  the fail-closed evaluator's ceiling is `QUALIFYING_WINDOW_FOUND`
  (exact-key rejection; nine consistency relations over primitives;
  poison semantics); gate closure is a HUMAN governance act (runbook
  §7); `SATISFIED` erased from every surface. Later rounds hardened the
  test integrity itself (exact alert-set equality; a fail-closed
  thirteen-shape YAML subset validator closing an inline-comment bypass;
  the wording denylist extended to all six operator surfaces with
  phrase-level negation handling) and the honesty of every alarm claim
  (best-effort advisory; the in-process halt + PAGE is the only enforced
  guarantee — including a dated correction to the merged WP-120
  handoff's own wording).
- Merged `735d330` (`--no-ff`); root wiring `5757ef3` (soak-tree
  typecheck in the root gate so the structural-mirror drift pin runs in
  every root/CI typecheck, closing known risk 3; `test:soak-smoke` root
  script + a bounded loopback-only CI step). Post-merge gates: root
  3451/3451 (122 files); contract chain unchanged; check:deps 34/24;
  main-tree lint clean; smoke 3/3. Worktree and branch cleaned up.
- Residual (LOW, disclosed): the guarantee-wording denylist is a
  four-pattern heuristic narrowed by positive pins — novel promissory
  phrasing needs human review at doc-change time.
- **Follow-ups carried**: wire the exporter into the processes (apps
  owner — loopback listeners rendering `renderRecorderMetrics`); trim
  the compose README's duplicated restart procedure; observability
  manifest wiring (barrel re-export, vitest devDep hygiene); the REAL
  soak after deployment (then size admission bounds, profile compactor
  memory, benchmark §9.1 p99 from its evidence); the 24h threshold and
  window-composition rule remain orchestrator-ratifiable if a different
  bar is intended; `data.raw_segments` → WP-210 (operator decision
  2026-09-02).

### WP-120 completion record (2026-09-01)

- Implemented by `wp-implementer` on branch `worktree-agent-a71e4e080fb6d6838`,
  base `85bf8d4`; 7 adversarial review rounds / 6 fresh-session remediation
  rounds. The Wave 1 integration point: four public adapters + WAL + event-bus
  + universe assembled under "evidence recorded before it is interpreted;
  nothing dropped in silence." 62 files vs base; lockfile +34/−0.
- Core design: a single `IngestSequencer` assigns `(gatewayEpoch, ingestSeq)`
  for raw frames and normalized events from one counter, so `causationId`
  names the exact preceding WAL record; assign-and-submit in one synchronous
  step makes submission order be assignment order; WAL refusal suppresses
  derived market data and opens PAGE while feed-health keeps flowing;
  transport outage halts publication terminally for the epoch while
  recording continues.
- The review loop hardened the process lifecycle edge-by-edge, each defect
  found by direct probe, fixed probe-first, mutation-pinned: r1's five HIGH
  (WAL tick/drain race violating exact-one; the unbounded hidden publisher
  chain; non-outage rejections continuing past a lost event; RTDS gaps not
  halting; startup Redis outage killing recording) + Coinbase generation
  relabeling + cadence validation; r2's recording-only self-exit (gateway-
  owned referenced lifetime anchor); r3's fatal-start transport leak
  (transactional `runGatewaySequence`); r4's missing fallback exit
  (referenced hard-deadline on fatal AND signal paths via required host
  effects) and in-repo disposal abandonment (per-resource isolation +
  `GatewayDisposalError`); r5's unvalidated deadline values (fail-closed
  [100ms, 2^31−1] at both seams) and the uncovered `create()` cleanup
  (deadline capability); r6's sequential-disposal composition gap
  (two-family concurrent disposal on a documented ordering finding-of-fact —
  journal/transport disjoint, flush-before-sever the one real constraint —
  with settled-failure collection and moment-of-collection evidence).
- Review-infrastructure note: one round-4 attempt was aborted by Codex-side
  usage exhaustion; its single candidate finding was orchestrator-confirmed
  by code reading before remediation dispatch; the operator confirmed Codex
  restored and the loop resumed with the prescribed reviewer.
- Merged `0622f45` (`--no-ff`) after the disclosed pre-merge LOW comment fix
  `023819e`; root wiring `2a49153` (data-gateway suite in `test:integration`;
  `dev:gateway` → the app's typecheck-build-run start). Post-merge gates on
  main: frozen install PASS; typecheck PASS; main-tree lint clean;
  `check:deps` 34 packages / 24 edges (7 gateway edges, all downward); root
  3329/3329 (117 files); gateway integration 58/58; contract chain 583 + 65
  + 158 + 94. Worktree and branch cleaned up.
- **Escalated to the operator — RESOLVED 2026-09-02**: `data.raw_segments`
  (§10.2) ownership — WP-120 declined it (a PostgreSQL dependency in the
  recorder's path violates §4.2); WP-040 and WP-130 merged without it. The
  operator chose deferral: **WP-210 inherits it** (the first consumer that
  queries recorded segments — its event source owns the migration plus a
  manifest-reading importer/backfill job; the table is backfillable from
  manifests at any time, so nothing is lost by waiting). At WP-210
  authorization the orchestrator ratifies a bounded storage-postgres
  migration-path grant covering both this table and the still-open WP-110
  `payoff_model NOT NULL` divergence. Recorded in the workplan's WP-210
  entry.
- **Follow-ups carried**: WP-140 recorder runbook (bidirectional exit
  contract; deadline and `[disposal]` operator signals; liveness alarming;
  queue metrics charting; admission-bound sizing from soak data);
  `GATEWAY_RETENTION_EVENTS` fail-closed parsing; adapter-level
  `socket.close()` guards (packages/polymarket-public, packages/
  coinbase-adapter — outside WP-120 paths); `runGatewaySequence` reuse for
  any future composition root; the `causationId` format's contract
  registration; `docker compose config` validation of the compose fragment
  (Docker unavailable in this environment — never claimed run).

### WP-130 completion record (2026-08-31)

- Implemented by `wp-implementer` (Opus) on branch
  `worktree-agent-a422f1462076a65fe`, base `9a5b551`; 6 review rounds /
  5 remediation rounds (r1: 2 HIGH on the deletion path + 4 MEDIUM; r6:
  ACCEPT with one LOW closed pre-merge). Four artifacts:
  `packages/storage-parquet`, `apps/research-worker`,
  `python/research/compaction`, `test/integration/parquet`. Graph
  11→13 edges at base (both downward 3→2), 17 on main post-merge.
- Landmark fixes across the loop: manifest + digest sidecar persisted
  and READ-BACK-VERIFIED before any WAL deletion, retention completion
  moved to an immutable receipt, and `verifyRetentionProof` requiring
  store-fetched proof pinning segment checksum/count/object key+checksum
  plus a whole-file `segmentFileSha256` (fails closed on absent pins);
  mixed-epoch refusal instead of invented chronology; cross-runtime
  frame-line byte parity (Python mirrors `encodeFrameLine` exactly,
  digests recomputed before trust — a duplicated `walRetentionPolicy`
  key silently flipping the effective policy was caught and refused at
  parse); nullability pins reconciled against actual Parquet metadata
  (with the discovery that DuckDB's own writer emits every column
  OPTIONAL); every manifest/receipt loading failure classified with no
  exit-3 leakage from manifest-controlled input; honest degraded-state
  suppression for unavailable objects.
- Review-infrastructure note: THREE review attempts were aborted by a
  reviewer-side content-filter false positive, all while processing bulk
  reads of the validator source; the accepted terminal round ran under a
  mandatory narrow-read constraint (≤30-line grep windows, behavioral
  verification preferred). Two findings surfaced by an aborted attempt
  were dispatched only after independent orchestrator confirmation via
  the real CLI, and re-verified fixed the same way.
- Merged `cfa353b` (`--no-ff`) after the disclosed pre-merge LOW
  addendum `1bcc0f4`; root wiring `24903d2` (research-worker filter in
  `test:integration`; `ops:validate-dataset` → the DuckDB validation
  job). Post-merge gates on main: frozen installs (pnpm + uv) PASS;
  typecheck PASS; main-tree lint clean; `check:deps` 34/17; root
  3235/3235 (104 files); integration 27/27; pytest 131/131; contract
  chain 583 + 65 + 158 + 94. Worktree and branch cleaned up.
- **Follow-ups carried**: WAL contract owner must define cross-epoch
  chronology or rule mixed-epoch directories out (compactor refuses
  until then); a dataset-manifest ADR pinning the two digest roles,
  `nullable` = repetition semantics, and the strict-JSON profile
  (UTF-8-only, RFC 8259 literals, unique keys); WP-140 memory/deletion
  profiling; replace the operator incident file with the
  `data_quality_incidents` query; persist `CompactionResult.manifest`
  to `data.*`; repo-wide runtime-build convention (esbuild precedent);
  periodic dependency review + ADR before any upgrade that changes
  archived bytes.

### WP-110 completion record (2026-08-31)

- Implemented by `wp-implementer` (Opus) on branch
  `worktree-agent-ad46f96b4e8f24e93`, base `7b76943`; the longest loop of
  the run: 8 adversarial review rounds and 7 fresh-session remediation
  rounds, findings strictly narrowing every round (r1: 3 HIGH + 3 MEDIUM;
  r8: ACCEPT with LOW/NOTE residuals only). Full-chain scope:
  packages/universe/**, packages/settlement/**,
  db/seeds/settlement-specs/**, docs/handoffs/WP-110.md, pnpm-lock.yaml
  (+38/−0, two importer entries). 51 files vs base.
- Landmark fixes across the loop: exact-ms TWAP window validation in both
  evaluators (reviewer-ruled the correct conservative default);
  discriminated permitted-verdict view with full cross-series identity
  correlation failing closed, refusals typed `readonly []`, and a
  source-text pin on Settlement's activation vocabulary (compile-time pin
  impossible without the forbidden same-layer edge — disclosed);
  deep-frozen registries defeating nested-approval forgery; unconditional
  `asOf` validation; scheduled-close-elapsed decoupled from
  venue-confirmed CLOSED so observation continues to resolution; and the
  eight-round placeholder-matcher hardening (whole-field token-multiset +
  bounded morphology tables + stopword-only refusal with exhaustive-DP
  partitioning + post-fold confusable refusal + digit wildcards +
  generated encoding matrices), with every residual disclosed AND pinned
  as a visible passing test so disclosures cannot drift.
- U-6 CONFIRMED on the current official resolution page (50/50 $0.50
  redemption; post-open clarifications published onchain); CANCELLED
  payout refused as `SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED` (no
  documented mechanic); no dispute event invented.
- Round 8 final judgments: all four acceptance criteria PASS; the
  guarantee-vs-residual boundary ruled accurate, complete, and honestly
  positioned; residual false negatives LOW and directional false refusals
  NOTE for a PAPER-only system behind the human `verified_by` gate.
- Merged `ea81f5f` (`--no-ff`); no root wiring needed (colocated tests
  ride the root config). Post-merge gates on main: frozen install PASS;
  typecheck PASS; main-tree lint clean; `check:deps` 34 packages /
  15 edges; root suite 3116/3116 (97 files); contract chain 583 + 65 +
  158 + 94. Worktree and branch cleaned up.
- **Follow-ups carried**: composition root (WP-120/WP-160/WP-170) must
  narrow `SettlementActivationVerdict` into the discriminated view (the
  wiring site is where assignability becomes a type error);
  `catalog.settlement_specs.payoff_model NOT NULL` divergence owned by
  the migration owner; venue-register rows for WP-110's non-confirmations;
  a `MarketClosed`-equivalent venue signal remains unconfirmed; seed
  loader and a human-reviewed spec for `btc-15m-updown` before any
  model-dependent use; matcher fixture U+200B escapes must not be
  reformatted to literals.

### WP-100 completion record (2026-08-30)

- Implemented by `wp-implementer` (Opus) on branch
  `worktree-agent-ae974c3cda2ffa0dd`, base `75c6521`; chain `d51dcd5` (impl) →
  `3624593` (remediation round 1) → `2e5be65` (handoff SHA record). 30 files,
  all within authorized paths; lockfile untouched (sha256 identical at base and
  candidate). Polymarket RTDS Chainlink TWAP observation feed: E18 exact
  fixed-point `full_accuracy_value` path (display value never read),
  never-resynchronizing subscription model with generation acknowledgements,
  per-series gap obligations, typed refusals with raw-envelope preservation.
- Review round 1 (Codex `01a0498b-9f3c-7440-9030-f4161343c99e`): CHANGES
  REQUIRED — M1 observation-timestamp heuristic, M2 gap-obligation modeling,
  L1 handoff counts (full detail in git history of this file at `a9545b2`).
  Remediation round 1 (fresh repair session, probes reproduced first,
  per-finding mutation checks; mutation M2-b exposed a real test hole, fixed).
- Review round 2 (fresh Codex `01a049b2-0370-7a01-9553-6b1a503d7979`):
  **ACCEPT** — zero BLOCKER/HIGH/MEDIUM/LOW. R1-M1/M2/L1 all FIXED with direct
  probes (strict ms-only observation parser vs tolerant publisher parser
  mutation-killed; stacked-break, eviction, restatement-attribution, and
  mutual-exclusivity probes on `assessGap`). Judgment calls ruled:
  all-digit-string acceptance ACCEPTED (matches SDK `^\d+$`, cannot trigger
  seconds rescaling); absence of a plausibility window ACCEPTED (no invented
  venue threshold; seconds-spelled input publishes a visibly-wrong 1970 window
  that must fail freshness downstream — honest disclosure). Residual NOTE:
  series eviction clears an outstanding gap obligation; reappearance reports
  `firstObservationEver` with neither interval field (documented).
- Merged `e3ac6a3` (`--no-ff`); root wiring `eaf18f4` adds the RTDS suite to
  root `test:contract` (flows into the existing CI venue-contract step).
  Post-merge gates on main: frozen install PASS; typecheck PASS (34 projects);
  main-tree lint clean (excluding in-flight worktrees); `check:deps` PASS;
  root suite 2385/2385 (79 files); contract chain 583/583 + RTDS 65/65 +
  Binance 131/131 + Coinbase 94/94. Worktrees `agent-ae974c3cda2ffa0dd` and
  `agent-ad1b84cc52570e1ec` removed; branches deleted after ancestry checks.
- **Binding obligations carried to WP-120**: handle both interval fields
  (`unobservedInterval` measured vs `unobservedIntervalUnavailable`),
  freshness/eviction signals (a reappearing evicted series is
  `firstObservationEver`), RTDS `openGap.recoverableFromVenue===false` → halt;
  acknowledgement is never an authoritative resync downstream.
- Registry note: the Codex companion job registry for the round-2 review was
  found wiped (empty state at 2026-08-28 15:13 local, cause unknown); the
  verdict was recovered from the persisted Codex session rollout
  `01a049b2-0370-7a01-9553-6b1a503d7979` under `~/.codex/sessions`, which
  contains the full review text and gate log. Treated as authoritative — same
  session id family, candidate SHA `2e5be65` named in the handoff line.

### Wave 1 batch 1B phase-gate record (2026-08-27)

- **C-4 phase-start venue re-check executed by the orchestrator** (owner per the
  Wave 0 closeout record) before batch 1B dispatch: both pages re-fetched
  2026-08-27. `https://docs.polymarket.com/trading/quickstart` ("Place Your
  First Order") demonstrates only the unified `@polymarket/client`
  (`createSecureClient`, `@polymarket/client/viem`; Python `polymarket`
  package); `https://docs.polymarket.com/trading/overview` names no SDK
  package. The review-claimed archived-SDK references remain NOT REPRODUCED.
  Register row C-4 annotated in `docs/contracts/protected-contracts.md`
  (dated orchestrator governance edit); next re-check at the phase-2 start
  gate.
- `pnpm ops:verify-venue` (offline validation of the frozen report): exit 0,
  all sections PASS.
- Batch 1B dispatch: WP-070/WP-080/WP-090 in parallel (three worktree-isolated
  implementers — within the AGENTS.md four-agent ceiling and the runbook's
  two-to-three adapter recommendation; paths disjoint; `pnpm-lock.yaml`
  mechanically shared, reconciled at merge per the recorded WP-040/WP-050
  lockfile-regeneration procedure). WP-100 remains sequenced strictly after
  WP-070 merges (path subset). WP-070 packet carries the accumulated
  obligations: reworded C-1/U-1 acceptance criterion, register R-2 (venue
  schemas not hand-transcription-load-bearing within its paths), ADR-002 §7
  `.nullish()`-to-absent adapter rule, and the §9 fixture-only-narrowings
  binding list.

### Wave 1 batch 1B in-flight records (2026-08-27)

**WP-090 (Coinbase adapter):**
- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-aab9b11346f9eb037`,
  base `145fc32`; chain `aa74419` (impl) → `44eb525` (handoff SHA record).
  58 files, all allowed; lockfile +16/−0. Orchestrator reproduced gates:
  root 1823/1823, contract 72/72 (offline), check:deps PASS. Public
  unauthenticated Advanced Trade WS; 15 venue facts cited (2026-08-27);
  C-CB-1 (per-product vs per-connection `sequence_num`) resolved per-connection
  on AsyncAPI authority; disclosed read-only 25s public-feed observation (no
  credential/order/fixture) settles the ADR-004 Coinbase-framing item: all
  frames UTF-8 JSON.
- Review round 1 (fresh Codex `01a044bd-10a2-7a22-8777-e20d8ac910dc`): **CHANGES
  REQUIRED** — 0 blocker, 2 high (H1 a malformed snapshot records channel
  satisfaction before validation, so an invalid trade snapshot plus a valid
  ticker snapshot falsely emits `FeedResynchronized`; H2 frames/callbacks from a
  closed connection are accepted and relabeled as current-generation data),
  2 medium (M1 a rejected trade reserves its dedupe identity so a corrected
  valid copy is suppressed; M2 silent paths — market-trades message timestamp
  unvalidated before use as venue time, heartbeat counter reuse/regression
  silently continued), 1 low (handoff "every frame yields output" overclaim).
  Venue judgments: V1/V2/V3/V5 ACCEPT (reviewer independently refetched the
  official pages; maker-side inversion required and correctly isolated);
  V4/V6 REJECT via H1/H2/M1. Deviations D1/D2/D3/D5 ACCEPT, D4 REJECT (M2).
  Remediation round 1 dispatched.
- Remediation round 1 completed 2026-08-27 in `d03391f` (+ doc `72587d1`),
  fresh repair session, probes reproduced first, per-finding mutation checks:
  H1 → channel satisfaction only via per-entry applied/refused verdicts (a
  knowingly suppressed duplicate counts as applied to avoid a reconnect
  livelock — pinned by its own test; refusals reported via new
  `COINBASE_SNAPSHOT_NOT_APPLIED`); H2 → `ingestFrame` takes a
  connection-origin parameter and refuses superseded connections with no
  state change, listeners bound to connection ordinal; M1 → deduplicator
  split into `isKnown`/`remember`, identity recorded only after the domain
  boundary; M2 → envelope timestamps validated on every classified arm
  (invalid → venue-time cleared, raw preserved), heartbeat tracker switch
  exhaustive with `COINBASE_HEARTBEAT_REGRESSED`; L1 → claim corrected in
  handoff and module header. Also surfaced: a literal U+0000 byte in the
  dedupe key separator replaced with a visible escape. Anomaly codes 16→19,
  contract tests 72→91, three new fixtures. Orchestrator fast-forwarded the
  canonical branch to `72587d1` and reproduced gates: root 1826/1826,
  contract 91/91, paths clean, lockfile untouched. New disclosed risk for
  review: a channel whose snapshot persistently fails to apply never
  resynchronizes — loud reconnect loop, not silent. Review round 2
  dispatched.
- Review round 2 (fresh Codex `01a0463c-8177-7601-b578-5d83e7009c28`): **CHANGES
  REQUIRED**, strictly narrower — 0 blocker, 1 high (H1 residue: a refused
  LATER snapshot does not revoke the channel's earlier satisfied mark —
  valid→refused→other-channel ordering still falsely emits
  FeedResynchronized), 2 medium (H2 residues: a retired socket's frame is
  accepted during the replacement's CONNECTING interval because the
  processor's connection id updates only on open; a synchronous `onOpen`
  loses subscriptions — `#socket` is assigned only after `connect()` returns,
  so `#sendSubscriptions` sees undefined — the exact timing invoked to
  justify ordinal binding), 2 low (handoff says five new counters, actual
  four; omitted-`from` origin parameter is a disclosed public-API risk — the
  bundled manager always supplies it). M1/M2/L1 confirmed FIXED;
  suppressed-counts-as-applied ACCEPTED (M1 prevents identity poisoning);
  U+0000 fix verified; post-open retired callbacks all correctly refused
  with observable counters; reconnect-loop risk accepted as loud fail-closed
  with WP-120 owning escalation. Remediation round 2 dispatched.
- Remediation round 2 completed 2026-08-27 in `e31b711` (+ doc `fa518e7`),
  probes reproduced byte-for-byte first, per-finding mutation checks:
  R2-H1 → `#noteSnapshot` deletes the channel's seen-mark when a snapshot is
  not fully applied (revocation reported in the anomaly; deliberately does
  NOT re-open an already-closed gap — a refused restatement establishes no
  loss); R2-M1 → manager gates `onFrame` on the captured ordinal AND the
  processor gained `staleConnectionFrame(raw, from)` (counts, classifies
  with raw preserved, zero state change); R2-M2 → per-attempt
  `withSocket(action)` holds socket-dependent actions until `connect()`
  returns; synchronous callbacks remain legal; the `onFrame`-triggered drop
  shared the hole and is covered; R2-L1 → five→four corrected; R2-L2 →
  optional `from` kept per the accepted API shape with the risk documented
  precisely. Orchestrator fast-forwarded the canonical branch to `fa518e7`
  and reproduced gates: root 1827/1827, contract 94/94, paths clean,
  lockfile untouched. Review round 3 dispatched.
- Review round 3 (fresh Codex `01a0465f-25ef-7451-8601-9744555a22c7`,
  candidate `fa518e7` vs base `145fc32`): **ACCEPT** — 0 findings above NOTE
  (sole NOTE: sandbox-blocked root-suite subprocess tests; covered by the
  orchestrator's exact-commit 51/1827 reproduction). All round-2 fixes
  verified under direct adversarial interleavings (post-closure refusal →
  reconnect → single-channel snapshot does NOT resync; connecting-window
  frames refused with zero mutation; synchronous-open subscription delivery
  proven on start, reconnect, stop-from-callback, overtaken-attempt, and
  already-closed paths); no-reopen rationale ACCEPTED; trusts-its-caller
  trade ACCEPTED as disclosed LOW; mutation claims spot-verified.
- Merged to `main` as `335b1b0` under the release manager's standing
  delegation (2026-08-27). Post-merge on `main`: root 1827/1827, fault
  89/89, integration 208/208 + 81/81, contract 94/94 via the NEW root
  `test:contract` script wired by the orchestrator in the completion commit
  (with a CI "Venue contract tests (offline fixtures)" step; to be extended
  as WP-070/WP-080 merge), audit clean, frozen install verified.
  WP-090 is the first batch-1B merge; WP-070/WP-080 remain on base
  `145fc32` and their lockfile unions will be reconciled at their merges.

**WP-080 (Binance adapter):**
- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-a24ead9170631b1c6`,
  base `145fc32`; chain `cff20ba` (impl) → `be5d67a` (handoff). 48 files, all
  allowed; lockfile +16/−0. Orchestrator reproduced gates: root 1902/1902,
  contract 108/108 (offline), check:deps PASS. 15 venue facts cited from the
  official `binance/binance-spot-api-docs` (2026-08-27); ADR-004 framing item
  answered (JSON endpoints carry JSON; the binary SBE path is a different,
  key-required host, refused by construction); UNVERIFIED register BNC-U1..U6.
  Review round 1 dispatched.
- Review round 1 (fresh Codex `01a0461f-aa31-7a93-98dd-1cd768972403`): **CHANGES
  REQUIRED** — 0 blocker, 1 high (H1 retired-socket callbacks carry no immutable
  connection identity on MESSAGE/ERROR/CLOSE, so a stale socket's trade is
  relabeled as the current connection/generation and a stale close tears down
  the active feed — same defect class as WP-090's H2), 2 medium (M1 the
  combined-wrapper `stream` label is trusted unvalidated: a wrapper/payload
  symbol-or-kind mismatch is normalized instead of classified; M2 only the
  latest trade id is remembered, so a delayed non-adjacent duplicate is
  published twice as a "late observation"), 2 low (L1 BNC-U4 register text
  contradicts actual partial-book behavior; L2 MAX_FRAME_BYTES enforced as
  UTF-16 chars, not bytes). Venue judgments: V1 PASS (reviewer re-fetched all
  official sources), V2 ACCEPT (ADR-004 settlement complete), V4 **ACCEPT
  omission of `takerSide`** (frozen artifacts do not resolve the vocabulary;
  domain owner must rule; do NOT add a mapping from the current sample),
  V3/V5 FAIL only via H1/M1/M2/L1. All five deviations and all assumptions
  ACCEPTED (incident-per-generation contingent on H1). Remediation round 1
  dispatched.
- Remediation round 1 completed 2026-08-27 in `73b70bc`, fresh repair session,
  probes reproduced first, per-finding mutation checks (identity-gate
  mutation → 44 failures): H1 → `connectionId` required on all four
  socket-event variants, stamped once per socket by the factory; the feed
  accepts events only from the live socket (bounded retired-id FIFO 256);
  refused events mutate nothing and return typed `rejected` outcomes with a
  counter and incident; frames get a `STALE_CONNECTION` classification with
  raw preserved; ERROR/CLOSE from a never-live identity still accepted while
  nothing is live (failed connect attempts can direct reconnects); M1 →
  wrapper must equal the payload-derived lowercase `<symbol>@<suffix>` AND
  belong to the resolved subscription set (`CHANNEL_MISMATCH`/
  `CHANNEL_NOT_SUBSCRIBED`); an unconfirmable wrapper is
  `UNVERIFIED_WRAPPER` and never becomes `sourceChannel`; M2 → bounded
  per-key FIFO window of recent id→identity pairs (default 64), previously
  seen ids duplicate regardless of arrival order, eviction consequence
  documented and observable; L1 → register text distinguishes one-vs-both
  unusable sides with a behavior-pinning test; L2 → UTF-8 byte measurement;
  off-state frames now `STALE_CONNECTION` instead of throwing. Disclosed
  deviation: socket-event callbacks take the connection id as a REQUIRED
  first parameter (identity cannot be optional without reopening H1;
  package unmerged). New load-bearing WP-120 obligation: supply a unique
  `connectionId` per attempt. Orchestrator fast-forwarded the canonical
  branch to `73b70bc` and reproduced gates: root 1943/1943, contract
  115/115, paths clean, lockfile untouched. Review round 2 dispatched.
- Review round 2 (fresh Codex `01a0464c-3130-7980-bef1-e020109d42ae`): **CHANGES
  REQUIRED**, strictly narrower — 0 blocker/high, 1 medium (lifecycle events
  are not correlated to an authorized PENDING attempt: `connecting()`
  records no expected id, so any well-formed UNKNOWN identity is accepted
  whenever no socket is live — four demonstrated holes: forged close on
  fresh IDLE directs reconnect attempt 1; forged close during the
  replacement's connecting interval exhausts maxAttempts; unknown ERROR
  accepted after caller shutdown; after 257 retirements an evicted
  historical id's OPEN is accepted, replaces the live socket, and advances
  the generation), 0 low, notes (mutation count 45 not 44; root suite
  sandbox-limited as before). M1/M2/L1/L2 confirmed FIXED (wrapper
  validation, bounded duplicate window incl. eviction disclosure, register
  text, UTF-8 bytes); the retired-identity connecting-interval case IS
  refused (the WP-090-style residue does not exist here); never-live
  acceptance rule REJECTED as designed; 256-FIFO risk characterization
  REJECTED (false for OPEN); ND1/ND2 ACCEPT; WP-120 unique-id obligation
  sound but insufficient alone — the adapter must register pending ids.
  Remediation round 2 dispatched.
- Remediation round 2 completed 2026-08-27 in `352380f`, probes reproduced
  first, per-finding mutation checks: `connecting(connectionId)` is now
  required-argument and REGISTERS the pending attempt; OPEN accepted only
  for the registered identity; pre-open ERROR/CLOSE only for it and only
  while nothing is live (legitimate failed-connect path preserved);
  everything else refused for all four event types with typed `rejected`
  (carrying `pendingConnectionId`), a counter, and the new distinct
  `BINANCE_UNAUTHORIZED_CONNECTION_EVENT` incident; `close()` revokes the
  outstanding authorization; abandoned attempts retired; malformed/reused
  identities throw at registration. All four review probes now refusals
  (fresh-IDLE forged close; connecting-interval forged close;
  post-shutdown unknown error; evicted-identity OPEN after 257
  retirements — live socket and generation unchanged). The 44-vs-45
  mutation-count discrepancy settled by re-running both exact mutations
  (44 and 45 respectively, both now recorded). Disclosed deviation:
  `connecting()` signature change (required id; unmerged package, no
  consumer). Final WP-120 identity contract: uniqueness AND registration.
  Orchestrator fast-forwarded the canonical branch to `352380f` and
  reproduced gates: root 1953/1953, contract 119/119, paths clean,
  lockfile untouched. Review round 3 dispatched.
- Review round 3 (fresh Codex `01a04671-5d7a-7132-bb76-c224a465747f`): **CHANGES
  REQUIRED** — R2-M1 FIXED (all four authorization attacks refused without
  mutation; legitimate failed-connect path preserved; 44/45 reconciliation
  verified accurate), but the mandated make-before-break probes exposed
  1 medium (R3-M1, pre-existing at `73b70bc`: `connecting()` unconditionally
  flips the feed to CONNECTING even while `#liveConnectionId` is populated,
  so the still-live socket's frames are refused as STALE_CONNECTION —
  mislabeled "frame without connection" — and staleness checks stop
  emitting; during a slow/failed replacement valid market data is discarded
  indefinitely) and 1 low (R3-L1: a PENDING-identity refusal maps to
  `BINANCE_UNAUTHORIZED_CONNECTION_EVENT`, whose documentation means an
  identity the feed never authorized — conflates an authorized-but-
  inadmissible event with a forged identity). P6 shutdown semantics
  ACCEPTED; risks 2/3/4 ACCEPTED; risk 1's characterization incomplete
  until R3-M1 is fixed (afterwards a NOTE-level residual); WP-120
  four-part identity contract judged sound and clearly documented.
  Remediation round 3 dispatched.
- Remediation round 3 completed 2026-08-27 in `38a6bb2`, probes reproduced
  first: R3-M1 → `connecting()` sets CONNECTING only when nothing is live
  (pending-attempt state orthogonal to the active socket); the live
  socket's frames stay NORMALIZED and staleness keeps emitting throughout
  replacement registration and after a refused pending failure;
  `FeedConnectionState` redocumented as a statement about the socket;
  `metrics()` gains `pendingConnectionId` so the in-flight attempt stays
  observable; R3-L1 → new `BINANCE_PENDING_ATTEMPT_EVENT_INADMISSIBLE`
  reason code (three-way refusal vocabulary: retired / pending-inadmissible
  / unauthorized), inherited by the frame path; risk-1 text rewritten as
  the NOTE-level residual (late OPEN under the caller-authorized identity
  is adopted as the make-before-break replacement it always was).
  Mutation checks: unconditional-state restore → 6 unit + 3 contract
  failures. New disclosed risks: the handover interval genuinely runs two
  transport sockets with one live in the books (shared sequence tracker
  keeps replayed ids duplicates); `state` alone no longer signals an
  in-flight reconnect (dashboards read `pendingConnectionId`). New WP-120
  item: decide how long a registered attempt may stay unresolved (adapter
  owns no timer). Orchestrator fast-forwarded the canonical branch to
  `38a6bb2` and reproduced gates: root 1961/1961, contract 123/123, paths
  clean, lockfile untouched. Review round 4 dispatched.
- Review round 4 (fresh Codex `01a0468b-af5d-7bc2-834c-4ad0ce4b4f5e`): **CHANGES
  REQUIRED** on one remaining interleaving — 0 blocker/high, 1 medium
  (R4-M1: an accepted close clears the pending identity only when the
  closing socket is itself PENDING; when the LIVE socket closes with a
  replacement pending, the feed sets IDLE and directs RECONNECT_AFTER while
  the authorization survives — a compliant caller registers a third
  identity, retiring the authorized replacement, risking redundant sockets
  or a handover gap; contradicts the documented CONNECTING and NONE
  semantics), 1 low (R4-L1: the round-3 risk text says the registration
  lasts only until "the live socket closes" and "nothing else changes" —
  both wrong for this interleaving). R3-M1 and R3-L1 confirmed FIXED
  (three-way refusal vocabulary verified; live frames/staleness flow
  through pending registration; adoption/abandonment/stop/second-
  registration/shared-tracker-handover/metrics all PASS). Remediation
  round 4 dispatched.
- Remediation round 4 completed 2026-08-27 in `e2ec1a1`, probe reproduced
  first (incl. the predicted double-charge: two RECONNECT_AFTER decisions
  and two maxAttempts slots for one outage): the `onClose` branch is keyed
  on AN ATTEMPT BEING IN FLIGHT (`#pendingConnectionId !== undefined` →
  CONNECTING + directive NONE, attempt not charged), which preserves the
  nothing-live failed-connect path (a PENDING close clears the pending id
  as that attempt's resolution before the branch is evaluated); the
  reconnect attempt is charged only when the attempt itself fails;
  `CONNECTING`'s second entry edge documented; risk text rewritten
  (registration survives a live close; three ending events named;
  no-timer consequence disclosed with the WP-120 deadline follow-up).
  12 new tests across unit+contract incl. attempt-budget accounting and a
  control; three independent mutations each pinned. New WP-120 driver
  obligation: read NONE after a FeedDisconnected as "wait for the attempt
  you already started". Orchestrator fast-forwarded the canonical branch
  to `e2ec1a1` and reproduced gates: root 1968/1968, contract 128/128,
  paths clean, lockfile untouched. Review round 5 dispatched.
- Review round 5 (fresh Codex `01a046a0-8dac-76f0-b9c2-c8e956a2fbd9`): **CHANGES
  REQUIRED** — 0 blocker/high, 1 medium (R5-M1, the packet's P6 hunt
  confirmed: when the PENDING socket closes FIRST — refused while live is
  open, registration deliberately retained — a later live close sees the
  stale pending id and parks the feed in CONNECTING + NONE with no attempt
  actually in flight; an obedient driver stalls indefinitely; the round-4
  branch composed with the round-2 disclosed residual), 1 low (R5-L1: risk
  text calls the retained registration an "attempt in flight" and tells
  WP-120 to wait for it — wrong for the pending-close-first ordering).
  P1-P5/P7/P8 all PASS (live-close-first, adoption, single-charge budget,
  control, failed-connect, stop, re-registration); mutation counts
  mechanically credible; accepted residuals unchanged. Remediation round 5
  dispatched: an already-closed pending socket must not count as in
  flight — the P6 live close must reconnect normally (IDLE, pending
  cleared/retired, exactly one RECONNECT_AFTER at attempt 1).
- Remediation round 5 completed 2026-08-28 in `a77c8f0` (implementer session
  interrupted once by an API session limit and resumed; probes reproduced
  first): design shape (a) — a refused PENDING `CLOSE` retires that attempt
  at refusal time, so `#pendingConnectionId` means UNRESOLVED ATTEMPT, not
  registered identity. Deliberate edges: the refusal is built first
  (telemetry unchanged); only CLOSE retires, never ERROR (error-then-close
  transports keep their adoption); only relation PENDING retires (round-2
  forged-close immunity preserved). The P6 ordering now reconnects normally
  (IDLE, pending cleared, one RECONNECT_AFTER at attempt 1). Disclosed
  design consequence: the rounds-2/3 "late OPEN adopted" residual is GONE —
  now an observable RETIRED refusal (packet-authorized). Risk text rewritten
  at all three locations (three orderings; four ending events; no-timer
  disclosure narrowed to genuinely unresolved attempts). New WP-120 note:
  count a rejected PENDING CLOSE as a failed attempt (the feed emits no
  FeedDisconnected for it). 9 new tests + 1 strengthened; three mutations
  pinned incl. the ERROR-retirement and PENDING-guard inversions.
  Orchestrator fast-forwarded the canonical branch to `a77c8f0` and
  reproduced gates: root 1974/1974, contract 131/131, paths clean, lockfile
  untouched. Review round 6 dispatched.
- Review round 6 (fresh Codex `01a0496d-8f4a-7e71-b053-52f437b35cd5`,
  candidate `a77c8f0` vs base `145fc32`): **ACCEPT** — 0 findings above NOTE
  (sole NOTE: the sandbox-blocked root-suite subprocess tests, covered by
  the orchestrator's exact-commit reproduction). R5-M1/R5-L1 verified FIXED
  with direct probes (refusal-before-retirement telemetry identical;
  ERROR-retains/CLOSE-retires spelling; forged-close immunity; P5
  preserved; late OPEN observably RETIRED; four-ending-events list matches
  code exactly); the WP-120 failed-attempt accounting note judged correct
  division of labor; full regression sweep clean (unit 247/247, contract
  131/131).
- Merged to `main` as `d0d66bf` under the release manager's standing
  delegation (2026-08-28). Third lockfile union auto-merged and
  frozen-install verified. Post-merge on `main`: root 2250/2250 (72 files),
  fault 89/89, integration 208/208 + 81/81, contract 583/583 + 131/131 +
  94/94 via the root `test:contract` script extended to all three adapters,
  audit clean. **Wave 1 batch 1B (WP-070/WP-080/WP-090) is COMPLETE** —
  three adapters, thirteen independent review rounds total, every round's
  findings strictly narrower. Binding WP-120 obligations accumulated across
  the three handoffs (identity registration contract; NONE-after-
  FeedDisconnected semantics; rejected-PENDING-CLOSE failed-attempt
  accounting; dedup identities; resync/gap routing; consumer-id stability)
  are recorded in the respective completion/in-flight records and the
  handoff files.
- **Cross-adapter `takerSide` divergence flagged by the orchestrator**: the
  frozen `ReferenceTradeObservedPayloadSchema.takerSide` is
  `BookSideSchema.optional()` documented only as "Taker side when the venue
  reports it" — the BID/ASK meaning for a taker is not specified. WP-090
  computes it (maker-side inversion, reviewer-accepted); WP-080 omits it
  (BNC-U5: refuses to guess the vocabulary mapping). Both are contract-legal;
  the semantic ruling (which BookSide value names the taker's side) is a
  domain-contract documentation gap for the next ADR-modifying package or an
  orchestrator governance round, and the two adapters must converge once
  ruled (WP-080 follow_up; register R-3 family).

**WP-070 (Polymarket public adapter):** implementer session hit an API session
limit after reporting all gates green, before writing the handoff document;
resumed via SendMessage per the recorded resume pattern (context intact).
- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-af750220276628c72`,
  base `145fc32`; chain `f4d374d` (impl) → `f16390c` (handoff SHA record).
  42 files, all allowed; lockfile +16/−0. Orchestrator reproduced gates:
  root 1869/1869, contract 177/177 (offline), check:deps PASS. No
  `@polymarket/client` or archived-client import (F6/F7) — native
  WebSocket/fetch behind injected ports. Headlines: **C-1/U-1 CONFIRMED by
  current official documentation 2026-08-27** (new page
  `docs.polymarket.com/api-reference/wss/market`: `price_change.size` = "New
  aggregate size (0 means level removed)"), correctly NOT self-ratified
  (protected paths untouched; ADR ratification queued for the orchestrator);
  R-2 discharged for owned schemas via an executable SDK anchor table (116
  assertions against pinned commit `7fdbed4…`, 5 recorded divergences);
  §9 narrowings discharged at the venue edge; tick-size one-for-one;
  no invented sequence number. Review round 1 dispatched.
- Review round 1 (fresh Codex `01a04623-3b3b-7e73-990e-6e45253a9c80`): **CHANGES
  REQUIRED** — 0 blocker, 2 high (H1 stale socket callbacks cross the
  generation boundary and are relabeled as current — the SAME defect class
  found independently in WP-080 r1 and WP-090 r1; H2 gap lifecycle not
  generation-bound: unsubscribe increments the generation without opening a
  gap, and `markResynchronized` requires no open gap or expected generation,
  so a stale snapshot acknowledgement for generation N closes generation
  N+1's gap and double-emits FeedResynchronized), 2 medium (M1 the R-2
  anchor table records the LOCAL loosened modifier for the five divergent
  REST fields rather than the SDK modifier — proving divergence instead of
  detecting it — two owned nested schemas unanchored, and REST requiredness
  of min_order_size/tick_size/neg_risk/hash loosened without REST evidence;
  M2 the §9 "any-length hex condition id" narrowing is capped at 200 chars
  by the frozen domain `ConditionIdSchema` — a contract-level contradiction
  the adapter cannot discharge; flagged for ADR-governed resolution), 1 low
  (one-outcome-per-frame-element accounting overstated for multi-entry
  price_change). C-1/U-1 evidence **PASS with caveat** (reviewer confirmed
  the page's delta semantics and internal consistency; could not extract the
  exact nested quote through its extractor); tick-size PASS (snapshot-emits-
  nothing reading accepted); F6/F7 PASS (zero venue dependencies); D1/D2/D4/
  D5/D6 ACCEPT, D3 REJECT (requiredness dimension). Remediation round 1
  dispatched.
- Remediation round 1 completed 2026-08-27 in `ef4713c` (+ doc `d71eb85`),
  fresh repair session, probes reproduced first, per-finding mutation checks
  (11 code + 5 anchor-table mutations all caught): H1 → immutable
  `FeedSocketSession` built before the factory call, all four callbacks
  capture it, `#isLive(session)` gates every path; stale frames recorded
  under the STALE session's identity with a new `STALE_CONNECTION_FRAME`
  problem (no false attribution, §8.3 satisfied); stale opens close the
  abandoned socket; H2 → unsubscribe retains the generation (rule: on a live
  connection the generation advances exactly when a gap opens — swept
  invariant test); `markResynchronized` takes the expected
  `subscriptionGeneration` and returns accepted/rejected with
  `NO_OPEN_GAP`/`GENERATION_MISMATCH`; M1 → REST requiredness restored for
  hash/min_order_size/tick_size/neg_risk on fresh first-party evidence (the
  venue's own OpenAPI requires all ten; SDK requires 8/10; only
  timestamp/last_trade_price stay absence-tolerant as reasoned presence
  divergences citing the SDK), anchor table records sdk/rest/local modifiers
  separately with per-dimension reasons, both unanchored schemas anchored,
  policed by an exported-schema enumeration test (116→509 assertions);
  M2 → any-length claim withdrawn in place, >200-char boundary asserted as a
  typed `INVALID_CONDITION_ID` problem (no throw/silent drop), discharged
  in substance not literally, ADR flag stands (contract-owner item 3);
  L1 → per-entry `entryIndex` added, claim restated as the venue's
  accounting unit; side comment corrected. New evidence for the venue
  report re-issue: the GET /book OpenAPI also contradicts the prose page on
  bid/ask ordering (follow_up). Orchestrator fast-forwarded the canonical
  branch to `d71eb85` and reproduced gates: root 1886/1886, contract
  578/578, paths clean, lockfile untouched. Review round 2 dispatched.
- Review round 2 (fresh Codex `01a04658-4c9f-78d1-ab1a-9af7d72c2ff4`): **CHANGES
  REQUIRED**, strictly narrower — 0 blocker, 2 high (R2-H1 synchronous
  `onOpen` publishes FeedConnected without sending the subscription — the
  session goes live before the factory call returns the socket, so
  `#sendFrames` sends nothing; the same sibling-adapter timing defect;
  R2-H2 an empty-set reconnect opens a gap WITHOUT advancing the generation
  — `remove()` retains the generation when no assets remain but the
  reconnect gap opens unconditionally, so an old same-generation
  acknowledgement closes the newer gap; the swept invariant test misses it
  because it reconnects with an asset remaining), 1 medium (the withdrawn
  any-length condition-id claim survives verbatim in
  `src/venue/primitives.ts:34`/`:70` — location missed by the repair),
  2 low (anchor coverage guard is name-convention-bound; the
  "source rejects the vector" test description overstates what is
  mechanically executed). Fix judgments: H1 otherwise complete (session
  binding incl. the connecting-interval refusal verified), H2 otherwise
  complete (remove/double-ack/stale-gen/N+1-race all pass), M1 FIXED, L1
  FIXED, comment FIXED. **ND3 judged NOT a finding**: SDK-over-OpenAPI
  presence authority is defensible — the reviewer re-fetched current
  official docs and found the higher-level OrderBook documentation
  independently declares `timestamp?`/`lastTradePrice?` nullable, a
  first-party source conflict at the same §1.1 tier; union acceptance with
  recorded divergence is the right call; the eight both-sources-required
  fields stay fail-closed. ND5 bid/ask-ordering contradiction verified
  recorded. Remediation round 2 dispatched.
- Remediation round 2 completed 2026-08-27 in `21cae1b` (+ doc `9e931cc`),
  probes reproduced byte-for-byte first: R2-H1 → per-attempt deferred
  socket-action queue on `FeedSocketSession` (the WP-090 shape); `#onOpen`
  defers its whole body so plan→send→FeedConnected order holds
  synchronously and asynchronously; stop/staleness/heartbeat/abandoned-
  socket closes routed through the queue; R2-H2 → no reconnect gap when
  the desired set is empty; invariant restated in the true direction
  ("every gap opens under a generation the same transition advanced") and
  re-swept including two empty reconnects; R2-M1 → claim withdrawn at both
  primitives.ts locations plus a third found by sweep (order-book.ts);
  R2-L1 → structural identity-based `reachableObjectSchemas()` guard
  walking zod `_def` with canary tests proving non-vacuity; R2-L2 →
  description corrected, +3 assertions (anchor cases 510). Disclosures:
  mutation C (`#sendFrames` deferral) is not killed alone — defense in
  depth jointly load-bearing with the open deferral (A+C kills 3); a
  synchronous post-open pre-return frame is stamped with the
  pre-subscription generation (the generation it genuinely arrived under;
  disclosed); `FeedGapDetected` now conditional on the desired set — WP-120
  must key recovery off `feed.openGap`, never off "a reconnect happened".
  Orchestrator fast-forwarded the canonical branch to `9e931cc` and
  reproduced gates: root 1894/1894, contract 581/581, paths clean,
  lockfile untouched. Review round 3 dispatched.
- Review round 3 (fresh Codex `01a0467f-fbb2-7e30-b39a-4e21c71645f5`): **CHANGES
  REQUIRED**, still narrowing — 0 blocker, 1 high (R3-H1: after a
  disconnect, `#scheduleReconnect` arms a timer and a manual `start()`
  during the backoff opens conn-2, but the stale timer still fires and
  `#connect()` overwrites the session with conn-3 WITHOUT retiring or
  closing conn-2 — a physically live subscribed socket leaks, its
  callbacks become non-authoritative by identity overwrite, and the open
  gap still names conn-2; the prior overtaking test never started a second
  connection while a timer was pending), 1 medium (R3-M1: a queued frame
  delivered after synchronous onOpen but before the factory returns is
  published as a current BookSnapshot under the manager's PRE-subscription
  generation — the round-2 disclosure's "generation it genuinely arrived
  under" was REJECTED as subscription provenance; must be refused/reported
  as pre-subscription data until the subscription is written), 0 low.
  R2-H2/R2-M1/R2-L1/R2-L2 all FIXED; undead mutation C ruled ADEQUATE
  disclosure (whole-open deferral covers the only no-handle path);
  empty-reconnect gap semantics ruled CORRECT per ADR-002 (no affected
  markets) and recorded loudly enough. Remediation round 3 dispatched.
- Remediation round 3 completed 2026-08-27 in `076b44c` (+ doc `97ddcf1`),
  probes reproduced byte-for-byte first: R3-H1 → three-layer fix
  (`#connect()` cancels the armed reconnect; the timer stands down unless
  status is idle AND no session exists; new `#displaceLiveSession()`
  retires/stops/closes via `#withSocket` and publishes FeedDisconnected
  with a package-local `CONNECTION_SUPERSEDED` reason) — honest mutation
  matrix disclosed: no layer dies alone (each is covered by another), but
  A+B kills 3 tests via layer 3's disclosure and A+B+C reproduces the
  reviewed leak verbatim; R3-M1 → `FeedSocketSession.subscribed` set after
  subscription frames are written and the generation advanced; `#onMessage`
  refuses earlier frames with a new `PRE_SUBSCRIPTION_FRAME` problem
  carrying the payload, placed after the stale check (ordering pinned by
  test); raw record still written first. One round-2 test deviation
  disclosed (expects the new code; property unchanged, test strengthened).
  New risks: `CONNECTION_SUPERSEDED` is unreachable-by-construction public
  surface (defense in depth); pre-subscription frames are not parsed (a
  pre-return PONG is reported, not consumed — unreachable before a PING).
  WP-120 note: treat PRE_SUBSCRIPTION_FRAME as a transport observation.
  Orchestrator fast-forwarded the canonical branch to `97ddcf1` and
  reproduced gates: root 1903/1903, contract 583/583, paths clean,
  lockfile untouched. Review round 4 dispatched.
- Review round 4 (fresh Codex `01a046a3-c4fa-7b73-818c-fd55fae07f7c`,
  candidate `97ddcf1` vs base `145fc32`): **ACCEPT** — 0 findings above NOTE
  (sole NOTE: a stale doc comment at feed/subscriptions.ts:45 saying
  generation 0 is "never carried by an event", contradicted by the accepted
  empty-subscription behavior — runtime correct, documentation residual for
  a future authorized packet). R3-H1 and R3-M1 verified FIXED with
  independent probes (no third socket in the overtake race; conn-2 stays
  authoritative; CONNECTION_SUPERSEDED confirmed genuinely unreachable
  today and accepted as defense-in-depth; pre-return frames refused with
  raw preserved and correct generation provenance; pre-return PONG ruled
  unreachable-before-PING; empty-subscription probes show no wedged state);
  the round-2 test change verified not weakened; full regression matrix
  clean.
- Merged to `main` as `f2f0258` under the release manager's standing
  delegation (2026-08-27, recorded 2026-08-28 after a session-limit
  interruption). The lockfile union with WP-090's block auto-merged cleanly
  and `pnpm install --frozen-lockfile` accepted it without regeneration.
  Post-merge on `main`: root 2003/2003 (60 files), fault 89/89, integration
  208/208 + 81/81, contract 583/583 + 94/94 via the root `test:contract`
  script extended by the orchestrator to run both suites, audit clean.
  **WP-100 is now unblocked** (sequenced strictly after the WP-070 merge;
  path subset now exclusive). Contract-owner items 1-3 (C-1/U-1
  ratification, `takerSide` ruling, `ConditionIdSchema` cap) remain queued
  for the governance round after batch 1B closes.
- **Contract-owner items accumulated from batch 1B round 1** (for the next
  ADR-modifying package or an orchestrator governance round): (1) ratify
  C-1/U-1 across the four provisional-marked paths (WP-070 documentary
  confirmation 2026-08-27); (2) rule the `takerSide` BID/ASK vocabulary
  (WP-080 omission accepted pending ruling; WP-090 emits maker-inversion;
  adapters must converge); (3) reconcile the frozen `ConditionIdSchema`
  200-char cap with the §9 no-length-bound narrowing (WP-070 M2).

### WP-060 completion record (2026-08-27)

- Review round 3 (fresh Codex session `01a0447d-5890-7a72-8808-810b0e473f2d`,
  candidate `954e764` vs base `4126f29`): **ACCEPT** — 0 findings above NOTE
  (sole NOTE: reviewer sandbox lacked Docker for the integration gate; covered
  by the orchestrator's independent 81/81 reproduction at the exact commit).
  All round-2 fixes verified FIXED with direct probes (typed queue-full refusal
  before any Redis mutation with no capacity leak; durable-first resync
  acknowledgement with failure-path stickiness and recovery; publish sequence
  validation→XADD→SET→XTRIM with exact-contents compensation; metrics judged
  server-side; foreign-entry disclosure accurate; clock-guard reorder).
  ND3/ND4/ND5 and NR5-NR8 all ACCEPT; two mutation-check claims independently
  spot-verified; full regression sweep clean.
- Merged to `main` as `af29b08` under the release manager's standing delegation
  (2026-08-27). Post-merge on `main`: root 1727/1727, fault 89/89, integration
  208/208 (postgres) + 81/81 (event-bus), `check:deps` PASS, audit clean,
  frozen install verified. Root `test:integration` wired by the orchestrator in
  the completion commit to run both integration suites; CI step renamed
  accordingly (WP-040/WP-050 precedent for orchestrator-owned root wiring).
- As merged: transport-neutral interface (publish / subscribe / consumer
  checkpoint / bounded retention) carrying frozen-domain `EventEnvelope`s;
  Redis Streams v1 implementation (ioredis@6) with serialized per-epoch
  publication (bounded admission queue, typed halt-class refusal), atomic
  publication ordinals making retention loss exactly detectable
  (`missedEventCount`), server-judged instance-bound `ebc2` checkpoint tokens,
  sticky hard-resync blocking delivery and checkpointing until an
  authoritative-snapshot acknowledgement is durably recorded, §8.3 metric set
  plus `unreadableCheckpoints`/`retentionTrimFailures`, BigInt-exact per-epoch
  ordering, opaque payloads. Vocabulary test mechanically enforces that no
  Redis term appears in consumer-facing types (ADR-003 Consequences).
- Binding obligations recorded for consumers (WP-060 handoff follow_up):
  WP-120 must dedup on `(gatewayEpoch, ingestSeq)` (NOT `eventId`), keep one
  stable durable consumer id per role, publish each epoch from one process
  sequentially, route `resync-required` to the halt path with a
  `DataQualityIncidentOpened` + authoritative snapshot, treat
  `EVENT_BUS_PUBLISH_QUEUE_FULL`/`EventBusUnavailableError` as
  halt-plus-incident signals, and size `maxQueuedPublishes`/retention
  deliberately (retention sizing belongs in the operational runbook). WP-140
  exports queue depth/max/oldest-age pairs from process memory. The 5 ms p99
  gateway-to-trader target remains an unmeasured target (ADR-003 §5).

### WP-060 review history (2026-08-27, archived)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-ab4ebe3e28c3ce141`,
  base `4126f29`; chain `d7bbb0f` (implementation) → `794347a` (handoff record).
  41 files, all in allowed paths (lockfile ratified 2026-08-27, additive-only +71/−0).
  Orchestrator reproduced all gates in the candidate worktree: frozen install,
  typecheck, lint, `check:deps` PASS, root 1703/1703, event-bus integration 57/57
  (real Testcontainers Redis).
- Review round 1 (fresh Codex session `01a04418-b394-7542-b762-25ffad67452a`,
  candidate `794347a` vs base `4126f29`): **CHANGES REQUIRED** — 0 blocker,
  2 high (H1 concurrent publishes can reorder one gateway epoch: check-then-act
  cursor advances after append, probe delivered `["2","1"]`; H2 forged or
  cross-instance checkpoint tokens are syntax-validated only and silently skip
  retained events — future entry ID yields `idle` with no gap), 2 medium (M1
  publish Lua script INCRs the ordinal before XADD, so an append failure burns
  an ordinal → false hard resync and phantom `messagesDropped`; M2 handoff
  instructs WP-120 to dedup on `eventId` instead of the required
  `(gatewayEpoch, ingestSeq)`), 1 low (L1 handoff's "no default start position"
  claim false — a safe stored-checkpoint/oldest-retained default exists), notes
  (reviewer sandbox had no Docker — integration suite verified by orchestrator
  instead; fresh consumer ID with explicit `start: newest` can proceed past
  another consumer's pending resync — explicit, WP-120 must keep its durable
  consumer ID stable; testing helpers not exported from the main entry).
  Deviation judgments: D1 REJECT as stated (prose), D2/D3/D4/D5 ACCEPT.
  Assumption judgments: A5 REJECT (§8.1 does not establish sequential gateway
  publication), A1-A4/A6/A7 ACCEPT. Interface neutrality, path ownership,
  dependency direction, and safety criteria PASS as reviewed.
- Remediation round 1 completed 2026-08-27 in `3bc247c` (+ handoff `eee4b54`),
  fresh repair session, every probe reproduced on the unmodified candidate
  before fixing, per-finding mutation checks: H1 → `KeyedSerialQueue` makes
  check+append+cursor one serialized step per gatewayEpoch (concurrent
  reverse-order publish now refused before append); H2 → per-stream instance
  marker key + versioned `ebc2` tokens, `RESOLVE_POSITION`/`STORE_CHECKPOINT`
  Lua scripts judge marker/ordinal/clock/exact-entry server-side before
  delivery, unreadable stored positions refused and counted
  (`unreadableCheckpoints`); M1/P6 → `PUBLISH_SCRIPT` prevalidates key types +
  safe-integer ceiling before any mutation, pcall-guarded append with
  compensation (failed counter write removes the appended entry); M2 → handoff
  corrected to `(gatewayEpoch, ingestSeq)` dedup with positive duplicate test;
  L1/NOTE → prose corrected, WP-120 obligations now explicit (stable durable
  consumer id per role). Two new disclosed deviations: fourth per-stream key
  (instance marker), new `unreadableCheckpoints` metric field. Orchestrator
  fast-forwarded the canonical branch to `eee4b54` and reproduced all gates:
  root 1719/1719, integration 73/73, check:deps PASS, lockfile untouched this
  round. Review round 2 dispatched.
- Review round 2 (fresh Codex session `01a0444d-a524-70b3-bfe8-c5f3cd0525eb`,
  candidate `eee4b54` vs base `4126f29`): **CHANGES REQUIRED** — 0 blocker,
  2 high (R2-H1 the new publish serialization queue is unbounded and queue-wait
  time invisible — 10,000 operations admitted behind a stalled publish with
  only active-key count observable, and `producerBlockedTimeMs` starts after
  dequeue, contra §8.3; R2-H2 a failed durable hard-resync acknowledgement
  clears the sticky resync state before the checkpoint write — injected
  write failure left delivery unlocked with `pendingAfterFailure: null`),
  1 medium (R2-M1 publish compensation cannot restore an entry trimmed by
  `XADD MAXLEN` when the subsequent counter `SET` fails at full retention;
  NR4 characterization REJECTED as incomplete), 3 low (L1 `unreadableCheckpoints`
  undercounts — marker-only check, a same-marker future token reports as
  ordinary lag; L2 handoff omits the accepted foreign-entry step-over
  exception; L3 clock regression refuses genuine retained checkpoints —
  fail-closed availability issue). Round-1 fixes otherwise verified: H1 core
  reorder fixed (queue does not poison/deadlock, epochs independent), H2 core
  forgery closed (future/cross-prefix/ebc1/mismatched tokens refused), P6/M2/
  L1/NOTE fixed; ND1/ND2 ACCEPT (ND2 contingent on L1), new ADR-002 §2
  serialization-boundary assumption ACCEPT, NR1 ACCEPT in principle
  (foreign-entry disclosure required), NR2/NR3 ACCEPT, empty-stream residue
  ruled LOW/NOTE-acceptable. Reviewer sandbox again had no Docker; integration
  evidence remains the orchestrator's independent 73/73 reproduction.
- Remediation round 2 completed 2026-08-27 in `9c43b52` (+ handoff `954e764`),
  fresh repair session, probes reproduced first, per-finding mutation checks:
  R2-H1 → `KeyedSerialQueue` bounds admission (`maxQueuedPublishes`, default
  1024) with typed `EventBusPublishQueueFullError` (subclass of
  `EventBusUnavailableError`), exposes pending count/max/oldest-pending age,
  and `publish` now times submission→completion so queue wait is counted in
  `producerBlockedTimeMs`; R2-H2 → durable checkpoint store happens FIRST,
  every in-memory resync transition after it in statements that cannot fail
  (probed: positions-key occupied, marker rewritten, transport unreachable);
  R2-M1 → `XADD` no longer trims — entry, then counter `SET`, then `XTRIM`
  last; a post-commit trim failure is counted (`retentionTrimFailures`), not
  raised; R2-L1 → stored positions judged with the same server-side script
  `subscribe` uses; R2-L2/L3 → foreign-entry step-over documented; exact-entry
  lookup moved before the clock guard (future id naming no entry still
  refused). New disclosed deviations: per-stream (not per-epoch) admission
  bound; new `retentionTrimFailures` metric field; defaulted fourth
  `EventBusUnavailableError` constructor parameter. Orchestrator
  fast-forwarded the canonical branch to `954e764` and reproduced all gates:
  root 1727/1727, integration 81/81, check:deps PASS, lockfile untouched.
  Review round 3 dispatched.

### WP-040 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-aa6e4c6fd7701b054`,
  base `b1431e4`; chain `0a73ffe` (initial) → `7d8e94d` (handoff) → `49d065c`
  (orchestrator D1: testcontainers build-script denial in pnpm-workspace.yaml,
  disclosed) → r1 `f439e55`/`c287413` → r2 `65d9622`/`8be5e5c` → r3
  `964c6e4`/`43dbe04` → r4 `ca5d603`/`f8982bf`; merged `d23bb67` under the
  standing delegation.
- Reviews (fresh Codex per round): r1 4H/4M/2L, r2 4H/2M, r3 1H/1M, r4 1H/1M/1N
  — every bypass reproduced on the reviewed schema before fixing — r5 **ACCEPT**
  (zero findings above NOTE; binding-class sweep run twice and closed).
- As merged: 57 tables across six schemas + internal/migrations; §10.7
  constraints database-enforced and adversarially probed (immutable balance
  identity keyed to reservation facts; forward-only fencing leases with an
  un-lowerable per-realm token high-water; account_key sentinel binding fills to
  orders; ledger discriminators bound to order/fill/wallet-operation facts incl.
  conditional wallet-market equality via PMB12; SIGNED requires its attempt per
  §9.11; decimal-safe JSON incl. model_outputs; NULLS NOT DISTINCT venue
  identity; uuid_v7 variant check); Kysely typed repositories; advisory-locked
  checksum-verified migration runner (up+down verified).
- Obligations recorded for consumers: F13/F16-F20 (WP-200: carry the market on
  ledger postings; resolve wallet-operation market before insert; net positions
  from ledger_entries.account_ref; attempt row before SIGNED order — WP-320
  same); R9-R21 risk register accurate and owned.
- Post-merge on `main` at `d23bb67`: lockfile regenerated (two benign vitest
  peer-key rewrites from the WP-050/WP-040 merge union; frozen install verified);
  1441 root + 89 fault + 208 integration tests green; root `test:integration`
  and `db:migrate` wired to the package (WP-010 placeholders replaced) and the
  CI step renamed to the real suite; `db:migrate` proven end-to-end against the
  compose dev DB (all 8 migrations applied then status-verified; torn down).

### WP-015 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-a2a6f707d957e8153`,
  base `ff0c01e`; chain `bb441dc` (initial) → `c668493` (handoff) → nine
  remediation commits (`c9b59b2` `7de62d0` `6658026` `a87f26c` `a187ccf`
  `900b299` `fdf9c02` `9a89040` `b2b3b9b`); merged `d77b2ba`.
- **Ten independent adversarial review rounds** — an unusually deep hardening
  arc for a CI lint, each round closing exactly one more class of module-load
  escape a purity-restricted package could use to reach a forbidden module,
  every bypass runtime-verified by the reviewer: regex scanner (r1) → hand lexer
  (r2 fail-open) → TypeScript compiler-API AST (r2 rebuild) → require-capability
  tracking (r3) → total unconsumed-reference rule (r4) → `getBuiltinModule`
  (r5) → `.constructor` evaluator acquisition (r6) → `process.mainModule`/
  `require.main` (r7) → `.constructor`+ambient audit (r8, superseded) →
  named/renamed `node:module` imports (r8 fix) → `new`-result escape (r9) →
  ACCEPT (r10) at the calibrated ordinary-code bar.
- **Deliverable & scope**: `tools/check-dependency-direction.mjs` implements
  `docs/contracts/dependency-direction.md` §6 — it PARSES the contract's §2 layer
  table and §2.1 same-layer allowlist at runtime (no mirrored copy), builds the
  workspace dependency graph, and enforces cycles (F9), upward-edge (F12) and
  unlisted-same-layer-edge (F13) prohibitions, plus per-package forbidden
  specifiers / impure globals / evaluator+loader capability escapes (F1-F8/F11)
  for the four purity-restricted packages. Wired into CI as `pnpm check:deps`
  and the root `check:deps` script; repo verdict PASS (34 packages / 2 edges,
  only the S0 `domain→decimal` edge).
- **Honest terminal position** (WP-015 handoff, re-affirmed at merge): a
  name-enumeration static scanner is provably non-total. After ten rounds no
  ORDINARY-CODE (non-reflective, single-file, statically-named, plausibly-
  accidental) silent synchronous forbidden-load route is known; the remaining
  residuals — reflective acquisition (`Reflect.get`), runtime-computed member
  names, and cross-file capability injection — are inherent to the architecture
  and documented, not one-more-spelling gaps.
- **Durable follow-up (WP-030 contract owner)**: follow_up 8 — replace the
  growing negative capability list with a POSITIVE rule ("a call in a restricted
  package whose callee does not statically resolve to a declared import or a
  known-pure local is a finding"), total by construction. It needs a numbered
  `docs/contracts/**` §3 rule (outside WP-015's paths) and carries a
  contract-level noise trade-off, so it is deliberately deferred to the contract
  owner rather than rammed in. The CI check is defense-in-depth; the real purity
  guarantee remains package structure + review + tests + runtime.
- Post-merge on `main` at `d77b2ba`: 1628 root + 89 fault + 208 integration
  tests green; `check:deps` PASS; lockfile unchanged.

### WP-050 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-a8f55b87222d2953c`,
  base `b1431e4`; chain `32cb0a8` (initial) → `3c2228a` (handoff) → `a972e96` (r1)
  → `3f35a0c` (r2) → `b3a906f` (r3) → `22db770` (orchestrator LOW wording fixes,
  disclosed); merged `8a607ec` under the standing delegation.
- Reviews (fresh Codex per round): r1 CHANGES REQUIRED (frame loss on non-append
  faults; doctored-metadata validation; soft cap), r2 CHANGES REQUIRED
  (fsyncgate; queue stranding; sidecar double-count; burst cap), r3 CHANGES
  REQUIRED (earlier-fsynced accountability; factory width; ordinal false
  positive) — each round's fixes probe-reproduced first — r4 **ACCEPT**
  (mutation walk verified no release-without-manifest path; recovery table,
  checksum boundary, older-manifest compatibility, §13 worked example all
  verified; 2 LOW doc wordings fixed pre-merge).
- Core guarantees as merged: durability watermark (any fsync-or-write failure
  freezes durability claims permanently; manifests never overcount);
  accountability released ONLY by a written manifest (an unmanifested segment
  returns every accepted record to `pendingFrames()` — at-least-once);
  `maxTotalBytes` holds for default/stable factories with an enforced
  1024-byte factory-id bound; provenance-scoped manifest validation.
- **Binding obligations on consumers** (carry into WP-120/WP-130 packets):
  dedup on `(gatewayEpoch, ingestSeq)` is MANDATORY (duplicates are the normal
  fault-boundary outcome by design); the gateway drives `drain()`/`tick()` and
  routes refusals/faults to incidents; retention memory (one segment's records,
  64 MiB default bound) is reasoned-not-profiled — profile in WP-140 soak.
- Post-merge: 1387 root + 89 fault tests green; root `test:fault` script and a
  CI step wired by the orchestrator in the completion commit (recorded plan).

### WP-030 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus subagent; session interrupted once by an
  API limit and resumed) on branch `worktree-agent-a919f38ed969c8ffc`, base
  `f7ccb8e`; chain `051bb62` (ADRs + contract docs) → `1e30ff1` (handoff) →
  `66d29a9` (review round 1 remediation) → `21a3370` (round-2 residual fix,
  applied directly by the orchestrator with disclosure in the handoff); merged to
  `main` as `59cf254` under the release manager's standing delegation.
- Independent adversarial reviews (fresh Codex session per round): round 1
  CHANGES REQUIRED (2 medium: 5/26 citation-sample failures, dependency-layer
  inconsistency), round 2 CHANGES REQUIRED (1 medium residue; fresh 15-site
  citation sample over the unaudited surface passed in full), round 3 **ACCEPT**
  (0 findings above NOTE; residual-fix scope and orchestrator disclosure
  verified).
- Post-merge integration on `main` at `59cf254`: all gates pass (1102/1102,
  pytest, audit). The one inherited NOTE (broken `#contract-freeze` anchor in
  `docs/contracts/domain.md`, present since WP-020) fixed in this governance
  commit as promised in the WP-030 handoff.
- Deliverables: ADR-001..ADR-012 (all Status: Accepted, evidence-cited),
  `docs/adr/README.md` (ADR policy/template), `docs/contracts/
  dependency-direction.md` (single-layer-per-package model, enumerated
  same-layer edges S0–S2, mechanically implementable three-part CI check spec —
  NOT yet enforced, owner unassigned), `docs/contracts/protected-contracts.md`
  (protected-path policy + open venue-fact register), additive `domain.md` §10
  ADR cross-reference, handoff `docs/handoffs/WP-030.md`.
- Open items registered for later packages: dependency-check CI owner; venue-fact
  gaps (same-account matching, shared-bucket arbitration, Binance/Coinbase
  framing → WP-080/WP-090, U-6 50/50 mechanics → WP-110, U-7 SDK pin → WP-260,
  C-1/U-1 → WP-070, C-2 → ledger/fees, C-3 → WP-280).

### WP-000 completion record (2026-08-26)

- Implemented by `venue-verifier` (rounds 3+ on Opus subagents) on branch
  `worktree-agent-a373c7ba6650bf1a9`, base `7faf30f`; commit chain `8d16849` →
  `f79aa96` (r1) → `f8ecdbb` (r2) → `30e6f47` (handoff) → `5b98b5e` (r3) →
  `4505aaf` (r4) → `ac85ab6` (r4b) → `ddc56ff` (r5); merged to `main` as
  `d427f00` under the release manager's standing delegation (2026-08-26).
- Independent adversarial reviews (fresh Codex session per round): rounds 1–5
  CHANGES REQUIRED, round 6 **ACCEPT** (session `01a03d73-8ad1-7b23-929d-9f93703b67ef`;
  0 blocker/high/medium; residual LOW: `conditionId` 31/32-byte fixture narrowing —
  runtime parsers must NOT inherit it; NOTE: report §17 wording, self-corrected).
- Post-merge integration on `main` at `d427f00`: install/typecheck/lint/test
  (1102/1102), `uv` + pytest, and `pnpm audit` all pass.
- Deliverables: `docs/venue/verified-2026-08-24.md` (29 gated sections, 120
  official-source citations, 26 SDK links pinned to commit `7fdbed4…`), 17
  sanitized fixture JSON files across market-ws/user-ws/orders/heartbeat/fees/
  rate-limits/geoblock/positions/rtds, and the `verify-venue` CLI skeleton with
  305 offline tests (per-section citation gate, recursive schema validation,
  credential scanner with 57+ vectors). No credential, signer, order, or
  authenticated call anywhere.
- Open venue conflicts/unverified items carried to WP-030/later packages:
  C-1/U-1 (price_change zero-removal semantics → WP-070), C-2 (USDC vs pUSD
  denomination → ledger/fee packages), C-3 (MATCHED_NOT_BROADCASTED layering →
  WP-280), U-7 (npm version pin → WP-260), plus fixture-only narrowings that
  runtime adapters must not inherit (SDK `.nullish()` fields, conditionId length).

### WP-020 completion record (2026-08-26)

- Implemented by `wp-implementer` (Opus subagent) on isolated worktree branch
  `worktree-agent-a45b4929f044830ca`, base `4c1d96f`; commit chain `815b6cb`
  (initial) → `9790e0a` (review round 1 remediation) → `8d9596e` (review round 2
  remediation); merged to `main` as `25bc451` under the release manager's standing
  delegation for this run (2026-08-26).
- Independent adversarial reviews (fresh Codex session per round): round 1
  CHANGES REQUIRED (3 high, 4 medium, 2 low), round 2 CHANGES REQUIRED (3 medium,
  1 low), round 3 **ACCEPT** (Codex session `01a03d55-078f-7283-ba28-9bb01535e0d1`;
  0 blocker/high/medium; residual LOW doc shorthand fixed post-merge; NOTE —
  WP-030 ADR should reserve top-level payload key `venue` for provenance).
- Post-merge integration on `main` at `25bc451`: `pnpm install --frozen-lockfile`,
  `typecheck`, `lint`, `test` (797/797), `uv sync --frozen` + `pytest`, and
  `pnpm audit --audit-level high` all pass.
- Deliverables: `@polymarket-bot/decimal` (canonical §7.3 grammar, exact
  arithmetic, deterministic domain-tagged SHA-256 hashing with strict hash-input
  grammar, exact tick modulo) and `@polymarket-bot/domain` (event envelope with
  required `gatewayEpoch`/`ingestSeq` and provenance refinement, 22 versioned
  event contracts, DecisionResult with zero-or-more intents, five intent types,
  run modes with PAPER-safe maximum assertion, versioned schema registry), plus
  `docs/contracts/domain.md` and handoff `docs/handoffs/WP-020.md`.
- Items deferred to WP-030 ADRs: decimal library + canonicalization + hash
  preimage; strict-boundary/normalize split; version-per-field-set policy;
  inferred `QuoteLevel`/`BasketLeg`; `DISPUTED` non-terminal ruling;
  `TradingParametersChanged` vocabulary (`status` per §10.1, `open_time`/
  `close_time` per §9.2); reserve payload key `venue` for provenance.
- Domain contracts are now FROZEN: changes require an ADR (workplan
  `protected_paths` already covers `packages/domain/**`, `packages/decimal/**`).

### WP-010 completion record (2026-08-22)

- Implemented by `wp-implementer` on isolated worktree branch; implementation commit `1bca7cf90d6488107d5fed908a44c5eb18989bc1`; merged to `main` as `12ce0ab` after human approval.
- Independent adversarial review: **ACCEPT**, zero high/medium findings.
- Acceptance criteria (`pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test`, no live credentials; plus `uv sync --frozen` + `pytest`) verified by implementer, reproduced independently by reviewer, and re-run on merged `main` — all pass.
- Path ownership ratification: root `eslint.config.mjs` is canonically recorded in `docs/spec/polymarket-bot-workplan.yaml` under WP-010 `allowed_paths` and global `protected_paths` (2026-08-23).
- External post-merge review (Codex, 2026-08-23): CHANGES REQUIRED with two medium findings — both remediated same day: (1) CI now runs dependency vulnerability scans over both lockfiles (`pnpm audit --audit-level high`; `uv export --frozen` + `pip-audit --strict`), both passing locally; (2) the complete auditable WP-010 handoff with all required fields is recorded at `docs/handoffs/WP-010.md`. Additionally, a compose health gate (`pnpm test:compose` + CI `compose` job) now supplements the exit-0 `test:integration` placeholder, and it passes locally.

## Wave 0 closeout (2026-08-26)

- Closeout audits (runbook §10, both fresh read-only contexts): Codex mechanical
  audit (session `01a03ee5-ddd6-7683-918b-02840e9c0ff6`) — initial verdict
  **WAVE INCOMPLETE** solely on (a) two gates unrunnable in its sandbox and
  (b) status-file bookkeeping, with merges/acceptance/safety/register all PASS;
  Claude architectural consistency pass — **INCONSISTENCIES FOUND** (1 high,
  7 medium, 4 low, no blocker; ADR-vs-code, git-facts, and safety checks all
  verified clean), plus a 10-item Wave 1 gap list.
- Orchestrator gate reruns on `main@c9e9a72` (2026-08-26): `pnpm audit
  --audit-level high` → no known vulnerabilities; `pnpm test:compose` → healthy
  (with the documented `PMB_POSTGRES_PORT=15432`/`PMB_REDIS_PORT=16379`
  overrides; native PostgreSQL occupies 5432 on this host), stack torn down.
- Bookkeeping corrected in this commit: WP-000 fixture count (17 JSON files);
  authorization vocabulary + accurate dependency-ready states in the package
  table; stale worktree entries archived below.
- Governance fixes in this commit: WP-070 acceptance criterion reworded to stop
  asserting C-1/U-1 as settled (workplan, audit M3); WP-100 sequenced after
  WP-070 with a scoped package.json ratification (M8, runbook corrected);
  test-tree registration ratification for unexecuted test roots (M7); WP-015
  (dependency-direction CI enforcement) added to the workplan with ratified
  paths — resolves the unassigned-owner item; runbook added to AGENTS.md
  reading list (N15); venue-report filename ratification comment added to the
  workplan (L10).
- **C-4 ownership assigned**: the quickstart/overview archived-SDK-reference
  re-check is owned by the orchestrator-run phase-start venue re-verification
  (handoff §1.2), to be executed and recorded before Wave 1 batch 1B (WP-070+)
  dispatch.
- Remaining architecture findings (H1 null-handling doc contradiction; M2
  UNVERIFIED marker on book.ts + domain-successor policy; M4 binding-narrowing
  list completion; M5 grammar-duplication register + dropped follow-up; M6
  dependency-direction false fact; L9 decimal error-code defect; L11
  ops:verify-venue wiring; L12 ops-cli undeclared devDeps; N13 unratified
  inferred shapes register) → fixed in the bounded **Wave 0 closeout
  remediation package**: candidate `42fbf2b` (impl `2d41c97`, base `b1431e4`),
  independent review **ACCEPT** (0 blocker/high/medium; 1 low: handoff
  evidence-scope wording on the errors test; book.ts comment-only proven by
  identical stripped-transpile hash), merged `b8e5eab`, post-merge gates green
  (1203/1203 tests; `pnpm ops:verify-venue` exit 0; audit + compose verified
  earlier this closeout).

**WAVE 0: COMPLETE (2026-08-26).** All four packages plus the closeout
remediation merged and post-merge verified; both closeout audits' actionable
items resolved or ownership-assigned; domain contracts frozen; run mode PAPER;
no signer or credentials. Wave 1 authorized per the package table.

## Wave 0 review history (archived; all branches merged and worktrees removed)

- `worktree-agent-a919f38ed969c8ffc` (WP-030): base `f7ccb8e`, candidate `1e30ff1`
  (impl `051bb62` + handoff). ADR-001..012, docs/adr/README.md,
  docs/contracts/{dependency-direction,protected-contracts}.md, additive
  domain.md §10 cross-reference, docs/handoffs/WP-030.md. Implementer session was
  interrupted once by an API session limit and resumed with context intact.
  Orchestrator verified: 17 files all in allowed paths, domain.md diff purely
  additive, gates reproduced (1102/1102). Review round 1 (Codex session
  `01a03eb9-6992-76a2-9f02-ca351bf7cbc8`, candidate `1e30ff1` vs `f7ccb8e`):
  **CHANGES REQUIRED** — 0 blocker/high, 2 medium (citation-accuracy sample 26
  checked / 5 failed: taker-rebate "pool-shared, midnight UTC" generalization in
  ADR-006+ADR-012; ADR-011 deterministic loser-cancel-fails and account-level
  self-trade assertions beyond report evidence; ADR-004 "every feed JSON"
  overreach vs Binance/Coinbase + PING/PONG; dependency-layer contract
  internally inconsistent: event-bus in layers 1 and 2, same-layer ban would
  forbid strategy-runtime→strategy-sdk, layer CI unimplementable as written),
  1 low (handoff file-count 16 vs actual 17), notes (normalize one ADR
  cross-reference). All four flagged inferences RATIFIED; README/domain.md §10
  deviations ACCEPTED; three-part CI concept sound pending layer-model fix;
  deferred backlog fully covered; safety defaults PASS. Remediation round 1
  completed 2026-08-26 in `66d29a9` (per-program reward facts; contention risk
  without invented determinism; same-account matching marked NOT DOCUMENTED;
  ADR-004 feed-framing claims split with Binance/Coinbase marked to-verify;
  dependency model made single-layer-per-package with an enumerated
  permitted-same-layer-edges table — including the already-shipping S0
  domain→decimal edge — and a mechanically implementable fail-closed check spec;
  counts fixed; two new venue-fact gaps registered). Orchestrator fast-forwarded
  and verified (1102/1102). Review round 2 (Codex session
  `01a03ed6-4411-79c1-be09-dc87a4fad7f8`): **CHANGES REQUIRED** — one MEDIUM
  residue (ADR-006/ADR-012 Evidence summaries still carried the all-programs
  midnight-UTC overclaim although the Decision sections were fixed), one LOW
  (7-vs-8 remediation file count), one NOTE (broken `#contract-freeze` anchor in
  domain.md inherited from base — orchestrator to fix on `main` post-merge);
  round-1 items otherwise RESOLVED and the fresh 15-site citation sample over
  the previously unaudited surface passed in full. Residual fix `21a3370`
  applied directly by the orchestrator (four-line wording + count + round-2
  history entry; disclosed in the handoff) — gates re-verified 1102/1102.
  Review round 3 (focused, candidate `21a3370`): **ACCEPT**. Merged to `main` as
  `59cf254` and post-merge verified (see WP-030 completion record); worktrees and
  branches cleaned up. Wave 0 closeout audit pending.

- `worktree-agent-a45b4929f044830ca` (WP-020): base `4c1d96f`, first candidate `815b6cb`
  (chain `e7844c9`→`815b6cb`). Implementer handoff `docs/handoffs/WP-020.md` (in worktree);
  gates reproduced by orchestrator — 642/642 tests, lockfile purely additive, all 43 files
  in allowed paths. Independent adversarial review round 1 (Codex session
  `01a03d1d-1510-77a0-b6c5-2d8fed838715`, 2026-08-26): **CHANGES REQUIRED** — 0 blocker,
  3 high (hash preimage uses lenient normalizer accepting `+1.5`/`1.`/`.5` contra §7.3;
  same-version optional-field policy incompatible with strict unknown-key schemas —
  must increment per emitted field-set change; `FeedGapDetected.requiresAuthoritativeSnapshot`
  and `FeedResynchronized.authoritativeSnapshotApplied` accept `false` contra the
  gap→snapshot invariant), 4 medium (reference payload `venue` vs envelope `source`
  provenance conflict; `MarketResolved` accepts pending outcomes; contract/registry
  skip runtime schemaVersion validation; `TradingParametersChanged` too narrow for
  fee/delay/negRisk changes), 2 low (overstated recursive-mutation test claim;
  "never collide" wording). Acceptance 1/2/4/5 verified; 3 failed as reviewed.
  Remediation round 1 completed 2026-08-26 in `9790e0a` (separate hash-input grammar
  rejecting §7.3-forbidden forms with unchanged golden digests; version-per-field-set
  policy with evolution tests; gap/resync flags now literal `true`; provenance module
  + samples fix; terminal-outcome subset for MarketResolved with DISPUTED ruled
  non-terminal; runtime schemaVersion validation at both entry points;
  `parameterVersionRef` + `changedParameters` for TradingParametersChanged; recursive
  mutation walker; collision wording fixed; 757/757 tests; lockfile untouched).
  Repair agent was git-isolated from the original worktree (same as WP-000 r3);
  committed on its own branch and the orchestrator fast-forwarded
  `worktree-agent-a45b4929f044830ca` to `9790e0a`; gates reproduced by orchestrator.
  Review round 2 (Codex session `01a03d3b-c5ee-75a3-82ca-92fee192b2b7`, candidate
  `9790e0a` vs `4c1d96f`): **CHANGES REQUIRED** — 0 blocker, 0 high, 3 medium
  (registry `parseEnvelope` never invokes provenance check, so contradictory
  reference envelopes still parse; `assertSchemaVersion` uses `Number.isInteger`,
  admitting unsafe integers that envelope routing rejects; `TradingParameterKindSchema`
  omits open/close-time categories and carries `status` without citation), 1 low
  (handoff evidence overstatements: 12-vs-20 file count, incomplete resync-flag
  negative matrix, imprecise removed-tests claim). All five acceptance criteria
  PASS; round-1 items HIGH-1/2/3, MEDIUM-2, LOW-1/2 resolved; design rulings
  (golden digests, DISPUTED non-terminal, unbranded SchemaVersion,
  `parameterVersionRef`, staying at v1) all judged sound. Review also flagged a
  stale duplicate WP-020 table row in this file — fixed by orchestrator.
  Remediation round 2 completed 2026-08-26 in `8d9596e` (provenance enforced in the
  envelope schema itself via superRefine plus a parseEnvelope structural-bypass
  assert, 12 mismatch combinations tested through the registry;
  `Number.isSafeInteger` with `SchemaVersionSchema` as the single shared range;
  `open_time`/`close_time` added and `status` cited to §10.1 with a per-category
  citation table in domain.md §6.4; handoff precision fixes; 797/797 tests; no
  decimal-package, golden-digest, or lockfile change). Orchestrator fast-forwarded
  the branch to `8d9596e` and reproduced gates. Review round 3 (candidate `8d9596e`
  vs `4c1d96f`): **ACCEPT**. Merged to `main` as `25bc451` and post-merge verified
  (see WP-020 completion record); worktrees and branches cleaned up.

- `worktree-agent-a373c7ba6650bf1a9` (WP-000): base `7faf30f`, first candidate `8d16849`,
  second candidate `f79aa96`. Independent adversarial review round 1 (2026-08-24):
  **CHANGES REQUIRED** (fixture fidelity, rate-limit tiers, position schemas, vacuous
  verification PASS) — remediated in `f79aa96`. Review round 2 (2026-08-24):
  **CHANGES REQUIRED** (raw user-trade schema fidelity vs official SDK, recursive
  nested validation, report-evidence enforcement, canonical-decimal rules, credential
  header names, clob-client-v2 doc conflict, in-repo handoff). Remediation round 2
  completed in `f8ecdbb`; structured handoff record committed as `30e6f47` (branch
  HEAD, third candidate). `docs/handoffs/WP-000.md` ratified into WP-000 allowed
  paths (M4). Orchestrator re-verification (2026-08-26): all 24 changed files vs
  base `7faf30f` inside allowed paths; install/typecheck/lint/test reproduced in
  the worktree at `30e6f47` — 124/124 tests pass; handoff record complete.
  Independent adversarial review round 3 (fresh Codex session `01a03d03-0087-7132-bfaa-644e090779d1`,
  candidate `30e6f47` vs base `7faf30f`, 2026-08-26): **CHANGES REQUIRED** — 0 blocker,
  3 high (per-section report-evidence gate still bypassable by `UNVERIFIED`; several
  contract-bearing nested structures unchecked: fee tables, rate-limit headers/limits,
  position contracts, RTDS subscriptions/optional update fields; stand-in validators
  diverge from frozen SDK schema: empty-string optional decimals, non-integer
  `outcome_index`/`bucket_index`, non-digit epochs, omitted SDK fields), 1 medium
  (price-bound check via `Number()` accepts negative price on float underflow),
  2 low (mutable `blob/main` source URLs untied to pinned SHA; credential scanner
  misses `POLYMARKET_PRIVATE_KEY`/`POLYMARKET_BUILDER_API_KEY`). Round-2 findings
  M2/M3/M4 confirmed resolved; B1/H1/H2/M1 partial or unresolved. Path ownership,
  safety defaults, fixture coverage, and no-credential criteria PASS. Remediation
  round 3 completed 2026-08-26 in `5b98b5e` (per-section citation gate with
  enumerated exemptions; fully typed nested schemas with catalog guards; strict
  SDK-fidelity validators verified verbatim against the pinned commit, adding
  clob/account.ts and clob/order-response.ts sources; lexical price bounds;
  pinned permalinks enforced by validator; credential scanner 57 vectors with
  substring patterns; handoff claims corrected; 235/235 tests, mutation check
  performed). Repair agent was git-isolated from the original worktree, so the
  commit landed on `wp-000-remediation-round3` and the orchestrator fast-forwarded
  `worktree-agent-a373c7ba6650bf1a9` onto it; gates reproduced by orchestrator.
  Venue-fact conflict recorded: review's `POLYMARKET_BUILDER_API_KEY` not found on
  2026-08-26 official pages; verified names are `POLY_BUILDER_API_KEY` and
  `POLYMARKET_BUILDER_CODE` — later corrected in round 4: the migration page DOES
  document `POLYMARKET_BUILDER_API_KEY`/`_SECRET`/`_PASSPHRASE`; `/builders/api-keys`
  currently serves the Place Orders page; `POLY_BUILDER_*` headers live on the relayer
  submit-a-transaction reference. Review round 4 (Codex session
  `01a03d29-c533-7fc3-a180-d6995aa359c8`, candidate `5b98b5e` vs `7faf30f`):
  **CHANGES REQUIRED** — 0 blocker, 1 high (HIGH-2 continuation: `validateObjectSpec`
  skips null/undefined map entries; RTDS `filters` wrongly mandatory vs official TWAP
  docs; `TransactionOutcome.transactionId` and `clobRewards[].endDate` wrongly
  non-nullable vs official docs), 1 medium (round-3 credential reconciliation itself
  wrong: `POLYMARKET_BUILDER_API_KEY` IS on the official migration page; source
  attributions to /builders/api-keys incorrect), 1 low (catalog guard not recursive).
  Round-3 items HIGH-1/HIGH-3/MEDIUM-1/LOW-1/LOW-2 confirmed resolved. Deviation
  judgments: canonicalized fee strings acceptable as normalized data (raw-wire caveat
  required); added SDK sources beneficial; synthetic-completed fixtures must stay
  labeled; mutation-check claim not comprehensive. Remediation round 4 completed
  2026-08-26 in `4505aaf` (whole-map validation with declared nullability; RTDS
  `filters` optional with the wrong negative test replaced; nullable `transactionId`
  and rewards `endDate` per re-fetched official docs; credential citations corrected
  per-name — all four venue facts re-verified independently agreed with the review;
  new scanner gap `POLYMARKET_BUILDER_SECRET` found and fixed; recursive catalog
  guard; 257/257 tests; per-finding mutation checks). Orchestrator fast-forwarded
  the branch and reproduced gates. Repair session disclosed one NEW out-of-scope
  divergence: `clobRewards[].rewardsAmount`/`rewardsDailyRate` modeled as JSON
  number vs official DecimalString — fixed in follow-up `ac85ab6` (round 4b):
  SDK-parsed-layer modeling per the pinned SDK's DecimalishSchema, with the
  market-details page's three-tab type disagreement recorded verbatim in report
  §7.1; deliberate scope extension (`rewardsMinSize` → decimal-string) and
  deliberate relaxation (`assetAddress` narrowing removed per page + SDK) flagged
  for review; `conditionId` narrowing kept and marked. 279/279 tests; orchestrator
  fast-forwarded and reproduced gates. Review round 5 (Codex session
  `01a03d55-0eb7-7780-9ccf-96959244dd25`, candidate `ac85ab6` vs `7faf30f`):
  **CHANGES REQUIRED** — 0 blocker, 1 high (`validateObjectSpec` treats `optional`
  as implying nullable, so `filters: null`, `transactionsHashes: null`,
  `tradeIDs: null`, book `hash: null` all pass undocumented), 2 medium (strict
  reward schema omits official `holdingRewardsEnabled?: boolean|null`; report
  §7.1/§16 outside the per-section citation gate), 1 low (conditionId narrowing —
  accepted as residual for the frozen snapshot). All round-4 items otherwise
  RESOLVED; all round-4b judgment calls ACCEPTED (filters test replacement,
  SDK-parsed reward layer, rewardsMinSize extension, assetAddress relaxation,
  key-required snapshot strictness). Remediation round 5 completed 2026-08-26 in
  `ddc56ff` (null accepted only under explicit `nullable: true` — exactly four
  cited nullable fields enforced by a recursive walker guard; `tradeIDs`/
  `transactionsHashes` null-acceptance reclassified as defects vs the SDK's
  `.default([])`; book-`hash` null rejection recorded as fixture-only narrowing in
  new report §17; `holdingRewardsEnabled` modeled per official type with full
  MarketRewards key-by-key re-audit; citation gate completed across ALL report
  sections with §10/§15 as enumerated exemptions and the test's private section
  list deleted; 307/307 tests; per-finding mutation checks). Orchestrator
  fast-forwarded and reproduced gates. Review round 6 (candidate `ddc56ff` vs
  `7faf30f`): **ACCEPT**. Merged to `main` as `d427f00` and post-merge verified
  (see WP-000 completion record); worktrees and branches cleaned up.

### WP-000 in-flight record (2026-08-24)

- Path compliance, protected paths, safety defaults: verified clean by orchestrator and reviewer.
- Automated gates (install/typecheck/lint/test) pass on candidate `8d16849`, but the
  review found the fixture content itself does not faithfully match official venue
  contracts; acceptance is therefore not met and the package remains open.

## Accepted evidence

- WP-010 automated gate: install/typecheck/lint/test pass on `main` at `12ce0ab` (2026-08-22), reproduced independently by the adversarial reviewer at `1bca7cf`.

## Open blockers

None.

### Cross-package risk (recorded 2026-09-03): a schema parse output is not clean data

**Discovered by WP-180's round-6 mechanical census; independently confirmed by the
orchestrator against the pinned `zod` (4.4.3), and endorsed by WP-180's review round 7
as "not WP-180-specific".** Two measured behaviours:

- **Adoption.** An object whose own keys are `['a']`, with `b` on its prototype, parses
  through `z.object({a, b?})` to `{"a":"x","b":"inherited"}` — the validated output
  contains a field that was never in the input.
- **Loss.** A get-only inherited accessor makes the library's own output assignment fail,
  so a field present in the input is ABSENT from the validated output.
- **Defaults defeated (added 2026-09-03, orchestrator-confirmed — the most dangerous of the
  three).** The same single get-only inherited accessor also defeats a schema's OWN
  `.default()`: `z.object({a, flag: z.boolean().default(true)})` parsing `{a:"x"}` normally
  yields an own `flag: true`, but with `flag` defined as a get-only accessor on
  `Object.prototype` the parse still SUCCEEDS while `flag` never lands in the output as an
  own property. Any check gated on a defaulted setting being present therefore SKIPS.
  WP-180's round-7 remediation measured three LIVE fail-opens from exactly this at its own
  reviewed tip, with no hostile input beyond that one accessor:
  `requireVerifiedSettlementForEntries` → §9.8 check 6 skipped, an unverified settlement
  APPROVED; `requirePositiveNetEdgeForEntries` → check 12 skipped, a negative net edge
  APPROVED; and **`maxRunMode` → check 2 gone, so LIVE no longer exceeded the maximum** —
  a run-mode ceiling silently ceasing to be enforced.

So a successful parse guarantees neither that the output matches the input nor that it is
free of ambient prototype state. Any code that treats a parse result as trustworthy data —
the near-universal assumption — is relying on something the library does not provide.

**Scope.** WP-180 fixes its own paths (materialize prototype-free BEFORE parsing; take the
value from the materialized tree rather than the library's constructed output). **Every other
caller-input schema boundary in the repository needs the same audit.** Known parsing surfaces
include `packages/domain` (the frozen event/intent schemas every package parses through),
WP-200's `packages/ledger` and `packages/pnl` (**merged** at `7e75f9a` — its records are
parsed from caller-supplied values), WP-170's `packages/strategy-runtime`, and every adapter
that parses venue payloads.

- **Format checks disabled wholesale (added 2026-09-03, orchestrator-confirmed — the most
  severe of the four).** `zod` reads its parse-context flags through the prototype chain, so a
  single inherited `Object.prototype.skipChecks = true` turns **EVERY format check in EVERY
  schema into a no-op**. Measured directly: `z.object({id: z.string().uuid(), when:
  z.string().datetime()})` refuses `{id:"not-a-uuid", when:"definitely-not-a-timestamp"}`
  normally, and ACCEPTS it with that one inherited property present. This is not scoped to one
  package — it applies at **any** `zod` boundary in the repository, including `packages/domain`'s
  frozen schemas that every package parses through.
- **Descriptor literals (added 2026-09-03).** A property descriptor written as an object literal
  is itself read through the prototype chain, so an inherited `get` makes every
  `Object.defineProperty` throw `TypeError`. In WP-180 that escaped `evaluateIntent` as a throw,
  because building a refusal defines properties. **Every other `Object.defineProperty` in the
  repository still passes an ordinary descriptor literal** (WP-180 follow-up R8-1).

**The audit question is therefore broader than "did my fields survive?" — it is "is any of
this value the library's rather than mine?", which covers adopted fields, dropped fields,
defaults, format checks, and descriptor literals. A safety-relevant setting expressed as a
schema default is a sharp case; wholesale disablement of format validation via an inherited
context flag is sharper still, and reaches every merged package.**

**Owner: contract owner, as a bounded governance round** (it spans packages no single work
package owns, and the remedy may belong in a contract rule rather than in each package).
Not a blocker for WP-180 or WP-170 once their local paths are correct. **Not yet audited:**
whether any merged package is presently exploitable — WP-200 in particular should be checked
before it is relied on, since it is already on `main`.

## Deviations from specification

- Root `eslint.config.mjs` was outside WP-010's literal `allowed_paths`; ratified into WP-010 ownership (see completion record).
- Node 24 pin is `engines: ">=24"` + CI `node-version: 24` + runtime smoke assertion, not an exact `.nvmrc` pin; acceptable for WP-010, tighten later if needed.
- WP-000 verification report filename: workplan literally names `docs/venue/verified-2026-08-18.md` (plan-generation date), but handoff §1.2 requires `verified-YYYY-MM-DD.md` dated to the actual verification. **Ratified by orchestrator 2026-08-24**: the report is `docs/venue/verified-2026-08-24.md`; the workplan literal is treated as a template dated at plan generation. Flagged by independent review (M2) as requiring explicit ratification — recorded here.

## Pending external evidence

- `.github/workflows/ci.yml`: YAML-validated only — a real GitHub Actions run is pending.

## Resolved evidence items

- `docker-compose.yml` runtime validation (2026-08-22): Docker 29.1.2 / Compose v2.40.3 became available; `docker compose config` valid, `docker compose up -d --wait` brought both services to healthy (`pg_isready` accepting connections, `redis-cli ping` → PONG), both ports confirmed bound to 127.0.0.1 only. Host ports made overridable (`PMB_POSTGRES_PORT`, `PMB_REDIS_PORT`, defaults 5432/6379 unchanged) because this machine has a native PostgreSQL on 5432; validated with `PMB_POSTGRES_PORT=15432`. Stack torn down after verification.

## Human and operational gates

- Execution-probe gate: Not requested
- Live-micro gate: Not requested
- Live gate: Not requested
- Time-based soak evidence: None
