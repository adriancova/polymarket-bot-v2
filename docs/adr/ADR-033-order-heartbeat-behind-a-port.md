# ADR-033: The order heartbeat is built behind a port; its transport is ruled before live

- **Status:** **Proposed, 2026-10-03, by the orchestrator.** The venue report
  assigns conflict C-12 to "the orchestrator, by ADR, before `WP-320`"
  (`docs/venue/verified-2026-09-30.md`, closing list item 2). D1–D4 and D6
  rule for PAPER. D5, the transport, stays open; it must be ruled before any
  run mode above PAPER.
- **Date:** 2026-10-03
- **Recorded by:** the orchestrator, after `WP-310`.
- **Implemented by:** `WP-320` (D1–D4, D6). D5 is not implemented.
- **Supersedes / Superseded by:** none. It refines how §9.12's "heartbeat
  orders" is met while the SDK has no heartbeat method. It amends no
  invariant: nothing outside the SDK is called.
- **Handoff sections:** §9.12, §9.13, §9.18, §6 (invariant 16).
  **ADRs:** none amended.
- **Conflict it resolves for PAPER:** C-12 / E-17
  (`docs/venue/verified-2026-09-30.md` §5, §11; brief row
  `V3-C12-HEARTBEAT-ADR`).

## Context

1. **The handoff asks for two things that cannot both be met today.**
   - §9.12 says to "Wrap only the official unified SDK" and to "Place,
     cancel, query, and heartbeat orders".
   - §9.18 says that only the active fenced trader may send order heartbeats,
     that the heartbeat health lease needs recent proof from every critical
     component, and that "A process that is alive but unhealthy must stop
     heartbeats".
2. **The venue's protocol** (`docs/venue/verified-2026-09-16.md` §5,
   re-confirmed unchanged on 2026-09-30):
   - The request is an L2-signed `POST /v1/heartbeats`.
   - "Once the first heartbeat is accepted, the CLOB expects the account to
     keep sending them; if a valid heartbeat is not received within 10
     seconds, all open orders owned by those CLOB API credentials are
     canceled. The cancellation check runs every five seconds, so
     cancellation may occur up to five seconds after the timeout."
   - "Send a heartbeat every **5 seconds**."
   - The first request sends an empty `heartbeat_id`, and each success
     returns the id for the next one.
   - An invalid or expired id gets `400` with the expected id: "Sign a new
     request with that ID and retry".
   - The fixture is `test/fixtures/venue/heartbeat/heartbeat.json`.
3. **The SDK has no heartbeat method** at `0.11.0` or at head. Its
   authenticated request client, `secureClob`, is marked `@internal`.
   The docs' TypeScript and Python tabs read "Content coming soon." (E-17.)
4. **What `WP-320` must do** is about the decision to send a heartbeat, not
   the wire. Its four deliverables are the fencing lease, the heartbeat
   health lease, the geoblock check and kill-switch enforcement. Its
   acceptance criteria are: two live writers cannot both hold authority; an
   unhealthy process that is still running stops the heartbeat; an ambiguous
   geoblock result blocks new live entries; and paper mode cannot acquire
   live fencing.
5. **PAPER forbids credentials and network** (`AGENTS.md`), so no transport
   could be exercised now in any case.

## Decision

### D1. The controller is built; the transport is a port

`WP-320` builds the heartbeat controller in
`packages/polymarket-secure/src/heartbeat/**`, behind an injected
`OrderHeartbeatTransport` port. The controller owns:

1. **The protocol state:**
   - the id chain: an empty id first, then each returned id;
   - the single re-sign and retry with the expected id on the documented
     `400`;
   - the 5 s cadence;
   - the 10 s timeout and 5 s check, as cited venue facts.
2. **The gate.** A heartbeat is sent only while all of these hold:
   - the process holds the current fencing token;
   - the health lease holds;
   - the kill switch is not engaged;
   - the run mode is live (D4).
3. **Stopping.** When any of these fails, the controller stops sending, and
   does not resume until the gate passes again.

### D2. No transport is written under this ADR

- No raw HTTP request, no hand-built signature and no use of an `@internal`
  SDK member.
- The port's contract is the documented request and response shapes and
  the fixture.
- Tests use a fake port.

### D3. Rate limits

Every heartbeat is requested from `WP-310`'s budget as `clob.heartbeat`, at
`ORDER_HEARTBEAT` priority (`WP-310` follow_up 4).

### D4. Mode

- The controller refuses to construct outside a live run mode, through
  `WP-260`'s signer gate, as `WP-280`'s manager does.
- A PAPER process can never acquire live fencing.

### D5. Open before any mode above PAPER: the transport

1. **An L2-signed request inside `packages/polymarket-secure`,** built from
   the SDK's credential and signing primitives. It would be a reviewed,
   named exception to "wrap only the SDK", confined to the secure package
   and pinned by its own contract tests.
2. **Wait for SDK support,** keeping every live mode blocked until it
   arrives.
3. **Call the SDK's `@internal` `secureClob`.** This is not recommended,
   because an internal member can change without notice.

The ruling needs the user. A venue round must re-check the SDK first. The
ruling is recorded as an amendment to this ADR.

### D6. A heartbeat that is not confirmed

- **What counts.** Any transport error, timeout, malformed answer or unknown
  outcome leaves the heartbeat unconfirmed.
- **What the controller assumes.** Once the last confirmed heartbeat is more
  than 10 s old, plus the 5 s check interval, it treats every open order as
  possibly canceled by the venue.
- **What it does.** It requests reconciliation (`WP-290`, §9.17 trigger
  "submission unknown"). It never infers that an order is still resting.

## What it amends

| Item | Before | After |
|---|---|---|
| §9.12 "heartbeat orders" | Unmet: the SDK has no method (C-12) | Met for PAPER by the D1 controller behind a port; the transport waits on D5 |
| Brief row `V3-C12-HEARTBEAT-ADR` | Blocks `WP-320` | Blocks only modes above PAPER (D5) |

"Wrap only the official unified SDK" is unchanged.

## Consequences

- **`WP-320` can start once `WP-290` merges.** Its implementer builds D1, D3,
  D4 and D6, and tests them against a fake transport.
- **Live stays impossible** until D5 is ruled and implemented. That is
  consistent with `MAX_RUN_MODE=PAPER`.
- **The composition** binds the transport only after D5.

## Evidence

- `docs/venue/verified-2026-09-16.md` §5 (S-D17 lines 1454–1541; S-D18).
- `docs/venue/verified-2026-09-30.md`: the heartbeat row of the summary table
  (unchanged), §5 (no heartbeat in the SDK), §11 (C-12) and E-17.
- `docs/handoffs/WP-310.md`, follow_up 3.
- `docs/handoffs/WP-280.md`: the signer gate refuses outside live modes.
