# ADR-034: Order-lifecycle semantics before live: venue-time ordering, one executable quantity, time-in-force end to end, and collateral-targeted immediate BUYs

- **Status:** **Proposed** (2026-10-06). Nothing is implemented.
  - D1 records the user's ruling on `WP340-F1` (2026-10-05: venue-time
    ordering) and settles its details. Two of D1's outcomes go beyond the
    ruling's two cases: the hold for pairs that venue-timed evidence may
    still order, and the halt at once for pairs it never can (D1.5). Both
    are put to the user (Open item 1).
  - D2 to D4 are for the orchestrator to accept after the joint review.
    D4.1's conversion basis departs from the round's packet ("at the limit
    price") and is put to the orchestrator (Open item 9).
- **Date:** 2026-10-06. Revised the same day (round 1 of the review).
- **Recorded by:** the round `ADR-034` (docs only), authorized at `3294201`.
- **Implemented by:** not yet. Three rounds are proposed under "Implementation
  plan", strictly in this order: `OMS-QTY` (D2), `OMS-VENUE-TIME` (D1), and
  `TIF-COLLATERAL` (D3, D4). The names are proposals; the orchestrator
  assigns them.
- **Findings it disposes of:**
  - `WP340-F1` (`docs/handoffs/WP-340.md`;
    `docs/experiments/phase-3-verification.md` §5);
  - `CO3-N1` and `CO3-N2` (`docs/handoffs/CLOSEOUT-3-wave-3-closeout.md`, N1
    and N2);
  - `V2-10B` (`docs/handoffs/V2-10.md`, "The orchestrator's deferral").
- **Venue facts:** the dated addendum
  [`verified-2026-10-06.md`](../venue/verified-2026-10-06.md), written by this
  round and cited below as **A** with its fact id (for example A F-84). Earlier
  dated reports are cited by name. This ADR asserts no venue fact on its own
  authority ([README](./README.md), "Source precedence").
- **Supersedes / Superseded by:** none.
  - It refines ADR-007 §5 (how FAK and FOK answers map) and §8 (how a lifetime
    below the GTD floor is met).
  - It refines `V2-10`'s conversion (D4.1).
  - It amends no handoff invariant. Every departure is named under "Relation
    to the handoff and the ADRs".
- **Handoff sections:** §1.3, §6 (invariants 6, 7, 9, 10, 12 and 15), §8,
  §9.9, §9.10, §9.11, §9.12, §9.13, §9.17, §12.2 and §13. **ADRs:** ADR-001,
  ADR-002 §2, ADR-007, ADR-008, ADR-010, ADR-020, ADR-022 D10, ADR-032 D4 and
  ADR-033.
- **Code cited:** `main` at `3294201`.
- **Posture:** PAPER only. No decision here enables a mode above PAPER. Every
  rule is exercised against mocks until the human gate of ADR-010.

## Context

1. **`WP340-F1`: a late `LIVE` halts its market.**
   - **What happens.** When a stream observation says `LIVE`, `DELAYED` or
     `UNMATCHED` for an order the OMS holds terminal, the OMS reopens the order
     to RECONCILING. It raises a halting `EVIDENCE_CONFLICT` ("a terminal order
     was observed LIVE"; `packages/oms/src/order-manager.ts:2217-2228` and
     `#reopenTerminal`, `:2266-2288`). WP-290 then quarantines the market
     (`OMS_HALTING_ALERT`), and the account stays paused until an operator
     releases it.
   - **Three routes** (`docs/experiments/phase-3-verification.md` §5):
     1. a lost placement answer, where the retained `PLACEMENT` is drained
        after a terminal reconciliation read;
     2. a frame that lags a read which recorded the order FILLED;
     3. with no fault at all, a place-then-cancel that is faster than the
        stream's `PLACEMENT` push. Route 3 rests on the mock's assumption A8.
   - **Why the OMS cannot tell.** Its observation port carries no instant:
     `OrderObservation` is `{ venueOrderId, status }`
     (`order-manager.ts:320-323`). WP-280's normalizer reads the event's
     `timestamp` (`packages/polymarket-secure/src/user-stream/normalize.ts:116-117`,
     `:318`), but the projection drops it (`oms-projection.ts:64-69`,
     `:126-142`).
   - **Today it is pinned, not fixed:** four `it.fails` tests
     (`test/fault-injection/live/findings.test.ts:115`, `:152`, and `:177` for
     the filled and canceled variants), and 287 scripted operator releases
     (`support/expected-releases.ts`).
   - **The user ruled on 2026-10-05:** venue-time ordering. "The venue
     timestamp is passed into the OMS. A `LIVE` older than the evidence that
     made the order terminal is recorded as stale, with no halt. A newer one
     still halts." (the brief's `WP340-F1` row).
2. **What the venue gives an ordering rule** (A §2):

   | Evidence | Instant it carries | Precision | Fact |
   | --- | --- | --- | --- |
   | Stream order event (`PLACEMENT`, `UPDATE`, `CANCELLATION`) | `timestamp`, required, "Event timestamp in milliseconds" | ms | A F-88, F-89, F-91 |
   | Stream trade event | `timestamp` (ms); `match_time` and `last_update` | ms; s | A F-88, F-89, F-91 |
   | REST order read (`/data/order`, `/data/orders`) | `created_at` (and the order's `expiration`); no instant of the current status | s | A F-93 |
   | REST trade read (`/data/trades`) | `match_time`, `last_update`. The OpenAPI's optional `match_time_nano` is dropped by SDK 0.12.0 | s | A F-94, F-95 |
   | Placement answer, cancel answer | none | — | A F-96 |

   - **Not documented:** what instant `timestamp` names, whether it is
     monotonic per order, how a push is ordered against the REST answer of
     its cause (U-52), and whether a value is truncated or rounded to its
     unit. The examples are consistent with "the instant of the change" (A
     F-98, an inference).
   - **The unit is in conflict** (C-25). WP-280 refuses any value outside its
     plausible window, so a seconds value is refused, never misread
     (`wire.ts:76-77`, `:122-137`).
   - **Our harnesses stamp every frame with one constant:** `wireOrder` and
     `wireTrade` write `TIMESTAMP_MS`
     (`test/fault-injection/reconciliation/support/wp280.ts:36`, `:81`,
     `:112`), and the live mock publishes through them
     (`test/fault-injection/live/support/mock-clob.ts:733-737`, `#publishOrder`).
3. **`CO3-N1`: two share quantities.**
   - **The SDK rounds the share amount down to 2 decimals** for every tick
     size, as the documented "Size decimals" column says (A F-99, F-101).
   - **The adapter accepts a signed share amount** that is rounded down by less
     than 0.01 (`packages/polymarket-secure/src/venue-client.ts:295-313`,
     `:369-383`).
   - **The OMS keeps the unrounded ticket size** (`originalShares:
     ticket.shares`, `order-manager.ts:2434`). Its `identityMismatch` does not
     compare amounts (`:3028-3037`).
   - **Reconciliation needs equality:** the venue's original size must equal
     that unrounded size (`packages/oms/src/reconciliation/identity.ts:64-71`,
     `matchesExactly`).
   - **The mock hides it:** it signs the rounded amount but books the
     requested one (`mock-clob.ts:525-537`, `:886-897`).
   - **The closeout's probe E01** (BUY 5.009 at 0.5) shows the result: with
     signed booking, an acknowledged order breaks with `ORDER_FACTS_MISMATCH`,
     and a lost answer with `SIGNED_IDENTITY_AMBIGUOUS` and `ORDER_UNRESOLVED`.
   - **Nothing upstream quantizes.** The planner slices any positive decimal
     (`packages/execution-planner/src/slice.ts`). Static Bracket accepts any
     positive `size_shares`
     (`packages/strategies/static-bracket/src/params.ts:547`).
4. **`CO3-N2`: FAK and FOK cannot reach the venue.**
   - **PAPER resolves a time-in-force:** the intent's tag, else the instance's
     `immediate_order_type`, else a refusal
     (`packages/trading-core/src/pipeline.ts:113-150`). It records the result
     in an in-memory side table, `OrderTimeInForceBook`, which the simulator
     reads. `PlannedOrder` carries none
     (`packages/execution-planner/src/plan.ts:97-109`).
   - **The OMS cannot carry one:**
     - the ticket infers GTC or GTD from the expiration
       (`order-manager.ts:285-296`, `:3034-3035`);
     - the adapter refuses any other type (`venue-client.ts:373`);
     - the SDK port exposes only `createLimitOrder`
       (`packages/polymarket-secure/src/sdk-port.ts:27-39`), which cannot
       express FAK or FOK (A F-83). `createMarketOrder` can (A F-84).
   - **The example PAPER config uses FAK,** with `"order_validity_ms": 30000`
     (`infra/compose/trader/trader.config.example.json:126`, `:130`).
   - **ADR-007 §8 requires it:** "a requested lifetime shorter than the floor
     cannot be expressed as GTD at all and must be handled by FAK/FOK or by
     cancel-on-deadline".
5. **`V2-10B`: the collateral target, and dust.**
   - **The venue:** "CLOB GTC/GTD BUY targets are shares; FOK/FAK BUY targets
     are collateral." (`verified-2026-10-05.md` F-63, re-read unchanged in A
     F-82).
   - **`V2-10`** built `"COLLATERAL_AT_LIMIT_PRICE"` but kept
     `"SHARES_UNDOCUMENTED"` as the default
     (`packages/simulation/src/venue.ts:260-269`).
   - **Its probe B:** an entry of 50 at 0.35 bought 30 at 0.34 plus 20.857142
     at 0.35. The exit sold 50.85714 and left 0.000002 shares, and the
     two-bracket run never entered again (`V2-10` round-0 handoff, known
     risk 1).
   - **A correction to the framing of the packet and of `V2-10.md`** ("exits
     still sell 50"). Static Bracket already sizes every exit from its
     confirmed allocation not yet exited, not from the planned count
     (`openShares`, `packages/strategies/static-bracket/src/decide.ts:843-847`;
     §6 invariant 10). The gap is the venue's 0.01 share grid, and what to do
     with the residue.
   - **Probe B also shows the caps problem.** 50.857142 shares exceed the
     strategy's own `maximum_position_shares` of 50, which its caps checked
     on the requested 50 (`applyEntryCaps`, `decide.ts:1194-1207`,
     `:1248-1265`). A target at the limit price buys more than the planned
     size whenever the book asks less than the limit, and the direct leg's
     limit is the configured `maximum_buy_price` (`decide.ts:897`).
   - **A second gap:** `V2-10` floors the target to base units (6 decimals),
     but the SDK floors a market BUY's amount to 0.01 (A F-101).
6. **Constraints this ADR works within.**
   - ADR-007: the protocol, a fixed state machine (§1), unknown is never a
     rejection (§3), identity is the signed order (§4), and persisted payloads
     are secrets (§11).
   - ADR-008: fencing, and the heartbeat as the backstop for resting orders.
   - ADR-020: new port fields are read as own data through the doors.
   - ADR-022 D10: live packages attach through the core's ports. A hook inside
     the loop is a bounded `packages/trading-core/**` grant.
   - ADR-032 D4: a read answers only its current request, and is never made
     before receiving it.
   - ADR-002 §2: "A venue timestamp is data, not an order."
   - Handoff §1.3 makes a change to event-ordering semantics ADR-worthy. D1 is
     that ADR for late order evidence.

## Decision

### D1. Venue-time ordering of late order observations (`WP340-F1`, per the user's ruling)

**D1.1 Scope.**
- **What it covers:** a user-stream order observation whose status says the
  venue may still hold the order (`LIVE`, `DELAYED` or `UNMATCHED`; "LIVE-class"
  below), arriving for an order the OMS holds terminal.
- **`DELAYED` and `UNMATCHED` are an extension.** The ruling names `LIVE`. The
  OMS treats the three alike today (`order-manager.ts:2219-2227`), so D1 does
  too.
- **Unchanged:**
  - an unrecognised status on a terminal order still halts, whatever its time;
  - `MATCHED` and `CANCELED` observations of a terminal order are recorded, as
    today. They may now also supply a terminal instant (D1.3);
  - a REST read that finds open an order the OMS holds terminal still halts
    (`#applyPresent`, `order-manager.ts:2114-2181`). A read is current-state
    evidence made after its request (ADR-032 D4), not a late event.

**D1.2 The instant each port receives.**

| OMS port | Instant | Source | Unit |
| --- | --- | --- | --- |
| `applyOrderObservation` | `venueInstant`: the event's `timestamp` | WP-280's `NormalizedOrderEvent.venueTimestamp` (A F-88, F-91) | `MS`; **required** |
| `recordFill`, from the stream | `venueInstant`: the event's `timestamp`, **only on a fill projected from a `MATCHED` trade event**; and `matchedAt` (`match_time`) as today | WP-280's projection (A F-89, F-91) | `MS`; `S` |
| `recordFill`, from a REST read (WP-290) | `matchedAt` (`match_time`) only | A F-94, F-95 | `S` |
| `applySettlement` | `observedAt`, unchanged | | ms |
| placement answer, cancel answer | none | A F-96 | — |
| reconciliation answer | none for the order's status; its fills carry `matchedAt` | A F-93 | `S` |

- **Only a `MATCHED` event's `timestamp` is a fill instant.** A fill first
  projected from a `MINED`, `CONFIRMED` or other trade event carries no
  `venueInstant`: that event's `timestamp` names a later change (A F-98), and
  using it would place the match too late, which is the unsafe direction. Its
  instant is then its `match_time`.
- **Representation.** An instant is an integer epoch value with a unit, `MS`
  or `S`, never a float.
- **Its interval is widened by one unit on each side.** No source says
  whether the venue truncates or rounds a value to its unit (U-52). So a
  value `v` in unit `u` (1 ms, or 1000 ms for `S`) stands for the interval
  `[(v − 1)·u, (v + 1)·u)` ms. It contains the true instant whether the venue
  truncates (`[v·u, (v + 1)·u)`), rounds to nearest (`[v·u − u/2, v·u + u/2)`)
  or rounds up (`((v − 1)·u, v·u]`).
  - Example: `match_time` 1790000001 is `[1790000000000, 1790000002000)` ms.
    A `LIVE` at 1790000000900 ms is therefore not STALE against it. Under
    truncation alone it would have been, and if the venue rounds, that
    `LIVE` may follow the match.
- **Missing instants are refused.** An observation without a readable instant
  is refused at the port (`OMS_INVALID_INPUT`) and never applied. WP-280
  already treats a missing or implausible `timestamp` as a malformed event and
  requests reconciliation (`normalize.ts:318`; `manager.ts:1000-1005`; C-25).
  New fields are read as own data (ADR-020).
- **Retained evidence keeps its instant.** An observation or a fill retained
  because no order holds its venue order id yet (`#unattributed`,
  `order-manager.ts:1167`) keeps the `venueInstant` it arrived with. When it is
  drained, it is classified with that instant, never with the drain's.

**D1.3 The terminal instant T: "the evidence that made the order terminal".**

| Terminal state, and how it was reached | T |
| --- | --- |
| CANCELED, by a stream `CANCELED` observation (a `CANCELLATION` event) | its `timestamp` (`MS`) |
| CANCELED, by a cancel answer, a FAK's answer or a reconciliation read | **PENDING** (A F-93, F-96), until a stream `CANCELED` observation of the same venue order id arrives; then its `timestamp` |
| FILLED, however it was reached (fills, a FAK or FOK answer, or a read) | the **completion instant C**: the latest instant among the fills that make up its final size. `C.lo = max F.lo` and `C.hi = max F.hi` over those fills. **PENDING** while the fills received do not yet sum to the final size. Every fill has at least its `match_time` |
| EXPIRED | the `timestamp` of the stream observation that made it EXPIRED, if one did; else **PENDING**. No documented stream status names an expiry (A U-54), so in practice PENDING |
| REJECTED | **none.** A rejected order never rested, and it has no venue order id an observation could name. A LIVE-class observation that reached one would halt at once, as today |

- **A fill's instant F.**
  - It is the `timestamp` (`MS`) of its trade's `MATCHED` event when that
    event was received, whichever arrived first. Otherwise it is the trade's
    `match_time` (`S`), from any trade event or REST read.
  - **Narrowing.** When a fill first recorded with `match_time` later gets its
    `MATCHED` event, and the `MS` interval lies inside the `S` interval, the
    `MS` one replaces it. That is the only way an instant narrows.
  - **Disagreement.** When the `MS` interval does not lie inside the `S`
    interval, the two disagree. F is then the hull of both, the smallest
    interval containing both. That can only make fewer pairs STALE.
- **Evidence that widens T after a classification.** A disagreeing fill
  instant, or a second `CANCELED` observation of the order with another
  `timestamp`, makes T the hull of what it was and the new instant. Every
  observation already classified STALE against the narrower T is then
  compared again, and anything but STALE raises the halting conflict: the
  proof it was cleared on no longer holds.
- **Why the latest fill, and not the completing one** (`CX034-R1-04`). The OMS
  completes an order when the fills it has *received* sum to its size
  (`order-manager.ts:1267-1271`). The fill that arrives last can be an
  earlier match. T is computed from all the fills, independently of arrival
  order and of REST pagination.
  - Example: fills `5@200` then `5@100` (ms) give `C = [199, 201)`, so a `LIVE`
    at 150 is STALE. Taking the arrival-order completing fill (`[99, 101)`)
    would have made it NEWER, and halted.
- **A PENDING T is fixed** by the first later venue-timed evidence of the same
  terminal fact, for the same venue order id: a `CANCELED` observation for a
  canceled order, or the fills' instants for a filled one.
- **T is recorded.** T, its unit and the kind of evidence that fixed it are
  recorded in the payload of the order event that fixed it
  (`execution.order_events.payload` is `jsonb`).

**D1.4 The comparison.** Let L be the observation's interval and T the
terminal interval, both widened as D1.2 says.
- **STALE**: L ends no later than T starts (`L.hi ≤ T.lo`).
- **NEWER**: L starts no earlier than T ends (`L.lo ≥ T.hi`).
- **UNORDERED**: anything else. It has two kinds:
  - **OPEN**: T is PENDING, or T rests on a fill instant still in `S` (its
    `MATCHED` event could still narrow it). Venue-timed evidence may yet order
    the pair.
  - **CLOSED**: the intervals overlap, and both are final `MS` intervals.
    Venue time will never order the pair. This covers equal and adjacent
    milliseconds.

Ties are never STALE and never NEWER.

**D1.5 The outcomes.**

| Classification | Outcome |
| --- | --- |
| **STALE** | Recorded as an `OBSERVATION_STALE` order event (source `polymarket`; payload: the status, L, T, T's evidence kind, `rule: "VENUE_TIME"`). No state change, no alert, no read, no halt. A metric and a structured log line count it |
| **NEWER** | Today's behaviour, unchanged: the halting `EVIDENCE_CONFLICT`, the reopen to RECONCILING with a state conflict, and a fresh authoritative read |
| **UNORDERED, CLOSED** | The halting conflict, **at once**. Venue time cannot order the pair, and D1 lets nothing else order it (D1.6) |
| **UNORDERED, OPEN** | A **hold**, described below |

**The hold** (UNORDERED, OPEN):
- It is recorded as an `OBSERVATION_UNORDERED` order event, and **no alert is
  raised**.
- The order keeps its terminal state. A hold is a durable marker, not a new
  state, so ADR-007 §1's state machine is unchanged.
- **While any hold on the order is open** (`MEDIUM-1`):
  - **The group's salt gate is closed.** An open hold is a gate blocker
    (`#saltGate`, `order-manager.ts:2384`). That **re-closes** a gate which a
    read had already opened: in routes 1 and 2, the read has fixed the final
    size before the late frame lands.
  - **An unconsumed reservation stays held.** `#maybeRelease`
    (`order-manager.ts:2346-2379`) also waits for no open hold.
  - **A reservation already released stays released, and is not re-taken.**
    The order is still terminal in the OMS's view, and no other order can use
    the freed amount meanwhile: every submission is paused (next bullet).
  - **Submissions are paused at once.** The OMS issues a reconciliation
    request with a new purpose, `ORDERING`, and a fresh token (ADR-032 D4).
    Its receipt pauses every submission of the account at once: the
    coordinator's `trigger` calls `#hold`, which calls `oms.pause()`
    (`packages/oms/src/reconciliation/coordinator.ts:679-684`, `:3334-3338`).
  - **`resume()` refuses** while any hold is open, exactly as it does for an
    order in RECONCILING, so no run resumes the account.
- **The hold resolves by venue time, or it halts** (`CX034-R1-01`):
  1. **Venue-timed terminal evidence arrives:** a `CANCELED` observation, or a
     fill or `MATCHED` event that fixes or narrows a fill instant. Every open
     hold on the order is compared again:
     - STALE closes it (`rule: "VENUE_TIME"`). When no other hold on the
       order remains open, the OMS supersedes its `ORDERING` request with an
       `ORDER_STATE` request for the same attempt, which the coordinator
       answers without the horizon below. That read still checks that the
       order is not open;
     - NEWER raises the halting conflict;
     - UNORDERED, OPEN keeps it open;
     - UNORDERED, CLOSED raises the halting conflict.
  2. **The read answers the `ORDERING` request:**
     - `PRESENT`, with the order open: the halting conflict. This is today's
       "an order believed terminal is open at the venue";
     - `UNRESOLVED` or `ABSENT`: the halting conflict;
     - `PRESENT`, with the order terminal: this orders nothing, because a read
       carries no instant of its status (A F-93). The coordinator gives this
       answer only from a read that began at least
       `policy.orderingHorizonMs` after it received the request, by its own
       clock. The run must also have routed every stream output received
       before its reads began, and no stream activity output may have arrived
       during it (r14's buffer rule). Before then, the request stays
       unanswered, the hold stays open, and submissions stay paused; the next
       run reads again. This mirrors WP-290's quiescence rule
       (`coordinator.ts` header, "Quiescence"). Once the answer is given, a
       hold that venue time has still not closed raises the halting conflict:
       "venue time could not order a LIVE-class observation of a terminal
       order".
- **The read never classifies STALE.** Round 0 let a terminal read close a
  hold as STALE ("READ_AFTER"). Then the same evidence (a cancel at 100 whose
  answer left T PENDING, and a `LIVE` at 200) cleared or halted according to
  which arrived first: the read, or the `CANCELED` frame. That rule is
  withdrawn.
- **`orderingHorizonMs`** is configured, beside `quiescenceHorizonMs`. It must
  exceed how long a terminal frame can lag its cause. No venue fact bounds
  that lag (U-52). Its live value needs the same decision as
  `quiescenceHorizonMs` ("Needs an ADR before any live mode",
  `docs/runbooks/reconciliation.md`, the policy table).
- **Bounds and restarts.** Open holds are bounded like retained evidence
  (`MAX_RETAINED_EVIDENCE`), and one beyond the bound halts. The marker is
  durable. A restart re-issues the `ORDERING` request for every open hold (the
  horizon then runs from the new receipt), and raises no alert for it. Today
  recovery re-raises only real conflicts (`order-manager.ts:2905-2909`).

**A missing instant fails closed** in both directions:
- a missing L is refused at the port (D1.2);
- a missing T is PENDING, so the observation is held. Nothing is released
  while the hold is open, and it halts unless venue time orders the pair as
  STALE before the horizon read.

**D1.6 Why this is the ruling.**
- **STALE needs a proof in venue time,** and only that: L ends before the
  earliest instant T can have, both widened by a unit. No read and no
  inference about lifecycles classifies an observation STALE.
- **A strictly newer observation always halts.** When T is known, it halts at
  once. When T is PENDING, the observation is held, and the hold ends in a
  halt whichever comes first: T, which shows NEWER, or the horizon read,
  which finds the hold still open. Whether it halts never depends on arrival
  order.
- **Arrival order can change the outcome in one direction only.** A STALE
  observation is cleared if its T arrives before the horizon read, and halts
  otherwise. That costs liveness, never safety.
- **A STALE classification releases nothing the existing rules hold.** A new
  salt still needs the group's final matched size from an authoritative read
  ("THE SALT GATE", `order-manager.ts` header).

**D1.7 If the venue's `timestamp` means something else** (U-52):
- **If it names the emission or the delivery,** a delayed frame looks NEWER
  and halts. That is today's behaviour: a cost to liveness, not to safety.
- **If it named an instant earlier than the change,** a LIVE-class `UPDATE`
  might be judged STALE. But an `UPDATE` reports a match ("Some or all of the
  order matched", A F-89). That fill still reaches the OMS's fill checks, and
  a fill beyond a confirmed final size halts. No new salt opens without a read
  made after the terminal evidence either.
- So a misread instant can cost liveness, not exposure. The first
  authenticated observation checks the reading (Open item 2).

**D1.8 ADR-002 and §6 invariant 15.**
- The OMS still applies each observation when it arrives, in arrival order.
- The venue timestamp is read as data, to classify that observation ("A venue
  timestamp is data, not an order", ADR-002 §2.2). Nothing is reordered,
  buffered for reordering or replayed by venue time.
- Only instants the process has received are compared, so §6 invariant 15
  holds.
- PAPER and replay run no OMS, so their order is untouched.

**D1.9 What changes, and where.**
- **`packages/oms`:**
  - `OrderObservation` gains a required `venueInstant` (`{ value, unit }`);
    `FillReport` gains an optional one;
  - T, the hold markers and their classifications live in order-event
    payloads;
  - `#applyObservation`'s terminal branch implements D1.4 and D1.5;
  - `ReconciliationPurpose` gains `ORDERING`;
  - `#applyPresent` resolves holds; `#saltGate` and `#maybeRelease` gain the
    hold as a blocker;
  - recovery re-issues an `ORDERING` request for each open hold.
- **WP-280 (`packages/polymarket-secure/src/user-stream/**`):**
  `oms-projection.ts` passes `venueTimestamp` into the observation, and into a
  fill projected from a `MATCHED` event only. The normalizer already reads
  both.
- **WP-290 (`packages/oms/src/reconciliation/**`):**
  - fills from `/data/trades` carry `matchedAt` with unit `S`;
  - `ReconciliationPolicy` gains `orderingHorizonMs`, and the coordinator
    answers an `ORDERING` request under D1.5's rule;
  - no new read route: `/data/order` has no state-change instant (A F-93), and
    `match_time_nano` is unavailable through SDK 0.12.0 (A F-95).
- **No domain contract and no new dependency edge.** No migration is needed
  today, since no PostgreSQL OMS store exists yet. A fill's venue instant
  joins Open item 4's list for that store.

**D1.10 Test obligations.**
1. **The four `it.fails` pins** in `test/fault-injection/live/findings.test.ts`
   (`:115`, `:152`, `:177` filled and canceled) become plain `it` tests and
   pass. The four "TODAY" tests, which assert the halt, are removed: the
   behaviour they pin no longer exists.
2. **`support/expected-releases.ts` goes to 0.** Every population is 0:
   - each `CRASH_MATRIX_F1` entry;
   - `crashNamedPins`, `crashProperty`, `streamNamed` and `streamProperty`;
   - `releaseDriver`.

   Each suite's pin asserts 0. `report.test.ts` and the §5 table of
   `docs/experiments/phase-3-verification.md` read 0.
3. **`release-driver.test.ts`.** Its positive controls build a genuine F1,
   which can no longer occur. They are replaced by two pins: the driver
   releases nothing, and a NEWER LIVE's halt is not released. The driver may
   then be deleted.
4. **Frames carry real instants.**
   - The live mock (`support/mock-clob.ts`, `support/user-channel.ts`) and
     WP-290's harness (`test/fault-injection/reconciliation/support/wp280.ts`,
     `world.ts`) stamp each frame with the venue instant of the change it
     reports, on the shared time line: milliseconds for `timestamp`, seconds
     for `match_time`. They stop using one constant.
   - The mock's venue clock gives each venue change its own instant, at least
     2 ms after the previous one, so that widened instants (D1.2) can order
     them.
   - The mock emits a `CANCELLATION` frame for every cancel, a REST cancel
     included.
   - These are labelled mock assumption **A10**: a reading of U-52 and U-54.
   - The live suite's `orderingHorizonMs` is at most its
     `quiescenceHorizonMs`, which `reconcileUntilResumed` waits between runs
     (`support/live-node.ts:695`).
5. **Unit tests in `test/unit/oms/**`:**
   - STALE, NEWER, UNORDERED CLOSED (equal and adjacent milliseconds: a halt
     at once) and UNORDERED OPEN (a PENDING T; a `S` T: a hold);
   - **the widened interval** (`MEDIUM-2`): with T from `match_time`
     1790000001, a `LIVE` at 1790000000900 is held, not STALE, and a `LIVE` at
     1789999999899 is STALE;
   - **arrival order** (`CX034-R1-04`): fills `5@200` then `5@100` give a T
     of `[199, 201)`, and a `LIVE` at 150 is STALE. A REST read whose fills
     come in two pages, in either order, gives the same T. A seconds fill
     instant is narrowed by its `MATCHED` event, and a disagreeing one makes
     the hull. A hull that undoes an earlier STALE raises the halting
     conflict;
   - **both permutations** (`CX034-R1-01`). A cancel answer (T PENDING) is
     followed by a `LIVE` at 200:
     - then `CANCELED@100`, or the horizon read finding the order CANCELED,
       in either order: a halt in both;
     - with the `LIVE` at 50 instead: `CANCELED@100` before the horizon read
       makes it STALE, and the horizon read first makes it a halt;
   - **the horizon:** a read that began before `orderingHorizonMs` gives no
     answer, and neither does a run during which a stream output arrived;
   - **the hold's protections** (`MEDIUM-1`): in route 2's state (final size
     fixed, gate open, reservation released), a hold closes the gate, the
     reservation stays released, the OMS is paused, and `resume()` refuses
     until the hold resolves;
   - EXPIRED with a PENDING T; a retained observation drained with its own
     instant; a `MINED` event's `timestamp` never used as a fill instant;
   - `DELAYED` and `UNMATCHED` behave as `LIVE`; an unrecognised status still
     halts; an observation without an instant is refused; a hold survives a
     restart as an `ORDERING` request with no alert.
   - **Mutation rows,** each failing a named test: flip the comparison; read
     ties as STALE; drop the widening; take the arrival-order completing fill;
     let a terminal read close a hold as STALE; drop the horizon; let a hold
     resume; drop the hold's gate blocker.
6. **A seeded property** over frame delays shorter than the horizon,
   duplicates, and the order of terminal frames against the horizon read, in
   a truthful mock: no halt. With an injected contradiction (a LIVE stamped
   after T): always a halt, in every permutation. With the terminal frame
   dropped: a halt, never a STALE.

**D1 is pre-live only.** PAPER runs no OMS (the core consumes simulated
orders; `CLOSEOUT-3` N2), so no PAPER output or golden changes.

### D2. One executable quantity (`CO3-N1`)

**D2.1 The grid.**
- An order's **input quantity** is on the venue's 0.01 grid. That is shares
  for a limit order and for a FAK or FOK SELL, and pUSD for a FAK or FOK BUY
  (D4). "Size decimals" is 2 for every tick size (A F-99, F-101).
- The price stays on the market's tick grid.
- The planner reads the grid from the documented table, keyed by the market's
  tick size (A F-99). The tick size is already a versioned parameter (§6
  invariant 9), and every tick size gives 0.01 today. An unknown tick size is
  refused, as the SDK refuses it ("Unsupported tick size", `context.ts` line
  30; A F-101).

**D2.2 One place: the execution planner.** `packages/execution-planner`
quantizes, in one function, every quantity a planned order carries:
- entries, slices, exits and collateral targets;
- before the plan's reservation requirements are emitted.

It slices on the grid, and refuses as incoherent a slice policy
(`maxSliceShares`) that is off the grid.

**D2.3 An off-grid request is quantized down, and the remainder is recorded.**
- The planner floors the requested quantity to the grid. It records
  `unexecutableRemainder` with a reason, `SUB_GRID`, on the planned order. The
  intent-to-plan link keeps both numbers, the requested and the executable.
- **The minimum.** A quantity that floors to 0, or whose order falls below the
  market minimum, is refused as today (`PLAN_BELOW_MINIMUM_ORDER_SIZE`). The
  quantity compared with `min_order_size` (`MEDIUM-5`) is:
  - for a limit order, or a FAK or FOK SELL: the executable shares;
  - for a FAK or FOK BUY: the signed share side, `ceil` at the tick's Amount
    decimals of `collateralTarget ÷ limitPrice` (A F-101). That is how the
    documentation's market-order example judges a BUY: by the shares it
    computes, against "the five-share minimum in the order book" (A F-105;
    that it is the CLOB's general rule is an inference).
  - This is the share reading of C-7. Under the other reading, a notional,
    the collateral target itself would be compared. The planner keeps the
    share reading (Open item 5).
  - Example: 5 shares, with a limit and a best ask of 0.347 (tick 0.001,
    Amount decimals 5), give a target of 1.73 and a share side of 4.98560.
    That is below 5, so the order is refused, in PAPER as in live.
- **Why down, and not a refusal:**
  1. **Off-grid quantities arise without anyone choosing them.** F-63
     computes fills in base units, so positions get up to six decimals. A
     collateral-targeted BUY does this (`V2-10`'s probe B: 50.857142). So does
     a partial fill of a resting BUY, through F-63's floor on its share count
     (`V2-10` round-0 handoff, known risk 3). Refusing the exit would strand
     the position.
  2. **Flooring only shrinks an order risk has approved.** The reservation and
     the exposure shrink and never grow. Rounding up would exceed the
     approval.
  3. **The SDK floors anyway** (A F-101). Doing it once, upstream and
     recorded, is what makes the OMS, the reservation, reconciliation and the
     signed order agree.
  4. **Nothing is silent.** The remainder is on the plan, and D4.3 says what
     becomes of it.
- **The OMS and the adapter never round.** They refuse (D2.4).

**D2.4 Guards. These are checks, not second quantizers.**
- **The OMS ticket door** (`readTicket`) refuses an off-grid quantity with
  `OMS_SIZE_OFF_GRID`. It does so before the PLANNED row and before `reserve`,
  so nothing is reserved, signed or sent.
- **Static Bracket's configuration door** refuses an off-grid `size_shares`,
  or any other configured share quantity, at load. An operator cannot
  configure a size the venue cannot execute.
- **The adapter's cross-check** (`signedOrderMatchesRequest`) recomputes the
  signed amounts from the request, exactly, by order kind (`LOW-2`). Today it
  accepts a share amount rounded down by less than 0.01
  (`venue-client.ts:312`, `:369-383`). In base units (× 10^6):

  | Order | `makerAmount` | `takerAmount` |
  | --- | --- | --- |
  | GTC or GTD BUY | shares × price, exactly | shares, exactly |
  | GTC or GTD SELL | shares, exactly | shares × price, exactly |
  | FAK or FOK BUY | `collateralTarget`, exactly | `ceil` at Amount decimals of `collateralTarget ÷ maxPrice`, the SDK's protected rounding (`amounts.ts:91-100`; A F-101) |
  | FAK or FOK SELL | shares, exactly | shares × `minPrice`, exactly |

  - Every "exactly" holds because on-grid inputs need no rounding (A F-102).
    The FAK or FOK BUY's share side is a division, so its rule names the
    rounding instead.
  - Anything else is `FAILED`, so no order exists (WP-260). A later change in
    the SDK's rounding then fails closed at signing.
- **The OMS's `identityMismatch`** also compares the signed amounts with the
  order's quantities, by the same table. Today it compares token, side,
  post-only, expiration and type only (`order-manager.ts:3028-3037`).

**D2.5 One number everywhere.** The planned order's executable quantity is,
exactly:
- the reservation basis (a limit BUY reserves price × shares; a SELL reserves
  shares);
- the OMS ticket and its `originalShares`;
- the signed share amount;
- the venue `original_size` that reconciliation compares (`matchesExactly`,
  unchanged);
- the size the mock books.

For a FAK or FOK BUY the one number is the collateral target, and D4.2 says
what each party compares.

**D2.6 Test obligations.**
1. **The closeout's probe E01 becomes a regression** in
   `test/fault-injection/live/`, in both arms (acknowledged, and lost answer).
   The probe is `~/pmb-rounds/closeout-3/E-architecture-probes.test.ts`,
   sha256 `bc23ce684d0d962aa9628874b2192cad763a43e1eabfe2ea2ffc934422bc80c4`,
   outside the repository.
   - A ticket of 5.009 shares at 0.5 is refused `OMS_SIZE_OFF_GRID`: no
     reservation, no signature, no venue receipt.
   - The planner turns a request of 5.009 into a planned order of 5.00, with
     a remainder of 0.009.
   - That order signs `takerAmount` 5000000, the mock books 5.00, and the OMS
     holds 5.00.
   - The reconciliation run resumes with no break in both arms. Today it
     breaks with `ORDER_FACTS_MISMATCH`, and with `SIGNED_IDENTITY_AMBIGUOUS`
     plus `ORDER_UNRESOLVED`.
2. **The mock venue books the signed amounts.** Its `original` and matched
   quantities come from the signed maker and taker amounts, never from the
   request (`mock-clob.ts:525-537`). `mock-venue-facts.test.ts` checks the
   rounding against A F-101.
3. **A fake-SDK case** signs a share amount one base unit away from the
   ticket. Signing returns `FAILED`, and no attempt is recorded as sent.
4. **Unit tests:**
   - the quantizer, on exact decimals, for every tick size, both sides, and
     collateral inputs;
   - slicing on the grid;
   - the recorded remainder;
   - the configuration door;
   - the cross-check table, one row each, with a one-base-unit deviation
     refused.
5. **Every replay golden stays byte-identical,** since the shipped sizes are
   on the grid.

**D2 is pre-live, with a latent PAPER change.** The planner is shared, so
off-grid quantities floor in PAPER too. No shipped size is off the grid, so no
golden moves in this round.

### D3. Time-in-force, carried end to end (`CO3-N2`)

**D3.1 One persisted value**, `timeInForce`, which is `GTC`, `GTD`, `FAK` or
`FOK`, for each planned order.
1. **Resolved as today** by `resolveTimeInForce`: the tag, else the instance's
   configuration, else a refusal (`pipeline.ts:113-150`).
2. **Carried on the plan.**
   - `PlannedOrder` gains `timeInForce`, plus `expirationUnixSeconds` for GTD
     and `deadlineAt` for a deadline-bounded GTC.
   - The `OrderTimeInForceBook` side table goes away. The simulator's
     `ExecutionPolicy.timeInForceFor` reads the plan.
   - PAPER and live then read one value from one core.
3. **Carried on the OMS ticket.**
   - `OrderTicket.timeInForce` is required, and nothing is inferred from the
     expiration.
   - It is persisted on the order (`OrderRecord.timeInForce`) in the same
     transaction as the PLANNED row, before reservation. It is also copied into
     the PLANNED event's payload.
   - Its `execution.orders` column needs a migration, which is a protected
     path (Open item 4).
4. **Carried to the SDK call.**
   - `OmsVenuePort` gains `createMarketOrder`.
   - `SdkSecureClientPort` gains the SDK's `createMarketOrder`. It is a
     `create*` member, so the port still has no `place*` member
     (`sdk-port.ts:18-22`).
   - The adapter validates its request and cross-checks its signed amounts by
     D2.4's table.
5. **Kept on retransmission.** `orderType` and `expiration` are unsigned wire
   fields (A F-81, F-85). A retransmission (ADR-007 §2 step 9) re-posts the
   persisted signed order unchanged. A restored envelope whose `orderType` or
   `expiration` differs from the order's persisted time-in-force is refused.

**D3.2 The mapping** (A F-83, F-84):

| `timeInForce` | SDK method | Request | Signed |
| --- | --- | --- | --- |
| GTC | `createLimitOrder` | `{ assetId, side, price: limit, size: shares, postOnly? }`, no `expiration` | `orderType` GTC, `expiration` 0 |
| GTD | `createLimitOrder` | the same, plus `expiration` in Unix seconds | GTD, that expiration |
| FAK | `createMarketOrder` | BUY: `{ assetId, side: BUY, amount: collateralTarget (D4), maxPrice: limit, orderType: FAK }`. SELL: `{ assetId, side: SELL, shares, minPrice: limit, orderType: FAK }` | FAK, `expiration` 0 |
| FOK | `createMarketOrder` | as FAK, with `orderType: FOK` | FOK, `expiration` 0 |

Never sent:
- **`maxSpend`.** Its fee adjustment is JavaScript `number` arithmetic, and it
  changes the signed amount (A F-84).
- **`builderCode`.**
- **An unprotected market order,** one without `maxPrice` or `minPrice`. The
  SDK would read the book and choose the price itself (A F-84). The limit is
  always the plan's capped marketable limit (§9.10).

**D3.3 Refusals before signing.** Each is refused at the earliest door that
can see it, and none reaches the SDK:
- **No value or an unknown one:** refused by the core, as today, and again at
  the OMS door (`OMS_TIME_IN_FORCE_UNSUPPORTED`). That includes `IOC` and any
  other value outside the four (C-24).
- **A mismatched expiration:** GTD without one; GTC, FAK or FOK with one.
- **Post-only with FAK or FOK** (A F-81). The OMS door and the adapter refuse
  it, and they are the only protection on this path (`LOW-3`).
  `createMarketOrder`'s input schema is a non-strict `z.object`, which strips
  an unknown `postOnly`, and its draft carries no `postOnly` (A F-84). So the
  SDK's own post-only invariant (A F-85) can never fire on a market order.
- **A misplaced collateral target:** a FAK or FOK BUY without one, or a GTC,
  GTD or SELL order with one (D4).
- **A FAK or FOK BUY-to-close** (D4.1, D4.3).
- **A GTD below the floor.**
  - The core has the clock. It sets `expiration = deadline + 60 s` (the
    venue's security threshold, A F-79). It refuses GTD when `expiration <
    now + 180 s + margin`. The SDK checks 180 s against the host clock (A
    F-83). Its own documentation asks for that margin: "Add your own buffer
    for network latency and clock skew when deriving an expiration from the
    current time" (`LOW-4`; A F-83, `dist/types-B9F4CyS-.d.ts` lines
    5852-5854).
  - The OMS is clockless and checks the shape only.
  - The SDK's check is the last guard. Its `UserInputError` maps to `FAILED`,
    so no order exists.

**D3.4 ADR-007 §8's obligations.** A lifetime below the GTD floor, about two
minutes effective (A F-79), is met in one of two ways. The plan chooses
between them; the OMS never does.
- **Immediately,** with FAK or FOK. These never rest (A F-80).
- **Resting,** with GTC and a cancel at the deadline:
  - **The request.** The core's clock calls the OMS's `requestCancel` at the
    deadline. It is filed at `EMERGENCY_CANCEL`, because it enforces a
    lifetime bound: "Safety cancellation outranks new order placement"
    (§6 invariant 13; §9.13; `packages/polymarket-secure/src/rate-limit/priority.ts`).
  - **Persisted.** The deadline is persisted with the plan
    (`execution.plans.deadline_at`, migration `0005`), and re-armed after a
    restart.
  - **Retried** (`CX034-R1-06`). A cancel the budget defers or refuses, or
    whose answer is `NOT_CANCELED` or unknown, is requested again, until the
    order is known terminal. That goes on at most until `deadline +
    deadlineEscalationMs`, a configured bound.
  - **Escalated.** An order still not known terminal at that bound is §9.9's
    failure "Account state unknown" (`ACCOUNT_STATE_UNKNOWN`,
    `packages/risk/src/recommendations.ts`). Its default action is "Stop
    heartbeat, cancel, reconcile, full halt":
    - the core raises the incident, with cause `DEADLINE_CANCEL_OVERDUE`, and
      new entries in the account are refused from then;
    - the order goes to reconciliation. It is never assumed gone (ADR-007
      §10);
    - in a live composition, the Incident Controller's explicit heartbeat
      stop (ADR-033 D1 item 4) is engaged:
      `LiveSafety.stopHeartbeat("INCIDENT_CONTROLLER", …)`
      (`apps/trader/src/live-safety/live-safety.ts:636-640`). It stays
      **latched until an operator releases it**. The venue then cancels every
      open order of the credentials (ADR-008; ADR-033 D6), whatever the cancel
      route's rate limit.
  - **Why the stop must be explicit** (a correction of round 0, which relied
    on the lapse). Venue calls are not OMS health
    (`apps/trader/src/live-safety/oms-progress.ts:43-54`). So a refused or
    rate-limited cancel can coexist with healthy heartbeats, and a read that
    finds the GTC order open and consistent cancels nothing. Nothing would
    lapse by itself.
  - **The bound this gives.** The order can outlive its deadline by at most
    `deadlineEscalationMs`, plus ADR-008's heartbeat timeout and check
    interval.
  - **Who wires it.** R3 implements the deadline hook, the retries and the
    incident. Mapping the incident to the explicit stop belongs to the live
    composition root (Open item 8). It is a precondition of any
    deadline-bounded GTC above PAPER, with its fault test (D3.7 item 8).

Static Bracket's passive entry with `convert_to_aggressive_after_ms` is of the
second kind, and so is a GTC limited by the example's `order_validity_ms`.

**D3.5 Answers to FAK and FOK orders** (refining ADR-007 §5):
- **`matched`.**
  - A FAK may fill fully or partly; "Any unfilled remainder is canceled" (A
    F-80). The order is terminal at the answer: FILLED if the answer's
    amounts complete it, otherwise CANCELED with its matched part.
  - A FOK `matched` is FILLED.
  - For a collateral-targeted BUY, what the answer's amounts hold is U-51. The
    OMS holds it terminal, with its final size unknown until the read.
  - The final size is fixed only by an authoritative read. That is the salt
    gate's rule, unchanged.
- **`delayed`:** DELAYED, as today. A delayed market can delay an immediate
  order (A F-80).
- **`live` or `unmatched`:** these contradict "A market order never rests on
  the book" (A F-80). The order goes to RECONCILING with a fresh read, and is
  never assumed filled or canceled. A read that finds it open raises the
  halting conflict.
- **A FOK that cannot fill whole.** Its answer is undocumented (U-49). Unless
  it is a documented rejection, it is UNKNOWN (ADR-007 §6) and reconciled. It
  is never a rejection by assumption.
- **The taker delay on our series** (A F-87). "The API waits for this hold and
  returns the final order result", and meanwhile the order "cannot be
  canceled". The OMS sends no cancel for a FAK or FOK in flight.

**D3.6 Within ADR-022 D10.**
- The core-side changes are a bounded `packages/trading-core/**` grant at the
  round's authorization:
  - the plan's time-in-force reaches the execution port instead of a side
    table;
  - the deadline-cancel hook, its retries and its incident (D3.4);
  - the venue builder passes `fokFakBuyTarget` (D4).
- The OMS and the adapter keep their layers, and attach through the core's
  ports. No dependency edge is added from the core to `packages/oms` or
  `packages/polymarket-secure`.

**D3.7 Test obligations.**
1. **Probe E02 ported, for FAK and FOK.** The OMS signs `orderType` FAK or FOK
   through `createMarketOrder`. Today it signs GTC.
2. **A composed FAK-remainder case:**
   - a partial fill, and the venue cancels the remainder;
   - the order is terminal with its matched part;
   - a read fixes its final size;
   - the unused reservation is released.
3. **A FOK partial-liquidity case.** The mock's kill answer is a labelled
   assumption (U-49). The OMS follows D3.5, opens no new salt until the read
   resolves the order, and never exposes the position twice.
4. **A refusal test for each D3.3 case:** no reservation, no signature, no
   venue receipt. The post-only case asserts that the refusal comes from our
   door, before any SDK call.
5. **Real-SDK contract tests behind the network tripwire,** as V2-5's 0.12
   tests do:
   - the signed amounts of a protected BUY and a protected SELL from
     `createMarketOrder`, against D2.4's table;
   - `expiration` is 0, and `orderType` is as requested.

   `v2-5.test.ts`'s port pin moves to eleven members, and keeps its no-`place*`
   rule.
6. **A restart test.** A restored signed order keeps its `orderType`, and a
   restored payload whose `orderType` was altered is refused.
7. **The PAPER goldens do not change for D3 alone.** The time-in-force values
   are the same; they now come from the plan.
8. **The deadline escalation** (`CX034-R1-06`):
   - **in R3,** the deadline cancel is refused by the budget on every try,
     and everything else is healthy. The cancel is retried at
     `EMERGENCY_CANCEL`. At `deadline + deadlineEscalationMs` the
     `ACCOUNT_STATE_UNKNOWN` incident is raised, new entries are refused, and
     the order is in reconciliation. One mutation row lets the retries run
     unbounded, and fails the test;
   - **in the live composition round, before any mode above PAPER,** the
     same, with heartbeats succeeding throughout: the heartbeat gate closes
     at the bound and stays closed until an operator release.

**D3 is pre-live for the OMS and the adapter.** For PAPER it is plumbing only,
with no change in output.

### D4. Collateral-targeted FAK and FOK BUYs, and exits sized by the held position (`V2-10B`)

**D4.1 The conversion is made once, at plan time, by D2's quantizer:**

`collateralTarget = floor₀.₀₁(plannedShares × min(limitPrice, bestAsk))`, in
pUSD.

- **`bestAsk`** is the best ask of the leg's token in the planning snapshot,
  which the planner already receives (`MarketBookInputs`,
  `packages/execution-planner/src/inputs.ts:57-62`; the core passes it,
  `packages/trading-core/src/pipeline.ts:446`). With no best ask, a FAK or FOK
  BUY is refused (`PLAN_BOOK_REQUIRED`): no bound could be computed.
- **Why the best ask, and not the limit** (`CX034-R1-02`).
  - Every fill of the order is at or below the limit. While no ask below the
    snapshot's best ask appears, every fill is also at or above that best
    ask. Then the shares bought are `Σ cᵢ ÷ pᵢ ≤ collateralTarget ÷ bestAsk ≤
    plannedShares`.
  - So the strategy's share caps, which it checks on `plannedShares` at the
    same snapshot, hold for the fill too: `maximum_position_shares` and
    `maximum_book_participation` (`applyEntryCaps`, `decide.ts:1194-1207`,
    `:1248-1265`).
  - The money caps hold too: the target is at most `plannedShares × bestAsk`,
    which is at most the strategy's quote cost for `plannedShares`, which it
    checked against `maximum_total_cost` and `maximum_contractual_loss`
    (`decide.ts:1210-1231`). Fees come on top, and the reservation covers
    them (D4.2).
  - **At the limit price** (the round's packet; `V2-10`'s
    `collateralTargetAtLimitPrice`), the target buys more than
    `plannedShares` whenever the book asks less than the limit. 50 at a limit
    of 0.35 is a target of 17.50: it buys 51.470588 shares if it all fills at
    0.34, and probe B's book (0.34 × 30, then 0.35) bought 50.857142. Both
    exceed the handoff's §13.2 reference configuration, whose
    `maximum_position_shares` equals its `size_shares` (50). Checking the
    caps on that larger count instead would refuse every such entry. This is
    a named departure (Relation; Open item 9).
- **What it costs.** When the order must walk above the best ask, it buys
  fewer than `plannedShares`. Over probe B's book (0.34 × 30, then 0.35), the
  target is 17.00, which buys 30 + 19.428571 = 49.428571. The intent's
  partial-fill policy governs that, as for any partial fill.
- **Why 0.01.** The SDK floors a market BUY's amount to "Size decimals" (A
  F-101), and the documentation says "Round the price and input amount down …
  to the table's … Size decimals" (A F-99).
- **Recorded.** The target is recorded on the planned order and on the OMS
  ticket, and it is exactly the signed `makerAmount`. `plannedShares` stays
  on the plan as the strategy's intended size.
- **Only FAK and FOK entry BUYs convert.** GTC and GTD BUYs, and every SELL,
  target shares (F-63; A F-82). A BUY-to-close never converts: it is
  share-targeted (D4.3), and the planner refuses a FAK or FOK BUY-to-close
  (D3.3).
- **The minimum** is checked on the signed share side (D2.3; A F-105).
- **A departure from `V2-10`.** Its `collateralTargetAtLimitPrice` converts
  at the limit price and floors to whole base units (6 decimals). D4 converts
  at `min(limitPrice, bestAsk)`, for the caps, and floors to 0.01, because the
  SDK signs that amount and the simulator must match it. Authority: handoff
  §13.2 for the first (its `risk` block), and the venue documentation and the
  SDK for the second (handoff §1.1).

**D4.2 The OMS and reconciliation, for a collateral-targeted BUY.**
- **When fills exceed `plannedShares`** (an ask below the snapshot's best ask
  was taken):
  - the excess is real and is kept: no rule can undo a fill;
  - the OMS allocates it (attribution, below), and raises a non-halting
    `ENTRY_SHARE_BOUND_EXCEEDED` alert, with a metric;
  - the strategy's caps count the actual position at once, so no further
    entry is admitted while it exceeds them;
  - the exit sells the actual position (D4.3).

  Why the alert does not halt: a halt cannot undo the fill, and a market
  quarantine would block the exit that reduces it.
- **The share bounds do not apply.** "Matched ≤ original" in `#applyPresent`
  and "a fill beyond the order" (`#fillInconsistency`) do not apply to such an
  order. Its fills exceed the signed `takerAmount` whenever the book asks
  less than the limit: "ExchangeV3 reduces a BUY's remaining collateral budget
  by the amount actually spent" (F-63).
- **A collateral bound applies instead, per maker leg** (`CX034-R1-05`).
  - F-63 floors each maker fill: `counterAmount = floor(makerAssetFill ×
    takerAmount / makerAmount)`. One OMS fill can aggregate several maker
    matches. WP-280 emits one fill per own taker leg, of the summed maker
    amounts, and requires every maker leg at the fill's price
    (`oms-projection.ts:180-191`, `:235-247`).
  - So `FillReport` carries the fill's maker legs: their matched amounts.
    They come from the stream's `maker_orders` and from the REST trade's
    (A F-106).
  - Over the order's `n` distinct maker legs, the collateral it spent, `S`,
    satisfies `Σ(m × p) − n × 10⁻⁶ < S ≤ Σ(m × p)`. That holds for every
    maker whose signed amounts equal its price, which on-grid makers do (A
    F-102). For any other maker it is an inference.
  - The venue never spends more than the target. So a contradiction is
    `Σ(m × p) − n × 10⁻⁶ ≥ collateralTarget`, and it halts as today.
    Example: three legs of 16.666668 at 0.35 give `Σ(m × p)` = 17.5000014,
    below 17.50 + 0.000003, so they pass.
  - A duplicate delivery counts once. Fills are deduplicated by trade id,
    order id and discriminator (§10.7), so the allowance is not multiplied.
- **The group's remaining is in collateral.** For such a group, the salt
  gate's `remaining` (`#saltGate`, `order-manager.ts:2384`) is the target less
  `Σ(m × p)` of its orders' fills, and 0 when that falls below 0 within the
  leg allowance. Shares beyond `plannedShares` never trip the gate's
  invariant ("a group's final sizes exceed its plan").
- **Attribution** (`MEDIUM-3`).
  - The ticket's attributions still sum exactly to `plannedShares`
    (`order-manager.ts:294-295`).
  - Fills are allocated by the sequential bands, as today (`allocatedAt`,
    `:631-646`; `allocationsFor`, `:3062-3075`).
  - For a collateral-targeted BUY, the **last band is open-ended**: shares
    beyond Σ attributions are the last attribution's.
  - So nothing is UNATTRIBUTED (§6 invariant 7). Example: bands of 30 and 20,
    and fills of 51.470588, allocate 30 and 21.470588.
- **Identity, by what the reads carry** (`HIGH-1`).
  - **What a read exposes** of an order: its token, side, price,
    `original_size`, `size_matched` and `order_type` (A F-93). The SDK's
    `OpenOrderSchema` strips any other key. No read carries a maker or taker
    amount (A F-106, PROBE PR-3).
  - **So the signed amounts are compared at signing** (D2.4), from the
    persisted signed order, and not in reconciliation.
  - **What reconciliation compares** for a FAK or FOK order: token, side and
    `order_type`. Under the labelled assumption **A11** it also compares:
    - `original_size` = the signed share side ÷ 10^6 (`takerAmount` for a
      BUY, `makerAmount` for a SELL);
    - `price` = the order's limit (`maxPrice` or `minPrice`).

    A11 is U-51: what the venue reports for a market order is undocumented.
  - **`size_matched` may exceed `original_size`** for such a BUY (U-51). It is
    not bounded by it; the collateral bound bounds the fills.
  - **A read that differs never matches.** For a lost answer, the matcher
    gives `AMBIGUOUS`, and the attempt stays unresolved with submissions
    paused. For an order whose venue id is known, the read raises the halting
    conflict. Both fail closed.
  - **The lost-answer arm.**
    - A FAK or FOK never rests, so the open-orders list never holds it
      (`identity.ts:28-34`).
    - If it matched, its trade names its order id, and the coordinator reads
      that order by id, as it does every order our trade legs name
      (`coordinator.ts:1021-1044`). The comparison above then applies.
    - If it was killed with nothing matched, no read shows it. The verdict is
      `NO_CANDIDATE`, then `ABSENT` once quiescent, which fixes its final size
      at 0 exactly. For an order that never rests, that is the same outcome
      as never placed.
    - Such an attempt is **never retransmitted.** It is abandoned: an
      immediate order's moment has passed, and the plan approved no later
      execution.
    - `quiescenceHorizonMs` must exceed the taker delay (A F-87), so that
      a delayed match is not missed.
  - **No FAK or FOK order runs above PAPER** before the first execution probe
    has observed A11 (`WP-350`/`WP-360`; Open item 3).
- **The reservation** is the target plus the fee bound. Fees are charged on
  top: "BUY fees add to collateral spend" (F-63; A F-82). The bound comes from
  the market's versioned fee parameters, at the worst price the budget can
  reach, which is at most the limit.

**D4.3 Exits are sized by the held position.**
- **The source is kept.** Static Bracket already names each exit from its
  confirmed allocation not yet exited (`openShares`), and checks position
  agreement before any exit that changes the position (`decide.ts:21-24`,
  rule 4; §6 invariants 10 and 12). D4 keeps that source.
- **D4 adds the grid, by the leg's exit side** (`CX034-R1-03`; `legPosture`,
  `decide.ts:704-713`):
  - **The direct leg** entered by BUYING, and exits by SELLING. Its exit is
    `floor₀.₀₁(min(openShares, the held shares of the leg's token))`. The
    clamp applies to SELL exits only: a SELL cannot exceed what is held.
  - **The complement leg** entered by SELLING tokens it held, and exits by
    BUYING them back. Its exit is `floor₀.₀₁(openShares)`, from the confirmed
    outstanding exposure. There is no inventory clamp: the entry sold that
    inventory, so a clamp would size the exit at 0 after a full sale. The
    BUY-to-close is GTC (`EXIT_ORDER_TYPE`, `decide.ts:437`), and a GTC BUY
    targets shares (F-63), so it never buys more than its size.
  - Both go through D2's quantizer.
- **The residual is what the exit cannot trade.** It is either:
  - the part below the grid (under 0.01 share), with reason `SUB_GRID`; or
  - a whole open quantity whose floored size is below the market's minimum
    order size, with reason `SUB_MINIMUM`. The minimum's unit is in conflict
    (C-7). The planner keeps its current reading, shares, until a venue round
    settles it.

  On the direct leg it is held inventory of the leg's token. On the
  complement leg it is the part of the sale not bought back: an exposure of
  under 0.01 share, or below the minimum, which settles at resolution with
  nothing to redeem.
- **A residual is:**
  - recorded in the strategy's state with its reason and its leg;
  - not an open exposure that needs an exit order, so a bracket whose only
    remainder is a residual can close;
  - still real exposure. It stays in the position projections, it counts in
    the directional exposure that `maximum_position_shares` and the entry
    bounds cap, and its PnL is valued at worst-case resolution;
  - on the direct leg, held to resolution and redeemed through WP-300's
    REDEEM, which takes an explicit base-unit amount
    (`verified-2026-10-05.md` F-73), or merged with a held complement.
- **A residual is never sold below the venue's minimum, and never rounded
  up.** It is held to resolution even where the configuration forbids that
  (`LOW-5`). Handoff §13.2's `allow_resolution_hold: false` and its
  `final_policy` govern every quantity a venue order can reduce, and no venue
  order can reduce a residual. The operator surface shows it. This is a named
  departure (Relation).
- **The effect.** The bracket reaches `CLOSED`, handoff §13.3's own state.
  No new state is added; the residual and its reason are recorded with it.
  So a `SUB_GRID` residual (`V2-10`'s probe B left 0.000002) no longer keeps
  the bracket open, and the next bracket can enter. After a `SUB_MINIMUM`
  residual, a new entry is allowed only within the caps, which count the
  residual.
- **A named departure from handoff §13.3,** whose rule is "Exit size equals
  actual allocated filled size". An allocation off the 0.01 grid cannot be
  traded whole: the SDK floors every limit order's size to 0.01 (A F-101), and
  the documented procedure rounds the share quantity down (A F-99). D4.3 meets
  the rule up to the venue's grid and records what is left. Authority: venue
  facts rank above the handoff (§1.1).

**D4.4 The simulator's default.** Once D3 and D4 are in:
- the simulator spends the planned order's `collateralTarget` for a FAK or FOK
  BUY, and converts nothing itself. That is a new value,
  `"COLLATERAL_FROM_PLAN"`, of `fokFakBuyTarget`;
- `DEFAULT_FOK_FAK_BUY_TARGET` becomes `"COLLATERAL_FROM_PLAN"`
  (`venue.ts:269`), and `trading-core`'s venue builder passes it explicitly;
- the simulator's version pin `wp-210/v2` becomes `wp-210/v3`, in the run
  configs and the goldens (`V2-10`'s follow-up);
- `"COLLATERAL_AT_LIMIT_PRICE"` and `"SHARES_UNDOCUMENTED"` stay selectable,
  only to replay old runs.

**D4.5 PAPER economics.**
- Trader cash and the allocation debits use each fill's `collateralAmount`,
  not price × shares (`V2-10` round-0 handoff, known risk 2).
- The ledger's `FillFact` (`packages/ledger/src/allocation.ts:65`) gains the
  pUSD leg. That is a contract change for its owner, WP-200's package.

**D4.6 Golden and replay changes.** Each is regenerated with a recorded
reason:
- `test/replay-golden/paper-e2e/paper-e2e-run.json`. Its entry, 50 at limit
  0.35 over asks 0.34 × 30 and 0.35 × 100, now targets 17.00 and buys
  49.428571. The exit sells 49.42, leaving a `SUB_GRID` residual of 0.008571;
- `test/replay-golden/paper-e2e/two-brackets-run.json`, which must now show
  the second bracket entering;
- `test/replay-golden/backtest/static-bracket/expected-artifact.txt`, and its
  `run-pins.json` version pin;
- `test/replay-golden/simulation/golden-replay.json`,
  `test/unit/simulation/fixtures.ts`, `test/unit/simulation/determinism.test.ts`
  and `apps/backtest-cli/src/backtest.test.ts`, wherever they pin
  `wp-210/v2`;
- the suites `V2-10`'s probe B moved: 7 unit files
  (`packages/trading-core/src/loop-capital.test.ts`,
  `loop-refused-plan.test.ts`, `loop-cadence.test.ts`,
  `loop-order-lifecycle.test.ts`, `loop-long-run.test.ts`,
  `apps/backtest-cli/src/run-command.test.ts`,
  `test/unit/simulation/backtest-static-bracket-replay.test.ts`), 36 e2e tests
  in 7 files, and 5 replay tests; and the simulation unit pins of the old
  default.

Before merging, the round investigates why `apps/trader/src/loop-folds.test.ts`
hung under the flipped default (`V2-10` round-0 handoff, known risk 7, and
STOPPED S1).

**D4.7 Test obligations.**
1. **The conversion:**
   - 50 shares at a limit of 0.35 with a best ask of 0.35 give 17.50, and with
     a best ask of 0.34 give 17.00;
   - an off-grid product floors: 33.33 × 0.347 = 11.56551 gives 11.56;
   - a target that floors to 0 is refused; so is a FAK BUY with no best ask;
   - **the minimum** (`MEDIUM-5`): 5 shares with a limit and a best ask of
     0.347 give a target of 1.73 and a share side of 4.98560, refused below a
     minimum of 5.
2. **The caps** (`CX034-R1-02`). With `maximum_position_shares` 50, a 50-share
   FAK BUY against a book whose asks are all at or above the snapshot's best
   ask buys at most 50, and the participation allowance holds. One mutation
   row converts at the limit price instead, and fails the test.
3. **A fill below the snapshot's best ask** (an ask that appeared after the
   snapshot): the excess is kept, attributed to the last band, raises
   `ENTRY_SHARE_BOUND_EXCEEDED`, and refuses the next entry; the exit sells
   the whole position.
4. **The OMS** (`MEDIUM-3`, `CX034-R1-05`):
   - bands of 30 and 20 and fills of 51.470588 allocate 30 and 21.470588, with
     nothing UNATTRIBUTED;
   - three maker legs of 16.666668 at 0.35 against a target of 17.50 pass;
     the same fill reported as one leg halts; a duplicate delivery does not
     double the allowance;
   - the group's remaining is in collateral, and never trips the gate's
     invariant.
5. **Identity** (`HIGH-1`). The mock's reads carry exactly the fields the
   SDK's `OpenOrderSchema` keeps, and no amount: a pin compares their keys.
   - Acknowledged arm: a FAK BUY with a partial fill, its read built under
     A11, reconciles; a read with another `original_size` halts.
   - Lost-answer arm, matched: the order is found by the id its trade names,
     and reconciles under A11.
   - Lost-answer arm, killed with nothing matched: `ABSENT` once quiescent,
     final size 0, abandoned, never retransmitted.
6. **Exits by side** (`CX034-R1-03`):
   - a direct-leg FAK BUY with price improvement: the exit sells the held
     position floored to 0.01; the residual is `SUB_GRID`, and the bracket
     closes; the two-bracket run enters twice;
   - a complement-leg bracket that sold all 50 held tokens: its stop, its
     take-profit and a partial exit each BUY from `openShares`, never 0; an
     off-grid `openShares` of 49.995 buys 49.99 and records a `SUB_GRID`
     residual of 0.005 on that leg;
   - a FAK or FOK BUY-to-close is refused.
7. **A partial entry that leaves a position below the minimum:** a
   `SUB_MINIMUM` residual, held to resolution even with
   `allow_resolution_hold: false`, and counted by the caps.
8. **The D4.6 goldens are regenerated,** and a determinism run, made twice,
   is byte-identical.

**D4 changes PAPER fills and exits.**

## Implementation plan

The three rounds run **strictly in order: R1, then R2, then R3** (`LOW-8`).
Never two at once: R1 and R2 share `packages/oms/**` and the live and
reconciliation fault suites; R2 and R3 share `packages/oms/**`,
`packages/polymarket-secure/**` and `test/fault-injection/live/**`.

| Round | Decisions | Paths it needs | Order | Label | Acceptance |
| --- | --- | --- | --- | --- | --- |
| R1 `OMS-QTY` | D2 | `packages/execution-planner/**`, but not `src/probes/**` (WP-350's); `packages/oms/**`; `packages/polymarket-secure/src/venue-client.ts` and its tests; `packages/strategies/static-bracket/src/params.ts` and its tests; `test/unit/{execution-planner,oms,strategies}/**`; `test/contract/polymarket-secure/**`; `test/fault-injection/live/**`; `test/fault-injection/reconciliation/**` | first | pre-live; a latent PAPER change, with no golden change | D2.6; all gates; the goldens byte-identical |
| R2 `OMS-VENUE-TIME` | D1 | `packages/oms/**`, including `src/reconciliation/**`; `packages/polymarket-secure/src/user-stream/**`; `test/unit/oms/**`; `test/contract/user-stream/**`; `test/fault-injection/reconciliation/**`; `test/fault-injection/live/**`; `apps/ops-cli/src/emergency/**`, only where it builds the `ReconciliationPolicy` (the new `orderingHorizonMs`) and its tests; `docs/runbooks/reconciliation.md` (the policy table's new row); `docs/experiments/phase-3-verification.md` (§5's counts to 0, with a dated note) | after R1 is merged | pre-live only | D1.10; all gates |
| R3 `TIF-COLLATERAL` | D3, then D4 | `packages/trading-core/**` (the bounded ADR-022 D10 grant of D3.6 and D4.5), its tests included; `packages/execution-planner/**`; `packages/oms/**`; `packages/polymarket-secure/**`; `packages/simulation/**`; `packages/strategies/static-bracket/**`; `packages/ledger/src/allocation.ts` (`FillFact`, with WP-200's owner); `packages/risk/**`, only if the incident needs a new cause; the matching `test/unit/**`, `test/contract/polymarket-secure/**`, `test/fault-injection/live/**`, `test/fault-injection/reconciliation/**`, `test/e2e/**` and `test/replay-golden/**`; and, from `apps/**`, **test files only:** `apps/backtest-cli/src/**/*.test.ts` (`backtest.test.ts`, `run-command.test.ts`) and `apps/trader/src/**/*.test.ts` (`loop-folds.test.ts` included) (`MEDIUM-4`). **Not** `db/migrations/**`, `packages/domain/**`, `packages/decimal/**`, or any non-test `apps/**` file: if one must change, the round stops and reports it | after R2 is merged. D3 with D4: one round, or two rounds merged back to back before any PAPER run is cited as evidence | D3: pre-live, plumbing only for PAPER. **D4: changes PAPER fills and exits** | D3.7, D4.7; each golden with a reason; all gates |

**For every round:**
- PAPER only, with no credential and no network. The four live defaults stay
  `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
  `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`.
- Mocks run behind the network tripwire.
- The gates are typecheck, lint, check:deps, test and the full fault chain,
  plus the integration and e2e suites that each round's paths touch.
- Each round has two verifiers, reconciled: these are order-safety changes.

## Relation to the handoff and the ADRs

- **The user's ruling (D1).** It is implemented as ruled: STALE only with a
  venue-time proof, and a strictly newer observation always halts. D1 adds
  three things, each put to the user (Open item 1):
  - the hold for pairs that venue-timed evidence may still order (D1.5);
  - the halt at once for pairs it never can (UNORDERED, CLOSED);
  - the extension from `LIVE` to `DELAYED` and `UNMATCHED` (D1.1).
- **ADR-002 §2:** consistent (D1.8). Observations keep their arrival order,
  and the venue timestamp is data.
- **ADR-007:**
  - §1: no new state; a hold is a marker.
  - §3: a hold resolves only by venue evidence or an authoritative read.
    The horizon delays when a read may decide, and what it decides is only
    ever a halt.
  - §5: refined for FAK and FOK (D3.5).
  - §8: implemented by D3.4, with an explicit escalation.
  - §2 step 9: a retransmission keeps the order type (D3.1, item 5). An
    ABSENT FAK or FOK is never retransmitted (D4.2).
  - §11: the time-in-force sits in the persisted signed payload, which is
    secret, and on the order record, which is not.
- **ADR-008 and ADR-033 D1 item 4:** unchanged. D3.4's escalation uses the
  Incident Controller's explicit heartbeat stop, latched until an operator
  releases it; it does not rely on a lapse.
- **ADR-020:** every new port field is read as own data through the existing
  doors.
- **ADR-022 D10:** D3's and D4's core hooks are a bounded grant (D3.6).
- **ADR-032 D4:** a hold takes a fresh request token.
- **Handoff §9.9:** a stale `LIVE` no longer starts the incident ladder; a
  newer one still quarantines the market, as today. An overdue deadline
  cancel is "Account state unknown" (D3.4).
- **Handoff §9.10:** the planner quantizes (D2), defines deadlines (D3.4),
  converts and bounds the collateral target (D4.1), and reserves (D4.2).
- **Handoff §9.11:** the protocol is unchanged.
- **Handoff §9.12:** only the official SDK. `createMarketOrder` is an SDK
  method; nothing is signed by hand.
- **Handoff §6 invariant 7:** a collateral-targeted BUY's excess shares are
  attributed to its last band (D4.2).
- **Handoff §6 invariant 10:** exits still come from confirmed allocation, now
  on the venue's grid and by the leg's exit side (D4.3).
- **Handoff §13.2, the `risk` block:** D4.1 converts at `min(limitPrice,
  bestAsk)` so that the share caps hold for the fill. The case they cannot
  cover, a fill below the snapshot's best ask, is detected and contained
  (D4.2).
- **Handoff §13.2, `allow_resolution_hold: false` and `final_policy`:** a
  named departure (`LOW-5`). A residual (D4.3) is held to resolution even when
  the configuration forbids it, because no venue order can reduce it. The
  configured policy still governs every quantity a venue order can reduce.
  Authority: §1.1 (A F-99, F-101; C-7).
- **Handoff §13.3,** "Exit size equals actual allocated filled size": met up
  to the venue's 0.01 grid, with the residue recorded and held to resolution
  (D4.3). A named departure, on the authority of §1.1. The state machine is
  unchanged: a bracket with a residual reaches `CLOSED`.
- **`V2-10` and the round's packet:** the conversion basis changes from the
  limit price to `min(limitPrice, bestAsk)`, and its grid from base units to
  0.01 (D4.1). Authority: handoff §13.2 for the first, §1.1 for the second.
  The basis is put to the orchestrator (Open item 9).

## Consequences

- **Liveness.**
  - `WP340-F1`'s 287 scripted releases go to 0, and a place-then-cancel no
    longer needs an operator, when its terminal frame arrives before the
    horizon read.
  - FAK and FOK reach the venue port.
  - A residue no longer blocks the next bracket.
- **One number and one value.** The OMS, the reservation, reconciliation, the
  signed order and the mock agree on one quantity. PAPER and live read one
  time-in-force from the plan.
- **Costs.**
  - A hold pauses every submission of the account, not only its market,
    until venue time closes it or the horizon read halts it.
  - A STALE observation whose terminal frame arrives after the horizon read
    halts. If the venue emits no `CANCELLATION` for a REST cancel (U-54),
    every route-3 case halts after the horizon.
  - Overlapping millisecond instants halt at once.
  - A collateral-targeted BUY converted at the best ask can buy fewer than its
    planned shares when it walks the book (D4.1).
  - Residual inventory is held to resolution.
  - The PAPER goldens and the simulator's version pin change with D4. Runs
    before and after it are not comparable.
  - A migration is owed before any PostgreSQL OMS store (Open item 4).
- **Risks.**
  - D1 relies on an inference about `timestamp` (U-52). If the inference is
    wrong, the cost is liveness (D1.7).
  - What the venue reports for collateral-targeted BUYs (U-51, A11) and for a
    killed FOK (U-49) is unknown, so FAK and FOK orders stay in PAPER until an
    execution probe observes them.
  - The share caps rest on the planning snapshot. A fill below its best ask
    exceeds them; D4.2 detects and contains it, but cannot prevent it.
  - C-7 sets the `SUB_MINIMUM` threshold and the minimum check.

## Alternatives considered

**For D1:**
- **Halt on every unordered pair** (a strict reading of "fail closed"). D1
  adopts it where venue time can never order the pair (UNORDERED, CLOSED).
  Applied to the OPEN kind, route 3 and route 1 would still halt, and their
  pins would stay red. Rejected for that kind.
- **Close a hold as STALE when a read finds the order terminal** (round 0's
  `READ_AFTER`). The same evidence then cleared or halted by arrival order,
  and a newer observation could clear (`CX034-R1-01`). Rejected.
- **Close it on the read, and revisit when T arrives.** The account would
  resume on the read's inference, and a newer observation would halt only
  after new orders had been placed. Rejected.
- **Let arrival order and the read decide, with no timestamps.** That is
  contrary to the ruling.
- **A lifecycle tie-break:** a `PLACEMENT` always precedes its own order's
  terminal transition.
  - This is sound against a truthful venue, and needs no read.
  - But an `UPDATE` against a `CANCELLATION` at one instant rests on
    undocumented semantics (U-52).
  - It is kept as a refinement for after an observation.
- **Buffer or reorder observations by venue time before applying them.** This
  contradicts ADR-002 §2, and delays every observation.
- **Use the HTTP `Date` header as an answer's instant.** It is undocumented,
  has seconds precision, and the SDK does not expose it.
- **Read seconds as truncated** (round 0). No source says so; under rounding
  a newer observation could be classed STALE (`MEDIUM-2`). Rejected for the
  widened interval.

**For D2:**
- **Refuse every off-grid quantity.** It strands exits sized by the held
  position (D2.3, reason 1).
- **Quantize in the OMS or the adapter.** The OMS would have to re-attribute a
  remainder across intents it does not own: attributions must sum exactly to
  the ticket (`order-manager.ts:294`). The adapter is the last moment, after
  the reservation is made.
- **Keep the adapter's 0.01 window, and compare rounded values in
  reconciliation.** That leaves three places to keep in step instead of one.

**For D3:**
- **Infer FAK from a zero expiration, or from `executionStyle`
  `MARKETABLE_LIMIT`.** Inference is what `CO3-N2` found unsafe ("a silently
  assumed FAK would change every unfilled remainder's fate",
  `pipeline.ts:55-56`).
- **Let the SDK's `place*` methods post.** They are forbidden: they may send
  approval transactions by themselves (`sdk-port.ts:18-22`).
- **Use GTD for short lifetimes.** That is impossible below the floor (ADR-007
  §8).
- **Rely on the heartbeat lapse when a deadline cancel cannot be sent**
  (round 0). Nothing makes the heartbeat lapse in that case
  (`CX034-R1-06`). Rejected for the explicit, latched stop.

**For D4:**
- **Keep FAK BUYs in shares.** That is contrary to the venue (F-63).
- **Convert at the limit price** (the packet; `V2-10`). It breaks the share
  caps whenever the book asks less than the limit, or, checked on its share
  bound, refuses every such entry (D4.1). Rejected.
- **Convert at the strategy's walk cost for `plannedShares`.** It buys
  exactly `plannedShares` against the snapshot, but any improvement at any
  level breaks the bound, and the planner receives only the best levels.
  Rejected.
- **Emulate an immediate BUY with a share-targeted GTC and an immediate
  cancel.** The caps would be exact, but the remainder would rest until the
  cancel lands, and the order would not be the venue's FAK or FOK. Rejected;
  an operator can still configure that route through D3.4.
- **A book-independent share bound.** None useful exists: a collateral target
  buys up to `target ÷ tick size` shares at the venue's lowest price, 1750
  shares for 17.50 at a tick of 0.01. Checking the caps on that would refuse
  every entry.
- **Exit the planned share count.** It leaves the extra shares behind, and is
  contrary to §6 invariant 10.
- **Clamp every exit to the held inventory.** It sizes a complement leg's
  BUY-to-close at 0 (`CX034-R1-03`).
- **Round the exit up, or trade up to the minimum.** A SELL rounded up
  exceeds the held position; trading up to the minimum adds exposure.
- **Keep the base-unit target** (`V2-10`). It differs from the signed amount.

## Open items

1. **The user confirms D1's additions.** The ruling names two outcomes. D1
   adds:
   - **a hold** for pairs that venue-timed evidence may still order: a
     PENDING terminal instant, or one in seconds. It pauses every submission
     of the account until that evidence orders the pair, or a read made
     `orderingHorizonMs` after the hold halts it;
   - **a halt at once** for pairs that venue time can never order:
     overlapping millisecond instants;
   - **the extension** of both of the ruling's outcomes from `LIVE` to
     `DELAYED` and `UNMATCHED` (D1.1).

   The hold's costs are listed under Consequences. If the user rules that
   every pair not ordered at once halts, D1.5's OPEN row becomes a halt.
   Route 3 (a cancel answer has no instant) and route 1 (its terminal
   evidence is a read) would then stay operator releases, and their pins
   would stay failing. Only route 2, against a fill whose stream event carries
   milliseconds, would be judged by venue time alone.
2. **U-52 and C-25:** what `timestamp` names, its unit, its rounding, whether
   it is monotonic, and how a push is ordered against an answer.
   - The first authenticated observation, in a mode that permits one (the
     execution-probe phase), checks a placement's `timestamp` against its
     `created_at` and against when its answer arrived.
   - Until then D1 rests on A F-98, an inference. D1.7 analyses what happens
     if it is wrong.
   - `orderingHorizonMs` needs the same live-mode decision as
     `quiescenceHorizonMs`.
3. **U-49, U-50 and U-51 (A11):** the killed FOK's answer, FAK and FOK events
   on the stream, and what the venue reports for a market order's
   `original_size`, `size_matched` and `price`. The first execution probe
   (`WP-350`/`WP-360`) observes them. No FAK or FOK order runs above PAPER
   before then.
4. **A migration, before any PostgreSQL OMS store** (`CO3-N3`), for
   (`LOW-7`):
   - `execution.orders.time_in_force`, and the plan's time-in-force;
   - the collateral target, on the plan and the order;
   - D2.3's `unexecutableRemainder` and its reason, on the plan;
   - the intent-to-plan link's two quantities, requested and executable
     (`execution.intent_order_links` has one, `attributed_shares`);
   - a fill's venue instant (D1.2) and its maker legs (D4.2), on
     `execution.fills`.

   Today `db/migrations/0005_execution.up.sql` has none of them
   (`:30-101`, `:430-438`, `:448-500`). A defined durable payload, such as an
   order-event payload, would also serve for any of them. `db/migrations/**`
   is a protected path, and needs its own authorization.
5. **C-7,** the unit of the minimum order size, sets D4.3's `SUB_MINIMUM`
   threshold and D2.3's minimum check. The planner keeps its share reading
   until a venue round settles it.
6. **The register** (`docs/contracts/protected-contracts.md` §8) gains C-24,
   C-25 and U-49 to U-54, through its owner.
7. **The brief's rows** `WP340-F1`, `CO3-N1`, `CO3-N2` and `V2-10B` point to
   this ADR and to R1 to R3. That is the orchestrator's records work.
8. **Out of scope:** ADR-033 D5's transport and the live composition root.
   D3's port changes are exercised against mocks only. The live root must
   map D3.4's `ACCOUNT_STATE_UNKNOWN` incident to the explicit heartbeat stop,
   with D3.7 item 8's test, before any deadline-bounded GTC runs above PAPER.
9. **The orchestrator confirms D4.1's conversion basis,** `min(limitPrice,
   bestAsk)`. The round's packet said "at the limit price", which breaks the
   share caps (D4.1). If the orchestrator keeps the limit price, D4 needs
   another answer to `CX034-R1-02`: wider caps in the configurations, or a
   refusal of every entry whose share bound exceeds them.

## Evidence

- **Venue:** [`verified-2026-10-06.md`](../venue/verified-2026-10-06.md)
  F-79…F-106, C-24, C-25 and U-49…U-54, with its source register and probes.
  `verified-2026-10-05.md` F-63, F-64 and F-73. `verified-2026-10-04.md` F-19
  and C-16. `verified-2026-09-16.md` §2.3, C-7 and S-S1j.
- **Findings:**
  - `docs/handoffs/WP-340.md`;
  - `docs/experiments/phase-3-verification.md` §3.2 (A8) and §5;
  - `docs/handoffs/CLOSEOUT-3-wave-3-closeout.md` N1, N2 and N4;
  - `docs/handoffs/V2-10.md`, the deferral;
  - `docs/handoffs/V2-5.md`, summary item 7;
  - the closeout's probe file (sha256 above), and the `V2-10` round-0
    handoff's probe B and STOPPED S1, both outside the repository under
    `~/pmb-rounds/`.
- **Code, at `3294201`:**
  - `packages/oms/src/order-manager.ts:285-296, 320-323, 631-646,
    1159-1168, 1243-1276, 2114-2181, 2217-2288, 2346-2379, 2384, 2434,
    2905-2909, 3028-3037, 3062-3075`;
  - `packages/oms/src/reconciliation/identity.ts:28-34, 64-71`;
  - `packages/oms/src/reconciliation/coordinator.ts:679-684, 1021-1044,
    3334-3338`, and its header's "Quiescence";
  - `packages/oms/src/ports.ts:30-116, 343`;
  - `packages/polymarket-secure/src/venue-client.ts:295-313, 369-383, 438-455`;
  - `packages/polymarket-secure/src/sdk-port.ts:18-39`;
  - `packages/polymarket-secure/src/rate-limit/priority.ts`;
  - `packages/polymarket-secure/src/user-stream/normalize.ts:95-118, 318`;
  - `packages/polymarket-secure/src/user-stream/oms-projection.ts:64-69,
    126-142, 180-191, 235-247`;
  - `packages/polymarket-secure/src/user-stream/wire.ts:76-77, 117-137`;
  - `packages/risk/src/recommendations.ts` (`ACCOUNT_STATE_UNKNOWN`);
  - `packages/trading-core/src/pipeline.ts:44-177, 446`;
  - `packages/execution-planner/src/plan.ts:97-109`, `inputs.ts:57-62`,
    `slice.ts:1-31`;
  - `packages/simulation/src/venue.ts:221-269`;
  - `packages/strategies/static-bracket/src/decide.ts:21-30, 437, 704-713,
    843-847, 897, 1194-1265`, `params.ts:547`;
  - `packages/ledger/src/allocation.ts:65`;
  - `apps/trader/src/live-safety/live-safety.ts:636-640`,
    `oms-progress.ts:43-54`;
  - `test/fault-injection/live/findings.test.ts`,
    `support/expected-releases.ts`, `support/live-node.ts:683-698`,
    `support/mock-clob.ts:525-537, 733-737, 886-897`;
  - `test/fault-injection/reconciliation/support/wp280.ts:36, 81, 112`;
  - `infra/compose/trader/trader.config.example.json:126-130`;
  - `db/migrations/0005_execution.up.sql` (`execution.plans.deadline_at`; no
    time-in-force column on `execution.orders`).
- **Safety.** This ADR changes no run-mode default (ADR-010). It describes
  behaviour that cannot be reached today: `ALLOW_REAL_ORDERS=false`, both
  live-micro caps are 0, no signer is configured, and no live gate has been
  requested.
