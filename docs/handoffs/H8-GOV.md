# H8-GOV — the H8 track, round 1: ADR-022, the staged dependency-contract amendment, and the work-plan ratification

- **Package:** `H8-GOV`, an orchestrator-authorized governance round in the
  bounded-repair shape of `docs/contracts/protected-contracts.md` §3.1, like
  `GOV-1B`, `GOV-1C` and `GOV-1D` (authorized in `IMPLEMENTATION_STATUS.md`,
  2026-09-28).
- **Base:** `a8a3a63` (`main`). **Branch:** `h8-gov`. **Date:** 2026-09-28.
- **Ruling recorded:** the user's **H8** ruling of 2026-09-28:
  - option A, with the package named `@polymarket-bot/trading-core`;
  - ADR-022 is written;
  - a strategy-agnostic core ("D4") waits for a second strategy;
  - `FOLD-2` runs after `BACKTEST-2`;
  - the order is the H1 blockers, `H8-GOV`, the optional checker hardening,
    `CORE-MOVE`, then `BACKTEST-2`.
- **Review:** an independent review (Codex, the hardening loop) gates the
  merge. The implementer did not review its own work. **This round is not
  marked complete.** Round 1 reviewed `81d1b34` and returned CHANGES
  REQUIRED, with three wording findings. They are fixed on top of that
  commit; see "Review round 1".
- **Documentation only.** No path under `packages/**`, `apps/**`, `test/**`,
  `tools/**` or `db/**` was touched, and neither was the lockfile, any
  `package.json`, any `tsconfig*`, `eslint.config.mjs`, `.github/**`, the
  handoff spec, any other ADR, any frozen handoff record, or
  `IMPLEMENTATION_STATUS.md`. **Nothing the dependency check parses changed.**

---

## Why this round exists

Blocker B3, the replay half of §7 item 4, was narrowed by `BACKTEST-1` and
not closed. The backtest executable cannot build the paper core, because
`createPaperTrader` and `CoreLoop` live in `apps/trader` and
`dependency-direction.md` §2 says "Nothing may depend on an app" (F10, F13).
The user ruled option A: move the core into a new layer-1 package that both
composition roots build.

The move is `CORE-MOVE`'s job. Making the backtest executable build the core
is `BACKTEST-2`'s. This round **records** the ruling and **stages** the
contract text those rounds activate.

The staging is forced. The check fails closed on a §2 entry without a manifest
(`F-CLOSED`) and on a §2.1 row naming an unclassified endpoint (`CHK`). §6.1
item 5 puts the pinned allowlist in `test/**`, which is outside a governance
round. This is the `GOV-2A` → `WP-180-FU2` precedent.

## What the round records

1. **ADR-022**,
   `docs/adr/ADR-022-shared-trading-core-is-a-layer-1-package.md`, status
   Accepted, "Implemented by: CORE-MOVE (pending), BACKTEST-2 (pending)". It
   carries:
   - Context: the handoff's single core; the work plan's two-way pull; the
     F10/F13 proof; the measured closure; the interim state.
   - Decisions D1-D10.
   - The argued §4.1/§5 reading (D2): §4.1 lists deployable
     processes, not code locations.
   - The PAPER ceiling kept under ADR-010's human gate (D6).
   - The D4 sunset on row S18 (D9).
   - Consequences, including costs and the rejected alternatives: B, C, a
     new layer, and a copied composition.
   - Evidence measured at `a8a3a63`.

   Its row is added to the `docs/adr/README.md` index. `git grep ADR-022` at
   the base found the number only in `IMPLEMENTATION_STATUS.md`'s planning
   rows, so it was unused.
2. **`docs/contracts/dependency-direction.md`**:
   - **(a) A staged `#### PENDING` subsection in §2.1**, placed after row S7
     and before `#### DONE 2026-09-04`, in the GOV-2A form. It holds:
     - the §2 Layer 1 fence line;
     - the §2 paragraph;
     - rows S8-S18, one per target, with no leading pipe;
     - the two S15 sentences for activation;
     - the `CORE-MOVE` grant, quoted verbatim.

     The staged material sits in ```` ```text ```` fences, and **no line of
     the subsection begins with `|`**.
   - **(b) Two settlements that are true today**, discharging `WP-210`
     `follow_up` 6:
     - The §2.1 list of cases "that will need" a row loses its
       `ExecutionVenue` bullet. A dated settled note replaces it and quotes
       the replaced text.
     - §4's execution-venue sentence now says where the interfaces were
       declared. `WP-210` declared `Clock`, `MarketEventSource` and
       `ExecutionVenue` in `packages/simulation`
       (`packages/simulation/src/clock.ts:48`, `src/ports.ts:89`, `:522`), and
       the only manifests declaring `@polymarket-bot/simulation` are
       `apps/trader` and `apps/backtest-cli`, both layer 3. So no same-layer
       edge ever existed.
3. **`docs/contracts/protected-contracts.md` §5**: one precedent row for this
   round. Also, the blank line that had detached `GOV-1D`'s 2026-09-03 row from
   the table is removed. A blank line ends a GFM table, so that row rendered as
   a stray paragraph.
4. **`docs/spec/polymarket-bot-workplan.yaml`**: dated comments and list items
   only (49 insertions, 0 deletions). The parsed data differs from base in
   exactly five lists:
   - `WP-230` `allowed_paths` gains `packages/trading-core/**`, under a dated
     ratification that also extends its lockfile entry to the new importer
     block;
   - `WP-260`, `WP-270`, `WP-300` and `WP-330` `forbidden_paths` gain it.

   Dated notes are added on `WP-210`, `WP-320` and `WP-350`. No goal,
   deliverable or acceptance text changed.
5. **This record**, which quotes both grants verbatim.

## Re-verified at `a8a3a63`: what changed since the scoping (`60a5d7e`)

The scoping ran before `SNAP-1`. Every figure it carried was re-measured, and
these moved:

| Item | Scoping (`60a5d7e`) | This round (`a8a3a63`) | Where it lands |
| --- | --- | --- | --- |
| Closure size | 24 files, 10,879 lines | **25 files, 11,218 lines**; `SNAP-1` added `apps/trader/src/pnl-snapshot-key.ts` | ADR-022 Context 4; the §2 paragraph |
| `packages/pnl` surface | the fold only | plus `toPnlSnapshotRow` (from `pnl-snapshot-key.ts`) and the `PnlStreamIdentity` type | row S13 |
| A test importing moving modules by relative path | not present | `test/unit/trader/memory-store-pnl-snapshot-key.test.ts` :55 `pnl-snapshot-key.js`, :56 `ports.js`, :63 `time.js` | **added to the `CORE-MOVE` grant** |
| `health-realized-pnl.test.ts` path string | :187 | **:214** | the `CORE-MOVE` grant |
| A staying file importing a closure name the trader's `index.ts` does not export | none | `apps/trader/src/adapters/postgres-store.ts:89` imports `unreplacedPnlSnapshotProblem` from `../pnl-snapshot-key.js` | the `CORE-MOVE` grant (the core's `index.ts` must export it) |
| The venue-policy block's `simulation` surface | not stated | the `PlannedOrderView` type (`main.ts:101-109`, used only in :155-217) | row S15 |
| Where the fence line goes | "after :88" | after the class-entry line **:87**; :88 is the closing fence | the PENDING subsection's step 1 |

Unchanged at `a8a3a63`:
- **Dependencies:** the same 13 workspace packages plus `zod`; no `node:`
  import.
- **Clock and globals:** no clock read and no process global. An AST census
  finds only `time.ts:68`, `new Date(epochMs)`, which converts a supplied
  instant.
- **Moving tests:** 14 colocated tests move. `loop-folds.test.ts` and
  `main.test.ts` stay. Every closure name `loop-folds.test.ts` imports is
  exported by `apps/trader/src/index.ts`.
- **`main.ts`:** unchanged since `60a5d7e`, so the :155-217 cut still holds.
- **Tooling-test anchors:** :224-230, :442-458, :658 and :1017-1030.

## The grants, verbatim

### The `CORE-MOVE` grant

This text is also quoted, byte for byte, at the end of
`dependency-direction.md` §2.1's PENDING subsection. It is the scoping's grant
(synthesis item I), corrected for the `SNAP-1` deltas above and for four
further points:
- the two test re-points (`./main.js` → `./venue-policy.js`) are named;
- the `main.ts` cut may drop the import names only the block used;
- the suite aliases are named as deliberately **not** granted;
- every line anchor also names the content it points at.

> **Owner:** `CORE-MOVE`, a bounded `WP-230` follow-up round (ADR-022 D8). It
> runs in an exclusive window: no other grant that touches any path below may be
> in flight.
>
> **Allowed paths.** Everything not listed here is forbidden.
>
> - `packages/trading-core/**` (new):
>   - the moved closure (25 files at `a8a3a63`);
>   - the closure's 14 colocated tests. Two of them,
>     `loop-order-lifecycle.test.ts:106` and `order-provenance.test.ts:44`,
>     change their `./main.js` specifier to `./venue-policy.js`;
>   - `src/testing/index.ts`, a byte-identical copy of the trader's;
>   - `src/venue-policy.ts`, holding the `VenueWiring` / `createExecutionPolicy`
>     block cut from `apps/trader/src/main.ts` (:155-217 at `a8a3a63`);
>   - `src/index.ts`, `package.json` and `tsconfig.json`.
> - `apps/trader/**`, limited to:
>   - deleting the moved files;
>   - the `src/index.ts` and `src/testing/index.ts` facades;
>   - import-specifier-only edits in the files that stay. The core's
>     `src/index.ts` exports what those files import, including
>     `unreplacedPnlSnapshotProblem`, which the trader's `src/index.ts` does
>     not export today;
>   - cutting the venue-policy block out of `src/main.ts`, with the import names
>     only that block used, and adding the lines that import it from the core
>     and re-export it;
>   - `package.json` `dependencies`.
> - `pnpm-lock.yaml`: the `importers` blocks of `packages/trading-core` and
>   `apps/trader` only.
> - `test/unit/trader/health-realized-pnl.test.ts`: the :19 specifier, and the
>   `apps/trader/src/health.ts` path string (:214) in the test "the source files
>   on the path contain no Number(...), parseFloat or parseInt" only.
> - `test/unit/trader/health-server.test.ts`: the :20 specifier only.
> - `test/unit/trader/memory-store-pnl-snapshot-key.test.ts`: the :55, :56 and
>   :63 specifiers only.
> - `test/unit/trader/query-boundary-cast-scan.test.ts`: its scan root
>   (`TRADER_SRC`, :121) and the per-root file labels only.
> - `test/unit/tooling/dependency-direction.test.ts`, limited to:
>   - the `removeDependencies` fixture of the test "does not treat a strategy
>     class entry matching zero packages as an error" (:658), and the option's
>     comment (:224-230);
>   - the allowlist pin in "keeps the shipping contract valid under all of the
>     above" (:1017-1030);
>   - one `layerOf` assertion inside the existing test "classifies every
>     workspace package into exactly one §2 layer" (:442-458).
> - `docs/contracts/dependency-direction.md`, limited to:
>   - the §2 fence line and paragraph;
>   - rows S8-S18, moved verbatim from the PENDING subsection, which becomes a
>     dated DONE note;
>   - the S15 sentences in the §2.1 note and in §4;
>   - a dated §6 graph note with the MEASURED count.
> - `docs/handoffs/CORE-MOVE.md`.
>
> **Not granted.** The suite aliases (`tsconfig.json` and `vitest.config.ts`
> under `test/e2e`, `test/integration/paper-trader` and
> `test/integration/control-api`) and `tsconfig.lint.json` are not granted.
> They name the two facades, which stay at their paths. If a gate proves one of
> them must change, `CORE-MOVE` stops and reports, and the orchestrator amends
> this grant.
>
> **Invariants.**
> - `test/replay-golden/**` stays byte-identical.
> - Every moved file keeps its bytes, except the specifier-only edits named
>   above.
> - Line numbers are at `a8a3a63`. `CORE-MOVE` re-verifies them at its own
>   base by the content named beside each one.

### The optional checker-hardening grant (the orchestrator authorizes it or not)

> **Owner:** an optional, bounded checker-hardening round, shaped like
> `WP-015` (the check's owner, which is closed). The orchestrator decides
> whether to authorize it. If authorized, it runs after `H8-GOV` merges and
> before `CORE-MOVE`, and never at the same time as `CORE-MOVE`: both edit
> `test/unit/tooling/dependency-direction.test.ts` and
> `docs/contracts/dependency-direction.md`.
>
> **Allowed paths.** Everything not listed here is forbidden.
>
> - `tools/check-dependency-direction.mjs`, limited to:
>   - rule 2: a declared workspace edge into an `apps/*` package fails F10,
>     whatever the layers;
>   - a §2.1 row whose `to` endpoint is an application is a `CHK` error;
>   - rule 3: the relative half of F16, where a relative import specifier that
>     resolves outside the importing package's root fails F16;
>   - optionally, a `CHK` error for a §2.1 row that matches no declared edge.
> - `test/unit/tooling/dependency-direction.test.ts`: additive test cases only,
>   each mutation-proved. No existing assertion changes.
> - `docs/contracts/dependency-direction.md`, limited to the §3 F10 and F16
>   Source cells, the §5 enforcement list, and the §6 rule 2 and rule 3 text.
>   The §2 fences, the §2.1 table and the §2.1 PENDING subsection are not
>   touched.
> - The round's own handoff record under `docs/handoffs/`.
>
> **Acceptance anchors.**
> - `check:deps` passes on the repository with its package count, edge count
>   and allowlist (S0..S7) unchanged.
> - Every existing tooling test passes unchanged.
> - An app-to-app §2.1 row (the scoping's probe P3, accepted silently today)
>   fails with `CHK` and F10.
> - A relative cross-app import (probe P8, accepted today) fails F16.
>
> **Not in this grant:**
> - `CI2-L5-2` and `CI2-L5-3`. They ride along only if the orchestrator widens
>   the grant to `test/unit/tooling/**`.
> - Adding `packages/trading-core` to F14's purity-restricted set. That list is
>   §3 rule text, and the package does not exist before `CORE-MOVE`.

## Evidence

**The activation dry run and the hazard probes.** They ran in a scratch mirror
at `a8a3a63` carrying this round's candidate contract, with the checker run
through `--root <copy> --json`. The script is `activate-probe.cjs` in the
session scratch directory
`/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/h8-gov/`,
which is not committed. The staged text was read out of the
PENDING subsection's fences exactly as written, and each variant then made
these edits:
- **ACT:** each staged row's leading `| ` is restored and the rows are pasted
  after S7; the fence line is pasted after the class-entry line; and
  `packages/trading-core/package.json` is added, declaring the closure's 13
  workspace packages plus `zod`. No other edit.
- **+PROSE:** the ACT edits, plus the paragraph pasted into §2.
- **+TRADER / +BT:** the ACT edits, plus the `apps/trader` (and
  `apps/backtest-cli`) dependency on the core.
- The rest are the fail-closed and hazard variants.

```text
[AS-IS] exit=0 ok=true packages=34 edges=80 layer(trading-core)=undefined allowlist=S0,S1,S2,S3,S4,S5,S6,S7 violations={}
[ACT] exit=0 ok=true packages=35 edges=93 layer(trading-core)=1 allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={}
[ACT+PROSE] exit=0 ok=true packages=35 edges=93 layer(trading-core)=1 allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={}
[ACT+TRADER] exit=0 ok=true packages=35 edges=94 layer(trading-core)=1 allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={}
[ACT+TRADER+BT] exit=0 ok=true packages=35 edges=95 layer(trading-core)=1 allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={}
[FENCE-NO-MANIFEST] exit=1 ok=false packages=34 edges=80 layer(trading-core)=undefined allowlist=S0,S1,S2,S3,S4,S5,S6,S7 violations={"F-CLOSED":1}
   F-CLOSED packages/trading-core: §2 (line 88) classifies `packages/trading-core` in layer 1, but that path has no workspace `package.json`
[ROWS-NO-FENCE] exit=1 ok=false packages=34 edges=80 layer(trading-core)=undefined allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={"CHK":11}
   CHK docs/contracts/dependency-direction.md: docs/contracts/dependency-direction.md §2.1 row "S8" (line 146) names `packages/trading-core` as its `from` endpoint, but §2 classifies no package or class matching it.
   CHK docs/contracts/dependency-direction.md: docs/contracts/dependency-direction.md §2.1 row "S9" (line 147) names `packages/trading-core` as its `from` endpoint, but §2 classifies no package or class matching it.
   CHK docs/contracts/dependency-direction.md: docs/contracts/dependency-direction.md §2.1 row "S10" (line 148) names `packages/trading-core` as its `from` endpoint, but §2 classifies no package or class matching it.
   CHK docs/contracts/dependency-direction.md: docs/contracts/dependency-direction.md §2.1 row "S11" (line 149) names `packages/trading-core` as its `from` endpoint, but §2 classifies no package or class matching it.
[FENCE+ROWS-NO-MANIFEST] exit=1 ok=false packages=34 edges=80 layer(trading-core)=undefined allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={"F-CLOSED":1}
   F-CLOSED packages/trading-core: §2 (line 88) classifies `packages/trading-core` in layer 1, but that path has no workspace `package.json`
[PIPE-IN-FENCE] exit=1 ok=false packages=34 edges=80 layer(trading-core)=undefined allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8 violations={"CHK":1}
   CHK docs/contracts/dependency-direction.md: docs/contracts/dependency-direction.md §2.1 row "S8" (line 235) names `packages/trading-core` as its `from` endpoint, but §2 classifies no package or class matching it.
[BAD-ANNOTATION] exit=1 ok=false packages=35 edges=93 layer(trading-core)=1 allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={"CHK":1,"F13":11,"F12":2}
   CHK docs/contracts/dependency-direction.md: docs/contracts/dependency-direction.md §2 assigns `apps/trader` to layer 1 (line 88) and layer 3 (line 124); §2 requires exactly one layer per package.
   F13 apps/trader: same-layer edge `apps/trader` -> `packages/capital-allocator` (both layer 1) is not listed in §2.1
   F12 apps/trader: upward edge `apps/trader` (layer 1) -> `packages/event-bus` (layer 2) via dependencies; §5.2 permits only downward edges
   F13 apps/trader: same-layer edge `apps/trader` -> `packages/execution-planner` (both layer 1) is not listed in §2.1
[GLOB-ROW] exit=1 ok=false packages=35 edges=93 layer(trading-core)=1 allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8 violations={"CHK":1,"F13":1}
   CHK docs/contracts/dependency-direction.md: docs/contracts/dependency-direction.md §2.1 row "S8" (line 147) names `packages/*` as its `to` endpoint, which §2 classifies in more than one layer (0, 1, 2).
   F13 packages/trading-core: same-layer edge `packages/trading-core` -> `packages/strategies/static-bracket` (both layer 1) is not listed in §2.1
[S18-NO-EDGE] exit=0 ok=true packages=35 edges=92 layer(trading-core)=1 allowlist=S0,S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18 violations={}
[P3-APP-ROW] exit=0 ok=true packages=34 edges=81 layer(trading-core)=undefined allowlist=S0,S1,S2,S3,S4,S5,S6,S7,SX violations={}
```

All probe copies were deleted, and the mirror was removed after the round.
*(Round 1 re-ran every variant against the round-1 text, and the block above
is that re-run. It matches round 0's output except for one line: the
PIPE-IN-FENCE S8 line moved from 228 to 235, because the staged §2 paragraph
grew by seven lines.)*

**The staged block is unparsed.** The checker's `--json` report on the
candidate is **byte-identical** to the base's, with the same sha256: 34
packages, 80 edges, allowlist S0..S7, no violations. The
contract diff deletes only the two settled passages; no line of the §2 fences,
the §2.1 table, or the §3/§5/§6 rule text changed.

**The measurement scripts** are in the same scratch directory:
- `closure.cjs`: the TypeScript pre-processor over static, dynamic and
  type-only relative imports from `apps/trader/src/trader.ts`;
- `bindings.cjs`: every name imported from each workspace package, value or
  type;
- `globals.cjs`: an AST census of clock, randomness, scheduler and
  process-global references;
- `test-imports.cjs` and `staying-names.cjs`: the colocated tests, and the
  staying files' closure imports checked against `index.ts`'s exports.
- Round 1:
  - `claims-r1.cjs`: the claim-truth probes on an activated copy;
  - `pins-r1.mjs`: the three finding pins;
  - `pins-r1-proof.sh`: their fail-on-`81d1b34` proof.

  All three are described in the next section.

## Review round 1 (Codex gpt-6-astra, of `81d1b34`) and its remediation

**The verdict on `81d1b34` was CHANGES REQUIRED:** one MEDIUM and two LOW
findings, all about wording. Everything else passed:
- the parser: the `--json` report is byte-identical to the base's;
- the activation dry run, which the review reproduced independently;
- the rows, the work plan, the settlements, the grants and the scope.

Round 1 adds one commit on top of `81d1b34`, amending nothing, and touches the
same six allowed paths.

| Finding | Severity | Status | Pin |
| --- | --- | --- | --- |
| H8G-01 | MEDIUM | fixed | `PIN-H8G-01` `f12-scope` |
| H8G-02 | LOW | fixed | `PIN-H8G-02` `d10-layers`, which checks each stated layer against the check's `--json` |
| H8G-03 | LOW | fixed | `PIN-H8G-03` `d4-reverse-edge` |

**H8G-01: the F12 claim went beyond what the check enforces.**
- *What was wrong.* ADR-022 D3, its Consequences bullet and the staged §2
  paragraph called "a backtest cannot reach Redis, PostgreSQL or a signer
  through the core" a gate result. F12 fails only the edges a manifest
  declares into layer 2. A declared `pg` import passes.
- *The fix.* Each of the three passages now:
  - scopes F12 to the edges the manifest declares;
  - names what else binds the core: F6, F7 and F8;
  - names what the check does not catch: `pg`, a generic signing library,
    and an undeclared or relative import (F16);
  - says the remainder rests on the measured closure and on review.
- *Dated, not present tense.* The limits are stated as measured with the
  check at `a8a3a63`. The optional checker-hardening round, which runs before
  `CORE-MOVE`, may implement F16's relative half, and its grant forbids
  editing the PENDING subsection. A present-tense "not yet implemented" would
  then be activated by `CORE-MOVE` verbatim while false.
  - A scan of the staged text found one round-0 sentence with the same
    hazard. It was in row S18: "The check does not flag a row that matches no
    declared edge". The hardening grant may add exactly that `CHK`.
  - The sentence is now dated at `a8a3a63`. The rest of the row, including
    the sunset obligation, is unchanged.
  - No other staged sentence states checker behaviour in the present
    tense.
- *Aligned in the same round:*
  - the Alternatives' "F12 guarantee";
  - the "forecloses" bullet;
  - D10's last bullet;
  - the three work-plan comments this round had added (`WP-260`, `WP-320`,
    `WP-350`), which said F12 "keeps" or "bars" a package out of the core.
    They are this round's own additions, so the work plan still has 0
    deleted lines against the base.

**H8G-02: D10 put components in the wrong layers.**
- *What was wrong.* D10 said the live components "stay in layers 2 and 3".
  The contract and the check put `packages/oms`, `packages/inventory`,
  `packages/ledger` and `packages/execution-planner` in layer 1.
- *The fix.* D10 is rewritten:
  - each package keeps its paths and its §2 layer;
  - a table gives every `WP-260` to `WP-350` path with the layer the check
    reports;
  - the text separates layer-1 logic, layer-2 adapters and layer-3 wiring;
  - a future edge from the core to one of the layer-1 packages needs its own
    cited §2.1 row.
- *Also corrected:* `WP-350` is phase 4. `IMPLEMENTATION_STATUS.md:5` defers
  `WP-260` and the eight other phase-3 packages to Wave 3.

**H8G-03: D4 over-stated F9.**
- *What was wrong.* D4 said any same-layer reverse edge is F9 plus F13, but
  `packages/config` → core gives F13 only.
- *The fix.* D4 now says:
  - every reverse edge fails F13;
  - F9 applies only when the core already reaches the declaring package;
  - measured: the layer-1 packages the core reaches are exactly the eleven
    S8-S18 targets.

**Claim-truth probes.** Every new claim was measured before it was written:
- method: the same mirror as the activation dry run, with the staged fence
  line and rows activated and a core manifest of the 13 measured workspace
  packages plus `zod`;
- probe source: each import probe adds one file,
  `packages/trading-core/src/probe.ts`;
- script: `claims-r1.cjs`. Every probe copy was deleted after its run.

The output against the round-1 text:

```text
[ACT] exit=0 ok=true packages=35 edges=93 violations={}
[DECL-storage-postgres] exit=1 ok=false packages=35 edges=94 violations={"F12":1}
[DECL-polymarket-secure] exit=1 ok=false packages=35 edges=94 violations={"F12":1}
[DECL-event-bus] exit=1 ok=false packages=35 edges=94 violations={"F12":1}
[IMPORT-pg (declared external)] exit=0 ok=true packages=35 edges=93 violations={}
[IMPORT-ethers (declared external)] exit=0 ok=true packages=35 edges=93 violations={}
[IMPORT-ioredis (declared external)] exit=1 ok=false packages=35 edges=93 violations={"F8":1}
[IMPORT-@polymarket/client] exit=1 ok=false packages=35 edges=93 violations={"F6":1}
[IMPORT-@polymarket/clob-client (archived)] exit=1 ok=false packages=35 edges=93 violations={"F7":1}
[IMPORT-undeclared-workspace-bare] exit=0 ok=true packages=35 edges=93 violations={}
[IMPORT-relative-escape] exit=0 ok=true packages=35 edges=93 violations={}
core reaches (layer 1): packages/capital-allocator, packages/execution-planner, packages/features, packages/ledger, packages/order-book, packages/pnl, packages/risk, packages/simulation, packages/strategies/static-bracket, packages/strategy-runtime, packages/strategy-sdk
  [REV packages/capital-allocator] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/config] reachable=false exit=1 violations={"F13":1} as-stated
  [REV packages/execution-planner] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/features] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/inventory] reachable=false exit=1 violations={"F13":1} as-stated
  [REV packages/ledger] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/observability] reachable=false exit=1 violations={"F13":1} as-stated
  [REV packages/oms] reachable=false exit=1 violations={"F13":1} as-stated
  [REV packages/order-book] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/pnl] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/risk] reachable=true exit=1 violations={"F9":6,"F13":1} as-stated
  [REV packages/settlement] reachable=false exit=1 violations={"F13":1} as-stated
  [REV packages/simulation] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/strategies/static-bracket] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/strategy-runtime] reachable=true exit=1 violations={"F9":1,"F13":1} as-stated
  [REV packages/strategy-sdk] reachable=true exit=1 violations={"F9":3,"F13":1} as-stated
  [REV packages/testkit] reachable=false exit=1 violations={"F13":1} as-stated
  [REV packages/universe] reachable=false exit=1 violations={"F13":1} as-stated
  layer(packages/polymarket-secure) = 2
  layer(packages/oms) = 1
  layer(packages/ledger) = 1
  layer(packages/inventory) = 1
  layer(packages/storage-postgres) = 2
  layer(packages/execution-planner) = 1
  layer(apps/trader) = 3
  layer(apps/ops-cli) = 3
OK   ACT
OK   DECL-storage-postgres
OK   DECL-polymarket-secure
OK   DECL-event-bus
OK   IMPORT-pg (declared external)
OK   IMPORT-ethers (declared external)
OK   IMPORT-ioredis (declared external)
OK   IMPORT-@polymarket/client
OK   IMPORT-@polymarket/clob-client (archived)
OK   IMPORT-undeclared-workspace-bare
OK   IMPORT-relative-escape
OK   REV sweep: F13 always, F9 iff the core reaches the declaring package
CLAIMS: all as stated
```

**The pins.** `test/**` and `tools/**` are outside a documentation round, so
the pins are a scratch script, `pins-r1.mjs`.
- It reads the committed ADR-022, contract and work plan.
- `PIN-H8G-02` also runs the check's `--json` to get the layer map.
- `pins-r1-proof.sh` restores those three files from `81d1b34`, first all
  together and then one at a time, runs the pins after each restore,
  restores the round-1 bytes, and checks their sha256:

```text
== all three files restored from 81d1b34 ==
FAIL PIN-H8G-01 f12-scope
FAIL PIN-H8G-02 d10-layers
FAIL PIN-H8G-03 d4-reverse-edge
PINS: 3 of 3 FAILED
exit=1
== only docs/adr/ADR-022-shared-trading-core-is-a-layer-1-package.md restored from 81d1b34 ==
FAIL PIN-H8G-01 f12-scope
FAIL PIN-H8G-02 d10-layers
FAIL PIN-H8G-03 d4-reverse-edge
PINS: 3 of 3 FAILED
exit=1
== only docs/contracts/dependency-direction.md restored from 81d1b34 ==
FAIL PIN-H8G-01 f12-scope
PASS PIN-H8G-02 d10-layers
PASS PIN-H8G-03 d4-reverse-edge
PINS: 1 of 3 FAILED
exit=1
== only docs/spec/polymarket-bot-workplan.yaml restored from 81d1b34 ==
FAIL PIN-H8G-01 f12-scope
PASS PIN-H8G-02 d10-layers
PASS PIN-H8G-03 d4-reverse-edge
PINS: 1 of 3 FAILED
exit=1
== r1 bytes restored ==
docs/adr/ADR-022-shared-trading-core-is-a-layer-1-package.md: OK
docs/contracts/dependency-direction.md: OK
docs/spec/polymarket-bot-workplan.yaml: OK
PASS PIN-H8G-01 f12-scope
PASS PIN-H8G-02 d10-layers
PASS PIN-H8G-03 d4-reverse-edge
PINS: all 3 pass
exit=0
```

**Gates at the round-1 tree.** Every command ran with
`pnpm_config_verify_deps_before_run=false`, twice: once partway through the
round-1 edits, and again on the final tree before the commit. Both runs gave
the same counts and the same checker report.

The first run's js-yaml step failed because it could not resolve the module;
js-yaml is not hoisted to the root. It did not reach the parse. The
final run loads js-yaml 4.3.2 from its store path.

| Gate | Result |
| --- | --- |
| typecheck | exit 0, with no `error TS` line |
| lint | exit 0 |
| `check:deps` | PASS: 34 packages, 80 edges, allowlist S0..S7 |
| `check:deps --json` | **byte-identical** to the base's (sha256 `1a8c2347…`) |
| `test` | 348 files and 7,576 tests passed, as at base |
| `test:e2e` | 8 files and 206 tests passed |
| `test:replay` | 3 files and 17 tests passed |
| work plan | parses under PyYAML and js-yaml 4.3.2 |

The work plan's `git diff --numstat a8a3a63` is still 49 insertions and **0
deletions**. The drafting hazards still hold:
- A9: no line of the PENDING subsection starts with `|`;
- A10: the fence annotation has no `packages/` or `apps/` token;
- A11: 11 rows, 11 distinct targets, and no glob;
- no added line contains the prose assignment phrase that §6's shape table
  lists.

## summary

`H8-GOV` records the user's H8 ruling (option A) and prepares its activation
without changing anything the dependency check parses.
- **ADR-022 (Accepted).** It moves the `createPaperTrader` / `CoreLoop`
  closure into a new layer-1 package, `packages/trading-core`, that both
  composition roots build. It argues the §4.1 reading from the handoff's own
  text, keeps the core's PAPER ceiling under ADR-010's human gate, puts the D4
  sunset on row S18, and cites evidence measured at `a8a3a63`.
- **A staged, unparsed §2.1 PENDING subsection** in
  `dependency-direction.md`. It holds the fence line, the §2 paragraph, rows
  S8-S18, the two S15 sentences, and the `CORE-MOVE` grant verbatim. It sits
  beside two settlements that are true today and discharge `WP-210`
  `follow_up` 6.
- **A protected-contracts §5 precedent row**, plus the reattached `GOV-1D`
  row.
- **Work-plan ratification entries only:** 49 insertions, 0 deletions.
- **This record.**

The whole checker report is byte-identical to the base's (34 packages, 80
edges, S0..S7). The activation dry run passes at 35 packages with S0..S18, and
`apps/trader → trading-core` adds exactly one edge (93 → 94). Seven
corrections to the scoping's `60a5d7e` figures are absorbed and disclosed; five
of them were caused by `SNAP-1`. The most consequential is a new
`test/unit/trader` file that imports three moving modules by relative path;
the scoping's `CORE-MOVE` grant lacked it.

## files_changed

- `docs/adr/ADR-022-shared-trading-core-is-a-layer-1-package.md`: new.
- `docs/adr/README.md`: one index row.
- `docs/contracts/dependency-direction.md`:
  - the §2.1 PENDING subsection, inserted after row S7;
  - the §2.1 settled note, which replaces the `ExecutionVenue` bullet and the
    "Two known cases" count;
  - the §4 execution-venue sentence.
- `docs/contracts/protected-contracts.md` §5: the blank line before
  `GOV-1D`'s row is removed, and the `H8-GOV` row is appended.
- `docs/spec/polymarket-bot-workplan.yaml`: comments and list items only.
- `docs/handoffs/H8-GOV.md`: new (this record).

## tests_run

| Gate | Base `a8a3a63` | Candidate (this worktree) |
| --- | --- | --- |
| `pnpm run typecheck` | exit 0 | exit 0 |
| `pnpm run lint` | exit 0 | exit 0 |
| `pnpm run check:deps` | PASS: 34 packages, 80 edges, allowlist S0..S7 | PASS: 34 packages, 80 edges, allowlist S0..S7 |
| `node tools/check-dependency-direction.mjs --json` | sha256 `1a8c23473b91f04f…` | **byte-identical** (same sha256) |
| `pnpm run test` (root) | 348 files / 7576 tests passed | **348 files / 7576 tests passed**; `dependency-direction.test.ts` 187/187 and `lint-typed-program.test.ts` 14/14, as at base |

The base column comes from two places. Typecheck, lint and tests ran in a
clean scratch mirror at `a8a3a63`, and the checker ran in this worktree before
any edit.

Checks that have no base column:
- **Work plan:**
  - PyYAML and js-yaml 4.3.2 both parse it;
  - the parsed data differs from base only in the five lists named above, each
    base list a prefix of the new one;
  - `git diff --numstat`: 49 insertions, **0 deletions**.
- **Activation dry run and hazard probes:** the 13 variants quoted under
  "Evidence", run against the final text.
- **Drafting hazards:**
  - A9: no line in the PENDING subsection starts with `|` once trimmed;
  - A10: after the first token, the fence line has no token that starts with
    `packages/` or `apps/`;
  - A11: 11 rows, 11 distinct targets, no glob, and exactly 4 pipes per row;
  - the prose assignment phrase that the §2 parser accepts (§6's shape
    table) appears in none of the new text.
- **Citations:** every line ADR-022 cites was printed from
  `git show a8a3a63:<file>` and read against its claim.
- **Verbatim grant:** the contract's quoted grant, with its quote markers
  removed, equals the grant source byte for byte, and so does the copy in this
  record.
- **Scope:** `git diff --name-only a8a3a63..HEAD` lists exactly the six
  allowed paths.
- **Safety sweep:** `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS` and `LIVE_MICRO_MAX_*`
  appear only in ADR-022 D6, which restates them as unchanged.

**Not run, and not claimed:**
- `test:e2e`, `test:replay` and the integration suites (no code, test or
  fixture changed);
- GitHub CI (the orchestrator's step);
- any soak, execution probe or live gate.

## assumptions

1. **Line numbers.** Those in both grants and in ADR-022 are at `a8a3a63`.
   If the optional checker-hardening round lands first, its additive tests
   shift the `dependency-direction.test.ts` anchors. Every anchor therefore
   also names its content, and `CORE-MOVE` re-verifies it at its own base.
2. **S15's `BACKTEST-2` clause.** It names the simulated-venue surface that
   `main.ts`'s construction uses today (`SimulatedVenue`, `tier0Model`,
   `readFeeScheduleSnapshot`, `unmodeledRateLimits`, `BookView`), on the
   assumption that the one builder absorbs that construction (ADR-022 D5).
3. **Work-plan ownership.** The work plan is not a protected path, and its
   entries are orchestrator ratifications. This round drafted them under the
   packet's "ratification entries only" grant; the orchestrator's merge
   ratifies them. `IMPLEMENTATION_STATUS.md` is left to the orchestrator.
4. **The §4.1 reading** (ADR-022 D2) is argued, not ruled by the user. The
   user ruled option A and "ADR-022 is written". This ADR records the reading
   option A depends on, as the scoping's owner question 2 recommended.
5. **The commit hash.** A commit cannot contain its own hash, so it is
   reported in the implementer's structured handoff, not in this file.

## deviations

Each departure from the scoping's draft text is required by re-verification
at `a8a3a63`, or is a correction.

1. **The `CORE-MOVE` grant** differs from scoping item I in these ways:
   - it adds `test/unit/trader/memory-store-pnl-snapshot-key.test.ts` (:55,
     :56, :63). The file was new in `SNAP-1`, and it imports the moving
     `pnl-snapshot-key.js`, `ports.js` and `time.js`;
   - `health-realized-pnl.test.ts`'s path string moves from :187 to :214;
   - it states that the core's `index.ts` exports `unreplacedPnlSnapshotProblem`
     (`adapters/postgres-store.ts:89` imports it, and the trader's `index.ts`
     does not export it);
   - it names the two moved tests' `./main.js` → `./venue-policy.js`
     re-points, and allows `main.ts`'s cut to drop import names only the block
     used;
   - it names the suite aliases and `tsconfig.lint.json` as deliberately not
     granted, with a stop-and-report rule;
   - each line anchor also carries a content anchor.
2. **The fence-line insertion point** is after :87, the class-entry line. The
   scoping said "after the class-entry line at :88", but :88 is the closing
   fence.
3. **Measured figures and row text:**
   - the closure is 25 files / 11,218 lines, not 24 / 10,879;
   - S13 gains `toPnlSnapshotRow`;
   - S15 names the venue-policy block's `PlannedOrderView` and lists the
     simulated types it consumes;
   - S8 quotes `WP-230`'s goal in full ("… in the trader process"), with a
     pointer to ADR-022 D2 instead of a truncated quote;
   - every row reads "measured at `a8a3a63`".
4. **The §2 paragraph** says the trader builds the core, and
   `apps/backtest-cli` builds it from `BACKTEST-2` on. The scoping's "the
   trader application and `apps/backtest-cli` are the composition roots that
   build the core" would be false for the whole interval from `CORE-MOVE`'s
   activation to `BACKTEST-2`.
5. **The PENDING subsection also stages the two S15 activation sentences**
   verbatim, which the scoping kept only in its notes. Activation therefore
   needs no drafting.
6. **The optional `protected-contracts.md` fix was taken.** The blank line
   that detached `GOV-1D`'s row from the table (so it rendered as a stray
   paragraph) was removed.
7. **ADR form:**
   - it follows ADR-020's use of the README template, with Decision
     subsections `### D1` … `### D10`;
   - it adds a "Handoff sections" header line;
   - it places "Alternatives rejected" inside Consequences, so the template's
     four sections stay intact.

## known_risks

1. **The grant's completeness is argued, not executed.** No move was
   performed in this round, so the suite-alias exclusion rests on the
   scoping's move probe (variant B, green at `60a5d7e`) and on this round's
   re-reading of the import graph at `a8a3a63`. The grant's stop-and-report
   rule is the mitigation.
2. **S18's removal cannot be enforced today.** A row that matches no declared
   edge is not flagged (probe S18-NO-EDGE: PASS, 92 edges). Until the optional
   hardening adds the "row matches no edge" `CHK`, S18's removal in the D4
   round is an obligation, not a gate.
3. **F10 is still unimplemented.** Probe P3 shows an app-to-app §2.1 row plus
   the dependency passes today (exit 0, 81 edges). Until the hardening round
   lands, option B's hole stays open to a careless edit.
4. **The staged rows are a second copy of text the check will parse.**
   `CORE-MOVE` must drop them in its DONE note (PENDING step 7). If it
   forgets, a later edit to a table row would silently diverge from its
   staged copy. The copy itself stays unparsed.
5. **ADR-016 and ADR-021 cite paths that move.** They go stale at
   `CORE-MOVE` and stay as history (README, "Status vocabulary").
6. **The last §6 graph note is out of date.** It records 78 edges
   (2026-09-15), while the check reports 80 at `a8a3a63`: `BACKTEST-1` added
   two downward edges and recorded no note. This is pre-existing, and this
   round does not edit §6. `CORE-MOVE`'s measured note supersedes it.
7. **The core's isolation from PostgreSQL clients and signers is not gated**
   (round 1, H8G-01). With the check at `a8a3a63` and the core activated, a
   declared-and-imported `pg` or `ethers` passes. So does an undeclared or
   relative import of an adapter (`claims-r1.cjs`). F12, F6, F7 and F8 cover
   the rest.
   - If the optional checker-hardening round implements F16's relative half,
     the relative import stops passing.
   - The staged §2 paragraph and ADR-022 D3 date these limits at `a8a3a63`,
     so that round does not have to edit the PENDING subsection, which its
     grant forbids.
   - Until a §3 rule binds the core, a `pg`, `ethers` or undeclared-name
     regression is caught by review or not at all.

## follow_up

1. **Orchestrator, at merge:**
   - record `H8-GOV` in `IMPLEMENTATION_STATUS.md`;
   - decide the optional checker-hardening round (grant quoted above);
   - write `CORE-MOVE`'s packet from the grant quoted above, re-verified at
     its base.
2. **`CORE-MOVE`:**
   - activate the PENDING text verbatim;
   - keep the moved code byte-identical;
   - add the core `index.ts` export of `unreplacedPnlSnapshotProblem` (and
     `pnlSnapshotKey` if a staying file needs it), so the core's `index.ts`
     has one more export block than the scoping's "23 blocks plus
     venue-policy" (acceptance part 5 needs the matching update);
   - measure the §6 count. The dry run gives 94 with the trader's manifest
     otherwise unchanged, and fewer if its unused dependencies are pruned.
3. **`BACKTEST-2`:**
   - build the core from `apps/backtest-cli`;
   - build the single venue builder;
   - correct the four stale comments (ADR-022 Consequences);
   - its grant should allow S15's text correction if the builder consumes a
     different simulation surface than the one S15 names.
4. **The next docs round:** ADR-022's discharge note, marking it implemented,
   on the ADR-021 precedent (`e6548cf`). `BUNDLE1-LOWS` (1) is already queued
   for the same round.
5. **A governance round after `CORE-MOVE`** (round 1, H8G-01): decide
   whether a §3 rule binds `packages/trading-core` to the checker's
   database-client and signing-library catalogues. Today they bind only
   `packages/domain` (F1), `packages/strategies/**` (F3) and
   `packages/simulation` (F5).
   - Such a rule would be new §3 rule text, plus its checker implementation.
     The package does not exist before `CORE-MOVE`.
   - It is separate from F14's purity-restricted set, which the hardening
     grant above leaves out. That set governs opaque constructs; it does not
     govern which catalogues apply.
   - This round records the question and grants nothing.

## commit_sha

Two commits on branch `h8-gov`, on base `a8a3a63`:
- round 0 is `81d1b3471dd1150e3f2a26ef4a7db18a4da90cac`;
- the round-1 remediation sits on top of it.

A commit cannot contain its own hash. The round-1 hash is in the
implementer's structured handoff, and the orchestrator records it at merge.
