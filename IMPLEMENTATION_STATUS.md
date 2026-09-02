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
| `WP-140`               | IN_REVIEW (candidate `860436c`) | All ✓ | Impl `9b9173a` (+ doc `860436c`) on base `77521f3`, branch `worktree-agent-ac72fe93bf1988ee1` (one session-limit interruption resumed). Four deliverables with ZERO new dependencies (lockfile untouched; graph unchanged 34/24): (1) pure layer-1 metrics exporter — the dependency contract forbids observability→apps edges, so it declares STRUCTURAL MIRRORS of GatewayMetrics/ResearchWorkerMetrics with drift caught by a compile-time assignability pin in the soak tree (where both sides are reachable); a 120-family canonical table is the single source of truth (renderer refuses unlisted samples; every family reachability-tested); null-able producer fields OMITTED, never rendered as 0; plus the WP-130 finding-class registry (drift-tested against the actual validate.py source), the book snapshot comparator, and the fail-closed soak-evidence schema; (2) dashboard (24 panels) + 16 alert rules AS CODE with acceptance 1 MACHINE-CHECKED (every referenced series emitted; all six categories panel-bound; the WP-120-obligated charts and alarms exist by name; the failed-to-exit alarm honestly documented as log-based, pinned); (3) soak harness running the REAL gateway bundle (loopback-only) writing per-window evidence records with duration first-class and NO status field — status exists only as the output of a fail-closed evaluator (malformed/contradictory/future-dated records poison to INVALID; windows never sum; SATISFIED needs ONE contiguous real window ≥24h with recording demonstrated, clean shutdown, zero unexplained gaps); PENDING is machine-visible in soak-status.json/.prom; (4) snapshot comparison job (ADR-013 absolute-size deltas, canonical decimal strings, per-token per-epoch, never mixing epochs) + the recorder runbook (bidirectional exit contract, forced-exit signals verbatim, restart procedure folded in, fsync-as-data-loss-bound closing the WP-120 owed item, validator classes as operational signals, the real-soak procedure). Status per runbook 1F exactly: Implementation complete; Automated checks complete; External time-based evidence PENDING. Orchestrator reproduced gates: root 122/3422 (+93/+5 all from this package), both typechecks, check:deps unchanged, soak smoke 3/3 (real bundle ~7s), evaluate → machine-readable PENDING, compare-books 3/3 fixture posture, 30 files zero out-of-path. 7 disclosed deviations (no HTTP endpoint served yet — the exporter is pure, wiring is a follow-up to the apps owner; the restart procedure subsumed not moved; an internal minimal decimal comparator instead of an out-of-grant dependency edit; the recorder module not re-exported from the out-of-grant barrel; non-workspace soak-tree scripts; vitest-without-local-devDep hygiene; jobs as vitest specs). Assumption flagged for orchestrator ruling: the 24h soak threshold and no-window-summing rule (nothing in the docs states a duration). Review round 1 (strict; Codex `01a06141-5bd4-7293-bb58-f4ea0da48be1`): **CHANGES REQUIRED — the run's first BLOCKER, exactly where the review was aimed**: the evaluator manufactured SATISFIED from an unauthenticated hand-written 25h evidence file (field shapes validated but neither provenance nor exact keys; `cleanShutdown:true` trusted without code===0/signal null/shutdownLogSeen — a contradictory record with code 2 + SIGKILL still reached SATISFIED; unknown keys incl. a smuggled `status` accepted), disproving four in-repo claims (handoff, runbook, dashboard, metric help-text); the status-ARTIFACT tamper protection is sound (the job overwrites it) but the input domain is untrusted; required: separate structural qualification from external completion — repository-controlled JSON may yield at most a candidate/pending-external-review result (the gate itself closes only as a governance act), exact-key rejection, full exit/observation consistency relations, and every doc/metric/dashboard surface updated so synthetic input can never represent final satisfaction. 3 MEDIUM: M-1 the alert-name drift test uses substring matching (RecorderExited→RecorderExitedRenamed passed 14/14) — anchor/parse exactly; M-2 the soak WAL reader mixes epochs (a frame declaring epoch-B inside epoch-A/ was admitted; directory/header/frame/footer identities must agree, mismatches refused); M-3 the before-the-admission-bound alarm claim is unenforceable at a 5s threshold + 15s scrape + for:1m (a 1024-entry queue can fill first) — implement a predictive in-process signal or obtain authority to restate as best-effort with the in-process terminal halt as the actual guarantee. PASSING: acceptance-1 core coverage (unknown-family and category-deletion mutations fail properly), structural mirrors (TS2741 names the mutated field), renderer (refusals, null-omission, HELP/TYPE), book arithmetic (absolute replace, zero deletes, named divergence; canonicalization intentional), runbook wording/substrings/drift-test, safety sweep; all seven deviation boundaries ACCEPTED; no evidence file committed; the three-line status honest as current state. Remediation round 1 dispatched 2026-09-02. **Remediation round 1 completed** in `9e009de` (+ doc `4d0d163`), fresh repair session, all five reviewer probes reproduced first: BLOCKER → soak-evidence schema v2: verdict lattice exactly INVALID/PENDING/QUALIFYING_WINDOW_FOUND (best state a named CANDIDATE; no repo-controlled input can produce anything presentable as final satisfaction; gate closure documented as a governance act in IMPLEMENTATION_STATUS after out-of-band provenance review); `SATISFIED` erased from evaluator, artifacts, prom label domain, help texts, dashboard, alerts, runbook, handoff (orchestrator grep-verified zero occurrences outside tests); exact-key rejection at every level (a smuggled `status` names the key); free-standing derived booleans REMOVED from the schema (cleanShutdown → primitive shutdownRequested with cleanliness derived; unexplainedGapSignals → primitive gapIncidents) with NINE consistency relations poisoning contradictions to INVALID (racy-but-legitimate cases deliberately not made relations to avoid false INVALIDs); trust-domain statement in module header/runbook/handoff; the reviewer's matrix permanent + mutation-checked; re-probe: the original forged file → INVALID naming the smuggled key; the strongest v2-consistent forgery → QUALIFYING_WINDOW_FOUND with the caveat in the artifact. M-1 → alert declarations parsed, exact set equality both directions (the rename fails as missing AND unexpected); M-2 → directory/header/frame/footer epoch agreement with `epochIdentityRefusals` (unproven header refuses the segment whole); M-3 → best-effort wording under granted authority with the in-process halt stated as the enforced guarantee, test pins the honest wording and REJECTS "before the bound"; +1 optional apps-owner follow-up (in-process queue-growth early warning). Honest residual stated: a forged-but-internally-consistent record reaches the candidate state BY DESIGN — provenance is the human step; no code can prevent an operator skipping the procedure. Orchestrator verified scope (16 files, zero out-of-path; lockfile untouched) and reproduced gates: root 122/3446 (+24), both typechecks, check:deps 34/24, soak:evaluate → honest PENDING; canonical fast-forwarded to `4d0d163`; worktree cleaned up. Review round 2 dispatched 2026-09-02 |
| `WP-150`               | Released by GOV-1B (ADR-013 replace-not-accumulate); Wave 2 per runbook — do not start before the Wave 1 closeout gate | All ✓ | — |
| `WP-260`               | Dependency-ready; DEFERRED to Wave 3 by wave ordering and signer-boundary safety | All ✓ | — |
| All other packages     | Blocked  | See work plan      | —          |

Authorization vocabulary: "Ready (authorized)" rows are the only packages agents
may begin in the current run; "Dependency-ready" rows must not start until this
table says otherwise.

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
