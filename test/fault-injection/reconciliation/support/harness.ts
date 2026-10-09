/**
 * The reconciliation suite's harness (WP-290): a real `OrderManager`, a real
 * `ReconciliationCoordinator`, a real `ReconciliationJournal`, a real `Ledger`
 * and WP-300's real in-memory `ReservationService`, over the simulated venue
 * (`world.ts`). Every port is a mock or in-memory: nothing here reaches a
 * network, a key, a signer or a real venue. PAPER only.
 *
 * A UNIVERSE is what survives a crash: the venue, the OMS store, the journal's
 * durable events, the ledger, the inventory, the clock. A PROCESS is one
 * incarnation over it. Every port call an incarnation makes is counted, in
 * order (`Incarnation.call`), and a kill plan stops the process BEFORE or
 * AFTER the k-th call: after a kill, every later port call of that
 * incarnation throws, so it can neither write, send nor read.
 *
 * THE ORACLE (ground truth, independent of the coordinator's logic):
 * - R1: whenever `OrderManager.resume()` succeeds through the coordinator,
 *   the account is CONSISTENT at that moment (`consistencyProblems`);
 * - R2: an ABSENT answer the OMS accepted was given while the venue held no
 *   order for the attempt's salt and none was still travelling;
 * - R3: a PRESENT answer the OMS accepted named the attempt's own venue order;
 * - S2 (in `world.ts`): no new salt for a slot while an earlier one is live
 *   at the venue or may still arrive.
 */

import { addDecimal, compareDecimal, mulDecimal, negateDecimal } from "../../../../packages/decimal/src/index.js";
import {
  Ledger,
  buildUnattributedCorrection,
  projectLedger,
  projectedHoldings,
  remainingFillBookings,
  ReconciliationJournal,
  type ReconciliationJournalEvent,
} from "../../../../packages/ledger/src/index.js";
import {
  OrderManager,
  ReconciliationCoordinator,
  type AttemptView,
  type OmsAlert,
  type OmsReservationPort,
  type OmsStore,
  type OrderManagerDependencies,
  type PayloadCipher,
  type ReconciledOms,
  type ReconciliationJournalPort,
  type ReconciliationPolicy,
  type ReconciliationRequest,
  type VenueMode,
} from "../../../../packages/oms/src/index.js";
import { restoreFakeSignedOrder, venueIdFor } from "../../../unit/oms/support/fake-venue.js";
import { ACCOUNT, MARKET, NO, PUSD, YES, INSTANCE_A, realInventory } from "../../../unit/oms/support/harness.js";
import { idSource, tokenSource, uuid7 } from "../../../unit/oms/support/ids.js";
import { MemoryStore } from "../../../unit/oms/support/memory-store.js";
import { MockCipher } from "../../../unit/oms/support/mock-cipher.js";

import { EXCHANGE, ReconWorld } from "./world.js";

export { ACCOUNT, EXCHANGE, MARKET, NO, PUSD, YES };

/** A second market, for the NO token. */
export const MARKET_NO = uuid7(0xc, 2);
export const START_MS = 1_790_000_000_000;

export const POLICY: ReconciliationPolicy = Object.freeze({
  accountRef: ACCOUNT,
  collateralAssetId: PUSD,
  quiescenceHorizonMs: 5_000,
  maxReadSpanMs: 2_000,
  holdingConfirmationMs: 1_000,
  requiredApprovalSpenders: Object.freeze([EXCHANGE]),
});

export interface KillPlan {
  readonly at: number;
  readonly phase: "before" | "after";
}

export class Killed extends Error {}

export interface Universe {
  readonly clock: { t: number };
  readonly world: ReconWorld;
  readonly store: MemoryStore;
  readonly cipher: MockCipher;
  readonly inventory: ReturnType<typeof realInventory>;
  /** The ledger (durable); replaced on every append (it is a snapshot). */
  ledger: Ledger;
  readonly postedFills: Set<string>;
  readonly ledgerIds: () => string;
  /** The journal's durable events (its sink). */
  readonly journalEvents: ReconciliationJournalEvent[];
  readonly omsIds: () => string;
  readonly coordinatorIds: () => string;
  readonly requestToken: () => string;
  readonly mode: { value: VenueMode };
  readonly omsRequests: ReconciliationRequest[];
  readonly violations: string[];
  /** Accepted answers, for assertions. */
  readonly accepted: { readonly verdict: string; readonly attemptId: string; readonly venueOrderId: string | null; readonly quiescent: boolean }[];
  resumes: number;
  /** How many times the coordinator called the OMS's `retryReconciliationRequests` (ADR-032 D5's cadence). */
  omsRetries: number;
  /** One ordered log of request receipts, reads and answers: `recv:oms:<id>`, `read:<name>`, `answer:oms:<id>`. */
  readonly log: string[];
  policy: ReconciliationPolicy;
  /**
   * Test seams over the ports a process binds (all default to the real objects): the journal port the
   * coordinator sees (read at boot); the OMS's attempt list (e.g. an attempt reported in flight), its alert list,
   * and its answer to a reconciliation; the group-token binding; a ledger that refuses bookings.
   * Each is a structural answer a real port could give; none reaches a network or a key.
   */
  readonly seams: {
    journal?: (real: ReconciliationJournal) => ReconciliationJournalPort;
    attempts?: (real: readonly AttemptView[]) => readonly AttemptView[];
    /** The OMS's alert list as the coordinator sees it (e.g. one that is not append-only, a contract break). */
    alerts?: (real: readonly OmsAlert[]) => readonly OmsAlert[];
    applyReconciliation?: (raw: unknown, real: (raw: unknown) => Promise<unknown>) => Promise<unknown>;
    tokenOfGroup?: (executionGroupId: string, real: (executionGroupId: string) => string | null) => string | null;
    /** The ledger refuses every UNATTRIBUTED booking. */
    refuseBooking?: boolean;
    /** The ledger's answer about FAILED fills' remaining bookings (r4), e.g. one that omits a fill or throws. */
    remainingBookings?: (fills: readonly { readonly venueTradeId: string; readonly venueOrderId: string }[], real: () => unknown) => unknown;
    /**
     * The coordinator's own clock, when it differs from the venue's time (r5): e.g. one that ran ahead and is then
     * corrected back (a step the coordinator detects only when it reads the clock again). Default: the venue's.
     */
    localClock?: (venueMs: number) => number;
  };
}

export function universe(
  options: {
    readonly pusd?: string;
    readonly policy?: Partial<ReconciliationPolicy>;
    readonly requestToken?: () => string;
    readonly seams?: Universe["seams"];
  } = {},
): Universe {
  const clock = { t: START_MS };
  const pusd = options.pusd ?? "1000";
  const ledgerIds = idSource(0x1ed);
  let ledger = Ledger.empty("PAPER");
  // The opening balance: pUSD, attributed to instance A (the ADR-006 §2 partition holds from the first entry).
  const opening = ledger.append({
    ledgerTransactionId: ledgerIds(),
    eventType: "DEPOSIT_OBSERVED",
    environment: "PAPER",
    accountRef: ACCOUNT,
    source: "internal",
    occurredAt: "2026-10-03T00:00:00Z",
    entries: [
      { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", amount: pusd },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-venue", assetId: PUSD, assetKind: "COLLATERAL", amount: negateDecimal(pusd) },
      { scope: "VIRTUAL_STRATEGY", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", amount: pusd, instanceId: INSTANCE_A },
      { scope: "EXTERNAL_CLEARING", accountRef: "clearing-attribution", assetId: PUSD, assetKind: "COLLATERAL", amount: negateDecimal(pusd) },
    ],
  });
  if (!opening.ok) throw new Error(`opening balance refused: ${JSON.stringify(opening.refusals)}`);
  ledger = opening.value.ledger;
  return {
    clock,
    world: new ReconWorld({ now: () => clock.t, collateral: pusd, collateralAssetId: PUSD }),
    store: new MemoryStore(),
    cipher: new MockCipher(),
    inventory: realInventory({ pusd, yes: "0" }),
    ledger,
    postedFills: new Set(),
    ledgerIds,
    journalEvents: [],
    omsIds: idSource(0x9),
    coordinatorIds: idSource(0x290),
    requestToken: options.requestToken ?? tokenSource("wp290"),
    mode: { value: "NORMAL" },
    omsRequests: [],
    violations: [],
    accepted: [],
    resumes: 0,
    omsRetries: 0,
    log: [],
    policy: Object.freeze({ ...POLICY, ...options.policy }),
    seams: { ...options.seams },
  };
}

export class Incarnation {
  alive = true;
  calls = 0;
  readonly trace: string[] = [];
  readonly #plan: KillPlan | null;

  constructor(plan: KillPlan | null) {
    this.#plan = plan;
  }

  #enter(name: string): boolean {
    if (!this.alive) throw new Killed("dead incarnation");
    this.calls += 1;
    this.trace.push(name);
    const here = this.#plan !== null && this.#plan.at === this.calls;
    if (here && this.#plan?.phase === "before") {
      this.alive = false;
      throw new Killed(`killed before ${name}`);
    }
    return here;
  }

  async call<T>(name: string, run: () => Promise<T>): Promise<T> {
    const here = this.#enter(name);
    const result = await run();
    if (here) {
      this.alive = false;
      throw new Killed(`killed after ${name}`);
    }
    return result;
  }

  callSync<T>(name: string, run: () => T): T {
    const here = this.#enter(name);
    const result = run();
    if (here) {
      this.alive = false;
      throw new Killed(`killed after ${name}`);
    }
    return result;
  }
}

export interface Process {
  readonly inc: Incarnation;
  readonly coordinator: ReconciliationCoordinator;
  readonly journal: ReconciliationJournal;
  /** `null` when the incarnation died while opening. */
  readonly oms: OrderManager | null;
}

/**
 * The halts the live entry gate reads (C1-OMS06): the coordinator's QUARANTINED breaks (`quarantinedBreaks`, which
 * throws when the journal cannot be read), each with its market, or `null` when it halts the account.
 */
export function halted(p: Process): { readonly breakId: string; readonly marketId: string | null }[] {
  return p.coordinator.quarantinedBreaks().map((view) => ({ breakId: view.breakId, marketId: view.scope === "MARKET" ? view.marketId : null }));
}

/** Fold every durable OMS fill into the ledger once (the composition posts each fill at its match: ADR-006 §5). */
export function syncLedger(u: Universe): void {
  for (const fill of u.store.snapshotSync().fills) {
    if (u.postedFills.has(fill.fillId)) continue;
    const notional = mulDecimal(fill.shares, fill.price);
    const sign = fill.side === "BUY" ? (amount: string): string => amount : (amount: string): string => negateDecimal(amount);
    const market = fill.tokenId === NO ? MARKET_NO : MARKET;
    const leg = (scope: string, account: string, assetId: string, assetKind: string, amount: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      scope,
      accountRef: account,
      assetId,
      assetKind,
      amount,
      ...extra,
    });
    const appended = u.ledger.append({
      ledgerTransactionId: u.ledgerIds(),
      eventType: "TRADE_PRINCIPAL",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "polymarket",
      occurredAt: fill.matchedAt,
      marketId: market,
      fillId: fill.fillId,
      entries: [
        leg("ACTUAL_ACCOUNT", ACCOUNT, fill.tokenId, "OUTCOME_TOKEN", sign(fill.shares), { marketId: market }),
        leg("VIRTUAL_STRATEGY", ACCOUNT, fill.tokenId, "OUTCOME_TOKEN", sign(fill.shares), { marketId: market, instanceId: INSTANCE_A }),
        leg("EXTERNAL_CLEARING", "clearing-venue", fill.tokenId, "OUTCOME_TOKEN", negateDecimal(sign(fill.shares))),
        leg("EXTERNAL_CLEARING", "clearing-attribution", fill.tokenId, "OUTCOME_TOKEN", negateDecimal(sign(fill.shares))),
        leg("ACTUAL_ACCOUNT", ACCOUNT, PUSD, "COLLATERAL", negateDecimal(sign(notional))),
        leg("VIRTUAL_STRATEGY", ACCOUNT, PUSD, "COLLATERAL", negateDecimal(sign(notional)), { instanceId: INSTANCE_A }),
        leg("EXTERNAL_CLEARING", "clearing-venue", PUSD, "COLLATERAL", sign(notional)),
        leg("EXTERNAL_CLEARING", "clearing-attribution", PUSD, "COLLATERAL", sign(notional)),
      ],
    });
    if (!appended.ok) throw new Error(`fill posting refused: ${JSON.stringify(appended.refusals)}`);
    u.ledger = appended.value.ledger;
    // A fee charged in the collateral is its own PLATFORM_FEE transaction naming the fill (as `fill-posting.ts`).
    if (fill.feeAssetId === PUSD && compareDecimal(fill.feeAmount, "0") > 0) {
      const fee = u.ledger.append({
        ledgerTransactionId: u.ledgerIds(),
        eventType: "PLATFORM_FEE",
        environment: "PAPER",
        accountRef: ACCOUNT,
        source: "polymarket",
        occurredAt: fill.matchedAt,
        marketId: market,
        fillId: fill.fillId,
        entries: [
          leg("ACTUAL_ACCOUNT", ACCOUNT, PUSD, "COLLATERAL", negateDecimal(fill.feeAmount), { marketId: market }),
          leg("FEE_EXPENSE", "fee-expense", PUSD, "COLLATERAL", fill.feeAmount, { marketId: market }),
          leg("VIRTUAL_STRATEGY", ACCOUNT, PUSD, "COLLATERAL", negateDecimal(fill.feeAmount), { marketId: market, instanceId: INSTANCE_A }),
          leg("EXTERNAL_CLEARING", "clearing-attribution", PUSD, "COLLATERAL", fill.feeAmount),
        ],
      });
      if (!fee.ok) throw new Error(`fee posting refused: ${JSON.stringify(fee.refusals)}`);
      u.ledger = fee.value.ledger;
    }
    u.postedFills.add(fill.fillId);
  }
}

/** The OMS's fill ids for one venue trade on one venue order (`execution.fills`). */
function fillIdsOf(u: Universe, venueTradeId: string, venueOrderId: string): string[] {
  return u.store
    .snapshotSync()
    .fills.filter((fill) => fill.venueTradeId === venueTradeId && fill.venueOrderId === venueOrderId)
    .map((fill) => fill.fillId);
}

/**
 * The composition's `HoldingsPort.remainingBookings` (r4): the OMS's fills joined with the ledger's
 * `remainingFillBookings`, one answer per identity asked.
 */
export function remainingBookingsOf(u: Universe, fills: readonly { readonly venueTradeId: string; readonly venueOrderId: string }[]): unknown {
  syncLedger(u);
  const asked = fills.map((fill) => ({ fill, ids: fillIdsOf(u, fill.venueTradeId, fill.venueOrderId) }));
  const remaining = remainingFillBookings(u.ledger.transactions(), ACCOUNT, asked.flatMap((entry) => entry.ids));
  return {
    bookings: asked.map(({ fill, ids }) => {
      const sums = new Map<string, string>();
      for (const id of ids) for (const line of remaining.get(id) ?? []) sums.set(line.assetId, addDecimal(sums.get(line.assetId) ?? "0", line.amount));
      return {
        venueTradeId: fill.venueTradeId,
        venueOrderId: fill.venueOrderId,
        entries: [...sums].filter(([, amount]) => compareDecimal(amount, "0") !== 0).map(([assetId, amount]) => ({ assetId, amount })),
      };
    }),
  };
}

/**
 * The operator's compensating reversal of a FAILED trade's fill (ADR-006 §5): every ledger transaction that books
 * the trade's fill on `venueOrderId` (its principal, its fee) and is not yet reversed is reversed, exactly, with
 * `reversesLedgerTransactionId` (`Ledger.append` refuses anything else). `only` limits it to one event type.
 */
export function bookReversal(u: Universe, venueTradeId: string, venueOrderId: string, only?: string): number {
  syncLedger(u);
  const ids = new Set(fillIdsOf(u, venueTradeId, venueOrderId));
  const reversed = new Set(u.ledger.transactions().flatMap(({ transaction }) => (transaction.reversesLedgerTransactionId === undefined ? [] : [transaction.reversesLedgerTransactionId])));
  let count = 0;
  for (const { transaction } of u.ledger.transactions()) {
    if (transaction.fillId === undefined || !ids.has(transaction.fillId) || transaction.reversesLedgerTransactionId !== undefined) continue;
    if (reversed.has(transaction.ledgerTransactionId) || (only !== undefined && transaction.eventType !== only)) continue;
    const appended = u.ledger.append({
      ...transaction,
      ledgerTransactionId: u.ledgerIds(),
      eventType: "MANUAL_ADJUSTMENT",
      source: "internal",
      reversesLedgerTransactionId: transaction.ledgerTransactionId,
      entries: transaction.entries.map((entry) => ({ ...entry, amount: negateDecimal(entry.amount) })),
    });
    if (!appended.ok) throw new Error(`reversal refused: ${JSON.stringify(appended.refusals)}`);
    u.ledger = appended.value.ledger;
    count += 1;
  }
  return count;
}

/** The ledger's projected holdings of the account, after the durable fills are folded in. */
export function ledgerHoldings(u: Universe): Map<string, string> {
  syncLedger(u);
  const out = new Map<string, string>();
  for (const line of projectedHoldings(projectLedger(u.ledger), ACCOUNT).lines) out.set(line.assetId, line.balance);
  return out;
}

/** What is inconsistent between the venue's truth and the system's state (R1). Empty when consistent. */
export function consistencyProblems(u: Universe, oms: OrderManager | ReconciledOms): string[] {
  const problems: string[] = [];
  const orders = oms.orders();
  for (const venue of u.world.orders.values()) {
    if (venue.foreign) continue;
    const tracked = orders.filter((order) => order.venueOrderId === venue.venueOrderId);
    if (tracked.length !== 1) {
      problems.push(`venue order ${venue.venueOrderId} is tracked by ${String(tracked.length)} OMS orders`);
      continue;
    }
    const order = tracked[0] as (typeof orders)[number];
    if (compareDecimal(order.filledShares, venue.matched) !== 0) {
      problems.push(`order ${order.orderId}: the OMS recorded ${order.filledShares} filled; the venue matched ${venue.matched}`);
    }
  }
  if (u.world.pending.length > 0) problems.push("a transmission is still travelling");
  for (const attempt of oms.attempts()) {
    const held = attempt.state === "RECONCILING" && attempt.absentConfirmed && !attempt.inFlight;
    if (!held && ["SENDING", "SUBMISSION_UNKNOWN", "RECONCILING"].includes(attempt.state)) problems.push(`attempt ${attempt.submissionAttemptId} is ${attempt.state}`);
  }
  const holdings = ledgerHoldings(u);
  if (compareDecimal(holdings.get(PUSD) ?? "0", u.world.collateral) !== 0) {
    problems.push(`collateral: the ledger projects ${holdings.get(PUSD) ?? "0"}; the venue holds ${u.world.collateral}`);
  }
  const tokens = new Set([...u.world.positions.keys(), ...[...holdings.keys()].filter((asset) => asset !== PUSD)]);
  for (const token of tokens) {
    if (compareDecimal(holdings.get(token) ?? "0", u.world.positions.get(token) ?? "0") !== 0) {
      problems.push(`${token}: the ledger projects ${holdings.get(token) ?? "0"}; the venue holds ${u.world.positions.get(token) ?? "0"}`);
    }
  }
  for (const order of orders) {
    const reservation = u.inventory.book.reservation(order.reservation.reservationId);
    if (reservation === undefined) continue;
    if (addDecimal(addDecimal(reservation.consumed, reservation.released), reservation.remaining) !== reservation.amount) {
      problems.push(`reservation ${reservation.reservationId} is not conserved`);
    }
  }
  if (u.inventory.book.checkInvariants().length > 0) problems.push("the inventory's invariants fail");
  return problems;
}

/** A wrapper around the OMS that runs the oracle on every answer and every resume (R1-R3). */
function oracleOms(u: Universe, oms: OrderManager): ReconciledOms {
  return {
    get paused() {
      return oms.paused;
    },
    get faulted() {
      return oms.faulted;
    },
    pause: () => oms.pause(),
    resume: () => {
      const result = oms.resume();
      if (result.ok) {
        u.resumes += 1;
        for (const problem of consistencyProblems(u, oms)) u.violations.push(`R1 (resumed while inconsistent): ${problem}`);
      }
      return result;
    },
    attempts: () => (u.seams.attempts === undefined ? oms.attempts() : u.seams.attempts(oms.attempts())),
    orders: () => oms.orders(),
    alerts: () => (u.seams.alerts === undefined ? oms.alerts() : u.seams.alerts(oms.alerts())),
    retainedEvidence: () => oms.retainedEvidence(),
    outstandingReconciliations: () => oms.outstandingReconciliations(),
    retryReconciliationRequests: () => {
      u.omsRetries += 1;
      return oms.retryReconciliationRequests();
    },
    applyReconciliation: async (raw: unknown) => {
      const answer = raw as {
        readonly requestId: string;
        readonly submissionAttemptId: string;
        readonly verdict: string;
        readonly transmissionQuiescent?: boolean;
        readonly order?: { readonly venueOrderId: string };
      };
      u.log.push(`answer:oms:${answer.requestId}`);
      const attempt = oms.attempt(answer.submissionAttemptId);
      const salt = attempt?.salt;
      u.world.settleArrivals();
      const seam = u.seams.applyReconciliation;
      const result = (seam === undefined ? await oms.applyReconciliation(raw) : await seam(raw, (inner) => oms.applyReconciliation(inner))) as Awaited<
        ReturnType<OrderManager["applyReconciliation"]>
      >;
      if (result.ok && salt !== undefined) {
        if (answer.verdict === "ABSENT" && (u.world.orders.has(salt) || u.world.isPending(salt))) {
          u.violations.push(`R2: ABSENT accepted for salt ${salt}, which the venue holds or which may still arrive`);
        }
        if (answer.verdict === "PRESENT" && answer.order?.venueOrderId !== venueIdFor(salt)) {
          u.violations.push(`R3: PRESENT accepted for salt ${salt} naming ${answer.order?.venueOrderId ?? "?"}`);
        }
        u.accepted.push({
          verdict: answer.verdict,
          attemptId: answer.submissionAttemptId,
          venueOrderId: answer.order?.venueOrderId ?? null,
          quiescent: answer.transmissionQuiescent === true,
        });
      }
      return result;
    },
    applyOrderObservation: (raw: unknown) => oms.applyOrderObservation(raw),
    recordFill: (raw: unknown) => oms.recordFill(raw),
    applySettlement: (raw: unknown) => oms.applySettlement(raw),
    requestOrderReconciliation: (orderId: string) => oms.requestOrderReconciliation(orderId),
  };
}

/**
 * Boot one process over the universe: the journal from its durable events,
 * the coordinator, then the OMS (whose recovery issues requests to the
 * coordinator), then the binding (STARTUP).
 */
export async function boot(u: Universe, plan: KillPlan | null = null, options: { readonly openOms?: boolean } = {}): Promise<Process> {
  const inc = new Incarnation(plan);
  const opened = ReconciliationJournal.open({
    accountRef: ACCOUNT,
    history: [...u.journalEvents],
    sink: {
      append: (event) =>
        inc.call("journal.append", async () => {
          u.journalEvents.push(event);
        }),
    },
  });
  if (!opened.ok) throw new Error(`the journal history did not replay: ${opened.refusal.message}`);
  const journal = opened.value;
  const reads = u.world.readPort();
  const coordinator = new ReconciliationCoordinator({
    reads: {
      listOpenOrders: () => inc.call("read.openOrders", () => logged(u, "listOpenOrders", () => reads.listOpenOrders())),
      readOrder: (id) => inc.call("read.order", () => logged(u, "readOrder", () => reads.readOrder(id))),
      listTrades: () => inc.call("read.trades", () => logged(u, "listTrades", () => reads.listTrades())),
      readPositions: () => inc.call("read.positions", () => logged(u, "readPositions", () => reads.readPositions())),
      readCollateral: () => inc.call("read.collateral", () => logged(u, "readCollateral", () => reads.readCollateral())),
      readApprovals: () => inc.call("read.approvals", () => logged(u, "readApprovals", () => reads.readApprovals())),
      readWalletMember: (member) => inc.call("read.walletMember", () => logged(u, "readWalletMember", () => reads.readWalletMember(member))),
    },
    journal: u.seams.journal === undefined ? journal : u.seams.journal(journal),
    holdings: {
      projected: () => inc.call("ledger.projected", async () => projectedHoldings(projectLedgerSynced(u), ACCOUNT)),
      remainingBookings: (fills) =>
        inc.call("ledger.bookings", async () =>
          u.seams.remainingBookings === undefined ? remainingBookingsOf(u, fills) : u.seams.remainingBookings(fills, () => remainingBookingsOf(u, fills)),
        ),
      bookUnattributed: (booking) =>
        inc.call("ledger.book", async () => {
          if (u.seams.refuseBooking === true) return { ok: false };
          const built = buildUnattributedCorrection({
            ledgerTransactionId: booking.ledgerTransactionId,
            reconciliationRunId: booking.reconciliationRunId,
            environment: "PAPER",
            accountRef: ACCOUNT,
            assetId: booking.assetId,
            assetKind: booking.assetKind,
            marketId: booking.marketId,
            delta: booking.delta,
            occurredAt: "2026-10-03T00:00:00.000Z",
            venueClearingAccount: "clearing-venue",
            attributionClearingAccount: "clearing-attribution",
          });
          if (!built.ok) return { ok: false };
          const appended = u.ledger.append(built.value);
          if (!appended.ok) return { ok: false };
          u.ledger = appended.value.ledger;
          return { ok: true };
        }),
    },
    clock: { now: () => (u.seams.localClock === undefined ? u.clock.t : u.seams.localClock(u.clock.t)) },
    newId: u.coordinatorIds,
    marketOfToken: (tokenId) => (tokenId === YES ? MARKET : tokenId === NO ? MARKET_NO : null),
    // The groups the OMS registered, as the composition would bind them (`execution.groups.token_id`).
    tokenOfGroup: (executionGroupId) => {
      const real = (id: string): string | null => u.store.snapshotSync().groups.get(id)?.tokenId ?? null;
      return u.seams.tokenOfGroup === undefined ? real(executionGroupId) : u.seams.tokenOfGroup(executionGroupId, real);
    },
    policy: u.policy,
  });
  // (r7) `openOms: false`: a process whose coordinator runs with no OMS bound yet (the composition opens it later).
  const oms = options.openOms === false ? null : await openOms(u, inc, coordinator);
  if (oms !== null) coordinator.bindOms(oracleOms(u, oms));
  return { inc, coordinator, journal, oms };
}

/**
 * Open an OMS over the universe's durable store for one incarnation (its port calls counted), with the coordinator
 * as its reconciler. `null` when the incarnation died while opening.
 */
async function openOms(u: Universe, inc: Incarnation, coordinator: ReconciliationCoordinator): Promise<OrderManager | null> {
  const venue = u.world.venuePort(() => inc.alive);
  const store: OmsStore = {
    apply: (writes) => inc.call(`store.apply[${writes.map((write) => write.kind).join(",")}]`, () => u.store.apply(writes)),
    load: () => inc.call("store.load", () => u.store.load()),
  };
  const cipher: PayloadCipher = {
    encrypt: (text) => inc.call("cipher.encrypt", () => u.cipher.encrypt(text)),
    decrypt: (payload) => inc.call("cipher.decrypt", () => u.cipher.decrypt(payload)),
  };
  const reservations: OmsReservationPort = {
    reserve: (input) => inc.call("inventory.reserve", () => u.inventory.service.reserve(input)),
    consume: (input) => inc.call("inventory.consume", () => u.inventory.service.consume(input)),
    release: (input) => inc.call("inventory.release", () => u.inventory.service.release(input)),
  };
  const deps: OrderManagerDependencies = {
    venue: {
      createLimitOrder: (request) => inc.call("venue.sign", () => venue.createLimitOrder(request)),
      postOrder: (order) => inc.call("venue.post", () => venue.postOrder(order)),
      postOrders: (orders) => inc.call("venue.postBatch", () => venue.postOrders(orders)),
      cancelOrder: (orderId) => inc.call("venue.cancel", () => venue.cancelOrder(orderId)),
    },
    restoreSignedOrder: restoreFakeSignedOrder,
    store,
    cipher,
    reservations,
    reconciler: {
      request: (request) =>
        inc.callSync("reconciler.request", () => {
          u.omsRequests.push(request);
          u.log.push(`recv:oms:${request.requestId}`);
          coordinator.omsRequester.request(request);
        }),
    },
    newId: u.omsIds,
    requestToken: u.requestToken,
    venueMode: () => u.mode.value,
    collateralAssetId: PUSD,
  };
  let oms: OrderManager | null = null;
  try {
    const result = await OrderManager.open(deps);
    if (result.ok) oms = result.value;
    else if (inc.alive) throw new Error(`open refused while alive: ${result.refusal.code}`);
  } catch (error) {
    if (!(error instanceof Killed) && inc.alive) throw error;
  }
  return oms;
}

/**
 * r7 (WP290-V7-STREAM-REFUSAL-DROPPED): the composition reopens a FAULTED OMS from its durable store and binds it to
 * the SAME live coordinator (no process restart: the coordinator, its journal and its memory stay). Returns the
 * process with its new OMS.
 */
export async function reopenOms(u: Universe, p: Process): Promise<Process> {
  const oms = await openOms(u, p.inc, p.coordinator);
  if (oms !== null) p.coordinator.bindOms(oracleOms(u, oms));
  return { ...p, oms };
}

/** Log a read at the moment it starts (before the world answers). */
function logged(u: Universe, name: string, run: () => Promise<unknown>): Promise<unknown> {
  u.log.push(`read:${name}`);
  return run();
}

function projectLedgerSynced(u: Universe): ReturnType<typeof projectLedger> {
  syncLedger(u);
  return projectLedger(u.ledger);
}

/** Reconcile until the coordinator resumes, advancing the clock past the horizon between attempts. */
export async function reconcileUntilResumed(p: Process, u: Universe, rounds = 8): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    let resumed = false;
    try {
      resumed = (await p.coordinator.reconcile()).resumed;
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
    if (resumed) return true;
    u.clock.t += u.policy.quiescenceHorizonMs + 1;
  }
  return false;
}

/** The deliverable fills of the venue's trades on one venue order, as the user stream would project them. */
export function streamTrade(u: Universe, venueTradeId: string): unknown {
  const trade = u.world.trades.find((candidate) => candidate.venueTradeId === venueTradeId);
  if (trade === undefined) throw new Error("no such trade");
  return {
    kind: "TRADE",
    oms: {
      fills: [
        {
          venueTradeId: trade.venueTradeId,
          venueOrderId: trade.venueOrderId,
          shares: trade.shares,
          price: trade.price,
          liquidityRole: trade.role,
          feeAmount: "0",
          feeAssetId: null,
          matchedAt: trade.matchedAt,
        },
      ],
      settlements: [],
      shortfalls: [],
    },
  };
}
