# CLOSEOUT-3: Wave 3 closeout audit (runbook §10)

**Run date:** 2026-10-05 to 2026-10-06. This synthesis was written on 2026-10-06.

**Tree:** read-only, on `main` at `fdc3430` (`fdc34309ead1f733592e56936ab37658d1d5ba4c`), which equals `origin/main`. The audit used a detached worktree, `polymarket-bot-closeout-3`. At synthesis time, `main` was still `fdc3430`, and CI push run `37414895013` on it was `success`.

**Seven agents took part:**

| Auditor | Model | Scope |
|---|---|---|
| A-matrix | Opus | §10 steps 1-3: the dependency and acceptance matrix, and the merge SHAs |
| B-checklist | Opus | the six runbook §8 "Wave 3 closeout" items, plus the §8 Critical rule |
| C-gates | Opus | step 4: every root gate run locally, and GitHub CI |
| D-drift | Opus | steps 5-8 |
| E-architecture | Codex `gpt-6-astra` (read-only sandbox) | the architectural-consistency pass over the composition seams |
| F-critic | Opus | completeness critic |
| S-synthesis | Opus | this report |

**Hygiene.**
- No agent modified a tracked file, committed, pushed or ran `pnpm install`.
- The only containers started were Testcontainers PostgreSQL, Redis and Ryuk containers, all reaped. `adriancova-db-1` was not touched, and no prune was run.
- No `.env` file was read.
- The source reports are in `scratchpad/closeout-3/{A-matrix,B-checklist,C-gates,D-drift,E-architecture,F-critic}.md`, with copies in `~/pmb-rounds/closeout-3/`.

**What was audited:**
- the runbook §8 Wave 3 packages, `WP-260` to `WP-340`, plus `WP-300b` and `WP-300c`;
- every side or hardening round merged from 2026-09-30 to 2026-10-05: 53 first-parent merges, from `VENUE-3` `6a15131` to `VENUE-4` `f925a43` (A §2.1).

**What was not credited:** `V2-0` and `V2-2` are in flight. At synthesis time `v2-0` is at `5d36cd7` and `v2-2` at `212d5aa`, and neither is an ancestor of `fdc3430` (`git merge-base --is-ancestor`).

**The rulings applied:**
- **By the user:**
  - `WP340-F1`: venue-time ordering, then a pre-live ADR and an OMS round (brief `:304`);
  - the settlement checklist answered (`VENUE-SETL-1`);
  - paper fills enabled in the PAPER example config only (`:458`);
  - ADR-030 and ADR-023 Amendment 1 confirmed (`ab5033a`);
  - the SDK's per-surface scope, ADR-033 D5 option 1, and the ADR-001 bounded number rule (`:71`);
  - `CKPT1-PG-RNG-STATUS` option 1.
- **ADR-033 D1–D4 and D6 were accepted by the orchestrator, not the user** (`docs/adr/ADR-033-order-heartbeat-behind-a-port.md:3`; A F6, F F-04). Only D5 is the user's ruling, and the ADR does not record it yet (`:8` still reads "D5, the transport, stays open"). `V2-0` will record it.

# VERDICT: WAVE 3 IS COMPLETE WITH QUALIFICATIONS

**The scope of this verdict** is the runbook §8 Wave 3 packages and exit checklist, as merged at `fdc3430`. The user folded the Protocol V2 migration into Wave 3 on 2026-10-05. That migration is open, and this verdict does not grade it (see "Open Wave 3 scope"). It has hard dates: Data API v1 retires on 2026-10-24, and the switchover is about 2026-11-02.

**What holds:**
- **All six §8 items are MET:** items 4-6 outright, items 1-3 with qualification. No item is NOT MET, and every grade rests on executed evidence, not on the status file.
- **Every gate is green at `fdc3430`, locally and in CI:**
  - locally: unit 530 files / 11,956 tests, `test:fault` 104 / 1,113, `test:contract` 41 / 1,112, and `test:integration` 126 / 1,320, after one disclosed `TC-LOCAL-FLAKE` re-run of step 5/8 (C §1);
  - in CI: push run `37414895013` on `fdc3430` itself, with identical counts (C §2).
- **Every acceptance criterion is evidenced.** All 31 work-plan criteria of `WP-260`…`WP-340` have a named, currently passing test (A §3). Every dependency edge held (A §2.3). All 49 cited CI runs are `success` on exactly the merged tree (A §2.2).
- **The security reviews are real.** Every security-review gate ends in a true joint ACCEPT on the candidate that merged. F confirmed this from the raw workflow journals, and I re-read WP-330 r5 myself.
- **No auditor found a BLOCKER or a HIGH.**
- **The §8 Critical rule holds:** nothing in the tree or the records authorizes live trading.

**What qualifies it:**
- **Two new MEDIUM composition defects, found by E and reproduced by F (5 of 5).** I re-read both at the cited lines. Neither has an owner row.
  - **N1 (E-01):** the SDK rounds the signed share size, but the OMS and reconciliation compare the unrounded size.
  - **N2 (E-02):** FAK and FOK cannot be carried from the plan through the OMS, although the shipped PAPER example config uses FAK.
- **`WP340-F1` is ruled but unfixed.** The fault suite's green includes four `it.fails` pins and 284 scripted operator releases.
- **The crash-recovery evidence assumes durable state that no composition has yet:** the OMS store, the inventory and the ledger (N3).
- **Several follow-ups have no owner.** The emergency CLI's real-PostgreSQL suite is in no gate (L1). An agreed fix to the emergency runbook was never applied (L2). The venue check of the mock's assumptions has no brief row (L3).

**Why nothing here blocks:**
- No finding makes a §8 item NOT MET, and none contradicts a work-plan acceptance criterion.
- No composed process can reach these defects. The PAPER trader runs a simulated venue (`apps/trader/src/main.ts:903,925`). `apps/trader` declares none of `oms`, `inventory` or `polymarket-secure` (D §2.2). The shipped `ops-cli` binds no credential and no venue (`apps/ops-cli/src/emergency/main.ts:64-70,131-132`).
- Each defect either fails closed or is a missing capability.
- Closure releases only `WP-350`, and only the user can start it (step 10).

This differs from CLOSEOUT-2's X1, which was reachable in PAPER and contradicted WP-230 criterion 4.

## The §8 exit checklist, item by item

The checklist is at `docs/spec/polymarket-bot-agent-orchestration-runbook.md:605-614`.

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | All security reviews are resolved | **MET WITH QUALIFICATION** | **The gates** (YAML `security-review`) are `WP-260` (`workplan.yaml:1016`), `WP-320` (`:1166`) and `WP-330` (`:1196`). Each ends in a joint Opus + astra ACCEPT on the candidate that merged: <br>• `WP-260`: r5 on `d63677c`, CI `36763368765`, head `d63677c`; <br>• `WP-320`: r5 on `fed6ec1`, plus the CI fix r6 on `8747c25`, CI `37323961799`, head `81b2551`; <br>• `WP-330`: r5 on `83ea906`, CI `37372692710`, head `d44d905`. <br>F read the raw verdicts from the workflow journals (F §2.1). I re-read WP-330 r5's journal: astra returned CHANGES REQUIRED, with `CX330-R5-01` at MEDIUM, and the reconciliation produced a joint ACCEPT with both verifiers at LOW. No unreviewed commit landed after any ACCEPT (A §2.2, F §3.4). `WP-340`'s `review` gate ended in a joint ACCEPT r2 on `e0c4bb9`. <br>**Qualifications:** <br>• open LOWs and INFOs under `WP320-FOLLOWUPS` and `WP330-LOWS` (brief `:283-284`); <br>• the WP-330 r5 reconciliation's agreed correction of `docs/runbooks/emergency.md:219-221` was never made (L2); <br>• the pre-live ADR obligations (`WP270-DECISIONS`, `WP290-RESIDUALS`, `WP310-LOWS`, `CAP1-RESIDUALS`); <br>• `V2-8`'s security review (cancel paths) is future Wave 3 scope. |
| 2 | Fault-injection suite passes | **MET WITH QUALIFICATION** | **Locally:** the root `test:fault` chain (`package.json:18`, all six commands) exits 0 every time, with 104 files and 1,113 tests (B, C). The live PostgreSQL half passes 1 file / 4 tests (`{"holderSent":119,"otherRefusals":120}`, B). <br>**In CI:** run `37414895013` passed "Fault-injection tests 1/6"…"6/6" and "Integration tests 8/8". <br>**Qualifications:** <br>• `WP340-F1` is pinned, not fixed. There are four `it.fails` tests (`test/fault-injection/live/findings.test.ts:115,152,177`; `:177` is a loop over two variants), and the green includes 284 scripted operator releases plus the driver's 3 controls (`support/expected-releases.ts`; A F2, B F-1, F §3.5); <br>• the mock CLOB's assumptions A1–A9 are unverified against the venue (`docs/experiments/phase-3-verification.md:103-113`); <br>• the mock also assumes, without saying so, that the venue books the requested size rather than the signed size (N1). Every share size in the suites is on the 2-decimal grid, so they never reach that boundary (F §2.2); <br>• the PostgreSQL half's 10× time line can lose a renewal under load (`CI6-R1-L1`). |
| 3 | Independent cancel path works against mocks/fixtures | **MET WITH QUALIFICATION** | **The test:** `test/fault-injection/live/independent-cancel.test.ts` passes 5 of 5. It drives `runOpsCli` end to end over WP-260's real client against the mock CLOB, with the trader reaped and its store and journal throwing (`databaseCalls` stays `[]`) (B item 3). It is gated in CI by fault step 6/6. <br>**It is not vacuous** (B's out-of-tree mutants): <br>• M1 removes the by-id sweep, and 3 of 5 tests fail; <br>• M2 forces the gate open, and the PAPER-refusal case fails, along with 50 of 51 `run.gate` tests. <br>**WP-330's own suites:** the unit run is 22 files / 748 tests. `ops-cli test:integration` (real PostgreSQL, the shipped bundle) passed 6 of 6 in A's, B's and C's runs. <br>**Qualifications:** <br>• it works only with injected ports. The shipped composition binds `UNCONFIGURED_CREDENTIALS` and `UNBOUND_VENUE`, and B's probe under raised flags got `CREDENTIALS_UNAVAILABLE` (exit 6), with nothing sent; <br>• mock assumptions A2 (the scope of `DELETE /cancel-all`; both readings are run) and A9 (`Retry-After` under D-21 debt) are unverified; <br>• the real-PostgreSQL suite is in no gate (L1). |
| 4 | No live caps have been raised | **MET** | **No production change:** `git diff 8de4828 fdc3430` is empty on `packages/trading-core/src/safety.ts`, `apps/control-api/src/safety.ts`, `apps/backtest-cli/src/safety.ts` and `packages/capital-allocator/src/caps.ts`. Every cap literal in the Wave 3 diff is in a test or a comment (B, D). <br>**The floors:** `safety.ts:341-351` refuses any cap other than `"0"`; `caps.ts:56` sets `LIVE_MICRO_CAP_FLOOR = "0"`; `infra/compose/trader/trader.config.example.json:26-27` sets both caps to `"0"`. <br>**The tests:** `live-defaults.test.ts` passes 15/15, and B's mutant M3, which disables the trader's cap check, fails it. <br>**The records:** "Execution-probe gate: Not requested; Live-micro gate: Not requested" (brief `:503-504`). |
| 5 | No production signer is mounted | **MET** | **No production signer type exists.** The only `SignerProvenance` is `"TEST_MOCK"` (`packages/polymarket-secure/src/signer.ts:31`). `sealSigner`'s only caller is `src/testing/mock-signer.ts:121`, and the real factory refuses `TEST_MOCK` (`venue-client.ts:599-607`). <br>**Nothing binds or supplies a credential.** No compose file has `secrets:`, `env_file` or a key volume. `ci.yml` references no `secrets.`. The trader declares no `polymarket-secure`, and `ops-cli` binds no credential (B, D). <br>**At the host level:** the only container is `adriancova-db-1`, no bot process is running, and the main checkout has no file with a key-like name (F §3.1). <br>INFO: an untracked, gitignored `.env` exists in the main checkout. It was not read (B F-6). |
| 6 | Maximum run mode remains PAPER | **MET** | **The ceiling:** `REPOSITORY_MAXIMUM_RUN_MODE = "PAPER"` (`packages/trading-core/src/safety.ts:67`), and a raised ceiling is refused, not clamped (`:281-289`). The config schema is `environment: z.literal("PAPER")` (`config.ts:513`). The control API and the backtest CLI apply the same floor (`apps/control-api/src/safety.ts:59`; `apps/backtest-cli/src/safety.ts:85-101`). Every app entry runs its check first (B item 6). <br>**The tests:** the safety and boundary unit files pass 216/216, and e2e `safety-posture` passes 17/17 (D). None of the safety files changed in Wave 3. <br>INFO: `data-gateway` and `ops-cli` trust the `MAX_RUN_MODE` flag instead of refusing a raised value. Neither holds a live capability today (B F-5, D-11). |
| — | §8 Critical rule: completing Wave 3 does not authorize live trading | **HELD** | **Live trading:** `docs/experiments/phase-3-verification.md:10` reads "This report authorizes nothing live". All three live gates read "Not requested" (brief `:503-505`), and "Human live-micro approval: Not granted" (`:17`). <br>**The signer and the transport:** no signer is accepted (item 5), and no heartbeat transport exists (ADR-033 D5 is unbuilt). |

## Package matrix summary

**Runbook §8 packages.** All of them are merged, are ancestors of `fdc3430`, and are two-parent merges with matching subjects (A §2.1). For the four gated merges, CI head = `merge^2`, and no commit landed after the ACCEPT (F §3.4).

| WP | Merge | Final review | YAML gate | Verdict |
|---|---|---|---|---|
| WP-260 | `32d10be` | joint ACCEPT r5, `d63677c` | security-review | MET |
| WP-270 | `259c964` | joint ACCEPT r4, `19130ae` | automated | MET. Its "signed payload persistence" exists as a port with a `MemoryStore`; the adapter on `0005` and the AEAD cipher are composition duties (`docs/handoffs/WP-270.md:103`; N3). ADR-007 §8's FAK/FOK duty is not implemented (N2) |
| WP-280 | `065716f` | joint ACCEPT r4, `258f016` | automated | MET |
| WP-290 | `7a53988` | joint ACCEPT r16, `228a40d` | automated | MET WITH QUALIFICATION. Criterion 3 holds only in a universe where the OMS store, ledger and inventory survive (`test/fault-injection/reconciliation/support/harness.ts:8-9`; N3), and only for on-grid sizes (N1) |
| WP-300 | `9cdbf32` | joint ACCEPT r10, `42bdae4` | automated | MET (the book is in memory: `WP300-PERSIST`) |
| WP-300b | `05535ae` | ACCEPT | — | MET |
| WP-300c | `7e05702` | r4; G1 discharged by the user's 2026-10-02 ruling (ADR-032) | — | MET; `WP300C-OBLIGATIONS` carried |
| WP-310 | `fdf27ff` | joint ACCEPT r3, `163d186` | automated | MET |
| WP-320 | `ed6e5a0` | joint ACCEPT r5, `fed6ec1`; r6, `8747c25` | security-review | MET |
| WP-330 | `c1e6909` | joint ACCEPT r5, `83ea906` (opened split, then reconciled) | security-review | MET (L1, L2) |
| WP-340 | `73e1ba2` | joint ACCEPT r2, `e0c4bb9` | review | MET WITH QUALIFICATION. Criteria 1-2 include the scripted `WP340-F1` releases (N4), assume surviving state (N3), and hold only for on-grid sizes under a mock that books requested economics (N1) |

**Dependencies.**
- Every `depends_on` edge landed on `main` before its dependent, and is inside the dependent's branch (A §2.3).
- `WP-300`'s authorization commit `b94cc26` is not inside its branch, but the branch's first commit (16:15) post-dates the authorization (15:52). That is not a defect.
- The Wave 3 preconditions held before `WP-260` started: `VENUE-3` merged at 2026-09-30 00:02, and the authorizing commit `8de4828` landed at 09:45 (F §3.7).

**Side and hardening rounds** (A §4, all with SHA, CI and review verified):
- **MET:** 37 rounds, including `CI-5`, `CI-6`, `CAP-1`, `CONTROL-2`, `ROLLOVER-1`, `RTDS-RETIRE`, `VENUE-SETL-1`, `FLAKES-1`, `FLAKE-KS-1`, `AUDIT-SWEEP`, `TC-LOWS-1`, `GOV-NOTES-1`/`2`/`3`, `DEPS-2`, `DEPS-3`, `TRADER-SIGNALS` and `VENUE-4`.
- **MET, with a record gap:** `ADR033-REVIEW` (`47575cf`) has no row in the brief.
- **MET WITH QUALIFICATION:** `CKPT-1`. Its PostgreSQL restore does not store the RNG lanes or the status. The user ruled it on 2026-10-04 (`CKPT1-PG-RNG-STATUS`, option 1).

**Phase-3 YAML entries that are not runbook §8 packages, and stay open:** `HOST-BENCH` (Ready), `HOST-1`, `BURN-IN`, `SCALE-8` and `REFDIET`.

**Drift** (D §2):
- **Dependency direction:** `check:deps` passes (35 packages, 105 edges), and the checker and its contract are unchanged in Wave 3.
- **F6 holds:** only `packages/polymarket-secure` imports `@polymarket/client`.
- **Frozen records:** the frozen venue reports are untouched, and all 11 status-archive regions match their sha256 values.
- **Direct commits:** none of the 112 direct commits on `main` touches code.

## Blocking findings

**None.** No finding from any of the six auditors, or from my own re-checks, makes a §8 item NOT MET or contradicts a work-plan acceptance criterion. "Where the auditors disagreed" explains why E's two MEDIUMs are not blocking.

## Non-blocking findings (each needs an owner recorded)

Rows marked **no owner** have no row in `IMPLEMENTATION_STATUS.md` today. Recording one is orchestrator governance; none needs code.

**MEDIUM**

- **N1 (E-01, F-02), the signed share size and the OMS share size disagree, and the mock hides it. No owner.**
  - **The mismatch:**
    - The adapter accepts a signed share amount rounded down to 2 decimals (`packages/polymarket-secure/src/venue-client.ts:282-291`, `:356-358`).
    - The OMS stores the unrounded ticket size (`packages/oms/src/order-manager.ts:2434`), and `identityMismatch` does not compare amounts (`:3027-3036`).
    - Reconciliation requires the venue's original size to equal that unrounded size (`packages/oms/src/reconciliation/identity.ts:64-71`).
  - **How the mock hides it:** the mock signs the rounded amount (`test/fault-injection/live/support/mock-clob.ts:886-896`) but books the request's size (`:396`, `:530`).
  - **E's probe** (`E-architecture-probes.test.ts`) submits BUY 5.009 at 0.5 through the real client, OMS, inventory and coordinator. When the mock books the signed size, an acknowledged order breaks with `ORDER_FACTS_MISMATCH`, and a lost response breaks with `SIGNED_IDENTITY_AMBIGUOUS` plus `ORDER_UNRESOLVED`. F re-ran it: 5 of 5.
  - **Reach:** no share-precision rule exists. `readTicket` accepts any positive amount (`order-manager.ts:3301`), Static Bracket reads `size_shares` as any positive value (`packages/strategies/static-bracket/src/params.ts:547`), and no quantizer exists upstream (F §2.2). The shipped config's `"50"` is on the grid, so the defect is latent.
  - **Effect:** a fail-closed halt that strands reservations, with no duplicate exposure. The assumption is not among the disclosed A1–A9.
  - **Agent-closable fix:**
    - Set one executable quantity before reservation and signing, or refuse a signed quantity that differs from the ticket before transmission.
    - Make the mock derive its book from the signed amounts.
    - Keep E's probe as a regression test, in both the acknowledged and the lost-response arms.
  - **Owner:** a `packages/oms`, `packages/polymarket-secure` and `test/fault-injection/live` round, before or with `V2-5`. The SDK 0.12.x upgrade re-pins this exact rounding table (`venue-client.ts:282-291`).
- **N2 (E-02, F-02), the live OMS cannot carry FAK or FOK, which ADR-007 §8 requires and the shipped PAPER config uses. No owner.**
  - **The config:** `infra/compose/trader/trader.config.example.json:126` sets `"immediate_order_type": "FAK"`, with `"order_validity_ms": 30000`.
  - **ADR-007 §8** (`docs/adr/ADR-007-signed-order-idempotency-and-unknown-submissions.md:163-167`) says a lifetime below the GTD floor "must be handled by FAK/FOK or by cancel-on-deadline", and calls these "consequences the OMS must implement". The ADR lists `WP-270` as an implementer (`:6-8`).
  - **The OMS has neither:**
    - The ticket infers GTC or GTD from the expiration (`order-manager.ts:3017-3036`).
    - The adapter rejects any other order type (`venue-client.ts:350`).
    - The SDK port exposes only `createLimitOrder` (`sdk-port.ts:17-29`).
  - **E's probe** gives `{"paperSelection":"FAK","omsSignedOrderType":"GTC"}`, and the same for FOK.
  - **Disclosure:** `WP-270.md` and the brief say nothing about it.
  - **The broader seam:** the core loop consumes `SimulatedOrder` and `SimulatedFill` (`packages/trading-core/src/loop.ts:272-307`), and the simulation port requires `venueClass: "SIMULATED"` (`packages/simulation/src/ports.ts:454-455`). So the claim that one core runs PAPER and live is unevidenced at this seam.
  - **Agent-closable fix:**
    - Now: a disclosure row.
    - Then: an ADR-007 §8 implementation inside the ADR-022 D10 core-hook grant. It carries an explicit, persisted time-in-force from the plan through the OMS to the SDK surface, and refuses an unsupported selection before signing.
    - Add a composed FAK-remainder case and a FOK partial-liquidity refusal case.
  - **Deadline:** before any mode above PAPER, and before `WP-350` is requested.
- **N3 (A F1), the crash-recovery evidence assumes durable state that does not exist yet. No owner for its unowned half.**
  - **The assumption:** the harness "universe" carries the OMS store, the ledger and the inventory across every crash (`test/fault-injection/reconciliation/support/harness.ts:8-9`), and so does WP-340's harness.
  - **What the product has:**
    - the OMS store is `MemoryStore` only, with no adapter on `0005` and no AEAD cipher (`WP-270.md:87,103`; phase-3 report `:444-447`);
    - the inventory is in memory only (`WP300-PERSIST`);
    - the trader's ledger is in memory only.
  - **What is tracked:** only the inventory half. `grep -cE "0005|AEAD|OmsStore" IMPLEMENTATION_STATUS.md` returns 0. The ledger-survival assumption is stated nowhere.
  - **Fix:** one brief row that gates any restart-safe or live composition on four things: the `0005` store with AEAD; `WP300-PERSIST`; a ledger rebuild from durable rows with fill links; and re-running the WP-290 and WP-340 crash suites against that composition.
- **N4 (`WP340-F1`, A F2, B F-1, D-9), a late `LIVE` event after FILLED or CANCELED halts the market.** It has three routes, one of them fault-free. Safety holds, and liveness does not. The user ruled it on 2026-10-05 (brief `:304`), and its owner is a pre-live ADR, then a `packages/oms` round. **It must stay attached to any statement that the Wave 3 fault suite "passes".**
- **N5 (D-10), six PAPER-quality MEDIUMs are carried from CLOSEOUT-2:** `CO2-N3`, `CO2-N4`, `CO2-N6`, `CO2-N7`, `CO2-N11` and `UNIV4-R1`. Wave 3 touched none of them, and each has an owner row (brief `:297-302`, `:330`).

**LOW**

- **L1 (C-2, A F4, B F-2, D-2), WP-330's real-PostgreSQL suite runs in no gate. No owner.**
  - **The suite:** `pnpm --filter @polymarket-bot/ops-cli test:integration`, 6 tests: the shipped bundle, the lease revocation, and the audit mirror.
  - **It is not wired:** it is absent from the root `test:integration` (`package.json:20`) and from `ci.yml` (`grep -c ops-cli` gives 0). Its own config calls wiring it "an orchestrator follow-up" (`test/integration/ops-cli/vitest.config.ts:9-10`). It is the only package `test:*` script that no gate reaches (C, and F §3.3).
  - **Agent-closable fix (one CI round):** chain it as integration 9/9, add the CI step, and extend `ci-step-split.test.ts` so that any package `test:integration` script missing from the chain fails.
- **L2 (F-01, F-03), the emergency runbook tells operators to discard a line that can hold a completed cancel. No owner.**
  - **The text:** `docs/runbooks/emergency.md:219-221` says a line that does not parse "records nothing done". Under `CX330-R5-01`, a concurrent interleave can bury a completed cancel's `ACTING` or `OUTCOME` record inside such a line.
  - **The agreed fix was never applied:** the `reconcile:WP-330:r5` record names this correction (I confirmed it in `wf_cefb8c08-71b/journal.jsonl`), but the file's last commit is the candidate `83ea906`.
  - **The handoff omits the split:** `WP-330.md:84` does not say that r5 opened split.
  - **Agent-closable fix:** a docs round that corrects the paragraph and adds a "Corrected" line to the handoff.
- **L3 (D-3), `WP-340` follow-up 3 has no brief row.** It is the venue round that must observe mock assumptions A1, A2, A3, A8 and A9, and the S-D17/S-D18 conflict. Items 2 and 3's "against mocks" evidence rests on these. **Owner:** `VENUE-5`, `V2-11`, or a venue round before live.
- **L4 (A F3), CKPT-1's PostgreSQL restore does not store the RNG or the status.** Ruled, and deferred to the first real restore.
- **L5 (D-1, B F-3, A F5), the brief misstates what is open, in both directions.** Examples:
  - `N8` (`:333`) still lists WP-240 M-1 and M-3, which `CONTROL-1` closed;
  - `B4` and `B5` (`:269-270`) are stale, and `:444` contradicts `:458` on paper fills;
  - `WP320-FOLLOWUPS` (`:283`) and `WP270-DECISIONS` (`:294`) list items that `CI-5` and `CI-6` already did;
  - "Last updated: 2026-09-30" (`:3`), and the start-of-wave "Next" (`:33-35`);
  - `ADR033-REVIEW` has no row.
- **L6 (D-2), Wave 3 follow-ups with no row:**
  - `TS-R1-01` and `TS-R1-02`;
  - `CI6-R1-L1`;
  - `VENUE4-R3-01` and `-02`;
  - the node job's timeout margin of 1.6-2.4×, against `CI-2`'s 6× rule;
  - `CI-5` follow-up 1;
  - `GOV-NOTES-3` follow-up 2.
- **L7 (D-4), `CADENCE-1`'s `db/migrations/0010` grant was not ratified the `protected-contracts.md` §5 way.** The grant exists and the change is additive, but the work-plan entry still forbids the path (`workplan.yaml:1457`).
- **L8 (D-5), every Wave 3 handoff record was added after its merge,** against `protected-contracts.md` §2 (`:52`) and §6 (`:187`). The practice predates Wave 3. Either the contract text or the practice should change.
- **L9 (D-6, A F5), the ADR headers and index are stale.**
  - `docs/adr/README.md:107-114` says "(not yet)" for merged rounds.
  - These headers still read "not yet": ADR-026 `:6`, ADR-031 `:16`, ADR-033 `:14` and ADR-007 `:6-8`.
- **L10 (D-7), the open venue-fact register in `protected-contracts.md` §8 has not moved since Wave 1.** C-5…C-23 and U-13…U-48 live only in the dated reports.
- **L11 (D-8), the offline venue gate still validates the 2026-08-24 snapshot** (`apps/ops-cli/src/verify-venue/checks.ts:69,250`). Both named owners, `WP-330` and `WP-270`, completed without updating it, and the `protocol-v2` `.jsonc`/`.jsonl` fixtures sit outside it. `V2-11` is the natural owner.
- **L12 (C-1), local `TC-LOCAL-FLAKE`:** integration step 5/8 failed in setup (`containers.ts:158`, before any trader existed), then passed 409/409 when re-run alone. CI passed it on the first attempt. Under `&&`, such a flake hides steps 6/8 to 8/8.

**INFO**

- **I1 (A F6, F-04):** ADR-033 D1–D4 and D6 are the orchestrator's acceptance, not the user's. Only D5 is the user's ruling.
- **I2 (B F-5, D-11):** the ceiling is enforced in different ways. Any live composition must own a startup ceiling check for `ops-cli` and WP-260's gate.
- **I3 (B F-6):** there is an untracked `.env` in the main checkout. The user may want to confirm that it holds no signer material.
- **I4 (C-3):** the audit gate passes with 2 moderate advisories (`DEPS1-VITEST`). A newly published advisory can turn `main` red with no code change (runs `37412091860`, `37403214345`).
- **I5 (C-4):** two stale CI step labels (`ci.yml:262`, `:270`).
- **I6 (C-5):** the compose and Python jobs are evidenced by CI `37414895013` only.
- **I7 (A F7, A F8):**
  - the handoff fields differ from `docs/handoffs/README.md` item 9;
  - `WP-310`'s merge includes an orchestrator conflict resolution, which was disclosed and verified by running it.
- **I8 (D-12):** the brief grew from 86,846 to 110,842 bytes in Wave 3, against `CLAUDE.md`'s "keep … brief".

## Open Wave 3 scope: the Protocol V2 migration

**Status.**
- The user folded it into Wave 3 on 2026-10-05 (brief `:69`).
- **Merged:** only `VENUE-4` (`f925a43`).
- **In flight, not merged:** `V2-0` and `V2-2` (brief `:236-237`; neither branch is an ancestor of `fdc3430`).

**The plan:** `docs/venue/protocol-v2-migration-plan.md:47-53` and `:144-152`.

| Package | Class | Done by | State at `fdc3430` |
|---|---|---|---|
| `V2-0`: the ADR amendments, and the record of D5 option 1 and the ADR-001 rule | D, gates A | 2026-10-09 (§5 items 1-3) | running |
| `V2-1`: admission and identifiers | A | **2026-10-20** | not started (after `V2-0`) |
| `V2-2`: the market-data path and recorded-data readers | A | **2026-10-20** | running |
| `V2-3`: V2 resolution | A | **2026-10-28** | not started (after `V2-1`) |
| `V2-4`: the Data API v1 guard (optional; the grep is the minimum) | B | 2026-10-23 | not started. No tracked code calls Data API v1 (D §5) |
| `VENUE-5`: observe the first V2 window of series 10192 | D | within a day of that window | — |
| `V2-5` SDK 0.12.x, `V2-6` account reads, `V2-7` inventory and wallet operations, `V2-8` cancel paths (a security-review gate) | C | before any mode above PAPER | not started; needs authorization |
| `V2-9` fixtures, `V2-10` simulation fidelity, `V2-11` documents and registers | D | alongside; `V2-10` before `WP-360` | — |

**The dates.**
- **2026-10-24: Data API v1 retires.** This is documented. F re-fetched the official migration page on 2026-10-06, and it still says so (F §3.2).
- **2026-10-30:** class A merged.
- **About 2026-11-02: the switchover.** This date comes from the announcement only. No official page states it, so it could come earlier (plan `:55`; F-05).
- **From then:** admission refuses every V2 window, and PAPER on the series stops (failing closed) until class A is merged and running.

**How the findings meet V2:**
- N1's code is the rounding table that `V2-5` re-pins.
- N2's adapter surface is `V2-5`'s.
- L3's venue checks belong with `VENUE-5` or `V2-11`.
- I recommend recording N1 and N2 owners before `V2-5` starts, so the SDK upgrade does not bake in the mismatch.

## Where the auditors disagreed, and how I resolved it

1. **The wave as a whole: E said INCONSISTENT; A–D said nothing blocks a §8 item.**
   - **What I checked:** I re-read every line E cites for E-01 and E-02 (listed under N1 and N2). I confirmed the shipped config's FAK and ADR-007 §8 myself. F reproduced both probes, 5 of 5.
   - **Ruling: both are real MEDIUMs, not blocking, and each needs an owner.** CLOSEOUT-2 held its wave on X1 because X1 was reachable in the running PAPER pipeline and contradicted an acceptance criterion (WP-230 #4). Neither holds here:
     - no composed process reaches the OMS or the adapter;
     - E-01 fails closed, and E-02 is a missing capability;
     - no §8 item and no work-plan criterion is contradicted. ADR-007 §8 is an Accepted-ADR duty that is unimplemented and undisclosed, which is why N2 needs an owner and a disclosure, not a hold.
   - **How they bound the grades:** both narrow A's WP-290 and WP-340 recovery grades, and the "same core, PAPER to live" claim. The matrix carries those bounds.
2. **The severity of the ops-cli suite gap: C said MEDIUM; A, B and D said LOW.**
   - **Ruling: LOW, with a mandatory owner (L1).**
   - **Why:** C is right that a bundle, lease or mirror regression would not turn CI red. But every WP-330 criterion has a gated unit test (A §3.2), and item 3's cancel path is gated by fault 6/6. So the risk is future silent rot, not a gap in this closeout's evidence.
3. **Item 1: B said MET WITH QUALIFICATION; D's "no open HIGH or MEDIUM" implies MET.**
   - **Ruling: MET WITH QUALIFICATION.**
   - **Why:** the reviews are resolved, as F confirmed from the raw journals. The qualification is what they left: the open LOWs, the unapplied doc fix L2, and the pre-live ADRs. `WP340-F1` belongs to a `review` gate, not a security review, so it does not qualify item 1.
4. **Item 2: B said MET WITH QUALIFICATION; C said MET "on gate evidence".**
   - **Ruling: MET WITH QUALIFICATION.**
   - **Why:** C graded the gate alone. B's qualifications (the F1 releases and A1–A9) and E's undisclosed mock-economics assumption are evidenced.
5. **Item 3: B said MET WITH QUALIFICATION; C said "gated against mocks"; E said "supported for mocks".**
   - **Ruling: MET WITH QUALIFICATION.** The item asks only for mocks, and that is met. The qualification records that no deployable credential route exists, and must not be read as one.
6. **The release and pin counts: A said 287 releases and four `it.fails`; B said 284 releases and cited three line numbers.** Both are consistent: 284 suite releases plus 3 driver controls, and one site is a loop over two variants (F §3.5).
7. **The V2 branch heads differed between auditors.** A saw no commits; B and D saw `v2-0` at `813ba37`; F saw `5d36cd7` and `5fdbd5d`; I see `5d36cd7` and `212d5aa`. This is timing only. Neither branch is merged.
8. **The task packet listed "ADR-033 D1–D4 and D6 accepted" among the user's rulings.** The ADR says the orchestrator accepted them (`ADR-033…md:3`). I attribute them to the orchestrator (I1).
9. **The packet said `WP-350` to `WP-370` carry human-approval gates.** The work plan gives `WP-350` and `WP-370` the gate `human-approval` (`workplan.yaml:1247`, `:1293`), but gives `WP-360` the gate `external-evidence` (`:1270`). I report the YAML values.

## Runbook §10 step 10: exact packages now unblocked

**Method.** I extracted `depends_on` and `gate` for all 50 work-plan packages myself and checked each dependency against `main`'s first-parent merges. Eight packages are unmerged. F's §5 reached the same table.

| Package | depends_on | Dependencies merged? | Gate (YAML) | Status after this closeout |
|---|---|---|---|---|
| `WP-350` Execution-probe planner and hard caps | `WP-340` | **yes** (`73e1ba2`) | `human-approval` (`:1247`) | **Dependency-eligible only. Not startable** without the user's explicit approval. "Execution-probe gate: Not requested" (brief `:503`); the §8 Critical rule; AGENTS.md (no real-order test, nothing above PAPER) |
| `WP-360` Fill, slippage, cancel and markout calibration | `WP-210`, `WP-350` | no (`WP-350`) | `external-evidence` (`:1270`) | blocked. `V2-10` must also come first (plan `:152`) |
| `WP-370` Live-micro promotion report and gate | `WP-360` | no | `human-approval` (`:1293`) | blocked |
| `HOST-BENCH` | `LEAN-GOV` | yes | `external-evidence` | already "Ready". It does not depend on Wave 3 |
| `HOST-1`, `BURN-IN`, `SCALE-8`, `REFDIET` | the `HOST-BENCH` chain | no | external-evidence / automated | blocked; none depends on a Wave 3 package |

**The exact answer:**
- Closing Wave 3 makes exactly one package dependency-eligible: **`WP-350`**.
- **No package becomes startable without a user decision.**
- If the user ever requests `WP-350`, these must be settled or owned first: N1, N2, N3, N4, ADR-033 D5's build, and V2 class C (`V2-5` to `V2-8`).
- The `V2-*` packages are not YAML packages. They are authorized or queued under the user's 2026-10-05 fold, independent of this closeout.

## What the qualifications require

1. **Orchestrator governance (docs only).**
   - Add owner rows for N1, N2, N3, L1, L2, L3 and L6's list.
   - Add a row for `ADR033-REVIEW`.
   - Correct the stale cells in L5.
2. **Agent-closable rounds, none blocking:**
   - a CI round for L1 (integration 9/9, plus the drift pin);
   - a docs round for L2;
   - an `oms`/`polymarket-secure`/mock round for N1, before or with `V2-5`;
   - an ADR-007 §8 implementation for N2, under the ADR-022 D10 core-hook grant, before any mode above PAPER.
3. **The V2 class-A dates:** `V2-0` by 2026-10-09; `V2-1` and `V2-2` by 2026-10-20; `V2-3` by 2026-10-28; class A merged by 2026-10-30. Re-run the Data API v1 grep on 2026-10-23.

No re-audit of the six §8 items is needed. They stand as graded here.

## Audit confidence

- **HIGH on items 4, 5 and 6, the gates, and the merge and CI SHAs.**
  - At least two auditors executed or re-derived each one independently.
  - I re-checked `main` = `fdc3430`, CI `37414895013` = `success`, and the V2 branches as unmerged.
- **HIGH on items 1-3 and their qualifications.**
  - F read the raw review journals, and I re-read the WP-330 r5 split.
  - B's mutants show the cancel test is not vacuous.
  - The fault chain was run by B and C and in CI.
- **HIGH on the facts of N1 and N2.**
  - E's probe was reproduced by F, and I re-read the code at the cited lines.
  - They were shown against the fake SDK and the mock. No real venue response was observed.
- **MEDIUM on grading N1 and N2 as not blocking.** This is a judgement call. The user may hold the closeout on them instead. If so, N1's fix and N2's disclosure row are each one bounded, agent-closable step.
