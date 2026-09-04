@AGENTS.md

## Claude Code-specific instructions

- Use the project-scoped subagents under `.claude/agents/`.
- Always pass a complete work-package task packet in the subagent delegation message.
- Do not enable agent teams for the initial implementation waves.
- Do not enable any execution mode above PAPER.

### Model roles (operator policy, 2026-09-04)

- The orchestrator (main session) runs on **Fable 5**.
- Every Claude subagent (wp-implementer, adversarial-reviewer, governance rounds, etc.)
  is launched with an explicit **`model: opus` (Opus 5)** override — never inherit the
  orchestrator's model.
- Codex CLI reviews run on **SOL** (`gpt-5.6-sol`) — this is the configured default in
  `~/.codex/config.toml`; keep it (pass `--model gpt-5.6-sol` explicitly if the default
  ever changes).
- A subagent killed by a rate limit or model switch must NOT be resumed (it would keep
  its original model): launch a FRESH agent with the same packet plus a progress
  summary, pointed at the dead agent's worktree if it left committed work.
