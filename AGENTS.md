# Repository agent operating rules

Before planning, editing, or delegating:

1. Read `docs/spec/polymarket-bot-orchestrator-handoff.md`.
2. Read `docs/spec/polymarket-bot-workplan.yaml`.
3. Read `IMPLEMENTATION_STATUS.md`. It is a brief of current state: its history is archived verbatim, and frozen, under `docs/status-archive/`, and per-package detail goes in the handoff (`docs/handoffs/README.md`), linked from the package's one-line row.
4. Inspect the current Git status and recent commits.
5. When orchestrating multi-package execution, also read
   `docs/spec/polymarket-bot-agent-orchestration-runbook.md` (process authority
   for the per-package lifecycle and wave gates).

## Authority

- Current official Polymarket documentation controls volatile venue facts.
- The Markdown handoff controls architecture and invariants.
- The YAML work plan controls dependencies, path ownership, and acceptance criteria.
- Accepted ADRs may refine implementation details but may not silently override the handoff.

## Execution rules

- Execute only work packages explicitly authorized for the current run.
- Current per-package authorization and state are recorded in `IMPLEMENTATION_STATUS.md`; do not begin a package it does not mark authorized/ready for this run.
- Use at most four agents, and fewer when tasks are not genuinely independent.
- One write-enabled work package per Git branch/worktree.
- Never allow two agents to edit the same paths concurrently.
- Respect `allowed_paths`, `forbidden_paths`, and global `protected_paths`.
- Do not modify shared contracts merely to make local implementation easier.
- Do not mark a work package complete until all acceptance criteria and tests pass.
- The implementing agent may not perform the final adversarial review.
- Report conflicts or missing information; never silently invent venue behavior.

## Safety

These defaults may not be weakened:

- `MAX_RUN_MODE=PAPER`
- `ALLOW_REAL_ORDERS=false`
- `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`
- `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`

No production wallet, signer, API credential, or real-order test is permitted.
Do not claim that a soak, execution probe, or live gate occurred without real evidence.

## Required work-package handoff

Every completed task returns:

- `summary`
- `files_changed`
- `tests_run`
- `assumptions`
- `deviations`
- `known_risks`
- `follow_up`
- `commit_sha`
