# Orchestration runbook: the wave 0-2 text (superseded)

Moved verbatim from [`../polymarket-bot-agent-orchestration-runbook.md`](../polymarket-bot-agent-orchestration-runbook.md) at `5129b98` by `COMPLEXITY-1` (2026-10-08): its §3, §4 and §11. The runbook's §3, "The current loop", replaces them. This file is frozen.

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
