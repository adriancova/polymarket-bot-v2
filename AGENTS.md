# Repository agent operating rules

Before planning, editing, or delegating:

1. Read `docs/spec/polymarket-bot-orchestrator-handoff.md`.
2. Read `docs/spec/polymarket-bot-workplan.yaml`.
3. Read `IMPLEMENTATION_STATUS.md`. It is a brief of current state: its history is archived, verbatim and frozen, under `docs/status-archive/`; per-package detail goes in the handoff (`docs/handoffs/README.md`), linked from the package's one-line row.
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
- Current per-package authorization and open state are recorded in `IMPLEMENTATION_STATUS.md`; completed packages are listed in `docs/handoffs/INDEX.md`. Do not begin a package the brief does not mark authorized/ready for this run.
- Use at most four agents, and fewer when tasks are not genuinely independent.
- One write-enabled work package per Git branch/worktree.
- Never allow two agents to edit the same paths concurrently.
- Respect `allowed_paths`, `forbidden_paths`, and global `protected_paths`.
- Do not modify shared contracts merely to make local implementation easier.
- Do not mark a work package complete until all acceptance criteria and tests pass.
- The implementing agent may not perform the final adversarial review.
- Report conflicts or missing information; never silently invent venue behavior.

## Design principle: proportionality (every mechanism earns its place)

The complexity a mechanism adds must be proportionate to the risk it removes. This applies to every guard, state, retry, hold, check, knob and abstraction.

**The test.** Answer these before adding one. Reviewers ask them of every addition.
1. **Failure:** what concrete failure does it prevent? Give a scenario with steps, not "it might matter".
2. **Likelihood:** how often would that happen here, in PAPER now and live later?
3. **Impact:** what happens when it does: lost money, a stuck or unexitable position, a wrong record, or only a nuisance?
4. **Coverage:** does something else already catch it?
5. **Cost:** what does it add? Count code, the states or knobs an operator must learn, new failure modes, valid trades it may block, and recovery it makes harder.

**Decide.**
- **Build it** when likelihood × impact, net of existing coverage, outweighs the cost. Then choose the smallest form that covers the risk:
  - scope it to the cases that need it;
  - make a temporary block clear itself when its condition recovers;
  - keep one mechanism, not two that overlap.
- **Otherwise, do not build it.** Record it as a follow-up with its trigger: the evidence that would make it worth building.

**Symmetry.** Removing a mechanism needs the same evidence as adding one. Proportionality is not minimalism.

**Always proportionate:** the protections around ambiguous submissions, duplicate orders, position sizing and reliable exits, and the safety defaults below.

**For reviewers:**
- A finding states its scenario, its likelihood and its impact. Its severity follows from those, not from how clever the gap is.
- A gap that needs a contrived or implausible scenario is LOW or a follow-up.
- Unjustified complexity in a change is itself a finding.

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
