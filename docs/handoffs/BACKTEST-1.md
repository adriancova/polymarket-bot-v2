# BACKTEST-1 completion record — Static Bracket runs in replay through the shipped root

**Merged:** `b462501` (`--no-ff`, 2026-09-16). One commit `eb0b1ee` on base
`1aa2238`. Review round 1 **ACCEPT** (4 LOW, 4 INFO; none blocking). Reviewer
independent of the implementer. *Written by the orchestrator at merge: the
round's grant carried no `docs/handoffs/` path, so the eight fields existed only
in the commit body and the agent's report (the N6 class GOV-2C ratified).*

**Verdict on the blocker: B3 NARROWED, not closed.**

## What it is

GOV-2B **B3**: §7 checklist item 4's replay half did not exist — the shipped
replay root `apps/backtest-cli` declared only `polymarket-public`, `simulation`
and `storage-parquet`, and `coreLoop` was never supplied anywhere.

## What shipped

1. **`apps/backtest-cli/src/core-loop.ts` — `replayDrivenCoreLoop`.** The
   replay-side driver: for every envelope, `clock.advanceTo(record instant)` →
   `loop.ingest({envelope, identity})` → refuse-stop on `false` →
   `await loop.drain()`. That is the same `ingest`/`drain` pair the live
   `apps/trader/src/pump.ts:113-125` calls; the only granularity difference (the
   pump ingests a batch before one drain) has no decision effect because
   `CoreLoop.drain` processes one event at a time (`loop.ts:429-435`).
2. **`apps/backtest-cli/src/normalizer.ts` — `normalizedEnvelopeNormalizer`.**
   The recorded stream's door (D1–D4 stated).
3. **A committed synthetic fixture** `test/replay-golden/backtest/static-bracket/**`:
   8 frames, Parquet `cab30bd0…0cf3` (6169 bytes, re-derived by the drift-guard
   test with the pinned `hyparquet-writer`), manifest, `run-pins.json` with every
   §12.5 run-scoped pin, `trader-config.json`, and the golden artefact
   `expected-artifact.txt` (`c7e71e5e…81be`). Identities `019b1e00-…`,
   `0xbacktest1condition`, tokens `9101/9102` — found nowhere else in the tree.
4. **The proof** `test/unit/simulation/backtest-static-bracket-replay.test.ts`
   (+ `backtest-replay-support.ts`): drives the REAL `createPaperTrader`
   (books, features, runtime, Static Bracket, allocator, risk, planner,
   `SimulatedVenue` built as `main.ts:242-296` builds it, ledger, PnL) through
   the SHIPPED `runBacktest` to **RISK-2's exact numbers** — 18 decisions,
   risk 4/4/0, 3 fills, 9 ledger transactions, 12 `pnlRecords`, realized
   `-1.2`, fees `0.432` (the reviewer re-derived every fee by hand), the
   artefact's health block equal field for field to the paper-e2e golden —
   **byte-identical across two separate vitest processes**, and wired into
   `pnpm test:replay` (3 files / 17 tests; a CI step since `GATE-1`).
5. Residual 5 is observed and pinned, not hidden: the artefact carries
   `SB.UNATTRIBUTED_FILL, SB.POSITION_MISMATCH, SB.NO_BLIND_FLATTEN, SB.PAUSED`
   on the reduce's fill and `SB.PAUSED` on `onMarketClosing`; a strategy fix
   fails the test by name.

## Why NARROWED

The `backtest-cli` **executable** still cannot construct that core.
`createPaperTrader` (`apps/trader/src/trader.ts:156`) and `class CoreLoop`
(`loop.ts:278`) are the only composition in the repository, and
`docs/contracts/dependency-direction.md` §2 ("Nothing may depend on an app"),
F10 and F13 forbid `apps/backtest-cli → apps/trader`. The reviewer proved it:
adding `"@polymarket-bot/trader": "workspace:*"` gives `FAIL [F13] … same-layer
edge … is not listed in §2.1`. It also enumerated every `packages/*` and
`packages/strategies/*` manifest: none composes runtime + risk + planner +
ledger; `packages/simulation/src/ports.ts:24-36` says its shapes are "mirrored
rather than imported" for exactly this reason. So there is no third option, and
`node dist/main.mjs verify` over the fixture (exit 0, byte-identical twice)
drives no core. The work plan itself created the tension: `WP-230` assigns the
assembly to `apps/trader/**` while `WP-210` promises "the same core logic" from
`apps/backtest-cli`. Closing B3 is a governance decision (**H8**): move the
composition below layer 3, or rule a cited §2.1 exception.

## What the review established independently

- The same-root trace (task B), the fixture audit (task C, no identity
  leakage either way), determinism under five perturbations (task D: golden
  byte, fee rate, frame size, a flipped Parquet byte → 6/8
  `REPLAY_OBJECT_CHECKSUM_MISMATCH`, shipped source reverted → 6/8), the
  residual-5 pin (task E), the BOOT-1 merge hazard (task G: changed-file lists
  disjoint; expect the golden unchanged).
- **`MarketOpened`/`MarketClosing` have NO producer anywhere in the repository**
  (task F, verified true by grep over `apps/*/src`, `packages/*/src`,
  `packages/strategies/*/src` excluding tests and the domain contract: every hit
  a consumer or a comment; the gateway's feed emits only
  `MARKET_DATA_EVENT_TYPES`, which lacks both; `loop.ts:576-600` has no case for
  `MarketDiscovered`; `pipeline.ts:337-347` maps `PENDING → UNKNOWN` and §9.8
  fails closed on it). Consequence: a live-data paper run today never leaves
  `PENDING` and every entry is refused. Recorded as closeout blocker **B10**;
  H1 is not attemptable until it closes.

## Gates

At tip `eb0b1ee` (reviewer's runs) and post-merge on `main` `b462501`
(orchestrator's runs): `pnpm run test` **328 files / 7153 tests**; `check:deps`
PASS 34 packages / **80 edges** (+2 downward: `apps/backtest-cli` L3 →
`packages/domain` L0, → `packages/risk` L1 via the exported `./schema-arena`);
typecheck 0; lint 0; `test:replay` 3/17; `test:e2e` 6/78. Scope:
`apps/backtest-cli/**` (9 files), `test/unit/simulation/**` (2),
`test/replay-golden/backtest/static-bracket/**` (7), root `package.json` (the
`test:replay` line only — ratified at merge, deviation **N11**),
`pnpm-lock.yaml` (6 added lines, the `apps/backtest-cli` importer block only).
No `packages/**`, no `apps/trader/**`. Paper-only controls at the floor.

## Residuals (owned)

- **BT1-R1 [LOW]** `apps/backtest-cli/README.md` ("The shared core in replay",
  last paragraph): "the executable's `verify` command still runs the
  verification-only normalizer with no core" — "no core" true, "verification-only
  normalizer" stale since `main.ts:44-58` selects `normalizedEnvelopeNormalizer`
  when the pins name it.
- **BT1-R2 [LOW]** run pins are not reconciled against the core's own config
  (`manifest.ts:825-841` reconciles dataset ↔ pins only); `fillModelVersion`,
  `feeSnapshotVersion`, `runSeed` in `run-pins.json` vs `trader-config.json` —
  the golden freezes both sides today. Three equality assertions in
  `backtest-replay-support.ts` now; a reconciliation in `runBacktest` when the
  composition moves.
- **BT1-R3 [LOW]** post-halt behaviour diverges from the pump and is unpinned:
  `core-loop.ts:139-178` keeps delivering after a latched halt where
  `pump.ts:125-127` returns `HALTED`; fills for resting orders can still book.
  No halt test exists (`halts=[]` in the fixture). Pin it or mirror the pump.
- **BT1-R4 [LOW]** `normalizer.ts` neither reports a schema-boundary §4 item 5
  pollution battery nor says one was not run. The reviewer ran one (8 inherited
  keys on `Object.prototype`; permission never varied): the door is sound, the
  statement is incomplete.
- **BT1-R5 [INFO]** `run_mode=BACKTEST` names the ROOT; the core it drives is
  hard-wired PAPER (`safety.ts:70`, `loop.ts:1054`, `allocation.ts:675`). The
  closeout should say "the PAPER core driven by recorded events under the
  BACKTEST root".
- **BT1-R6 [INFO]** two replay clocks (source `event-source.ts:1117` from the
  first record; core from the manifest's first `receivedAt`); both advanced per
  event; no artefact byte depends on the pre-first-event value.
- **GATE1-M1** stands: the new file's presence in `test:replay` is asserted
  nowhere mechanically.
- Not exercised by the fixture: tier-1 bands, incidents, duplicates, a halted
  replay; the take-profit never fills (`RISK2-R6`).

## Handoff fields

- `summary`: above.
- `files_changed`: 20 files (listed under Gates).
- `tests_run`: as under Gates; one first-run vitest worker RPC timeout under
  host load, clean on re-run (BT1-R8).
- `assumptions`: `idNamespace` fixed rather than derived from run ids (a seed
  choice, disclosed in the support header); the core config's fee/fill values
  equal the run pins (BT1-R2).
- `deviations`: the root `package.json` line (N11, ratified); no handoff file
  (this record).
- `known_risks`: BT1-R3; B10.
- `follow_up`: BT1-R1..R4; H8.
- `commit_sha`: `eb0b1ee`; merge `b462501`.
