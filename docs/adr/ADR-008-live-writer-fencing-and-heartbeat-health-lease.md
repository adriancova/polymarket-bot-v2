# ADR-008: Live-writer fencing and heartbeat health lease

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-320` (fencing lease, heartbeat health lease, geoblock,
  kill controls), `WP-330` (independent emergency CLI), `WP-040` (the
  `ops.fencing_leases` table and the live-order constraint) — **not yet
  implemented**
- **Supersedes / Superseded by:** none

## Context

Handoff §2 locks "Exactly one fenced live order writer per account/signer" and
"Supervisor restart and independent cancel utility; **no order-submitting hot
standby in v1**". Handoff §6 invariant 16 states it as an invariant: "Live order
authority is fenced. Only the holder of the current account fencing token may
submit or refresh heartbeats." Handoff §9.18 gives the mechanism and rules out
the obvious shortcut: "**Redis is not sufficient as the only fence.** Use a
PostgreSQL advisory lock or lease with a monotonic fencing token persisted with
every live submission."

Handoff §1.3 makes "adding a hot standby capable of order submission" and
"removing any reconciliation, heartbeat, geoblock, or kill-switch control"
ADR-gated changes.

The venue side makes this sharper than a generic leader-election problem, in two
ways recorded in `docs/venue/verified-2026-08-24.md` §5. The order heartbeat uses
a **rotating identifier**, so the heartbeat itself is a single-writer resource.
And venue-side cancellation is scoped to the **CLOB API credentials**, not to a
process — so the venue cannot tell two of our processes apart, and the isolation
has to be ours.

## Decision

### 1. PostgreSQL owns the fence; Redis does not

The fence is a **PostgreSQL advisory lock or lease row** carrying a **monotonic
fencing token**, persisted with every live submission (§9.18). The lease lives in
`ops.fencing_leases` (§10.6), and **every live order references a valid fencing
token** as a database constraint (§10.7).

Redis holds hot coordination — streams, kill-switch state, health-lease state —
and is explicitly **not** sufficient as the only fence (§2, §9.18). A Redis-only
fence can be lost and reacquired across a partition without the store noticing;
a monotonic token in the same transactional store that records the order is what
makes a stale writer's submission rejectable after the fact.

**Monotonic means monotonic.** A token is never reused, never decremented, and is
allocated by the same store that records live orders, so a late write from a
previous holder is detectable rather than merely improbable.

### 2. Only the token holder may submit or heartbeat

Both actions are gated on the current token (§6 invariant 16, §9.18). A process
that lost the lease must stop both immediately, including any in-flight retry
loop.

**Two live writers cannot both hold authority** (work-plan `WP-320` acceptance),
and **paper mode cannot acquire a live fencing lease at all** (same acceptance
criterion, and ADR-010).

### 3. The health lease is a lease on *health*, not on liveness

The heartbeat health lease requires recent proof from **market data, user data,
event loop, OMS, database, reconciler, and kill-switch state** (§9.18). A process
that is alive but unhealthy **must stop heartbeats** (§9.18).

This inverts the usual failure default deliberately: the safe state is "the venue
cancels our resting orders", so losing the ability to prove health must *cause*
that, not be papered over. Handoff §4.2 states the same thing from the other
direction — a PostgreSQL outage stops new trading decisions and order submission,
"Heartbeats stop, causing venue-side cancellation of open orders" — and a trader
crash "must stop the order heartbeat and must not leave an order-submitting
standby active."

### 4. Venue heartbeat mechanics (as verified) and what they imply

From venue report §5:

- Endpoint `POST /v1/heartbeats`, with **ID rotation**. Bootstrap by sending an
  empty `heartbeat_id` (`{"heartbeat_id":""}`); the response returns a new
  identifier, and "each successful response returns a new ID to use for the
  following heartbeat".
- Cadence: **send every 5 seconds**. If a valid heartbeat is not received within
  **10 seconds**, all open orders owned by those CLOB API credentials are
  canceled. The cancellation check runs every 5 seconds, so venue-side
  cancellation can occur up to ~5 seconds after the timeout.
- An invalid or expired ID returns **400** with
  `{"error_msg": "Invalid Heartbeat ID", "heartbeat_id": "<expected>"}`; the
  client recovers by sending a fresh request using the supplied expected ID.

Three binding consequences:

1. **The rotating heartbeat ID is part of the lease state.** Two processes
   heartbeating the same credentials would invalidate each other's IDs and could
   thrash the venue-side timer. The current heartbeat ID is therefore owned by the
   fencing-token holder and persisted alongside the lease, so a failover can
   either resume with the persisted ID or bootstrap cleanly with an empty one.
2. **The health-lease evaluation budget is bounded by the cadence.** With a
   5-second send cadence and a 10-second venue timeout, the full health check
   must complete well inside 5 seconds, or the heartbeat is late for reasons
   unrelated to health. This is a design constraint on `WP-320`, not a tuning
   preference.
3. **Cancellation is credential-scoped, so credential sharing defeats
   isolation.** The venue cancels orders "owned by those CLOB API credentials".
   Running two processes on one credential set is therefore indistinguishable to
   the venue, and only our fence prevents it.

An invalid-ID 400 is a **recoverable protocol state**, not a health failure: the
client re-sends with the expected ID. But repeated invalid-ID responses are
evidence of a second writer and must raise a live-fencing-conflict alert (§14.4
pages on "Live fencing conflict").

### 5. No order-submitting hot standby in v1

A standby may exist for failover *readiness* but may not submit orders or send
heartbeats while another holder is live (§2, §4.2). Adding one requires a new ADR
(§1.3).

The supported high-availability posture is: supervisor restart, plus an
**independent cancel utility** (§2).

### 6. The independent cancel path must not depend on the trader

The emergency CLI can cancel **without relying on trader memory** (§9.18) and
**`cancel-all` must use only current credentials and venue truth; it must not
require the trader database to be healthy** (§14.2). Required commands include
`cancel-order`, `cancel-market`, `cancel-all`, `account-snapshot`, `reconcile`,
`stop-heartbeat`, and `geoblock-check` (§14.2).

The venue supports this directly: `DELETE /order`, `DELETE /orders` (1–3,000 ids,
duplicates ignored), `DELETE /cancel-market-orders`, and `DELETE /cancel-all`
(no body), all returning `{"canceled": [...], "not_canceled": {"<id>": "<reason>"}}`
(venue report §5). `not_canceled` entries must be surfaced, not summarized away —
a partial cancel is exactly the state an operator needs to see.

Where practical, independent cancel credentials are protected separately from the
main service runtime (§15).

### 7. Geographic eligibility is part of the live gate

Before any real order the live adapter performs the venue's current
geographic-eligibility check and **fails closed on ambiguity** (§0.2, §6 invariant
18, §9.12). A blocked, close-only, failed, or ambiguous result prevents new live
entries (§6 invariant 18; work-plan `WP-320` acceptance "Ambiguous geoblock result
blocks new live entries").

Verified mechanics (venue report §10.1): the check is
`GET https://polymarket.com/api/geoblock` — served from `polymarket.com`, **not**
the CLOB API hosts — returning `{"blocked": bool, "ip": string, "country": string
(ISO 3166-1 alpha-2), "region": string}`. Three restriction tiers were documented
as of 2026-08-24: an OFAC complete block (positions cannot even be closed), a
regulatory close-only tier enforced on frontend **and** API, and a close-only tier
enforced on frontend only. Tier membership is a **volatile snapshot** and must be
re-read, never hardcoded.

Note the asymmetry this creates: "close-only" is not "blocked". A close-only
result must permit protected reduction and redemption paths while blocking new
entries — collapsing both to a single boolean would either strand a position or
open a forbidden one.

### 8. Kill switches outrank everything

Kill-switch scopes are `GLOBAL`, `ACCOUNT`, `MARKET`, `STRATEGY_INSTANCE`, with
actions `HALT_NEW_ENTRIES`, `CANCEL_ALL`, `CANCEL_MARKET`,
`MANAGE_POSITIONS_ONLY`, `FULL_HALT` (§14.1). Every change is **append-only
audited with actor, reason, timestamp, prior state, and resulting state** (§14.1,
`ops.kill_switch_events` §10.6).

Kill-switch state is one of the required health-lease inputs (§9.18): a process
that cannot read kill-switch state cannot prove it is allowed to trade, so it
stops heartbeating.

**Removing any of these controls requires an ADR** (§1.3).

## Consequences

- **Losing PostgreSQL loses trading, on purpose.** The fence and the health lease
  both depend on it, so a database outage stops submissions and heartbeats and the
  venue cancels resting orders. That is the designed fail-safe, and it means
  PostgreSQL availability is a trading-availability dependency.
- **Failover is not instant and must not be.** A new holder must acquire a higher
  fencing token, prove health across all seven inputs, and reconcile before
  submitting (§9.17). Fast failover that skips reconciliation would reintroduce
  exactly the duplicate-exposure risk ADR-007 exists to prevent.
- **The heartbeat is stateful, so failover carries state.** The rotating ID must
  be persisted with the lease or bootstrapped from empty; a failover that assumes
  a stateless heartbeat will fail its first request with a 400.
- **Credential sharing is a fencing bypass.** Because venue cancellation is
  credential-scoped, a second process with the same credentials is invisible to
  the venue. Operational procedure, not code, has to prevent it — which is why
  repeated invalid-ID 400s must page.
- **The ~5-second cancellation-check granularity is an exposure window.** Between
  the heartbeat timeout and the venue's next check, resting orders may still be
  live. Any reasoning about "orders are gone by now" must use timeout + check
  interval, not timeout alone.
- **Geoblock tiers are volatile.** A hardcoded country list would be wrong within
  a phase. The check is a live call whose failure is treated as ambiguity, and
  therefore as a block.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §0.2 — before any real order the live adapter must perform the venue's current
  geographic-eligibility check and fail closed on ambiguity.
- §1.3 — adding an order-submitting hot standby, or removing any reconciliation,
  heartbeat, geoblock, or kill-switch control, requires an ADR.
- §2 — exactly one fenced live order writer per account/signer; Redis for hot
  coordination, not monetary truth; supervisor restart and independent cancel
  utility; no order-submitting hot standby in v1.
- §4.2 — a PostgreSQL outage stops new trading decisions and order submission and
  heartbeats stop, causing venue-side cancellation; a control-API outage must not
  stop a healthy trader but the cancel CLI must remain usable; a trader crash must
  stop the heartbeat and must not leave an order-submitting standby active.
- §6 invariants 16 and 18.
- §9.9 — "Account state unknown → Stop heartbeat, cancel, reconcile, full halt".
- §9.12 — the secure adapter performs geographic eligibility checks before live
  entries and consumes per-signer warning headers.
- §9.13 — the order heartbeat is the highest rate-limit priority.
- §9.17 — reconciliation triggers and the resume-only-after-invariants-pass rule.
- §9.18 — the whole section: only the active fenced trader may heartbeat; the
  health lease's seven required inputs; alive-but-unhealthy stops heartbeats; the
  independent cancel CLI; "Redis is not sufficient as the only fence. Use a
  PostgreSQL advisory lock or lease with a monotonic fencing token persisted with
  every live submission."
- §10.6, §10.7 — `ops.fencing_leases`, `ops.kill_switch_events`; every live order
  references a valid fencing token.
- §14.1 — kill-switch scopes, actions, and append-only auditing.
- §14.2 — required emergency CLI commands; `cancel-all` must not require the
  trader database.
- §14.4 — paging alerts include "Heartbeat health lease failed while orders may
  exist" and "Live fencing conflict".
- §15 — independent cancel credentials protected separately where practical.
- §16.6 — fault injection: heartbeat response invalid/expired.
- §17 Phase 3 — automated gate: "Startup with ambiguous account state enters
  cancel-only/full-halt."

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §5 — `POST /v1/heartbeats` with ID rotation; bootstrap with an empty
  `heartbeat_id`; send every 5 seconds; a missing valid heartbeat within 10
  seconds cancels all open orders owned by those CLOB API credentials; the
  cancellation check runs every 5 seconds; invalid/expired ID returns 400 with the
  expected id. Also the four cancel endpoints and their `canceled` /
  `not_canceled` response shape, and the authoritative query endpoints.
- §8 — per-signer order and cancel token buckets; `DELETE /cancel-all` costs 1 +
  one per order actually canceled; response headers including
  `Poly-RateLimit-Warning`. Snapshot with effective date 2026-08-24.
- §10.1 — the geoblock endpoint, its response shape, and the three restriction
  tiers as of 2026-08-24; explicitly **not exercised** by `WP-000` (PAPER-only).

**Implementation and prior handoffs:**

- `docs/handoffs/WP-000.md` — safety attestation: no signer, wallet key, API
  credential, or authenticated call was used; the geoblock path was not exercised.

**Safety:** this ADR changes no run-mode default (ADR-010). Every mechanism here
is inert in the repository's current state: `ALLOW_REAL_ORDERS=false`, both live
caps `0`, no signer configured, no live gate requested
(`IMPLEMENTATION_STATUS.md`). **Paper mode cannot acquire a live fencing lease**,
and no heartbeat, geoblock, or cancel call has ever been made from this
repository.
