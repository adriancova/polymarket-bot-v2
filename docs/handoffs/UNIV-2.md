# UNIV-2 completion record — The packages/universe registration and envelope doors

**Merged:** `f90ff05` (`--no-ff`, 2026-09-07). Candidate `60cefc3` (one
commit) on base `989d41d`. One review round: ACCEPT (0 blockers; 2 MEDIUM
base-identical with owners, 3 LOW, 5 NOTE). The implementing agent was
rate-limit-killed mid-implementation and resumed via SendMessage with its
worktree intact (correct-model resume policy); its scratch probes were
removed before the single commit.

**What it is.** GOV-2A §5 items 9(a)+(b), both measured by UNIV-1's
review. Three new package-local modules — `caller-door.ts` (D1/declared-
read/D4/containment machinery on `lifecycle-door.ts`'s primitives),
`registration-door.ts`, `envelope-door.ts` — now stand in front of
`registerSeries`, `approveSeries`, `registerMarket`, `bindMarketToSeries`,
`recordMarketParameters`, `applyMarketEvent`, `recordMarketOutcomeState`,
`requireMarket`, and `marketLifecycleInputFromEnvelope`. The
ghost-approval route (an inherited `{approved:true, approvedBy:"ghost"}`
binding registering, approving, and binding a series through a review
that never happened) refuses `UNIVERSE_INPUT_INVALID` end-to-end, both
pollution variants. A whole market was registrable at base from
`registerMarket({})` plus inherited identity+parameters — closed. The
envelope door closes UNIV-1's disclosed upstream residual: an
envelope-layer adoption no longer arrives at the lifecycle door as a
genuine own key (inherited `payload.outcome` → RESOLVED at base; the
composition is pinned END-TO-END at tip). `lifecycle-door.ts` changed
only by the `dataDescriptor` → `ownDataDescriptor` rename+export
(orchestrator-inspected line by line; its 46 tests byte-identical and
green — the `appendData` precedent). Item 9(c), the state-side round, was
explicitly out of grant and remains open.

## Evidence highlights (reviewer-reproduced with different primitives)

- Censuses derived in-suite from the frozen schemas (series 9, identity
  7, envelope 17 — one signature across all 8 lifecycle contracts,
  observation 3 + snapshot 8, four interface-derived input records) and
  ALL re-derived independently by the reviewer: no missing key.
- The reviewer's accessor-counter primitive: the doors invoke 0 inherited
  getters at tip (base 1–5 per call). A 260-cell behavioural sweep plus a
  248-cell landing differential (state-under-pollution vs clean): base
  123 state-divergences + 60 escaping throws; tip 10 divergences, all in
  `parameters.ts`'s output side and ALL present at base.
- Kill sets exact over the full 341-test package suite (M1 21, M3a 1,
  M3b 8, M3c 1, M6 6, M8 1; M7 census-drift killed on all 8 single-field
  deletions). The reviewer's neighbour mutant (swallow
  `UniverseValidationError`) killed by 6 — the parameters throw contract
  is genuinely pinned.
- Verdict digest byte-identical base↔tip (`96c27ba1…`); value-digest
  differences fall exactly into the three disclosed classes (D4
  null-prototype, own-`undefined` collapse, frozen descriptors).
- Post-merge gates on main: root 287/6462, check:deps 34/71, replay 6,
  trader 9/110, control-api 7/76, e2e 6/75, frozen golden
  `dd6893bf…263d95` byte-identical.

## Residuals (owned)

- **r1 MED-1 — `parameters.ts` output-side adoption** (an absent optional
  answered from the prototype corrupts `changedParameters` on the
  returned version AND the `TradingParametersChanged` payload;
  base-identical). The reviewer sharpened the module header's "loss
  class" wording: it is an adoption/gain class on a result surface.
  Owner: the item 9c state-side round.
- **r1 MED-2 — the `skipChecks` observation defeat** (inherited
  `skipChecks` admits `tickSize:"-9"` into an immutable recorded
  parameter version; base-identical; D2 not performed — no severed arena
  reachable without a forbidden edge). Owner: item 9c / ADR-020.
- **r1 LOW — unjudged review facts:** `bindMarketToSeries` stores a
  caller's own `approvedBy` unguarded (123, `{a:1}`); `registerMarket`
  passes own `metadataVersion` values the payload schema itself would
  reject into the projection and the emitted `MarketDiscovered` payload.
  Base-identical. Owner: item 9c (validation question disclosed, not
  decided).
- **r1 LOW — `ingestSeq` asymmetry:** the envelope door re-states the
  unsigned-integer grammar (because `BigInt()` throws) but
  `registration-door.ts`'s `openLifecycleEventInput` does not — a missing
  or float `ingestSeq` still throws OUT of `applyMarketEvent`
  (base-identical without pollution). Owner: item 9c (newly assigned —
  the reviewer flagged the missing owner).
- **r1 LOW — permanence undisclosed:** the cold-`discriminatedUnion`
  cache poisoning is contained to typed refusals but PERMANENT for the
  process (base is equally bricked, throwing). Fail-closed availability.
  Owner: ADR-020 governance — the same class as SETL-1's.
- r1 NOTE: `caller-door.contained` and the envelope D3 step are
  defence-in-depth with no live trigger today (M8's kill is shape-only;
  M3a's is unit-only — zero escapes in the reviewer's 252-cell battery);
  one equivalent mutant (`hasOwn`→`in` on already-materialized trees);
  the own-`undefined` collapse spans all six optional keys with zero
  distinguishing consumers repo-wide; emitted/stored records now frozen
  (a third digest class, no mutating consumer found); own accessors on
  caller records now refuse where base invoked them (fail-closed).

## Follow-ups (owned)

1. Docs round (orchestrator, combined with CLOB-1's): flip the §3
   universe registration half to CLOSED, tally, §5 items 9a+9b EXECUTED;
   record the residuals and the MED-1 wording sharpening.
2. **Item 9c — the state-side round** now carries: UNIV-1's MED-1/MED-2/
   LOW-2/LOW-3/NOTE-2 plus this round's MED-1 (parameters output side),
   MED-2 (skipChecks observation), both LOW validation questions, and the
   `ingestSeq` re-statement.
3. The D2/severed-arena and permanent-poisoning questions stay with
   ADR-020 governance (now measured in THREE packages: settlement,
   universe registration, and the CLOB half pending review).
