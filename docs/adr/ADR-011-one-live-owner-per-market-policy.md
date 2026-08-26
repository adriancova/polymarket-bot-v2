# ADR-011: One-live-owner-per-market policy

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-040` (the database constraint), `WP-180` (capital
  allocator and risk gate), `WP-170` (runtime ownership and stable evaluation
  order) — **not yet implemented**
- **Supersedes / Superseded by:** none

## Context

Handoff §2 locks two related decisions: "One active live strategy owner per
market; no cross-strategy account netting in v1", and §6 invariant 11 states it
as an invariant: "One active live strategy owns a market in v1. Other strategies
may observe or run in shadow mode." Handoff §1.3 makes "allowing more than one
active live strategy owner per market" an ADR-gated change. Handoff §9.7 spells
out the allocator's posture: "V1 does not net opposing strategy intents. It
rejects conflicting live ownership and preserves independent shadow accounting."
§3.2 puts "Multi-strategy netting within one market" out of scope for the first
production release.

This ADR records the decision and, more usefully, the reasons it is a venue-level
constraint rather than a stylistic one.

## Decision

### 1. Exactly one live owner per market

At most one strategy instance may hold **live** ownership of a market at a time.
Other instances may:

- run in `SHADOW` mode (live data, simulated execution, independent accounting),
  or
- observe without emitting live intents.

Enforcement is layered, so a bug in one layer does not create real exposure:

1. **Database constraint** — "Only one active live owner per market" is a required
   constraint (§10.7), enforced in `WP-040`.
2. **Risk gate** — "Run and strategy state permit the intent" and the self-trade
   and duplicate-intent guards (§9.8 checks 1 and 18) reject an intent from a
   non-owner.
3. **Allocator** — conflicting live ownership is *rejected*, not merged (§9.7).

Shadow instances still evaluate, after the owner, in the stable order: market
ownership priority, then strategy instance priority, then strategy instance UUID
(§8.2). V1 prevents multiple live owners; shadow instances evaluating afterwards
is explicitly allowed (§8.2).

### 2. No cross-strategy netting in v1

Opposing intents from two instances are **not** netted (§9.7). Shadow accounting
is kept independent, so a shadow instance's simulated position never offsets the
owner's real position in any projection.

### 3. Why this is a venue-level constraint

The venue nets at the **account and signer** level. Every mechanism a second live
owner would touch is shared, and each is a verified venue fact:

| Shared resource | Verified fact |
| --- | --- |
| Collateral and inventory | Buying consumes pUSD; selling requires outcome-token inventory; every YES/NO pair is backed by exactly $1 of collateral through the CTF contracts (venue report §10.2). Two owners spend the same balance and the same tokens. |
| Rate-limit budgets | Per-signer **order and cancel token buckets**, with documented token costs and all-or-nothing batches — "A batch is admitted only when the bucket contains enough tokens for every entry" (venue report §8). Two owners contend for one bucket, and the loser's *safety cancel* is the one that fails. |
| Order heartbeat | `POST /v1/heartbeats` uses a **rotating ID**, and venue-side cancellation is scoped to the **CLOB API credentials**, not to a process (venue report §5). Two owners on one credential set cannot be told apart by the venue. |
| Self-trade exposure | Two owners quoting the same market on opposite sides trade against each other at the account level, paying taker fees for the privilege — fees are taker-only, `fee = C × feeRate × p × (1 − p)` (venue report §6). |

The venue therefore cannot enforce the separation for us, and it cannot even
report it: an order response, a trade event, and a position read all describe the
*account*, not the instance. Attribution is ours to compute (ADR-006), and the
cheapest way to keep it correct is to have exactly one live writer of intent per
market.

### 4. Relationship to fencing (ADR-008)

These are different constraints and both hold:

- **One live *writer* per account/signer** (ADR-008) is a **process**-level
  constraint enforced by a PostgreSQL lease and a monotonic fencing token.
- **One live *owner* per market** (this ADR) is a **strategy-instance**-level
  constraint enforced by a database constraint and the risk gate, *inside* the
  single fenced writer.

Satisfying one does not satisfy the other. A correctly fenced trader can still run
two live instances on one market; that is what this ADR forbids.

### 5. What ownership does not exempt

- **Attribution is still required.** One owner bounds *intentional* activity; it
  does not bound wallet-level activity from outside the trader. Unexplained
  activity still goes to `UNATTRIBUTED` and halts the market (§6 invariant 7,
  ADR-006).
- **Exposure limits still aggregate.** Per-market, per-series, per-underlying, and
  per-resolution-window exposure and worst-case contractual loss apply across
  instances (§9.7, §9.8 check 15), because the account is shared even when the
  market's owner is not.
- **Shadow instances still consume resources.** They evaluate, produce decisions,
  and write records; they do not consume venue rate limits, because they submit
  nothing.

### 6. Changing this requires an ADR plus a design

Allowing more than one live owner is ADR-gated (§1.3). A future ADR would need,
at minimum: a fill-attribution rule for an order that could serve two owners, a
netting policy, a self-trade prevention design, and a rate-limit arbitration
policy that preserves "safety cancellation outranks new order placement" (§6
invariant 13). Multi-strategy netting within one market and cross-account capital
allocation remain out of scope for the first production release (§3.2).

## Consequences

- **Capacity per market is bounded by one strategy.** A second promising strategy
  for the same series waits, runs in shadow, or takes a different series. Accepted
  for v1.
- **Shadow mode carries the research load.** Counterfactual comparison happens
  through `SHADOW` (§11) and decision-log analysis, not through parallel live
  instances. Stateful counterfactual PnL still requires a full deterministic
  replay (§12.6).
- **Ownership becomes an operational object.** Handover between instances is a
  real procedure — the incoming owner must not assume the outgoing owner's
  position, and the transition has to reconcile (§9.17). A quiet swap would
  produce exactly the kind of unattributed state §6 invariant 7 halts on.
- **The constraint must live in the database, not only in code.** A risk-gate-only
  enforcement fails open on a restart race; §10.7 requires the constraint, and
  that is deliberate.
- **This weakens no safety default.** It is a restriction; removing it later would
  be the loosening, and that is ADR-gated.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §1.3 — allowing more than one active live strategy owner per market requires an
  ADR and orchestrator approval.
- §2 — "One active live strategy owner per market; no cross-strategy account
  netting in v1"; "Exactly one fenced live order writer per account/signer".
- §3.2 — multi-strategy netting within one market, and cross-account capital
  allocation, are out of scope for the first production release.
- §6 invariants 7, 11, 13.
- §8.2 — stable strategy evaluation order; "V1 prevents multiple live owners of
  one market, but shadow instances may still evaluate after the owner."
- §9.7 — the capital allocator's exposure dimensions; "V1 does not net opposing
  strategy intents. It rejects conflicting live ownership and preserves
  independent shadow accounting."
- §9.8 — pre-trade checks 1 (run and strategy state permit the intent), 15
  (per-order, per-market, per-instance, per-series, per-underlying, and global
  limits), and 18 (self-trade and duplicate-intent guards).
- §9.17 — reconciliation triggers and the resume-only-after-invariants-pass rule.
- §10.3 — `strategy.instances` holds "Named deployments and ownership rules".
- §10.7 — required constraint: "Only one active live owner per market."
- §11 — `SHADOW` is "Simulated beside another run … Counterfactual comparison",
  with public-only credentials.
- §12.6 — stateful counterfactual PnL requires a full deterministic replay.

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §5 — the order-heartbeat protocol with ID rotation, and venue-side cancellation
  scoped to "all open orders owned by those CLOB API credentials".
- §6 — taker-only fees and the fee formula (the cost of an account-level
  self-trade). Snapshot of volatile program parameters.
- §8 — per-signer order and cancel token buckets, token costs, and all-or-nothing
  batch admission. Snapshot with effective date 2026-08-24.
- §10.2 — buying consumes pUSD, selling requires outcome-token inventory, and
  every YES/NO pair is backed by exactly $1 of collateral through the CTF
  contracts.

**Related records:**

- [ADR-006](./ADR-006-actual-ledger-versus-virtual-allocation.md) — why virtual
  attribution is required regardless of ownership.
- [ADR-008](./ADR-008-live-writer-fencing-and-heartbeat-health-lease.md) — the
  distinct process-level fencing constraint.

**Safety:** this ADR changes no run-mode default (ADR-010). It is a restriction on
live behavior that is itself currently unreachable
(`ALLOW_REAL_ORDERS=false`, both live caps `0`, no signer, no live gate
requested).
