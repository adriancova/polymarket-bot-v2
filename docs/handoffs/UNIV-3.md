# UNIV-3 completion record — The packages/universe state-side round

**Merged:** `cbc1ed3` (`--no-ff`, 2026-09-07). Chain `db13a00`
(candidate, one commit) → `3340675` (remediation r1) on base `c2c0733`.
Review r1: CHANGES REQUIRED (1 MED-HIGH + 2 LOW + 3 NOTE); remediation;
confirming pass: **CONFIRMED ACCEPT** on all eight checklist items.

**Model/process note (2026-09-07 operator policy).** The candidate was
implemented by a Claude (Opus 5) wp-implementer and reviewed by a fresh
Claude adversarial reviewer; the implementer was rate-limit-killed
before remediation. Under the operator's mid-round instruction the
remediation was implemented AND confirm-reviewed by **Codex
gpt-6-astra** (write-enabled worktree run; read-only-scratch confirming
run using the r1 reviewer's own mutants as the oracle). The
orchestrator staged/committed the remediation (Codex's sandbox cannot
write worktree git metadata), inspected the diff, and reproduced every
gate at the tip.

**What it is.** GOV-2A §5 item 9c — the consolidated residual queue
from UNIV-1 r1 and UNIV-2 r1, all seven items closed. Three new
modules: `grammar.ts` (formats derived from the schemas' own patterns —
never re-implemented), `state-door.ts` (the projection door, §7.1
order re-statement, the `metadataVersion` verdict), `parameters-door.ts`
(the observation door). The sharpest measured cell was beyond the
packet: in `eligibility.ts`, an inherited `rulesVersionId` equal to the
reviewed spec's flipped §9.2 model-dependent activation from
refused-with-`UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT` to
permitted-with-no-refusals, both variants. Also closed: the projection
dot-read class (rules-hole APPLY, `openedAt` swallow/conflict, second
resolution, replay-guard bypass), the instant-format terminal-
transition residual (differential 1128 rows drift 0), the
`parameters.ts` output-side adoption (corrupt `changedParameters` in
immutable versions AND the emitted `TradingParametersChanged`), the
`skipChecks` observation defeat (13 cells → `UniverseValidationError`,
schema judging first, honest messages byte-identical), the two
SANCTIONED tightenings, and the `ingestSeq` gap (base: `"0x10"` ordered
as 16, a missing `gatewayEpoch` skipped the replay guard entirely).

## The review arc (the round that earned its keep)

- **r1 (CHANGES REQUIRED)** — the reviewer verified the whole packet
  true, then found **F1**: a fail-open regression the round itself
  introduced. `effectiveLifecycleState` invented `?? "DISCOVERED"`
  while `eligibility.ts`/`recordObservedOutcomeState` still dot-read
  `lifecycleState`; an own enumerable ACCESSOR returning `"RESOLVED"`
  (no pollution needed) or an inherited value made activation ALLOW
  and the terminal-conflict write ACCEPT where base refused — and the
  default was pinned by nothing (`?? "RESOLVED"`, `?? "CLOSING"`, and
  removal each survived all 402). Bounded severity: zero in-repo
  `evaluateMarketReadiness` call sites today. F2: the `metadataVersion:
  null` cell exceeded the tightening sanction (base's `?? 1` emitted a
  schema-valid payload). F3: a header claim falsified by the
  own-accessor-with-valid-value refusal. F4–F6: wording/disclosure.
- **Remediation (`3340675`)** — required scalar projection fields
  (`lifecycleState`, `outcomeState`, `metadataVersion`, `seriesBinding`)
  must now be own enumerable DATA properties: missing or
  accessor-shaped refuses `UNIVERSE_INPUT_INVALID` (the parameters-door
  rule, adopted); `eligibility.ts` and `recordObservedOutcomeState`
  read through the same door as the derived readers; the invented
  default is gone; null `metadataVersion` restored to default-1; the
  `parameters: null` readiness TypeError closed and pinned; five
  equivalent surviving mutants disclosed in the suite header.
- **Confirming pass (CONFIRMED ACCEPT)** — all three formerly-surviving
  default mutants now each kill (`never silently defaults missing
  lifecycleState in the derived reader`); both F1 triggers plus the
  honest control verified (honest own `"RESOLVED"` keeps
  `UNIVERSE_MARKET_RESOLVED`/`UNIVERSE_TERMINAL_OUTCOME_CONFLICT`);
  414/414; digest constants byte-identical; protected files
  byte-identical; scope exactly six files.

## Evidence highlights (r1 reviewer, different primitives)

- The 87-case UNIV-2 digests re-derived WITHOUT the implementer's stash
  method: exactly ONE moved row (`bind/noApprover` — base stored an
  APPROVED binding with no approver; tip refuses with
  `SeriesDefinitionSchema`'s own message). The cold-load attack on the
  pattern derivation FAILED (fail-open 0/7 while the schema under
  `skipChecks` accepts 7/7); `isPositiveDecimalString` ≡ the schema's
  own canonical check row-for-row. Key-order/bytes of every stored and
  emitted record byte-identical base↔tip. Containment escapes 15
  (base) → 1 (tip, closed in remediation).

## Residuals (owned)

- **The direct-export caller-input round:** `applyMarketLifecycleEvent`
  (direct export) still dot-reads `input.eventType`/`input.payload`
  (an empty input + inherited pair folds a MarketResolved —
  base-identical; the registry path is doored), and its order-PRESENCE
  read (`input.order !== undefined`) is likewise base-identical (the
  order SHAPE is re-stated on both paths). Owner: a future
  direct-export round.
- Nested values of a hand-built projection carried by reference
  (in-package paths all prototype-free). Same owner.
- UUIDv7/token-id/condition-id/CodeString grammars unstated under
  `skipChecks` (base-identical). Owner: recorded; D2/ADR-020.
- D2 not performed; the permanent cold-`discriminatedUnion` poisoning
  stays with ADR-020 governance (now measured in four boundaries).
- `seriesBinding` is frozen but prototype-BEARING (`kind` always own,
  no instance) — the r1 reviewer's precision note.

## Follow-ups (owned)

1. Docs round (orchestrator, combined with SETL-2's): §3 universe row
   → CLOSED for the state-side class; §5 item 9c EXECUTED (all of
   item 9 now closed); tally; enter the residuals above; the §2 table
   gains nothing new from this round (the derivation-attack result
   corroborates the ADR-020 own-read discipline).
2. The direct-export caller-input round (bounded, opportunistic).
3. ADR-020 governance: the severed-arena/D2 question and the
   near-parallel-door consolidation (universe now carries four
   in-package door modules).
