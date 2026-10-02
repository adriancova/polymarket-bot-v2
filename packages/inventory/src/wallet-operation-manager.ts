/**
 * The wallet-operation manager — handoff §9.14 ("Split collateral into complete
 * outcome sets", "Merge balanced outcome sets", "Redeem resolved positions",
 * "Track allowances and trading approvals", "Track relayer transaction
 * lifecycle", "Reconcile all wallet operations"); ADR-006 §8.
 *
 * PAPER ONLY. This module never signs, builds calldata, or sends anything. An
 * operation reaches the outside world only through the injected
 * {@link WalletOperationExecutor} port, which no production code in this
 * package implements; tests use mocks. The executor receives a
 * {@link WalletOperationSubmission}, and no submission has a recipient,
 * destination or bridge field: every operation acts on the account's own
 * holdings (see `venue-facts.ts` for what is and is not documented).
 *
 * Venue facts used (each cited in `venue-facts.ts` or here):
 * - split converts pUSD into a YES and NO pair and merge converts a pair back;
 *   "Every YES and NO pair is backed by exactly `$1` of collateral"
 *   (verified-2026-09-16 §10.2, S-D28 lines 24–42; re-confirmed 2026-09-30
 *   §10.2). So SPLIT of `a` pUSD yields `a` YES and `a` NO; MERGE is its
 *   inverse.
 * - redeem "Exchange[s] resolved outcome tokens for their payout" after
 *   resolution (same source). The payout is credited from the confirmation's
 *   OBSERVED amount. A CANCELLED market is refused: its payout is undocumented
 *   (U-10; GOV-1C's obligation "WP-300 must keep the U-10 CANCELLED refusal").
 *   A non-terminal outcome (DISPUTED, PENDING, PENDING_CLARIFICATION) is
 *   refused (ADR-009 §4, §8).
 * - wrap/unwrap go through the CollateralOnramp/CollateralOfframp, whose
 *   wrap `_asset` "Must be USDC.e" (verified-2026-09-16 D-15; 2026-09-30
 *   §W.8). No rate is documented, so the credit is the OBSERVED amount
 *   (ADR-006 §7 rule 2).
 * - the SDK's `TransactionOutcome` has `transactionHash: TxHash` and
 *   `transactionId: TransactionId | null` (verified-2026-09-16 §10.2; fixture
 *   `positions/split-merge-redeem.json`): a missing relayer id is legal, and
 *   nothing here requires one.
 * - approvals precede the CLOB allowance sync, which precedes trading
 *   (S-D48; `approvals.ts`).
 *
 * UNKNOWN. Any executor result or observation this module does not recognise,
 * any executor exception, and any confirmation lacking required evidence moves
 * the operation to UNKNOWN, and the manager immediately requests
 * reconciliation (trigger `WALLET_OPERATION_UNKNOWN`) and moves it to
 * RECONCILING. While UNKNOWN or RECONCILING the operation's reservations stay
 * held and its effects are not asserted (ADR-006 §8). Only
 * {@link WalletOperationManager.resolveByReconciliation} with authoritative
 * evidence leaves RECONCILING; there is no timeout. The manager is ready to
 * accept that evidence DURING the request call itself, so a requester that
 * answers synchronously is honoured (the operation passes through RECONCILING
 * to the answer); if the request cannot be delivered and nothing answered it,
 * the operation stays UNKNOWN with the request queued for
 * {@link WalletOperationManager.retryReconciliationRequests}. A request raised
 * WHILE another is being delivered (a synchronous requester's answer raising
 * one) is queued too, never delivered re-entrantly, so no requester can drive
 * unbounded recursion; retry never delivers a queued request that a newer
 * request for the same operation supersedes (WP300-R7-X3). If the operation
 * was answered during the delivery and sent back to UNKNOWN inside it, it
 * stays UNKNOWN: retry moves it to RECONCILING by delivering the request
 * raised when it was sent back — or, if evidence weighed inside the same call
 * raised an even newer request, a fresh one carrying everything (WP300-R8-X1,
 * WP300-R9-04; the older request never stands in for either).
 *
 * WHAT IS WEIGHED WHEN AN OPERATION GOES BACK TO UNKNOWN (WP300-R8-01,
 * WP300-R9-01). Nothing that accompanies or triggers a return to UNKNOWN is
 * thrown away. Before the reconciliation request is built, the evidence is
 * weighed against the whole identity set (see EVIDENCE OUTSIDE FLIGHT)
 * exactly as the same fact observed one step later, under reconciliation,
 * would be — with the identifiers it was the first to name counting as named
 * by it:
 * - the claim that sent the operation back: an unrecognised or under-evidenced
 *   observation (or refused reconciliation evidence applied like one), one
 *   naming another transaction, a SUBMITTED after MINED (a stale report, which
 *   changes nothing), a superseded terminal answer (or one naming a request
 *   not issued for the operation) delivered in flight or while the executor
 *   call is pending (WP300-R10-01), the executor's late contradiction, the
 *   executor's NOT_SENT / unrecognised answer contradicting what was
 *   buffered, or its SUBMITTED when the buffer conflicts with it;
 * - every observation still buffered (received while the executor call was
 *   pending): none is applied, every one is weighed.
 * What is NOT weighed is the executor's own answer when nothing else was
 * received (a THROW, an unrecognised answer, a NOT_SENT naming a transaction):
 * it is the operation's own uncertainty, the reason reconciliation is asked
 * for, and contradicts nothing; it names at most the operation's own
 * transaction, which it admits. Nor is a SUBMITTED the operation goes into
 * flight under (its identity in flight — the in-flight trust boundary), nor a
 * THROW (no fact), early or late.
 *
 * OBSERVATIONS DURING SUBMISSION (WP300-R1-05, WP300-R2-02). While the
 * executor call is still pending:
 * - an UNRECOGNISED observation (UNKNOWN, DROPPED, malformed …) moves the
 *   operation to UNKNOWN at once and requests reconciliation — it never waits
 *   for the executor to answer; it is weighed there, with whatever was
 *   buffered (above);
 * - any other observation is buffered (classified on arrival; its identity
 *   admitted). When the executor answers SUBMITTED the WHOLE buffer is checked
 *   before anything is applied: an identity conflict, or anything after a
 *   terminal observation other than an exact repeat of it, is conflicting
 *   evidence and the operation goes UNKNOWN with nothing applied. Otherwise
 *   the buffer is applied in arrival order, and if one of them sends the
 *   operation back to UNKNOWN, it and the rest are weighed there. If the
 *   executor answers NOT_SENT, throws, or answers something unrecognised
 *   while observations are buffered, the operation goes UNKNOWN (never
 *   FAILED), and the buffer is weighed (above);
 * - NOTHING CONCLUDES (CONFIRMED or FAILED, which release reservations and end
 *   the in-flight hold) while the executor call is pending (WP300-R3-02): its
 *   answer may still name another transaction. A terminal reconciliation
 *   answer — one the observation classifier reads as CONFIRMED or FAILED; a
 *   terminal state it does not recognise is an unrecognised answer, handled as
 *   above (WP300B-R1-03) — is never recorded then; what happens to it depends
 *   on where the operation is (WP300-R10-01; every code is in REFUSAL CODES):
 *   - still PLANNED (no reconciliation request has been issued for it yet): a
 *     terminal answer that names a request — necessarily one not issued for
 *     this operation — or is superseded, authoritative or not, is refused
 *     (`WALLET_OP_EVIDENCE_SUPERSEDED`) and never kept: it sends the operation
 *     to UNKNOWN and is weighed there with whatever was buffered, exactly as
 *     the same answer delivered in flight is (see RECONCILIATION ANSWERS). A
 *     terminal answer that names no request is current (nothing has been
 *     weighed yet): it is refused (`WALLET_OP_ILLEGAL_TRANSITION`) and kept
 *     like the same observation — applied once the executor answers
 *     SUBMITTED, when it can conclude, or weighed if the operation goes back
 *     first. So is a terminal fact delivered through {@link observe} (the
 *     in-flight trust boundary for observations). An answer whose `requestId`
 *     is present but not own data does not name "no request": it is
 *     unrecognised (WP300B-R1-02), and sends the operation to UNKNOWN;
 *   - already under reconciliation (it left PLANNED while the executor call
 *     was pending): a terminal answer that every other check accepts is
 *     refused (`WALLET_OP_EVIDENCE_REQUIRED`) and weighed, and the reconciler
 *     is asked again once the executor answers; any other is refused as it
 *     would be with no call pending, and weighed (raising no request until
 *     the executor answers).
 * Since WP300-R9-01 an operation that left PLANNED while the executor call was
 * pending never returns to flight before the executor answers: what moved it
 * was weighed under reconciliation, so a "still in flight" answer is refused
 * (see below). The handling of a terminal observation in flight while the
 * executor is pending (kept, weighed with its answer) is defence in depth.
 * An executor answer that arrives after the operation already left PLANNED
 * is evidence too, weighed like the same fact from any other source:
 * consistent → weighed as the SUBMITTED report it is (a transaction it names
 * first is admitted, marked, and must be answered by name); contradictory
 * (NOT_SENT, unrecognised, another transaction) → weighed like an
 * unrecognised fact; a fresh reconciliation request carries what it opens or
 * contradicts.
 * Because nothing concluded while it was pending, that request is always
 * answerable.
 *
 * ONE IDENTITY SET (WP300-R1-03, WP300-R3-01, WP300-R4-01, WP300-R5-01/02,
 * WP300-R6-01/02). Every transaction hash and relayer id named by any evidence
 * — the executor's answer, an observation (buffered, applied, unrecognised,
 * or refused because the operation is under reconciliation or terminal),
 * reconciliation evidence — is a member of the operation's ONE identity set
 * ({@link OperationIdentity}, `operation-identity.ts`), and is never
 * forgotten. No verified report documents how a relayer id relates to hashes.
 * The first member of each field is the operation's identity. In flight
 * (SUBMITTED/MINED), evidence naming a value outside a non-empty field is
 * conflicting: an observation moves the operation to UNKNOWN (and joins the
 * set); reconciliation evidence is refused (`WALLET_OP_EVIDENCE_CONFLICT`) and
 * weighed. Every reconciliation request carries the set and the members still
 * unresolved.
 *
 * WHERE A PAIRING OF HASH AND RELAYER ID IS STILL ASSUMED (WP300-R7-X4). Not
 * everywhere is free of it; two places treat the identifiers as one
 * transaction, by design:
 * - in flight (SUBMITTED/MINED), the first hash and the first relayer id any
 *   evidence names are learned as the operation's identity, and an in-flight
 *   FAILED naming only a first relayer id (or nothing) concludes, exactly as
 *   the in-flight trust boundary has always concluded on an unnamed FAILED;
 * - before the conclusion, in SIMPLE MODE — at most one hash and one relayer
 *   id, nothing weighed under reconciliation — one terminal answer naming ANY
 *   member concludes for the whole set: `FAILED(null, R)` concludes an
 *   operation submitted as `(A, R)`, with A never answered by name.
 * Once anything is weighed under reconciliation (an observation, refused
 * reconciliation evidence — including a superseded answer that arrived in
 * flight or, since WP300-R10-01, while the executor call was pending —, a late
 * contradiction from the executor, and, since WP300-R9-01,
 * everything that accompanies or triggers a return to UNKNOWN: the claim that
 * sent the operation back and every observation buffered meanwhile; anything
 * but a stale SUBMITTED/MINED report naming no new member, which changes
 * nothing), or the set holds two hashes or two relayer ids, no pairing is
 * assumed: every member is answered by name, terminally (an answer saying
 * "still in flight" is refused and weighed). That holds even when the
 * weighing happened while no transaction had been named yet (WP300-R8-02):
 * every member named AFTER it — by the executor's late answer, an observation
 * or an answer — is answered by name too. With no member at all there is
 * nothing to name, so a terminal answer naming no transaction concludes (a
 * CONFIRMED always names its hash, so such an answer is a FAILED). So simple
 * mode survives a return to UNKNOWN only when what sent the operation back is
 * the executor's own answer with nothing buffered, or a stale report.
 *
 * Per member there is ONE standing outcome (CONFIRMED or FAILED), written by
 * an authoritative answer — for EVERY member the answer names — or by the
 * operation's conclusion; an answer is refused while any member it names
 * stands under a different outcome that nothing contested (and is then
 * weighed: the contradiction contests that outcome — WP300-R7-X1).
 *
 * EVIDENCE OUTSIDE FLIGHT (UNKNOWN, RECONCILING, CONFIRMED, FAILED) — an
 * observation, or reconciliation evidence not recorded as a resolution — is weighed
 * against the WHOLE set, contradictions first and then admission, so no
 * observation evades invalidation by naming another identifier:
 * - a different terminal outcome, a CONFIRMED with a different credited amount,
 *   or an unrecognised observation CONTESTS the standing outcome of each member
 *   it names (every member if it names none);
 * - a FAILED fact, an unrecognised one, or any contradiction, under ANY member,
 *   contests every CONFIRMED standing under EVERY member;
 * - contested standings are SET ASIDE (the members are unresolved again; the
 *   view's `reopenedTransactions` keeps the history); members not seen before
 *   join the set, unresolved;
 * - a stale SUBMITTED/MINED report of members, or a repeat of a standing
 *   outcome that is neither FAILED nor unrecognised, changes nothing.
 * Before the conclusion, any such evidence (anything but a stale report)
 * means the WHOLE set — members named later included, even if none was named
 * yet (WP300-R8-02) — must be answered by name, as it must once more than one
 * hash or relayer id was named: the operation stays RECONCILING (reservations
 * and the in-flight hold kept) until every member stands; it then concludes
 * CONFIRMED if any stands CONFIRMED (the lines await a read), else FAILED. A
 * fresh request carrying the new unresolved members is sent — and one is sent
 * whenever the weighing supersedes earlier reads (WP300-R7-X3), so a current
 * answer always has a request to name.
 *
 * AFTER A TERMINAL STATE. CONFIRMED and FAILED have no exit, but evidence can
 * still arrive. Whatever the weighing leaves unresolved is QUARANTINED: the
 * operation's lines are quarantined in the book
 * ({@link InventoryBook.quarantineLines}), which refuses reservations and
 * which no balance read lifts, an approval's readiness is SUSPENDED in the
 * {@link ApprovalTracker}, and a `POSITION_BALANCE_DISCREPANCY` request
 * carrying `unresolvedTransactions` is sent. The recovery path is
 * {@link WalletOperationManager.resolveByReconciliation}: a terminal
 * authoritative answer for unresolved members, by name (an unnamed answer
 * names only the `operation` key of an operation that never named a
 * transaction). When none remains unresolved the quarantine is lifted and the
 * lines await a fresh authoritative read (the answer may mean an effect this
 * book never applied, or applied wrongly). An approval is then re-recorded
 * with a fresh sequence — so readiness again needs a CLOB allowance sync
 * recorded after it — only if it still stands: some member stands CONFIRMED
 * by an authoritative answer, or stands CONFIRMED and no authoritative answer
 * says FAILED; otherwise it is DISCARDED (fail-closed). The operation's state
 * does not change.
 *
 * RECONCILIATION ANSWERS (WP300-R7-X3, WP300-R7-X1). Every request carries a
 * `requestId`, and the manager records the evidence generation it was issued
 * at (`operation-identity.ts`, "EVIDENCE GENERATION"). An answer echoes the
 * request it reports a read for (`requestId`; none named = read before any
 * evidence was weighed; a `requestId` that is present but not own data is
 * never "none named" — WP300B-R1-02). It is bound only to a request the
 * reconciler has RECEIVED for the operation (see REQUEST IDS). It is
 * SUPERSEDED, and refused
 * (`WALLET_OP_EVIDENCE_SUPERSEDED`) before it changes any standing evidence,
 * when evidence weighed after that request was issued could make the read
 * wrong: a doubt for a CONFIRMED answer, a success claim about a member it
 * names for a FAILED answer, a set-aside or first naming of a member it names
 * for any answer, or the operation re-entering reconciliation. Agreeing
 * evidence does not supersede. A superseded answer, or one naming a request
 * not issued for the operation, never concludes anything, so it never
 * releases a reservation or makes an approval ready (WP300-R10-01 closed the
 * last route by which one could, through the buffer). The exact code for
 * every state and shape is the table in REFUSAL CODES (WP300B-R1-03); in
 * words:
 * - under reconciliation (RECONCILING, an UNKNOWN operation answering the
 *   request being delivered, or a quarantined terminal one) it is refused and
 *   weighed — `WALLET_OP_EVIDENCE_REQUIRED` for a request not issued for the
 *   operation, `WALLET_OP_EVIDENCE_SUPERSEDED` for a superseded read; but an
 *   answer that is not authoritative, or is unrecognised, or (while every
 *   member must be answered by name, or after a terminal state) is not
 *   terminal, is refused `WALLET_OP_EVIDENCE_REQUIRED` before either is
 *   checked;
 * - a TERMINAL one — CONFIRMED or FAILED as the observation classifier reads
 *   it — delivered in flight, or while the executor call is pending before
 *   the operation left PLANNED (no request has been issued for it then, so
 *   any request it names is not one of its own), is refused
 *   (`WALLET_OP_EVIDENCE_SUPERSEDED`), never applied or kept: it sends the
 *   operation to reconciliation and is weighed there. One whose terminal state
 *   the classifier does not recognise (CONFIRMED with no hash, a malformed
 *   identity field or credited amount, a field that is not own data) is an
 *   UNRECOGNISED answer instead: refused `WALLET_OP_ILLEGAL_TRANSITION` and
 *   handled like the same unrecognised observation, which sends the operation
 *   to reconciliation too (never kept, never concluding);
 * - one that is not terminal (SUBMITTED/MINED), in flight or while the
 *   executor call is pending, is handled like the same observation (see
 *   below): refused `WALLET_OP_ILLEGAL_TRANSITION`; it cannot conclude;
 * - anywhere else (UNKNOWN with no request being delivered, a terminal
 *   operation that is not quarantined) it is refused
 *   (`WALLET_OP_ILLEGAL_TRANSITION`) and weighed.
 * Before submission (PLANNED, the executor not called) nothing has left the
 * process: any answer or observation is refused
 * (`WALLET_OP_ILLEGAL_TRANSITION`) and changes nothing about the operation
 * (a request id an answer names is still recorded, wherever it arrives: see
 * REQUEST IDS).
 *
 * The FIRST entry into reconciliation marks nothing by itself (WP300-R9-01
 * asked whether it should; it does not): there is no earlier request whose
 * reads it could supersede, and every claim that accompanies or triggers it
 * is weighed (see WHAT IS WEIGHED …), so each marks what it concerns and an
 * answer that echoes no request is superseded for all of it. What stays
 * current for such an answer is only what no weighed evidence concerns — all
 * of it after the executor's own uncertainty with nothing buffered (a THROW,
 * an unrecognised answer), where nothing was weighed. Marking everything
 * on the first entry would make an answer that echoes no request useless
 * before any conclusion (every RECONCILING operation passed through UNKNOWN),
 * which the request contract allows; known risk: a reconciler that answers
 * without echoing the request it read for, from a read made before it was
 * asked, is trusted for what nothing contradicts.
 *
 * Reconciliation evidence that is not RECORDED as a resolution — whatever the
 * reason: not authoritative, inconclusive, superseded, unwitnessed, refused
 * while the executor is pending, contradicting standing evidence, or arriving
 * after a terminal state — is never thrown away once the operation has been
 * handed to the executor (before that, nothing has left the process and it
 * changes nothing; see above):
 * - while the executor call is pending and the operation is still PLANNED,
 *   it is handled like the same observation there (kept, or, if
 *   unrecognised, sending the operation to UNKNOWN — see OBSERVATIONS DURING
 *   SUBMISSION), except a TERMINAL answer that names a request (none has been
 *   issued for the operation yet) or is superseded, authoritative or not:
 *   that one is never kept, and is handled exactly as in flight (next item) —
 *   it sends the operation to reconciliation and is weighed there, after
 *   whatever was buffered and before the request is delivered (WP300-R10-01);
 * - outside flight it is weighed against the whole set exactly as the same
 *   observation would be (contesting, admitting, requiring every member by
 *   name; quarantining after a terminal state and suspending an approval);
 * - in flight, a CURRENT answer is applied exactly as the same observation
 *   would be (the in-flight trust boundary), while a SUPERSEDED terminal
 *   answer, or one naming a request not issued for the operation —
 *   authoritative or not (WP300-R9-03) — is never applied: it sends the
 *   operation back to reconciliation and is then weighed there like the same
 *   observation outside flight — admitting what it names, contesting what it
 *   contradicts, requiring every member by name (WP300-R8-01). That weighing
 *   happens BEFORE the reconciliation request is delivered, so the request
 *   carries the new members and a requester that answers synchronously,
 *   inside the call, already has to answer them. An answer that is not
 *   terminal (SUBMITTED/MINED) is applied in flight like the same observation
 *   whether or not it is superseded: it cannot conclude, but it can teach the
 *   operation a first hash or a first relayer id (the in-flight trust
 *   boundary), and one naming another transaction sends it back to UNKNOWN,
 *   where it is weighed.
 * The one exception is an authoritative answer that repeats, for every member
 * it names, an outcome the authority already gave and that still stands: it
 * carries no new fact (directive 3 would otherwise let a reconciler that
 * answers every member on every request reopen its own answers forever).
 * While the executor call is pending, reconciliation evidence weighed under
 * reconciliation raises no request of its own; the executor's answer sends
 * the one owed. (Evidence that moves the operation to UNKNOWN — out of
 * PLANNED, as above — requests reconciliation at once, like every move to
 * UNKNOWN.)
 *
 * REFUSAL CODES (WP300B-R1-03). What
 * {@link WalletOperationManager.resolveByReconciliation} returns, by where the
 * operation is (rows) and what the answer is (columns).
 * `test/unit/inventory/refusal-codes.test.ts` reads this table from this file
 * and checks every cell against the code. The three "RECONCILING" rows also
 * cover an UNKNOWN operation answering the request being delivered (a
 * synchronous requester): it takes the same path. Columns:
 * - `U`: unrecognised, from any source and naming any request. The
 *   observation classifier does not read its state as SUBMITTED, MINED,
 *   CONFIRMED or FAILED (an unknown or missing state, NOT_SENT, MINED with no
 *   hash); or it rejects the terminal state it reads (CONFIRMED with no hash,
 *   a malformed identity field, a malformed or negative credited amount); or
 *   a field is present but not own data (see EVIDENCE AT THE DOOR);
 * - `N.c`, `N.s`, `N.x`: SUBMITTED or MINED, recognised and authoritative —
 *   current; superseded (naming no request counts as naming one issued before
 *   any evidence was weighed); or naming a request the reconciler had not
 *   received for the operation before the read of an answer naming it began
 *   (another operation's, an unknown, pre-named or queued id, one whose token
 *   was guessed, one received only during the answer's own read or during the
 *   read of an earlier answer that named it, `""`, a number, an object; see
 *   REQUEST IDS);
 * - `T.c`, `T.s`, `T.x`: CONFIRMED or FAILED, recognised and authoritative,
 *   likewise;
 * - `H`: recognised but not authoritative (`source` is not
 *   `"AUTHORITATIVE_READ"`), with any binding.
 * Codes: `IT` = `WALLET_OP_ILLEGAL_TRANSITION`, `SU` =
 * `WALLET_OP_EVIDENCE_SUPERSEDED`, `RQ` = `WALLET_OP_EVIDENCE_REQUIRED`, `CF` =
 * `WALLET_OP_EVIDENCE_CONFLICT`, `ok` = accepted. `ok/CF/RQ`: accepted unless
 * the identity set refuses it — `CF` for a value outside a non-empty identity
 * field, or a member standing under the other outcome; `RQ` for an answer
 * naming no member (simple mode) or no unresolved member (by name); `CF/RQ`
 * while the executor call is pending (`RQ` for whatever every other check
 * accepts). `shape`: authority does not matter there; the code is the one in
 * the column of the answer's shape. `—`: cannot happen (no request is issued
 * while an operation is PLANNED, so none is superseded).
 *
 *   | where the operation is               | U  | N.c      | N.s | N.x | T.c      | T.s | T.x | H     |
 *   | PLANNED, not submitted               | IT | IT       | —   | IT  | IT       | —   | IT  | shape |
 *   | PLANNED, executor pending            | IT | IT       | —   | IT  | IT       | —   | SU  | shape |
 *   | SUBMITTED or MINED                   | IT | IT       | IT  | IT  | IT       | SU  | SU  | shape |
 *   | UNKNOWN, no request being delivered  | IT | IT       | IT  | IT  | IT       | IT  | IT  | IT    |
 *   | RECONCILING, simple mode             | RQ | ok/CF/RQ | SU  | RQ  | ok/CF/RQ | SU  | RQ  | RQ    |
 *   | RECONCILING, every member by name    | RQ | RQ       | RQ  | RQ  | ok/CF/RQ | SU  | RQ  | RQ    |
 *   | RECONCILING, executor pending        | RQ | RQ       | RQ  | RQ  | CF/RQ    | SU  | RQ  | RQ    |
 *   | CONFIRMED or FAILED, not quarantined | IT | IT       | IT  | IT  | IT       | IT  | IT  | IT    |
 *   | CONFIRMED or FAILED, quarantined     | RQ | RQ       | RQ  | RQ  | ok/CF/RQ | SU  | RQ  | RQ    |
 *
 * (Simple mode: one identity and nothing weighed under reconciliation — see
 * WHERE A PAIRING … IS STILL ASSUMED. With the executor call pending, every
 * member is answered by name: what moved the operation out of PLANNED was
 * weighed.) An `IT` answer, and any `SU`/`RQ`/`CF` refusal, is weighed as
 * described above, unless it is an authoritative repeat; a `U` answer never
 * concludes anything wherever it arrives.
 *
 * EVIDENCE AT THE DOOR (WP300B-R1-01, WP300B-R1-02; `guards.ts`, "EVIDENCE IS
 * READ ONCE"). An observation ({@link WalletOperationManager.observe}), a
 * reconciliation answer ({@link WalletOperationManager.resolveByReconciliation})
 * and the executor's answer are each read ONCE, field by field, as they arrive
 * — before the operation is looked up, before anything is decided — and every
 * decision is taken on that snapshot: whether an answer is authoritative, its
 * state, its binding, its identity and credited amount, and the observation
 * the same answer becomes when it is weighed. Nothing reads the caller's
 * object again. So a Proxy whose traps answer differently on a second read
 * (MINED, then FAILED) is decided on what it said first, and a trap that calls
 * back into the manager acts before the call it belongs to decides anything.
 * The one thing settled DURING the read is an answer's binding: whether the
 * request its `requestId` names had been received before the read began is
 * decided, and an id named before receipt is recorded, the moment that field
 * is read (see REQUEST IDS), so no trap — on a field read before it or after
 * it — can bind the answer, or any later answer, to a request issued during
 * its read (WP300C-J2, WP300C-R2-X1). A field that is present but not the caller's own data —
 * an accessor (whose getter is never run), an inherited property, or a
 * property whose read throws — is OPAQUE,
 * and the evidence carrying it is UNRECOGNISED: it moves the operation to
 * reconciliation, is weighed as naming only what it names as own data, and
 * concludes nothing. In particular a `requestId` that is not own data never
 * means "no request named" (which can be current), and a `transactionHash` or
 * `transactionId` that is not own data never reads as "names nothing". The
 * fields read are `status`, `transactionHash`, `transactionId` and (for an
 * observation) `credited`; for an answer, `source`, `state`, `requestId`,
 * `transactionHash`, `transactionId` and `credited`.
 *
 * REQUEST IDS (WP-300c; WP-300b known risk 1; WP300C-J1, WP300C-J2,
 * WP300C-R2-X1, WP300C-R2-X3). An answer must never be bound to a request it
 * was not read for. Three rules make that hold:
 * - an answer is bound only to a request the reconciler had RECEIVED for the
 *   operation it is addressed to BEFORE the answer's door read began: its
 *   `request` call had returned, or was still in progress (a synchronous
 *   requester answers inside it). A request that is only queued (the
 *   reconciler was down, or it was raised during another delivery) has not
 *   been received, and nor has one whose `request` call threw. One received
 *   DURING the answer's own read — a trap on a field read before `requestId`,
 *   or on `requestId` itself, called back into the manager, which issued and
 *   delivered it — is not bound either: the fields read before it predate it
 *   (WP300C-J2);
 * - every string an answer names as its `requestId` that is not, at that
 *   moment, a request received for the operation it is addressed to — or that
 *   is addressed to an operation that does not exist — is recorded manager
 *   wide, and NO request is ever issued under it: the next id skips it. It is
 *   recorded the moment the `requestId` field is read, before any later field
 *   is read, so a trap on a later field that calls back into the manager
 *   (which may issue requests) can never issue the id just named (WP300C-J2).
 *   A queued request whose id is named before its delivery is never
 *   delivered: retry replaces it with a fresh request under a new id, as it
 *   replaces one that a newer request supersedes. An id received only DURING
 *   the read of the answer naming it is recorded too, and no answer is ever
 *   bound to it afterwards: a later answer naming it — a verbatim replay of
 *   the same values included — is refused like the first (WP300C-R2-X1). If
 *   it is the operation's latest request once that answer has been handled,
 *   and the operation still awaits an answer (only RECONCILING, or terminal
 *   and quarantined: not in flight, and not terminal without a quarantine —
 *   WP300C-R3-02), a fresh request replaces it. It is sent then, or queued
 *   if it cannot be delivered then (the reconciler refused it, its token draw
 *   failed, or this runs inside another request's delivery, which is never
 *   re-entered), and retry delivers it — after a failed draw, a fresh request
 *   in its place (WP300C-R3-01). While the executor call is pending, the
 *   fresh request is owed instead, and sent when the executor answers. So the
 *   reconciler always holds a request it can answer, or is handed one by
 *   retry;
 * - every request id carries a TOKEN that no reconciler can know before it
 *   receives the request (WP300C-J1): `compositeKey("wallet-op", operationId,
 *   "reconciliation", n, token)`, the token drawn once per id from the
 *   injected {@link WalletOperationManagerDependencies.requestToken}
 *   source. The composition root binds that source to a CSPRNG; this package
 *   uses no randomness itself, and given the source it stays deterministic. A
 *   read made for a request that does not exist yet — prepared for the
 *   predicted next id and held back until the reconciler received that
 *   request — cannot name the token, so it names an id never issued and is
 *   never bound, however long it is held. A draw that fails (the source
 *   throws, or returns something other than a non-empty string of at most
 *   {@link MAX_REQUEST_TOKEN_LENGTH} characters that this manager never drew
 *   before) leaves the request without a token: it is never delivered, so no
 *   answer can be bound to it; it is queued, and retry replaces it with a
 *   fresh request under a fresh draw.
 * So an answer that names an id before the reconciler received it (judged
 * from the moment that answer's read began) is never bound to it, however
 * often it is delivered again. The records only grow; they live as long as
 * the manager, like the rest of its state. What remains is what no id can
 * show, because an answer carries no time: a reconciler that receives a
 * request and then answers it with a read it made BEFORE receiving it,
 * relabelled with the new id (a stale read relabelled with the fresh request
 * that replaced a recorded one included). The request contract forbids that —
 * never answer a request with a read made before receiving it (WP-290) — and
 * an id the reconciler could know in advance (a token source that is not a
 * CSPRNG) re-opens the held-back case above.
 * Because the token comes from the source, request ids are NOT reproducible
 * from one run to the next: under a CSPRNG the same events give different
 * ids. Anything that journals or replays requests, or answers echoing their
 * ids, must record the tokens drawn (or inject a replay source that returns
 * the recorded tokens in order), and a predictable replay source must never
 * be the production source: that re-opens the held-back case (WP300C-R2-X3).
 *
 * RECOGNITION BOUNDARY. From submission until the operation resolves
 * (CONFIRMED or FAILED), every line it touches is under an in-flight hold in
 * the book ({@link InventoryBook.holdForOperation}), so an authoritative
 * balance read of those lines is refused and the operation's effect is
 * recognised exactly once: as deltas on confirmation, or — after a
 * reconciled confirmation, which applies no deltas — inside the next balance
 * read.
 */

import { compareDecimal, type DecimalString } from "@polymarket-bot/decimal";
import type { MarketOutcomeState } from "@polymarket-bot/domain";

import type { ApprovalTracker } from "./approvals.js";
import type { AssetRegistry } from "./assets.js";
import {
  compositeKey,
  isIdentifier,
  MAX_IDENTIFIER_LENGTH,
  ownData,
  ownNonEmptyString,
  ownNonNegativeAmount,
  ownPositiveAmount,
  readField,
  type FieldRead,
} from "./guards.js";
import type { InventoryBook } from "./inventory-book.js";
import {
  identityKeys,
  OperationIdentity,
  type AnswerCheck,
  type IdentityValues,
  type TerminalOutcome,
  type WeighedEvidence,
  type Weighing,
} from "./operation-identity.js";
import { ok, refuse, type EvidenceValue, type InventoryRefusalCode, type InventoryResult } from "./refusals.js";
import { isDocumentedApprovalSpender } from "./venue-facts.js";
import {
  isLegalWalletTransition,
  WALLET_OPERATION_TYPES,
  WALLET_OPERATION_UNKNOWN_TRIGGER,
  type WalletOperationState,
  type WalletOperationType,
} from "./wallet-operations.js";

// ------------------------------------------------------------------ plans --

export type WalletOperationPlan =
  | {
      readonly type: "APPROVE_ERC20";
      readonly operationId: string;
      readonly accountRef: string;
      /** The collateral asset approved (pUSD or USDC.e). */
      readonly assetId: string;
      readonly spender: string;
      readonly allowance: DecimalString;
    }
  | {
      readonly type: "APPROVE_ERC1155";
      readonly operationId: string;
      readonly accountRef: string;
      readonly spender: string;
    }
  | {
      readonly type: "SPLIT" | "MERGE";
      readonly operationId: string;
      readonly accountRef: string;
      readonly conditionId: string;
      readonly amount: DecimalString;
    }
  | {
      readonly type: "REDEEM";
      readonly operationId: string;
      readonly accountRef: string;
      readonly conditionId: string;
      readonly resolution: MarketOutcomeState;
      readonly yesAmount?: DecimalString;
      readonly noAmount?: DecimalString;
    }
  | {
      readonly type: "WRAP_COLLATERAL" | "UNWRAP_COLLATERAL";
      readonly operationId: string;
      readonly accountRef: string;
      readonly amount: DecimalString;
    };

/**
 * Exactly the own keys each plan type may carry. A plan with any other key —
 * `to`, `recipient`, `destination`, `chainId`, `bridge` … — is refused: no
 * operation here can direct funds anywhere but the account's own holdings.
 */
export const WALLET_PLAN_KEYS: Readonly<Record<WalletOperationType, readonly string[]>> = Object.freeze({
  APPROVE_ERC20: Object.freeze(["type", "operationId", "accountRef", "assetId", "spender", "allowance"]),
  APPROVE_ERC1155: Object.freeze(["type", "operationId", "accountRef", "spender"]),
  SPLIT: Object.freeze(["type", "operationId", "accountRef", "conditionId", "amount"]),
  MERGE: Object.freeze(["type", "operationId", "accountRef", "conditionId", "amount"]),
  REDEEM: Object.freeze(["type", "operationId", "accountRef", "conditionId", "resolution", "yesAmount", "noAmount"]),
  WRAP_COLLATERAL: Object.freeze(["type", "operationId", "accountRef", "amount"]),
  UNWRAP_COLLATERAL: Object.freeze(["type", "operationId", "accountRef", "amount"]),
});

/** What the executor port receives. Frozen; carries no recipient of any kind. */
export type WalletOperationSubmission = WalletOperationPlan;

// ------------------------------------------------------------------ ports --

/**
 * The only way an operation leaves this package. A composition root binds it
 * to the secure adapter (`packages/polymarket-secure`, whose run-mode gate
 * refuses PAPER); in this repository only test mocks implement it.
 *
 * Recognised results: `{ status: "NOT_SENT" }` (definitively nothing left the
 * process; it names no transaction — a NOT_SENT naming one, or carrying a
 * malformed identity field, is unrecognised: WP300-R9-02) and `{ status:
 * "SUBMITTED", transactionHash: string | null, transactionId: string | null }`
 * with at least one non-null. Anything else, or a rejection, is UNKNOWN. The
 * answer is read once, as it arrives (`status`, `transactionHash`,
 * `transactionId`); a field that is present but not own data makes it
 * unrecognised (see the header, "EVIDENCE AT THE DOOR").
 */
export interface WalletOperationExecutor {
  submit(submission: WalletOperationSubmission): Promise<unknown>;
}

export type ReconciliationTrigger = typeof WALLET_OPERATION_UNKNOWN_TRIGGER | "POSITION_BALANCE_DISCREPANCY";

export interface ReconciliationRequest {
  /**
   * This request's id (WP300-R7-X3). An answer echoes it as `requestId`, and
   * must report a read made AFTER the request was received: the manager
   * refuses (`WALLET_OP_EVIDENCE_SUPERSEDED`) an answer whose request was
   * issued before evidence that could make that read wrong. An answer that
   * echoes no request is taken as read before any such evidence (it is current
   * only while none has been weighed). An answer is bound to a request only
   * once the reconciler has received it, no request ever carries an id that
   * an answer named before that, and every id carries a token the reconciler
   * cannot know before it receives the request (see the header, "REQUEST
   * IDS"). Treat it as opaque: echo it verbatim, never derive one.
   */
  readonly requestId: string;
  /** A WP-040 `internal.reconciliation_trigger` value. */
  readonly trigger: ReconciliationTrigger;
  readonly walletOperationId: string;
  readonly accountRef: string;
  readonly reason: string;
  /**
   * The operation's identity set: every transaction hash / relayer id any
   * evidence has named for it (WP300-R3-01, WP300-R6).
   */
  readonly transactionHashes: readonly string[];
  readonly transactionIds: readonly string[];
  /**
   * The members the reconciler must resolve, by name, before the operation
   * (or, after a terminal state, its quarantine) can be released (`hash:<h>` /
   * `id:<i>`, or `operation` for an operation that never named a transaction).
   * Answer each with a terminal authoritative answer naming it.
   */
  readonly unresolvedTransactions: readonly string[];
}

/** Hands a reconciliation request to the reconciler (§9.17; WP-290). */
export interface ReconciliationRequester {
  request(request: ReconciliationRequest): void;
}

/**
 * The longest request token ({@link WalletOperationManagerDependencies.requestToken})
 * the manager accepts. A UUID is 36 characters.
 */
export const MAX_REQUEST_TOKEN_LENGTH = 128;

/** What a {@link WalletOperationManager} is built from. */
export interface WalletOperationManagerDependencies {
  readonly book: InventoryBook;
  readonly approvals: ApprovalTracker;
  readonly executor: WalletOperationExecutor;
  readonly reconciler: ReconciliationRequester;
  /**
   * The source of every reconciliation request id's TOKEN (WP300C-J1; see the
   * header, "REQUEST IDS"). Called once per request id the manager builds; it
   * must return a fresh token that no reconciler can know before it receives
   * the request carrying it: a non-empty string of at most
   * {@link MAX_REQUEST_TOKEN_LENGTH} characters, never one it returned
   * before. The composition root binds it to a CSPRNG, for example
   * `() => crypto.randomUUID()`. It is injected because generating one needs
   * randomness, which this layer-1 package does not use (as
   * `packages/polymarket-public` takes its `connectionId` source). It must
   * not call back into the manager. A draw that throws or returns anything
   * else fails closed: the request is never delivered, and retry draws again.
   * A predictable source (a counter, a clock) re-opens the held-back
   * pre-named read the token closes; tests use one only to show that.
   * Read once, when the manager is built (WP300C-R2-X5). Request ids are not
   * reproducible across runs: a journal or replay of requests (or of answers
   * echoing their ids) must record the drawn tokens or inject a source that
   * returns them, and such a replay source must never be the production
   * source (WP300C-R2-X3; see the header, "REQUEST IDS").
   */
  readonly requestToken: () => string;
}

// ------------------------------------------------------------------ views --

export interface WalletOperationEvent {
  readonly operationId: string;
  readonly ordinal: number;
  readonly previousState: WalletOperationState | null;
  readonly newState: WalletOperationState;
  readonly reason: string;
}

export interface WalletOperationView {
  readonly operationId: string;
  readonly type: WalletOperationType;
  readonly accountRef: string;
  readonly state: WalletOperationState;
  readonly plan: WalletOperationPlan;
  readonly reservationIds: readonly string[];
  readonly transactionHash: string | null;
  readonly transactionId: string | null;
  /** Whether confirmed effects were applied as deltas (false: lines await an observation). */
  readonly effectsApplied: boolean;
  /** Whether the executor call is still pending. */
  readonly submitting: boolean;
  /** Observations received during submission and not yet applied. */
  readonly bufferedObservations: number;
  /** Every transaction hash any evidence has named, in order of arrival (the identity set's hashes). */
  readonly transactionHashes: readonly string[];
  /** Every relayer transaction id any evidence has named, in order of arrival (the identity set's ids). */
  readonly transactionIds: readonly string[];
  /**
   * Members of the identity set lacking standing evidence that must be
   * answered by name (`hash:<h>` / `id:<i>` / `operation`): before the
   * conclusion, once the whole set must be answered (none otherwise); after a
   * terminal state, the quarantined ones. Nothing is released while any remain.
   */
  readonly unresolvedTransactions: readonly string[];
  /** A terminal operation whose outcome is contested; its lines are quarantined. */
  readonly quarantined: boolean;
  /**
   * Members whose standing evidence was contested and set aside
   * (WP300-R5-01, WP300-R6), in order. Never shrinks.
   */
  readonly reopenedTransactions: readonly string[];
}

interface Operation {
  readonly plan: WalletOperationPlan;
  readonly reservations: readonly { readonly reservationId: string; readonly assetId: string; readonly amount: DecimalString }[];
  state: WalletOperationState;
  /** The ONE identity set and the evidence standing under it (WP300-R6; see the header). */
  readonly identity: OperationIdentity;
  effectsApplied: boolean;
  submitting: boolean;
  /** A reconciliation request for this operation is being delivered right now. */
  requesting: boolean;
  /** The in-flight hold id while one is in place in the book. */
  holdId: string | null;
  /**
   * A reconciliation request is owed once the executor answers: a terminal
   * answer was refused, or refused evidence was weighed without a request, or
   * the latest request was named before its receipt (WP300C-R2-X1), while the
   * executor call was pending.
   */
  requestOwed: boolean;
  /** Every request issued for this operation: request id → the evidence generation it was issued at. */
  readonly requests: Map<string, number>;
  /**
   * The requests the reconciler has received (its `request` call returned, or
   * is in progress — a synchronous answer): request id → the manager-wide
   * receipt number it was received at. An answer is bound only to one of
   * these, received before the answer's door read began, and never named by
   * an answer whose read began before its receipt (see the header, "REQUEST
   * IDS").
   */
  readonly delivered: Map<string, number>;
  /** The ordinal of the newest request id issued (ids an answer named first are skipped). */
  requestCount: number;
  /** The id of the newest request issued for this operation. */
  latestRequestId: string | null;
  /** The credited amount of the CONFIRMED observation whose deltas were applied. */
  confirmedCredited: DecimalString | null;
  /** Observations kept while the executor call is pending, in arrival order. */
  readonly buffered: Buffered[];
  ordinal: number;
}

/** An observation kept while the executor call is pending (see the header, "OBSERVATIONS DURING SUBMISSION"). */
interface Buffered {
  readonly outcome: Classified;
  /** The keys it was the first to name (admitted on arrival — WP300-R3-01). */
  readonly firstNamed: readonly string[];
}

/**
 * The evidence that sends an operation back to UNKNOWN, weighed there
 * (WP300-R8-01, WP300-R9-01). `firstNamed`: the keys it was the first to name
 * if it was admitted before the weighing. `afterBuffer: false` when it arrived
 * BEFORE the observations still buffered (a buffered observation being
 * applied when it sent the operation back), so the weighing keeps arrival order.
 */
interface Trigger {
  readonly evidence: WeighedEvidence;
  readonly firstNamed: readonly string[];
  readonly afterBuffer: boolean;
}

/** Where an outcome being applied in flight came from (see {@link WalletOperationManager.#applyOutcome}). */
interface Origin {
  /** Whatever identity the raw evidence named (an unrecognised outcome carries none of its own). */
  readonly hints: Identity;
  /** The keys it was the first to name, if they were admitted before it is applied. */
  readonly firstNamed: readonly string[];
  /** It was buffered: what is still buffered arrived after it. */
  readonly fromBuffer: boolean;
}

type Classified =
  | { readonly kind: "NOT_SENT" }
  | { readonly kind: "SUBMITTED"; readonly transactionHash: string | null; readonly transactionId: string | null }
  | { readonly kind: "MINED"; readonly transactionHash: string; readonly transactionId: string | null }
  | {
      readonly kind: "CONFIRMED";
      readonly transactionHash: string;
      readonly transactionId: string | null;
      readonly credited: DecimalString | null;
    }
  | { readonly kind: "FAILED"; readonly transactionHash: string | null; readonly transactionId: string | null }
  | { readonly kind: "UNRECOGNISED"; readonly why: string };

const CREDIT_EVIDENCE_TYPES: readonly WalletOperationType[] = ["REDEEM", "WRAP_COLLATERAL", "UNWRAP_COLLATERAL"];

// ---------------------------------------------------------------- manager --

export class WalletOperationManager {
  readonly #book: InventoryBook;
  readonly #registry: AssetRegistry;
  readonly #approvals: ApprovalTracker;
  readonly #executor: WalletOperationExecutor;
  readonly #reconciler: ReconciliationRequester;
  readonly #operations = new Map<string, Operation>();
  readonly #events: WalletOperationEvent[] = [];
  /**
   * Undelivered requests. `advances: true` marks the request that moves an
   * UNKNOWN operation to RECONCILING once delivered; a plain request only
   * carries more evidence for an operation already under reconciliation.
   */
  readonly #outstandingRequests: { readonly request: ReconciliationRequest; readonly advances: boolean }[] = [];
  /**
   * How many request deliveries are in progress. A request raised while one is
   * (a synchronous requester answering from inside `request()`) is queued, not
   * delivered re-entrantly, so no requester can drive unbounded recursion.
   */
  #delivering = 0;
  /** How many times a request has been received (numbers {@link Operation.delivered}; WP300C-J2). */
  #receipts = 0;
  /**
   * Every request id an answer has named that was not, when it was named, a
   * request the reconciler had received for the operation the answer was
   * addressed to (WP-300c, "REQUEST IDS" in the header). No request is ever
   * issued under one of these ids, and a queued request whose id is named
   * before its delivery is never delivered: it is replaced by a fresh one.
   */
  readonly #namedUnissued = new Set<string>();
  /**
   * Every request id an answer has named that the reconciler had received for
   * the operation only DURING that answer's own read (WP300C-R2-X1, "REQUEST
   * IDS" in the header). No answer is ever bound to one of these ids; one
   * that is an operation's latest request is replaced by a fresh one.
   */
  readonly #namedBeforeReceipt = new Set<string>();
  /** The request-token source (WP300C-J1, "REQUEST IDS" in the header). */
  readonly #requestToken: () => string;
  /** Every token drawn so far: a token drawn twice is a failed draw (it was predictable). */
  readonly #tokensDrawn = new Set<string>();
  /**
   * Request ids built after a failed token draw. Such a request is never
   * delivered (no answer can be bound to it); retry replaces it with a fresh
   * request under a fresh draw.
   */
  readonly #untokened = new Set<string>();

  constructor(deps: WalletOperationManagerDependencies) {
    // WP300C-R2-X5: the source is read once; the check and every draw use that one value.
    const requestToken = deps.requestToken;
    // WP300C-J1: without a token source every request id would be predictable; refused before anything is built.
    if (typeof requestToken !== "function") {
      throw new TypeError("WalletOperationManager needs a requestToken source (a CSPRNG; see the header, REQUEST IDS)");
    }
    this.#book = deps.book;
    this.#registry = deps.book.registry;
    this.#approvals = deps.approvals;
    this.#executor = deps.executor;
    this.#reconciler = deps.reconciler;
    this.#requestToken = requestToken;
  }

  /**
   * Validate a plan, reserve what it will consume (all or nothing), and record
   * it as PLANNED. Nothing is sent.
   */
  plan(input: unknown): InventoryResult<WalletOperationView> {
    const parsed = this.#parsePlan(input);
    if (!parsed.ok) return parsed;
    const plan = parsed.value;
    if (this.#operations.has(plan.operationId)) {
      return refuse("WALLET_OP_DUPLICATE_ID", "wallet operation ids are single-use", {
        operationId: plan.operationId,
      });
    }
    const needs = this.#reservationNeeds(plan);
    if (!needs.ok) return needs;
    const derived = this.#derivedIdentifiers(plan, needs.value.map((need) => need.assetId));
    const tooLong = derived.find((id: string): boolean => !isIdentifier(id));
    if (tooLong !== undefined) {
      // WP300-R2-03: every identifier this operation will hand the book later
      // (reservation, holder, hold, pending debit and credit ids) must be
      // valid NOW, or its confirmation could never be recorded.
      return refuse(
        "INVENTORY_INVALID_INPUT",
        "operationId is too long: an identifier derived from it would exceed the identifier bound",
        { operationId: plan.operationId, derivedLength: tooLong.length, maxLength: MAX_IDENTIFIER_LENGTH },
      );
    }
    const made: { reservationId: string; assetId: string; amount: DecimalString }[] = [];
    for (const need of needs.value) {
      const reservationId = reservationIdOf(plan.operationId, need.assetId);
      const reserved = this.#book.reserve({
        reservationId,
        holderRef: holderRefOf(plan.operationId),
        accountRef: plan.accountRef,
        assetId: need.assetId,
        amount: need.amount,
      });
      if (!reserved.ok) {
        for (const done of made) this.#book.release({ reservationId: done.reservationId });
        return reserved;
      }
      made.push({ reservationId, assetId: need.assetId, amount: need.amount });
    }
    const operation: Operation = {
      plan,
      reservations: Object.freeze(made.map((m) => Object.freeze(m))),
      state: "PLANNED",
      identity: new OperationIdentity(),
      effectsApplied: false,
      submitting: false,
      requesting: false,
      holdId: null,
      requestOwed: false,
      requests: new Map(),
      delivered: new Map(),
      requestCount: 0,
      latestRequestId: null,
      confirmedCredited: null,
      buffered: [],
      ordinal: 0,
    };
    this.#operations.set(plan.operationId, operation);
    this.#record(operation, null, "PLANNED", "planned; reservations held");
    return ok(view(operation));
  }

  /** Hand a PLANNED operation to the executor port. */
  async submit(operationId: string): Promise<InventoryResult<WalletOperationView>> {
    const operation = this.#operations.get(operationId);
    if (operation === undefined) return refuse("WALLET_OP_NOT_FOUND", "no such wallet operation", { operationId });
    if (operation.state !== "PLANNED" || operation.submitting) {
      return refuse("WALLET_OP_ILLEGAL_TRANSITION", "only a PLANNED operation that is not already submitting may be submitted", {
        operationId,
        state: operation.state,
      });
    }
    // From here the operation may leave the process: its lines are in flight.
    // A hold the book refuses is refused here, before anything is sent.
    const held = this.#beginHold(operation);
    if (!held.ok) return held;
    // Claimed synchronously: a concurrent second submit is refused above.
    operation.submitting = true;
    let result: Classified | "THREW";
    let hints: Identity = { transactionHash: null, transactionId: null };
    try {
      const raw = await this.#executor.submit(operation.plan);
      // Read once, at the door; classified and named from that snapshot only (WP-300c).
      const answer = readEvidence(raw, SUBMIT_FIELDS);
      result = classifyEvidence(answer, "submit");
      hints = identityHints(answer);
    } catch {
      result = "THREW";
    }
    operation.submitting = false;
    if (operation.state !== "PLANNED") {
      // Evidence moved the operation while the executor call was pending.
      this.#lateExecutorAnswer(operation, result, hints);
      return ok(view(operation));
    }
    // Any identity the answer names is witnessed, whatever else it says (WP300-R3-01).
    const executorNamed = operation.identity.admit(hints);
    // WP300-R9-01: when observations were buffered meanwhile, an executor answer
    // that is NOT_SENT or unrecognised contradicts them, exactly like a late
    // contradiction: it is weighed with them (as an unrecognised fact). A THROW
    // carries no fact. With nothing buffered there is nothing to contradict:
    // the executor's own uncertainty is the reason for reconciliation, and
    // simple mode stays.
    const contradiction = (): Trigger | null =>
      operation.buffered.length === 0
        ? null
        : { evidence: { kind: "UNRECOGNISED", ...hints, credited: null }, firstNamed: executorNamed, afterBuffer: true };
    if (result === "THREW") {
      this.#toUnknown(operation, `the executor threw; the submission's fate is unknown${this.#bufferedNote(operation)}`);
    } else if (result.kind === "NOT_SENT") {
      if (operation.buffered.length > 0) {
        // Something was observed about this operation while the executor said
        // nothing left the process: conflicting evidence, never assumed.
        this.#toUnknown(operation, `executor: NOT_SENT contradicted${this.#bufferedNote(operation)}`, contradiction());
      } else {
        this.#transition(operation, "FAILED", "executor: NOT_SENT (nothing left the process)");
        this.#releaseAll(operation);
        this.#endHold(operation);
      }
    } else if (result.kind === "SUBMITTED") {
      this.#transition(operation, "SUBMITTED", "executor: SUBMITTED");
      this.#drainBuffer(operation, result, {
        evidence: { kind: "SUBMITTED", transactionHash: result.transactionHash, transactionId: result.transactionId, credited: null },
        firstNamed: executorNamed,
        afterBuffer: true,
      });
    } else {
      this.#toUnknown(
        operation,
        `unrecognised executor result: ${result.kind === "UNRECOGNISED" ? result.why : result.kind}${this.#bufferedNote(operation)}`,
        contradiction(),
      );
    }
    return ok(view(operation));
  }

  /**
   * Apply a lifecycle observation (the SDK transaction's `wait()` outcome, a
   * relayer or chain read) to a SUBMITTED or MINED operation. Unrecognised or
   * under-evidenced observations move it to UNKNOWN. The observation is read
   * once, here, and decided on that snapshot; a field that is present but not
   * own data makes it unrecognised (see the header, "EVIDENCE AT THE DOOR").
   */
  observe(operationId: string, observation: unknown): InventoryResult<WalletOperationView> {
    // Read once, at the door, before anything is decided (see the header, "EVIDENCE AT THE DOOR").
    const evidence = readEvidence(observation, OBSERVATION_FIELDS);
    const operation = this.#operations.get(operationId);
    if (operation === undefined) return refuse("WALLET_OP_NOT_FOUND", "no such wallet operation", { operationId });
    return this.#observeEvidence(operation, evidence, "observation");
  }

  /**
   * Resolve a RECONCILING operation from an authoritative read (§9.17 step 4),
   * or recover a quarantined terminal one. Evidence must carry `source:
   * "AUTHORITATIVE_READ"`, a recognised state, and (optionally) the
   * `requestId` of the request it answers, each as an own data property; it
   * is refused if that request was issued before evidence that supersedes it
   * (see the header, "RECONCILIATION ANSWERS"), or if the reconciler had not
   * received it before the read of an answer naming it began ("REQUEST IDS").
   * The evidence is read once, here, and decided on that snapshot ("EVIDENCE
   * AT THE DOOR"): a field that is present but not own data makes it
   * unrecognised. The code returned for every state and
   * shape is the header's REFUSAL CODES table. A CONFIRMED resolution
   * releases the reservations and blocks the affected lines until an
   * authoritative balance observation (the reconciler's read already reflects
   * the operation, so its deltas are not re-applied).
   *
   * WP300-R7-X1: evidence this method does not RECORD as a resolution is never
   * thrown away once the operation has been handed to the executor, and the
   * call still returns the refusal. Outside flight it is handled exactly as the
   * same fact delivered through {@link observe} would be: weighed against the
   * whole identity set (contesting what it contradicts, admitting what it
   * names, requiring every member by name, quarantining after a terminal
   * state). In flight, a current answer is applied as the same observation
   * would be (and if that sends the operation back to UNKNOWN, it is weighed
   * there — WP300-R9-01); a superseded terminal answer, or one naming a
   * request it cannot be bound to (see REQUEST IDS), authoritative or not
   * (WP300-R9-03), is not applied — it sends the operation back to
   * reconciliation and is weighed there like the same observation outside
   * flight, before the request is delivered (WP300-R8-01). The same holds while the executor call
   * is pending and the operation is still PLANNED (WP300-R10-01): a current
   * answer (one naming no request) is kept like the same observation, and a
   * terminal answer (CONFIRMED or FAILED as the observation classifier reads
   * it) naming any request (none has been issued for the operation yet) or
   * superseded is refused (`WALLET_OP_EVIDENCE_SUPERSEDED`) and never kept —
   * it sends the operation to reconciliation and is weighed there, with
   * whatever was buffered. In flight and while PLANNED, an answer the
   * classifier does not recognise — a terminal state included (CONFIRMED with
   * no hash, a malformed identity or credited amount, a field that is not own
   * data) — is refused `WALLET_OP_ILLEGAL_TRANSITION` and handled as the
   * unrecognised observation it is: it sends the operation to reconciliation
   * and concludes nothing (WP300B-R1-03). Before submission an answer is
   * refused (`WALLET_OP_ILLEGAL_TRANSITION`) and changes nothing about the
   * operation (the request id it names is recorded, as everywhere). The one
   * exception is an authoritative answer that repeats, for every member it
   * names, what the authority already said and still stands: it carries no
   * new fact.
   */
  resolveByReconciliation(operationId: string, evidence: unknown): InventoryResult<WalletOperationView> {
    // WP300B-R1-01: every field is read exactly once, here, before anything is
    // decided; #answer and the observation route both decide on this snapshot.
    // WP300C-J2: the binding is settled the moment `requestId` is read, before
    // any later field is (see the header, "REQUEST IDS").
    const readFrom = this.#receipts;
    const answer = readAnswer(evidence, (named) => this.#bindNamedRequest(operationId, named, readFrom));
    const operation = this.#operations.get(operationId);
    if (operation === undefined) return refuse("WALLET_OP_NOT_FOUND", "no such wallet operation", { operationId });
    const answered = this.#answer(operation, answer);
    if (answered.weigh) this.#observeEvidence(operation, answer.observation, "answer");
    // WP300C-R2-X1: never leave the reconciler holding only a request no answer can be bound to.
    this.#replaceNamedBeforeReceipt(operation);
    return answered.result;
  }

  /**
   * Settle an answer's binding the moment its `requestId` (a string) is read
   * at the door, before any later field is read (WP300C-J2; see the header,
   * "REQUEST IDS"). True only if the reconciler had received a request under
   * that id, for the operation the answer is addressed to, before the door
   * read began (`readFrom`: the receipt count then), and no earlier answer
   * named it before ITS read had seen it received. An id no request received
   * carries is recorded, and no request is ever issued under it; an id
   * received only during this answer's read is recorded, and no answer is
   * ever bound to it (WP300C-R2-X1).
   */
  #bindNamedRequest(operationId: string, named: string, readFrom: number): boolean {
    const receivedAt = this.#operations.get(operationId)?.delivered.get(named);
    if (receivedAt === undefined) {
      this.#namedUnissued.add(named);
      return false;
    }
    if (receivedAt > readFrom) {
      // Received DURING this answer's own read (a trap called back into the manager, which delivered it): the
      // fields read before it predate the request, so the answer is not a read made after receiving it. Recorded:
      // a later answer naming it (a verbatim replay included) is refused too (WP300C-R2-X1).
      this.#namedBeforeReceipt.add(named);
      return false;
    }
    return !this.#namedBeforeReceipt.has(named);
  }

  /**
   * WP300C-R2-X1: an answer named the operation's LATEST request although the
   * reconciler received it only during that answer's own read, so no answer is
   * ever bound to it. While the operation still awaits an answer — under
   * reconciliation, or terminal and quarantined; never in flight, nor terminal
   * without a quarantine (WP300C-R3-02) — a fresh request replaces it: sent
   * now, or queued if it cannot be delivered now (the reconciler refused it,
   * its token draw failed, or this runs inside another request's delivery,
   * never re-entered), and delivered by retry (after a failed draw, retry
   * sends a fresh request in its place; WP300C-R3-01). While the executor
   * call is pending, the request is owed instead, and sent when the executor
   * answers (WP300-R7-X1). So the reconciler always holds a request it can
   * answer, or is handed one by retry. (If the answer's own weighing already
   * raised a newer request, there is nothing to replace.)
   */
  #replaceNamedBeforeReceipt(operation: Operation): void {
    const latest = operation.latestRequestId;
    if (latest === null || !this.#namedBeforeReceipt.has(latest)) return;
    const terminal = isTerminalState(operation.state);
    if (terminal ? unresolvedKeys(operation).length === 0 : operation.state !== "RECONCILING") return;
    if (!terminal && operation.submitting) {
      operation.requestOwed = true;
      return;
    }
    const reason =
      "the latest reconciliation request was named by an answer before that answer's read had seen it received (it was delivered during the read); no answer is bound to it, and this request replaces it";
    this.#deliverOrQueue(
      terminal
        ? this.#requestFor(operation, "POSITION_BALANCE_DISCREPANCY", `${reason}; the lines stay quarantined`)
        : this.#requestFor(operation, WALLET_OPERATION_UNKNOWN_TRIGGER, reason),
    );
  }

  /**
   * One piece of evidence about an operation, from an observation or from
   * reconciliation evidence that was not recorded as a resolution (WP300-R7-X1:
   * both are handled alike). `observation` is the snapshot read at the door
   * (WP-300c): it is classified and named once, here, from that snapshot.
   */
  #observeEvidence(
    operation: Operation,
    observation: Evidence,
    from: "observation" | "answer",
  ): InventoryResult<WalletOperationView> {
    const operationId = operation.plan.operationId;
    const hints = identityHints(observation);
    const classified = classifyEvidence(observation, "observation");
    if (operation.state === "PLANNED" && operation.submitting) {
      // Witnessed on arrival: the identity survives whatever happens to the
      // buffer (WP300-R3-01).
      const firstNamed = operation.identity.admit(hints);
      if (classified.kind === "UNRECOGNISED") {
        // Uncertainty is acted on now, not when (or if) the executor answers;
        // it is weighed there, with whatever was buffered (WP300-R9-01).
        this.#toUnknown(
          operation,
          `unrecognised observation during submission: ${classified.why}${this.#bufferedNote(operation)}`,
          { evidence: { kind: "UNRECOGNISED", ...hints, credited: null }, firstNamed, afterBuffer: true },
        );
        return ok(view(operation));
      }
      // The executor has not answered yet; the observation is kept, classified
      // now, and applied once it does — or weighed, if the operation goes back
      // to reconciliation first (see the header). Reconciliation evidence
      // reaches this point only when it is current (it names no request) or not
      // terminal: #answer has already sent a terminal answer naming a request,
      // or a superseded one, to reconciliation (WP300-R10-01).
      operation.buffered.push({ outcome: classified, firstNamed });
      return ok(view(operation));
    }
    if (operation.state !== "SUBMITTED" && operation.state !== "MINED") {
      // Refused as a transition, never dropped: weighed against the whole identity set (WP300-R6).
      // The exception is a PLANNED operation not yet handed to the executor (the
      // pending case is handled above): nothing has left the process, and the
      // evidence changes nothing.
      if (operation.state !== "PLANNED") {
        this.#weighOutsideFlight(
          operation,
          weighedEvidence(classified, hints),
          from === "observation" ? "an observation" : "reconciliation evidence not recorded as a resolution",
          // WP300-R7-X1: while the executor call is pending, weighed reconciliation
          // evidence raises no request (the executor's answer sends the one owed).
          from === "answer" && operation.submitting,
        );
      }
      return refuse(
        "WALLET_OP_ILLEGAL_TRANSITION",
        "observations apply only to SUBMITTED or MINED operations; UNKNOWN/RECONCILING resolve only by reconciliation",
        { operationId, state: operation.state },
      );
    }
    if ((classified.kind === "FAILED" || classified.kind === "CONFIRMED") && operation.submitting) {
      // WP300-R3-02: nothing concludes while the executor call is pending (its
      // answer may name another transaction). A consistent terminal outcome is
      // kept and weighed with the executor's answer; a conflicting one is
      // conflicting evidence now.
      const conflict = operation.identity.fieldConflict(classified);
      const firstNamed = operation.identity.admit(classified);
      if (conflict !== null) {
        this.#toUnknown(operation, `observation: ${classified.kind} under a different ${conflict}; conflicting evidence is never assumed`, {
          evidence: weighedOf(classified, hints),
          firstNamed,
          afterBuffer: true,
        });
        return ok(view(operation));
      }
      operation.buffered.push({ outcome: classified, firstNamed });
      return ok(view(operation));
    }
    const firstNamed = classified.kind === "UNRECOGNISED" ? operation.identity.admit(hints) : [];
    this.#applyOutcome(operation, classified, from === "observation" ? "observation" : "reconciliation evidence (handled as an observation)", {
      hints,
      firstNamed,
      fromBuffer: false,
    });
    return ok(view(operation));
  }

  /**
   * Decide whether reconciliation evidence is RECORDED as a resolution (see
   * {@link resolveByReconciliation}). `weigh` says whether a refused piece is
   * then handled as an observation. Everything here is decided on `answer`,
   * the snapshot read at the door (WP300B-R1-01): the evidence is never read
   * again.
   */
  #answer(operation: Operation, answer: Answer): Answered {
    const operationId = operation.plan.operationId;
    const authoritative = answer.authoritative;
    const state = answer.state;
    // The answer as the observation of the same fact: its state is the status. An
    // answer with a field that is not own data is unrecognised (WP300B-R1-02).
    const classified = classifyEvidence(answer.observation, "observation");
    const outcome: TerminalOutcome | null =
      classified.kind === "FAILED" || classified.kind === "CONFIRMED" ? classified.kind : null;
    const identity: IdentityValues =
      classified.kind === "NOT_SENT" || classified.kind === "UNRECOGNISED"
        ? { transactionHash: null, transactionId: null }
        : { transactionHash: classified.transactionHash, transactionId: classified.transactionId };
    // A repeat of what the authority already said, and still stands, carries no new fact.
    const repeat =
      authoritative &&
      outcome !== null &&
      operation.identity.isAuthoritativeRepeat(
        outcome,
        identity,
        classified.kind === "CONFIRMED" ? classified.credited : null,
        operation.confirmedCredited,
      );
    const refused = (
      code: InventoryRefusalCode,
      message: string,
      details: Readonly<Record<string, EvidenceValue>> = {},
    ): Answered => ({ result: refuse(code, message, { operationId, ...details }), weigh: !repeat });
    const unresolvedNow = (): string => unresolvedKeys(operation).join(",");

    const terminalState = isTerminalState(operation.state);
    if (terminalState && unresolvedKeys(operation).length === 0) {
      // WP300-R4-01: the recovery path exists only for a contested terminal outcome.
      return refused(
        "WALLET_OP_ILLEGAL_TRANSITION",
        "a terminal operation is resolved by reconciliation only while its outcome is contested (quarantined); the evidence is weighed like an observation",
        { state: operation.state },
      );
    }
    // An UNKNOWN operation whose reconciliation request is being delivered
    // right now is ready for the answer (a synchronous requester).
    const answeringRequest = operation.state === "UNKNOWN" && operation.requesting;
    // WP300-R7-X3: the request the answer reports a read for (none named: before any evidence was weighed).
    // WP-300c: bound only to a request the reconciler had received before the door read began (WP300C-J2), and
    // that no answer named before its read had seen it received (WP300C-R2-X1);
    // a `requestId` that is present but not own data is never "none named" (WP300B-R1-02: such an answer is
    // unrecognised above, and never current).
    const binding = answer.binding.kind === "NAMED" ? answer.binding.value : undefined;
    const issuedAt =
      answer.binding.kind === "NONE"
        ? 0
        : answer.binding.kind === "NAMED" && answer.binding.received && typeof binding === "string"
          ? operation.requests.get(binding)
          : undefined;
    if (!terminalState && operation.state !== "RECONCILING" && !answeringRequest) {
      const inFlight = operation.state === "SUBMITTED" || operation.state === "MINED";
      // WP300-R10-01: the executor call is pending and the operation has not left
      // PLANNED. No reconciliation request has been issued for it yet, so an
      // answer naming any request names one not issued for this operation.
      const pendingPlanned = operation.state === "PLANNED" && operation.submitting;
      if (outcome !== null && (inFlight || pendingPlanned)) {
        // In flight a refused answer is applied like an observation, and while
        // the executor call is pending (still PLANNED) it is kept like one —
        // unless it is a TERMINAL answer that is superseded (or names a request
        // not issued for this operation), authoritative or not (WP300-R9-03,
        // WP300-R10-01): such a read never concludes anything, and is never kept
        // to be applied later. It sends the operation to reconciliation instead
        // (nothing applied or released) and, once the operation is out of
        // flight / out of PLANNED, it is WEIGHED like the same observation would
        // be there (WP300-R8-01): it admits what it names, contests what it
        // contradicts, and requires every member by name — all before the
        // reconciliation request is delivered (see #toUnknown), and together
        // with every observation still buffered.
        const superseded =
          issuedAt === undefined
            ? "a reconciliation request the reconciler had not received for this operation when the read of an answer naming it began"
            : operation.identity.supersededFor(outcome, identity, issuedAt);
        if (superseded !== null) {
          const where = inFlight ? "in flight" : "while the executor call was pending";
          this.#toUnknown(
            operation,
            `a superseded ${outcome} reconciliation answer arrived ${where} (${superseded}); it is weighed against the whole identity set, nothing is assumed${this.#bufferedNote(operation)}`,
            { evidence: weighedEvidence(classified, identityHints(answer.observation)), firstNamed: [], afterBuffer: true },
          );
          return {
            result: refuse(
              "WALLET_OP_EVIDENCE_SUPERSEDED",
              inFlight
                ? "a superseded answer arrived in flight; the operation is under reconciliation again and the answer is weighed"
                : "a superseded answer arrived while the executor call was pending; the operation is under reconciliation and the answer is weighed",
              { operationId, supersededBy: superseded },
            ),
            // Already weighed (above), before the request was delivered.
            weigh: false,
          };
        }
      }
      return refused(
        "WALLET_OP_ILLEGAL_TRANSITION",
        "only a RECONCILING operation is resolved by reconciliation; the evidence is handled like an observation",
        { state: operation.state },
      );
    }
    if (!authoritative) {
      return refused("WALLET_OP_EVIDENCE_REQUIRED", "reconciliation evidence must be an authoritative read");
    }
    if (classified.kind === "NOT_SENT" || classified.kind === "UNRECOGNISED") {
      return refused("WALLET_OP_EVIDENCE_REQUIRED", "evidence is inconclusive; the operation stays under reconciliation", {
        state: typeof state === "string" ? state : null,
      });
    }
    if (terminalState && outcome === null) {
      return refused(
        "WALLET_OP_EVIDENCE_REQUIRED",
        "a contested terminal outcome is released only by a terminal authoritative answer (CONFIRMED or FAILED) per transaction; the quarantine stays",
        { state: typeof state === "string" ? state : null, unresolved: unresolvedNow() },
      );
    }
    if (outcome === null && operation.identity.requiresEveryKey()) {
      // WP300-R3-01, WP300-R6: the whole identity set is answered by name, terminally.
      return refused(
        "WALLET_OP_EVIDENCE_REQUIRED",
        "every transaction of this operation must be resolved terminally (CONFIRMED or FAILED) by name",
        { unresolved: unresolvedNow() },
      );
    }
    // WP300-R7-X3: the answer is bound to the request it answers.
    if (issuedAt === undefined) {
      return refused(
        "WALLET_OP_EVIDENCE_REQUIRED",
        "the evidence names a reconciliation request the reconciler had not received for this operation when the read of an answer naming it began (never issued for it, issued but not delivered by then, or delivered only during that answer's own read); no answer is bound to it",
        { requestId: typeof binding === "string" ? binding : null },
      );
    }
    const superseded = operation.identity.supersededFor(outcome ?? "IN_FLIGHT", identity, issuedAt);
    if (superseded !== null) {
      return refused(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
        "the answer reports a read made for a request issued before evidence that supersedes it; answer the latest request",
        { supersededBy: superseded, unresolved: unresolvedNow() },
      );
    }
    const conflict = operation.identity.fieldConflict(identity);
    if (conflict !== null) {
      return refused(
        "WALLET_OP_EVIDENCE_CONFLICT",
        terminalState
          ? "reconciliation evidence names a transaction no evidence has named for this operation; the quarantine stays"
          : "reconciliation evidence names a transaction no evidence has named for this operation; the operation stays under reconciliation and its holds stay",
        { field: conflict },
      );
    }
    if (terminalState && outcome !== null) return this.#resolveQuarantine(operation, outcome, identity, repeat);
    if (outcome !== null && operation.submitting) {
      // WP300-R3-02: the executor's answer may still name another transaction;
      // no conclusion (release, recognition) before it has answered.
      operation.requestOwed = true;
      return refused(
        "WALLET_OP_EVIDENCE_REQUIRED",
        `a ${outcome} resolution is not accepted while the executor call is pending; the reconciler is asked again once it answers`,
      );
    }
    if (outcome !== null && operation.identity.requiresEveryKey()) {
      // WP300-R3-01, WP300-R6: the whole identity set is answered by name;
      // nothing is released before every member stands.
      const checked = operation.identity.checkAnswer(outcome, identity);
      if (!checked.ok) return { result: answerRefusal(operationId, checked, unresolvedKeys(operation)), weigh: !repeat };
      if (answeringRequest) this.#transition(operation, "RECONCILING", "reconciliation requested (answered synchronously)");
      operation.identity.recordAnswer(outcome, identity, checked.keys);
      if (unresolvedKeys(operation).length > 0) return { result: ok(view(operation)), weigh: false };
      this.#concludeByReconciliation(operation, operation.identity.anyConfirmed() ? "CONFIRMED" : "FAILED");
      return { result: ok(view(operation)), weigh: false };
    }
    // One identity, nothing weighed under reconciliation: one answer naming the
    // operation's transaction (any member of the set, or nothing if the set is
    // empty) concludes — the simple-mode pairing the header discloses.
    const members = operation.identity.keys();
    if (members.length > 0 && !identityKeys(identity).some((key) => members.includes(key))) {
      return refused("WALLET_OP_EVIDENCE_REQUIRED", "the evidence must name the operation's transaction", {
        transactions: members.join(","),
      });
    }
    if (answeringRequest) this.#transition(operation, "RECONCILING", "reconciliation requested (answered synchronously)");
    if (outcome === null) {
      operation.identity.admit(identity);
      this.#transition(operation, classified.kind === "MINED" ? "MINED" : "SUBMITTED", "reconciliation: still in flight");
      return { result: ok(view(operation)), weigh: false };
    }
    operation.identity.recordAnswer(outcome, identity, identityKeys(identity));
    this.#concludeByReconciliation(operation, outcome);
    return { result: ok(view(operation)), weigh: false };
  }

  /**
   * Retry reconciliation requests the requester refused earlier. A queued
   * request that a newer request for the same operation supersedes is never
   * delivered late (WP300-R7-X3: answers to it could only be superseded): it
   * is dropped, or, if it would still move an UNKNOWN operation to
   * RECONCILING, re-issued as a fresh request.
   */
  retryReconciliationRequests(): number {
    if (this.#delivering > 0) return 0; // never re-entrantly (see #delivering)
    const pending = this.#outstandingRequests.splice(0);
    let delivered = 0;
    for (const { request, advances } of pending) {
      const operation = this.#operations.get(request.walletOperationId);
      // WP-300c: a queued request whose id an answer named before the reconciler
      // received it is never delivered under that id (an answer may already
      // claim it), nor is one built after a failed token draw (WP300C-J1); like
      // a superseded one, it is replaced by a fresh request (a fresh draw) when
      // it still has to be sent (see the header, "REQUEST IDS").
      const replace = this.#namedUnissued.has(request.requestId) || this.#untokened.has(request.requestId);
      if (operation !== undefined && (replace || request.requestId !== operation.latestRequestId)) {
        if (advances && operation.state === "UNKNOWN") {
          const fresh = this.#requestFor(operation, request.trigger, request.reason);
          if (this.#requestReconciliation(operation, fresh, "reconciliation requested (retry)")) delivered += 1;
        } else if (!advances && request.requestId === operation.latestRequestId) {
          if (this.#deliverOrQueue(this.#requestFor(operation, request.trigger, request.reason))) delivered += 1;
        }
        continue;
      }
      if (advances && operation !== undefined) {
        if (operation.state !== "UNKNOWN") continue; // already answered
        if (this.#requestReconciliation(operation, request, "reconciliation requested (retry)")) delivered += 1;
        continue;
      }
      if (this.#deliver(request)) delivered += 1;
      else this.#outstandingRequests.push({ request, advances: false });
    }
    return delivered;
  }

  operation(operationId: string): WalletOperationView | undefined {
    const operation = this.#operations.get(operationId);
    return operation === undefined ? undefined : view(operation);
  }

  events(operationId?: string): readonly WalletOperationEvent[] {
    return Object.freeze(
      operationId === undefined ? [...this.#events] : this.#events.filter((e) => e.operationId === operationId),
    );
  }

  outstandingReconciliationRequests(): readonly ReconciliationRequest[] {
    return Object.freeze(this.#outstandingRequests.map((entry) => entry.request));
  }

  // -------------------------------------------------------------- internal --

  /**
   * Apply an outcome to an operation in flight. Whatever sends the operation
   * back to UNKNOWN here is weighed there, exactly as the same fact observed
   * one step later would be (WP300-R9-01).
   */
  #applyOutcome(operation: Operation, outcome: Classified, via: string, origin: Origin): void {
    let firstNamed = origin.firstNamed;
    const back = (reason: string): void =>
      this.#toUnknown(operation, reason, {
        evidence: weighedOf(outcome, origin.hints),
        firstNamed,
        afterBuffer: !origin.fromBuffer,
      });
    if (outcome.kind === "SUBMITTED" || outcome.kind === "MINED" || outcome.kind === "CONFIRMED" || outcome.kind === "FAILED") {
      const conflict = operation.identity.fieldConflict(outcome);
      // Witnessed even when it conflicts: the conflict stays explicit (WP300-R3-01).
      firstNamed = [...firstNamed, ...operation.identity.admit(outcome)];
      if (conflict !== null) {
        back(`${via}: ${outcome.kind} under a different ${conflict}; conflicting evidence is never assumed`);
        return;
      }
    }
    switch (outcome.kind) {
      case "MINED":
        // A repeated MINED report (same identity, checked above) changes nothing.
        if (operation.state !== "MINED") this.#transition(operation, "MINED", `${via}: MINED`);
        return;
      case "SUBMITTED":
        // A repeated SUBMITTED report changes nothing; after MINED it is a regression.
        if (operation.state !== "SUBMITTED") {
          back(`${via}: SUBMITTED after MINED`);
          return;
        }
        return;
      case "FAILED":
        this.#transition(operation, "FAILED", `${via}: FAILED`);
        this.#releaseAll(operation);
        this.#endHold(operation);
        return;
      case "CONFIRMED": {
        const needsCredit = CREDIT_EVIDENCE_TYPES.includes(operation.plan.type);
        if (needsCredit && outcome.credited === null) {
          back(`${via}: CONFIRMED without the observed credited amount; not assumed`);
          return;
        }
        this.#transition(operation, "CONFIRMED", `${via}: CONFIRMED`);
        operation.confirmedCredited = outcome.credited;
        this.#recordApprovalIfAny(operation);
        if (!this.#applyConfirmedDeltas(operation, outcome.credited)) {
          // Defensive: while the operation is in flight its lines refuse
          // balance reads, so its debits should always fit.
          this.#releaseAll(operation);
          this.#awaitObservation(operation);
          this.#endHold(operation);
          this.#deliverOrQueue(
            this.#requestFor(
              operation,
              "POSITION_BALANCE_DISCREPANCY",
              "confirmed wallet operation's deltas do not fit the book; lines await an authoritative read",
            ),
          );
          return;
        }
        this.#endHold(operation);
        return;
      }
      default:
        back(`unrecognised ${via}: ${outcome.kind === "UNRECOGNISED" ? outcome.why : outcome.kind}`);
    }
  }

  /** Apply a confirmed operation's balance deltas. False (and nothing applied) if they do not fit. */
  #applyConfirmedDeltas(operation: Operation, credited: DecimalString | null): boolean {
    const plan = operation.plan;
    const credits: { assetId: string; amount: DecimalString }[] = [];
    switch (plan.type) {
      case "SPLIT": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair === undefined) return false;
        credits.push({ assetId: pair.yesAssetId, amount: plan.amount }, { assetId: pair.noAssetId, amount: plan.amount });
        break;
      }
      case "MERGE":
        credits.push({ assetId: this.#registry.pusdAssetId, amount: plan.amount });
        break;
      case "REDEEM":
      case "WRAP_COLLATERAL":
        if (credited !== null && compareDecimal(credited, "0") > 0) {
          credits.push({ assetId: this.#registry.pusdAssetId, amount: credited });
        }
        break;
      case "UNWRAP_COLLATERAL": {
        const usdcE = this.#registry.usdcEAssetId;
        if (usdcE === null) return false;
        if (credited !== null && compareDecimal(credited, "0") > 0) credits.push({ assetId: usdcE, amount: credited });
        break;
      }
      default:
        break;
    }
    // Pre-check every step the book will be asked to take: all or nothing.
    // A step the book would refuse (a debit that does not fit, a reservation
    // no longer ACTIVE for its full amount, a pending id already taken) sends
    // the confirmation down the recovery path instead of throwing (WP300-R2-03).
    for (const r of operation.reservations) {
      const line = this.#book.line(plan.accountRef, r.assetId);
      if (line === undefined || compareDecimal(line.actual, r.amount) < 0) return false;
      const reservation = this.#book.reservation(r.reservationId);
      if (reservation?.status !== "ACTIVE" || compareDecimal(reservation.remaining, r.amount) !== 0) return false;
      if (!this.#book.isPendingIdAvailable(debitPendingIdOf(r.reservationId))) return false;
    }
    for (const credit of credits) {
      if (!this.#book.isPendingIdAvailable(creditPendingIdOf(plan.operationId, credit.assetId))) return false;
    }
    for (const r of operation.reservations) {
      const pendingId = debitPendingIdOf(r.reservationId);
      const consumed = this.#book.consume({ reservationId: r.reservationId, amount: r.amount, pendingId });
      if (!consumed.ok) throw new Error(`wallet-operation invariant: consume refused (${consumed.refusal.code})`);
      const settled = this.#book.settlePending({ pendingId, settlement: "APPLIED" });
      if (!settled.ok) throw new Error(`wallet-operation invariant: settle refused (${settled.refusal.code})`);
    }
    for (const credit of credits) {
      const pendingId = creditPendingIdOf(plan.operationId, credit.assetId);
      const expected = this.#book.expectInflow({
        pendingId,
        accountRef: plan.accountRef,
        assetId: credit.assetId,
        amount: credit.amount,
      });
      if (!expected.ok) throw new Error(`wallet-operation invariant: inflow refused (${expected.refusal.code})`);
      const settled = this.#book.settlePending({ pendingId, settlement: "APPLIED" });
      if (!settled.ok) throw new Error(`wallet-operation invariant: settle refused (${settled.refusal.code})`);
    }
    operation.effectsApplied = true;
    return true;
  }

  #recordApprovalIfAny(operation: Operation): void {
    const plan = operation.plan;
    if (plan.type === "APPROVE_ERC20") {
      this.#approvals.recordConfirmedApproval({
        accountRef: plan.accountRef,
        standard: "ERC20",
        assetId: plan.assetId,
        spender: plan.spender,
        walletOperationId: plan.operationId,
      });
      operation.effectsApplied = true;
    } else if (plan.type === "APPROVE_ERC1155") {
      this.#approvals.recordConfirmedApproval({
        accountRef: plan.accountRef,
        standard: "ERC1155",
        assetId: null,
        spender: plan.spender,
        walletOperationId: plan.operationId,
      });
      operation.effectsApplied = true;
    }
  }

  #awaitObservation(operation: Operation): void {
    for (const assetId of this.#touchedAssets(operation)) {
      this.#book.requireObservation(operation.plan.accountRef, assetId);
    }
  }

  #touchedAssets(operation: Operation): readonly string[] {
    return this.#touchedAssetsOf(
      operation.plan,
      operation.reservations.map((r) => r.assetId),
    );
  }

  #touchedAssetsOf(plan: WalletOperationPlan, reservedAssetIds: readonly string[]): readonly string[] {
    const assets = new Set(reservedAssetIds);
    switch (plan.type) {
      case "SPLIT": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair !== undefined) {
          assets.add(pair.yesAssetId);
          assets.add(pair.noAssetId);
        }
        break;
      }
      case "MERGE":
      case "REDEEM":
      case "WRAP_COLLATERAL":
        assets.add(this.#registry.pusdAssetId);
        break;
      case "UNWRAP_COLLATERAL":
        if (this.#registry.usdcEAssetId !== null) assets.add(this.#registry.usdcEAssetId);
        break;
      default:
        break;
    }
    return [...assets];
  }

  #releaseAll(operation: Operation): void {
    for (const r of operation.reservations) {
      if (this.#book.reservation(r.reservationId)?.status === "ACTIVE") {
        this.#book.release({ reservationId: r.reservationId });
      }
    }
  }

  /**
   * Move the operation to UNKNOWN and request reconciliation. Every piece of
   * evidence that goes with it is weighed against the whole identity set HERE,
   * after the transition and BEFORE the request is built and delivered, so the
   * request carries every obligation it creates and a requester that answers
   * synchronously, inside the call, already meets them (WP300-R8-01):
   * - `trigger`, the evidence that sent the operation back, if it is a claim
   *   (an observation or answer, or the executor contradicting what was
   *   buffered); it is weighed exactly as the same fact observed one step
   *   later would be (WP300-R9-01);
   * - every observation still buffered (received while the executor call was
   *   pending): none is applied, and none is thrown away (WP300-R9-01).
   * They are weighed in arrival order. What none of them concerns is not
   * marked: an answer that echoes no request stays current for it (see the
   * header, "RECONCILIATION ANSWERS").
   */
  #toUnknown(operation: Operation, reason: string, trigger: Trigger | null = null): void {
    // WP300-R7-X3: re-entering reconciliation after a request was issued — the
    // evidence that sent the operation back is newer than any earlier read.
    if (operation.requestCount > 0) operation.identity.supersedeEverything();
    this.#transition(operation, "UNKNOWN", reason);
    const discarded = operation.buffered.splice(0).map(
      (kept): Trigger => ({ evidence: weighedOf(kept.outcome, identityOf(kept.outcome)), firstNamed: kept.firstNamed, afterBuffer: true }),
    );
    const weighed = trigger === null ? discarded : trigger.afterBuffer ? [...discarded, trigger] : [trigger, ...discarded];
    for (const item of weighed) this.#weighUnderReconciliation(operation, item.evidence, item.firstNamed);
    this.#requestReconciliation(
      operation,
      this.#requestFor(operation, WALLET_OPERATION_UNKNOWN_TRIGGER, reason),
      "reconciliation requested",
    );
  }

  /** Reconciliation reached a terminal conclusion (the executor call is not pending). */
  #concludeByReconciliation(operation: Operation, kind: "FAILED" | "CONFIRMED"): void {
    if (kind === "FAILED") {
      this.#transition(operation, "FAILED", "reconciliation: FAILED");
      this.#releaseAll(operation);
      this.#endHold(operation);
      return;
    }
    this.#transition(operation, "CONFIRMED", "reconciliation: CONFIRMED");
    this.#recordApprovalIfAny(operation);
    this.#releaseAll(operation);
    this.#awaitObservation(operation);
    this.#endHold(operation);
  }

  /**
   * Apply the observations buffered while the executor call was pending, now
   * that it has answered consistently. The whole buffer is checked first:
   * conflicting identities, or anything after a terminal observation other
   * than an exact repeat, send the operation to UNKNOWN with nothing applied
   * (every buffered observation, and `executorAnswer`, weighed there).
   */
  #drainBuffer(operation: Operation, seed: Identity, executorAnswer: Trigger): void {
    const conflict = operation.identity.isConflicted()
      ? "more than one transaction has been named"
      : bufferConflict(
          seed,
          operation.buffered.map((kept) => kept.outcome),
        );
    if (conflict !== null) {
      // Nothing buffered is applied: conflicting evidence goes to reconciliation
      // whole, where every buffered observation is weighed — and so is the
      // executor's answer, which arrived after them and is one side of the
      // conflict (WP300-R9-01).
      this.#toUnknown(
        operation,
        `observations received during submission conflict (${conflict})${this.#bufferedNote(operation)}`,
        executorAnswer,
      );
      return;
    }
    // Applied one at a time, in arrival order. Re-read the state: each applied
    // outcome may have moved it. If one sends the operation back to UNKNOWN, it
    // and every observation still buffered are weighed there (#toUnknown).
    while (operation.buffered.length > 0) {
      const current: WalletOperationState = stateOf(operation);
      if (current !== "SUBMITTED" && current !== "MINED") break;
      const kept = operation.buffered.shift();
      if (kept === undefined) break;
      this.#applyOutcome(operation, kept.outcome, "observation (received during submission)", {
        hints: identityOf(kept.outcome),
        firstNamed: kept.firstNamed,
        fromBuffer: true,
      });
    }
    // After a conclusion, whatever is left repeats it exactly (checked above).
    operation.buffered.length = 0;
  }

  /**
   * Evidence about an operation outside flight (UNKNOWN, RECONCILING,
   * CONFIRMED, FAILED), weighed against the WHOLE identity set —
   * contradictions first, then admission (see the header, "EVIDENCE OUTSIDE
   * FLIGHT"). Whatever it leaves unresolved that was not before is acted on:
   * a fresh reconciliation request before the conclusion, a quarantine after
   * it.
   */
  #weighOutsideFlight(operation: Operation, evidence: WeighedEvidence, what: string, deferRequest = false): void {
    const terminal = isTerminalState(operation.state);
    const before = new Set(unresolvedKeys(operation));
    const weighed = this.#weighUnderReconciliation(operation, evidence);
    const unresolved = unresolvedKeys(operation);
    const opened = unresolved.filter((key) => !before.has(key));
    // WP300-R7-X3: evidence that supersedes reads made for earlier requests
    // needs a request that a current answer can name — always before the
    // conclusion, and after it while anything is unresolved (quarantined).
    const superseding = weighed.marked && (!terminal || unresolved.length > 0);
    if (opened.length === 0 && !superseding) return; // nothing new to resolve: an outstanding request covers it
    const changes = [
      weighed.setAside.length > 0 ? `sets aside the outcome standing under ${weighed.setAside.join(",")}` : null,
      weighed.admitted.length > 0 ? `names ${weighed.admitted.join(",")} for the first time` : null,
    ].filter((part): part is string => part !== null);
    const reason = `${what} (${evidence.kind}) ${changes.length > 0 ? changes.join(" and ") : opened.length > 0 ? "must be resolved by name" : "supersedes earlier reads"}; unresolved: ${unresolved.join(",")}`;
    if (terminal) {
      this.#quarantine(operation, `${reason} (operation is ${operation.state})`);
      return;
    }
    if (deferRequest) {
      operation.requestOwed = true;
      return;
    }
    this.#deliverOrQueue(this.#requestFor(operation, WALLET_OPERATION_UNKNOWN_TRIGGER, reason));
  }

  /**
   * Weigh evidence about an operation outside flight against the whole
   * identity set (contradictions, admission, marks) and set the obligation it
   * creates: evidence other than a stale lifecycle report, arriving before the
   * conclusion, means the whole set — every member named so far AND every
   * member named later — is answered by name from now on. That holds even
   * while the set is still empty (WP300-R8-02: the flag binds what is named
   * afterwards). Raises no request and quarantines nothing: the caller does.
   */
  #weighUnderReconciliation(operation: Operation, evidence: WeighedEvidence, firstNamed: readonly string[] = []): Weighing {
    const weighed = operation.identity.weigh(evidence, operation.confirmedCredited, firstNamed);
    const staleReport = (evidence.kind === "SUBMITTED" || evidence.kind === "MINED") && weighed.admitted.length === 0;
    if (!isTerminalState(operation.state) && !staleReport) operation.identity.requireEveryKey();
    return weighed;
  }

  /**
   * Quarantine a terminal operation whose outcome is contested: its lines
   * refuse reservations, and an approval's readiness is suspended, until every
   * unresolved member is resolved authoritatively ({@link #resolveQuarantine});
   * a balance read does not lift it.
   */
  #quarantine(operation: Operation, reason: string): void {
    const placed = this.#book.quarantineLines({
      quarantineId: quarantineIdOf(operation.plan.operationId),
      accountRef: operation.plan.accountRef,
      assetIds: this.#touchedAssets(operation),
    });
    // Defensive (the ids are validated at plan time and the assets are registered).
    if (!placed.ok) this.#awaitObservation(operation);
    // WP300-R5-02: an approval has no lines; its readiness is suspended instead.
    if (isApproval(operation.plan)) this.#approvals.suspendApproval(operation.plan.operationId);
    this.#deliverOrQueue(
      this.#requestFor(
        operation,
        "POSITION_BALANCE_DISCREPANCY",
        `${reason}; the lines are quarantined until every unresolved transaction is resolved authoritatively`,
      ),
    );
  }

  /**
   * The recovery path for a quarantined terminal operation (WP300-R4-01,
   * WP300-R6): a current, terminal, authoritative answer naming only witnessed
   * transactions (checked by {@link #answer}) is recorded per member.
   */
  #resolveQuarantine(operation: Operation, outcome: TerminalOutcome, identity: IdentityValues, repeat: boolean): Answered {
    const operationId = operation.plan.operationId;
    const checked = operation.identity.checkAnswer(outcome, identity);
    if (!checked.ok) return { result: answerRefusal(operationId, checked, unresolvedKeys(operation)), weigh: !repeat };
    operation.identity.recordAnswer(outcome, identity, checked.keys);
    if (unresolvedKeys(operation).length > 0) return { result: ok(view(operation)), weigh: false };
    // Every member stands again: lift the quarantine. Whatever the answers
    // were, the book's lines may not reflect them (an effect never applied, or
    // applied wrongly), so they await a fresh authoritative read.
    this.#book.releaseQuarantine(quarantineIdOf(operationId));
    this.#awaitObservation(operation);
    if (isApproval(operation.plan)) {
      // WP300-R5-02, WP300-R6-02: re-recorded (needing a fresh CLOB allowance
      // sync) only if it stands on the whole set's evidence; else discarded.
      if (operation.identity.approvalStands()) this.#recordApprovalIfAny(operation);
      else this.#approvals.discardApproval(operationId);
    }
    return { result: ok(view(operation)), weigh: false };
  }

  /**
   * Deliver an UNKNOWN operation's reconciliation request. While the call is
   * in progress the operation accepts {@link resolveByReconciliation} (a
   * synchronous answer). Afterwards, if nothing answered it: delivered →
   * RECONCILING; not delivered → stays UNKNOWN with the request queued.
   */
  #requestReconciliation(operation: Operation, request: ReconciliationRequest, reason: string): boolean {
    if (this.#delivering > 0) {
      // Raised from inside another request's delivery: queued, never re-entrant.
      this.#outstandingRequests.push({ request, advances: true });
      return false;
    }
    operation.requesting = true;
    let delivered: boolean;
    try {
      delivered = this.#deliver(request);
    } finally {
      operation.requesting = false;
    }
    if (operation.state !== "UNKNOWN") return delivered; // answered during the call
    if (operation.latestRequestId !== request.requestId && this.#queuedAdvancing(operation, request.requestId)) {
      // Answered during the call, moved, and sent back to UNKNOWN inside it: the
      // request raised then (queued, never re-entrant) carries the operation
      // now, and retry moves it to RECONCILING — delivering that request if it
      // is still the newest, or a fresh one if an even newer request (one that
      // does not advance, raised by evidence weighed inside the same call)
      // superseded it (WP300-R9-04). This one must not stand in for it, or
      // retry would find the operation out of UNKNOWN and never deliver the
      // request that names the new evidence.
      return delivered;
    }
    if (delivered) this.#transition(operation, "RECONCILING", reason);
    else this.#outstandingRequests.push({ request, advances: true });
    return delivered;
  }

  /**
   * Whether a request other than `except` is queued for this operation that
   * moves it to RECONCILING once delivered (one raised when it was sent back
   * to UNKNOWN during a delivery).
   */
  #queuedAdvancing(operation: Operation, except: string): boolean {
    return this.#outstandingRequests.some(
      (entry) =>
        entry.advances && entry.request.walletOperationId === operation.plan.operationId && entry.request.requestId !== except,
    );
  }

  /**
   * A new reconciliation request for the operation, recorded with the evidence
   * generation it is issued at (WP300-R7-X3). Its id carries a token drawn for
   * it (WP300C-J1), and is never one an answer has already named (WP-300c):
   * such an id is skipped, so an answer that named it before it existed can
   * never be bound to it. After a failed draw the id has no token, and the
   * request is never delivered (see the header, "REQUEST IDS").
   */
  #requestFor(operation: Operation, trigger: ReconciliationTrigger, reason: string): ReconciliationRequest {
    let requestId: string;
    let token: string | null;
    do {
      operation.requestCount += 1;
      token = this.#drawToken();
      requestId = compositeKey("wallet-op", operation.plan.operationId, "reconciliation", String(operation.requestCount), token ?? "");
    } while (this.#namedUnissued.has(requestId));
    if (token === null) this.#untokened.add(requestId);
    operation.requests.set(requestId, operation.identity.generation);
    operation.latestRequestId = requestId;
    return {
      requestId,
      trigger,
      walletOperationId: operation.plan.operationId,
      accountRef: operation.plan.accountRef,
      reason,
      transactionHashes: Object.freeze([...operation.identity.hashes]),
      transactionIds: Object.freeze([...operation.identity.ids]),
      unresolvedTransactions: Object.freeze(unresolvedKeys(operation)),
    };
  }

  /**
   * Hand a request to the reconciler. From the moment the call starts, an
   * answer may be bound to it (a synchronous requester answers inside the
   * call); if the call throws, the reconciler did not take it, and it is again
   * a request the reconciler has not received (see the header, "REQUEST IDS").
   */
  #deliver(request: ReconciliationRequest): boolean {
    // WP300C-J1: a request built after a failed token draw is never handed over
    // (its id is predictable); retry replaces it under a fresh draw.
    if (this.#untokened.has(request.requestId)) return false;
    const operation = this.#operations.get(request.walletOperationId);
    const received = operation === undefined || operation.delivered.has(request.requestId);
    // Received from now on, numbered in receipt order (WP300C-J2).
    if (operation !== undefined && !received) operation.delivered.set(request.requestId, ++this.#receipts);
    this.#delivering += 1;
    try {
      this.#reconciler.request(Object.freeze({ ...request }));
      return true;
    } catch {
      if (!received) operation?.delivered.delete(request.requestId);
      return false;
    } finally {
      this.#delivering -= 1;
    }
  }

  /**
   * Draw one request token (WP300C-J1; see the header, "REQUEST IDS"): a
   * non-empty string of at most {@link MAX_REQUEST_TOKEN_LENGTH} characters
   * that this manager never drew before, or null — the source threw, returned
   * anything else, or repeated itself (a repeated token was predictable).
   */
  #drawToken(): string | null {
    let token: unknown;
    try {
      const draw = this.#requestToken;
      token = draw();
    } catch {
      return null;
    }
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_REQUEST_TOKEN_LENGTH) return null;
    if (this.#tokensDrawn.has(token)) return null;
    this.#tokensDrawn.add(token);
    return token;
  }

  #beginHold(operation: Operation): InventoryResult<null> {
    const assetIds = this.#touchedAssets(operation);
    if (assetIds.length === 0) return ok(null);
    const holdId = holderRefOf(operation.plan.operationId);
    const held = this.#book.holdForOperation({ holdId, accountRef: operation.plan.accountRef, assetIds });
    if (!held.ok) return held;
    operation.holdId = holdId;
    return ok(null);
  }

  /** Every identifier this plan will hand the book, so it can be validated up front. */
  #derivedIdentifiers(plan: WalletOperationPlan, reservedAssetIds: readonly string[]): readonly string[] {
    const ids = [holderRefOf(plan.operationId), quarantineIdOf(plan.operationId)];
    for (const assetId of reservedAssetIds) {
      const reservationId = reservationIdOf(plan.operationId, assetId);
      ids.push(reservationId, debitPendingIdOf(reservationId));
    }
    for (const assetId of this.#touchedAssetsOf(plan, reservedAssetIds)) {
      ids.push(creditPendingIdOf(plan.operationId, assetId));
    }
    return ids;
  }

  /** Deliver a request that does not move the operation, or queue it. True if delivered. */
  #deliverOrQueue(request: ReconciliationRequest): boolean {
    // Raised from inside another request's delivery: queued, never re-entrant.
    if (this.#delivering === 0 && this.#deliver(request)) return true;
    this.#outstandingRequests.push({ request, advances: false });
    return false;
  }

  /**
   * The executor answered after evidence had already moved the operation out
   * of PLANNED (see the header). The answer is weighed, never dropped.
   */
  #lateExecutorAnswer(operation: Operation, result: Classified | "THREW", hints: Identity): void {
    let contradiction: string | null = null;
    const conflict = operation.identity.fieldConflict(hints);
    if (conflict !== null) {
      contradiction = `the executor's late answer names a different ${conflict}`;
    } else if (result === "THREW") {
      // No new fact: the other evidence already says the operation left.
    } else if (result.kind === "SUBMITTED") {
      // Consistent: its identity (witnessed below) is learned.
    } else if (result.kind === "NOT_SENT") {
      contradiction = "the executor's late answer is NOT_SENT, contradicting the evidence received meanwhile";
    } else {
      contradiction = `the executor's late answer is unrecognised (${result.kind === "UNRECOGNISED" ? result.why : result.kind})`;
    }
    const state = operation.state;
    const owed = operation.requestOwed;
    operation.requestOwed = false;
    if (isTerminalState(state)) {
      // Unreachable by construction (nothing concludes while the executor is
      // pending — WP300-R3-02); weighed like any evidence after a terminal
      // state if it ever happens (fail closed: a contradiction is unrecognised).
      this.#weighOutsideFlight(
        operation,
        { kind: contradiction === null ? "SUBMITTED" : "UNRECOGNISED", ...hints, credited: null },
        `the executor's late answer${contradiction === null ? "" : ` (${contradiction})`}`,
      );
      return;
    }
    // Witnessed whatever it says: a second transaction stays explicit (WP300-R3-01).
    const unresolvedBefore = new Set(unresolvedKeys(operation));
    let firstNamed: readonly string[] = [];
    if (state !== "SUBMITTED" && state !== "MINED") {
      // Outside flight the late answer is weighed like the same fact arriving
      // there from any other source. WP300-R7-X3: a contradiction is a doubt,
      // weighed (and marked) like an unrecognised observation: reads made
      // before it are superseded; like any evidence weighed under
      // reconciliation, it ends simple mode (WP300-R8-02). WP300-R9-01: a
      // consistent answer is the lifecycle report it is — stale (no change) if
      // it names nothing new, otherwise it admits and marks what it names
      // first, so a read made before that transaction was named is superseded.
      // Nothing stands while the executor was pending, so it contests nothing.
      const late: WeighedEvidence = { kind: contradiction === null ? "SUBMITTED" : "UNRECOGNISED", ...hints, credited: null };
      this.#weighUnderReconciliation(operation, late);
    } else {
      firstNamed = operation.identity.admit(hints);
    }
    if (state === "SUBMITTED" || state === "MINED") {
      // Reconciliation said "still in flight" while the executor was pending.
      if (contradiction !== null) {
        // WP300-R9-01: the contradiction is weighed once the operation is out
        // of flight, like the same contradiction arriving there, and so is
        // everything kept meanwhile (#toUnknown).
        this.#toUnknown(operation, `${contradiction}${this.#bufferedNote(operation)}`, {
          evidence: { kind: "UNRECOGNISED", ...hints, credited: null },
          firstNamed,
          afterBuffer: true,
        });
        return;
      }
      // Terminal observations kept while the executor was pending are weighed now.
      this.#drainBuffer(
        operation,
        { transactionHash: operation.identity.hashes[0] ?? null, transactionId: operation.identity.ids[0] ?? null },
        { evidence: { kind: "SUBMITTED", ...hints, credited: null }, firstNamed, afterBuffer: true },
      );
      return;
    }
    // A member the whole set must now answer for is news to the reconciler too.
    const opened = unresolvedKeys(operation).filter((key) => !unresolvedBefore.has(key));
    if (contradiction === null && !owed && opened.length === 0) return;
    this.#deliverOrQueue(
      this.#requestFor(
        operation,
        WALLET_OPERATION_UNKNOWN_TRIGGER,
        contradiction !== null
          ? `${contradiction} (operation is ${state})`
          : opened.length > 0
            ? `the executor's late answer names ${opened.join(",")}, which must be resolved by name too`
            : "the executor call has now answered; a terminal resolution refused while it was pending may be given now",
      ),
    );
  }

  #endHold(operation: Operation): void {
    if (operation.holdId === null) return;
    this.#book.releaseOperationHold(operation.holdId);
    operation.holdId = null;
  }

  /** A note for the reason of a return to UNKNOWN; the buffered observations themselves are weighed by {@link #toUnknown}. */
  #bufferedNote(operation: Operation): string {
    const count = operation.buffered.length;
    if (count === 0) return "";
    return ` (${String(count)} observation(s) received during submission; not applied, weighed under reconciliation)`;
  }

  #transition(operation: Operation, to: WalletOperationState, reason: string): void {
    const from = operation.state;
    if (!isLegalWalletTransition(from, to)) {
      throw new Error(`wallet-operation invariant: illegal transition ${from} -> ${to}`);
    }
    operation.state = to;
    // A conclusion stands for every member of the identity set without standing evidence (WP300-R6).
    if (isTerminalState(to)) operation.identity.conclude(to);
    this.#record(operation, from, to, reason);
  }

  #record(operation: Operation, from: WalletOperationState | null, to: WalletOperationState, reason: string): void {
    this.#events.push(
      Object.freeze({
        operationId: operation.plan.operationId,
        ordinal: operation.ordinal,
        previousState: from,
        newState: to,
        reason,
      }),
    );
    operation.ordinal += 1;
  }

  #reservationNeeds(
    plan: WalletOperationPlan,
  ): InventoryResult<readonly { readonly assetId: string; readonly amount: DecimalString }[]> {
    switch (plan.type) {
      case "APPROVE_ERC20":
      case "APPROVE_ERC1155":
        return ok([]);
      case "SPLIT":
      case "MERGE": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair === undefined) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "condition has no registered outcome pair", {
            conditionId: plan.conditionId,
          });
        }
        return plan.type === "SPLIT"
          ? ok([{ assetId: this.#registry.pusdAssetId, amount: plan.amount }])
          : ok([
              { assetId: pair.yesAssetId, amount: plan.amount },
              { assetId: pair.noAssetId, amount: plan.amount },
            ]);
      }
      case "REDEEM": {
        const pair = this.#registry.pairOf(plan.conditionId);
        if (pair === undefined) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "condition has no registered outcome pair", {
            conditionId: plan.conditionId,
          });
        }
        const needs: { assetId: string; amount: DecimalString }[] = [];
        if (plan.yesAmount !== undefined) needs.push({ assetId: pair.yesAssetId, amount: plan.yesAmount });
        if (plan.noAmount !== undefined) needs.push({ assetId: pair.noAssetId, amount: plan.noAmount });
        return ok(needs);
      }
      case "WRAP_COLLATERAL": {
        const usdcE = this.#registry.usdcEAssetId;
        if (usdcE === null) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "no USDC.e asset is registered; the onramp wraps USDC.e only");
        }
        return ok([{ assetId: usdcE, amount: plan.amount }]);
      }
      case "UNWRAP_COLLATERAL":
        if (this.#registry.usdcEAssetId === null) {
          return refuse("INVENTORY_UNKNOWN_ASSET", "no USDC.e asset is registered to receive the unwrap");
        }
        return ok([{ assetId: this.#registry.pusdAssetId, amount: plan.amount }]);
    }
  }

  #parsePlan(input: unknown): InventoryResult<WalletOperationPlan> {
    const type = ownData(input, "type");
    if (typeof type !== "string" || !(WALLET_OPERATION_TYPES as readonly string[]).includes(type)) {
      return refuse("WALLET_OP_UNSUPPORTED_TYPE", "unsupported wallet operation type", {
        type: typeof type === "string" ? type : null,
      });
    }
    const opType = type as WalletOperationType;
    const allowed = WALLET_PLAN_KEYS[opType];
    for (const key of Reflect.ownKeys(input as object)) {
      if (typeof key !== "string" || !allowed.includes(key)) {
        return refuse("INVENTORY_INVALID_INPUT", "wallet operation plan carries a field this operation does not have", {
          type: opType,
          field: typeof key === "string" ? key : "<symbol>",
        });
      }
    }
    const operationId = ownNonEmptyString(input, "operationId");
    const accountRef = ownNonEmptyString(input, "accountRef");
    if (operationId === undefined || accountRef === undefined) {
      return refuse("INVENTORY_INVALID_INPUT", "wallet operation needs operationId and accountRef");
    }
    const bad = (message: string): InventoryResult<WalletOperationPlan> =>
      refuse("INVENTORY_INVALID_INPUT", message, { type: opType, operationId });
    switch (opType) {
      case "APPROVE_ERC20": {
        const assetId = ownNonEmptyString(input, "assetId");
        const spender = ownNonEmptyString(input, "spender");
        const allowance = ownPositiveAmount(input, "allowance");
        if (assetId === undefined || spender === undefined || allowance === undefined) {
          return bad("APPROVE_ERC20 needs assetId, spender and a positive allowance");
        }
        const role = this.#registry.lookup(assetId)?.role;
        if (role !== "PUSD" && role !== "USDC_E") {
          return refuse("INVENTORY_ASSET_ROLE_MISMATCH", "an ERC20 approval is for a registered collateral asset", {
            assetId,
          });
        }
        if (!isDocumentedApprovalSpender(spender)) {
          return refuse("WALLET_OP_SPENDER_NOT_DOCUMENTED", "approval spender is not a documented venue contract", {
            spender,
          });
        }
        return ok(Object.freeze({ type: opType, operationId, accountRef, assetId, spender, allowance }));
      }
      case "APPROVE_ERC1155": {
        const spender = ownNonEmptyString(input, "spender");
        if (spender === undefined) return bad("APPROVE_ERC1155 needs spender");
        if (!isDocumentedApprovalSpender(spender)) {
          return refuse("WALLET_OP_SPENDER_NOT_DOCUMENTED", "approval spender is not a documented venue contract", {
            spender,
          });
        }
        return ok(Object.freeze({ type: opType, operationId, accountRef, spender }));
      }
      case "SPLIT":
      case "MERGE": {
        const conditionId = ownNonEmptyString(input, "conditionId");
        const amount = ownPositiveAmount(input, "amount");
        if (conditionId === undefined || amount === undefined) {
          return bad(`${opType} needs conditionId and a positive amount`);
        }
        return ok(Object.freeze({ type: opType, operationId, accountRef, conditionId, amount }));
      }
      case "REDEEM": {
        const conditionId = ownNonEmptyString(input, "conditionId");
        const resolution = ownData(input, "resolution");
        const yesRaw = ownData(input, "yesAmount");
        const noRaw = ownData(input, "noAmount");
        const yesAmount = yesRaw === undefined ? undefined : ownPositiveAmount(input, "yesAmount");
        const noAmount = noRaw === undefined ? undefined : ownPositiveAmount(input, "noAmount");
        if (
          conditionId === undefined ||
          (yesRaw !== undefined && yesAmount === undefined) ||
          (noRaw !== undefined && noAmount === undefined) ||
          (yesAmount === undefined && noAmount === undefined)
        ) {
          return bad("REDEEM needs conditionId and at least one positive yesAmount/noAmount");
        }
        if (resolution === "CANCELLED") {
          return refuse(
            "WALLET_OP_REDEEM_CANCELLED_UNVERIFIED",
            "a CANCELLED market's payout is undocumented (U-10); redemption is refused rather than invented",
            { conditionId },
          );
        }
        if (resolution !== "YES_WIN" && resolution !== "NO_WIN" && resolution !== "SPLIT_50_50") {
          return refuse(
            "WALLET_OP_REDEEM_OUTCOME_NOT_TERMINAL",
            "redeem requires a resolved market (YES_WIN, NO_WIN or SPLIT_50_50); resolution is not settlement (ADR-009 §8)",
            { conditionId, resolution: typeof resolution === "string" ? resolution : null },
          );
        }
        return ok(
          Object.freeze({
            type: opType,
            operationId,
            accountRef,
            conditionId,
            resolution,
            ...(yesAmount === undefined ? {} : { yesAmount }),
            ...(noAmount === undefined ? {} : { noAmount }),
          }),
        );
      }
      case "WRAP_COLLATERAL":
      case "UNWRAP_COLLATERAL": {
        const amount = ownPositiveAmount(input, "amount");
        if (amount === undefined) return bad(`${opType} needs a positive amount`);
        return ok(Object.freeze({ type: opType, operationId, accountRef, amount }));
      }
    }
  }
}

// ------------------------------------------------------------ identifiers --

function holderRefOf(operationId: string): string {
  return compositeKey("wallet-op", operationId);
}

function reservationIdOf(operationId: string, assetId: string): string {
  return compositeKey("wallet-op", operationId, assetId);
}

function debitPendingIdOf(reservationId: string): string {
  return compositeKey(reservationId, "out");
}

function creditPendingIdOf(operationId: string, assetId: string): string {
  return compositeKey("wallet-op", operationId, assetId, "in");
}

function quarantineIdOf(operationId: string): string {
  return compositeKey("wallet-op", operationId, "quarantine");
}

/**
 * Why the observations buffered during submission, read together with the
 * executor's SUBMITTED answer, are not one consistent story — or null.
 * Checked before any of them is applied (WP300-R2-02).
 */
function bufferConflict(
  submitted: { readonly transactionHash: string | null; readonly transactionId: string | null },
  buffered: readonly Classified[],
): string | null {
  let hash = submitted.transactionHash;
  let id = submitted.transactionId;
  let terminal: Classified | null = null;
  for (const outcome of buffered) {
    if (outcome.kind === "UNRECOGNISED" || outcome.kind === "NOT_SENT") return `an unrecognised observation`;
    if (outcome.transactionHash !== null && hash !== null && outcome.transactionHash !== hash) {
      return `${outcome.kind} under a different transaction hash`;
    }
    if (outcome.transactionId !== null && id !== null && outcome.transactionId !== id) {
      return `${outcome.kind} under a different relayer transaction id`;
    }
    hash ??= outcome.transactionHash;
    id ??= outcome.transactionId;
    if (terminal !== null) {
      const repeat =
        outcome.kind === terminal.kind &&
        (outcome.kind !== "CONFIRMED" ||
          terminal.kind !== "CONFIRMED" ||
          (outcome.credited === null
            ? terminal.credited === null
            : terminal.credited !== null && compareDecimal(outcome.credited, terminal.credited) === 0));
      if (!repeat) return `${outcome.kind} after ${terminal.kind}`;
    } else if (outcome.kind === "CONFIRMED" || outcome.kind === "FAILED") {
      terminal = outcome;
    }
  }
  return null;
}

// ------------------------------------------------------------ classifiers --

function nullableString(source: unknown, key: string): string | null | undefined {
  const descriptor =
    source !== null && typeof source === "object" ? Object.getOwnPropertyDescriptor(source, key) : undefined;
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * An optional identity field: absent or null → null; a non-empty string →
 * itself; anything else (malformed) → undefined.
 */
function optionalIdentity(source: unknown, key: string): string | null | undefined {
  const descriptor =
    source !== null && typeof source === "object" ? Object.getOwnPropertyDescriptor(source, key) : undefined;
  if (descriptor === undefined) return null;
  if (!("value" in descriptor)) return undefined;
  const value: unknown = descriptor.value;
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface Identity {
  readonly transactionHash: string | null;
  readonly transactionId: string | null;
}

function isTerminalState(state: WalletOperationState): state is "CONFIRMED" | "FAILED" {
  return state === "CONFIRMED" || state === "FAILED";
}

function isApproval(plan: WalletOperationPlan): boolean {
  return plan.type === "APPROVE_ERC20" || plan.type === "APPROVE_ERC1155";
}

/** What remains to resolve by name (see the header and {@link OperationIdentity.unresolved}). */
function unresolvedKeys(operation: Operation): string[] {
  return operation.identity.unresolved(isTerminalState(operation.state));
}

/** What {@link WalletOperationManager.resolveByReconciliation} decided, and whether a refusal is weighed. */
interface Answered {
  readonly result: InventoryResult<WalletOperationView>;
  readonly weigh: boolean;
}

/** A refusal for an authoritative answer the identity set did not accept. */
function answerRefusal(
  operationId: string,
  checked: Extract<AnswerCheck, { ok: false }>,
  unresolved: readonly string[],
): InventoryResult<never> {
  return refuse(checked.code, checked.reason, {
    operationId,
    unresolved: unresolved.join(","),
    ...(checked.transaction === null ? {} : { transaction: checked.transaction }),
    ...(checked.previous === null ? {} : { previous: checked.previous }),
  });
}

/**
 * Classified evidence received outside flight, for weighing: its identity is
 * whatever it names (`hints`: own non-empty strings), recognised or not.
 */
function weighedEvidence(classified: Classified, hints: Identity): WeighedEvidence {
  switch (classified.kind) {
    case "SUBMITTED":
    case "MINED":
    case "FAILED":
      return { kind: classified.kind, ...hints, credited: null };
    case "CONFIRMED":
      return { kind: "CONFIRMED", ...hints, credited: classified.credited };
    default:
      return { kind: "UNRECOGNISED", ...hints, credited: null };
  }
}

/**
 * A classified outcome as evidence to weigh: a recognised one with its own
 * identity (and credited amount), anything else as an unrecognised fact
 * naming whatever the raw evidence named (`hints`).
 */
function weighedOf(outcome: Classified, hints: Identity): WeighedEvidence {
  switch (outcome.kind) {
    case "SUBMITTED":
    case "MINED":
    case "FAILED":
      return { kind: outcome.kind, transactionHash: outcome.transactionHash, transactionId: outcome.transactionId, credited: null };
    case "CONFIRMED":
      return { kind: "CONFIRMED", transactionHash: outcome.transactionHash, transactionId: outcome.transactionId, credited: outcome.credited };
    default:
      return { kind: "UNRECOGNISED", ...hints, credited: null };
  }
}

/** The identity a classified outcome names (none for NOT_SENT or an unrecognised one). */
function identityOf(outcome: Classified): Identity {
  return outcome.kind === "NOT_SENT" || outcome.kind === "UNRECOGNISED"
    ? { transactionHash: null, transactionId: null }
    : { transactionHash: outcome.transactionHash, transactionId: outcome.transactionId };
}

/**
 * Identity fields the evidence names (own data, non-empty strings), whether or
 * not the rest of it is recognised: a transaction named by unrecognised
 * evidence is still a transaction to account for. Read from the snapshot (an
 * opaque field names nothing: the evidence carrying it is unrecognised, and
 * weighed as naming what it named as own data).
 */
function identityHints(evidence: Evidence): Identity {
  const hash = nullableString(evidence.fields, "transactionHash");
  const id = nullableString(evidence.fields, "transactionId");
  return { transactionHash: typeof hash === "string" ? hash : null, transactionId: typeof id === "string" ? id : null };
}

// ------------------------------------------------------ evidence at the door --

/** The fields the executor's answer is read by. */
const SUBMIT_FIELDS: readonly string[] = Object.freeze(["status", "transactionHash", "transactionId"]);
/** The fields an observation is read by. */
const OBSERVATION_FIELDS: readonly string[] = Object.freeze(["status", "transactionHash", "transactionId", "credited"]);
/** The fields a reconciliation answer is read by, in this order. */
const ANSWER_FIELDS: readonly string[] = Object.freeze(["source", "state", "requestId", "transactionHash", "transactionId", "credited"]);

/**
 * Evidence as it read at the door (see the header, "EVIDENCE AT THE DOOR"):
 * `fields` holds the fields that are own data — frozen, with no prototype, so
 * reading it again is stable; `opaque` lists the fields that are present but
 * not own data (an accessor, an inherited property, a read that threw).
 * Evidence with an opaque field is unrecognised ({@link classifyEvidence}).
 */
interface Evidence {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly opaque: readonly string[];
}

/** Assemble a snapshot from fields already read (`label` names a field in a refusal reason). */
function evidenceOf(reads: readonly (readonly [key: string, read: FieldRead, label: string])[]): Evidence {
  const fields = Object.create(null) as Record<string, unknown>;
  const opaque: string[] = [];
  for (const [key, read, label] of reads) {
    if (read.kind === "DATA") fields[key] = read.value;
    else if (read.kind === "OPAQUE") opaque.push(`${label} (${read.why})`);
  }
  return Object.freeze({ fields: Object.freeze(fields), opaque: Object.freeze(opaque) });
}

/** Read evidence at the door: each field exactly once ({@link readField}). */
function readEvidence(raw: unknown, keys: readonly string[]): Evidence {
  return evidenceOf(keys.map((key) => [key, readField(raw, key), key] as const));
}

/** A reconciliation answer as it read at the door (WP300B-R1-01): nothing below reads the caller's object again. */
interface Answer {
  /** `source` is own data and is `"AUTHORITATIVE_READ"`. */
  readonly authoritative: boolean;
  /** `state`, if it is own data (for refusal details only; the decision is on `observation`). */
  readonly state: unknown;
  /**
   * The request it names: none (`requestId` absent, `undefined` or `null`), a
   * value (own data; bound only if it is a string id the reconciler had
   * received before the door read began, and that no answer named before its
   * read had seen it received — `received`, settled the moment the field is
   * read: WP300C-J2, WP300C-R2-X1), or `OPAQUE` — present but not own data,
   * never "none" (WP300B-R1-02).
   */
  readonly binding:
    | { readonly kind: "NONE" }
    | { readonly kind: "NAMED"; readonly value: unknown; readonly received: boolean }
    | { readonly kind: "OPAQUE" };
  /**
   * The answer as the observation of the same fact (WP300-R7-X1): its state is
   * the status. Built from the same reads; any opaque field of the answer —
   * `source` and `requestId` included — makes it unrecognised.
   */
  readonly observation: Evidence;
}

/**
 * Read a reconciliation answer at the door, each field once, in
 * {@link ANSWER_FIELDS} order. `bindNamed` settles the binding of a `requestId`
 * that is an own string the moment that field is read, BEFORE any later field
 * is read (WP300C-J2: a trap may call back into the manager and issue
 * requests; one on a later field can no longer issue the id just named, and
 * none can bind the answer to a request received during its read).
 */
function readAnswer(raw: unknown, bindNamed: (named: string) => boolean): Answer {
  const reads = new Map<string, FieldRead>();
  let received = false;
  for (const key of ANSWER_FIELDS) {
    const field = readField(raw, key);
    reads.set(key, field);
    if (key === "requestId" && field.kind === "DATA" && typeof field.value === "string") received = bindNamed(field.value);
  }
  const read = (key: string): FieldRead => reads.get(key) ?? { kind: "ABSENT" };
  const source = read("source");
  const state = read("state");
  const requestId = read("requestId");
  const named = requestId.kind === "DATA" && requestId.value !== undefined && requestId.value !== null;
  return Object.freeze({
    authoritative: source.kind === "DATA" && source.value === "AUTHORITATIVE_READ",
    state: state.kind === "DATA" ? state.value : undefined,
    binding: Object.freeze(
      requestId.kind === "OPAQUE"
        ? { kind: "OPAQUE" as const }
        : named
          ? { kind: "NAMED" as const, value: requestId.value, received }
          : { kind: "NONE" as const },
    ),
    observation: evidenceOf([
      ["status", state, "state"],
      ["transactionHash", read("transactionHash"), "transactionHash"],
      ["transactionId", read("transactionId"), "transactionId"],
      ["credited", read("credited"), "credited"],
      ...(source.kind === "OPAQUE" ? [["source", source, "source"] as const] : []),
      ...(requestId.kind === "OPAQUE" ? [["requestId", requestId, "requestId"] as const] : []),
    ]),
  });
}

/**
 * Classify a snapshot: unrecognised if any field is opaque (WP300B-R1-02: a
 * field that is present but not own data is never read as absent), else by
 * the executor's two shapes (`submit`) or the lifecycle shapes.
 */
function classifyEvidence(evidence: Evidence, as: "submit" | "observation"): Classified {
  if (evidence.opaque.length > 0) {
    return { kind: "UNRECOGNISED", why: `a field is present but not own data: ${evidence.opaque.join(", ")}` };
  }
  return as === "submit" ? classifySubmitFields(evidence.fields) : classifyObservationFields(evidence.fields);
}

/** Classify an executor `submit` result, read once at the door. Only two shapes are recognised. */
export function classifySubmit(raw: unknown): Classified {
  return classifyEvidence(readEvidence(raw, SUBMIT_FIELDS), "submit");
}

/** Classify a lifecycle observation or reconciliation state, read once at the door. */
export function classifyObservation(raw: unknown): Classified {
  return classifyEvidence(readEvidence(raw, OBSERVATION_FIELDS), "observation");
}

/** The executor's two shapes, over a snapshot's own data fields. */
function classifySubmitFields(raw: Readonly<Record<string, unknown>>): Classified {
  const status = ownData(raw, "status");
  if (status === "NOT_SENT") {
    // WP300-R9-02: "nothing left the process" names no transaction. A NOT_SENT
    // that names one (or carries a malformed identity field) contradicts
    // itself: unrecognised, never a release.
    if (optionalIdentity(raw, "transactionHash") !== null || optionalIdentity(raw, "transactionId") !== null) {
      return { kind: "UNRECOGNISED", why: "NOT_SENT naming a transaction (or with a malformed identity field)" };
    }
    return { kind: "NOT_SENT" };
  }
  if (status === "SUBMITTED") {
    const transactionHash = nullableString(raw, "transactionHash");
    const transactionId = nullableString(raw, "transactionId");
    if (transactionHash === undefined || transactionId === undefined) {
      return { kind: "UNRECOGNISED", why: "SUBMITTED without transactionHash/transactionId fields" };
    }
    if (transactionHash === null && transactionId === null) {
      return { kind: "UNRECOGNISED", why: "SUBMITTED with neither a transaction hash nor a relayer id" };
    }
    return { kind: "SUBMITTED", transactionHash, transactionId };
  }
  return { kind: "UNRECOGNISED", why: typeof status === "string" ? `status ${status}` : "no status" };
}

/** The lifecycle shapes, over a snapshot's own data fields. */
function classifyObservationFields(raw: Readonly<Record<string, unknown>>): Classified {
  const status = ownData(raw, "status");
  switch (status) {
    case "SUBMITTED":
      return classifySubmitFields(raw);
    case "MINED": {
      const transactionHash = nullableString(raw, "transactionHash");
      const transactionId = optionalIdentity(raw, "transactionId");
      if (typeof transactionHash !== "string") return { kind: "UNRECOGNISED", why: "MINED without a transaction hash" };
      if (transactionId === undefined) return { kind: "UNRECOGNISED", why: "MINED with a malformed transactionId" };
      return { kind: "MINED", transactionHash, transactionId };
    }
    case "CONFIRMED": {
      // TransactionOutcome: transactionHash: TxHash; transactionId: TransactionId | null.
      const transactionHash = nullableString(raw, "transactionHash");
      const transactionIdRaw = optionalIdentity(raw, "transactionId");
      if (typeof transactionHash !== "string") {
        return { kind: "UNRECOGNISED", why: "CONFIRMED without a transaction hash" };
      }
      if (transactionIdRaw === undefined) return { kind: "UNRECOGNISED", why: "CONFIRMED with a malformed transactionId" };
      const creditedRaw = ownData(raw, "credited");
      const credited = creditedRaw === undefined ? null : ownNonNegativeAmount(raw, "credited");
      if (credited === undefined) return { kind: "UNRECOGNISED", why: "CONFIRMED with a malformed credited amount" };
      return { kind: "CONFIRMED", transactionHash, transactionId: transactionIdRaw, credited };
    }
    case "FAILED": {
      const transactionHash = optionalIdentity(raw, "transactionHash");
      const transactionId = optionalIdentity(raw, "transactionId");
      if (transactionHash === undefined || transactionId === undefined) {
        return { kind: "UNRECOGNISED", why: "FAILED with a malformed transaction identity" };
      }
      return { kind: "FAILED", transactionHash, transactionId };
    }
    default:
      return { kind: "UNRECOGNISED", why: typeof status === "string" ? `status ${status}` : "no status" };
  }
}

function stateOf(operation: Operation): WalletOperationState {
  return operation.state;
}

function view(operation: Operation): WalletOperationView {
  return Object.freeze({
    operationId: operation.plan.operationId,
    type: operation.plan.type,
    accountRef: operation.plan.accountRef,
    state: operation.state,
    plan: operation.plan,
    reservationIds: Object.freeze(operation.reservations.map((r) => r.reservationId)),
    transactionHash: operation.identity.hashes[0] ?? null,
    transactionId: operation.identity.ids[0] ?? null,
    effectsApplied: operation.effectsApplied,
    submitting: operation.submitting,
    bufferedObservations: operation.buffered.length,
    transactionHashes: Object.freeze([...operation.identity.hashes]),
    transactionIds: Object.freeze([...operation.identity.ids]),
    unresolvedTransactions: Object.freeze(unresolvedKeys(operation)),
    quarantined: isTerminalState(operation.state) && unresolvedKeys(operation).length > 0,
    reopenedTransactions: Object.freeze([...operation.identity.reopened]),
  });
}
