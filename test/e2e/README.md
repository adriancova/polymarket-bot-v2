# Paper end-to-end verification suite (WP-250)

Adversarial verification of the paper-ready core: `apps/trader`'s composition
root driving the merged `WP-030`…`WP-240` packages end to end, verified from the
OUTSIDE.

## Running it

```
pnpm test:e2e
```

The root `test:e2e` script (orchestrator-wired in `da37a0c`; the root
`package.json` is a protected path) is `vitest run --config
test/e2e/vitest.config.ts`, so `pnpm vitest run --config
test/e2e/vitest.config.ts` is the same run. The root unit runner
(`test/vitest.config.ts`) includes `test/unit/**`, `packages/**/src/**` and
`apps/**/src/**` only, so nothing in this tree enters the root `pnpm test`
count — `pnpm test:e2e` is its own gate.

Type checking is wired the same way: `pnpm typecheck` runs this tree's own
`test/e2e/tsconfig.json` (`tsc -p test/e2e/tsconfig.json --noEmit`) after
`test/tsconfig.json`, which includes `test/unit` only. To check this tree
alone:

```
pnpm exec tsc --noEmit -p test/e2e/tsconfig.json
```

`pnpm lint` (`eslint .`) covers this tree too.

## What is real, and what is doubled

REAL, in every test here: `packages/order-book`, `packages/features`,
`packages/strategy-runtime`, `packages/strategies/static-bracket`,
`packages/capital-allocator`, `packages/risk`, `packages/execution-planner`,
`packages/simulation`'s `SimulatedVenue`, `packages/ledger`, `packages/pnl`, and
the whole of `apps/trader`.

DOUBLED, and only these three: the §12.1 `Clock`, the §4.2 event transport and
the §4.2 durable store — using `apps/trader`'s OWN in-memory implementations
(`@polymarket-bot/trader/testing`). No subject behaviour is doubled anywhere.

**No Docker. No network. No credential. No signer. No real order.** Nothing in
this tree opens a socket, reads an ambient environment variable or contacts a
database. There is no PostgreSQL, Redis or testcontainers evidence here and none
is claimed.

## Why this is not a second copy of `WP-230`'s integration suite

`test/integration/paper-trader/acceptance-3-traceable-chain.test.ts` walks §6
invariant 4 hop by hop from INSIDE a live process, holding the loop, the venue
and the ledger as objects. That is the right test for the process's own suite
and this package does not repeat it.

`WP-250` verifies the same chain with a DIFFERENT PRIMITIVE: the run is captured
into one plain document, serialised to canonical bytes, and the chain is
resolved as a CLOSED-WORLD GRAPH over those bytes by a module that imports
nothing from any workspace package (`support/chain-walk.ts`). An id that names
something outside the document is a broken hop, because there is nowhere else to
look — and the walk is BIDIRECTIONAL: the orphan checks prove nothing was
persisted that no chain accounts for, which forward resolution can never show.

## Layout

| File | What it is |
| --- | --- |
| `support/scenario.ts` | this package's OWN deterministic scenario — configuration and recorded events, every number's reason stated |
| `support/harness.ts` | assembles the real composition with `main.ts`'s venue wiring, and drives it |
| `support/artifact.ts` | captures what the run PERSISTED into one plain document, plus every order's submission-time provenance (`orderProvenance`, golden format 2, `RECON-2`) |
| `support/canonical-json.ts` | the canonical byte form, with a §6-invariant-1 float guard |
| `support/chain-walk.ts` | the outside-in, closed-world traceability walk; every order's provenance record is a node that must resolve, with no orphan and no order without one (`RECON-2`) |
| `support/reconcile.ts` | projected-vs-realized rows with named mechanisms and exact residuals; every order — filled or not — attributed to the entry or an exit through its own provenance record, by id, or refused (`RECON-2`); the open cost basis restated from `packages/pnl`'s average-cost specification, folded in `atEventIngestSeq` order (`RECON-1`); shares still open at run end named `POSITION_OPEN_AT_RUN_END` (`RECON-2`) |
| `support/module-specifiers.ts` | every module specifier a source names, read from its PARSED syntax tree — the one helper both import scans share (`RECON-2`, `RECON1-SCAN`) |
| `support/golden.ts` | the committed golden's path, reader and deliberately-fatal regenerator |
| `traceability-chain.test.ts` | acceptance 1, over the run's bytes AND over the committed golden |
| `traceability-chain-negative.test.ts` | one mutation per hop, plus one per document-level finding — the provenance section's included, by exact finding set: the walk must be falsifiable |
| `projection-reconciliation.test.ts` | acceptance 2, with four falsifiability probes |
| `reconciliation-attribution.test.ts` | `RECON-1` / `RECON-2`: synthetic artefacts built from the golden that pin the reconciler's by-id attribution of every order through its provenance record and its refusals (`RISK2-R3`, `RECON1-ORIGIN`), its sequence-ordered fold (`RISK2-R4`), its agreement with the real `packages/pnl` engine on partial exits, the open-position mechanism (`RECON1-EDGE`) and the oracle's import independence |
| `determinism-golden.test.ts` | two fresh runs byte-identical to each other and to the committed golden |
| `residuals-observed.test.ts` | the known residuals, observed and never fought — five rows, three of them (1, 2 and 5) now pinning their RESOLUTION (`BRACKET-1a` resolved residual 5: the protective reduction's own fill closes the bracket) |
| `safety-posture.test.ts` | the four repository floors, refused not clamped, plus a scan of this package's own files — imports read from each file's parsed syntax tree (`RECON1-SCAN`) |

## Determinism hygiene

No wall clock (`ManualClock`, positioned only by the scenario's literal
instants), no host entropy, no ambient environment read, no filesystem read
outside the committed golden and this package's own sources. Ids are minted by
the trader's `DeterministicIdFactory` from a fixed `idNamespace`.
`safety-posture.test.ts` enforces all of it by scanning this tree for
random-source and wall-clock CALLS and for any module specifier outside a small
permitted set.

## Acceptance criteria, mapped

| Criterion | Named by |
| --- | --- |
| 1 — the traceability chain is complete | `traceability-chain.test.ts` ("every hop resolves by id, in every chain, over the run's own bytes" and the golden twin), made falsifiable by `traceability-chain-negative.test.ts` |
| 2 — zero unexplained projection difference | `projection-reconciliation.test.ts` ("every row is explained…"), made falsifiable by the four probes in the same file; the reconciler's own attribution and cost method are pinned by `reconciliation-attribution.test.ts` |
| 3 — time-based paper evidence remains explicitly pending | an HONESTY criterion, discharged in `docs/experiments/phase-2-verification.md`. **No soak, execution probe or live gate has occurred, and this suite claims none.** |
