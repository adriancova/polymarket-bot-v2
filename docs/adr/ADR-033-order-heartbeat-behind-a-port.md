# ADR-033: The order heartbeat goes behind a port; the user rules its transport before live

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
- **Handoff sections:** §6 (invariants 6 and 16), §9.9, §9.12, §9.13,
  §9.17, §9.18, §14.1, §14.2, §14.4.
  **ADRs:** ADR-008 §2–§4 and §8, applied unchanged; ADR-007; ADR-010 §4.
- **Conflict it resolves for PAPER:** C-12 / E-17
  (`docs/venue/verified-2026-09-30.md` §5, §11; brief row
  `V3-C12-HEARTBEAT-ADR`). It carries one more, unresolved, to the next
  venue round: the guide and the API reference disagree (Context 3).
- **Code cited:** `main` at `85b81e5`. `WP-290`'s coordinator is cited on
  the `wp-290` branch at `1dc6672`, not yet merged. Each cited behavior
  still holds at the branch tip `ba150f5`.
- **Revision:** r1, 2026-10-03 (`ADR033-REVIEW`), before acceptance.
  - Facts corrected or qualified. The old text, on `main` at `85b81e5`:
    - Status: "closing list item 2";
    - Context 2, now 3: "The request is an L2-signed
      `POST /v1/heartbeats`";
    - Context 5, now 6: "PAPER forbids credentials and network", citing
      `AGENTS.md`;
    - D3: "(`WP-310` follow_up 4)";
    - D6: "It requests reconciliation (`WP-290`, §9.17 trigger 'submission
      unknown')";
    - D6: "Once the last confirmed heartbeat is more than 10 s old, plus the
      5 s check interval";
    - "What it amends": "Met for PAPER by the D1 controller behind a port";
    - Evidence: "`docs/handoffs/WP-280.md`: the signer gate refuses outside
      live modes".
  - Rules changed. D1's gate drops "the kill switch is not engaged". D1
    gains the kill-switch scope rule and the explicit stops. D6 gains the
    clock, the lapse record, the entry block, "starts lapsed" and the lapse
    end. D2 gains where its tests run.

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
3. **Two official pages describe the protocol, and they disagree.** Both
   were byte-identical on 2026-09-30 (`verified-2026-09-30.md` §5).
   - **The manage-orders guide (S-D17)** gives a raw L2-signed
     `POST /v1/heartbeats` (`verified-2026-09-16.md` §5; C-12):
     - "Once the first heartbeat is accepted, the CLOB expects the account
       to keep sending them; if a valid heartbeat is not received within 10
       seconds, all open orders owned by those CLOB API credentials are
       canceled. The cancellation check runs every five seconds, so
       cancellation may occur up to five seconds after the timeout."
     - "Send a heartbeat every **5 seconds**."
     - The first request sends an empty `heartbeat_id`. "Each successful
       response returns a new ID to use for the following heartbeat".
     - An invalid or expired id gets `400 Bad Request` with the expected
       id: "Sign a new request with that ID and retry".
     - The fixture `test/fixtures/venue/heartbeat/heartbeat.json` records
       these shapes.
   - **The API reference (S-D18)** gives `POST /heartbeats`. Its `200`
     response is `{"status":"ok"}`, with no `heartbeat_id`. It documents no
     request body and no `400`.
   - **The dated reports do not record this conflict.**
     `verified-2026-09-16.md` §5 calls S-D18 "the OpenAPI page for
     `POST /v1/heartbeats`". The S-D18 body that both reports verified, by
     digest `983e93c1…`, reads `post /heartbeats`. This ADR carries the
     conflict as unverified, for the next venue round (D5).
   - Every figure is documentary only. No verification round has observed
     the protocol (`verified-2026-09-16.md` §5, "Documentary-only limit";
     §12).
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

1. **The protocol,** as the guide gives it (provisional; D2):
   - the id chain: an empty id first, then each returned id. The current id
     is persisted with the fencing lease (ADR-008 §4, consequence 1);
   - the documented `400` recovery: one new request with the expected id.
     Repeated `400`s raise the live-fencing-conflict alert (ADR-008 §4);
   - the 5 s cadence.
2. **The gate.** A heartbeat is sent only while both hold:
   - the process holds the current fencing token;
   - the health lease holds.

   Each must be confirmed, not assumed: an unknown result fails the gate.
   The controller exists only in the modes D4 allows.
3. **Kill switches.** Kill-switch state is a health-lease input. A process
   that cannot read it fails the gate (ADR-008 §8). `WP-320` defines which
   engaged switches stop the heartbeat, at `GLOBAL` or `ACCOUNT` scope
   only. A `MARKET` or `STRATEGY_INSTANCE` switch never does. The venue
   would cancel every order under the credentials, which is wider than the
   switch's scope (§14.1).
4. **Explicit stops** also act through the gate. Each fails the fence or
   the health lease:
   - the Incident Controller's "Stop heartbeat", the default for "Account
     state unknown" (§9.9);
   - `ops-cli stop-heartbeat` (§14.2). The command and its guidance are
     `WP-330`'s.
5. **Stopping.** When the gate fails, the controller sends nothing more
   and abandons any pending `400` retry (ADR-008 §2). It sends again only
   when the gate passes again.

### D2. No transport is written under this ADR

- No raw HTTP request, no hand-built signature and no use of an `@internal`
  SDK member.
- The port's contract is provisional: the guide's request and response
  shapes (S-D17), as the fixture records them. The venue round before D5
  resolves the conflict with S-D18. A different answer amends D1, D2 and
  D6.
- Tests use a fake port. `WP-320`'s allowed paths have no
  `test/contract/**` entry today.
  - §16.3's "Heartbeat protocol" contract test runs beside the code, in
    `packages/polymarket-secure/src/heartbeat/**`, or under a
    `test/contract/heartbeat/**` grant made at `WP-320`'s authorization.
  - §16.6's "Heartbeat response invalid/expired" fault runs under
    `test/fault-injection/live-safety/**`.

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

**Before the ruling,** a venue round:

- re-checks the SDK. If the SDK has gained a public heartbeat method, the
  port wraps it and no exception is needed;
- resolves the conflict between S-D17 and S-D18: the route, and whether a
  success carries an id;
- records the conflict in a new dated report, with S-D18's description
  corrected. A merged report is frozen.

**Recommendation, not a ruling:** option 1 if the SDK still has no method
and exports the primitives publicly; otherwise option 2.

The ruling needs the user. It is recorded as an amendment to this ADR.

### D6. A lapsed heartbeat

- **The clock.** Every age here is measured on the process's monotonic
  clock. A heartbeat's send time is read just before the controller calls
  the port. The transport signs and sends inside that call, so the send
  time never follows the request's departure.
- **Confirmed** means a success response that carries the next id.
  Anything else leaves a heartbeat unconfirmed:
  - not sent (D1 or D3);
  - a transport error, a timeout, a malformed answer or an unknown outcome;
  - a `400`;
  - a success without an id, such as S-D18's `{"status":"ok"}`. This fails
    closed: no heartbeat is confirmed, so new entries stay blocked.
- **Lapsed.** The heartbeat has lapsed once 10 s have passed since the send
  time of the last confirmed heartbeat.
  - This reads the venue's 10 s as running from its receipt of the last
    valid heartbeat. That reading is documentary only.
  - Receipt never precedes the send. So a lapse measured from the send is
    never late.
  - A confirmation that arrives 10 s or more after its send time leaves the
    heartbeat lapsed. A late arrival never moves the deadline.
  - The controller starts lapsed. No live entry precedes the first
    confirmed heartbeat.
- **What a lapse means.** The venue may already have canceled any open
  order under those credentials. During the lapse, the venue may cancel any
  remaining open order. The controller infers neither "resting" nor
  "canceled". ADR-008's timeout plus check interval bounds when orders are
  gone, not when they may go.
- **When a lapse starts,** the controller reports it. The composition
  (`apps/trader/src/live-safety/**`) then:
  1. records the lapse, with its cause and start. A lapse caused by a
     failed health lease while orders may exist raises §14.4's page
     "Heartbeat health lease failed while orders may exist";
  2. sends every open order with a venue order id to `RECONCILING`, through
     `WP-270`'s `OrderManager.requestOrderReconciliation`:
     - each transition carries reason code `MANUAL_REQUEST`, so the lapse
       record is what names the cause;
     - `WP-290`'s coordinator raises each request as §9.17's
       "position/balance discrepancy" (`POSITION_BALANCE_DISCREPANCY`). It
       pauses new submissions at once (§9.17 step 1);
     - `resume()` refuses while any of these orders is `RECONCILING`;
  3. latches a block on new live entries. `WP-320` already needs such a
     block for an ambiguous geoblock result.
- **When a lapse ends.** A lapse ends when a heartbeat is confirmed less
  than 10 s after its send time. The composition then:
  1. records the end of the lapse;
  2. re-requests each open order with a venue order id that is not already
     `RECONCILING`. `requestOrderReconciliation` refuses an order still
     `RECONCILING` (`OMS_ILLEGAL_TRANSITION`). That order's request from the
     lapse stays outstanding, and a read taken during the lapse may answer
     it;
  3. raises `POSITION_BALANCE_DISCREPANCY` through
     `ReconciliationCoordinator.trigger`. That pauses new submissions. A
     run that started before the trigger then cannot resume the OMS. The
     pending trigger stops it, and so does the hold epoch while it records
     its result;
  4. keeps the entry block latched until a run that started after the
     confirmation completes, passes and resumes the OMS (§9.17 step 8).
     - Such a run compares every tracked order that has a venue order id
       with the venue's view. So it sees any cancel made during the lapse.
     - Every run of a `reconcile()` call made after the confirmation
       qualifies. A run that started earlier never counts, even when its
       report arrives later;
  5. lifts the block only if the heartbeat has not lapsed again by then. A
     new lapse voids the recovery, and its own end starts another.
- **No new trigger.** §9.17 gains none. "Submission unknown" is not used:
  it belongs to a submission whose outcome is unknown (§6 invariant 6;
  ADR-007).

## Effect on the handoff and the brief

| Item | Before | After |
|---|---|---|
| §9.12 "heartbeat orders" | Unmet: the SDK has no method (C-12) | `WP-320` builds and tests the controller behind a port (D1–D4, D6). It sends nothing until D5 binds a transport |
| Brief row `V3-C12-HEARTBEAT-ADR` | Blocks `WP-320` | Once this ADR is accepted, blocks only modes above PAPER (D5) |

"Wrap only the official unified SDK" is unchanged.

## Consequences

- **`WP-320` can start once `WP-290` merges and this ADR is accepted.** Its
  implementer builds D1–D4 and D6, and tests them against a fake transport.
- **Each `WP-320` acceptance criterion can be implemented and tested
  without a real heartbeat transport:**

  | Criterion | How `WP-320` can meet and test it |
  |---|---|
  | Two live writers cannot both hold authority. | The fencing lease (ADR-008 §1–§2). D1 sends only for the current holder: the fake port sees no heartbeat from the other. |
  | Unhealthy-but-running process stops heartbeat. | D1's gate. One failed health input, and the fake port sees no further heartbeat. |
  | Ambiguous geoblock result blocks new live entries. | The geoblock check (ADR-008 §7). The heartbeat port is not involved. |
  | Paper mode cannot acquire live fencing. | The fencing lease's PAPER refusal. D4 also refuses the controller: a PAPER context gets `SignerBoundaryRefusal`. |

- **`WP-320`'s D6 tests include,** with a fake port and a fake monotonic
  clock:
  - a confirmation that arrives while a read taken during the lapse is
    still pending. No run that started before the confirmation lifts the
    entry block;
  - a success that arrives 10 s or more after its port call. The lapse
    does not end;
  - a new lapse between the confirmation and the passing run. The block
    stays latched.
- **Live stays impossible** until D5 is ruled and implemented. That is
  consistent with `MAX_RUN_MODE=PAPER`.
- **The composition** binds the transport only after D5.

## Evidence

- `docs/venue/verified-2026-09-16.md` §5 (S-D17 lines 1454–1541; S-D18) and
  its "Documentary-only limit"; §12, "Heartbeat cadence in practice"; the
  source index's S-D18 digest.
- `docs/venue/verified-2026-09-30.md`: the summary table's heartbeat row;
  §5 (no heartbeat in the SDK); §11 (C-12); E-17; §16, carried-forward
  item 2; the source index's S-D18 digest, the same as on 2026-09-16.
- Handoff §1.3, §6 invariants 6 and 16, §9.9, §9.12, §9.13, §9.17, §9.18,
  §11, §14.1, §14.2, §14.4, §16.3 and §16.6.
- Work plan: `WP-320`'s deliverables, acceptance criteria and allowed
  paths; `WP-330`'s "stop-heartbeat guidance".
- ADR-008 §1–§4, §7, §8 and Consequences; ADR-007; ADR-010 §4.
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
  - in `packages/oms/src/order-manager.ts`:
    `OrderManager.requestOrderReconciliation`, which refuses an order
    already `RECONCILING`; `retryReconciliationRequests`, which skips a
    request delivered and not consumed; and `resume` with its blocker.
- `WP-290`'s `ReconciliationCoordinator` at `1dc6672` (unchanged in these
  respects at `ba150f5`):
  - an OMS `ORDER_STATE` request triggers `POSITION_BALANCE_DISCREPANCY`,
    and every trigger pauses new submissions;
  - `trigger`. A pending trigger stops a run from resuming
    (`#workArrivedDuring`). So does any hold while the run records its
    result (the hold epoch);
  - `reconcile`, and its reads and comparison of every tracked order;
  - the test "(I-10, X4) a trigger raised during the reads" in
    `test/fault-injection/reconciliation/resume.test.ts`.
