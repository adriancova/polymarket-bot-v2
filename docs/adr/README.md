# Architecture Decision Records

Owner: `WP-030` (initial set). Path `docs/adr/**` is a global **protected path**
(`docs/spec/polymarket-bot-workplan.yaml` → `protected_paths`).

These records document decisions that are already **locked** by
`docs/spec/polymarket-bot-orchestrator-handoff.md` §2 and §20. Per handoff §20:

> ADRs document the locked decision and evidence. They are not an excuse to
> reopen every design choice.

An ADR may refine an implementation detail the handoff leaves open. It may not
silently override the handoff (`AGENTS.md`, Authority).

---

## Source precedence (handoff §1.1)

1. Current official Polymarket API documentation and current official SDK
   behavior — for **venue facts**.
2. This implementation handoff — for **product architecture and system
   invariants**.
3. Accepted ADRs in `docs/adr/`.
4. Versioned domain contracts in `packages/domain` and database migrations.
5. Executable tests and fixtures.
6. The original product design document — rationale and historical context.

Consequences for every ADR in this directory:

- **No ADR asserts a venue fact on its own authority.** Every venue statement
  cites `docs/venue/verified-2026-08-24.md` by section. That report is the
  in-repo authority for venue facts as of its verification date, and it is
  itself a dated snapshot that must be re-verified at the start of each
  implementation phase (handoff §1.2).
- Items the verification report marks **UNVERIFIED** (`U-n`) or as a
  **conflict** (`C-n`) are carried into the relevant ADR *as unverified*. They
  are never restated as settled behavior.
- An ADR that needs a venue fact the report does not contain records it as a
  gap for the next verification round. It does not fetch venue documentation
  and it does not guess.

**One narrow exception, added 2026-08-28 by `GOV-1B` and stated so it is not
re-derived case by case.** A **ratifying** ADR may record a venue fact that a
work package's own **mandated** verification obtained from *current official*
documentation — the case ADR-002 §8.3 created when it required `WP-070` to
confirm C-1/U-1 before `WP-150` could rely on it. This is not a weakening of the
rule above, and it is bounded by all four of:

1. **Handoff §1.1 already ranks current official documentation above the in-repo
   report**, so the ADR still asserts nothing on its own authority.
2. The record carries the **URL, the retrieval date, and verbatim quotes**, and
   distinguishes documentary confirmation from observation. An observational
   claim still requires real evidence (`AGENTS.md`).
3. The frozen report is **still cited** for the item's origin and prior status,
   and is **not edited** (`docs/contracts/protected-contracts.md` §2).
4. The **gap is still recorded** for the next verification round: a source the
   frozen report's index does not contain must enter the next dated report.

An ADR that merely *wants* a venue fact still does not fetch one.
[ADR-013](./ADR-013-book-price-change-absolute-size-confirmed.md) §7 is the
first use. The second is the 2026-09-02 amendment to
[ADR-009](./ADR-009-settlement-spec-and-payoff-model-selection.md) §5,
recording `WP-110`'s mandated 2026-08-28 confirmation of U-6 (the case
ADR-009 §5.2 itself created); its amendment block states how each of the four
conditions is met. The third is the 2026-09-03 amendment to
[ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) §7, resolving
conflict **C-2** (USDC vs pUSD denomination) — the case ADR-006 §7 item 4
itself created; it likewise walks all four conditions. That amendment also
records the one respect in which its fit is imperfect and which a reader
should not generalize from: item 4's mandate named `WP-200`, whose grant made
both the fetch and the amendment impossible, so the **contract owner executed
the same mandate in that package's place** rather than let it lapse. *(This
sentence previously read "the first and, so far, only use"; corrected
2026-09-02 per `protected-contracts.md` §4, and extended 2026-09-03.)*

---

## Index

| ADR | Title | Status | Primary handoff sections | Implemented by |
| --- | --- | --- | --- | --- |
| [ADR-001](./ADR-001-exact-decimal-representation.md) | Exact decimal representation | Accepted | §2, §6.1, §7.3 | `WP-020` (done) |
| [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) | Event envelope and ordering semantics | Accepted | §7.1, §7.4, §8 | `WP-020` (done), `WP-070`, `WP-120` |
| [ADR-003](./ADR-003-gateway-to-trader-transport.md) | Gateway-to-trader transport | Accepted | §2, §9.1, §4.2 | `WP-060` |
| [ADR-004](./ADR-004-wal-format-durability-and-compaction.md) | WAL format, durability, and compaction | Accepted | §9.1, §12.5 | `WP-050`, `WP-130` |
| [ADR-005](./ADR-005-strategy-purity-and-decision-result.md) | Strategy purity and `DecisionResult` contract | Accepted | §6.2–6.3, §7.5–7.7, §9.6 | `WP-020` (done), `WP-170` |
| [ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) | Actual ledger versus virtual allocation; §7 amended 2026-09-03 — C-2 (USDC vs pUSD) **resolved as a documentation inconsistency**, denominations stay distinct; §7 amended again 2026-09-04 (`GOV-2A`) — the deferred `WP-200` conformance ratification **closed against merged `7e75f9a`** on executed probes | Accepted | §6.7–6.8, §9.15, §9.16 | `WP-040`, `WP-200` |
| [ADR-007](./ADR-007-signed-order-idempotency-and-unknown-submissions.md) | Signed-order idempotency and unknown submissions | Accepted | §6.6, §9.11, §9.17 | `WP-260`, `WP-270`, `WP-290` |
| [ADR-008](./ADR-008-live-writer-fencing-and-heartbeat-health-lease.md) | Live-writer fencing and heartbeat health lease | Accepted | §6.16, §9.18, §4.2 | `WP-320`, `WP-330` |
| [ADR-009](./ADR-009-settlement-spec-and-payoff-model-selection.md) | `SettlementSpec` and payoff-model selection | Accepted | §9.2, §9.3, §6.9 | `WP-110` |
| [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) | Run-mode enablement and production key boundary | Accepted | §0.2, §11, §6.16–6.18, §15 | every package; gated by `WP-350`/`WP-370` |
| [ADR-011](./ADR-011-one-live-owner-per-market-policy.md) | One-live-owner-per-market policy | Accepted | §2, §6.11, §9.7 | `WP-040`, `WP-180` |
| [ADR-012](./ADR-012-simulation-fill-model-evidence-hierarchy.md) | Simulation fill-model evidence hierarchy | Accepted | §12.2–12.5, §17 | `WP-210`, `WP-360` |
| [ADR-013](./ADR-013-book-price-change-absolute-size-confirmed.md) | Book `price_change` carries absolute aggregate size, with zero removal (C-1/U-1 ratified) | Accepted | §9.4, §23, §1.1–1.2 | `WP-020` (done, unchanged), `WP-070` (done), `WP-150` |
| [ADR-014](./ADR-014-taker-side-names-the-aggressor-order-side.md) | `takerSide` names the aggressor order's own side | Accepted | §7.4 | `WP-020` (done, unchanged), `WP-070`/`WP-090` (conform), `WP-080` (follow-up owed) |
| [ADR-015](./ADR-015-repository-identifier-bound.md) | The repository identifier bound is boundary hardening, not a venue narrowing | Accepted | §7.2, §7.3, §8.3 | `WP-020` (done, unchanged), `WP-070` (done), every adapter |
| [ADR-016](./ADR-016-ratified-inferred-domain-shapes.md) | Ratification of the four unratified `domain.md` §8 inferences (R-3); §2 amended 2026-09-02 — external UUID-shaped input is **refused**, not case-folded (R-8) | Accepted | §7.2, §7.4, §14.4 | `WP-020` (done, unchanged); every future external input surface |
| [ADR-017](./ADR-017-dataset-manifest-and-retention-receipt-artifact-contract.md) | Dataset-manifest and retention-receipt artifact contract (two digest roles; `nullable` = Parquet repetition; strict-JSON profile; receipt = reporting, not proof) | Accepted | §8.4, §12.5, §10.2 | `WP-130` (done, unchanged) |
| [ADR-018](./ADR-018-app-local-esbuild-runtime-build-convention.md) | Workspace apps that must run use an app-local esbuild bundle (ESM default; CJS where a CJS-only dependency forces it) | Accepted | §2, §5 | `WP-120`/`WP-130` (done, unchanged); `apps/trader` and later apps |
| [ADR-019](./ADR-019-soak-evidence-threshold-policy.md) | Soak-evidence threshold: 24 contiguous hours, one window, no summing | Accepted | §16.7, §17 | `WP-140` (done, unchanged) |
| [ADR-020](./ADR-020-schema-parse-boundary-integrity.md) | A schema parse result is not clean data: every caller/wire-input boundary parses through a prototype-free door (`zod@4.4.3` reads its own state and the input's properties through the prototype chain) | Accepted | §6, §7, §7.5, §9.15, §11 | `WP-180`/`WP-190` conform; staged owners in [`docs/contracts/schema-boundary.md`](../contracts/schema-boundary.md) §5 |
| [ADR-021](./ADR-021-strategy-instance-id-is-a-uuidv7.md) | `strategyInstanceId` is an identity typed `Uuidv7Schema`; `packages/risk`'s `CodeString` typing was a mis-typing. DISCHARGED 2026-09-07: risk re-typed (`WP-180-FU3` `8c14b47`), the allocator door the original text missed (`ALLOC-1` `d9f70a6`), and the trader's intersection startup refusal replaced by the real `Uuidv7Schema` (`TRDR-1` `65ae56c` — a simultaneous widening and version/variant tightening; two dated amendments) | Accepted | §10.3 | resolves `WP-230` accepted residual 1 |

Companion contract documentation (not ADRs, same authority chain):

- [`docs/contracts/domain.md`](../contracts/domain.md) — the frozen `WP-020`
  domain and decimal contracts.
- [`docs/contracts/dependency-direction.md`](../contracts/dependency-direction.md)
  — the §5.2 dependency graph and its CI enforcement expectation.
- [`docs/contracts/schema-boundary.md`](../contracts/schema-boundary.md) —
  ADR-020's normative companion: the door definition, the measured classes at the
  pinned `zod`, the per-package audit at `main` `2d7e7da`, and the owner
  assignments.
- [`docs/contracts/protected-contracts.md`](../contracts/protected-contracts.md)
  — the protected-path policy, the ratification-precedent mechanism, and the
  consolidated register of open venue-fact items.

---

## Which change requires which ADR

Handoff §1.3 lists the changes that require an ADR *and* orchestrator approval.
Each row names the record that owns that decision today:

| Change (handoff §1.3) | Owning ADR |
| --- | --- |
| Changing the production language | none yet — handoff §2 locks TypeScript/Node 24; a change needs a new ADR |
| Replacing the official SDK with hand-written signing or an unofficial SDK | [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) (SDK boundary), [ADR-007](./ADR-007-signed-order-idempotency-and-unknown-submissions.md) (signing protocol) |
| Changing event ordering semantics | [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) |
| Changing numeric representation | [ADR-001](./ADR-001-exact-decimal-representation.md) |
| Allowing a strategy to perform I/O or submit orders directly | [ADR-005](./ADR-005-strategy-purity-and-decision-result.md) |
| Changing the ledger source of truth | [ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) |
| Allowing more than one active live strategy owner per market | [ADR-011](./ADR-011-one-live-owner-per-market-policy.md) |
| Changing the live-enablement mechanism | [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) |
| Adding a hot standby capable of order submission | [ADR-008](./ADR-008-live-writer-fencing-and-heartbeat-health-lease.md) |
| Removing any reconciliation, heartbeat, geoblock, or kill-switch control | [ADR-008](./ADR-008-live-writer-fencing-and-heartbeat-health-lease.md), [ADR-007](./ADR-007-signed-order-idempotency-and-unknown-submissions.md), [ADR-010](./ADR-010-run-mode-enablement-and-production-key-boundary.md) |

Two additional formats are ADR-gated by their own specification text:

- The WAL format — handoff §9.1 says "Append-only JSONL or another
  **ADR-approved** recoverable format".
  [ADR-004](./ADR-004-wal-format-durability-and-compaction.md) is that approval.
- The exact-decimal library — handoff §2.1 says "`decimal.js` (or an
  **ADR-approved** exact-decimal equivalent)".
  [ADR-001](./ADR-001-exact-decimal-representation.md) is that approval.

---

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `Proposed` | Drafted, not yet approved by the orchestrator. Not binding. |
| `Accepted` | Binding. Implementations must conform; a divergence is a defect or a new ADR. |
| `Superseded by ADR-NNN` | Historical. Kept verbatim; never edited to match the new decision. |
| `Deprecated` | No longer applies and has no successor. Requires a rationale. |

An accepted ADR is **not** edited to reflect a changed decision. It is
superseded by a new record, and its `Status` line is updated to point at the
successor. Corrections of fact (a broken link, a wrong section number, a
citation that does not support its claim) are made in place and noted in the
record's change log, because leaving a false citation standing is worse than an
edit.

Because `docs/adr/**` is a protected path, **any** change here — including a
supersession — needs orchestrator approval and a work package that owns the
path. See
[`docs/contracts/protected-contracts.md`](../contracts/protected-contracts.md).

---

## Numbering

ADR-001 through ADR-012 are reserved by handoff §20 for the titles listed there
and may not be renumbered or repurposed. New decisions take the next free number
from ADR-013 onward. A decision that refines an existing ADR is folded into that
ADR (under orchestrator approval) rather than given a number that competes with
it.

---

## Template

```markdown
# ADR-NNN: <Title>

- **Status:** Accepted
- **Date:** YYYY-MM-DD
- **Recorded by:** WP-NNN
- **Implemented by:** WP-NNN (state whether the implementation exists yet)
- **Supersedes / Superseded by:** none

## Context

Why the decision exists, and what the primary specification already locks.

## Decision

Numbered, testable statements. Each one is something an implementation can
conform to or violate.

## Consequences

What this costs, what it forecloses, and what breaks if it is changed later.

## Evidence

Every claim's source: handoff section, `docs/venue/verified-YYYY-MM-DD.md`
section, `docs/contracts/*.md` section, or `docs/handoffs/WP-NNN.md`.
Unverified venue items are listed here explicitly as unverified.
```
