# Implementation Status

Last updated: 2026-10-08 (residuals moved to `docs/handoffs/RESIDUALS.md` by `COMPLEXITY-1`)  
Specification version: 2.0.0  
Maximum permitted run mode: `PAPER`

This file is the brief: current state only, one entry per item. It holds the safety state, the phase, what is authorized, the open packages, the blockers and the human items. Open residuals are in [`docs/handoffs/RESIDUALS.md`](docs/handoffs/RESIDUALS.md). Every handoff is listed in [`docs/handoffs/INDEX.md`](docs/handoffs/INDEX.md). The history the brief once carried is in [`docs/status-archive/`](docs/status-archive/README.md), frozen. How to write records: [`docs/handoffs/README.md`](docs/handoffs/README.md).

## Safety state

- `MAX_RUN_MODE=PAPER`
- `ALLOW_REAL_ORDERS=false`
- `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`
- `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`
- Production signer configured: **No**
- Real venue credentials required: **No**
- Human live-micro approval: **Not granted**

## Current phase

`phase-3`: live-micro infrastructure, still PAPER-only (runbook §8). **Budget (user, 2026-09-30):** under $100/mo for at least the first 3 months. The first deployment is a dedicated laptop, PAPER only.

- **Wave 3 IS COMPLETE WITH QUALIFICATIONS** (`CLOSEOUT-3`, at `fdc3430`, 2026-10-06). No blocker or HIGH was found, and all six runbook §8 items are met. See [the report](docs/handoffs/CLOSEOUT-3-wave-3-closeout.md).
  - Every package, `WP-260` to `WP-340`, is merged. `CI-6` runs the live fault suites in CI. `TRADER-SIGNALS` adds the graceful stop and paper fills. `DEPS-3` patched the `tinypool` and `source-map-js` advisories.
  - Its unowned findings are the rows `CO3-N1`, `CO3-N2`, `CO3-N3`, `CO3-LOWS` and `CO3-L6`. Only `WP-350` is released, and only the user can start it.
- **Protocol V2** (folded into Wave 3 by the user, 2026-10-05): `VENUE-4` (`f925a43`), `V2-0` (`5f2b3c8`), `V2-2` (`9836ab0`) and `V2-1` (`8558053`) and `V2-3` (`3ee3e1d`) are Complete: class A is done. The facts are in `docs/venue/verified-2026-10-05.md`, and the plan in `docs/venue/protocol-v2-migration-plan.md`.
  - **Dates:** Data API v1 retires on 2026-10-24, which breaks nothing here. New markets switch over about 2026-11-02. Reviewed series must list `acceptedProtocolVersions` `["v1","v2"]` by then.
  - **The user's rulings (2026-10-05):** the SDK's per-surface scope; ADR-033 D5 option 1; the ADR-001 bounded number rule. See [VENUE-4](docs/handoffs/VENUE-4.md). `V2-0` recorded them in the ADRs.
- **Wave 2 is CLOSED WITH QUALIFICATIONS** (2026-09-30). `CLOSEOUT-2` found one blocker, `X1`. `DURABLE-1` fixed it, and `CLOSEOUT-2B` confirmed the fix. The user ruled the CANCEL exemption. Records: [`CLOSEOUT-2`](docs/handoffs/CLOSEOUT-2-wave-2-closeout.md), [`CLOSEOUT-2B`](docs/handoffs/CLOSEOUT-2B-wave-2-regrade.md).
  - **Wave 2 packages:** all merged (batches 2A-2G; each merge is an ancestor of `main`). Handed over in [`WAVE-2-HANDOVER.md`](docs/handoffs/WAVE-2-HANDOVER.md).
  - A Wave 2 row that reads "Complete" means the package met its own acceptance criteria (re-verified by `GOV-2B` on 2026-09-15). It does not mean the paper core works end to end. Closing Wave 2 releases no new package: the four packages outside Wave 2 that depend directly on a Wave 2 package (`WP-270`, `WP-290`, `WP-300`, `WP-360`) all also depend on `WP-260`, directly or transitively. `WP-260` itself is held by wave ordering and the signer boundary. Gate counts in rows dated before 2026-09-26 come from one laptop; CI first ran with `CI-1`. Full text: [`wave-2-qualification.md`](docs/status-archive/wave-2-qualification.md).
  - **§7 exit checklist:** items 1-5 MET WITH QUALIFICATION, items 6 and 7 MET (`CLOSEOUT-2` and `CLOSEOUT-2B`). The qualifications are the `CO2-*` residuals.
  - **Closeout blockers:** every agent-closable blocker is closed, `B3` last (`BACKTEST-2`, 2026-09-28). What remains is human work or a ruling ([Human items](#human-items)).
- **The inherited-`toJSON` sweep is complete:** `SER-0` (`9a44167`, the measurement) and its rounds `SER-1`, `SER-2` and `SER-3`.

## Authorized now

Only rows marked **Ready (authorized)** may be started. Each row's allowed and forbidden paths are in [`work-packages-rounds.md`](docs/status-archive/work-packages-rounds.md) (search for the id). Completed packages are in [`docs/handoffs/INDEX.md`](docs/handoffs/INDEX.md); what each closed is under [Open blockers](#open-blockers).

- **`HOST-BENCH`**: Ready; run by the laptop agent from `docs/runbooks/laptop-host-bench.md`.
- **`COMPLEXITY-1`**: Ready (authorized 2026-10-08 by the user). A complexity audit with fixes in one go. Its scope is everything, process included; debatable removals go to the user, and `AGENTS.md` changes need the user's approval. `V2-9`'s scanner was cut down in its round C1-V29 and merged (`636536a`). It runs before `OMS-VENUE-TIME` and `TIF-COLLATERAL`.
- **`OMS-VENUE-TIME`**, then **`TIF-COLLATERAL`**: authorized (ADR-034, 2026-10-08), strictly in order, after `COMPLEXITY-1`. Their paths are in ADR-034's "Implementation plan".
- Wave 3 is authorized, and both conditions hold ([Wave 3 authorization](#wave-3-authorization-conditional)).

## Work packages

One line per open package. Full rows (chains, reviews, scope, paths, gates): `WP-000` to `WP-250` in [`work-packages-waves-0-2.md`](docs/status-archive/work-packages-waves-0-2.md); `WP-180-FU3` onward in [`work-packages-rounds.md`](docs/status-archive/work-packages-rounds.md). Completion records are in the `completion-records-*` archive files.

Completed packages are listed in [`docs/handoffs/INDEX.md`](docs/handoffs/INDEX.md), one row each, with the merge SHA and the handoff link.

| Package | Scope | Status | Merge | Record |
| --- | --- | --- | --- | --- |
| `WP-140` | Recorder observability and soak harness | Implementation complete; automated checks complete; the evidence gate is unmet until the ≥24h soak (H4) | `735d330` + wiring `5757ef3` | [WP-140](docs/handoffs/WP-140.md) |
| `OMS-VENUE-TIME` | ADR-034 R2 (D1, `WP340-F1`): venue-time ordering of late order observations, with the user-confirmed hold, halt at once and `DELAYED`/`UNMATCHED` extension | Authorized 2026-10-08 (user); waits for `COMPLEXITY-1` (user, 2026-10-08), which may simplify it. Paths: ADR-034 R2. Dual review | — | — |
| `TIF-COLLATERAL` | ADR-034 R3 (D3 `CO3-N2`, D4 `V2-10B`): time-in-force end to end; collateral-targeted FAK/FOK BUYs with plan-time share caps (variant P) | Authorized 2026-10-08 (user); starts after `OMS-VENUE-TIME` merges; needs the WP-200 and WP-320 owners' consent for their paths. Paths: ADR-034 R3. Dual review | — | — |
| `COMPLEXITY-1` | Complexity audit with fixes (scope: everything, process included) | **Running** (authorized 2026-10-08, user): C1-V29 merged with V2-9; C1-PROC merged via PR #91; C1-OPS merged via PR #92; C1-HALTS merged via PR #93; next C1-RISK, then C1-TIF, then C1-UNIV | — | [COMPLEXITY-1](docs/handoffs/COMPLEXITY-1.md) |
| `HOST-BENCH` | measure the laptop and a multi-market recording before launch | Ready: run by the laptop agent from `docs/runbooks/laptop-host-bench.md`; results come back on branch `host-bench-results-<date>`. The user starts it later on 2026-10-05 and reports back | — | — |
| All other packages not in `docs/handoffs/INDEX.md` | — | Blocked | — | See work plan |

Authorization vocabulary: "Ready (authorized)" rows are the only packages agents may begin in the current run; "Dependency-ready" rows must not start until this table says otherwise.

## Open blockers

Open residuals, one row each, are in [`docs/handoffs/RESIDUALS.md`](docs/handoffs/RESIDUALS.md): "Affects PAPER" and "Before any live mode". The closeout blockers are below, and the human items are under [Human items](#human-items). Full archived rows, evidence and history: [`open-blockers-2026-09.md`](docs/status-archive/open-blockers-2026-09.md) (search for the id). The cross-package schema-boundary record is [`cross-package-schema-risk.md`](docs/status-archive/cross-package-schema-risk.md).

### Closeout blockers (from `GOV-2B`, 2026-09-15)

| Id | State | Owner |
| --- | --- | --- |
| `B9` | **Closed for a run's first start** by `BOOT-1` (`0d09eb5`): the trader refuses to start unless its rows exist and match, and refuses to resume a run that holds decisions (exit 78). Resume (R10) is Wave 3's; after a crash the operator starts a NEW run. | `BOOT-1` ✓; R10 for resume |
| `H7` | **Ratified** by the user, 2026-09-28 ("Ratify all"). It covers the N6 field format; four root-wiring commits without recorded reviewer sign-off (`5b73461`, `af059d7`, `80126e8`, `da37a0c`); the SER confirming reviews run by Claude after Codex's content filter refused the packet; N11. Also the Fable verifiers for container- and spawn-heavy rounds (`BRACKET-1c`, `BUNDLE-1`, `DEPCHECK-1`; the `CI-2` precedent), the `DEPCHECK-1` grant widening (`CI2-L5-2/3`) and the `DOCS-1` authorization. The archived state cell reads "PARTLY DONE"; it predates the ruling. | no open owner: the archived owner (human/orchestrator, for three questions) became historical at ratification |

Closed: `B4` (graded CLOSED by `CLOSEOUT-2`, 2026-09-30: H1 runs 3 and 5-8 on `8fde4df`), `B5` (graded CLOSED WITH QUALIFICATION by `CLOSEOUT-2`: the code half R4 by `TRDR-3` `da9c58e`, the infrastructure half R5 by H3; the qualifications are `CO2-N3` and the H3 line under Human items), `B3` (`BACKTEST-2` `fd12be0`, 2026-09-28), `B10` (`UNIV-4` `7c08af7`), `G-01` (`VENUE-2` `d6aedee`), `H5` (ruled 2026-09-28: one demonstrated run). Closed earlier: `B1`'s cause (`TRDR-2` `f3da220`), `B2` (`RISK-2` `133eac1`), `B6`, `B7` and N4 (`GATE-1` `0434c82`), `B8` with N2 (the contract correction; the `N2` measurement is open), N3 (features), N6, N7, N9, N10 and G-13 (`GOV-2C`). N5 closed later (`CI-1`).

## Human items

- **H1**, the live-data paper run: discharged under H5 (`CLOSEOUT-2`). Runs 3 and 5-8 (2026-09-30) each held a full 15-minute window with no trader halt. Runs 7 and 8 each made one live entry, vetoed `RISK_SETTLEMENT_UNVERIFIED`: then, no fill was possible until a settlement spec was reviewed (`CLOSEOUT-2` N2). Since the user's 2026-10-05 answer, PAPER configs may lift that veto for `btc-15m-updown` (below). Records: [`H1-RUN-1.md`](docs/handoffs/H1-RUN-1.md), [`H1-RUNS-2-8.md`](docs/handoffs/H1-RUNS-2-8.md).
- **H2**, a real CI run: discharged 2026-09-26 by `CI-1` (PR #1 run `36282501033`, every gate green).
- **H3**, a real Prometheus and Grafana: closed with qualification by `CLOSEOUT-2`. No real Grafana has rendered a non-empty Fills or PnL panel. Since `CONTROL-2`, tests read the scrape fragment's `rule_files` entry and `scrape_timeout` (`infra/prometheus/control-api-scrape.yaml`); no gate loads it into a real Prometheus.
- **H4**, elapsed soak evidence: open. It is the `WP-140` gate, which closes only through the runbook §7 governance procedure after a real ≥24h soak.
- **H5**: ruled 2026-09-28: one demonstrated run. The runbook §7 "Wave 2 closeout" check "Static Bracket runs in replay and live-data paper mode through the same code" (`:509` at `f43efe6`) is discharged by one supervised live-data paper session. That session runs through the real stack (gateway → Redis → trader → PostgreSQL), produces decisions and reads back clean. Sustained accumulation is the post-closeout activity the same section describes next (`:514` at `f43efe6`).
- **H6**, the authorization rows and round order: the orchestrator's, ongoing.
- **ADR-023's rulings** (orchestrator, 2026-10-01; confirmed by the user's ratification, 2026-10-02): D7 option (a); the guard's `Clock` use is not a clock-semantics change; the epoch taint stays coarse and fail-closed. **Narrowing the taint is the user's choice;** until then a Binance feed makes the rule change nothing (ADR-023 §5). Detail: [`THROUGHPUT-1c`](docs/handoffs/THROUGHPUT-1c.md).
- **H7**: ratified 2026-09-28 (`H7` above).
- **H8**: ruled 2026-09-28, option A: extract the paper core into the layer-1 package `@polymarket-bot/trading-core`. Done by the `H8 track` (`H8-GOV` → `DEPCHECK-1` → `CORE-MOVE` → `BACKTEST-2`); `B3` is closed. Rulings still in force (user, 2026-09-28): D4, a strategy-agnostic core, waits for a second strategy, with S18 (the `trading-core` → `static-bracket` same-layer edge) carrying a sunset clause; `FOLD-2` runs after `BACKTEST-2`.
- **`§5 item 6`**: no owner yet; the orchestrator authorizes it.
- **The `btc-15m-updown` settlement spec** (`CLOSEOUT-2` N2): **the user answered on 2026-10-05.** Lines 1-9 are confirmed. D1 is No: no clarification was sent, so U-24 clears only through new documentation. D2 is Yes: the spec is marked reviewed once a review can be recorded (gaps G-1 to G-10) and U-24 has cleared. PAPER configs may set `settlementReadiness.modelDependentActivationAllowed: true` for this series. The example PAPER config does (`TRADER-SIGNALS`). The spec stays `UNVERIFIED`. Record: `docs/settlement/btc-15m-updown-review-checklist.md`.

### Wave 3 authorization (conditional)

The user authorized Wave 3 on 2026-09-30. The orchestrator may start `WP-260` first, then the work-plan chain, only when both hold:
- the fresh Wave 2 closeout audit grades Wave 2 CLOSED: met on 2026-09-30 (`CLOSEOUT-2B`, with the user's CANCEL ruling);
- `VENUE-3` has merged (the phase-3 start gate): met on 2026-09-30 (`6a15131`).

Every Wave 3 package stays PAPER-only, built with fixtures, mocks and fault injection (runbook §8, "Critical rule"): no production wallet, signer, API credential or real-order test. If the closeout does not grade Wave 2 CLOSED, only the agent-closable blockers it names are worked, and Wave 3 does not start.

## Deviations from specification

One entry each; full text in [`deviations-evidence-gates.md`](docs/status-archive/deviations-evidence-gates.md).

- `WP-010`: the root `eslint.config.mjs` was outside its `allowed_paths`; ratified into WP-010 ownership.
- `WP-010`: Node 24 is pinned by `engines: ">=24"`, CI `node-version: 24` and a runtime smoke assertion, not an exact `.nvmrc`. Acceptable; tighten later if needed.
- `WP-000`: the venue report is `docs/venue/verified-2026-08-24.md`, not the work plan's literal `verified-2026-08-18.md`. Ratified by the orchestrator 2026-08-24. The rule: handoff §1.2 requires `verified-YYYY-MM-DD.md` dated to the actual verification; a work-plan literal is a template dated at plan generation.
- **N6**: four Wave 2 records, and most bounded rounds since 2026-09-05, use the completion-record form instead of the eight labelled fields. Recorded 2026-09-15 (`GOV-2C`); `AGENTS.md`'s eight fields control; the form was ratified by the user 2026-09-28 (H7).
- **N7**: ten Wave 2 merges touched `pnpm-lock.yaml` importer blocks. Ratified 2026-09-15 as a pattern (`GOV-2C`): a package that declares its own workspace and dev dependencies may update its own importer block, and later packages cite that entry. Seven more touches by rounds with no work-plan entry are covered by precedent only. `GATE-1`'s `js-yaml` substitution is recorded, not covered by the pattern.
- **N9**: `WP-200`'s `allowed_paths` names `test/integration/ledger/**`, which does not exist. Recorded 2026-09-15. A grant that authorizes nothing is not a deviation.
- **N11**: `BACKTEST-1` changed one line of the protected root `package.json` (`test:replay`). Ratified 2026-09-16 for that line. The orchestrator owns the class: every acceptance criterion that names a script must grant the file the script lives in.
- **N3**: a ruling of the form "by the next round touching X" failed twice, because nothing checks it. The systemic fix (a dated comment in the package's work-plan entry) is proposed, not applied: `GOV-2C`'s work-plan grant covered ratification entries only, and `packages/execution-planner` has no open package entry to carry it.
- **CANCEL exemption** (`DURABLE-1`): a CANCEL is submitted without waiting for its own decision's durability, and cancels route before placements within one decision. It departs from handoff §8.1's literal order. Ruled by the user 2026-09-30 ("Yes, cancels go first"). A cancel places and books nothing; its decision is still flushed after the callback, and a failure halts.

## Pending external evidence

- **H4**, the ≥24h soak for `WP-140` ([Human items](#human-items)).
- **C-2's reopen condition is met** (2026-09-17, `VENUE-2`; `verified-2026-09-16.md` D-15). The register's C-2 says any venue assertion of equivalence or conversion authorizes an explicit recorded conversion, never a fold. The venue now documents a conversion: pUSD is an ERC-20 wrapper representing a USDC claim, wrapped and unwrapped onchain by the `CollateralOnramp` and `CollateralOfframp` contracts, and its `_asset` must be USDC.e. The bridge deposit and resolution pages agree. Three names are in play (USDC, USDC native, USDC.e), and the Bridge API labels the pUSD address `"symbol": "USDC"`. The report records this and does not act; the ADR-006 fail-closed rulings are unaffected. Owner: the register/ADR-006 contract owner, through a dated amendment recording the conversion, in a governance round with `docs/adr/**` and `docs/contracts/protected-contracts.md` in grant. Also for that owner: U-11 (D-20), the SDK's closed five-value `UmaResolutionStatus` enum at both commits against the docs' nullable string.

## Human and operational gates

- Execution-probe gate: Not requested
- Live-micro gate: Not requested
- Live gate: Not requested
- Time-based soak evidence: None

## Archive

The whole file at `8fde4df` is archived verbatim in [`docs/status-archive/`](docs/status-archive/README.md), whose README lists each file and what it holds. Search by id; do not read whole files. [`MOVE-MAP.md`](docs/status-archive/MOVE-MAP.md) says where each old section and row went, and [`REWRITES.md`](docs/status-archive/REWRITES.md) gives each rewritten live sentence, old and new. Resolved evidence items are in [`deviations-evidence-gates.md`](docs/status-archive/deviations-evidence-gates.md) and the `CI-1` and `WP-010` handoffs.
