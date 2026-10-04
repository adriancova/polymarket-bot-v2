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
   The orders read by id are: **every venue order with evidence that no
   sound run has settled** (below), every tracked order still open, every one
   with fills, terminal or not, every one an unresolved break names, every
   venue order an unresolved break names (a read problem keyed by the order,
   an `ORDER_UNRESOLVED` keyed by the venue order, an
   `ORDER_NOT_FOUND_BY_ID`), every id the OMS retains as user-stream
   evidence, and every tracked order a request names. E-14: an order absent
   from the open-orders list is not proof of cancellation, and missing orders
   are resolved by id.

   **The evidence (r6).** Every validated observation, from every source and
   whatever the run's soundness, is recorded BEFORE anything is classified:
   folded into the coordinator's evidence store and appended to the journal
   (`EVIDENCE_RECORDED`). Every run rebuilds the store from the journal, so a
   restart forgets nothing. An observation whose append fails (or that a run
   folded before it failed outright) is kept in memory, folded into the next
   rebuild and appended again; a run whose evidence could not be appended
   concludes nothing (no clearing, no resume) until a later run makes it
   durable. Per venue order the store keeps whether any
   source SHOWED it, every value any observation showed of each of its fixed
   facts (token, side, price, original size: r7), the most matched any
   observation showed (and at least the sum of its distinct trades' legs),
   whether any showed it terminal, and every status seen; per venue trade, its
   legs, each with every value shown of each fill fact (shares, price, fee,
   fee asset, liquidity role, match time: r7), and its furthest settlement.
   These marks only ever go up. The sources:

   | Source | Provenance |
   | --- | --- |
   | a row of a complete, valid open-orders list | shown |
   | a row that validated in full inside a partial, malformed or duplicated open-orders answer (the answer is discarded; what the row showed is not) | shown |
   | an own leg of a valid trades read, or one that validated in full inside an unusable trades answer | shown |
   | a by-id read that found the order | shown |
   | the id alone of a malformed row or leg (nothing else of it validated) | named |
   | an id the OMS retains as user-stream evidence | named |
   | what the user stream reported that the OMS did not apply, whatever it answered (it retained it; it refused it as unknown, inconsistent or contradicting; its store failed and it faulted; it was already faulted; it refused the input; it holds no such fill; it threw), or that was routed while no OMS was bound, recorded the moment it is routed, with a run triggered (r7) | named |

   An order with evidence is read by id in every run until a sound run
   classifies it consistently with ALL its evidence (the run records it
   `SETTLED`); new evidence about it makes it read again. A run whose reads
   are not one consistent view (or are stale) also holds every unclaimed
   order with unsettled evidence as `ORDER_UNRESOLVED`, keyed `venue-order`
   when shown and `venue-order-named` when only named.

   Every read starts after every request the run will answer was received.
   A request that arrives during the reads waits for the next run, which
   starts at once.
3. Compare, and answer the requests (section 5). Every venue order and trade
   the run read, or has unsettled evidence of, gets ONE verdict from the
   evidence store, against the run's other reads and against all the
   evidence, and nothing else is ever answered, compared, classified or
   cleared from a raw read:
   - **consistent**: the run's latest view of it (its by-id read, else its
     row) shows at least everything the evidence holds;
   - **a conflict** (the run's order reads are unsound; nothing is answered
     from them): a status outside the documented vocabulary in any read
     (`STATUS_UNRECOGNISED`); an observation showing less than an earlier
     one, from any run or source (less matched, live after terminal, a
     settlement backwards: `READ_REGRESSION`; a terminal settlement against
     another: `READ_CONFLICT`); the list and the by-id read disagreeing about
     a fixed fact, or about the status at the same stage (`READ_CONFLICT`;
     only "live, then terminal" is a step forward, since no order-status
     transition table is documented, C-6, C-14); trades summing to more than
     the order's matched size, or any trade naming an order a read shows with
     nothing matched; an order a source SHOWED that its by-id read does not
     find (`READ_CONFLICT`: the by-id read finds canceled and fully matched
     orders); (r7) an order's fixed fact, or a fill's economics, that any two
     observations showed with different values (`READ_CONFLICT`, DURABLE: which
     value is the venue's is unknown, so no later read ends it; a value newly
     known, or the same value at another precision, is no contradiction); a
     trade a read SHOWED that a complete trades read omits, while it is not
     accounted for under its own identity (`READ_CONFLICT`: below);
   - **a ghost**: an unclaimed order only NAMED that the by-id read of a
     sound run does not find. No earlier read is contradicted, so it is an
     `ORDER_NOT_FOUND_BY_ID` quarantine (the account is halted), read by id
     while it stands; and while it stands no attempt is answered by signed
     identity (section 5). Once found, it is classified like any order;
   - **acknowledged**: a ghost an operator released, with no new evidence
     since;
   - **missing**: a tracked order its by-id read does not find (the OMS's
     comparison holds it: `ORDER_STATE_MISMATCH`).

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
     checks, and the run does not resume. Every such write passes the
     run-validity latch first.)
   - a missed fill the OMS refuses as a contradiction (it raises its own
     halting alert) is offered once per process, not once per run;
   - a trade of a tracked order the venue shows FAILED is a
     `SETTLEMENT_FAILED` quarantine, keyed by the trade and the order, and
     its market is halted: the ledger booked the fill at its match and owes a
     compensating reversal (ADR-006 §5). This is derived from the venue's
     trades read in every run that read it, whatever the run's soundness. The OMS's own `SETTLEMENT_FAILED` alert lives only in
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

   **Every trade a read showed carries a classification obligation (r7).** Each
   run judges every trade its trades read shows AND every trade a read ever
   showed. A shown trade the complete trades read omits is a `READ_CONFLICT`
   (the run is unsound) unless it is accounted for under its own identity:
   every leg a read showed is on an order the OMS tracks (the OMS comparison
   judges it: `ORDER_FILLS_AHEAD_OF_VENUE`, `ORDER_TRADES_INCOMPLETE`), on an
   order an unresolved attempt could own (that attempt's resolution
   classifies it, and holds the account meanwhile), or has a
   `TRADE_UNATTRIBUTED` break, and no unresolved break names the trade. When no
   one can own a missing trade's order, the run records `TRADE_UNATTRIBUTED`
   for each of its shown legs from the evidence, whatever the run's soundness,
   so the operator sees the trade by its own id. The `READ_CONFLICT` itself
   clears only when a read shows the trade again, consistent. A trade already
   accounted for may later age out of the trades history without holding.
   An UNATTRIBUTED order's `TRADE_UNATTRIBUTED` breaks cover every trade the
   evidence holds on it, not only those the current read shows.
4. Record each discrepancy as a break, and each answer.
5. Act on each break by its rule (section 4).
6. Resume if, and only if, everything in section 6 holds.

A run whose reads span more than `maxReadSpanMs`, or during which the clock
was unreadable or went backwards, concludes nothing (`READ_STALE`). **One
run-validity latch** (r6) is checked immediately before every commit, after
every await that preceded it: each OMS answer, wallet answer and stream
acknowledgement, EACH fill delivery of a multi-fill act, each settlement or
economics write to the OMS, each act, each UNATTRIBUTED booking, each break
resolution, each evidence settlement, the decision, and the resume. A clock
fault, wherever the coordinator detects it (during the reads, while it
records an answer, when a request arrives, at the run's closing reading, or
when an operator's release reads the clock during an awaited delivery), and a
journal that faulted, latch the run: from that moment it commits nothing
more. Recording a hold is never withheld. What it did before the fault was
detected stands. A later run, with fresh reads, does what it withheld.

The evidence and every halt obligation that needs no consistent view of the
venue (each ledger arrival, each FAILED settlement, each OMS halting alert)
are recorded by every run, a stale or unsound one included.

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
is a hold. No release exists for it. **A break leaves the open state by a run
only through one function** (r6): its EXACT subject must have been judged
consistent, positively, by the comparison that actually ran in that run, and
the run must be conclusive (every read complete, consistent and fresh, the
evidence journal readable, every append recorded, the latch passing).
Anything not positively judged stays open:

| Break about | Positively judged by |
| --- | --- |
| one read (or one by-id read): `READ_MISSING`, `READ_MALFORMED`, `READ_INCOMPLETE`, `READ_WRONG_ROUTE` | that read answering in its shape |
| one venue order (a conflict, regression or unrecognised status keyed by it; `ORDER_UNRESOLVED` keyed by the venue order) | the evidence store's verdict on that order, in this run: consistent (an order only named: its by-id read answered, found or not) |
| one venue trade (a regression, conflict, unrecognised status or undetermined ownership keyed by it) | the trades read showing that trade, consistent; no by-id trade read is documented, so it holds until the trades read shows it again |
| one tracked order's state or fills (`ORDER_STATE_MISMATCH`, `ORDER_TRADES_INCOMPLETE`, `ORDER_FILLS_AHEAD_OF_VENUE`, `TRADE_MISSING_IN_OMS`, `FILL_*`) | a comparison of that order in full that found nothing wrong with it (a run that skipped it for an unknown token or other venue facts, could not verify its fills, saw it mid-cancel or still reconciling, or found anything else wrong with it judges none of them); a refused fill also needs its trade read consistent; a missed fill (`RESOLVE_IN_RUN`) is resolved in its own run only when every delivery was accepted and that run is conclusive |
| a holding (`HOLDING_*`, `CORRECTION_FAILED`, `APPROVAL_MISSING`, `WALLET_OPERATION_IN_FLIGHT`) | the holding comparison finding that asset matched (that spender approved; no operation in flight) |
| `SETTLEMENT_REVERSAL_OWED` | that trade read consistent, and the holdings judged with nothing of its fill booked |
| an attempt's identity ambiguity, or a refused answer | that attempt judged without ambiguity, or an answer for it accepted, or nothing owed for it any more |
| a wallet member (`WALLET_MEMBER_*`, `WALLET_ANSWER_REFUSED`) | an answer for that member accepted, or its operation's request gone |
| `REQUEST_MALFORMED` | a run its channel presented nothing malformed to |
| a component, the clock, the journal, a halt delivery, retained evidence, an unsettled operation | that check passing in this run |

**A malformed request** (from the OMS, the inventory or the user stream) is
refused to its requester and recorded as `REQUEST_MALFORMED`, one break per
receipt. The run that records it cannot pass. A later complete run to which
that channel presented nothing malformed clears every one of them. A
requester that keeps presenting it (the OMS's and the inventory's retries,
the user stream's backlog) keeps every one of them open and the account held:
that component needs attention.

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

**Every halt obligation has its own break, derived again in every run,
whatever the run's soundness** (a run whose order reads are unusable, or a
stale one, included: an obligation never waits on a view the account may not
get back). Each has its own identity, an occurrence, never a hash of its
detail. The ledger records one obligation per UNATTRIBUTED entry and per
breached bucket, each with its own asset and market. Each is its own break
(`LEDGER_UNATTRIBUTED_ARRIVAL` when no break records it yet), keyed by its
transaction, movement kind, asset, market and place, and halts its own
market: one transaction touching two markets is two breaks and two halts. A
booking made by this coordinator uses the same key, so a crash between the
booking and its journal entry is recovered as exactly that break. Each FAILED
settlement is its own `SETTLEMENT_FAILED` break, keyed by its trade and order.
Each OMS halting alert is its own break (below); the alerts are inspected
after the reads and again at the end of the run, so an alert the OMS raises
while the run answers or delivers is recorded by that very run, which then
does not resume. Each not-found occurrence of
a venue order id is its own `ORDER_NOT_FOUND_BY_ID`: released, then named
again by new evidence and still not found, it is a new break (keyed by the id
and how many were released before).

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

**The journal is append-only.** Runs, breaks, quarantines, resolutions,
answers and evidence are events. The `ops.reconciliation_runs` and
`ops.reconciliation_breaks` rows are projections of them; the evidence
(`EVIDENCE_RECORDED`) is a third, and a composition must persist it with the
others (the coordinator rebuilds its evidence from it at every run).

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
| a ghost: an unclaimed order id only named (the id alone of a malformed row or leg, an id the OMS retains as user-stream evidence, one the stream reported) that the venue's by-id read does not find (`ORDER_NOT_FOUND_BY_ID`) | none, for every attempt: `SIGNED_IDENTITY_AMBIGUOUS` (its token is unknown, so it could be any attempt's), until an operator releases it or the venue shows the order |
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
names them, and any venue order or trade of the run the evidence store could
not judge without a conflict. A venue order id the user stream named, which
the OMS holds as retained evidence, is evidence: read by id, a candidate when
found, a ghost when not (r6).

A `PRESENT` answer carries the venue order's matched size and status from its
consistent verdict only, so it never fixes a final size below a match any
source showed, and never names a status older than one any source showed.

## 6. Resume

Trading resumes only when ALL of these hold at the end of a run:

- the run is conclusive: every read answered, completely, in its shape,
  from the required route, with no conflict, regression or unrecognised
  status against its own reads or the evidence, within `maxReadSpanMs`, from
  a readable evidence journal, with every append recorded, and with a sound
  clock and journal from the run's start to its resume (no reading
  unreadable or backwards anywhere in the run);
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
`RESUME_REFUSED` (`RECON_CLOCK_FAULT`), and the next run starts at once; or
if the journal faulted then (`RECON_JOURNAL_FAULTED`). If
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
  which side is wrong. A wrong read clears on its own once the read is right,
  but only if no read showed that fill otherwise before: once the venue's
  reads have shown one fill's economics two ways, it is a durable
  `READ_CONFLICT` (r7, below).
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
- **An `ORDER_NOT_FOUND_BY_ID` quarantine** names a venue order id that only
  NAMED evidence knows (the id alone of a malformed row or leg, an id the OMS
  retains as user-stream evidence, one the stream reported) and that the
  venue's by-id read does not find. An order a source SHOWED (a valid row or
  leg, even inside a partial or malformed answer; a by-id read that found
  it) is never this quarantine: its not-found is a `READ_CONFLICT`. The
  account is halted, and while it stands no attempt is answered by signed
  identity (the id could be any attempt's). Establish whether the id is the
  account's (the stream's evidence, the adapter's logs). If it may be, do not
  release it. If it is not, release it: the release settles that id's
  evidence ("the venue does not show it"), so it is no longer read or
  withheld for; the attempts are then answered, and the OMS may raise its own
  halting alert about stream evidence it retained for that id (a second
  quarantine). If new evidence names the id again and the venue still does
  not show it, that is a new occurrence and a new quarantine. While it stands
  it is read by id in every run, and if the venue shows it later it is
  classified like any order.
- **A `READ_CONFLICT` or `READ_REGRESSION` that does not clear** means a read
  shows less than the evidence holds: an order a source showed is no longer
  found, a matched size went down, a terminal order reads live, trades sum to
  more than the order's matched size, or a settlement went backwards. The
  evidence never goes down, so this holds until a read shows at least what
  was seen (a lagging read catches up on its own). If the venue truly
  withdrew what a read once showed (a phantom row, trade or match), the
  account stays held: no release exists, and no tool retracts evidence today
  (section 10). Do not edit the journal; escalate.
- **A `READ_CONFLICT` whose detail says "different fixed facts" or
  "different fill facts"** (r7) means two observations showed one order's
  token, side, price or size, or one fill's shares, price, fee, fee asset,
  role or match time, with different values. It never clears: no read can
  agree with both values, and which one the venue holds is unknown (a signed
  order's facts and a fill's facts do not change; a difference is a wrong
  read, from the adapter or the venue). While it stands, nothing about that
  order or trade is answered (no signed-identity resolution), delivered or
  concluded. Establish which value is right from the venue's own records;
  the account stays held until the retraction ADR gives a path (section 10).
- **A `READ_CONFLICT` whose detail says "missing from a complete trades
  read"** (r7) names a trade a read showed that the complete trades read now
  omits, before it was accounted for. When no one can own its order, its
  `TRADE_UNATTRIBUTED` quarantine names the same trade: handle it as
  unattributed activity. The conflict clears only when a read shows the trade
  again (a lagging read catches up on its own); if the venue truly withdrew
  it, the account stays held (section 10).

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

- **Invisible without its id.** An order placed and then cancelled with
  nothing matched, and NEVER OBSERVED by any source (no read, no stream event
  recorded as evidence), is invisible to every read without its id. So is a
  live order that a complete open-orders list leaves out before any source
  observed it (E-14 says the list may lag; no venue fact bounds the lag).
  `ABSENT` then fixes the final size at 0 for the first, but proves nothing
  about the second: the order may still fill, and is then unattributed
  activity. No reconciler can see it without the order hash (WP-270's
  STOPPED item). An order a source did observe is different: its evidence is
  durable, it is read by id until classified, and a not-found by id never
  answers for it.
- **An observation not yet recorded dies with the process.** A run's
  observations are folded in memory during its reads and journaled together
  once the reads end; the stream's evidence is journaled the moment it is
  routed. One whose append fails is kept in memory and appended again by the
  next run (and a run that could not journal its evidence concludes
  nothing). A crash before it is journaled loses it. The run that made those
  reads never resumed; the next one reads afresh.
- **Evidence never goes down.** A read that showed a match, a trade, a
  terminal status or an order that the venue later withdraws (a phantom row,
  a trade id replaced by another, a read that lied upward) holds the account
  for good (`READ_CONFLICT` or `READ_REGRESSION`, holds with no release), and
  no tool retracts evidence. Fail closed; an operator path needs an ADR
  (follow-up). So, since r7, does any ONE read that showed an order's fixed
  fact or a fill's economics with another value than an earlier observation
  (a transient adapter or venue error included), and a trade a read showed
  that the trades history drops before it was accounted for.
- **What "evidence never goes down" assumes (unverified venue assumptions,
  held as a conservative policy).** No venue document states any of these;
  the code treats a read that disagrees as wrong (it holds), never as a
  correction:
  - an order's matched size never decreases, and a canceled or fully matched
    order is never live again;
  - a trade id, once shown, is not replaced by another for the same fill, and
    the trades read keeps every trade not yet accounted for;
  - an order's token, side, price and original size, and a fill's shares,
    price, fee, fee asset, liquidity role and match time, never change for
    one id.
  E-14 (`docs/venue/verified-2026-09-30.md`, section W.9) says only that a
  by-id read returns an order "regardless of status, including canceled or
  fully matched orders"; it says nothing about how these facts evolve.
  **The FAILED-trade case:** no document states what an order's
  `size_matched` does after one of its trades FAILS. The evidence keeps the
  FAILED leg's shares in the order's high-water matched size, so if the venue
  lowers `size_matched` after a FAILED trade, every later read of that order
  is a `READ_REGRESSION` (or a `READ_CONFLICT` against the trades' sum) and
  the account stays held: fail closed, a liveness cost the retraction ADR
  (or a verified venue fact) must address.
- A signed-identity ambiguity between orders the account holds (canceled
  ones included, since a canceled order is still found by id) does not clear
  on its own unless a candidate is claimed by its real owner. No operator
  tool exists to assert which order is the attempt's (follow-up).
- A break keyed by one venue trade holds until the trades read shows that
  trade again. Trades are read in full today. A windowed trades read would
  need care here.
- An order a source SHOWED in full that its by-id read no longer finds holds
  the whole account (`READ_CONFLICT`: nothing is answered while it lasts,
  and no release exists). Fail closed. A row or leg that validated in full
  inside a partial, malformed or duplicated answer counts as shown, so an
  adapter that returns a well-formed row for an order the venue does not
  have holds the account this way too. An id only NAMED that the venue does
  not find is a releasable quarantine instead (`ORDER_NOT_FOUND_BY_ID`), and
  while it stands no attempt is answered by signed identity. An operator who
  releases it wrongly (the id was the attempt's own order, and the by-id read
  lied) lets the attempt be answered on the other reads.
- A clock fault latches the run from the moment it is detected, not before.
  Anything the run committed earlier stands: an answer the OMS accepted, a
  booking, a delivered fill, a settlement written. A forward step that is
  never corrected is invisible (section 8).
- A FAILED fill's remaining booking is what the ledger books under its fill
  id (and every reversal linked to one of its transactions). The composition
  must join the OMS's fills to the ledger (`HoldingsPort.remainingBookings`).
  An unlinked correction that names the fill counts toward it; one that
  names neither the fill nor its transactions does not.
- One FAILED trade in the process that saw it is three breaks: two
  quarantines (the OMS's alert and the trade's own) and the reversal hold.
- Collateral-kind assets other than pUSD (e.g. USDC.e after an unwrap) have no
  read here, so they are not judged.
- A wallet operation in flight holds the account paused until it is terminal.
- What a restart still forgets: the unconfirmed holding deltas (their
  confirmation starts again), the attempt facts learned from requests (the
  OMS re-issues its requests), and the contradictions already offered to the
  OMS (offered once more, one more OMS alert each). The evidence and every
  quarantine are in the journal and survive.
- The OMS's own alerts live in its memory. An alert raised just before a crash
  that no run recorded is lost as an alert, but its cause is derived again:
  a FAILED settlement from the trades read, an unknown venue order from the
  coordinator's durable stream evidence (read by id, then classified), a
  fill's contradiction from the comparison (offered again), an evidence
  conflict and a reservation shortfall by the OMS's own recovery.
- **A foreign twin.** No order hash exists, so an unknown attempt is matched on
  its economics. Suppose one order placed outside the OMS has exactly the
  attempt's token, side, price and size, and the attempt's own order is not
  visible (it never arrived, or was cancelled with nothing matched, before
  any source observed it). That order is answered `PRESENT` for the attempt,
  and the OMS then tracks it as the attempt's. If the attempt's own order is
  later seen, it is an unclaimed order: `ORDER_UNATTRIBUTED`, or a hold while
  another attempt could own it. This is detection after the fact, not
  prevention. (Once any source observed the attempt's own order, it is a
  candidate, a ghost, or, if a later read shows its fixed facts otherwise, a
  durable contradiction (r7), and the twin is never adopted.)
- Every venue order with unsettled evidence, every tracked order with fills,
  every order the trades read names, every tracked order an unresolved break
  names, and every venue order an unresolved hold names is read by id every
  run. The evidence journal grows with history (one record per informative
  observation).
- A break about a tracked order holds while that order cannot be compared
  again. That includes a terminal order the venue's by-id read no longer
  finds: E-14 says the by-id read finds canceled and fully matched orders, so
  that is a contradiction, and it holds (fail closed).
- The two order reads of one run are compared strictly. A status change
  between them other than "live, then terminal" (a delayed order going live,
  say) holds for that run, and a list that still shows an order live after
  any earlier observation showed it terminal holds until the list catches
  up. Fail closed: a liveness cost.
- Every OMS halting alert is a quarantine of its own, and needs its own
  release. An OMS that raises the same alert repeatedly (re-delivered
  evidence) opens one quarantine per alert. The coordinator offers each
  contradiction it finds (a fill's economics, a settlement, a refused
  delivery) once per process, so it raises one alert per contradiction per
  process. The OMS's alert list must be append-only: one that is not holds
  the account (`COMPONENT_UNAVAILABLE`) until a freshly opened OMS is bound.
