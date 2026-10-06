# ADR-034: Order-lifecycle semantics before live: venue-time ordering, one executable quantity, time-in-force end to end, and collateral-targeted immediate BUYs

- **Status:** **Proposed** (2026-10-06). Nothing is implemented.
  - D1 records the user's ruling on `WP340-F1` (2026-10-05: venue-time
    ordering) and settles its details. D1's third outcome, the hold for pairs
    that venue time cannot order (D1.5), goes beyond the ruling's two cases.
    It is put to the user (Open item 1).
  - D2 to D4 are for the orchestrator to accept after the joint review.
- **Date:** 2026-10-06
- **Recorded by:** the round `ADR-034` (docs only), authorized at `3294201`.
- **Implemented by:** not yet. Three rounds are proposed under "Implementation
  plan": `OMS-QTY` (D2), `OMS-VENUE-TIME` (D1) and `TIF-COLLATERAL` (D3, D4).
  The names are proposals; the orchestrator assigns them.
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
  - It refines `V2-10`'s conversion grid (D4.1).
  - It amends no handoff invariant. Every departure is named under "Relation
    to the handoff and the ADRs".
- **Handoff sections:** §1.3, §6 (invariants 6, 7, 9, 10, 12 and 15), §8,
  §9.9, §9.10, §9.11, §9.12, §9.17, §12.2 and §13. **ADRs:** ADR-001, ADR-002
  §2, ADR-007, ADR-008, ADR-010, ADR-020, ADR-022 D10, ADR-032 D4 and ADR-033.
- **Code cited:** `main` at `3294201`.
- **Posture:** PAPER only. No decision here enables a mode above PAPER. Every
  rule is exercised against mocks until the human gate of ADR-010.

## Context

1. **`WP340-F1`: a late `LIVE` halts its market.**
   - **What happens.** When a stream observation says `LIVE`, `DELAYED` or
     `UNMATCHED` for an order the OMS holds terminal, the OMS reopens the order
     to RECONCILING. It raises a halting `EVIDENCE_CONFLICT` ("a terminal
     order was observed LIVE"; `packages/oms/src/order-manager.ts:2217-2228`
     and `#reopenTerminal`). WP-290 then quarantines the market
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
     monotonic per order, and how a push is ordered against the REST answer of
     its cause (U-52). The examples are consistent with "the instant of the
     change" (A F-98, an inference).
   - **The unit is in conflict** (C-25). WP-280 refuses any value outside its
     plausible window, so a seconds value is refused, never misread
     (`wire.ts:76-77`, `:122-137`).
   - **Our harnesses stamp every frame with one constant**
     (`test/fault-injection/live/support/mock-clob.ts:384`;
     `test/fault-injection/reconciliation/support/wp280.ts:36`).
3. **`CO3-N1`: two share quantities.**
   - **The SDK rounds the share amount down to 2 decimals** for every tick
     size, as the documented "Size decimals" column says (A F-99, F-101).
   - **The adapter accepts a signed share amount** that is rounded down by less
     than 0.01 (`packages/polymarket-secure/src/venue-client.ts:295-313`,
     `:369-383`).
   - **The OMS keeps the unrounded ticket size** (`order-manager.ts:2436`).
     Its `identityMismatch` does not compare amounts (`:3028-3037`).
   - **Reconciliation needs equality:** the venue's original size must equal
     that unrounded size (`packages/oms/src/reconciliation/identity.ts:64-71`,
     `matchesExactly`).
   - **The mock hides it:** it signs the rounded amount but books the
     requested one (`mock-clob.ts:528-537`, `:886-897`).
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
       (`order-manager.ts:285-296`, `:3017-3037`);
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
    today;
  - a REST read that finds open an order the OMS holds terminal still halts
    (`#applyPresent`). A read is current-state evidence made after its request
    (ADR-032 D4), not a late event.

**D1.2 The instant each port receives.**

| OMS port | Instant | Source | Precision |
| --- | --- | --- | --- |
| `applyOrderObservation` | `venueInstant`: the event's `timestamp` | WP-280's `NormalizedOrderEvent.venueTimestamp` (A F-88, F-91) | ms; **required** |
| `recordFill`, from the stream | `venueInstant`: the `MATCHED` trade event's `timestamp`; and `matchedAt` (`match_time`) as today | WP-280's projection (A F-89, F-91) | ms; s |
| `recordFill`, from a REST read (WP-290) | `matchedAt` (`match_time`) only | A F-94, F-95 | s |
| `applySettlement` | `observedAt`, unchanged | | ms |
| placement answer, cancel answer | none | A F-96 | — |
| reconciliation answer | none for the order's status; its fills carry `matchedAt` | A F-93 | s |

- **Representation.** An instant is an integer epoch-millisecond text with a
  precision, `MS` or `S`, never a float. A millisecond value `t` is the
  interval `[t, t+1)` ms. A seconds value `s` is `[1000·s, 1000·s + 1000)` ms.
- **Missing instants are refused.** An observation without a readable instant
  is refused at the port (`OMS_INVALID_INPUT`) and never applied. WP-280
  already treats a missing or implausible `timestamp` as a malformed event and
  requests reconciliation (`normalize.ts:318`; `manager.ts:1000-1005`; C-25).
  New fields are read as own data (ADR-020).

**D1.3 The terminal instant T: "the evidence that made the order terminal".**

| Evidence that made the order terminal | T |
| --- | --- |
| A stream `CANCELED` observation (a `CANCELLATION` event) | its `timestamp` (ms) |
| The fill that completed the order | the instant of its `MATCHED` trade event when the fill was first recorded from it (ms), else its `match_time` (s). Never a later settlement event's instant, which names a later change (A F-98) |
| A cancel answer listing the order in `canceled` | **PENDING**: the answer has no instant (A F-96) |
| A placement answer `matched` that completes the order (FAK or FOK, D3) | **PENDING** |
| A reconciliation read finding the order `CANCELED` or `MATCHED` | **PENDING**, unless the fills recorded with it give the completing fill's `match_time` (s) |

- A PENDING T is fixed by the first later venue-timed evidence of the same
  terminal fact, for the same venue order id: a `CANCELED` observation for a
  canceled order, or the completing fill's instant for a filled one.
- T, its precision and its evidence kind are recorded in the terminal
  transition's order-event payload (`execution.order_events.payload` is
  `jsonb`), so no migration is needed.

**D1.4 The comparison.** Let L be the observation's interval and T the
terminal interval.
- **STALE**: L ends no later than T starts (`L.hi ≤ T.lo`).
- **NEWER**: L starts no earlier than T ends (`L.lo ≥ T.hi`).
- **UNORDERED**: they overlap, or T is PENDING. Overlap covers equal
  milliseconds, and a millisecond instant inside a seconds instant's second.

Ties are never STALE and never NEWER: venue time cannot order them.

**D1.5 The outcomes.**

| Classification | Outcome |
| --- | --- |
| **STALE** | Recorded as an `OBSERVATION_STALE` order event (source `polymarket`; payload: the status, L, T, T's evidence kind, `rule: "VENUE_TIME"`). No state change, no alert, no read, no halt. A metric and a structured log line count it |
| **NEWER** | Today's behaviour, unchanged: the halting `EVIDENCE_CONFLICT`, the reopen to RECONCILING with a state conflict, and a fresh authoritative read |
| **UNORDERED** | A **hold**, described below |

**The hold** (UNORDERED):
- It is recorded as an `OBSERVATION_UNORDERED` order event, and **no alert is
  raised**.
- The order keeps its terminal state. A hold is a durable marker, not a new
  state, so ADR-007 §1's state machine is unchanged.
- While any hold on the order is open:
  - its group's salt gate stays closed;
  - its unconsumed reservation stays held;
  - `resume()` refuses, exactly as it does for an order in RECONCILING.
- The OMS issues a fresh reconciliation request with a new token, so the read
  that answers it is made after the hold opened (ADR-032 D4).
- **The hold resolves by the first of two events:**
  1. **Venue-timed terminal evidence fixes or narrows T** (D1.3). The OMS
     compares again:
     - STALE closes the hold (`rule: "VENUE_TIME"`);
     - NEWER raises the halting conflict;
     - a remaining overlap waits for the read.
  2. **The read answers:**
     - `PRESENT`, with the order terminal: STALE (`rule: "READ_AFTER"`). The
       venue held the order terminal after the observation arrived. That
       makes the observation older than the terminal transition, because a
       `CANCELED` or fully `MATCHED` order does not become live again. That
       is an inference: no fetched page documents a transition back to `LIVE`
       from either (A F-91, F-93);
     - `PRESENT`, with the order open: the halting conflict. This is today's
       "an order believed terminal is open at the venue";
     - `UNRESOLVED` or `ABSENT`, or a run that ends without an answer: the
       halting conflict. This is the fail-closed path.
- **Bounds and restarts.** Open holds are bounded like retained evidence
  (`MAX_RETAINED_EVIDENCE`), and one beyond the bound halts. The marker is
  durable: a restart re-requests the read for every open hold, and raises no
  alert for it. Today recovery re-raises only real conflicts, as
  `order-manager.ts:2908` does.

**A missing instant fails closed** in both directions:
- a missing L is refused at the port (D1.2);
- a missing T is PENDING, so the observation is held. Nothing is released
  while the hold is open, and the halt follows if the read cannot confirm the
  terminal state.

**D1.6 Why this is the ruling.**
- A LIVE-class observation strictly older than the terminal evidence never
  halts.
- One strictly newer always halts, at once, as today.
- Nothing is classified STALE without one of two proofs: a venue instant
  strictly before T, or an authoritative read made after the observation that
  finds the order terminal.
- A STALE classification releases nothing the existing rules hold. A new salt
  still needs the group's final matched size from an authoritative read
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
  - `OrderObservation` gains a required `venueInstant`; `FillReport` gains an
    optional `venueInstant`;
  - the terminal instant and the hold markers live in order-event payloads;
  - `#applyObservation`'s terminal branch implements D1.4 and D1.5;
  - `#applyPresent` resolves holds;
  - recovery re-requests a read for each open hold.
- **WP-280 (`packages/polymarket-secure/src/user-stream/**`):** `oms-projection.ts`
  passes `venueTimestamp` into the observation, and into fills projected from
  a `MATCHED` event. The normalizer already reads both.
- **WP-290 (`packages/oms/src/reconciliation/**`):**
  - fills from `/data/trades` carry `matchedAt` with an explicit seconds
    precision;
  - the coordinator answers a hold's request like any other;
  - no new read route: `/data/order` has no state-change instant (A F-93), and
    `match_time_nano` is unavailable through SDK 0.12.0 (A F-95).
- **No migration**, no domain contract and no new dependency edge.

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
4. **Frames carry real instants.** The live mock (`support/mock-clob.ts`,
   `support/user-channel.ts`) and WP-290's harness
   (`test/fault-injection/reconciliation/support/wp280.ts`, `world.ts`) stamp
   each frame with the venue instant of the change it reports, on the shared
   time line: milliseconds for `timestamp`, seconds for `match_time`. They
   stop using one constant. A labelled mock assumption, A10, records this
   reading of U-52.
5. **Unit tests in `test/unit/oms/**`:**
   - STALE, NEWER and UNORDERED. UNORDERED covers equal milliseconds, a
     millisecond inside a seconds T, and a PENDING T, each resolved both by
     timed evidence and by a read (terminal → STALE; open → halt;
     unresolved → halt);
   - `DELAYED` and `UNMATCHED` behave as `LIVE`;
   - an unrecognised status still halts;
   - an observation without an instant is refused;
   - a hold keeps the salt gate closed and the reservation held, and survives
     a restart as a read request with no alert.
   - **Mutation rows,** each failing a named test: flip the comparison; read
     ties as STALE; drop the hold's read; let a hold resume.
6. **A seeded property** over frame delays, duplicates and drops in a truthful
   mock: no halt. With an injected contradiction (a LIVE stamped after T):
   always a halt.

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
  intent-to-plan link keeps both numbers.
- A quantity that floors to 0, or below the market minimum, is refused as
  today (`PLAN_BELOW_MINIMUM_ORDER_SIZE`).
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
- **The adapter's cross-check** (`signedOrderMatchesRequest`) requires the
  signed share amount to equal the request × 10^6 exactly. Today it accepts a
  value rounded down by less than 0.01 (`venue-client.ts:312`, `:369-383`).
  - A limit order's quote must equal price × shares exactly. On-grid inputs
    make it exact (A F-102).
  - Anything else is `FAILED`, so no order exists (WP-260). A later change in
    the SDK's rounding then fails closed at signing.
- **The OMS's `identityMismatch`** also compares the signed amounts with the
  order's quantities. Today it compares token, side, post-only, expiration and
  type only (`order-manager.ts:3028-3037`).

**D2.5 One number everywhere.** The planned order's executable quantity is,
exactly:
- the reservation basis (a limit BUY reserves price × shares; a SELL reserves
  shares);
- the OMS ticket and its `originalShares`;
- the signed share amount;
- the venue `original_size` that reconciliation compares (`matchesExactly`,
  unchanged);
- the size the mock books.

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
   request (`mock-clob.ts:528-537`). `mock-venue-facts.test.ts` checks the
   rounding against A F-101.
3. **A fake-SDK case** signs a share amount one base unit away from the
   ticket. Signing returns `FAILED`, and no attempt is recorded as sent.
4. **Unit tests:**
   - the quantizer, on exact decimals, for every tick size, both sides, and
     collateral inputs;
   - slicing on the grid;
   - the recorded remainder;
   - the configuration door.
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
   - The adapter validates and cross-checks it as it does `createLimitOrder`.
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
- **Post-only with FAK or FOK** (A F-81; the SDK's own invariant, A F-85).
- **A misplaced collateral target:** a FAK or FOK BUY without one, or a GTC,
  GTD or SELL order with one (D4).
- **A GTD below the floor.**
  - The core has the clock. It sets `expiration = deadline + 60 s` (the
    venue's security threshold, A F-79). It refuses GTD when `expiration <
    now + 180 s + margin`. The SDK checks 180 s against the host clock (A
    F-83), and its own documentation asks for a margin against latency and
    skew.
  - The OMS is clockless and checks the shape only.
  - The SDK's check is the last guard. Its `UserInputError` maps to `FAILED`,
    so no order exists.

**D3.4 ADR-007 §8's obligations.** A lifetime below the GTD floor, about two
minutes effective (A F-79), is met in one of two ways. The plan chooses
between them; the OMS never does.
- **Immediately,** with FAK or FOK. These never rest (A F-80).
- **Resting,** with GTC and a cancel at the deadline.
  - The core's clock calls the OMS's `requestCancel` at the deadline.
  - The deadline is persisted with the plan (`execution.plans.deadline_at`,
    migration `0005`), and re-armed after a restart.
  - A cancel that cannot be sent leaves the order to the heartbeat lapse
    (ADR-033 D6; ADR-008). The lapse cancels every open order of the
    credentials.
  - An order past its deadline that is not known to be canceled goes to
    reconciliation, as ADR-007 §10 treats a heartbeat lapse. It is never
    assumed gone.

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
  - the deadline-cancel hook;
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
   venue receipt.
5. **Real-SDK contract tests behind the network tripwire,** as V2-5's 0.12
   tests do:
   - the signed amounts of a protected BUY and a protected SELL from
     `createMarketOrder`, per A F-101. The BUY's `makerAmount` is the target,
     and its `takerAmount` is rounded up;
   - `expiration` is 0, and `orderType` is as requested.

   `v2-5.test.ts`'s port pin moves to eleven members, and keeps its no-`place*`
   rule.
6. **A restart test.** A restored signed order keeps its `orderType`, and a
   restored payload whose `orderType` was altered is refused.
7. **The PAPER goldens do not change for D3 alone.** The time-in-force values
   are the same; they now come from the plan.

**D3 is pre-live for the OMS and the adapter.** For PAPER it is plumbing only,
with no change in output.

### D4. Collateral-targeted FAK and FOK BUYs, and exits sized by the held position (`V2-10B`)

**D4.1 The conversion is made once, at plan time, by D2's quantizer:**

`collateralTarget = floor₀.₀₁(plannedShares × limitPrice)`, in pUSD.

- **Why 0.01.** The SDK floors a market BUY's amount to "Size decimals" (A
  F-101), and the documentation says "Round the price and input amount down …
  to the table's … Size decimals" (A F-99).
- The target is recorded on the planned order and on the OMS ticket, and it is
  exactly the signed `makerAmount`. `plannedShares` stays on the plan as the
  strategy's intended size.
- Only FAK and FOK BUYs convert. GTC and GTD BUYs, and every SELL, target
  shares (F-63; A F-82).
- **A departure from `V2-10`.** Its `collateralTargetAtLimitPrice` floors to
  whole base units (6 decimals). D4 floors to 0.01, because the SDK signs that
  amount and the simulator must match it. Authority: the venue
  documentation and the SDK rank first (handoff §1.1).

**D4.2 The OMS and reconciliation, for a collateral-targeted BUY.**
- **Shares are an outcome, not a bound.** Fills may exceed the signed
  `takerAmount` when the budget buys at better prices: "ExchangeV3 reduces a
  BUY's remaining collateral budget by the amount actually spent" (F-63). How
  the venue reports this is U-51.
  - The share bounds therefore do not apply to such an order: "matched ≤
    original" in `#applyPresent`, and "a fill beyond the order".
  - A collateral bound applies instead. The order's fills, valued at shares ×
    price, may exceed the target by less than one base unit per fill, and no
    more. That is the most F-63's floor moves one fill against a maker whose
    signed amounts equal its tick-grid price (A F-102). The tolerance is an
    inference, since the stream carries no per-fill collateral amount. A
    larger excess is a fill contradiction, and halts as today.
- **Identity.** Reconciliation compares the persisted signed identity:
  `makerAmount`, `takerAmount` and `orderType`. It does not compare a share
  `original_size`. What the venue reports in `original_size` and `size_matched`
  for such an order is U-51.
  - Until the first execution probe has observed it (`WP-350`/`WP-360`), a
    read the OMS cannot reconcile with the signed identity raises the halting
    conflict, which is fail closed.
  - No FAK or FOK BUY runs above PAPER before that observation.
- **The reservation** is the target plus the fee bound. Fees are charged on
  top: "BUY fees add to collateral spend" (F-63; A F-82). The bound comes from
  the market's versioned fee parameters, at the worst price the budget can
  reach, which is at most the limit.

**D4.3 Exits are sized by the held position.**
- **The source is kept.** Static Bracket already names each exit from its
  confirmed allocation not yet exited (`openShares`), and checks position
  agreement before any exit that changes the position (`decide.ts:21-24`,
  rule 4; §6 invariants 10 and 12). D4 keeps that source.
- **D4 adds the grid:** the exit quantity is `floor₀.₀₁(min(openShares, the
  held shares of the leg))`, through D2's quantizer.
- **The residual is what the exit cannot sell.** It is either:
  - the part below the grid (under 0.01 share), with reason `SUB_GRID`; or
  - a whole open quantity whose floored size is below the market's minimum
    order size, with reason `SUB_MINIMUM`. The minimum's unit is in conflict
    (C-7). The planner keeps its current reading, shares, until a venue round
    settles it.
- **A residual is:**
  - recorded in the strategy's state with its reason;
  - not an open exposure that needs an exit order, so a bracket whose only
    remainder is a residual can close;
  - still real inventory. It stays in the position projections, it counts
    against `maximum_position_shares` and the entry bounds, and its PnL is
    valued at worst-case resolution;
  - held to resolution and redeemed through WP-300's REDEEM, which takes an
    explicit base-unit amount (`verified-2026-10-05.md` F-73), or merged with
    a held complement.
- A residual is never sold below the venue's minimum, and never rounded up.
  It is held to resolution whatever the configured resolution-hold policy,
  because no venue order can sell it. The operator surface shows it.
- **The effect.** The bracket reaches `CLOSED`, handoff §13.3's own state.
  No new state is added; the residual and its reason are recorded with it.
  So a `SUB_GRID` residual (`V2-10`'s probe B left 0.000002) no longer keeps
  the bracket open, and the next bracket can enter. After a `SUB_MINIMUM`
  residual, a new entry is allowed only within the caps, which count the
  residual.
- **A named departure from handoff §13.3,** whose rule is "Exit size equals
  actual allocated filled size". An allocation off the 0.01 grid cannot be
  sold whole: the SDK floors every SELL to 0.01 (A F-101), and the documented
  procedure rounds the share quantity down (A F-99). D4.3 meets the rule up to
  the venue's grid and records what is left. Authority: venue facts rank
  above the handoff (§1.1).

**D4.4 The simulator's default.** Once D3 and D4 are in:
- `DEFAULT_FOK_FAK_BUY_TARGET` becomes `"COLLATERAL_AT_LIMIT_PRICE"`
  (`venue.ts:269`), and `trading-core`'s venue builder passes it explicitly;
- the conversion grid becomes 0.01 (D4.1);
- the simulator's version pin `wp-210/v2` becomes `wp-210/v3`, in the run
  configs and the goldens (`V2-10`'s follow-up);
- `"SHARES_UNDOCUMENTED"` stays selectable, only to replay old runs.

**D4.5 PAPER economics.**
- Trader cash and the allocation debits use each fill's `collateralAmount`,
  not price × shares (`V2-10` round-0 handoff, known risk 2).
- The ledger's `FillFact` (`packages/ledger/src/allocation.ts:65`) gains the
  pUSD leg. That is a contract change for its owner, WP-200's package.

**D4.6 Golden and replay changes.** Each is regenerated with a recorded
reason:
- `test/replay-golden/paper-e2e/paper-e2e-run.json`;
- `test/replay-golden/paper-e2e/two-brackets-run.json`, which must now show
  the second bracket entering;
- `test/replay-golden/backtest/static-bracket/expected-artifact.txt`, and its
  `run-pins.json` version pin;
- `test/replay-golden/simulation/golden-replay.json`,
  `test/unit/simulation/fixtures.ts`, `test/unit/simulation/determinism.test.ts`
  and `apps/backtest-cli/src/backtest.test.ts`, wherever they pin
  `wp-210/v2`;
- the suites `V2-10`'s probe B moved (7 unit files, 36 e2e tests, 5 replay
  tests), and the simulation unit pins of the old default.

Before merging, the round investigates why `apps/trader/src/loop-folds.test.ts`
hung under the flipped default (`V2-10` round-0 handoff, known risk 7).

**D4.7 Test obligations.**
1. **The conversion:**
   - 50 shares at 0.35 gives 17.50;
   - an off-grid product floors: 33.33 × 0.347 = 11.56551 gives 11.56;
   - a target that floors to 0 is refused.
2. **A FAK BUY with price improvement:**
   - it buys more than `plannedShares`;
   - the exit sells the held position floored to 0.01;
   - the residual is `SUB_GRID` and the bracket closes;
   - the two-bracket run enters twice.
3. **A partial entry that leaves a position below the minimum:** a
   `SUB_MINIMUM` residual, held to resolution and counted by the caps.
4. **The OMS's collateral bound, and identity by the signed amounts,** against
   the mock. The mock's `original_size` and `size_matched` for such an order
   are a labelled assumption (U-51).
5. **The D4.6 goldens are regenerated,** and a determinism run, made twice,
   is byte-identical.

**D4 changes PAPER fills and exits.**

## Implementation plan

| Round | Decisions | Paths it needs | Order | Label | Acceptance |
| --- | --- | --- | --- | --- | --- |
| R1 `OMS-QTY` | D2 | `packages/execution-planner/**`, but not `src/probes/**` (WP-350's); `packages/oms/**`; `packages/polymarket-secure/src/venue-client.ts` and its tests; `packages/strategies/static-bracket/src/params.ts` and its tests; `test/unit/{execution-planner,oms,strategies}/**`; `test/contract/polymarket-secure/**`; `test/fault-injection/live/**`; `test/fault-injection/reconciliation/**` | first | pre-live; a latent PAPER change, with no golden change | D2.6; all gates; the goldens byte-identical |
| R2 `OMS-VENUE-TIME` | D1 | `packages/oms/**`, including `src/reconciliation/**`; `packages/polymarket-secure/src/user-stream/**`; `test/unit/oms/**`; `test/contract/user-stream/**`; `test/fault-injection/reconciliation/**`; `test/fault-injection/live/**`; `docs/experiments/phase-3-verification.md` (§5's counts to 0, with a dated note) | after R1 (shared paths); it may run before R1 if the orchestrator prefers, but never alongside it | pre-live only | D1.10; all gates |
| R3 `TIF-COLLATERAL` | D3, then D4 | `packages/trading-core/**` (the bounded ADR-022 D10 grant of D3.6 and D4.5); `packages/execution-planner/**`; `packages/oms/**`; `packages/polymarket-secure/**`; `packages/simulation/**`; `packages/strategies/static-bracket/**`; `packages/ledger/src/allocation.ts` (`FillFact`, with WP-200's owner); the matching `test/unit/**`, `test/contract/polymarket-secure/**`, `test/fault-injection/live/**`, `test/e2e/**` and `test/replay-golden/**`; `apps/backtest-cli/src/backtest.test.ts`. **Not** `db/migrations/**`, `packages/domain/**` or `packages/decimal/**` | after R1. D3 with D4: one round, or two rounds merged back to back before any PAPER run is cited as evidence | D3: pre-live, plumbing only for PAPER. **D4: changes PAPER fills and exits** | D3.7, D4.7; each golden with a reason; all gates |

**For every round:**
- PAPER only, with no credential and no network. The four live defaults stay
  `MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
  `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`.
- Mocks run behind the network tripwire.
- The gates are typecheck, lint, check:deps, test and the full fault chain,
  plus the integration and e2e suites that each round's paths touch.
- Each round has two verifiers, reconciled: these are order-safety changes.

## Relation to the handoff and the ADRs

- **The user's ruling (D1).** It is implemented as ruled wherever venue time
  orders the pair. The hold for pairs that venue time cannot order is this
  ADR's addition (Open item 1). D1 also extends the ruling from `LIVE` to
  `DELAYED` and `UNMATCHED` (D1.1).
- **ADR-002 §2:** consistent (D1.8). Observations keep their arrival order,
  and the venue timestamp is data.
- **ADR-007:**
  - §1: no new state; a hold is a marker.
  - §3: a hold resolves only by venue evidence or an authoritative read,
    never by elapsed time.
  - §5: refined for FAK and FOK (D3.5).
  - §8: implemented by D3.4.
  - §2 step 9: a retransmission keeps the order type (D3.1, item 5).
  - §11: the time-in-force sits in the persisted signed payload, which is
    secret, and on the order record, which is not.
- **ADR-008:** unchanged. The heartbeat lapse is D3.4's backstop.
- **ADR-020:** every new port field is read as own data through the existing
  doors.
- **ADR-022 D10:** D3's and D4's core hooks are a bounded grant (D3.6).
- **ADR-032 D4:** a hold takes a fresh request token.
- **Handoff §9.9:** a stale `LIVE` no longer starts the incident ladder; a
  newer one still quarantines the market, as today.
- **Handoff §9.10:** the planner quantizes (D2), defines deadlines (D3.4) and
  reserves (D4.2).
- **Handoff §9.11:** the protocol is unchanged.
- **Handoff §9.12:** only the official SDK. `createMarketOrder` is an SDK
  method; nothing is signed by hand.
- **Handoff §6 invariant 10:** exits still come from confirmed allocation, now
  on the venue's grid (D4.3).
- **Handoff §13.3,** "Exit size equals actual allocated filled size": met up
  to the venue's 0.01 grid, with the residue recorded and held to resolution
  (D4.3). This is a named departure, on the authority of §1.1. The state
  machine is unchanged: a bracket with a residual reaches `CLOSED`.
- **`V2-10`:** its conversion grid changes (D4.1), on the authority of
  handoff §1.1.

## Consequences

- **Liveness.**
  - `WP340-F1`'s 287 scripted releases go to 0, and a place-then-cancel no
    longer needs an operator.
  - FAK and FOK reach the venue port.
  - A residue no longer blocks the next bracket.
- **One number and one value.** The OMS, the reservation, reconciliation, the
  signed order and the mock agree on one quantity. PAPER and live read one
  time-in-force from the plan.
- **Costs.**
  - An unordered pair costs one reconciliation read.
  - Residual inventory is held to resolution.
  - The PAPER goldens and the simulator's version pin change with D4. Runs
    before and after it are not comparable.
  - A migration is owed before any PostgreSQL OMS store (Open item 4).
- **Risks.**
  - D1 relies on an inference about `timestamp` (U-52). If the inference is
    wrong, the cost is liveness (D1.7).
  - What the venue reports for collateral-targeted BUYs (U-51) and for a
    killed FOK (U-49) is unknown, so FAK and FOK BUYs stay in PAPER until an
    execution probe observes them.
  - C-7 sets the `SUB_MINIMUM` threshold.

## Alternatives considered

**For D1:**
- **Halt on every unordered pair** (a strict reading of "fail closed").
  Route 3, and every pair within one second, would still halt. The ruling's
  purpose would fail, and the route-3 pin would stay red. Rejected.
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

**For D4:**
- **Keep FAK BUYs in shares.** That is contrary to the venue (F-63).
- **Exit the planned share count.** It leaves the extra shares behind, and is
  contrary to §6 invariant 10.
- **Round the exit up, or buy up to the minimum.** The first exceeds the held
  position; the second adds exposure.
- **Keep the base-unit target** (`V2-10`). It differs from the signed amount.

## Open items

1. **The user confirms D1's hold.** The ruling names two outcomes. D1 adds a
   third, for pairs that venue time cannot order: equal instants, a
   millisecond instant inside a seconds instant, or a PENDING terminal
   instant. If the user rules instead that such pairs halt, D1.5's UNORDERED
   row becomes NEWER. Route 3 (a cancel answer has no instant) and route 1
   (its terminal evidence is a read) would then stay operator releases, and
   their pins would stay failing. Only route 2, against a fill whose stream
   event carries milliseconds, would be judged by venue time alone.
2. **U-52 and C-25:** what `timestamp` names, its unit, whether it is
   monotonic, and how a push is ordered against an answer.
   - The first authenticated observation, in a mode that permits one (the
     execution-probe phase), checks a placement's `timestamp` against its
     `created_at` and against when its answer arrived.
   - Until then D1 rests on A F-98, an inference. D1.7 analyses what happens
     if it is wrong.
3. **U-49, U-50 and U-51:** the killed FOK's answer, FAK and FOK events on the
   stream, and what the venue reports for a collateral-targeted BUY. The first
   execution probe (`WP-350`/`WP-360`) observes them. No FAK or FOK BUY runs
   above PAPER before then.
4. **A migration** for `execution.orders.time_in_force` and the collateral
   target, and for the plan's time-in-force, before any PostgreSQL OMS store
   (`CO3-N3`). `db/migrations/**` is a protected path, and needs its own
   authorization.
5. **C-7,** the unit of the minimum order size, sets D4.3's `SUB_MINIMUM`
   threshold. The planner keeps its share reading until a venue round settles
   it.
6. **The register** (`docs/contracts/protected-contracts.md` §8) gains C-24,
   C-25 and U-49 to U-54, through its owner.
7. **The brief's rows** `WP340-F1`, `CO3-N1`, `CO3-N2` and `V2-10B` point to
   this ADR and to R1 to R3. That is the orchestrator's records work.
8. **Out of scope:** ADR-033 D5's transport and the live composition root. D3's
   port changes are exercised against mocks only.

## Evidence

- **Venue:** [`verified-2026-10-06.md`](../venue/verified-2026-10-06.md)
  F-79…F-104, C-24, C-25 and U-49…U-54, with its source register.
  `verified-2026-10-05.md` F-63, F-64 and F-73. `verified-2026-10-04.md` F-19
  and C-16. `verified-2026-09-16.md` §2.3, C-7 and S-S1j.
- **Findings:**
  - `docs/handoffs/WP-340.md`;
  - `docs/experiments/phase-3-verification.md` §3.2 (A8) and §5;
  - `docs/handoffs/CLOSEOUT-3-wave-3-closeout.md` N1, N2 and N4;
  - `docs/handoffs/V2-10.md`, the deferral;
  - `docs/handoffs/V2-5.md`, summary item 7;
  - the closeout's probe file (sha256 above), and the `V2-10` round-0
    handoff's probe B, both outside the repository under `~/pmb-rounds/`.
- **Code, at `3294201`:**
  - `packages/oms/src/order-manager.ts:285-296, 320-336, 1159-1190,
    2114-2181, 2217-2288, 2908, 3017-3037`;
  - `packages/oms/src/reconciliation/identity.ts:64-71`;
  - `packages/oms/src/ports.ts:30-116`;
  - `packages/polymarket-secure/src/venue-client.ts:295-313, 369-383, 438-455`;
  - `packages/polymarket-secure/src/sdk-port.ts:18-39`;
  - `packages/polymarket-secure/src/user-stream/normalize.ts:95-118, 318`;
  - `packages/polymarket-secure/src/user-stream/oms-projection.ts:64-69,
    126-142`;
  - `packages/polymarket-secure/src/user-stream/wire.ts:76-77, 117-137`;
  - `packages/trading-core/src/pipeline.ts:44-177`;
  - `packages/execution-planner/src/plan.ts:97-109`, `slice.ts:1-31`;
  - `packages/simulation/src/venue.ts:221-269`;
  - `packages/strategies/static-bracket/src/decide.ts:21-30, 843-847`,
    `params.ts:547`;
  - `packages/ledger/src/allocation.ts:65`;
  - `test/fault-injection/live/findings.test.ts`,
    `support/expected-releases.ts`, `support/mock-clob.ts:384, 528-537,
    886-897`;
  - `test/fault-injection/reconciliation/support/wp280.ts:36`;
  - `infra/compose/trader/trader.config.example.json:126-130`;
  - `db/migrations/0005_execution.up.sql` (`execution.plans.deadline_at`; no
    time-in-force column on `execution.orders`).
- **Safety.** This ADR changes no run-mode default (ADR-010). It describes
  behaviour that cannot be reached today: `ALLOW_REAL_ORDERS=false`, both
  live-micro caps are 0, no signer is configured, and no live gate has been
  requested.
