# Architecture Decision Records

Owner: `WP-030` (initial set). Path `docs/adr/**` is a global **protected path**
(`docs/spec/polymarket-bot-workplan.yaml` → `protected_paths`).

These records document decisions that are already **locked** by
`docs/spec/polymarket-bot-orchestrator-handoff.md` §2 and §20. Per handoff §20:

> ADRs document the locked decision and evidence. They are not an excuse to
> reopen every design choice.

An ADR may refine an implementation detail the handoff leaves open. It may not
silently override the handoff (`AGENTS.md`, Authority).

---

## Source precedence (handoff §1.1)

1. Current official Polymarket API documentation and current official SDK
   behavior — for **venue facts**.
2. This implementation handoff — for **product architecture and system
   invariants**.
3. Accepted ADRs in `docs/adr/`.
4. Versioned domain contracts in `packages/domain` and database migrations.
5. Executable tests and fixtures.
6. The original product design document — rationale and historical context.

Consequences for every ADR in this directory:

- **No ADR asserts a venue fact on its own authority.** Every venue statement
  cites `docs/venue/verified-2026-08-24.md` by section. That report is the
  in-repo authority for venue facts as of its verification date, and it is
  itself a dated snapshot that must be re-verified at the start of each
  implementation phase (handoff §1.2).
- Items the verification report marks **UNVERIFIED** (`U-n`) or as a
  **conflict** (`C-n`) are carried into the relevant ADR *as unverified*. They
  are never restated as settled behavior.
- An ADR that needs a venue fact the report does not contain records it as a
  gap for the next verification round. It does not fetch venue documentation
  and it does not guess.

**One narrow exception, added 2026-08-28 by `GOV-1B` and stated so it is not
re-derived case by case.** A **ratifying** ADR may record a venue fact that a
work package's own **mandated** verification obtained from *current official*
documentation — the case ADR-002 §8.3 created when it required `WP-070` to
confirm C-1/U-1 before `WP-150` could rely on it. This is not a weakening of the
rule above, and it is bounded by all four of:

1. **Handoff §1.1 already ranks current official documentation above the in-repo
   report**, so the ADR still asserts nothing on its own authority.
2. The record carries the **URL, the retrieval date, and verbatim quotes**, and
   distinguishes documentary confirmation from observation. An observational
   claim still requires real evidence (`AGENTS.md`).
3. The frozen report is **still cited** for the item's origin and prior status,
   and is **not edited** (`docs/contracts/protected-contracts.md` §2).
4. The **gap is still recorded** for the next verification round: a source the
   frozen report's index does not contain must enter the next dated report.

An ADR that merely *wants* a venue fact still does not fetch one.
[ADR-013](./ADR-013-book-price-change-absolute-size-confirmed.md) §7 is the
first use. The second is the 2026-09-02 amendment to
[ADR-009](./ADR-009-settlement-spec-and-payoff-model-selection.md) §5,
recording `WP-110`'s mandated 2026-08-28 confirmation of U-6 (the case
ADR-009 §5.2 itself created); its amendment block states how each of the four
conditions is met. The third is the 2026-09-03 amendment to
[ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) §7, resolving
conflict **C-2** (USDC vs pUSD denomination) — the case ADR-006 §7 item 4
itself created; it likewise walks all four conditions. That amendment also
records the one respect in which its fit is imperfect and which a reader
should not generalize from: item 4's mandate named `WP-200`, whose grant made
both the fetch and the amendment impossible, so the **contract owner executed
the same mandate in that package's place** rather than let it lapse. *(This
sentence previously read "the first and, so far, only use"; corrected
2026-09-02 per `protected-contracts.md` §4, and extended 2026-09-03.)*

---

## Index

| ADR | Title | Status | Primary handoff sections | Implemented by |
| --- | --- | --- | --- | --- |
| [ADR-001](./ADR-001-exact-decimal-representation.md) | Exact decimal representation; §8 amended 2026-10-05 (`V2-0`): item 6, the bounded binary64 rule for Data API v2 sizes read through the SDK (the domain D checked on the SDK's string, aliases and underflow accepted, everything outside D refused with the whole read, the 2^-23-share bound), ruled by the user | Accepted | §2, §6.1, §7.3 | `WP-020` (done); §8 item 6: `V2-6` (not yet) |
| [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) | Event envelope and ordering semantics | Accepted | §7.1, §7.4, §8 | `WP-020` (done), `WP-070`, `WP-120` |
| [ADR-003](./ADR-003-gateway-to-trader-transport.md) | Gateway-to-trader transport | Accepted | §2, §9.1, §4.2 | `WP-060` |
| [ADR-004](./ADR-004-wal-format-durability-and-compaction.md) | WAL format, durability, and compaction | Accepted | §9.1, §12.5 | `WP-050`, `WP-130` |
| [ADR-005](./ADR-005-strategy-purity-and-decision-result.md) | Strategy purity and `DecisionResult` contract | Accepted | §6.2–6.3, §7.5–7.7, §9.6 | `WP-020` (done), `WP-170` |
| [ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) | Actual ledger versus virtual allocation; §7 amended 2026-09-03 — C-2 (USDC vs pUSD) **resolved as a documentation inconsistency**, denominations stay distinct; §7 amended again 2026-09-04 (`GOV-2A`) — the deferred `WP-200` conformance ratification **closed against merged `7e75f9a`** on executed probes | Accepted | §6.7–6.8, §9.15, §9.16 | `WP-040`, `WP-200` |
| [ADR-007](./ADR-007-signed-order-idempotency-and-unknown-submissions.md) | Signed-order idempotency and unknown submissions | Accepted | §6.6, §9.11, §9.17 | `WP-260`, `WP-270`, `WP-280`, `WP-290`, `WP-310` (done, PAPER only); §8's FAK and FOK: `CO3-N2` (not yet); the durable signed-order store: `CO3-N3` (not yet) |
| [ADR-008](./ADR-008-live-writer-fencing-and-heartbeat-health-lease.md) | Live-writer fencing and heartbeat health lease | Accepted | §6.16, §9.18, §4.2 | `WP-320`, `WP-330` |
| [ADR-009](./ADR-009-settlement-spec-and-payoff-model-selection.md) | `SettlementSpec` and payoff-model selection; dated notes 2026-10-05 (`V2-0`): §8, a journaled `/v2/resolutions` row may publish a resolution in PAPER (ADR-030 Amendment 2, rule 5), its micro-USDC payouts compared as fixed integer vectors with no amount taken, and its `resolvedAt` the row's observed `resolved_at`; §5, U-11 for Protocol V2 | Accepted | §9.2, §9.3, §6.9 | `WP-110`; the row: `V2-3` (not yet) |
| [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) | Run-mode enablement and production key boundary; §4 note 2026-10-05 (`V2-0`): the SDK's scope per surface, ruled by the user (trading and account reads on the SDK inside `polymarket-secure`; public market data on our own clients; no change to §9.12 or F6) | Accepted | §0.2, §11, §6.16–6.18, §15 | every package; gated by `WP-350`/`WP-370` |
| [ADR-011](./ADR-011-one-live-owner-per-market-policy.md) | One-live-owner-per-market policy | Accepted | §2, §6.11, §9.7 | `WP-040`, `WP-180` |
| [ADR-012](./ADR-012-simulation-fill-model-evidence-hierarchy.md) | Simulation fill-model evidence hierarchy | Accepted | §12.2–12.5, §17 | `WP-210`, `WP-360` |
| [ADR-013](./ADR-013-book-price-change-absolute-size-confirmed.md) | Book `price_change` carries absolute aggregate size, with zero removal (C-1/U-1 ratified) | Accepted | §9.4, §23, §1.1–1.2 | `WP-020` (done, unchanged), `WP-070` (done), `WP-150` |
| [ADR-014](./ADR-014-taker-side-names-the-aggressor-order-side.md) | `takerSide` names the aggressor order's own side | Accepted | §7.4 | `WP-020` (done, unchanged), `WP-070`/`WP-090` (conform), `WP-080` (follow-up owed) |
| [ADR-015](./ADR-015-repository-identifier-bound.md) | The repository identifier bound is boundary hardening, not a venue narrowing | Accepted | §7.2, §7.3, §8.3 | `WP-020` (done, unchanged), `WP-070` (done), every adapter |
| [ADR-016](./ADR-016-ratified-inferred-domain-shapes.md) | Ratification of the four unratified `domain.md` §8 inferences (R-3); §2 amended 2026-09-02 — external UUID-shaped input is **refused**, not case-folded (R-8) | Accepted | §7.2, §7.4, §14.4 | `WP-020` (done, unchanged); every future external input surface |
| [ADR-017](./ADR-017-dataset-manifest-and-retention-receipt-artifact-contract.md) | Dataset-manifest and retention-receipt artifact contract (two digest roles; `nullable` = Parquet repetition; strict-JSON profile; receipt = reporting, not proof) | Accepted | §8.4, §12.5, §10.2 | `WP-130` (done, unchanged) |
| [ADR-018](./ADR-018-app-local-esbuild-runtime-build-convention.md) | Workspace apps that must run use an app-local esbuild bundle (ESM default; CJS where a CJS-only dependency forces it) | Accepted | §2, §5 | `WP-120`/`WP-130` (done, unchanged); `apps/trader` and later apps |
| [ADR-019](./ADR-019-soak-evidence-threshold-policy.md) | Soak-evidence threshold: 24 contiguous hours, one window, no summing | Accepted | §16.7, §17 | `WP-140` (done, unchanged) |
| [ADR-020](./ADR-020-schema-parse-boundary-integrity.md) | A schema parse result is not clean data: every caller/wire-input boundary parses through a prototype-free door (`zod@4.4.3` reads its own state and the input's properties through the prototype chain) | Accepted | §6, §7, §7.5, §9.15, §11 | `WP-180`/`WP-190` conform; staged owners in [`docs/contracts/schema-boundary.md`](../contracts/schema-boundary.md) §5 |
| [ADR-021](./ADR-021-strategy-instance-id-is-a-uuidv7.md) | `strategyInstanceId` is an identity typed `Uuidv7Schema`; `packages/risk`'s `CodeString` typing was a mis-typing. DISCHARGED 2026-09-07: risk re-typed (`WP-180-FU3` `8c14b47`), the allocator door the original text missed (`ALLOC-1` `d9f70a6`), and the trader's intersection startup refusal replaced by the real `Uuidv7Schema` (`TRDR-1` `65ae56c` — a simultaneous widening and version/variant tightening; two dated amendments) | Accepted | §10.3 | resolves `WP-230` accepted residual 1 |
| [ADR-022](./ADR-022-shared-trading-core-is-a-layer-1-package.md) | The shared trading core (`createPaperTrader` / `CoreLoop` and their import closure) is a layer-1 package, `packages/trading-core`, that both composition roots build. §4.1 describes deployable processes, not where code lives. The PAPER ceiling is kept. Recorded by `H8-GOV` under the user's H8 ruling (option A, 2026-09-28). DISCHARGED 2026-09-28 by the four H8-track merges: `H8-GOV` `bb58edb`, `DEPCHECK-1` `d7f2906`, `CORE-MOVE` `33b7d0b` (35 packages / 89 edges) and `BACKTEST-2` `fd12be0` (35 / 90; one venue builder; B3 CLOSED). S18's sunset and the facade retirement stay open | Accepted | §2, §4, §4.1, §5, §12.1 | `CORE-MOVE` (done, `33b7d0b`), `BACKTEST-2` (done, `fd12be0`) |
| [ADR-023](./ADR-023-book-freshness-by-delivery-session-liveness.md) | Book freshness by delivery-session liveness, not by the last change: under the opt-in `bookFreshness: CONNECTION_CONFIRMED`, a book is vouched for by the latest confirmation of its delivery session, from a frame the trader has proven whole. A per-book ceiling bounds the extension, and a process-lag guard narrows it for a lagging trader. Any market-less incident taints the gateway epoch, and the rule then falls back to the last change. | Accepted (ratified by the user 2026-10-02) | §6 (invariants 9, 12, 15), §7.1, §8.1, §9.5, §9.8 (check 7), §9.9 | `THROUGHPUT-1c`; Amendment 1 (`GOV-NOTES-3`, 2026-10-05: the market-less incident reference id, an interim ruling) |
| [ADR-024](./ADR-024-evaluate-once-per-venue-frame.md) | The trader evaluates once per venue FRAME (one gateway raw frame, keyed by `causationId`), after the frame's last event, instead of after every event. One decision per callback (§7.5, ADR-005) is kept, and every event is still applied. No half-applied book state is evaluated. The gateway publishes a frame atomically, and the trader never splits one across reads | Accepted (ratified by the user 2026-09-30) | §7.5, §9.6 | `THROUGHPUT-2` (done, `7d59fd3`) |
| [ADR-025](./ADR-025-laptop-paper-host-profile.md) | The laptop PAPER host profile: every process on one dedicated laptop; the filesystem store plus B2 as §2's "object storage"; the Redis retention set from measurement; the §9.1 p99 measured on this host; under $100/mo; PAPER only, superseded before any live mode. A6 (several traders) is open until `SCALE-8`. Recorded by `LEAN-GOV` under the user's ruling H (2026-09-30) | Accepted | §2, §4, §4.2, §9.1 | `HOST-BENCH`, `HOST-1`, `BURN-IN` (not yet) |
| [ADR-026](./ADR-026-evaluation-cadence.md) | Evaluation cadence: at most one `onFeatures` evaluation per market per 1 s of event time (a high-water-mark clock), plus a 5 s heartbeat; every other callback is never delayed; pinned per run, and every new run uses 1 s and 5 s (the per-frame cadence only in a historical replay). Amends ADR-024 D3 and §8.1. A coalesced market is not evaluated, so no record is owed; §6 invariant 3, §7.5 and §9.6 are kept. Ruling A1 (2026-09-30) | Accepted | §6, §7.5, §8.1, §9.6, §12.4 | `CADENCE-1` (done, `8d7086a`) |
| [ADR-027](./ADR-027-checkpoint-on-change.md) | Strategy checkpoints only on a defined transition (state, status or RNG change, start, stop), plus a 60 s heartbeat; the RNG cursor and callback sequence stay recoverable. Ruling A2 (2026-09-30) | Accepted | §9.6, §12.4 | `CKPT-1` (done, `891ccdd`); the PostgreSQL RNG and status columns: `CKPT1-PG-RNG-STATUS` (not yet) |
| [ADR-028](./ADR-028-raw-retention-with-pins.md) | Raw WAL deleted after 72 h once the research tier and every covering pin are verified; fill windows pinned forever, intent, refusal and halt windows for 30 days; a new retention-receipt basis; the file must match the source-segment digests pinned in the research-tier manifest before deletion (ADR-017 §1's roles kept); `maxTotalBytes` a hard stop. Amends §2, §8.4, §9.1, §12.4, §12.5, ADR-004 §5, ADR-017 §4, the provenance clause of ADR-017 §1, and `WP-130`'s acceptance. Re-ruled before Phase 4. A3b not taken. Ruling A3 (2026-09-30). Amended 2026-10-01 (`STORAGE-GOV`, Amendment 1): records the retention-safety rules `STORAGE-1` implemented, and where it stops short of this ADR | Accepted | §2, §6, §8.4, §9.1, §12.4, §12.5 | `STORAGE-1` (done, `a22502b`) |
| [ADR-029](./ADR-029-approximate-dataset-class.md) | The approximate dataset class: `fidelity: approximate` in the dataset manifest (version 2); never determinism, calibration, promotion or soak evidence; ranked below every ADR-012 tier. Ruling A4 (2026-09-30) | Accepted | §6, §8.4, §12.4, §12.5 | `STORAGE-1` (done, `a22502b`), `APPROX-REPLAY-1` (done, `86830d9`) |
| [ADR-030](./ADR-030-series-auto-admission-and-multi-window-runs.md) | Series auto-admission and multi-window runs: a reviewed series admits each new window that exactly matches it, in PAPER only; one run spans many windows. Amends §9.2, the gateway's "no discovery" contract and the run boundary. NOT auto-approval for live trading. Ruling A5 (2026-09-30) | Accepted | §9.2, §9.6, §12.5 | `ROLLOVER-1` (`ae11daa`); Amendment 1 (`GOV-NOTES-3`, 2026-10-05: the admission policies, recorded as interim PAPER rulings and confirmed by the user the same day); Amendment 2 (`V2-0`, 2026-10-05: Protocol V2 ids selected by `version`, reviewed `acceptedProtocolVersions`, 32-byte condition ids at the CLOB and Data API, a journaled `/v2/resolutions` read, and rule 5, an interim PAPER ruling letting a resolved row publish, dated by its observed `resolved_at`; a pending row is read again, and a refused row or a disagreement raises the unresolved-window incident at once), for `V2-1` and `V2-3` (not yet) |
| [ADR-031](./ADR-031-admitting-entries-when-the-trader-lags.md) | Admitting entries when the trader lags the stream (`CO2-N1`): live admission judges an entry at the event's instant, so a backlog can admit entries after close. Frames options (a)-(e) and (b-entry). The user ruled (a): an entry guard on the process clock, through existing inputs (the features' age is the lag; seconds to close from the later instant). Entries only, by risk's disposition; replay unchanged at lag 0. Q1: existing refusal codes. Q2: exits as today; the question passes to the §9.9 Incident Controller round, and is answered before any mode above PAPER. Q3: the separate residual `ADR023-CLOCK-STEP` | Accepted (ruled by the user 2026-10-02) | §6, §8.1, §9.8, §12.1, §12.4 | the `CO2-N1` round (done, `9869e53`) |
| [ADR-032](./ADR-032-reconciliation-request-ids-carry-an-unguessable-token.md) | Wallet-operation reconciliation request ids carry an unguessable token from a required injected `requestToken` source, which the composition binds to a CSPRNG; `packages/inventory` stays free of randomness. Closes `WP300C-J1`, a held-back read of a predicted id. Ids are not reproducible across runs, so a journal or replay records the drawn tokens. `WP-290` echoes `requestId` and never answers with a read made before receiving the request | Accepted (ruled by the user 2026-10-02) | §9.14, §9.17, §12.4 | `WP-300c` (done, `7e05702`); D4's echo of `requestId` and its no-read-before-receipt rule: `WP-290` (done, `7a53988`, per its handoff); D3, D5 and D6: the composition round (not yet) |
| [ADR-033](./ADR-033-order-heartbeat-behind-a-port.md) | The order heartbeat (C-12): `WP-320` builds the controller behind an injected `OrderHeartbeatTransport` port. The controller keeps the id chain, the `400` recovery and the 5 s cadence of `POST /v1/heartbeats`, the route the venue documents for the 10 s cancellation (`VENUE-4`, H-3). It sends only for the fencing-token holder while the health lease holds, in a live-signer mode, at `ORDER_HEARTBEAT` priority. A lapse, 10 s on the monotonic clock after the last confirmed heartbeat was sent, sends every open order with a venue order id to reconciliation and blocks new entries. The block lifts only after a heartbeat confirmed less than 10 s after its send, and a passing reconciliation run that started at least 5 s after that confirmation. D5, the transport, was ruled by the user on 2026-10-05: option 1 (Amendment 1). `polymarket-secure` sends `POST /v1/heartbeats` itself, signed with the SDK's public `buildHmacSignature` and `credentials` getter: a named exception to "wrap only the SDK", for that route only, with a timeout, no retry beyond the §9.13 budget, and the `400` read under both `error_msg` and `error` (C-20). It lapses at the first stable SDK release with a public heartbeat method | Accepted for D1–D4, D6 (orchestrator, 2026-10-03); D5 decided by the user, 2026-10-05 (option 1) | §9.12, §9.13, §9.17, §9.18 | `WP-320` (D1–D4, D6; `ed6e5a0`); D5's transport: pre-live (not yet) |
| [ADR-034](./ADR-034-order-lifecycle-semantics-pre-live.md) | Order-lifecycle semantics before live, with the venue addendum `verified-2026-10-06.md`. D1 (`WP340-F1`; the user's ruling, venue-time ordering): the OMS receives the stream's `timestamp`. Two millisecond values compare by value, under a labelled assumption (A12: one venue clock and one rounding); a seconds instant, or a mixed comparison, is widened by one unit since the venue's rounding is undocumented. A LIVE-class observation older than the evidence that made its order terminal is recorded as stale, with no halt; a newer one halts, whatever the arrival order. A pair venue time can never order (equal milliseconds) halts at once. A pair that venue-timed evidence may still order (a terminal instant the venue's answer does not carry, or one in seconds) is held, with submissions paused, until that evidence orders it; a read made `orderingHorizonMs` after the hold halts it, and no read ever classifies stale. D2 (`CO3-N1`): one executable quantity, floored to the venue's 0.01 grid once in the execution planner, with the remainder recorded; the OMS and the adapter refuse off-grid amounts, and the adapter recomputes the signed amounts exactly by order kind. D3 (`CO3-N2`): a persisted time-in-force from the plan through the OMS, and the live-safety fence, to `createLimitOrder` (GTC, GTD) or a protected `createMarketOrder` (FAK, FOK), refused before signing when unsupported; ADR-007 §8 met by FAK, FOK or cancel-on-deadline, with an overdue cancel escalated to §9.9's "Account state unknown" and a latched heartbeat stop. D4 (`V2-10B`): FAK and FOK entry BUYs target pUSD, converted at the lower of the limit and the snapshot's best ask, floored to 0.01; the OMS debits and bounds each fill by its per-maker-leg spend, ends such an order at its answer with its final size from a read, and reconciles its identity under a labelled assumption (A11); the ledger books that spend as the principal, and the holding comparison expects it, with no tolerance. The money caps hold; the share caps cannot be hard for such a fill, so plan-time caps (proposed) or refusing such entries is put to the user. Exits trade the held position by the leg's exit side, floored to the grid; the residue is held to resolution, and the next entry is trimmed to the cap's headroom; the simulator's default flips | Proposed (2026-10-06); D1's additions and D4's share caps are put to the user, and D4.1's conversion basis to the orchestrator | §6, §9.9–§9.12, §13.2, §13.3 | not yet: `OMS-QTY` (D2), then `OMS-VENUE-TIME` (D1), then `TIF-COLLATERAL` (D3, D4), strictly in that order, proposed; D4 waits for the share-cap ruling |

Corrected 2026-10-06 (`RECORDS-W3`, `CLOSEOUT-3` L9): the Implemented-by cells of ADR-026, ADR-027, ADR-029 and ADR-031 read '(not yet)' for `CADENCE-1`, `CKPT-1`, `APPROX-REPLAY-1` and the `CO2-N1` round, which had merged. ADR-032's read 'the composition round and `WP-290` (obligations, not yet)', and ADR-007's read '`WP-260`, `WP-270`, `WP-290`'.

Companion contract documentation (not ADRs, same authority chain):

- [`docs/contracts/domain.md`](../contracts/domain.md) — the frozen `WP-020`
  domain and decimal contracts.
- [`docs/contracts/dependency-direction.md`](../contracts/dependency-direction.md)
  — the §5.2 dependency graph and its CI enforcement expectation.
- [`docs/contracts/schema-boundary.md`](../contracts/schema-boundary.md) —
  ADR-020's normative companion: the door definition, the measured classes at the
  pinned `zod`, the per-package audit at `main` `2d7e7da`, and the owner
  assignments.
- [`docs/contracts/protected-contracts.md`](../contracts/protected-contracts.md)
  — the protected-path policy, the ratification-precedent mechanism, and the
  consolidated register of open venue-fact items.

---

## Which change requires which ADR

Handoff §1.3 lists the changes that require an ADR *and* orchestrator approval.
Each row names the record that owns that decision today:

| Change (handoff §1.3) | Owning ADR |
| --- | --- |
| Changing the production language | none yet — handoff §2 locks TypeScript/Node 24; a change needs a new ADR |
| Replacing the official SDK with hand-written signing or an unofficial SDK | [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) (SDK boundary), [ADR-007](./ADR-007-signed-order-idempotency-and-unknown-submissions.md) (signing protocol) |
| Changing event ordering semantics | [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) |
| Changing numeric representation | [ADR-001](./ADR-001-exact-decimal-representation.md) |
| Allowing a strategy to perform I/O or submit orders directly | [ADR-005](./ADR-005-strategy-purity-and-decision-result.md) |
| Changing the ledger source of truth | [ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) |
| Allowing more than one active live strategy owner per market | [ADR-011](./ADR-011-one-live-owner-per-market-policy.md) |
| Changing the live-enablement mechanism | [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) |
| Adding a hot standby capable of order submission | [ADR-008](./ADR-008-live-writer-fencing-and-heartbeat-health-lease.md) |
| Removing any reconciliation, heartbeat, geoblock, or kill-switch control | [ADR-008](./ADR-008-live-writer-fencing-and-heartbeat-health-lease.md), [ADR-007](./ADR-007-signed-order-idempotency-and-unknown-submissions.md), [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) |

Two additional formats are ADR-gated by their own specification text:

- The WAL format — handoff §9.1 says "Append-only JSONL or another
  **ADR-approved** recoverable format".
  [ADR-004](./ADR-004-wal-format-durability-and-compaction.md) is that approval.
- The exact-decimal library — handoff §2.1 says "`decimal.js` (or an
  **ADR-approved** exact-decimal equivalent)".
  [ADR-001](./ADR-001-exact-decimal-representation.md) is that approval.

---

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `Proposed` | Drafted, not yet approved by the orchestrator. Not binding. |
| `Accepted` | Binding. Implementations must conform; a divergence is a defect or a new ADR. |
| `Superseded by ADR-NNN` | Historical. Kept verbatim; never edited to match the new decision. |
| `Deprecated` | No longer applies and has no successor. Requires a rationale. |

An accepted ADR is **not** edited to reflect a changed decision. It is
superseded by a new record, and its `Status` line is updated to point at the
successor. Corrections of fact (a broken link, a wrong section number, a
citation that does not support its claim) are made in place and noted in the
record's change log, because leaving a false citation standing is worse than an
edit.

Because `docs/adr/**` is a protected path, **any** change here — including a
supersession — needs orchestrator approval and a work package that owns the
path. See
[`docs/contracts/protected-contracts.md`](../contracts/protected-contracts.md).

---

## Numbering

ADR-001 through ADR-012 are reserved by handoff §20 for the titles listed there
and may not be renumbered or repurposed. New decisions take the next free number
from ADR-013 onward. A decision that refines an existing ADR is folded into that
ADR (under orchestrator approval) rather than given a number that competes with
it.

---

## Template

```markdown
# ADR-NNN: <Title>

- **Status:** Accepted
- **Date:** YYYY-MM-DD
- **Recorded by:** WP-NNN
- **Implemented by:** WP-NNN (state whether the implementation exists yet)
- **Supersedes / Superseded by:** none

## Context

Why the decision exists, and what the primary specification already locks.

## Decision

Numbered, testable statements. Each one is something an implementation can
conform to or violate.

## Consequences

What this costs, what it forecloses, and what breaks if it is changed later.

## Evidence

Every claim's source: handoff section, `docs/venue/verified-YYYY-MM-DD.md`
section, `docs/contracts/*.md` section, or `docs/handoffs/WP-NNN.md`.
Unverified venue items are listed here explicitly as unverified.
```
