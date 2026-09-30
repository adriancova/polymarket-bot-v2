# Implementation Status

Last updated: 2026-09-30 (content as of `f43efe6`; restructured by LOGS-1)  
Specification version: 2.0.0  
Maximum permitted run mode: `PAPER`

This file is the brief: current state only, one line per item. The full history,
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

- **Wave 2 packages:** all merged (batches 2A-2G; each merge is an ancestor of `main`). So is the inherited-`toJSON` sweep `SER-0` (`9a44167`) with its rounds `SER-1`, `SER-2` and `SER-3`.
- **Wave 2 is NOT closed out.** The runbook §10 closeout audit `GOV-2B` ran on 2026-09-15 (`main` at `b9bacc1`). Its verdict: every package met its own criteria, but three composition seams failed.
- **Closeout blockers:** every agent-closable blocker is closed. B3 closed last, on 2026-09-28 (`BACKTEST-2`, `fd12be0`): the backtest executable now builds the same core as the trader. What remains is human work or a ruling ([Human items](#human-items)).
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

Only rows marked **Ready (authorized)** may be started. Each row's full scope,
allowed paths and gate are in
[`work-packages-rounds.md`](docs/status-archive/work-packages-rounds.md) (search
for the id).

- **`THROUGHPUT-2`**: Ready (authorized) by the user, 2026-09-30.
  - Goal: evaluate once per venue frame, so no half-applied book state is evaluated, and reach the H1 burst rate.
  - Kept: exactly one persisted decision per callback (handoff §7.5, ADR-005); every event is still applied and recorded. Changed: the callback fires once per frame, after the frame's last event.
  - Targets: catch-up ≥ 943 events/s, paced max lag ≤ 5 s, no halt.
  - Base `229d58a`. HARDENING LOOP; verifier: a Fable adversarial-reviewer. Runs before `THROUGHPUT-1c`. H1 is re-run afterwards.
  - ADR-024 is Proposed. On reviewer ACCEPT the round merges, with ADR-024 marked *Accepted provisionally (orchestrator, pending user ratification)*. The user ratifies afterwards; a rejection is reverted by a follow-up round (user ruling, 2026-09-30).
- **`VENUE-3`**: Ready (authorized) by the user, 2026-09-30.
  - Goal: the phase-3 venue gate, i.e. the Wave 3 start re-verification (handoff §1.2) against `verified-2026-09-16.md`. It includes the C-4 re-check and a fresh SDK pin check (U-7 / D-02, for `WP-260`).
  - Documentary only: unauthenticated GETs of the documentation and the SDK source. No credential, wallet, signer, authenticated endpoint, order or WebSocket.
  - Runs in parallel with `THROUGHPUT-2` (disjoint paths). Implementer: the `venue-verifier` agent. HARDENING LOOP; verifier: a Fable adversarial-reviewer that re-fetches every source.
- **`THROUGHPUT-1c`** (queued, not startable now): authorized by the user on 2026-09-29. On 2026-09-30 the user moved it off the critical path: it runs after the Wave 2 closeout, alongside the start of Wave 3.
  - Goal: book freshness by feed liveness, not by the last change. In H1 run 1, 20,367 of 37,546 decisions (54%) paused on `SB.STALE_BOOK`.
  - Needs ADR-023 (Proposed), ratified by the user before merge. HARDENING LOOP; verifier: a Fable adversarial-reviewer.

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
| `WP-140` | Recorder observability and soak harness | Evidence pending: the ≥24h soak (H4); the gate is open | `735d330` + wiring `5757ef3` | [WP-140](docs/handoffs/WP-140.md) |
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
| `WP-260` | Secure unified-SDK adapter and signer boundary | Dependency-ready; deferred to Wave 3 | — | — |
| All other packages | — | Blocked | — | See work plan |

Authorization vocabulary: "Ready (authorized)" rows are the only packages agents
may begin in the current run; "Dependency-ready" rows must not start until this
table says otherwise.

## Open blockers

Open items are of three kinds: closeout blockers, the residual queue, and human
items ([below](#human-items)). Full rows, evidence and history:
[`open-blockers-2026-09.md`](docs/status-archive/open-blockers-2026-09.md)
(search for the id). The cross-package schema-boundary findings (zod adoption and
loss) are in
[`cross-package-schema-risk.md`](docs/status-archive/cross-package-schema-risk.md);
what is still live from them is listed under
[Schema boundary](#schema-boundary-still-live).

### Closeout blockers (from `GOV-2B`, 2026-09-15)

| Id | State | Owner |
| --- | --- | --- |
| `B4` | **Open.** CHECK-4's live-data half, i.e. H1. Its preconditions are closed: `B9` (`BOOT-1`), `B10` (`UNIV-4`), the venue gate (`VENUE-2`), the health surface (`TRDR-3`). Run 1 (2026-09-29, [`H1-RUN-1.md`](docs/handoffs/H1-RUN-1.md)) was registered with `REGISTER-1`, and its `gammaMarketId` was verified against both venue APIs. It ran 34 min on live data: 37,546 decisions and checkpoints, read back clean. It then halted fail-closed (`TRANSPORT_RESYNC_REQUIRED`) at the window open: about 35 decisions/s against about 735 events/s. No entry was evaluated. Re-run after `THROUGHPUT-2`. | human (H1) |
| `B5` | **Code half (R4) closed** by `TRDR-3` (`da9c58e`). **Infra half (R5), i.e. H3:** performed 2026-09-29 with H1 run 1 (a real Prometheus scraped the control API; a real Grafana imported and rendered the three dashboards). The fresh closeout grades it. The row also records that no test validates the scrape fragment. | human (H3) |
| `B9` | **Closed for a run's first start** by `BOOT-1` (`0d09eb5`): the trader refuses to start unless its rows exist and match, and refuses to resume a run that holds decisions (exit 78). Resume (R10) is Wave 3's; after a crash the operator starts a NEW run. | `BOOT-1` ✓; R10 for resume |
| `H7` | **Ratified** by the user, 2026-09-28: the N6 field format; the four root-wiring commits without recorded reviewer sign-off (`5b73461`, `af059d7`, `80126e8`, `da37a0c`); the SER confirming reviews by Claude reviewers; N11; the Fable verifiers for `BRACKET-1c`, `BUNDLE-1` and `DEPCHECK-1`; the `DEPCHECK-1` grant widening and the `DOCS-1` authorization. (The row's state cell still reads "PARTLY DONE", written before the ruling.) | — |

Closed: `B3` (`BACKTEST-2` `fd12be0`, 2026-09-28), `B10` (`UNIV-4` `7c08af7`),
`G-01` (`VENUE-2` `d6aedee`), `H5` (ruled 2026-09-28: one demonstrated run).
Closed earlier: `B1`'s cause (`TRDR-2` `f3da220`), `B2` (`RISK-2` `133eac1`),
`B6`, `B7` and N4 (`GATE-1` `0434c82`), `B8` with N2 (the contract correction;
the `N2` measurement is open), N3 (features), N6, N7, N9, N10 and G-13
(`GOV-2C`). N5 closed later (`CI-1`).

### Residual queue

Open rows only, one line each. An owner cell marked "row" repeats the archived
row's owner as written.

| Id | Residual | Owner |
| --- | --- | --- |
| `H1R1-FRAME-ATOMICITY` | Each venue frame yields two `BookLevelChanged` events and the trader evaluates after each, so half the evaluations see a book that never existed. Ruled by the user 2026-09-30. | `THROUGHPUT-2` (evaluate once per frame) |
| `OUT1-R1-HALT-NOT-DURABLE` | A halt (including `TRANSPORT_UNAVAILABLE`) is not persisted: nothing writes `ops.incidents` or `ops.risk_events`. When a halt record is added, the three outage scenarios must expect exactly that one row (`OUT2-R1-HALT-RECORD-INTERACTION`). | a trader/storage round, before sustained live-data paper runs |
| `H1R1-PROVENANCE` | On all 37,546 H1 decisions, `gateway_epoch`, `ingest_seq` and `feature_snapshot_id` are NULL (`source_event_id` is set). | a trader/storage round (with `OUT1-R1-HALT-NOT-DURABLE`) |
| `H1R1-HALT-INVISIBLE` | A halt that exits quickly never reaches Prometheus: dashboards read `halts 0, healthy 1` until "health unavailable". Same root as `OUT1-R1-HALT-NOT-DURABLE`. | with `OUT1-R1-HALT-NOT-DURABLE` |
| `TRADER-SIGNALS` | The trader has no SIGINT/SIGTERM handler. Ctrl-C skips the `FOLD-1` SHUTDOWN rebuild check and the orderly close (durable writes are already committed per event). | offered to the user as an optional small round before H1 |
| `LOOPMEM-FOLD` | CPU half closed by `FOLD-1` (`2c0bd21`). Remaining: `FOLD-2`, and memory bounding (Option 4, behind `RECON2-DURABLE` and an ADR-006 amendment): the Ledger store is append-only and unbounded. | row: an ADR-level ruling, then a ledger/PnL round |
| `FOLD-2` | LOOPMEM-FOLD Option 3, queued by the user 2026-09-27; runs after `BACKTEST-2` (user, 2026-09-28). Constant-cost PnL updates; serialized bytes, Map order and no-mutation guarantees unchanged. Estimated about 6 s instead of about 890 s for a PnL rebuild at 100k records (not prototyped; measure first). | when backtests or a runtime PnL check justify it; needs a `packages/pnl` grant |
| `FOLD-RELATCH` | Latent: a released MARKET `UNATTRIBUTED_ACTIVITY` halt is re-latched by the next fill in any market. Unreachable today: nothing calls `HaltController.release`. | the round that wires a halt-release seam |
| `FOLD-PNL2TOKEN` | Silent PnL gap: if an instance holds both tokens of a market, only the filled token is marked. Unreachable with single-token Static Bracket. | a PnL correctness round |
| `FOLD-OVERSELL` | After a restart (a new run, empty ledger), selling shares bought in the previous run is a `PNL_OVERSELL`. | the restart/resume design (with `RECON2-DURABLE`) |
| `FOLD1-SLOWTEST` | `apps/trader/src/loop-folds.test.ts`'s 1,000-fill pin is quadratic: about 68 s locally; the CI unit step went from about 102 s to 187 s. | the next round granted `apps/trader/src/**` |
| `RECON2-DURABLE` | Unfilled-order provenance lives only in memory (a bounded 50k window since `TRDR-4`). After a restart, a cancelled unfilled order loses its link to its intent: a §6 invariant 4 gap. | a governance ruling, then a storage round |
| `TRDR4-LIVESETTLE` | Live-adapter obligation, outside PAPER: settle only when every trade is CONFIRMED or FAILED and a §9.17 reconciliation passed; surface orders a refused plan left behind, with `plannedOrderId`. | the live-adapter work package |
| `TRDR4-ORPHAN` | An order left resting by a partly refused plan is ownerless; its market halts (`UNATTRIBUTED_ACTIVITY`) and clearing it is manual. Since `SIM-1` this is defensive only (a future live adapter). | an operator-tooling round, or moot (row) |
| `TRDR4-GAUGES` | `seams.orders`, `seams.retention` and the venue's `retention()` counters are on `/health` only, not exported as gauges. | the next observability round (additions only) |
| `TRDR4-CITES` | A control-API test cites `health-door.ts:181` and `:77`, now `:242` and `:82`. The claim still holds. | the next round touching `test/unit/control-api/**` |
| `RISK2-R1` | `apps/trader/src/pipeline.ts:99-103`'s rule stands, but its premise ("`packages/risk` decides disposition from the intent TYPE") is superseded. | row: `BOOT-1` (merged `0d09eb5`; the row was never marked closed) |
| `TRDR2-R8` | A parenthesized type alias (`type X = (never); value as X`) evades the trader cast census, eslint and tsc. One-line fix plus a self-test. | the next round touching `test/unit/trader/**` |
| `TRDR2 residual 7` | `persistDecision`, `saveCheckpoint` and `appendLedgerTransaction` have no round trip of their own (`GOV-2B` R8 half discharged); plus INFOs `TRDR2-R9`, `TRDR2-R10`. | row: `BOOT-1`'s acceptance for the first two; the rest to the next `apps/trader` round |
| `BOOT1-R6` | `health.loop.decisionsPersisted` counts outbox appends before the write (read 1 with zero rows persisted). It ships as `trader_decisions_persisted_total`. | the next `loop.ts` round |
| `BOOT1-R11` | `trader-health-shape.test.ts:169` passes only because the corrected caveat quotes "WP-220 accepted residual"; `apps/trader/README.md:144-160` still states the WP-220 posture. | the next control-api round; the next round granted `apps/trader/README.md` |
| `BOOT1 fill-link severing` | `ledger_transactions.fill_id`/`order_id` are bound NULL and no `execution.*` rows are persisted, so a rebuild from durable rows cannot reproduce per-fill economics (§6 invariant 8). A pinned test trips when the chain is persisted. | the execution-chain persistence round (Wave 3, `WP-260`+) |
| `BOOT1 pool leak` | `createMigratedContext.close()` leaks the `pg` pool when the context never queried through `context.db`. Fix: `await pool.end()`. | the next round granted `packages/storage-postgres/src/testing/**` |
| `BOOT1 unchecked shared facts` | Registration does not compare instance status, `default_ownership_mode`/`evaluation_priority`, `catalog.market_tokens` or `parameters_version`. (The row's "no registration CLI exists" predates `REGISTER-1`.) | the next `apps/trader` round |
| `TRDR3-R1` | The paper golden's `health.accounting.realizedPnl` is null while the durable path serves the ledger value. Fix in `trader.ts`, then regenerate; expected `{account: "-1.2", …}`. | `TRDR-3-FU1` (candidate; orchestrator authorization after `UNIV-4`) |
| `TRDR3-R2` | `health-server.ts` enforces its 5 s timeouts only every 30 s (Node's `connectionsCheckingInterval`). Loopback, PAPER. Fix: `connectionsCheckingInterval = 1_000`. | `TRDR-3-FU1` |
| `TRDR3-R3` | Three READMEs are false since `da9c58e`, and two tests require the stale sentence; `TRADER_HEALTH_BIND`/`TRADER_HEALTH_PORT` are undocumented. | `TRDR-3-FU1` |
| `TRDR3-R4/R5/R7` | The operations dashboard lacks `control_trader_health_current`; control-API port 9465 collides with the recorder compaction target; `health-door.ts:133` claims a 4096-instance bound it lacks. | the next `apps/control-api`/`infra` round |
| `SNAP1-KEYSET` | `SNAP-1`'s written-keys set grows one entry per snapshot instant: a small regression against `TRDR-4`'s bounded loop. | the next `apps/trader` round |
| `SNAP1-MINOR` | A replaced row keeps its first `computed_at`; no replacement counter; the double accepts some `as_of` values PostgreSQL refuses; a crash window; unowned fills write no snapshot. | the next `apps/trader` round |
| `REGISTER1-LOWS` | Four LOWs in the register command (L1-L4): a misleading refusal on an unmigrated database, two untested codes, the exit-code table, `-h` as a value. | the next `apps/trader/src/register` round |
| `OUTAGE1-LOWS` | Three LOWs: the read deadline is not pinned at trader level; the docker-restart halt is a Testcontainers port artifact; a catch mislabels errors as `TRADER_EVENT_SUBSCRIPTION_REFUSED` (78). | the next `apps/trader` round |
| `UNIV4-R1` | The lifecycle feed attributes a polled body by request, not content. A mis-pointed `gammaMarketId` opens this market on another market's readiness, silently. Operators must verify it. | the next venue round, then the feed refuses a mismatch |
| `UNIV4-R2` | The trader's `markLifecycle` is unguarded: a RESOLVED market re-marked OPEN/CLOSING maps to `ACTIVE`/`CLOSE_ONLY`, not `HALTED`. Also UNIV4-R3: `onMarketClosing` arrives with `secondsRemaining ≈ 0`. | the next `apps/trader` round |
| `UNIV4-R4/R5` | R4: a hold-back after a failed confirmation write is released only by the next epoch. R5: a poll sees changes up to one `pollIntervalMs` late; `publisher.ts:461`'s halt detail is false for derived events. | the next `apps/data-gateway` round |
| `N8` | Control API (`WP-240` r1): M-1 pausing an unknown instance answers `200 PAUSED`; M-3 a read-only operator can exhaust the audit log and so disable every mutation, including the §14.1 kill switch (fail-closed); nine LOWs and N-4. M-2 closed (`TRDR-3`); L-9 is now load-bearing. | the next bounded `apps/control-api` round |
| `G-03` | Only `soak:smoke` is gated. `soak:evaluate` and `soak:compare-books` run only when an operator runs them; `soak:evaluate` is PENDING everywhere. | H4 (`WP-140`); gating is the orchestrator's `ci.yml` decision |
| `SIM-BALANCE` | `SimulatedVenue` has no cash or position sufficiency check (`PP-6`). Upstream risk prevents it today. | a simulation round after `SIM-2` |
| `SIM-ATTEMPT` | One submission attempt per plan; §9.11 reads per signed order. Changing it churns every deterministic id in the goldens (`PP-11`). | the OMS / live-adapter work package |
| `SIM1-BASKET` | BASKET partial handling is unreachable: risk refuses every BASKET and nothing consumes `failurePolicy`. A basket partial fails closed. | a round that makes baskets reachable |
| `SIM1-CANCELDEBIT` | The simulator charges a market cancel's live-target count up front; the venue debits per success. Small and conservative. | a simulation round (with `SIM-BALANCE`) |
| `SIM1-LOOKAHEAD` | A Tier-1 DELAYED order's disposition is computed at submission. Tier 1 only; not in production PAPER. | a Tier-1 fidelity round, with an ADR-012 reading |
| `SIM1-PRICEVALID` | A hand-built planned order is not validated against the price range (planner-built orders are). | a ruling first: the venue's job or the planner's? |
| `SIM2-TIER1-TRADES` | Tier-1 `#trades` and per-trade band cost (`VS-07`) are unbounded; trimming is not byte-safe (pinned). Backtests only. | a Tier-1 round |
| `SIM2-FILTER` | The duplicate-id filter can refuse a new id on a false positive: about 1% after about 1.75 M folded ids. Loud and counted. | revisit if a run approaches 10^6 orders |
| `BRACKET1-TPRACE` | A late entry fill can resize a live take-profit whose cancel then loses a race (`SB.ILLEGAL_TRANSITION`; the instance pauses, fail-closed); an entry fill can arrive while `OPEN`. Needs an edge or a ruling. | the next static-bracket round |
| `BRACKET1-IDLESSVIEW` | An id-less protective reduce whose first view is terminal and partly filled is ignored by D5. Unreachable under fills-before-views delivery. | the next static-bracket round |
| `RISK-2 item 7` | (i) closed by `BRACKET-1a`. (ii) A covered SELL is an EXIT; gating it on direction needs a measure §9.8 lacks. (iii) `planEntry` tags `immediate_order_type` unconditionally, so a PASSIVE entry collides. | (ii) the contract owner; (iii) the next static-bracket round |
| `BRACKET1B-RECON` | Disclosed limits of the per-bracket reconciler: fee records not tied to fills, and four more (all loud where it matters). | the next `test/e2e/**` round |
| `BRACKET1C-LOWS` | L1 closed (`SNAP-1`). L2: the read-back's SQL predicates are not load-bearing. | L2: the next paper-trader integration round |
| `GATE1-M1` | `test:replay` is a hand-maintained list: a renamed file drops out and the gate still exits 0 (the N4 defect). | a round granted `test/unit/**` |
| `TC-LOCAL-FLAKE` | 2 of 5 local `trader test:integration` runs failed on infrastructure (Redis, Reaper); CI was green. | watch CI |
| `LINT1-TSC` | Nothing in CI compiles `tsconfig.lint.json`, so an import outside its `paths` would escape `no-floating-promises` silently. | a round granted `.github/workflows/ci.yml` |
| `DEPS1-VITEST` | Two moderate vitest advisories remain (test-only, below CI's high threshold). Clearing them needs a vitest major. | a tooling round |
| `BUNDLE1-LOWS` | Six LOWs: (1) ADR-018's third bundle pattern; (2) the migrations directory resolves relative to the bundle; (3) a renamed bundle exits 0; (4)-(5) pin coverage; (6) a process note. [`DOCS-1.md`](docs/handoffs/DOCS-1.md) says `DOCS-1` covered (1); the row was not updated. | (1) the next docs round; (2)-(5) the next tooling or apps round |
| `GATE1-R3` | `js-yaml 4.3.2` has run locally since `GATE-1`'s post-merge install. The remaining unknown was the first real CI install. | H2, discharged 2026-09-26 by `CI-1`; the row was not closed |
| `N3` | `packages/execution-planner/src/refusals.ts:178-187` says every public entry point returns a typed result, but `buyLimitPrice`/`sellLimitPrice` throw. | the next bounded grant on `packages/execution-planner/**`; its packet must quote the archived row |
| `N2` | `packages/order-book` `book.ts:191` and `:265` parse caller payloads against object schemas. Whether a defeat is reachable is not measured. | the next bounded grant on `packages/order-book/**` (measure first) |
| `R8-1` | Every `Object.defineProperty` outside `packages/risk`/`capital-allocator` uses a descriptor literal that throws under an inherited `get`. | the detector/tooling round (`§5 item 6`) |
| `§5 item 6` | The detector/tooling round: a `.safeParse`-on-unmaterialized-value detector, census and scan hardening, and the F15-F17 checker. Deliberately last; not a CI gate. | unassigned; the orchestrator authorizes it |
| `H8 track` | Complete (B3 closed). Rulings still in force (user, 2026-09-28): D4, a strategy-agnostic core, waits for a second strategy (S18 has a sunset clause); `FOLD-2` runs after `BACKTEST-2`. | — |

Closed, done or ruled (full rows in the archive): `RISK-2 residual 5`, `RISK2-R6`,
`RISK2-R2`, `RISK2-R3`, `RISK2-R4`, `RECON1-SCAN`, `RECON1-ORIGIN`, `RECON1-TEXT`,
`RECON1-EDGE`, `RECON2-LOOPMEM`, `LOOPMEM-SIM` (remainder: the `SIM-*` rows
above), `SIM2-E2E-MSG`, `RECON2-EVENTHOP`, `RECON2-README`, `N5`, `N1`,
`GATE1-R4`, `CI1-L1`, `CI1-L2`, `CI1-L3`, `CI1-L4`, `CI1-L5`, `CI2-L5-2`,
`CI2-L5-3`, `BT1-R1..R4`, `BOOT1-R7`, `BRACKET-1b`, `BRACKET1C-SNAPKEY`, `M18`,
`BOOT1-CONFIGPARAMS`, `ADR022-DISCHARGE`, `DC1-R1-L1`, `B1-R1-REDIS-UNCAUGHT`,
`BRACKET-1c`.

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

- **H1**, the live-data paper run: run 1 halted fail-closed on throughput (2026-09-29, `B4` above). Re-run after `THROUGHPUT-2`.
- **H2**, a real CI run: discharged 2026-09-26 by `CI-1` (PR #1 run `36282501033`, every gate green).
- **H3**, a real Prometheus and Grafana: performed 2026-09-29 with H1 run 1. The fresh closeout grades it.
- **H4**, elapsed soak evidence: open. It is the `WP-140` gate, which closes only through the runbook §7 governance procedure after a real ≥24h soak.
- **H5**: ruled 2026-09-28. One supervised live-data paper session through the real stack (gateway → Redis → trader → PostgreSQL) that produces decisions and reads back clean discharges runbook :509. Sustained accumulation is the post-closeout activity at :514.
- **H6**, the authorization rows and round order: the orchestrator's, ongoing.
- **H7**: ratified 2026-09-28 (`H7` above).
- **H8**: ruled 2026-09-28, option A (extract the core into a layer-1 package). Done by the H8 track; `B3` is closed.
- **`§5 item 6`**: no owner yet; the orchestrator authorizes it.
- **The fresh read-only Wave 2 closeout audit** (runbook :906) runs after H1 and H3 (user, 2026-09-28).

### Wave 3 authorization (conditional)

The user authorized Wave 3 on 2026-09-30, on a condition. The orchestrator may
start Wave 3 packages (`WP-260` first, then the work-plan chain) only when both
hold:

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
`WP-300`, `WP-360`) all also depend on `WP-260`, directly or transitively. Gate
counts in rows dated before 2026-09-26 come from one laptop; CI first ran with
`CI-1`. Full text:
[`wave-2-qualification.md`](docs/status-archive/wave-2-qualification.md).

## Deviations from specification

One line each; full text in
[`deviations-evidence-gates.md`](docs/status-archive/deviations-evidence-gates.md).

- `WP-010`: the root `eslint.config.mjs` was outside its `allowed_paths`; ratified into WP-010 ownership.
- `WP-010`: Node 24 is pinned by `engines: ">=24"`, CI `node-version: 24` and a runtime smoke assertion, not an exact `.nvmrc`. Acceptable; tighten later if needed.
- `WP-000`: the venue report is `docs/venue/verified-2026-08-24.md`, not the work plan's literal `verified-2026-08-18.md`. Ratified by the orchestrator 2026-08-24.
- **N6**: four Wave 2 records, and most bounded rounds since 2026-09-05, use the completion-record form instead of the eight labelled fields. Recorded 2026-09-15 (`GOV-2C`); `AGENTS.md`'s eight fields control; the form was ratified by the user 2026-09-28 (H7).
- **N7**: ten Wave 2 merges touched `pnpm-lock.yaml` importer blocks. Ratified 2026-09-15 as a pattern (`GOV-2C`). `GATE-1`'s `js-yaml` substitution is recorded, not covered by the pattern.
- **N9**: `WP-200`'s `allowed_paths` names `test/integration/ledger/**`, which does not exist. Recorded 2026-09-15.
- **N11**: `BACKTEST-1` changed one line of the protected root `package.json` (`test:replay`). Ratified 2026-09-16 for that line; the orchestrator owns the class.
- **N3**: a ruling of the form "by the next round touching X" failed twice, because nothing checks it. The systemic fix (a dated comment in the package's work-plan entry) is proposed, not applied.

## Pending external evidence

- **H4**, the ≥24h soak for `WP-140` ([Human items](#human-items)).
- **C-2's reopen condition is met** (2026-09-17, `VENUE-2`; `verified-2026-09-16.md` D-15). The venue now documents a conversion: pUSD is an ERC-20 wrapper representing a USDC claim, wrapped and unwrapped onchain by the `CollateralOnramp` and `CollateralOfframp` contracts, and its `_asset` must be USDC.e. Three names are in play (USDC, USDC native, USDC.e), and the Bridge API labels the pUSD address `"symbol": "USDC"`. The report records this and does not act; the ADR-006 fail-closed rulings are unaffected. Owner: the register/ADR-006 contract owner, through a dated amendment in a governance round with `docs/adr/**` and `docs/contracts/protected-contracts.md` in grant. Also for that owner: U-11 (D-20), the SDK's closed five-value `UmaResolutionStatus` enum against the docs' nullable string.

## Resolved evidence items

- The real GitHub Actions run (2026-09-26, `CI-1`). The first run (`36279491795`, on `926cd08`) failed at "Unit tests" on a vitest worker RPC timeout, with all 7217 tests passing, and skipped seven gates. PR #1 run `36282501033` passed every job, the six integration suites included.
- `docker-compose.yml` runtime validation (2026-08-22): both services healthy, both ports bound to 127.0.0.1 only. Host ports are overridable (`PMB_POSTGRES_PORT`, `PMB_REDIS_PORT`).
- Accepted evidence: the `WP-010` automated gate passed on `main` at `12ce0ab` (2026-08-22), reproduced by the reviewer at `1bca7cf`.

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
