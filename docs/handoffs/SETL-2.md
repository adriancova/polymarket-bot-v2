# SETL-2 completion record — The packages/settlement observation/evaluation door

**Merged:** `6142e66` (`--no-ff`, 2026-09-07). Chain `0a4e11e`
(candidate, one commit) → `26a6959` (disclosed orchestrator header fix,
reviewer wording — the survivor census 3→8) on base `c2c0733`. One
review round: ACCEPT (0 blockers; 1 LOW handoff-accuracy, 8 NOTE).

**What it is.** GOV-2A §5 item 10 — the last open §5 grant. Reproduce-
first measurement found the class TOTAL and WORSE than the packet's
premise: `evaluateSettlement` never parsed an observation at all, so
every declared observation field adopted from `Object.prototype`, and
the headline rows land wrong values on the PAYOUT surface — a
TerminalSpot `strike` hole with an inherited `"0"` settled `YES_WIN`
with payout `{yes:"1",no:"0"}`; an inherited `comparison` `LT` flipped
the direction; a btc spec was settled by an `eth.usd` reading whose own
symbol was deleted. Closed by `observation-door.ts` (D1/D3/D4) reusing
`spec-door.ts`'s primitives — `spec-door.ts` is BYTE-UNCHANGED, no
fifth near-parallel materializer; the door judges presence, ownership
and routing only. **D2 is declared vacuous and MEASURED**: the
evaluation path delegates no decision to zod, and the reviewer's 40-key
× 2-variant battery found zero zod-defeat divergence at tip (base had
four distinct escaping TypeError classes; tip has zero). No public
parse entry was added (no wire caller exists; recorded follow-up).

## Beyond the packet (both closed, one surfaced by review)

- The compatibility matrix's object-literal lookup: an inherited
  `observationType:"toString"` made `checkPayoffModelCompatibility`
  throw (`requirements.required is not iterable`),
  `isCompatiblePayoffModel("toString")` return `true`, and
  `payoffModelRequirements` return a FUNCTION. All typed at tip.
- `payoutPerShare`'s zod-backed refusal detail threw under inherited
  `_zod`/`value`/`get` (and `set`/`writable` — the review's addition to
  the prose) on every PENDING threshold market, taking
  `evaluateSettlement` with it. Contained at tip.
- **The review's undisclosed-improvement finding (F9):** at base,
  `comparison:"BOGUS"` settled `NO_WIN` with `satisfied: undefined` and
  payout `{yes:"0",no:"1"}` — a live cash-surface defect requiring NO
  pollution at all. `requireComparison`'s new vocabulary check refuses
  it at tip.

## Evidence highlights (reviewer-reproduced with different primitives)

- Census re-derived from the four `strictObject` schemas: 30 declared
  keys / 39 cells — matches exactly. All base-adopt cells flip at tip;
  the 3 absent-optional cells restore availability (base was
  fail-closed under an inherited window).
- Kill sets EXACT on all 14 mutants; the six corpus values each kill
  exactly one of the six measured single-group case drifts (the SETL-1
  residual said two; the recount's cause: the existing uppercase row
  was uppercase in groups 1 AND 5 at once).
- **Eight surviving mutants, all verified dead-by-ordering** by the
  reviewer's combo mutants (open-the-first-gate + revert-the-second-
  line): the four disclosed plus S4 (`evaluateReferenceOpenUpDown`'s
  `observationType` own read — refused earlier by
  `candidatePayoffModels`), the TWAP and THRESHOLD evaluator
  D1-identities (every field they read is REQUIRED; the up/down variant
  IS killed because its window fields are optional), and
  `observationOwnIssues`' no-table branch (only ever receives a
  validated model). The suite header now carries the full enumeration
  (`26a6959`).
- Value digest byte-identical base↔tip (both the implementer's 68-row
  corpus and the reviewer's independent serializers and separate
  100-row battery); strict digest differs on exactly the 17 D4 rows.
  Honest value-rule contracts (`SETTLEMENT_TIMESTAMP_INVALID`, window
  codes, decimal canonicality throws) byte-identical.
- Post-merge gates on main: root 290/6567 (reconciles both ways),
  check:deps 34/71, replay 6, trader 110, control-api 76, e2e 75,
  golden byte-identical.

## Residuals (owned)

- **Ordering-pin ambiguity (r1 F2, NOTE):** the pin's `comparison` case
  is satisfied by either gate (both emit
  `SETTLEMENT_SPEC_FIELD_REQUIRED`/`comparison`); the `windowSeconds`
  case does discriminate. Owner: SETL-2 follow-up test hardening.
- **`nonTerminalDetails` catch value unpinned (F3)**; **the
  `Array.prototype.includes` dependency in two value gates (F4** —
  base-identical wrong row exists WITHOUT pollution via F9's now-closed
  route; the remaining exposure needs a poisoned intrinsic**)**. Owner:
  SETL-2 follow-up hardening / an ADR-020 amendment line for the
  intrinsic class.
- **The spec is never materialized on the evaluation path (F5):** a
  caller-supplied Proxy with a descriptor trap can answer gates
  differently across reads (base-identical; emitted records stay
  self-consistent). Owner: the spec-door/SETL-1 line.
- **The `SettlementResult` envelope keeps `Object.prototype` and is
  unfrozen (F6)** — refusals and D4 records are null-proto/frozen; the
  envelope literal is not (base-identical; `toJSON` inheritance
  reaches `JSON.stringify(result)`). Owner: an errors.ts D4 follow-up.
- The "settlement spec" wording on rare observation-refusal details
  (disclosed; no consumer parses refusal strings). Accepted.
- The observation parse entry (`safeParseSettlementObservation`) if a
  wire caller ever appears — with the full grammar differential that
  implies. Owner: future grant.
- `packages/settlement/README.md` still describes payoff records as
  plain frozen objects — a docs-owner pass (out of the implementer's
  grant).

## Follow-ups (owned)

1. Docs round (orchestrator, combined with UNIV-3's when it closes):
   §3 settlement row narrows to fully CLOSED for both measured layers;
   §5 item 10 EXECUTED; the §2 class table gains the two measured
   facts (a frozen object-literal lookup answers `Object.prototype`
   for a non-declared key and turns a documented refusal into an
   escaping TypeError; a refusal detail computed by a zod parse is
   inside the ADR-020 containment amendment's blast radius); record
   F9 and the six-not-two case-drift recount.
2. SETL-2 follow-up hardening (F2, F3, F4) — opportunistic.
3. The settlement near-parallel-door count (now SIX in-package
   surfaces per the implementer's note) — the consolidation question
   stays with ADR-020 governance.
