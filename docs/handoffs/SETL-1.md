# SETL-1 completion record — The packages/settlement spec door

**Merged:** `af991ee` (`--no-ff`, 2026-09-07). Chain `e0fab62`
(candidate) → `24c6fd2` (remediation r1) on base `78ec81d`. Review r1:
CHANGES REQUIRED (1 HIGH blocker + 2 unpinned-defence findings + 1 LOW);
remediation r1; confirming pass by the same reviewer: **ACCEPT**
(0 remaining defects; NOTE residuals below).

**What it is.** GOV-2A §5 item 7's second HIGH grant. Probe N's row —
of `terminalSpotSpecSample()`'s 16 own keys, 14 required and ALL 14
adoptable from `Object.prototype`, with an adopted `verification`
clearing both activation gates — is closed by a package-local D1–D4
door (`spec-door.ts`) wired into `safeParseSettlementSpec`/
`parseSettlementSpec` and the activation path. Census correction on the
record: the 14 = 12 shape-required + 2 (`comparison`, `strikeSource`)
required by the payoff-model compatibility rule. Narration correction:
the §3 row's literal shape (`{status:"VERIFIED"}` alone on the
prototype) refuses at base for missing reviewer fields; the two shapes
that DO land VERIFIED-from-nothing at base are both closed at tip,
end-to-end through `isReviewedSettlementSpec`, both activation gates
(`activation.ts:145,159`), and the registry call site
(`registry.ts:252`). No settlement→risk edge; no mirrored-body copy;
`index.ts` byte-unchanged from base (public surface untouched).

## The review arc (the round that earned its keep)

- **r1 (CHANGES REQUIRED):** the shipped closures all held — the
  reviewer reproduced the 16-key sweep with a third primitive, found no
  route to VERIFIED or an activation gate at tip, and corroborated
  honest verdicts with an independent 705-row digest. The blocker was
  **B1**: the D2 compensation's hand-written ISO form never bounded the
  offset's hour/minute, so under inherited `skipChecks` the door
  ADMITTED a VERIFIED spec the schema refuses (`+24:00`, `+99:99`, …)
  and it activated — a falsified "every rule" claim failing OPEN. B2/B3
  (HIGH/MED): the accessor guard and the outer `reviewContext` own read
  were load-bearing but unpinned — one-token reverts restored
  VERIFIED-from-nothing with 543/543 green. N1: the public
  `rulesVersionId` own read unpinned.
- **Remediation (`24c6fd2`):** B1 fixed IN BOTH DIRECTIONS — the
  reviewer's fail-open half AND a self-found fail-closed half that was
  live in a CLEAN process (the old form made seconds mandatory and its
  `Date.UTC` round-trip mapped years 0000–0099 to 1900+, refusing nine
  schema-valid spellings at the reviewed candidate). The form is now
  recomposed from zod's own sub-patterns, and every re-implemented
  grammar (verifiedAt, settlementSpecId, referenceSymbol, specVersion,
  roundingRule, verifiedBy) is held to the schema's own verdict by a
  DIFFERENTIAL sweep, clean and under `skipChecks`, with per-field
  non-vacuity — a zod upgrade that moves a grammar fails the suite.
  All four pins added.
- **Confirming pass (ACCEPT):** the reviewer's independent 897-row
  digest (all 58 verifiedAt spellings) is BYTE-IDENTICAL between true
  base and tip — and showed 27 differing rows at the mid candidate,
  independently establishing both halves of B1. All thirteen mutants
  kill (the five remediation mutants exactly 1 each; the original eight
  with growth in the claimed directions). Ten grammar-drift
  spot-attacks: eight killed including all three fail-closed
  off-by-ones (the both-directions property is real); two single-group
  case-widening drifts survive (NOTE residual, one corpus value closes
  it). The reviewer also recorded its own r1 method gap (a single-value
  verifiedAt corpus) — future door reviews sweep the grammar corpus of
  every re-implemented pattern.

## The record reversal (adjudicated; quote it precisely)

The implementer retracted its round-1 claim that zod@4.4.3's
`optin`/`optout` required-key waiver does not reach a
`.superRefine`-carrying schema — the r1 probe harness warmed the schema
first. The confirming pass adjudicated the CORRECTED claim right, with
two refinements that govern how the fact is used: **the waiver reaches
`SettlementSpecSchema` on COLD parses only, and it is DURABLE** (a
schema whose first parse ran under the pollution stays waived after the
pollution is removed; a schema warmed on an honest parse first is
immune). The r1 suite contained no false assertion — the defect was a
comment's inference; and the correction ran against the implementer's
own interest, making the D2 compensation MORE load-bearing (the
presence pin is now killed end-to-end, M8 1→2).

## Residuals (owned)

- **The observation/evaluation door** (r1 claim 7, twice verified):
  `evaluateSettlement` dot-reads `spec.referenceSymbol`/
  `observation.model`/`observation.referenceSymbol`;
  `selectPayoffModel` → `checkPayoffModelCompatibility` destructures
  caller-supplied views; `SettlementObservationSchema` has no door.
  Owner: a settlement observation/evaluation grant.
- **Cold-lazy poisoning contained, not cured:** enumerable pollution
  during a cold first parse durably poisons the raw schema (later CLEAN
  parses throw); the door converts this to clean refusals — fail-closed
  availability, curable only by D2. Owner: governance / ADR-020.
- **Three measured zod facts for the §2 class table** (docs round): the
  cold-only durable waiver (above, with the warm-first immunity); the
  cold-`discriminatedUnion` `propValues[key].add` throw triggered by an
  inherited `status` — the same key a verification attack sets; durable
  poisoning persisting after pollution removal.
- One corpus value closes the single-group case-drift gap
  (`settlementSpecId` differential). Owner: SETL-1 follow-up,
  opportunistic.
- r1 N3 (settlementRefusal's `Object.keys` drops non-enumerable own
  detail keys): left alone with an argued call — a `Reflect.ownKeys`
  filter would move MORE caller-controlled keys into refusal details.
  All 30 in-package call sites pass literals.
- Carried: five near-parallel door implementations; arrays keep
  `Array.prototype`; the emitted spec frozen + null-prototype (no repo
  consumer mutates one).

## Follow-ups (owned)

1. Combined docs round (orchestrator, with UNIV-1's): §3 settlement row
   + §5 item 7 EXECUTED; the census and narration corrections; the §2
   class-table entries.
2. The observation/evaluation grant.
3. The corpus value; the D2 question stays with ADR-020 governance.
