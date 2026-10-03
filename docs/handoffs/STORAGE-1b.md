# STORAGE-1b: the storage cycle lock's round-6 LOWs (STORAGE1-LOCK-LOWS)

**Status:** Complete (2026-10-01). Merged `7b6499e` (PR #40; CI run `36884261610` green).
**Reviewers:** Claude Opus and Codex gpt-6-astra, reconciled. Joint ACCEPT at round 1 on `c8b6f6d`, with no open findings.
**Base:** `7942b1d`. The branch merged `main` at `2740658` before the PR. **Paths:** `apps/research-worker/**`.

## summary

Both findings are in `apps/research-worker/src/retention/cycle-lock.ts`. Both are closed under route (a), which fails closed.

- **R6-LOCK-OPEN-ERROR-UNTESTED.**
  - Any `open()` error other than EEXIST now refuses at once, with a `StorageCycleLockError` that keeps the cause. It runs nothing and unlinks nothing.
  - A test seam, `StorageCycleLockOptions.fileSystem`, injects nine errno values: EACCES, EROFS, ENOSPC, EMFILE, ENFILE, EPERM, EIO, EDQUOT and ENOTDIR. A further test uses a real EACCES.
  - Mutant Q3 (throw → break) is killed. Before the fix, it ran the work and unlinked another holder's lock.
- **R6-LOCK-NAME-FALLBACK.**
  - `withStorageCycleLock` reads and validates the kernel boot id, a lowercase UUID, before it creates anything. A participant that cannot read it refuses. The command then exits 1 through `storage-cycle-fatal`.
  - The `storage-cycle.lock` fallback and the digest naming path are gone. Real boot ids keep their old file name.
  - A leftover legacy `storage-cycle.lock` counts as held: the cycle waits, refuses and names it. It is removed by hand.
  - **`ProcSubset=pid` is unsupported**, which is documented in the module header and the research-worker README.
- **Route (a), not (b).** Route (b) would need a lock-breaking protocol proven race-free under concurrent breakers, with no `flock` and no new dependency. Route (a) never removes a lock it does not hold.
- **ADR-028's lock semantics are unchanged:**
  - one cycle per state directory;
  - a stale lock left in the same boot is never broken automatically;
  - a reboot makes the old lock inert.

## tests_run

- **Gates on `c8b6f6d`:**
  - `typecheck`, `lint` and `check:deps` exit 0; `check:deps` covered 35 packages and 98 edges.
  - `test`: 416 files, 9322 tests.
  - `test:e2e`: 9/212.
  - `test:replay`: 3/17.
  - Research-worker `test:integration`: 6/43, with real PostgreSQL.
  - `pytest`: 155.
- **The pins fail on base:** 40 of 140 fail, and all 40 are new pins.
- **Round-6 pairings:**
  - On base, both readable-versus-unreadable pairings overlap.
  - On the candidate, the unreadable side refuses, and the holder's lock is untouched.
  - The same-boot control serializes on both.
- **End to end:** the bundled `main.mjs storage` ran with `/proc` mounted `subset=pid`.
  - Base exits 0, and writes beside a held lock.
  - The candidate exits 1 with `storage-cycle-fatal`, and writes nothing.
- **Mutation:** 19 of 19 mutants killed, including round 6's Q3. Both verifiers re-ran rows.
- **CI:** GitHub CI on the PR #40 merge ref was green before the merge: run `36884261610`.

## assumptions
- Linux does not namespace `/proc/sys/kernel/random/boot_id`. This round's probes confirmed it in private user, pid and mount namespaces.
- One host per state directory. A sandbox that presents its own boot id, such as gVisor or a VM, counts as another host.

## deviations
- The refusal applies on every platform, not "on Linux": a non-Linux carve-out would keep a fallback name.
- A boot id that is readable but is not a lowercase UUID is also refused.

## known_risks
- Two participants that read different boot ids still do not exclude each other: a gVisor sandbox or a VM sharing the state directory, or two hosts sharing it. This is by design, since it is what makes a reboot's lock inert. It is documented as unsupported.
- During an upgrade, an old-version participant on the legacy fallback name could run beside a new cycle. No deployment runs the timer yet, because `HOST-1` is pending.
- A transient failure to read the boot id, such as EMFILE, refuses that run with exit 1. The next timer run retries.
- The storage command no longer runs natively on macOS or Windows. `HOST-1` runs it on Linux (WSL2).

## follow_up
1. ADR-028 Amendment 1, rule 3, still names the two LOWs as open. A later docs round adds a dated correction recording route (a), together with ADR-029's stale header and S-GOV-R3-01.
2. **`HOST-1`:**
   - leave `ProcSubset` unset in the storage unit;
   - alert on `storage-cycle-fatal`;
   - check for a leftover `storage-cycle.lock` before the first timer start.

## commit_sha
`c8b6f6d8934704a10e1ed91df3f89e0e29b6d039`
