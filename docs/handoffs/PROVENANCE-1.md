# PROVENANCE-1: decision provenance, durable halts and refusals; raw WAL expiry where a trader runs

**Status:** Complete (2026-10-03). Merged `71d8b80` (PR #49; CI run `37106559835` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 2 on `d05a854`.
**Base:** `c5157c3`. The branch merged `main` at `6fb6412` before the PR. **Posture:** PAPER only.
**It closes:**
- `H1R1-PROVENANCE`;
- `OUT1-R1-HALT-NOT-DURABLE`;
- `OUT2-R1-HALT-RECORD-INTERACTION`;
- the trader half of `BURN-IN`'s raw-expiry criterion. ADR-028 Amendment 1 rule 6's two trader limits are now lifted.

## summary

1. **Decision provenance.** Every decision an event triggered carries that envelope's own `eventId`, `gatewayEpoch` and `ingestSeq` (`dispatchPositionOf`).
   - Frame-coalesced evaluations carry the position of the frame event that owed them.
   - Loop-originated decisions (`onFill`, `onOrderUpdate`) carry none.
   - `feature_snapshot_id` stays NULL on purpose. It is a foreign key into `data.feature_snapshot_index`, which nothing writes. The decision's `feature_snapshot_ref` content address stays its name.
   - Two goldens move from format 3 to 4: `paper-e2e-run.json` and `two-brackets-run.json`. Only the new keys and the version changed, which was checked mechanically.
2. **Durable halts.** `startup()` writes every latched halt to `ops.incidents` after the pump stops and before anything closes.
   - Each is a `TRADER_HALT:<scope>` row: failure class, §9.9 action, PAGE, OPEN, and the halt's own instant. A GLOBAL halt writes one row per configured instance.
   - The write is bounded to 5 s, server-side and by a client deadline, and it never changes exit code 75.
   - If PostgreSQL itself failed, the trader logs `HALT RECORD NOT DURABLE`, or `HALT RECORD UNCONFIRMED` at the bound.
   - The outage scenarios expect exactly one halt row.
   - An idle pooled connection that the server ended used to crash the trader (exit 1). It now latches `GLOBAL STORE_UNAVAILABLE` and exits 75.
3. **Durable refusals.** Each refused intent becomes `ops.risk_events` rows, one per code, in the shape `postgresTraderEvidence` reads. The rows go in the event's own group-commit staging. One gate, `#takeRiskRefusals`, writes nothing after a store failure.
4. **Retention safety (round 1's HIGH, PROV1-R1-01).** Provenance must not move the retention frontier past an event before that event's effects are durable. A frontier inside an ended epoch no longer classifies a window (`wal-index.ts`).
5. **End to end,** through `startup()` and `storageMain()` on real PostgreSQL, with a throwaway WAL written by the real writer:
   - decisions carry positions, and `dispatchFrontiers` returns the epoch;
   - the window classifies after its grace;
   - in an execute cycle, unpinned segments over 72 h expire;
   - segments under a fill pin (kept forever), a refusal pin (30 days) or a halt pin (30 days) are kept.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `c342843` | CHANGES REQUIRED | PROV1-R1-01 HIGH: the frontier could pass an event before its effects were durable. F1 = PROV1-R1-02 MEDIUM: a frozen PostgreSQL hung the exit in `store.close()`. Two LOWs |
| 2 | `d05a854` | **ACCEPT** | none; 3 LOW open, plus F3 carried |

## tests_run

- **Gates on `d05a854`:**
  - typecheck, lint and check:deps exit 0;
  - unit: 428 / 9659;
  - e2e: 9/212;
  - replay: 3/17;
  - integration: trader 35/260, data-gateway 14/104, event-bus 10/112, research-worker 6/43;
  - pytest: 155.
- **The new tests fail on base.**
- **Mutation:** 20 mutants; 19 killed, 1 equivalent.
- **The stall-bound flake** hit both verifiers' first data-gateway run. The reruns were green, and `WALCAP-1` owns the fix.
- **CI:** GitHub CI on the PR #49 merge ref was green before the merge: run `37106559835`.

## assumptions
- A halt whose record cannot land is not window evidence (see F3).

## deviations
- Beyond the deliverables, an idle connection ended by the server now halts the trader rather than crashing it.

## known_risks
- **PROV1-UNRECORDED-HALT (F3, LOW).** When PostgreSQL itself failed, the halt's record may not land, so the 30-day halt pin can silently become no pin. HOST-1 pages on the `HALT RECORD NOT DURABLE`, `HALT RECORD UNCONFIRMED` and `STORE CONNECTION LOST` lines; BURN-IN owns the operator-pin procedure.
- **PROV1-R2-L1 (LOW).** A window that overlaps a gateway epoch's end stays unclassified for good when the gateway and the trader restart together. It fails closed: about one window's raw is kept.
- **PROV1-R2-L2 (LOW).** On a frozen PostgreSQL, `startup()` returns 75 within its bound, but half-closed idle sockets may keep the process alive.
- **PROV1-R2-L3 (LOW).** The bound's log line overstates what it covers for a connection that is still opening.
- **Refusal volume.** One row per code per refused intent; a strategy that re-emits a refused entry writes at the decision rate.
- **Socket drops.** A trading write whose socket the server drops mid-query is still an uncaught pg error (exit 1). This exists on base for every Kysely write.
- **`H1R1-HALT-INVISIBLE` stays open.** Halt rows now outlive a fast exit, but nothing reads them yet.

## follow_up
1. **The control API** (`CADENCE-1` owns `apps/control-api` next) reads open `TRADER_HALT:*` rows into health and metrics. That closes `H1R1-HALT-INVISIBLE`.
2. **`HOST-1` and `BURN-IN`:**
   - page on the three log lines above;
   - treat exit 75 with an open `TRADER_HALT` row as page-class;
   - after a NOT DURABLE record, an operator pins the window.
3. **ADR-028 Amendment 1, rule 6:** add a dated correction that `PROVENANCE-1` lifted both trader limits.

## commit_sha
`d05a8540004dac437f5815aec5ba8f6f312f7686`
