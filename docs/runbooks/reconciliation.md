# Runbook: account reconciliation

Owner: `WP-290` (`packages/oms/src/reconciliation/`, the coordinator;
`packages/ledger/src/reconciliation/`, the break taxonomy, the journal and the
UNATTRIBUTED corrections). Status: **PAPER only**. Nothing here holds a key,
reads a credential, opens a socket or places an order. The coordinator is not
yet composed into any process: every venue read reaches it through an injected
port, and in this repository only test doubles implement those ports.

Authority: handoff §6 (invariants 6, 7, 8 and 12), §9.11, §9.14, §9.15, §9.17,
§10.6; ADR-006 §2 and §5; ADR-007 §3; ADR-032 D4 and D5; the `WP-270` and
`WP-300c` handoffs; `docs/venue/verified-2026-09-30.md` §W.4, §W.8, §W.9 (E-13,
E-14, E-15, E-16), §11 (C-3, C-5) and §12 (U-16, U-22).

---

## 1. What reconciliation does

The coordinator compares what the venue says the account holds with what this
system believes, and decides whether new submissions may continue. It never
trades. It pauses, reads, compares, records, resolves or quarantines, and
resumes only when every required invariant passes (§9.17).

**The one rule an operator must remember:** while any break is unresolved,
new submissions stay paused. Cancels and reconciliation continue.

## 2. Triggers

Every trigger pauses new submissions at once, then queues a run.

| Trigger | Raised by |
| --- | --- |
| `STARTUP` | binding a freshly opened OMS (`bindOms`), so every process start reconciles before it trades |
| `PERIODIC_TIMER` | the composition's timer (the coordinator owns no timer) |
| `USER_STREAM_RECONNECT` | a user-stream request (`WP-280`) caused by a loss, a (re)subscription, a stop or a fault |
| `MARKET_STREAM_GAP` | the market-data gateway |
| `SUBMISSION_UNKNOWN` | the OMS: a placement whose answer was lost |
| `WALLET_OPERATION_UNKNOWN` | the inventory: a wallet operation whose outcome is unknown |
| `MANUAL_REQUEST` | an operator; also every quarantine release |
| `POSITION_BALANCE_DISCREPANCY` | the OMS (an order-state or final-size read), a stream event the OMS could not apply, the inventory's quarantine |

A periodic run therefore pauses trading briefly. That is the §9.17 procedure,
not a fault.

## 3. One run

1. Pause. Close any run a crash left `RUNNING` (recorded `FAILED`). Record
   `RUN_STARTED`. Ask the OMS and the inventory to re-deliver any request they
   still owe (`retryReconciliationRequests`, ADR-032 D5).
2. Read, in this order: open orders, trades, each order that must be read by
   id, positions (`/v2` only), the collateral balance (on chain), approvals,
   the ledger projection, and each wallet-operation member a request names.
   Every read starts after every request the run will answer was received.
   A request that arrives during the reads waits for the next run, which
   starts at once.
3. Compare, and answer the requests (section 5).
4. Record each discrepancy as a break, and each answer.
5. Act on each break by its rule (section 4).
6. Resume if, and only if, everything in section 6 holds.

A run whose reads span more than `maxReadSpanMs`, or during which the clock
went backwards, concludes nothing (`READ_STALE`).

## 4. Breaks

A break is one discrepancy, or one reason the comparison could not be made.
Its class decides its rule. The full table, with every class's meaning, is
`BREAK_TAXONOMY` in `packages/ledger/src/reconciliation/taxonomy.ts`.

| Rule | Who clears it | Classes |
| --- | --- | --- |
| `HOLD_UNTIL_CONSISTENT` | a later complete run that no longer finds it; **never an operator** | every `READ_*` class, `STATUS_UNRECOGNISED`, `SIGNED_IDENTITY_AMBIGUOUS`, `ORDER_STATE_MISMATCH`, `ORDER_UNRESOLVED`, `ORDER_TRADES_INCOMPLETE`, `ORDER_FILLS_AHEAD_OF_VENUE`, `FILL_ECONOMICS_UNFIXED`, `FILL_REFUSED`, `HOLDING_IN_TRANSIT_AMBIGUOUS`, `HOLDING_DELTA_UNCONFIRMED`, `WALLET_OPERATION_IN_FLIGHT`, `APPROVAL_MISSING`, `CORRECTION_FAILED`, `WALLET_MEMBER_*`, `WALLET_ANSWER_REFUSED`, `WALLET_REQUESTS_OUTSTANDING`, `WALLET_OPERATION_UNSETTLED`, `OMS_EVIDENCE_RETAINED`, `COMPONENT_UNAVAILABLE`, `ANSWER_REFUSED`, `HALT_DELIVERY_FAILED`, `REQUEST_MALFORMED` |
| `RESOLVE_IN_RUN` | the run that found it, once its fix is accepted | `TRADE_MISSING_IN_OMS` (a missed fill, delivered with its exact economics) |
| `QUARANTINE_UNTIL_RELEASED` | an operator's release | `ORDER_FACTS_MISMATCH`, `OMS_HALTING_ALERT`, `WALLET_OPERATION_UNIDENTIFIABLE` |
| `UNATTRIBUTED_HALT` | an operator's release, after the market (or account) was halted | `ORDER_UNATTRIBUTED`, `TRADE_UNATTRIBUTED`, `POSITION_UNATTRIBUTED`, `BALANCE_UNATTRIBUTED`, `LEDGER_UNATTRIBUTED_ARRIVAL` |

**Ambiguity never resumes trading.** Every class that means "we cannot tell"
is a hold. No release exists for it. It clears only when a complete,
consistent run no longer finds it.

**Unmatched activity becomes UNATTRIBUTED** (§6 invariant 7, §9.15):

- an order of the account that no tracked order and no unresolved attempt can
  own: `ORDER_UNATTRIBUTED`;
- each trade on such an order: `TRADE_UNATTRIBUTED`;
- a position or collateral delta that no activity explains. It is held once
  (`HOLDING_DELTA_UNCONFIRMED`). If a read at least `holdingConfirmationMs`
  later shows the same delta, it is booked to the ledger's `UNATTRIBUTED`
  scope (a `RECONCILIATION_CORRECTION` carrying the run's id), giving
  `POSITION_UNATTRIBUTED` or `BALANCE_UNATTRIBUTED`. It is never booked
  while an unresolved attempt could explain it (that attempt's fill may not
  be visible yet). Such a delta stays held instead. Any unresolved attempt
  could explain a collateral delta.

Each UNATTRIBUTED break halts its market through the halt port. Collateral,
or a token whose market is unknown, halts the account. The halt is delivered
again by every run while the break is open: the halt port must be idempotent.

**The journal is append-only.** Runs, breaks, quarantines, resolutions and
answers are events. The `ops.reconciliation_runs` and
`ops.reconciliation_breaks` rows are projections of them.

## 5. How requests are answered

| Request | Answer |
| --- | --- |
| OMS, a known venue order (`ORDER_STATE`, `FINAL_SIZE`) | `PRESENT`, from a by-id read made after the request was received. Not given if the venue shows less matched than the OMS recorded (`ORDER_FILLS_AHEAD_OF_VENUE`) or other fixed facts (`ORDER_FACTS_MISMATCH`). |
| OMS, a lost placement (`SUBMISSION_UNKNOWN`) | By signed identity, strictly (next table). |
| Inventory, a wallet operation | Each unresolved member read by name. Only CONFIRMED or FAILED is answered, one answer per member. A pending, dropped, not-found or unrecognised report is waited out. |
| User stream (`WP-280`) | Acknowledged by id after a complete run whose order and trade reads began after the request arrived. |

Every answer echoes the request's id verbatim.

**By signed identity.** No order hash exists (`WP-270`'s STOPPED item), and
no documented read shows a salt. So an unknown attempt is matched on what the
reads do show: token, side, price and original size, among the account's
unclaimed orders.

| What the reads show | Answer |
| --- | --- |
| exactly one matching order, which no other unresolved attempt could own | `PRESENT` |
| two or more matching orders, or one that another attempt could own | none: `SIGNED_IDENTITY_AMBIGUOUS` |
| an unclaimed order on the same token and side that does not match exactly | none: `SIGNED_IDENTITY_AMBIGUOUS` |
| nothing on the same token and side | `ABSENT`, once the reads begin at least `quiescenceHorizonMs` after the coordinator received the request, and the run judged the holdings with no break in the attempt's token or the collateral |

Every `ABSENT` carries `transmissionQuiescent: true`, from the coordinator's
own clock. After a clock fault the window starts again; a reading that went
backwards is never used.

Why ABSENT also needs clean holdings: a marketable order that matched at once
is gone from the open-orders list, and its trade may not be visible yet. Its
fill still moves the holdings once settled, so an unexplained delta in the
token or the collateral withholds ABSENT. So does any unresolved break that
names them. A venue order id the user stream named, which the OMS holds as
retained evidence, is read by id and is a candidate too.

## 6. Resume

Trading resumes only when ALL of these hold at the end of a run:

- every read answered, completely, in its shape, from the required route,
  with no conflict, regression or unrecognised status, within
  `maxReadSpanMs`, and with a sound clock;
- holdings were judged in this run;
- no break is unresolved in the whole journal. Quarantines from before a
  restart count. The journal itself refuses a `PASSED` run otherwise;
- the OMS is bound and not faulted. No attempt or order awaits a read. An
  attempt held for the retransmission decision is the OMS's own exception.
  No evidence is retained;
- no request is unanswered, and none arrived during the run;
- `RUN_COMPLETED` with `PASSED` is durable.

If the OMS's own `resume()` then refuses, it stays paused, and the journal
records `RESUME_REFUSED`.

## 7. Operator actions

- **See what holds the account.** `status()` lists the pending triggers and
  requests, and every unresolved break with its class and detail. Each run's
  report names its detections and answers.
- **Release a quarantine** with `releaseQuarantine({ breakId, operatorRef,
  reason })`. It works only on a QUARANTINED break, and records who released
  it and why. It does not resume trading: it queues a `MANUAL_REQUEST` run,
  which must pass on its own. A released subject is acknowledged: the same
  order, trade or booking does not reopen it, but new activity opens a new
  break.
- **Before releasing an UNATTRIBUTED break,** make sure the incident
  controller holds the market halt. Then decide what the activity was. A live
  unattributed order is cancelled with the emergency CLI (`WP-330`), not here.
- **A held attempt** (the 425 path) waits for the composition's decision:
  resend the same signed order, or abandon it. Trading may resume meanwhile,
  as the OMS allows.
- **An ambiguity that does not clear** (two identical orders and one unknown
  attempt, say) needs a person. Cancel what must be cancelled, then let a run
  find a consistent account. There is no override.

## 8. Configuration

None of these has a default. The coordinator refuses to start without each.
None is a venue fact.

| Setting | Meaning | Constraint |
| --- | --- | --- |
| `quiescenceHorizonMs` | how long after a request's receipt an `ABSENT` may be attested | Must exceed the longest time a transmission can travel. **Needs an ADR before any live mode** (`WP270-DECISIONS`). |
| `maxReadSpanMs` | the longest a run's reads may take and still count as one view | |
| `holdingConfirmationMs` | how much later a delta must be seen again before it is booked | Must exceed the Data API's indexing lag and the composition's ledger-posting latency, neither documented. |
| `requiredApprovalSpenders` | approvals trading needs | e.g. the documented CTF Exchange (§W.8) |
| `accountRef`, `collateralAssetId` | the account and its pUSD asset id | |

The clock port must be **monotonic**: a forward step would attest quiescence
early.

## 9. What the reads must be (for the composition)

| Read | Source | Note |
| --- | --- | --- |
| open orders | CLOB `GET /data/orders`, every page | E-14: absence from this list is not proof of cancellation |
| one order | CLOB `GET /data/order/<id>` | any status |
| trades | CLOB `GET /data/trades`, every page | both status spellings (E-13, C-5); the adapter splits out the account's own legs and states when it cannot |
| positions | Data API **`GET /v2/positions`**, every status | v1 is retired on 2026-10-24 (E-15) |
| approvals | Data API `GET /v2/approvals` | |
| collateral | the pUSD ERC-20 balance on chain | The CLOB balance-allowance read is refused: its response is undocumented (U-22), and its cache is stale until an L2-authenticated refresh (§W.9). |
| a wallet transaction | a chain receipt, by hash | No relayer status read is documented, so a relayer id is unreadable and stays held. |

Reads are per credential (E-16). Read with the credential that placed the
orders. A second credential's orders are invisible.

## 10. Known limits

- An order placed and then cancelled with nothing matched is invisible to
  every read without its id. `ABSENT` then fixes the final size at 0 exactly,
  but does not prove the order never reached the venue. That matters only to
  the 425 same-salt resend, whose ADR is owed.
- Trades are read in full each run; nothing is windowed yet.
- Collateral-kind assets other than pUSD (e.g. USDC.e after an unwrap) have no
  read here, so they are not judged.
- A wallet operation in flight holds the account paused until it is terminal.
- The coordinator's in-memory marks are lost on a restart: the out-of-order
  marks, the unconfirmed deltas, and the attempt facts learned from requests.
  The startup run rebuilds what it needs, conservatively. Quarantines are in
  the journal and survive.
