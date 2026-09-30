# DEPS-2 — patch @grpc/grpc-js for GHSA-m9gg-hp2v-232j

**Status:** Complete (2026-09-30). Merged `c5967b4`, PR #30, CI run `36760006527`. Orchestrator-authorized CI-health fix.
**Reviewer:** an independent Opus adversarial-reviewer, ACCEPT (5/5 checks; 2 INFO).

- **Why:** a new high advisory against `@grpc/grpc-js` 1.14.4 made `pnpm audit --audit-level high` fail on every PR, including WP-260's round-4 gates.
- **Change:** lockfile only, in range: 1.14.4 → 1.14.5, reached only via testcontainers > dockerode (dev dependencies of event-bus and storage-postgres). No runtime path from any app.
- **Result:** the audit exits 0 (2 moderate advisories remain; see `DEPS1-VITEST`).
