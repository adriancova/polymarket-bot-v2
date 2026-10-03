# ADR-033: The order heartbeat is built behind a port; its transport is ruled before live

- **Status:** **Proposed, 2026-10-03, by the orchestrator.** The venue report
  assigns C-12 / E-17 to "the orchestrator, by ADR, before `WP-320`"
  (`docs/venue/verified-2026-09-30.md` §16, carried-forward item 2). Once
  accepted, D1–D4 and D6 settle what `WP-320` builds. D5, the transport,
  stays open. The user rules it before any run mode above PAPER.
- **Date:** 2026-10-03
- **Recorded by:** the orchestrator, after `WP-310`.
- **Implemented by:** `WP-320` (D1–D4, D6), not yet. D5 is not implemented.
- **Supersedes / Superseded by:** none. It refines how §9.12's "heartbeat
  orders" is met while the SDK has no heartbeat method. It amends no
  invariant and no ADR. Under D1–D4 and D6, nothing but the SDK reaches the
  venue.
- **Handoff sections:** §6 (invariants 6 and 16), §9.12, §9.13, §9.17,
  §9.18.
  **ADRs:** ADR-008 §2–§4, applied unchanged; ADR-007; ADR-010 §4.
- **Conflict it resolves for PAPER:** C-12 / E-17
  (`docs/venue/verified-2026-09-30.md` §5, §11; brief row
  `V3-C12-HEARTBEAT-ADR`).
- **Code cited:** `main` at `85b81e5`. `WP-290`'s coordinator is cited on
  the `wp-290` branch at `1dc6672`, not yet merged.

## Context

1. **The handoff asks for two things that cannot both be met today.**
   §9.12 says to "Wrap only the official unified SDK" and to "Place, cancel,
   query, and heartbeat orders". The SDK has no heartbeat method (item 4).
2. **ADR-008 (Accepted) already rules who may send the heartbeat.**
   - Only the holder of the current fencing token may send it (§6 invariant
     16; ADR-008 §2).
   - The health lease needs recent proof from market data, user data, the
     event loop, the OMS, the database, the reconciler and kill-switch state.
     "A process that is alive but unhealthy must stop heartbeats" (§9.18;
     ADR-008 §3).
   - ADR-008 §4 records the id chain and the `400` recovery.

   This ADR adds how the heartbeat reaches the venue, and what a missing
   confirmation means.
3. **The venue's protocol** (`docs/venue/verified-2026-09-16.md` §5;
   byte-identical on 2026-09-30, `verified-2026-09-30.md` §5):
   - The docs give it only as a raw L2-signed `POST /v1/heartbeats` (C-12).
   - "Once the first heartbeat is accepted, the CLOB expects the account to
     keep sending them; if a valid heartbeat is not received within 10
     seconds, all open orders owned by those CLOB API credentials are
     canceled. The cancellation check runs every five seconds, so
     cancellation may occur up to five seconds after the timeout."
   - "Send a heartbeat every **5 seconds**."
   - The first request sends an empty `heartbeat_id`. "Each successful
     response returns a new ID to use for the following heartbeat".
   - An invalid or expired id gets `400 Bad Request` with the expected id:
     "Sign a new request with that ID and retry".
   - These figures are documentary only. No verification round has observed
     them (`verified-2026-09-16.md` §5, "Documentary-only limit"; §12).
   - The fixture is `test/fixtures/venue/heartbeat/heartbeat.json`.
4. **The SDK has no heartbeat method** at `0.11.0` or at head
   (`verified-2026-09-30.md` §5; §11, C-12). Its authenticated request
   client, `secureClob`, is marked `@internal`. The docs' TypeScript and
   Python tabs read "Content coming soon." (E-17).
5. **What `WP-320` must deliver** is the fencing lease, the heartbeat health
   lease, the geoblock check and kill-switch enforcement. Its acceptance
   criteria are listed under Consequences. None needs a heartbeat
   transport.
6. **No transport can run now.** PAPER uses public credentials only (§11).
   `AGENTS.md` forbids any production wallet, signer, API credential or
   real-order test. The heartbeat needs CLOB API credentials.

## Decision

### D1. The controller is built; the transport is a port

`WP-320` builds the heartbeat controller in
`packages/polymarket-secure/src/heartbeat/**`, behind an injected
`OrderHeartbeatTransport` port. The controller owns:

1. **The protocol:**
   - the id chain: an empty id first, then each returned id. The current id
     is persisted with the fencing lease (ADR-008 §4, consequence 1);
   - the documented `400` recovery: one new request with the expected id.
     Repeated `400`s raise the live-fencing-conflict alert (ADR-008 §4);
   - the 5 s cadence.
2. **The gate.** A heartbeat is sent only while both hold:
   - the process holds the current fencing token;
   - the health lease holds.

   The controller exists only in the modes D4 allows. Each condition must
   be confirmed, not assumed: an unknown result fails the gate.
   Kill-switch state reaches the gate through the health lease.
   `WP-320`'s kill-switch enforcement decides which actions also stop the
   heartbeat. A `MARKET` or `STRATEGY_INSTANCE` scope never does, because
   the venue would cancel every order under the credentials.
3. **Stopping.** When the gate fails, the controller stops at once,
   including a retry in flight (ADR-008 §2). It sends again only when the
   gate passes again.

### D2. No transport is written under this ADR

- No raw HTTP request, no hand-built signature and no use of an `@internal`
  SDK member.
- The port's contract is the documented request and response shapes and
  the fixture.
- Tests use a fake port. `WP-320` runs §16.3's "Heartbeat protocol"
  contract test and §16.6's "Heartbeat response invalid/expired" fault
  against it.

### D3. Rate limits

- Each heartbeat is requested from `WP-310`'s `RateLimitBudget` as the
  operation `clob.heartbeat`, at `ORDER_HEARTBEAT` (`WP-310` follow_up 3).
- That operation is configured, not coded. `WP-310`'s contract snapshot
  `rate-limits-2026-09-30` gives it kind `HEARTBEAT`, which
  `PERMITTED_PRIORITIES` allows only at `ORDER_HEARTBEAT`. The live snapshot
  must define it too (`WP-310` follow_up 1).
- A refused or queued request delays or drops the heartbeat. D6's lapse
  clock keeps running.

### D4. Mode

- The controller's factory runs `WP-260`'s `assertSignerGate` first, as
  `WP-280`'s `createUserStreamManager` does.
- So it is built only in `EXECUTION_PROBE`, `LIVE_MICRO` or `LIVE`, within
  the process maximum, with real orders allowed. Any other context, PAPER
  included, gets `SignerBoundaryRefusal`, and the port is never touched.
- The fencing lease's own PAPER refusal (ADR-008 §2) is separate and
  unchanged.

### D5. Open before any run mode above PAPER: the transport

1. **An L2-signed request inside `packages/polymarket-secure`,** built from
   the SDK's credential and signing primitives.
   - It would be a reviewed, named exception to "wrap only the SDK",
     confined to the secure package and pinned by its own contract tests.
   - If the SDK does not export those primitives publicly, this becomes
     hand-written signing. That needs its own ADR (§1.3; ADR-010 §4).
2. **Wait for SDK support,** and ask for it upstream. Every live-signer
   mode stays blocked until it arrives.
3. **Call the SDK's `@internal` `secureClob`.** Not recommended: an
   internal member can change without notice.
4. **Go live without order heartbeats.** Not recommended. It removes a
   heartbeat control, which §1.3 gates by ADR. It also removes the
   fail-safe ADR-008 §3 relies on.

Options 1 and 2 are the venue report's examples (C-12).

**Before the ruling,** a venue round re-checks the SDK. If the SDK has
gained a public heartbeat method, the port wraps it and no exception is
needed.

**Recommendation, not a ruling:** option 1 if the SDK still has no method
and exports the primitives publicly; otherwise option 2.

The ruling needs the user. It is recorded as an amendment to this ADR.

### D6. A lapsed heartbeat

- **Confirmed** means a success response that carries the next id.
  Anything else leaves a heartbeat unconfirmed: not sent (D1 or D3), a
  transport error, a timeout, a malformed answer, an unknown outcome or a
  `400`.
- **Lapsed.** The heartbeat has lapsed once 10 s have passed since the last
  confirmed heartbeat was sent.
  - The venue cannot have received it before it was sent. So a lapse
    measured from the send is never late.
  - The controller starts lapsed. No live entry precedes the first
    confirmed heartbeat.
- **What a lapse means.** Any open order under those credentials may
  already be canceled by the venue. Until a heartbeat is confirmed again,
  any may still be. The controller infers neither "resting" nor "canceled".
  ADR-008's timeout plus check interval bounds when orders are gone, not
  when they may go.
- **What follows.** The controller reports the lapse. The composition
  (`apps/trader/src/live-safety/**`) then:
  1. sends every open order with a venue order id to `RECONCILING`, through
     `WP-270`'s `OrderManager.requestOrderReconciliation`.
     - `WP-290`'s coordinator raises the resulting request as §9.17's
       "position/balance discrepancy" (`POSITION_BALANCE_DISCREPANCY`).
     - It pauses new submissions at once (§9.17 step 1).
     - `resume()` refuses while any order is `RECONCILING`.
  2. blocks new live entries until the lapse ends. `WP-320` already needs
     such a block for an ambiguous geoblock result. Without it, a run that
     passes during the lapse could resume entries before a venue cancel.
- **Ending a lapse.** When a heartbeat is confirmed again, every order
  still open goes to `RECONCILING` again. The reads that settle it then
  start after the lapse. Only then does the entry block lift. The OMS stays
  paused until those reads pass (§9.17 step 8).
- **No new trigger.** §9.17 gains none. "Submission unknown" is not used:
  it belongs to a submission whose outcome is unknown (§6 invariant 6;
  ADR-007).

## Effect on the handoff and the brief

| Item | Before | After |
|---|---|---|
| §9.12 "heartbeat orders" | Unmet: the SDK has no method (C-12) | The controller is built and tested behind a port (D1–D4, D6). It sends nothing until D5 binds a transport |
| Brief row `V3-C12-HEARTBEAT-ADR` | Blocks `WP-320` | Once this ADR is accepted, blocks only modes above PAPER (D5) |

"Wrap only the official unified SDK" is unchanged.

## Consequences

- **`WP-320` can start once `WP-290` merges and this ADR is accepted.** Its
  implementer builds D1–D4 and D6, and tests them against a fake transport.
- **Each `WP-320` acceptance criterion is met and tested without a
  transport:**

  | Criterion | Met and tested by |
  |---|---|
  | Two live writers cannot both hold authority. | The fencing lease (ADR-008 §1–§2). D1 sends only for the current holder: the fake port sees no heartbeat from the other. |
  | Unhealthy-but-running process stops heartbeat. | D1's gate. One failed health input, and the fake port sees no further heartbeat. |
  | Ambiguous geoblock result blocks new live entries. | The geoblock check (ADR-008 §7). The heartbeat port is not involved. |
  | Paper mode cannot acquire live fencing. | The fencing lease's PAPER refusal. D4 also refuses the controller: a PAPER context gets `SignerBoundaryRefusal`. |

- **Live stays impossible** until D5 is ruled and implemented. That is
  consistent with `MAX_RUN_MODE=PAPER`.
- **The composition** binds the transport only after D5.

## Evidence

- `docs/venue/verified-2026-09-16.md` §5 (S-D17 lines 1454–1541; S-D18) and
  its "Documentary-only limit"; §12, "Heartbeat cadence in practice".
- `docs/venue/verified-2026-09-30.md`: the summary table's heartbeat row;
  §5 (no heartbeat in the SDK); §11 (C-12); E-17; §16, carried-forward
  item 2.
- Handoff §1.3, §6 invariants 6 and 16, §9.12, §9.13, §9.17, §9.18, §11,
  §16.3 and §16.6.
- ADR-008 §1–§4, §7 and Consequences; ADR-007; ADR-010 §4.
- `docs/handoffs/WP-260.md` (the run-mode gate), `WP-280.md`
  (`createUserStreamManager` runs it first) and `WP-310.md` (follow_up 1
  and 3).
- Code at `85b81e5`:
  - `assertSignerGate` in `packages/polymarket-secure/src/run-mode-gate.ts`
    and `SignerBoundaryRefusal` in `errors.ts`;
  - `RateLimitBudget` and `PERMITTED_PRIORITIES` in
    `packages/polymarket-secure/src/rate-limit/`;
  - the `clob.heartbeat` operation in
    `test/contract/rate-limits/fixtures/rate-limits-2026-09-30.snapshot.json`;
  - `OrderManager.requestOrderReconciliation` and `resume` in
    `packages/oms/src/order-manager.ts`.
- `WP-290`'s `ReconciliationCoordinator` at `1dc6672`: an OMS `ORDER_STATE`
  request triggers `POSITION_BALANCE_DISCREPANCY`, and every trigger pauses
  new submissions.
