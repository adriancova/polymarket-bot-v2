# ADR-010: Run-mode enablement and production key boundary

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** every package, enforced at process startup. `WP-020` froze
  the run-mode contract with a PAPER-safe maximum assertion (done); `WP-230`,
  `WP-240`, `WP-260`, and `WP-320` carry the enforcement points; `WP-350` and
  `WP-370` are the human-approval gates that could ever raise a cap.
- **Supersedes / Superseded by:** none

## Context

Handoff §0.2 is titled "Non-negotiable safety boundary" and states four defaults
the repository must ship with. `AGENTS.md` repeats them under "Safety" with the
sentence "These defaults may not be weakened." The work plan repeats them again
under `defaults` (`maximum_run_mode: PAPER`, `allow_real_orders: false`).
`CLAUDE.md` adds "Do not enable any execution mode above PAPER."

Handoff §1.3 makes "changing the live-enablement mechanism" an ADR-gated change,
which is why this record exists. **This ADR records the boundary. It does not
move it.**

## Decision

### 1. The four defaults are floors, not suggestions

```text
MAX_RUN_MODE=PAPER
ALLOW_REAL_ORDERS=false
LIVE_MICRO_MAX_ORDER_NOTIONAL=0
LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0
```

- No ADR, work package, configuration file, environment, test, or agent may
  weaken any of them.
- Raising them requires an explicit **human** gate, recorded with evidence: the
  §17 Phase 3 human gate (architecture and security review, venue docs
  reverified, account/wallet flow manually verified, live-micro caps explicitly
  configured), and the work plan's `human-approval` gates on `WP-350` and
  `WP-370`.
- **Current state:** no gate has been requested or granted. `IMPLEMENTATION_STATUS.md`
  records "Production signer configured: No", "Real venue credentials required:
  No", "Human live-micro approval: Not granted", and every human/operational gate
  as "Not requested".

### 2. The maximum mode is a startup property and cannot be raised at runtime

The six modes are `BACKTEST`, `PAPER`, `SHADOW`, `EXECUTION_PROBE`, `LIVE_MICRO`,
`LIVE` (§11). Each has a data source, an execution path, and a credential
requirement:

| Mode | Data | Execution | Credentials |
| --- | --- | --- | --- |
| `BACKTEST` | historical replay | simulated | **none** |
| `PAPER` | live | simulated | **public only** |
| `SHADOW` | live | simulated beside another run | **public only** |
| `EXECUTION_PROBE` | live | tiny real calibration orders | live signer |
| `LIVE_MICRO` | live | real, hard capped | live signer |
| `LIVE` | live | real | live signer |

Binding rules:

1. "A process has a maximum allowed mode. **It cannot be raised through the
   control API above the startup maximum**" (§11). The control API may lower, and
   may halt; it may never escalate (work-plan `WP-240` acceptance: "Control API
   cannot raise mode above process maximum").
2. The first three modes require **no signer at all**. A process whose maximum is
   `PAPER` has no code path that could use one.
3. The last three are unreachable today: `ALLOW_REAL_ORDERS=false` and both live
   caps are `0`, so even an enabled probe mode has zero permitted notional and
   zero permitted exposure.

### 3. A real key cannot be loaded by a paper or backtest process

**Startup validation rejects this configuration** (§6 invariant 17). Two
consequences that must both hold:

- "A production signer must never be required to run tests, backtests, the
  recorder, paper trading, or the control plane. A real signer is mounted only
  into the live execution process after the live-micro gate is approved" (§0.2).
- "**A paper environment cannot reference production secret names**" (§15). Not
  "must not hold the secret" — must not *reference the name*, so a
  misconfiguration cannot silently pick up a real value.

The names to reject are not guessed. `docs/venue/verified-2026-08-24.md` §16
enumerates them with a per-name official source, and splits them by role:

| Category | Names (venue report §16) |
| --- | --- |
| **Secret material** (§16.1) | `POLYMARKET_PRIVATE_KEY`, `SIGNER_PRIVATE_KEY`, `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`, `POLYMARKET_BUILDER_PASSPHRASE`, `POLY_API_KEY`, `POLY_PASSPHRASE`, `POLY_SIGNATURE`, `POLY_BUILDER_API_KEY`, `POLY_BUILDER_PASSPHRASE`, `POLY_BUILDER_SIGNATURE`, `POLY_BUILDER_TIMESTAMP` |
| **Account-identifying, not secret** (§16.2) | `POLYMARKET_WALLET_ADDRESS`, `POLY_ADDRESS`, `POLY_TIMESTAMP` |
| **Public builder attribution, NOT a credential** (§16.3) | `POLYMARKET_BUILDER_CODE` |

Rules derived from that split:

1. The startup deny-list for non-live processes is built from **§16.1 plus
   §16.2**. An account-identifying value is not a secret, but a paper process
   referencing a real one identifies a real account.
2. **`POLYMARKET_BUILDER_CODE` must not be described as a credential.** It is a
   public identifier a builder publishes and attaches to orders, and it grants no
   authority by itself (venue report §16.3). It is still scanned so that no
   fixture embeds a real builder's attribution value.
3. The list is a **dated snapshot** and must be re-derived at each venue
   re-verification (§1.2). Venue report §16.4 records a case where an earlier
   round got two of these names wrong in both directions — a name it claimed was
   undocumented turned out to be documented, and a citation it gave was
   attributed to the wrong page. A hardcoded, unreviewed list is exactly how that
   recurs.

### 4. The SDK boundary

- Only `packages/polymarket-secure` may import `@polymarket/client` (§9.12: "The
  rest of the codebase must not import `@polymarket/client` directly"; work-plan
  `WP-260` acceptance: "Only this package imports the secure SDK entry points").
- **All signer access is isolated inside that package** (§9.12).
- Archived and previous CLOB, relayer, and builder-signing clients are
  **forbidden**: the official migration guide instructs integrators to remove
  `@polymarket/clob-client-v2`, `@polymarket/builder-relayer-client`, and
  `@polymarket/builder-signing-sdk`, and `WP-000` ruled accordingly (venue report
  §1).
- **`simulation` must not import a live signer** (§5.2). A simulated venue that
  can reach a signer is not a simulation.
- Replacing the official SDK with hand-written signing or an unofficial SDK
  requires an ADR (§1.3).
- **The exact npm version is not yet pinned** — venue report §12 **U-7** records
  that the published version was not observable, and pinning happens at `WP-260`
  with a fresh check. Everything verified about the SDK is pinned to commit
  `7fdbed42484b5d279c71aa36d3757d18968260da` (venue report §1). No SDK dependency
  exists in this repository today.

### 5. Geographic eligibility, and the ordering of the live gate

Before any real order the live adapter performs the venue's current geographic
eligibility check and **fails closed on ambiguity** (§0.2, §6 invariant 18). The
mechanics and the close-only-versus-blocked distinction are owned by ADR-008 §7.

Ordering matters: eligibility is checked **before** entries, not after a rejection
teaches us. §9.8's pre-trade check list puts run-mode and real-order enablement
(checks 2–3) and venue geographic eligibility (check 4) ahead of every economic
check.

### 6. Prohibited conduct, stated plainly

- "The software must not bypass geographic restrictions, platform controls,
  sanctions controls, or account eligibility checks" (§0.2).
- No production private key is ever committed, logged, copied to fixtures, or
  mounted into a non-live process (§15).
- Logs redact API keys, passphrases, signatures, signed order payloads, and
  private wallet material (§15).
- **No real-order test.** Contract tests use sanitized official examples and
  captured non-sensitive responses, and "Contract tests must not place real orders
  in ordinary CI" (§16.3). Ordinary tests for the secure adapter use mocks and
  fixtures (work-plan `WP-260` acceptance).
- **Time-based gates cannot be simulated.** The orchestrator must mark them
  `PENDING_EXTERNAL_EVIDENCE` until real elapsed-time evidence exists (§16.7);
  the work plan sets `time_based_gates_may_be_simulated: false`.
- No claim of a soak, execution probe, or live result may be made without real
  evidence (`AGENTS.md`).

### 7. `EXECUTION_PROBE` and `LIVE_MICRO` caps are non-bypassable

When and if a probe mode is ever enabled, probe notional and account exposure are
**hard capped**, probe mode cannot start a normal live strategy, and a **human
gate is required to set caps above zero** (work-plan `WP-350` acceptance). The
caps are enforcement, not advice: a plan exceeding them is rejected, not
truncated silently.

### 8. Attestation for the current repository state

- No production wallet, signer, API credential, or real-order test exists in this
  repository (`AGENTS.md`; `docs/handoffs/WP-000.md` safety attestation; venue
  report §13).
- `WP-000` performed **only unauthenticated public documentation reads**: "No
  order was placed, no execution probe was run. No production signer, wallet key,
  API credential, or account secret was loaded or configured" (venue report §13).
- The compose stack ships obvious dev-only, loopback-bound credentials
  (`docs/handoffs/WP-010.md`), and CI requires no secrets
  (`.github/workflows/ci.yml` sets `permissions: contents: read` and passes no
  secret).

## Consequences

- **Every live capability in this design is written and unreachable.** ADR-007,
  ADR-008, and parts of ADR-006 describe protocols that cannot execute under the
  current defaults. That is intentional: designing them under review is separate
  from enabling them.
- **The deny-list is a maintenance obligation.** Venue credential names change,
  and a stale list gives false assurance. It is re-derived at each venue
  verification round, from the report's cited per-name table.
- **"Cannot reference production secret names" is stricter than "must not hold
  secrets"** and will reject configurations that would technically have worked.
  That is the intended over-rejection.
- **CI cannot prove the live path works.** With no signer and no real orders, live
  behavior is only ever exercised against mocks and the fault-injection suite
  (`WP-340`). The gap is closed by the human gate and the execution-probe phase,
  not by a test.
- **Any future ADR that touches these numbers is out of order unless a human gate
  is already recorded.** The mechanism is: human approval first, recorded in
  `IMPLEMENTATION_STATUS.md`, then a configuration change — never the reverse.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §0 — "The implementation must begin in paper-only mode. Real order submission
  remains disabled until the live-micro gate is intentionally unlocked after human
  review and venue verification."
- §0.2 — the four defaults verbatim; a production signer is never required for
  tests, backtests, the recorder, paper trading, or the control plane; no
  bypassing of geographic, platform, sanctions, or eligibility controls;
  fail closed on ambiguity.
- §1.3 — changing the live-enablement mechanism, or replacing the official SDK,
  requires an ADR.
- §4.1 — `apps/control-api` "Never has the signing key."
- §5.2 — `simulation` importing a live signer is forbidden.
- §6 invariants 16, 17, 18.
- §9.8 — pre-trade check order: run mode within process maximum, real-order
  enablement and fencing, venue geographic eligibility — all ahead of economic
  checks.
- §9.12 — the secure venue adapter isolates all signer access; the rest of the
  codebase must not import `@polymarket/client` directly.
- §11 — the six run modes and "A process has a maximum allowed mode. It cannot be
  raised through the control API above the startup maximum."
- §15 — security requirements, including "A paper environment cannot reference
  production secret names."
- §16.3 — "Contract tests must not place real orders in ordinary CI."
- §16.7 — time-based operational gates cannot be faked by an agent.
- §17 Phase 3 — automated gate: "Production signer remains absent from CI. Live
  maximum defaults remain zero." Human gate: architecture and security review,
  venue docs reverified, account/wallet flow manually verified, live-micro caps
  explicitly configured.
- §18.1 — the orchestrator keeps live execution disabled unless a human explicitly
  approves the live-micro gate.
- §18.3 — subagents do not add live credentials or real-order tests and do not
  claim a real-world soak or live result occurred.

**Repository governance:**

- `AGENTS.md` — "These defaults may not be weakened"; "No production wallet,
  signer, API credential, or real-order test is permitted."
- `CLAUDE.md` — "Do not enable any execution mode above PAPER."
- `docs/spec/polymarket-bot-workplan.yaml` — `defaults.maximum_run_mode: PAPER`,
  `defaults.allow_real_orders: false`,
  `defaults.time_based_gates_may_be_simulated: false`; per-phase
  `maximum_run_mode`; `WP-350` and `WP-370` gated `human-approval`.
- `IMPLEMENTATION_STATUS.md` — Safety state and "Human and operational gates"
  (every gate "Not requested"; live-micro approval "Not granted").

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §1 — `@polymarket/client` is the supported unified SDK; archived/previous CLOB,
  relayer, and builder-signing packages are rejected and forbidden; SDK reference
  commit `7fdbed42484b5d279c71aa36d3757d18968260da`; exact npm version pinning
  deferred to `WP-260`.
- §10.1 — the geoblock endpoint and the three restriction tiers as of 2026-08-24;
  explicitly not exercised by `WP-000`.
- §12 unverified **U-7** — the published `@polymarket/client` npm version was not
  observable; pinned at `WP-260` with a fresh check.
- §13 — safety attestation: no order placed, no execution probe run, no signer,
  wallet key, API credential, or account secret loaded; PAPER-only defaults
  unchanged.
- §16.1–§16.4 — the enumerated credential, account-identifying, and public
  builder-attribution names with per-name official sources, and the recorded
  round-3→round-4 fact reversal showing why the list must be re-derived rather
  than trusted.

**Implementation and prior handoffs:**

- `docs/contracts/domain.md` §1 — `run-mode.ts` implements §11 with a PAPER-safe
  maximum assertion.
- `docs/handoffs/WP-020.md` — the run-mode contract with an escalation ordering
  and a pure process-maximum assertion.
- `docs/handoffs/WP-000.md` — `assumptions` and safety attestation; no credential
  value of any enumerated name was ever loaded, read from the environment, or
  placed in a fixture.
- `docs/handoffs/WP-010.md` — CI requires no secrets; compose credentials are
  self-describing dev-only placeholders bound to loopback.

**Safety:** this ADR **strengthens** the boundary by writing it down and weakens
nothing. All four defaults remain exactly as specified.
