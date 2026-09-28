# BUNDLE-1: the trader's shipped bundle loads (H1 blocker M18)

Branch `bundle-1` on base `1ad2a36`, merged into `main` as `fd30e5f` (`--no-ff`) on 2026-09-28.

- **Authorization:** the user's ruling "H1 blockers first" (2026-09-28).
- **Process:** the HARDENING LOOP (workflow `wf_b3cf0832-acc`, run in parallel with `SNAP-1` on disjoint paths).
  - The **verifier was a Claude Fable adversarial-reviewer**, because the pin spawns processes and Codex's sandbox blocks spawning (the precedent from `CI-2` and `BRACKET-1c`).

| Commit | Content |
| --- | --- |
| `8c03d71` | r0 (accepted on its first review) |
| `fd30e5f` | the merge |

## Outcome
- **The build.** `apps/trader/package.json` `build` stays ESM, ADR-018's default, and adds esbuild's `createRequire` banner: `import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);`.
  - The forcing dependency is `ioredis`, reached through `packages/event-bus`. That is the ADR-018 §2 disclosure, recorded here because `docs/**` was outside the grant.
- **Why CJS was measured and rejected:**
  - Top-level await (`main.ts:655`) blocks a plain CJS build.
  - With the await wrapped, the migrations loader's top-level `new URL(..., import.meta.url)` (`packages/storage-postgres/src/migrations/loader.ts:33`) crashes the bundle at load.
  - With `import.meta.url` shimmed, the file-name entry guard never fires, and the process exits 0 silently.
- **The pin.** `test/unit/tooling/app-bundles-load.test.ts` (15 tests, about 0.6 s) builds each runnable app's bundle with the app's OWN `build` script and runs it. The apps are trader, data-gateway, control-api, backtest-cli and research-worker.
  - Each must reach its own refusal or usage, never a load crash.
  - For the trader, an UNSAFE environment is refused by the shipped bundle with `EXIT_CODES.unsafeEnvironment` (78) and every violation code.
  - Drift guards: `start` must run the file `build` writes, and every esbuild-built app must be covered.
  - It uses async spawn only.
- **Observed on real containers:**
  - Postgres unreachable: exit 69.
  - Postgres unmigrated: exit 69.
  - Postgres migrated but unregistered: `TRADER_REGISTRATION_MISSING`, exit 78.
  - `pnpm --filter @polymarket-bot/trader start` works end to end up to the registration check.

## Review (Claude Fable): r1 ACCEPT
- **`B1-R1-REDIS-UNCAUGHT`, MEDIUM, pre-existing and outside the grant.** With Redis unreachable, `startup()` rejects with an uncaught `EventBusUnavailableError` (stack trace, exit 1) instead of a documented refusal.
  - `RedisStreamsEventTransport.connect` (`main.ts:290`) is awaited without a catch, which contradicts `startup()`'s "Never throws" docstring.
  - It fails closed, so nothing trades. Queued with `BOOT1-R7`.
- **LOW:**
  - `B1-R1-ADR018-EVIDENCE`: ADR-018 should record the third pattern.
  - `B1-R1-MIGRATIONS-URL`: the default migrations path resolves relative to the bundle. This is latent.
  - `B1-R1-FILENAME-GUARDS`: a renamed bundle exits 0 silently. This explains the control-api observation; the shipped artefact is fine.
  - `B1-R1-COVERAGE-GUARD`: the pin recognises only a `build` that starts with `esbuild `.
  - `B1-R1-EXAMPLE-CONFIG-COUPLING`.
  - `B1-R1-VERIFYDEPS-SLIP`: one unprefixed pnpm command rewrote two shared-hardlink metadata files. The reviewer verified the observable state, and the orchestrator verified that the main checkout's `node_modules` still holds `js-yaml@4.3.1`.
- **Non-vacuity:** base's `package.json` makes the pin fail both trader cases with `Dynamic require of "events"`.

## Evidence
- **Gates (implementer and reviewer):**
  - typecheck, lint and check:deps pass;
  - unit 346 / 7544 (+1 file / +15 tests);
  - e2e 8 / 206;
  - replay 3 / 17;
  - trader integration 16 / 135 on Docker.
- **GitHub CI:** PR #13, run `36466196117`, green.

## commit_sha
- Implementation: `8c03d710ce4569d399140d9d783bac1190943177`.
- Merge: `fd30e5f`.

# Appendix A — implementer handoff, r0 (verbatim)

# BUNDLE-1 — handoff r0

## plan (written before any structural change)

Measured in scratch before planning (base `1ad2a36`, node v24.13.0, esbuild 0.28.2):

- Base ESM bundle: `Error: Dynamic require of "events" is not supported` (ioredis 6.0.0 via event-bus), exit 1. REPRODUCED.
- Option (b), ESM + `createRequire` banner: loads; empty env gives `safety: OK` and then the `TRADER_CONFIG_PATH` refusal, exit 78.
- Option (a), CJS:
  - Wrapper only (a1): esbuild warns twice on `import.meta`: `main.ts:653`, the entry guard itself, and `storage-postgres/src/migrations/loader.ts:33`. The bundle then CRASHES AT LOAD with `TypeError: Invalid URL`. `DEFAULT_MIGRATIONS_DIRECTORY` is a top-level `new URL(..., import.meta.url)`, evaluated at load although the trader never runs migrations. The warning is NOT harmless.
  - Wrapper plus an `import.meta.url` define shim (a2): exits 0 SILENTLY, because the guard `endsWith("/main.mjs")` never fires.
  - Only a3 works. It needs the wrapper, a guard edit in `main.ts` (outside the grant), a define/banner shim, and the rename `main.mjs` → `main.cjs` (compose docs change).

Plan:

1. Option (b). Change only `apps/trader/package.json` `build`: add `--banner:js=import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);`.
   - `start`, `main.ts`, the file name `dist/main.mjs` and the compose docs are unchanged.
   - Disclose the forcing dependency (ioredis) in this handoff and in the test header. `package.json` cannot carry comments.
2. Add `test/unit/tooling/app-bundles-load.test.ts`.
   - For each of the five apps, read `scripts.build` and `scripts.start` from the app's `package.json`.
   - Assert that the script is an ADR-018 esbuild bundle, with exactly one `--outfile=dist/<name>`, and that `start` runs `node ./dist/<name>`.
   - Run the build script through async `sh -c` in the app directory, with `--outfile=dist/` rewritten to a `mkdtemp` directory outside the repository, keeping the basename (the entry guards key on it).
   - Run the bundle with `process.execPath` in a controlled env: an explicit record, not inherited, with cwd set to the temp directory.
   - Assert the exact exit code, the app's own refusal or usage line, and none of the load-crash signatures.
   - Trader cases:
     - An UNSAFE environment gives `EXIT_CODES.unsafeEnvironment` plus the safety refusal line and violation codes. No `safety: OK` and no `configuration: OK` are printed.
     - A safe PAPER environment with the example config and no `REDIS_URL`/`DATABASE_URL` gives `configuration: OK`, then the documented refusal, exit 78.
   - Async spawn with a SIGKILL deadline. Builds are memoized per app, and the cases run concurrently.
3. Acceptance evidence:
   - A real throwaway Redis container (cached `redis:7.4.2-alpine`) with Postgres unreachable, run against the built bundle, should give the documented `infrastructureUnavailable` (69).
   - Report separately what happens with Redis ALSO unreachable. Measured: an uncaught `EventBusUnavailableError`, exit 1. That is a pre-existing `startup()` behaviour outside this grant.
4. Non-vacuity: restore base `package.json` temporarily; the pin must fail on the trader with `Dynamic require`; then restore byte-identically.
5. Run all gates and commit once.

---

# handoff (r0)

## summary

The trader's shipped bundle now loads and reaches its startup path. I chose option (b), measured against option (a).

**The change.** `apps/trader/package.json` `build` keeps `--format=esm` and adds one esbuild banner:

`import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);`

- esbuild's `__require` shim then finds a real `require` for the Node builtins that `ioredis` and `pg` load: events, net, tls, dns, crypto, stream, util, and so on.
- `start`, `main.ts`, the file name `dist/main.mjs` and `infra/compose/trader/**` are unchanged.

**ADR-018 §2 disclosure.**
- The forcing dependency is `ioredis`, reached through `packages/event-bus`. It is the same forcing dependency as data-gateway's CJS choice.
- The format stays ESM, the ADR-018 default. The banner is one esbuild flag inside the app-local build. It is not a runtime loader, a per-package dist build or a root pipeline, so §4 is not triggered.
- In my reading, no ADR-018 amendment is needed. Recording this third pattern (ESM + `createRequire` banner) in ADR-018's evidence is a docs follow-up.
- `package.json` cannot carry comments, so the disclosure is here and in the new test's header.

**Why not option (a), CJS.** All measured in scratch, never committed:
- **a0**, plain `--format=cjs`: `✘ Top-level await is currently not supported with the "cjs" output format` at `main.ts:655`. There are two `import.meta` warnings: `main.ts:653`, the entry guard itself, and `storage-postgres/src/migrations/loader.ts:33`.
- **a1**, the TLA wrapped in `async main()`: the build succeeds with the two warnings, then the bundle CRASHES AT LOAD with `TypeError: Invalid URL` at `new URL`. The `import.meta` warning is NOT harmless: `DEFAULT_MIGRATIONS_DIRECTORY` is a top-level `fileURLToPath(new URL("../../../../db/migrations", import.meta.url))` evaluated at module load, and in CJS `import.meta.url` is undefined. The trader never RUNS the migrations; its source never calls `readMigrations` or the migrator. The line is still evaluated at load, because `storage-postgres`'s index re-exports `migrations/`.
- **a2**, a1 plus `--define:import.meta.url` with a `pathToFileURL(__filename)` banner: exit 0 SILENTLY. The guard `import.meta.url.endsWith("/main.mjs")` never fires for `main.cjs`.
- **a3**, a2 plus the guard edited to `/main.cjs`: works (exit 78 on an empty env). It needs a `main.ts` edit beyond the TLA wrapper (outside the grant), a shim, and the `main.mjs` → `main.cjs` rename, which changes the compose docs.
- Option (b) needs one flag.

**The pin.** New file `test/unit/tooling/app-bundles-load.test.ts`, 15 tests.
- **Build.** For trader, data-gateway, control-api, backtest-cli and research-worker, it reads `scripts.build` and `scripts.start` from the app's own `package.json`. It runs the build script through async `sh -c` in the app directory, with exactly one substitution: `--outfile=dist/` becomes a `mkdtemp` directory under `os.tmpdir()`, realpath'd, shell-safe and outside the repository. The BASENAME is kept, because the entry guards key on it.
- **Run.** It runs each bundle with `process.execPath`, an explicit environment (nothing inherited), and the temp directory as cwd, so no repository `node_modules` can be resolved by accident.
- **Assertions.** The exact exit code, the app's own refusal or usage line(s), and none of these load-crash signatures: `Dynamic require of "`, `ERR_MODULE_NOT_FOUND`, `Cannot find module|package`, `ERR_REQUIRE_ESM|ASYNC_MODULE`, `ERR_UNKNOWN_FILE_EXTENSION`, `SyntaxError`, `ReferenceError`, and Node's `Node.js vN` footer after any uncaught exception.
- **Trader cases.**
  - An UNSAFE env (MAX_RUN_MODE=LIVE, RUN_MODE=LIVE, ALLOW_REAL_ORDERS=true, both live-micro caps 5, plus a valid config path and URLs, so a skipped check would get further) gives `EXIT_CODES.unsafeEnvironment` (78) and all five violation lines. Neither `safety: OK` nor `configuration: OK` may appear.
  - A safe PAPER env with the example config and no URLs gives `safety: OK`, `configuration: OK`, then the `REDIS_URL and DATABASE_URL are both required` refusal, exit `configurationRefused` (78).
- **Other apps' cases.**
  - data-gateway: exit 1 with `GATEWAY_CONFIG_PATH is required ...`.
  - control-api: `EXIT_CODES.configurationRefused` (78) with `REFUSING TO START — CONTROL_API_CONFIG names no configuration file.`
  - backtest-cli: `EXIT_USAGE` (2) with its usage lines.
  - research-worker: exit 1 with its `research-worker-fatal` `RESEARCH_WORKER_WAL_DIR` line.
- **Drift guards.**
  - Every app whose `build` starts with `esbuild` must be in the list, and ops-cli is not.
  - Each build is `esbuild src/main.ts --bundle --platform=node --target=node24` with exactly one `--outfile=dist/main.(mjs|cjs)`.
  - The format matches the extension.
  - `start` ends with `&& node ./dist/<same file>`.
- **Classifier self-test.** The signatures are checked against the real pre-BUNDLE-1 crash text, the a1 `Invalid URL` crash, and a missing module. They do not flag any expected output.
- **Runtime.** Async `spawn` with SIGKILL deadlines (build 60 s, run 30 s; test timeout 120 s, above both, per CI-1). Builds are memoized per app, and the cases run under `describe.concurrent`.
  - The file takes 608 ms inside the full unit run and 269–305 ms standalone (tests), about 2.1–2.4 s standalone wall including collection. It is far under the 30 s budget.
  - The temp directory is removed in `afterAll`; `tmpdir()` is `/tmp` here, and I checked that no `pmb-app-bundles-*` remained.

**control-api's "exit 0 silently" (verified, not a defect of the shipped artefact).** Built by its own script to `main.mjs`, control-api REFUSES an empty environment with exit 78 and `REFUSING TO START — CONTROL_API_CONFIG names no configuration file`. The silent exit 0 reproduces only when the same bundle is RENAMED (`renamed-control-api.mjs` → exit 0, no output), because its guard is `import.meta.url.endsWith("main.mjs")`. So the orchestrator's observation was almost certainly a renamed output file.
- Is exit 0 right? For a module imported or run under another name, doing nothing is the guard's intent.
- It is also a latent trap: renaming `outfile` would make `start` exit 0 having done nothing. The same class affects the trader (`/main.mjs`) and backtest-cli (`.mjs`).
- The pin therefore keeps the basename, pins `start` to the build's file, and asserts an exact exit code plus a refusal line. A silent exit fails it.

**Acceptance 1 outputs.** All from `pnpm --filter @polymarket-bot/trader build` → `apps/trader/dist/main.mjs`, run with `env -i`.

Unsafe env (`MAX_RUN_MODE=LIVE RUN_MODE=LIVE ALLOW_REAL_ORDERS=true LIVE_MICRO_MAX_ORDER_NOTIONAL=5`, plus config and URLs):
```
REFUSING TO START: the environment is not safe for a PAPER trader (§6 invariant 17, §15, ADR-010 §1). No configuration was read and no connection was attempted.
  PAPER_RUN_MODE_CEILING_RAISED: MAX_RUN_MODE=LIVE is above the repository maximum PAPER (AGENTS.md, ADR-010 §1); ...
  PAPER_RUN_MODE_NOT_PERMITTED: RUN_MODE=LIVE exceeds the process maximum PAPER (§11: ...)
  PAPER_REAL_ORDERS_ENABLED: ALLOW_REAL_ORDERS=true is not false (AGENTS.md, ADR-010 §1); ...
  PAPER_LIVE_MICRO_CAP_NONZERO: LIVE_MICRO_MAX_ORDER_NOTIONAL=5 is not 0 (AGENTS.md, ADR-010 §1); ...
exit=78   (EXIT_CODES.unsafeEnvironment)
```

Safe PAPER env (all four defaults at their safe values, example config), a REAL throwaway Redis (`redis:7.4.2-alpine` on a loopback port) and an UNREACHABLE PostgreSQL (`127.0.0.1:1`):
```
safety: OK — run mode PAPER, ceiling PAPER, real orders disabled
configuration: OK — 1 market(s), 1 instance(s), environment PAPER
health endpoint: NOT configured (TRADER_HEALTH_BIND and TRADER_HEALTH_PORT are unset); ...
REFUSING TO START: TRADER_REGISTRATION_UNREADABLE: the database could not answer whether the configured market, instance and run rows exist; ... (fail closed)
  Error: connect ECONNREFUSED 127.0.0.1:1
exit=69   (EXIT_CODES.infrastructureUnavailable), 0.175 s
```

Two further runs through the bundle, not required by acceptance 1:
- A real Redis with a reachable but UNMIGRATED `postgres:16.6-alpine` gives `TRADER_REGISTRATION_UNREADABLE ... error: relation "catalog.markets" does not exist`, exit 69. This proves pg's authenticated query path works from the bundle.
- After `db:migrate` against that throwaway DB, the result is `TRADER_REGISTRATION_MISSING: 3 row(s) ...`, exit 78.
- Both containers were removed.

The documented command `pnpm --filter @polymarket-bot/trader start` (typecheck → build → run):
- With `MAX_RUN_MODE=LIVE ALLOW_REAL_ORDERS=true`: the safety refusal, `Exit status 78`.
- With the safe four plus the example config: `configuration: OK`, then the `REDIS_URL and DATABASE_URL are both required` refusal, `Exit status 78`.

**FINDING, reported and not fixed (outside the grant): an unreachable REDIS is not a refusal.** With the safe env and BOTH Redis and PostgreSQL unreachable, the bundle prints the three OK lines, then dies with an uncaught `EventBusUnavailableError: could not connect to the event transport` (cause `Connection is closed.`), a stack trace and exit 1.
- Reproduced from SOURCE with a scratch vitest probe calling `startup()`: it REJECTS with `EventBusUnavailableError`. So this is `main.ts`'s behaviour, not the bundle's. `RedisStreamsEventTransport.connect` at main.ts:~270 is awaited without a catch.
- This contradicts `startup()`'s "Never throws" docstring and leaves the Redis boundary without a documented exit code.
- It fails closed: no trading, no connection left open.
- So "no reachable Redis or Postgres gives the documented infrastructure refusal" holds for PostgreSQL (69) but NOT for Redis (exit 1, uncaught).

## files_changed

- `apps/trader/package.json`: `build` script only (the banner). `start` unchanged.
- `test/unit/tooling/app-bundles-load.test.ts`: new.

## tests_run

All exit 0 on the final tree (commit `8c03d71`'s content). Base counts are from the packet.

| Gate | Result | Base |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0, 0 `error TS`, 33.8 s | |
| `pnpm run lint` | exit 0 | |
| `pnpm run check:deps` | exit 0, `PASS: no cycle (F9), ...` | |
| `pnpm run test` | exit 0, 346 files / 7544 tests; 68.3 s duration | 345 / 7529 |
| `pnpm run test:e2e` | exit 0, 8 / 206 | 8 / 206 |
| `pnpm run test:replay` | exit 0, 3 / 17 | 3 / 17 |
| `pnpm --filter @polymarket-bot/trader test:integration` | exit 0, 16 / 135, 12.6 s | 16 / 135 |

- **Unit delta:** +1 file / +15 tests, exactly the new `test/unit/tooling/app-bundles-load.test.ts`. There was no `Timeout calling "onTaskUpdate"` in the run.
- **Integration:** Docker server 29.1.2, containers really started. The five `*-postgres*`/`*redis*` files ran (for example `durable-two-brackets-postgres-redis.test.ts`, 3 tests, 7.0 s), with 0 skipped.
- **Tracked-file scan:** after `git add`, `no-synchronous-spawn.test.ts` (7), `lint-typed-program.test.ts` (14) and `app-bundles-load.test.ts` (15) pass: 3 files / 36 tests. The new file is in the index, so the scan covered it, and it names none of the three synchronous APIs (grep count 0).
- **Acceptance 3, non-vacuity.**
  - I wrote base's `apps/trader/package.json` (`git show 1ad2a36:...`, sha256 `a63d6bf1…c7`, equal to the pre-edit hash; `git diff` empty) and ran the pin: 15 tests, **2 failed**. Both trader cases failed with `Error: Dynamic require of "events" is not supported ... ioredis/built/Redis.js`, caught as `expected [ 'Dynamic require of "', …(1) ] to deeply equal []`. The other four apps passed.
  - I then restored the new file byte-identically (sha256 `1050c9f1…38` before and after).
- **Safety-case non-vacuity (extra).** A scratch esbuild-API build with an in-memory plugin disabled `checkPaperTraderSafety`; no repository file was touched. Under the pin's unsafe env that bundle prints `safety: OK` and `configuration: OK` and exits 1. The pin's unsafe case would fail on the exit code, the `Node.js v` footer, the missing refusal lines and the forbidden `safety: OK`.
- **Measurements:** base ESM crash reproduced; options a0/a1/a2/a3/b; the other four apps' bundles under their own name and renamed; `__require` sites per bundle (0 in control-api, backtest-cli and research-worker; the trader has builtins plus `pg-native`, inside pg's own try/catch).

## assumptions

- "Manifest-adjacent comment" cannot be literal for `package.json`, which has no comment syntax, and a `"//"` key would be outside the build/start-only grant. The disclosure is this handoff plus the new test file's header.
- The ESM + `createRequire` banner stays within ADR-018 §1/§2: an app-local esbuild invocation, ESM default. It is not a §4 departure (no runtime loader, no per-package dist, no root pipeline), so no amendment is needed. A reviewer who reads §2 as "the only remedy for a CJS-only dependency is CJS" would disagree, and that is a governance call.
- "No reachable Redis or Postgres gives its infrastructure refusal" was demonstrated for the Postgres half with a real Redis container, whose cached image needed no network. For the Redis half I report the measured behaviour (exit 1, uncaught) rather than claim a refusal.
- The pin uses `infra/compose/trader/trader.config.example.json` read-only as its valid configuration. It is already pinned valid by `test/integration/paper-trader/compose-and-example-config.test.ts`.
- `sh` exists on every machine that runs the unit suite (Linux CI and this WSL host). The build step does not run on Windows cmd.
- Exit 1 for data-gateway and research-worker is taken from their `main.ts` (`process.exitCode = 1`). Neither exports a constant; the other three apps' codes are imported from source.

## deviations

- **One procedural slip.** Once, I ran `pnpm exec tsc -p test/tsconfig.json --noEmit` WITHOUT the `pnpm_config_verify_deps_before_run=false` prefix. pnpm ran its verify-deps step, `Lockfile is up to date, resolution step is skipped / Already up to date`. Effects I measured:
  - It rewrote `node_modules/.modules.yaml` and `node_modules/.package-map.json` IN PLACE. Both are hardlinks (link count 5) shared with the main checkout and `polymarket-bot-snap-1`. Their content holds only relative paths and the global store dir, with no worktree path; the visible change is the `prunedAt` timestamp.
  - It replaced this worktree's own `.pnpm-workspace-state-v1.json`, `.pnpm/lock.yaml` and the root and app `node_modules/.bin/*` shims with new, unshared files.
  - This worktree's `.pnpm/` no longer has the ORPHAN `js-yaml@4.3.1`, which is not in `pnpm-lock.yaml`; the lockfile has only 4.3.2. The main checkout and snap-1 still have their copies. Most likely pnpm pruned it here.
  - No lockfile, manifest or package in use changed, and every gate above ran after this, green. No `pnpm install` was run.
- **Acceptance 1's infrastructure half.** The Redis-unreachable path is NOT a documented refusal (see FINDING). I did not fix it, because `main.ts` edits are allowed only as the option (a) TLA wrapper.
- Beyond the packet's example cases, the pin adds a second trader case (a safe env through the configuration door), a script-shape and start/build consistency check, an app-coverage guard, and a classifier self-test.

## known_risks

- **The banner's identifiers.** A future bundled ESM module that declares a top-level `require` would be renamed by esbuild, which reserves `require` as an unbound global. The banner's own import is aliased to `__bundleCreateRequire` to make a collision with a bundled `createRequire` import unlikely. A collision would be a load-time SyntaxError, which the pin catches.
- **Filename-keyed entry guards.** The trader (`/main.mjs`), control-api (`main.mjs`) and backtest-cli (`.mjs`) do nothing and exit 0 under any other file name. research-worker's `import.meta.url === file://${argv[1]}` goes silent for a path containing URL-escaped characters, such as a space. The pin catches a renamed outfile or a silent exit, but running the bundle by hand from such a path is still a silent no-op.
- **The pin's reach.** It proves load plus the first refusal only. Lazily-required builtins further along a run path go through the real `require` from the banner. That path was exercised by hand to the BOOT-1 registration check with real Redis and Postgres, but it is not pinned, because the unit suite has no Docker.
- **The pin's environment.** It needs `sh`, `git` is already required, and each app's `node_modules/.bin/esbuild` must exist, which is true after any `pnpm install`. The temp directory must be shell-safe and outside the repo, or the pin fails loudly with that reason. It never skips.
- **Shared exit code.** `EXIT_CODES.unsafeEnvironment` and `configurationRefused` are both 78, so an operator script cannot tell a safety refusal from a config refusal by code alone. This is pre-existing. The pin asserts the refusal text to separate them.

## follow_up

1. **Trader source, not the bundle.** `startup()` should contain `RedisStreamsEventTransport.connect` (and `transport.subscribe`) failures as a logged refusal with `EXIT_CODES.infrastructureUnavailable` (69), matching PostgreSQL's `TRADER_REGISTRATION_UNREADABLE`, instead of an uncaught `EventBusUnavailableError` and exit 1. This needs a grant on `apps/trader/src/main.ts` plus a unit or integration test. Proposed residual id: `BUNDLE1-REDISREJECT`.
2. **Governance (docs/\*\*).** Record in ADR-018's Evidence and Consequences that the trader uses ESM + a `createRequire` banner for the ioredis case. Record why CJS was rejected there: `import.meta` at load in `storage-postgres`'s migrations loader, and the filename-keyed guard. Update the M18 row to resolved-pending-review.
3. **Optional hardening round.** Make the entry guards independent of the file name (for example `import.meta.url === pathToFileURL(process.argv[1]).href`, or `realpath`-based) in trader, control-api, backtest-cli and research-worker, so a rename cannot produce a silent exit 0. That touches four apps' source and is out of this scope.
4. **Optional.** A Docker-backed integration test that runs the BUILT trader bundle against Testcontainers Redis and PostgreSQL up to the registration refusal, pinning the lazy-require runtime path the unit pin cannot reach.
5. CI: a green GitHub run is the remaining gate for this package, per the status row.

## commit_sha

`8c03d710ce4569d399140d9d783bac1190943177` on branch `bundle-1`, one commit on base `1ad2a36`. Not pushed.
