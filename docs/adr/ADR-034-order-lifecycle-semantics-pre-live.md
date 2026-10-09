# ADR-034: Order-lifecycle semantics before live: venue-time ordering, one executable quantity, time-in-force end to end, and collateral-targeted immediate BUYs

- **Status:** **Accepted** (2026-10-08). Proposed 2026-10-06; merged
  `e1b62c1` after a joint Opus and gpt-6-astra ACCEPT at review round 6.
  - **The user's rulings, 2026-10-08:** D1's additions are confirmed: the
    hold, the halt at once, and the extension to `DELAYED` and `UNMATCHED`
    (Open item 1). The share caps of a collateral-targeted FAK or FOK BUY
    are plan-time caps, **variant P** (Open item 10). The user also accepted
    the ADR.
  - **The orchestrator's ruling, 2026-10-08:** D4.1's conversion basis,
    `min(limitPrice, bestAsk)`, is confirmed (Open item 9). D2 to D4 are
    accepted.
  - D1 records the user's ruling on `WP340-F1` (2026-10-05: venue-time
    ordering) and settles its details.
  - Nothing is implemented. The venue unknowns (Open items 2, 3 and 5) stay
    open until the execution probe; no FAK or FOK runs above PAPER before
    then.
- **Date:** 2026-10-06. Revised after review rounds 1 and 2 (2026-10-06)
  and rounds 3 to 5 (2026-10-08).
- **Recorded by:** the round `ADR-034` (docs only), authorized at `3294201`.
- **Implemented by:** not yet. Three rounds, under "Implementation plan",
  strictly in this order: `OMS-QTY` (D2), `OMS-VENUE-TIME` (D1), and
  `TIF-COLLATERAL` (D3, D4). The orchestrator assigned these names on
  2026-10-08.
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
     In the trader, the live-safety fence implements the OMS's venue port and
     judges every signing and every transmission per order
     (`apps/trader/src/live-safety/fenced-venue.ts:77-82`, `:200-244`;
     `LiveSafety.fenceVenue`, `live-safety.ts:617-622`).
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
  or `S`, never a float. It takes part in a comparison in one of two forms.
- **A point** (`CX034-R2-02`). A user-channel `timestamp` is a point: an order
  event's, or a `MATCHED` trade event's. Two points compare by their values.
  - **Why the values order the instants.** No source says whether the venue
    truncates, rounds to nearest or rounds up to the millisecond (U-52). All
    three are non-decreasing: if `t₁ ≥ t₂` then `r(t₁) ≥ r(t₂)`. So, for one
    rounding function `r`, `r(t₁) < r(t₂)` proves `t₁ < t₂`. Equal values
    prove nothing.
  - **Assumption A12** (a reading of U-52): every user-channel `timestamp`,
    of an order event or of a trade event, comes from one venue clock and is
    rounded to milliseconds by one function. Nothing documents it, and
    nothing contradicts it. D1.7 analyses what happens if it is wrong, and
    the first authenticated observation checks it (Open item 2).
  - Example: a `LIVE` at 1790000000099 and a `CANCELED` at 1790000000100 are
    one millisecond apart, so the `LIVE` is STALE. Round 1 widened each value
    on its own and halted this pair at once; that rule is withdrawn.
- **An interval**, for every other comparison. It is used for a `match_time`
  (`S`), and for a point compared with an interval: two fields whose roundings
  are not known to relate. A value `v` in unit `u` (1 ms, or 1000 ms for `S`)
  then stands for `[(v − 1)·u, (v + 1)·u)` ms, widened by one unit on each
  side. It contains the true instant whether the venue truncates (`[v·u,
  (v + 1)·u)`), rounds to nearest (`[v·u − u/2, v·u + u/2)`) or rounds up
  (`((v − 1)·u, v·u]`).
  - Example: `match_time` 1790000001 is `[1790000000000, 1790000002000)` ms.
    A `LIVE` at 1790000000900 ms, widened to `[1790000000899,
    1790000000901)`, is therefore not STALE against it. Under truncation
    alone it would have been, and if the venue rounds, that `LIVE` may follow
    the match.
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
| FILLED, however it was reached (fills, a FAK or FOK answer, or a read) | the **completion instant C**: the latest instant among the fills that make up its final size. When every fill instant is a point, C is the latest point. Otherwise C is an interval: `C.lo = max F.lo` and `C.hi = max F.hi` over those fills, each point widened as an interval (D1.2). **PENDING** while the fills received do not yet sum to the final size. Every fill has at least its `match_time` |
| EXPIRED | the `timestamp` of the stream observation that made it EXPIRED, if one did; else **PENDING**. No documented stream status names an expiry (A U-54), so in practice PENDING |
| REJECTED | **none.** A rejected order never rested, and it has no venue order id an observation could name. A LIVE-class observation that reached one would halt at once, as today |

- **A fill's instant F.**
  - It is the `timestamp` (`MS`) of its trade's `MATCHED` event, a point, when
    that event was received, whichever arrived first. Otherwise it is the
    trade's `match_time` (`S`), an interval, from any trade event or REST read.
  - **Narrowing.** When a fill first recorded with `match_time` later gets its
    `MATCHED` event, and the point's widened interval lies inside the `S`
    interval, the point replaces it. That is the only way an instant narrows.
  - **Disagreement.** When the point's widened interval does not lie inside
    the `S` interval, the two disagree. F is then the hull of both, the
    smallest interval containing both. That can only make fewer pairs STALE.
- **Evidence that widens T after a classification.**
  - A disagreeing fill instant makes T the hull of what it was and the new
    instant.
  - A second `CANCELED` observation of the order with another `timestamp`
    makes T the span `[a, b]` of the two points: D1.4 compares a point with
    a span.
  - Every observation already classified STALE against the narrower T is
    then compared again. Anything but STALE raises the halting conflict: the
    proof it was cleared on no longer holds.
- **Why the latest fill, and not the completing one** (`CX034-R1-04`). The OMS
  completes an order when the fills it has *received* sum to its size
  (`order-manager.ts:1267-1271`). The fill that arrives last can be an
  earlier match. T is computed from all the fills, independently of arrival
  order and of REST pagination.
  - Example: fills `5@200` then `5@100` (ms points) give `C = 200`, so a
    `LIVE` at 150 is STALE. Taking the arrival-order completing fill (100)
    would have made it NEWER, and halted.
  - With intervals the rule is the same: fills whose instants are
    `[199, 201)` and `[99, 101)` give `C = [199, 201)`.
- **A PENDING T is fixed** by the first later venue-timed evidence of the same
  terminal fact, for the same venue order id: a `CANCELED` observation for a
  canceled order, or the fills' instants for a filled one.
- **A collateral-targeted BUY** (`R3-M1`; D3.5, D4.2). Its `matched` answer
  makes it FILLED, and only a read fixes its final size. With the answer
  lost, a read that shows it terminal with a positive `size_matched`,
  `MATCHED` or `CANCELED`, makes it FILLED (`R4-L3`). So its T is the
  FILLED row's C. The one exception (`R5-L2`):
  - **a `delayed` such order that a stream `CANCELED` observation ends
    first** (D3.5's delayed arm; `order-manager.ts:2252-2256`) stays
    CANCELED. Its T is that frame's `timestamp`, the table's first row, a
    point. The read it requests fixes the final size and leaves the state
    (`:2149-2154`), so T stays that point.

  When it is FILLED, C is PENDING until a read has fixed the final size and the
  recorded fills sum to it. C is then the latest instant among those fills.
  - **What the read supplies.** The read fixes which fills make up the
    order, and never supplies an instant. Each fill's instant is still venue
    time (a `MATCHED` event's `timestamp`, or `match_time`).
  - **Why C, and not a `CANCELLATION`, is sound here.** A match needs a live
    order, so every fill's instant is no later than the instant the order
    became terminal, and neither is C. So STALE against C (D1.4, a point or
    an interval) still proves that L is older than the order's end. The venue may emit no `CANCELLATION` for a fully
    spent order (U-50, U-54). Waiting for one would hold every late frame of
    such an order until the horizon read halts it.
- **T is recorded.** T, its unit and the kind of evidence that fixed it are
  recorded in the payload of the order event that fixed it
  (`execution.order_events.payload` is `jsonb`).

**D1.4 The comparison.** L is the observation's instant, always a point (an
order event's `timestamp`, D1.2). T is the terminal instant (D1.3).
- **T is a point `t`** (`CX034-R2-02`):
  - **STALE**: `l < t`;
  - **NEWER**: `l > t`;
  - **UNORDERED, CLOSED**: `l = t`.
- **T is a span `[a, b]` of points** (two `CANCELED` observations): STALE if
  `l < a`, NEWER if `l > b`, and UNORDERED, CLOSED otherwise.
- **T is an interval** (it rests on a `match_time`, or on a hull). L is then
  widened to `[l − 1, l + 1)` ms, as D1.2 says:
  - **STALE**: L ends no later than T starts (`L.hi ≤ T.lo`);
  - **NEWER**: L starts no earlier than T ends (`L.lo ≥ T.hi`);
  - **UNORDERED**: anything else. It is **OPEN** when T rests on a fill
    instant still in `S`, whose `MATCHED` event could still narrow it to a
    point, and **CLOSED** when T is final (a hull).
- **T is PENDING:** UNORDERED, OPEN. Venue-timed evidence may yet order the
  pair.

So **CLOSED** means venue time will never order the pair: equal millisecond
values, a value inside a span, or an overlap with a final interval. Adjacent
milliseconds are ordered. Ties are never STALE and never NEWER.

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
     fill or `MATCHED` event that fixes or narrows a fill instant. It also
     arrives when a read fixes the final size of a FILLED order whose
     recorded fills then sum to it, since that makes C known from those
     fills' venue instants (D1.3). Every open hold on the order is compared
     again:
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
       order". If that answer itself fixes the order's final size, the final
       size is applied first. The holds are then compared again against the C
       it makes known (item 1). Only a hold still open after that halts.
- **The read never classifies STALE.** Round 0 let a terminal read close a
  hold as STALE ("READ_AFTER"). Then the same evidence (a cancel at 100 whose
  answer left T PENDING, and a `LIVE` at 200) cleared or halted according to
  which arrived first: the read, or the `CANCELED` frame. That rule is
  withdrawn. A read that fixes a FILLED order's final size does not break
  this rule: it supplies no instant, and what it lets classify is ordered by
  the fills' venue instants (D1.3). Whether the read or the horizon comes
  first, the same fills give the same C.
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
- **STALE needs a proof in venue time,** and only that. Against a point T, L
  is a strictly smaller value of the same clock and rounding (A12). Against an
  interval T, L's widened interval ends before the earliest instant T can
  have. No read and no inference about lifecycles classifies an observation
  STALE.
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
- **If A12 is wrong** (order events and trade events stamped by different
  clocks or roundings), a point comparison between an order event and a fill
  can misjudge the pair by the clocks' disagreement.
  - A pair misjudged NEWER halts: a cost to liveness.
  - A pair misjudged STALE is the case above. It releases nothing: the fill
    checks still halt on a fill beyond the final size, and no new salt opens
    without a read made after the terminal evidence.
  - A CANCELED T compares two order events, one field of one event type, so
    it rests on A12 for order events only.
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
   - The mock's venue clock gives each distinct venue change its own
     millisecond value, strictly greater than the previous change's. One
     millisecond apart is enough: points compare by value (D1.2).
   - The mock emits a `CANCELLATION` frame for every cancel, a REST cancel
     included.
   - These are labelled mock assumption **A10**: a reading of U-52 and U-54.
   - **A10's scope** (`NEW-L4`). A10 orders distinct changes; it does not
     claim the venue never stamps two changes with one value. A FAK's
     placement and the cancel of its remainder might share one; whether they
     do is unobserved (U-50). So the route tests rest on A10, and the
     equal-value cases are tested on their own (item 5; D3.7 item 2), where
     they halt.
   - The live suite's `orderingHorizonMs` is at most its
     `quiescenceHorizonMs`, which `reconcileUntilResumed` waits between runs
     (`support/live-node.ts:695`).
   - **The OMS crash suite** (`NEW-M2`).
     `test/fault-injection/oms/crash-points.test.ts:148` applies a `LIVE`
     observation with no instant, which D1.2 refuses. It gains the instant of
     the venue change it reports, on its world's time line, and keeps its
     retention assertion (`:149`). That suite is type-checked and run by the
     OMS package's `test:fault` (`packages/oms/package.json:13`), inside the
     root fault chain (`package.json:18`).
5. **Unit tests in `test/unit/oms/**`:**
   - STALE, NEWER, UNORDERED CLOSED (equal milliseconds: a halt at once) and
     UNORDERED OPEN (a PENDING T; a `S` T: a hold);
   - **one millisecond** (`CX034-R2-02`), against a `CANCELED` at
     1790000000100: a `LIVE` at 1790000000099 is STALE, with no halt; one at
     1790000000100 is UNORDERED, CLOSED, a halt at once; one at
     1790000000101 is NEWER, a halt. The same three against a fill point from
     a `MATCHED` event at 1790000000100;
   - **a span:** two `CANCELED` observations at 100 and 104 make T `[100,
     104]`. A `LIVE` at 99 is STALE, at 102 CLOSED, at 105 NEWER;
   - **the widened interval** (`MEDIUM-2`): with T from `match_time`
     1790000001, a `LIVE` at 1790000000900 is held, not STALE, and a `LIVE` at
     1789999999899 is STALE;
   - **arrival order** (`CX034-R1-04`): fills `5@200` then `5@100` give a T
     of 200, and a `LIVE` at 150 is STALE. A REST read whose fills come in
     two pages, in either order, gives the same T. A seconds fill instant is
     narrowed by its `MATCHED` event, and a disagreeing one makes the hull. A
     hull that undoes an earlier STALE raises the halting conflict;
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
     ties as STALE; widen two points (the one-millisecond test fails); drop
     the widening against an interval; take the arrival-order completing
     fill; let a terminal read close a hold as STALE; drop the horizon; let a
     hold resume; drop the hold's gate blocker.
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
   - The `OrderTimeInForceBook` side table goes away, with the trader
     facade's re-export of it (`apps/trader/src/index.ts:303`); the README's
     section on it (`apps/trader/README.md:177-191`) is updated. Both are in
     R3's grant (`CX034-R3-02`). The simulator's `ExecutionPolicy.timeInForceFor`
     reads the plan.
   - PAPER and live then read one value from one core.
3. **Carried on the OMS ticket.**
   - `OrderTicket.timeInForce` is required, and nothing is inferred from the
     expiration.
   - It is persisted on the order (`OrderRecord.timeInForce`) in the same
     transaction as the PLANNED row, before reservation. It is also copied into
     the PLANNED event's payload.
   - Its `execution.orders` column needs a migration, which is a protected
     path (Open item 4).
4. **Carried to the SDK call, through every wrapper of the port** (`NEW-H1`).
   - `OmsVenuePort` (`packages/oms/src/ports.ts:111-116`) gains a required
     `createMarketOrder`, which answers a `SignOutcome` like
     `createLimitOrder`. No wrapper may omit it or make it optional.
   - `SdkSecureClientPort` gains the SDK's `createMarketOrder`. It is a
     `create*` member, so the port still has no `place*` member
     (`sdk-port.ts:18-22`).
   - The adapter validates its request and cross-checks its signed amounts by
     D2.4's table.
   - **The live-safety fence** (ADR-008; WP-320). The fence implements the
     port: `PlacementVenuePort` (`apps/trader/src/live-safety/fenced-venue.ts:77-82`)
     and `fenceVenuePort` (`:143-245`), through `LiveSafety.fenceVenue`
     (`live-safety.ts:617-622`).
     - `PlacementVenuePort` gains the member. `fenceVenuePort` wraps it
       exactly as it wraps `createLimitOrder` (`:201-213`). It classifies the
       request; the classifier gains a member for market requests, and a
       `null` scope refuses. It then asks the gate (`decide`), and on a
       refusal returns `signRefused` without calling the venue: no signed
       order exists. When permitted, it signs, and remembers the signed
       order's scope by identity (`remembered`, `:151`, `:212`).
     - Transmission is unchanged. `postOrder` and `postOrders` judge every
       order they send by its remembered scope, else by the classifier
       (`:168-178`, `:215-240`). So a market order is judged at signing and
       again at every transmission, like a limit order. Cancels stay
       unfenced (§6 invariant 13).
     - `LiveSafety.fenceVenue` carries the member through its type
       parameters, and changes nothing else.
   - **The restricted-mode wrapper** `withModeDetection`
     (`packages/oms/src/restricted-mode/venue-port.ts:60-90`) passes
     `createMarketOrder` through untouched, as it does `createLimitOrder`
     (`:62-64`). A signing is not a venue answer the detector reads.
   - **Every other implementer** gains the member: the OMS's test venues and
     the harnesses' literals. The plan lists their paths (R3).
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
  - A FOK `matched` is FILLED. A later read decides whether it filled whole
    (the FOK fill conflict, below).
  - **A collateral-targeted BUY** (`R3-M1`; FAK or FOK) is **FILLED at its
    `matched` answer**, with its final size unknown (`finalSize` null). When
    the answer is lost, it is FILLED at the first read that shows it
    terminal with a positive `size_matched`, `MATCHED` or `CANCELED`
    (`R4-L3`; the table below).
    - Why FILLED. The venue ends the order at its answer: a FAK cancels any
      unspent remainder, and a FOK spends its amount whole (A F-80). What the
      answer's amounts hold is U-51, so the OMS cannot tell a full spend from
      a partial one. Neither can a share count: such an order has no share
      size to complete (D4.2).
    - So, for such an order, FILLED means "matched, and ended by the venue".
      It does not mean that `plannedShares` were bought. The shares bought
      are its fills.
    - The transition issues an `ORDER_STATE` reconciliation request at once,
      so that a read fixes the final size.
    - Its T under D1 is the FILLED row's C (D1.3). Ending such an order
      CANCELED at its answer, or at a read, was rejected (Alternatives). The
      one route that leaves it CANCELED is a stream `CANCELED` observation
      that ends a `delayed` such order (the `delayed` bullet below;
      `R5-L2`). Its T is then that frame's `timestamp` (D1.3).
  - The final size is fixed only by an authoritative read. That is the salt
    gate's rule, unchanged.
  - **A read's `MATCHED` is terminal for an immediate order** (`R3-M1`), and
    so is its `CANCELED` (`CX034-R4-01`, `R4-L3`). Today `presentState` maps a `MATCHED` read whose
    `size_matched` differs from its `original_size` to PARTIALLY_FILLED, a
    live state (`order-manager.ts:2999-3011`). For a FAK or FOK that is
    wrong: the order never rests (A F-80), so a `MATCHED` or `CANCELED` read
    describes a terminal order. `presentState` therefore takes the order's
    type and target kind. With m the read's `size_matched` and o its
    `original_size`:

    | Read | Share-targeted FAK | Share-targeted FOK | Collateral-targeted BUY (FAK or FOK) |
    | --- | --- | --- | --- |
    | `MATCHED`, m = o | FILLED | FILLED | FILLED |
    | `MATCHED`, 0 < m < o | CANCELED with its matched part: "Any unfilled remainder is canceled" (A F-80) | **the FOK fill conflict** (below) | FILLED |
    | `CANCELED`, 0 < m < o | CANCELED with its matched part, as today | **the FOK fill conflict** | FILLED (`R4-L3`) |
    | `CANCELED`, m = o | CANCELED, as today | CANCELED, as today | FILLED (`R4-L3`) |
    | `MATCHED` or `CANCELED`, m > o | the halting conflict, as today (`:2120`) | the same | FILLED: `:2120` is lifted for it (D4.2) |
    | `CANCELED`, m = 0 | CANCELED, as today | CANCELED, as today | CANCELED: nothing was spent |
    | `MATCHED`, m = 0 | unrecognised, as today | the same | the same |
    | `LIVE` or `UNMATCHED` | the halting conflict: an immediate order never rests (the `live` bullet below) | the same | the same |
    | `DELAYED` | DELAYED when m = 0, else unrecognised, as today | the same | the same |

    Otherwise every partial FAK, and every collateral BUY whose shares differ
    from its signed share side, would meet "an order believed terminal is
    open at the venue" (`order-manager.ts:2155-2160`), a halt. When the
    order is already terminal, a terminal read fixes its final size and
    leaves its state, as today (`:2149-2154`). The FOK fill conflict is the
    exception: it is raised whatever the order's state.
  - **The FOK fill conflict** (`CX034-R4-01`). A FOK "Fills the entire order
    immediately or does not fill any of it" (A F-80). A read that shows a
    share-targeted FOK partly matched contradicts that, so it is never read
    as a FAK's partial cancellation:
    - **The genuine fills are kept.** Every fill is recorded, booked and
      attributed as for any order: no rule can undo a fill. The read's
      `size_matched` is recorded (`venueSizeMatched`), and a fill beyond it
      is still a contradiction, as for every order (`:2300`'s rule, against
      the read's value).
    - **It fails closed.** The OMS raises the halting `EVIDENCE_CONFLICT`,
      with the reason `FOK_PARTIAL_FILL`. The order goes to RECONCILING,
      through the existing reopen when it was terminal (`:2155-2160`), with
      `finalSize` null.
    - **It is sticky and durable,** with a VENUE-ID CONFLICT's rules
      (`order-manager.ts:78-90`): recorded in the order's event log,
      re-raised on recovery, and never cleared by the OMS, not by a further
      read, a cancel or abandonment. While it is open, the group's salt gate
      stays closed and the order's reservation stays held. Resolving it is an
      operator's act. A STATE conflict is not used, because an authoritative
      read clears one (`:2149-2154`, `:2169-2172`), and a further read would
      repeat the very contradiction that raised it.
    - **A collateral-targeted FOK BUY** cannot be judged by shares: they
      differ from its signed share side whenever the book asks below the
      limit (D4.2). Its analogue is the spend. Once a read has fixed a
      positive final size and its fills sum to it, the OMS compares the
      spend `Σ eᵢ` with the target, whatever the order's state, FILLED or
      CANCELED (`R5-L2`). A FOK that filled nothing (final size 0, the
      table's `CANCELED`, m = 0 row) spent nothing, as A F-80 allows, and
      raises nothing. If the spend is below `target − n × 10⁻⁶`, where n is
      its distinct maker legs, the OMS raises the same conflict, and does not
      release. The threshold rests on labelled assumption **A13**: a FOK BUY
      that fills spends its target whole, up to F-63's per-leg floor. A13 is
      a reading of A F-80 with F-63, and is part of U-51. If it is wrong, the
      cost is a halt, which is a liveness cost, and the execution probe
      observes it (Open item 3). Example: D4.2's crossing fill spends
      16.999999 over two legs, at or above 17.00 − 0.000002, and raises
      nothing.
    - **A FAK stays normal.** Its partial read is CANCELED with its matched
      part, or FILLED for a collateral-targeted BUY, and its under-spend is
      expected, since the venue cancels its remainder (A F-80).
- **`delayed`:** DELAYED, as today. A delayed market can delay an immediate
  order (A F-80).
  - **How a delayed immediate order ends** (`R4-L3`). Its fills move it to
    PARTIALLY_FILLED (`order-manager.ts:1275-1276`). For a
    collateral-targeted BUY, no fill ends it (D4.2). It ends at the first
    authoritative read that shows it terminal, mapped by the table above.
    That read is requested by one of three events:
    - **a stream `MATCHED` observation** of a FAK or FOK in a live state.
      It issues an `ORDER_STATE` request at once. This is new: today such an
      observation is only recorded (`:2249-2251`);
    - **a stream `CANCELED` observation,** which already makes the order
      CANCELED and requests a read (`:2252-2256`). Its T is that frame's
      `timestamp` (D1.3), and the read fixes its final size. A
      collateral-targeted BUY ended this way stays CANCELED: its T is
      already known;
    - otherwise **the next periodic run,** which reads by id every tracked
      order that is not terminal (`coordinator.ts:1034-1037`).

    A read that still shows the order `DELAYED` with a positive
    `size_matched` is unrecognised, as today, and the next run reads again.
    Until the order ends, its gate stays closed and its reservation stays
    held. That is a liveness cost only.
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
- The live-safety fence is WP-320's, in `apps/trader`. Its change is bounded
  to carrying the new member with the same per-order judgement (D3.1 item 4).
  It adds no dependency: the fence keeps the OMS's types as type parameters
  (`fenced-venue.ts:69-72`).

**D3.7 Test obligations.**
1. **Probe E02 ported, for FAK and FOK.** The OMS signs `orderType` FAK or FOK
   through `createMarketOrder`. Today it signs GTC.
2. **A composed FAK-remainder case:**
   - a partial fill, and the venue cancels the remainder;
   - the order is terminal with its matched part;
   - a read fixes its final size;
   - the unused reservation is released.

   **With D1** (`NEW-L4`), it runs in three arrangements of a late
   `PLACEMENT` frame, delivered after the answer, against the remainder's
   `CANCELLATION`:
   - stamped one millisecond earlier: STALE, with no halt;
   - stamped with the same value: UNORDERED, CLOSED, a halt at once. The test
     asserts that halt, which is D1's designed outcome until Open item 3
     settles it;
   - with no `PLACEMENT` frame at all: no hold, no halt.
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

   `v2-5.test.ts`'s SDK-port pin moves to eleven members, and keeps its
   no-`place*` rule.
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
9. **The fence and the wrappers** (`NEW-H1`):
   - **Conformance, at compile time:** the fenced venue is an `OmsVenuePort`
     with `createMarketOrder`
     (`test/fault-injection/live-safety/port-conformance.test.ts:73-80`, with
     the new member); the secure client is one
     (`test/unit/oms/port-conformance.test.ts`); and so is
     `withModeDetection`'s result.
   - **The fence, at run time** (`apps/trader/src/live-safety/*.test.ts`):
     - a market order whose scope the gate refuses returns `FAILED` with its
       reasons, and the venue's `createMarketOrder` is never called;
     - an unclassified market request is refused `PLACEMENT_UNCLASSIFIED`;
     - a permitted one is signed, and its later `postOrder` is judged with
       the remembered scope: a switch engaged between signing and
       transmission refuses it `NOT_SENT`, with no send.
   - **The mode wrapper:** `createMarketOrder` passes through untouched, and
     the detector observes nothing for it.
   - **One mutation row** makes the fence's `createMarketOrder` call the venue
     without asking the gate, and fails the refusal test.
10. **Paired partial reads, FAK against FOK** (`CX034-R4-01`). The same
    share-targeted SELL of 50, with a `matched` answer, 20 shares of fills
    received, and then the same read, run once as a FAK and once as a FOK:
    - **read `MATCHED`, `size_matched` 20, `original_size` 50:**
      - the FAK ends CANCELED with its matched part, final size 20, no
        alert; the gate opens and the reservation is released;
      - the FOK keeps its 20 shares of fills, booked and attributed, and
        raises the halting `EVIDENCE_CONFLICT` `FOK_PARTIAL_FILL`. It is
        RECONCILING with `finalSize` null, the gate closed and the
        reservation held. A second identical read clears nothing, and a
        restart re-raises the alert from the event log;
    - **the same pair with a `CANCELED` read** of 20 out of 50: the same two
      outcomes;
    - **a collateral-targeted pair:** a target of 17.00, a read that fixes
      the final size, and fills summing to it, spending 10.00 over one leg:
      the FAK BUY is FILLED and releases; the FOK BUY raises the conflict
      and releases nothing. D4.2's crossing fill (16.999999 over two legs)
      as a FOK raises nothing;
    - **one mutation row** maps the FOK's partial read as the FAK's, and
      fails the test.
11. **The terminal read of a collateral-targeted BUY** (`R4-L3`):
    - **the lost-answer arm, read `CANCELED`:** the answer is lost; the
      fills of 10.00 are received; a read shows `CANCELED` with a positive
      `size_matched`. The order is FILLED, its T is C (D1.3), the gate
      opens once the fills sum to the final size, and a late `PLACEMENT`
      stamped one millisecond before the last fill is STALE, with no halt.
      One mutation row keeps CANCELED, and the late frame halts at the
      horizon;
    - **the `delayed` arm:** a `delayed` answer, then fills, then a stream
      `MATCHED` observation. The observation requests a read at once, and
      that read makes the order FILLED. With no observation at all, the next
      periodic run reads it by id and ends it in the same way;
    - **the `delayed` arm, ended by a stream `CANCELED` observation**
      (`R5-L2`): a collateral-targeted FAK BUY with a target of 17.00, a
      `delayed` answer, then fills spending 10.00 whose `MATCHED` events
      were received, then a stream `CANCELED` observation stamped t:
      - the order is CANCELED at once, its T is t (D1.3's first row, a
        point), and a read is requested;
      - a late `PLACEMENT` stamped t − 1 ms is STALE, with no halt; one
        stamped t + 1 ms halts;
      - the read, `MATCHED` or `CANCELED` with a positive `size_matched`,
        fixes the final size and leaves the order CANCELED with T = t. The
        gate opens and the reservation is released only once the fills sum
        to that size: not at the observation, and not before the read;
      - **as a collateral-targeted FOK BUY** (the A13 check): the same
        spend of 10.00 raises the FOK fill conflict once the read fixes the
        size, and nothing is released. A spend of 16.999999 over two legs
        raises nothing, and releases. A FOK ended this way with
        `size_matched` 0 raises nothing;
      - **one mutation row** skips the A13 check for an order that is
        CANCELED: the FOK's under-spend then releases, failing the test.

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
  - **At the limit price** (the round's packet; `V2-10`'s
    `collateralTargetAtLimitPrice`), the target buys more than
    `plannedShares` whenever the book asks less than the limit: on every such
    book, not by chance. 50 at a limit of 0.35 is a target of 17.50: it buys
    51.470588 shares if it all fills at 0.34, and probe B's book (0.34 × 30,
    then 0.35) bought 50.857142. Both exceed the handoff's §13.2 reference
    configuration, whose `maximum_position_shares` equals its `size_shares`
    (50). This is a named departure (Relation; Open item 9).
  - At `q = min(limitPrice, bestAsk)`, the target is sized for
    `plannedShares` at the snapshot's best price.
- **What the conversion bounds, exactly** (`SHARE-CAP`).
  - Let the order's fills come from `n` maker legs of `mᵢ` shares at `pᵢ`.
    F-63 charges each leg `eᵢ = floor₆(mᵢ × pᵢ)`, for a maker whose signed
    amounts equal its price (D4.2). The venue never spends more than the
    target, so `Σ eᵢ ≤ collateralTarget ≤ plannedShares × q`. Since `eᵢ > mᵢ
    × pᵢ − 10⁻⁶`, each leg has `mᵢ < (eᵢ + 10⁻⁶) ÷ pᵢ`.
  - **On a stationary book** (every `pᵢ ≥ q`: no ask below the snapshot's
    best ask appears before the match), `Σ mᵢ < (collateralTarget + n ×
    10⁻⁶) ÷ q ≤ plannedShares + n × 10⁻⁶ ÷ q`. The per-leg floor can buy a
    sub-grid **rounding excess**. Example: three legs of 16.666668 at 0.35
    buy 50.000004 shares for 17.499999 pUSD, below the bound of 50 + 3 ×
    10⁻⁶ ÷ 0.35 ≈ 50.0000086.
  - **Under price improvement** (an ask below `q` appears between the
    snapshot and the match), no useful bound exists. A 17.00 target filled at
    0.17 buys 100 shares. The only bound that holds on every book is
    `(collateralTarget + n × 10⁻⁶) ÷ tickSize`: over 1,700 shares for 17.00 at
    a tick of 0.01.
  - **The money caps do hold, on every book.** The venue never spends more
    than the target. The target is at most `plannedShares × bestAsk`, which is
    at most the strategy's quote cost for `plannedShares`, which it checked
    against `maximum_total_cost` and `maximum_contractual_loss`
    (`decide.ts:1210-1231`). Fees come on top, and the reservation covers them
    (D4.2).
- **So the share caps are not hard for the fill.** Three caps count shares,
  and all three are judged on `plannedShares`, the intent's size, before the
  conversion:
  - Static Bracket's `maximum_position_shares` and
    `maximum_book_participation` (`applyEntryCaps`, `decide.ts:1194-1207`,
    `:1248-1265`);
  - the risk engine's `participation.maxOrderShares` (§9.8 check 13,
    `packages/risk/src/engine.ts:643-653`), on the intent's `buyShares`.

  A fill can exceed them by the rounding excess on any book, and by any amount
  under price improvement. **This ADR does not claim that they hold.** What to
  do is put to the user (Open item 10), as two variants, each fully
  specified:
  - **Variant P, plan-time share caps (proposed).**
    - The share caps of a collateral-targeted FAK or FOK BUY entry are judged
      at plan time, on `plannedShares`, against the planning snapshot. The
      fill's excess is accepted. It is detected and contained (D4.2): it is
      attributed; the caps count it at once, so the next entry is trimmed or
      refused (D4.3); it is alerted beyond the rounding excess; and the exit
      reduces it. The money caps stay hard.
    - This relaxes handoff §13.2's share caps, for these orders only. It is a
      named departure (Relation).
    - Why it is proposed: it is the venue's FAK and FOK BUY (F-63), which the
      packet asks for; the breach is event-driven, not systematic as at the
      limit price; and money stays capped.
  - **Variant H, hard share caps.**
    - The planner refuses a collateral-targeted FAK or FOK BUY entry whenever
      a share cap applies to it (`PLAN_SHARE_CAP_UNENFORCEABLE`), because its
      only book-independent bound exceeds any useful cap.
    - An immediate entry is then a share-targeted GTC with a deadline cancel
      (D3.4; Static Bracket's `immediate_order_type: GTC`, `params.ts:139`).
      The venue caps its shares (F-63), at the cost of a remainder that rests
      until the cancel lands.
    - Under H, the §13.2 reference configuration's FAK entry is refused. The
      PAPER goldens of D4.6 then show that refusal, or move to a GTC
      configuration with a recorded reason.
  - **Until the ruling,** R3 may implement D3, but not D4 (Implementation
    plan). D3 does not depend on the ruling.
- **What it costs.** When the order must walk above the best ask, it buys
  fewer than `plannedShares`. Over probe B's book (0.34 × 30, then 0.35), the
  target is 17.00, which buys 30 + 19.428571 = 49.428571. The intent's
  partial-fill policy governs that, as for any partial fill.
- **Why 0.01.** The SDK floors a market BUY's amount to "Size decimals" (A
  F-101), and the documentation says "Round the price and input amount down …
  to the table's … Size decimals" (A F-99).
- **Recorded.** Three values are recorded on the planned order and on the
  OMS ticket:
  - the target, which is exactly the signed `makerAmount`;
  - **the conversion price `q`**, `conversionPrice` (`R3-L1`). The OMS needs
    it for D4.2's alert threshold, and cannot recover it from the target:
    5 shares at a `q` of 0.340 or of 0.341 both give 1.70;
  - **the signed share side**, `signedShares`: D2.4's `takerAmount` rule
    applied to the target and the limit. The planner already computes it for
    the minimum check (D2.3).

  `plannedShares` stays on the plan, and in the ticket's `shares`, as the
  strategy's intended size: the attributions sum to it.
- **Only FAK and FOK entry BUYs convert.** GTC and GTD BUYs, and every SELL,
  target shares (F-63; A F-82). A BUY-to-close never converts: it is
  share-targeted (D4.3), and the planner refuses a FAK or FOK BUY-to-close
  (D3.3).
- **The minimum** is checked on the signed share side (D2.3; A F-105).
- **A departure from `V2-10`.** Its `collateralTargetAtLimitPrice` converts
  at the limit price and floors to whole base units (6 decimals). D4 converts
  at `min(limitPrice, bestAsk)`, so that the target does not buy beyond
  `plannedShares` on every book that asks below the limit, and floors to
  0.01, because the SDK signs that amount and the simulator must match it.
  Authority: handoff §13.2 for the first (its `risk` block), and the venue
  documentation and the SDK for the second (handoff §1.1).

**D4.2 The OMS and reconciliation, for a collateral-targeted BUY.**
- **When fills exceed `plannedShares`** (variant P of D4.1; under variant H no
  such order exists):
  - the excess is real and is kept: no rule can undo a fill;
  - the OMS allocates it (attribution, below);
  - **beyond the rounding excess** (`SHARE-CAP`), that is when the order's
    shares reach the stationary-book bound `plannedShares + n × 10⁻⁶ ÷ q`
    (D4.1), at least one leg was below `q`. The OMS then raises a non-halting
    `ENTRY_SHARE_BOUND_EXCEEDED` alert, with a metric. The rounding excess
    alone, below that bound, is a valid fill and raises nothing. `q` is the
    ticket's `conversionPrice` (D4.1; `R3-L1`), and `n` counts the order's
    distinct maker legs. The substitute `target ÷ plannedShares` is sound,
    since it is at most `q`, but looser, so it is not used. PAPER runs no OMS
    and raises no alert; the excess shows in its fills;
  - the strategy's caps count the actual position at once, rounding excess
    included, so the next entry is trimmed to the headroom or refused (D4.3);
  - the exit sells the actual position, floored to the grid (D4.3).

  Why the alert does not halt: a halt cannot undo the fill, and a market
  quarantine would block the exit that reduces it.
- **The share bounds do not apply.** "Matched ≤ original" in `#applyPresent`
  and "a fill beyond the order" (`#fillInconsistency`) do not apply to such an
  order. Its fills exceed the signed `takerAmount` whenever the book asks
  less than the limit: "ExchangeV3 reduces a BUY's remaining collateral budget
  by the amount actually spent" (F-63).
- **The order's share quantities, and how it ends** (`R3-M1`). Every share
  rule of the OMS is listed here for such an order. Round 2 lifted only two
  of them, and left two that halt a valid fill.

  | Quantity or rule | For a collateral-targeted BUY |
  | --- | --- |
  | `shares` on the ticket | `plannedShares`. The attributions sum to it (`order-manager.ts:294-295`), as today |
  | `originalShares` on the order (`:2434`), and on the attempt's facts (`:2055`) | the ticket's `signedShares`: the signed share side, which is what the read's `original_size` carries under A11. `#applyPresent`'s `original_size` check (`:2116`) and `matchesExactly` (`identity.ts:64-71`) compare it, unchanged in form. The OMS also checks at signing that the signed `takerAmount` equals it exactly, and the `makerAmount` the target (D2.4) |
  | **Completion by share equality** (`#recordFill`, `:1268-1272`: FILLED, `finalSize = originalShares`) | **does not apply.** No fill makes such an order FILLED or fixes its final size, whatever its running total. It ends at its answer (D3.5) |
  | "a fill beyond the order" (`#fillInconsistency`, `:2299`) | lifted (above) |
  | "a fill beyond the confirmed final size" (`:2300`) | **kept, against a final size a read fixed.** For such an order that is the only kind, since no fill fixes one. The read that fixes it is made after the venue has ended the order: after its answer, or, in the lost-answer arm, once quiescent (below). Its `size_matched` counts every match (A11). A fill beyond it contradicts the venue, as for every order. Before a read, the spend guard below is the bound |
  | `#applyPresent`'s "matched ≤ original" (`:2120`) | lifted (above). Its "matched ≥ the recorded fills" is kept |
  | the read's state (`presentState`, `:2999-3011`) | `MATCHED`, or `CANCELED` with a positive `size_matched`, is terminal: FILLED (D3.5; `R4-L3`). For a FOK, an under-spend raises the FOK fill conflict (D3.5; `CX034-R4-01`) |
  | the final size | only from a read: `size_matched`, under A11 |
  | `remainingShares` on each order event (`:2468`, `:2576`) | `max(0, originalShares − filledShares)`, since the fills may exceed the signed share side and the column is non-negative (`0005_execution.up.sql:411`). The event's payload also carries the collateral remaining, the target less `Σ eᵢ` |
  | the reservation at the door (`#reservationProblem`, `:1481`: at least limit × shares) | at least the target. The fee bound is the planner's, on top (below) |
  | `FillRecord.notional` (`:1257`, shares × price) | the fill's spend `Σ eᵢ`, the principal the ledger books (D4.5) |
  | the group's `remaining` (`#saltGate`) | in collateral (below) |

  - **The ticket door** refuses, with `OMS_INVALID_INPUT`, a
    collateral-targeted ticket:
    - whose target is not `floor₀.₀₁(shares × conversionPrice)`;
    - whose `conversionPrice` is above its limit;
    - or that lacks the target, the conversion price or the signed share
      side.

    The door has no tick size, so the signed share side is checked at signing,
    against the signed `takerAmount`.
  - **Example** (D4.7 item 4). `plannedShares` 50, a limit and a best ask of
    0.34, so a target of 17.00 and a signed share side of 50.0000 (`17.00 ÷
    0.34`, exactly). An ask of 0.33 × 50 appears after the snapshot. The fills
    are 50 at 0.33 (a spend of 16.50) and then 1.470588 at 0.34
    (`floor₆(0.49999992)` = 0.499999). The spend is 16.999999, within
    17.00. After the first fill the running total equals `originalShares`.
    Today that completes the order at 50, and the second fill is refused
    `FILL_INCONSISTENT`, a halt. Under this rule the order stays open to
    fills. The `matched` answer makes it FILLED. A read with `size_matched`
    51.470588 fixes the final size. The fills sum to it, so the gate opens and
    0.000001 plus the unused fee bound is released. With one maker leg per
    fill, the bound is 50 + 2 × 10⁻⁶ ÷ 0.34 ≈ 50.0000059, so `ENTRY_SHARE_BOUND_EXCEEDED` is raised,
    without a halt, and the 51.470588 shares are attributed to the intent.
- **The collateral spent, per maker leg** (`CX034-R1-05`, `CX034-R2-03`).
  - F-63 floors each maker fill: `counterAmount = floor(makerAssetFill ×
    takerAmount / makerAmount)`. For a maker SELL that is the collateral it
    receives, which our BUY spends. One OMS fill can aggregate several maker
    matches. WP-280 emits one fill per own taker leg, of the summed maker
    amounts, and requires every maker leg at the fill's price
    (`oms-projection.ts:180-191`, `:235-247`).
  - So `FillReport` carries the fill's maker legs: their matched amounts `mᵢ`
    and prices `pᵢ`. They come from the stream's `maker_orders` and from the
    REST trade's (A F-106).
  - **A leg's spend** is `eᵢ = floor₆(mᵢ × pᵢ)`, in base units. It equals
    F-63's `counterAmount` for every maker whose signed amounts equal its
    price, as on-grid makers' amounts do (A F-102). For any other maker it is an
    inference. It sharpens round 1's interval, `Σ(m × p) − n × 10⁻⁶ < S ≤
    Σ(m × p)`, by applying the floor per leg.
  - **The guard.** The venue never spends more than the target. So `Σ eᵢ >
    collateralTarget`, over the order's distinct legs, is a contradiction. It
    raises the halting conflict as today ("a fill beyond the order"), before
    anything is consumed. Example: three legs of 16.666668 at 0.35 spend 3 ×
    5.833333 = 17.499999, within 17.50, and pass. The same fill reported as
    one leg spends `floor₆(17.5000014)` = 17.500001, and halts.
  - A duplicate delivery counts once. Fills are deduplicated by trade id,
    order id and discriminator (§10.7), so a leg is never counted twice.
- **The OMS's reservation accounting** (`CX034-R2-03`).
  - **Today:** `#debitOf` debits a BUY at shares × price
    (`order-manager.ts:2307-2311`). `InventoryBook.consume` refuses any
    amount above the reservation's remainder (`INVENTORY_OVER_CONSUMPTION`,
    `packages/inventory/src/inventory-book.ts:462-468`). `#consume` then
    raises a halting `RESERVATION_SHORTFALL` (`order-manager.ts:2334-2337`).
    For the three legs above that debit is 50.000004 × 0.35 = 17.5000014,
    above a zero-fee reservation of 17.50: a valid fill would halt.
  - **For a collateral-targeted BUY:**
    1. **Reserve** the target plus the fee bound (the last bullet of D4.2).
    2. **Debit** each fill by its spend `Σ eᵢ`, plus its collateral fee as
       today. Never by shares × price.
    3. **Persist** the debit in the FILL event's payload, as every debit is
       persisted today (`payload.debit`, `order-manager.ts:1269`; restored on
       recovery at `:3674`), with the fill's legs (Open item 4).
    4. **Consume** that debit through `#consume`. The guard keeps `Σ eᵢ` within
       the target, so the principal never over-consumes. A fee beyond the fee
       bound still raises `RESERVATION_SHORTFALL`, as today.
    5. **Release** by `#maybeRelease`'s rule, unchanged: the order is
       terminal, its final size is fixed by a read, its fills sum to it, and
       every consume succeeded. The remainder released is the reservation
       less the debits: 0.000001 in the example, plus any unused fee bound.
    6. **Reconcile** the order's shares as today: the read's `size_matched`
       against the fills, under A11. No order read carries the spend (A
       F-106), so the spend is reconciled at the account. WP-290 compares the
       collateral balance A with the ledger's projection P, allowing for the
       trades still in transit (`compareHolding`, `coordinator.ts:2172`;
       defined at `packages/oms/src/reconciliation/holdings.ts:111-119`).
       That comparison is exact, so **both of its
       inputs carry the spend** (`R3-M2`, `CX034-R3-01`):
       - **the projection P.** The ledger books the fill's principal at the
         spend `Σ eᵢ`, never at shares × price (D4.5;
         `packages/ledger/src/fill-posting.ts:254`, `:269`, `:275` today);
       - **the pending delta.** `pendingDeltas`
         (`holdings.ts:60-108`) prices a leg's collateral at shares × price
         (`:83`). For a leg of an order the OMS tracks as a
         collateral-targeted BUY, the coordinator passes the spend the OMS
         recorded for that fill (by trade id and venue order id), and the
         leg's collateral delta is minus that spend, plus the fee as today.
         **A leg whose fill the OMS did not record** (the fill was withheld
         for want of legs, below; `R5-M1`, replacing round 4's `R4-L1`
         sequence). Nothing is estimated: in `pendingDeltas`, the leg's
         collateral delta is **not exact**. But the holding comparison never
         sees this leg, because WP-290 defers it. Read from the code at
         `3294201`:
         - **while the venue's trades read shows the trade,** the trade's own
           leg names our venue order id, so it joins the order's legs
           (`legsByOrder`, `coordinator.ts:1137-1142`). The OMS holds no fill
           for it, so its probe is `UNKNOWN` (`OMS_UNKNOWN_FILL`,
           `:1644-1647`), and `#compareFills` raises, in every run that
           compares the order:
           - **with the leg's fee known,** `TRADE_MISSING_IN_OMS`, with a
             delivery act (`:1966-1975`). The OMS refuses the legless
             `FillReport` for such an order with `OMS_INVALID_INPUT` (the
             no-legs rule below), so the delivery adds `FILL_REFUSED`
             (`:2066-2080`). That refusal is not a contradiction, so the next
             run offers the delivery again (`:2041-2045`);
           - **with the leg's fee unknown,** `FILL_ECONOMICS_UNFIXED`, and no
             delivery: nothing is booked with a guessed fee (`:1955-1965`);
         - **those three classes defer holdings.** `TRADE_MISSING_IN_OMS`,
           `FILL_ECONOMICS_UNFIXED` and `FILL_REFUSED` are all in
           `DEFERS_HOLDINGS` (`:328-336`), so the run sets `holdingsDeferred`
           and never calls `#compareHoldings` (`:950-958`). No `MATCH`, no
           `IN_TRANSIT_AMBIGUOUS`, no `UNEXPLAINED` and no
           `HOLDING_DELTA_UNCONFIRMED` is judged for the collateral, and
           nothing is booked;
         - **the run cannot pass.** `#resumeBlocker` refuses it ("holdings
           were not judged", `:3076`), so submissions stay paused (the RESUME
           rules, `:185-208`). A deferral asks for another run at once
           (`:2905`), and that run defers again. The account holds, and the
           OMS holds the order's reservation and its salt gate (the no-legs
           rule below);
         - **if a complete trades read omits the trade** while the evidence
           holds it (a WP-280 request that named it, `streamRequestRecords`,
           `:4024-4027`, or an earlier read that showed it), the trade's
           verdict is a conflict and the view is unsound (`:1131-1133`).
           Holdings are then not judged either (`:950`);
         - **this lasts** until a read carries the legs, so that the delivery
           is accepted and the fill is recorded and booked at its spend, or
           until an operator resolves the order.

         **`BALANCE_UNATTRIBUTED` is never reached for the spend of a
         tracked order's fill that the OMS did not record.** The deferral is
         the guard that prevents it: "a delta such an order explains is
         never booked UNATTRIBUTED" (`:951-954`). No round may weaken that
         guard to make a test pass (D4.7 item 4's mutation row). The
         holding-break path below applies only to a fill the OMS recorded and
         verified, whose booked spend differs from the venue's.

       On the three-leg fill below, at zero fee and a balance of 1000: P is
       982.500001, and the pending delta is −17.499999. Before settlement A
       is 1000, so `d` = 17.499999 = −(the pending delta): `MATCH_IN_TRANSIT`.
       After settlement A is 982.500001: `MATCH`. With the booking at shares
       × price (17.5000014), the result after settlement is `UNEXPLAINED`
       (`d` = 0.0000024), then `HOLDING_DELTA_UNCONFIRMED`. With only the
       pending delta at shares × price, it is `IN_TRANSIT_AMBIGUOUS` before
       settlement.

       After settlement, a booked spend that differs from the venue's real
       spend, as an off-ratio maker could cause, shows as a collateral delta.
       The existing holding-break rules handle it
       (`HOLDING_DELTA_UNCONFIRMED`, then `BALANCE_UNATTRIBUTED`, `:2313`).
       **No balance tolerance is added.** Nothing adjusts a delta silently.
- **A fill with no maker legs** (`NEW-L3`). The stream's `maker_orders` is
  optional, and the REST examples show an empty array (A F-106). Without legs,
  the OMS can neither compute nor bound a collateral-targeted BUY's spend:
  - WP-280 already withholds such a fill as a shortfall
    (`TAKER_ECONOMICS_UNVERIFIABLE`, `oms-projection.ts:180-186`), which
    requests reconciliation;
  - the OMS refuses, with `OMS_INVALID_INPUT`, a `FillReport` without legs
    for such an order;
  - a REST trade without legs fixes nothing either. No fill is recorded, so
    the order's fills cannot sum to its final size. The salt gate stays
    closed and the reservation stays held (`#maybeRelease`), until a read
    carries the legs or an operator resolves the order. Nothing is inferred.
  - Whether such trades carry their legs is part of U-51.
- **The group's remaining is in collateral.** For such a group, the salt
  gate's `remaining` (`#saltGate`, `order-manager.ts:2384`) is the target less
  the spend `Σ eᵢ` of its orders' fills. The guard keeps it at 0 or above.
  Shares beyond `plannedShares` never trip the gate's invariant ("a group's
  final sizes exceed its plan").
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
    not bounded by it; the spend guard above bounds the fills.
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
    bounds cap (so the next entry is trimmed to the headroom, below), and
    its PnL is valued at worst-case resolution;
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
  So a residual (`V2-10`'s probe B left 0.000002) no longer keeps the bracket
  open.
- **Re-entry after a residual** (`NEW-M1`).
  - **The cap counts the residual,** as it counts any held share. Today
    `applyEntryCaps` refuses `held + size > maximum_position_shares`, and
    never trims (`decide.ts:1194-1208`; `held` is the instance's virtual
    holding, `observe.ts:314-316`).
  - **Why that blocks re-entry.** In the reference configuration
    `maximum_position_shares` equals `size_shares`, 50
    (`test/e2e/support/scenario.ts:220`, `:262`), and the two-bracket run
    re-enters the same market (`two-brackets.ts:69-70`). Any residual would
    refuse every later full-size entry: D4.6's 0.008571 gives 50.008571 >
    50. That would defeat `V2-10B`'s liveness.
  - **So the entry is trimmed to the headroom, on the grid.** When every
    share the instance holds in its direction is a recorded residual, the
    entry's size is `floor₀.₀₁(min(size_shares, maximum_position_shares −
    held))`.
    - It is computed where the size is chosen today (`decide.ts:1017`),
      before the minimum check and the leg's quote. So every later check
      (minimum, quote, cost, loss, slippage, participation, edge) is made on
      the trimmed size.
    - A trimmed entry records `POSITION_CAP_HEADROOM`, with both sizes.
    - A trimmed size of 0, or one below the market minimum, is refused as
      today. Any other held quantity (an excess not yet exited, D4.2) refuses
      as today, untrimmed.
    - Example: after D4.6's residual of 0.008571, the next entry is 49.99,
      and the position stays within 50.
  - The cap itself is unchanged. This refines Static Bracket's entry sizing
    (§13); it is within R3's grant.
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

**D4.5 One principal, in PAPER and live** (`R3-M2`).
- **The principal of a collateral-targeted BUY's fill is its spend.** Live,
  that is `Σ eᵢ`, validated by D4.2's guard. In PAPER it is the simulator's
  `collateralAmount`, F-63's per-level floor (`V2-10` round-0 handoff, known
  risk 2). Both are at most price × shares, because every leg of one fill has
  the fill's price (D4.2) and a floor never rounds up.
- **Every site that prices a fill's principal uses it.** The sites were found
  by `grep -rn 'mulDecimal('` over the non-test sources of `packages/oms`,
  `packages/ledger`, `packages/pnl`, `packages/trading-core` and
  `packages/simulation` at `3294201`, and each match was read:

  | Site | Today | For such a fill |
  | --- | --- | --- |
  | `FillFact` (`packages/ledger/src/allocation.ts:65`) | shares and price | gains a **required** `principalBasis`, and a `collateralAmount` that is required under `COLLATERAL_SPEND` and refused otherwise (the basis, below; `CX034-R4-02`): a contract change for its owner, WP-200's package |
  | `buildFillPosting` (`packages/ledger/src/fill-posting.ts:254`, `:269`, `:275`) | `TRADE_PRINCIPAL` and each owner's cost at price × shares | chosen by `principalBasis`, never by whether an amount is present. Under `COLLATERAL_SPEND`, `TRADE_PRINCIPAL` books `collateralAmount`, and so does the actual-account PnL record's cost; each owner's cost is its claim's share of it (below). Under `SHARES_AT_PRICE`, price × shares, as today |
  | `PnlTradeRecord` (`packages/pnl/src/records.ts:162`), and `applyTrade` (`packages/pnl/src/state.ts:574-590`) | cost = price × shares | the record carries the same **required** `principalBasis`, copied from the fact, and a `notional`, the owner's booked cost, required under `COLLATERAL_SPEND` and refused otherwise. `applyTrade` uses `notional` under `COLLATERAL_SPEND` and price × shares under `SHARES_AT_PRICE`. So the PnL cost basis equals the ledger's principal. A reversal unwinds the logged effect, unchanged |
  | the OMS's `FillRecord.notional` and `#debitOf` (`order-manager.ts:1257`, `:2309`) | price × shares | the spend (D4.2) |
  | `pendingDeltas` (`packages/oms/src/reconciliation/holdings.ts:83`) | price × shares | the spend the OMS recorded (D4.2 item 6) |
  | trader cash, `cashAfter` (`packages/trading-core/src/loop.ts:5883-5887`) | price × shares, plus the fee | `collateralAmount`, plus the fee |
  | `toFillFact` (`packages/simulation/src/fill-model.ts:517-545`) | no collateral | takes `principalBasis` from its caller, as a required argument, and passes `collateralAmount` only under `COLLATERAL_SPEND`. Every simulated fill carries a `collateralAmount` (`fill-model.ts:106`), share-targeted ones included, so its presence cannot say which basis applies |

- **Kept at price × shares, because it is conservative there:**
  - the core's `CostBasisBook` (`packages/trading-core/src/allocation.ts:554`,
    `:563`), the capital a held position consumes from the caps. It
    over-counts by under 10⁻⁶ per maker leg, and it keeps its rule of no
    division;
  - `allocation.ts:862` and `:1078`, which price planned parts not yet
    filled at the limit. That is at least the target.
- **The owners' split.** The ledger never prorates by silent division
  (`LEDGER_FEE_SPLIT_MISMATCH`, `allocation.ts:97-102`, `:298`), and the same
  rule holds for this principal:
  - with one owner, its cost is `collateralAmount`;
  - with more than one, each `AllocationClaim` carries its `collateralAmount`
    explicitly. A claim's `collateralAmount` is refused under
    `SHARES_AT_PRICE`. They must sum exactly to the fill's, else the new refusal
    `LEDGER_PRINCIPAL_SPLIT_MISMATCH`, beside the fee's (`packages/ledger/src/refusals.ts:122-127`);
  - the caller computes them. Each owner but the last gets
    `floor₆(spend × ownerShares ÷ fillShares)`. The last band takes the rest,
    as it takes the share excess (D4.2), so no cost is negative. Example:
    50.000004 shares, a spend of 17.499999, and bands of 30 and 20.000004
    give 10.499998 and 7.000001.
- **The principal's basis is explicit** (`CX034-R4-02`). An optional amount
  alone cannot be enforced: a collateral-targeted fact that lost its
  `collateralAmount` would look exactly like a valid share-targeted fact, and
  would be booked at price × shares (17.5000014 instead of 17.499999 for the
  three legs of D4.2). So the basis is an independent, required field of
  both contracts, and nothing infers it from an amount:
  - **`principalBasis`**, `SHARES_AT_PRICE` or `COLLATERAL_SPEND`, is
    required on every `FillFact` and every `PnlTradeRecord`. A fact or
    record without it is refused at the warmed door (`LEDGER_INPUT_INVALID`,
    `allocation.ts:192-198`; `PNL_INPUT_INVALID`).
  - **Under `COLLATERAL_SPEND`** the fact's `collateralAmount` and the
    record's `notional` are required, and the side is BUY. The fact's amount
    is positive and at most price × shares. A fill whose every leg spends 0
    (`floor₆` below one base unit) is refused, as the ledger books no zero
    entry (`LEDGER_ENTRY_AMOUNT_ZERO`); that fails closed. A record's
    `notional` is positive too. Although the attribution bands are on D2's
    grid, an individual fill can allocate sub-grid shares to an owner when
    it crosses a band boundary: `allocationsFor` allocates a fill as the
    difference of cumulative band allocations (`order-manager.ts:3062-3075`).
    That owner's `floor₆` part can therefore be 0, even at ordinary prices
    (`CX034-R5-01`). Example (D4.7 item 9): bands of 30 and 20, with
    29.999999 already filled; a next fill of 1 at 0.35 spends 0.350000 and
    allocates 0.000001 share to the first owner, whose part is `floor₆(0.35
    × 0.000001 ÷ 1)` = 0. A zero part is refused. That fails closed, and it
    can stop the accounting of an otherwise valid fill. A part is not
    bounded by its own price × shares, because the last
    owner takes the split's remainder: owners of 1.000001 and 0.999999
    shares of a 0.70 spend at 0.35 get 0.350000 and 0.350000, and the second
    exceeds 0.34999965. Anything else is refused at the door
    (`PNL_INPUT_INVALID` from `PnlRecordDoor`, `packages/pnl/src/state.ts:480`).
  - **Under `SHARES_AT_PRICE`** both are refused when present, and the
    principal is price × shares, as today. This is the legacy rule,
    qualified: it applies to a fact that **states** the share basis, never to
    one that merely lacks an amount.
  - **Who sets it.** The basis comes from the order's target kind, one
    value per order: `COLLATERAL_SPEND` exactly when the plan and the ticket
    carry a `collateralTarget` (D4.1), and `SHARES_AT_PRICE` otherwise.
    In PAPER, `trading-core` passes it to `toFillFact` from the planned
    order. Live, the fact's producer reads it from the order's persisted
    target (Open item 4), never from a fill. A producer that states the
    wrong basis is the one error the ledger cannot see. It is confined to
    that one derivation, which is tested (D4.7 item 9), and it fails closed
    downstream: in PAPER through D4.7 item 9's agreement case, and live as a
    holding break after settlement (D4.2 item 6).
  - **No version decoder is needed.** At `3294201` neither contract is read
    back from storage: the only parsers are the warmed doors (`FillFactDoor`,
    `allocation.ts:114`; `PnlRecordDoor`, `packages/pnl/src/records.ts:330`),
    fed in-process by their producers. If R3 finds a stored reader, it
    decodes a record written before D4 as `SHARES_AT_PRICE`. That is sound,
    because no such record can be collateral-targeted. The round reports
    the reader.
- **Missing economics fail closed.** A live fill without maker legs is never
  recorded (D4.2), so nothing is booked for it. In PAPER every simulated fill
  carries a canonical `collateralAmount`
  (`packages/simulation/src/queue.ts:746-751` refuses one that is not). A
  `COLLATERAL_SPEND` fact without its `collateralAmount`, or a
  `COLLATERAL_SPEND` record without its `notional`, is refused, never booked
  at price × shares.
- **Out of scope:** a share-targeted taker BUY against an off-grid maker also
  pays F-63's per-leg floor. Its m × p is not then exact in base units, so its
  booking can differ from its spend by under 10⁻⁶ per leg. That exists today,
  and fails closed as a holding break (D4.2 item 6). It is a follow-up, not
  decided here.

**D4.6 Golden and replay changes.** Each is regenerated with a recorded
reason. The list assumes variant P of D4.1; under variant H, the FAK entries
below become refusals or a GTC configuration instead:
- `test/replay-golden/paper-e2e/paper-e2e-run.json`. Its entry, 50 at limit
  0.35 over the asks 0.34 × 30 and 0.35 × 40
  (`test/e2e/support/scenario.ts:122-125`), now targets 17.00 and buys 30 +
  19.428571 = 49.428571. The exit sells 49.42, leaving a `SUB_GRID` residual
  of 0.008571;
- `test/replay-golden/paper-e2e/two-brackets-run.json`. Its brackets' best
  asks (0.34 × 60 for bracket 1, 0.33 × 60 for bracket 2;
  `two-brackets.ts:72-82`) convert to exactly 50 shares each (17.00 ÷ 0.34,
  16.50 ÷ 0.33) and leave no residual, so it shows both entries at 50;
- **a new residual-producing two-bracket scenario** (`NEW-M1`), in
  `test/e2e/support/scenarios/`, with its golden beside the others in
  `test/replay-golden/paper-e2e/`. Bracket 1 enters over the paper-e2e
  ladder (0.34 × 30, 0.35 × 40) and leaves the residual of 0.008571.
  Bracket 2's entry is trimmed to 49.99 (D4.3), enters, and the position
  never exceeds 50;
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
2. **The caps** (`CX034-R1-02`), with `SHARE-CAP`, under the ruled variant:
   - **variant P:** with `maximum_position_shares` 50, a 50-share FAK BUY
     against a book whose asks are all at or above the snapshot's best ask
     buys less than `plannedShares + n × 10⁻⁶ ÷ q`. The three-leg case buys
     50.000004, raises no alert, and after its exit the next entry is
     trimmed to 49.99. One mutation row converts at the limit price instead,
     and fails the test;
   - **variant H:** the same entry is refused `PLAN_SHARE_CAP_UNENFORCEABLE`
     before any reservation, and the GTC route signs a share-targeted order
     of 50.
3. **A fill below the snapshot's best ask** (variant P; an ask that appeared
   after the snapshot): the excess is kept, attributed to the last band,
   raises `ENTRY_SHARE_BOUND_EXCEEDED`, and refuses the next entry until the
   exit; the exit sells the whole position, floored to 0.01.
4. **The OMS** (`MEDIUM-3`, `CX034-R1-05`, `CX034-R2-03`):
   - bands of 30 and 20 and fills of 51.470588 allocate 30 and 21.470588, with
     nothing UNATTRIBUTED;
   - three maker legs of 16.666668 at 0.35 against a target of 17.50 pass the
     guard; the same fill reported as one leg halts; a duplicate delivery
     does not count a leg twice;
   - **the composed accounting case:** with a zero fee and a reservation of
     exactly 17.50, the three-leg fill debits 17.499999, consumes with no
     `RESERVATION_SHORTFALL`, and, once a read fixes the final size, releases
     0.000001. One mutation row debits shares × price (17.5000014) instead,
     and fails it with the shortfall;
   - **the same case, through reconciliation** (`R3-M2`, `CX034-R3-01`). The
     fill is posted through `buildFillPosting`, and the ledger's principal is
     17.499999. A WP-290 run with the trade `MATCHED` and a collateral
     balance of 1000 judges the collateral `MATCH_IN_TRANSIT`. A run after
     the trade is `CONFIRMED`, with a balance of 982.500001, judges it
     `MATCH`. The token is `MATCH_IN_TRANSIT`, then `MATCH`. No holding
     break is raised. Two mutation rows each fail it:
     - the posting books shares × price: `UNEXPLAINED` after settlement;
     - `pendingDeltas` prices the leg at shares × price:
       `IN_TRANSIT_AMBIGUOUS` before settlement.

     **A leg whose fill the OMS did not record** (`R5-M1`; D4.2 item 6).
     The trade's stream event was withheld for want of maker legs, and the
     trades read shows the trade, with no maker legs, in each of `MATCHED`,
     `MINED` and `CONFIRMED`, against balances of 1000 and 982.500001:
     - **the fee known:** every run raises `TRADE_MISSING_IN_OMS` and, on
       the refused delivery (`OMS_INVALID_INPUT`), `FILL_REFUSED`. The
       delivery is offered again by the next run;
     - **the fee unknown:** every run raises `FILL_ECONOMICS_UNFIXED`, and
       nothing is delivered;
     - **in both branches,** in every run and whatever the trade's status
       and the balance:
       - the run's holdings are deferred (`holdingsDeferred`), and no
         holding verdict is recorded for the collateral: no `MATCH`,
         `IN_TRANSIT_AMBIGUOUS`, `UNEXPLAINED` or
         `HOLDING_DELTA_UNCONFIRMED`;
       - the run is not `PASSED`, and submissions stay paused;
       - nothing is booked: no `BALANCE_UNATTRIBUTED`, and no call to the
         holdings port's `bookUnattributed`, even after
         `holdingConfirmationMs` has elapsed;
       - the order's reservation and its salt gate stay held;
     - **the way out:** a later trades read that carries the maker legs is
       delivered and accepted, the fill is recorded and booked at its spend
       of 17.499999, and the next run judges the collateral `MATCH`;
     - **one mutation row** removes `TRADE_MISSING_IN_OMS`,
       `FILL_ECONOMICS_UNFIXED` and `FILL_REFUSED` from `DEFERS_HOLDINGS`.
       The holding comparison then runs and, once the trade is `CONFIRMED`
       and `holdingConfirmationMs` has elapsed, books the spend as
       `BALANCE_UNATTRIBUTED` (`#bookUnattributed`), failing the test;
   - **fills that cross `plannedShares` part-way through** (`R3-M1`), D4.2's
     example: 50 at 0.33, then 1.470588 at 0.34, against a target of 17.00
     whose signed share side is 50.0000. Both fills are recorded. Neither
     raises `FILL_INCONSISTENT`, and the order is not FILLED before its
     answer. The `matched` answer makes it FILLED, with no final size, and
     requests a read. A read whose `size_matched` is 51.470588 and whose
     status is `MATCHED` fixes the final size. The gate opens, 0.000001 is
     released, and `ENTRY_SHARE_BOUND_EXCEEDED` is raised without a halt.
     Two mutation rows each fail it:
     - keep the share-equality completion (`order-manager.ts:1268-1272`) for
       such an order: the second fill halts;
     - keep `presentState`'s PARTIALLY_FILLED for a `MATCHED` read of an
       immediate order: the read halts with "an order believed terminal is
       open at the venue";
   - **a walk that never reaches `plannedShares`** (D4.6: 30 at 0.34, then
     19.428571 at 0.35, 49.428571 in all): FILLED at the answer, the final
     size 49.428571 from the read, and D1's T is the latest of its fills'
     instants (D1.3);
   - **a late `PLACEMENT` frame** for such an order (D1), against fills whose
     `MATCHED` events were received. Stamped one millisecond before the last
     of them, it is held until the read fixes the final size, and is then
     STALE, with no halt. Stamped one millisecond after it, it halts. Both hold
     whether the read answers an `ORDER_STATE` or the `ORDERING` request;
   - **the ticket door:** a target that is not `floor₀.₀₁(shares ×
     conversionPrice)`, or a `conversionPrice` above the limit, is refused
     before any reservation. `ENTRY_SHARE_BOUND_EXCEEDED`'s threshold is
     computed from the ticket's `conversionPrice` (`R3-L1`): with the
     three-leg fill and a `conversionPrice` of 0.35, 50.000004 raises
     nothing;
   - a `FillReport` without maker legs for such an order is refused, and the
     order's reservation stays held (`NEW-L3`);
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
     closes;
   - **re-entry after a residual** (`NEW-M1`): the residual-producing
     two-bracket scenario of D4.6 enters twice, the second time at 49.99,
     and the position never exceeds 50. A held excess that is not a residual
     refuses the next entry, untrimmed. One mutation row removes the trim,
     and the second entry is refused, failing the test;
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
9. **The principal** (`R3-M2`; D4.5), in `packages/ledger` and
   `packages/pnl`:
   - a `COLLATERAL_SPEND` `FillFact` books `TRADE_PRINCIPAL` at its
     `collateralAmount`, and its PnL records carry `COLLATERAL_SPEND` and the
     owner's cost as `notional`;
   - the split: 10.499998 and 7.000001 for D4.5's example; a split that does
     not sum exactly is refused `LEDGER_PRINCIPAL_SPLIT_MISMATCH`;
   - **a fill that crosses a band boundary** (`CX034-R5-01`; D4.5): bands of
     30 and 20, with 29.999999 already filled, and a next fill of 1 at 0.35.
     The OMS allocates 0.000001 and 0.999999 share (`allocationsFor`), and
     the spend is 0.350000. The first owner's part is `floor₆(0.35 ×
     0.000001 ÷ 1)` = 0, and the last owner's is 0.350000. The zero part is
     refused (a `PnlTradeRecord` whose `notional` is 0 is refused
     `PNL_INPUT_INVALID`), and the test asserts that the refusal is
     reachable at this ordinary price and fails closed;
   - **the negative cases** (`CX034-R4-02`), each refused and booking
     nothing:
     - D4.2's three-leg fact under `COLLATERAL_SPEND` with its
       `collateralAmount` removed is refused `LEDGER_INPUT_INVALID`, and is
       never booked at 17.5000014;
     - a fact with no `principalBasis` is refused, with or without an amount;
     - a `SHARES_AT_PRICE` fact, or an `AllocationClaim` of one, that
       carries a `collateralAmount` is refused;
     - a `COLLATERAL_SPEND` SELL, or an amount above price × shares, is
       refused, and so is an amount of 0;
     - a `COLLATERAL_SPEND` `PnlTradeRecord` without its `notional`, a
       `SHARES_AT_PRICE` record with one, and a record with no
       `principalBasis` are each refused `PNL_INPUT_INVALID`, and the PnL
       state is unchanged;
     - one mutation row lets `buildFillPosting` choose by the amount's
       presence, and the first negative case books 17.5000014, failing the
       test;
   - **the legacy control:** a `SHARES_AT_PRICE` fact books price × shares
     exactly as today. Every existing ledger and PnL test passes with only
     `principalBasis: "SHARES_AT_PRICE"` added to its fixtures, and every
     expected value unchanged;
   - **the producer:** `toFillFact` called for a share-targeted fill whose
     simulated `collateralAmount` is a floor below price × shares yields
     `SHARES_AT_PRICE` with no amount; called for a collateral-targeted
     order's fill, it yields `COLLATERAL_SPEND` with that amount;
   - in PAPER, trader cash, the ledger's actual collateral line and the PnL
     cost basis agree after D4.6's paper-e2e entry (19.428571 at 0.35 has a
     `collateralAmount` of 6.799999, not 6.79999985).

**D4 changes PAPER fills and exits.**

## Implementation plan

The three rounds run **strictly in order: R1, then R2, then R3** (`LOW-8`).
Never two at once: R1 and R2 share `packages/oms/**` and the live,
reconciliation and OMS fault suites; R2 and R3 share `packages/oms/**`,
`packages/polymarket-secure/**`, `test/fault-injection/live/**` and
`test/fault-injection/oms/**`.

| Round | Decisions | Paths it needs | Order | Label | Acceptance |
| --- | --- | --- | --- | --- | --- |
| R1 `OMS-QTY` | D2 | `packages/execution-planner/**`, but not `src/probes/**` (WP-350's); `packages/oms/**`; `packages/polymarket-secure/src/venue-client.ts` and its tests; `packages/strategies/static-bracket/src/params.ts` and its tests; `test/unit/{execution-planner,oms,strategies}/**`; `test/contract/polymarket-secure/**`; `test/fault-injection/live/**`; `test/fault-injection/reconciliation/**`; and, test files only, `test/fault-injection/oms/**` and `test/fault-injection/live-safety/**`, which run on the OMS's shared test supports (`test/unit/oms/support/**`) whose signed amounts D2.4 checks | first | pre-live; a latent PAPER change, with no golden change | D2.6; all gates; the goldens byte-identical |
| R2 `OMS-VENUE-TIME` | D1 | `packages/oms/**`, including `src/reconciliation/**`; `packages/polymarket-secure/src/user-stream/**`; `test/unit/oms/**`; `test/contract/user-stream/**`; `test/fault-injection/reconciliation/**`; `test/fault-injection/live/**`; `test/fault-injection/oms/**` (`crash-points.test.ts:148`'s observation gains a venue instant, D1.10 item 4; `NEW-M2`); `apps/ops-cli/src/emergency/**`, only where it builds the `ReconciliationPolicy` (the new `orderingHorizonMs`) and its tests; `docs/runbooks/reconciliation.md` (the policy table's new row); `docs/experiments/phase-3-verification.md` (§5's counts to 0, with a dated note) | after R1 is merged | pre-live only | D1.10; all gates |
| R3 `TIF-COLLATERAL` | D3, then D4 | `packages/trading-core/**` (the bounded ADR-022 D10 grant of D3.6 and D4.5), its tests included; `packages/execution-planner/**`; `packages/oms/**`; `packages/polymarket-secure/**`; `packages/simulation/**`; `packages/strategies/static-bracket/**`; `packages/ledger/src/allocation.ts` (`FillFact` and `AllocationClaim`), `packages/ledger/src/fill-posting.ts` (the principal, D4.5; `R3-M2`) and `packages/ledger/src/refusals.ts` (the new refusal), with their tests (`packages/ledger/src/*.test.ts`), and `packages/pnl/src/records.ts` and `packages/pnl/src/state.ts` (`principalBasis` and `notional`), with their tests (`packages/pnl/src/*.test.ts`) and the sample builders `packages/pnl/src/testing/**`, which build `PnlTradeRecord`s (`CX034-R4-02`), all with WP-200's owner; `packages/risk/**`, only if the incident needs a new cause; the matching `test/unit/**`, which includes, test files only, `test/unit/{ledger,pnl,simulation,trader}/**`, whose fixtures build a `FillFact` or a `PnlTradeRecord` (`CX034-R4-02`); `test/contract/polymarket-secure/**`, `test/fault-injection/live/**`, `test/fault-injection/reconciliation/**`, `test/e2e/**` and `test/replay-golden/**`. **The fence** (`NEW-H1`; WP-320's paths, with its owner's consent): `apps/trader/src/live-safety/fenced-venue.ts`; `apps/trader/src/live-safety/live-safety.ts` and `index.ts`, only to carry the new member through `fenceVenue`'s types and the module's exports (D3.1 item 4); and the test files `test/fault-injection/live-safety/**` (`port-conformance.test.ts:73-80`), `test/fault-injection/oms/**` (`support/crash-harness.ts:125-130`) and `test/integration/postgres/fencing-race.test.ts` (its port literal at `:373-374`, type-checked by `packages/storage-postgres`'s `typecheck`, inside the root `typecheck`). **The removed side table** (`CX034-R3-02`): `apps/trader/src/index.ts`, only to remove the `OrderTimeInForceBook` re-export (`:303`), and `apps/trader/README.md`, only its section "The `immediate_order_type` question, resolved" (`:177-191`), which names the table and says that `PlannedOrder` carries no time-in-force. No compatibility export is kept: the class goes away (D3.1 item 2), and no test names it. From the rest of `apps/**`, **test files only:** `apps/backtest-cli/src/**/*.test.ts` (`backtest.test.ts`, `run-command.test.ts`) and `apps/trader/src/**/*.test.ts` (`loop-folds.test.ts` included) (`MEDIUM-4`); and `test/integration/paper-trader/**`, test files only, where they fold PAPER fills' PnL records by shares × price (`trader-health-endpoint-postgres.test.ts:217-236`), which D4.5 changes for a collateral-targeted BUY. **Not** `db/migrations/**`, `packages/domain/**`, `packages/decimal/**`, or any other non-test `apps/**` file: if one must change, the round stops and reports it | after R2 is merged. D4 only after the user's ruling on Open item 10; D3 does not wait for it. D3 with D4: one round, or two rounds merged back to back before any PAPER run is cited as evidence | D3: pre-live, plumbing only for PAPER. **D4: changes PAPER fills and exits** | D3.7, D4.7 (for the ruled variant); each golden with a reason; all gates |

**How the test grants were found** (`NEW-H1`, `NEW-M2`). At `3294201`, `grep
-rln` over every `*.ts` file listed each file that names a port the round
changes, or calls a method whose input it changes:
- for R3, `OmsVenuePort`, `PlacementVenuePort`, `fenceVenue` and
  `createLimitOrder`;
- for R2, `applyOrderObservation`, `OrderObservation` and
  `quiescenceHorizonMs`;
- for R1, the OMS's ticket and its test venues.

Round 3 added two searches (`R3-M2`, `CX034-R3-02`), because a port search
does not find a decision path or a removed name:
- every symbol a round removes, over every file outside `node_modules` and
  `.git`, including Markdown: for R3, `OrderTimeInForceBook`;
- every site that prices a fill's principal: `grep -rn 'mulDecimal('` over
  the non-test sources of the packages D4 touches (D4.5's table).

Round 4 added a third (`CX034-R4-02`), because a required member breaks
every literal of its contract: every `*.ts` file that builds a `FillFact`
(it names `denominationAssetId`, `fillId` and `shares`) or a
`PnlTradeRecord` (it names `denominationAsset` and `"TRADE"`). The matches
lie in `packages/{ledger,pnl,simulation,trading-core}/src/`, in
`packages/pnl/src/testing/samples.ts`, in `test/e2e/support/`, in
`test/unit/{ledger,simulation,trader}/` and in `test/integration/paper-trader/`,
all inside R3's paths above.

Each match was read, to see whether it builds such a value or passes such an
input. Every one that does lies inside its round's paths above. Files that
only receive a wrapped port need no change, for example
`test/contract/rate-limits/oms-integration.test.ts`, which wraps the shared
test venue. If a gate shows that any other path must change, the round stops
and reports it.

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
  - §5: refined for FAK and FOK (D3.5). A collateral-targeted BUY is FILLED
    at its `matched` answer, with its final size from a read; a read's
    `MATCHED` is terminal for an immediate order. A share-targeted FOK read
    as partly matched raises a sticky conflict, since a FOK fills whole or
    not at all (A F-80; `CX034-R4-01`).
  - §8: implemented by D3.4, with an explicit escalation.
  - §2 step 9: a retransmission keeps the order type (D3.1, item 5). An
    ABSENT FAK or FOK is never retransmitted (D4.2).
  - §11: the time-in-force sits in the persisted signed payload, which is
    secret, and on the order record, which is not.
- **ADR-008 and ADR-033 D1 item 4:** unchanged. D3.4's escalation uses the
  Incident Controller's explicit heartbeat stop, latched until an operator
  releases it; it does not rely on a lapse. The submission fence judges a
  market order at signing and at every transmission, exactly as a limit
  order, and remembers its scope (D3.1 item 4; `NEW-H1`).
- **ADR-006:** unchanged in its rules. A collateral-targeted BUY's principal
  is booked at its spend, each transaction still balances per asset, and the
  owners' split is explicit and machine-checked, like the fee's (D4.5). The
  principal's basis is a required field of WP-200's `FillFact` and
  `PnlTradeRecord`, so a missing amount is refused, never defaulted
  (`CX034-R4-02`).
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
- **Handoff §13.2, the `risk` block, and §9.8 check 13** (`SHARE-CAP`).
  - D4.1 converts at `min(limitPrice, bestAsk)`, so that the target does not
    buy beyond `plannedShares` on every book that asks below the limit.
  - The money caps hold on every book. The share caps
    (`maximum_position_shares`, `maximum_book_participation`,
    `participation.maxOrderShares`) **do not hold for the fill** of a
    collateral-targeted FAK or FOK BUY: rounding can exceed them by a
    sub-grid amount, and price improvement by any amount (D4.1).
  - Variant P, proposed, is a **named departure**: those caps become
    plan-time caps for these orders, with the excess detected and contained
    (D4.2, D4.3). Variant H keeps them hard by refusing such entries. Neither
    is adopted without the user's ruling (Open item 10). Authority for P,
    if ruled: the venue's FAK and FOK BUY targets collateral (F-63, handoff
    §1.1), so no share bound can be signed.
- **Static Bracket's entry size (§13):** after a residual, an entry is
  trimmed to the position cap's headroom on the grid (D4.3, `NEW-M1`). The
  cap is unchanged; today's refusal of every later full-size entry becomes a
  smaller entry within it.
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
  - FAK and FOK reach the venue port, through the fence.
  - A residue no longer blocks the next bracket: the next entry is trimmed to
    the cap's headroom (D4.3).
- **One number and one value.** The OMS, the reservation, reconciliation, the
  signed order and the mock agree on one quantity. PAPER and live read one
  time-in-force from the plan.
- **Costs.**
  - A hold pauses every submission of the account, not only its market,
    until venue time closes it or the horizon read halts it.
  - A STALE observation whose terminal frame arrives after the horizon read
    halts. If the venue emits no `CANCELLATION` for a REST cancel (U-54),
    every route-3 case halts after the horizon.
  - Equal millisecond values halt at once, and so does an overlap with a
    final interval. Adjacent values are ordered (D1.4).
  - **FAK and FOK under D1** (`NEW-L4`; conditional on U-50, not observed).
    - A FAK or FOK made terminal by its answer has a PENDING T, until the
      remainder's `CANCELLATION` or, for a filled one, its `MATCHED` events
      fix it (D1.3).
    - If the venue emits a `PLACEMENT` frame for such an order, delivers it
      after the answer, and stamps it with the same millisecond as that
      terminal evidence, the pair is UNORDERED, CLOSED: a halt at once. A
      placement one millisecond earlier is STALE.
    - Whether FAK and FOK emit order events at all, and with which values, is
      U-50. A10 does not decide it (D1.10 item 4), and D3.7 item 2 tests the
      equal-value halt.
    - The execution probe that gates FAK and FOK above PAPER observes it
      (Open item 3).
  - A collateral-targeted BUY converted at the best ask can buy fewer than its
    planned shares when it walks the book (D4.1).
  - A re-entry after a residual is smaller than `size_shares`, by the
    residual rounded up to the grid (D4.3). Under variant H, the reference
    configuration's FAK entries are refused.
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
  - Under variant P, the share caps of a collateral-targeted BUY are
    plan-time caps. Its fill can exceed them, by a sub-grid rounding excess
    on any book and by any amount under price improvement. D4.2 detects and
    contains the excess, but cannot prevent it. The money caps hold.
  - The OMS's spend of a collateral-targeted BUY is `Σ floor₆(mᵢ × pᵢ)`. It
    is exact for makers whose signed amounts equal their price, and an
    inference for any other. The ledger books, and reconciliation expects,
    that spend (D4.5), so a valid fill matches exactly, and a wrong spend
    surfaces as a collateral balance break after settlement (D4.2).
  - A collateral-targeted BUY is FILLED at its answer even when it spent
    part of its target. Consumers read its fills, never `plannedShares`, for
    what it bought (D3.5).
  - A FOK read as partly matched, or a collateral-targeted FOK BUY that
    under-spends beyond A13's bound, halts until an operator resolves it
    (D3.5). A13 is an assumption: if it is wrong, the cost is a halt.
  - `FillFact` and `PnlTradeRecord` gain a required member. Every producer
    and fixture states the basis (D4.5), so R3 touches every literal of both
    contracts (Implementation plan, the third search).
  - A12 (one clock and one rounding for every user-channel `timestamp`) is an
    assumption. If it is wrong, the cost is liveness (D1.7).
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
- **Widen every millisecond value on its own** (round 1). It treated two
  values of one clock as if their roundings were unrelated, so a `LIVE` one
  millisecond older than its `CANCELED` halted at once (`CX034-R2-02`).
  Rejected for points compared by value, under A12. Widening stays for a
  `match_time` and for mixed comparisons.

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
- **Make `createMarketOrder` optional on the port, and leave the fence
  alone** (`NEW-H1`). Transmission would still be judged, since the fence's
  `postOrder` and `postOrders` classify every order. But a market order
  would be signed with no gate decision and no remembered scope. Rejected:
  the fence judges signing too, for every order kind.

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
  shares for 17.50 at a tick of 0.01. Checking the caps on that refuses every
  entry. That is variant H (D4.1), kept as the alternative put to the user,
  with the GTC route for immediate entries.
- **Absorb the rounding excess by lowering the target.** The excess is under
  `n × 10⁻⁶ ÷ q` shares, but `n`, the number of maker legs, is not known
  before the match. No fixed reduction covers every `n`, and none covers
  price improvement. Rejected: the excess is counted, and the next entry
  trimmed (D4.3).
- **Refuse every re-entry after a residual,** or exempt residuals from the
  position cap. The first blocks `V2-10B`'s liveness under the reference
  configuration; the second breaks the cap by up to 0.01 share per bracket.
  Rejected for the trim to the headroom (D4.3, `NEW-M1`).
- **Debit a collateral-targeted BUY at shares × price** (today's
  `#debitOf`). It over-debits by up to the rounding excess, and halts a
  valid fill with `RESERVATION_SHORTFALL` (`CX034-R2-03`). Rejected for the
  per-leg spend (D4.2).
- **Book and reconcile the principal at shares × price, and allow a small
  tolerance in the holding comparison** (`R3-M2`). A valid fill would
  otherwise break the exact comparison by under 10⁻⁶ per leg. Rejected: a
  tolerance would also hide real differences of that size, and none is
  needed when the booking and the pending delta carry the spend (D4.2 item
  6, D4.5).
- **Complete a collateral-targeted BUY when its fills reach `plannedShares`,
  or its signed share side** (today's `#recordFill`). Such an order's fills
  can cross either part-way through, and the next fill then halts (`R3-M1`).
  Rejected: such an order ends at its answer (D3.5).
- **End a collateral-targeted BUY CANCELED at its answer.** Its T would stay
  PENDING until a `CANCELLATION` frame, which the venue may never emit for a
  fully spent order (U-50, U-54). Every late frame would then halt at the
  horizon. Rejected for FILLED with T = C, which is sound (D1.3). A
  `delayed` such order that a stream `CANCELED` frame ends stays CANCELED
  (D3.5; `R5-L2`): that frame fixes its T, so this objection does not apply.
- **Read a FOK's partial read as a FAK's: CANCELED with its matched part**
  (`CX034-R4-01`). It contradicts A F-80 ("Fills the entire order
  immediately or does not fill any of it") and would raise nothing.
  Rejected for the sticky FOK fill conflict, which keeps the fills and fails
  closed (D3.5).
- **Make that conflict a STATE conflict.** An authoritative read clears a
  STATE conflict (`order-manager.ts:2149-2154`), and the next read would
  repeat the contradiction and clear it. Rejected for a VENUE-ID CONFLICT's
  sticky rules (D3.5).
- **An optional `collateralAmount` alone, its absence meaning price ×
  shares** (`CX034-R4-02`). The posting boundary could not tell a
  collateral-targeted fact that lost its amount from a share-targeted one,
  and would book 17.5000014 for 17.499999. Rejected for the required
  `principalBasis` (D4.5).
- **Always book the simulator's `collateralAmount`, whatever the target.**
  It would change every PAPER share-targeted BUY's booking, and live
  share-targeted fills carry no per-leg spend the OMS checks. It is out of
  scope (D4.5's last bullet).
- **Recover `q` from the target, as `target ÷ plannedShares`** (`R3-L1`).
  Sound but looser; rejected for carrying `q` on the ticket (D4.1).
- **Exit the planned share count.** It leaves the extra shares behind, and is
  contrary to §6 invariant 10.
- **Clamp every exit to the held inventory.** It sizes a complement leg's
  BUY-to-close at 0 (`CX034-R1-03`).
- **Round the exit up, or trade up to the minimum.** A SELL rounded up
  exceeds the held position; trading up to the minimum adds exposure.
- **Keep the base-unit target** (`V2-10`). It differs from the signed amount.

## Open items

1. **Resolved 2026-10-08: the user confirmed all three of D1's additions.**
   **The user confirms D1's additions.** The ruling names two outcomes. D1
   adds:
   - **a hold** for pairs that venue-timed evidence may still order: a
     PENDING terminal instant, or one in seconds. It pauses every submission
     of the account until that evidence orders the pair, or a read made
     `orderingHorizonMs` after the hold halts it;
   - **a halt at once** for pairs that venue time can never order: equal
     millisecond values, or an overlap with a final interval. Adjacent
     millisecond values are ordered, under assumption A12 (D1.2);
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
     `created_at` and against when its answer arrived. It also checks A12:
     that a fill's `MATCHED` event and its order's `UPDATE` carry consistent
     values.
   - Until then D1 rests on A F-98, an inference, and on A12, an assumption.
     D1.7 analyses what happens if either is wrong.
   - `orderingHorizonMs` needs the same live-mode decision as
     `quiescenceHorizonMs`.
3. **U-49, U-50 and U-51 (A11):** the killed FOK's answer, FAK and FOK events
   on the stream, and what the venue reports for a market order's
   `original_size`, `size_matched` and `price`, and whether its trades carry
   their maker legs. The first execution probe (`WP-350`/`WP-360`) observes
   them. No FAK or FOK order runs above PAPER before then. It also observes
   A13: what a filled FOK BUY spends against its target (D3.5).
   - **The D1 × D3 case** (`NEW-L4`). The probe also observes whether a FAK
     or FOK emits a `PLACEMENT` frame, and its value against the remainder's
     `CANCELLATION` and the `MATCHED` events. If equal values occur, they
     halt under D1 (Consequences). A tie-break, "a `PLACEMENT` precedes its
     own order's terminal transition" (Alternatives), is then put to the user
     before FAK or FOK runs above PAPER.
4. **A migration, before any PostgreSQL OMS store** (`CO3-N3`), for
   (`LOW-7`):
   - `execution.orders.time_in_force`, and the plan's time-in-force;
   - the collateral target, its conversion price `q` and its signed share
     side, on the plan and the order (D4.1; `R3-L1`). A live fill's
     `principalBasis` is derived from it (D4.5; `CX034-R4-02`);
   - D2.3's `unexecutableRemainder` and its reason, on the plan;
   - the intent-to-plan link's two quantities, requested and executable
     (`execution.intent_order_links` has one, `attributed_shares`);
   - a fill's venue instant (D1.2), its maker legs and its spend (D4.2), on
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
9. **Resolved 2026-10-08: the orchestrator confirmed `min(limitPrice, bestAsk)`.**
   **The orchestrator confirms D4.1's conversion basis,** `min(limitPrice,
   bestAsk)`. The round's packet said "at the limit price", which buys beyond
   `plannedShares` on every book that asks below the limit (D4.1). If the
   orchestrator keeps the limit price, D4 needs another answer to
   `CX034-R1-02`: wider caps in the configurations, or variant H.
10. **Resolved 2026-10-08: the user ruled variant P (plan-time share caps).**
    **The user rules on the share caps of a collateral-targeted FAK or FOK BUY
    entry** (`SHARE-CAP`). This ruling is a precondition of R3's D4 part.
    - **The facts** (D4.1). The venue targets such a BUY in collateral (F-63),
      so no share count can be signed. Three share caps are judged on
      `plannedShares` before the conversion: `maximum_position_shares`,
      `maximum_book_participation` and the risk engine's
      `participation.maxOrderShares`. A fill can exceed them by a sub-grid
      rounding excess, under `n × 10⁻⁶ ÷ q` shares, on any book; and by any
      amount when an ask below the snapshot's best ask appears before the
      match (a 17.00 target filled at 0.17 buys 100 shares). The money caps
      hold on every book.
    - **Variant P (proposed):** plan-time share caps for these orders only.
      The excess is accepted, attributed, counted by the caps at once (the
      next entry is trimmed or refused), alerted beyond the rounding excess,
      and reduced by the exit. A named departure from handoff §13.2's share
      caps.
    - **Variant H:** hard share caps. The planner refuses such an entry
      whenever a share cap applies (`PLAN_SHARE_CAP_UNENFORCEABLE`). An
      immediate entry is made as a share-targeted GTC with a deadline cancel
      instead. The reference configuration's FAK entries are then refused.
    - Until the ruling, R3 may implement D3 only.

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
    1159-1168, 1243-1276, 1477-1489, 2055, 2114-2181, 2217-2288, 2292-2339,
    2346-2379, 2384-2419, 2434, 2468, 2576, 2905-2909, 2978-3015, 3028-3037,
    3062-3075, 3674`;
  - `packages/oms/src/reconciliation/holdings.ts:1-119`;
  - `packages/ledger/src/fill-posting.ts:221-275, 380-388`,
    `allocation.ts:65-103, 298`, `refusals.ts:122-127`;
  - `packages/pnl/src/records.ts:162`, `state.ts:574-600, 659-740`;
  - `packages/trading-core/src/allocation.ts:512-565, 862, 1078`,
    `loop.ts:5879-5887`;
  - `packages/simulation/src/fill-model.ts:517-545`, `queue.ts:746-751`;
  - `apps/trader/src/index.ts:303`, `apps/trader/README.md:177-191`;
  - `test/integration/paper-trader/trader-health-endpoint-postgres.test.ts:217-236`;
  - `db/migrations/0005_execution.up.sql:411` (`remaining_shares` is
    non-negative);
  - `packages/oms/src/reconciliation/identity.ts:28-34, 64-71`;
  - `packages/oms/src/reconciliation/coordinator.ts:679-684, 1021-1044,
    2091-2184, 2313, 3334-3338`, and its header's "Quiescence";
  - `packages/oms/src/ports.ts:30-116, 343`;
  - `packages/oms/src/restricted-mode/venue-port.ts:60-90`;
  - `packages/oms/package.json:13` (`test:fault`); the root `package.json:18`
    (the fault chain);
  - `packages/inventory/src/inventory-book.ts:462-468`;
  - `packages/risk/src/engine.ts:643-653`;
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
    843-847, 897, 1017, 1194-1265`, `params.ts:139, 547`, `observe.ts:314-316`;
  - `packages/ledger/src/allocation.ts:65`;
  - `apps/trader/src/live-safety/live-safety.ts:617-622, 636-640`,
    `fenced-venue.ts:69-72, 77-82, 143-245`, `oms-progress.ts:43-54`;
  - `test/fault-injection/live/findings.test.ts`,
    `support/expected-releases.ts`, `support/live-node.ts:683-698`,
    `support/mock-clob.ts:525-537, 733-737, 886-897`;
  - `test/fault-injection/reconciliation/support/wp280.ts:36, 81, 112`;
  - `test/fault-injection/oms/crash-points.test.ts:148-149`,
    `support/crash-harness.ts:125-130`;
  - `test/fault-injection/live-safety/port-conformance.test.ts:73-80`;
  - `test/integration/postgres/fencing-race.test.ts:373-374`;
  - `test/e2e/support/scenario.ts:122-125, 220, 262`,
    `support/scenarios/two-brackets.ts:69-82`;
  - `infra/compose/trader/trader.config.example.json:126-130`;
  - `db/migrations/0005_execution.up.sql` (`execution.plans.deadline_at`; no
    time-in-force column on `execution.orders`).
- **Safety.** This ADR changes no run-mode default (ADR-010). It describes
  behaviour that cannot be reached today: `ALLOW_REAL_ORDERS=false`, both
  live-micro caps are 0, no signer is configured, and no live gate has been
  requested.

## Note (2026-10-08, COMPLEXITY-1)

**The ruling.** On 2026-10-08 the user re-sequenced this ADR's implementation,
on `COMPLEXITY-1`'s audit findings `OMS-01`, `OMS-02`, `OMS-07` and
`TRADE-11`. **Build now only what PAPER uses: time-in-force carried on the
plan.** The Decision text above is unchanged; this note records what is built,
what is parked, and the form a parked part takes when it is built.

**Built now (round `C1-TIF`): D3.1 item 2 only.**

- `PlanningInputs.timeInForce` carries the value resolved as D3.1 item 1 says
  (the tag, else the instance's configuration). The planner refuses a
  placement's inputs without one and never defaults it.
- Every `PlannedOrder` carries `timeInForce`. A GTD order also carries
  `expirationUnixSeconds`: its plan's deadline, rounded up to the second, plus
  60 s, so the venue's one-minute early expiry ends it at the deadline (D3.3).
  The seal refuses a GTD order without one and any other order with one.
- `OrderTimeInForceBook` is deleted, with the trader facade's re-export. The
  simulator's `ExecutionPolicy` reads the planned order, and converts a GTD
  expiration to the clock's monotonic scale.
- Not built: `deadlineAt` for a deadline-bounded GTC, and D3.4's deadline
  cancel. No shipped entry is GTC. Not built either: D3.3's GTD-floor refusal.
  The simulated venue does not enforce the floor, and no GTD order runs above
  PAPER.

**Parked until the execution probe.**

- **D1's venue-time machinery** (round R2, `OMS-VENUE-TIME`).
- **D4**, the collateral-targeted FAK and FOK BUYs, with their OMS, adapter and
  ledger halves (round R3, `TIF-COLLATERAL`).
- **D3's `createMarketOrder`, fence and SDK-port additions** (D3.1 items 3 to
  5, and D3.2's FAK and FOK rows), with the rest of D3 that only the OMS and
  the adapter read. `OMS-01`'s review noted that the probe cannot observe a FAK
  or FOK order unless these exist. When they are built relative to the probe is
  decided when the probe is planned.

**Meanwhile: immediate entries are share-sized GTC or GTD orders with a
deadline,** so the share caps stay hard.

- Static Bracket refuses a FAK or FOK `immediate_order_type` at validation,
  named `SB_IMMEDIATE_ORDER_TYPE_PARKED_UNTIL_EXECUTION_PROBE`, until D4 is
  built. Every Static Bracket entry can be a BUY (its direct leg always is),
  so the value is refused outright.
- The shipped example configuration's entry is GTD, with an explicit
  `order_validity_ms` of 30 000. The simulated venue expires it at its plan's
  deadline. GTD was chosen over GTC because the simulated venue already
  expires a GTD order, while nothing in PAPER cancels a GTC order at its plan's
  deadline.
- **The trade-off.** A GTD entry that fills in part RESTS its remainder until
  its deadline, where a FAK cancelled it at once.
- Static Bracket also refuses a GTC `immediate_order_type`, named
  `SB_IMMEDIATE_ORDER_TYPE_GTC_NEEDS_DEADLINE_CANCEL`, until D3.4's deadline
  cancel is built (C1-TIF review round 1).
- While a GTD entry's remainder rests, the bracket is not finished. Its exits
  are sized from the folded fills, so a take-profit can sell everything folded
  first. The bracket then waits in its exit state instead of certifying
  `CLOSED`, so a later fill of the remainder is folded and exited (C1-TIF
  review round 1, finding C1-TIF-01).
- Exits are unchanged: Static Bracket's exits are GTC; none is FAK or FOK.
- **Before any GTD entry runs above PAPER:** a 30 s GTD states an expiration
  about 90 s ahead, below the venue's floor of 180 s plus a margin (D3.3; A
  F-79, F-83). Either D3.3's floor refusal is built and the configuration's
  lifetime is lengthened, or the entry becomes a deadline-bounded GTC with
  D3.4's cancel.

**Variant P is superseded for now** by these share-sized entries (`OMS-07`).
The user's ruling of variant P (Open item 10) applies again only if D4 is
built.

**When D1 is built, it takes the self-clearing form** (`OMS-02`). A late
LIVE-class frame on a terminal order triggers an authoritative read. Only a
read that contradicts the terminal state halts; a read that confirms it clears
the hold by itself, with no operator release. Intervals, spans, the hull,
`PENDING`, the durable hold marker, the `ORDERING` purpose and
`orderingHorizonMs` are not built. **The residual risk, in this ADR's terms:
a newer LIVE that the read contradicts as terminal resumes instead of
halting.** This revisits the 2026-10-05 wording that a newer one still halts
(D1.5's NEWER row). A cheap middle ground stays open: judge a frame STALE
without a read only when `L < T`, for a point `T` from a CANCELED or MATCHED
stamp.
