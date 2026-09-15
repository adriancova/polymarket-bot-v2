# SER-1 completion record — the own-data JSON encoder and the accounting Map keys

**Merged:** `c065d63` (`--no-ff`, 2026-09-15). Chain on base `9a44167`:
`62566ce` (candidate) → `ebd5211` (r1). Review arc: r1 **CHANGES REQUIRED**
(2 MEDIUM, 2 LOW) → r2 **ACCEPT**. One remediation round, opened by the
reviewer.

**What it is.** Round 1 of the `docs/handoffs/SER-0-sweep.md` remediation — the
OPEN successor obligation `docs/contracts/schema-boundary.md` §5 recorded when
`WP-060-FU1` merged: `JSON.stringify` resolves `toJSON` through the PROTOTYPE
CHAIN, so an inherited `toJSON` on `Object.prototype`/`Array.prototype`
(assignment or non-enumerable `defineProperty`) replaces the bytes of any
object and any array keeping `Array.prototype`, and one reachable through
`BigInt.prototype` turns a bigint's typed refusal into accepted bytes. At base,
the five accounting Map keys (`ledger/balance.ts` `attributionBucketKey`,
`legKeyOfValidated`; `ledger/projections.ts` `balanceLineKey`,
`virtualPositionKey`; `pnl/state.ts` `key2`) were `JSON.stringify` of an array
literal the site itself builds. Measured and independently reproduced (SER-0,
then again by this round's reviewer with its own builders): under 4 of the 6
contexts every key collapses to one constant, so a cross-account parity breach
and a non-compensating reversal are ACCEPTED where clean refuses
(`LEDGER_ATTRIBUTION_PARITY_BROKEN`, `LEDGER_REVERSAL_NOT_COMPENSATING`), the
projection's balance book is EMPTY for any history (every zero-sum line nets to
zero and is dropped), every instance's positions fold into one line, and the
§9.16 fee/reward breakdowns come back empty. ADR-020 §6 binds a conforming door
against exactly that ("no refusal … may vary with ambient prototype state").

## Model and process note (2026-09-04 policy)

Implemented by Claude **Opus** `wp-implementer` agents (candidate and r1, in an
isolated hardlinked worktree); adversarial review by Codex `gpt-6-astra` in a
second hardlinked worktree at each tip; the orchestrator reproduced every gate
both ways (base and tip) in the implementer's worktree and on `main`.

## What shipped

1. **`packages/risk/src/plain-json.ts`** — `encodePlainJson(value, { maxDepth?, indent? })`:
   ECMA-262 25.5.2 restated over OWN DATA (the `encodeWireJson` algorithm of
   `d99c2ac`, moved to the canonical own-data home named by the GOV-2A ruling),
   exported as the `./plain-json` subpath only. Byte-identical to
   `JSON.stringify(value, null, indent)` in a clean process for plain data;
   never consults `toJSON`; every divergence is a typed `NotPlainJson
   { kind, path, problem }` from the closed vocabulary `PLAIN_JSON_REFUSAL_KINDS`
   (`UNDEFINED_ROOT`, `BIGINT`, `EXECUTABLE`, `ACCESSOR`, `NON_PLAIN`, `DEPTH`).
   PLAIN CONTAINERS ONLY: a `Date`/`Map`/`Set`/class instance/wrapper/array
   subclass/cross-realm array is refused rather than silently `{}` or a
   method's answer. Options are not data: `indent` integer 0–10, `maxDepth`
   integer 1–`MAX_PLAIN_JSON_DEPTH` (256; default `MAX_DEPTH` 64), out of domain
   → `RangeError` before any traversal (r1, M1).
2. **`packages/event-bus/src/envelope-door.ts`** — `encodeWireJson` is a thin
   adapter (`maxDepth: 16`) mapping the refusal `kind` to the six pre-existing
   `NotWireData` messages (verbatim); the six private helpers deleted; the
   classifier reads `kind` as own data (never `instanceof`, per the round-4
   `brand.ts` lesson) and is pinned against hostile thrown values (r1, M2).
   `envelope-wire-bytes.test.ts` unmodified (sha256 `f6b76d0a…bf7052`),
   byte-identical. `packages/event-bus` → `packages/risk` is a downward edge
   (workspace link; lockfile importer block only).
3. **The five keys and the `stableStringify` scalar/key branches**
   (`ledger/projections.ts`, `pnl/serialize.ts`) built by the primitive; key
   format unchanged (JSON array text, re-parsed by `computePnlSnapshot`);
   bytes byte-identical for every in-type input (reviewer: 15,125 key
   comparisons, 0 differences). Disclosed: `stableStringify` keeps emitting the
   text `undefined` for an explicit-undefined scalar (`runId: undefined` is
   admitted at base and produced exactly those bytes; hash equal at base and tip).
4. **`docs/contracts/dependency-direction.md`** §2.1 S5/S6: the consumed-surface
   clause widened to `plain-json.ts` with the measured basis; no new row;
   `check:deps` 34 packages / 72 edges (71 + the downward event-bus edge).
5. Tests: `test/unit/risk/plain-json.test.ts` (48: differential corpus for
   indent {0,1,2,4}, six-context invariance with the injected `toJSON` counted
   at 0, refusal table with paths, the depth ceiling), `test/unit/ledger/
   inherited-tojson.test.ts` (5) + shared harness, `test/unit/pnl/
   inherited-tojson.test.ts` (2), `packages/event-bus/src/
   envelope-door-classifier.test.ts` (9). Non-vacuity: a `JSON.stringify`
   stand-in kills 41/43 of the encoder battery; the seven accounting pins fail
   7/7 with the four sources reverted to base (orchestrator-reproduced); the
   `instanceof` classifier mutant is killed by 4 tests (r1).

## The review arc

- **r1 (`62566ce`, CHANGES REQUIRED):** independent fuzz (xorshift32 seed
  `0x5e710915`, 22,627 cases, 0 byte differences), seven-prototype invariance
  table (0 encoder calls, native controls live), key corpus (15,125, 0
  differences), SER-0 defects reproduced at base and closed at the candidate
  with the reviewer's own scenario builders, eight mutants (seven killed).
  Findings: **M1** `maxDepth` accepted any safe integer while the recursive
  walk overflowed the stack near 2,000 levels — an untyped `RangeError`
  escaped where a typed refusal was promised; **M2** the `instanceof`
  classifier mutant survived 978/978 tests though a hostile thrown Proxy
  distinguishes it; **L1** the adapter comment overstated "re-thrown
  untouched" (structural classification is forgeable from inside the encoder,
  reachable only through a Proxy trap, excluded by the materialized-input
  precondition of the sole caller); **L2** the header omitted the
  option-domain `RangeError`.
- **r1 remediation (`ebd5211`):** `MAX_PLAIN_JSON_DEPTH = 256` enforced at
  option validation (header states the stack-budget argument: reviewer measured
  1,000 encode / 2,000 overflow at Node 24's default stack; the implementer
  measured first overflow ≈2,550 in the vitest worker; every consumer's bound
  ≤ 64); five depth tests; `envelope-door-classifier.test.ts` (9) pins the
  hostile pair, the accessor-`kind` and throwing-descriptor controls, and the
  structural-forgery residual as measured; the two comments rewritten.
- **r2 (`ebd5211`): ACCEPT, no new findings. Every r1 finding closed by independent reproduction: the r1 depth harness now gets the option-validation `RangeError` naming the ceiling (never a stack overflow); 256/257/cycle behave as pinned; a fresh-process bisection put the encoder's first overflow at 1,910 levels — a **7.46×** margin over the ceiling; the `instanceof` mutant is killed by the four named classifier tests; the L1/L2 sentences were checked against the code one by one; fuzz re-run on the r1 seed and a second seed (2 × 22,627 cases, 0 byte differences); key corpus 15,125 / 0; six-context invariance 0 encoder calls with live native controls; all eight r1 mutants still killed (992 relevant tests); confinement 4 files, no protected path, six messages verbatim at base/candidate/tip.**

## Residuals (owned)

- The encoder does not detect a `Proxy` (its reflective operations run the
  traps); stated in the header. Every consumer hands it a container it built
  or a materialized tree. Owner: any future consumer that encodes a value it
  did not build must read it through `readPlainData` first.
- The adapter's classification is structural and forgeable from inside the
  encoder; the guard is the sole caller's materialized-input precondition,
  pinned rather than closed. Owner: `packages/event-bus`.
- The depth ceiling is a stack-budget argument, not a proof; a future consumer
  passing a bound near 256 from a deep call site must re-measure. Owner: that
  consumer's round.
- `stableStringify`'s explicit-`undefined` oracle text is preserved (invalid
  JSON, valid oracle). Owner: `packages/ledger`/`packages/pnl` if the oracle is
  ever re-parsed.
- The reviewer could not run the full root suite in its sandbox (EPERM on
  `spawnSync`/`listen` in five files, identical at base); the orchestrator ran
  it green outside the sandbox at every tip. Recorded as UNVERIFIED-by-reviewer.

## Gates at the merged tip `ebd5211`

- `pnpm run test`: 306 files / 6944 tests (base `9a44167`: 302 / 6880; +4
  files, +64 tests = 48 + 5 + 2 + 9). `typecheck`, `lint`, `check:deps` (34/72)
  green. `packages/event-bus` `test:integration` 8 files / 81 tests green
  (Docker up this session).
- Post-merge on `main` at `c065d63`: `pnpm install --frozen-lockfile --offline` (the event-bus → risk link materialized), `check:deps` 34/72, lint, typecheck, `pnpm run test` 306 files / 6944 tests, `packages/event-bus` `test:integration` 8 files / 81 tests — all green.

## Follow-ups (owned)

- `SER-2` and `SER-3` (scope fixed in `IMPLEMENTATION_STATUS.md`) consume
  `encodePlainJson` — `indent: 2` for the pretty-printed artifacts;
  `PLAIN_JSON_REFUSAL_KINDS` for typed re-mapping; pass `maxDepth` ≤ 64 or omit.
- `docs/contracts/schema-boundary.md` §5: the OPEN successor obligation is now
  MEASURED (SER-0) and being closed in three rounds — docs round after SER-3.
- `test/unit/ledger/inherited-tojson.ts` could become the shared six-context
  harness for SER-2/SER-3 pins.
- `TRDR-2` candidate (out of class, recorded in SER-0): `writePnlSnapshot`'s
  camelCase keys into snake_case columns.
