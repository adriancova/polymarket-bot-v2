# Implementation Status

Last updated: 2026-08-26  
Specification version: 2.0.0  
Current phase: `phase-0` — repository and venue verification  
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
| `WP-000`               | In remediation (round 4) | None | `venue-verifier` on branch `worktree-agent-a373c7ba6650bf1a9` |
| `WP-010`               | Complete | None               | Merged `12ce0ab` (impl `1bca7cf`) |
| `WP-020`               | In remediation (round 2) | `WP-010` ✓ | `wp-implementer` on branch `worktree-agent-a45b4929f044830ca` |
| `WP-030`               | Blocked  | `WP-000`, `WP-020` | —          |
| All remaining packages | Blocked  | See work plan      | —          |

### WP-010 completion record (2026-08-22)

- Implemented by `wp-implementer` on isolated worktree branch; implementation commit `1bca7cf90d6488107d5fed908a44c5eb18989bc1`; merged to `main` as `12ce0ab` after human approval.
- Independent adversarial review: **ACCEPT**, zero high/medium findings.
- Acceptance criteria (`pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test`, no live credentials; plus `uv sync --frozen` + `pytest`) verified by implementer, reproduced independently by reviewer, and re-run on merged `main` — all pass.
- Path ownership ratification: root `eslint.config.mjs` is canonically recorded in `docs/spec/polymarket-bot-workplan.yaml` under WP-010 `allowed_paths` and global `protected_paths` (2026-08-23).
- External post-merge review (Codex, 2026-08-23): CHANGES REQUIRED with two medium findings — both remediated same day: (1) CI now runs dependency vulnerability scans over both lockfiles (`pnpm audit --audit-level high`; `uv export --frozen` + `pip-audit --strict`), both passing locally; (2) the complete auditable WP-010 handoff with all required fields is recorded at `docs/handoffs/WP-010.md`. Additionally, a compose health gate (`pnpm test:compose` + CI `compose` job) now supplements the exit-0 `test:integration` placeholder, and it passes locally.

## Active branches and worktrees

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
  Remediation round 2 dispatched 2026-08-26. Not merged.

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
  number vs official DecimalString — follow-up repair round 4b dispatched
  2026-08-26 before review round 5. Not merged.

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
