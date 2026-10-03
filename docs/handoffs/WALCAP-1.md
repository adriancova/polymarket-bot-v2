# WALCAP-1: the WAL cap is relieved by expiry and never undercounts; required on the laptop profile; visible; the stall-bound flake fixed

**Status:** Complete (2026-10-03). Merged `da559ca` (PR #51; CI run `37117057986` green). It closes `STORAGE1-MAXBYTES`, except D5.1's stronger form, and `CI-FLAKE-STALL-BOUND`.
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 3 on `91149f0`.
**Base:** `8e68fcc`. The branch merged `main` at `d803299` before the PR.
**Paths:** `packages/storage-wal/**`, `apps/data-gateway/**`, `test/integration/data-gateway/**`, and the gateway example config.

## summary

1. **J10: relief after expiry, with no undercount.**
   - The WAL writer compares `maxTotalBytes` against a per-file ledger of segment files, `capacity-ledger.ts`, instead of a running sum that was never lowered.
   - The ledger is read from disk at open, and re-derived on every `tick()`.
   - Its scope is the whole WAL root (`capacityRootPath`), so every epoch counts, and a restart or crash no longer starts from 0.
   - The count drops only when a direct length read finds a counted file gone. A stale or partial listing, a deletion during rotation, a torn append or a failed read all keep the bytes.
   - Admission also counts frames already taken from the queue but not yet written (round 1's HIGH). A deferred time rotation cannot push segment bytes past the cap (round 2's HIGH).
   - ADR-028 D5.3 and D5.4 are intact: nothing deletes, and nothing triggers expiry.
2. **D5.1.** No profile marker existed. An opt-in `hostProfile: "laptop-paper"` now refuses a missing or `null` `maxTotalBytes` at startup. Configs without it are unchanged. The stronger rule, which would change other deployments, was proposed and not implemented: the packet's STOP. The example config sets 100 GB.
3. **Visibility (D5.3).**
   - A `GATEWAY_WAL_CAPACITY_REACHED` PAGE incident fires once per episode, and re-arms when relief gives bytes back.
   - New writer metrics: `capacityReached`, `capacityRescans`, `capacityRescanFailures`, `capacityRelievedBytes` and `timeRotationsDeferred`.
   - The existing `GATEWAY_WAL_FRAME_REFUSED` page and the `RecorderWalRefusals` rule are unchanged.
4. **The stall-bound flake.**
   - **The cause:** the test froze the hop at an admission, so a run cut after the freeze published at the thaw.
   - **The fix:** a proxy freezes the hop when the run carrying index 300 is handed over, and every bound is now exact.
   - **The proof:** the old test failed 14 of 50 runs under load, and the new one passed 50 of 50. A mutant that freezes at admission again fails 10 of 10.

## Rounds

| Round | Candidate | Joint verdict | Blocking findings |
|---|---|---|---|
| 1 | `3ed8268` | CHANGES REQUIRED | A-01 HIGH: drained but unrecorded frames were not counted at admission. O-M1 MEDIUM: the fail-closed open scan was unpinned |
| 2 | `801c49b` | CHANGES REQUIRED | TR HIGH: a time-driven rotation could pass the cap after a burst |
| 3 | `91149f0` | **ACCEPT** | none; LOWs open |

## tests_run

- **Gates on `91149f0`** (counts from the implementer's final run):
  - typecheck, lint and check:deps exit 0;
  - unit: 431 / 9778;
  - e2e: 9/212;
  - replay: 3/17;
  - storage-wal fault: 11/89;
  - integration: data-gateway 15/107, research-worker 6/43.
- **Mutation:** round 0 killed 25 of 25. Later rounds added pins for the HIGHs.
- **CI:** GitHub CI on the PR #51 merge ref was green before the merge: run `37117057986`.

## assumptions
- One writer per WAL root, as ADR-025 D10.3 runs one gateway per host.
- `readdir` lists every file that exists for the whole call.

## deviations
- `docs/spec/wal-format.md` does not exist. The format document is `docs/contracts/wal-format.md`, which was not granted. Its §11.1 is stale, and the orchestrator owes the dated note.

## known_risks
- **O-L2.** Re-deriving the count on every tick costs more as epoch directories pile up: about 2,000 reads and 150–215 ms per tick at 2,000 epochs. HOST-BENCH should measure it.
- **O-L3.** D5.1 is enforced only when a config declares `hostProfile: "laptop-paper"`. `HOST-1` must declare it, with a measured `maxTotalBytes`.
- **O-L4.** `docs/contracts/wal-format.md` §11.1 is stale, and §9.1 lacks the deferred time rotation.
- **O-L5.** The research worker's `walCapacity` metric and its 90% alarm model the old per-epoch writer. It can miss the cap, or alarm falsely after expiry.
- **O-L6.** A crashed, unmanifested epoch's segment permanently consumes the root-wide cap. Expiry never inventories it.
- **WALCAP-R3-01.** A rescan that fails part-way loses relief it already applied from the relief metric. The ledger is right; only the counter is wrong.
- **A second load flake.** The unchanged "TWICE its recorded pace" throughput test fails under heavy CPU load, as it did on base.
- **O-I1.** The new writer metrics are not exported, and no alert fires on rescan failures.

## follow_up
1. **The orchestrator:** a dated note in `docs/contracts/wal-format.md` §11.1 and §9.1 (O-L4).
2. **A research-worker round:** realign `walCapacity` and its alarm with the root-wide ledger (O-L5).
3. **`HOST-1`:**
   - declare `hostProfile: "laptop-paper"` and a measured `maxTotalBytes`;
   - export the new metrics and page on `capacityRescanFailures`;
   - write a runbook step for a crashed epoch's segment.
4. **`HOST-BENCH`:** measure the rescan cost (O-L2).
5. **A data-gateway test round:** the "TWICE its recorded pace" load flake.

## commit_sha
`91149f078aae2aaaf340c88f53e1d8bb74f67b6f`
