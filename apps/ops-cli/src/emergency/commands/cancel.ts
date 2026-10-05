/**
 * cancel-order, cancel-market, cancel-all (handoff §14.2; ADR-008 §6;
 * WP-310 follow_up 4).
 *
 * Each command:
 *
 * 1. reads venue truth for its plan (an order by id, or the open orders), and
 *    prints the PLAN: the endpoint, what the venue lists now, the rate-limit
 *    class and cost, the D-21 debt, the scope to confirm;
 * 2. stops on `--dry-run`, or without a scoped confirmation;
 * 3. writes the `ACTING` audit record, durable, before the first cancel;
 * 4. sends each cancel only once WP-310's budget grants it at
 *    `EMERGENCY_CANCEL`, through WP-260's secure client, and completes the
 *    grant with the venue's canceled count;
 * 5. reads venue truth again, and prints the RESULT, every not-canceled order
 *    with its reason, and what is UNKNOWN.
 *
 * cancel-all reads ONLY venue truth and uses ONLY the emergency credential:
 * no trader state, no trader process, no database (§14.2). After its
 * `DELETE /cancel-all` it re-reads the open orders and cancels every order
 * still listed BY ID (`DELETE /orders`), in batches of at most the cancel
 * bucket's burst minus the emergency headroom (≤ 1,000, C-11), each batch
 * waiting for the cancel bucket's debt (D-21); then it reads once more.
 * It never retries beyond that one sweep: what is still listed is reported.
 *
 * THE OUTCOME RECORD IS BOUNDED BY CONSTRUCTION (WP-330 r1, WP330-V1-01),
 * whatever the number of orders and batches: {@link auditAttempts} records
 * totals over every attempt, itemizes at most {@link MAX_AUDITED_ATTEMPTS}
 * attempts (counts, no ids), and samples the ids canceled and not canceled,
 * over all attempts, at most `MAX_AUDITED_IDS` each, with their counts.
 * `audit-bounds.test.ts` pins the worst case below `MAX_AUDIT_LINE_BYTES`.
 */

import type { BudgetEffect, BudgetRequest, CancelOutcome, CancelMarketFilter, NotCanceledEntry } from "@polymarket-bot/polymarket-secure";
import type { VenueOrderView } from "@polymarket-bot/oms";

import type { AuditValue } from "../audit-log.js";
import { withinBound } from "../bounded.js";
import { canceledCountOf, completionErrorOf, CANCEL_PRIORITY, EMERGENCY_OPERATIONS } from "../budget.js";
import { scopeDescription, scopeText } from "../confirmation.js";
import { auditedIds, auditId, auditText, confirmThenRecord, MAX_AUDITED_IDS, printedIds, type CommandContext, type CommandResult } from "../context.js";
import type { ExitName } from "../exit-codes.js";
import { SECTIONS } from "../printer.js";
import type { VenueSession } from "../session.js";
import { checkOpenOrders, checkOrderById, readChecked, type Checked } from "../venue-truth.js";
import { EMERGENCY_VENUE_FACTS } from "../venue-facts.js";

// ---------------------------------------------------------------------------
// One cancel request.

export interface CancelAttempt {
  readonly endpoint: string;
  readonly operationId: string;
  /** The ids a by-id request carried; `null` for cancel-all and cancel-market. */
  readonly requested: readonly string[] | null;
  readonly sent: boolean;
  /** Why it was not sent, when it was not. */
  readonly notSent: string | null;
  readonly waitedMs: number;
  readonly outcome: CancelOutcome | null;
  readonly canceledCount: number | null;
  readonly effects: readonly BudgetEffect[];
  /** No answer came within `venueAnswerBoundMs`: the outcome is UNKNOWN, and may still apply. */
  readonly unanswered?: boolean;
}

/**
 * Ask the budget, send once, complete the grant with the count. The secure
 * client never throws (WP-260); a binding that does is read as UNKNOWN.
 */
async function sendCancel(
  session: VenueSession,
  request: BudgetRequest,
  endpoint: string,
  requested: readonly string[] | null,
  call: () => Promise<CancelOutcome>,
  estimateWhenUnknown: number | null,
): Promise<CancelAttempt> {
  const acquired = await session.budget.acquire(request);
  if (acquired.kind !== "GRANTED") {
    const notSent =
      acquired.kind === "REFUSED"
        ? `the rate-limit budget refused it (${acquired.code}: ${acquired.message})`
        : `the cancel bucket would not admit it within maxBudgetWaitMs (${String(session.configuration.maxBudgetWaitMs)} ms)${acquired.wakeAtMs === null ? "" : `; earliest grant ${new Date(acquired.wakeAtMs).toISOString()}`}`;
    return { endpoint, operationId: request.operationId, requested, sent: false, notSent, waitedMs: acquired.kind === "TIMED_OUT" ? acquired.waitedMs : 0, outcome: null, canceledCount: null, effects: [] };
  }
  let outcome: CancelOutcome;
  let unanswered = false;
  try {
    const bounded = await withinBound(session.configuration.venueAnswerBoundMs, call);
    unanswered = bounded.kind === "UNANSWERED";
    outcome = bounded.kind === "ANSWERED" ? bounded.value : Object.freeze({ kind: "UNKNOWN", error: null });
  } catch {
    outcome = Object.freeze({ kind: "UNKNOWN", error: null });
  }
  const canceledCount = canceledCountOf(outcome, estimateWhenUnknown);
  const error = unanswered ? { kind: "UNANSWERED", retryAfterSeconds: null } : completionErrorOf(outcome);
  const effects = session.budget.complete(acquired.grant, { error, canceledCount });
  return { endpoint, operationId: request.operationId, requested, sent: true, notSent: null, waitedMs: acquired.waitedMs, outcome, canceledCount, effects, unanswered };
}

function errorText(error: { readonly kind: string; readonly httpStatus: number | null; readonly effect: string } | null): string {
  if (error === null) return "no readable answer";
  return `${error.kind}${error.httpStatus === null ? "" : `, HTTP ${String(error.httpStatus)}`}, effect ${error.effect}`;
}

/** The RESULT lines of one attempt: canceled, and every not-canceled order with its reason (ADR-008 §6). */
function describeAttempt(attempt: CancelAttempt): string[] {
  const head = `${attempt.endpoint}${attempt.requested === null ? "" : ` (${String(attempt.requested.length)} id${attempt.requested.length === 1 ? "" : "s"})`}`;
  if (!attempt.sent) return [`${head}: NOT SENT: ${attempt.notSent ?? "not granted"}`];
  const sent = `${head}: sent${attempt.waitedMs > 0 ? ` after waiting ${String(attempt.waitedMs)} ms for the rate-limit budget` : ""}`;
  const outcome = attempt.outcome;
  if (outcome === null) return [`${sent}; no answer`];
  const count = attempt.canceledCount === null ? "no canceled count (none known)" : `canceled count ${String(attempt.canceledCount)} passed to the budget`;
  switch (outcome.kind) {
    case "COMPLETED": {
      const lines = [`${sent}; answer COMPLETED: canceled ${String(outcome.canceled.length)} [${printedIds(outcome.canceled)}]; not canceled ${String(outcome.notCanceled.length)}; ${count}`];
      for (const entry of outcome.notCanceled) lines.push(`NOT CANCELED ${entry.orderId}: ${entry.reason}`);
      return lines;
    }
    case "NOT_SENT":
      return [`${sent}; answer NOT_SENT (${errorText(outcome.error)}): WP-260 did not transmit it; nothing was canceled by it`];
    case "REFUSED":
      return [`${sent}; answer REFUSED (${errorText(outcome.error)}): the venue refused it unapplied; nothing was canceled by it`];
    case "UNKNOWN":
      return [
        attempt.unanswered === true
          ? `${sent}; NO ANSWER within venueAnswerBoundMs: UNKNOWN, some or all of it may have been (or may still be) applied; ${count}`
          : `${sent}; answer UNKNOWN (${errorText(outcome.error)}): some or all of it may have been applied; ${count}`,
      ];
  }
}

/** At most this many attempts are itemized in one OUTCOME record; every attempt is counted in its totals. */
export const MAX_AUDITED_ATTEMPTS = 20;
/** At most this many budget effects are itemized per attempt; their count is recorded. */
export const MAX_AUDITED_EFFECTS = 8;
/** The longest text an itemized attempt carries: why it was not sent; a code (an answer, an error kind, an effect kind). */
export const MAX_AUDITED_NOT_SENT_LENGTH = 300;
export const MAX_AUDITED_CODE_LENGTH = 40;
/** The longest not-canceled reason recorded (WP-260 maps every venue reason to a documented one or `UNDOCUMENTED`). */
export const MAX_AUDITED_REASON_LENGTH = 64;

/** One attempt, itemized: counts and codes, NO ids (the ids are sampled once, over all attempts). */
function auditAttempt(attempt: CancelAttempt): AuditValue {
  const outcome = attempt.outcome;
  return {
    endpoint: attempt.endpoint,
    operationId: attempt.operationId,
    requested: attempt.requested === null ? null : attempt.requested.length,
    sent: attempt.sent,
    notSent: attempt.notSent === null ? null : auditText(attempt.notSent, MAX_AUDITED_NOT_SENT_LENGTH),
    answer: outcome === null ? null : auditText(outcome.kind, MAX_AUDITED_CODE_LENGTH),
    unanswered: attempt.unanswered === true,
    canceled: outcome?.kind === "COMPLETED" ? outcome.canceled.length : null,
    notCanceled: outcome?.kind === "COMPLETED" ? outcome.notCanceled.length : null,
    errorKind: outcome === null || outcome.kind === "COMPLETED" || outcome.error === null ? null : auditText(outcome.error.kind, MAX_AUDITED_CODE_LENGTH),
    canceledCount: attempt.canceledCount,
    budgetEffects: attempt.effects.slice(0, MAX_AUDITED_EFFECTS).map((effect) => auditText(effect.kind, MAX_AUDITED_CODE_LENGTH)),
    budgetEffectCount: attempt.effects.length,
  };
}

/**
 * The attempts of one cancel command as its OUTCOME record holds them,
 * bounded by construction whatever their number (WP330-V1-01):
 *
 * - `attempts`: totals over EVERY attempt (sent, each answer kind, no answer
 *   in time, ids requested, canceled counts passed to the budget), and the
 *   first {@link MAX_AUDITED_ATTEMPTS} attempts itemized (`truncated` says
 *   whether more were made);
 * - `canceled`: every id the venue answered canceled, over all attempts: the
 *   count, and the first `MAX_AUDITED_IDS` ids;
 * - `notCanceled`: every entry the venue answered not canceled, over all
 *   attempts: the count, and the first `MAX_AUDITED_IDS` entries with their
 *   reasons.
 */
export function auditAttempts(attempts: readonly CancelAttempt[]): { readonly [key: string]: AuditValue } {
  const answers = { COMPLETED: 0, NOT_SENT: 0, REFUSED: 0, UNKNOWN: 0 };
  const canceled: string[] = [];
  const notCanceled: NotCanceledEntry[] = [];
  let sent = 0;
  let unanswered = 0;
  let requestedIds = 0;
  let canceledCountPassed = 0;
  let canceledCountMissing = 0;
  let canceledTotal = 0;
  let notCanceledTotal = 0;
  for (const attempt of attempts) {
    if (attempt.requested !== null) requestedIds += attempt.requested.length;
    if (!attempt.sent) continue;
    sent += 1;
    if (attempt.unanswered === true) unanswered += 1;
    if (attempt.canceledCount === null) canceledCountMissing += 1;
    else canceledCountPassed += attempt.canceledCount;
    const outcome = attempt.outcome;
    if (outcome === null) continue;
    switch (outcome.kind) {
      case "COMPLETED":
      case "NOT_SENT":
      case "REFUSED":
      case "UNKNOWN":
        answers[outcome.kind] += 1;
    }
    if (outcome.kind !== "COMPLETED") continue;
    canceledTotal += outcome.canceled.length;
    notCanceledTotal += outcome.notCanceled.length;
    for (const id of outcome.canceled) {
      if (canceled.length >= MAX_AUDITED_IDS) break;
      canceled.push(id);
    }
    for (const entry of outcome.notCanceled) {
      if (notCanceled.length >= MAX_AUDITED_IDS) break;
      notCanceled.push(entry);
    }
  }
  return {
    attempts: {
      count: attempts.length,
      sent,
      answers,
      unanswered,
      requestedIds,
      canceledCountPassed,
      canceledCountMissing,
      itemized: attempts.slice(0, MAX_AUDITED_ATTEMPTS).map(auditAttempt),
      truncated: attempts.length > MAX_AUDITED_ATTEMPTS,
    },
    canceled: { count: canceledTotal, ids: canceled.map(auditId), truncated: canceledTotal > canceled.length },
    notCanceled: {
      count: notCanceledTotal,
      entries: notCanceled.map((entry) => ({ orderId: auditId(entry.orderId), reason: auditText(entry.reason, MAX_AUDITED_REASON_LENGTH) })),
      truncated: notCanceledTotal > notCanceled.length,
    },
  };
}

function effectLines(attempts: readonly CancelAttempt[], session: VenueSession): string[] {
  const lines: string[] = [];
  for (const attempt of attempts) {
    for (const effect of attempt.effects) {
      if (effect.kind === "CANCELED_DEBITED") lines.push(`rate limit: ${attempt.operationId} debited ${String(effect.tokens)} token(s) for orders canceled (D-21)`);
      if (effect.kind === "WAIT_APPLIED") lines.push(`rate limit: the cancel bucket waits until ${new Date(effect.untilMs).toISOString()} (${effect.basis})`);
      if (effect.kind === "CANCELED_COUNT_UNKNOWN") lines.push(`rate limit: ${attempt.operationId} completed with no canceled count: no debit was applied`);
    }
  }
  const bucket = session.budget.cancelBucketText();
  if (bucket !== null) lines.push(`rate limit now (this process's estimate): ${bucket}`);
  return lines;
}

function nothingApplied(attempts: readonly CancelAttempt[]): boolean {
  return attempts.every((attempt) => !attempt.sent || attempt.outcome === null || attempt.outcome.kind === "NOT_SENT" || attempt.outcome.kind === "REFUSED");
}

/**
 * The exit of a cancel command, by evidence, in this order:
 *
 * 1. every request unsent or refused unapplied: `VENUE_REFUSED` (an emergency
 *    must learn at once that its cancels are not landing);
 * 2. a complete verification read: `COMPLETED` when nothing targeted is still
 *    open, else `NOT_ALL_CANCELED`;
 * 3. no verification: the answers alone. Any answer UNKNOWN: `UNKNOWN`; any
 *    request unsent, refused, or naming an order not canceled:
 *    `NOT_ALL_CANCELED`; every answer COMPLETED with nothing not canceled:
 *    `COMPLETED`.
 */
export function cancelExit(attempts: readonly CancelAttempt[], verification: { readonly verified: true; readonly stillOpen: number } | { readonly verified: false }): ExitName {
  if (nothingApplied(attempts)) return "VENUE_REFUSED";
  if (verification.verified) return verification.stillOpen === 0 ? "COMPLETED" : "NOT_ALL_CANCELED";
  if (attempts.some((attempt) => attempt.sent && (attempt.outcome === null || attempt.outcome.kind === "UNKNOWN"))) return "UNKNOWN";
  const allCompleted = attempts.every((attempt) => attempt.sent && attempt.outcome?.kind === "COMPLETED" && attempt.outcome.notCanceled.length === 0);
  return allCompleted ? "COMPLETED" : "NOT_ALL_CANCELED";
}

function listedText(read: Checked<readonly VenueOrderView[]>, label: string): string {
  if (read.kind === "READ") return `${label}: ${String(read.value.length)} open order(s) listed${read.complete ? "" : " (the venue marked the list INCOMPLETE)"} [${printedIds(read.value.map((order) => order.venueOrderId))}]`;
  return `${label}: NOT READ (${read.problem})`;
}

function identityLines(session: VenueSession, accountRef: string): string[] {
  return [
    `account ${accountRef}: the emergency credential acts for it; signer ${session.identity.signerAddress}, wallet ${session.identity.walletAddress} (identity, not secret)`,
    `the venue reads and cancels per credential: only orders these credentials own are seen or canceled (${EMERGENCY_VENUE_FACTS.READS_PER_CREDENTIAL.section})`,
  ];
}

const ALWAYS_UNKNOWN = [
  `an order missing from the open-orders list is not proof that it was canceled (${EMERGENCY_VENUE_FACTS.ABSENT_IS_NOT_CANCELED.section}); it may have matched. Read it by id, or run reconcile`,
  "the venue's own cancel balance for this signer is shared with the trader and is not visible here; the rate-limit figures are this process's estimate",
  "this command does not depend on, stop or ask the trader: a trader still running may place new orders. stop-heartbeat revokes its fencing lease",
];

// ---------------------------------------------------------------------------
// cancel-all.

export async function runCancelAll(context: CommandContext, session: VenueSession): Promise<CommandResult> {
  const { parsed, printer } = context;
  const before = await readChecked(() => session.reads.listOpenOrders(), checkOpenOrders);
  const listed = before.kind === "READ" ? before.value : null;
  const capacity = session.budget.batchCapacity();
  const batchSize = "problem" in capacity ? 0 : capacity.maxEntries;
  const debt = session.budget.cancelDebtPlan(listed === null ? null : listed.length, batchSize);
  const scope = scopeText(parsed);

  const plan = [
    `DELETE /cancel-all (no body): the venue cancels every open order owned by these CLOB API credentials; it works even in cancel-only mode (${EMERGENCY_VENUE_FACTS.CANCEL_ENDPOINTS.source} ${EMERGENCY_VENUE_FACTS.CANCEL_ENDPOINTS.section})`,
    ...identityLines(session, parsed.accountRef),
    listedText(before, "venue truth now"),
    `rate limit: ${EMERGENCY_OPERATIONS.CANCEL_ALL} at ${CANCEL_PRIORITY} (handoff §9.13 rank 2); it costs 1 cancel token, then 1 per order canceled (D-21)`,
  ];
  if ("problem" in debt) plan.push(`cancel debt (D-21): not estimable: ${debt.problem}`);
  else {
    plan.push(
      `cancel debt (D-21): tier ${debt.tier} (cancel burst ${String(debt.cancelBurst)}, ${String(debt.cancelTokensPerSecond)} tokens/s, negative balance ${debt.negativeCancelBalance ? "allowed" : "floored at 0"}); local cancel bucket now ${debt.levelNow} tokens (a new process starts empty), first grant in about ${String(debt.firstGrantWaitMs)} ms`,
    );
    plan.push(
      debt.assumedCanceled === null
        ? "after the cancel-all: the debit is not estimable (the open orders could not be read); later cancels wait for the venue's answers"
        : `after canceling the ${String(debt.assumedCanceled)} listed order(s) the local bucket would stand at about ${debt.levelAfterDebit ?? "?"} tokens; a sweep batch of ${String(debt.sweepEntries)} id(s) would wait about ${String(debt.sweepWaitMs ?? 0)} ms (bound: maxBudgetWaitMs ${String(session.configuration.maxBudgetWaitMs)} ms)`,
    );
  }
  plan.push(
    "problem" in capacity
      ? `then: re-read the open orders; NO by-id sweep is possible (${capacity.problem})`
      : `then: re-read the open orders; cancel every order still listed by id (DELETE /orders, ${EMERGENCY_OPERATIONS.CANCEL_ORDERS} at ${CANCEL_PRIORITY}) in batches of at most ${String(capacity.maxEntries)} ids (tier ${capacity.tier}: cancel burst ${String(capacity.cancelBurst)} minus ${String(capacity.headroomPermille)}‰ headroom; at most 1,000 per C-11); then read once more`,
    "nothing else is read or written: no trader state, no trader process, no database, no fencing lease (handoff §14.2)",
    `scope to confirm: ${scope}`,
  );
  printer.section(SECTIONS.PLAN, plan);

  const planDetail = { listedBefore: listed === null ? null : auditedIds(listed.map((order) => order.venueOrderId)), batchSize };
  const go = await confirmThenRecord(context, scope, scopeDescription(parsed), planDetail);
  if (go !== "GO") {
    printer.section(SECTIONS.RESULT, ["nothing was sent"]);
    printer.section(SECTIONS.UNKNOWN, before.kind === "READ" ? [] : ["the account's open orders (the read failed)"]);
    return go;
  }

  const attempts: CancelAttempt[] = [];
  const first = await sendCancel(
    session,
    { operationId: EMERGENCY_OPERATIONS.CANCEL_ALL, priority: CANCEL_PRIORITY, signer: session.identity.signerAddress },
    "DELETE /cancel-all",
    null,
    () => session.venue.cancels.cancelAll(),
    listed === null ? null : listed.length,
  );
  attempts.push(first);
  if (!first.sent) {
    printer.section(SECTIONS.RESULT, describeAttempt(first));
    printer.section(SECTIONS.UNKNOWN, ALWAYS_UNKNOWN);
    return { exit: "BUDGET_REFUSED", result: { ...auditAttempts(attempts), verified: false } };
  }

  const after = await readChecked(() => session.reads.listOpenOrders(), checkOpenOrders);
  let final = after;
  const sweepIds = after.kind === "READ" ? after.value.map((order) => order.venueOrderId) : [];
  let sweepStopped: string | null = null;
  if (sweepIds.length > 0) {
    if (batchSize < 1) sweepStopped = "problem" in capacity ? capacity.problem : "no batch fits the cancel bucket";
    for (let start = 0; start < sweepIds.length && sweepStopped === null; start += batchSize) {
      const chunk = sweepIds.slice(start, start + batchSize);
      const attempt = await sendCancel(
        session,
        { operationId: EMERGENCY_OPERATIONS.CANCEL_ORDERS, priority: CANCEL_PRIORITY, signer: session.identity.signerAddress, entries: chunk.length },
        "DELETE /orders",
        chunk,
        () => session.venue.cancels.cancelOrders(chunk),
        chunk.length,
      );
      attempts.push(attempt);
      if (!attempt.sent) sweepStopped = attempt.notSent;
    }
    final = await readChecked(() => session.reads.listOpenOrders(), checkOpenOrders);
  }

  const result: string[] = [];
  for (const attempt of attempts) result.push(...describeAttempt(attempt));
  result.push(listedText(after, "venue truth after DELETE /cancel-all"));
  if (sweepIds.length > 0) {
    if (sweepStopped !== null) result.push(`the by-id sweep stopped: ${sweepStopped}`);
    result.push(listedText(final, "venue truth after the by-id sweep"));
  }
  result.push(...effectLines(attempts, session));
  printer.section(SECTIONS.RESULT, result);

  const unknown = [...ALWAYS_UNKNOWN];
  if (first.outcome?.kind === "UNKNOWN") unknown.push("which orders DELETE /cancel-all canceled: its answer was lost or unreadable");
  if (final.kind !== "READ") unknown.push("the account's open orders after the cancels: the read failed");
  else if (!final.complete) unknown.push("the account's full open-order list: the venue marked it incomplete");
  printer.section(SECTIONS.UNKNOWN, unknown);

  const verified = final.kind === "READ" && final.complete;
  const exit = cancelExit(attempts, final.kind === "READ" && final.complete ? { verified: true, stillOpen: final.value.length } : { verified: false });
  return {
    exit,
    result: {
      ...auditAttempts(attempts),
      stillListed: final.kind === "READ" ? auditedIds(final.value.map((order) => order.venueOrderId)) : null,
      finalReadComplete: verified,
      // Whether a complete read of venue truth decided the exit; false: the venue's answers alone did (D8).
      verified,
    },
  };
}

// ---------------------------------------------------------------------------
// cancel-order.

export async function runCancelOrder(context: CommandContext, session: VenueSession): Promise<CommandResult> {
  const { parsed, printer } = context;
  const orderId = parsed.target as string;
  const before = await readChecked(() => session.reads.readOrder(orderId), (answer) => checkOrderById(answer, orderId));
  const scope = scopeText(parsed);
  const describeRead = (read: Checked<VenueOrderView | null>, label: string): string =>
    read.kind !== "READ" ? `${label}: NOT READ (${read.problem})` : read.value === null ? `${label}: the venue does not show order ${orderId}` : `${label}: order ${orderId} status ${read.value.status}, token ${read.value.tokenId}, ${read.value.side} ${read.value.originalSize} at ${read.value.price}, matched ${read.value.sizeMatched}`;
  printer.section(SECTIONS.PLAN, [
    `DELETE /order {"orderID": "${orderId}"}: the venue cancels that one order; it works even in cancel-only mode (${EMERGENCY_VENUE_FACTS.CANCEL_ENDPOINTS.source} ${EMERGENCY_VENUE_FACTS.CANCEL_ENDPOINTS.section})`,
    ...identityLines(session, parsed.accountRef),
    describeRead(before, "venue truth now"),
    `rate limit: ${EMERGENCY_OPERATIONS.CANCEL_ORDER} at ${CANCEL_PRIORITY}; 1 cancel token`,
    "then: read the order by id again",
    `scope to confirm: ${scope}`,
  ]);
  const go = await confirmThenRecord(context, scope, scopeDescription(parsed), { target: orderId });
  if (go !== "GO") {
    printer.section(SECTIONS.RESULT, ["nothing was sent"]);
    printer.section(SECTIONS.UNKNOWN, before.kind === "READ" ? [] : ["the order's state (the read failed)"]);
    return go;
  }
  const attempt = await sendCancel(
    session,
    { operationId: EMERGENCY_OPERATIONS.CANCEL_ORDER, priority: CANCEL_PRIORITY, signer: session.identity.signerAddress },
    "DELETE /order",
    [orderId],
    () => session.venue.cancels.cancelOrder(orderId),
    1,
  );
  if (!attempt.sent) {
    printer.section(SECTIONS.RESULT, describeAttempt(attempt));
    printer.section(SECTIONS.UNKNOWN, []);
    return { exit: "BUDGET_REFUSED", result: { target: orderId, ...auditAttempts([attempt]), verified: false } };
  }
  const after = await readChecked(() => session.reads.readOrder(orderId), (answer) => checkOrderById(answer, orderId));
  printer.section(SECTIONS.RESULT, [...describeAttempt(attempt), describeRead(after, "venue truth after"), ...effectLines([attempt], session)]);

  const outcome = attempt.outcome;
  // A read by id that FINDS the order verifies it: CANCELED, or not canceled (still live, or matched). The venue's
  // answer decides only when the read fails or does not find it (E-14: absent is not canceled).
  const verified = after.kind === "READ" && after.value !== null;
  const exit =
    after.kind === "READ" && after.value !== null
      ? cancelExit([attempt], { verified: true, stillOpen: after.value.status === "CANCELED" ? 0 : 1 })
      : outcome?.kind === "COMPLETED" && !outcome.canceled.includes(orderId)
        ? nothingApplied([attempt])
          ? "VENUE_REFUSED"
          : "NOT_ALL_CANCELED"
        : cancelExit([attempt], { verified: false });

  const unknown: string[] = [];
  if (outcome?.kind === "UNKNOWN") unknown.push("whether DELETE /order was applied: its answer was lost or unreadable");
  if (after.kind !== "READ") unknown.push("the order's state afterwards: the read by id failed");
  else if (after.value === null) unknown.push(`the venue does not show order ${orderId} by id: whether it was canceled or never existed is not known`);
  printer.section(SECTIONS.UNKNOWN, unknown);
  return { exit, result: { target: orderId, ...auditAttempts([attempt]), statusAfter: after.kind === "READ" ? (after.value?.status ?? "NOT_FOUND") : null, verified } };
}

// ---------------------------------------------------------------------------
// cancel-market.

export async function runCancelMarket(context: CommandContext, session: VenueSession): Promise<CommandResult> {
  const { parsed, printer } = context;
  const market = parsed.target as string;
  const asset = parsed.assetId;
  const before = await readChecked(() => session.reads.listOpenOrders(), checkOpenOrders);
  const targeted = (read: Checked<readonly VenueOrderView[]>): readonly VenueOrderView[] | null =>
    read.kind === "READ" && asset !== null ? read.value.filter((order) => order.tokenId === asset) : null;
  const targetedBefore = targeted(before);
  const scope = scopeText(parsed);
  const estimate = targetedBefore !== null ? targetedBefore.length : before.kind === "READ" ? before.value.length : null;
  printer.section(SECTIONS.PLAN, [
    `DELETE /cancel-market-orders {"market": "${market}"${asset === null ? "" : `, "asset_id": "${asset}"`}}: the venue cancels every open order of that market${asset === null ? "" : " in that asset"}; it works even in cancel-only mode (${EMERGENCY_VENUE_FACTS.CANCEL_REQUEST_SHAPES.source} ${EMERGENCY_VENUE_FACTS.CANCEL_REQUEST_SHAPES.section})`,
    ...identityLines(session, parsed.accountRef),
    targetedBefore !== null
      ? `venue truth now: ${String(targetedBefore.length)} open order(s) in asset ${asset ?? ""} [${printedIds(targetedBefore.map((order) => order.venueOrderId))}]`
      : before.kind === "READ"
        ? `venue truth now: ${String(before.value.length)} open order(s) account-wide; the open-orders read carries no market id (WP-290's AccountReadPort), so which belong to this market is the venue's to decide (pass --asset to verify by token)`
        : listedText(before, "venue truth now"),
    `rate limit: ${EMERGENCY_OPERATIONS.CANCEL_MARKET_ORDERS} at ${CANCEL_PRIORITY}; 1 cancel token, then 1 per order canceled (D-21)`,
    "then: re-read the open orders",
    `scope to confirm: ${scope}`,
  ]);
  const go = await confirmThenRecord(context, scope, scopeDescription(parsed), { target: market, asset });
  if (go !== "GO") {
    printer.section(SECTIONS.RESULT, ["nothing was sent"]);
    printer.section(SECTIONS.UNKNOWN, before.kind === "READ" ? [] : ["the account's open orders (the read failed)"]);
    return go;
  }
  const filter: CancelMarketFilter = asset === null ? { market } : { market, assetId: asset };
  const attempt = await sendCancel(
    session,
    { operationId: EMERGENCY_OPERATIONS.CANCEL_MARKET_ORDERS, priority: CANCEL_PRIORITY, signer: session.identity.signerAddress },
    "DELETE /cancel-market-orders",
    null,
    () => session.venue.cancels.cancelMarketOrders(filter),
    estimate,
  );
  if (!attempt.sent) {
    printer.section(SECTIONS.RESULT, describeAttempt(attempt));
    printer.section(SECTIONS.UNKNOWN, []);
    return { exit: "BUDGET_REFUSED", result: { target: market, asset, ...auditAttempts([attempt]), verified: false } };
  }
  const after = await readChecked(() => session.reads.listOpenOrders(), checkOpenOrders);
  const targetedAfter = targeted(after);
  printer.section(SECTIONS.RESULT, [
    ...describeAttempt(attempt),
    targetedAfter !== null ? `venue truth after: ${String(targetedAfter.length)} open order(s) still listed in asset ${asset ?? ""} [${printedIds(targetedAfter.map((order) => order.venueOrderId))}]` : listedText(after, "venue truth after (account-wide)"),
    ...effectLines([attempt], session),
  ]);

  const outcome = attempt.outcome;
  // Verifiable only with --asset: the open-orders read names tokens, not markets. `--asset` is canonical decimal,
  // the read's own lexeme (grammar.ts ASSET_ID, a sub-language of venue-truth.ts TOKEN_ID), so `targeted` compares
  // like with like, and an empty selection means no order of that token is listed (WP-330 r3, CX330-R3-01).
  const verified = after.kind === "READ" && after.complete && targetedAfter !== null;
  const exit = cancelExit([attempt], verified && targetedAfter !== null ? { verified: true, stillOpen: targetedAfter.length } : { verified: false });

  const unknown = [...ALWAYS_UNKNOWN];
  if (outcome?.kind === "UNKNOWN") unknown.push("which orders DELETE /cancel-market-orders canceled: its answer was lost or unreadable");
  if (asset === null) unknown.push("which open orders belong to this market: the open-orders read carries no market id, so the result is the venue's answer alone");
  if (after.kind !== "READ") unknown.push("the account's open orders afterwards: the read failed");
  printer.section(SECTIONS.UNKNOWN, unknown);
  return {
    exit,
    result: { target: market, asset, ...auditAttempts([attempt]), stillListedInAsset: targetedAfter === null ? null : auditedIds(targetedAfter.map((order) => order.venueOrderId)), verified },
  };
}
