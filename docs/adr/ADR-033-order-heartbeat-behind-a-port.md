# ADR-033: The order heartbeat goes behind a port; the user rules its transport before live

- **Status:** **Accepted.** D1–D4 and D6 were accepted on 2026-10-03 by the
  orchestrator. **D5 was decided on 2026-10-05 by the user: option 1**
  ([Amendment 1](#amendment-1-2026-10-05-v2-0-d5-decided)), on the facts of
  the venue round `VENUE-4`.
  The venue report assigns C-12 / E-17 to "the orchestrator, by ADR, before
  `WP-320`" (`docs/venue/verified-2026-09-30.md` §16, carried-forward item 2).
  Proposed the same day; revised r1 to r3 by `ADR033-REVIEW`, with a joint
  ACCEPT from Opus and gpt-6-astra at r4, merged as `47575cf`. D1–D4 and D6 settle
  what `WP-320` builds. Three LOWs from r4 (R4-W1, R4-L1, R4-L2) go to the
  next revision or `WP-320`'s packet.
- **Date:** 2026-10-03
- **Recorded by:** the orchestrator, after `WP-310`. Amendment 1 by `V2-0`.
- **Implemented by:** `WP-320` (D1–D4, D6), merged `ed6e5a0` (2026-10-05).
  D5 is not implemented: a pre-live package builds its transport
  (Amendment 1).
- **Supersedes / Superseded by:** none. It refines how §9.12's "heartbeat
  orders" is met while the SDK has no heartbeat method. It amends no
  invariant and no ADR. Under D1–D4 and D6, nothing but the SDK reaches the
  venue. Amendment 1 adds one named exception to §9.12's "Wrap only the
  official unified SDK": D5's heartbeat request, on the user's ruling.
- **Handoff sections:** §6 (invariants 6 and 16), §9.9, §9.12, §9.13,
  §9.17, §9.18, §14.1, §14.2, §14.4.
  **ADRs:** ADR-008 §2–§4 and §8, applied unchanged; ADR-007; ADR-010 §4.
- **Conflict it resolves for PAPER:** C-12 / E-17
  (`docs/venue/verified-2026-09-30.md` §5, §11; brief row
  `V3-C12-HEARTBEAT-ADR`). It carries one more, unresolved, to the next
  venue round: the guide and the API reference disagree (Context 3).
  - *Note, 2026-10-05 (`V2-0`):* that round, `VENUE-4`, recorded the
    conflict as C-20 and resolved it in part. The 10 s cancellation is
    documented for `POST /v1/heartbeats`, which carries the id chain (H-3).
    Still open: the `400` message key (C-20) and U-40. See
    [Amendment 1](#amendment-1-2026-10-05-v2-0-d5-decided), "The facts the
    ruling rests on".
- **Code cited:** `main` at `85b81e5`. `WP-290`'s coordinator is cited on
  the `wp-290` branch at `1dc6672`, not yet merged. Each cited behavior
  still holds at `ba150f5` and at `6ed3fbe`, the branch tip when r2 and r3
  were written.
- **Revision:** r1 to r3, 2026-10-03 (`ADR033-REVIEW`), before acceptance.
  - Text corrected or qualified. The old text, on `main` at `85b81e5`:
    - Status: "closing list item 2";
    - Context 2, now 3: "The request is an L2-signed
      `POST /v1/heartbeats`";
    - Context 5, now 6: "PAPER forbids credentials and network", citing
      `AGENTS.md`;
    - D3: "(`WP-310` follow_up 4)";
    - D4: "The controller refuses to construct outside a live run mode";
    - D6: "It requests reconciliation (`WP-290`, §9.17 trigger 'submission
      unknown')";
    - D6: "Once the last confirmed heartbeat is more than 10 s old, plus the
      5 s check interval";
    - "What it amends": "Met for PAPER by the D1 controller behind a port";
    - Consequences: "`WP-320` can start once `WP-290` merges";
    - Evidence: "`docs/handoffs/WP-280.md`: the signer gate refuses outside
      live modes".
  - Rules changed:
    - D1's gate drops "the kill switch is not engaged" and "the run mode
      is live (D4)"; D4's factory checks the mode once. An unknown result
      fails the gate. D1 gains the kill-switch scope rule, the explicit
      stops, the abandoned `400` retry, and ADR-008 §4's id persistence and
      alert.
    - D2's contract becomes provisional. D2 gains where its tests run.
    - D3 gains the live snapshot's duty and what a refused or queued
      request means.
    - D5 gains option 4, a recommendation, and what the venue round checks
      first. Option 1 gains its hand-written-signing limit, and option 2 an
      upstream request.
    - D6 gains the clock, the lapse record, the entry block, the startup
      lapse and the lapse end. Since r2, the lapse end raises the trigger
      again 5 s after the confirmation. The block waits for a run that
      started at least that late. Since r3, step 3 states when a run takes
      its triggers, and step 4 makes the composition call `reconcile()`.
    - Consequences gain D6's tests. Since r2, they run against the real
      `OrderManager` and `ReconciliationCoordinator`. Since r3, they include
      a lift without the periodic timer.
- **Amendment 1:** 2026-10-05 (`V2-0`), after acceptance. It records the
  user's D5 ruling. Dated pointers to it were added, without editing the
  text they follow, to "Conflict it resolves for PAPER", Context 3, D1
  item 1 and D2. The header's old text:
  - Status: "**D5, the transport, stays open**, and its recommendation is
    not a ruling: the user rules it before any run mode above PAPER.";
  - Implemented by: "`WP-320` (D1–D4, D6), not yet. D5 is not
    implemented."

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

   This ADR adds where the heartbeat's transport sits, and what a missing
   confirmation means.
3. **Two official pages describe the protocol, and they disagree.** On
   2026-09-30 both were byte-identical to their 2026-09-16 captures
   (`verified-2026-09-30.md` §5).
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
     *Note, 2026-10-05 (`V2-0`):* `VENUE-4` recorded it as C-20. The page
     renders the CLOB OpenAPI's other operation, and `/v1/heartbeats` is the
     documented route of the 10 s cancellation (H-3). The `400` message key
     and U-40 stay open (Amendment 1).
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
   - *Note, 2026-10-05 (`V2-0`):* no longer provisional in its route or its
     id chain (H-3; D2's note; Amendment 1).
2. **The gate.** A heartbeat is sent only while both hold:
   - the process holds the current fencing token;
   - the health lease holds.

   Each must be confirmed, not assumed: an unknown result fails the gate.
   The controller exists only in the modes D4 allows.
3. **Kill switches.** Kill-switch state is a health-lease input. A process
   that cannot read it fails the gate (ADR-008 §8). Only a `GLOBAL` or
   `ACCOUNT` switch may stop the heartbeat. `WP-320` defines which of their
   actions do. A `MARKET` or `STRATEGY_INSTANCE` switch never does: the
   venue would cancel every order under the credentials, which is wider
   than that switch's scope (§14.1).
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
  - *Note, 2026-10-05 (`V2-0`):* the round, `VENUE-4`, gave no different
    answer. The OpenAPI documents the same `/v1/heartbeats` shapes (H-3),
    so D1, D2 and D6 stand. The contract is no longer provisional in its
    route or its id chain. The `400` message key stays open (C-20), and
    Amendment 1's transport rule 4 covers it. U-40 stays open.
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

**2026-10-05, the user:** run the venue round first, then rule D5 on its
facts. The round is `VENUE-4`, combined with the Protocol V2 migration
facts, since the SDK upgrade bears on the same questions.

The ruling needs the user. It is recorded as an amendment to this ADR.

**2026-10-05, the user ruled option 1.**
[Amendment 1](#amendment-1-2026-10-05-v2-0-d5-decided) records the
decision, its scope, its transport rules and when it lapses.

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
  - The controller starts lapsed. At startup the composition runs the
    lapse-start steps with cause "startup". New live entries remain blocked
    until the first recovery completes the lapse end's steps 4–5.
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
     `ReconciliationCoordinator.trigger`, at the confirmation and again 5 s
     after it. Each trigger pauses new submissions. A run takes the pending
     triggers after ADR-032 D5's retry cadence and before its reads. It may
     take a trigger received after its recorded start and still resume. A
     trigger raised after the run takes its triggers, but before it resumes,
     prevents that resumption. The pending-trigger check stops it. If the
     trigger arrives while the run writes its completion, the changed hold
     epoch stops it instead. Steps 4–5 decide when the entry block lifts;
  4. keeps the entry block latched until a run that started at least 5 s
     after the confirmation completes, passes and resumes the OMS (§9.17
     step 8).
     - The wait covers the venue's sweep. On D6's reading of the 10 s, a
       valid heartbeat received before the venue's deadline resets it. So
       any timeout during the lapse fell no later than the confirming
       heartbeat's receipt, which precedes the confirmation. S-D17 says
       "cancellation may occur up to five seconds after the timeout"
       (ADR-008: timeout plus check interval). So the sweep has run by 5 s
       after the confirmation. Like the 10 s, that figure is documentary
       only.
     - Such a run reads every open tracked order that has a venue order id,
       by id when the open-orders list omits it. It compares the order with
       that read, or answers the order's outstanding request with it. So it
       sees any cancel made during the lapse or by that sweep.
     - Every run of a `reconcile()` call made at least 5 s after the
       confirmation qualifies. A run that started earlier never counts, even
       when its report arrives later.
     - The composition makes those calls. The coordinator owns no timer,
       and a trigger only queues a run. So, from 5 s after the confirmation,
       the composition calls `reconcile()`. It keeps calling until a
       qualifying run passes and resumes the OMS, or a new lapse voids the
       recovery. A call made while another is in progress runs nothing
       (`NOT_RUN`). The composition then waits for the call in progress to
       end, and calls again, even if no trigger is pending. A pass from a
       call made earlier never ends the calls. After a qualifying run that
       fails, the composition may space its calls;
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

Amendment 1 (2026-10-05) adds one named exception to it, for D5's heartbeat
request only. Its own table gives the effect.

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

- **`WP-320`'s D6 tests** run under `test/fault-injection/live-safety/**`,
  with a fake port and a fake monotonic clock, against the real
  `OrderManager` and `ReconciliationCoordinator`. §18.3 says "Do not mock
  away the central behavior being tested". The tests include:
  - a confirmation that arrives while a read taken during the lapse is
    still pending. No run that started before the confirmation lifts the
    entry block;
  - a venue cancel within 5 s after the confirmation. The block stays
    latched until a run that sees it;
  - a `reconcile()` call made just before 5 s after the confirmation, whose
    rerun takes the second trigger and resumes the OMS. No trigger is then
    pending. The composition calls again, and the block lifts without the
    periodic timer;
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
  §11, §14.1, §14.2, §14.4, §16.3, §16.6 and §18.3.
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
  respects at `ba150f5` and `6ed3fbe`):
  - an OMS `ORDER_STATE` request triggers `POSITION_BALANCE_DISCREPANCY`,
    and every trigger pauses new submissions;
  - the file's header: "this layer-1 class owns no timer";
  - `trigger`, which holds and queues a run but starts none. A pending
    trigger stops a run from resuming (`#workArrivedDuring`). So does any
    hold while the run records its result (the hold epoch);
  - `#runOnce`, which reads its start time before `#retryCadence`, then
    takes the pending triggers (`#takeTriggers`) before `#readAll`;
  - `reconcile`, which runs nothing (`NOT_RUN`) while a run is in progress,
    and its reads and comparison of every open tracked order with a venue
    order id (`#readAll`, `#compareOrdersAndTrades`);
  - the test "(I-10, X4) a trigger raised during the reads" in
    `test/fault-injection/reconciliation/resume.test.ts`.

## Amendment 1 (2026-10-05, V2-0): D5 decided

- **Recorded by:** `V2-0`.
- **Ruled by:** **the user, 2026-10-05**, in the session, on `VENUE-4`'s
  facts: "ADR-033 D5: option 1". `docs/handoffs/VENUE-4.md` records it
  ("The user's rulings on this plan (2026-10-05)", item 2).
- **Facts:** `docs/venue/verified-2026-10-05.md` §H, cited by id. That
  report numbers its sources afresh: its guide is S-D20 (S-D17 above), its
  API-reference page S-D23 (S-D18 above), and the CLOB OpenAPI S-O02.
- **The handoff:** it departs from §9.12's "Wrap only the official unified
  SDK" for one request, on the user's ruling. It is not hand-written
  signing, so §1.3's SDK-replacement gate is not reached (ADR-010 §4). It
  removes no heartbeat control.
- **Mode:** it enables no mode. What it allows once a mode above PAPER is
  otherwise permitted is stated below.
- **Not implemented.** A pre-live package builds the transport. `WP-320`'s
  controller and port are unchanged.

### The facts the ruling rests on

- **H-1.** No release has a public order-heartbeat method: not 0.11.0, not
  0.12.0, not the canary. The guide's TypeScript tab reads "Content coming
  soon." So the port cannot wrap an SDK method, and C-12 stands.
- **H-2.** `buildHmacSignature` is a public root export, and `SecureClient`'s
  own L2 headers are built with it. `credentials` and `account` are public
  getters. The authenticated transport, `secureClob`, is still `@internal`.
- **H-3.** The CLOB OpenAPI documents two routes:
  - `POST /v1/heartbeats`: the id chain; a `200` that requires
    `heartbeat_id`; a `400` that requires `error` and `heartbeat_id`;
  - `POST /heartbeats`: no body; a `200` with `{"status": "ok"}`.

  The guide documents only the first, keys its `400` `error_msg`, and ties
  the 10 s cancellation to it. **So the documented route of the 10 s
  cancellation is `/v1/heartbeats`.**
- **C-20** is resolved in part. Open: the `400` message key, `error_msg` in
  the guide and `error` in the OpenAPI.
- **U-40** is open: the timing of `/heartbeats`' cancellation; whether it and
  `/v1/heartbeats` are one mechanism; and whether heartbeats protect
  ExchangeV3 orders. INF: yes, since the cancel is per credential, but no
  page says so.
- **Protocol V2 changes nothing here.** The guide's order-heartbeat section
  is unchanged apart from one punctuation mark (F-75).

**What this means for D1, D2 and D6.**
- The venue round found D2's provisional shapes documented for
  `/v1/heartbeats` by both the guide and the OpenAPI (H-3). D2 said a
  different answer would amend D1, D2 and D6. The answer was not different,
  so all three stand as written.
- D2's contract is no longer provisional in its route or its id chain. The
  `400` message key is the one open point (C-20), and transport rule 4
  below covers it.
- `classifyHeartbeatAnswer` already reads a `400` by its `heartbeat_id`,
  never by its message.

### The decision: option 1

1. **What.** D1's `OrderHeartbeatTransport` port is bound to one request:
   an L2-signed `POST /v1/heartbeats` on the CLOB host, sent by
   `packages/polymarket-secure` itself.
2. **Signing.** The L2 headers are built as the SDK's own `SecureClient`
   builds them (H-2):
   - `POLY_SIGNATURE` comes from the public `buildHmacSignature`, over the
     timestamp, `"POST"`, `"/v1/heartbeats"` and the exact body sent (H-2,
     quoting S-D20 lines 1518-1523);
   - the key, passphrase and secret come from the public `credentials`
     getter, and `POLY_ADDRESS` from the public `account` getter;
   - no signature code of our own is written, and `secureClob` stays unused.
     Option 3 stays rejected.
3. **The exception.** The package sends this request itself, so it is a
   named, reviewed exception to "Wrap only the official unified SDK"
   (§9.12).
   - D2's "no hand-built signature" and "no use of an `@internal` SDK
     member" stand.
   - D2's "no raw HTTP request" is lifted for this one request.

### Its scope: this route only

- Only `POST /v1/heartbeats`. Never `POST /heartbeats` (U-40), and no other
  route.
- Only inside `packages/polymarket-secure`, and only as the binding of D1's
  port.
- It permits no other request that the secure package sends itself. Every
  other venue call stays on the SDK. A second exception needs its own ADR.

### The transport rules

1. **A timeout.** Every request has a fixed timeout. The implementing
   package sets it and pins it with a test.
   - It is no longer than the controller's `responseTimeoutMs`, a client
     choice of 4 s by default (`createOrderHeartbeatController`). So a call
     the controller abandons leaves no request open.
   - A timed-out request is an unknown outcome, so the heartbeat is
     unconfirmed (D6).
2. **No retry beyond the §9.13 budget.**
   - The transport makes one attempt per call of the port. It never
     retries: not on a network error, a `429` or any other status.
   - Every resend is the controller's: the next 5 s tick, or D1's one `400`
     recovery. Each is filed with the budget as `clob.heartbeat` at
     `ORDER_HEARTBEAT` (D3).
   - A `Retry-After` is reported to the controller, not waited on.
3. **The id chain, as D1, D2 and D6 state it.**
   - An empty `heartbeat_id` first, then each returned id (H-3).
   - Confirmed means a success response that carries the next id (D6).
   - A success without one, such as `/heartbeats`' `{"status": "ok"}`,
     confirms nothing.
4. **The `400` body is read under both documented keys** (C-20).
   - Its message is under `error_msg` in the guide and `error` in the
     OpenAPI. Either or both may be present.
   - A reader accepts either key and depends on neither. The message text
     classifies nothing.
   - The expected id is `heartbeat_id`, which both sources document (H-3).
5. **What it reports.** The venue's answer, unparsed, as D2's port contract
   says (`HeartbeatTransportAnswer`). It never throws.
6. **Secrecy.** The headers, the credentials and the heartbeat id are never
   logged and never put in an event (§15; ADR-010 §6).
7. **Mode.** The transport's factory runs `assertSignerGate` first, as the
   controller's does (D4). In PAPER it is never built.
8. **Tests.** Contract tests pin the request, the headers built through the
   SDK's exports, the timeout, the single attempt and both `400` keys. They
   run on fakes behind the network tripwire. No test sends a heartbeat.

### When the exception lapses

- It lapses at the first stable release of `@polymarket/client` with a public
  order-heartbeat method. A canary or beta release does not count.
- Then the port wraps that method, as D5 already says: "the port wraps it
  and no exception is needed". The hand-sent request is removed in the same
  package, after a fresh pin check.
- Until then, each venue round re-checks H-1.

### What it allows, and what it does not

- **Now, nothing runs.** `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
  `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`
  are unchanged. PAPER holds no credential (ADR-010 §3).
- **Once a mode above PAPER is otherwise permitted** (ADR-010 §1's human
  gates): the live composition may bind D1's port to this transport, in the
  modes D4 allows. It allows nothing else.
- **Still owed before a live gate relies on it for V2 orders:** U-40's
  ExchangeV3 question. It is settled by documentation, or by an
  authenticated observation in a mode that permits credentials (U-40).
- "Live stays impossible until D5 is ruled and implemented" (Consequences):
  D5 is now ruled, and not yet implemented.

### Related, not yet triggered

The migration plan's §5 item 5 is a possible second exception: one
unsigned, credential-free `GET /v2/approvals` inside
`packages/polymarket-secure`.
- It triggers only if no stable SDK release reads `/v2/approvals` when
  `V2-6` starts. Today only the canary does (§S.2, §S.3).
- It is not decided here, and this amendment's scope does not cover it.
- If it triggers, its ADR states its scope, transport rules, number handling
  and lapse in the same form, and names this exception.

### Effect on the handoff and the brief

| Item | Before | After |
|---|---|---|
| §9.12 "Wrap only the official unified SDK" | Unchanged | One named exception: D5's `POST /v1/heartbeats`, on the user's ruling |
| §9.12 "heartbeat orders" | `WP-320` built the controller behind a port; no transport | The transport is option 1, built pre-live |
| Brief row `V3-C12-HEARTBEAT-ADR` | D5 open for the user | D5 ruled; its transport is owed before any mode above PAPER |
