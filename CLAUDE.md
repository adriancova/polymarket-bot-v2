@AGENTS.md

## Claude Code-specific instructions

- Use the project-scoped subagents under `.claude/agents/`.
- Always pass a complete work-package task packet in the subagent delegation message.
- Do not enable agent teams for the initial implementation waves.
- Do not enable any execution mode above PAPER.
- Keep `IMPLEMENTATION_STATUS.md` brief: do not add history to it or to the frozen `docs/status-archive/`; follow `docs/handoffs/README.md`.
