# Implementation Status

Last updated: 2026-09-30 (content as of `f43efe6`; restructured by LOGS-1)  
Specification version: 2.0.0  
Maximum permitted run mode: `PAPER`

This file is the brief: current state only, one entry per item. The full history,
verbatim, is in [`docs/status-archive/`](docs/status-archive/README.md). Every
handoff is listed in [`docs/handoffs/INDEX.md`](docs/handoffs/INDEX.md). How to
write records: [`docs/handoffs/README.md`](docs/handoffs/README.md).

## Safety state

- `MAX_RUN_MODE=PAPER`
- `ALLOW_REAL_ORDERS=false`
- `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`
- `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`
- Production signer configured: **No**
- Real venue credentials required: **No**
- Human live-micro approval: **Not granted**

## Current phase

`phase-2`: the deterministic paper core.

- **Wave 2 packages:** all merged (batches 2A-2G; each merge is an ancestor of `main`).
- **The inherited-`toJSON` sweep is complete:** `SER-0` (`9a44167`, the measurement) and its rounds `SER-1`, `SER-2` and `SER-3`.
- **Wave 2 is NOT closed out.** The runbook §10 closeout audit `GOV-2B` ran on 2026-09-15 (`main` at `b9bacc1`). Its verdict: every package met its own criteria, but three composition seams failed.
- **Closeout blockers:** every agent-closable blocker is closed; all but B3 were closed by 2026-09-17. B3 closed last, on 2026-09-28 (`BACKTEST-2`, `fd12be0`): the backtest executable now builds the same core as the trader. What remains is human work or a ruling ([Human items](#human-items)).
- **The 1a/1b/1c track is complete.**
  - `BRACKET-1a` (`11969f3`): an instance ends CLOSED after its own exit.
  - `BRACKET-1b` (`7252150`): a recorded two-bracket run with a FILLED take-profit, reconciled per bracket.
  - `BRACKET-1c` (`6e06c50`): the same round trip, durable, through real PostgreSQL and Redis and the real composition root.
  - Its two H1 blockers are closed: `SNAP-1` (`fff844d`) writes one PnL snapshot per instance per instant, and `BUNDLE-1` (`fd30e5f`) makes the trader's shipped bundle load.
- **§7 exit checklist:** item 1 stays OPEN until a fresh closeout grades it. Items 4 and 5 stay NOT MET on their human halves: H1, the live-data paper run, and H3, the dashboards' infrastructure.
- **Next:** `THROUGHPUT-2`, then the H1 re-run, then the fresh read-only closeout audit (after H1 and H3).
- **Deferred:** `WP-260` and the eight remaining phase-3 packages wait for Wave 3 ([Wave 3 authorization](#wave-3-authorization-conditional)).
- Handed over in [`WAVE-2-HANDOVER.md`](docs/handoffs/WAVE-2-HANDOVER.md). What "Complete" means for a Wave 2 row: [Wave 2 qualification](#wave-2-qualification).

## Authorized now

Only rows marked **Ready (authorized)** may be started. Each row's allowed and
forbidden paths are in
[`work-packages-rounds.md`](docs/status-archive/work-packages-rounds.md) (search
for the id).

- **`THROUGHPUT-2`**: Ready (authorized) by the user, 2026-09-30.
  - Goal: evaluate once per venue frame, so no half-applied book state is evaluated (`H1R1-FRAME-ATOMICITY`), and reach the H1 burst rate. After `THROUGHPUT-1a`, evaluation is about 82% of CPU.
  - Kept: exactly one persisted decision per callback (handoff §7.5, ADR-005); every event is still applied and recorded, and none is dropped. Changed: the callback fires once per frame, after the frame's last event.
  - Scope (1): ADR-024, Proposed. It covers frame completeness without waiting on the next event, the per-source frame meaning grounded in `docs/venue/verified-*.md`, replay/backtest parity (ADR-022), crash recovery mid-frame, and determinism.
  - Scope (2)-(3): the implementation, plus two semantics-preserving extras only: a static-bracket parameter-validation cache, and an exact incremental EWMA only if proven bit-identical.
  - Evidence (4): catch-up ≥ 943 events/s, paced max lag ≤ 5 s, no halt; a pin that half-applied states are gone; a fixture proof that no event is dropped; a base-vs-candidate decision characterization; every golden change explained.
  - Base `229d58a`. HARDENING LOOP; verifier: a Fable adversarial-reviewer. Runs before `THROUGHPUT-1c`. H1 is re-run afterwards.
  - Gate: automated checks, the Fable adversarial review, a green CI run on GitHub, and the user's ADR-024 ratification.
  - Ratification may follow the merge (user ruling, 2026-09-30): on reviewer ACCEPT the round merges, with ADR-024 marked *Accepted provisionally (orchestrator, pending user ratification)*. The user ratifies afterwards; a rejection is reverted by a follow-up round.
- **`VENUE-3`**: Ready (authorized) by the user, 2026-09-30.
  - Goal: the phase-3 venue gate, i.e. the Wave 3 start re-verification. It is `VENUE-2`'s shape for phase 3: the full handoff §1.2 re-verification against `verified-2026-09-16.md`, with every drift row quoted, sourced, and given a consequence and an owner.
  - Emphasis, the Wave 3 surfaces: the unified secure SDK (its current commit and version, what changed since `983a10a7…`, and the U-7 / D-02 pin check for `WP-260`); L1/L2 authentication; order placement, cancel and error codes (U-4); the user WebSocket channel (`WP-280`); heartbeats (`WP-320`); geoblock, documentary only (the endpoint is NOT called); rate limits and matching-engine modes (`WP-310`); collateral, pUSD and the settlement-contract addresses (U-5, `WP-300`); C-4.
  - Documentary only: unauthenticated GETs of the documentation and the SDK source. No credential, wallet, signer, authenticated endpoint, order or WebSocket.
  - Runs in parallel with `THROUGHPUT-2` (disjoint paths). Implementer: the `venue-verifier` agent. HARDENING LOOP; verifier: a Fable adversarial-reviewer that re-fetches every source.
  - Gate: the Fable adversarial review (re-fetch) and a green CI run on GitHub.
- **`THROUGHPUT-1c`** (queued, not startable now): authorized by the user on 2026-09-29. On 2026-09-30 the user moved it off the critical path: it runs after the Wave 2 closeout, alongside the start of Wave 3.
  - The finding: in H1 run 1, 20,367 of 37,546 decisions (54%) paused on `SB.STALE_BOOK`. Book age is `now − book.asOf`, the last change, so a quiet but live book reads stale after 2 s. The risk policy's `venueBookMaxAgeMs` has the same shape.
  - Scope (1): ADR-023, Proposed: a liveness-based freshness rule grounded ONLY in the venue's documented market-channel behaviour (`docs/venue/verified-*.md` and current official docs; never invented). The user ratifies it before merge.
  - Scope (2): end to end: a gateway liveness signal if one is needed, then features, strategy and risk freshness, with the strategy's parameter and version discipline.
  - Evidence (3): a quiet but live book is fresh; a silent or disconnected feed is stale within its bound; every golden change is listed and explained.
  - HARDENING LOOP; verifier: a Fable adversarial-reviewer. Gate: automated checks, the Fable adversarial review, the user's ADR-023 ratification, and a green CI run on GitHub.

## Work packages

One line per package. Full rows (chains, reviews, scope, paths, gates):
`WP-000` to `WP-250` in
[`work-packages-waves-0-2.md`](docs/status-archive/work-packages-waves-0-2.md);
`WP-180-FU3` onward in
[`work-packages-rounds.md`](docs/status-archive/work-packages-rounds.md).
Completion records are in the `completion-records-*` archive files.

| Package | Scope | Status | Merge | Record |
| --- | --- | --- | --- | --- |
| `WP-000` | Venue verification and sanitized fixtures | Complete (2026-08-26) | `d427f00` | [WP-000](docs/handoffs/WP-000.md) |
| `WP-010` | Monorepo, CI, compose, and quality gates | Complete (2026-08-22) | `12ce0ab` | [WP-010](docs/handoffs/WP-010.md) |
| `WP-020` | Domain contracts and exact decimal types | Complete (2026-08-26) | `25bc451` | [WP-020](docs/handoffs/WP-020.md) |
| `WP-030` | Initial ADR and contract documentation | Complete (2026-08-26) | `59cf254` | [WP-030](docs/handoffs/WP-030.md) |
| `WP-015` | Dependency-direction CI enforcement | Complete (2026-08-27) | `d77b2ba` | [WP-015](docs/handoffs/WP-015.md) |
| `WP-040` | PostgreSQL schemas and migrations | Complete (2026-08-26) | `d23bb67` | [WP-040](docs/handoffs/WP-040.md) |
| `WP-050` | WAL, segment manifests, and crash recovery | Complete (2026-08-26) | `8a607ec` | [WP-050](docs/handoffs/WP-050.md) |
| `WP-060` | Redis Streams event transport | Complete (2026-08-27) | `af29b08` | [WP-060](docs/handoffs/WP-060.md) |
| `WP-090` | Coinbase reference adapter | Complete (2026-08-27) | `335b1b0` | [WP-090](docs/handoffs/WP-090.md) |
| `WP-070` | Polymarket public market-data adapter | Complete (2026-08-27) | `f2f0258` | [WP-070](docs/handoffs/WP-070.md) |
| `WP-080` | Binance reference adapter | Complete (2026-08-28) | `d0d66bf` | [WP-080](docs/handoffs/WP-080.md) |
| `WP-100` | Polymarket RTDS Chainlink TWAP adapter | Complete (2026-08-30) | `e3ac6a3` + wiring `eaf18f4` | [WP-100](docs/handoffs/WP-100.md) |
| `WP-110` | Universe and settlement specifications | Complete (2026-08-31) | `ea81f5f` | [WP-110](docs/handoffs/WP-110.md) |
| `GOV-1B` | contract-owner governance round | Complete (2026-08-28) | `dd61e1e` | [GOV-1B](docs/handoffs/GOV-1B.md) |
| `WP-130` | Parquet compactor and dataset manifests | Complete (2026-08-31) | `cfa353b` + wiring `24903d2` | [WP-130](docs/handoffs/WP-130.md) |
| `WP-080-FU1` | ADR-014 takerSide conformance | Complete (2026-08-31) | `ebda609` | [WP-080](docs/handoffs/WP-080.md), FU1 section |
| `WP-120` | Data gateway integration | Complete (2026-09-01) | `0622f45` + wiring `2a49153` | [WP-120](docs/handoffs/WP-120.md) |
| `WP-140` | Recorder observability and soak harness | Implementation complete; automated checks complete; the evidence gate is unmet until the ≥24h soak (H4) | `735d330` + wiring `5757ef3` | [WP-140](docs/handoffs/WP-140.md) |
| `GOV-1C` | contract-owner governance round at Wave 1 closeout | Complete (2026-09-02) | `3272c4b` | [GOV-1C](docs/handoffs/GOV-1C.md) |
| `WP-150` | Local exact-decimal order books | Complete (2026-09-02) | `70c7f1f` | [WP-150](docs/handoffs/WP-150.md) |
| `WP-170` | Strategy SDK and deterministic runtime | Complete (2026-09-03) | `9d0971b` | [WP-170](docs/handoffs/WP-170.md) |
| `WP-180` | Capital allocator and scenario risk | Complete (2026-09-04) | `98a6cc1` | [WP-180](docs/handoffs/WP-180.md) |
| `WP-200` | Append-only ledger, allocations, positions, and PnL | Complete (2026-09-03) | `7e75f9a` | [WP-200](docs/handoffs/WP-200.md) |
| `WP-210` | Replay clock, event source, simulated venue, and fill models | Complete (2026-09-04) | `bebdd85` + wiring `5b73461` | [WP-210](docs/handoffs/WP-210.md) |
| `WP-180-FU2` | mirror collapse to canonical `packages/risk` | Complete (2026-09-04) | `625c83b` | [WP-180-FU2](docs/handoffs/WP-180-FU2.md) |
| `WP-220` | Static Bracket strategy | Complete (2026-09-05) | `b8f7864` | [WP-220](docs/handoffs/WP-220.md) |
| `WP-200-FU1` | ledger/pnl schema-boundary door | Complete (2026-09-05) | `a30fec8` | [WP-200-FU1](docs/handoffs/WP-200-FU1.md) |
| `GOV-2A` | cross-package schema-boundary governance round | Complete (2026-09-04) | `b4b720a` | [GOV-2A](docs/handoffs/GOV-2A.md) |
| `GOV-1D` | C-2 resolution: USDC vs pUSD denomination | Complete (2026-09-04) | `61a7ba5` | [GOV-1D](docs/handoffs/GOV-1D.md) |
| `WP-160` | Versioned feature engine | Complete (2026-09-04) | `3d49946` | [WP-160](docs/handoffs/WP-160.md) |
| `WP-190` | Execution planner contracts and paper implementation | Complete (2026-09-04) | `5aa11e3` | [WP-190](docs/handoffs/WP-190.md) |
| `WP-150` | superseded row: the WP-150 review trail | Superseded | — | [WP-150](docs/handoffs/WP-150.md) |
| `WP-020-FU1` | decimal/risk index-0 family round | Complete (2026-09-05) | `edf6b1d` | [WP-020-FU1](docs/handoffs/WP-020-FU1.md) |
| `WP-230` | Paper trader integration | Complete (2026-09-05) | `8425e03` + wiring `af059d7` | [WP-230](docs/handoffs/WP-230.md) |
| `WP-170-FU1` | strategy-runtime schema-boundary door | Complete (2026-09-06) | `d89841d` | [WP-170-FU1](docs/handoffs/WP-170-FU1.md) |
| `WP-240` | Control API and paper dashboards | Complete (2026-09-06) | `0e7227d` + wiring `80126e8` | [WP-240](docs/handoffs/WP-240.md) |
| `WP-250` | Determinism and paper end-to-end verification | Complete (2026-09-06) | `ce7fbe0` + wiring `da37a0c` | [WP-250](docs/handoffs/WP-250.md) |
| `WP-180-FU3` | packages/risk remainder round | Complete (2026-09-06) | `8c14b47` | [WP-180-FU3](docs/handoffs/WP-180-FU3.md) |
| `WP-160-FU1` | features output-side hardening | Complete (2026-09-06) | `5faf16b` | [WP-160-FU1](docs/handoffs/WP-160-FU1.md) |
| `REC-1` | recorder-pipeline hardening round | Complete (2026-09-06) | `327cae7` | [REC-1](docs/handoffs/REC-1.md) |
| `ALLOC-1` | capital-allocator strategyInstanceId re-typing | Complete (2026-09-06) | `d9f70a6` | [ALLOC-1](docs/handoffs/ALLOC-1.md) |
| `TRDR-1` | apps/trader instanceId relaxation | Complete (2026-09-07) | `65ae56c` | [TRDR-1](docs/handoffs/TRDR-1.md) |
| `UNIV-1` | packages/universe lifecycle door | Complete (2026-09-07) | `4d7443b` | [UNIV-1](docs/handoffs/UNIV-1.md) |
| `SETL-1` | packages/settlement spec door | Complete (2026-09-07) | `af991ee` | [SETL-1](docs/handoffs/SETL-1.md) |
| `CLOB-1` | polymarket-public CLOB doors | Complete (2026-09-07) | `eb0c586` | [CLOB-1](docs/handoffs/CLOB-1.md) |
| `UNIV-2` | universe registration + envelope doors | Complete (2026-09-07) | `f90ff05` | [UNIV-2](docs/handoffs/UNIV-2.md) |
| `SETL-2` | settlement observation/evaluation door | Complete (2026-09-07) | `6142e66` | [SETL-2](docs/handoffs/SETL-2.md) |
| `UNIV-3` | universe state-side round | Complete (2026-09-07) | `cbc1ed3` | [UNIV-3](docs/handoffs/UNIV-3.md) |
| `WP-060-FU1` | event-bus envelope door | Complete (2026-09-11) | `d869868` | [WP-060-FU1](docs/handoffs/WP-060-FU1.md) |
| `WP-200-FU2` | ledger/pnl own accumulators | Complete (2026-09-07) | `af4aacc` | [WP-200-FU2](docs/handoffs/WP-200-FU2.md) |
| `SER-1` | own-data JSON encoder + accounting keys | Complete (2026-09-15) | `c065d63` | [SER-1](docs/handoffs/SER-1.md) |
| `SER-2` | durable bytes: WAL, Parquet, PostgreSQL | Complete (2026-09-15) | `0d8b6a0` | [SER-2](docs/handoffs/SER-2.md) |
| `SER-3` | outbound bytes, runtime decisions, soak artifacts | Complete (2026-09-15) | `603a49c` | [SER-3](docs/handoffs/SER-3.md) |
| `GOV-2B` | Wave 2 closeout audit | Complete (2026-09-15) | — (an audit; no merge) | [GOV-2B-wave-2-closeout](docs/handoffs/GOV-2B-wave-2-closeout.md) |
| `TRDR-2` | the pnl_snapshots column binding — GOV-2B **B1** | Complete (2026-09-15) | `f3da220` | [TRDR-2](docs/handoffs/TRDR-2.md) |
| `RISK-2` | protective-reduction recognition — GOV-2B **B2** | Complete (2026-09-15) | `133eac1` | [RISK-2](docs/handoffs/RISK-2.md) |
| `GATE-1` | gate the evidence; clear the audit step — GOV-2B **B6**, **B7**, N4, N5 | Complete (2026-09-15) | `0434c82` | [GATE-1](docs/handoffs/GATE-1.md) |
| `BOOT-1` | the durable trader's bootstrap rows — GOV-2B **B9**, raised by the TRDR-2 review | Complete (2026-09-16) | `0d09eb5` | [BOOT-1](docs/handoffs/BOOT-1.md) |
| `BACKTEST-1` | the replay composition root — GOV-2B **B3** | Complete (2026-09-16) | `b462501` | [BACKTEST-1](docs/handoffs/BACKTEST-1.md) |
| `GOV-2C` | ledger integrity and the contract-owner docs debt — GOV-2B **B8**, N2, N3, N6, N7, N9, N10, G-13 | Complete (2026-09-16) | `33c36f9` | [GOV-2C](docs/handoffs/GOV-2C.md) |
| `VENUE-2` | the phase-2 venue gate — GOV-2B **G-01** | Complete (2026-09-17) | `d6aedee` | [VENUE-2](docs/handoffs/VENUE-2.md) |
| `UNIV-4` | the market lifecycle producer — closeout blocker **B10**, found by `BACKTEST-1` | Complete (2026-09-17) | `7c08af7` | [UNIV-4](docs/handoffs/UNIV-4.md) |
| `TRDR-3` | the trader health endpoint and an exact-decimal PnL producer — GOV-2B **B5**'s code half, R4 | Complete (2026-09-17) | `da9c58e` | [TRDR-3](docs/handoffs/TRDR-3.md) |
| `CI-1` | the first real CI run's failure; GATE1-R4; N5 | Complete (2026-09-26) | `7248073` | [CI-1](docs/handoffs/CI-1.md) |
| `RECON-1` | the e2e reconciler's two latent traps — `RISK2-R3`, `RISK2-R4` | Complete (2026-09-26) | `de58d83` | [RECON-1](docs/handoffs/RECON-1.md) |
| `CI-2` | four of `CI-1`'s review LOWs — `CI1-L1`, `CI1-L3`, `CI1-L4`, `CI1-L5`; `CI1-L2` is `LINT-1` | Complete (2026-09-26) | `6325d10` | [CI-2](docs/handoffs/CI-2.md) |
| `RECON-2` | `RECON-1`'s four residuals — `RECON1-SCAN`, `RECON1-ORIGIN`, `RECON1-TEXT`, `RECON1-EDGE` | Complete (2026-09-26) | `a4d1159` | [RECON-2](docs/handoffs/RECON-2.md) |
| `LINT-1` | `CI1-L2`: nothing catches a floating promise | Complete (2026-09-26) | `e3a3389` | [LINT-1](docs/handoffs/LINT-1.md) |
| `TRDR-4` | the trader loop's unbounded state — `RECON2-LOOPMEM`, widened by scoping | Complete (2026-09-27) | `fea251f` | [TRDR-4](docs/handoffs/TRDR-4.md) |
| `SIM-1` | LOOPMEM-SIM part 1: `SimulatedVenue` CORRECTNESS, which bounding depends on | Complete (2026-09-27) | `93c7bbd` | [SIM-1](docs/handoffs/SIM-1.md) |
| `SIM-2` | LOOPMEM-SIM part 2: BOUND `SimulatedVenue` | Complete (2026-09-27) | `04bf9d8` | [SIM-2](docs/handoffs/SIM-2.md) |
| `FOLD-1` | LOOPMEM-FOLD Option 2: the ledger view and PnL updated IN PLACE, with a rebuild-equals-incremental check | Complete (2026-09-27) | `2c0bd21` | [FOLD-1](docs/handoffs/FOLD-1.md) |
| `BRACKET-1a` | RISK-2 residual 5: the protective reduce gets an order track, so an instance survives its own exit | Complete (2026-09-28) | `11969f3` | [BRACKET-1a](docs/handoffs/BRACKET-1a.md) |
| `BRACKET-1b` | §7 item 1 evidence: a two-bracket e2e run with a FILLED take-profit; the reconciler learns two brackets; `RECON2-EVENTHOP` | Complete (2026-09-28) | `7252150` | [BRACKET-1b](docs/handoffs/BRACKET-1b.md) |
| `BRACKET-1c` | §7 item 1: one DURABLE two-bracket round trip — real PostgreSQL + real Redis through the real composition root | Complete (2026-09-28) | `6e06c50` | [BRACKET-1c](docs/handoffs/BRACKET-1c.md) |
| `BUNDLE-1` | H1 blocker M18: the trader's shipped bundle crashes at load | Complete (2026-09-28) | `fd30e5f` | [BUNDLE-1](docs/handoffs/BUNDLE-1.md) |
| `SNAP-1` | H1 blocker `BRACKET1C-SNAPKEY`: one PnL snapshot per instance per instant | Complete (2026-09-28) | `fff844d` | [SNAP-1](docs/handoffs/SNAP-1.md) |
| `H8-GOV` | the H8 track, round 1: ADR-022 + a staged dependency-contract amendment + work-plan ratification; documentation only | Complete (2026-09-28) | `bb58edb` | [H8-GOV](docs/handoffs/H8-GOV.md) |
| `DEPCHECK-1` | the H8 track's checker-hardening round: F10, app-endpoint CHK, F16's relative half, stale-row CHK; ride-alongs `CI2-L5-2`/`CI2-L5-3` | Complete (2026-09-28) | `d7f2906` | [DEPCHECK-1](docs/handoffs/DEPCHECK-1.md) |
| `CORE-MOVE` | the H8 track, round 3: MOVE the paper core into `packages/trading-core`; move-only | Complete (2026-09-28) | `33b7d0b` | [CORE-MOVE](docs/handoffs/CORE-MOVE.md) |
| `BACKTEST-2` | the H8 track, round 4: the backtest CLI builds the real trading core; closes blocker B3 | Complete (2026-09-28) | `fd12be0` | [BACKTEST-2](docs/handoffs/BACKTEST-2.md) |
| `DOCS-1` | append-only documentation owed by the H8 track | Complete (2026-09-28) | `2e7f618` | [DOCS-1](docs/handoffs/DOCS-1.md) |
| `OUTAGE-1` | pre-H1 outage hardening: Redis unreachable at start → a documented refusal; a Redis outage mid-run → a bounded, fail-closed halt instead of a hang; registered config parameters checked | Complete (2026-09-29) | `143ad8d` | [OUTAGE-1](docs/handoffs/OUTAGE-1.md) |
| `REGISTER-1` | pre-H1: an operator registration command | Complete (2026-09-29) | `7f1ebc0` | [REGISTER-1](docs/handoffs/REGISTER-1.md) |
| `OUTAGE-2` | make OUTAGE-1's PARTITION outage test deterministic; prove nothing is written after a halt | Complete (2026-09-29) | `a618752` | [OUTAGE-2](docs/handoffs/OUTAGE-2.md) |
| `THROUGHPUT-1a` | the trader keeps pace with a live 15-minute market; its stream lag is visible | Complete (2026-09-30) | `229d58a` | [THROUGHPUT-1a](docs/handoffs/THROUGHPUT-1a.md) |
| `THROUGHPUT-1b` | the gateway publishes a window-open burst without overflowing; the example config subscribes to books | Complete (2026-09-30) | `c179095` | [THROUGHPUT-1b](docs/handoffs/THROUGHPUT-1b.md) |
| `THROUGHPUT-1c` | book freshness by feed liveness, not by the last change | Authorized; runs after the Wave 2 closeout | — | — |
| `DEPS-1` | CI health: new high advisories in dev/test-only transitive dependencies | Complete (2026-09-30) | `f6a2714` | the archived row |
| `THROUGHPUT-2` | evaluate once per venue frame: no half-applied book states; reach the H1 burst rate | **Ready (authorized)** 2026-09-30 | — | — |
| `VENUE-3` | the phase-3 venue gate: the Wave 3 start re-verification, including the C-4 re-check and a fresh SDK pin check | **Ready (authorized)** 2026-09-30 | — | — |
| `WP-260` | Secure unified-SDK adapter and signer boundary | Dependency-ready; deferred to Wave 3 by wave ordering and signer-boundary safety | — | — |
| All other packages | — | Blocked | — | See work plan |

Authorization vocabulary: "Ready (authorized)" rows are the only packages agents
may begin in the current run; "Dependency-ready" rows must not start until this
table says otherwise.

## Open blockers

Open items are closeout blockers, residual rows, venue drift carried forward,
and human items ([below](#human-items)). Full rows, evidence and history:
[`open-blockers-2026-09.md`](docs/status-archive/open-blockers-2026-09.md)
(search for the id). The cross-package schema-boundary findings (zod adoption and
loss) are in
[`cross-package-schema-risk.md`](docs/status-archive/cross-package-schema-risk.md);
what is still live from them is listed under
[Schema boundary](#schema-boundary-still-live).

### Closeout blockers (from `GOV-2B`, 2026-09-15)

| Id | State | Owner |
| --- | --- | --- |
| `B4` | **Open.** CHECK-4's live-data half, i.e. H1. Its preconditions are closed: `B9` (`BOOT-1`), `B10` (`UNIV-4`), the venue gate (`VENUE-2`), the health surface (`TRDR-3`). Run 1 (2026-09-29) halted fail-closed on throughput; details under [Human items](#human-items). Re-run after `THROUGHPUT-2`. | human (H1) |
| `B5` | **Code half (R4) closed** by `TRDR-3` (`da9c58e`). **Infra half (R5), i.e. H3:** performed 2026-09-29 with H1 run 1 (a real Prometheus scraped the control API; a real Grafana imported and rendered the three dashboards). The fresh closeout grades it. No test validates the scrape fragment (`infra/prometheus/control-api-scrape.yaml`). | human (H3) |
| `B9` | **Closed for a run's first start** by `BOOT-1` (`0d09eb5`): the trader refuses to start unless its rows exist and match, and refuses to resume a run that holds decisions (exit 78). Resume (R10) is Wave 3's; after a crash the operator starts a NEW run. | `BOOT-1` ✓; R10 for resume |
| `H7` | **Ratified** by the user, 2026-09-28 ("Ratify all"): the N6 field format; four root-wiring commits without recorded reviewer sign-off (`5b73461`, `af059d7`, `80126e8`, `da37a0c`); the SER confirming reviews run by Claude after Codex's content filter refused the packet; N11; the Fable verifiers for container- and spawn-heavy rounds (`BRACKET-1c`, `BUNDLE-1`, `DEPCHECK-1`; the `CI-2` precedent); the `DEPCHECK-1` grant widening (`CI2-L5-2/3`) and the `DOCS-1` authorization. The archived state cell reads "PARTLY DONE"; it predates the ruling. | no open owner: the archived owner (human/orchestrator, for three questions) became historical at ratification |

Closed: `B3` (`BACKTEST-2` `fd12be0`, 2026-09-28), `B10` (`UNIV-4` `7c08af7`),
`G-01` (`VENUE-2` `d6aedee`), `H5` (ruled 2026-09-28: one demonstrated run).
Closed earlier: `B1`'s cause (`TRDR-2` `f3da220`), `B2` (`RISK-2` `133eac1`),
`B6`, `B7` and N4 (`GATE-1` `0434c82`), `B8` with N2 (the contract correction;
the `N2` measurement is open), N3 (features), N6, N7, N9, N10 and G-13
(`GOV-2C`). N5 closed later (`CI-1`).

### Residual queue

Open rows only, one line each. An owner beginning "row:" is quoted from the
archived row and may be stale; the cell says why. File:line citations are as of
`f43efe6`.

| Id | Residual | Owner |
| --- | --- | --- |
| `H1R1-FRAME-ATOMICITY` | In the H1 burst every venue market-channel frame produced exactly two `BookLevelChanged` events, one per token of the pair (85,547 events from 42,774 frames). The trader evaluates after each, so half the evaluations see a half-applied frame, a book state that never existed at the venue. Evaluating once per frame (per `causationId`) is truer and halves the work, but changes WP-170's exactly-one-decision-per-event criteria. The user ruled on 2026-09-30 that `THROUGHPUT-2` evaluates once per frame. | `THROUGHPUT-2` (evaluate once per frame) |
| `OUT1-R1-HALT-NOT-DURABLE` | A halt, including `OUTAGE-1`'s `TRANSPORT_UNAVAILABLE`, is not persisted to PostgreSQL: `TraderStore` has no halt write, and nothing writes `ops.incidents` or `ops.risk_events`. The durable record of an outage is only its consequence (no writes after the halt instant), plus the process log and the exit code. `OUT2-R1-HALT-RECORD-INTERACTION`: the outage tests require that no row commits after the pre-fault snapshot, so the round that adds the halt record must update the three outage scenarios to expect exactly that one halt row, and nothing else. | a trader/storage round that adds a durable halt record (`ops.incidents`), before sustained live-data paper runs |
| `H1R1-PROVENANCE` | On all 37,546 H1 decisions, `strategy.decisions.gateway_epoch`, `ingest_seq` and `feature_snapshot_id` are NULL (`source_event_id` is set). A decision cannot be traced to its gateway epoch, its ingest sequence or an indexed feature snapshot except by joining through the event id. | a trader/storage round (with `OUT1-R1-HALT-NOT-DURABLE`) |
| `H1R1-HALT-INVISIBLE` | A halt that exits the process quickly never reaches Prometheus. In H1 the trader exited 75 between two 15 s scrapes, so the dashboards read `halts 0, healthy 1` until "health unavailable". Same root as `OUT1-R1-HALT-NOT-DURABLE`: there is no durable halt record for the control API to read. | with `OUT1-R1-HALT-NOT-DURABLE` |
| `TRADER-SIGNALS` | The trader installs no SIGINT/SIGTERM handler, although `main.ts`'s header mentions "the signal handlers". Ctrl-C kills the process. Durable writes are already committed per event, but the `FOLD-1` SHUTDOWN rebuild check and the orderly close never run. A graceful stop (stop the pump, run the SHUTDOWN check, close, exit 0) would add the shutdown check to H1's evidence. | offered to the user as an optional small round before H1 |
| `LOOPMEM-FOLD` | CPU half closed by `FOLD-1` (`2c0bd21`): the ledger view is flat per fill and PnL is linear per fill. Remaining: `FOLD-2`, and memory bounding (Option 4, behind `RECON2-DURABLE` and an ADR-006 amendment): the Ledger store is append-only and unbounded. Over days this could slow each event enough to fill the §8.3 ingest queue, which halts. Replacing folds-from-zero with snapshot + tail must stay byte-identical (§6 invariant 8, §12.4). | row: an ADR-level ruling, then a ledger/PnL round (written before `FOLD-1` closed the CPU half) |
| `FOLD-2` | LOOPMEM-FOLD Option 3, queued by the user 2026-09-27; runs after `BACKTEST-2` (user, 2026-09-28). It changes internal representations only; serialized bytes (`pnl-state/v3`, `ledger-projection/v3`), Map insertion order and the public no-mutation guarantees stay. `packages/pnl`: one record's update becomes constant-cost (the ever-growing ref and trade logs move to an append-only store with a watermark). `packages/ledger`, optionally: a from-zero rebuild folds into mutable maps and freezes once. A runtime PnL rebuild check becomes affordable: about 6 s instead of about 890 s at 100k records (estimated, not prototyped; measure first). | when backtests with thousands of fills per instance, or a cheap runtime PnL check, justify it; needs a `packages/pnl` (and optionally `packages/ledger`) grant |
| `FOLD-RELATCH` | Latent: a released MARKET `UNATTRIBUTED_ACTIVITY` halt is re-latched by the next fill in any market, because `haltOnLedgerProjection` re-reads the whole unattributed history (reproduced by calling `release` directly). Unreachable today: nothing in production calls the trader's `HaltController.release`. | the round that wires a halt-release seam into a running trader |
| `FOLD-PNL2TOKEN` | A silent PnL gap: when an instance holds both tokens of a market, only the filled token is marked (`loop.ts` about :2607-2612). | a PnL correctness round (unreachable with a single-token Static Bracket) |
| `FOLD-OVERSELL` | After a restart (a new run with an empty in-memory ledger), a SELL of shares bought in the previous run is an oversell in the PnL fold (`PNL_OVERSELL`). It is tied to restart semantics and `RECON2-DURABLE`. | the restart/resume design (with `RECON2-DURABLE`) |
| `FOLD1-SLOWTEST` | `apps/trader/src/loop-folds.test.ts`'s 1,000-fill held==rebuilt pin runs a full ledger rebuild after every fill: quadratic by design, about 68 s locally. It took the CI unit step from about 102 s to 187 s. It yields after every step, so the CI-1 RPC timeout cannot fire, but it is by far the slowest file. | the next round granted `apps/trader/src/**`: keep the property with far less work (check every fill for the first ~200 fills, then every 10th; or 1,000 fills with sampled checks) |
| `RECON2-DURABLE` | Unfilled-order provenance lives only in process memory. The durable-store port (`apps/trader/src/ports.ts`) persists decisions, checkpoints, ledger transactions and PnL snapshots, but no trace, plan or order provenance. After a restart, a cancelled unfilled order's link to its intent is gone: a §6 invariant 4 traceability gap for orders that never filled. Since `TRDR-4` the in-memory traces are a bounded 50k window; evictions are counted in `seams.retention`, not persisted, so persisting before eviction is the real fix. | a governance ruling (does §6 require it?), then a storage round |
| `TRDR4-LIVESETTLE` | A live-adapter obligation, outside PAPER. `TRDR-4` settles an order when it is terminal and its booked shares equal its filled shares. At a real venue, trades settle asynchronously (MATCHED → MINED → CONFIRMED, or RETRYING → FAILED; `verified-2026-09-16.md`). Before a live adapter exists: settlement must also require every trade of the order to be CONFIRMED or FAILED, and a §9.17 reconciliation to have passed; and the adapter must surface the orders a refused plan left behind (in `ordersSnapshot()` or in the refused result), carrying `plannedOrderId`. Meanwhile the loud path covers a late fill. | the live-adapter work package |
| `TRDR4-ORPHAN` | An order left resting by a partly refused plan is ownerless. It keeps its reservation, allocator and time-in-force entries until it goes terminal, and its market halts (`UNATTRIBUTED_ACTIVITY`): fail-closed, but clearing it is manual operator reconciliation. The Incident Controller (§9.9) could offer a SAFETY_CANCEL of the held orders (§6 invariant 13), a design addition. Since `SIM-1` the simulator reports partial execution per order, so this halt is defensive only: reachable only by a venue that refuses while holding unlisted orders (a future live adapter); pinned through a double. | row: an operator-tooling round, or moot once `LOOPMEM-SIM` makes the venue report partial execution (`SIM-1` did so for the simulator; a live adapter still could reach it) |
| `TRDR4-GAUGES` | `packages/observability` does not export as gauges the `seams.orders`/`seams.retention` counters, or the venue's `retention()` counters (including `awaitingAcknowledgment` and `evictedIds.refused`). Evictions, unowned fills and settle mismatches are visible on `/health` only. | the next observability round (additions only) |
| `TRDR4-CITES` | `test/unit/control-api/response-encoder-bound.test.ts` cites `health-door.ts:181` and `:77`, now `:242` and `:82`. The claim itself still holds. | the next round touching `test/unit/control-api/**` (documentation only) |
| `RISK2-R1` | `apps/trader/src/pipeline.ts:99-103`'s rule stands (the composition root may not re-derive disposition from tags), but its premise ("`packages/risk` decides disposition from the intent TYPE") is superseded. | row: `BOOT-1` (merged `0d09eb5`; the row was never marked closed) |
| `TRDR2-R8` | A parenthesized type alias (`type X = (never); value as X`) evades the trader cast census, eslint and tsc, because `resolveTypeText` does not strip parentheses. One-line fix plus a self-test. | the next round touching `test/unit/trader/**` |
| `TRDR2 residual 7` | `persistDecision`, `saveCheckpoint` and `appendLedgerTransaction` are typecheck-pinned with no round trip of their own. `GOV-2B` R8 (real-infrastructure integration for the trader's adapters) is half discharged: `TRDR-2` round-tripped `writePnlSnapshot` only. INFOs: `TRDR2-R9`, a sentence claiming "nothing else in the app writes SQL at all" while `appendLedgerTransaction` does (through WP-040's ledger repository); `TRDR2-R10`, eleven paper-trader harness aliases with no importer. | row: `BOOT-1`'s acceptance (a decision AND a fill end to end with every durable write landing) covers the first two round trips if it lands as specified; `appendLedgerTransaction` and the two INFOs go to the next `apps/trader` round. (`BOOT-1` merged; the row was not updated.) |
| `BOOT1-R6` | `health.loop.decisionsPersisted` counts outbox appends, incremented before `#flushOutbox` attempts the write: the BOOT-1 reviewer read 1 with zero rows persisted, twice. It ships as `trader_decisions_persisted_total`: a §6 invariant 3 counter that reports a rejected decision as persisted. Outside BOOT-1's grant. | the next `loop.ts` round (count on `written.ok`, or rename) |
| `BOOT1-R11` | `test/integration/control-api/trader-health-shape.test.ts:169` asserts `toContain("WP-220 accepted residual")` and passes only because the corrected caveat quotes that phrase, so it no longer measures what its name says. `apps/trader/README.md:144-160` still states the WP-220 posture verbatim. | the next control-api round (pin `SUPERSEDED (RISK-2, 133eac1)`); the next round granted `apps/trader/README.md` |
| `BOOT1 fill-link severing` | `accounting.ledger_transactions.fill_id`/`order_id` are bound NULL by `BOOT-1`: the trader persists no `execution.*` rows (`execution.fills.order_id` and `execution.orders.plan_id` are NOT NULL, so no minimal row is honest). One fill's durable transactions share only `occurred_at`, market, account and environment, and two fills at one instant are indistinguishable. So §6 invariant 8's rebuild from durable rows cannot reproduce per-fill economics. Not lost: per-asset balances, per-instance attribution, the in-memory ledger and `loop.traces()`. `expect(execution.fills).toHaveLength(0)` in `durable-trader-first-fill-postgres.test.ts` trips the day a round persists the chain; that failure is the instruction to delete the NULL binding. | the execution-chain persistence round (Wave 3, `WP-260`+) |
| `BOOT1 pool leak` | `packages/storage-postgres/src/testing/fixtures.ts`'s `createMigratedContext.close()` only calls `db.destroy()`. `migrateUp` uses the raw `pg` pool, and Kysely 0.29.5's `RuntimeDriver.destroy()` returns early when `#initPromise` is unset. So a context that never queried through `context.db` leaks the pool (two uncaught `57P01` at container stop, reproduced). Fix: `await pool.end()` in `close()`. Outside BOOT-1's grant. | the next round granted `packages/storage-postgres/src/testing/**` |
| `BOOT1 unchecked shared facts` | The registration check does not compare `strategy.instances.status` (a PAUSED or RETIRED instance with a RUNNING run passes), `default_ownership_mode`/`evaluation_priority`, `catalog.market_tokens` or `parameters_version`; they are listed in `postgres-registration.ts`'s header table. (The row's "no registration CLI exists" predates `REGISTER-1`.) | row: the next `apps/trader` round; a registration CLI is Wave 3 operator tooling (`REGISTER-1` has since added a registration command) |
| `TRDR3-R1` | The paper golden's `health.accounting.realizedPnl` is `{account: null, byInstance: {}}` while the durable path serves the ledger's value. The e2e harness builds the trader on a bare `MemoryTraderStore`, and `main.ts` attaches the PnL observer late (`attachRealizedPnl`) instead of inside `createPaperTrader`: two composition paths disagree on one observed field. Fix: one line in `apps/trader/src/trader.ts` (wrap the store, attach the book), delete the late attach in `main.ts`, and regenerate the golden. The expected flip, derived and verified by the reviewer: `{account: "-1.2", byInstance: {"e18f5c20-2000-7a20-8b00-000000000002": "-1.2"}}`, and nothing else. | a follow-up round owning `apps/trader/src/trader.ts` (candidate `TRDR-3-FU1`, with R2/R3; orchestrator authorization after `UNIV-4`) |
| `TRDR3-R2` | `apps/trader/src/health-server.ts` sets `headersTimeout`/`requestTimeout` to 5 s but leaves `server.connectionsCheckingInterval` at Node's 30 s default, the cadence at which those timeouts are enforced: an 8-socket partial-header probe got its first 200 at 33 s. Loopback only, PAPER, no write path. Meanwhile the control API's refresh fails fast (`current 0`, `reads_total{UNAVAILABLE}`), so no dashboard lies. Fix: one line (`connectionsCheckingInterval = 1_000`), and restate the bound in the header and the handoff. | `TRDR-3-FU1` |
| `TRDR3-R3` | Three READMEs are false since `da9c58e`: `apps/control-api/README.md` ("nothing in the shipped process calls `refresh()`; no poller exists yet"), `infra/grafana/control/README.md` ("Realized PnL" still in the PENDING panels table) and `apps/trader/README.md` ("a value rather than a metrics endpoint"). Two tests (`example-config-and-startup.test.ts`, `dashboards.test.ts`) require the sentence "does not expose an HTTP health endpoint today": the BOOT-1 R11 class. `TRADER_HEALTH_BIND`/`TRADER_HEALTH_PORT` are documented nowhere outside code and the handoff. | `TRDR-3-FU1` (READMEs and pins flipped together) |
| `TRDR3-R4/R5/R7` | (R4) The operations dashboard lacks the `control_trader_health_current` stat the trading dashboard gained. (R5) The control API example's `bindPort: 9465` collides with `infra/prometheus/recorder-scrape.yaml`'s compaction target; the new fragment targets 9466 to avoid it. (R7) `apps/control-api/src/health-door.ts:133` says "Bounded: at most 4096 instances" over an unbounded `z.record`; the practical bound is the http source's 4 MiB body. | the next `apps/control-api`/`infra` round |
| `SNAP1-KEYSET` | The loop's written-keys set (`SNAP-1`'s insert-or-replace identity) grows by one entry per snapshot instant for the life of the process: a small regression against `TRDR-4`'s bounded loop. It only needs the current event's instant(s) plus what `SNAP1-R2`'s backwards-timestamp rule requires. It is empty after a restart, which is harmless: a restart is a new run. | row: the next `apps/trader` round (after `CORE-MOVE`: the file moves; `CORE-MOVE` has since merged) |
| `SNAP1-MINOR` | A replaced row keeps its first `computed_at`, and no health counter counts replacements. The double does not refuse an `as_of` that PostgreSQL refuses (for example year 0000, which `normalizeToStrictUtc` accepts), and other PostgreSQL-accepted spellings key as themselves. There is a crash window between harvests. Unowned fills still write no virtual snapshot (pre-existing). | the next `apps/trader` round |
| `REGISTER1-LOWS` | (L1) `REGISTER_REFUSED_BY_DATABASE` says "the database refused a row" when the failing statement was the duplicate-check SELECT on an unmigrated database; the outcome is correct. (L2) `REGISTER_DEFINITION_MISMATCH` and `REGISTER_CONFIG_MISMATCH` have no test (verified by hand). (L3) `--help`'s exit-code table does not name every 78 code. (L4) A flag value of exactly `-h`/`--help` prints the usage. | the next `apps/trader/src/register` round |
| `OUTAGE1-LOWS` | (1) The trader-level outage tests pin "halts within T" but not the read deadline itself; the event-bus suite pins that deterministically. (2) The recorded docker-restart halt is an artifact of Testcontainers re-mapping the port; with a fixed port a fast restart recovers, as designed. (3) `startup()`'s subscribe catch labels any error that is not an `EventBusUnavailableError` as `TRADER_EVENT_SUBSCRIPTION_REFUSED` (78). | the next `apps/trader` round |
| `UNIV4-R1` | The lifecycle feed attributes a polled body to the configured market by request, not by content: D-30 does not record `conditionId` on the `GET /markets/{id}` response, so the door records it and never compares it. A mis-pointed `gammaMarketId` opens this market on another market's readiness, silently. Disclosed in the feed header, the compose README (operators must verify `gammaMarketId`) and the handoff. | the next venue round (record S-D34's `{id}` semantics and example body), then the feed refuses a mismatched poll with an incident |
| `UNIV4-R2` | The trader's `markLifecycle` is unguarded: `loop.ts` marks OPEN/CLOSING on receipt, and `pipeline.ts` then maps a RESOLVED market re-marked OPEN/CLOSING to `ACTIVE`/`CLOSE_ONLY` instead of `HALTED`. Two routes reach it: a same-instant replayed `MarketOpened` (UNIV-4's ledger, after a failed confirmation write), and an R4 observed `MarketClosing` that lands up to one poll interval after the WebSocket's `MarketResolved` (two independent producers). The universe fold is correct (same instant: unchanged; closing on RESOLVED: refused). Also UNIV4-R3: the strategy receives `onMarketClosing` with `secondsRemaining ≈ 0`; its cutoffs read `closeTimeMs` from configuration. | the next `apps/trader` round: rank-guard `markLifecycle` (never regress from RESOLVED) |
| `UNIV4-R4/R5` | (R4) A hold-back caused by a failed confirmation write, with a healthy publisher, is released only by the next epoch (two PAGEs raised); a same-epoch retry when not halted would release it. (R5) Poll latency is up to one `pollIntervalMs`: a market closed between polls is seen late, and one closed and reopened within one interval is unseen. The venue's `endDate`/`startDate` are deliberately not used: they have no documented semantics and are a schedule, not an observation. `publisher.ts:461`'s halt detail "the event remains in the WAL" is false for derived lifecycle events (the feed's own incident states the truth). | the next `apps/data-gateway` round |
| `N8` | Control API, `WP-240` review round 1, live and untested. M-1: pausing an instance the control plane never knew answers `200 PAUSED` (the shipped composition never calls `register()`; a prior is synthesized), contradicting its own `CONTROL_NOT_ENGAGED` release rule. M-3: an authenticated read-only operator can exhaust the audit log through pre-authorization forbidden-key refusal records, and so disable every mutation, including the §14.1 kill switch (fail-closed; shown at capacity 3 in five requests). Nine LOWs (L-1 to L-9) and N-4 sit behind them. M-2 closed 2026-09-17 by `TRDR-3` (`da9c58e`). L-9 (no rate bound) is now load-bearing on the request path (TRDR3-R8/R9). | M-1, M-3 and the LOWs: the next bounded `apps/control-api` round |
| `G-03` | `test/soak/recorder` ships four job scripts: `soak:run`, `soak:smoke`, `soak:evaluate` and `soak:compare-books`. Only `soak:smoke` is gated (`test:soak-smoke` in CI). `soak:evaluate` and `soak:compare-books` produce evidence but run only when an operator runs them. `soak:evaluate` is PENDING in every record that names it (no evidence windows exist). | the elapsed-soak human item H4 (`WP-140`); gating the two jobs is the orchestrator's `ci.yml` decision |
| `SIM-BALANCE` | `SimulatedVenue` has no cash or position sufficiency check: cash can go negative, and a SELL of shares the account does not hold books a negative position (`PP-6`). The real venue refuses insufficient balance. Upstream risk prevents it today. | a simulation round after `SIM-2` |
| `SIM-ATTEMPT` | One submission attempt per plan today; §9.11's idempotent protocol reads per signed order. Minting one per order would churn every deterministic id in the paper-e2e and backtest goldens (`PP-11`). | the OMS / live-adapter work package |
| `SIM1-BASKET` | BASKET partial handling is unreachable in production. `CoreLoop.#economicsFor` supplies fee and slippage estimates for POSITION intents only, so risk refuses every BASKET (`RISK_EDGE_INPUTS_MISSING`), and nothing consumes the plan's `failurePolicy` (ABANDON / PROTECTED_UNWIND / HOLD_FILLED_LEGS). `SIM-1` makes a basket partial fail closed (a halt), pinned through a disclosed `vi.mock` seam. | a round that makes baskets reachable: basket economics plus a `failurePolicy` consumer |
| `SIM1-CANCELDEBIT` | The simulator charges a market cancel's live-target count up front; the dated venue report describes admission plus a per-success debit. The difference is small, and the simulator is conservative. | a simulation round (with `SIM-BALANCE`) |
| `SIM1-LOOKAHEAD` | A Tier-1 DELAYED order's disposition is still computed at submission, from `timeline.bookAt(matchableAtNs)`: a pre-existing look-ahead question, unchanged by `SIM-1`. Tier 1 only; not in production PAPER. | a Tier-1 fidelity round, with an ADR-012 reading |
| `SIM1-PRICEVALID` | A hand-built planned order is not validated against the price range (planner-built orders are). | a ruling first: is it the venue's job or the planner's? |
| `SIM2-TIER1-TRADES` | Tier-1 `#trades` is unbounded, and so is Tier-1 per-trade band cost (`VS-07`, O(R·T²)). Trimming to the earliest live `restingFromNs` is not byte-safe: a later order can rest at an instant the venue already holds a trade for (pinned in `venue-sim2.test.ts`). Tier 1 is unreachable from the shipped trader (Tier 0), so the cost falls on backtests only. | a Tier-1 round: an incremental band fold, with an absolute base offset |
| `SIM2-FILTER` | The never-forgetting duplicate-id filter (2^24 bits, about 2 MiB) can refuse a new id on a false positive; the refusal is loud and counted. The probability is about 1% after roughly 1.75 M folded ids; folding starts only after 150k acknowledged orders. At saturation every new id is refused (a fail-closed denial of service on an extremely long run). `evictedIdFilterBits` is the knob. | revisit if a run ever approaches 10^6 orders |
| `BRACKET1-TPRACE` | Pre-existing; disclosed in the static-bracket README by `BRACKET-1a`. The `(PARTIALLY_OPEN\|OPEN, *_FILL)` family. (a) A take-profit is still live when a late entry fill resizes it, and the resize's cancel loses the race to a fill: the fill is refused with `SB.ILLEGAL_TRANSITION`, and the instance pauses, fail-closed, with the fill unfolded (at base the view-first order gave `UNATTRIBUTED_FILL`; either way it pauses). (b) A live entry's fill arrives while the bracket is `OPEN`. It needs an edge or a ruling; one option: exit settlement does not move into `OPEN` while the entry is still live. | the next static-bracket round |
| `BRACKET1-IDLESSVIEW` | An id-less protective reduce whose first view is terminal and partly filled is ignored by D5. Its fill then names it, but the track stays WORKING until a terminal view is re-delivered by id. Unreachable under the trader's fills-before-views delivery (`#harvestFills` before `#deliverOrderViews`); R2's composition obligation carries the same assumption. The fix: re-read `ctx.orders()` by id for a tracked exit whose view is terminal. | the next static-bracket round |
| `RISK-2 item 7` | (i) Closed by `BRACKET-1a`: the obsolete `RISK2-R5` table was removed. (ii) The complement-leg reclassification: a strategy that establishes exposure by selling a token it holds is now also an EXIT. That is sound within §9.8's own measures, disclosed at the site and not exercised end to end. Gating a covered sale on its directional effect needs a net-directional-exposure measure §9.8 does not define. (iii) `planEntry` tags `immediate_order_type` unconditionally, so a PASSIVE entry hits the same order-type collision the exits just escaped. | (ii) the contract owner, as a §9.8 question; (iii) the next `packages/strategies/static-bracket/**` round (re-owned by `BRACKET-1a`) |
| `BRACKET1B-RECON` | Disclosed limits of the per-bracket reconciler (`BRACKET-1b`), each loud rather than silent where it matters: fee records are not individually tied to their fills (fee totals are compared through fills and snapshots); the single-bracket path does not check the PnL stream's order (no single-bracket row reads it); same-event fill ties keep the fill-id convention; there is no per-bracket engine checkpoint in the artifact; two internal guards are unreachable and unpinned. | the next `test/e2e/**` round |
| `BRACKET1C-LOWS` | L1 closed (`SNAP-1`). L2: the read-back's SQL predicates are not load-bearing; one database per scenario scopes the rows. | L2: the next paper-trader integration round |
| `GATE1-M1` | `test:replay` is a hand-maintained positional list. Vitest fails only when the whole filtered set is empty, so if one named file is renamed or moved the gate drops it and still exits 0: the N4 defect can silently return (proven by the reviewer). | a round granted `test/unit/**` (a guard test asserting both golden files exist by path, or one directory named in the script) |
| `TC-LOCAL-FLAKE` | Seen by the `BACKTEST-2` implementer: 2 of 5 local `trader test:integration` runs failed on infrastructure (Redis "Connection is closed" at `RedisStreamsEventTransport.connect` in test setup; testcontainers "Failed to connect to Reaper"), in a different file each time. The orchestrator's gate runs and GitHub CI were green. A CI flake of the same shape would read as a red build. | watch CI; a paper-trader integration round may add connect retries or container readiness waits |
| `LINT1-TSC` | Nothing in CI compiles `tsconfig.lint.json`. An import that resolves outside its `paths` (for example through a suite's `baseUrl`, which the lint program lacks) gets an error type, and `no-floating-promises` silently skips that module's promises. The drift pin guards `paths` only. At `e3a3389` all 4,636 imports resolve. Recorded, not queued: `void` opt-outs need no reason comment, and a promise typed as `any` is not seen. | a round granted `.github/workflows/ci.yml`: add a gated `pnpm exec tsc -p tsconfig.lint.json --noEmit` step, keeping CI-2's drift pin satisfied |
| `DEPS1-VITEST` | Two moderate advisories remain in vitest / @vitest/mocker 3.2.7 (`>=2.1.0 <4.1.11`). They are test-only and below CI's high threshold. Clearing them needs a vitest major, which is not lockfile-only. | a tooling round |
| `BUNDLE1-LOWS` | Six LOWs. (1) ADR-018 should record the third pattern (ESM + `createRequire`) and why CJS was rejected. (2) `packages/storage-postgres`'s default migrations directory resolves relative to the bundle (latent). (3) The entry guards key on the file name, so a renamed bundle exits 0 silently. (4) The pin covers only `build` scripts that start with `esbuild `. (5) The pin couples to the example config's market count. (6) Process: one unprefixed pnpm command rewrote shared-hardlink metadata (observable state verified; the main checkout still holds `js-yaml@4.3.1`). [`DOCS-1.md`](docs/handoffs/DOCS-1.md) says `DOCS-1` covered (1); the row was not updated. | (1) the next docs round (with the ADR-022 discharge note); (2)-(5) the next tooling or apps round |
| `GATE1-R3` | `js-yaml 4.3.2` has run locally since `GATE-1`'s post-merge `pnpm install --frozen-lockfile --offline` at `0434c82`; every lint gate since ran on it. The remaining unknown was the first real CI run's fresh install. | H2, discharged 2026-09-26 by `CI-1`; the row was not closed |
| `N3` | `GOV-2A`'s 2026-09-04 ruling: `packages/execution-planner/src/refusals.ts:178-187` claims every public entry point returns a typed result, but `buyLimitPrice`/`sellLimitPrice` (`src/price.ts`) throw `InvalidDecimalStringError` on non-canonical input. The claim is to be corrected in text or guarded in code; its first trigger (`WP-180-FU2`) fired unmet. | the next bounded grant on `packages/execution-planner/**`; every packet dispatched for that package must quote the archived row |
| `N2` | `packages/order-book` `book.ts:191` and `:265` `safeParse` caller-supplied `input.payload` against object schemas and read `parsed.data`. The contract row is corrected (`schema-boundary.md` §3). The severity is unchanged, because whether a defeat on those two doors is reachable has not been measured. | the next bounded grant on `packages/order-book/**`, which owes the measurement first |
| `R8-1` | Every `Object.defineProperty` outside `packages/risk`/`capital-allocator` still passes an ordinary descriptor literal, which throws under an inherited `get`. | the detector/tooling round (`§5 item 6`) |
| `§5 item 6` | The detector/tooling round: a `.safeParse`-on-unmaterialized-value detector; alias/cast/indirection hardening for the census and source scans (folding in `WP-160` R1-N3, `WP-180` R9-1 and R8-2); and the F15/F16/F17 checker. Deliberately last, and deliberately not a CI gate today. | unassigned; the orchestrator authorizes it |

Closed, done or ruled (full rows in the archive): `RISK-2 residual 5`, `RISK2-R6`,
`RISK2-R2`, `RISK2-R3`, `RISK2-R4`, `RECON1-SCAN`, `RECON1-ORIGIN`, `RECON1-TEXT`,
`RECON1-EDGE`, `RECON2-LOOPMEM`, `LOOPMEM-SIM` (remainder: the `SIM-*` rows
above), `SIM2-E2E-MSG`, `RECON2-EVENTHOP`, `RECON2-README`, `N5`, `N1`,
`GATE1-R4`, `CI1-L1`, `CI1-L2`, `CI1-L3`, `CI1-L4`, `CI1-L5`, `CI2-L5-2`,
`CI2-L5-3`, `BT1-R1..R4`, `BOOT1-R7`, `BRACKET-1b`, `BRACKET1C-SNAPKEY`, `M18`,
`BOOT1-CONFIGPARAMS`, `ADR022-DISCHARGE`, `DC1-R1-L1`, `B1-R1-REDIS-UNCAUGHT`,
`BRACKET-1c`. The `H8 track` is complete; its rulings still in force are under
[Human items](#human-items).

### Venue drift carried forward (from `VENUE-2`)

`verified-2026-09-16.md` fed these to later rounds; they have no row of their own.
Owners are from `docs/handoffs/VENUE-2.md` follow_up and the report's §16.3.

- D-13: a per-market `feeSchedule {rate, exponent, takerOnly, rebateRate}`, while `packages/simulation/src/fees.ts` models only `exponent = 1`. Owner: `packages/simulation` (ADR-012) and fee/reward accounting.
- D-17: the minimum-order-size unit conflict (market details say "USDC notional", place-orders says "shares"; static-bracket `decide.ts` compares shares). Register conflict C-7. Owner: `packages/strategies/static-bracket` and `packages/universe`, with venue evidence.
- D-02: SDK 0.6.0 → 0.10.0 with breaking changes (`WP-260`; `VENUE-3` re-checks the pin).
- D-15 and D-20: see [Pending external evidence](#pending-external-evidence). D-30 is B10's basis (closed).
- The offline gate does not consume the phase-2 report: `apps/ops-cli`'s validator pins the frozen report only (`checks.ts:69`) and pins `effective_date` to 2026-08-24 (`checks.ts:249-252`), as of `f43efe6`. Report §15 items 1-4. Owner: the `apps/ops-cli/**` package (`WP-330` or an earlier authorized packet).
- U-17 and U-16: the semantics of `feeSchedule.exponent ≠ 1` and the rounding direction are still undocumented. Owner: as D-13; `roundingMode` stays caller-declared.
- U-15: Protocol V2 is documented only in SDK source. Owners: `WP-260`, `WP-300`, and the universe/data-gateway line that first reads Gamma `version`.
- Handoff §24 has three redirecting links (D-07, D-11, D-25). Owner: the orchestrator or register owner (update or annotate them).
- The phase-3 start gate owes its own report: `VENUE-3`.

### Schema boundary (still live)

The authority is `docs/contracts/schema-boundary.md` §3 (2 LIVE / 13 CLOSED / 5
outside, recounted 2026-09-11). Still live from the cross-package record
(reconciled 2026-09-15):

- `packages/domain`: the frozen root cause. It is closed at each door (ADR-020 §3) and never edited, by design.
- `packages/order-book`: live by inheritance, and `N2`.
- The `features` INPUT-side records: prototype-bearing, no live consumer route (`WP-160-FU1` r1 N2).
- `R8-1`, `§5 item 6`, and the open totality claim `N3`.
- Each closed door's disclosed residuals, owned in its handoff: `REC-1` (D2 not performed; the `config-door` format check), `CLOB-1` (`Array.prototype` arrays; the shared-materializer question, for ADR-020 governance), `UNIV-3` (the direct-export caller-input round), `SETL-2` (follow-up hardening), `WP-060-FU1` (the `redis/transport.ts` epoch cursor), the `isFreshOrdinaryContainer` round (zod's own array assembly), and the strategy-runtime `modelOutputs` split collapse.

## Human items

- **H1**, the live-data paper run. Run 1 (2026-09-29, [`H1-RUN-1.md`](docs/handoffs/H1-RUN-1.md)) was registered with `REGISTER-1`, and its `gammaMarketId` was verified against both venue APIs. It ran 34 min on live data: 37,546 decisions and checkpoints, read back clean. It then halted fail-closed (`TRANSPORT_RESYNC_REQUIRED`) at the window open: the trader could not keep pace (about 35 decisions/s against about 735 events/s). No entry was evaluated. Re-run after `THROUGHPUT-2`.
- **H2**, a real CI run: discharged 2026-09-26 by `CI-1` (PR #1 run `36282501033`, every gate green).
- **H3**, a real Prometheus and Grafana: performed 2026-09-29 with H1 run 1. The fresh closeout grades it.
- **H4**, elapsed soak evidence: open. It is the `WP-140` gate, which closes only through the runbook §7 governance procedure after a real ≥24h soak.
- **H5**: ruled 2026-09-28: one demonstrated run. The runbook §7 "Wave 2 closeout" check "Static Bracket runs in replay and live-data paper mode through the same code" (`:509` at `f43efe6`) is discharged by one supervised live-data paper session through the real stack (gateway → Redis → trader → PostgreSQL) that produces decisions and reads back clean. Sustained accumulation is the post-closeout activity the same section describes next (`:514` at `f43efe6`).
- **H6**, the authorization rows and round order: the orchestrator's, ongoing.
- **H7**: ratified 2026-09-28 (`H7` above).
- **H8**: ruled 2026-09-28, option A: extract the paper core into the layer-1 package `@polymarket-bot/trading-core`. Done by the `H8 track` (`H8-GOV` → `DEPCHECK-1` → `CORE-MOVE` → `BACKTEST-2`); `B3` is closed. Rulings still in force (user, 2026-09-28): D4, a strategy-agnostic core, waits for a second strategy, with S18 (the `trading-core` → `static-bracket` same-layer edge) carrying a sunset clause; `FOLD-2` runs after `BACKTEST-2`.
- **`§5 item 6`**: no owner yet; the orchestrator authorizes it.
- **The fresh read-only Wave 2 closeout audit** runs after H1 and H3 (user, 2026-09-28). It follows the runbook §10 wave closeout procedure (the old row cited §14, `:906` at `f43efe6`).

### Wave 3 authorization (conditional)

The user authorized Wave 3 on 2026-09-30. The orchestrator starts `WP-260` first,
then the work-plan chain, only when both hold:

- the fresh Wave 2 closeout audit grades Wave 2 CLOSED;
- `VENUE-3` has merged (the phase-3 start gate).

Every Wave 3 package stays PAPER-only, built with fixtures, mocks and fault
injection (runbook §8, "Critical rule"): no production wallet, signer, API
credential or real-order test. If the closeout does not grade Wave 2 CLOSED, only
the agent-closable blockers it names are worked, and Wave 3 does not start.

## Wave 2 qualification

A Wave 2 row that reads "Complete" means the package met its own acceptance
criteria (re-verified by `GOV-2B` on 2026-09-15). It does not mean the paper core
works end to end. Closing Wave 2 releases no new package: the four packages
outside Wave 2 that depend directly on a Wave 2 package (`WP-270`, `WP-290`,
`WP-300`, `WP-360`) all also depend on `WP-260`, directly or transitively.
`WP-260` itself is held by wave ordering and the signer boundary. Gate counts in
rows dated before 2026-09-26 come from one laptop; CI first ran with `CI-1`.
Full text:
[`wave-2-qualification.md`](docs/status-archive/wave-2-qualification.md).

## Deviations from specification

One entry each; full text in
[`deviations-evidence-gates.md`](docs/status-archive/deviations-evidence-gates.md).

- `WP-010`: the root `eslint.config.mjs` was outside its `allowed_paths`; ratified into WP-010 ownership.
- `WP-010`: Node 24 is pinned by `engines: ">=24"`, CI `node-version: 24` and a runtime smoke assertion, not an exact `.nvmrc`. Acceptable; tighten later if needed.
- `WP-000`: the venue report is `docs/venue/verified-2026-08-24.md`, not the work plan's literal `verified-2026-08-18.md`. Ratified by the orchestrator 2026-08-24. The rule: handoff §1.2 requires `verified-YYYY-MM-DD.md` dated to the actual verification; a work-plan literal is a template dated at plan generation.
- **N6**: four Wave 2 records, and most bounded rounds since 2026-09-05, use the completion-record form instead of the eight labelled fields. Recorded 2026-09-15 (`GOV-2C`); `AGENTS.md`'s eight fields control; the form was ratified by the user 2026-09-28 (H7).
- **N7**: ten Wave 2 merges touched `pnpm-lock.yaml` importer blocks. Ratified 2026-09-15 as a pattern (`GOV-2C`): a package that declares its own workspace and dev dependencies may update its own importer block, and later packages cite that entry. Seven more touches by rounds with no work-plan entry are covered by precedent only. `GATE-1`'s `js-yaml` substitution is recorded, not covered by the pattern.
- **N9**: `WP-200`'s `allowed_paths` names `test/integration/ledger/**`, which does not exist. Recorded 2026-09-15. A grant that authorizes nothing is not a deviation.
- **N11**: `BACKTEST-1` changed one line of the protected root `package.json` (`test:replay`). Ratified 2026-09-16 for that line. The orchestrator owns the class: every acceptance criterion that names a script must grant the file the script lives in.
- **N3**: a ruling of the form "by the next round touching X" failed twice, because nothing checks it. The systemic fix (a dated comment in the package's work-plan entry) is proposed, not applied: `GOV-2C`'s work-plan grant covered ratification entries only, and `packages/execution-planner` has no open package entry to carry it.

## Pending external evidence

- **H4**, the ≥24h soak for `WP-140` ([Human items](#human-items)).
- **C-2's reopen condition is met** (2026-09-17, `VENUE-2`; `verified-2026-09-16.md` D-15). The register's C-2 says any venue assertion of equivalence or conversion authorizes an explicit recorded conversion, never a fold. The venue now documents a conversion: pUSD is an ERC-20 wrapper representing a USDC claim, wrapped and unwrapped onchain by the `CollateralOnramp` and `CollateralOfframp` contracts, and its `_asset` must be USDC.e. The bridge deposit and resolution pages agree. Three names are in play (USDC, USDC native, USDC.e), and the Bridge API labels the pUSD address `"symbol": "USDC"`. The report records this and does not act; the ADR-006 fail-closed rulings are unaffected. Owner: the register/ADR-006 contract owner, through a dated amendment recording the conversion, in a governance round with `docs/adr/**` and `docs/contracts/protected-contracts.md` in grant. Also for that owner: U-11 (D-20), the SDK's closed five-value `UmaResolutionStatus` enum at both commits against the docs' nullable string.

## Resolved evidence items

- The real GitHub Actions run (2026-09-26, `CI-1`). The first run (`36279491795`, on `926cd08`) failed at "Unit tests" on a vitest worker RPC timeout, with all 7217 tests passing, and skipped seven gates. PR #1 run `36282501033` passed every job, the six integration suites included.
- `docker-compose.yml` runtime validation (2026-08-22): both services healthy, both ports bound to 127.0.0.1 only. Host ports are overridable (`PMB_POSTGRES_PORT`, `PMB_REDIS_PORT`).
- Accepted evidence: the `WP-010` automated gate (install, typecheck, lint, test) passed on `main` at `12ce0ab` (2026-08-22), reproduced independently by the adversarial reviewer at `1bca7cf`.

## Human and operational gates

- Execution-probe gate: Not requested
- Live-micro gate: Not requested
- Live gate: Not requested
- Time-based soak evidence: None

## Archive

Everything below was moved verbatim from this file at `f43efe6`. Search by id;
do not read whole files. See [`docs/status-archive/README.md`](docs/status-archive/README.md).

- [`header-and-phase.md`](docs/status-archive/header-and-phase.md): the old header and current-phase sentence.
- [`work-packages-waves-0-2.md`](docs/status-archive/work-packages-waves-0-2.md), [`work-packages-rounds.md`](docs/status-archive/work-packages-rounds.md): every full work-package row.
- [`completion-records-wave-1.md`](docs/status-archive/completion-records-wave-1.md), [`wave-1-batch-1b-in-flight.md`](docs/status-archive/wave-1-batch-1b-in-flight.md), [`completion-records-wave-0.md`](docs/status-archive/completion-records-wave-0.md): completion records. The code-cited "contract-owner item 3" is in the batch 1B in-flight records.
- [`wave-0-closeout-and-reviews.md`](docs/status-archive/wave-0-closeout-and-reviews.md): the Wave 0 closeout and review history.
- [`wave-2-qualification.md`](docs/status-archive/wave-2-qualification.md): what Wave 2 "Complete" means; superseded header sentences.
- [`open-blockers-2026-09.md`](docs/status-archive/open-blockers-2026-09.md): every closeout blocker and residual row, open and closed.
- [`cross-package-schema-risk.md`](docs/status-archive/cross-package-schema-risk.md): the 2026-09-03 zod adoption/loss record and its reconciliation.
- [`deviations-evidence-gates.md`](docs/status-archive/deviations-evidence-gates.md): full deviations and evidence.
- [`MOVE-MAP.md`](docs/status-archive/MOVE-MAP.md): where each old section and row went. [`REWRITES.md`](docs/status-archive/REWRITES.md): each rewritten live sentence, old and new.
