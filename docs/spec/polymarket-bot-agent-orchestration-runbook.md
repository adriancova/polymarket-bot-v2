# Polymarket Bot — Human Operator Runbook for Claude Code + Codex CLI

**Purpose:** A repeatable process for implementing, reviewing, merging, and graduating the work packages in `docs/spec/polymarket-bot-workplan.yaml`.

**Primary roles**

- **You:** human release manager and approval authority.
- **Claude Code:** implementation orchestrator and coding subagents.
- **Codex CLI:** independent, preferably read-only, adversarial reviewer.
- **Git + CI:** durable source of truth and mechanical acceptance gate.

The agent conversation is disposable. The repository is the memory.

---

## 1. First correction: where you are now

`WP-010` being merged does **not** mean Wave 0 is complete.

Wave 0 contains:

1. `WP-000` — Venue verification and sanitized fixtures
2. `WP-010` — Monorepo, CI, compose, and quality gates
3. `WP-020` — Domain contracts and exact decimal types
4. `WP-030` — Initial ADR and contract documentation

Current state:

- `WP-010`: implemented and merged
- `WP-000`: ready
- `WP-020`: ready because `WP-010` is merged
- `WP-030`: blocked until `WP-000` and `WP-020` are accepted and merged

Because `WP-010` was merged before an independent Codex review, perform a **post-merge audit now**. This is an exception. For all future packages, review the candidate commit **before** merging it.

---

## 2. Context policy

Use a fresh top-level context for each bounded responsibility.

### Recommended

- **Fresh Claude Code session per work package**, or per explicitly approved batch of independent packages.
- **Fresh Codex CLI session per candidate commit or re-review.**
- **Fresh integration-review session at the end of each wave.**
- Use `IMPLEMENTATION_STATUS.md`, committed task packets, commit SHAs, test output, and review reports as durable state.

### Avoid

- One Claude conversation spanning the entire project.
- One Codex conversation reviewing many unrelated packages.
- Asking the same agent that wrote a package to provide its final independent acceptance.
- Relying on an agent to remember a prior session instead of reading current repository state.

### Exception

For a very small correction inside the same unmerged work package, continuing the existing Claude session is acceptable. A fresh repair session is still preferred when the original context is long or noisy.

---

## 3. Standard lifecycle for every work package

Use this workflow unless a package explicitly requires external evidence or human approval.

### Step 1 — Preflight

From the main repository:

```bash
git checkout main
git pull --ff-only
git status --short
git log --oneline --decorate -8
```

Requirements:

- Working tree is clean.
- Dependencies in the YAML are merged.
- No other active package owns overlapping paths.
- `IMPLEMENTATION_STATUS.md` is current.
- Maximum run mode and safety defaults remain unchanged.

### Step 2 — Start a fresh Claude Code session

Authorize exactly one work package, or a named set of genuinely independent packages.

Claude must:

1. Read `CLAUDE.md`, `AGENTS.md`, the implementation handoff, YAML work plan, and status file.
2. Verify dependencies and allowed/forbidden paths.
3. Render a complete work-package task packet.
4. Delegate implementation to the appropriate worktree-isolated subagent.
5. Require tests, a commit, and the structured handoff.
6. Stop before merging.

### Step 3 — Inspect Claude's candidate

Record:

- Work-package ID
- Candidate branch
- Commit SHA
- Base SHA
- Files changed
- Tests run
- Assumptions
- Deviations
- Known risks

Do not review only the prose handoff. Inspect the actual Git diff.

### Step 4 — Start a fresh Codex review session

Codex should be read-only and review:

- Candidate commit versus its base
- Task packet
- YAML acceptance criteria
- Relevant handoff invariants
- Tests and failure cases
- Path ownership
- Security and live-mode defaults

Codex returns findings by severity:

- `BLOCKER`
- `HIGH`
- `MEDIUM`
- `LOW`
- `NOTE`

A package cannot be accepted with unresolved `BLOCKER`, `HIGH`, or `MEDIUM` findings.

### Step 5 — Remediation loop

When findings exist:

1. Keep the package unmerged.
2. Start a fresh Claude repair session on the same branch/worktree, or create a dedicated fix branch.
3. Give Claude only:
   - exact package,
   - exact commit,
   - Codex review report,
   - allowed paths,
   - unresolved findings.
4. Require new tests and a new commit.
5. Start a fresh Codex re-review.
6. Repeat until accepted.

Codex remains reviewer-only. Claude remains implementer.

### Step 6 — Human merge decision

Before merging, verify:

```bash
git diff --stat <base-sha>..<candidate-sha>
git diff --name-only <base-sha>..<candidate-sha>
```

Confirm:

- Acceptance criteria pass.
- Review findings are resolved or explicitly accepted as low-risk.
- No protected or forbidden paths changed unexpectedly.
- No credentials or live-enablement changes exist.
- Handoff and status data are complete.

Then merge.

### Step 7 — Post-merge integration check

On `main`:

```bash
git checkout main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

Also run the relevant package-specific integration commands.

### Step 8 — Update durable state

Update and commit `IMPLEMENTATION_STATUS.md` with:

- Package state: merged and verified
- Merge SHA
- Review report reference
- Tests run
- Deviations
- Newly unblocked packages
- Evidence still pending
- Current maximum run mode

### Step 9 — Close contexts

End the Claude and Codex sessions. Begin the next package from a fresh context.

---

## 4. Immediate action: audit the already-merged WP-010

### 4.1 Identify the commit

If `WP-010` is the latest merge:

```bash
git checkout main
git status --short
git log --oneline --decorate -10
git rev-parse HEAD
git rev-parse HEAD^1
```

Record:

```text
WP010_MERGE_SHA=<HEAD>
WP010_BASE_SHA=<HEAD^1>
```

If Claude used a squash or fast-forward merge, identify the exact first and last commit belonging to `WP-010` from the log.

### 4.2 Run a fresh Codex review

Use the prompt in section 11.2 and tell Codex this is a **post-merge audit**.

### 4.3 Handle the result

- No material findings: mark `WP-010` verified.
- Findings: create `fix/wp-010-review`, run a fresh Claude repair session, re-review with a fresh Codex session, then merge the fix.

Do not rewrite published history unless the repository is private, unshared, and you intentionally choose to do so. A normal corrective commit is simpler.

---

# 5. Wave 0 — Foundations

## Goal

Freeze repository foundations, current venue facts, domain contracts, and ADRs before broad parallel implementation.

## Recommended order

### 0A — Finish `WP-010` verification

Perform the post-merge Codex audit described above.

### 0B — `WP-000`: Venue verification and sanitized fixtures

**Claude:** fresh session using `venue-verifier`  
**Codex:** fresh review session  
**Merge only after:** current official behavior is documented, fixtures are sanitized, and no real order or signer was used.

This package is intentionally evidence-oriented. Conflicts between the handoff and current official venue behavior must be surfaced, not silently patched.

### 0C — `WP-020`: Domain contracts and exact decimals

Run after `WP-010`.

**Claude:** fresh session using `wp-implementer`  
**Codex:** fresh review with special attention to:

- no JavaScript `number` for economic fields,
- canonical decimal hashing,
- scientific notation rejection,
- event envelope ordering fields,
- `DecisionResult` with zero or more intents,
- package-boundary leakage.

`WP-020` is a protected foundation. Do not begin broad consumer implementation before it is accepted.

### 0D — `WP-030`: Initial ADR and contract documentation

Run only after `WP-000` and `WP-020` are accepted and merged.

This is a **review-gated** package. Review ADRs for consistency with:

- verified venue facts,
- locked architecture,
- implemented domain contracts,
- database and package boundaries planned for later waves.

### Wave 0 closeout

Start a fresh integration-review context and verify:

- All four packages are merged and reviewed.
- Full repository CI passes.
- `IMPLEMENTATION_STATUS.md` is accurate.
- Venue conflicts are captured in ADRs or tracked blockers.
- Domain contracts are considered frozen for Wave 1.
- Run mode remains `PAPER`.
- No signer or real credentials exist.

Only then begin Wave 1.

---

# 6. Wave 1 — Recording platform

## Packages

- `WP-040` PostgreSQL schemas and migrations
- `WP-050` WAL, segment manifests, and crash recovery
- `WP-060` Redis Streams event transport
- `WP-070` Polymarket public market-data adapter
- `WP-080` Binance reference adapter
- `WP-090` Coinbase reference adapter
- `WP-100` Polymarket RTDS Chainlink TWAP adapter
- `WP-110` Universe and settlement specifications
- `WP-120` Data gateway integration
- `WP-130` Parquet compactor and dataset manifests
- `WP-140` Recorder observability and soak harness

## Recommended execution batches

### 1A — Storage and transport foundations

After Wave 0:

- `WP-040`
- `WP-050`
- `WP-060`

These paths should be distinct, but begin with no more than two simultaneous Claude implementation sessions until the parallel workflow is proven.

Each package gets its own branch/worktree, handoff, Codex review, and merge.

### 1B — Public feed adapters

After contracts are frozen:

- `WP-070`
- `WP-080`
- `WP-090`
- `WP-100`

These are good candidates for parallel implementation because they are adapter-focused and should consume stable contracts rather than edit them.

Do not run four merely because four are allowed. Two or three concurrent agents are easier to supervise.

### 1C — Universe and settlement semantics

Run `WP-110` after `WP-040` and `WP-000`.

Give this package a particularly strict Codex review. Settlement rules, TWAP semantics, rule versions, and market eligibility are financially load-bearing.

### 1D — Parquet compactor

Run `WP-130` after `WP-040` and `WP-050`.

This can proceed while remaining adapters are being completed if path ownership is clean.

### 1E — Gateway integration

Run `WP-120` only when `WP-050`, `WP-060`, `WP-070`, `WP-080`, `WP-090`, `WP-100`, and `WP-110` are all accepted and merged.

This package is an integration point. Use a fresh Claude context and a fresh Codex review focused on:

- event ordering,
- raw-frame traceability,
- bounded backpressure,
- no silent drops,
- restart and resubscription behavior,
- data freshness.

### 1F — Recorder observability and soak harness

Run `WP-140` after `WP-120` and `WP-130`.

The code and harness can be completed, but the elapsed soak evidence cannot be manufactured. Mark the package:

```text
Implementation: complete
Automated checks: complete
External time-based evidence: pending
```

Deploy the recorder only after its implementation review passes. Let the evidence accumulate while Wave 2 development proceeds, but do not falsely mark the external-evidence gate complete.

### Wave 1 closeout

Verify:

- Gateway can record all configured sources.
- Raw WAL recovery works.
- Parquet manifests and checksums reproduce datasets.
- Book reconstruction is checked against snapshots.
- Gaps and staleness are visible.
- Recorder can run independently of trading deployments.
- External soak evidence is either complete or explicitly pending.
- No trading path exists yet.

---

# 7. Wave 2 — Deterministic paper core

## Packages

- `WP-150` Local exact-decimal order books
- `WP-160` Versioned feature engine
- `WP-170` Strategy SDK and deterministic runtime
- `WP-180` Capital allocator and scenario risk
- `WP-190` Execution planner contracts and paper implementation
- `WP-200` Append-only ledger, allocations, positions, and PnL
- `WP-210` Replay clock, event source, simulated venue, and fill models
- `WP-220` Static Bracket strategy
- `WP-230` Paper trader integration
- `WP-240` Control API and paper dashboards
- `WP-250` Determinism and paper end-to-end verification

## Recommended execution batches

### 2A — Parallel core modules

Once dependencies are ready, these are reasonable parallel candidates:

- `WP-150`
- `WP-170`
- `WP-180`
- `WP-200`

Use separate worktrees. Do not let any package modify protected domain contracts to simplify its implementation.

### 2B — Derived modules

- `WP-160` after `WP-150`, `WP-080`, `WP-090`, and `WP-100`
- `WP-190` after `WP-180`

These can run in parallel if paths do not overlap.

### 2C — Simulator and replay

Run `WP-210` after `WP-130`, `WP-150`, `WP-190`, and `WP-200`.

Review carefully for:

- deterministic event ordering,
- replay-clock purity,
- no direct wall-clock reads,
- exact arithmetic,
- explicit fill-model version,
- no claim that paper fills validate real maker fills.

### 2D — First strategy

Run `WP-220` after `WP-160`, `WP-170`, and `WP-210`.

The Static Bracket strategy is the first complete consumer of the pipeline. Keep scope narrow; do not add momentum or market making here.

### 2E — Paper trader integration

Run `WP-230` only after all listed dependencies are merged.

This is the first full paper-trading system. Use a fresh implementation context and a fresh Codex review.

### 2F — Control surfaces

Run `WP-240` after `WP-230`.

Ensure paper-only controls remain explicit and that no UI or API can bypass run-mode restrictions.

### 2G — Determinism and paper E2E

Run `WP-250` last.

This package has a review gate. It must prove:

- traceability from input through decisions, plans, simulated orders, fills, ledger, and PnL,
- deterministic replay,
- zero unexplained projection differences in fixtures.

Time-based paper evidence remains pending until actually observed.

### Wave 2 closeout

Verify:

- Full paper pipeline works end to end.
- Replaying the same dataset produces identical results.
- Ledger rebuild equals incremental projections.
- Static Bracket runs in replay and live-data paper mode through the same code.
- Dashboards expose decisions, risk vetoes, simulated fills, and PnL.
- No real signer is installed.
- Maximum run mode remains `PAPER`.

At this point, the system can begin accumulating meaningful live-data paper evidence.

---

# 8. Wave 3 — Live-micro infrastructure, still PAPER-only

## Packages

- `WP-260` Secure unified-SDK adapter and signer boundary
- `WP-270` OMS and signed-order persistence
- `WP-280` Authenticated user-stream adapter
- `WP-290` Account reconciliation
- `WP-300` Collateral inventory and wallet operations
- `WP-310` Rate-limit budgets and matching-engine modes
- `WP-320` Heartbeat health lease, fencing, geoblock, and kill controls
- `WP-330` Independent emergency operations CLI
- `WP-340` Live-micro fault-injection verification

## Critical rule

Completing Wave 3 does **not** authorize live trading. The infrastructure is built and tested with fixtures, mocks, and fault injection while the maximum operational mode remains `PAPER`.

Do not provide a production signer simply because the secure adapter exists.

## Recommended order

### 3A — Secure adapter

Run `WP-260` first.

This package requires a dedicated security review. Verify:

- only the secure package imports secure SDK entry points,
- secrets and signatures are redacted,
- ordinary tests need no live credentials,
- signer boundaries cannot be crossed from paper mode.

### 3B — OMS

Run `WP-270` after `WP-260`, `WP-190`, and `WP-200`.

Do not parallelize this casually with changes to the secure adapter. The signed-order idempotency and unknown-submission state machine are central.

### 3C — User stream, inventory, and rate limits

After prerequisites:

- `WP-280`
- `WP-300`
- `WP-310`

At most two concurrent implementations are recommended because these packages all interact conceptually with account truth and execution safety.

### 3D — Reconciliation

Run `WP-290` after `WP-280`.

Review unknown orders, missing user-stream events, startup recovery, actual versus virtual state, and fail-closed behavior.

### 3E — Heartbeat, fencing, geoblock, and kill controls

Run `WP-320` after `WP-290` and `WP-310`.

This requires a security review. Verify:

- two writers cannot both hold authority,
- unhealthy-but-running processes stop heartbeats,
- ambiguous geoblock results block live entries,
- paper mode cannot acquire live fencing.

### 3F — Independent emergency CLI

Run `WP-330` after `WP-320`.

This also requires a security review. It must operate independently from trader state, be audited, and require confirmation for destructive operations.

### 3G — Fault injection

Run `WP-340` last.

This is a review-gated package. Test:

- crash during submission,
- lost response,
- lost user-stream messages,
- partial fills,
- reconciliation,
- heartbeat failure,
- duplicate-exposure prevention,
- zero live defaults.

### Wave 3 closeout

Verify:

- All security reviews are resolved.
- Fault-injection suite passes.
- Independent cancel path works against mocks/fixtures.
- No live caps have been raised.
- No production signer is mounted.
- Maximum run mode remains `PAPER`.

---

# 9. Wave 4 and Phase 5 — Execution probes, calibration, and live-micro gate

## Packages

- `WP-350` Execution-probe planner and hard caps
- `WP-360` Fill, slippage, cancel, and markout calibration pipeline
- `WP-370` Live-micro promotion report and gate

These are not ordinary unattended coding tasks. They contain human-approval and external-evidence gates.

## 4A — `WP-350`: Probe planner and hard caps

Claude implements the planner and safety controls. Codex reviews them.

After code review, the package remains operationally disabled until **you** explicitly approve non-zero execution-probe caps.

A coding agent must not approve its own probe.

## 4B — Human pre-probe checklist

Before allowing any real probe:

- Confirm legal and geographic eligibility.
- Review current official venue behavior.
- Create a dedicated low-balance account or bounded signer configuration.
- Set extremely small hard caps.
- Confirm emergency cancel works.
- Confirm heartbeat, fencing, reconciliation, and alerts.
- Back up configuration and record the approval.
- Start with one probe type and one market series.
- Keep normal live strategies impossible to start.

## 4C — Run execution probes

Execution probes are real orders used only to calibrate:

- placement and acknowledgement latency,
- cancellation behavior,
- partial fills,
- maker fill probability,
- queue estimates,
- slippage,
- adverse markouts.

This is operational evidence, not something an agent can truthfully simulate.

## 4D — `WP-360`: Calibration pipeline

The implementation can be reviewed normally, but the gate needs actual evidence.

Acceptance must preserve:

- paper fills are not actual fills,
- markout is diagnostic unless used in a separately reported stress model,
- calibration artifacts are versioned and reproducible.

## 4E — `WP-370`: Live-micro promotion report

This belongs to Phase 5 and requires human approval.

The report must include:

- effective sample size,
- regime coverage,
- predicted versus actual execution,
- core PnL separately from rebates/rewards,
- zero unresolved account discrepancies,
- outstanding risks and evidence gaps.

Only you may approve changing the maximum mode to `LIVE_MICRO`.

### After promotion

A live-micro period is an operational phase, not a blanket coding authorization. Every defect found during live-micro becomes a bounded repair package and repeats:

```text
Claude implementation → Codex review → human merge → evidence collection
```

Do not graduate to normal live allocation through an agent-only decision.

---

# 10. Wave closeout procedure

At the end of every wave, start a fresh review context with no implementation authorization.

Ask it to:

1. Read the handoff, YAML, status file, and all package handoffs in the wave.
2. Build a dependency and acceptance matrix.
3. Verify every merge SHA.
4. Run full CI and relevant integration/fault suites.
5. Check unresolved review findings.
6. Check protected-path and architecture drift.
7. Confirm evidence-gated items are not falsely marked complete.
8. Confirm current maximum run mode.
9. Produce a wave-closeout report.
10. List the exact packages now unblocked.

Preferably use Codex for the first wave-level audit and Claude for a second architectural consistency pass, or reverse the roles. Neither should modify code during closeout.

---

# 11. Reusable prompts

## 11.1 Claude implementation prompt

```text
Act as the implementation orchestrator for exactly <WP-ID>.

Start from a fresh context. Read completely:

- CLAUDE.md
- AGENTS.md
- docs/spec/polymarket-bot-orchestrator-handoff.md
- docs/spec/polymarket-bot-workplan.yaml
- IMPLEMENTATION_STATUS.md

Inspect Git status and recent commits.

Only <WP-ID> is authorized. Do not begin any other package.

1. Verify dependencies are merged and the working tree is clean.
2. Extract the exact goal, allowed paths, forbidden paths, deliverables,
   acceptance criteria, and gate for <WP-ID>.
3. Check for active path-ownership conflicts.
4. Produce a complete task packet.
5. Delegate implementation to the appropriate project-scoped worktree-isolated
   subagent.
6. Require tests, a commit, and the complete handoff:
   summary, files changed, tests run, assumptions, deviations, known risks,
   follow-up, and commit SHA.
7. Review the returned diff and test evidence.
8. Do not merge.
9. Present the candidate branch, base SHA, candidate SHA, acceptance matrix,
   deviations, and exact command needed for independent review.
10. Keep all live-order defaults unchanged and do not request credentials.
```

## 11.2 Codex review prompt

```text
Perform an independent, read-only adversarial review of <WP-ID>.

Read:

- AGENTS.md
- docs/spec/polymarket-bot-orchestrator-handoff.md
- docs/spec/polymarket-bot-workplan.yaml
- IMPLEMENTATION_STATUS.md
- the <WP-ID> task packet and implementer handoff, if present

Review candidate commit <CANDIDATE-SHA> against base <BASE-SHA>.

Do not modify files and do not create a fix.

Verify:

1. Every acceptance criterion.
2. Allowed, forbidden, and protected paths.
3. Architecture and dependency-direction invariants.
4. Tests, including whether they exercise the central behavior and failures.
5. Exact-decimal rules and deterministic behavior where applicable.
6. Security, credential, signer, and run-mode defaults.
7. Whether the handoff accurately reports assumptions and deviations.
8. Whether implementation claims rely on evidence that did not actually occur.

Run safe read-only inspection and test commands as needed.

Return:

- Verdict: ACCEPT / CHANGES REQUIRED
- Findings grouped as BLOCKER, HIGH, MEDIUM, LOW, NOTE
- File and symbol references
- Failed or unproven acceptance criteria
- Missing tests
- Required remediation
- Commands run and results
```

## 11.3 Claude remediation prompt

```text
Repair only the unresolved findings for <WP-ID> on branch <BRANCH>.

Read the original task packet, implementer handoff, and Codex review report.
Do not broaden scope or redesign adjacent modules.

For each finding:

1. Confirm it against the current code.
2. Implement the smallest correct fix within the package's allowed paths.
3. Add or strengthen tests that would have caught it.
4. Run the full package acceptance suite.
5. Commit the repair.
6. Return a finding-by-finding resolution matrix and new commit SHA.

Do not merge and do not begin another package.
```

## 11.4 Wave closeout prompt

```text
Perform a read-only closeout audit for Wave <N>.

Read the implementation handoff, YAML work plan, status file, all wave package
handoffs, review reports, and Git history.

Do not edit code.

Produce:

- package-by-package acceptance matrix,
- merge SHA verification,
- unresolved findings,
- full CI and integration results,
- architecture drift findings,
- external/human evidence still pending,
- current run-mode verification,
- exact list of newly unblocked packages,
- verdict: WAVE COMPLETE / WAVE INCOMPLETE.
```

---

# 12. Recommended status values

Use a small controlled vocabulary in `IMPLEMENTATION_STATUS.md`:

```text
BLOCKED
READY
IN_PROGRESS
IMPLEMENTED
IN_REVIEW
CHANGES_REQUESTED
ACCEPTED
MERGED
VERIFIED
EVIDENCE_PENDING
COMPLETE
```

Suggested interpretation:

- `IMPLEMENTED`: Claude returned a commit and handoff.
- `IN_REVIEW`: Codex is reviewing.
- `ACCEPTED`: independent review has no unresolved material findings.
- `MERGED`: commit is on `main`, but post-merge integration has not yet passed.
- `VERIFIED`: post-merge CI/integration passed.
- `EVIDENCE_PENDING`: implementation is done, but real elapsed or operational evidence is incomplete.
- `COMPLETE`: all automated, review, external, and human gates for that package are satisfied.

---

# 13. Practical parallelism rule

Use parallel implementation only when all of these are true:

1. Dependencies are merged.
2. Allowed paths do not overlap.
3. Neither package changes protected shared contracts.
4. The packages do not define both sides of the same interface.
5. Each has its own worktree and branch.
6. You can review the resulting diffs separately.
7. Integration order is known.

Recommended limits:

- Wave 0: one at a time.
- Wave 1 adapters: two or three at a time.
- Wave 2 independent core modules: two or three at a time.
- Wave 3 safety-critical modules: mostly one at a time; at most two after interfaces are stable.
- Wave 4: one at a time with explicit human gates.

The YAML's maximum of four is a ceiling, not a target.

---

# 14. One-sentence operating model

For every package:

> Fresh Claude implementation context, isolated candidate commit, fresh read-only Codex review, Claude repair loop if needed, human merge, post-merge CI, status update, then discard both contexts.

For every wave:

> Repeat per package, then perform a fresh read-only wave closeout before unlocking the next wave.
