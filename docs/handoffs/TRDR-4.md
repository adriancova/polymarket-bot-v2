# TRDR-4: bound the trader loop's per-order state (`RECON2-LOOPMEM`, widened)

Branch `trdr-4` on base `30cc3ff`, merged into `main` as `fea251f` (`--no-ff`) on 2026-09-27.

- **Authorized** 2026-09-26 by the user ("gotcha, let's go for it please").
- **Scoped** by a read-only workflow (`wf_38604101-524`), which widened the queue item:
  - the dominant growth was per EVENT: every order ever placed was re-delivered on every harvest;
  - `ctx.orders()` returned full history;
  - an ownerless fill was silently skipped, which is a live accounting bug.
- **User rulings (2026-09-26):**
  - R1: deliver a finished order's view until it has been evaluated once, then retire it.
  - R2: the trader loop now; the simulated venue and the ledger/PnL folds are queued.
- **Process:** the user's HARDENING LOOP (workflow `wf_a73ed519-f87`): an Opus implementer, gates run outside any sandbox (including Testcontainers), and Codex gpt-6-astra verification, looped until ACCEPT.

| Commit | Content |
| --- | --- |
| `ed6d656` | r0: all eight items; both goldens regenerated |
| `d549e99` | r1: `TRDR4-R1` (HIGH): a refused multi-order plan released an order the venue still held |
| `fea251f` | the merge |

## Outcome
- **R1.**
  - A working order is still delivered on every harvest.
  - A terminal order is delivered until ONE delivery actually returns DECIDED. A halt-suppressed delivery, an uncomputable snapshot, or a REFUSED (paused), CONTAINED or HALTED outcome does not count.
  - After that the order is retired: no more `onOrderUpdate`, and it leaves `ctx.orders()`, which now matches the SDK's "working orders" contract.
  - Pinned for an immediate order, a halted instance, a real pause and a paused refusal. A stale-adoption probe never finds a terminal view.
- **Settlement.** Per-order state is pruned only when all four conditions hold: terminal at a harvest boundary; booked fill shares equal to the venue's `filledShares` (an exact-decimal counter; a mismatch is counted and never pruned); retired; and no pending cancel.
  - Pruned: the owner, the trace lookup, the instance order set, the view-tracker entry and the counter.
  - A bounded tombstone remains (`OrderTombstones`, built like `FillDeduplicator`).
- **Ownerless fills are loud.** Posted with `claims: []`, such a fill lands UNATTRIBUTED with `haltRequired` and triggers the MARKET `UNATTRIBUTED_ACTIVITY` halt (`RECONCILE_ACCOUNT`). The halt detail names the tombstone's probable owner, but the fill is never attributed to it. It is counted in `unownedFills`, and also in `lateFillsAfterSettlement` when a tombstone matched. Pinned for a settled order, an unknown order, an evicted tombstone and the present-day orphan path through the real `SimulatedVenue`.
- **`TRDR4-R1` (HIGH, Codex r1; pre-existing).**
  - The bug: a refused plan released the reservation, allocator commitment and time-in-force of every planned order. The simulator refuses a partly booked plan with `orders: []`, but keeps the earlier orders RESTING, so a still-working order lost its entries. ADR-006 §9 forbids that.
  - The fix: `#releaseRefusedPlacement` releases only orders the venue does not hold. A held order keeps its entries until the harvest sees it terminal, and its market halts for reconciliation.
  - Pinned with a one-placement budget: 10 × 5 passive slices, of which 9 are released, and the resting slice keeps GTC, reservation and allocator entries until it fills UNATTRIBUTED.
- **Time-in-force leak:** entries recorded before an allocator refusal are released.
- **Audit logs.** Decisions (100k), traces (50k) and an append-only provenance log (50k, split from the prunable lookup) keep a capped window, with `retained` / `maximumRetained` / `evicted` counters. Both goldens pin `evicted 0`. Tombstones are capped at 100k.
- **Health (additive):** `seams.orders` and `seams.retention`. The control-api strict door requires both; its fixture and health-shape tests are updated; `packages/observability` is untouched.
- **Long synthetic run** (not a soak, §16.7): 500+ orders through the real CoreLoop with a cycling strategy double. After every event, each per-order map holds exactly the working orders, and deliveries per event stay flat.
- **NOT bounded, and not claimed:** `#pnlRecords` and the Ledger (`LOOPMEM-FOLD`); `SimulatedVenue` history (`LOOPMEM-SIM`). The loop still iterates `ordersSnapshot()`, which is O(history) CPU per harvest.

## Goldens (regenerated once each)
- **paper-e2e** (format 2 → 3), 18 → 12 decisions.
  - Removed: exactly the six `onOrderUpdate` / `hold` / `SB.IDLE` terminal repeats.
  - Renumbered: every later `evaluationSeq`, including the reduce's trace and provenance (9 → 8).
  - Health counters: checkpoints and evaluations 18 → 12; `orderViews` emitted 10 → 4, repeats 6 → 0.
  - **Independently re-checked by the orchestrator:** events, fills, orders, ledger transactions, ledger projection, PnL records, PnL snapshots, reconciliation and scenario are byte-identical sections.
- **backtest static-bracket:** the same six decisions are removed and renumbered. The simulation-run (orders, fills, economics), ledger, PnL and driver sections are byte-identical.

## Reviews (Codex gpt-6-astra)
- **r1 of `ed6d656`: CHANGES REQUIRED, 1 HIGH (`TRDR4-R1`).**
- **r2 of `d549e99`: ACCEPT, no findings.** Codex rebuilt the r1 reproduction:
  - at the candidate: the resting slice keeps GTC, reservations `open:1` and allocator `open:1`, and the market halts `UNATTRIBUTED_ACTIVITY`;
  - with `ed6d656`'s `loop.ts`: the original failure (time-in-force undefined).

  It confirmed byte-for-byte restoration of 1,357 tracked paths.

## Evidence
- **Verification gates at `d549e99`, outside any sandbox:**
  - typecheck 0, lint 0, check:deps PASS;
  - unit 339 / 7315;
  - e2e 7 / 157;
  - replay 3 / 17;
  - trader integration 14 / 129 (Docker 29.1.2);
  - control-api integration 10 / 86.
- **GitHub Actions:** PR #6 run `36302053284` green on all three jobs.

## Queued (new)
- `TRDR4-LIVESETTLE`: a live-adapter obligation.
  - Settlement must also require every trade of the order to be CONFIRMED or FAILED, and a §9.17 reconciliation to have passed.
  - An adapter must surface the orders a refused plan left behind, carrying `plannedOrderId`.
- `TRDR4-ORPHAN`: a partial-refusal orphan keeps its entries until it goes terminal. That is the safe direction, but it is operator reconciliation work. The Incident Controller (§9.9) could offer a SAFETY_CANCEL; that is a design addition.
- `TRDR4-GAUGES`: `packages/observability` could export `seams.orders` / `seams.retention`.
- `TRDR4-CITES`: `test/unit/control-api/response-encoder-bound.test.ts` cites stale `health-door.ts` lines.
- Refinements to existing rows:
  - `LOOPMEM-SIM` gains "report partial plan execution, or refuse the whole plan up front", and "Tier-1 band orders report `filledShares` 0, so they settle-mismatch and are never pruned".
  - `RECON2-DURABLE` gains "traces now evict beyond 50k: counted, not persisted".

## commit_sha
`d549e997b98044604239d5b38f09ad4291edefb5` (branch `trdr-4`), merged as `fea251f`.

---

# Appendix A — implementer handoff, r0 (verbatim)

# TRDR-4 — implementation handoff, round 0

## plan (written before any edit)

Base `30cc3ff`, worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-trdr-4`, branch `trdr-4`.
Docker available (server 29.1.2). Prerequisites present: scoping report, rulings R1/R2 in
`IMPLEMENTATION_STATUS.md`, both goldens and their tests, `CoreLoop`/`TraderVenue`, the
control-api door and fixture.

### Production (apps/trader/src)

1. **New `order-lifecycle.ts`** (no new dependency):
   - `OrderTombstones` — `orderId → instanceId`, built like `FillDeduplicator`: insertion-ordered
     `Map`, `maximumRemembered`, oldest-first eviction, `evictions` counter, constructor refuses a
     bound below 1 (and a non-safe-integer).
   - `RetentionLog<T>` — bounded append-only log (ring buffer, O(1) append/evict),
     `entries()` oldest→newest, `metrics() = {retained, maximumRetained, evicted}`, refuses a
     bound below 1.
   - `settlementBlocker(...)` — the pure (a)-(d) predicate, so every arm is unit-testable.
   - Default bounds, argued from the scoping sizes: decisions 100 000, traces 50 000,
     provenance 50 000, tombstones 100 000.
2. **`loop.ts`**:
   - R1 in `#deliverOrderViews`: a non-terminal order is delivered every harvest (unchanged);
     a terminal order is delivered until ONE delivery returns `DECIDED`, then it is RETIRED.
     Halt-suppressed, snapshot-unavailable, `REFUSED` (PAUSED), `CONTAINED` and `HALTED`
     outcomes do not count. Terminal releases unchanged.
   - `#orderViews_` (ctx.orders()) excludes retired orders.
   - Settlement (a)-(d) in the same harvest-boundary pass, after every delivery of the
     harvest (so a cancel registered by a delivery is seen by (d)); prunes `#orderOwners`,
     the `#orderTraces` LOOKUP, `#instanceOrders` (set removed when empty),
     `OrderViewTracker` entry (new `forget`), the booked-shares counter, the retired flag; then a
     tombstone. A mismatch is counted once per order and never pruned.
   - `#orderTraces` split: prunable LOOKUP (fill join) + append-only PROVENANCE log
     (`orderProvenance()`); `#decisions`, `#traces`, provenance become `RetentionLog`s.
   - Ownerless fill: posted with `claims: []` (UNATTRIBUTED, `haltRequired`), cash moves,
     store append, projection counters, `haltOnLedgerProjection` (extended with an optional
     per-transaction note so the halt detail names the tombstone's probable instance);
     counted `unownedFills` (+ `lateFillsAfterSettlement` on a tombstone hit). Never
     attributed, never delivered.
   - Time-in-force released on allocator refusal.
   - `health()` adds `seams.orders` and `seams.retention`; a read-only
     `retainedOrderState()` accessor gives the per-map sizes for the synthetic run.
   - `CoreLoopOptions.retention?` (constructor options with defaults); `createPaperTrader`
     passes an optional `retention` through.
   - Rewrite the old-design statements (`loop.ts` "EVERY order, EVERY harvest, INCLUDING
     repeats", `orders.ts` header rule 2 and the class docs).
3. **`health.ts`**: `SeamHealth` gains `orders?` and `retention?` — OPTIONAL on the type
   because `test/unit/trader/**` (forbidden to this round) builds `HealthState.snapshot`
   inputs with the five existing seams; `CoreLoop.health()` always supplies both and its
   return type says so; the control-api door REQUIRES both, so an omitting producer is
   refused, never defaulted. Nothing renamed or removed.
4. **`halt.ts`**: `haltOnLedgerProjection(controller, projection, at, notes?)` — additive.

### control-api
`health-door.ts` strict schema gains `seams.orders` and `seams.retention`; the fixture
(`src/testing/index.ts`), `health-door.test.ts`, and the control-api integration tests that
build health documents are updated in the same commit.

### Tests (new)
- `apps/trader/src/order-lifecycle.test.ts` — the three classes/predicate; small-bound
  eviction oldest-first.
- `apps/trader/src/loop-order-retirement.test.ts` — WP-250 scenario, real composition,
  `vi.spyOn` on the runtime's `evaluate` to observe `ctx.orders()` and deliveries: normal run,
  immediate order, halted instance (halt released later), PAUSED (a REAL pause via the
  watchdog, plus the runtime's refusal answer), stale adoption, settlement (a)-(d) incl.
  mismatch and pending cancel via a `TraderVenue` double, retention bounds through
  `createPaperTrader`.
- `apps/trader/src/loop-unowned-fills.test.ts` — `TraderVenue` double injecting a fill for a
  settled id and for an unknown id; tombstone eviction; the orphan-plan case through the real
  `SimulatedVenue` (token-bucket 1 + `maxSliceShares` slicing); the TIF leak.
- `apps/trader/src/loop-long-run.test.ts` — deterministic synthetic run (not a soak): real
  `CoreLoop` + a cycling strategy double through the real runtime, risk, planner, allocator,
  `SimulatedVenue`, ledger; >= 500 orders; bounded maps; flat per-event deliveries; retention
  counters; yields to the macrotask queue.

### Goldens (last)
Regenerate `paper-e2e-run.json` (WP250_WRITE_GOLDEN) and the backtest
`expected-artifact.txt` by its documented capture path (`renderArtifact` over
`replayThroughShippedRoot({withCore:true})`, via a scratch probe, twice, byte-equal).
Categorize hunks, prove order/fill/ledger/PnL identity with a scratch script, name removed
decisions (predicted 7, 11, 12, 15, 16, 17), run determinism twice, update R1 pins only.

### Out of scope, stated
`packages/**` (LOOPMEM-SIM, LOOPMEM-FOLD); `#pnlRecords` and the Ledger stay unbounded; the
process is NOT claimed memory-bounded; nothing here is soak evidence.

---

## summary

TRDR-4 round 0 is implemented and committed as `ed6d656` on `trdr-4`, a single commit on base `30cc3ff`. Every gate exits 0.

1. **R1 (user ruling, binding).** `#deliverOrderViews` still delivers a WORKING order on every harvest.
   - A TERMINAL order is delivered until ONE delivery is evaluated. Only a runtime `DECIDED` counts. These do not count:
     - a halt-suppressed delivery;
     - an unavailable snapshot;
     - `REFUSED` (a PAUSED runtime);
     - `CONTAINED` (the callback failed and its state did not move);
     - `HALTED`.
   - After that the order is RETIRED: no further `onOrderUpdate`, and `ctx.orders()` excludes it.
   - The terminal releases are unchanged.
2. **Settlement.** It requires all of (a) to (d). It prunes the owner, the trace LOOKUP, the instance set, the view tracker, the booked counter and the retired flag, then leaves a bounded tombstone.
   - A booked-shares mismatch is counted once per order and never pruned.
   - The predicate is total: a non-canonical quantity is a mismatch, never a throw.
3. **Ownerless fills.** They are posted with `claims: []`, which makes them UNATTRIBUTED with `haltRequired`.
   - The MARKET `UNATTRIBUTED_ACTIVITY` halt (`RECONCILE_ACCOUNT`) comes through `haltOnLedgerProjection`. Its detail carries the tombstone's PROBABLE owner.
   - They are counted in `unownedFills`, plus `lateFillsAfterSettlement` when a tombstone matched, and never attributed.
   - The present-day orphan path is reproduced through the real `SimulatedVenue` and pinned.
4. **Time-in-force leak.** It is closed: the entries are released when the allocator refuses the plan.
5. **Audit logs.** `#orderTraces` is split into a prunable lookup and an append-only provenance log.
   - `#decisions`, `#traces` and the provenance log are bounded `RetentionLog`s with counters.
   - Defaults: 100 000 decisions, 50 000 traces, 50 000 provenance records and 100 000 tombstones. The goldens pin that no fixture evicts.
   - `#pnlRecords` and the Ledger are NOT bounded (`LOOPMEM-FOLD`). The process is NOT claimed memory-bounded.
6. **Health.** `seams.orders` and `seams.retention` are additions only; nothing is renamed. The control-api strict door requires them, and its fixture and shape tests are updated. `packages/observability` is untouched.
7. **Long synthetic run.** It drives 500+ orders through the real `CoreLoop` with a cycling strategy double. It is NOT a soak.
   - The maps equal the working-order count after every event.
   - Deliveries per event stay flat.
   - The stale-adoption probe never fires.
   - Retention counters evict oldest-first.
   - It takes about 7 s alone and 12.6 s under full-suite load.
8. **Goldens.** Both are regenerated once and mechanically proven.
   - The removed decisions are exactly the predicted terminal repeats, old `evaluationSeq` 7, 11, 12, 15, 16 and 17, identified by the order each one delivered.
   - Determinism passes twice.

### Golden categorization

**`test/replay-golden/paper-e2e/paper-e2e-run.json`** (sha256 `3ec3880c…` → `0527aa59182e43aa309fae66418be05bbccb5db2dbf73a4e63aeb11face3bd71`, format 2 → 3). Hunks by category:
- **Removed repeat decisions.** Six records were removed:
  - old seq 7: the entry, at 09:00:03;
  - old seq 11 and 12: the entry and the take-profit, at 09:14:49;
  - old seq 15, 16 and 17: the entry, the take-profit and the reduce, at 09:14:50.

  Each was an `onOrderUpdate` `hold` with `SB.IDLE` and no intents. Identity comes from the probes, which recorded `input.order` per `evaluationSeq` in the base run and the new run (`identity-base.json` / `identity-new.json`).
- **Renumbered `evaluationSeq`.** The mapping is 8→7, 9→8, 10→9, 13→10 and 14→11. The reduce's `traces[2]` and `orderProvenance[2]` `evaluationSeq` move 9→8.
- **Checkpoints.** `checkpointInstants` loses one instant per removed decision; there are 12 left.
- **Health counters.**
  - `loop.evaluations`, `decisionsPersisted` and `featureSnapshots`: 18→12.
  - `seams.orderViews`: `emitted` 10→4, `repeats` 6→0, `tracked` 3→0.
- **New health seams.**
  - `seams.orders`: tracked 0, settled 3, tombstones 3/100000, evictions 0, unowned 0, late 0, mismatches 0.
  - `seams.retention`: decisions 12/100000, traces 3/50000, provenance 3/50000, all evicted 0.
- **Anything else.** `goldenFormatVersion` 2→3, and nothing more.
- **Mechanical proof** (`scratchpad/trdr-4/prove-paper-e2e.py`, output `proof-paper-e2e.txt`). It reports ALL PROVEN on these points:
  - these sections are identical as parsed values: `scenario`, `events`, `orders`, `fills`, `ledgerTransactions`, `pnlRecords`, `pnlSnapshots`, `ledgerProjection` and `reconciliation`;
  - the decisions equal the base minus the identity-proven terminal repeats, with the same delivered-order identity;
  - the total intents are unchanged;
  - `traces` and `orderProvenance` are identical except the renumbered `evaluationSeq`;
  - health differs only in the listed fields.

**`test/replay-golden/backtest/static-bracket/expected-artifact.txt`** (sha256 `c7e71e5e…` → `764160ebc7f7ed75397550ea9d784a5f22deacae3406533c5af39c2394481854`). It was regenerated by its documented path: a scratch probe calls `renderArtifact(await replayThroughShippedRoot({ withCore: true }))` twice, the two results are byte-equal, and the file is written once. Hunks by category:
- **Removed repeat decision lines:** the same six, old seq 7, 11, 12, 15, 16 and 17. Identity comes from `bt-identity-*.json`, recorded through the replay root at base and at the new commit.
- **Renumbered.** Seq 8→7, 9→8, 10→9, 13→10 and 14→11. The reduce trace's `evaluationSeq` moves 9→8.
- **Health line.** `evaluations` and `decisionsPersisted`: 18→12.
- **Store line.** `decisions` and `checkpoints`: 18→12.
- **Mechanical proof** (`prove-backtest.py`, output `proof-backtest.txt`). It reports ALL PROVEN on these points:
  - these sections are byte-identical: `header`, `simulation-run` (every order, fill and economics line), `ledger`, `pnl` and `driver`;
  - the decisions equal the base minus the repeats, with identity checked;
  - the traces are identical but for the renumbered seq;
  - the health and store lines differ only in the named keys.

**Scoping prediction.** It held exactly: the removed decisions are seq 7, 11, 12, 15, 16 and 17 in both goldens, and the reduce moves 9→8.

**Determinism, run twice.**
- `test/e2e/determinism-golden.test.ts` passed 5/5 on each of 2 runs.
- `test/unit/simulation/backtest-static-bracket-replay.test.ts` passed 8/8 on each of 2 runs.
- The golden hashes were stable across both passes (`determinism-twice.txt`).

### Pins changed (old → new, reason)
- `test/e2e/reconciliation-attribution.test.ts:1084`: `(trace 9, provenance 18)` → `(trace 8, provenance 18)`. R1 moved the reduce's `evaluationSeq` 9→8. The two comments naming "evaluation 9" (lines ~1077 and ~1396) now say 8, with a TRDR-4 note.
- `test/integration/paper-trader/halts-reservations-and-seams.test.ts`:
  - "all five seam sections" becomes "all seven": the key list gains `orders` and `retention`;
  - it adds live-value pins for `seams.orders` and `seams.retention` (evicted 0);
  - it adds store decisions = `loop.decisions()` length.

  Reason: item 6 (health shape) and the "no fixture evicts" pin.
- `test/unit/simulation/backtest-static-bracket-replay.test.ts`: comment only. The "trailing onOrderUpdate holds are SB.IDLE deliveries" statement is corrected, because under R1 `onMarketClosing` is the last decision. No assertion changed.
- `test/replay-golden/backtest/static-bracket/README.md`: reduce `seq=9`→`8`; counts 18→12; residual-5 `seq=10`→`9` and `seq=14`→`11`; a paragraph documenting the TRDR-4 re-capture.
- `test/replay-golden/paper-e2e/README.md`: the `health` row describes format 3 and the new seams; a "TRDR-4 regeneration" section is added.
- `test/e2e/support/artifact.ts`: `GOLDEN_FORMAT_VERSION` 2→3, and `seams.orders` and `seams.retention` are captured.
- **Control-api health-shape pins.**
  - `apps/control-api/src/health-door.test.ts`: the seam `it.each` gains `orders` and `retention`, and a new describe block covers the TRDR-4 seams (a missing field, an unknown key, a negative or a fractional value is refused).
  - `test/integration/control-api/trader-health-shape.test.ts`: the seams now come from the REAL `OrderTombstones` and `RetentionLog` producers; value pins are added; a new test shows a snapshot without the TRDR-4 seams is REFUSED.
  - `health-refresh-wiring.test.ts` and `trader-health-http-source.test.ts`: the seams inputs gain the two sections.

### Non-vacuity
**(a)** I temporarily restored the 30cc3ff versions of `apps/trader/src/{loop,orders,health,halt,trader}.ts`, then restored my versions; `sha256sum -c` passed.
- **New trader pins as committed:** 16 of 31 fail on base. The 15 that pass are the pure unit tests of the new `order-lifecycle.ts` module, which exists regardless.
- **Pins that fail on base behaviour:**
  - the WP-250 run: `['FILLED','FILLED','FILLED','FILLED']` vs `['FILLED']`;
  - immediate order: a retired order is still in the next `ctx.orders()`;
  - mismatch: 4 deliveries vs 1;
  - TIF: the entry is still `'FAK'`;
  - retention: 18 decisions vs 12;
  - the bound refusal does not throw.
- **Pins that fail on the missing surface** (`retainedOrderState` / `seams.orders`): halted, PAUSED (both), (d), the four ownerless-fill cases, the long run, and `OrderViewTracker.forget`.
- **Behaviour-only copies**, with every surface assertion stripped (scratch `behaviour/*.probe.ts`), run against base: 15 of 16 fail on BEHAVIOUR.
  - halted: a retired order is still in `ctx.orders()`;
  - PAUSED refusal: 4 deliveries vs 2;
  - (d): no UNATTRIBUTED arrival after settlement;
  - settled, unknown, evicted and orphan: no UNATTRIBUTED activity and no halt;
  - long run: 120 deliveries per event (the ≤ 20 check fails), and separately `TRDR4.ADOPTED_TERMINAL` fires, which is the stale-adoption hazard reproduced on base.

  The one that passes on base is the REAL-pause case. It is legitimate: a refused offer is re-offered on base too, and only the retirement/settlement state distinguishes the two.
- **Health-shape pins on base:**
  - control-api integration: 10 of 86 fail (the door refuses a snapshot without the new seams);
  - trader integration: 1 of 129 fails (the seven-seam pin).

**(b)** I reverted only the R1 retirement (the `#retired.add` line), then restored the file; `sha256sum -c` passed.
- `determinism-golden` failed ("first difference at line 11").
- `test:replay` failed the backtest golden byte comparison.

## files_changed
Production:
- `apps/trader/src/order-lifecycle.ts` (NEW): `DEFAULT_RETENTION`, `RetentionBounds`, `retentionBoundsProblem`, `RetentionLog`, `OrderTombstones`, `OrderLifecycleMetrics`, `RetentionMetrics`/`RetentionHealth`, `settlementBlocker`, `UNREADABLE_BOOKED_SHARES`.
- `apps/trader/src/loop.ts`:
  - R1 delivery;
  - the retire rule;
  - `#settle`, `#cancelPendingFor`, `#bookUnownedFill`, `#readProjection`, `#traceFill`, `#countBookedShares`;
  - the lookup/provenance split and the retention logs;
  - the TIF release on allocator refusal;
  - `health()` returning `LoopHealthSnapshot`, and `retainedOrderState()`;
  - `CoreLoopOptions.retention`;
  - key comments and rewritten design statements.
- `apps/trader/src/orders.ts`: header rule 2 rewritten for R1; `OrderViewTracker.forget`; repeat doc.
- `apps/trader/src/health.ts`: `SeamHealth.orders?` and `retention?`, passed through only when supplied.
- `apps/trader/src/halt.ts`: the optional `notes` parameter of `haltOnLedgerProjection`.
- `apps/trader/src/trader.ts`: the `retention` passthrough, and the total refusal (`TRADER_CONFIG_REFUSED`) of a bad bound.
- `apps/trader/src/index.ts`: exports of the new API.
- `apps/control-api/src/health-door.ts`: the `OrderLifecycleSeam` and `RetentionSeam` strict schemas (required); the `TraderHealthDocument` type.
- `apps/control-api/src/testing/index.ts`: the fixture gains the two seams.

Tests:
- NEW: `apps/trader/src/order-lifecycle.test.ts`, `apps/trader/src/loop-order-lifecycle.test.ts`, `apps/trader/src/loop-long-run.test.ts`.
- `apps/control-api/src/health-door.test.ts`.
- `test/integration/control-api/{trader-health-shape,health-refresh-wiring,trader-health-http-source}.test.ts`.
- `test/integration/paper-trader/halts-reservations-and-seams.test.ts`.
- `test/e2e/support/artifact.ts`, `test/e2e/reconciliation-attribution.test.ts`.
- `test/unit/simulation/backtest-static-bracket-replay.test.ts` (comment only).

Goldens and READMEs:
- `test/replay-golden/paper-e2e/{paper-e2e-run.json,README.md}`
- `test/replay-golden/backtest/static-bracket/{expected-artifact.txt,README.md}`

## tests_run
All on the final tree, with the `pnpm_config_verify_deps_before_run=false` prefix. Docker 29.1.2 was available.

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 (run again after the last edit) |
| `pnpm run lint` | exit 0 (run again after the last edit) |
| `pnpm run check:deps` | exit 0 |
| `pnpm run test` | exit 0: **338 files / 7313 tests** (base 335 / 7267; +3 files, +46 tests) |
| `pnpm run test:e2e` | exit 0: **7 / 157** (base 7 / 157; no new e2e tests) |
| `pnpm run test:replay` | exit 0: **3 / 17** (base 3 / 17) |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0: **14 / 129** (base 14 / 129). The Postgres and Redis testcontainer files ran: `durable-trader-first-fill-postgres`, `durable-pnl-snapshot-postgres`, `trader-health-endpoint-postgres`, `univ-4-gateway-opens-trader-redis` |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0: **10 / 86** (base 10 / 85; +1) |

New tests, 47 in total:
- **46 in the unit gate:**
  - `order-lifecycle.test.ts` (16): RetentionLog ×5, OrderTombstones ×3, `settlementBlocker` ×5, `OrderViewTracker.forget` ×1, the default bounds and `retentionBoundsProblem` ×2;
  - `loop-order-lifecycle.test.ts` (14): R1 ×5 (the WP-250 run, immediate, halted, real PAUSED, PAUSED refusal), settlement (b) and (d), ownerless ×4 (settled, unknown, evicted tombstone, orphan plan), TIF leak, retention ×2;
  - `loop-long-run.test.ts` (1);
  - `health-door.test.ts` (+15): the two added `it.each` rows, the read test, 8 missing `orders.*` fields, 3 retention logs, and the unknown/negative/fractional test.
- **1 in control-api integration:** `trader-health-shape` "the door REFUSES a snapshot whose producer supplied no TRDR-4 seams".

Also run:
- the paper-e2e golden regeneration, once with `WP250_WRITE_GOLDEN=1`;
- the backtest capture probe, once, writing the golden;
- the determinism tests, twice;
- both mechanical proofs;
- both identity probes, at base and at the new commit;
- the non-vacuity (a) and (b) runs.

## assumptions
- **What counts as "evaluated" (R1).** Only a runtime `DECIDED` counts.
  - `CONTAINED` does not count: the callback failed, the state patch was not applied and the runtime paused.
  - `HALTED` does not count either: persistence failed.
  - Both leave the view deliverable, which is the fail-safe direction.
- **A scope-wide pending cancel counts as naming the order for (d).** A pending cancel with no order ids is scope-wide for its market, so it is read as naming every order of that market. This is conservative: it only delays settlement.
- **Settlement after `SILENCE_EXCEEDED`.** Once the cancel ledger has resolved a cancel `SILENCE_EXCEEDED` (which also halts the market), nothing is pending, so a retired order may settle. The packet's (d) asks only for "no pending cancel".
- **What an unowned fill moves.** It moves `#cash`, the ledger and the store, because the venue moved the money. It does not move the allocator cost basis, any instance PnL stream or any strategy delivery. A trace is written only when a lookup prefix still exists (the registry-miss case).
- **Keying.** The per-order maps are keyed by `SimulatedOrder.simulatedOrderId`, the venue id; the release books by `plannedOrderId`. They are equal in the simulator, and nothing relies on that.
- **Retention bounds.** They are a programmatic option (`CoreLoopOptions.retention` / `CreateTraderOptions.retention`), not part of the operator config document. This follows the packet's "constructor options with defaults".

## deviations
- **The new seams are optional on the `SeamHealth` type.**
  - `test/unit/trader/{health-server,health-realized-pnl}.test.ts` build `HealthState.snapshot` inputs with the five original seams, and they are outside this grant. So `orders` and `retention` are optional on the type and passed through only when supplied; nothing is ever defaulted to zero.
  - `CoreLoop.health()` always supplies both (return type `LoopHealthSnapshot`), and the control-api door REQUIRES both. A new shape test proves an omitting producer is refused.
- **The halt detail comes through a note.** The tombstone's probable owner reaches the halt detail through a new optional `notes` parameter of `haltOnLedgerProjection`, keyed by ledger transaction id. The halt is still raised by that function.
- **A bad retention bound is refused, not thrown.** `createPaperTrader` refuses it with the existing `TRADER_CONFIG_REFUSED` code, because the function is documented TOTAL. The `CoreLoop`/`RetentionLog`/`OrderTombstones` constructors still throw `RangeError`, like `FillDeduplicator`.
- **The e2e golden format was bumped to 3.** It now captures `seams.orders` and `seams.retention`, which makes "no fixture evicts" part of the golden. The backtest renderer was NOT changed (R1-only grant there). Its no-eviction is pinned by the existing `store.decisions.length === loop.decisions().length` assertion, and it is the same scenario as the e2e golden.
- **How the PAUSED case is pinned.** It is pinned twice:
  - a REAL pause: the runtime's monotonic clock is made to jump, so the first `onFill` overruns the 5 s watchdog and is CONTAINED, which pauses the instance for good;
  - the runtime's own `REFUSED/INSTANCE_PAUSED` answer through a spy, for the "lifted" case. A real pause cannot be lifted within a run ("resumption is a new run").
- **How the stale-adoption pin is built.** It uses a strategy DOUBLE that adopts exactly like Static Bracket's `adoptOrder` (the first `(outcome, side)` view by id, no status filter), across 50+ entry cycles in the long run. Static Bracket itself cannot open a second bracket at trader level: RISK-2 residual 5 pauses it after the first round trip, and `packages/**` is out of scope. On base the probe fires (`TRDR4.ADOPTED_TERMINAL`).
- **One out-of-scope edit, caught and reverted.** I briefly exported `TraderHealthDocument` from `apps/control-api/src/index.ts`, which is outside the allowed paths. I reverted it before the commit; the file is byte-identical to base, and the gates were re-run afterwards.

## known_risks
- **The process is still not memory-bounded.** `#pnlRecords`, the in-memory Ledger (re-folded on every evaluation) and `SimulatedVenue` `#orders`/`#fills`/`#trades` still grow.
  - This shows in the long run: per-tick cost grows with booked fills, which is why the double keeps fills rare.
  - `#releaseSettledReservations` and `#deliverOrderViews` still iterate `venue.ordersSnapshot()`, which lists every order ever placed. That is O(history) CPU per harvest, although deliveries per event are now flat (`LOOPMEM-SIM`).
- **`#traces` can now evict.** It is the only in-process link from a fill to its ledger transaction ids, because durable rows carry `fill_id NULL`. An eviction beyond 50 000 traces is counted, not persisted (`RECON2-DURABLE`).
- **Tombstone eviction degrades only the classification.** A late fill for an evicted order is classified "unknown" rather than "late"; it is still UNATTRIBUTED, halted and counted.
- **A live adapter needs a stronger settlement rule.** Settlement assumes a terminal view plus booked == filled means no more fills. At a real venue, trades settle asynchronously (MATCHED→CONFIRMED/FAILED). The loud path covers a late fill, but the settlement rule should become "every trade confirmed and a §9.17 reconciliation passed" (see follow_up).
- **Some simulator orders never settle.** The simulator's dead-but-non-terminal orders never reach terminal (`LOOPMEM-SIM`: a FAK partial, a marketable-limit remainder, an expired partial), so they are never retired or settled. Tier-1 band orders report `filledShares "0"` and would count as a settle mismatch, never pruned.
- **Drifted line citations.** `test/unit/control-api/response-encoder-bound.test.ts` (a forbidden path) cites `health-door.ts:181` and `:77`.
  - Those are now `:242` and `:82`; `:181` had already drifted at base, where the line was `:192`.
  - Its claim that the door schema is fixed-shape, with no new `z.record`, still holds.
- **Timing under load.** The long run takes about 7 s alone and 12.6 s under full-suite load. Its timeout is 60 s, and it yields every 25 events.

## follow_up
- `LOOPMEM-SIM` (packages/simulation): prune terminal orders, add a fill cursor or drain API, make dead orders terminal, and report partial plan execution. The orphan path pinned here would then become an owned fill.
- `LOOPMEM-FOLD`: incremental ledger and PnL folds, with snapshot plus tail kept byte-identical.
- `RECON2-DURABLE`: persist traces and provenance before they are evicted.
- A live-adapter obligation: before settling, require every trade of the order to be CONFIRMED or FAILED and a §9.17 reconciliation to have passed.
- `packages/observability` could export `seams.orders` and `seams.retention` as gauges. This was not done: it is additions-only and out of scope.
- Docs (forbidden here): an `IMPLEMENTATION_STATUS.md` row and a `docs/handoffs/TRDR-4.md` record.
- Refresh the stale line citations in `response-encoder-bound.test.ts`.

## commit_sha
`ed6d656c586311ddcbeb09f59259b3f8e23f9fde` (branch `trdr-4`, parent `30cc3ff`; not pushed).

---

# Appendix B — implementer handoff, r1 (verbatim)

# TRDR-4 — remediation round 1 handoff

## plan (written before editing; the pre-edit hand-back is waived)

The single finding is TRDR4-R1 (HIGH). The loop's venue-refusal branch released the reservation, the allocator commitment and the time-in-force of every planned order. It did this even for an order the simulator had already booked, when it refused a LATER order of the same plan.

The fix is a new helper, `#releaseRefusedPlacement`, which keys every planned order by its PLANNED id:
- if the venue holds NO order under that id, release its three entries now (MEDIUM-4, unchanged);
- if the venue HOLDS one, keep all three entries. `#releaseSettledReservations` releases them at the first harvest that sees the order terminal; it already walks every venue order, owned or not;
- if anything is held, halt the held order's market (MARKET, `UNATTRIBUTED_ACTIVITY`, `RECONCILE_ACCOUNT`).

The pins:
- a new real-venue RESTING-first-slice test;
- an extension of the round-0 filled-orphan test;
- a no-halt guard for an outright refusal.

Nothing leaves `apps/trader/src/**`, and no golden should change.

## Finding table

| Finding | Severity | Disposition | Pin(s) that fail on `ed6d656` and pass on `d549e99` |
| --- | --- | --- | --- |
| TRDR4-R1 | HIGH | **FIXED** | `apps/trader/src/loop-refused-plan.test.ts`: "the RESTING first slice keeps its reservation, allocator commitment and time-in-force until it is terminal; the market halts for reconciliation"; and `apps/trader/src/loop-order-lifecycle.test.ts`: "the ORPHAN of a plan the real venue partly executed and then refused is booked UNATTRIBUTED and halts" (extended) |

The verifier reported no other finding and no scope violation. The orchestrator's gate file reported every gate at exit 0 on `ed6d656`.

## summary

TRDR4-R1 is fixed in commit `d549e99`, which sits on top of `ed6d656` (no amend, no rebase).

**Cause.** The branch rested on a false assumption: that a refused submission produced no order. `SimulatedVenue.#submitSync` books a plan's orders one at a time. When a later order fails (the rate-limit budget, a duplicate id, or an execution refusal), `#refuse` answers `accepted: false, orders: []` for the WHOLE plan, and the earlier orders stay in the venue's book. They can be RESTING, PARTIALLY_FILLED or already terminal.

At `ed6d656` the loop then released every planned order's three entries. For a still-working order, that breaks ADR-006 §9 ("never released before terminal"). It also raised no halt for a RESTING orphan, because nothing fills it.

**Fix.** The new `CoreLoop.#releaseRefusedPlacement(placement, result, instant)` in `apps/trader/src/loop.ts`, called from the refusal branch of `#submitPlan`:
- It collects the plan's planned order ids. It treats as HELD any order whose `plannedOrderId` is in the plan, drawn from two sources: the refused answer's own `orders`, and the venue's `ordersSnapshot()`, read last so the fresher view wins. The key is `plannedOrderId` because all three books use it; `simulatedOrderId` is the venue's own id.
- **Not held:** the reservation, the allocator commitment and the time-in-force are released now, and `reservationsReleasedOnRefusal` counts them. This is the MEDIUM-4 behaviour, unchanged.
- **Held, in any state:** all three are KEPT.
  - `#releaseSettledReservations` walks every venue order, owned or not. It returns the three entries at the first harvest that sees the order terminal, after that harvest's fills are booked. That is the same rule and the same moment as for an owned order. The method's doc now says that this is load-bearing.
- **Any held order:** the market of each held order is halted immediately with MARKET `UNATTRIBUTED_ACTIVITY`, whose §9.9 action is `RECONCILE_ACCOUNT`.
  - The detail names the plan, the refusal code and message, "N of its M planned orders", and each held order as `id (planned id) STATE filled/requested`. It also contains the phrase "partly executed and then refused".
  - The held orders stay ownerless. They are never delivered, never in `ctx.orders()`, and any fill of theirs goes through `#bookUnownedFill`, so it is UNATTRIBUTED and counted.
- The docs that claimed a refused submission "produces no order" are corrected: `allocation.ts` (the module table and `release`) and `health.ts` (`reservationsReleasedOnRefusal`).

**Why halt on ANY held order, not only a working one?**
- The verifier's minimal remediation asked for a halt "when partial execution leaves working orders". Halting on any held order is a strict superset of that, and it is the fail-closed choice.
- A refused answer that contradicts the venue's own state is exactly §6 invariant 6's "unknown submission → reconciliation question".
- If a held order has already FILLED, the unowned-fill path would halt anyway, but only at the harvest. Halting at the refusal stops every later decision of the same iteration. For example, a `ReferenceTradeObserved` event evaluates every market before the harvest, and risk's `runStatePermitsIntent` is `!anyHalt`.
- An outright refusal, where nothing is held, raises no halt. A pin guards this.

**Goldens are unaffected.** No fixture, golden or backtest reaches a partial refusal. `test:e2e` and `test:replay` pass with both goldens byte-unchanged, and `git status` was clean after every gate.

## files_changed

Production:
- `apps/trader/src/loop.ts`:
  - the refusal branch calls the new `#releaseRefusedPlacement`, which carries a full doc comment;
  - the `#releaseSettledReservations` doc now states the owned-or-not property.
- `apps/trader/src/allocation.ts`: docs only (the module book table sentence and the `release` doc).
- `apps/trader/src/health.ts`: docs only (`reservationsReleasedOnRefusal`).

Tests:
- `apps/trader/src/loop-refused-plan.test.ts` (NEW, 2 tests). It uses the real `CoreLoop`, strategy runtime, feature engine, books, allocator, risk, planner, `SimulatedVenue` (Tier 0, with `tokenBucketRateLimits`) and ledger. A one-shot strategy double emits a `MAKER_ONLY`/`PASSIVE`/GTC BUY of 50 at 0.2, which is sliced 10 × 5 (`maxSliceShares: "5"`).
- `apps/trader/src/loop-order-lifecycle.test.ts`: the round-0 filled-orphan test is extended (new assertions plus a comment; no existing assertion was removed or weakened).

Not changed: goldens, READMEs, e2e/integration pins, control-api, `packages/**`, `db/**`, `docs/**`, and the package, lock, eslint and tsconfig files.

## tests_run

Every gate below was run on the FINAL tree, with the `pnpm_config_verify_deps_before_run=false` prefix. Docker reported server 29.1.2.

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run check:deps` | exit 0 |
| `pnpm run test` | exit 0: **339 files / 7315 tests** (`ed6d656`: 338 / 7313; +1 file, +2 tests) |
| `pnpm run test:e2e` | exit 0: **7 / 157** (unchanged) |
| `pnpm run test:replay` | exit 0: **3 / 17** (unchanged) |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0: **14 / 129** (unchanged). The Postgres and Redis testcontainer files ran. |
| `pnpm --filter @polymarket-bot/control-api test:integration` | exit 0: **10 / 86** (unchanged) |

`git diff --check` was clean.

**New tests (2):**
- `loop-refused-plan.test.ts` › "the RESTING first slice keeps its reservation, allocator commitment and time-in-force until it is terminal; the market halts for reconciliation";
- `loop-refused-plan.test.ts` › "a plan the venue refused OUTRIGHT (it booked nothing) releases every planned order and raises no halt — MEDIUM-4 unchanged".

**Extended test (1):** `loop-order-lifecycle.test.ts` › "the ORPHAN of a plan the real venue partly executed and then refused is booked UNATTRIBUTED and halts". It adds:
- the halt detail `1 of its 2 planned orders` and `<id> (planned <id>) FILLED 30/30`;
- `reservationsReleasedOnRefusal` = 1, where `ed6d656` gives 2;
- both books at `open 0`, `taken/applied 2`, `released 2`;
- `timeInForceFor(held)` undefined.

**Non-vacuity.** Only `apps/trader/src/loop.ts` was swapped for `git show ed6d656:apps/trader/src/loop.ts`. It was then restored and checked with `sha256sum -c` (OK), and the run was repeated on the final tree.
- **Committed pins on `ed6d656`:** 2 of 16 fail, exactly the two targeted tests.
  - RESTING test: `expected 10 to be 9` (`reservationsReleasedOnRefusal`, the first differing assertion).
  - Filled-orphan test: `expected 'unattributed actual activity on pUSD …' to contain '1 of its 2 planned orders'`.
  - The outright-refusal guard passes at both commits, as intended.
- **Behaviour-only probe.** This is a scratch copy of the new file with only the counter assertion removed, run through `scratchpad/trdr-4/behaviour-r1.config.mts`. On `ed6d656` it fails with **`expected undefined to be 'GTC'`**, the verifier's exact symptom, so the ADR-006 assertion itself is what fails there. The same probe passes on the final tree.
- **On the final tree:** both files pass, 16 / 16.
- The worktree ended clean. The scratch material (`r1/`, `behaviour-r1/`, `behaviour-r1.config.mts`) is outside the repository.

## assumptions

- **Held evidence.** It is keyed by the PLANNED order id and drawn from the refused result's `orders` plus `ordersSnapshot()`. `TraderVenue` exposes no other order state. A real adapter's `ordersSnapshot()` must list orders the venue accepted under a refused plan, or the kept/released split degrades to MEDIUM-4's release-all. That remains the adapter's obligation, as it already is for owned orders.
- **Why the halt is `UNATTRIBUTED_ACTIVITY`, not a new code.**
  - A venue order no instance owns is actual activity without attribution (§6 invariant 7), and its §9.9 action, `RECONCILE_ACCOUNT`, is what the verifier asked for.
  - A new `HaltReasonCode` would have widened the control-api door's halt vocabulary and the goldens' health capture for no behavioural gain.
- **No new health counter.** The halt record carries the evidence on the health surface (`halts[]`), and `submissionsRefused` / `reservationsReleasedOnRefusal` already count. A new `seams.orders` field would have forced a third regeneration of both goldens. No count is lost: nothing is dropped, and a KEPT entry stays visible in `seams.reservations.open` and `seams.allocator.open`.
- **Halt on any held order, working or terminal.** This is the conservative superset of the verifier's "working orders" wording (see the summary).

## deviations

- The verifier's remediation says "halt … when partial execution leaves working orders". The implementation halts when the venue holds ANY order of the refused plan, a strict superset. The reasoning is in the summary.
- The round-0 filled-orphan test's halt now comes from the refusal, not from the later unowned-fill harvest. The halt controller keeps the FIRST record per scope. Both details contain "partly executed and then refused", so the round-0 assertion still holds. The UNATTRIBUTED posting, the counters and the `ACTUAL_ARRIVAL` records of that test are unchanged. The unowned-fill halt path itself stays pinned by the settled, unknown and evicted-tombstone tests.

## known_risks

- **An orphan resting order that never becomes terminal keeps its entries forever.** The loop does not cancel it, because no instance owns it, so it is never in any `ctx.orders()`. This is the fail-closed direction: collateral and inventory are understated, never overstated. The market is halted, so no further plan in that market consumes more. Removing the order is the operator's reconciliation act.
- **Duplicate planned id (pathological).** If a refusal is caused by `SIMULATED_VENUE_DUPLICATE_ORDER` and an earlier plan's order holds that id, the entries under that id are KEPT and the market halts. Keeping is conservative. Planned ids come from the deterministic id factory, so this is not expected.
- **Cost of the refusal branch.** `ordersSnapshot()` is O(history) (`LOOPMEM-SIM`). It is now also read in the refusal branch, which runs once per refused placement, so the added cost is small.
- The round-0 known risks stand unchanged:
  - the process is not memory-bounded;
  - `#pnlRecords` and the Ledger are unbounded (`LOOPMEM-FOLD`);
  - `SimulatedVenue` history grows (`LOOPMEM-SIM`);
  - trace eviction is not persisted (`RECON2-DURABLE`);
  - a live-adapter settlement rule is still needed;
  - some simulator orders are dead but never terminal;
  - `response-encoder-bound.test.ts` still cites stale lines.

## follow_up

- **`LOOPMEM-SIM`.** The simulator should report partial plan execution in the refused result, listing the orders it did book. Alternatively, it should refuse before booking anything, for example by checking the rate-limit budget for the whole plan up front. Either way, the "orphan" becomes either owned or never created, and this halt becomes unreachable in paper.
- **Operator/Incident Controller (§9.9).** An `UNATTRIBUTED_ACTIVITY` halt caused by a partial refusal could offer a SAFETY_CANCEL of the held working orders (§6 invariant 13). That would be a design addition beyond this package; the loop does not auto-cancel.
- **A real venue adapter must:**
  - surface orders a refused plan left behind in `ordersSnapshot()`, or in the refused result's `orders`;
  - carry `plannedOrderId` on them.
- Round-0 follow-ups stand unchanged: `LOOPMEM-FOLD`, `RECON2-DURABLE`, the live settlement rule, observability gauges, the docs/status row, and the citation refresh.

## commit_sha

`d549e997b98044604239d5b38f09ad4291edefb5` on branch `trdr-4`. Its parent is `ed6d656c586311ddcbeb09f59259b3f8e23f9fde`. Not pushed.
