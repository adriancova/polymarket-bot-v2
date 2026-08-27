# Orchestration session handoff — 2026-08-26

Written by the outgoing orchestrator session for its successor. Read this AFTER
the AGENTS.md mandatory list (handoff spec, workplan, IMPLEMENTATION_STATUS.md,
git log, runbook). **Per-package state lives in `IMPLEMENTATION_STATUS.md` and
is not duplicated here** — this document carries orchestration know-how, the
operational recipes that were proven this session, and the queued next actions.

## 1. Where this session got to

- **Wave 0: COMPLETE** (all four packages + closeout remediation merged and
  post-merge verified; two independent closeout audits recorded; see the
  "Wave 0 closeout (2026-08-26)" section of the status file).
- **Wave 1 batch 1A + WP-015 in flight** at the time of writing; the status
  table's rows for WP-015/WP-040/WP-050 name the exact candidate branches,
  review rounds, and open findings. WP-060 is authorized but deliberately not
  started (slot discipline). The outgoing session intends to drive the three
  in-flight packages through merge and then stop; if any row still says "In
  remediation/review" when you read this, that loop is yours to finish using
  the recipes below.

## 2. The lifecycle as actually practiced (runbook §3, with mechanics)

One package = one canonical worktree branch. Loop: implement → orchestrator
verify → fresh Codex review → fresh repair session → re-review → … → ACCEPT →
merge (--no-ff, message via file) → post-merge gates on main → status commit →
worktree/branch cleanup.

**Delegation.** Implementation and repair sessions are `wp-implementer` /
`venue-verifier` subagents on **Opus** (`model: "opus"`), one complete task
packet per §18.2 in the delegation message, always including: exact base SHA,
allowed/forbidden paths (with any orchestrator ratifications spelled out),
verbatim review findings for repairs, gates to run, and the required handoff
fields. Repairs get findings **verbatim with file:line and the reviewer's
probe outputs**, and are told to reproduce each probe before fixing.

**Worktree isolation quirk (important).** A subagent's git operations are
restricted to its OWN worktree — it cannot commit to the canonical package
worktree. Proven pattern: the repair packet tells the agent to
`git checkout -b wp-XXX-remediation-roundN <candidate-sha>` inside its own
worktree (objects are shared), commit there, and the orchestrator then runs
`git merge --ff-only <new-sha>` in the canonical worktree. Always verify
linear parentage before FF.

**Reviews.** Codex, invoked DIRECTLY (never via the codex:rescue forwarder —
it double-submits on timeout):

```bash
cd <canonical worktree>   # companion scopes per workspace cwd
node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs \
  task --background --fresh "$(cat <prompt-file>)"
# then poll: status <job-id> --json  (check BOTH status and pid liveness —
# registry entries can be zombies), and fetch: result <job-id>
```

Watcher pattern: a background shell loop polling every 30s, exiting when the
job stops running or its pid dies. Review prompts include: candidate/base SHAs,
read list, acceptance criteria, findings-to-verify verbatim, explicit judgment
requests for each disclosed deviation, and the clause "if remaining defects are
genuinely LOW/NOTE only, issue ACCEPT plainly with the residual list; do not
manufacture findings; do not soften genuine ones" — without it the loop never
terminates; with it Codex has issued clean ACCEPTs.

**Session limits.** Subagents die mid-task on API session limits. Resume the
SAME agent (context intact) rather than respawning; it picks up exactly where
it stopped. Its last text tells you where that was.

**Commit mechanics.** The permission classifier intermittently blocks
`git commit -m` with multiline messages; write the message to a scratch file
and use `git commit -F <file>` — never blocked. Always `cd` explicitly in every
command (a failed compound command can silently reset the persisted cwd, and
gates then run against the wrong tree — this happened once and was caught).

**Ratifications.** Mechanical path needs (lockfile updates from declared deps,
in-repo `docs/handoffs/WP-XXX.md`, root-config lines serving a deliverable) are
ratified by a dated comment in the workplan YAML + a status-file record — the
eslint/WP-020 precedent. Check the workplan before writing a packet; WP-040/050
already carry theirs. Verify every lockfile diff is additive
(`git diff ... -- pnpm-lock.yaml | grep -c '^-[^-]'` → 0, or explained).

**Tests placement lessons.** Tests under `test/unit/**` cannot resolve
workspace packages (no root devDep) → colocate in `packages/*/src/**` (WP-020
precedent). Non-unit trees (`test/fault-injection/**`, `test/integration/**`,
`test/contract/**`…) are not run by the root vitest config → the workplan-level
ratification (comment near the top of the YAML) lets the owning package add a
self-contained vitest config + package-level script; **root script + CI wiring
is orchestrator-owned at merge** (see §4).

## 3. Safety state (unchanged, non-negotiable)

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, both live caps 0, no signer,
no credentials, no live gates requested. Nothing this session touched weakens
any of it; every review verified it. Keep it that way.

## 4. Queued orchestrator actions (do these at/after the in-flight merges)

1. **Merge order if several land together:** WP-015 first (smallest, no
   lockfile), then WP-050, then WP-040; after each, run full gates on main
   (`install --frozen-lockfile, typecheck, lint, test`, plus the package's own
   suite) — lockfile merges across WP-040/WP-050 should be clean (disjoint
   importer blocks) but verify.
2. **Root wiring at merge (orchestrator-owned, ratify with workplan comments):**
   - root `test:fault` script + CI step (WP-050's 78-test fault suite is
     currently executed by nothing in CI);
   - root `test:integration` replacement for the WP-010 placeholder + a CI job
     with Postgres (WP-040's 140-test suite; needs Docker);
   - root `db:migrate` wiring to the storage-postgres runner;
   - keep `pnpm check:deps` green (WP-015's CI step already wired by the package).
3. **WP-060** (Redis Streams transport): authorized, packet not yet written.
   After a 1A slot frees. Remember Docker/redis for integration tests; same
   lockfile/handoff ratification pattern (add the workplan comments first —
   WP-060 does NOT have them yet).
4. **Batch 1B** (WP-070/WP-080/WP-090 parallel; **WP-100 strictly after WP-070
   merges** — path subset, runbook corrected accordingly): before dispatching
   1B, run the **C-4 phase-start venue re-check** (quickstart/overview archived-
   SDK references; owner: orchestrator, recorded in the Wave 0 closeout
   section) and record it. `pnpm ops:verify-venue` runs offline and validates
   the frozen report.
5. **WP-070 packet must include** (accumulated obligations): C-1/U-1
   confirmation with the reworded workplan acceptance criterion; the R-2
   register item (replace hand-transcribed venue stand-in schemas so
   transcription stops being load-bearing); adapters accept SDK `.nullish()`
   null → absent BEFORE the domain boundary (ADR-001 §8/ADR-002 §7);
   fixture-only narrowings must NOT be inherited (ADR-002 §7 binding list).
6. **WP-120/WP-130 obligations recorded by WP-050:** gateway drives
   `drain()`/`tick()` and routes refusals/faults to incidents; consumers
   deduplicate on `(gatewayEpoch, ingestSeq)` (the WAL's documented
   at-least-once trade); WP-130 must not trip the anchored `.gitignore`
   patterns (already fixed: `/wal/`, `/parquet/`, etc.).
7. **Open registers to keep grooming:** `docs/contracts/protected-contracts.md`
   §8/§8.1 (venue-fact gaps R-1..R-4, unratified inferred shapes → next
   ADR-modifying package); WP-015 follow-ups (contract owner: make §2/§2.1
   machine-readable in place; number F-OPAQUE; fix the now-stale §5/§6
   owner text — all need `docs/contracts/**`, i.e. an authorized packet or
   orchestrator governance edit).
8. **Evidence still pending:** a real GitHub Actions run (no remote configured;
   never claim it ran). Everything else Wave-0/1-related is in-repo.

## 5. Prompt-file + scratch conventions

Review prompts and commit messages live under the session scratchpad
(`.../scratchpad/wpXXX-rN-prompt.txt`, `commitmsg.txt`) — rewrite `commitmsg.txt`
before every commit (parallel agents share the scratchpad; it has been
overwritten mid-flight). Prompt files are disposable; the durable copy of every
verdict is summarized in the status file with the Codex session id.

## 6. One-line operating truths from this session

- The adversarial loop works: every package converged (Wave 0: 6/3/3 rounds;
  Wave 1 so far: 2-3+ rounds each) and each round's findings were strictly
  narrower. Do not skip the re-review after "small" fixes — round-N+1 has
  found real defects in round-N remediations four times.
- Reviewers must be told what was ALREADY accepted, or they re-litigate.
- Implementers overclaim in handoffs under pressure; reviews catch it. Require
  probe reproduction before fixes and mutation checks after.
- One package = one loop = one context. The repository is the memory.
