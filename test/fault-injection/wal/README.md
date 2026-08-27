# WAL fault-injection suite (`WP-050`)

Covers the handoff §16.6 scenarios that belong to the write-ahead log: a process
killed mid-append, a corrupted record, a failing `fsync`, a host power loss, a
full disk, an exceeded WAL capacity threshold, plus the `WP-050` acceptance
criteria that are only meaningful under failure (crash recovery truncates **only**
an incomplete final record; full segments validate by record count and SHA-256;
queue overflow is observable and never silently drops frames).

## Running it

```bash
pnpm --filter @polymarket-bot/storage-wal test:fault
```

The root runner (`test/vitest.config.ts`) does not execute
`test/fault-injection/**` and is a `WP-010`-owned protected path, so this tree
carries its own `vitest.config.ts` and is invoked by a package-level script,
under the 2026-08-26 workplan test-tree registration ratification. Types are
checked by the same package's `typecheck` script through `tsconfig.json` here.

`vitest.config.ts` aliases `@polymarket-bot/storage-wal` (and its `./testing`
subpath) to the package source, because this tree is not a workspace package and
cannot resolve the dependency through `node_modules` without editing the
protected root manifest.

## Repository caveat: this directory is matched by `.gitignore`

`.gitignore` line 26 is `wal/`, a **runtime data** rule (alongside `data/`,
`parquet/`, `tmp/`). It also matches this test directory, so every file here had
to be added with `git add -f`.

Consequences until the rule is narrowed (`.gitignore` is outside `WP-050`'s
allowed paths, so `WP-050` did not edit it — see `docs/handoffs/WP-050.md`,
`deviations`):

- Tracked files behave normally: they are diffed, committed, and reported by
  `git status`.
- **A newly created file in this directory will be silently ignored.** Add it
  with `git add -f`, or the orchestrator narrows the rule first — for example by
  anchoring it as `/wal/` or adding `!/test/fault-injection/wal/`.

## Layout

| File | Scenario |
| --- | --- |
| `torn-write-recovery.test.ts` | kill mid-append; truncate only the partial record; recovery idempotence |
| `corrupt-record.test.ts` | corrupt final and non-final records; recorder keeps running |
| `checksum-validation.test.ts` | count + SHA-256 validation, and the mutations it must catch |
| `rotation.test.ts` | rotation by size and by time, with no lost or duplicated frame |
| `fsync-policy.test.ts` | periodic fsync, the published data-loss bound, a failing fsync |
| `queue-overflow.test.ts` | bounded queue refusals, metrics, and no silent drops |
| `verbatim-frames.test.ts` | `PING`/`PONG` and adversarial payloads round-trip byte for byte |
| `wal-capacity.test.ts` | configured capacity threshold and a genuinely full disk |
| `support/` | the filesystem fault shim and the shared harness (not tests) |
