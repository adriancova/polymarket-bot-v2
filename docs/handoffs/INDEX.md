# Handoff index

One line per handoff in this directory, oldest first. "Added" is the date git first recorded the file. Status and merge SHAs come from `IMPLEMENTATION_STATUS.md`. Kinds: WP (a work package), FU (a follow-up to one), Governance, Audit, Round (a bounded round), Operational, Session.

After a merge, add or update the handoff's single row here (see [`README.md`](README.md)).

| Added | Handoff | Package or round | Kind | Outcome | Merge | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-23 | [WP-010.md](WP-010.md) | `WP-010`: Monorepo, CI, compose, and quality gates | WP | Complete (2026-08-22) | `12ce0ab` | 8 KB |
| 2026-08-24 | [WP-000.md](WP-000.md) | `WP-000`: Venue verification and sanitized fixtures | WP | Complete (2026-08-26) | `d427f00` | 82 KB |
| 2026-08-26 | [WP-015.md](WP-015.md) | `WP-015`: Dependency-direction CI enforcement | WP | Complete (2026-08-27) | `d77b2ba` | 148 KB |
| 2026-08-26 | [WP-020.md](WP-020.md) | `WP-020`: Domain contracts and exact decimal types | WP | Complete (2026-08-26) | `25bc451` | 50 KB |
| 2026-08-26 | [WP-030.md](WP-030.md) | `WP-030`: Initial ADR and contract documentation | WP | Complete (2026-08-26) | `59cf254` | 45 KB |
| 2026-08-26 | [WP-040.md](WP-040.md) | `WP-040`: PostgreSQL schemas and migrations | WP | Complete (2026-08-26) | `d23bb67` | 112 KB |
| 2026-08-26 | [WP-050.md](WP-050.md) | `WP-050`: WAL, segment manifests, and crash recovery | WP | Complete (2026-08-26) | `8a607ec` | 74 KB |
| 2026-08-26 | [orchestration-2026-08-26.md](orchestration-2026-08-26.md) | the outgoing orchestrator session's handoff to its successor | Session | Handoff | — | 11 KB |
| 2026-08-26 | [wave-0-closeout-remediation.md](wave-0-closeout-remediation.md) | Wave 0 closeout remediation | Round | Complete (Wave 0 closed) | — | 24 KB |
| 2026-08-27 | [WP-060.md](WP-060.md) | `WP-060`: Redis Streams event transport | WP | Complete (2026-08-27) | `af29b08` | 71 KB |
| 2026-08-27 | [WP-070.md](WP-070.md) | `WP-070`: Polymarket public market-data adapter | WP | Complete (2026-08-27) | `f2f0258` | 106 KB |
| 2026-08-27 | [WP-080.md](WP-080.md) | `WP-080`: Binance reference adapter; also `WP-080-FU1` (ADR-014 takerSide conformance, merged `ebda609`) | WP | Complete (2026-08-28) | `d0d66bf` | 179 KB |
| 2026-08-27 | [WP-090.md](WP-090.md) | `WP-090`: Coinbase reference adapter | WP | Complete (2026-08-27) | `335b1b0` | 70 KB |
| 2026-08-28 | [GOV-1B.md](GOV-1B.md) | `GOV-1B`: contract-owner governance round | Governance | Complete (2026-08-28) | `dd61e1e` | 28 KB |
| 2026-08-28 | [WP-100.md](WP-100.md) | `WP-100`: Polymarket RTDS Chainlink TWAP adapter | WP | Complete (2026-08-30) | `e3ac6a3` + wiring `eaf18f4` | 40 KB |
| 2026-08-28 | [WP-110.md](WP-110.md) | `WP-110`: Universe and settlement specifications | WP | Complete (2026-08-31) | `ea81f5f` | 103 KB |
| 2026-08-30 | [WP-130.md](WP-130.md) | `WP-130`: Parquet compactor and dataset manifests | WP | Complete (2026-08-31) | `cfa353b` + wiring `24903d2` | 103 KB |
| 2026-09-01 | [WP-120.md](WP-120.md) | `WP-120`: Data gateway integration | WP | Complete (2026-09-01) | `0622f45` + wiring `2a49153` | 160 KB |
| 2026-09-02 | [GOV-1C.md](GOV-1C.md) | `GOV-1C`: contract-owner governance round at Wave 1 closeout | Governance | Complete (2026-09-02) | `3272c4b` | 37 KB |
| 2026-09-02 | [GOV-1D.md](GOV-1D.md) | `GOV-1D`: C-2 resolution: USDC vs pUSD denomination | Governance | Complete (2026-09-04) | `61a7ba5` | 27 KB |
| 2026-09-02 | [WP-140.md](WP-140.md) | `WP-140`: Recorder observability and soak harness | WP | Evidence pending: the ≥24h soak (H4); the gate is open | `735d330` + wiring `5757ef3` | 53 KB |
| 2026-09-02 | [WP-150.md](WP-150.md) | `WP-150`: Local exact-decimal order books | WP | Complete (2026-09-02) | `70c7f1f` | 32 KB |
| 2026-09-02 | [WP-170.md](WP-170.md) | `WP-170`: Strategy SDK and deterministic runtime | WP | Complete (2026-09-03) | `9d0971b` | 314 KB |
| 2026-09-02 | [WP-180.md](WP-180.md) | `WP-180`: Capital allocator and scenario risk | WP | Complete (2026-09-04) | `98a6cc1` | 339 KB |
| 2026-09-02 | [WP-200.md](WP-200.md) | `WP-200`: Append-only ledger, allocations, positions, and PnL | WP | Complete (2026-09-03) | `7e75f9a` | 100 KB |
| 2026-09-04 | [GOV-2A.md](GOV-2A.md) | `GOV-2A`: cross-package schema-boundary governance round | Governance | Complete (2026-09-04) | `b4b720a` | 58 KB |
| 2026-09-04 | [WP-160.md](WP-160.md) | `WP-160`: Versioned feature engine | WP | Complete (2026-09-04) | `3d49946` | 8 KB |
| 2026-09-04 | [WP-180-FU2.md](WP-180-FU2.md) | `WP-180-FU2`: mirror collapse to canonical `packages/risk` | FU | Complete (2026-09-04) | `625c83b` | 7 KB |
| 2026-09-04 | [WP-190.md](WP-190.md) | `WP-190`: Execution planner contracts and paper implementation | WP | Complete (2026-09-04) | `5aa11e3` | 6 KB |
| 2026-09-04 | [WP-210.md](WP-210.md) | `WP-210`: Replay clock, event source, simulated venue, and fill models | WP | Complete (2026-09-04) | `bebdd85` + wiring `5b73461` | 9 KB |
| 2026-09-05 | [WP-020-FU1.md](WP-020-FU1.md) | `WP-020-FU1`: decimal/risk index-0 family round | FU | Complete (2026-09-05) | `edf6b1d` | 7 KB |
| 2026-09-05 | [WP-200-FU1.md](WP-200-FU1.md) | `WP-200-FU1`: ledger/pnl schema-boundary door | FU | Complete (2026-09-05) | `a30fec8` | 7 KB |
| 2026-09-05 | [WP-220.md](WP-220.md) | `WP-220`: Static Bracket strategy | WP | Complete (2026-09-05) | `b8f7864` | 7 KB |
| 2026-09-05 | [WP-230.md](WP-230.md) | `WP-230`: Paper trader integration | WP | Complete (2026-09-05) | `8425e03` + wiring `af059d7` | 7 KB |
| 2026-09-06 | [ALLOC-1.md](ALLOC-1.md) | `ALLOC-1`: capital-allocator strategyInstanceId re-typing | Round | Complete (2026-09-06) | `d9f70a6` | 6 KB |
| 2026-09-06 | [REC-1.md](REC-1.md) | `REC-1`: recorder-pipeline hardening round | Round | Complete (2026-09-06) | `327cae7` | 9 KB |
| 2026-09-06 | [WP-160-FU1.md](WP-160-FU1.md) | `WP-160-FU1`: features output-side hardening | FU | Complete (2026-09-06) | `5faf16b` | 5 KB |
| 2026-09-06 | [WP-170-FU1.md](WP-170-FU1.md) | `WP-170-FU1`: strategy-runtime schema-boundary door | FU | Complete (2026-09-06) | `d89841d` | 6 KB |
| 2026-09-06 | [WP-180-FU3.md](WP-180-FU3.md) | `WP-180-FU3`: packages/risk remainder round | FU | Complete (2026-09-06) | `8c14b47` | 7 KB |
| 2026-09-06 | [WP-240.md](WP-240.md) | `WP-240`: Control API and paper dashboards | WP | Complete (2026-09-06) | `0e7227d` + wiring `80126e8` | 8 KB |
| 2026-09-06 | [WP-250.md](WP-250.md) | `WP-250`: Determinism and paper end-to-end verification | WP | Complete (2026-09-06) | `ce7fbe0` + wiring `da37a0c` | 6 KB |
| 2026-09-07 | [CLOB-1.md](CLOB-1.md) | `CLOB-1`: polymarket-public CLOB doors | Round | Complete (2026-09-07) | `eb0c586` | 7 KB |
| 2026-09-07 | [SETL-1.md](SETL-1.md) | `SETL-1`: packages/settlement spec door | Round | Complete (2026-09-07) | `af991ee` | 6 KB |
| 2026-09-07 | [SETL-2.md](SETL-2.md) | `SETL-2`: settlement observation/evaluation door | Round | Complete (2026-09-07) | `6142e66` | 6 KB |
| 2026-09-07 | [TRDR-1.md](TRDR-1.md) | `TRDR-1`: apps/trader instanceId relaxation | Round | Complete (2026-09-07) | `65ae56c` | 4 KB |
| 2026-09-07 | [UNIV-1.md](UNIV-1.md) | `UNIV-1`: packages/universe lifecycle door | Round | Complete (2026-09-07) | `4d7443b` | 6 KB |
| 2026-09-07 | [UNIV-2.md](UNIV-2.md) | `UNIV-2`: universe registration + envelope doors | Round | Complete (2026-09-07) | `f90ff05` | 6 KB |
| 2026-09-07 | [UNIV-3.md](UNIV-3.md) | `UNIV-3`: universe state-side round | Round | Complete (2026-09-07) | `cbc1ed3` | 6 KB |
| 2026-09-07 | [WP-200-FU2.md](WP-200-FU2.md) | `WP-200-FU2`: ledger/pnl own accumulators | FU | Complete (2026-09-07) | `af4aacc` | 5 KB |
| 2026-09-11 | [WP-060-FU1.md](WP-060-FU1.md) | `WP-060-FU1`: event-bus envelope door | FU | Complete (2026-09-11) | `d869868` | 14 KB |
| 2026-09-15 | [GATE-1.md](GATE-1.md) | `GATE-1`: gate the evidence; clear the audit step — GOV-2B **B6**, **B7**, N4, N5 | Round | Complete (2026-09-15) | `0434c82` | 8 KB |
| 2026-09-15 | [GOV-2B-wave-2-closeout.md](GOV-2B-wave-2-closeout.md) | `GOV-2B`: the Wave 2 closeout audit (runbook §10) | Audit | Verdict: WAVE 2 IS NOT CLOSED | — (audited `b9bacc1`) | 11 KB |
| 2026-09-15 | [RISK-2.md](RISK-2.md) | `RISK-2`: protective-reduction recognition — GOV-2B **B2** | Round | Complete (2026-09-15) | `133eac1` | 10 KB |
| 2026-09-15 | [SER-0-sweep.md](SER-0-sweep.md) | `SER-0`: the inherited-`toJSON` measurement | Round | Measurement complete | `9a44167` | 19 KB |
| 2026-09-15 | [SER-1.md](SER-1.md) | `SER-1`: own-data JSON encoder + accounting keys | Round | Complete (2026-09-15) | `c065d63` | 10 KB |
| 2026-09-15 | [SER-2.md](SER-2.md) | `SER-2`: durable bytes: WAL, Parquet, PostgreSQL | Round | Complete (2026-09-15) | `0d8b6a0` | 10 KB |
| 2026-09-15 | [SER-3.md](SER-3.md) | `SER-3`: outbound bytes, runtime decisions, soak artifacts | Round | Complete (2026-09-15) | `603a49c` | 10 KB |
| 2026-09-15 | [TRDR-2.md](TRDR-2.md) | `TRDR-2`: the pnl_snapshots column binding — GOV-2B **B1** | Round | Complete (2026-09-15) | `f3da220` | 8 KB |
| 2026-09-16 | [BACKTEST-1.md](BACKTEST-1.md) | `BACKTEST-1`: the replay composition root — GOV-2B **B3** | Round | Complete (2026-09-16) | `b462501` | 8 KB |
| 2026-09-16 | [BOOT-1.md](BOOT-1.md) | `BOOT-1`: the durable trader's bootstrap rows — GOV-2B **B9**, raised by the TRDR-2 review | Round | Complete (2026-09-16) | `0d09eb5` | 11 KB |
| 2026-09-16 | [GOV-2C.md](GOV-2C.md) | `GOV-2C`: ledger integrity and the contract-owner docs debt — GOV-2B **B8**, N2, N3, N6, N7, N9, N10, G-13 | Governance | Complete (2026-09-16) | `33c36f9` | 8 KB |
| 2026-09-16 | [VENUE-2.md](VENUE-2.md) | `VENUE-2`: the phase-2 venue gate — GOV-2B **G-01** | Round | Complete (2026-09-17) | `d6aedee` | 25 KB |
| 2026-09-17 | [TRDR-3.md](TRDR-3.md) | `TRDR-3`: the trader health endpoint and an exact-decimal PnL producer — GOV-2B **B5**'s code half, R4 | Round | Complete (2026-09-17) | `da9c58e` | 25 KB |
| 2026-09-17 | [UNIV-4.md](UNIV-4.md) | `UNIV-4`: the market lifecycle producer — closeout blocker **B10**, found by `BACKTEST-1` | Round | Complete (2026-09-17) | `7c08af7` | 41 KB |
| 2026-09-17 | [WAVE-2-HANDOVER.md](WAVE-2-HANDOVER.md) | Wave 2 handover: what the agents closed, what only the human can | Session | Handoff | — | 15 KB |
| 2026-09-26 | [CI-1.md](CI-1.md) | `CI-1`: the first real CI run's failure; GATE1-R4; N5 | Round | Complete (2026-09-26) | `7248073` | 9 KB |
| 2026-09-26 | [CI-2.md](CI-2.md) | `CI-2`: four of `CI-1`'s review LOWs — `CI1-L1`, `CI1-L3`, `CI1-L4`, `CI1-L5`; `CI1-L2` is `LINT-1` | Round | Complete (2026-09-26) | `6325d10` | 36 KB |
| 2026-09-26 | [LINT-1.md](LINT-1.md) | `LINT-1`: `CI1-L2`: nothing catches a floating promise | Round | Complete (2026-09-26) | `e3a3389` | 21 KB |
| 2026-09-26 | [RECON-1.md](RECON-1.md) | `RECON-1`: the e2e reconciler's two latent traps — `RISK2-R3`, `RISK2-R4` | Round | Complete (2026-09-26) | `de58d83` | 10 KB |
| 2026-09-26 | [RECON-2.md](RECON-2.md) | `RECON-2`: `RECON-1`'s four residuals — `RECON1-SCAN`, `RECON1-ORIGIN`, `RECON1-TEXT`, `RECON1-EDGE` | Round | Complete (2026-09-26) | `a4d1159` | 50 KB |
| 2026-09-27 | [FOLD-1.md](FOLD-1.md) | `FOLD-1`: LOOPMEM-FOLD Option 2: the ledger view and PnL updated IN PLACE, with a rebuild-equals-incremental check | Round | Complete (2026-09-27) | `2c0bd21` | 46 KB |
| 2026-09-27 | [SIM-1.md](SIM-1.md) | `SIM-1`: LOOPMEM-SIM part 1: `SimulatedVenue` CORRECTNESS, which bounding depends on | Round | Complete (2026-09-27) | `93c7bbd` | 81 KB |
| 2026-09-27 | [SIM-2.md](SIM-2.md) | `SIM-2`: LOOPMEM-SIM part 2: BOUND `SimulatedVenue` | Round | Complete (2026-09-27) | `04bf9d8` | 46 KB |
| 2026-09-27 | [TRDR-4.md](TRDR-4.md) | `TRDR-4`: the trader loop's unbounded state — `RECON2-LOOPMEM`, widened by scoping | Round | Complete (2026-09-27) | `fea251f` | 47 KB |
| 2026-09-28 | [BACKTEST-2.md](BACKTEST-2.md) | `BACKTEST-2`: the H8 track, round 4: the backtest CLI builds the real trading core; closes blocker B3 | Round | Complete (2026-09-28) | `fd12be0` | 13 KB |
| 2026-09-28 | [BRACKET-1a.md](BRACKET-1a.md) | `BRACKET-1a`: RISK-2 residual 5: the protective reduce gets an order track, so an instance survives its own exit | Round | Complete (2026-09-28) | `11969f3` | 88 KB |
| 2026-09-28 | [BRACKET-1b.md](BRACKET-1b.md) | `BRACKET-1b`: §7 item 1 evidence: a two-bracket e2e run with a FILLED take-profit; the reconciler learns two brackets; `RECON2-EVENTHOP` | Round | Complete (2026-09-28) | `7252150` | 72 KB |
| 2026-09-28 | [BRACKET-1c.md](BRACKET-1c.md) | `BRACKET-1c`: §7 item 1: one DURABLE two-bracket round trip — real PostgreSQL + real Redis through the real composition root | Round | Complete (2026-09-28) | `6e06c50` | 28 KB |
| 2026-09-28 | [BUNDLE-1.md](BUNDLE-1.md) | `BUNDLE-1`: H1 blocker M18: the trader's shipped bundle crashes at load | Round | Complete (2026-09-28) | `fd30e5f` | 25 KB |
| 2026-09-28 | [CORE-MOVE.md](CORE-MOVE.md) | `CORE-MOVE`: the H8 track, round 3: MOVE the paper core into `packages/trading-core`; move-only | Round | Complete (2026-09-28) | `33b7d0b` | 22 KB |
| 2026-09-28 | [DEPCHECK-1.md](DEPCHECK-1.md) | `DEPCHECK-1`: the H8 track's checker-hardening round: F10, app-endpoint CHK, F16's relative half, stale-row CHK; ride-alongs `CI2-L5-2`/`CI2-L5-3` | Round | Complete (2026-09-28) | `d7f2906` | 19 KB |
| 2026-09-28 | [DOCS-1.md](DOCS-1.md) | `DOCS-1`: append-only documentation owed by the H8 track | Round | Complete (2026-09-28) | `2e7f618` | 17 KB |
| 2026-09-28 | [H8-GOV.md](H8-GOV.md) | `H8-GOV`: the H8 track, round 1: ADR-022 + a staged dependency-contract amendment + work-plan ratification; documentation only | Governance | Complete (2026-09-28) | `bb58edb` | 42 KB |
| 2026-09-28 | [SNAP-1.md](SNAP-1.md) | `SNAP-1`: H1 blocker `BRACKET1C-SNAPKEY`: one PnL snapshot per instance per instant | Round | Complete (2026-09-28) | `fff844d` | 77 KB |
| 2026-09-29 | [H1-RUN-1.md](H1-RUN-1.md) | H1 run 1 and H3: the first live-data paper run | Operational | Halted fail-closed (throughput); H3 performed | — | 7 KB |
| 2026-09-29 | [OUTAGE-1.md](OUTAGE-1.md) | `OUTAGE-1`: pre-H1 outage hardening: Redis unreachable at start → a documented refusal; a Redis outage mid-run → a bounded, fail-closed halt instead of a hang; registered config parameters checked | Round | Complete (2026-09-29) | `143ad8d` | 41 KB |
| 2026-09-29 | [OUTAGE-2.md](OUTAGE-2.md) | `OUTAGE-2`: make OUTAGE-1's PARTITION outage test deterministic; prove nothing is written after a halt | Round | Complete (2026-09-29) | `a618752` | 39 KB |
| 2026-09-29 | [REGISTER-1.md](REGISTER-1.md) | `REGISTER-1`: pre-H1: an operator registration command | Round | Complete (2026-09-29) | `7f1ebc0` | 64 KB |
| 2026-09-29 | [THROUGHPUT-1a.md](THROUGHPUT-1a.md) | `THROUGHPUT-1a`: the trader keeps pace with a live 15-minute market; its stream lag is visible | Round | Complete (2026-09-30) | `229d58a` | 18 KB |
| 2026-09-29 | [THROUGHPUT-1b.md](THROUGHPUT-1b.md) | `THROUGHPUT-1b`: the gateway publishes a window-open burst without overflowing; the example config subscribes to books | Round | Complete (2026-09-30) | `c179095` | 17 KB |
| 2026-09-30 | [THROUGHPUT-2.md](THROUGHPUT-2.md) | `THROUGHPUT-2`: evaluate once per venue frame: no half-applied book states; reach the H1 burst rate | Round | Complete (2026-09-30) | `7d59fd3` | 30 KB |
| 2026-09-30 | [VENUE-3.md](VENUE-3.md) | `VENUE-3`: the phase-3 venue gate: the Wave 3 start re-verification, including the C-4 re-check and a fresh SDK pin check | Round | Complete (2026-09-30) | `6a15131` | 15 KB |
| 2026-09-30 | [H1-RUNS-2-8.md](H1-RUNS-2-8.md) | `H1` runs 2-8: live-data PAPER runs after THROUGHPUT-1a/1b/2 | Operational | H1 discharged under H5 (decisions and vetoes; no fill) | — | 5 KB |
| 2026-09-30 | [LOGS-1.md](LOGS-1.md) | `LOGS-1`: `IMPLEMENTATION_STATUS.md` becomes a brief; history archived verbatim | Round | Complete (2026-09-30) | `7ac7985` | 13 KB |
| 2026-09-30 | [CLOSEOUT-2-wave-2-closeout.md](CLOSEOUT-2-wave-2-closeout.md) | `CLOSEOUT-2`: fresh Wave 2 closeout audit (runbook §10) | Audit | WAVE 2 NOT CLOSED: blocker `X1` | — (an audit) | 20 KB |
| 2026-09-30 | [DURABLE-1.md](DURABLE-1.md) | `DURABLE-1`: a decision is durable before its order and ledger effects (`X1`) | Round | Complete (2026-09-30) | `6e01228` | 23 KB |
| 2026-09-30 | [CLOSEOUT-2B-wave-2-regrade.md](CLOSEOUT-2B-wave-2-regrade.md) | `CLOSEOUT-2B`: focused re-grade of Wave 2 after `DURABLE-1` | Audit | WAVE 2 CLOSED WITH QUALIFICATIONS (with the user's CANCEL ruling) | — (an audit) | 13 KB |
| 2026-09-30 | [LEAN-1.md](LEAN-1.md) | `LEAN-1`: a sub-$100/mo first deployment (plan and the user's rulings) | Governance | Planned; ruled H, A1-A5 | — (a plan) | 26 KB |
| 2026-09-30 | [DEPS-2.md](DEPS-2.md) | `DEPS-2`: patch `@grpc/grpc-js` for GHSA-m9gg-hp2v-232j | Round | Complete (2026-09-30) | `c5967b4` | 1 KB |
| 2026-09-30 | [WP-260.md](WP-260.md) | `WP-260`: secure unified-SDK adapter and signer boundary | WP | Complete (2026-09-30) | `32d10be` | 38 KB |
| 2026-09-30 | [HOST-BENCH-PREP.md](HOST-BENCH-PREP.md) | `HOST-BENCH-PREP`: the laptop guide and host measurement tools | Round | Complete (2026-09-30) | `1710a86` | 23 KB |
| 2026-09-30 | [CI-3.md](CI-3.md) | `CI-3`: run the secure-SDK contract suite in CI | Round | Complete (2026-09-30) | `a145fa4` | 1 KB |
| 2026-09-30 | [LEAN-GOV.md](LEAN-GOV.md) | `LEAN-GOV`: ADR-025..030 and work-plan rows for the LEAN-1 rulings | Governance | Complete (2026-09-30) | `78ba39b` | 6 KB |
| 2026-10-01 | [WP-300.md](WP-300.md) | `WP-300`: collateral inventory and wallet operations | WP | Complete (2026-10-01) | `9cdbf32` | 9 KB |
| 2026-10-01 | [STORAGE-1.md](STORAGE-1.md) | `STORAGE-1`: research tier, pinned windows, verified raw expiry, disk metrics | WP | Complete (2026-10-01) | `a22502b` | 10 KB |
| 2026-10-01 | [CI-4.md](CI-4.md) | `CI-4`: run the wallet-operations contract suite in CI | Round | Complete (2026-10-01) | `4628541` | 2 KB |
| 2026-10-01 | [STORAGE-GOV.md](STORAGE-GOV.md) | `STORAGE-GOV`: ADR-028 Amendment 1 | Governance | Complete (2026-10-01) | `1f75ac0` | 3 KB |
| 2026-10-01 | [STORAGE-1b.md](STORAGE-1b.md) | `STORAGE-1b`: the storage cycle lock's round-6 LOWs | Round | Complete (2026-10-01) | `7b6499e` | 4 KB |
| 2026-10-01 | [WP-300b.md](WP-300b.md) | `WP-300b`: WP300-R10-01 and the contract suite fetch tripwire | Round | Complete (2026-10-01) | `05535ae` | 4 KB |
| 2026-10-01 | [STORAGE-GOV2.md](STORAGE-GOV2.md) | `STORAGE-GOV2`: ADR-028 Amendment 1 corrections; ADR-029 header | Governance | Complete (2026-10-01) | `a428ba3` | 2 KB |
| 2026-10-01 | [CONTROL-1.md](CONTROL-1.md) | `CONTROL-1`: CO2-N8, the kill switch cannot be starved via the audit log | Round | Complete (2026-10-01) | `b9d9818` | 6 KB |
| 2026-10-01 | [CO2-N1-ADR.md](CO2-N1-ADR.md) | `CO2-N1-ADR`: ADR-031 (Proposed), admitting entries when the trader lags | Governance | Complete (2026-10-01): Proposed | `1770be3` | 5 KB |
| 2026-10-01 | [CONTROL-1b.md](CONTROL-1b.md) | `CONTROL-1b`: authoritative no-signer checks; lock key; durable-sink prerequisites | Round | Complete (2026-10-01) | `80a06e2` | 7 KB |
| 2026-10-02 | [THROUGHPUT-1c.md](THROUGHPUT-1c.md) | `THROUGHPUT-1c`: book freshness by feed liveness (ADR-023) | Round | Complete (2026-10-02) | `0c270df` | 6 KB |
| 2026-10-02 | [WP-300c.md](WP-300c.md) | `WP-300c`: hostile evidence, refusal codes, module-load tripwires, unguessable request ids | Round | Complete (2026-10-02) | `7e05702` | 5 KB |
| 2026-10-02 | [ADR031-ACCEPT.md](ADR031-ACCEPT.md) | `ADR031-ACCEPT`: ADR-031 Accepted; ADR-032 | Governance | Complete (2026-10-02) | `a60ee27` | 3 KB |
| 2026-10-03 | [APPROX-REPLAY-1.md](APPROX-REPLAY-1.md) | `APPROX-REPLAY-1`: approximate replay over the research tier | WP | Complete (2026-10-03) | `86830d9` | 3 KB |
| 2026-10-03 | [PROVENANCE-1.md](PROVENANCE-1.md) | `PROVENANCE-1`: decision provenance, durable halts and refusals | Round | Complete (2026-10-03) | `71d8b80` | 5 KB |
| 2026-10-03 | [CO2-N1.md](CO2-N1.md) | `CO2-N1`: ADR-031's entry guard on the process clock | Round | Complete (2026-10-03) | `9869e53` | 4 KB |
| 2026-10-03 | [WALCAP-1.md](WALCAP-1.md) | `WALCAP-1`: the WAL cap after expiry; the stall-bound flake | Round | Complete (2026-10-03) | `da559ca` | 5 KB |
| 2026-10-03 | [WP-270.md](WP-270.md) | `WP-270`: the OMS and signed-order persistence | WP | Complete (2026-10-03) | `259c964` | 7 KB |
| 2026-10-03 | [CADENCE-1.md](CADENCE-1.md) | `CADENCE-1`: ADR-026 evaluation cadence | WP | Complete (2026-10-03) | `8d7086a` | 6 KB |
| 2026-10-03 | [WP-280.md](WP-280.md) | `WP-280`: the authenticated user-stream adapter | WP | Complete (2026-10-03) | `065716f` | 4 KB |
| 2026-10-03 | [WP-310.md](WP-310.md) | `WP-310`: rate-limit budgets and matching-engine modes | WP | Complete (2026-10-03) | `fdf27ff` | 7 KB |
| 2026-10-03 | [CKPT-1.md](CKPT-1.md) | `CKPT-1`: ADR-027, checkpoint on change plus a 60 s heartbeat | Round | Complete (2026-10-03) | `891ccdd` | 5 KB |
| 2026-10-03 | [ADR033-REVIEW.md](ADR033-REVIEW.md) | `ADR033-REVIEW`: ADR-033 checked, corrected and accepted (the order heartbeat, C-12) | Round | Complete (2026-10-03) | `47575cf` | 3 KB |
| 2026-10-04 | [TC-LOWS-1.md](TC-LOWS-1.md) | `TC-LOWS-1`: pin the open trading-core and trader LOWs | Round | Complete (2026-10-04) | `9033743` | 4 KB |
| 2026-10-04 | [GOV-NOTES-1.md](GOV-NOTES-1.md) | `GOV-NOTES-1`: dated corrections to ADR-028 Amendment 1 rule 6 and wal-format §11.1 | Round | Complete (2026-10-04) | `1f99fcc` | 3 KB |
| 2026-10-04 | [CONTROL-2.md](CONTROL-2.md) | `CONTROL-2`: open trader halts in the control API, fail closed; CONTROL-1b's LOWs | Round | Complete (2026-10-04) | `2f84ad7` | 5 KB |
