# Paper end-to-end verification suite (WP-250)

Adversarial verification of the paper-ready core: `apps/trader`'s composition
root driving the merged `WP-030`…`WP-240` packages end to end, verified from the
OUTSIDE.

## Running it

```
pnpm vitest run --config test/e2e/vitest.config.ts
```

There is no root `pnpm test:e2e` script yet: the root `package.json` is a
protected path and its wiring is orchestrator-owned at merge (the `af059d7`
precedent). The root runner (`test/vitest.config.ts`) includes
`test/unit/**`, `packages/**/src/**` and `apps/**/src/**` only, so nothing in
this tree enters the root `pnpm test` count.

Type checking has the same shape: `pnpm typecheck` runs `test/tsconfig.json`,
which includes `test/unit` only, and this tree carries its own
`test/e2e/tsconfig.json`. Run it with:

```
pnpm exec tsc --noEmit -p test/e2e/tsconfig.json
```

`pnpm lint` (`eslint .`) DOES cover this tree already.

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
| `support/artifact.ts` | captures what the run PERSISTED into one plain document |
| `support/canonical-json.ts` | the canonical byte form, with a §6-invariant-1 float guard |
| `support/chain-walk.ts` | the outside-in, closed-world traceability walk |
| `support/reconcile.ts` | projected-vs-realized rows with named mechanisms and exact residuals; every fill and order attributed to the entry or an exit by id or refused, and the open cost basis restated from `packages/pnl`'s average-cost specification, folded in `atEventIngestSeq` order (`RECON-1`) |
| `support/golden.ts` | the committed golden's path, reader and deliberately-fatal regenerator |
| `traceability-chain.test.ts` | acceptance 1, over the run's bytes AND over the committed golden |
| `traceability-chain-negative.test.ts` | one mutation per hop, plus one per document-level finding: the walk must be falsifiable |
| `projection-reconciliation.test.ts` | acceptance 2, with four falsifiability probes |
| `reconciliation-attribution.test.ts` | `RECON-1`: synthetic artefacts built from the golden that pin the reconciler's by-id exit attribution and refusals (`RISK2-R3`), its sequence-ordered fold (`RISK2-R4`), and its agreement with the real `packages/pnl` engine on partial exits |
| `determinism-golden.test.ts` | two fresh runs byte-identical to each other and to the committed golden |
| `residuals-observed.test.ts` | the four known residuals, observed and never fought |
| `safety-posture.test.ts` | the four repository floors, refused not clamped, plus a scan of this package's own files |

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
