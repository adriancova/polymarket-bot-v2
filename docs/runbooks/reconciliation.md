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
   still owe (`retryReconciliationRequests`, ADR-032 D5). Record every request
   received since the last run that could not be read (`REQUEST_MALFORMED`).
2. Read, in this order: open orders, trades, each order that must be read by
   id, positions (`/v2` only), the collateral balance (on chain), approvals,
   the ledger projection, what the ledger still books of each FAILED fill
   (section 3, step 3), and each wallet-operation member a request names.
   The orders read by id are: every tracked order still open, every one with
   fills, terminal or not, every one an unresolved break names, every venue
   order an unresolved break names (a read problem keyed by the order, an
   `ORDER_UNRESOLVED` keyed by the venue order, an `ORDER_NOT_FOUND_BY_ID`),
   and every order id of the account a run observed but could not classify.
   E-14: an order absent from the open-orders list is not proof of
   cancellation, and missing orders are resolved by id. **Once observed, an
   order id is never forgotten** while anything about it is unresolved: a
   run whose reads are not one consistent view (or are stale) records every
   unclaimed order id it observed as `ORDER_UNRESOLVED`, keyed by the venue
   order, so the next runs (after a restart too) read it by id until a sound
   run classifies it (tracked, still ownable by an attempt, UNATTRIBUTED, or
   not found). An id is observed in any of five ways, each recorded with its
   **provenance** (the rows of an unusable answer carry either, row by row):

   | Source | Provenance | Recorded as |
   | --- | --- | --- |
   | a complete, valid open-orders list | shown | `ORDER_UNRESOLVED` keyed `venue-order` |
   | a valid trades read's own leg | shown | the same |
   | a by-id read that found the order | shown | the same |
   | a row of a partial, malformed or duplicated open-orders answer, or a leg of such a trades answer, that validated in full (the answer is discarded whole; what its valid rows showed is not) | shown | `ORDER_UNRESOLVED` keyed `venue-order` |
   | the id alone of a malformed row or leg (nothing else of it validated) | named | `ORDER_UNRESOLVED` keyed `venue-order-named` |
   | a by-id read that did not show the order (it failed, was malformed, or did not find it), for an id the OMS's retained stream evidence or a request named | named | the same |

   The provenance is merged: an order a read once showed stays shown (one
   `venue-order` record), however a later unsound run observes it.

   Every read starts after every request the run will answer was received.
   A request that arrives during the reads waits for the next run, which
   starts at once.
3. Compare, and answer the requests (section 5). Every order observation is
   checked on its own before the open-orders list and a by-id read of the
   same order are merged: a status outside the documented vocabulary in
   either read is `STATUS_UNRECOGNISED`; a later read showing an older state
   (less matched, or live after the list showed it terminal) is
   `READ_REGRESSION`; another status at the same stage (`DELAYED`, then
   `LIVE`) is `READ_CONFLICT`. Only "live, then terminal" is a step forward:
   no order-status transition table is documented (C-6, C-14). An order an
   earlier read SHOWED, which its by-id read no longer finds, is a
   `READ_CONFLICT` (the by-id read finds canceled and fully matched orders).
   Any of these makes the run's order reads unsound: nothing is answered from
   them. This holds for a row or leg that validated in full inside a partial,
   malformed or duplicated answer too: it showed the order, so the contradiction
   holds identity resolution exactly as after a complete list. An order id
   only NAMED (no read ever showed it), which a sound run's
   by-id read does not find, contradicts no earlier read: it is an
   `ORDER_NOT_FOUND_BY_ID` quarantine (the account is halted), which keeps
   the id and is read by id while it stands; once found, the order is
   classified like any other.

   Fills are compared with what the OMS recorded durably, by identity (one
   fill per trade and order) and with exact economics, both ways:
   - a trade the OMS holds must carry the same shares, price, fee, role and
     match time; otherwise `FILL_MISMATCH`;
   - the OMS's recorded fill must be exactly what it holds under the venue's
     trade ids. More, with no other trade ids, means the read lags
     (`ORDER_FILLS_AHEAD_OF_VENUE`); more, with trade ids the OMS did not
     record, is `FILL_MISMATCH`;
   - only then is a trade the OMS does not hold a missed fill, delivered
     (`TRADE_MISSING_IN_OMS`);
   - a settlement read earlier than the one the OMS recorded is a
     `READ_REGRESSION`, after a restart too; one that contradicts its terminal
     settlement is a `FILL_MISMATCH`. Once a read is found behind the OMS,
     nothing more is written to the OMS from that run's reads. (Comparing a
     settlement records it in the OMS when it is a legal step forward; a leg
     compared before the regression was found may have been recorded. Each
     such write is a forward fact the venue showed, which the OMS itself
     checks, and the run does not resume.)
   - a missed fill the OMS refuses as a contradiction (it raises its own
     halting alert) is offered once per process, not once per run;
   - a trade of a tracked order the venue shows FAILED is a
     `SETTLEMENT_FAILED` quarantine, keyed by the trade and the order, and
     its market is halted: the ledger booked the fill at its match and owes a
     compensating reversal (ADR-006 §5). This is derived from the venue's
     read in every run. The OMS's own `SETTLEMENT_FAILED` alert lives only in
     its memory and is raised once, so a crash after the OMS recorded the
     failure, before the alert was journaled, would otherwise lose the halt.
     FAILED is "terminal failure" (`docs/venue/verified-2026-08-24.md`, the
     SDK's `TradeStatus`; ADR-006 §5). That the trades read keeps showing a
     FAILED trade is an assumption about the read port: no document states
     how long the venue's trades history keeps a trade;
   - a FAILED trade never moved the chain, and the ledger books its fill
     until a compensating reversal cancels it. So, for each FAILED leg, the
     run reads what the ledger STILL BOOKS of that fill (its principal and
     its fee, net of every reversal linked to them). That remaining booking
     is the only holding difference the fill explains: a fully reversed fill
     explains nothing, so a later unrelated movement of the same size is
     UNATTRIBUTED. While any of it remains, `SETTLEMENT_REVERSAL_OWED` holds
     the account. **A release is not a booking:** releasing the FAILED
     quarantines never clears it; only the ledger's reversal does.

   A tracked order's token (its execution group's), side, price and size are
   its fixed facts; any difference is `ORDER_FACTS_MISMATCH`.
4. Record each discrepancy as a break, and each answer.
5. Act on each break by its rule (section 4).
6. Resume if, and only if, everything in section 6 holds.

A run whose reads span more than `maxReadSpanMs`, or during which the clock
was unreadable or went backwards, concludes nothing (`READ_STALE`). The clock
fault is latched wherever the coordinator detects it: during the reads, while
it records an answer, when a request arrives, at the run's closing reading,
or when an operator's release reads the clock during the run. From that
moment the run gives no further answer (OMS, wallet or stream; an `ABSENT`
queued before the fault included), books nothing, acts on no break, clears
none, and does not resume. What it did before the fault was detected stands.
A later run, with fresh reads, answers what it withheld.

## 4. Breaks

A break is one discrepancy, or one reason the comparison could not be made.
Its class decides its rule. The full table, with every class's meaning, is
`BREAK_TAXONOMY` in `packages/ledger/src/reconciliation/taxonomy.ts`.

| Rule | Who clears it | Classes |
| --- | --- | --- |
| `HOLD_UNTIL_CONSISTENT` | a later complete run that judged it again and no longer finds it; **never an operator** | every `READ_*` class, `STATUS_UNRECOGNISED`, `SIGNED_IDENTITY_AMBIGUOUS`, `ORDER_STATE_MISMATCH`, `ORDER_UNRESOLVED`, `ORDER_TRADES_INCOMPLETE`, `ORDER_FILLS_AHEAD_OF_VENUE`, `FILL_MISMATCH`, `FILL_ECONOMICS_UNFIXED`, `FILL_REFUSED`, `SETTLEMENT_REVERSAL_OWED`, `HOLDING_IN_TRANSIT_AMBIGUOUS`, `HOLDING_DELTA_UNCONFIRMED`, `WALLET_OPERATION_IN_FLIGHT`, `APPROVAL_MISSING`, `CORRECTION_FAILED`, `WALLET_MEMBER_*`, `WALLET_ANSWER_REFUSED`, `WALLET_REQUESTS_OUTSTANDING`, `WALLET_OPERATION_UNSETTLED`, `OMS_EVIDENCE_RETAINED`, `COMPONENT_UNAVAILABLE`, `ANSWER_REFUSED`, `HALT_DELIVERY_FAILED`, `REQUEST_MALFORMED` |
| `RESOLVE_IN_RUN` | the run that found it, once its fix is accepted | `TRADE_MISSING_IN_OMS` (a missed fill, delivered with its exact economics) |
| `QUARANTINE_UNTIL_RELEASED` | an operator's release | `ORDER_FACTS_MISMATCH`, `ORDER_NOT_FOUND_BY_ID`, `SETTLEMENT_FAILED`, `OMS_HALTING_ALERT`, `WALLET_OPERATION_UNIDENTIFIABLE` |
| `UNATTRIBUTED_HALT` | an operator's release, after the market (or account) was halted | `ORDER_UNATTRIBUTED`, `TRADE_UNATTRIBUTED`, `POSITION_UNATTRIBUTED`, `BALANCE_UNATTRIBUTED`, `LEDGER_UNATTRIBUTED_ARRIVAL` |

**Ambiguity never resumes trading.** Every class that means "we cannot tell"
is a hold. No release exists for it. It clears only when a complete,
consistent run no longer finds it, having performed the check that would find
it, and found the subject consistent:

- a run that did not judge the holdings does not clear a holding break;
- a break whose subject names one venue order a read SHOWED (a
  `READ_CONFLICT`, `READ_REGRESSION` or `STATUS_UNRECOGNISED` keyed by the
  order; an `ORDER_UNRESOLVED` keyed `venue-order`) is cleared only by a run
  that read that order again, by id or in the open-orders list. One whose
  subject names a venue order only NAMED (a by-id read's problem:
  `READ_MISSING`, `READ_MALFORMED`, `READ_WRONG_ROUTE` keyed by the order;
  an `ORDER_UNRESOLVED` keyed `venue-order-named`) is cleared only by a run
  whose by-id read of that order answered, found or not (not found, the
  same run records `ORDER_NOT_FOUND_BY_ID`). Every such order is read by id
  in every run, so a later run can always look again;
- a break whose subject names one venue trade (`READ_REGRESSION`,
  `STATUS_UNRECOGNISED` or `READ_INCOMPLETE` keyed by the trade, and
  `SETTLEMENT_REVERSAL_OWED`, which also needs the holdings judged) is
  cleared only by a run whose trades read shows that trade. No by-id trade
  read is documented, so it holds until the trades read shows it again;
- a break about one tracked order's state or fills (`ORDER_STATE_MISMATCH`,
  `ORDER_TRADES_INCOMPLETE`, `ORDER_FILLS_AHEAD_OF_VENUE`,
  `TRADE_MISSING_IN_OMS`, `FILL_*`) is cleared only by a run that compared
  that order in full and found nothing wrong with it. A run that skipped the
  order (its group's token unknown, its venue facts different, its by-id
  read missing), could not verify its fills, found anything else wrong with
  it, or saw it mid-cancel or still reconciling in the OMS clears none of
  them. Every tracked order such a break names is read by id each run, so
  the comparison can be made again;
- a run that did not judge an attempt's identity (or give it an answer) does
  not clear that attempt's ambiguity (or refused answer).

**A malformed request** (from the OMS, the inventory or the user stream) is
refused to its requester and recorded as `REQUEST_MALFORMED`, one break per
receipt. The run that records it cannot pass. A later complete run that no
longer receives it clears it. A requester that keeps presenting it (the OMS's
and the inventory's retries, the user stream's backlog) keeps the account
held: that component needs attention.

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

**Every halt obligation has its own break, derived again in every run.**
The ledger records one obligation per UNATTRIBUTED entry and per breached
bucket, each with its own asset and market. Each is its own break
(`LEDGER_UNATTRIBUTED_ARRIVAL` when no break records it yet), keyed by its
transaction, movement kind, asset, market and place, and halts its own
market. A booking made by this coordinator uses the same key, so a crash
between the booking and its journal entry is recovered as exactly that
break. Each FAILED settlement is its own `SETTLEMENT_FAILED` break, keyed by
its trade and order.

A crash between a quarantine's `BREAK_OPENED` and its `BREAK_QUARANTINED`
leaves it OPEN. The next run quarantines it first, before it delivers the
halts, whether or not it finds the subject again.

**What a release means.** Releasing immutable history (an UNATTRIBUTED order,
trade or booking; one ledger halt obligation; one trade's FAILED settlement;
one venue order id the venue does not show; one OMS alert; an operation that
never named a transaction) acknowledges that subject for good. A release is
never proof that a ledger correction was booked: a FAILED trade's reversal
is its own hold (`SETTLEMENT_REVERSAL_OWED`), which only the ledger clears.
An acknowledged subject does not open again, and new activity opens new
breaks. Releasing one obligation of a transaction never acknowledges
another obligation of the same transaction. Each OMS halting alert is its own break, keyed
by its OMS instance and its place in that instance's list: two alerts of one
kind on one order (two trades of one order FAILED, each owing a reversal) are
two breaks, and releasing the first never acknowledges the second. After a
restart, every alert the new OMS raises is a new break. Releasing a live
contradiction (`ORDER_FACTS_MISMATCH`) does not acknowledge it: every run that
still finds it opens it again, quarantined, with its market halted. The table
is `RELEASE_ACKNOWLEDGES_SUBJECT` in the taxonomy.

**The journal is append-only.** Runs, breaks, quarantines, resolutions and
answers are events. The `ops.reconciliation_runs` and
`ops.reconciliation_breaks` rows are projections of them.

## 5. How requests are answered

| Request | Answer |
| --- | --- |
| OMS, a known venue order (`ORDER_STATE`, `FINAL_SIZE`) | `PRESENT`, from a by-id read made after the request was received. Not given if the venue shows less matched than the OMS recorded (`ORDER_FILLS_AHEAD_OF_VENUE`) or other fixed facts: token, side, price or size (`ORDER_FACTS_MISMATCH`). |
| OMS, a lost placement (`SUBMISSION_UNKNOWN`) | By signed identity, strictly (next table). |
| Inventory, a wallet operation | Each unresolved member read by name. Only CONFIRMED or FAILED is answered, one answer per member. A pending, dropped, not-found or unrecognised report is waited out. |
| User stream (`WP-280`) | Acknowledged by id after a complete run whose order and trade reads began after the request arrived. Each acknowledgement is journaled (`ANSWER_RECORDED`, channel `USER_STREAM`): WP-280 keeps its backlog in memory only. |

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
| an unclaimed order id only named (no read showed it) that the venue's by-id read does not find (`ORDER_NOT_FOUND_BY_ID`) | none, for every attempt: `SIGNED_IDENTITY_AMBIGUOUS` (its token is unknown, so it could be any attempt's), until an operator releases it or the venue shows the order |
| nothing on the same token and side | `ABSENT`, once the reads begin at least `quiescenceHorizonMs` after the coordinator received the request, and the run judged the holdings with no break in the attempt's token or the collateral |

Every `ABSENT` carries `transmissionQuiescent: true`, from the coordinator's
own clock. After a clock fault the window starts again; a reading that went
backwards is never used. A run in which a clock fault is detected gives no
further answer, so an `ABSENT` it queued before the fault is withheld; the
attempt's window restarts, and a later run answers it a full horizon later.

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
  `maxReadSpanMs`, and with a sound clock from the run's start to its
  resume (no reading unreadable or backwards anywhere in the run);
- holdings were judged in this run;
- no break is unresolved in the whole journal. Quarantines from before a
  restart count. The journal itself refuses a `PASSED` run otherwise;
- the OMS is bound and not faulted. No attempt or order awaits a read. An
  attempt held for the retransmission decision is the OMS's own exception.
  No evidence is retained;
- no request is unanswered, and none arrived during the run;
- the journal's breaks can be read;
- `RUN_COMPLETED` with `PASSED` is durable, and nothing held the account
  while it was being written (a trigger, a request, a pause).

If work arrived while the `PASSED` record was being written, the run does not
resume: the journal records `RESUME_REFUSED` (`RECON_WORK_ARRIVED`), and the
next run starts at once. The same holds if a clock fault was detected then
(an operator's release attempted with an unreadable clock):
`RESUME_REFUSED` (`RECON_CLOCK_FAULT`), and the next run starts at once. If
the OMS's own `resume()` refuses, it stays paused, and the journal records
`RESUME_REFUSED` with the OMS's code.

One run at a time: a `reconcile()` call made while a run is in progress
returns at once, with no run.

## 7. Operator actions

- **See what holds the account.** `status()` lists the pending triggers and
  requests, and every unresolved break with its class and detail. Each run's
  report names its detections and answers.
- **Release a quarantine** with `releaseQuarantine({ breakId, operatorRef,
  reason })`. It works only on a QUARANTINED break, and records who released
  it and why. An `OMS_HALTING_ALERT` break is one alert: its detail names the
  alert's place in the OMS instance's list. Handle each one (a FAILED
  settlement owes its own reversal) before releasing it. A FAILED trade also
  has its own `SETTLEMENT_FAILED` break, which names the trade, the order
  and the market. In the process that saw the failure happen, one FAILED
  trade is therefore two quarantines (the OMS's alert and the trade's own).
  After a restart, only the trade's own break remains. **Releasing them does
  not discharge the reversal:** `SETTLEMENT_REVERSAL_OWED` (a hold, never
  released) stays until the ledger books the compensating reversal of every
  transaction of that fill (its principal and its fee), each linked to the
  transaction it reverses (`reversesLedgerTransactionId`: `Ledger.append`
  accepts only an exact negation). A correction that names neither the
  fill nor one of its transactions does not discharge it. A release does not
  resume trading: it queues a `MANUAL_REQUEST` run, which must pass on its
  own. Released history is acknowledged: the same order, trade, booking or
  alert does not reopen it, but new activity opens a new break. A released
  `ORDER_FACTS_MISMATCH` reopens while the venue still shows other facts:
  correct the cause first.
- **A `FILL_MISMATCH` that does not clear** means the OMS's durable fills and
  the venue's trades disagree about a trade, or a settlement contradicts a
  terminal one. The coordinator never rewrites a recorded fill. Establish
  which side is wrong. A wrong read clears on its own once the read is right.
  A wrong OMS record needs a correction outside this package, after which a
  run must find the two equal. Each contradiction is offered to the OMS once
  per process, so its own halting alert (an `OMS_HALTING_ALERT` quarantine)
  is raised once.
- **Before releasing an UNATTRIBUTED break,** make sure the incident
  controller holds the market halt. Then decide what the activity was. A live
  unattributed order is cancelled with the emergency CLI (`WP-330`), not here.
- **A held attempt** (the 425 path) waits for the composition's decision:
  resend the same signed order, or abandon it. Trading may resume meanwhile,
  as the OMS allows.
- **An ambiguity that does not clear** (two identical orders and one unknown
  attempt, say) needs a person, and today has no tool. Cancelling one of the
  orders does not remove it as a candidate: once observed, an order id is
  read by id in every run (whether a complete list, a partial or malformed
  one, a trade, or a by-id read observed it), and a canceled order is still
  found by id (E-14). It clears only if a candidate is claimed by its real
  owner (another attempt found `PRESENT` for it). There is no override
  (section 10).
- **An `ORDER_NOT_FOUND_BY_ID` quarantine** names a venue order id that no
  read ever showed in full (only a by-id read that did not show it, for an id
  the user stream's evidence or a request named, or the id alone of a
  malformed row or leg, named it) and that the venue's by-id read does not
  find. An order a valid row or leg showed, even inside a partial or
  malformed answer, is never this quarantine: its not-found is a
  `READ_CONFLICT`. The account is halted, and while it stands no attempt is
  answered by signed identity (the id could be any attempt's). Establish
  whether the id is the account's (the stream's evidence, the adapter's
  logs). If it may be, do not release it. If it is not, release it: the
  release acknowledges that id for good, and it is no longer read; the
  attempts are then answered, and the OMS may raise its own halting alert
  about stream evidence it retained for that id (a second quarantine). While it stands it is read by id in every
  run, and if the venue shows it later it is classified like any order.

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
early. A step forward is invisible until the clock is corrected back. The
correction is a fault the coordinator detects, and from then on the run
answers nothing more. An answer it gave before the correction stands: an
`ABSENT` that the OMS accepted is not withdrawn. The OMS then holds the attempt
for the retransmission decision, or abandons it.

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

The trades adapter must report each own leg as the user stream's projection
reports a fill (WP-280): the same shares, price and match instant, and the
fee as an exact amount only when it is fixed (a zero-rate taker fee is `0`
with no fee asset; anything not fixed is `null`). The OMS compares a recorded
fill's facts exactly, so a different spelling of the same fill holds as a
`FILL_MISMATCH`.

The composition also binds `tokenOfGroup` to the execution groups it
registered with the OMS (`execution.groups.token_id`). An order whose group's
token is unknown is not compared, and holds (`COMPONENT_UNAVAILABLE`).

The composition binds `HoldingsPort.remainingBookings` by joining the OMS's
fills (`execution.fills`: venue trade and order to fill id) with the
ledger's `remainingFillBookings`, one answer per FAILED fill asked about. An
answer that omits a fill, names one twice, or is unreadable holds the
account (`READ_MALFORMED` or `READ_MISSING` on `ledger-fill-bookings`), and
nothing is judged or booked from it.

## 10. Known limits

- An order placed and then cancelled with nothing matched, and NEVER SEEN by
  any read, is invisible to every read without its id. `ABSENT` then fixes
  the final size at 0 exactly, but does not prove the order never reached the
  venue. That matters only to the 425 same-salt resend, whose ADR is owed. An
  order a read did see is different: it is read by id until classified
  (section 3), so it is never mistaken for absent.
- A crash after a run saw an unclassified order but before that run's
  journal entry (`ORDER_UNRESOLVED`) was written loses the order id. The run
  that saw it never resumed, and the next runs are back to the case above.
- A signed-identity ambiguity between orders the account holds (canceled
  ones included, since a canceled order is still found by id) does not clear
  on its own unless a candidate is claimed by its real owner. No operator
  tool exists to assert which order is the attempt's (follow-up).
- A break keyed by one venue trade holds until the trades read shows that
  trade again. Trades are read in full today. A windowed trades read would
  need care here.
- An order a read SHOWED in full that its by-id read no longer finds holds
  the whole account (`READ_CONFLICT`: nothing is answered while it lasts,
  and no release exists). Fail closed. A row or leg that validated in full
  inside a partial, malformed or duplicated answer counts as shown, so an
  adapter that returns a well-formed row for an order the venue does not
  have holds the account this way too. An order id only NAMED that the venue
  does not find is a releasable quarantine instead (`ORDER_NOT_FOUND_BY_ID`).
  While that quarantine stands, the id is not a signed-identity candidate,
  but nothing rules it out either, so no attempt is answered by signed
  identity until it is released (r5). An operator who releases it wrongly
  (the id was the attempt's own order, and the by-id read lied) lets the
  attempt be answered on the other reads. An id the OMS retains as stream
  evidence, with no unsound run in between, is not watched this way: the
  venue's by-id read (E-14) is taken as authoritative for it, and an attempt
  can be answered while the OMS still retains it (the OMS then raises its own
  halting alert about the evidence; holdings the evidence moved also withhold
  `ABSENT`).
- A clock fault latches the run from the moment it is detected, not before.
  Anything the run did earlier stands: an answer the OMS accepted, a booking,
  a delivered fill. After the fault the run still compares settlements with
  the OMS (`applySettlement`) for the orders it has not compared yet. Each
  such write is a forward fact the venue showed, and the OMS checks it with
  its own transition rule. The write carries the run's read time as
  `observedAt`, which is metadata only: a settlement's order is its ordinal.
  Such writes answer nothing and resolve nothing.
- A FAILED fill's remaining booking is what the ledger books under its fill
  id (and every reversal linked to one of its transactions). The composition
  must join the OMS's fills to the ledger (`HoldingsPort.remainingBookings`).
  An unlinked correction that names the fill counts toward it; one that
  names neither the fill nor its transactions does not.
- One FAILED trade in the process that saw it is three breaks: two
  quarantines (the OMS's alert and the trade's own) and the reversal hold.
- Trades are read in full each run; nothing is windowed yet.
- Collateral-kind assets other than pUSD (e.g. USDC.e after an unwrap) have no
  read here, so they are not judged.
- A wallet operation in flight holds the account paused until it is terminal.
- The coordinator's in-memory marks are lost on a restart: the out-of-order
  marks, the unconfirmed deltas, the attempt facts learned from requests, and
  the contradictions already offered to the OMS. The startup run rebuilds
  what it needs, conservatively: a settlement read behind the OMS's durable
  one is a `READ_REGRESSION` whatever the in-memory marks say. Quarantines
  are in the journal and survive.
- The out-of-order marks keep the latest status a sound read showed, even one
  that contradicted the OMS. If a contradicting read later corrects itself,
  the earlier mark reads the correction as a regression, and holds until a
  restart. Fail closed: it never resumes early.
- **A foreign twin.** No order hash exists, so an unknown attempt is matched on
  its economics. Suppose one order placed outside the OMS has exactly the
  attempt's token, side, price and size, and the attempt's own order is not
  visible (it never arrived, or was cancelled with nothing matched). That
  order is answered `PRESENT` for the attempt, and the OMS then tracks it as
  the attempt's. If the attempt's own order is later seen, it is an unclaimed
  order: `ORDER_UNATTRIBUTED`, or a hold while another attempt could own it.
  This is detection after the fact, not prevention.
- Every tracked order with fills is read by id every run, as is every order
  the trades read names, every tracked order an unresolved break names, and
  every venue order an unresolved hold names or a run saw but could not
  classify. All grow with history.
- A break about a tracked order holds while that order cannot be compared
  again. That includes a terminal order the venue's by-id read no longer
  finds: E-14 says the by-id read finds canceled and fully matched orders, so
  that is a contradiction, and it holds (fail closed).
- The two order reads of one run are compared strictly. A status change
  between them other than "live, then terminal" (a delayed order going live,
  say) holds for that run, and a list that still shows an order live after an
  earlier sound read showed it terminal holds until the list catches up.
  Fail closed: a liveness cost.
- Every OMS halting alert is a quarantine of its own, and needs its own
  release. An OMS that raises the same alert repeatedly (re-delivered
  evidence) opens one quarantine per alert. The coordinator offers each
  contradiction it finds (a fill's economics, a settlement, a refused
  delivery) once per process, so it raises one alert per contradiction per
  process. The OMS's alert list must be append-only: one that is not holds
  the account (`COMPONENT_UNAVAILABLE`) until a freshly opened OMS is bound.
