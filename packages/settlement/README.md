# `@polymarket-bot/settlement` — settlement specs and payoff models

Owner: `WP-110`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §9.3 (with §9.2,
§6 invariant 9), [ADR-009](../../docs/adr/ADR-009-settlement-spec-and-payoff-model-selection.md),
[ADR-001](../../docs/adr/ADR-001-exact-decimal-representation.md)
Layer: 1 (`docs/contracts/dependency-direction.md` §2) — depends on
`@polymarket-bot/domain`, `@polymarket-bot/decimal`, `zod`, and nothing else.

---

## 1. What this package decides

| Question | Answer lives in |
| --- | --- |
| What is a settlement spec, and is this one well-formed? | `spec.ts` |
| Which payoff model settles this spec — and which may not? | `models/compatibility.ts`, `models/registry.ts` |
| What does one share redeem for in each outcome state? | `payout.ts` |
| May a model-dependent strategy be activated on this series? | `activation.ts` |

It performs no I/O, reads no clock, and holds no state. Every function is a pure
function of its arguments, which is what makes a replayed settlement reproduce a
live one exactly (handoff §12.4).

## 2. U-6 — the venue re-verification this package was gated on

ADR-009 §5 and `docs/contracts/protected-contracts.md` §8 recorded item **U-6**
as NOT CONFIRMED: the 50/50 resolution outcome and post-open on-chain
clarification were handoff-asserted, and
`https://docs.polymarket.com/concepts/resolution` had not been captured.
`WP-110` was required to verify it before implementing settlement specs.

**Outcome: U-6 is CONFIRMED.** Source
`https://docs.polymarket.com/concepts/resolution`, retrieved **2026-08-28**
(HTTP 200; the same page was retrieved in both its rendered and Markdown forms).
Verbatim:

> | **Unknown/50-50** | Neither outcome applicable (rare) | Market resolves
> 50/50 — each token redeems for \$0.50; disputer gets bond back + half of
> proposer's bond |

> **Winning tokens** become redeemable for \$1.00 each

> **Losing tokens** become worthless (\$0.00)

> In rare cases, unforeseen circumstances require clarification of the rules
> after trading begins. Polymarket may issue an **"Additional context"** update
> that proposers and voters should consider during resolution.

> Clarifications:
>
> * Cannot change the fundamental intent of the question
> * Are published onchain via the bulletin board contract
> * Should be considered by UMA voters when resolving disputes

Supporting, from `https://docs.polymarket.com/concepts/positions-tokens`
(retrieved 2026-08-28):

> Outcome tokens are always fully backed. Every Yes/No pair in existence is
> backed by exactly `$1` of pUSD collateral locked in the CTF contract.

Both halves of U-6 are therefore venue-verified as of 2026-08-28: the 50/50
outcome exists and pays \$0.50 per token, and post-open clarifications exist and
are published on-chain. This is a DATED snapshot — handoff §1.2 requires
re-verification at each phase gate — and the register entry is the
orchestrator's to close; this package does not edit
`docs/contracts/protected-contracts.md`.

### 2.1 What the same pass did NOT confirm

- **`CANCELLED` has no documented venue mechanic.** The resolution page
  documents exactly three redemption outcomes — winning (\$1.00), losing
  (\$0.00), and 50/50 (\$0.50 each) — and describes no cancellation, void, or
  refund path. `CANCELLED` remains in the §9.3 state vocabulary (and in the
  frozen `MarketResolved` terminal subset), but `payoutPerShare("CANCELLED")`
  REFUSES with `SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED` rather than inventing a
  refund rule.
- **No documented dispute EVENT.** The page documents a dispute PROCESS (a
  \$750-bond proposal, a 2-hour challenge period, a debate period, a UMA DVM
  vote). The Gamma market schema exposes a nullable `umaResolutionStatus`
  string, but its value vocabulary is not documented anywhere retrieved, so
  nothing here parses it. ADR-009 §4's condition for adding a `MarketDisputed`
  event ("if the venue publishes an explicit dispute transition") is therefore
  NOT met, and `DISPUTED` stays an operator-recorded state in
  `@polymarket-bot/universe`.

## 3. The spec

`SettlementSpecSchema` carries every §9.3 field; the module header in `spec.ts`
maps each one to its `catalog.settlement_specs` column. Two decisions are worth
repeating here:

- **`verification` is a discriminated union**, not two nullable fields. A spec
  that claims `VERIFIED` without a reviewer, or names a reviewer while claiming
  to be unverified, cannot be constructed. This mirrors WP-040's
  `settlement_specs_verification_complete` check.
- **Rule text may not be a placeholder.** ADR-009 §5.4: "'Halt and escalate' is
  a legitimate policy; 'unspecified' is not." `SettlementRuleTextSchema`
  normalizes case, whitespace and punctuation and then refuses punctuation-only
  values (`???`, `- - -`), semantic placeholder phrases (`to be determined`,
  `not specified`, `N / A`, `T.B.D.`, and the rest of
  `PLACEHOLDER_RULE_TEXTS`), and placeholder PREFIXES
  (`TBD - complete after review`; see `PLACEHOLDER_RULE_PREFIXES`), tightened
  in remediation round 1 (finding M1). It also refuses leading/trailing
  whitespace so one rule has one representation.

### 3.1 The parse door (ADR-020 §3; `schema-boundary.md` §3, probe N)

A `zod` parse result is not clean data. `docs/contracts/schema-boundary.md` §3
measured this package's boundary as **LIVE, HIGH**: of the sixteen own keys of
`terminalSpotSpecSample()`, fourteen are required and all fourteen were
supplied from `Object.prototype` when the input lacked them — including
`resolutionSource` (a spec settling against a source its own text never named)
and `verification`, where a spec carrying **no verification key at all** parsed
as reviewed, cleared both activation gates, and had `evaluateSettlement` stamp
`reviewed: true` on the number it produced.

`spec-door.ts` is this package's door and its header states what it performs:

- **D1** materialize prototype-free from own DESCRIPTORS before any parse;
- **D2 NOT performed, disclosed** — a severed warmed arena lives in
  `packages/risk` and reaching it needs an edge `dependency-direction.md` does
  not permit, while copying it is forbidden by the repository-wide deletion
  guard. The compensation is measured: `settlementSpecOwnIssues` and
  `ownCrossFieldIssues` in `spec.ts` re-state **every** rule the schema
  declares — presence, type, bounds, vocabulary, UUID/ISO form, the ADR-009
  §5.4 placeholder matcher and the §9.3 model-compatibility rules — on the
  door's own reads, so the boundary still refuses with every `zod` check
  switched off by an inherited `skipChecks`, and still refuses a spec with a
  required key deleted when a COLD schema's required-key enforcement is waived
  by an inherited `optin`/`optout` pair. The re-implemented grammars (UUIDv7,
  the code string, the ISO instant, the integer and length bounds) are held to
  the schema by a DIFFERENTIAL sweep — the door's verdict must equal the
  schema's on every case, in both directions — because review round 1 found the
  hand-written `verifiedAt` grammar wrong both ways at once: it admitted an
  offset of `+24:00` under `skipChecks` (activating `REVIEWED_MODEL_BACKED`)
  and refused the schema-valid `2026-08-28T00:00Z` and `0050-06-15T…` in a
  clean process;
- **D3** every emitted value comes from the materialized tree, and every
  decision-bearing read in the activation path (`input.spec`,
  `input.reviewContext`, `verification.status`, `rulesVersionId`,
  `publishedWindowSeconds`) is an OWN read rather than a dot access;
- **D4** the spec, its `verification` block, every refusal and the activation
  verdict are emitted with a null prototype.
- The refusal CONSTRUCTION is contained (ADR-020's 2026-09-06 amendment):
  before the door, an inherited `_zod`, `path` or `value` made
  `safeParseSettlementSpec` — documented not to throw — throw a `TypeError`.

`prototype-boundary.test.ts` is the regression net: the fourteen-key sweep in
both pollution variants, over all four sample specs; the VERIFIED-from-nothing
route pinned end to end through `isReviewedSettlementSpec`, both activation
gates and the `registry.ts` call site; the containment; D4; and the
`skipChecks` census. **Deployment reading:** nothing on the wire can write
`Object.prototype` — every one of these needs code already executing in the
process. The row says the check is not load-bearing against an attacker already
inside the process, not that a caller can turn it off.

## 4. Model selection (§9.3, acceptance 1)

The matrix in `models/compatibility.ts` is total over 5 observation types × 4
models, and `compatibility.test.ts` walks all 20 cells:

|  | TerminalSpotBinary | TwapBinary | ReferenceOpenUpDown | ThresholdByDate |
| --- | --- | --- | --- | --- |
| `TERMINAL_SPOT` | yes | no | yes | yes |
| `TWAP` | **no (§9.3)** | yes | yes | no |
| `VWAP` | no | no | no | no |
| `EVENT_RESULT` | no | no | no | no |
| `MANUAL_ORACLE` | no | no | no | no |

Two independent gates keep a terminal-spot model away from a TWAP-settled
market:

1. `SettlementSpecSchema` refuses the combination at construction, with the
   dedicated code `SETTLEMENT_TWAP_TERMINAL_SPOT_FORBIDDEN`, so the invalid spec
   is unrepresentable past validation;
2. every observation is TAGGED with the model that consumes it, so a
   terminal-spot reading cannot be handed to a TWAP spec even when the spec is
   correct.

The three empty rows are ADR-009 §2: an observation type with no implementing
model yields a spec that cannot be activated, not an invitation to approximate.

## 5. Payouts

Exact decimal strings only (§6 invariant 1, ADR-001): `1`, `0`, `0.5`, and exact
multiplication for a share count. Two properties are asserted over generated
share counts — a 50/50 position is exactly half the shares (checked by doubling
it back), and a YES/NO pair sums to exactly the share count in every terminal
outcome, which is the \$1-backing statement above restated as arithmetic.

Non-terminal states (`PENDING`, `PENDING_CLARIFICATION`, `DISPUTED`) refuse a
payout: ADR-009 §4 — a dispute is an in-flight process, not an outcome.

## 6. The activation gate (§9.2, acceptance 3)

`classifySettlementActivation` returns one of seven statuses, exactly one of
which permits model-dependent activation. A spec that CLAIMS a review is
re-checked against the conditions that must have held when it was signed
(`settlementSpecReviewBlockers`), because a feed's published windows can change
under a spec that was correct when signed (ADR-009 §6).

The published TWAP windows are NOT hardcoded as truth: the caller passes the
current list, and a windowed spec with no list supplied is BLOCKED rather than
waved through. `RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24` is exported as a
dated snapshot of `docs/venue/verified-2026-08-24.md` §10.3.

`@polymarket-bot/universe` consumes the verdict through a structural port; the
two packages share a layer and no `dependency-direction.md` §2.1 row permits an
edge between them, so neither imports the other.

## 7. Known asymmetries with the WP-040 migration

Recorded here because a future integrator will hit them:

1. **`catalog.settlement_specs.payoff_model` is `NOT NULL`,** but ADR-009 §2
   says an observation type with no implementing model still yields a spec. This
   package makes `payoffModel` OPTIONAL for exactly that case, so a `VWAP`,
   `EVENT_RESULT`, or `MANUAL_ORACLE` spec cannot currently be persisted by
   migration `0002`. Reported as follow-up in `docs/handoffs/WP-110.md`; the
   migration is not this package's to change.
2. **This package is stricter than the columns.** `timestamp_boundary`,
   `rounding_rule`, `fallback_source`, `dispute_policy`, and
   `clarification_policy` are nullable in SQL and REQUIRED here, per ADR-009
   §5.4. A legacy row with a null policy will not parse — which is the intended
   direction: it is not a reviewed spec.

## 8. Why these vocabularies live here

`packages/domain` is frozen (`docs/contracts/domain.md` §9) and contains no
settlement-spec contract; adding one would need an ADR. The observation type,
comparison operator, payoff model, and verification status enums are therefore
declared here and match WP-040's PostgreSQL enums member for member, so a
persisted row and an in-memory spec cannot disagree. The outcome-state
vocabulary is NOT redeclared: it is re-exported from the frozen domain package.
