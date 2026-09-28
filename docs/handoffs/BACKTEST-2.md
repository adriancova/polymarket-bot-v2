# BACKTEST-2 — the backtest executable builds the shared trading core (H8 track, round 4; closes B3)

- **Package:** `BACKTEST-2`, authorized 2026-09-28 (`IMPLEMENTATION_STATUS.md`,
  row `BACKTEST-2`) under the user's H8 ruling; design basis: the H8 scoping
  `wf_5375df07-cc2` ("Synthesis: backtest_2"); ADR-022 D5, D6, D7.
- **Base:** `f8aedec` (`main`, with `CORE-MOVE` merged). **Branch:** `backtest-2`.
  **Date:** 2026-09-28. **Exclusive window** on this round's paths.
- **Review:** an independent Codex review (the hardening loop) gates the merge;
  a green GitHub Actions run is the orchestrator's step. The implementer did not
  review its own work. **This round is not marked complete here**, and B3 is
  recorded CLOSED by the orchestrator at merge, not by this record.
- **Safety:** `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false` and both
  live-micro caps at `0` are untouched. The core's PAPER constants
  (`packages/trading-core/src/safety.ts`, `config.ts`) are byte-identical to
  the base. No wallet, signer, credential, network call or real order anywhere;
  every artifact is SIMULATED (`SIMULATED_NOT_REAL_EVIDENCE` on every fill).
  No `eslint-disable`, `.skip`, `.only` or `ts-ignore` was added.

## What shipped

1. **The CLI builds the core.** `apps/backtest-cli` declares
   `@polymarket-bot/trading-core` (layer 3 → layer 1, downward, no §2.1 row).
   New `src/assembly.ts`: `assembleBacktestCore` / `runBacktestCore` —
   startup safety FIRST (this root's `checkBacktestSafety` AND the core's
   `checkPaperTraderSafety`, on the real environment record, before any file
   is opened), the core's config door, the BT1-R2 pin reconciliation, a
   `ReplayClock` at the manifest's first recorded instant, the core's venue
   builder, the core's PRODUCTION `InMemoryTraderStore`, `createPaperTrader`,
   and `replayDrivenCoreLoop` bound to the core's clock and halt latch; driven
   through the shipped `runBacktest`. New `run` command in `src/main.ts`
   (`run --dataset --pins --config --artifact [--id-namespace]`) that takes no
   core from its caller and writes the artifact (`src/artifact.ts`, the
   replay suite's renderer moved byte for byte) with `wx` (never overwrites).
   It prints `core_run_mode=PAPER` and `evidence=SIMULATED_NOT_REAL_EVIDENCE`
   beside the report's `run_mode=BACKTEST` (BT1-R5 recorded, not changed).
   `runBacktest` gains one optional input, `dataset` (a manifest the caller
   already read from the same directory), so the manifest is read once.
2. **One venue builder**, `packages/trading-core/src/venue-builder.ts`
   (`buildSimulatedVenue`), built on the unchanged `venue-policy.ts`.
   `apps/trader/src/main.ts`, the e2e harness, the paper-trader fixture and the
   backtest assembly all call it; `apps/trader/src/index.ts` re-exports it for
   the harnesses (no suite alias, no tsconfig edit). The production store is
   `packages/trading-core/src/memory-store.ts` (`InMemoryTraderStore`), which
   imports `pnl-snapshot-key.ts` (shared, not copied) and nothing from
   `testing/`.
3. **The replay suite drives the CLI.** `test/unit/simulation/backtest-replay-support.ts`
   assembles nothing: `replayThroughShippedRoot({ withCore: true })` is the
   CLI's `runBacktestCore`, `assembleSharedCore` is the CLI's
   `assembleBacktestCore`, and `renderArtifact` is the CLI's renderer. The
   golden is byte-identical. The argv test is
   `apps/backtest-cli/src/run-command.test.ts` (root unit suite, CI-gated), so
   `test:replay` stays 3 files / 17 tests and the root `package.json` is
   untouched.
4. **BT1-R1..R4** — see below.
5. **Comment corrections** (proved comment-only below): the core's `ports.ts`
   ("consumed only from layer 3"), `packages/simulation/src/ports.ts` (the
   composition-root sentence), `apps/backtest-cli/src/core-loop.ts` (the
   structural-core section), plus `apps/trader/package.json`'s description.
6. **The contract:** one dated §6 graph note in
   `docs/contracts/dependency-direction.md` with the measured count.

## The venue copies, parameter by parameter

The base had four constructions: `apps/trader/src/main.ts:422`,
`test/e2e/support/harness.ts:142`, `test/integration/paper-trader/support/fixture.ts:671`,
`test/unit/simulation/backtest-replay-support.ts:264`.

| Venue input | `main.ts` (base) | Differed in | Now |
| --- | --- | --- | --- |
| `runMode` | `"PAPER"` | none | fixed: `TRADER_RUN_MODE` (`"PAPER"`) |
| `model` | Tier 0 over the PARSED config's `simulation.fillModelVersion` / `…ParametersHash` | e2e + replay copy: the RAW document with fallbacks; fixture: literals `tier0/fixture`, `a`×64 | builder parameter `settings`; each caller states its source (main.ts and the CLI: the parsed config; e2e: its defensive reads; fixture: its literals) |
| `feeSnapshot` | the fee door over the parsed config's fields; refusal → exit 78 | e2e: the document's schedule or the scenario's fallback; fixture: its own `feeSnapshot()`; replay copy: the raw document | `settings.feeSchedule`, validated by the builder's door (field-by-field, as main.ts did); e2e keeps its fallback choice and passes the validated snapshot |
| `startingCash` | parsed config | e2e + replay copy: raw with fallback `"0"`; fixture: `simulationStartingCash(document)` | `settings.startingCash` |
| `rateLimits` | `unmodeledRateLimits(<main.ts text>)` | fixture: an optional `options.rateLimits` override (a token bucket for a REAL refusal test); all three copies: different disclosure TEXTS | builder parameter `rateLimits` (the fixture passes its override through); default `unmodeledRateLimits(UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE)` = main.ts's text. **The copies' own disclosure texts are dropped** — see Deviations |
| `policy` | `createExecutionPolicy(wiring, log)` | the copies restated it inline, with the same throw text and NO log | builder parameter `log` (absent: no line; the throw and its containment are unchanged) |
| `books` | live lookup through the holder's trader | fixture: a map pre-bound after `createPaperTrader` (`bindBooks`) | fixed: main.ts's live lookup. The fixture's map was a projection of the same `trader.markets` states with the same token ids, bound before any event; its removal is reported, not parametrized (a caller-supplied book provider is the second authority the seam forbids) |
| `retention` | venue default | e2e: optional `venueRetention` | builder parameter `retention` |
| `clock` | the process clock | each caller's | builder parameter `clock` |

## The census

`git grep --untracked -n "new SimulatedVenue(" -- apps packages test ':!*.test.ts' ':!packages/simulation'`
at the candidate answers ONE construction, `packages/trading-core/src/venue-builder.ts:176`
(and `:18`, a comment). At the base the same command answered the four copies
above. Every other hit is a unit test that builds a venue on purpose:
`apps/trader/src/main.test.ts:45` (drives the policy's containment through a
venue it controls), `apps/trader/src/loop-folds.test.ts:406`, and the core's
`loop-long-run.test.ts:377`, `loop-order-lifecycle.test.ts:638/644`,
`loop-refused-plan.test.ts:665/671`, `order-provenance.test.ts:354` (a bare
`CoreLoop`, Tier-1 models, injected books or budgets — not a `PaperTrader`, so
not the builder's shape), and `packages/simulation`'s own tests under
`test/unit/simulation/` (`doors`, `golden-replay`, `venue-and-clock`,
`venue-sim1`, `venue-sim2`). ADR-022 :237 carries the phrase in prose.

## BT1-R1..R4

- **R1** — `apps/backtest-cli/README.md`: the sentence is corrected in place,
  quoting the superseded text.
- **R2** — `reconcileRunPinsWithCoreConfig` (`assembly.ts`) refuses
  `BACKTEST_PINS_DISAGREE_WITH_CONFIG` before a core is built, naming each
  field: `fillModelVersion`, `fillModelParametersHash` (added: it is the fourth
  pin the configuration also states), `feeSnapshotVersion`, and every
  instance's `runSeed`. Tests: `assembly.test.ts` (each pin mutated; the
  configuration side mutated), `run-command.test.ts` (argv, no artifact).
- **R3** — DECIDED: mirror `pump.ts`. Given the core's halt latch,
  `replayDrivenCoreLoop` refuses to ingest into a core already halted
  (`pump.ts:84-86`) and stops after the drain that latched one (`:127-130`),
  as a `SIMULATION_INTERNAL` refusal naming every halt `CODE@SCOPE`, the
  point (`BEFORE_INGEST` / `AFTER_DRAIN`) and the event. `run` exits `75` (the
  trader's `halted`). The latch option is OPTIONAL, because
  `test/integration/paper-trader/fold-held-equals-rebuilt.test.ts` (outside
  this grant) builds a driver without one; a caller that hands none keeps
  `BACKTEST-1`'s behaviour, and the shipped assembly always hands
  `trader.halts`. Tests: three double-driven in `core-loop.test.ts`, two on the
  REAL core in `assembly.test.ts` (a pre-latched `OPERATOR_HALT` stops at event
  1 with nothing ingested; the production store closed under the core latches
  `STORE_UNAVAILABLE` mid-run and the replay stops after that drain, while the
  same core driven without the latch delivers all 8), and one through argv in
  `run-command.test.ts` (a dataset whose fourth frame names a token the market
  does not have: the core latches `BOOK_DESYNCHRONIZED@MARKET`, the replay
  stops `AFTER_DRAIN` at `ingestSeq=4`, `run` exits 75 and writes no
  artifact). The golden is unchanged (its run has no halt).
- **R4** — a battery WAS run and is pinned
  (`apps/backtest-cli/src/normalizer-battery.test.ts`): 33 inherited keys × 2
  variants × 15 frames. Its first run against the base normalizer recorded 94
  deviations in three classes: an inherited `venueTimestamp` ADOPTED into
  every envelope (D3), zod's refusal construction THROWING under `value` /
  `writable` / `_zod` / `get` / `set`, and `packages/simulation`'s strict-JSON
  parser throwing from `Array.push` (`strict-json.ts:328`) under a get-only
  numeric name. `normalizer.ts` now reads `venueTimestamp` as an own key and
  contains every throw into a refusal; the pinned bound is: no throw escapes,
  permission never widens, accepted envelopes byte-identical, and exactly
  `"0"`/`"1"` (get-only) fail closed. The door's conformance statement says so.

## Evidence (run by the implementer)

- **Goldens:** `git diff --exit-code f8aedec -- test/replay-golden` empty after
  each of two `test:e2e` + `test:replay` rounds.
- **Operator path:** `pnpm --filter @polymarket-bot/backtest-cli build`, then
  `node apps/backtest-cli/dist/main.mjs run --dataset <fixture> --pins
  <fixture>/run-pins.json --config <fixture>/trader-config.json --artifact <f>
  --id-namespace backtest-1-static-bracket-replay`, twice under `env -i`: exit
  0 both times, sha256 of both artifacts
  `0da3c56f63798414451fa8a5e2c1526ed91725874bc5284f8029a801ea19fb3e` =
  `expected-artifact.txt`. Also exit 0 and the same hash with the ambient
  environment and through `pnpm --filter @polymarket-bot/backtest-cli start run …`.
  The bundle contains no `ioredis` and needs no `createRequire` banner. Under
  `POLY_API_KEY=…` it refuses (exit 3) before reading a file.
- **check:deps:** PASS, 35 packages / 90 edges (base 35 / 89); the `--json`
  edge diff is exactly `+ apps/backtest-cli → packages/trading-core`
  (`dependencies`, layer 3 → 1); allowlist S0..S18.
- **Comment-only:** TypeScript printer with `removeComments` (types kept) and
  `transpileModule`: the two `ports.ts` files are EQUAL to the base; the
  stripped diff of `core-loop.ts` is exactly the R3 code; the two `index.ts`
  files differ only by their added export blocks.
- **Lockfile:** one hunk, `@@ -49,0 +50,3 @@ importers:`, the
  `apps/backtest-cli` block; `packages:` and `snapshots:` untouched.

## Residuals

- The ADR-022 discharge note (queued by the orchestrator; `docs/adr/**` is
  outside this grant).
- `test/replay-golden/backtest/static-bracket/README.md` still names the
  support file and `MemoryTraderStore` as the assembly (read-only path).
- `packages/trading-core/src/pnl-snapshot-key.ts`'s header says the key is
  "read by two parties"; there are now three (the production store). Not in
  this grant's additive list.
- `packages/simulation/src/strict-json.ts:328` throws a bare `TypeError`
  under an inherited get-only numeric name (the §2 numeric-name family); the
  normalizer contains it, the parser does not (WP-210's owner).
- The core's loop-level unit tests restate `main.ts`'s policy and book wiring
  over a bare `CoreLoop`; a later round could give the builder a loop-holder
  form.
- `run` refuses `RUN_MODE=BACKTEST` (the core's own check; ADR-022 D6) and
  refuses to render when the core's bounded logs evicted anything (no CLI
  option raises them).
